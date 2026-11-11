// Browser and server share this module. Monetary inputs and outputs are decimal strings.
export const currencies = Object.freeze(['CNY', 'MYR', 'USD', 'PHP', 'CLP', 'IDR', 'EGP']);
export const validCurrencyCode = code => typeof code === 'string' && /^[A-Z]{3}$/.test(code);
export const snapshotAction = '登记订单汇率快照';
export const automaticProvider = Object.freeze({
  id: 'exchange-rate-api-open',
  source: 'ExchangeRate-API',
  attributionUrl: 'https://www.exchangerate-api.com'
});
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
  if (input.provider !== automaticProvider.id || input.source !== automaticProvider.source)
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
  if (!order || order.receiptConfirmed !== true || order.cancelled || order.draft ||
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
const requiresCardAllocation = product => product === 'GPT' || personalBankProducts.includes(product);
const unavailableOrders = ['draft', 'failed', '草稿', '失败'];
const isAutomatic = (order) => order.source === '线上代充';
export const orderAccountingAt = (order) => isAutomatic(order) && order.rechargeCompletedAt || order.start;
const stableCardId = (order) => {
  // A materials correction does not move the already-recorded opening fee to another card.
  const original = order.corrections?.find(change => change.kind !== 'historical-card-backfill' &&
    change.previous?.paidConfirmed && change.previous.payment === '银行卡' &&
    change.previous.paidAmount === order.paidAmount && change.previous.paidCurrency === order.paidCurrency &&
    (change.previous.cardId || '') !== (order.cardId || ''))?.previous;
  const id = original ? original.cardId : order.cardId;
  return typeof id === 'string' && id.trim() === id && id.length > 0 && !/^\d{4,19}$/.test(id) ? id : '';
};
const compareKey = (a, b) => a === b ? 0 : a < b ? -1 : 1;
const openingOrder = (a, b) => a.at - b.at ||
  compareKey(a.order.orderNo || a.order.id, b.order.orderNo || b.order.id) || compareKey(a.order.id, b.order.id);

function confirmedCardOpening(order, clock) {
  const cardId = stableCardId(order);
  const auto = isAutomatic(order);
  const evidence = Array.isArray(order.financialEvidence) ? order.financialEvidence : [];
  const confirmed = auto || order.paidConfirmed === true || Boolean(cardId && evidence.some((row) =>
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

// Use the complete order set, including successful orders later refunded or
// cancelled. Display filters and FX gaps do not alter a card's denominator.
export function buildCardIssueAllocations(orders, { clock = Date.now() } = {}) {
  const result = new Map(), groups = new Map(), tasks = new Map();
  const pending = (reason) => ({ status: 'pending', reason });
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
    if (sameTask.has(item.order.id)) continue;
    if (!item.cardId) {
      if (requiresCardAllocation(item.order.product)) result.set(item.order.id, pending('缺少原付款银行卡的稳定编号'));
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
      if (requiresCardAllocation(item.order.product)) result.set(item.order.id, pending('本单成功开通待核对'));
      continue;
    }
    const group = groups.get(item.cardId) || [];
    group.push(item);
    groups.set(item.cardId, group);
  }

  for (const [cardId, group] of groups) {
    const charges = [...group.filter(({ order }) => order.issueFeeSnapshot?.applied === true),
      ...(feesOnFailedOpenings.get(cardId) || [])];
    if (!charges.length && !group.some(({ order }) => requiresCardAllocation(order.product)) && !ambiguousCards.has(cardId)) continue;
    let total;
    let reason;
    if (ambiguousCards.has(cardId) || group.some((item) => item.state !== 'opened')) {
      reason = '同卡开通记录存在待核对项';
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
    group.sort(openingOrder).forEach(({ order }, index) => {
      result.set(order.id, {
        status: 'ready', amountUsd: formatted(base + (BigInt(index) < extra ? 1n : 0n)),
        totalUsd: formatted(total), count: group.length, asOf: new Date(clock).toISOString()
      });
    });
  }
  return result;
}

// All converted values share an exact denominator. Apple actual-cost returns are
// prorated against the documented recoverable part of the total, not against fees.
export function calculateOrder(order, { appleLedger, cardIssueAllocations, currency = 'CNY', clock = Date.now() } = {}) {
  const missing = new Set();
  let cardIssueReason;
  try {
    if (!targets.includes(currency)) throw new Error('统计币种无效');
    const allocation = cardIssueAllocations?.get(order.id);
    if (allocation?.status === 'duplicate') throw new Error(allocation.reason);
    if (order.payment === '银行卡' && order.costBasis === 'standard' && allocation?.status === 'pending')
      cardIssueReason = allocation.reason;
    const snapshot = readSnapshot(order, clock);
    const rate = (code) => {
      if (!validCurrencyCode(code)) throw new Error('订单币种无效');
      if (!Object.hasOwn(snapshot.rates, code)) {
        missing.add(code);
        return 0n;
      }
      return unsigned(snapshot.rates[code], 8);
    };
    const value = (units, code) => units === 0n ? 0n : units * rate(code);
    const paid = unsigned(order.paidAmount);
    const received = netReceiptUnits(order);
    const rules = order.costSettings;
    if (!Number.isSafeInteger(rules?.version) || rules.version < 1)
      throw new Error('订单缺少费用规则快照');
    const apple = order.payment === '苹果内购';
    const claude = ['Claude Pro', 'Claude Max'].includes(order.product);
    if (!apple && order.payment !== '银行卡') throw new Error('订单支付方式无效');
    if (apple && order.paidCurrency !== 'USD') throw new Error('Apple 代付币种必须是美元');
    const actual = order.costBasis === 'actual';
    if (!actual && order.costBasis !== 'standard') throw new Error('成本依据未确认');

    let returned;
    if (apple) {
      // Allocation.returned is posted by the existing Apple receipt ledger only.
      if (order.paidConfirmed && (!appleLedger || appleLedger.orderId !== order.id ||
          appleLedger.appleIdId !== order.appleIdId || unsigned(appleLedger.amount) !== paid))
        throw new Error('Apple 实际扣款及回款台账待核对');
      returned = unsigned(appleLedger?.returned ?? '0');
    } else {
      returned = sumOrderAmounts(order.bankReturns || [], order.paidCurrency, '银行卡回款');
    }
    if (returned > paid) throw new Error('实际回款超过原代付');

    const denominator = actual && apple && returned > 0n ? paid : 1n;
    const original = [];
    let recovery;
    const item = (label, units, code, multiplier = one) =>
      original.push({ label, amount: value(units, code) * multiplier * denominator,
        originalAmount: formatted(rounded(units * multiplier, one)), originalCurrency: code });
    if (actual) {
      const cost = unsigned(order.actualCostAmount);
      item('实际总成本（退回前）', cost, order.actualCostCurrency);
      if (apple && returned > 0n) {
        if (!order.appleRecoverableCostAmount)
          throw new Error('请核对实际总成本中可按 Apple 面额比例收回的部分');
        const recoverable = unsigned(order.appleRecoverableCostAmount);
        if (recoverable > cost) throw new Error('Apple 可收回成本不得大于实际总成本');
        recovery = value(recoverable, order.actualCostCurrency) * returned * one;
      }
    } else {
      const factor = apple && claude ? unsigned(rules.appleDiscount) : one;
      if (factor === 0n || factor > one) throw new Error('Apple 折扣必须大于 0 且不超过 1');
      item(apple && claude ? '苹果内购折扣后成本' : '代付金额', paid, order.paidCurrency, factor);
      if (!apple && cardIssueAllocations && (allocation || requiresCardAllocation(order.product))) {
        if (allocation?.status !== 'ready')
          throw new Error(allocation?.reason || '本单开卡成本待核对');
        item('开卡成本分摊', unsigned(allocation.amountUsd), 'USD');
      }
      if (!apple && claude) {
        item('代付服务费', unsigned(rules.claudeBankFeeMyr), 'MYR');
        item('KYC 认证成本', unsigned(rules.claudeAccountCostMyr), 'MYR');
      } else if (!apple) {
        // The original per-order format remains readable for historic audits
        // without a complete card cohort.
        if (!cardIssueAllocations) {
          if (!order.issueFeeSnapshot) throw new Error('订单缺少开卡费快照');
          if (order.issueFeeSnapshot.pending) throw new Error('首次开卡费待核对');
          if (order.issueFeeSnapshot.applied)
            item('本卡首次开卡费', unsigned(order.issueFeeSnapshot.amountUsd), 'USD');
        }
        const feePercent = unsigned(rules.cardPercent);
        if (feePercent > one) throw new Error('银行卡手续费比例不能大于 1');
        item('支付比例手续费', paid, order.paidCurrency, feePercent);
        item('每笔固定手续费', unsigned(rules.cardPerPaymentUsd), 'USD');
      }
      item('补充邮箱成本', unsigned(order.emailCostAmount || '0'), order.emailCostCurrency || 'CNY');
      if (apple) recovery = value(returned, 'USD') * factor;
    }
    recovery ??= value(returned, order.paidCurrency) * one * denominator;
    const netRevenue = value(received, order.saleCurrency) * one * denominator;
    const grossCost = original.reduce((sum, row) => sum + row.amount, 0n);
    const targetRate = rate(currency);
    if (missing.size) throw new Error(`订单快照缺少 ${[...missing].join('、')} 汇率`);
    const divisor = one * targetRate * denominator;
    const toMoney = (num) => formatted(rounded(num, divisor));
    const netCost = grossCost - recovery;
    return {
      status: 'ready', currency,
      revenue: toMoney(netRevenue), originalCost: toMoney(grossCost),
      recoveredCost: toMoney(recovery), netCost: toMoney(netCost),
      profit: toMoney(netRevenue - netCost),
      basis: actual && snapshot.basis === 'settlement' ? 'actual' : 'reference',
      ...(allocation?.status === 'ready' && { cardIssue: allocation }),
      items: original.map((row) => ({ ...row, amount: toMoney(row.amount) }))
    };
  } catch (error) {
    return { status: 'pending', currency, reason: error.message,
      ...(cardIssueReason && cardIssueReason !== error.message && { additionalReasons: [cardIssueReason] }) };
  }
}

export function requiredQuoteCurrencies(order) {
  const required = new Set(['MYR', order.paidCurrency, order.saleCurrency]);
  if (order.costBasis === 'actual') {
    required.add(order.actualCostCurrency);
  } else {
    if (typeof order.emailCostAmount === 'string' && /[1-9]/.test(order.emailCostAmount))
      required.add(order.emailCostCurrency || 'CNY');
    if (order.payment === '银行卡' && (requiresCardAllocation(order.product) || /^(?:recharge|orbitcard):/.test(order.cardId || ''))) required.add('USD');
  }
  return [...new Set([...currencies, ...required])].filter(code => code !== 'CNY' && validCurrencyCode(code) && required.has(code));
}

function checkFeeSnapshot(order) {
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
