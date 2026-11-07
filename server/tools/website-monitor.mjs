import { Resolver } from 'node:dns/promises';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { parseToolPublicOrigin, toolRequestOrigin } from './request-origin.mjs';

const maxUrlLength = 2048;
const maxBodyBytes = 4096;
const maxRedirects = 5;
const dnsTimeoutMs = 3000;
const requestTimeoutMs = 10_000;
const totalTimeoutMs = 15_000;
const slowResponseMs = 3000;
const certificateWarningMs = 14 * 86_400_000;
const rateWindowMs = 60_000;
const maxChecksPerUser = 20;
const maxActiveChecks = 8;
const maxRateUsers = 5000;
const blockedHostSuffix = /\.(?:home|internal|invalid|lan|local|localhost|test)$/i;
const redirectStatusCodes = new Set([301, 302, 303, 307, 308]);

const blockedAddresses = new BlockList();
for (const [network, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3]
]) blockedAddresses.addSubnet(network, bits, 'ipv4');
for (const [network, bits] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]
]) blockedAddresses.addSubnet(network, bits, 'ipv6');
const globalUnicast = new BlockList();
globalUnicast.addSubnet('2000::', 3, 'ipv6');

class MonitorError extends Error {
  constructor(httpStatus, message) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

const blockedTarget = () => new MonitorError(400, '网站监控只允许检测公开网站');
const networkError = (code) => Object.assign(new Error(code), { code });

function isPublicAddress(address, family) {
  if (typeof address !== 'string' || isIP(address) !== family || address.includes('%')) return false;
  if (family === 4) return !blockedAddresses.check(address, 'ipv4');
  return (
    family === 6 && globalUnicast.check(address, 'ipv6') && !blockedAddresses.check(address, 'ipv6')
  );
}

function normalizedHostname(target) {
  return target.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function normalizeTarget(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MonitorError(400, '请输入要检测的网站地址');
  }
  const candidate = value.trim();
  if (candidate.length > maxUrlLength) throw new MonitorError(400, '网站地址过长，请检查后重试');
  let target;
  try {
    target = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
  } catch {
    throw new MonitorError(400, '网站地址格式不正确');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new MonitorError(400, '网站监控只支持 HTTP 或 HTTPS 地址');
  }
  if (target.username || target.password) {
    throw new MonitorError(400, '网站地址不能包含账号或密码');
  }
  const hostname = normalizedHostname(target);
  const family = isIP(hostname);
  const publicHost = family
    ? isPublicAddress(hostname, family)
    : hostname.includes('.') && !blockedHostSuffix.test(hostname);
  if (!publicHost) {
    throw blockedTarget();
  }
  target.hash = '';
  if (target.href.length > maxUrlLength) throw new MonitorError(400, '网站地址过长，请检查后重试');
  return target;
}

async function resolveDns(hostname, timeoutMs) {
  const resolver = new Resolver();
  const timer = setTimeout(() => resolver.cancel(), timeoutMs);
  try {
    const answers = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    return answers.flatMap((result, index) => {
      if (result.status === 'fulfilled') {
        const family = index === 0 ? 4 : 6;
        return result.value.map((address) => ({ address, family }));
      }
      if (['ENODATA', 'ENOTFOUND'].includes(result.reason?.code)) return [];
      if (result.reason?.code === 'ECANCELLED') throw networkError('EDNSTIMEOUT');
      throw networkError('EDNS');
    });
  } finally {
    clearTimeout(timer);
  }
}

async function resolveTarget(target, resolve, timeoutMs) {
  const hostname = normalizedHostname(target);
  const family = isIP(hostname);
  if (family) return { address: hostname, family };
  const records = await resolve(hostname, timeoutMs);
  if (!records.length) throw networkError('EDNS');
  if (records.some((entry) => !isPublicAddress(entry.address, entry.family))) throw blockedTarget();
  return records.find((entry) => entry.family === 4) ?? records[0];
}

function requestTarget(options, callback) {
  return (options.protocol === 'https:' ? requestHttps : requestHttp)(options, callback);
}

function probeResponse(target, endpoint, requestImpl, timeoutMs) {
  const secure = target.protocol === 'https:';
  const hostname = normalizedHostname(target);
  const options = {
    protocol: target.protocol,
    agent: false,
    // 固定已核验的 IP，原主机名仅用于 HTTP Host 和 TLS 验证。
    hostname: endpoint.address,
    family: endpoint.family,
    port: target.port || undefined,
    path: target.pathname + target.search,
    method: 'GET',
    maxHeaderSize: 32 * 1024,
    headers: {
      Host: target.host,
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      Connection: 'close',
      'User-Agent': 'ID-Business-Website-Monitor/1.0'
    },
    ...(secure && {
      rejectUnauthorized: true,
      servername: isIP(hostname) ? '' : hostname,
      checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate)
    })
  };
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    }
    const request = requestImpl(options, (response) => {
      const certificate = secure && response.socket?.getPeerCertificate?.();
      const expiresAt = Date.parse(certificate?.valid_to || '');
      const location = response.headers.location;
      response.destroy();
      finish(null, {
        statusCode: response.statusCode,
        location: typeof location === 'string' && location.length <= maxUrlLength ? location : '',
        expiring: Number.isFinite(expiresAt) && expiresAt - Date.now() <= certificateWarningMs
      });
    });
    request.once('error', (error) => finish(error));
    timer = setTimeout(() => {
      finish(networkError('ETIMEDOUT'));
      request.destroy();
    }, timeoutMs);
    request.end();
  });
}

