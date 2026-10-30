#!/usr/bin/env python3
"""omr/ 의 변환 서버를 Hugging Face Space(Docker)로 올린다. GitHub Actions(hf-deploy.yml)에서 실행.
환경변수: HF_TOKEN(쓰기 권한 토큰, 필수), HF_SPACE(선택, 예: 아이디/gunban-omr — 없으면 토큰 주인/gunban-omr)
"""
import os, shutil, sys, tempfile
from huggingface_hub import HfApi

tok = os.environ.get("HF_TOKEN", "").strip()
if not tok:
    print("HF_TOKEN 비밀값이 없어 건너뜀 (docs/OMR_SERVER.md)"); sys.exit(0)
api = HfApi(token=tok)
repo = os.environ.get("HF_SPACE", "").strip() or f"{api.whoami()['name']}/gunban-omr"
api.create_repo(repo, repo_type="space", space_sdk="docker", exist_ok=True, private=False)
here = os.path.dirname(os.path.abspath(__file__))
with tempfile.TemporaryDirectory() as d:
    for f in ("Dockerfile", "server.py", "worker.py", "postprocess.py", ".dockerignore"):
        shutil.copy(os.path.join(here, f), d)
    open(os.path.join(d, "README.md"), "w", encoding="utf-8").write(
        "---\ntitle: gunban-omr\nemoji: 🎹\ncolorFrom: green\ncolorTo: blue\nsdk: docker\napp_port: 7860\npinned: false\nlicense: agpl-3.0\n---\n\n"
        "건반 내비(https://luckydodo777.github.io/curly-octo-sniffle/)의 악보 변환 서버. PDF·사진 악보를 Audiveris로 MusicXML로 바꾼다.\n"
        "소스: https://github.com/luckydodo777/curly-octo-sniffle/tree/main/omr\n")
    api.upload_folder(folder_path=d, repo_id=repo, repo_type="space", commit_message="deploy from GitHub")
owner, name = repo.split("/")
print(f"올림: https://huggingface.co/spaces/{repo}")
print(f"앱에 넣을 주소: https://{owner.lower().replace('_', '-').replace('.', '-')}-{name.lower().replace('_', '-').replace('.', '-')}.hf.space")
