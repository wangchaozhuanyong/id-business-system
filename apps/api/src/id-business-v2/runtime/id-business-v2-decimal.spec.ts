import { Prisma } from '@prisma/client';
import { Prisma as CloudflarePrisma } from '../../generated/prisma-cloudflare/client';
import { Amount4, Rate8 } from './id-business-v2-decimal';
import { V2RowMappingError, mapAmount4, mapRate8 } from './id-business-v2-row-mapper';

describe('ID Business V2 runtime decimals', () => {
  it.each([
    ['0', '0'],
    ['0.00004', '0'],
    ['0.00005', '0.0001'],
    ['-0.00005', '-0.0001'],
    ['12.34564', '12.3456'],
    ['12.34565', '12.3457'],
    ['99999999999999.99995', '100000000000000']
  ])('normalizes Amount4 %s to %s with deterministic half-up rounding', (input, expected) => {
    expect(Amount4.from(input).toString()).toBe(expected);
  });

  it.each([
    ['0', '0'],
    ['0.000000004', '0'],
    ['0.000000005', '0.00000001'],
    ['-0.000000005', '-0.00000001'],
    ['5.643512344', '5.64351234'],
    ['5.643512345', '5.64351235']
  ])('normalizes Rate8 %s to %s', (input, expected) => {
    expect(Rate8.from(input).toString()).toBe(expected);
  });

  it('normalizes Node and Cloudflare Decimal instances without sharing their runtime', () => {
    const nodeValue = new Prisma.Decimal('12.34565');
    const cloudflareValue = new CloudflarePrisma.Decimal('12.34565');

    expect(Amount4.from(nodeValue).toString()).toBe('12.3457');
    expect(Amount4.from(cloudflareValue).toString()).toBe('12.3457');
    expect(Amount4.from(nodeValue).add(cloudflareValue).toString()).toBe('24.6914');
    expect(Amount4.from(nodeValue).equals(cloudflareValue)).toBe(true);
  });

  it('uses shared BigInt decimal math for amount and rate operations', () => {
    const amount = Amount4.from('128');
    const rate = Rate8.from('0.04');

    expect(rate.apply(amount).toString()).toBe('5.12');
    expect(amount.sub('28.00005').toString()).toBe('99.9999');
    expect(Amount4.from('-1.25').abs().toString()).toBe('1.25');
    expect(Amount4.from('1').ratio('3').toString()).toBe('0.33333333');
  });

  it('supports canonical arithmetic, comparison and zero behavior without runtime decimals', () => {
    const value = Amount4.from('10.125');

    expect(value.add('0.875').toString()).toBe('11');
    expect(value.sub('11').toString()).toBe('-0.875');
    expect(value.mul('1.25').toString()).toBe('12.6563');
    expect(value.div('4').toString()).toBe('2.5313');
    expect(value.compare('10.125')).toBe(0);
    expect(value.gt('10.1249')).toBe(true);
    expect(value.gte('10.125')).toBe(true);
    expect(value.lt('10.1251')).toBe(true);
    expect(value.lte('10.125')).toBe(true);
    expect(Amount4.zero().isZero()).toBe(true);
    expect(Amount4.zero().isNegative()).toBe(false);
    expect(Rate8.one().apply('12.34565').toString()).toBe('12.3457');
    expect(() => value.div('0')).toThrow();
  });

  it('maps persisted decimals with a stable safe error', () => {
    expect(mapAmount4(new CloudflarePrisma.Decimal('1.23456'), 'account.balance').toString()).toBe(
      '1.2346'
    );
    expect(mapRate8(new Prisma.Decimal('5.643512345'), 'exchangeRate.raw').toString()).toBe(
      '5.64351235'
    );

    expect(() => mapAmount4({} as never, 'account.balance')).toThrowError(
      expect.objectContaining({
        code: 'V2_PERSISTENCE_DECIMAL_INVALID',
        field: 'account.balance'
      }) as V2RowMappingError
    );
  });
});
