import { constants, createCipheriv, createDecipheriv, createHash, createPublicKey,
  privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, lstat, mkdir, open, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { projectBackupPath, verifySnapshot } from './local-sqlite.mjs';

const magic = Buffer.from('IDBSQ01\n');
const algorithm = 'aes-256-gcm';
const databaseName = 'local-business.sqlite';
const manifestName = 'manifest.json';
const idPattern = /^[a-f0-9-]{36}$/;
const options = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };

export async function archiveDigest(path) {
  const info = await lstat(path);
  if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 1)
    throw new Error('BACKUP_ARCHIVE_INVALID');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { size: info.size, sha256: hash.digest('hex') };
}

export async function sealSnapshot({ input, output, recipient, source, batch }) {
  if (![source, batch].every((value) => typeof value === 'string' && idPattern.test(value)))
    throw new Error('BACKUP_ARCHIVE_ID_INVALID');
  if (typeof recipient !== 'string' || !/^-----BEGIN (?:RSA )?PUBLIC KEY-----/.test(recipient))
    throw new Error('BACKUP_PUBLIC_KEY_REQUIRED');
  const publicKey = createPublicKey(recipient);
  if (publicKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyDetails.modulusLength < 3072)
    throw new Error('BACKUP_PUBLIC_KEY_REQUIRED');
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, key, iv);
  let wrapped;
  try {
    wrapped = publicEncrypt({ key: publicKey, ...options }, key);
  } finally {
    key.fill(0);
  }
  const header = Buffer.from(JSON.stringify({
    source, batch, iv: iv.toString('base64url'), wrapped: wrapped.toString('base64url')
  }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  const prefix = Buffer.concat([magic, length, header]);
  cipher.setAAD(prefix);
  const manifest = await readFile(join(input, manifestName));
  if (!manifest.length || manifest.length > 4096) throw new Error('BACKUP_MANIFEST_INVALID');
  const manifestLength = Buffer.alloc(4);
  manifestLength.writeUInt32BE(manifest.length);
  await writeFile(output, prefix, { flag: 'wx', mode: 0o600 });
  const plaintext = Readable.from((async function* () {
    yield manifestLength;
    yield manifest;
    yield* createReadStream(join(input, databaseName));
  })());
  await pipeline(plaintext, createGzip({ level: 1 }), cipher, createWriteStream(output, { flags: 'a' }));
  await appendFile(output, cipher.getAuthTag());
  const file = await open(output, 'r');
  try { await file.sync(); } finally { await file.close(); }
  return archiveDigest(output);
}

export async function unpackSnapshot({ input, output, key, maxBytes = 4 * 1024 ** 3 }) {
  output = await projectBackupPath(output);
  const source = await open(input, 'r');
  let created = false;
  const decoded = join(output, 'decoded.partial');
  try {
    const info = await source.stat();
    const fixed = Buffer.alloc(12);
    if (!info.isFile() || (await source.read(fixed, 0, 12, 0)).bytesRead !== 12 ||
        !fixed.subarray(0, 8).equals(magic)) throw new Error();
    const length = fixed.readUInt32BE(8);
    if (length < 1 || length > 8192 || info.size <= 12 + length + 16) throw new Error();
    const header = Buffer.alloc(length);
    const tag = Buffer.alloc(16);
    if ((await source.read(header, 0, length, 12)).bytesRead !== length ||
        (await source.read(tag, 0, 16, info.size - 16)).bytesRead !== 16) throw new Error();
    const infoHeader = JSON.parse(header.toString('utf8'));
    const iv = Buffer.from(infoHeader.iv, 'base64url');
    if (iv.length !== 12 || !idPattern.test(infoHeader.source) || !idPattern.test(infoHeader.batch)) throw new Error();
    const sessionKey = privateDecrypt({ key, ...options }, Buffer.from(infoHeader.wrapped, 'base64url'));
    let decipher;
    try { decipher = createDecipheriv(algorithm, sessionKey, iv); } finally { sessionKey.fill(0); }
    decipher.setAAD(Buffer.concat([fixed, header]));
    decipher.setAuthTag(tag);
    await mkdir(output, { mode: 0o700 });
    created = true;
    await pipeline(
      source.createReadStream({ autoClose: false, start: 12 + length, end: info.size - 17 }),
      decipher, createGunzip(),
      async function* (stream) {
        let bytes = 0;
        for await (const chunk of stream) {
          bytes += chunk.length;
          if (bytes > maxBytes) throw new Error();
          yield chunk;
        }
      },
      createWriteStream(decoded, { flags: 'wx', mode: 0o600 })
    );
    const body = await open(decoded, 'r');
    let manifestLength;
    try {
      const bytes = Buffer.alloc(4);
      if ((await body.read(bytes, 0, 4, 0)).bytesRead !== 4) throw new Error();
      manifestLength = bytes.readUInt32BE(0);
      if (manifestLength < 1 || manifestLength > 4096) throw new Error();
      const manifest = Buffer.alloc(manifestLength);
      if ((await body.read(manifest, 0, manifestLength, 4)).bytesRead !== manifestLength) throw new Error();
      await writeFile(join(output, manifestName), manifest, { flag: 'wx', mode: 0o600 });
    } finally {
      await body.close();
    }
    await pipeline(createReadStream(decoded, { start: 4 + manifestLength }),
      createWriteStream(join(output, databaseName), { flags: 'wx', mode: 0o600 }));
    await rm(decoded);
    return await verifySnapshot(output);
  } catch {
    if (created) {
      for (const path of [decoded, join(output, manifestName), join(output, databaseName)])
        await rm(path, { force: true }).catch(() => {});
      await rmdir(output).catch(() => {});
    }
    throw new Error('BACKUP_ARCHIVE_RECOVERY_FAILED');
  } finally {
    await source.close();
  }
}
