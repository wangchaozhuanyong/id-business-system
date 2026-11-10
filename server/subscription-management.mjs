import { createHash, randomUUID } from 'node:crypto';

import { parseV2DateTimeInput } from '../modules/time/dateTime.ts';
import { releasedAccountOrders } from './account-lifecycle.mjs';
import { personalProduct, subscriptionSeries, targetKey } from './personal-subscriptions.mjs';
import { isManagedCode, mailboxPoolItems } from './tools/mailbox-pool.mjs';

export const subscriptionDomain = 'subscription-management';
const base = '/api/local/subscriptions';
export const subscriptionRoutes = new Set(['list', 'account', 'lookup', 'copy', 'confirm', 'owner'].map(action => `${base}/${action}`));
const products = new Set(['GPT', 'Claude', 'Gemini', 'Grok']);
const statuses = new Set(['active', 'expired', 'pending', 'ended']);
const sorts = new Set(['expiry_asc', 'expiry_desc', 'account_asc']);
const defaultPageSize = 20;
const day = 86_400_000;
const array = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value.trim() : '';
const emailKey = value => text(value).toLowerCase();
const family = product => ['Claude Pro', 'Claude Max'].includes(product) ? 'Claude' : product;
const stockType = product => ({ GPT: 'gpt', Claude: 'claude', Gemini: 'gemini', Grok: 'grok' })[product];
const manager = actor => Boolean(actor?.id && ['admin', 'super'].includes(actor.role));
const failure = (status, message) => Object.assign(new Error(message), { status });
const digest = value => createHash('sha256').update(value).digest('base64url');

function instant(value) {
  let input = text(value).replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) input += 'T00:00';
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(input)
    ? Date.parse(input) : parseV2DateTimeInput(input)?.getTime() ?? NaN;
}

function identity(row, product) {
  if (product === 'Gemini' || product === 'Grok') return targetKey(row);
  const email = emailKey(row?.email);
  return email ? `email:${email}` : '';
}

export function subscriptionAccountId(product, row) {
  const target = identity(row, product);
  return products.has(product) && target ? digest(`${product}\0${target}`) : '';
}

function orderFingerprint(order) {
  const product = family(order.product);
  return digest(JSON.stringify([order.id, product, identity(order, product), order.plan || '',
    order.start || '', order.expiry || '', order.accountId || '', order.customerId || '']));
}

export function ownerForSubscriptionOrder(order, profiles) {
  const product = family(order?.product);
  const key = subscriptionAccountId(product, order);
  const owner = profiles?.owners?.[key];
  const matchesAccount = owner?.accountId ? order?.accountId === owner.accountId :
    !order?.accountId && owner?.customerId && owner.customerId === order?.customerId;
  return matchesAccount && owner?.ownerId && (!owner.customerId || owner.customerId === order.customerId) ? owner : null;
}

export function ownerForSubscriptionAccount(account, profiles) {
  const product = ({ gpt: 'GPT', claude: 'Claude', gemini: 'Gemini', grok: 'Grok' })[account?.type];
  const owner = profiles?.owners?.[subscriptionAccountId(product, account)];
  const customer = account?.accountLifecycle?.customerId;
  return owner?.accountId === account?.id && owner?.ownerId &&
    !(owner.customerId && ['recovered', 'retired'].includes(account?.accountLifecycle?.disposition)) &&
    (!owner.customerId || !customer || owner.customerId === customer) ? owner : null;
}

function openingConfirmed(order, profiles, now) {
  if (personalProduct(order.product)) return order.entitlementStatus === 'active';
  if (profiles?.confirmations?.[order.id]?.fingerprint === orderFingerprint(order)) return true;
  if (order.source === '线上代充' && order.taskId) {
    const completed = instant(order.rechargeCompletedAt);
    const start = instant(order.start), expiry = instant(order.expiry);
    return Number.isFinite(completed) && completed <= now &&
      (!Number.isFinite(start) || completed >= start) && (!Number.isFinite(expiry) || completed < expiry);
  }
  return false;
}

