import { createHash, randomUUID } from 'node:crypto';

import { validCurrencyCode } from '../modules/finance/accounting.mjs';
import { parseV2DateTimeInput } from '../modules/time/dateTime.ts';
import { releasedAccountOrders } from './account-lifecycle.mjs';
import { validMoney } from './order-policy.mjs';
import { isManagedCode, mailboxPoolItems } from './tools/mailbox-pool.mjs';

const baseRoute = '/api/local/claude-google-subscriptions';
const listRoute = baseRoute + '/list';
const copyRoute = baseRoute + '/copy';
const settingsRoute = baseRoute + '/copy-settings';
export const claudeGoogleSubscriptionRoutes = new Set([listRoute, copyRoute, settingsRoute]);
export const claudeGoogleCopyDomainPrefix = 'claude-google-copy:';

const day = 86_400_000;
const codeStatuses = new Set(['active', 'missing', 'expired', 'disabled', 'auth_failed', 'conflict']);
const googleTypes = new Set(['google', 'gmail', '谷歌邮箱']);
const otherEmailTypes = new Set(['apple', 'icloud', 'relay', 'microsoft', '苹果邮箱', '苹果隐藏邮箱', '微软邮箱']);
const list = value => Array.isArray(value) ? value : [];
const string = value => typeof value === 'string' ? value : '';
const emailKey = value => string(value).trim().toLowerCase();
const claude = order => ['Claude Pro', 'Claude Max'].includes(order?.product);
const googleAddress = email => /@(?:gmail|googlemail)\.com$/.test(email);
const paid = order => order?.paidConfirmed === true || list(order?.financialEvidence).some(entry =>
  entry?.kind === 'payment' && ['银行卡', '苹果内购'].includes(entry.payment) &&
  validCurrencyCode(entry.currency) && validMoney(entry.amount) && /[1-9]/.test(entry.amount));
const subscription = order => paid(order) && !order.cancelled &&
  !order.draft && !['draft', 'failed', 'cancelled', '草稿', '失败', '已撤单'].includes(order.status);
const failure = (status, message) => Object.assign(new Error(message), { status });
const manager = actor => Boolean(actor?.id && ['admin', 'super'].includes(actor.role));

function instant(value) {
  let text = string(value).trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += 'T00:00';
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
    ? Date.parse(text) : parseV2DateTimeInput(text)?.getTime() ?? NaN;
}

function indexRows(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const id = key(row);
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  return groups;
}

function orderAccount(order, accounts, byId) {
  if (order.accountId) {
    const matches = byId.get(order.accountId) || [];
    const account = matches.length === 1 ? matches[0] : null;
    return account?.type === 'claude' && emailKey(account.email) === emailKey(order.email)
      ? { account } : { conflict: true };
  }
  const linked = accounts.filter(account => list(account.usageLinks).some(link =>
    ['order-sale', 'order-renewal', 'order-use'].includes(link?.kind) && link.orderId === order.id));
  const matches = linked.length ? linked : accounts;
  return matches.length > 1 ? { conflict: true } : { account: matches[0] };
}

function mailboxBinding(order, account, mailboxes, emailOrders) {
  const released = account ? releasedAccountOrders(account) : new Set();
  const lifecycle = account?.accountLifecycle;
  if (released.has(order.id) ||
      ['recovered', 'retired'].includes(lifecycle?.disposition) ||
      (lifecycle?.customerId && lifecycle.customerId !== order.customerId) ||
      emailOrders.some(other => !other.subscriptionEnded && !released.has(other.id) &&
        other.customerId && other.customerId !== order.customerId))
    return { conflict: true };
  if (order.subscriptionEnded) return { ended: true };
  const linked = mailboxes.filter(mailbox => list(mailbox.usageLinks).some(link =>
    (link?.kind === 'registration' && account && link.accountId === account.id) ||
    (link?.kind === 'order-use' && link.orderId === order.id)));
  const matches = linked.length ? linked : mailboxes;
  if (matches.length > 1) return { credentialConflict: true };
  const [mailbox] = matches;
  if (mailbox && !linked.length && list(mailbox.usageLinks).some(link =>
    (link?.accountId && link.accountId !== account?.id) ||
    (link?.orderId && !emailOrders.some(other => other.id === link.orderId && !released.has(other.id)))))
    return { conflict: true };
  return { mailbox };
}

