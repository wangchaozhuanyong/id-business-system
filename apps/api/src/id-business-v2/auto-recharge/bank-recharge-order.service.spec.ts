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
  it('Plus升级使用本次已绑定实际发票建单，不伪造新结算编号', async () => {
    const { service, tx, job, repository } = fixture();
    const upgrade = {
      ...verified,
      operation: 'subscription_upgrade',
      upgrade_identifier: `upg_${'b'.repeat(32)}`,
      current_plan_before: 'plus',
      target_plan: 'pro-20x',
      quote_authority: 'official_upgrade_preview',
      upgrade_invoice_identifier: 'in_syntheticupgrade',
      checkout_identifier: undefined,
      quote: { ...verified.quote, plan: 'pro-20x' },
      payment_evidence: {
        ...verified.payment_evidence,
        kind: 'invoice',
        identifier: 'in_syntheticupgrade'
      }
    };
    await service.recordVerifiedSuccess(tx as never, { ...job, plan: 'pro-20x' } as never, upgrade);
    expect(repository.createOrder).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        data: expect.objectContaining({
          plan: 'pro-20x',
          checkoutIdentifier: 'in_syntheticupgrade',
          paymentEvidenceId: 'in_syntheticupgrade'
        })
      })
    );
    repository.createOrder.mockClear();
    await service.recordVerifiedSuccess(tx as never, { ...job, plan: 'pro-20x' } as never, {
      ...upgrade,
      upgrade_invoice_identifier: 'in_other'
    });
    expect(repository.createOrder).not.toHaveBeenCalled();
  });
  it('升级开通日采用本次成功时间，官网账期结束日优先于默认提醒', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T10:15:00+08:00'));
    try {
      const { service, tx, job, repository } = fixture();
      const accountKey = 'a'.repeat(64);
      await service.recordVerifiedSuccess(
        tx as never,
        { ...job, accountKey, plan: 'pro-5x' } as never,
        {
          ...verified,
          operation: 'subscription_upgrade',
          upgrade_identifier: `upg_${'c'.repeat(32)}`,
          current_plan_before: 'plus',
          target_plan: 'pro-5x',
          quote_authority: 'official_upgrade_preview',
          checkout_identifier: undefined,
          upgrade_invoice_identifier: 'in_timingupgrade',
          payment_evidence: {
            ...verified.payment_evidence,
            kind: 'invoice',
            identifier: 'in_timingupgrade'
          },
          quote: { ...verified.quote, plan: 'pro-5x' },
          subscription_period: {
            source: 'official_subscription_response',
            start: '2026-03-01T02:15:00.000Z',
            end: '2026-04-01T02:15:00.000Z',
            account_key: accountKey,
            target_plan: 'pro-5x'
          }
        }
      );
      expect(repository.createOrder).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          data: expect.objectContaining({
            openedAt: new Date('2026-03-04T10:15:00+08:00'),
            verifiedAt: new Date('2026-03-04T10:15:00+08:00'),
            dueAt: new Date('2026-03-31T10:15:00+08:00')
          })
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('其他账号的账期不能影响本次新订阅到期提醒', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T10:15:00+08:00'));
    try {
      const { service, tx, job, repository } = fixture();
      await service.recordVerifiedSuccess(tx as never, job as never, {
        ...verified,
        subscription_period: {
          source: 'official_subscription_response',
          start: '2026-03-01T02:15:00.000Z',
          end: '2026-04-01T02:15:00.000Z',
          account_key: 'other-account',
          target_plan: 'plus'
        }
      });
      expect(repository.createOrder).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          data: expect.objectContaining({ dueAt: new Date('2026-04-03T10:15:00+08:00') })
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(['2026-03-04T03:15:00.000Z', '2026-03-05T02:15:00.000Z'])(
    '官网账期 %s 减一天不晚于本次开通时保留自然月待核对提醒',
    async (end) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-04T10:15:00+08:00'));
      try {
        const { service, tx, job, repository } = fixture();
        const accountKey = 'a'.repeat(64);
        await service.recordVerifiedSuccess(tx as never, { ...job, accountKey } as never, {
          ...verified,
          subscription_period: {
            source: 'official_subscription_response',
            start: '2026-03-01T02:15:00.000Z',
            end,
            account_key: accountKey,
            target_plan: 'plus'
          }
        });
        expect(repository.createOrder).toHaveBeenCalledWith(
          tx,
          expect.objectContaining({
            data: expect.objectContaining({
              openedAt: new Date('2026-03-04T10:15:00+08:00'),
              dueAt: new Date('2026-04-03T10:15:00+08:00')
            })
          })
        );
      } finally {
        vi.useRealTimers();
      }
    }
  );
  it('官网核验成功建单时将开通时间和自然月到期提醒一并保存', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T10:15:00+08:00'));
    try {
      const { service, tx, job, repository } = fixture();
      await service.recordVerifiedSuccess(tx as never, job as never, verified);
      expect(repository.createOrder).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          data: expect.objectContaining({
            openedAt: new Date('2026-01-01T10:15:00+08:00'),
            dueAt: new Date('2026-01-31T10:15:00+08:00')
          })
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });
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
