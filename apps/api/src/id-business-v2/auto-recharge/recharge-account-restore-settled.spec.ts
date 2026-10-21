import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { restoreRechargeAccount } from './recharge-account-restore';
import { RechargeRepository } from './persistence/recharge.repository';

const accountKey = 'a'.repeat(64);
const sourceJobId = '22222222-2222-4222-8222-222222222222';
const identifier = 'cs_original';
function fixture(closed: boolean) {
  const proof = {
    version: 1,
    outcome: 'failure',
    operationId: '33333333-3333-4333-8333-333333333333',
    sourceJobId,
    operatorId: '44444444-4444-4444-8444-444444444444',
    accountKey,
    identifier,
    plan: 'plus',
    resolvedAt: '2026-10-21T06:36:00.000Z',
    requestDigest: 'd'.repeat(64)
  };
  const record = {
    accountKey,
    ownerId: 'owner',
    fileKey: `${accountKey}.json`,
    revision: 8,
    document: {
      account_key: accountKey,
      target_plan: 'plus',
      status: 'checkout_created',
      checkout_outcome: 'created',
      checkout_identifier: identifier,
      processor_entity: 'openai_llc',
      checkout_recovered_from_original: true,
      expired_checkout_replacement: {},
      payment_attempted: false,
      payment_requests_sent: 0,
      confirmation_requests_sent: 0,
      ...(closed ? { manual_settlement: proof } : {})
    }
  };
  const payment = {
    accountKey,
    ownerId: 'owner',
    revision: 10,
    fileKey: `payments/${createHash('sha256').update(identifier).digest('hex')}.json`,
    document: {
      account_key: accountKey,
      target_plan: 'plus',
      checkout_identifier: identifier,
      status: 'payment_result_unknown',
      payment_status: 'unknown',
      payment_attempted: true,
      payment_requests_sent: 1,
      confirmation_requests_sent: 1,
      ...(closed ? { manual_settlement: proof } : {})
    }
  };
  const actual = new RechargeRepository({} as never);
  const repository = {
    records: vi.fn().mockResolvedValue([record, payment]),
    retainedProfileForAccount: vi.fn().mockResolvedValue(undefined),
    finishedJobsForUnidentifiedCheckout: vi.fn().mockResolvedValue([]),
    originalCheckoutForAccount: vi.fn().mockResolvedValue(undefined),
    restoreCheckoutIdentifier: actual.restoreCheckoutIdentifier.bind(actual),
    updateJob: vi.fn().mockResolvedValue(undefined)
  };
  const job = {
    id: '11111111-1111-4111-8111-111111111111',
    ownerId: 'owner',
    accountKey: null,
    action: 'bitbrowser',
    state: 'running',
    plan: 'plus',
    createdAt: new Date('2026-10-21T07:00:00.000Z'),
    result: { transport: 'web_direct', mode: 'payment', payment_requests_sent: 0 }
  };
  return {
    record,
    payment,
    repository,
    run: () =>
      restoreRechargeAccount({
        tx: {} as never,
        job: job as never,
        repository: repository as never,
        callback: { accountKey }
      })
  };
}

describe('人工失败后残留过期单恢复标记', () => {
  it('保留已核实失败账本，允许新任务读取凭据并继续，不能再次核验旧恢复来源', async () => {
    const f = fixture(true);
    const before = structuredClone([f.record, f.payment]);
    const restored = await f.run();
    expect(restored.originalCheckoutIdentifier).toBe(identifier);
    expect(f.repository.finishedJobsForUnidentifiedCheckout).not.toHaveBeenCalled();
    expect(restored.records).toEqual(before);
    expect([f.record, f.payment]).toEqual(before);
  });
  it('尚未核实失败的原单继续要求完整恢复来源', async () => {
    const f = fixture(false);
    await expect(f.run()).rejects.toThrow('已发现原单的恢复来源尚未完整核实');
    expect(f.repository.updateJob).not.toHaveBeenCalled();
  });

  it.each([
    { requestDigest: 'invalid' },
    { accountKey: 'b'.repeat(64) },
    { identifier: 'cs_other' },
    { outcome: 'success' }
  ])('无效或不匹配的人工处理凭据不解除恢复保护 %j', async (patch) => {
    const f = fixture(true);
    Object.assign(f.record.document.manual_settlement!, patch);
    await expect(f.run()).rejects.toThrow('已发现原单的恢复来源尚未完整核实');
    expect(f.repository.updateJob).not.toHaveBeenCalled();
  });
});
