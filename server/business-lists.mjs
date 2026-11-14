import { sortByRecordTime } from '../modules/orders/list-order.mjs';
import {
  claudeListPlan, isClaudeOrder, listPaymentStatus, listSubscriptionStatus, matchesOrderQuery, orderAccountingFact,
  orderListMissing, orderListTime, personalOrderProduct
} from '../modules/orders/order-list.mjs';
import { automaticGptOrder, inventoryOperationalStatus, orderReceiptRecorded, subscriptionTime, validOrderEmail } from '../modules/orders/order-opening.mjs';
import {
  claudeInventoryIssue, defaultInventorySettings, displayInventoryState, inventoryAccountTypes, inventoryCanExtract,
  inventoryHealthTime, inventoryIdentityIndex, inventoryListTime, inventoryMailboxTypes, inventoryMatches,
  inventoryRegistrationInstant, inventoryRegistrationTime,
  inventoryPlatformLabel, mailUse, normalizeInventoryAsset
} from '../modules/inventory/list.mjs';
import { activeExpenseReceipt, buildCardIssueAllocations, hasRecordedPaymentAmount } from '../modules/finance/accounting.mjs';
import { accountLifecycleSummaries, releasedSubscriptionOrderIds } from './account-lifecycle.mjs';
import { inspectInventoryUsage } from './inventory-usage.mjs';

export const ordersPageDomain = 'commerce/page';
export const inventoryPageDomain = 'inventory/page';
export const ordersPageRoles = ['super', 'admin', 'finance', 'employee'];
const productTypes = ['GPT', 'Claude', 'Gemini', 'Grok'];
const orderTabs = ['all', 'pending', 'refunded', 'cancelled'];
const inventoryTabs = ['all', 'available', 'claimed', 'used', 'dead', 'unlocking', 'imports'];
const orderFields = ['id', 'version', 'orderNo', 'product', 'plan', 'status', 'cancelled', 'draft', 'businessType', 'source',
  'customerId', 'ownerId', 'owner', 'rechargeOwnerId', 'createdById', 'createdBy', 'createdAt', 'updatedAt', 'updatedBy',
  'updatedById', 'start', 'expiry', 'entitlementStatus', 'payment', 'paymentId', 'saleAmount', 'saleCurrency', 'paidAmount',
  'paidCurrency', 'paidConfirmed', 'receiptConfirmed', 'email', 'xHandle', 'loginMethod', 'taskId', 'proMaterialMode',
  'proCardNumber', 'proCardSerial', 'cardTypeName', 'billingChannel', 'wechat', 'customerPhone', 'whatsapp', 'telegram',
  'phone', 'kyc', 'verifier', 'verifierPhone', 'tenantId', 'notes'];
const assetFields = ['id', 'version', 'type', 'email', 'xHandle', 'loginMethod', 'emailType', 'acquisitionMethod',
  'password', 'totp', 'appPassword', 'auxiliary', 'phone', 'country', 'city', 'health', 'status', 'inventoryState',
  'mailboxUsage', 'microsoftSecurity', 'source', 'registered', 'createdBy', 'createdAt', 'importedAt', 'lastOperatedBy',
  'lastOperatedAt', 'device', 'notes', 'notes2', 'purpose', 'claimedAt', 'usedAt', 'actualUsedAt', 'extractionNotes',
  'proxyUrl', 'proxyProtocol', 'proxyHost', 'proxyPort', 'proxyUser', 'proxyPassword', 'kyc', 'relayDeleted', 'deleted'];
