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
      const response = await fetchExtraction('/api/local/bitbrowser-proxies/extract', {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ link: parsed.link, protocol }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)])
      });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.reason === 'extraction' ? result.error : '提取检测未完成，请确认系统会话后重试。'), { reason: 'extraction' });
      parsed = parseBitBrowserProxyInput(result.link, { protocol: 'auto', mode: 'static' });
      parsed.automaticProtocol = result.automaticProtocol === true;
    } catch (error) {
      throw Object.assign(new Error(signal.aborted ? '代理检测已取消。' : error.reason === 'extraction' ? error.message : '提取检测请求未完成，请稍后重试；这不代表代理不可用。'), { reason: 'extraction' });
    }
  }
  const candidates = parsed.automaticProtocol ? ['socks5', 'http'] : [parsed.protocol];
  const started = Date.now();
  async function nativeCheck(body) {
    const timeout = AbortSignal.timeout(30_000);
    const api = directBrowserApi(url, token, AbortSignal.any([signal, timeout]));
    try { return await api.post('/checkagent', body); }
    catch (error) {
      if (timeout.aborted && !signal.aborted)
        throw Object.assign(new Error('比特代理检测等待超时（30 秒），未完成检测；请检查该线路或稍后重试。'), { reason: 'bitbrowser_proxy_probe_timeout' });
      throw error;
    }
  }
  for (const type of candidates) {
    signal.throwIfAborted();
    try {
      const body = { host: parsed.host.replace(/^\[|\]$/g, ''), port: String(parsed.port), proxyType: type, proxyUserName: parsed.username, proxyPassword: parsed.password, checkExists: 0 };
      let response;
      try { response = await nativeCheck(body); }
      catch (error) {
        // Only this read-only native check may retry a dropped connection once.
        if (signal.aborted || error.reason !== 'bitbrowser_direct_unreachable') throw error;
        response = await nativeCheck(body);
      }
      const result = readProbeResult(response);
      const normalized = new URL(parsed.link.replace(/^[a-z][a-z0-9+.-]*:/i, type + ':'));
      return { ...result, protocol: type, mode: source.mode, link: source.mode === 'dynamic' ? source.link : normalized.href, latencyMs: Math.max(1, Date.now() - started) };
    } catch (error) {
      if (signal.aborted) throw new Error('代理检测已取消。');
      if (['bitbrowser_direct_token_invalid', 'bitbrowser_secure_context_required'].includes(error.reason)) throw error;
      if (type === candidates.at(-1) && ['bitbrowser_direct_unreachable', 'bitbrowser_proxy_probe_timeout', 'bitbrowser_direct_protocol'].includes(error.reason)) throw error;
      if (type === candidates.at(-1)) throw Object.assign(new Error('代理检测未通过，请核对代理账号、密码、套餐余额或稍后重试。'), { reason: 'proxy_unavailable' });
    }
  }
}
