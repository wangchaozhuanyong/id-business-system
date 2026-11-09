import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BackupError,
  UUID,
  SHA256,
  validateBackupIdentity,
  type BackupLease,
  type BackupUploadState
} from './backup-types';
import { privateBackupDirectory, syncBackupDirectory } from './backup-files';

export class BackupJournal {
  constructor(
    readonly directory: string,
    private readonly lease: BackupLease
  ) {}
  assertCurrent() {
    return this.lease.assertCurrent();
  }

  async load(id: string): Promise<BackupUploadState | null> {
    if (!UUID.test(id)) throw new BackupError('BACKUP_ID_INVALID');
    const value = await this.readState<BackupUploadState>(`${id}.json`);
    if (value === null) return null;
    this.validate(value, id);
    return value;
  }

  loadCaptureCheckpoint(): Promise<unknown> {
    return this.readState('capture-checkpoint.json');
  }

  saveCaptureCheckpoint(value: unknown) {
    return this.writeState('capture-checkpoint.json', value);
  }

  private async readState<T>(name: string): Promise<T | null> {
    await this.lease.assertCurrent();
    await privateBackupDirectory(this.directory);
    const path = join(this.directory, name);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536 || info.mode & 0o077)
      throw new BackupError('BACKUP_JOURNAL_INVALID');
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new BackupError('BACKUP_JOURNAL_INVALID');
    return value as T;
  }

  async save(value: BackupUploadState) {
    this.validate(value, value.blob.identity.id);
    return this.writeState(`${value.blob.identity.id}.json`, value);
  }

  private async writeState(name: string, value: unknown) {
    await this.lease.assertCurrent();
    await privateBackupDirectory(this.directory);
    const temp = join(this.directory, `.${randomUUID()}.json.partial`);
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
      await file.close();
      await this.lease.assertCurrent();
      await rename(temp, join(this.directory, name));
      await syncBackupDirectory(this.directory);
    } catch (error) {
      await file.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  private validate(value: BackupUploadState, id: string) {
    if (!value?.blob?.identity) throw new BackupError('BACKUP_JOURNAL_INVALID');
    if (
      Object.keys(value).some(
        (key) =>
          ![
            'version',
            'blob',
            'folderId',
            'phase',
            'fileId',
            'sessionEncrypted',
            'offset',
            'failures',
            'retryAt',
            'errorCode',
            'verifiedAt',
            'verifiedVersion'
          ].includes(key)
      ) ||
      Object.keys(value.blob).some(
        (key) => !['identity', 'filename', 'size', 'sha256', 'md5'].includes(key)
      )
    )
      throw new BackupError('BACKUP_JOURNAL_INVALID');
    validateBackupIdentity(value.blob.identity);
    if (
      value.version !== 1 ||
      value.blob.identity.id !== id ||
      value.blob.filename !== `${id}.idbackup` ||
      !SHA256.test(value.blob.sha256) ||
      !/^[a-f0-9]{32}$/.test(value.blob.md5) ||
      !Number.isSafeInteger(value.blob.size) ||
      value.blob.size < 1 ||
      !/^[A-Za-z0-9_-]{10,200}$/.test(value.folderId) ||
      !['ready', 'uploading', 'verified'].includes(value.phase) ||
      !Number.isSafeInteger(value.offset) ||
      value.offset < 0 ||
      value.offset > value.blob.size ||
      !Number.isSafeInteger(value.failures) ||
      value.failures < 0 ||
      !Number.isSafeInteger(value.retryAt) ||
      value.retryAt < 0 ||
      (value.verifiedVersion !== undefined && !/^[0-9]{1,20}$/.test(value.verifiedVersion)) ||
      (value.fileId !== undefined && !/^[A-Za-z0-9_-]{10,200}$/.test(value.fileId)) ||
      (value.errorCode !== undefined && !/^BACKUP_[A-Z0-9_]{1,80}$/.test(value.errorCode)) ||
      (value.sessionEncrypted !== undefined &&
        (typeof value.sessionEncrypted !== 'string' || value.sessionEncrypted.length > 16_384)) ||
      (value.phase === 'verified' &&
        (!value.fileId || value.offset !== value.blob.size || !value.verifiedAt))
    )
      throw new BackupError('BACKUP_JOURNAL_INVALID');
  }
}
