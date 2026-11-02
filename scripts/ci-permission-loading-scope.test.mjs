import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAdminOnly,
  isCiOnly,
  needsAdminBrowserAcceptance,
  needsOnlineRechargeCiBuild,
  isPermissionLoadingRepairOnly,
  isPermissionLoadingControlsOnly,
  permissionLoadingRepairPaths
} from './ci-recharge-scope.mjs';

const controls = [
  '.github/workflows/permission-loading-publication.yml',
  ...['runtime.py', 'build.py', 'publication.py', 'release.test.py', 'contract.json'].map(
    (suffix) => 'scripts/production-release/permission-loading-' + suffix
  )
];
test('browser acceptance commands install Chromium before the affected frontend checks', () => {
  assert.equal(
    needsAdminBrowserAcceptance('admin', [
      'apps/admin/src/v2/features/proxy-pool/V2ProxyPoolView.vue'
    ]),
    true
  );
  assert.equal(
    needsAdminBrowserAcceptance('admin', ['scripts/acceptance-v2-permission-loading.mjs']),
    true
  );
  assert.equal(
    needsAdminBrowserAcceptance('admin', ['scripts/acceptance-v2-recharge-proxies-ui.mjs']),
    true
  );
  assert.equal(
    needsAdminBrowserAcceptance('admin', ['apps/admin/src/v2/components/asyncRegionState.ts']),
    false
  );
});
test('permission loading release controls do not classify business or schema changes as CI', () => {
  assert.equal(isCiOnly(controls), true);
  for (const path of [
    'apps/admin/src/v2/components/V2AsyncRegion.vue',
    'apps/api/prisma-mysql/schema.prisma',
    'scripts/production-release/permission-loading-unreviewed.py'
  ]) {
    assert.equal(isCiOnly([...controls, path]), false, path);
  }
});
test('the complete permission repair uses frontend checks and rejects backend additions', () => {
  const paths = [
    ...controls,
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-permission-loading-scope.test.mjs',
    'scripts/acceptance-v2-permission-loading.mjs',
    'scripts/acceptance-v2-recharge-proxies-ui.mjs',
    'scripts/ci-recharge-release.test.mjs',
    'apps/admin/src/v2/components/asyncRegionState.ts',
    'apps/admin/src/v2/components/V2AsyncRegion.vue'
  ];
  assert.equal(isAdminOnly(paths), true);
  assert.equal(isAdminOnly([...paths, 'apps/api/src/auth/auth.service.ts']), false);
});

test('the finite loading batch excludes unrelated ONLINE images and closes extensions', () => {
  const paths = permissionLoadingRepairPaths;
  assert.equal(isPermissionLoadingRepairOnly(paths), true);
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  assert.equal(isAdminOnly(paths), true);
  for (const extra of [
    'apps/api/src/id-business-v2/online-recharge/engine/healthcheck.cjs',
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json',
    'scripts/production-release/remote-deploy.py'
  ]) {
    assert.equal(isPermissionLoadingRepairOnly([...paths, extra]), false, extra);
    assert.equal(needsOnlineRechargeCiBuild([...paths, extra]), true, extra);
  }
  assert.equal(isPermissionLoadingRepairOnly([...paths, paths[0]]), false);
  assert.equal(
    isPermissionLoadingRepairOnly(
      paths.filter((p) => !p.endsWith('permission-loading-contract.json'))
    ),
    false
  );
});

test('publication-only repairs keep controls without frontend or historical engine builds', () => {
  const paths = [
    ...controls,
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-check.mjs',
    'scripts/ci-permission-loading-scope.test.mjs'
  ];
  assert.equal(isPermissionLoadingControlsOnly(paths), true);
  assert.equal(isCiOnly(paths), true);
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  for (const extra of [
    'apps/admin/src/v2/components/V2AsyncRegion.vue',
    'apps/api/src/auth/auth.service.ts',
    'package-lock.json',
    'scripts/production-release/remote-deploy.py'
  ])
    assert.equal(isPermissionLoadingControlsOnly([...paths, extra]), false, extra);
});
