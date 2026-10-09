import { describe, expect, it, vi } from 'vitest';
import { RechargeRepository } from './persistence/recharge.repository';

const ownerId = 'synthetic-owner';
const accountKey = 'a'.repeat(64);
const profileId = 'b'.repeat(32);
const currentId = '11111111-1111-4111-8111-111111111111';
const id = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
const source = (index: number) => ({
  id: id(index),
  ownerId,
  accountKey,
  action: 'bitbrowser',
  state: 'finished',
  plan: 'plus',
  result: { browser_profile_id: profileId, payment_attempted: false, payment_requests_sent: 0 }
});
const rechecks = (start = 0) =>
  Array.from({ length: 30 }, (_, offset) => ({
    ...source(start + offset),
    result: { ...source(start + offset).result, recheck_only: true }
  }));

describe('原窗口归属历史查询', () => {
  it('列表仍只显示30条，30次只读复查不能挤掉原窗口绑定', async () => {
    const first = rechecks();
    const original = source(30);
    const jobs = {
      findMany: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce([original])
    };
    const repository = new RechargeRepository({ idBusinessV2RechargeJob: jobs } as never);
    expect(
      await repository.retainedProfileForAccount(
        { idBusinessV2RechargeJob: jobs } as never,
        ownerId,
        accountKey,
        currentId
      )
    ).toEqual({ sourceJobId: original.id, profileId, accountKey });
    expect(jobs.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        ownerId,
        accountKey,
        action: 'bitbrowser',
        state: 'finished',
        id: { not: currentId }
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 30
    });
    expect(jobs.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: { id: first.at(-1)!.id }, skip: 1, take: 30 })
    );
    jobs.findMany.mockResolvedValueOnce([]);
    await repository.list(ownerId);
    expect(jobs.findMany).toHaveBeenLastCalledWith({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      take: 30
    });
  });

  it.each([profileId, ''])('30条之后的删除记录仍阻止回退旧窗口或新建（%s）', async (savedId) => {
    const deleted = {
      ...source(30),
      result: { browser_profile_id: savedId, browser_cleanup_status: 'completed' }
    };
    const jobs = {
      findMany: vi
        .fn()
        .mockResolvedValueOnce(rechecks())
        .mockResolvedValueOnce([deleted, source(31)])
    };
    const repository = new RechargeRepository({} as never);
    await expect(
      repository.retainedProfileForAccount(
        { idBusinessV2RechargeJob: jobs } as never,
        ownerId,
        accountKey,
        currentId
      )
    ).rejects.toThrow('原比特浏览器资料已被删除');
    expect(jobs.findMany).toHaveBeenCalledTimes(2);
  });

  it('只有完整耗尽历史后才返回无原窗口', async () => {
    const jobs = { findMany: vi.fn().mockResolvedValueOnce(rechecks()).mockResolvedValueOnce([]) };
    const repository = new RechargeRepository({} as never);
    await expect(
      repository.retainedProfileForAccount(
        { idBusinessV2RechargeJob: jobs } as never,
        ownerId,
        accountKey,
        currentId
      )
    ).resolves.toBeUndefined();
    expect(jobs.findMany).toHaveBeenCalledTimes(2);
  });

  it('达到有界查询上限仍未查完时明确停止，不能把未知当作无绑定', async () => {
    const jobs = { findMany: vi.fn().mockResolvedValue(rechecks()) };
    const repository = new RechargeRepository({} as never);
    await expect(
      repository.retainedProfileForAccount(
        { idBusinessV2RechargeJob: jobs } as never,
        ownerId,
        accountKey,
        currentId
      )
    ).rejects.toThrow('原窗口历史尚未完整核验，禁止自动创建新窗口');
    expect(jobs.findMany).toHaveBeenCalledTimes(30);
  });

  it('同套餐原订单不被30次仅登录或只读复查挤出，查询按套餐隔离', async () => {
    const first = rechecks();
    const original = {
      ...source(30),
      result: {
        ...source(30).result,
        checkout_identifier: 'cs_original',
        checkout_requests_sent: 1
      }
    };
    const jobs = {
      findMany: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce([original])
    };
    const repository = new RechargeRepository({} as never);
    await expect(
      repository.originalCheckoutForAccount(
        { idBusinessV2RechargeJob: jobs } as never,
        ownerId,
        accountKey,
        'plus',
        currentId
      )
    ).resolves.toBe('cs_original');
    expect(jobs.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ ownerId, accountKey, plan: 'plus' })
      })
    );
    expect(jobs.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: { id: first.at(-1)!.id }, skip: 1 })
    );
  });
});
