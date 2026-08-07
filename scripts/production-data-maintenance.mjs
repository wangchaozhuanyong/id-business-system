import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';
import { normalizeDatabaseConnection } from './lib/production-closure-audit.mjs';
import {
  assertApplyTargetSupported,
  assertExpectedProductionMaintenanceDatabase,
  assertPreviewAuthorization,
  assertProductionCutoverAuthorization,
  assertTargetMatchesDatabase,
  captureMaintenanceSnapshot,
  clearIsolatedBusinessData,
  clearProductionCutoverData,
  countProductionCutoverRows,
  createOperationId,
  createSnapshotFingerprint,
  sha256File
} from './lib/production-data-maintenance.mjs';

const [command = 'preview', ...rawArgs] = process.argv.slice(2);
const args = parseArgs(rawArgs);
const target = args.target;
const databaseUrlEnv = args['database-url-env'] ?? 'MAINTENANCE_DATABASE_URL';
const databaseUrl = process.env[databaseUrlEnv];

if (!target) throw new Error('缺少 --target=isolated 或 --target=production');
if (!databaseUrl) throw new Error(`环境变量 ${databaseUrlEnv} 未配置`);
const classification = assertTargetMatchesDatabase(target, databaseUrl);
const connection = normalizeDatabaseConnection(databaseUrl);

