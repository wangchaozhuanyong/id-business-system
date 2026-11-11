import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseV2DateTimeInput, toV2DateTimeInput } from '../modules/time/dateTime.ts';
import { validCurrencyCode } from '../modules/finance/accounting.mjs';
import { registrationOccupancy, registrationProductConflict } from './inventory-registration.mjs';
import { checkSubscriptionTermination, nextOrderNo, validMoney } from './order-policy.mjs';

const phases = new Map([['已开通', 'opened'], ['养号中', 'aging'], ['死号', 'dead']]);
const plans = new Set(['Pro', 'Max 5x', 'Max 20x']);
const fields = ['email', 'state', 'registered', 'plan', 'start', 'expiry', 'country', 'device', 'note'];
const emailKey = value => String(value ?? '').trim().toLowerCase();

export class ClaudeHistoryIntakeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function historyDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?$/.test(value)) return null;
  const date = value.replace(' ', 'T');
  const local = date.length === 10 ? date + 'T00:00' : date;
  const instant = parseV2DateTimeInput(local)?.getTime();
  return Number.isFinite(instant) ? { date, instant } : null;
}

export function planClaudeHistoryIntake(input, inventory, commerce, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['rows', 'inventoryVersion'].includes(key)) ||
      !Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > 100)
    throw new ClaudeHistoryIntakeError('请按表头填写 1 至 100 条 Claude 历史账号');

  const accounts = Map.groupBy((inventory.data?.accounts || []).filter(row => row?.type === 'claude'),
    row => emailKey(row.email));
  const registeredEmails = registrationOccupancy(inventory.data);
  const sold = new Set((commerce.data?.orders || []).filter(row =>
    ['Claude Pro', 'Claude Max'].includes(row?.product) && (row.accountId || row.customerId))
    .map(row => emailKey(row.email)));
  const seen = new Set();
  const rows = input.rows.map((raw, index) => {
    const line = index + 1;
    const problem = error => ({ line, error });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        Object.entries(raw).some(([key, value]) =>
          !fields.includes(key) || typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)))
      return problem('请只填写历史入库表头中的文字字段');

    const values = Object.fromEntries(fields.map(key => [key, raw[key]?.trim() || '']));
    const email = emailKey(values.email);
    if (email.length > 254 || !/^[^\s@,|]+@[^\s@,|]+\.[^\s@,|]+$/.test(email))
      return problem('请输入有效的 Claude 登录邮箱');
    if (seen.has(email)) return problem('同一批 Claude 登录邮箱重复');
    seen.add(email);
    const phase = phases.get(values.state);
    if (!phase) return problem('请选择已开通、养号中或死号');
    if (values.country.length > 100 || values.device.length > 200 || values.note.length > 500)
      return problem('国家地区、登录设备或来源备注过长');

    const registered = historyDate(values.registered);
    if (values.registered && (!registered || registered.instant > now))
      return problem('请核对原注册时间');
    const hasPeriod = Boolean(values.plan || values.start || values.expiry);
    const start = historyDate(values.start);
    const expiry = historyDate(values.expiry);
    if (phase === 'aging' && hasPeriod) return problem('养号中的账号请保留未开通状态');
    if ((phase === 'opened' || hasPeriod) && (!plans.has(values.plan) || !start || !expiry ||
        start.instant > now || expiry.instant <= start.instant ||
        (registered && (registered.date.length === 10 || start.date.length === 10
          ? registered.date.slice(0, 10) > start.date.slice(0, 10) : registered.instant > start.instant))))
      return problem('请核对原套餐、开通时间和到期时间');

    const details = { country: values.country, device: values.device, registered: registered?.date || '', notes: values.note };
    const history = { phase, plan: values.plan, start: start?.date || '', expiry: expiry?.date || '' };
    const health = phase === 'dead' ? 'dead' : 'normal';
    const [prior, duplicate] = accounts.get(email) || [];
    const conflict = registrationProductConflict(registeredEmails.get(email), 'claude', prior?.id);
    if (conflict) return problem(conflict);
    if (prior && (duplicate || !isDeepStrictEqual(prior.claudeHistory, history) || prior.health !== health ||
        Object.entries(details).some(([key, value]) => (prior[key] || '') !== value)))
      return problem('已有同邮箱的 Claude 账号，请核对原记录');
    if (!prior && sold.has(email)) return problem('该邮箱已关联客户订单，请先核对账号归属');

    return { line, email, state: values.state, health, details, history, prior };
  });
  return { inventoryVersion: inventory.version, rows, additions: rows.filter(row => !row.error && !row.prior) };
}

export function claudeHistoryPreview(plan) {
  return {
    inventoryVersion: plan.inventoryVersion,
    pending: plan.additions.length,
    rows: plan.rows.map(row => row.error ? { line: row.line, error: row.error } : {
      line: row.line, email: row.email, state: row.state, plan: row.history.plan, registered: row.details.registered,
      start: row.history.start, expiry: row.history.expiry, result: row.prior ? '已登记' : '待入库'
    })
  };
}

