import { describe, expect, it } from 'vitest';
import {
  allocateV2TableContentWidths,
  getV2TableColumnKeyClass,
  getV2TableContentBaseWidth
} from './tableContentWidth';
import type { V2TableColumnDefinition } from './tableSystem';

const columns = [
  { key: 'status', label: '状态', kind: 'status', widthPreset: 'compact' },
  { key: 'amount', label: '金额', kind: 'numeric', widthPreset: 'standard' },
  { key: 'remark', label: '备注', kind: 'text', widthPreset: 'longText' },
  { key: 'createdAt', label: '注册时间', kind: 'date', widthPreset: 'dateTime' },
  { key: 'actions', label: '操作', kind: 'actions', layout: 'quadruple', pin: 'end' }
] as const satisfies readonly V2TableColumnDefinition[];

describe('content fitted table widths', () => {
  it('fits short rendered content including badge padding and a safety margin', () => {
    expect(getV2TableContentBaseWidth(columns[0], { header: 52, content: 76 })).toBe(78);
    expect(getV2TableContentBaseWidth(columns[1], { header: 52, content: 106 })).toBe(108);
    expect(getV2TableContentBaseWidth(columns[1], { header: 52, content: 190 })).toBe(192);
    expect(getV2TableContentBaseWidth(columns[0], { header: 52, content: 140 })).toBe(142);
    expect(getV2TableContentBaseWidth(columns[2], { header: 52, content: 0 })).toBe(80);
  });

  it('limits long values but keeps the complete header and stable dates/actions', () => {
    expect(getV2TableContentBaseWidth(columns[2], { header: 52, content: 2000 })).toBe(224);
    expect(getV2TableContentBaseWidth(columns[0], { header: 132, content: 50 })).toBe(134);
    expect(getV2TableContentBaseWidth(columns[3], { header: 52, content: 0 })).toBe(165);
    expect(getV2TableContentBaseWidth(columns[4])).toBe(340);
    expect(getV2TableContentBaseWidth(columns[4], { header: 52, content: 350 })).toBe(352);
  });

  it('preserves observed maxima when a later page or empty state has shorter content', () => {
    const first = getV2TableContentBaseWidth(columns[1], { header: 52, content: 120 });
    expect(getV2TableContentBaseWidth(columns[1], { header: 52, content: 32 }, first)).toBe(first);
    expect(getV2TableContentBaseWidth(columns[1], undefined, first)).toBe(first);
  });

  it('fits action groups instead of reserving their whole startup preset', () => {
    const fitted = getV2TableContentBaseWidth(columns[4], { header: 52, content: 288 });
    expect(fitted).toBe(290);
    expect(getV2TableContentBaseWidth(columns[4], { header: 52, content: 110 }, fitted)).toBe(
      fitted
    );
    expect(getV2TableContentBaseWidth(columns[4], undefined, fitted)).toBe(fitted);
    expect(getV2TableContentBaseWidth(columns[4], { header: 40, content: 24 })).toBe(52);
  });

  it('fills the container through text without stretching short fields or actions', () => {
    const base = { status: 78, amount: 108, remark: 80, createdAt: 165, actions: 340 };
    const narrow = allocateV2TableContentWidths(columns, base, 600);
    const wide = allocateV2TableContentWidths(columns, base, 1800);
    expect(narrow.widths).toEqual(base);
    expect(narrow.tableWidth).toBe(600);
    expect(wide.widths).toEqual({ ...base, remark: 1109 });
    expect(wide.tableWidth).toBe(1800);
  });

  it('shares spare room between text fields with more room for longer content', () => {
    const textColumns = [
      { key: 'name', label: '名称', kind: 'text', widthPreset: 'standard' },
      { key: 'email', label: '邮箱', kind: 'identifier', widthPreset: 'identifier' },
      columns[2],
      columns[4]
    ] as const satisfies readonly V2TableColumnDefinition[];
    const fitted = allocateV2TableContentWidths(
      textColumns,
      { name: 80, email: 112, remark: 80, actions: 100 },
      973.5
    );
    expect(fitted.widths).toEqual({ name: 180, email: 312, remark: 381, actions: 100 });
    expect(fitted.tableWidth).toBe(973.5);
    expect(Object.values(fitted.widths).reduce((total, width) => total + width, 0)).toBe(973);
  });

  it('keeps pinned identifiers compact when other text can fill the page', () => {
    const pinned = { ...columns[2], key: 'id', kind: 'identifier', pin: 'start' } as const;
    const fitted = allocateV2TableContentWidths(
      [pinned, columns[2], columns[4]],
      { id: 192, remark: 80, actions: 100 },
      1000
    );
    expect(fitted.widths).toEqual({ id: 192, remark: 708, actions: 100 });

    const onlyPinnedText = allocateV2TableContentWidths(
      [pinned, columns[0], columns[4]],
      { id: 192, status: 64, actions: 100 },
      1000
    );
    expect(onlyPinnedText.widths).toEqual({ id: 836, status: 64, actions: 100 });
  });

  it('shares spare room between short fields only when no text is visible', () => {
    const fixedColumns = [
      { key: 'select', label: '选择', kind: 'control', control: 'selection', width: 46 },
      { key: 'index', label: '序号', kind: 'index', widthPreset: 'index' }
    ] as const satisfies readonly V2TableColumnDefinition[];
    const fitted = allocateV2TableContentWidths(
      [...fixedColumns, columns[0], columns[1], columns[3], columns[4]],
      { status: 78, amount: 108, createdAt: 165, actions: 100 },
      1200
    );
    expect(fitted.widths).toEqual({
      select: 46,
      index: 72,
      status: 288,
      amount: 318,
      createdAt: 376,
      actions: 100
    });
    expect(fitted.tableWidth).toBe(1200);
  });

  it('fills the frame without stretching action or control columns when all data is hidden', () => {
    const fitted = allocateV2TableContentWidths([columns[4]], { actions: 100 }, 1200);
    expect(fitted).toEqual({ widths: { actions: 100 }, tableWidth: 1200 });
    expect(allocateV2TableContentWidths([], {}, 1200)).toEqual({ widths: {}, tableWidth: 1200 });
  });

  it('does not reserve space for hidden columns or allow column key collisions', () => {
    const visible = allocateV2TableContentWidths([columns[0], columns[4]], { status: 78 }, 1800);
    expect(Object.keys(visible.widths)).toEqual(['status', 'actions']);
    expect(visible.widths).toEqual({ status: 1460, actions: 340 });
    expect(visible.tableWidth).toBe(1800);
    expect(getV2TableColumnKeyClass('国家')).toMatch(/^v2-table-key-[0-9a-f-]+$/);
    expect(getV2TableColumnKeyClass('a.b')).not.toBe(getV2TableColumnKeyClass('a-b'));
  });
});
