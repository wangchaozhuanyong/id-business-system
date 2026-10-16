import { describe, expect, it, vi } from 'vitest';
import { accountSaleUpdate, parseChatgptAccountSaleStatus } from './bank-recharge-account-sales';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import { listChatgptAccounts } from './bank-recharge-account-list';
import type { BankRechargeRepository } from './persistence/bank-recharge.repository';

const id = '123e4567-e89b-42d3-a456-426614174000';
const updatedAt = new Date('2026-10-16T01:00:00.000Z');
function setup(patch: Record<string, unknown> = {}) {
  const before = {
    id,
    updatedAt,
    registered: true,
    saleStatus: 'unsold',
    soldAt: null,
    status: 'active',
    offerStatus: 'unknown',
    emailMasked: 'te***@example.invalid',
    emailEncrypted: 'encrypted',
    registrationCountryCode: null,
    ...patch
  };
  const tx = {};
  const repository = {
    findAccount: vi.fn(async () => before),
    updateAccount: vi.fn(async (_tx, { data }) => ({ ...before, ...data }))
  };
  const audit = { append: vi.fn() };
  const transactions = { execute: vi.fn(async (work) => work(tx)) };
  const service = new BankRechargeAccountService(
    repository as never,
    transactions as never,
    audit as never,
    {} as never
  );
  const operator = { id: 'admin-id' } as never;
  const change = (
    saleStatus: unknown = 'sold',
    expectedUpdatedAt: unknown = updatedAt.toISOString()
  ) => service.updateAccount(id, { saleStatus, expectedUpdatedAt }, operator);
  return { service, repository, audit, transactions, operator, before, tx, change };
}

describe('ChatGPT 出售状态命令', () => {
  it.each(['all', '', null, true, 1, '已出售'])('拒绝非法状态 %s', async (value) => {
    const f = setup();
    await expect(f.change(value)).rejects.toThrow('出售情况无效');
    expect(f.transactions.execute).not.toHaveBeenCalled();
    expect(() => parseChatgptAccountSaleStatus(value)).toThrow();
  });
  it.each([undefined, null, '', 'invalid'])('必须提供有效版本 %s', async (expectedUpdatedAt) => {
    const f = setup();
    await expect(
      f.service.updateAccount(id, { saleStatus: 'sold', expectedUpdatedAt }, f.operator)
    ).rejects.toThrow('版本');
    expect(f.repository.updateAccount).not.toHaveBeenCalled();
  });
  it('未注册账号不能出售，也不能通过直接请求绕过', async () => {
    const f = setup({ registered: false });
    await expect(f.change()).rejects.toThrow('只有已标记注册');
    expect(f.repository.updateAccount).not.toHaveBeenCalled();
    expect(f.audit.append).not.toHaveBeenCalled();
  });
  it('已注册且资料未补齐也能出售，写入版本条件和同事务脱敏审计', async () => {
    const f = setup({ passwordEncrypted: null, registeredAt: null });
    await f.change();
    expect(f.repository.updateAccount).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        where: { id, updatedAt, registered: true, deletedAt: null },
        data: expect.objectContaining({ saleStatus: 'sold', soldAt: expect.any(Date) })
      })
    );
    expect(f.audit.append).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        beforeData: expect.objectContaining({ saleStatus: 'unsold', soldAt: null }),
        afterData: expect.objectContaining({ saleStatus: 'sold', soldAt: expect.any(String) })
      })
    );
    const audit = JSON.stringify(f.audit.append.mock.calls);
    expect(audit).not.toContain('encrypted');
  });
  it('改回未出售会清除当前出售时间，审计保留原时间', async () => {
    const soldAt = new Date('2026-10-15T01:00:00.000Z');
    const f = setup({ saleStatus: 'sold', soldAt });
    await f.change('unsold');
    expect(f.repository.updateAccount.mock.calls[0]?.[1].data).toMatchObject({
      saleStatus: 'unsold',
      soldAt: null
    });
    expect(f.audit.append.mock.calls[0]?.[1]).toMatchObject({
      beforeData: { saleStatus: 'sold', soldAt: soldAt.toISOString() },
      afterData: { saleStatus: 'unsold', soldAt: null }
    });
  });
  it('重复标记不重新生成出售时间，普通编辑也不改变出售标记', async () => {
    const f = setup({ saleStatus: 'sold', soldAt: updatedAt });
    await f.change();
    expect(f.repository.updateAccount.mock.calls[0]?.[1].data).not.toHaveProperty('soldAt');
    await f.service.updateAccount(id, { remark: '仅备注' }, f.operator);
    expect(f.repository.updateAccount.mock.calls[1]?.[1].data).not.toHaveProperty('saleStatus');
    expect(accountSaleUpdate(f.before as never, undefined)).toEqual({});
  });
  it('过期版本不写入，事务内晚发生的并发冲突也转为可理解的冲突提示', async () => {
    const f = setup();
    await expect(f.change('sold', '2026-10-15T01:00:00.000Z')).rejects.toThrow('已变化');
    expect(f.repository.updateAccount).not.toHaveBeenCalled();
    f.repository.updateAccount.mockRejectedValueOnce({ code: 'P2025' });
    await expect(f.change()).rejects.toThrow('已被其他人修改');
    expect(f.audit.append).not.toHaveBeenCalled();
  });
  it('已删除账号禁止改变出售标记', async () => {
    const f = setup({ deletedAt: updatedAt });
    await expect(f.change()).rejects.toThrow('不存在或已删除');
    expect(f.repository.updateAccount).not.toHaveBeenCalled();
  });
  it('写入或审计失败不得返回成功', async () => {
    const f = setup();
    f.repository.updateAccount.mockRejectedValueOnce(new Error('保存失败'));
    await expect(f.change()).rejects.toThrow('保存失败');
    expect(f.audit.append).not.toHaveBeenCalled();
    f.audit.append.mockRejectedValueOnce(new Error('审计失败'));
    await expect(f.change()).rejects.toThrow('审计失败');
    expect(f.transactions.execute).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({
        changedScopes: ['auto-recharge'],
        retryMode: 'none'
      })
    );
  });
  it('已出售账号仍按现有条件用于充值，不因出售禁用', async () => {
    const f = setup({ saleStatus: 'sold', soldAt: updatedAt });
    await expect(f.service.requireActive(f.tx as never, id)).resolves.toBe(f.before);
  });
  it('禁止客户端改写出售时间', async () => {
    const f = setup();
    await expect(
      f.service.updateAccount(id, { soldAt: updatedAt.toISOString() }, f.operator)
    ).rejects.toThrow('未知字段');
  });
});

