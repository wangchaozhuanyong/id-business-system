import { describe, expect, it } from 'vitest';
import { calculateOneMonthInclusiveDueAt } from './subscriptionPeriod';

describe('calculateOneMonthInclusiveDueAt', () => {
  it.each([
    {
      openedAt: new Date(2026, 6, 27, 9, 52, 13, 456),
      dueAt: new Date(2026, 7, 26, 9, 52, 13, 456)
    },
    {
      openedAt: new Date(2026, 4, 8, 6, 10),
      dueAt: new Date(2026, 5, 7, 6, 10)
    },
    {
      openedAt: new Date(2026, 0, 31, 6, 10),
      dueAt: new Date(2026, 1, 27, 6, 10)
    },
    {
      openedAt: new Date(2028, 0, 31, 6, 10),
      dueAt: new Date(2028, 1, 28, 6, 10)
    },
    {
      openedAt: new Date(2026, 11, 31, 6, 10),
      dueAt: new Date(2027, 0, 30, 6, 10)
    },
    {
      openedAt: new Date(2026, 1, 9, 9, 52),
      dueAt: new Date(2026, 2, 8, 9, 52)
    }
  ])('calculates $openedAt as $dueAt without mutating the opening time', ({ openedAt, dueAt }) => {
    const originalOpenedAt = new Date(openedAt);

    expect(calculateOneMonthInclusiveDueAt(openedAt)).toEqual(dueAt);
    expect(openedAt).toEqual(originalOpenedAt);
  });
});