export function stageClaudeHistoryIntake(plan, inventoryVersion, inventory, actor, time) {
  if (inventoryVersion !== plan.inventoryVersion)
    throw new ClaudeHistoryIntakeError('库存已变化，请重新预检', 409);
  const problem = plan.rows.find(row => row.error);
  if (problem) throw new ClaudeHistoryIntakeError('第 ' + problem.line + ' 条。' + problem.error, 409);
  const imported = plan.additions.length;
  const reused = plan.rows.length - imported;
  if (!imported) return { imported, reused };

  const batchId = 'claude-history-' + randomUUID();
  const recordedAt = toV2DateTimeInput(time).replace('T', ' ');
  const attribution = { actorId: actor.id, actor: actor.name, time: recordedAt };
  const results = [];
  const accounts = plan.additions.map(row => {
    const id = 'claude-' + randomUUID();
    const used = row.history.phase === 'opened';
    results.push({
      id: 'row-' + row.line, assetId: id, line: row.line, email: row.email, type: 'claude',
      registered: row.details.registered, createdAt: recordedAt, result: row.state
    });
    return {
      id, type: 'claude', email: row.email, emailType: /@(?:gmail|googlemail)\.com$/.test(row.email) ? 'google' : '',
      ...row.details, claudeHistory: row.history, source: '历史入库',
      status: '冻结', health: row.health, inventoryState: used ? 'used' : 'available', used,
      ...(used && { actualUsedAt: row.history.start.replace('T', ' ') }), usageLinks: [],
      importId: batchId, importedAt: recordedAt, createdAt: recordedAt, createdById: actor.id, createdBy: actor.name,
      lastOperatedAt: recordedAt, lastOperatedById: actor.id, lastOperatedBy: actor.name, version: 1,
      inventoryHistory: [{ id: randomUUID(), action: 'Claude 历史入库', detail: row.state, ...attribution }]
    };
  });
  (inventory.accounts ??= []).unshift(...accounts);
  (inventory.importRecords ??= []).unshift({
    id: batchId, type: 'claude', types: ['claude'], total: imported, success: imported, failed: 0,
    status: '已导入', results, ...attribution
  });
  return { imported, reused, batchId };
}

const claudeProducts = new Set(['Claude Pro', 'Claude Max']);

export function isClaudeHistoricalSale(order, account) {
  return Boolean(order?.accountId && account?.id === order.accountId && account.type === 'claude' &&
    emailKey(order.email) === emailKey(account.email) && claudeProducts.has(order.product) &&
    order.source === '历史入库' && order.businessType === '成品交付' &&
    ['opened', 'dead'].includes(account.claudeHistory?.phase));
}

function historicalSaleCandidate(account, inventory, now) {
  const history = account?.claudeHistory;
  const email = emailKey(account?.email);
  if (account?.type !== 'claude' || !['opened', 'dead'].includes(history?.phase) ||
      !email || !plans.has(history.plan) || account.inventoryState === 'claimed' ||
      account.claimId || account.accountLifecycle?.customerId || account.accountLifecycle?.orderId) return null;
  const start = historyDate(history.start || '');
  const expiry = historyDate(history.expiry || '');
  if (!start || !expiry || start.instant > now || expiry.instant <= start.instant) return null;
  const sameAccount = (inventory.accounts || []).filter(row => row.type === 'claude' && emailKey(row.email) === email);
  const mailboxes = (inventory.mailboxes || []).filter(row => emailKey(row.email) === email &&
    (account.emailType ? row.type === account.emailType : row.type === 'google') && !row.relayDeleted);
  if (sameAccount.length !== 1 || mailboxes.length !== 1) return null;
  const ended = history.phase === 'dead' || account.health === 'dead' ||
    account.accountLifecycle?.disposition === 'retired';
  return { id: account.id, email, plan: history.plan, start: start.date, expiry: expiry.date, ended };
}

function historicalSaleOrders(orders, candidate) {
  return orders.filter(order => order.accountId === candidate.id ||
    (claudeProducts.has(order.product) && emailKey(order.email) === candidate.email));
}

export function claudeHistoricalSales(inventory, commerce, now = Date.now()) {
  const orders = commerce.data?.orders || [];
  const data = inventory.data || {};
  return {
    inventoryVersion: inventory.version,
    commerceVersion: commerce.version,
    accounts: (data.accounts || []).map(account => historicalSaleCandidate(account, data, now))
      .filter(candidate => candidate && !historicalSaleOrders(orders, candidate).length)
  };
}

const saleFields = ['accountId', 'tenantId', 'customerId', 'payment', 'saleAmount', 'saleCurrency',
  'actualCostAmount', 'actualCostCurrency', 'subscriptionEndedAt', 'notes'];

