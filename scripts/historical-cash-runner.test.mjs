import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { assertHistoricalCashChainUnchanged } from './historical-cash-chain.mjs';
import {
  buildOfflinePreview,
  canonicalJson,
  createFactsTemplate,
  projectRoot,
  readHistoricalCashOperator,
  resolveProjectFile,
  sha256,
  validateFrozenBatch
} from './historical-cash-runner.mjs';

const id = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const sourceAmounts = [
  ['debit', '130.0000', 101, 201],
  ['credit', '130.0000', 102, 201],
  ['credit', '10.0000', 102, 201],
  ['debit', '1350.0000', 103, 202]
];
const sourceCosts = [
  ['MYR', '66.3567', '0.3817', 301, '65.9750'],
  ['USDT', '343.6173', '-0.6083', 302, '344.2256'],
  ['USDT', '37.1111', '0.0818', 302, '37.0293'],
  ['MYR', '67.6244', '0.0000', 301, '67.6244'],
  ['MYR', '67.6244', '0.0000', 301, '67.6244']
];
const snapshot = {
  release: { commit: 'synthetic-test-source' },
  audit: {
    readOnlyPrivilegeVerified: true,
    identity: { snapshotAt: '2026-10-04T00:00:00.000Z' },
    accounts: [{ id: id(300), currency: 'CNY' }],
    journals: [
      ...new Map(
        sourceAmounts.map(([, , journal, order]) => [
          journal,
          { id: id(journal), sourceId: id(order), sourceType: 'order' }
        ])
      ).values()
    ],
    orders: [201, 202].map((value) => ({ id: id(value), orderNo: `SYNTHETIC-${value}` })),
    lines: [
      ...sourceAmounts.map(([direction, amount, journal], index) => ({
        id: id(index + 1),
        journalId: id(journal),
        accountCode: 'cash',
        financeAccountId: null,
        currency: 'CNY',
        direction,
        amountOriginal: amount,
        amountCny: amount
      })),
      ...sourceCosts.map(([currency, amount, , account], index) => ({
        id: id(index + 5),
        journalId: id(index + 104),
        accountCode: 'cash',
        financeAccountId: id(account),
        currency,
        direction: 'credit',
        amountOriginal: '1.0000',
        amountCny: amount
      }))
    ]
  }
};
const sourceBytes = Buffer.from(JSON.stringify(snapshot));
const proposals = {
  sourceFileSha256: sha256(sourceBytes),
  unboundCashReclassificationCandidates: sourceAmounts.map(([, amount, journal, order], index) => ({
    sourceLineId: id(index + 1),
    sourceJournalId: id(journal),
    sourceId: id(order),
    amountOriginal: amount,
    amountCny: amount
  })),
  cashCostAdjustments: sourceCosts.slice(0, 3).map(([, , delta, account], index) => ({
    sourceLineId: id(index + 5),
    casAccount: { id: id(account) },
    cashCarryingDeltaCny: delta
  }))
};
const proposalBytes = Buffer.from(JSON.stringify(proposals));
const recompute = {
  provenance: { sourceFileSha256: sha256(sourceBytes) },
  foreignExpenseCandidates: sourceCosts.map(
    ([currency, oldCost, delta, account, weighted], index) => ({
      cashLineId: id(index + 5),
      financeAccountId: id(account),
      journalId: id(index + 104),
      journalStatus: 'posted',
      currency,
      oldCashCostCny: oldCost,
      weightedNewCashCostCny: weighted,
      cashCarryingDeltaCny: delta
    })
  )
};
const recomputeHash = sha256(JSON.stringify(recompute));
const preview = (facts, selected = proposals) =>
  buildOfflinePreview(
    snapshot,
    selected,
    sha256(sourceBytes),
    sha256(proposalBytes),
    facts,
    recompute,
    recomputeHash
  );

