import type { IdBusinessV2RechargeJob, Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { restoreRechargeAccount } from '../recharge-account-restore';
import { RechargeRepository } from './recharge.repository';

const ownerId = 'history-owner';
const accountKey = 'a'.repeat(64);
const profileId = 'b'.repeat(32);
const currentId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const jobId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const date = new Date('2026-10-19T00:00:00Z');

const sourceResult = () => ({
  status: 'blocked',
  reason: 'checkout_unknown_write',
  stage: 'checkout_create',
  account_matched: true,
  payment_status: 'not_attempted',
  payment_attempted: false,
  checkout_requests_sent: 1,
  payment_requests_sent: 0,
  confirmation_requests_sent: 0,
  browser_profile_id: profileId,
  target_plan: 'plus',
  plan: 'chatgptplusplan'
});

const row = (n: number, result: unknown = { status: 'blocked' }) =>
  ({
    id: jobId(n),
    ownerId,
    accountKey,
    action: 'bitbrowser',
    state: 'finished',
    plan: 'plus',
    result,
    createdAt: date,
    updatedAt: date
  }) as IdBusinessV2RechargeJob;

function fixture(count: number) {
  const source = row(1, sourceResult());
  const history = [source, ...Array.from({ length: count - 1 }, (_, i) => row(i + 2))];
  const findMany = vi.fn(async (args: Prisma.IdBusinessV2RechargeJobFindManyArgs) => {
    // All timestamps deliberately tie: the id order is needed to traverse every row once.
    const sorted = [...history].sort((a, b) => b.id.localeCompare(a.id));
    const start = args.cursor ? sorted.findIndex((item) => item.id === args.cursor!.id) + 1 : 0;
    return sorted.slice(start, start + Number(args.take));
  });
  const tx = { idBusinessV2RechargeJob: { findMany } };
  const actual = new RechargeRepository({} as never);
  const repository = {
    records: vi.fn().mockResolvedValue([
      {
        ownerId,
        accountKey,
        fileKey: `${accountKey}.json`,
        revision: 2,
        document: sourceResult()
      }
    ]),
    retainedProfileForAccount: vi
      .fn()
      .mockResolvedValue({ sourceJobId: source.id, profileId, accountKey }),
    findJob: vi.fn().mockResolvedValue(source),
    finishedJobsForUnidentifiedCheckout: actual.finishedJobsForUnidentifiedCheckout,
    restoreCheckoutIdentifier: actual.restoreCheckoutIdentifier,
    originalCheckoutForAccount: vi.fn().mockResolvedValue(undefined),
    updateJob: vi.fn()
  };
  const job = {
    ...row(9999),
    id: currentId,
    state: 'running',
    result: { mode: 'payment', payment_requests_sent: 0, checkout_requests_sent: 0 }
  };
  const input = { tx, job, callback: { accountKey }, repository };
  const login = (profile: string, parent: string) => ({
    mode: 'open_browser',
    status: 'session_ready',
    account_matched: true,
    browser_profile_id: profile,
    browser_profile_missing_confirmed: true,
    replaced_browser_profile_id: parent,
    payment_attempted: false,
    payment_requests_sent: 0,
    payment_status: 'not_attempted'
  });
  return { actual, tx, source, history, findMany, repository, input, login };
}

describe('完整未知结账单历史分页', () => {
  it.each([30, 34])('%i条完整历史可核实唯一旧来源，不受列表30条限制', async (count) => {
    const f = fixture(count);
    const before = structuredClone(f.history);
    const restored = await restoreRechargeAccount(f.input as never);
    expect(restored.unidentifiedCheckoutRecovery).toBe(true);
    expect(restored.originalCheckoutIdentifier).toBeUndefined();
    expect(f.findMany).toHaveBeenCalledTimes(2);
    expect(f.repository.updateJob).toHaveBeenCalledOnce();
    expect(f.history).toEqual(before);
  });

  it('按同时间戳的id稳定翻页，使用传入事务和原账号归属，不按套餐截断', async () => {
    const f = fixture(34);
    const result = await f.actual.finishedJobsForUnidentifiedCheckout(
      f.tx as never,
      ownerId,
      accountKey,
      currentId
    );
    expect(result).toHaveLength(34);
    expect(new Set(result.map((item) => item.id)).size).toBe(34);
    const options = {
      where: {
        ownerId,
        accountKey,
        action: 'bitbrowser',
        state: 'finished',
        id: { not: currentId }
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 30
    };
    expect(f.findMany).toHaveBeenNthCalledWith(1, options);
    expect(f.findMany).toHaveBeenNthCalledWith(2, {
      ...options,
      cursor: { id: jobId(5) },
      skip: 1
    });
    expect(result.at(-1)?.id).toBe(f.source.id);
  });

  it('后页出现第二个建单候选时仍拒绝恢复，不提前选第一个', async () => {
    const f = fixture(34);
    f.history.find((item) => item.id === jobId(34))!.result = sourceResult();
    await expect(restoreRechargeAccount(f.input as never)).rejects.toThrow('未核实');
    expect(f.findMany).toHaveBeenCalledTimes(2);
    expect(f.repository.updateJob).not.toHaveBeenCalled();
  });

  it('不同套餐的已验证窗口替换链跨页时可完整核实', async () => {
    const f = fixture(34);
    const replacement = 'c'.repeat(32),
      middle = 'd'.repeat(32);
    const latest = f.history.find((item) => item.id === jobId(34))!;
    const older = f.history.find((item) => item.id === jobId(2))!;
    Object.assign(latest, { plan: 'go', result: f.login(replacement, middle) });
    Object.assign(older, { plan: 'pro-20x', result: f.login(middle, profileId) });
    f.repository.findJob.mockResolvedValue(latest);
    f.repository.retainedProfileForAccount.mockResolvedValue({
      sourceJobId: latest.id,
      profileId: replacement,
      accountKey
    });
    const restored = await restoreRechargeAccount(f.input as never);
    expect(restored.unidentifiedCheckoutRecovery).toBe(true);
    expect(f.findMany).toHaveBeenCalledTimes(2);
  });

  it('后页窗口父链冲突仍拒绝恢复', async () => {
    const f = fixture(34),
      replacement = 'c'.repeat(32);
    const latest = f.history.find((item) => item.id === jobId(34))!;
    const older = f.history.find((item) => item.id === jobId(2))!;
    latest.result = f.login(replacement, profileId);
    older.result = f.login(replacement, 'd'.repeat(32));
    f.repository.findJob.mockResolvedValue(latest);
    f.repository.retainedProfileForAccount.mockResolvedValue({
      sourceJobId: latest.id,
      profileId: replacement,
      accountKey
    });
    await expect(restoreRechargeAccount(f.input as never)).rejects.toThrow('未核实');
    expect(f.findMany).toHaveBeenCalledTimes(2);
    expect(f.repository.updateJob).not.toHaveBeenCalled();
  });

  it('900条满页未能证明遍历结束时拒绝，不能返回截断历史', async () => {
    const f = fixture(900);
    await expect(restoreRechargeAccount(f.input as never)).rejects.toThrow('历史尚未完整核验');
    expect(f.findMany).toHaveBeenCalledTimes(30);
    expect(f.repository.updateJob).not.toHaveBeenCalled();
  });

  it('跨页重复游标记录时拒绝，不能忽略重复而宣称来源唯一', async () => {
    const f = fixture(34);
    f.findMany.mockResolvedValueOnce(f.history.slice(0, 30)).mockResolvedValueOnce([f.source]);
    await expect(restoreRechargeAccount(f.input as never)).rejects.toThrow('历史存在重复记录');
    expect(f.repository.updateJob).not.toHaveBeenCalled();
  });

  it('后页读取失败时不返回前页来源或更新任务', async () => {
    const f = fixture(34);
    f.findMany
      .mockResolvedValueOnce(f.history.slice(0, 30))
      .mockRejectedValueOnce(new Error('read failed'));
    await expect(restoreRechargeAccount(f.input as never)).rejects.toThrow('read failed');
    expect(f.repository.updateJob).not.toHaveBeenCalled();
  });
});
