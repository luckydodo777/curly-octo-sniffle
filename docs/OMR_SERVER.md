# (유료 선택지) 전용 악보 변환 서버 — Hugging Face Space

> ⚠️ 2026년 여름부터 Hugging Face에서 Docker Space를 새로 만들려면 **PRO(유료) 요금제**가 필요하다. 무료로는 [OMR_FAST.md](OMR_FAST.md)(중계기 + GitHub Actions, 1~2분)를 쓴다.
> 이 서버를 켜면 업로드 → 결과가 10~20초로 더 빨라진다. 코드와 시험(omr-test의 Docker 왕복)은 그대로 유지한다.

PDF·사진 악보를 올리면 앱이 이 서버로 바로 보내고, 보통 **20~40초** 안에 악보가 열린다.
(예전 방식은 GitHub 예약 실행을 기다려야 해서 5~30분 이상 걸릴 수 있었다. 서버를 못 쓰면 앱이 예전 방식으로 자동 전환한다.)

- 엔진: Audiveris 5.11 (오픈소스 악보 인식, AI 토큰 사용 없음)
- 비용: PRO 요금제 필요(하드웨어 CPU Basic 자체는 무료). 48시간 동안 아무도 안 쓰면 잠들고, 다음 첫 변환만 1분쯤 더 걸린다(앱이 열릴 때 미리 깨움).
- 개인정보: 올린 파일은 변환이 끝나면 서버에서 바로 지워진다. 결과 악보는 로그인한 경우에만 "내 악보함"(Firebase)에 저장된다.

## 사용자가 한 번만 할 일
1. https://huggingface.co/join 에서 무료 가입 (이메일 인증까지)
2. 오른쪽 위 프로필 → **Settings → Access Tokens → Create new token**
   - Token type: **Write**, 이름: `gunban-omr` → Create → 토큰 복사
   - ⚠️ 토큰은 채팅·코드에 붙이지 말 것
3. GitHub 저장소 → **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `HF_TOKEN`, Secret: 복사한 토큰 → Add secret
4. GitHub 저장소 → **Actions → hf-deploy → Run workflow** (처음 한 번. 이후 omr/ 가 바뀌면 자동)
   - 로그 끝에 "앱에 넣을 주소: https://아이디-gunban-omr.hf.space" 가 나온다
   - Hugging Face에서 Space가 처음 만들어질 때 5~10분 빌드된다 (Space 페이지에 Running 이 뜨면 완료)
5. Hugging Face 아이디를 Claude/GPT에게 알려 주면 `src/app.js` 의 `OMR_SERVER_URL` 에 주소를 넣는다.

## 구조
- `omr/server.py` — HTTP 서버. `GET /health`, `POST /convert`(본문=파일 그대로, 헤더 `X-File-Name`) → `{xml, info}`
- `omr/worker.py` — Audiveris 실행(`convert`), GitHub Actions 예비 작업자와 공유
- `omr/Dockerfile` — Ubuntu 24.04 + Audiveris deb + xvfb, 포트 7860, uid 1000
- `omr/deploy_hf.py` + `.github/workflows/hf-deploy.yml` — Space 생성/갱신
- 시험: `omr-test.yml` 이 Docker 이미지를 실제로 만들어 같은 방식으로 POST 하고 원본과 음 단위로 비교한다.
