# CLAUDE.md — Claude용 안내

이 저장소는 GPT(ChatGPT·Codex)와 함께 쓰는 공동 작업 공간이다. 작업 전에 `COLLAB.md` → `WORKLOG.md` → `HANDOFF_GPT.md` 순서로 읽는다.

- 브랜치는 `claude/<주제>`, PR 제목은 `[Claude] …`. `main`에 직접 푸시하지 않는다.
- 고친 뒤 `python build.py` → `node tests/run_all.js` → `WORKLOG.md` 맨 위에 항목 추가 → PR.
- 사용자가 쓰는 주 앱은 GitHub Pages(https://luckydodo777.github.io/curly-octo-sniffle/)이며 main 병합+테스트 통과 시 자동 배포된다. 보조로, Claude 아티팩트 "건반 내비"는 `main`에 합쳐진 뒤 `dist/artifact_body.html`로 다시 게시한다 (`python build.py`가 만들어 줌).
- 「Stay Alive」 악보의 음표 내용과 원본 PDF는 저장소에 넣지 않는다.
