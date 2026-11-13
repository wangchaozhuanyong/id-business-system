import { createHash, randomUUID } from 'node:crypto';
import { managesBusiness } from './access-roles.mjs';
import { moneyUnits, validMoney } from './order-policy.mjs';
import { validCurrencyCode } from '../modules/finance/accounting.mjs';
import { orderOpeningConfirmed, subscriptionChainRoot, subscriptionTime,
  validOrderEmail, validOrderXHandle } from '../frontend/order-opening.mjs';
import { personalProduct, subscriptionSeries, targetKey } from './personal-subscriptions.mjs';
import { describeWriteOperation } from './write-operation.mjs';
import { readPoolCards } from './order-recharge-client.mjs';
import { accountMarkedDead, releasedAccountOrders } from './account-lifecycle.mjs';
import { legacyOpeningOrderIds, ownerForSubscriptionOrder, subscriptionDomain } from './subscription-management.mjs';
import { tenantCardUseHistory } from './tenant-initial-cards.mjs';
import { parseV2DateTimeInput } from '../modules/time/dateTime.ts';
import { appleFundingEligibility, appleFundingIndex } from '../frontend/apple-funding.mjs';
import { cardFreezeDocument, blockedOrderCard, frozenOrderCard, orderCardHealth,
  cardTypeDocument, orderCardArchiveDocument, orderCardHealthReference } from './card-management.mjs';

export const renewalHandoffDomain = 'renewal-handoffs';
export const renewalHandoffPath = '/api/local/renewals';
const products = new Set(['GPT', 'Claude Pro', 'Claude Max', 'Gemini', 'Grok']);
const states = new Set(['pending', 'processing', 'paid', 'returned', 'complete']);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const text = (value, limit = 120) => typeof value === 'string' && value.length <= limit && !/[\p{Cc}\p{Cf}]/u.test(value)
  ? value.trim() : '';
const bank = '银行卡', apple = '苹果内购';
const financeRole = actor => ['finance', 'super'].includes(actor?.role);
export const renewalRole = actor => ['admin', 'super', 'employee', 'supervisor', 'finance'].includes(actor?.role);
const manualSource = '管理员手工';
const credit = (value, currency) => validMoney(value) && validCurrencyCode(currency);
const capturedFields = ['product', 'plan', 'customerId', 'email', 'xHandle', 'loginMethod', 'accountId', 'tenantId',
  'start', 'expiry', 'payment', 'paymentId', 'appleIdId', 'appleStoreRegion', 'platformAccountId', 'cardId', 'billingChannel'];
const dateInput = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value) &&
  Boolean(parseV2DateTimeInput(value));
const displayTime = time => new Date(time).toISOString();

function originalStamp(order, store) {
  return createHash('sha256').update(JSON.stringify([
    ...capturedFields.map(field => order[field] ?? ''),
    store.orderCardFingerprint(order.proCardNumber)
  ])).digest('base64url');
}

