import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isMailboxProviderOnly,
  mailboxProviderControls,
  mailboxProviderSources
} from './ci-mailbox-provider-scope.mjs';
import { checkMode, adminCheckCommands } from './ci-recharge-scope.mjs';
const paths = [...mailboxProviderSources, ...mailboxProviderControls];
test('the complete reviewed UI and publication delta uses Admin checks', () => {
  assert.equal(isMailboxProviderOnly(paths), true);
  assert.equal(checkMode(paths), 'admin');
  const commands = adminCheckCommands('admin', paths).map((c) => c.join(' '));
  assert.ok(commands.some((c) => c.includes('mailbox-provider-release.test.py')));
  assert.ok(commands.some((c) => c.includes('acceptance-v2-workspace-dock.mjs')));
});
test('API, authentication, database and unrelated paths cannot enter the finite release', () => {
  for (const name of [
    'apps/api/src/id-business-v2/workspace/other.ts',
    'apps/admin/src/auth/session.ts',
    'apps/api/prisma-mysql/schema.prisma',
    '.env'
  ])
    assert.equal(isMailboxProviderOnly([...paths, name]), false);
});
test('missing controls and duplicate paths cannot qualify as the reviewed scope', () => {
  assert.equal(isMailboxProviderOnly(paths.slice(1)), false);
  assert.equal(isMailboxProviderOnly([...paths, paths[0]]), false);
  assert.equal(isMailboxProviderOnly([]), false);
});
