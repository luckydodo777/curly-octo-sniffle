"use strict";
/* ============================================================
   건반 내비 — 악보를 올리면 어디를 쳐야 하는지 보여주는 피아노 연습 앱
   구조: 파서(MusicXML/MXL/MIDI/AI-JSON) → Song 모델(초 단위 타임라인)
        → 재생 엔진(대기 모드·구간 반복·손 분리) → 렌더러(악보 커서·낙하 노트·건반)
   ============================================================ */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const SOL = ["도","도#","레","레#","미","파","파#","솔","솔#","라","라#","시"];
const ABC = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const isBlack = (m) => [1,3,6,8,10].includes(((m % 12) + 12) % 12);
const octOf = (m) => Math.floor(m / 12) - 1;
function noteName(m, mode) {
  const pc = ((m % 12) + 12) % 12;
  if (mode === "abc") return ABC[pc] + (pc === 0 ? octOf(m) : "");
  return SOL[pc];
}
function fullName(m) { return SOL[((m%12)+12)%12] + "(" + ABC[((m%12)+12)%12] + octOf(m) + ")"; }

/* ---------------- settings (per-viewer convenience) ---------------- */
const STORE_KEY = "gunban-navi-v1";
const settings = Object.assign({
  rate: 1, mode: "listen", hands: "both", loopOn: false, loopA: 1, loopB: 4, autoSpeed: false,
  accomp: true, guide: false, countIn: true, inputSound: true, volume: 0.8, metro: false,
  soundSet: "sal", steadyTempo: false, expandRepeats: true, chordLoose: false, micChord: true, sideCollapsed: false, scoreLayout: "line", view: "all", labels: "sol", fingers: true, range: "fit", zoom: 1, scoreZoom: 0.8, kbBase: 60
}, (() => { try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch (e) { return {}; } })());
function saveSettings() { try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) {} }

/* ============================================================
   1) 파일 해석: MXL(zip) 풀기
   ============================================================ */
async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") throw new Error("이 브라우저는 .mxl 압축 풀기를 지원하지 않아요. 압축하지 않은 .musicxml로 올려 주세요.");
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error("압축 파일 구조를 읽을 수 없어요.");
  const count = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
  const files = {}; const td = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nlen));
    files[name] = { method, csize, lho };
    p += 46 + nlen + xlen + clen;
  }
  return {
    names: Object.keys(files),
    async read(name) {
      const f = files[name]; if (!f) return null;
      const lnlen = dv.getUint16(f.lho + 26, true), lxlen = dv.getUint16(f.lho + 28, true);
      const start = f.lho + 30 + lnlen + lxlen; const data = u8.subarray(start, start + f.csize);
      const out = f.method === 0 ? data : await inflateRaw(data);
      return new TextDecoder().decode(out);
    }
  };
}
async function mxlToXml(buf) {
  const z = await unzip(buf);
  let root = null;
  const cont = await z.read("META-INF/container.xml");
  if (cont) { const m = cont.match(/full-path\s*=\s*"([^"]+)"/); if (m) root = m[1]; }
  if (!root) root = z.names.find((n) => !n.startsWith("META-INF") && /\.(xml|musicxml)$/i.test(n));
  if (!root) throw new Error(".mxl 안에서 악보 파일을 찾지 못했어요.");
  return z.read(root);
}

/* ============================================================
   2) MusicXML 파서 → 원시 노트 목록 (4분음표 단위)
   ============================================================ */
const STEP_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function kidText(el, sel) { const n = el.querySelector(sel); return n ? n.textContent.trim() : ""; }
function directKids(el, name) { return [...el.children].filter((c) => c.nodeName === name); }

function parseMusicXML(xmlText, opts = {}) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("MusicXML 형식이 아니거나 파일이 손상됐어요.");
  const root = doc.documentElement;
  if (root.nodeName === "score-timewise") throw new Error("score-timewise 형식은 아직 못 읽어요. 악보 프로그램에서 일반 MusicXML로 다시 내보내 주세요.");
  if (root.nodeName !== "score-partwise") throw new Error("MusicXML 악보가 아니에요.");
  let title = kidText(root, "work > work-title") || kidText(root, "movement-title");
  let composer = "";
  root.querySelectorAll("identification > creator").forEach((c) => { if (!composer && (c.getAttribute("type") || "") === "composer") composer = c.textContent.trim(); });
  if (!title) { const cw = root.querySelector("credit credit-words"); if (cw) title = cw.textContent.trim(); }
  const parts = directKids(root, "part");
  if (!parts.length) throw new Error("악보에 파트가 없어요.");
  const measures = []; const tempos = []; const notes = []; let jumps = false;
  // opts.fit: 악보 인식(OMR) 결과 점검. 박자표와 길이가 다른 마디를 "확인 필요"로 표시만 하고 음의 시간은 바꾸지 않는다.
  //   (예전에는 넘치는 성부를 비율로 줄였는데, 양손 동시성과 악보 커서 위치가 어긋나서 그만둠 — 이슈 #14)
  const partInfo = []; const fitFlags = new Map();
  parts.forEach((part, pi) => {
    let divisions = 1, transpose = 0, staves = 1, beats = 4, beatType = 4, qStart = 0;
    const clefs = {}; const ties = new Map(); // "파트:음높이" → 아직 이어지는 음 목록 [{note, voice}]
    directKids(part, "measure").forEach((m, mi) => {
      let pos = 0, maxPos = 0, lastStart = 0, idx = -1;
      const numAttr = m.getAttribute("number");
      let rep = null; // 도돌이표·1/2번 괄호 (첫 파트 기준)
      if (pi === 0) {
        for (const bl of m.querySelectorAll(":scope > barline")) {
          const r = bl.querySelector("repeat"), en = bl.querySelector("ending");
          if (r || en) rep = rep || {};
          if (r && r.getAttribute("direction") === "forward") rep.fwd = true;
          if (r && r.getAttribute("direction") === "backward") rep.bwd = Math.max(2, parseInt(r.getAttribute("times")) || 2);
          if (en) {
            const nums = (en.getAttribute("number") || "").split(/[,\s]+/).map((x) => parseInt(x)).filter((x) => x > 0);
            const t = en.getAttribute("type");
            if (t === "start") rep.endStart = nums; else rep.endStop = true;
            if (nums.length) rep.ending = nums;
          }
        }
        if (m.querySelector("sound[dacapo], sound[dalsegno], sound[tocoda], sound[coda], sound[segno], sound[fine]") || m.querySelector("direction-type > segno, direction-type > coda")) jumps = true;
      }
      for (const el of m.children) {
        const nn = el.nodeName;
        if (nn === "attributes") {
          const d = parseFloat(kidText(el, "divisions")); if (d > 0) divisions = d;
          const st = parseInt(kidText(el, "staves")); if (st > 0) staves = st;
          const tb = el.querySelector("time beats"), tt = el.querySelector("time beat-type");
          if (tb && tt) { beats = parseInt(tb.textContent) || beats; beatType = parseInt(tt.textContent) || beatType; }
          el.querySelectorAll("clef").forEach((c) => { clefs[c.getAttribute("number") || "1"] = kidText(c, "sign"); });
          const tr = el.querySelector("transpose");
          if (tr) transpose = (parseInt(kidText(tr, "chromatic")) || 0) + 12 * (parseInt(kidText(tr, "octave-change")) || 0);
        } else if (nn === "backup") {
          pos -= (parseFloat(kidText(el, "duration")) || 0) / divisions; if (pos < 0) pos = 0;
        } else if (nn === "forward") {
          pos += (parseFloat(kidText(el, "duration")) || 0) / divisions; maxPos = Math.max(maxPos, pos);
        } else if (nn === "direction" || nn === "sound") {
          const snd = nn === "sound" ? el : el.querySelector("sound");
          let bpm = snd && parseFloat(snd.getAttribute("tempo"));
          if (!(bpm > 0)) {
            const met = el.querySelector("metronome");
            if (met) {
              const pm = parseFloat(kidText(met, "per-minute"));
              const unit = kidText(met, "beat-unit");
              const dots = met.querySelectorAll("beat-unit-dot").length;
              const uq = { whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25 }[unit] || 1;
              if (pm > 0) bpm = pm * uq * (dots ? 1.5 : 1);
            }
          }
          if (bpm > 0 && pi === 0) tempos.push({ q: qStart + pos, bpm });
        } else if (nn === "note") {
          idx++;
          const isChord = !!el.querySelector("chord");
          const isGrace = !!el.querySelector("grace");
          if (el.querySelector("cue")) continue;
          const d = isGrace ? 0 : (parseFloat(kidText(el, "duration")) || 0) / divisions;
          const start = isChord ? lastStart : pos;
          if (!isChord) { lastStart = pos; pos += d; }
          maxPos = Math.max(maxPos, pos);
          if (isGrace || el.querySelector("rest") || !el.querySelector("pitch")) continue;
          const step = kidText(el, "pitch > step"), alter = parseFloat(kidText(el, "pitch > alter")) || 0, oct = parseInt(kidText(el, "pitch > octave"));
          if (!(step in STEP_PC) || isNaN(oct)) continue;
          const midi = Math.round((oct + 1) * 12 + STEP_PC[step] + alter + transpose);
          const staff = parseInt(kidText(el, "staff")) || 1;
          const fing = kidText(el, "notations technical fingering");
          const tieTypes = [...el.querySelectorAll("tie")].map((t) => t.getAttribute("type"))
            .concat([...el.querySelectorAll("notations tied")].map((t) => t.getAttribute("type")));
          const voice = kidText(el, "voice") || "1";
          const key = pi + ":" + midi, abs = qStart + start;
          if (tieTypes.includes("stop")) {
            // 붙임줄 끝: 같은 성부에서 바로 앞에 끝난 같은 음에 잇는다. 성부 정보가 다르면(성부 표기 누락·다른 단 넘김) 시간이 맞닿은 음에 잇는다.
            const open = ties.get(key) || [];
            const ends = (o) => Math.abs(o.note.startQ + o.note.durQ - abs) < 1e-3;
            let hit = open.find((o) => o.voice === voice && ends(o)) || open.find((o) => ends(o) && !open.some((x) => x !== o && x.voice === voice && ends(x)));
            if (!hit && open.length === 1 && open[0].voice === voice) hit = open[0];
            if (hit) {
              hit.note.durQ = Math.max(hit.note.durQ, abs + d - hit.note.startQ);
              if (!tieTypes.includes("start")) open.splice(open.indexOf(hit), 1);
              continue;
            }
          }
          const note = { midi, startQ: abs, durQ: Math.max(d, 0.0625), staff, voice, part: pi, measure: mi, finger: fing ? parseInt(fing) || null : null,
            src: { measure: numAttr || String(mi + 1), offsetQ: start, idx } }; // 원본 악보 위치 (마디 번호·마디 안 위치·마디 안 몇 번째 음)
          notes.push(note);
          if (tieTypes.includes("start")) { if (!ties.has(key)) ties.set(key, []); ties.get(key).push({ note, voice }); }
        }
      }
      const nominal = beats * 4 / beatType;
      const implicit = m.getAttribute("implicit") === "yes";
      if (opts.fit && maxPos > nominal + 1e-3) {
        // 시간은 그대로 둔다(악보 그림·양손 동시성 유지). 이 마디만 길어지고, 다음 마디는 이 마디가 끝난 뒤 시작한다.
        if (!fitFlags.has(mi)) fitFlags.set(mi, `박자표보다 음이 길게 인식됨 (${+maxPos.toFixed(2)}박 / ${+nominal.toFixed(2)}박) — 음 길이가 잘못 읽혔을 수 있어요. 원본과 비교해 주세요`);
      } else if (opts.fit && maxPos > 1e-6 && maxPos < nominal - 1e-3 && mi > 0 && !implicit && !fitFlags.has(mi)) {
        fitFlags.set(mi, `음이 빠졌을 수 있음 (${+maxPos.toFixed(2)}박 / ${+nominal.toFixed(2)}박)`);
      }
      let lenQ;
      if (pi === 0) {
        if (maxPos <= 1e-6) lenQ = nominal;
        else if (maxPos < nominal - 1e-6 && !(mi === 0 || implicit)) lenQ = nominal;
        else lenQ = maxPos;
        measures.push({ num: /^\d+$/.test(numAttr || "") ? parseInt(numAttr) : mi + 1, startQ: qStart, lenQ, beats, beatType, ...(rep ? { rep } : {}) });
      } else {
        lenQ = measures[mi] ? measures[mi].lenQ : (maxPos || nominal);
      }
      qStart += lenQ;
    });
    partInfo.push({ staves, clefs });
  });
  assignHandsXML(notes, partInfo);
  return { title: title || "제목 없는 악보", composer, notes, measures, tempos, jumps, fitFlags: [...fitFlags].map(([m, t]) => ({ m, issues: [t] })) };
}
// 자동 변환 악보의 "확인 필요" 목록 = 앱이 찾은 박자 문제 + 변환 서버가 남긴 안내(omrNotes: [{m, text}])
function omrFlags(raw, notes) {
  const map = new Map((raw.fitFlags || []).map((f) => [f.m, [...f.issues]]));
  for (const n of notes || []) if (n && Number.isInteger(n.m) && n.text) { if (!map.has(n.m)) map.set(n.m, []); map.get(n.m).unshift(n.text); }
  return [...map].sort((a, b) => a[0] - b[0]).map(([m, issues]) => ({ m, issues }));
}
function avgPitch(list) { return list.length ? list.reduce((s, n) => s + n.midi, 0) / list.length : 60; }
function assignHandsXML(notes, partInfo) {
  const byPart = new Map();
  notes.forEach((n) => { if (!byPart.has(n.part)) byPart.set(n.part, []); byPart.get(n.part).push(n); });
  const multiStaff = partInfo.some((p) => p.staves >= 2);
  const partIds = [...byPart.keys()];
  const ranked = partIds.slice().sort((a, b) => avgPitch(byPart.get(b)) - avgPitch(byPart.get(a)));
  byPart.forEach((list, pi) => {
    const info = partInfo[pi] || { staves: 1, clefs: {} };
    list.forEach((n) => {
      if (info.staves >= 2) n.hand = n.staff === 1 ? "R" : "L";
      else if (!multiStaff && partIds.length === 2) n.hand = ranked[0] === pi ? "R" : "L";
      else if (partIds.length > 2 || multiStaff) n.hand = avgPitch(list) >= 60 ? "R" : "L";
      else n.hand = (info.clefs["1"] === "F") ? "L" : "R";
    });
  });
}

/* ============================================================
   3) MIDI 파서 (SMF 0/1)
   ============================================================ */
