import { createHmac, timingSafeEqual } from 'node:crypto';
import { closeSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const runtimeRoot = fileURLToPath(new URL('../../../.runtime', import.meta.url));
export const isolatedRechargeFilename = 'vendure-recharge-isolated.sqlite';

export function openIsolatedRechargeStore({ file, storageKey }) {
  if (!Buffer.isBuffer(storageKey) || storageKey.length !== 32)
    throw new TypeError('隔离任务存储需要单独的 32 字节密钥');
  const path = resolve(file);
  const directory = dirname(path);
  if (
    basename(path) !== isolatedRechargeFilename ||
    !directory.startsWith(runtimeRoot + sep) ||
    realpathSync(directory) !== directory
  )
    throw new TypeError('任务库须放在本项目 .runtime 的专用子目录');

  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() ||
      (stat.mode & 0o077) !== 0) throw new Error('隔离任务库文件或权限无效');

  const db = new DatabaseSync(path);
  const key = Buffer.from(storageKey);
  const fingerprint = (purpose, value) =>
    createHmac('sha256', key).update(purpose).update('\0').update(value).digest('hex');
  const integrity = (revision, payload) =>
    fingerprint('snapshot', JSON.stringify([revision, payload]));

  try {
    db.exec(`
      PRAGMA busy_timeout = 1000;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS vendure_recharge_isolated_state (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        revision INTEGER NOT NULL,
        payload TEXT NOT NULL,
        integrity TEXT NOT NULL
      ) STRICT;
    `);
    const empty = JSON.stringify({ tasks: [], nonces: [] });
    db.prepare('INSERT OR IGNORE INTO vendure_recharge_isolated_state VALUES (1, 0, ?, ?)').run(
      empty,
      integrity(0, empty)
    );
    const read = db.prepare(
      'SELECT revision, payload, integrity FROM vendure_recharge_isolated_state WHERE id = 1'
    );
    const write = db.prepare(
      'UPDATE vendure_recharge_isolated_state SET revision = ?, payload = ?, integrity = ? WHERE id = 1 AND revision = ?'
    );
    function load() {
      const row = read.get();
      if (
        !row ||
        !Number.isSafeInteger(row.revision) ||
        !/^[a-f0-9]{64}$/.test(row.integrity) ||
        !timingSafeEqual(
          Buffer.from(row.integrity, 'hex'),
          Buffer.from(integrity(row.revision, row.payload), 'hex')
        )
      ) {
        throw new Error('隔离任务库校验失败，请核对原存储与密钥');
      }
      const state = JSON.parse(row.payload);
      if (!Array.isArray(state?.tasks) || !Array.isArray(state.nonces))
        throw new Error('隔离任务库结构无效');
      return { revision: row.revision, state };
    }
    load();

    return {
      fingerprint,
      load,
      commit(expectedRevision, state) {
        const revision = expectedRevision + 1;
        const payload = JSON.stringify(state);
        // One SQLite statement commits the reservation, lease or result and its nonce together.
        const result = write.run(revision, payload, integrity(revision, payload), expectedRevision);
        if (result.changes !== 1) throw new Error('隔离任务库版本已变化，请重新读取');
        return revision;
      },
      close() {
        db.close();
        key.fill(0);
      }
    };
  } catch (error) {
    db.close();
    key.fill(0);
    throw error;
  }
}
