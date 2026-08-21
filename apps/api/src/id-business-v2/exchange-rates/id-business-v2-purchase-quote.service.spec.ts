import { Rate8 } from '../runtime/public-api';
import { describe, expect, it, vi } from 'vitest';
import { IdBusinessV2PurchaseQuoteService } from './id-business-v2-purchase-quote.service';

const operator = {
  id: '10000000-0000-4000-8000-000000000001',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: ['apple.exchange_rate.view', 'apple.exchange_rate.manage']
};

function currencyRecord() {
  return {
    code: 'EUR',
    nameCn: '欧元',
    displayName: '欧元',
    purchaseRatio: Rate8.from('0.6'),
    quoteUnit: Rate8.from('1'),
    decimalPlaces: 4,
    roundingMode: 'ROUND_DOWN' as const,
    enabled: true,
    sortOrder: 2,
    updatedBy: null,
    createdAt: new Date('2026-08-20T00:00:00.000Z'),
    updatedAt: new Date('2026-08-20T00:00:00.000Z'),
    latestSnapshot: null
  };
}

describe('IdBusinessV2PurchaseQuoteService', () => {
  it('persists an independently calculated immutable snapshot and audit in one command', async () => {
    const before = currencyRecord();
    const snapshot = {
      id: '20000000-0000-4000-8000-000000000001',
      currencyCode: 'EUR',
      marketRateCnyPerUnit: Rate8.from('8.32'),
      purchaseRatio: Rate8.from('0.6'),
      quoteUnit: Rate8.from('1'),
      purchaseRateRaw: Rate8.from('4.992'),
      purchaseRateDisplay: Rate8.from('4.992'),
      decimalPlaces: 4,
      roundingMode: 'ROUND_DOWN' as const,
      marketRateSource: 'manual' as const,
      marketRateSourceReference: '银行公开牌价',
      marketRateCapturedAt: new Date('2026-08-20T01:00:00.000Z'),
      fetchRunId: null,
      changeRate: null,
      validationStatus: 'normal' as const,
      createdBy: operator,
      createdAt: new Date('2026-08-20T01:01:00.000Z')
    };
    const repository = {
      findCurrencyInTransaction: vi.fn().mockResolvedValue(before),
      updateCurrency: vi.fn().mockResolvedValue(before),
      createSnapshot: vi.fn().mockResolvedValue(snapshot)
    };
    const audit = { append: vi.fn().mockResolvedValue(undefined) };
    const transactionManager = {
      execute: vi.fn(async (work: (tx: object) => Promise<unknown>) => work({}))
    };
    const settingsService = {
      getRecord: vi.fn().mockResolvedValue({ staleMinutes: 120 })
    };
    const service = new IdBusinessV2PurchaseQuoteService(
      repository as never,
      transactionManager as never,
      audit as never,
      settingsService as never
    );

    const result = await service.update(
      'eur',
      {
        nameCn: '欧元',
        displayName: '欧元',
        purchaseRatioPercent: '60',
        quoteUnit: '1',
        decimalPlaces: 4,
        roundingMode: 'ROUND_DOWN',
        enabled: true,
        sortOrder: 2,
        marketRateCnyPerUnit: '8.32',
        marketRateCapturedAt: '2026-08-20T01:00:00.000Z',
        marketRateSourceReference: '银行公开牌价'
      },
      operator,
      'request-1'
    );

    expect(repository.createSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        currencyCode: 'EUR',
        marketRateCnyPerUnit: '8.32',
        purchaseRatio: '0.6',
        purchaseRateRaw: '4.992',
        purchaseRateDisplay: '4.992'
      })
    );
    expect(audit.append).toHaveBeenCalledOnce();
    expect(result.latestSnapshot?.purchaseRateFormatted).toBe('4.9920');
  });

  it('returns a controlled validation error when a bulk recalculation exceeds storage range', async () => {
    const before = {
      ...currencyRecord(),
      quoteUnit: Rate8.from('2'),
      latestSnapshot: {
        id: '20000000-0000-4000-8000-000000000002',
        currencyCode: 'EUR',
        marketRateCnyPerUnit: Rate8.from('9999999999.99999999'),
        purchaseRatio: Rate8.from('0.6'),
        quoteUnit: Rate8.from('2'),
        purchaseRateRaw: Rate8.from('9999999999'),
        purchaseRateDisplay: Rate8.from('9999999999'),
        decimalPlaces: 4,
        roundingMode: 'ROUND_DOWN' as const,
        marketRateSource: 'manual' as const,
        marketRateSourceReference: '测试边界',
        marketRateCapturedAt: new Date('2026-08-20T01:00:00.000Z'),
        fetchRunId: null,
        changeRate: null,
        validationStatus: 'normal' as const,
        createdBy: null,
        createdAt: new Date('2026-08-20T01:01:00.000Z')
      }
    };
    const repository = {
      findCurrencyInTransaction: vi.fn().mockResolvedValue(before),
      updateCurrency: vi.fn().mockResolvedValue(before),
      createSnapshot: vi.fn()
    };
    const transactionManager = {
      execute: vi.fn(async (work: (tx: object) => Promise<unknown>) => work({}))
    };
    const service = new IdBusinessV2PurchaseQuoteService(
      repository as never,
      transactionManager as never,
      { append: vi.fn() } as never,
      { getRecord: vi.fn() } as never
    );

    await expect(
      service.bulkUpdate(
        { currencyCodes: ['EUR'], purchaseRatioPercent: '100' },
        operator,
        'request-2'
      )
    ).rejects.toThrow('EUR：收购价超过系统可保存的最大汇率范围');
    expect(repository.createSnapshot).not.toHaveBeenCalled();
  });

  it('requires a source explanation for every manual market-rate override', async () => {
    const transactionManager = { execute: vi.fn() };
    const service = new IdBusinessV2PurchaseQuoteService(
      {} as never,
      transactionManager as never,
      {} as never,
      {} as never
    );

    await expect(
      service.update(
        'EUR',
        {
          nameCn: '欧元',
          displayName: '欧元',
          purchaseRatioPercent: '60',
          quoteUnit: '1',
          decimalPlaces: 4,
          roundingMode: 'ROUND_DOWN',
          enabled: true,
          sortOrder: 2,
          marketRateCnyPerUnit: '8.32',
          marketRateCapturedAt: '2026-08-20T01:00:00.000Z',
          marketRateSourceReference: null
        },
        operator,
        'request-3'
      )
    ).rejects.toThrow('手工覆盖汇率必须填写来源说明');
    expect(transactionManager.execute).not.toHaveBeenCalled();
  });
});
