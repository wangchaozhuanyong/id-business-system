import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  isRechargeOnly,
  isRechargeRecordRepairOnly,
  isRechargeRecordControlsOnly,
  needsOnlineRechargeCiBuild,
  selectedParts
} from './ci-recharge-scope.mjs';

const contract = JSON.parse(
  readFileSync('scripts/production-release/recharge-record-contract.json', 'utf8')
);
const paths = [
  ...Object.keys(contract.changedSources),
  ...Object.keys(contract.validationOnlySources || {}),
  'scripts/production-release/recharge-record-contract.json',
  'scripts/production-release/recharge-record-build.py',
  'scripts/production-release/recharge-record-release.py',
  'scripts/production-release/recharge-record-release.test.py',
  'scripts/production-release/recharge-record-dispatch.py',
  'scripts/production-release/online-recharge-component-consumer.test.py',
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

const controlsOnly = [
  'scripts/production-release/recharge-record-contract.json',
  'scripts/production-release/recharge-record-build.py',
  'scripts/production-release/recharge-record-release.test.py',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-record.test.mjs',
  'docs/AUTO_RECHARGE_RECORD_DIAGNOSTICS_20261015.md'
];
test('finite control updates keep their own and common selector checks without repeating unrelated controls', () => {
  assert.equal(isRechargeRecordControlsOnly(controlsOnly), true);
  assert.equal(needsOnlineRechargeCiBuild(controlsOnly), false);
  assert.equal(isRechargeRecordControlsOnly([]), false);
  assert.equal(isRechargeRecordControlsOnly(['docs/V2_TASKS.md']), false);
  const program = readFileSync('scripts/ci-recharge-check.mjs', 'utf8');
  const stop = program.indexOf(
    "part === 'guards' && mode === 'ci-only' && isRechargeRecordControlsOnly(changed)"
  );
  assert.ok(stop > program.indexOf("'scripts/ci-change-scope.test.mjs'"));
  assert.ok(
    stop > program.indexOf("['-B', 'scripts/production-release/recharge-record-release.test.py']")
  );
  assert.ok(stop < program.indexOf('const readonlyQualityMetadataOnly'));
});
for (const extra of [
  ...Object.keys(contract.changedSources),
  'deploy/nginx/admin.conf',
  'package-lock.json',
  '.github/workflows/production-release.yml',
  'scripts/production-release/remote-deploy.py',
  'scripts/production-release/online-recharge-component-consumer.test.py'
]) {
  test(`control-only path excludes ${extra}`, () => {
    assert.equal(isRechargeRecordControlsOnly([...controlsOnly, extra]), false);
    assert.equal(
      needsOnlineRechargeCiBuild([...controlsOnly, extra]),
      !isRechargeRecordRepairOnly([...controlsOnly, extra])
    );
  });
}
