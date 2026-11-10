import { randomUUID } from 'node:crypto';
import { parseV2DateTimeInput, toV2DateTimeInput } from '../../modules/time/dateTime.ts';
import { systemAccount } from '../account-lifecycle.mjs';
import { rechargePlanLabels } from '../order-policy.mjs';
import { RelayError } from './vendure-provider.mjs';

const emailKey = value => String(value ?? '').trim().toLowerCase();
const state = row => row?.inventoryState || (row?.used ? 'used' : 'available');
const orderPlans = new Set(Object.values(rechargePlanLabels));
const rowKeys = ['email', 'registered', 'wechat', 'plan', 'start', 'expiry', 'payment', 'note'];
const saleKeys = ['wechat', 'plan', 'start', 'expiry', 'payment'];

function historicalDate(value) {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const local = `${date}T${(hour || '0').padStart(2, '0')}:${minute || '00'}`;
  const instant = parseV2DateTimeInput(local)?.getTime();
  return Number.isFinite(instant) ? { value: hour ? local : date, local, instant } : null;
}

function storedHistoricalDate(value) {
  const date = historicalDate(value);
  if (date || typeof value !== 'string') return date;
  const instant = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
    ? Date.parse(value) : parseV2DateTimeInput(value.replace(' ', 'T'))?.getTime();
  return Number.isFinite(instant) ? { value: toV2DateTimeInput(instant), instant } : null;
}

export function planHistoricalIntake(input, inventory, commerce, now = Date.now()) {
  const { parentId, parentVersion, days, rows } = input;
  if (Object.keys(input).some(key => !['parentId', 'parentVersion', 'days', 'rows', 'inventoryVersion', 'commerceVersion'].includes(key)))
    throw new RelayError(400, '历史入库请求包含未支持的字段');
  const parent = inventory.data?.appleRelay?.parents?.find(row => row.id === parentId);
  if (!parent || parent.deleted || parent.status !== 'ACTIVE' || (parent.version || 1) !== parentVersion)
    throw new RelayError(409, '请重新选择有效主邮箱后预检');
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650 || !Array.isArray(rows) || rows.length < 1 || rows.length > 100)
    throw new RelayError(400, '请填写有效天数和 1 至 100 条历史资料');
  const group = (items, key) => Map.groupBy(items || [], row => emailKey(row[key]));
  const aliases = group(inventory.data?.mailboxes?.filter(row => row.type === 'relay'), 'email');
  const accounts = group(inventory.data?.accounts?.filter(row => row.type === 'gpt'), 'email');
  const customers = group(commerce.data?.customers, 'wechat');
  const sales = group(commerce.data?.orders?.filter(row => row.product === 'GPT' && row.businessType === '成品交付'), 'email');
  const seen = new Set();
  const plannedRows = rows.map((raw, index) => {
    const line = index + 1;
    const error = message => ({ line, error: message });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        Object.entries(raw).some(([key, value]) => !rowKeys.includes(key) || typeof value !== 'string' || /[\r\n\x00]/.test(value)))
      return error('只接受历史入库表头中的文字字段');
    const email = emailKey(raw.email);
    const note = raw.note?.trim() || '';
    if (email.length > 254 || !/^[^\s@,|]+@[^\s@,|]+\.[^\s@,|]+$/.test(email) || note.length > 500)
      return error('隐藏邮箱或备注格式无效');
    if (seen.has(email)) return error('同一批隐藏邮箱重复');
    seen.add(email);
    const registered = historicalDate(raw.registered?.trim());
    if (!registered || registered.instant > now) return error('请填写已核实的注册时间');

    const [alias, duplicateAlias] = aliases.get(email) || [];
    if (duplicateAlias || (alias && (alias.parentMailboxId !== parentId || alias.relayDeleted ||
        alias.relayStatus !== 'ACTIVE' || state(alias) === 'claimed')))
      return error('隐藏邮箱归属、状态或领用有冲突');
    const priorRecords = alias ? (inventory.data?.registrationRecords || []).filter(row => row.assetId === alias.id) : [];
    if (priorRecords.some(row => row.state !== '成功' || row.product?.toLowerCase() !== 'gpt') ||
        alias?.usageLinks?.some(row => row.kind === 'registration' && row.product && row.product !== 'gpt'))
      return error('邮箱已有冲突的注册记录');

    const [account, duplicateAccount] = accounts.get(email) || [];
    if (duplicateAccount || (account && (!systemAccount(account) ||
        (account.emailType && !['relay', '苹果隐藏邮箱'].includes(account.emailType)))))
      return error('GPT 账号重复或来源有冲突');
    const priorDate = storedHistoricalDate(account?.registered);
    if (priorDate && priorDate.value !== registered.value &&
        ((priorDate.value.length > 10 && registered.value.length > 10) ||
          priorDate.value.slice(0, 10) !== registered.value.slice(0, 10)))
      return error('GPT 账号已有不同的注册时间');

    let sale;
    let previousOrder;
    if (saleKeys.some(key => raw[key]?.trim())) {
      const [customer, duplicateCustomer] = customers.get(emailKey(raw.wechat)) || [];
      if (!raw.wechat?.trim() || !customer?.id || duplicateCustomer)
        return error('请先按客户微信建立或核对唯一客户');
      const plan = raw.plan?.trim();
      const start = historicalDate(raw.start?.trim());
      const expiry = historicalDate(raw.expiry?.trim());
      const payment = raw.payment?.trim();
      if (!orderPlans.has(plan) || !start || !expiry || start.instant < registered.instant || start.instant > now || expiry.instant <= start.instant ||
          !['银行卡', '苹果内购'].includes(payment))
        return error('请核对原套餐、付款方式、开通与到期时间');
      sale = { customer, plan, start: start.local, expiry: expiry.local, payment };
      const existing = sales.get(email) || [];
      const matches = existing.filter(order => account && order.accountId === account.id &&
        order.customerId === customer.id && order.plan === plan && order.payment === payment &&
        storedHistoricalDate(order.start)?.instant === start.instant && storedHistoricalDate(order.expiry)?.instant === expiry.instant);
      if (matches.length === 1 && (state(account) === 'used' || account.accountLifecycle?.disposition === 'recovered'))
        previousOrder = matches[0];
      else if (existing.length) return error('同邮箱已有成品订单，请先核对原单');
      if (!previousOrder && account && (state(account) !== 'available' || account.usageLinks?.length ||
          account.claimId || (account.status || '正常') !== '正常' || (account.health || 'normal') !== 'normal'))
        return error('现有账号已有占用、历史或异常状态');
    }

    return { line, email, note, registered: registered.value, alias, account, sale, previousOrder };
  });
  const pending = plannedRows.filter(row => !row.error &&
    (!row.alias || !row.account || state(row.alias) !== 'used' || (row.sale && !row.previousOrder)));
  return { parentId, parentVersion, days, rows: plannedRows, pending,
    inventoryVersion: inventory.version, commerceVersion: commerce.version };
}

