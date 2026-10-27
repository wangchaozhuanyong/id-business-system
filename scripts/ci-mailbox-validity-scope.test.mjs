import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mailboxValidityPaths,
  isMailboxValidityOnly,
  mailboxValidityCommands
} from './ci-mailbox-validity-scope.mjs';
import { checkMode, needsOnlineRechargeCiBuild } from './ci-recharge-scope.mjs';

const field =
  '  queryCodeValidityDays       Int                              @default(30) @map("query_code_validity_days")\n';
test('only the complete reviewed mailbox delta selects scoped quality', () => {
  assert.equal(checkMode(mailboxValidityPaths, 'model {}\n', field + 'model {}\n'), 'mailbox');
  assert.equal(needsOnlineRechargeCiBuild(mailboxValidityPaths), false);
  assert.equal(
    isMailboxValidityOnly([...mailboxValidityPaths, 'apps/api/src/auth/auth.service.ts']),
    false
  );
  assert.equal(isMailboxValidityOnly(mailboxValidityPaths.slice(1)), false);
  assert.equal(
    isMailboxValidityOnly([...mailboxValidityPaths.slice(1), mailboxValidityPaths[1]]),
    false
  );
  assert.equal(
    isMailboxValidityOnly(mailboxValidityPaths, 'model {}\n', field + 'different schema\n'),
    false
  );
});
test('selected checks retain UI, API, browser and release controls', () => {
  const guards = JSON.stringify(mailboxValidityCommands('guards', mailboxValidityPaths));
  for (const name of [
    'check:admin-ui',
    'check:v2-ui-language',
    'check:v2-color-contrast',
    'check:v2-table-standard',
    'check:v2-loading-standard',
    'check:v2-module-architecture',
    'check:v2-isolation',
    'mailbox-validity-release.test.py'
  ])
    assert.ok(guards.includes(name));
  assert.ok(
    JSON.stringify(mailboxValidityCommands('api')).includes('managed-mailbox.service.spec.ts')
  );
  assert.ok(
    JSON.stringify(mailboxValidityCommands('admin')).includes(
      'acceptance-v2-mailbox-query-code-validity.mjs'
    )
  );
  assert.throws(() => mailboxValidityCommands('engine'));
});
