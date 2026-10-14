import { afterEach, describe, expect, it, vi } from 'vitest';
import { RechargeRepository } from './persistence/recharge.repository';
import { RechargeService } from './recharge.service';
import { RechargeLocalService } from './recharge-local.service';
import { hash, safeDocument } from './recharge-validation';
import { rechargeDocumentDigest } from './recharge-callback-receipts';

const id = '11111111-1111-4111-8111-111111111111';
const addressId = '22222222-2222-4222-8222-222222222222';
const accountKey = 'a'.repeat(64);
const token = 'synthetic-receipt-token';
const checkout = 'cs_synthetic_receipt';
const money = { amount: '20.00', amount_minor: 2000, currency: 'USD' };
const quote = {
  plan: 'plus',
  today: money,
  tax: { ...money, amount: '0.00', amount_minor: 0 },
  renewal: money,
  renewal_interval: 'monthly'
};
const evidence = {
  kind: 'checkout_session',
  identifier: checkout,
  amount_minor: 2000,
  currency: 'USD'
};
const operator = {
  id: 'synthetic-owner',
  username: 'synthetic',
  displayName: '合成验收',
  roles: ['admin'],
  permissions: []
};

function fixture() {
  const job = {
    id,
    ownerId: operator.id,
    accountKey,
    action: 'bitbrowser',
    state: 'running',
    plan: 'plus',
    nonceHash: hash(token),
    leaseUntil: new Date(Date.now() + 45 * 60000),
    createdAt: new Date(),
    cardId: null,
    chatgptAccountId: null,
    result: {
      mode: 'payment',
      status: 'payment_ready',
      account_matched: true,
      addressId,
      checkout_identifier: checkout,
      quote,
      quote_digest: 'b'.repeat(64),
      quote_authority: 'official_checkout_response',
      payment_attempted: false,
      payment_requests_sent: 0,
      confirmation_requests_sent: 0
    } as Record<string, unknown>
  };
  const records = new Map<string, Record<string, unknown>>();
  const tx = {
    idBusinessV2RechargeJob: {
      findUnique: vi.fn(async () => job),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async ({ data }) => Object.assign(job, data))
    },
    idBusinessV2RechargeRecord: {
      findUnique: vi.fn(async ({ where }) => records.get(where.accountKey_fileKey.fileKey) ?? null),
      findMany: vi.fn(async () => [...records.values()]),
      upsert: vi.fn(async ({ create }) => {
        records.set(create.fileKey, create);
        return create;
      })
    }
  };
  const repository = new RechargeRepository({
    idBusinessV2RechargeJob: { findMany: async () => [job] }
  } as never);
  const lock = vi.spyOn(repository, 'lock').mockResolvedValue(undefined);
  const used = new Set<string>();
  const addresses = {
    markUsed: vi.fn(async (_tx, _owner, _address, jobId) => {
      const changed = !used.has(jobId);
      used.add(jobId);
      return { changed, before: { status: 'available' }, after: { status: 'used' } };
    })
  };
  const audit = { append: vi.fn() };
  const transactions = { execute: vi.fn(async (work) => work(tx)) };
  const orders = { recordVerifiedSuccess: vi.fn(async () => null) };
  const service = new RechargeService(
    repository,
    addresses as never,
    transactions as never,
    audit as never,
    undefined,
    orders as never
  );
  const local = new RechargeLocalService(
    repository,
    addresses as never,
    {} as never,
    service,
    transactions as never,
    audit as never
  );
  const callback = (input: unknown, credential = token) => local.callback(id, credential, input);
  const payment = (paid = false) => ({
    ...safeDocument(job.result),
    account_key: accountKey,
    target_plan: 'plus',
    payment_attempted: true,
    payment_requests_sent: 1,
    confirmation_requests_sent: 1,
    payment_status: paid ? 'paid' : 'unknown',
    ...(paid
      ? {
          payment_evidence: evidence,
          status: 'subscription_activated',
          payment_outcome: 'subscription_activated',
          account_matched: true
        }
      : { status: 'payment_result_unknown' })
  });
  return {
    job,
    tx,
    repository,
    lock,
    addresses,
    audit,
    orders,
    service,
    local,
    callback,
    records,
    payment
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('本机回执恢复、单调取消和精确账本重放', () => {
  it('启动恢复被拒后的结束回执保存诊断，列表读取和精确重放均保留且不写付款账本', async () => {
    const f = fixture();
    f.job.accountKey = null as never;
    f.job.result = {
      status: 'waiting_local_connector',
      stage: 'connector_dispatch',
      payment_attempted: false,
      payment_requests_sent: 0
    };
    const result = {
      status: 'blocked',
      reason: 'durable_state_unavailable',
      payment_attempted: false,
      payment_requests_sent: 0,
      callback_operation: 'restore',
      callback_failure_kind: 'http',
      callback_http_status: 409,
      callback_error_code: 'CONFLICT',
      callback_request_id: id,
      callback_business_reason: 'callback_previous_payment_unverified'
    };
    const terminal = { type: 'finished', result };
    await expect(f.callback(terminal)).resolves.toEqual({ ok: true });
    expect(f.job.state).toBe('finished');
    expect(f.job.result).toMatchObject(result);
    const list = await f.service.list(operator);
    expect(list.items[0].result).toMatchObject(result);
    const writes = f.tx.idBusinessV2RechargeJob.update.mock.calls.length;
    await expect(f.callback(terminal)).resolves.toEqual({ ok: true });
    expect(f.tx.idBusinessV2RechargeJob.update).toHaveBeenCalledTimes(writes);
    expect(f.records.size).toBe(0);
    expect(f.tx.idBusinessV2RechargeRecord.upsert).not.toHaveBeenCalled();
    expect(f.addresses.markUsed).not.toHaveBeenCalled();
  });
  it('认证在事务锁内读取最新nonce，旧凭据无权写入任何结果', async () => {
    const f = fixture();
    vi.mocked(f.repository.lock).mockImplementation(async () => {
      f.job.nonceHash = null as never;
    });
    await expect(f.callback({ type: 'finished', result: {} })).rejects.toThrow('本机连接凭据无效');
    expect(f.tx.idBusinessV2RechargeJob.findUnique).toHaveBeenCalledAfter(f.lock);
    expect(f.tx.idBusinessV2RechargeJob.update).not.toHaveBeenCalled();
  });

  it('终态精确重放跨API重启可确认，凭据保持清空，所有业务写入只发生一次', async () => {
    const f = fixture();
    const terminal = {
      type: 'finished',
      result: {
        status: 'blocked',
        reason: 'synthetic_failure',
        payment_attempted: false,
        payment_requests_sent: 0,
        network: { ip: '127.0.0.1', country: 'US' }
      }
    };
    await expect(f.callback(terminal)).resolves.toEqual({ ok: true });
    const before = structuredClone(f.job);
    const writes = f.tx.idBusinessV2RechargeJob.update.mock.calls.length;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 60000));
    await expect(f.callback(terminal)).resolves.toEqual({ ok: true });
    expect(f.job).toEqual(before);
    expect(f.job.nonceHash).toBeNull();
    expect(f.tx.idBusinessV2RechargeJob.update).toHaveBeenCalledTimes(writes);
    expect(f.addresses.markUsed).not.toHaveBeenCalled();
    expect(f.orders.recordVerifiedSuccess).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.job.result)).not.toContain(token);
    const list = await f.service.list(operator);
    expect(JSON.stringify(list)).not.toContain('_callback_private_v1');
    expect(JSON.stringify(list)).not.toContain('identityHash');
    await expect(f.callback(terminal, 'synthetic-other-token')).rejects.toThrow('凭据无效');
    await expect(f.callback({ type: 'progress', result: {} })).rejects.toThrow('凭据无效');
  });

  it.each(['_callback_private_v1', '_subscription_cycle_private_v1'])(
    '客户端不能写私有命名空间 %s',
    async (key) => {
      const f = fixture();
      await expect(
        f.callback({ type: 'finished', result: { [key]: { identityHash: hash(token) } } })
      ).rejects.toThrow('内部字段');
      expect(f.repository.lock).not.toHaveBeenCalled();
      expect(f.tx.idBusinessV2RechargeJob.update).not.toHaveBeenCalled();
    }
  );

  it('重复取消和迟到普通进度保持第一次五分钟截止，不更新任务和审计', async () => {
    const f = fixture();
    await f.local.cancel(id, operator);
    const deadline = f.job.leaseUntil.getTime();
    const auditCount = f.audit.append.mock.calls.length;
    const writes = f.tx.idBusinessV2RechargeJob.update.mock.calls.length;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 60000));
    await f.local.cancel(id, operator);
    await f.callback({
      type: 'progress',
      result: { status: 'awaiting_confirmation', stage: 'session_ready' }
    });
    expect(f.job.leaseUntil.getTime()).toBe(deadline);
    expect(f.job.result.status).toBe('cancelling');
    expect(f.audit.append).toHaveBeenCalledTimes(auditCount);
    expect(f.tx.idBusinessV2RechargeJob.update).toHaveBeenCalledTimes(writes);
  });

  it('完成为未知后可补收原单真实已付款，终态和租约不恢复，首次回执摘要不被覆盖', async () => {
    const f = fixture();
    Object.assign(f.job.result, { current_plan: 'free', subscription_status: 'not_verified' });
    const first = { type: 'finished', result: f.payment() };
    await f.callback(first);
    const privateBefore = f.job.result._callback_private_v1 as Record<string, unknown>;
    const lease = f.job.leaseUntil.getTime();
    f.tx.idBusinessV2RechargeJob.findFirst.mockRejectedValue(new Error('不能重新占执行资源'));
    const success = {
      type: 'finished',
      result: {
        ...f.payment(true),
        current_plan: 'plus',
        current_tier: 'plus',
        subscription_status: 'active'
      }
    };
    await f.callback(success);
    expect(f.job).toMatchObject({
      state: 'finished',
      nonceHash: null,
      result: {
        status: 'subscription_activated',
        payment_status: 'paid',
        payment_evidence: evidence,
        payment_requests_sent: 1,
        current_plan: 'plus',
        current_tier: 'plus',
        subscription_status: 'active',
        account_matched: true
      }
    });
    expect(f.job.leaseUntil.getTime()).toBe(lease);
    const privateAfter = f.job.result._callback_private_v1 as Record<string, unknown>;
    expect(privateAfter.firstTerminalDigest).toBe(privateBefore.firstTerminalDigest);
    expect(privateAfter.latestFactDigest).not.toBe(privateAfter.firstTerminalDigest);
    const writes = f.tx.idBusinessV2RechargeJob.update.mock.calls.length;
    const auditCount = f.audit.append.mock.calls.length;
    await f.callback(success);
    await f.callback(first);
    expect(f.job.result.payment_status).toBe('paid');
    expect(f.tx.idBusinessV2RechargeJob.update).toHaveBeenCalledTimes(writes);
    expect(f.audit.append).toHaveBeenCalledTimes(auditCount);
  });

  it('租约过期后的原付款账本事实可保存，不续租且不再次占用员工/窗口', async () => {
    const f = fixture();
    f.job.leaseUntil = new Date(Date.now() - 1000);
    const lease = f.job.leaseUntil.getTime();
    f.tx.idBusinessV2RechargeJob.findFirst.mockRejectedValue(new Error('不能重新占执行资源'));
    const receipt = {
      type: 'ledger',
      accountKey,
      fileKey: `payments/${hash(checkout)}.json`,
      revision: 0,
      document: f.payment()
    };
    await expect(f.callback(receipt)).resolves.toEqual({ revision: 1 });
    expect(f.job.leaseUntil.getTime()).toBe(lease);
    expect(f.job.result.payment_requests_sent).toBe(1);
    const writes = f.tx.idBusinessV2RechargeJob.update.mock.calls.length;
    const auditCount = f.audit.append.mock.calls.length;
    await expect(f.callback(receipt)).resolves.toEqual({ revision: 1 });
    expect(f.tx.idBusinessV2RechargeRecord.upsert).toHaveBeenCalledTimes(1);
    expect(f.tx.idBusinessV2RechargeJob.update).toHaveBeenCalledTimes(writes);
    expect(f.audit.append).toHaveBeenCalledTimes(auditCount);
  });

  it.each([
    { account_key: 'c'.repeat(64) },
    { checkout_identifier: 'cs_other' },
    { quote_digest: 'c'.repeat(64) },
    { payment_requests_sent: 2 },
    { quote: { ...quote, today: { ...money, amount: '21.00', amount_minor: 2100 } } },
    { payment_evidence: { ...evidence, currency: 'MYR' } }
  ])('过期任务不能补收其他账户、订单、报价或无效金额/次数：%j', async (patch) => {
    const f = fixture();
    f.job.leaseUntil = new Date(0);
    await expect(
      f.callback({ type: 'finished', result: { ...f.payment(true), ...patch } })
    ).rejects.toThrow();
    expect(f.tx.idBusinessV2RechargeJob.update).not.toHaveBeenCalled();
    expect(f.tx.idBusinessV2RechargeRecord.upsert).not.toHaveBeenCalled();
    expect(f.addresses.markUsed).not.toHaveBeenCalled();
  });

  it('旧助手未发送新增account_key/quote_digest仍可按绑定原单和报价收据补收', async () => {
    const f = fixture();
    f.job.leaseUntil = new Date(0);
    const report = f.payment(true) as Record<string, unknown>;
    delete report.account_key;
    delete report.quote_digest;
    await expect(f.callback({ type: 'finished', result: report })).resolves.toEqual({ ok: true });
    expect(f.job.result.payment_status).toBe('paid');
  });

  it('历史nonce已经清空而没有收据摘要的任务继续保持只读', async () => {
    const f = fixture();
    f.job.nonceHash = null as never;
    f.job.state = 'finished';
    await expect(f.callback({ type: 'finished', result: f.payment(true) })).rejects.toThrow(
      '凭据无效'
    );
    expect(f.tx.idBusinessV2RechargeJob.update).not.toHaveBeenCalled();
  });

  it('未绑定原账号或原订单不能凭迟到真实样式回执推定归属', async () => {
    for (const missing of ['account', 'operation']) {
      const f = fixture();
      f.job.leaseUntil = new Date(0);
      const result = f.payment(true);
      if (missing === 'account') f.job.accountKey = null as never;
      else delete f.job.result.checkout_identifier;
      await expect(f.callback({ type: 'finished', result })).rejects.toThrow('原账户');
      expect(f.tx.idBusinessV2RechargeJob.update).not.toHaveBeenCalled();
    }
  });

  it('取消截止过期后仍能收回零付款停止确认，结束不续租，精确回执可重复确认', async () => {
    const f = fixture();
    await f.local.cancel(id, operator);
    const deadline = f.job.leaseUntil.getTime();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(deadline + 1000));
    const terminal = {
      type: 'finished',
      result: {
        status: 'cancelled',
        cancellation_confirmed: true,
        payment_attempted: false,
        confirmation_requests_sent: 0,
        payment_requests_sent: 0
      }
    };
    await expect(f.callback(terminal)).resolves.toEqual({ ok: true });
    const writes = f.tx.idBusinessV2RechargeJob.update.mock.calls.length;
    await expect(f.callback(terminal)).resolves.toEqual({ ok: true });
    expect(f.job).toMatchObject({
      state: 'finished',
      nonceHash: null,
      result: { status: 'cancelled' }
    });
    expect(f.job.leaseUntil.getTime()).toBe(deadline);
    expect(f.tx.idBusinessV2RechargeJob.update).toHaveBeenCalledTimes(writes);
  });

  it('升级迟到回执不能更换已绑定发票或付款意图引用', async () => {
    const f = fixture();
    const upgrade = 'upg_' + 'a'.repeat(32);
    Object.assign(f.job.result, {
      operation: 'subscription_upgrade',
      upgrade_identifier: upgrade,
      current_plan_before: 'go',
      target_plan: 'plus',
      upgrade_invoice_identifier: 'in_original',
      quote_authority: 'official_upgrade_preview'
    });
    f.job.leaseUntil = new Date(0);
    await expect(
      f.callback({
        type: 'finished',
        result: {
          ...f.payment(true),
          upgrade_invoice_identifier: 'in_other',
          payment_evidence: { ...evidence, kind: 'invoice', identifier: 'in_other' }
        }
      })
    ).rejects.toThrow('原订单');
    expect(f.tx.idBusinessV2RechargeJob.update).not.toHaveBeenCalled();
  });

  it('已核实订阅成功不能被迟到失败退回免费版，官网已核实账期不可替换', async () => {
    const f = fixture();
    const period = {
      source: 'official_subscription_response',
      account_key: accountKey,
      target_plan: 'plus',
      start: '2026-10-01T00:00:00.000Z',
      end: '2026-11-01T00:00:00.000Z'
    };
    await f.callback({
      type: 'finished',
      result: {
        ...f.payment(true),
        current_plan: 'plus',
        current_tier: 'plus',
        subscription_status: 'active',
        subscription_period: period
      }
    });
    await f.callback({
      type: 'finished',
      result: {
        ...f.payment(),
        payment_outcome: 'pending',
        current_plan: 'free',
        subscription_status: 'not_verified'
      }
    });
    expect(f.job.result).toMatchObject({
      current_plan: 'plus',
      current_tier: 'plus',
      subscription_status: 'active',
      payment_status: 'paid',
      status: 'subscription_activated',
      subscription_period: period
    });
    await expect(
      f.callback({
        type: 'finished',
        result: {
          ...f.payment(true),
          subscription_period: { ...period, start: '2026-10-02T00:00:00.000Z' }
        }
      })
    ).rejects.toThrow('原报价');
  });

  it('精确账本重放也不能借用其他员工的记录', async () => {
    const f = fixture();
    const receipt = {
      type: 'ledger',
      accountKey,
      fileKey: `payments/${hash(checkout)}.json`,
      revision: 0,
      document: f.payment()
    };
    f.records.set(receipt.fileKey, {
      ownerId: 'synthetic-other-owner',
      revision: 1,
      fileKey: receipt.fileKey,
      document: safeDocument(receipt.document)
    });
    await expect(f.callback(receipt)).rejects.toThrow('版本冲突');
    expect(f.tx.idBusinessV2RechargeRecord.upsert).not.toHaveBeenCalled();
    expect(f.addresses.markUsed).not.toHaveBeenCalled();
  });

  it('迟到零付款取消确认不能覆盖已经回收的付款事实', async () => {
    const f = fixture();
    await f.local.cancel(id, operator);
    await f.callback({
      type: 'ledger',
      accountKey,
      fileKey: `payments/${hash(checkout)}.json`,
      revision: 0,
      document: f.payment()
    });
    const before = structuredClone(f.job);
    await f.callback({
      type: 'finished',
      result: {
        cancellation_confirmed: true,
        payment_attempted: false,
        payment_requests_sent: 0,
        confirmation_requests_sent: 0,
        status: 'cancelled'
      }
    });
    expect(f.job).toEqual(before);
    expect(f.job.result.payment_attempted).toBe(true);
  });

  it('n→n+1只有完整规范内容相同才重放；派生observedAt不导致假冲突', async () => {
    const f = fixture();
    const receipt = {
      type: 'ledger',
      accountKey,
      fileKey: `${accountKey}.json`,
      revision: 0,
      document: { checkout_identifier: checkout, network: { ip: '127.0.0.1', country: 'US' } }
    };
    await f.callback(receipt);
    const auditCount = f.audit.append.mock.calls.length;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 60000));
    await expect(f.callback(receipt)).resolves.toEqual({ revision: 1 });
    expect(f.audit.append).toHaveBeenCalledTimes(auditCount);
    expect(f.tx.idBusinessV2RechargeRecord.upsert).toHaveBeenCalledTimes(1);
    await expect(
      f.callback({ ...receipt, document: { ...receipt.document, stage: 'changed' } })
    ).rejects.toThrow('版本冲突');
    await expect(f.callback({ ...receipt, revision: 2 })).rejects.toThrow('版本冲突');
  });

  it('付费证据不可替换，已付款次数和金额不能回退', async () => {
    const f = fixture();
    const receipt = {
      type: 'ledger',
      accountKey,
      fileKey: `payments/${hash(checkout)}.json`,
      revision: 0,
      document: f.payment(true)
    };
    await f.callback(receipt);
    await expect(
      f.callback({
        ...receipt,
        revision: 1,
        document: { ...receipt.document, payment_evidence: { ...evidence, identifier: 'cs_other' } }
      })
    ).rejects.toThrow('不能回退');
    await expect(
      f.callback({
        ...receipt,
        revision: 1,
        document: { ...receipt.document, confirmation_requests_sent: 0 }
      })
    ).rejects.toThrow('不能回退');
    expect(f.tx.idBusinessV2RechargeRecord.upsert).toHaveBeenCalledTimes(1);
  });

  it('规范摘要不受对象键序影响，仍纳入币种、金额及客户端时间内容', () => {
    expect(
      rechargeDocumentDigest({ b: 1, a: { y: 2, x: 3 }, network: { observedAt: 'a', ip: 'x' } })
    ).toBe(
      rechargeDocumentDigest({ network: { ip: 'x', observedAt: 'b' }, a: { x: 3, y: 2 }, b: 1 })
    );
    expect(rechargeDocumentDigest({ observedAt: 'a' })).not.toBe(
      rechargeDocumentDigest({ observedAt: 'b' })
    );
  });
});
