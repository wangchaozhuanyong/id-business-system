import { isDeepStrictEqual } from 'node:util';
import { financeCards, websitePages } from '../modules/website/pages.mjs';

export const staffRoles = new Set(['admin', 'supervisor', 'finance', 'registrar', 'employee']);

const workspaces = new Map(websitePages.map(page => [page.resource, page]));

export function managesBusiness(actor) {
  return actor?.role === 'admin' || actor?.role === 'super';
}

export function canUseWorkspace(actor, workspace) {
  return Boolean(workspaces.get('staff/' + workspace)?.roles.includes(actor?.role));
}

export function ownsRecord(actor, row) {
  return Boolean(actor && row && (row.ownerId || row.rechargeOwnerId || row.createdById) === actor.id);
}

export function managesCards(actor) {
  return financeCards.roles.includes(actor?.role);
}

const rechargeManagerReads = [
  /^\/api\/admin\/(?:session|data|task-logs|activation-manual-holds|billing|addresses|proxies|pool-emails|products|region)$/,
  /^\/api\/admin\/(?:task-logs|checkout\/status|billing\/summary)\/[^/]+$/,
  /^\/api\/admin\/(?:checkout\/plans|orbitcard\/products|recharge-routing|subscription\/batch-renewal-status)$/
];

const rechargeManagerWrites = {
  POST: [
    /^\/api\/admin\/(?:checkout\/generate|subscription\/batch-renewal-status|proxy\/test|proxies|addresses(?:\/generate-random-us)?|recharge-routing\/proxies)$/,
    /^\/api\/admin\/proxies\/[^/]+\/test$/
  ],
  PUT: [/^\/api\/admin\/(?:proxies|addresses)\/[^/]+$/],
  DELETE: [/^\/api\/admin\/(?:proxies|addresses)\/[^/]+$/]
};

export function nativeManagerAccess(actor, path, method) {
  const route = path.toLowerCase().replace(/\/+$/, '');
  if (!route.startsWith('/api/admin/')) return managesBusiness(actor);
  if (method === 'DELETE' && /^\/api\/admin\/(?:billing|task-logs)(?:\/|$)/.test(route)) return false;
  if (actor?.role === 'super') return true;
  if (actor?.role !== 'admin') return false;
  const permitted = ['GET', 'HEAD'].includes(method) ? rechargeManagerReads : rechargeManagerWrites[method];
  return Boolean(permitted?.some(pattern => pattern.test(route)));
}

export function nativeBrowserVerification(path, method) {
  const route = path.toLowerCase();
  const read = method === 'GET' || method === 'HEAD';
  if (read) return /^\/api\/admin\/(?:sessions|runtime-logs|screenshots|video|cdks|products\/export|billing\/export)(?:\/|$)/.test(route);
  if (/^\/api\/admin\/(?:subscription\/batch-renewal-status|proxy\/test|proxies\/[^/]+\/test)(?:\/|$)/.test(route)) return false;
  return /^\/api\/(?:external\/cards|admin\/(?:cards|config|region|recharge-routing|proxies|security|2fa|hcaptcha|telegram|ip-bans|orbitcard|subscription|activation-manual-holds|trigger-activation|cdks|products|pool-emails))(?:\/|$)/.test(route);
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
const financeCardSuffix = row => {
  const references = [row.paymentId, row.proCardNumber];
  const number = references.find(value => typeof value === 'string' && /^\d{4,19}$/.test(value));
  // A legacy reference still means a card was recorded, even when its type or
  // number cannot be read. Do not turn that unknown cost into a cardless fee.
  return number ? number.slice(-4) : references.some(Boolean) ? '••••' : '';
};
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
        'loginMethod', 'subscriptionSeries', 'previousSubscriptionOrderId', 'billingChannel', 'cardTypeName',
        'cardTypeId', 'proMaterialMode', 'kyc', 'proRenewalSourceId', 'claudeRenewalId']),
      paymentId: row.payment === '银行卡' ? financeCardSuffix(row) : row.paymentId,
      ...Object.fromEntries(['refunds', 'bankReturns', 'financialEvidence'].map(key =>
        [key, (Array.isArray(row[key]) ? row[key] : []).map(item => pick(item, accountingFields))])),
      // Monetary snapshots are used by the same accounting calculation as the orders page.
      ...Object.fromEntries(['costSettings', 'fxSnapshot', 'issueFeeSnapshot'].filter(key => row[key]).map(key =>
        [key, JSON.parse(JSON.stringify(row[key], (field, value) =>
          /pass|token|secret|credential|cvc|serial|card.?number|session/i.test(field) ? undefined : value))])),
      corrections: (Array.isArray(row.corrections) ? row.corrections : []).filter(item => item?.previous)
        .map(item => ({ kind: item.kind, previous: { ...pick(item.previous, ['cardId', 'paidConfirmed', 'payment',
          'paidAmount', 'paidCurrency', 'cardTypeId', 'cardTypeName', 'proMaterialMode']),
          ...(item.previous.payment === '银行卡' && { paymentId: financeCardSuffix(item.previous) }) } }))
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
  const page = workspaces.get(route.slice('/api/local/'.length));
  if (page && route.startsWith('/api/local/')) return page.roles.includes(actor?.role) && page.methods.includes(method);
  if (staffRoles.has(actor?.role) && route === '/api/local/toolbox') return readable || method === 'PUT';
  if (staffRoles.has(actor?.role) && ['/api/local/saved-totp', '/api/local/saved-totp/code',
    '/api/local/saved-totp/secret'].includes(route)) return true;
  if (actor?.role === 'employee')
    return (route === '/api/local/commerce' && readable) ||
      (['/api/local/order-completion', '/api/local/recharge-codes',
        '/api/local/tools/website-monitor'].includes(route));
  if (actor?.role === 'finance')
    return readable && ['/api/local/commerce', '/api/local/settings', '/api/local/appleBalance', '/api/local/finance/expense-receipts'].includes(route);
  if (actor?.role === 'registrar')
    return (readable && route === '/api/local/inventory') ||
      ['/api/local/staff/mail-code', '/api/local/staff/registration-code',
        '/api/local/apple-relay/alias-register'].includes(route);
  return false;
}
