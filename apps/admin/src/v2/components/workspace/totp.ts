import * as OTPAuth from 'otpauth';

export const V2_TOTP_INPUT_LIMITS = {
  lines: 50,
  length: 20_000,
  secretMinLength: 16
} as const;

const SUPPORTED_ALGORITHMS = new Set(['SHA1', 'SHA256', 'SHA512']);
const BASE32_PATTERN = /^[A-Z2-7]+=*$/;
const MIN_SECRET_DISTINCT_CHARACTERS = 6;

export interface V2TotpAccount {
  id: string;
  lineNumber: number;
  label: string;
  issuer: string;
  maskedSecret: string;
  algorithm: string;
  digits: number;
  period: number;
  generator: OTPAuth.TOTP;
}

export interface V2TotpInputError {
  lineNumber: number;
  message: string;
}

export interface V2TotpParseResult {
  accounts: V2TotpAccount[];
  errors: V2TotpInputError[];
}

export interface V2TotpCodeResult {
  id: string;
  token: string;
  remainingSeconds: number;
  progress: number;
}

export function parseV2TotpInput(input: string): V2TotpParseResult {
  if (input.length > V2_TOTP_INPUT_LIMITS.length) {
    return {
      accounts: [],
      errors: [{ lineNumber: 0, message: `输入内容不能超过 ${V2_TOTP_INPUT_LIMITS.length} 个字符` }]
    };
  }

  const sourceLines = input.split(/\r?\n/);
  if (sourceLines.length > V2_TOTP_INPUT_LIMITS.lines) {
    return {
      accounts: [],
      errors: [{ lineNumber: 0, message: `一次最多处理 ${V2_TOTP_INPUT_LIMITS.lines} 行` }]
    };
  }

  const accounts: V2TotpAccount[] = [];
  const errors: V2TotpInputError[] = [];
  sourceLines.forEach((source, index) => {
    const lineNumber = index + 1;
    const line = source.trim();
    if (!line) return;
    try {
      accounts.push(parseLine(line, lineNumber));
    } catch (error) {
      errors.push({
        lineNumber,
        message: error instanceof Error ? error.message : '无法识别这一行的 2FA 密钥'
      });
    }
  });

  return { accounts, errors };
}

export function generateV2TotpCodes(
  accounts: readonly V2TotpAccount[],
  timestamp: number
): V2TotpCodeResult[] {
  return accounts.map((account) => {
    const remainingMs = account.generator.remaining({ timestamp });
    return {
      id: account.id,
      token: account.generator.generate({ timestamp }),
      remainingSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
      progress: Math.max(0, Math.min(100, (remainingMs / (account.period * 1000)) * 100))
    };
  });
}

function parseLine(line: string, lineNumber: number): V2TotpAccount {
  if (/^otpauth:\/\//i.test(line)) {
    return parseOtpAuthUri(line, lineNumber);
  }

  const segments = line.split('|');
  const label = segments.length >= 3 ? segments[0].trim() : '';
  const secretInput = segments.length >= 3 ? segments[2].trim() : line;
  const secret = normalizeBase32(secretInput);
  const generator = new OTPAuth.TOTP({
    label: label || `第 ${lineNumber} 行`,
    secret,
    algorithm: 'SHA1',
    digits: 6,
    period: 30
  });
  return toAccount(generator, lineNumber, label || `第 ${lineNumber} 行`);
}

function parseOtpAuthUri(line: string, lineNumber: number) {
  let parsed: OTPAuth.HOTP | OTPAuth.TOTP;
  try {
    parsed = OTPAuth.URI.parse(line);
  } catch {
    throw new Error('otpauth URI 格式无效');
  }
  if (!(parsed instanceof OTPAuth.TOTP)) throw new Error('仅支持基于时间的 TOTP');
  validateBase32Secret(parsed.secret.base32);
  validateConfiguration(parsed);
  return toAccount(parsed, lineNumber, parsed.label || `第 ${lineNumber} 行`);
}

function validateConfiguration(generator: OTPAuth.TOTP) {
  const algorithm = generator.algorithm.toUpperCase();
  if (!SUPPORTED_ALGORITHMS.has(algorithm)) {
    throw new Error('仅支持 SHA1、SHA256 或 SHA512 算法');
  }
  if (![6, 7, 8].includes(generator.digits)) throw new Error('验证码位数必须为 6 至 8 位');
  if (generator.period < 15 || generator.period > 300) {
    throw new Error('验证码刷新周期必须为 15 至 300 秒');
  }
}

function normalizeBase32(value: string) {
  const normalized = value.replace(/[\s-]+/g, '').toUpperCase();
  return validateBase32Secret(normalized);
}

function validateBase32Secret(normalized: string) {
  if (!BASE32_PATTERN.test(normalized)) {
    throw new Error('2FA 密钥必须是有效的 Base32 文本');
  }
  const unpadded = normalized.replace(/=+$/, '');
  if (unpadded.length < V2_TOTP_INPUT_LIMITS.secretMinLength) {
    throw new Error(`2FA 密钥长度不能少于 ${V2_TOTP_INPUT_LIMITS.secretMinLength} 位`);
  }
  if (new Set(unpadded).size < MIN_SECRET_DISTINCT_CHARACTERS) {
    throw new Error('2FA 密钥内容过于简单，请粘贴账号服务生成的真实密钥');
  }
  let secret: OTPAuth.Secret;
  try {
    secret = OTPAuth.Secret.fromBase32(normalized);
  } catch {
    throw new Error('2FA 密钥必须是有效的 Base32 文本');
  }
  if (secret.bytes.length < 10) {
    throw new Error(`2FA 密钥长度不能少于 ${V2_TOTP_INPUT_LIMITS.secretMinLength} 位`);
  }
  return secret;
}

function toAccount(generator: OTPAuth.TOTP, lineNumber: number, label: string): V2TotpAccount {
  validateConfiguration(generator);
  return {
    id: `totp-${lineNumber}`,
    lineNumber,
    label,
    issuer: generator.issuer,
    maskedSecret: maskSecret(generator.secret.base32),
    algorithm: generator.algorithm.toUpperCase(),
    digits: generator.digits,
    period: generator.period,
    generator
  };
}

function maskSecret(value: string) {
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
