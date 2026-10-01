import { afterEach, describe, expect, it, vi } from 'vitest';
import type { V2QuickActionItem } from '@apple-business/shared';
import {
  quickActionOrderKey,
  readQuickActionOrder,
  sortQuickActions,
  writeQuickActionOrder
} from './quickActionOrder';

afterEach(() => vi.unstubAllGlobals());

describe('personal quick action order', () => {
  it('keeps each user order separate and stores only record identifiers', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    });
    writeQuickActionOrder('user-a', ['second', 'first']);
    writeQuickActionOrder('user-b', ['first', 'second']);
    expect(readQuickActionOrder('user-a')).toEqual(['second', 'first']);
    expect(readQuickActionOrder('user-b')).toEqual(['first', 'second']);
    expect(values.get(quickActionOrderKey('user-a'))).toBe('["second","first"]');
    expect(readQuickActionOrder('')).toEqual([]);
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

  it('reports failed writes instead of claiming that an unsaved order succeeded', () => {
    vi.stubGlobal('localStorage', {
      setItem: () => {
        throw new Error('quota');
      }
    });
    expect(() => writeQuickActionOrder('user-a', ['first'])).toThrow('浏览器无法保存顺序');
    expect(() => writeQuickActionOrder('', ['first'])).toThrow('无法识别当前用户');
  });
});
