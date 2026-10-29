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


  // 7) 구글 로그인 + 내 악보함 + 연습 기록 (가짜 클라우드로 시험)
  { const mockCloud = () => {
      const store = new Map(); window.__store = store; let cb = null; let n = 0;
      window.GUNBAN_CLOUD_BACKEND = {
        onAuth: (f) => { cb = f; setTimeout(() => f(null), 0); },
        signIn: async () => cb({ uid: 'u1', name: '테스트 사용자', email: 't@example.com' }),
        signOut: async () => cb(null),
        set: async (path, obj, merge) => { store.set(path, merge ? { ...(store.get(path) || {}), ...JSON.parse(JSON.stringify(obj)) } : JSON.parse(JSON.stringify(obj))); },
        get: async (path) => (store.has(path) ? JSON.parse(JSON.stringify(store.get(path))) : null),
        list: async (col, opt = {}) => { const depth = col.split('/').length + 1; let out = [...store.entries()].filter(([k]) => k.startsWith(col + '/') && k.split('/').length === depth).map(([k, v]) => ({ id: k.split('/').pop(), ...v })); if (opt.orderBy) out.sort((a, b) => (opt.dir === 'asc' ? 1 : -1) * ((a[opt.orderBy] || 0) - (b[opt.orderBy] || 0))); return opt.limit ? out.slice(0, opt.limit) : out; },
        del: async (path) => { store.delete(path); },
        newId: () => 'id' + (++n),
      };
      window.GUNBAN_AI_ADAPTER = { limits: async () => ({ images: { maxCount: 5 } }), json: async (input) => {
        if (/proofreading/.test(input)) { const ms = JSON.parse(input.match(/is i=0\):\n(.*)\n/)[1]); return { measures: ms.map((m, i) => ({ i, match: true })) }; }
        return { title: 'AI곡', measures: [{ rh: [{ p: 'C5', d: 'w' }], lh: [{ p: 'C3', d: 'w' }], bpm: 80, time: [4, 4] }, { rh: [{ p: 'D5', d: 'w' }], lh: [{ p: 'C3', d: 'w' }] }] }; } };
    };
    const { p, errs } = await openPage(browser, { mockAI: mockCloud });
    ok('설정 전에는 로그인 버튼만 보임', await p.evaluate(() => !document.querySelector('#accountBox').hidden && !document.querySelector('#loginBtn').hidden && document.querySelector('#libBtn').hidden));
    await p.click('#loginBtn'); await p.waitForTimeout(200);
    ok('로그인하면 "내 악보함" 버튼이 보임', await p.evaluate(() => document.querySelector('#loginBtn').hidden && !document.querySelector('#libBtn').hidden));
    await p.setInputFiles('#fileInput', FIX('test.musicxml')); await p.waitForTimeout(1200);
    const saved = await p.evaluate(() => { const k = [...window.__store.keys()].filter((x) => /^users\/u1\/songs\/[^/]+$/.test(x)); const d = window.__store.get(k[0]); return { n: k.length, title: d && d.title, xml: d && d.big.xml, id: current.cloudId }; });
    ok('악보를 올리면 계정에 자동 저장', saved.n === 1 && saved.title === 'Test Waltz' && saved.xml === 1 && !!saved.id, JSON.stringify(saved));
    const t = await p.evaluate(async () => { const inp = document.querySelector('#tempoList input'); inp.value = 50; inp.dispatchEvent(new Event('change')); await new Promise((r) => setTimeout(r, 1200)); return window.__store.get('users/u1/songs/' + current.cloudId).tempos.map((x) => x.bpm); });
    ok('고친 빠르기도 계정에 저장', JSON.stringify(t) === '[50]', JSON.stringify(t));
    const sess = await p.evaluate(async () => { const G = GunbanNavi; G.settings.countIn = false; G.setMode('wait'); G.setHands('both'); G.seek(0); G.play(); await new Promise((r) => setTimeout(r, 300)); G.userNoteOn(30); const st = G.song.steps[G.E.waitIdx]; st.notes.forEach((n) => G.userNoteOn(n.midi)); await new Promise((r) => setTimeout(r, 200)); G.pause(); await new Promise((r) => setTimeout(r, 300)); const sp = 'users/u1/songs/' + current.cloudId; return { log: [...window.__store.keys()].filter((k) => k.startsWith(sp + '/sessions/')).map((k) => window.__store.get(k)), stats: window.__store.get(sp).stats }; });
    ok('연습 기록 저장 (정확도·틀린 음)', sess.log.length === 1 && sess.log[0].mistakes === 1 && sess.stats.sessions === 1, JSON.stringify(sess.log[0]));
    await p.evaluate(() => { GunbanNavi.pause(); loadDemo(); }); await p.waitForTimeout(300);
    await p.click('#libBtn'); await p.waitForTimeout(600);
    const lib = await p.evaluate(() => [...document.querySelectorAll('#libList .lib-item')].map((li) => li.innerText.replace(/\s+/g, ' ')));
    ok('내 악보함 목록에 곡과 연습 요약이 보임', lib.length === 1 && /Test Waltz/.test(lib[0]) && /연습 1회/.test(lib[0]), lib[0]);
    await p.click('#libList .lib-item button.primary'); await p.waitForTimeout(700);
    const re = await p.evaluate(() => ({ title: GunbanNavi.song.title, bpm: GunbanNavi.song.baseBpm, id: current.cloudId, hidden: document.querySelector('#libModal').hidden }));
    ok('악보함에서 다시 열기 (빠르기 수정 포함)', re.title === 'Test Waltz' && re.bpm === 50 && re.hidden, JSON.stringify(re));
    const big = await p.evaluate(async () => { const s = 'x'.repeat(650000) + '한글'; const n = await Library.putBig('users/u1/songs/tmp', 'xml', s, 0); const back = await Library.getBig('users/u1/songs/tmp', 'xml', n); return { n, same: back === s }; });
    ok('큰 악보는 나눠 저장하고 그대로 합침', big.n === 3 && big.same, JSON.stringify(big));
    await p.setInputFiles('#fileInput', FIX('synthetic_page.png'));
    await p.waitForSelector('#aiGo:not([disabled])', { timeout: 60000 }); await p.click('#aiGo');
    await p.waitForFunction(() => document.querySelector('#aiModal').hidden, null, { timeout: 60000 }); await p.waitForTimeout(1000);
    const ai = await p.evaluate(async () => { const d = window.__store.get('users/u1/songs/' + current.cloudId); current.ai.systems = null; const f = await Library.getOriginalFile(current.cloudId); return { kind: d.kind, orig: d.original && d.original.name, ai: d.big.ai, fsize: f && f.size }; });
    ok('AI로 읽은 악보는 원본 이미지·판독 결과까지 저장', ai.kind === 'ai' && ai.orig === 'synthetic_page.png' && ai.ai >= 1 && ai.fsize > 1000, JSON.stringify(ai));
    await p.evaluate(() => GunbanNavi.seek(GunbanNavi.song.measures[0].start)); await p.click('#recheckBtn'); await p.waitForTimeout(2500);
    ok('새로고침 뒤 "다시 확인"은 악보함의 원본을 자동으로 씀', await p.evaluate(() => !!(current.ai && current.ai.systems)), await p.evaluate(() => document.querySelector('#toast').textContent));
    await p.click('#libBtn'); await p.waitForTimeout(600);
    const before = await p.evaluate(() => document.querySelectorAll('#libList .lib-item').length);
    await p.evaluate(() => { const b = [...document.querySelectorAll('#libList .lib-item')].pop().querySelectorAll('button')[2]; b.click(); }); await p.waitForTimeout(100);
    await p.evaluate(() => { const b = [...document.querySelectorAll('#libList .lib-item')].pop().querySelectorAll('button')[2]; b.click(); }); await p.waitForTimeout(800);
    const after = await p.evaluate(() => ({ n: document.querySelectorAll('#libList .lib-item').length, left: [...window.__store.keys()].filter((k) => k.includes('/songs/') && !k.includes('/songs/tmp')).length }));
    ok('삭제는 두 번 눌러야 지워지고, 딸린 데이터도 함께 삭제', before === 2 && after.n === 1, JSON.stringify({ before, ...after }));
    await p.setViewportSize({ width: 400, height: 800 }); await p.waitForTimeout(200);
    ok('로그인 상태 모바일(400px) 가로 넘침 없음', !(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
    ok('페이지 오류 없음', errs.length === 0, errs.join(' | ')); await p.close(); }


  // 8) 악보 파일만 올리면 자동 변환(Audiveris) — 로그인 없이 임시 계정, 버튼 없음, 끝나면 자동으로 열림
  { const mock = () => {
      const store = new Map(); window.__store = store; let cb = null; let n = 0;
      window.GUNBAN_CLOUD_BACKEND = {
        onAuth: (f) => { cb = f; setTimeout(() => f(null), 0); }, signIn: async () => cb({ uid: 'u9', name: '사용자' }), signOut: async () => cb(null),
        signInAnon: async () => cb({ uid: 'u9', name: '', anon: true }),
      }; window.GUNBAN_OMR_KICK = 'https://kick.test/'; Object.assign(window.GUNBAN_CLOUD_BACKEND, {
        set: async (path, obj, merge) => { store.set(path, merge ? { ...(store.get(path) || {}), ...JSON.parse(JSON.stringify(obj)) } : JSON.parse(JSON.stringify(obj))); },
        get: async (path) => (store.has(path) ? JSON.parse(JSON.stringify(store.get(path))) : null),
        list: async (col, opt = {}) => { const depth = col.split('/').length + 1; let out = [...store.entries()].filter(([k]) => k.startsWith(col + '/') && k.split('/').length === depth).map(([k, v]) => ({ id: k.split('/').pop(), ...v })); if (opt.orderBy) out.sort((a, b) => (opt.dir === 'asc' ? 1 : -1) * ((a[opt.orderBy] || 0) - (b[opt.orderBy] || 0))); return opt.limit ? out.slice(0, opt.limit) : out; },
        del: async (path) => { store.delete(path); }, newId: () => 'j' + (++n),
      });
    };
    const { p, errs } = await openPage(browser, { mockAI: mock });
    let kicks = 0; await p.route('https://kick.test/**', (r) => { if (r.request().method() === 'POST') kicks++; r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: '{"ok":true}' }); });
    await p.setInputFiles('#fileInput', FIX('synthetic_page.png')); await p.waitForTimeout(800);
    const q = await p.evaluate(() => { const ks = [...window.__store.keys()]; return { modal: !document.querySelector('#aiModal').hidden, job: window.__store.get('users/u9/omrJobs/j1'), queue: window.__store.get('omrQueue/j1'), chunk: ks.filter((k) => k.startsWith('users/u9/omrJobs/j1/chunks/')).length, chip: document.querySelector('#omrChip').hidden ? '' : document.querySelector('#omrChipText').textContent, saved: localStorage.getItem('gunban-navi-v1:omrJob') }; });
    ok('파일만 올리면 안내 창 없이 바로 변환 요청(임시 계정)', !q.modal && q.job && q.job.status === 'queued' && q.queue && q.queue.uid === 'u9' && q.chunk === 1, JSON.stringify({ modal: q.modal, chip: q.chip }));
    ok('올리자마자 변환 바로 시작 요청(중계기)', kicks === 1, String(kicks));
    ok('화면 위에 진행 상황 표시 + 새로고침 대비 기억', /준비 중.*1~2분/.test(q.chip) && /j1/.test(q.saved || ''), q.chip);
    ok('임시 계정이면 구글 로그인 버튼은 계속 보임', await p.evaluate(() => !document.querySelector('#loginBtn').hidden && !document.querySelector('#libBtn').hidden));
    // 변환 서버(omr/worker.py)가 하는 일을 흉내 낸다
    await p.evaluate(async () => {
      const xml = jsonToMusicXML({ title: '변환곡', time: [4, 4], measures: [{ rh: [{ p: 'C5', d: 'w' }], lh: [{ p: 'C3', d: 'w' }] }, { rh: [{ p: 'D5', d: 'w' }], lh: [{ p: 'G2', d: 'w' }] }] });
      const s = window.__store; s.set('users/u9/songs/s1/chunks/xml_0', { field: 'xml', i: 0, data: xml });
      s.set('users/u9/songs/s1', { title: '변환곡', kind: 'omr', name: 'synthetic_page.png', measures: 2, createdAt: Date.now(), updatedAt: Date.now(), flags: [], fixed: [], tempos: [], big: { xml: 1 }, original: null, stats: { sessions: 0 } });
      s.set('users/u9/omrJobs/j1', { ...s.get('users/u9/omrJobs/j1'), status: 'done', songId: 's1', finishedAt: Date.now(), info: { measures: 2, seconds: 14 } }); s.delete('omrQueue/j1');
      await Convert.poll();
    });
    await p.waitForTimeout(700);
    ok('변환이 끝나면 악보가 자동으로 열림', await p.evaluate(() => GunbanNavi.song.title === '변환곡' && current.kind === 'omr' && /완료/.test(document.querySelector('#omrChipText').textContent) && !localStorage.getItem('gunban-navi-v1:omrJob').includes('j1')));
    await p.click('#libBtn'); await p.waitForTimeout(600);
    const j = await p.evaluate(() => ({ jobs: [...document.querySelectorAll('#jobList .lib-item')].map((x) => x.innerText.replace(/\s+/g, ' ')), songs: document.querySelectorAll('#libList .lib-item').length }));
    ok('내 악보함에 변환 기록과 결과 곡이 보임', j.jobs.length === 1 && /완료/.test(j.jobs[0]) && j.songs === 1, j.jobs[0]);
    ok('페이지 오류 없음', errs.length === 0, errs.join(' | ')); await p.close(); }

  // 8-2) 익명 로그인을 못 쓰는 경우: 안내만 하고 오류 없이 멈춤
  { const mock = () => {
      let cb = null;
      window.GUNBAN_CLOUD_BACKEND = { onAuth: (f) => { cb = f; setTimeout(() => f(null), 0); }, signIn: async () => cb({ uid: 'u1' }), signOut: async () => cb(null),
        signInAnon: async () => { throw Object.assign(new Error('admin-restricted-operation'), { code: 'auth/admin-restricted-operation' }); },
        set: async () => {}, get: async () => null, list: async () => [], del: async () => {}, newId: () => 'x' };
    };
    const { p, errs } = await openPage(browser, { mockAI: mock });
    await p.setInputFiles('#fileInput', FIX('synthetic_page.png')); await p.waitForTimeout(600);
    ok('임시 계정 불가 시 로그인 안내', await p.evaluate(() => !document.querySelector('#omrChip').hidden && /로그인/.test(document.querySelector('#omrChipText').textContent) && document.querySelector('#aiModal').hidden));
    ok('페이지 오류 없음', errs.length === 0, errs.join(' | ')); await p.close(); }

  // 9) 변환 서버로 바로 변환 (Hugging Face Space 흉내) — 깨우는 중(503) → 결과 받아 바로 열기, 로그인 없이도 됨
  { const { p, errs } = await openPage(browser, { mockAI: () => { window.GUNBAN_OMR_SERVER = 'https://omr.test/'; } });
    let posts = 0, wakes = 0, gotName = '';
    const xml = await p.evaluate(() => jsonToMusicXML({ title: 'Title', time: [4, 4], measures: [{ rh: [{ p: 'E5', d: 'w' }], lh: [{ p: 'C3', d: 'w' }] }] }));
    await p.route('https://omr.test/**', async (r) => {
      const u = r.request().url(); const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type, X-File-Name' };
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
      if (u.endsWith('/health')) { wakes++; return r.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: '{"ok":true}' }); }
      posts++; gotName = decodeURIComponent(r.request().headers()['x-file-name'] || '');
      if (posts === 1) return r.fulfill({ status: 503, headers: cors, body: 'loading' });
      return r.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ xml, info: { measures: 1, seconds: 12 } }) });
    });
    await p.evaluate(() => wakeOmrServer()); await p.waitForTimeout(200);
    await p.setInputFiles('#fileInput', FIX('synthetic_page.png')); await p.waitForTimeout(800);
    const w1 = await p.evaluate(() => document.querySelector('#omrChipText').textContent);
    ok('서버 깨우는 중 표시', /깨우는 중/.test(w1) && await p.evaluate(() => document.querySelector('#aiModal').hidden), w1);
    await p.waitForFunction(() => GunbanNavi.song.title === 'synthetic_page', null, { timeout: 15000 }).catch(() => {});
    const r = await p.evaluate(() => ({ title: GunbanNavi.song.title, kind: current.kind, chip: document.querySelector('#omrChipText').textContent }));
    ok('변환 서버 결과를 받아 바로 열기 (로그인 없이)', r.title === 'synthetic_page' && r.kind === 'omr' && /완료/.test(r.chip) && posts === 2 && gotName === 'synthetic_page.png' && wakes >= 1, JSON.stringify({ ...r, posts, wakes, gotName }));
    ok('페이지 오류 없음', errs.length === 0, errs.join(' | ')); await p.close(); }

  await browser.close();
  console.log(failed ? `\n${failed}개 실패` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})();
