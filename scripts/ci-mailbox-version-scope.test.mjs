import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mailboxVersionPaths,
  isMailboxVersionOnly,
  mailboxVersionCommands
} from './ci-mailbox-version-scope.mjs';
import { checkMode, selectedParts } from './ci-recharge-scope.mjs';
test('mailbox version scope keeps all API checks without publishing unrelated code', () => {
  assert.equal(isMailboxVersionOnly(mailboxVersionPaths), true);
  assert.equal(checkMode(mailboxVersionPaths, 'same', 'same'), 'recharge');
  assert.deepEqual(selectedParts(mailboxVersionPaths), ['guards', 'api', 'release-controls']);
  assert.equal(checkMode(mailboxVersionPaths, 'old', 'new'), 'full');
  for (const part of ['guards', 'api', 'release-controls'])
    assert.ok(mailboxVersionCommands(part, mailboxVersionPaths).length);
  assert.throws(() => mailboxVersionCommands('admin', mailboxVersionPaths));
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
