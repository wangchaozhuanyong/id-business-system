import process from 'node:process';
import { fetchWithReleasePolicy } from './lib/cloudflare-deployment.mjs';
import { SMOKE_PERMISSIONS, SMOKE_ROLE_CODE, SMOKE_USERNAME } from './lib/cloudflare-release.mjs';
import { createTotpCode, validateTotpSecret } from './lib/totp.mjs';

const baseUrl = process.argv[2]?.replace(/\/+$/, '');
const username = process.env.SMOKE_TEST_USERNAME?.trim();
const password = process.env.SMOKE_TEST_PASSWORD;
const mfaTotpSecret = process.env.SMOKE_TEST_MFA_TOTP_SECRET;
const supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, '');
const frontendSupabaseKey =
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() || process.env.VITE_SUPABASE_ANON_KEY?.trim();

if (!baseUrl || !baseUrl.startsWith('https://')) {
  throw new Error('请传入 Cloudflare Workers HTTPS 地址');
}

if (
  username !== SMOKE_USERNAME ||
  !password ||
  !validateTotpSecret(mfaTotpSecret) ||
  !supabaseUrl ||
  !frontendSupabaseKey
) {
  throw new Error(
    `SMOKE_TEST_USERNAME 必须固定为 ${SMOKE_USERNAME}，且密码、TOTP secret、SUPABASE_URL 和前端公开 key 必须有效`
  );
}

const publicEndpoints = ['/', '/api/health/live', '/api/health/ready'];
const checks = [];
for (const endpoint of publicEndpoints) {
  const response = await fetchWithReleasePolicy(`${baseUrl}${endpoint}`);
  checks.push({ path: endpoint, status: response.status });
  if (!response.ok) {
    throw new Error(`${endpoint} 公共健康检查失败，HTTP ${response.status}`);
  }
  if (endpoint === '/') {
    await verifyFrontendEntry(response);
  }
}

const loginResponse = await fetchWithReleasePolicy(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json'
  },
  body: JSON.stringify({
    username,
    password,
    mfaCode: createTotpCode(mfaTotpSecret)
  })
});
const loginPayload = await readJson(loginResponse);
let accessToken = loginPayload?.data?.accessToken ?? loginPayload?.accessToken;
const refreshToken = loginPayload?.data?.refreshToken ?? loginPayload?.refreshToken;
const expiresAt = loginPayload?.data?.expiresAt ?? loginPayload?.expiresAt;

if (
  !loginResponse.ok ||
  typeof accessToken !== 'string' ||
  !accessToken ||
  typeof refreshToken !== 'string' ||
  !refreshToken ||
  typeof expiresAt !== 'string' ||
  !Number.isFinite(Date.parse(expiresAt)) ||
  Date.parse(expiresAt) <= Date.now()
) {
  throw new Error(`线上登录失败，HTTP ${loginResponse.status}`);
}
assertSupabaseAccessToken(accessToken, supabaseUrl);
accessToken = await refreshWithFrontendSupabaseKey(refreshToken);
assertSupabaseAccessToken(accessToken, supabaseUrl);
checks.push({ path: 'Supabase frontend token refresh', status: 200 });

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
  const response = await fetchWithReleasePolicy(`${baseUrl}${endpoint}`, {
    headers: {
      accept: 'application/json',
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

const logoutResponse = await fetchWithReleasePolicy(`${baseUrl}/api/auth/logout`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${accessToken}`
  }
});
checks.push({ path: '/api/auth/logout', status: logoutResponse.status });
if (!logoutResponse.ok) {
  throw new Error(`/api/auth/logout 验证失败，HTTP ${logoutResponse.status}`);
}

const revokedSessionResponse = await fetchWithReleasePolicy(`${baseUrl}/api/auth/me`, {
  headers: {
    authorization: `Bearer ${accessToken}`
  }
});
checks.push({
  path: '/api/auth/me (revoked session)',
  status: revokedSessionResponse.status
});
if (revokedSessionResponse.status !== 401) {
  throw new Error(`退出后的会话仍可使用，HTTP ${revokedSessionResponse.status}`);
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

async function verifyFrontendEntry(response) {
  const html = await response.text();
  if (!/<meta\s+name=["']v2-build-id["']\s+content=["'][^"']+["']/i.test(html)) {
    throw new Error('线上首页缺少可追溯构建标识');
  }
  const scriptPath = html.match(
    /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/i
  )?.[1];
  if (!scriptPath) {
    throw new Error('线上首页缺少管理端模块入口');
  }
  const assetResponse = await fetchWithReleasePolicy(new URL(scriptPath, baseUrl));
  if (!assetResponse.ok) {
    throw new Error(`管理端模块入口加载失败，HTTP ${assetResponse.status}`);
  }
  const assetContentType = assetResponse.headers.get('content-type') ?? '';
  if (!/(?:java|ecma)script/i.test(assetContentType)) {
    throw new Error(`管理端模块入口 Content-Type 无效：${assetContentType || 'missing'}`);
  }
  if ((await assetResponse.arrayBuffer()).byteLength === 0) {
    throw new Error('管理端模块入口内容为空');
  }
  checks.push({
    path: scriptPath,
    status: assetResponse.status
  });
}

async function refreshWithFrontendSupabaseKey(refreshToken) {
  const response = await fetchWithReleasePolicy(
    `${supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
    {
      method: 'POST',
      headers: {
        apikey: frontendSupabaseKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        refresh_token: refreshToken
      })
    }
  );
  const payload = await readJson(response);
  if (!response.ok || typeof payload?.access_token !== 'string' || !payload.access_token) {
    throw new Error(`前端 Supabase key 无法刷新真实会话，HTTP ${response.status}`);
  }
  return payload.access_token;
}

function assertSupabaseAccessToken(accessToken, expectedSupabaseUrl) {
  const payloadPart = accessToken.split('.')[1];
  if (!payloadPart) {
    throw new Error('线上登录未返回 Supabase JWT');
  }

  try {
    const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    const expectedIssuer = `${expectedSupabaseUrl}/auth/v1`;
    if (
      claims.iss !== expectedIssuer ||
      claims.aal !== 'aal2' ||
      typeof claims.session_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        claims.session_id
      )
    ) {
      throw new Error('claims mismatch');
    }
  } catch {
    throw new Error('线上登录未使用预期 Supabase 项目、AAL2 和稳定会话标识');
  }
}
