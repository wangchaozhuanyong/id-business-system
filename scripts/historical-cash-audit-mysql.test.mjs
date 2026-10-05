import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { V2_DATA_INTEGRITY_CHECKS } from './lib/v2-data-integrity-audit.mjs';

const databaseUrl = process.env.V2_FINANCIAL_INTEGRITY_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1', '历史巡检反例仅允许本机隔离数据库');
  assert.match(url.pathname, /^\/id_business_v2_financial_integrity_\d+$/);
}
const client = databaseUrl ? new PrismaClient({ datasourceUrl: databaseUrl }) : null;
after(async () => client?.$disconnect());
const key = () => randomUUID();
const stamp = new Date('2026-08-28T08:00:00Z');
const rollback = Symbol('synthetic fixture rollback');
const ruleCodes = {
  cash: 'finance_cash_source_currency_mismatch',
  cost: 'cash_historical_cost_evidence_mismatch',
  proof: 'historical_cash_adjustment_integrity_mismatch'
};

async function inFixture(work) {
  await assert.rejects(
    client.$transaction(
      async (tx) => {
        await work(tx);
        throw rollback;
      },
      { timeout: 120000 }
    ),
    (error) => error === rollback
  );
}

function fingerprint(journal, line) {
  return createHash('sha256')
    .update(
      [
        journal.id,
        journal.sourceType,
        journal.sourceId ?? '',
        line.id,
        line.lineNo,
        line.accountCode,
        line.direction,
        line.currency,
        line.amountOriginal.toFixed(4),
        line.fxRateToCny.toFixed(8),
        line.amountCny.toFixed(4),
        line.financeAccountId ?? '',
        line.supplierAccountId ?? '',
        line.fxRateSnapshotId ?? ''
      ].join('|')
    )
    .digest('hex');
}

async function scan(tx, code, ids) {
  const rule = V2_DATA_INTEGRITY_CHECKS.find((item) => item.code === ruleCodes[code]);
  assert.ok(rule);
  const result = await tx.$queryRawUnsafe(rule.sql);
  return result.map((row) => row.entity_id).filter((id) => ids.includes(id));
}

