import { V2_BANK_RECHARGE_PLANS, V2_FINANCE_CURRENCIES } from '@apple-business/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  BankRechargePricingService,
  BIT_ORDER_PRICING_SETTINGS_OWNER_ID
} from './bank-recharge-pricing.service';
import { RechargeSettingsRepository } from './persistence/recharge-settings.repository';

const operator = {
  id: 'fixture-admin',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};
const originalUpdatedAt = new Date('2026-10-10T00:00:00.000Z');
const planPrices = Object.fromEntries(V2_BANK_RECHARGE_PLANS.map((plan) => [plan, null]));
const draft = {
  receivedCurrencyCode: 'CNY',
  shoppingFeePercent: '0.01',
  usdtFeePercent: '2.5',
  planPrices: { ...planPrices, go: '500', plus: '1000' },
  updatedAt: null as string | null
};

function fixture() {
  type Row = { browserOptions: Record<string, unknown>; updatedAt: Date };
  let row: Row | null = null;
  const settingsModel = {
    findUnique: vi.fn(async () => row && { ...row }),
    createMany: vi.fn(async ({ data }) => {
      if (row) return { count: 0 };
      row = { browserOptions: data[0].browserOptions, updatedAt: data[0].updatedAt };
      return { count: 1 };
    }),
    updateMany: vi.fn(async ({ where, data }) => {
      if (!row || row.updatedAt.getTime() !== where.updatedAt.getTime()) return { count: 0 };
      row = { browserOptions: data.browserOptions, updatedAt: data.updatedAt };
      return { count: 1 };
    })
  };
  const prisma = { idBusinessV2RechargeBrowserSetting: settingsModel };
  const repository = new RechargeSettingsRepository(prisma as never);
  const transactions = {
    execute: vi.fn(async (work) => {
      const before = row;
      try {
        return await work(prisma);
      } catch (error) {
        row = before;
        throw error;
      }
    })
  };
  const audit = { append: vi.fn().mockResolvedValue(undefined) };
  const fx = { listLatest: vi.fn().mockResolvedValue({ items: [], generatedAt: 'fixture-time' }) };
  const createService = () =>
    new BankRechargePricingService(repository, transactions as never, audit as never, fx as never);
  return {
    service: createService(),
    createService,
    repository,
    settingsModel,
    transactions,
    audit,
    fx,
    setRow: (value: Row | null) => {
      row = value;
    },
    currentRow: () => row
  };
}

