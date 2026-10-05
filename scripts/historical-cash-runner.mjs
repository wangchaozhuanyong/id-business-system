#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertV2AuditConnectionReadOnly } from './lib/v2-data-integrity-audit.mjs';
import { assertHistoricalCashChainUnchanged } from './historical-cash-chain.mjs';

const require = createRequire(import.meta.url);
export const projectRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const auditRoot = path.join(projectRoot, '.codex-audit/financial-closure-20261004');
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const HASH = /^[\da-f]{64}$/;
const REFERENCE = /^[A-Za-z\d_.:-]{1,160}$/;

function fail(code) {
  const error = new Error(code);
  error.runnerCode = code;
  throw error;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function resolveProjectFile(value, output = false) {
  const candidate = path.resolve(projectRoot, value);
  const resolved = output
    ? path.join(realpathSync(path.dirname(candidate)), path.basename(candidate))
    : realpathSync(candidate);
  if (!resolved.startsWith(`${projectRoot}${path.sep}`)) fail('FILE_OUTSIDE_PROJECT');
  return resolved;
}

function loadJson(file) {
  const bytes = readFileSync(resolveProjectFile(file));
  return { data: JSON.parse(bytes.toString('utf8')), hash: sha256(bytes) };
}

function amount4(value) {
  if (typeof value !== 'string' || !/^-?\d+\.\d{4}$/.test(value)) fail('INVALID_AMOUNT');
  const negative = value.startsWith('-');
  const [whole, fraction] = value.replace(/^-/, '').split('.');
  return BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n);
}

