// Stream a database dump into an authenticated encrypted backup. Never emit SQL.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';

const [mode, revision] = process.argv.slice(2);
if (!['seal', 'verify'].includes(mode) || !/^[a-f0-9]{40}$/.test(revision || '')) throw new Error('Invalid backup mode');
const magic = Buffer.from('IDBKUP01');
let header = Buffer.alloc(0);
let key;
let cipher;
let tail = Buffer.alloc(0);
let bytes = 0;
const digest = createHash('sha256');
const write = async (data) => { if (!process.stdout.write(data)) await once(process.stdout, 'drain'); };
const consume = async (data) => {
  if (mode === 'seal') {
    digest.update(data); bytes += data.length;
    await write(cipher.update(data));
  } else {
    tail = Buffer.concat([tail, data]);
    if (!cipher) {
      if (tail.length < 20) return;
      if (!tail.subarray(0, 8).equals(magic)) throw new Error('Invalid backup header');
      cipher = createDecipheriv('aes-256-gcm', key, tail.subarray(8, 20));
      cipher.setAAD(Buffer.from(revision));
      tail = tail.subarray(20);
    }
    if (tail.length <= 16) return;
    const output = cipher.update(tail.subarray(0, -16));
    digest.update(output); bytes += output.length;
    tail = tail.subarray(-16);
  }
};
try {
  for await (const chunk of process.stdin) {
    if (!key) {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf(10);
      if (end < 0) { if (header.length > 64) throw new Error('Invalid private input'); continue; }
      const secret = header.subarray(0, end).toString();
      if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid private input');
      key = createHmac('sha256', secret).update('id-business/codexdaichong/mysql-backup/v1\0' + revision).digest();
      if (mode === 'seal') {
        const iv = randomBytes(12);
        cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(Buffer.from(revision));
        await write(Buffer.concat([magic, iv]));
      }
      await consume(header.subarray(end + 1));
      header = Buffer.alloc(0);
    } else await consume(chunk);
  }
  if (!key || !cipher) throw new Error('Incomplete backup');
  if (mode === 'seal') {
    process.stdout.write(cipher.final());
    process.stdout.write(cipher.getAuthTag());
    process.stderr.write(JSON.stringify({ bytes, sha256: digest.digest('hex'), encrypted: true }) + '\n');
  } else {
    if (tail.length !== 16) throw new Error('Incomplete backup');
    cipher.setAuthTag(tail);
    const last = cipher.final(); digest.update(last); bytes += last.length;
    process.stdout.write(JSON.stringify({ bytes, sha256: digest.digest('hex'), verified: true }) + '\n');
  }
} catch {
  process.stderr.write('Private backup validation failed.\n');
  process.exitCode = 1;
} finally { key?.fill(0); }