describe('ChatGPT 出售状态列表', () => {
  function listFixture() {
    const repository = {
      listAccounts: vi
        .fn<BankRechargeRepository['listAccounts']>()
        .mockResolvedValue([
          { id, registered: true, saleStatus: 'sold', soldAt: updatedAt }
        ] as never),
      countAccounts: vi.fn(async () => 1),
      renewalWarningDays: vi.fn(async () => 3),
      subscriptionsForAccounts: vi.fn(async () => []),
      loginNetworksByEmailHashes: vi.fn(async () => []),
      openingCardsForAccounts: vi.fn(async () => []),
      registrationSourceAudits: vi.fn(async () => [])
    };
    const list = (query: Parameters<typeof listChatgptAccounts>[0]) =>
      listChatgptAccounts(query, repository as never, { decrypt: () => null } as never);
    return { repository, list };
  }
  it('已出售分类在数据库内筛选、排序和分页，返回注册及出售事实', async () => {
    const f = listFixture();
    const result = await f.list({ saleStatus: 'sold', page: '1', pageSize: '20' });
    expect(result.items[0]).toMatchObject({
      registered: true,
      saleStatus: 'sold',
      soldAt: updatedAt
    });
    const args = f.repository.listAccounts.mock.calls[0]?.[0];
    expect(args).toMatchObject({
      where: { saleStatus: 'sold', deletedAt: null },
      orderBy: [{ soldAt: 'desc' }, { id: 'desc' }],
      skip: 0,
      take: 20
    });
    expect(f.repository.countAccounts).toHaveBeenCalledWith(args?.where);
  });
  it('待用分类组合未出售、现有订阅条件和搜索，全部与回收站不排除已出售', async () => {
    const f = listFixture();
    await f.list({ saleStatus: 'unsold', subscriptionState: 'never_subscribed', keyword: '测试' });
    expect(f.repository.listAccounts.mock.calls[0]?.[0]).toMatchObject({
      where: {
        saleStatus: 'unsold',
        AND: [{ OR: expect.any(Array) }, { OR: expect.any(Array) }]
      }
    });
    await f.list({ saleStatus: 'all' });
    expect(f.repository.listAccounts.mock.calls[1]?.[0]?.where).not.toHaveProperty('saleStatus');
    await f.list({ deleted: 'deleted' });
    expect(f.repository.listAccounts.mock.calls[2]?.[0]?.where).toMatchObject({
      deletedAt: { not: null }
    });
  });
  it('无效出售筛选不得读取列表', async () => {
    const f = listFixture();
    await expect(f.list({ saleStatus: 'yes' })).rejects.toThrow('出售情况无效');
    expect(f.repository.listAccounts).not.toHaveBeenCalled();
  });
});
