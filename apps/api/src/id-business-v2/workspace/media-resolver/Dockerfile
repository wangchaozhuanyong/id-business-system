FROM python:3.11-slim-bookworm@sha256:528257d48c1da0dcecc2e725d1ae34498d60c965f1241e39cd6a85a8859bdf84

ARG YT_DLP_VERSION=2026.08.19
ARG YT_DLP_COMMIT=3a08beaf031ab68f966401ead017ac81fe8486cf
ARG F2_COMMIT=7dab3e2ffffaa2535834d28fca99dbc2e89fa9d3

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
  PYTHONUNBUFFERED=1 \
  PIP_DISABLE_PIP_VERSION_CHECK=1 \
  MEDIA_RESOLVER_PORT=8787 \
  F2_PYTHON=/opt/f2/bin/python \
  PATH=/opt/yt-dlp/bin:$PATH

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
  && python -m venv /opt/yt-dlp \
  && /opt/yt-dlp/bin/pip install --no-cache-dir \
    "yt-dlp[default,pin,curl-cffi,pin-curl-cffi,deno,pin-deno] @ https://github.com/yt-dlp/yt-dlp/archive/${YT_DLP_COMMIT}.tar.gz" \
  && /opt/yt-dlp/bin/pip check \
  && python -m venv /opt/f2 \
  && /opt/f2/bin/pip install --no-cache-dir \
    "f2 @ https://github.com/Johnserf-Seed/f2/archive/${F2_COMMIT}.tar.gz" \
  && /opt/f2/bin/pip check \
  && groupadd --gid 10001 resolver \
  && useradd --uid 10001 --gid resolver --no-create-home --shell /usr/sbin/nologin resolver \
  && rm -rf /var/lib/apt/lists/* /root/.cache

COPY --chown=resolver:resolver \
  apps/api/src/id-business-v2/workspace/media-resolver/server.py \
  apps/api/src/id-business-v2/workspace/media-resolver/f2_bridge.py \
  /app/

USER resolver

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8787/health', timeout=3).read()"]

CMD ["python", "/app/server.py"]
