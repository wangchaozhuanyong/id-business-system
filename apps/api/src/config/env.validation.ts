type RuntimeEnv = 'development' | 'test' | 'production';
type AuthProvider = 'local' | 'supabase';

export interface RawEnv {
  NODE_ENV?: string;
  APP_PORT?: string;
  APP_PUBLIC_URL?: string;
  CORS_ORIGIN?: string;
  DATABASE_URL?: string;
  V2_RUNTIME_DATABASE_URL?: string;
  JWT_SECRET?: string;
  JWT_EXPIRES_IN?: string;
  FIELD_ENCRYPTION_KEY?: string;
  HASH_SECRET?: string;
  AUTH_PROVIDER?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_EDGE_FUNCTION?: string;
  V2_TRUSTED_PROXY_SECRET?: string;
  ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED?: string;
  ID_BUSINESS_V2_EXCHANGE_RATE_RUN_ON_STARTUP?: string;
  ID_BUSINESS_V2_FREE_MANUAL_MODE?: string;
  ID_BUSINESS_V2_EXCHANGE_RATE_STALE_MS?: string;
  ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET?: string;
  [key: string]: unknown;
}

const PRODUCTION_UNSAFE_VALUE =
  /(change_me|replace_with|placeholder|your[-_]?domain|example\.(com|net|org)|localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1|\.test(?::|\/|$)|\.invalid(?::|\/|$))/i;

const BLOCKED_RUNTIME_TARGETS = [
  /uperydhdwgzvakyskask/i,
  /damatong\.net/i,
  /13\.214\.152\.29/
] as const;

