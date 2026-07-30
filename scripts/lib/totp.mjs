import { createHmac } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_PERIOD_SECONDS = 30;
const DEFAULT_DIGITS = 6;

export function createTotpCode(
  secret,
  now = Date.now(),
  { digits = DEFAULT_DIGITS, periodSeconds = DEFAULT_PERIOD_SECONDS } = {}
) {
  const key = decodeBase32Secret(secret);
  if (!Number.isFinite(now) || now < 0) {
    throw new Error('TOTP 时间戳无效');
  }
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new Error('TOTP 位数必须在 6 到 8 之间');
  }
  if (!Number.isInteger(periodSeconds) || periodSeconds <= 0) {
    throw new Error('TOTP 周期必须是正整数');
  }

  const counter = BigInt(Math.floor(now / 1000 / periodSeconds));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest.at(-1) & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function validateTotpSecret(secret) {
  try {
    decodeBase32Secret(secret);
    return true;
  } catch {
    return false;
  }
}

function decodeBase32Secret(secret) {
  if (typeof secret !== 'string') {
    throw new Error('TOTP secret 必须是 Base32 字符串');
  }
  const normalized = secret
    .trim()
    .replace(/[\s=-]/g, '')
    .toUpperCase();
  if (normalized.length < 16 || !/^[A-Z2-7]+$/.test(normalized)) {
    throw new Error('TOTP secret 必须是至少 16 位的 Base32 字符串');
  }

  let bits = '';
  for (const character of normalized) {
    bits += BASE32_ALPHABET.indexOf(character).toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  if (!bytes.length) {
    throw new Error('TOTP secret 解码后为空');
  }
  return Buffer.from(bytes);
}
