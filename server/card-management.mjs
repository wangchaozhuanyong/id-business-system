import { randomUUID } from 'node:crypto';

import { automaticProvider, renewalFundingUsd, validCurrencyCode } from '../modules/finance/accounting.mjs';
import { parseV2DateTimeInput } from '../modules/time/dateTime.ts';
import { accountLifecycleSummary, releasedAccountOrders, systemAccount } from './account-lifecycle.mjs';
import { validMoney } from './order-policy.mjs';

export const cardTypeDocument = 'card-types';
export const orderCardArchiveDocument = 'order-card-archive';
const detailsRoute = '/api/local/subscription-card-details';
const revealRoute = '/api/local/subscription-card-reveal';
const copyRoute = '/api/local/subscription-card-copy';
export const cardManagementRoutes = new Set([
  '/api/local/card-types', '/api/local/subscription-card-estimates', copyRoute,
  detailsRoute, revealRoute
]);

const initialTypes = [
  ['vccwc999', 'vccwc999'], ['wise-pan', 'wise潘'], ['wise-jia', 'wise佳'], ['xiaohong-feng', '小红卡峰']
].map(([key, name]) => ({ id: 'card-type-' + key, name, active: true }));

const classify = data => data ?? { items: initialTypes, assignments: {} };
const recognizedCard = id => typeof id === 'string' &&
  /^(?:recharge:[1-9]\d*|tenant:[a-zA-Z0-9-]{1,120}|orbitcard:[1-9]\d*)$/.test(id);
const error = (status, message) => Object.assign(new Error(message), { status });
const validPan = number => typeof number === 'string' && /^\d{12,19}$/.test(number);

export async function preserveReferencedOrderCard(store, client, cardId, actor) {
  const orders = store.load('commerce').data?.orders || [];
  const referenced = orders.some(order => [order, ...(order.corrections || []).map(change => change.previous)]
    .some(row => row?.payment === '银行卡' && (row.cardId === cardId ||
      row.financialEvidence?.some(entry => entry.kind === 'payment' && entry.cardId === cardId))));
  if (!referenced) return;
  const before = store.featureDocument(orderCardArchiveDocument);
  if (validPan(before.data?.cards?.[cardId]?.number)) return;
  const row = await poolCard(client, cardId);
  if (!row || !validPan(row.card_number) || !/^\d{4}$/.test(row.last4) || !row.card_number.endsWith(row.last4))
    throw error(409, '此卡关联历史订单，完整卡号尚未留存，请先核对订单资料');
  store.saveFeatureDocument(orderCardArchiveDocument, before.version, {
    cards: { ...before.data?.cards, [cardId]: { number: row.card_number, last4: row.last4 } }
  }, { action: '保留历史订单银行卡资料', actor, targetId: cardId });
}

export function cardTypeSnapshot(data, { cardId, cardTypeId, prior }) {
  const { items, assignments } = classify(data);
  const sameCard = (prior?.cardId || '') === (cardId || '');
  const priorId = prior?.cardTypeId || '';
  if (sameCard && prior && (cardTypeId === undefined || cardTypeId === priorId))
    return { id: priorId, name: priorId ? prior.cardTypeName || '' : '' };
  const inferred = cardTypeId === undefined;
  const id = inferred ? assignments[cardId] : cardTypeId;
  if (id === '' || (inferred && !id)) return { id: '', name: '' };
  const item = items.find(row => row.id === id && row.active);
  if (item) return { id: item.id, name: item.name };
  if (inferred) return { id: '', name: '' };
  throw error(400, '请选择有效的银行卡类型');
}

function orderCardIds(order) {
  if (order?.payment !== '银行卡') return [];
  if (order.proMaterialMode === 'manual_card') return ['manual:' + order.id];
  if (recognizedCard(order.cardId)) return [order.cardId];
  const ids = evidenceCardIds(order);
  return ids.length === 1 ? ids : [];
}

