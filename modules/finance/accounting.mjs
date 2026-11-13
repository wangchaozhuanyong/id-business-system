// Browser and server share this module. Monetary inputs and outputs are decimal strings.
export const currencies = Object.freeze(['CNY', 'MYR', 'USD', 'PHP', 'CLP', 'IDR', 'EGP']);
export const validCurrencyCode = code => typeof code === 'string' && /^[A-Z]{3}$/.test(code);
export const snapshotAction = '登记订单汇率快照';
export const automaticProvider = Object.freeze({
  id: 'currency-api',
  source: 'Fawaz Currency API'
});
export const fallbackQuoteProvider = Object.freeze({
  id: 'frankfurter-v2',
  source: 'Frankfurter v2'
});
// Existing frozen quotes keep their original provider, source, dates and values.
export const normalizeAutomaticProvider = provider =>
  provider === 'exchange-rate-api-open' ? automaticProvider.id : provider;
export const isAutomaticQuote = quote =>
  (quote?.provider === automaticProvider.id && quote.source === automaticProvider.source) ||
  (quote?.provider === fallbackQuoteProvider.id && quote.source === fallbackQuoteProvider.source) ||
  (quote?.provider === 'exchange-rate-api-open' && quote.source === 'ExchangeRate-API');
export const compareQuoteRecency = (a, b) =>
  Date.parse(b.at) - Date.parse(a.at) ||
  Date.parse(b.lastSeenAt || b.fetchedAt) - Date.parse(a.lastSeenAt || a.fetchedAt);
const targets = ['CNY', 'MYR'];
const one = 10n ** 4n;
const rateOne = 10n ** 8n;

function unsigned(value, places = 4) {
  if (typeof value !== 'string' || !new RegExp(`^\\d{1,20}(?:\\.\\d{1,${places}})?$`).test(value))
    throw new Error('金额或汇率必须是有效的十进制小数');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole + fraction.padEnd(places, '0'));
}

function formatted(units, places = 4) {
  const magnitude = units < 0n ? -units : units;
  const digits = magnitude.toString().padStart(places + 1, '0');
  return `${units < 0n ? '-' : ''}${digits.slice(0, -places)}.${digits.slice(-places)}`;
}

export function renewalFundingUsd(amount, fixedFee, rateToCny = '1', usdRateToCny = '1') {
  const paid = unsigned(amount);
  const fee = unsigned(fixedFee) + 2n * one;
  const rate = unsigned(rateToCny, 8);
  const usdRate = unsigned(usdRateToCny, 8);
  if (!paid || !rate || !usdRate) throw new Error('续费预计金额的计算依据无效');
  const units = paid * rate + fee * usdRate;
  const cent = usdRate * (one / 100n);
  return formatted((units + cent - 1n) / cent, 2);
}

function rounded(numerator, denominator) {
  const magnitude = numerator < 0n ? -numerator : numerator;
  const result = (magnitude + denominator / 2n) / denominator;
  return numerator < 0n ? -result : result;
}

// Local date/time fields are Beijing time; storage uses canonical UTC.
function instant(value) {
  if (typeof value !== 'string') return NaN;
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/.exec(value);
  const iso = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):(\d{2})(\.\d{3})?Z$/.exec(value);
  const match = local || iso;
  if (!match) return NaN;
  const base = `${match[1]}T${match[2]}:${match[3] || '00'}`;
  const ms = Date.parse(base + (iso?.[4] || '.000') + 'Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== base) return NaN;
  return local ? ms - 8 * 3600000 : ms;
}

function normalizeSnapshot(input, orderAt, clock) {
  const source = typeof input?.source === 'string' ? input.source.trim() : '';
  const at = instant(input?.at), expiresAt = instant(input?.expiresAt);
  const basisAt = instant(orderAt);
  if (!source || source.length > 160 || /演示|示例|\bdemo\b|\bsample\b/i.test(source))
    throw new Error('请填写真实的汇率来源与凭据编号，不使用演示值');
  if (![at, expiresAt, basisAt, clock].every(Number.isFinite) ||
      at > clock || basisAt > clock || expiresAt <= at)
    throw new Error('请核对订单时间、报价时点和有效截止时间');
  if (basisAt < at || basisAt >= expiresAt)
    throw new Error('报价在本次订阅时点尚未生效或已过期');
  if (!input.rates || typeof input.rates !== 'object' || Array.isArray(input.rates))
    throw new Error('请填写兑人民币汇率');
  const rates = { CNY: '1' };
  for (const [currency, value] of Object.entries(input.rates)) {
    if (!validCurrencyCode(currency)) throw new Error('汇率币种不受支持');
    if (currency !== 'CNY' && value === '') continue;
    const rate = unsigned(value, 8);
    if (!rate || (currency === 'CNY' && rate !== rateOne))
      throw new Error('汇率必须大于零，人民币基准固定为 1');
    if (currency !== 'CNY') rates[currency] = value;
  }
  return {
    source,
    at: new Date(at).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    basisAt: new Date(basisAt).toISOString(),
    rates
  };
}

