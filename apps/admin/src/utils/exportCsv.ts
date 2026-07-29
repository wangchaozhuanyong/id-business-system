export interface CsvColumn<TItem> {
  header: string;
  value: (item: TItem) => string | number | boolean | null | undefined;
}

function formatCsvValue(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined) {
    return '';
  }

  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function buildTimestamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');

  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('');
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
