import { isDeepStrictEqual } from 'node:util';

export const staffRoles = new Set(['admin', 'supervisor', 'finance', 'registrar', 'employee']);

const workspaces = {
  supervisor: new Set(['team', 'business-proxies']),
  registrar: new Set(['registration']),
  employee: new Set(['customer-service'])
};

export function managesBusiness(actor) {
  return actor?.role === 'admin' || actor?.role === 'super';
}

export function canUseWorkspace(actor, workspace) {
  return Boolean(actor && workspaces[actor.role]?.has(workspace));
}

export function ownsRecord(actor, row) {
  return Boolean(actor && row && (row.ownerId || row.rechargeOwnerId || row.createdById) === actor.id);
}

export function managesCards(actor) {
  return actor?.role === 'finance' || actor?.role === 'super';
}

export function nativeManagerAccess(actor, path, method) {
  if (actor?.role !== 'admin') return true;
  if (['GET', 'HEAD'].includes(method))
    return !/^\/api\/admin\/(?:security|hcaptcha|ip-bans|telegram|runtime-logs)(?:\/|$)/i.test(path);
  return !(/^\/api\/admin\/(?:config|region|checkout\/plans|cards|orbitcard\/(?:cards|sync|config|product-strategy)|security|2fa|ip-bans|change-password|hcaptcha|telegram)(?:\/|$)/i.test(path) ||
    /^\/api\/admin\/recharge-routing(?:\/?$|\/proxies\/[^/]+\/country\/?$)/i.test(path));
}

export function protectedSettingsChanged(next, previous) {
  if (!previous) return true;
  return ['mailboxTypes', 'customerTags', 'customerSources', 'costSettings', 'orderCurrencies',
    'orderCurrenciesByProduct', 'applePaidPrices', 'gptPaidPrices', 'claudePaidPrices', 'personalPaidPrices']
    .some(key => !isDeepStrictEqual(next[key], previous[key]));
}

export function registrarInventory(snapshot, actor) {
  if (!snapshot.data) return snapshot;
  const data = snapshot.data;
  const forRegistration = row => ({ ...pick(row, ['id', 'type', 'email', 'status', 'version', 'inventoryState', 'used']),
    hasAuthenticator: Boolean(row.totp) });
  const mailboxes = (data.mailboxes || []).filter(row => ownsRecord(actor, row) && !row.relayDeleted).map(forRegistration);
  const accounts = (data.accounts || []).filter(row => ownsRecord(actor, row)).map(forRegistration);
  const parents = (data.appleRelay?.parents || []).filter(row => !row.deleted && row.status !== 'disabled')
    .map(({ id, email, version, status }) => ({ id, email, version, status }));
  return { version: snapshot.version, data: { mailboxes, accounts, batches: [], returnRecords: [], importRecords: [],
    registrationRecords: [], undo: [], tableSettings: data.tableSettings || [], appleRelay: { parents } } };
}