export function createManualSnapshot(input, orderAt, clock = Date.now()) {
  if (input.basis !== undefined && !['settlement', 'reference'].includes(input.basis))
    throw new Error('请选择有效的汇率依据');
  return { kind: 'manual', ...(input.basis && { basis: input.basis }), ...normalizeSnapshot(input, orderAt, clock) };
}

function normalizeAutomaticSnapshot(input, orderAt, clock) {
  if (!isAutomaticQuote(input))
    throw new Error('订单自动汇率来源未经确认');
  const checked = normalizeSnapshot(input, orderAt, clock);
  const fetchedAt = instant(input.fetchedAt);
  if (!(fetchedAt >= instant(checked.at) && fetchedAt < instant(checked.expiresAt) && fetchedAt <= clock))
    throw new Error('自动报价采集时间无效');
  if (input.quoteId !== undefined && !/^fxq-[a-f0-9]{64}$/.test(input.quoteId))
    throw new Error('自动报价凭据编号无效');
  return { kind: 'automatic', provider: input.provider, fetchedAt: new Date(fetchedAt).toISOString(),
    ...(input.quoteId && { quoteId: input.quoteId }), ...checked };
}

function readSnapshot(order, clock) {
  const snapshot = order.fxSnapshot;
  if (!snapshot) throw new Error('订单缺少有效汇率快照');
  if (snapshot.kind !== 'manual' && snapshot.kind !== 'automatic')
    throw new Error('订单汇率来源未经确认');
  const checked = snapshot.kind === 'automatic'
    ? normalizeAutomaticSnapshot(snapshot, snapshot.basisAt, clock)
    : createManualSnapshot(snapshot, snapshot.basisAt, clock);
  const current = instant(orderAccountingAt(order));
  if (!(current >= instant(checked.at) && current < instant(checked.expiresAt) && current <= clock))
    throw new Error('更正后的订阅时间不在原汇率有效期内');
  return checked;
}

function sumOrderAmounts(rows, currency, field) {
  return rows.reduce((sum, row) => {
    if (row.currency !== currency) throw new Error(`${field}币种与原订单不符`);
    return sum + unsigned(row.amount);
  }, 0n);
}

function netReceiptUnits(order) {
  const sold = unsigned(order.saleAmount);
  const refunded = sumOrderAmounts(order.refunds || [], order.saleCurrency, '客户退款');
  if (refunded > sold) throw new Error('客户退款超过原实收');
  return sold - refunded;
}

export function calculateConfirmedNetReceipt(order, { currency = 'CNY', clock = Date.now() } = {}) {
  if (!order || (order.source === '线上代充' && order.receiptConfirmed !== true) || order.cancelled || order.draft ||
      ['draft', '草稿'].includes(order.status) || !targets.includes(currency) ||
      !validCurrencyCode(order.saleCurrency) || !Array.isArray(order.refunds)) return null;
  try {
    const net = netReceiptUnits(order);
    if (!net || order.saleCurrency === currency) return formatted(net);
    const { rates } = readSnapshot(order, clock);
    return formatted(rounded(net * unsigned(rates[order.saleCurrency], 8), unsigned(rates[currency], 8)));
  } catch {
    return null;
  }
}

