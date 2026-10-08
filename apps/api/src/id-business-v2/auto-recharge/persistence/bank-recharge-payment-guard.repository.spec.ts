import { describe, expect, it, vi } from 'vitest';
import { BankRechargeRepository } from './bank-recharge.repository';

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
function fixture(jobs: unknown[], orders: unknown[] = []) {
  return {
    idBusinessV2RechargeJob: { findMany: vi.fn().mockResolvedValue(jobs) },
    idBusinessV2BankRechargeOrder: { findMany: vi.fn().mockResolvedValue(orders) }
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
});
