import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2ExchangeRateCronService } from './id-business-v2-exchange-rate-cron.service';

const cronSecret = 'test-exchange-rate-cron-secret-32-characters';

describe('IdBusinessV2ExchangeRateCronService', () => {
  const worker = {
    runScheduled: vi.fn()
  };
  const retention = {
    cleanup: vi.fn()
  };
  const service = new IdBusinessV2ExchangeRateCronService(worker as never, retention as never);
  const originalSecret = process.env.ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET = cronSecret;
    worker.runScheduled.mockResolvedValue({ status: 'skipped', reason: 'not_due' });
    retention.cleanup.mockResolvedValue({
      cutoff: '2026-06-28T10:00:00.000Z',
      deletedRuns: 0,
      deletedSnapshots: 0,
      deletedProviderSnapshots: 0,
      deletedQuoteSamples: 0,
      preservedReferencedRuns: 0
    });
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET;
    } else {
      process.env.ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET = originalSecret;
    }
  });

  it('runs collection and retention only for the dedicated Bearer secret', async () => {
    await expect(service.run(`Bearer ${cronSecret}`)).resolves.toMatchObject({
      collection: { status: 'skipped', reason: 'not_due' },
      retention: { deletedRuns: 0 }
    });
    expect(worker.runScheduled).toHaveBeenCalledTimes(1);
    expect(retention.cleanup).toHaveBeenCalledTimes(1);
  });

  it('rejects missing configuration and invalid callers without doing work', async () => {
    delete process.env.ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET;
    await expect(service.run(`Bearer ${cronSecret}`)).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );

    process.env.ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET = cronSecret;
    await expect(service.run('Bearer wrong-secret')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(worker.runScheduled).not.toHaveBeenCalled();
    expect(retention.cleanup).not.toHaveBeenCalled();
  });

  it('still cleans expired history when collection fails', async () => {
    worker.runScheduled.mockRejectedValue(new Error('provider unavailable'));

    await expect(service.run(`Bearer ${cronSecret}`)).rejects.toThrow('provider unavailable');
    expect(retention.cleanup).toHaveBeenCalledTimes(1);
  });
});
