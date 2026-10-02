import { BankRechargeFeesService } from './bank-recharge-fees.service';
import { describe, expect, it, vi } from 'vitest';
import { BankRechargeOrderService } from './bank-recharge-order.service';
import {
  bankRechargeFee,
  bankRechargeFeeRate,
  bankRechargeMoney
} from './bank-recharge-validation';

const verified = {
  recheck_only: false,
  payment_status: 'paid',
  payment_outcome: 'subscription_activated',
  status: 'subscription_activated',
  account_matched: true,
  quote_authority: 'official_checkout_response',
  payment_requests_sent: 1,
  checkout_identifier: 'checkout-1',
  payment_evidence: {
    kind: 'bank',
    identifier: 'payment-1',
    amount_minor: 100000,
    currency: 'PHP'
  },
  quote: { today: { amount: '1000.00', amount_minor: 100000, currency: 'PHP' } }
};

function fixture() {
  const order = {
    id: 'order-1',
    orderNo: 'BC001',
    checkoutIdentifier: 'checkout-1',
    paymentEvidenceId: 'payment-1',
    chargeAmount: { toString: () => '1000' },
    accountId: null,
    customerId: null,
    plan: 'plus',
    openedAt: new Date(),
    dueAt: null
  };
  const tx = {
    idBusinessV2BankRechargeOrder: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(order)
    },
    idBusinessV2BankRechargeCard: { findMany: vi.fn().mockResolvedValue([]) }
  };
  const accounts = {
    ensureVerifiedCurrency: vi.fn().mockResolvedValue({ code: 'PHP', minorUnits: 2 }),
    ensureAccountForVerifiedPayment: vi.fn().mockResolvedValue(null)
  };
  const audit = { append: vi.fn().mockResolvedValue(undefined) };
  const repository = {
    findOrderByPaymentEvidence: vi.fn(() => tx.idBusinessV2BankRechargeOrder.findFirst()),
    createOrder: vi.fn((_tx: unknown, input: unknown) =>
      tx.idBusinessV2BankRechargeOrder.create(input)
    ),
    findRechargeJob: vi.fn(),
    findCardsByTail: vi.fn(() => tx.idBusinessV2BankRechargeCard.findMany())
  };
  const service = new BankRechargeOrderService(
    {} as never,
    audit as never,
    accounts as never,
    repository as never,
    new BankRechargeFeesService({} as never, {} as never),
    {
      decrypt: (value: string | null) => value,
      encrypt: (value: string) => `encrypted:${value}`
    } as never
  );
  const job = {
    id: 'job-1',
    action: 'bitbrowser',
    accountKey: 'account-key',
    chatgptAccountId: null,
    ownerId: 'user-1',
    plan: 'plus'
  };
  return { service, tx, accounts, audit, job, order, repository };
}

describe('银充付款入单', () => {
  it('开通核验成功时仅在订单保存加密的首位与末八位摘要', async () => {
    const { service, tx, job, repository, audit } = fixture();
    repository.findCardsByTail.mockResolvedValue([
      { id: 'used-card', label: '验收卡', last4: '1111', numberEncrypted: '4111111111111111' }
    ] as never);
    await service.recordVerifiedSuccess(tx as never, { ...job, cardId: 'used-card' } as never, {
      ...verified,
      card_last4: '1111'
    });
    expect(repository.createOrder).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        data: expect.objectContaining({
          cardId: 'used-card',
          cardNumberSummaryEncrypted: 'encrypted:4*******11111111',
          cardDeletedAt: null
        })
      })
    );
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('4111111111111111');
  });
  it('1000 的 2.5% 客户手续费为 25，代付币种精度受控', () => {
    expect(
      bankRechargeFee(
        bankRechargeMoney('1000.00', '代付', 2),
        bankRechargeFeeRate('2.5'),
        2
      ).toString()
    ).toBe('25');
    expect(
      bankRechargeFee(
        bankRechargeMoney('1000', '代付', 0),
        bankRechargeFeeRate('2.5'),
        0
      ).toString()
    ).toBe('25');
    expect(() => bankRechargeMoney('1000.001', '代付', 2)).toThrow();
  });

  it('没有一致的官网付款证据时不建立订单', async () => {
    const { service, tx, job } = fixture();
    const mismatched = {
      ...verified,
      payment_evidence: { ...verified.payment_evidence, amount_minor: 99999 }
    };
    expect(await service.recordVerifiedSuccess(tx as never, job as never, mismatched)).toBeNull();
    expect(tx.idBusinessV2BankRechargeOrder.create).not.toHaveBeenCalled();
  });

  it.each(['plus', 'pro-500'])('%s 服务器任务仅在付款与订阅核验后入单', async (plan) => {
    const { service, tx, job, order } = fixture();
    expect(
      await service.recordVerifiedSuccess(
        tx as never,
        { ...job, plan, action: 'server' } as never,
        verified
      )
    ).toEqual(order);
    expect(tx.idBusinessV2BankRechargeOrder.create).toHaveBeenCalledTimes(1);
    expect(tx.idBusinessV2BankRechargeOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ plan }) })
    );
    tx.idBusinessV2BankRechargeOrder.create.mockClear();
    expect(
      await service.recordVerifiedSuccess(
        tx as never,
        { ...job, plan, action: 'server' } as never,
        {
          ...verified,
          status: 'paid_pending_activation',
          payment_outcome: 'paid_pending_activation'
        }
      )
    ).toBeNull();
    expect(tx.idBusinessV2BankRechargeOrder.create).not.toHaveBeenCalled();
  });

  it('only backfills a verified read-only recheck through the trusted original job', async () => {
    const { service, tx, job, repository } = fixture();
    const source = {
      ...job,
      id: 'source-job',
      result: { ...verified, status: 'subscription_pending' }
    };
    repository.findRechargeJob.mockResolvedValue(source);
    const recheckJob = { ...job, result: { recheck_only: true, source_job_id: source.id } };
    const report = { ...verified, recheck_only: true, payment_requests_sent: 0 };
    await service.recordVerifiedSuccess(tx as never, recheckJob as never, report);
    expect(tx.idBusinessV2BankRechargeOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ rechargeJobId: source.id }) })
    );
    tx.idBusinessV2BankRechargeOrder.create.mockClear();
    repository.findRechargeJob.mockResolvedValue({ ...source, ownerId: 'other-user' });
    expect(
      await service.recordVerifiedSuccess(tx as never, recheckJob as never, report)
    ).toBeNull();
    expect(tx.idBusinessV2BankRechargeOrder.create).not.toHaveBeenCalled();
  });

  it('官网付款及订阅生效均核验后建立待补全订单，重放只返回原单', async () => {
    const { service, tx, job, order, audit } = fixture();
    expect(await service.recordVerifiedSuccess(tx as never, job as never, verified)).toEqual(order);
    expect(tx.idBusinessV2BankRechargeOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'automatic',
          rechargeJobId: 'job-1',
          chargeAmount: '1000',
          chargeCurrencyCode: 'PHP',
          paymentEvidenceId: 'payment-1'
        })
      })
    );
    tx.idBusinessV2BankRechargeOrder.findFirst.mockResolvedValue(order);
    expect(await service.recordVerifiedSuccess(tx as never, job as never, verified)).toEqual(order);
    expect(tx.idBusinessV2BankRechargeOrder.create).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledTimes(1);
  });
});
