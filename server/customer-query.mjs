import { orderOpeningConfirmed, subscriptionPeriodState, subscriptionTime } from '../modules/orders/order-opening.mjs';
import { appleBinding, appleFundingIndex, appleRegions } from '../modules/finance/apple-funding.mjs';
import { releasedAccountOrders } from './account-lifecycle.mjs';
import { blockedOrderCard, cardFreezeDocument, cardTypeDocument, frozenOrderCard, orderCardArchiveDocument,
  orderCardHealth, orderCardHealthReference } from './card-management.mjs';
import { personalProduct, stockTypeForProduct, subscriptionSeries, targetKey } from './personal-subscriptions.mjs';
import { currentSeriesRecord, legacyOpeningOrderIds } from './subscription-management.mjs';

const base = '/api/local/customer-query/';
export const customerQueryRoutes = new Set(['search', 'detail', 'prefill', 'copy-claude'].map(action => base + action));
const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value.trim() : '';
const key = value => text(value).normalize('NFKC').toLowerCase();
const failure = (status, message) => Object.assign(new Error(message), { status });
const claude = product => product === 'Claude Pro' || product === 'Claude Max';
const products = new Set(['GPT', 'Claude Pro', 'Claude Max', 'Gemini', 'Grok']);
const orderIdentity = row => row.loginMethod === 'x' && row.xHandle ? row.xHandle : row.email || row.xHandle || '';
const orderGroup = row => {
  const target = personalProduct(row.product) ? targetKey(row) : text(row.email).toLowerCase();
  return target ? JSON.stringify([stockTypeForProduct(row.product), target,
    personalProduct(row.product) ? subscriptionSeries(row) : '']) : row.id;
};
const orderTime = row => subscriptionTime(row.start) || subscriptionTime(row.createdAt) || 0;
const isDraft = row => row.draft || ['草稿', 'draft'].includes(row.status);

function paginate(items, { page = 1, pageSize = 20 }) {
  if (!Number.isSafeInteger(page) || page < 1 || ![10, 20, 50].includes(pageSize)) throw failure(400, '分页参数无效');
  page = Math.min(page, Math.max(1, Math.ceil(items.length / pageSize)));
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize };
}

function customerIdentity(row) {
  return { id: row.id, name: text(row.name), wechat: text(row.wechat), active: row.active !== false };
}

function customerProfile(row) {
  return { ...customerIdentity(row), phone: text(row.phone), qq: text(row.qq),
    whatsapp: text(row.whatsapp), telegram: text(row.telegram), source: text(row.source),
    tags: list(row.tags).filter(value => typeof value === 'string'), notes: text(row.notes) };
}

function appleStatus(row) {
  if (!row || row.deleted) return 'unknown';
  if (row.health === 'dead' || row.health === 'unlocking') return row.health;
  return row.status === '正常' ? 'normal' : 'unavailable';
}

function bankView(order, cardTypes, cardContext) {
  if (order.payment !== '银行卡') return undefined;
  const { id, number, conflict } = orderCardHealthReference(order, cardContext);
  const health = !conflict && (id || number) ? orderCardHealth(cardTypes, id, number) : 'unknown';
  const state = !blockedOrderCard(health) && frozenOrderCard(cardContext.freezes, id, cardContext.fingerprint?.(number))
    ? 'frozen' : health;
  if (claude(order.product)) return blockedOrderCard(state) || state === 'frozen' ? { state, private: true } : undefined;
  return { state, last4: /^\d{4}$/.test(order.paymentId || '') ? order.paymentId : number.slice(-4),
    type: text(order.cardTypeName) };
}

