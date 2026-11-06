import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { legacyMailboxCodePattern, mailboxPoolItems, MailboxPoolError } from './mailbox-pool.mjs';

const providers = new Map([['gmail', 'google'], ['icloud', 'apple'], ['microsoft', 'microsoft']]);
const statuses = new Set(['active', 'disabled', 'auth_failed']);
const validDate = (value) => typeof value === 'string' &&
  /(?:Z|[+-]\d\d:?\d\d)$/i.test(value) && Number.isFinite(Date.parse(value));

function decryptField(value, key) {
  if (typeof value !== 'string' || value.length > 16_384) throw new Error();
  const fields = value.split(':');
  if (fields.length !== 4 || fields[0] !== 'v1' ||
      fields.slice(1).some((field) => !/^[A-Za-z\d_-]+$/.test(field))) throw new Error();
  const [iv, tag, payload] = fields.slice(1).map((field) => Buffer.from(field, 'base64url'));
  if (iv.length !== 12 || tag.length !== 16 || !payload.length) throw new Error();
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
}

export function decodeLegacyMailboxPool(bundle, secrets) {
  if (bundle?.format !== 'id-managed-mailbox-v1' || !Array.isArray(bundle.rows) ||
      !bundle.rows.length || bundle.rows.length > 500 ||
      !Number.isSafeInteger(bundle.defaultValidDays) || bundle.defaultValidDays < 1 || bundle.defaultValidDays > 365 ||
      ![secrets?.fieldEncryptionKey, secrets?.hashSecret].every((value) =>
        typeof value === 'string' && value.length > 0 && value.length <= 4096))
    throw new MailboxPoolError(400, '旧邮箱池导出或密钥文件格式无效');
  const key = createHash('sha256').update(secrets.fieldEncryptionKey).digest();
  const ids = new Set(), emails = new Set(), codes = new Set();
  const items = bundle.rows.map((row, index) => {
    const fail = (reason) => new MailboxPoolError(400, `旧邮箱池第 ${index + 1} 行${reason}`);
    const provider = providers.get(row?.provider);
    const email = typeof row?.email === 'string' ? row.email.trim().toLowerCase() : '';
    const label = row?.label ?? '';
    if (!provider || !statuses.has(row.status) ||
        typeof row.id !== 'string' || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(row.id) ||
        email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        typeof label !== 'string' || label.length > 60 || /[\p{C}]/u.test(label) ||
        !validDate(row.queryCodeExpiresAt) || !validDate(row.updatedAt) ||
        (row.lastQueriedAt != null && !validDate(row.lastQueriedAt)) ||
        typeof row.queryCodeHash !== 'string' || !/^[a-f\d]{64}$/i.test(row.queryCodeHash))
      throw fail('资料格式无效');
    if (row.queryCodeEncrypted == null && !row.recoveredQueryCode)
      throw fail('缺少可恢复的旧查询码，请补齐原码后重试');
    let queryCode, credential;
    try {
      queryCode = row.queryCodeEncrypted == null ? row.recoveredQueryCode : decryptField(row.queryCodeEncrypted, key);
      credential = decryptField(row.providerCredentialEncrypted, key);
    } catch {
      throw fail('解密失败，请核对原系统密钥');
    }
    if (typeof queryCode !== 'string' || !legacyMailboxCodePattern.test(queryCode) ||
        !timingSafeEqual(
          createHmac('sha256', secrets.hashSecret).update(queryCode).digest(),
          Buffer.from(row.queryCodeHash, 'hex')
        )) throw fail('旧查询码与原校验值不一致');
    if (!credential || credential.length > (provider === 'microsoft' ? 4096 : 256) || /[\p{C}]/u.test(credential))
      throw fail('授权资料格式无效');
    if (ids.has(row.id) || emails.has(email) || codes.has(queryCode))
      throw fail('与导出内其他记录重复');
    ids.add(row.id);
    emails.add(email);
    codes.add(queryCode);
    return {
      id: row.id, provider, email, label, queryCode,
      ...(provider === 'microsoft' ? { refreshToken: credential } : { appPassword: credential }),
      active: row.status !== 'disabled',
      ...(row.status === 'auth_failed' && { authFailed: true }),
      expiresAt: row.queryCodeExpiresAt, updatedAt: row.updatedAt,
      ...(row.lastQueriedAt && { lastQueriedAt: row.lastQueriedAt })
    };
  });
  return { items, defaultValidDays: bundle.defaultValidDays };
}

export function planLegacyMailboxImport(snapshot, bundle, secrets) {
  const decoded = decodeLegacyMailboxPool(bundle, secrets);
  const items = [...mailboxPoolItems(snapshot)];
  let imported = 0;
  for (const row of decoded.items) {
    const matches = items.filter((item) =>
      item.id === row.id || item.email === row.email || item.queryCode === row.queryCode
    );
    if (matches.length === 1 && isDeepStrictEqual(matches[0], row)) continue;
    if (matches.length) throw new MailboxPoolError(409, '旧邮箱池与目标资料有冲突，未覆盖任何记录');
    items.push(row);
    imported++;
  }
  if (items.length > 500) throw new MailboxPoolError(409, '合并后超出 500 条邮箱池上限');
  return {
    items, imported, unchanged: decoded.items.length - imported,
    defaultValidDays: snapshot.data?.defaultValidDays ?? decoded.defaultValidDays
  };
}
