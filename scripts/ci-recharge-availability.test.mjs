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