function projection(snapshots, customer, cardTypes, now, cardContext) {
  const commerce = snapshots.commerce.data || {};
  const inventory = snapshots.inventory.data || {};
  const orders = list(commerce.orders).filter(row => row.customerId === customer.id);
  const orderIds = new Set(orders.map(row => row.id));
  const accounts = new Map(list(inventory.accounts).map(row => [row.id, row]));
  const apples = new Map(list(inventory.mailboxes).filter(row => row.type === 'apple').map(row => [row.id, row]));
  const tenants = new Map();
  for (const tenant of list(commerce.tenants)) tenants.set(tenant.id, tenants.has(tenant.id) ? null : tenant);
  const legacy = new Set(legacyOpeningOrderIds(orders, snapshots.subscriptions?.data));
  const releases = new Map();
  const groups = new Map();
  const platformIds = new Map();
  for (const order of orders) {
    if (!personalProduct(order.product) || !order.platformAccountId || isDraft(order)) continue;
    const group = orderGroup(order);
    if (!platformIds.has(group)) platformIds.set(group, new Set());
    platformIds.get(group).add(order.platformAccountId);
  }
  const rows = orders.map(order => {
    const group = orderGroup(order), knownPlatforms = platformIds.get(group);
    const ambiguousTarget = !order.platformAccountId && knownPlatforms?.size > 1;
    const account = accounts.get(order.accountId);
    if (account && !releases.has(account.id)) releases.set(account.id, releasedAccountOrders(account));
    const released = releases.get(account?.id)?.has(order.id);
    const ended = Boolean(order.subscriptionEnded || released);
    const otherCustomer = Boolean(account?.accountLifecycle?.customerId && account.accountLifecycle.customerId !== customer.id);
    const conflict = ambiguousTarget || (otherCustomer && !released);
    const cancelled = Boolean(order.cancelled || ['cancelled', '已撤单'].includes(order.status));
    const confirmed = orderOpeningConfirmed(order, now, legacy.has(order.id));
    const status = conflict ? 'pending' : subscriptionPeriodState({ start: order.start, expiry: order.expiry,
      confirmed, ended, cancelled, failed: order.entitlementStatus === 'failed' || ['failed', '失败'].includes(order.status) }, now);
    const tenant = claude(order.product) && !conflict && tenants.get(order.tenantId);
    const apple = order.payment === '苹果内购' && order.appleIdId ? apples.get(order.appleIdId) : null;
    const row = { id: order.id, orderNo: text(order.orderNo), product: text(order.product), plan: text(order.plan),
      account: text(orderIdentity(order)), email: text(order.email), start: text(order.start), expiry: text(order.expiry),
      status, conflict, businessType: text(order.businessType), payment: claude(order.product) && order.payment === '银行卡' ? '' : text(order.payment),
      bank: bankView(order, cardTypes, cardContext), cancelled, ended,
      canPrefill: !isDraft(order) && !conflict && !otherCustomer && customer.active !== false && products.has(order.product),
      refunds: list(order.refunds).map(refund => ({ at: text(refund.at || refund.time || refund.createdAt),
        amount: text(refund.amount), currency: text(refund.currency || order.saleCurrency) })),
      ...(claude(order.product) && {
        tenant: text(tenant?.name) ? { name: text(tenant.name), active: tenant.active !== false } : null,
        tenantConflict: Boolean(order.tenantId && !text(tenant?.name))
      }),
      ...(order.payment === '苹果内购' && order.appleIdId && { apple: {
        id: order.appleIdId, account: text(apple?.email), state: appleStatus(apple), bound: Boolean(order.appleFunding?.bound || order.paidConfirmed)
      } })
    };
    if (!isDraft(order)) {
      const platformId = personalProduct(order.product) && (order.platformAccountId ||
        (knownPlatforms?.size === 1 && knownPlatforms.values().next().value));
      const identity = platformId ? JSON.stringify([order.product, subscriptionSeries(order), 'platform', platformId]) : group;
      if (!groups.has(identity)) groups.set(identity, []);
      groups.get(identity).push({ row, time: orderTime(order) });
    }
    return row;
  }).sort((a, b) => (subscriptionTime(b.start) || 0) - (subscriptionTime(a.start) || 0));
  const accountRows = [...groups.values()].map(history => {
    history.sort((a, b) => b.time - a.time);
    const current = currentSeriesRecord(history.map(({ row }) => row));
    const bindings = new Map();
    for (const { row } of history) if (row.apple?.bound || (row.apple && row === current))
      bindings.set(row.apple.id, { ...row.apple, historical: current.apple?.id !== row.apple.id });
    return { ...current, appleBindings: [...bindings.values()], copyClaude: claude(current.product) &&
      !current.conflict && Boolean(current.email && current.tenant?.name) };
  });
  const represented = new Set(accountRows.map(row => JSON.stringify([stockTypeForProduct(row.product), key(row.account)])));
  for (const account of accounts.values()) {
    if (account.accountLifecycle?.customerId !== customer.id && !list(account.usageLinks).some(link => orderIds.has(link.orderId))) continue;
    if (account.accountLifecycle?.customerId && account.accountLifecycle.customerId !== customer.id) continue;
    const identity = orderIdentity(account), history = account.claudeHistory;
    if (!identity || represented.has(JSON.stringify([account.type, key(identity)]))) continue;
    const product = { gpt: 'GPT', claude: 'Claude', gemini: 'Gemini', grok: 'Grok' }[account.type];
    if (!product) continue;
    const confirmed = history?.phase === 'opened' || (history?.phase === 'dead' && Boolean(history.start && history.expiry));
    const status = subscriptionPeriodState({ start: history?.start, expiry: history?.expiry, confirmed,
      ended: ['recovered', 'retired'].includes(account.accountLifecycle?.disposition) }, now);
    accountRows.push({ id: account.id, product, account: identity, email: text(account.email), plan: text(history?.plan),
      start: text(history?.start), expiry: text(history?.expiry), status, canPrefill: false,
      ...(product === 'Claude' && { tenant: null }) });
  }
  const warnings = accountRows.flatMap(row => [
    ...(blockedOrderCard(row.bank?.state) || row.bank?.state === 'frozen' ? [{ account: row.account, kind: 'bank', state: row.bank.state, private: row.bank.private }] : []),
    ...(row.appleBindings || []).filter(item => ['dead', 'unlocking'].includes(item.state)).map(item =>
      ({ account: row.account, kind: 'apple', state: item.state, apple: item.account, historical: item.historical, bound: item.bound }))
  ]);
  const related = list(commerce.logs).filter(log => log.entityId === customer.id || orderIds.has(log.entityId))
    .map(log => ({ id: log.id, type: text(log.type), at: text(log.at), actor: text(log.actor) }));
  // A contact match can prompt review, but cannot disclose or assign the old order.
  const wechat = key(customer.wechat);
  const unresolved = wechat ? list(commerce.orders).filter(order => !order.customerId && key(order.wechat) === wechat).length : 0;
  return { orders, rows, accountRows, warnings, related, unresolved, apples, tenants };
}

