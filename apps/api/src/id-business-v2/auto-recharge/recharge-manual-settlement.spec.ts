import { describe, expect, it, vi } from 'vitest';
import { settleRechargeManually } from './recharge-manual-settlement';
import { hash, object, safeDocument } from './recharge-validation';
import { manualRechargeSettlement } from './recharge-manual-settlement-proof';
import { assertNoPrivateRechargeCallback } from './recharge-callback-receipts';
import { rechargeAvailability } from './recharge-availability';
import { cycleSources, safeUnpaidCycleCheckout } from './recharge-cycle-state';
import { recoverRechargePaymentResult } from './recharge-payment-facts';
import { unknownPaymentCanBeResolved } from './recharge-resolution';
import { declinedResolutionEligible } from './recharge-noncharge-proof';
import { SharedBankCardRepository } from '../bank-card-pool/persistence/shared-bank-card.repository';
import { RechargeService } from './recharge.service';
import type { IdBusinessV2RechargeJob } from '@prisma/client';

const id = '11111111-1111-4111-8111-111111111111';
const operatorId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const orderId = '44444444-4444-4444-8444-444444444444';
const siblingId = '55555555-5555-4555-8555-555555555555';
const key = 'a'.repeat(64),
  checkout = 'oaics_synthetic_manual';
const token = 'synthetic-test-only';
function fixture(plan = 'plus') {
  const facts = {
    target_plan: plan,
    account_key: key,
    checkout_identifier: checkout,
    payment_status: 'requires_action',
    payment_attempted: true,
    payment_requests_sent: 1,
    confirmation_requests_sent: 1,
    status: 'payment_result_unknown'
  };
  const source = {
    id,
    ownerId: operatorId,
    accountKey: key,
    plan,
    action: 'bitbrowser',
    state: 'finished',
    cardId: 'legacy-card',
    nonceHash: hash(token),
    createdAt: new Date('2026-10-17T10:00:00.000Z'),
    updatedAt: new Date('2026-10-17T10:02:00.000Z'),
    leaseUntil: new Date(0),
    result: {
      ...facts,
      _shared_card_attempt_v1: {
        cardId: 'original-card',
        authorizedAt: '2026-10-17T10:01:00.000Z',
        outcome: 'pending'
      }
    }
  } as unknown as IdBusinessV2RechargeJob;
  const sibling = {
    ...source,
    id: siblingId,
    result: { ...facts, recheck_only: true, confirmation_requests_sent: 0 }
  } as IdBusinessV2RechargeJob;
  const unrelated = {
    ...source,
    id: orderId,
    result: { ...facts, checkout_identifier: 'oaics_other' }
  } as IdBusinessV2RechargeJob;
  const records = [
    {
      ownerId: operatorId,
      accountKey: key,
      fileKey: `${key}${plan === 'plus' ? '' : `-${plan}`}.json`,
      revision: 2,
      document: {
        ...facts,
        payment_attempted: false,
        payment_status: 'not_attempted',
        confirmation_requests_sent: 0
      }
    },
    {
      ownerId: operatorId,
      accountKey: key,
      fileKey: `payments/${hash(checkout)}.json`,
      revision: 3,
      document: { ...facts }
    },
    {
      ownerId: operatorId,
      accountKey: key,
      fileKey: 'history/old.json',
      revision: 1,
      document: { ...facts }
    }
  ] as {
    ownerId: string;
    accountKey: string;
    fileKey: string;
    revision: number;
    document: Record<string, unknown>;
  }[];
  const card: Record<string, unknown> = {
    id: 'original-card',
    numberHash: hash('synthetic-card-identity'),
    leaseOwner: 'new-account-job',
    successCount: 0,
    declineCount: 0,
    status: 'active'
  };
  const tx = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    idBusinessV2RechargeJob: { findMany: vi.fn(async () => [source, sibling, unrelated]) },
    idBusinessV2RechargeRecord: {
      update: vi.fn(async ({ where, data }) => {
        const record = records.find((r) => r.fileKey === where.accountKey_fileKey.fileKey)!;
        record.document = data.document;
        record.revision += data.revision.increment;
      })
    },
    idBusinessV2BankRechargeCard: {
      findUnique: vi.fn(async ({ where }) =>
        where.id === 'legacy-card'
          ? { id: 'legacy-card', numberHash: hash('synthetic-card-identity') }
          : null
      )
    },
    onlineRechargeConfig: { findUnique: vi.fn(async () => null) },
    onlineRechargeCard: {
      findUnique: vi.fn(async () => card),
      updateMany: vi.fn(async ({ where, data }) => {
        if (where.leaseOwner && where.leaseOwner !== card.leaseOwner) return { count: 0 };
        for (const [k, v] of Object.entries(data))
          card[k] =
            v && typeof v === 'object' && 'increment' in v
              ? Number(card[k]) + Number(v.increment)
              : v;
        return { count: 1 };
      })
    }
  };
  const repository = {
    lock: vi.fn(),
    findJob: vi.fn(async () => source),
    records: vi.fn(async () => records),
    updateJob: vi.fn(async (_tx, jobId, data) => {
      const job = [source, sibling, unrelated].find((j) => j.id === jobId)!;
      Object.assign(job, data, { updatedAt: new Date() });
      return job;
    })
  };
  const pool = new SharedBankCardRepository({} as never, {} as never, {} as never, {} as never);
  const cards = {
    assertSharedAttemptBinding: vi.fn(
      (...args: Parameters<typeof pool.assertBitBrowserAttemptBinding>) =>
        pool.assertBitBrowserAttemptBinding(...args)
    ),
    finishSharedCard: vi.fn((...args: Parameters<typeof pool.finishBitBrowser>) =>
      pool.finishBitBrowser(...args)
    )
  };
  const orders = {
    recordManualSettlement: vi.fn(async () => ({ id: orderId })),
    assertNoOrderForManualFailure: vi.fn()
  };
  const audit = { append: vi.fn() };
  const operator = { id: operatorId, roles: ['admin'] } as never;
  const failure = {
    outcome: 'failure',
    operationId,
    expectedUpdatedAt: source.updatedAt.toISOString(),
    identifier: checkout,
    confirmed: true,
    reason: '核对银行及订阅未成功',
    noDebitConfirmed: true,
    notActivatedConfirmed: true
  };
  const success = {
    outcome: 'success',
    operationId,
    expectedUpdatedAt: source.updatedAt.toISOString(),
    identifier: checkout,
    confirmed: true,
    reason: '核对银行及订阅成功',
    subscriptionConfirmed: true,
    amount: '982.14',
    currency: 'PHP',
    evidenceRef: 'BANK-SYNTHETIC-A',
    openedAt: '2026-10-17T10:02:00.000Z',
    dueAt: '2026-11-17T10:02:00.000Z'
  };
  const run = (value: unknown = failure) =>
    settleRechargeManually({
      tx: tx as never,
      repository: repository as never,
      orders: orders as never,
      cards: cards as never,
      audit: audit as never,
      id,
      value,
      operator
    });
  return {
    source,
    sibling,
    unrelated,
    records,
    card,
    tx,
    repository,
    cards,
    orders,
    audit,
    operator,
    failure,
    success,
    run
  };
}

