# 건반 내비

악보를 올리면 **어느 건반을 칠지** 낙하 노트와 건반 불빛으로 보여 주는 초보자용 피아노 연습 앱입니다.
따라치기(맞는 건반을 누를 때까지 기다림), 구간 반복, 속도 조절, 손 분리, 실제 그랜드 피아노 소리를 지원합니다.

- **바로 쓰기:** https://luckydodo777.github.io/curly-octo-sniffle/ (main 이 바뀌고 테스트가 통과하면 자동으로 새 버전이 올라감)
- **내려받아 쓰기:** `dist/건반내비.html`을 크롬에서 열기 (MusicXML·MXL·MIDI 지원)
- **고치기:** `src/` 수정 → `python build.py` → `node tests/run_all.js`
- **공동 작업:** Claude와 GPT가 함께 고칩니다. 규칙은 [`COLLAB.md`](COLLAB.md), 최근 작업은 [`WORKLOG.md`](WORKLOG.md), 구조 설명은 [`HANDOFF_GPT.md`](HANDOFF_GPT.md).
