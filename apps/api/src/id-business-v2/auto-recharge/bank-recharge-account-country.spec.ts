import { describe, expect, it, vi } from 'vitest';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import { accountListItem } from './bank-recharge-account-subscription';

const accountId = '123e4567-e89b-42d3-a456-426614174000';
function setup() {
  const before = {
    id: accountId,
    emailMasked: 'te***@example.test',
    emailEncrypted: 'encrypted',
    status: 'active',
    offerStatus: 'unknown',
    registrationCountryCode: 'PH',
    updatedAt: new Date('2026-10-03T01:00:00Z')
  };
  const repository = {
    findAccount: vi.fn().mockResolvedValue(before),
    updateAccount: vi.fn(async (_tx, { data }) => ({ ...before, ...data })),
    createAccount: vi.fn(async (_tx, { data }) => ({ id: accountId, ...data }))
  };
  const transactions = { execute: vi.fn(async (work) => work({})) };
  const audit = { append: vi.fn() };
  const encryption = { encrypt: vi.fn(), hash: vi.fn(), decrypt: vi.fn() };
  const service = new BankRechargeAccountService(
    repository as never,
    transactions as never,
    audit as never,
    encryption as never
  );
  const operator = { id: 'operator-id' } as never;
  const version = { expectedUpdatedAt: before.updatedAt.toISOString() };
  return { service, repository, transactions, audit, operator, version, before };
}

describe('ChatGPT 独立注册国家', () => {
  it('新增可选择国家，省略国家保持未知', async () => {
    const { service, repository, operator } = setup();
    await service.createAccount(
      { email: 'test@example.test', registrationCountryCode: 'my' },
      operator
    );
    expect(repository.createAccount.mock.calls[0]?.[1].data.registrationCountryCode).toBe('MY');
    await service.createAccount({ email: 'unknown@example.test' }, operator);
    expect(repository.createAccount.mock.calls[1]?.[1].data.registrationCountryCode).toBeNull();
  });
  it('人工修改和清空国家均写审计，未提供国家时不改原值', async () => {
    const { service, repository, audit, operator, version } = setup();
    await service.updateAccount(accountId, { ...version, registrationCountryCode: 'MY' }, operator);
    expect(repository.updateAccount.mock.calls[0]?.[1].data).toEqual({
      registrationCountryCode: 'MY',
      updatedByUserId: 'operator-id'
    });
    expect(audit.append.mock.calls[0]?.[1]).toMatchObject({
      beforeData: { registrationCountryCode: 'PH' },
      afterData: { registrationCountryCode: 'MY' }
    });
    await service.updateAccount(accountId, { ...version, registrationCountryCode: null }, operator);
    expect(repository.updateAccount.mock.calls[1]?.[1].data.registrationCountryCode).toBeNull();
    await service.updateAccount(accountId, { ...version, remark: '仅备注' }, operator);
    expect(repository.updateAccount.mock.calls[2]?.[1].data).not.toHaveProperty(
      'registrationCountryCode'
    );
  });
  it.each(['Malaysia', 'ZZ', 'XA', 'AA', 123])(
    '无效国家拒绝写事务（%#）',
    async (registrationCountryCode) => {
      const { service, transactions, operator, version } = setup();
      await expect(
        service.updateAccount(accountId, { ...version, registrationCountryCode }, operator)
      ).rejects.toThrow('国家代码无效');
      expect(transactions.execute).not.toHaveBeenCalled();
    }
  );
  it('过期编辑不能覆盖新国家', async () => {
    const { service, repository, operator } = setup();
    await expect(
      service.updateAccount(
        accountId,
        { expectedUpdatedAt: '2026-10-03T00:00:00Z', registrationCountryCode: 'MY' },
        operator
      )
    ).rejects.toThrow('已变化');
    expect(repository.updateAccount).not.toHaveBeenCalled();
  });
  it('列表只返回保存的注册国家，未知不会推断登录国家', () => {
    const { before } = setup();
    const list = (code: string | null) =>
      accountListItem(
        { ...before, registrationCountryCode: code } as never,
        undefined,
        Date.now(),
        Date.now()
      );
    expect(list('PH').registrationCountryCode).toBe('PH');
    expect(list(null).registrationCountryCode).toBeNull();
  });
});
