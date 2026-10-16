import { describe, expect, it, vi } from 'vitest';
import { listChatgptAccounts } from './bank-recharge-account-list';
import { BankRechargeAccountService } from './bank-recharge-account.service';

function fixture() {
  const rows = [
    'alpha.test@example.invalid',
    'beta.alpha@example.invalid',
    'unrelated@example.invalid'
  ].map((email, index) => ({
    id: String(index),
    emailEncrypted: email,
    emailMasked: 'al***@example.invalid',
    emailHash: String(index),
    remark: null,
    status: 'active',
    registeredAt: null
  }));
  const repository = {
    listAccounts: vi.fn().mockResolvedValue(rows),
    countAccounts: vi.fn().mockResolvedValue(3),
    renewalWarningDays: vi.fn().mockResolvedValue(3),
    subscriptionsForAccounts: vi.fn().mockResolvedValue([]),
    loginNetworksByEmailHashes: vi.fn().mockResolvedValue([]),
    openingCardsForAccounts: vi.fn().mockResolvedValue([]),
    registrationSourceAudits: vi.fn().mockResolvedValue([])
  };
  const encryption = {
    decrypt: (value: string | null) => value,
    hash: (value: string) => `hash:${value}`
  };
  return { rows, repository, encryption };
}

describe('ChatGPT 完整邮箱与片段搜索', () => {
  it('核对片段候选后才计算总数和分页，排除令牌误命中', async () => {
    const f = fixture();
    const result = await listChatgptAccounts(
      { keyword: 'ALPHA', page: '2', pageSize: '1' },
      f.repository as never,
      f.encryption as never
    );
    expect(result.total).toBe(2);
    expect(result.items.map((item) => item.email)).toEqual(['beta.alpha@example.invalid']);
    expect(f.repository.listAccounts.mock.calls[0]?.[0].skip).toBeUndefined();
    expect(f.repository.subscriptionsForAccounts).toHaveBeenCalledWith(['1']);
  });
  it('完整邮箱显示不携带密码或 2FA 密钥', async () => {
    const f = fixture();
    const result = await listChatgptAccounts({}, f.repository as never, f.encryption as never);
    expect(result.items[0]?.email).toBe('alpha.test@example.invalid');
    expect(result.items[0]).not.toHaveProperty('emailEncrypted');
    expect(result.items[0]).not.toHaveProperty('passwordEncrypted');
    expect(result.items[0]).not.toHaveProperty('totpSecretEncrypted');
  });
});

describe('ChatGPT 注册日期修正', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  function serviceFixture() {
    const before = {
      id,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      registeredAt: null,
      saleStatus: 'unsold'
    };
    const repository = {
      findAccount: vi.fn().mockResolvedValue(before),
      updateAccount: vi.fn(async (_tx, args) => ({ ...before, ...args.data }))
    };
    const audit = { append: vi.fn() };
    const service = new BankRechargeAccountService(
      repository as never,
      { execute: (work: (tx: unknown) => unknown) => work({}) } as never,
      audit as never,
      {} as never
    );
    return { service, repository, audit, before };
  }
  it('按北京时间保存日期，保留未提供的密码和 2FA 并记录审计', async () => {
    const f = serviceFixture();
    await f.service.updateAccount(
      id,
      { registeredDate: '2026-09-10', expectedUpdatedAt: f.before.updatedAt.toISOString() },
      { id: 'operator' } as never
    );
    const data = f.repository.updateAccount.mock.calls[0]?.[1].data;
    expect(data.registeredAt.toISOString()).toBe('2026-09-09T16:00:00.000Z');
    expect(data).not.toHaveProperty('passwordEncrypted');
    expect(data).not.toHaveProperty('totpSecretEncrypted');
    expect(f.audit.append.mock.calls[0]?.[1].afterData.registeredAt).toBe(
      '2026-09-09T16:00:00.000Z'
    );
  });
  it.each(['2026-02-30', '2099-01-01', ''])('拒绝无效或未来日期 %s', async (registeredDate) => {
    const f = serviceFixture();
    await expect(f.service.updateAccount(id, { registeredDate }, {} as never)).rejects.toThrow();
    expect(f.repository.updateAccount).not.toHaveBeenCalled();
  });
});
