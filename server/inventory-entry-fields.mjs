const entryKeys = ['type', 'email', 'password', 'phone', 'country', 'city', 'source', 'registered', 'device',
  'emailType', 'totp', 'auxiliary', 'appPassword', 'security1', 'security2', 'security3', 'birthday',
  'proxyUrl', 'proxyProtocol', 'proxyHost', 'proxyPort', 'proxyUser', 'proxyPassword', 'notes', 'notes2'];
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const unchanged = (old, row) => (old.version || 1) === (row.version || 1) &&
  (old.status || '正常') === (row.status || '正常') && entryKeys.every(key => (old[key] ?? '') === (row[key] ?? ''));

export function checkInventoryEntryFields(previous, next, action) {
  if (!['inventory_create', 'inventory_edit', 'inventory_import'].includes(action)) return;
  const prior = new Map([...(previous?.mailboxes || []), ...(previous?.accounts || [])].map(row => [row.id, row]));
  for (const row of [...(next.mailboxes || []), ...(next.accounts || [])]) {
    const old = prior.get(row.id);
    if (old && unchanged(old, row)) continue;
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
    if (['google', 'apple'].includes(row.type) && /^[a-z][a-z0-9+.-]*:/i.test(row.phone || '')) {
      try {
        const url = new URL(row.phone);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '验证码链接仅支持有效的 HTTP(S) 地址';
      } catch { return '验证码链接格式不正确'; }
    }
  }
}
