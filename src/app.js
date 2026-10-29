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
  soundSet: "sal", steadyTempo: false, view: "all", labels: "sol", fingers: true, range: "fit", zoom: 1, scoreZoom: 0.8, kbBase: 60
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

function parseMusicXML(xmlText) {
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
  const measures = []; const tempos = []; const notes = [];
  const partInfo = [];
  parts.forEach((part, pi) => {
    let divisions = 1, transpose = 0, staves = 1, beats = 4, beatType = 4, qStart = 0;
    const clefs = {}; const ties = new Map();
    directKids(part, "measure").forEach((m, mi) => {
      let pos = 0, maxPos = 0, lastStart = 0;
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
          const key = pi + ":" + midi;
          if (tieTypes.includes("stop") && ties.has(key)) {
            const prev = ties.get(key);
            prev.durQ = Math.max(prev.durQ, qStart + start + d - prev.startQ);
            if (!tieTypes.includes("start")) ties.delete(key);
            continue;
          }
          const note = { midi, startQ: qStart + start, durQ: Math.max(d, 0.0625), staff, part: pi, measure: mi, finger: fing ? parseInt(fing) || null : null };
          notes.push(note);
          if (tieTypes.includes("start")) ties.set(key, note);
        }
      }
      const nominal = beats * 4 / beatType;
      let lenQ;
      if (pi === 0) {
        if (maxPos <= 1e-6) lenQ = nominal;
        else if (maxPos < nominal - 1e-6 && !(mi === 0 || m.getAttribute("implicit") === "yes")) lenQ = nominal;
        else lenQ = maxPos;
        const numAttr = m.getAttribute("number");
        measures.push({ num: /^\d+$/.test(numAttr || "") ? parseInt(numAttr) : mi + 1, startQ: qStart, lenQ, beats, beatType });
      } else {
        lenQ = measures[mi] ? measures[mi].lenQ : (maxPos || nominal);
      }
      qStart += lenQ;
    });
    partInfo.push({ staves, clefs });
  });
  assignHandsXML(notes, partInfo);
  return { title: title || "제목 없는 악보", composer, notes, measures, tempos };
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
function buildSong(raw, extra) {
  let tempos = (raw.tempos || []).filter((t) => t.bpm > 0 && isFinite(t.q)).sort((a, b) => a.q - b.q);
  if (settings.steadyTempo && tempos.length) tempos = [{ q: 0, bpm: tempos[0].bpm }];
  const dedup = []; tempos.forEach((t) => { if (dedup.length && Math.abs(dedup[dedup.length - 1].q - t.q) < 1e-6) dedup[dedup.length - 1] = t; else dedup.push(t); });
  tempos = dedup;
  if (!tempos.length || tempos[0].q > 1e-6) tempos.unshift({ q: 0, bpm: tempos.length ? tempos[0].bpm : 100 });
  let acc = 0; const segs = tempos.map((t, i) => { if (i) acc += (t.q - tempos[i - 1].q) * 60 / tempos[i - 1].bpm; return { q: t.q, bpm: t.bpm, sec: acc }; });
  const secAt = (q) => { let s = segs[0]; for (let i = 1; i < segs.length && segs[i].q <= q; i++) s = segs[i]; return s.sec + (q - s.q) * 60 / s.bpm; };
  const qAt = (sec) => { let s = segs[0]; for (let i = 1; i < segs.length && segs[i].sec <= sec; i++) s = segs[i]; return s.q + (sec - s.sec) * s.bpm / 60; };
  const bpmAt = (sec) => { let s = segs[0]; for (let i = 1; i < segs.length && segs[i].sec <= sec; i++) s = segs[i]; return s.bpm; };
  const all = raw.notes.filter((n) => n.midi >= 21 && n.midi <= 108).map((n, i) => ({ ...n, id: i, start: secAt(n.startQ), end: secAt(n.startQ + n.durQ) }));
  all.sort((a, b) => a.start - b.start || a.midi - b.midi || b.end - a.end);
  // 같은 순간 같은 건반이 두 번(두 성부에 겹쳐) 적혀 있으면 한 번만 친다 — 겹치면 소리가 끊기고 어색해짐
  const notes = [];
  for (const n of all) { const prev = notes[notes.length - 1]; if (prev && prev.midi === n.midi && Math.abs(prev.start - n.start) < 0.004) { prev.end = Math.max(prev.end, n.end); prev.durQ = Math.max(prev.durQ, n.durQ); if (!prev.finger) prev.finger = n.finger; continue; } notes.push(n); }
  const measures = raw.measures.map((m, i) => ({ ...m, idx: i, start: secAt(m.startQ), end: secAt(m.startQ + m.lenQ) }));
  const lastNoteEnd = notes.reduce((m, n) => Math.max(m, n.end), 0);
  const duration = Math.max(measures.length ? measures[measures.length - 1].end : 0, lastNoteEnd);
  const beats = [];
  measures.forEach((m) => { const bq = 4 / m.beatType; const cnt = Math.max(1, Math.round(m.lenQ / bq)); for (let k = 0; k < cnt; k++) beats.push({ sec: secAt(m.startQ + k * bq), down: k === 0 && m.lenQ >= m.beats * bq - 1e-6 }); });
  const steps = [];
  notes.forEach((n) => { const last = steps[steps.length - 1]; if (last && Math.abs(last.start - n.start) < 0.004) last.notes.push(n); else steps.push({ start: n.start, notes: [n], measure: n.measure }); });
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
  return { title: raw.title, composer: raw.composer || "", notes, measures, beats, steps, duration, lo, hi, maxDur, secAt, qAt, bpmAt, baseBpm: tempos[0].bpm, tempoMarks, ...extra };
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
  note(midi, vel = 0.7, dur = null) {
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
  noteCur: 0, beatCur: 0, waitIdx: 0, hits: new Set(),
  mistakes: 0, correct: 0, loops: 0, passMistakes: 0, finished: false
};
const pressed = new Map();   // midi -> {state:'ok'|'bad'|'free', t}
const userVoices = new Map();
const sounding = new Map();  // midi -> hand (재생 중인 음, 화면 표시용)

function practiceHas(hand) { return settings.hands === "both" || settings.hands === hand; }
function loopRange() {
  if (!song || !settings.loopOn || !song.measures.length) return null;
  const n = song.measures.length;
  const a = clamp(settings.loopA, 1, n) - 1, b = clamp(Math.max(settings.loopB, settings.loopA), 1, n) - 1;
  return { a, b, start: song.measures[a].start, end: song.measures[b].end };
}
function measureAt(sec) {
  if (!song || !song.measures.length) return 0;
  let lo = 0, hi = song.measures.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (song.measures[mid].start <= sec + 1e-6) lo = mid; else hi = mid - 1; }
  return lo;
}
function lowerBound(arr, sec, key = "start") { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m][key] < sec - 1e-6) lo = m + 1; else hi = m; } return lo; }
function requiredOf(step) { return step.notes.filter((n) => practiceHas(n.hand)); }