const personalBankProducts = ['Gemini', 'Grok'];
const bankProducts = ['GPT', 'Claude Pro', 'Claude Max', ...personalBankProducts];
const isClaude = order => ['Claude Pro', 'Claude Max'].includes(order.product);
const unavailableOrders = ['draft', 'failed', '草稿', '失败'];
const isAutomatic = (order) => order.source === '线上代充';
// Saved manual amounts are accounting facts. This read rule never confirms a
// payment, charges a wallet, or changes an automatic task's payment result.
export function hasRecordedPaymentAmount(order) {
  if (!order || (isAutomatic(order) && order.paidConfirmed !== true) || !validCurrencyCode(order.paidCurrency)) return false;
  try { return unsigned(order.paidAmount) > 0n; } catch { return false; }
}
export const orderAccountingAt = (order) => isAutomatic(order) && order.rechargeCompletedAt || order.start;
const originalCardPayment = (order) =>
  // A materials correction does not move the already-recorded opening fee to another card.
  order.corrections?.find(change => change.kind !== 'historical-card-backfill' &&
    change.previous?.paidConfirmed && change.previous.payment === '银行卡' &&
    change.previous.paidAmount === order.paidAmount && change.previous.paidCurrency === order.paidCurrency &&
    (change.previous.cardId || '') !== (order.cardId || ''))?.previous || order;
const stableCardId = (order) => {
  const id = originalCardPayment(order).cardId;
  return typeof id === 'string' && id.trim() === id && id.length > 0 && !/^\d{4,19}$/.test(id) ? id : '';
};
function bankCardKind(order) {
  const { cardTypeId, cardTypeName, cardId, proMaterialMode } = originalCardPayment(order);
  if (cardTypeId === 'card-type-real' || cardTypeName?.trim() === '真实卡') return 'real';
  if (cardTypeId || cardTypeName) return 'virtual';
  if (proMaterialMode === 'tenant_card' || cardId?.startsWith('tenant:')) return 'real';
  if (!isClaude(order) || proMaterialMode === 'pool_card' || /^(recharge|orbitcard):/.test(cardId || '')) return 'virtual';
  return 'unknown';
}
export const usesVirtualBankCard = order => bankCardKind(order) === 'virtual';
const recordedKyc = order => order.businessType !== '续费' && !order.claudeRenewalId && !order.proRenewalSourceId &&
  (order.kyc === true || ['KYC 认证', 'KYC认证'].includes(order.kyc));
export const expenseAccountingModes = Object.freeze({
  kyc: Object.freeze(['cash', 'replace-kyc', 'included']),
  'card-issue': Object.freeze(['cash', 'replace-card']),
  'fx-fee': Object.freeze(['cash', 'add-fx', 'included'])
});
export function expenseAmountIn(receipt, currency) {
  if (receipt.currency === currency) return receipt.amount;
  return receipt.settlementCurrency === currency ? receipt.settlementAmount ?? null : null;
}

export function orderExpenseTerms(order, receipts) {
  const terms = [];
  for (const receipt of receipts) {
    const { category, accountingMode: mode = 'cash' } = receipt;
    if (receipt.voidedAt || mode === 'cash') continue;
    if (!Object.hasOwn(expenseAccountingModes, category) || !expenseAccountingModes[category].includes(mode))
      throw new Error('费用凭据的核算方式无效');
    if (!order || receipt.orderId !== order.id || (!hasRecordedPaymentAmount(order) && !usesRecordedActualCost(order)) || order.draft ||
        unavailableOrders.includes(order.status) || order.entitlementStatus === 'failed')
      throw new Error('费用凭据须关联已登记代付或具备实际总成本的有效原单');
    if (mode === 'replace-kyc' && (order.costBasis !== 'standard' || order.payment !== '银行卡' ||
        !['Claude Pro', 'Claude Max'].includes(order.product)))
      throw new Error('仅按规则核算的 Claude 银行卡订单可以替换 KYC 参考成本');
    if (mode === 'add-fx' && !['actual', 'standard'].includes(order.costBasis))
      throw new Error('请先核对原单的成本依据');
    if (mode === 'included' && order.costBasis !== 'actual')
      throw new Error('原单须已登记实际总成本，才可拆出已包含的费用');
    const cardId = mode === 'replace-card' && order.payment === '银行卡' && usesVirtualBankCard(order) ? stableCardId(order) : '';
    if (mode === 'replace-card' && (!cardId || (receipt.accountingCardId && receipt.accountingCardId !== cardId)))
      throw new Error('开卡费凭据关联的原付款卡待核对');
    const currency = mode === 'included' ? order.actualCostCurrency : receipt.settlementCurrency || receipt.currency;
    const amount = expenseAmountIn(receipt, currency);
    if (!validCurrencyCode(currency) || amount === null)
      throw new Error(mode === 'included' ? '已包含费用须有与原单实际总成本同币种的账单金额'
        : '凭据缺少用于核算的原币或结算金额');
    const units = unsigned(amount);
    if (!units) throw new Error('费用凭据金额须大于零');
    terms.push({ category, mode, units, currency, cardId,
      receipt: { id: receipt.id, source: receipt.source, reference: receipt.reference } });
  }
  if (terms.filter(term => term.mode === 'replace-kyc').length > 1)
    throw new Error('本单已有一笔替换 KYC 参考成本的凭据');
  const included = terms.filter(term => term.mode === 'included');
  if (included.length && included.reduce((total, term) => total + term.units, 0n) > unsigned(order.actualCostAmount))
    throw new Error('已包含费用合计超过原单实际总成本');
  return terms;
}

