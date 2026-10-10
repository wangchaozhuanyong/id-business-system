import { BankRechargeFeesService } from './bank-recharge-fees.service';
import { describe, expect, it, vi } from 'vitest';
import { BankRechargeOrderService } from './bank-recharge-order.service';
import { recordVerifiedBankRecharge } from './recharge-bank-callback';
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
  quote: { plan: 'plus', today: { amount: '1000.00', amount_minor: 100000, currency: 'PHP' } }
};

function fixture() {
  const order = {
    id: 'order-1',
    orderNo: 'BC001',
    rechargeJobId: 'job-1',
    checkoutIdentifier: 'checkout-1',
    paymentEvidenceId: 'payment-1',
    chargeAmount: { toString: () => '1000' },
    chargeCurrencyCode: 'PHP',
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
    result: {},
    plan: 'plus'
  };
  return { service, tx, accounts, audit, job, order, repository };
}

describe('银充付款入单', () => {
  it('GO 开通与 Plus 升级分别记录菲律宾币当次实付，升级重放和复查不重复建单', async () => {
    const { service, tx, job, order, repository } = fixture();
    const stored: Array<typeof order> = [];
    repository.findOrderByPaymentEvidence.mockImplementation((...args: unknown[]) =>
      Promise.resolve(
        stored.find(
          (item) =>
            item.rechargeJobId === args[1] ||
            item.checkoutIdentifier === args[2] ||
            item.paymentEvidenceId === args[3]
        ) ?? null
      )
    );
    tx.idBusinessV2BankRechargeOrder.create.mockImplementation(async (input) => {
      const { data } = input as {
        data: {
          rechargeJobId: string;
          checkoutIdentifier: string;
          paymentEvidenceId: string;
          chargeCurrencyCode: string;
          chargeAmount: string;
          plan: string;
        };
      };
      const saved = {
        ...order,
        ...data,
        id: `order-${stored.length + 1}`,
        chargeAmount: { toString: () => data.chargeAmount }
      };
      stored.push(saved);
      return saved;
    });
    const goJob = { ...job, id: 'go-job', plan: 'go' };
    const go = {
      ...verified,
      checkout_identifier: 'cs_syntheticgo',
      payment_evidence: {
        ...verified.payment_evidence,
        identifier: 'pi_syntheticgo',
        amount_minor: 50000
      },
      quote: {
        plan: 'go',
        today: { amount: '500.00', amount_minor: 50000, currency: 'PHP' },
        renewal: { amount: '500.00', amount_minor: 50000, currency: 'PHP' }
      }
    };
    const plusJob = { ...job, id: 'plus-upgrade-job', plan: 'plus' };
    const upgrade = {
      ...verified,
      operation: 'subscription_upgrade',
      upgrade_identifier: `upg_${'c'.repeat(32)}`,
      current_plan_before: 'go',
      target_plan: 'plus',
      quote_authority: 'official_upgrade_preview',
      upgrade_invoice_identifier: 'in_syntheticgoplus',
      checkout_identifier: undefined,
      quote: {
        plan: 'plus',
        today: { amount: '699.75', amount_minor: 69975, currency: 'PHP' },
        credit: { amount: '300.25', amount_minor: 30025, currency: 'PHP' },
        renewal: { amount: '1000.00', amount_minor: 100000, currency: 'PHP' }
      },
      payment_evidence: {
        kind: 'invoice',
        identifier: 'in_syntheticgoplus',
        amount_minor: 69975,
        currency: 'PHP'
      }
    };
    await service.recordVerifiedSuccess(tx as never, goJob as never, go);
    const upgradeOrder = await service.recordVerifiedSuccess(
      tx as never,
      plusJob as never,
      upgrade
    );
    expect(
      stored.map((item) => [item.plan, item.chargeAmount.toString(), item.chargeCurrencyCode])
    ).toEqual([
      ['go', '500', 'PHP'],
      ['plus', '699.75', 'PHP']
    ]);
    expect(await service.recordVerifiedSuccess(tx as never, plusJob as never, upgrade)).toBe(
      upgradeOrder
    );

    repository.findRechargeJob.mockResolvedValue({ ...plusJob, result: upgrade });
    const recheckJob = {
      ...plusJob,
      id: 'readonly-recheck-job',
      action: 'recheck',
      result: { recheck_only: true, source_job_id: plusJob.id }
    };
    expect(
      await service.recordVerifiedSuccess(tx as never, recheckJob as never, {
        ...upgrade,
        recheck_only: true,
        payment_requests_sent: 0,
        // 复查回包即使混入续费价，也只能沿用原任务当次实付报价。
        quote: { ...upgrade.quote, today: upgrade.quote.renewal }
      })
    ).toBe(upgradeOrder);
    expect(repository.createOrder).toHaveBeenCalledTimes(2);
    expect(stored[1].rechargeJobId).toBe(plusJob.id);
    expect(stored[1].chargeAmount.toString()).toBe('699.75');
  });

  it('GO→Plus 发票只有原价而非升级当次补付时拒绝建单', async () => {
    const { service, tx, job, repository } = fixture();
    const result = {
      ...verified,
      operation: 'subscription_upgrade',
      upgrade_identifier: `upg_${'d'.repeat(32)}`,
      current_plan_before: 'go',
      target_plan: 'plus',
      quote_authority: 'official_upgrade_preview',
      upgrade_invoice_identifier: 'in_syntheticwrongfullprice',
      quote: {
        plan: 'plus',
        today: { amount: '699.75', amount_minor: 69975, currency: 'PHP' },
        renewal: { amount: '1000.00', amount_minor: 100000, currency: 'PHP' }
      },
      payment_evidence: {
        kind: 'invoice',
        identifier: 'in_syntheticwrongfullprice',
        amount_minor: 100000,
        currency: 'PHP'
      }
    };
    expect(await service.recordVerifiedSuccess(tx as never, job as never, result)).toBeNull();
    expect(repository.createOrder).not.toHaveBeenCalled();
  });

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
  it.each(['prepare', 'flow', 'bitbrowser', 'server'])(
    '%s 成功付款保留待核对日期，重放只建一单',
    async (action) => {
      const { service, tx, job, repository, order } = fixture();
      const inputJob = { ...job, action };
      await recordVerifiedBankRecharge(
        tx as never,
        inputJob as never,
        {
          ...verified,
          first_session_verified_at: '2026-10-01T00:00:00Z',
          subscription_period: {
            source: 'official_subscription_response',
            start: '2026-09-01T00:00:00Z',
            end: '2026-11-01T00:00:00Z',
            account_key: job.accountKey,
            target_plan: job.plan
          }
        },
        service
      );
      expect(repository.createOrder).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          data: expect.objectContaining({
            openedAt: null,
            dueAt: null,
            renewedFromOrderId: null,
            customerId: null,
            verifiedAt: expect.any(Date)
          })
        })
      );
      tx.idBusinessV2BankRechargeOrder.findFirst.mockResolvedValue(order);
      await recordVerifiedBankRecharge(tx as never, inputJob as never, verified, service);
      expect(repository.createOrder).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    { payment_status: 'unknown' },
    { account_matched: false },
    { payment_requests_sent: 0 },
    { quote_authority: 'worker_estimate' },
    { quote: { ...verified.quote, plan: 'pro-20x' } },
    { payment_evidence: { ...verified.payment_evidence, currency: 'USD' } },
    { quote: { ...verified.quote, today: { ...verified.quote.today, amount: '2000.00' } } }
  ])('JSON 错误事实 %j 不建立银充订单', async (patch) => {
    const { service, tx, job, repository } = fixture();
    expect(
      await service.recordVerifiedSuccess(tx as never, { ...job, action: 'prepare' } as never, {
        ...verified,
        ...patch
      })
    ).toBeNull();
    expect(repository.createOrder).not.toHaveBeenCalled();
  });

  it('generic recheck 无原任务绑定不能当作新付款来源', async () => {
    const { service, tx, job, repository } = fixture();
    expect(
      await service.recordVerifiedSuccess(
        tx as never,
        { ...job, action: 'recheck' } as never,
        verified
      )
    ).toBeNull();
    expect(repository.createOrder).not.toHaveBeenCalled();
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
        { ...verified, quote: { ...verified.quote, plan } }
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

  it('相同凭据不能被另一原付款任务认领', async () => {
    const { service, tx, job, order, repository } = fixture();
    tx.idBusinessV2BankRechargeOrder.findFirst.mockResolvedValue({
      ...order,
      rechargeJobId: 'other-original'
    });
    await expect(
      service.recordVerifiedSuccess(tx as never, job as never, verified)
    ).rejects.toThrow('已关联其他银充订单');
    expect(repository.createOrder).not.toHaveBeenCalled();
  });

  it('旧 JSON 原付款迟到复查补单保留较新订阅和续费链', async () => {
    const { service, tx, job, repository, accounts } = fixture();
    const current = {
      currentOrderId: 'newer',
      openedAt: new Date('2026-10-03'),
      dueAt: new Date('2026-11-01')
    };
    const subscriptionRepository = {
      findSubscription: vi.fn().mockResolvedValue(current),
      findSubscriptionWithOrder: vi.fn().mockResolvedValue(current),
      upsertSubscription: vi.fn()
    };
    Object.assign(repository, subscriptionRepository);
    accounts.ensureAccountForVerifiedPayment.mockResolvedValue('account' as never);
    const source = {
      ...job,
      id: 'original',
      action: 'prepare',
      createdAt: new Date('2026-10-01'),
      result: { ...verified, status: 'subscription_pending' }
    };
    repository.findRechargeJob.mockResolvedValue(source);
    await service.recordVerifiedSuccess(
      tx as never,
      { ...job, result: { recheck_only: true, source_job_id: source.id } } as never,
      { ...verified, recheck_only: true, payment_requests_sent: 0 }
    );
    expect(repository.createOrder).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        data: expect.objectContaining({
          rechargeJobId: source.id,
          accountId: 'account',
          openedAt: null,
          dueAt: null,
          renewedFromOrderId: null
        })
      })
    );
    expect(subscriptionRepository.upsertSubscription).not.toHaveBeenCalled();
    expect(current.currentOrderId).toBe('newer');
    expect(current.dueAt.toISOString()).toBe('2026-11-01T00:00:00.000Z');
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
