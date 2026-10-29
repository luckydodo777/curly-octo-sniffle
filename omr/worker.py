#!/usr/bin/env python3
"""건반 내비 악보 변환 작업자 (토큰 없이 Audiveris로 PDF·사진 → MusicXML).

흐름
  앱(로그인 상태)에서 PDF/사진을 올리면
    users/{uid}/omrJobs/{jobId}            ← 상태·이름 (+ chunks/orig_N 에 원본 base64)
    omrQueue/{jobId} = {uid, createdAt}    ← 처리 대기열 (앱은 만들기만 가능)
  GitHub Actions(omr.yml)가 몇 분마다 이 스크립트를 실행:
    대기열 확인 → 없으면 바로 끝 → 있으면 Audiveris로 변환 →
    users/{uid}/songs/{새 id} 에 악보 저장(내 악보함) → 작업 상태 done/failed → 대기열 삭제

사용
  python omr/worker.py --check            # 대기 작업이 있으면 종료코드 0, 없으면 10 (설치 생략용)
  python omr/worker.py --run --audiveris /path/to/Audiveris [--linger 600]
  python omr/worker.py --local IN_DIR OUT_DIR --audiveris BIN   # Firebase 없이 변환만 (시험용)

환경변수: FIREBASE_SERVICE_ACCOUNT (서비스 계정 JSON 전체 문자열)
개인정보: 로그에는 작업 ID와 결과 요약만 남기고 파일 이름·내용은 남기지 않는다(공개 저장소의 로그는 누구나 볼 수 있음).
"""
import argparse, base64, glob, json, os, re, shutil, subprocess, sys, tempfile, time, zipfile

CHUNK = 300000  # 앱(Library.putBig)과 같은 크기


def mxl_to_xml(path):
    with zipfile.ZipFile(path) as z:
        root = None
        if "META-INF/container.xml" in z.namelist():
            m = re.search(r'full-path\s*=\s*"([^"]+)"', z.read("META-INF/container.xml").decode("utf-8", "replace"))
            if m:
                root = m.group(1)
        if not root:
            root = next(n for n in z.namelist() if not n.startswith("META-INF") and n.lower().endswith((".xml", ".musicxml")))
        return z.read(root).decode("utf-8")


