// Browser and server share this module. Monetary inputs and outputs are decimal strings.
export const currencies = Object.freeze(['CNY', 'MYR', 'USD', 'PHP', 'CLP', 'IDR']);
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
    if (!currencies.includes(currency)) throw new Error('汇率币种不受支持');
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
  return { kind: 'manual', ...normalizeSnapshot(input, orderAt, clock) };
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
  const current = instant(order.start);
  if (!(current >= instant(checked.at) && current < instant(checked.expiresAt) && current <= clock))
    throw new Error('更正后的订阅时间不在原汇率有效期内');
  return checked;
}

// All converted values share an exact denominator. Apple actual-cost returns are
// prorated against the documented recoverable part of the total, not against fees.
export function calculateOrder(order, { appleLedger, currency = 'CNY', clock = Date.now() } = {}) {
  const missing = new Set();
  try {
    if (!targets.includes(currency)) throw new Error('统计币种无效');
    const snapshot = readSnapshot(order, clock);
    const rate = (code) => {
      if (!currencies.includes(code)) throw new Error('订单币种无效');
      if (!Object.hasOwn(snapshot.rates, code)) {
        missing.add(code);
        return 0n;
      }
      return unsigned(snapshot.rates[code], 8);
    };
    const value = (units, code) => units === 0n ? 0n : units * rate(code);
    const total = (rows, code, field) => rows.reduce((sum, row) => {
      if (row.currency !== code) throw new Error(`${field}币种与原订单不符`);
      return sum + unsigned(row.amount);
    }, 0n);
    const paid = unsigned(order.paidAmount);
    const sold = unsigned(order.saleAmount);
    const refunded = total(order.refunds || [], order.saleCurrency, '客户退款');
    if (refunded > sold) throw new Error('客户退款超过原实收');
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
      returned = total(order.bankReturns || [], order.paidCurrency, '银行卡回款');
    }
    if (returned > paid) throw new Error('实际回款超过原代付');

    const denominator = actual && apple && returned > 0n ? paid : 1n;
    const original = [];
    let recovery;
    const item = (label, units, code, multiplier = one) =>
      original.push({ label, amount: value(units, code) * multiplier * denominator });
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
      if (!apple && claude) {
        item('代付服务费', unsigned(rules.claudeBankFeeMyr), 'MYR');
        item('KYC 认证成本', unsigned(rules.claudeAccountCostMyr), 'MYR');
      } else if (!apple) {
        if (!order.issueFeeSnapshot) throw new Error('订单缺少开卡费快照');
        if (order.issueFeeSnapshot.pending) throw new Error('首次开卡费待核对');
        if (order.issueFeeSnapshot.applied)
          item('本卡首次开卡费', unsigned(order.issueFeeSnapshot.amountUsd), 'USD');
        const feePercent = unsigned(rules.cardPercent);
        if (feePercent > one) throw new Error('银行卡手续费比例不能大于 1');
        item('支付比例手续费', paid, order.paidCurrency, feePercent);
        item('每笔固定手续费', unsigned(rules.cardPerPaymentUsd), 'USD');
      }
      item('补充邮箱成本', unsigned(order.emailCostAmount || '0'), order.emailCostCurrency || 'CNY');
      if (apple) recovery = value(returned, 'USD') * factor;
    }
    recovery ??= value(returned, order.paidCurrency) * one * denominator;
    const netRevenue = value(sold - refunded, order.saleCurrency) * one * denominator;
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
      items: original.map((row) => ({ label: row.label, amount: toMoney(row.amount) }))
    };
  } catch (error) {
    return { status: 'pending', currency, reason: error.message };
  }
}

export function requiredQuoteCurrencies(order) {
  const required = new Set(['MYR', order.paidCurrency, order.saleCurrency]);
  if (order.costBasis === 'actual') {
    required.add(order.actualCostCurrency);
  } else {
    if (typeof order.emailCostAmount === 'string' && /[1-9]/.test(order.emailCostAmount))
      required.add(order.emailCostCurrency || 'CNY');
    if (order.payment === '银行卡' && order.product === 'GPT') required.add('USD');
  }
  return currencies.filter((code) => code !== 'CNY' && required.has(code));
}

function checkFeeSnapshot(order) {
  if (!Number.isSafeInteger(order.costSettings?.version) || order.costSettings.version < 1)
    throw new Error('请先核对订单费用规则，再冻结汇率快照');
}

export function createOrderSnapshot(input, order, clock = Date.now()) {
  const snapshot = createManualSnapshot(input, order.start, clock);
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
  return normalizeAutomaticSnapshot(quote, order.start, clock);
}
