import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2PurchaseRateSettingsService } from './id-business-v2-purchase-rate-settings.service';

const operator = {
  id: '10000000-0000-4000-8000-000000000001',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: ['apple.exchange_rate.view', 'apple.exchange_rate.manage']
};

function setup() {
  const row = {
    autoEnabled: true,
    intervalMinutes: 60,
    staleMinutes: 120,
    abnormalChangeRate: { toString: () => '0.1' },
    nextRunAt: new Date('2026-08-20T10:05:00.000Z'),
    updatedByUserId: operator.id,
    createdAt: new Date('2026-08-20T00:00:00.000Z'),
    updatedAt: new Date('2026-08-20T10:03:00.000Z')
  };
  const repository = {
    updateSettings: vi.fn().mockResolvedValue(row)
  };
  const transactionManager = {
    execute: vi.fn(async (work: (tx: object) => Promise<unknown>) => work({}))
  };
  const audit = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new IdBusinessV2PurchaseRateSettingsService(
    repository as never,
    transactionManager as never,
    audit as never
  );
  return { service, repository, audit, row };
}

describe('IdBusinessV2PurchaseRateSettingsService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T10:03:00.000Z'));
  });

  afterEach(() => vi.useRealTimers());

  it('stores a percentage as a decimal ratio and schedules the next hour boundary at minute five', async () => {
    const { service, repository, audit } = setup();

    await expect(
      service.update(
        { autoEnabled: true, staleMinutes: 120, abnormalChangePercent: '10' },
        operator,
        'settings-1'
      )
    ).resolves.toMatchObject({
      autoEnabled: true,
      intervalMinutes: 60,
      abnormalChangeRate: '0.1',
      abnormalChangePercent: '10'
    });
    expect(repository.updateSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        intervalMinutes: 60,
        abnormalChangeRate: '0.1',
        nextRunAt: new Date('2026-08-20T10:05:00.000Z')
      })
    );
    expect(audit.append).toHaveBeenCalledOnce();
  });

  it('rejects invalid stale and abnormal thresholds before writing', async () => {
    const { service, repository } = setup();

    await expect(
      service.update({ autoEnabled: true, staleMinutes: 29, abnormalChangePercent: '10' }, operator)
    ).rejects.toThrow('过期提醒时间必须是 30 到 1440 分钟之间的整数');
    await expect(
      service.update(
        { autoEnabled: true, staleMinutes: 120, abnormalChangePercent: '101' },
        operator
      )
    ).rejects.toThrow('异常波动阈值必须大于 0% 且不超过 100%');
    expect(repository.updateSettings).not.toHaveBeenCalled();
  });

  it('clears the next run when automatic collection is disabled', async () => {
    const { service, repository, row } = setup();
    repository.updateSettings.mockResolvedValueOnce({
      ...row,
      autoEnabled: false,
      nextRunAt: null
    });

    await service.update(
      { autoEnabled: false, staleMinutes: 120, abnormalChangePercent: '10' },
      operator,
      'settings-2'
    );
    expect(repository.updateSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ autoEnabled: false, nextRunAt: null })
    );
  });
});