def convert(audiveris, src_path, workdir):
    """Audiveris 실행 → (MusicXML 문자열, 정보). 여러 악장/페이지면 첫 번째 결과를 쓰되 개수를 알려 준다."""
    out = os.path.join(workdir, "out")
    os.makedirs(out, exist_ok=True)
    cmd = [audiveris, "-batch", "-transcribe", "-export", "-output", out, src_path]
    if shutil.which("xvfb-run"):
        cmd = ["xvfb-run", "-a"] + cmd
    t = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    mxls = sorted(glob.glob(os.path.join(out, "**", "*.mxl"), recursive=True))
    if not mxls:
        tail = "\n".join((p.stdout + p.stderr).splitlines()[-15:])
        raise RuntimeError("Audiveris가 악보를 찾지 못했어요 (오선이 보이는 선명한 악보인지 확인해 주세요)\n" + tail)
    xml = mxl_to_xml(mxls[0])
    info = {"seconds": round(time.time() - t, 1), "movements": len(mxls), "measures": len(re.findall(r"<measure\b", xml)) // max(1, len(re.findall(r"<part\b[^-]", xml)))}
    return xml, info


def local_mode(args):
    os.makedirs(args.local[1], exist_ok=True)
    ok = True
    for f in sorted(glob.glob(os.path.join(args.local[0], "*.pdf")) + glob.glob(os.path.join(args.local[0], "*.png")) + glob.glob(os.path.join(args.local[0], "*.jpg"))):
        with tempfile.TemporaryDirectory() as w:
            try:
                xml, info = convert(args.audiveris, f, w)
                name = os.path.splitext(os.path.basename(f))[0] + ".musicxml"
                open(os.path.join(args.local[1], name), "w", encoding="utf-8").write(xml)
                print(f"OK {os.path.basename(f)} {info}")
            except Exception as e:
                ok = False
                print(f"FAIL {os.path.basename(f)}: {e}")
    return 0 if ok else 1


def firestore():
    import firebase_admin
    from firebase_admin import credentials, firestore as fs
    sa = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip()
    if not sa:
        print("FIREBASE_SERVICE_ACCOUNT 비밀값이 없어요. docs/FIREBASE_SETUP.md 8단계를 보세요.")
        sys.exit(2)
    firebase_admin.initialize_app(credentials.Certificate(json.loads(sa)))
    return fs.client()


def put_big(db, base, field, s):
    n = (len(s) + CHUNK - 1) // CHUNK if s else 0
    for i in range(n):
        db.document(f"{base}/chunks/{field}_{i}").set({"field": field, "i": i, "data": s[i * CHUNK:(i + 1) * CHUNK]})
    return n


def get_big(db, base, field, n):
    return "".join((db.document(f"{base}/chunks/{field}_{i}").get().to_dict() or {}).get("data", "") for i in range(n or 0))


def run_mode(args):
    db = firestore()
    if args.check:
        queue = list(db.collection("omrQueue").order_by("createdAt").limit(10).stream())
        print(f"대기 작업 {len(queue)}개")
        return 0 if queue else 10
    # --linger N: 처리 후에도 N초 동안 새 작업을 기다려 바로 처리 (Audiveris 설치를 다시 하지 않아 빠름)
    until = time.time() + max(0, args.linger)
    total = 0
    while True:
        total += process_queue(db, args)
        if time.time() >= until:
            break
        time.sleep(20)
    print(f"이번 실행에서 처리 {total}개")
    return 0


def process_queue(db, args):
    queue = list(db.collection("omrQueue").order_by("createdAt").limit(10).stream())
    done = 0
    for q in queue:
        qd = q.to_dict() or {}
        uid, job_id = qd.get("uid"), q.id
        jp = f"users/{uid}/omrJobs/{job_id}"
        job_ref = db.document(jp)
        job = (job_ref.get().to_dict() or {}) if uid else {}
        if not uid or not job:
            q.reference.delete()
            print(f"[{job_id}] 작업 정보가 없어 대기열에서 지움")
            continue
        job_ref.set({"status": "running", "startedAt": int(time.time() * 1000)}, merge=True)
        try:
            raw = base64.b64decode(get_big(db, jp, "orig", (job.get("big") or {}).get("orig", 0)))
            if not raw:
                raise RuntimeError("원본 파일이 비어 있어요")
            ext = {"application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg"}.get(job.get("type", ""), os.path.splitext(job.get("name", ""))[1] or ".pdf")
            with tempfile.TemporaryDirectory() as w:
                src = os.path.join(w, "score" + ext)
                open(src, "wb").write(raw)
                xml, info = convert(args.audiveris, src, w)
            # 내 악보함에 새 곡으로 저장 (앱의 Library.open 이 읽는 형식과 같게)
            title = re.sub(r"\.[^.]+$", "", job.get("name") or "변환한 악보")
            m = re.search(r"<work-title>([^<]+)</work-title>", xml) or re.search(r"<movement-title>([^<]+)</movement-title>", xml)
            song_ref = db.collection(f"users/{uid}/songs").document()
            sp = f"users/{uid}/songs/{song_ref.id}"
            big = {"xml": put_big(db, sp, "xml", xml)}
            b64 = base64.b64encode(raw).decode()
            if len(raw) <= 6_000_000:
                big["orig"] = put_big(db, sp, "orig", b64)
            now = int(time.time() * 1000)
            song_ref.set({
                "title": title if not m or m.group(1).strip() in ("", "Title") else m.group(1).strip(),
                "kind": "omr", "name": job.get("name", ""), "measures": info["measures"], "bpm": None,
                "createdAt": now, "updatedAt": now, "flags": [], "report": None, "fixed": [], "tempos": [],
                "big": big, "original": {"name": job.get("name", ""), "type": job.get("type", ""), "size": len(raw)} if "orig" in big else None,
                "stats": {"sessions": 0, "lastAcc": None, "bestAcc": None, "totalSec": 0, "lastAt": None},
                "omr": {"engine": "Audiveris", "seconds": info["seconds"], "movements": info["movements"]},
            })
            job_ref.set({"status": "done", "songId": song_ref.id, "finishedAt": now, "info": info}, merge=True)
            print(f"[{job_id}] 완료: {info['measures']}마디, {info['seconds']}초")
            done += 1
        except Exception as e:
            msg = str(e).splitlines()[0][:300]
            job_ref.set({"status": "failed", "error": msg, "finishedAt": int(time.time() * 1000)}, merge=True)
            print(f"[{job_id}] 실패: {msg}")
        q.reference.delete()
    if queue:
        print(f"처리 {len(queue)}개, 성공 {done}개")
    return len(queue)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--audiveris", default=os.environ.get("AUDIVERIS_BIN", "audiveris"))
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--linger", type=int, default=0, help="처리 후 새 작업을 기다릴 초")
    ap.add_argument("--local", nargs=2, metavar=("IN_DIR", "OUT_DIR"))
    a = ap.parse_args()
    sys.exit(local_mode(a) if a.local else run_mode(a))
