import { constants, createReadStream } from 'node:fs';
import {
  chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rm, rmdir, writeFile
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { createLocalBusinessStore } from '../local-business.mjs';
import { bitBrowserAddressDomain } from '../bitbrowser-addresses.mjs';
import { bitBrowserConnectionDomain } from '../bitbrowser-connections.mjs';

const root = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const snapshotName = 'local-business.sqlite';
const manifestName = 'manifest.json';
const format = 'id-business-sqlite-backup-v1';

export class BackupError extends Error {}

function inside(parent, child) {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

async function projectPath(path) {
  if (typeof path !== 'string' || !path.trim()) throw new BackupError('必须显式指定路径');
  const absolute = resolve(path);
  if (!inside(root, absolute)) throw new BackupError('路径必须位于独立新版项目内');
  let parent;
  try {
    parent = await realpath(dirname(absolute));
  } catch {
    throw new BackupError('路径的父目录必须已存在');
  }
  const result = join(parent, basename(absolute));
  if (!inside(root, result)) throw new BackupError('路径的实际位置超出独立新版项目');
  return result;
}

async function regularFile(path, label) {
  try {
    const stat = await lstat(path);
    if (stat.isFile()) return stat;
  } catch {
    // Report a stable message without printing supplied paths or raw OS errors.
  }
  throw new BackupError(`${label}必须是已存在的普通文件`);
}

async function privateDirectory(path) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new BackupError('目标已存在，已拒绝覆盖');
    throw new BackupError('无法创建新的隔离目标目录');
  }
}

async function digest(path) {
  const stat = await regularFile(path, 'SQLite 快照');
  const sha256 = createHash('sha256');
  for await (const chunk of createReadStream(path, { flags: constants.O_RDONLY | constants.O_NOFOLLOW }))
    sha256.update(chunk);
  return { bytes: stat.size, sha256: sha256.digest('hex') };
}

function inspectDatabase(path) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 4000 });
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') throw new Error();
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' ||
        db.prepare('PRAGMA foreign_key_check').get()) throw new Error();
    const tables = db.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map((row) => row.name);
    if (tables.join(',') !== 'business_audit,business_document') throw new Error();
    const documents = db.prepare('SELECT domain, version, typeof(payload) AS type, length(payload) AS size FROM business_document').all();
    if (documents.some((row) => typeof row.domain !== 'string' || !row.domain ||
        !Number.isSafeInteger(row.version) || row.version < 1 || row.type !== 'blob' || row.size <= 28))
      throw new Error();
    db.prepare('SELECT id, at, domain, action, summary, version FROM business_audit LIMIT 0').all();
    const auditEntries = db.prepare('SELECT COUNT(*) AS count FROM business_audit').get().count;
    return { documents, auditEntries };
  } catch {
    throw new BackupError('SQLite 完整性或独立新版业务结构校验失败');
  } finally {
    db?.close();
  }
}

function prepareStandaloneSnapshot(path) {
  // A WAL-mode source may carry its journal mode into the snapshot header.
  // Switch only the destination so the package is one standalone DB file.
  const db = new DatabaseSync(path, { timeout: 4000 });
  try {
    const result = db.prepare('PRAGMA journal_mode=DELETE').get();
    if (result.journal_mode !== 'delete') throw new Error();
  } finally {
    db.close();
  }
}

async function removeAttempt(path) {
  // Only remove known files in a directory created by this invocation.
  for (const name of [
    snapshotName, manifestName, snapshotName + '.key',
    snapshotName + '-wal', snapshotName + '-shm', snapshotName + '-journal'
  ]) await rm(join(path, name), { force: true }).catch(() => {});
  await rmdir(path).catch(() => {});

}

export async function createSnapshot({ source, output }) {
  const database = await projectPath(source);
  const target = await projectPath(output);
  await regularFile(database, '源 SQLite 数据库');
  await privateDirectory(target);
  try {
    const destination = join(target, snapshotName);
    const placeholder = await open(destination, 'wx', 0o600);
    await placeholder.close();
    const db = new DatabaseSync(database, { readOnly: true, timeout: 4000 });
    try {
      await backup(db, destination);
    } finally {
      db.close();
    }
    prepareStandaloneSnapshot(destination);
    const { documents, auditEntries } = inspectDatabase(destination);
    const manifest = {
      format, file: snapshotName, createdAt: new Date().toISOString(),
      ...await digest(destination), documents: documents.length, auditEntries
    };
    await writeFile(join(target, manifestName), JSON.stringify(manifest, null, 2) + '\n', {
      flag: 'wx', mode: 0o600
    });
    return manifest;
  } catch (error) {
    await removeAttempt(target);
    if (error instanceof BackupError) throw error;
    throw new BackupError('无法生成一致的 SQLite 快照');
  }
}

async function readManifest(directory) {
  const manifestPath = join(directory, manifestName);
  const stat = await regularFile(manifestPath, '快照清单');
  if (stat.size > 4096) throw new BackupError('快照清单格式无效');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new BackupError('快照清单格式无效');
  }
  const validInteger = (value) => Number.isSafeInteger(value) && value >= 0;
  if (manifest?.format !== format || manifest.file !== snapshotName ||
      typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)) ||
      !validInteger(manifest.bytes) || manifest.bytes === 0 ||
      typeof manifest.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
      !validInteger(manifest.documents) || !validInteger(manifest.auditEntries))
    throw new BackupError('快照清单格式无效');
  // Do not return arbitrary metadata from an imported manifest.
  const { file, createdAt, bytes, sha256, documents, auditEntries } = manifest;
  return { format, file, createdAt, bytes, sha256, documents, auditEntries };
}

