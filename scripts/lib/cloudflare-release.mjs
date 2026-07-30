import { validateTotpSecret } from './totp.mjs';

export const RELEASE_REPOSITORY = 'wangchaozhuanyong/id-business-system';
export const RELEASE_BRANCH = 'main';
export const RELEASE_WORKER_NAME = 'daichongxitong-v2-free-20260727';
export const RELEASE_ACCOUNT_ID = 'a7e061557092f924beb4a7c8adc39c3d';
export const RELEASE_PUBLIC_URL = 'https://daichongxitong-v2-free-20260727.ppfzj1314.workers.dev';
export const RELEASE_SUPABASE_PROJECT_REF = 'fjquufgbnxyocmuzltxi';
export const RELEASE_V2_REALTIME_CHANGES_ENABLED = 'false';
export const REQUIRED_CHECKS = ['quality', 'production-images'];
export const SMOKE_USERNAME = 'production_release_smoke';
export const SMOKE_AUTH_EMAIL =
  'production-release-smoke@daichongxitong-v2-free-20260727.ppfzj1314.workers.dev';
export const SMOKE_AUTH_ACTOR = 'id_business_v2_production_smoke';
export const SMOKE_DISPLAY_NAME = '生产发布只读巡检';
export const RELEASE_REQUIRED_ENV_KEYS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'FIELD_ENCRYPTION_KEY',
  'HASH_SECRET',
  'ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET',
  'AUTH_PROVIDER',
  'SUPABASE_URL',
  'VITE_API_BASE_URL',
  'VITE_SUPABASE_URL',
  'VITE_V2_REALTIME_CHANGES_ENABLED',
  'SMOKE_TEST_USERNAME',
  'SMOKE_TEST_PASSWORD',
  'SMOKE_TEST_MFA_TOTP_SECRET'
];
export const RELEASE_REQUIRED_ENV_KEY_GROUPS = [
  ['SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'],
  ['VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY']
];
export const SMOKE_ROLE_CODE = 'production_smoke_readonly';
export const SMOKE_ROLE_NAME = '生产发布只读巡检';
export const SMOKE_ROLE_DESCRIPTION = '仅用于生产发布后的自动只读健康检查';
export const SMOKE_PERMISSIONS = [
  'apple.order.view',
  'apple.renewal_task.view',
  'apple.account.view',
  'customer.view',
  'apple.activation.view',
  'apple.balance.view',
  'apple.exchange_rate.view'
];

const unsafeValuePattern =
  /(change_me|replace_with|placeholder|example\.(com|net|org)|localhost|127\.0\.0\.1|0\.0\.0\.0|\.test(?::|\/|$)|\.invalid(?::|\/|$))/i;
const BUILD_ENV_PASSTHROUGH_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'SHELL',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'CI',
  'NO_COLOR',
  'FORCE_COLOR',
  'NODE_OPTIONS'
];
const RUNTIME_SECRET_KEYS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'FIELD_ENCRYPTION_KEY',
  'HASH_SECRET',
  'ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY'
];
const RELEASE_MANAGED_ENV_KEYS = new Set([
  ...RELEASE_REQUIRED_ENV_KEYS,
  ...RELEASE_REQUIRED_ENV_KEY_GROUPS.flat()
]);

export function createCloudflareProductionBuildEnvironment(env) {
  const publicKey = firstConfiguredValue(
    env.VITE_SUPABASE_PUBLISHABLE_KEY,
    env.VITE_SUPABASE_ANON_KEY
  );
  const buildEnvironment = {
    NODE_ENV: 'production',
    AUTH_PROVIDER: 'supabase',
    SUPABASE_URL: env.SUPABASE_URL,
    VITE_API_BASE_URL: '/api',
    VITE_SUPABASE_URL: env.VITE_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: publicKey,
    VITE_SUPABASE_PUBLISHABLE_KEY: publicKey,
    VITE_SUPABASE_FUNCTION_REGION: env.VITE_SUPABASE_FUNCTION_REGION,
    VITE_V2_REALTIME_CHANGES_ENABLED: RELEASE_V2_REALTIME_CHANGES_ENABLED
  };

  for (const key of BUILD_ENV_PASSTHROUGH_KEYS) {
    if (typeof env[key] === 'string' && env[key]) {
      buildEnvironment[key] = env[key];
    }
  }

  return buildEnvironment;
}

