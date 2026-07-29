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
  const prisma = {
    idBusinessV2ExchangeRateRun: {
      findFirst: vi.fn()
    }
  };
  const settings = {
    getRecord: vi.fn(),
    isNetworkEnabled: vi.fn()
  };
  const service = new IdBusinessV2ExchangeRateQueryService(prisma as never, settings as never);

  beforeEach(() => {
    vi.clearAllMocks();
    settings.getRecord.mockResolvedValue({ intervalMinutes: 15 });
    settings.isNetworkEnabled.mockReturnValue(true);
  });

  it('returns a fresh latest successful snapshot for topup prefill', async () => {
    const success = run('success');
    prisma.idBusinessV2ExchangeRateRun.findFirst
      .mockResolvedValueOnce(success)
      .mockResolvedValueOnce(success);

    await expect(service.getEffective()).resolves.toMatchObject({
      available: true,
      runId,
      snapshotId,
      midRateToRmb: '6.73'
    });
  });

  it('blocks prefill immediately when the latest attempt failed', async () => {
    prisma.idBusinessV2ExchangeRateRun.findFirst
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
    prisma.idBusinessV2ExchangeRateRun.findFirst
      .mockResolvedValueOnce(expired)
      .mockResolvedValueOnce(expired);

    await expect(service.getEffective()).resolves.toMatchObject({
      available: false,
      reason: 'stale'
    });
  });

  it('rejects a topup prefill whose source snapshot is no longer effective', async () => {
    prisma.idBusinessV2ExchangeRateRun.findFirst
      .mockResolvedValueOnce(run('failed'))
      .mockResolvedValueOnce(run('success'));

    await expect(service.validatePrefill(snapshotId, '6.73', '6.73')).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('keeps the last fresh success effective while the next collection is running', async () => {
    const running = run('running');
    const success = run('success');
    prisma.idBusinessV2ExchangeRateRun.findFirst
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(success);

    await expect(service.getEffective()).resolves.toMatchObject({
      available: true,
      runId,
      snapshotId,
      midRateToRmb: '6.73'
    });
  });

  it('reports first collection in progress when there is no successful snapshot yet', async () => {
    prisma.idBusinessV2ExchangeRateRun.findFirst
      .mockResolvedValueOnce(run('running'))
      .mockResolvedValueOnce(null);

    await expect(service.getEffective()).resolves.toMatchObject({
      available: false,
      reason: 'collection_in_progress',
      latestRunId: runId
    });
  });
});
