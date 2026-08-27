import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Amount4 } from '../runtime/public-api';
import { IdBusinessV2ExchangeRateWorker } from './id-business-v2-exchange-rate.worker';

const operator = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'operator',
  displayName: '运营',
  roles: ['operation'],
  permissions: ['apple.exchange_rate.collect']
};

describe('IdBusinessV2ExchangeRateWorker', () => {
  const repository = {
    findStaleRuns: vi.fn(),
    findRunningRun: vi.fn(),
    recoverStaleRun: vi.fn(),
    createFinanceFxRateSnapshot: vi.fn()
  };
  const settings = {
    isNetworkEnabled: vi.fn(),
    claimDueSchedule: vi.fn(),
    getRecord: vi.fn(),
    get: vi.fn()
  };
  const persistence = {
    collectAndPersist: vi.fn()
  };
  const transactionManager = {
    execute: vi.fn(async (work) => work({}))
  };
  const audit = { append: vi.fn() };
  const worker = new IdBusinessV2ExchangeRateWorker(
    repository as never,
    settings as never,
    persistence as never,
    transactionManager as never,
    audit as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const rate = url.includes('/D.CNY.')
          ? '7.3000'
          : url.includes('/D.MYR.')
            ? '4.7000'
            : '1.1000';
        return {
          ok: true,
          text: async () => `TIME_PERIOD,OBS_VALUE\n2026-08-06,${rate}\n`
        } as Response;
      })
    );
    delete process.env.ID_BUSINESS_V2_EXCHANGE_RATE_RUN_ON_STARTUP;
    process.env.DATABASE_URL = 'postgresql://local-test';
    settings.isNetworkEnabled.mockReturnValue(true);
    settings.claimDueSchedule.mockResolvedValue(null);
    settings.getRecord.mockResolvedValue({
      targetAmountRmb: Amount4.from('5000')
    });
    settings.get.mockResolvedValue({
      autoEnabled: true,
      intervalMinutes: 30,
      targetAmountRmb: '5000',
      nextRunAt: new Date()
    });
    repository.findStaleRuns.mockResolvedValue([]);
    repository.findRunningRun.mockResolvedValue(null);
    repository.recoverStaleRun.mockResolvedValue({ count: 1 });
    repository.createFinanceFxRateSnapshot.mockImplementation(async (_tx, input) => ({
      id: input.id,
      rateToCny: input.rateToCny
    }));
    persistence.collectAndPersist.mockResolvedValue({
      runId: '33333333-3333-4333-8333-333333333333',
      snapshotId: '44444444-4444-4444-8444-444444444444',
      midRateToRmb: '6.81234567',
      averagedAt: new Date('2026-08-06T08:00:00.000Z'),
      validSampleCount: 96
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs a claimed scheduled collection with the database target amount', async () => {
    const targetAmountRmb = Amount4.from('8000');
    settings.claimDueSchedule.mockResolvedValue({
      targetAmountRmb,
      intervalMinutes: 30,
      nextRunAt: new Date()
    });

    await worker.tick();

    expect(persistence.collectAndPersist).toHaveBeenCalledWith({
      triggerType: 'scheduled',
      targetAmountRmb,
      requestId: 'exchange-rate-scheduled-collect'
    });
  });

  it('returns a structured result for a database Cron collection', async () => {
    const targetAmountRmb = Amount4.from('5000');
    settings.claimDueSchedule.mockResolvedValue({
      targetAmountRmb,
      intervalMinutes: 30,
      nextRunAt: new Date()
    });
    persistence.collectAndPersist.mockResolvedValue({
      runId: '33333333-3333-4333-8333-333333333333',
      snapshotId: '44444444-4444-4444-8444-444444444444',
      midRateToRmb: '6.81234567',
      averagedAt: new Date('2026-08-06T08:00:00.000Z'),
      validSampleCount: 96
    });

    await expect(worker.runScheduled()).resolves.toMatchObject({
      status: 'success',
      successfulCurrencies: ['USDT', 'MYR', 'USD'],
      failedCurrencies: [],
      results: [
        expect.objectContaining({
          currency: 'USDT',
          status: 'success',
          source: 'combined_p2p',
          exchangeRateRunId: '33333333-3333-4333-8333-333333333333',
          validSampleCount: 96
        }),
        expect.objectContaining({ currency: 'MYR', status: 'success', source: 'ecb_cross' }),
        expect.objectContaining({ currency: 'USD', status: 'success', source: 'ecb_cross' })
      ]
    });
    expect(repository.createFinanceFxRateSnapshot).toHaveBeenCalledTimes(3);
  });

  it('does not collect when automatic networking is disabled or another instance won the claim', async () => {
    settings.isNetworkEnabled.mockReturnValue(false);
    await worker.tick();
    expect(settings.claimDueSchedule).not.toHaveBeenCalled();

    settings.isNetworkEnabled.mockReturnValue(true);
    settings.claimDueSchedule.mockResolvedValue(null);
    await worker.tick();
    expect(persistence.collectAndPersist).not.toHaveBeenCalled();
  });

  it('recovers a timed-out running batch before checking the next schedule', async () => {
    const startedAt = new Date(Date.now() - 6 * 60_000);
    repository.findStaleRuns.mockResolvedValue([
      { id: '22222222-2222-4222-8222-222222222222', startedAt }
    ]);

    await worker.tick();

    expect(repository.recoverStaleRun).toHaveBeenCalledWith(
      expect.anything(),
      { id: '22222222-2222-4222-8222-222222222222', startedAt },
      expect.any(Date)
    );
    expect(audit.append).toHaveBeenCalled();
  });

  it('uses the current database target for an operator-triggered collection', async () => {
    const targetAmountRmb = Amount4.from('5000');
    settings.getRecord.mockResolvedValue({ targetAmountRmb });

    await worker.collectManual(operator);

    expect(persistence.collectAndPersist).toHaveBeenCalledWith({
      triggerType: 'manual',
      targetAmountRmb,
      triggeredByUserId: operator.id,
      requestId: 'exchange-rate-manual-collect'
    });
  });

  it('records an order-triggered refresh as a system collection', async () => {
    const targetAmountRmb = Amount4.from('5000');
    settings.getRecord.mockResolvedValue({ targetAmountRmb });

    await worker.collectSystem();

    expect(persistence.collectAndPersist).toHaveBeenCalledWith({
      triggerType: 'system',
      targetAmountRmb,
      requestId: 'exchange-rate-system-collect'
    });
  });
});
