import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Prisma as CloudflarePrisma } from '../../generated/prisma-cloudflare/client';
import { IdBusinessV2BalanceCalculatorService } from './id-business-v2-balance-calculator.service';

describe('IdBusinessV2BalanceCalculatorService', () => {
  const service = new IdBusinessV2BalanceCalculatorService();

  function cloudflareDecimal(value: Prisma.Decimal.Value) {
    return new CloudflarePrisma.Decimal(String(value));
  }

  it('calculates the first gift card credit from a zero balance', () => {
    const result = service.calculateGiftCardCredit(
      {
        currentBalance: '0',
        balanceCostAmount: '0'
      },
      '50',
      '5.4'
    );

    expect(result.costAmount.toFixed(3)).toBe('270.000');
    expect(result.balanceAfter.toFixed(3)).toBe('50.000');
    expect(result.costAfter.toFixed(3)).toBe('270.000');
    expect(result.averageCostBefore.toFixed(3)).toBe('0.000');
    expect(result.averageCostAfter.toFixed(3)).toBe('5.400');
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

    expect(result.balanceBefore.toFixed(3)).toBe('50.000');
    expect(result.costBefore.toFixed(3)).toBe('270.000');
    expect(result.costAmount.toFixed(3)).toBe('570.000');
    expect(result.balanceAfter.toFixed(3)).toBe('150.000');
    expect(result.costAfter.toFixed(3)).toBe('840.000');
    expect(result.averageCostBefore.toFixed(3)).toBe('5.400');
    expect(result.averageCostAfter.toFixed(3)).toBe('5.600');
  });

  it('rounds the card RMB cost half up to three decimal places', () => {
    const result = service.calculateGiftCardCredit(
      {
        currentBalance: '0',
        balanceCostAmount: '0'
      },
      '1.005',
      '1.5'
    );

    expect(result.costAmount.toFixed(3)).toBe('1.508');
    expect(result.averageCostAfter.toFixed(3)).toBe('1.500');
  });

  it('calculates consumption cost using the current moving average', () => {
    const result = service.calculateConsumption(
      {
        currentBalance: '150',
        balanceCostAmount: '840'
      },
      '20'
    );

    expect(result.costAmount.toFixed(3)).toBe('112.000');
    expect(result.balanceAfter.toFixed(3)).toBe('130.000');
    expect(result.costAfter.toFixed(3)).toBe('728.000');
    expect(result.averageCostBefore.toFixed(3)).toBe('5.600');
    expect(result.averageCostAfter.toFixed(3)).toBe('5.600');
  });

  it('normalizes Cloudflare Prisma amounts before calculating balance consumption', () => {
    const result = service.calculateConsumption(
      {
        currentBalance: cloudflareDecimal('30') as unknown as Prisma.Decimal.Value,
        balanceCostAmount: cloudflareDecimal('90') as unknown as Prisma.Decimal.Value
      },
      cloudflareDecimal('20') as unknown as Prisma.Decimal.Value
    );

    expect(result.balanceAfter.toFixed(3)).toBe('10.000');
    expect(result.costAmount.toFixed(3)).toBe('60.000');
    expect(result.costAfter.toFixed(3)).toBe('30.000');
  });

  it('clears all remaining cost when the full balance is consumed', () => {
    const result = service.calculateConsumption(
      {
        currentBalance: '0.001',
        balanceCostAmount: '0.001'
      },
      '0.001'
    );

    expect(result.costAmount.toFixed(3)).toBe('0.001');
    expect(result.balanceAfter.toFixed(3)).toBe('0.000');
    expect(result.costAfter.toFixed(3)).toBe('0.000');
    expect(result.averageCostAfter.toFixed(3)).toBe('0.000');
  });

  it('allows a zero-cost balance and keeps consumption cost at zero', () => {
    const result = service.calculateConsumption(
      {
        currentBalance: '10',
        balanceCostAmount: '0'
      },
      '2'
    );

    expect(result.costAmount.toFixed(3)).toBe('0.000');
    expect(result.costAfter.toFixed(3)).toBe('0.000');
    expect(result.averageCostAfter.toFixed(3)).toBe('0.000');
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

    expect(result.balanceAmount.toFixed(3)).toBe('20.000');
    expect(result.costAmount.toFixed(3)).toBe('60.000');
    expect(result.balanceBefore.toFixed(3)).toBe('10.000');
    expect(result.balanceAfter.toFixed(3)).toBe('30.000');
    expect(result.costBefore.toFixed(3)).toBe('30.000');
    expect(result.costAfter.toFixed(3)).toBe('90.000');
    expect(result.averageCostBefore.toFixed(3)).toBe('3.000');
    expect(result.averageCostAfter.toFixed(3)).toBe('3.000');
  });

  it('rejects a reversal credit that would overflow the database amount range', () => {
    expect(() =>
      service.calculateReversalCredit(
        {
          currentBalance: '99999999999999.999',
          balanceCostAmount: '0'
        },
        '0.001',
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
          '5.12345'
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
          { currentBalance: '99999999999999.999', balanceCostAmount: '0' },
          '1',
          '1'
        )
    ]
  ])('rejects invalid input: %s', (_name, action) => {
    expect(action).toThrow(BadRequestException);
  });
});
