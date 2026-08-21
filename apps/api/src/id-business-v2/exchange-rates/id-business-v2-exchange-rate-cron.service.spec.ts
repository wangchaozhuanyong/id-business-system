import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2ExchangeRateCronService } from './id-business-v2-exchange-rate-cron.service';

const cronSecret = 'test-exchange-rate-cron-secret-32-characters';

describe('IdBusinessV2ExchangeRateCronService', () => {
  const worker = {
    runScheduled: vi.fn()
  };
  const purchaseRateWorker = {
    runScheduled: vi.fn()
  };
  const service = new IdBusinessV2ExchangeRateCronService(
    worker as never,
    purchaseRateWorker as never
  );
  const originalSecret = process.env.ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET = cronSecret;
    worker.runScheduled.mockResolvedValue({ status: 'skipped', reason: 'not_due' });
    purchaseRateWorker.runScheduled.mockResolvedValue({ status: 'skipped', reason: 'not_due' });
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET;
    } else {
      process.env.ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET = originalSecret;
    }
  });

  it('runs collection but leaves physical cleanup to the governance workflow', async () => {
    await expect(service.run(`Bearer ${cronSecret}`)).resolves.toMatchObject({
      collection: { status: 'skipped', reason: 'not_due' },
      purchaseRates: { status: 'skipped', reason: 'not_due' },
      retention: {
        cleanupMode: 'governance_approval_required',
        automaticCleanupExecuted: false
      }
    });
    expect(worker.runScheduled).toHaveBeenCalledTimes(1);
    expect(purchaseRateWorker.runScheduled).toHaveBeenCalledTimes(1);
  });

  it('rejects missing configuration and invalid callers without doing work', async () => {
    delete process.env.ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET;
    await expect(service.run(`Bearer ${cronSecret}`)).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );

    process.env.ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET = cronSecret;
    await expect(service.run('Bearer wrong-secret')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(worker.runScheduled).not.toHaveBeenCalled();
    expect(purchaseRateWorker.runScheduled).not.toHaveBeenCalled();
  });

  it('still attempts purchase-rate collection before propagating an unrelated collection failure', async () => {
    worker.runScheduled.mockRejectedValue(new Error('provider unavailable'));

    await expect(service.run(`Bearer ${cronSecret}`)).rejects.toThrow('provider unavailable');
    expect(purchaseRateWorker.runScheduled).toHaveBeenCalledTimes(1);
  });
});
