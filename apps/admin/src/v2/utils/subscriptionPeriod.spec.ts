import { describe, expect, it } from 'vitest';
import { calculateOneMonthInclusiveDueAt } from './subscriptionPeriod';

describe('calculateOneMonthInclusiveDueAt', () => {
  it.each([
    {
      openedAt: new Date('2026-07-27T01:52:13.456Z'),
      dueAt: new Date('2026-08-26T01:52:13.456Z')
    },
    {
      openedAt: new Date('2026-05-07T22:10:00.000Z'),
      dueAt: new Date('2026-06-06T22:10:00.000Z')
    },
    {
      openedAt: new Date('2026-01-30T22:10:00.000Z'),
      dueAt: new Date('2026-02-26T22:10:00.000Z')
    },
    {
      openedAt: new Date('2028-01-30T22:10:00.000Z'),
      dueAt: new Date('2028-02-27T22:10:00.000Z')
    },
    {
      openedAt: new Date('2026-12-30T22:10:00.000Z'),
      dueAt: new Date('2027-01-29T22:10:00.000Z')
    },
    {
      openedAt: new Date('2026-02-09T01:52:00.000Z'),
      dueAt: new Date('2026-03-08T01:52:00.000Z')
    }
  ])('calculates $openedAt as $dueAt without mutating the opening time', ({ openedAt, dueAt }) => {
    const originalOpenedAt = new Date(openedAt);

    expect(calculateOneMonthInclusiveDueAt(openedAt)).toEqual(dueAt);
    expect(openedAt).toEqual(originalOpenedAt);
  });
});
