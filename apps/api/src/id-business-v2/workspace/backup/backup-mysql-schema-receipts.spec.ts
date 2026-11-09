import { describe, expect, it } from 'vitest';
import { mysqlSchemaReceipts, mysqlSchemaDifferences } from './backup-mysql-schema-receipts';
function metadata(body = 'synthetic-definition') {
  return Array.from(
    { length: 9 },
    (_, index) =>
      `__OBJECT_${index}__${index === 6 ? `\naudit_guard\tUPDATE\taudit_logs\t1\t${body}\tROW\tBEFORE\troot@%` : ''}`
  ).join('\n');
}
describe('physical schema diagnostics', () => {
  it('classifies a terminal delimiter difference while continuing to report a mismatch', () => {
    const before = mysqlSchemaReceipts(
      metadata(Buffer.from("SIGNAL SQLSTATE '45000';").toString('hex'))
    );
    const after = mysqlSchemaReceipts(
      metadata(Buffer.from("SIGNAL SQLSTATE '45000'").toString('hex'))
    );
    expect(mysqlSchemaDifferences(before, after)).toEqual([
      {
        identity: 'triggers:audit_guard',
        kind: 'changed',
        fields: [4],
        terminalDelimiterOnly: true
      }
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