function evidenceCardIds(order) {
  return [...new Set((order.financialEvidence || []).filter(row =>
    row.kind === 'payment' && row.payment === '银行卡' && recognizedCard(row.cardId)).map(row => row.cardId))];
}

function currentQuote(quotes, currency, now) {
  let latest;
  for (const quote of quotes) {
    const at = Date.parse(quote.at);
    if (quote.provider === automaticProvider.id && at <= now && now < Date.parse(quote.expiresAt) &&
        Date.parse(quote.fetchedAt) <= now && quote.rates?.[currency] && quote.rates?.USD &&
        (!latest || at > Date.parse(latest.at))) latest = quote;
  }
  return latest;
}

export function cardFundingEstimate(order, fixedFee, quotes, now) {
  const { paidAmount, paidCurrency } = order;
  const basis = { amount: paidAmount || '', currency: paidCurrency || '', fixedFee, bufferUsd: '2.00' };
  if (order.paidConfirmed !== true &&
      !(order.source === '线上代充' && Number.isFinite(Date.parse(order.rechargeCompletedAt)))) return { ...basis, amount: '' };
  if (!validCurrencyCode(paidCurrency)) return basis;
  const quote = paidCurrency === 'USD' ? null : currentQuote(quotes, paidCurrency, now);
  if (paidCurrency !== 'USD' && !quote) return basis;
  try {
    const converted = renewalFundingUsd(paidAmount, fixedFee, quote?.rates[paidCurrency], quote?.rates.USD);
    return { ...basis, usd: converted, ...(quote && {
      source: quote.source, quotedAt: quote.at, expiresAt: quote.expiresAt,
      originalRateToCny: quote.rates[paidCurrency], usdRateToCny: quote.rates.USD
    }) };
  } catch {
    return basis;
  }
}

async function poolCards(client) {
  let result;
  try {
    result = await client.get('/api/admin/cards');
    if (!Array.isArray(result.cards)) throw new Error('Invalid pool response');
  } catch {
    throw error(503, '充值卡池暂时无法读取，请重试');
  }
  return result.cards;
}

async function poolCard(client, id) {
  const matches = (await poolCards(client)).filter(row => 'recharge:' + row.id === id);
  return matches.length === 1 ? matches[0] : null;
}

function tenantCard(store, id) {
  return store.featureDocument('tenant-cards').data?.items?.find(row => row.id === id);
}

function send(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
  response.end(JSON.stringify(data));
}

async function readCommand(request, maximumBytes = 4096) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximumBytes) throw error(400, '请求过长');
    chunks.push(chunk);
  }
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    return input;
  } catch {
    throw error(400, '无法读取银行卡操作');
  }
}

function cardTypeName(data, order, id) {
  const type = data.items.find(row => row.id === data.assignments[id]);
  return (type?.active ? type.name : '') || order.cardTypeName || type?.name || '未设置';
}

function currentEstimateContext(store) {
  return {
    fixedFee: store.load('settings').data?.costSettings?.cardPerPaymentUsd ?? '0.3',
    quotes: store.featureDocument('finance-rates').data?.quotes || []
  };
}

const emailKey = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const productFamily = product => product === 'GPT' ? 'gpt' : ['Claude Pro', 'Claude Max'].includes(product) ? 'claude'
  : ['Gemini', 'Grok'].includes(product) ? product.toLowerCase() : '';
const validOrderId = value => typeof value === 'string' && value.trim() && value.length <= 160;
const positiveMoney = value => validMoney(value) && /[1-9]/.test(value);

function orderTime(value) {
  const time = typeof value === 'string' ? value.trim().replace(' ', 'T') : '';
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(time)
    ? Date.parse(time) : parseV2DateTimeInput(time)?.getTime() ?? NaN;
}

