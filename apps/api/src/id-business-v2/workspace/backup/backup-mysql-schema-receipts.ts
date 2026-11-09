import { createHash } from 'node:crypto';

const sections = [
  'tables',
  'columns',
  'indexes',
  'constraints',
  'foreignKeys',
  'checks',
  'triggers',
  'routines',
  'events'
] as const;
const keyColumns = [[0], [0, 1], [0, 1, 3], [0, 1], [0, 1, 2], [0], [0], [0, 1], [0]];
export interface MysqlSchemaReceipt {
  section: (typeof sections)[number];
  key: string;
  fields: string[];
  bodyWithoutTerminalDelimiter?: string;
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** Metadata values remain hashes; only schema-object identifiers are exposed in diagnostics. */
export function mysqlSchemaReceipts(output: string): MysqlSchemaReceipt[] {
  let section = -1;
  const receipts: MysqlSchemaReceipt[] = [];
  for (const line of output.split('\n')) {
    const marker = /^__OBJECT_(\d+)__$/.exec(line);
    if (marker) {
      const next = Number(marker[1]);
      if (next !== section + 1 || next >= sections.length)
        throw new Error('CI_SCHEMA_RECEIPT_INVALID');
      section = next;
    } else {
      if (section < 0) throw new Error('CI_SCHEMA_RECEIPT_INVALID');
      const fields = line.split('\t');
      const key = keyColumns[section]!.map((index) => fields[index] ?? '').join('.');
      if (!key) throw new Error('CI_SCHEMA_RECEIPT_INVALID');
      const bodyIndex = section === 6 ? 4 : section === 7 ? 3 : -1;
      const body = fields[bodyIndex];
      const bodyWithoutTerminalDelimiter =
        bodyIndex >= 0 && body !== undefined && /^(?:[a-f0-9]{2})*$/i.test(body)
          ? digest(Buffer.from(body, 'hex').toString('utf8').trim().replace(/;\s*$/, ''))
          : undefined;
      receipts.push({
        section: sections[section]!,
        key,
        fields: fields.map(digest),
        ...(bodyWithoutTerminalDelimiter ? { bodyWithoutTerminalDelimiter } : {})
      });
    }
  }
  if (section !== sections.length - 1) throw new Error('CI_SCHEMA_RECEIPT_INCOMPLETE');
  const keys = receipts.map((receipt) => `${receipt.section}:${receipt.key}`);
  if (new Set(keys).size !== keys.length) throw new Error('CI_SCHEMA_RECEIPT_DUPLICATE');
  return receipts;
}

export function mysqlSchemaDifferences(
  source: MysqlSchemaReceipt[],
  restored: MysqlSchemaReceipt[]
) {
  const key = (row: MysqlSchemaReceipt) => `${row.section}:${row.key}`;
  const before = new Map(source.map((row) => [key(row), row]));
  const after = new Map(restored.map((row) => [key(row), row]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((identity) => {
    const expected = before.get(identity),
      actual = after.get(identity);
    if (!expected || !actual)
      return [{ identity, kind: expected ? 'missing' : 'extra', fields: [] as number[] }];
    const fields = Array.from(
      { length: Math.max(expected.fields.length, actual.fields.length) },
      (_, index) => index
    ).filter((index) => expected.fields[index] !== actual.fields[index]);
    const bodyIndex =
      expected.section === 'triggers' ? 4 : expected.section === 'routines' ? 3 : -1;
    const terminalDelimiterOnly =
      fields.length === 1 &&
      fields[0] === bodyIndex &&
      expected.bodyWithoutTerminalDelimiter !== undefined &&
      expected.bodyWithoutTerminalDelimiter === actual.bodyWithoutTerminalDelimiter;
    return fields.length
      ? [
          {
            identity,
            kind: 'changed',
            fields,
            ...(terminalDelimiterOnly ? { terminalDelimiterOnly: true } : {})
          }
        ]
      : [];
  });
}