function parseMIDI(buf) {
  const u8 = new Uint8Array(buf); let p = 0;
  const str = (n) => { let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(u8[p + i]); return s; };
  const u32 = () => { const v = (u8[p] << 24 | u8[p + 1] << 16 | u8[p + 2] << 8 | u8[p + 3]) >>> 0; p += 4; return v; };
  const u16 = () => { const v = u8[p] << 8 | u8[p + 1]; p += 2; return v; };
  const vlq = () => { let v = 0, b; do { b = u8[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80 && p < u8.length); return v; };
  if (str(4) !== "MThd") throw new Error("MIDI 파일이 아니에요.");
  p += 4; const hlen = u32(); const fmt = u16(), ntr = u16(), div = u16(); p = 8 + hlen;
  void fmt;
  if (div & 0x8000) throw new Error("SMPTE 시간 단위 MIDI는 지원하지 않아요.");
  const ppq = div; const tempos = []; const timesigs = []; const tracks = [];
  for (let t = 0; t < ntr && p < u8.length; t++) {
    while (p < u8.length && str(4) !== "MTrk") { p += 4; const l = u32(); p += l; }
    if (p >= u8.length) break;
    p += 4; const len = u32(); const end = p + len; let tick = 0, status = 0; const open = new Map(); const tnotes = []; let name = "";
    while (p < end) {
      tick += vlq(); let b = u8[p];
      if (b === 0xff) { p++; const type = u8[p++]; const l = vlq(); const d = u8.subarray(p, p + l);
        if (type === 0x51 && l === 3) tempos.push({ tick, bpm: 60000000 / ((d[0] << 16) | (d[1] << 8) | d[2]) });
        else if (type === 0x58 && l >= 2) timesigs.push({ tick, beats: d[0], beatType: Math.pow(2, d[1]) });
        else if (type === 0x03) name = new TextDecoder().decode(d);
        p += l; continue; }
      if (b === 0xf0 || b === 0xf7) { p++; const l = vlq(); p += l; continue; }
      if (b & 0x80) { status = b; p++; }
      const type = status & 0xf0, ch = status & 0x0f;
      if (type === 0xc0 || type === 0xd0) { p += 1; continue; }
      const d1 = u8[p++], d2 = u8[p++];
      if (type === 0x90 && d2 > 0) { const k = ch * 128 + d1; if (!open.has(k)) open.set(k, []); open.get(k).push({ tick, vel: d2 }); }
      else if (type === 0x80 || (type === 0x90 && d2 === 0)) { const k = ch * 128 + d1; const s = open.get(k); if (s && s.length) { const st = s.shift(); if (ch !== 9) tnotes.push({ midi: d1, startQ: st.tick / ppq, durQ: Math.max((tick - st.tick) / ppq, 0.05), ch }); } }
    }
    p = end;
    tracks.push({ name, notes: tnotes });
  }
  const withNotes = tracks.filter((t) => t.notes.length);
  if (!withNotes.length) throw new Error("이 MIDI에는 연주할 음이 없어요.");
  const handByName = (n) => /right|rh|treble|오른|우/i.test(n) ? "R" : /left|lh|bass|왼|좌/i.test(n) ? "L" : null;
  const notes = [];
  if (withNotes.length === 1) withNotes[0].notes.forEach((n) => notes.push({ ...n, hand: n.midi >= 60 ? "R" : "L" }));
  else {
    const ranked = withNotes.slice().sort((a, b) => avgPitch(b.notes) - avgPitch(a.notes));
    withNotes.forEach((t) => {
      let h = handByName(t.name);
      if (!h) h = withNotes.length === 2 ? (ranked[0] === t ? "R" : "L") : (avgPitch(t.notes) >= 60 ? "R" : "L");
      t.notes.forEach((n) => notes.push({ ...n, hand: h }));
    });
  }
  const tq = (tick) => tick / ppq;
  const endQ = notes.reduce((m, n) => Math.max(m, n.startQ + n.durQ), 0);
  timesigs.sort((a, b) => a.tick - b.tick);
  const measures = []; let q = 0, ts = { beats: 4, beatType: 4 }, i = 0, idx = 0;
  while (q < endQ - 1e-6 || measures.length === 0) {
    while (i < timesigs.length && tq(timesigs[i].tick) <= q + 1e-6) { ts = timesigs[i]; i++; }
    const lenQ = ts.beats * 4 / ts.beatType;
    measures.push({ num: idx + 1, startQ: q, lenQ, beats: ts.beats, beatType: ts.beatType }); q += lenQ; idx++;
    if (idx > 5000) break;
  }
  notes.forEach((n) => { let mi = 0; while (mi + 1 < measures.length && measures[mi + 1].startQ <= n.startQ + 1e-6) mi++; n.measure = mi; n.finger = null; });
  return { title: "", composer: "", notes, measures, tempos: tempos.map((t) => ({ q: tq(t.tick), bpm: t.bpm })) };
}

/* ============================================================
   4) 간단 악보 JSON → MusicXML (예제 곡·AI 인식 결과 공용)
   { title, composer, bpm, time:[4,4], fifths, measures:[m] }
   m  = { rh:[ev], lh:[ev], rh2?, lh2?, time?:[b,bt], fifths?, bpm?, rhClef?:"G"|"F", lhClef?, rh8va?:1|-1, lh8va? }
   ev = { p:"E4" | ["C4","E4"] | "r", d:"q"|"h."|"e3"|"s", tup?:[5,4], f:3|[1,3], tie:true }
   ============================================================ */
const DIV = 840; // 4분음표 = 840 (3·5·7잇단음까지 정수로 나뉨)
const DUR = { w: 3360, h: 1680, q: 840, e: 420, s: 210, t: 105 };
const TYPE = { w: "whole", h: "half", q: "quarter", e: "eighth", s: "16th", t: "32nd" };
function parseDur(d, tup) {
  const m = String(d || "q").trim().match(/^([whqest])(\.{0,2})(3?)$/);
  const base = m ? m[1] : "q";
  let u = DUR[base]; const dots = m ? m[2].length : 0;
  if (dots === 1) u *= 1.5; if (dots === 2) u *= 1.75;
  let act = 0, norm = 0;
  if (m && m[3]) { act = 3; norm = 2; }
  if (Array.isArray(tup) && tup.length === 2 && tup[0] > 0 && tup[1] > 0) { act = Math.round(tup[0]); norm = Math.round(tup[1]); }
  if (act) u = u * norm / act;
  return { units: u, type: TYPE[base], dots, act, norm, valid: !!m };
}
function parsePitch(s) {
  const m = String(s).trim().match(/^([A-Ga-g])(#{1,2}|b{1,2}|x|♯|♭|n)?(-?\d)$/);
  if (!m) return null;
  const acc = m[2] || ""; const alter = acc === "x" ? 2 : acc.startsWith("#") || acc === "♯" ? acc.length : acc.startsWith("b") || acc === "♭" ? -acc.length : 0;
  return { step: m[1].toUpperCase(), alter, octave: parseInt(m[3]) };
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const VOICES = [["rh", 1, 1], ["rh2", 2, 1], ["lh", 5, 2], ["lh2", 6, 2]];
const evUnits = (ev) => parseDur(ev.d, ev.tup).units;
// 마디마다 각 성부의 길이 합을 박자표와 맞춘다. 넘치면 뒤를 잘라내고, 모자라면 쉼표로 채우며 표시해 둔다.
function repairScore(j) {
  const flags = [];
  let time = Array.isArray(j.time) && j.time.length === 2 ? j.time.map(Number) : [4, 4];
  const ms = Array.isArray(j.measures) ? j.measures : [];
  ms.forEach((m, i) => {
    if (Array.isArray(m.time) && m.time.length === 2 && m.time[0] > 0 && m.time[1] > 0) time = m.time.map(Number);
    const len = time[0] * DUR.w / time[1];
    const issues = [];
    VOICES.forEach(([k]) => {
      const evs = Array.isArray(m[k]) ? m[k].filter((e) => e && typeof e === "object") : null;
      if (!evs) { if (k === "rh" || k === "lh") m[k] = []; return; }
      m[k] = evs;
      const sum = evs.reduce((s, e) => s + evUnits(e), 0);
      if (!evs.length) return;
      if (sum > len + 1) {
        let acc = 0; const keep = [];
        for (const e of evs) {
          const u = evUnits(e);
          if (acc + u <= len + 1) { keep.push(e); acc += u; continue; }
          const room = len - acc;
          const cand = ["w", "h.", "h", "q.", "q", "e.", "e", "s.", "s", "t"].find((c) => parseDur(c).units <= room + 0.5);
          if (cand && room > 50) { keep.push({ ...e, d: cand, tup: undefined }); acc += parseDur(cand).units; }
          break;
        }
        m[k] = keep;
        issues.push(`${k.startsWith("rh") ? "오른손" : "왼손"} 박자가 ${fmtBeats(sum - len)}만큼 넘쳐서 잘라냄`);
      } else if (sum < len - 1 && !(i === 0) && !(i === ms.length - 1)) {
        issues.push(`${k.startsWith("rh") ? "오른손" : "왼손"} 박자가 ${fmtBeats(len - sum)} 모자람`);
      }
      evs.forEach((e) => { if (!parseDur(e.d, e.tup).valid) issues.push(`알 수 없는 음표 길이 "${e.d}"`); });
    });
    if (issues.length) flags.push({ m: i, issues });
  });
  return flags;
}
function fmtBeats(u) { const q = u / DUR.q; return (Math.round(q * 100) / 100) + "박"; }
function jsonToMusicXML(j) {
  let time = Array.isArray(j.time) && j.time.length === 2 ? j.time.map(Number) : [4, 4];
  let fifths = clamp(parseInt(j.fifths) || 0, -7, 7);
  const bpm0 = Number(j.bpm) > 0 ? Number(j.bpm) : j.bpm === 0 ? null : 90;
  const clefXml = (n, c) => c === "F" ? `<clef number="${n}"><sign>F</sign><line>4</line></clef>` : `<clef number="${n}"><sign>G</sign><line>2</line></clef>`;
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  out.push('<score-partwise version="4.0">');
  out.push(`<work><work-title>${esc(j.title || "제목 없는 악보")}</work-title></work>`);
  if (j.composer) out.push(`<identification><creator type="composer">${esc(j.composer)}</creator></identification>`);
  out.push('<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">');
  const pendingTie = { 1: new Map(), 2: new Map() }; // id -> 붙임줄이 시작된 마디 (1마디 안에 끝나지 않으면 버림)
  const measures = Array.isArray(j.measures) ? j.measures : [];
  const sumOf = (m, k) => (m[k] || []).reduce((s, ev) => s + evUnits(ev), 0);
  const lenOf = (t) => t[0] * DUR.w / t[1];
  const firstTime = measures[0] && Array.isArray(measures[0].time) ? measures[0].time.map(Number) : time;
  const firstLen = measures[0] ? Math.max(...VOICES.map(([k]) => sumOf(measures[0], k))) : 0;
  const hasPickup = !j.noPickup && firstLen > 0 && firstLen < lenOf(firstTime) - 1;
  let clefs = { 1: "G", 2: "F" }, lastBpm = null;
  measures.forEach((m, i) => {
    let attrs = "";
    const newTime = Array.isArray(m.time) && m.time.length === 2 && m.time[0] > 0 ? m.time.map(Number) : null;
    if (newTime) time = newTime;
    const newFifths = m.fifths != null && !isNaN(parseInt(m.fifths)) ? clamp(parseInt(m.fifths), -7, 7) : null;
    const nc = { 1: m.rhClef === "F" || m.rhClef === "G" ? m.rhClef : clefs[1], 2: m.lhClef === "F" || m.lhClef === "G" ? m.lhClef : clefs[2] };
    if (i === 0) attrs = `<attributes><divisions>${DIV}</divisions><key><fifths>${newFifths ?? fifths}</fifths></key><time><beats>${time[0]}</beats><beat-type>${time[1]}</beat-type></time><staves>2</staves>${clefXml(1, nc[1])}${clefXml(2, nc[2])}</attributes>`;
    else if (newTime || (newFifths != null && newFifths !== fifths) || nc[1] !== clefs[1] || nc[2] !== clefs[2]) {
      attrs = `<attributes>${newFifths != null && newFifths !== fifths ? `<key><fifths>${newFifths}</fifths></key>` : ""}${newTime ? `<time><beats>${time[0]}</beats><beat-type>${time[1]}</beat-type></time>` : ""}${nc[1] !== clefs[1] ? clefXml(1, nc[1]) : ""}${nc[2] !== clefs[2] ? clefXml(2, nc[2]) : ""}</attributes>`;
    }
    if (newFifths != null) fifths = newFifths;
    clefs = nc;
    const mLen = lenOf(time);
    const pickup = i === 0 && hasPickup;
    const len = pickup ? firstLen : mLen;
    out.push(`<measure number="${j.firstNumber != null ? j.firstNumber + i : hasPickup ? i : i + 1}"${pickup ? ' implicit="yes"' : ""}>`);
    if (attrs) out.push(attrs);
    const bpm = i === 0 ? (Number(m.bpm) > 0 ? Number(m.bpm) : bpm0) : (Number(m.bpm) > 0 ? Number(m.bpm) : null);
    if (bpm && bpm !== lastBpm) { out.push(`<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(bpm)}</per-minute></metronome></direction-type><staff>1</staff><sound tempo="${Math.round(bpm * 100) / 100}"/></direction>`); lastBpm = bpm; }
    let first = true;
    VOICES.forEach(([k, voice, staff]) => {
      const evs = m[k];
      if (k.endsWith("2") && !(evs && evs.length)) return;
      if (!first) out.push(`<backup><duration>${fmtNum(len)}</duration></backup>`);
      first = false;
      if (!evs || !evs.length) { out.push(`<note><rest measure="yes"/><duration>${fmtNum(len)}</duration><voice>${voice}</voice><staff>${staff}</staff></note>`); return; }
      const oct = j.noOttava ? 0 : Math.round(Number(m[(staff === 1 ? "rh" : "lh") + "8va"]) || 0);
      let used = 0, tupCount = 0, tupKey = "";
      evs.forEach((ev, ei) => {
        const dur = parseDur(ev.d, ev.tup);
        // 잇단음 묶음 표시(3·5·6 숫자): 같은 종류의 잇단음표를 act개씩 묶는다
        let tupX = "";
        if (dur.act) {
          const key = dur.act + "/" + dur.norm + "/" + dur.type;
          if (key !== tupKey) { tupKey = key; tupCount = 0; }
          const next = evs[ei + 1] ? parseDur(evs[ei + 1].d, evs[ei + 1].tup) : null;
          const pos = tupCount % dur.act; tupCount++;
          const last = pos === dur.act - 1 || !next || !next.act || (next.act + "/" + next.norm + "/" + next.type) !== key;
          if (pos === 0 && !last) tupX = '<tuplet type="start" bracket="no"/>'; else if (last && pos > 0) tupX = '<tuplet type="stop"/>';
          if (last) tupCount = 0;
        } else { tupKey = ""; tupCount = 0; }
        const ps = ev.p === "r" || ev.p == null ? [] : (Array.isArray(ev.p) ? ev.p : [ev.p]).map(parsePitch).filter(Boolean);
        const fingers = Array.isArray(ev.f) ? ev.f : ev.f != null ? [ev.f] : [];
        const durXml = `<duration>${fmtNum(dur.units)}</duration>`;
        const typeXml = `<type>${dur.type}</type>${"<dot/>".repeat(dur.dots)}${dur.act ? `<time-modification><actual-notes>${dur.act}</actual-notes><normal-notes>${dur.norm}</normal-notes></time-modification>` : ""}`;
        if (!ps.length) { out.push(`<note><rest/>${durXml}<voice>${voice}</voice>${typeXml}<staff>${staff}</staff>${tupX ? `<notations>${tupX}</notations>` : ""}</note>`); }
        else {
          const pend = pendingTie[staff];
          ps.forEach((pp0, k2) => {
            const pp = { ...pp0, octave: pp0.octave + oct };
            const id = pp.step + pp.alter + "/" + pp.octave;
            const stop = pend.has(id) && i - pend.get(id) <= 1; const start = !!ev.tie;
            pend.delete(id); if (start) pend.set(id, i);
            const tieX = (stop ? '<tie type="stop"/>' : "") + (start ? '<tie type="start"/>' : "");
            const tiedX = (stop ? '<tied type="stop"/>' : "") + (start ? '<tied type="start"/>' : "");
            const fx = fingers[k2] != null && fingers[k2] !== "" && !isNaN(parseInt(fingers[k2])) ? `<technical><fingering>${parseInt(fingers[k2])}</fingering></technical>` : "";
            const notations = tiedX || fx || (tupX && k2 === 0) ? `<notations>${tiedX}${k2 === 0 ? tupX : ""}${fx}</notations>` : "";
            out.push(`<note>${k2 ? "<chord/>" : ""}<pitch><step>${pp.step}</step>${pp.alter ? `<alter>${pp.alter}</alter>` : ""}<octave>${pp.octave}</octave></pitch>${durXml}${tieX}<voice>${voice}</voice>${typeXml}<staff>${staff}</staff>${notations}</note>`);
          });
        }
        used += dur.units;
      });
      if (used < len - 1) out.push(`<forward><duration>${fmtNum(len - used)}</duration><voice>${voice}</voice><staff>${staff}</staff></forward>`);
    });
    out.push("</measure>");
  });
  out.push("</part></score-partwise>");
  return out.join("\n");
}
function fmtNum(x) { return Math.round(x); }

/* ============================================================
   5) Song 모델: 템포 맵으로 초 단위 타임라인 계산
   ============================================================ */
// 도돌이표·1/2번 괄호를 연주 순서로 펼친다. 결과 마디마다 src(원본 마디 순번)와 pass(몇 번째 연주)를 단다.
// D.C./D.S./Coda/Fine은 아직 펼치지 않는다(raw.jumps로 알림).
function repeatOrder(ms) {
  // 괄호(ending) 구간: start가 있는 마디부터 stop/discontinue 마디까지 같은 번호
  const endingOf = new Array(ms.length).fill(null); let cur = null;
  ms.forEach((m, i) => { const r = m.rep || {}; if (r.endStart) cur = r.endStart; if (cur) endingOf[i] = cur; if (r.endStop) cur = null; });
  if (!ms.some((m) => m.rep && (m.rep.bwd || m.rep.fwd))) return ms.map((m, i) => ({ src: i, pass: 1 }));
  const order = []; const jumped = new Map(); let start = 0, pass = 1, i = 0, guard = 0;
  while (i < ms.length && guard++ < 4000) {
    const r = ms[i].rep || {};
    if (r.fwd && !(i === start && pass > 1)) { start = i; pass = 1; }
    if (endingOf[i] && !endingOf[i].includes(pass)) { i++; continue; } // 이번 회차가 아닌 괄호는 건너뜀
    order.push({ src: i, pass });
    if (r.bwd) {
      const done = jumped.get(i) || 0;
      if (done < r.bwd - 1) { jumped.set(i, done + 1); pass++; i = start; continue; }
      jumped.set(i, 0); pass = 1; start = i + 1;
    } else if (endingOf[i] && (i + 1 >= ms.length || !endingOf[i + 1])) { pass = 1; start = i + 1; } // 마지막 괄호가 끝나면 새 구간
    i++;
  }
  return order;
}
function expandRepeats(raw) {
  const ms = raw.measures; const order = repeatOrder(ms);
  if (order.length === ms.length && order.every((o, k) => o.src === k)) return null;
  const measures = []; let q = 0;
  order.forEach((o, k) => { const m = ms[o.src]; measures.push({ ...m, startQ: q, src: o.src, pass: o.pass }); q += m.lenQ; });
  const bySrc = new Map(); raw.notes.forEach((n) => { if (!bySrc.has(n.measure)) bySrc.set(n.measure, []); bySrc.get(n.measure).push(n); });
  const notes = [];
  order.forEach((o, k) => { const d = measures[k].startQ - ms[o.src].startQ; for (const n of bySrc.get(o.src) || []) notes.push({ ...n, startQ: n.startQ + d, measure: k, pass: o.pass }); });
  // 빠르기표: 원본 마디 안 위치 그대로, 그 마디가 연주될 때마다
  const tempos = [];
  for (const t of raw.tempos || []) { let si = 0; while (si + 1 < ms.length && ms[si + 1].startQ <= t.q + 1e-6) si++; order.forEach((o, k) => { if (o.src === si) tempos.push({ ...t, q: measures[k].startQ + (t.q - ms[si].startQ) }); }); }
  return { ...raw, notes, measures, tempos, expanded: true };
}
function buildSong(raw, extra) {
  const srcMeasures = raw.measures;
  if (settings.expandRepeats !== false) { const ex = expandRepeats(raw); if (ex) raw = ex; }
  let tempos = (raw.tempos || []).filter((t) => t.bpm > 0 && isFinite(t.q)).sort((a, b) => a.q - b.q);
  if (settings.steadyTempo && tempos.length) tempos = [{ q: 0, bpm: tempos[0].bpm }];
  const dedup = []; tempos.forEach((t) => { if (dedup.length && Math.abs(dedup[dedup.length - 1].q - t.q) < 1e-6) dedup[dedup.length - 1] = t; else dedup.push(t); });
  tempos = dedup;
  if (!tempos.length || tempos[0].q > 1e-6) tempos.unshift({ q: 0, bpm: tempos.length ? tempos[0].bpm : 100 });
  let acc = 0; const segs = tempos.map((t, i) => { if (i) acc += (t.q - tempos[i - 1].q) * 60 / tempos[i - 1].bpm; return { q: t.q, bpm: t.bpm, sec: acc }; });
  const secAt = (q) => { let s = segs[0]; for (let i = 1; i < segs.length && segs[i].q <= q; i++) s = segs[i]; return s.sec + (q - s.q) * 60 / s.bpm; };
  const qAt = (sec) => { let s = segs[0]; for (let i = 1; i < segs.length && segs[i].sec <= sec; i++) s = segs[i]; return s.q + (sec - s.sec) * s.bpm / 60; };
  const bpmAt = (sec) => { let s = segs[0]; for (let i = 1; i < segs.length && segs[i].sec <= sec; i++) s = segs[i]; return s.bpm; };
  // occ: 연주 순서상의 위치(원본 마디 번호 + 몇 번째로 연주되는지). 도돌이표를 펼치면 같은 원본 음이 여러 occ를 가진다.
  const all = raw.notes.filter((n) => n.midi >= 21 && n.midi <= 108).map((n, i) => ({ ...n, id: i, occ: `${n.src ? n.src.measure : n.measure + 1}#${n.pass || 1}`, start: secAt(n.startQ), end: secAt(n.startQ + n.durQ) }));
  all.sort((a, b) => a.startQ - b.startQ || a.midi - b.midi || b.durQ - a.durQ);
  // 같은 순간 같은 건반이 두 번(두 성부에 겹쳐) 적혀 있으면 한 번만 친다 — 겹치면 소리가 끊기고 어색해짐
  const notes = [];
  // 같은 순간인지는 초가 아니라 악보 시간(4분음표 단위)으로 판단한다
  const sameQ = (a, b) => Math.abs(a - b) < 1e-6;
  for (const n of all) { const prev = notes[notes.length - 1]; if (prev && prev.midi === n.midi && sameQ(prev.startQ, n.startQ)) { prev.end = Math.max(prev.end, n.end); prev.durQ = Math.max(prev.durQ, n.durQ); if (!prev.finger) prev.finger = n.finger; continue; } notes.push(n); }
  const measures = raw.measures.map((m, i) => ({ ...m, idx: i, src: m.src ?? i, pass: m.pass || 1, start: secAt(m.startQ), end: secAt(m.startQ + m.lenQ) }));
  const lastNoteEnd = notes.reduce((m, n) => Math.max(m, n.end), 0);
  const duration = Math.max(measures.length ? measures[measures.length - 1].end : 0, lastNoteEnd);
  const beats = [];
  measures.forEach((m) => { const bq = 4 / m.beatType; const cnt = Math.max(1, Math.round(m.lenQ / bq)); for (let k = 0; k < cnt; k++) beats.push({ sec: secAt(m.startQ + k * bq), down: k === 0 && m.lenQ >= m.beats * bq - 1e-6 }); });
  const steps = [];
  notes.forEach((n) => { const last = steps[steps.length - 1]; if (last && sameQ(last.startQ, n.startQ)) last.notes.push(n); else steps.push({ start: n.start, startQ: n.startQ, notes: [n], measure: n.measure, occ: n.occ }); });
  // 실제 연주처럼 음량 균형: 오른손 맨 윗음(멜로디)은 또렷하게, 화음 안쪽 음과 왼손은 부드럽게, 왼손 맨 아랫음(베이스)은 조금 받쳐 준다
  steps.forEach((st) => {
    const R = st.notes.filter((n) => n.hand === "R").sort((a, b) => b.midi - a.midi), L = st.notes.filter((n) => n.hand === "L").sort((a, b) => a.midi - b.midi);
    const crowd = Math.max(0, st.notes.length - 3) * 0.02;
    R.forEach((n, i) => { n.vel = (i === 0 ? 0.74 : 0.5) - crowd; });
    L.forEach((n, i) => { n.vel = (i === 0 ? 0.56 : 0.44) - crowd; });
  });
  let lo = 127, hi = 0; notes.forEach((n) => { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); });
  if (!notes.length) { lo = 60; hi = 72; }
  const maxDur = notes.reduce((m, n) => Math.max(m, n.end - n.start), 0);
  const tempoMarks = tempos.map((t) => { let mi = 0; while (mi + 1 < measures.length && measures[mi + 1].startQ <= t.q + 1e-6) mi++; return { q: t.q, bpm: t.bpm, measure: mi }; });
  // 연주 위치(펼친 시간) → 원본 악보 위치(악보 커서용)
  const toSrcQ = (q) => { let lo2 = 0, hi2 = measures.length - 1; while (lo2 < hi2) { const m2 = (lo2 + hi2 + 1) >> 1; if (measures[m2].startQ <= q + 1e-9) lo2 = m2; else hi2 = m2 - 1; } const m = measures[lo2]; return m ? srcMeasures[m.src].startQ + (q - m.startQ) : q; };
  return { title: raw.title, composer: raw.composer || "", notes, measures, srcMeasures, srcCount: srcMeasures.length, expanded: !!raw.expanded, jumps: !!raw.jumps, toSrcQ, beats, steps, duration, lo, hi, maxDur, secAt, qAt, bpmAt, baseBpm: tempos[0].bpm, tempoMarks, ...extra };
}

/* ============================================================
   6) 예제 곡: 베토벤 「환희의 송가」 (퍼블릭 도메인, 초급 편곡)
   ============================================================ */
function q(p, f, d) { return { p, d: d || "q", f }; }
const ODE = (() => {
  const L1 = [q("E4", 3), q("E4", 3), q("F4", 4), q("G4", 5)];
  const L2 = [q("G4", 5), q("F4", 4), q("E4", 3), q("D4", 2)];
  const L3 = [q("C4", 1), q("C4", 1), q("D4", 2), q("E4", 3)];
  const L4a = [q("E4", 3, "q."), q("D4", 2, "e"), q("D4", 2, "h")];
  const L4b = [q("D4", 2, "q."), q("C4", 1, "e"), q("C4", 1, "h")];
  const C = [q("C3", 5, "w")], G = [q("G3", 1, "w")];
  const ms = [
    { rh: L1, lh: C }, { rh: L2, lh: G }, { rh: L3, lh: C }, { rh: L4a, lh: G },
    { rh: L1, lh: C }, { rh: L2, lh: G }, { rh: L3, lh: C }, { rh: L4b, lh: [q("G3", 1, "h"), q("C3", 5, "h")] },
    { rh: [q("D4", 2), q("D4", 2), q("E4", 3), q("C4", 1)], lh: G },
    { rh: [q("D4", 2), q("E4", 3, "e"), q("F4", 4, "e"), q("E4", 3), q("C4", 1)], lh: C },
    { rh: [q("D4", 2), q("E4", 3, "e"), q("F4", 4, "e"), q("E4", 3), q("D4", 2)], lh: G },
    { rh: [q("C4", 1), q("D4", 2), q("r", null, "h")], lh: [q("E3", 3, "h"), q("G3", 1, "h")] },
    { rh: L1, lh: C }, { rh: L2, lh: G }, { rh: L3, lh: C }, { rh: L4b, lh: [q("G3", 1, "h"), q("C3", 5, "h")] }
  ];
  return { title: "환희의 송가 (초급)", composer: "L. v. Beethoven", bpm: 96, time: [4, 4], fifths: 0, measures: ms };
})();

/* ============================================================
   7) 소리: 실제 그랜드 피아노 샘플 재생 (Web Audio)
   ============================================================ */
const Sound = {
  ctx: null, master: null, rev: null, noise: null, bank: null, banks: {}, voices: [],
  // 실제 그랜드 피아노 녹음 두 세트:
  //  sal = Salamander Grand Piano V3 (Yamaha C5, 3건반 간격 실제 녹음, MIT) — 기본
  //  key = 88건반을 건반마다 따로 녹음한 세트 (piano-mp3 / midi-js-soundfonts, MIT)
  raw: null,
  loadBank(set) {
    set = set || settings.soundSet || "sal";
    if (this.banks[set]) return this.banks[set].then((b) => { if ((settings.soundSet || "sal") === set) this.bank = b; return b; });
    this.banks[set] = (async () => {
      try {
        if (!this.raw) this.raw = JSON.parse(document.getElementById("pianoSamples").textContent);
        const data = this.raw[set]; const gains = set === "key" ? this.raw.keyGain : null;
        const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        const dec = OAC ? new OAC(1, 1, 44100) : null;
        const bank = [];
        await Promise.all(Object.keys(data).map(async (k) => {
          const ab = unb64(data[k]);
          const ctx = dec || this.ensure();
          const buf = await new Promise((res, rej) => { const p = ctx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); });
          const ch = buf.getChannelData(0); let peak = 0; for (let i = 0; i < Math.min(ch.length, 20000); i++) peak = Math.max(peak, Math.abs(ch[i]));
          let on = 0; const thr = peak * 0.02; while (on < ch.length && Math.abs(ch[on]) < thr) on++;
          bank.push({ midi: parseInt(k), buf, offset: Math.max(0, on - 64) / buf.sampleRate, gain: gains ? gains[k] : 1 });
        }));
        bank.sort((x, y) => x.midi - y.midi);
        const map = new Map(bank.map((b) => [b.midi, b]));
        bank.byMidi = map;
        if ((settings.soundSet || "sal") === set) this.bank = bank;
        return bank;
      } catch (e) { console.warn("piano samples", e); return null; }
    })();
    return this.banks[set];
  },
  setSet(set) { settings.soundSet = set; saveSettings(); this.bank = null; return this.loadBank(set); },
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
      this.ctx = new AC({ latencyHint: "interactive" });
      const ctx = this.ctx;
      const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -10; lim.knee.value = 8; lim.ratio.value = 10; lim.attack.value = 0.002; lim.release.value = 0.25;
      this.master = ctx.createGain(); this.master.gain.value = settings.volume;
      this.bus = ctx.createGain(); this.bus.gain.value = 0.8;
      // 작은 방 울림(합성 임펄스 응답)
      const len = Math.floor(ctx.sampleRate * 1.8), ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); let lp = 0; for (let i = 0; i < len; i++) { lp = lp * 0.55 + (Math.random() * 2 - 1) * 0.45; d[i] = lp * Math.pow(1 - i / len, 3.2); } }
      this.rev = ctx.createConvolver(); this.rev.buffer = ir;
      const wet = ctx.createGain(); wet.gain.value = 0.22;
      this.bus.connect(this.master); this.bus.connect(this.rev); this.rev.connect(wet); wet.connect(this.master);
      this.master.connect(lim); lim.connect(ctx.destination);
      const nl = Math.floor(ctx.sampleRate * 0.04); const nb = ctx.createBuffer(1, nl, ctx.sampleRate); const nd = nb.getChannelData(0);
      for (let i = 0; i < nl; i++) nd[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / nl, 4);
      this.noise = nb;
      this.loadBank();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  },
  setVolume(v) { if (this.master) this.master.gain.value = v; },
  pick(midi) {
    const b = this.bank; const exact = b.byMidi && b.byMidi.get(midi); if (exact) return exact;
    let best = b[0];
    for (const s of b) if (Math.abs(s.midi - midi) < Math.abs(best.midi - midi)) best = s;
    return best;
  },
  recent: new Map(), // midi → 앱이 이 음을 낸 시각(ms). 마이크가 앱 소리를 피아노로 착각하지 않게.
  note(midi, vel = 0.7, dur = null) {
    this.recent.set(midi, performance.now());
    const ctx = this.ensure(); if (!ctx || !this.bank) return null;
    const t = ctx.currentTime + 0.005;
    // 같은 건반을 다시 치면 앞 소리를 빠르게 끊는다(실제 피아노의 댐퍼처럼)
    this.voices = this.voices.filter((v) => !v.done);
    this.voices.forEach((v) => { if (v.midi === midi) v.release(t, 0.03); });
    if (this.voices.length > 56) this.voices.slice(0, this.voices.length - 56).forEach((v) => v.release(t, 0.04));
    const s = this.pick(midi);
    const src = ctx.createBufferSource(); src.buffer = s.buf; src.playbackRate.value = Math.pow(2, (midi - s.midi) / 12);
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1400 + 15000 * vel * vel; lp.Q.value = 0.3;
    const g = ctx.createGain(); const amp = (0.18 + 0.62 * Math.pow(clamp(vel, 0.05, 1), 1.4)) * (s.gain || 1);
    g.gain.setValueAtTime(amp, t);
    src.connect(lp); lp.connect(g); g.connect(this.bus);
    src.start(t, s.offset);
    const relTau = midi < 48 ? 0.16 : midi < 72 ? 0.11 : 0.08;
    const voice = {
      midi, done: false,
      release(at, tau) {
        if (this.done) return; this.done = true;
        const tt = Math.max(at || ctx.currentTime, t + 0.01);
        g.gain.cancelScheduledValues(tt); g.gain.setValueAtTime(amp, tt); g.gain.setTargetAtTime(0, tt, tau || relTau);
        try { src.stop(tt + (tau || relTau) * 8); } catch (e) {}
      }
    };
    src.onended = () => { voice.done = true; try { g.disconnect(); } catch (e) {} };
    if (dur != null) voice.release(t + Math.max(0.06, dur));
    this.voices.push(voice);
    return voice;
  },
  // 메트로놈: 삐 소리 대신 짧은 우드블록 소리
  click(accent, at) {
    const ctx = this.ensure(); if (!ctx) return;
    const t = at || ctx.currentTime + 0.002;
    const n = ctx.createBufferSource(); n.buffer = this.noise;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = accent ? 2600 : 1900; bp.Q.value = 6;
    const g = ctx.createGain(); g.gain.setValueAtTime(accent ? 0.9 : 0.6, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    n.connect(bp); bp.connect(g); g.connect(this.master); n.start(t); n.stop(t + 0.06);
  }
};
Sound.loadBank();

/* ============================================================
   8) 엔진 상태
   ============================================================ */
let song = null;
const E = {
  pos: 0, playing: false, waiting: false, countIn: 0, countTotal: 0,
  noteCur: 0, beatCur: 0, waitIdx: 0, hits: new Map(), // hits: 지금 차례에서 맞게 친 음 → 친 시각(ms)
  mistakes: 0, correct: 0, loops: 0, passMistakes: 0, finished: false
};
const pressed = new Map();   // midi -> {state:'ok'|'bad'|'free', t}
const userVoices = new Map();
const sounding = new Map();  // midi -> hand (재생 중인 음, 화면 표시용)

function practiceHas(hand) { return settings.hands === "both" || settings.hands === hand; }
function loopRange() {
  if (!song || !settings.loopOn || !song.measures.length) return null;
  // loopA/B는 원본 마디 번호. 연주 순서에서 A의 첫 연주부터 그 뒤 처음 나오는 B까지.
  const n = srcCount();
  const sa = clamp(settings.loopA, 1, n) - 1, sb = clamp(Math.max(settings.loopB, settings.loopA), 1, n) - 1;
  const a = perfOfSrc(sa); let b = a; for (let i = a; i < song.measures.length; i++) { b = i; if (song.measures[i].src === sb) break; }
  return { a, b, sa, sb, start: song.measures[a].start, end: song.measures[b].end };
}
function measureAt(sec) {
  if (!song || !song.measures.length) return 0;
  let lo = 0, hi = song.measures.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (song.measures[mid].start <= sec + 1e-6) lo = mid; else hi = mid - 1; }
  return lo;
}
// 화면에 보이는 마디 번호는 원본 악보 기준(순번+1). 엔진은 펼친(연주 순서) 마디 순번을 쓴다.
const srcOf = (pi) => (song && song.measures[pi] ? song.measures[pi].src : pi);
const srcCount = () => (song ? song.srcCount || song.measures.length : 0);
function perfOfSrc(si, from = 0) { if (!song) return 0; for (let i = Math.max(0, from); i < song.measures.length; i++) if (song.measures[i].src === si) return i; for (let i = 0; i < song.measures.length; i++) if (song.measures[i].src === si) return i; return clamp(si, 0, song.measures.length - 1); }
function nearestPerfOfSrc(si) { if (!song) return 0; const cur = measureAt(E.pos); let best = -1; song.measures.forEach((m, i) => { if (m.src === si && (best < 0 || Math.abs(i - cur) < Math.abs(best - cur))) best = i; }); return best < 0 ? perfOfSrc(si) : best; }
function srcMeasureAt(sec) { return srcOf(measureAt(sec)); }
function measureLabel(pi) { const m = song && song.measures[pi]; if (!m) return String(pi + 1); return String(m.src + 1) + (song.expanded && m.pass > 1 ? `(${m.pass}회)` : ""); }
function lowerBound(arr, sec, key = "start") { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m][key] < sec - 1e-6) lo = m + 1; else hi = m; } return lo; }
function requiredOf(step) { return step.notes.filter((n) => practiceHas(n.hand)); }

// 재생 위치가 바뀐 이유를 남긴다 (역행 원인 추적, 이슈 #14). 사용자 데이터는 담지 않고 시간·마디·이유만.
//   허용된 되돌아감: user(사용자가 옮김), loop(구간 반복), restart(처음부터), song(곡 바꿈), mode(모드 변경 등)
const PosLog = {
  list: [], seq: 0, inSeek: false,
  add(reason, from, to) {
    const mi = (t) => (song ? measureAt(t) + 1 : 0);
    this.list.push({ seq: ++this.seq, t: Math.round(performance.now()), reason, from: +from.toFixed(3), to: +to.toFixed(3), mFrom: mi(from), mTo: mi(to) });
    if (this.list.length > 300) this.list.shift();
  },
  // 악보 커서가 뒤로 갔는데 그 직전에 위치를 옮긴 기록(seek)이 없으면 "이유 없는 역행"으로 남긴다
  cursorBack(fromStep, toStep) {
    if (this.inSeek) return;
    this.add("unexpected-cursor-back", song ? song.secAt(fromStep.q) : 0, song ? song.secAt(toStep.q) : 0);
  },
  unexpected() { return this.list.filter((e) => e.reason.startsWith("unexpected")); },
};
function seek(sec, keepPlaying, reason = "user") {
  if (!song) return;
  const from = E.pos;
  E.pos = clamp(sec, 0, song.duration);
  PosLog.add(reason, from, E.pos);
  E.noteCur = lowerBound(song.notes, E.pos);
  E.beatCur = lowerBound(song.beats, E.pos, "sec");
  E.waitIdx = lowerBound(song.steps, E.pos);
  E.hits.clear(); E.waiting = false; E.finished = false; E.prevStep = null;
  sounding.clear();
  PosLog.inSeek = true; try { Score.sync(true); } finally { PosLog.inSeek = false; }
  updateReadouts();
}
function nextWaitStep() {
  if (!song) return null;
  while (E.waitIdx < song.steps.length && requiredOf(song.steps[E.waitIdx]).length === 0) E.waitIdx++;
  return song.steps[E.waitIdx] || null;
}
// AI 초안에서는 이전 화음의 건반을 계속 누르고 있으면 다시 치지 않아도 맞은 것으로 본다(놓친 붙임줄 대비).
const heldKeys = new Set();
// 화음은 함께 쳐야 맞음: 필요한 음을 모두, 가장 먼저 친 음과 가장 나중 친 음이 CHORD_WINDOW_MS 안이어야 한다.
// (예전에는 시간 제한 없이 모아서 도·미·솔을 따로따로 쳐도 통과했다 — 이슈 #14)
// 설정 "화음을 한 음씩 쳐도 인정"(chordLoose)을 켜면 순서대로 천천히 쳐도 된다(처음 익힐 때).
const CHORD_WINDOW_MS = 200;
function chordSpread(req) { let lo = Infinity, hi = -Infinity; for (const n of req) { const t = E.hits.get(n.midi); lo = Math.min(lo, t); hi = Math.max(hi, t); } return hi - lo; }
function stepSatisfied(st) {
  const lenient = current && current.kind === "ai";
  const req = requiredOf(st).filter((n) => !(lenient && heldKeys.has(n.midi) && E.prevStep && E.prevStep.has(n.midi) && !E.hits.has(n.midi)));
  if (!req.every((n) => E.hits.has(n.midi))) return false;
  return settings.chordLoose || req.length < 2 || chordSpread(req) <= CHORD_WINDOW_MS;
}
// 너무 오래전에 친 음은 이번 화음에서 뺀다 (새로 함께 쳐야 함)
function pruneHits(now) { if (settings.chordLoose) return; for (const [m, t] of E.hits) if (now - t > CHORD_WINDOW_MS) E.hits.delete(m); }
function consumeStep() { const st = song.steps[E.waitIdx]; if (st) { E.correct += requiredOf(st).length; E.prevStep = new Set(requiredOf(st).map((n) => n.midi)); } E.waitIdx++; E.hits.clear(); updateStats(); }

