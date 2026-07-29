import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2ExchangeRatesService } from './id-business-v2-exchange-rates.service';

const entryId = '11111111-1111-4111-8111-111111111111';
const operator = {
  id: '22222222-2222-4222-8222-222222222222',
  username: 'operator',
  displayName: '运营',
  roles: ['operation'],
  permissions: ['apple.exchange_rate.view', 'apple.exchange_rate.create']
};
const recordedAt = new Date('2026-07-26T18:20:00.000Z');
const createdAt = new Date('2026-07-26T18:21:00.000Z');

function decimal(value: Prisma.Decimal.Value) {
  return new Prisma.Decimal(value);
}

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: entryId,
    binanceMerchantBuyRateToRmb: decimal('6.7'),
    binanceMerchantSellRateToRmb: decimal('6.8'),
    okxMerchantBuyRateToRmb: decimal('6.72'),
    okxMerchantSellRateToRmb: decimal('6.82'),
    combinedMerchantBuyAverageRateToRmb: decimal('6.71'),
    combinedMerchantSellAverageRateToRmb: decimal('6.81'),
    midRateToRmb: decimal('6.76'),
    recordedAt,
    remark: '晚班手工记录',
    createdByUserId: operator.id,
    createdAt,
    createdBy: operator,
    ...overrides
  };
}

describe('IdBusinessV2ExchangeRatesService', () => {
  const tx = {
    idBusinessV2ExchangeRateEntry: {
      create: vi.fn()
    },
    auditLog: {
      create: vi.fn()
    }
  };
  const prisma = {
    $transaction: vi.fn(),
    idBusinessV2ExchangeRateEntry: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn()
    }
  };
  const service = new IdBusinessV2ExchangeRatesService(prisma as never);

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (input) =>
      typeof input === 'function' ? input(tx) : Promise.all(input)
    );
    prisma.idBusinessV2ExchangeRateEntry.findMany.mockResolvedValue([makeEntry()]);
    prisma.idBusinessV2ExchangeRateEntry.count.mockResolvedValue(1);
    prisma.idBusinessV2ExchangeRateEntry.findFirst.mockResolvedValue(makeEntry());
    prisma.idBusinessV2ExchangeRateEntry.findUnique.mockResolvedValue(makeEntry());
    tx.idBusinessV2ExchangeRateEntry.create.mockImplementation(async ({ data }) =>
      makeEntry({
        ...data,
        createdAt
      })
    );
    tx.auditLog.create.mockResolvedValue({ id: 'audit-1' });
  });

  it('lists immutable manual entries with filters and Decimal strings', async () => {
    const result = await service.list({
      keyword: '运营',
      recordedFrom: '2026-07-26',
      recordedTo: '2026-07-26',
      sortBy: 'createdAt',
      sortOrder: 'asc'
    });

    expect(result).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 20,
      items: [
        {
          id: entryId,
          binanceMerchantBuyRateToRmb: '6.7',
          okxMerchantSellRateToRmb: '6.82',
          combinedMerchantBuyAverageRateToRmb: '6.71',
          combinedMerchantSellAverageRateToRmb: '6.81',
          midRateToRmb: '6.76',
          createdBy: operator
        }
      ]
    });
    expect(prisma.idBusinessV2ExchangeRateEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
        where: expect.objectContaining({
          recordedAt: {
            gte: new Date('2026-07-26T00:00:00.000Z'),
            lte: new Date('2026-07-26T23:59:59.999Z')
          }
        })
      })
    );
  });

  it('calculates combined rates and middle rate on the server before writing audit evidence', async () => {
    const result = await service.create(
      {
        binanceMerchantBuyRateToRmb: '6.70',
        binanceMerchantSellRateToRmb: '6.80',
        okxMerchantBuyRateToRmb: '6.72',
        okxMerchantSellRateToRmb: '6.82',
        recordedAt: recordedAt.toISOString(),
        remark: ' 晚班手工记录 '
      },
      operator
    );

    expect(tx.idBusinessV2ExchangeRateEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        binanceMerchantBuyRateToRmb: decimal('6.7'),
        binanceMerchantSellRateToRmb: decimal('6.8'),
        okxMerchantBuyRateToRmb: decimal('6.72'),
        okxMerchantSellRateToRmb: decimal('6.82'),
        combinedMerchantBuyAverageRateToRmb: decimal('6.71'),
        combinedMerchantSellAverageRateToRmb: decimal('6.81'),
        midRateToRmb: decimal('6.76'),
        recordedAt,
        remark: '晚班手工记录',
        createdByUserId: operator.id
      }),
      include: expect.any(Object)
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: operator.id,
        action: 'id_business_v2.exchange_rate.manual.create',
        objectId: entryId,
        afterData: expect.objectContaining({
          combinedMerchantBuyAverageRateToRmb: '6.71',
          combinedMerchantSellAverageRateToRmb: '6.81',
          midRateToRmb: '6.76'
        })
      })
    });
    expect(result.midRateToRmb).toBe('6.76');
  });

  it('returns the latest manual entry and total count in the overview', async () => {
    const result = await service.getOverview();

    expect(result).toMatchObject({
      latestEntry: {
        id: entryId,
        midRateToRmb: '6.76'
      },
      total: 1
    });
    expect(result.calculationRule).toContain('算术平均值');
  });

  it('rejects invalid rates, dates, operators and missing records', async () => {
    await expect(
      service.create(
        {
          binanceMerchantBuyRateToRmb: '0',
          binanceMerchantSellRateToRmb: '6.8',
          okxMerchantBuyRateToRmb: '6.72',
          okxMerchantSellRateToRmb: '6.82',
          recordedAt: recordedAt.toISOString()
        },
        operator
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create(
        {
          binanceMerchantBuyRateToRmb: '6.7',
          binanceMerchantSellRateToRmb: '6.8',
          okxMerchantBuyRateToRmb: '6.72',
          okxMerchantSellRateToRmb: '6.82',
          recordedAt: 'not-a-date'
        },
        operator
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create({} as never, undefined)).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(
      service.list({ recordedFrom: '2026-07-27', recordedTo: '2026-07-26' })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.get('bad-id')).rejects.toBeInstanceOf(BadRequestException);

    prisma.idBusinessV2ExchangeRateEntry.findUnique.mockResolvedValue(null);
    await expect(service.get(entryId)).rejects.toBeInstanceOf(NotFoundException);
  });
});
