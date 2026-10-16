'use strict';
const { randomBytes } = require('node:crypto');
const { rememberSecrets } = require('./security.cjs');

function directProxy(value) {
  let raw = String(value || '').trim();
  if (!raw.includes('://')) {
    const match = /^([^:/\s]+):(\d{1,5}):([^:\r\n]+):([^\r\n]+)$/.exec(raw);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535)
      throw new Error('提取结果不是有效的直连代理');
    raw = `http://${encodeURIComponent(match[3])}:${encodeURIComponent(match[4])}@${match[1]}:${match[2]}`;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('提取结果不是有效的直连代理');
  }
  if (
    !['http:', 'https:', 'socks5:'].includes(url.protocol) ||
    !/^(?:[a-z0-9._-]+|\[[a-f0-9:]+\])$/i.test(url.hostname) ||
    (url.pathname && url.pathname !== '/') ||
    url.search ||
    url.hash
  )
    throw new Error('提取结果不是有效的直连代理');
  rememberSecrets(raw, 'proxy');
  rememberSecrets(decodeURIComponent(url.username), 'secret');
  rememberSecrets(decodeURIComponent(url.password), 'password');
  return raw;
}

function extractedValue(value, depth = 0) {
  if (depth > 4) throw new Error('动态代理提取响应格式无效');
  if (typeof value === 'string') {
    const raw = value.trim();
    if (['"', '[', '{'].includes(raw[0])) {
      try {
        return extractedValue(JSON.parse(raw), depth + 1);
      } catch {
        throw new Error('动态代理提取响应格式无效');
      }
    }
    try {
      return directProxy(raw);
    } catch {
      /* A JSON wrapper may contain the endpoint. */
    }
    try {
      return extractedValue(JSON.parse(raw), depth + 1);
    } catch {
      throw new Error('动态代理提取响应格式无效');
    }
  }
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new Error('动态代理提取须返回一个连接端点');
    return extractedValue(value[0], depth + 1);
  }
  if (value && typeof value === 'object') {
    const host = value.ip ?? value.host;
    const user = value.username ?? value.user;
    const password = value.password ?? value.pwd;
    if (host && value.port && user && password)
      return directProxy(`${host}:${value.port}:${user}:${password}`);
    for (const key of ['data', 'proxy', 'proxy_url', 'list'])
      if (value[key] != null) return extractedValue(value[key], depth + 1);
  }
  throw new Error('动态代理提取响应格式无效');
}

async function resolveProxy(proxy, options = {}) {
  const raw = typeof proxy === 'string' ? proxy : proxy?.proxy_url;
  if (!raw) return null;
  rememberSecrets(raw, 'proxy');
  let url;
  try {
    url = new URL(raw);
  } catch {
    return directProxy(raw);
  }
  const extraction = proxy?.protocol === 'extraction' || url.hostname === 'api.ipdeep.com';
  if (!extraction) return directProxy(raw.replace(/\{session\}/gi, randomBytes(8).toString('hex')));
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'api.ipdeep.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== '/api/Pro/DynamicIp/GetIpByGenerateLink' ||
    !url.searchParams.get('id')
  )
    throw new Error('动态代理提取地址无效');
  try {
    const response = await (options.fetch || fetch)(url.href, {
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { accept: 'application/json, text/plain' }
    });
    if (!response.ok || !response.body) throw new Error();
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 16384) throw new Error();
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return extractedValue(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('动态代理提取失败，请检查供应商链接或提取额度');
  }
}

module.exports = { directProxy, extractedValue, resolveProxy };
