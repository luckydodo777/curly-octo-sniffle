# 건반 내비 악보 변환 서버 — Hugging Face Space(Docker, 무료 CPU)용
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 curl ca-certificates xvfb xauth fontconfig fonts-dejavu-core libfreetype6 \
      libx11-6 libxext6 libxrender1 libxtst6 libxi6 libgomp1 \
    && rm -rf /var/lib/apt/lists/*
ARG AUDIVERIS_VERSION=5.11.0
RUN set -e; \
    url=$(curl -fsSL "https://api.github.com/repos/Audiveris/audiveris/releases/tags/${AUDIVERIS_VERSION}" \
          | grep -o '"browser_download_url": *"[^"]*ubuntu24\.04[^"]*\.deb"' | head -1 | sed 's/.*"\(https[^"]*\)"$/\1/'); \
    echo "Audiveris: $url"; curl -fsSL -o /tmp/a.deb "$url"; dpkg-deb -x /tmp/a.deb /; rm /tmp/a.deb; \
    test -x /opt/audiveris/bin/Audiveris
# Hugging Face Space는 uid 1000 으로 실행한다
RUN (userdel -r ubuntu 2>/dev/null || true) && useradd -m -u 1000 user
USER 1000
ENV HOME=/home/user PORT=7860 AUDIVERIS_BIN=/opt/audiveris/bin/Audiveris PYTHONUNBUFFERED=1
WORKDIR /home/user/app
COPY --chown=1000 worker.py server.py ./
EXPOSE 7860
CMD ["python3", "server.py"]
