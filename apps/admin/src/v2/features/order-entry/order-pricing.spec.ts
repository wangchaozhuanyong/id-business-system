import { describe, expect, it } from 'vitest';
import {
  calculateEstimatedProfitAmount,
  calculatePlatformFeeAmount,
  calculateSuggestedReceivedAmount
} from './order-pricing';

describe('order entry pricing', () => {
  it('calculates a no-fee recommendation and rounds it up to cents', () => {
    expect(
      calculateSuggestedReceivedAmount({
        targetProfit: '10.0001',
        estimatedBalanceCostAmount: '120',
        fixedFee: '0',
        percentageFee: '0'
      })
    ).toEqual({
      amount: '130.01',
      platformFee: '0',
      estimatedProfit: '10.01',
      error: ''
    });
  });

  it('supports fixed and percentage fees with exact decimal arithmetic', () => {
    const suggestion = calculateSuggestedReceivedAmount({
      targetProfit: '20',
      estimatedBalanceCostAmount: '100',
      fixedFee: '1',
      percentageFee: '2.5'
    });

    expect(suggestion.amount).toBe('124.11');
    expect(suggestion.platformFee).toBe('4.1028');
    expect(suggestion.estimatedProfit).toBe('20.0072');
  });

  it('keeps the recommended profit at or above the requested target after fee rounding', () => {
    const suggestion = calculateSuggestedReceivedAmount({
      targetProfit: '1',
      estimatedBalanceCostAmount: '1',
      fixedFee: '0',
      percentageFee: '99.9999'
    });

    expect(suggestion.error).toBe('');
    expect(Number(suggestion.estimatedProfit)).toBeGreaterThanOrEqual(1);
  });

  it('rejects a 100 percent fee and an amount beyond the Decimal limit', () => {
    expect(
      calculateSuggestedReceivedAmount({
        targetProfit: '10',
        estimatedBalanceCostAmount: '20',
        fixedFee: '0',
        percentageFee: '100'
      }).error
    ).toContain('100%');
    expect(
      calculateSuggestedReceivedAmount({
        targetProfit: '99999999999999.9999',
        estimatedBalanceCostAmount: '1',
        fixedFee: '0',
        percentageFee: '0'
      }).error
    ).toContain('金额上限');
  });

  it('calculates fee and signed estimated profit without floating point', () => {
    expect(calculatePlatformFeeAmount('100.01', '1', '2.25')).toBe('3.2502');
    expect(calculateEstimatedProfitAmount('100.01', '3.2502', '120')).toBe('-23.2402');
  });
});
