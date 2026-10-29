# 건반 내비 — GPT 인수인계 문서

> 이 문서는 ChatGPT(또는 다른 AI/개발자)가 이 프로젝트를 이어서 고칠 수 있도록 Claude가 작성했다.
> 작성 시점: 2026-10-29 · 기준 버전: 게시본 v6과 같은 코드 (빌드 결과가 게시본과 바이트 단위로 동일함을 확인)

## 1. 무엇을 만드는 앱인가
- 목표: 피아노 악보를 올리면 **어느 건반을 칠지** 낙하 노트와 건반 하이라이트로 보여 주고, 반복 연습·템포 조절로 **초보자도 따라 칠 수 있게** 하는 앱.
- 사용자가 실제로 익히려는 곡: Theishter 편곡 「Stay Alive」(Re:Zero ED2), 46마디, 4플랫, 템포 변화가 많음. **이 PDF는 저작권 때문에 패키지에 넣지 않았다.** 사용자가 직접 갖고 있다.
- 형태: **설치 없이 브라우저에서 열리는 HTML 한 파일** (`dist/건반내비.html`). 서버·빌드 도구 없이 동작한다.

## 2. 폴더 구조
```
gunban-navi/
├─ HANDOFF_GPT.md          ← 이 문서
├─ GPT_PROMPT.txt          ← ChatGPT에 처음 붙여넣을 지시문
├─ build.py                ← src/ + assets/ → dist/ 로 합치기 (파이썬 표준 라이브러리만 사용)
├─ src/
│  ├─ index.html           ← 화면 구조(마크업). @@STYLE / @@SAMPLES / @@SCRIPT 자리표시자 3개
│  ├─ styles.css           ← 디자인 (색은 :root 토큰, 다크모드 포함)
│  └─ app.js               ← 모든 동작 (약 1,700줄, 바닐라 JS, 모듈/번들러 없음)
├─ assets/
│  └─ piano_samples.json   ← 피아노 녹음 (base64 MP3, 약 3MB) — 코드 수정 시 열 필요 없음
├─ dist/
│  ├─ 건반내비.html          ← 완성본 (브라우저에서 바로 열기)
│  └─ artifact_body.html   ← Claude 아티팩트 게시용 본문 (doctype/head 없음)
├─ tests/
│  ├─ run_all.js           ← 자동 테스트 20개 (Playwright)
│  └─ fixtures/            ← test.musicxml, test.mxl, test.mid, synthetic_page.png(합성 악보 이미지)
└─ docs/
   ├─ REA_분석_및_설계.md    ← 유사 앱 분석(REA), 설계, 사용자 피드백 1~4차와 조치 이력
   └─ LICENSES.md          ← 외부 라이브러리·샘플 라이선스
```

**작업 규칙:** `src/`와 `assets/`만 고치고, `python build.py`로 `dist/`를 다시 만든다. `dist/`를 직접 고치지 않는다.

## 3. 빌드와 테스트
```bash
python build.py                       # dist/건반내비.html 생성
npm i playwright && npx playwright install chromium   # 처음 한 번
node tests/run_all.js                 # 20개 테스트, "모두 통과"가 나와야 함
```
- 테스트는 외부 네트워크를 막고 돌린다. 그래서 **악보 그림(OSMD)과 PDF 읽기(pdf.js)는 테스트에서 빠진다** (둘 다 CDN 필요).
- AI 기능은 `window.GUNBAN_AI_ADAPTER` 가짜 구현으로 시험한다 (아래 6장).

## 4. 동작 구조 (app.js 지도)
데이터 흐름: **파일 → 파서 → Song 모델(초 단위 타임라인) → 재생 엔진 → 화면(악보 커서·낙하 노트·건반)**, 입력은 화면 건반·PC 키보드·MIDI·마이크.