function seek(sec, keepPlaying) {
  if (!song) return;
  E.pos = clamp(sec, 0, song.duration);
  E.noteCur = lowerBound(song.notes, E.pos);
  E.beatCur = lowerBound(song.beats, E.pos, "sec");
  E.waitIdx = lowerBound(song.steps, E.pos);
  E.hits.clear(); E.waiting = false; E.finished = false; E.prevStep = null;
  sounding.clear();
  Score.sync(true);
  updateReadouts();
}
function nextWaitStep() {
  if (!song) return null;
  while (E.waitIdx < song.steps.length && requiredOf(song.steps[E.waitIdx]).length === 0) E.waitIdx++;
  return song.steps[E.waitIdx] || null;
}
// AI 초안에서는 이전 화음의 건반을 계속 누르고 있으면 다시 치지 않아도 맞은 것으로 본다(놓친 붙임줄 대비).
const heldKeys = new Set();
function stepSatisfied(st) { const lenient = current && current.kind === "ai"; return requiredOf(st).every((n) => E.hits.has(n.midi) || (lenient && heldKeys.has(n.midi) && E.prevStep && E.prevStep.has(n.midi))); }
function consumeStep() { const st = song.steps[E.waitIdx]; if (st) { E.correct += requiredOf(st).length; E.prevStep = new Set(requiredOf(st).map((n) => n.midi)); } E.waitIdx++; E.hits.clear(); updateStats(); }

function play() {
  if (!song) return;
  Sound.ensure();
  const lr = loopRange();
  if (E.finished || E.pos >= song.duration - 0.01) seek(lr ? lr.start : 0);
  if (lr && (E.pos < lr.start - 0.01 || E.pos >= lr.end - 0.01)) seek(lr.start);
  E.playing = true; Practice.start();
  if (settings.countIn) startCountIn();
  setPlayIcon();
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
  E.pos = target;
  if (!E.waiting && E.pos >= end - 1e-6) {
    if (lr) { onLoopDone(); seek(lr.start, true); if (settings.countIn) startCountIn(); }
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
function userNoteOn(midi, vel = 0.75, src = "screen") {
  if (midi < 21 || midi > 108) return;
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
        E.hits.add(midi); state = "ok";
        if (stepSatisfied(st)) { const wasWaiting = E.waiting; E.waiting = false; consumeStep(); if (wasWaiting) fireNotes(E.pos, E.pos + 1e-6); }
      } else if (!req.includes(midi)) { state = "bad"; E.mistakes++; E.passMistakes++; updateStats(); }
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
  if (e.code === "ArrowLeft") { e.preventDefault(); stepMeasure(-1); return; }
  if (e.code === "ArrowRight") { e.preventDefault(); stepMeasure(1); return; }
  if (e.code === "Home") { e.preventDefault(); restart(); return; }
  if (e.code === "KeyZ") { settings.kbBase = clamp(settings.kbBase - 12, 24, 96); saveSettings(); updateOct(); return; }
  if (e.code === "KeyX") { settings.kbBase = clamp(settings.kbBase + 12, 24, 96); saveSettings(); updateOct(); return; }
  if (e.code in KEYMAP) { e.preventDefault(); if (e.repeat || kbDown.has(e.code)) return; const m = settings.kbBase + KEYMAP[e.code]; kbDown.set(e.code, m); userNoteOn(m, 0.75, "kb"); }
});
window.addEventListener("keyup", (e) => { if (kbDown.has(e.code)) { userNoteOff(kbDown.get(e.code)); kbDown.delete(e.code); } });
window.addEventListener("blur", () => { kbDown.forEach((m) => userNoteOff(m)); kbDown.clear(); });
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
      st.classList.toggle("on", names.length > 0);
      if (names.length && settings.inputSound && !midiAccess._muted) { midiAccess._muted = true; settings.inputSound = false; $("#inputSound").checked = false; saveSettings(); toast("전자피아노 소리를 쓰도록 앱의 입력음은 껐어요"); }
    };
    midiAccess.onstatechange = bind; bind();
  } catch (e) { st.textContent = "MIDI를 쓸 수 없어요. 이 화면에서 막혀 있다면 내려받은 파일을 크롬으로 열어 주세요."; }
}
function onMidiMsg(ev) {
  const [s, d1, d2] = ev.data; const type = s & 0xf0;
  if (type === 0x90 && d2 > 0) userNoteOn(d1, d2 / 127, "midi");
  else if (type === 0x80 || (type === 0x90 && d2 === 0)) userNoteOff(d1);
}