function confirmedPaid(order, cardId) {
  if (order.paidConfirmed === true && positiveMoney(order.paidAmount) && validCurrencyCode(order.paidCurrency))
    return { amount: order.paidAmount, currency: order.paidCurrency };
  const matches = new Map();
  for (const entry of order.financialEvidence || []) {
    if (entry.kind !== 'payment' || entry.payment !== order.payment ||
        (entry.cardId || '') !== cardId || !positiveMoney(entry.amount) || !validCurrencyCode(entry.currency)) continue;
    matches.set(JSON.stringify([entry.amount, entry.currency]), { amount: entry.amount, currency: entry.currency });
  }
  return matches.size === 1 ? matches.values().next().value : null;
}

function paymentConfirmed(order) {
  return order.paidConfirmed === true || (order.financialEvidence || []).some(entry =>
    entry.kind === 'payment' && entry.payment === order.payment && positiveMoney(entry.amount) && validCurrencyCode(entry.currency)) ||
    (order.source === '线上代充' && Number.isFinite(orderTime(order.rechargeCompletedAt)));
}

function accountForOrder(order, commerce, inventory, now) {
  const email = typeof order.email === 'string' ? order.email.trim() : '';
  const type = productFamily(order.product);
  const inventoryAccounts = inventory?.accounts || [];
  const stockWithEmail = inventoryAccounts.filter(row => systemAccount(row) && row.type === type &&
    email && emailKey(row.email) === emailKey(email));
  const matches = order.accountId ? inventoryAccounts.filter(row => row.id === order.accountId) :
    stockWithEmail.filter(row =>
      (row.usageLinks || []).some(link => ['order-sale', 'order-renewal', 'order-use'].includes(link.kind) && link.orderId === order.id));
  const available = !order.cancelled && !order.subscriptionEnded;
  const unverified = { account: { email, source: '库存归属待核对', status: '库存归属待核对', canRenew: false }, conflict: true };
  if (!matches.length && !order.accountId && order.accountSource !== '库存' && !stockWithEmail.length) {
    const customerOwned = ['客户自有', 'customer'].includes(order.accountSource);
    return { account: {
      email, source: customerOwned ? '客户自有' : '历史账号来源未登记',
      status: customerOwned ? '未关联库存' : '待核对', canRenew: available && customerOwned
    }, released: false };
  }
  const [asset] = matches;
  if (matches.length !== 1 || !systemAccount(asset) || asset.type !== type ||
      !email || emailKey(asset.email) !== emailKey(email)) return unverified;
  const summary = accountLifecycleSummary(asset, commerce, now);
  const released = releasedAccountOrders(asset).has(order.id) || ['recovered', 'retired'].includes(summary.disposition);
  const conflict = summary.currentCustomers.length > 1 || Boolean(summary.customerId && summary.customerId !== order.customerId);
  const health = { dead: '死号', unlocking: '解封中' }[asset.health];
  return { account: {
    email, source: '库存账号',
    status: released ? '本单使用已结束' : conflict ? '库存归属待核对' : health || summary.label,
    canRenew: Boolean(available && !released && !conflict && !health && summary.disposition === 'in_use' &&
      summary.customerId && summary.customerId === order.customerId)
  }, conflict, released, assetId: asset.id };
}

function validSuccessor(order, candidate, orderAccount, candidateAccount) {
  if (!candidate || candidate.id === order.id || candidate.cancelled || candidate.subscriptionEnded ||
      orderAccount.conflict || candidateAccount.conflict || candidateAccount.released ||
      !order.customerId || candidate.customerId !== order.customerId ||
      productFamily(candidate.product) !== productFamily(order.product) || !emailKey(order.email) ||
      emailKey(candidate.email) !== emailKey(order.email) ||
      (orderAccount.assetId && candidateAccount.assetId && orderAccount.assetId !== candidateAccount.assetId)) return false;
  const start = orderTime(order.start), end = orderTime(order.expiry);
  const nextStart = orderTime(candidate.start), nextEnd = orderTime(candidate.expiry);
  return paymentConfirmed(order) && paymentConfirmed(candidate) &&
    end > start && nextStart >= start && nextEnd > nextStart && nextEnd > end;
}

