import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  assertV2AuditConnectionReadOnly,
  V2_DATA_INTEGRITY_CHECKS
} from './lib/v2-data-integrity-audit.mjs';
import { projectRoot, sha256 } from './historical-cash-runner.mjs';

const require = createRequire(import.meta.url);
const rootUrl = process.env.V2_FINANCIAL_INTEGRITY_DATABASE_URL;
const auditorUrl = process.env.V2_DATA_INTEGRITY_DATABASE_URL;

function assertDisposableUrl(value) {
  const url = new URL(value);
  assert.equal(url.protocol, 'mysql:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/id_business_v2_financial_integrity_\d+$/);
  return url;
}

test(
  'real CLI readonly preview, database identity, atomic execute, replay and stale cash-chain rejection',
  { skip: !rootUrl || !auditorUrl, timeout: 120_000 },
  async () => {
    const writeTarget = assertDisposableUrl(rootUrl);
    const readTarget = assertDisposableUrl(auditorUrl);
    assert.equal(writeTarget.port, readTarget.port);
    assert.equal(writeTarget.pathname, readTarget.pathname);
    const { PrismaService } = require('../apps/api/dist/common/prisma/prisma.service.js');
    const { Amount4 } = require('../apps/api/dist/id-business-v2/runtime/public-api.js');
    const {
      createHistoricalCashMysqlFixtures
    } = require('../apps/api/dist/id-business-v2/finance/persistence/historical-cash-mysql.fixtures.js');
    const { SYSTEM_SUPER_ADMIN_KEY } = require('../apps/api/dist/v2-auth/system-super-admin.js');
    const client = new PrismaService({ datasourceUrl: rootUrl });
    const reader = new PrismaService({ datasourceUrl: auditorUrl });
    const fixtureRoot = path.join(projectRoot, '.codex-audit/financial-closure-20261004');
    mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(path.join(fixtureRoot, 'historical-cash-runner-mysql-fixtures-'));
    const save = (name, value) => {
      const file = path.join(directory, name);
      const text = `${JSON.stringify(value, null, 2)}\n`;
      writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
      return { file, text, hash: sha256(text) };
    };
    const fixed = (value, scale) => {
      const [integer, decimals = ''] = String(value).split('.');
      return `${integer}.${decimals.padEnd(scale, '0')}`;
    };
    const invoke = (args, expectedCode) => {
      const child = spawnSync(process.execPath, ['scripts/historical-cash-runner.mjs', ...args], {
        cwd: projectRoot,
        env: { ...process.env, DATABASE_URL: rootUrl, V2_DATA_INTEGRITY_DATABASE_URL: auditorUrl },
        encoding: 'utf8',
        timeout: 30_000
      });
      if (expectedCode) {
        assert.equal(child.status, 1);
        assert.equal(JSON.parse(child.stderr).code, expectedCode);
      } else {
        assert.equal(child.status, 0, child.stderr);
        assert.equal(JSON.parse(child.stdout).ok, true);
      }
    };
    try {
      await client.$connect();
      await reader.$connect();
      assertV2AuditConnectionReadOnly(await reader.$queryRawUnsafe('SHOW GRANTS'));
      const accountIds = [];
      const orderIds = [];
      const prepared = await createHistoricalCashMysqlFixtures(client, accountIds, orderIds);
      const operatorId = prepared.operator.id;
      const bindingBefore = await client.securitySetting.findUnique({
        where: { key: SYSTEM_SUPER_ADMIN_KEY }
      });
      if (!bindingBefore)
        await client.securitySetting.create({
          data: {
            key: SYSTEM_SUPER_ADMIN_KEY,
            value: { userId: operatorId },
            remark: '本机一次性数据库合成身份绑定',
            updatedByUserId: operatorId
          }
        });
      const binding = await client.securitySetting.findUnique({
        where: { key: SYSTEM_SUPER_ADMIN_KEY }
      });
      const fixtures = prepared.fixtures;
      const opening = async (account) => {
        if (
          await client.idBusinessV2FinanceJournal.findFirst({
            where: { sourceType: 'opening_balance', sourceId: account.id }
          })
        )
          return;
        await client.idBusinessV2FinanceJournal.create({
          data: {
            journalNo: `CLI-OPEN-${randomUUID().slice(0, 26)}`,
            journalType: 'opening_balance',
            sourceType: 'opening_balance',
            sourceId: account.id,
            businessDate: new Date('2026-08-01'),
            periodMonth: '2026-08',
            occurredAt: new Date('2026-08-01T00:00:00Z'),
            summary: '合成 CLI 期初账',
            idempotencyKey: randomUUID(),
            createdByUserId: operatorId,
            lines: {
              create: [
                {
                  lineNo: 1,
                  accountCode: 'cash',
                  direction: 'debit',
                  currency: account.currency,
                  amountOriginal: account.openingBalance,
                  amountCny: account.openingBalanceCny,
                  fxRateToCny: Amount4.from(account.openingBalanceCny.toString())
                    .ratio(account.openingBalance.toString())
                    .toString(),
                  financeAccountId: account.id
                },
                {
                  lineNo: 2,
                  accountCode: 'opening_equity',
                  direction: 'credit',
                  currency: 'CNY',
                  amountOriginal: account.openingBalanceCny,
                  amountCny: account.openingBalanceCny,
                  fxRateToCny: '1'
                }
              ]
            }
          }
        });
      };
      const snapshot = async (accounts, sources, orders = []) =>
        reader.$transaction(
          async (tx) => {
            const accountRows = await tx.idBusinessV2FinanceAccount.findMany({
              where: { id: { in: accounts.map((row) => row.id) } }
            });
            const journals = await tx.idBusinessV2FinanceJournal.findMany({
              where: {
                OR: [
                  { id: { in: sources.map((row) => row.id) } },
                  {
                    lines: {
                      some: {
                        accountCode: 'cash',
                        financeAccountId: { in: accounts.map((row) => row.id) }
                      }
                    }
                  }
                ]
              },
              include: { lines: true }
            });
            return {
              mode: 'SYNTHETIC_LOCAL_DISPOSABLE_DATABASE_SNAPSHOT',
              release: { commit: 'f'.repeat(40) },
              audit: {
                readOnlyPrivilegeVerified: true,
                identity: { snapshotAt: new Date().toISOString() },
                accounts: accountRows.map((row) => ({
                  id: row.id,
                  currency: row.currency,
                  status: row.status,
                  currentBalance: fixed(row.currentBalance, 4),
                  currentBalanceCny: fixed(row.currentBalanceCny, 4),
                  updatedAt: row.updatedAt.toISOString()
                })),
                journals: journals.map((row) => ({
                  id: row.id,
                  journalNo: row.journalNo,
                  journalType: row.journalType,
                  sourceType: row.sourceType,
                  sourceId: row.sourceId,
                  status: row.status,
                  reversalOfJournalId: row.reversalOfJournalId,
                  occurredAt: row.occurredAt.toISOString(),
                  createdAt: row.createdAt.toISOString(),
                  businessDate: row.businessDate.toISOString(),
                  cashCostEvidenceVersion: null
                })),
                lines: journals.flatMap((row) =>
                  row.lines.map((line) => ({
                    id: line.id,
                    journalId: line.journalId,
                    lineNo: line.lineNo,
                    accountCode: line.accountCode,
                    direction: line.direction,
                    currency: line.currency,
                    amountOriginal: fixed(line.amountOriginal, 4),
                    amountCny: fixed(line.amountCny, 4),
                    fxRateToCny: fixed(line.fxRateToCny, 8),
                    financeAccountId: line.financeAccountId,
                    supplierAccountId: line.supplierAccountId,
                    fxSnapshotId: line.fxRateSnapshotId,
                    createdAt: line.createdAt.toISOString()
                  }))
                ),
                orders: orders.map((row) => ({
                  id: row.id,
                  orderNo: row.orderNo,
                  updatedAt: row.updatedAt.toISOString()
                }))
              }
            };
          },
          { isolationLevel: 'RepeatableRead' }
        );
      const prepareInputs = async (prefix, accounts, sources, orders, costs) => {
        const evidence = 'synthetic-cli-source-reconciled';
        const snap = save(`${prefix}-snapshot.json`, await snapshot(accounts, sources, orders));
        const cashAssignments = sources
          .filter((row) => row.sourceType === 'order')
          .map((row) => ({
            sourceLineId: row.lines.find((line) => line.accountCode === 'cash').id,
            sourceJournalId: row.id,
            sourceId: row.sourceId,
            amountOriginal: fixed(row.lines[0].amountOriginal, 4),
            amountCny: fixed(row.lines[0].amountCny, 4)
          }));
        const costRows = costs.map(({ source, account, recomputed }) => ({
          cashLineId: source.lines[0].id,
          financeAccountId: account.id,
          journalId: source.id,
          journalStatus: source.status,
          currency: account.currency,
          oldCashCostCny: fixed(source.lines[0].amountCny, 4),
          weightedNewCashCostCny: recomputed,
          cashCarryingDeltaCny: fixed(source.lines[0].amountCny.sub(recomputed), 4)
        }));
        const props = save(`${prefix}-proposals.json`, {
          sourceFileSha256: snap.hash,
          unboundCashReclassificationCandidates: cashAssignments,
          cashCostAdjustments: costRows
            .filter((row) => row.cashCarryingDeltaCny !== '0.0000')
            .map((row) => ({
              sourceLineId: row.cashLineId,
              casAccount: { id: row.financeAccountId },
              cashCarryingDeltaCny: row.cashCarryingDeltaCny
            }))
        });
        const recompute = save(`${prefix}-recompute.json`, {
          provenance: { sourceFileSha256: snap.hash },
          foreignExpenseCandidates: costRows
        });
        const facts = save(`${prefix}-facts.json`, {
          version: 1,
          orders: orders.map((row) => ({
            orderId: row.id,
            targetAccountId: accounts.find((row) => row.currency === 'CNY').id,
            classification: 'real',
            duplicatePostingAbsent: true,
            openingIncludesTheseMovements: false,
            evidenceReference: evidence,
            lineAccountOverrides: []
          })),
          costs: {
            realOperationsConfirmed: true,
            openingAndLedgerReconciled: true,
            priorCorrectionsAbsent: true,
            evidenceReference: evidence
          }
        });
        return [
          '--snapshot',
          snap.file,
          '--proposals',
          props.file,
          '--recompute',
          recompute.file,
          '--facts',
          facts.file,
          '--operator-id',
          operatorId
        ];
      };
      const cny = await fixtures.account('CNY', '1000');
      const usdt = await fixtures.account('USDT', '99', '694', '100', '700');
      const myr = await fixtures.account('MYR', '99', '198', '100', '200');
      await opening(cny);
      await opening(usdt);
      await opening(myr);
      const order = await fixtures.order('completed', '100');
      const cash = await fixtures.source('100', 'debit', order.id);
      const oldExpense = await fixtures.expenseSource(usdt, '1', '6');
      const zeroExpense = await fixtures.expenseSource(myr, '1', '2');
      const sources = [cash, oldExpense, zeroExpense];
      const originalSources = JSON.stringify(sources);
      const originalExpenses = JSON.stringify(
        await client.idBusinessV2FinanceExpense.findMany({
          where: { journalId: { in: [oldExpense.id, zeroExpense.id] } },
          orderBy: { id: 'asc' }
        })
      );
      const args = await prepareInputs(
        'closed',
        [cny, usdt, myr],
        sources,
        [order],
        [
          { source: oldExpense, account: usdt, recomputed: '7.0000' },
          { source: zeroExpense, account: myr, recomputed: '2.0000' }
        ]
      );
      const previewFile = path.join(directory, 'live-preview.json');
      invoke(['--mode', 'preview', ...args, '--output', previewFile]);
      const preview = JSON.parse(readFileSync(previewFile));
      assert.equal(preview.mode, 'LIVE_READONLY_PREVIEW');
      assert.equal(preview.operatorId, operatorId);
      assert.equal(preview.command.adjustments.length, 3);
      assert.equal(preview.productionWrites, 0);
      const firstFile = path.join(directory, 'executed.json');
      const executeArgs = [
        '--mode',
        'execute',
        '--batch',
        previewFile,
        '--approve-hash',
        preview.batchHash,
        '--operator-id',
        operatorId
      ];
      invoke([...executeArgs, '--output', firstFile]);
      const first = JSON.parse(readFileSync(firstFile));
      assert.equal(first.replayed, false);
      assert.equal(first.adjustmentJournalIds.length, 2);
      const balances = await client.idBusinessV2FinanceAccount.findMany({
        where: { id: { in: [cny.id, usdt.id, myr.id] } },
        orderBy: { id: 'asc' }
      });
      assert.equal(balances.find((row) => row.id === cny.id).currentBalance.toString(), '1100');
      assert.equal(balances.find((row) => row.id === usdt.id).currentBalanceCny.toString(), '693');
      assert.equal(balances.find((row) => row.id === myr.id).currentBalanceCny.toString(), '198');
      assert.equal(
        (await client.idBusinessV2Order.findUnique({ where: { id: order.id } }))
          .receivedFinanceAccountId,
        cny.id
      );
      const countBeforeReplay = {
        journals: await client.idBusinessV2FinanceJournal.count(),
        audits: await client.auditLog.count()
      };
      const replayFile = path.join(directory, 'replayed.json');
      invoke([...executeArgs, '--output', replayFile]);
      const replay = JSON.parse(readFileSync(replayFile));
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.adjustmentJournalIds, first.adjustmentJournalIds);
      assert.equal(
        JSON.stringify(
          await client.idBusinessV2FinanceAccount.findMany({
            where: { id: { in: [cny.id, usdt.id, myr.id] } },
            orderBy: { id: 'asc' }
          })
        ),
        JSON.stringify(balances)
      );
      assert.deepEqual(
        {
          journals: await client.idBusinessV2FinanceJournal.count(),
          audits: await client.auditLog.count()
        },
        countBeforeReplay
      );
      const afterSources = await Promise.all(
        sources.map((row) =>
          client.idBusinessV2FinanceJournal.findUnique({
            where: { id: row.id },
            include: { lines: { orderBy: { lineNo: 'asc' } }, reversedBy: true }
          })
        )
      );
      assert.equal(JSON.stringify(afterSources), originalSources);
      assert.equal(
        JSON.stringify(
          await client.idBusinessV2FinanceExpense.findMany({
            where: { journalId: { in: [oldExpense.id, zeroExpense.id] } },
            orderBy: { id: 'asc' }
          })
        ),
        originalExpenses
      );
      const journalIds = [...sources.map((row) => row.id), ...first.adjustmentJournalIds];
      const auditLines = await client.idBusinessV2FinanceJournalLine.findMany({
        where: { journalId: { in: journalIds } }
      });
      const relevant = new Set([
        ...journalIds,
        ...[cny, usdt, myr].map((row) => row.id),
        ...auditLines.map((row) => row.id),
        ...auditLines.map((row) => `${row.journalId}:${row.financeAccountId ?? 'unassigned'}`)
      ]);
      for (const code of [
        'finance_cash_source_currency_mismatch',
        'cash_historical_cost_evidence_mismatch',
        'historical_cash_adjustment_integrity_mismatch',
        'finance_account_balance_mismatch'
      ]) {
        const rule = V2_DATA_INTEGRITY_CHECKS.find((row) => row.code === code);
        assert.ok(rule);
        const actualRows = await reader.$queryRawUnsafe(rule.sql);
        assert.deepEqual(
          actualRows.filter((row) => relevant.has(row.entity_id)),
          [],
          code
        );
      }
      const staleAccount = await fixtures.account('USDT', '99', '694', '100', '700');
      await opening(staleAccount);
      const staleExpense = await fixtures.expenseSource(staleAccount, '1', '6');
      const staleArgs = await prepareInputs(
        'stale',
        [staleAccount],
        [staleExpense],
        [],
        [{ source: staleExpense, account: staleAccount, recomputed: '7.0000' }]
      );
      const {
        IdBusinessV2FinancePostingService
      } = require('../apps/api/dist/id-business-v2/finance/id-business-v2-finance-posting.service.js');
      const {
        IdBusinessV2FinanceCommandRepository
      } = require('../apps/api/dist/id-business-v2/finance/persistence/id-business-v2-finance-command.repository.js');
      const posting = new IdBusinessV2FinancePostingService(
        new IdBusinessV2FinanceCommandRepository()
      );
      await client.$transaction((tx) =>
        posting.post(tx, {
          journalType: 'manual_operating_income',
          sourceType: 'manual',
          sourceId: randomUUID(),
          occurredAt: new Date(),
          summary: '合成后续现金流',
          idempotencyKey: randomUUID(),
          lines: [
            {
              accountCode: 'cash',
              direction: 'debit',
              currency: 'USDT',
              amountOriginal: '1',
              amountCny: '7',
              fxRateToCny: '7',
              financeAccountId: staleAccount.id
            },
            {
              accountCode: 'sales_revenue',
              direction: 'credit',
              currency: 'CNY',
              amountOriginal: '7',
              amountCny: '7',
              fxRateToCny: '1'
            }
          ]
        })
      );
      invoke(
        [
          '--mode',
          'preview',
          ...staleArgs,
          '--output',
          path.join(directory, 'stale-rejected.json')
        ],
        'SOURCE_CHAIN_CHANGED'
      );
      assert.equal(
        JSON.stringify(
          await client.idBusinessV2FinanceJournal.findUnique({
            where: { id: staleExpense.id },
            include: { lines: { orderBy: { lineNo: 'asc' } }, reversedBy: true }
          })
        ),
        JSON.stringify(staleExpense)
      );
      assert.equal(
        JSON.stringify(
          await client.securitySetting.findUnique({ where: { key: SYSTEM_SUPER_ADMIN_KEY } })
        ),
        JSON.stringify(binding)
      );
      save('result.json', {
        ok: true,
        mode: 'REAL_LOCAL_DISPOSABLE_MYSQL_CLI_ACCEPTANCE',
        actorReadFromDatabase: true,
        sourceJournalsUnchanged: true,
        expenseAmountsUnchanged: true,
        existingIdentityBindingUnchanged: true,
        adjustmentJournalCount: 2,
        verificationOnlyCount: 1,
        replayedWithoutDuplicateFinancialWrites: true,
        staleChainPreviewRejected: true,
        targetedActualSqlChecks: 4,
        productionWrites: 0
      });
      console.log(
        JSON.stringify({ historicalCashCliMysqlResult: path.join(directory, 'result.json') })
      );
    } finally {
      await reader.$disconnect().catch(() => undefined);
      await client.$disconnect().catch(() => undefined);
    }
  }
);