function originalOrderContext(commerce, inventory, profiles, store, now) {
  const orders = commerce?.orders || [];
  const byId = new Map(orders.map(row => [row.id, row]));
  const customers = new Map((commerce?.customers || []).filter(row => row.active !== false).map(row => [row.id, row]));
  const decisions = new Map();
  const accounts = new Map((inventory?.accounts || []).map(row => [row.id, row]));
  const operations = new Map(commerce?.operating || []);
  const released = new Set([...accounts.values()].flatMap(row => [...releasedAccountOrders(row)]));
  const legacy = new Set(legacyOpeningOrderIds(orders, profiles));
  const opened = row => orderOpeningConfirmed(row, now, legacy.has(row.id));
  const owners = new Map();
  for (const row of commerce?.logs || []) {
    if (['拒续费', '恢复续费提醒'].includes(row.type) && !decisions.has(row.entityId))
      decisions.set(row.entityId, row.type);
  }
  const latest = new Map(), linked = new Set();
  const keyOf = row => {
    const root = subscriptionChainRoot(row, byId);
    const family = row.product?.startsWith('Claude') ? 'Claude' : personalProduct(row.product)
      ? subscriptionSeries(row) : row.product;
    return JSON.stringify([row.customerId, family, targetKey(root) || root.accountId || root.id]);
  };
  for (const row of orders) {
    if (row.cancelled || row.subscriptionEnded || released.has(row.id) || !products.has(row.product) || !opened(row))
      continue;
    const start = subscriptionTime(row.start), expiry = subscriptionTime(row.expiry);
    const previous = row.previousOrderId || row.proRenewalSourceId || row.claudeRenewalId;
    if (previous && (Number.isFinite(start) || Number.isFinite(subscriptionTime(row.rechargeCompletedAt)))) linked.add(previous);
    if (!(expiry > start) || start > now) continue;
    const key = keyOf(row);
    const current = latest.get(key);
    if (!current || expiry > current.expiry || (expiry === current.expiry && start > current.start))
      latest.set(key, { id: row.id, start, expiry });
  }
  function eligible(row) {
    return Boolean(row && customers.has(row.customerId) && !row.cancelled && !row.subscriptionEnded &&
      !linked.has(row.id) && !accountMarkedDead(accounts.get(row.accountId)) &&
      (!row.product.startsWith('Claude') || !['frozen', 'abandoned'].includes(
        operations.get(String(row.email || '').toLowerCase())?.status)) &&
      decisions.get(row.id) !== '拒续费' && [bank, apple].includes(row.payment) &&
      latest.get(keyOf(row))?.id === row.id);
  }
  function owner(order) {
    if (!owners.has(order.id)) {
      // A confirmed, unreleased order can establish the existing assignment by itself.
      const related = !order.cancelled && !order.subscriptionEnded && !released.has(order.id) && opened(order)
        ? { orders: [order] } : commerce;
      const account = accounts.get(order.accountId);
      const assignment = ownerForSubscriptionOrder(order, profiles, related, account ? { accounts: [account] } : undefined, now);
      owners.set(order.id, assignment ?? { ownerId: order.ownerId || order.rechargeOwnerId || order.createdById,
        ownerName: order.owner || order.createdBy || '' });
    }
    return owners.get(order.id);
  }
  return { orders, byId, customers, tenants: commerce?.tenants || [], eligible, owner, stamp: order => originalStamp(order, store) };
}

function publicOrder(order, context) {
  const customer = context.customers.get(order.customerId);
  return { id: order.id, number: order.orderNo || '', customer: customer?.name || '原客户', wechat: customer?.wechat || '',
    product: order.product, plan: order.plan, account: order.email || order.xHandle || '', expiry: order.expiry,
    start: order.start, payment: order.payment, owner: context.owner(order).ownerName,
    previousPaidCurrency: order.paidCurrency, previousSaleCurrency: order.saleCurrency };
}

function canSend(actor, order, team, context) {
  if (managesBusiness(actor)) return true;
  const { ownerId } = context.owner(order);
  return actor.role === 'employee' && actor.id === ownerId ||
    actor.role === 'supervisor' && team.has(ownerId);
}

function canFinish(actor, order, context) {
  return Boolean(order) && (managesBusiness(actor) || actor.role === 'employee' && context.owner(order).ownerId === actor.id);
}

