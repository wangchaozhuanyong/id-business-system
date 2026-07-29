import process from 'node:process';
import { SMOKE_PERMISSIONS, SMOKE_ROLE_CODE } from './lib/cloudflare-release.mjs';

const baseUrl = process.argv[2]?.replace(/\/+$/, '');
const username = process.env.SMOKE_TEST_USERNAME?.trim();
const password = process.env.SMOKE_TEST_PASSWORD;

if (!baseUrl || !baseUrl.startsWith('https://')) {
  throw new Error('请传入 Cloudflare Workers HTTPS 地址');
}

if (!username || !password) {
  throw new Error('缺少 SMOKE_TEST_USERNAME 或 SMOKE_TEST_PASSWORD');
}

const publicEndpoints = ['/', '/api/health/live', '/api/health/ready'];
const checks = [];
for (const endpoint of publicEndpoints) {
  const response = await fetch(`${baseUrl}${endpoint}`);
  checks.push({ path: endpoint, status: response.status });
  if (!response.ok) {
    throw new Error(`${endpoint} 公共健康检查失败，HTTP ${response.status}`);
  }
}

const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json'
  },
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
  const response = await fetch(`${baseUrl}${endpoint}`, {
    headers: {
      authorization: `Bearer ${accessToken}`
    }
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

const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${accessToken}`
  }
});
checks.push({ path: '/api/auth/logout', status: logoutResponse.status });
if (!logoutResponse.ok) {
  throw new Error(`/api/auth/logout 验证失败，HTTP ${logoutResponse.status}`);
}

console.log(
  JSON.stringify(
    {
      baseUrl,
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
