FROM python:3.12-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright HOME=/tmp
COPY apps/api/src/id-business-v2/auto-recharge/worker/requirements.lock.txt ./
RUN pip install --no-cache-dir -r requirements.lock.txt \
  && python -m playwright install --with-deps chromium \
  && apt-get install -y --no-install-recommends xauth \
  && groupadd --gid 10001 recharge \
  && useradd --uid 10001 --gid recharge --no-create-home --shell /usr/sbin/nologin recharge \
  && chmod -R a+rX /ms-playwright \
  && rm -rf /var/lib/apt/lists/* /root/.cache
COPY --chown=recharge:recharge apps/api/src/id-business-v2/auto-recharge/worker/ ./
USER recharge
EXPOSE 8051
HEALTHCHECK --interval=15s --timeout=5s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8051/health',timeout=3)"
CMD ["xvfb-run", "-a", "python", "-B", "server.py"]
