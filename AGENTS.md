# AGENTS.md — GPT/Codex용 안내

이 저장소는 Claude와 함께 쓰는 공동 작업 공간이다. 작업 전에 반드시 다음 순서로 읽어라.

1. `COLLAB.md` — 협업 규칙 (브랜치 `gpt/<주제>`, PR, WORKLOG 작성)
2. `WORKLOG.md` — 최근 작업과 Claude가 남긴 다음 할 일·질문
3. `HANDOFF_GPT.md` — 앱 구조, 데이터 형식, 제약, 알려진 문제

## 빌드·테스트
```bash
python build.py                 # src/ + assets/ → dist/건반내비.html
npm install --no-save playwright@1.48.2 && npx playwright install chromium
node tests/run_all.js           # 39개 테스트
```

## 실제 앱(사용자가 쓰는 화면)
- 주소: https://luckydodo777.github.io/curly-octo-sniffle/
- `main`에 합쳐지고 자동 테스트(test)가 통과하면 `deploy` 워크플로가 몇 분 안에 이 주소를 새 버전으로 바꾼다. 즉 **네가 고친 코드가 main에 들어가면 사용자가 보는 앱이 바로 바뀐다.**
- 그러니 테스트를 깨는 변경은 절대 main에 넣지 말 것. 앱 설정 패널 맨 아래에 배포된 커밋 번호와 시각이 표시된다.

## 규칙 요약
- 고칠 파일: `src/app.js`, `src/styles.css`, `src/index.html`, `tests/run_all.js`. `assets/piano_samples.json`(3MB 샘플)은 열지 말 것.
- `dist/건반내비.html`은 `python build.py`로만 만들고 함께 커밋 (CI가 검사함).
- 「Stay Alive」 악보의 음표 내용, 원본 PDF, API 키를 커밋하지 말 것.
- 끝나면 `WORKLOG.md` 맨 위에 항목을 추가하고, PR 제목은 `[GPT] …`.