function paid(order) {
  return order.paidConfirmed === true || array(order.financialEvidence).some(item =>
    item?.kind === 'payment' && typeof item.amount === 'string' && /[1-9]/.test(item.amount));
}

function statusFor(record, now) {
  if (!record.confirmed) return 'pending';
  if (record.ended) return 'ended';
  if (record.cancelled) return 'pending';
  const start = instant(record.start), expiry = instant(record.expiry);
  if (!Number.isFinite(start) || !Number.isFinite(expiry) || expiry <= start || start > now) return 'pending';
  return expiry <= now ? 'expired' : 'active';
}

function remaining(expiry, now) {
  const end = instant(expiry);
  return Number.isFinite(end) ? Math.max(0, Math.ceil((end - now) / day)) : null;
}

function accountMatches(order, account, product) {
  return account?.type === stockType(product) && identity(account, product) === identity(order, product) &&
    (!order.platformAccountId || !account.platformAccountId || order.platformAccountId === account.platformAccountId);
}

function resolveAccount(order, product, accounts) {
  if (order.accountId) {
    const matches = accounts.filter(account => account.id === order.accountId);
    if (matches.length !== 1 || !accountMatches(order, matches[0], product)) return { conflict: true };
    const account = matches[0], customer = account.accountLifecycle?.customerId;
    if (customer && order.customerId && customer !== order.customerId && !releasedAccountOrders(account).has(order.id))
      return { conflict: true };
    return { account };
  }
  const candidates = accounts.filter(account => accountMatches(order, account, product));
  const linked = candidates.filter(account => array(account.usageLinks).some(link => link.orderId === order.id));
  if (linked.length > 1 || (!linked.length && candidates.length > 1)) return { conflict: true };
  const account = linked[0] || candidates[0];
  if (!account) return {};
  const lifecycle = account.accountLifecycle;
  // A matching login alone cannot establish that an unlinked inventory account
  // belongs to this order's customer, including older orders without a source.
  if (!linked.length && (!lifecycle?.customerId || lifecycle.customerId !== order.customerId)) return {};
  if (lifecycle?.customerId && order.customerId && lifecycle.customerId !== order.customerId &&
      !releasedAccountOrders(account).has(order.id)) return { conflict: true };
  return { account };
}

function seriesFor(order) {
  return personalProduct(order.product) ? subscriptionSeries(order) : family(order.product).toLowerCase();
}