export function createCloudflareRuntimeSecrets(env) {
  const runtimeSecrets = {};
  for (const key of RUNTIME_SECRET_KEYS) {
    if (typeof env[key] === 'string' && env[key]) {
      runtimeSecrets[key] = env[key];
    }
  }
  const publicKey = firstConfiguredValue(env.SUPABASE_PUBLISHABLE_KEY, env.SUPABASE_ANON_KEY);
  const serviceKey = firstConfiguredValue(env.SUPABASE_SECRET_KEY, env.SUPABASE_SERVICE_ROLE_KEY);
  if (publicKey) {
    runtimeSecrets.SUPABASE_ANON_KEY = publicKey;
    runtimeSecrets.SUPABASE_PUBLISHABLE_KEY = publicKey;
  }
  if (serviceKey) {
    runtimeSecrets.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
    runtimeSecrets.SUPABASE_SECRET_KEY = serviceKey;
  }
  return runtimeSecrets;
}

export function createReleaseSubprocessEnvironment(env, allowedManagedKeys = []) {
  const allowed = new Set(allowedManagedKeys);
  const result = { ...env };
  for (const key of RELEASE_MANAGED_ENV_KEYS) {
    if (!allowed.has(key)) delete result[key];
  }
  return result;
}

export function validateCloudflareRemoteSecretNames(
  actualNames,
  expectedNames,
  { allowMissing = false } = {}
) {
  const errors = [];
  const actual = new Set(actualNames);
  const expected = new Set(expectedNames);
  for (const name of actual) {
    if (!expected.has(name)) {
      errors.push(`Cloudflare Worker 存在未纳入发布清单的远端 secret：${name}`);
    }
  }
  if (!allowMissing) {
    for (const name of expected) {
      if (!actual.has(name)) {
        errors.push(`Cloudflare Worker 缺少本次版本要求的远端 secret：${name}`);
      }
    }
  }
  return errors;
}

export function isSmokeMfaBootstrapCommand(command, args) {
  return (
    command === 'npm' &&
    Array.isArray(args) &&
    args.length === 2 &&
    args[0] === 'run' &&
    args[1] === 'prod:smoke-user:provision:with-env'
  );
}

export function validateCloudflareHyperdriveTarget(
  hyperdrive,
  expectedId,
  databaseUrlValue,
  supabaseUrlValue
) {
  const errors = [];
  let databaseUrl;
  let database = '';
  let schema = null;
  let expectedProjectRef = '';

  try {
    databaseUrl = new URL(databaseUrlValue);
    database = decodeURIComponent(databaseUrl.pathname.replace(/^\/+/, ''));
    schema = databaseUrl.searchParams.get('schema');
  } catch {
    errors.push('Cloudflare Hyperdrive 无法核对无效的 DATABASE_URL');
  }
  try {
    expectedProjectRef =
      new URL(supabaseUrlValue).hostname
        .toLowerCase()
        .match(/^([a-z0-9]{20})\.supabase\.co$/)?.[1] ?? '';
  } catch {
    errors.push('Cloudflare Hyperdrive 无法核对无效的 SUPABASE_URL');
  }

  const expectedHost = expectedProjectRef ? `db.${expectedProjectRef}.supabase.co` : '';
  const origin = hyperdrive?.origin;
  if (
    hyperdrive?.id !== expectedId ||
    !expectedHost ||
    String(origin?.host ?? '').toLowerCase() !== expectedHost ||
    origin?.user !== 'postgres' ||
    Number(origin?.port) !== 5432 ||
    origin?.database !== 'postgres' ||
    !['postgres', 'postgresql'].includes(String(origin?.scheme ?? '').toLowerCase()) ||
    hyperdrive?.caching?.disabled !== true ||
    !databaseUrl ||
    !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
    database !== 'postgres' ||
    ![null, 'public'].includes(schema)
  ) {
    errors.push(
      'Cloudflare Hyperdrive 必须直连当前 Supabase 项目的 db.<project-ref>.supabase.co:5432/postgres，使用 postgres 用户并关闭查询缓存'
    );
  }

  return errors;
}

