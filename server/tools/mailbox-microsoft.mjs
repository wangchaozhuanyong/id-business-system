import { createHash, randomBytes } from 'node:crypto';

import { readMailboxImap } from './mailbox-pool.mjs';
import { parseToolPublicOrigin, toolRequestOrigin } from './request-origin.mjs';

export const microsoftMailboxPrefix = '/api/local/tools/mailbox-microsoft/';
export const legacyMicrosoftMailboxCallback = '/api/public/mailbox/microsoft-oauth/callback';
const endpoint = 'https://login.microsoftonline.com/common/oauth2/v2.0/';
const scope = 'offline_access openid email https://outlook.office.com/IMAP.AccessAsUser.All';
const statePattern = /^[A-Za-z0-9_-]{43}$/;
const tokenValid = (value) => typeof value === 'string' && value.length > 0 && value.length <= 8192;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
  res.end(JSON.stringify(body));
}

function callbackPage(res, complete) {
  res.writeHead(complete ? 200 : 400, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  });
  res.end(complete
    ? '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><h1>Microsoft 授权已验证</h1><p>可关闭此窗口，回到工具箱保存邮箱。</p></html>'
    : '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><h1>Microsoft 邮箱授权未完成</h1><p>请回到工具箱检查邮箱账号、授权配置和 IMAP 设置后重试。</p></html>');
}

