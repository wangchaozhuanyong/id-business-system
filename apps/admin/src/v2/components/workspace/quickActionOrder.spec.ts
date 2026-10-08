import { afterEach, describe, expect, it, vi } from 'vitest';
import type { V2QuickActionItem } from '@apple-business/shared';
import {
  quickActionOrderKey,
  clearLegacyQuickActionOrder,
  readQuickActionOrder,
  sortQuickActions
} from './quickActionOrder';

afterEach(() => vi.unstubAllGlobals());

describe('personal quick action order', () => {
  it('reads previous per-user order and removes only the migrated user key', () => {
    const values = new Map<string, string>([
      [quickActionOrderKey('user-a'), '["second","first"]'],
      [quickActionOrderKey('user-b'), '["first","second"]']
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key)
    });
    expect(readQuickActionOrder('user-a')).toEqual(['second', 'first']);
    expect(readQuickActionOrder('user-b')).toEqual(['first', 'second']);
    expect(readQuickActionOrder('')).toEqual([]);
    clearLegacyQuickActionOrder('user-a');
    expect(values.has(quickActionOrderKey('user-a'))).toBe(false);
    expect(values.get(quickActionOrderKey('user-b'))).toBe('["first","second"]');
  });

  it('ignores deleted identifiers, keeps new items at the end and does not mutate fetched data', () => {
    const items = ['first', 'second', 'new'].map((id) => ({ id })) as V2QuickActionItem[];
    expect(sortQuickActions(items, ['second', 'deleted', 'first']).map((item) => item.id)).toEqual([
      'second',
      'first',
      'new'
    ]);
    expect(items.map((item) => item.id)).toEqual(['first', 'second', 'new']);
  });

  it('tolerates damaged or unavailable browser storage when reading', () => {
    const getItem = vi
      .fn()
      .mockReturnValueOnce('{broken')
      .mockReturnValueOnce('{}')
      .mockReturnValueOnce('["first",null,"first",23,"second"]')
      .mockImplementationOnce(() => {
        throw new Error('unavailable');
      });
    vi.stubGlobal('localStorage', { getItem });
    expect(readQuickActionOrder('user-a')).toEqual([]);
    expect(readQuickActionOrder('user-a')).toEqual([]);
    expect(readQuickActionOrder('user-a')).toEqual(['first', 'second']);
    expect(readQuickActionOrder('user-a')).toEqual([]);
  });

  it('does not fail a confirmed database save when old browser data cannot be removed', () => {
    vi.stubGlobal('localStorage', {
      removeItem: () => {
        throw new Error('quota');
      }
    });
    expect(() => clearLegacyQuickActionOrder('user-a')).not.toThrow();
    expect(() => clearLegacyQuickActionOrder('')).not.toThrow();
  });
});