function play(opts = {}) {
  if (!song) return;
  Sound.ensure();
  const lr = loopRange();
  if (E.finished || E.pos >= song.duration - 0.01) seek(lr ? lr.start : 0, false, "restart");
  if (lr && (E.pos < lr.start - 0.01 || E.pos >= lr.end - 0.01)) seek(lr.start, false, "loop");
  E.playing = true; E.loopTold = false; Practice.start();
  if (settings.countIn && !opts.noCountIn) startCountIn();
  setPlayIcon(); updateInputHint();
}
function pause() { if (E.playing) Practice.flush(); E.playing = false; E.countIn = 0; $("#countdown").hidden = true; setPlayIcon(); }
function togglePlay() { E.playing ? pause() : play(); }
function startCountIn() {
  const m = song.measures[measureAt(E.pos)] || { beats: 4, beatType: 4 };
  const beatsN = clamp(m.beats || 4, 2, 6);
  const beatSec = (60 / song.bpmAt(E.pos)) * (4 / (m.beatType || 4)) / settings.rate;
  E.countTotal = beatsN; E.countBeat = beatSec; E.countIn = beatsN * beatSec;
  const ctx = Sound.ensure();
  if (ctx) for (let k = 0; k < beatsN; k++) Sound.click(k === 0, ctx.currentTime + 0.03 + k * beatSec);
}

function fireNotes(a, b) {
  const notes = song.notes;
  while (E.noteCur < notes.length && notes[E.noteCur].start < b - 1e-9) {
    const n = notes[E.noteCur++];
    if (n.start < a - 1e-4) continue;
    const mine = practiceHas(n.hand);
    const audible = mine ? (settings.mode === "wait" ? settings.guide : true) : settings.accomp;
    if (audible) Sound.note(n.midi, clamp((n.vel || 0.6) * (mine ? 1 : 0.85), 0.2, 0.9), (n.end - n.start) / settings.rate);
  }
}
function fireBeats(a, b) {
  const beats = song.beats;
  while (E.beatCur < beats.length && beats[E.beatCur].sec < b - 1e-9) {
    const bt = beats[E.beatCur++];
    if (bt.sec >= a - 1e-4 && settings.metro) Sound.click(bt.down);
  }
}
function advance(d) {
  const lr = loopRange();
  const end = lr ? lr.end : song.duration;
  let target = Math.min(E.pos + d, end);
  if (settings.mode === "wait") {
    for (;;) {
      const st = nextWaitStep();
      if (!st || st.start > target + 1e-9 || st.start >= end - 1e-6) break;
      if (stepSatisfied(st)) { consumeStep(); continue; }
      target = Math.max(E.pos, st.start); E.waiting = true; break;
    }
  }
  fireNotes(E.pos, target + (E.waiting ? 0 : 0));
  fireBeats(E.pos, target);
  if (target < E.pos - 1e-9) PosLog.add("unexpected-advance-back", E.pos, target); // 재생 중에는 앞으로만 간다
  E.pos = Math.max(E.pos, target);
  if (!E.waiting && E.pos >= end - 1e-6) {
    if (lr) {
      onLoopDone(); seek(lr.start, true, "loop"); if (settings.countIn) startCountIn();
      // 구간 반복으로 되돌아간다는 걸 알려 준다 (켜 둔 걸 잊으면 "뒤로 가서 다시 친다"로 보일 수 있음)
      if (!E.loopTold) { E.loopTold = true; toast(`구간 반복 중: ${lr.sa + 1}~${lr.sb + 1}마디를 다시 쳐요 (반복 버튼으로 끌 수 있어요)`); }
    }
    else { E.playing = false; E.finished = true; Practice.flush(); setPlayIcon(); toast(settings.mode === "wait" ? `끝까지 쳤어요! 정확도 ${accText()}` : "곡이 끝났어요. ▶를 누르면 처음부터 다시 들어요."); }
  }
}
function onLoopDone() {
  E.loops++;
  if (settings.mode === "wait" && settings.autoSpeed) {
    if (E.passMistakes === 0 && settings.rate < 1) { setRate(Math.min(1, Math.round((settings.rate + 0.05) * 100) / 100)); toast(`실수 없이 통과! 속도를 ${Math.round(settings.rate * 100)}%로 올렸어요.`); }
    else if (E.passMistakes > 0) toast(`이번 바퀴 틀린 음 ${E.passMistakes}개. 같은 속도로 한 번 더!`);
  }
  E.passMistakes = 0; updateStats();
}
function accText() { const t = E.correct + E.mistakes; return t ? Math.round(E.correct / t * 100) + "%" : "–"; }

/* ============================================================
   9) 입력 (화면 건반 · PC 키보드 · MIDI · 마이크)
   ============================================================ */
function userNoteOn(midi, vel = 0.75, src = "screen", opts = {}) {
  if (midi < 21 || midi > 108) return;
  // 따라치기에서 멈춰 있을 때 첫 음을 맞게 치면 바로 시작한다 (▶를 누르러 손을 뗄 필요 없음)
  if (settings.mode === "wait" && song && !E.playing && !E.finished) {
    const st = nextWaitStep();
    if (st && requiredOf(st).some((n) => n.midi === midi) && st.start - E.pos < 4) { seek(st.start, false, "autostart"); play({ noCountIn: true }); }
  }
  heldKeys.add(midi);
  if (settings.inputSound) {
    const old = userVoices.get(midi); if (old) old.release();
    userVoices.set(midi, Sound.note(midi, vel));
  } else Sound.ensure();
  let state = "free";
  if (settings.mode === "wait" && E.playing && E.countIn <= 0 && song) {
    const st = nextWaitStep();
    if (st) {
      const req = requiredOf(st).map((n) => n.midi);
      const earlyReal = (st.start - E.pos) / settings.rate;
      if (req.includes(midi) && earlyReal <= 0.6) {
        const now = performance.now(); pruneHits(now); E.hits.set(midi, now); state = "ok";
        if (stepSatisfied(st)) { const wasWaiting = E.waiting; E.waiting = false; consumeStep(); if (wasWaiting) fireNotes(E.pos, E.pos + 1e-6); }
      } else if (!req.includes(midi)) { state = "bad"; if (!opts.noPenalty) { E.mistakes++; E.passMistakes++; updateStats(); } }
    }
  }
  pressed.set(midi, { state, t: performance.now() });
}
function userNoteOff(midi) {
  heldKeys.delete(midi);
  const v = userVoices.get(midi); if (v) { v.release(); userVoices.delete(midi); }
  const p = pressed.get(midi); if (p) { p.up = performance.now(); }
}
// PC 키보드 (e.code 기준이라 한글 입력 상태에서도 동작)
const KEYMAP = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17 };
const kbDown = new Map();
window.addEventListener("keydown", (e) => {
  const tg = e.target;
  if (tg && (tg.tagName === "SELECT" || tg.tagName === "TEXTAREA" || (tg.tagName === "INPUT" && !["checkbox", "range"].includes(tg.type)))) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!$("#aiModal").hidden) return;
  if (e.code === "Space") { e.preventDefault(); if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); if (!e.repeat) togglePlay(); return; }
  if (e.code === "Backslash" && !e.repeat && getComputedStyle($("#sideToggle")).display !== "none") { e.preventDefault(); setSideCollapsed(!settings.sideCollapsed); return; }
  if (e.code === "ArrowLeft") { e.preventDefault(); stepMeasure(-1); return; }
  if (e.code === "ArrowRight") { e.preventDefault(); stepMeasure(1); return; }
  if (e.code === "Home") { e.preventDefault(); restart(); return; }
  if (e.code === "KeyZ") { settings.kbBase = clamp(settings.kbBase - 12, 24, 96); saveSettings(); updateOct(); return; }
  if (e.code === "KeyX") { settings.kbBase = clamp(settings.kbBase + 12, 24, 96); saveSettings(); updateOct(); return; }
  if (e.code in KEYMAP) { e.preventDefault(); if (e.repeat || kbDown.has(e.code)) return; const m = settings.kbBase + KEYMAP[e.code]; kbDown.set(e.code, m); Input.on(m, 0.75, "kb"); }
});
window.addEventListener("keyup", (e) => { if (kbDown.has(e.code)) { Input.off(kbDown.get(e.code)); kbDown.delete(e.code); } });
window.addEventListener("blur", () => { kbDown.forEach((m) => Input.off(m)); kbDown.clear(); });
function updateOct() { $("#octLabel").textContent = "도" + octOf(settings.kbBase); }

// Web MIDI
let midiAccess = null;
async function connectMIDI() {
  const st = $("#midiStatus");
  if (!navigator.requestMIDIAccess) { st.textContent = "이 브라우저는 MIDI를 지원하지 않아요. 크롬·엣지에서 내려받은 파일로 열어 보세요."; return; }
  try {
    midiAccess = await navigator.requestMIDIAccess();
    const bind = () => {
      const names = [];
      midiAccess.inputs.forEach((inp) => { names.push(inp.name); inp.onmidimessage = onMidiMsg; });
      st.textContent = names.length ? "연결됨: " + names.join(", ") : "연결된 MIDI 기기가 없어요. 케이블을 꽂으면 자동으로 잡혀요.";
      st.classList.toggle("on", names.length > 0); updateInputHint();
      if (names.length && settings.inputSound && !midiAccess._muted) { midiAccess._muted = true; settings.inputSound = false; $("#inputSound").checked = false; saveSettings(); toast("전자피아노 소리를 쓰도록 앱의 입력음은 껐어요"); }
    };
    midiAccess.onstatechange = bind; bind();
  } catch (e) { st.textContent = "MIDI를 쓸 수 없어요. 이 화면에서 막혀 있다면 내려받은 파일을 크롬으로 열어 주세요."; }
}

// ---- 입력 공통: MIDI·마이크·화면 건반 모두 "새로 친 음(onset)" 하나를 한 번만 쓴다 ----
const Input = {
  seq: 0, lastOn: new Map(), lat: [],
  // 같은 음이 다른 MIDI 포트 등에서 8ms 안에 두 번 오면 한 번으로 친다
  on(midi, vel, source, capturedAt, opts) {
    const now = performance.now(), last = this.lastOn.get(midi);
    if (last && last.source !== source && now - last.t < 8) return null;
    if (last && source === "midi" && last.port && last.port !== this.port && now - last.t < 8) return null;
    const id = ++this.seq; this.lastOn.set(midi, { t: now, source, port: this.port });
    if (capturedAt != null) { this.lat.push(now - capturedAt); if (this.lat.length > 200) this.lat.shift(); }
    userNoteOn(midi, vel, source, opts);
    return id;
  },
  off(midi) { userNoteOff(midi); },
  latency() { if (!this.lat.length) return null; const a = this.lat.slice().sort((x, y) => x - y); const q = (p) => Math.round(a[Math.min(a.length - 1, Math.floor(p * a.length))]); return { n: a.length, p50: q(0.5), p95: q(0.95) }; },
};
function onMidiMsg(ev) {
  const [s, d1, d2] = ev.data; const type = s & 0xf0;
  Input.port = ev.target && ev.target.id;
  if (type === 0x90 && d2 > 0) Input.on(d1, d2 / 127, "midi");
  else if (type === 0x80 || (type === 0x90 && d2 === 0)) Input.off(d1);
}

// ---- 마이크 분석기: 음 높이(자기상관)와 새로 친 순간(에너지 급증)을 따로 판단 ----
// 같은 음을 다시 쳐도 소리 크기가 다시 커지는 순간을 새 타건으로 본다. 길게 누른 음(줄어드는 소리)은 한 번만.
// 워커 안에서도 그대로 돌도록 바깥 변수를 쓰지 않는다 (toString()으로 워커에 넣음).
function createMicAnalyzer(sr, opt = {}) {
  const HOP = 512, WIN = 2048, FMIN = opt.fmin || 50, FMAX = opt.fmax || 1400;
  const minLag = Math.floor(sr / FMAX), maxLag = Math.min(Math.floor(sr / FMIN), WIN - 64);
  const ring = new Float32Array(WIN); let filled = 0;
  // 화음용: 최근 4096샘플(약 85ms)과 타건 직전 상태
  const BIG = 4096, big = new Float32Array(BIG), bigPrev = new Float32Array(BIG); let polyWait = 0, polyTries = 0, pre = null, curSet = new Set();
  const hist = [], hfHist = []; const floorHist = []; let floor = 0.003, cur = null, wait = 0, tries = 0, tryMidi = null, lastOnsetT = -1, quiet = 0, hop = 0, cand = null, candN = 0, prevRms = 0, prevHf = 0, lastSample = 0;
  function pitch() {
    // 최근 WIN 샘플에서 자기상관. 첫 봉우리 중 가장 높은 것의 88% 이상인 가장 짧은 주기
    const N = WIN; let e0 = 0; for (let i = 0; i < N; i += 2) e0 += ring[i] * ring[i];
    if (e0 <= 0) return null;
    const corr = new Float32Array(maxLag + 2); let peak = 0;
    for (let lag = minLag; lag <= maxLag + 1; lag++) { let s = 0; for (let i = 0; i < N - lag; i += 2) s += ring[i] * ring[i + lag]; corr[lag] = s; if (lag <= maxLag && s > peak) peak = s; }
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (corr[lag] > peak * 0.88 && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) {
        const y1 = corr[lag - 1], y2 = corr[lag], y3 = corr[lag + 1]; const sh = (y3 - y1) / (2 * (2 * y2 - y1 - y3) || 1);
        const f = sr / (lag + sh); const conf = y2 / e0 * (N / (N - lag));
        return { midi: Math.round(69 + 12 * Math.log2(f / 440)), f, conf };
      }
    }
    return null;
  }
  // 여러 음(화음) 높이 추정: FFT 스펙트럼 봉우리 → 배음 합(salience)이 가장 큰 음을 하나씩 뽑고, 그 음의 배음 몫을 빼고 반복.
  // 기본음이 실제로 있어야 인정(한 옥타브 아래 오인 방지), 이미 찾은 음의 옥타브 위는 더 강해야 인정(배음 찌꺼기 방지).
  // 반환 [{midi, s}] (s: 배음 합 강도, 절대값). 합성 화음 시험 기준 정밀도 약 0.95·재현율 약 0.9 — 실제 피아노 수치 아님.
  function estimatePitches(x, lo = 36, hi = 96, maxN = 6) {
    const N = 8192, L = Math.min(x.length, 4096);
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < L; i++) re[i] = x[x.length - L + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (L - 1)));
    for (let i = 1, j = 0; i < N; i++) { let bit = N >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let len = 2; len <= N; len <<= 1) { const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a), h2 = len >> 1;
      for (let i = 0; i < N; i += len) { let cr = 1, ci = 0; for (let k = 0; k < h2; k++) { const p = i + k, q = p + h2; const vr = re[q] * cr - im[q] * ci, vi = re[q] * ci + im[q] * cr; re[q] = re[p] - vr; im[q] = im[p] - vi; re[p] += vr; im[p] += vi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } }
    const half = N / 2, mag = new Float64Array(half); let mx = 0;
    for (let k = 0; k < half; k++) { mag[k] = Math.hypot(re[k], im[k]); if (mag[k] > mx) mx = mag[k]; }
    if (mx <= 0) return [];
    const peaks = [], bin = sr / N;
    for (let k = 2; k < half - 2; k++) if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1] && mag[k] > mx * 0.01) {
      const a = Math.log(mag[k - 1] + 1e-12), b = Math.log(mag[k]), c = Math.log(mag[k + 1] + 1e-12); const d = 0.5 * (a - c) / (a - 2 * b + c || 1);
      peaks.push({ f: (k + d) * bin, a: mag[k] });
    }
    const amp = peaks.map((q) => q.a);
    const harm = (f0) => { const out = []; for (let h = 1; h <= 10; h++) { const ft = h * f0; if (ft > sr / 2 - 200) break; let best = -1, bd = Infinity; for (let i = 0; i < peaks.length; i++) { const dd = Math.abs(peaks[i].f - ft) / ft; if (dd < 0.03 && dd < bd) { bd = dd; best = i; } } out.push(best); } return out; };
    const sal = (m) => { const f0 = 440 * Math.pow(2, (m - 69) / 12); const hs = harm(f0); let v = 0; hs.forEach((i, h) => { if (i >= 0) v += amp[i] * (f0 + 20) / ((h + 1) * f0 + 320); }); return { v, hs }; };
    const found = [], skip = new Set(); let first = 0;
    for (let guard = 0; found.length < maxN && guard < 40; guard++) {
      let best = null;
      for (let m = lo; m <= hi; m++) { if (skip.has(m)) continue; const r = sal(m); if (!best || r.v > best.v) best = { ...r, midi: m }; }
      if (!best || best.v <= 0) break;
      if (!first) first = best.v; else if (best.v < first * 0.25) break;
      skip.add(best.midi);
      if (found.some((f) => best.midi > f.midi && (best.midi - f.midi) % 12 === 0) && best.v < first * 0.5) continue;
      const f1 = best.hs[0]; const strong = Math.max(...best.hs.filter((i) => i >= 0).map((i) => amp[i]));
      if (f1 < 0 || amp[f1] < strong * 0.15) continue;
      found.push({ midi: best.midi, s: best.v }); // 절대 강도 (타건 전후 비교용)
      const snap = best.hs.map((i) => (i >= 0 ? amp[i] : 0));
      best.hs.forEach((i, h) => { if (i < 0) return; const nb = [snap[h - 1], snap[h + 1]].filter((v) => v != null && v > 0); const smooth = nb.length ? Math.min(snap[h], Math.max(...nb)) : snap[h]; amp[i] = Math.max(0, amp[i] - (h === 0 ? snap[h] : smooth)); });
    }
    return found.sort((a, b) => a.midi - b.midi);
  }
  // 짧은 구간(마지막 len 샘플)에서 f0의 1~3배음 에너지 (타건 전후 비교용)
  function hEnergy(x, f0, len = 1024) { let e = 0; const s0 = x.length - len; for (let h = 1; h <= 3; h++) { const w = 2 * Math.PI * h * f0 / sr; if (h * f0 > sr / 2) break; let re = 0, im = 0; for (let i = 0; i < len; i++) { const v = x[s0 + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (len - 1))); re += v * Math.cos(w * i); im -= v * Math.sin(w * i); } e += (re * re + im * im) / h; } return e / (len * len); }
  return {
    estimatePitches, hEnergy,
    range: [Math.round(69 + 12 * Math.log2(FMIN / 440)), Math.round(69 + 12 * Math.log2(FMAX / 440))],
    // block: HOP개 샘플, t: 블록 끝 시각(초). 반환: [{type:'on'|'off', midi, conf, t}]
    feed(block, t) {
      const ev = [];
      ring.copyWithin(0, block.length); ring.set(block, WIN - block.length); filled = Math.min(WIN, filled + block.length); hop++;
      if (opt.poly) { bigPrev.set(big); big.copyWithin(0, block.length); big.set(block, BIG - block.length); }
      // r: 소리 크기, hf: 고음역 변화량(1차 차분) — 해머가 줄을 칠 때 짧게 커진다
      let r = 0, hf = 0, last = lastSample; for (let i = 0; i < block.length; i++) { r += block[i] * block[i]; const d = block[i] - last; hf += d * d; last = block[i]; } lastSample = last;
      r = Math.sqrt(r / block.length); hf = Math.sqrt(hf / block.length);
      hist.push(r); hfHist.push(hf); if (hist.length > 8) { hist.shift(); hfHist.shift(); }
      // 잡음 수준 = 최근 약 2초 동안 가장 조용했던 블록. 내려갈 땐 바로, 올라갈 땐 천천히(페달로 계속 울려도 끌려 올라가지 않게), 최대 0.003
      floorHist.push(r); if (floorHist.length > 190) floorHist.shift();
      floor = Math.max(1e-5, Math.min(Math.min(...floorHist) * 1.2, floor * 1.002, 0.003));
      // 소리 있음 기준: 잡음의 4배 이상, 최소 0.0025 (아이패드 등 기기 마이크는 소리가 작게 들어와 예전 0.01은 너무 높았다)
      const loud = r > Math.max(opt.minLevel || 0.0025, floor * 4);
      if (hop % 4 === 0) ev.push({ type: "level", r: +r.toFixed(5), floor: +floor.toFixed(5), t });
      const minOf = (a) => Math.min(...a.slice(0, -1).concat([1]));
      // 새 타건: 최근(약 80ms) 최저보다 소리가 1.5배 이상(또는 고음역 변화가 2배 이상) 커지고, 직전 블록보다도 커짐. 70ms 안에는 한 번만
      // 화음 모드는 여러 음이 겹쳐 맥놀이(크기 출렁임)가 생기므로 기준을 높인다: 해머 타격의 고음역 변화, 또는 크기가 1.8배 이상 커질 때
      const hammer = hf > minOf(hfHist) * 2 && hf > prevHf * 1.5;
      const rise = opt.poly ? (hammer && r > prevRms * 1.1) || (r > minOf(hist) * 1.8 && r > prevRms * 1.3) : (r > minOf(hist) * 1.5 && r > prevRms * 1.25) || (hammer && r > prevRms * 1.05);
      if (loud && rise && (lastOnsetT < 0 || t - lastOnsetT > 0.07)) {
        lastOnsetT = t;
        if (opt.poly) { pre = bigPrev.slice(BIG - 1024); polyWait = 6; polyTries = 4; } // 화음: 타건 약 65ms 뒤 한 번에. 타건 직전 약 20ms를 남겨 두고 비교
        else { wait = 2; tries = 9; tryMidi = null; }
      }
      prevRms = r; prevHf = hf;
      if (filled < WIN) return ev;
      if (wait > 0) wait--;
      if (opt.poly && polyWait > 0 && --polyWait === 0) {
        // 새로 친 음 = 타건 뒤에 있고, 그 음의 배음 에너지가 타건 직전보다 2배 이상 커진 음. 페달로 울리던(줄어드는) 소리는 뺀다.
        const post = loud ? estimatePitches(big) : [];
        const fresh = post.filter((q) => { const f0 = 440 * Math.pow(2, (q.midi - 69) / 12); const a = pre ? hEnergy(pre, f0) : 0, b = hEnergy(big, f0); return a < 1e-9 || b > a * 2; }).map((q) => q.midi);
        if (fresh.length) {
          for (const m of curSet) if (!post.some((q) => q.midi === m)) { ev.push({ type: "off", midi: m, t }); curSet.delete(m); }
          fresh.forEach((m) => curSet.add(m)); cur = fresh.length === 1 ? fresh[0] : null; cand = cur; candN = 3;
          ev.push({ type: "chord", midis: fresh, sounding: post.map((q) => q.midi), t, onset: true });
        } else if (--polyTries > 0) polyWait = 2; // 낮은 음은 조금 더 기다려 봄
      }
      if (tries > 0 && wait === 0) {
        // 타건 약 20ms 뒤부터 음 높이를 재서 두 번 연속 같으면 확정(앞 음 여운이 섞인 순간을 피함).
        // 낮은 음은 주기가 길어 늦게 정해질 수 있어 몇 번 더 시도(최대 약 120ms)
        tries--;
        const p = loud ? pitch() : null;
        const agreed = p && p.conf > 0.55 && p.midi === tryMidi;
        tryMidi = p && p.conf > 0.55 ? p.midi : null;
        if (agreed) { tries = 0; if (cur != null) ev.push({ type: "off", midi: cur, t }); cur = p.midi; cand = p.midi; candN = 3; ev.push({ type: "on", midi: p.midi, conf: +p.conf.toFixed(2), t, onset: true }); }
      } else if (cur != null && loud && tries === 0 && hop % 3 === 0) {
        // 이어서 치는(레가토) 다른 음: 소리 크기 급증 없이 높이만 바뀐 경우, 세 번 연속(약 30ms 간격) 같고 확실하면 새 음
        const p = pitch();
        if (p && p.conf > 0.75) { if (p.midi === cand) candN++; else { cand = p.midi; candN = 1; } if (p.midi !== cur && candN >= 3) { ev.push({ type: "off", midi: cur, t }); if (opt.poly) { curSet.delete(cur); curSet.add(p.midi); } cur = p.midi; ev.push({ type: "on", midi: p.midi, conf: +p.conf.toFixed(2), t, onset: false }); } }
      }
      if (!loud) { if (++quiet >= 4) { if (cur != null && !curSet.has(cur)) ev.push({ type: "off", midi: cur, t }); for (const m of curSet) ev.push({ type: "off", midi: m, t }); curSet.clear(); cur = null; } } else quiet = 0;
      return ev;
    },
  };
}

