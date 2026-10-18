import { describe, expect, it, vi } from 'vitest';
import type { V2FinanceExchangeWrite } from '@apple-business/shared';
import { IdBusinessV2FinanceExchangesService } from './id-business-v2-finance-exchanges.service';

const input: V2FinanceExchangeWrite = {
  sourceAccountId: '11111111-1111-4111-8111-111111111111',
  targetAccountId: '22222222-2222-4222-8222-222222222222',
  sourceCurrency: 'MYR',
  targetCurrency: 'USD',
  sourceAmount: '10',
  targetAmount: '9',
  feeAmount: '1',
  feeMode: 'target_deducted',
  sourceFxRateToCny: '1',
  targetFxRateToCny: '1',
  manualRateReason: '固定合成估值',
  occurredAt: '2088-02-15T00:00:00.000Z',
  idempotencyKey: 'exchange-rate-order-test'
};

function service(resolve: unknown) {
  return new IdBusinessV2FinanceExchangesService(
    {} as never,
    {} as never,
    { resolve } as never,
    {} as never,
    {} as never
  );
}

describe('exchange quote snapshot transaction order', () => {
  it('resolves both rates without overlapping writes to their shared scope versions', async () => {
    let active = 0;
    const resolve = vi.fn(async ({ currency }: { currency: string }) => {
      if (active) throw new Error('synthetic overlapping snapshot transaction');
      active++;
      try {
        await Promise.resolve();
        return { id: `${currency}-snapshot`, currency, rateToCny: '1', source: 'manual' };
      } finally {
        active--;
      }
    });
    const result = await service(resolve).quote(input);
    expect(resolve.mock.calls.map(([value]) => value.currency)).toEqual(['MYR', 'USD']);
    expect(result).toMatchObject({
      sourceFxSnapshotId: 'MYR-snapshot',
      targetFxSnapshotId: 'USD-snapshot',
      sourceFxRateToCny: '1',
      targetFxRateToCny: '1',
      sourceAmount: '10',
      targetAmount: '9',
      feeAmount: '1',
      feePercent: '10',
      effectiveRate: '0.9'
    });
  });

  it('does not start the target snapshot when source resolution fails', async () => {
    const failure = new Error('synthetic source snapshot persistence failure');
    const resolve = vi.fn().mockRejectedValue(failure);
    await expect(service(resolve).quote(input)).rejects.toBe(failure);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