function format4(value) {
  const digits = (value < 0n ? -value : value).toString().padStart(5, '0');
  return `${value < 0n ? '-' : ''}${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

export function createFactsTemplate(snapshot) {
  const cashOrders = new Set(
    snapshot.audit.lines
      .filter(
        (line) =>
          line.accountCode === 'cash' &&
          line.financeAccountId === null &&
          (amount4(line.amountOriginal) !== 0n || amount4(line.amountCny) !== 0n)
      )
      .map(
        (line) => snapshot.audit.journals.find((journal) => journal.id === line.journalId)?.sourceId
      )
  );
  return {
    version: 1,
    orders: snapshot.audit.orders
      .filter((order) => cashOrders.has(order.id))
      .map((order) => ({
        orderId: order.id,
        orderNo: order.orderNo,
        targetAccountId: null,
        classification: null,
        duplicatePostingAbsent: null,
        openingIncludesTheseMovements: null,
        evidenceReference: null,
        lineAccountOverrides: []
      })),
    costs: {
      realOperationsConfirmed: null,
      openingAndLedgerReconciled: null,
      priorCorrectionsAbsent: null,
      evidenceReference: null
    }
  };
}

export function buildOfflinePreview(
  snapshot,
  proposals,
  snapshotHash,
  proposalsHash,
  facts,
  recompute,
  recomputeHash
) {
  if (!snapshot.audit?.readOnlyPrivilegeVerified || proposals.sourceFileSha256 !== snapshotHash) {
    fail('SNAPSHOT_PROVENANCE_MISMATCH');
  }
  if (recompute?.provenance?.sourceFileSha256 !== snapshotHash)
    fail('RECOMPUTE_PROVENANCE_MISMATCH');
  const actualUnassigned = snapshot.audit.lines
    .filter(
      (line) =>
        line.accountCode === 'cash' &&
        line.financeAccountId === null &&
        (amount4(line.amountOriginal) !== 0n || amount4(line.amountCny) !== 0n)
    )
    .map((line) => line.id)
    .sort();
  const selectedUnassigned = proposals.unboundCashReclassificationCandidates
    .map((row) => row.sourceLineId)
    .sort();
  if (canonicalJson(actualUnassigned) !== canonicalJson(selectedUnassigned))
    fail('SOURCE_SELECTION_MISMATCH');
  const template = createFactsTemplate(snapshot);
  if (facts && (facts.version !== 1 || !Array.isArray(facts.orders))) fail('INVALID_FACTS');
  const inputFacts = facts ?? template;
  const missingFacts = [];
  const assignments = proposals.unboundCashReclassificationCandidates.map((proposal) => {
    const source = snapshot.audit.lines.find((line) => line.id === proposal.sourceLineId);
    const journal = snapshot.audit.journals.find((row) => row.id === proposal.sourceJournalId);
    if (
      !source ||
      !journal ||
      source.financeAccountId !== null ||
      source.journalId !== journal.id ||
      journal.sourceType !== 'order' ||
      journal.sourceId !== proposal.sourceId ||
      source.amountOriginal !== proposal.amountOriginal ||
      source.amountCny !== proposal.amountCny
    ) {
      fail('SOURCE_SELECTION_MISMATCH');
    }
    const orderFacts = inputFacts.orders.find((row) => row.orderId === journal.sourceId);
    const override = orderFacts?.lineAccountOverrides?.find(
      (row) => row.sourceLineId === source.id
    );
    const rawTarget = override?.targetAccountId ?? orderFacts?.targetAccountId ?? null;
    const targetAccountId = UUID.test(rawTarget ?? '') ? rawTarget : null;
    if (
      !UUID.test(targetAccountId ?? '') ||
      orderFacts?.classification !== 'real' ||
      orderFacts?.duplicatePostingAbsent !== true ||
      orderFacts?.openingIncludesTheseMovements !== false ||
      !REFERENCE.test(orderFacts?.evidenceReference ?? '')
    ) {
      missingFacts.push(`ORDER_FACTS:${journal.sourceId}:${source.id}`);
    }
    return {
      sourceLineId: source.id,
      sourceJournalId: journal.id,
      sourceOrderId: journal.sourceId,
      targetAccountId,
      currency: source.currency,
      direction: source.direction,
      amountOriginal: source.amountOriginal,
      amountCny: source.amountCny,
      evidenceReference: REFERENCE.test(orderFacts?.evidenceReference ?? '')
        ? orderFacts.evidenceReference
        : null
    };
  });
  for (const orderId of new Set(assignments.map((row) => row.sourceOrderId))) {
    if (
      new Set(
        assignments.filter((row) => row.sourceOrderId === orderId).map((row) => row.targetAccountId)
      ).size > 1
    )
      missingFacts.push(`ORDER_TARGET_DIFFERENT_ACCOUNTS:${orderId}`);
  }
  const verifications = recompute.foreignExpenseCandidates
    .filter((row) => row.journalStatus === 'posted' && amount4(row.cashCarryingDeltaCny) === 0n)
    .map((row) => ({
      sourceLineId: row.cashLineId,
      casAccount: { id: row.financeAccountId },
      cashCarryingDeltaCny: '0.0000'
    }));
  const costs = [...proposals.cashCostAdjustments, ...verifications].map((proposal) => {
    const source = snapshot.audit.lines.find((row) => row.id === proposal.sourceLineId);
    if (!source || source.financeAccountId !== proposal.casAccount.id) {
      fail('SOURCE_SELECTION_MISMATCH');
    }
    const delta = amount4(proposal.cashCarryingDeltaCny);
    const expectedBookCostCny = source.amountCny;
    const recomputedBookCostCny = format4(amount4(expectedBookCostCny) - delta);
    const calculated = recompute.foreignExpenseCandidates.find(
      (row) => row.cashLineId === source.id
    );
    if (
      !calculated ||
      calculated.journalStatus !== 'posted' ||
      calculated.journalId !== source.journalId ||
      calculated.financeAccountId !== source.financeAccountId ||
      calculated.oldCashCostCny !== expectedBookCostCny ||
      calculated.weightedNewCashCostCny !== recomputedBookCostCny
    )
      fail('RECOMPUTE_SOURCE_MISMATCH');
    return {
      sourceLineId: source.id,
      sourceJournalId: source.journalId,
      accountId: source.financeAccountId,
      currency: source.currency,
      expectedBookCostCny,
      recomputedBookCostCny,
      cashCarryingDeltaCny: proposal.cashCarryingDeltaCny,
      action: amount4(proposal.cashCarryingDeltaCny) === 0n ? 'verification-only' : 'adjustment',
      evidenceReference: REFERENCE.test(inputFacts.costs?.evidenceReference ?? '')
        ? inputFacts.costs.evidenceReference
        : null
    };
  });
  if (
    inputFacts.costs?.realOperationsConfirmed !== true ||
    inputFacts.costs?.openingAndLedgerReconciled !== true ||
    inputFacts.costs?.priorCorrectionsAbsent !== true ||
    !REFERENCE.test(inputFacts.costs?.evidenceReference ?? '')
  ) {
    missingFacts.push('COST_OPENING_SOURCE_AND_DUPLICATE_FACTS');
  }
  const plan = {
    snapshotSha256: snapshotHash,
    proposalsSha256: proposalsHash,
    recomputeSha256: recomputeHash,
    snapshotAt: snapshot.audit.identity.snapshotAt,
    deployedCommitAtSnapshot: snapshot.release.commit,
    assignments,
    costs
  };
  return {
    version: 1,
    mode: 'OFFLINE_PREVIEW',
    databaseConnected: false,
    productionWrites: 0,
    planHash: sha256(canonicalJson(plan)),
    executableBatchHash: null,
    factsComplete: missingFacts.length === 0,
    missingFacts: [...new Set(missingFacts)],
    unassignedCashNetCny: format4(
      assignments.reduce(
        (sum, line) => sum + amount4(line.amountCny) * (line.direction === 'debit' ? 1n : -1n),
        0n
      )
    ),
    cashCostNetDeltaCny: format4(
      costs.reduce((sum, row) => sum + amount4(row.cashCarryingDeltaCny), 0n)
    ),
    costAdjustmentCount: costs.filter((row) => row.action === 'adjustment').length,
    costVerificationOnlyCount: costs.filter((row) => row.action === 'verification-only').length,
    plan,
    factsTemplate: template,
    nextStep:
      '补全事实后，以只读数据库生成完整源指纹和账户 CAS；离线 planHash 不是可执行 batchHash。'
  };
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      ![
        '--mode',
        '--snapshot',
        '--proposals',
        '--recompute',
        '--facts',
        '--output',
        '--operator-id',
        '--batch',
        '--approve-hash'
      ].includes(key) ||
      !value ||
      Object.hasOwn(options, key.slice(2))
    ) {
      fail('INVALID_ARGUMENTS');
    }
    options[key.slice(2)] = value;
  }
  return { mode: 'offline', ...options };
}

function loadBuiltRuntime() {
  try {
    const runtime = {
      ...require(path.join(projectRoot, 'apps/api/dist/common/prisma/prisma.service.js')),
      ...require(path.join(projectRoot, 'apps/api/dist/v2-auth/v2-identity.service.js')),
      ...require(path.join(projectRoot, 'apps/api/dist/v2-auth/system-super-admin.js')),
      ...require(path.join(projectRoot, 'apps/api/dist/id-business-v2/runtime/public-api.js')),
      ...require(path.join(projectRoot, 'apps/api/dist/id-business-v2/finance/public-api.js')),
      ...require(
        path.join(
          projectRoot,
          'apps/api/dist/id-business-v2/finance/persistence/id-business-v2-finance-command.repository.js'
        )
      ),
      ...require(
        path.join(
          projectRoot,
          'apps/api/dist/id-business-v2/finance/persistence/id-business-v2-historical-cash.repository.js'
        )
      )
    };
    for (const name of [
      'historicalCashBatchFingerprint',
      'historicalCashSourceFingerprint',
      'IdBusinessV2HistoricalCashService',
      'IdBusinessV2HistoricalCashRepository'
    ]) {
      if (typeof runtime[name] !== 'function') fail('CURRENT_API_BUILD_REQUIRED');
    }
    return runtime;
  } catch {
    fail('CURRENT_API_BUILD_REQUIRED');
  }
}

export async function readHistoricalCashOperator(client, runtime, userId) {
  if (!UUID.test(userId ?? '')) fail('OPERATOR_ID_REQUIRED');
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { status: true, deletedAt: true, v2AuthIdentity: { select: { enabled: true } } }
  });
  if (user?.status !== 'active' || user.deletedAt || !user.v2AuthIdentity?.enabled) {
    fail('ACTIVE_OPERATOR_REQUIRED');
  }
  if (!(await runtime.getSystemSuperAdminUserId(client)))
    fail('EXISTING_IDENTITY_BINDING_REQUIRED');
  const identityReadClient = {
    idBusinessV2ScopeVersion: client.idBusinessV2ScopeVersion,
    user: client.user,
    securitySetting: client.securitySetting,
    $transaction: () => fail('IDENTITY_INITIALIZATION_NOT_ALLOWED')
  };
  const operator = await new runtime.V2IdentityService(identityReadClient).getAuthenticatedUser(
    userId
  );
  if (
    operator.mustResetPassword ||
    (!operator.roles.includes('admin') &&
      !['finance.view', 'finance.post', 'finance.adjust'].every((code) =>
        operator.permissions.includes(code)
      ))
  ) {
    fail('FINANCE_OPERATOR_PERMISSION_REQUIRED');
  }
  return operator;
}

export async function runHistoricalCash(options) {
  if (!['offline', 'preview', 'execute'].includes(options.mode)) fail('INVALID_MODE');
  if (options.mode === 'execute') return executeFrozenBatch(options);
  const snapshot = loadJson(
    options.snapshot ?? path.join(auditRoot, 'production-readonly-history-report.json')
  );
  const proposals = loadJson(
    options.proposals ?? path.join(auditRoot, 'production-cost-recompute-adjustment-proposals.json')
  );
  const facts = options.facts ? loadJson(options.facts).data : undefined;
  const recompute = loadJson(
    options.recompute ?? path.join(auditRoot, 'production-cost-recompute-report.json')
  );
  const offline = buildOfflinePreview(
    snapshot.data,
    proposals.data,
    snapshot.hash,
    proposals.hash,
    facts,
    recompute.data,
    recompute.hash
  );
  if (options.mode === 'offline') return offline;
  if (!offline.factsComplete) fail('FACTS_REQUIRED_FOR_LIVE_PREVIEW');
  return createHistoricalCashLivePreview(options, offline, snapshot.data);
}

function normalizeSnapshotValue(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function assertMatchesSnapshot(journal, snapshot, runtime) {
  const original = snapshot.audit.journals.find((row) => row.id === journal.id);
  if (!original) fail('SOURCE_CHANGED_AFTER_SNAPSHOT');
  for (const [key, expected] of Object.entries(original)) {
    if (key !== 'cashCostEvidenceVersion' && normalizeSnapshotValue(journal[key]) !== expected) {
      fail('SOURCE_CHANGED_AFTER_SNAPSHOT');
    }
  }
  const originalLines = snapshot.audit.lines.filter((line) => line.journalId === journal.id);
  if (originalLines.length !== journal.lines.length) fail('SOURCE_CHANGED_AFTER_SNAPSHOT');
  for (const line of journal.lines) {
    const originalLine = originalLines.find((row) => row.id === line.id);
    if (!originalLine) fail('SOURCE_CHANGED_AFTER_SNAPSHOT');
    for (const [key, expected] of Object.entries(originalLine)) {
      const actual = ['amountOriginal', 'amountCny'].includes(key)
        ? runtime.Amount4.from(line[key].toString()).toFixed(4)
        : key === 'fxRateToCny'
          ? runtime.Rate8.from(line[key].toString()).toFixed(8)
          : normalizeSnapshotValue(key === 'fxSnapshotId' ? line.fxRateSnapshotId : line[key]);
      if (actual !== expected) fail('SOURCE_CHANGED_AFTER_SNAPSHOT');
    }
  }
}

function databaseUrlFor(mode) {
  const value = process.env[mode === 'preview' ? 'V2_DATA_INTEGRITY_DATABASE_URL' : 'DATABASE_URL'];
  if (!value || !/^mysql:\/\//i.test(value)) fail('MYSQL_CONFIGURATION_REQUIRED');
  return value;
}

export async function createHistoricalCashLivePreview(options, offline, snapshot) {
  const runtime = loadBuiltRuntime();
  const client = new runtime.PrismaService({ datasourceUrl: databaseUrlFor('preview') });
  try {
    await client.$connect();
    assertV2AuditConnectionReadOnly(await client.$queryRawUnsafe('SHOW GRANTS'));
    return await client.$transaction(
      async (tx) => {
        const operator = await readHistoricalCashOperator(tx, runtime, options['operator-id']);
        if (
          !(await tx.idBusinessV2FinanceSettings.findUnique({
            where: { id: 1 },
            select: { id: true }
          }))
        )
          fail('EXISTING_FINANCE_SETTINGS_REQUIRED');
        const sourceIds = new Set(
          [...offline.plan.assignments, ...offline.plan.costs].map((row) => row.sourceJournalId)
        );
        const sourceFingerprints = new Map();
        for (const id of sourceIds) {
          const journal = await tx.idBusinessV2FinanceJournal.findUnique({
            where: { id },
            include: { lines: { orderBy: { lineNo: 'asc' } } }
          });
          if (!journal) fail('SOURCE_CHANGED_AFTER_SNAPSHOT');
          assertMatchesSnapshot(journal, snapshot, runtime);
          sourceFingerprints.set(id, runtime.historicalCashSourceFingerprint(journal));
        }
        const accountIds = new Set([
          ...offline.plan.assignments.map((row) => row.targetAccountId),
          ...offline.plan.costs.map((row) => row.accountId)
        ]);
        const accounts = [];
        for (const accountId of [...accountIds].sort()) {
          const account = await tx.idBusinessV2FinanceAccount.findUnique({
            where: { id: accountId },
            select: {
              id: true,
              currency: true,
              status: true,
              updatedAt: true,
              currentBalance: true,
              currentBalanceCny: true
            }
          });
          if (!account || account.status !== 'active') fail('ACTIVE_TARGET_ACCOUNT_REQUIRED');
          if (offline.plan.costs.some((row) => row.accountId === accountId)) {
            const chain = await tx.idBusinessV2FinanceJournalLine.findMany({
              where: { accountCode: 'cash', financeAccountId: accountId },
              include: { journal: true }
            });
            assertHistoricalCashChainUnchanged(account, chain, snapshot);
          }
          for (const assignment of offline.plan.assignments.filter(
            (row) => row.targetAccountId === accountId
          )) {
            if (assignment.currency !== account.currency) fail('TARGET_ACCOUNT_CURRENCY_MISMATCH');
          }
          accounts.push({
            accountId,
            expectedUpdatedAt: account.updatedAt.toISOString(),
            expectedBalanceOriginal: runtime.Amount4.from(
              account.currentBalance.toString()
            ).toString(),
            expectedBalanceCny: runtime.Amount4.from(
              account.currentBalanceCny.toString()
            ).toString()
          });
        }
        const adjustments = [
          ...offline.plan.assignments.map((row) => ({
            kind: 'assign_unassigned_cash',
            sourceLineId: row.sourceLineId,
            sourceFingerprint: sourceFingerprints.get(row.sourceJournalId),
            targetAccountId: row.targetAccountId,
            evidenceReference: row.evidenceReference
          })),
          ...offline.plan.costs.map((row) => ({
            kind: 'restate_foreign_cash_cost',
            sourceLineId: row.sourceLineId,
            sourceFingerprint: sourceFingerprints.get(row.sourceJournalId),
            expectedBookCostCny: row.expectedBookCostCny,
            recomputedBookCostCny: row.recomputedBookCostCny,
            evidenceReference: row.evidenceReference
          }))
        ];
        const orderAttributions = [];
        for (const orderId of new Set(offline.plan.assignments.map((row) => row.sourceOrderId))) {
          const targets = new Set(
            offline.plan.assignments
              .filter((row) => row.sourceOrderId === orderId)
              .map((row) => row.targetAccountId)
          );
          if (targets.size !== 1) fail('ORDER_TARGET_SAME_ACCOUNT_REQUIRED');
          const original = snapshot.audit.orders.find((row) => row.id === orderId);
          const order = await tx.idBusinessV2Order.findUnique({
            where: { id: orderId },
            select: { updatedAt: true, receivedFinanceAccountId: true }
          });
          if (
            !order ||
            order.updatedAt.toISOString() !== original.updatedAt ||
            order.receivedFinanceAccountId !== null
          )
            fail('ORDER_CHANGED_AFTER_SNAPSHOT');
          orderAttributions.push({
            orderId,
            expectedUpdatedAt: original.updatedAt,
            targetAccountId: [...targets][0]
          });
        }
        const command = {
          idempotencyKey: `historical_cash:${offline.planHash}`,
          reason: '历史现金归属与外币账面成本核对后的批次调整',
          evidenceReference: `reconciliation:${offline.planHash}`,
          accounts,
          adjustments,
          orderAttributions
        };
        return {
          version: 1,
          mode: 'LIVE_READONLY_PREVIEW',
          productionWrites: 0,
          planHash: offline.planHash,
          batchHash: runtime.historicalCashBatchFingerprint(command),
          operatorId: operator.id,
          command,
          sourceSnapshotSha256: offline.plan.snapshotSha256,
          factsComplete: true
        };
      },
      { isolationLevel: 'RepeatableRead', timeout: 120_000 }
    );
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}

export function validateFrozenBatch(frozen, approvedHash, batchFingerprint) {
  if (
    !frozen ||
    frozen.mode !== 'LIVE_READONLY_PREVIEW' ||
    frozen.factsComplete !== true ||
    !HASH.test(approvedHash ?? '') ||
    approvedHash !== frozen.batchHash ||
    batchFingerprint(frozen.command) !== frozen.batchHash
  ) {
    fail('APPROVED_FROZEN_BATCH_REQUIRED');
  }
}

async function executeFrozenBatch(options) {
  if (!options.batch) fail('APPROVED_FROZEN_BATCH_REQUIRED');
  const frozen = loadJson(options.batch).data;
  return executeHistoricalCashFrozenBatch(frozen, options['approve-hash'], options['operator-id']);
}

export async function executeHistoricalCashFrozenBatch(frozen, approvedHash, operatorId) {
  const runtime = loadBuiltRuntime();
  validateFrozenBatch(frozen, approvedHash, runtime.historicalCashBatchFingerprint);
  if (operatorId !== frozen.operatorId) fail('FROZEN_OPERATOR_MISMATCH');
  const client = new runtime.PrismaService({ datasourceUrl: databaseUrlFor('execute') });
  try {
    await client.$connect();
    const operator = await readHistoricalCashOperator(client, runtime, operatorId);
    const commandRepo = new runtime.IdBusinessV2FinanceCommandRepository();
    const service = new runtime.IdBusinessV2HistoricalCashService(
      new runtime.V2CommandTransactionManager(client),
      new runtime.IdBusinessV2HistoricalCashRepository(),
      commandRepo,
      new runtime.IdBusinessV2FinancePostingService(commandRepo),
      new runtime.V2TransactionalAuditService()
    );
    const result = await service.execute(frozen.command, operator);
    return {
      version: 1,
      mode: 'EXECUTED',
      batchHash: result.batchHash,
      adjustmentJournalIds: result.adjustmentJournalIds,
      replayed: result.replayed,
      committedAdjustmentJournalCount: result.adjustmentJournalIds.length,
      productionExecution: 'CALLER_RUNTIME_NOT_INFERRED'
    };
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}

async function main() {
  let descriptor;
  try {
    const options = parseArgs(process.argv.slice(2));
    const output = resolveProjectFile(
      options.output ?? path.join(auditRoot, `historical-cash-runner-${options.mode}.json`),
      true
    );
    descriptor = openSync(output, 'wx', 0o600);
    const result = await runHistoricalCash(options);
    writeFileSync(descriptor, `${JSON.stringify(result, null, 2)}\n`);
    console.log(
      JSON.stringify({
        ok: true,
        mode: result.mode,
        output,
        planHash: result.planHash ?? null,
        batchHash: result.batchHash ?? null,
        replayed: result.replayed ?? null,
        committedAdjustmentJournalCount: result.committedAdjustmentJournalCount ?? 0
      })
    );
  } catch (error) {
    const safeError = { ok: false, code: error?.runnerCode ?? 'HISTORICAL_CASH_RUNNER_FAILED' };
    if (descriptor !== undefined) writeFileSync(descriptor, `${JSON.stringify(safeError)}\n`);
    console.error(JSON.stringify(safeError));
    process.exitCode = 1;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
