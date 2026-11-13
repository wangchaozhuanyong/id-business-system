import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseToolPublicOrigin, toolRequestOrigin } from './request-origin.mjs';
import { createMailboxUpdates } from './mailbox-updates.mjs';
import { createSourceLimit } from '../login-security.mjs';

export const managedMailboxDomain = 'managed-mailbox-pool';
export const managedMailboxQueryRoute = '/api/local/tools/mailbox-query';
export const storefrontMailboxQueryRoute = '/api/public/mailbox/query';
export const defaultMailboxValidDays = 30;
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

function queryCodeCounts(items) {
  const counts = new Map();
  for (const { queryCode } of items) if (queryCode) counts.set(queryCode, (counts.get(queryCode) || 0) + 1);
  return counts;
}

export function mailboxPoolMetadata(snapshot) {
  const items = mailboxPoolItems(snapshot);
  const counts = queryCodeCounts(items);
  return {
    version: snapshot.version,
    defaultValidDays: snapshot.data?.defaultValidDays ?? defaultMailboxValidDays,
    items: items.map(({ id, provider, email, active, expiresAt, updatedAt, authFailed, label, queryCode }) =>
      ({ id, provider, email, active, expiresAt, updatedAt, label: label || '', authFailed: authFailed === true,
        ...(counts.get(queryCode) > 1 && { associationConflict: true }) }))
  };
}

const emailKey = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const inventoryProviders = { google: 'google', microsoft: 'microsoft', apple: 'apple' };

export function availableRegistrationMailbox(asset) {
  return Boolean(asset?.createdById && !asset.deleted && !asset.relayDeleted && !asset.used &&
    (asset.inventoryState ?? 'available') === 'available' && (asset.health ?? 'normal') === 'normal' &&
    (asset.status ?? '正常') === '正常');
}

export function registrationMailboxSource(snapshot, asset, actor) {
  if (!availableRegistrationMailbox(asset) || asset.createdById !== actor.id) return null;
  if (asset.type === 'relay') return { asset };
  const item = mailboxPoolItems(snapshot).find(row => row.registrationAssetId === asset.id &&
    row.registrationActorId === actor.id && emailKey(row.email) === emailKey(asset.email) && row.active && !row.authFailed);
  if (item) return { asset, item: { ...item, revision: snapshot.version } };
  if (asset.appPassword && ['google', 'apple'].includes(asset.type)) {
    const provider = /@(?:gmail|googlemail)\.com$/i.test(asset.email) ? 'google'
      : /@(?:icloud|mac|me)\.com$/i.test(asset.email) ? 'apple' : null;
    if (provider) return { asset, item: { provider, email: asset.email, appPassword: asset.appPassword } };
  }
  return { asset };
}

export function mailboxRegistrationAssignment(item, mailboxes, assetId, isRegistrar) {
  if (assetId === null) {
    const { registrationAssetId, registrationActorId, ...unassigned } = item;
    return unassigned;
  }
  const asset = mailboxes.find(row => row.id === assetId && row.type !== 'relay' &&
    availableRegistrationMailbox(row) && emailKey(item.email) === emailKey(row.email));
  if (!asset || !item.active || item.authFailed || !isRegistrar(asset.createdById))
    throw new MailboxPoolError(409, '请选择仍在职的注册员及其已登记、可用的相同邮箱');
  return { ...item, registrationAssetId: asset.id, registrationActorId: asset.createdById };
}

