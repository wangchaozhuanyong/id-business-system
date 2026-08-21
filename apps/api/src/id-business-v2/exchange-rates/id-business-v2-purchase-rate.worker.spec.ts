import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Rate8 } from '../runtime/public-api';
import { IdBusinessV2PurchaseRateProviderError } from './id-business-v2-purchase-rate-provider.types';
import { IdBusinessV2PurchaseRateWorker } from './id-business-v2-purchase-rate.worker';
import { IdBusinessV2PurchaseRateRunLockedError } from './persistence/id-business-v2-purchase-rate-automation.repository';

const operator = {
  id: '10000000-0000-4000-8000-000000000001',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: ['apple.exchange_rate.view', 'apple.exchange_rate.collect']
};

function currency(previousMarketRate?: string) {
  return {
    code: 'USD',
    purchaseRatio: Rate8.from('0.7'),
    quoteUnit: Rate8.from('1'),
    decimalPlaces: 4,
    roundingMode: 'ROUND_DOWN' as const,
    snapshots: previousMarketRate ? [{ marketRateCnyPerUnit: Rate8.from(previousMarketRate) }] : []
  };
}

function setup(previousMarketRate?: string) {
  const settings = {
    autoEnabled: true,
    intervalMinutes: 60,
    staleMinutes: 120,
    abnormalChangeRate: Rate8.from('0.1'),
    nextRunAt: new Date('2026-08-20T11:05:00.000Z'),
    updatedByUserId: null,
    createdAt: new Date('2026-08-20T00:00:00.000Z'),
    updatedAt: new Date('2026-08-20T00:00:00.000Z')
  };
  const repository = {
    recoverStaleRuns: vi.fn().mockResolvedValue({ count: 0 }),
    findSettingsInTransaction: vi.fn().mockResolvedValue(settings),
    listEnabledCurrencies: vi.fn().mockResolvedValue([currency(previousMarketRate)]),
    createRun: vi.fn().mockResolvedValue({ id: '20000000-0000-4000-8000-000000000001' }),
    publishRun: vi.fn().mockResolvedValue({ id: '20000000-0000-4000-8000-000000000001' }),
    claimRunningForPublish: vi.fn().mockResolvedValue({ count: 1 }),
    claimPendingReview: vi.fn().mockResolvedValue({ count: 1 }),
    rejectRun: vi.fn().mockResolvedValue({ count: 1 }),
    findRunInTransaction: vi.fn(),
    markRunPendingReview: vi.fn().mockResolvedValue({ count: 1 }),
    markRunFailed: vi.fn().mockResolvedValue({ count: 1 })
  };
  const settingsService = { getRecord: vi.fn().mockResolvedValue(settings) };
  const provider = {
    fetchLatest: vi.fn().mockResolvedValue({
      provider: 'currencyapi',
      baseCurrency: 'CNY',
      providerUpdatedAt: new Date(),
      quotePerCny: { USD: '0.125' },
      sourceContract: 'currencyapi-v3-latest-cny-base',
      sourceReference: 'https://api.currencyapi.com/v3/latest?base_currency=CNY&currencies=USD'
    }),
    getRuntime: vi.fn()
  };
  const transactionManager = {
    execute: vi.fn(async (work: (tx: object) => Promise<unknown>) => work({}))
  };
  const audit = { append: vi.fn().mockResolvedValue(undefined) };
  const queryService = {
    assertRunId: vi.fn(),
    parseCandidates: vi.fn((value: unknown) => value),
    getRun: vi.fn().mockResolvedValue({ id: '20000000-0000-4000-8000-000000000001' })
  };
  const worker = new IdBusinessV2PurchaseRateWorker(
    repository as never,
    settingsService as never,
    provider as never,
    queryService as never,
    transactionManager as never,
    audit as never
  );
  return { worker, repository, provider, queryService, audit };
}

