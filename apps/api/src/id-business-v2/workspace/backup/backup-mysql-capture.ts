import { randomUUID, type KeyObject } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { NEW_SYSTEM_BACKUP_PROFILE } from '../id-business-v2-new-backup-coverage';
import type { BackupJournal } from './backup-journal';
import {
  mysqlPosition,
  parseMysqlPosition,
  type MysqlNativeBackupSource
} from './backup-mysql-native';
import { BackupError, validateBackupIdentity, type BackupIdentity } from './backup-types';

interface CaptureCheckpoint {
  version: 1;
  sourceId: string;
  head?: BackupIdentity;
  pending?: BackupIdentity;
}

type MysqlSource = Pick<
  MysqlNativeBackupSource,
  'serverUuid' | 'migrationRevision' | 'full' | 'position' | 'incremental'
>;
type StageCapture = (
  identity: BackupIdentity,
  key: KeyObject,
  source?: () => Readable
) => Promise<unknown>;
const MIN_FREE_BYTES = 1024n * 1024n * 1024n;

/** Drives a single database chain under the outbox's existing exclusive process lease. */
export class MysqlBackupCapture {
  constructor(
    private readonly source: MysqlSource,
    private readonly journal: BackupJournal,
    private readonly stage: StageCapture,
    private readonly config: {
      database: string;
      serverUuid: string;
      sourceId: string;
      key: KeyObject;
    }
  ) {}

  async tick() {
    let checkpoint = await this.checkpoint();
    if (checkpoint.pending) {
      try {
        await this.stage(checkpoint.pending, this.config.key);
        await this.commit(checkpoint.pending);
        return;
      } catch (error) {
        if (!(error instanceof BackupError) || error.code !== 'BACKUP_CAPTURE_NOT_STAGED')
          throw error;
        // A stopped process can leave an intent without an encrypted file. Start at the durable head.
        checkpoint = { version: 1, sourceId: this.config.sourceId, head: checkpoint.head };
        await this.journal.saveCaptureCheckpoint(checkpoint);
      }
    }

    const { database, serverUuid, sourceId } = this.config;
    if ((await this.source.serverUuid()) !== serverUuid)
      throw new BackupError('BACKUP_MYSQL_SERVER_CHANGED');
    const revision = await this.source.migrationRevision(database);
    const head = checkpoint.head;
    if (head && !isDeepStrictEqual((await this.journal.load(head.id))?.blob.identity, head))
      throw new BackupError('BACKUP_CAPTURE_HEAD_MISSING');
    const newFull = !head || head.schemaSha256 !== revision;
    const identity: BackupIdentity = {
      profile: NEW_SYSTEM_BACKUP_PROFILE,
      id: randomUUID(),
      sourceId,
      kind: newFull ? 'full' : 'incremental',
      schemaSha256: revision
    };
    const streamId = `mysql:${serverUuid}`;
    let stream: Readable;
    if (newFull) {
      await this.checkDisk();
      const full = await this.source.full(database);
      if (full.serverUuid !== serverUuid) {
        full.stream.destroy();
        throw new BackupError('BACKUP_MYSQL_SERVER_CHANGED');
      }
      const position = mysqlPosition(full.coordinate);
      identity.boundary = { stream: streamId, start: position, end: position };
      stream = full.stream;
    } else {
      const start = head.boundary!.end;
      const end = await this.source.position();
      const endPosition = mysqlPosition(end);
      if (start === endPosition) return;
      await this.checkDisk();
      stream = await this.source.incremental(parseMysqlPosition(start), end, serverUuid, database);
      identity.previousId = head.id;
      identity.boundary = { stream: streamId, start, end: endPosition };
    }

    try {
      // Persist intent before encryption. An orphan ciphertext can be re-enqueued without re-exporting.
      await this.journal.saveCaptureCheckpoint({ ...checkpoint, pending: identity });
      await this.stage(identity, this.config.key, () => this.checkedStream(stream, revision));
      await this.commit(identity);
    } finally {
      stream.destroy();
    }
  }

  private checkedStream(stream: Readable, revision: string) {
    const { database, serverUuid } = this.config;
    const source = this.source;
    const checkDisk = () => this.checkDisk();
    return Readable.from(
      (async function* () {
        let bytesSinceCheck = 0;
        for await (const chunk of stream) {
          bytesSinceCheck += Buffer.byteLength(chunk);
          if (bytesSinceCheck >= 32 * 1024 * 1024) {
            await checkDisk();
            bytesSinceCheck = 0;
          }
          yield chunk;
        }
        if ((await source.serverUuid()) !== serverUuid)
          throw new BackupError('BACKUP_MYSQL_SERVER_CHANGED');
        if ((await source.migrationRevision(database)) !== revision)
          throw new BackupError('BACKUP_MYSQL_SCHEMA_CHANGED_DURING_CAPTURE');
      })()
    );
  }

  private async checkDisk() {
    const { bavail, bsize } = await statfs(this.journal.directory, { bigint: true });
    if (bavail * bsize < MIN_FREE_BYTES) throw new BackupError('BACKUP_CAPTURE_DISK_LOW');
  }

  private async commit(head: BackupIdentity) {
    await this.journal.saveCaptureCheckpoint({ version: 1, sourceId: this.config.sourceId, head });
  }

  private async checkpoint(): Promise<CaptureCheckpoint> {
    const raw = await this.journal.loadCaptureCheckpoint();
    if (raw === null) return { version: 1, sourceId: this.config.sourceId };
    const checkpoint = raw as CaptureCheckpoint;
    const { head, pending } = checkpoint;
    const invalid = () => new BackupError('BACKUP_CAPTURE_CHECKPOINT_INVALID');
    if (checkpoint.version !== 1 || checkpoint.sourceId !== this.config.sourceId) throw invalid();
    for (const identity of [head, pending]) {
      if (identity === undefined) continue;
      validateBackupIdentity(identity);
      if (
        identity.sourceId !== this.config.sourceId ||
        !identity.boundary ||
        identity.boundary.stream !== `mysql:${this.config.serverUuid}` ||
        identity.kind === 'attachments' ||
        (identity.kind === 'full' &&
          (identity.previousId || identity.boundary.start !== identity.boundary.end))
      )
        throw invalid();
      parseMysqlPosition(identity.boundary.start);
      parseMysqlPosition(identity.boundary.end);
    }
    if (
      pending?.kind === 'incremental' &&
      (!head ||
        pending.previousId !== head.id ||
        pending.boundary!.start !== head.boundary!.end ||
        pending.schemaSha256 !== head.schemaSha256)
    )
      throw invalid();
    return checkpoint;
  }
}
