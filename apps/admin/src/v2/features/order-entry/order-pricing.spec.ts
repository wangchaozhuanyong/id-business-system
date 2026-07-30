import { describe, expect, it } from 'vitest';
import {
  calculateEstimatedBalanceCostAmount,
  calculateEstimatedProfitAmount,
  calculatePlatformFeeAmount,
  calculateProfitRate,
  calculateSuggestedOriginalAmount,
  calculateSuggestedReceivedAmount
} from './order-pricing';

describe('order entry pricing', () => {
  it('calculates a no-fee recommendation from target profit rate', () => {
    expect(
      calculateSuggestedReceivedAmount({
        targetProfitRate: '10',
        appliedAccountCostAmount: '0',
        estimatedBalanceCostAmount: '120',
        fixedFee: '0',
        percentageFee: '0'
      })
    ).toEqual({
      amount: '133.3334',
      platformFee: '0',
      estimatedProfit: '13.3334',
      estimatedProfitRate: '10',
      error: ''
    });
  });

  it('supports fixed and percentage fees with exact decimal arithmetic', () => {
    const suggestion = calculateSuggestedReceivedAmount({
      targetProfitRate: '20',
      appliedAccountCostAmount: '0',
      estimatedBalanceCostAmount: '100',
      fixedFee: '1',
      percentageFee: '2.5'
    });

    expect(suggestion.amount).toBe('130.3227');
    expect(suggestion.platformFee).toBe('4.2581');
    expect(suggestion.estimatedProfit).toBe('26.0646');
    expect(suggestion.estimatedProfitRate).toBe('20');
  });

  it('keeps the recommended profit rate at or above the requested target after fee rounding', () => {
    const suggestion = calculateSuggestedReceivedAmount({
      targetProfitRate: '0.0005',
      appliedAccountCostAmount: '0',
      estimatedBalanceCostAmount: '1',
      fixedFee: '0',
      percentageFee: '99.999'
    });

    expect(suggestion.error).toBe('');
    expect(Number(suggestion.estimatedProfitRate)).toBeGreaterThanOrEqual(0.0005);
  });

  it('rejects an impossible combined rate and an amount beyond the Decimal limit', () => {
    expect(
      calculateSuggestedReceivedAmount({
        targetProfitRate: '10',
        appliedAccountCostAmount: '0',
        estimatedBalanceCostAmount: '20',
        fixedFee: '0',
        percentageFee: '90'
      }).error
    ).toContain('合计必须小于 100%');
    expect(
      calculateSuggestedReceivedAmount({
        targetProfitRate: '99.9999',
        appliedAccountCostAmount: '0',
        estimatedBalanceCostAmount: '99999999999999.9999',
        fixedFee: '0',
        percentageFee: '0'
      }).error
    ).toContain('金额上限');
  });

  it('calculates fee and signed estimated profit without floating point', () => {
    expect(calculatePlatformFeeAmount('100.01', '1', '2.25')).toBe('3.2502');
    expect(calculateEstimatedProfitAmount('100.01', '3.25', '0', '120')).toBe('-23.24');
  });

  it('includes sold ID cost in recommendation and estimated profit', () => {
    expect(
      calculateSuggestedReceivedAmount({
        targetProfitRate: '10',
        appliedAccountCostAmount: '35.1234',
        estimatedBalanceCostAmount: '20',
        fixedFee: '0',
        percentageFee: '0'
      })
    ).toMatchObject({
      amount: '61.2483',
      estimatedProfit: '6.1249',
      estimatedProfitRate: '10.0001'
    });
    expect(calculateEstimatedProfitAmount('61.2483', '0', '35.1234', '20')).toBe('6.1249');
  });

  it('calculates positive, negative, and unavailable profit rates', () => {
    expect(calculateProfitRate('20', '100')).toBe('20');
    expect(calculateProfitRate('-23.24', '100.01')).toBe('-23.2377');
    expect(calculateProfitRate('0', '0')).toBeNull();
  });

  it('converts CNY recommendations to CNY, MYR and USDT without mixing currencies', () => {
    expect(calculateSuggestedOriginalAmount('100', 'CNY', '')).toBe('100');
    expect(calculateSuggestedOriginalAmount('100', 'MYR', '1.6')).toBe('62.5');
    expect(calculateSuggestedOriginalAmount('100', 'USDT', '7.2')).toBe('13.8889');
    expect(calculateSuggestedOriginalAmount('100', 'USDT', '')).toBeNull();
  });

  it('estimates balance cost from the stored balance snapshot', () => {
    expect(calculateEstimatedBalanceCostAmount('30', '90', '10')).toBe('30');
    expect(calculateEstimatedBalanceCostAmount('3', '10', '3')).toBe('10');
    expect(calculateEstimatedBalanceCostAmount('3', '10', '4')).toBeNull();
  });
});
