export const BITBROWSER_BACKUP_START = '/api/recharge/bitbrowser/jobs/bitbrowser';

const requiredStringFields = [
  'id',
  'plan',
  'addressId',
  'windowName',
  'lockedCurrency',
  'expectedEmail'
];
const optionalStringFields = [
  'billingAllocationId',
  'cardId',
  'billingName',
  'proxyId',
  'proxyCountryCode'
];
const allowedFields = new Set([
  ...requiredStringFields,
  ...optionalStringFields,
  'connectionProfileId',
  'subscriptionCycleProtocol',
  'directMode',
  'authorizeSinglePayment',
  'manualPaymentConfirmation'
]);

const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function response(status, body, extraHeaders) {
  return { status, headers: { 'Cache-Control': 'no-store', ...extraHeaders }, body };
}

function isDirectJsonPayment(body) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(body))
  ) {
    return false;
  }
  return (
    Object.keys(body).every((key) => allowedFields.has(key)) &&
    requiredStringFields.every((field) => Object.hasOwn(body, field) && isText(body[field])) &&
    optionalStringFields.every((field) => !Object.hasOwn(body, field) || isText(body[field])) &&
    (body.connectionProfileId == null || isText(body.connectionProfileId)) &&
    (body.subscriptionCycleProtocol === undefined || body.subscriptionCycleProtocol === 1) &&
    emailPattern.test(body.expectedEmail) &&
    body.expectedEmail.length <= 250 &&
    body.directMode === true &&
    body.authorizeSinglePayment === true &&
    body.manualPaymentConfirmation === true
  );
}

/**
 * Optional host adapter for the production start contract. The host supplies its unified
 * role/session guard and production-grade task service. This adapter is not a payment engine.
 */
export function createBitBrowserBackup({ requireOperator, startDirectRecharge }) {
  if (typeof requireOperator !== 'function' || typeof startDirectRecharge !== 'function') {
    throw new TypeError('比特备用充值需要统一权限校验和已接入的直连任务服务');
  }

  return async function handleBitBrowserBackup({ method, pathname, body, context }) {
    if (pathname !== BITBROWSER_BACKUP_START) return null;
    if (method !== 'POST') {
      return response(405, { message: '此入口只接受直连充值任务' }, { Allow: 'POST' });
    }

    const operator = await requireOperator(context);
    if (!operator?.id) {
      return response(403, { message: '当前用户没有比特备用充值权限' });
    }
    if (!isDirectJsonPayment(body)) {
      return response(400, { message: '请使用授权 JSON 直连充值，并在官网核价后人工确认' });
    }

    // In production the JSON is consumed by the local browser. This call creates a task
    // using identifiers and expected email. The original service owns all payment checks.
    const launch = await startDirectRecharge({ ...body }, operator);
    return response(201, launch);
  };
}
