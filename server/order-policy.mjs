export const rechargePlanLabels = Object.freeze({
  plus: 'Plus', pro100: 'Pro 100', pro200: 'Pro 200', pro500: 'Pro 500'
});
const bands = {
  Plus: ['20', '99'], 'Pro 100': ['100', '199'], 'Pro 200': ['220', '499'], 'Pro 500': ['500', ''],
  Pro: ['20', '99'], 'Max 5x': ['100', '249'], 'Max 20x': ['250', '']
};
const plans = {
  GPT: Object.values(rechargePlanLabels), 'Claude Pro': ['Pro'], 'Claude Max': ['Max 5x', 'Max 20x']
};
export function checkNewOrder(order) {
  if (!order.product) return;
  if (!Object.hasOwn(plans, order.product) || !plans[order.product].includes(order.plan))
    return '请选择当前可售套餐';
  if (!['续费', '成品交付'].includes(order.businessType)) return '请选择续费或成品交付';
  if (order.costBasis === 'actual') return '新订单按费用规则核算，实际总成本请通过有依据的订单更正登记';
  if ((order.email || order.product !== 'GPT' || order.businessType !== '续费') &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(order.email || '')) return '请填写有效订单邮箱';
  if (order.payment === '银行卡' && (order.paidConfirmed || order.cardId) &&
      !(typeof order.cardId === 'string' && order.cardId.startsWith(order.product === 'GPT' ? 'recharge:' : 'tenant:')))
    return '请选择对应来源的银行卡';
}
export const validMoney = (value) => typeof value === 'string' && /^\d{1,16}(?:\.\d{1,4})?$/.test(value);
const moneyUnits = (value) => {
  if (!validMoney(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole + fraction.padEnd(4, '0'));
};

export function validOrderPrices(prices) {
  const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
  return record(prices) && Object.entries(prices).every(([product, rows]) =>
    Object.hasOwn(plans, product) && record(rows) && Object.entries(rows).every(([plan, amounts]) =>
      plans[product].includes(plan) && record(amounts) && Object.entries(amounts).every(([currency, value]) =>
        ['CNY', 'MYR'].includes(currency) && (value === '' || validMoney(value)))));
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
    const previous = priorOrders.filter((row) => row.id !== order.id && sameSubscription(order, row) &&
      row.payment === '苹果内购' && row.appleIdId && row.paidConfirmed && !row.cancelled)
      .sort((a, b) => String(b.start).localeCompare(String(a.start)));
    if (!previous.length || previous[0].appleIdId !== order.appleIdId)
      return '苹果内购续费必须选择原订阅的苹果 ID';
    return;
  }
  if ((ledger?.movements || []).some((row) => row.appleIdId === order.appleIdId &&
        (row.orderId || ['charge', 'order-debit'].includes(row.kind))) ||
      allOrders.some((row) => row.id !== order.id && row.appleIdId === order.appleIdId && row.paidConfirmed))
    return '首次分配只能使用未用于订阅的苹果 ID';
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
  if (order.product !== 'GPT' || order.payment !== '银行卡' || !order.paidConfirmed) return;
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