function viewRow(row, actor, fromFinance, source, canFile, review) {
  const funding = row.funding;
  const original = { ...row.order };
  if (fromFinance) {
    delete original.wechat;
    if (orderTail(source)) original.originalLast4 = orderTail(source);
  }
  if (actor.role === 'supervisor') {
    delete original.previousPaidCurrency;
    delete original.previousSaleCurrency;
  }
  return { id: row.id, version: row.version, status: row.status, order: original,
    submittedAt: row.submittedAt, submittedBy: row.submittedBy.name,
    processingBy: row.processingBy?.name, assignedToMe: row.processingBy?.id === actor.id,
    canTake: fromFinance && row.status === 'pending' && row.submittedBy.id !== actor.id,
    canTransfer: fromFinance && row.status === 'processing' &&
      (row.processingBy?.id === actor.id || actor.role === 'super'),
    ...(row.paymentReview && { paymentReview: true }),
    canFinish: row.status === 'paid' && canFile && Boolean(source),
    ...(review && { sourceReview: { version: review.version ?? 0, expiry: review.expiry,
      originalLast4: orderTail(review) } }),
    sourceChanged: !source, paidAt: funding?.at, paidBy: funding?.actor.name, saleCurrency: original.previousSaleCurrency,
    ...(funding && actor.role !== 'supervisor' && { amount: funding.amount, currency: funding.currency }),
    ...(funding?.last4 && actor.role !== 'supervisor' && { last4: funding.last4 }),
    ...(fromFinance && funding?.reference && { reference: funding.reference }),
    ...(row.returned && { returned: row.returned }),
    ...(row.newOrderId && { newOrderId: row.newOrderId, newOrderNo: row.newOrderNo, completedAt: row.completedAt })
  };
}

function orderTail(order) {
  return order?.payment === bank && /^\d{4,6}$/.test(order.paymentId || '') ? order.paymentId.slice(-4) : '';
}

function sourceFor(row, context) {
  const order = context.byId.get(row.order.id);
  if (!context.eligible(order) || (row.accountSource !== undefined && row.accountSource !== (order.accountSource || ''))) return null;
  return context.stamp(order) === row.source ? order : null;
}

function reviewSourceFor(row, actor, context, source) {
  if (source || row.status !== 'paid' || row.submittedBy.id === actor.id ||
      (row.processingBy?.id !== actor.id && actor.role !== 'super')) return null;
  const order = context.byId.get(row.order.id);
  if (!context.eligible(order) || row.funding?.payment !== order.payment) return null;
  // Recheck all captured order fields using the dates the finance request originally used.
  if (row.accountSource !== undefined && row.accountSource !== (order.accountSource || '')) return null;
  const previous = { ...order, start: row.order.start, expiry: row.order.expiry };
  return row.source === context.stamp(previous) ? order : null;
}

function cardPermitted(store, id, number) {
  return !frozenOrderCard(store.featureDocument(cardFreezeDocument).data, id, store.orderCardFingerprint(number)) &&
    !blockedOrderCard(orderCardHealth(store.featureDocument(cardTypeDocument).data, id, number));
}

function tenantFunding(store, context, source, items) {
  const tenantCards = store.featureDocument('tenant-cards').data?.items || [];
  const archive = store.featureDocument(orderCardArchiveDocument).data;
  const used = tenantCardUseHistory(tenantCards, context.orders, archive);
  const claimed = new Set(items.filter(item => item.status === 'paid').map(item => item.funding?.card?.id));
  const allowed = source.product.startsWith('Claude') && source.tenantId &&
    context.tenants.some(tenant => tenant.id === source.tenantId && tenant.active !== false);
  const isAvailable = card => allowed && card.tenantId === source.tenantId && card.active &&
    /^\d{12,19}$/.test(card.number || '') &&
    !used.get(card.id) && !claimed.has(card.id) && cardPermitted(store, card.id, card.number);
  return { tenantCards, archive, isAvailable };
}

