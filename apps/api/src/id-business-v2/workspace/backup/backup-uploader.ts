import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { BackupJournal } from './backup-journal';
import { BackupDriveClient } from './backup-drive-client';
import { hashBackupFile } from './backup-files';
import { assertBackupEnvelope } from './backup-envelope';
import {
  BackupError,
  copyBackupIdentity,
  type BackupBlob,
  type BackupLease,
  type BackupStateCodec,
  type BackupUploadState
} from './backup-types';

const CHUNK_BYTES = 8 * 1024 * 1024; // Multiple of Google's required 256 KiB.
export class BackupUploader {
  private running = false;
  constructor(
    private readonly journal: BackupJournal,
    private readonly drive: BackupDriveClient,
    private readonly codec: BackupStateCodec,
    private readonly lease: BackupLease,
    private readonly chunkBytes = CHUNK_BYTES,
    private readonly rootFolder?: string
  ) {
    if (
      !Number.isSafeInteger(chunkBytes) ||
      chunkBytes < 262_144 ||
      chunkBytes > CHUNK_BYTES ||
      chunkBytes % 262_144 !== 0
    )
      throw new BackupError('BACKUP_TRANSFER_CHUNK_INVALID');
  }

  async enqueue(blob: BackupBlob, folderId: string) {
    blob = { ...structuredClone(blob), identity: copyBackupIdentity(blob.identity) };
    const existing = await this.journal.load(blob.identity.id);
    if (existing) {
      if (!isDeepStrictEqual(existing.blob, blob) || existing.folderId !== folderId)
        throw new BackupError('BACKUP_BATCH_CONFLICT');
      return existing;
    }
    const state: BackupUploadState = {
      version: 1,
      blob,
      folderId,
      phase: 'ready',
      offset: 0,
      failures: 0,
      retryAt: 0
    };
    await this.journal.save(state);
    return state;
  }

  async run(id: string) {
    if (this.running) throw new BackupError('BACKUP_EXECUTOR_BUSY');
    this.running = true;
    let state: BackupUploadState | null = null;
    try {
      state = await this.journal.load(id);
      if (!state) throw new BackupError('BACKUP_BATCH_MISSING');
      if (state.phase === 'verified' || state.retryAt > Date.now()) return state;
      if (this.rootFolder) await this.drive.assertBackupFolder(state.folderId, this.rootFolder);
      await this.assertParent(state);
      const path = join(this.journal.directory, state.blob.filename);
      const actual = await hashBackupFile(path, () => this.lease.assertCurrent());
      if (actual.sha256 !== state.blob.sha256 || actual.size !== state.blob.size)
        throw new BackupError('BACKUP_LOCAL_VERIFICATION_FAILED');
      await assertBackupEnvelope(path, state.blob.identity);
      if (!state.fileId) {
        state.fileId = await this.drive.generateId();
        await this.journal.save(state);
      }
      // An upload may have finished remotely just before a crash or a lost response.
      const existing = await this.drive.metadata(state.fileId);
      if (existing) {
        const version = await this.drive.verify(state, existing);
        return await this.complete(state, version);
      }
      let session = state.sessionEncrypted ? this.codec.decrypt(state.sessionEncrypted) : null;
      if (state.sessionEncrypted && !session)
        throw new BackupError('BACKUP_SESSION_DECRYPTION_FAILED');
      if (session) {
        const response = await this.drive.progress(session, state.blob.size);
        if (response.status === 404 || response.status === 410) {
          session = null;
          state.sessionEncrypted = undefined;
          state.offset = 0;
        } else state.offset = this.drive.offset(response, state.blob.size);
        await response.body?.cancel();
        await this.journal.save(state);
      }
      if (!session && state.offset < state.blob.size) {
        session = await this.drive.start(state);
        const encrypted = this.codec.encrypt(session);
        if (!encrypted || encrypted === session)
          throw new BackupError('BACKUP_SESSION_ENCRYPTION_FAILED');
        state.sessionEncrypted = encrypted;
        state.offset = 0;
        state.phase = 'uploading';
        await this.journal.save(state);
      }
      const file = await open(path, 'r');
      try {
        while (state.offset < state.blob.size) {
          await this.lease.assertCurrent();
          const bytes = Buffer.alloc(Math.min(this.chunkBytes, state.blob.size - state.offset));
          const read = await file.read(bytes, 0, bytes.length, state.offset);
          if (read.bytesRead !== bytes.length) throw new BackupError('BACKUP_FILE_CHANGED');
          const response = await this.drive.chunk(session!, state.offset, state.blob.size, bytes);
          const offset = this.drive.offset(response, state.blob.size);
          await response.body?.cancel();
          if (offset <= state.offset) throw new BackupError('BACKUP_ACK_STALLED');
          state.offset = offset;
          await this.journal.save(state);
        }
      } finally {
        await file.close();
      }
      await this.lease.assertCurrent();
      const version = await this.drive.verify(state, await this.drive.metadata(state.fileId));
      return await this.complete(state, version);
    } catch (error) {
      if (!state) throw error;
      const failure =
        error instanceof BackupError ? error : new BackupError('BACKUP_UPLOAD_FAILED');
      state.failures += 1;
      state.errorCode = failure.code;
      state.retryAt =
        Date.now() +
        Math.max(
          failure.retryAfterMs,
          Math.min(900_000, 30_000 * 2 ** Math.min(state.failures - 1, 5)) +
            Math.floor(Math.random() * 1000)
        );
      await this.journal.save(state);
      return state;
    } finally {
      this.running = false;
    }
  }

  private async complete(state: BackupUploadState, version?: string) {
    await this.lease.assertCurrent();
    state.phase = 'verified';
    state.offset = state.blob.size;
    state.verifiedAt = new Date().toISOString();
    state.verifiedVersion = version;
    state.errorCode = undefined;
    state.retryAt = 0;
    state.sessionEncrypted = undefined;
    await this.journal.save(state);
    return state;
  }
  private async assertParent(state: BackupUploadState) {
    if (state.blob.identity.kind !== 'incremental') return;
    const parent = await this.journal.load(state.blob.identity.previousId!);
    const current = state.blob.identity,
      previous = parent?.blob.identity;
    if (
      parent?.phase !== 'verified' ||
      !['full', 'incremental'].includes(previous?.kind ?? '') ||
      previous?.sourceId !== current.sourceId ||
      previous.schemaSha256 !== current.schemaSha256 ||
      !previous.boundary ||
      previous.boundary.stream !== current.boundary?.stream ||
      previous.boundary.end !== current.boundary.start
    )
      throw new BackupError('BACKUP_CHAIN_GAP');
    await this.drive.verify(parent, await this.drive.metadata(parent.fileId!));
  }
}