if (command === 'preview') {
  if (!args.out) throw new Error('preview 必须提供 --out');
  const client = new pg.Client({
    ...connection,
    application_name: `id_business_recovery_preview_${target}`,
    statement_timeout: 30_000,
    query_timeout: 30_000
  });
  await client.connect();
  try {
    await client.query('begin read only');
    const snapshot = await captureMaintenanceSnapshot(client, classification.database);
    await client.query('rollback');
    const generatedAt = new Date();
    const snapshotFingerprint = createSnapshotFingerprint(snapshot);
    const report = {
      schemaVersion: 1,
      generatedAt: generatedAt.toISOString(),
      expiresAt: new Date(generatedAt.getTime() + 60 * 60 * 1000).toISOString(),
      target,
      operationId: createOperationId(snapshotFingerprint, generatedAt.toISOString()),
      snapshotFingerprint,
      snapshot,
      sensitiveDataIncluded: false,
      executionAllowed: target === 'isolated',
      productionGuard:
        target === 'production'
          ? 'cutover-apply-requires-verified-backup-and-irrevocable-confirmation'
          : 'local-isolated-database-only'
    };
    await writeJson(args.out, report);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
} else if (command === 'apply') {
  assertApplyTargetSupported(target);
  for (const name of ['preview-file', 'backup-file', 'backup-sha256', 'confirm', 'out']) {
    if (!args[name]) throw new Error(`apply 必须提供 --${name}`);
  }
  const preview = JSON.parse(await readFile(path.resolve(args['preview-file']), 'utf8'));
  const actualBackupSha256 = await sha256File(path.resolve(args['backup-file']));
  if (actualBackupSha256 !== args['backup-sha256'].toLowerCase()) {
    throw new Error('备份文件实际 SHA256 与参数不一致');
  }
  const client = new pg.Client({
    ...connection,
    application_name: 'id_business_isolated_reconstruction_apply',
    statement_timeout: 60_000,
    query_timeout: 60_000
  });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(`set local lock_timeout = '5s'`);
    const before = await captureMaintenanceSnapshot(client, classification.database);
    const beforeFingerprint = createSnapshotFingerprint(before);
    assertPreviewAuthorization({
      preview,
      target,
      confirmOperationId: args.confirm,
      backupSha256: actualBackupSha256,
      currentFingerprint: beforeFingerprint
    });
    await clearIsolatedBusinessData(client, {
      auditId: randomUUID(),
      operationId: preview.operationId,
      beforeFingerprint,
      backupSha256: actualBackupSha256,
      beforeCounts: Object.fromEntries(
        Object.entries(before.businessTables).map(([table, state]) => [table, state.count])
      )
    });
    const after = await captureMaintenanceSnapshot(client, classification.database);
    const remainingBusinessRows = Object.values(after.businessTables).reduce(
      (sum, state) => sum + state.count,
      0
    );
    if (remainingBusinessRows !== 0) {
      throw new Error(`隔离清理后仍存在 ${remainingBusinessRows} 条业务记录`);
    }
    await client.query('commit');
    const report = {
      schemaVersion: 1,
      appliedAt: new Date().toISOString(),
      target,
      operationId: preview.operationId,
      backupFile: args['backup-file'],
      backupSha256: actualBackupSha256,
      beforeFingerprint,
      afterFingerprint: createSnapshotFingerprint(after),
      before: before.businessTables,
      after: after.businessTables,
      preservedTables: after.preservedTables,
      sensitiveDataIncluded: false,
      productionDatabaseChanged: false
    };
    await writeJson(args.out, report);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
} else if (command === 'cutover-drill') {
  if (target !== 'isolated') throw new Error('cutover-drill 只允许 --target=isolated');
  for (const name of ['preview-file', 'backup-file', 'backup-sha256', 'confirm', 'out']) {
    if (!args[name]) throw new Error(`cutover-drill 必须提供 --${name}`);
  }
  const preview = JSON.parse(await readFile(path.resolve(args['preview-file']), 'utf8'));
  const actualBackupSha256 = await sha256File(path.resolve(args['backup-file']));
  if (actualBackupSha256 !== args['backup-sha256'].toLowerCase()) {
    throw new Error('备份文件实际 SHA256 与参数不一致');
  }
  const client = new pg.Client({
    ...connection,
    application_name: 'id_business_cutover_drill_cleanup',
    statement_timeout: 90_000,
    query_timeout: 90_000
  });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(`set local lock_timeout = '5s'`);
    const before = await captureMaintenanceSnapshot(client, classification.database);
    const beforeFingerprint = createSnapshotFingerprint(before);
    assertPreviewAuthorization({
      preview,
      target,
      confirmOperationId: args.confirm,
      backupSha256: actualBackupSha256,
      currentFingerprint: beforeFingerprint
    });
    const cleanup = await clearProductionCutoverData(client, {
      auditId: randomUUID(),
      operationId: preview.operationId,
      beforeFingerprint,
      backupSha256: actualBackupSha256,
      beforeCounts: Object.fromEntries(
        Object.entries(before.businessTables).map(([table, state]) => [table, state.count])
      ),
      preservedTables: Object.keys(before.preservedTables)
    });
    const after = await captureMaintenanceSnapshot(client, classification.database);
    const remainingBusinessRows = Object.values(after.businessTables).reduce(
      (sum, state) => sum + state.count,
      0
    );
    if (remainingBusinessRows !== 0) {
      throw new Error(`隔离演练清理后仍存在 ${remainingBusinessRows} 条业务记录`);
    }
    const afterCutoverRows = await countProductionCutoverRows(client);
    const unexpectedRows = Object.entries(afterCutoverRows).filter(([table, count]) => {
      if (table === 'audit_logs') return count !== 1;
      return count !== 0;
    });
    if (unexpectedRows.length > 0) {
      throw new Error(
        `隔离演练清理后仍存在未清理数据：${unexpectedRows
          .map(([table, count]) => `${table}=${count}`)
          .join(', ')}`
      );
    }
    await client.query('commit');
    const report = {
      schemaVersion: 1,
      appliedAt: new Date().toISOString(),
      target,
      operationId: preview.operationId,
      backupFile: args['backup-file'],
      backupSha256: actualBackupSha256,
      beforeFingerprint,
      afterFingerprint: createSnapshotFingerprint(after),
      before: before.businessTables,
      beforeExtraTables: cleanup.beforeExtraCounts,
      optionalTables: cleanup.optionalTables,
      after: after.businessTables,
      afterCutoverRows,
      preservedTables: after.preservedTables,
      sensitiveDataIncluded: false,
      productionDatabaseChanged: false
    };
    await writeJson(args.out, report);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
} else if (command === 'cutover-apply') {
  if (target !== 'production') throw new Error('cutover-apply 只允许 --target=production');
  assertExpectedProductionMaintenanceDatabase(databaseUrl);
  for (const name of [
    'preview-file',
    'backup-file',
    'backup-sha256',
    'confirm',
    'production-confirm',
    'out'
  ]) {
    if (!args[name]) throw new Error(`cutover-apply 必须提供 --${name}`);
  }
  const preview = JSON.parse(await readFile(path.resolve(args['preview-file']), 'utf8'));
  const actualBackupSha256 = await sha256File(path.resolve(args['backup-file']));
  if (actualBackupSha256 !== args['backup-sha256'].toLowerCase()) {
    throw new Error('备份文件实际 SHA256 与参数不一致');
  }
  const client = new pg.Client({
    ...connection,
    application_name: 'id_business_production_cutover_cleanup',
    statement_timeout: 90_000,
    query_timeout: 90_000
  });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(`set local lock_timeout = '5s'`);
    const before = await captureMaintenanceSnapshot(client, classification.database);
    const beforeFingerprint = createSnapshotFingerprint(before);
    assertProductionCutoverAuthorization({
      preview,
      target,
      confirmOperationId: args.confirm,
      productionConfirmation: args['production-confirm'],
      backupSha256: actualBackupSha256,
      currentFingerprint: beforeFingerprint
    });
    const cleanup = await clearProductionCutoverData(client, {
      auditId: randomUUID(),
      operationId: preview.operationId,
      beforeFingerprint,
      backupSha256: actualBackupSha256,
      beforeCounts: Object.fromEntries(
        Object.entries(before.businessTables).map(([table, state]) => [table, state.count])
      ),
      preservedTables: Object.keys(before.preservedTables)
    });
    const after = await captureMaintenanceSnapshot(client, classification.database);
    const remainingBusinessRows = Object.values(after.businessTables).reduce(
      (sum, state) => sum + state.count,
      0
    );
    if (remainingBusinessRows !== 0) {
      throw new Error(`生产清理后仍存在 ${remainingBusinessRows} 条业务记录`);
    }
    const afterCutoverRows = await countProductionCutoverRows(client);
    const unexpectedRows = Object.entries(afterCutoverRows).filter(([table, count]) => {
      if (table === 'audit_logs') return count !== 1;
      return count !== 0;
    });
    if (unexpectedRows.length > 0) {
      throw new Error(
        `生产清理后仍存在未清理数据：${unexpectedRows
          .map(([table, count]) => `${table}=${count}`)
          .join(', ')}`
      );
    }
    await client.query('commit');
    const report = {
      schemaVersion: 1,
      appliedAt: new Date().toISOString(),
      target,
      operationId: preview.operationId,
      backupFile: args['backup-file'],
      backupSha256: actualBackupSha256,
      beforeFingerprint,
      afterFingerprint: createSnapshotFingerprint(after),
      before: before.businessTables,
      beforeExtraTables: cleanup.beforeExtraCounts,
      optionalTables: cleanup.optionalTables,
      after: after.businessTables,
      afterCutoverRows,
      preservedTables: after.preservedTables,
      sensitiveDataIncluded: false,
      productionDatabaseChanged: true
    };
    await writeJson(args.out, report);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
} else {
  throw new Error('命令必须是 preview、apply、cutover-drill 或 cutover-apply');
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) throw new Error(`无法识别参数：${value}`);
    const [rawKey, inlineValue] = value.slice(2).split('=', 2);
    const nextValue = inlineValue ?? values[index + 1];
    if (!nextValue || nextValue.startsWith('--')) throw new Error(`参数 --${rawKey} 缺少值`);
    parsed[rawKey] = nextValue;
    if (inlineValue === undefined) index += 1;
  }
  return parsed;
}

async function writeJson(filePath, value) {
  const resolved = path.resolve(filePath);
  await writeFile(resolved, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