export const activeExpenseReceipt = (receipt, clock) => !receipt.voidedAt && typeof receipt.accountingMode === 'string' &&
  receipt.accountingMode !== 'cash' && Date.parse(receipt.chargedOn + 'T00:00:00+08:00') <= clock;
const compareKey = (a, b) => a === b ? 0 : a < b ? -1 : 1;
const openingOrder = (a, b) => a.at - b.at ||
  compareKey(a.order.orderNo || a.order.id, b.order.orderNo || b.order.id) || compareKey(a.order.id, b.order.id);

function confirmedCardOpening(order, clock) {
  const cardId = stableCardId(order);
  const auto = isAutomatic(order);
  const evidence = Array.isArray(order.financialEvidence) ? order.financialEvidence : [];
  const confirmed = auto || hasRecordedPaymentAmount(order) || Boolean(cardId && evidence.some((row) =>
    row?.kind === 'payment' && row.payment === '银行卡' && row.cardId === cardId));
  const start = instant(order.start), expiry = instant(order.expiry);
  const at = auto ? instant(order.rechargeCompletedAt) : start;
  if (!confirmed) return { order, cardId, at, state: 'unconfirmed' };
  if (personalBankProducts.includes(order.product) && order.entitlementStatus !== 'active')
    return { order, cardId, at, state: order.entitlementStatus === 'failed' ? 'failed' : 'unknown' };
  if (!Number.isFinite(at) || (Number.isFinite(start) && at < start) ||
      (order.expiry && !(at < expiry)))
    return { order, cardId, at, state: 'unknown' };
  return { order, cardId, at, state: at > clock ? 'future' : 'opened' };
}

function canUseUnlinkedCardReference(order, clock, opening) {
  if (order.cardId || !usesVirtualBankCard(order) || order.payment !== '银行卡' || order.costBasis !== 'standard' ||
      !['管理员手工', '历史入库'].includes(order.source) ||
      !hasRecordedPaymentAmount(order) ||
      order.cancelled || order.draft || unavailableOrders.includes(order.status)) return false;
  const { cardId, state } = opening || confirmedCardOpening(order, clock);
  return !cardId && state === 'opened';
}