export function historicalIntakePreview(plan) {
  return {
    inventoryVersion: plan.inventoryVersion,
    commerceVersion: plan.commerceVersion,
    pending: plan.pending.length,
    rows: plan.rows.map(({ line, email, alias, account, sale, previousOrder, error }) => error ? { line, error } : ({
      line, email,
      mailbox: !alias ? '新增已使用邮箱' : state(alias) === 'used' ? '复用' : '登记为已使用',
      account: account ? '复用' : sale ? '新增已使用账号' : '新增正常账号',
      order: previousOrder ? '复用原订单' : sale ? '新增待补全订单' : '—'
    }))
  };
}

export function requireHistoricalIntake(plan, versions) {
  if (plan.inventoryVersion !== versions.inventoryVersion || plan.commerceVersion !== versions.commerceVersion)
    throw new RelayError(409, '库存或订单已变化，请重新预检');
  const problem = plan.rows.find(row => row.error);
  if (problem) throw new RelayError(409, `第 ${problem.line} 条。${problem.error}`);
}

export function stageHistoricalIntake(plan, inventory, commerce, actor, time) {
  const deliveryAccounts = [];
  const aliasIds = new Set();
  const orders = [];
  let accountsCreated = 0;
  for (const row of plan.pending) {
    const alias = inventory.mailboxes.find(item => item.type === 'relay' && emailKey(item.email) === row.email);
    if (!alias || alias.parentMailboxId !== plan.parentId)
      throw new RelayError(409, `第 ${row.line} 条的主邮箱绑定未确认`);
    aliasIds.add(alias.id);
    const sold = row.sale && !row.previousOrder;
    let account = row.account && inventory.accounts.find(item => item.id === row.account.id);
    if (!account) {
      account = {
        id: `gpt-history-${randomUUID()}`, type: 'gpt', email: row.email, emailType: 'relay',
        registered: row.registered, source: '自己注册', status: '正常', health: 'normal',
        inventoryState: 'available', used: false, notes: row.note, version: 1, inventoryHistory: [], usageLinks: []
      };
      inventory.accounts.unshift(account);
      accountsCreated += 1;
      if (sold) deliveryAccounts.push(structuredClone(account));
    }
    if (!sold) continue;

    const { customer, plan: productPlan, start, expiry, payment } = row.sale;
    const order = {
      id: `commerce-order-${randomUUID()}`, product: 'GPT', businessType: '成品交付', plan: productPlan,
      accountId: account.id, email: account.email, accountSource: '库存', customerId: customer.id,
      wechat: customer.wechat || '', customerPhone: customer.phone || '', qq: customer.qq || '',
      whatsapp: customer.whatsapp || '', telegram: customer.telegram || '',
      payment, paymentId: '', cardId: '', appleIdId: '', paidAmount: '', saleAmount: '',
      paidCurrency: '', saleCurrency: '', paidConfirmed: false, receiptConfirmed: false, costConfirmed: false,
      start, expiry, source: '历史入库', notes: row.note,
      createdAt: time, updatedAt: time, updatedById: actor.id, version: 1, cancelled: false,
      refunds: [], bankReturns: [], corrections: [], compensations: [], cancellationEvents: []
    };
    commerce.orders.unshift(order);
    commerce.logs.unshift({ id: `commerce-log-${randomUUID()}`, type: '历史成品交付', entityId: order.id,
      detail: productPlan, at: time, actorId: actor.id, actor: actor.name });
    orders.push(order);
    account.used = true;
    account.inventoryState = 'used';
    account.actualUsedAt = start;
    if (row.account) account.version = (account.version || 1) + 1;
    (account.usageLinks ||= []).push({ kind: 'order-sale', orderId: order.id, label: '历史成品交付', time, occurredAt: start });
    (account.inventoryHistory ||= []).push({ id: randomUUID(), action: '历史成品交付', detail: order.id });
  }
  return { aliasIds, deliveryAccounts, orders, accountsCreated };
}
