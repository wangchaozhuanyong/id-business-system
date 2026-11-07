import { directBrowserApi } from './login/direct-api.mjs';
import { parseBitBrowserProxyInput } from './proxy-input.mjs';
function exitAddress(value) {
  if (typeof value !== 'string' || value.length > 64) return '';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) && value.split('.').every(part => Number(part) <= 255) && !/^(?:0|10|127)\.|^192\.168\.|^169\.254\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(value)) return value;
  if (/^[\da-f:]+$/i.test(value) && value.includes(':') && /^[23][\da-f]{0,3}:/i.test(value)) return value;
  return '';
}
function readProbeResult(value) {
  for (let depth = 0; depth < 4 && value && typeof value === 'object'; depth++) {
    if (value.success === false) break;
    const ip = exitAddress(value.ip ?? value.query);
    if (ip) return { ip, countryCode: /^[A-Z]{2}$/i.test(value.countryCode || '') ? value.countryCode.toUpperCase() : '' };
    value = value.data;
  }
  throw new Error('代理检测未通过，未取得有效的出口 IP；请核对代理账号、密码和余额后重试。');
}
export async function testBitBrowserProxy({ link, protocol = 'auto', mode = 'auto', url, token, signal = new AbortController().signal, fetchExtraction = globalThis.fetch } = {}) {
  let parsed = parseBitBrowserProxyInput(link, { protocol, mode });
  const source = parsed;
  if (parsed.mode === 'dynamic') {
    try {
      const response = await fetchExtraction(parsed.link, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw new Error();
      const reader = response.body.getReader(); let bytes = 0, chunks = '';
      try {
        for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 8192) throw new Error(); chunks += new TextDecoder().decode(value); }
      } finally { await reader.cancel().catch(() => {}); }
      let extracted = chunks.trim();
      try {
        const data = JSON.parse(extracted), row = data?.data?.[0] ?? data?.data ?? data?.[0] ?? data;
        extracted = typeof row === 'string' ? row : row?.host && row?.port ? `${row.host}:${row.port}${row.username && row.password ? `:${row.username}:${row.password}` : ''}` : row?.proxy || row?.url || '';
      } catch { /* A plain proxy line is also supported. */ }
      parsed = parseBitBrowserProxyInput(extracted.split(/\r?\n/)[0], { protocol, mode: 'static' });
    } catch { throw new Error(signal.aborted ? '代理检测已取消。' : '当前电脑无法读取这个提取链接；请确认提取格式或在高级设置中核对协议。打开窗口时仍可交由比特浏览器提取。'); }
  }
  const candidates = parsed.automaticProtocol ? ['socks5', 'http'] : [parsed.protocol];
  const api = directBrowserApi(url, token, signal), started = Date.now();
  for (const type of candidates) {
    signal.throwIfAborted();
    try {
      const response = await api.post('/checkagent', { host: parsed.host.replace(/^\[|\]$/g, ''), port: String(parsed.port), proxyType: type, proxyUserName: parsed.username, proxyPassword: parsed.password, checkExists: 0 }, 12000);
      const result = readProbeResult(response);
      const normalized = new URL(parsed.link.replace(/^[a-z][a-z0-9+.-]*:/i, type + ':'));
      return { ...result, protocol: type, mode: source.mode, link: source.mode === 'dynamic' ? source.link : normalized.href, latencyMs: Math.max(1, Date.now() - started) };
    } catch (error) {
      if (signal.aborted) throw new Error('代理检测已取消。');
      if (['bitbrowser_direct_token_invalid', 'bitbrowser_direct_unreachable', 'bitbrowser_secure_context_required'].includes(error.reason)) throw error;
      if (type === candidates.at(-1)) throw new Error('代理检测未通过，请核对代理账号、密码、套餐余额或稍后重试。');
    }
  }
}