// Use the complete order set, including successful orders later refunded or
// cancelled. Display filters and FX gaps do not alter a card's denominator.
export function buildCardIssueAllocations(orders, { clock = Date.now(), expenseReceipts = [] } = {}) {
  const result = new Map(), groups = new Map(), tasks = new Map();
  const pending = (reason) => ({ status: 'pending', reason });
  const cardReceipts = new Map();
  const ordersById = new Map(orders.filter(order => order?.id).map(order => [order.id, order]));
  for (const receipt of expenseReceipts) {
    if (receipt.accountingMode !== 'replace-card' || !activeExpenseReceipt(receipt, clock)) continue;
    const group = cardReceipts.get(receipt.accountingCardId) || [];
    group.push(receipt);
    cardReceipts.set(receipt.accountingCardId, group);
  }
  const candidates = [...new Map(orders.filter((row) => row?.id && row.payment === '银行卡' &&
    bankProducts.includes(row.product) && !row.draft && !unavailableOrders.includes(row.status))
    .map((row) => [row.id, row])).values()].map((row) => confirmedCardOpening(row, clock));
  const sameTask = new Set(), ambiguousCards = new Set(), feesOnFailedOpenings = new Map();
  for (const item of candidates) {
    if (!isAutomatic(item.order) || !item.order.taskId) continue;
    const group = tasks.get(item.order.taskId) || [];
    group.push(item);
    tasks.set(item.order.taskId, group);
  }
  for (const group of tasks.values()) {
    if (group.length < 2) continue;
    const cards = new Set(group.map((item) => item.cardId).filter(Boolean));
    const conflict = cards.size > 1;
    if (conflict) for (const id of cards) ambiguousCards.add(id);
    group.sort((a, b) => Number(b.state === 'opened' && Boolean(b.cardId)) -
      Number(a.state === 'opened' && Boolean(a.cardId)) || openingOrder(a, b));
    for (const item of conflict ? group : group.slice(1)) {
      sameTask.add(item.order.id);
      result.set(item.order.id, { status: 'duplicate', reason: conflict ? '同一代充任务关联多张卡，待核对' : '重复代充任务，待核对' });
    }
  }
  for (const item of candidates) {
    if (sameTask.has(item.order.id) || !usesVirtualBankCard(item.order)) continue;
    if (!item.cardId) {
      if (canUseUnlinkedCardReference(item.order, clock, item)) result.set(item.order.id, { status: 'unlinked' });
      else result.set(item.order.id, pending('缺少原付款银行卡的稳定编号'));
      continue;
    }
    if (item.state === 'failed') {
      if (item.order.issueFeeSnapshot?.applied === true) {
        const fees = feesOnFailedOpenings.get(item.cardId) || [];
        fees.push(item);
        feesOnFailedOpenings.set(item.cardId, fees);
      }
      continue;
    }
    if (item.state === 'future' || item.state === 'unconfirmed') {
      result.set(item.order.id, pending('本单成功开通待核对'));
      continue;
    }
    const group = groups.get(item.cardId) || [];
    group.push(item);
    groups.set(item.cardId, group);
  }

  for (const [cardId, group] of groups) {
    const charges = [...group.filter(({ order }) => order.issueFeeSnapshot?.applied === true),
      ...(feesOnFailedOpenings.get(cardId) || [])];
    const verified = cardReceipts.get(cardId);
    let total, appliedReceipt;
    let currency = 'USD';
    let reason;
    if (ambiguousCards.has(cardId) || group.some((item) => item.state !== 'opened')) {
      reason = '同卡开通记录存在待核对项';
    } else if (verified?.length) {
      try {
        if (verified.length !== 1 || ![...group, ...(feesOnFailedOpenings.get(cardId) || [])]
          .some(item => item.order.id === verified[0].orderId))
          throw new Error('发卡实付凭据或同卡原单待核对');
        const [term] = orderExpenseTerms(ordersById.get(verified[0].orderId), verified);
        total = term.units;
        currency = term.currency;
        appliedReceipt = term.receipt;
      } catch (error) {
        reason = error.message;
      }
    } else if (charges.length !== 1) {
      reason = charges.length ? '同卡有多份开卡费凭据' : '同卡开卡费凭据缺失';
    } else {
      const fee = charges[0].order.issueFeeSnapshot;
      try {
        if (fee.pending || fee.cardId !== cardId) throw new Error();
        total = unsigned(fee.amountUsd);
      } catch {
        reason = '原卡开卡费凭据待核对';
      }
    }
    if (reason) {
      for (const { order } of group) result.set(order.id, pending(reason));
      continue;
    }
    const count = BigInt(group.length), base = total / count, extra = total % count;
    const totalAmount = formatted(total);
    group.sort(openingOrder).forEach(({ order }, index) => {
      const amount = formatted(base + (BigInt(index) < extra ? 1n : 0n));
      result.set(order.id, {
        status: 'ready', ...(currency === 'USD' ? { amountUsd: amount, totalUsd: totalAmount } : { amount, total: totalAmount, currency }),
        count: group.length, asOf: new Date(clock).toISOString(),
        ...(appliedReceipt && { expenseReceipt: appliedReceipt })
      });
    });
  }
  return result;
}

export function calculateOrder(order, options) {
  return calculateOrderAmounts(order, options, true);
}

export function calculateOrderCost(order, options) {
  return calculateOrderAmounts(order, options, false);
}

