# 작업 일지 (최신이 맨 위)

Claude와 GPT가 서로에게 전달할 내용을 여기에 남긴다. 형식은 `COLLAB.md` 참고.

---

## 2026-10-30 · Claude · claude/omr-converter
- 바꾼 것: 토큰 없는 악보 인식 "무료 자동 변환" — Audiveris(오픈소스 OMR)를 GitHub Actions에서 실행. 앱(로그인, Pages)에서 PDF·사진을 올리면 변환 요청 → 몇 분 뒤 "내 악보함"에 MusicXML로 들어옴. 내 악보함에 변환 진행 상황 표시, 끝나면 알림.
- 근거(실측): MuseScore로 만든 공개 악보 PDF를 Audiveris로 다시 읽어 앱 파서로 비교 → 환희의 송가 80/80음, 직접 만든 어려운 연습곡(16분음표·화음·붙임줄·제자리표·셋잇단·2성부) 52/52음 완전 일치. 한 곡 14초. 빠르기표는 못 읽음. 손가락 번호 "3"을 셋잇단으로 오인한 사례 있음(예제 원본은 손가락 번호 제거 후 100%).
- 사용자 할 일: Firebase 서비스 계정 키를 GitHub 비밀값 FIREBASE_SERVICE_ACCOUNT 로 등록 + 최신 firestore.rules 게시 (docs/FIREBASE_SETUP.md 8~9단계).
- 테스트: run_all 39/39, omr-test(실제 Audiveris 왕복 비교)는 CI에서.
- 다음 사람에게: Audiveris 결과에 빠르기표를 넣는 방법(텍스트 인식 또는 사용자 입력 유도) 개선 여지. 여러 페이지/악장 PDF는 첫 결과만 씀(worker.py convert).

## 2026-10-29 · Claude · claude/firebase-config
- 바꾼 것: FIREBASE_CONFIG 에 사용자의 Firebase 프로젝트(rmtlove777) 웹 설정값을 넣어 구글 로그인·내 악보함을 켬. (웹 설정값은 비밀이 아님. 보호는 firestore.rules)
- 확인할 것: 사용자가 Authentication(Google)·승인된 도메인(luckydodo777.github.io)·Firestore(규칙 게시)를 마쳤는지. 배포 후 Pages 주소에서 실제 로그인·저장 확인 필요.
- 테스트: run_all 통과(테스트는 가짜 클라우드를 쓰므로 영향 없음).

## 2026-10-29 · Claude · claude/account-library
- 바꾼 것: 구글 로그인 + "내 악보함" + 연습 기록 (Firebase Auth·Firestore, app.js 14-2 구역). 로그인 상태에서 올린 악보·AI 판독 결과·원본 PDF/사진·빠르기 수정·연습 기록이 계정별로 저장되고, 다른 기기에서도 열 수 있음. "지금 마디 다시 확인"은 새로고침 뒤에도 악보함의 원본을 자동으로 씀.
- 이유: 사용자 요청 "계정별로 로그인해서 업로드한 파일과 기록을 남기고 싶다".
- 아직 꺼져 있음: `FIREBASE_CONFIG`가 비어 있어 로그인 버튼이 숨겨져 있음. 사용자가 docs/FIREBASE_SETUP.md 대로 Firebase 프로젝트를 만들고 값 4개를 주면 켜짐.
- 테스트: run_all 34/34 통과 (계정 기능 14개는 가짜 클라우드로 시험). 실제 Firebase 연결은 아직 시험 못 함.
- 다음 사람에게: 값을 받으면 FIREBASE_CONFIG 에 넣는 PR 하나면 된다. 그 뒤 실제 로그인·저장을 Pages 주소에서 확인할 것.

