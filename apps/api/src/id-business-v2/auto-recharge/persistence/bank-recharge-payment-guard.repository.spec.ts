import { describe, expect, it, vi } from 'vitest';
import { BankRechargeRepository } from './bank-recharge.repository';
import { hash } from '../recharge-validation';

const accountKey = 'a'.repeat(64);
const accountId = 'synthetic-account';
const sourceJobId = '11111111-1111-4111-8111-111111111111';
const ownerId = 'synthetic-owner';
const unknown = {
  id: sourceJobId,
  ownerId,
  result: { payment_requests_sent: 1, payment_status: 'unknown', target_plan: 'go' }
};
const verified = {
  rechargeJobId: sourceJobId,
  createdByUserId: ownerId,
  accountId,
  source: 'automatic',
  verifiedAt: new Date('2026-10-09T00:00:00Z')
};
function fixture(jobs: unknown[], orders: unknown[] = [], records: unknown[] = []) {
  return {
    idBusinessV2RechargeJob: { findMany: vi.fn().mockResolvedValue(jobs) },
    idBusinessV2BankRechargeOrder: { findMany: vi.fn().mockResolvedValue(orders) },
    idBusinessV2RechargeRecord: { findMany: vi.fn().mockResolvedValue(records) }
  };
}
describe('同一账号跨套餐付款结果保护', () => {
  it.each([
    { status: 'payment_result_unknown', payment_attempted: true, payment_status: 'unknown' },
    { status: 'blocked', payment_requests_sent: 1, payment_status: 'requires_action' },
    { status: 'blocked', confirmation_requests_sent: 1, payment_status: 'paid' },
    { status: 'subscription_activated', payment_requests_sent: 1, payment_status: 'unknown' }
  ])('另一套餐未闭合付款不能被新套餐绕过 %j', async (result) => {
    const tx = fixture([{ ...unknown, result: { ...result, target_plan: 'go' } }]);
    const repository = new BankRechargeRepository({} as never);
    expect(await repository.hasUnresolvedRechargePayment(tx as never, accountId, accountKey)).toBe(
      true
    );
    expect(tx.idBusinessV2RechargeJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [{ chatgptAccountId: accountId }, { accountKey }],
          action: { in: ['prepare', 'flow', 'bitbrowser', 'server'] }
        }
      })
    );
  });
  it.each([
    {
      status: 'subscription_activated',
      payment_attempted: true,
      payment_status: 'paid',
      payment_outcome: 'subscription_activated'
    },
    { payment_requests_sent: 1, payment_status: 'declined' },
    {
      payment_requests_sent: 1,
      payment_status: 'unknown',
      operator_resolution: 'confirmed_no_bank_request'
    },
    { status: 'waiting_local_connector', payment_attempted: false, payment_requests_sent: 0 }
  ])('付款已闭合或尚未尝试时仅允许进入本机官网核对 %j', async (result) => {
    const tx = fixture([{ ...unknown, result }]);
    const repository = new BankRechargeRepository({} as never);
    expect(await repository.hasUnresolvedRechargePayment(tx as never, accountId, accountKey)).toBe(
      false
    );
    expect(tx.idBusinessV2BankRechargeOrder.findMany).not.toHaveBeenCalled();
  });
  it('原未知付款只读复查成功后可继续核价，财务日期待补不改原任务历史', async () => {
    const tx = fixture([unknown], [verified]);
    const repository = new BankRechargeRepository({} as never);
    expect(await repository.hasUnresolvedRechargePayment(tx as never, accountId, accountKey)).toBe(
      false
    );
    expect(tx.idBusinessV2BankRechargeOrder.findMany).toHaveBeenCalledWith({
      where: {
        accountId,
        source: 'automatic',
        verifiedAt: { not: null },
        deletedAt: null,
        status: { not: 'cancelled' },
        OR: [{ rechargeJobId: sourceJobId, createdByUserId: ownerId }]
      },
      select: {
        rechargeJobId: true,
        createdByUserId: true,
        accountId: true,
        source: true,
        verifiedAt: true
      }
    });
    expect(unknown.result.payment_status).toBe('unknown');
  });
  it.each([
    { rechargeJobId: 'other-source-job' },
    { accountId: 'other-account' },
    { createdByUserId: 'other-owner' },
    { source: 'manual' },
    { verifiedAt: null },
    { verifiedAt: new Date('invalid') }
  ])('其他任务、账号、归属或未核实订单不能闭合原付款 %j', async (patch) => {
    const tx = fixture([unknown], [{ ...verified, ...patch }]);
    expect(
      await new BankRechargeRepository({} as never).hasUnresolvedRechargePayment(
        tx as never,
        accountId,
        accountKey
      )
    ).toBe(true);
  });
  it('一笔已核实订单不能放过同账号另一笔仍未知的付款', async () => {
    const tx = fixture([unknown, { ...unknown, id: 'other-source-job' }], [verified]);
    expect(
      await new BankRechargeRepository({} as never).hasUnresolvedRechargePayment(
        tx as never,
        accountId,
        accountKey
      )
    ).toBe(true);
  });
  it('完整人工核实标记仅结束对应原单，保留另一笔未知付款保护', async () => {
    const result = {
      payment_status: 'unknown',
      payment_attempted: true,
      payment_requests_sent: 1,
      confirmation_requests_sent: 1,
      operator_resolution: 'confirmed_verification_failed_no_charge',
      resolution_basis: 'operator_observed_official_failure',
      resolved_at: '2026-10-18T12:00:00Z',
      resolution_job_id: '33333333-3333-4333-8333-333333333333',
      source_job_id: sourceJobId,
      verification_job_id: '22222222-2222-4222-8222-222222222222'
    };
    const repository = new BankRechargeRepository({} as never);
    expect(
      await repository.hasUnresolvedRechargePayment(
        fixture([{ ...unknown, result }]) as never,
        accountId,
        accountKey
      )
    ).toBe(false);
    expect(
      await repository.hasUnresolvedRechargePayment(
        fixture([
          { ...unknown, result },
          { ...unknown, id: 'another-source' }
        ]) as never,
        accountId,
        accountKey
      )
    ).toBe(true);
    expect(
      await repository.hasUnresolvedRechargePayment(
        fixture([{ ...unknown, result: { ...result, resolution_basis: undefined } }]) as never,
        accountId,
        accountKey
      )
    ).toBe(true);
  });
  it('同一Go原单多个只读复查历史按严格匹配账本派生闭合，其他未知任务仍保持保护', async () => {
    const result = {
      ...unknown.result,
      payment_attempted: true,
      payment_requests_sent: 1,
      confirmation_requests_sent: 1,
      operator_resolution: 'confirmed_verification_failed_no_charge',
      resolution_basis: 'operator_observed_official_failure',
      resolved_at: '2026-10-18T12:00:00Z',
      resolution_job_id: '33333333-3333-4333-8333-333333333333',
      source_job_id: sourceJobId,
      verification_job_id: '22222222-2222-4222-8222-222222222222'
    };
    const source = { ...unknown, result };
    const recheck = {
      id: '44444444-4444-4444-8444-444444444444',
      ownerId,
      accountKey,
      plan: 'go',
      action: 'bitbrowser',
      state: 'finished',
      createdAt: new Date('2026-10-18T11:00:00Z'),
      updatedAt: new Date('2026-10-18T11:01:00Z'),
      result: {
        transport: 'web_direct',
        recheck_only: true,
        source_job_id: sourceJobId,
        checkout_identifier: 'cs_go_original',
        payment_attempted: true,
        payment_status: 'unknown',
        payment_requests_sent: 0,
        confirmation_requests_sent: 0
      }
    };
    const records = [
      {
        ownerId,
        accountKey,
        fileKey: 'payments/' + hash('cs_go_original') + '.json',
        document: {
          ...result,
          account_key: accountKey,
          checkout_identifier: 'cs_go_original',
          target_plan: 'go'
        }
      }
    ];
    const history = [source, recheck, { ...recheck, id: '55555555-5555-4555-8555-555555555555' }];
    const before = JSON.stringify(history);
    const tx = fixture(history, [], records);
    const repository = new BankRechargeRepository({} as never);
    expect(await repository.hasUnresolvedRechargePayment(tx as never, accountId, accountKey)).toBe(
      false
    );
    expect(tx.idBusinessV2BankRechargeOrder.findMany).not.toHaveBeenCalled();
    expect(JSON.stringify(history)).toBe(before);
    for (const patch of [
      { source_job_id: '66666666-6666-4666-8666-666666666666' },
      { checkout_identifier: 'cs_other' },
      { recheck_only: false },
      { payment_evidence: { identifier: 'paid' } },
      { payment_status: 'paid' },
      { payment_requests_sent: 1 }
    ]) {
      expect(
        await repository.hasUnresolvedRechargePayment(
          fixture(
            [
              ...history,
              {
                ...recheck,
                id: '77777777-7777-4777-8777-777777777777',
                result: { ...recheck.result, ...patch }
              }
            ],
            [],
            records
          ) as never,
          accountId,
          accountKey
        )
      ).toBe(true);
    }
  });
});