| 구역 (app.js 주석 번호) | 주요 함수 | 하는 일 |
|---|---|---|
| 1) MXL 풀기 | `unzip`, `mxlToXml` | .mxl(zip)을 `DecompressionStream`으로 직접 풂 (라이브러리 없음) |
| 2) MusicXML 파서 | `parseMusicXML`, `assignHandsXML` | 노트 목록(4분음표 단위 `startQ/durQ`), 마디, 템포. 붙임줄 합치기, 손 구분(1단=오른손, 2단=왼손) |
| 3) MIDI 파서 | `parseMIDI` | SMF 0/1 직접 해석, 트랙 이름/음높이로 손 구분 |
| 4) JSON→MusicXML | `parseDur`, `repairScore`, `jsonToMusicXML` | AI가 준 간단 JSON을 MusicXML로. 4분음표=840 단위(3·5·7잇단음 정수). **마디 박자 검사·복구**, 8va, 음자리표·템포·조표 변화, 잇단음 표시 |
| 5) Song 모델 | `buildSong` | 템포 맵 → 초 단위, 같은 순간 중복음 제거, 화음 음량 균형(멜로디 강조), 화음 단위 `steps`, `tempoMarks` |
| 6) 예제 곡 | `ODE` | 환희의 송가(퍼블릭 도메인) 손가락 번호 포함 |
| 7) 소리 | `Sound` | Web Audio 샘플 재생. 세트 2개: `sal`(Salamander 그랜드, 30음) / `key`(88건반 개별). 리미터·잔향·댐퍼 |
| 8) 엔진 | `advance`, `fireNotes`, `stepSatisfied`, `seek` | 재생 위치 `E.pos`(초), 따라치기(대기) 판정, 구간 반복, 준비 박자, 메트로놈, 점진적 가속 |
| 9) 입력 | `userNoteOn/Off`, `connectMIDI`, `Mic` | 화면 건반(멀티터치), PC 키보드(`e.code` 기준이라 한글 입력 상태에서도 동작), Web MIDI, 마이크 단음 인식 |
| 10) 악보 그리기 | `Score` | OSMD(CDN)로 악보 렌더, 커서 동기화(마디+마디 내 위치로 맞춤), 구간·확인필요 마디 음영 |
| 11) 렌더러 | `drawFall`, `drawKeys` | 캔버스 낙하 노트와 건반 |
| 12~13) 루프·UI | `frame`, `setMode`, `setLoop` … | 화면 바인딩 |
| 14) 곡 불러오기 | `setSong`, `openFile`, `renderFlags`, `renderTempos`, `rebuildTiming` | 곡 교체, 확인필요/고친 마디 버튼, 빠르기 표 수정, localStorage 저장·복원 |
| 15) AI 악보 읽기 | `fileToPages` → `pagesToSystems` → `systemPrompt` → `repairScore` → `verifySystem` | PDF·사진 업스케일·선명화 → 오선/큰보표 검출(`detectSystems`) → 마디선 검출(`findBarlines`) → 줄 단위로 AI 판독 → 박자 검사·재요청 → **앱이 읽은 결과를 OSMD로 그림으로 그려 원본과 나란히 비교**(`renderTranscriptionPNG`, `verifyPrompt`) → 보고서 |
| 15-2) 다시 확인 | `recheckMeasure` | 현재 마디가 속한 줄만 원본과 다시 비교해 고침 |

### 핵심 데이터 형식
- **Song 노트:** `{ midi, startQ, durQ, start, end(초), hand:"R"|"L", finger, measure, vel }`
- **AI JSON(악보 한 마디):** `{ rh:[ev], lh:[ev], rh2?, lh2?, time?:[b,bt], fifths?, bpm?, rhClef?:"G"|"F", lhClef?, rh8va?:1|-1, lh8va? }`
  - `ev = { p:"E4" | ["C4","E4"] | "r", d:"q"|"h."|"e3"|"s", tup?:[5,4], f?:3, tie?:true }`
  - 음높이는 **적힌 음(written pitch)**, 8va는 `rh8va`로 따로. 임시표는 마디 끝까지 유지된 결과를 적는다.

