import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mailboxValidityPaths,
  isMailboxValidityOnly,
  mailboxValidityCommands
} from './ci-mailbox-validity-scope.mjs';
import {
  mailboxValidityApiReceipt as b,
  mailboxValidityApiReceiptMatches
} from './ci-mailbox-validity-scope.mjs';
import { checkMode, needsOnlineRechargeCiBuild, affectsPart } from './ci-recharge-scope.mjs';

test('browser-only repair rechecks Admin and guards while retaining API source evidence', () => {
  const changed = ['scripts/acceptance-v2-mailbox-query-code-validity.mjs'];
  assert.equal(affectsPart('guards', changed), true);
  assert.equal(affectsPart('admin', changed), true);
  assert.equal(affectsPart('api', changed), false);
  assert.equal(
    affectsPart('api', [
      'apps/api/src/id-business-v2/workspace/id-business-v2-managed-mailbox.service.ts'
    ]),
    true
  );
});

const field =
  '  queryCodeValidityDays       Int                              @default(30) @map("query_code_validity_days")\n';

test('partial API reuse requires the original successful native job and checkout', () => {
  const input = {
    unchanged: true,
    run: {
      id: b.runId,
      run_attempt: 1,
      event: 'pull_request',
      path: '.github/workflows/quality.yml',
      status: 'completed',
      conclusion: 'failure',
      head_sha: b.head,
      repository: { full_name: b.repository },
      pull_requests: [{ number: b.pullRequest }]
    },
    job: {
      id: b.jobId,
      run_id: b.runId,
      name: 'recharge (api)',
      status: 'completed',
      conclusion: 'success',
      steps: ['Checkout', 'Install package dependencies', 'Check affected recharge part'].map(
        (name) => ({ name, conclusion: 'success' })
      )
    },
    checkout: {
      sha: b.checkout,
      tree: { sha: b.tree },
      parents: [{ sha: b.base }, { sha: b.head }]
    },
    log: '[command]/usr/bin/git log -1 --format=%H\n2026-10-27T00:00:00Z ' + b.checkout + '\n'
  };
  assert.equal(mailboxValidityApiReceiptMatches(input), true);
  assert.equal(mailboxValidityApiReceiptMatches({ ...input, unchanged: false }), false);
  assert.equal(
    mailboxValidityApiReceiptMatches({ ...input, run: { ...input.run, head_sha: '0'.repeat(40) } }),
    false
  );
  assert.equal(
    mailboxValidityApiReceiptMatches({ ...input, job: { ...input.job, conclusion: 'failure' } }),
    false
  );
  assert.equal(
    mailboxValidityApiReceiptMatches({
      ...input,
      checkout: { ...input.checkout, tree: { sha: '0'.repeat(40) } }
    }),
    false
  );
  assert.equal(mailboxValidityApiReceiptMatches({ ...input, log: '' }), false);
});
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
