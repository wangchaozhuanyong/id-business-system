import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  publicEncrypt,
  privateDecrypt,
  randomBytes,
  type KeyObject
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import {
  BackupError,
  validateBackupIdentity,
  copyBackupIdentity,
  type BackupIdentity,
  type BackupBlob
} from './backup-types';
import {
  hashBackupFile,
  openBackupPartial,
  publishBackupPartial,
  syncBackupDirectory
} from './backup-files';

const MAGIC = Buffer.from('IDBKB01\n');
const MAX_HEADER = 16_384;
function writerFor(file: Awaited<ReturnType<typeof open>>) {
  return new Writable({
    write(chunk: Buffer, _encoding, done) {
      void file.writeFile(chunk).then(
        () => done(),
        () => done(new BackupError('BACKUP_WRITE_FAILED'))
      );
    }
  });
}
interface EnvelopeHeader {
  version: 1;
  algorithm: 'RSA-OAEP-SHA256+AES-256-GCM';
  compression: 'gzip';
  recipient: string;
  iv: string;
  wrappedKey: string;
  identity: BackupIdentity;
}
function publicRecipient(key: KeyObject) {
  const publicKey = key.type === 'public' ? key : createPublicKey(key);
  if (
    publicKey.asymmetricKeyType !== 'rsa' ||
    (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072
  )
    throw new BackupError('BACKUP_RECIPIENT_KEY_INVALID');
  return {
    publicKey,
    fingerprint: createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex')
  };
}

export async function encryptBackupStream(
  input: Readable,
  directory: string,
  identity: BackupIdentity,
  recipient: KeyObject
): Promise<BackupBlob> {
  validateBackupIdentity(identity);
  identity = copyBackupIdentity(identity);
  const { publicKey, fingerprint } = publicRecipient(recipient);
  const key = randomBytes(32),
    iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let wrappedKey: Buffer;
  try {
    wrappedKey = publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      key
    );
  } finally {
    key.fill(0);
  }
  const header: EnvelopeHeader = {
    version: 1,
    algorithm: 'RSA-OAEP-SHA256+AES-256-GCM',
    compression: 'gzip',
    recipient: fingerprint,
    iv: iv.toString('base64url'),
    wrappedKey: wrappedKey.toString('base64url'),
    identity
  };
  const headerBytes = Buffer.from(JSON.stringify(header));
  if (headerBytes.length > MAX_HEADER) throw new BackupError('BACKUP_HEADER_TOO_LARGE');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length);
  const prefix = Buffer.concat([MAGIC, length, headerBytes]);
  cipher.setAAD(prefix);
  const partial = await openBackupPartial(directory);
  const filename = `${identity.id}.idbackup`;
  let closed = false;
  try {
    await partial.file.writeFile(prefix);
    const gzip = createGzip();
    const writer = writerFor(partial.file);
    await pipeline(input, gzip, cipher, writer);
    await partial.file.writeFile(cipher.getAuthTag());
    await partial.file.sync();
    await partial.file.close();
    closed = true;
    await publishBackupPartial(partial.path, join(directory, filename));
    await syncBackupDirectory(directory);
    return { identity, filename, ...(await hashBackupFile(join(directory, filename))) };
  } catch {
    if (!closed) await partial.file.close().catch(() => undefined);
    await unlink(partial.path).catch(() => undefined);
    throw new BackupError('BACKUP_ENCRYPTION_FAILED');
  }
}

export async function assertBackupEnvelope(path: string, expected: BackupIdentity) {
  const source = await open(path, 'r');
  try {
    const prefix = Buffer.alloc(12);
    if (
      (await source.read(prefix, 0, 12, 0)).bytesRead !== 12 ||
      !prefix.subarray(0, 8).equals(MAGIC)
    )
      throw new Error();
    const length = prefix.readUInt32BE(8);
    if (length < 1 || length > MAX_HEADER || (await source.stat()).size <= 12 + length + 16)
      throw new Error();
    const bytes = Buffer.alloc(length);
    if ((await source.read(bytes, 0, length, 12)).bytesRead !== length) throw new Error();
    const header = JSON.parse(bytes.toString()) as EnvelopeHeader;
    if (
      !isDeepStrictEqual(header.identity, expected) ||
      header.version !== 1 ||
      header.algorithm !== 'RSA-OAEP-SHA256+AES-256-GCM' ||
      header.compression !== 'gzip' ||
      !/^[a-f0-9]{64}$/.test(header.recipient) ||
      Buffer.from(header.iv, 'base64url').length !== 12 ||
      Buffer.from(header.wrappedKey, 'base64url').length < 384
    )
      throw new Error();
  } catch {
    throw new BackupError('BACKUP_FORMAT_INVALID');
  } finally {
    await source.close();
  }
}

/** Restore is explicit/offline. No private key is written or included in a backup. */
export async function decryptBackupFile(
  input: string,
  destination: string,
  privateKey: KeyObject,
  expected: BackupIdentity
) {
  expected = copyBackupIdentity(expected);
  const source = await open(input, 'r');
  let partial: Awaited<ReturnType<typeof openBackupPartial>> | undefined;
  try {
    const prefix = Buffer.alloc(12);
    if (
      (await source.read(prefix, 0, 12, 0)).bytesRead !== 12 ||
      !prefix.subarray(0, 8).equals(MAGIC)
    )
      throw new BackupError('BACKUP_FORMAT_INVALID');
    const length = prefix.readUInt32BE(8);
    if (length < 1 || length > MAX_HEADER) throw new BackupError('BACKUP_FORMAT_INVALID');
    const bytes = Buffer.alloc(length);
    if ((await source.read(bytes, 0, length, 12)).bytesRead !== length)
      throw new BackupError('BACKUP_FORMAT_INVALID');
    const header = JSON.parse(bytes.toString('utf8')) as EnvelopeHeader;
    if (
      header.version !== 1 ||
      header.algorithm !== 'RSA-OAEP-SHA256+AES-256-GCM' ||
      header.compression !== 'gzip' ||
      !isDeepStrictEqual(header.identity, expected) ||
      header.recipient !== publicRecipient(privateKey).fingerprint
    )
      throw new BackupError('BACKUP_IDENTITY_MISMATCH');
    const key = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(header.wrappedKey, 'base64url')
    );
    const iv = Buffer.from(header.iv, 'base64url');
    if (key.length !== 32 || iv.length !== 12) {
      key.fill(0);
      throw new BackupError('BACKUP_FORMAT_INVALID');
    }
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    key.fill(0);
    decipher.setAAD(Buffer.concat([prefix, bytes]));
    const size = (await source.stat()).size,
      start = 12 + length;
    if (size <= start + 16) throw new BackupError('BACKUP_FORMAT_INVALID');
    const tag = Buffer.alloc(16);
    await source.read(tag, 0, 16, size - 16);
    decipher.setAuthTag(tag);
    partial = await openBackupPartial(dirname(destination));
    const writer = writerFor(partial.file);
    await pipeline(
      createReadStream(input, { start, end: size - 17 }),
      decipher,
      createGunzip(),
      writer
    );
    await partial.file.sync();
    await partial.file.close();
    await publishBackupPartial(partial.path, destination);
    await syncBackupDirectory(dirname(destination));
  } catch {
    if (partial) {
      await partial.file.close().catch(() => undefined);
      await unlink(partial.path).catch(() => undefined);
    }
    throw new BackupError('BACKUP_RESTORE_FAILED');
  } finally {
    await source.close();
  }
}
