import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseToolPublicOrigin, toolRequestOrigin } from './request-origin.mjs';

export const managedMailboxDomain = 'managed-mailbox-pool';
export const managedMailboxQueryRoute = '/api/local/tools/mailbox-query';
export const storefrontMailboxQueryRoute = '/api/public/mailbox/query';
const workerFile = fileURLToPath(new URL('../../modules/tools/mailbox-imap.py', import.meta.url));
const providers = ['google', 'apple'];
const codePattern = /^MBX-[A-Za-z0-9_-]{32}$/;
export const legacyMailboxCodePattern = /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]{20}$/;
export const isManagedCode = (value) => typeof value === 'string' &&
  (codePattern.test(value) || legacyMailboxCodePattern.test(value));

export function extractManagedMailboxCode(body) {
  const text = String(body || '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ');
  return /(?:验证码|verification code|security code)\D{0,20}(\d{4,8})(?!\d)/i.exec(text)?.[1] || null;
}

export class MailboxPoolError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function mailboxPoolItems(snapshot) {
  return Array.isArray(snapshot.data) ? snapshot.data : snapshot.data?.items || [];
}

export function mailboxPoolMetadata(snapshot) {
  return {
    version: snapshot.version,
    defaultValidDays: snapshot.data?.defaultValidDays ?? 7,
    items: mailboxPoolItems(snapshot).map(({ id, provider, email, active, expiresAt, updatedAt, authFailed, label }) =>
      ({ id, provider, email, active, expiresAt, updatedAt, label: label || '', authFailed: authFailed === true }))
  };
}

export function mailboxPoolCodePage(snapshot, { ids, version }) {
  if (snapshot.version !== version)
    throw new MailboxPoolError(409, '邮箱池已更新，请刷新列表');
  const codes = new Map(mailboxPoolItems(snapshot).map(({ id, queryCode }) => [id, queryCode]));
  return { version, items: ids.map(id => ({ id, code: codes.get(id) || '' })) };
}

export function applyMailboxPoolWrite(snapshot, body, clock = Date.now(), microsoftRefreshToken) {
  if (!body || !['create', 'credential', 'status', 'rotate', 'settings', 'batch'].includes(body.action) ||
      !Number.isSafeInteger(body.version) || body.version < 0)
    throw new MailboxPoolError(400, '邮箱池操作格式无效');
  if (snapshot.version !== body.version)
    throw new MailboxPoolError(409, '邮箱池已更新，请重新读取');
  const items = mailboxPoolItems(snapshot);
  const defaultValidDays = snapshot.data?.defaultValidDays ?? 7;
  const validDays = (days) => {
    if (!Number.isSafeInteger(days) || days < 1 || days > 365)
      throw new MailboxPoolError(400, '查询码有效期必须为 1 至 365 天');
    return days;
  };
  if (body.action === 'settings') {
    if (body.applyExisting !== undefined && typeof body.applyExisting !== 'boolean')
      throw new MailboxPoolError(400, '同步现有查询码设置无效');
    const days = validDays(body.validDays);
    const expiresAt = new Date(clock + days * 86_400_000).toISOString();
    const updatedAt = new Date(clock).toISOString();
    return {
      items: body.applyExisting ? items.map((row) => ({ ...row, expiresAt, updatedAt })) : items,
      defaultValidDays: days
    };
  }
  if (body.action === 'batch') {
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50)
      throw new MailboxPoolError(400, '每批可登记 1 至 50 个邮箱');
    let next = items;
    const batch = body.items.map((row, index) => {
      try {
        const result = applyMailboxPoolWrite(
          { version: snapshot.version, data: { items: next, defaultValidDays } },
          { ...row, version: snapshot.version, action: 'create' }, clock
        );
        next = result.items;
        return { line: index + 1, success: true, issuedCode: result.issuedCode };
      } catch (error) {
        if (!(error instanceof MailboxPoolError)) throw error;
        return { line: index + 1, success: false, error: error.message };
      }
    });
    return { items: next, defaultValidDays, batch };
  }
  const now = new Date(clock).toISOString();
  const code = () => 'MBX-' + randomBytes(24).toString('base64url');
  const expiry = () => {
    const days = validDays(body.validDays ?? defaultValidDays);
    return new Date(clock + days * 86_400_000).toISOString();
  };
  const credential = () => {
    const value = typeof body.appPassword === 'string' ? body.appPassword.replace(/\s+/g, '') : '';
    if (!value || value.length > 256 || /[\p{C}]/u.test(value))
      throw new MailboxPoolError(400, '请输入有效的邮箱应用专用密码');
    return value;
  };
  if (body.action === 'create') {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!(providers.includes(body.provider) || (body.provider === 'microsoft' && microsoftRefreshToken)) || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new MailboxPoolError(400, '请选择支持的邮箱类型并填写正确邮箱');
    if (items.length >= 500) throw new MailboxPoolError(400, '邮箱池已达 500 条');
    if (items.some((row) => row.email === email)) throw new MailboxPoolError(409, '此邮箱已在邮箱池中');
    const label = typeof body.label === 'string' ? body.label.trim().replace(/\s+/g, ' ') : '';
    if (label.length > 60 || /[\p{C}]/u.test(label)) throw new MailboxPoolError(400, '邮箱备注最多 60 字');
    const item = {
      id: randomUUID(), provider: body.provider, email, label,
      ...(body.provider === 'microsoft' ? { refreshToken: microsoftRefreshToken } : { appPassword: credential() }),
      active: true, expiresAt: expiry(), queryCode: code(), updatedAt: now
    };
    return { id: item.id, items: [...items, item], defaultValidDays, issuedCode: item.queryCode };
  }
  const current = items.find((row) => row.id === body.id);
  if (!current) throw new MailboxPoolError(404, '找不到邮箱池记录');
  const item = { ...current, updatedAt: now };
  if (body.action === 'credential') {
    delete item.authFailed;
    if (item.provider === 'microsoft') {
      if (!microsoftRefreshToken) throw new MailboxPoolError(400, '请通过 Microsoft 授权更新邮箱连接');
      item.refreshToken = microsoftRefreshToken;
    } else {
      item.appPassword = credential();
    }
  }
  if (body.action === 'status') {
    if (typeof body.active !== 'boolean') throw new MailboxPoolError(400, '邮箱状态无效');
    if (body.active && item.authFailed) throw new MailboxPoolError(409, '请先更新邮箱授权');
    item.active = body.active;
  }
  if (body.action === 'rotate') {
    item.expiresAt = expiry();
    item.queryCode = code();
  }
  return {
    id: item.id, defaultValidDays, items: items.map((row) => row.id === item.id ? item : row),
    issuedCode: body.action === 'rotate' ? item.queryCode : undefined
  };
}

