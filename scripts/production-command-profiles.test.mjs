import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProductionCommandEnvironment,
  resolveProductionCommand
} from './lib/production-command-profiles.mjs';

const secrets = {
  AUDIT_DATABASE_URL: 'postgresql://audit:secret@db.example.com/postgres',
  V2_RUNTIME_DATABASE_URL: 'postgresql://runtime:secret@db.example.com/postgres',
  MIGRATION_DATABASE_URL: 'postgresql://admin:secret@db.example.com/postgres',
  JWT_SECRET: 'jwt-secret',
  FIELD_ENCRYPTION_KEY: 'field-key',
  HASH_SECRET: 'hash-secret',
  V2_TRUSTED_PROXY_SECRET: 'trusted-proxy-secret',
  CURRENCY_API_KEY: 'currency-api-key',
  SMOKE_TEST_USERNAME: 'smoke-user',
  SMOKE_TEST_PASSWORD: 'smoke-password'
};

test('rejects arbitrary commands and node evaluation', () => {
  assert.throws(() => resolveProductionCommand('node'), /未知生产操作/);
  assert.throws(() => resolveProductionCommand('node -e'), /未知生产操作/);
  assert.throws(() => resolveProductionCommand('--'), /未知生产操作/);
});

test('closure audit receives only the read-only database credential', () => {
  const profile = resolveProductionCommand('closure-audit');
  const environment = buildProductionCommandEnvironment(
    {
      DATABASE_URL: secrets.MIGRATION_DATABASE_URL,
      DIRECT_URL: secrets.MIGRATION_DATABASE_URL,
      MIGRATION_DATABASE_URL: secrets.MIGRATION_DATABASE_URL,
      PATH: '/usr/bin'
    },
    secrets,
    profile
  );

  assert.equal(environment.DATABASE_URL, secrets.AUDIT_DATABASE_URL);
  assert.equal(environment.PATH, '/usr/bin');
  assert.equal(environment.DIRECT_URL, undefined);
  assert.equal(environment.MIGRATION_DATABASE_URL, undefined);
  assert.equal(environment.V2_RUNTIME_DATABASE_URL, undefined);
});

test('integrity audit receives only the read-only database credential', () => {
  const profile = resolveProductionCommand('integrity-audit');
  const environment = buildProductionCommandEnvironment(
    { MIGRATION_DATABASE_URL: secrets.MIGRATION_DATABASE_URL },
    secrets,
    profile
  );

  assert.deepEqual(profile.args, ['scripts/v2-data-integrity-audit.mjs']);
  assert.equal(environment.DATABASE_URL, secrets.AUDIT_DATABASE_URL);
  assert.equal(environment.MIGRATION_DATABASE_URL, undefined);
  assert.equal(environment.V2_RUNTIME_DATABASE_URL, undefined);
});

test('deploy receives runtime credential but never migration or audit credentials', () => {
  const profile = resolveProductionCommand('deploy');
  const environment = buildProductionCommandEnvironment({}, secrets, profile);

  assert.equal(environment.DATABASE_URL, secrets.V2_RUNTIME_DATABASE_URL);
  assert.equal(environment.V2_RUNTIME_DATABASE_URL, secrets.V2_RUNTIME_DATABASE_URL);
  assert.equal(environment.AUDIT_DATABASE_URL, undefined);
  assert.equal(environment.MIGRATION_DATABASE_URL, undefined);
  assert.equal(environment.JWT_SECRET, secrets.JWT_SECRET);
  assert.equal(environment.V2_TRUSTED_PROXY_SECRET, secrets.V2_TRUSTED_PROXY_SECRET);
  assert.equal(environment.CURRENCY_API_KEY, secrets.CURRENCY_API_KEY);
});

test('data maintenance receives migration credential only and allows explicit arguments', () => {
  const profile = resolveProductionCommand('data-maintenance');
  const environment = buildProductionCommandEnvironment({}, secrets, profile);

  assert.deepEqual(profile.args, ['scripts/production-data-maintenance.mjs']);
  assert.equal(profile.allowExtraArgs, true);
  assert.equal(environment.DATABASE_URL, secrets.MIGRATION_DATABASE_URL);
  assert.equal(environment.MIGRATION_DATABASE_URL, undefined);
  assert.equal(environment.V2_RUNTIME_DATABASE_URL, undefined);
  assert.equal(environment.AUDIT_DATABASE_URL, undefined);
});

test('sensitive search backfill receives only runtime access and encryption secrets', () => {
  const profile = resolveProductionCommand('sensitive-search-backfill');
  const environment = buildProductionCommandEnvironment({}, secrets, profile);

  assert.deepEqual(profile.args, ['run', 'backfill:v2-sensitive-search-indexes']);
  assert.equal(profile.allowExtraArgs, undefined);
  assert.equal(environment.DATABASE_URL, secrets.V2_RUNTIME_DATABASE_URL);
  assert.equal(environment.FIELD_ENCRYPTION_KEY, secrets.FIELD_ENCRYPTION_KEY);
  assert.equal(environment.HASH_SECRET, secrets.HASH_SECRET);
  assert.equal(environment.MIGRATION_DATABASE_URL, undefined);
  assert.equal(environment.AUDIT_DATABASE_URL, undefined);
  assert.equal(environment.JWT_SECRET, undefined);
});
