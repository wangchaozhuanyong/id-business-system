import { describe, expect, it } from 'vitest';
import { hash } from './recharge-validation';
import {
  mergeRechargePaymentFacts,
  projectRechargePaymentRecord,
  recoverRechargePaymentResult
} from './recharge-payment-facts';

const accountKey = 'a'.repeat(64);
const checkout = 'cs_synthetic_original';
const quote = {
  plan: 'plus',
  today: { currency: 'USD', amount_minor: 2000, amount: '20.00' },
  tax: { currency: 'USD', amount_minor: 0, amount: '0.00' },
  renewal: { currency: 'USD', amount_minor: 2000, amount: '20.00' },
  renewal_interval: 'monthly'
};
const evidence = {
  kind: 'checkout_session',
  identifier: checkout,
  amount_minor: 2000,
  currency: 'USD'
};

function fixture() {
  const job = {
    ownerId: 'synthetic-owner',
    accountKey,
    plan: 'plus',
    state: 'confirming',
    createdAt: new Date('2026-10-03T00:00:00Z'),
    leaseUntil: new Date('2026-10-03T00:16:00Z'),
    result: {
      quote,
      quote_authority: 'official_checkout_response',
      stage: 'payment_ready',
      addressId: 'synthetic-address'
    } as Record<string, unknown>
  };
  const record = {
    ownerId: job.ownerId,
    accountKey,
    fileKey: `payments/${hash(checkout)}.json`,
    updatedAt: new Date('2026-10-03T00:01:00Z'),
    document: {
      account_key: accountKey,
      target_plan: 'plus',
      checkout_identifier: checkout,
      quote,
      payment_attempted: true,
      confirmation_requests_sent: 1,
      payment_status: 'unknown',
      created_at: Date.parse('2026-10-03T00:00:59Z') / 1000
    } as Record<string, unknown>
  };
  return { job, record };
}

describe('持久付款事实与原任务摘要', () => {
  it('仅投影同账号、同套餐、同报价且与付款文件绑定的事实，保留执行进度', () => {
    const { job, record } = fixture();
    const result = projectRechargePaymentRecord(job, record.fileKey, record.document);
    expect(result).toMatchObject({
      checkout_identifier: checkout,
      payment_attempted: true,
      confirmation_requests_sent: 1,
      payment_requests_sent: 1,
      payment_status: 'unknown',
      stage: 'payment_ready',
      addressId: 'synthetic-address',
      repeated_payment: 'blocked'
    });
    expect(job.result).not.toHaveProperty('payment_attempted');
  });

  it('点击前的持久标记保留零次确认，不冒充已发出付款', () => {
    const { job, record } = fixture();
    record.document.confirmation_requests_sent = 0;
    expect(projectRechargePaymentRecord(job, record.fileKey, record.document)).toMatchObject({
      payment_attempted: true,
      confirmation_requests_sent: 0,
      payment_requests_sent: 0
    });
  });

  it('只读复查看到历史确认标记也保持本次付款请求为零', () => {
    const { job, record } = fixture();
    job.result.recheck_only = true;
    expect(projectRechargePaymentRecord(job, record.fileKey, record.document)).toMatchObject({
      payment_attempted: true,
      confirmation_requests_sent: 1,
      payment_requests_sent: 0
    });
  });

  it('进度、失败或迟到回执不能回退确认次数、已付款和付款证据', () => {
    const previous = {
      payment_attempted: true,
      confirmation_requests_sent: 1,
      payment_requests_sent: 1,
      payment_status: 'paid',
      payment_evidence: evidence
    };
    expect(
      mergeRechargePaymentFacts(previous, {
        payment_attempted: false,
        confirmation_requests_sent: 0,
        payment_requests_sent: 0,
        payment_status: 'not_attempted',
        payment_evidence: null,
        stage: 'payment_submitted_or_pending'
      })
    ).toEqual({ ...previous, stage: 'payment_submitted_or_pending' });
  });

  it('已有成功终态不因读取或旧 ledger 变为未知', () => {
    const { job, record } = fixture();
    Object.assign(job.result, {
      checkout_identifier: checkout,
      payment_status: 'paid',
      payment_evidence: evidence,
      status: 'subscription_activated',
      payment_outcome: 'subscription_activated'
    });
    expect(projectRechargePaymentRecord(job, record.fileKey, record.document)).toMatchObject({
      payment_status: 'paid',
      payment_evidence: evidence,
      status: 'subscription_activated',
      payment_outcome: 'subscription_activated'
    });
  });

  it.each([
    { account_key: 'b'.repeat(64) },
    { target_plan: 'pro-500' },
    { payment_attempted: false },
    { confirmation_requests_sent: 2 },
    { payment_status: 'paid' },
    { quote: { ...quote, today: { ...quote.today, amount_minor: 2100, amount: '21.00' } } }
  ])('拒绝不匹配或不完整的付款记录：%j', (changes) => {
    const { job, record } = fixture();
    expect(
      projectRechargePaymentRecord(job, record.fileKey, { ...record.document, ...changes })
    ).toBeNull();
  });

  it('拒绝更换已绑定的原单编号或付款文件', () => {
    const { job, record } = fixture();
    expect(
      projectRechargePaymentRecord(job, `payments/${'f'.repeat(64)}.json`, record.document)
    ).toBeNull();
    job.result.checkout_identifier = 'cs_other';
    expect(projectRechargePaymentRecord(job, record.fileKey, record.document)).toBeNull();
  });

  it('旧硬中断摘要由原任务租约内唯一付款记录恢复，纯读取不改状态或租约', () => {
    const { job, record } = fixture();
    const before = structuredClone(job);
    expect(recoverRechargePaymentResult(job, [record])).toMatchObject({
      checkout_identifier: checkout,
      payment_attempted: true,
      payment_requests_sent: 1
    });
    expect(job).toEqual(before);
  });

  it.each(['owner', 'account', 'before', 'after', 'later_update', 'finished'])(
    '未绑定编号时不挪用其他归属或任务的付款记录：%s',
    (scenario) => {
      const { job, record } = fixture();
      if (scenario === 'owner') record.ownerId = 'another-owner';
      if (scenario === 'account') record.accountKey = 'b'.repeat(64);
      if (scenario === 'before') record.document.created_at = job.createdAt.getTime() / 1000 - 1;
      if (scenario === 'after') record.document.created_at = job.leaseUntil.getTime() / 1000 + 1;
      if (scenario === 'later_update') record.updatedAt = new Date(job.leaseUntil.getTime() + 1);
      if (scenario === 'finished') job.state = 'finished';
      expect(recoverRechargePaymentResult(job, [record])).toEqual(job.result);
    }
  );

  it('多个相同报价付款记录仍然拒绝猜测归属', () => {
    const { job, record } = fixture();
    const second = {
      ...record,
      fileKey: `payments/${hash('cs_another')}.json`,
      document: { ...record.document, checkout_identifier: 'cs_another' }
    };
    expect(recoverRechargePaymentResult(job, [record, second])).toEqual(job.result);
  });

  it('已绑定原单允许读取后来只读复查写回的事实，不接受另一个checkout', () => {
    const { job, record } = fixture();
    job.result.checkout_identifier = checkout;
    job.state = 'finished';
    record.updatedAt = new Date(job.leaseUntil.getTime() + 1000);
    expect(recoverRechargePaymentResult(job, [record])).toMatchObject({ payment_requests_sent: 1 });
  });
});
