import { V2_TABLE_ACTION_COLUMN_WIDTH } from './tableActionLayout';
import { V2_TABLE_COLUMN_WIDTH } from './tableColumn';
import { isV2TableDataColumn, type V2TableColumnDefinition } from './tableSystem';

export interface V2TableContentMeasurement {
  header: number;
  content: number;
  padding?: number;
}

export function getV2TableColumnKeyClass(key: string) {
  return `v2-table-key-${Array.from(key, (character) => character.codePointAt(0)!.toString(16)).join('-')}`;
}

const contentFloors = { text: 80, identifier: 112, numeric: 72, status: 64, date: 112, index: 72 };

export function getV2TableContentBaseWidth(
  column: V2TableColumnDefinition,
  measurement?: V2TableContentMeasurement,
  previous = 0
) {
  if (column.kind === 'actions') {
    if (!measurement) return previous || V2_TABLE_ACTION_COLUMN_WIDTH[column.layout];
    return Math.max(52, previous, Math.ceil(Math.max(measurement.header, measurement.content) + 2));
  }
  if (column.kind === 'control') return column.width;
  const preset = V2_TABLE_COLUMN_WIDTH[column.widthPreset];
  if (
    column.pin ||
    column.kind === 'index' ||
    ['dateTime', 'inlineContent'].includes(column.widthPreset)
  ) {
    return preset;
  }
  if (!measurement) return previous || preset;
  return Math.max(
    previous,
    contentFloors[column.kind],
    Math.ceil(measurement.header + 2),
    ['status', 'numeric'].includes(column.kind)
      ? Math.ceil(measurement.content + 2)
      : Math.min(preset, Math.ceil(measurement.content + 2))
  );
}

export function allocateV2TableContentWidths(
  columns: readonly V2TableColumnDefinition[],
  baseWidths: Readonly<Record<string, number>>,
  containerWidth: number
) {
  const widths: Record<string, number> = {};
  for (const column of columns) {
    widths[column.key] = baseWidths[column.key] ?? getV2TableContentBaseWidth(column);
  }
  let spare = Math.max(
    0,
    Math.floor(containerWidth) - Object.values(widths).reduce((a, b) => a + b, 0)
  );
  // Long text gets space first. Short status, numeric and date columns never stretch.
  for (const presets of [['longText'], ['wide', 'identifier', 'inlineContent'], ['standard']]) {
    const candidates = columns.filter(
      (column) =>
        isV2TableDataColumn(column) &&
        !column.pin &&
        ['text', 'identifier'].includes(column.kind) &&
        presets.includes(column.widthPreset)
    );
    for (let remaining = candidates.length; remaining > 0; remaining -= 1) {
      const column = candidates[candidates.length - remaining];
      if (!isV2TableDataColumn(column)) continue;
      const addition = Math.min(
        Math.ceil(spare / remaining),
        Math.max(0, V2_TABLE_COLUMN_WIDTH[column.widthPreset] - widths[column.key])
      );
      widths[column.key] += addition;
      spare -= addition;
    }
  }
  return {
    widths,
    tableWidth: Math.min(
      containerWidth,
      Object.values(widths).reduce((a, b) => a + b, 0)
    )
  };
}