function orderCardReference(order) {
  const evidence = evidenceCardIds(order);
  const id = orderCardIds(order)[0] || '';
  const manual = order.proMaterialMode === 'manual_card';
  const recordedBeforeCorrection = ref => (order.corrections || []).some(change =>
    change.previous?.payment === '银行卡' && change.previous.cardId === ref && change.reason);
  const conflict = evidence.some(ref => ref !== id && !recordedBeforeCorrection(ref)) ||
    (manual && Boolean(order.cardId)) || (!id && Boolean(order.cardId));
  return { id, manual, conflict };
}

function orbitBalance(card, now) {
  const amount = typeof card.balance === 'number' || typeof card.balance === 'string' ? String(card.balance) : '';
  const updated = orderTime(card.balanceUpdatedAt);
  if (!/^-?\d{1,16}(?:\.\d{1,4})?$/.test(amount) || !validCurrencyCode(card.balanceCurrency) ||
      !Number.isFinite(updated) || updated > now) return null;
  return { amount, currency: card.balanceCurrency, updatedAt: new Date(updated).toISOString() };
}

async function cardDetails(context, order, account) {
  const { commerce, client, types, tenantCards, archive, fixedFee, quotes, now } = context;
  const bank = order.payment === '银行卡';
  const { id, manual, conflict } = bank ? orderCardReference(order) : { id: '' };
  const tail = /^\d{4}(?:\d{2})?$/.test(order.paymentId) ? order.paymentId : '';
  const paid = bank ? confirmedPaid(order, id) : null;
  const estimate = bank ? cardFundingEstimate({
    ...order, paidAmount: paid?.amount || '', paidCurrency: paid?.currency || '', paidConfirmed: Boolean(paid)
  }, fixedFee, quotes, now) : null;
  const card = {
    source: bank ? '未登记银行卡' : '苹果内购', typeName: bank ? cardTypeName(types, order, id) : '未设置',
    last4: bank ? tail.slice(-4) : '', status: bank ? '无卡资料' : '无需银行卡',
    canReveal: false, estimate, balance: null, paid
  };
  let number, verifiedTail;
  const savedNumber = order.proCardNumber || archive?.cards?.[id]?.number;
  if (conflict) card.status = '卡片关联待核对';
  else if (validPan(savedNumber)) {
    // The saved order is the source of historical card materials, not the mutable pool.
    card.source = manual ? '手填银行卡' : id.startsWith('tenant:') ? '认证人银行卡（订单留存）'
      : id.startsWith('recharge:') ? '充值卡池（订单留存）'
        : id.startsWith('orbitcard:') || order.source === '线上代充' ? '线上代充用卡（订单留存）' : '订单登记银行卡';
    card.status = manual ? '已登记' : '订单留存';
    number = savedNumber;
  }
  else if (manual) {
    card.source = '手填银行卡';
    card.status = '已登记';
    number = order.proCardNumber;
  } else if (id.startsWith('recharge:')) {
    card.source = '充值卡池';
    try {
      const row = await poolCard(client, id);
      card.status = !row ? '历史卡已删除' : Number(row.is_active) === 1 ? '可用' : '已停用';
      verifiedTail = row?.last4;
      if (card.status === '可用') number = row.card_number;
    } catch {
      card.status = '卡池暂时无法读取';
    }
  } else if (id.startsWith('tenant:')) {
    card.source = '认证人银行卡';
    const rows = (tenantCards?.data?.items || []).filter(row => row.id === id);
    const tenant = commerce.tenants?.find(row => row.id === order.tenantId);
    const [row] = rows;
    if (!rows.length) card.status = '历史卡已删除';
    else if (rows.length !== 1 || !order.tenantId || row.tenantId !== order.tenantId) card.status = '卡片关联待核对';
    else {
      const active = row.active && tenant && tenant.active !== false;
      card.status = active ? '可用' : '已停用';
      if (validPan(row.number)) verifiedTail = row.number.slice(-4);
      if (active) number = row.number;
    }
  } else if (id.startsWith('orbitcard:')) {
    card.source = '线上代充用卡';
    try {
      const key = id.slice('orbitcard:'.length);
      const response = await client.get('/api/admin/orbitcard/usage?page_size=100&keyword=' + key);
      if (!Array.isArray(response.cards)) throw new Error('Invalid Orbitcard usage');
      const matches = response.cards.filter(row => String(row.cardId) === key);
      const [row] = matches;
      if (matches.length !== 1) card.status = '卡片关联待核对';
      else if (row.status === 'PROVIDER_DELETED' || row.providerStatus === 'DELETED') card.status = '历史卡已删除';
      else {
        const unavailable = ['CANCELED', 'CANCELLED', 'RETIRED', 'FROZEN', 'CLOSED', 'DISABLED', 'INACTIVE'];
        const active = row.status === 'ACTIVE' && !unavailable.includes(row.providerStatus);
        card.status = active ? '可用' : '已停用';
        card.balance = orbitBalance(row, now);
        verifiedTail = row.cardLast4;
        if (active) number = row.cardNumber;
      }
    } catch {
      card.status = '卡池暂时无法读取';
    }
  }
  const foundTail = /^\d{4}$/.test(verifiedTail) ? verifiedTail : '';
  const completeNumber = validPan(number);
  const tailConflict = (tail && foundTail && !tail.endsWith(foundTail)) ||
    (completeNumber && ((tail && !number.endsWith(tail)) || (foundTail && !number.endsWith(foundTail))));
  if (tailConflict) {
    card.status = '原卡资料待核对';
    card.balance = null;
    number = undefined;
  } else {
    card.last4 ||= foundTail || (completeNumber ? number.slice(-4) : '');
    if (['已登记', '可用'].includes(card.status) && !completeNumber) {
      card.status = '完整卡号未登记';
      if (!tail || !foundTail) card.balance = null;
    }
  }
  card.canReveal = Boolean(validPan(number) && !account.conflict && !account.released && !order.cancelled && paymentConfirmed(order));
  return { card, number: card.canReveal ? number : undefined };
}