export function findMailboxQuery(snapshot, input, clock = Date.now()) {
  if (!isManagedCode(input)) return null;
  const wanted = Buffer.from(input);
  const item = mailboxPoolItems(snapshot).find((row) => row.active && !row.authFailed && Date.parse(row.expiresAt) > clock &&
    isManagedCode(row.queryCode) && row.queryCode.length === input.length &&
    timingSafeEqual(Buffer.from(row.queryCode), wanted));
  return item ? { ...item, revision: snapshot.version } : null;
}

export async function prepareVerifiedMailboxWrite(snapshot, body, verify) {
  const plan = applyMailboxPoolWrite(snapshot, body);
  const check = async (item) => {
    try {
      await verify(item);
    } catch {
      throw new MailboxPoolError(422, '邮箱授权验证失败，请核对应用专用密码及 IMAP 设置后重试');
    }
  };
  if (['create', 'credential'].includes(body.action)) {
    await check(plan.items.find((item) => item.id === plan.id));
  }
  if (body.action !== 'batch') return plan;

  const additions = new Map(plan.items.slice(mailboxPoolItems(snapshot).length).map((item) => [item.queryCode, item]));
  const rejected = new Set();
  const candidates = plan.batch.filter((row) => row.success);
  for (let offset = 0; offset < candidates.length; offset += 4) {
    await Promise.all(candidates.slice(offset, offset + 4).map(async (row) => {
      const item = additions.get(row.issuedCode);
      try {
        await check(item);
      } catch (error) {
        rejected.add(item.id);
        delete row.issuedCode;
        row.success = false;
        row.error = error.message;
      }
    }));
  }
  plan.items = plan.items.filter((row) => !rejected.has(row.id));
  return plan;
}

export class MailboxAuthorizationError extends Error {}

export function verifyMailboxImap(item) {
  return readMailboxImap(item, { verifyOnly: true });
}

export async function readMailboxImap(item, { verifyOnly = false } = {}) {
  return new Promise((resolve, reject) => {
    const maximumBytes = item.storefront ? 2_000_000 : 400_000;
    const child = spawn('python3', ['-B', workerFile], {
      stdio: ['pipe', 'pipe', 'ignore'], timeout: 14_000, killSignal: 'SIGKILL'
    });
    child.stdin.on('error', () => {});
    child.on('error', () => reject(new Error('mail provider unavailable')));
    const chunks = [];
    let bytes = 0;
    child.stdout.on('data', (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) child.kill();
      else chunks.push(chunk);
    });
    child.on('close', (code) => {
      try {
        if (code === 2) return reject(new MailboxAuthorizationError());
        if (code !== 0 || bytes > maximumBytes) throw new Error();
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('mail provider unavailable'));
      }
    });
    child.stdin.end(JSON.stringify({
      provider: item.provider, email: item.email, storefront: item.storefront === true,
      appPassword: item.appPassword, accessToken: item.accessToken, limit: item.limit, verifyOnly
    }));
  });
}