function failureCategory(error) {
  const code = String(error?.code || '');
  if (code === 'EDNS' || code === 'EDNSTIMEOUT') return 'dns';
  if (code === 'ETIMEDOUT') return 'timeout';
  if (/CERT|TLS|SSL|SIGNATURE|ISSUER|EPROTO/.test(code)) return 'tls';
  return 'connection';
}

const displayUrl = (target) => target.origin + target.pathname;

async function checkTarget(requested, resolve, requestImpl) {
  const startedAt = performance.now();
  const visited = new Set();
  const hops = [];
  let target = requested;
  const elapsed = (start) => Math.max(0, Math.round(performance.now() - start));
  const remaining = () => Math.floor(totalTimeoutMs - (performance.now() - startedAt));
  function result(status, tls, failure, statusCode = null, warnings = []) {
    return {
      status,
      requestedUrl: displayUrl(requested),
      effectiveUrl: displayUrl(target),
      statusCode,
      latencyMs: elapsed(startedAt),
      tls,
      hops,
      failure,
      warnings
    };
  }
  function failed(category) {
    if (category === 'tls') return result('tls_error', 'invalid', category);
    const tls = target.protocol === 'http:' ? 'not_applicable' : 'unknown';
    return result('unreachable', tls, category);
  }
  for (let index = 0; index <= maxRedirects; index++) {
    if (visited.has(target.href)) return failed('redirect');
    visited.add(target.href);
    const hopStart = performance.now();
    let response;
    try {
      const dnsBudget = Math.min(remaining(), dnsTimeoutMs);
      if (dnsBudget <= 0) return failed('timeout');
      const endpoint = await resolveTarget(target, resolve, dnsBudget);
      const requestBudget = Math.min(remaining(), requestTimeoutMs);
      if (requestBudget <= 0) return failed('timeout');
      response = await probeResponse(target, endpoint, requestImpl, requestBudget);
    } catch (error) {
      if (error instanceof MonitorError) {
        if (index === 0) throw error;
        return failed('blocked_target');
      }
      return failed(failureCategory(error));
    }
    const { statusCode, location, expiring } = response;
    if (!Number.isInteger(statusCode)) return failed('connection');
    hops.push({ url: displayUrl(target), statusCode, latencyMs: elapsed(hopStart) });
    if (redirectStatusCodes.has(statusCode) && location) {
      if (index === maxRedirects) return failed('redirect');
      let redirected;
      try {
        redirected = new URL(location, target);
      } catch {
        return failed('redirect');
      }
      try {
        target = normalizeTarget(redirected.href);
      } catch {
        return failed('blocked_target');
      }
      continue;
    }
    const secure = target.protocol === 'https:';
    const warnings = [];
    if (!secure) warnings.push('insecure_http');
    if (expiring) warnings.push('certificate_expiring');
    if (elapsed(startedAt) >= slowResponseMs) warnings.push('slow');
    if (redirectStatusCodes.has(statusCode)) warnings.push('redirect_without_location');
    return result(
      statusCode >= 400 ? 'http_error' : 'reachable',
      secure ? 'valid' : 'not_applicable',
      null,
      statusCode,
      warnings
    );
  }
  return failed('redirect');
}

