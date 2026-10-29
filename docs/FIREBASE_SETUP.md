# 구글 로그인·내 악보함 켜기 (Firebase 설정)

로그인과 계정별 저장은 Firebase(구글의 무료 로그인·데이터베이스)가 맡는다. 무료 요금제(Spark)로 충분하고 결제 정보가 필요 없다.
설정은 저장소 주인이 한 번만 하면 되고, 끝나면 `src/app.js`의 `FIREBASE_CONFIG`에 값 4개를 넣으면 기능이 켜진다.

1. https://console.firebase.google.com 에서 **프로젝트 추가** → 이름(예: gunban-navi) → Google 애널리틱스는 꺼도 됨 → 만들기
2. **Authentication** → 시작하기 → 로그인 방법(Sign-in method) → **Google** → 사용 설정 → 지원 이메일 선택 → 저장
3. Authentication → 설정(Settings) → **승인된 도메인** → 도메인 추가: `luckydodo777.github.io`
4. **Firestore Database** → 데이터베이스 만들기 → 위치 `asia-northeast3 (서울)` → 프로덕션 모드로 시작
5. Firestore → **규칙(Rules)** 탭 → 저장소의 `firestore.rules` 내용을 그대로 붙여 넣고 **게시**
   (로그인한 사람은 자기 데이터만 읽고 쓸 수 있게 하는 규칙)
6. 프로젝트 설정(톱니바퀴) → 일반 → 내 앱 → **웹(</>)** → 앱 닉네임 입력 → 앱 등록 → 나오는 `firebaseConfig`에서 `apiKey`, `authDomain`, `projectId`, `appId` 4개를 복사
7. 그 4개를 `src/app.js` 의 `FIREBASE_CONFIG`에 넣고 `python build.py` → PR (Claude나 GPT에게 값만 알려 줘도 된다)

참고
- 웹 설정값(apiKey 등)은 비밀번호가 아니라서 공개 저장소에 있어도 된다. 데이터 보호는 5번 규칙이 한다.
- 로그인은 GitHub Pages 주소에서만 동작한다. Claude 게시본과 내려받은 파일(file://)에서는 로그인 버튼이 숨겨진다.
- 저장 구조: `users/{uid}/songs/{곡}` (+ `chunks/` 큰 데이터 조각, `sessions/` 연습 기록). 원본 PDF·사진은 6MB까지 보관.