async function readRenewalCard(store, client, command, actor, now, action) {
  if (!validOrderId(command.orderId) || (command.renewalOrderId !== undefined && !validOrderId(command.renewalOrderId)) ||
      (command.version !== undefined && (!Number.isSafeInteger(command.version) || command.version < 1)))
    throw error(400, '请选择有效的订单');
  const commerce = store.load('commerce');
  const inventory = store.load('inventory');
  const findOrder = id => {
    const matches = (commerce.data?.orders || []).filter(row => row.id === id);
    const order = matches.length === 1 ? matches[0] : undefined;
    return order && productFamily(order.product) && ['银行卡', '苹果内购'].includes(order.payment) ? order : null;
  };
  const order = findOrder(command.orderId);
  if (!order) throw error(404, '订单不存在或无法核对');
  if (command.version !== undefined && order.version !== command.version) throw error(409, '订单已变化，请重新打开银行卡详情');
  if (action === 'copy' && command.cardId !== undefined && command.cardId !== orderCardReference(order).id)
    throw error(409, '银行卡关联已变化，请重新打开银行卡详情');
  const original = accountForOrder(order, commerce.data, inventory.data, now);
  const candidate = action === 'details' && command.renewalOrderId ? findOrder(command.renewalOrderId) : null;
  const candidateAccount = candidate ? accountForOrder(candidate, commerce.data, inventory.data, now) : null;
  const renewal = validSuccessor(order, candidate, original, candidateAccount) ? candidate : null;
  const tenantCards = [order, renewal].some(row => row?.payment === '银行卡' && orderCardReference(row).id.startsWith('tenant:'))
    ? store.featureDocument('tenant-cards') : null;
  const cache = new Map();
  const context = {
    commerce: commerce.data, tenantCards, now, ...currentEstimateContext(store),
    archive: store.featureDocument(orderCardArchiveDocument).data,
    types: classify(store.featureDocument(cardTypeDocument).data),
    client: { get(path) {
      if (!cache.has(path)) cache.set(path, Promise.resolve().then(() => client.get(path)));
      return cache.get(path);
    } }
  };
  const [originalCard, renewalCard] = await Promise.all([
    cardDetails(context, order, original),
    renewal && cardDetails(context, renewal, candidateAccount)
  ]);
  if (store.load('commerce').version !== commerce.version || store.load('inventory').version !== inventory.version ||
      (tenantCards && store.featureDocument('tenant-cards').version !== tenantCards.version))
    throw error(409, '订单或账号已变化，请重新打开银行卡详情');
  if (action !== 'details') {
    if (!originalCard.number) {
      if (originalCard.card.status === '卡池暂时无法读取') throw error(503, '卡池暂时无法读取，请重试');
      throw error(404, '银行卡号已不可用，仍可查看订单历史');
    }
    const { version } = store.featureDocument(cardTypeDocument);
    const label = action === 'reveal' ? '查看续费银行卡号'
      : command.context === 'renewal' ? '复制续费银行卡资料' : '复制订阅银行卡资料';
    store.auditFeature(cardTypeDocument, version, { action: label, actor, targetId: order.id });
    if (action === 'copy')
      return cardCopyText(order, originalCard.card.typeName, originalCard.number, originalCard.card.estimate);
    return { number: originalCard.number };
  }
  const view = (row, account, card) => ({
    id: row.id, version: row.version, orderNo: row.orderNo || row.id, payment: row.payment,
    account: account.account, card: card.card
  });
  return {
    order: view(order, original, originalCard),
    renewal: renewal ? view(renewal, candidateAccount, renewalCard) : null,
    ...(command.renewalOrderId && !renewal && { renewalStatus: '续费新单关联待核对' })
  };
}

