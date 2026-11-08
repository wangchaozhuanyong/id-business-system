import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { NEW_SYSTEM_BACKUP_PROFILE } from '../id-business-v2-new-backup-coverage';
import { assertBackupEnvelope, decryptBackupFile, encryptBackupStream } from './backup-envelope';
import type { BackupIdentity } from './backup-types';
import { BackupJournal } from './backup-journal';
import { stageNewSystemBackup } from './backup-stage';

let keys: { publicKey: KeyObject; privateKey: KeyObject };
const directories: string[] = [];
beforeAll(() => {
  keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
});
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true });
});
async function directory() {
  const root = resolve(process.cwd(), '.runtime/backup-envelope-tests');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, 'case-'));
  directories.push(dir);
  return dir;
}
function identity(): BackupIdentity {
  return {
    profile: NEW_SYSTEM_BACKUP_PROFILE,
    id: randomUUID(),
    sourceId: randomUUID(),
    kind: 'full',
    schemaSha256: 'a'.repeat(64)
  };
}

describe('streaming encrypted backup envelope', () => {
  it('writes ciphertext only and restores exact synthetic bytes without persisting keys', async () => {
    const dir = await directory(),
      meta = identity();
    const input = Buffer.from('synthetic-private-value\n'.repeat(10000));
    const blob = await encryptBackupStream(Readable.from([input]), dir, meta, keys.publicKey);
    const encrypted = await readFile(join(dir, blob.filename));
    expect(encrypted.includes(Buffer.from('synthetic-private-value'))).toBe(false);
    expect(encrypted.length).toBe(blob.size);
    await assertBackupEnvelope(join(dir, blob.filename), meta);
    const restored = join(dir, 'isolated-restored-fixture.sql');
    await decryptBackupFile(join(dir, blob.filename), restored, keys.privateKey, { ...meta });
    expect(await readFile(restored)).toEqual(input);
    expect((await readdir(dir)).sort()).toEqual(
      [blob.filename, 'isolated-restored-fixture.sql'].sort()
    );
  });
  it('rejects changed ciphertext and never publishes a partially restored file', async () => {
    const dir = await directory(),
      meta = identity();
    const blob = await encryptBackupStream(
      Readable.from(['synthetic bytes']),
      dir,
      meta,
      keys.publicKey
    );
    const path = join(dir, blob.filename),
      bytes = await readFile(path);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(path, bytes);
    await expect(
      decryptBackupFile(path, join(dir, 'restored.sql'), keys.privateKey, meta)
    ).rejects.toThrow('BACKUP_RESTORE_FAILED');
    expect(await readdir(dir)).toEqual([blob.filename]);
  });
  it('rejects a different source identity and does not overwrite existing output', async () => {
    const dir = await directory(),
      meta = identity();
    const blob = await encryptBackupStream(Readable.from(['new data']), dir, meta, keys.publicKey);
    const output = join(dir, 'existing.sql');
    await writeFile(output, 'preserved');
    await expect(
      decryptBackupFile(join(dir, blob.filename), output, keys.privateKey, {
        ...meta,
        sourceId: randomUUID()
      })
    ).rejects.toThrow();
    await expect(
      decryptBackupFile(join(dir, blob.filename), output, keys.privateKey, meta)
    ).rejects.toThrow();
    expect(await readFile(output, 'utf8')).toBe('preserved');
  });
  it('cleans only its own partial file when the input stream fails', async () => {
    const dir = await directory();
    const source = Readable.from(
      (async function* () {
        yield Buffer.from('partial');
        throw new Error('fixture');
      })()
    );
    await expect(encryptBackupStream(source, dir, identity(), keys.publicKey)).rejects.toThrow(
      'BACKUP_ENCRYPTION_FAILED'
    );
    expect(await readdir(dir)).toEqual([]);
  });
  it('requires an explicit incremental predecessor and transaction boundary', async () => {
    const dir = await directory();
    await expect(
      encryptBackupStream(
        Readable.from(['x']),
        dir,
        { ...identity(), kind: 'incremental' },
        keys.publicKey
      )
    ).rejects.toThrow('BACKUP_INCREMENTAL_BOUNDARY_REQUIRED');
    expect(await readdir(dir)).toEqual([]);
  });
  it('recovers a published encrypted file after a crash before enqueue without exporting again', async () => {
    const dir = await directory(),
      meta = identity();
    const blob = await encryptBackupStream(
      Readable.from(['synthetic bytes']),
      dir,
      meta,
      keys.publicKey
    );
    const journal = new BackupJournal(dir, { assertCurrent: async () => undefined });
    let exports = 0;
    const source = () => {
      exports++;
      return Readable.from(['not executed']);
    };
    const staged = await stageNewSystemBackup(
      journal,
      meta,
      'folder_full_00001',
      keys.publicKey,
      source
    );
    expect(staged.blob.sha256).toBe(blob.sha256);
    expect(exports).toBe(0);
    expect(
      (await stageNewSystemBackup(journal, meta, 'folder_full_00001', keys.publicKey, source)).blob
    ).toEqual(staged.blob);
    expect(exports).toBe(0);
  });
  it('rejects extra plaintext metadata fields and incomplete log boundaries', async () => {
    const dir = await directory();
    await expect(
      encryptBackupStream(
        Readable.from(['x']),
        dir,
        { ...identity(), privateValue: 'never persisted' } as BackupIdentity,
        keys.publicKey
      )
    ).rejects.toThrow('BACKUP_IDENTITY_INVALID');
    await expect(
      encryptBackupStream(
        Readable.from(['x']),
        dir,
        { ...identity(), boundary: { stream: 'only-one-field' } } as BackupIdentity,
        keys.publicKey
      )
    ).rejects.toThrow('BACKUP_BOUNDARY_INVALID');
    expect(await readdir(dir)).toEqual([]);
  });
  it('keeps optional metadata stable when an existing batch is loaded from JSON', async () => {
    const dir = await directory(),
      meta = { ...identity(), previousId: undefined, boundary: undefined };
    const journal = new BackupJournal(dir, { assertCurrent: async () => undefined });
    const first = await stageNewSystemBackup(
      journal,
      meta,
      'folder_full_00001',
      keys.publicKey,
      () => Readable.from(['fixture'])
    );
    const second = await stageNewSystemBackup(
      journal,
      meta,
      'folder_full_00001',
      keys.publicKey,
      () => {
        throw new Error('must not export again');
      }
    );
    expect(second.blob).toEqual(first.blob);
  });
});
