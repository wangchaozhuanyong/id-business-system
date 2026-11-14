// Portable recovery state. Plaintext stays in memory; this module never installs
// recovered files, changes a credential, or resumes a payment executor.
import { constants, createCipheriv, createDecipheriv, createHash, createPrivateKey,
  createPublicKey, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const magic = Buffer.from('IDBSTATE1\n');
const maximum = 64 * 1024 * 1024;
const rsa = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const relative = value => typeof value === 'string' && value.length <= 512 &&
  !/[\u0000-\u001f\u007f\\]/u.test(value) && !value.startsWith('/') &&
  value.split('/').every(part => part && part !== '.' && part !== '..');
const ownership = entry => Number.isSafeInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777 &&
  ['uid', 'gid'].every(key => Number.isSafeInteger(entry[key]) && entry[key] >= 0 && entry[key] < 2 ** 31);

function validate(state) {
  if (state?.format !== 'id-business-recovery-state-v1' || state.sessionPolicy !== 'revoke' ||
      !/^[a-f0-9]{40}$/.test(state.appRevision || '') || !/^[a-f0-9]{40}$/.test(state.nativeRevision || '') ||
      !Number.isFinite(Date.parse(state.startedAt)) || !Number.isFinite(Date.parse(state.finishedAt)) ||
      Date.parse(state.startedAt) > Date.parse(state.finishedAt) ||
      !Array.isArray(state.entries) || !state.entries.length || state.entries.length > 4096 ||
      !Array.isArray(state.directories) || state.directories.length > 4096)
    throw new Error('RECOVERY_STATE_INVALID');
  const names = new Set();
  const directories = new Set();
  for (const directory of state.directories) {
    if (!relative(directory.path) || !ownership(directory) || directories.has(directory.path))
      throw new Error('RECOVERY_DIRECTORY_INVALID');
    directories.add(directory.path);
  }
  let total = 0;
  for (const entry of state.entries) {
    if (!relative(entry.path) || names.has(entry.path) || directories.has(entry.path) ||
        !['file', 'sqlite', 'credential', 'service'].includes(entry.kind) ||
        !ownership(entry) ||
        typeof entry.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.data) ||
        !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) throw new Error('RECOVERY_ENTRY_INVALID');
    const bytes = Buffer.from(entry.data, 'base64');
    total += bytes.length;
    if (total > maximum || bytes.toString('base64') !== entry.data || hash(bytes) !== entry.sha256)
      throw new Error('RECOVERY_ENTRY_INVALID');
    names.add(entry.path);
  }
  for (const name of [...names, ...directories]) {
    const parts = name.split('/'); parts.pop();
    while (parts.length) {
      if (!directories.has(parts.join('/'))) throw new Error('RECOVERY_DIRECTORY_MISSING');
      parts.pop();
    }
  }
  for (const required of ['formal/data/local-auth.json', 'formal/data/local-auth.json.security.json',
    'formal/data/local-business.sqlite', 'formal/data/local-business.sqlite.key',
    'formal/data/recharge-events.checkpoint.json'])
    if (!names.has(required)) throw new Error('RECOVERY_REQUIRED_STATE_MISSING');
  // Live sessions and the admission marker must never be restored as proof that
  // a new host is allowed to accept payments. Sockets/locks are runtime objects.
  if ([...names, ...directories].some(name => name.split('/').some(part =>
    part === 'accept-submissions' || /\.(?:sessions|sock|lock)$/.test(part))))
    throw new Error('RECOVERY_RUNTIME_STATE_FORBIDDEN');
  return { files: names.size, directories: directories.size, bytes: total, appRevision: state.appRevision,
    nativeRevision: state.nativeRevision, startedAt: state.startedAt, finishedAt: state.finishedAt,
    sessionPolicy: state.sessionPolicy };
}

export function sealRecoveryState(state, recipient) {
  const details = validate(state);
  const publicKey = createPublicKey(recipient);
  if (publicKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyDetails.modulusLength < 3072)
    throw new Error('RECOVERY_PUBLIC_KEY_REQUIRED');
  const key = randomBytes(32), iv = randomBytes(12);
  const recipientSha256 = hash(Buffer.from(recipient));
  const header = Buffer.from(JSON.stringify({ version: 1, recipientSha256, iv: iv.toString('base64'),
    wrapped: publicEncrypt({ key: publicKey, ...rsa }, key).toString('base64') }));
  const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
  const prefix = Buffer.concat([magic, length, header]);
  const plain = Buffer.from(JSON.stringify(state));
  if (plain.length > maximum * 2) { key.fill(0); plain.fill(0); throw new Error('RECOVERY_STATE_TOO_LARGE'); }
  let packed;
  try {
    packed = gzipSync(plain, { level: 1 });
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(prefix);
    const archive = Buffer.concat([prefix, cipher.update(packed), cipher.final(), cipher.getAuthTag()]);
    return { archive, receipt: { ...details, recipientSha256, cipherSha256: hash(archive), cipherBytes: archive.length } };
  } finally { key.fill(0); plain.fill(0); packed?.fill(0); }
}

export function openRecoveryState(archive, recoveryKey) {
  let key, verified, plain;
  try {
    if (!Buffer.isBuffer(archive) || archive.length < magic.length + 21 || archive.length > maximum * 2 ||
        !archive.subarray(0, magic.length).equals(magic)) throw new Error();
    const fixed = magic.length + 4;
    const length = archive.readUInt32BE(magic.length);
    if (length < 1 || length > 8192 || archive.length <= fixed + length + 16) throw new Error();
    const end = fixed + length;
    const header = JSON.parse(archive.subarray(fixed, end));
    const iv = Buffer.from(header.iv, 'base64');
    const privateKey = createPrivateKey(recoveryKey);
    const recipientSha256 = hash(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }));
    if (header.version !== 1 || iv.length !== 12 || header.recipientSha256 !== recipientSha256) throw new Error();
    key = privateDecrypt({ key: privateKey, ...rsa }, Buffer.from(header.wrapped, 'base64'));
    if (key.length !== 32) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(archive.subarray(0, end)); cipher.setAuthTag(archive.subarray(-16));
    verified = Buffer.concat([cipher.update(archive.subarray(end, -16)), cipher.final()]);
    plain = gunzipSync(verified, { maxOutputLength: maximum * 2 });
    const state = JSON.parse(plain);
    const receipt = validate(state);
    return { state, receipt: { ...receipt, recipientSha256, cipherSha256: hash(archive), cipherBytes: archive.length } };
  } catch { throw new Error('RECOVERY_STATE_VERIFICATION_FAILED'); }
  finally { key?.fill(0); verified?.fill(0); plain?.fill(0); }
}