export function customerQuery(snapshots, cards, action, body, now = Date.now(), cardContext = {}) {
  const customers = list(snapshots.commerce.data?.customers);
  if (action === 'search') {
    const query = key(body.query);
    if (!query || query.length > 160) throw failure(400, '请输入客户姓名或微信（最多 160 字）');
    const matches = customers.filter(row => key(row.name).includes(query) || key(row.wechat).includes(query));
    matches.sort((a, b) => Number(key(b.wechat) === query) - Number(key(a.wechat) === query) ||
      text(a.name).localeCompare(text(b.name), 'zh-CN') || a.id.localeCompare(b.id));
    return paginate(matches.map(customerIdentity), body);
  }
  const customer = customers.find(row => row.id === body.customerId);
  if (!customer) throw failure(404, '未找到此客户');
  const data = projection(snapshots, customer, cards, now, cardContext);
  if (action === 'detail') {
    const tabs = { accounts: data.accountRows, orders: data.rows, records: data.related };
    if (!Object.hasOwn(tabs, body.tab)) throw failure(400, '请选择查询内容');
    return { customer: customerProfile(customer), warnings: data.warnings, unresolved: data.unresolved,
      ...paginate(tabs[body.tab], body) };
  }
  const order = data.orders.find(row => row.id === body.orderId);
  if (body.orderId && !order) throw failure(404, '该订单不属于当前客户');
  if (action === 'copy-claude') {
    const row = data.accountRows.find(row => row.id === body.orderId && row.copyClaude);
    if (!row) throw failure(409, 'Claude 账号或租户关联待核对');
    return { text: `${row.email}----${row.tenant.name}` };
  }
  const product = order?.product || body.product;
  if (!products.has(product) || customer.active === false) throw failure(409, '请选择可用的客户与订单产品');
  const values = { product, customerId: customer.id, wechat: text(customer.wechat), customerPhone: text(customer.phone),
    qq: text(customer.qq), whatsapp: text(customer.whatsapp), telegram: text(customer.telegram) };
  if (!order) return { values };
  const row = data.rows.find(row => row.id === order.id);
  if (!row?.canPrefill) throw failure(409, '订单与账号关联待核对');
  const apple = order.payment === '苹果内购' && order.appleIdId && data.apples.get(order.appleIdId);
  const ledger = snapshots.appleBalance?.data || {};
  const wallet = apple && list(ledger.wallets).find(item => item.id === apple.id);
  const binding = apple && appleBinding(appleFundingIndex(snapshots.commerce.data.orders, ledger), order);
  const useApple = apple && appleStatus(apple) === 'normal' && wallet?.currency === 'USD' && binding?.id === apple.id &&
    !binding.conflict && Object.hasOwn(appleRegions, apple.appStoreRegion);
  const bank = orderCardHealthReference(order, cardContext);
  const bankBlocked = bank.conflict || blockedOrderCard(row.bank?.state) || row.bank?.state === 'frozen' ||
    ['冻结', '停用', 'frozen', 'disabled'].includes(text(order.cardStatus).toLowerCase());
  const poolCard = !bankBlocked && bank.id.startsWith('recharge:');
  const tenant = claude(product) && data.tenants.get(order.tenantId);
  const tenantCard = !bankBlocked && row.tenant?.active && bank.id.startsWith('tenant:');
  return { values: { ...values, plan: text(order.plan), email: text(order.email),
    ...(personalProduct(product) && { loginMethod: text(order.loginMethod), xHandle: text(order.xHandle),
      xLinkState: text(order.xLinkState), platformAccountId: text(order.platformAccountId), personalHistoryId: order.id }),
    ...(tenant && row.tenant?.active && { tenantId: tenant.id }),
    ...(useApple && { payment: '苹果内购',
      appleIdId: apple.id, appleStoreRegion: text(apple.appStoreRegion) }),
    ...(poolCard && (claude(product) ? { proMaterialMode: 'pool_card', proPoolCardId: bank.id } : { cardId: bank.id })),
    ...(tenantCard && { proMaterialMode: 'tenant_card', cardId: bank.id })
  }, orderNo: row.orderNo };
}