function usesRecordedActualCost(order) {
  if (!order || order.costBasis !== 'actual' || !validCurrencyCode(order.actualCostCurrency) ||
      order.draft || unavailableOrders.includes(order.status) || order.entitlementStatus === 'failed' ||
      (isAutomatic(order) && !hasRecordedPaymentAmount(order))) return false;
  try { unsigned(order.actualCostAmount); return true; } catch { return false; }
}

// All converted values share an exact denominator. Apple actual-cost returns are
// prorated against the documented recoverable part of the total, not against fees.
function calculateOrderAmounts(order, { appleLedger, cardIssueAllocations, expenseReceipts = [], currency = 'CNY', clock = Date.now() } = {},
  includeRevenue) {
  const missing = new Set();
  const recordedActualCost = usesRecordedActualCost(order);
  const paymentRecorded = hasRecordedPaymentAmount(order);
  const paymentRequirement = { requiresPaymentConfirmation: !recordedActualCost && !paymentRecorded };
  try {
    if (!targets.includes(currency)) throw new Error('统计币种无效');
    const allocation = cardIssueAllocations?.get(order.id);
    if (allocation?.status === 'duplicate') throw new Error(allocation.reason);
    const unallocatedCard = allocation?.status === 'unlinked' || allocation?.status === 'pending' ||
      (!cardIssueAllocations && canUseUnlinkedCardReference(order, clock));
    const expenseTerms = orderExpenseTerms(order, expenseReceipts.filter(row => activeExpenseReceipt(row, clock)));
    let snapshot, snapshotError, usedFx = false;
    try { snapshot = readSnapshot(order, clock); }
    catch (error) { snapshotError = error.message; }
    const targetRate = snapshot?.rates[currency] ? unsigned(snapshot.rates[currency], 8) : rateOne;
    const value = (units, code) => {
      if (units === 0n) return 0n;
      if (!validCurrencyCode(code)) throw new Error('订单币种无效');
      if (code === currency) return units * targetRate;
      usedFx = true;
      if (!snapshot?.rates[currency]) missing.add(currency);
      if (!snapshot?.rates[code]) missing.add(code);
      return snapshot?.rates[currency] && snapshot?.rates[code] ? units * unsigned(snapshot.rates[code], 8) : 0n;
    };
    if (!recordedActualCost && !paymentRecorded)
      throw new Error(isAutomatic(order) ? '自动代充尚未取得实际扣款结果' : '缺少已登记的代付金额或币种');
    if (includeRevenue && isAutomatic(order) && order.receiptConfirmed !== true)
      throw new Error('缺少已登记的收款金额');
    const paid = paymentRecorded ? unsigned(order.paidAmount) : 0n;
    const received = includeRevenue ? netReceiptUnits(order) : 0n;
    const rules = order.costSettings;
    if (!recordedActualCost && (!Number.isSafeInteger(rules?.version) || rules.version < 1))
      throw new Error('订单缺少费用规则快照');
    const apple = order.payment === '苹果内购';
    const claude = ['Claude Pro', 'Claude Max'].includes(order.product);
    if (!apple && order.payment !== '银行卡') throw new Error('订单支付方式无效');
    if (apple && !recordedActualCost && order.paidCurrency !== 'USD') throw new Error('Apple 代付币种必须是美元');
    const actual = order.costBasis === 'actual';
    if (!actual && order.costBasis !== 'standard') throw new Error('成本依据未确认');

    let returned, appleLedgerNote;
    if (apple) {
      const expected = (order.paidConfirmed || order.appleIdId) &&
        !(order.externalApplePayment === true && !order.appleIdId);
      const matched = appleLedger?.orderId === order.id && appleLedger?.appleIdId === order.appleIdId &&
        paymentRecorded && /^\d{1,20}(?:\.\d{1,4})?$/.test(appleLedger.amount) && unsigned(appleLedger.amount) === paid;
      if (expected && !matched) appleLedgerNote = '原单 Apple 扣款或回款未匹配，金额按已登记成本计算';
      returned = matched ? unsigned(appleLedger.returned ?? '0') : 0n;
    } else {
      returned = sumOrderAmounts(order.bankReturns || [], order.paidCurrency, '银行卡回款');
    }
    if (returned > paid) throw new Error('实际回款超过原代付');

    const denominator = actual && apple && returned > 0n ? paid : 1n;
    const original = [];
    const costGaps = new Set();
    let recovery, recoveryUnits = returned, recoveryCurrency = order.paidCurrency;
    let cardIssueUnallocated = false;
    const bankKind = apple ? null : bankCardKind(order);
    const gaps = [];
    const item = (key, label, units, code, multiplier = one, expenseReceipt) => {
      const amount = value(units * multiplier, code) * denominator;
      if (units && multiplier && (missing.has(code) || (code !== currency && missing.has(currency)))) {
        costGaps.add(code);
        return;
      }
      original.push({ key, label, amount,
        originalAmount: formatted(rounded(units * multiplier, one)), originalCurrency: code,
        ...(expenseReceipt && { expenseReceipt }) });
    };
    const addTerm = (term, label) => item(term.category, label, term.units, term.currency, one, term.receipt);
    if (actual) {
      const cost = unsigned(order.actualCostAmount);
      const included = expenseTerms.filter(term => term.mode === 'included');
      item('actual-total', included.length ? '实际总成本未拆分部分' : '实际总成本（退回前）',
        cost - included.reduce((total, term) => total + term.units, 0n), order.actualCostCurrency);
      for (const term of included)
        addTerm(term, term.category === 'kyc' ? '已含 KYC 实付' : '已含换汇手续费');
      if (apple && returned > 0n) {
        if (!order.appleRecoverableCostAmount) gaps.push('缺少实际总成本中可按 Apple 面额比例收回的金额');
        const recoverable = unsigned(order.appleRecoverableCostAmount || '0');
        if (recoverable > cost) throw new Error('Apple 可收回成本不得大于实际总成本');
        recovery = value(recoverable, order.actualCostCurrency) * returned * one;
        recoveryUnits = rounded(recoverable * returned, paid);
        recoveryCurrency = order.actualCostCurrency;
      }
    } else {
      const factor = apple && claude ? unsigned(rules.appleDiscount) : one;
      if (factor === 0n || factor > one) throw new Error('Apple 折扣必须大于 0 且不超过 1');
      item('subscription', apple && claude ? '苹果内购折扣后成本' : '代付金额', paid, order.paidCurrency, factor);
      if (bankKind === 'virtual' && allocation?.status === 'ready') {
        item('card-issue', '开卡成本分摊', unsigned(allocation.amount ?? allocation.amountUsd),
          allocation.currency || 'USD', one, allocation.expenseReceipt);
      } else if (bankKind === 'virtual' && unallocatedCard) {
        const fee = order.issueFeeSnapshot;
        if (allocation?.status !== 'pending' && fee?.applied)
          item('card-issue', '原单已登记开卡费', unsigned(fee.amountUsd), 'USD');
        else cardIssueUnallocated = true;
      }
      if (bankKind === 'real' && claude)
        item('service', '代付服务费', unsigned(rules.claudeBankFeeMyr), 'MYR');
      if (!apple && claude) {
        const kyc = expenseTerms.find(term => term.mode === 'replace-kyc');
        if (kyc) addTerm(kyc, 'KYC 认证实付');
        else if (recordedKyc(order)) item('kyc', 'KYC 认证成本', unsigned(rules.claudeAccountCostMyr), 'MYR');
        if (bankKind === 'unknown') gaps.push('缺少原付款卡类型');
      }
      if (bankKind === 'virtual') {
        if (!cardIssueAllocations && !unallocatedCard) {
          const fee = order.issueFeeSnapshot;
          if (!fee || fee.pending) cardIssueUnallocated = true;
          else if (fee.applied) item('card-issue', '本卡首次开卡费', unsigned(fee.amountUsd), 'USD');
        }
        const feePercent = unsigned(rules.cardPercent);
        if (feePercent > one) throw new Error('银行卡手续费比例不能大于 1');
        item('payment-percent', '支付比例手续费', paid, order.paidCurrency, feePercent);
        item('payment-fixed', '每笔固定手续费', unsigned(rules.cardPerPaymentUsd), 'USD');
      }
      item('email', '补充邮箱成本', unsigned(order.emailCostAmount || '0'), order.emailCostCurrency || 'CNY');
      if (apple) {
        recovery = value(returned, 'USD') * factor;
        recoveryUnits = rounded(returned * factor, one);
      }
    }
    for (const term of expenseTerms.filter(term => term.mode === 'add-fx'))
      addTerm(term, '独立换汇手续费');
    recovery ??= value(returned, order.paidCurrency) * one * denominator;
    const netRevenue = includeRevenue ? value(received, order.saleCurrency) * one * denominator : 0n;
    const grossCost = original.reduce((sum, row) => sum + row.amount, 0n);
    if (missing.size) gaps.push(snapshotError || `订单快照缺少 ${[...missing].join('、')} 汇率`);
    const divisor = one * targetRate * denominator;
    const toMoney = (num) => formatted(rounded(num, divisor));
    const netCost = grossCost - recovery;
    const result = {
      status: 'ready', currency,
      originalCost: toMoney(grossCost),
      recoveredCost: toMoney(recovery), netCost: toMoney(netCost),
      ...(includeRevenue && !gaps.length && { revenue: toMoney(netRevenue), profit: toMoney(netRevenue - netCost) }),
      ...(recovery > 0n && { recoveryItem: {
        key: 'recovery', amount: toMoney(recovery), originalAmount: formatted(recoveryUnits), originalCurrency: recoveryCurrency
      } }),
      basis: actual && (!usedFx || snapshot?.basis === 'settlement') ? 'actual' : 'reference',
      ...paymentRequirement,
      ...(bankKind === 'virtual' && allocation?.status === 'ready' && { cardIssue: allocation }),
      ...(appleLedgerNote && { appleLedgerNote }),
      ...(cardIssueUnallocated && { cardIssueUnallocated,
        ...(allocation?.reason && { cardIssueUnallocatedReason: allocation.reason }) }),
      items: original.map((row) => ({ ...row, amount: toMoney(row.amount) }))
    };
    if (!gaps.length) return result;
    const [reason, ...additionalReasons] = gaps;
    return { status: 'pending', currency, reason, additionalReasons, ...paymentRequirement,
      ...(original.length && (original.some(item => item.key !== 'email' || item.amount !== 0n) || !costGaps.size) &&
        { knownCost: { ...result, partial: true } }) };
  } catch (error) {
    return { status: 'pending', currency, reason: error.message, ...paymentRequirement };
  }
}

