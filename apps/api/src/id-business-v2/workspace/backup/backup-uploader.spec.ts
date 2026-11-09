import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  createHash,
  type KeyObject
} from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import { FieldEncryptionService } from '../../../common/crypto/field-encryption.service';
import { NEW_SYSTEM_BACKUP_PROFILE } from '../id-business-v2-new-backup-coverage';
import { encryptBackupStream } from './backup-envelope';
import { BackupJournal } from './backup-journal';
import { BackupDriveClient, type BackupRemoteFile } from './backup-drive-client';
import { BackupUploader } from './backup-uploader';
import type { BackupIdentity, BackupUploadState } from './backup-types';

let publicKey: KeyObject;
const directories: string[] = [];
beforeAll(() => {
  publicKey = generateKeyPairSync('rsa', { modulusLength: 3072 }).publicKey;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) await rm(path, { recursive: true });
});

async function fixture(large = false, identityOverrides: Partial<BackupIdentity> = {}) {
  const root = resolve(process.cwd(), '.runtime/backup-uploader-tests');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, 'case-'));
  directories.push(dir);
  const identity: BackupIdentity = {
    profile: NEW_SYSTEM_BACKUP_PROFILE,
    id: randomUUID(),
    sourceId: randomUUID(),
    schemaSha256: 'a'.repeat(64),
    kind: 'full',
    ...identityOverrides
  };
  const blob = await encryptBackupStream(
    Readable.from([large ? randomBytes(9 * 1024 * 1024) : Buffer.from('synthetic backup')]),
    dir,
    identity,
    publicKey
  );
  let validLease = true;
  const lease = {
    assertCurrent: vi.fn(async () => {
      if (!validLease) throw new Error('lease expired');
    })
  };
  const journal = new BackupJournal(dir, lease);
  const codec = new FieldEncryptionService(
    new ConfigService({ FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64') })
  );
  const remote: {
    file: BackupRemoteFile | null;
    bytes: Buffer;
    metadata: Record<string, unknown>;
    dropOnce: boolean;
    badDigest: boolean;
    unsafeUrl: boolean;
    throttle: boolean;
    omitSha: boolean;
  } = {
    file: null,
    bytes: Buffer.alloc(0),
    metadata: {},
    dropOnce: false,
    badDigest: false,
    unsafeUrl: false,
    throttle: false,
    omitSha: false
  };
  const ranges: string[] = [];
  const session =
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=fixture-private-session';
  const http = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer fixture-access');
    if (remote.throttle) {
      remote.throttle = false;
      return new Response('', { status: 429, headers: { 'retry-after': '120' } });
    }
    if (url.includes('/generateIds?')) return Response.json({ ids: ['generated_file_00001'] });
    if (init?.method === 'POST') {
      remote.metadata = JSON.parse(String(init.body));
      return new Response(null, {
        status: 200,
        headers: { location: remote.unsafeUrl ? 'https://outside.invalid/upload' : session }
      });
    }
    if (init?.method === 'PUT') {
      const range = headers.get('content-range')!;
      if (range.startsWith('bytes */'))
        return new Response(null, {
          status: remote.file ? 200 : 308,
          headers: remote.bytes.length ? { range: `bytes=0-${remote.bytes.length - 1}` } : {}
        });
      ranges.push(range);
      const start = Number(/^bytes ([0-9]+)-/.exec(range)![1]);
      expect(start).toBe(remote.bytes.length);
      remote.bytes = Buffer.concat([remote.bytes, Buffer.from(init.body as Uint8Array)]);
      if (remote.bytes.length === blob.size)
        remote.file = {
          id: 'generated_file_00001',
          size: String(blob.size),
          parents: remote.metadata.parents as string[],
          appProperties: remote.metadata.appProperties as Record<string, string>,
          sha256Checksum: remote.omitSha
            ? undefined
            : remote.badDigest
              ? '0'.repeat(64)
              : createHash('sha256').update(remote.bytes).digest('hex')
        };
      if (remote.dropOnce) {
        remote.dropOnce = false;
        throw new Error('fixture-sensitive-network-details');
      }
      return new Response(null, {
        status: remote.file ? 200 : 308,
        headers: { range: `bytes=0-${remote.bytes.length - 1}` }
      });
    }
    if (url.includes('alt=media')) return new Response(new Uint8Array(remote.bytes));
    return remote.file ? Response.json(remote.file) : new Response(null, { status: 404 });
  });
  const drive = new BackupDriveClient(async () => 'fixture-access', http as typeof fetch);
  const createRunner = () => new BackupUploader(new BackupJournal(dir, lease), drive, codec, lease);
  const runner = createRunner();
  await runner.enqueue(blob, 'folder_full_00001');
  const retry = (state: BackupUploadState) =>
    vi.spyOn(Date, 'now').mockReturnValue(state.retryAt + 1);
  return {
    dir,
    blob,
    runner,
    createRunner,
    remote,
    http,
    ranges,
    journal,
    drive,
    codec,
    lease,
    retry,
    expire: () => {
      validLease = false;
    }
  };
}

