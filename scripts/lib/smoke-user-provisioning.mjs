import {
  SMOKE_AUTH_ACTOR,
  SMOKE_AUTH_EMAIL,
  SMOKE_DISPLAY_NAME,
  SMOKE_ROLE_CODE,
  SMOKE_ROLE_DESCRIPTION,
  SMOKE_ROLE_NAME,
  SMOKE_USERNAME,
  RELEASE_SUPABASE_PROJECT_REF,
  classifySupabaseCredential,
  getSupabaseDatabaseProjectRefFromTarget
} from './cloudflare-release.mjs';

export class SmokeProvisioningSafetyError extends Error {}

export function assertDedicatedSmokeBusinessUsers(users) {
  if (!users.length) return null;
  if (users.length !== 1) {
    throw new SmokeProvisioningSafetyError('固定巡检账号标识命中了多个业务用户，已拒绝修改');
  }

  const user = users[0];
  const roleCodes = user.userRoles.map((assignment) => assignment.role.code);
  const email = user.email?.trim().toLowerCase() ?? '';
  if (
    user.username !== SMOKE_USERNAME ||
    user.displayName !== SMOKE_DISPLAY_NAME ||
    (email && email !== SMOKE_AUTH_EMAIL) ||
    roleCodes.length !== 1 ||
    roleCodes[0] !== SMOKE_ROLE_CODE
  ) {
    throw new SmokeProvisioningSafetyError('固定巡检账号标识已被非专用业务用户占用，已拒绝修改');
  }

  return user;
}

export function assertDedicatedSmokeRole(role) {
  if (!role) return;

  const assignedUsernames = role.userRoles.map((assignment) => assignment.user.username);
  if (
    role.code !== SMOKE_ROLE_CODE ||
    role.name !== SMOKE_ROLE_NAME ||
    role.description !== SMOKE_ROLE_DESCRIPTION ||
    assignedUsernames.some((username) => username !== SMOKE_USERNAME)
  ) {
    throw new SmokeProvisioningSafetyError('固定巡检角色标识已被非专用角色占用，已拒绝修改');
  }
}

export function assertDedicatedSmokeIdentity(identity, { userId, authUserId }) {
  if (!identity) return;
  if (
    !userId ||
    identity.userId !== userId ||
    identity.authUserId !== authUserId ||
    identity.usernameNormalized !== SMOKE_USERNAME ||
    identity.authEmail.toLowerCase() !== SMOKE_AUTH_EMAIL
  ) {
    throw new SmokeProvisioningSafetyError('固定巡检身份标识已绑定到其他账号，已拒绝修改');
  }
}

export function assertDedicatedSupabaseAuthUser(user) {
  if (
    !user ||
    user.email?.trim().toLowerCase() !== SMOKE_AUTH_EMAIL ||
    user.app_metadata?.id_business_system_actor !== SMOKE_AUTH_ACTOR
  ) {
    throw new SmokeProvisioningSafetyError(
      '固定巡检邮箱已被非专用 Supabase Auth 用户占用，已拒绝修改'
    );
  }
}

export function assertSmokeProvisioningEnvironment(env) {
  const username = env.SMOKE_TEST_USERNAME?.trim() ?? '';
  const password = env.SMOKE_TEST_PASSWORD;
  const authProvider = env.AUTH_PROVIDER?.trim() || 'local';

  if (username !== SMOKE_USERNAME) {
    throw new Error(`SMOKE_TEST_USERNAME 必须固定为 ${SMOKE_USERNAME}`);
  }
  if (typeof password !== 'string' || password.length < 20) {
    throw new Error('SMOKE_TEST_PASSWORD 必须至少包含 20 个字符');
  }
  if (!['local', 'supabase'].includes(authProvider)) {
    throw new Error('AUTH_PROVIDER 必须是 local 或 supabase');
  }

  if (authProvider === 'supabase') {
    const url = env.SUPABASE_URL?.trim() ?? '';
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || env.SUPABASE_SECRET_KEY?.trim();
    const databaseUrlValue = env.DATABASE_URL?.trim() ?? '';
    let supabaseUrl;
    try {
      const parsedUrl = new URL(url);
      if (
        parsedUrl.protocol !== 'https:' ||
        parsedUrl.hostname.toLowerCase() !== `${RELEASE_SUPABASE_PROJECT_REF}.supabase.co` ||
        parsedUrl.username ||
        parsedUrl.password ||
        (parsedUrl.pathname !== '/' && parsedUrl.pathname !== '') ||
        parsedUrl.search ||
        parsedUrl.hash
      ) {
        throw new Error();
      }
      supabaseUrl = parsedUrl.origin;
    } catch {
      throw new Error('SUPABASE_URL 必须是本仓库固定的生产 Supabase HTTPS 项目根地址');
    }
    if (
      !serviceKey ||
      serviceKey.length < 20 ||
      classifySupabaseCredential(serviceKey) !== 'service'
    ) {
      throw new Error('Supabase 巡检账号 provisioning 缺少服务端管理配置');
    }
    try {
      const databaseUrl = new URL(databaseUrlValue);
      const database = decodeURIComponent(databaseUrl.pathname.replace(/^\/+/, ''));
      const schema = databaseUrl.searchParams.get('schema') ?? 'public';
      if (
        !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
        database !== 'postgres' ||
        schema !== 'public' ||
        getSupabaseDatabaseProjectRefFromTarget(databaseUrl.hostname, databaseUrl.username) !==
          RELEASE_SUPABASE_PROJECT_REF
      ) {
        throw new Error();
      }
    } catch {
      throw new Error('DATABASE_URL 必须固定为同一生产 Supabase 项目的 postgres/public');
    }
    return { authProvider, password, serviceKey, supabaseUrl };
  }

  return { authProvider, password };
}
