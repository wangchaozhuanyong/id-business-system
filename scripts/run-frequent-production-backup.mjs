#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { EXPECTED_BACKUP_PROJECT_REF, atomicWriteJson } from './lib/production-backup.mjs';
import {
  FREQUENT_BACKUP_LABEL,
  assertEnoughFreeDisk,
  pruneFrequentBackups,
  resolveFrequentBackupDirectory,
  safeBackupError
} from './lib/frequent-production-backup.mjs';
import { resolveNativePostgresClient } from './lib/native-postgres-client.mjs';

const BACKUP_RUNNER_TIMEOUT_MS = 17 * 60 * 1000;
const STALE_LOCK_MS = 20 * 60 * 1000;
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const runtimeDirectory = path.join(projectRoot, '.runtime');
const statusPath = path.join(runtimeDirectory, 'frequent-production-backup-status.json');
const backupScriptPath = path.join(projectRoot, 'scripts', 'backup-production-database.mjs');
const publicKeyPath = path.join(projectRoot, 'deploy', 'backup-recovery-public.pem');
const startedAtMs = Date.now();

process.umask(0o077);
await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
const previousStatus = await readJsonIfPresent(statusPath);

try {
  const backupDirectory = await resolveFrequentBackupDirectory(projectRoot);
  await recoverStaleBackupLock(backupDirectory);
  await pruneFrequentBackups(backupDirectory);
  const availableBytes = await assertEnoughFreeDisk(backupDirectory);
  const nativePostgresClient = await resolveNativePostgresClient();
  const result = await runBackup(nativePostgresClient.directory);
  validateBackupResult(result, backupDirectory);
  const inventory = await pruneFrequentBackups(backupDirectory);
  const completed = inventory.backups.find(
    (backup) => backup.archive.path === path.resolve(result.archive)
  );
  if (!completed) throw new Error('新生成的加密备份未进入受管保留集合');

  const status = {
    version: 1,
    ok: true,
    lastAttemptAt: new Date(startedAtMs).toISOString(),
    lastSuccessAt: completed.createdAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAtMs,
    executor: result.executor,
    pgDumpVersion: result.pgDumpVersion,
    archive: completed.archive.name,
    dumpSizeBytes: result.dumpSizeBytes,
    archiveSizeBytes: completed.archive.sizeBytes,
    retainedBackupCount: inventory.backups.length,
    retainedBytes: inventory.totalBytes,
    availableDiskBytes: Number(availableBytes),
    deletedBackupCount: inventory.deletedBackupCount,
    deletedStaleFileCount: inventory.deletedStaleFileCount
  };
  await atomicWriteJson(statusPath, status, 0o600);
  console.log(JSON.stringify(status, null, 2));
} catch (error) {
  const status = {
    version: 1,
    ok: false,
    lastAttemptAt: new Date(startedAtMs).toISOString(),
    lastSuccessAt: previousStatus.lastSuccessAt ?? null,
    failedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAtMs,
    error: safeBackupError(error)
  };
  await atomicWriteJson(statusPath, status, 0o600).catch(() => undefined);
  console.error(JSON.stringify(status, null, 2));
  process.exitCode = 1;
}

async function runBackup(postgresBinDirectory) {
  const confirmation = `BACKUP_${EXPECTED_BACKUP_PROJECT_REF}_${FREQUENT_BACKUP_LABEL}`;
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        backupScriptPath,
        `--label=${FREQUENT_BACKUP_LABEL}`,
        `--confirmation=${confirmation}`,
        `--public-key=${publicKeyPath}`,
        '--executor=native',
        `--postgres-bin-dir=${postgresBinDirectory}`,
        '--ephemeral-plaintext'
      ],
      {
        cwd: projectRoot,
        env: process.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout = boundedAppend(stdout, chunk, 32_000)));
    child.stderr.on('data', (chunk) => (stderr = boundedAppend(stderr, chunk, 32_000)));
    const timer = setTimeout(() => terminateProcessGroup(child), BACKUP_RUNNER_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal) {
        reject(
          new Error(
            `15分钟备份执行失败（退出码 ${code ?? 'unknown'}）：${stderr.trim().slice(-1000)}`
          )
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error('15分钟备份未返回有效结果'));
      }
    });
  });
}

function validateBackupResult(result, backupDirectory) {
  if (result?.ok !== true || !result.archive || !result.receipt) {
    throw new Error('15分钟备份结果缺少加密文件或校验凭据');
  }
  const archivePath = path.resolve(result.archive);
  const receiptPath = path.resolve(result.receipt);
  const expectedPrefix = `${FREQUENT_BACKUP_LABEL}-`;
  if (
    path.dirname(archivePath) !== backupDirectory ||
    path.dirname(receiptPath) !== backupDirectory ||
    !path.basename(archivePath).startsWith(expectedPrefix) ||
    !path.basename(receiptPath).startsWith(expectedPrefix) ||
    !path.basename(archivePath).endsWith('.backup.enc') ||
    !path.basename(receiptPath).endsWith('.receipt.json')
  ) {
    throw new Error('15分钟备份结果越过受管目录或文件名前缀');
  }
}

async function recoverStaleBackupLock(backupDirectory) {
  const lockPath = path.join(backupDirectory, '.production-backup.lock');
  let metadata;
  try {
    metadata = await lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('生产备份锁不是普通文件，拒绝自动处理');
  }
  if (Date.now() - metadata.mtimeMs < STALE_LOCK_MS) return;

  let lock = {};
  try {
    lock = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    // 旧锁内容无效时，仍只按文件年龄和进程存活状态处理。
  }
  if (Number.isInteger(lock.pid) && isProcessAlive(lock.pid)) return;
  await unlink(lockPath);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function terminateProcessGroup(child) {
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

function boundedAppend(current, chunk, maximumLength) {
  const combined = current + String(chunk);
  return combined.length <= maximumLength ? combined : combined.slice(-maximumLength);
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    return {};
  }
}
