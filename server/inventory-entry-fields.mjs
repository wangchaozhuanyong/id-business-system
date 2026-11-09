import { isDeepStrictEqual } from 'node:util';

const entryKeys = ['type', 'email', 'password', 'phone', 'country', 'city', 'source', 'registered', 'device',
  'emailType', 'totp', 'auxiliary', 'appPassword', 'security1', 'security2', 'security3', 'birthday',
  'proxyUrl', 'proxyProtocol', 'proxyHost', 'proxyPort', 'proxyUser', 'proxyPassword', 'notes', 'notes2'];
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const sameEntryFields = (old, row) => (old.status || '正常') === (row.status || '正常') &&
  entryKeys.every(key => (old[key] ?? '') === (row[key] ?? '')) &&
  isDeepStrictEqual(old.microsoftSecurity, row.microsoftSecurity);
const emailKey = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
const useState = (row) => row?.inventoryState || (row?.used ? 'used' : 'available');
const microsoftMethods = new Set(['email', 'authenticator', 'totp', 'passkey', 'sms']);
const microsoftSecurityKeys = new Set(['loginMode', 'recoveryAccess', 'twoStep', 'verificationMethods',
  'verificationDevice', 'recoveryMailboxId']);

function checkMicrosoftFields(row, recoveryMailboxes) {
  const email = emailKey(row.email);
  const auxiliary = emailKey(row.auxiliary);
  if (!validEmail(email)) return '微软邮箱地址格式不正确';
  if (!text(row.source, 200) || !['正常', '冻结', '封控中'].includes(row.status))
    return '请选择有效的微软邮箱来源渠道和账号状态';
  for (const key of ['password', 'phone', 'auxiliary', 'totp', 'appPassword']) {
    if (row[key] !== undefined && (typeof row[key] !== 'string' || row[key].length > 4096))
      return '微软邮箱登录或验证资料格式不正确';
  }
  const security = row.microsoftSecurity;
  if (!security || typeof security !== 'object' || Array.isArray(security) ||
      Object.keys(security).some(key => !microsoftSecurityKeys.has(key)))
    return '请填写微软邮箱登录和验证资料';
  const { loginMode, recoveryAccess, twoStep, verificationMethods, verificationDevice, recoveryMailboxId } = security;
  if (!['password', 'passwordless'].includes(loginMode) ||
      !['unknown', 'inventory', 'manual', 'unavailable'].includes(recoveryAccess) ||
      !['unknown', 'enabled', 'disabled'].includes(twoStep) ||
      !Array.isArray(verificationMethods) || verificationMethods.length > microsoftMethods.size ||
      new Set(verificationMethods).size !== verificationMethods.length ||
      verificationMethods.some(method => !microsoftMethods.has(method)) ||
      typeof verificationDevice !== 'string' || verificationDevice.length > 200)
    return '请核对微软邮箱的登录方式、两步验证和验证方式';
  if (loginMode === 'password' && !text(row.password, 4096)) return '密码登录必须填写登录密码';
  if (loginMode === 'passwordless' && (row.password || !verificationMethods.length))
    return '无密码登录请清空登录密码并选择实际使用的验证方式';
  if (auxiliary && (!validEmail(auxiliary) || auxiliary === email))
    return '辅助邮箱必须是不同于当前账号的有效地址';
  if (!auxiliary && (recoveryAccess !== 'unknown' || verificationMethods.includes('email')))
    return '请填写已绑定的辅助邮箱，再登记取码或邮箱验证方式';
  if (row.totp && !verificationMethods.includes('totp')) return '填写 2FA 密钥时请选择动态验证码';
  if (recoveryAccess === 'inventory') {
    const matches = recoveryMailboxes.get(auxiliary) || [];
    if (!recoveryMailboxId || matches.length !== 1 || matches[0].id !== recoveryMailboxId)
      return '辅助邮箱须唯一对应一条邮箱库存资料，请重新核对关联';
  } else if (recoveryMailboxId !== undefined) {
    return '请选择系统内邮箱后再关联辅助邮箱资料';
  }
}

export function checkInventoryEntryFields(previous, next, action) {
  const entryAction = ['inventory_create', 'inventory_edit', 'inventory_import'].includes(action);
  const mailboxes = next.mailboxes || [];
  const accounts = next.accounts || [];
  const microsoft = mailboxes.filter(row => row?.type === 'microsoft');
  if (!entryAction && !microsoft.length && !accounts.some(row => row?.type === 'microsoft')) return;
  const recoveryMailboxes = new Map();
  const microsoftAddresses = new Map();
  if (microsoft.length) {
    for (const row of mailboxes) {
      if (!row || row.relayDeleted || !['google', 'relay', 'microsoft'].includes(row.type)) continue;
      const email = emailKey(row.email);
      if (!recoveryMailboxes.has(email)) recoveryMailboxes.set(email, []);
      recoveryMailboxes.get(email).push(row);
      if (row.type === 'microsoft') microsoftAddresses.set(email, (microsoftAddresses.get(email) || 0) + 1);
    }
  }
  const prior = new Map([...(previous?.mailboxes || []), ...(previous?.accounts || [])].filter(Boolean).map(row => [row.id, row]));
  for (const row of accounts) {
    if (row?.type === 'microsoft' && prior.get(row.id)?.type !== 'microsoft') return '请在微软邮箱库存登记资料';
  }
  for (const row of [...mailboxes, ...accounts]) {
    if (!row) continue;
    const old = prior.get(row.id);
    if (row.type === 'microsoft') {
      if (old && row.email !== old.email) return '邮箱地址创建后不可修改';
      if (useState(row) !== useState(old) || row.claimId !== old?.claimId || row.claimBatchId !== old?.claimBatchId ||
          !isDeepStrictEqual(row.usageLinks ?? [], old?.usageLinks ?? []))
        return '微软邮箱库存暂未接入提取、归还和使用流程';
      if (old && sameEntryFields(old, row)) continue;
      if (!entryAction && (action !== 'inventory_undo' || !old)) return '请从微软邮箱管理录入或编辑资料';
      const issue = checkMicrosoftFields(row, recoveryMailboxes);
      if (issue) return issue;
      if (microsoftAddresses.get(emailKey(row.email)) > 1) return '相同类型邮箱重复，不覆盖原资料';
    } else {
      if (!entryAction || (old && (old.version || 1) === (row.version || 1) && sameEntryFields(old, row))) continue;
    }
    if (row.type === 'google' && (!text(row.country, 100) || !text(row.device, 200)))
      return '谷歌邮箱的国家地区和登录设备必填';
    if (row.type === 'claude' && (!text(row.device, 200) || !text(row.proxyUrl, 2048)))
      return 'Claude 账号的登录设备和注册代理链接必填';
    if (row.type === 'claude') {
      try {
        const proxy = new URL(row.proxyUrl);
        if (!['socks5:', 'http:', 'https:'].includes(proxy.protocol) || !proxy.hostname || /\s/.test(row.proxyUrl) ||
            (proxy.pathname && proxy.pathname !== '/') || proxy.search || proxy.hash) return '注册代理链接格式不正确';
      } catch { return '注册代理链接格式不正确'; }
    }
    if (['google', 'apple', 'microsoft'].includes(row.type) && /^[a-z][a-z0-9+.-]*:/i.test(row.phone || '')) {
      try {
        const url = new URL(row.phone);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '验证码链接仅支持有效的 HTTP(S) 地址';
      } catch { return '验证码链接格式不正确'; }
    }
  }
}
