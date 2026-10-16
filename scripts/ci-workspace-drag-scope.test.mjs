import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isWorkspaceDragOnly,
  workspaceDragParts,
  workspaceDragCommands
} from './ci-workspace-drag-scope.mjs';
import { checkMode, selectedParts, needsOnlineRechargeCiBuild } from './ci-recharge-scope.mjs';

const control = ['scripts/production-release/workspace-drag-contract.json'];
const paths = [...control, 'apps/admin/src/v2/components/workspace/V2QuickActions.vue'];

test('card drag selects only frontend and guards when schema is unchanged', () => {
  assert.equal(isWorkspaceDragOnly(paths), true);
  assert.equal(checkMode(paths, 'same', 'same'), 'admin');
  assert.deepEqual(selectedParts(paths), ['guards', 'admin']);
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  assert.equal(checkMode(paths, 'old', 'new'), 'full');
});
test('unknown source dependency and duplicated paths cannot enter this scope', () => {
  for (const name of [
    'apps/api/src/pay.ts',
    'package.json',
    'apps/admin/src/v2/features/unknown.vue',
    paths[0]
  ])
    assert.equal(isWorkspaceDragOnly([...paths, name]), false);
});
test('control repairs do not rerun unchanged application checks', () => {
  assert.deepEqual(workspaceDragParts(control), ['guards']);
  assert.equal(checkMode(control, 'same', 'same'), 'ci-only');
  assert.deepEqual(selectedParts(control), ['guards']);
  assert.throws(() => workspaceDragCommands('api', paths));
});
test('frontend scope retains all seven UI rules and the affected runtime tests and build', () => {
  const guards = workspaceDragCommands('guards', paths)
    .map((a) => a.join(' '))
    .join('\n');
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
  const admin = workspaceDragCommands('admin', paths)
    .map((a) => a.join(' '))
    .join('\n');
  assert.ok(admin.includes('useV2QuickActionSorting.spec.ts'));
  assert.ok(admin.includes('workspace-ui.contract.spec.ts'));
  assert.ok(admin.includes('build --workspace @apple-business/admin'));
  assert.ok(!admin.includes('prisma'));
});