test('snapshot preview preserves exact amounts and leaves the actual target unknown', () => {
  const result = preview();
  assert.equal(result.plan.assignments.length, 4);
  assert.equal(result.plan.costs.length, 5);
  assert.equal(result.costAdjustmentCount, 3);
  assert.equal(result.costVerificationOnlyCount, 2);
  assert.equal(result.unassignedCashNetCny, '1340.0000');
  assert.equal(result.cashCostNetDeltaCny, '-0.1448');
  assert.equal(result.factsComplete, false);
  assert.equal(result.executableBatchHash, null);
  assert.ok(result.plan.assignments.every((row) => row.targetAccountId === null));
});

test('receipt facts distinguish actual money, duplicate postings and opening inclusion', () => {
  const facts = createFactsTemplate(snapshot);
  const target = snapshot.audit.accounts.find((row) => row.currency === 'CNY').id;
  for (const row of facts.orders) {
    Object.assign(row, {
      targetAccountId: target,
      classification: 'real',
      duplicatePostingAbsent: true,
      openingIncludesTheseMovements: false,
      evidenceReference: 'synthetic:test-only'
    });
  }
  Object.assign(facts.costs, {
    realOperationsConfirmed: true,
    openingAndLedgerReconciled: true,
    priorCorrectionsAbsent: true,
    evidenceReference: 'synthetic:test-only'
  });
  assert.equal(preview(facts).factsComplete, true);
  for (const [key, value] of [
    ['classification', 'test'],
    ['duplicatePostingAbsent', false],
    ['openingIncludesTheseMovements', true]
  ]) {
    const invalid = structuredClone(facts);
    invalid.orders[0][key] = value;
    assert.equal(preview(invalid).factsComplete, false);
  }
});

test('source snapshot checksum and complete nonzero source coverage are mandatory', () => {
  assert.throws(
    () => buildOfflinePreview(snapshot, proposals, 'a'.repeat(64), sha256(proposalBytes)),
    /SNAPSHOT_PROVENANCE_MISMATCH/
  );
  const omitted = structuredClone(proposals);
  omitted.unboundCashReclassificationCandidates.pop();
  assert.throws(() => preview(undefined, omitted), /SOURCE_SELECTION_MISMATCH/);
});

test('invalid account text cannot be saved as an account identifier', () => {
  const facts = createFactsTemplate(snapshot);
  facts.orders[0].targetAccountId = 'not-an-account';
  const result = preview(facts);
  assert.ok(result.plan.assignments.every((row) => row.targetAccountId === null));
});

test('different receipt and refund targets stay unready rather than leaving the order account unresolved', () => {
  const facts = createFactsTemplate(snapshot);
  facts.orders[0].targetAccountId = id(300);
  facts.orders[0].lineAccountOverrides = [{ sourceLineId: id(2), targetAccountId: id(399) }];
  const result = preview(facts);
  assert.equal(result.factsComplete, false);
  assert.ok(
    result.missingFacts.some((value) => value.startsWith('ORDER_TARGET_DIFFERENT_ACCOUNTS:'))
  );
});

test('frozen execution binds both the reviewed hash and the exact command contents', () => {
  const fingerprint = (value) => sha256(canonicalJson(value));
  const command = { idempotencyKey: 'synthetic:test', adjustments: [{ sourceLineId: 'source-a' }] };
  const hash = fingerprint(command);
  const frozen = { mode: 'LIVE_READONLY_PREVIEW', factsComplete: true, batchHash: hash, command };
  validateFrozenBatch(frozen, hash, fingerprint);
  assert.throws(
    () => validateFrozenBatch(frozen, 'a'.repeat(64), fingerprint),
    /APPROVED_FROZEN_BATCH_REQUIRED/
  );
  assert.throws(
    () =>
      validateFrozenBatch(
        { ...frozen, command: { ...command, adjustments: [] } },
        hash,
        fingerprint
      ),
    /APPROVED_FROZEN_BATCH_REQUIRED/
  );
  assert.throws(
    () => validateFrozenBatch({ ...frozen, mode: 'OFFLINE_PREVIEW' }, hash, fingerprint),
    /APPROVED_FROZEN_BATCH_REQUIRED/
  );
});

