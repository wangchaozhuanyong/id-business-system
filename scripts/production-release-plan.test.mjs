import assert from 'node:assert/strict';
import test from 'node:test';

import { createProductionReleasePlan } from './production-release-plan.mjs';

test('legacy production manifests force a one-time full image bootstrap', () => {
  const plan = createProductionReleasePlan(['docs/DEPLOYMENT.md'], { baseSchemaVersion: 1 });
  assert.equal(plan.bootstrap, true);
  assert.deepEqual(plan.changedImages, [
    'api',
    'admin',
    'migration',
    'mediaResolver',
    'recharge',
    'gate'
  ]);
  assert.equal(plan.backupPolicy, 'recent');
});

test('admin-only changes reuse server and worker images', () => {
  const plan = createProductionReleasePlan(
    ['apps/admin/src/v2/features/customers/V2CustomersView.vue'],
    { baseSchemaVersion: 2 }
  );
  assert.deepEqual(plan.changedImages, ['admin']);
  assert.equal(plan.dataRisk, 'none');
  assert.equal(plan.backupPolicy, 'recent');
  assert.deepEqual(plan.acceptanceScopes, ['admin', 'base']);
});

test('auto recharge changes rebuild only affected runtime images and require a fresh backup', () => {
  const plan = createProductionReleasePlan(
    [
      'apps/api/src/id-business-v2/auto-recharge/recharge.service.ts',
      'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py'
    ],
    { baseSchemaVersion: 2 }
  );
  assert.deepEqual(plan.changedImages, ['api', 'recharge', 'gate']);
  assert.equal(plan.dataRisk, 'write-path');
  assert.equal(plan.backupPolicy, 'fresh');
  assert.equal(plan.migrationRequired, false);
  assert.ok(plan.acceptanceScopes.includes('auto-recharge'));
});

test('schema changes rebuild migration and retain database gates', () => {
  const plan = createProductionReleasePlan(
    ['apps/api/prisma-mysql/migrations/20260908010000_example/migration.sql'],
    { baseSchemaVersion: 2 }
  );
  assert.deepEqual(plan.changedImages, ['api', 'migration', 'gate']);
  assert.equal(plan.dataRisk, 'schema');
  assert.equal(plan.backupPolicy, 'fresh');
  assert.equal(plan.migrationRequired, true);
  assert.ok(plan.acceptanceScopes.includes('database'));
});

test('dependency boundary changes rebuild every immutable image', () => {
  const plan = createProductionReleasePlan(['package-lock.json'], { baseSchemaVersion: 2 });
  assert.deepEqual(plan.changedImages, [
    'api',
    'admin',
    'migration',
    'mediaResolver',
    'recharge',
    'gate'
  ]);
});

test('API Dockerfile rebuilds the runtime, migration and gate images', () => {
  const plan = createProductionReleasePlan(['apps/api/Dockerfile.mysql'], {
    baseSchemaVersion: 2
  });
  assert.deepEqual(plan.changedImages, ['api', 'migration', 'gate']);
});

test('Compose-only changes restart the runtime stack without rebuilding images', () => {
  const plan = createProductionReleasePlan(['docker-compose.aws-mysql.yml'], {
    baseSchemaVersion: 2
  });
  assert.deepEqual(plan.changedImages, []);
  assert.ok(plan.acceptanceScopes.includes('runtime-config'));
  assert.equal(plan.backupPolicy, 'recent');
});
