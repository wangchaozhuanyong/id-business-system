import { describe, expect, it, vi } from 'vitest';
import { RechargeService } from './recharge.service';
import { RechargeLocalService } from './recharge-local.service';
import { hash } from './recharge-validation';
import { startUnknownPaymentResolution } from './recharge-resolution';
import {
  assertDirectRechargeReport,
  confirmDirectRechargePayment,
  prepareDirectRechargeQuote,
  persistDirectRechargeObservation
} from './recharge-direct-payment';

const id = '11111111-1111-4111-8111-111111111111';
const accountKey = 'a'.repeat(64);
const checkout = 'oaics_synthetic_direct';
const operator = { id: 'owner' };
const money = { amount: '20.00', amount_minor: 2000, currency: 'USD' };
const quote = {
  plan: 'plus',
  today: money,
  tax: { ...money, amount: '0.00', amount_minor: 0 },
  renewal: money,
  renewal_interval: 'monthly'
};

function fixture() {
  const job = {
    id,
    ownerId: operator.id,
    accountKey,
    plan: 'plus',
    action: 'bitbrowser',
    state: 'running',
    nonceHash: hash('synthetic-direct-agent-token'),
    createdAt: new Date(),
    leaseUntil: new Date(Date.now() + 600000),
    result: {
      transport: 'web_direct',
      mode: 'payment',
      locked_currency: 'USD',
      checkout_identifier: checkout,
      account_matched: true,
      payment_attempted: false,
      payment_requests_sent: 0,
      confirmation_requests_sent: 0
    } as Record<string, unknown>
  };
  const records = new Map<
    string,
    { ownerId: string; fileKey: string; revision: number; document: object }
  >();
  const repository = {
    lock: vi.fn(),
    findJob: vi.fn(async () => job),
    updateJob: vi.fn(async (_tx, _id, data) => Object.assign(job, data)),
    records: vi.fn(async () => [...records.values()]),
    saveRecord: vi.fn(async (_tx, input) => {
      const previous = records.get(input.fileKey);
      if ((previous?.revision ?? 0) !== input.revision) throw new Error('版本冲突');
      const record = { ...input, revision: input.revision + 1 };
      records.set(input.fileKey, record);
      return { revision: record.revision };
    })
  };
  const audit = { append: vi.fn() };
  const input = () => ({
    tx: {} as never,
    job: job as never,
    repository: repository as never,
    audit: audit as never
  });
  const report = () => ({
    quote,
    account_matched: true,
    checkout_identifier: checkout,
    current_plan_before: 'free',
    billing_fingerprint: 'b'.repeat(64),
    quote_authority: 'official_checkout_response'
  });
  const prepare = (value: unknown = report()) =>
    prepareDirectRechargeQuote({ ...input(), report: value });
  const confirm = (value: unknown) =>
    confirmDirectRechargePayment({ ...input(), operator: operator as never, value });
  const transactions = { execute: async (work: (tx: object) => Promise<unknown>) => work({}) };
  const service = new RechargeService(
    repository as never,
    {} as never,
    transactions as never,
    audit as never
  );
  const names = { releaseUnreceivedCard: vi.fn() };
  const local = new RechargeLocalService(
    repository as never,
    {} as never,
    {} as never,
    service,
    transactions as never,
    audit as never,
    undefined,
    undefined,
    undefined,
    names as never
  );
  const callback = (value: unknown) =>
    service.callback(id, value, { localToken: 'synthetic-direct-agent-token' });
  return {
    job,
    records,
    repository,
    audit,
    input,
    report,
    prepare,
    confirm,
    service,
    local,
    names,
    callback
  };
}

function resolutionFixture() {
  const source = {
    id,
    ownerId: operator.id,
    accountKey,
    plan: 'plus',
    action: 'bitbrowser',
    state: 'finished',
    createdAt: new Date('2026-10-16T01:00:00Z'),
    result: {
      transport: 'web_direct',
      checkout_identifier: checkout,
      status: 'payment_result_unknown',
      payment_attempted: true,
      confirmation_requests_sent: 1,
      payment_requests_sent: 1,
      payment_status: 'unknown',
      _direct_confirmation_v1: { consumed: true }
    } as Record<string, unknown>
  };
  const verification = {
    ...source,
    id: '22222222-2222-4222-8222-222222222222',
    createdAt: new Date('2026-10-16T02:00:00Z'),
    result: {
      transport: 'web_direct',
      recheck_only: true,
      account_matched: true,
      current_plan: 'free',
      payment_attempted: false,
      payment_requests_sent: 0,
      confirmation_requests_sent: 0
    } as Record<string, unknown>
  };
  const jobs = new Map([
    [id, source],
    [verification.id, verification]
  ]);
  const repository = {
    lock: vi.fn(),
    findRunningJob: vi.fn().mockResolvedValue(null),
    findJob: vi.fn(async (_tx, jobId) => jobs.get(jobId)),
    createJob: vi.fn(async (_tx, data) => {
      const job = { ...data, createdAt: new Date() };
      jobs.set(job.id, job);
      return job;
    }),
    updateJob: vi.fn(async (_tx, jobId, data) => Object.assign(jobs.get(jobId)!, data)),
    resolveUnknownPaymentRecords: vi.fn()
  };
  const settings = { runtime: vi.fn().mockRejectedValue(new Error('本测试不存在本机助手')) };
  const audit = { append: vi.fn() };
  const cards = { finishSharedCard: vi.fn() };
  const input = {
    sourceId: id,
    value: { confirmNoBankRequest: true, verificationJobId: verification.id },
    operator: operator as never,
    repository: repository as never,
    settings: settings as never,
    transactions: { execute: async (work: (tx: object) => unknown) => work({}) } as never,
    audit: audit as never,
    cards: cards as never
  };
  return { source, verification, jobs, repository, settings, audit, cards, input };
}

