import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { normalizeTarget, resolveDns, resolveTarget, requestTarget } from './tools/website-monitor.mjs';
import { parseToolPublicOrigin, toolRequestOrigin } from './tools/request-origin.mjs';
import { parseBitBrowserProxyInput } from '../modules/recharge/bitbrowser/proxy-input.mjs';
import { parseBitBrowserProxyExtraction } from '../modules/recharge/bitbrowser/proxy-extraction.mjs';

const failure = (status, message) => Object.assign(new Error(message), { status, reason: 'extraction' });
const json = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
};
function readExtraction(target, endpoint, request, signal) {
  const hostname = target.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return new Promise((resolve, reject) => {
    let incoming, timer, outgoing, settled = false;
    const finish = (error, text) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal.removeEventListener('abort', cancel);
      if (error) { incoming?.destroy(); outgoing?.destroy(); reject(error); } else resolve(text);
    };
    const cancel = () => finish(failure(408, '提取检测已取消。'));
    signal.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => finish(failure(504, '提取接口响应超时，未完成检测；可稍后重试。')), 8000);
    outgoing = request({
      protocol: target.protocol, agent: false, hostname: endpoint.address, family: endpoint.family,
      port: target.port || undefined, path: target.pathname + target.search, method: 'GET', maxHeaderSize: 16 * 1024,
      headers: { Host: target.host, Accept: 'application/json, text/plain', 'Accept-Encoding': 'identity', Connection: 'close' },
      ...(target.protocol === 'https:' && { rejectUnauthorized: true, servername: isIP(hostname) ? '' : hostname,
        checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate) })
    }, response => {
      incoming = response;
      const status = response.statusCode;
      if (status >= 300 && status < 400) return finish(failure(422, '提取接口要求跳转，未完成检测；请使用供应商提供的最终提取链接。'));
      if (!Number.isInteger(status) || status < 200 || status >= 300)
        return finish(failure(422, `提取接口返回 HTTP ${Number.isInteger(status) ? status : '异常'}，未完成检测；请核对链接及提取权限。`));
      let bytes = 0; const chunks = [];
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 8192) return finish(failure(422, '提取结果过大，未完成检测；请将提取数量设为 1。'));
        chunks.push(chunk);
      });
      response.once('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
      response.once('error', () => finish(failure(502, '提取连接中断，未完成检测；请稍后重试。')));
      response.once('aborted', () => finish(failure(502, '提取连接中断，未完成检测；请稍后重试。')));
    });
    outgoing.once('error', () => finish(failure(502, '无法连接提取接口，未完成检测；请核对链接及服务状态。')));
    if (signal.aborted) cancel(); else outgoing.end();
  });
}
export function createBitBrowserProxyExtraction({ publicOrigin, resolve = resolveDns, request = requestTarget } = {}) {
  const publicUrl = parseToolPublicOrigin(publicOrigin), active = new Set(), recent = new Map();
  return async (req, res, actor) => {
    let reserved = false;
    const controller = new AbortController(), disconnected = () => controller.abort();
    res.once('close', disconnected);
    try {
      if (!actor?.id) throw failure(401, '请先登录。');
      if (!['admin', 'super'].includes(actor.role)) throw failure(403, '没有管理比特代理的权限。');
      const expected = toolRequestOrigin(req.headers, publicUrl);
      if (!expected || req.headers.origin !== expected || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') ||
        (!publicUrl && !/^(?:127\.0\.0\.1|localhost):\d{1,5}$/.test(req.headers.host || '')))
        throw failure(403, '仅允许从本站页面检测代理。');
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw failure(405, '代理提取检测只支持 POST。'); }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw failure(415, '请提交 JSON 资料。');
      let size = 0; const chunks = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length; if (size > 4096) { req.resume(); throw failure(413, '代理检测请求过大。'); } chunks.push(chunk);
      }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure(400, '无法读取代理检测资料。'); }
      let parsed, target;
      try { parsed = parseBitBrowserProxyInput(body?.link, { mode: 'dynamic', protocol: body?.protocol || 'auto' }); target = normalizeTarget(parsed.link); }
      catch { throw failure(400, '请输入公开的 HTTP／HTTPS 提取链接。'); }
      const now = Date.now();
      for (const [id, times] of recent) if (times.at(-1) < now - 60000) recent.delete(id);
      const times = (recent.get(actor.id) || []).filter(time => time > now - 60000);
      if (active.has(actor.id) || active.size >= 8 || times.length >= 20 || (!recent.has(actor.id) && recent.size >= 5000))
        throw failure(429, '代理提取检测繁忙或过于频繁，请稍后重试。');
      recent.set(actor.id, [...times, now]); active.add(actor.id); reserved = true;
      let endpoint;
      try { endpoint = await resolveTarget(target, resolve, 3000); }
      catch { throw failure(422, '提取地址无法解析或不是公开地址，未完成检测。'); }
      controller.signal.throwIfAborted();
      const text = await readExtraction(target, endpoint, request, controller.signal);
      const result = parseBitBrowserProxyExtraction(text, { protocol: parsed.automaticProtocol ? 'auto' : parsed.protocol });
      return json(res, 200, { link: result.link, automaticProtocol: result.automaticProtocol });
    } catch (error) {
      if (!res.destroyed) return json(res, error.status || (error.reason === 'extraction' ? 422 : 502), {
        error: error.reason === 'extraction' ? error.message : '提取检测未完成，请稍后重试。', reason: 'extraction'
      });
    } finally { if (reserved) active.delete(actor.id); res.removeListener('close', disconnected); }
  };
}
