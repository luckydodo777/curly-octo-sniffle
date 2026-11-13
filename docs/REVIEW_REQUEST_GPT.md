# 검수·개선 요청서 (Claude → GPT)

> 작성: Claude · 2026-11-13 · 기준: `main` (PR #12 병합 후)
> 범위: 2026-10-30에 Claude가 만든 **"악보 파일만 올리면 자동 변환"** 기능 전체 (PR #7 ~ #12)
> 부탁: 아래 "검수 체크리스트"를 확인하고, 문제를 찾으면 `gpt/<주제>` 브랜치에서 고친 뒤 `[GPT]` PR로 올려 주세요. 고치기 애매한 것은 `WORKLOG.md`에 "질문:"으로 남겨 주세요.

먼저 `AGENTS.md` → `COLLAB.md` → `WORKLOG.md` → `HANDOFF_GPT.md`를 읽고 이 문서를 보세요.

---

## 1. 한 줄 요약
웹 앱(GitHub Pages)에서 PDF·사진 악보를 올리면, **로그인·버튼 없이** 자동으로 무료 악보 인식(Audiveris)을 돌려 1~4분 안에 악보를 열어 준다. AI 토큰은 쓰지 않는다.

## 2. 전체 흐름

```
[브라우저: 건반 내비]
  ① PDF/사진 업로드 (openFile → autoConvert)
  ② Firebase 익명 로그인 (Library.ensureUser) ─ 구글 로그인하면 linkWithPopup으로 기록 이어 붙임
  ③ Firestore에 작업 저장 (Library.submitOmr)
       users/{uid}/omrJobs/{id} + chunks/orig_N (원본 base64, 30만 자씩)
       omrQueue/{id} = {uid, createdAt}
  ④ 중계기 호출 POST OMR_KICK_URL ──▶ [Cloudflare Worker: relay/kick-worker.js]
                                          └▶ GitHub API workflow_dispatch(omr.yml)
  ⑤ 화면 위 진행 표시 (Convert.poll, 4~10초 간격, localStorage로 새로고침 후에도 이어서)

[GitHub Actions: .github/workflows/omr.yml]  (중계기 즉시 실행 + 5분 cron 예비)
  python omr/worker.py --run --linger 600
    대기열 확인 → Audiveris 변환(omr/worker.py convert)
      PDF는 첫 쪽 오선 간격을 재서 DPI 자동 선택 (postprocess.pick_pdf_dpi)
    → 다듬기 (omr/postprocess.py polish)
      빠르기표: PDF 글자층에서 읽어 해당 마디에 넣기 (add_tempos)
      박자표: 누락·오독 구간을 마디 길이로 추정해 고치기 (fix_time)
      제목: 파일 이름 (set_title)
    → users/{uid}/songs/{새 id} (kind "omr") 저장, 작업 상태 done/failed
    → 10분 동안 5초마다 새 작업 확인 (이어 올린 악보는 빠르게)

[브라우저] ⑥ 작업 done → Library.open(songId) 자동 열기
  parseMusicXML(xml, { fit: true }): 박자가 넘치는 성부만 마디 길이에 맞추고
  맞춘 마디·음이 빠진 마디를 "확인 필요"로 표시
  악보 그림(OSMD)이 실패하면 8va 등 표시를 덜어 내고 다시 그리기 (Score.show)
```

예비/유료 경로: `OMR_SERVER_URL`을 채우면 위 대기열 대신 **전용 HTTP 변환 서버**(`omr/server.py` + `omr/Dockerfile`, Hugging Face Docker Space)로 바로 보낸다(10~20초). Hugging Face Docker Space는 2026년 여름부터 **PRO(유료)**가 필요해서 지금은 비어 있다. 코드와 CI 시험(Docker 왕복)은 유지 중.

## 3. PR별로 바뀐 것

| PR | 내용 | 주요 파일 |
|---|---|---|
| #7 | 업로드만 하면 자동 변환. 익명 로그인, 진행 표시 칩(`#omrChip`), 완료 시 자동 열기, MuseScore 안내 창 제거. worker `--linger` | `src/app.js`(Convert, autoConvert, firebaseBackend), `src/index.html`, `src/styles.css`, `omr/worker.py` |
| #8 (#9에 포함) | Firebase 로그인 오류 코드를 쉬운 안내로 (`authErrorText`) | `src/app.js` |
| #9 | Cloudflare 중계기(즉시 실행), omr.yml 속도 개선(pip 캐시, xvfb 설치 생략), HF 변환 서버(유료 선택지) | `relay/kick-worker.js`, `omr/server.py`, `omr/Dockerfile`, `omr/deploy_hf.py`, `.github/workflows/{omr,omr-test,hf-deploy}.yml`, `docs/OMR_FAST.md`, `docs/OMR_SERVER.md` |
| #10 | 중계기 주소 연결 (`OMR_KICK_URL`) | `src/app.js` |
| #11 | 변환 악보 제목이 "제목 없는 악보"일 때 파일 이름 사용 | `src/app.js`(Library.open) |
| #12 | **정확도 개선**: DPI 자동 선택, 빠르기표·박자표 보정, 마디 길이 맞춤 + 확인 필요 표시, OSMD 그리기 실패 대비 | `omr/postprocess.py`(신규), `omr/worker.py`, `src/app.js`(parseMusicXML fit, Score.show), `tests/run_all.js` |

## 4. 코드 위치 (2026-11-13 main 기준 줄 번호, 바뀔 수 있음)

`src/app.js`
- `parseMusicXML(xmlText, opts)` 83행 — `opts.fit` 처리 160~170행, 반환값 `fitFlags`
- `Score.show(xml)` 838행 — 그리기 실패 시 단계적 재시도(`variants`)
- `OMR_SERVER_URL` / `OMR_KICK_URL` 1328~1331행
- `firebaseBackend` 1334행 (`signInAnon`, 익명→구글 `linkWithPopup`)
- `Library` 1364행 — `ensureUser` 1379, `open` ~1430, `submitOmr` 1470
- `authErrorText` 1578행
- `Convert`(진행 표시·폴링) 1963행, `serverConvert` 1991행, `autoConvert` 2022행

`omr/`
- `worker.py` — `convert`(Audiveris 실행·DPI·다듬기), `run_mode`/`process_queue`(Firestore 대기열), `--local`(Firebase 없이 시험)
- `postprocess.py` — `pdf_tempos`, `layout`, `add_tempos`, `fix_time`, `set_title`, `polish`, `staff_interline`, `pick_pdf_dpi`
- `server.py` — HTTP 변환 서버(유료 선택지)

`relay/kick-worker.js` — Cloudflare Worker 원본(배포본은 사용자 Cloudflare 계정에 붙여 넣은 사본. 비밀값 `GH_TOKEN`은 Cloudflare에만 있음)

## 5. 검증된 것 (근거)

| 항목 | 결과 | 근거 |
|---|---|---|
| 앱 자동 테스트 | 48개 통과 | `node tests/run_all.js`, CI `test` |
| 변환 왕복 (MuseScore로 만든 PDF 2개) | 음 80/80, 52/52 일치 | CI `omr-test` (`tests/omr_compare.js`) |
| Docker 변환 서버 왕복 | 같은 결과, 한 장당 약 10~12초 | CI `omr-test` Docker 단계 |
| 배포본 전체 흐름 (실제 Firebase + 중계기 + Actions) | 사진 1장 업로드 → 자동으로 열림까지 **40초** | 2026-10-30 Claude가 배포본에서 직접 실행 |
| 9쪽 Sibelius 피아노 악보 PDF (사용자 소유, 저작권 때문에 저장소에 없음) | 기본 300DPI: 음 1158개, 박자 오류 64마디, 12/8을 3/8로 오독, 그림 실패 → 개선 후 400DPI: 음 2844개, 박자 오류 39마디, 12/8 복원, 빠르기표 3개(1·110·129마디) 정확한 위치, 그림 정상 | Claude 로컬 실행(Audiveris 5.11, 변환 216초) + OSMD 1.8.9 렌더 확인 |

## 6. 알려진 문제·한계 (Claude가 스스로 찾은 것)

1. **Audiveris가 박자표 변화를 놓치면 그 뒤 마디의 음이 빠진다.** 위 9쪽 악보 89마디(6/8 → 12/8 복귀)를 놓쳐서 89마디 이후 각 마디의 뒤쪽 절반이 사라졌다. 남은 음이 6/8 길이에 딱 맞아 `fit` 검사로도 "확인 필요"에 안 잡힌다. 후처리로는 복구 불가.
2. **CI가 400DPI 경로와 `fix_time`·`add_tempos` 위치 계산을 시험하지 않는다.** CI 시험 악보(MuseScore)는 오선이 커서 300DPI 경로만 탄다. `postprocess.py`의 파이썬 단위 테스트가 없다.
3. **`postprocess.py`는 정규식으로 XML을 다룬다.** 파트가 여러 개이거나 Audiveris가 다른 형태를 내보내면 깨질 수 있다. `layout()`은 첫 파트만 보고, 오선 높이를 40 tenths로 가정한다.
4. **`fix_time` 휴리스틱**: 구간 마디 길이의 최빈값 비율 ≥ 0.4일 때만 고친다. 겹박자(6/8·12/8) 판단은 "빠르기표에 점음표가 있는가"뿐이다. 3/4와 6/8을 구분할 근거가 약하다.
5. **`parseMusicXML` fit 휴리스틱**: 넘치는 성부 전체를 비율로 줄인다. 마디를 넘는 붙임줄, 잇단음, 장식음과의 상호작용은 시험하지 않았다. 박이 부족한 성부만 있고 다른 성부가 꽉 차면 "음이 빠졌을 수 있음"으로 잡히지 않는다.
6. **8va 처리**: Audiveris가 원본에 없는 8vb를 넣는 경우를 봤다(그림에만 영향). 반대로 진짜 8va 구간에서 Audiveris의 `<pitch>`가 실제 소리 높이인지 적힌 높이인지 확인하지 않았다. 앱 파서는 `<octave-shift>`를 무시한다.
7. **빠르기 표 버튼의 마디 번호**는 마디 순번(index+1)이라, Audiveris가 마디 번호를 건너뛰면(예: 95, 106 누락) 악보 번호와 어긋나 보인다.
8. **보안·남용**
   - 익명 계정 누구나 `omrQueue`에 작업을 만들 수 있다. `firestore.rules`에 문서 크기·개수 제한이 없다(클라이언트에서 6MB 제한만).
   - 중계기 URL은 공개다. Origin 검사는 브라우저 밖에서 우회 가능하고, 20초 중복 방지는 Worker 인스턴스별 메모리라 완벽하지 않다(대기열이 비면 실행은 몇 초 만에 끝남).
   - GitHub Actions를 사실상 변환 백엔드로 쓰고 있다. GitHub Actions 이용 약관의 "serverless computing" 금지 조항과 충돌할 소지가 있다. 장기적으로는 별도 서버가 맞다.
9. **처리 시간**: 9쪽 악보는 로컬에서 Audiveris만 216초 걸렸다. Actions(4코어)에서의 실측은 없다.
10. **OSMD 그리기 실패 대비 코드**는 CDN이 막힌 테스트 환경 때문에 자동 테스트가 없다(Claude가 로컬에서 OSMD를 받아 수동 확인만 함).

## 7. 검수 체크리스트 (GPT에게 부탁)

**정확성**
- [ ] `parseMusicXML` fit: 붙임줄·잇단음·여러 성부·화음이 섞인 마디에서 음 순서와 손 구분이 유지되는가? 반례 테스트를 `tests/run_all.js`에 추가해 주세요.
- [ ] `fix_time`: 못갖춘마디(첫 마디 `implicit`), 중간 박자 변화, 3/4 대 6/8에서 잘못 고치는 경우가 있는가?
- [ ] `add_tempos`/`layout`: 쪽이 바뀌는 곳, 한 줄에 마디가 많은 경우, 여러 파트일 때 마디 배치가 맞는가?
- [ ] `pick_pdf_dpi`: 가로 악보, 첫 쪽이 표지인 PDF, 스캔 PDF(기울어짐)에서 오선 간격 측정이 엉뚱하지 않은가?
- [ ] 8va 구간에서 Audiveris 출력 음높이가 앱에서 맞게 들리는가?

**안정성·보안**
- [ ] `firestore.rules`: omrQueue·omrJobs 크기/필드 검증 추가가 필요한가?
- [ ] `relay/kick-worker.js`: 남용 방지를 더 단단하게 할 방법 (예: Firestore에 실제 대기 작업이 있을 때만 실행)
- [ ] `omr.yml`: 동시 실행·linger·실패 처리에 빈틈이 없는가? 같은 작업을 두 번 처리할 가능성은?
- [ ] 익명 → 구글 계정 연결(`linkWithPopup`)에서 이미 있는 구글 계정이면 임시 계정 기록이 버려지는데, 옮겨 줄 필요가 있는가?

**코드 품질**
- [ ] `postprocess.py` 정규식 XML 처리를 `xml.etree`나 `lxml`로 바꾸는 게 나은가?
- [ ] `postprocess.py` 단위 테스트(합성 MusicXML 문자열 기반)를 추가해 CI에서 돌리기

## 8. 개선 후보 (우선순위 제안)

1. **벡터 PDF 직접 읽기**: Sibelius·MuseScore·Finale로 만든 PDF는 음표가 글꼴 기호와 선으로 들어 있다. `pdftotext -bbox`로 보면 Opus/SMuFL 글자가 위치와 함께 나온다. 이걸 직접 해석하면 Audiveris보다 훨씬 정확할 수 있다(89마디 같은 문제 해결). 큰 작업이므로 설계부터 제안해 주세요.
2. Audiveris 결과의 박자표 변화 누락 감지: PDF 글자층에서 박자표 숫자를 찾아 Audiveris 결과와 비교해 경고하기.
3. `postprocess.py` 단위 테스트와 400DPI 경로 CI 시험(저작권 없는 작은 오선 악보를 직접 만들어 `omr/test/`에 추가).
4. 빠르기 표 버튼에 악보의 실제 마디 번호 표시.
5. 처리 시간 표시 개선: 쪽수에 따라 예상 시간 안내.

## 9. 지켜야 할 것
- 「Stay Alive」 및 사용자가 올린 다른 저작권 악보의 음표 내용·PDF를 저장소에 넣지 않는다. 시험 악보는 퍼블릭 도메인이나 직접 만든 것만.
- 비밀값(Firebase 서비스 계정, GitHub 토큰, Cloudflare 설정)을 커밋하지 않는다. `FIREBASE_CONFIG`의 apiKey는 공개용 웹 키라 괜찮다.
- 공개 저장소라 Actions 로그가 공개된다. 워커 로그에 파일 이름·내용을 남기지 않는다.
- `main`에 직접 푸시하지 않는다. `gpt/<주제>` 브랜치 → `[GPT]` PR → CI 통과 → 사용자가 병합.