describe('网页未知付款在同一服务端事务内处理', () => {
  it('旧助手来源明确选择网页后也无需当前电脑助手，并拒绝false或字符串伪装', async () => {
    const f = resolutionFixture();
    delete f.source.result.transport;
    await expect(
      startUnknownPaymentResolution({ ...f.input, value: { ...f.input.value, directMode: true } })
    ).resolves.toMatchObject({ alreadyResolved: true });
    expect(f.settings.runtime).not.toHaveBeenCalled();
    for (const directMode of [false, 'true', 1]) {
      const other = resolutionFixture();
      await expect(
        startUnknownPaymentResolution({
          ...other.input,
          value: { ...other.input.value, directMode }
        })
      ).rejects.toThrow();
      expect(other.repository.createJob).not.toHaveBeenCalled();
    }
  });
  it('无需助手即可处理，并保留原付款事实与幂等结果', async () => {
    const f = resolutionFixture();
    const result = await startUnknownPaymentResolution(f.input);
    expect(result).toMatchObject({ alreadyResolved: true });
    expect(Object.keys(result).sort()).toEqual(['alreadyResolved', 'id']);
    expect(f.settings.runtime).not.toHaveBeenCalled();
    expect(f.source.result).toMatchObject({
      operator_resolution: 'confirmed_no_bank_request',
      payment_attempted: true,
      confirmation_requests_sent: 1,
      payment_requests_sent: 1,
      payment_status: 'unknown',
      _direct_confirmation_v1: { consumed: true }
    });
    expect(f.jobs.get(result.id)).toMatchObject({
      state: 'finished',
      nonceHash: null,
      result: { resolution_only: true, payment_attempted: false, payment_requests_sent: 0 }
    });
    expect(f.repository.resolveUnknownPaymentRecords).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountKey,
        checkoutIdentifier: checkout,
        ownerId: operator.id,
        sourceJobId: id,
        verificationJobId: f.verification.id
      })
    );
    expect(f.cards.finishSharedCard).toHaveBeenCalledWith(
      expect.anything(),
      id,
      { payment_attempted: false, payment_requests_sent: 0 },
      false
    );
    await expect(startUnknownPaymentResolution(f.input)).resolves.toEqual(result);
    expect(f.repository.createJob).toHaveBeenCalledOnce();
    expect(f.cards.finishSharedCard).toHaveBeenCalledOnce();
  });

  it.each(['owner', 'paid', 'wrong-account', 'older-verification', 'not-confirmed', 'running'])(
    '网页处理仍拒绝未核实输入：%s',
    async (reason) => {
      const f = resolutionFixture();
      if (reason === 'owner') f.source.ownerId = 'another-owner';
      if (reason === 'paid') f.source.result.payment_status = 'paid';
      if (reason === 'wrong-account') f.verification.accountKey = 'b'.repeat(64);
      if (reason === 'older-verification')
        f.verification.createdAt = new Date('2026-10-15T00:00:00Z');
      if (reason === 'not-confirmed') f.input.value.confirmNoBankRequest = false;
      if (reason === 'running') f.repository.findRunningJob.mockResolvedValue({ id: 'active' });
      await expect(startUnknownPaymentResolution(f.input)).rejects.toThrow();
      expect(f.repository.createJob).not.toHaveBeenCalled();
      expect(f.cards.finishSharedCard).not.toHaveBeenCalled();
    }
  );
});

