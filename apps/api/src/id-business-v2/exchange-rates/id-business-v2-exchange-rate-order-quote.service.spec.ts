import { ConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2ExchangeRateOrderQuoteService } from './id-business-v2-exchange-rate-order-quote.service';

const effectiveRate = {
  available: true as const,
  reason: null,
  runId: '11111111-1111-4111-8111-111111111111',
  snapshotId: '22222222-2222-4222-8222-222222222222',
  midRateToRmb: '7.12345678',
  averagedAt: new Date('2026-07-30T12:00:00.000Z'),
  expiresAt: new Date('2026-07-30T12:32:00.000Z')
};

describe('IdBusinessV2ExchangeRateOrderQuoteService', () => {
  const queryService = {
    getEffective: vi.fn()
  };
  const worker = {
    collectSystem: vi.fn()
  };
  const service = new IdBusinessV2ExchangeRateOrderQuoteService(
    queryService as never,
    worker as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reuses a currently effective USDT/CNY rate without collecting', async () => {
    queryService.getEffective.mockResolvedValue(effectiveRate);

    await expect(service.ensureEffective()).resolves.toEqual(effectiveRate);
    expect(worker.collectSystem).not.toHaveBeenCalled();
  });

  it('collects once and returns the newly effective rate when no valid quote exists', async () => {
    queryService.getEffective
      .mockResolvedValueOnce({ available: false, reason: 'stale' })
      .mockResolvedValueOnce(effectiveRate);
    worker.collectSystem.mockResolvedValue({ status: 'success' });

    await expect(service.ensureEffective()).resolves.toEqual(effectiveRate);
    expect(worker.collectSystem).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent collection requests in the same process', async () => {
    let releaseCollection: (() => void) | undefined;
    queryService.getEffective
      .mockResolvedValueOnce({ available: false, reason: 'never_collected' })
      .mockResolvedValueOnce({ available: false, reason: 'never_collected' })
      .mockResolvedValue(effectiveRate);
    worker.collectSystem.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseCollection = resolve;
        })
    );

    const first = service.ensureEffective();
    const second = service.ensureEffective();
    await vi.waitFor(() => expect(worker.collectSystem).toHaveBeenCalledOnce());
    releaseCollection?.();

    await expect(Promise.all([first, second])).resolves.toEqual([effectiveRate, effectiveRate]);
  });

  it('returns a retryable conflict when another instance is already collecting', async () => {
    queryService.getEffective.mockResolvedValue({
      available: false,
      reason: 'collection_in_progress'
    });

    await expect(service.ensureEffective()).rejects.toBeInstanceOf(ConflictException);
    expect(worker.collectSystem).not.toHaveBeenCalled();
  });
});
