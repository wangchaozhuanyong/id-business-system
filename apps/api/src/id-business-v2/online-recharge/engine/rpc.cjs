'use strict';

class LeaseLostError extends Error {
  constructor() {
    super('任务租约已失效');
    this.code = 'LEASE_LOST';
  }
}
class ResultUnknownError extends Error {
  constructor(message = '外部执行结果待核对，禁止自动重试') {
    super(message);
    this.code = 'RESULT_UNKNOWN';
  }
}
let taskContext = null;
let submitted = false;
let paymentConfirmed = false;
let transportOverride = null;
function configureTask(task) {
  taskContext = task;
  submitted = false;
  paymentConfirmed = false;
}
function wasSubmitted() {
  return submitted;
}
function wasPaymentConfirmed() {
  return paymentConfirmed;
}
function recordKnownOutcome(kind) {
  submitted = false;
  if (kind === 'success') paymentConfirmed = true;
}
function setTransportForTest(fn) {
  transportOverride = fn;
}
function scope() {
  return taskContext
    ? {
        taskId: taskContext.id,
        workerId: taskContext.workerId,
        leaseId: taskContext.leaseId,
        leaseVersion: taskContext.leaseVersion
      }
    : {};
}
async function rpc(method, args = {}) {
  const scoped = { ...args, ...scope() };
  if (transportOverride) return transportOverride(method, scoped);
  const url = process.env.ONLINE_RECHARGE_RPC_URL;
  const key = process.env.ONLINE_RECHARGE_WORKER_KEY;
  if (!url || !key) throw new Error('缺少独立执行器内部接口配置');
  const target = new URL(url);
  if (target.username || target.password || !['http:', 'https:'].includes(target.protocol))
    throw new Error('内部接口地址无效');
  if (
    target.protocol !== 'https:' &&
    !['127.0.0.1', 'localhost', '[::1]', 'api'].includes(target.hostname)
  )
    throw new Error('内部接口须使用受保护连接');
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-online-recharge-worker': key },
      body: JSON.stringify({ method, args: scoped, ...scope() }),
      signal: AbortSignal.timeout(20000)
    });
  } catch {
    throw submitted
      ? new ResultUnknownError('外部提交后的内部连接中断，等待核对')
      : new Error('内部执行接口暂不可用');
  }
  if ([401, 403, 409, 410].includes(response.status)) throw new LeaseLostError();
  if (!response.ok) throw new Error(`内部执行接口失败 ${response.status}`);
  const body = await response.json();
  if (body === null) return null;
  if (body.ok === false || body.success === false) {
    if (body.code === 'LEASE_LOST') throw new LeaseLostError();
    throw new Error('内部执行操作未完成');
  }
  if (Object.prototype.hasOwnProperty.call(body, 'result')) return body.result;
  if (Object.prototype.hasOwnProperty.call(body, 'data')) return body.data;
  return body;
}
async function beforeExternalSubmit(detail = {}) {
  await rpc('beforeExternalSubmit', {
    ...require('./upstream/mysql-store').currentCardLease(),
    ...detail
  });
  submitted = true;
}
function clearTask() {
  taskContext = null;
  submitted = false;
  paymentConfirmed = false;
}
module.exports = {
  rpc,
  configureTask,
  clearTask,
  scope,
  beforeExternalSubmit,
  wasSubmitted,
  recordKnownOutcome,
  wasPaymentConfirmed,
  LeaseLostError,
  ResultUnknownError,
  setTransportForTest
};
