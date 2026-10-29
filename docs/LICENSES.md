# 외부 구성요소와 라이선스

| 구성요소 | 쓰는 곳 | 라이선스 / 출처 |
|---|---|---|
| OpenSheetMusicDisplay 1.8.9 (VexFlow 포함) | 악보 그리기 (jsDelivr CDN에서 불러옴) | BSD-3-Clause (VexFlow: MIT) |
| pdf.js 3.11.174 | PDF 악보를 이미지로 그리기 (cdnjs CDN) | Apache-2.0 |
| Salamander Grand Piano V3 (velocity 8) | 기본 피아노 소리, `assets/piano_samples.json`의 `sal` | 원본 녹음: Alexander Holm, CC BY 3.0. npm 패키지 `@audio-samples/piano-mp3-velocity8` 표기: MIT. 4~7초로 다듬고 음량을 맞춤 |
| piano-mp3 1.0.2 | 88건반 개별 녹음, `assets/piano_samples.json`의 `key` | MIT (npm `piano-mp3`, gleitz/midi-js-soundfonts에서 가져온 샘플) |
| 환희의 송가 예제 | 예제 곡 | 베토벤, 퍼블릭 도메인 (초급 편곡은 직접 작성) |

배포할 때는 Salamander 원본 녹음의 저작자(Alexander Holm)를 표기하는 것이 안전하다.
