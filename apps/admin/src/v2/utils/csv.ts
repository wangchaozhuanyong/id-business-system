export type AccountCountryCsvHeader = '国家' | 'ID地区';

export function resolveAccountCountryCsvHeader(
  headers: readonly string[]
): AccountCountryCsvHeader | null {
  if (headers.includes('国家')) return '国家';
  if (headers.includes('ID地区')) return 'ID地区';
  return null;
}

export function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const nextCharacter = source[index + 1];

    if (character === '"') {
      if (quoted && nextCharacter === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (character === ',' && !quoted) {
      row.push(value);
      value = '';
      continue;
    }

    if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && nextCharacter === '\n') {
        index += 1;
      }
      row.push(value);
      if (row.some((cell) => cell.trim())) {
        rows.push(row);
      }
      row = [];
      value = '';
      continue;
    }

    value += character;
  }

  if (quoted) {
    throw new Error('CSV 文件存在未闭合的引号');
  }

  row.push(value);
  if (row.some((cell) => cell.trim())) {
    rows.push(row);
  }

  return rows;
}
