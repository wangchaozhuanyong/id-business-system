#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-.deploy/local-deploy.env}"
EXPECTED_API_UPSTREAM_BASE_URL="${API_UPSTREAM_BASE_URL:-}"
if [[ ! -f "$DEPLOY_ENV_FILE" ]]; then
  echo "Missing ${DEPLOY_ENV_FILE}. No remote API host is currently configured." >&2
  exit 1
fi

source "$DEPLOY_ENV_FILE"

SERVER_PM2_APP="${SERVER_PM2_APP:-mairuanjian-api}"
API_BASE_URL="${SERVER_API_BASE_URL:-}"
if [[ -z "$API_BASE_URL" && -n "${SERVER_API_DOMAIN:-}" ]]; then
  API_BASE_URL="https://${SERVER_API_DOMAIN}/api"
fi
if [[ -z "$API_BASE_URL" ]]; then
  API_BASE_URL="${VITE_API_BASE_URL:-}"
fi

require_var() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "${name} is missing in .deploy/local-deploy.env" >&2
    exit 1
  fi
}

require_var SERVER_PROVIDER
require_var SERVER_SSH_HOST
require_var SERVER_SSH_USER
require_var SERVER_APP_DIR
require_var SERVER_API_PORT
require_var SERVER_SSH_KEY
require_var API_BASE_URL
require_var API_UPSTREAM_BASE_URL

case "${SERVER_PROVIDER,,}" in
  aws | amazon | ec2)
    echo "Refusing deployment: this project has retired its AWS/EC2 runtime." >&2
    exit 1
    ;;
esac

if [[ ! -f "$SERVER_SSH_KEY" ]]; then
  echo "SERVER_SSH_KEY is not found: $SERVER_SSH_KEY" >&2
  exit 1
fi

SSH_TARGET="${SERVER_SSH_USER}@${SERVER_SSH_HOST}"
SSH_OPTS=(-i "$SERVER_SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new)
API_BASE_URL="${API_BASE_URL%/}"
API_UPSTREAM_BASE_URL="${API_UPSTREAM_BASE_URL%/}"
EXPECTED_API_UPSTREAM_BASE_URL="${EXPECTED_API_UPSTREAM_BASE_URL%/}"
if [[ -n "$EXPECTED_API_UPSTREAM_BASE_URL" && "$API_UPSTREAM_BASE_URL" != "$EXPECTED_API_UPSTREAM_BASE_URL" ]]; then
  echo "API_UPSTREAM_BASE_URL differs between deployment credentials and local deploy config" >&2
  exit 1
fi
if [[ "$API_BASE_URL" != "${API_UPSTREAM_BASE_URL}/api" ]]; then
  echo "SERVER_API_BASE_URL must equal API_UPSTREAM_BASE_URL plus /api" >&2
  exit 1
fi

remote() {
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$@"
}

remote_bash() {
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" bash -s -- "$@"
}

check_http_status() {
  local method="$1"
  local url="$2"
  local expected="$3"
  local status

  if [[ "$method" == "POST" ]]; then
    status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "$url")"
  else
    status="$(curl -sS -o /dev/null -w '%{http_code}' "$url")"
  fi

  if [[ "$status" != "$expected" ]]; then
    echo "Unexpected status for ${method} ${url}: got ${status}, expected ${expected}" >&2
    exit 1
  fi

  echo "OK ${method} ${url} -> ${status}"
}

echo "==> Checking local production env"
npm run prod:env:check

echo "==> Building API locally"
npm run prisma:generate --workspace @apple-business/api
npm run build --workspace @apple-business/shared
npm run build --workspace @apple-business/api

echo "==> Preparing remote app directory: ${SSH_TARGET}:${SERVER_APP_DIR}"
remote "mkdir -p '$SERVER_APP_DIR'"

echo "==> Syncing source files without local secrets"
rsync -az --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'coverage/' \
  --exclude '.env' \
  --exclude '.env.production' \
  --exclude '.deploy/' \
  --exclude '.secrets/' \
  --exclude 'uploads/' \
  --exclude 'tmp/' \
  --exclude 'backups/' \
  --exclude 'exports/' \
  -e "ssh ${SSH_OPTS[*]}" \
  ./ "$SSH_TARGET:$SERVER_APP_DIR/"

echo "==> Syncing built API artifacts"
rsync -az --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  apps/api/dist/ "$SSH_TARGET:$SERVER_APP_DIR/apps/api/dist/"
rsync -az --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  packages/shared/dist/ "$SSH_TARGET:$SERVER_APP_DIR/packages/shared/dist/"

