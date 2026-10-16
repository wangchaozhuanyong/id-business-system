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
  const dataColumns = columns.filter(isV2TableDataColumn);
  const textColumns = dataColumns.filter((column) => ['text', 'identifier'].includes(column.kind));
  // Prefer unpinned text. Short fields only grow when no text remains visible.
  const candidates =
    [
      textColumns.filter((column) => !column.pin),
      textColumns,
      dataColumns.filter((column) => !column.pin && column.kind !== 'index'),
      dataColumns.filter((column) => column.kind !== 'index')
    ].find((group) => group.length) ?? [];
  const weightedColumns = candidates.map((column) => ({
    column,
    weight: !textColumns.length
      ? 1
      : column.widthPreset === 'longText'
        ? 3
        : ['wide', 'identifier', 'inlineContent'].includes(column.widthPreset)
          ? 2
          : 1
  }));
  let remainingWeight = weightedColumns.reduce((total, { weight }) => total + weight, 0);
  for (const { column, weight } of weightedColumns) {
    const addition = Math.floor((spare * weight) / remainingWeight);
    widths[column.key] += addition;
    spare -= addition;
    remainingWeight -= weight;
  }
  return {
    widths,
    tableWidth: containerWidth
  };
}
