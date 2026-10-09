'use strict';
const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const values = new Map();
const owners = new Map();
const TTL = 30 * 60 * 1000;
const cardId = (v) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
function forget(ids) {
  for (const id of ids) {
    const entry = values.get(id);
    if (entry) entry.cvc = '';
    values.delete(id);
    owners.delete(id);
  }
}
function cleanup() {
  const now = Date.now();
  forget([...values].filter(([, v]) => v.expires <= now).map(([id]) => id));
}
function take(id, taskId) {
  cleanup();
  const value = values.get(id),
    owner = owners.get(id);
  if (!value || (owner && owner !== taskId)) return '';
  owners.set(id, taskId);
  return value.cvc;
}
function forgetTask(taskId) {
  forget([...owners].filter(([, owner]) => owner === taskId).map(([id]) => id));
}
function matches(value, expected) {
  if (typeof value !== 'string' || !expected || expected.length < 32) return false;
  const a = Buffer.from(value),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function start(options = {}) {
  const target = new URL(
    options.url || process.env.ONLINE_RECHARGE_CREDENTIALS_URL || 'http://127.0.0.1:8053'
  );
  if (
    target.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname) ||
    target.username ||
    target.password
  )
    throw new Error('临时凭据服务只能监听本机私网地址');
  const key = options.key || process.env.ONLINE_RECHARGE_WORKER_KEY;
  if (!key || key.length < 32) throw new Error('临时凭据服务缺少内部认证配置');
  const server = http.createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'POST' || !matches(req.headers['x-online-recharge-worker'], key))
      return reply(401, { error: '内部凭证无效' });
    const pathname = (req.url || '').split('?')[0];
    if (
      !['/credentials', '/credentials/status', '/credentials/forget', '/health'].includes(pathname)
    )
      return reply(404, { error: '接口不存在' });
    if (pathname === '/health') {
      const state = options.health
        ? options.health()
        : { ready: true, mode: 'credentials-only', activeTasks: 0, stopping: false };
      return reply(state.ready ? 200 : 503, { ok: Boolean(state.ready), ...state });
    }
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 128 * 1024) return reply(413, { error: '输入过大' });
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      cleanup();
      if (pathname === '/credentials') {
        if (
          !Array.isArray(body.cards) ||
          body.cards.length > 1000 ||
          body.cards.some((c) => !cardId(c.id) || !/^\d{3,4}$/.test(c.cvc))
        )
          return reply(400, { error: '临时安全码格式无效' });
        if (body.cards.some((c) => owners.has(c.id)))
          return reply(409, { error: '资料正在执行中，不能替换本次凭据' });
        for (const c of body.cards) {
          values.set(c.id, { cvc: c.cvc, expires: Date.now() + TTL });
          c.cvc = '';
        }
        return reply(200, { ok: true, expiresInSeconds: TTL / 1000 });
      }
      if (!Array.isArray(body.ids) || body.ids.length > 1000 || body.ids.some((id) => !cardId(id)))
        return reply(400, { error: '资料标识无效' });
      if (pathname === '/credentials/forget') {
        forget(body.ids);
        return reply(200, { ok: true });
      }
      return reply(200, { availableIds: body.ids.filter((id) => values.has(id)) });
    } catch {
      return reply(400, { error: '输入无效' });
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(target.port || 8053), target.hostname.replace(/^\[|\]$/g, ''), resolve);
  });
  const timer = setInterval(cleanup, 30000);
  timer.unref();
  return {
    server,
    close: async () => {
      clearInterval(timer);
      forget([...values.keys()]);
      server.closeIdleConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
module.exports = { start, take, forget, forgetTask, cleanup, matches };
