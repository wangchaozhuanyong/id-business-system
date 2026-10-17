import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { checkMode, selectedParts } from './ci-recharge-scope.mjs';
import {
  onlineSettingsPaths,
  isOnlineSettingsOnly,
  isOnlineSettingsControlsOnly,
  onlineSettingsCommands
} from './ci-online-settings-scope.mjs';

test('complete declared three-feature scope is accepted with every affected check', () => {
  assert.equal(isOnlineSettingsOnly(onlineSettingsPaths), true);
  const guards = onlineSettingsCommands('guards', onlineSettingsPaths)
    .map((command) => command.join(' '))
    .join('\n');
  for (const name of [
    'check:admin-ui',
    'check:v2-ui-language',
    'check:v2-color-contrast',
    'check:v2-table-standard',
    'check:v2-loading-standard',
    'check:v2-module-architecture',
    'check:v2-isolation'
  ])
    assert.ok(guards.includes(name));
  assert.ok(
    onlineSettingsCommands('api', onlineSettingsPaths).some((c) =>
      c.includes('src/id-business-v2/online-recharge')
    )
  );
  assert.ok(
    onlineSettingsCommands('online-engine', onlineSettingsPaths).some((c) =>
      c.includes('test:online-recharge:engine')
    )
  );
});
test('an extra schema, dependency, unrelated business file or duplicate falls back', () => {
  for (const name of [
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json',
    'apps/admin/src/v2/features/auto-recharge/V2AutoRechargeView.vue',
    'apps/api/src/id-business-v2/online-recharge/engine/unreviewed.cjs',
    onlineSettingsPaths[0]
  ])
    assert.equal(isOnlineSettingsOnly([...onlineSettingsPaths, name]), false);
});
test('a partial business feature cannot be admitted as controls-only', () => {
  assert.equal(
    isOnlineSettingsOnly(['apps/api/src/id-business-v2/online-recharge/plan-region.ts']),
    false
  );
  assert.equal(
    isOnlineSettingsControlsOnly([
      'scripts/ci-online-settings-scope.mjs',
      'apps/api/src/id-business-v2/online-recharge/plan-region.ts'
    ]),
    false
  );
});
test('control-only repairs retain guard tests without rerunning unrelated business checks', () => {
  assert.equal(
    isOnlineSettingsControlsOnly([
      'scripts/ci-recharge-scope.mjs',
      'scripts/ci-recharge-check.mjs'
    ]),
    false
  );
  const paths = [
    'scripts/ci-online-settings-scope.mjs',
    'scripts/production-release/online-settings-release.test.py'
  ];
  assert.equal(isOnlineSettingsControlsOnly(paths), true);
  assert.ok(
    onlineSettingsCommands('guards', paths).some((c) =>
      c.includes('scripts/production-release/online-settings-release.test.py')
    )
  );
  assert.throws(() => onlineSettingsCommands('api', paths));
});

test('isolated MySQL fixture repair retains all four checks and rejects extra runtime source', () => {
  const paths = [
    'apps/api/src/id-business-v2/online-recharge/mysql.integration.spec.ts',
    'scripts/production-release/online-settings-contract.json',
    'scripts/ci-online-settings-scope.mjs',
    'scripts/ci-online-settings-scope.test.mjs'
  ];
  assert.equal(isOnlineSettingsOnly(paths), true);
  assert.equal(isOnlineSettingsControlsOnly(paths), false);
  for (const part of ['guards', 'api', 'admin', 'online-engine'])
    assert.ok(onlineSettingsCommands(part, paths).length);
  for (const name of [
    'apps/api/src/id-business-v2/online-recharge/plan-region.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json'
  ])
    assert.equal(isOnlineSettingsOnly([...paths, name]), false);
});

test('Python-only release controls never invoke an unbounded formatter or lint command', () => {
  const commands = onlineSettingsCommands('guards', [
    'scripts/production-release/online-settings-release.py'
  ]);
  assert.ok(commands.some((command) => command[0] === 'python3'));
  assert.ok(
    commands.every((command) => !command.includes('eslint') && !command.includes('prettier'))
  );
});

