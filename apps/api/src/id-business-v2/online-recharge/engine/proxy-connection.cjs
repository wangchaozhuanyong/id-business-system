'use strict';
const { randomUUID } = require('node:crypto');
const { lookup } = require('node:dns');
const { BlockList, isIP } = require('node:net');
const https = require('node:https');
const { rememberSecrets } = require('./security.cjs');
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
])
  blocked.addSubnet(address, prefix, 'ipv4');
function isPublic(address) {
  if (isIP(address) === 4) return !blocked.check(address, 'ipv4');
  return isIP(address) === 6 && /^[23]/i.test(address) && !/^2001:db8:/i.test(address);
}
function hostName(host) {
  const value = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !value ||
    value === 'localhost' ||
    /\.(?:localhost|local)$/.test(value) ||
    (isIP(value) && !isPublic(value))
  )
    throw new Error('代理必须指向公网服务');
  return value;
}
function endpoint(raw, protocol) {
  const value = new URL(raw);
  hostName(value.hostname);
  if (
    !['http:', 'https:', 'socks5:'].includes(value.protocol) ||
    value.protocol !== `${protocol}:` ||
    !['', '/'].includes(value.pathname) ||
    value.search ||
    value.hash ||
    Boolean(value.username) !== Boolean(value.password)
  )
    throw new Error('代理地址格式无效');
  if (value.protocol === 'socks5:' && !value.port) throw new Error('代理端口无效');
  return raw;
}
function publicLookup(host, options, callback) {
  lookup(host, { all: true, verbatim: true }, (error, addresses) => {
    if (error || !addresses?.length || addresses.some((row) => !isPublic(row.address)))
      return callback(new Error('代理提取服务不可用'));
    if (options?.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}
function fetchExtraction(raw) {
  return new Promise((resolve, reject) => {
    const url = new URL(raw);
    hostName(url.hostname);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      return reject(new Error('提取链接格式无效'));
    const request = https.get(
      url,
      { lookup: publicLookup, agent: false, headers: { Accept: 'application/json, text/plain' } },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          return reject(new Error('代理提取失败'));
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 2048) {
            response.destroy();
            reject(new Error('代理提取响应过大'));
          } else chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.on('error', () => reject(new Error('代理提取失败')));
      }
    );
    // A total deadline also bounds DNS and a peer that drips response bytes.
    const timer = setTimeout(() => {
      request.destroy();
      reject(new Error('代理提取超时'));
    }, 12000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', () => {
      clearTimeout(timer);
      reject(new Error('代理提取失败'));
    });
  });
}
function parseExtracted(raw, protocol) {
  let value = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    /* Plain provider response. */
  }
  if (value && typeof value === 'object' && value.data !== undefined) value = value.data;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const host = value.host || value.ip;
    const port = Number(value.port);
    const username = value.username || value.user || '';
    const password = value.password || value.pass || '';
    if (
      typeof host !== 'string' ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      /[\s/@?#]/.test(host)
    )
      throw new Error('代理提取响应无效');
    value = `${protocol}://${username || password ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : ''}${host.includes(':') ? `[${host}]` : host}:${port}`;
  }
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value.trim()))
    throw new Error('代理提取响应无效');
  value = value.trim();
  if (!value.includes('://') && value.split(':').length === 4) {
    const [host, port, username, password] = value.split(':');
    value = `${protocol}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
  }
  if (!/:\d+\/?$/.test(value)) throw new Error('代理提取响应缺少端口');
  return endpoint(value.includes('://') ? value : `${protocol}://${value}`, protocol);
}
async function resolveProxy(connection, fetcher = fetchExtraction) {
  if (typeof connection === 'string')
    connection = {
      proxy_url: connection,
      connectionMode: 'direct',
      protocol: new URL(connection).protocol.slice(0, -1)
    };
  if (!connection?.proxy_url) throw new Error('共用代理池没有可用代理');
  rememberSecrets(connection);
  connection = {
    connectionMode: 'direct',
    protocol: new URL(connection.proxy_url).protocol.slice(0, -1),
    ...connection
  };
  const raw = connection.proxy_url.replace(/\{session\}/gi, randomUUID().replaceAll('-', ''));
  try {
    const resolved =
      connection.connectionMode === 'extraction'
        ? parseExtracted(await fetcher(raw), connection.protocol)
        : endpoint(raw, connection.protocol);
    rememberSecrets(resolved, 'proxy');
    return resolved;
  } catch {
    throw new Error(
      connection.connectionMode === 'extraction' ? '代理提取失败或响应无效' : '代理地址无效'
    );
  }
}
module.exports = { resolveProxy, parseExtracted, isPublic };
