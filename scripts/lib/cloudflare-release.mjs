export const RELEASE_REPOSITORY = 'wangchaozhuanyong/id-business-system';
export const RELEASE_BRANCH = 'main';
export const RELEASE_WORKER_NAME = 'daichongxitong-v2-free-20260727';
export const RELEASE_ACCOUNT_ID = 'a7e061557092f924beb4a7c8adc39c3d';
export const RELEASE_PUBLIC_URL = 'https://daichongxitong-v2-free-20260727.ppfzj1314.workers.dev';
export const RELEASE_SUPABASE_PROJECT_REF = 'fjquufgbnxyocmuzltxi';
export const RELEASE_SUPABASE_API_BASE_URL = `https://${RELEASE_SUPABASE_PROJECT_REF}.supabase.co/functions/v1/v2-api`;
export const RELEASE_V2_REALTIME_CHANGES_ENABLED = 'false';
export const REQUIRED_CHECKS = ['quality', 'production-images'];
export const SMOKE_ROLE_CODE = 'production_smoke_readonly';
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

export function createCloudflareProductionBuildEnvironment(env) {
  return {
    ...env,
    VITE_API_BASE_URL: '/api',
    VITE_V2_REALTIME_CHANGES_ENABLED: RELEASE_V2_REALTIME_CHANGES_ENABLED
  };
}

export function validateReleaseEnvironment(env) {
  const errors = [];

  validateProductionPostgresUrl(env.DATABASE_URL, 'DATABASE_URL', errors);
  validateRuntimeDatabaseRole(env.DATABASE_URL, errors);
  validateSecret(env.JWT_SECRET, 'JWT_SECRET', 32, errors);
  validateSecret(env.FIELD_ENCRYPTION_KEY, 'FIELD_ENCRYPTION_KEY', 32, errors);
  validateSecret(env.HASH_SECRET, 'HASH_SECRET', 32, errors);

  const username = env.SMOKE_TEST_USERNAME?.trim() ?? '';
  if (!username || username.length > 100 || unsafeValuePattern.test(username)) {
    errors.push('SMOKE_TEST_USERNAME 必须是有效的生产巡检账号');
  }
  validateSecret(env.SMOKE_TEST_PASSWORD, 'SMOKE_TEST_PASSWORD', 20, errors);

  return errors;
}

function validateRuntimeDatabaseRole(value, errors) {
  try {
    const url = new URL(value);
    const direct =
      url.hostname === `db.${RELEASE_SUPABASE_PROJECT_REF}.supabase.co` &&
      url.username === 'id_business_v2_runtime';
    const pooler =
      url.hostname.endsWith('.pooler.supabase.com') &&
      url.username === `id_business_v2_runtime.${RELEASE_SUPABASE_PROJECT_REF}`;
    if (!direct && !pooler) throw new Error();
  } catch {
    errors.push('DATABASE_URL 必须使用当前项目的 id_business_v2_runtime 最小权限角色');
  }
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

  if (config.alias && Object.keys(config.alias).length) {
    errors.push('Cloudflare 前端代理不得打包 NestJS/Prisma alias');
  }
  if (Array.isArray(config.hyperdrive) && config.hyperdrive.length) {
    errors.push('Cloudflare 前端代理不得绑定 Hyperdrive');
  }
  if (config.compatibility_flags?.includes('nodejs_compat')) {
    errors.push('Cloudflare 前端代理不得启用 nodejs_compat');
  }

  const vars = config.vars ?? {};
  if (vars.APP_PUBLIC_URL !== RELEASE_PUBLIC_URL) {
    errors.push(`APP_PUBLIC_URL 必须固定为 ${RELEASE_PUBLIC_URL}`);
  }
  if (vars.SUPABASE_API_BASE_URL !== RELEASE_SUPABASE_API_BASE_URL) {
    errors.push(`SUPABASE_API_BASE_URL 必须固定为 ${RELEASE_SUPABASE_API_BASE_URL}`);
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
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      unsafeValuePattern.test(value)
    ) {
      throw new Error();
    }
  } catch {
    errors.push(`${name} 必须是非本地生产 PostgreSQL 地址`);
  }
}

function validateSecret(value, name, minimumLength, errors) {
  if (typeof value !== 'string' || value.length < minimumLength || unsafeValuePattern.test(value)) {
    errors.push(`${name} 必须至少包含 ${minimumLength} 位非占位字符`);
  }
}