function normalizeMessages(value) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('invalid mail response');
  const safe = (text, max) => typeof text === 'string' ? text.slice(0, max) : '';
  return value.map((row) => {
    const body = safe(row?.body, 16_000);
    return {
      subject: safe(row?.subject, 500),
      receivedAt: safe(row?.receivedAt, 64),
      body: body.slice(0, 2000),
      extractedCode: extractManagedMailboxCode(body)
    };
  });
}

function storefrontMessages(value, limit, address) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('invalid mail response');
  const safe = (text, max) => typeof text === 'string' ? text.slice(0, max) : '';
  return value.slice(0, limit).flatMap((row) => {
    const time = Date.parse(row?.receivedAt);
    if (!Number.isFinite(time)) return [];
    return [{
      from: safe(row.from, 500), to: safe(row.to, 500) || address,
      subject: safe(row.subject, 500), body: safe(row.body, 16_000),
      savedAt: new Date(time).toISOString()
    }];
  });
}

export function createManagedMailboxQuery({ store, publicOrigin, storefrontOrigin, readMailbox = readMailboxImap, clock = Date.now }) {
  const publicUrl = parseToolPublicOrigin(publicOrigin);
  const storefrontUrl = parseToolPublicOrigin(storefrontOrigin);
  const attempts = [];
  let running = 0;
  return async (request, response) => {
    const storefront = request.url?.split('?', 1)[0] === storefrontMailboxQueryRoute;
    const send = (status, payload, retryAfter = 5) => {
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
        ...(status === 405 && { Allow: 'POST' }),
        ...(status === 429 && { 'Retry-After': String(retryAfter) })
      });
      response.end(JSON.stringify(payload));
    };
    if (request.method !== 'POST') return send(405, { error: '邮件查询只支持 POST' });
    const origin = toolRequestOrigin(request.headers, storefront ? storefrontUrl : publicUrl);
    const originAllowed = storefront
      ? storefrontUrl && (request.headers.origin === undefined || request.headers.origin === origin)
      : request.headers.origin === origin;
    if (!origin || !originAllowed ||
        (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin'))
      return send(403, { error: '请求来源未通过校验' });
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || ''))
      return send(415, { error: '请提交 JSON 请求' });
    const now = clock();
    while (attempts.length && attempts[0] <= now - 300_000) attempts.shift();
    if (attempts.length >= 40 || running >= 3)
      return send(429, { error: '查询繁忙，请稍后再试' },
        attempts.length >= 40 ? Math.ceil((attempts[0] + 300_000 - now) / 1000) : 5);
    attempts.push(now);
    running++;
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.byteLength;
        if (bytes > 2048) {
          request.resume();
          return send(400, { error: '查询请求格式无效' });
        }
        chunks.push(chunk);
      }
      let input;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, { error: '查询请求格式无效' });
      }
      const raw = input?.queryCode ?? (storefront ? input?.credential : undefined);
      let code = typeof raw === 'string' ? raw.trim() : '';
      if (storefront) {
        const oldInput = /^[^\s@]+@[^\s@]+\.\S+?----([^\s]+)$/.exec(code);
        if (oldInput) code = oldInput[1];
      }
      const limit = input?.limit ?? (storefront ? 5 : 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 20)
        return send(400, { error: '返回封数须为 1 至 20' });
      const item = store.findManagedMailbox(code, clock());
      const invalidCode = () => send(storefront ? 400 : 404, { error: '邮件查询码无效或已过期' });
      if (!item) return invalidCode();
      let result;
      try {
        result = await readMailbox({ ...item, limit, ...(storefront && { storefront: true }) });
      } catch (error) {
        if (error instanceof MailboxAuthorizationError)
          store.markManagedMailboxAuthFailed(item.id, item.revision);
        throw error;
      }
      const messages = Array.isArray(result) ? result : result.rows;
      const rows = storefront
        ? storefrontMessages(messages, limit, item.email)
        : normalizeMessages(messages).slice(0, limit);
      const latest = store.findManagedMailbox(code, clock());
      if (latest?.id !== item.id || latest.revision !== item.revision)
        return invalidCode();
      if (result.refreshToken && result.refreshToken !== item.refreshToken)
        store.rotateMicrosoftRefreshToken(item.id, item.revision, result.refreshToken);
      store.recordManagedMailboxQuery(item.id);
      if (storefront) return send(200, {
        success: true,
        data: { email: item.email, items: rows,
          provider: { google: 'gmail', apple: 'icloud', microsoft: 'microsoft' }[item.provider],
          queriedAt: new Date(clock()).toISOString() }
      });
      const [user, host] = item.email.split('@');
      send(200, {
        success: true, targetType: 'PRIMARY', primaryEmail: user.slice(0, 1) + '***@' + host,
        codeExpiresAt: item.expiresAt,
        items: rows
      });
    } catch {
      if (!response.destroyed) send(503, { error: '邮箱暂不可用，请联系管理员核对授权' });
    } finally {
      running--;
    }
  };
}