function queryCodeInfo(poolMatches, codes, now) {
  const empty = { queryCode: '', codeStatus: 'missing', expiresAt: null, remainingDays: null };
  if (poolMatches.length > 1) return { ...empty, codeStatus: 'conflict' };
  const [record] = poolMatches;
  if (!record?.queryCode) return empty;
  const expires = instant(record.expiresAt);
  if (!isManagedCode(record.queryCode) || (codes.get(record.queryCode)?.length || 0) !== 1 || !Number.isFinite(expires))
    return { ...empty, codeStatus: 'conflict' };
  return {
    queryCode: record.queryCode,
    codeStatus: record.authFailed ? 'auth_failed' : !record.active ? 'disabled' : expires <= now ? 'expired' : 'active',
    expiresAt: new Date(expires).toISOString(),
    remainingDays: Math.max(0, Math.ceil((expires - now) / day))
  };
}

export function projectClaudeGoogleSubscriptions({ commerce, inventory, mailboxes }, now = Date.now()) {
  const allOrders = list(commerce.data?.orders);
  const orderIds = indexRows(allOrders, order => order.id);
  const orders = allOrders.filter(subscription).map(order => ({
    order, start: instant(order.start), expiry: instant(order.expiry), created: instant(order.createdAt) || 0
  })).filter(({ order, start, expiry }) => Number.isFinite(start) && start <= now &&
    (!order.expiry || (Number.isFinite(expiry) && expiry >= start)))
    .sort((a, b) => b.start - a.start || b.created - a.created || string(a.order.id).localeCompare(string(b.order.id)))
    .map(({ order }) => order);
  const emailOrders = indexRows(orders, order => emailKey(order.email));
  const accounts = list(inventory.data?.accounts);
  const accountIds = indexRows(accounts, account => account.id);
  const claudeAccounts = indexRows(accounts.filter(account => account.type === 'claude'), account => emailKey(account.email));
  const googleMailboxes = indexRows(list(inventory.data?.mailboxes).filter(mailbox => mailbox.type === 'google'),
    mailbox => emailKey(mailbox.email));
  const pool = mailboxPoolItems(mailboxes);
  const googlePool = indexRows(pool.filter(mailbox => mailbox.provider === 'google'), mailbox => emailKey(mailbox.email));
  const codes = indexRows(pool, mailbox => mailbox.queryCode);
  const eligible = [];
  const seen = new Set();
  for (const order of orders) {
    const email = emailKey(order.email);
    if (!claude(order) || !string(order.id) || seen.has(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    seen.add(email);
    if (orderIds.get(order.id).length !== 1) continue;
    const accountMatch = orderAccount(order, claudeAccounts.get(email) || [], accountIds);
    const type = emailKey(accountMatch.account?.emailType);
    const mailboxMatches = googleMailboxes.get(email) || [];
    const poolMatches = googlePool.get(email) || [];
    if (otherEmailTypes.has(type) ||
        (!googleTypes.has(type) && !googleAddress(email) && !mailboxMatches.length && !poolMatches.length)) continue;

    const binding = accountMatch.conflict ? { conflict: true } :
      mailboxBinding(order, accountMatch.account, mailboxMatches, emailOrders.get(email));
    const password = string(binding.mailbox?.password);
    const totp = string(binding.mailbox?.totp);
    const code = queryCodeInfo(binding.conflict || binding.ended ? [] : poolMatches, codes, now);
    if (binding.conflict) code.codeStatus = 'conflict';
    const operatorId = string(order.createdById);
    const operatorName = string(order.createdBy);
    eligible.push({
      id: order.id, email: order.email.trim(), password, totp, ...code,
      operatorId, operatorName,
      ownerId: string(order.ownerId) || operatorId, ownerName: string(order.owner) || (order.ownerId ? '' : operatorName),
      credentialStatus: binding.conflict || binding.credentialConflict ? 'conflict' : password ? 'available' : 'missing'
    });
  }
  return eligible;
}

function pagination({ query = '', status = '', page = 1, pageSize = 8 }) {
  if (typeof query !== 'string' || query.length > 254 || (status !== '' && !codeStatuses.has(status)) ||
      !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100)
    throw failure(400, '查询筛选或分页格式不正确');
  return { query: query.trim().toLowerCase(), status, page, pageSize };
}

export function validateClaudeGoogleCopySettings(body) {
  if (!Number.isSafeInteger(body?.version) || body.version < 0 || body.version >= Number.MAX_SAFE_INTEGER ||
      [body.copy1, body.copy2].some(value => typeof value !== 'string' || value.length > 2000 ||
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)))
    throw failure(400, '复制后缀格式不正确，每份最多 2000 字');
  return { copy1: body.copy1, copy2: body.copy2 };
}

function copyContents(row, mode, suffix) {
  const fields = [
    ['邮箱账号', row.email],
    ...(mode === 2 ? [['邮箱密码', row.password], ['邮箱 2FA', row.totp]] : []),
    ['买家查询码', row.codeStatus === 'active' ? row.queryCode : '']
  ];
  const lines = fields.filter(([, value]) => value).map(([label, value]) => `${label}：${value}`);
  if (suffix) lines.push(suffix);
  return { text: lines.join('\n'), omitted: fields.filter(([, value]) => !value).map(([label]) => label) };
}

function send(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
  response.end(JSON.stringify(value));
}

async function readCommand(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || ''))
    throw failure(415, '请提交 JSON 资料');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.byteLength;
    if (bytes > 24_000) {
      request.resume();
      throw failure(413, '订阅资料请求过长');
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* Invalid JSON and invalid body shape share the same response. */ }
  throw failure(400, '无法读取订阅资料请求');
}

