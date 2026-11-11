import { isDeepStrictEqual } from 'node:util';
import { orderOpeningConfirmed, subscriptionTime as orderTime } from '../frontend/order-opening.mjs';
import { personalProduct, subscriptionSeries, targetKey } from './personal-subscriptions.mjs';

export const tenantRenewalHandledAction = '处理租户续费提醒';
export const tenantRenewalSettingsAction = '更新租户续费提醒设置';

const defaultHours = 72;
const hourMs = 3_600_000;
const isReminderLog = row => [tenantRenewalHandledAction, tenantRenewalSettingsAction].includes(row?.type);
const warningHours = data => data?.renewalWarningHours ?? (data?.renewalWarningDays ?? 3) * 24;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

function accountKey(order) {
  if (personalProduct(order.product)) {
    const target = targetKey(order);
    return target && JSON.stringify([order.product, subscriptionSeries(order), target, order.platformAccountId || '']);
  }
  const email = String(order.email || '').trim().toLowerCase();
  const family = ['Claude Pro', 'Claude Max'].includes(order.product) ? 'Claude' : order.product;
  return email && ['Claude', 'GPT'].includes(family) && JSON.stringify([family, email]);
}

function checkHandledCycle(entry, previous, at, hours, history, confirmedOrderIds) {
  const cycle = entry.tenantRenewal;
  const { orderIds, expiry } = cycle || {};
  if (!Array.isArray(orderIds) || !orderIds.length ||
      orderIds.some(id => typeof id !== 'string' || !id) || new Set(orderIds).size !== orderIds.length ||
      !Number.isSafeInteger(expiry) || !previous?.tenants?.some(tenant => tenant.id === entry.entityId))
    fail(400, '租户续费提醒资料不完整');
  if (expiry > at + hours * hourMs) fail(409, '订阅尚未进入提醒时间，请重新核对');
  const ordersById = new Map((previous.orders || []).map(order => [order.id, order]));
  const identities = new Set();
  for (const id of orderIds) {
    const order = ordersById.get(id);
    const start = orderTime(order?.start);
    if (!order || order.tenantId !== entry.entityId || order.cancelled || order.subscriptionEnded ||
        !(start <= at && start < expiry) || orderTime(order.expiry) !== expiry ||
        !orderOpeningConfirmed(order, at, confirmedOrderIds.has(order.id)))
      fail(409, '关联订单或到期时间已变化，请重新核对');
    identities.add(accountKey(order));
  }
  if (identities.size !== 1 || [...identities].some(key => !key))
    fail(409, '请按同一账号和周期处理续费提醒');
  const ids = new Set(orderIds);
  if (history.some(row => row.type === tenantRenewalHandledAction && row.entityId === entry.entityId &&
      row.tenantRenewal?.expiry === expiry && row.tenantRenewal.orderIds.some(id => ids.has(id))))
    fail(409, '这条租户续费提醒已经处理');
  return { orderIds, expiry };
}

export function prepareTenantRenewalWrite(previous, data, action, actor, now = new Date(), confirmedOrderIds = new Set()) {
  const priorHours = previous?.tenantRenewalWarningHours;
  const setting = action === tenantRenewalSettingsAction;
  const handling = action === tenantRenewalHandledAction;
  if (data.tenantRenewalWarningHours === undefined && priorHours !== undefined)
    data.tenantRenewalWarningHours = priorHours;
  const hours = data.tenantRenewalWarningHours;
  if (hours !== undefined && (!Number.isSafeInteger(hours) || hours < 1 || hours > 365 * 24))
    fail(400, '租户续费提醒时间须在 1 小时至 365 天之间');
  if (!setting && hours !== priorHours) fail(409, '请在租户续费提醒设置中修改提前时间');
  const oldLogs = previous?.logs || [];
  const history = oldLogs.filter(isReminderLog);
  if (!setting && !handling) {
    if (!isDeepStrictEqual(history, data.logs.filter(isReminderLog)))
      fail(409, '已有的租户续费记录须完整保留');
    return;
  }
  if (actor && (!actor.id || !['admin', 'super'].includes(actor.role)))
    fail(403, '只有管理员可以处理租户续费提醒');
  const [entry, ...rest] = data.logs;
  if (!entry || entry.type !== action || typeof entry.id !== 'string' || !entry.id ||
      oldLogs.some(row => row?.id === entry.id) || !isDeepStrictEqual(rest, oldLogs) ||
      warningHours(previous) !== warningHours(data) ||
      ['customers', 'tenants', 'orders', 'operating', 'rentBatches'].some(key =>
        !isDeepStrictEqual(previous?.[key] ?? [], data[key])))
    fail(409, '请单独保存租户续费提醒，相关业务资料须保留原值');
  if (setting && hours === undefined) fail(400, '请填写租户续费提醒时间');
  const tenantRenewal = handling
    ? checkHandledCycle(entry, previous, now.getTime(), hours ?? defaultHours, history, confirmedOrderIds) : undefined;
  data.logs[0] = {
    id: entry.id,
    type: action,
    entityId: setting ? 'tenant-renewal-settings' : entry.entityId,
    detail: setting ? `租户提醒提前 ${hours} 小时` : '已标记处理本次到期提醒',
    at: now.toISOString(),
    actor: actor?.name || '本机操作员',
    actorId: actor?.id || 'local-operator',
    ...(tenantRenewal && { tenantRenewal })
  };
}
