FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
WORKDIR /workspace/engine
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    PYTHON=/opt/solver-venv/bin/python \
    ONLINE_RECHARGE_RUNTIME_DIR=/workspace/engine/runtime \
    ONLINE_RECHARGE_MEDIA_DIR=/workspace/engine/runtime/media \
    ONLINE_RECHARGE_FFMPEG_PATH=/usr/bin/ffmpeg \
    HF_HOME=/workspace/engine/runtime/cache/huggingface \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    RUNNING_IN_DOCKER=1 \
    TMPDIR=/tmp \
    ONLINE_RECHARGE_ENGINE_ENABLED=0
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg xvfb xauth tini fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
COPY upstream/package.json upstream/package-lock.json ./upstream/
RUN npm ci --prefix upstream --ignore-scripts --no-audit --no-fund
# Browser/Python downloads happen only on a separately authorized image build.
RUN cd upstream && node node_modules/playwright/cli.js install --with-deps chromium
COPY upstream/requirements-hcaptcha.txt ./upstream/
COPY requirements-hcaptcha.lock.txt ./
# Independent lock comes from a successful Linux build, including CPU-only Torch.
# The frozen Node driver is 1.59.1; the available compatible Python driver is 1.59.0.
RUN python3 -m venv /opt/solver-venv \
    && /opt/solver-venv/bin/pip install --no-cache-dir --index-url https://pypi.org/simple pip==26.2.1 \
    && /opt/solver-venv/bin/pip install --no-cache-dir --only-binary=:all: -r requirements-hcaptcha.lock.txt \
    && /opt/solver-venv/bin/pip check \
    && /opt/solver-venv/bin/python -c 'import importlib.metadata as m; import torch, cv2, numpy, requests; from PIL import Image; from playwright.sync_api import sync_playwright; from transformers import CLIPModel, CLIPProcessor; assert torch.version.cuda is None; assert not any(d.metadata["Name"].lower().startswith("nvidia-") for d in m.distributions())' \
    && /opt/solver-venv/bin/pip freeze --all > /opt/solver-venv/requirements.resolved.txt \
    && node --version > /opt/solver-venv/node-version.txt \
    && node -e 'process.stdout.write(JSON.stringify(require("./upstream/node_modules/playwright-core/browsers.json"), null, 2))' > /opt/solver-venv/browser-versions.json
COPY . .
RUN mkdir -p runtime/cache/huggingface && chmod 700 runtime && chown -R node:node /workspace/engine /opt/playwright
USER node
# Shared private network namespace with API; do not publish credential/CDP ports.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 CMD ["node", "healthcheck.cjs"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["xvfb-run", "-a", "node", "worker.cjs"]
