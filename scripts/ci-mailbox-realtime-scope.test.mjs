import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isMailboxRealtimeOnly } from './ci-mailbox-realtime-scope.mjs';
import { checkMode, selectedParts, needsOnlineRechargeCiBuild } from './ci-recharge-scope.mjs';
const c = JSON.parse(
  readFileSync('scripts/production-release/mailbox-realtime-contract.json', 'utf8')
);
const context = { base: c.sourceBaseline, baseTree: c.sourceBaselineTree };
test('mailbox source scope keeps API Admin and all seven UI checks without an ONLINE build', () => {
  assert.equal(isMailboxRealtimeOnly(c.expectedGitChanges, context), true);
  assert.equal(checkMode(c.expectedGitChanges, 'same', 'same', undefined, context), 'recharge');
  assert.deepEqual(selectedParts(c.expectedGitChanges, undefined, context), [
    'guards',
    'api',
    'admin',
    'release-controls'
  ]);
  assert.equal(needsOnlineRechargeCiBuild(c.expectedGitChanges, context), false);
  assert.equal(checkMode(c.expectedGitChanges, 'old', 'new', undefined, context), 'full');
});
test('extra files missing files duplicate paths and a different base are rejected', () => {
  assert.equal(
    isMailboxRealtimeOnly(
      [...c.expectedGitChanges, 'apps/api/prisma-mysql/schema.prisma'],
      context
    ),
    false
  );
  assert.equal(isMailboxRealtimeOnly(c.expectedGitChanges.slice(1), context), false);
  assert.equal(
    isMailboxRealtimeOnly([...c.expectedGitChanges.slice(1), c.expectedGitChanges[1]], context),
    false
  );
  assert.equal(
    isMailboxRealtimeOnly(c.expectedGitChanges, { ...context, base: 'a'.repeat(40) }),
    false
  );
});