function buildRecords(snapshots, now) {
  const inventory = snapshots.inventory.data || {};
  const accounts = array(inventory.accounts);
  const profiles = snapshots.subscriptions?.data || {};
  const orders = array(snapshots.commerce.data?.orders);
  const ids = new Map();
  for (const order of orders) ids.set(order?.id, (ids.get(order?.id) || 0) + 1);
  const records = [];
  for (const order of orders) {
    const product = family(order?.product);
    if (!products.has(product) || !text(order.id) || order.draft || ['draft', '草稿'].includes(order.status)) continue;
    const accountIdentity = identity(order, product);
    // Missing identities stay individually reviewable and must never be merged by product.
    const id = accountIdentity ? subscriptionAccountId(product, order) : digest(`${product}\0unresolved-order:${order.id}`);
    const confirmed = openingConfirmed(order, profiles, now);
    if (!confirmed && !paid(order)) continue;
    const match = resolveAccount(order, product, accounts);
    const released = match.account && releasedAccountOrders(match.account).has(order.id);
    const ended = order.subscriptionEnded === true || Boolean(released);
    const record = {
      id, product, sourceId: order.id, source: 'order', orderNo: text(order.orderNo) || text(order.id),
      target: identity(order, product), display: order.loginMethod === 'x' && order.xHandle ? order.xHandle :
        text(order.email) || text(order.xHandle), email: text(order.email), series: seriesFor(order),
      plan: text(order.plan), start: text(order.start), expiry: text(order.expiry),
      created: text(order.createdAt), customerId: text(order.customerId), account: match.account,
      accountConflict: Boolean(!accountIdentity || !text(order.customerId) || match.conflict || ids.get(order.id) !== 1),
      confirmed, ended, cancelled: order.cancelled === true,
      operatorId: order.source === '线上代充' ? '' : text(order.createdById),
      operatorName: order.source === '线上代充' ? '系统自动' : text(order.createdBy) || '历史未记录'
    };
    record.status = statusFor(record, now);
    records.push(record);
  }
  for (const account of accounts) {
    const history = account?.claudeHistory;
    if (account?.type !== 'claude' || !(history?.phase === 'opened' ||
        (history?.phase === 'dead' && history.plan && history.start && history.expiry))) continue;
    const id = subscriptionAccountId('Claude', account);
    if (!id) continue;
    const record = {
      id, product: 'Claude', sourceId: account.id, source: 'history', orderNo: '',
      target: identity(account, 'Claude'), display: text(account.email), email: text(account.email),
      series: 'claude', plan: text(history.plan), start: text(history.start), expiry: text(history.expiry),
      created: '', customerId: '', account, accountConflict: false, confirmed: true,
      ended: ['recovered', 'retired'].includes(account.accountLifecycle?.disposition),
      operatorId: '', operatorName: '历史未记录'
    };
    record.status = statusFor(record, now);
    records.push(record);
  }
  return records;
}

function orderTime(record) {
  return instant(record.start) || instant(record.created) || 0;
}

function publicRecord(record, now) {
  return {
    source: record.source, sourceId: record.sourceId, orderNo: record.orderNo, plan: record.plan,
    start: record.start, expiry: record.expiry, status: record.status,
    remainingDays: remaining(record.expiry, now), operatorName: record.operatorName,
    confirmed: record.confirmed
  };
}

function mailboxFor(row, inventory) {
  const account = row._account;
  const orderIds = new Set(row._records.filter(record => record.source === 'order' && !record.ended)
    .map(record => record.sourceId));
  const mailboxes = array(inventory.mailboxes);
  const explicit = mailboxes.filter(mailbox => (account?.sourceMailboxId && mailbox.id === account.sourceMailboxId) ||
    array(mailbox.usageLinks).some(link => (account && link.kind === 'registration' && link.accountId === account.id) ||
      (link.kind === 'order-use' && orderIds.has(link.orderId))));
  const matches = explicit.length ? explicit : mailboxes.filter(mailbox =>
    row.registrationEmail && emailKey(mailbox.email) === emailKey(row.registrationEmail));
  if (matches.length !== 1) return { conflict: matches.length > 1 };
  const mailbox = matches[0];
  if (row.registrationEmail && emailKey(mailbox.email) !== emailKey(row.registrationEmail)) return { conflict: true };
  if (!explicit.length && array(mailbox.usageLinks).some(link =>
    (link.accountId && link.accountId !== account?.id) || (link.orderId && !orderIds.has(link.orderId))))
    return { conflict: true };
  return { mailbox };
}

function queryCodeFor(row, snapshots, now) {
  const pool = mailboxPoolItems(snapshots.mailboxes);
  const matches = pool.filter(item => emailKey(item.email) === emailKey(row.registrationEmail));
  if (matches.length !== 1) return { status: matches.length ? 'conflict' : 'missing', remainingDays: null };
  const item = matches[0], expiry = instant(item.expiresAt);
  if (!item.queryCode) return { status: 'missing', remainingDays: null };
  if (!isManagedCode(item.queryCode) || pool.filter(candidate => candidate.queryCode === item.queryCode).length !== 1 ||
      !Number.isFinite(expiry)) return { status: 'conflict', remainingDays: null };
  const status = item.authFailed ? 'auth_failed' : !item.active ? 'disabled' : expiry <= now ? 'expired' : 'active';
  return { status, remainingDays: remaining(item.expiresAt, now), expiresAt: item.expiresAt,
    value: status === 'active' ? item.queryCode : '' };
}

