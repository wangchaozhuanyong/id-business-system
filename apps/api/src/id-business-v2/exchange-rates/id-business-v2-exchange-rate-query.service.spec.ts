import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2ExchangeRateQueryService } from './id-business-v2-exchange-rate-query.service';

const runId = '11111111-1111-4111-8111-111111111111';
const snapshotId = '22222222-2222-4222-8222-222222222222';

function run(
  status: 'running' | 'success' | 'failed',
  averagedAt = new Date()
): Record<string, unknown> {
  return {
    id: runId,
    status,
    triggerType: 'scheduled',
    targetAmountRmb: new Prisma.Decimal('5000'),
    startedAt: new Date(),
    finishedAt: new Date(),
    triggeredBy: null,
    errorCode: status === 'failed' ? 'okx_otc_timeout' : null,
    errorMessage: status === 'failed' ? 'OKX 请求超时' : null,
    errorProvider: status === 'failed' ? 'okx' : null,
    errorSide: status === 'failed' ? 'merchant_sell' : null,
    errorRetryable: status === 'failed' ? true : null,
    snapshot:
      status === 'success'
        ? {
            id: snapshotId,
            averagedAt,
            combinedMerchantBuyAverageRateToRmb: new Prisma.Decimal('6.71'),
            combinedMerchantSellAverageRateToRmb: new Prisma.Decimal('6.75'),
            midRateToRmb: new Prisma.Decimal('6.73'),
            providerSnapshots: []
          }
        : null
  };
}

describe('IdBusinessV2ExchangeRateQueryService effective rate', () => {
  const repository = { findLatestRun: vi.fn(), findLatestReceiptFxSnapshots: vi.fn() };
  const settings = {
    getRecord: vi.fn(),
    isNetworkEnabled: vi.fn()
  };
  const service = new IdBusinessV2ExchangeRateQueryService(repository as never, settings as never);

  beforeEach(() => {
    vi.clearAllMocks();
    settings.getRecord.mockResolvedValue({ intervalMinutes: 15 });
    settings.isNetworkEnabled.mockReturnValue(true);
    repository.findLatestReceiptFxSnapshots.mockResolvedValue([]);
  });

  it('returns a fresh latest successful snapshot for topup prefill', async () => {
    const success = run('success');
    repository.findLatestRun.mockResolvedValueOnce(success).mockResolvedValueOnce(success);

    await expect(service.getEffective()).resolves.toMatchObject({
      available: true,
      runId,
      snapshotId,
      midRateToRmb: '6.73'
    });
  });

  it('blocks prefill immediately when the latest attempt failed', async () => {
    repository.findLatestRun
      .mockResolvedValueOnce(run('failed'))
      .mockResolvedValueOnce(run('success'));

    await expect(service.getEffective()).resolves.toMatchObject({
      available: false,
      reason: 'latest_attempt_failed',
      latestRunId: runId
    });
  });

  it('blocks an expired successful snapshot instead of serving a cached default', async () => {
    const expired = run('success', new Date(Date.now() - 20 * 60_000));
    repository.findLatestRun.mockResolvedValueOnce(expired).mockResolvedValueOnce(expired);

    await expect(service.getEffective()).resolves.toMatchObject({
      available: false,
      reason: 'stale'
    });
  });

  it('rejects a topup prefill whose source snapshot is no longer effective', async () => {
    repository.findLatestRun
      .mockResolvedValueOnce(run('failed'))
      .mockResolvedValueOnce(run('success'));

    await expect(service.validatePrefill(snapshotId, '6.73', '6.73')).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('keeps the last fresh success effective while the next collection is running', async () => {
    const running = run('running');
    const success = run('success');
    repository.findLatestRun.mockResolvedValueOnce(running).mockResolvedValueOnce(success);

    await expect(service.getEffective()).resolves.toMatchObject({
      available: true,
      runId,
      snapshotId,
      midRateToRmb: '6.73'
    });
  });

  it('reports first collection in progress when there is no successful snapshot yet', async () => {
    repository.findLatestRun.mockResolvedValueOnce(run('running')).mockResolvedValueOnce(null);

    await expect(service.getEffective()).resolves.toMatchObject({
      available: false,
      reason: 'collection_in_progress',
      latestRunId: runId
    });
  });

  it('returns receipt FX status for CNY, MYR and USDT', async () => {
    const now = new Date('2026-08-06T10:00:00.000Z');
    repository.findLatestReceiptFxSnapshots.mockResolvedValue([
      {
        id: '33333333-3333-4333-8333-333333333333',
        currency: 'MYR',
        rateToCny: '1.63000000',
        source: 'ecb_cross',
        capturedAt: new Date('2026-08-06T09:30:00.000Z'),
        expiresAt: new Date('2026-08-07T09:30:00.000Z')
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        currency: 'USDT',
        rateToCny: '7.18000000',
        source: 'combined_p2p',
        capturedAt: new Date('2026-08-06T08:00:00.000Z'),
        expiresAt: new Date('2026-08-06T09:00:00.000Z')
      }
    ]);

    await expect(service.getLatestReceiptFxRates(now)).resolves.toEqual([
      expect.objectContaining({ currency: 'CNY', rateToCny: '1', status: 'fixed' }),
      expect.objectContaining({ currency: 'MYR', rateToCny: '1.63000000', status: 'available' }),
      expect.objectContaining({ currency: 'USDT', rateToCny: '7.18000000', status: 'expired' })
    ]);
  });
});
