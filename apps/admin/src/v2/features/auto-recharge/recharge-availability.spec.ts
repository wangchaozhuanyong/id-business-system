import { describe, expect, it } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import {
  accountReferenceFromJson,
  rechargeAddressReserved,
  paymentBlockedForAccount,
  rechargeJobUsesConnection
} from './recharge-availability';
import type { V2RechargeJob } from './contracts';

const source = {
  id: 'synthetic-job',
  plan: 'plus',
  action: 'bitbrowser',
  state: 'finished',
  createdAt: '',
  updatedAt: '',
  chatgptAccountId: 'saved-a',
  result: { payment_attempted: true, payment_status: 'unknown' },
  availability: {
    execution: 'released',
    payment: 'unknown',
    accountPaymentRestricted: true,
    accountReference: 'fingerprint-a',
    canInspect: true
  }
} as V2RechargeJob;
describe('account-scoped payment controls', () => {
  it('独立连接不得同时选用同一条地址，释放后的记录不再占用地址', () => {
    const job = {
      ...source,
      result: { addressId: 'address-a' },
      availability: { ...source.availability!, execution: 'active' as const }
    };
    expect(rechargeAddressReserved(job, 'address-a')).toBe(true);
    expect(rechargeAddressReserved(job, 'address-b')).toBe(false);
    expect(rechargeAddressReserved(job, 'address-a', job.id)).toBe(false);
    expect(
      rechargeAddressReserved({ ...job, availability: source.availability }, 'address-a')
    ).toBe(false);
  });
  it('different connections do not occupy this connection, while legacy unknown bindings stay protected', () => {
    expect(
      rechargeJobUsesConnection({ ...source, connectionProfileId: 'computer-a' }, 'computer-b')
    ).toBe(false);
    expect(
      rechargeJobUsesConnection({ ...source, connectionProfileId: 'computer-a' }, 'computer-a')
    ).toBe(true);
    expect(rechargeJobUsesConnection({ ...source, connectionProfileId: null }, 'computer-b')).toBe(
      false
    );
    expect(rechargeJobUsesConnection(source, 'computer-b')).toBe(true);
    expect(
      paymentBlockedForAccount(
        { ...source, connectionProfileId: 'computer-a' },
        { savedId: 'saved-a' }
      )
    ).toBe(true);
  });
  it('a selected historical failure never disables another account', () => {
    expect(paymentBlockedForAccount(source, { reference: 'fingerprint-b' })).toBe(false);
    expect(paymentBlockedForAccount(source, { savedId: 'saved-b' })).toBe(false);
    expect(paymentBlockedForAccount(source, {})).toBe(false);
    expect(paymentBlockedForAccount(source, { reference: 'fingerprint-a' })).toBe(true);
    expect(paymentBlockedForAccount(source, { savedId: 'saved-a' })).toBe(true);
  });
  it('does not invent a payment attempt from an expired no-request task', () => {
    expect(
      paymentBlockedForAccount(
        {
          ...source,
          availability: {
            ...source.availability!,
            payment: 'no_request',
            accountPaymentRestricted: false
          }
        },
        { reference: 'fingerprint-a' }
      )
    ).toBe(false);
  });
  it('derives the same opaque reference as API without returning or storing credentials', async () => {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
    const id = 'synthetic-account-id';
    const sha = (value: string) => createHash('sha256').update(value).digest('hex');
    expect(
      await accountReferenceFromJson(
        JSON.stringify({ account: { id }, accessToken: 'private-fixture' })
      )
    ).toBe(sha(sha(id)));
    expect(await accountReferenceFromJson('{invalid')).toBeUndefined();
    expect(await accountReferenceFromJson('{}')).toBeUndefined();
  });
});
