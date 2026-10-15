import { describe, expect, it } from 'vitest';
import {
  RECHARGE_ADDRESS_LOCATION,
  validateRechargeAddressGeneration,
  validateRechargeAddressImport,
  validateRechargeAddressListQuery,
  validateRechargeAddressStatus
} from './recharge-address-validation';

describe('auto recharge address validation', () => {
  it('bounds generation and rejects overrides or coerced counts', () => {
    expect(validateRechargeAddressGeneration({})).toEqual({ count: 10 });
    for (const count of [1, 100])
      expect(validateRechargeAddressGeneration({ count })).toEqual({ count });
    for (const count of [0, 101, 1.5, '10', null, true, Number.NaN])
      expect(() => validateRechargeAddressGeneration({ count })).toThrow();
    for (const value of [null, [], { count: 1, ownerId: 'other' }, { city: 'elsewhere' }])
      expect(() => validateRechargeAddressGeneration(value)).toThrow();
  });
  it('keeps the requested location fixed and normalizes unique streets', () => {
    expect(RECHARGE_ADDRESS_LOCATION).toEqual({
      country: 'US',
      city: 'Portland',
      state: 'OR',
      postalCode: '97204'
    });
    expect(
      validateRechargeAddressImport({
        streets: ['1221  SW Fourth Avenue', '1221 SW Fourth Avenue', '', 'bad\nvalue']
      })
    ).toEqual({
      streets: ['1221 SW Fourth Avenue'],
      rejected: 2,
      duplicatedInFile: 1
    });
  });

  it('bounds import size and rejects unsupported street characters', () => {
    expect(() => validateRechargeAddressImport({ streets: [] })).toThrow();
    expect(() =>
      validateRechargeAddressImport({ streets: Array.from({ length: 2001 }, () => '1 Main St') })
    ).toThrow();
    expect(() => validateRechargeAddressImport({ streets: ['中文地址'] })).toThrow();
  });

  it('accepts only controlled pagination and status values', () => {
    expect(
      validateRechargeAddressListQuery({ page: '2', pageSize: '50', status: 'unused' })
    ).toMatchObject({ page: 2, pageSize: 50, status: 'unused' });
    expect(
      validateRechargeAddressListQuery({ page: '1', pageSize: '2000', status: 'unused' })
    ).toMatchObject({ page: 1, pageSize: 2000, status: 'unused' });
    expect(() => validateRechargeAddressListQuery({ pageSize: 500 })).toThrow();
    expect(() => validateRechargeAddressStatus({ status: 'available' })).toThrow();
    expect(validateRechargeAddressStatus({ status: 'disabled' })).toBe('disabled');
  });
});