async function fundingFor(store, client, context, inventory, items, source, input, actor, now) {
  const amount = input.amount, currency = input.currency;
  if (!credit(amount, currency) || moneyUnits(amount) <= 0n || input.confirmed !== true)
    fail(400, '请填写实际付款金额、币种，并确认付款成功');
  const reference = text(input.reference);
  if (input.reference && (!reference || /(?:\d[ -]?){12}/.test(reference)))
    fail(400, '请填写简短的凭据编号，银行卡信息请填入对应字段');
  const funding = { payment: source.payment, amount, currency, reference, at: displayTime(now),
    actor: { id: actor.id, name: actor.name } };
  if (source.payment === apple) {
    if (currency !== 'USD') fail(400, '苹果内购请填写实际支付的美元金额');
    if (source.appleIdId) {
      const ledger = store.load('appleBalance').data || {};
      const asset = inventory?.mailboxes?.find(row => row.id === source.appleIdId && row.type === 'apple');
      const balance = ledger.wallets?.find(row => row.id === source.appleIdId);
      const wallet = asset && balance ? { ...asset, balance: balance.balance, currency: balance.currency } : null;
      const check = appleFundingEligibility(wallet, { ...source, id: '', businessType: '续费', paidAmount: amount },
        appleFundingIndex(context.orders, ledger), store.load('settings').data, { actual: true });
      if (check.error) fail(409, check.error);
    }
    return { ...funding, appleIdId: source.appleIdId || '', appleStoreRegion: source.appleStoreRegion || '' };
  }
  const kind = input.cardMode;
  if (kind === 'none') return funding;
  const { tenantCards, archive, isAvailable } = tenantFunding(store, context, source, items);
  let number, serial, card;
  const selectTenantCard = choice => {
    if (!choice || !isAvailable(choice)) fail(409, '这张租户卡已使用、已停用或不属于本单，请核对本次用卡');
    return { id: choice.id, number: choice.number, last4: choice.number.slice(-4) };
  };
  if (kind === 'manual') {
    number = typeof input.cardNumber === 'string' ? input.cardNumber.replace(/[ -]/g, '') : '';
    serial = text(input.cardSerial, 120);
    if (!/^\d{12,19}$/.test(number) || input.cardSerial && !serial)
      fail(400, '请核对本次实际使用的卡号和卡序列号');
    const known = tenantCards.filter(row => row.number === number);
    if (known.length > 1) fail(409, '此卡有多条租户资料，请从系统选择本次实际使用的卡');
    if (known.length) card = selectTenantCard(known[0]);
  } else if (kind === 'original' || kind === 'pool') {
    const original = kind === 'original' ? orderCardHealthReference(source, { archive, tenantCards }) : null;
    const requestedCard = kind === 'pool' ? input.cardId : original?.id;
    if (original?.conflict) fail(409, '原单用卡有冲突，请按本次实际使用的卡登记');
    if (kind === 'pool' && !(typeof requestedCard === 'string' &&
        /^(?:recharge:[1-9]\d{0,19}|tenant:[a-z0-9-]{1,96})$/i.test(requestedCard)))
      fail(400, '请选择本次使用的银行卡');
    if (requestedCard?.startsWith('recharge:')) {
      card = (await readPoolCards(client, { includeNumbers: true })).find(item => item.id === requestedCard);
      if (!card?.active || !/^\d{12,19}$/.test(card.number || '') || !card.number.endsWith(card.last4) ||
          (original?.number && original.number !== card.number))
        fail(409, '该卡当前无法核对，请登记本次实际使用的银行卡');
    } else if (requestedCard?.startsWith('tenant:')) {
      card = selectTenantCard(tenantCards.find(row => row.id === requestedCard));
    } else {
      number = original?.number;
      serial = source.proCardSerial;
      if (!number) fail(400, '原单只有银行卡尾号，请填写本次用卡或选暂不登记');
      const known = tenantCards.find(row => row.number === number);
      if (known) card = selectTenantCard(known);
    }
  } else fail(400, '请选择本次用卡的登记方式');
  const cardNumber = card?.number || number;
  if (!cardPermitted(store, card?.id, cardNumber))
    fail(409, '这张卡的状态需要核对，请按实际凭据登记');
  if (card) return { ...funding, card, last4: card.last4 };
  return { ...funding, number, serial, last4: number.slice(-4) };
}

