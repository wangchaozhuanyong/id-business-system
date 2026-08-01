import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    recoverStaleRun: vi.fn()
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
    delete process.env.CLOUDFLARE_WORKER;
    delete process.env.SUPABASE_EDGE_FUNCTION;
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
    persistence.collectAndPersist.mockResolvedValue({ status: 'success' });
  });

  it('does not start a persistent timer inside Cloudflare Workers', () => {
    process.env.CLOUDFLARE_WORKER = 'true';
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    worker.onModuleInit();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(settings.isNetworkEnabled).not.toHaveBeenCalled();
    expect(persistence.collectAndPersist).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('does not start a persistent timer inside Supabase Edge Functions', () => {
    process.env.SUPABASE_EDGE_FUNCTION = 'true';
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    worker.onModuleInit();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(settings.isNetworkEnabled).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
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
      midRateToRmb: '6.81234567',
      validSampleCount: 96
    });

    await expect(worker.runScheduled()).resolves.toEqual({
      status: 'collected',
      runId: '33333333-3333-4333-8333-333333333333',
      midRateToRmb: '6.81234567',
      validSampleCount: 96
    });
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
