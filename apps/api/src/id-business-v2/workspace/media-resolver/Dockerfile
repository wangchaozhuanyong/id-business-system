FROM python:3.11-slim-bookworm@sha256:528257d48c1da0dcecc2e725d1ae34498d60c965f1241e39cd6a85a8859bdf84

ARG YT_DLP_VERSION=2026.08.19
ARG YT_DLP_COMMIT=3a08beaf031ab68f966401ead017ac81fe8486cf

WORKDIR /app

COPY scripts/audit-python-dependencies.py /opt/security/audit-python-dependencies.py
COPY apps/api/src/id-business-v2/workspace/media-resolver/prepare_f2.py /opt/security/prepare_f2.py

ENV PYTHONDONTWRITEBYTECODE=1 \
  PYTHONUNBUFFERED=1 \
  PIP_DISABLE_PIP_VERSION_CHECK=1 \
  MEDIA_RESOLVER_PORT=8787 \
  F2_PYTHON=/opt/f2/bin/python \
  PATH=/opt/yt-dlp/bin:$PATH

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
  && python -m pip install --no-cache-dir pip==26.2.1 setuptools==84.0.0 \
  && python -m venv /opt/yt-dlp \
  && /opt/yt-dlp/bin/pip install --no-cache-dir pip==26.2.1 setuptools==84.0.0 \
  && /opt/yt-dlp/bin/pip install --no-cache-dir \
    "yt-dlp[default,pin,curl-cffi,pin-curl-cffi,deno,pin-deno] @ https://github.com/yt-dlp/yt-dlp/archive/${YT_DLP_COMMIT}.tar.gz" \
  && /opt/yt-dlp/bin/pip check \
  && python -m venv /opt/f2 \
  && /opt/f2/bin/pip install --no-cache-dir pip==26.2.1 setuptools==84.0.0 \
  && python /opt/security/prepare_f2.py \
  && /opt/f2/bin/pip install --no-cache-dir \
    /tmp/f2-build/f2-7dab3e2ffffaa2535834d28fca99dbc2e89fa9d3 \
  && /opt/f2/bin/pip check \
  && rm -rf /tmp/f2-build \
  && groupadd --gid 10001 resolver \
  && useradd --uid 10001 --gid resolver --no-create-home --shell /usr/sbin/nologin resolver \
  && rm -rf /var/lib/apt/lists/* /root/.cache

COPY --chown=resolver:resolver \
  apps/api/src/id-business-v2/workspace/media-resolver/server.py \
  apps/api/src/id-business-v2/workspace/media-resolver/f2_bridge.py \
  /app/

COPY apps/api/src/id-business-v2/workspace/media-resolver/test_runtime.py /opt/security/test_runtime.py
RUN cd /tmp \
  && /opt/f2/bin/python /opt/security/test_runtime.py \
  && python /opt/security/audit-python-dependencies.py \
    --python /usr/local/bin/python --python /opt/yt-dlp/bin/python --python /opt/f2/bin/python \
    --output /opt/security/python-dependencies.json

USER resolver

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8787/health', timeout=3).read()"]

CMD ["python", "/app/server.py"]
