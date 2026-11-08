import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const digestPattern = /^[0-9a-f]{64}$/;
const maxSessions = 1024;

function privateOwnedFile(stat) {
  return (stat.mode & 0o077) === 0 &&
    (typeof process.getuid !== 'function' || stat.uid === process.getuid());
}

export function openLocalSessionStore(directory) {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || !privateOwnedFile(stat))
    throw new Error('登录会话目录或权限不正确');

  function get(digest) {
    if (!digestPattern.test(digest)) return undefined;
    let fd;
    try {
      fd = openSync(join(directory, digest), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const file = fstatSync(fd);
      if (!file.isFile() || file.nlink !== 1 || file.size > 2048 || !privateOwnedFile(file))
        return undefined;
      const row = JSON.parse(readFileSync(fd, 'utf8'));
      if (typeof row?.employeeId !== 'string' || !Number.isSafeInteger(row.version) ||
          row.version < 1 || !Number.isSafeInteger(row.expiresAt)) return undefined;
      if (row.id !== undefined && (!/^[0-9a-f-]{36}$/.test(row.id) || typeof row.remembered !== 'boolean' ||
          !Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.lastUsedAt) ||
          !Number.isSafeInteger(row.absoluteExpiresAt) || row.createdAt > row.lastUsedAt ||
          row.lastUsedAt > row.expiresAt || row.expiresAt > row.absoluteExpiresAt ||
          typeof row.device !== 'string' || row.device.length > 80)) return undefined;
      return row;
    } catch (error) {
      // A missing volume/directory is an outage, not an expired login.
      if (error.code === 'ENOENT') lstatSync(directory);
      if (error.code !== 'ENOENT' && error.code !== 'ELOOP' && !(error instanceof SyntaxError)) throw error;
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  function remove(digest) {
    if (!digestPattern.test(digest)) return;
    try {
      unlinkSync(join(directory, digest));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  return {
    get,
    *entries() {
      for (const digest of readdirSync(directory).filter(name => digestPattern.test(name))) {
        const row = get(digest);
        if (row) yield [digest, row];
      }
    },
    delete: remove,
    // Synchronous read/check/replace cannot interleave with logout in this process.
    // Never recreate a removed session or follow an existing link.
    update(digest, change) {
      const current = get(digest);
      if (!current) return undefined;
      const next = change(current);
      if (!next) return undefined;
      const temporary = join(directory, '.session-' + randomUUID());
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(next));
        fsyncSync(fd);
        renameSync(temporary, join(directory, digest));
      } finally {
        closeSync(fd);
        try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return next;
    },
    set(digest, row) {
      if (!digestPattern.test(digest)) throw new Error('登录会话标识不正确');
      const fd = openSync(join(directory, digest), 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(row));
        fsyncSync(fd);
      } catch (error) {
        remove(digest);
        throw error;
      } finally {
        closeSync(fd);
      }
    },
    prune(now) {
      const active = [];
      for (const digest of readdirSync(directory).filter((name) => digestPattern.test(name))) {
        const row = get(digest);
        if (row?.expiresAt > now) active.push({ digest, expiresAt: row.expiresAt });
        else if (row) remove(digest);
      }
      active.sort((a, b) => a.expiresAt - b.expiresAt);
      for (const { digest } of active.slice(0, Math.max(0, active.length - maxSessions + 1)))
        remove(digest);
    }
  };
}
