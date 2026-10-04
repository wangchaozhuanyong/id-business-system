import { describe, expect, it } from 'vitest';
import { Amount4 } from '../runtime/public-api';
import {
  allocateSupplierBookCost,
  assertSupplierBookCost
} from './id-business-v2-finance-supplier-cost';

describe('supplier historical book cost allocation', () => {
  it('multiplies exactly before dividing and takes the complete remainder on the final quantity', () => {
    let quantity = Amount4.from('3');
    let cost = Amount4.from('10');
    const allocations: string[] = [];
    for (let index = 0; index < 3; index++) {
      const allocated = allocateSupplierBookCost(quantity, cost, Amount4.from('1'));
      allocations.push(allocated.toString());
      quantity = quantity.sub('1');
      cost = cost.sub(allocated);
    }
    expect(allocations).toEqual(['3.3333', '3.3334', '3.3333']);
    expect(quantity.toString()).toBe('0');
    expect(cost.toString()).toBe('0');
  });

  it('does not lose precision on high-value quantities or round to an eight-place rate first', () => {
    expect(
      allocateSupplierBookCost(
        Amount4.from('100000000'),
        Amount4.from('700.0001'),
        Amount4.from('50000000')
      ).toString()
    ).toBe('350.0001');
    expect(
      allocateSupplierBookCost(
        Amount4.from('0.0003'),
        Amount4.from('0.0002'),
        Amount4.from('0.0001')
      ).toString()
    ).toBe('0.0001');
  });

  it('blocks a partial allocation that would create positive foreign quantity with no book cost', () => {
    expect(() =>
      allocateSupplierBookCost(
        Amount4.from('100000000'),
        Amount4.from('700.0001'),
        Amount4.from('99999999')
      )
    ).toThrow('剩余外币成本低于金额精度');
    expect(
      allocateSupplierBookCost(
        Amount4.from('100000000'),
        Amount4.from('700.0001'),
        Amount4.from('100000000')
      ).toString()
    ).toBe('700.0001');
  });

  it.each([
    ['0', '1'],
    ['-1', '-7'],
    ['1', '0'],
    ['1', '-7']
  ])('rejects unverified foreign balance/cost %s/%s', (quantity, cost) => {
    expect(() => assertSupplierBookCost('USD', Amount4.from(quantity), Amount4.from(cost))).toThrow(
      '历史成本异常'
    );
  });

  it('keeps an existing CNY debt valid without applying a foreign positive-balance ratio', () => {
    expect(() =>
      assertSupplierBookCost('CNY', Amount4.from('-20'), Amount4.from('-20'))
    ).not.toThrow();
    expect(() => assertSupplierBookCost('CNY', Amount4.from('-20'), Amount4.from('-19'))).toThrow(
      '账面成本不一致'
    );
  });
});
