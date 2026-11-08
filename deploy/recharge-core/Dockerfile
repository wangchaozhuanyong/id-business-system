FROM node:24.22.1-bookworm-slim@sha256:e1582112fb9f152ed38eefcd712efc93fee1becb519fdfa57574d5e07eaa5e7d
ARG BUILD_HCAPTCHA_SOLVER=0

# Pinned dependencies; only the reviewed routing and unused-code return patches are allowed.
ENV DEBIAN_FRONTEND=noninteractive \
    PIP_BREAK_SYSTEM_PACKAGES=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 HCAPTCHA_SOLVER_PYTHON=/usr/bin/python3 \
    HCAPTCHA_SOLVER_SCRIPT=/app/hcaptcha/solver.py \
    PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
    git wget curl ca-certificates fonts-liberation fonts-noto-cjk \
    python3 python3-pip python-is-python3 \
    libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
    libxss1 libasound2 libpangocairo-1.0-0 libpango-1.0-0 \
    libxshmfence1 xdg-utils procps libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /candidate/.runtime/codexdaichong
COPY engine/package.json engine/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
RUN npx --no-install playwright install chromium
COPY engine/requirements-hcaptcha.txt ./
RUN if [ "$BUILD_HCAPTCHA_SOLVER" = "1" ]; then pip install -r requirements-hcaptcha.txt && python3 -m playwright install chromium; fi
COPY engine/ ./
# Preserve the original optional Python entry path used by the existing image.
COPY engine/ /app/
RUN mkdir -p debug_screenshots product_files /tmp/hcaptcha_auto_solver_live
COPY source/ /candidate/
COPY upstream/ /candidate/.upstream/codexdaichong/
WORKDIR /candidate
RUN node --input-type=module -e 'import {applyApprovedRechargeRouting,verifyCodexdaichongSource} from "./modules/recharge/codexdaichong/prepare.mjs"; for (const path of ["/candidate/.runtime/codexdaichong", "/app"]) { await applyApprovedRechargeRouting(path); console.log(await verifyCodexdaichongSource(path)); }'
ENV NODE_ENV=production PORT=3000 HEADFUL=0 CDP_PORT=9222 CDP_URL=http://127.0.0.1:9222
HEALTHCHECK --interval=20s --timeout=6s --start-period=45s --retries=3 \
  CMD node /candidate/deploy/recharge-core/health.mjs
ENTRYPOINT ["node", "/candidate/deploy/recharge-core/entry.mjs"]