describe('原付款人工结单', () => {
  it('失败释放原单额度和防重，保留事实、历史、其他订单及新银行卡租约', async () => {
    const f = fixture(),
      before = structuredClone(f.records);
    expect(rechargeAvailability(f.source, f.records).accountPaymentRestricted).toBe(true);
    await expect(f.run()).resolves.toMatchObject({ id, alreadyResolved: false });
    expect(f.orders.recordManualSettlement).not.toHaveBeenCalled();
    expect(f.card).toMatchObject({
      leaseOwner: 'new-account-job',
      successCount: 0,
      declineCount: 0
    });
    expect(object(f.source.result)._shared_card_attempt_v1).toMatchObject({ outcome: 'resolved' });
    expect(object(f.source.result)).toMatchObject({
      payment_attempted: true,
      confirmation_requests_sent: 1,
      payment_status: 'requires_action'
    });
    expect(f.records.slice(0, 2).map((r) => r.revision)).toEqual([3, 4]);
    for (let i = 0; i < 2; i++) expect(f.records[i]!.document).toMatchObject(before[i]!.document);
    expect(f.records[2]).toEqual(before[2]);
    expect(object(f.unrelated.result).manual_settlement).toBeUndefined();
    expect(manualRechargeSettlement(f.sibling.result)).toMatchObject({
      sourceJobId: id,
      outcome: 'failure'
    });
    expect(rechargeAvailability(f.source, f.records)).toMatchObject({
      payment: 'resolved',
      accountPaymentRestricted: false
    });
    expect(cycleSources(f.records, f.source)).toEqual([]);
    expect(safeUnpaidCycleCheckout(f.records[0]!.document)).toBe(true);
    expect(
      recoverRechargePaymentResult(
        f.source,
        f.records.map((record) => ({ ...record, updatedAt: new Date() }))
      )
    ).toEqual(f.source.result);
    expect(unknownPaymentCanBeResolved(f.source)).toBe(false);
    expect(declinedResolutionEligible(f.source)).toBe(false);
    await expect(f.run()).resolves.toMatchObject({ alreadyResolved: true });
    expect(f.audit.append).toHaveBeenCalledOnce();
    expect(f.cards.finishSharedCard).toHaveBeenCalledOnce();
    await expect(f.run(f.success)).rejects.toThrow('已经结单');
  });
  it.each(['go', 'plus', 'pro-5x', 'pro-20x', 'pro-500'])(
    '%s 成功关联原任务一次结算，不冒充官网回执',
    async (plan) => {
      const f = fixture(plan);
      const result = await f.run(f.success);
      expect(result).toMatchObject({ orderId, alreadyResolved: false });
      expect(f.orders.recordManualSettlement).toHaveBeenCalledWith(
        f.tx,
        f.source,
        expect.objectContaining({ identifier: checkout, amount: '982.14', currency: 'PHP' })
      );
      expect(f.card).toMatchObject({ leaseOwner: 'new-account-job', successCount: 1 });
      expect(object(f.source.result)).toMatchObject({
        payment_status: 'requires_action',
        status: 'payment_result_unknown'
      });
      expect(object(f.source.result).payment_evidence).toBeUndefined();
      expect(safeDocument(f.source.result).manual_settlement).toMatchObject({
        outcome: 'success',
        orderId
      });
      expect(rechargeAvailability(f.source, f.records)).toMatchObject({
        payment: 'completed',
        accountPaymentRestricted: false
      });
      expect(cycleSources(f.records, f.source)).toHaveLength(2);
      await expect(f.run(f.success)).resolves.toMatchObject({ alreadyResolved: true, orderId });
      expect(f.card.successCount).toBe(1);
      expect(f.orders.recordManualSettlement).toHaveBeenCalledOnce();
      await expect(f.run({ ...f.success, amount: '1000.00' })).rejects.toThrow('已经结单');
      await expect(f.run()).rejects.toThrow('已经结单');
    }
  );
  it.each([
    { confirmed: false },
    { noDebitConfirmed: false },
    { notActivatedConfirmed: false },
    { outcome: 'arbitrary' },
    { manual_settlement: {} },
    { reason: '5429 9739 0000 0000' },
    { reason: 'session-token-test' },
    { reason: 'https://example.test' }
  ])('无本人声明或含敏感资料不能写入：%j', async (patch) => {
    const f = fixture();
    await expect(f.run({ ...f.failure, ...patch })).rejects.toThrow();
    expect(f.cards.finishSharedCard).not.toHaveBeenCalled();
    expect(f.repository.updateJob).not.toHaveBeenCalled();
  });
  it.each([
    'owner',
    'version',
    'identifier',
    'active',
    'recheck',
    'missing-ledger',
    'paid',
    'other-active',
    'card-mismatch',
    'missing-attempt',
    'settle-missing',
    'existing-order'
  ])('拒绝不完整或冲突的结单：%s', async (kind) => {
    const f = fixture();
    if (kind === 'owner') f.source.ownerId = orderId;
    if (kind === 'version') f.source.updatedAt = new Date();
    if (kind === 'identifier') object(f.source.result).checkout_identifier = 'oaics_changed';
    if (kind === 'active') {
      f.source.state = 'running';
      f.source.leaseUntil = new Date(Date.now() + 60000);
    }
    if (kind === 'recheck') object(f.source.result).recheck_only = true;
    if (kind === 'missing-ledger') f.records.splice(1, 1);
    if (kind === 'paid') f.records[1]!.document.payment_status = 'paid';
    if (kind === 'other-active') {
      f.sibling.state = 'running';
      f.sibling.leaseUntil = new Date(Date.now() + 60000);
    }
    if (kind === 'card-mismatch') f.source.cardId = 'different';
    if (kind === 'missing-attempt') delete object(f.source.result)._shared_card_attempt_v1;
    if (kind === 'settle-missing') f.cards.finishSharedCard.mockResolvedValue(undefined);
    if (kind === 'existing-order')
      f.orders.assertNoOrderForManualFailure.mockRejectedValue(new Error('已有订单'));
    await expect(f.run()).rejects.toThrow();
    expect(f.tx.idBusinessV2RechargeRecord.update).not.toHaveBeenCalled();
    expect(f.repository.updateJob).not.toHaveBeenCalled();
  });
  it('其他未决付款仍保护原账号，不能因为处理一笔清除全部记录', async () => {
    const f = fixture();
    f.records.push({
      ...f.records[1]!,
      fileKey: `payments/${hash('oaics_other')}.json`,
      document: { ...f.records[1]!.document, checkout_identifier: 'oaics_other' }
    });
    await f.run();
    expect(rechargeAvailability(f.source, f.records).accountPaymentRestricted).toBe(true);
    expect(f.records.at(-1)!.document.manual_settlement).toBeUndefined();
  });
  it('已明确拒付且卡池先结算的失败单仍可结束账号防重', async () => {
    const f = fixture();
    object(object(f.source.result)._shared_card_attempt_v1).outcome = 'declined';
    await f.run();
    expect(rechargeAvailability(f.source, f.records).payment).toBe('resolved');
    expect(f.card.successCount).toBe(0);
  });
  it('已结单原任务的迟到执行回执被拒绝，客户端也不能伪造或嵌套处理标记', async () => {
    const f = fixture();
    await f.run();
    const transactions = { execute: vi.fn((work) => work(f.tx)) };
    const service = new RechargeService(
      f.repository as never,
      {} as never,
      transactions as never,
      f.audit as never
    );
    await expect(
      service.callback(
        id,
        { type: 'finished', result: { payment_status: 'paid' } },
        { localToken: token }
      )
    ).rejects.toThrow('人工结单');
    for (const payload of [
      { manual_settlement: {} },
      { result: { manual_settlement: {} } },
      { records: [{ manual_settlement: {} }] }
    ])
      expect(() => assertNoPrivateRechargeCallback(payload)).toThrow('不可写入');
    expect(f.card.successCount).toBe(0);
  });
});