describe('比特订单共享收费设置', () => {
  it('首次默认人民币，手续费与套餐金额均未设，不猜收费或写入数据', async () => {
    const f = fixture();
    await expect(f.service.read(operator)).resolves.toEqual({
      receivedCurrencyCode: 'CNY',
      shoppingFeePercent: null,
      usdtFeePercent: null,
      planPrices,
      updatedAt: null
    });
    expect(f.settingsModel.findUnique).toHaveBeenCalledWith({
      where: { ownerId: BIT_ORDER_PRICING_SETTINGS_OWNER_ID },
      select: { browserOptions: true, updatedAt: true }
    });
    expect(f.transactions.execute).not.toHaveBeenCalled();
    expect(f.fx.listLatest).not.toHaveBeenCalled();
  });

  it('所有管理员跨服务实例读取同一设置，按十进制精确保留 0.01% 和四位金额', async () => {
    const f = fixture();
    const saved = await f.service.update(
      {
        ...draft,
        shoppingFeePercent: '0.0100',
        usdtFeePercent: '2.5000',
        planPrices: { ...planPrices, go: '500.1234', plus: '1000.0000' }
      },
      operator
    );
    expect(saved).toEqual({
      receivedCurrencyCode: 'CNY',
      shoppingFeePercent: '0.01',
      usdtFeePercent: '2.5',
      planPrices: { ...planPrices, go: '500.1234', plus: '1000' },
      updatedAt: expect.any(String)
    });
    await expect(f.createService().read({ ...operator, id: 'another-admin' })).resolves.toEqual(
      saved
    );
    expect(f.audit.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'id_business_v2.auto_recharge.order_pricing.settings',
        objectId: BIT_ORDER_PRICING_SETTINGS_OWNER_ID,
        afterData: f.currentRow()?.browserOptions
      })
    );
    expect(f.settingsModel.createMany).toHaveBeenCalledWith({
      data: [
        {
          ownerId: BIT_ORDER_PRICING_SETTINGS_OWNER_ID,
          browserOptions: f.currentRow()?.browserOptions,
          updatedAt: expect.any(Date)
        }
      ],
      skipDuplicates: true
    });
    expect(f.transactions.execute).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        changedScopes: ['auto-recharge'],
        operator,
        retryMode: 'none'
      })
    );
  });

  it.each(V2_FINANCE_CURRENCIES)('支持既有客户收费币种 %s', async (currency) => {
    const f = fixture();
    const saved = await f.service.update({ ...draft, receivedCurrencyCode: currency }, operator);
    expect(saved.receivedCurrencyCode).toBe(currency);
  });

  it('空值表示未设而非零，明确 0% 与免费套餐可以保存', async () => {
    const f = fixture();
    const saved = await f.service.update(
      {
        ...draft,
        shoppingFeePercent: '',
        usdtFeePercent: '0',
        planPrices: { ...planPrices, go: '0', plus: '' }
      },
      operator
    );
    expect(saved).toMatchObject({
      shoppingFeePercent: null,
      usdtFeePercent: '0',
      planPrices: { go: '0', plus: null }
    });
  });

  it.each([
    { shoppingFeePercent: '-1' },
    { shoppingFeePercent: '100.0001' },
    { shoppingFeePercent: '0.00001' },
    { shoppingFeePercent: 0.1 },
    { usdtFeePercent: '1e-2' },
    { usdtFeePercent: undefined },
    { receivedCurrencyCode: 'XYZ' },
    { receivedCurrencyCode: 'cny' },
    { planPrices: { go: '-1' } },
    { planPrices: { go: '500.12345' } },
    { planPrices: { go: 500 } },
    { planPrices: { go: '1e3' } },
    { planPrices: { invalid: '1' } },
    { planPrices: null },
    { token: 'unsupported-field' },
    { updatedAt: undefined },
    { updatedAt: 'invalid-time' }
  ])('无效币种、精度、字段或版本拒绝且没有写入（%#）', async (override) => {
    const f = fixture();
    await expect(f.service.update({ ...draft, ...override }, operator)).rejects.toThrow();
    expect(f.transactions.execute).not.toHaveBeenCalled();
    expect(f.audit.append).not.toHaveBeenCalled();
  });

  it('首次只能创建，已存在时 updatedAt null 拒绝覆盖', async () => {
    const f = fixture();
    f.setRow({ browserOptions: draft, updatedAt: originalUpdatedAt });
    await expect(f.service.update(draft, operator)).rejects.toThrow('其他管理员修改');
    expect(f.settingsModel.createMany).not.toHaveBeenCalled();
    expect(f.settingsModel.updateMany).not.toHaveBeenCalled();
    expect(f.audit.append).not.toHaveBeenCalled();
  });

  it('有效版本原子更新并增加版本，旧版本不能再次保存', async () => {
    const f = fixture();
    f.setRow({ browserOptions: draft, updatedAt: originalUpdatedAt });
    const saved = await f.service.update(
      { ...draft, updatedAt: originalUpdatedAt.toISOString() },
      operator
    );
    expect(new Date(saved.updatedAt!).getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
    expect(f.settingsModel.updateMany).toHaveBeenCalledWith({
      where: { ownerId: BIT_ORDER_PRICING_SETTINGS_OWNER_ID, updatedAt: originalUpdatedAt },
      data: { browserOptions: expect.anything(), updatedAt: expect.any(Date) }
    });
    await expect(
      f.service.update({ ...draft, updatedAt: originalUpdatedAt.toISOString() }, operator)
    ).rejects.toThrow('其他管理员修改');
    expect(f.audit.append).toHaveBeenCalledTimes(1);
  });

  it.each(['create', 'update'])('读后发生并发 %s 时 CAS 拒绝并且不审计成功', async (mode) => {
    const f = fixture();
    if (mode === 'update') f.setRow({ browserOptions: draft, updatedAt: originalUpdatedAt });
    (mode === 'create'
      ? f.settingsModel.createMany
      : f.settingsModel.updateMany
    ).mockResolvedValueOnce({ count: 0 });
    await expect(
      f.service.update(
        {
          ...draft,
          updatedAt: mode === 'create' ? null : originalUpdatedAt.toISOString()
        },
        operator
      )
    ).rejects.toThrow('其他管理员修改');
    expect(f.audit.append).not.toHaveBeenCalled();
  });

  it('审计失败回滚同一事务内的收费设置，未产生订单或收款', async () => {
    const f = fixture();
    f.audit.append.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(f.service.update(draft, operator)).rejects.toThrow('audit unavailable');
    expect(f.currentRow()).toBeNull();
    expect(f.fx.listLatest).not.toHaveBeenCalled();
  });

  it('非管理员或缺失身份拒绝前不读配置、汇率或启动事务', async () => {
    const f = fixture();
    for (const rejected of [
      { ...operator, roles: ['staff'] },
      { ...operator, id: '' }
    ]) {
      await expect(f.service.read(rejected)).rejects.toThrow('仅管理员');
      await expect(f.service.update(draft, rejected)).rejects.toThrow('仅管理员');
      await expect(f.service.rates(rejected)).rejects.toThrow('仅管理员');
    }
    expect(f.settingsModel.findUnique).not.toHaveBeenCalled();
    expect(f.fx.listLatest).not.toHaveBeenCalled();
    expect(f.transactions.execute).not.toHaveBeenCalled();
  });

  it('汇率接口仅按指定字段读取缓存，不生成快照；保留缺失与过期时间供界面判断', async () => {
    const f = fixture();
    const capturedAt = new Date('2026-10-01T00:00:00.000Z');
    const expiresAt = new Date('2026-10-02T00:00:00.000Z');
    f.fx.listLatest.mockResolvedValue({
      items: [
        { currency: 'CNY', id: null, rateToCny: '1', capturedAt, expiresAt: null },
        {
          currency: 'PHP',
          id: 'php-cache',
          rateToCny: '0.12345678',
          capturedAt,
          expiresAt,
          sourceReference: 'private-provider-field'
        },
        { currency: 'MYR', id: null, rateToCny: null, capturedAt: null, expiresAt: null }
      ],
      generatedAt: '2026-10-10T00:00:00.000Z'
    } as never);
    await expect(f.service.rates(operator)).resolves.toEqual({
      items: [
        {
          currency: 'CNY',
          id: null,
          rateToCny: '1',
          capturedAt: capturedAt.toISOString(),
          expiresAt: null
        },
        {
          currency: 'PHP',
          id: 'php-cache',
          rateToCny: '0.12345678',
          capturedAt: capturedAt.toISOString(),
          expiresAt: expiresAt.toISOString()
        },
        { currency: 'MYR', id: null, rateToCny: null, capturedAt: null, expiresAt: null }
      ],
      generatedAt: '2026-10-10T00:00:00.000Z'
    });
    expect(f.fx.listLatest).toHaveBeenCalledTimes(1);
    expect(f.settingsModel.findUnique).not.toHaveBeenCalled();
    expect(f.transactions.execute).not.toHaveBeenCalled();
  });
});
