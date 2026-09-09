import { describe, expect, it } from 'vitest';
import {
  RECHARGE_ADDRESS_LOCATION,
  validateRechargeAddressImport,
  validateRechargeAddressListQuery,
  validateRechargeAddressStatus
} from './recharge-address-validation';

describe('auto recharge address validation', () => {
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