async function verifyFile(path, manifest) {
  const { bytes, sha256 } = await digest(path);
  if (bytes !== manifest.bytes || sha256 !== manifest.sha256)
    throw new BackupError('SQLite 文件大小或 SHA-256 与清单不符');
  const details = inspectDatabase(path);
  if (details.documents.length !== manifest.documents || details.auditEntries !== manifest.auditEntries)
    throw new BackupError('业务文档或审计记录数量与清单不符');
  return details;
}

async function checkedPackage(input) {
  const path = await projectPath(input);
  const directory = await realpath(path).catch(() => null);
  if (!directory || directory !== path || !(await lstat(path)).isDirectory())
    throw new BackupError('快照包必须是项目内的普通目录');
  const entries = (await readdir(directory)).sort();
  if (entries.join(',') !== [snapshotName, manifestName].sort().join(','))
    throw new BackupError('快照包应仅包含数据库和清单，密钥与 SQLite 附属文件应分开');
  const manifest = await readManifest(directory);
  const database = join(directory, snapshotName);
  await verifyFile(database, manifest);
  return { directory, database, manifest };
}

export async function verifySnapshot(input) {
  const { manifest } = await checkedPackage(input);
  return manifest;
}

async function readRecoveryKey(path) {
  const stat = await regularFile(path, '恢复密钥');
  if (stat.size !== 32 || (stat.mode & 0o077))
    throw new BackupError('恢复密钥应为 32 字节，且仅文件所有者可访问');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const key = await file.readFile();
    if (key.length !== 32) {
      key.fill(0);
      throw new BackupError('恢复密钥长度无效');
    }
    return key;
  } finally {
    await file.close();
  }
}

function verifyRecoveredDocuments(path, { documents, auditEntries }) {
  if (!documents.length) throw new BackupError('快照没有加密业务文档，无法验证密钥匹配');
  let store;
  try {
    store = createLocalBusinessStore(path);
    for (const { domain, version } of documents) {
      let result;
      if (domain.startsWith('toolbox:')) {
        result = store.loadToolbox({ id: domain.slice('toolbox:'.length) });
      } else if (domain.startsWith('saved-totp:')) {
        const snapshot = store.loadSavedTotp({ id: domain.slice('saved-totp:'.length) });
        result = { version: snapshot.version, data: snapshot.items };
      } else if (domain === 'managed-mailbox-pool') {
        const snapshot = store.loadManagedMailboxPool();
        result = { version: snapshot.version, data: snapshot.items };
      } else if (domain === 'website-visits') {
        const snapshot = store.loadWebsiteVisitBackup();
        result = { version: snapshot.version, data: snapshot };
      } else if (['recharge-codes', 'tenant-cards', 'order-sync'].includes(domain)) {
        result = store.featureDocument(domain);
      } else if (domain.startsWith(`${bitBrowserAddressDomain}:`)) {
        result = store.loadBitBrowserAddressBackup(domain);
      } else if (domain.startsWith(`${bitBrowserConnectionDomain}:`)) {
        const owner = domain.slice(bitBrowserConnectionDomain.length + 1);
        const { version, profiles } = store.loadBitBrowserConnections({ id: owner });
        if (!Array.isArray(profiles)) throw new Error();
        result = { version, data: profiles };
      } else {
        result = store.load(domain);
      }
      if (result.version !== version || !result.data || typeof result.data !== 'object') throw new Error();
    }
    // The public audit reader intentionally caps results at 1000 rows.
    if (store.audit().length !== Math.min(auditEntries, 1000)) throw new Error();
  } catch {
    throw new BackupError('业务回读失败，请核对配套密钥和快照版本');
  } finally {
    store?.close();
  }
}

export async function restoreSnapshot({ input, key, output }) {
  const source = await checkedPackage(input);
  const target = await projectPath(output);
  const keyPath = await projectPath(key);
  if (inside(source.directory, keyPath)) throw new BackupError('恢复密钥必须与快照包分别保管');
  if (target === source.directory || inside(source.directory, target))
    throw new BackupError('恢复目标必须位于快照包之外的新目录');
  const recoveryKey = await readRecoveryKey(keyPath);
  let created = false;
  try {
    await privateDirectory(target);
    created = true;
    const database = join(target, snapshotName);
    await copyFile(source.database, database, constants.COPYFILE_EXCL);
    await chmod(database, 0o600);
    const details = await verifyFile(database, source.manifest);
    await writeFile(database + '.key', recoveryKey, { flag: 'wx', mode: 0o600 });
    verifyRecoveredDocuments(database, details);
    return { restored: true, documents: details.documents.length, auditEntries: details.auditEntries };
  } catch (error) {
    if (created) await removeAttempt(target);
    if (error instanceof BackupError) throw error;
    throw new BackupError('无法恢复到新的隔离目录');
  } finally {
    recoveryKey.fill(0);
  }
}
