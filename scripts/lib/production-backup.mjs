import {
  constants as cryptoConstants,
  createCipheriv,
  createDecipheriv,
  createHash,
  privateDecrypt,
  publicEncrypt,
  randomBytes
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';

export const BACKUP_ARCHIVE_MAGIC = Buffer.from('IDBKP001');
export const EXPECTED_BACKUP_PROJECT_REF = 'fjquufgbnxyocmuzltxi';
export const EXPECTED_BACKUP_ROLE = 'id_v2_backup';
export const POSTGRES_BACKUP_VERSION = '17.6';
export const MAX_ENCRYPTED_ARCHIVE_BYTES = 12 * 1024 * 1024;
export const MAX_GITHUB_BACKUP_STORAGE_BYTES = 400 * 1024 * 1024;

export const CORE_BACKUP_TABLES = Object.freeze([
  'users',
  'roles',
  'permissions',
  'audit_logs',
  'v2_auth_identities',
  'id_business_v2_options',
  'id_business_v2_customers',
  'id_business_v2_accounts',
  'id_business_v2_gift_cards',
  'id_business_v2_orders',
  'id_business_v2_activations',
  'id_business_v2_finance_journals',
  'id_business_v2_finance_journal_lines'
]);

export function assertExpectedBackupDatabase(rawDatabaseUrl) {
  if (typeof rawDatabaseUrl !== 'string' || !rawDatabaseUrl) {
    throw new Error('缺少 BACKUP_DATABASE_URL');
  }
  const url = new URL(rawDatabaseUrl);
  const direct =
    url.hostname === `db.${EXPECTED_BACKUP_PROJECT_REF}.supabase.co` &&
    url.username === EXPECTED_BACKUP_ROLE;
  const pooler =
    url.hostname.endsWith('.pooler.supabase.com') &&
    url.username === `${EXPECTED_BACKUP_ROLE}.${EXPECTED_BACKUP_PROJECT_REF}`;
  if (!direct && !pooler) {
    throw new Error('备份凭据不是已核验生产项目的专用只读角色');
  }
  return url;
}

export function parsePgRestoreList(output) {
  const entries = String(output)
    .split(/\r?\n/u)
    .filter((line) => line && !line.startsWith(';'));
  const tableEntries = entries.filter((line) => /\sTABLE\s/u.test(line)).length;
  const tableDataEntries = entries.filter((line) => /\sTABLE DATA\s/u.test(line)).length;
  if (entries.length === 0 || tableEntries === 0 || tableDataEntries === 0) {
    throw new Error('pg_restore 目录缺少表或表数据，备份无效');
  }
  return { tocEntries: entries.length, tableEntries, tableDataEntries };
}

export function parseCoreCounts(output) {
  const counts = {};
  for (const line of String(output).trim().split(/\r?\n/u)) {
    if (!line) continue;
    const match = line.match(/^([a-z0-9_]+)=([0-9]+)$/u);
    if (!match || !CORE_BACKUP_TABLES.includes(match[1])) {
      throw new Error('核心表计数输出格式无效');
    }
    counts[match[1]] = Number(match[2]);
  }
  if (Object.keys(counts).length !== CORE_BACKUP_TABLES.length) {
    throw new Error('核心表计数不完整');
  }
  return counts;
}

export function countFingerprint(counts) {
  const canonical = CORE_BACKUP_TABLES.map((table) => `${table}=${counts[table]}`).join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

export async function sha256File(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function publicKeyFingerprint(publicKeyPem) {
  return createHash('sha256').update(String(publicKeyPem).trim()).digest('hex');
}

export async function encryptBackupBundle({ dumpPath, manifestPath, outputPath, publicKeyPem }) {
  const [dump, manifestBytes] = await Promise.all([readFile(dumpPath), readFile(manifestPath)]);
  const manifestLength = Buffer.alloc(4);
  manifestLength.writeUInt32BE(manifestBytes.length);
  const plaintext = Buffer.concat([manifestLength, manifestBytes, dump]);
  const contentKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', contentKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrappedKey = publicEncrypt(
    {
      key: publicKeyPem,
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    contentKey
  );
  const header = Buffer.from(
    JSON.stringify({
      version: 1,
      cipher: 'aes-256-gcm',
      keyWrap: 'rsa-oaep-sha256',
      iv: iv.toString('base64'),
      wrappedKey: wrappedKey.toString('base64'),
      publicKeySha256: publicKeyFingerprint(publicKeyPem)
    })
  );
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(header.length);
  const archive = Buffer.concat([BACKUP_ARCHIVE_MAGIC, headerLength, header, ciphertext, tag]);
  if (archive.length > MAX_ENCRYPTED_ARCHIVE_BYTES) {
    throw new Error(
      `加密备份超过免费方案单份上限：${archive.length} > ${MAX_ENCRYPTED_ARCHIVE_BYTES}`
    );
  }
  await writeFile(outputPath, archive, { flag: 'wx', mode: 0o400 });
  await chmod(outputPath, 0o400);
  return {
    sizeBytes: archive.length,
    sha256: createHash('sha256').update(archive).digest('hex'),
    publicKeySha256: publicKeyFingerprint(publicKeyPem)
  };
}

export async function decryptBackupBundle({ archivePath, privateKeyPem, passphrase }) {
  const archive = await readFile(archivePath);
  if (archive.length > MAX_ENCRYPTED_ARCHIVE_BYTES) {
    throw new Error('加密备份超过允许大小');
  }
  if (
    archive.length < BACKUP_ARCHIVE_MAGIC.length + 4 + 16 ||
    !archive.subarray(0, BACKUP_ARCHIVE_MAGIC.length).equals(BACKUP_ARCHIVE_MAGIC)
  ) {
    throw new Error('加密备份魔数无效');
  }
  const headerLengthOffset = BACKUP_ARCHIVE_MAGIC.length;
  const headerLength = archive.readUInt32BE(headerLengthOffset);
  const headerStart = headerLengthOffset + 4;
  const headerEnd = headerStart + headerLength;
  if (headerLength === 0 || headerEnd + 16 > archive.length) {
    throw new Error('加密备份头部长度无效');
  }
  const header = JSON.parse(archive.subarray(headerStart, headerEnd).toString('utf8'));
  if (
    header.version !== 1 ||
    header.cipher !== 'aes-256-gcm' ||
    header.keyWrap !== 'rsa-oaep-sha256'
  ) {
    throw new Error('加密备份算法或版本不受支持');
  }
  const contentKey = privateDecrypt(
    {
      key: privateKeyPem,
      passphrase,
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    Buffer.from(header.wrappedKey, 'base64')
  );
  const tag = archive.subarray(archive.length - 16);
  const ciphertext = archive.subarray(headerEnd, archive.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', contentKey, Buffer.from(header.iv, 'base64'));
  decipher.setAuthTag(tag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('加密备份认证失败，文件已损坏或密钥错误');
  }
  if (plaintext.length < 4) throw new Error('解密后的备份内容无效');
  const manifestLength = plaintext.readUInt32BE(0);
  if (manifestLength === 0 || manifestLength + 4 >= plaintext.length) {
    throw new Error('解密后的 manifest 长度无效');
  }
  const manifestBytes = plaintext.subarray(4, 4 + manifestLength);
  const dump = plaintext.subarray(4 + manifestLength);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  validateManifestAgainstDump(manifest, dump);
  return { manifest, manifestBytes, dump, header };
}

export function validateManifestAgainstDump(manifest, dump) {
  if (
    manifest?.databaseProjectRef !== EXPECTED_BACKUP_PROJECT_REF ||
    manifest?.databaseVersion !== POSTGRES_BACKUP_VERSION ||
    manifest?.pgDumpVersion !== POSTGRES_BACKUP_VERSION ||
    manifest?.format !== 'custom'
  ) {
    throw new Error('备份 manifest 的生产项目、版本或格式不匹配');
  }
  if (manifest.sizeBytes !== dump.length) throw new Error('备份 manifest 文件大小不匹配');
  const actualSha256 = createHash('sha256').update(dump).digest('hex');
  if (manifest.sha256 !== actualSha256) throw new Error('备份 manifest SHA-256 不匹配');
  if (manifest.countFingerprint !== countFingerprint(manifest.coreCounts ?? {})) {
    throw new Error('备份 manifest 核心表计数指纹不匹配');
  }
  if (
    !Number.isInteger(manifest.tocEntries) ||
    !Number.isInteger(manifest.tableEntries) ||
    !Number.isInteger(manifest.tableDataEntries) ||
    manifest.tocEntries <= 0 ||
    manifest.tableEntries <= 0 ||
    manifest.tableDataEntries <= 0
  ) {
    throw new Error('备份 manifest 的归档目录统计无效');
  }
}

export async function atomicWriteJson(finalPath, value, mode = 0o400) {
  const partialPath = `${finalPath}.partial-${process.pid}`;
  try {
    await writeFile(partialPath, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode
    });
    await chmod(partialPath, mode);
    await rename(partialPath, finalPath);
    return finalPath;
  } catch (error) {
    await unlink(partialPath).catch(() => undefined);
    throw error;
  }
}

export async function validatePlaintextBackup({ dumpPath, manifestPath }) {
  const [dump, manifest, fileStat] = await Promise.all([
    readFile(dumpPath),
    readFile(manifestPath, 'utf8').then(JSON.parse),
    stat(dumpPath)
  ]);
  if (!fileStat.isFile() || fileStat.size === 0) throw new Error('生产备份为空或不是文件');
  validateManifestAgainstDump(manifest, dump);
  return manifest;
}
