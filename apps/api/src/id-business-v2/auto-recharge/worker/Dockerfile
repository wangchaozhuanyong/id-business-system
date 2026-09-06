FROM mcr.microsoft.com/playwright/python:v1.62.0-noble@sha256:aa81288e738725378becba5b3e06cb0f3a7f012a610e87e8d767a090ea3f740d
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright HOME=/tmp
COPY apps/api/src/id-business-v2/auto-recharge/worker/requirements.lock.txt ./
RUN pip install --no-cache-dir --break-system-packages -r requirements.lock.txt
COPY --chown=pwuser:pwuser apps/api/src/id-business-v2/auto-recharge/worker/ ./
USER pwuser
EXPOSE 8051
HEALTHCHECK --interval=15s --timeout=5s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8051/health',timeout=3)"
CMD ["xvfb-run", "-a", "python", "-B", "server.py"]
