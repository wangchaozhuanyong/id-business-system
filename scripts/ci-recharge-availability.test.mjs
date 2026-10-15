import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  rechargeAvailabilityControlPaths,
  isRechargeAvailabilityControlsOnly,
  isRechargeAvailabilityRepairOnly,
  isRechargeOnly,
  needsOnlineRechargeCiBuild,
  selectedParts
} from './ci-recharge-scope.mjs';
import {
  rechargeAvailabilityGuardChecks,
  rechargeAvailabilityCommonControlTests
} from './ci-recharge-scope.mjs';

const contract = JSON.parse(
  readFileSync('scripts/production-release/recharge-availability-contract.json', 'utf8')
);
const controls = [
  ...rechargeAvailabilityControlPaths,
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-check.mjs',
  'docs/AUTO_RECHARGE_PAYMENT_AVAILABILITY_20261015.md',
  'docs/V2_TASKS.md'
];
const paths = [...Object.keys(contract.sources), ...controls];
test('availability changes keep Admin, API and connector validation without unrelated ONLINE image build', () => {
  assert.equal(isRechargeAvailabilityRepairOnly(paths), true);
  assert.equal(isRechargeOnly(paths), true);
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  for (const part of ['guards', 'admin', 'api', 'connector'])
    assert.ok(selectedParts(paths).includes(part));
});
test('publication controls alone do not repeat application checks', () => {
  assert.equal(isRechargeAvailabilityControlsOnly(controls), true);
  assert.equal(isRechargeAvailabilityControlsOnly(paths), false);
  assert.equal(isRechargeAvailabilityControlsOnly([]), false);
  assert.equal(needsOnlineRechargeCiBuild(controls), false);
});
test('finite availability still runs every mandatory UI and backend architecture rule', () => {
  const checks = rechargeAvailabilityGuardChecks(paths);
  for (const name of [
    'check:admin-ui',
    'check:v2-ui-language',
    'check:v2-color-contrast',
    'check:v2-table-standard',
    'check:v2-loading-standard',
    'check:v2-module-architecture',
    'check:v2-isolation',
    'check:v2-decimal-standard',
    'check:v2-prisma-runtime-boundary',
    'check:v2-concurrency-standard'
  ])
    assert.ok(checks.includes(name));
  assert.equal(rechargeAvailabilityGuardChecks(controls), undefined);
  assert.equal(rechargeAvailabilityGuardChecks([...paths, 'apps/api/Dockerfile.mysql']), undefined);
  const program = readFileSync('scripts/ci-recharge-check.mjs', 'utf8');
  assert.ok(
    program.indexOf('const checks = rechargeAvailabilityGuardChecks(changed)') >
      program.indexOf("'scripts/ci-recharge-scope.test.mjs'")
  );
  assert.ok(
    program.indexOf('const checks = rechargeAvailabilityGuardChecks(changed)') <
      program.indexOf('const readonlyQualityMetadataOnly')
  );
});
test('only the closed availability scope narrows unrelated historical selector suites', () => {
  const wanted = [
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-check.test.mjs',
    'scripts/ci-change-scope.test.mjs'
  ];
  assert.deepEqual(rechargeAvailabilityCommonControlTests(paths), wanted);
  assert.deepEqual(rechargeAvailabilityCommonControlTests(controls), wanted);
  assert.equal(
    rechargeAvailabilityCommonControlTests([
      ...paths,
      'scripts/production-release/remote-deploy.py'
    ]),
    undefined
  );
  assert.equal(rechargeAvailabilityCommonControlTests([]), undefined);
});
for (const extra of [
  'apps/api/src/id-business-v2/online-recharge/worker.service.ts',
  'package-lock.json',
  'apps/api/Dockerfile.mysql',
  '.github/workflows/production-release.yml'
]) {
  test('unrelated ' + extra + ' cannot enter the finite availability exception', () => {
    assert.equal(isRechargeAvailabilityRepairOnly([...paths, extra]), false);
    assert.equal(isRechargeAvailabilityControlsOnly([...controls, extra]), false);
    assert.equal(needsOnlineRechargeCiBuild([...paths, extra]), true);
  });
}
