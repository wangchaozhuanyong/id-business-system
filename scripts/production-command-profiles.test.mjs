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
