import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mailboxVersionPaths,
  isMailboxVersionOnly,
  isMailboxVersionControlsOnly,
  mailboxVersionCommands
} from './ci-mailbox-version-scope.mjs';
import { checkMode, selectedParts, needsOnlineRechargeCiBuild } from './ci-recharge-scope.mjs';
test('mailbox version scope keeps all API checks without publishing unrelated code', () => {
  assert.equal(isMailboxVersionOnly(mailboxVersionPaths), true);
  assert.equal(checkMode(mailboxVersionPaths, 'same', 'same'), 'recharge');
  assert.deepEqual(selectedParts(mailboxVersionPaths), ['guards', 'api', 'release-controls']);
  assert.equal(needsOnlineRechargeCiBuild(mailboxVersionPaths), false);
  assert.equal(checkMode(mailboxVersionPaths, 'old', 'new'), 'full');
  for (const part of ['guards', 'api', 'release-controls'])
    assert.ok(mailboxVersionCommands(part, mailboxVersionPaths).length);
  assert.throws(() => mailboxVersionCommands('admin', mailboxVersionPaths));
});

test('layout repair selects only controls and cannot admit application or schema changes', () => {
  const paths = mailboxVersionPaths.filter((name) => !name.startsWith('apps/'));
  assert.equal(isMailboxVersionControlsOnly(paths), true);
  assert.equal(checkMode(paths, 'same', 'same'), 'ci-only');
  assert.deepEqual(selectedParts(paths), ['guards', 'release-controls']);
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  assert.ok(mailboxVersionCommands('guards', paths).some(([file]) => file === 'python3'));
  assert.throws(() => mailboxVersionCommands('api', paths));
  assert.equal(isMailboxVersionControlsOnly([...paths, mailboxVersionPaths[0]]), false);
});
test('extra payment auth schema and missing regression paths cannot use the narrow checks', () => {
  for (const path of [
    'apps/api/src/auth/auth.service.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json'
  ])
    assert.equal(isMailboxVersionOnly([...mailboxVersionPaths, path]), false);
  assert.equal(isMailboxVersionOnly(mailboxVersionPaths.slice(1)), false);
  assert.equal(isMailboxVersionOnly([...mailboxVersionPaths, mailboxVersionPaths[0]]), false);
});
