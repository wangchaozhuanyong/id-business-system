// 仅由既有远端 CI 的专属隔离 MySQL 入口调用，不连接生产或本机开发数据库。
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { V2_ONLINE_RECHARGE_INTEGRITY_CHECKS as checks } from './lib/v2-online-recharge-integrity.mjs';
import { buildV2DataIntegrityCheckQuery } from './lib/v2-data-integrity-audit.mjs';

const connection =
  process.env.V2_FINANCIAL_INTEGRITY_DATABASE_URL ??
  (process.env.ONLINE_RECHARGE_MYSQL_TEST === '1' ? process.env.DATABASE_URL : undefined);
test('独立代充十一条 SQL 的隔离 MySQL 正反例', { skip: !connection }, async (t) => {
  const url = new URL(connection);
  assert.equal(url.protocol, 'mysql:');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.match(
    url.pathname.slice(1),
    /^(?:id_business_v2_financial_integrity_\d+|online_recharge_test[A-Za-z0-9_]*|id_business_v2_online_recharge_fixture)$/
  );
  const db = new PrismaClient({ datasourceUrl: connection });
  const rollback = new Error('EXPECTED_FIXTURE_ROLLBACK');
  async function scenario(mutate, expected) {
    const expectedCodes = new Set(Array.isArray(expected) ? expected : expected ? [expected] : []);
    try {
      await db.$transaction(
        async (tx) => {
          await tx.onlineRechargeBill.deleteMany();
          await tx.onlineRechargeTask.deleteMany();
          const task = await tx.onlineRechargeTask.create({
            data: {
              id: randomUUID(),
              message: '合成对账任务',
              status: 'succeeded',
              confirmedPaid: true
            }
          });
          const bill = await tx.onlineRechargeBill.create({
            data: {
              taskId: task.id,
              plan: 'plus',
              status: 'success',
              amount: '20.1234',
              currency: 'USD',
              checkoutId: 'synthetic-checkout',
              idempotencyKey: randomUUID(),
              message: '合成账单'
            }
          });
          await mutate(tx, task, bill);
          for (const definition of checks) {
            const rows = await tx.$queryRawUnsafe(buildV2DataIntegrityCheckQuery(definition.sql));
            assert.equal(
              Number(rows[0].count),
              expectedCodes.has(definition.code) ? 1 : 0,
              definition.code
            );
          }
          throw rollback;
        },
        { isolationLevel: 'Serializable', timeout: 30000 }
      );
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }
  try {
    await t.test('完整成功账单十一条均零命中', () => scenario(async () => {}, null));
    const updateBill = (data) => async (tx, _task, bill) =>
      tx.onlineRechargeBill.update({ where: { id: bill.id }, data });
    const updateTask = (data) => async (tx, task) =>
      tx.onlineRechargeTask.update({ where: { id: task.id }, data });
    const cases = [
      [
        'online_bill_task_missing',
        updateBill({ taskId: randomUUID() }),
        ['online_bill_task_missing', 'online_confirmed_payment_bill_missing']
      ],
      [
        'online_bill_status_invalid',
        updateBill({ status: 'unexpected' }),
        ['online_bill_status_invalid', 'online_confirmed_payment_bill_missing']
      ],
      ['online_bill_amount_invalid', updateBill({ amount: '-1' })],
      ['online_bill_currency_invalid', updateBill({ currency: 'usd' })],
      ['online_bill_plan_mismatch', updateBill({ plan: 'pro_5x' })],
      [
        'online_checkout_multiple_success_bills',
        async (tx, task) =>
          tx.onlineRechargeBill.create({
            data: {
              taskId: task.id,
              plan: 'plus',
              status: 'success',
              amount: '20.1234',
              currency: 'USD',
              checkoutId: 'synthetic-checkout',
              idempotencyKey: randomUUID(),
              message: '合成重复账单'
            }
          })
      ],
      ['online_third_party_local_bill', updateTask({ provider: 'third_party' })],
      [
        'online_confirmed_payment_bill_missing',
        async (tx, _task, bill) => tx.onlineRechargeBill.delete({ where: { id: bill.id } })
      ],
      ['online_success_actual_amount_missing', updateBill({ amount: null })],
      ['online_payment_awaiting_review', updateTask({ status: 'awaiting_review' })],
      ['online_success_bill_terminal_task_not_paid', updateTask({ confirmedPaid: false })]
    ];
    for (const [code, mutate, expected = code] of cases)
      await t.test(code, () => scenario(mutate, expected));
    await t.test('零元已知金额和无结账编号均不误报', () =>
      scenario(updateBill({ amount: '0', checkoutId: null }), null)
    );
  } finally {
    await db.$disconnect();
  }
});
