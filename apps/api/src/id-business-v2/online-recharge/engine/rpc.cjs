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
let taskAbortController = new AbortController();
function taskSignal() {
  return taskAbortController.signal;
}
function abortTask(reason) {
  if (!taskAbortController.signal.aborted)
    taskAbortController.abort(
      reason || Object.assign(new Error('任务已停止'), { code: 'TASK_ABORTED' })
    );
}
function configureTask(task) {
  abortTask();
  taskAbortController = new AbortController();
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
  taskSignal().throwIfAborted();
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
      signal: AbortSignal.any([AbortSignal.timeout(20000), taskSignal()])
    });
  } catch {
    taskSignal().throwIfAborted();
    throw submitted
      ? new ResultUnknownError('外部提交后的内部连接中断，等待核对')
      : new Error('内部执行接口暂不可用');
  }
  if ([401, 403, 409, 410].includes(response.status)) {
    const error = new LeaseLostError();
    // The parent multiplexes independent leases and has no task context. A
    // rejected parent request must not cancel every later polling/heartbeat RPC.
    if (taskContext) abortTask(error);
    throw error;
  }
  if (!response.ok) throw new Error(`内部执行接口失败 ${response.status}`);
  // Nest sends null (and empty strings) as an empty successful HTTP body.
  // Only methods whose contract permits absence may accept that response.
  const raw = await response.text();
  let body;
  if (!raw.trim()) {
    if (['claimJob', 'getActiveProxy', 'reserveCard'].includes(method)) return null;
    if (method === 'getAppConfigValue') return '';
    throw Object.assign(new Error('内部执行接口返回了空响应'), { code: 'RPC_RESPONSE_INVALID' });
  }
  if (
    ['getPaymentRegion', 'getAppConfigValue'].includes(method) &&
    !/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(response.headers.get('content-type') || '')
  )
    return raw;
  try {
    body = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('内部执行接口响应格式无效'), { code: 'RPC_RESPONSE_INVALID' });
  }
  if (body === null) return null;
  if (body.ok === false || body.success === false) {
    if (body.code === 'LEASE_LOST') {
      const error = new LeaseLostError();
      if (taskContext) abortTask(error);
      throw error;
    }
    throw new Error('内部执行操作未完成');
  }
  if (Object.prototype.hasOwnProperty.call(body, 'result')) return body.result;
  if (Object.prototype.hasOwnProperty.call(body, 'data')) return body.data;
  return body;
}
async function beforeExternalSubmit(detail = {}) {
  taskSignal().throwIfAborted();
  if (submitted) throw new ResultUnknownError('原付款已经提交，禁止重复提交');
  require('./security.cjs').rememberSecrets(detail);
  await rpc('beforeExternalSubmit', {
    ...require('./upstream/mysql-store').currentCardLease(),
    ...detail
  });
  submitted = true;
  taskSignal().throwIfAborted();
}
function clearTask() {
  abortTask();
  taskContext = null;
  submitted = false;
  paymentConfirmed = false;
  taskAbortController = new AbortController();
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
  setTransportForTest,
  taskSignal,
  abortTask
};
