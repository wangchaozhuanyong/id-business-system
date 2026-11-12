const commonRegions = {
  US: '美国', MY: '马来西亚', PH: '菲律宾', JP: '日本', SG: '新加坡', CN: '中国大陆',
  HK: '中国香港', TW: '中国台湾', GB: '英国', AU: '澳大利亚', CA: '加拿大',
  TH: '泰国', VN: '越南', ID: '印度尼西亚', IN: '印度', TR: '土耳其', EG: '埃及',
  CL: '智利', BR: '巴西', MX: '墨西哥', DE: '德国', FR: '法国', KR: '韩国',
  AE: '阿联酋', SA: '沙特阿拉伯', NZ: '新西兰'
};
// App Store storefronts, using two-letter codes in the inventory and order documents.
const storefronts = ('AF AG AI AL AM AO AR AT AU AZ BA BB BE BF BG BH BJ BM BN BO BR BS BT BW BY BZ ' +
  'CA CD CG CH CI CL CM CN CO CR CV CY CZ DE DK DM DO DZ EC EE EG ES FI FJ FM FR GA GB GD GE GH GM GR GT GW GY ' +
  'HK HN HR HU ID IE IL IN IQ IS IT JM JO JP KE KG KH KN KR KW KY KZ LA LB LC LK LR LT LU LV LY ' +
  'MA MD ME MG MK ML MM MN MO MR MS MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR NZ OM PA PE PG PH PK PL PT PW PY ' +
  'QA RO RS RU RW SA SB SC SE SG SI SK SL SN SR ST SV SZ TC TD TH TJ TM TN TO TR TT TW TZ UA UG US UY UZ ' +
  'VC VE VG VN VU XK YE ZA ZM ZW').split(' ');
const regionNames = new Intl.DisplayNames(['zh-Hans'], { type: 'region' });
export const appleRegions = Object.freeze({
  ...commonRegions,
  ...Object.fromEntries(storefronts.filter(code => !Object.hasOwn(commonRegions, code))
    .map(code => [code, regionNames.of(code)])
    .sort((a, b) => a[1].localeCompare(b[1], 'zh-Hans')))
});
export const appleRegion = code => typeof code === 'string' && Object.hasOwn(appleRegions, code);
export const appleAmountUnits = value => {
  if (typeof value !== 'string' || !/^\d{1,16}(?:\.\d{1,4})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'));
};
export const applePrice = (settings, product, plan, region) =>
  appleRegion(region) ? settings?.applePaidPrices?.[product]?.[plan]?.[region] || '' : '';
const lower = value => String(value || '').trim().toLowerCase();
const productFamily = product => ['Claude Pro', 'Claude Max'].includes(product) ? 'Claude' : product;

export function appleTarget(order) {
  const product = productFamily(order?.product);
  const key = product === 'Grok' && order.loginMethod === 'x' ? lower(order.xHandle) : lower(order?.email);
  const valid = product === 'Grok' && order?.loginMethod === 'x'
    ? /^@[a-z0-9_]{1,15}$/.test(key) : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key);
  return product && valid ? JSON.stringify([product, key]) : '';
}

export function appleFundingIndex(orders = [], ledger = {}) {
  const byWallet = new Map();
  const byTarget = new Map();
  const pendingByTarget = new Map();
  const references = new Map(orders.map(order => [order.id, order]));
  const ensure = id => {
    if (!byWallet.has(id)) byWallet.set(id, { bindings: [], pending: [], used: false });
    return byWallet.get(id);
  };
  function rememberTarget(target, id) {
    if (!byTarget.has(target)) byTarget.set(target, new Set());
    byTarget.get(target).add(id);
  }
  function bind(id, order) {
    if (!id) return;
    const wallet = ensure(id);
    wallet.used = true;
    const target = appleTarget(order);
    if (!target || !order.customerId) return;
    const binding = wallet.bindings.find(row => row.target === target && row.customerId === order.customerId);
    if (!binding) wallet.bindings.push({ target, customerId: order.customerId, order,
      accountIds: new Set(order.platformAccountId ? [order.platformAccountId] : []) });
    else if (order.platformAccountId) binding.accountIds.add(order.platformAccountId);
    rememberTarget(target, id);
  }
  for (const allocation of ledger.allocations || []) {
    const order = references.get(allocation.orderId);
    if (order?.payment === '苹果内购' && order.paidConfirmed && order.appleIdId === allocation.appleIdId)
      bind(allocation.appleIdId, order);
    else if (allocation.appleIdId) ensure(allocation.appleIdId).used = true;
  }
  const debits = new Map();
  for (const movement of ledger.movements || []) {
    if (!movement.appleIdId || !movement.orderId) continue;
    ensure(movement.appleIdId).used = true;
    const order = references.get(movement.orderId);
    if (order?.appleIdId !== movement.appleIdId || !['order-charge', 'order-reversal'].includes(movement.kind)) continue;
    const before = debits.get(movement.orderId);
    const charge = movement.kind === 'order-charge';
    const amount = typeof movement.amount === 'string' && (charge ? movement.amount.startsWith('-') : !movement.amount.startsWith('-'))
      ? appleAmountUnits(charge ? movement.amount.slice(1) : movement.amount) : null;
    debits.set(movement.orderId, amount === null || before === null ? null :
      (before || 0n) + (charge ? amount : -amount));
  }
  for (const order of orders) {
    if (order.appleFunding?.bound && order.appleIdId) bind(order.appleIdId, order);
    if (order.payment !== '苹果内购' || !order.appleIdId || order.draft ||
        ['draft', '草稿'].includes(order.status)) continue;
    if (order.paidConfirmed) {
      // Unreconciled historical orders must not return to the unassigned pool.
      ensure(order.appleIdId).used = true;
      const target = appleTarget(order);
      if (target) rememberTarget(target, order.appleIdId);
      const paid = appleAmountUnits(order.paidAmount);
      if (paid > 0n && debits.get(order.id) === paid) bind(order.appleIdId, order);
    } else if (!order.appleFunding?.bound && (!order.cancelled ||
        order.cancellationEvents?.at(-1)?.appleUnpaidConfirmed !== true)) {
      ensure(order.appleIdId).pending.push(order);
      const target = appleTarget(order);
      if (target) {
        if (!pendingByTarget.has(target)) pendingByTarget.set(target, []);
        pendingByTarget.get(target).push(order);
      }
    }
  }
  return { byWallet, byTarget, pendingByTarget };
}