export function recordClaudeHistoricalSale(input, inventory, commerce, actor, time, costSettings) {
  if (!actor?.id || !['admin', 'super'].includes(actor.role))
    throw new ClaudeHistoryIntakeError('只有管理员可以补录 Claude 历史销售', 403);
  if (!Number.isSafeInteger(input.inventoryVersion) || !Number.isSafeInteger(input.commerceVersion) ||
      Object.keys(input).some(key => !saleFields.includes(key) && !['inventoryVersion', 'commerceVersion'].includes(key)) ||
      saleFields.some(key => input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 300)))
    throw new ClaudeHistoryIntakeError('请核对历史销售资料');
  const sale = Object.fromEntries(saleFields.map(key => [key, input[key]?.trim() || '']));
  if (!sale.actualCostAmount) sale.actualCostCurrency = '';
  const data = inventory.data || {};
  const account = (data.accounts || []).find(row => row.id === sale.accountId);
  const candidate = historicalSaleCandidate(account, data, time.getTime());
  if (!candidate) throw new ClaudeHistoryIntakeError('请核对原 Claude 账号、已登记邮箱和订阅周期', 409);
  const orders = commerce.data?.orders || [];
  const existing = historicalSaleOrders(orders, candidate);
  if (existing.length) {
    const [order] = existing;
    const stable = ['tenantId', 'payment', 'saleAmount', 'saleCurrency', 'actualCostAmount', 'actualCostCurrency'];
    if (existing.length === 1 && isClaudeHistoricalSale(order, account) && !order.cancelled &&
        stable.every(key => (order[key] || '') === sale[key]) &&
        (!sale.customerId || sale.customerId === order.customerId) &&
        (!sale.subscriptionEndedAt || sale.subscriptionEndedAt === order.subscriptionEndedAt))
      return { order, created: false };
    throw new ClaudeHistoryIntakeError('这个账号已有订单，请核对原单', 409);
  }
  if (inventory.version !== input.inventoryVersion || commerce.version !== input.commerceVersion)
    throw new ClaudeHistoryIntakeError('库存或订单资料已变化，请重新打开补录', 409);
  const tenant = (commerce.data?.tenants || []).find(row => row.id === sale.tenantId && row.active !== false);
  if (!tenant) throw new ClaudeHistoryIntakeError('请选择实际出租账号的租户');
  const customer = sale.customerId &&
    (commerce.data?.customers || []).find(row => row.id === sale.customerId && row.active !== false);
  if (sale.customerId && !customer) throw new ClaudeHistoryIntakeError('请选择实际购买账号的客户');
  if (!['银行卡', '苹果内购'].includes(sale.payment))
    throw new ClaudeHistoryIntakeError('请选择原开通方式');
  if (!validMoney(sale.saleAmount) || !validCurrencyCode(sale.saleCurrency) ||
      (sale.actualCostAmount && (!validMoney(sale.actualCostAmount) || !validCurrencyCode(sale.actualCostCurrency))))
    throw new ClaudeHistoryIntakeError('请核对原售价、实际总成本和币种');
  if (sale.subscriptionEndedAt && (!candidate.ended || !historyDate(sale.subscriptionEndedAt)))
    throw new ClaudeHistoryIntakeError('请按死号记录填写实际终止时间');

  const at = time.toISOString();
  const order = {
    ...sale,
    id: 'commerce-order-' + randomUUID(),
    orderNo: nextOrderNo(orders),
    product: candidate.plan === 'Pro' ? 'Claude Pro' : 'Claude Max',
    plan: candidate.plan,
    email: candidate.email,
    accountSource: '库存',
    businessType: '成品交付',
    source: '历史入库',
    start: candidate.start,
    expiry: candidate.expiry,
    entitlementStatus: 'active',
    subscriptionEnded: candidate.ended,
    paidAmount: '', paidCurrency: '', paidConfirmed: false, receiptConfirmed: false,
    ...(sale.payment === '银行卡' && { proMaterialMode: 'none' }),
    ...(sale.actualCostAmount && { costBasis: 'actual' }),
    ...(customer && { customerSource: customer.source || '', wechat: customer.wechat || '',
      customerPhone: customer.phone || '', qq: customer.qq || '', whatsapp: customer.whatsapp || '',
      telegram: customer.telegram || '' }),
    costSettings,
    ownerId: actor.id, owner: actor.name, createdById: actor.id, createdBy: actor.name,
    createdAt: at, updatedAt: at, updatedById: actor.id, updatedBy: actor.name, version: 1,
    cancelled: false, refunds: [], bankReturns: [], corrections: [], compensations: [], cancellationEvents: []
  };
  const error = checkSubscriptionTermination(order, null, '补录 Claude 历史销售', time.getTime(), true);
  if (error) throw new ClaudeHistoryIntakeError(error);
  return { order, created: true };
}
