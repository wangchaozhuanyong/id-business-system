import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, link, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { BackupError } from './backup-types';

export async function privateBackupDirectory(directory: string) {
  if (!isAbsolute(directory)) throw new BackupError('BACKUP_DIRECTORY_INVALID');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new BackupError('BACKUP_DIRECTORY_NOT_PRIVATE');
}
export async function openBackupPartial(directory: string) {
  await privateBackupDirectory(directory);
  const path = join(directory, `.${randomUUID()}.partial`);
  return { path, file: await open(path, 'wx', 0o600) };
}
export async function publishBackupPartial(partial: string, destination: string) {
  // link() fails if a destination exists; rename() would overwrite it.
  await link(partial, destination);
  await unlink(partial);
}
export async function syncBackupDirectory(directory: string) {
  const file = await open(directory, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function hashBackupFile(path: string, canContinue?: () => Promise<void>) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new BackupError('BACKUP_FILE_INVALID');
  const sha = createHash('sha256'),
    md5 = createHash('md5');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    await canContinue?.();
    size += chunk.length;
    if (!Number.isSafeInteger(size)) throw new BackupError('BACKUP_FILE_TOO_LARGE');
    sha.update(chunk);
    md5.update(chunk);
  }
  return { size, sha256: sha.digest('hex'), md5: md5.digest('hex') };
}
