import assert from 'node:assert/strict';
import test from 'node:test';
import {
  rechargeAutofillControls,
  isRechargeAutofillControlsOnly
} from './ci-recharge-autofill-scope.mjs';
import { checkMode, selectedParts, needsOnlineRechargeCiBuild } from './ci-recharge-scope.mjs';
test('complete publication controls reuse reviewed source checks and run control guards', () => {
  assert.equal(isRechargeAutofillControlsOnly(rechargeAutofillControls), true);
  assert.equal(checkMode(rechargeAutofillControls, 'same', 'same'), 'ci-only');
  assert.deepEqual(selectedParts(rechargeAutofillControls), ['guards']);
  assert.equal(needsOnlineRechargeCiBuild(rechargeAutofillControls), false);
});
test('missing controls, duplicates and every runtime extension retain ordinary CI', () => {
  for (const missing of rechargeAutofillControls.filter((p) => !p.startsWith('scripts/ci-')))
    assert.equal(
      isRechargeAutofillControlsOnly(rechargeAutofillControls.filter((p) => p !== missing)),
      false
    );
  assert.equal(isRechargeAutofillControlsOnly([]), false);
  for (const extra of [
    rechargeAutofillControls[0],
    'apps/admin/src/v2/features/auto-recharge/useAutoRecharge.ts',
    'apps/api/src/auth/auth.service.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json',
    'scripts/production-release/remote-deploy.py'
  ])
    assert.equal(isRechargeAutofillControlsOnly([...rechargeAutofillControls, extra]), false);
});

import {
  rechargeAutofillSourcePaths,
  rechargeAutofillReviewedSources,
  isRechargeAutofillSourceOnly,
  rechargeAutofillSourceCommands
} from './ci-recharge-autofill-scope.mjs';
test('reviewed application keeps API Admin and Linux engine checks and every UI rule', () => {
  assert.equal(isRechargeAutofillSourceOnly(rechargeAutofillSourcePaths), true);
  assert.equal(checkMode(rechargeAutofillSourcePaths, 'same', 'same'), 'recharge');
  assert.equal(checkMode(rechargeAutofillSourcePaths, 'old', 'changed'), 'full');
  assert.deepEqual(selectedParts(rechargeAutofillSourcePaths), [
    'guards',
    'api',
    'admin',
    'online-engine'
  ]);
  assert.equal(needsOnlineRechargeCiBuild(rechargeAutofillSourcePaths), false);
  const commands = JSON.stringify(
    selectedParts(rechargeAutofillSourcePaths).flatMap((p) => rechargeAutofillSourceCommands(p))
  );
  for (const required of [
    'check:admin-ui',
    'check:v2-ui-language',
    'check:v2-color-contrast',
    'check:v2-table-standard',
    'check:v2-loading-standard',
    'check:v2-module-architecture',
    'check:v2-isolation',
    'typecheck',
    'bitbrowser-card-credentials.spec.ts',
    'recharge-settings-selection.spec.ts',
    'useRechargeCardCvc.spec.ts',
    'test:online-recharge:engine',
    '--with-deps',
    'ffmpeg',
    'https://archive.ubuntu.com/ubuntu'
  ])
    assert.ok(commands.includes(required), required);
});
test('application batch refuses altered, missing, duplicated or unrelated sources', () => {
  for (const n of rechargeAutofillSourcePaths)
    assert.equal(
      isRechargeAutofillSourceOnly(rechargeAutofillSourcePaths.filter((p) => p !== n)),
      false
    );
  for (const extra of [
    'package-lock.json',
    'apps/api/prisma-mysql/schema.prisma',
    rechargeAutofillSourcePaths[0]
  ])
    assert.equal(isRechargeAutofillSourceOnly([...rechargeAutofillSourcePaths, extra]), false);
  const first = Object.keys(rechargeAutofillReviewedSources)[0];
  assert.equal(
    isRechargeAutofillSourceOnly(rechargeAutofillSourcePaths, (name) =>
      name === first ? '0'.repeat(64) : rechargeAutofillReviewedSources[name]
    ),
    false
  );
  assert.throws(() => rechargeAutofillSourceCommands('migration'), /Unknown/);
});

test('publication admits its seven new controls after unchanged CI support has merged', () => {
  const paths = rechargeAutofillControls.filter((p) => !p.startsWith('scripts/ci-'));
  assert.equal(paths.length, 7);
  assert.equal(isRechargeAutofillControlsOnly(paths), true);
  assert.equal(checkMode(paths, 'same', 'same'), 'ci-only');
  assert.deepEqual(selectedParts(paths), ['guards']);
});
