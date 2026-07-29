#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rootDir = new URL('..', import.meta.url);
loadEnvFile(new URL('.env', rootDir));

const apiBaseUrl = String(process.env.V2_PERF_API_BASE_URL ?? '').replace(/\/$/, '');
const functionRegion = String(process.env.V2_PERF_FUNCTION_REGION ?? '').trim();
const probeRounds = Number(process.env.V2_PERF_ROUNDS ?? 3);
const username = process.env.V2_PERF_USERNAME ?? process.env.SEED_ADMIN_USERNAME;
const password = process.env.V2_PERF_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD;
assert.ok(apiBaseUrl, '缺少 V2_PERF_API_BASE_URL');
assert.ok(username && password, '缺少 V2 性能探测账号');
assert.ok(Number.isInteger(probeRounds) && probeRounds > 0, 'V2_PERF_ROUNDS 必须是正整数');

const login = await request('/auth/login', {
  method: 'POST',
  body: {
    username,
    password
  }
});
const accessToken = login.data?.accessToken;
assert.ok(accessToken, '性能探测登录没有返回 accessToken');

const probes = [
  '/id-business-v2/orders/bootstrap?page=1&pageSize=20&sortBy=openedAt&sortOrder=desc',
  '/id-business-v2/customers/bootstrap?page=1&pageSize=20&sortBy=sortOrder&sortOrder=asc',
  '/id-business-v2/accounts/bootstrap?page=1&pageSize=20&sortBy=sortOrder&sortOrder=asc',
  '/id-business-v2/renewals/workbench/bootstrap?page=1&pageSize=20&sortBy=dueAt&sortOrder=asc',
  '/id-business-v2/options/bootstrap?page=1&pageSize=20&type=id_status&sortBy=sortOrder&sortOrder=asc'
];

for (let round = 1; round <= probeRounds; round += 1) {
  for (const path of probes) {
    const result = await request(path, {
      accessToken
    });
    console.log(
      JSON.stringify({
        round,
        path: path.split('?')[0],
        status: result.status,
        totalMs: result.totalMs,
        serverTiming: result.serverTiming,
        edgeRegion: result.edgeRegion
      })
    );
  }
}

await request('/auth/logout', {
  method: 'POST',
  accessToken
}).catch(() => undefined);

function loadEnvFile(fileUrl) {
  try {
    for (const line of readFileSync(fileUrl, 'utf8').split(/\r?\n/)) {
      const normalized = line.trim();
      if (!normalized || normalized.startsWith('#')) continue;
      const separator = normalized.indexOf('=');
      if (separator < 0) continue;
      process.env[normalized.slice(0, separator)] ??= normalized.slice(separator + 1);
    }
  } catch {
    // Missing values are reported by assertions above.
  }
}

async function request(path, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(functionRegion ? { 'x-region': functionRegion } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30_000)
  });
  const payload = await response.json().catch(() => null);
  const totalMs = Math.round(performance.now() - startedAt);
  if (!response.ok) {
    throw new Error(`V2 API probe failed: ${response.status} ${path}`);
  }
  return {
    ...payload,
    status: response.status,
    totalMs,
    serverTiming: response.headers.get('server-timing') ?? '',
    edgeRegion: response.headers.get('x-sb-edge-region') ?? ''
  };
}
