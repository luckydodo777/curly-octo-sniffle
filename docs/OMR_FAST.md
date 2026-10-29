# 변환 바로 시작하기 (완전 무료, 카드 등록 없음)

악보(PDF·사진)를 올리면 앱이 작은 중계기(Cloudflare Worker)에 알리고, 중계기가 GitHub의 무료 변환(Audiveris, omr.yml)을 **즉시** 실행시킨다.
- 업로드 → 악보가 열릴 때까지 **약 1~2분** (중계기가 없으면 GitHub 5분 예약 실행을 기다려 5~30분 이상)
- 한 번 실행되면 10분 동안 5초마다 새 작업을 확인하므로, 이어서 올린 악보는 **15~30초** 안에 처리된다
- 정확도: 무료로 쓸 수 있는 악보 인식 중 가장 정확한 Audiveris 5.11 (시험 악보 132/132음 일치). 빠르기표는 읽지 못하니 설정 → 빠르기에서 고친다
- 비용: Cloudflare Workers 무료 플랜(하루 10만 요청), GitHub Actions(공개 저장소 무료). 둘 다 카드 등록 없음

## 사용자가 한 번만 할 일 (약 10분)

### 1. GitHub 토큰 만들기 (이 저장소의 "변환 실행" 권한만)
1. https://github.com/settings/personal-access-tokens/new 접속 (luckydodo777 계정)
2. Token name: `gunban-kick`, Expiration: 가장 긴 기간(예: 1년)
3. Repository access: **Only select repositories** → `curly-octo-sniffle`
4. Permissions → Repository permissions → **Actions: Read and write** (다른 권한은 건드리지 않음)
5. Generate token → 토큰 복사 ⚠️ 채팅·코드에 붙이지 말 것

### 2. Cloudflare 중계기 만들기
1. https://dash.cloudflare.com/sign-up 에서 무료 가입 (이메일 인증)
2. 왼쪽 메뉴 **Workers & Pages**(또는 Compute → Workers) → **Create** → **Hello World** 시작 → 이름 `gunban-kick` → **Deploy**
3. **Edit code** → 기존 내용을 모두 지우고 저장소의 `relay/kick-worker.js` 내용을 붙여 넣기 → **Deploy**
4. 이 Worker의 **Settings → Variables and Secrets → Add** → Type: **Secret**, Name: `GH_TOKEN`, Value: 1단계 토큰 → **Deploy**
5. 화면에 나온 주소(`https://gunban-kick.○○○.workers.dev`)를 Claude/GPT에게 알려 주기 → `src/app.js` 의 `OMR_KICK_URL` 에 넣는다

### 확인
- 주소를 브라우저로 열면 `{"ok":true,"hint":"건반 내비 변환 중계기"}` 가 보이면 정상
- 앱에서 악보를 올리면 GitHub Actions → omr 실행이 바로 생긴다

## 보안 메모
- 토큰은 Cloudflare Secret 에만 있다(저장소·앱에는 없음). 권한은 이 저장소의 Actions 실행뿐이다.
- 중계기는 앱 주소(luckydodo777.github.io)에서 온 요청만 받고, 20초 안의 중복 요청은 한 번으로 친다. 누가 억지로 호출해도 대기열이 비어 있으면 실행은 몇 초 만에 끝난다.
