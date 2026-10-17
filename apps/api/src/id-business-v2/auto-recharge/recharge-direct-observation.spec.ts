import { describe, expect, it, vi } from 'vitest';
import { RechargeService } from './recharge.service';
import { RechargeLocalService } from './recharge-local.service';
import { hash } from './recharge-validation';
import {
  assertDirectRechargeReport,
  directRechargeAuthorized,
  prepareDirectRechargeQuote
} from './recharge-direct-payment';
import { authorizeExpiredCheckoutReplacement } from './recharge-expired-checkout';
import { unknownPaymentCanBeResolved } from './recharge-resolution';

const id = '11111111-1111-4111-8111-111111111111';
const accountKey = 'a'.repeat(64);
const checkout = 'oaics_unexpected_direct';
const owner = { id: 'owner' };
function fixture() {
  const job = {
    id,
    ownerId: owner.id,
    accountKey,
    plan: 'plus',
    action: 'bitbrowser',
    state: 'running',
    nonceHash: hash('synthetic-observer-token'),
    createdAt: new Date(),
    leaseUntil: new Date(Date.now() + 600000),
    result: {
      transport: 'web_direct',
      mode: 'payment',
      account_matched: true,
      current_plan: 'free',
      current_plan_before: 'free',
      target_plan: 'plus',
      locked_currency: 'USD',
      checkout_identifier: checkout,
      payment_attempted: false,
      payment_requests_sent: 0,
      confirmation_requests_sent: 0
    } as Record<string, unknown>
  };
  const active = {
    ownerId: owner.id,
    fileKey: `${accountKey}.json`,
    revision: 1,
    document: {
      target_plan: 'plus',
      checkout_identifier: checkout,
      processor_entity: 'openai_llc',
      payment_status: 'not_attempted',
      payment_attempted: false,
      payment_requests_sent: 0,
      confirmation_requests_sent: 0
    }
  };
  const records = new Map<
    string,
    { ownerId: string; fileKey: string; revision: number; document: object }
  >([[active.fileKey, active]]);
  const repository = {
    lock: vi.fn(),
    findJob: vi.fn(async () => job),
    records: vi.fn(async () => [...records.values()]),
    updateJob: vi.fn(async (_tx, _id, data) => Object.assign(job, data)),
    saveRecord: vi.fn(async (_tx, input) => {
      const previous = records.get(input.fileKey);
      if ((previous?.revision ?? 0) !== input.revision) throw new Error('版本冲突');
      const value = { ...input, revision: input.revision + 1 };
      records.set(input.fileKey, value);
      return { revision: value.revision };
    })
  };
  const audit = { append: vi.fn() };
  const transactions = { execute: async (work: (tx: object) => unknown) => work({}) };
  const service = new RechargeService(
    repository as never,
    {} as never,
    transactions as never,
    audit as never
  );
  const local = new RechargeLocalService(
    repository as never,
    {} as never,
    {} as never,
    service,
    transactions as never,
    audit as never
  );
  const report = () => ({
    checkout_identifier: checkout,
    processor_entity: 'openai_llc',
    account_matched: true,
    current_plan_before: 'free',
    target_plan: 'plus',
    payment_requests_sent: 1,
    confirmation_requests_sent: 1
  });
  const callback = (type: string, result: object) =>
    service.callback(id, { type, result }, { localToken: 'synthetic-observer-token' });
  return { job, records, active, repository, audit, service, local, report, callback };
}

