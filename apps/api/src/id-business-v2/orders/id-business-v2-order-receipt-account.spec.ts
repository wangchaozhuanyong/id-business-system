import { describe, expect, it, vi } from 'vitest';
import {
  assertOrderReceiptAccount,
  nonZeroOrderCashLines
} from './id-business-v2-order-receipt-account';

const accountId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

describe('order receipt finance account boundary', () => {
  it('holds a current finance account row lock through the command transaction', async () => {
    const query = vi.fn().mockResolvedValue([
      {
        id: accountId,
        status: 'active',
        currency: 'CNY',
        currentBalance: '100',
        currentBalanceCny: '100'
      }
    ]);
    await expect(
      assertOrderReceiptAccount({ $queryRaw: query } as never, accountId, 'CNY', ['10'])
    ).resolves.toBe(accountId);
    expect(Array.from(query.mock.calls[0]![0] as TemplateStringsArray).join('')).toContain(
      'FOR UPDATE'
    );
    expect(query.mock.calls[0]![1]).toBe(accountId);
  });

  it('retains a cash line when either original or CNY amount is nonzero', () => {
    const common = {
      accountCode: 'cash' as const,
      direction: 'debit' as const,
      currency: 'CNY' as const,
      fxRateToCny: '1'
    };
    expect(
      nonZeroOrderCashLines([
        { ...common, amountOriginal: '0', amountCny: '0' },
        { ...common, amountOriginal: '0.0001', amountCny: '0' },
        { ...common, amountOriginal: '0', amountCny: '0.0001' }
      ])
    ).toHaveLength(2);
  });
});