export function createCustomerQueryHandler({ store, publicOrigin, clock = Date.now }) {
  return async (request, response, route, actor) => {
    const send = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
      response.end(JSON.stringify(data));
    };
    if (request.method !== 'POST') return send(405, { error: '请提交查询条件' });
    if (!actor?.id || !['admin', 'super'].includes(actor.role) || request.headers.origin !== (publicOrigin || `http://${request.headers.host}`) ||
        request.headers['sec-fetch-site'] === 'cross-site' || !/^application\/json(?:;|$)/i.test(request.headers['content-type'] || ''))
      return send(403, { error: '没有查询客户资料的权限' });
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        if ((size += chunk.length) > 8192) throw failure(400, '查询参数过长');
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw failure(400, '查询参数无效'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure(400, '查询参数无效');
      const action = route.slice(base.length);
      const result = store.withSubscriptions(actor, (snapshots, audit) => {
        const input = action === 'prefill' ? { ...snapshots, appleBalance: store.load('appleBalance') } : snapshots;
        const cardContext = action === 'search' ? {} : {
          archive: store.featureDocument(orderCardArchiveDocument).data,
          tenantCards: store.featureDocument('tenant-cards').data?.items || [],
          freezes: store.featureDocument(cardFreezeDocument).data,
          fingerprint: number => store.orderCardFingerprint?.(number)
        };
        const output = customerQuery(input, store.featureDocument(cardTypeDocument).data, action, body, clock(), cardContext);
        if (action === 'copy-claude') audit('copy', [body.orderId]);
        return output;
      });
      return send(200, result);
    } catch (error) {
      const status = [400, 403, 404, 409].includes(error.status) ? error.status : 500;
      return send(status, { error: status === 500 ? '客户资料读取失败，请重试' : error.message });
    }
  };
}