describe('durable resumable backup upload', () => {
  it('verifies remote SHA-256, size, folder and identity before marking a file complete', async () => {
    const f = await fixture();
    const result = await f.runner.run(f.blob.identity.id);
    expect(result.phase).toBe('verified');
    expect(result.sessionEncrypted).toBeUndefined();
    const calls = f.http.mock.calls.length;
    expect((await f.createRunner().run(f.blob.identity.id)).phase).toBe('verified');
    expect(f.http).toHaveBeenCalledTimes(calls);
  });
  it('resumes from the server acknowledgement after a dropped response and a new executor instance', async () => {
    const f = await fixture(true);
    f.remote.dropOnce = true;
    const failed = await f.runner.run(f.blob.identity.id);
    expect(failed.phase).toBe('uploading');
    expect(failed.offset).toBe(0);
    const json = await readFile(join(f.dir, `${f.blob.identity.id}.json`), 'utf8');
    expect(json).not.toContain('upload_id');
    expect(json).not.toContain('fixture-sensitive-network-details');
    expect(json).not.toContain('fixture-access');
    f.retry(failed);
    expect((await f.createRunner().run(f.blob.identity.id)).phase).toBe('verified');
    expect(f.ranges[1]).toMatch(/^bytes 8388608-/);
    expect(
      f.http.mock.calls.filter((call) => String(call[0]).includes('generateIds'))
    ).toHaveLength(1);
    expect(f.http.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  });
  it('adopts an already completed upload after its final response was lost', async () => {
    const f = await fixture();
    f.remote.dropOnce = true;
    const failed = await f.runner.run(f.blob.identity.id);
    f.retry(failed);
    expect(f.remote.file).not.toBeNull();
    expect((await f.createRunner().run(f.blob.identity.id)).phase).toBe('verified');
    expect(f.ranges).toHaveLength(1);
  });
  it('keeps failed checks pending and does not overwrite a conflicting remote file', async () => {
    const f = await fixture();
    f.remote.badDigest = true;
    const failed = await f.runner.run(f.blob.identity.id);
    expect(failed.phase).not.toBe('verified');
    expect(failed.errorCode).toBe('BACKUP_REMOTE_VERIFICATION_FAILED');
    f.retry(failed);
    const calls = f.ranges.length;
    expect((await f.createRunner().run(f.blob.identity.id)).phase).not.toBe('verified');
    expect(f.ranges).toHaveLength(calls);
  });
  it('persists Retry-After across executor restart without immediately issuing more requests', async () => {
    const f = await fixture();
    f.remote.throttle = true;
    const before = Date.now();
    const failed = await f.runner.run(f.blob.identity.id);
    expect(failed.retryAt).toBeGreaterThanOrEqual(before + 120_000);
    expect((await f.createRunner().run(f.blob.identity.id)).phase).toBe('ready');
    expect(f.http).toHaveBeenCalledOnce();
  });
  it('rejects redirects to an external upload destination without forwarding authorization', async () => {
    const f = await fixture();
    f.remote.unsafeUrl = true;
    expect((await f.runner.run(f.blob.identity.id)).errorCode).toBe('BACKUP_SESSION_URL_INVALID');
    expect(
      f.http.mock.calls.every((call) => String(call[0]).startsWith('https://www.googleapis.com/'))
    ).toBe(true);
  });
  it('checks local integrity before any network upload', async () => {
    const f = await fixture();
    await writeFile(join(f.dir, f.blob.filename), 'changed');
    expect((await f.runner.run(f.blob.identity.id)).errorCode).toBe(
      'BACKUP_LOCAL_VERIFICATION_FAILED'
    );
    expect(f.http).not.toHaveBeenCalled();
  });
  it('refuses to write into a folder outside the configured backup root', async () => {
    const f = await fixture();
    const http = vi.fn<typeof fetch>(async () =>
      Response.json({
        id: 'folder_full_00001',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['other_project_root'],
        capabilities: { canAddChildren: true }
      })
    );
    const lease = { assertCurrent: async () => undefined };
    const uploader = new BackupUploader(
      f.journal,
      new BackupDriveClient(async () => 'synthetic-token', http),
      { encrypt: () => null, decrypt: () => null },
      lease,
      262_144,
      'configured_backup_root'
    );
    expect((await uploader.run(f.blob.identity.id)).errorCode).toBe('BACKUP_DRIVE_FOLDER_INVALID');
    expect(http).toHaveBeenCalledOnce();
    expect(http.mock.calls[0]?.[1]?.method).toBeUndefined();
  });
  it('rejects an enqueue conflict and invalid filenames rather than reading outside the outbox', async () => {
    const f = await fixture();
    await expect(
      f.runner.enqueue({ ...f.blob, sha256: 'b'.repeat(64) }, 'folder_full_00001')
    ).rejects.toThrow('BACKUP_BATCH_CONFLICT');
    await expect(
      f.journal.save({
        ...(await f.journal.load(f.blob.identity.id))!,
        blob: { ...f.blob, filename: '../outside' }
      })
    ).rejects.toThrow('BACKUP_JOURNAL_INVALID');
  });
  it('will not read or advance a checkpoint after the execution lease is lost', async () => {
    const f = await fixture();
    f.expire();
    await expect(f.runner.run(f.blob.identity.id)).rejects.toThrow('lease expired');
    expect(f.http).not.toHaveBeenCalled();
  });
  it('verifies streamed encrypted bytes when Drive omits its optional SHA-256 metadata', async () => {
    const f = await fixture();
    f.remote.omitSha = true;
    expect((await f.runner.run(f.blob.identity.id)).phase).toBe('verified');
    expect(f.http.mock.calls.filter((call) => String(call[0]).includes('alt=media'))).toHaveLength(
      1
    );
  });
  it('does not upload an incremental segment whose acknowledged predecessor is missing', async () => {
    const f = await fixture(false, {
      kind: 'incremental',
      previousId: randomUUID(),
      boundary: { stream: 'mysql', start: 'log.000001:100', end: 'log.000001:200' }
    });
    expect((await f.runner.run(f.blob.identity.id)).errorCode).toBe('BACKUP_CHAIN_GAP');
    expect(f.http).not.toHaveBeenCalled();
  });
  it('accepts a continuous declared chain only after the predecessor is verified', async () => {
    const previousId = randomUUID();
    const f = await fixture(false, {
      kind: 'incremental',
      previousId,
      boundary: { stream: 'mysql', start: 'log.000001:100', end: 'log.000001:200' }
    });
    await f.journal.save({
      version: 1,
      blob: {
        ...f.blob,
        filename: `${previousId}.idbackup`,
        identity: {
          ...f.blob.identity,
          id: previousId,
          previousId: undefined,
          kind: 'full',
          boundary: { stream: 'mysql', start: 'log.000001:100', end: 'log.000001:100' }
        }
      },
      folderId: 'folder_full_00001',
      phase: 'verified',
      fileId: 'previous_file_00001',
      offset: f.blob.size,
      failures: 0,
      retryAt: 0,
      verifiedAt: new Date().toISOString()
    });
    const original = f.drive.metadata.bind(f.drive);
    vi.spyOn(f.drive, 'metadata').mockImplementation(async (id) =>
      id === 'previous_file_00001'
        ? {
            id,
            size: String(f.blob.size),
            sha256Checksum: f.blob.sha256,
            parents: ['folder_full_00001'],
            appProperties: {
              profile: f.blob.identity.profile,
              batch: previousId,
              source: f.blob.identity.sourceId,
              sha256: f.blob.sha256
            }
          }
        : original(id)
    );
    expect((await f.runner.run(f.blob.identity.id)).phase).toBe('verified');
  });
  it('avoids downloading a verified predecessor again while its provider version is unchanged', async () => {
    const f = await fixture();
    const verified = await f.runner.run(f.blob.identity.id);
    verified.verifiedVersion = '7';
    f.remote.file!.version = '7';
    f.remote.file!.md5Checksum = f.blob.md5;
    delete f.remote.file!.sha256Checksum;
    const calls = f.http.mock.calls.length;
    expect(await f.drive.verify(verified, f.remote.file)).toBe('7');
    expect(f.http).toHaveBeenCalledTimes(calls);
    f.remote.file!.version = '8';
    expect(await f.drive.verify(verified, f.remote.file)).toBe('8');
    expect(f.http.mock.calls.filter((call) => String(call[0]).includes('alt=media'))).toHaveLength(
      1
    );
  });
});