describe('IdBusinessV2PurchaseRateWorker', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://test.invalid/database';
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('inverts the direct CNY-base quote and atomically publishes the calculated snapshot', async () => {
    const { worker, repository } = setup();

    await expect(worker.collectManual(operator, 'request-1')).resolves.toMatchObject({
      status: 'success',
      publishedCurrencyCount: 1
    });
    expect(repository.publishRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        snapshots: [
          expect.objectContaining({
            currencyCode: 'USD',
            marketRateCnyPerUnit: '8',
            purchaseRateRaw: '5.6',
            purchaseRateDisplay: '5.6',
            marketRateSource: 'currencyapi'
          })
        ]
      })
    );
  });

  it('holds the entire batch for review when a currency changes by more than ten percent', async () => {
    const { worker, repository } = setup('7');

    await expect(worker.collectManual(operator, 'request-2')).resolves.toMatchObject({
      status: 'pending_review',
      abnormalCurrencyCodes: ['USD'],
      retainedPreviousQuotes: true
    });
    expect(repository.markRunPendingReview).toHaveBeenCalledOnce();
    expect(repository.publishRun).not.toHaveBeenCalled();
  });

  it('retries a retryable provider failure and records the successful attempt count', async () => {
    vi.useFakeTimers();
    const { worker, repository, provider } = setup();
    provider.fetchLatest.mockRejectedValueOnce(
      new IdBusinessV2PurchaseRateProviderError(
        'purchase_rate_provider_http_503',
        '供应商暂时不可用',
        true
      )
    );

    const result = worker.collectManual(operator, 'request-3');
    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toMatchObject({ status: 'success' });
    expect(provider.fetchLatest).toHaveBeenCalledTimes(2);
    expect(repository.publishRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ attemptCount: 2 })
    );
  });

  it('keeps the previous quote and records failure without publishing zeros', async () => {
    const { worker, repository, provider } = setup('7');
    provider.fetchLatest.mockRejectedValueOnce(
      new IdBusinessV2PurchaseRateProviderError(
        'purchase_rate_provider_not_configured',
        '收购汇率供应商密钥未配置',
        false
      )
    );

    await expect(worker.collectManual(operator, 'request-4')).resolves.toMatchObject({
      status: 'failed',
      retainedPreviousQuotes: true,
      errorCode: 'purchase_rate_provider_not_configured'
    });
    expect(repository.markRunFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ attemptCount: 1 })
    );
    expect(repository.publishRun).not.toHaveBeenCalled();
  });

  it('rejects provider data older than the configured validity window', async () => {
    const { worker, repository, provider } = setup('7');
    provider.fetchLatest.mockResolvedValueOnce({
      provider: 'currencyapi',
      baseCurrency: 'CNY',
      providerUpdatedAt: new Date(Date.now() - 121 * 60_000),
      quotePerCny: { USD: '0.125' },
      sourceContract: 'currencyapi-v3-latest-cny-base',
      sourceReference: 'https://api.currencyapi.com/v3/latest?base_currency=CNY&currencies=USD'
    });

    await expect(worker.collectManual(operator, 'request-5')).resolves.toMatchObject({
      status: 'failed',
      retainedPreviousQuotes: true,
      errorCode: 'purchase_rate_provider_stale_data'
    });
    expect(repository.publishRun).not.toHaveBeenCalled();
  });

  it('skips a second task when the database unique running lock is held', async () => {
    const { worker, repository, provider } = setup();
    repository.createRun.mockRejectedValueOnce(new IdBusinessV2PurchaseRateRunLockedError());

    await expect(worker.collectManual(operator, 'request-6')).resolves.toEqual({
      status: 'skipped',
      reason: 'already_running'
    });
    expect(provider.fetchLatest).not.toHaveBeenCalled();
  });

  it('publishes an abnormal candidate only after an administrator confirms it', async () => {
    const { worker, repository, queryService, audit } = setup();
    const candidate = {
      currencyCode: 'USD',
      marketRateCnyPerUnit: '8',
      providerQuotePerCny: '0.125',
      purchaseRatio: '0.7',
      quoteUnit: '1',
      purchaseRateRaw: '5.6',
      purchaseRateDisplay: '5.6',
      decimalPlaces: 4,
      roundingMode: 'ROUND_DOWN',
      previousMarketRateCnyPerUnit: '7',
      changeRate: '0.14285714',
      abnormal: true
    };
    repository.findRunInTransaction.mockResolvedValueOnce({
      id: '20000000-0000-4000-8000-000000000001',
      status: 'pending_review',
      candidateQuotes: [candidate],
      providerUpdatedAt: new Date('2026-08-20T10:00:00.000Z'),
      sourceContract: 'currencyapi-v3-latest-cny-base',
      sourceReference: 'https://api.currencyapi.com/v3/latest?base_currency=CNY&currencies=USD',
      finishedAt: new Date('2026-08-20T10:00:01.000Z'),
      attemptCount: 1,
      maximumChangeRate: Rate8.from('0.14285714'),
      abnormalCurrencyCodes: ['USD'],
      requestedCurrencyCodes: ['USD']
    });

    await expect(
      worker.confirmRun(
        '20000000-0000-4000-8000-000000000001',
        { remark: '已人工核对' },
        operator,
        'request-7'
      )
    ).resolves.toMatchObject({ review: { status: 'success', publishedCurrencyCount: 1 } });
    expect(queryService.parseCandidates).toHaveBeenCalledWith([candidate], ['USD']);
    expect(repository.publishRun).toHaveBeenCalledWith(
      expect.anything(),
      '20000000-0000-4000-8000-000000000001',
      expect.objectContaining({
        reviewedByUserId: operator.id,
        snapshots: [
          expect.objectContaining({
            currencyCode: 'USD',
            validationStatus: 'confirmed_abnormal',
            createdByUserId: operator.id
          })
        ]
      })
    );
    expect(audit.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'id_business_v2.exchange_rate.purchase_rate.review.confirm'
      })
    );
  });

  it('rejects an abnormal batch without publishing its candidate quotes', async () => {
    const { worker, repository, audit } = setup();
    repository.findRunInTransaction.mockResolvedValueOnce({
      id: '20000000-0000-4000-8000-000000000001',
      status: 'pending_review',
      abnormalCurrencyCodes: ['USD']
    });

    await expect(
      worker.rejectRun(
        '20000000-0000-4000-8000-000000000001',
        { remark: '供应商波动待复核' },
        operator,
        'request-8'
      )
    ).resolves.toMatchObject({ review: { status: 'rejected' } });
    expect(repository.rejectRun).toHaveBeenCalledOnce();
    expect(repository.publishRun).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'id_business_v2.exchange_rate.purchase_rate.review.reject'
      })
    );
  });
});