describe('官网未授权付款观察只持久加锁，不生成付款许可', () => {
  it('未arm时实际观察被保存，报价/确认/取消/过期替换均无法再次放行', async () => {
    const f = fixture();
    await expect(f.callback('direct_unexpected_payment', f.report())).resolves.toEqual({
      ok: true,
      paymentLocked: true
    });
    expect(directRechargeAuthorized(f.job as never)).toBe(false);
    expect(f.job.result).toMatchObject({
      payment_attempted: true,
      payment_status: 'unknown',
      payment_requests_sent: 1,
      confirmation_requests_sent: 1,
      repeated_payment: 'blocked'
    });
    expect(f.job.result._direct_confirmation_v1).toBeUndefined();
    expect(f.records.get(`payments/${hash(checkout)}.json`)?.document).toMatchObject({
      account_key: accountKey,
      checkout_identifier: checkout,
      payment_status: 'unknown',
      payment_attempted: true
    });
    await expect(
      prepareDirectRechargeQuote({
        tx: {} as never,
        job: f.job as never,
        report: {},
        repository: f.repository as never,
        audit: f.audit as never
      })
    ).rejects.toThrow();
    await expect(
      f.service.confirm(
        id,
        { nonce: 'b'.repeat(64), quoteDigest: 'c'.repeat(64), checkoutIdentifier: checkout },
        owner as never
      )
    ).rejects.toThrow();
    await expect(f.local.cancel(id, owner as never)).rejects.toThrow('只能查看原单');
    await expect(
      authorizeExpiredCheckoutReplacement({
        tx: {} as never,
        job: f.job as never,
        callback: {
          accountKey,
          checkoutIdentifier: checkout,
          proof: {
            checkout_identifier: checkout,
            processor_entity: 'openai_llc',
            target_plan: 'plus',
            account_key: accountKey,
            status: 'expired',
            payment_status: 'unpaid'
          }
        },
        repository: f.repository as never,
        audit: f.audit as never
      })
    ).rejects.toThrow();
    await f.callback('direct_unexpected_payment', f.report());
    expect(f.repository.saveRecord).toHaveBeenCalledOnce();
  });

  it('普通终态保留unknown，迟到false/0不能清零；不得改成paid或附加证据', async () => {
    const f = fixture();
    await f.callback('direct_unexpected_payment', f.report());
    expect(() => assertDirectRechargeReport(f.job as never, { payment_status: 'paid' })).toThrow();
    expect(() =>
      assertDirectRechargeReport(f.job as never, {
        payment_status: 'unknown',
        payment_evidence: {}
      })
    ).toThrow();
    await f.callback('finished', {
      checkout_identifier: checkout,
      status: 'payment_result_unknown',
      payment_status: 'unknown',
      payment_attempted: false,
      payment_requests_sent: 0,
      confirmation_requests_sent: 0
    });
    expect(f.job.state).toBe('finished');
    expect(f.job.result).toMatchObject({
      payment_attempted: true,
      payment_status: 'unknown',
      payment_requests_sent: 1,
      confirmation_requests_sent: 1,
      repeated_payment: 'blocked'
    });
    expect(f.records.get(`payments/${hash(checkout)}.json`)?.document).toMatchObject({
      payment_attempted: true,
      payment_status: 'unknown'
    });
    await expect(
      f.callback('finished', {
        checkout_identifier: checkout,
        status: 'subscription_activated',
        payment_attempted: true,
        payment_requests_sent: 1,
        confirmation_requests_sent: 1,
        payment_status: 'paid',
        payment_evidence: {
          kind: 'checkout_session',
          identifier: checkout,
          amount_minor: 2000,
          currency: 'USD'
        }
      })
    ).rejects.toThrow();
  });

  it.each([1, 2, 10])('接受观测次数%d，仅按1次保守锁定并在审计保留真实次数', async (count) => {
    const f = fixture();
    await f.callback('direct_unexpected_payment', {
      ...f.report(),
      payment_requests_sent: count,
      confirmation_requests_sent: count
    });
    expect(f.job.result).toMatchObject({ payment_requests_sent: 1, confirmation_requests_sent: 1 });
    expect(f.audit.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        afterData: { operationIdentifier: checkout, observedRequests: count }
      })
    );
    f.job.state = 'finished';
    expect(unknownPaymentCanBeResolved(f.job)).toBe(count === 1);
  });

  it.each([0, 11, -1, 1.5, '1', false, null])('拒绝无效观察计数%j', async (count) => {
    const f = fixture();
    await expect(
      f.callback('direct_unexpected_payment', {
        ...f.report(),
        payment_requests_sent: count,
        confirmation_requests_sent: count
      })
    ).rejects.toThrow();
    expect(f.repository.saveRecord).not.toHaveBeenCalled();
  });

  it.each([
    'other-order',
    'other-plan',
    'unmatched',
    'other-owner',
    'no-original',
    'paid',
    'evidence'
  ])('不能伪造绑定或成功事实：%s', async (reason) => {
    const f = fixture();
    const report: Record<string, unknown> = f.report();
    if (reason === 'other-order') report.checkout_identifier = 'oaics_other';
    if (reason === 'other-plan') report.target_plan = 'go';
    if (reason === 'unmatched') report.account_matched = false;
    if (reason === 'other-owner') f.active.ownerId = 'another-owner';
    if (reason === 'no-original') f.records.clear();
    if (reason === 'paid') report.payment_status = 'paid';
    if (reason === 'evidence') report.payment_evidence = { kind: 'checkout_session' };
    await expect(f.callback('direct_unexpected_payment', report)).rejects.toThrow();
    expect(f.repository.saveRecord).not.toHaveBeenCalled();
  });

  it('同样锁定已绑定的升级操作，仍不生成授权或成功', async () => {
    const f = fixture();
    const upg = `upg_${'d'.repeat(32)}`;
    delete f.job.result.checkout_identifier;
    Object.assign(f.job.result, {
      operation: 'subscription_upgrade',
      upgrade_identifier: upg,
      current_plan_before: 'go'
    });
    const rest: Record<string, unknown> = { ...f.report() };
    delete rest.checkout_identifier;
    delete rest.processor_entity;
    await expect(
      f.callback('direct_unexpected_payment', {
        ...rest,
        upgrade_identifier: upg,
        current_plan_before: 'go'
      })
    ).resolves.toEqual({ ok: true, paymentLocked: true });
    expect(f.records.get(`payments/${hash(upg)}.json`)?.document).toMatchObject({
      operation: 'subscription_upgrade',
      upgrade_identifier: upg,
      payment_status: 'unknown'
    });
    expect(directRechargeAuthorized(f.job as never)).toBe(false);
  });
});