test('missing fixed identity binding cannot trigger identity initialization or role writes', async () => {
  let identityReads = 0;
  const client = {
    user: {
      findUnique: async () => ({
        status: 'active',
        deletedAt: null,
        v2AuthIdentity: { enabled: true }
      })
    }
  };
  const runtime = {
    getSystemSuperAdminUserId: async () => null,
    V2IdentityService: class {
      async getAuthenticatedUser() {
        identityReads += 1;
        return { roles: ['admin'], permissions: [] };
      }
    }
  };
  await assert.rejects(
    readHistoricalCashOperator(client, runtime, id(999)),
    /EXISTING_IDENTITY_BINDING_REQUIRED/
  );
  assert.equal(identityReads, 0);
});

test('operator status, login enablement, password reset and database-derived finance permissions are enforced', async () => {
  const actor = {
    id: id(999),
    roles: ['finance_operator'],
    permissions: ['finance.view', 'finance.post', 'finance.adjust'],
    mustResetPassword: false
  };
  const user = { status: 'active', deletedAt: null, v2AuthIdentity: { enabled: true } };
  const client = { user: { findUnique: async () => user } };
  const runtime = {
    getSystemSuperAdminUserId: async () => id(998),
    V2IdentityService: class {
      async getAuthenticatedUser() {
        return actor;
      }
    }
  };
  assert.equal((await readHistoricalCashOperator(client, runtime, id(999))).id, actor.id);
  user.v2AuthIdentity.enabled = false;
  await assert.rejects(
    readHistoricalCashOperator(client, runtime, id(999)),
    /ACTIVE_OPERATOR_REQUIRED/
  );
  user.v2AuthIdentity.enabled = true;
  actor.mustResetPassword = true;
  await assert.rejects(
    readHistoricalCashOperator(client, runtime, id(999)),
    /FINANCE_OPERATOR_PERMISSION_REQUIRED/
  );
  actor.mustResetPassword = false;
  actor.permissions.pop();
  await assert.rejects(
    readHistoricalCashOperator(client, runtime, id(999)),
    /FINANCE_OPERATOR_PERMISSION_REQUIRED/
  );
});

test('identity initialization remains blocked if the fixed binding disappears between reads', async () => {
  const client = {
    user: {
      findUnique: async () => ({
        status: 'active',
        deletedAt: null,
        v2AuthIdentity: { enabled: true }
      })
    }
  };
  const runtime = {
    getSystemSuperAdminUserId: async () => id(998),
    V2IdentityService: class {
      constructor(prisma) {
        this.prisma = prisma;
      }
      async getAuthenticatedUser() {
        return this.prisma.$transaction();
      }
    }
  };
  await assert.rejects(
    readHistoricalCashOperator(client, runtime, id(999)),
    /IDENTITY_INITIALIZATION_NOT_ALLOWED/
  );
});

test('all controlled artifact output remains inside this project', () => {
  assert.throws(
    () => resolveProjectFile('/private/tmp/historical-cash.json', true),
    /FILE_OUTSIDE_PROJECT/
  );
  assert.throws(() => resolveProjectFile('/etc/passwd'), /FILE_OUTSIDE_PROJECT/);
});

