import { createHash, randomUUID } from 'node:crypto';

import { defaultSubscriptionSort, firstRecordTime, sortByRecordTime } from '../frontend/list-order.mjs';
import {
  orderOpeningConfirmed, subscriptionChainRoot, validOrderEmail, validOrderXHandle,
  rechargeRenewalExpiryPending, subscriptionDuration, subscriptionPeriodState, subscriptionStateLabels, subscriptionTime as instant
} from '../frontend/order-opening.mjs';
import { accountMarkedDead, releasedAccountOrders } from './account-lifecycle.mjs';
import { isClaudeHistoricalSale } from './claude-history-intake.mjs';
import { personalProduct, subscriptionSeries, targetKey } from './personal-subscriptions.mjs';
import { isManagedCode, mailboxPoolItems } from './tools/mailbox-pool.mjs';

export const subscriptionDomain = 'subscription-management';
const base = '/api/local/subscriptions';
export const subscriptionRoutes = new Set(['list', 'account', 'lookup', 'copy', 'contact-copy', 'renewal-settings', 'confirm', 'owner'].map(action => `${base}/${action}`));
const products = new Set(['GPT', 'Claude', 'Gemini', 'Grok']);
const statuses = new Set(Object.keys(subscriptionStateLabels));
const sorts = new Set(['recent', 'expiry_asc', 'expiry_desc', 'account_asc']);
const subscriptionScopes = ['all', 'customer', 'owned', 'unlinked', 'upcoming', 'expired', 'dead'];
const archiveScopes = new Set(['expired', 'dead']);
const defaultPageSize = 20;
const day = 86_400_000;
const array = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value.trim() : '';
const emailKey = value => text(value).toLowerCase();
const family = product => ['Claude Pro', 'Claude Max'].includes(product) ? 'Claude' : product;
const stockType = product => ({ GPT: 'gpt', Claude: 'claude', Gemini: 'gemini', Grok: 'grok' })[product];
const manager = actor => Boolean(actor?.id && ['admin', 'super'].includes(actor.role));
const contactChannels = ['phone', 'wechat', 'qq', 'whatsapp', 'telegram'];
const failure = (status, message) => Object.assign(new Error(message), { status });
const digest = value => createHash('sha256').update(value).digest('base64url');