// 마이크 (단음 인식, 자기상관 기반)
const Mic = {
  on: false, stream: null, an: null, buf: null, cur: null, cand: null, candN: 0, quiet: 0,
  async start() {
    const st = $("#micStatus");
    try {
      const ctx = Sound.ensure();
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const src = ctx.createMediaStreamSource(this.stream);
      this.an = ctx.createAnalyser(); this.an.fftSize = 2048; src.connect(this.an);
      this.buf = new Float32Array(this.an.fftSize); this.on = true;
      st.textContent = "듣는 중 · 헤드폰을 쓰면 더 잘 알아들어요"; st.classList.add("on"); $("#micBtn").textContent = "끄기";
    } catch (e) {
      st.textContent = "마이크를 쓸 수 없어요. 이 화면에서는 마이크가 막혀 있을 수 있어요. 내려받은 파일을 크롬으로 열어 주세요.";
    }
  },
  stop() { this.on = false; if (this.stream) this.stream.getTracks().forEach((t) => t.stop()); if (this.cur != null) userNoteOff(this.cur); this.cur = null; $("#micStatus").textContent = "한 번에 한 음만 알아들어요"; $("#micStatus").classList.remove("on"); $("#micBtn").textContent = "켜기"; },
  detect() {
    if (!this.on || (this.tick = (this.tick || 0) + 1) % 2) return;
    this.an.getFloatTimeDomainData(this.buf);
    const b = this.buf, N = b.length; let rms = 0; for (let i = 0; i < N; i++) rms += b[i] * b[i]; rms = Math.sqrt(rms / N);
    let midi = null;
    if (rms > 0.012) {
      const sr = Sound.ctx.sampleRate; const minLag = Math.floor(sr / 1400), maxLag = Math.floor(sr / 50);
      let best = 0, bestLag = -1; const corr = new Float32Array(maxLag + 2);
      for (let lag = minLag; lag <= maxLag; lag++) { let s = 0; for (let i = 0; i < N - lag; i += 2) s += b[i] * b[i + lag]; corr[lag] = s; }
      let peak = 0; for (let lag = minLag; lag <= maxLag; lag++) peak = Math.max(peak, corr[lag]);
      for (let lag = minLag + 1; lag < maxLag; lag++) { if (corr[lag] > peak * 0.88 && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) { bestLag = lag; best = corr[lag]; break; } }
      if (bestLag > 0 && best > 0) { const y1 = corr[bestLag - 1], y2 = corr[bestLag], y3 = corr[bestLag + 1]; const sh = (y3 - y1) / (2 * (2 * y2 - y1 - y3) || 1); const f = sr / (bestLag + sh); midi = Math.round(69 + 12 * Math.log2(f / 440)); }
    }
    if (midi != null && midi === this.cand) this.candN++; else { this.cand = midi; this.candN = 1; }
    if (midi != null && this.candN >= 2 && midi !== this.cur) { if (this.cur != null) userNoteOff(this.cur); this.cur = midi; const keep = settings.inputSound; settings.inputSound = false; userNoteOn(midi, 0.7, "mic"); settings.inputSound = keep; }
    if (midi == null) { if (++this.quiet > 3 && this.cur != null) { userNoteOff(this.cur); this.cur = null; } } else this.quiet = 0;
  }
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
    try {
      const osmd = new lib.OpenSheetMusicDisplay($("#osmd"), {
        autoResize: true, backend: "svg", drawTitle: true, drawSubtitle: false, drawComposer: true, drawCredits: false,
        drawPartNames: false, drawFingerings: true, followCursor: false, autoBeam: current && (current.kind === "ai" || current.kind === "demo"),
        cursorsOptions: [{ type: 0, color: "#17766b", alpha: 0.35, follow: false }]
      });
      this.osmd = osmd;
      await osmd.load(xml);
      if (token !== this.token) return;
      osmd.zoom = settings.scoreZoom;
      osmd.render();
      this.note("");
      this.buildSteps();
      osmd.cursor.show();
      this.ready = true; this.idx = -1;
      this.sync(true); this.drawShades();
    } catch (e) {
      console.warn("OSMD", e);
      this.note("이 악보는 그림으로 그리지 못했어요. 떨어지는 음표와 건반으로 연습할 수 있어요.");
    }
  },
  buildSteps() {
    const c = this.osmd.cursor; c.reset(); const it = c.Iterator || c.iterator; const steps = []; let guard = 0;
    while (it && !it.EndReached && guard++ < 20000) {
      const mi = it.CurrentMeasureIndex;
      const meas = it.CurrentMeasure;
      const ts = (it.CurrentSourceTimestamp || it.currentTimeStamp).RealValue;
      const ms = meas && meas.AbsoluteTimestamp ? meas.AbsoluteTimestamp.RealValue : ts;
      if (song && song.measures[mi]) {
        const qq = song.measures[mi].startQ + (ts - ms) * 4;
        if (steps.length && qq < steps[steps.length - 1].q - 1e-6) break;
        steps.push({ q: qq, mi });
      }
      it.moveToNext();
    }
    this.steps = steps; c.reset();
  },
  sync(force) {
    if (!this.ready || !song || !this.steps.length) return;
    const qNow = song.qAt(E.pos) + 1e-4;
    let lo = 0, hi = this.steps.length - 1;
    if (this.steps[0].q > qNow) hi = 0;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.steps[m].q <= qNow) lo = m; else hi = m - 1; }
    const target = lo;
    if (target === this.idx && !force) return;
    try {
      const c = this.osmd.cursor;
      if (target < this.idx || this.idx < 0) { c.reset(); this.idx = 0; }
      const it = c.Iterator || c.iterator; // reset()은 iterator를 새로 만들므로 reset 뒤에 가져온다
      while (this.idx < target && !it.EndReached) { it.moveToNext(); this.idx++; }
      c.update();
      this.scrollToCursor(force);
    } catch (e) { console.warn(e); }
  },
  scrollToCursor(force) {
    const el = this.osmd && this.osmd.cursor && this.osmd.cursor.cursorElement; if (!el) return;
    const sc = $("#scoreScroll"); const top = el.offsetTop, h = el.offsetHeight || 80;
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
    for (let i = lr.a; i <= lr.b; i++) { const b = this.measureBox(i); if (!b) continue; const d = document.createElement("div"); d.className = "loop-shade"; Object.assign(d.style, { left: b.x - 2 + "px", top: b.y - 6 + "px", width: b.w + 4 + "px", height: b.h + 12 + "px" }); $("#osmd").appendChild(d); }
  },
  measureFromPoint(x, y) {
    if (!this.ready || !song) return -1;
    for (let i = 0; i < song.measures.length; i++) { const b = this.measureBox(i); if (b && x >= b.x && x <= b.x + b.w && y >= b.y - 20 && y <= b.y + b.h + 20) return i; }
    return -1;
  },
  setZoom(z) { if (!this.ready) return; try { this.osmd.zoom = z; this.osmd.render(); this.idx = -1; this.sync(true); this.drawShades(); } catch (e) {} }
};
$("#osmd").addEventListener("click", (e) => {
  const host = $("#osmd").getBoundingClientRect();
  const mi = Score.measureFromPoint(e.clientX - host.left, e.clientY - host.top);
  if (mi >= 0) { seek(song.measures[mi].start); toast(`${mi + 1}마디로 이동했어요`); }
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
function roundRect(ctx, x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
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
    if (song.flagged && song.flagged.has(m.idx)) { const y1 = yOf(m.end), y2 = yOf(m.start); fctx.fillStyle = "rgba(240,170,40,0.10)"; fctx.fillRect(0, y1, W, y2 - y1); fctx.fillStyle = "rgba(240,170,40,0.9)"; fctx.fillRect(0, y1, 4, y2 - y1); }
    if (m.start < bottom) return;
    const y = yOf(m.start); fctx.fillStyle = song.flagged && song.flagged.has(m.idx) ? "#f0aa28" : colors["--stage-text"]; fctx.fillText(String(m.idx + 1) + (song.flagged && song.flagged.has(m.idx) ? " ?" : ""), 8, y - 4);
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
  const whiteH = H - 4, blackH = whiteH * 0.62;
  const fam = colors["--f-body"];
  const pressColor = (m) => { const p = pressed.get(m); if (!p) return null; if (p.up && now - p.up > 160) { pressed.delete(m); return null; } return p.state === "ok" ? colors["--ok"] : p.state === "bad" ? colors["--bad"] : "#9fb0c8"; };
  // 흰건반
  kb.whites.forEach((m, i) => {
    const g = keyGeom(m, W);
    const pc = pressColor(m); const a = act.get(m); const u = upMap.get(m);
    kctx.fillStyle = pc || (a && (settings.mode !== "wait" || !practiceHas(a.hand)) ? handColor(a.hand) : "#f7f7f4");
    roundRect(kctx, g.x + 1, 0, g.w - 2, whiteH, 5); kctx.fill();
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
    kctx.fillStyle = pc || (a && (settings.mode !== "wait" || !practiceHas(a.hand)) ? handColor(a.hand) : "#1d222c");
    roundRect(kctx, g.x, 0, g.w, blackH, 3); kctx.fill();
    if (u && !pc) { kctx.strokeStyle = handColor(u.hand); kctx.lineWidth = 3; roundRect(kctx, g.x + 1.5, 1.5, g.w - 3, blackH - 3, 3); kctx.stroke(); }
    if (u && settings.labels !== "off" && g.w > 9) { kctx.fillStyle = "#fff"; kctx.textAlign = "center"; kctx.font = `600 ${Math.min(11, g.w * 0.5)}px ${fam}`; kctx.fillText(noteName(m, settings.labels), g.x + g.w / 2, blackH - 8); }
    if (u && settings.fingers && u.finger) badge(kctx, g.x + g.w / 2, blackH + 14, String(u.finger), handColor(u.hand), fam);
  }
  kctx.textAlign = "left";
}
function badge(ctx, x, y, t, col, fam) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.fill(); ctx.fillStyle = "#0b0f17"; ctx.textAlign = "center"; ctx.font = `700 11px ${fam}`; ctx.fillText(t, x, y + 4); }

// 건반 터치/클릭 입력
const ptrNotes = new Map();
function keyFromPoint(x, y) {
  const r = keysC.getBoundingClientRect(); const W = r.width, H = r.height; const lx = x - r.left, ly = y - r.top; const blackH = (H - 4) * 0.62;
  if (ly < blackH) for (let m = kb.lo; m <= kb.hi; m++) { if (!isBlack(m)) continue; const g = keyGeom(m, W); if (lx >= g.x && lx <= g.x + g.w) return m; }
  const i = Math.floor(lx / (W / kb.whites.length)); return kb.whites[clamp(i, 0, kb.whites.length - 1)];
}
keysC.addEventListener("pointerdown", (e) => { e.preventDefault(); keysC.setPointerCapture(e.pointerId); const m = keyFromPoint(e.clientX, e.clientY); ptrNotes.set(e.pointerId, m); userNoteOn(m, 0.75, "screen"); });
keysC.addEventListener("pointermove", (e) => { if (!ptrNotes.has(e.pointerId)) return; const m = keyFromPoint(e.clientX, e.clientY); const old = ptrNotes.get(e.pointerId); if (m !== old) { userNoteOff(old); ptrNotes.set(e.pointerId, m); userNoteOn(m, 0.7, "screen"); } });
const ptrUp = (e) => { if (!ptrNotes.has(e.pointerId)) return; userNoteOff(ptrNotes.get(e.pointerId)); ptrNotes.delete(e.pointerId); };
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
function frame(ts) {
  const dt = Math.min(0.1, (ts - lastTs) / 1000); lastTs = ts;
  if (song && E.playing) {
    if (E.countIn > 0) {
      E.countIn -= dt; const left = Math.ceil(E.countIn / E.countBeat);
      const cd = $("#countdown"); cd.hidden = E.countIn <= 0; cd.textContent = left > 0 ? String(E.countTotal - left + 1) : "";
    } else if (!E.waiting) advance(dt * settings.rate);
  }
  Mic.detect();
  drawFall(); drawKeys();
  Score.sync(false);
  const mi = song ? measureAt(E.pos) : 0; if (mi !== lastMeasure) { lastMeasure = mi; updateReadouts(); }
  updatePrompt();
  requestAnimationFrame(frame);
}

/* ============================================================
   13) UI 바인딩
   ============================================================ */
let toastT = 0;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2600); }
function setPlayIcon() { $("#playIcon").innerHTML = E.playing ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>'; $("#playBtn").setAttribute("aria-label", E.playing ? "일시정지" : "재생"); }
function updateReadouts() {
  if (!song) return; const mi = measureAt(E.pos);
  $("#measureReadout").innerHTML = `마디 <b>${mi + 1}</b> / ${song.measures.length}`;
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
function setMode(m) {
  settings.mode = m; $$("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
  $("#modeHelp").textContent = m === "wait" ? "따라치기: 맞는 건반을 누를 때까지 음악이 기다려 줘요. 화면 건반, PC 키보드, 전자피아노로 칠 수 있어요." : "듣기: 곡을 들으며 어떤 건반을 누르는지 봐요.";
  E.waitIdx = lowerBound(song ? song.steps : [], E.pos); E.hits.clear(); E.waiting = false; saveSettings();
}
function setHands(h) { settings.hands = h; $$("[data-hands]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.hands === h))); if (song) { E.waitIdx = lowerBound(song.steps, E.pos); E.hits.clear(); E.waiting = false; } saveSettings(); }
function setLoop(on) {
  settings.loopOn = on; $("#loopOn").checked = on; $("#loopBtn").setAttribute("aria-pressed", String(on));
  if (song) { const n = song.measures.length; settings.loopA = clamp(parseInt($("#loopA").value) || 1, 1, n); settings.loopB = clamp(Math.max(parseInt($("#loopB").value) || 1, settings.loopA), 1, n); $("#loopA").value = settings.loopA; $("#loopB").value = settings.loopB; }
  saveSettings(); Score.drawShades();
  const lr = loopRange(); if (lr && (E.pos < lr.start || E.pos >= lr.end)) seek(lr.start);
}
function setLoopRange(a, b) { $("#loopA").value = a; $("#loopB").value = b; setLoop(true); toast(a === b ? `${a}마디를 반복해요` : `${a}~${b}마디를 반복해요`); }
function stepMeasure(d) { if (!song) return; const mi = clamp(measureAt(E.pos) + d, 0, song.measures.length - 1); seek(song.measures[mi].start); }
function restart() { if (!song) return; const lr = loopRange(); seek(lr ? lr.start : 0); E.mistakes = 0; E.correct = 0; E.loops = 0; E.passMistakes = 0; updateStats(); }
function applyView() { const app = $("#app"); app.classList.toggle("view-keys", settings.view === "keys"); app.classList.toggle("view-score", settings.view === "score"); setTimeout(() => { if (Score.ready) { Score.idx = -1; Score.sync(true); } }, 50); }

$("#playBtn").onclick = togglePlay;
$("#restartBtn").onclick = restart;
$("#prevBtn").onclick = () => stepMeasure(-1);
$("#nextBtn").onclick = () => stepMeasure(1);
$("#speed").oninput = (e) => setRate(parseInt(e.target.value) / 100);
$$("[data-mode]").forEach((b) => b.onclick = () => setMode(b.dataset.mode));
$$("[data-hands]").forEach((b) => b.onclick = () => setHands(b.dataset.hands));
$("#loopBtn").onclick = () => {
  if (!settings.loopOn && song) { const mi = measureAt(E.pos) + 1; if (mi < settings.loopA || mi > settings.loopB) { $("#loopA").value = mi; $("#loopB").value = Math.min(song.measures.length, mi + 1); } }
  setLoop(!settings.loopOn);
  toast(settings.loopOn ? `${settings.loopA}~${settings.loopB}마디 반복 (설정에서 바꿀 수 있어요)` : "구간 반복을 껐어요");
};
$("#loopOn").onchange = (e) => setLoop(e.target.checked);
$("#loopA").onchange = () => setLoop(settings.loopOn);
$("#loopB").onchange = () => setLoop(settings.loopOn);
$("#loopHere").onclick = () => { if (!song) return; const mi = measureAt(E.pos) + 1; setLoopRange(mi, mi); };
$("#loopHere2").onclick = () => { if (!song) return; const mi = measureAt(E.pos) + 1; setLoopRange(mi, Math.min(song.measures.length, mi + 1)); };
$("#loopAll").onclick = () => { if (!song) return; setLoopRange(1, song.measures.length); };
$("#metroBtn").onclick = () => { settings.metro = !settings.metro; $("#metroBtn").setAttribute("aria-pressed", String(settings.metro)); saveSettings(); };
const bindSwitch = (id, key, after) => { const el = $("#" + id); el.checked = !!settings[key]; el.onchange = () => { settings[key] = el.checked; saveSettings(); after && after(); }; };
bindSwitch("autoSpeed", "autoSpeed"); bindSwitch("steadyTempo", "steadyTempo", () => rebuildTiming()); bindSwitch("accomp", "accomp"); bindSwitch("guide", "guide"); bindSwitch("countIn", "countIn"); bindSwitch("inputSound", "inputSound"); bindSwitch("fingers", "fingers");
$("#volume").value = Math.round(settings.volume * 100); $("#volume").oninput = (e) => { settings.volume = e.target.value / 100; Sound.setVolume(settings.volume); saveSettings(); };
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
  const go = (mi, tip) => { setLoopRange(mi + 1, mi + 1); seek(song.measures[mi].start); toast(`${mi + 1}마디: ${tip}`); };
  if (hasFlags) chips("확인이 필요한 마디:", [...song.flagged.keys()].sort((a, b) => a - b).map((mi) => [mi, song.flagged.get(mi).join(" · ")]), "", go);
  if (fixed.length) chips("대조하며 고친 마디:", fixed.filter((f) => song && f.m < song.measures.length).map((f) => [f.m, f.note]), "fixed", go);
}
function setSong(raw, meta) {
  pause();
  const prevCloudId = current && current.cloudId;
  if (meta.persist !== false && settings.loopOn && !meta.keepLoop) { settings.loopOn = false; $("#loopOn").checked = false; $("#loopBtn").setAttribute("aria-pressed", "false"); saveSettings(); }
  song = buildSong(raw, {});
  current = { xml: meta.xml || null, kind: meta.kind, origImages: meta.origImages || [], name: meta.name || "", flags: meta.flags || [], report: meta.report || null, fixed: meta.fixed || [], raw, meta, ai: meta.ai || null, cloudId: meta.cloudId || (meta.sameSong ? prevCloudId : null) || null };
  song.flagged = new Map(); current.flags.forEach((f) => { if (f.m < song.measures.length) song.flagged.set(f.m, (song.flagged.get(f.m) || []).concat(f.issues)); });
  renderFlags(); renderTempos();
  $("#songTitle").textContent = song.title || meta.name || "제목 없는 악보";
  const kindBadge = { musicxml: "MusicXML", midi: "MIDI", demo: "예제 곡", ai: "AI 초안", omr: "자동 변환" }[meta.kind] || meta.kind;
  $("#songMeta").innerHTML = `<span class="badge${meta.kind === "ai" ? " ai" : ""}">${kindBadge}</span>${song.composer ? `<span>${esc(song.composer)}</span>` : ""}<span>${song.measures.length}마디 · ♩=${Math.round(song.baseBpm)}</span><span>오른손 ${song.notes.filter((n) => n.hand === "R").length} · 왼손 ${song.notes.filter((n) => n.hand === "L").length}음</span>`;
  $("#aiBanner").hidden = meta.kind !== "ai";
  $("#origBtn").hidden = !(meta.origImages && meta.origImages.length);
  $("#recheckBtn").hidden = !(meta.ai && meta.ai.json);
  const ov = $("#origView"); ov.hidden = true; ov.innerHTML = ""; $("#origBtn").textContent = "원본 보기";
  current.origImages.forEach((u) => { const im = document.createElement("img"); im.src = u; im.alt = "원본 악보"; ov.appendChild(im); });
  $("#saveXmlBtn").hidden = !current.xml;
  const n = song.measures.length; $("#loopA").max = n; $("#loopB").max = n;
  if (settings.loopA > n) settings.loopA = 1; if (settings.loopB > n) settings.loopB = Math.min(n, 4);
  $("#loopA").value = settings.loopA; $("#loopB").value = settings.loopB;
  E.mistakes = 0; E.correct = 0; E.loops = 0; E.passMistakes = 0; updateStats();
  computeRange(); setRate(settings.rate);
  seek(loopRange() ? loopRange().start : 0);
  Score.show(current.xml);
  try { if (meta.persist !== false) localStorage.setItem(STORE_KEY + ":last", JSON.stringify({ kind: meta.kind, name: meta.name || "", xml: current.xml, midiB64: meta.midiB64 || null, flags: current.flags, report: current.report, fixed: current.fixed, ai: current.ai ? { json: current.ai.json, ranges: current.ai.ranges } : null, cloudId: current.cloudId })); } catch (e) {}
  if (meta.persist !== false && meta.kind !== "demo" && !meta.fromLibrary) Library.autoSave(meta.file || null, !!meta.sameSong);
  if ($("#libModal") && !$("#libModal").hidden) renderLibrary();
}
// 빠르기 표: 악보의 메트로놈 표시를 보여 주고 고칠 수 있게 한다
function renderTempos() {
  const box = $("#tempoList"); if (!box || !song) return; box.innerHTML = "";
  if (!current.raw.tempos || !current.raw.tempos.length) current.raw.tempos = [{ q: 0, bpm: song.baseBpm }];
  const list = current.raw.tempos.slice().sort((a, b) => a.q - b.q);
  list.forEach((t) => {
    let mi = 0; while (mi + 1 < song.measures.length && song.measures[mi + 1].startQ <= t.q + 1e-6) mi++;
    const row = document.createElement("div"); row.className = "row";
    const lab = document.createElement("button"); lab.type = "button"; lab.className = "btn small"; lab.textContent = `${mi + 1}마디`; lab.title = "이 마디로 이동"; lab.onclick = () => seek(song.measures[mi].start);
    const inp = document.createElement("input"); inp.type = "number"; inp.className = "num"; inp.min = 20; inp.max = 300; inp.value = Math.round(t.bpm); inp.setAttribute("aria-label", `${mi + 1}마디 빠르기`);
    inp.onchange = () => { const v = clamp(parseFloat(inp.value) || t.bpm, 20, 300); t.bpm = v; inp.value = Math.round(v); rebuildTiming(); toast(`${mi + 1}마디부터 ♩=${Math.round(v)}`); };
    const w = document.createElement("span"); w.append("♩ = ", inp); row.append(lab, w); box.appendChild(row);
  });
}
function rebuildTiming() {
  if (!song || !current.raw) return;
  const mi = measureAt(E.pos); const flagged = song.flagged; const wasPlaying = E.playing; pause();
  song = buildSong(current.raw, {}); song.flagged = flagged;
  setRate(settings.rate); seek(song.measures[mi] ? song.measures[mi].start : 0);
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
    if (ext === "pdf" || file.type === "application/pdf" || file.type.startsWith("image/") || /^(png|jpe?g|webp|gif|bmp|heic)$/.test(ext)) { openAIDialog(file); return; }
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
const CLOUD_CHUNK = 300000; // 문서 하나 1MB 제한 → 큰 글자 데이터는 30만 자씩 나눠 저장
async function firebaseBackend(cfg) {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;
  const [fa, au, fs] = await Promise.all([import(base + "firebase-app.js"), import(base + "firebase-auth.js"), import(base + "firebase-firestore.js")]);
  const app = fa.initializeApp(cfg); const auth = au.getAuth(app); const db = fs.getFirestore(app);
  try { await au.getRedirectResult(auth); } catch (e) {}
  return {
    onAuth: (cb) => au.onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid, name: u.displayName || "", email: u.email || "", photo: u.photoURL || "" } : null)),
    async signIn() {
      const p = new au.GoogleAuthProvider(); p.setCustomParameters({ prompt: "select_account" }); // 매번 계정 고르기 창
      try { await au.signInWithPopup(auth, p); }
      catch (e) { if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) await au.signInWithRedirect(auth, p); else throw e; }
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
    if (!this.available) return;
    this.be.onAuth((u) => { this.user = u; renderAccount(); });
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
    const sp = this.songPath(id); const d = await this.be.get(sp); if (!d) throw new Error("악보를 찾지 못했어요");
    const big = d.big || {};
    const [xml, midi, ai] = await Promise.all([this.getBig(sp, "xml", big.xml), this.getBig(sp, "midi", big.midi), this.getBig(sp, "ai", big.ai)]);
    let raw;
    if (xml) raw = parseMusicXML(xml); else if (midi) { raw = parseMIDI(unb64(midi)); raw.title = d.title; } else throw new Error("악보 내용이 비어 있어요");
    if (Array.isArray(d.tempos) && d.tempos.length) raw.tempos = d.tempos.map((t) => ({ ...t }));
    const aiObj = ai ? JSON.parse(ai) : null;
    setSong(raw, { kind: d.kind, xml: xml || null, name: d.name, midiB64: midi || null, flags: d.flags || [], report: d.report || null, fixed: d.fixed || [], ai: aiObj, cloudId: id, fromLibrary: true });
    current.hasCloudOriginal = !!(d.original && big.orig);
    toast(d.kind === "omr" && !(d.tempos && d.tempos.length) ? `'${d.title}'을(를) 열었어요. 자동 변환은 빠르기표를 읽지 못하니, 설정 → 빠르기에서 악보의 ♩= 숫자로 고쳐 주세요.` : `'${d.title}'을(를) 열었어요`);
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
  start() { this.snap = { t: performance.now(), c: E.correct, m: E.mistakes, l: E.loops, from: song ? measureAt(E.pos) + 1 : 1 }; },
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
  $("#loginBtn").hidden = !!u; $("#libBtn").hidden = !u;
  if (u) $("#libBtnName").textContent = (u.name || u.email || "내 악보함").split(" ")[0];
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
$("#loginBtn").onclick = async () => { try { await Library.be.signIn(); } catch (e) { toast(e && e.code === "auth/popup-closed-by-user" ? "로그인을 취소했어요" : "로그인하지 못했어요: " + (e && (e.code || e.message) || "")); } };
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
  if ((!sample || !caps || !caps.images) && Library.available) { showOmrOption(file); return; }
  if (!sample || !caps || !caps.images) {
    desc.innerHTML = "이 화면에서는 AI 악보 읽기를 쓸 수 없어요. PDF·사진 악보는 이렇게 바꿔서 올려 주세요.";
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
// 무료 자동 변환(Audiveris) 안내 창 — AI 토큰을 쓰지 않는다
function showOmrOption(file) {
  const go = $("#aiGo"), desc = $("#aiDesc"), st = $("#aiStatus"), thumbs = $("#aiThumbs");
  $("#aiTitle").textContent = "PDF·사진 악보 자동 변환";
  desc.textContent = "악보 인식 프로그램(Audiveris)이 GitHub 무료 서버에서 PDF·사진을 MusicXML로 바꿔 '내 악보함'에 넣어 드려요. AI 토큰을 쓰지 않고, 깨끗한 인쇄 악보는 음·박자·붙임줄을 정확하게 읽어요. 보통 2~10분 걸려요. 빠르기표(♩=)는 읽지 못해서 열어 본 뒤 직접 고쳐 주세요.";
  thumbs.innerHTML = ""; st.textContent = `${file.name} · ${(file.size / 1024).toFixed(0)}KB`;
  go.hidden = false; go.disabled = false;
  if (!Library.user) {
    go.textContent = "구글로 로그인하고 계속";
    go.onclick = async () => { try { await Library.be.signIn(); } catch (e) { st.textContent = "로그인하지 못했어요"; return; } setTimeout(() => showOmrOption(file), 300); };
    return;
  }
  go.textContent = "무료 자동 변환 요청";
  go.onclick = async () => {
    go.disabled = true; st.textContent = "원본을 계정에 올리는 중…";
    try {
      await Library.submitOmr(file);
      st.innerHTML = ""; st.append("요청했어요. 진행 상황은 '내 악보함'에서 볼 수 있고, 끝나면 알려 드려요. 기다리기 싫으면 ");
      const a = document.createElement("a"); a.href = OMR_ACTIONS_URL; a.target = "_blank"; a.rel = "noopener"; a.textContent = "GitHub에서 바로 시작(Run workflow)"; st.append(a, "을 누르세요.");
      go.textContent = "내 악보함 열기"; go.disabled = false; go.onclick = () => { $("#aiModal").hidden = true; $("#libModal").hidden = false; renderLibrary(); };
    } catch (e) { st.textContent = e.message || "요청하지 못했어요"; go.disabled = false; }
  };
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
    if (song.measures[keepPos]) seek(song.measures[keepPos].start);
    toast(changed ? `고쳤어요 — ${notes.slice(0, 2).join(" / ")}` : res.verdicts[mi - rg.start] === "match" ? `${mi + 1}마디는 원본과 같아요. 그래도 이상하면 그 부분의 빠르기·손가락을 확인해 보세요.` : `${mi + 1}마디: 다를 수 있지만 확실히 고치지 못했어요`);
  } catch (e) {
    toast(e && e.code === "not_granted" ? "AI 사용을 허용해야 다시 확인할 수 있어요." : e && e.code === "rate_limited" ? "요청이 많아요. 잠시 뒤 다시 눌러 주세요." : "다시 확인하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
  } finally { recheckBusy = false; btn.disabled = false; btn.textContent = "지금 마디 다시 확인"; }
}
$("#recheckBtn") && ($("#recheckBtn").onclick = () => {
  if (!song) return; const mi = measureAt(E.pos);
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
      if (last.xml) { const raw = parseMusicXML(last.xml); if (Array.isArray(last.tempos) && last.tempos.length) raw.tempos = last.tempos; setSong(raw, { kind: last.kind, xml: last.xml, name: last.name, flags: last.flags || [], report: last.report || null, fixed: last.fixed || [], ai: last.ai || null, persist: false }); restored = true; }
      else if (last.midiB64) { const raw = parseMIDI(unb64(last.midiB64)); raw.title = (last.name || "").replace(/\.[^.]+$/, ""); setSong(raw, { kind: "midi", name: last.name, persist: false }); restored = true; }
    }
  } catch (e) {}
  if (!restored) loadDemo();
  try { const last = JSON.parse(localStorage.getItem(STORE_KEY + ":last") || "null"); if (restored && last && last.cloudId && current) current.cloudId = last.cloudId; } catch (e) {}
  Library.init();
  if (matchMedia("(pointer: coarse)").matches) $("#hintKeys").hidden = true;
  requestAnimationFrame(frame);
}
window.GunbanNavi = { parseMusicXML, parseMIDI, jsonToMusicXML, buildSong, mxlToXml, get song() { return song; }, E, settings, ODE, seek, play, pause, userNoteOn, setMode, setHands, setLoopRange, setRate, Score };
boot();
