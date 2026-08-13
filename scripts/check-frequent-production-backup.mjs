#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  BACKUP_IDLE_TRANSACTION_TIMEOUT_MS,
  BACKUP_SESSION_TIMEOUT_MS,
  describeBackupTransactions,
  findStaleBackupTransactions,
  inspectProductionBackupTransactions
} from './lib/production-backup-transactions.mjs';
import { assertExpectedBackupDatabase, atomicWriteJson } from './lib/production-backup.mjs';
import {
  assertFrequentBackupHealthy,
  formatBytes,
  inspectFrequentBackups,
  resolveFrequentBackupDirectory,
  safeBackupError
} from './lib/frequent-production-backup.mjs';

const ALERT_REPEAT_MS = 60 * 60 * 1000;
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const runtimeDirectory = path.join(projectRoot, '.runtime');
const runnerStatusPath = path.join(runtimeDirectory, 'frequent-production-backup-status.json');
const monitorStatusPath = path.join(runtimeDirectory, 'frequent-production-backup-monitor.json');
const alertStatePath = path.join(runtimeDirectory, 'frequent-production-backup-alert.json');

process.umask(0o077);
await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });

try {
  const databaseUrl = await resolveBackupDatabaseUrl();
  const transactionInspection = await inspectProductionBackupTransactions(databaseUrl, {
    applicationName: 'id-v2-frequent-backup-monitor',
    includeCurrentSessionTimeout: true,
    includeRoleTimeouts: true
  });
  assertBackupTimeouts(transactionInspection);
  const staleTransactions = findStaleBackupTransactions(transactionInspection.transactions);
  if (staleTransactions.length > 0) {
    throw new Error(
      `发现专用备份角色遗留的空闲事务：${describeBackupTransactions(staleTransactions)}`
    );
  }

  const directory = await resolveFrequentBackupDirectory(projectRoot);
  const inventory = await inspectFrequentBackups(directory);
  const health = assertFrequentBackupHealthy(inventory);
  const runnerStatus = await readJsonIfPresent(runnerStatusPath);
  if (runnerStatus.ok === false) {
    throw new Error(`最近一次备份任务失败：${runnerStatus.error ?? '未知错误'}`);
  }
  const status = {
    version: 1,
    ok: true,
    checkedAt: new Date().toISOString(),
    latestBackupAt: health.latest.createdAt,
    latestArchive: health.latest.archive.name,
    ageMinutes: Number((health.ageMs / 60_000).toFixed(1)),
    activeBackupTransactionCount: transactionInspection.transactions.length,
    staleBackupTransactionCount: staleTransactions.length,
    backupIdleTransactionTimeoutMs: transactionInspection.currentSessionIdleTimeoutMs,
    backupRoleIdleTransactionTimeoutMs:
      transactionInspection.backupRoleTimeouts.idleInTransactionMs,
    backupRoleIdleSessionTimeoutMs: transactionInspection.backupRoleTimeouts.idleSessionMs,
    retainedBackupCount: inventory.backups.length,
    retainedBytes: inventory.totalBytes,
    retainedSize: formatBytes(inventory.totalBytes)
  };
  await Promise.all([
    atomicWriteJson(monitorStatusPath, status, 0o600),
    atomicWriteJson(
      alertStatePath,
      { version: 1, ok: true, lastHealthyAt: status.checkedAt },
      0o600
    )
  ]);
  console.log(JSON.stringify(status, null, 2));
} catch (error) {
  const message = safeBackupError(error);
  const checkedAt = new Date().toISOString();
  const alertState = await readJsonIfPresent(alertStatePath);
  const repeatedRecently =
    alertState.ok === false &&
    alertState.fingerprint === message &&
    Date.now() - Date.parse(alertState.lastAlertedAt) < ALERT_REPEAT_MS;
  if (!repeatedRecently) await showNotification(message);
  await Promise.all([
    atomicWriteJson(monitorStatusPath, { version: 1, ok: false, checkedAt, error: message }, 0o600),
    atomicWriteJson(
      alertStatePath,
      {
        version: 1,
        ok: false,
        fingerprint: message,
        lastAlertedAt: repeatedRecently ? alertState.lastAlertedAt : checkedAt
      },
      0o600
    )
  ]);
  console.error(`生产数据库备份告警：${message}`);
  process.exitCode = 1;
}

async function showNotification(message) {
  if (process.platform !== 'darwin') return;
  await new Promise((resolve) => {
    const child = spawn(
      'osascript',
      [
        '-e',
        'on run argv',
        '-e',
        'display notification (item 1 of argv) with title "ID业务管理系统备份告警"',
        '-e',
        'end run',
        message.slice(0, 220)
      ],
      { stdio: 'ignore' }
    );
    child.on('error', () => resolve());
    child.on('exit', () => resolve());
  });
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return {};
  }
}

async function resolveBackupDatabaseUrl() {
  if (process.env.BACKUP_DATABASE_URL) {
    return assertExpectedBackupDatabase(process.env.BACKUP_DATABASE_URL).toString();
  }
  const secretsPath = path.join(projectRoot, '.deploy', 'cloudflare-free.secrets.json');
  const secrets = JSON.parse(await readFile(secretsPath, 'utf8'));
  return assertExpectedBackupDatabase(secrets.BACKUP_DATABASE_URL).toString();
}

function assertBackupTimeouts(inspection) {
  const timeoutValues = [
    inspection.currentSessionIdleTimeoutMs,
    inspection.backupRoleTimeouts?.idleInTransactionMs
  ];
  if (timeoutValues.some((value) => value <= 0 || value > BACKUP_IDLE_TRANSACTION_TIMEOUT_MS)) {
    throw new Error('备份角色空闲事务超时不是预期的 2 分钟');
  }
  const roleIdleSessionMs = inspection.backupRoleTimeouts?.idleSessionMs;
  if (roleIdleSessionMs !== BACKUP_SESSION_TIMEOUT_MS) {
    throw new Error('备份角色空闲会话超时不是预期的 16 分钟');
  }
}
