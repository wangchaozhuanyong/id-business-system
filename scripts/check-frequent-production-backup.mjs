#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson } from './lib/production-backup.mjs';
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