export function createClaudeGoogleSubscriptionsHandler({ store, publicOrigin, clock = Date.now }) {
  const generation = randomUUID();
  return async (request, response, route, actor) => {
    if (!manager(actor)) return send(response, 403, { error: '只有管理员可以查看或复制订阅资料' });
    const origin = publicOrigin || `http://${request.headers.host}`;
    if ((request.headers.origin && request.headers.origin !== origin) ||
        (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin') ||
        (request.method !== 'GET' && request.headers.origin !== origin))
      return send(response, 403, { error: '仅允许从当前页面使用订阅资料' });
    try {
      if (route === settingsRoute) {
        if (request.method === 'GET') return send(response, 200, store.loadClaudeGoogleCopySettings(actor));
        if (request.method === 'PUT')
          return send(response, 200, store.saveClaudeGoogleCopySettings(await readCommand(request), actor));
      } else if (request.method === 'POST' && (route === listRoute || route === copyRoute)) {
        const body = await readCommand(request);
        const output = store.withClaudeGoogleSubscriptions(actor, (snapshots, audit) => {
          const now = Number(clock());
          const { commerce, inventory, mailboxes } = snapshots;
          const revision = createHash('sha256').update(JSON.stringify([
            generation, actor.id, commerce.version, inventory.version, mailboxes.version
          ])).digest('base64url');
          if (route === copyRoute) {
            if (typeof body.id !== 'string' || !body.id || body.id.length > 160 ||
                ![1, 2].includes(body.mode) || typeof body.revision !== 'string' || !body.revision)
              throw failure(400, '请选择要复制的订单资料');
            if (body.revision !== revision) throw failure(409, '订阅资料已变化，请刷新后重新核对');
            const row = projectClaudeGoogleSubscriptions(snapshots, now).find(item => item.id === body.id);
            if (!row) throw failure(404, '订单已无可复制的谷歌订阅资料');
            const settings = store.loadClaudeGoogleCopySettings(actor);
            const result = copyContents(row, body.mode, body.mode === 1 ? settings.copy1 : settings.copy2);
            audit(body.mode === 1 ? 'copy_1' : 'copy_2', [row.id]);
            return result;
          }
          const options = pagination(body);
          const matches = projectClaudeGoogleSubscriptions(snapshots, now).filter(row =>
            (!options.status || options.status === row.codeStatus) &&
            (!options.query || [row.email, row.operatorName, row.ownerName].some(value =>
              value.toLowerCase().includes(options.query))));
          const total = matches.length;
          const page = Math.min(options.page, Math.max(1, Math.ceil(total / options.pageSize)));
          const items = matches.slice((page - 1) * options.pageSize, page * options.pageSize);
          audit('view', items.map(row => row.id));
          return { items, total, page, pageSize: options.pageSize, revision, now: new Date(now).toISOString() };
        });
        return send(response, 200, output);
      }
      throw failure(405, '不支持此订阅资料操作');
    } catch (error) {
      if (response.destroyed) return;
      if ([400, 403, 404, 405, 409, 413, 415].includes(error.status))
        return send(response, error.status, { error: error.message });
      return send(response, 500, { error: '读取或保存订阅资料失败，请重试' });
    }
  };
}
