'use strict';

const { isPublic } = require('./proxy-connection.cjs');
const { createRequire } = require('node:module');
const upstreamRequire = createRequire(require.resolve('./upstream/package.json'));

const PROBE_URLS = ['https://api.ipify.org/?format=text', 'https://ifconfig.me/ip'];
const ERROR_MESSAGES = Object.freeze({
  invalid_exit_ip: '探测服务未返回有效公网 IP',
  proxy_auth_failed: '代理认证失败，请检查账号和密码',
  connection_timeout: '代理连接超时',
  connection_refused: '代理连接被拒绝',
  extraction_failed: '代理提取失败或响应无效',
  network_error: '代理网络连接失败',
  unsupported_protocol: '代理地址或协议无效',
  proxy_unavailable: '所选代理不可用或已停用',
  probe_http_error: '出口探测服务响应异常',
  proxy_dns_failed: '代理域名解析失败',
  proxy_tls_failed: '代理安全连接失败',
  execution_failed: '检测执行未完成，请重试',
  result_write_failed: '检测已执行，但结果回写未能确认，请重试',
  completion_ack_failed: '检测结束回执未能确认，请刷新核对检测结果'
});
const ERROR_PRIORITY = {
  proxy_auth_failed: 100,
  connection_refused: 80,
  proxy_dns_failed: 70,
  proxy_tls_failed: 60,
  connection_timeout: 50,
  invalid_exit_ip: 40,
  probe_http_error: 30,
  network_error: 20
};

function failure(errorCode, latencyMs = null) {
  const code = Object.hasOwn(ERROR_MESSAGES, errorCode) ? errorCode : 'execution_failed';
  return { ok: false, ip: null, errorCode: code, error: ERROR_MESSAGES[code], latencyMs };
}

function errorCode(error) {
  if (Object.hasOwn(ERROR_MESSAGES, error?.code)) return error.code;
  if (
    error?.response?.status === 407 ||
    /(?:\b407\b|(?:socks|proxy).*auth|authentication failed)/i.test(String(error?.message || ''))
  )
    return 'proxy_auth_failed';
  if (['ETIMEDOUT', 'ECONNABORTED', 'ERR_CANCELED'].includes(error?.code))
    return 'connection_timeout';
  if (error?.code === 'ECONNREFUSED') return 'connection_refused';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(error?.code)) return 'proxy_dns_failed';
  if (/CERT|TLS|SSL/.test(String(error?.code || ''))) return 'proxy_tls_failed';
  return 'network_error';
}

function exitIp(response) {
  const contentType = String(response?.headers?.['content-type'] || '').toLowerCase();
  if (response?.status !== 200 || /(?:html|xhtml)/.test(contentType)) return null;
  if (typeof response.data !== 'string') return null;
  const ip = response.data.trim();
  return ip.length <= 45 && isPublic(ip) ? ip : null;
}

async function testProxyUrl(raw, options = {}) {
  const now = options.now || Date.now;
  const startedAt = now();
  let proxy;
  try {
    proxy = new URL(raw);
    if (!['http:', 'https:', 'socks5:'].includes(proxy.protocol) || !proxy.hostname)
      return failure('unsupported_protocol');
  } catch {
    return failure('unsupported_protocol');
  }
  let agent;
  try {
    const createAgent =
      options.createAgent ||
      ((proxyUrl) => {
        const { ProxyAgent } = upstreamRequire('proxy-agent');
        return new ProxyAgent({ getProxyForUrl: () => proxyUrl });
      });
    agent = createAgent(proxy.href);
  } catch {
    return failure('unsupported_protocol');
  }
  const request = options.request || upstreamRequire('axios').get;
  const timeout = Math.min(12000, Math.max(3000, Number(options.timeoutMs) || 12000));
  let lastCode = 'network_error';
  try {
    for (const probeUrl of PROBE_URLS) {
      try {
        const response = await request(probeUrl, {
          httpsAgent: agent,
          httpAgent: agent,
          proxy: false,
          timeout,
          responseType: 'text',
          transformResponse: [(value) => value],
          maxRedirects: 0,
          maxContentLength: 1024,
          maxBodyLength: 1024,
          headers: { Accept: 'text/plain' },
          validateStatus: () => true
        });
        const ip = exitIp(response);
        if (ip) return { ok: true, ip, latencyMs: Math.max(0, now() - startedAt) };
        const code = [401, 407].includes(response?.status)
          ? 'proxy_auth_failed'
          : response?.status === 200
            ? 'invalid_exit_ip'
            : 'probe_http_error';
        if ((ERROR_PRIORITY[code] || 0) >= (ERROR_PRIORITY[lastCode] || 0)) lastCode = code;
      } catch (error) {
        const code = errorCode(error);
        if ((ERROR_PRIORITY[code] || 0) >= (ERROR_PRIORITY[lastCode] || 0)) lastCode = code;
      }
    }
    return failure(lastCode, Math.max(0, now() - startedAt));
  } finally {
    agent?.destroy?.();
  }
}

function selectedIds(task) {
  const payload = task.payload || {};
  const ids = Array.isArray(payload.ids) ? payload.ids : [payload.proxyId];
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))].slice(0, 50);
}

function taskFailure(task, error) {
  const code = Object.hasOwn(ERROR_MESSAGES, error?.code) ? error.code : 'execution_failed';
  const observed = Array.isArray(error?.proxyResults) ? error.proxyResults : [];
  return {
    success: false,
    results: selectedIds(task).map(
      (proxyId) =>
        observed.find((result) => result.proxyId === proxyId) || { proxyId, ...failure(code) }
    ),
    ...failure(code)
  };
}

function completionFailure(task, result) {
  return taskFailure(task, {
    code: result ? 'completion_ack_failed' : 'execution_failed',
    proxyResults: result?.results
  });
}

module.exports = {
  PROBE_URLS,
  testProxyUrl,
  exitIp,
  failure,
  errorCode,
  selectedIds,
  taskFailure,
  completionFailure
};
