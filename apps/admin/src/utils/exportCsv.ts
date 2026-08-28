import { getV2BusinessNowMs } from '@/v2/runtime/businessClock';
import { V2_BUSINESS_TIME_ZONE } from '@/v2/utils/dateTime';

export interface CsvColumn<TItem> {
  header: string;
  value: (item: TItem) => string | number | boolean | null | undefined;
}

const CSV_TEXT_SAFETY_PREFIX = "'";
const CSV_FORMULA_MARKERS = new Set(['=', '+', '-', '@']);
const PLAIN_NEGATIVE_NUMBER = /^-(?:0|[1-9]\d*)(?:\.\d+)?$/u;

export function formatCsvValue(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined) {
    return '';
  }

  const rawText = String(value);
  const text =
    typeof value === 'string' && shouldPrefixCsvText(value)
      ? CSV_TEXT_SAFETY_PREFIX + value
      : rawText;
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

export function decodeCsvTextSafetyPrefix(value: string) {
  if (!value.startsWith(CSV_TEXT_SAFETY_PREFIX)) return value;
  const candidate = value.slice(CSV_TEXT_SAFETY_PREFIX.length);
  return shouldPrefixCsvText(candidate) ? candidate : value;
}

function shouldPrefixCsvText(value: string) {
  let candidate = value;
  while (candidate.startsWith(CSV_TEXT_SAFETY_PREFIX)) {
    candidate = candidate.slice(CSV_TEXT_SAFETY_PREFIX.length);
  }
  return requiresCsvTextSafetyPrefix(candidate);
}

function requiresCsvTextSafetyPrefix(value: string) {
  if (PLAIN_NEGATIVE_NUMBER.test(value)) return false;
  let sawLeadingControl = false;
  for (const character of value) {
    if (CSV_FORMULA_MARKERS.has(character)) return true;
    if (character === ' ') continue;
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0xfeff || character.trim() === '') {
      sawLeadingControl = true;
      continue;
    }
    return sawLeadingControl;
  }
  return sawLeadingControl;
}

function buildTimestamp() {
  const now = getV2BusinessNowMs();
  if (now === null) return 'beijing-time-pending';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: V2_BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return ['year', 'month', 'day', 'hour', 'minute', 'second']
    .map((type) => get(type as Intl.DateTimeFormatPartTypes))
    .join('');
}

export function exportRowsToCsv<TItem>(
  filenamePrefix: string,
  columns: Array<CsvColumn<TItem>>,
  rows: TItem[]
) {
  const headerLine = columns.map((column) => formatCsvValue(column.header)).join(',');
  const bodyLines = rows.map((row) =>
    columns.map((column) => formatCsvValue(column.value(row))).join(',')
  );
  const csv = ['\uFEFF' + headerLine, ...bodyLines].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = `${filenamePrefix}-${buildTimestamp()}.csv`;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  return rows.length;
}