export function projectSubscriptions(snapshots, now = Date.now()) {
  const groups = new Map();
  for (const record of buildRecords(snapshots, now)) {
    if (!groups.has(record.id)) groups.set(record.id, []);
    groups.get(record.id).push(record);
  }
  const profiles = snapshots.subscriptions?.data || {};
  const result = [];
  for (const [id, records] of groups) {
    records.sort((a, b) => orderTime(b) - orderTime(a) || a.sourceId.localeCompare(b.sourceId));
    const activeRecords = records.filter(record => !record.ended && record.source === 'order');
    const customers = new Set(activeRecords.map(record => record.customerId).filter(Boolean));
    const accountIds = new Set(records.map(record => record.account?.id).filter(Boolean));
    let conflict = records.some(record => record.accountConflict) || customers.size > 1 || accountIds.size > 1;
    const series = new Map();
    for (const record of records) if (!series.has(record.series)) series.set(record.series, record);
    const selected = [...series.values()];
    const precedence = ['active', 'pending', 'expired', 'ended'];
    let status = conflict ? 'pending' : precedence.find(value => selected.some(record => record.status === value));
    const primary = selected.find(record => record.status === status) || selected[0];
    const account = primary.account || (primary.customerId
      ? records.find(record => !record.ended && record.customerId === primary.customerId && record.account)?.account
      : undefined);
    const currentLifecycle = account?.accountLifecycle;
    const otherCustomer = primary.customerId && records.some(record => record.customerId && record.customerId !== primary.customerId);
    if ((!account && otherCustomer) ||
        (currentLifecycle?.customerId && primary.customerId && currentLifecycle.customerId !== primary.customerId)) {
      conflict = true;
      status = 'pending';
    }
    const protectedLifecycle = currentLifecycle && ['recovered', 'retired'].includes(currentLifecycle.disposition);
    const owner = profiles.owners?.[id];
    const ownerValid = owner && (!owner.accountId || owner.accountId === account?.id) &&
      (!owner.customerId || !primary.customerId || owner.customerId === primary.customerId);
    const row = {
      id, product: primary.product, account: primary.display, registrationEmail: primary.email || text(account?.email),
      status, ownerId: ownerValid ? text(owner.ownerId) : '', ownerName: ownerValid ? text(owner.ownerName) : '',
      operatorName: primary.operatorName, accountId: account?.id || '', customerId: primary.customerId,
      conflict: Boolean(conflict),
      series: selected.map(record => ({ key: record.series, ...publicRecord(record, now) })),
      history: records.map(record => publicRecord(record, now)),
      _account: account, _records: records
    };
    const binding = status === 'ended' ? {} : mailboxFor(row, snapshots.inventory.data || {});
    row.credentialStatus = row.conflict || protectedLifecycle || binding.conflict ? 'conflict' : binding.mailbox ? 'available' : 'missing';
    if (row.credentialStatus === 'conflict') row.queryCode = { status: 'conflict', remainingDays: null };
    else if (status === 'ended') row.queryCode = { status: 'not_applicable', remainingDays: null };
    else if (row.product === 'Claude') row.queryCode = queryCodeFor(row, snapshots, now);
    else row.queryCode = { status: 'missing', remainingDays: null };
    result.push(row);
  }
  return result.sort((a, b) => a.account.localeCompare(b.account, 'zh-CN') || a.id.localeCompare(b.id));
}

function safeRow(row) {
  const { _account, _records, queryCode, ...rest } = row;
  return { ...rest, queryCode: { status: queryCode.status, remainingDays: queryCode.remainingDays,
    expiresAt: queryCode.expiresAt || null } };
}