function newOrder(source, row, command, actor, context, now) {
  const { start, expiry, saleAmount, saleCurrency } = command;
  if (!dateInput(start) || !dateInput(expiry) || !(subscriptionTime(start) <= now &&
      subscriptionTime(expiry) > Math.max(subscriptionTime(start), subscriptionTime(source.expiry))))
    fail(400, '请填写实际开通时间，新到期时间须晚于原到期时间');
  if (!credit(saleAmount, saleCurrency)) fail(400, '请填写客户实际支付金额及币种');
  const funding = row.funding;
  const email = source.email || text(command.email, 254).toLowerCase();
  const xHandle = source.xHandle || text(command.xHandle, 16);
  if ((!source.email && email && !validOrderEmail(email)) || (xHandle && !validOrderXHandle(xHandle)))
    fail(400, '请核对订单邮箱或 X 账号');
  const loginMethod = source.loginMethod || (source.product === 'Gemini' ? 'google'
    : source.product === 'Grok' ? xHandle && !email ? 'x' : 'email' : undefined);
  const order = { id: 'order-' + row.id, version: 1, product: source.product, plan: ({ 'Claude Pro': { pro: 'Pro' }, 'Claude Max': { max5: 'Max 5x', max20: 'Max 20x' } })[source.product]?.[source.plan] || source.plan,
    source: manualSource, businessType: '续费', accountSource: source.accountSource || '客户自有',
    customerId: source.customerId, ownerId: context.owner(source).ownerId || actor.id,
    start, expiry, saleAmount, saleCurrency, paidAmount: funding.amount, paidCurrency: funding.currency,
    payment: funding.payment, paidConfirmed: true, receiptConfirmed: true, entitlementStatus: 'active',
    costBasis: 'standard', createdAt: displayTime(now), updatedAt: displayTime(now), email,
    ...(xHandle && { xHandle }), ...(loginMethod && { loginMethod }),
    previousOrderId: source.id, renewalSourceVersion: source.version ?? 0 };
  for (const field of ['accountId', 'platformAccountId', 'xLinkState'])
    if (source[field]) order[field] = source[field];
  if (personalProduct(order.product)) {
    order.subscriptionSeries = subscriptionSeries(order);
    if (source.billingChannel) order.billingChannel = source.billingChannel;
    if (funding.reference) order.billingReceipt = funding.reference;
  }
  if (order.payment === apple && funding.appleIdId) {
    order.appleIdId = funding.appleIdId;
    order.appleStoreRegion = funding.appleStoreRegion || '';
    if (order.product === 'Gemini') order.appleGoogleVerified = true;
  } else if (funding.card) {
    order.cardId = funding.card.id;
    order.proMaterialMode = funding.card.id.startsWith('tenant:') ? 'tenant_card' : 'pool_card';
    if (order.proMaterialMode === 'tenant_card') order.tenantId = source.tenantId;
  } else if (funding.number) {
    order.proMaterialMode = 'manual_card';
    order.proCardNumber = funding.number;
    if (funding.serial) order.proCardSerial = funding.serial;
  }
  return order;
}

export function directRenewalSource(orders, order, legacy) {
  if (order.source === '线上代充' || !['续费', '首次开通'].includes(order.businessType) || !order.customerId) return undefined;
  const previousId = order.previousOrderId || order.proRenewalSourceId || order.claudeRenewalId;
  if (previousId) return previousId;
  const target = targetKey(order) || order.accountId;
  if (!target) return undefined;
  return orders.find(row => row.customerId === order.customerId && !row.cancelled && !row.subscriptionEnded &&
    (row.product === order.product || row.product?.startsWith('Claude') && order.product?.startsWith('Claude')) &&
    (!personalProduct(order.product) || (subscriptionSeries(row) === subscriptionSeries(order))) &&
    (targetKey(row) || row.accountId) === target && orderOpeningConfirmed(row, Date.now(), legacy?.has(row.id)))?.id;
}