describe('网页直连单次付款服务端门禁', () => {
  it('报价或账单在nonce生成后变化，即使摘要字段没有改变也不能付款', async () => {
    const f = fixture();
    const ready = await f.prepare();
    f.job.result.billing_fingerprint = 'd'.repeat(64);
    await expect(
      f.confirm({
        nonce: ready.nonce,
        quoteDigest: ready.quote_digest,
        checkoutIdentifier: checkout
      })
    ).rejects.toThrow('账单已变化');
    expect(f.repository.saveRecord).not.toHaveBeenCalled();
  });

  it('未确认网页任务可安全结束，已消费授权不能通过取消清零', async () => {
    const idle = fixture();
    const pending = await idle.prepare();
    await idle.local.cancel(id, operator as never);
    expect(idle.job.state).toBe('finished');
    expect(idle.names.releaseUnreceivedCard).toHaveBeenCalledWith(expect.anything(), id);
    await idle.local.cancel(id, operator as never);
    expect(idle.names.releaseUnreceivedCard).toHaveBeenCalledOnce();
    await expect(
      idle.confirm({
        nonce: pending.nonce,
        quoteDigest: pending.quote_digest,
        checkoutIdentifier: checkout
      })
    ).rejects.toThrow();
    const sent = fixture();
    const ready = await sent.prepare();
    await sent.confirm({
      nonce: ready.nonce,
      quoteDigest: ready.quote_digest,
      checkoutIdentifier: checkout
    });
    await expect(sent.local.cancel(id, operator as never)).rejects.toThrow('只能查看原单');
    expect(sent.names.releaseUnreceivedCard).not.toHaveBeenCalled();
    expect(sent.job.result).toMatchObject({
      payment_attempted: true,
      confirmation_requests_sent: 1,
      payment_requests_sent: 1,
      payment_status: 'unknown'
    });
  });

  it('取消不能绕过已消费的授权私有事实，即使外部计数缺失', async () => {
    const f = fixture();
    f.job.result._direct_confirmation_v1 = { consumed: true };
    await expect(f.local.cancel(id, operator as never)).rejects.toThrow('只能查看原单');
    expect(f.repository.updateJob).not.toHaveBeenCalled();
    expect(f.names.releaseUnreceivedCard).not.toHaveBeenCalled();
  });

  it('付款Intent须先持久绑定原确认响应，后续成功证据不能换PI或金额', async () => {
    const f = fixture();
    const ready = await f.prepare();
    await f.confirm({
      nonce: ready.nonce,
      quoteDigest: ready.quote_digest,
      checkoutIdentifier: checkout
    });
    const paid = {
      payment_status: 'paid',
      payment_evidence: {
        kind: 'payment_intent',
        identifier: 'pi_SyntheticDirect',
        amount_minor: 2000,
        currency: 'USD'
      }
    };
    await expect(
      persistDirectRechargeObservation({ ...f.input(), report: paid })
    ).rejects.toThrow();
    await f.callback({
      type: 'progress',
      result: { payment_intent_identifier: 'pi_SyntheticDirect' }
    });
    await expect(
      persistDirectRechargeObservation({ ...f.input(), report: paid })
    ).resolves.toBeUndefined();
    expect(() =>
      assertDirectRechargeReport(f.job as never, { payment_intent_identifier: 'pi_other' })
    ).toThrow();
    await expect(
      persistDirectRechargeObservation({
        ...f.input(),
        report: { ...paid, payment_evidence: { ...paid.payment_evidence, amount_minor: 1999 } }
      })
    ).rejects.toThrow();
  });

  it('实际回执入口生成确认，确认接口与已授权付款回传共用同一持久账本', async () => {
    const f = fixture();
    const prepared = (await f.callback({ type: 'direct_quote', result: f.report() })) as {
      nonce: string;
      quote_digest: string;
    };
    const request = {
      nonce: prepared.nonce,
      quoteDigest: prepared.quote_digest,
      checkoutIdentifier: checkout
    };
    await expect(f.service.confirm(id, request, operator as never)).resolves.toMatchObject({
      paymentAllowed: true
    });
    await f.callback({
      type: 'progress',
      result: {
        stage: 'payment_result',
        payment_status: 'paid',
        payment_attempted: true,
        payment_requests_sent: 1,
        confirmation_requests_sent: 1,
        payment_evidence: {
          kind: 'checkout_session',
          identifier: checkout,
          amount_minor: 2000,
          currency: 'USD'
        }
      }
    });
    expect([...f.records.values()][0]!.document).toMatchObject({ payment_status: 'paid' });
    await expect(f.service.confirm(id, request, operator as never)).rejects.toThrow();
  });

  it('未确认时实际回执入口不能绕过门禁，旧助手确认入口仍保持退役提示', async () => {
    const f = fixture();
    await expect(
      f.callback({ type: 'progress', result: { payment_attempted: true } })
    ).rejects.toThrow('单次付款授权');
    await expect(f.service.confirm(id, 'synthetic-old-nonce', operator as never)).rejects.toThrow(
      '本机充值助手'
    );
  });

  it('服务端保留直连运输标记，执行回执不能把任务改回旧助手路径绕过付款门禁', async () => {
    const f = fixture();
    await f.callback({
      type: 'progress',
      result: { stage: 'quote_read', transport: 'official_browser' }
    });
    expect(f.job.result.transport).toBe('web_direct');
    await expect(
      f.callback({ type: 'progress', result: { payment_requests_sent: 1 } })
    ).rejects.toThrow();
  });

  it('服务端生成绑定账单和原单的报价摘要，明文确认凭据不落库', async () => {
    const f = fixture();
    const response = await f.prepare();
    expect(response).toMatchObject({ ok: true });
    expect(response.nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(response.quote_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(f.job.state).toBe('awaiting_confirmation');
    expect(JSON.stringify(f.job.result)).not.toContain(response.nonce);
    const other = fixture();
    const changed = await other.prepare({ ...other.report(), billing_fingerprint: 'c'.repeat(64) });
    expect(changed.quote_digest).not.toBe(response.quote_digest);
  });

  it.each([
    { account_matched: false },
    { checkout_identifier: 'oaics_other' },
    { billing_fingerprint: '' },
    { quote: { ...quote, renewal: null } },
    { payment_attempted: true },
    { payment_requests_sent: 1 }
  ])('最终报价缺少可信绑定时停止 %j', async (change) => {
    const f = fixture();
    await expect(f.prepare({ ...f.report(), ...change })).rejects.toThrow();
    expect(f.repository.saveRecord).not.toHaveBeenCalled();
  });

  it('确认先持久保留付款记录，只放行一次；重复请求和丢失回执均不能再次放行', async () => {
    const f = fixture();
    const prepared = await f.prepare();
    const request = {
      nonce: prepared.nonce,
      quoteDigest: prepared.quote_digest,
      checkoutIdentifier: checkout
    };
    await expect(f.confirm(request)).resolves.toMatchObject({
      id,
      paymentAllowed: true,
      paymentRecordRevision: 1
    });
    expect(f.repository.saveRecord).toHaveBeenCalledTimes(1);
    expect([...f.records.values()][0]!.document).toMatchObject({
      payment_attempted: true,
      payment_status: 'unknown',
      confirmation_requests_sent: 1,
      payment_requests_sent: 1
    });
    await expect(f.confirm(request)).rejects.toThrow('只读核对原任务');
    expect(f.repository.saveRecord).toHaveBeenCalledTimes(1);
  });

  it('持久记录失败不放行，不消费确认资格', async () => {
    const f = fixture();
    const prepared = await f.prepare();
    f.repository.saveRecord.mockRejectedValueOnce(new Error('持久写入失败'));
    await expect(
      f.confirm({
        nonce: prepared.nonce,
        quoteDigest: prepared.quote_digest,
        checkoutIdentifier: checkout
      })
    ).rejects.toThrow('持久写入失败');
    expect(f.job.state).toBe('awaiting_confirmation');
    expect(f.job.result.payment_attempted).toBe(false);
  });

  it('过期或错误报价确认不产生付款记录', async () => {
    const f = fixture();
    const prepared = await f.prepare();
    await expect(
      f.confirm({
        nonce: prepared.nonce,
        quoteDigest: '0'.repeat(64),
        checkoutIdentifier: checkout
      })
    ).rejects.toThrow();
    (f.job.result._direct_confirmation_v1 as Record<string, unknown>).expiresAt = new Date(
      0
    ).toISOString();
    await expect(
      f.confirm({
        nonce: prepared.nonce,
        quoteDigest: prepared.quote_digest,
        checkoutIdentifier: checkout
      })
    ).rejects.toThrow();
    expect(f.repository.saveRecord).not.toHaveBeenCalled();
  });

  it('未授权回执不能伪造付款或确认次数', () => {
    const f = fixture();
    expect(() => assertDirectRechargeReport(f.job as never, { payment_attempted: true })).toThrow();
    expect(() =>
      assertDirectRechargeReport(f.job as never, { confirmation_requests_sent: 1 })
    ).toThrow();
  });

  it('授权后观察到的付款结果更新同一付款记录，不遗留未知状态或更换报价', async () => {
    const f = fixture();
    const prepared = await f.prepare();
    await f.confirm({
      nonce: prepared.nonce,
      quoteDigest: prepared.quote_digest,
      checkoutIdentifier: checkout
    });
    const report = {
      payment_status: 'paid',
      payment_evidence: {
        kind: 'checkout_session',
        identifier: checkout,
        amount_minor: 2000,
        currency: 'USD'
      }
    };
    await persistDirectRechargeObservation({ ...f.input(), report });
    expect([...f.records.values()][0]!.document).toMatchObject(report);
    expect([...f.records.values()][0]!.revision).toBe(2);
    expect(() =>
      assertDirectRechargeReport(f.job as never, { checkout_identifier: 'oaics_other' })
    ).toThrow();
  });
});
