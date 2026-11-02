import assert from 'node:assert/strict';
import test from 'node:test';
import { isAdminOnly, isCiOnly, needsAdminBrowserAcceptance } from './ci-recharge-scope.mjs';

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
    'apps/admin/src/v2/components/asyncRegionState.ts',
    'apps/admin/src/v2/components/V2AsyncRegion.vue'
  ];
  assert.equal(isAdminOnly(paths), true);
  assert.equal(isAdminOnly([...paths, 'apps/api/src/auth/auth.service.ts']), false);
});
