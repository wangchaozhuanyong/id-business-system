import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  rechargePlanBillingPublicationControls,
  isRechargePlanBillingPublicationOnly,
  rechargePlanBillingSourcePaths,
  isRechargePlanBillingSource
} from './ci-recharge-plan-billing-scope.mjs';
import {
  isCiOnly,
  selectedParts,
  checkMode,
  needsOnlineRechargeCiBuild
} from './ci-recharge-scope.mjs';

test('only exact billing publication controls use the control checks', () => {
  const controls = [...rechargePlanBillingPublicationControls];
  assert.equal(isRechargePlanBillingPublicationOnly(controls), true);
  assert.equal(isCiOnly(controls), true);
  assert.deepEqual(selectedParts(controls), ['guards']);
  for (const path of [
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/src/id-business-v2/auto-recharge/recharge-local.service.ts',
    'apps/admin/src/v2/features/auto-recharge/useAutoRecharge.ts',
    'package-lock.json',
    'scripts/production-release/remote-deploy.py',
    '.github/workflows/quality.yml'
  ]) {
    assert.equal(isRechargePlanBillingPublicationOnly([...controls, path]), false, path);
  }
  assert.equal(isRechargePlanBillingPublicationOnly([]), false);
  assert.equal(isRechargePlanBillingPublicationOnly(['scripts/ci-recharge-check.mjs']), false);
});

test('billing schema and exact source hashes keep API Admin and real migration checks', () => {
  const paths = [...rechargePlanBillingSourcePaths];
  const before = execFileSync(
    'git',
    ['show', 'e317136851edfe3b49c0c44a8deed01b7de62a53:apps/api/prisma-mysql/schema.prisma'],
    { encoding: 'utf8' }
  );
  const after = readFileSync(
    new URL('../apps/api/prisma-mysql/schema.prisma', import.meta.url),
    'utf8'
  );
  assert.equal(isRechargePlanBillingSource(paths, before, after), true);
  assert.equal(checkMode(paths, before, after), 'recharge');
  assert.deepEqual(selectedParts(paths), ['guards', 'admin', 'api', 'migration']);
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  assert.equal(isRechargePlanBillingSource(paths, before + '\nmodel Unreviewed {}', after), false);
  assert.equal(isRechargePlanBillingSource(paths, before, after + '\nmodel Unreviewed {}'), false);
  for (const extra of [
    'apps/api/src/auth/auth.service.ts',
    'package-lock.json',
    'scripts/production-release/remote-deploy.py'
  ])
    assert.equal(isRechargePlanBillingSource([...paths, extra], before, after), false, extra);
});
