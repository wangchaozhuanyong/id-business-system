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

describe('已保存账号自动升级资格', () => {
  it.each(['pro-5x', 'pro-20x', 'pro-500'] as const)(
    '已绑定身份且有效 Plus 可选择 %s 升级',
    async (target) => {
      const { service, account } = setup();
      await expect(service.assertRechargeEligible({} as never, id, target)).resolves.toBe(account);
    }
  );
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
