import { BadRequestException } from '@nestjs/common';
import { IdBusinessV2BalanceCalculatorService } from './id-business-v2-balance-calculator.service';

describe('IdBusinessV2BalanceCalculatorService', () => {
  const service = new IdBusinessV2BalanceCalculatorService();

  it('calculates the first gift card credit from a zero balance', () => {
    const result = service.calculateGiftCardCredit(
      {
        currentBalance: '0',
        balanceCostAmount: '0'
      },
      '50',
      '5.4'
    );

    expect(result.costAmount.toFixed(4)).toBe('270.0000');
    expect(result.balanceAfter.toFixed(4)).toBe('50.0000');
    expect(result.costAfter.toFixed(4)).toBe('270.0000');
    expect(result.averageCostBefore.toFixed(8)).toBe('0.00000000');
    expect(result.averageCostAfter.toFixed(8)).toBe('5.40000000');
  });

  it('calculates the moving weighted average after a second gift card credit', () => {
    const result = service.calculateGiftCardCredit(
      {
        currentBalance: '50',
        balanceCostAmount: '270'
      },
      '100',
      '5.7'
    );

    expect(result.balanceBefore.toFixed(4)).toBe('50.0000');
    expect(result.costBefore.toFixed(4)).toBe('270.0000');
    expect(result.costAmount.toFixed(4)).toBe('570.0000');
    expect(result.balanceAfter.toFixed(4)).toBe('150.0000');
    expect(result.costAfter.toFixed(4)).toBe('840.0000');
    expect(result.averageCostBefore.toFixed(8)).toBe('5.40000000');
    expect(result.averageCostAfter.toFixed(8)).toBe('5.60000000');
  });

  it('rounds the card RMB cost to four decimal places', () => {
    const result = service.calculateGiftCardCredit(
      {
        currentBalance: '0',
        balanceCostAmount: '0'
      },
      '1',
      '1.23455'
    );

    expect(result.costAmount.toFixed(4)).toBe('1.2346');
    expect(result.averageCostAfter.toFixed(8)).toBe('1.23460000');
  });

  it('calculates consumption cost using the current moving average', () => {
    const result = service.calculateConsumption(
      {
        currentBalance: '150',
        balanceCostAmount: '840'
      },
      '20'
    );

    expect(result.costAmount.toFixed(4)).toBe('112.0000');
    expect(result.balanceAfter.toFixed(4)).toBe('130.0000');
    expect(result.costAfter.toFixed(4)).toBe('728.0000');
    expect(result.averageCostBefore.toFixed(8)).toBe('5.60000000');
    expect(result.averageCostAfter.toFixed(8)).toBe('5.60000000');
  });

  it('clears all remaining cost when the full balance is consumed', () => {
    const result = service.calculateConsumption(
      {
        currentBalance: '0.0001',
        balanceCostAmount: '0.0001'
      },
      '0.0001'
    );

    expect(result.costAmount.toFixed(4)).toBe('0.0001');
    expect(result.balanceAfter.toFixed(4)).toBe('0.0000');
    expect(result.costAfter.toFixed(4)).toBe('0.0000');
    expect(result.averageCostAfter.toFixed(8)).toBe('0.00000000');
  });

  it('allows a zero-cost balance and keeps consumption cost at zero', () => {
    const result = service.calculateConsumption(
      {
        currentBalance: '10',
        balanceCostAmount: '0'
      },
      '2'
    );

    expect(result.costAmount.toFixed(4)).toBe('0.0000');
    expect(result.costAfter.toFixed(4)).toBe('0.0000');
    expect(result.averageCostAfter.toFixed(8)).toBe('0.00000000');
  });

  it('restores the exact balance and cost from an immutable consumption ledger', () => {
    const result = service.calculateReversalCredit(
      {
        currentBalance: '10',
        balanceCostAmount: '30'
      },
      '20',
      '60'
    );

    expect(result.balanceAmount.toFixed(4)).toBe('20.0000');
    expect(result.costAmount.toFixed(4)).toBe('60.0000');
    expect(result.balanceBefore.toFixed(4)).toBe('10.0000');
    expect(result.balanceAfter.toFixed(4)).toBe('30.0000');
    expect(result.costBefore.toFixed(4)).toBe('30.0000');
    expect(result.costAfter.toFixed(4)).toBe('90.0000');
    expect(result.averageCostBefore.toFixed(8)).toBe('3.00000000');
    expect(result.averageCostAfter.toFixed(8)).toBe('3.00000000');
  });

  it('rejects a reversal credit that would overflow the database amount range', () => {
    expect(() =>
      service.calculateReversalCredit(
        {
          currentBalance: '99999999999999.9999',
          balanceCostAmount: '0'
        },
        '0.0001',
        '0'
      )
    ).toThrow(BadRequestException);
  });

  it.each([
    [
      'zero face value',
      () =>
        service.calculateGiftCardCredit({ currentBalance: '0', balanceCostAmount: '0' }, '0', '5.4')
    ],
    [
      'zero exchange rate',
      () =>
        service.calculateGiftCardCredit({ currentBalance: '0', balanceCostAmount: '0' }, '50', '0')
    ],
    ['negative balance', () => service.calculateAverageCost('-1', '0')],
    ['amount scale overflow', () => service.calculateAverageCost('1.00001', '0')],
    [
      'rate scale overflow',
      () =>
        service.calculateGiftCardCredit(
          { currentBalance: '0', balanceCostAmount: '0' },
          '50',
          '5.123456789'
        )
    ],
    ['inconsistent zero balance cost', () => service.calculateAverageCost('0', '1')],
    [
      'insufficient balance',
      () => service.calculateConsumption({ currentBalance: '10', balanceCostAmount: '54' }, '20')
    ],
    [
      'database amount overflow',
      () =>
        service.calculateGiftCardCredit(
          { currentBalance: '99999999999999.9999', balanceCostAmount: '0' },
          '1',
          '1'
        )
    ]
  ])('rejects invalid input: %s', (_name, action) => {
    expect(action).toThrow(BadRequestException);
  });
});
