import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mysqlSchemaReceipts, mysqlSchemaDifferences } from './backup-mysql-schema-receipts';
function metadata(
  body = 'synthetic-definition',
  key = 'audit_guard',
  mode = 'STRICT_TRANS_TABLES'
) {
  return Array.from(
    { length: 9 },
    (_, index) =>
      `__OBJECT_${index}__${index === 6 ? `\n${key}\tUPDATE\taudit_logs\t1\t${body}\tROW\tBEFORE\troot@%\t${mode}` : ''}`
  ).join('\n');
}
const signal = "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'protect; this row'";
const hex = (body: string) => Buffer.from(body).toString('hex');

describe('physical schema diagnostics', () => {
  it('records the raw difference for a reviewed SIGNAL with only an outer terminator change', () => {
    const before = mysqlSchemaReceipts(metadata(hex(`  ${signal}\n;\n`)));
    const after = mysqlSchemaReceipts(metadata(hex(signal)));
    expect(mysqlSchemaDifferences(before, after)).toEqual([
      {
        identity: 'triggers:audit_guard',
        kind: 'changed',
        fields: [4],
        terminalDelimiterOnly: true
      }
    ]);
  });
  it('keeps changed literals, SQL modes, comments and compound bodies as mismatches', () => {
    const cases = [
      [metadata(hex(`${signal};`)), metadata(hex(signal.replace(';', '')))],
      [metadata(hex(`${signal};`)), metadata(hex(signal), 'audit_guard', 'ANSI_QUOTES')],
      [metadata(hex(`${signal} -- comment;`)), metadata(hex(`${signal} -- comment`))],
      [metadata(hex(`BEGIN ${signal}; END;`)), metadata(hex(`BEGIN ${signal}; END`))]
    ];
    for (const [before, after] of cases) {
      expect(
        mysqlSchemaDifferences(mysqlSchemaReceipts(before!), mysqlSchemaReceipts(after!))
      ).toEqual([expect.not.objectContaining({ terminalDelimiterOnly: true })]);
    }
  });
  it('recognizes the ledger assignment from the actual migration only for that trigger', () => {
    const migration = readFileSync(
      'prisma-mysql/migrations/20260830182500_mysql_trigger_service_definers/migration.sql',
      'utf8'
    );
    const trigger = 'idv2_balance_ledger_singleton_insert';
    const assignment = /SET NEW.`order_singleton_key` = CASE[\s\S]+?\nEND;/.exec(migration)![0];
    const before = mysqlSchemaReceipts(metadata(hex(assignment), trigger));
    const after = mysqlSchemaReceipts(metadata(hex(assignment.slice(0, -1)), trigger));
    expect(mysqlSchemaDifferences(before, after)).toEqual([
      expect.objectContaining({ terminalDelimiterOnly: true })
    ]);
    const unknownBefore = mysqlSchemaReceipts(metadata(hex(assignment)));
    const unknownAfter = mysqlSchemaReceipts(metadata(hex(assignment.slice(0, -1))));
    expect(mysqlSchemaDifferences(unknownBefore, unknownAfter)).toEqual([
      { identity: 'triggers:audit_guard', kind: 'changed', fields: [4] }
    ]);
  });
  it('locates the exact object and changed field without returning definition values', () => {
    const before = mysqlSchemaReceipts(metadata()),
      after = mysqlSchemaReceipts(metadata('changed-definition'));
    expect(mysqlSchemaDifferences(before, after)).toEqual([
      { identity: 'triggers:audit_guard', kind: 'changed', fields: [4] }
    ]);
    expect(JSON.stringify(after)).not.toContain('changed-definition');
    expect(mysqlSchemaDifferences(before, before)).toEqual([]);
  });
  it('detects a missing object and refuses truncated or duplicate metadata', () => {
    const source = mysqlSchemaReceipts(metadata());
    expect(mysqlSchemaDifferences(source, [])).toEqual([
      { identity: 'triggers:audit_guard', kind: 'missing', fields: [] }
    ]);
    expect(() => mysqlSchemaReceipts('__OBJECT_0__')).toThrow('CI_SCHEMA_RECEIPT_INCOMPLETE');
    expect(() =>
      mysqlSchemaReceipts(
        metadata().replace(
          '__OBJECT_7__',
          'audit_guard\tUPDATE\taudit_logs\t1\tother\tROW\tBEFORE\troot@%\n__OBJECT_7__'
        )
      )
    ).toThrow('CI_SCHEMA_RECEIPT_DUPLICATE');
  });
});
