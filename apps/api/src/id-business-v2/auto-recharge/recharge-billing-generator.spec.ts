import { describe, expect, it, vi } from 'vitest';
const { randomInt } = vi.hoisted(() => ({ randomInt: vi.fn() }));
vi.mock('node:crypto', async (original) => ({
  ...(await original<typeof import('node:crypto')>()),
  randomInt
}));
import {
  generateRechargeBillingAddress,
  generateRechargeBillingName
} from './recharge-billing-generator';

describe('independent BitBrowser billing templates', () => {
  it('matches the online first and last name dictionary boundaries', () => {
    randomInt.mockReturnValueOnce(0).mockReturnValueOnce(0);
    expect(generateRechargeBillingName()).toBe('James Smith');
    randomInt.mockReturnValueOnce(29).mockReturnValueOnce(29);
    expect(generateRechargeBillingName()).toBe('Sandra Robinson');
  });
  it('keeps the full city, state and ZIP pairing including leading zeroes', () => {
    const expected = [
      ['Portland', 'Oregon', '97201'],
      ['Salem', 'Oregon', '97301'],
      ['Eugene', 'Oregon', '97401'],
      ['Wilmington', 'Delaware', '19801'],
      ['Dover', 'Delaware', '19901'],
      ['Billings', 'Montana', '59101'],
      ['Missoula', 'Montana', '59801'],
      ['Manchester', 'New Hampshire', '03101'],
      ['Nashua', 'New Hampshire', '03060'],
      ['Anchorage', 'Alaska', '99501'],
      ['Fairbanks', 'Alaska', '99701']
    ];
    expected.forEach(([city, state, postalCode], index) => {
      randomInt
        .mockReturnValueOnce(index)
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0);
      expect(generateRechargeBillingAddress()).toEqual({
        country: 'US',
        line1: '100 Main St',
        line2: null,
        city,
        state,
        postalCode
      });
    });
  });
});