function identity(row, product) {
  if (product === 'Grok' && (row?.loginMethod === 'x' || (!row?.email && row?.xHandle)))
    return validOrderXHandle(row.xHandle) ? targetKey(row) : '';
  return validOrderEmail(row?.email) ? `email:${emailKey(row.email)}` : '';
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

function legacyOpeningConfirmed(order, profiles) {
  const saved = profiles?.confirmations?.[order?.id]?.fingerprint;
  return Boolean(saved && saved === orderFingerprint(order));
}

export function legacyOpeningOrderIds(orders, profiles) {
  if (!profiles?.confirmations) return [];
  return array(orders).filter(order => legacyOpeningConfirmed(order, profiles)).map(order => order.id);
}

export function ownerForSubscriptionOrder(order, profiles, commerce, inventory, now = Date.now()) {
  const product = family(order?.product);
  const key = subscriptionAccountId(product, order);
  const owner = profiles?.owners?.[key];
  const matchesAccount = owner?.accountId ? order?.accountId === owner.accountId :
    !order?.accountId && owner?.customerId && owner.customerId === order?.customerId;
  if (!matchesAccount || !owner?.ownerId || (owner.customerId && owner.customerId !== order.customerId)) return null;
  const account = array(inventory?.accounts).find(item => item.id === owner.accountId);
  if (account && ['recovered', 'retired'].includes(account.accountLifecycle?.disposition)) return null;
  const released = releasedAccountOrders(account || {});
  const confirmedOrder = array(commerce?.orders).some(candidate =>
    !candidate.cancelled && !candidate.subscriptionEnded && !released.has(candidate.id) &&
    subscriptionAccountId(family(candidate.product), candidate) === key &&
    candidate.customerId === order.customerId && (!candidate.accountId || candidate.accountId === order.accountId) &&
    openingConfirmed(candidate, profiles, now));
  const confirmedHistory = product === 'Claude' && account?.claudeHistory?.phase === 'opened';
  return confirmedOrder || confirmedHistory ? owner : null;
}

function openingConfirmed(order, profiles, now) {
  return orderOpeningConfirmed(order, now, legacyOpeningConfirmed(order, profiles));
}

function paid(order) {
  return order.paidConfirmed === true || array(order.financialEvidence).some(item =>
    item?.kind === 'payment' && typeof item.amount === 'string' && /[1-9]/.test(item.amount));
}

function remaining(expiry, now) {
  const end = instant(expiry);
  return Number.isFinite(end) ? Math.max(0, Math.ceil((end - now) / day)) : null;
}

function accountMatches(order, account, product) {
  return account?.type === stockType(product) && identity(account, product) === identity(order, product) &&
    (!order.platformAccountId || !account.platformAccountId || order.platformAccountId === account.platformAccountId);
}

// A unique same-platform login can prove health without granting access to inventory credentials.
function healthAccount(order, product, accounts, linked) {
  if (linked || !identity(order, product)) return linked;
  const matches = accounts.filter(account => (!order.accountId || account.id === order.accountId) &&
    accountMatches(order, account, product));
  return matches.length === 1 ? matches[0] : undefined;
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
  const customers = snapshots.commerce.data?.customers;
  const customerIds = Array.isArray(customers) ? new Set(customers.map(row => row.id)) : null;
  const orderById = new Map(orders.map(order => [order.id, order]));
  const customersById = new Map(array(customers).map(row => [row.id, row]));
  const ids = new Map();
  for (const order of orders) ids.set(order?.id, (ids.get(order?.id) || 0) + 1);
  const records = [];
  for (const order of orders) {
    const product = family(order?.product);
    if (!products.has(product) || !text(order.id) || order.draft || ['draft', '草稿'].includes(order.status)) continue;
    const accountIdentity = identity(order, product);
    const root = subscriptionChainRoot(order, orderById);
    const anchor = root.subscriptionAnchor || (!identity(root, product) ? root.id : '');
    const id = anchor ? digest(`${product}\0unresolved-order:${anchor}`) : subscriptionAccountId(product, root);
    const confirmed = openingConfirmed(order, profiles, now);
    if (!confirmed && !paid(order)) continue;
    const missingCustomer = !text(order.customerId) || Boolean(customerIds && !customerIds.has(order.customerId));
    const missingAssociation = !accountIdentity || missingCustomer;
    const match = resolveAccount(order, product, accounts);
    const health = healthAccount(order, product, accounts, match.account);
    const released = match.account && releasedAccountOrders(match.account).has(order.id);
    const historicalSale = isClaudeHistoricalSale(order, match.account);
    const ended = order.subscriptionEnded === true || Boolean(released);
    const customer = customersById.get(order.customerId);
    const contacts = Object.fromEntries(contactChannels.map(channel => [
      channel, text(customer?.[channel]) || text(order[channel === 'phone' ? 'customerPhone' : channel])
    ]).filter(([, value]) => value));
    const nextCard = profiles.renewalCards?.[renewalCardKey(id, seriesFor(order))];
    const tail = /^\d{4}(?:\d{2})?$/.test(order.paymentId) ? order.paymentId.slice(-4) : '';
    const record = {
      id, product, sourceId: order.id, source: 'order', orderNo: text(order.orderNo) || text(order.id),
      target: accountIdentity, display: !accountIdentity ? '' : order.loginMethod === 'x' && order.xHandle
        ? text(order.xHandle) : text(order.email) || text(order.xHandle),
      email: validOrderEmail(order.email) ? text(order.email) : '', series: seriesFor(order),
      plan: text(order.plan), start: text(order.start), expiry: text(order.expiry),
      created: text(order.createdAt), customerId: text(order.customerId), account: match.account,
      customerName: text(customer?.name || order.customerName), wechat: text(customer?.wechat || order.wechat), contacts,
      payment: text(order.payment), appleIdId: text(order.appleIdId),
      last4: order.payment === '银行卡' ? nextCard?.last4 || tail : '',
      hasCard: order.payment === '银行卡' && Boolean(nextCard || order.cardId || order.proCardNumber || tail),
      delivered: order.businessType === '成品交付' && Boolean(match.account?.id && match.account.id === order.accountId),
      historicalSale,
      healthId: health?.id, dead: confirmed && accountMarkedDead(health), healthChangedAt: text(health?.healthChangedAt),
      missingAssociation, missingCustomer, accountConflict: Boolean(match.conflict || ids.get(order.id) !== 1),
      confirmed, ended, renewalExpiryPending: rechargeRenewalExpiryPending(order),
      cancelled: order.cancelled === true || ['cancelled', '已撤单'].includes(order.status),
      failed: order.entitlementStatus === 'failed' || ['failed', '失败'].includes(order.status),
      orderOwner: text(order.owner) ||
        (order.createdById && (order.ownerId || order.rechargeOwnerId || order.createdById) === order.createdById ? text(order.createdBy) : ''),
      operatorId: order.source === '线上代充' ? '' : text(order.createdById),
      operatorName: order.source === '线上代充' ? '系统自动' : text(order.createdBy) || '历史未记录'
    };
    record.status = subscriptionPeriodState(record, now);
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
      healthId: account.id, dead: accountMarkedDead(account), healthChangedAt: text(account.healthChangedAt),
      ended: ['recovered', 'retired'].includes(account.accountLifecycle?.disposition),
      operatorId: '', operatorName: '历史未记录'
    };
    record.status = subscriptionPeriodState(record, now);
    records.push(record);
  }
  return records;
}

