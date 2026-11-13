// 건반 내비 자동 테스트 — 사용법: (한 번만) npm i playwright && npx playwright install chromium
//                                  python build.py && node tests/run_all.js
// 외부 네트워크(CDN·폰트)는 막고 테스트한다. PDF(pdf.js)는 빠진다.
// 악보 그림(OSMD 1.8.9)은 tests/.cache/osmd-1.8.9.min.js 가 있을 때만 시험한다 (CI는 GitHub 릴리스에서 받아 둠, 저장소에는 넣지 않음).
const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs');
const PAGE = 'file://' + path.resolve(__dirname, '../dist/건반내비.html');
const FIX = (f) => path.resolve(__dirname, 'fixtures', f);
const OSMD_LOCAL = process.env.OSMD_JS || path.resolve(__dirname, '.cache', 'osmd-1.8.9.min.js');
let failed = 0; const ok = (name, cond, info) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`); if (!cond) failed++; };

async function openPage(browser, opts = {}) {
  const p = await browser.newPage({ viewport: opts.viewport || { width: 1300, height: 850 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  if (opts.mockAI) await p.addInitScript(opts.mockAI);
  await p.route('**/*', (r) => {
    const u = r.request().url();
    if (opts.osmd && u.includes('opensheetmusicdisplay')) return r.fulfill({ body: fs.readFileSync(OSMD_LOCAL), contentType: 'application/javascript' });
    return u.startsWith('file:') ? r.continue() : r.abort();
  });
  await p.goto(PAGE); await p.waitForTimeout(opts.osmd ? 2500 : 1200);
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

  // 10) MusicXML 해석 정확성 (이슈 #14): 박자 넘침은 표시만, 붙임줄은 성부별, 잇단음·divisions 변경·못갖춘마디
  { const { p, errs } = await openPage(browser);
    const r = await p.evaluate(() => {
      const N = (st, dur, voice, staff, extra = '', oct = 4) => `<note><pitch><step>${st}</step><octave>${oct}</octave></pitch><duration>${dur}</duration>${extra.includes('tie') ? extra.match(/<tie [^>]*\/>/g).join('') : ''}<voice>${voice}</voice><staff>${staff}</staff>${extra.replace(/<tie [^>]*\/>/g, '')}</note>`;
      const T = (t) => `<tie type="${t}"/><notations><tied type="${t}"/></notations>`;
      const wrap = (ms) => `<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list><part id="P1">${ms.join('')}</part></score-partwise>`;
      const attrs = (div, b, bt, staves = 2) => `<attributes><divisions>${div}</divisions><time><beats>${b}</beats><beat-type>${bt}</beat-type></time><staves>${staves}</staves></attributes>`;
      const out = {};
      // (a) 박자 넘침: 3/4 마디에 오른손 4박 → 시간은 그대로, 마디만 길어지고 표시
      const xa = wrap([
        `<measure number="1">${attrs(2, 3, 4)}${N('C', 2, 1, 1)}${N('D', 2, 1, 1)}${N('E', 2, 1, 1)}<backup><duration>6</duration></backup>${N('C', 6, 5, 2, '', 3)}</measure>`,
        `<measure number="2">${N('C', 2, 1, 1)}${N('D', 2, 1, 1)}${N('E', 2, 1, 1)}${N('F', 2, 1, 1)}<backup><duration>8</duration></backup>${N('C', 6, 5, 2, '', 3)}</measure>`,
        `<measure number="3">${N('G', 2, 1, 1)}${N('A', 2, 1, 1)}<backup><duration>4</duration></backup>${N('C', 4, 5, 2, '', 3)}</measure>`]);
      const fa = parseMusicXML(xa, { fit: true }), pa = parseMusicXML(xa);
      out.a = { rh: fa.notes.filter((n) => n.measure === 1 && n.staff === 1).map((n) => n.startQ), lh: fa.notes.find((n) => n.measure === 1 && n.staff === 2).startQ,
        len: fa.measures[1].lenQ, m3: fa.measures[2].startQ, same: JSON.stringify(fa.notes.map((n) => [n.startQ, n.durQ])) === JSON.stringify(pa.notes.map((n) => [n.startQ, n.durQ])),
        flags: fa.fitFlags.map((f) => f.m), msg: fa.fitFlags[0] && fa.fitFlags[0].issues[0] };
      // (b) 두 성부의 같은 음 붙임줄 (GPT 재현 2)
      const xb = wrap([`<measure number="1">${attrs(1, 4, 4, 1)}${N('C', 4, 1, 1, T('start'))}<backup><duration>4</duration></backup>${N('C', 4, 2, 1, T('start'))}</measure>`,
        `<measure number="2">${N('C', 4, 1, 1, T('stop'))}<backup><duration>4</duration></backup>${N('C', 4, 2, 1, T('stop'))}</measure>`]);
      const rb = parseMusicXML(xb);
      out.b = { parsed: rb.notes.map((n) => [n.startQ, n.durQ, n.voice]), played: buildSong(rb, {}).notes.map((n) => [n.startQ, n.durQ]) };
      // (c) 다른 단으로 넘어가는 붙임줄 (같은 성부)
      const xc = wrap([`<measure number="1">${attrs(1, 4, 4)}${N('C', 4, 1, 1, T('start'))}</measure>`, `<measure number="2">${N('C', 4, 1, 2, T('stop'))}</measure>`]);
      out.c = parseMusicXML(xc).notes.map((n) => [n.startQ, n.durQ]);
      // (d) 한 성부의 붙임줄은 다른 성부의 같은 음과 섞이지 않음: 성부1 C4 이어짐, 성부2 C4는 2마디에서 새로 침
      const xd = wrap([`<measure number="1">${attrs(1, 4, 4, 1)}${N('C', 4, 1, 1, T('start'))}<backup><duration>4</duration></backup>${N('C', 4, 2, 1)}</measure>`,
        `<measure number="2">${N('C', 4, 1, 1, T('stop'))}<backup><duration>4</duration></backup>${N('C', 2, 2, 1)}${N('C', 2, 2, 1)}</measure>`]);
      out.d = parseMusicXML(xd).notes.map((n) => [n.startQ, n.durQ, n.voice]);
      // (e) 셋잇단(duration에 이미 비율 반영) + divisions 변경
      const tm = '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>';
      const xe = wrap([`<measure number="1">${attrs(3, 2, 4, 1)}${N('C', 1, 1, 1, tm)}${N('D', 1, 1, 1, tm)}${N('E', 1, 1, 1, tm)}${N('F', 3, 1, 1)}</measure>`,
        `<measure number="2"><attributes><divisions>4</divisions></attributes>${N('G', 4, 1, 1)}${N('A', 4, 1, 1)}</measure>`]);
      const re_ = parseMusicXML(xe);
      out.e = { starts: re_.notes.map((n) => +n.startQ.toFixed(4)), m2: re_.measures[1].startQ, m2len: re_.measures[1].lenQ };
      // (f) 못갖춘마디(implicit)는 표시하지 않고 1박으로 시작
      const xf = wrap([`<measure number="0" implicit="yes">${attrs(1, 4, 4, 1)}${N('G', 1, 1, 1)}</measure>`, `<measure number="1">${N('C', 4, 1, 1)}</measure>`]);
      const rf = parseMusicXML(xf, { fit: true });
      out.f = { len0: rf.measures[0].lenQ, m1: rf.measures[1].startQ, flags: rf.fitFlags.length, src: rf.notes[1].src };
      // (g) 변환 서버 안내 합치기
      out.g = omrFlags({ fitFlags: [{ m: 2, issues: ['길이'] }] }, [{ m: 0, text: '박자표 추정' }, { m: 2, text: '박자표 확인' }, { m: 'x', text: '무시' }]);
      return out;
    });
    ok('박자 넘침: 음 시간을 바꾸지 않음 (양손 동시성 유지)', JSON.stringify(r.a.rh) === '[3,4,5,6]' && r.a.lh === 3 && r.a.same && r.a.len === 4 && r.a.m3 === 7, JSON.stringify(r.a));
    ok('박자 넘침·빠진 마디는 "확인 필요"로만 표시', JSON.stringify(r.a.flags) === '[1,2]' && /원본과 비교/.test(r.a.msg || ''), JSON.stringify(r.a.flags));
    ok('두 성부 같은 음 붙임줄: 다시 치지 않음', JSON.stringify(r.b.parsed) === '[[0,8,"1"],[0,8,"2"]]' && JSON.stringify(r.b.played) === '[[0,8]]', JSON.stringify(r.b));
    ok('다른 단으로 넘어가는 붙임줄 연결', JSON.stringify(r.c) === '[[0,8]]', JSON.stringify(r.c));
    ok('붙임줄이 다른 성부의 같은 음과 섞이지 않음', JSON.stringify(r.d) === '[[0,8,"1"],[0,4,"2"],[4,2,"2"],[6,2,"2"]]', JSON.stringify(r.d));
    ok('셋잇단(비율 두 번 곱하지 않음)·divisions 변경', JSON.stringify(r.e.starts) === '[0,0.3333,0.6667,1,2,3]' && r.e.m2 === 2 && r.e.m2len === 2, JSON.stringify(r.e));
    ok('못갖춘마디는 짧은 그대로·표시 안 함·원본 위치 보존', r.f.len0 === 1 && r.f.m1 === 1 && r.f.flags === 0 && r.f.src && r.f.src.measure === '1' && r.f.src.offsetQ === 0, JSON.stringify(r.f));
    ok('변환 서버 안내를 확인 필요 목록에 합침', JSON.stringify(r.g) === '[{"m":0,"issues":["박자표 추정"]},{"m":2,"issues":["박자표 확인","길이"]}]', JSON.stringify(r.g));
    ok('페이지 오류 없음', errs.length === 0, errs.join(' | ')); await p.close(); }

  // 11) 재생 위치 동기화·역행 추적 (이슈 #14 PR 2)
  { const { p, errs } = await openPage(browser);
    // (a) 같은 순간 판단은 악보 시간으로: 아주 빠른 곡에서 3ms 차이 나는 두 음은 다른 차례
    const a = await p.evaluate(() => {
      const raw = { title: 't', tempos: [{ q: 0, bpm: 600 }], measures: [{ num: 1, startQ: 0, lenQ: 4, beats: 4, beatType: 4 }],
        notes: [{ midi: 60, startQ: 0, durQ: 1 / 32, staff: 1, hand: 'R', measure: 0 }, { midi: 62, startQ: 1 / 32, durQ: 1, staff: 1, hand: 'R', measure: 0 }, { midi: 48, startQ: 0, durQ: 1, staff: 2, hand: 'L', measure: 0 }] };
      const s = GunbanNavi.buildSong(raw, {}); return { steps: s.steps.map((x) => x.notes.map((n) => n.midi)), gapMs: Math.round((s.notes[2].start - s.notes[0].start) * 1000), occ: s.notes[0].occ };
    });
    ok('같은 순간은 악보 시간으로 묶음 (3ms 차이 두 음은 다른 차례)', JSON.stringify(a.steps) === '[[48,60],[62]]' && a.gapMs < 5 && a.occ === '1#1', JSON.stringify(a));
    // (b) 따라치기로 끝까지: 위치·차례가 뒤로 가지 않음, 이유 없는 역행 0
    const b = await p.evaluate(async () => {
      const G = GunbanNavi; G.settings.countIn = false; G.setMode('wait'); G.setHands('both'); G.setRate(1.5); G.seek(G.song.measures[12].start, false, 'test'); G.play(); // 13~16마디
      let back = 0, lastPos = -1, lastIdx = -1, guard = 0;
      while (!G.E.finished && guard++ < 600) {
        await new Promise((r) => setTimeout(r, 20));
        if (G.E.pos < lastPos - 1e-9 || G.E.waitIdx < lastIdx) back++; lastPos = G.E.pos; lastIdx = G.E.waitIdx;
        if (G.E.waiting) { const st = G.song.steps[G.E.waitIdx]; if (st) st.notes.forEach((n) => G.userNoteOn(n.midi)); }
      }
      G.pause(); return { finished: G.E.finished, back, unexpected: G.PosLog.unexpected().length, reasons: [...new Set(G.PosLog.list.map((e) => e.reason))] };
    });
    ok('따라치기 끝까지: 위치·차례가 뒤로 가지 않음', b.finished && b.back === 0 && b.unexpected === 0, JSON.stringify(b));
    // (c) 구간 반복으로 돌아갈 때는 이유(loop)가 남고, 한 번 알려 줌
    const c = await p.evaluate(async () => {
      const G = GunbanNavi; G.setMode('listen'); G.setLoopRange(2, 2); G.setRate(1.5); G.play();
      await new Promise((r) => setTimeout(r, 3500)); G.pause(); G.setLoopRange(1, 1); document.querySelector('#loopOn').click();
      const loops = G.PosLog.list.filter((e) => e.reason === 'loop' && e.to < e.from); return { loops: loops.length, toast: document.querySelector('#toast').textContent, unexpected: G.PosLog.unexpected().length };
    });
    ok('구간 반복 되돌아감은 이유가 남고 알려 줌', c.loops >= 1 && c.unexpected === 0, JSON.stringify(c));
    ok('페이지 오류 없음', errs.length === 0, errs.join(' | ')); await p.close(); }

  // 12) 변환이 끝나도 연습 중이면 곡을 바꾸지 않음 + 늦게 끝난 열기는 무시
  { const mock = () => {
      const store = new Map(); window.__store = store; let cb = null;
      window.GUNBAN_CLOUD_BACKEND = { onAuth: (f) => { cb = f; setTimeout(() => f({ uid: 'u1', anon: true }), 0); }, signIn: async () => {}, signOut: async () => {}, signInAnon: async () => {},
        set: async (k, o) => { store.set(k, o); }, list: async () => [], del: async () => {}, newId: () => 'x',
        get: async (k) => { if (k.endsWith('/slow')) await new Promise((r) => setTimeout(r, 400)); return store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null; } };
    };
    const { p, errs } = await openPage(browser, { mockAI: mock });
    const r = await p.evaluate(async () => {
      const xml = (t, step) => jsonToMusicXML({ title: t, time: [4, 4], measures: [{ rh: [{ p: step + '5', d: 'w' }], lh: [{ p: 'C3', d: 'w' }] }] });
      const S = window.__store; const put = (id, t, step) => { S.set(`users/u1/songs/${id}`, { title: t, kind: 'musicxml', name: t, big: { xml: 1 }, flags: [] }); S.set(`users/u1/songs/${id}/chunks/xml_0`, { data: xml(t, step) }); };
      put('slow', '느린곡', 'D'); put('fast', '빠른곡', 'E'); put('done', '변환곡', 'F');
      // 늦게 끝난 열기 무시
      const p1 = Library.open('slow'); await Library.open('fast'); await p1; const afterOpen = GunbanNavi.song.title;
      // 재생 중 변환 완료 → 곡 그대로, 열기 버튼
      S.set('users/u1/omrJobs/j1', { status: 'done', songId: 'done' }); Convert.jobId = 'j1'; Convert.name = 'a.pdf';
      GunbanNavi.setMode('listen'); GunbanNavi.play(); await Convert.poll();
      const during = { title: GunbanNavi.song.title, openBtn: !document.querySelector('#omrChipOpen').hidden };
      GunbanNavi.pause(); document.querySelector('#omrChipOpen').click(); await new Promise((r) => setTimeout(r, 600));
      return { afterOpen, during, after: GunbanNavi.song.title };
    });
    ok('늦게 끝난 곡 열기가 나중 곡을 덮어쓰지 않음', r.afterOpen === '빠른곡', r.afterOpen);
    ok('연습 중 변환 완료: 곡을 바꾸지 않고 열기 버튼', r.during.title === '빠른곡' && r.during.openBtn && r.after === '변환곡', JSON.stringify(r));
    ok('페이지 오류 없음', errs.length === 0, errs.join(' | ')); await p.close(); }

  // 12-2) 도돌이표·1/2번 괄호 펼치기
  { const { p, errs } = await openPage(browser);
    const r = await p.evaluate(() => {
      const M = (rep) => ({ lenQ: 4, rep });
      const ord = (ms) => repeatOrder(ms).map((o) => o.src + (o.pass > 1 ? "'" : "")).join(' ');
      const E1 = { endStart: [1], endStop: true, ending: [1] }, E2 = { endStart: [2], endStop: true, ending: [2] };
      const out = {
        simple: ord([M({ fwd: true }), M({ bwd: 2 }), M()]),
        noFwd: ord([M(), M({ bwd: 2 }), M()]),
        endings: ord([M({ fwd: true }), M(), M({ ...E1, bwd: 2 }), M(E2), M()]),
        three: ord([M({ fwd: true }), M({ endStart: [1, 2], endStop: true, ending: [1, 2], bwd: 3 }), M({ endStart: [3], endStop: true, ending: [3] }), M()]),
        two: ord([M(), M({ bwd: 2 }), M({ fwd: true }), M({ bwd: 2 }), M()]),
        longEnding: ord([M({ fwd: true }), M({ endStart: [1], ending: [1] }), M({ endStop: true, bwd: 2 }), M({ endStart: [2] }), M({ endStop: true }), M()]),
      };
      // 실제 MusicXML: 2마디 |: 3 4 :| [1 5 ] [2 6] 7 , 빠르기 2마디에서 변경, 4마디 확인 필요
      const N = (st) => `<note><pitch><step>${st}</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note>`;
      const bl = (loc, inner) => `<barline location="${loc}">${inner}</barline>`;
      const xml = `<score-partwise><part-list><score-part id="P1"/></part-list><part id="P1">
        <measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><direction><sound tempo="60"/></direction>${N('C')}</measure>
        <measure number="2">${bl('left', '<repeat direction="forward"/>')}<direction><sound tempo="120"/></direction>${N('D')}</measure>
        <measure number="3">${N('E')}</measure>
        <measure number="4">${bl('left', '<ending number="1" type="start"/>')}${N('F')}${bl('right', '<ending number="1" type="stop"/><repeat direction="backward"/>')}</measure>
        <measure number="5">${bl('left', '<ending number="2" type="start"/>')}${N('G')}${bl('right', '<ending number="2" type="discontinue"/>')}</measure>
        <measure number="6">${N('A')}</measure></part></score-partwise>`;
      const G = GunbanNavi; const raw = parseMusicXML(xml); setSong(raw, { kind: 'musicxml', xml, name: 'r', flags: [{ m: 3, issues: ['확인'] }], persist: false });
      const s = G.song;
      out.perf = s.measures.map((m) => m.src + 1 + (m.pass > 1 ? "'" : "")).join(' ');
      out.notes = s.notes.map((n) => n.midi).join(',');
      out.occ = s.notes.filter((n) => n.midi === 62).map((n) => n.occ).join(',');
      out.tempos = s.tempoMarks.map((t) => `${t.measure + 1}:${t.bpm}`).join(' ');
      out.secs = Math.round(s.duration);
      out.srcQ = [s.toSrcQ(s.measures[4].startQ), s.toSrcQ(s.measures[4].startQ + 1)]; // 2회째 2마디 → 원본 2마디(4박)
      G.setLoopRange(3, 4); const lr = loopRangeForTest();
      out.loop = [lr.a, lr.b, lr.sa, lr.sb];
      G.seek(s.measures[5].start + 0.1); out.label = document.querySelector('#measureReadout').textContent; 
      document.querySelector('#loopOn').checked && document.querySelector('#loopOn').click();
      document.querySelector('#expandRepeats').click(); out.off = G.song.measures.length; out.offLabel = document.querySelector('#measureReadout').textContent;
      document.querySelector('#expandRepeats').click(); out.on = G.song.measures.length;
      return out;
    });
    ok('도돌이표 순서: 기본·여는 표 없음·1/2번 괄호·3회·두 구간·여러 마디 괄호', r.simple === "0 1 0' 1' 2" && r.noFwd === "0 1 0' 1' 2" && r.endings === "0 1 2 0' 1' 3' 4" && r.three === "0 1 0' 1' 0' 2' 3" && r.two === "0 1 0' 1' 2 3 2' 3' 4" && r.longEnding === "0 1 2 0' 3' 4' 5", JSON.stringify(r));
    ok('MusicXML 도돌이표 펼침: 마디·음·빠르기가 연주 순서대로', r.perf === "1 2 3 4 2' 3' 5' 6" && r.notes === '60,62,64,65,62,64,67,69' && r.occ === '2#1,2#2' && r.tempos === '1:60 2:120 5:120' && r.srcQ[0] === 4 && r.srcQ[1] === 5, JSON.stringify(r));
    ok('마디 번호는 원본 악보 기준 (구간 반복·표시)', JSON.stringify(r.loop) === '[2,3,2,3]' && /마디 3\(2회\) \/ 6/.test(r.label), JSON.stringify([r.loop, r.label]));
    ok('도돌이표 반복 끄기/켜기', r.off === 6 && r.on === 8 && /마디 3 \/ 6/.test(r.offLabel), JSON.stringify([r.off, r.on, r.offLabel]));
    ok('페이지 오류 없음', errs.length === 0, errs.join(' | ')); await p.close(); }

  // 14) 실제 피아노 입력 (이슈 #14 PR 3): 새로 친 순간(onset) 인식, 같은 음 재타건, 공통 입력
  { const { p, errs } = await openPage(browser);
    const r = await p.evaluate(() => {
      // 합성 피아노 소리: 기본음+배음, 5ms 올라가고 줄어드는 소리, 해머 타격음(4ms 잡음)
      const run = (sr, strikes, dur, noise = 0) => {
        const N = Math.round(dur * sr); const x = new Float32Array(N); let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
        for (const s of strikes) { const i0 = Math.round(s.t * sr), i1 = s.stopAt ? Math.round(s.stopAt * sr) : N;
          for (let i = i0; i < N; i++) { const tt = (i - i0) / sr; let env = Math.min(1, tt / 0.005) * Math.exp(-tt / 0.8) * s.amp; if (i >= i1) env *= Math.exp(-(i - i1) / sr / 0.01); if (tt > 0.01 && env < 1e-5) break;
            x[i] += env * (Math.sin(2 * Math.PI * s.f * tt) + 0.5 * Math.sin(4 * Math.PI * s.f * tt) + 0.3 * Math.sin(6 * Math.PI * s.f * tt)) + (tt < 0.004 ? rnd() * 0.3 * s.amp * (1 - tt / 0.004) : 0); } }
        if (noise) for (let i = 0; i < N; i++) x[i] += rnd() * noise;
        const A = GunbanNavi.createMicAnalyzer(sr); const ev = [];
        for (let i = 0; i + 512 <= N; i += 512) ev.push(...A.feed(x.slice(i, i + 512), (i + 512) / sr));
        const ons = ev.filter((e) => e.type === 'on');
        window.__delays = (window.__delays || []).concat(ons.map((e) => { const st = strikes.filter((x) => x.t <= e.t).pop(); return st ? e.t - st.t : 0; }));
        return ons.map((e) => e.midi);
      };
      const rep = (pedal) => Array.from({ length: 10 }, (_, k) => ({ t: 0.1 + k * 0.3, f: 440, amp: 0.3, stopAt: 0.1 + k * 0.3 + (pedal ? 0.3 : 0.27) }));
      const out = {
        repDamped: run(48000, rep(false), 3.5), repPedal: run(48000, rep(true), 3.5), noisyRep: run(48000, rep(false), 3.5, 0.01),
        held: run(48000, [{ t: 0.1, f: 440, amp: 0.3 }], 3),
        gpt: run(48000, [{ t: 0.1, f: 440, amp: 0.1 }, { t: 0.6, f: 440, amp: 0.25 }], 1.5),
        legato: run(48000, [{ t: 0.1, f: 440, amp: 0.3, stopAt: 0.62 }, { t: 0.6, f: 523.25, amp: 0.22 }], 1.4),
        octaves: [run(48000, [{ t: 0.1, f: 110, amp: 0.3 }], 0.8), run(44100, [{ t: 0.1, f: 880, amp: 0.3 }], 0.8)],
        silence: run(48000, [], 2, 0.03),
        range: GunbanNavi.createMicAnalyzer(48000).range,
      };
      const d = window.__delays.slice().sort((a, b) => a - b); out.delayP95 = Math.round(d[Math.floor(d.length * 0.95)] * 1000); out.delayMax = Math.round(d[d.length - 1] * 1000);
      // 따라치기: 같은 음 10개 — 10번 치면 10칸, 한 번 길게 누르면 1칸
      const G = GunbanNavi; const raw = { title: 'rep', tempos: [{ q: 0, bpm: 120 }], measures: [{ num: 1, startQ: 0, lenQ: 10, beats: 10, beatType: 4 }],
        notes: Array.from({ length: 10 }, (_, k) => ({ midi: 60, startQ: k, durQ: 1, staff: 1, hand: 'R', measure: 0 })) };
      setSong(raw, { kind: 'musicxml', name: 'rep', persist: false });
      G.settings.countIn = false; G.setMode('wait'); G.setHands('both'); G.seek(0, false, 'test'); G.play();
      out.waitSetup = true;
      // 같은 음이 두 MIDI 포트에서 거의 동시에 오면 한 번
      const before = G.Input.seq; onMidiMsg({ data: [0x90, 64, 100], target: { id: 'a' } }); onMidiMsg({ data: [0x90, 64, 100], target: { id: 'b' } }); out.dup = G.Input.seq - before;
      // 앱이 방금 낸 소리는 마이크 입력으로 받지 않음
      G.Mic.on = true; G.Mic.cur = null; Sound.recent.set(67, performance.now()); const b2 = G.Input.seq; G.Mic.handle({ type: 'on', midi: 67 }); out.feedback = G.Input.seq - b2;
      Sound.recent.set(67, performance.now() - 1000); G.Mic.handle({ type: 'on', midi: 67 }); out.real = G.Input.seq - b2; G.Mic.handle({ type: 'off', midi: 67 }); G.Mic.on = false;
      return out;
    });
    // 시간이 흐르는 동안: 누른 채로 있으면 1칸, 기다릴 때마다 새로 치면 한 칸씩
    const w = await p.evaluate(async () => {
      const G = GunbanNavi; G.setRate(1.5); G.Input.on(60, 0.7, 'kb');
      await new Promise((r) => setTimeout(r, 900)); const held = G.E.waitIdx; // 0.9초 동안 누르고만 있음
      for (let k = 0; k < 30 && !G.E.finished; k++) { for (let i = 0; i < 50 && !G.E.waiting && !G.E.finished; i++) await new Promise((r) => setTimeout(r, 20)); G.Input.off(60); G.Input.on(60, 0.7, 'kb'); }
      const res = { held, ten: G.E.waitIdx, finished: G.E.finished, mistakes: G.E.mistakes }; G.Input.off(60); G.pause(); return res;
    });
    r.held1 = w.held; r.ten = w.ten;
    const tenA = (a) => a.length === 10 && a.every((m) => m === 69);
    ok('마이크: 같은 음 10번 다시 치기 → 10번 (댐퍼·페달·잡음)', tenA(r.repDamped) && tenA(r.repPedal) && tenA(r.noisyRep), JSON.stringify([r.repDamped.length, r.repPedal.length, r.noisyRep.length]));
    ok('마이크: 길게 누른 음은 1번, 무음·잡음은 0번', JSON.stringify(r.held) === '[69]' && r.silence.length === 0, JSON.stringify([r.held, r.silence]));
    ok('마이크: 이어 치기·소리 커짐·옥타브 구분', JSON.stringify(r.legato) === '[69,72]' && JSON.stringify(r.gpt) === '[69,69]' && JSON.stringify(r.octaves) === '[[45],[81]]', JSON.stringify(r));
    ok('마이크: 타건 → 인식 지연 (합성 소리, 분석만) p95 < 120ms', r.delayP95 < 120, `p95 ${r.delayP95}ms, 최대 ${r.delayMax}ms`);
    ok('마이크 음역 표시값 (약 50~1400Hz)', r.range[0] === 31 && r.range[1] === 89, JSON.stringify(r.range));
    ok('따라치기: 같은 음은 새로 칠 때마다 한 칸, 누르고 있으면 한 칸', r.held1 === 1 && r.ten === 10, JSON.stringify([r.held1, r.ten]));
    ok('두 MIDI 포트의 같은 음은 한 번 / 앱 소리는 마이크로 안 받음', r.dup === 1 && r.feedback === 0 && r.real === 1, JSON.stringify([r.dup, r.feedback, r.real]));
    ok('페이지 오류 없음', errs.length === 0, errs.join(' | ')); await p.close(); }

  // 14-2) 마이크 전체 흐름: 가짜 마이크(합성 소리) → 워클릿 → 워커 분석 → 입력, 권한 거부 안내, 앱 소리 끄고 되돌리기
  { const b2 = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const fake = () => {
      window.__denyMic = false;
      navigator.mediaDevices.getUserMedia = async () => {
        if (window.__denyMic) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
        const ac = new AudioContext(); const dst = ac.createMediaStreamDestination(); const t0 = ac.currentTime + 0.3;
        for (let k = 0; k < 4; k++) { const o = ac.createOscillator(); o.frequency.value = 261.63; const g = ac.createGain(); g.gain.setValueAtTime(0, 0); g.gain.setValueAtTime(0, t0 + k * 0.5); g.gain.linearRampToValueAtTime(0.4, t0 + k * 0.5 + 0.005); g.gain.exponentialRampToValueAtTime(0.01, t0 + k * 0.5 + 0.45); g.gain.setValueAtTime(0, t0 + k * 0.5 + 0.46); o.connect(g); g.connect(dst); o.start(); }
        window.__fakeCtx = ac; return dst.stream;
      };
    };
    const p = await b2.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); await p.addInitScript(fake);
    await p.route('**/*', (r) => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
    await p.goto(PAGE); await p.waitForTimeout(1000);
    const r = await p.evaluate(async () => {
      const G = GunbanNavi; G.settings.accomp = true; G.settings.metro = true;
      const got = []; const orig = window.userNoteOn; const before = G.Input.seq;
      window.__deny = async () => { window.__denyMic = true; await G.Mic.start(); const msg = document.querySelector('#micStatus').textContent; window.__denyMic = false; return msg; };
      const denied = await window.__deny();
      await G.Mic.start(); const mode = G.Mic.mode; const offWhileOn = [G.settings.accomp, G.settings.metro];
      await new Promise((r) => setTimeout(r, 2800));
      const n = G.Input.seq - before; const lat = G.Input.latency(); const status = document.querySelector('#micStatus').textContent;
      const err = G.Mic.workletError; G.Mic.stop(); return { err, denied, mode, n, lat, status, offWhileOn, restored: [G.settings.accomp, G.settings.metro] };
    });
    ok('마이크 권한 거부 안내', /권한이 거부/.test(r.denied), r.denied);
    ok('마이크 전체 흐름: 4번 친 소리 → 입력 4번 (워클릿·워커)', r.n === 4 && /worker\+worklet/.test(r.mode), JSON.stringify([r.mode, r.err, r.n]));
    ok('마이크 켜는 동안 앱 소리 끄고, 끄면 되돌림 · 음역 표시', JSON.stringify(r.offWhileOn) === '[false,false]' && JSON.stringify(r.restored) === '[true,true]' && /1400Hz/.test(r.status), JSON.stringify([r.offWhileOn, r.restored, r.status]));
    ok('페이지 오류 없음 (마이크)', errs.length === 0, errs.join(' | '));
    await b2.close(); }

  // 15) 화음 판정 (이슈 #14 PR 4): 0.2초 안에 함께 쳐야 맞음, 한 음씩 인정 설정, 마이크 화음
  { const { p, errs } = await openPage(browser);
    const r = await p.evaluate(async () => {
      const G = GunbanNavi; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const chordSong = () => setSong({ title: 'c', tempos: [{ q: 0, bpm: 60 }], measures: [{ num: 1, startQ: 0, lenQ: 8, beats: 8, beatType: 4 }],
        notes: [0, 2, 4, 6].flatMap((q) => [48, 60, 64, 67].map((m) => ({ midi: m, startQ: q, durQ: 2, staff: m < 60 ? 2 : 1, hand: m < 60 ? 'L' : 'R', measure: 0 }))) }, { kind: 'musicxml', name: 'c', persist: false });
      const start = async () => { chordSong(); G.settings.countIn = false; G.setMode('wait'); G.setHands('both'); G.setRate(1); G.seek(0, false, 'test'); G.play(); for (let i = 0; i < 200 && !G.E.waiting; i++) await sleep(20); };
      const hit = (ms) => ms.forEach((m) => { G.Input.on(m, 0.7, 'kb'); G.Input.off(m); });
      const out = {};
      G.settings.chordLoose = false; await start();
      hit([48, 60, 64, 67]); out.together = G.E.waitIdx; // 함께 → 1칸
      for (let i = 0; i < 200 && !G.E.waiting; i++) await sleep(20);
      for (const m of [48, 60, 64, 67]) { hit([m]); await sleep(260); } out.apart = G.E.waitIdx; // 0.26초 간격 → 그대로
      hit([48, 60, 64, 67]); out.again = G.E.waitIdx; // 다시 함께 → 진행
      G.pause(); G.settings.chordLoose = true; await start();
      for (const m of [48, 60, 64, 67]) { hit([m]); await sleep(260); } out.loose = G.E.waitIdx; G.pause(); G.settings.chordLoose = false;
      // 마이크 화음 이벤트
      await start(); G.Mic.on = true; const mk = () => G.E.mistakes;
      const ev = (midis) => { G.Mic.handle({ type: 'chord', midis, sounding: midis }); midis.forEach((m) => G.Mic.handle({ type: 'off', midi: m })); };
      ev([48, 60, 64, 67, 79]); out.micExtra = [G.E.waitIdx, mk()]; // 배음 오인(솔5) 하나 섞임 → 진행, 틀린 음 0
      for (let i = 0; i < 200 && !G.E.waiting; i++) await sleep(20);
      out.waitingBeforeWrong = G.E.waiting; ev([48, 60, 64, 69]); out.micWrong = [G.E.waitIdx, mk()]; // 솔 대신 라 → 그대로, 틀린 음으로 세지 않음(불확실)
      ev([50, 65]); out.micAllWrong = [G.E.waitIdx, mk()]; // 맞는 음이 하나도 없음 → 틀린 음 2
      ev([48, 64, 67]); out.micOct = G.E.waitIdx; // 도3+도4 중 도4가 안 들려도 진행 (옥타브 겹침)
      G.Mic.on = false; G.pause();
      // 화음 분석기 (합성 피아노, 화음 모양 400개): 정밀도·재현율
      let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647; const sr = 48000;
      const synth = (notes) => { const n = 4096; const x = new Float32Array(n); for (const m of notes) { const f = 440 * Math.pow(2, (m - 69) / 12); const ph = rnd() * 6.28; for (let h = 1; h <= 10; h++) { const fh = h * f * Math.sqrt(1 + 0.0004 * h * h); if (fh > sr / 2) break; const a = 0.2 / Math.pow(h, 1.1) * (0.6 + 0.8 * rnd()); for (let i = 0; i < n; i++) x[i] += a * Math.sin(2 * Math.PI * fh * i / sr + ph * h); } } return x; };
      const shapes = [[0, 4, 7], [0, 3, 7], [0, 4, 7, 10], [0, 4, 7, 12], [0, 7, 12, 16], [-12, 0, 4, 7], [0, 5, 9], [0, 3, 8], [-12, 0, 7, 16], [0, 4, 7, 11, 14], [0], [0, 12], [0, 7]];
      const A = G.createMicAnalyzer(sr, { poly: true }); let tp = 0, fp = 0, fn = 0, ex = 0; const T = 400; const t0 = performance.now();
      for (let k = 0; k < T; k++) { const sh = shapes[Math.floor(rnd() * shapes.length)]; const root = 48 + Math.floor(rnd() * 20); const truth = sh.map((d) => root + d);
        const est = A.estimatePitches(synth(truth)).map((q) => q.midi); const tr = new Set(truth); let t = 0; est.forEach((m) => (tr.has(m) ? t++ : fp++)); tp += t; fn += truth.length - t; if (t === truth.length && est.length === truth.length) ex++; }
      // 화음 연속 (페달 없음): 화음마다 한 번, 들린 음은 모두 실제로 친 음 / 같은 음 연타도 매번
      const strikeAdd = (x, m, t0, amp, stopAt) => { const f = 440 * Math.pow(2, (m - 69) / 12); const i0 = Math.round(t0 * sr), i1 = stopAt ? Math.round(stopAt * sr) : x.length; const hs = Array.from({ length: 10 }, (_, h) => 1 / Math.pow(h + 1, 1.1) * (0.7 + 0.6 * rnd())); const ph = rnd() * 6;
        for (let i = i0; i < x.length; i++) { const tt = (i - i0) / sr; let env = Math.min(1, tt / 0.005) * Math.exp(-tt / 1.0) * amp; if (i >= i1) env *= Math.exp(-(i - i1) / sr / 0.01); if (tt > 0.01 && env < 1e-5) break; let v = 0; for (let h = 0; h < 10; h++) { if ((h + 1) * f > sr / 2) break; v += hs[h] * Math.sin(2 * Math.PI * (h + 1) * f * tt + ph * (h + 1)); } x[i] += env * v + (tt < 0.004 ? (rnd() * 2 - 1) * 0.3 * amp * (1 - tt / 0.004) : 0); } };
      const runSeq = (chords, gap) => { const x = new Float32Array(Math.round((chords.length * gap + 0.6) * sr)); chords.forEach((c, k) => c.forEach((m) => strikeAdd(x, m, 0.1 + k * gap, 0.12, 0.1 + (k + 1) * gap - 0.03)));
        const B = G.createMicAnalyzer(sr, { poly: true }); const ev = []; for (let i = 0; i + 512 <= x.length; i += 512) ev.push(...B.feed(x.slice(i, i + 512), (i + 512) / sr)); return ev.filter((e) => e.type === 'chord').map((e) => e.midis); };
      const seq = [[48, 60, 64, 67], [53, 60, 65, 69], [55, 59, 62, 67], [48, 60, 64, 67]];
      const got = runSeq(seq, 0.6); out.seq = { n: got.length, subset: got.every((g, k) => seq[k] && g.every((m) => seq[k].includes(m))), got: got.map((g) => g.join(',')) };
      out.single = runSeq([[60], [60], [64], [67]], 0.4).map((g) => g.join(',')).join(' ');
      out.poly = { P: +(tp / (tp + fp)).toFixed(3), R: +(tp / (tp + fn)).toFixed(3), exact: +(ex / T).toFixed(3), msPer: +((performance.now() - t0) / T).toFixed(1) };
      return out;
    });
    ok('화음: 함께 치면 진행, 0.26초씩 떨어져 치면 그대로, 다시 함께 치면 진행', r.together === 1 && r.apart === 1 && r.again === 2, JSON.stringify(r));
    ok('설정 "화음을 한 음씩 쳐도 인정"', r.loose === 1, String(r.loose));
    ok('마이크 화음: 배음 오인 섞여도 진행·틀린 음 0', r.micExtra[0] === 1 && r.micExtra[1] === 0, JSON.stringify(r.micExtra));
    ok('마이크 화음: 한 음 틀리면 머무름(불확실하니 틀린 음으로 안 셈), 맞는 음이 없으면 틀린 음', r.waitingBeforeWrong && r.micWrong[0] === 1 && r.micWrong[1] === 0 && r.micAllWrong[0] === 1 && r.micAllWrong[1] === 2, JSON.stringify([r.micWrong, r.micAllWrong]));
    ok('마이크 화음: 옥타브 겹친 음은 하나만 들려도 진행', r.micOct === 2, String(r.micOct));
    ok('화음 분석기 (합성 화음 400개): 정밀도 ≥ 0.9, 재현율 ≥ 0.8', r.poly.P >= 0.9 && r.poly.R >= 0.8, JSON.stringify(r.poly));
    ok('마이크 화음 흐름: 화음 4번 → 4번, 들린 음은 모두 친 음 / 같은 음 연타', r.seq.n === 4 && r.seq.subset && r.single === '60 60 64 67', JSON.stringify([r.seq, r.single]));
    ok('페이지 오류 없음', errs.length === 0, errs.join(' | ')); await p.close(); }

  // 16) 화면이 아주 작거나 숨겨져도 재생·화면 갱신이 멈추지 않음 (배포본 점검에서 찾은 오류: roundRect 반지름 음수)
  { const { p, errs } = await openPage(browser);
    const r = await p.evaluate(async () => {
      const G = GunbanNavi; G.settings.countIn = false; G.setMode('listen'); G.setRate(1.5); G.seek(0, false, 'test');
      document.querySelectorAll('#fall, #keys').forEach((c) => { c.style.width = '0px'; c.style.height = '0px'; c.parentElement.style.width = '1px'; });
      window.dispatchEvent(new Event('resize')); G.play();
      let thrown = null; for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 20)); try { frame(performance.now()); } catch (e) { thrown = e.message; } }
      const pos = G.E.pos; G.pause(); return { thrown, pos, frameErr: G.PosLog.list.filter((e) => e.reason.startsWith('frame-error')).length };
    });
    ok('화면이 0 크기여도 오류 없이 재생 계속', r.thrown === null && r.pos > 0.3 && r.frameErr === 0, JSON.stringify(r));
    ok('페이지 오류 없음', errs.length === 0, errs.join(' | ')); await p.close(); }

  // 17) 오른쪽 연습 설정 접기 (넓은 화면): 버튼·\ 키, 기억, 좁은 화면에서는 버튼 숨김
  { const { p, errs } = await openPage(browser);
    const w0 = await p.evaluate(() => document.querySelector('#fall').getBoundingClientRect().width);
    await p.click('#sideToggle'); await p.waitForTimeout(400);
    const a = await p.evaluate(() => ({ side: getComputedStyle(document.querySelector('#side')).display, fall: document.querySelector('#fall').getBoundingClientRect().width, text: document.querySelector('#sideToggleText').textContent, exp: document.querySelector('#sideToggle').getAttribute('aria-expanded'), saved: JSON.parse(localStorage.getItem('gunban-navi-v1')).sideCollapsed }));
    await p.reload(); await p.waitForTimeout(1000);
    const kept = await p.evaluate(() => getComputedStyle(document.querySelector('#side')).display);
    await p.keyboard.press('Backslash'); await p.waitForTimeout(300);
    const back = await p.evaluate(() => getComputedStyle(document.querySelector('#side')).display);
    await p.setViewportSize({ width: 600, height: 850 }); await p.waitForTimeout(300);
    const mob = await p.evaluate(() => getComputedStyle(document.querySelector('#sideToggle')).display);
    ok('연습 설정 접기: 접으면 건반·낙하 노트가 넓어짐', a.side === 'none' && a.fall > w0 + 200 && a.text === '설정 펼치기' && a.exp === 'false' && a.saved === true, JSON.stringify([w0, a]));
    ok('접힌 상태 기억 · \\ 키로 펼치기 · 좁은 화면은 기존 설정 버튼', kept === 'none' && back === 'block' && mob === 'none', JSON.stringify([kept, back, mob]));
    ok('페이지 오류 없음', errs.length === 0, errs.join(' | ')); await p.close(); }

  // 13) 악보 커서 ↔ 연주 위치 (OSMD 1.8.9 필요): 못갖춘마디·박자 넘침 마디·도돌이표가 있어도 커서가 연주 위치 마디에 있고 뒤로 가지 않음
  if (fs.existsSync(OSMD_LOCAL)) {
    const { p, errs } = await openPage(browser, { osmd: true });
    const r = await p.evaluate(async () => {
      const N = (st, dur, voice, staff, oct = 4) => `<note><pitch><step>${st}</step><octave>${oct}</octave></pitch><duration>${dur}</duration><voice>${voice}</voice><type>quarter</type><staff>${staff}</staff></note>`;
      const lh = (d) => `<backup><duration>${d}</duration></backup>${N('C', d, 5, 2, 3)}`;
      const xml = `<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list><part id="P1">
        <measure number="0" implicit="yes"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>${N('G', 1, 1, 1)}${lh(1)}</measure>
        <measure number="1">${N('C', 1, 1, 1)}${N('D', 1, 1, 1)}${N('E', 1, 1, 1)}${lh(3)}</measure>
        <measure number="2"><barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>${N('F', 1, 1, 1)}${N('G', 1, 1, 1)}${N('A', 1, 1, 1)}${N('B', 1, 1, 1)}${lh(3)}</measure>
        <measure number="3">${N('C', 1, 1, 1, 5)}${N('B', 1, 1, 1)}${N('A', 1, 1, 1)}${lh(3)}<barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline></measure>
        <measure number="4"><note><grace/><pitch><step>A</step><octave>4</octave></pitch><voice>1</voice><type>eighth</type><staff>1</staff></note>${N('G', 1, 1, 1)}${N('E', 1, 1, 1)}${N('C', 1, 1, 1)}${lh(3)}</measure>
      </part></score-partwise>`;
      const raw = parseMusicXML(xml, { fit: true }); setSong(raw, { kind: 'omr', xml, name: 't', flags: omrFlags(raw), persist: false });
      for (let i = 0; i < 60 && !Score.ready; i++) await new Promise((r) => setTimeout(r, 100));
      if (!Score.ready) return { ready: false };
      const G = GunbanNavi; G.PosLog.list.length = 0; let bad = [];
      for (const st of G.song.steps) {
        G.E.pos = st.start + 1e-4; Score.sync(false);
        const it = Score.osmd.cursor.Iterator || Score.osmd.cursor.iterator;
        const srcM = G.song.measures[st.measure].src; // 도돌이표로 펼친 연주 마디 → 원본 마디
        if (it.CurrentMeasureIndex !== srcM) bad.push([st.measure, srcM, it.CurrentMeasureIndex]);
      }
      return { ready: true, repeats: G.PosLog.list.filter((e) => e.reason === 'repeat').length, steps: G.song.steps.length, cursorSteps: Score.steps.length, lastK: Score.steps[Score.steps.length - 1].k, bad, unexpected: G.PosLog.unexpected().length, flags: raw.fitFlags.map((f) => f.m) };
    });
    ok('악보 커서가 연주 위치 마디와 일치 (못갖춘마디·박자 넘침·도돌이표 펼침·꾸밈음)', r.ready && r.bad.length === 0 && r.unexpected === 0 && r.steps === 21 && r.cursorSteps === 14 && r.repeats === 1, JSON.stringify(r));
    ok('페이지 오류 없음 (악보 그림)', errs.length === 0, errs.join(' | ')); await p.close();
  } else console.log('SKIP  악보 커서 시험 (tests/.cache/osmd-1.8.9.min.js 없음)');

  await browser.close();
  console.log(failed ? `\n${failed}개 실패` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})();