const pick = (source, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
const orderFields = ['id', 'version', 'orderNo', 'product', 'plan', 'status', 'cancelled', 'draft', 'businessType', 'source',
  'customerId', 'ownerId', 'owner', 'rechargeOwnerId', 'createdById', 'createdBy', 'createdAt', 'updatedAt', 'start', 'expiry',
  'entitlementStatus', 'subscriptionEnded', 'subscriptionEndedAt', 'previousOrderId', 'payment', 'saleAmount', 'saleCurrency',
  'paidAmount', 'paidCurrency', 'paidConfirmed', 'receiptConfirmed', 'email', 'xHandle', 'rechargeCompletedAt'];
const customerFields = ['id', 'version', 'name', 'wechat', 'contact', 'active', 'source', 'tags', 'createdAt', 'createdById'];
const accountingFields = ['id', 'kind', 'paidAmount', 'paidCurrency', 'currency', 'amount', 'time', 'at', 'occurredAt',
  'recordedAt', 'evidenceDate', 'effectiveAt', 'receivedAt', 'receiptKind', 'status', 'voidedAt', 'voided', 'cardId',
  'appleRecoverableCostAmount', 'feeAmount', 'customerAmount', 'customerCurrency', 'actualAmount', 'actualCurrency',
  'saleAmount', 'saleCurrency', 'chargeAmount', 'chargeCurrency', 'rate', 'state', 'payment'];

export function financeCommerce(snapshot) {
  if (!snapshot.data) return snapshot;
  const { orders = [], customers = [], operating = [] } = snapshot.data;
  return { version: snapshot.version, data: {
    orders: orders.map(row => ({
      ...pick(row, [...orderFields, 'accountId', 'appleIdId', 'cardId', 'costBasis', 'actualCostAmount',
        'actualCostCurrency', 'appleRecoverableCostAmount', 'emailCostAmount', 'emailCostCurrency',
        'externalApplePayment', 'taskId', 'customerSource', 'billingCountry', 'appleStoreRegion', 'cardUsedAt',
        'loginMethod', 'subscriptionSeries', 'previousSubscriptionOrderId', 'billingChannel', 'cardTypeName']),
      paymentId: row.payment === '银行卡' ? (/^\d{4,19}$/.test(row.paymentId) ? row.paymentId.slice(-4) : '') : row.paymentId,
      ...Object.fromEntries(['refunds', 'bankReturns', 'financialEvidence'].map(key =>
        [key, (Array.isArray(row[key]) ? row[key] : []).map(item => pick(item, accountingFields))])),
      // Monetary snapshots are used by the same accounting calculation as the orders page.
      ...Object.fromEntries(['costSettings', 'fxSnapshot', 'issueFeeSnapshot'].filter(key => row[key]).map(key =>
        [key, JSON.parse(JSON.stringify(row[key], (field, value) =>
          /pass|token|secret|credential|cvc|serial|card.?number|session/i.test(field) ? undefined : value))])),
      corrections: (Array.isArray(row.corrections) ? row.corrections : []).filter(item => item?.previous)
        .map(item => ({ kind: item.kind, previous: pick(item.previous, ['cardId', 'paidConfirmed', 'payment', 'paidAmount', 'paidCurrency']) }))
    })),
    customers: customers.map(row => pick(row, customerFields)),
    operating: operating.filter(row => Array.isArray(row) && row.length === 2 && row[1]).map(([id, row]) =>
      [id, pick(row, ['id', 'date', 'time', 'amount', 'currency', 'name', 'category', 'status'])]),
    tenants: [], rentBatches: [], logs: []
  } };
}

export function employeeCommerce(snapshot, actor) {
  if (!snapshot.data) return snapshot;
  const orders = (snapshot.data.orders || []).filter(row => ownsRecord(actor, row));
  const customerIds = new Set(orders.map(row => row.customerId));
  return { version: snapshot.version, data: {
    orders: orders.map(row => pick(row, orderFields)),
    customers: (snapshot.data.customers || []).filter(row => ownsRecord(actor, row) || customerIds.has(row.id))
      .map(row => pick(row, customerFields)),
    tenants: [], operating: [], rentBatches: [], logs: []
  } };
}

export function retailAccess(actor, route, method) {
  const readable = method === 'GET' || method === 'HEAD';
  if (staffRoles.has(actor?.role) && route === '/api/local/toolbox') return readable || method === 'PUT';
  if (staffRoles.has(actor?.role) && ['/api/local/saved-totp', '/api/local/saved-totp/code',
    '/api/local/saved-totp/secret'].includes(route)) return true;
  if (actor?.role === 'employee')
    return (route === '/api/local/commerce' && readable) ||
      (['/api/local/order-completion', '/api/local/recharge-codes', '/api/local/staff/customer-service',
        '/api/local/tools/website-monitor'].includes(route));
  if (actor?.role === 'finance')
    return (readable && ['/api/local/commerce', '/api/local/settings', '/api/local/appleBalance', '/api/local/finance/expense-receipts'].includes(route)) ||
      route.startsWith('/api/local/staff/finance/');
  if (actor?.role === 'registrar')
    return (readable && route === '/api/local/inventory') ||
      ['/api/local/staff/registration', '/api/local/staff/mail-code', '/api/local/staff/registration-code',
        '/api/local/apple-relay/alias-register'].includes(route);
  if (actor?.role === 'supervisor') return ['/api/local/staff/team', '/api/local/staff/business-proxies'].includes(route);
  return false;
}
