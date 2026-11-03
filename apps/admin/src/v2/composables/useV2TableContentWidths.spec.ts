import { afterEach, expect, it, vi } from 'vitest';
import { measureV2TableContent } from './useV2TableContentWidths';
import type { V2TableSchema } from '@/v2/components/tableSystem';

afterEach(() => vi.unstubAllGlobals());
it('measures identical samples once and reuses widths until content or font changes', () => {
  let clones = 0,
    rects = 0;
  const create = () => ({
    style: {},
    className: '',
    setAttribute() {},
    append() {},
    remove() {},
    querySelectorAll: () => [],
    getBoundingClientRect: () => {
      rects++;
      return { width: 120 };
    }
  });
  vi.stubGlobal('document', { createElement: create });
  vi.stubGlobal('window', { innerWidth: 1440 });
  let font = '13px sans-serif';
  vi.stubGlobal('getComputedStyle', () => ({ font, paddingLeft: '12px', paddingRight: '12px' }));
  const table = { append: vi.fn(), querySelectorAll: () => cells };
  const cell = () => ({
    innerHTML: '合成状态',
    parentElement: { tagName: 'TD', className: 'status' },
    closest: () => table,
    cloneNode: () => {
      clones++;
      return create();
    }
  });
  const cells = [cell(), cell(), cell()];
  const schema = { columns: [{ key: 'status', kind: 'status' }] } as unknown as V2TableSchema;
  const cache = new Map<string, number>();
  const measure = () => measureV2TableContent(table as unknown as HTMLElement, schema, cache);
  expect(measure().get('status')?.content).toBe(120);
  expect(clones).toBe(1);
  expect(rects).toBe(1);
  measure();
  expect(clones).toBe(1);
  expect(rects).toBe(1);
  cells[0].innerHTML = '更长的合成状态';
  measure();
  expect(clones).toBe(2);
  font = '14px sans-serif';
  measure();
  expect(clones).toBe(4);
});

it('does not clone columns whose fixed presets ignore content, but keeps visible columns', () => {
  const cloneNode = vi.fn();
  const getStyle = vi.fn();
  vi.stubGlobal('getComputedStyle', getStyle);
  vi.stubGlobal('document', {
    createElement: () => ({ style: {}, setAttribute() {}, remove() {} })
  });
  const table = {
    querySelectorAll: () => [{ closest: () => table, cloneNode }]
  };
  const schema = {
    columns: [
      { key: 'id', kind: 'identifier', pin: 'start', widthPreset: 'identifier' },
      { key: 'date', kind: 'date', widthPreset: 'dateTime' },
      { key: 'details', kind: 'text', widthPreset: 'inlineContent' }
    ]
  } as unknown as V2TableSchema;
  expect([
    ...measureV2TableContent(table as unknown as HTMLElement, schema, new Map()).keys()
  ]).toEqual(['id', 'date', 'details']);
  expect(cloneNode).not.toHaveBeenCalled();
  expect(getStyle).not.toHaveBeenCalled();
});
