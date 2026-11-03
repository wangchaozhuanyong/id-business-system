import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { OnlineRechargeWorkerRepository } from './persistence/worker.repository';
import { OnlineBitbrowserCompletionService } from './bitbrowser-completion.service';

function fixture() {
  const account = 'billing-recovery-fixture';
  const row = {
    id: '11111111-1111-4111-8111-111111111111',
    provider: 'bitbrowser',
    operation: 'recharge',
    codeId: 'synthetic-code',
    cardId: 'synthetic-card',
    cardLast4: '0000',
    plan: 'plus',
    paymentStarted: true,
    confirmedPaid: false,
    status: 'running',
    progress: 0,
    payload: {},
    sessionEncrypted: JSON.stringify({
      accessToken: `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.x`
    })
  };
  type Bill = {
    id: string;
    idempotencyKey: string;
    taskId: string;
    cardId: string;
    plan: string;
    checkoutId: string;
    amount: Prisma.Decimal | null;
    currency: string;
    status: string;
  };
  const bills = new Map<string, Bill>(),
    code = { status: 'reserved' };
  const db = {
    onlineRechargeBill: {
      upsert: vi.fn(async ({ where, create, update }) => {
        const existing = bills.get(where.idempotencyKey);
        const bill = existing
          ? Object.assign(existing, update)
          : { id: 'synthetic-bill', ...create };
        bills.set(where.idempotencyKey, bill);
        return bill;
      }),
      update: vi.fn(async ({ where, data }) => {
        const bill = [...bills.values()].find((value) => value.id === where.id)!;
        return Object.assign(bill, data);
      })
    },
    onlineRechargeTask: { update: vi.fn(async ({ data }) => Object.assign(row, data)) },
    onlineRechargeCode: { updateMany: vi.fn(async ({ data }) => Object.assign(code, data)) },
    onlineRechargeCard: { updateMany: vi.fn(async () => ({ count: 1 })) }
  };
  const log = vi.fn();
  const workers = new OnlineRechargeWorkerRepository(
    { log } as never,
    {} as never,
    { decrypt: (value: string) => value } as never,
    {} as never,
    { enqueueInTransaction: async () => undefined } as never
  );
  vi.spyOn(workers, 'withLease').mockImplementation(async (_rpc, work) =>
    work(db as never, row as never)
  );
  vi.spyOn(workers, 'cardAction').mockResolvedValue({} as never);
  const state = {
    deviceId: 'synthetic-device',
    paymentConsumed: true,
    accountKey: 'synthetic-account-key',
    quoteDigest: 'synthetic-quote',
    quote: { today: { amount: '20.00', amount_minor: 2000, currency: 'USD' } },
    ledgerEncrypted: JSON.stringify({
      file: {
        document: {
          account_key: 'synthetic-account-key',
          target_plan: 'plus',
          quote_digest: 'synthetic-quote',
          payment_status: 'paid',
          checkout_identifier: 'cs_billingfixture',
          payment_evidence: {
            kind: 'checkout_session',
            identifier: 'cs_billingfixture',
            amount_minor: 2000,
            currency: 'USD'
          }
        }
      }
    })
  };
  const completion = new OnlineBitbrowserCompletionService(
    {} as never,
    workers,
    { owned: async () => state } as never,
    { decrypt: (value: string) => value } as never,
    { releaseCvc: vi.fn() } as never
  );
  const finish = (matched: boolean) =>
    completion.finish(
      {
        method: 'callback',
        args: {
          result: {
            account_matched: matched,
            current_plan: matched ? 'plus' : 'free',
            status: matched ? 'subscription_activated' : 'paid_pending_activation'
          }
        }
      },
      {} as never
    );
  const bill = (changes: Record<string, unknown> = {}) =>
    workers.billing({
      method: 'billing',
      args: {
        status: 'success',
        amount: '20.00',
        currency: 'USD',
        amountSource: 'checkout',
        checkoutId: 'cs_billingfixture',
        ...changes
      }
    });
  return { row, bills, code, db, log, finish, bill };
}

describe('比特原任务核对与账单收尾', () => {
  it('付款已确认但套餐待核对，随后核实成功时推进同一账单并核销兑换码', async () => {
    const f = fixture();
    expect(await f.finish(false)).toMatchObject({ status: 'awaiting_review' });
    expect([...f.bills.values()]).toMatchObject([{ status: 'result_unknown' }]);
    expect(f.code.status).toBe('reserved');
    f.row.status = 'running';
    expect(await f.finish(true)).toMatchObject({ status: 'succeeded' });
    expect(f.bills.size).toBe(1);
    expect([...f.bills.values()]).toMatchObject([
      { status: 'success', checkoutId: 'cs_billingfixture' }
    ]);
    expect([...f.bills.values()][0]!.amount?.toString()).toBe('20');
    expect(f.code.status).toBe('used');
    expect(f.log).toHaveBeenCalledWith(
      expect.anything(),
      'worker.billing.confirm',
      undefined,
      f.row.id,
      expect.objectContaining({ billId: 'synthetic-bill', status: 'success' })
    );
    await f.bill();
    expect(f.db.onlineRechargeBill.update).toHaveBeenCalledTimes(1);
  });
  it('迟到的不明或失败回执不能把成功账单降级', async () => {
    const f = fixture();
    await f.bill();
    await f.bill({ status: 'result_unknown' });
    await f.bill({ status: 'failed' });
    expect([...f.bills.values()]).toMatchObject([{ status: 'success' }]);
    expect(f.bills.size).toBe(1);
  });
  it('金额、币种、付款标识或业务归属变化时拒绝推进原账单', async () => {
    for (const change of [
      { amount: new Prisma.Decimal('21') },
      { currency: 'PHP' },
      { checkoutId: 'cs_other' },
      { taskId: 'other-task' },
      { cardId: 'other-card' },
      { plan: 'pro_5x' }
    ]) {
      const f = fixture();
      await f.bill({ status: 'result_unknown' });
      Object.assign([...f.bills.values()][0]!, change);
      await expect(f.bill()).rejects.toThrow('账单');
      expect([...f.bills.values()][0]!.status).toBe('result_unknown');
    }
  });
  it('缺少实际金额时不能将待核对账单标记成功', async () => {
    const f = fixture();
    await f.bill({ status: 'result_unknown' });
    await expect(f.bill({ amount: null })).rejects.toThrow('账单');
    expect([...f.bills.values()][0]!.status).toBe('result_unknown');
  });
});
