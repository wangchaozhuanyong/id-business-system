import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const maxBytes = 64 * 1024;
const labels = new Map([
  ['website-analytics', '网站访问统计'],
  ['website-cloudflare', 'Cloudflare 商城访问统计'],
  ['website-visits', '网站访问采集'],
  ['microsoft-mailbox', 'Microsoft 邮箱授权'],
  ['vendure-task-service', '商城代充任务服务'],
  ['legacy-mailbox-export', '旧邮箱池导出'],
  ['legacy-mailbox-key', '旧邮箱池密钥']
]);

function isPrivate(stat, uid, limit) {
  const mode = stat.mode & 0o7777n;
  return (
    stat.isFile() &&
    stat.uid === uid &&
    stat.nlink === 1n &&
    (mode === 0o600n || mode === 0o400n) &&
    stat.size > 0n &&
    stat.size <= BigInt(limit)
  );
}

function unchanged(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function assertNoMacAcl(path) {
  if (process.platform !== 'darwin') return;
  // macOS can grant access via an extended ACL even when POSIX mode is 0600.
  const { stdout } = await run('/bin/ls', ['-ldeb', path], {
    env: { LC_ALL: 'C' },
    maxBuffer: 64 * 1024,
    timeout: 2000
  });
  if (!stdout.startsWith('-') || stdout[10] === '+' || /(?:^|\n)\s+\d+:/u.test(stdout))
    throw new Error();
}

async function readPrivateFile(path, limit) {
  const uid = BigInt(process.geteuid());
  if (
    typeof path !== 'string' ||
    !path.trim() ||
    path.split(sep).includes('..') ||
    !Number.isInteger(constants.O_NOFOLLOW) ||
    !Number.isInteger(constants.O_NONBLOCK)
  )
    throw new Error();
  const absolute = resolve(path);
  if ((await realpath(absolute)) !== absolute) throw new Error();
  const initial = await lstat(absolute, { bigint: true });
  if (!isPrivate(initial, uid, limit)) throw new Error();

  const file = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  let bytes;
  try {
    const before = await file.stat({ bigint: true });
    if (!isPrivate(before, uid, limit) || !unchanged(initial, before)) throw new Error();
    await assertNoMacAcl(absolute);
    // Read at most the verified size plus one byte, even if the file grows in place.
    const length = Number(before.size);
    bytes = Buffer.alloc(length + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      offset !== length ||
      !isPrivate(after, uid, limit) ||
      !unchanged(before, after) ||
      (await realpath(absolute)) !== absolute ||
      !unchanged(after, await lstat(absolute, { bigint: true }))
    )
      throw new Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    bytes?.fill(0);
    await file.close();
  }
}

class ToolConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Load only explicitly supplied private files. Error messages never include OS or parser details. */
export async function readToolConfig(path, kind) {
  const label = labels.get(kind);
  if (!label) throw new Error('工具配置类型无效');
  if (path === undefined) return undefined;

  let text;
  try {
    text = await readPrivateFile(path, kind === 'legacy-mailbox-export' ? 8 * 1024 * 1024 : maxBytes);
  } catch {
    throw new ToolConfigError('CONFIG_FILE_REJECTED',
      `${label}配置无法安全读取，请核对文件所有者、0600／0400 权限及文件位置`);
  }

  try {
    if (kind === 'website-visits') {
      const secret = text.trim();
      if (Buffer.byteLength(secret) < 32 || /[\r\n\0]/u.test(secret)) throw new Error();
      return secret;
    }
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    if (kind === 'website-analytics' && parsed.type === 'service_account' &&
        !['propertyId', 'streamId', 'hosts', 'serviceAccount'].some((field) => Object.hasOwn(parsed, field))) {
      // The deployed FLASH CAST integration stores a standard Google credential separately from the report source.
      return {
        propertyId: '540413787',
        streamId: '15010607367',
        hosts: ['flashcast.com.my', 'www.flashcast.com.my'],
        serviceAccount: parsed
      };
    }
    return parsed;
  } catch {
    throw new ToolConfigError('CONFIG_FORMAT_INVALID', `${label}配置文件格式无效`);
  }
}
