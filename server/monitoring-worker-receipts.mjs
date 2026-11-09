import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const workers = new Set(['backup', 'sheets']);
const receiptPath = (directory, name) => join(directory, 'monitoring-' + name + '.json');

export async function readWorkerReceipt(directory, name) {
  if (!directory || !workers.has(name)) return null;
  let handle;
  try {
    handle = await open(receiptPath(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = await handle.stat();
    if (!file.isFile() || file.nlink !== 1 || file.size > 1024 || file.uid !== process.getuid() ||
        (file.mode & 0o777) !== 0o600) return null;
    const value = JSON.parse(await handle.readFile('utf8'));
    if (Number.isSafeInteger(value.at) && value.at > 0 && Number.isSafeInteger(value.failures) && value.failures >= 0 &&
        typeof value.integrityFailure === 'boolean' &&
        (value.verifiedAt === null || (Number.isSafeInteger(value.verifiedAt) && value.verifiedAt > 0 &&
          value.verifiedAt <= value.at))) return value;
  } catch {} finally { await handle?.close().catch(() => {}); }
  return null;
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
