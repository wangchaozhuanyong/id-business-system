import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  isRechargeOnly,
  isRechargeRecordRepairOnly,
  needsOnlineRechargeCiBuild,
  selectedParts
} from './ci-recharge-scope.mjs';

const contract = JSON.parse(
  readFileSync('scripts/production-release/recharge-record-contract.json', 'utf8')
);
const paths = [
  ...Object.keys(contract.changedSources),
  'scripts/production-release/recharge-record-contract.json',
  'scripts/production-release/recharge-record-build.py',
  'scripts/production-release/recharge-record-release.py',
  'scripts/production-release/recharge-record-release.test.py',
  'scripts/production-release/recharge-record-dispatch.py',
  '.github/workflows/recharge-record-validation.yml',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-record.test.mjs',
  'docs/V2_TASKS.md',
  'docs/AUTO_RECHARGE_RECORD_DIAGNOSTICS_20261015.md'
];

test('finite record repair retains application checks and avoids unrelated ONLINE rebuilds', () => {
  assert.equal(isRechargeRecordRepairOnly(paths), true);
  assert.equal(isRechargeOnly(paths), true);
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  for (const part of ['guards', 'admin', 'api', 'connector'])
    assert.ok(selectedParts(paths).includes(part));
});

for (const extra of [
  'apps/api/src/id-business-v2/online-recharge/worker.service.ts',
  'apps/api/Dockerfile.mysql',
  'package-lock.json',
  '.github/workflows/production-release.yml',
  'scripts/production-release/remote-deploy.py'
]) {
  test(`additional ${extra} retains its existing build selection`, () => {
    assert.equal(isRechargeRecordRepairOnly([...paths, extra]), false);
    assert.equal(needsOnlineRechargeCiBuild([...paths, extra]), true);
  });
}
