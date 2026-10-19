import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isManualSettlementCandidate,
  hasOnlineRuntimeChange,
  manualReleasePaths,
  manualCiPaths
} from './ci-bitbrowser-manual-controls.mjs';

const manifest = JSON.parse(
  readFileSync('scripts/production-release/bitbrowser-manual-contract.json', 'utf8')
);
const paths = [...Object.keys(manifest.sources), ...manualReleasePaths, ...manualCiPaths];

test('manual publisher closes its source and control paths without changing full quality mode', () => {
  assert.equal(isManualSettlementCandidate(paths, manifest), true);
  for (const path of manualReleasePaths)
    assert.equal(
      isManualSettlementCandidate(
        paths.filter((name) => name !== path),
        manifest
      ),
      false
    );
  assert.equal(isManualSettlementCandidate([...paths, paths[0]], manifest), false);
});

test('unreviewed source, schema, dependencies and other publishers keep their ordinary controls', () => {
  for (const path of [
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json',
    'apps/api/src/id-business-v2/online-recharge/worker.repository.ts',
    'scripts/production-release/remote-deploy.py'
  ])
    assert.equal(isManualSettlementCandidate([...paths, path], manifest), false);
  for (const c of [
    {},
    { ...manifest, status: 'DRAFT' },
    { ...manifest, sourceReviewCommit: 'a'.repeat(40) }
  ])
    assert.equal(isManualSettlementCandidate(paths, c), false);
});

test('publisher repair retains finite controls only with frozen contract and matching tests', () => {
  const repair = [
    'scripts/production-release/bitbrowser-manual-dispatch.py',
    'scripts/production-release/bitbrowser-manual-contract.json',
    'scripts/production-release/bitbrowser-manual-release.test.py',
    ...manualCiPaths.slice(0, 2)
  ];
  assert.equal(isManualSettlementCandidate(repair, manifest), true);
  for (const path of repair.slice(1, 3))
    assert.equal(
      isManualSettlementCandidate(
        repair.filter((name) => name !== path),
        manifest
      ),
      false
    );
  assert.equal(isManualSettlementCandidate([...repair, 'package-lock.json'], manifest), false);
  assert.equal(
    isManualSettlementCandidate([...repair, Object.keys(manifest.sources)[0]], manifest),
    false
  );
});

test('test fixture alone requires API tests rather than a rebuilt unchanged ONLINE engine', () => {
  const root = 'apps/api/src/id-business-v2/online-recharge/';
  assert.equal(hasOnlineRuntimeChange([root + 'local-chain-acceptance.spec.ts']), false);
  assert.equal(hasOnlineRuntimeChange([root + 'worker.service.ts']), true);
  assert.equal(hasOnlineRuntimeChange([root + 'engine/checkout-form.cjs']), true);
});

test('finite publisher tests preserve source, payload, shared runtime and original activation guards', () => {
  const source = readFileSync('scripts/ci-recharge-check.mjs', 'utf8');
  assert.match(
    source,
    /\['guards', 'release-controls'\]\.includes\(part\) && isManualSettlementCandidate\(changed\)/
  );
  assert.match(source, /bitbrowser-manual-build\.py', '--check'/);
  assert.match(source, /bitbrowser-manual-release\.test\.py/);
  const scope = readFileSync('scripts/ci-recharge-scope.mjs', 'utf8');
  assert.match(
    scope,
    /isManualSettlementCandidate\(paths\)\s*\?\s*false\s*:\s*needsOnlineRechargeCiBuild\(paths\)/
  );
});