// 마이크 수집: AudioWorklet(가능하면) → 분석은 Worker(가능하면) → 이벤트만 화면 쪽으로
const MIC_WORKLET = `class GunbanCap extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(512);this.n=0;}process(i){const c=i[0]&&i[0][0];if(c){for(let k=0;k<c.length;k++){this.b[this.n++]=c[k];if(this.n===512){this.port.postMessage({b:this.b.slice(0),t:currentTime});this.n=0;}}}return true;}}registerProcessor('gunban-cap',GunbanCap);`;
const Mic = {
  on: false, stream: null, node: null, worker: null, an: null, saved: null, cur: null, timer: 0, mode: "",
  status(msg, on) { const st = $("#micStatus"); st.textContent = msg; st.classList.toggle("on", !!on); },
  rangeText() { const r = createMicAnalyzer(48000).range; return `${fullName(r[0])}~${fullName(r[1])}, 약 50~1400Hz`; },
  async start() {
    try {
      const ctx = Sound.ensure();
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) {
      const n = e && e.name;
      this.status(n === "NotAllowedError" ? "마이크 권한이 거부됐어요. 주소창 왼쪽 자물쇠 → 마이크 → 허용으로 바꾼 뒤 다시 켜 주세요."
        : n === "NotFoundError" ? "마이크를 찾지 못했어요. 마이크를 연결한 뒤 다시 켜 주세요."
        : "마이크를 쓸 수 없어요. 이 화면에서는 마이크가 막혀 있을 수 있어요. 웹 버전(크롬)에서 열어 주세요.");
      return;
    }
    const ctx = Sound.ctx, sr = ctx.sampleRate;
    this.stream.getTracks().forEach((tr) => { tr.onended = () => { if (this.on) { this.stop(); toast("마이크 연결이 끊겼어요"); } }; });
    const src = ctx.createMediaStreamSource(this.stream);
    const onEvents = (evs, capturedAt) => evs.forEach((e) => this.handle(e, capturedAt));
    // 분석기: 워커 → 실패하면 화면 쪽에서
    let feed = null;
    try {
      const code = `${createMicAnalyzer.toString()}\nlet A=null;onmessage=(m)=>{const d=m.data;if(d.init){A=createMicAnalyzer(d.sr,d.opt);return;}const at=d.at;postMessage({ev:A.feed(d.b,d.t),at});};`;
      this.worker = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
      this.worker.postMessage({ init: true, sr, opt: { poly: !!settings.micChord } });
      this.worker.onmessage = (m) => onEvents(m.data.ev, m.data.at);
      feed = (b, t) => this.worker.postMessage({ b, t, at: performance.now() }, [b.buffer]);
      this.mode = "worker";
    } catch (e) { const A = createMicAnalyzer(sr, { poly: !!settings.micChord }); feed = (b, t) => onEvents(A.feed(b, t), performance.now()); this.mode = "main"; }
    try {
      try { await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([MIC_WORKLET], { type: "text/javascript" }))); }
      catch (e1) { await ctx.audioWorklet.addModule("data:text/javascript;charset=utf-8," + encodeURIComponent(MIC_WORKLET)); } // 파일로 열었을 때(origin null)는 blob이 막힘
      this.node = new AudioWorkletNode(ctx, "gunban-cap");
      const mute = ctx.createGain(); mute.gain.value = 0; src.connect(this.node); this.node.connect(mute); mute.connect(ctx.destination);
      this.node.port.onmessage = (m) => feed(m.data.b, m.data.t);
      this.mode += "+worklet";
    } catch (e) {
      // 예비: 10ms마다 최근 512샘플을 읽음 (화면 그리기와 상관없이)
      this.an = ctx.createAnalyser(); this.an.fftSize = 512; src.connect(this.an);
      this.timer = setInterval(() => { const b = new Float32Array(512); this.an.getFloatTimeDomainData(b); feed(b, ctx.currentTime); }, 1000 * 512 / sr);
      this.mode += "+poll"; this.workletError = String(e && (e.message || e)).slice(0, 120);
    }
    this.on = true;
    // 스피커에서 나는 앱 소리를 피아노로 착각하지 않도록 앱 소리를 잠시 끈다 (끄면 되돌림)
    const keys = ["accomp", "guide", "metro", "inputSound"]; const loud = keys.filter((k) => settings[k]);
    if (loud.length) { this.saved = Object.fromEntries(keys.map((k) => [k, settings[k]])); keys.forEach((k) => { settings[k] = false; const el = $("#" + k); if (el) el.checked = false; }); $("#metroBtn").setAttribute("aria-pressed", "false"); toast("마이크가 앱 소리를 피아노 소리로 착각하지 않도록 반주·안내음·메트로놈·입력음을 잠시 껐어요. 마이크를 끄면 다시 켜져요."); }
    this.stats = { blocks: 0, onsets: 0, maxLevel: 0, lastLevel: 0, since: performance.now() }; this.syncUi();
    this.status(`듣는 중 · ${settings.micChord ? "화음도(최대 6음, 베타)" : "한 번에 한 음"} · ${this.rangeText()} · 헤드폰을 쓰면 더 정확해요`, true); $("#micBtn").textContent = "끄기";
  },
  curSet: new Set(), stats: { blocks: 0, onsets: 0, maxLevel: 0, lastLevel: 0, since: 0 },
  handle(e, capturedAt) {
    if (!this.on) return;
    if (e.type === "level") { this.level(e.r, e.floor); return; }
    if (e.type === "chord" || e.type === "on") { this.stats.onsets++; this.heard(e.type === "chord" ? e.midis : [e.midi]); }
    if (e.type === "chord") {
      const fresh = e.midis.filter((m) => { const r = Sound.recent.get(m); return !(r && performance.now() - r < 250); });
      if (!fresh.length) return;
      // 화음 안에 지금 칠 음이 하나라도 있으면, 나머지 낯선 음은 배음 오인일 수 있어 틀린 음으로 세지 않는다(진행도 하지 않음)
      const st = settings.mode === "wait" && E.playing ? nextWaitStep() : null;
      const req = st ? new Set(requiredOf(st).map((n) => n.midi)) : null;
      const anyReq = !!req && fresh.some((m) => req.has(m));
      if (this.cur != null && !fresh.includes(this.cur)) { Input.off(this.cur); this.cur = null; }
      for (const m of [...this.curSet]) if (!e.sounding.includes(m)) { Input.off(m); this.curSet.delete(m); }
      for (const m of fresh) { if (this.curSet.has(m)) Input.off(m); this.curSet.add(m); Input.on(m, 0.7, "mic", capturedAt, { noPenalty: anyReq && !req.has(m) }); }
      // 옥타브로 겹친 음(예: 도3+도4)은 소리로 구분이 어려워, 같은 이름 음이 새로 들렸으면 겹친 쪽도 친 것으로 본다
      if (req) for (const m of req) if (!fresh.includes(m) && !this.curSet.has(m) && fresh.some((f) => f !== m && Math.abs(f - m) % 12 === 0 && Math.abs(f - m) <= 24)) { this.curSet.add(m); Input.on(m, 0.7, "mic", capturedAt, { noPenalty: true }); }
      return;
    }
    if (e.type === "off") { if (this.curSet.has(e.midi)) { this.curSet.delete(e.midi); Input.off(e.midi); return; } if (this.cur === e.midi) { this.cur = null; Input.off(e.midi); } return; }
    // 앱이 방금(0.25초 안) 낸 같은 음은 무시 (스피커 → 마이크)
    const r = Sound.recent.get(e.midi); if (r && performance.now() - r < 250) return;
    if (this.cur != null) Input.off(this.cur);
    this.cur = e.midi; Input.on(e.midi, 0.7, "mic", capturedAt);
  },
  stop() {
    this.on = false;
    if (this.stream) this.stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    if (this.node) { try { this.node.disconnect(); } catch (e) {} this.node = null; }
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    clearInterval(this.timer); this.an = null;
    if (this.cur != null) Input.off(this.cur); this.cur = null; this.curSet.forEach((m) => Input.off(m)); this.curSet.clear();
    if (this.saved) { Object.entries(this.saved).forEach(([k, v]) => { settings[k] = v; const el = $("#" + k); if (el) el.checked = !!v; }); $("#metroBtn").setAttribute("aria-pressed", String(!!settings.metro)); saveSettings(); this.saved = null; }
    this.status("꺼져 있어요"); $("#micBtn").textContent = "켜기"; this.syncUi();
  },
  // 소리 크기 표시(바의 마이크 버튼 둘레)와 "소리가 작아요" 안내
  level(r, floor) {
    const st = this.stats; st.blocks++; st.lastLevel = r; st.maxLevel = Math.max(st.maxLevel * 0.995, r);
    const db = 20 * Math.log10(Math.max(r, 1e-6)); const lvl = Math.max(0, Math.min(1, (db + 60) / 45));
    const b = $("#micQuick"); if (b) b.style.setProperty("--lvl", lvl.toFixed(2));
    if (!st.warned && performance.now() - st.since > 8000 && st.onsets === 0 && st.maxLevel < 0.004) { st.warned = true; this.status("소리가 아주 작게 들려요. 기기를 피아노 가까이(악보대 위) 두고 조금 세게 쳐 보세요.", true); }
  },
  // 들린 음을 잠깐 보여 준다 (인식이 되는지 바로 알 수 있게)
  heard(midis) {
    const el = $("#heard"); if (!el) return;
    el.textContent = "들린 음 " + midis.map((m) => fullName(m)).join(" ");
    el.hidden = false; clearTimeout(this.heardT); this.heardT = setTimeout(() => { el.hidden = true; }, 1600);
  },
  syncUi() {
    const b = $("#micQuick"); if (!b) return;
    b.setAttribute("aria-pressed", String(this.on)); b.title = this.on ? "마이크로 듣는 중 (누르면 끄기)" : "마이크로 실제 피아노 소리 듣기";
    if (!this.on) b.style.setProperty("--lvl", "0");
    updateInputHint();
  },
  reset() { if (this.cur != null) Input.off(this.cur); this.cur = null; this.curSet.forEach((m) => Input.off(m)); this.curSet.clear(); },
};

/* ============================================================
   10) 악보 그리기 (OpenSheetMusicDisplay, 실패해도 앱은 동작)
   ============================================================ */
const OSMD_URL = "https://cdn.jsdelivr.net/npm/opensheetmusicdisplay@1.8.9/build/opensheetmusicdisplay.min.js";
const Score = {
  osmd: null, ready: false, steps: [], idx: -1, lib: null, libPromise: null, xml: null, token: 0, lastScroll: 0,
  loadLib() {
    if (this.libPromise) return this.libPromise;
    this.libPromise = new Promise((res) => {
      if (window.opensheetmusicdisplay) return res(window.opensheetmusicdisplay);
      const s = document.createElement("script"); s.src = OSMD_URL; s.async = true;
      s.onload = () => res(window.opensheetmusicdisplay || null); s.onerror = () => res(null);
      document.head.appendChild(s);
      setTimeout(() => res(window.opensheetmusicdisplay || null), 20000);
    });
    return this.libPromise;
  },
  note(msg) { const n = $("#scoreNote"); n.hidden = !msg; n.textContent = msg || ""; },
  async show(xml) {
    const token = ++this.token; this.ready = false; this.steps = []; this.idx = -1; this.xml = xml;
    $("#osmd").innerHTML = ""; this.clearShades();
    if (!xml) { this.note("MIDI 파일은 악보 그림 없이 떨어지는 음표와 건반으로 보여 드려요."); return; }
    this.note("악보를 그리는 중…");
    const lib = await this.loadLib();
    if (token !== this.token) return;
    if (!lib) { this.note("악보 그림 도구를 불러오지 못했어요. 인터넷 연결을 확인해 주세요. 떨어지는 음표와 건반은 그대로 쓸 수 있어요."); return; }
    // 악보 인식 결과에는 그림 도구가 못 그리는 표시(짝 없는 8va 등)가 섞일 수 있다 → 그리기용으로만 단계적으로 덜어 내고 다시 시도
    const variants = [xml, xml.replace(/<direction\b[^>]*>(?:(?!<\/direction>)[\s\S])*?<octave-shift\b[\s\S]*?<\/direction>/g, ""),
      xml.replace(/<direction\b[\s\S]*?<\/direction>/g, "").replace(/<(slur|tied|tuplet|wedge|ornaments|arpeggiate)\b[^>]*\/>/g, "")];
    for (let vi = 0; vi < variants.length; vi++) {
      if (vi > 0 && variants[vi] === variants[vi - 1]) continue;
      try {
        $("#osmd").innerHTML = "";
        const osmd = new lib.OpenSheetMusicDisplay($("#osmd"), {
          autoResize: true, backend: "svg", drawTitle: settings.scoreLayout === "page", drawSubtitle: false, drawComposer: settings.scoreLayout === "page", drawCredits: false,
          drawPartNames: false, drawFingerings: true, followCursor: false,
          renderSingleHorizontalStaffline: settings.scoreLayout !== "page", // 한 줄로 흐르는 악보 (악보대에 올린 태블릿에서 보기 좋게) autoBeam: current && (current.kind === "ai" || current.kind === "demo"),
          cursorsOptions: [{ type: 0, color: "#17766b", alpha: 0.35, follow: false }]
        });
        this.osmd = osmd;
        await osmd.load(variants[vi]);
        if (token !== this.token) return;
        osmd.zoom = settings.scoreZoom;
        osmd.render(); this.fitHeight();
        this.note(vi ? "악보 그림에서 일부 표시(8va 등)를 빼고 그렸어요. 소리와 건반 안내는 원래대로예요." : "");
        this.buildSteps();
        osmd.cursor.show();
        this.ready = true; this.idx = -1;
        this.sync(true); this.drawShades();
        return;
      } catch (e) {
        console.warn("OSMD", vi, e);
        if (this.osmd && this.osmd.setOptions) try { this.osmd.setOptions({ autoResize: false }); } catch (e2) {}
        if (token !== this.token) return;
      }
    }
    $("#osmd").innerHTML = "";
    this.note("이 악보는 그림으로 그리지 못했어요. 떨어지는 음표와 건반으로 연습할 수 있어요.");
  },
  buildSteps() {
    // 악보 커서가 갈 수 있는 위치 목록. k = 처음부터 moveToNext()를 몇 번 해야 그 위치인지.
    // (예전에는 목록 순번을 k로 썼는데, 건너뛴 위치가 있으면 커서가 엉뚱한 곳에 섰다. 시간이 거꾸로 가는 위치(도돌이표 두 번째 바퀴 등)를 만나면 목록을 끝내 버려 뒤쪽 커서가 멈췄다.)
    const c = this.osmd.cursor; c.reset(); const it = c.Iterator || c.iterator; const steps = []; let guard = 0, k = 0;
    while (it && !it.EndReached && guard++ < 20000) {
      const mi = it.CurrentMeasureIndex;
      const meas = it.CurrentMeasure;
      const ts = (it.CurrentSourceTimestamp || it.currentTimeStamp).RealValue;
      const ms = meas && meas.AbsoluteTimestamp ? meas.AbsoluteTimestamp.RealValue : ts;
      const sm = song && (song.srcMeasures || song.measures);
      if (sm && sm[mi]) {
        const qq = sm[mi].startQ + (ts - ms) * 4; // 원본 악보 시간
        if (!steps.length || qq > steps[steps.length - 1].q + 1e-6) steps.push({ q: qq, mi, k });
      }
      it.moveToNext(); k++;
    }
    this.steps = steps; c.reset(); this.k = 0;
  },
  sync(force) {
    if (!this.ready || !song || !this.steps.length) return;
    const qNow = (song.toSrcQ ? song.toSrcQ(song.qAt(E.pos)) : song.qAt(E.pos)) + 1e-4; // 도돌이표로 펼친 연주 위치 → 원본 악보 위치
    let lo = 0, hi = this.steps.length - 1;
    if (this.steps[0].q > qNow) hi = 0;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.steps[m].q <= qNow) lo = m; else hi = m - 1; }
    const target = lo;
    if (target === this.idx && !force) return;
    try {
      const c = this.osmd.cursor;
      if (target < this.idx && this.idx >= 0) {
        // 도돌이표로 원본 앞부분을 다시 연주하는 건 정상 (연주 마디의 회차가 바뀜)
        const pm = song.measures[measureAt(E.pos)];
        if (pm && pm.pass > 1 && this.lastPass !== pm.pass) PosLog.add("repeat", song.secAt(this.steps[this.idx].q), song.secAt(this.steps[target].q));
        else PosLog.cursorBack(this.steps[this.idx], this.steps[target]);
      }
      { const pm = song.measures[measureAt(E.pos)]; this.lastPass = pm ? pm.pass : 1; }
      const goal = this.steps[target].k;
      if (goal < this.k || this.idx < 0) { c.reset(); this.k = 0; }
      const it = c.Iterator || c.iterator; // reset()은 iterator를 새로 만들므로 reset 뒤에 가져온다
      while (this.k < goal && !it.EndReached) { it.moveToNext(); this.k++; }
      this.idx = target;
      c.update();
      this.scrollToCursor(force);
    } catch (e) { console.warn(e); }
  },
  scrollToCursor(force) {
    const el = this.osmd && this.osmd.cursor && this.osmd.cursor.cursorElement; if (!el) return;
    const sc = $("#scoreScroll");
    if (settings.scoreLayout !== "page") {
      // 한 줄 악보: 커서가 왼쪽에서 3분의 1쯤에 오도록 옆으로 흐르게
      const left = el.offsetLeft, target = Math.max(0, left - sc.clientWidth * 0.32);
      if (force || left < sc.scrollLeft + sc.clientWidth * 0.15 || left > sc.scrollLeft + sc.clientWidth * 0.62) sc.scrollTo({ left: target, behavior: force ? "auto" : "smooth" });
      return;
    }
    const top = el.offsetTop, h = el.offsetHeight || 80;
    if (force || top < sc.scrollTop + 10 || top + h > sc.scrollTop + sc.clientHeight - 10) {
      sc.scrollTo({ top: Math.max(0, top - 16), behavior: force ? "auto" : "smooth" });
    }
  },
  measureBox(mi) {
    try {
      const gs = this.osmd.GraphicSheet; const row = gs.MeasureList[mi]; if (!row) return null;
      const list = row.filter(Boolean); if (!list.length) return null;
      const u = 10 * this.osmd.zoom;
      const a = list[0].PositionAndShape, z = list[list.length - 1].PositionAndShape;
      const svg = $("#osmd svg"); const off = svg ? svg.offsetTop : 0; const offL = svg ? svg.offsetLeft : 0;
      return { x: offL + a.AbsolutePosition.x * u, y: off + (a.AbsolutePosition.y + a.BorderTop) * u, w: a.Size.width * u, h: (z.AbsolutePosition.y + z.BorderBottom - a.AbsolutePosition.y - a.BorderTop) * u };
    } catch (e) { return null; }
  },
  clearShades() { $$(".loop-shade,.flag-shade").forEach((n) => n.remove()); },
  drawShades() {
    this.clearShades(); if (!this.ready) return;
    if (song && song.flagged) song.flagged.forEach((iss, i) => { const b = this.measureBox(i); if (!b) return; const d = document.createElement("div"); d.className = "flag-shade"; d.title = iss.join(" · "); Object.assign(d.style, { left: b.x - 2 + "px", top: b.y - 6 + "px", width: b.w + 4 + "px", height: b.h + 12 + "px" }); $("#osmd").appendChild(d); });
    const lr = loopRange(); if (!lr) return;
    for (const si of new Set(song.measures.slice(lr.a, lr.b + 1).map((m) => m.src))) { const b = this.measureBox(si); if (!b) continue; const d = document.createElement("div"); d.className = "loop-shade"; Object.assign(d.style, { left: b.x - 2 + "px", top: b.y - 6 + "px", width: b.w + 4 + "px", height: b.h + 12 + "px" }); $("#osmd").appendChild(d); }
  },
  measureFromPoint(x, y) {
    if (!this.ready || !song) return -1;
    for (let i = 0; i < song.measures.length; i++) { const b = this.measureBox(i); if (b && x >= b.x && x <= b.x + b.w && y >= b.y - 20 && y <= b.y + b.h + 20) return i; }
    return -1;
  },
  // 한 줄 악보는 악보 높이만큼만 자리를 차지하게 (남는 자리는 피아노에)
  fitHeight() {
    const app = $("#app"), host = $("#osmd"); if (settings.scoreLayout === "page") { app.style.removeProperty("--score-line-h"); host.style.marginTop = ""; return; }
    const svg = $("#osmd svg"); if (!svg) return;
    try {
      // 악보 그림 위아래 빈 여백을 빼고, 실제 오선·음표가 있는 높이만큼만
      const vb = svg.viewBox && svg.viewBox.baseVal, rh = svg.getBoundingClientRect().height, sc = vb && vb.height ? rh / vb.height : 1, bb = svg.getBBox();
      const top = Math.max(0, bb.y * sc - 6), bottom = (bb.y + bb.height) * sc + 6;
      host.style.marginTop = -top + "px";
      if (bottom - top > 40) { app.style.setProperty("--score-line-h", Math.ceil(bottom - top + 4) + "px"); setTimeout(() => window.dispatchEvent(new Event("resize")), 30); }
    } catch (e) {}
  },
  setZoom(z) { if (!this.ready) return; try { this.osmd.zoom = z; this.osmd.render(); this.fitHeight(); this.idx = -1; this.sync(true); this.drawShades(); } catch (e) {} }
};
$("#osmd").addEventListener("click", (e) => {
  const host = $("#osmd").getBoundingClientRect();
  const mi = Score.measureFromPoint(e.clientX - host.left, e.clientY - host.top);
  if (mi >= 0) { seek(song.measures[nearestPerfOfSrc(mi)].start); toast(`${mi + 1}마디로 이동했어요`); }
});
let resizeT = 0;
new ResizeObserver(() => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (Score.ready) { Score.idx = -1; Score.sync(true); Score.drawShades(); } }, 400); }).observe($("#scoreScroll"));

/* ============================================================
   11) 낙하 노트 + 건반 렌더러 (캔버스)
   ============================================================ */
const fall = $("#fall"), keysC = $("#keys");
const fctx = fall.getContext("2d"), kctx = keysC.getContext("2d");
let colors = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  ["--stage", "--stage-2", "--stage-line", "--stage-text", "--rh", "--lh", "--ok", "--bad", "--accent", "--f-mono", "--f-body"].forEach((k) => colors[k] = cs.getPropertyValue(k).trim());
}
readColors();
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", readColors);
new MutationObserver(readColors).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
function sizeCanvas(c, ctx) { const r = c.getBoundingClientRect(); const dpr = Math.min(window.devicePixelRatio || 1, 2.5); const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr)); if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } ctx.setTransform(dpr, 0, 0, dpr, 0, 0); return { w: r.width, h: r.height }; }

let kb = { lo: 48, hi: 83, whites: [], keyW: 20 };
function computeRange() {
  let lo, hi;
  if (settings.range === "88") { lo = 21; hi = 108; }
  else if (settings.range === "61") { lo = 36; hi = 96; }
  else {
    lo = song ? song.lo : 60; hi = song ? song.hi : 72;
    lo -= ((lo % 12) + 12) % 12; hi += 11 - (((hi % 12) + 12) % 12);
    while (hi - lo < 23) { lo -= 12; if (hi - lo < 23) hi += 12; }
    lo = Math.max(21, lo); hi = Math.min(108, hi);
  }
  const whites = []; for (let m = lo; m <= hi; m++) if (!isBlack(m)) whites.push(m);
  kb = { lo, hi, whites };
}
function keyGeom(m, W) {
  const kw = W / kb.whites.length;
  if (!isBlack(m)) { const i = kb.whites.indexOf(m); return { x: i * kw, w: kw, black: false }; }
  const i = kb.whites.indexOf(m - 1); const bw = kw * 0.6; return { x: (i + 1) * kw - bw / 2, w: bw, black: true };
}
// 폭·높이가 0 이하(화면이 아주 좁거나 숨겨진 때)면 그리지 않는다 — 예전엔 반지름이 음수가 되어 오류가 나고 화면 갱신이 멈췄다
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); if (!(w > 0 && h > 0)) return; r = Math.max(0, Math.min(r, w / 2, h / 2)); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function handColor(h) { return h === "L" ? colors["--lh"] : colors["--rh"]; }

