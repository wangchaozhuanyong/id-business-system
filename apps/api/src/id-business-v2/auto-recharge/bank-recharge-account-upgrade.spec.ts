import { describe, expect, it, vi } from 'vitest';
import { BankRechargeAccountService } from './bank-recharge-account.service';

const id = '11111111-1111-4111-8111-111111111111';
function setup(
  plan = 'plus',
  accountKey: string | null = 'a'.repeat(64),
  dueAt: Date | null = new Date(Date.now() + 86400000)
) {
  const account = { id, status: 'active', officialAccountKey: accountKey };
  const repository = {
    findAccount: vi.fn().mockResolvedValue(account),
    hasUnreviewedVerifiedPayment: vi.fn().mockResolvedValue(false),
    subscriptionForAccount: vi
      .fn()
      .mockResolvedValue({ plan, status: 'active', dueAt, currentOrderId: id })
  };
  const service = new BankRechargeAccountService(
    repository as never,
    {} as never,
    {} as never,
    {} as never
  );
  return { service, repository, account };
}

describe('账号库连续套餐升级资格', () => {
  it.each(['pro-5x', 'pro-20x', 'pro-500'] as const)(
    '已绑定身份且有效 Plus 可选择 %s 升级',
    async (target) => {
      const { service, account } = setup();
      await expect(service.assertRechargeEligible({} as never, id, target)).resolves.toBe(account);
    }
  );
  it('本机登录只取邮箱和密码，不额外解密或发送 2FA 密钥', () => {
    const decrypt = vi.fn((value) =>
      value === 'encrypted-email' ? 'account@example.invalid' : 'synthetic-password'
    );
    const service = new BankRechargeAccountService(
      {} as never,
      {} as never,
      {} as never,
      { decrypt } as never
    );
    expect(
      service.savedLogin({
        emailEncrypted: 'encrypted-email',
        passwordEncrypted: 'encrypted-password',
        totpSecretEncrypted: 'encrypted-totp'
      } as never)
    ).toEqual({ email: 'account@example.invalid', password: 'synthetic-password' });
    expect(decrypt).toHaveBeenCalledTimes(2);
    expect(decrypt).not.toHaveBeenCalledWith('encrypted-totp');
  });
  it('有效 Go 可以进入 Plus 升级核对，不能跳到 Pro 或重复 Go', async () => {
    const { service, account } = setup('go');
    await expect(service.assertRechargeEligible({} as never, id, 'plus')).resolves.toBe(account);
    await expect(service.assertRechargeEligible({} as never, id, 'pro-20x')).rejects.toThrow(
      '不能自动再次付款'
    );
    await expect(service.assertRechargeEligible({} as never, id, 'go')).rejects.toThrow(
      '不能自动再次付款'
    );
  });
  it('本机核对不按历史套餐授权付款，同套餐可以核对，未闭合付款仍拦截', async () => {
    const { service, repository, account } = setup('go');
    const unresolved = vi.fn().mockResolvedValue(false);
    Object.assign(repository, { hasUnresolvedRechargePayment: unresolved });
    await expect(service.requireRechargeInspection({} as never, id)).resolves.toBe(account);
    expect(repository.subscriptionForAccount).not.toHaveBeenCalled();
    unresolved.mockResolvedValue(true);
    await expect(service.requireRechargeInspection({} as never, id)).rejects.toThrow('只读复查');
    unresolved.mockResolvedValue(false);
    repository.hasUnreviewedVerifiedPayment.mockResolvedValue(true);
    await expect(service.requireRechargeInspection({} as never, id)).resolves.toBe(account);
    expect(repository.hasUnreviewedVerifiedPayment).not.toHaveBeenCalled();
  });
  it.each(['plus', 'go'] as const)('有效 Plus 不能重复付款或降为 %s', async (target) => {
    const { service } = setup();
    await expect(service.assertRechargeEligible({} as never, id, target)).rejects.toThrow(
      '不能自动再次付款'
    );
  });
  it.each(['go', 'pro-5x', 'pro-20x', 'pro-500', 'unknown'])(
    '%s 不能伪装 Plus 升级',
    async (current) => {
      const { service } = setup(current);
      await expect(service.assertRechargeEligible({} as never, id, 'pro-20x')).rejects.toThrow(
        '不能自动再次付款'
      );
    }
  );
  it('身份未核实或到期未知的 Plus 不能放开付款', async () => {
    for (const { service } of [setup('plus', null), setup('plus', 'a'.repeat(64), null)])
      await expect(service.assertRechargeEligible({} as never, id, 'pro-20x')).rejects.toThrow(
        '不能自动再次付款'
      );
  });
  it('已付款但日期待核对，即使没有订阅投影也拒绝再次付款', async () => {
    const { service, repository } = setup();
    repository.hasUnreviewedVerifiedPayment.mockResolvedValue(true);
    repository.subscriptionForAccount.mockResolvedValueOnce(null as never);
    await expect(service.assertRechargeEligible({} as never, id, 'pro-20x')).rejects.toThrow(
      '开通时间待核对'
    );
    expect(repository.subscriptionForAccount).not.toHaveBeenCalled();
  });
  it('无有效订阅保持原首次开通资格', async () => {
    const { service, repository, account } = setup();
    repository.subscriptionForAccount.mockResolvedValueOnce(null as never);
    await expect(service.assertRechargeEligible({} as never, id, 'go')).resolves.toBe(account);
  });
  it('停用账号在订阅核验之前被拒绝', async () => {
    const { service, repository } = setup();
    repository.findAccount.mockResolvedValueOnce({ id, status: 'disabled' } as never);
    await expect(service.assertRechargeEligible({} as never, id, 'pro-20x')).rejects.toThrow(
      '已停用'
    );
    expect(repository.subscriptionForAccount).not.toHaveBeenCalled();
  });
});
