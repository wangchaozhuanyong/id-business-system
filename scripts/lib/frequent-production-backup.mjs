import { lstat, mkdir, readFile, readdir, realpath, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MAX_ENCRYPTED_ARCHIVE_BYTES } from './production-backup.mjs';

export const FREQUENT_BACKUP_LABEL = 'local-15m';
export const MAX_LOCAL_BACKUP_COUNT = 1;
export const MAX_LOCAL_BACKUP_BYTES = 16 * 1024 * 1024;
export const MIN_LOCAL_BACKUP_COUNT = 1;
export const MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024;
export const FREQUENT_BACKUP_STALE_AFTER_MS = 20 * 60 * 1000;
export const STALE_MANAGED_FILE_MS = 60 * 60 * 1000;

const STAMP_PATTERN = '[0-9]{8}T[0-9]{6}Z';
const ARCHIVE_PATTERN = new RegExp(
  `^${FREQUENT_BACKUP_LABEL}-${STAMP_PATTERN}\\.backup\\.enc$`,
  'u'
);
const RECEIPT_PATTERN = new RegExp(
  `^${FREQUENT_BACKUP_LABEL}-${STAMP_PATTERN}\\.receipt\\.json$`,
  'u'
);
const PARTIAL_PATTERN = new RegExp(
  `^\\.${FREQUENT_BACKUP_LABEL}-${STAMP_PATTERN}\\.(?:dump|manifest\\.json|backup\\.enc)\\.partial$`,
  'u'
);

export async function resolveFrequentBackupDirectory(projectRoot = process.cwd()) {
  const resolvedRoot = await realpath(path.resolve(projectRoot));
  const expected = path.join(resolvedRoot, 'backups', 'postgres');
  await mkdir(expected, { recursive: true, mode: 0o700 });
  const actual = await realpath(expected);
  if (actual !== expected) throw new Error('高频生产备份目录不得经过符号链接');
  return actual;
}

export async function assertEnoughFreeDisk(directory, minimumBytes = MIN_FREE_DISK_BYTES) {
  const filesystem = await statfs(directory, { bigint: true });
  const availableBytes = filesystem.bavail * filesystem.bsize;
  if (availableBytes < BigInt(minimumBytes)) {
    throw new Error(`备份磁盘可用空间不足 ${formatBytes(minimumBytes)}，本次备份已停止`);
  }
  return availableBytes;
}

export async function inspectFrequentBackups(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const archives = new Map();
  const receipts = new Map();
  const partials = [];
  let totalBytes = 0;

  for (const entry of entries) {
    const kind = managedFileKind(entry.name);
    if (!kind) continue;
    const filePath = path.join(directory, entry.name);
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`受管备份路径不是普通文件：${entry.name}`);
    }
    const file = {
      name: entry.name,
      path: filePath,
      sizeBytes: metadata.size,
      modifiedAtMs: metadata.mtimeMs
    };
    totalBytes += metadata.size;
    if (kind === 'partial') partials.push(file);
    else if (kind === 'archive') archives.set(fileStem(entry.name), file);
    else receipts.set(fileStem(entry.name), file);
  }

  const backups = [];
  const orphans = [];
  const stems = new Set([...archives.keys(), ...receipts.keys()]);
  for (const stem of stems) {
    const archive = archives.get(stem);
    const receipt = receipts.get(stem);
    if (!archive || !receipt) {
      orphans.push(...[archive, receipt].filter(Boolean));
      continue;
    }
    let receiptValue;
    try {
      receiptValue = JSON.parse(await readFile(receipt.path, 'utf8'));
    } catch {
      orphans.push(archive, receipt);
      continue;
    }
    const createdAtMs = Date.parse(receiptValue.createdAt);
    if (
      receiptValue.archive !== archive.name ||
      receiptValue.encrypted !== true ||
      receiptValue.sizeBytes !== archive.sizeBytes ||
      !/^[a-f0-9]{64}$/u.test(receiptValue.sha256 ?? '') ||
      !Number.isFinite(createdAtMs) ||
      archive.sizeBytes <= 0 ||
      archive.sizeBytes > MAX_ENCRYPTED_ARCHIVE_BYTES
    ) {
      orphans.push(archive, receipt);
      continue;
    }
    backups.push({
      stem,
      archive,
      receipt,
      createdAt: receiptValue.createdAt,
      createdAtMs,
      sizeBytes: archive.sizeBytes + receipt.sizeBytes
    });
  }

  backups.sort((left, right) => left.createdAtMs - right.createdAtMs);
  orphans.sort((left, right) => left.modifiedAtMs - right.modifiedAtMs);
  partials.sort((left, right) => left.modifiedAtMs - right.modifiedAtMs);
  return { backups, orphans, partials, totalBytes };
}

