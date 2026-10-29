// 사용: node tests/omr_compare.js <원본 musicxml 폴더> <변환 결과 폴더>
// 앱의 파서로 두 악보를 읽어 음(높이·시작·길이·손)을 비교한다. 하나라도 다르면 실패.
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
(async () => {
  const [srcDir, outDir] = process.argv.slice(2);
  const b = await chromium.launch(); const p = await b.newPage();
  await p.route('**/*', (r) => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await p.goto('file://' + path.resolve(__dirname, '../dist/건반내비.html')); await p.waitForTimeout(800);
  let bad = 0;
  for (const f of fs.readdirSync(srcDir).filter((x) => x.endsWith('.musicxml'))) {
    const outF = path.join(outDir, f); if (!fs.existsSync(outF)) { console.log(`FAIL ${f}: 변환 결과 없음`); bad++; continue; }
    const r = await p.evaluate(([A, B]) => {
      const sa = buildSong(parseMusicXML(A), {}), sb = buildSong(parseMusicXML(B), {});
      const key = (n) => `${n.midi}@${n.startQ.toFixed(3)}/${n.durQ.toFixed(3)}/${n.hand}`;
      const kb = new Set(sb.notes.map(key)); const miss = sa.notes.map(key).filter((k) => !kb.has(k));
      return { orig: sa.notes.length, omr: sb.notes.length, exact: sa.notes.length - miss.length, measures: [sa.measures.length, sb.measures.length], miss: miss.slice(0, 5) };
    }, [fs.readFileSync(path.join(srcDir, f), 'utf8'), fs.readFileSync(outF, 'utf8')]);
    const ok = r.exact === r.orig && r.omr === r.orig && r.measures[0] === r.measures[1];
    if (!ok) bad++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${f}: 음 ${r.exact}/${r.orig} 일치 (변환 ${r.omr}음), 마디 ${r.measures.join('→')}${r.miss.length ? ' 예: ' + r.miss.join(', ') : ''}`);
  }
  await b.close(); process.exit(bad ? 1 : 0);
})();
