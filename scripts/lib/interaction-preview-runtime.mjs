import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { build } from 'esbuild';
import { PREVIEW_BRANCH, PREVIEW_BASE } from './interaction-preview-evidence.mjs';

export { PREVIEW_BRANCH, PREVIEW_BASE };
export const PREVIEW_API_READY_PATH = '/api/health/ready';
export async function waitForPreviewService(
  url,
  {
    request = fetch,
    isRunning = () => true,
    pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    attempts = 120
  } = {}
) {
  const target = new URL(url);
  assert.equal(target.hostname, '127.0.0.1');
  assert.ok(target.pathname === PREVIEW_API_READY_PATH || target.pathname === '/login');
  for (let attempt = 0; attempt < attempts; attempt++) {
    assert.ok(isRunning(), 'A preview process exited before readiness');
    const response = await request(url, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (response && [401, 403, 404].includes(response.status))
      throw new Error(`Preview readiness endpoint returned ${response.status}`);
    if (response?.ok) {
      if (target.pathname === '/login') return;
      const body = await response.json();
      const status = body.data ?? body;
      if (status.status === 'ready' && status.database === 'ok') return;
    }
    await pause(500);
  }
  throw new Error('Preview did not become ready');
}
export function assertPreviewExecutionContext(env, project) {
  assert.equal(
    env.GITHUB_ACTIONS,
    'true',
    'Only the authorized disposable runner may start services'
  );
  assert.equal(env.GITHUB_REPOSITORY, 'wangchaozhuanyong/id-business-system');
  assert.equal(env.GITHUB_REF, PREVIEW_BRANCH);
  assert.equal(realpathSync(env.GITHUB_WORKSPACE), realpathSync(project));
  for (const key of [
    'DATABASE_URL',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'DOCKER_HOST',
    'DOCKER_CONTEXT'
  ])
    assert.ok(!env[key], `Unexpected external runtime configuration: ${key}`);
}
export function isolatedPreviewEnvironment(env) {
  const safe = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'])
    if (env[key]) safe[key] = env[key];
  return {
    ...safe,
    NODE_ENV: 'test',
    AUTH_PROVIDER: 'local',
    APP_PORT: '5300',
    CORS_ORIGIN: 'http://127.0.0.1:5374,http://127.0.0.1:5375',
    JWT_SECRET: randomBytes(32).toString('hex'),
    FIELD_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    HASH_SECRET: randomBytes(32).toString('hex'),
    SEED_ADMIN_USERNAME: 'interaction-preview',
    SEED_ADMIN_PASSWORD: randomBytes(32).toString('base64url'),
    ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED: 'false',
    ID_BUSINESS_V2_EXCHANGE_RATE_RUN_ON_STARTUP: 'false',
    VITE_DEV_API_PROXY_TARGET: 'http://127.0.0.1:5300'
  };
}
export function redactPreviewOutput(text, secrets = []) {
  let result = String(text);
  for (const secret of secrets) if (secret) result = result.replaceAll(secret, '[REDACTED]');
  return result
    .replace(
      /(\b(?:password(?:Hash)?|accessToken|refreshToken|apiKey|token|secret)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/gi,
      '$1[REDACTED]'
    )
    .replace(/mysql:\/\/[^\s'"<>]+/g, '[DATABASE_URL]')
    .replace(/Bearer\s+[^\s'"<>]+/gi, 'Bearer [REDACTED]');
}
export function previewServerTimings(header) {
  return String(header ?? '')
    .split(',')
    .flatMap((part) => {
      const match =
        /^\s*(db|database|app|api|total|cache|render)\s*;\s*dur=(\d+(?:\.\d+)?)(?:;|\s*$)/i.exec(
          part
        );
      return match ? [{ metric: match[1].toLowerCase(), duration: Number(match[2]) }] : [];
    });
}
export async function listPreviewRoutes(project) {
  const result = await build({
    entryPoints: [path.join(project, 'apps/admin/src/v2/features/registry.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    alias: { '@': path.join(project, 'apps/admin/src') },
    plugins: [
      {
        name: 'metadata-only',
        setup(builder) {
          builder.onResolve({ filter: /\.vue$|tableSchemas/ }, (args) => ({
            path: args.path,
            external: true
          }));
        }
      }
    ]
  });
  const registry = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  );
  return registry.v2ModuleDefinitions.map((module) => module.route);
}
// Only called after the caller creates its new owned database and applies existing migrations.
export async function seedPreviewRows(project, env, owned) {
  const url = new URL(env.DATABASE_URL);
  assert.equal(url.protocol, 'mysql:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, String(owned.port));
  assert.equal(url.pathname, `/${owned.database}`);
  assert.equal(url.password, owned.rootPassword);
  const require = createRequire(path.join(project, 'package.json'));
  const { PrismaClient } = require('@prisma/client');
  const { FieldEncryptionService } = require(
    path.join(project, 'apps/api/dist/common/crypto/field-encryption.service.js')
  );
  const crypto = new FieldEncryptionService({ get: (key) => env[key] });
  const db = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
  try {
    const user = await db.user.findUniqueOrThrow({ where: { username: env.SEED_ADMIN_USERNAME } });
    await db.securitySetting.upsert({
      where: { key: 'v2_system_super_admin' },
      update: {},
      create: { key: 'v2_system_super_admin', value: { userId: user.id } }
    });
    const option = (type, code, extra = {}) =>
      db.idBusinessV2Option.create({
        data: { type, code, name: `合成${code}`, uniqueKey: `${type}:preview:${code}`, ...extra }
      });
    const country = await option('country', 'country', { currencyCode: 'USD' });
    const category = await option('business_category', 'category');
    const service = await option('service', 'service', {
      parentId: category.id,
      countryOptionId: country.id,
      businessAmount: '0'
    });
    const status = await option('id_status', 'normal', { isSystem: true });
    const platform = await option('settlement_platform', 'platform');
    for (let index = 1; index <= 45; index++) {
      const customer = await db.idBusinessV2Customer.create({
        data: { name: `合成客户${index}`, createdByUserId: user.id }
      });
      const email = `synthetic-${index}@example.invalid`;
      const account = await db.idBusinessV2Account.create({
        data: {
          appleIdEncrypted: crypto.encrypt(email),
          appleIdHash: crypto.hash(email),
          appleIdMasked: email,
          countryOptionId: country.id,
          statusOptionId: status.id,
          createdByUserId: user.id
        }
      });
      await db.idBusinessV2Order.create({
        data: {
          orderNo: `PREVIEW-${index}`,
          idempotencyKey: `preview:${index}`,
          customerId: customer.id,
          serviceOptionId: service.id,
          accountId: account.id,
          settlementPlatformOptionId: platform.id,
          status: 'draft',
          createdByUserId: user.id
        }
      });
    }
    return { customers: 45, accounts: 45, orders: 45, externalResources: 0 };
  } finally {
    await db.$disconnect();
  }
}
