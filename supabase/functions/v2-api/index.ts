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

function resolveEdgeDatabaseUrl() {
  const rawConnectionString = requireEnv('V2_RUNTIME_DATABASE_URL');
  const connectionUrl = new URL(rawConnectionString);
  const projectUrl = new URL(requireEnv('SUPABASE_URL'));
  const projectRef = projectUrl.hostname.split('.', 1)[0];
  const directHost = `db.${projectRef}.supabase.co`;
  const isSupabaseDirect = connectionUrl.hostname === directHost;
  const isSupabasePooler = connectionUrl.hostname.endsWith('.pooler.supabase.com');

  if (!isSupabaseDirect && !isSupabasePooler) {
    throw new Error('V2_RUNTIME_DATABASE_URL must target the current Supabase project');
  }
  if (
    connectionUrl.hostname === directHost &&
    connectionUrl.username !== 'id_business_v2_runtime'
  ) {
    throw new Error('V2_RUNTIME_DATABASE_URL must use id_business_v2_runtime');
  }
  if (isSupabasePooler && connectionUrl.username !== `id_business_v2_runtime.${projectRef}`) {
    throw new Error('V2_RUNTIME_DATABASE_URL must use the scoped runtime pooler role');
  }
  return connectionUrl.toString();
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
  ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED: 'true',
  ID_BUSINESS_V2_EXCHANGE_RATE_RUN_ON_STARTUP: 'false',
  ID_BUSINESS_V2_FREE_MANUAL_MODE: 'false',
  ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET: requireEnv('ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET')
});

const server = await createCloudflareV2HttpServer(`${__V2_FUNCTION_NAME__}/api`);
const port = Number(Deno.env.get('PORT') ?? 9999);

server.listen(port, '0.0.0.0');
