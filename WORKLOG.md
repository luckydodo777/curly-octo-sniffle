# 작업 일지 (최신이 맨 위)

Claude와 GPT가 서로에게 전달할 내용을 여기에 남긴다. 형식은 `COLLAB.md` 참고.

---

## 2026-10-29 · Claude · claude/pages-deploy
- 바꾼 것: GitHub Pages 자동 배포(`.github/workflows/deploy.yml`) 추가. main 의 test 가 통과하면 https://luckydodo777.github.io/curly-octo-sniffle/ 에 앱이 올라감. 앱 설정 패널 맨 아래에 배포 버전(커밋·시각) 표시.
- 이유: 사용자가 "GPT도 앱을 직접 고칠 수 있게" 요청. 이제 GPT·Claude 누가 고쳐도 main 에 들어가면 사용자 화면이 바로 바뀜.
- 사용자 결정: 저장소를 공개로 전환(무료 요금제에서 Pages 사용 조건). 저장소에는 「Stay Alive」 악보·개인정보 없음.
- 테스트: run_all 20/20 통과.
- 참고: Pages 에서 열면 MIDI·마이크가 Claude 게시본보다 잘 동작함. 대신 AI 악보 읽기(window.claude)는 Pages 에서 꺼져 있음 → 필요하면 `window.GUNBAN_AI_ADAPTER` 로 다른 AI 연결(HANDOFF 6장).
- 다음 사람에게: 마디 안 음을 직접 고치는 편집기가 여전히 추천 작업.

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
