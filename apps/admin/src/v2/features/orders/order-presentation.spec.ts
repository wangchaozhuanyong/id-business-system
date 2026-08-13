import { describe, expect, it } from 'vitest';
import { accountDispositionMeta } from './order-presentation';

describe('order presentation', () => {
  it('distinguishes a refunded sold ID from a corrected sale record', () => {
    expect(accountDispositionMeta('recovered', 'refunded').label).toBe('ID 已退款');
    expect(accountDispositionMeta('recovered', 'completed').label).toBe('售出已纠正');
  });
});