function cardCopyText(order, type, number, estimate) {
  return { text: [type, number, [order.product, order.plan].filter(Boolean).join(' ') || '未登记',
    estimate.usd ? estimate.usd + ' USD' : '待核算'].join(' / ') };
}

async function writeType(store, client, command, actor) {
  const current = store.featureDocument(cardTypeDocument);
  if (command.version !== current.version) throw error(409, '银行卡类型已更新，请刷新后重试');
  const data = structuredClone(classify(current.data));
  const item = command.action === 'add' ? undefined : data.items.find(row => row.id === command.id && row.active);
  let target = command.id, label, importTypes;
  switch (command.action) {
    case 'add':
    case 'rename': {
      if (command.action === 'rename' && !item) throw error(404, '银行卡类型已停用或不存在');
      const name = typeof command.name === 'string' ? command.name.trim() : '';
      if (!name || name.length > 40 || /[\p{Cc}\p{Cf}\/]/u.test(name)) throw error(400, '请输入 1 至 40 字的银行卡类型名称，名称不能含斜杠');
      if (data.items.some(row => row !== item && row.active && row.name.toLowerCase() === name.toLowerCase()))
        throw error(409, '银行卡类型名称已存在');
      if (item) item.name = name;
      else {
        target = 'card-type-' + randomUUID();
        data.items.push({ id: target, name, active: true });
      }
      label = item ? '修改银行卡类型' : '新增银行卡类型';
      break;
    }
    case 'remove': {
      if (!item) throw error(404, '银行卡类型已停用或不存在');
      const used = Object.values(data.assignments).includes(item.id) ||
        (store.load('commerce').data?.orders || []).some(order => order.cardTypeId === item.id ||
          order.corrections?.some(entry => entry.previous?.cardTypeId === item.id));
      if (used) item.active = false;
      else data.items = data.items.filter(row => row !== item);
      label = '删除银行卡类型';
      break;
    }
    case 'assign': {
      target = command.cardId;
      if (!recognizedCard(target) || target.startsWith('orbitcard:')) throw error(400, '请选择可管理的银行卡');
      if (command.typeId !== '' && !data.items.some(row => row.id === command.typeId && row.active))
        throw error(400, '请选择有效的银行卡类型');
      const card = target.startsWith('recharge:') ? await poolCard(client, target) : tenantCard(store, target);
      if (!card) throw error(404, '银行卡已删除，历史记录仍可查看');
      if (command.typeId) data.assignments[target] = command.typeId;
      else delete data.assignments[target];
      label = '设置银行卡类型';
      break;
    }
    case 'assign-imported': {
      if (actor.role !== 'super') throw error(403, '没有导入充值银行卡的权限');
      const { cardIds, typeId } = command;
      if (!Array.isArray(cardIds) || !cardIds.length || cardIds.length > 500 ||
          cardIds.some(id => typeof id !== 'string' || !/^recharge:[1-9]\d{0,19}$/.test(id)))
        throw error(400, '导入卡片编号无效');
      if (!data.items.some(row => row.id === typeId && row.active))
        throw error(400, '请选择有效的银行卡类型');
      const existing = new Set((await poolCards(client)).map(row => 'recharge:' + row.id));
      importTypes = { assigned: 0, alreadyAssigned: 0, conflict: 0, missing: 0 };
      for (const id of new Set(cardIds)) {
        if (!existing.has(id)) importTypes.missing++;
        else if (data.assignments[id] === typeId) importTypes.alreadyAssigned++;
        else if (data.assignments[id]) importTypes.conflict++;
        else {
          data.assignments[id] = typeId;
          importTypes.assigned++;
        }
      }
      if (!importTypes.assigned) {
        if (store.featureDocument(cardTypeDocument).version !== current.version)
          throw error(409, '银行卡类型已更新，请刷新后重试');
        return { version: current.version, ...data, importTypes };
      }
      target = typeId;
      label = '设置本批充值银行卡类型';
      break;
    }
    default: throw error(400, '不支持此银行卡类型操作');
  }
  const saved = store.saveFeatureDocument(cardTypeDocument, current.version, data, { action: label, actor, targetId: target });
  return { version: saved.version, ...saved.data, ...(importTypes && { importTypes }) };
}