export function validateReleaseEnvironment(env) {
  const errors = [];

  const databaseUrl = validateProductionPostgresUrl(env.DATABASE_URL, 'DATABASE_URL', errors);
  validateSecret(env.JWT_SECRET, 'JWT_SECRET', 32, errors);
  validateSecret(env.FIELD_ENCRYPTION_KEY, 'FIELD_ENCRYPTION_KEY', 32, errors);
  validateSecret(env.HASH_SECRET, 'HASH_SECRET', 32, errors);
  validateSecret(
    env.ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET,
    'ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET',
    32,
    errors
  );
  if (env.AUTH_PROVIDER?.trim() !== 'supabase') {
    errors.push('AUTH_PROVIDER 必须固定为 supabase');
  }

  const backendUrl = validateProductionHttpsUrl(env.SUPABASE_URL, 'SUPABASE_URL', errors);
  const frontendUrl = validateProductionHttpsUrl(
    env.VITE_SUPABASE_URL,
    'VITE_SUPABASE_URL',
    errors
  );
  if (backendUrl && frontendUrl && backendUrl !== frontendUrl) {
    errors.push('SUPABASE_URL 与 VITE_SUPABASE_URL 必须指向同一个 Supabase 项目');
  }
  const authProjectRef = getSupabaseProjectRef(env.SUPABASE_URL);
  const databaseProjectRef = getSupabaseDatabaseProjectRef(databaseUrl);
  if (!authProjectRef) {
    errors.push('SUPABASE_URL 必须使用可核验项目 ref 的 Supabase 项目地址');
  } else if (authProjectRef !== RELEASE_SUPABASE_PROJECT_REF) {
    errors.push(`Supabase 生产项目必须固定为 ${RELEASE_SUPABASE_PROJECT_REF}`);
  }
  if (!databaseProjectRef) {
    errors.push('DATABASE_URL 必须包含可核验的 Supabase 项目 ref');
  }
  if (authProjectRef && databaseProjectRef && authProjectRef !== databaseProjectRef) {
    errors.push('DATABASE_URL 与 Supabase Auth 必须属于同一个生产项目');
  }
  if (env.VITE_API_BASE_URL?.trim() !== '/api') {
    errors.push('Cloudflare 单体发布要求 VITE_API_BASE_URL=/api');
  }

  const backendPublicKeys = validateCredentialGroup(
    env,
    RELEASE_REQUIRED_ENV_KEY_GROUPS[0],
    '后端 Supabase publishable/anon key',
    'public',
    errors
  );
  const serviceKeys = validateCredentialGroup(
    env,
    RELEASE_REQUIRED_ENV_KEY_GROUPS[1],
    '后端 Supabase service/secret key',
    'service',
    errors
  );
  const frontendPublicKeys = validateCredentialGroup(
    env,
    RELEASE_REQUIRED_ENV_KEY_GROUPS[2],
    '前端 Supabase publishable/anon key',
    'public',
    errors
  );
  if (
    serviceKeys.some(
      (serviceKey) =>
        backendPublicKeys.includes(serviceKey) || frontendPublicKeys.includes(serviceKey)
    )
  ) {
    errors.push('Supabase publishable/anon key 与 service/secret key 必须分离');
  }
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('VITE_') && /(SERVICE_ROLE|SECRET_KEY)/.test(name) && value?.trim()) {
      errors.push(`${name} 不得进入前端环境`);
    }
  }

  if (env.VITE_V2_REALTIME_CHANGES_ENABLED?.trim() !== 'false') {
    errors.push('Supabase Auth 首发要求 VITE_V2_REALTIME_CHANGES_ENABLED=false');
  }

  const username = env.SMOKE_TEST_USERNAME?.trim() ?? '';
  if (username !== SMOKE_USERNAME) {
    errors.push(`SMOKE_TEST_USERNAME 必须固定为 ${SMOKE_USERNAME}`);
  }
  validateSecret(env.SMOKE_TEST_PASSWORD, 'SMOKE_TEST_PASSWORD', 20, errors);
  if (!validateTotpSecret(env.SMOKE_TEST_MFA_TOTP_SECRET)) {
    errors.push('SMOKE_TEST_MFA_TOTP_SECRET 必须是至少 16 位的有效 Base32 TOTP secret');
  }

  return errors;
}

