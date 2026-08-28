import { createHmac } from 'node:crypto';
import { V2_SAVED_TOTP_ACCOUNT_LIMITS, type V2TotpAlgorithm } from '@apple-business/shared';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_PATTERN = /^[A-Z2-7]+=*$/;
const MIN_SECRET_LENGTH = 16;
const MIN_SECRET_DISTINCT_CHARACTERS = 6;

export interface IdBusinessV2TotpConfiguration {
  algorithm: Lowercase<V2TotpAlgorithm>;
  digits: number;
  issuer: string | null;
  period: number;
  secret: string;
}

export interface IdBusinessV2GeneratedTotpCode {
  expiresAt: Date;
  token: string;
}

export function parseIdBusinessV2TotpSecret(input: string): IdBusinessV2TotpConfiguration {
  const raw = input.trim();
  if (!raw || raw.length > V2_SAVED_TOTP_ACCOUNT_LIMITS.secret) {
    throw new Error(`2FA 密钥长度必须为 1 至 ${V2_SAVED_TOTP_ACCOUNT_LIMITS.secret} 个字符`);
  }

  if (!/^otpauth:\/\//i.test(raw)) {
    return {
      algorithm: 'sha1',
      digits: 6,
      issuer: null,
      period: 30,
      secret: normalizeBase32(raw)
    };
  }

  let uri: URL;
  try {
    uri = new URL(raw);
  } catch {
    throw new Error('otpauth URI 格式无效');
  }
  if (uri.protocol !== 'otpauth:' || uri.hostname.toLowerCase() !== 'totp') {
    throw new Error('仅支持基于时间的 TOTP');
  }

  const algorithm = normalizeAlgorithm(uri.searchParams.get('algorithm'));
  const digits = normalizeInteger(uri.searchParams.get('digits'), 6, 6, 8, '验证码位数');
  const period = normalizeInteger(uri.searchParams.get('period'), 30, 15, 300, '验证码刷新周期');
  const label = safeDecodeURIComponent(uri.pathname.replace(/^\/+/, ''));
  const issuer = normalizeIssuer(uri.searchParams.get('issuer') || label.split(':')[0]);

  return {
    algorithm,
    digits,
    issuer,
    period,
    secret: normalizeBase32(uri.searchParams.get('secret') ?? '')
  };
}

export function generateIdBusinessV2TotpCode(
  configuration: Pick<IdBusinessV2TotpConfiguration, 'algorithm' | 'digits' | 'period' | 'secret'>,
  timestamp = Date.now()
): IdBusinessV2GeneratedTotpCode {
  const periodMs = configuration.period * 1000;
  const counter = BigInt(Math.floor(timestamp / periodMs));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);

  const digest = createHmac(configuration.algorithm, decodeBase32(configuration.secret))
    .update(counterBuffer)
    .digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  const token = String(binary % 10 ** configuration.digits).padStart(configuration.digits, '0');
  const expiresAt = new Date((Number(counter) + 1) * periodMs);
  return { expiresAt, token };
}

function normalizeAlgorithm(value: string | null): Lowercase<V2TotpAlgorithm> {
  const algorithm = (value || 'SHA1').trim().toLowerCase();
  if (algorithm === 'sha1' || algorithm === 'sha256' || algorithm === 'sha512') return algorithm;
  throw new Error('仅支持 SHA1、SHA256 或 SHA512 算法');
}

function normalizeInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
) {
  if (value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label}必须为 ${minimum} 至 ${maximum}`);
  }
  return number;
}

function normalizeIssuer(value: string | null) {
  if (!value) return null;
  const issuer = value.trim().replace(/\s+/g, ' ');
  if (!issuer) return null;
  if (issuer.length > V2_SAVED_TOTP_ACCOUNT_LIMITS.issuer) {
    throw new Error(`签发方名称最多 ${V2_SAVED_TOTP_ACCOUNT_LIMITS.issuer} 个字符`);
  }
  return issuer;
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error('otpauth URI 格式无效');
  }
}

function normalizeBase32(value: string) {
  const normalized = value.replace(/[\s-]+/g, '').toUpperCase();
  if (!BASE32_PATTERN.test(normalized)) {
    throw new Error('2FA 密钥必须是有效的 Base32 文本');
  }
  const unpadded = normalized.replace(/=+$/, '');
  if (unpadded.length < MIN_SECRET_LENGTH) {
    throw new Error(`2FA 密钥长度不能少于 ${MIN_SECRET_LENGTH} 位`);
  }
  if (new Set(unpadded).size < MIN_SECRET_DISTINCT_CHARACTERS) {
    throw new Error('2FA 密钥内容过于简单，请粘贴账号服务生成的真实密钥');
  }
  const decoded = decodeBase32(unpadded);
  if (decoded.length < 10) {
    throw new Error(`2FA 密钥长度不能少于 ${MIN_SECRET_LENGTH} 位`);
  }
  return unpadded;
}

function decodeBase32(value: string) {
  const unpadded = value.replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bitCount = 0;

  for (const character of unpadded) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error('2FA 密钥必须是有效的 Base32 文本');
    buffer = (buffer << 5) | index;
    bitCount += 5;
    while (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((buffer >>> bitCount) & 0xff);
    }
    buffer &= bitCount === 0 ? 0 : (1 << bitCount) - 1;
  }

  return Buffer.from(bytes);
}
