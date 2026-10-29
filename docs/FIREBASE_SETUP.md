# 구글 로그인·내 악보함 켜기 (Firebase 설정)

로그인과 계정별 저장은 Firebase(구글의 무료 로그인·데이터베이스)가 맡는다. 무료 요금제(Spark)로 충분하고 결제 정보가 필요 없다.
설정은 저장소 주인이 한 번만 하면 되고, 끝나면 `src/app.js`의 `FIREBASE_CONFIG`에 값 4개를 넣으면 기능이 켜진다.

1. https://console.firebase.google.com 에서 **프로젝트 추가** → 이름(예: gunban-navi) → Google 애널리틱스는 꺼도 됨 → 만들기
2. **Authentication** → 시작하기 → 로그인 방법(Sign-in method) → **Google** → 사용 설정 → 지원 이메일 선택 → 저장
   - 같은 화면에서 **새 제공업체 추가 → 익명(Anonymous)** → 사용 설정 → 저장. 로그인하지 않은 사람도 악보 파일만 올리면 바로 자동 변환되게 해 준다(이 브라우저 전용 임시 계정). 나중에 구글로 로그인하면 임시 계정의 기록이 구글 계정으로 옮겨진다.
3. Authentication → 설정(Settings) → **승인된 도메인** → 도메인 추가: `luckydodo777.github.io`
4. **Firestore Database** → 데이터베이스 만들기 → 위치 `asia-northeast3 (서울)` → 프로덕션 모드로 시작
5. Firestore → **규칙(Rules)** 탭 → 저장소의 `firestore.rules` 내용을 그대로 붙여 넣고 **게시**
   (로그인한 사람은 자기 데이터만 읽고 쓸 수 있게 하는 규칙)
6. 프로젝트 설정(톱니바퀴) → 일반 → 내 앱 → **웹(</>)** → 앱 닉네임 입력 → 앱 등록 → 나오는 `firebaseConfig`에서 `apiKey`, `authDomain`, `projectId`, `appId` 4개를 복사
7. 그 4개를 `src/app.js` 의 `FIREBASE_CONFIG`에 넣고 `python build.py` → PR (Claude나 GPT에게 값만 알려 줘도 된다)

8. (무료 자동 변환을 쓰려면) **서비스 계정 키를 GitHub 비밀값으로 등록**
   - Firebase 프로젝트 설정(톱니) → **서비스 계정** → **새 비공개 키 생성** → JSON 파일이 내려받아짐
   - GitHub 저장소 → Settings → Secrets and variables → **Actions** → **New repository secret**
     - Name: `FIREBASE_SERVICE_ACCOUNT`
     - Secret: 내려받은 JSON 파일 내용 전체를 붙여 넣기 → Add secret
   - 이 키는 비밀번호와 같다. 채팅·저장소·코드에 절대 붙여 넣지 말고 GitHub 비밀값에만 넣는다. 다 넣었으면 내려받은 파일은 지운다.
   - 9번 규칙도 꼭 다시 게시한다(변환 대기열 규칙이 추가됨).
9. Firestore → 규칙 탭 → 저장소의 최신 `firestore.rules` 내용으로 바꾸고 **게시**

참고
- 웹 설정값(apiKey 등)은 비밀번호가 아니라서 공개 저장소에 있어도 된다. 데이터 보호는 5번 규칙이 한다.
- 로그인은 GitHub Pages 주소에서만 동작한다. Claude 게시본과 내려받은 파일(file://)에서는 로그인 버튼이 숨겨진다.
- 저장 구조: `users/{uid}/songs/{곡}` (+ `chunks/` 큰 데이터 조각, `sessions/` 연습 기록). 원본 PDF·사진은 6MB까지 보관.
