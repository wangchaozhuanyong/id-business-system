import { afterEach, expect, it, vi } from 'vitest';
import {
  measureV2TableContent,
  getV2TableContentKey,
  rememberV2TableWidths,
  recallV2TableWidths
} from './useV2TableContentWidths';
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

it('reuses numeric layout only for the same array and layout inputs, with bounded variants', () => {
  const rows = [{ id: 'synthetic' }];
  const size = {
    widths: { name: 120 },
    tableWidth: 800,
    baseWidths: { name: 100 },
    actionPadding: {}
  };
  rememberV2TableWidths(rows, 'desktop-light-columns-v1', size);
  expect(recallV2TableWidths(rows, 'desktop-light-columns-v1')).toEqual(size);
  expect(recallV2TableWidths([...rows], 'desktop-light-columns-v1')).toBeUndefined();
  rows[0].id = 'changed';
  expect(recallV2TableWidths(rows, 'desktop-light-columns-v1')).toBeUndefined();
  rows[0].id = 'synthetic';
  expect(recallV2TableWidths(rows, 'desktop-dark-columns-v1')).toBeUndefined();
  expect(recallV2TableWidths(rows, 'desktop-light-columns-v2')).toBeUndefined();
  for (let index = 0; index < 5; index++) rememberV2TableWidths(rows, String(index), size);
  expect(recallV2TableWidths(rows, 'desktop-light-columns-v1')).toBeUndefined();
  expect(recallV2TableWidths(rows, '4')).toEqual(size);
});

it('restores only numeric layout without walking hidden record data and skips hashing cache misses', () => {
  const hiddenRead = vi.fn(() => []);
  const rows = [{ name: '原始名称', hiddenDetails: { toJSON: hiddenRead } }];
  const size = {
    widths: { name: 160 },
    tableWidth: 800,
    baseWidths: { name: 160 },
    actionPadding: {}
  };
  expect(recallV2TableWidths(rows, 'new-layout')).toBeUndefined();
  expect(hiddenRead).not.toHaveBeenCalled();
  rememberV2TableWidths(rows, 'current-layout', size);
  hiddenRead.mockClear();
  rows[0].name = '更长的新名称';
  expect(recallV2TableWidths(rows, 'current-layout', false)).toEqual(size);
  expect(hiddenRead).not.toHaveBeenCalled();
  expect(recallV2TableWidths(rows, 'current-layout')).toBeUndefined();
});

it('invalidates rendered layout for visible text, structure and font styles but ignores volatile ids', () => {
  const attributes = new Map<string, string>([['class', 'label']]);
  const child = { tagName: 'STRONG', getAttribute: (name: string) => attributes.get(name) ?? null };
  const table = { querySelectorAll: () => [cell] };
  const cell = {
    tagName: 'DIV',
    textContent: '原始名称',
    closest: () => table,
    querySelectorAll: () => [child],
    getAttribute: () => 'cell'
  };
  const contentKey = () => getV2TableContentKey(table as unknown as HTMLElement);
  const original = contentKey();
  attributes.set('id', 'transient-next-trigger');
  attributes.set('aria-describedby', 'transient-next-tooltip');
  expect(contentKey()).toBe(original);
  cell.textContent = '更长的新名称';
  expect(contentKey()).not.toBe(original);
  cell.textContent = '原始名称';
  attributes.set('style', 'font-weight:700');
  expect(contentKey()).not.toBe(original);
  attributes.delete('style');
  child.tagName = 'SPAN';
  expect(contentKey()).not.toBe(original);
});
