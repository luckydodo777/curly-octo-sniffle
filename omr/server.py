#!/usr/bin/env python3
"""건반 내비 악보 변환 서버 (Audiveris, AI 토큰 없음).

앱이 PDF·사진을 그대로 POST 하면 MusicXML을 돌려준다. Hugging Face Space(무료, Docker)에서 돌리는 것을 전제로 한다.
  GET  /health            → {"ok": true}   (잠든 서버 깨우기용)
  POST /convert           본문 = 파일 그대로, 헤더 Content-Type, X-File-Name(URL 인코딩)
                          → {"xml": "...", "info": {...}} 또는 {"error": "..."}
개인정보: 올린 파일은 임시 폴더에서 변환 후 바로 지운다. 로그에는 크기·시간만 남긴다.
"""
import json, os, sys, tempfile, threading, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from worker import convert  # noqa: E402  (같은 변환 함수를 GitHub Actions 작업자와 공유)

AUDIVERIS = os.environ.get("AUDIVERIS_BIN", "/opt/audiveris/bin/Audiveris")
MAX_BYTES = int(os.environ.get("OMR_MAX_BYTES", 15_000_000))
ALLOW_ORIGIN = os.environ.get("OMR_ALLOW_ORIGIN", "*")
SLOTS = threading.BoundedSemaphore(int(os.environ.get("OMR_PARALLEL", "1")))
WAITING = [0]
MAX_WAITING = 4
EXT = {"application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/bmp": ".bmp", "image/tiff": ".tif"}


class H(BaseHTTPRequestHandler):
    server_version = "gunban-omr/1"

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", ALLOW_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-File-Name")
        self.send_header("Access-Control-Max-Age", "86400")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.split("?")[0] in ("/", "/health"):
            self._send(200, {"ok": True, "engine": "Audiveris", "busy": WAITING[0]})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != "/convert":
            return self._send(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return self._send(400, {"error": "파일이 비어 있어요"})
        if n > MAX_BYTES:
            return self._send(413, {"error": f"{MAX_BYTES // 1_000_000}MB보다 큰 파일은 변환할 수 없어요"})
        raw = self.rfile.read(n)
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        name = urllib.parse.unquote(self.headers.get("X-File-Name") or "")
        ext = EXT.get(ctype) or (os.path.splitext(name)[1].lower() if os.path.splitext(name)[1].lower() in EXT.values() else ".pdf")
        if WAITING[0] >= MAX_WAITING:
            return self._send(503, {"error": "지금 변환할 악보가 많아요. 잠시 뒤 다시 올려 주세요.", "busy": True})
        WAITING[0] += 1
        t0 = time.time()
        try:
            with SLOTS:
                with tempfile.TemporaryDirectory() as w:
                    src = os.path.join(w, "score" + ext)
                    with open(src, "wb") as f:
                        f.write(raw)
                    xml, info = convert(AUDIVERIS, src, w, os.path.splitext(name)[0])
            info["total"] = round(time.time() - t0, 1)
            print(f"ok bytes={n} measures={info['measures']} sec={info['total']}", flush=True)
            self._send(200, {"xml": xml, "info": info})
        except Exception as e:  # noqa: BLE001
            msg = str(e).splitlines()[0][:300] if str(e) else "변환하지 못했어요"
            print(f"fail bytes={n} sec={round(time.time() - t0, 1)}", flush=True)
            self._send(422, {"error": msg})
        finally:
            WAITING[0] -= 1

    def log_message(self, *a):  # 기본 접근 로그(주소 등)는 남기지 않음
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "7860"))
    print(f"gunban-omr listening on :{port}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), H).serve_forever()