function orderTime(record) {
  return instant(record.start) || instant(record.created) || 0;
}

function currentSeriesRecord(records) {
  const [latest, ...earlier] = records;
  if (latest.renewalExpiryPending && !latest.missingCustomer && !latest.ended && !latest.cancelled) return latest;
  if (!latest.missingCustomer && !['pending', 'failed', 'scheduled', 'opened'].includes(latest.status))
    return latest;
  for (const record of earlier) {
    if (record.ended) break;
    if (record.status === 'active' && !record.missingCustomer) return record;
  }
  return latest;
}

function publicRecord(record, now) {
  return {
    source: record.source, sourceId: record.sourceId, orderNo: record.orderNo, plan: record.plan,
    start: record.start, expiry: record.expiry, status: record.status,
    remainingDays: record.ended ? 0 : remaining(record.expiry, now), operatorName: record.operatorName,
    confirmed: record.confirmed, missingAssociation: Boolean(record.missingAssociation),
    customerName: record.customerName || '', wechat: record.wechat || '',
    payment: record.payment || '', last4: record.last4 || '', hasCard: Boolean(record.hasCard),
    appleIdId: record.appleIdId || '',
    ...(record.renewalExpiryPending && { renewalExpiryPending: true })
  };
}

function mailboxFor(row, inventory) {
  if (row.product === 'GPT' && !row.customerId) return {};
  const account = row._account;
  const orderIds = new Set(row._records.filter(record => record.source === 'order' && record.confirmed &&
      !record.ended && !record.cancelled && !record.missingAssociation && record.customerId === row.customerId)
    .map(record => record.sourceId));
  const mailboxes = array(inventory.mailboxes);
  const explicit = mailboxes.filter(mailbox => (account?.sourceMailboxId && mailbox.id === account.sourceMailboxId) ||
    array(mailbox.usageLinks).some(link => (account && link.kind === 'registration' && link.accountId === account.id) ||
      (link.kind === 'order-use' && orderIds.has(link.orderId))));
  const matches = explicit.length || account?.acquisitionMethod ? explicit : mailboxes.filter(mailbox =>
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
    records.sort((a, b) => orderTime(b) - orderTime(a) || (instant(b.created) || 0) - (instant(a.created) || 0) ||
      (instant(b.expiry) || 0) - (instant(a.expiry) || 0) || a.sourceId.localeCompare(b.sourceId));
    const activeRecords = records.filter(record => !record.ended && !record.cancelled && record.source === 'order');
    const customers = new Set(activeRecords.map(record => record.customerId).filter(Boolean));
    const accountIds = new Set(records.map(record => record.account?.id).filter(Boolean));
    const historyAccounts = new Set(records.filter(record => record.source === 'history').map(record => record.sourceId));
    const healthIds = new Set(records.map(record => record.healthId).filter(Boolean));
    const dead = healthIds.size === 1 && records.some(record => record.dead);
    const delivered = records.some(record => record.delivered && record.confirmed && !record.cancelled &&
      (!record.missingAssociation || record.historicalSale) && historyAccounts.has(record.account?.id));
    const scope = !records.some(record => record.target) ? 'unlinked' : historyAccounts.size && !delivered ? 'owned' : 'customer';
    let conflict = records.some(record => record.accountConflict) || customers.size > 1 || accountIds.size > 1 ||
      (scope === 'owned' && activeRecords.some(record => record.confirmed && record.customerId));
    const series = new Map();
    const currentRecords = historyAccounts.size
      ? records.filter(record => record.source === (scope === 'owned' ? 'history' : 'order'))
      : records;
    for (const record of currentRecords) {
      if (!series.has(record.series)) series.set(record.series, []);
      series.get(record.series).push(record);
    }
    const selected = [...series.values()].map(currentSeriesRecord);
    const precedence = ['active', 'opened', 'scheduled', 'pending', 'failed', 'expired', 'ended'];
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
    const missingAssociation = scope === 'unlinked' || Boolean(primary.missingAssociation);
    if (dead) status = 'dead';
    const ownerEligible = !dead && !conflict && !missingAssociation && !protectedLifecycle && currentRecords.some(record => record.confirmed && !record.ended &&
      !record.cancelled && (record.source === 'history' || (record.customerId && record.customerId === primary.customerId)));
    const ownerValid = ownerEligible && owner && (!owner.accountId || owner.accountId === account?.id) &&
      (!owner.customerId || !primary.customerId || owner.customerId === primary.customerId);
    const knownIdentity = primary.display ? primary : records.find(record => record.display);
    const row = {
      id, product: primary.product, account: knownIdentity?.display || '', registrationEmail: knownIdentity?.email || text(account?.email),
      scope, status, ownerId: ownerValid ? text(owner.ownerId) : '',
      ownerName: ownerValid ? text(owner.ownerName) : scope === 'unlinked' ? primary.orderOwner : '',
      operatorName: primary.operatorName, accountId: account?.id || '', customerId: primary.customerId,
      customerName: primary.customerName || '', wechat: primary.wechat || '',
      contacts: conflict ? {} : primary.contacts || {},
      conflict: Boolean(conflict), missingAssociation, ownerEligible,
      series: selected.map(record => ({ key: record.series, ...publicRecord(record, now),
        ...(dead && { status: 'dead', remainingDays: 0 }) })),
      history: records.map(record => publicRecord(record, now)),
      _account: account, _records: records
    };
    const closed = status === 'ended' || status === 'dead';
    const binding = closed || missingAssociation ? {} : mailboxFor(row, snapshots.inventory.data || {});
    row.credentialStatus = row.conflict || missingAssociation || protectedLifecycle || binding.conflict
      ? 'conflict' : binding.mailbox ? 'available' : 'missing';
    if (closed) row.queryCode = { status: 'not_applicable', remainingDays: null };
    else if (row.credentialStatus === 'conflict') row.queryCode = { status: 'conflict', remainingDays: null };
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

function hasStatus(row, status) {
  if (row.status === 'dead') return status === 'dead';
  return row.series.some(series => series.status === status);
}

function matchesScope(row, scope, now = Date.now(), hours = 72) {
  if (scope === 'all') return true;
  if (scope === 'upcoming') return row.series.some(series => series.status === 'active' &&
    instant(series.expiry) <= now + hours * 3_600_000);
  if (archiveScopes.has(scope)) return hasStatus(row, scope);
  return row.scope === scope && (scope === 'unlinked' ||
    (row.status !== 'dead' && (row.conflict || row.series.some(series => series.status !== 'expired'))));
}

export const renewalCardKey = (id, series) => JSON.stringify([id, series]);

export function subscriptionForOrder(snapshots, orderId, now) {
  for (const row of projectSubscriptions(snapshots, now)) {
    const series = row.series.find(item => item.source === 'order' && item.sourceId === orderId);
    if (series) return { row, series };
  }
}

function listSeries(row, scope) {
  if (scope === 'expired') return row.series.filter(series => series.status === 'expired');
  if ((scope === 'customer' || scope === 'owned') && !row.conflict)
    return row.series.filter(series => series.status !== 'expired');
  return row.series;
}

function subscriptionListTime(row, scope, sort, upcomingEnd) {
  if (sort === 'recent') {
    if (scope === 'dead') {
      const changes = row._records.filter(record => record.dead)
        .map(record => instant(record.healthChangedAt)).filter(Number.isFinite);
      if (changes.length) return Math.max(...changes);
    }
    const records = row._records.filter(record => !record.cancelled);
    return (records.length ? records : row._records).reduce((latest, record) => {
      const time = scope === 'unlinked' ? firstRecordTime(record.created, record.start)
        : firstRecordTime(record.start, record.created);
      return time === null ? latest : Math.max(latest ?? time, time);
    }, null);
  }
  const series = listSeries(row, scope);
  const dates = (scope === 'upcoming' ? series.filter(item => item.status === 'active' &&
    instant(item.expiry) <= upcomingEnd) : series).map(item => instant(item.expiry)).filter(Number.isFinite);
  if (!dates.length) return null;
  return scope === 'expired' && sort === 'expiry_desc' ? Math.max(...dates) : Math.min(...dates);
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
  return { id, product, account: account.loginMethod === 'x' && account.xHandle ? account.xHandle : text(account.email),
    registrationEmail: text(account.email), accountId: account.id, customerId: text(account.accountLifecycle?.customerId),
    ownerId: '', ownerName: '', conflict: false };
}

function copyRow(row, snapshots, mode, suffix) {
  if (row.conflict || row.credentialStatus === 'conflict') throw failure(409, '账号或邮箱关联存在冲突，请先核对');
  const closed = row.status === 'ended' || row.status === 'dead';
  const { mailbox } = closed ? {} : mailboxFor(row, snapshots.inventory.data || {});
  const account = closed || (row.product === 'GPT' && !row.customerId) ? undefined : row._account;
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
          const owner = existing?.ownerEligible &&
            ownerForSubscriptionOrder(order, priorProfile, snapshots.commerce.data, snapshots.inventory.data, now);
          audit('view', [id]);
          return { ownerId: text(owner?.ownerId), ownerName: text(owner?.ownerName) };
        }
        if (action === 'list') {
          const pageSize = body.pageSize ?? defaultPageSize;
          const scope = body.scope;
          if ((body.product !== 'all' && !products.has(body.product)) || (body.status && !statuses.has(body.status)) ||
              (body.sort && !sorts.has(body.sort)) ||
              (scope !== undefined && !subscriptionScopes.includes(scope)) ||
              typeof (body.query ?? '') !== 'string' || (body.query || '').length > 254 ||
              !Number.isSafeInteger(body.page ?? 1) || (body.page ?? 1) < 1 ||
              !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100)
            throw failure(400, '查询筛选或分页格式不正确');
          const allProductRows = rows.filter(row => body.product === 'all' || row.product === body.product);
          const hours = snapshots.commerce.data?.renewalWarningHours ??
            (snapshots.commerce.data?.renewalWarningDays || 3) * 24;
          const inScope = (row, value) => matchesScope(row, value, now, hours);
          const scopeCounts = Object.fromEntries(subscriptionScopes.map(value =>
            [value, allProductRows.filter(row => inScope(row, value)).length]));
          const productRows = scope ? allProductRows.filter(row => inScope(row, scope)) : allProductRows;
          const accounts = scope === 'customer' || scope === 'owned'
            ? allProductRows.filter(row => row.scope === scope) : productRows;
          const counts = Object.fromEntries([...statuses].map(status =>
            [status, accounts.filter(row => hasStatus(row, status)).length]));
          const query = text(body.query).toLowerCase();
          const matching = productRows.filter(row => (!body.status || hasStatus(row, body.status)) &&
            (!query || [row.account, row.registrationEmail, row.ownerName, row.operatorName, row.customerName, ...Object.values(row.contacts),
              ...row.series.map(series => series.last4),
              ...row.history.map(record => record.orderNo)].some(value => text(value).toLowerCase().includes(query))));
          const sort = body.sort || defaultSubscriptionSort(scope);
          const ordered = sort === 'account_asc'
            ? matching.sort((a, b) => a.account.localeCompare(b.account, 'zh-CN') || a.id.localeCompare(b.id))
            : sortByRecordTime(matching, row => subscriptionListTime(row, scope, sort, now + hours * 3_600_000),
              sort === 'expiry_asc' ? 'asc' : 'desc');
          const page = Math.min(body.page ?? 1, Math.max(1, Math.ceil(matching.length / pageSize)));
          const items = ordered.slice((page - 1) * pageSize, page * pageSize);
          audit('view', items.map(row => row.id));
          return { items: items.map(row => ({ ...safeRow(row), series: listSeries(row, scope),
            ...(scope === 'expired' && { status: 'expired' }) })), total: matching.length,
            accountCount: accounts.filter(row => Boolean(row.account)).length, scopeCounts, counts, page, pageSize, revision,
            now: new Date(now).toISOString() };
        }
        if (action === 'renewal-settings') {
          const existing = snapshots.subscriptions.data || {};
          const suffixes = existing.renewalSuffixes || {};
          if (body.suffix === undefined) return { suffix: suffixes[actor.id] || '' };
          if (typeof body.suffix !== 'string' || body.suffix.length > 1000)
            throw failure(400, '续费提醒话术最多 1000 个字');
          const suffix = body.suffix.trim();
          save({ ...existing, renewalSuffixes: { ...suffixes, [actor.id]: suffix } }, 'subscription_renewal_suffix', actor.id);
          return { suffix };
        }
        if (action === 'contact-copy') {
          const target = subscriptionForOrder(snapshots, body.orderId, now);
          if (!target || target.row.conflict || (body.id && target.row.id !== body.id))
            throw failure(409, '订阅或客户关联已变化，请重新选择');
          const { row, series } = target;
          if (!series.confirmed) throw failure(409, '该订单未登记开通');
          const format = value => Number.isFinite(instant(value)) ? new Intl.DateTimeFormat('sv-SE', {
            timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short'
          }).format(instant(value)) : '';
          const duration = subscriptionDuration(series.expiry, now);
          const lines = [['账号', row.account],
            ['订阅套餐', series.plan], ['订阅时间', format(series.start)], ['到期时间', format(series.expiry)],
            ['到期提醒', duration]].filter(([, value]) => value).map(([label, value]) => label + '：' + value);
          const suffix = snapshots.subscriptions.data?.renewalSuffixes?.[actor.id];
          if (suffix) lines.push(suffix);
          audit('contact_copy', [row.id]);
          return { text: lines.join('\n') };
        }
        if (typeof body.id !== 'string' || typeof body.revision !== 'string' || body.revision !== revision)
          throw failure(409, '订阅资料已变化，请刷新后重新核对');
        let row = rows.find(item => item.id === body.id);
        if (action === 'owner' && body.accountId) {
          const account = accountRow(snapshots, body.accountId);
          if (account.id !== body.id || (row?.accountId && row.accountId !== account.accountId))
            throw failure(409, '账号资料已变化，请重新核对');
        }
        if (action === 'owner' && !row?.ownerEligible)
          throw failure(409, '确认订阅成功后才能设置归属人');
        if (!row) throw failure(404, '未找到订阅账号');
        if (action === 'copy') {
          if (!['short', 'full'].includes(body.mode) || (body.mode === 'short' && row.product !== 'Claude'))
            throw failure(400, '请选择复制格式');
          const settings = row.product === 'Claude' ? store.loadClaudeGoogleCopySettings(actor) : {};
          const output = copyRow(row, snapshots, body.mode, body.mode === 'short' ? settings.copy1 : settings.copy2);
          audit('copy', [row.id]);
          return output;
        }
        if (row.conflict || row.missingAssociation) throw failure(409, '请先补齐或核对原订单的账号与客户关联');
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
          if (row.status === 'dead' || !record || !order || personalProduct(order.product) || record.confirmed || order.cancelled ||
              !paid(order) || body.confirmed !== true)
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
