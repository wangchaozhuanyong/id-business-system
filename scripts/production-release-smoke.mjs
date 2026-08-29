#!/usr/bin/env node
import assert from 'node:assert/strict';

assert.ok(process.env.BASE_URL, '缺少生产巡检地址 BASE_URL');
const baseUrl = new URL(
  process.env.BASE_URL?.endsWith('/') ? process.env.BASE_URL : `${process.env.BASE_URL}/`
);
const username = process.env.SMOKE_TEST_USERNAME;
const password = process.env.SMOKE_TEST_PASSWORD;
assert.ok(username && password, '缺少生产巡检账号');

async function request(path, options = {}) {
  return fetch(new URL(path, baseUrl), {
    ...options,
    signal: AbortSignal.timeout(20_000),
    headers: {
      'user-agent': 'id-business-v2-release-smoke',
      ...(options.headers ?? {})
    }
  });
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`JSON 响应无效：${response.status}`);
  }
}

const homeResponse = await request('/');
assert.equal(homeResponse.status, 200, '首页状态异常');
assert.match(homeResponse.headers.get('content-type') ?? '', /text\/html/iu, '首页 MIME 异常');
const html = await homeResponse.text();
const checkedAssets = new Set();
const assetQueue = [];

for (const match of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/gu)) {
  assetQueue.push(new URL(match[1], baseUrl).toString());
}
while (assetQueue.length) {
  const assetUrl = assetQueue.shift();
  if (!assetUrl || checkedAssets.has(assetUrl)) continue;
  assert.ok(checkedAssets.size < 500, '静态资源数量异常');
  const response = await fetch(assetUrl, { signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, 200, '静态资源状态异常');
  const contentType = response.headers.get('content-type') ?? '';
  if (new URL(assetUrl).pathname.endsWith('.js')) {
    assert.match(contentType, /javascript/iu, 'JS MIME 异常');
    const source = await response.text();
    for (const match of source.matchAll(/import\("([^"]+\.(?:js|css))"\)/gu)) {
      assetQueue.push(new URL(match[1], baseUrl).toString());
    }
  } else {
    assert.match(contentType, /text\/css/iu, 'CSS MIME 异常');
  }
  checkedAssets.add(assetUrl);
}
assert.ok(checkedAssets.size > 0, '未发现可巡检静态资源');

for (const [path, expectedStatus] of [
  ['/api/health/live', 200],
  ['/api/health/ready', 200],
  ['/api/id-business-v2/orders?page=1&pageSize=1', 401]
]) {
  const response = await request(path);
  assert.equal(response.status, expectedStatus, `${path} 状态异常`);
}

const loginResponse = await request('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password })
});
assert.ok([200, 201].includes(loginResponse.status), '登录失败');
const loginBody = await readJson(loginResponse);
const token = loginBody?.data?.accessToken;
assert.ok(token, '登录未返回令牌');
const authorizedHeaders = { authorization: `Bearer ${token}` };

const meResponse = await request('/api/auth/me', { headers: authorizedHeaders });
assert.equal(meResponse.status, 200, 'auth/me 失败');
const meBody = await readJson(meResponse);
assert.equal(meBody?.data?.username, username, 'auth/me 身份不一致');

const readonlyPaths = [
  '/api/id-business-v2/orders?page=1&pageSize=1',
  '/api/id-business-v2/renewals/workbench',
  '/api/id-business-v2/accounts?page=1&pageSize=1',
  '/api/id-business-v2/customers?page=1&pageSize=1',
  '/api/id-business-v2/activations?page=1&pageSize=1',
  '/api/id-business-v2/balances/workbench',
  '/api/id-business-v2/exchange-rates?page=1&pageSize=1'
];
for (const path of readonlyPaths) {
  const response = await request(path, { headers: authorizedHeaders });
  assert.equal(response.status, 200, `${path} 只读巡检失败`);
}

const forbiddenWrite = await request('/api/id-business-v2/orders', {
  method: 'POST',
  headers: { ...authorizedHeaders, 'content-type': 'application/json' },
  body: '{}'
});
assert.equal(forbiddenWrite.status, 403, '只读账号越权写入未被拒绝');

const logoutResponse = await request('/api/auth/logout', {
  method: 'POST',
  headers: authorizedHeaders
});
assert.ok([200, 201].includes(logoutResponse.status), '登出失败');
const revokedResponse = await request('/api/auth/me', { headers: authorizedHeaders });
assert.equal(revokedResponse.status, 401, '登出后令牌仍然有效');

console.log(
  JSON.stringify({
    ok: true,
    assets: checkedAssets.size,
    readonlyEndpoints: readonlyPaths.length,
    authorizationBoundary: 403,
    logoutRevocation: 401
  })
);