export function inventoryMailboxPool(metadata, inventory) {
  const mailboxes = inventory?.data?.mailboxes || [];
  const hidden = new Set(mailboxes.filter(row => row.type === 'relay').map(row => emailKey(row.email)));
  const items = [], byEmail = new Map();
  for (const row of metadata.items) {
    const email = emailKey(row.email);
    if (!email || hidden.has(email) || row.provider === 'relay') continue;
    const existing = byEmail.get(email);
    if (existing) { existing.associationConflict = true; continue; }
    const entry = { ...row, source: 'manual' };
    byEmail.set(email, entry);
    items.push(entry);
  }
  for (const asset of mailboxes) {
    if (!Object.hasOwn(inventoryProviders, asset.type) || asset.deleted) continue;
    const email = emailKey(asset.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || hidden.has(email)) continue;
    let row = byEmail.get(email);
    if (!row) {
      const provider = asset.type !== 'apple' ? inventoryProviders[asset.type]
        : /@(?:icloud|mac|me)\.com$/.test(email) ? 'apple' : /@(?:gmail|googlemail)\.com$/.test(email) ? 'google'
          : /@(?:outlook|hotmail|live)\.com$/.test(email) ? 'microsoft' : '';
      row = { id: `inventory:${asset.id}`, email, provider, label: '', source: 'inventory', authorizationPending: true,
        active: false, authFailed: false, expiresAt: null, lastQueriedAt: null };
      byEmail.set(email, row);
      items.push(row);
    }
    const sources = row.inventorySources ??= [];
    if (sources.includes(asset.type)) row.associationConflict = true;
    else sources.push(asset.type);
    if (!row.authorizationPending && asset.type !== 'apple' && row.provider !== asset.type) row.associationConflict = true;
  }
  return { ...metadata, inventoryVersion: inventory?.version ?? 0, items };
}

export function mailboxRotationProblem(item) {
  if (!item || item.authorizationPending) return '未绑定邮箱';
  if (item.associationConflict) return '邮箱关联冲突';
  if (item.authFailed) return '邮箱授权已失效';
  if (!item.active) return '邮箱已停用';
  if (!['google', 'apple', 'microsoft'].includes(item.provider)) return '邮箱服务商待核对';
  return '';
}

