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
      amount: '133',
      exactAmount: '133.3334',
      platformFee: '0',
      estimatedProfit: '13',
      estimatedProfitRate: '9.7744',
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

    expect(suggestion.amount).toBe('130');
    expect(suggestion.exactAmount).toBe('130.3227');
    expect(suggestion.platformFee).toBe('4.25');
    expect(suggestion.estimatedProfit).toBe('25.75');
    expect(suggestion.estimatedProfitRate).toBe('19.8077');
  });

  it('recalculates the actual profit rate after whole-unit rounding', () => {
    const suggestion = calculateSuggestedReceivedAmount({
      targetProfitRate: '10',
      appliedAccountCostAmount: '0',
      estimatedBalanceCostAmount: '120',
      fixedFee: '0',
      percentageFee: '0'
    });

    expect(suggestion.error).toBe('');
    expect(suggestion.amount).toBe('133');
    expect(suggestion.estimatedProfitRate).toBe('9.7744');
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
      amount: '61',
      exactAmount: '61.2483',
      estimatedProfit: '5.8766',
      estimatedProfitRate: '9.6338'
    });
    expect(calculateEstimatedProfitAmount('61', '0', '35.1234', '20')).toBe('5.8766');
  });

  it('calculates positive, negative, and unavailable profit rates', () => {
    expect(calculateProfitRate('20', '100')).toBe('20');
    expect(calculateProfitRate('-23.24', '100.01')).toBe('-23.2377');
    expect(calculateProfitRate('0', '0')).toBeNull();
  });

  it('reverse-calculates the screenshot receipt into its actual profit rate', () => {
    const fee = calculatePlatformFeeAmount('100', '5', '0');
    const profit = calculateEstimatedProfitAmount('100', fee, '0', '38.374');

    expect(fee).toBe('5');
    expect(profit).toBe('56.626');
    expect(calculateProfitRate(profit, '100')).toBe('56.626');
  });

  it('converts CNY recommendations to CNY, MYR and USDT without mixing currencies', () => {
    expect(calculateSuggestedOriginalAmount('100', 'CNY', '')).toBe('100');
    expect(calculateSuggestedOriginalAmount('100', 'MYR', '1.6')).toBe('63');
    expect(calculateSuggestedOriginalAmount('100', 'USDT', '7.2')).toBe('14');
    expect(calculateSuggestedOriginalAmount('100', 'MYR', '1.69565217')).toBe('59');
    expect(calculateSuggestedOriginalAmount('100', 'USDT', '7.12345678')).toBe('14');
    expect(calculateSuggestedOriginalAmount('100', 'USDT', '')).toBeNull();
  });

  it('uses HALF_UP integers and a minimum of one unit for positive recommendations', () => {
    expect(calculateSuggestedOriginalAmount('99.49', 'CNY', '')).toBe('99');
    expect(calculateSuggestedOriginalAmount('99.5', 'CNY', '')).toBe('100');
    expect(calculateSuggestedOriginalAmount('100', 'MYR', '1.6')).toBe('63');
    expect(calculateSuggestedOriginalAmount('0.0001', 'USDT', '7.2')).toBe('1');
    expect(calculateSuggestedOriginalAmount('-1', 'CNY', '')).toBeNull();
  });

  it('estimates balance cost from the stored balance snapshot', () => {
    expect(calculateEstimatedBalanceCostAmount('30', '90', '10')).toBe('30');
    expect(calculateEstimatedBalanceCostAmount('3', '10', '3')).toBe('10');
    expect(calculateEstimatedBalanceCostAmount('3', '10', '4')).toBeNull();
  });
});