const pick = (row, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
const list = value => Array.isArray(value) ? value : [];
function byKey(rows, key) {
  const index = new Map();
  for (const row of rows) if (!index.has(row[key])) index.set(row[key], row);
  return index;
}

export function businessListQuery(domain, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const { page, pageSize, tab } = input;
  if (!Number.isSafeInteger(page) || page < 1 || ![10, 20, 50].includes(pageSize)) return;
  const orders = domain === ordersPageDomain;
  const key = orders ? 'product' : 'type';
  const filters = orders ? ['query', 'plan', 'operation', 'payment', 'expiry'] : ['query', 'country', 'status', 'usage'];
  const types = orders ? productTypes : [...inventoryAccountTypes, ...inventoryMailboxTypes];
  if (!types.includes(input[key]) || !(orders ? orderTabs : inventoryTabs).includes(tab) ||
      Object.keys(input).some(field => ![key, 'page', 'pageSize', 'tab', ...filters].includes(field)) ||
      filters.some(field => Object.hasOwn(input, field) && (typeof input[field] !== 'string' || input[field].length > 500)))
    return;
  return { ...input, page, pageSize, tab };
}

function paginate(rows, params, timeOf) {
  const { pageSize } = params;
  const page = Math.min(params.page, Math.max(1, Math.ceil(rows.length / pageSize)));
  return { page, pageSize, total: rows.length, rows: sortByRecordTime(rows, timeOf).slice((page - 1) * pageSize, page * pageSize) };
}

function orderOwner(row, labels) {
  const actor = row.ownerId || row.rechargeOwnerId || row.createdById;
  let name = labels.get(row.taskId ? row.rechargeOwnerId || row.createdById : row.createdById);
  const fallback = typeof row.createdBy === 'string' && row.createdBy.trim() ? row.createdBy : '历史未记录';
  if (name && row.taskId && /^自动充值/.test(fallback) && name !== fallback) name = '自动充值/' + name;
  return labels.get(actor) || row.owner || (row.ownerId ? '历史未记录' : name || fallback);
}

export function readOrdersPage(params, {
  snapshot, inventory, owners = [], managers = false, expenseReceipts = [], appleLedger, currency = 'CNY', at = Date.now(), sync
}) {
  const { data, version } = snapshot;
  const orders = list(data?.orders), customers = list(data?.customers), tenants = list(data?.tenants);
  const customerIndex = byKey(customers, 'id'), tenantIndex = byKey(tenants, 'id');
  const labels = new Map(owners.map(({ id, name }) => [id, name]));
  const operating = new Map(list(data?.operating));
  const legacy = new Set(snapshot.legacyOpeningOrderIds);
  const released = managers ? releasedSubscriptionOrderIds(inventory, data) : new Set();
  const claude = params.product === 'Claude';
  const personal = personalOrderProduct(params.product);
  const inventoryIndex = claude && managers ? inventoryIdentityIndex(list(inventory?.accounts), []) : null;
  const summaries = personal && managers
    ? byKey(accountLifecycleSummaries({
      accounts: list(inventory?.accounts).filter(row => row.type === params.product.toLowerCase())
    }, data, at), 'assetId') : new Map();
  const counts = { all: 0, pending: 0, refunded: 0, cancelled: 0 };
  let productTotal = 0, deadline = Infinity;
  const includeDeadline = value => { if (value > at) deadline = Math.min(deadline, value); };
  const results = [];
  for (const row of orders) {
    if (claude ? !isClaudeOrder(row) : row.product !== params.product) continue;
    productTotal++;
    const missing = orderListMissing(row, customerIndex, at), pending = missing.length > 0;
    const opens = subscriptionTime(row.start), expires = subscriptionTime(row.expiry);
    if (!row.cancelled) {
      includeDeadline(opens);
      includeDeadline(expires);
      includeDeadline(subscriptionTime(row.rechargeCompletedAt));
      includeDeadline(subscriptionTime(row.subscriptionEndedAt));
    }
    const inTab = {
      all: !row.cancelled && (!automaticGptOrder(row) || !pending),
      pending: !row.cancelled && pending, refunded: Boolean(row.refunds?.length), cancelled: Boolean(row.cancelled)
    };
    for (const key of orderTabs) if (inTab[key]) counts[key]++;
    if (!inTab[params.tab] || (params.plan && row.plan !== params.plan &&
        (!claude || claudeListPlan(row.product, row.plan) !== params.plan))) continue;
    const customer = customerIndex.get(row.customerId)?.name || '待补充客户';
    const tenant = tenantIndex.get(row.tenantId)?.name || '未关联租户';
    const owner = orderOwner(row, labels);
    if (params.query && !matchesOrderQuery(row, params.query, { customer, owner, tenant })) continue;
    const payment = listPaymentStatus(row);
    const expiry = listSubscriptionStatus(row, at, { legacy: legacy.has(row.id), released: released.has(row.id) });
    const operation = personal ? summaries.get(row.accountId)?.label ||
      ({ pending: '待核对', active: '已确认开通', failed: '开通失败' })[row.entitlementStatus] || '—'
      : claude && !validOrderEmail(row.email) ? '—'
        : (claude && managers && claudeInventoryIssue(row, inventoryIndex)) ||
          ({ active: '使用中', frozen: '冻结', abandoned: '弃用' })[operating.get(String(row.email).toLowerCase())?.status || 'active'];
    if ((params.operation && params.operation !== operation) || (params.payment && params.payment !== payment) ||
        (params.expiry && params.expiry !== expiry)) continue;
    results.push({ id: row.id, row, customer, tenant, owner, pending, payment, expiry, operation });
  }
  const page = paginate(results, params, item => orderListTime(item.row, params.tab));
  const active = expenseReceipts.filter(row => activeExpenseReceipt(row, at));
  const allocations = page.rows.length ? buildCardIssueAllocations(orders, { clock: at, expenseReceipts: active }) : new Map();
  const receipts = new Map(), apple = byKey(list(appleLedger?.allocations), 'orderId');
  const ids = new Set(page.rows.map(row => row.id));
  for (const receipt of active) if (ids.has(receipt.orderId)) {
    if (!receipts.has(receipt.orderId)) receipts.set(receipt.orderId, []);
    receipts.get(receipt.orderId).push(receipt);
  }
  page.rows = page.rows.map(({ row, id, ...labels }) => {
    const { cost, gain, originalProfit } = orderAccountingFact(row, {
      currency, clock: at, cardIssueAllocations: allocations, expenseReceipts: receipts.get(row.id),
      appleLedger: row.payment === '苹果内购' ? apple.get(row.id) : undefined
    });
    // Retain only what list cells need. In particular, no FX snapshots, charge receipts or correction bodies.
    const refunds = list(row.refunds).map(refund => ({ amount: refund.amount }));
    if (['有效', '已过期'].includes(labels.expiry)) {
      const expiry = subscriptionTime(row.expiry);
      const interval = 3_600_000;
      const duration = Math.abs(expiry - at);
      includeDeadline(expiry > at ? expiry - Math.floor((duration - 1) / interval) * interval + 1
        : expiry + (Math.floor(duration / interval) + 1) * interval);
    }
    return { ...pick(row, orderFields), refunds,
      list: { ...labels, paymentRecorded: hasRecordedPaymentAmount(row), netCost: cost?.netCost ?? null, gain,
        receiptRecorded: orderReceiptRecorded(row), originalProfit, cardIssueUnallocated: cost?.cardIssueUnallocated } };
  });
  return { ...page, version, counts, productTotal, currency, at,
    ...(sync && { sync }), ...(Number.isFinite(deadline) && { refreshAt: deadline }) };
}

export function readInventoryPage(params, snapshot, commerce, at = Date.now()) {
  const { data, version } = snapshot;
  const mail = inventoryMailboxTypes.includes(params.type);
  const records = list(mail ? data?.mailboxes : data?.accounts).filter(row => row.type === params.type);
  const tableSettings = new Map(list(data?.tableSettings));
  const settings = tableSettings.get(params.type) || defaultInventorySettings();
  const review = inspectInventoryUsage(data, commerce, at);
  const index = mail && inventoryIdentityIndex(list(data?.accounts), list(data?.registrationRecords));
  const personal = ['gemini', 'grok'].includes(params.type);
  const accounts = mail ? [] : records;
  const lifecycle = byKey(accountLifecycleSummaries({ accounts }, commerce, at), 'assetId');
  const pending = personal ? new Set(list(commerce?.orders).filter(order =>
    personalOrderProduct(order.product) && order.businessType === '成品交付' && !order.cancelled &&
    order.entitlementStatus !== 'active').map(row => row.accountId)) : new Set();
  const usage = byKey(list(data?.batches).flatMap(batch => list(batch.items)), 'id');
  const mailboxes = params.type === 'microsoft' ? byKey(list(data?.mailboxes), 'id') : new Map();
  const counts = { available: 0, claimed: 0, used: 0, dead: 0, unlocking: 0 };
  let available = 0, history = false, refreshAt = Infinity;
  const rows = [];
  for (const record of records) {
    const asset = normalizeInventoryAsset({ ...record });
    const state = mail ? mailUse(asset) : displayInventoryState(asset);
    if (state === 'used' || (asset.health === 'normal' && ['available', 'claimed'].includes(state))) counts[state]++;
    if (['dead', 'unlocking'].includes(asset.health)) counts[asset.health]++;
    const issue = review.get(asset.id), summary = lifecycle.get(asset.id);
    if (inventoryCanExtract(asset, { review: issue, at, agingHours: settings.hours ?? 72,
      pendingDelivery: personal && (pending.has(asset.id) || summary?.label === '已保留待核对') })) available++;
    history ||= Boolean(asset.claudeHistory);
    if (params.type === 'claude' && asset.health === 'normal' && asset.inventoryState === 'available' &&
        inventoryOperationalStatus(asset) === '正常' && !issue && asset.claudeHistory?.phase !== 'opened') {
      const registered = inventoryRegistrationInstant(inventoryRegistrationTime(asset));
      const agingAt = registered + (settings.hours ?? 72) * 3_600_000;
      if (registered > at) refreshAt = Math.min(refreshAt, registered);
      if (agingAt > at) refreshAt = Math.min(refreshAt, agingAt);
    }
    const platformLabel = mail ? inventoryPlatformLabel(asset, index, issue) : undefined;
    if (inventoryMatches(asset, params, { mail, platformLabel })) rows.push({ ...asset, platformLabel });
  }
  const page = params.tab === 'imports'
    ? paginate(list(data?.importRecords).filter(row => row.type === params.type || row.types?.includes(params.type)), params, row => row.time)
    : paginate(rows, params, row => inventoryListTime(row, params.tab));
  page.rows = page.rows.map(row => {
    if (params.tab === 'imports')
      return pick(row, ['id', 'type', 'time', 'actor', 'total', 'success', 'failed', 'status']);
    const summary = lifecycle.get(row.id), issue = review.get(row.id);
    const recovery = mailboxes.get(row.microsoftSecurity?.recoveryMailboxId);
    const recoveryLinked = recovery && ['google', 'relay', 'microsoft'].includes(recovery.type) && !recovery.relayDeleted &&
      recovery.email?.trim().toLowerCase() === row.auxiliary?.trim().toLowerCase();
    return { ...pick(row, assetFields),
      ...(row.claudeHistory && { claudeHistory: pick(row.claudeHistory, ['phase', 'start']) }),
      ...(row.accountLifecycle && { accountLifecycle: pick(row.accountLifecycle, ['disposition']) }),
      list: {
        platformLabel: row.platformLabel, healthChangeTime: inventoryHealthTime(row),
        claimUsedAt: usage.get(row.claimId)?.usedAt,
        ...(params.type === 'microsoft' && { recoveryLinked: Boolean(recoveryLinked) }),
        ...(summary && { summary: { ...pick(summary, ['label', 'customer', 'lastRecoveredAt']), latestKyc: Boolean(summary.latestKyc) } }),
        ...(issue && { review: issue.status }),
        // Interpret legacy Claude imports using their original history on the server.
        operationalStatus: inventoryOperationalStatus(row)
      } };
  });
  const hasReview = [list(data?.mailboxes), list(data?.accounts)]
    .some(rows => rows.some(row => row.type !== 'relay' && review.has(row.id)));
  return { ...page, version, counts, stockTotal: records.length, available: params.type === 'microsoft' ? counts.available : available,
    countries: settings.countries, agingHours: settings.hours ?? 72, history, hasReview,
    ...(Number.isFinite(refreshAt) && { refreshAt }) };
}