function upcomingStep() {
  if (!song) return null;
  if (settings.mode === "wait") return nextWaitStep();
  const i = lowerBound(song.steps, E.pos + 0.001);
  return song.steps[i] || null;
}
function drawFall() {
  if (fall.offsetParent === null) return;
  const { w: W, h: H } = sizeCanvas(fall, fctx);
  fctx.fillStyle = colors["--stage"]; fctx.fillRect(0, 0, W, H);
  if (!song) return;
  const pps = settings.zoom * Math.max(90, H / 3.2);
  const hitY = H - 1;
  const top = E.pos + hitY / pps, bottom = E.pos - 0.2;
  const yOf = (sec) => hitY - (sec - E.pos) * pps;
  // 검은 건반 레인
  for (let m = kb.lo; m <= kb.hi; m++) if (isBlack(m)) { const g = keyGeom(m, W); fctx.fillStyle = colors["--stage-2"]; fctx.fillRect(g.x, 0, g.w, H); }
  // 구간 반복 영역
  const lr = loopRange();
  if (lr) { fctx.fillStyle = "rgba(79,209,191,0.07)"; const y1 = yOf(lr.end), y2 = yOf(lr.start); fctx.fillRect(0, Math.max(0, y1), W, Math.min(H, y2) - Math.max(0, y1)); fctx.fillStyle = "rgba(79,209,191,0.6)"; if (y1 > 0) fctx.fillRect(0, y1, W, 1.5); }
  // 마디선
  fctx.font = "500 11px " + colors["--f-mono"];
  song.beats.forEach((b) => { if (b.sec < bottom || b.sec > top) return; const y = yOf(b.sec); fctx.fillStyle = b.down ? colors["--stage-line"] : "rgba(255,255,255,0.035)"; fctx.fillRect(0, y, W, b.down ? 1.5 : 1); });
  song.measures.forEach((m) => {
    if (m.end < bottom || m.start > top) return;
    if (song.flagged && song.flagged.has(m.src)) { const y1 = yOf(m.end), y2 = yOf(m.start); fctx.fillStyle = "rgba(240,170,40,0.10)"; fctx.fillRect(0, y1, W, y2 - y1); fctx.fillStyle = "rgba(240,170,40,0.9)"; fctx.fillRect(0, y1, 4, y2 - y1); }
    if (m.start < bottom) return;
    const y = yOf(m.start); fctx.fillStyle = song.flagged && song.flagged.has(m.src) ? "#f0aa28" : colors["--stage-text"]; fctx.fillText(measureLabel(m.idx) + (song.flagged && song.flagged.has(m.src) ? " ?" : ""), 8, y - 4);
  });
  // 노트
  const from = lowerBound(song.notes, E.pos - 0.25 - song.maxDur);
  const fsz = 11;
  for (let i = from; i < song.notes.length; i++) {
    const n = song.notes[i]; if (n.start > top) break; if (n.end < bottom) continue;
    if (n.midi < kb.lo || n.midi > kb.hi) continue;
    const g = keyGeom(n.midi, W); const mine = practiceHas(n.hand);
    const y1 = yOf(n.end), y2 = yOf(n.start); const h = Math.max(4, y2 - y1 - 1.5);
    const x = g.x + (g.black ? 0.5 : 2), w = g.w - (g.black ? 1 : 4);
    fctx.globalAlpha = mine ? 1 : 0.28;
    const active = n.start <= E.pos + 1e-4 && n.end > E.pos;
    fctx.fillStyle = handColor(n.hand);
    roundRect(fctx, x, y1, w, h, Math.min(6, w / 3)); fctx.fill();
    if (active) { fctx.strokeStyle = "rgba(255,255,255,0.85)"; fctx.lineWidth = 1.5; fctx.stroke(); }
    if (mine && settings.labels !== "off" && h > 15 && w > 12) {
      fctx.fillStyle = "rgba(8,12,20,0.82)"; fctx.textAlign = "center"; fctx.font = `600 ${fsz}px ${colors["--f-body"]}`;
      const label = noteName(n.midi, settings.labels);
      fctx.fillText(label, x + w / 2, y2 - 6);
      if (settings.fingers && n.finger && h > 30) { fctx.font = `500 ${fsz - 1}px ${colors["--f-body"]}`; fctx.fillText(String(n.finger), x + w / 2, y2 - 19); }
      fctx.textAlign = "left";
    }
    fctx.globalAlpha = 1;
  }
  // 판정선
  fctx.fillStyle = E.waiting ? colors["--accent"] : "rgba(255,255,255,0.25)";
  fctx.fillRect(0, hitY - (E.waiting ? 3 : 1), W, E.waiting ? 3 : 1);
}
function drawKeys() {
  const { w: W, h: H } = sizeCanvas(keysC, kctx);
  kctx.fillStyle = colors["--stage"]; kctx.fillRect(0, 0, W, H);
  const now = performance.now();
  const act = new Map();
  if (song) {
    const from = lowerBound(song.notes, E.pos - song.maxDur - 0.01);
    for (let i = from; i < song.notes.length; i++) { const n = song.notes[i]; if (n.start > E.pos + 1e-4) break; if (n.end > E.pos && n.start <= E.pos + 1e-4) { if (practiceHas(n.hand) || settings.accomp) act.set(n.midi, n); } }
  }
  const up = upcomingStep(); const upMap = new Map();
  if (up && (settings.mode === "wait" || (up.start - E.pos) < 1.2)) up.notes.forEach((n) => { if (practiceHas(n.hand)) upMap.set(n.midi, n); });
  // 건반 바로 위 붉은 펠트 띠 (실제 피아노처럼), 그 아래 건반
  const F = 6; kctx.fillStyle = "#a1283b"; kctx.fillRect(0, 0, W, F); kctx.fillStyle = "rgba(0,0,0,.35)"; kctx.fillRect(0, F - 1, W, 1);
  kctx.save(); kctx.translate(0, F);
  const whiteH = H - 4 - F, blackH = whiteH * 0.62;
  const ivory = kctx.createLinearGradient(0, 0, 0, whiteH); ivory.addColorStop(0, "#efeadd"); ivory.addColorStop(0.08, "#f8f5ed"); ivory.addColorStop(0.92, "#f4f0e6"); ivory.addColorStop(1, "#ddd6c4");
  const ebony = kctx.createLinearGradient(0, 0, 0, blackH); ebony.addColorStop(0, "#0e0f12"); ebony.addColorStop(0.85, "#24262c"); ebony.addColorStop(1, "#3a3d45");
  const fam = colors["--f-body"];
  const pressColor = (m) => { const p = pressed.get(m); if (!p) return null; if (p.up && now - p.up > 160) { pressed.delete(m); return null; } return p.state === "ok" ? colors["--ok"] : p.state === "bad" ? colors["--bad"] : "#9fb0c8"; };
  // 흰건반
  kb.whites.forEach((m, i) => {
    const g = keyGeom(m, W);
    const pc = pressColor(m); const a = act.get(m); const u = upMap.get(m);
    kctx.fillStyle = pc || (a && (settings.mode !== "wait" || !practiceHas(a.hand)) ? handColor(a.hand) : ivory);
    keyShape(kctx, g.x + 1, 0, g.w - 2, whiteH, Math.min(6, g.w / 4)); kctx.fill();
    if (u && !pc) { kctx.strokeStyle = handColor(u.hand); kctx.lineWidth = 3; roundRect(kctx, g.x + 2.5, 1.5, g.w - 5, whiteH - 3, 5); kctx.stroke(); kctx.fillStyle = handColor(u.hand); kctx.globalAlpha = 0.22; roundRect(kctx, g.x + 2.5, 1.5, g.w - 5, whiteH - 3, 5); kctx.fill(); kctx.globalAlpha = 1; }
    if (m === 60) { kctx.fillStyle = "#c7cbd3"; kctx.beginPath(); kctx.arc(g.x + g.w / 2, whiteH - 34, 2.5, 0, 7); kctx.fill(); }
    if (settings.labels !== "off" && g.w > 13) {
      kctx.fillStyle = u ? "#111" : "#8a909b"; kctx.textAlign = "center"; kctx.font = `${u ? 600 : 500} ${Math.min(13, g.w * 0.42)}px ${fam}`;
      kctx.fillText(noteName(m, settings.labels), g.x + g.w / 2, whiteH - 10);
    }
    if (u && settings.fingers && u.finger) { badge(kctx, g.x + g.w / 2, whiteH - 52, String(u.finger), handColor(u.hand), fam); }
  });
  // 검은건반
  for (let m = kb.lo; m <= kb.hi; m++) {
    if (!isBlack(m)) continue; const g = keyGeom(m, W);
    const pc = pressColor(m); const a = act.get(m); const u = upMap.get(m);
    kctx.fillStyle = pc || (a && (settings.mode !== "wait" || !practiceHas(a.hand)) ? handColor(a.hand) : ebony);
    keyShape(kctx, g.x, 0, g.w, blackH, Math.min(3, g.w / 4)); kctx.fill();
    if (!pc && !a) { kctx.fillStyle = "rgba(255,255,255,.13)"; kctx.fillRect(g.x + 2, blackH * 0.86, g.w - 4, Math.max(2, blackH * 0.06)); } // 검은건반 앞면 빛
    if (u && !pc) { kctx.strokeStyle = handColor(u.hand); kctx.lineWidth = 3; roundRect(kctx, g.x + 1.5, 1.5, g.w - 3, blackH - 3, 3); kctx.stroke(); }
    if (u && settings.labels !== "off" && g.w > 9) { kctx.fillStyle = "#fff"; kctx.textAlign = "center"; kctx.font = `600 ${Math.min(11, g.w * 0.5)}px ${fam}`; kctx.fillText(noteName(m, settings.labels), g.x + g.w / 2, blackH - 8); }
    if (u && settings.fingers && u.finger) badge(kctx, g.x + g.w / 2, blackH + 14, String(u.finger), handColor(u.hand), fam);
  }
  kctx.textAlign = "left"; kctx.restore();
}
// 건반 모양: 위는 펠트 밑으로 들어가 각지고, 아래만 둥글게
function keyShape(ctx, x, y, w, h, r) { ctx.beginPath(); if (!(w > 0 && h > 0)) return; r = Math.max(0, Math.min(r, w / 2, h / 2)); ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r); ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r); ctx.closePath(); }
function badge(ctx, x, y, t, col, fam) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.fill(); ctx.fillStyle = "#0b0f17"; ctx.textAlign = "center"; ctx.font = `700 11px ${fam}`; ctx.fillText(t, x, y + 4); }

// 건반 터치/클릭 입력
const ptrNotes = new Map();
function keyFromPoint(x, y) {
  const r = keysC.getBoundingClientRect(); const W = r.width, H = r.height; const lx = x - r.left, ly = y - r.top - 6; const blackH = (H - 10) * 0.62; // 6 = 펠트 띠
  if (ly < blackH) for (let m = kb.lo; m <= kb.hi; m++) { if (!isBlack(m)) continue; const g = keyGeom(m, W); if (lx >= g.x && lx <= g.x + g.w) return m; }
  const i = Math.floor(lx / (W / kb.whites.length)); return kb.whites[clamp(i, 0, kb.whites.length - 1)];
}
keysC.addEventListener("pointerdown", (e) => { e.preventDefault(); keysC.setPointerCapture(e.pointerId); const m = keyFromPoint(e.clientX, e.clientY); ptrNotes.set(e.pointerId, m); Input.on(m, 0.75, "screen"); });
keysC.addEventListener("pointermove", (e) => { if (!ptrNotes.has(e.pointerId)) return; const m = keyFromPoint(e.clientX, e.clientY); const old = ptrNotes.get(e.pointerId); if (m !== old) { Input.off(old); ptrNotes.set(e.pointerId, m); Input.on(m, 0.7, "screen"); } });
const ptrUp = (e) => { if (!ptrNotes.has(e.pointerId)) return; Input.off(ptrNotes.get(e.pointerId)); ptrNotes.delete(e.pointerId); };
keysC.addEventListener("pointerup", ptrUp); keysC.addEventListener("pointercancel", ptrUp);
// 낙하 영역 드래그로 위치 이동
let drag = null;
fall.addEventListener("pointerdown", (e) => { if (!song) return; fall.setPointerCapture(e.pointerId); drag = { y: e.clientY, pos: E.pos, was: E.playing }; if (E.playing) pause(); });
fall.addEventListener("pointermove", (e) => { if (!drag) return; const H = fall.getBoundingClientRect().height; const pps = settings.zoom * Math.max(90, H / 3.2); seek(drag.pos + (e.clientY - drag.y) / pps); });
const dragEnd = () => { drag = null; }; fall.addEventListener("pointerup", dragEnd); fall.addEventListener("pointercancel", dragEnd);
fall.addEventListener("wheel", (e) => { if (!song) return; e.preventDefault(); seek(E.pos - e.deltaY / 400); }, { passive: false });

/* ============================================================
   12) 메인 루프
   ============================================================ */
let lastTs = performance.now(), lastMeasure = -1;
let frameErrs = 0;
function frame(ts) {
  // 다음 프레임을 먼저 예약한다: 그리기 중 오류가 나도 재생·화면 갱신이 멈추지 않게
  requestAnimationFrame(frame);
  try { frameBody(ts); } catch (e) { if (frameErrs++ < 5) { console.warn("frame", e); PosLog.add("frame-error: " + String(e && e.message).slice(0, 60), E.pos, E.pos); } }
}
function frameBody(ts) {
  const dt = Math.min(0.1, (ts - lastTs) / 1000); lastTs = ts;
  if (song && E.playing) {
    if (E.countIn > 0) {
      E.countIn -= dt; const left = Math.ceil(E.countIn / E.countBeat);
      const cd = $("#countdown"); cd.hidden = E.countIn <= 0; cd.textContent = left > 0 ? String(E.countTotal - left + 1) : "";
    } else if (!E.waiting) advance(dt * settings.rate);
  }
  drawFall(); drawKeys();
  Score.sync(false);
  const mi = song ? measureAt(E.pos) : 0; if (mi !== lastMeasure) { lastMeasure = mi; updateReadouts(); }
  updatePrompt();
}

/* ============================================================
   13) UI 바인딩
   ============================================================ */
