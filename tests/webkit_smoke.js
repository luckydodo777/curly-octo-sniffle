// 사파리 엔진(WebKit)으로 아이패드 화면 크기에서 앱을 열어 보는 시험. CI(webkit.yml)에서 실행.
// 확인: 페이지 오류 없음, 악보 그림, 화면 배치(피아노가 절반 이상), 가짜 마이크(합성 소리)로 워클릿/워커 경로와 인식 횟수.
const { webkit, devices } = require('playwright'); const path = require('path'); const fs = require('fs');
const PAGE = 'file://' + path.resolve(__dirname, '../dist/건반내비.html');
const OSMD = path.resolve(__dirname, '.cache', 'osmd-1.8.9.min.js');
(async () => {
  const b = await webkit.launch(); let bad = 0;
  const ok = (name, cond, info) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`); if (!cond) bad++; };
  // 실제 사이트처럼 http 주소로도 한 번 연다 (파일로 열 때와 워커·워클릿 동작이 다를 수 있음)
  const srv = require('http').createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(fs.readFileSync(path.resolve(__dirname, '../dist/건반내비.html'))); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const HTTP = `http://127.0.0.1:${srv.address().port}/`;
  for (const [name, url] of [['iPad (gen 7) landscape', PAGE], ['iPad (gen 7)', PAGE], ['iPad (gen 7) landscape', HTTP]]) {
    const label = url === HTTP ? name + ' · http' : name;
    const ctx = await b.newContext({ ...devices[name] }); const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.addInitScript(() => {
      const fakeGUM = async () => {
        const AC = window.AudioContext || window.webkitAudioContext; const ac = new AC(); const dst = ac.createMediaStreamDestination(); const t0 = ac.currentTime + 1.2;
        for (let k = 0; k < 4; k++) { const o = ac.createOscillator(); o.frequency.value = 261.63; const g = ac.createGain(); g.gain.setValueAtTime(0, 0); g.gain.setValueAtTime(0, t0 + k * 0.5); g.gain.linearRampToValueAtTime(0.05, t0 + k * 0.5 + 0.005); g.gain.exponentialRampToValueAtTime(0.002, t0 + k * 0.5 + 0.45); g.gain.setValueAtTime(0, t0 + k * 0.5 + 0.46); o.connect(g); g.connect(dst); o.start(); }
        window.__fakeUsed = (window.__fakeUsed || 0) + 1; return dst.stream;
      };
      // 사파리 엔진은 단순 대입으로는 안 바뀌어 속성을 다시 정의한다
      try { Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { value: fakeGUM, configurable: true, writable: true }); } catch (e) {}
      try { if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: fakeGUM }, configurable: true }); else Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: fakeGUM, configurable: true, writable: true }); } catch (e) {}
    });
    await p.route('**/*', (r) => { const u = r.request().url(); if (u.includes('opensheetmusicdisplay') && fs.existsSync(OSMD)) return r.fulfill({ body: fs.readFileSync(OSMD), contentType: 'application/javascript' }); return u.startsWith('file:') || u.startsWith(HTTP) ? r.continue() : r.abort(); });
    await p.goto(url); await p.waitForTimeout(3000);
    const lay = await p.evaluate(() => { const h = (s) => document.querySelector(s).getBoundingClientRect().height; return { w: innerWidth, h: innerHeight, piano: +((h('#fall') + h('#keys')) / innerHeight).toFixed(2), score: Score.ready, scroll: document.documentElement.scrollWidth > innerWidth }; });
    ok(`[${label}] 화면 배치 · 악보 그림`, lay.piano >= 0.45 && !lay.scroll && (lay.score || !fs.existsSync(OSMD)), JSON.stringify(lay));
    await p.tap('#micQuick'); await p.waitForTimeout(4200);
    const mic = await p.evaluate(() => ({ on: GunbanNavi.Mic.on, mode: GunbanNavi.Mic.mode, err: GunbanNavi.Mic.lastError || null, worklet: GunbanNavi.Mic.workletError || null, worker: GunbanNavi.Mic.workerError || null, fixes: GunbanNavi.Mic.fixes, n: GunbanNavi.Input.seq, stats: GunbanNavi.Mic.stats, status: document.querySelector('#micStatus').textContent, sr: Sound.ctx && Sound.ctx.sampleRate, state: Sound.ctx && Sound.ctx.state,
      env: { fake: window.__fakeUsed || 0, secure: window.isSecureContext, md: !!navigator.mediaDevices, msd: typeof (window.AudioContext || window.webkitAudioContext).prototype.createMediaStreamDestination, mss: typeof (window.AudioContext || window.webkitAudioContext).prototype.createMediaStreamSource, awn: typeof window.AudioWorkletNode } }));
    console.log(`INFO [${label}] 환경 ${JSON.stringify(mic.env)} sr ${mic.sr} ${mic.state}`);
    console.log(`INFO [${label}] 마이크 ${JSON.stringify({ on: mic.on, mode: mic.mode, err: mic.err, worklet: mic.worklet, worker: mic.worker, fixes: mic.fixes, n: mic.n, stats: mic.stats })}`);
    ok(`[${label}] 가짜 마이크: 켜지고 소리를 받음`, mic.on && mic.stats && mic.stats.blocks > 10, JSON.stringify({ mode: mic.mode, blocks: mic.stats && mic.stats.blocks }));
    ok(`[${label}] 가짜 마이크: 4번 친 소리 → 입력 4번`, mic.n === 4, `${mic.n}번 (${mic.mode})`);
    ok(`[${label}] 페이지 오류 없음`, errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  srv.close(); await b.close(); process.exit(bad ? 1 : 0);
})();