function accountRow(snapshots, accountId) {
  const accounts = array(snapshots.inventory.data?.accounts);
  const matches = accounts.filter(account => account.id === accountId);
  const account = matches.length === 1 ? matches[0] : null;
  const product = ({ gpt: 'GPT', claude: 'Claude', gemini: 'Gemini', grok: 'Grok' })[account?.type];
  const id = subscriptionAccountId(product, account);
  if (!account || !id) throw failure(404, '未找到可管理归属的账号');
  if (accounts.filter(item => item.type === account.type && identity(item, product) === identity(account, product)).length !== 1)
    throw failure(409, '同一账号存在多条库存资料，请先核对');
  const owner = ownerForSubscriptionAccount(account, snapshots.subscriptions.data);
  return { id, product, account: account.loginMethod === 'x' && account.xHandle ? account.xHandle : text(account.email),
    registrationEmail: text(account.email), accountId: account.id, customerId: text(account.accountLifecycle?.customerId),
    ownerId: text(owner?.ownerId), ownerName: text(owner?.ownerName), conflict: false };
}

function copyRow(row, snapshots, mode, suffix) {
  if (row.conflict || row.credentialStatus === 'conflict') throw failure(409, '账号或邮箱关联存在冲突，请先核对');
  const { mailbox } = row.status === 'ended' ? {} : mailboxFor(row, snapshots.inventory.data || {});
  const account = row.status === 'ended' ? undefined : row._account;
  const fields = [['邮箱账号', row.registrationEmail]];
  if (mode === 'full') {
    fields.push(['邮箱密码', text(mailbox?.password)], ['邮箱 2FA', text(mailbox?.totp)]);
    if (row.product !== 'Claude') fields.push(['产品账号', row.account], ['产品账号密码', text(account?.password)],
      ['产品账号 2FA', text(account?.totp)]);
  }
  if (row.product === 'Claude') fields.push(['买家查询码', row.queryCode.value || '']);
  const lines = fields.filter(([, value]) => value).map(([label, value]) => `${label}：${value}`);
  if (suffix) lines.push(suffix);
  return { text: lines.join('\n'), omitted: fields.filter(([, value]) => !value).map(([label]) => label) };
}

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw failure(415, '请提交 JSON 资料');
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.byteLength;
    if (size > 24000) { request.resume(); throw failure(413, '请求内容过长'); }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* Invalid JSON uses the same response. */ }
  throw failure(400, '无法读取请求内容');
}