test('historical weighted cost rejects a new cash chain even when opposite flows leave the same account balance', () => {
  const account = {
    id: id(300),
    currency: 'USDT',
    status: 'active',
    currentBalance: '100',
    currentBalanceCny: '700',
    updatedAt: new Date('2026-10-04T00:00:00Z')
  };
  const journal = { id: id(301), status: 'posted', reversalOfJournalId: null };
  const line = {
    id: id(302),
    journalId: journal.id,
    accountCode: 'cash',
    financeAccountId: account.id,
    amountOriginal: '100.0000',
    amountCny: '700.0000',
    fxRateToCny: '7.00000000'
  };
  const old = {
    audit: {
      accounts: [
        {
          ...account,
          currentBalance: '100.0000',
          currentBalanceCny: '700.0000',
          updatedAt: account.updatedAt.toISOString()
        }
      ],
      lines: [line],
      journals: [journal]
    }
  };
  const chain = [{ ...line, journal }];
  assertHistoricalCashChainUnchanged(account, chain, old);
  assert.throws(
    () => assertHistoricalCashChainUnchanged({ ...account, currentBalanceCny: '699' }, chain, old),
    /SOURCE_CHAIN_CHANGED/
  );
  assert.throws(
    () =>
      assertHistoricalCashChainUnchanged(
        { ...account, updatedAt: new Date('2026-10-04T00:00:01Z') },
        chain,
        old
      ),
    /SOURCE_CHAIN_CHANGED/
  );
  assert.throws(
    () =>
      assertHistoricalCashChainUnchanged(
        account,
        [
          ...chain,
          { ...line, id: id(303), amountOriginal: '1', journal },
          { ...line, id: id(304), amountOriginal: '1', journal }
        ],
        old
      ),
    /SOURCE_CHAIN_CHANGED/
  );
  assert.throws(
    () =>
      assertHistoricalCashChainUnchanged(
        account,
        [{ ...line, journal: { ...journal, status: 'reversed' } }],
        old
      ),
    /SOURCE_CHAIN_CHANGED/
  );
});

test('unchanged Prisma Decimal tiny rates match the fixed snapshot without rounding JavaScript numbers', () => {
  const account = {
    id: id(300),
    currency: 'USDT',
    status: 'active',
    currentBalance: new Prisma.Decimal('100'),
    currentBalanceCny: new Prisma.Decimal('700'),
    updatedAt: new Date('2026-10-04T00:00:00Z')
  };
  const journal = { id: id(301), status: 'posted', reversalOfJournalId: null };
  const line = {
    id: id(302),
    journalId: journal.id,
    accountCode: 'cash',
    financeAccountId: account.id,
    amountOriginal: '100.0000',
    amountCny: '700.0000',
    fxRateToCny: '0.00000001'
  };
  const old = {
    audit: {
      accounts: [
        {
          ...account,
          currentBalance: '100.0000',
          currentBalanceCny: '700.0000',
          updatedAt: account.updatedAt.toISOString()
        }
      ],
      lines: [line],
      journals: [journal]
    }
  };
  const rate = new Prisma.Decimal(line.fxRateToCny);
  assert.equal(rate.toString(), '1e-8');
  assertHistoricalCashChainUnchanged(account, [{ ...line, fxRateToCny: rate, journal }], old);
  assert.throws(
    () =>
      assertHistoricalCashChainUnchanged(account, [{ ...line, fxRateToCny: 1e-8, journal }], old),
    /SOURCE_CHAIN_CHANGED/
  );
});

test('offline mode rejects outside-project output before connecting or exposing configuration', () => {
  const secretFixture = 'synthetic-only-do-not-print';
  const child = spawnSync(
    process.execPath,
    [
      path.join(projectRoot, 'scripts/historical-cash-runner.mjs'),
      '--output',
      '/private/tmp/historical-cash.json'
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        DATABASE_URL: `mysql://fake:${secretFixture}@invalid.invalid/test`,
        V2_DATA_INTEGRITY_DATABASE_URL: `mysql://fake:${secretFixture}@invalid.invalid/test`
      },
      encoding: 'utf8',
      timeout: 10_000
    }
  );
  assert.equal(child.status, 1);
  assert.match(child.stderr, /FILE_OUTSIDE_PROJECT/);
  assert.ok(!`${child.stdout}${child.stderr}`.includes(secretFixture));
});
