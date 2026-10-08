import { describe, expect, it, vi } from 'vitest';
import { ACCOUNT_COPY_SETTINGS_OWNER_ID } from '../account-copy-settings';
import { RechargeSettingsRepository } from './recharge-settings.repository';

function fixture() {
  const settings = {
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([])
  };
  const repository = new RechargeSettingsRepository({
    idBusinessV2RechargeBrowserSetting: settings
  } as never);
  return { settings, repository };
}

describe('账号复制后缀共享设置仓储', () => {
  it('共享行仅读后缀所在 JSON，不读取连接器或代理凭据', async () => {
    const { settings, repository } = fixture();
    settings.findUnique.mockResolvedValue({ browserOptions: { accountCopySuffix: '共享内容' } });
    await expect(repository.findAccountCopySuffix()).resolves.toBe('共享内容');
    expect(settings.findUnique).toHaveBeenCalledWith({
      where: { ownerId: ACCOUNT_COPY_SETTINGS_OWNER_ID },
      select: { browserOptions: true }
    });
    expect(settings.findMany).not.toHaveBeenCalled();
  });

  it.each(['', null, { accountCopySuffix: 123 }])(
    '共享行存在时始终权威，即使清空或没有有效字符串（%#）',
    async (options) => {
      const { settings, repository } = fixture();
      settings.findUnique.mockResolvedValue({
        browserOptions: options === '' ? { accountCopySuffix: '' } : options
      });
      settings.findMany.mockResolvedValue([
        { browserOptions: { accountCopySuffix: '不能恢复的历史后缀' } }
      ]);
      await expect(repository.findAccountCopySuffix()).resolves.toBe('');
      expect(settings.findMany).not.toHaveBeenCalled();
    }
  );

  it('没有共享行时按稳定更新时间顺序兼容最新非空旧后缀，只查询 JSON', async () => {
    const { settings, repository } = fixture();
    settings.findMany.mockResolvedValue([
      { browserOptions: { accountCopySuffix: '' } },
      { browserOptions: { accountCopySuffix: 123 } },
      { browserOptions: null },
      { browserOptions: { accountCopySuffix: '较新旧后缀' } },
      { browserOptions: { accountCopySuffix: '更早旧后缀' } }
    ]);
    await expect(repository.findAccountCopySuffix()).resolves.toBe('较新旧后缀');
    expect(settings.findMany).toHaveBeenCalledWith({
      where: { ownerId: { not: ACCOUNT_COPY_SETTINGS_OWNER_ID } },
      select: { browserOptions: true },
      orderBy: [{ updatedAt: 'desc' }, { ownerId: 'asc' }]
    });
  });

  it('没有任何已保存后缀时返回空字符串', async () => {
    const { repository } = fixture();
    await expect(repository.findAccountCopySuffix()).resolves.toBe('');
  });

  it('单行复制传入事务时只在同一事务读取共享设置', async () => {
    const { settings, repository } = fixture();
    const transactionSettings = {
      findUnique: vi.fn().mockResolvedValue({ browserOptions: { accountCopySuffix: '事务内容' } }),
      findMany: vi.fn()
    };
    await expect(
      repository.findAccountCopySuffix({
        idBusinessV2RechargeBrowserSetting: transactionSettings
      } as never)
    ).resolves.toBe('事务内容');
    expect(settings.findUnique).not.toHaveBeenCalled();
    expect(settings.findMany).not.toHaveBeenCalled();
    expect(transactionSettings.findUnique).toHaveBeenCalledWith({
      where: { ownerId: ACCOUNT_COPY_SETTINGS_OWNER_ID },
      select: { browserOptions: true }
    });
  });
});
