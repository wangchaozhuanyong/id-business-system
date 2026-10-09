import { describe, expect, it, vi } from 'vitest';
import { PATH_METADATA } from '@nestjs/common/constants';
import { RechargeController } from './recharge.controller';
import { RechargeSettingsService } from './recharge-settings.service';
import { RechargeSettingsRepository } from './persistence/recharge-settings.repository';
import { safeDocument } from './recharge-validation';

const operator = {
  id: 'admin-test',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};

describe('付款金额上限退役合同', () => {
  it('不再注册金额上限的读取或写入路由', () => {
    const paths = Object.getOwnPropertyNames(RechargeController.prototype)
      .filter((key) => key !== 'constructor')
      .map((key) =>
        Reflect.getMetadata(PATH_METADATA, Reflect.get(RechargeController.prototype, key))
      );
    expect(paths).not.toContain('payment-caps');
    expect(paths).not.toContain('payment-caps/:plan/:currencyCode');
    expect(RechargeSettingsService.prototype).not.toHaveProperty('requirePaymentCap');
    expect(RechargeSettingsService.prototype).not.toHaveProperty('updatePaymentCap');
    expect(RechargeSettingsRepository.prototype).not.toHaveProperty('upsertPaymentCap');
  });

  it('读取现有连接设置不访问或删除历史金额上限数据', async () => {
    const legacy = {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn()
    };
    const settings = { findUnique: vi.fn().mockResolvedValue(null) };
    const repository = new RechargeSettingsRepository({
      idBusinessV2RechargeBrowserSetting: settings,
      idBusinessV2RechargePaymentCap: legacy
    } as never);
    const service = new RechargeSettingsService(
      repository,
      { decrypt: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never
    );
    await service.get(operator);
    expect(settings.findUnique).toHaveBeenCalledWith({ where: { ownerId: operator.id } });
    for (const query of Object.values(legacy)) expect(query).not.toHaveBeenCalled();
  });

  it('新执行回执不保存旧金额上限，仍保存币种与付款事实', () => {
    expect(
      safeDocument({
        locked_currency: 'PHP',
        max_amount: '1000.00',
        max_amount_minor: 100000,
        payment_requests_sent: 0,
        payment_attempted: false
      })
    ).toEqual({ locked_currency: 'PHP', payment_requests_sent: 0, payment_attempted: false });
  });
});
