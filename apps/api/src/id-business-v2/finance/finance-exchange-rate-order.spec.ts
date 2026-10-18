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

function createFixture() {
  const repository = { replayRead: vi.fn().mockResolvedValue(null) };
  const resolve = vi.fn(async ({ currency }: { currency: string }) => ({
    id: `${currency}-snapshot`,
    currency,
    rateToCny: '1',
    source: 'manual'
  }));
  const result = { id: 'posted-exchange', status: 'posted' };
  const transactions = { execute: vi.fn().mockResolvedValue(result) };
  const instance = new IdBusinessV2FinanceExchangesService(
    repository as never,
    transactions as never,
    { resolve } as never,
    {} as never,
    {} as never
  );
  return { instance, repository, resolve, transactions, result };
}

describe('same-command exchange create coordination before snapshot writes', () => {
  it('shares identical concurrent submissions before quoting or entering the posting transaction', async () => {
    const f = createFixture();
    const results = await Promise.all([f.instance.create(input), f.instance.create({ ...input })]);
    expect(results).toEqual([f.result, f.result]);
    expect(f.repository.replayRead).toHaveBeenCalledTimes(1);
    expect(f.resolve).toHaveBeenCalledTimes(2);
    expect(f.transactions.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects a changed payload on the pending key without a second quote or posting', async () => {
    const f = createFixture();
    const first = f.instance.create(input);
    await expect(f.instance.create({ ...input, targetAmount: '8' })).rejects.toThrow(
      '幂等键已用于不同换汇资料'
    );
    await expect(first).resolves.toEqual(f.result);
    expect(f.repository.replayRead).toHaveBeenCalledTimes(1);
    expect(f.transactions.execute).toHaveBeenCalledTimes(1);
  });

  it('propagates one failed attempt to both callers and releases it for an explicit later call', async () => {
    const f = createFixture();
    const failure = new Error('synthetic storage unavailable');
    f.repository.replayRead.mockRejectedValueOnce(failure);
    expect(
      await Promise.allSettled([f.instance.create(input), f.instance.create({ ...input })])
    ).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure }
    ]);
    expect(f.repository.replayRead).toHaveBeenCalledTimes(1);
    expect(f.transactions.execute).not.toHaveBeenCalled();
    await expect(f.instance.create({ ...input })).resolves.toEqual(f.result);
    expect(f.repository.replayRead).toHaveBeenCalledTimes(2);
    expect(f.transactions.execute).toHaveBeenCalledTimes(1);
  });
});