function send(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
  response.end(JSON.stringify(data));
}

async function readCommand(request) {
  if (!/^application\/json(?:\s*;|$)/.test(request.headers['content-type'] || '')) fail(415, '请从当前页面提交');
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if ((bytes += chunk.length) > 32 * 1024) { request.resume(); fail(413, '提交内容过多，请分批操作'); }
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {}
  fail(400, '请核对填写的资料');
}

const actions = new Set(['submit', 'claim', 'paid', 'return', 'finish', 'transfer', 'review-source']);
const actionFields = {
  submit: ['confirmed', 'orders'], claim: [],
  paid: ['confirmed', 'amount', 'currency', 'reference', 'cardMode', 'cardId', 'cardNumber', 'cardSerial'],
  return: ['confirmed', 'reason'], finish: ['start', 'expiry', 'saleAmount', 'saleCurrency', 'email', 'xHandle'],
  transfer: ['confirmed', 'review', 'reason'],
  'review-source': ['confirmed', 'reason', 'sourceVersion']
};

export function createRenewalHandoff({ store, client, publicOrigin, getAuth, clock = Date.now }) {
  return async (request, response, actor) => {
    try {
      if (!actor?.id) fail(401, '请先登录');
      if (!renewalRole(actor)) fail(403, '当前账号无权办理续费');
      const origin = publicOrigin || 'http://' + request.headers.host;
      if ((request.headers.origin && request.headers.origin !== origin) ||
          (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])))
        fail(403, '请从当前页面操作');
      const now = clock();
      const scope = getAuth();
      const team = actor.role === 'supervisor' ? new Set(scope.teamFor(actor.id).map(member => member.id)) : new Set();
      const snapshot = store.featureDocument(renewalHandoffDomain);
      const items = snapshot.data?.items || [];
      const commerce = store.load('commerce');
      const inventory = store.load('inventory').data;
      const context = originalOrderContext(commerce.data, inventory, store.featureDocument(subscriptionDomain).data, store, now);
      if (request.method === 'GET') {
        const params = new URL(request.url, origin).searchParams;
        const view = params.get('view');
        if (view === 'cards') {
          if (!financeRole(actor) || !scope.recentlyVerified(request)) fail(403, '请先完成安全确认再选卡');
          const row = items.find(item => item.id === params.get('id') && item.status === 'processing' &&
            item.processingBy.id === actor.id);
          const source = row && sourceFor(row, context);
          if (!source || source.payment !== bank) fail(404, '请先接手对应的银行卡续费');
          const { tenantCards, isAvailable } = tenantFunding(store, context, source, items);
          const selected = tenantCards.filter(isAvailable).map(({ id, number }) => ({ id, last4: number.slice(-4), label: '租户卡' }));
          let pool;
          try { pool = (await readPoolCards(client, { includeNumbers: true })).filter(card => card.active &&
            /^\d{12,19}$/.test(card.number || '') && card.number.endsWith(card.last4) && cardPermitted(store, card.id, card.number)); }
          catch { return send(response, 200, { items: selected, poolUnavailable: true }); }
          return send(response, 200, { items: [...selected, ...pool.map(({ id, last4 }) => ({ id, last4, label: '代充卡' }))] });
        }
        const fromFinance = view === 'finance';
        if (fromFinance && !financeRole(actor) || !fromFinance && (view !== 'staff' || actor.role === 'finance'))
          fail(403, '当前账号无权查看此工作台');
        const mine = order => Boolean(order && canSend(actor, order, team, context));
        const visible = items.filter(row => fromFinance || managesBusiness(actor) ||
          mine(context.byId.get(row.order.id)));
        const queued = new Set(items.filter(row => row.status !== 'returned').map(row => row.order.id));
        const candidates = fromFinance ? [] : context.orders.filter(row => context.eligible(row) && mine(row) && !queued.has(row.id))
          .map(order => {
            const display = publicOrder(order, context);
            if (actor.role === 'supervisor') {
              delete display.previousPaidCurrency;
              delete display.previousSaleCurrency;
            }
            return { ...display, version: order.version ?? 0 };
          });
        const reminderHours = commerce.data?.renewalWarningHours ?? (commerce.data?.renewalWarningDays || 7) * 24;
        return send(response, 200, { version: snapshot.version, reminderHours, candidates,
          items: visible.map(row => {
            const order = context.byId.get(row.order.id);
            const source = row.status === 'complete' ? order : sourceFor(row, context);
            return viewRow(row, actor, fromFinance, source, canFinish(actor, order, context),
              fromFinance && reviewSourceFor(row, actor, context, source));
          }) });
      }
      if (request.method !== 'POST') fail(405, '此操作不可用');
      if (request.headers.origin !== origin) fail(403, '请从当前页面提交');
      const command = await readCommand(request);
      const action = command.action;
      if (!actions.has(action)) fail(400, '请选择可用的续费操作');
      if (Object.keys(command).some(key => !['action', 'id', 'version', ...actionFields[action]].includes(key)))
        fail(400, '请通过对应的续费操作填写资料');
      const operation = describeWriteOperation(request.headers['x-id-operation'], actor, ['renewal', command]);
      if (!operation) fail(400, '请从当前工作台提交');
      if (store.replayWrite(operation)) {
        const prior = items.find(row => row.id === command.id && row.status === 'complete');
        return send(response, 200, { saved: true, ...(prior && { orderNo: prior.newOrderNo }) });
      }
      if (action === 'submit') {
        if (actor.role === 'finance') fail(403, '请由业务人员送财务');
        if (command.confirmed !== true || !Array.isArray(command.orders) || !command.orders.length || command.orders.length > 50 ||
            command.orders.some(row => typeof row?.id !== 'string' || row.id.length > 256 || !Number.isSafeInteger(row.version)) ||
            new Set(command.orders.map(row => row?.id)).size !== command.orders.length)
          fail(400, '请选择要续费的订单并再次确认，单次最多 50 笔');
        const additions = command.orders.map(row => {
          const source = context.byId.get(row?.id);
          if (!source || !canSend(actor, source, team, context)) fail(404, '所选订单不存在或不在你的工作范围内');
          if (!context.eligible(source) || row.version !== (source.version ?? 0) ||
              items.some(item => item.order.id === row.id && item.status !== 'returned'))
            fail(409, '有订单已送财务或资料已更新，请刷新后核对再提交');
          return { id: randomUUID(), version: 1, status: 'pending', order: publicOrder(source, context),
            source: context.stamp(source), accountSource: source.accountSource || '',
            submittedBy: { id: actor.id, name: actor.name }, submittedAt: displayTime(now) };
        });
        store.saveRenewalQueue(snapshot.version, commerce.version, [...additions, ...items],
          { action: 'renewal_submit', actor, ids: additions.map(row => row.id), operation });
        return send(response, 200, { saved: true, count: additions.length });
      }
      const row = items.find(item => item.id === command.id);
      if (!row || !states.has(row.status)) fail(404, '未找到该续费申请');
      const original = context.byId.get(row.order.id);
      if (action === 'finish' ? !original || !canFinish(actor, original, context)
        : !financeRole(actor) || action !== 'transfer' && row.submittedBy.id === actor.id)
        fail(403, '当前账号无权办理这笔续费');
      if (row.version !== command.version) fail(409, '这笔续费已更新，请重新核对');
      const source = sourceFor(row, context);
      const next = { ...row, version: row.version + 1 };
      if (action === 'claim') {
        if (row.status !== 'pending') fail(409, '这笔续费已有人办理');
        next.status = 'processing';
        next.processingBy = { id: actor.id, name: actor.name };
      } else if (action === 'transfer') {
        if (row.status !== 'processing' || !row.processingBy ||
            (row.processingBy.id !== actor.id && actor.role !== 'super'))
          fail(403, '仅当前经办人或超级管理员可交接');
        if (!scope.recentlyVerified(request)) fail(403, '请先完成安全确认，再移交续费');
        const reason = text(command.reason, 160);
        if (!reason || /(?:\d[ -]?){12}/.test(reason) || command.confirmed !== true || typeof command.review !== 'boolean')
          fail(400, '请填写交接原因并确认付款状态，原因中请勿填写卡号');
        next.status = 'pending';
        next.paymentReview = Boolean(row.paymentReview || command.review);
        delete next.processingBy;
        next.transfers = [...(row.transfers || []), { from: row.processingBy, by: { id: actor.id, name: actor.name },
          reason, paymentReview: next.paymentReview, at: displayTime(now) }];
      } else if (action === 'review-source') {
        if (row.processingBy?.id !== actor.id && actor.role !== 'super')
          fail(403, '仅当前经办人或超级管理员可核对原单');
        if (!scope.recentlyVerified(request)) fail(403, '请先完成安全确认，再核对原单');
        const review = reviewSourceFor(row, actor, context, source);
        if (!review || command.sourceVersion !== (review.version ?? 0))
          fail(409, '原单已变化或与这笔付款不符，请刷新后核对');
        const reason = text(command.reason, 160);
        if (!reason || /(?:\d[ -]?){12}/.test(reason) || command.confirmed !== true)
          fail(400, '请核对付款凭据并简述原单更正原因，原因中请勿填写卡号');
        next.order = publicOrder(review, context);
        next.source = context.stamp(review);
        next.accountSource = review.accountSource || '';
        next.sourceReviews = [...(row.sourceReviews || []), { from: row.source, to: next.source,
          by: { id: actor.id, name: actor.name }, reason, at: displayTime(now) }];
      } else if (action === 'finish') {
        if (row.status !== 'paid' || !source) fail(409, '这笔续费尚未完成财务处理或原单已变化');
        const order = newOrder(source, row, command, actor, context, now);
        const orderNo = store.finishRenewal({ snapshot, commerce, item: next, order, actor, operation,
          owners: () => scope.orderOwners() });
        return send(response, 200, { saved: true, orderNo });
      } else {
        if (row.status !== 'processing' || row.processingBy.id !== actor.id) fail(409, '请先接手这笔续费');
        if (action === 'return') {
          if (row.paymentReview && !scope.recentlyVerified(request))
            fail(403, '请先完成安全确认，再确认这笔续费未付款');
          const reason = text(command.reason, 160);
          if (!reason || /(?:\d[ -]?){12}/.test(reason) || command.confirmed !== true)
            fail(400, '请确认未付款并填写退回原因，原因中请勿填写卡号');
          next.status = 'returned';
          next.paymentReview = false;
          next.returned = reason;
        } else {
          if (!source) fail(409, '原单已变化，请核对付款及原单');
          if (!scope.recentlyVerified(request)) fail(403, '请先完成安全确认，再登记实付和用卡');
          next.status = 'paid';
          next.paymentReview = false;
          next.funding = await fundingFor(store, client, context, inventory, items, source, command, actor, now);
        }
      }
      store.saveRenewalQueue(snapshot.version, commerce.version, items.map(item => item.id === row.id ? next : item),
        { action: 'renewal_' + action.replace('-', '_'), actor, ids: [row.id], operation });
      return send(response, 200, { saved: true });
    } catch (error) {
      const status = [400, 401, 403, 404, 405, 409, 413, 415, 422].includes(error.status) ? error.status : 503;
      return send(response, status, { error: status === 503 ? '暂时无法确认办理结果，请刷新后核对' : error.message });
    }
  };
}