export function selectFrequentBackupsToDelete(
  backups,
  {
    maxCount = MAX_LOCAL_BACKUP_COUNT,
    maxBytes = MAX_LOCAL_BACKUP_BYTES,
    minimumCount = MIN_LOCAL_BACKUP_COUNT
  } = {}
) {
  if (minimumCount > maxCount) throw new Error('最低保留数量不能高于最大保留数量');
  const newestFirst = [...backups].sort((left, right) => right.createdAtMs - left.createdAtMs);
  let retainedCount = 0;
  let retainedBytes = 0;
  let limitReached = false;
  const deleted = [];

  for (const backup of newestFirst) {
    const mandatory = retainedCount < minimumCount;
    const withinLimits = retainedCount < maxCount && retainedBytes + backup.sizeBytes <= maxBytes;
    if (!limitReached && (mandatory || withinLimits)) {
      retainedCount += 1;
      retainedBytes += backup.sizeBytes;
    } else {
      limitReached = true;
      deleted.push(backup);
    }
  }
  return deleted.sort((left, right) => left.createdAtMs - right.createdAtMs);
}

export async function pruneFrequentBackups(directory, nowMs = Date.now()) {
  const before = await inspectFrequentBackups(directory);
  const staleFiles = [...before.partials, ...before.orphans].filter(
    (file) => nowMs - file.modifiedAtMs >= STALE_MANAGED_FILE_MS
  );
  for (const file of staleFiles) await unlinkManagedFile(directory, file.path);

  const afterStaleCleanup = await inspectFrequentBackups(directory);
  const backupsToDelete = selectFrequentBackupsToDelete(afterStaleCleanup.backups);
  for (const backup of backupsToDelete) {
    await unlinkManagedFile(directory, backup.archive.path);
    await unlinkManagedFile(directory, backup.receipt.path);
  }

  const after = await inspectFrequentBackups(directory);
  if (after.backups.length > MAX_LOCAL_BACKUP_COUNT || after.totalBytes > MAX_LOCAL_BACKUP_BYTES) {
    throw new Error('高频备份超过数量或容量硬上限，已停止继续生成备份');
  }
  return {
    ...after,
    deletedBackupCount: backupsToDelete.length,
    deletedStaleFileCount: staleFiles.length
  };
}

export function assertFrequentBackupHealthy(inventory, nowMs = Date.now()) {
  if (inventory.backups.length === 0) throw new Error('尚无可用的15分钟加密备份');
  if (inventory.orphans.length > 0 || inventory.partials.length > 0) {
    throw new Error('高频备份目录存在未完成或无效文件');
  }
  if (
    inventory.backups.length > MAX_LOCAL_BACKUP_COUNT ||
    inventory.totalBytes > MAX_LOCAL_BACKUP_BYTES
  ) {
    throw new Error('高频备份超过数量或容量硬上限');
  }
  const latest = inventory.backups.at(-1);
  const ageMs = nowMs - latest.createdAtMs;
  if (ageMs < -5 * 60 * 1000) throw new Error('高频备份时间晚于当前系统时间');
  if (ageMs > FREQUENT_BACKUP_STALE_AFTER_MS) {
    throw new Error(`最新15分钟备份已过期 ${Math.ceil(ageMs / 60_000)} 分钟`);
  }
  return { latest, ageMs };
}

export function safeBackupError(error) {
  return String(error?.message ?? error ?? '未知错误')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/giu, '[数据库地址已隐藏]')
    .replace(/(password|token|secret|key)=([^\s&]+)/giu, '$1=[已隐藏]')
    .slice(-800);
}

export function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${Math.ceil(bytes / 1024)} KiB`;
}

function managedFileKind(name) {
  if (ARCHIVE_PATTERN.test(name)) return 'archive';
  if (RECEIPT_PATTERN.test(name)) return 'receipt';
  if (PARTIAL_PATTERN.test(name)) return 'partial';
  return undefined;
}

function fileStem(name) {
  return name.replace(/\.(?:backup\.enc|receipt\.json)$/u, '');
}

async function unlinkManagedFile(directory, filePath) {
  const resolvedDirectory = path.resolve(directory);
  const resolvedFile = path.resolve(filePath);
  if (
    path.dirname(resolvedFile) !== resolvedDirectory ||
    !managedFileKind(path.basename(resolvedFile))
  ) {
    throw new Error('拒绝删除不属于高频备份范围的文件');
  }
  await unlink(resolvedFile);
}
