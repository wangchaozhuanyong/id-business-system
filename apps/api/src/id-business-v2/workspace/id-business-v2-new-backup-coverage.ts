import { createHash } from 'node:crypto';

export const NEW_SYSTEM_BACKUP_PROFILE = 'id-business-new-system-v1';
export const NEW_SYSTEM_REQUIRED_MODELS = {
  mailboxes: [
    'IdBusinessV2GoogleMailbox',
    'IdBusinessV2ManagedMailbox',
    'IdBusinessV2ManagedMailboxSetting',
    'IdBusinessV2MailboxEvent'
  ],
  accounts: [
    'IdBusinessV2Account',
    'IdBusinessV2ChatgptAccount',
    'IdBusinessV2ClaudeAccount',
    'IdBusinessV2ClaudeInventoryPolicy',
    'IdBusinessV2GiftCard',
    'IdBusinessV2BalanceLedger',
    'IdBusinessV2AccountLoss'
  ],
  orders: [
    'IdBusinessV2SubscriptionOrder',
    'IdBusinessV2SubscriptionRefund',
    'IdBusinessV2SubscriptionFeeRule',
    'IdBusinessV2SubscriptionCardOpeningClaim',
    'IdBusinessV2Order',
    'IdBusinessV2Activation'
  ],
  customers: ['IdBusinessV2Customer', 'IdBusinessV2CustomerTag', 'IdBusinessV2CustomerService'],
  inventoryHistory: [
    'IdBusinessV2InventoryOption',
    'IdBusinessV2InventoryEntry',
    'IdBusinessV2ExtractionBatch',
    'IdBusinessV2ExtractionItem',
    'IdBusinessV2InventoryEvent',
    'IdBusinessV2InventoryCommandReceipt',
    'IdBusinessV2InventoryImportBatch'
  ],
  attachments: ['Attachment']
} as const;

interface BackupModelMetadata {
  name: string;
  dbName?: string | null;
  fields: readonly {
    name: string;
    dbName?: string | null;
    kind: string;
    type: string;
    isRequired: boolean;
    isList: boolean;
  }[];
}

export interface NewSystemBackupCatalog {
  coverageScope: 'application-models';
  profile: typeof NEW_SYSTEM_BACKUP_PROFILE;
  schemaSha256: string;
  catalogSha256: string;
  tables: {
    model: string;
    name: string;
    modules: string[];
    columns: { name: string; field: string; type: string; required: boolean; list: boolean }[];
  }[];
  requiredFileSources: readonly ['attachments', 'apple-relay-vendure'];
}

/** Schema metadata only. Never queries rows, decrypts fields, or imports legacy configuration. */
export function buildNewSystemBackupCatalog(
  models: readonly BackupModelMetadata[],
  schemaSha256: string
): NewSystemBackupCatalog {
  if (!/^[a-f0-9]{64}$/.test(schemaSha256)) throw new Error('新版备份 schema 摘要无效');
  const names = new Set(models.map((model) => model.name));
  const missing = Object.values(NEW_SYSTEM_REQUIRED_MODELS)
    .flat()
    .filter((name) => !names.has(name));
  if (missing.length) throw new Error(`新版备份模型缺失：${missing.join('、')}`);
  const tables = models
    .map((model) => ({
      model: model.name,
      name: model.dbName || model.name,
      modules: Object.entries(NEW_SYSTEM_REQUIRED_MODELS)
        .filter(([, members]) => (members as readonly string[]).includes(model.name))
        .map(([name]) => name),
      // Relation properties are virtual; their scalar foreign-key columns are included here.
      columns: model.fields
        .filter((field) => field.kind !== 'object')
        .map((field) => ({
          name: field.dbName || field.name,
          field: field.name,
          type: field.type,
          required: field.isRequired,
          list: field.isList
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (new Set(tables.map((table) => table.name)).size !== tables.length)
    throw new Error('新版备份表名重复');
  return {
    coverageScope: 'application-models',
    profile: NEW_SYSTEM_BACKUP_PROFILE,
    schemaSha256,
    catalogSha256: createHash('sha256').update(JSON.stringify(tables)).digest('hex'),
    tables,
    requiredFileSources: ['attachments', 'apple-relay-vendure']
  };
}

export interface NewSystemSnapshotCoverage {
  profile: string;
  schemaSha256: string;
  catalogSha256: string;
  tables: { name: string; rowCount: string; columns: string[] }[];
  fileSources: {
    name: string;
    state: 'verified' | 'empty' | 'pending';
    count: string;
    manifestSha256?: string;
  }[];
}

/** Only validates declared coverage. Upload, encryption and restore require separate receipts. */
export function checkNewSystemSnapshotCoverage(
  catalog: NewSystemBackupCatalog,
  snapshot: NewSystemSnapshotCoverage
) {
  const issues: string[] = [];
  if (snapshot.profile !== NEW_SYSTEM_BACKUP_PROFILE) issues.push('备份来源不是新版系统');
  if (
    snapshot.schemaSha256 !== catalog.schemaSha256 ||
    snapshot.catalogSha256 !== catalog.catalogSha256
  )
    issues.push('备份结构与当前新版不一致');
  const integer = /^(0|[1-9][0-9]*)$/;
  const byName = new Map(snapshot.tables.map((table) => [table.name, table]));
  if (byName.size !== snapshot.tables.length) issues.push('备份表清单重复');
  const expected = new Set(catalog.tables.map((table) => table.name));
  for (const table of snapshot.tables)
    if (!expected.has(table.name)) issues.push(`非当前新版表：${table.name}`);
  for (const table of catalog.tables) {
    const actual = byName.get(table.name);
    if (!actual) {
      issues.push(`缺少表：${table.name}`);
      continue;
    }
    if (!integer.test(actual.rowCount)) issues.push(`行数无效：${table.name}`);
    const columns = new Set(actual.columns);
    if (columns.size !== actual.columns.length) issues.push(`字段重复：${table.name}`);
    const expectedColumns = new Set(table.columns.map((column) => column.name));
    for (const name of expectedColumns)
      if (!columns.has(name)) issues.push(`缺少字段：${table.name}.${name}`);
    for (const name of columns)
      if (!expectedColumns.has(name)) issues.push(`未知字段：${table.name}.${name}`);
  }
  const files = new Map(snapshot.fileSources.map((source) => [source.name, source]));
  if (files.size !== snapshot.fileSources.length) issues.push('文件来源清单重复');
  for (const name of catalog.requiredFileSources) {
    const source = files.get(name);
    if (!source || source.state === 'pending') {
      issues.push(`文件来源未覆盖：${name}`);
      continue;
    }
    if (!['verified', 'empty', 'pending'].includes(source.state))
      issues.push(`文件来源状态无效：${name}`);
    if (!integer.test(source.count)) issues.push(`文件数量无效：${name}`);
    if (source.state === 'empty' && source.count !== '0') issues.push(`空来源数量不为零：${name}`);
    if (source.state === 'verified' && !/^[a-f0-9]{64}$/.test(source.manifestSha256 || ''))
      issues.push(`文件清单摘要缺失：${name}`);
    // Attachment metadata alone is insufficient when the database contains actual attachments.
    if (name === 'attachments' && source.state === 'empty') {
      const attachmentModel = catalog.tables.find((table) => table.model === 'Attachment');
      if (attachmentModel && byName.get(attachmentModel.name)?.rowCount !== '0')
        issues.push('附件记录存在但原始文件未覆盖');
    }
  }
  return { coverageMatches: issues.length === 0, issues };
}