function json(response, status, body) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(body));
}

async function readUrl(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    throw new MonitorError(415, '请提交 JSON 资料');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      request.resume();
      throw new MonitorError(413, '检测请求超过大小限制');
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new MonitorError(400, '无法读取 JSON 资料');
  }
  return normalizeTarget(body?.url);
}

export function createWebsiteMonitor({ publicOrigin, resolve = resolveDns, request = requestTarget } = {}) {
  const publicUrl = parseToolPublicOrigin(publicOrigin);
  const checksByUser = new Map();
  const activeUsers = new Set();
  let lastSweep = 0;
  function reserve(userId) {
    const now = Date.now();
    const cutoff = now - rateWindowMs;
    if (now - lastSweep >= rateWindowMs || checksByUser.size >= maxRateUsers) {
      for (const [key, times] of checksByUser) {
        if (times.at(-1) <= cutoff) checksByUser.delete(key);
      }
      lastSweep = now;
    }
    if (activeUsers.has(userId) || activeUsers.size >= maxActiveChecks) {
      throw new MonitorError(429, '正在进行网站检测，请稍后重试');
    }
    const recent = (checksByUser.get(userId) || []).filter((time) => time > cutoff);
    if (
      recent.length >= maxChecksPerUser ||
      (!checksByUser.has(userId) && checksByUser.size >= maxRateUsers)
    ) {
      throw new MonitorError(429, '检测次数过多，请稍后重试');
    }
    checksByUser.set(userId, [...recent, now]);
    activeUsers.add(userId);
  }
  return async function handleWebsiteMonitor(requestMessage, response, actor) {
    try {
      if (!actor?.id) throw new MonitorError(401, '请先登录');
      const { host, origin, 'sec-fetch-site': fetchSite } = requestMessage.headers;
      const expectedOrigin = toolRequestOrigin(requestMessage.headers, publicUrl);
      if (
        (!publicUrl && !/^(?:127\.0\.0\.1|localhost):[0-9]{1,5}$/.test(host || '')) ||
        !expectedOrigin || origin !== expectedOrigin ||
        (fetchSite && fetchSite !== 'same-origin')
      ) {
        throw new MonitorError(403, publicUrl ? '仅允许从本站页面检测网站' : '仅允许从本机页面检测网站');
      }
      if (requestMessage.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        throw new MonitorError(405, '网站监控只支持 POST 请求');
      }
      const target = await readUrl(requestMessage);
      reserve(actor.id);
      try {
        return json(response, 200, await checkTarget(target, resolve, request));
      } finally {
        activeUsers.delete(actor.id);
      }
    } catch (error) {
      if (error instanceof MonitorError) {
        return json(response, error.httpStatus, { error: error.message });
      }
      return json(response, 500, { error: '网站检测未完成，请重试' });
    }
  };
}

export const handleWebsiteMonitor = createWebsiteMonitor();

// Shared public-network validation; consumers must pin the returned address.
export { normalizeTarget, resolveDns, resolveTarget, requestTarget };
