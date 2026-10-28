import { describe, expect, it } from 'vitest';
import {
  mailboxQueryCodeValidityOptions,
  previewMailboxQueryCodeExpiry
} from './mailboxQueryCodeValidity';

describe('mailbox query code reset preview', () => {
  it('offers the same four explicit day-based periods to both mailbox managers', () => {
    expect(mailboxQueryCodeValidityOptions.map((option) => option.days)).toEqual([
      30, 90, 180, 365
    ]);
  });
  it.each([
    [30, '2026-11-26T08:00:00.000Z'],
    [90, '2027-01-25T08:00:00.000Z'],
    [180, '2027-04-25T08:00:00.000Z'],
    [365, '2027-10-27T08:00:00.000Z']
  ])('previews %i days from issuance across month/year boundaries', (days, expected) => {
    expect(
      previewMailboxQueryCodeExpiry(Date.parse('2026-10-27T08:00:00.000Z'), Number(days))
    ).toBe(expected);
  });
});
