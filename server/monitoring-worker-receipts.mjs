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
    (value.verifiedAt === null || (timestamp(value.verifiedAt) && value.verifiedAt <= value.at));
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

export async function readBackupMonitorReceipt(directory) {
  const report = await readReceiptFile(join(directory, 'backup-status.json'),
    { uid: 0, gid: process.getgid(), mode: 0o640 });
  if (!report || !timestamp(report.at) || typeof report.mysqlTimerActive !== 'boolean' ||
      typeof report.mysqlAttemptFailed !== 'boolean' ||
      (report.drive !== null && !validWorkerReceipt(report.drive))) return null;
  const mysql = report.mysql;
  if (mysql !== null && (!timestamp(mysql?.capturedAt) || !timestamp(mysql.verifiedAt) ||
      mysql.capturedAt > mysql.verifiedAt)) return null;
  return report;
}

export function createWorkerReceipt(directory, name, dataDirectory, clock = Date.now) {
  if (!isAbsolute(directory || '') || !workers.has(name) || typeof dataDirectory !== 'string' ||
      resolve(directory) === resolve(dataDirectory))
    return async () => {};
  let current;
  return async ({ failures = 0, verified = false, integrityFailure = false } = {}) => {
    let temp;
    try {
      const at = clock();
      current ??= await readWorkerReceipt(directory, name);
      if (current && current.failures === failures && current.integrityFailure === integrityFailure &&
          !verified && at - current.at < 60_000) return;
      const root = await lstat(directory);
      if (!root.isDirectory() || root.uid !== process.getuid() || (root.mode & 0o777) !== 0o700 ||
          await realpath(directory) !== directory) return;
      const next = { at, failures, integrityFailure, verifiedAt: verified ? at : current?.verifiedAt ?? null };
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
