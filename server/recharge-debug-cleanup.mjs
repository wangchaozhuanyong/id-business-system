import { createHash } from 'node:crypto';
import { automaticGptOrder } from '../modules/orders/order-opening.mjs';
import { hasConfirmedMoney } from './local-business-integrity.mjs';
import { checkoutDebugCode, rechargeCodeKey } from './recharge-order-admission.mjs';

const jobPattern = /^[A-Za-z0-9_-]{1,120}$/;
const orderNumber = /^OD-LOCAL-(\d{1,12})$/;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ordersIn = documents => documents.commerce?.data?.orders || [];

function confirmsDebug(result, jobKey) {
  const { task, runtimeEntries } = result || {};
  return task?.jobKey === jobKey && !task.gptApiOrderId && (checkoutDebugCode(task.cdk) ||
    !rechargeCodeKey(task.cdk) && (task.message === '支付页面已打开，调试已停止（未填卡、未付款）' ||
      (runtimeEntries || []).some(entry => entry.jobKey === jobKey && entry.source === 'task' &&
        /^调试结束 status=\w+ url=(?:yes|no) screenshots=\d+$/.test(entry.text))));
}

export async function readRechargeDebugEvidence(documents, client, orderNos) {
  const verified = new Set();
  for (const order of ordersIn(documents)) {
    if (!automaticGptOrder(order) || !jobPattern.test(order.taskId) ||
        (orderNos && !orderNos.has(order.orderNo))) continue;
    try {
      if (confirmsDebug(await client.get('/api/admin/task-logs/' + order.taskId), order.taskId))
        verified.add(order.taskId);
    } catch (error) {
      if (error.upstreamStatus !== 404) throw error;
    }
  }
  return verified;
}

function containsOrderReference(value, keys) {
  if (typeof value === 'string') return keys.has(value);
  return Boolean(value && typeof value === 'object' && Object.entries(value).some(([key, child]) =>
    keys.has(key) || containsOrderReference(child, keys)));
}

function standaloneOrderLog(row, orderId) {
  return row?.entityId === orderId && !row.relatedOrderId;
}

function hasBusinessReference(documents, order) {
  const keys = new Set([order.id, order.orderNo]);
  for (const [domain, { data }] of Object.entries(documents)) {
    if (!data) continue;
    if (domain === 'order-sync') {
      if ((data.rows || []).some(row => row.orderNo === order.orderNo && row.jobKey !== order.taskId)) return true;
      continue;
    }
    if (domain === 'commerce') {
      const { orders = [], logs = [], ...other } = data;
      if (containsOrderReference(orders.filter(row => row.id !== order.id), keys) ||
          containsOrderReference(logs.filter(row => !standaloneOrderLog(row, order.id)), keys) ||
          containsOrderReference(other, keys)) return true;
    } else if (containsOrderReference(data, keys)) return true;
  }
  return false;
}

function cleanupBlock(documents, order, verified) {
  if (!verified.has(order.taskId)) return '原任务未证实为调试';
  if (typeof order.id !== 'string' || !order.id || !orderNumber.test(order.orderNo) ||
      ordersIn(documents).filter(row => row.id === order.id || row.orderNo === order.orderNo || row.taskId === order.taskId).length !== 1)
    return '订单编号或任务关联存在冲突';
  if (hasConfirmedMoney(order) || order.paidConfirmed || order.receiptConfirmed || order.costConfirmed ||
      order.actualCostAmount || order.issueFeeSnapshot?.applied || order.refunds?.length || order.bankReturns?.length)
    return '存在付款、实收、成本、退款或回款记录';
  if (order.customerId || order.accountId || order.tenantId || order.previousOrderId || order.subscriptionAnchor ||
      order.updatedById || order.rechargeOwnerAssignment || order.notes ||
      order.corrections?.length || order.compensations?.length || order.cancellationEvents?.length ||
      hasBusinessReference(documents, order)) return '存在业务关联或人工处理记录';
  return '';
}

export function planRechargeDebugCleanup(documents, verified, orderNos) {
  const eligible = [];
  const review = [];
  const fingerprints = [];
  for (const order of ordersIn(documents)) {
    if (!automaticGptOrder(order) || (orderNos && !orderNos.has(order.orderNo))) continue;
    const row = { orderNo: order.orderNo, jobKey: jobPattern.test(order.taskId) ? order.taskId : '' };
    const reason = cleanupBlock(documents, order, verified);
    if (reason) review.push({ ...row, reason });
    else {
      eligible.push(row);
      fingerprints.push([row.orderNo, digest(order)]);
    }
  }
  return { eligible, review, confirmation: eligible.length ? digest(fingerprints.sort()) : null };
}

export function prepareRechargeDebugRemoval(documents, verified, orderNos, confirmation, restoredBackup) {
  const plan = planRechargeDebugCleanup(documents, verified, orderNos);
  if (!plan.confirmation || plan.confirmation !== confirmation || (orderNos && plan.eligible.length !== orderNos.size))
    throw new Error('清理清单已变化，请重新只读核对');
  const backupPlan = planRechargeDebugCleanup(restoredBackup, verified, new Set(plan.eligible.map(row => row.orderNo)));
  if (backupPlan.confirmation !== confirmation) throw new Error('隔离恢复的备份未覆盖已确认的待清理订单');
  const orderNosToRemove = new Set(plan.eligible.map(row => row.orderNo));
  const removedIds = new Set(ordersIn(documents).filter(row => orderNosToRemove.has(row.orderNo)).map(row => row.id));
  const jobs = new Set(plan.eligible.map(row => row.jobKey));
  const commerce = documents.commerce.data;
  const status = documents['order-sync']?.data;
  if (!Number.isFinite(status?.since) || status.since <= 0) throw new Error('入单检查点缺失，请先核验主站同步状态');
  return {
    removed: plan.eligible,
    commerce: {
      ...commerce,
      orders: commerce.orders.filter(row => !removedIds.has(row.id)),
      logs: (commerce.logs || []).filter(row => !removedIds.has(row?.entityId) || row.relatedOrderId)
    },
    status: {
      ...status,
      orderSequenceFloor: Math.max(status.orderSequenceFloor || 0, ...plan.eligible.map(row => Number(orderNumber.exec(row.orderNo)[1]))),
      rows: [...(status.rows || []).filter(row => !jobs.has(row.jobKey)),
        ...plan.eligible.map(({ jobKey }) => ({ jobKey, excluded: true, needs: [] }))]
    }
  };
}
