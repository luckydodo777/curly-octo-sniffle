#!/usr/bin/env python3
"""건반 내비 빌드: src/ + assets/ 를 합쳐 한 파일짜리 앱을 만든다.

  python build.py            → dist/건반내비.html (브라우저에서 바로 여는 완성본)
                               dist/artifact_body.html (Claude 아티팩트용: doctype/head 없는 본문)
외부 라이브러리 설치 필요 없음 (파이썬 3.8+ 표준 라이브러리만 사용).
"""
import pathlib, json, sys
ROOT = pathlib.Path(__file__).resolve().parent
src = (ROOT / "src" / "index.html").read_text(encoding="utf-8")
css = (ROOT / "src" / "styles.css").read_text(encoding="utf-8")
js = (ROOT / "src" / "app.js").read_text(encoding="utf-8")
samples = (ROOT / "assets" / "piano_samples.json").read_text(encoding="utf-8")
json.loads(samples)  # 샘플 데이터가 깨지지 않았는지 확인
for mark in ("/* @@STYLE", "/* @@SAMPLES", "/* @@SCRIPT"):
    if mark not in src:
        sys.exit(f"src/index.html 에 자리표시자 {mark} 가 없어요")
def fill(text, mark, content):
    a = text.index(mark); b = text.index("*/", a) + 2
    return text[:a] + content + text[b:]
body = fill(src, "/* @@STYLE", css.rstrip("\n"))
body = fill(body, "/* @@SAMPLES", samples)
body = fill(body, "/* @@SCRIPT", js.rstrip("\n"))
if "</script" in js.replace("<\\/script", ""):
    sys.exit("app.js 안에 '</script' 문자열이 있으면 안 돼요")
dist = ROOT / "dist"; dist.mkdir(exist_ok=True)
(dist / "artifact_body.html").write_text(body, encoding="utf-8")
full = ('<!doctype html><html lang="ko"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}'
        'body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>'
        '</head><body>' + body + '</body></html>')
(dist / "건반내비.html").write_text(full, encoding="utf-8")
print(f"OK  dist/건반내비.html ({len(full)/1e6:.2f} MB), dist/artifact_body.html")