test('the finite checkout repair keeps API, Admin, browser and all interface guards', () => {
  const contract = JSON.parse(
    readFileSync(new URL('./production-release/online-checkout-contract.json', import.meta.url))
  );
  const paths = [
    ...Object.keys(contract.sources),
    '.github/workflows/online-checkout-validation.yml',
    ...['build.py', 'contract.json', 'release.py', 'release.test.py'].map(
      (name) => 'scripts/production-release/online-checkout-' + name
    ),
    'scripts/ci-online-settings-scope.mjs',
    'scripts/ci-online-settings-scope.test.mjs'
  ];
  assert.equal(checkMode(paths, '', ''), 'recharge');
  assert.deepEqual(selectedParts(paths), ['guards', 'api', 'admin', 'online-engine']);
  assert.equal(isOnlineSettingsControlsOnly(paths), false);
  for (const extra of [
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json',
    'apps/api/src/auth/auth.service.ts'
  ])
    assert.equal(checkMode([...paths, extra], '', ''), 'full');
  assert.equal(isOnlineSettingsOnly(paths.filter((p) => !p.endsWith('/validation.ts'))), false);
  const guards = onlineSettingsCommands('guards', paths).flat();
  for (const name of [
    'admin-ui',
    'v2-ui-language',
    'v2-color-contrast',
    'v2-table-standard',
    'v2-loading-standard',
    'v2-module-architecture',
    'v2-isolation'
  ])
    assert.ok(guards.includes('check:' + name));
  assert.ok(guards.includes('scripts/production-release/online-checkout-release.test.py'));
  assert.ok(
    onlineSettingsCommands('api', paths)
      .flat()
      .includes('src/id-business-v2/bank-card-pool/shared-bank-card.spec.ts')
  );
});
test('display authorization repair is finite and retains real headed browser checks', () => {
  const paths = ['worker.cjs', 'test/runtime-main.test.cjs', 'SOURCE_MANIFEST.json'].map(
    (name) => 'apps/api/src/id-business-v2/online-recharge/engine/' + name
  );
  paths.push('scripts/production-release/online-browser-display-auth-release.py');
  assert.equal(isOnlineSettingsOnly(paths), true);
  assert.equal(isOnlineSettingsOnly(paths.slice(1)), false);
  assert.equal(isOnlineSettingsOnly([...paths, 'apps/api/src/auth/auth.service.ts']), false);
  assert.equal(isOnlineSettingsOnly([...paths, 'apps/api/prisma-mysql/schema.prisma']), false);
  const commands = onlineSettingsCommands('online-engine', paths).flat();
  assert.ok(commands.includes('xvfb') && commands.includes('xauth'));
  assert.ok(commands.includes('test:online-recharge:engine'));
  assert.ok(
    onlineSettingsCommands('guards', paths)
      .flat()
      .includes('scripts/production-release/online-browser-display-auth-release.test.py')
  );
});

test('billing, subscription context and progress follow-on repair uses all affected checks', () => {
  const paths = JSON.parse(
    readFileSync(
      new URL('./production-release/online-checkout-retest-contract.json', import.meta.url)
    )
  ).sources;
  const scope = [
    ...Object.keys(paths),
    'scripts/production-release/online-checkout-retest-build.py',
    'scripts/production-release/online-checkout-retest-release.py',
    'scripts/production-release/online-checkout-retest-contract.json',
    'scripts/production-release/online-checkout-retest-release.test.py',
    '.github/workflows/online-checkout-retest-validation.yml'
  ];
  assert.equal(isOnlineSettingsOnly(scope), true);
  for (const part of ['guards', 'api', 'admin', 'online-engine'])
    assert.ok(onlineSettingsCommands(part, scope).length);
  assert.equal(isOnlineSettingsOnly([...scope, 'apps/api/src/auth/auth.service.ts']), false);
});