export function validateWranglerConfig(config) {
  const errors = [];

  if (config.account_id !== RELEASE_ACCOUNT_ID) {
    errors.push(`Cloudflare account_id 必须固定为 ${RELEASE_ACCOUNT_ID}`);
  }
  if (config.name !== RELEASE_WORKER_NAME) {
    errors.push(`Worker 名称必须固定为 ${RELEASE_WORKER_NAME}`);
  }
  if (config.main !== './deploy/cloudflare-free/worker.mjs') {
    errors.push('Worker 入口配置不正确');
  }
  if (config.assets?.directory !== './apps/admin/dist') {
    errors.push('管理端静态资源目录配置不正确');
  }
  if (config.assets?.not_found_handling !== 'single-page-application') {
    errors.push('管理端 SPA 回退配置不正确');
  }
  if (!config.assets?.run_worker_first?.includes('/api/*')) {
    errors.push('API 必须优先由 Worker 处理');
  }

  const hyperdrive = config.hyperdrive?.find((item) => item.binding === 'HYPERDRIVE');
  if (!hyperdrive || !/^[a-f0-9]{32}$/i.test(hyperdrive.id ?? '')) {
    errors.push('HYPERDRIVE 绑定缺失或 ID 无效');
  }

  const vars = config.vars ?? {};
  if (vars.NODE_ENV !== 'production') {
    errors.push('NODE_ENV 必须为 production');
  }
  if (vars.CLOUDFLARE_WORKER !== 'true') {
    errors.push('CLOUDFLARE_WORKER 必须为 true');
  }
  if (vars.APP_PUBLIC_URL !== RELEASE_PUBLIC_URL) {
    errors.push(`APP_PUBLIC_URL 必须固定为 ${RELEASE_PUBLIC_URL}`);
  }
  if (vars.CORS_ORIGIN !== RELEASE_PUBLIC_URL) {
    errors.push(`CORS_ORIGIN 必须固定为 ${RELEASE_PUBLIC_URL}`);
  }
  if (vars.AUTH_PROVIDER !== 'supabase') {
    errors.push('Worker AUTH_PROVIDER 必须固定为 supabase');
  }
  if (vars.SUPABASE_EDGE_FUNCTION !== 'false') {
    errors.push('Cloudflare Worker SUPABASE_EDGE_FUNCTION 必须固定为 false');
  }
  if (!['true', 'false'].includes(vars.ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED)) {
    errors.push('汇率自动采集开关必须是 true 或 false');
  }

  const staleMs = Number(vars.ID_BUSINESS_V2_EXCHANGE_RATE_STALE_MS);
  if (!Number.isInteger(staleMs) || staleMs < 60_000 || staleMs > 3_600_000) {
    errors.push('汇率缓存时长必须在 60000 到 3600000 毫秒之间');
  }

  return errors;
}

export function validateGitState(state) {
  const errors = [];

  if (state.repository !== RELEASE_REPOSITORY) {
    errors.push(`origin 必须指向 ${RELEASE_REPOSITORY}`);
  }
  if (state.branch !== RELEASE_BRANCH) {
    errors.push(`生产发布只能从 ${RELEASE_BRANCH} 分支执行`);
  }
  if (state.status) {
    errors.push('生产发布要求工作区完全干净');
  }
  if (!state.head || state.head !== state.originHead) {
    errors.push('本地 HEAD 必须与 origin/main 完全一致');
  }

  return errors;
}

export function validateGitHubReleaseState({ checkRuns, protection }) {
  const errors = [];

  for (const checkName of REQUIRED_CHECKS) {
    const latest = checkRuns
      .filter((check) => check.name === checkName)
      .sort((left, right) => Number(right.id ?? 0) - Number(left.id ?? 0))[0];
    if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') {
      errors.push(`GitHub 检查 ${checkName} 尚未成功`);
    }
  }

  const protectedContexts = new Set([
    ...(protection.required_status_checks?.contexts ?? []),
    ...(protection.required_status_checks?.checks ?? []).map((check) => check.context)
  ]);
  for (const checkName of REQUIRED_CHECKS) {
    if (!protectedContexts.has(checkName)) {
      errors.push(`主分支保护缺少必需检查 ${checkName}`);
    }
  }
  if (protection.required_status_checks?.strict !== true) {
    errors.push('主分支保护必须要求分支与 main 保持最新');
  }
  if (protection.enforce_admins?.enabled !== true) {
    errors.push('主分支保护必须同时约束管理员');
  }
  if (!protection.required_pull_request_reviews) {
    errors.push('主分支保护必须要求通过 Pull Request 合并');
  } else {
    if (Number(protection.required_pull_request_reviews.required_approving_review_count ?? 0) < 1) {
      errors.push('主分支保护必须至少要求一名审查者批准');
    }
    if (protection.required_pull_request_reviews.dismiss_stale_reviews !== true) {
      errors.push('主分支保护必须在新提交后撤销旧批准');
    }
    if (protection.required_pull_request_reviews.require_code_owner_reviews !== true) {
      errors.push('主分支保护必须要求 CODEOWNERS 审查');
    }
    if (protection.required_pull_request_reviews.require_last_push_approval !== true) {
      errors.push('主分支保护必须禁止最后推送者自行批准');
    }
  }
  if (protection.required_linear_history?.enabled !== true) {
    errors.push('主分支保护必须要求线性历史');
  }
  if (protection.required_conversation_resolution?.enabled !== true) {
    errors.push('主分支保护必须要求解决所有对话');
  }
  if (protection.allow_force_pushes?.enabled === true) {
    errors.push('主分支保护不得允许强制推送');
  }
  if (protection.allow_deletions?.enabled === true) {
    errors.push('主分支保护不得允许删除 main');
  }

  return errors;
}

