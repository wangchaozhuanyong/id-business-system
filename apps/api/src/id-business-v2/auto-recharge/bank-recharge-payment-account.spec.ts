import { describe, expect, it, vi } from 'vitest';
import { BankRechargeAccountService } from './bank-recharge-account.service';

function setup(account: Record<string, unknown> | null) {
  const repository = {
    findAccountByOfficialKey: vi.fn().mockResolvedValue(account),
    findAccountByEmailHash: vi.fn(),
    createAccount: vi.fn(),
    updateAccount: vi.fn()
  };
  const service = new BankRechargeAccountService(
    repository as never,
    {} as never,
    {} as never,
    {} as never
  );
  const job = { accountKey: 'a'.repeat(64), expectedEmailEncrypted: null, chatgptAccountId: null };
  return { repository, service, job };
}

describe('JSON 付款账号归属', () => {
  it.each([
    null,
    { id: 'disabled', status: 'disabled' },
    { id: 'deleted', status: 'active', deletedAt: new Date() }
  ])('没有可用的精确官网绑定 %j 时保持待核验，不创建或改绑账号', async (account) => {
    const { service, repository, job } = setup(account);
    expect(await service.ensureAccountForVerifiedPayment({} as never, job as never)).toBeNull();
    expect(repository.findAccountByEmailHash).not.toHaveBeenCalled();
    expect(repository.createAccount).not.toHaveBeenCalled();
    expect(repository.updateAccount).not.toHaveBeenCalled();
  });
  it('只使用官方唯一标识精确命中的启用账号', async () => {
    const { service, repository, job } = setup({
      id: 'matched',
      status: 'active',
      deletedAt: null
    });
    expect(await service.ensureAccountForVerifiedPayment({} as never, job as never)).toBe(
      'matched'
    );
    expect(repository.findAccountByOfficialKey).toHaveBeenCalledWith({}, job.accountKey);
    expect(repository.updateAccount).not.toHaveBeenCalled();
  });
});
