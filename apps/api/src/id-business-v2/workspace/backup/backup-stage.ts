import { Readable } from 'node:stream';
import type { KeyObject } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  BackupError,
  validateBackupIdentity,
  copyBackupIdentity,
  type BackupIdentity,
  type BackupBlob
} from './backup-types';
import { BackupJournal } from './backup-journal';
import { encryptBackupStream, assertBackupEnvelope } from './backup-envelope';
import { hashBackupFile } from './backup-files';

/** Source factory is lazy: retrying the same batch never exports the database twice. */
export async function stageNewSystemBackup(
  journal: BackupJournal,
  identity: BackupIdentity,
  folderId: string,
  recipient: KeyObject,
  source: () => Readable
) {
  validateBackupIdentity(identity);
  identity = copyBackupIdentity(identity);
  const existing = await journal.load(identity.id);
  if (existing) {
    if (!isDeepStrictEqual(existing.blob.identity, identity) || existing.folderId !== folderId)
      throw new BackupError('BACKUP_BATCH_CONFLICT');
    return existing;
  }
  let blob: BackupBlob;
  const filename = `${identity.id}.idbackup`,
    path = join(journal.directory, filename);
  let present = false;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new BackupError('BACKUP_FILE_INVALID');
    present = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (present) {
    // Recover an encrypted file published immediately before a crash interrupted enqueue.
    await assertBackupEnvelope(path, identity);
    blob = { identity, filename, ...(await hashBackupFile(path, () => journal.assertCurrent())) };
  } else
    blob = await encryptBackupStream(
      Readable.from(
        (async function* () {
          for await (const bytes of source()) {
            await journal.assertCurrent();
            yield bytes;
          }
        })()
      ),
      journal.directory,
      identity,
      recipient
    );
  const state = {
    version: 1 as const,
    blob,
    folderId,
    phase: 'ready' as const,
    offset: 0,
    failures: 0,
    retryAt: 0
  };
  await journal.save(state);
  return state;
}
