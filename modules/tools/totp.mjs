const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const hashes = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

function decodeSecret(secret) {
  const input = secret.replace(/[\s-]+/g, '').toUpperCase();
  if (!/^[A-Z2-7]+={0,6}$/.test(input) || input.length > 1024)
    throw new Error('请输入有效的 Base32 密钥');
  const encoded = input.replace(/=+$/, '');
  if (encoded.length < 16 || new Set(encoded).size < 6)
    throw new Error('请使用验证器提供的 Base32 密钥（至少 16 位）');
  const padding = input.length - encoded.length;
  const validTail = [0, 2, 4, 5, 7].includes(encoded.length % 8);
  if (!validTail || (padding && input.length % 8 !== 0)) throw new Error('Base32 密钥长度不正确');
  const bytes = new Uint8Array(Math.floor((encoded.length * 5) / 8));
  let value = 0;
  let available = 0;
  let offset = 0;
  for (const char of encoded) {
    value = (value << 5) | alphabet.indexOf(char);
    available += 5;
    if (available < 8) continue;
    available -= 8;
    bytes[offset++] = value >> available;
    value &= (1 << available) - 1;
  }
  if (value !== 0 || !bytes.length) throw new Error('Base32 密钥编码不完整');
  return bytes;
}

async function prepareTotp(raw, defaultLabel) {
  let secret = String(raw).trim();
  let label = defaultLabel;
  let algorithm = 'SHA1';
  let digits = 6;
  let period = 30;
  if (/^otpauth:/i.test(secret)) {
    let uri;
    try {
      uri = new URL(secret);
    } catch {
      throw new Error('验证器链接格式不正确');
    }
    if (
      uri.protocol !== 'otpauth:' ||
      uri.host.toLowerCase() !== 'totp' ||
      uri.username ||
      uri.password
    ) {
      throw new Error('请使用基于时间的验证器链接');
    }
    const parameters = uri.searchParams;
    secret = parameters.get('secret') || '';
    algorithm = (parameters.get('algorithm') || 'SHA1').toUpperCase();
    digits = Number(parameters.get('digits') ?? 6);
    period = Number(parameters.get('period') ?? 30);
    try {
      label = decodeURIComponent(uri.pathname.replace(/^\/+/, '')) || label;
    } catch {
      throw new Error('验证器链接格式不正确');
    }
  } else {
    const segments = secret.split('|');
    if (segments.length >= 3) {
      label = segments[0].trim() || label;
      secret = segments[2];
    }
  }
  if (
    !Object.hasOwn(hashes, algorithm) ||
    ![6, 7, 8].includes(digits) ||
    !Number.isInteger(period) ||
    period < 15 ||
    period > 300
  ) {
    throw new Error('验证器链接的算法、位数或时间周期无效');
  }
  const keyBytes = decodeSecret(secret);
  let key;
  try {
    key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: hashes[algorithm] },
      false,
      ['sign']
    );
  } finally {
    keyBytes.fill(0);
  }
  return {
    label,
    async generate(now) {
      const counter = Math.floor(now / (period * 1000));
      const counterBytes = new Uint8Array(8);
      new DataView(counterBytes.buffer).setBigUint64(0, BigInt(counter));
      const hash = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes));
      const offset = hash[hash.length - 1] & 15;
      const code = (new DataView(hash.buffer).getUint32(offset) & 0x7fffffff) % 10 ** digits;
      return { code: String(code).padStart(digits, '0'), expiresAt: (counter + 1) * period * 1000 };
    }
  };
}

export async function calculateTotp(raw, now = Date.now()) {
  return (await prepareTotp(raw, '')).generate(now);
}

export async function prepareTotpBatch(input) {
  const lines = input.split(/\r?\n/);
  if (input.length > 20_000 || lines.length > 50)
    throw new Error('一次最多处理 50 行、20,000 个字符');
  const accounts = [];
  const errors = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      accounts.push(await prepareTotp(line, `第 ${index + 1} 行`));
    } catch (error) {
      errors.push(`第 ${index + 1} 行：${error.message}`);
    }
  }
  return { accounts, errors };
}