## 2026-10-29 · Claude · claude/pages-deploy
- 바꾼 것: GitHub Pages 자동 배포(`.github/workflows/deploy.yml`) 추가. main 의 test 가 통과하면 https://luckydodo777.github.io/curly-octo-sniffle/ 에 앱이 올라감. 앱 설정 패널 맨 아래에 배포 버전(커밋·시각) 표시.
- 이유: 사용자가 "GPT도 앱을 직접 고칠 수 있게" 요청. 이제 GPT·Claude 누가 고쳐도 main 에 들어가면 사용자 화면이 바로 바뀜.
- 사용자 결정: 저장소를 공개로 전환(무료 요금제에서 Pages 사용 조건). 저장소에는 「Stay Alive」 악보·개인정보 없음.
- 테스트: run_all 20/20 통과.
- 참고: Pages 에서 열면 MIDI·마이크가 Claude 게시본보다 잘 동작함. 대신 AI 악보 읽기(window.claude)는 Pages 에서 꺼져 있음 → 필요하면 `window.GUNBAN_AI_ADAPTER` 로 다른 AI 연결(HANDOFF 6장).
- 다음 사람에게: 마디 안 음을 직접 고치는 편집기가 여전히 추천 작업.
## 2026-10-29 · Claude · claude/repo-name
- 바꾼 것: GPT_PROMPT.txt 의 저장소 이름을 실제 이름(luckydodo777/curly-octo-sniffle)으로 고침.
- 이유: 사용자가 저장소를 이 이름으로 만들었음. Claude(Claude GitHub 앱)와 GPT(ChatGPT Codex Connector)가 모두 이 저장소에 접근 가능.
- 테스트: 코드 변경 없음. main 첫 커밋의 GitHub Actions 테스트 통과 확인.
- 다음 사람에게: WORKLOG 첫 항목의 "마디 안 음 직접 고치는 편집기"가 다음 추천 작업.

## 2026-10-29 · Claude · 첫 커밋 (main)
- 바꾼 것: 공동 작업용 저장소를 만들었다. 게시본 v7과 같은 코드(빌드 결과가 게시본과 바이트 단위로 동일).
  - 협업 문서: `COLLAB.md`(규칙), `AGENTS.md`(GPT/Codex용), `CLAUDE.md`(Claude용), 이 `WORKLOG.md`.
  - 자동 테스트: 푸시와 PR마다 GitHub Actions가 빌드 → dist 최신 여부 검사 → 테스트 20개를 돌린다.
- 지금까지의 흐름 (자세한 건 `docs/REA_분석_및_설계.md` 1~10장):
  - v1: 범용 앱(MusicXML·MXL·MIDI 직접 파싱, 낙하 노트, 따라치기, 구간 반복, 손 분리, 속도, MIDI/PC키보드/마이크 입력).
  - v2: 악보 커서 버그 수정(OSMD `cursor.reset()` 뒤 iterator가 바뀜).
  - v3–4: 사인파 합성음 → 실제 그랜드 피아노 녹음(Salamander) + 88건반 개별 녹음 선택.
  - v4: AI 판독을 줄 단위로 바꾸고 박자 검사·재요청, 템포·8va·음자리표·잇단음 지원.
  - v5: 업스케일·마디선 분할, 원본 대조, 중복음 제거·멜로디 강조, 빠르기 표 편집.
  - v6: 그림 대 그림 대조(OSMD로 다시 그려 원본과 비교), "지금 마디 다시 확인" 버튼, 판독 규칙 보강.
  - v7: 외부 AI 연결 지점 `window.GUNBAN_AI_ADAPTER` 추가.
- 테스트: `run_all.js` 20/20 통과 (Claude 환경, 네트워크 차단 상태).
- 남은 문제 (우선순위):
  1. 「Stay Alive」 AI 판독 정확도를 실제 악보로 아직 검증 못 함. 사용자가 26–27, 30, 33, 38–39마디 오류를 보고했고, 원인은 판독 오류였다(임시표 유지, 16분↔8분, 붙임줄 누락, 트레몰로).
  2. 도돌이표 펼치기 미구현. 3. 마이크 화음 인식 없음. 4. 악보 편집기 없음.
- 다음 사람에게:
  - 가장 효과가 큰 다음 작업은 **마디 안 음을 직접 고치는 간단 편집기**다. 사용자가 틀린 음을 들었을 때 AI 없이 바로 고칠 수 있게. 데이터는 `current.ai.json.measures[i]`(AI JSON) → `jsonToMusicXML` → `setSong` 흐름을 쓰면 된다 (`recheckMeasure` 참고).
  - 질문: GPT 환경에서 `node tests/run_all.js`를 돌릴 수 있는지 PR에 적어 주면, 이후 작업 분담에 참고하겠다.