let toastT = 0;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2600); }
function setPlayIcon() { $("#playIcon").innerHTML = E.playing ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>'; $("#playBtn").setAttribute("aria-label", E.playing ? "일시정지" : "재생"); }
function updateReadouts() {
  if (!song) return; const mi = measureAt(E.pos);
  $("#measureReadout").innerHTML = `마디 <b>${measureLabel(mi)}</b> / ${srcCount()}`;
}
let lastPrompt = "";
function updatePrompt() {
  const el = $("#prompt");
  let html = "";
  if (song && settings.mode === "wait" && E.playing && E.waiting) {
    const st = nextWaitStep();
    if (st) {
      const req = requiredOf(st).filter((n) => !E.hits.has(n.midi));
      const R = req.filter((n) => n.hand === "R"), L = req.filter((n) => n.hand === "L");
      const fmt = (arr) => arr.map((n) => noteName(n.midi, settings.labels === "abc" ? "abc" : "sol") + (settings.fingers && n.finger ? ` ${n.finger}번` : "")).join(" · ");
      html = "이 건반을 눌러 주세요 — " + [R.length ? `<span class="r">오른손 ${fmt(R)}</span>` : "", L.length ? `<span class="l">왼손 ${fmt(L)}</span>` : ""].filter(Boolean).join("&nbsp;&nbsp;");
    }
  }
  if (html !== lastPrompt) { lastPrompt = html; el.innerHTML = html; el.hidden = !html; }
}
function updateStats() { $("#stAcc").textContent = accText(); $("#stMiss").textContent = E.mistakes; $("#stLoops").textContent = E.loops; }
function setRate(r) { settings.rate = clamp(r, 0.25, 1.5); $("#speed").value = Math.round(settings.rate * 100); const bpm = song ? Math.round(song.baseBpm * settings.rate) : ""; $("#speedReadout").innerHTML = `<b>${Math.round(settings.rate * 100)}%</b>${bpm ? " · ♩=" + bpm : ""}`; saveSettings(); }
// 따라치기인데 들을 수단(마이크·전자피아노)이 없으면 화면에 바로 켤 수 있는 안내를 띄운다
function updateInputHint() {
  const el = $("#inputHint"); if (!el) return;
  const midiOn = !!(midiAccess && [...midiAccess.inputs.values()].length);
  const show = settings.mode === "wait" && !Mic.on && !midiOn && !Input.hintDismissed && !!song;
  el.hidden = !show;
}
function setMode(m) {
  settings.mode = m; $$("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
  $("#modeHelp").textContent = m === "wait" ? "따라치기: 맞는 건반을 누를 때까지 음악이 기다려 줘요. 화면 건반, PC 키보드, 전자피아노로 칠 수 있어요." : "듣기: 곡을 들으며 어떤 건반을 누르는지 봐요.";
  E.waitIdx = lowerBound(song ? song.steps : [], E.pos); E.hits.clear(); E.waiting = false; saveSettings(); updateInputHint();
}
function setHands(h) { settings.hands = h; $$("[data-hands]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.hands === h))); if (song) { E.waitIdx = lowerBound(song.steps, E.pos); E.hits.clear(); E.waiting = false; } saveSettings(); }
function setLoop(on) {
  settings.loopOn = on; $("#loopOn").checked = on; $("#loopBtn").setAttribute("aria-pressed", String(on));
  if (song) { const n = srcCount(); settings.loopA = clamp(parseInt($("#loopA").value) || 1, 1, n); settings.loopB = clamp(Math.max(parseInt($("#loopB").value) || 1, settings.loopA), 1, n); $("#loopA").value = settings.loopA; $("#loopB").value = settings.loopB; }
  saveSettings(); Score.drawShades();
  const lr = loopRange(); if (lr && (E.pos < lr.start || E.pos >= lr.end)) seek(lr.start, false, "loop");
}
function setLoopRange(a, b) { $("#loopA").value = a; $("#loopB").value = b; setLoop(true); toast(a === b ? `${a}마디를 반복해요` : `${a}~${b}마디를 반복해요`); }
function stepMeasure(d) { if (!song) return; const mi = clamp(measureAt(E.pos) + d, 0, song.measures.length - 1); seek(song.measures[mi].start); }
function restart() { if (!song) return; const lr = loopRange(); seek(lr ? lr.start : 0, false, "restart"); E.mistakes = 0; E.correct = 0; E.loops = 0; E.passMistakes = 0; updateStats(); }
function applyView() { const app = $("#app"); app.classList.toggle("view-keys", settings.view === "keys"); app.classList.toggle("view-score", settings.view === "score"); setTimeout(() => { if (Score.ready) { Score.idx = -1; Score.sync(true); } }, 50); }

$("#playBtn").onclick = togglePlay;
$("#restartBtn").onclick = restart;
$("#prevBtn").onclick = () => stepMeasure(-1);
$("#nextBtn").onclick = () => stepMeasure(1);
$("#speed").oninput = (e) => setRate(parseInt(e.target.value) / 100);
$$("[data-mode]").forEach((b) => b.onclick = () => setMode(b.dataset.mode));
$$("[data-hands]").forEach((b) => b.onclick = () => setHands(b.dataset.hands));
$("#loopBtn").onclick = () => {
  if (!settings.loopOn && song) { const mi = srcMeasureAt(E.pos) + 1; if (mi < settings.loopA || mi > settings.loopB) { $("#loopA").value = mi; $("#loopB").value = Math.min(srcCount(), mi + 1); } }
  setLoop(!settings.loopOn);
  toast(settings.loopOn ? `${settings.loopA}~${settings.loopB}마디 반복 (설정에서 바꿀 수 있어요)` : "구간 반복을 껐어요");
};
$("#loopOn").onchange = (e) => setLoop(e.target.checked);
$("#loopA").onchange = () => setLoop(settings.loopOn);
$("#loopB").onchange = () => setLoop(settings.loopOn);
$("#loopHere").onclick = () => { if (!song) return; const mi = srcMeasureAt(E.pos) + 1; setLoopRange(mi, mi); };
$("#loopHere2").onclick = () => { if (!song) return; const mi = srcMeasureAt(E.pos) + 1; setLoopRange(mi, Math.min(srcCount(), mi + 1)); };
$("#loopAll").onclick = () => { if (!song) return; setLoopRange(1, srcCount()); };
$("#metroBtn").onclick = () => { settings.metro = !settings.metro; $("#metroBtn").setAttribute("aria-pressed", String(settings.metro)); saveSettings(); };
const bindSwitch = (id, key, after) => { const el = $("#" + id); el.checked = !!settings[key]; el.onchange = () => { settings[key] = el.checked; saveSettings(); after && after(); }; };
bindSwitch("autoSpeed", "autoSpeed"); bindSwitch("micChord", "micChord", () => { if (Mic.on) { Mic.stop(); Mic.start(); } }); bindSwitch("chordLoose", "chordLoose", () => { E.hits.clear(); toast(settings.chordLoose ? "화음을 한 음씩 쳐도 맞는 걸로 쳐요" : "화음은 함께(0.2초 안에) 쳐야 맞아요"); }); bindSwitch("steadyTempo", "steadyTempo", () => rebuildTiming()); bindSwitch("expandRepeats", "expandRepeats", () => { rebuildTiming(); renderFlags(); toast(settings.expandRepeats ? "도돌이표대로 반복해서 연주해요" : "도돌이표를 무시하고 처음부터 끝까지 한 번만 연주해요"); }); bindSwitch("accomp", "accomp"); bindSwitch("guide", "guide"); bindSwitch("countIn", "countIn"); bindSwitch("inputSound", "inputSound"); bindSwitch("fingers", "fingers");
$("#volume").value = Math.round(settings.volume * 100); $("#volume").oninput = (e) => { settings.volume = e.target.value / 100; Sound.setVolume(settings.volume); saveSettings(); };
function applyScoreLayout() { $("#app").classList.toggle("score-line", settings.scoreLayout !== "page"); }
applyScoreLayout();
$("#scoreLayoutSel").value = settings.scoreLayout === "page" ? "page" : "line";
$("#scoreLayoutSel").onchange = (e) => { settings.scoreLayout = e.target.value; saveSettings(); applyScoreLayout(); if (current && current.xml) Score.show(current.xml); };
// 전체 화면 (아이패드 사파리는 webkit 접두사)
const fsEl = document.documentElement;
const fsOn = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
function toggleFullscreen() {
  try {
    if (fsOn()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (fsEl.requestFullscreen || fsEl.webkitRequestFullscreen).call(fsEl);
  } catch (e) { toast("이 기기는 전체 화면을 지원하지 않아요. 사파리 공유 → 홈 화면에 추가로 앱처럼 쓸 수 있어요."); }
}
if (!(fsEl.requestFullscreen || fsEl.webkitRequestFullscreen)) $("#fsBtn").hidden = true;
$("#fsBtn").onclick = toggleFullscreen;
["fullscreenchange", "webkitfullscreenchange"].forEach((ev) => document.addEventListener(ev, () => { $("#fsBtn").setAttribute("aria-pressed", String(fsOn())); setTimeout(() => window.dispatchEvent(new Event("resize")), 60); }));
$("#viewSel").value = settings.view; $("#viewSel").onchange = (e) => { settings.view = e.target.value; applyView(); saveSettings(); };
$("#labelSel").value = settings.labels; $("#labelSel").onchange = (e) => { settings.labels = e.target.value; saveSettings(); };
$("#rangeSel").value = settings.range; $("#rangeSel").onchange = (e) => { settings.range = e.target.value; computeRange(); saveSettings(); };
$("#zoom").value = Math.round(settings.zoom * 100); $("#zoom").oninput = (e) => { settings.zoom = e.target.value / 100; saveSettings(); };
$("#scoreZoom").value = Math.round(settings.scoreZoom * 100); $("#scoreZoom").onchange = (e) => { settings.scoreZoom = e.target.value / 100; Score.setZoom(settings.scoreZoom); saveSettings(); };
$("#soundSel").value = settings.soundSet || "sal";
const soundSubText = { sal: "야마하 C5 그랜드 실제 녹음 (Salamander)", key: "건반 88개를 하나씩 따로 녹음한 소리" };
$("#soundSub").textContent = soundSubText[settings.soundSet || "sal"];
$("#soundSel").onchange = async (e) => { const v = e.target.value; $("#soundSub").textContent = "불러오는 중…"; await Sound.setSet(v); $("#soundSub").textContent = soundSubText[v]; Sound.ensure(); Sound.note(60, 0.6, 0.6); Sound.note(64, 0.5, 0.6); Sound.note(67, 0.5, 0.6); };
$("#midiBtn").onclick = connectMIDI;
$("#micBtn").onclick = () => Mic.on ? Mic.stop() : Mic.start();
$("#micQuick").onclick = () => Mic.on ? Mic.stop() : Mic.start();
$("#hintMic").onclick = () => Mic.start();
$("#hintClose").onclick = () => { Input.hintDismissed = true; updateInputHint(); };
// 넓은 화면에서 오른쪽 연습 설정을 접고 펴기 (건반·악보에 집중). 상태는 기억한다.
function setSideCollapsed(c, quiet) {
  settings.sideCollapsed = !!c; saveSettings();
  $("#app").classList.toggle("side-collapsed", settings.sideCollapsed);
  const b = $("#sideToggle"); b.setAttribute("aria-expanded", String(!settings.sideCollapsed));
  $("#sideToggleText").textContent = settings.sideCollapsed ? "설정 펼치기" : "설정 접기";
  $("#sideToggleArrow").setAttribute("d", settings.sideCollapsed ? "M12 10l-2 2 2 2" : "M10 10l2 2-2 2");
  // 넓어진 화면에 맞춰 건반·낙하 노트·악보를 다시 그린다
  setTimeout(() => window.dispatchEvent(new Event("resize")), 30);
  if (!quiet) toast(settings.sideCollapsed ? "연습 설정을 접었어요. 위의 '설정 펼치기'나 \\ 키로 다시 열 수 있어요" : "연습 설정을 펼쳤어요");
}
$("#sideToggle").onclick = () => setSideCollapsed(!settings.sideCollapsed);
setSideCollapsed(settings.sideCollapsed, true);
$("#panelBtn").onclick = () => $("#side").classList.add("open");
$("#closePanel").onclick = () => $("#side").classList.remove("open");
$("#demoBtn").onclick = () => loadDemo();
$("#openBtn").onclick = () => $("#fileInput").click();
$("#fileInput").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) openFile(f); };
$("#origBtn").onclick = () => { const v = $("#origView"); v.hidden = !v.hidden; $("#origBtn").textContent = v.hidden ? "원본 보기" : "악보로 돌아가기"; };
// 드래그 앤 드롭
let dragDepth = 0;
window.addEventListener("dragenter", (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { dragDepth++; $("#drop").hidden = false; e.preventDefault(); } });
window.addEventListener("dragover", (e) => { e.preventDefault(); });
window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("#drop").hidden = true; });
window.addEventListener("drop", (e) => { e.preventDefault(); dragDepth = 0; $("#drop").hidden = true; const f = e.dataTransfer.files[0]; if (f) openFile(f); });

/* ============================================================
   14) 곡 불러오기
   ============================================================ */
let current = { xml: null, kind: "", origImages: [] };
function renderFlags() {
  const box = $("#flagList"); box.innerHTML = "";
  const rep = current && current.report, fixed = (current && current.fixed) || [];
  const hasFlags = song && song.flagged && song.flagged.size;
  if (!rep && !hasFlags && !fixed.length) { box.hidden = true; return; }
  box.hidden = false;
  if (rep && rep.verified && rep.total) {
    const pct = Math.round(rep.match / rep.total * 100);
    const line = document.createElement("div"); line.className = "verify-line";
    line.innerHTML = `<b>원본 대조 결과</b> ${rep.total}마디 중 처음 읽은 그대로 일치 <b>${rep.match}</b>마디(${pct}%) · 대조하며 고친 마디 <b>${rep.fixed}</b> · 아직 다를 수 있는 마디 <b>${song.flagged ? song.flagged.size : 0}</b>`;
    box.appendChild(line);
  }
  const chips = (label, list, cls, onclick) => {
    if (!list.length) return;
    const wrap = document.createElement("div"); wrap.className = "flag-list";
    const lab = document.createElement("span"); lab.textContent = label; wrap.appendChild(lab);
    list.forEach(([mi, tip]) => { const b = document.createElement("button"); b.type = "button"; b.className = "flag-chip " + cls; b.textContent = String(mi + 1); b.title = tip; b.onclick = () => onclick(mi, tip); wrap.appendChild(b); });
    box.appendChild(wrap);
  };
  const go = (mi, tip) => { setLoopRange(mi + 1, mi + 1); seek(song.measures[perfOfSrc(mi)].start); toast(`${mi + 1}마디: ${tip}`); };
  if (hasFlags) chips("확인이 필요한 마디:", [...song.flagged.keys()].sort((a, b) => a - b).map((mi) => [mi, song.flagged.get(mi).join(" · ")]), "", go);
  if (fixed.length) chips("대조하며 고친 마디:", fixed.filter((f) => song && f.m < song.measures.length).map((f) => [f.m, f.note]), "fixed", go);
}
function setSong(raw, meta) {
  pause(); Mic.reset();
  const prevCloudId = current && current.cloudId;
  if (meta.persist !== false && settings.loopOn && !meta.keepLoop) { settings.loopOn = false; $("#loopOn").checked = false; $("#loopBtn").setAttribute("aria-pressed", "false"); saveSettings(); }
  song = buildSong(raw, {});
  current = { xml: meta.xml || null, kind: meta.kind, origImages: meta.origImages || [], name: meta.name || "", flags: meta.flags || [], report: meta.report || null, fixed: meta.fixed || [], raw, meta, ai: meta.ai || null, cloudId: meta.cloudId || (meta.sameSong ? prevCloudId : null) || null };
  song.flagged = new Map(); current.flags.forEach((f) => { if (f.m < srcCount()) song.flagged.set(f.m, (song.flagged.get(f.m) || []).concat(f.issues)); });
  renderFlags(); renderTempos();
  if (song.jumps) setTimeout(() => toast("이 악보에는 D.C.·D.S.·Coda 같은 이동 표시가 있어요. 아직 그 이동은 하지 않고 순서대로 연주해요."), 1200);
  $("#songTitle").textContent = song.title || meta.name || "제목 없는 악보";
  const kindBadge = { musicxml: "MusicXML", midi: "MIDI", demo: "예제 곡", ai: "AI 초안", omr: "자동 변환" }[meta.kind] || meta.kind;
  $("#songMeta").innerHTML = `<span class="badge${meta.kind === "ai" ? " ai" : ""}">${kindBadge}</span>${song.composer ? `<span>${esc(song.composer)}</span>` : ""}<span>${song.measures.length}마디 · ♩=${Math.round(song.baseBpm)}</span><span>오른손 ${song.notes.filter((n) => n.hand === "R").length} · 왼손 ${song.notes.filter((n) => n.hand === "L").length}음</span>`;
  $("#aiBanner").hidden = meta.kind !== "ai";
  $("#origBtn").hidden = !(meta.origImages && meta.origImages.length);
  $("#recheckBtn").hidden = !(meta.ai && meta.ai.json);
  const ov = $("#origView"); ov.hidden = true; ov.innerHTML = ""; $("#origBtn").textContent = "원본 보기";
  current.origImages.forEach((u) => { const im = document.createElement("img"); im.src = u; im.alt = "원본 악보"; ov.appendChild(im); });
  $("#saveXmlBtn").hidden = !current.xml;
  const n = srcCount(); $("#loopA").max = n; $("#loopB").max = n;
  if (settings.loopA > n) settings.loopA = 1; if (settings.loopB > n) settings.loopB = Math.min(n, 4);
  $("#loopA").value = settings.loopA; $("#loopB").value = settings.loopB;
  E.mistakes = 0; E.correct = 0; E.loops = 0; E.passMistakes = 0; updateStats();
  computeRange(); setRate(settings.rate);
  seek(loopRange() ? loopRange().start : 0, false, "song");
  Score.show(current.xml);
  try { if (meta.persist !== false) localStorage.setItem(STORE_KEY + ":last", JSON.stringify({ kind: meta.kind, name: meta.name || "", xml: current.xml, midiB64: meta.midiB64 || null, flags: current.flags, omrNotes: meta.omrNotes || null, report: current.report, fixed: current.fixed, ai: current.ai ? { json: current.ai.json, ranges: current.ai.ranges } : null, cloudId: current.cloudId })); } catch (e) {}
  if (meta.persist !== false && meta.kind !== "demo" && !meta.fromLibrary) Library.autoSave(meta.file || null, !!meta.sameSong);
  if ($("#libModal") && !$("#libModal").hidden) renderLibrary();
}
// 빠르기 표: 악보의 메트로놈 표시를 보여 주고 고칠 수 있게 한다
function renderTempos() {
  const box = $("#tempoList"); if (!box || !song) return; box.innerHTML = "";
  if (!current.raw.tempos || !current.raw.tempos.length) current.raw.tempos = [{ q: 0, bpm: song.baseBpm }];
  const list = current.raw.tempos.slice().sort((a, b) => a.q - b.q);
  list.forEach((t) => {
    const sm = song.srcMeasures; let mi = 0; while (mi + 1 < sm.length && sm[mi + 1].startQ <= t.q + 1e-6) mi++; // 빠르기표는 원본 악보 위치
    const row = document.createElement("div"); row.className = "row";
    const lab = document.createElement("button"); lab.type = "button"; lab.className = "btn small"; lab.textContent = `${mi + 1}마디`; lab.title = "이 마디로 이동"; lab.onclick = () => seek(song.measures[perfOfSrc(mi)].start);
    const inp = document.createElement("input"); inp.type = "number"; inp.className = "num"; inp.min = 20; inp.max = 300; inp.value = Math.round(t.bpm); inp.setAttribute("aria-label", `${mi + 1}마디 빠르기`);
    inp.onchange = () => { const v = clamp(parseFloat(inp.value) || t.bpm, 20, 300); t.bpm = v; inp.value = Math.round(v); rebuildTiming(); toast(`${mi + 1}마디부터 ♩=${Math.round(v)}`); };
    const w = document.createElement("span"); w.append("♩ = ", inp); row.append(lab, w); box.appendChild(row);
  });
}
function rebuildTiming() {
  if (!song || !current.raw) return;
  const pi = measureAt(E.pos), si = srcOf(pi), pass = song.measures[pi] ? song.measures[pi].pass : 1; const flagged = song.flagged; const wasPlaying = E.playing; pause();
  song = buildSong(current.raw, {}); song.flagged = flagged;
  let ni = perfOfSrc(si); for (let i = ni; i < song.measures.length; i++) if (song.measures[i].src === si && song.measures[i].pass === pass) { ni = i; break; }
  setRate(settings.rate); seek(song.measures[ni] ? song.measures[ni].start : 0, false, "song"); Score.idx = -1; Score.sync(true); Score.drawShades();
  try { const last = JSON.parse(localStorage.getItem(STORE_KEY + ":last") || "null"); if (last) { last.tempos = current.raw.tempos; localStorage.setItem(STORE_KEY + ":last", JSON.stringify(last)); } } catch (e) {}
  Library.autoSave(null, true);
  if (wasPlaying) play();
}
function loadDemo() { const xml = jsonToMusicXML(ODE); setSong(parseMusicXML(xml), { kind: "demo", xml, name: "환희의 송가" }); }
function b64(buf) { let s = ""; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s) { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; }
async function openFile(file) {
  const name = file.name || "악보"; const ext = (name.split(".").pop() || "").toLowerCase();
  try {
    if (ext === "mid" || ext === "midi" || file.type === "audio/midi") {
      const buf = await file.arrayBuffer(); const raw = parseMIDI(buf); raw.title = name.replace(/\.[^.]+$/, "");
      setSong(raw, { kind: "midi", name, midiB64: b64(buf) }); toast("MIDI를 불러왔어요"); return;
    }
    if (ext === "mxl") { const xml = await mxlToXml(await file.arrayBuffer()); setSong(parseMusicXML(xml), { kind: "musicxml", xml, name }); toast("악보를 불러왔어요"); return; }
    if (ext === "musicxml" || ext === "xml" || file.type.includes("xml")) { const xml = await file.text(); setSong(parseMusicXML(xml), { kind: "musicxml", xml, name }); toast("악보를 불러왔어요"); return; }
    if (ext === "pdf" || file.type === "application/pdf" || file.type.startsWith("image/") || /^(png|jpe?g|webp|gif|bmp|heic)$/.test(ext)) { const noAI = !window.GUNBAN_AI_ADAPTER && !(window.claude && window.claude.use); if (noAI && omrServer()) serverConvert(file); else if (noAI && Library.available) autoConvert(file); else openAIDialog(file); return; }
    // 확장자를 모르면 내용으로 판별
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (head[0] === 0x4d && head[1] === 0x54) { const buf = await file.arrayBuffer(); setSong(parseMIDI(buf), { kind: "midi", name }); return; }
    if (head[0] === 0x50 && head[1] === 0x4b) { const xml = await mxlToXml(await file.arrayBuffer()); setSong(parseMusicXML(xml), { kind: "musicxml", xml, name }); return; }
    const xml = await file.text(); setSong(parseMusicXML(xml), { kind: "musicxml", xml, name });
  } catch (e) { console.error(e); toast(e.message || "파일을 열지 못했어요."); }
}
$("#saveXmlBtn").onclick = async () => {
  if (!current.xml) return;
  const fname = (song && song.title ? song.title : "악보").replace(/[\\/:*?"<>|]/g, "_") + ".musicxml";
  const dl = window.claude ? await window.claude.use("downloads").catch(() => null) : null;
  if (dl) { try { await dl.save({ filename: fname, data: current.xml }); } catch (e) { if (e && e.code !== "cancelled") toast("저장하지 못했어요."); } return; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([current.xml], { type: "application/xml" })); a.download = fname; document.body.appendChild(a); a.click(); a.remove();
};

/* ============================================================
   14-2) 계정(구글 로그인) + 내 악보함 + 연습 기록 — Firebase
   - FIREBASE_CONFIG 가 비어 있으면 이 기능은 숨겨진다.
   - Firebase 웹 설정값은 비밀번호가 아니다(공개돼도 됨). 데이터 보호는 firestore.rules 가 맡는다.
   - 저장 위치: users/{uid}/songs/{songId} (+ chunks/, sessions/)
   ============================================================ */
const FIREBASE_CONFIG = { apiKey: "AIzaSyCjxx7m4hoOWm2fkIeb-biPsNbzL_PkUCU", authDomain: "rmtlove777.firebaseapp.com", projectId: "rmtlove777", appId: "1:636976181085:web:d5c54d87decdda3a6902b4" };
const FIREBASE_VERSION = "10.12.2";
// 악보 변환 서버(Audiveris, Hugging Face Space). 비어 있으면 예전 방식(대기열 + GitHub Actions)을 쓴다. docs/OMR_SERVER.md
const OMR_SERVER_URL = "";
// 무료 즉시 시작 중계기(Cloudflare Worker): 올리자마자 GitHub 변환을 바로 실행시킨다. 비어 있으면 5분 예약 실행을 기다림. docs/OMR_FAST.md
const OMR_KICK_URL = "https://gunban-kick.znznzn4105.workers.dev/";
const omrKick = () => (window.GUNBAN_OMR_KICK || OMR_KICK_URL || "");
const omrServer = () => (window.GUNBAN_OMR_SERVER || OMR_SERVER_URL || "").replace(/\/+$/, "");
const CLOUD_CHUNK = 300000; // 문서 하나 1MB 제한 → 큰 글자 데이터는 30만 자씩 나눠 저장
async function firebaseBackend(cfg) {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;
  const [fa, au, fs] = await Promise.all([import(base + "firebase-app.js"), import(base + "firebase-auth.js"), import(base + "firebase-firestore.js")]);
  const app = fa.initializeApp(cfg); const auth = au.getAuth(app); const db = fs.getFirestore(app);
  try { await au.getRedirectResult(auth); } catch (e) {}
  return {
    onAuth: (cb) => au.onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid, name: u.displayName || "", email: u.email || "", photo: u.photoURL || "", anon: !!u.isAnonymous } : null)),
    // 로그인 없이 바로 쓰기: 이 브라우저 전용 임시 계정
    signInAnon: () => au.signInAnonymously(auth),
    async signIn() {
      const p = new au.GoogleAuthProvider(); p.setCustomParameters({ prompt: "select_account" }); // 매번 계정 고르기 창
      const cur = auth.currentUser;
      try {
        // 임시 계정으로 쓰던 기록은 구글 계정에 그대로 이어 붙인다
        if (cur && cur.isAnonymous) { try { await au.linkWithPopup(cur, p); await cur.reload(); return; } catch (e) { if (!(e && (e.code === "auth/credential-already-in-use" || e.code === "auth/email-already-in-use"))) throw e; } }
        await au.signInWithPopup(auth, p);
      } catch (e) { if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) await au.signInWithRedirect(auth, p); else throw e; }
    },
    signOut: () => au.signOut(auth),
    set: (path, obj, merge) => fs.setDoc(fs.doc(db, path), obj, { merge: !!merge }),
    async get(path) { const s = await fs.getDoc(fs.doc(db, path)); return s.exists() ? s.data() : null; },
    async list(col, opt = {}) {
      const parts = []; if (opt.orderBy) parts.push(fs.orderBy(opt.orderBy, opt.dir || "desc")); if (opt.limit) parts.push(fs.limit(opt.limit));
      const ref = fs.collection(db, col); const snap = await fs.getDocs(parts.length ? fs.query(ref, ...parts) : ref);
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    del: (path) => fs.deleteDoc(fs.doc(db, path)),
    newId: (col) => fs.doc(fs.collection(db, col)).id,
  };
}
const Library = {
  be: null, user: null, available: false, saveT: 0,
  async init() {
    try {
      if (window.GUNBAN_CLOUD_BACKEND) this.be = window.GUNBAN_CLOUD_BACKEND; // 테스트·다른 백엔드용
      else if (FIREBASE_CONFIG.apiKey && !window.claude && /^https?:$/.test(location.protocol)) this.be = await firebaseBackend(FIREBASE_CONFIG);
    } catch (e) { console.warn("cloud", e); this.be = null; }
    this.available = !!this.be;
    $("#accountBox").hidden = !this.available;
    // Claude 안의 앱은 외부 접속이 막혀 로그인할 수 없으므로, 웹 버전으로 가는 링크를 보여 준다
    $("#webLink").hidden = this.available || !FIREBASE_CONFIG.apiKey || !window.claude;
    if (!this.available) return;
    this.be.onAuth((u) => { const first = !this.user && u; this.user = u; renderAccount(); if (first) Convert.resume(); });
  },
  // 로그인하지 않았으면 이 브라우저 전용 임시 계정을 자동으로 만든다 (Firebase 익명 로그인)
  async ensureUser() {
    if (this.user) return this.user;
    if (!this.be.signInAnon) throw new Error("로그인이 필요해요");
    await this.be.signInAnon();
    for (let i = 0; i < 50 && !this.user; i++) await new Promise((r) => setTimeout(r, 100));
    if (!this.user) throw new Error("임시 계정을 만들지 못했어요");
    return this.user;
  },
  root() { return `users/${this.user.uid}`; },
  songPath(id) { return `${this.root()}/songs/${id}`; },
  async putBig(sp, field, str, oldN) {
    const n = str ? Math.ceil(str.length / CLOUD_CHUNK) : 0;
    for (let i = 0; i < n; i++) await this.be.set(`${sp}/chunks/${field}_${i}`, { field, i, data: str.slice(i * CLOUD_CHUNK, (i + 1) * CLOUD_CHUNK) });
    for (let i = n; i < (oldN || 0); i++) await this.be.del(`${sp}/chunks/${field}_${i}`).catch(() => {});
    return n;
  },
  async getBig(sp, field, n) {
    if (!n) return null;
    const parts = await Promise.all(Array.from({ length: n }, (_, i) => this.be.get(`${sp}/chunks/${field}_${i}`)));
    return parts.map((p) => (p ? p.data : "")).join("");
  },
  // 지금 곡을 보관함에 저장(새로 만들거나 덮어쓰기). file 이 있으면 원본(PDF·사진)도 함께 보관
  async saveCurrent(file) {
    if (!this.user || !song || !current || current.kind === "demo") return null;
    const be = this.be; const id = current.cloudId || be.newId(`${this.root()}/songs`); const sp = this.songPath(id);
    const prev = current.cloudId ? await be.get(sp).catch(() => null) : null; const pb = (prev && prev.big) || {};
    const big = { ...pb };
    big.xml = await this.putBig(sp, "xml", current.xml || "", pb.xml);
    big.midi = await this.putBig(sp, "midi", (current.meta && current.meta.midiB64) || "", pb.midi);
    big.ai = await this.putBig(sp, "ai", current.ai && current.ai.json ? JSON.stringify({ json: current.ai.json, ranges: current.ai.ranges }) : "", pb.ai);
    let orig = prev && prev.original || null;
    if (file && file.size <= 6e6) { big.orig = await this.putBig(sp, "orig", b64(await file.arrayBuffer()), pb.orig); orig = { name: file.name, type: file.type || "", size: file.size }; }
    const now = Date.now();
    const doc = {
      title: song.title || current.name || "제목 없는 악보", kind: current.kind, name: current.name || "",
      measures: song.measures.length, bpm: Math.round(song.baseBpm), createdAt: (prev && prev.createdAt) || now, updatedAt: now,
      flags: current.flags || [], report: current.report || null, fixed: current.fixed || [],
      tempos: current.raw && current.raw.tempos ? current.raw.tempos.map((t) => ({ q: t.q, bpm: t.bpm })) : [],
      big, original: orig, stats: (prev && prev.stats) || { sessions: 0, lastAcc: null, bestAcc: null, totalSec: 0, lastAt: null },
    };
    await be.set(sp, doc);
    current.cloudId = id; current.hasCloudOriginal = !!orig;
    try { const last = JSON.parse(localStorage.getItem(STORE_KEY + ":last") || "null"); if (last) { last.cloudId = id; localStorage.setItem(STORE_KEY + ":last", JSON.stringify(last)); } } catch (e) {}
    return id;
  },
  autoSave(file, quiet) {
    if (!this.user || !current || current.kind === "demo") return;
    clearTimeout(this.saveT);
    this.saveT = setTimeout(async () => {
      try { await this.saveCurrent(file); if (!quiet) toast("내 악보함에 저장했어요"); renderAccount(); }
      catch (e) { console.warn(e); toast("악보함에 저장하지 못했어요. 인터넷 연결을 확인해 주세요."); }
    }, file ? 50 : 800);
  },
  async list() { return this.be.list(`${this.root()}/songs`, { orderBy: "updatedAt", dir: "desc", limit: 200 }); },
  async open(id) {
    // 늦게 끝난 이전 요청이 더 나중에 연 곡을 덮어쓰지 않게 한다
    const seq = this.openSeq = (this.openSeq || 0) + 1;
    const sp = this.songPath(id); const d = await this.be.get(sp); if (!d) throw new Error("악보를 찾지 못했어요");
    const big = d.big || {};
    const [xml, midi, ai] = await Promise.all([this.getBig(sp, "xml", big.xml), this.getBig(sp, "midi", big.midi), this.getBig(sp, "ai", big.ai)]);
    let raw;
    if (xml) raw = parseMusicXML(xml, { fit: d.kind === "omr" }); else if (midi) { raw = parseMIDI(unb64(midi)); raw.title = d.title; } else throw new Error("악보 내용이 비어 있어요");
    if (d.title && (!raw.title || raw.title === "제목 없는 악보")) raw.title = d.title; // 자동 변환 악보는 제목이 없을 때가 많다
    if (Array.isArray(d.tempos) && d.tempos.length) raw.tempos = d.tempos.map((t) => ({ ...t }));
    const aiObj = ai ? JSON.parse(ai) : null;
    if (seq !== this.openSeq) return false;
    setSong(raw, { kind: d.kind, xml: xml || null, name: d.name, midiB64: midi || null, flags: d.kind === "omr" ? omrFlags(raw, d.omrNotes) : d.flags || [], omrNotes: d.omrNotes || null, report: d.report || null, fixed: d.fixed || [], ai: aiObj, cloudId: id, fromLibrary: true });
    current.hasCloudOriginal = !!(d.original && big.orig);
    toast(d.kind === "omr" && !(d.tempos && d.tempos.length) && !(raw.tempos && raw.tempos.length) ? `'${d.title}'을(를) 열었어요. 자동 변환은 빠르기표를 읽지 못하니, 설정 → 빠르기에서 악보의 ♩= 숫자로 고쳐 주세요.` : `'${d.title}'을(를) 열었어요`);
  },
  async getOriginalFile(id) {
    const sp = this.songPath(id); const d = await this.be.get(sp); if (!d || !d.original || !(d.big && d.big.orig)) return null;
    const s = await this.getBig(sp, "orig", d.big.orig);
    return new File([new Uint8Array(unb64(s))], d.original.name, { type: d.original.type || "application/octet-stream" });
  },
  async remove(id) {
    const sp = this.songPath(id); const d = await this.be.get(sp).catch(() => null);
    if (d && d.big) for (const [f, n] of Object.entries(d.big)) for (let i = 0; i < (n || 0); i++) await this.be.del(`${sp}/chunks/${f}_${i}`).catch(() => {});
    const ss = await this.be.list(`${sp}/sessions`).catch(() => []); for (const s of ss) await this.be.del(`${sp}/sessions/${s.id}`).catch(() => {});
    await this.be.del(sp);
    if (current && current.cloudId === id) current.cloudId = null;
  },
  async logSession(s) {
    if (!this.user || !current || !current.cloudId) return;
    const sp = this.songPath(current.cloudId);
    try {
      await this.be.set(`${sp}/sessions/${this.be.newId(`${sp}/sessions`)}`, s);
      const d = await this.be.get(sp); const st = (d && d.stats) || { sessions: 0, totalSec: 0 };
      const ns = { sessions: (st.sessions || 0) + 1, totalSec: Math.round((st.totalSec || 0) + s.sec), lastAt: s.at, lastAcc: s.acc != null ? s.acc : st.lastAcc ?? null, bestAcc: s.acc != null ? Math.max(st.bestAcc || 0, s.acc) : st.bestAcc ?? null };
      await this.be.set(sp, { stats: ns, updatedAt: Date.now() }, true);
    } catch (e) { console.warn("session", e); }
  },
  async sessions(id) { return this.be.list(`${this.songPath(id)}/sessions`, { orderBy: "at", dir: "desc", limit: 20 }); },
  // 무료 자동 변환(Audiveris) 요청: 원본을 계정에 올리고 대기열에 등록 → GitHub Actions(omr.yml)가 처리
  async submitOmr(file) {
    if (!this.user) throw new Error("로그인이 필요해요");
    if (file.size > 6e6) throw new Error("6MB보다 큰 파일은 변환할 수 없어요");
    const id = this.be.newId(`${this.root()}/omrJobs`); const jp = `${this.root()}/omrJobs/${id}`;
    const n = await this.putBig(jp, "orig", b64(await file.arrayBuffer()), 0);
    const now = Date.now();
    await this.be.set(jp, { status: "queued", name: file.name, type: file.type || "", size: file.size, createdAt: now, big: { orig: n } });
    await this.be.set(`omrQueue/${id}`, { uid: this.user.uid, createdAt: now });
    this.watchJobs();
    return id;
  },
  async jobs() { return this.be.list(`${this.root()}/omrJobs`, { orderBy: "createdAt", dir: "desc", limit: 20 }); },
  async removeJob(id) { const jp = `${this.root()}/omrJobs/${id}`; const d = await this.be.get(jp).catch(() => null); for (let i = 0; i < ((d && d.big && d.big.orig) || 0); i++) await this.be.del(`${jp}/chunks/orig_${i}`).catch(() => {}); await this.be.del(jp); },
  jobT: 0, known: {},
  // 변환 중인 작업이 있으면 1분마다 확인하고, 끝나면 알려 준다
  watchJobs() {
    clearTimeout(this.jobT); if (!this.user) return;
    this.jobT = setTimeout(async () => {
      let js = []; try { js = await this.jobs(); } catch (e) { return; }
      let pending = false;
      js.forEach((j) => { const was = this.known[j.id]; if ((j.status === "done" || j.status === "failed") && was && was !== j.status) toast(j.status === "done" ? `'${j.name}' 변환이 끝났어요. 내 악보함에서 열어 보세요.` : `'${j.name}' 변환에 실패했어요: ${j.error || ""}`); this.known[j.id] = j.status; if (j.status === "queued" || j.status === "running") pending = true; });
      if (!$("#libModal").hidden) renderJobs(js);
      if (pending) this.watchJobs();
    }, $("#libModal") && !$("#libModal").hidden ? 15000 : 60000);
  },
};
const OMR_ACTIONS_URL = "https://github.com/luckydodo777/curly-octo-sniffle/actions/workflows/omr.yml";
const JOB_STATUS = { queued: "대기 중", running: "변환 중", done: "완료", failed: "실패" };
function renderJobs(js) {
  const box = $("#jobList"); if (!box) return; box.innerHTML = "";
  const list = js.filter((j) => j.status !== "done" || Date.now() - (j.finishedAt || 0) < 7 * 864e5);
  $("#jobSec").hidden = !list.length;
  list.forEach((j) => {
    const li = document.createElement("li"); li.className = "lib-item job " + j.status;
    const info = document.createElement("div"); info.className = "lib-info";
    const t = document.createElement("b"); t.textContent = j.name || "악보";
    const m = document.createElement("span"); m.className = "status";
    m.textContent = `${JOB_STATUS[j.status] || j.status} · 요청 ${fmtDate(j.createdAt)}${j.status === "done" && j.info ? ` · ${j.info.measures}마디, ${j.info.seconds}초 걸림` : ""}${j.status === "failed" ? " · " + (j.error || "") : ""}${j.status === "queued" ? " · 보통 5분 안에 시작돼요" : ""}`;
    info.append(t, m);
    const acts = document.createElement("div"); acts.className = "lib-acts";
    if (j.status === "done" && j.songId) { const b = document.createElement("button"); b.type = "button"; b.className = "btn small primary"; b.textContent = "열기"; b.onclick = async () => { try { await Library.open(j.songId); $("#libModal").hidden = true; } catch (e) { toast(e.message); } }; acts.appendChild(b); }
    if (j.status === "queued") { const a = document.createElement("a"); a.className = "btn small"; a.href = OMR_ACTIONS_URL; a.target = "_blank"; a.rel = "noopener"; a.textContent = "지금 바로 시작"; a.title = "GitHub에서 Run workflow 를 누르면 기다리지 않고 바로 변환해요"; acts.appendChild(a); }
    if (j.status !== "running") { const d = document.createElement("button"); d.type = "button"; d.className = "btn small"; d.textContent = "목록에서 지우기"; d.onclick = async () => { await Library.removeJob(j.id).catch(() => {}); renderJobs(await Library.jobs()); }; acts.appendChild(d); }
    li.append(info, acts); box.appendChild(li);
  });
}
// 연습 한 번(재생 시작~멈춤)을 기록한다
const Practice = {
  snap: null,
  start() { this.snap = { t: performance.now(), c: E.correct, m: E.mistakes, l: E.loops, from: song ? srcMeasureAt(E.pos) + 1 : 1 }; },
  flush() {
    const s = this.snap; this.snap = null; if (!s || !song) return;
    const sec = (performance.now() - s.t) / 1000; const c = E.correct - s.c, m = E.mistakes - s.m;
    if (sec < 15 && c + m === 0) return; // 너무 짧은 재생은 기록하지 않음
    Library.logSession({ at: Date.now(), sec: Math.round(sec), mode: settings.mode, hands: settings.hands, rate: Math.round(settings.rate * 100), correct: c, mistakes: m, acc: c + m ? Math.round(c / (c + m) * 100) : null, loops: E.loops - s.l, from: s.from, to: measureAt(E.pos) + 1 });
  },
};
document.addEventListener("visibilitychange", () => { if (document.hidden && E.playing) Practice.flush(), Practice.start(); });
function fmtDate(ms) { if (!ms) return ""; const d = new Date(ms); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
function renderAccount() {
  const u = Library.user;
  $("#loginBtn").hidden = !!(u && !u.anon); $("#libBtn").hidden = !u;
  if (u) $("#libBtnName").textContent = u.anon ? "(이 브라우저)" : (u.name || u.email || "").split(" ")[0];
  $("#loginBtn").title = u && u.anon ? "지금은 이 브라우저에만 저장돼요. 구글로 로그인하면 기록이 계정으로 옮겨져 다른 기기에서도 보여요" : "구글 계정으로 로그인하면 올린 악보와 연습 기록이 계정에 저장돼요";
  if (!$("#libModal").hidden) renderLibrary();
}
async function renderLibrary() {
  const u = Library.user; const list = $("#libList"), st = $("#libStatus");
  $("#libUser").textContent = u ? `${u.name || ""} ${u.email ? "· " + u.email : ""}` : "";
  $("#libSaveCur").hidden = !(u && current && current.kind !== "demo" && !current.cloudId);
  list.innerHTML = ""; st.textContent = "불러오는 중…";
  Library.jobs().then((js) => { renderJobs(js); if (js.some((j) => j.status === "queued" || j.status === "running")) Library.watchJobs(); }).catch(() => {});
  let songs = [];
  try { songs = await Library.list(); } catch (e) { st.textContent = "악보함을 불러오지 못했어요. 인터넷 연결을 확인해 주세요."; return; }
  st.textContent = songs.length ? `악보 ${songs.length}개` : "아직 저장된 악보가 없어요. 로그인한 상태에서 악보를 올리면 자동으로 여기에 저장돼요.";
  const kindName = { musicxml: "MusicXML", midi: "MIDI", ai: "AI 초안", omr: "자동 변환", demo: "예제" };
  songs.forEach((d) => {
    const li = document.createElement("li"); li.className = "lib-item" + (current && current.cloudId === d.id ? " on" : "");
    const s = d.stats || {};
    const info = document.createElement("div"); info.className = "lib-info";
    const t = document.createElement("b"); t.textContent = d.title || "제목 없는 악보";
    const meta = document.createElement("span"); meta.className = "status";
    meta.textContent = `${kindName[d.kind] || d.kind} · ${d.measures || "?"}마디 · ${fmtDate(d.updatedAt)}${s.sessions ? ` · 연습 ${s.sessions}회, 최근 정확도 ${s.lastAcc != null ? s.lastAcc + "%" : "–"}, 최고 ${s.bestAcc != null ? s.bestAcc + "%" : "–"}` : " · 아직 연습 기록 없음"}${d.original ? " · 원본 보관됨" : ""}`;
    info.append(t, meta);
    const acts = document.createElement("div"); acts.className = "lib-acts";
    const bOpen = document.createElement("button"); bOpen.type = "button"; bOpen.className = "btn small primary"; bOpen.textContent = "열기";
    bOpen.onclick = async () => { bOpen.disabled = true; try { await Library.open(d.id); $("#libModal").hidden = true; } catch (e) { toast(e.message || "열지 못했어요"); } bOpen.disabled = false; };
    const bLog = document.createElement("button"); bLog.type = "button"; bLog.className = "btn small"; bLog.textContent = "연습 기록";
    const logBox = document.createElement("div"); logBox.className = "lib-log"; logBox.hidden = true;
    bLog.onclick = async () => {
      logBox.hidden = !logBox.hidden; if (logBox.hidden) return; logBox.textContent = "불러오는 중…";
      try {
        const ss = await Library.sessions(d.id);
        logBox.innerHTML = ""; if (!ss.length) { logBox.textContent = "아직 연습 기록이 없어요."; return; }
        ss.forEach((x) => { const r = document.createElement("div"); r.textContent = `${fmtDate(x.at)} · ${x.mode === "wait" ? "따라치기" : "듣기"} · ${x.hands === "both" ? "양손" : x.hands === "R" ? "오른손" : "왼손"} · 속도 ${x.rate}% · ${x.from}~${x.to}마디 · ${Math.round(x.sec / 60 * 10) / 10}분${x.acc != null ? ` · 정확도 ${x.acc}% (틀린 음 ${x.mistakes})` : ""}${x.loops ? ` · 반복 ${x.loops}회` : ""}`; logBox.appendChild(r); });
      } catch (e) { logBox.textContent = "기록을 불러오지 못했어요."; }
    };
    const bDel = document.createElement("button"); bDel.type = "button"; bDel.className = "btn small"; bDel.textContent = "삭제";
    let armT = 0;
    bDel.onclick = async () => {
      if (bDel.dataset.armed !== "1") { bDel.dataset.armed = "1"; bDel.textContent = "정말 삭제"; bDel.classList.add("danger"); clearTimeout(armT); armT = setTimeout(() => { bDel.dataset.armed = ""; bDel.textContent = "삭제"; bDel.classList.remove("danger"); }, 3000); return; }
      bDel.disabled = true; try { await Library.remove(d.id); toast("삭제했어요"); renderLibrary(); } catch (e) { toast("삭제하지 못했어요"); bDel.disabled = false; }
    };
    acts.append(bOpen, bLog, bDel); li.append(info, acts, logBox); list.appendChild(li);
  });
}
$("#omrChipClose").onclick = () => { $("#omrChip").hidden = true; };
$("#diagBtn").onclick = async () => {
  // 악보 내용(음표)은 넣지 않는다: 위치 기록, 설정, 곡 크기만
  const info = { build: (document.querySelector('meta[name="gunban-build"]') || {}).content || "local", kind: current && current.kind, measures: song ? song.measures.length : 0,
    steps: song ? song.steps.length : 0, cursorSteps: Score.steps.length, settings: { mode: settings.mode, hands: settings.hands, loopOn: settings.loopOn, loopA: settings.loopA, loopB: settings.loopB, rate: settings.rate },
    unexpected: PosLog.unexpected().length, input: { latencyMs: Input.latency(), mic: Mic.on ? Mic.mode : "off", micStats: Mic.on ? Mic.stats : null, sr: Sound.ctx && Sound.ctx.sampleRate, ua: navigator.userAgent.slice(0, 120) }, log: PosLog.list.slice(-80) };
  const txt = JSON.stringify(info);
  try { await navigator.clipboard.writeText(txt); toast(`진단 기록을 복사했어요 (이유 없는 역행 ${info.unexpected}번)`); }
  catch (e) { console.log(txt); toast("복사하지 못했어요. 개발자 도구 콘솔에 출력했어요."); }
};
// Firebase 로그인 오류를 초보자도 알 수 있는 말로
function authErrorText(e) {
  const c = (e && e.code) || "";
  if (c === "auth/popup-closed-by-user" || c === "auth/cancelled-popup-request") return "로그인을 취소했어요";
  if (c === "auth/configuration-not-found") return "아직 Firebase 로그인이 켜져 있지 않아요. Firebase 콘솔 → Authentication → '시작하기'를 누르고 Google·익명 로그인을 사용 설정해 주세요.";
  if (c === "auth/operation-not-allowed" || c === "auth/admin-restricted-operation") return "Firebase 콘솔 → Authentication → 로그인 방법에서 Google(과 익명) 로그인을 사용 설정해 주세요.";
  if (c === "auth/unauthorized-domain") return "Firebase 콘솔 → Authentication → 설정 → 승인된 도메인에 luckydodo777.github.io 를 추가해 주세요.";
  if (c === "auth/popup-blocked") return "팝업이 차단됐어요. 주소창의 팝업 차단을 풀고 다시 눌러 주세요.";
  if (c === "auth/network-request-failed") return "인터넷 연결을 확인해 주세요.";
  return "로그인하지 못했어요: " + (c || (e && e.message) || "");
}
$("#loginBtn").onclick = async () => { try { await Library.be.signIn(); } catch (e) { toast(authErrorText(e)); } };
$("#libBtn").onclick = () => { $("#libModal").hidden = false; renderLibrary(); };
$("#libClose").onclick = () => { $("#libModal").hidden = true; };
$("#logoutBtn").onclick = async () => { Practice.flush(); await Library.be.signOut(); $("#libModal").hidden = true; toast("로그아웃했어요"); };
$("#libSaveCur").onclick = async () => { try { await Library.saveCurrent(null); toast("지금 곡을 저장했어요"); renderLibrary(); } catch (e) { toast("저장하지 못했어요"); } };

/* ============================================================
   15) PDF·사진 악보 → AI 인식 (베타)
   ============================================================ */
let samplePromise = null;
// AI 연결 지점. Claude 아티팩트에서는 window.claude.use("sample")을 쓴다.
// 다른 환경(ChatGPT 등)에서는 window.GUNBAN_AI_ADAPTER = { json(prompt, {images, signal, onText}) → Promise<object>, limits() → Promise<{images:{maxCount}}> } 를 먼저 정의하면 그걸 쓴다.
function getSample() {
  if (!samplePromise) samplePromise = window.GUNBAN_AI_ADAPTER ? Promise.resolve(window.GUNBAN_AI_ADAPTER)
    : window.claude && window.claude.use ? window.claude.use("sample").catch(() => null) : Promise.resolve(null);
  return samplePromise;
}
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("load")); document.head.appendChild(s); }); }
async function getPdfjs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  await loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js");
  await loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js");
  const lib = window.pdfjsLib || window["pdfjs-dist/build/pdf"];
  if (lib && lib.GlobalWorkerOptions) lib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  return lib;
}
function canvasToBlob(c, q = 0.9) { return new Promise((res) => c.toBlob((b) => res(b), "image/jpeg", q)); }
/* ---- 이미지 전처리: 업스케일 + 선명화 + 대비 보정 (사진·스캔 악보용) ---- */
function upscaleCanvas(src, targetW) {
  let c = src;
  while (c.width < targetW) {
    const f = Math.min(2, targetW / c.width); const n = document.createElement("canvas");
    n.width = Math.round(c.width * f); n.height = Math.round(c.height * f);
    const x = n.getContext("2d"); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high"; x.drawImage(c, 0, 0, n.width, n.height); c = n;
  }
  return c;
}
function enhanceCanvas(c) {
  const cx = c.getContext("2d", { willReadFrequently: true }); const W = c.width, H = c.height;
  const img = cx.getImageData(0, 0, W, H), d = img.data, g = new Float32Array(W * H);
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) { const v = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]; g[i] = v; hist[v | 0]++; }
  const pct = (q) => { let acc = 0; const t = g.length * q; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= t) return v; } return 255; };
  const lo = Math.min(pct(0.01), 90), hi = Math.max(pct(0.6), lo + 60); // 종이(밝은 쪽)는 흰색으로, 잉크는 검게
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let blur = g[i];
      if (x > 0 && y > 0 && x < W - 1 && y < H - 1) blur = (g[i - 1] + g[i + 1] + g[i - W] + g[i + W] + g[i] * 4) / 8;
      let v = g[i] + 0.9 * (g[i] - blur);              // 언샤프 마스크
      v = (v - lo) / (hi - lo); v = clamp(v, 0, 1); v = Math.pow(v, 1.6) * 255; // 레벨 + 감마
      const p = i * 4; d[p] = d[p + 1] = d[p + 2] = v;
    }
  }
  cx.putImageData(img, 0, 0); return c;
}
async function fileToPages(file) {
  const pages = [];
  const mk = (w, h) => { const c = document.createElement("canvas"); c.width = Math.round(w); c.height = Math.round(h); const cx = c.getContext("2d", { willReadFrequently: true }); cx.fillStyle = "#fff"; cx.fillRect(0, 0, c.width, c.height); return { c, cx }; };
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    const lib = await getPdfjs(); if (!lib) throw new Error("PDF 도구를 불러오지 못했어요.");
    const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const n = Math.min(pdf.numPages, 12);
    for (let i = 1; i <= n; i++) {
      const page = await pdf.getPage(i); const vp0 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 3000 / vp0.width }); // 벡터 PDF는 고해상도로 다시 그려서 업스케일
      const { c, cx } = mk(vp.width, vp.height);
      await page.render({ canvasContext: cx, viewport: vp }).promise;
      pages.push({ canvas: c, url: c.toDataURL("image/jpeg", 0.55), vector: true });
    }
    if (pdf.numPages > 12) toast("앞의 12쪽만 읽어요");
  } else {
    const url = URL.createObjectURL(file);
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("이미지를 열지 못했어요. JPG나 PNG로 올려 주세요.")); im.src = url; });
    const { c, cx } = mk(img.naturalWidth, img.naturalHeight); cx.drawImage(img, 0, 0);
    let up = c.width < 3000 ? upscaleCanvas(c, 3000) : c;
    if (up.width > 3400) { const s = document.createElement("canvas"); s.width = 3000; s.height = Math.round(up.height * 3000 / up.width); const sx = s.getContext("2d"); sx.imageSmoothingQuality = "high"; sx.drawImage(up, 0, 0, s.width, s.height); up = s; }
    enhanceCanvas(up);
    pages.push({ canvas: up, url: up.toDataURL("image/jpeg", 0.55), vector: false });
  }
  return pages;
}
// 오선(5줄)을 찾아 피아노 큰보표(2단) 단위 줄로 묶는다. 각 줄의 오선 위치도 돌려준다.
function detectSystems(cx, W, H) {
  const data = cx.getImageData(0, 0, W, H).data;
  const x0 = Math.floor(W * 0.04), x1 = Math.floor(W * 0.96), span = x1 - x0;
  const ratio = new Float32Array(H);
  for (let y = 0; y < H; y++) { let c = 0; const row = y * W * 4; for (let x = x0; x < x1; x++) { const i = row + x * 4; if (data[i] + data[i + 1] + data[i + 2] < 450) c++; } ratio[y] = c / span; }
  const lines = []; let y = 0;
  while (y < H) { if (ratio[y] > 0.45) { let e = y; while (e + 1 < H && ratio[e + 1] > 0.45) e++; lines.push((y + e) / 2); y = e + 1; } else y++; }
  const staves = [];
  for (let i = 0; i + 4 < lines.length;) {
    const g = [lines[i + 1] - lines[i], lines[i + 2] - lines[i + 1], lines[i + 3] - lines[i + 2], lines[i + 4] - lines[i + 3]];
    const avg = (g[0] + g[1] + g[2] + g[3]) / 4;
    if (avg > 3 && g.every((v) => Math.abs(v - avg) < avg * 0.3)) { staves.push({ top: lines[i], bot: lines[i + 4], gap: avg }); i += 5; } else i++;
  }
  if (staves.length < 2) return { staves, systems: [] };
  const systems = []; let i = 0;
  while (i < staves.length) {
    const a = staves[i], b = staves[i + 1];
    const inner = b ? b.top - a.bot : Infinity, next = staves[i + 2] ? staves[i + 2].top - b.bot : Infinity;
    if (b && (inner <= next * 1.05 || !staves[i + 2])) { systems.push({ top: a.top, bot: b.bot, gap: a.gap, st: [a, b] }); i += 2; }
    else { systems.push({ top: a.top, bot: a.bot, gap: a.gap, st: [a], single: true }); i += 1; }
  }
  return { staves, systems: systems.map((s, k) => {
    const prev = systems[k - 1], nxt = systems[k + 1];
    return { y0: Math.round(prev ? (prev.bot + s.top) / 2 : Math.max(0, s.top - s.gap * 9)), y1: Math.round(nxt ? (s.bot + nxt.top) / 2 : Math.min(H, s.bot + s.gap * 9)), single: !!s.single, staves: s.st };
  }) };
}
// 큰보표 전체를 세로로 관통하는 마디선 x 위치를 찾는다. 두 단 사이 빈 공간까지 이어진 선만 마디선으로 본다
// (박자표 숫자·음표 기둥처럼 한 단 안에만 있는 세로선은 제외)
function findBarlines(cx, W, staves) {
  const top = Math.round(staves[0].top), bot = Math.round(staves[staves.length - 1].bot), H = bot - top + 1;
  const d = cx.getImageData(0, top, W, H).data;
  const inRows = []; staves.forEach((s) => { for (let y = Math.round(s.top); y <= Math.round(s.bot); y++) inRows.push(y - top); });
  const gapRows = []; if (staves.length > 1) for (let y = Math.round(staves[0].bot) + 2; y <= Math.round(staves[1].top) - 2; y++) gapRows.push(y - top);
  const dark = (x, yy) => { const p = (yy * W + x) * 4; return d[p] + d[p + 1] + d[p + 2] < 450; };
  const strict = [], loose = []; let run = null;
  const flush = () => { if (run && run[1] - run[0] < 12) { const x = (run[0] + run[1]) / 2; loose.push(x); if (run[2]) strict.push(x); } run = null; };
  for (let x = 0; x < W; x++) {
    let c = 0; for (const yy of inRows) if (dark(x, yy)) c++;
    if (c >= inRows.length * 0.9) {
      let g = 0; for (const yy of gapRows) if (dark(x, yy)) g++;
      const through = gapRows.length > 0 && g >= gapRows.length * 0.85;
      if (run) { run[1] = x; run[2] = run[2] || through; } else run = [x, x, through];
    } else flush();
  }
  flush();
  return strict.length >= 2 ? strict : loose;
}
async function pagesToSystems(pages) {
  const out = [];
  for (let pi = 0; pi < pages.length; pi++) {
    const c = pages[pi].canvas; const cx = c.getContext("2d", { willReadFrequently: true }); let sys = [];
    try { sys = detectSystems(cx, c.width, c.height).systems; } catch (e) { sys = []; }
    if (!sys.length) sys = [{ y0: 0, y1: c.height, whole: true, staves: [] }];
    if (pi === 0 && sys.length) sys[0].y0 = 0; // 첫 줄은 제목·빠르기표까지
    for (let si = 0; si < sys.length; si++) {
      const s = sys[si]; const h = s.y1 - s.y0; if (h < 40) continue;
      // 마디선에서 잘라 조각마다 원래 해상도 그대로 보낸다(AI가 이미지를 줄이지 않도록 폭 ≤ 1500px)
      let cuts = [0, c.width];
      if (!s.whole && s.staves.length) {
        let bars = []; try { bars = findBarlines(cx, c.width, s.staves); } catch (e) {}
        // 줄 끝(마지막 마디선) 뒤의 빈 여백은 버린다
        const xEnd = bars.length && Math.max(...bars) > c.width * 0.6 ? Math.min(c.width, Math.round(Math.max(...bars)) + 24) : c.width;
        const maxW = 1500; cuts = [0]; let start = 0;
        while (xEnd - start > maxW) {
          const cand = bars.filter((x) => x > start + 400 && x <= start + maxW && xEnd - x > 300);
          const wide = bars.filter((x) => x > start + maxW && x <= start + 2400 && xEnd - x > 300); // 넓은 마디는 중간에서 자르지 않고 조금 넓게
          if (!cand.length && !wide.length && xEnd - start <= 2400) break;
          const cut = cand.length ? Math.round(cand[cand.length - 1]) + 2 : wide.length ? Math.round(wide[0]) + 2 : start + maxW;
          cuts.push(cut); start = cut;
        }
        cuts.push(xEnd);
      }
      const images = [], previews = [];
      for (let k = 0; k + 1 < cuts.length; k++) {
        const w = cuts[k + 1] - cuts[k]; if (w < 60) continue;
        const cc = document.createElement("canvas"); cc.width = w; cc.height = h;
        cc.getContext("2d").drawImage(c, cuts[k], s.y0, w, h, 0, 0, w, h);
        images.push(await canvasToBlob(cc)); previews.push(cc.toDataURL("image/jpeg", 0.5));
      }
      out.push({ page: pi, idx: si, whole: !!s.whole, images, previews });
    }
  }
  return out;
}
const AI_FORMAT_RULES = `Reply with ONLY one JSON object:
{"title": string|null, "composer": string|null, "measures": [ {"n": number|null, "time"?: [beats, beatType], "fifths"?: int, "bpm"?: number, "rhClef"?: "G"|"F", "lhClef"?: "G"|"F", "rh8va"?: 1|-1, "lh8va"?: 1|-1, "rh": [ev], "lh": [ev], "rh2"?: [ev], "lh2"?: [ev]} ]}
ev = {"p": pitch | [pitch, ...] | "r", "d": duration, "tup"?: [actual, normal], "f"?: finger | [finger, ...], "tie"?: true}

PITCH
- Read each note in the clef in effect on that staff at that point. Clefs can change (the lower staff may switch to treble clef). Give "rhClef"/"lhClef" on a measure whenever the clef in effect at its start is not the usual one (upper G, lower F) or changes.
- Write the WRITTEN pitch, applying the key signature and accidentals earlier in the same measure. An accidental (including a natural ♮) stays in force for that pitch until the barline. Middle C = C4. Use "#" and "b" ("F#4", "Bb3"); a natural is written without accidental ("E4").
- Do NOT apply 8va/8vb lines to the pitch. Instead set "rh8va": 1 (or -1 for 8vb) on each measure the line covers ("lh8va" for the lower staff). An "8va" written as text over a passage applies until "loco" or the end of its line.

RHYTHM (most important: the app plays exactly these durations)
- "d": "w","h","q","e","s","t" (whole, half, quarter, eighth, 16th, 32nd); add "." per dot ("q.", "e."). Count beams: 1 beam = eighth, 2 = 16th, 3 = 32nd.
- Tuplets: eighth triplets "e3", sixteenth triplets "s3"; other tuplets use "tup", e.g. five 16ths in the time of four = {"d":"s","tup":[5,4]}, six 16ths in the time of four = {"d":"s","tup":[6,4]}.
- Notes struck together on one staff = ONE event with an array of pitches. Never split a chord into separate events.
- If on one staff some notes are held while others move (two voices: stems up and stems down), put the moving line in "rh" and the held notes in "rh2" (same for "lh"/"lh2"), each padded with rests "r" so BOTH add up to the full measure. Never write a held note again as a new event.
- "tie": true on a note tied to the next note of the same pitch (also across the barline). Still write the next note; the app joins them.
- CHECK each staff and voice: durations in every measure must add up exactly to the time signature (3/4 = three quarters). Recount before answering.
- "bpm" ONLY on a measure where a metronome mark "♩ = N" is printed (use N exactly). Ignore accel./rit. words.
- Ties vs slurs: a tie joins two noteheads of the SAME pitch (the second is not struck again); a slur joins different pitches and is ignored. A 16th chord tied to the following chord is a syncopation: write both, with "tie": true on the first.
- Tremolo (two notes or chords joined by beams/slashes without a common stem): write it as one chord of those notes lasting the written value.
- Count beams separately on each staff: the lower staff often moves in 16ths while the upper staff has 8ths.
- Ignore grace notes, dynamics, pedal, fermatas, lyrics and chord symbols. Do not unroll repeats. "f" only if fingering is printed.`;
function partsNote(n) { return n > 1 ? `The ${n} images are consecutive LEFT-TO-RIGHT parts of the SAME line, cut exactly at barlines. The clef and key signature are printed only at the start of image 1 but apply to all parts.` : ""; }
function systemPrompt(o) {
  return `You are an expert music engraver transcribing ONE system (one line of a piano grand staff) from a printed score, for a beginner practice app that plays exactly what you write.
${partsNote(o.parts)}
${o.first ? "This is the FIRST line of the piece. Also return the title/composer if visible (else null). Put the starting metronome mark as \"bpm\" on the first measure (if only a tempo word is printed, estimate: Adagio 66, Andante 80, Moderato 100, Allegro 130)." : `Context from earlier lines: time signature ${o.time[0]}/${o.time[1]}, key signature fifths ${o.fifths}.`}
${o.whole ? "The image may be a whole page: transcribe all its lines in order." : ""}
${o.retry ? `A previous attempt at THIS line had these problems: ${o.retry}\nLook again very carefully at rhythms, dots, tuplets, rests, ties and second voices, and fix them.` : ""}

Transcribe every measure on this line from left to right. If a measure number is printed at the start of the line, use it for "n" of the first measure and count up.
${AI_FORMAT_RULES}`;
}
const tidyAI = (d) => { if (d && Array.isArray(d.measures)) d.measures = d.measures.filter((m) => m && typeof m === "object"); (d && d.measures || []).forEach((m) => VOICES.forEach(([k]) => { if (m[k] != null && !Array.isArray(m[k])) m[k] = []; })); return d; };
const issuesOfAI = (ms, time) => repairScore(JSON.parse(JSON.stringify({ time, measures: ms })));
const isFatal = (e) => e && (e.code === "cancelled" || e.code === "not_granted" || e.code === "rate_limited");
// i번째 마디 직전까지의 박자표·조표·음자리표 상태
function stateBefore(all, idx) {
  const s = { time: all.time || [4, 4], fifths: all.fifths || 0, rh: "G", lh: "F" };
  for (let i = 0; i < idx && i < all.measures.length; i++) { const m = all.measures[i]; if (Array.isArray(m.time)) s.time = m.time.map(Number); if (m.fifths != null && !isNaN(parseInt(m.fifths))) s.fifths = parseInt(m.fifths); if (m.rhClef) s.rh = m.rhClef; if (m.lhClef) s.lh = m.lhClef; }
  return s;
}
// 지금 앱이 알고 있는 악보(JSON)를 실제 악보 그림으로 그려 PNG로 만든다 → 원본 그림과 나란히 비교용
async function renderTranscriptionPNG(measures, st, firstNumber) {
  const lib = await Score.loadLib(); if (!lib) return null;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-20000px;top:0;width:1500px;background:#fff;color:#000";
  document.body.appendChild(host);
  try {
    const ms = JSON.parse(JSON.stringify(measures));
    if (ms[0]) { ms[0].rhClef = ms[0].rhClef || st.rh; ms[0].lhClef = ms[0].lhClef || st.lh; }
    const xml = jsonToMusicXML({ title: "", bpm: 0, time: st.time, fifths: st.fifths, measures: ms, firstNumber, noPickup: true, noOttava: true });
    const o = new lib.OpenSheetMusicDisplay(host, { backend: "svg", autoResize: false, drawTitle: false, drawSubtitle: false, drawComposer: false, drawCredits: false, drawPartNames: false, drawMeasureNumbers: true, measureNumberInterval: 1, drawFingerings: false, autoBeam: true });
    await o.load(xml); o.zoom = 1.1; o.render();
    const svg = host.querySelector("svg"); if (!svg) return null;
    const w = Math.ceil(svg.getBoundingClientRect().width), h = Math.ceil(svg.getBoundingClientRect().height);
    if (!svg.getAttribute("xmlns")) svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const img = new Image(); img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    await img.decode();
    const c = document.createElement("canvas"); const sc = Math.min(1.4, 2000 / w); c.width = Math.round(w * sc); c.height = Math.round(h * sc);
    const cx = c.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, c.width, c.height); cx.drawImage(img, 0, 0, c.width, c.height);
    return { blob: await canvasToBlob(c, 0.9), url: c.toDataURL("image/jpeg", 0.6) };
  } catch (e) { console.warn("render transcription", e); return null; }
  finally { host.remove(); }
}
function verifyPrompt(o, measures) {
  const n = o.parts;
  return `You are proofreading a transcription of ONE line of a printed piano score. The practice app plays the transcription note-for-note, so every pitch and every duration must match the original.
${n > 1 ? `Images 1-${n} are the ORIGINAL printed line, split left-to-right at barlines (clef and key signature only at the start of image 1).` : "Image 1 is the ORIGINAL printed line."}
${o.render ? `Image ${n + 1} is the CURRENT TRANSCRIPTION drawn as notation by the app (measure numbers ${o.firstNumber}-${o.firstNumber + measures.length - 1} are printed on it). 8va lines are NOT drawn in it (check the rh8va/lh8va fields instead). Compare image ${n + 1} with the original side by side, measure by measure: any visual difference is an error in the transcription.` : ""}
Context: time signature ${o.time[0]}/${o.time[1]}, key signature fifths ${o.fifths}.
Transcription JSON of this line, one object per measure in order (index "i" starts at 0; measure ${o.firstNumber} is i=0):
${JSON.stringify(measures.map((m, i) => ({ i, ...m })))}
${o.focus != null ? `\nThe user reported that measure ${o.firstNumber + o.focus} (i=${o.focus}) sounds wrong. Check it with extra care.` : ""}
Check beat by beat, staff by staff:
- chords: every notehead present, no extra notes; correct octave and clef;
- accidentals: an accidental (including a natural ♮) lasts until the barline for that pitch;
- rhythm: count the beams/flags (8th vs 16th vs 32nd), dots, tuplet numbers, rests;
- ties: a curve joining two noteheads of the SAME pitch means the second one is NOT struck again; a held note in a second voice must not be repeated;
- tremolo slashes: two notes joined by beams but not by stems = tremolo, written as a chord held for the written value;
- metronome marks.
Reply with ONLY one JSON object: {"measures": [ {"i": 0, "match": true}, {"i": 1, "match": false, "problems": "짧은 한국어 설명", "fixed": { the complete corrected measure object in the same format, without "i" }} ]}
Include one entry per measure. Use "match": true only if the measure is fully correct.
Format of a measure object:
${AI_FORMAT_RULES.split("\n").slice(1).join("\n")}`;
}
// 한 줄을 원본과 대조해서 고친다. 돌려주는 값: {measures, verdicts[], render}
async function verifySystem(sample, sys, measures, st, firstNumber, opts) {
  const maxImgs = opts.maxImgs || 5;
  let render = null;
  if (sys.images.length < maxImgs) render = await renderTranscriptionPNG(measures, st, firstNumber);
  const images = render ? sys.images.concat([render.blob]) : sys.images;
  const data = tidyAI(await sample.json(verifyPrompt({ parts: sys.images.length, render: !!render, time: st.time, fifths: st.fifths, firstNumber, focus: opts.focus }, measures),
    { images, modelTier: "complex", signal: opts.signal, cache: false, onText: opts.onText }));
  const out = measures.slice(); const v = measures.map(() => "unchecked");
  (data && Array.isArray(data.measures) ? data.measures : []).forEach((x) => {
    const i = Number(x && x.i); if (!(i >= 0 && i < out.length)) return;
    if (x.match === true) { v[i] = "match"; return; }
    if (x.fixed && typeof x.fixed === "object") {
      const fixed = tidyAI({ measures: [x.fixed] }).measures[0];
      if (fixed && (Array.isArray(fixed.rh) || Array.isArray(fixed.lh))) {
        const before = issuesOfAI([out[i]], st.time).length, after = issuesOfAI([fixed], st.time).length;
        if (after <= before) { if (out[i].n != null && fixed.n == null) fixed.n = out[i].n; out[i] = fixed; v[i] = { fixed: String(x.problems || "원본과 달라서 고쳤어요") }; return; }
      }
    }
    v[i] = { wrong: String(x.problems || "원본과 다를 수 있어요") };
  });
  return { measures: out, verdicts: v, render };
}
async function poolRun(items, n, fn) { let next = 0; const worker = async () => { while (next < items.length) { const k = next++; await fn(items[k], k); } }; await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker)); }
async function openAIDialog(file) {
  const modal = $("#aiModal"); modal.hidden = false;
  $("#aiTitle").textContent = "PDF·사진 악보 읽기"; $("#aiGo").textContent = "AI로 악보 읽기";
  const go = $("#aiGo"), desc = $("#aiDesc"), st = $("#aiStatus"), thumbs = $("#aiThumbs"), prog = $("#aiProg"), vbox = $("#aiVerifyRow");
  thumbs.innerHTML = ""; st.textContent = ""; prog.hidden = true; go.hidden = false; go.disabled = true; vbox.hidden = true;
  let ctl = null, systems = [];
  $("#aiCancel").onclick = () => { if (ctl) ctl.abort(); modal.hidden = true; };
  const sample = await getSample();
  const caps = sample ? await sample.limits().catch(() => null) : null;
  if ((!sample || !caps || !caps.images) && Library.available) { modal.hidden = true; autoConvert(file); return; }
  if (!sample || !caps || !caps.images) {
    desc.innerHTML = `이 화면에서는 PDF·사진을 바로 읽을 수 없어요. <a href="https://luckydodo777.github.io/curly-octo-sniffle/" target="_blank" rel="noopener">웹 버전</a>에서 올리면 파일만 올려도 자동으로 변환돼요. 또는 아래처럼 직접 바꿔서 올려 주세요.`;
    thumbs.innerHTML = `<ol class="steps"><li><b>MuseScore 4</b>(무료)를 설치해요.</li><li>파일 → 가져오기에서 PDF를 열어요(악보 인식 기능이 MusicXML로 바꿔 줘요).</li><li>틀린 음을 고친 뒤 파일 → 내보내기 → <b>MusicXML</b>로 저장해요.</li><li>여기서 <b>악보 올리기</b>로 그 파일을 열어요.</li></ol>`;
    go.hidden = true; return;
  }
  const maxImgs = Math.max(1, (caps.images && caps.images.maxCount) || 5);
  st.textContent = "악보를 고해상도로 바꾸고(업스케일·선명화) 줄과 마디선을 찾는 중…";
  let pages;
  try { pages = await fileToPages(file); systems = await pagesToSystems(pages); }
  catch (e) { st.textContent = e.message || "파일을 열지 못했어요."; return; }
  systems.forEach((s) => { if (s.images.length > maxImgs) { s.images = s.images.slice(0, maxImgs); } });
  const parts = systems.reduce((a, s) => a + s.images.length, 0);
  const est = Math.max(1, Math.round(systems.length * 0.45));
  desc.textContent = `${pages.length}쪽 · ${systems.length}줄 · ${parts}조각으로 나눴어요. ${pages[0].vector ? "PDF를 3000px 고해상도로 다시 그렸고" : "사진을 업스케일·선명화했고"}, 줄마다 마디선에서 잘라 AI가 원래 해상도로 읽어요. 다 읽으면 앱이 읽은 내용을 악보 그림으로 다시 그려서 원본 그림과 나란히 비교하고, 다른 마디를 고친 뒤 일치율을 알려 드려요.`;
  systems.slice(0, 30).forEach((p) => p.previews.forEach((u) => { const im = document.createElement("img"); im.src = u; im.alt = `${p.page + 1}쪽 ${p.idx + 1}번째 줄`; thumbs.appendChild(im); }));
  vbox.hidden = false;
  const updEst = () => { const v = $("#aiVerify").checked; st.textContent = `${systems.length}줄을 읽을 준비가 됐어요. 예상 시간 약 ${v ? est * 2 : est}~${v ? est * 4 : est * 2}분.`; };
  $("#aiVerify").onchange = updEst; updEst(); go.disabled = false;
  go.onclick = async () => {
    go.disabled = true; vbox.hidden = true; prog.hidden = false; const bar = prog.querySelector("i"); bar.style.width = "2%";
    ctl = new AbortController();
    const doVerify = $("#aiVerify").checked;
    const total = systems.length * (doVerify ? 2 : 1); let done = 0, retried = 0;
    const results = new Array(systems.length).fill(null);
    const ctx = { time: [4, 4], fifths: 0 };
    const tick = (msg) => { done++; bar.style.width = Math.round(done / total * 100) + "%"; st.textContent = msg; };
    const readOne = async (sys, k, first) => {
      const opts = { images: sys.images, modelTier: "complex", signal: ctl.signal, onText: ({ text }) => { st.textContent = `읽는 중 ${Math.min(done + 1, total)}/${total} · ${text.length.toLocaleString()}자`; } };
      const po = { first, time: ctx.time, fifths: ctx.fifths, whole: sys.whole, parts: sys.images.length };
      let data = tidyAI(await sample.json(systemPrompt(po), opts));
      if (!data || !Array.isArray(data.measures)) throw { code: "invalid_json" };
      const time0 = first ? (data.measures[0] && data.measures[0].time) || ctx.time : ctx.time;
      let f = issuesOfAI(data.measures, time0);
      if (f.length) {
        retried++;
        const msg = f.map((x) => `measure ${x.m + 1} of this line: ${x.issues.join(", ").replace(/오른손/g, "upper staff").replace(/왼손/g, "lower staff").replace(/박자가 ([\d.]+)박만큼 넘쳐서 잘라냄/g, "durations are $1 quarter(s) too long").replace(/박자가 ([\d.]+)박 모자람/g, "durations are $1 quarter(s) short")}`).join("; ");
        try {
          const again = tidyAI(await sample.json(systemPrompt({ ...po, retry: msg }), { ...opts, cache: false }));
          if (again && Array.isArray(again.measures) && again.measures.length) { const f2 = issuesOfAI(again.measures, time0); if (f2.length <= f.length) { data = again; f = f2; } }
        } catch (e) { if (isFatal(e)) throw e; }
      }
      results[k] = data;
      tick(`${k + 1}번째 줄을 읽었어요${retried ? ` (박자를 다시 확인한 줄 ${retried}개)` : ""}`);
    };
    try {
      await readOne(systems[0], 0, true);
      const first = results[0]; const m0 = first.measures[0] || {};
      if (Array.isArray(m0.time)) ctx.time = m0.time.map(Number);
      if (m0.fifths != null) ctx.fifths = parseInt(m0.fifths) || 0;
      await poolRun(systems.slice(1), 2, (sys, k) => readOne(sys, k + 1, false).catch((e) => { if (isFatal(e)) throw e; results[k + 1] = { failed: true, measures: [] }; tick(`${k + 2}번째 줄을 읽지 못했어요`); }));
      // 합치기 (줄별 마디 범위 기록)
      const all = { title: first.title || file.name.replace(/\.[^.]+$/, ""), composer: first.composer || "", bpm: Number(m0.bpm) || 80, time: ctx.time, fifths: ctx.fifths, measures: [] };
      const extra = [], ranges = [];
      results.forEach((r, k) => {
        if (!r || r.failed) { ranges.push({ start: all.measures.length, count: 0 }); extra.push({ m: all.measures.length, issues: [`${systems[k].page + 1}쪽 ${systems[k].idx + 1}번째 줄을 읽지 못했어요 (마디가 빠졌어요)`] }); return; }
        const firstN = r.measures[0] && Number(r.measures[0].n), expected = all.measures.length + 1;
        if (k > 0 && firstN && firstN !== expected && firstN !== expected - 1) extra.push({ m: all.measures.length, issues: [`악보의 마디 번호(${firstN})와 순서(${expected})가 달라요. 마디가 빠지거나 겹쳤을 수 있어요`] });
        ranges.push({ start: all.measures.length, count: r.measures.length });
        all.measures.push(...r.measures);
      });
      if (!all.measures.length) throw { code: "empty" };
      // 원본 대조: 앱이 읽은 악보를 그림으로 그려 원본 그림과 비교
      const rep = { total: all.measures.length, match: 0, fixed: 0, wrong: 0, unchecked: 0, verified: doVerify };
      const fixedList = [];
      if (doVerify) {
        await poolRun(systems, 2, async (sys, k) => {
          const rg = ranges[k]; if (!rg.count) { tick("대조할 내용이 없는 줄을 건너뛰었어요"); return; }
          const ms = all.measures.slice(rg.start, rg.start + rg.count); const stt = stateBefore(all, rg.start);
          try {
            const res = await verifySystem(sample, sys, ms, stt, rg.start + 1, { maxImgs, signal: ctl.signal, onText: ({ text }) => { st.textContent = `원본 그림과 비교 중 ${Math.min(done + 1, total)}/${total} · ${text.length.toLocaleString()}자`; } });
            res.measures.forEach((m, i) => { all.measures[rg.start + i] = m; const v = res.verdicts[i];
              if (v === "match") rep.match++; else if (v && typeof v === "object" && v.fixed) { rep.fixed++; fixedList.push({ m: rg.start + i, note: v.fixed }); } else if (v && typeof v === "object" && v.wrong) { rep.wrong++; extra.push({ m: rg.start + i, issues: [`원본 대조: ${v.wrong}`] }); } else rep.unchecked++; });
            tick(`${k + 1}번째 줄 대조 완료`);
          } catch (e) { if (isFatal(e)) throw e; rep.unchecked += rg.count; tick(`${k + 1}번째 줄은 대조하지 못했어요`); }
        });
      }
      const flags = repairScore(all).concat(extra.filter((x) => x.m < all.measures.length));
      const xml = jsonToMusicXML(all);
      setSong(parseMusicXML(xml), { kind: "ai", xml, name: file.name, file, origImages: pages.map((p) => p.url), flags, report: rep, fixed: fixedList, ai: { json: all, ranges, systems, maxImgs } });
      modal.hidden = true;
      toast(doVerify ? `원본 대조 결과: ${rep.total}마디 중 ${rep.match}마디 일치, ${rep.fixed}마디 고침, ${new Set(flags.map((f) => f.m)).size}마디 확인 필요` : `${all.measures.length}마디를 읽었어요.`);
    } catch (e) {
      const code = e && e.code;
      st.textContent = code === "cancelled" ? "멈췄어요." : code === "not_granted" ? "AI 사용을 허용하지 않아서 읽지 못했어요." : code === "rate_limited" ? "요청이 많아요. 잠시 뒤 다시 시도해 주세요." : code === "invalid_json" ? "악보를 제대로 받아 적지 못했어요. 더 선명한 이미지로 다시 시도해 주세요." : "읽는 중에 문제가 생겼어요. " + (e && e.message ? e.message : "");
      go.disabled = false;
    }
  };
}
// 악보 파일만 올리면 끝: 자동으로 변환을 요청하고, 진행 상황을 보여 주고, 끝나면 자동으로 연다 (AI 토큰 사용 없음)
const Convert = {
  jobId: null, name: "", t: 0, started: 0, kicked: false,
  chip(text, cls, withLink) {
    const c = $("#omrChip"); c.hidden = !text; c.className = "omr-chip " + (cls || "");
    $("#omrChipText").textContent = text || "";
    $("#omrChipLink").hidden = !withLink;
    $("#omrChipOpen").hidden = true;
  },
  remember() { try { localStorage.setItem(STORE_KEY + ":omrJob", JSON.stringify(this.jobId ? { id: this.jobId, name: this.name, started: this.started } : null)); } catch (e) {} },
  elapsed() { const s = Math.round((Date.now() - this.started) / 1000); return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`; },
  async poll() {
    clearTimeout(this.t); if (!this.jobId || !Library.user) return;
    let j = null; try { j = await Library.be.get(`${Library.root()}/omrJobs/${this.jobId}`); } catch (e) {}
    if (!j) { this.chip(""); this.jobId = null; this.remember(); return; }
    if (j.status === "done" && j.songId) {
      const id = j.songId, name = this.name; this.jobId = null; this.remember();
      const openIt = async () => { this.chip(`'${name}' 변환 완료! 여는 중…`, "ok"); try { await Library.open(id); } catch (e) { toast("변환은 끝났지만 열지 못했어요. 내 악보함에서 열어 주세요."); } setTimeout(() => this.chip(""), 4000); };
      // 연습(재생) 중이면 곡을 갑자기 바꾸지 않고 "열기" 버튼을 보여 준다
      if (E.playing) { this.chip(`'${name}' 변환 완료!`, "ok"); const b = $("#omrChipOpen"); b.hidden = false; b.onclick = openIt; return; }
      await openIt(); return;
    }
    if (j.status === "failed") { this.chip(`'${this.name}' 변환 실패: ${j.error || "알 수 없는 오류"} (더 선명한 PDF로 다시 올려 보세요)`, "bad"); this.jobId = null; this.remember(); return; }
    const late = j.status === "queued" && Date.now() - this.started > 10 * 60e3;
    const msg = late ? `변환이 예상보다 늦어지고 있어요 (${this.elapsed()}). 조금 더 기다리거나, 같은 파일을 다시 올려 주세요.` : j.status === "running" ? `악보를 인식하는 중… (${this.elapsed()})` : (this.kicked ? `변환 준비 중… (${this.elapsed()}, 보통 1~2분이면 열려요)` : `변환 순서를 기다리는 중… (${this.elapsed()}, 보통 5~10분 안에 시작돼요)`);
    this.chip(`'${this.name}' ${msg}`, "", j.status === "queued" && !this.kicked);
    this.t = setTimeout(() => this.poll(), this.kicked || j.status === "running" ? 4000 : 10000);
  },
  resume() { try { const r = JSON.parse(localStorage.getItem(STORE_KEY + ":omrJob") || "null"); if (r && r.id && Date.now() - r.started < 6 * 3600e3) { Object.assign(this, { jobId: r.id, name: r.name, started: r.started }); this.poll(); } } catch (e) {} },
};
// 변환 서버로 바로 보내고 결과를 받아 연다 (보통 20~40초, 잠든 서버는 처음 한 번 1분쯤 더)
let omrBusy = false;
function wakeOmrServer() { const u = omrServer(); if (u) fetch(u + "/health", { cache: "no-store" }).catch(() => {}); }
async function serverConvert(file) {
  const url = omrServer();
  if (omrBusy) { toast("앞의 악보를 변환하는 중이에요. 끝나면 다시 올려 주세요."); return; }
  if (file.size > 15e6) { toast("15MB보다 큰 파일은 변환할 수 없어요. 페이지를 나눠서 올려 주세요."); return; }
  omrBusy = true; Convert.name = file.name; Convert.started = Date.now();
  let phase = "인식하는 중"; const tick = () => Convert.chip(`'${file.name}' 악보를 ${phase}… (${Convert.elapsed()})`);
  tick(); const timer = setInterval(tick, 1000);
  const ctl = new AbortController(); const kill = setTimeout(() => ctl.abort(), 6 * 60e3);
  try {
    let res = null, data = null;
    for (let tries = 0; ; tries++) {
      try { res = await fetch(url + "/convert", { method: "POST", body: file, signal: ctl.signal, headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) } }); }
      catch (e) { if (ctl.signal.aborted) throw new Error("시간이 너무 오래 걸려 멈췄어요"); res = null; }
      // 잠든 서버가 깨어나는 동안에는 연결이 안 되거나 502/503이 온다 → 잠시 뒤 다시
      const waking = !res || res.status === 502 || res.status === 503 || res.status === 504;
      if (waking && tries < 30) { const busy = res && res.status === 503 ? await res.clone().json().then((d) => d.busy).catch(() => false) : false; phase = busy ? "변환하려고 순서를 기다리는 중" : "변환 서버를 깨우는 중(처음 한 번만 1분쯤 걸려요)"; tick(); await new Promise((r) => setTimeout(r, 5000)); continue; }
      data = res ? await res.json().catch(() => null) : null; break;
    }
    if (!data || !data.xml) throw new Error((data && data.error) || `변환 서버 오류 (${res ? res.status : "연결 안 됨"})`);
    phase = "여는 중";
    const raw = parseMusicXML(data.xml, { fit: true }); if (!raw.title || raw.title === "제목 없는 악보" || /^(title|untitled)$/i.test(raw.title.trim())) raw.title = file.name.replace(/\.[^.]+$/, "");
    setSong(raw, { kind: "omr", xml: data.xml, name: file.name, file, flags: omrFlags(raw, data.info && data.info.notes), omrNotes: (data.info && data.info.notes) || null });
    clearInterval(timer);
    Convert.chip(`'${file.name}' 변환 완료! (${Convert.elapsed()})`, "ok"); setTimeout(() => Convert.chip(""), 5000);
    toast("자동 변환은 빠르기표를 읽지 못해요. 빠르기가 다르면 설정 → 빠르기에서 악보의 ♩= 숫자로 고쳐 주세요.");
  } catch (e) {
    clearInterval(timer);
    if (Library.available && !ctl.signal.aborted && !(e && /MB|악보를 찾지/.test(e.message || ""))) { toast("변환 서버가 응답하지 않아 예비 방식(몇 분 걸림)으로 변환할게요."); omrBusy = false; clearTimeout(kill); autoConvert(file); return; }
    Convert.chip(`'${file.name}' 변환 실패: ${(e && e.message) || "알 수 없는 오류"} (더 선명한 PDF로 다시 올려 보세요)`, "bad");
  } finally { omrBusy = false; clearTimeout(kill); }
}
async function autoConvert(file) {
  if (file.size > 6e6) { toast("6MB보다 큰 파일은 변환할 수 없어요. 페이지를 나눠서 올려 주세요."); return; }
  Convert.name = file.name; Convert.started = Date.now();
  Convert.chip(`'${file.name}' 올리는 중…`);
  try { await Library.ensureUser(); }
  catch (e) {
    const c = e && e.code;
    Convert.chip(c && c !== "auth/admin-restricted-operation" && c !== "auth/operation-not-allowed" ? authErrorText(e) : "변환하려면 로그인이 필요해요. 위의 '구글로 로그인'을 누른 뒤 파일을 다시 올려 주세요. (Firebase에서 익명 로그인을 켜면 로그인 없이도 돼요)", "bad");
    return;
  }
  try {
    Convert.jobId = await Library.submitOmr(file); Convert.remember();
    Convert.kicked = false;
    if (omrKick()) { try { const r = await fetch(omrKick(), { method: "POST" }); Convert.kicked = r.ok; } catch (e) {} }
    toast("악보 변환을 시작했어요. 끝나면 자동으로 열려요. 그동안 다른 곡을 연습해도 돼요.");
    Convert.poll();
  } catch (e) { Convert.chip(`'${file.name}' 변환을 요청하지 못했어요: ${e.message || ""}`, "bad"); }
}
/* ---- "지금 마디 다시 확인": 이상하게 들리는 마디를 원본 그림과 다시 비교해서 고친다 ---- */
let recheckBusy = false;
function pickFile(accept) { return new Promise((res) => { const i = document.createElement("input"); i.type = "file"; i.accept = accept; i.onchange = () => res(i.files[0] || null); i.click(); }); }
async function recheckMeasure(mi, filePromise) {
  const ai = current.ai; const btn = $("#recheckBtn");
  if (!ai || !ai.json) { toast("AI가 읽은 악보에서만 쓸 수 있어요"); return; }
  if (recheckBusy) return;
  const sample = await getSample(); const caps = sample ? await sample.limits().catch(() => null) : null;
  if (!sample || !caps || !caps.images) { toast("이 화면에서는 AI를 쓸 수 없어요"); return; }
  recheckBusy = true; btn.disabled = true;
  try {
    if (!ai.systems) {
      let f = null;
      if (!filePromise && current.cloudId && current.hasCloudOriginal) { btn.textContent = "악보함에서 원본 불러오는 중…"; f = await Library.getOriginalFile(current.cloudId).catch(() => null); }
      else f = await filePromise;
      if (!f) { toast("원본 파일이 없어서 다시 확인할 수 없어요"); return; }
      btn.textContent = "원본 준비 중…";
      const pages = await fileToPages(f); ai.systems = await pagesToSystems(pages);
      ai.maxImgs = Math.max(1, caps.images.maxCount || 5);
      ai.systems.forEach((s) => { if (s.images.length > ai.maxImgs) s.images = s.images.slice(0, ai.maxImgs); });
      if (ai.systems.length !== ai.ranges.length) toast(`원본 줄 수(${ai.systems.length})가 처음과 달라요(${ai.ranges.length}). 같은 파일인지 확인해 주세요.`);
    }
    const k = ai.ranges.findIndex((r) => mi >= r.start && mi < r.start + r.count);
    if (k < 0 || !ai.systems[k]) { toast("이 마디가 원본의 몇 번째 줄인지 찾지 못했어요"); return; }
    const rg = ai.ranges[k]; const ms = ai.json.measures.slice(rg.start, rg.start + rg.count);
    btn.textContent = `${mi + 1}마디 원본과 비교 중…`;
    const res = await verifySystem(sample, ai.systems[k], ms, stateBefore(ai.json, rg.start), rg.start + 1, { maxImgs: ai.maxImgs || 5, focus: mi - rg.start, onText: ({ text }) => { btn.textContent = `${mi + 1}마디 비교 중… ${text.length.toLocaleString()}자`; } });
    let changed = 0; const notes = [];
    const flags = (current.flags || []).filter((f) => f.m < rg.start || f.m >= rg.start + rg.count);
    const fixed = (current.fixed || []).slice();
    res.measures.forEach((m, i) => {
      const gi = rg.start + i; const v = res.verdicts[i]; ai.json.measures[gi] = m;
      if (v && typeof v === "object" && v.fixed) { changed++; fixed.push({ m: gi, note: v.fixed }); notes.push(`${gi + 1}마디: ${v.fixed}`); }
      else if (v && typeof v === "object" && v.wrong) flags.push({ m: gi, issues: [`원본 대조: ${v.wrong}`] });
      else if (v === "unchecked") (current.flags || []).filter((f) => f.m === gi).forEach((f) => flags.push(f));
    });
    const keepPos = mi; const xml = jsonToMusicXML(ai.json);
    const rep = current.report ? { ...current.report } : null;
    setSong(parseMusicXML(xml), { ...current.meta, file: null, sameSong: true, fromLibrary: false, persist: true, xml, flags: flags.concat(repairScore(JSON.parse(JSON.stringify(ai.json))).filter((f) => !flags.some((x) => x.m === f.m))), fixed, report: rep, ai, keepLoop: true });
    if (song.measures[keepPos]) seek(song.measures[keepPos].start, false, "song");
    toast(changed ? `고쳤어요 — ${notes.slice(0, 2).join(" / ")}` : res.verdicts[mi - rg.start] === "match" ? `${mi + 1}마디는 원본과 같아요. 그래도 이상하면 그 부분의 빠르기·손가락을 확인해 보세요.` : `${mi + 1}마디: 다를 수 있지만 확실히 고치지 못했어요`);
  } catch (e) {
    toast(e && e.code === "not_granted" ? "AI 사용을 허용해야 다시 확인할 수 있어요." : e && e.code === "rate_limited" ? "요청이 많아요. 잠시 뒤 다시 눌러 주세요." : "다시 확인하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
  } finally { recheckBusy = false; btn.disabled = false; btn.textContent = "지금 마디 다시 확인"; }
}
$("#recheckBtn") && ($("#recheckBtn").onclick = () => {
  if (!song) return; const mi = srcMeasureAt(E.pos);
  const needFile = current.ai && !current.ai.systems && !(current.cloudId && current.hasCloudOriginal && Library.user);
  if (needFile) toast("원본 악보 파일(PDF·사진)을 다시 골라 주세요. 줄 이미지를 다시 만들어요.");
  const fp = needFile ? pickFile(".pdf,image/*") : null; // 파일 고르기 창은 클릭 순간에 열어야 함
  recheckMeasure(mi, fp);
});

/* ============================================================
   16) 시작
   ============================================================ */
function boot() {
  try { const bm = document.querySelector('meta[name="gunban-build"]'); if (bm) $("#buildInfo").textContent = "버전 " + bm.content + " (GitHub 자동 배포)"; } catch (e) {}
  setMode(settings.mode); setHands(settings.hands); setRate(settings.rate); updateOct();
  $("#metroBtn").setAttribute("aria-pressed", String(!!settings.metro)); $("#loopBtn").setAttribute("aria-pressed", String(!!settings.loopOn)); $("#loopOn").checked = !!settings.loopOn;
  applyView();
  let restored = false;
  try {
    const last = JSON.parse(localStorage.getItem(STORE_KEY + ":last") || "null");
    if (last && last.kind !== "demo") {
      if (last.xml) { const raw = parseMusicXML(last.xml, { fit: last.kind === "omr" }); if (Array.isArray(last.tempos) && last.tempos.length) raw.tempos = last.tempos; setSong(raw, { kind: last.kind, xml: last.xml, name: last.name, flags: last.kind === "omr" ? omrFlags(raw, last.omrNotes) : last.flags || [], omrNotes: last.omrNotes || null, report: last.report || null, fixed: last.fixed || [], ai: last.ai || null, persist: false }); restored = true; }
      else if (last.midiB64) { const raw = parseMIDI(unb64(last.midiB64)); raw.title = (last.name || "").replace(/\.[^.]+$/, ""); setSong(raw, { kind: "midi", name: last.name, persist: false }); restored = true; }
    }
  } catch (e) {}
  if (!restored) loadDemo();
  // 지난번에 켜 둔 구간 반복이 그대로 살아 있으면 알려 준다 (모르면 "자꾸 뒤로 돌아간다"로 느껴짐)
  if (restored && settings.loopOn && song) { const lr = loopRange(); if (lr) setTimeout(() => toast(`지난번 구간 반복이 켜져 있어요: ${lr.sa + 1}~${lr.sb + 1}마디 (반복 버튼으로 끌 수 있어요)`), 600); }
  try { const last = JSON.parse(localStorage.getItem(STORE_KEY + ":last") || "null"); if (restored && last && last.cloudId && current) current.cloudId = last.cloudId; } catch (e) {}
  Library.init();
  wakeOmrServer(); // 잠든 변환 서버를 미리 깨워 둔다
  if (matchMedia("(pointer: coarse)").matches) $("#hintKeys").hidden = true;
  requestAnimationFrame(frame);
}
window.GunbanNavi = { parseMusicXML, parseMIDI, jsonToMusicXML, buildSong, mxlToXml, get song() { return song; }, E, settings, ODE, seek, play, pause, userNoteOn, setMode, setHands, setLoopRange, setRate, Score, PosLog, loopRange, repeatOrder, Input, Mic, createMicAnalyzer };
window.loopRangeForTest = () => loopRange();
boot();
