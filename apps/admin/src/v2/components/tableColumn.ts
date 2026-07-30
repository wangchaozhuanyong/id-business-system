export const V2_TABLE_COLUMN_WIDTH = {
  index: 72,
  compact: 112,
  standard: 128,
  wide: 160,
  dateTime: 165,
  identifier: 192,
  longText: 224
} as const;

export type V2TableColumnWidthPreset = keyof typeof V2_TABLE_COLUMN_WIDTH;

export type V2TableColumnKind = 'text' | 'identifier' | 'index' | 'numeric' | 'date' | 'status';

export type V2TableColumnAlignment = 'left' | 'center' | 'right';

export const V2_TABLE_COLUMN_ALIGNMENT: Record<V2TableColumnKind, V2TableColumnAlignment> = {
  text: 'left',
  identifier: 'left',
  index: 'center',
  numeric: 'right',
  date: 'left',
  status: 'center'
};

export function getV2TableColumnClass(kind: V2TableColumnKind) {
  return `v2-table-column v2-table-column--${kind}`;
}