async function fixture(tx, variant = {}) {
  const foreign = variant.kind !== 'assign';
  const currency = foreign ? 'USDT' : 'CNY';
  const cost = variant.kind === 'verify' ? '65' : foreign ? '70' : '1350';
  const quantity = foreign ? '10' : '1350';
  const sourceRate = cost === '65' ? '6.5' : foreign ? '7' : '1';
  const user = await tx.user.create({
    data: {
      username: `sql-proof-${key()}`,
      displayName: '合成巡检凭证',
      passwordHash: 'synthetic-only'
    }
  });
  const account = await tx.idBusinessV2FinanceAccount.create({
    data: {
      name: `合成现金核对 ${key()}`,
      accountType: 'bank',
      currency,
      openingBalance: foreign ? '1000' : '0',
      openingBalanceCny: foreign ? '6500' : '0',
      currentBalance: foreign ? (variant.duplicateCash ? '980' : '990') : quantity,
      currentBalanceCny: foreign ? (variant.duplicateCash ? '6365' : '6435') : cost
    }
  });
  const sourceId = key();
  const source = await tx.idBusinessV2FinanceJournal.create({
    data: {
      journalNo: `SQL-${key().slice(0, 28)}`,
      journalType: foreign ? 'expense' : 'manual_operating_income',
      sourceType: foreign ? 'expense' : 'manual',
      sourceId,
      status: variant.reverse ? 'reversed' : 'posted',
      businessDate: stamp,
      periodMonth: '2026-08',
      occurredAt: stamp,
      summary: '合成旧账来源',
      idempotencyKey: `sql-source:${key()}`,
      createdByUserId: user.id,
      ...(variant.metadataVersion === undefined
        ? {}
        : { metadata: { cashHistoricalCost: { version: variant.metadataVersion } } }),
      lines: {
        create: [
          {
            lineNo: 1,
            accountCode: 'cash',
            direction: foreign ? 'credit' : 'debit',
            currency,
            amountOriginal: quantity,
            amountCny: cost,
            fxRateToCny: sourceRate,
            financeAccountId: foreign ? account.id : null
          },
          {
            lineNo: 2,
            accountCode: foreign ? 'operating_expense' : 'sales_revenue',
            direction: foreign ? 'debit' : 'credit',
            currency,
            amountOriginal: variant.duplicateCash ? '20' : quantity,
            amountCny: variant.duplicateCash ? '140' : cost,
            fxRateToCny: sourceRate
          },
          ...(variant.duplicateCash
            ? [
                {
                  lineNo: 3,
                  accountCode: 'cash',
                  direction: 'credit',
                  currency,
                  amountOriginal: quantity,
                  amountCny: cost,
                  fxRateToCny: sourceRate,
                  financeAccountId: account.id
                }
              ]
            : [])
        ]
      }
    },
    include: { lines: { orderBy: { lineNo: 'asc' } } }
  });
  if (foreign && !variant.noExpense) {
    const category = await tx.idBusinessV2Option.create({
      data: {
        type: 'expense_category',
        code: key(),
        uniqueKey: key(),
        name: '合成开支类别'
      }
    });
    await tx.idBusinessV2FinanceExpense.create({
      data: {
        id: sourceId,
        journalId: source.id,
        categoryOptionId: category.id,
        categoryNameSnapshot: category.name,
        financeAccountId: account.id,
        financeAccountNameSnapshot: account.name,
        currency,
        amountOriginal: quantity,
        amountCny: variant.wrongExpense ? '71' : cost,
        fxRateToCny: sourceRate,
        occurredAt: stamp,
        idempotencyKey: `sql-expense:${key()}`
      }
    });
  }
  const original = source.lines[0];
  const batchKey = `sql-batch:${key()}`;
  const batchHash = 'a'.repeat(64);
  const kind = foreign ? 'restate_foreign_cash_cost' : 'assign_unassigned_cash';
  const metadata = {
    version: 1,
    kind,
    originalJournalId: source.id,
    originalLineId: original.id,
    sourceFingerprint: 'b'.repeat(64),
    sourceLineFingerprint: variant.badFingerprint ? 'c'.repeat(64) : fingerprint(source, original),
    targetAccountId: account.id,
    batchHash,
    idempotencyKey: batchKey,
    batchSize: 1,
    evidenceReference: 'synthetic-sql-proof',
    ...(foreign ? { expectedBookCostCny: cost, recomputedBookCostCny: '65' } : {})
  };
  let correction;
  if (variant.kind === 'verify') {
    await tx.auditLog.create({
      data: {
        userId: user.id,
        module: 'id_business_v2_finance',
        action: 'id_business_v2.historical_cash.verify',
        objectId: original.id,
        afterData: { ...metadata, recomputedBookCostCny: variant.wrongAmount ? '64' : cost }
      }
    });
  } else {
    correction = await tx.idBusinessV2FinanceJournal.create({
      data: {
        journalNo: `SQL-${key().slice(0, 28)}`,
        journalType: 'manual_adjustment',
        sourceType: 'historical_backfill',
        sourceId: original.id,
        status: variant.reverse === 'complete' ? 'reversed' : 'posted',
        businessDate: new Date(),
        periodMonth: new Date().toISOString().slice(0, 7),
        occurredAt: new Date(),
        summary: '合成现金补偿',
        idempotencyKey: `historical_cash:${kind}:${original.id}`,
        metadata: { historicalCashAdjustment: metadata },
        createdByUserId: user.id,
        lines: {
          create: foreign
            ? [
                {
                  lineNo: 1,
                  accountCode: 'cash',
                  direction: 'debit',
                  currency,
                  amountOriginal: '0',
                  amountCny: '5',
                  fxRateToCny: '1',
                  financeAccountId: account.id
                },
                {
                  lineNo: 2,
                  accountCode: 'realized_fx_gain_loss',
                  direction: variant.wrongDirection ? 'debit' : 'credit',
                  currency: 'CNY',
                  amountOriginal: '5',
                  amountCny: '5',
                  fxRateToCny: '1',
                  financeAccountId: account.id
                }
              ]
            : [
                {
                  lineNo: 1,
                  accountCode: 'cash',
                  direction: 'debit',
                  currency,
                  amountOriginal: quantity,
                  amountCny: cost,
                  fxRateToCny: '1',
                  financeAccountId: account.id
                },
                {
                  lineNo: 2,
                  accountCode: 'cash',
                  direction: 'credit',
                  currency,
                  amountOriginal: variant.wrongAmount ? '1349' : quantity,
                  amountCny: cost,
                  fxRateToCny: '1'
                }
              ]
        }
      },
      include: { lines: { orderBy: { lineNo: 'asc' } } }
    });
  }
  if (!variant.noReceipt) {
    await tx.auditLog.create({
      data: {
        userId: user.id,
        module: 'id_business_v2_finance',
        action: 'id_business_v2.historical_cash.execute',
        objectId: key(),
        afterData: {
          version: 1,
          idempotencyKey: batchKey,
          batchHash,
          batchSize: 1,
          sourceLineIds: [original.id],
          adjustmentJournalIds: correction ? [correction.id] : [],
          verifiedSourceLineIds: correction ? [] : [original.id]
        }
      }
    });
  }
  if (variant.reverse) {
    for (const journal of variant.reverse === 'complete' ? [source, correction] : [source]) {
      await tx.idBusinessV2FinanceJournal.create({
        data: {
          journalNo: `SQL-${key().slice(0, 28)}`,
          journalType: 'reversal',
          sourceType: 'manual',
          sourceId: journal.id,
          reversalOfJournalId: journal.id,
          businessDate: new Date(),
          periodMonth: new Date().toISOString().slice(0, 7),
          occurredAt: new Date(),
          summary: '合成精确镜像',
          idempotencyKey: `sql-reverse:${journal.id}`,
          lines: {
            create: journal.lines.map((line) => ({
              lineNo: line.lineNo,
              accountCode: line.accountCode,
              direction: line.direction === 'debit' ? 'credit' : 'debit',
              currency: line.currency,
              amountOriginal: line.amountOriginal,
              amountCny: line.amountCny,
              fxRateToCny: line.fxRateToCny,
              financeAccountId: line.financeAccountId,
              supplierAccountId: line.supplierAccountId,
              fxRateSnapshotId: line.fxRateSnapshotId
            }))
          }
        }
      });
    }
  }
  return { source, original, correction, account };
}

