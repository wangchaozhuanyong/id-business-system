import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { BackupJournal } from './backup-journal';
import { MysqlBackupCapture } from './backup-mysql-capture';
import { stageNewSystemBackup } from './backup-stage';
import { BackupError, type BackupIdentity } from './backup-types';

const directories: string[] = [];
let key: KeyObject;
beforeAll(() => {
  key = generateKeyPairSync('rsa', { modulusLength: 3072 }).publicKey;
});
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});

async function fixture() {
  const root = resolve(process.cwd(), '.runtime/backup-capture-tests');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'case-'));
  directories.push(directory);
  const journal = new BackupJournal(directory, { assertCurrent: async () => undefined });
  const serverUuid = randomUUID();
  const file = 'backup-bin.000001';
  const source = {
    serverUuid: vi.fn(async () => serverUuid as string),
    migrationRevision: vi.fn(async () => 'a'.repeat(64)),
    position: vi.fn(async () => ({ file, position: 80 })),
    full: vi.fn(async () => ({
      serverUuid,
      coordinate: { file, position: 80 },
      stream: Readable.from(['synthetic full'])
    })),
    incremental: vi.fn(async () => Readable.from(['synthetic increment']))
  };
  const stage = vi.fn((identity: BackupIdentity, recipient: KeyObject, stream?: () => Readable) =>
    stageNewSystemBackup(journal, identity, 'synthetic_folder_id', recipient, stream)
  );
  const config = { database: 'id_backup_test', serverUuid, sourceId: randomUUID(), key };
  const start = () => new MysqlBackupCapture(source, journal, stage, config);
  const head = async () =>
    (
      (await journal.loadCaptureCheckpoint()) as {
        head: BackupIdentity;
      }
    ).head;
  return { directory, journal, source, stage, start, head, file };
}

describe('independent MySQL capture', () => {
  it('captures only new committed boundaries, resumes from disk, and starts a full chain after a migration', async () => {
    const f = await fixture();
    await f.start().tick();
    const full = await f.head();
    await f.start().tick();
    expect(f.stage).toHaveBeenCalledTimes(1);
    f.source.position.mockResolvedValue({ file: f.file, position: 120 });
    await f.start().tick();
    const increment = await f.head();
    expect(increment).toMatchObject({
      kind: 'incremental',
      previousId: full.id,
      boundary: { start: `${f.file}:80`, end: `${f.file}:120` }
    });
    f.source.migrationRevision.mockResolvedValue('b'.repeat(64));
    await f.start().tick();
    const newFull = await f.head();
    expect(newFull).toMatchObject({ kind: 'full', schemaSha256: 'b'.repeat(64) });
    expect(newFull.previousId).toBeUndefined();
    expect(f.source.full).toHaveBeenCalledTimes(2);
    expect(await f.journal.load(increment.id)).not.toBeNull();
  });

  it('re-enqueues ciphertext left by a crash without re-exporting or advancing twice', async () => {
    const f = await fixture();
    const save = vi.spyOn(f.journal, 'save').mockRejectedValueOnce(new Error('synthetic restart'));
    await expect(f.start().tick()).rejects.toThrow('synthetic restart');
    expect((await readdir(f.directory)).filter((name) => name.endsWith('.idbackup'))).toHaveLength(
      1
    );
    save.mockRestore();
    await f.start().tick();
    await f.start().tick();
    expect(f.source.full).toHaveBeenCalledTimes(1);
    expect(await f.journal.load((await f.head()).id)).toMatchObject({ phase: 'ready' });
  });

  it('leaves the existing head intact when a capture crosses a migration or its source logs have a gap', async () => {
    const f = await fixture();
    await f.start().tick();
    const full = await f.head();
    f.source.position.mockResolvedValue({ file: f.file, position: 120 });
    f.source.migrationRevision
      .mockResolvedValueOnce('a'.repeat(64))
      .mockResolvedValueOnce('b'.repeat(64));
    await expect(f.start().tick()).rejects.toThrow('BACKUP_MYSQL_SCHEMA_CHANGED_DURING_CAPTURE');
    expect(await f.head()).toEqual(full);
    f.source.incremental.mockRejectedValueOnce(new BackupError('BACKUP_MYSQL_LOG_GAP'));
    await expect(f.start().tick()).rejects.toThrow('BACKUP_MYSQL_LOG_GAP');
    expect(await f.head()).toEqual(full);
    expect((await readdir(f.directory)).filter((name) => name.endsWith('.idbackup'))).toHaveLength(
      1
    );
  });
});
