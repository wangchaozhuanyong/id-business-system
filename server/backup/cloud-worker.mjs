import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm, rmdir, statfs } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { productionDataPaths } from '../production-data.mjs';
import { createRuntimeSnapshot } from './local-sqlite.mjs';
import { archiveDigest, sealSnapshot } from './cloud-archive.mjs';

const uuid = /^[a-f0-9-]{36}$/;
const digest = /^[a-f0-9]{64}$/;
const driveId = /^[A-Za-z0-9_-]{10,200}$/;

export async function privateBackupFile(path, limit) {
  if (!isAbsolute(path)) throw new Error('BACKUP_CONFIG_PATH_INVALID');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 ||
        info.mode & 0o077 || info.size > limit)
      throw new Error('BACKUP_CONFIG_FILE_INVALID');
    return handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function createCloudBackupWorker({
  dataDir, outbox, source, recipient, drive, guard = () => {}
}) {
  if (!uuid.test(source) || !isAbsolute(outbox) || resolve(dataDir) === resolve(outbox))
    throw new Error('BACKUP_WORKER_CONFIG_INVALID');
  const info = await lstat(outbox);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 ||
      await realpath(outbox) !== outbox)
    throw new Error('BACKUP_OUTBOX_INVALID');
  const { databasePath } = await productionDataPaths(dataDir);
  const original = await lstat(databasePath);
  if (!original.isFile()) throw new Error('BACKUP_DATABASE_REQUIRED');
  const db = new DatabaseSync(databasePath, { readOnly: true, timeout: 2000 });
  let seen, running = false;
  const statePath = join(outbox, 'checkpoint.json');
  const pathFor = (batch) => join(outbox, batch + '.idbackup');

  async function loadState() {
    try {
      const value = JSON.parse(await privateBackupFile(statePath, 8192));
      const pending = value?.pending;
      if (value?.source !== source ||
          (value.lastSha !== undefined && !digest.test(value.lastSha)) ||
          (pending && (!uuid.test(pending.batch) || !digest.test(pending.snapshotSha) ||
            (pending.capturedAt !== undefined && (!Number.isSafeInteger(pending.capturedAt) || pending.capturedAt <= 0)) ||
            (pending.remoteId !== undefined && !driveId.test(pending.remoteId)))))
        throw new Error('BACKUP_CHECKPOINT_INVALID');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { source };
      throw error;
    }
  }
  async function save(value) {
    guard();
    const part = join(outbox, '.' + randomUUID() + '.checkpoint');
    const handle = await open(part, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    guard();
    await rename(part, statePath);
    await syncDirectory(outbox);
  }
  async function ready(state) {
    const pending = state.pending;
    let blob;
    try {
      blob = await archiveDigest(pathFor(pending.batch));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (pending.remoteId) throw new Error('BACKUP_PENDING_FILE_MISSING');
      // No sealed archive was published. Recreate from the next consistent snapshot.
      await save({ source, lastSha: state.lastSha });
      return { captured: false };
    }
    if (pending.sha256 && (pending.sha256 !== blob.sha256 || pending.size !== blob.size))
      throw new Error('BACKUP_PENDING_DIGEST_MISMATCH');
    if (!pending.remoteId) {
      await drive.preflight();
      pending.remoteId = await drive.reserveId();
      Object.assign(pending, blob);
      await save(state);
    }
    guard();
    await drive.uploadBatch({ ...pending, ...blob, source }, pathFor(pending.batch));
    await save({ source, lastSha: pending.snapshotSha });
    await rm(pathFor(pending.batch));
    return { captured: true, capturedAt: pending.capturedAt, bytes: blob.size, sha256: blob.sha256 };
  }
  async function capture(state, revision) {
    const { bavail, bsize } = await statfs(outbox, { bigint: true });
    const sourceBytes = BigInt((await lstat(databasePath)).size);
    const walBytes = BigInt((await lstat(databasePath + '-wal').catch((error) => {
      if (error.code === 'ENOENT') return { size: 0 };
      throw error;
    })).size);
    if (bavail * bsize < (sourceBytes + walBytes) * 3n + 128n * 1024n * 1024n)
      throw new Error('BACKUP_OUTBOX_DISK_LOW');
    const batch = randomUUID();
    const snapshot = join(outbox, batch + '.snapshot');
    const archive = join(outbox, batch + '.partial');
    try {
      const manifest = await createRuntimeSnapshot({ dataDir, output: snapshot });
      if (manifest.sha256 === state.lastSha) {
        seen = revision;
        return { captured: false };
      }
      state.pending = { batch, snapshotSha: manifest.sha256, capturedAt: Date.parse(manifest.createdAt) };
      await save(state);
      await sealSnapshot({ input: snapshot, output: archive, recipient, source, batch });
      await rename(archive, pathFor(batch));
      await syncDirectory(outbox);
      seen = revision;
      return await ready(state);
    } finally {
      for (const path of [archive, join(snapshot, 'local-business.sqlite'), join(snapshot, 'manifest.json')])
        await rm(path, { force: true }).catch(() => {});
      await rmdir(snapshot).catch(() => {});
    }
  }
  return {
    async tick() {
      if (running) throw new Error('BACKUP_CAPTURE_BUSY');
      running = true;
      try {
        const current = await lstat(databasePath);
        guard();
        if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino)
          throw new Error('BACKUP_DATABASE_REPLACED');
        const state = await loadState();
        if (state.pending) return await ready(state);
        const revision = db.prepare('PRAGMA data_version').get().data_version;
        return revision === seen ? { captured: false } : await capture(state, revision);
      } finally {
        running = false;
      }
    },
    close() { db.close(); }
  };
}
