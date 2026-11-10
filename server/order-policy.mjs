import { isDeepStrictEqual } from 'node:util';
import { currencies, validCurrencyCode } from '../modules/finance/accounting.mjs';
import { personalPlans, personalProduct, samePersonalSubscription } from './personal-subscriptions.mjs';

export const rechargePlanLabels = Object.freeze({
  plus: 'Plus', pro100: 'Pro 100', pro200: 'Pro 200', pro500: 'Pro 500'
});
const bands = {
  Plus: ['20', '99'], 'Pro 100': ['100', '199'], 'Pro 200': ['220', '499'], 'Pro 500': ['500', ''],
  Pro: ['20', '99'], 'Max 5x': ['100', '249'], 'Max 20x': ['250', '']
};
const plans = {
  GPT: Object.values(rechargePlanLabels), 'Claude Pro': ['Pro'], 'Claude Max': ['Max 5x', 'Max 20x'], ...personalPlans
};
export function checkNewOrder(order) {
  if (!order.product) return;
  if (!Object.hasOwn(plans, order.product) || !plans[order.product].includes(order.plan))
    return '请选择当前可售套餐';
  if (personalProduct(order.product)) {
    if (order.costBasis === 'actual') return '新订单按费用规则核算';
    if (order.payment === '银行卡' && (order.cardId || order.paidConfirmed) &&
      !/^recharge:.+/.test(order.cardId || '')) return '请选择本次使用的银行卡';
    return;
  }
  if (!['续费', '成品交付'].includes(order.businessType)) return '请选择续费或成品交付';
  if (order.costBasis === 'actual') return '新订单按费用规则核算，实际总成本请通过有依据的订单更正登记';
  const email = order.email ?? '';
  if (typeof email !== 'string' || ((email || order.businessType !== '续费') &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return '请填写有效订单邮箱';
  if (order.payment === '银行卡' && !isClaudeProBankMaterials(order)) {
    const gpt = order.product === 'GPT';
    if ((order.cardId || (!gpt && order.paidConfirmed)) &&
        !(typeof order.cardId === 'string' && order.cardId.startsWith(gpt ? 'recharge:' : 'tenant:')))
      return '请选择对应来源的银行卡';
  }
}
const proMaterialFields = ['proMaterialMode', 'proCardNumber', 'proCardSerial'];
const proPeopleFields = ['tenantId', 'verifier', 'verifierPhone', 'phone', 'kyc'];
const proMaterialModes = new Set(['manual_card', 'people', 'pool_card', 'tenant_card', 'none']);
const nonempty = (value) => value !== undefined && value !== null && value !== '';

const isClaudeProBank = (order) => order?.product === 'Claude Pro' && order.payment === '银行卡';

export function isClaudeProBankMaterials(order) {
  return isClaudeProBank(order) && proMaterialModes.has(order.proMaterialMode);
}

export function normalizeClaudeProMaterials(order, prior, tenants, { allowLegacyCreate = false } = {}) {
  if (!isClaudeProBank(order)) {
    if (proMaterialFields.some((field) => nonempty(order[field])))
      return '只有 Claude Pro 银行卡订单可以填写这组资料';
    return;
  }
  const { proMaterialMode: mode } = order;
  if (!nonempty(mode) && (allowLegacyCreate || (isClaudeProBank(prior) && !nonempty(prior.proMaterialMode)))) {
    if (proMaterialFields.slice(1).some((field) => nonempty(order[field])))
      return '请先选择银行卡资料或人员与补充资料';
    return;
  }
  if (!isClaudeProBankMaterials(order)) return '请选择 Claude Pro 银行卡资料方式';
  if (nonempty(order.appleIdId)) return '银行卡资料不能关联苹果 ID';
  const prefix = mode === 'pool_card' ? 'recharge:' : mode === 'tenant_card' ? 'tenant:' : '';
  if (prefix) {
    if (typeof order.cardId !== 'string' || !order.cardId.startsWith(prefix) || order.cardId.length <= prefix.length)
      return '请选择对应来源的银行卡';
  } else {
    if (nonempty(order.cardId)) return '所选资料方式不能关联银行卡池';
    order.cardId = '';
  }
  if (mode === 'manual_card') {
    if (proPeopleFields.some((field) => nonempty(order[field])))
      return '银行卡资料和人员与补充资料只能选择一种';
    const number = typeof order.proCardNumber === 'string'
      ? order.proCardNumber.trim().replace(/[ -]/g, '') : '';
    if (!/^\d{12,19}$/.test(number)) return '请输入 12 至 19 位有效银行卡号';
    const serial = typeof order.proCardSerial === 'string' ? order.proCardSerial.trim() : '';
    if (!serial || serial.length > 120 || /[\p{Cc}\p{Cf}]/u.test(serial)) return '请填写有效的卡序列号';
    order.proCardNumber = number;
    order.proCardSerial = serial;
    order.paymentId = number.slice(-4);
    return;
  }
  if (nonempty(order.proCardNumber) || nonempty(order.proCardSerial))
    return '银行卡资料和人员与补充资料只能选择一种';
  delete order.proCardNumber;
  delete order.proCardSerial;
  if (!prefix) order.paymentId = '';
  if (mode === 'pool_card' || mode === 'none') {
    if (proPeopleFields.some((field) => nonempty(order[field])))
      return '所选资料方式不能混填认证人或补充资料';
    return;
  }
  if (mode === 'tenant_card' && !nonempty(order.tenantId)) return '请先选择认证人，再选择名下银行卡';
  const phone = typeof order.phone === 'string' ? order.phone.trim() : '';
  const phoneDigits = phone.replace(/\D/g, '').length;
  if (nonempty(order.phone) &&
      (!/^\+?\d[\d ()-]{4,31}$/.test(phone) || phoneDigits < 5 || phoneDigits > 20))
    return '请填写有效的订阅电话';
  if (!order.tenantId && !phone) return '请选择认证人或填写订阅电话';
  if (order.kyc && !['未认证', 'KYC 认证'].includes(order.kyc)) return '请选择有效的认证状态';
  const sameTenant = prior?.proMaterialMode === mode && prior.tenantId && prior.tenantId === order.tenantId;
  const tenant = sameTenant ? null : tenants.find((row) => row.id === order.tenantId && row.active !== false);
  if (order.tenantId && !sameTenant && !tenant) return '请选择可用的认证人';
  if (!order.tenantId && (order.verifier || order.verifierPhone))
    return '请先选择有效的认证人';
  order.verifier = (sameTenant ? prior.verifier : tenant?.name) || '';
  order.verifierPhone = (sameTenant ? prior.verifierPhone : tenant?.phone) || '';
  if (order.kyc === 'KYC 认证' && (!order.tenantId || !order.verifierPhone))
    return 'KYC 认证须选择有联系电话的认证人';
  if (phone) order.phone = phone;
}

const proSnapshotFields = ['payment', 'cardId', ...proMaterialFields, ...proPeopleFields];
const sameProMaterials = (left, right) => proSnapshotFields.every((field) =>
  (left?.[field] ?? '') === (right?.[field] ?? ''));

export function checkClaudeProMaterialHistory(order, prior, action) {
  if (!prior || (!isClaudeProBankMaterials(prior) && !isClaudeProBankMaterials(order))) return;
  const before = prior.corrections || [];
  const after = order.corrections || [];
  if (!Array.isArray(after) || before.some((entry, index) => !isDeepStrictEqual(entry, after[index])))
    return '原 Claude Pro 资料更正记录必须保留';
  if (sameProMaterials(prior, order)) return;
  if (order.version !== prior.version + 1) return 'Claude Pro 订单版本已变化，请重新核对';
  if (action === '补偿撤回更正') {
    const correction = before.at(-1);
    if (correction?.versionAfter === prior.version && sameProMaterials(order, correction.previous))
      return;
  } else if (action === '更正订单' && after.length === before.length + 1) {
    const correction = after.at(-1);
    if (correction?.versionAfter === order.version && correction.previous?.version === prior.version &&
        typeof correction.reason === 'string' && correction.reason.trim() &&
        sameProMaterials(prior, correction.previous))
      return;
  }
  return '请通过订单更正操作登记 Claude Pro 资料变化并保留原记录';
}

export function checkClaudeProRenewalSource(order, prior, previousOrders, nextOrders) {
  const fields = ['proRenewalSourceId', 'proRenewalSourceVersion'];
  const hasNewSource = fields.some((field) => nonempty(order[field]));
  const email = typeof order.email === 'string' ? order.email.trim().toLowerCase() : '';
  if (!email && ['Claude Pro', 'Claude Max'].includes(order.product) &&
      (hasNewSource || nonempty(order.claudeRenewalId)) && (!prior || nonempty(prior.email)))
    return '请填写邮箱后关联原 Claude 续费订单';
  if (prior) {
    if (fields.some((field) => (order[field] ?? '') !== (prior[field] ?? '')) ||
        (prior.proRenewalSourceId && (order.claudeRenewalId ?? '') !== (prior.claudeRenewalId ?? '')))
      return '已登记的 Claude Pro 续费来源不可更换';
    return;
  }
  const proBank = isClaudeProBankMaterials(order);
  if (!hasNewSource && (!proBank || !nonempty(order.claudeRenewalId))) return;
  if (!proBank || order.businessType !== '续费' ||
      (nonempty(order.claudeRenewalId) && order.claudeRenewalId !== order.proRenewalSourceId) ||
      typeof order.proRenewalSourceId !== 'string' || !Number.isSafeInteger(order.proRenewalSourceVersion))
    return 'Claude Pro 续费来源格式无效';
  const source = previousOrders.get(order.proRenewalSourceId);
  if (!source || !isDeepStrictEqual(source, nextOrders.get(source.id)) ||
      source.cancelled || source.product !== order.product ||
      source.version !== order.proRenewalSourceVersion || source.customerId !== order.customerId ||
      source.email?.trim().toLowerCase() !== email)
    return '原 Claude Pro 订单已变化，请重新核对客户和邮箱后续费';
  for (const row of [...previousOrders.values(), ...nextOrders.values()]) {
    if (row.id !== order.id && (row.proRenewalSourceId === source.id || row.claudeRenewalId === source.id))
      return '该 Claude Pro 订单已有续费记录，请从最新订单续费';
  }
}

export function redactClaudeProOrderMaterials(value, actor) {
  if (['admin', 'super'].includes(actor?.role)) return value;
  return JSON.parse(JSON.stringify(value, (field, fieldValue) => {
    if (field === 'proCardSerial') return undefined;
    if (field !== 'proCardNumber') return fieldValue;
    return typeof fieldValue === 'string' && /^\d{12,19}$/.test(fieldValue)
      ? `•••• ${fieldValue.slice(-4)}` : undefined;
  }));
}

export function assignOrderOwner(order, prior, actor, owners = []) {
  return assignOwner(order, prior, actor, owners, '订单');
}
export function assignTenantOwner(tenant, prior, actor, owners = []) {
  return assignOwner(tenant, prior, actor, owners, '租户');
}
function assignOwner(order, prior, actor, owners, kind) {
  if (prior) {
    if ((order.ownerId || '') !== (prior.ownerId || ''))
      return { status: 409, message: `已保存${kind}的归属人不可在资料更正中更换` };
    for (const field of ['ownerId', 'owner']) {
      if (Object.hasOwn(prior, field)) order[field] = prior[field];
      else delete order[field];
    }
    return;
  }
  if (order.ownerId !== undefined && typeof order.ownerId !== 'string')
    return { status: 400, message: `请选择有效的${kind}归属人` };
  const id = order.ownerId || actor.id;
  if (id !== actor.id && !['admin', 'super'].includes(actor.role))
    return { status: 403, message: `只有管理员可以为其他员工指定${kind}归属` };
  const owner = id === actor.id ? actor : owners.find(row => row.id === id && row.active !== false &&
    ['admin', 'super', 'employee'].includes(row.role));
  if (!owner) return { status: 409, message: '所选归属人已停用或不存在，请刷新人员列表' };
  order.ownerId = owner.id;
  order.owner = owner.name;
}
export const validMoney = (value) => typeof value === 'string' && /^\d{1,16}(?:\.\d{1,4})?$/.test(value);
export const moneyUnits = (value) => {
  if (!validMoney(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole + fraction.padEnd(4, '0'));
};

export function validOrderPrices(prices) {
  const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
  return record(prices) && Object.entries(prices).every(([product, rows]) =>
    Object.hasOwn(plans, product) && record(rows) && Object.entries(rows).every(([plan, amounts]) =>
      plans[product].includes(plan) && record(amounts) && Object.entries(amounts).every(([currency, value]) =>
        validCurrencyCode(currency) && (value === '' || validMoney(value)))));
}

const paidPriceCurrenciesValid = (prices) =>
  Object.values(prices).every(amounts => Object.keys(amounts).every(code => currencies.includes(code)));

export function validGptPaidPrices(prices) {
  return validOrderPrices({ GPT: prices }) && paidPriceCurrenciesValid(prices);
}

export function validClaudePaidPrices(prices) {
  return validOrderPrices(prices) && Object.keys(prices).every(product => ['Claude Pro', 'Claude Max'].includes(product)) &&
    Object.values(prices).every(paidPriceCurrenciesValid);
}

export function nextOrderNo(orders) {
  let maximum = 0;
  for (const row of orders) {
    const sequence = Number(/^OD-LOCAL-(\d{1,12})$/.exec(row?.orderNo)?.[1] || 0);
    maximum = Math.max(maximum, sequence);
  }
  return 'OD-LOCAL-' + String(maximum + 1).padStart(4, '0');
}

const sameSubscription = (a, b) => a.product === b.product && a.email && b.email &&
  a.email.trim().toLowerCase() === b.email.trim().toLowerCase();

export function checkAppleOrder(order, prior, priorOrders, ledger, inventory, allOrders) {
  const personal = personalProduct(order.product);
  if (personal && !order.paidConfirmed) return;
  if (order.payment !== '苹果内购' || !order.appleIdId) return;
  if (prior?.appleIdId === order.appleIdId && prior?.payment === order.payment &&
      prior?.email === order.email && prior?.product === order.product && prior?.plan === order.plan &&
      prior?.businessType === order.businessType && (prior.paidConfirmed || !order.paidConfirmed)) return;
  const account = (inventory?.mailboxes || []).find((row) => row.id === order.appleIdId && row.type === 'apple');
  const wallet = (ledger?.wallets || []).find((row) => row.id === order.appleIdId);
  const balance = moneyUnits(wallet?.balance ?? '0');
  const cost = moneyUnits(order.paidAmount);
  if (!account || account.deleted || (account.status && account.status !== '正常') || (account.health && account.health !== 'normal') ||
      wallet?.currency !== 'USD' || balance === null || cost === null || balance < cost)
    return '苹果 ID 必须正常且有足够美元余额';
  if (order.businessType === '续费') {
    const previous = priorOrders.filter((row) => row.id !== order.id &&
      (personal ? row.customerId === order.customerId && samePersonalSubscription(order, row)
        : sameSubscription(order, row)) &&
      row.payment === '苹果内购' && row.appleIdId && row.paidConfirmed && !row.cancelled)
      .sort((a, b) => String(b.start).localeCompare(String(a.start)));
    if (previous.length && previous[0].appleIdId === order.appleIdId) return;
    if (previous.length || !personal || order.appleOriginalVerified !== true ||
        typeof order.appleOriginalReceipt !== 'string' || !order.appleOriginalReceipt.trim())
      return '苹果内购续费必须选择原订阅的苹果 ID';
  }
  if ((ledger?.movements || []).some((row) => row.appleIdId === order.appleIdId &&
        (row.orderId || ['charge', 'order-debit'].includes(row.kind))) ||
      allOrders.some((row) => row.id !== order.id && row.appleIdId === order.appleIdId && row.paidConfirmed))
    return '首次分配只能使用未用于订阅的苹果 ID';
  if (personal) return;
  const band = bands[order.plan];
  if (!band) return '当前套餐没有苹果 ID 匹配规则';
  const min = moneyUnits(order.appleMatchMin || band[0]);
  const maxText = order.appleMatchMax === undefined ? band[1] : order.appleMatchMax;
  const max = maxText === '' ? null : moneyUnits(maxText);
  if (min === null || (maxText !== '' && max === null) || (max !== null && max < min) ||
      balance < min || (max !== null && balance > max)) return '苹果 ID 余额不在本单匹配区间';
}

export function deriveCardIssueFee(order, prior, orders, card) {
  if (prior?.issueFeeSnapshot?.applied && prior.cardId === order.cardId)
    return prior.issueFeeSnapshot;
  if ((order.product !== 'GPT' && !personalProduct(order.product)) || order.payment !== '银行卡' || !order.paidConfirmed) return;
  const previouslyUsed = orders.some((row) => row.id !== order.id &&
    (row.cardId === order.cardId && (row.paidConfirmed || row.issueFeeSnapshot?.applied) ||
      (row.financialEvidence || []).some((entry) => entry.kind === 'payment' && entry.cardId === order.cardId)));
  const applies = card?.usageCount === 0 && !card.lastUsedAt && !previouslyUsed;
  return {
    cardId: order.cardId || '', applied: applies,
    ...(applies ? { amountUsd: order.costSettings?.cardIssueUsd || '0', at: new Date().toISOString() }
      : { pending: !previouslyUsed })
  };
}