echo "==> Checking remote PM2 API runtime"
remote_bash "$SERVER_APP_DIR" "$SERVER_PM2_APP" "$SERVER_API_PORT" <<'REMOTE_CHECK'
set -euo pipefail
APP_DIR="$1"
PM2_APP="$2"
API_PORT="$3"
cd "$APP_DIR"

node - <<'NODE'
const fs = require('fs');
const text = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
const required = [
  'APP_PORT',
  'CORS_ORIGIN',
  'DATABASE_URL',
  'FIELD_ENCRYPTION_KEY',
  'HASH_SECRET',
  'JWT_SECRET',
  'V2_TRUSTED_PROXY_SECRET'
];
const missing = required.filter((key) => !new RegExp(`^${key}=`, 'm').test(text));
if (missing.length) {
  console.error(`Remote .env is missing: ${missing.join(', ')}`);
  process.exit(1);
}
const edgeRuntime = text
  .split(/\r?\n/)
  .find((item) => item.startsWith('SUPABASE_EDGE_FUNCTION='))
  ?.slice('SUPABASE_EDGE_FUNCTION='.length)
  .trim()
  .replace(/^['"]|['"]$/g, '');
if (edgeRuntime === 'true') {
  console.error('Remote Node API must not set SUPABASE_EDGE_FUNCTION=true.');
  process.exit(1);
}
console.log('Remote .env has required runtime keys.');
NODE

node - <<'NODE'
const tls = require('node:tls');
const hosts = ['imap.gmail.com', 'imap.mail.me.com'];
Promise.all(
  hosts.map(
    (host) =>
      new Promise((resolve, reject) => {
        const socket = tls.connect({ host, port: 993, servername: host });
        const timer = setTimeout(() => socket.destroy(new Error(`IMAP TLS timeout: ${host}`)), 10000);
        socket.once('secureConnect', () => {
          clearTimeout(timer);
          socket.destroy();
          resolve();
        });
        socket.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      })
  )
)
  .then(() => console.log('Remote IMAP TLS egress is available.'))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
NODE

if ! pm2 jlist | node -e "
let raw = '';
process.stdin.on('data', (chunk) => raw += chunk);
process.stdin.on('end', () => {
  const apps = JSON.parse(raw || '[]');
  process.exit(apps.some((app) => app && app.name === process.argv[1]) ? 0 : 1);
});
" "$PM2_APP"; then
  echo "PM2 app not found: $PM2_APP" >&2
  exit 1
fi

if ! grep -q "^APP_PORT=${API_PORT}$" .env; then
  echo "Remote .env APP_PORT does not match SERVER_API_PORT=${API_PORT}" >&2
  exit 1
fi
REMOTE_CHECK

echo "==> Installing remote dependencies when needed"
remote "cd '$SERVER_APP_DIR' && npm install --workspaces --include=dev"

echo "==> Generating Prisma Client and applying migrations with remote DATABASE_URL"
remote_bash "$SERVER_APP_DIR" <<'REMOTE_MIGRATE'
set -euo pipefail
APP_DIR="$1"
cd "$APP_DIR"

DATABASE_URL="$(
node - <<'NODE'
const fs = require('fs');
const text = fs.readFileSync('.env', 'utf8');
const line = text.split(/\r?\n/).find((item) => item.startsWith('DATABASE_URL='));
if (!line) process.exit(2);
let value = line.slice('DATABASE_URL='.length).trim();
if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
  value = value.slice(1, -1);
}
process.stdout.write(value);
NODE
)"

DATABASE_URL="$DATABASE_URL" npm run prisma:generate --workspace @apple-business/api
DATABASE_URL="$DATABASE_URL" npm run prisma:migrate:deploy --workspace @apple-business/api
REMOTE_MIGRATE

echo "==> Restarting PM2 app: ${SERVER_PM2_APP}"
remote "pm2 restart '$SERVER_PM2_APP' && pm2 describe '$SERVER_PM2_APP' --no-color | sed -n '1,80p'"

echo "==> Checking remote local health"
remote_bash "$SERVER_API_PORT" <<'REMOTE_HEALTH'
set -euo pipefail
API_PORT="$1"

for attempt in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null; then
    echo "Remote local health is ready after ${attempt}s"
    exit 0
  fi

  sleep 1
done

echo "Remote local health did not become ready on port ${API_PORT}" >&2
exit 1
REMOTE_HEALTH

echo "==> Checking public API health and route presence"
check_http_status GET "${API_BASE_URL}/health/ready" 200
check_http_status GET "${API_BASE_URL}/id-business-v2/scope" 401
check_http_status GET "${API_BASE_URL}/id-business-v2/workspace-mailboxes" 401
check_http_status POST "${API_BASE_URL}/public/mailbox/query" 400

echo "Deployment finished for PM2 API: ${SERVER_PM2_APP}"