export function planMailboxRotations(snapshot, inventory, body, now = Date.now()) {
  if (!['google', 'pool'].includes(body.scope) || !['single', 'selected', 'all'].includes(body.mode) ||
      (body.mode !== 'all' && (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 10000 ||
        (body.mode === 'single' && body.ids.length !== 1) || new Set(body.ids).size !== body.ids.length ||
        body.ids.some(id => typeof id !== 'string' || !id || id.length > 160))))
    throw new MailboxPoolError(400, '请选择要重置的邮箱');
  if (body.version !== snapshot.version || body.inventoryVersion !== inventory.version)
    throw new MailboxPoolError(409, '邮箱池或库存资料已更新，请刷新后重新选择');
  const view = inventoryMailboxPool(mailboxPoolMetadata(snapshot), inventory);
  const byEmail = new Map(view.items.map(row => [emailKey(row.email), row]));
  const targets = body.scope === 'pool' ? view.items.map(row => ({ id: row.id, row })) :
    (inventory.data?.mailboxes || []).filter(asset => asset.type === 'google' && !asset.deleted)
      .map(asset => ({ id: asset.id, row: byEmail.get(emailKey(asset.email)), asset }));
  const index = new Map(targets.map(target => [target.id, target]));
  const selected = body.mode === 'all' ? targets : body.ids.map(id => index.get(id) || { id });
  const items = mailboxPoolItems(snapshot);
  const credentials = new Map(items.map(row => [row.id, row]));
  const updates = new Map();
  const counts = queryCodeCounts(items);
  const validDays = view.defaultValidDays;
  const updatedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + validDays * 86_400_000).toISOString();
  const results = selected.map(({ id, row, asset }) => {
    const email = row?.email || emailKey(asset?.email);
    const credential = credentials.get(row?.id);
    let reason = mailboxRotationProblem(row);
    if (!reason && asset && ((asset.health && asset.health !== 'normal') || (asset.status && asset.status !== '正常')))
      reason = '库存邮箱状态异常';
    if (!reason && (!credential || (credential.provider === 'microsoft' ? !credential.refreshToken : !credential.appPassword)))
      reason = '邮箱授权资料待核对';
    if (!reason && updates.has(row.id)) reason = '本批已处理同一邮箱';
    if (reason) return { id, email, status: 'skipped', reason };
    let code;
    do { code = 'MBX-' + randomBytes(24).toString('base64url'); } while (counts.has(code));
    counts.set(code, 1);
    updates.set(row.id, { ...credential, queryCode: code, expiresAt, updatedAt });
    return { id, email, status: 'success', expiresAt };
  });
  return { results, items: items.map(row => updates.get(row.id) || row), validDays,
    ...(body.mode === 'single' && updates.size === 1 && { issued: updates.values().next().value }) };
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
  const defaultValidDays = snapshot.data?.defaultValidDays ?? defaultMailboxValidDays;
  const validDays = (days) => {
    if (!Number.isSafeInteger(days) || days < 1 || days > 365)
      throw new MailboxPoolError(400, '查询码有效期必须为 1 至 365 天');
    return days;
  };
  if (body.action === 'settings') {
    if (body.applyExisting !== undefined && typeof body.applyExisting !== 'boolean')
      throw new MailboxPoolError(400, '同步现有查询码设置无效');
    const days = validDays(body.validDays);
    return { items, defaultValidDays: days };
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
    const problem = mailboxRotationProblem(item);
    if (problem) throw new MailboxPoolError(409, problem);
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
  let item;
  for (const row of mailboxPoolItems(snapshot)) {
    if (!isManagedCode(row.queryCode) || row.queryCode.length !== input.length ||
        !timingSafeEqual(Buffer.from(row.queryCode), wanted)) continue;
    if (item) return null;
    item = row;
  }
  return item?.active && !item.authFailed && Date.parse(item.expiresAt) > clock
    ? { ...item, revision: snapshot.version } : null;
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

function normalizeMessages(value, includeBody) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('invalid mail response');
  const safe = (text, max) => typeof text === 'string' ? text.slice(0, max) : '';
  return value.map((row) => {
    const body = safe(row?.body, 16_000);
    return {
      subject: safe(row?.subject, 500),
      receivedAt: safe(row?.receivedAt, 64),
      ...(includeBody && { body: body.slice(0, 2000) }),
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

export function createManagedMailboxQuery({ store, publicOrigin, storefrontOrigin, readMailbox = readMailboxImap,
  watchMailbox, readSource = () => undefined, clock = Date.now }) {
  const publicUrl = parseToolPublicOrigin(publicOrigin);
  const storefrontUrl = parseToolPublicOrigin(storefrontOrigin);
  const allowSource = createSourceLimit({ maximum: 40, windowMs: 300_000, clock });
  const allowMailbox = createSourceLimit({ maximum: 30, windowMs: 60_000, clock });
  const running = { site: 0, storefront: 0, staff: 0 };
  const updates = createMailboxUpdates({ store, watchMailbox, clock });
  const handle = async (request, response, actor) => {
    const storefront = request.url?.split('?', 1)[0] === storefrontMailboxQueryRoute;
    const includeBody = !storefront && ['admin', 'super'].includes(actor?.role);
    const channel = storefront ? 'storefront' : includeBody ? 'staff' : 'site';
    const wantsUpdates = !storefront && request.headers.accept === 'text/event-stream';
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
    if (!allowSource(channel + ':' + (includeBody ? actor.id : readSource(request) || 'unverified')))
      return send(429, { error: '查询过于频繁，请稍后再试' }, 60);
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
      if (!allowMailbox(channel + ':' + item.id) || running[channel] >= 3)
        return send(429, { error: '查询繁忙，请稍后再试' });
      if (wantsUpdates) {
        await updates.handle(request, response, code, item);
        return;
      }
      let result;
      running[channel]++;
      try {
        result = await readMailbox({ ...item, limit, ...(storefront && { storefront: true }) });
      } catch (error) {
        if (error instanceof MailboxAuthorizationError)
          store.markManagedMailboxAuthFailed(item.id, item.revision);
        throw error;
      } finally {
        running[channel]--;
      }
      const messages = Array.isArray(result) ? result : result.rows;
      const rows = storefront
        ? storefrontMessages(messages, limit, item.email)
        : normalizeMessages(messages, includeBody).slice(0, limit);
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
    } catch (error) {
      const exposed = wantsUpdates && [403, 404, 409, 503].includes(error.status);
      if (!response.destroyed) send(exposed ? error.status : 503, { error: exposed ? error.message : '邮箱暂不可用，请联系管理员核对授权' });
    }
  };
  handle.close = () => updates.close();
  return handle;
}
