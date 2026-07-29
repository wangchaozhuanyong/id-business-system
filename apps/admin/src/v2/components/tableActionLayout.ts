export const V2_TABLE_ACTION_COLUMN_WIDTH = {
  icon: 76,
  single: 126,
  double: 180,
  triple: 260,
  wide: 272
} as const;

export type V2TableActionLayout = keyof typeof V2_TABLE_ACTION_COLUMN_WIDTH;