export function validateEnv(config: RawEnv) {
  assertNoRemovedRuntimeTarget(config);

  const nodeEnv = parseNodeEnv(config.NODE_ENV);
  const appPort = parseInteger('APP_PORT', config.APP_PORT ?? '3000', 1, 65535);
  const authProvider = parseAuthProvider(config.AUTH_PROVIDER);
  const autoCollect = parseBoolean(
    'ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED',
    config.ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED,
    true
  );
  const runOnStartup = parseBoolean(
    'ID_BUSINESS_V2_EXCHANGE_RATE_RUN_ON_STARTUP',
    config.ID_BUSINESS_V2_EXCHANGE_RATE_RUN_ON_STARTUP,
    false
  );
  const freeManualMode = parseBoolean(
    'ID_BUSINESS_V2_FREE_MANUAL_MODE',
    config.ID_BUSINESS_V2_FREE_MANUAL_MODE,
    false
  );
  const staleMs = parseInteger(
    'ID_BUSINESS_V2_EXCHANGE_RATE_STALE_MS',
    config.ID_BUSINESS_V2_EXCHANGE_RATE_STALE_MS ?? '600000',
    60000,
    3600000
  );

  validateUrls(config, nodeEnv);
  validateDatabase(config, nodeEnv);
  validateSecrets(config, nodeEnv, authProvider);
  parseOptionalBoolean('SUPABASE_EDGE_FUNCTION', config.SUPABASE_EDGE_FUNCTION);

  if (authProvider === 'supabase') {
    requireUrl('SUPABASE_URL', config.SUPABASE_URL);
    requireOneOf(config, ['SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY']);
    requireOneOf(config, ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY']);
  }

  if (
    nodeEnv === 'production' &&
    config.SUPABASE_EDGE_FUNCTION === 'true' &&
    autoCollect &&
    !isStrongSecret(config.ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET)
  ) {
    throw new Error('ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET must contain at least 32 characters');
  }

  return {
    ...config,
    NODE_ENV: nodeEnv,
    APP_PORT: String(appPort),
    AUTH_PROVIDER: authProvider,
    ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED: String(autoCollect),
    ID_BUSINESS_V2_EXCHANGE_RATE_RUN_ON_STARTUP: String(runOnStartup),
    ID_BUSINESS_V2_FREE_MANUAL_MODE: String(freeManualMode),
    ID_BUSINESS_V2_EXCHANGE_RATE_STALE_MS: String(staleMs)
  };
}

function parseNodeEnv(value: string | undefined): RuntimeEnv {
  const checked = value ?? 'development';
  if (checked !== 'development' && checked !== 'test' && checked !== 'production') {
    throw new Error('NODE_ENV must be one of development, test, production');
  }
  return checked;
}

function parseAuthProvider(value: string | undefined): AuthProvider {
  const checked = value ?? 'local';
  if (checked !== 'local' && checked !== 'supabase') {
    throw new Error('AUTH_PROVIDER must be local or supabase');
  }
  return checked;
}

function parseBoolean(name: string, value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue;
  if (value !== 'true' && value !== 'false') {
    throw new Error(`${name} must be true or false`);
  }
  return value === 'true';
}

function parseOptionalBoolean(name: string, value: string | undefined) {
  if (value !== undefined && value !== '') parseBoolean(name, value, false);
}

function parseInteger(name: string, value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function validateUrls(config: RawEnv, nodeEnv: RuntimeEnv) {
  if (config.APP_PUBLIC_URL) validatePublicUrl('APP_PUBLIC_URL', config.APP_PUBLIC_URL, nodeEnv);

  if (config.CORS_ORIGIN) {
    for (const origin of config.CORS_ORIGIN.split(',').map((item) => item.trim())) {
      if (origin) validatePublicUrl('CORS_ORIGIN', origin, nodeEnv);
    }
  } else if (nodeEnv === 'production') {
    throw new Error('CORS_ORIGIN is required in production');
  }
}

function validatePublicUrl(name: string, value: string, nodeEnv: RuntimeEnv) {
  const url = requireUrl(name, value);
  if (nodeEnv === 'production' && url.protocol !== 'https:') {
    throw new Error(`${name} must use https:// in production`);
  }
  if (nodeEnv === 'production' && PRODUCTION_UNSAFE_VALUE.test(value)) {
    throw new Error(`${name} must be configured with a production-safe value`);
  }
}

function validateDatabase(config: RawEnv, nodeEnv: RuntimeEnv) {
  if (!config.DATABASE_URL) {
    if (config.SUPABASE_EDGE_FUNCTION === 'true' && config.V2_RUNTIME_DATABASE_URL) {
      return;
    }
    if (nodeEnv === 'production') throw new Error('DATABASE_URL is required in production');
    return;
  }
  if (!config.DATABASE_URL.startsWith('postgresql://')) {
    throw new Error('DATABASE_URL must use postgresql://');
  }
}

function validateSecrets(config: RawEnv, nodeEnv: RuntimeEnv, authProvider: AuthProvider) {
  if (nodeEnv !== 'production') return;

  for (const name of ['FIELD_ENCRYPTION_KEY', 'HASH_SECRET'] as const) {
    if (!isStrongSecret(config[name])) {
      throw new Error(`${name} must contain at least 32 non-placeholder characters`);
    }
  }

  if (authProvider === 'local' && !isStrongSecret(config.JWT_SECRET)) {
    throw new Error('JWT_SECRET must contain at least 32 non-placeholder characters');
  }
  if (config.SUPABASE_EDGE_FUNCTION === 'true' && !isStrongSecret(config.V2_TRUSTED_PROXY_SECRET)) {
    throw new Error('V2_TRUSTED_PROXY_SECRET must contain at least 32 non-placeholder characters');
  }
}

function isStrongSecret(value: string | undefined) {
  return Boolean(value && value.trim().length >= 32 && !PRODUCTION_UNSAFE_VALUE.test(value));
}

function requireUrl(name: string, value: string | undefined) {
  if (!value) throw new Error(`${name} is required`);
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

function requireOneOf(config: RawEnv, names: string[]) {
  if (names.some((name) => typeof config[name] === 'string' && config[name]!.trim())) return;
  throw new Error(`${names.join(' or ')} is required`);
}

function assertNoRemovedRuntimeTarget(config: RawEnv) {
  for (const [key, rawValue] of Object.entries(config)) {
    if (typeof rawValue !== 'string' || !rawValue.trim()) continue;
    if (BLOCKED_RUNTIME_TARGETS.some((pattern) => pattern.test(rawValue))) {
      throw new Error(`环境变量 ${key} 指向已删除的系统`);
    }
  }
}