export function parseGitHubRepository(remote) {
  const match = remote
    .trim()
    .match(/github\.com(?::|\/)(?<repository>[^/:\s]+\/[^/\s]+?)(?:\.git)?$/i);
  return match?.groups?.repository ?? '';
}

function validateProductionPostgresUrl(value, name, errors) {
  try {
    const url = new URL(value);
    const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const schema = url.searchParams.get('schema');
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      database !== 'postgres' ||
      ![null, 'public'].includes(schema) ||
      unsafeValuePattern.test(value)
    ) {
      throw new Error();
    }
    return url;
  } catch {
    errors.push(`${name} 必须是非本地生产 PostgreSQL 地址，并固定使用 postgres/public`);
    return null;
  }
}

function validateSecret(value, name, minimumLength, errors) {
  if (typeof value !== 'string' || value.length < minimumLength || unsafeValuePattern.test(value)) {
    errors.push(`${name} 必须至少包含 ${minimumLength} 位非占位字符`);
  }
}

function validateProductionHttpsUrl(value, name, errors) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.port ||
      !['', '/'].includes(url.pathname) ||
      url.search ||
      url.hash ||
      unsafeValuePattern.test(value)
    ) {
      throw new Error();
    }
    return url.origin.toLowerCase();
  } catch {
    errors.push(`${name} 必须是无路径、查询参数或片段的生产 HTTPS 项目根地址`);
    return '';
  }
}

function validateCredentialGroup(env, names, label, expectedKind, errors) {
  const configured = names.map((name) => env[name]?.trim() ?? '').filter(Boolean);
  if (!configured.length) {
    errors.push(`${label} 必须完整配置`);
    return [];
  }
  if (
    configured.some(
      (value) =>
        value.length < 20 ||
        unsafeValuePattern.test(value) ||
        classifySupabaseCredential(value) !== expectedKind
    )
  ) {
    errors.push(
      `${label} 必须使用可正向识别的 ${
        expectedKind === 'public' ? 'publishable/anon' : 'secret/service_role'
      } 凭据`
    );
  }
  return configured;
}

export function classifySupabaseCredential(value) {
  if (value.startsWith('sb_publishable_')) return 'public';
  if (value.startsWith('sb_secret_')) return 'service';

  const parts = value.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) return 'unknown';
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (claims?.role === 'anon') return 'public';
    if (claims?.role === 'service_role') return 'service';
  } catch {
    return 'unknown';
  }
  return 'unknown';
}

function firstConfiguredValue(...values) {
  return values.map((value) => value?.trim()).find(Boolean) ?? '';
}

function getSupabaseProjectRef(value) {
  try {
    return new URL(value).hostname.toLowerCase().match(/^([a-z0-9]{20})\.supabase\.co$/)?.[1] ?? '';
  } catch {
    return '';
  }
}

function getSupabaseDatabaseProjectRef(databaseUrl) {
  if (!databaseUrl) return '';
  return getSupabaseDatabaseProjectRefFromTarget(databaseUrl.hostname, databaseUrl.username);
}

export function getSupabaseDatabaseProjectRefFromTarget(hostValue, usernameValue) {
  const hostname = String(hostValue ?? '').toLowerCase();
  const hostnameRef = hostname.match(/^db\.([a-z0-9]{20})\.supabase\.co$/)?.[1];
  if (hostnameRef) return hostnameRef;
  if (!/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(hostname)) return '';

  try {
    return (
      decodeURIComponent(String(usernameValue ?? ''))
        .toLowerCase()
        .match(/^postgres\.([a-z0-9]{20})$/)?.[1] ?? ''
    );
  } catch {
    return '';
  }
}
