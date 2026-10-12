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

  it('gives spare room to text within its cap without stretching short fields', () => {
    const base = { status: 78, amount: 108, remark: 80, createdAt: 165, actions: 340 };
    const narrow = allocateV2TableContentWidths(columns, base, 600);
    const wide = allocateV2TableContentWidths(columns, base, 1800);
    expect(narrow.widths).toEqual(base);
    expect(narrow.tableWidth).toBe(600);
    expect(wide.widths).toEqual({ ...base, remark: 224 });
    expect(wide.tableWidth).toBe(915);
  });

  it('does not reserve space for hidden columns or allow column key collisions', () => {
    const visible = allocateV2TableContentWidths([columns[0], columns[4]], { status: 78 }, 1800);
    expect(Object.keys(visible.widths)).toEqual(['status', 'actions']);
    expect(visible.tableWidth).toBe(418);
    expect(getV2TableColumnKeyClass('国家')).toMatch(/^v2-table-key-[0-9a-f-]+$/);
    expect(getV2TableColumnKeyClass('a.b')).not.toBe(getV2TableColumnKeyClass('a-b'));
  });
});
