import { describe, expect, it } from 'vitest';
import {
  buildNewSystemBackupCatalog,
  checkNewSystemSnapshotCoverage,
  NEW_SYSTEM_REQUIRED_MODELS,
  NEW_SYSTEM_BACKUP_PROFILE,
  type NewSystemSnapshotCoverage
} from './id-business-v2-new-backup-coverage';

const digest = 'a'.repeat(64);
function fixture() {
  const models = [...new Set(Object.values(NEW_SYSTEM_REQUIRED_MODELS).flat())].map((name) => ({
    name,
    dbName: name.toLowerCase(),
    fields: [
      { name: 'id', dbName: null, kind: 'scalar', type: 'String', isRequired: true, isList: false },
      {
        name: 'valueEncrypted',
        dbName: 'value_encrypted',
        kind: 'scalar',
        type: 'String',
        isRequired: false,
        isList: false
      },
      { name: 'version', kind: 'scalar', type: 'Int', isRequired: true, isList: false },
      { name: 'parent', kind: 'object', type: 'Other', isRequired: false, isList: false }
    ]
  }));
  const catalog = buildNewSystemBackupCatalog(models, digest);
  const snapshot: NewSystemSnapshotCoverage = {
    profile: NEW_SYSTEM_BACKUP_PROFILE,
    schemaSha256: digest,
    catalogSha256: catalog.catalogSha256,
    tables: catalog.tables.map((table) => ({
      name: table.name,
      rowCount: '0',
      columns: table.columns.map((column) => column.name)
    })),
    fileSources: catalog.requiredFileSources.map((name) => ({ name, state: 'empty', count: '0' }))
  };
  return { models, catalog, snapshot };
}

describe('new-system full snapshot coverage', () => {
  it('covers the new inventory and independent orders, retaining ciphertext and zero-row tables', () => {
    const { catalog, snapshot } = fixture();
    expect(catalog.tables.some((table) => table.model === 'IdBusinessV2GoogleMailbox')).toBe(true);
    expect(catalog.tables.some((table) => table.model === 'IdBusinessV2SubscriptionOrder')).toBe(
      true
    );
    expect(
      catalog.tables.every((table) =>
        table.columns.some((column) => column.name === 'value_encrypted')
      )
    ).toBe(true);
    expect(
      catalog.tables.every((table) => !table.columns.some((column) => column.name === 'parent'))
    ).toBe(true);
    expect(checkNewSystemSnapshotCoverage(catalog, snapshot).coverageMatches).toBe(true);
  });
  it('rejects metadata from a schema without the new Google inventory', () => {
    const { models } = fixture();
    expect(() =>
      buildNewSystemBackupCatalog(
        models.filter((model) => model.name !== 'IdBusinessV2GoogleMailbox'),
        digest
      )
    ).toThrow('新版备份模型缺失');
  });
  it('includes subsequently added tables automatically and requires their receipt', () => {
    const { models, snapshot } = fixture();
    const catalog = buildNewSystemBackupCatalog(
      [...models, { ...models[0]!, name: 'FutureFeature', dbName: 'future_feature' }],
      digest
    );
    expect(catalog.tables).toHaveLength(models.length + 1);
    expect(checkNewSystemSnapshotCoverage(catalog, snapshot).issues).toContain(
      '缺少表：future_feature'
    );
  });
  it('rejects missing fields, including encrypted values, and extra/duplicate tables', () => {
    const { catalog, snapshot } = fixture();
    snapshot.tables[0]!.columns = ['id'];
    snapshot.tables.push(
      { ...snapshot.tables[1]! },
      { name: 'old_only', rowCount: '0', columns: [] }
    );
    const result = checkNewSystemSnapshotCoverage(catalog, snapshot);
    expect(result.coverageMatches).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        '备份表清单重复',
        '非当前新版表：old_only',
        `缺少字段：${snapshot.tables[0]!.name}.value_encrypted`
      ])
    );
  });
  it('rejects another profile or a stale schema without accepting matching names alone', () => {
    const { catalog, snapshot } = fixture();
    snapshot.profile = 'legacy';
    snapshot.schemaSha256 = 'b'.repeat(64);
    expect(checkNewSystemSnapshotCoverage(catalog, snapshot).issues).toEqual(
      expect.arrayContaining(['备份来源不是新版系统', '备份结构与当前新版不一致'])
    );
  });
  it('keeps arbitrarily large exact row counts and rejects invalid counts', () => {
    const { catalog, snapshot } = fixture();
    const table = snapshot.tables.find((table) => table.name !== 'attachment')!;
    table.rowCount = '900719925474099312345';
    expect(checkNewSystemSnapshotCoverage(catalog, snapshot).coverageMatches).toBe(true);
    table.rowCount = '1.5';
    expect(checkNewSystemSnapshotCoverage(catalog, snapshot).coverageMatches).toBe(false);
  });
  it('requires original attachment and external-mail source manifests', () => {
    const { catalog, snapshot } = fixture();
    snapshot.tables.find((table) => table.name === 'attachment')!.rowCount = '1';
    snapshot.fileSources[1]!.state = 'pending';
    expect(checkNewSystemSnapshotCoverage(catalog, snapshot).issues).toEqual(
      expect.arrayContaining([
        '附件记录存在但原始文件未覆盖',
        '文件来源未覆盖：apple-relay-vendure'
      ])
    );
    snapshot.fileSources = snapshot.fileSources.map((source) => ({
      ...source,
      state: 'verified',
      count: '1',
      manifestSha256: digest
    }));
    expect(checkNewSystemSnapshotCoverage(catalog, snapshot).coverageMatches).toBe(true);
  });
  it('changes the catalog fingerprint for fields and the schema fingerprint for other DDL changes', () => {
    const { models, catalog } = fixture();
    const changed = models.map((model) => ({
      ...model,
      fields: [
        ...model.fields,
        { name: 'newField', kind: 'scalar', type: 'Decimal', isRequired: true, isList: false }
      ]
    }));
    expect(buildNewSystemBackupCatalog(changed, digest).catalogSha256).not.toBe(
      catalog.catalogSha256
    );
    expect(buildNewSystemBackupCatalog(models, 'b'.repeat(64)).schemaSha256).not.toBe(
      catalog.schemaSha256
    );
  });
});
