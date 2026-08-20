import process from 'node:process';
import { createHmac, randomUUID } from 'node:crypto';
import { SMOKE_PERMISSIONS, SMOKE_ROLE_CODE } from './lib/cloudflare-release.mjs';
import { fetchWithDeploymentRetry } from './lib/deployment-smoke-retry.mjs';

const baseUrl = process.argv
  .find((argument, index) => index >= 2 && !argument.startsWith('--'))
  ?.replace(/\/+$/, '');
const apiOnly = process.argv.includes('--api-only');
const username = process.env.SMOKE_TEST_USERNAME?.trim();
const password = process.env.SMOKE_TEST_PASSWORD;

if (!baseUrl || !baseUrl.startsWith('https://')) {
  throw new Error('请传入生产 HTTPS 地址');
}

if (!username || !password) {
  throw new Error('缺少 SMOKE_TEST_USERNAME 或 SMOKE_TEST_PASSWORD');
}

const publicEndpoints = apiOnly
  ? ['/api/health/live', '/api/health/ready']
  : ['/', '/api/health/live', '/api/health/ready'];
const checks = [];
for (const endpoint of publicEndpoints) {
  const response = await fetchWithDeploymentRetry(`${baseUrl}${endpoint}`, {
    headers: requestHeaders()
  });
  checks.push({ path: endpoint, status: response.status });
  if (!response.ok) {
    throw new Error(`${endpoint} 公共健康检查失败，HTTP ${response.status}`);
  }
}

const invalidMailboxQueryResponse = await fetchWithDeploymentRetry(
  `${baseUrl}/api/public/mailbox/query`,
  {
    method: 'POST',
    headers: requestHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ credential: 'invalid', limit: 5 })
  }
);
checks.push({
  path: '/api/public/mailbox/query [invalid-input]',
  status: invalidMailboxQueryResponse.status
});
if (invalidMailboxQueryResponse.status !== 400) {
  throw new Error(
    `/api/public/mailbox/query 路由验证失败，期望 HTTP 400，实际 HTTP ${invalidMailboxQueryResponse.status}`
  );
}

const anonymousMailboxAdminResponse = await fetchWithDeploymentRetry(
  `${baseUrl}/api/id-business-v2/workspace-mailboxes`,
  { headers: requestHeaders() }
);
checks.push({
  path: '/api/id-business-v2/workspace-mailboxes [anonymous]',
  status: anonymousMailboxAdminResponse.status
});
if (anonymousMailboxAdminResponse.status !== 401) {
  throw new Error(
    `/api/id-business-v2/workspace-mailboxes 权限验证失败，期望 HTTP 401，实际 HTTP ${anonymousMailboxAdminResponse.status}`
  );
}

const loginResponse = await fetchWithDeploymentRetry(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: requestHeaders({
    'content-type': 'application/json'
  }),
  body: JSON.stringify({ username, password })
});
const loginPayload = await readJson(loginResponse);
const accessToken = loginPayload?.data?.accessToken ?? loginPayload?.accessToken;

if (!loginResponse.ok || typeof accessToken !== 'string' || !accessToken) {
  throw new Error(`线上登录失败，HTTP ${loginResponse.status}`);
}

const endpoints = [
  '/api/auth/me',
  '/api/id-business-v2/orders',
  '/api/id-business-v2/renewals/workbench',
  '/api/id-business-v2/accounts',
  '/api/id-business-v2/customers',
  '/api/id-business-v2/activations',
  '/api/id-business-v2/balances/workbench',
  '/api/id-business-v2/exchange-rates/effective'
];
checks.push({ path: '/api/auth/login', status: loginResponse.status });

for (const endpoint of endpoints) {
  const response = await fetchWithDeploymentRetry(`${baseUrl}${endpoint}`, {
    headers: requestHeaders({
      authorization: `Bearer ${accessToken}`
    })
  });
  checks.push({ path: endpoint, status: response.status });

  if (!response.ok) {
    throw new Error(`${endpoint} 验证失败，HTTP ${response.status}`);
  }

  if (endpoint === '/api/auth/me') {
    const payload = await readJson(response);
    const user = payload?.data ?? payload;
    if (
      !Array.isArray(user?.roles) ||
      user.roles.length !== 1 ||
      user.roles[0] !== SMOKE_ROLE_CODE
    ) {
      throw new Error('线上巡检账号角色不是唯一只读角色');
    }
    const actualPermissions = [...(user?.permissions ?? [])].sort();
    if (JSON.stringify(actualPermissions) !== JSON.stringify([...SMOKE_PERMISSIONS].sort())) {
      throw new Error('线上巡检账号权限不是预期的最小只读集合');
    }
  }
}

const deniedFinanceWrite = await fetchWithDeploymentRetry(
  `${baseUrl}/api/id-business-v2/finance/accounts`,
  {
    method: 'POST',
    headers: requestHeaders({
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json'
    }),
    body: JSON.stringify({
      currency: 'CNY',
      name: 'production-smoke-must-not-create'
    })
  }
);
checks.push({
  path: '/api/id-business-v2/finance/accounts [denied-write]',
  status: deniedFinanceWrite.status
});
if (deniedFinanceWrite.status !== 403) {
  throw new Error(
    `财务写入最小权限门禁验证失败，期望 HTTP 403，实际 HTTP ${deniedFinanceWrite.status}`
  );
}

const logoutResponse = await fetchWithDeploymentRetry(`${baseUrl}/api/auth/logout`, {
  method: 'POST',
  headers: requestHeaders({
    authorization: `Bearer ${accessToken}`
  })
});
checks.push({ path: '/api/auth/logout', status: logoutResponse.status });
if (!logoutResponse.ok) {
  throw new Error(`/api/auth/logout 验证失败，HTTP ${logoutResponse.status}`);
}

console.log(
  JSON.stringify(
    {
      baseUrl,
      apiOnly,
      ok: true,
      checks
    },
    null,
    2
  )
);

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function requestHeaders(headers = {}) {
  if (!apiOnly) return headers;
  const secret = process.env.V2_TRUSTED_PROXY_SECRET?.trim() ?? '';
  if (secret.length < 32) throw new Error('缺少 V2_TRUSTED_PROXY_SECRET，无法直连巡检 API');
  const clientIp = '127.0.0.1';
  const requestId = `release-smoke-${randomUUID()}`;
  const timestamp = String(Date.now());
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}\n${requestId}\n${clientIp}`)
    .digest('hex');
  return {
    ...headers,
    'x-request-id': requestId,
    'x-v2-client-ip': clientIp,
    'x-v2-proxy-signature': signature,
    'x-v2-proxy-timestamp': timestamp
  };
}