## 5. 지켜야 할 제약
1. **한 파일 HTML 유지.** 외부 스크립트는 CDN에서만: OSMD `opensheetmusicdisplay@1.8.9` (jsDelivr), pdf.js `3.11.174` (cdnjs). 버전은 고정. Claude 아티팩트로 다시 게시할 경우 CSP 때문에 **스크립트 이외의 외부 요청(fetch·이미지·오디오)은 막힌다** → 샘플·데이터는 파일 안에 넣어야 한다.
2. **피아노 샘플은 base64로 내장.** `assets/piano_samples.json` 구조: `{ sal:{midi:b64mp3}, key:{midi:b64mp3}, keyGain:{midi:gain} }`.
3. **저작권:** 「Stay Alive」 악보 내용(음표)을 코드·테스트·예제에 넣지 말 것. 예제·테스트는 퍼블릭 도메인 곡이나 합성 데이터만.
4. **초보자용 UI:** 한국어 문구, 계이름(도레미) 기본, 손가락 번호, 오른손=하늘색 / 왼손=주황.
5. 모든 `localStorage` 접근은 try/catch (사생활 보호 모드 대비).
6. 테스트(`node tests/run_all.js`)를 모두 통과시킨 뒤 넘길 것.

## 6. AI 악보 읽기를 다른 환경에서 쓰려면
현재 AI 호출은 Claude 아티팩트 기능(`window.claude.use("sample")`)을 쓴다. **ChatGPT나 일반 웹에서는 이 기능이 없어서 PDF·사진 읽기가 꺼진다** (MusicXML·MIDI는 그대로 동작).
다른 AI를 붙이려면 앱 스크립트보다 먼저 아래 객체를 정의하면 된다 (`getSample()`이 이걸 우선 사용):
```js
window.GUNBAN_AI_ADAPTER = {
  async limits() { return { images: { maxCount: 5 } }; },
  // prompt: 문자열, opts.images: Blob[] (JPEG), opts.signal: AbortSignal, opts.onText?: ({text}) => void
  async json(prompt, opts) { /* 비전 모델 호출 → 응답의 JSON 객체를 돌려준다 */ },
};
```
- 실패 시 `{ code: "cancelled" | "not_granted" | "rate_limited" | "invalid_json" }` 형태로 throw 하면 앱이 알맞은 안내를 띄운다.
- **API 키를 HTML에 직접 넣지 말 것** (파일을 공유하면 키가 노출됨). 서버 프록시나 사용자 입력 방식을 쓸 것.

## 7. 현재 상태와 알려진 문제 (우선순위 순)
1. **AI 판독 정확도가 핵심 과제.** 사용자가 「Stay Alive」에서 지적한 오류는 모두 판독 오류였다(재생 엔진은 정상): 임시표(♮) 유지 실패, 왼손 16분음표를 8분으로 읽음, 붙임줄 누락으로 같은 음 재타건, 트레몰로 처리. v6에서 **그림 대 그림 대조**와 **"지금 마디 다시 확인"**을 넣었지만 **실제 악보로 정확도를 아직 검증하지 못했다.**
2. 가장 확실한 대안: 악보 원본이 MuseScore 2.1로 만든 것이라 musescore.com 원본에서 MusicXML을 받으면 오류 0. 또는 MuseScore 4 PDF 가져오기/Audiveris/homr로 변환 후 수정.
3. 도돌이표·D.S./Coda는 펼치지 않는다(처음부터 끝까지 한 번).
4. 마이크는 단음만 인식. 화음 인식은 미구현.
5. 게시된 Claude 아티팩트에서는 브라우저 정책상 MIDI/마이크가 막힐 수 있음 → `dist/건반내비.html`을 크롬에서 직접 열면 됨(이때는 AI 읽기 없음).
6. 악보 편집 기능 없음 → 틀린 음은 "MusicXML 저장" 후 MuseScore에서 고쳐 다시 올리는 흐름.

## 8. 다음에 할 만한 일
- 마디 안 음 하나를 직접 고치는 간단 편집기(음 클릭 → 음높이/길이 변경 → `ai.json` 갱신 → `jsonToMusicXML`).
- 도돌이표 펼치기(OSMD의 반복 정보 또는 MusicXML `<repeat>`/`<ending>` 해석).
- 화음 마이크 인식(예: basic-pitch 계열 모델).
- 연습 기록(마디별 틀린 횟수) 저장과 "약한 마디 자동 반복".
