import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { IdBusinessV2FinanceFxService } from './id-business-v2-finance-fx.service';
import { IdBusinessV2FinanceCommandRepository } from './persistence/id-business-v2-finance-command.repository';
import { IdBusinessV2FinanceQueryRepository } from './persistence/id-business-v2-finance-query.repository';

const operator = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'operator',
  displayName: '运营',
  roles: ['operation'],
  permissions: ['apple.order.create']
};
const quotedAt = new Date('2026-07-30T12:00:00.000Z');
const originalFetch = global.fetch;

describe('新增法币的原始市场估值', () => {
  function fixture() {
    const query = { findLatestFxSnapshot: vi.fn().mockResolvedValue(null) };
    const command = { createFxSnapshot: vi.fn(async (_tx, input) => input) };
    const provider = {
      fetchLatest: vi.fn().mockResolvedValue({
        quotePerCny: { PHP: '8', IDR: '2000', JPY: '20' },
        providerUpdatedAt: quotedAt
      })
    };
    const transactions = { execute: vi.fn(async (work) => work({})) };
    const service = new IdBusinessV2FinanceFxService(
      transactions as never,
      command as never,
      query as never,
      {} as never,
      {} as never,
      provider as never
    );
    return { service, query, command, provider };
  }
  it.each([
    ['PHP', '0.125'],
    ['IDR', '0.0005'],
    ['JPY', '0.05']
  ] as const)('%s 直接反算人民币市场汇率，不使用收购折扣', async (currency, rate) => {
    const { service, command, provider } = fixture();
    const result = await service.quoteOrderRate(currency, operator, quotedAt);
    expect(result.rateToCny).toBe(rate);
    expect(result.source).toBe('exchange_rate_api');
    expect(provider.fetchLatest).toHaveBeenCalledWith([currency]);
    expect(command.createFxSnapshot).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        rateToCny: rate,
        capturedAt: quotedAt,
        expiresAt: new Date(quotedAt.getTime() + 36 * 3600000)
      })
    );
  });
  it('复用已锁定的有效市场快照，拒绝过期市场数据', async () => {
    const { service, query, command, provider } = fixture();
    query.findLatestFxSnapshot.mockResolvedValue({
      id: 'market-snapshot',
      currency: 'PHP',
      rateToCny: '0.125',
      source: 'exchange_rate_api',
      capturedAt: quotedAt,
      expiresAt: new Date(quotedAt.getTime() + 3600000)
    });
    expect((await service.quoteOrderRate('PHP', operator, quotedAt)).snapshotId).toBe(
      'market-snapshot'
    );
    expect(provider.fetchLatest).not.toHaveBeenCalled();
    query.findLatestFxSnapshot.mockResolvedValue(null);
    provider.fetchLatest.mockResolvedValue({
      quotePerCny: { PHP: '8' },
      providerUpdatedAt: new Date(quotedAt.getTime() - 37 * 3600000)
    });
    await expect(service.quoteOrderRate('PHP', operator, quotedAt)).rejects.toThrow(
      '市场汇率已过期'
    );
    expect(command.createFxSnapshot).not.toHaveBeenCalled();
  });
  it('市场采集不可用时要求人工汇率', async () => {
    const { service, provider, command } = fixture();
    provider.fetchLatest.mockRejectedValue(new Error('provider unavailable'));
    await expect(service.quoteOrderRate('PHP', operator, quotedAt)).rejects.toThrow('填写人工汇率');
    expect(command.createFxSnapshot).not.toHaveBeenCalled();
  });
});

function snapshot(input: {
  id: string;
  currency: 'MYR' | 'USDT';
  rateToCny: string;
  source: 'ecb_cross' | 'combined_p2p';
  sourceReference?: string | null;
  capturedAt?: Date;
  expiresAt?: Date;
}) {
  return {
    id: input.id,
    currency: input.currency,
    rateToCny: new Prisma.Decimal(input.rateToCny),
    source: input.source,
    sourceReference: input.sourceReference ?? null,
    sourceEvidence: null,
    businessDate: new Date('2026-07-30T00:00:00.000Z'),
    capturedAt: input.capturedAt ?? quotedAt,
    expiresAt: input.expiresAt ?? new Date('2026-07-31T12:00:00.000Z'),
    manualReason: null,
    createdByUserId: operator.id,
    createdAt: quotedAt
  };
}