export function createSubscriptionHandler({ store, publicOrigin, readOwners = () => [], clock = Date.now }) {
  const generation = randomUUID();
  return async (request, response, route, actor) => {
    if (!manager(actor)) return send(response, 403, { error: '只有管理员可以查看或管理订阅资料' });
    const origin = publicOrigin || `http://${request.headers.host}`;
    if ((request.headers.origin && request.headers.origin !== origin) ||
        (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin') ||
        request.headers.origin !== origin) return send(response, 403, { error: '仅允许从当前页面使用订阅资料' });
    try {
      if (request.method !== 'POST') throw failure(405, '不支持此订阅操作');
      const body = await readBody(request);
      const action = route.slice(base.length + 1);
      const output = store.withSubscriptions(actor, (snapshots, audit, save) => {
        const now = Number(clock());
        const priorProfile = snapshots.subscriptions.data || {};
        let commandFingerprint;
        if (action === 'owner' || action === 'confirm') {
          if (typeof body.commandId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(body.commandId))
            throw failure(400, '请重新打开操作并核对资料');
          commandFingerprint = digest(JSON.stringify([action, actor.id, body.id, body.accountId || '', body.ownerId || '',
            body.orderId || '', body.reason || '', body.confirmed === true]));
          const receipt = priorProfile.commands?.[body.commandId];
          if (receipt) {
            if (receipt.fingerprint !== commandFingerprint) throw failure(409, '操作内容已变化，请重新核对');
            return { saved: true, replayed: true };
          }
        }
        const revision = digest(JSON.stringify([generation, actor.id, snapshots.commerce.version,
          snapshots.inventory.version, snapshots.mailboxes.version, snapshots.subscriptions.version]));
        const rows = projectSubscriptions(snapshots, now);
        if (action === 'account') {
          if (typeof body.accountId !== 'string' || !body.accountId || body.accountId.length > 160)
            throw failure(400, '请选择账号');
          const account = accountRow(snapshots, body.accountId);
          const existing = rows.find(item => item.id === account.id);
          if (existing?.conflict || (existing?.accountId && existing.accountId !== account.accountId))
            throw failure(409, '账号与订单关联存在冲突，请先核对');
          audit('view', [account.id]);
          return { ...account, revision };
        }
        if (action === 'lookup') {
          const order = body.order;
          if (!order || typeof order !== 'object' || Array.isArray(order) ||
              !products.has(family(order.product)) || !subscriptionAccountId(family(order.product), order) ||
              ['email', 'xHandle', 'loginMethod', 'accountId', 'customerId', 'platformAccountId'].some(key =>
                order[key] !== undefined && (typeof order[key] !== 'string' || order[key].length > 254)))
            throw failure(400, '请先核对账号和客户');
          const id = subscriptionAccountId(family(order.product), order);
          const existing = rows.find(item => item.id === id);
          if (existing?.conflict || (existing?.accountId && order.accountId && existing.accountId !== order.accountId))
            throw failure(409, '账号归属存在冲突，请先核对');
          if (order.accountId) {
            const account = accountRow(snapshots, order.accountId);
            if (account.id !== id) throw failure(409, '账号资料已变化，请重新核对');
          }
          const owner = ownerForSubscriptionOrder(order, priorProfile);
          audit('view', [id]);
          return { ownerId: text(owner?.ownerId), ownerName: text(owner?.ownerName) };
        }
        if (action === 'list') {
          const pageSize = body.pageSize ?? defaultPageSize;
          if (!products.has(body.product) || (body.status && !statuses.has(body.status)) ||
              (body.sort && !sorts.has(body.sort)) ||
              typeof (body.query ?? '') !== 'string' || (body.query || '').length > 254 ||
              !Number.isSafeInteger(body.page ?? 1) || (body.page ?? 1) < 1 ||
              !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100)
            throw failure(400, '查询筛选或分页格式不正确');
          const productRows = rows.filter(row => row.product === body.product);
          // One Grok account can have several series in different states.
          // A conflicting identity remains pending until the association is resolved.
          const hasStatus = (row, status) => row.conflict ? status === 'pending' :
            row.series.some(series => series.status === status);
          const counts = Object.fromEntries(['active', 'expired', 'pending', 'ended'].map(status =>
            [status, productRows.filter(row => hasStatus(row, status)).length]));
          const query = text(body.query).toLowerCase();
          const matching = productRows.filter(row => (!body.status || hasStatus(row, body.status)) &&
            (!query || [row.account, row.registrationEmail, row.ownerName, row.operatorName].some(value =>
              text(value).toLowerCase().includes(query))));
          const sort = body.sort || 'expiry_asc';
          const due = row => {
            const values = row.series.map(series => instant(series.expiry)).filter(Number.isFinite);
            return values.length ? Math.min(...values) : null;
          };
          matching.sort((a, b) => {
            if (sort !== 'account_asc') {
              const left = due(a), right = due(b);
              if (left === null || right === null) {
                if (left !== right) return left === null ? 1 : -1;
              } else if (left !== right) return sort === 'expiry_desc' ? right - left : left - right;
            }
            return a.account.localeCompare(b.account, 'zh-CN') || a.id.localeCompare(b.id);
          });
          const page = Math.min(body.page ?? 1, Math.max(1, Math.ceil(matching.length / pageSize)));
          const items = matching.slice((page - 1) * pageSize, page * pageSize);
          audit('view', items.map(row => row.id));
          return { items: items.map(safeRow), total: matching.length, accountCount: productRows.length, counts, page, pageSize, revision,
            now: new Date(now).toISOString() };
        }
        if (typeof body.id !== 'string' || typeof body.revision !== 'string' || body.revision !== revision)
          throw failure(409, '订阅资料已变化，请刷新后重新核对');
        let row = rows.find(item => item.id === body.id);
        if (action === 'owner' && body.accountId) {
          const account = accountRow(snapshots, body.accountId);
          if (account.id !== body.id || (row?.accountId && row.accountId !== account.accountId))
            throw failure(409, '账号资料已变化，请重新核对');
          if (!row) row = account;
        }
        if (!row) throw failure(404, '未找到订阅账号');
        if (action === 'copy') {
          if (!['short', 'full'].includes(body.mode) || (body.mode === 'short' && row.product !== 'Claude'))
            throw failure(400, '请选择复制格式');
          const settings = row.product === 'Claude' ? store.loadClaudeGoogleCopySettings(actor) : {};
          const output = copyRow(row, snapshots, body.mode, body.mode === 'short' ? settings.copy1 : settings.copy2);
          audit('copy', [row.id]);
          return output;
        }
        if (row.conflict) throw failure(409, '账号归属存在冲突，请先核对原订单及库存');
        const profile = structuredClone(snapshots.subscriptions.data || {});
        profile.owners ||= {};
        profile.confirmations ||= {};
        profile.commands ||= {};
        profile.events ||= [];
        if (action === 'owner') {
          const owner = [actor, ...readOwners()].find(item => item.id === body.ownerId && item.active !== false &&
            ['admin', 'super', 'employee'].includes(item.role));
          if (!owner) throw failure(400, '请选择仍在使用的员工');
          const previous = profile.owners[row.id] || null;
          profile.owners[row.id] = { ownerId: owner.id, ownerName: owner.name, accountId: row.accountId,
            customerId: row.customerId, actorId: actor.id, at: new Date(now).toISOString() };
          profile.events.push({ action, target: row.id, actorId: actor.id, at: new Date(now).toISOString(),
            previousOwnerId: previous?.ownerId || '', ownerId: owner.id });
          profile.commands[body.commandId] = { fingerprint: commandFingerprint };
          save(profile, 'subscription_owner', row.id);
          return { saved: true };
        }
        if (action === 'confirm') {
          const record = row._records.find(item => item.source === 'order' && item.sourceId === body.orderId);
          const order = array(snapshots.commerce.data?.orders).find(item => item.id === body.orderId);
          if (!record || !order || personalProduct(order.product) || record.confirmed || order.cancelled || !paid(order) || body.confirmed !== true)
            throw failure(400, '请先核对实际开通及付款记录');
          if (!text(body.reason) || text(body.reason).length > 300) throw failure(400, '请填写核对依据');
          const previous = profile.confirmations[order.id] || null;
          profile.confirmations[order.id] = { fingerprint: orderFingerprint(order), reason: text(body.reason),
            actorId: actor.id, at: new Date(now).toISOString() };
          profile.events.push({ action, target: row.id, orderId: order.id, actorId: actor.id,
            at: new Date(now).toISOString(), previous });
          profile.commands[body.commandId] = { fingerprint: commandFingerprint };
          save(profile, 'subscription_confirm', row.id);
          return { saved: true };
        }
        throw failure(405, '不支持此订阅操作');
      });
      return send(response, 200, output);
    } catch (error) {
      if (response.destroyed) return;
      if ([400, 403, 404, 405, 409, 413, 415].includes(error.status)) return send(response, error.status, { error: error.message });
      return send(response, 500, { error: '订阅资料读取或保存失败，请重试' });
    }
  };
}