async function inputJson(req) {
  const parts = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.byteLength;
    if (size > 4096) {
      req.resume();
      throw new Error('request too large');
    }
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

export function createMicrosoftMailbox({
  config, store, publicOrigin, fetchImpl = fetch, readImap = readMailboxImap, clock = Date.now
}) {
  const publicUrl = parseToolPublicOrigin(publicOrigin);
  const callback = typeof config?.redirectUri === 'string' ? URL.parse(config.redirectUri) : null;
  const localCallback = microsoftMailboxPrefix + 'callback';
  if (config) {
    const originAllowed = callback && (publicUrl
      ? callback.origin === publicUrl.origin
      : callback.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(callback.hostname) && callback.port);
    const paths = publicUrl ? [localCallback, legacyMicrosoftMailboxCallback] : [localCallback];
    if (!originAllowed || !paths.includes(callback.pathname) || callback.username || callback.password ||
        callback.search || callback.hash ||
        typeof config.clientId !== 'string' || !/^[a-f\d-]{36}$/i.test(config.clientId) || !tokenValid(config.clientSecret))
      throw new Error('Microsoft 邮箱授权配置无效');
  }
  const states = new Map();

  async function exchange(params, previousRefreshToken) {
    if (!config) throw new Error('Microsoft provider not configured');
    const body = new URLSearchParams({
      client_id: config.clientId, client_secret: config.clientSecret,
      redirect_uri: config.redirectUri, scope, ...params
    });
    const res = await fetchImpl(endpoint + 'token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
    });
    if (!res.ok || !res.body) throw new Error('Microsoft token request failed');
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > 64 * 1024) throw new Error('Microsoft token response too large');
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const refreshToken = payload.refresh_token || previousRefreshToken;
    if (!tokenValid(payload.access_token) || !tokenValid(refreshToken)) throw new Error('Microsoft token response invalid');
    return { accessToken: payload.access_token, refreshToken };
  }

  async function readMailbox(item) {
    const fields = { provider: item.provider, email: item.email, limit: item.limit,
      ...(item.storefront && { storefront: true }) };
    if (item.provider !== 'microsoft') return readImap({
      ...fields, appPassword: item.appPassword
    });
    const tokens = await exchange({ grant_type: 'refresh_token', refresh_token: item.refreshToken }, item.refreshToken);
    const rows = await readImap({ ...fields, accessToken: tokens.accessToken });
    return { rows, refreshToken: tokens.refreshToken };
  }

  async function handle(req, res, operation, actor) {
    const origin = toolRequestOrigin(req.headers, publicUrl);
    if (operation === 'callback') {
      const requestUrl = origin && URL.parse(req.url, origin);
      if (req.method !== 'GET' || !callback || origin !== callback.origin ||
          requestUrl?.origin !== origin || requestUrl.pathname !== callback.pathname)
        return callbackPage(res, false);
      const stateId = requestUrl.searchParams.get('state');
      const state = stateId && states.get(stateId);
      if (!state || state.status !== 'pending' || state.expiresAt <= clock())
        return callbackPage(res, false);
      const code = requestUrl.searchParams.get('code');
      state.status = 'verifying';
      try {
        if (!tokenValid(code) || requestUrl.searchParams.has('error')) throw new Error();
        const { accessToken, refreshToken } = await exchange({
          grant_type: 'authorization_code', code, code_verifier: state.verifier
        });
        await readImap({ provider: 'microsoft', email: state.email, accessToken });
        if (state.expiresAt <= clock() || states.get(stateId) !== state) throw new Error();
        state.refreshToken = refreshToken;
        state.status = 'verified';
        return callbackPage(res, true);
      } catch {
        state.status = 'failed';
        return callbackPage(res, false);
      } finally {
        state.verifier = null;
      }
    }
    if (!config || origin !== callback.origin)
      return json(res, 503, { error: '独立新版尚未配置当前地址的 Microsoft 邮箱授权' });
    if (req.method !== 'POST' || !['start', 'finish'].includes(operation))
      return json(res, 405, { error: '没有此授权操作' });
    if (req.headers.origin !== origin ||
        (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin'))
      return json(res, 403, { error: '请求来源未通过校验' });
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))
      return json(res, 415, { error: '请提交 JSON 请求' });
    let input;
    try {
      input = await inputJson(req);
    } catch {
      return json(res, 400, { error: '授权请求格式无效' });
    }
    for (const [key, state] of states) if (state.expiresAt <= clock()) states.delete(key);
    if (operation === 'finish') {
      const id = input?.authorizationId;
      const state = typeof id === 'string' && statePattern.test(id) && states.get(id);
      if (!state || state.actorId !== actor.id) return json(res, 404, { error: '授权记录已失效' });
      if (['pending', 'verifying'].includes(state.status)) return json(res, 202, { status: 'pending' });
      states.delete(id);
      if (state.status !== 'verified') return json(res, 400, { error: 'Microsoft 邮箱授权未完成' });
      try {
        const result = store.saveManagedMailboxPool(state.command, actor, state.refreshToken);
        return json(res, 200, { status: 'saved', ...result });
      } catch (error) {
        return json(res, error.status || 500, { error: error.status ? error.message : '保存邮箱授权失败' });
      }
    }

    const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
    const version = input?.version;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
        !Number.isSafeInteger(version) || version < 0)
      return json(res, 400, { error: '请填写正确的 Microsoft 邮箱' });
    const pool = store.loadManagedMailboxPool();
    if (pool.version !== version) return json(res, 409, { error: '邮箱池已更新，请重新读取' });
    let command;
    if (input.id) {
      const item = pool.items.find((row) => row.id === input.id);
      if (item?.provider !== 'microsoft' || item.email !== email)
        return json(res, 400, { error: '请核对原 Microsoft 邮箱编号' });
      command = { action: 'credential', version, id: item.id };
    } else {
      if (!Number.isSafeInteger(input.validDays) || input.validDays < 1 || input.validDays > 365)
        return json(res, 400, { error: '查询码有效期必须为 1 至 365 天' });
      command = { action: 'create', version, provider: 'microsoft', email, label: input.label, validDays: input.validDays };
    }
    if (states.size >= 100 || [...states.values()].filter((state) => state.actorId === actor.id).length >= 3)
      return json(res, 429, { error: '待处理授权过多，请稍后重试' });
    const id = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    states.set(id, { actorId: actor.id, email, verifier, command, status: 'pending', expiresAt: clock() + 600_000 });
    const url = new URL(endpoint + 'authorize');
    url.search = new URLSearchParams({
      client_id: config.clientId, response_type: 'code', response_mode: 'query',
      redirect_uri: config.redirectUri, scope, state: id, login_hint: email,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'
    }).toString();
    return json(res, 200, { authorizationId: id, authorizationUrl: url.href });
  }

  return { readMailbox, handle };
}
