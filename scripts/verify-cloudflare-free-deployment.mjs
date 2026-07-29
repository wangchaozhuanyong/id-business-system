import process from 'node:process';

const baseUrl = process.argv[2]?.replace(/\/+$/, '');
const username = process.env.SEED_ADMIN_USERNAME?.trim();
const password = process.env.SEED_ADMIN_PASSWORD;

if (!baseUrl || !baseUrl.startsWith('https://')) {
  throw new Error('请传入 Cloudflare Workers HTTPS 地址');
}

if (!username || !password) {
  throw new Error('缺少 SEED_ADMIN_USERNAME 或 SEED_ADMIN_PASSWORD');
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
  '/api/id-business-v2/options',
  '/api/id-business-v2/balances/workbench',
  '/api/id-business-v2/exchange-rates/effective'
];
const checks = [{ path: '/api/auth/login', status: loginResponse.status }];

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
