import { parseBitBrowserProxyInput } from './proxy-input.mjs';

// Provider replies stay in memory. Never include their body, URL or credentials in an error.
export function parseBitBrowserProxyExtraction(text, { protocol = 'auto' } = {}) {
  const fail = message => { throw Object.assign(new Error(message), { reason: 'extraction' }); };
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 8192)
    fail('提取结果过大，未完成检测；请将提取数量设为 1。');
  let value;
  try { value = JSON.parse(text); } catch { value = text.trim(); }
  let visited = 0;
  function read(row, depth = 0) {
    if (++visited > 32 || depth > 5) return;
    if (typeof row === 'string') {
      try { return parseBitBrowserProxyInput(row.trim().split(/\r?\n/)[0], { protocol, mode: 'static' }); } catch { return; }
    }
    if (!row || typeof row !== 'object') return;
    if (row.success === false || row.ok === false || row.status === 'error' || row.status === 'fail') return;
    if (Array.isArray(row)) { for (const entry of row.slice(0, 8)) { const parsed = read(entry, depth + 1); if (parsed) return parsed; } return; }
    const host = row.host ?? row.ip ?? row.server, port = row.port;
    if (typeof host === 'string' && /^(?:\[[\da-f:]+\]|[\da-z._:-]+)$/i.test(host) && /^\d{1,5}$/.test(String(port))) {
      const username = row.username ?? row.user ?? '', password = row.password ?? row.pass ?? row.pwd ?? '';
      if (typeof username === 'string' && typeof password === 'string') {
        const type = ['http', 'https', 'socks5'].includes(row.protocol) ? row.protocol : protocol;
        const authority = `${username || password ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : ''}${host}:${port}`;
        const parsed = read(type === 'auto' ? authority : `${type}://${authority}`, depth + 1);
        if (parsed) return parsed;
      }
    }
    for (const key of ['proxy', 'url', 'link', 'data', 'list', 'proxies', 'proxy_list', 'result']) {
      if (!Object.hasOwn(row, key)) continue;
      const parsed = read(row[key], depth + 1); if (parsed) return parsed;
    }
  }
  const parsed = read(value);
  if (parsed) return parsed;
  if (/白名单|whitelist|white.?list|来源.?IP|ip.?not.?allow|unauthori[sz]ed|forbidden/i.test(text))
    fail('提取服务限制访问来源或白名单，未完成检测；请核对供应商的提取权限。');
  if (/余额|套餐|到期|流量|quota|balance|expired|traffic|insufficient/i.test(text))
    fail('提取服务提示套餐、余额或有效期异常，未完成检测；请在供应商处核对。');
  fail('提取接口未返回可识别的代理地址，未完成检测；请选择单条文本或包含 IP、端口的 JSON 格式。');
}
