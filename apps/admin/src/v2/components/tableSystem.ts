export type V2TableRole = 'primary' | 'secondary' | 'embedded';

export type V2TableMobileMode = 'cards' | 'scroll';

export type V2TableColumnPin = 'start' | 'end';

export interface V2TableDataColumnDefinition {
  readonly key: string;
  readonly label: string;
  readonly kind: 'text' | 'identifier' | 'index' | 'numeric' | 'date' | 'status';
  readonly widthPreset:
    | 'index'
    | 'compact'
    | 'standard'
    | 'wide'
    | 'dateTime'
    | 'identifier'
    | 'longText';
  readonly pin?: V2TableColumnPin;
  readonly hideable?: boolean;
}

export interface V2TableActionColumnDefinition {
  readonly key: string;
  readonly label: '操作';
  readonly kind: 'actions';
  readonly layout: 'icon' | 'single' | 'double' | 'triple' | 'wide';
  readonly pin: 'end';
}

export interface V2TableControlColumnDefinition {
  readonly key: string;
  readonly label: string;
  readonly kind: 'control';
  readonly control: 'expand' | 'selection';
  readonly width: 46 | 52;
  readonly pin?: 'start';
}

export type V2TableColumnDefinition =
  | V2TableDataColumnDefinition
  | V2TableActionColumnDefinition
  | V2TableControlColumnDefinition;

export function isV2TableDataColumn(
  column: V2TableColumnDefinition
): column is V2TableDataColumnDefinition {
  return column.kind !== 'actions' && column.kind !== 'control';
}

export type V2TableRowKeyDefinition =
  | { readonly kind: 'path'; readonly value: string }
  | { readonly kind: 'binding'; readonly value: string }
  | null;

const defaultHiddenColumnKeysByTable = new Map<string, readonly string[]>();

export interface V2TableSchema<
  TId extends string = string,
  TFeature extends string = string,
  TColumns extends readonly V2TableColumnDefinition[] = readonly V2TableColumnDefinition[]
> {
  readonly id: TId;
  readonly feature: TFeature;
  readonly role: V2TableRole;
  readonly mobileMode: V2TableMobileMode;
  readonly rowKey: V2TableRowKeyDefinition;
  /** Hidden only when the user has no saved preference for this table. */
  readonly defaultHiddenColumnKeys?: readonly string[];
  readonly columns: TColumns;
}

export function defineV2TableSchema<
  const TId extends string,
  const TFeature extends string,
  const TColumns extends readonly V2TableColumnDefinition[]
>(schema: V2TableSchema<TId, TFeature, TColumns>) {
  if (schema.defaultHiddenColumnKeys) {
    defaultHiddenColumnKeysByTable.set(schema.id, schema.defaultHiddenColumnKeys);
  }
  return Object.freeze(schema);
}

export function getV2TableDefaultHiddenColumnKeys(tableId: string) {
  return defaultHiddenColumnKeysByTable.get(tableId) ?? [];
}
