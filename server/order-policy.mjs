import { isDeepStrictEqual } from 'node:util';
import { currencies, usesVirtualBankCard, validCurrencyCode } from '../modules/finance/accounting.mjs';
import { validApplePaidPrices as validateApplePrices } from './apple-funding.mjs';
import { personalPlans, personalProduct, samePersonalSubscription, stockTypeForProduct, subscriptionSeries, targetKey } from './personal-subscriptions.mjs';
import { orderNeedsAccount, orderOpeningConfirmed, orderTerminationTime, subscriptionTime } from '../frontend/order-opening.mjs';

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
const isClaudeOrder = order => order?.product === 'Claude Pro' || order?.product === 'Claude Max';
export const validApplePaidPrices = prices => validateApplePrices(prices, plans);
export const manualOrderDetailsAction = '补齐订单资料';

export function checkSubscriptionTermination(order, prior, action, now, allowHistoricalCreate = false) {
  const wasEnded = prior?.subscriptionEnded === true;
  const ended = order.subscriptionEnded === true;
  const priorTime = prior?.subscriptionEndedAt ?? '';
  const time = order.subscriptionEndedAt ?? '';
  const valid = Number.isFinite(orderTerminationTime(order, now));
  const priorValid = prior && Number.isFinite(orderTerminationTime(prior, now));
  if (wasEnded === ended && time === priorTime) {
    if (priorValid && !valid) return '订阅开始时间不能晚于已登记的实际终止时间';
    return;
  }
  if (!prior && allowHistoricalCreate && ended && (!time || valid)) return;
  if (priorValid) return '原订单已登记的实际终止时间必须保留';
  if (!prior || order.cancelled || !ended || !valid)
    return '请填写不早于订阅开始且不晚于当前的实际终止时间';
  if (wasEnded && action === manualOrderDetailsAction) return;
  if (action === '退款登记' && (order.refunds?.length || 0) === (prior.refunds?.length || 0) + 1) return;
  return '请通过原订单退款或历史资料补全登记实际终止时间';
}