describe('IdBusinessV2FinanceFxService order receipt quotes', () => {
  const prisma = {
    idBusinessV2FinanceFxRateSnapshot: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn()
    },
    auditLog: {
      create: vi.fn()
    },
    $transaction: vi.fn()
  };
  const exchangeRateOrderQuoteService = {
    ensureEffective: vi.fn()
  };
  const service = new IdBusinessV2FinanceFxService(
    new V2CommandTransactionManager(prisma as never),
    new IdBusinessV2FinanceCommandRepository(),
    new IdBusinessV2FinanceQueryRepository(prisma as never),
    new V2TransactionalAuditService(),
    exchangeRateOrderQuoteService as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (work) => work(prisma));
    prisma.idBusinessV2FinanceFxRateSnapshot.findFirst.mockResolvedValue(null);
    prisma.idBusinessV2FinanceFxRateSnapshot.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        createdAt: quotedAt,
        manualReason: null
      })
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns CNY at a fixed rate without reading or writing snapshots', async () => {
    await expect(service.quoteOrderRate('CNY', operator, quotedAt)).resolves.toEqual({
      snapshotId: null,
      currency: 'CNY',
      rateToCny: '1',
      source: 'cny_fixed',
      capturedAt: quotedAt,
      expiresAt: null
    });
    expect(prisma.idBusinessV2FinanceFxRateSnapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.idBusinessV2FinanceFxRateSnapshot.create).not.toHaveBeenCalled();
  });

  it('requires a reason when resolving a manual order receipt rate', async () => {
    await expect(
      service.resolve({
        currency: 'MYR',
        occurredAt: quotedAt,
        manualRate: '1.65000000',
        manualReason: '',
        operator
      })
    ).rejects.toThrow('人工汇率必须填写原因');
    expect(prisma.idBusinessV2FinanceFxRateSnapshot.create).not.toHaveBeenCalled();
  });

  it('reuses an unexpired ECB MYR quote', async () => {
    const existing = snapshot({
      id: '22222222-2222-4222-8222-222222222222',
      currency: 'MYR',
      rateToCny: '1.69565217',
      source: 'ecb_cross'
    });
    prisma.idBusinessV2FinanceFxRateSnapshot.findFirst.mockResolvedValue(existing);

    await expect(service.quoteOrderRate('MYR', operator, quotedAt)).resolves.toMatchObject({
      snapshotId: existing.id,
      currency: 'MYR',
      rateToCny: '1.69565217',
      source: 'ecb_cross'
    });
    expect(global.fetch).toBe(originalFetch);
    expect(prisma.idBusinessV2FinanceFxRateSnapshot.create).not.toHaveBeenCalled();
  });

  it('collects the ECB cross rate when MYR has no valid snapshot', async () => {
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const value = url.includes('/D.CNY.') ? '7.80000000' : '4.60000000';
      return new Response(`TIME_PERIOD,OBS_VALUE\n2026-07-29,${value}`, {
        status: 200,
        headers: { 'content-type': 'text/csv' }
      });
    }) as typeof fetch;

    const quote = await service.quoteOrderRate('MYR', operator, quotedAt);

    expect(quote).toMatchObject({
      currency: 'MYR',
      rateToCny: '1.69565217',
      source: 'ecb_cross'
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(prisma.idBusinessV2FinanceFxRateSnapshot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        currency: 'MYR',
        rateToCny: '1.69565217',
        source: 'ecb_cross',
        createdByUserId: operator.id
      })
    });
  });

  it('uses the exchange module effective expiry for a USDT finance snapshot', async () => {
    const expiresAt = new Date('2026-07-30T12:32:00.000Z');
    exchangeRateOrderQuoteService.ensureEffective.mockResolvedValue({
      available: true,
      reason: null,
      runId: '33333333-3333-4333-8333-333333333333',
      snapshotId: '44444444-4444-4444-8444-444444444444',
      midRateToRmb: '7.12345678',
      averagedAt: quotedAt,
      expiresAt
    });

    const quote = await service.quoteOrderRate('USDT', operator, quotedAt);

    expect(quote).toMatchObject({
      currency: 'USDT',
      rateToCny: '7.12345678',
      source: 'combined_p2p',
      capturedAt: quotedAt,
      expiresAt
    });
    expect(prisma.idBusinessV2FinanceFxRateSnapshot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        currency: 'USDT',
        sourceReference: '44444444-4444-4444-8444-444444444444',
        capturedAt: quotedAt,
        expiresAt
      })
    });
  });
});