export function appleBinding(index, order) {
  const target = appleTarget(order);
  const ids = index.byTarget.get(target);
  if (!ids?.size) return { id: '' };
  if (ids.size !== 1) return { id: '', conflict: true };
  const id = [...ids][0], wallet = index.byWallet.get(id);
  const [binding] = wallet.bindings;
  if (!binding) return { id: '' };
  return wallet.bindings.length === 1 && binding.target === target && binding.customerId === order.customerId &&
    binding.accountIds.size <= 1 &&
    (!order.platformAccountId || !binding.accountIds.size || binding.accountIds.has(order.platformAccountId))
    ? { id } : { id: '', conflict: true };
}

export function appleFundingEligibility(wallet, order, index, settings, { actual = false, quotedPrice } = {}) {
  const binding = appleBinding(index, order);
  const state = index.byWallet.get(wallet?.id);
  const region = order.appleStoreRegion || wallet?.appStoreRegion;
  const expected = quotedPrice || applePrice(settings, order.product, order.plan, region);
  const estimate = appleAmountUnits(expected);
  const paid = appleAmountUnits(order.paidAmount);
  const amount = actual ? paid : paid !== null && estimate !== null && paid > estimate ? paid : estimate;
  const balance = appleAmountUnits(wallet?.balance);
  if (!appleTarget(order) || !order.customerId) return { error: '请先核对客户和订阅账号' };
  if (binding.conflict) return { error: '历史苹果 ID 绑定存在冲突，请核对原订单' };
  if (order.businessType === '续费' && !binding.id)
    return { error: '未找到原订阅的苹果 ID 绑定，请核对历史付款记录' };
  if (!binding.id && index.byTarget.has(appleTarget(order)))
    return { error: '历史苹果内购付款待核对，请核对原订单与余额流水' };
  if (binding.id && binding.id !== wallet?.id) return { error: '本账号只能使用原绑定的苹果 ID' };
  if (!wallet || wallet.deleted || wallet.status !== '正常' ||
      (wallet.health && wallet.health !== 'normal') || wallet.currency !== 'USD')
    return { error: '苹果 ID 状态异常或未建立美元余额账本' };
  if (!appleRegion(region) || wallet.appStoreRegion !== region) return { error: '请核对所选苹果 ID 的 Id地区' };
  if (state?.pending.some(other => other.id !== order.id)) return { error: '该苹果 ID 已被待付款订单占用' };
  if (index.pendingByTarget.get(appleTarget(order))?.some(other => other.id !== order.id))
    return { error: '该订阅账号已有待付款订单，请先核对原单' };
  if (!binding.id && state?.used) return { error: '首次分配只能使用未使用的苹果 ID' };
  if (!actual && (estimate === null || estimate <= 0n)) return { error: '请先配置此地区的苹果内购代付价' };
  if (amount === null || amount <= 0n || balance === null) return { error: '请核对苹果内购金额和余额' };
  if (balance < amount) return { error: '苹果 ID 余额不足', shortage: amount - balance };
  return { region, expected, amount, balance };
}

if (typeof window !== 'undefined') window.IDAppleFunding = Object.freeze({
  appleRegions, appleRegion, appleAmountUnits, applePrice, appleTarget, appleFundingIndex, appleBinding, appleFundingEligibility
});
