import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const workers = new Set(['backup', 'sheets']);
const receiptPath = (directory, name) => join(directory, 'monitoring-' + name + '.json');
export const sheetsReceiptMaxAge = 15 * 60_000;
const timestamp = value => Number.isSafeInteger(value) && value > 0;

async function readReceiptFile(path, { uid, mode, gid }) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = await handle.stat();
    if (!file.isFile() || file.nlink !== 1 || file.size > 1024 || file.uid !== uid ||
        (gid !== undefined && file.gid !== gid) || (file.mode & 0o777) !== mode) return null;
    const raw = Buffer.alloc(1025);
    const { bytesRead } = await handle.read(raw, 0, raw.length, 0);
    if (bytesRead === file.size) return JSON.parse(raw.subarray(0, bytesRead).toString('utf8'));
  } catch {} finally { await handle?.close().catch(() => {}); }
  return null;
}

function validWorkerReceipt(value) {
  return value && timestamp(value.at) && Number.isSafeInteger(value.failures) && value.failures >= 0 &&
    typeof value.integrityFailure === 'boolean' &&
    (value.verifiedAt === null || (timestamp(value.verifiedAt) && value.verifiedAt <= value.at)) &&
    (value.capturedAt === undefined || (timestamp(value.capturedAt) && value.capturedAt <= value.verifiedAt));
}

export async function readWorkerReceipt(directory, name) {
  if (!directory || !workers.has(name)) return null;
  const value = await readReceiptFile(receiptPath(directory, name), { uid: process.getuid(), mode: 0o600 });
  return validWorkerReceipt(value) ? value : null;
}

export async function readSheetsMonitorReceipt(directory) {
  if (!directory) return null;
  const value = await readReceiptFile(join(directory, 'sheets-status.json'),
    { uid: 0, gid: process.getgid(), mode: 0o640 });
  return validWorkerReceipt(value) ? value : null;
}

export async function readSheetsSyncStatus({
  workerDirectory, collectorDirectory, now, startedAt = now,
  readWorker = readWorkerReceipt, readCollector = readSheetsMonitorReceipt
}) {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => workerDirectory && readWorker(workerDirectory, 'sheets')),
    Promise.resolve().then(() => collectorDirectory && readCollector(collectorDirectory))
  ]);
  const receipts = results.filter(result => result.status === 'fulfilled' && validWorkerReceipt(result.value))
    .map(result => result.value).sort((a, b) => b.at - a.at);
  const receipt = receipts.find(item => item.at <= now + 60_000);
  if (!receipt) return {
    state: workerDirectory || collectorDirectory
      ? now - startedAt > sheetsReceiptMaxAge ? 'stale' : 'no_receipt'
      : 'unconfigured',
    reportedAt: null, verifiedAt: null, failures: null, reason: receipts.length ? 'receipt_future' :
      workerDirectory || collectorDirectory ? 'receipt_missing' : 'receipt_disabled'
  };
  const { at: reportedAt, verifiedAt, failures, integrityFailure } = receipt;
  if (now - reportedAt > sheetsReceiptMaxAge)
    return { state: 'stale', reportedAt, verifiedAt, failures, reason: 'receipt_stale' };
  if (integrityFailure || failures >= 3)
    return { state: 'failed', reportedAt, verifiedAt, failures, reason: integrityFailure ? 'integrity_failed' : undefined };
  if (now - (verifiedAt ?? startedAt) > sheetsReceiptMaxAge)
    return { state: 'stale', reportedAt, verifiedAt, failures, reason: verifiedAt ? 'verification_stale' : 'verification_missing' };
  if (failures > 0) return { state: 'retrying', reportedAt, verifiedAt, failures, reason: 'recovering' };
  return verifiedAt
    ? { state: 'healthy', reportedAt, verifiedAt, failures }
    : { state: 'waiting', reportedAt, verifiedAt, failures, reason: 'verification_missing' };
}

export async function readBackupMonitorReceipt(directory) {
  if (!isAbsolute(directory || '')) return null;
  const report = await readReceiptFile(join(directory, 'backup-status.json'),
    { uid: 0, gid: process.getgid(), mode: 0o640 });
  if (!report || !timestamp(report.at) || typeof report.mysqlTimerActive !== 'boolean' ||
      typeof report.mysqlAttemptFailed !== 'boolean' ||
      (report.drive !== null && !validWorkerReceipt(report.drive))) return null;
  const mysql = report.mysql;
  if (mysql !== null && (!timestamp(mysql?.capturedAt) || !timestamp(mysql.verifiedAt) ||
      mysql.capturedAt > mysql.verifiedAt || (mysql.recoveryStatus !== undefined &&
        !['verified', 'capture_failed', 'missing'].includes(mysql.recoveryStatus)))) return null;
  return report;
}

export async function readRestoreEvidence(directory) {
  if (!isAbsolute(directory || '')) return {};
  const results = await Promise.all(['business', 'recharge'].map(async key => [key, await readReceiptFile(
    join(directory, 'restore-' + key + '.json'), { uid: 0, gid: process.getgid(), mode: 0o640 })]));
  return Object.fromEntries(results);
}

export function createWorkerReceipt(directory, name, dataDirectory, clock = Date.now) {
  if (!isAbsolute(directory || '') || !workers.has(name) || typeof dataDirectory !== 'string' ||
      resolve(directory) === resolve(dataDirectory))
    return async () => {};
  let current;
  return async ({ failures = 0, verified = false, integrityFailure = false, capturedAt } = {}) => {
    let temp;
    try {
      const at = clock();
      current ??= await readWorkerReceipt(directory, name);
      if (current && current.failures === failures && current.integrityFailure === integrityFailure &&
          !verified && at - current.at < 60_000) return;
      const root = await lstat(directory);
      if (!root.isDirectory() || root.uid !== process.getuid() || (root.mode & 0o777) !== 0o700 ||
          await realpath(directory) !== directory) return;
      const capture = verified ? capturedAt : current?.capturedAt;
      const next = { at, failures, integrityFailure, verifiedAt: verified ? at : current?.verifiedAt ?? null };
      if (name === 'backup' && timestamp(capture) && capture <= next.verifiedAt) next.capturedAt = capture;
      temp = join(directory, '.monitoring-' + randomUUID());
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(next)); } finally { await file.close(); }
      await rename(temp, receiptPath(directory, name));
      current = next;
    } catch {
      // Reporting is auxiliary to the verified backup or sync result.
      if (temp) await unlink(temp).catch(() => {});
    }
  };
}