export function checkNewOrder(order) {
  if (!order.product) return;
  const manual = order.source === '管理员手工';
  if (!Object.hasOwn(plans, order.product) || !plans[order.product].includes(order.plan))
    return '请选择当前可售套餐';
  if (personalProduct(order.product)) {
    if (order.costBasis === 'actual') return '新订单按费用规则核算';
    if (order.payment === '银行卡' && !isOrderBankMaterials(order) && (order.cardId || (!manual && order.paidConfirmed)) &&
      !/^recharge:.+/.test(order.cardId || '')) return '请选择本次使用的银行卡';
    return;
  }
  const businessTypes = isClaudeOrder(order) ? ['首次开通', '续费', '成品交付'] : ['续费', '成品交付'];
  if (!businessTypes.includes(order.businessType)) return '请选择有效的业务类型';
  if (order.costBasis === 'actual') return '新订单按费用规则核算，实际总成本请通过有依据的订单更正登记';
  const email = order.email ?? '';
  if (typeof email !== 'string' || ((email || (!manual && order.businessType !== '续费')) &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return '请填写有效订单邮箱';
  if (order.payment === '银行卡' && !isOrderBankMaterials(order)) {
    const gpt = order.product === 'GPT';
    if ((order.cardId || (!manual && !gpt && order.paidConfirmed)) &&
        !(typeof order.cardId === 'string' && order.cardId.startsWith(gpt ? 'recharge:' : 'tenant:')))
      return '请选择对应来源的银行卡';
  }
}

export function checkManualRenewalLink(order, previousOrders, nextOrders, now, legacyOpened = []) {
  if (order.renewalSourceVersion === undefined) return;
  const source = previousOrders.get(order.previousOrderId);
  if (order.source !== '管理员手工' || order.businessType !== '续费' || !source ||
      source.customerId !== order.customerId || !order.customerId || !stockTypeForProduct(order.product) ||
      stockTypeForProduct(source.product) !== stockTypeForProduct(order.product) ||
      (personalProduct(order.product) && subscriptionSeries(source) !== subscriptionSeries(order)) ||
      !Number.isSafeInteger(order.renewalSourceVersion) || order.renewalSourceVersion !== (source.version ?? 0) ||
      !isDeepStrictEqual(source, nextOrders.get(source.id)) || source.cancelled || source.subscriptionEnded ||
      !orderOpeningConfirmed(source, now, legacyOpened.includes(source.id)) ||
      (source.accountId && source.accountId !== order.accountId) ||
      (!orderNeedsAccount(source) && targetKey(source) !== targetKey(order)) ||
      (Number.isFinite(subscriptionTime(source.expiry)) && !(subscriptionTime(order.expiry) > subscriptionTime(source.expiry))))
    return '原订阅已变化或新到期时间未延长，请核对后重新登记续费';
  if ([...nextOrders.values()].some(row => row.id !== order.id && row.previousOrderId === source.id &&
      !row.cancelled && orderOpeningConfirmed(row, now, legacyOpened.includes(row.id))))
    return '该期订阅已有续费订单，请刷新后查看新单';
}

// This is an association of an already-recorded payment, not another payment.
// The original order and its evidence must remain intact apart from the card
// reference, one correction entry and the normal update metadata.
export function historicalGptCardBackfillError(prior, next, {
  action, card, changedOrderCount, previousLogs, nextLogs, actor
} = {}) {
  const fail = '原付款卡补录条件未满足，请单独核对订单和付款凭据';
  if (!prior || !next || action !== '更正订单' || changedOrderCount !== 1 ||
      next.cardBackfillConfirmed !== true || prior.product !== 'GPT' || prior.payment !== '银行卡' ||
      prior.paidConfirmed !== true || prior.cardId || prior.proMaterialMode === 'manual_card' || prior.cancelled || prior.source === '线上代充' ||
      prior.taskId || prior.taskEvidenceId || prior.rechargeCompletedAt ||
      (prior.refunds || []).length || (prior.bankReturns || []).length) return fail;
  if (!/^recharge:.+/.test(next.cardId || '') || !card?.active || card.id !== next.cardId ||
      !/^\d{4}$/.test(card.last4 || '') || next.paymentId !== card.last4 ||
      (prior.paymentId && prior.paymentId !== card.last4)) return fail;
  const history = [prior, ...(prior.corrections || []).map(item => item?.previous).filter(Boolean)];
  if (history.some(item => item.cardId || item.issueFeeSnapshot?.cardId || item.issueFeeSnapshot?.applied ||
      (item.paymentId && item.paymentId !== card.last4) ||
      (item.financialEvidence || []).some(entry => entry?.kind === 'payment' && entry.cardId))) return fail;
  const ignored = new Set(['cardId', 'paymentId', 'version', 'updatedAt', 'updatedBy', 'updatedById',
    'correctionReason', 'corrections', 'cardBackfillConfirmed', 'cardTypeId', 'cardTypeName']);
  const fields = new Set([...Object.keys(prior), ...Object.keys(next)]);
  for (const key of fields)
    if (!ignored.has(key) && !isDeepStrictEqual(prior[key], next[key])) return fail;
  if (!Number.isSafeInteger(prior.version) || next.version !== prior.version + 1) return fail;
  const corrections = prior.corrections || [];
  if (!Array.isArray(next.corrections) || next.corrections.length !== corrections.length + 1 ||
      !isDeepStrictEqual(next.corrections.slice(0, -1), corrections)) return fail;
  const correction = next.corrections.at(-1), reason = String(next.correctionReason || '').trim();
  const { corrections: _corrections, refunds: _refunds, bankReturns: _returns, ...snapshot } = prior;
  if (!reason || reason.length > 200 || /(?:\d[ -]?){12,19}/.test(reason) ||
      correction?.kind !== 'historical-card-backfill' || correction.verified !== true ||
      typeof correction.id !== 'string' || !correction.id || corrections.some(item => item?.id === correction.id) ||
      typeof correction.at !== 'string' || !correction.at ||
      correction?.reason !== reason || correction.versionAfter !== next.version ||
      !actor?.id || !['admin', 'super'].includes(actor.role) || correction.actorId !== actor.id ||
      next.updatedById !== actor.id ||
      !isDeepStrictEqual(correction.previous, snapshot)) return fail;
  if (!Array.isArray(previousLogs) || !Array.isArray(nextLogs)) return fail;
  if (nextLogs.length !== previousLogs.length + 1 || !isDeepStrictEqual(nextLogs.slice(1), previousLogs)) return fail;
  const entry = nextLogs[0], priorLogIds = new Set(previousLogs.map(item => item?.id));
  if (!entry?.id || priorLogIds.has(entry.id) || entry.type !== '更正订单' || entry.entityId !== prior.id || entry.actorId !== actor.id ||
      typeof entry.detail !== 'string' || !entry.detail.includes(reason)) return fail;
}

// The card was attached to the original payment after the fact; do not count
// the same payment twice merely because the old evidence had no card id.
export function matchesBackfilledPayment(order, payment, evidence) {
  if (!order?.cardId || !payment || !evidence || evidence.cardId || payment.cardId !== order.cardId ||
      payment.amount !== evidence.amount || payment.currency !== evidence.currency ||
      payment.payment !== evidence.payment) return false;
  return (order.corrections || []).some(item => item?.kind === 'historical-card-backfill' && item.verified === true &&
    item.previous?.paidConfirmed === true && !item.previous.cardId && item.previous.payment === payment.payment &&
    item.previous.paidAmount === payment.amount && item.previous.paidCurrency === payment.currency);
}
const proMaterialFields = ['proMaterialMode', 'proCardNumber', 'proCardSerial'];
const certificationFields = ['verifier', 'verifierPhone', 'kyc', 'claudeVerifierId'];
const proPeopleFields = ['tenantId', 'phone', ...certificationFields];
const cardMaterialModes = ['manual_card', 'pool_card', 'tenant_card'];
const proMaterialModes = new Set([...cardMaterialModes, 'people', 'none']);
const nonempty = (value) => value !== undefined && value !== null && value !== '';

const isClaudeProBank = (order) => order?.product === 'Claude Pro' && order.payment === '银行卡';

// Keep the existing encrypted document fields compatible with historical Pro orders.
// These fields now describe the bank-card materials of every order product.
export function isOrderBankMaterials(order) {
  return order?.payment === '银行卡' && Object.hasOwn(plans, order.product) &&
    (isClaudeOrder(order) ? proMaterialModes.has(order.proMaterialMode) : ['manual_card', 'pool_card', 'none'].includes(order.proMaterialMode));
}

export function sameRecordedBankPayment(before, after) {
  return before?.payment === '银行卡' && after?.payment === '银行卡' &&
    before.paidConfirmed === true && after.paidConfirmed === true &&
    before.paidAmount === after.paidAmount && before.paidCurrency === after.paidCurrency;
}

export function retainOrderCardNumber(order, prior, card) {
  if (order.payment !== '银行卡') { delete order.proCardNumber; return; }
  if (order.proMaterialMode === 'manual_card') return;
  const number = card?.number;
  if (typeof number === 'string' && /^\d{12,19}$/.test(number) && number.endsWith(order.paymentId))
    order.proCardNumber = number;
  else if (order.cardId && prior?.payment === order.payment && prior.cardId === order.cardId && prior.proCardNumber)
    order.proCardNumber = prior.proCardNumber;
  else delete order.proCardNumber;
}

export function normalizeClaudeProMaterials(order, prior, { allowLegacyCreate = false } = {}) {
  if (order?.payment !== '银行卡' || !Object.hasOwn(plans, order.product)) {
    if (proMaterialFields.some(field => nonempty(order[field]) && order[field] !== prior?.[field]))
      return '只有银行卡订单可以填写这组资料';
    return;
  }
  const { proMaterialMode: mode } = order;
  const claude = isClaudeOrder(order);
  const allowSerial = (order.source === '管理员手工' && mode === 'none') || cardMaterialModes.includes(mode) || order.product === 'GPT' || personalProduct(order.product) ||
    (claude && !nonempty(mode) && nonempty(order.cardId));
  if (mode === 'tenant_card') {
    if (prior?.proMaterialMode === mode && Object.hasOwn(prior, 'proCardSerial')) order.proCardSerial = prior.proCardSerial;
    else delete order.proCardSerial;
  } else if (allowSerial && (mode === 'manual_card' || nonempty(order.proCardSerial))) {
    if (nonempty(order.proCardSerial) && typeof order.proCardSerial !== 'string') return '请填写有效的卡序列号';
    const serial = typeof order.proCardSerial === 'string' ? order.proCardSerial.trim() : '';
    if (serial.length > 120 || /[\p{Cc}\p{Cf}]/u.test(serial)) return '卡序列号最多 120 个字，不能包含控制字符';
    order.proCardSerial = serial;
  }
  if (!prior && order.source === '管理员手工' && claude && nonempty(order.cardId) && !nonempty(mode))
    return '请选择该银行卡的登记方式';
  if (!nonempty(mode) && (order.source === '管理员手工' || !isClaudeProBank(order) || allowLegacyCreate || (isClaudeProBank(prior) && !nonempty(prior.proMaterialMode)))) {
    if (!allowSerial && nonempty(order.proCardSerial))
      return '请先选择银行卡资料或人员与补充资料';
    retainOrderCardNumber(order, prior);
    return;
  }
  if (!isOrderBankMaterials(order) || (order.product === 'Claude Max' && mode === 'people' && prior?.proMaterialMode !== mode))
    return '请选择有效的银行卡资料方式';
  if (nonempty(order.appleIdId)) return '银行卡资料不能关联苹果 ID';
  const prefix = mode === 'pool_card' ? 'recharge:' : mode === 'tenant_card' ? 'tenant:' : '';
  if (prefix) {
    if (typeof order.cardId !== 'string' || !order.cardId.startsWith(prefix) || order.cardId.length <= prefix.length)
      return '请选择对应来源的银行卡';
  } else {
    if (nonempty(order.cardId)) return '所选资料方式不能关联银行卡池';
    order.cardId = '';
  }
  const mismatchedPeople = claude
    ? nonempty(order.tenantId) && order.tenantId !== prior?.tenantId
    : proPeopleFields.some(field => nonempty(order[field]) && !(field === 'kyc' && order.kyc === '未认证'));
  if (mode === 'manual_card') {
    if (mismatchedPeople) return '手工银行卡方式不能关联其他租户';
    const number = typeof order.proCardNumber === 'string'
      ? order.proCardNumber.trim().replace(/[ -]/g, '') : '';
    if (!/^\d{12,19}$/.test(number)) return '请输入 12 至 19 位有效银行卡号';
    order.proCardNumber = number;
    order.paymentId = number.slice(-4);
    return;
  }
  if ((!prefix && nonempty(order.proCardNumber)) || (!allowSerial && nonempty(order.proCardSerial)))
    return '银行卡资料和人员与补充资料只能选择一种';
  retainOrderCardNumber(order, prior);
  if (!allowSerial) delete order.proCardSerial;
  if (!prefix) order.paymentId = '';
  if ((mode === 'pool_card' || mode === 'none') && mismatchedPeople)
    return '所选资料方式不能关联其他租户';
  if (mode === 'none' && order.product === 'Claude Max' && order.source !== '管理员手工' &&
      order.paidConfirmed && !prior?.paidConfirmed) return '请选择本次银行卡或手动填写卡号';
  if (mode === 'tenant_card' && !nonempty(order.tenantId)) return '请选择银行卡所属租户';
  if (mode === 'people' && !order.tenantId && !order.phone) return '请选择租户或填写订阅电话';
}

export function normalizeClaudeCertification(order, prior, tenants,
  { allowLegacyCreate = false, allowHistoricalCorrection = false } = {}) {
  const verifierId = order.claudeVerifierId;
  const selected = Object.hasOwn(order, 'claudeVerifierId') && (verifierId !== prior?.claudeVerifierId ||
    (allowHistoricalCorrection && ['verifier', 'verifierPhone'].some(field => order[field] !== prior?.[field])));
  delete order.claudeVerifierId;
  if (!isClaudeOrder(order)) return selected ? '只有 Claude 订单可以登记认证人' : undefined;
  if (prior && order.plan !== prior.plan && !plans[order.product].includes(order.plan))
    return '请选择与原订单产品匹配的套餐';
  if (prior && order.businessType !== prior.businessType)
    return '已保存的业务类型不直接切换，请登记独立新订单';

  if (nonempty(order.tenantId) && order.tenantId !== prior?.tenantId &&
      !tenants.some(tenant => tenant.id === order.tenantId && tenant.active !== false))
    return '请选择可用的租户';
  if (nonempty(order.phone) && order.phone !== prior?.phone) {
    const phone = typeof order.phone === 'string' ? order.phone.trim() : '';
    const digits = phone.replace(/\D/g, '').length;
    if (!/^\+?\d[\d ()-]{4,31}$/.test(phone) || digits < 5 || digits > 20)
      return '请填写有效的订阅电话';
    order.phone = phone;
  }

  if (order.businessType === '续费') {
    if (nonempty(verifierId)) return '续费无需登记认证人';
    if (!prior && allowLegacyCreate) return;
    for (const field of certificationFields) {
      if (prior?.businessType === '续费' && Object.hasOwn(prior, field)) order[field] = prior[field];
      else delete order[field];
    }
    return;
  }

  if (selected) {
    const verifier = tenants.find(tenant => tenant.id === verifierId && tenant.active !== false);
    if (typeof verifierId !== 'string' || (verifierId && !verifier)) return '请选择可用的认证人';
    order.verifier = verifier?.name || '';
    order.verifierPhone = verifier?.phone || '';
    if (verifier) order.claudeVerifierId = verifier.id;
  } else if (prior || !allowLegacyCreate) {
    for (const field of ['verifier', 'verifierPhone', 'claudeVerifierId']) {
      if (prior && Object.hasOwn(prior, field)) order[field] = prior[field];
      else delete order[field];
    }
  }
  const changedStatus = selected || prior?.kyc !== order.kyc;
  if (changedStatus && nonempty(order.kyc) && !['未认证', 'KYC 认证'].includes(order.kyc))
    return '请选择有效的认证状态';
  if (changedStatus && order.kyc === 'KYC 认证' && (!order.verifier || !order.verifierPhone))
    return 'KYC 认证须选择有联系电话的认证人';
}

const proSnapshotFields = ['payment', 'cardId', ...proMaterialFields, ...proPeopleFields];
const sameProMaterials = (left, right) => proSnapshotFields.every((field) =>
  (left?.[field] ?? '') === (right?.[field] ?? ''));

export function checkClaudeProMaterialHistory(order, prior, action) {
  if (!prior) return;
  const certificationChanged = isClaudeOrder(order) && certificationFields.some(field =>
    (order[field] ?? '') !== (prior[field] ?? ''));
  if (!certificationChanged && prior.payment !== '银行卡' && order.payment !== '银行卡') return;
  const before = prior.corrections || [];
  const after = order.corrections || [];
  if (!Array.isArray(after) || before.some((entry, index) => !isDeepStrictEqual(entry, after[index])))
    return '原银行卡资料更正记录必须保留';
  if (sameProMaterials(prior, order)) return;
  if (order.version !== prior.version + 1) return '订单版本已变化，请重新核对';
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
  return '请通过订单更正操作登记银行卡资料变化并保留原记录';
}

export function checkClaudeProRenewalSource(order, prior, previousOrders, nextOrders, { allowLegacyCreate = false } = {}) {
  const fields = ['proRenewalSourceId', 'proRenewalSourceVersion'];
  const hasVersionedSource = fields.some(field => nonempty(order[field]));
  const linked = hasVersionedSource || nonempty(order.claudeRenewalId);
  if (!isClaudeOrder(order)) return linked ? '只有 Claude 订单可以关联快捷续费来源' : undefined;
  if (prior) {
    if ([...fields, 'claudeRenewalId'].some(field => (order[field] ?? '') !== (prior[field] ?? '')))
      return '已登记的 Claude 续费来源不可更换';
    return;
  }
  if (!linked) return;
  const email = typeof order.email === 'string' ? order.email.trim().toLowerCase() : '';
  if (!email && order.renewalSourceVersion === undefined) return '请填写邮箱后关联原 Claude 续费订单';
  if (allowLegacyCreate && !hasVersionedSource) return;
  if (order.businessType !== '续费' ||
      (nonempty(order.claudeRenewalId) && order.claudeRenewalId !== order.proRenewalSourceId) ||
      typeof order.proRenewalSourceId !== 'string' || !Number.isSafeInteger(order.proRenewalSourceVersion))
    return 'Claude 续费来源格式无效';
  const source = previousOrders.get(order.proRenewalSourceId);
  const sourcePlan = source?.product === 'Claude Pro' && source.plan === 'pro' ? 'Pro'
    : source?.product === 'Claude Max' && source.plan === 'max5' ? 'Max 5x'
      : source?.product === 'Claude Max' && source.plan === 'max20' ? 'Max 20x' : source?.plan;
  if (!source || !isDeepStrictEqual(source, nextOrders.get(source.id)) ||
      source.cancelled || source.subscriptionEnded || source.product !== order.product || sourcePlan !== order.plan ||
      (source.version ?? 0) !== order.proRenewalSourceVersion || !source.customerId || source.customerId !== order.customerId ||
      (!orderNeedsAccount(source) && String(source.email).trim().toLowerCase() !== email))
    return '原 Claude 订单已变化，请重新核对客户和账号后续费';
  for (const row of [...previousOrders.values(), ...nextOrders.values()]) {
    if (row.id !== order.id && (row.proRenewalSourceId === source.id || row.claudeRenewalId === source.id))
      return '该 Claude 订单已有续费记录，请从最新订单续费';
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

const validGroupedPaidPrices = (prices, acceptsProduct) =>
  validOrderPrices(prices) && Object.keys(prices).every(acceptsProduct) && Object.values(prices).every(paidPriceCurrenciesValid);

export function validClaudePaidPrices(prices) {
  return validGroupedPaidPrices(prices, product => product === 'Claude Pro' || product === 'Claude Max');
}

export function validPersonalPaidPrices(prices) {
  return validGroupedPaidPrices(prices, personalProduct);
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
  if ((order.product !== 'GPT' && !personalProduct(order.product) && !isClaudeOrder(order)) ||
      order.payment !== '银行卡' || !order.paidConfirmed || !usesVirtualBankCard(order)) return;
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

export function normalizePaymentEvidence(row, prior, automatic) {
  if (!row.product) return;
  const evidence = Array.isArray(row.financialEvidence) ? row.financialEvidence : [];
  const historical = Array.isArray(prior?.financialEvidence) ? prior.financialEvidence : [];
  const normalized = historical.filter((item) => item?.kind === 'payment');
  const previous = prior?.paidConfirmed ? prior : null;
  for (const payment of automatic ? [] : [previous, row]) {
    // Editing card materials is not a second payment. The original evidence stays immutable.
    if (payment === row && sameRecordedBankPayment(prior, row)) continue;
    if (!payment?.paidConfirmed || (!validMoney(payment.paidAmount) || !/[1-9]/.test(payment.paidAmount)) ||
        !validCurrencyCode(payment.paidCurrency)) continue;
    const cardId = payment.cardId || '';
    const candidate = { amount: payment.paidAmount, currency: payment.paidCurrency, payment: payment.payment, cardId };
    if (!normalized.some((item) => item.amount === payment.paidAmount && item.currency === payment.paidCurrency &&
        item.payment === payment.payment && (item.cardId === cardId || matchesBackfilledPayment(prior, candidate, item) ||
          payment.corrections?.some(change => sameRecordedBankPayment(change.previous, payment) &&
            (change.previous.cardId || '') === item.cardId)))) {
      normalized.push({ kind: 'payment', amount: payment.paidAmount, currency: payment.paidCurrency,
        payment: payment.payment, cardId, at: new Date().toISOString() });
    }
  }
  const receipts = evidence.filter((item) => item?.kind !== 'payment');
  if (!isDeepStrictEqual(evidence.filter((item) => item?.kind === 'payment'), normalized))
    row.financialEvidence = [...normalized, ...receipts];
}
