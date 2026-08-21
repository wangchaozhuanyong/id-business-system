#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const envPath = path.resolve(process.cwd(), process.env.PROD_ENV_FILE || '.env.production');
if (!existsSync(envPath)) {
  console.error(`Production env file is missing: ${envPath}`);
  process.exit(1);
}

const values = new Map();
for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#') || !line.includes('=')) continue;
  const separator = line.indexOf('=');
  values.set(line.slice(0, separator).trim(), unquote(line.slice(separator + 1).trim()));
}

const errors = [];
const unsafe =
  /(change_me|replace_with|placeholder|your[-_]?domain|example\.(com|net|org)|localhost|127\.0\.0\.1|0\.0\.0\.0|\.test(?::|\/|$)|\.invalid(?::|\/|$))/i;

requireExact('NODE_ENV', 'production');
requirePort('APP_PORT');
requirePostgres('DATABASE_URL');
requireHttpsList('CORS_ORIGIN');
requireHttps('APP_PUBLIC_URL');
requireEnum('AUTH_PROVIDER', ['local', 'supabase']);
requireSecret('FIELD_ENCRYPTION_KEY');
requireSecret('HASH_SECRET');
if (values.get('SUPABASE_EDGE_FUNCTION') === 'true') {
  requireSecret('V2_TRUSTED_PROXY_SECRET');
}

if (values.get('AUTH_PROVIDER') === 'local') {
  requireSecret('JWT_SECRET');
}

if (values.get('AUTH_PROVIDER') === 'supabase') {
  requireHttps('SUPABASE_URL');
  requireAny(['SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY']);
  requireAny(['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY']);
}

requireBoolean('ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED');
requireBoolean('ID_BUSINESS_V2_EXCHANGE_RATE_RUN_ON_STARTUP');
requireBoolean('ID_BUSINESS_V2_FREE_MANUAL_MODE');
requireInteger('ID_BUSINESS_V2_EXCHANGE_RATE_STALE_MS', 60000, 3600000);
requireEnum('CURRENCY_RATE_PROVIDER', ['currencyapi']);
requireSecret('CURRENCY_API_KEY');
requireInteger('CURRENCY_RATE_REQUEST_TIMEOUT_MS', 1000, 30000);

if (
  values.get('SUPABASE_EDGE_FUNCTION') === 'true' &&
  values.get('ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED') !== 'false'
) {
  requireSecret('ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET');
}

if (errors.length) {
  console.error(`Production env validation failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Production env is valid: ${envPath}`);

function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function valueOf(name) {
  return values.get(name)?.trim() || '';
}

function requireExact(name, expected) {
  if (valueOf(name) !== expected) errors.push(`${name} must be ${expected}`);
}

function requirePort(name) {
  requireInteger(name, 1, 65535);
}

function requireInteger(name, minimum, maximum) {
  const parsed = Number(valueOf(name));
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    errors.push(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function requirePostgres(name) {
  const value = valueOf(name);
  if (!value.startsWith('postgresql://') || unsafe.test(value)) {
    errors.push(`${name} must be a production PostgreSQL URL`);
  }
}

function requireHttps(name) {
  const value = valueOf(name);
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || unsafe.test(value)) throw new Error();
  } catch {
    errors.push(`${name} must be a production HTTPS URL`);
  }
}

function requireHttpsList(name) {
  const values = valueOf(name)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!values.length) {
    errors.push(`${name} is required`);
    return;
  }
  for (const value of values) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || unsafe.test(value)) throw new Error();
    } catch {
      errors.push(`${name} contains an invalid production HTTPS origin`);
      return;
    }
  }
}

function requireEnum(name, allowed) {
  if (!allowed.includes(valueOf(name))) errors.push(`${name} must be one of ${allowed.join(', ')}`);
}

function requireBoolean(name) {
  if (!['true', 'false'].includes(valueOf(name))) errors.push(`${name} must be true or false`);
}

function requireSecret(name) {
  const value = valueOf(name);
  if (value.length < 32 || unsafe.test(value)) {
    errors.push(`${name} must contain at least 32 non-placeholder characters`);
  }
}

function requireAny(names) {
  if (!names.some((name) => valueOf(name))) errors.push(`${names.join(' or ')} is required`);
}
