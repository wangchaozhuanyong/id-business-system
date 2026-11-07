import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { calculateTotp } from '../../modules/tools/totp.mjs';
import { SavedTotpError, validateTotpWrite } from './saved-totp.mjs';

function configurationKey(raw) {
  const uri = /^otpauth:/i.test(raw) ? new URL(raw) : null;
  const parameters = uri?.searchParams;
  return JSON.stringify([
    (parameters?.get('secret') ?? raw).replace(/[\s=-]+/g, '').toUpperCase(),
    (parameters?.get('algorithm') || 'SHA1').toLowerCase(),
    Number(parameters?.get('digits') ?? 6),
    Number(parameters?.get('period') ?? 30)
  ]);
}

export async function planLegacyTotpImport(snapshot, bundle, secrets) {
  const invalid = () => new SavedTotpError(400, '旧 2FA 资料或原系统密钥校验失败');
  if (bundle?.format !== 'id-saved-totp-v1' ||
      !/^[a-f\d-]{36}$/i.test(bundle.ownerId || '') ||
      !Array.isArray(bundle.rows) || !bundle.rows.length || bundle.rows.length > 100 ||
      ![secrets?.fieldEncryptionKey, secrets?.hashSecret].every(value =>
        typeof value === 'string' && value.length > 0 && value.length <= 4096)) throw invalid();
  const key = createHash('sha256').update(secrets.fieldEncryptionKey).digest();
  const decoded = [];
  try {
    for (const row of bundle.rows) {
      if (row.userId !== bundle.ownerId || !/^[a-f\d-]{36}$/i.test(row.id || '') ||
          !/^[a-f\d]{64}$/i.test(row.secretHash || '') ||
          !['sha1', 'sha256', 'sha512'].includes(row.algorithm) ||
          ![6, 7, 8].includes(row.digits) || !Number.isSafeInteger(row.period) ||
          row.period < 15 || row.period > 300 ||
          (row.issuer != null && (typeof row.issuer !== 'string' || row.issuer.length > 80)) ||
          typeof row.updatedAt !== 'string' || !row.updatedAt.endsWith('Z') ||
          !Number.isFinite(Date.parse(row.updatedAt))) throw invalid();
      const fields = typeof row.secretEncrypted === 'string' ? row.secretEncrypted.split(':') : [];
      if (fields.length !== 4 || fields[0] !== 'v1' ||
          fields.slice(1).some(value => !/^[A-Za-z\d_-]+$/.test(value))) throw invalid();
      const [iv, tag, payload] = fields.slice(1).map(value => Buffer.from(value, 'base64url'));
      if (iv.length !== 12 || tag.length !== 16 || !payload.length || payload.length > 2048) throw invalid();
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const secret = Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
      const hash = createHmac('sha256', secrets.hashSecret)
        .update([row.algorithm, row.digits, row.period, secret].join(':')).digest();
      if (!timingSafeEqual(hash, Buffer.from(row.secretHash, 'hex'))) throw invalid();
      const uri = new URL('otpauth://totp/' + encodeURIComponent(row.name));
      uri.searchParams.set('secret', secret);
      uri.searchParams.set('algorithm', row.algorithm.toUpperCase());
      uri.searchParams.set('digits', String(row.digits));
      uri.searchParams.set('period', String(row.period));
      if (row.issuer) uri.searchParams.set('issuer', row.issuer);
      const command = await validateTotpWrite({ action: 'create', version: 0, name: row.name, secret: uri.href });
      decoded.push({ id: row.id, name: command.name, secret: command.secret, updatedAt: row.updatedAt });
    }
  } catch {
    throw invalid();
  } finally {
    key.fill(0);
  }
  if (new Set(decoded.map(row => row.id)).size !== decoded.length ||
      new Set(decoded.map(row => row.name)).size !== decoded.length ||
      new Set(decoded.map(row => configurationKey(row.secret))).size !== decoded.length) throw invalid();

  const items = [...(snapshot.data ?? [])];
  let imported = 0;
  for (const row of decoded) {
    const canonical = configurationKey(row.secret);
    const matching = items.find(item => configurationKey(item.secret) === canonical);
    if (items.some(item => (item.id === row.id || item.name === row.name) && item !== matching))
      throw new SavedTotpError(409, '旧 2FA 与当前账号名称或编号冲突，请核对后重试');
    if (matching) continue;
    items.push(row);
    imported++;
  }
  if (items.length > 100) throw new SavedTotpError(409, '合并后超出 100 个 2FA 账号上限');
  // Validate the merged representation without exposing generated codes.
  for (const row of items) await calculateTotp(row.secret, 59_000);
  return { items, imported, unchanged: decoded.length - imported };
}
