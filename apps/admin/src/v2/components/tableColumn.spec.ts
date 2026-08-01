import { describe, expect, it } from 'vitest';
import {
  getV2TableColumnWidthProps,
  getV2TableColumnClass,
  V2_TABLE_COLUMN_ALIGNMENT,
  V2_TABLE_COLUMN_WIDTH
} from './tableColumn';

describe('V2 table column semantics', () => {
  it('aligns every column kind by its data type', () => {
    expect(V2_TABLE_COLUMN_ALIGNMENT).toEqual({
      text: 'left',
      identifier: 'left',
      index: 'center',
      numeric: 'right',
      date: 'left',
      status: 'center'
    });
  });

  it('keeps shared width presets on the table spacing scale', () => {
    expect(V2_TABLE_COLUMN_WIDTH).toEqual({
      index: 72,
      compact: 112,
      standard: 128,
      wide: 160,
      dateTime: 165,
      identifier: 192,
      longText: 224
    });
  });

  it('lets every unpinned data column share spare width by its minimum width', () => {
    expect(getV2TableColumnWidthProps('text', 'wide')).toEqual({ minWidth: 160 });
    expect(getV2TableColumnWidthProps('numeric', 'standard')).toEqual({ minWidth: 128 });
    expect(getV2TableColumnWidthProps('identifier', 'identifier')).toEqual({ minWidth: 192 });
    expect(getV2TableColumnWidthProps('index', 'index')).toEqual({ width: 72 });
    expect(getV2TableColumnWidthProps('text', 'compact', true)).toEqual({ width: 112 });
  });

  it('returns stable semantic classes for cells and headers', () => {
    expect(getV2TableColumnClass('numeric')).toBe('v2-table-column v2-table-column--numeric');
  });
});
