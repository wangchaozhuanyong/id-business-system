import { describe, expect, it } from 'vitest';
import {
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

  it('returns stable semantic classes for cells and headers', () => {
    expect(getV2TableColumnClass('numeric')).toBe('v2-table-column v2-table-column--numeric');
  });
});