for (const [name, variant, expected] of [
  ['精确现金归属加真实批次凭证闭合原行及空账户抵销行', { kind: 'assign' }, false],
  ['缺批次凭证不能靠metadata关闭原现金缺口', { kind: 'assign', noReceipt: true }, true],
  ['错误原行fingerprint仍命中现金与补偿检查', { kind: 'assign', badFingerprint: true }, true],
  ['不精确的空账户抵销行仍命中现金与补偿检查', { kind: 'assign', wrongAmount: true }, true],
  ['真实原费用与精确成本补偿闭合旧成本依据', { kind: 'cost' }, false],
  ['错误汇兑方向不能关闭旧成本依据', { kind: 'cost', wrongDirection: true }, true],
  ['没有真实原费用不能仅凭expense标签关闭旧成本依据', { kind: 'cost', noExpense: true }, true],
  ['原费用冻结金额与分录不符仍命中', { kind: 'cost', wrongExpense: true }, true],
  ['已有字符串版本不能被当作legacy成本缺口', { kind: 'cost', metadataVersion: '1' }, true],
  ['已有未知版本不能被当作legacy成本缺口', { kind: 'cost', metadataVersion: 2 }, true],
  ['双现金支出只补一行仍检出整组旧成本缺口', { kind: 'cost', duplicateCash: true }, true],
  ['同额成本审计核对不造零金额凭证', { kind: 'verify' }, false],
  ['同额核对缺已提交批次凭证仍命中', { kind: 'verify', noReceipt: true }, true],
  ['非同额核对不能被当作同额成本审计', { kind: 'verify', wrongAmount: true }, true],
  ['原费用及补偿均精确冲销才闭合成本链', { kind: 'cost', reverse: 'complete' }, false],
  ['仅冲销原费用仍检出补偿残留', { kind: 'cost', reverse: 'incomplete' }, true]
]) {
  test(name, { skip: !client }, async () =>
    inFixture(async (tx) => {
      const { source, original, correction, account } = await fixture(tx, variant);
      const originalIds =
        variant.kind === 'assign' ? [original.id] : [`${source.id}:${account.id}`];
      if (variant.reverse !== 'incomplete') {
        const hits = await scan(tx, variant.kind === 'assign' ? 'cash' : 'cost', originalIds);
        assert.equal(hits.length > 0, expected);
      }
      if (correction) {
        const hits = await scan(tx, 'proof', [correction.id]);
        assert.equal(hits.length > 0, expected);
      }
    })
  );
}