export function createCardManagementHandler({ store, client, publicOrigin, clock = Date.now }) {
  return async (request, response, route, actor) => {
    if (!actor?.id || !['admin', 'super'].includes(actor.role)) return send(response, 403, { error: '没有管理订单用卡的权限' });
    const origin = publicOrigin || `http://${request.headers.host}`;
    if ((request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site'] === 'cross-site')
      return send(response, 403, { error: '请求来源未通过校验' });
    try {
      if (request.method === 'GET') {
        if (route === '/api/local/card-types') {
          const current = store.featureDocument(cardTypeDocument);
          return send(response, 200, { version: current.version, ...classify(current.data) });
        }
        if (route === '/api/local/subscription-card-estimates') {
          const orders = store.load('commerce').data?.orders || [];
          const { fixedFee, quotes } = currentEstimateContext(store);
          const now = clock();
          const items = orders.filter(order => orderCardIds(order).length).map(order => ({
            id: order.id, version: order.version, ...cardFundingEstimate(order, fixedFee, quotes, now)
          }));
          return send(response, 200, { items });
        }
        throw error(405, '不支持此操作');
      }
      if (request.method !== 'POST' || route === '/api/local/subscription-card-estimates') throw error(405, '不支持此操作');
      if (request.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(request.headers['content-type'] || ''))
        throw error(403, '请求来源未通过校验');
      const command = await readCommand(request, route === '/api/local/card-types' ? 20 * 1024 : undefined);
      let result;
      if (route === '/api/local/card-types') result = await writeType(store, client, command, actor);
      else if (route === detailsRoute || route === revealRoute || route === copyRoute) {
        const action = route === detailsRoute ? 'details' : route === revealRoute ? 'reveal' : 'copy';
        result = await readRenewalCard(store, client, command, actor, clock(), action);
      } else throw error(405, '不支持此操作');
      return send(response, 200, result);
    } catch (failure) {
      const status = [400, 403, 404, 405, 409, 503].includes(failure.status) ? failure.status : 500;
      return send(response, status, { error: status === 500 ? '银行卡操作未完成，请重试' : failure.message });
    }
  };
}
