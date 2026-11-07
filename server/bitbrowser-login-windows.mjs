import { randomUUID } from 'node:crypto';

export const bitBrowserWindowDomain = 'bitbrowser-login-windows';
export class BitBrowserWindowError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const profileId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw new BitBrowserWindowError(400, '原窗口关联资料格式无效'); };

export function validateWindowLookup(body) {
  if (!object(body) || Object.keys(body).length !== 2 || !hash(body.connectionKey) || !hash(body.accountKey)) invalid();
  return { connectionKey: body.connectionKey, accountKey: body.accountKey };
}

export function readWindowRecord(rows, input) {
  const { connectionKey, accountKey } = validateWindowLookup(input);
  return (rows ?? []).find(row => row.connectionKey === connectionKey && row.accountKey === accountKey) ?? null;
}

export function writeWindowRecord(rows, body) {
  const allowed = ['connectionKey', 'accountKey', 'version', 'profileId', 'proxyConfiguration', 'replacedProfileId', 'missingConfirmed'];
  if (!object(body) || Object.keys(body).some(key => !allowed.includes(key)) ||
      !hash(body.connectionKey) || !hash(body.accountKey) || !profileId(body.profileId) || !hash(body.proxyConfiguration) ||
      !Number.isSafeInteger(body.version) || body.version < 0 || body.version >= Number.MAX_SAFE_INTEGER ||
      (Object.hasOwn(body, 'replacedProfileId') && (!profileId(body.replacedProfileId) || body.missingConfirmed !== true)) ||
      (Object.hasOwn(body, 'missingConfirmed') && !Object.hasOwn(body, 'replacedProfileId'))) invalid();
  const entries = rows ?? [];
  const current = readWindowRecord(entries, { connectionKey: body.connectionKey, accountKey: body.accountKey });
  if ((current?.version ?? 0) !== body.version)
    throw new BitBrowserWindowError(409, '原窗口关联已在其他页面更新，请重新登录以读取原窗口');
  const replacing = current && current.profileId !== body.profileId;
  if ((replacing && body.replacedProfileId !== current.profileId) ||
      (!replacing && Object.hasOwn(body, 'replacedProfileId')) ||
      entries.some(row => row.connectionKey === body.connectionKey && row.accountKey !== body.accountKey && row.profileId === body.profileId))
    throw new BitBrowserWindowError(409, '无法确认原窗口归属，本次未更改窗口关联');
  const record = {
    connectionKey: body.connectionKey, accountKey: body.accountKey,
    profileId: body.profileId, proxyConfiguration: body.proxyConfiguration,
    sourceJobId: !current || replacing ? randomUUID() : current.sourceJobId,
    version: body.version + 1
  };
  return { record, rows: current ? entries.map(row => row === current ? record : row) : [...entries, record] };
}
