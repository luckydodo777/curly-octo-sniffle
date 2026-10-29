// 건반 내비 자동 테스트 — 사용법: (한 번만) npm i playwright && npx playwright install chromium
//                                  python build.py && node tests/run_all.js
// 외부 네트워크(CDN·폰트)는 막고 테스트한다. 악보 그림(OSMD)과 PDF(pdf.js)는 CDN이 필요해서 여기서는 빠진다.
const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs');
const PAGE = 'file://' + path.resolve(__dirname, '../dist/건반내비.html');
const FIX = (f) => path.resolve(__dirname, 'fixtures', f);
let failed = 0; const ok = (name, cond, info) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`); if (!cond) failed++; };

async function openPage(browser, opts = {}) {
  const p = await browser.newPage({ viewport: opts.viewport || { width: 1300, height: 850 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  if (opts.mockAI) await p.addInitScript(opts.mockAI);
  await p.route('**/*', (r) => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await p.goto(PAGE); await p.waitForTimeout(1200);
  return { p, errs };
}

(async () => {
  const browser = await chromium.launch();

  // 1) 예제 곡·재생·따라치기·구간 반복
  { const { p, errs } = await openPage(browser);
    const d = await p.evaluate(() => { const s = GunbanNavi.song; return { notes: s.notes.length, measures: s.measures.length, R: s.notes.filter((n) => n.hand === 'R').length }; });
    ok('예제 곡 불러오기 (80음, 16마디)', d.notes === 80 && d.measures === 16, JSON.stringify(d));
    const w = await p.evaluate(async () => { const G = GunbanNavi; G.settings.countIn = false; G.setMode('wait'); G.setHands('R'); G.setRate(1.5); G.seek(0); G.play(); await new Promise((r) => setTimeout(r, 400)); const w1 = G.E.waiting; G.userNoteOn(61); const miss = G.E.mistakes; const st = G.song.steps[G.E.waitIdx]; st.notes.filter((n) => n.hand === 'R').forEach((n) => G.userNoteOn(n.midi)); await new Promise((r) => setTimeout(r, 100)); return { w1, miss, idx: G.E.waitIdx }; });
    ok('따라치기: 맞는 음까지 기다리고 틀린 음을 센다', w.w1 && w.miss === 1 && w.idx >= 1, JSON.stringify(w));
    const l = await p.evaluate(async () => { const G = GunbanNavi; G.pause(); G.setMode('listen'); G.setHands('both'); G.setLoopRange(2, 2); G.play(); await new Promise((r) => setTimeout(r, 3200)); const r = { loops: G.E.loops }; G.pause(); return r; });
    ok('구간 반복이 돈다', l.loops >= 1, JSON.stringify(l));
    for (const [f, check] of [['test.musicxml', (s) => s.measures.length === 3 && s.notes.some((n) => n.midi === 66 && Math.abs(n.durQ - 2) < 1e-6)], ['test.mxl', (s) => s.measures.length === 3], ['test.mid', (s) => s.notes.length === 8 && s.baseBpm === 120]]) {
      await p.setInputFiles('#fileInput', FIX(f)); await p.waitForTimeout(500);
      const s = await p.evaluate(() => { const s = GunbanNavi.song; return { measures: s.measures, notes: s.notes, baseBpm: s.baseBpm }; });
      ok(`파일 불러오기: ${f}`, check(s));
    }
    ok('페이지 오류 없음', errs.length === 0, errs.join(' | ')); await p.close(); }

  // 2) AI 결과 → MusicXML 변환·박자 복구·잇단음·8va·템포 변화
  { const { p } = await openPage(browser);
    const r = await p.evaluate(() => {
      const q = (p, d, x) => Object.assign({ p, d }, x || {});
      const j = { title: 't', bpm: 66, time: [3, 4], fifths: -4, measures: [
        { rh: [q(['C5', 'Eb5'], 'h'), q('Ab4', 'q', { tie: true })], lh: [q('Ab2', 'e'), q('Eb3', 'e'), q('C4', 'h')] },
        { rh: [q('Ab4', 'q'), ...[67, 65, 63, 61, 60].map(() => q('G4', 's', { tup: [5, 4] })), q('Bb3', 'q')], lh: [q('Db3', 'e3'), q('Ab3', 'e3'), q('F4', 'e3'), q('r', 'h')] },
        { bpm: 70, rh8va: 1, rh: [q('C5', 'h'), q('D5', 'h')], lh: [q('C4', 'h.')] },
        { rh: [q('C5', 'q')], lh: [q('C3', 'h.')] },
        { rh: [q('Ab4', 'h.')], lh: [q('C3', 'h.')] }] };
      const flags = repairScore(j); const song = buildSong(parseMusicXML(jsonToMusicXML(j)), {});
      return { flags: flags.map((f) => f.m), tie: song.notes.find((n) => n.midi === 68 && n.startQ === 2), tupEnd: song.notes.filter((n) => n.hand === 'R' && n.startQ >= 4 && n.startQ < 5).map((n) => +n.durQ.toFixed(3)), oct: song.notes.some((n) => n.midi === 84), tempos: song.tempoMarks.map((t) => t.bpm) };
    });
    ok('박자 넘침(3마디)·모자람(4마디) 표시', JSON.stringify(r.flags) === '[2,3]', JSON.stringify(r.flags));
    ok('마디를 넘는 붙임줄을 한 음으로 합침', r.tie && Math.abs(r.tie.durQ - 2) < 1e-6);
    ok('5잇단음 길이 0.2박', r.tupEnd.length === 5 && r.tupEnd.every((d) => d === 0.2), JSON.stringify(r.tupEnd));
    ok('8va 적용 (C5→C6)', r.oct); ok('템포 변화 66→70', JSON.stringify(r.tempos) === '[66,70]', JSON.stringify(r.tempos));
    await p.close(); }

  // 3) 악보 이미지 → 줄(큰보표)·마디선 찾기 (합성 이미지)
  { const { p } = await openPage(browser);
    const b64 = fs.readFileSync(FIX('synthetic_page.png')).toString('base64');
    const r = await p.evaluate(async (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); const pages = await fileToPages(new File([u], 'page.png', { type: 'image/png' })); const sys = await pagesToSystems(pages); return { w: pages[0].canvas.width, systems: sys.length, parts: sys.map((s) => s.images.length) }; }, b64);
    ok('업스케일(3000px) + 줄 4개 검출', r.w === 3000 && r.systems === 4, JSON.stringify(r));
    await p.close(); }

  // 4) AI 읽기 전체 흐름 (가짜 AI) + 원본 대조 + "지금 마디 다시 확인"
  { const mock = () => {
      const calls = []; window.__calls = calls;
      const dummy = () => ({ rh: [{ p: ['C5', 'E5'], d: 'q' }, { p: 'D5', d: 'q' }, { p: 'E5', d: 'h' }], lh: [{ p: 'C3', d: 'w' }] });
      window.GUNBAN_AI_ADAPTER = {
        limits: async () => ({ images: { maxCount: 5 } }),
        json: async (input, opts) => {
          const verify = /proofreading/.test(input); const k = calls.filter((c) => !c.verify).length + (verify ? 0 : 1);
          calls.push({ verify, retry: /previous attempt/.test(input), focus: /sounds wrong/.test(input) });
          await new Promise((r) => setTimeout(r, 10));
          if (verify) { const ms = JSON.parse(input.match(/is i=0\):\n(.*)\n/)[1]); return { measures: ms.map((m, i) => (i === 1 ? { i, match: false, problems: '리듬이 다름', fixed: { rh: [{ p: 'C5', d: 'h' }, { p: 'E5', d: 'h' }], lh: [{ p: 'C3', d: 'w' }] } } : { i, match: true })) }; }
          if (k === 2) return { measures: [{ rh: [{ p: 'C5', d: 'w' }, { p: 'D5', d: 'q' }], lh: [{ p: 'C3', d: 'w' }] }, dummy()] };
          return { title: k === 1 ? 'TEST' : null, measures: [{ ...dummy(), bpm: k === 1 ? 70 : undefined, time: k === 1 ? [4, 4] : undefined }, dummy(), dummy()] };
        } };
    };
    const { p, errs } = await openPage(browser, { mockAI: mock });
    await p.setInputFiles('#fileInput', FIX('synthetic_page.png'));
    await p.waitForSelector('#aiGo:not([disabled])', { timeout: 60000 }); await p.click('#aiGo');
    await p.waitForFunction(() => document.querySelector('#aiModal').hidden, null, { timeout: 60000 }); await p.waitForTimeout(500);
    const r = await p.evaluate(() => ({ calls: window.__calls, m: GunbanNavi.song.measures.length, banner: document.querySelector('#flagList').innerText }));
    ok('줄마다 읽기 + 박자 틀린 줄 다시 읽기', r.calls.some((c) => c.retry), `${r.calls.length}번 호출`);
    ok('원본 대조 보고서 표시', /원본 대조 결과/.test(r.banner), r.banner.split('\n')[0]);
    await p.evaluate(() => GunbanNavi.seek(GunbanNavi.song.measures[1].start)); await p.click('#recheckBtn'); await p.waitForTimeout(1500);
    const r2 = await p.evaluate(() => ({ focus: window.__calls[window.__calls.length - 1].focus, toast: document.querySelector('#toast').textContent }));
    ok('"지금 마디 다시 확인"이 그 마디를 집중해서 다시 봄', r2.focus && /고쳤어요|같아요/.test(r2.toast), r2.toast);
    ok('페이지 오류 없음', errs.length === 0, errs.join(' | ')); await p.close(); }

  // 5) 빠르기 표 수정 / 피아노 소리 두 세트
  { const { p } = await openPage(browser);
    await p.setInputFiles('#fileInput', FIX('test.musicxml')); await p.waitForTimeout(400);
    const t = await p.evaluate(() => { const d0 = GunbanNavi.song.duration; const inp = document.querySelector('#tempoList input'); inp.value = 40; inp.dispatchEvent(new Event('change')); return { d0, d1: GunbanNavi.song.duration }; });
    ok('빠르기를 반으로 바꾸면 곡 길이가 두 배', Math.abs(t.d1 - 2 * t.d0) < 0.01, JSON.stringify(t));
    const a = await p.evaluate(async () => { const s = await Sound.setSet('sal'); const k = await Sound.setSet('key'); return { sal: s && s.length, key: k && k.length }; });
    ok('피아노 샘플 디코딩 (그랜드 30음, 개별 88음)', a.sal === 30 && a.key === 88, JSON.stringify(a));
    await p.close(); }

  // 6) 모바일 폭에서 가로 넘침 없음
  { const { p } = await openPage(browser, { viewport: { width: 400, height: 800 } });
    ok('모바일(400px) 가로 넘침 없음', !(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
    await p.close(); }

  await browser.close();
  console.log(failed ? `\n${failed}개 실패` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})();