export function requiredQuoteCurrencies(order) {
  const required = new Set([order.saleCurrency]);
  if (order.costBasis === 'actual') {
    required.add(order.actualCostCurrency);
    if (order.bankReturns?.length) required.add(order.paidCurrency);
  } else {
    required.add(order.paidCurrency);
    if (order.payment === '银行卡' && isClaude(order) && (bankCardKind(order) === 'real' || recordedKyc(order))) required.add('MYR');
    if (typeof order.emailCostAmount === 'string' && /[1-9]/.test(order.emailCostAmount))
      required.add(order.emailCostCurrency || 'CNY');
    if (order.payment === '银行卡' && usesVirtualBankCard(order) &&
        (/[1-9]/.test(order.costSettings?.cardPerPaymentUsd || '') || order.issueFeeSnapshot?.applied)) required.add('USD');
  }
  return [...new Set([...currencies, ...required])].filter(code => code !== 'CNY' && validCurrencyCode(code) && required.has(code));
}

function checkFeeSnapshot(order) {
  if (usesRecordedActualCost(order)) return;
  if (!Number.isSafeInteger(order.costSettings?.version) || order.costSettings.version < 1)
    throw new Error('请先核对订单费用规则，再冻结汇率快照');
}

export function createOrderSnapshot(input, order, clock = Date.now()) {
  const snapshot = createManualSnapshot(input, orderAccountingAt(order), clock);
  checkFeeSnapshot(order);
  const missing = requiredQuoteCurrencies(order).filter((code) => !Object.hasOwn(snapshot.rates, code));
  if (missing.length) throw new Error(`请补充 ${missing.join('、')} 汇率再冻结订单快照`);
  return snapshot;
}

export function createAutomaticOrderSnapshot(quote, order, clock = Date.now(), { historical = false } = {}) {
  checkFeeSnapshot(order);
  if (!(clock < instant(quote.expiresAt)) && !(historical && quote.quoteId)) throw new Error('当前自动报价已过期');
  const missing = requiredQuoteCurrencies(order).filter(code => !quote.rates || !Object.hasOwn(quote.rates, code));
  if (missing.length) throw new Error(`自动报价缺少 ${missing.join('、')} 汇率`);
  return normalizeAutomaticSnapshot(quote, orderAccountingAt(order), clock);
}
