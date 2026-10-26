import { describe, expect, it, vi } from 'vitest';
import { OnlineRechargeAssetsService } from './assets.service';
import { OnlineRechargeAssetsRepository } from './persistence/assets.repository';

vi.mock('../bank-card-pool/public-api', async (original) => ({
  ...(await original<object>()),
  lockSharedBankCards: vi.fn(async () => undefined)
}));
const input = { id: '11111111-1111-4111-8111-111111111111', plan: 'plus', reason: '比特本次回填' };
const admin = {
  id: 'admin',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};
function fixture(change = {}) {
  const tx = {
    onlineRechargeCard: {
      findUnique: vi.fn().mockResolvedValue({
        id: input.id,
        status: 'active',
        leaseOwner: null,
        allowedPlans: ['plus'],
        ...change
      })
    }
  };
  const repository = {
    transaction: vi.fn(async (_key, work) => work(tx)),
    log: vi.fn()
  };
  const memory = {
    forBitBrowser: vi.fn().mockResolvedValue({
      cvc: '987',
      expiresAt: new Date(Date.now() + 1000).toISOString(),
      state: 'available'
    })
  };
  const assets = new OnlineRechargeAssetsRepository(
    {} as never,
    repository as never,
    {} as never,
    memory as never
  );
  return { service: new OnlineRechargeAssetsService(assets), tx, repository, memory };
}
describe('比特充值临时安全码受控读取', () => {
  it('管理员按当前套餐读取未占用卡片，审计不包含安全码', async () => {
    const f = fixture();
    const result = await f.service.action('cards', 'bitbrowser-cvc', input, admin);
    expect(result).toMatchObject({ cvc: '987', state: 'available' });
    expect(f.repository.log).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.repository.log.mock.calls)).not.toContain('987');
    expect(f.repository.transaction).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
      ['audit-logs']
    );
  });
  it('即使有资料敏感读取权限，非管理员也不能调用比特安全码通道', async () => {
    const f = fixture();
    expect(() =>
      f.service.action('cards', 'bitbrowser-cvc', input, {
        ...admin,
        roles: ['staff'],
        permissions: ['id_business_v2.online_recharge.sensitive']
      })
    ).toThrow('管理员');
    expect(f.memory.forBitBrowser).not.toHaveBeenCalled();
  });
  it.each([{ status: 'disabled' }, { leaseOwner: 'other-task' }, { allowedPlans: ['pro_5x'] }])(
    '停用、占用或套餐不兼容卡片不得取密（%j）',
    async (change) => {
      const f = fixture(change);
      await expect(f.service.action('cards', 'bitbrowser-cvc', input, admin)).rejects.toThrow();
      expect(f.memory.forBitBrowser).not.toHaveBeenCalled();
      expect(f.repository.log).not.toHaveBeenCalled();
    }
  );
  it('审计失败不能将已读取的安全码返回客户端', async () => {
    const f = fixture();
    f.repository.log.mockRejectedValue(new Error('audit unavailable'));
    await expect(f.service.action('cards', 'bitbrowser-cvc', input, admin)).rejects.toThrow(
      'audit unavailable'
    );
  });
});
