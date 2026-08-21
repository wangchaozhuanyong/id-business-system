import 'reflect-metadata';
import process from 'node:process';
import { createCloudflareV2HttpServer } from '@v2-bootstrap';

declare const __V2_FUNCTION_NAME__: string;

type AuthProvider = 'local' | 'supabase';

const defaultAdminPublicUrl = 'https://daichongxitong-v2-free-20260727.ppfzj1314.workers.dev';

const requiredSecrets = [
  'FIELD_ENCRYPTION_KEY',
  'HASH_SECRET',
  'ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET',
  'V2_TRUSTED_PROXY_SECRET'
] as const;

function requireEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function firstEnv(...names: string[]) {
  for (const name of names) {
    const value = Deno.env.get(name)?.trim();
    if (value) return value;
  }
  throw new Error(`${names.join(' or ')} is required`);
}

function resolveAuthProvider(): AuthProvider {
  const value = Deno.env.get('AUTH_PROVIDER')?.trim() || 'local';
  if (value !== 'local' && value !== 'supabase') {
    throw new Error('AUTH_PROVIDER must be local or supabase');
  }
  return value;
}

function resolveCurrencyRateProvider() {
  const value = Deno.env.get('CURRENCY_RATE_PROVIDER')?.trim().toLowerCase() || 'exchange_rate_api';
  if (value !== 'exchange_rate_api') {
    throw new Error('CURRENCY_RATE_PROVIDER must be exchange_rate_api');
  }
  return value;
}

function resolveCurrencyRateRequestTimeoutMs() {
  const rawValue = Deno.env.get('CURRENCY_RATE_REQUEST_TIMEOUT_MS')?.trim() || '10000';
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 1000 || value > 30000) {
    throw new Error('CURRENCY_RATE_REQUEST_TIMEOUT_MS must be an integer between 1000 and 30000');
  }
  return String(value);
}

function resolveEdgeDatabaseUrl() {
  const rawConnectionString = requireEnv('V2_RUNTIME_DATABASE_URL');
  const connectionUrl = new URL(rawConnectionString);
  const projectRef = getSupabaseProjectRef();
  const directHost = projectRef ? `db.${projectRef}.supabase.co` : '';
  const isSupabaseDirect = Boolean(directHost) && connectionUrl.hostname === directHost;
  const isSupabasePooler = connectionUrl.hostname.endsWith('.pooler.supabase.com');

  if (!isSupabaseDirect && !isSupabasePooler) {
    throw new Error('V2_RUNTIME_DATABASE_URL must target the current Supabase project');
  }
  if (isSupabaseDirect && connectionUrl.username !== 'id_business_v2_runtime') {
    throw new Error('V2_RUNTIME_DATABASE_URL must use id_business_v2_runtime');
  }
  if (isSupabasePooler) {
    const poolerPrefix = 'id_business_v2_runtime.';
    if (
      !connectionUrl.username.startsWith(poolerPrefix) ||
      connectionUrl.username.length <= poolerPrefix.length
    ) {
      throw new Error('V2_RUNTIME_DATABASE_URL must use the scoped runtime pooler role');
    }
    const scopedProjectRef = connectionUrl.username.slice(poolerPrefix.length);
    if (projectRef && scopedProjectRef !== projectRef) {
      throw new Error('V2_RUNTIME_DATABASE_URL must target the current Supabase project');
    }
  }
  return connectionUrl.toString();
}

function getSupabaseProjectRef() {
  try {
    const projectUrl = new URL(requireEnv('SUPABASE_URL'));
    if (!projectUrl.hostname.endsWith('.supabase.co')) {
      return '';
    }
    return projectUrl.hostname.split('.', 1)[0];
  } catch {
    return '';
  }
}

for (const name of requiredSecrets) {
  requireEnv(name);
}

const authProvider = resolveAuthProvider();
const appPublicUrl = Deno.env.get('APP_PUBLIC_URL')?.trim() || defaultAdminPublicUrl;

Object.assign(process.env, {
  NODE_ENV: 'production',
  APP_PORT: '9999',
  APP_PUBLIC_URL: appPublicUrl,
  CORS_ORIGIN: Deno.env.get('CORS_ORIGIN')?.trim() || appPublicUrl,
  DATABASE_URL: resolveEdgeDatabaseUrl(),
  JWT_SECRET:
    authProvider === 'local'
      ? requireEnv('JWT_SECRET')
      : 'supabase-auth-provider-local-jwt-disabled',
  AUTH_PROVIDER: authProvider,
  SUPABASE_EDGE_FUNCTION: 'true',
  SUPABASE_URL: requireEnv('SUPABASE_URL'),
  SUPABASE_ANON_KEY: firstEnv('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY'),
  SUPABASE_SERVICE_ROLE_KEY: firstEnv('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'),
  V2_TRUSTED_PROXY_SECRET: requireEnv('V2_TRUSTED_PROXY_SECRET'),
  CURRENCY_RATE_PROVIDER: resolveCurrencyRateProvider(),
  CURRENCY_RATE_REQUEST_TIMEOUT_MS: resolveCurrencyRateRequestTimeoutMs(),
  ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED: 'true',
  ID_BUSINESS_V2_EXCHANGE_RATE_RUN_ON_STARTUP: 'false',
  ID_BUSINESS_V2_FREE_MANUAL_MODE: 'false',
  ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET: requireEnv('ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET')
});

const server = await createCloudflareV2HttpServer(`${__V2_FUNCTION_NAME__}/api`);
const port = Number(Deno.env.get('PORT') ?? 9999);

server.listen(port, '0.0.0.0');
