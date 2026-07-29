#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"

echo "Checking admin: ${BASE_URL}"
curl --fail --silent --show-error "${BASE_URL}/" >/dev/null

echo "Checking admin static asset MIME types"
BASE_URL="${BASE_URL}" node --input-type=module <<'NODE'
const baseUrl = new URL(process.env.BASE_URL.endsWith('/') ? process.env.BASE_URL : `${process.env.BASE_URL}/`);
const checked = new Map();
const queue = [];
const failures = [];

function enqueue(ref) {
  const url = new URL(ref, baseUrl).toString();
  if (!checked.has(url)) queue.push(url);
}

function expectedType(url) {
  const pathname = new URL(url).pathname;
  if (pathname.endsWith('.js')) return 'javascript';
  if (pathname.endsWith('.css')) return 'text/css';
  return '';
}

function extractAssetRefs(source, sourceUrl) {
  const refs = new Set();
  const viteDeps = source.match(/m\.f\|\|\(m\.f=\[(.*?)\]\)\)/s);

  if (viteDeps) {
    for (const match of viteDeps[1].matchAll(/"([^"]+\.(?:js|css))"/g)) {
      refs.add(new URL(match[1], baseUrl).pathname);
    }
  }

  for (const match of source.matchAll(/import\("([^"]+\.(?:js|css))"\)/g)) {
    refs.add(new URL(match[1], sourceUrl).pathname);
  }

  return [...refs];
}

const pageResponse = await fetch(baseUrl);
const pageType = pageResponse.headers.get('content-type') ?? '';
if (!pageResponse.ok || !pageType.includes('text/html')) {
  throw new Error(`Admin page returned ${pageResponse.status} ${pageType || '(missing content-type)'}`);
}

const html = await pageResponse.text();
for (const match of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
  enqueue(match[1]);
}

while (queue.length) {
  const url = queue.shift();
  if (checked.has(url)) continue;

  const response = await fetch(url);
  const contentType = response.headers.get('content-type') ?? '';
  const type = expectedType(url);

  checked.set(url, { status: response.status, contentType });

  if (!response.ok || !contentType.includes(type)) {
    failures.push(`${url} -> ${response.status} ${contentType || '(missing content-type)'}`);
    continue;
  }

  if (url.endsWith('.js')) {
    const source = await response.text();
    for (const ref of extractAssetRefs(source, url)) enqueue(ref);
  }
}

if (failures.length) {
  console.error('Admin static asset check failed:');
  for (const failure of failures.slice(0, 30)) console.error(`- ${failure}`);
  if (failures.length > 30) console.error(`... and ${failures.length - 30} more`);
  process.exit(1);
}

console.log(`Checked ${checked.size} admin JS/CSS assets.`);
NODE

echo "Checking API live health"
LIVE_BODY="$(curl --fail --silent --show-error "${BASE_URL}/api/health/live")"
if [[ "${LIVE_BODY}" != *'"success":true'* || "${LIVE_BODY}" != *'"status":"ok"'* ]]; then
  echo "API live health did not return the expected JSON payload." >&2
  echo "${LIVE_BODY}" >&2
  exit 1
fi

echo "Checking API ready health"
READY_BODY="$(curl --fail --silent --show-error "${BASE_URL}/api/health/ready")"
if [[ "${READY_BODY}" != *'"success":true'* || "${READY_BODY}" != *'"status":"ready"'* ]]; then
  echo "API ready health did not return the expected JSON payload." >&2
  echo "${READY_BODY}" >&2
  exit 1
fi

echo "Production smoke check passed."
