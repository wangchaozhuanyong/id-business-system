import { createHmac } from 'node:crypto';

export const RECHARGE_STAGE_LABELS = Object.freeze({
  preparing: '任务已受理，正在准备开通',
  payment_details: '正在填写支付资料',
  paying: '正在付款',
  paid: '付款已确认，等待开通结果',
  subscription_check: '正在确认订阅状态'
});

export const RECHARGE_STEP_LABELS = Object.freeze({
  started: '开始执行充值任务',
  network_check: '正在检查线路连接',
  network_ready: '线路连接已确认',
  account_prepare: '正在准备开通资料',
  checkout_wait: '正在等待结账页面',
  checkout_open: '结账页面已打开',
  payment_form: '正在等待支付表单',
  payment_details: '正在填写支付资料',
  payment_submitted: '已发起付款，等待结果确认',
  payment_check: '正在核对付款结果',
  subscription_check: '正在确认订阅状态'
});

const workerSteps = [
  [/^正在检查代理连通性/, 'network_check'],
  [/^✅ \[系统\] 代理连接成功! 代理公网 IP:/, 'network_ready'],
  [/^\[1\] 准备自助充值流程/, 'account_prepare'],
  [/^💳 \[步骤\] 等待跳转到 Checkout 配置套餐页/, 'checkout_wait'],
  [/^✅ \[步骤\] Checkout 页面已打开(?:[:：，]|$)/, 'checkout_open'],
  [/^\[Stripe\] Step 0: 等待 Checkout 支付页就绪/, 'payment_form'],
  [/^\[Stripe\] Step [1-9]: /, 'payment_details'],
  [/^\[Stripe\] ✅ 已点击提交按钮 \([^\r\n]+\)$/, 'payment_submitted'],
  [/^\[Stripe\] Step 10: 等待支付结果/, 'payment_check']
];

const originalStages = new Map([
  ['正在填写支付资料', 'payment_details'],
  ['正在填写银行卡信息', 'payment_details'],
  ['正在填写账单资料', 'payment_details'],
  ['正在付款', 'paying'],
  ['正在执行付款', 'paying'],
  ['付款成功', 'paid'],
  ['支付成功', 'paid'],
  ['正在确认订阅', 'subscription_check'],
  ['正在核对订阅状态', 'subscription_check']
]);

const originalStatuses = new Set(['running', 'success', 'failed', 'manual', 'maintenance']);
const jobKeyPattern = /^[A-Za-z0-9_-]{1,128}$/;
const taskStatusPath = /^\/api\/task-status\/([^/]+)$/;

function readTaskJobKey(path) {
  const parameter = taskStatusPath.exec(path)?.[1];
  if (!parameter) return null;
  try {
    const jobKey = decodeURIComponent(parameter).trim();
    return jobKeyPattern.test(jobKey) ? jobKey : null;
  } catch {
    return null;
  }
}

export function originalRechargeStage(message) {
  const value = typeof message === 'string' ? message.trim() : '';
  return originalStages.get(value.replace(/[。.!！…]+$/, '')) ?? 'processing';
}

export function originalRechargeNeedsReview(message) {
  return /转人工|人工确认|人工核|待核实|结果.*(?:未知|不明)|(?:付款|支付|扣款)结果(?:未确认|无法确认|等待超时)|Data too long for column ['"]error_message['"]|processing.*timeout/i.test(
    String(message ?? '')
  );
}

/** Project only fixed display steps from a matching task's dated runtime records. */
export function rechargeTaskStepHistory(body, { jobKey, status }) {
  if (body?.success !== true || body.task?.jobKey !== jobKey || !Array.isArray(body.runtimeEntries)) return null;
  const steps = [];
  let terminalAt;
  for (const entry of body.runtimeEntries) {
    if (entry?.jobKey !== jobKey || typeof entry.text !== 'string' ||
        !Number.isSafeInteger(entry.ts) || entry.ts <= 0 || entry.ts > 8.64e15) continue;
    const text = entry.text.trim();
    let stage;
    if (entry.source === 'task') {
      const terminal = /^任务结束 status=(success|failed|manual|maintenance) progress=\d+(?: |$)/.exec(text);
      if (terminal && terminal[1] === status) terminalAt = entry.ts;
      if (/^尝试 [1-9]\d* 启动自动化 proxy=(?:yes|no)$/.test(text)) stage = 'started';
    } else if (/^spawn\/a[1-9]\d*\/stdout$/.test(entry.source)) {
      stage = workerSteps.find(([pattern]) => pattern.test(text))?.[1];
      if (!stage && originalRechargeStage(text) === 'subscription_check') stage = 'subscription_check';
    }
    if (stage && steps.at(-1)?.stage !== stage) steps.push({ stage, at: entry.ts });
  }
  return { steps: steps.slice(-80), ...(terminalAt === undefined ? {} : { terminalAt }) };
}

function captchaView(value, jobKey, secret) {
  const stage =
    value?.stage === 'captcha_submitted' || value?.status === 'submitted'
      ? 'captcha_submitted'
      : value?.stage === 'awaiting_captcha' || value?.status === 'pending'
        ? 'awaiting_captcha'
        : null;
  if (!stage) return null;
  const expiry = value.expiresAt ?? value.expires_at;
  const numeric = typeof expiry === 'string' || typeof expiry === 'number' ? Number(expiry) : NaN;
  let timestamp = NaN;
  if (Number.isFinite(numeric) && numeric > 1e9)
    timestamp = new Date(numeric > 1e12 ? numeric : numeric * 1000).getTime();
  else if (typeof expiry === 'string') timestamp = Date.parse(expiry);
  // The browser compares IDs only to close a popup when its challenge is replaced.
  const challengeId = typeof value.id === 'string' ? value.id.trim() : '';
  const id = challengeId
    ? createHmac('sha256', secret)
        .update('recharge-browser-captcha\0' + jobKey + '\0' + challengeId)
        .digest('base64url')
        .slice(0, 22)
    : '';
  return {
    stage,
    ...(id ? { id } : {}),
    ...(Number.isFinite(timestamp) ? { expiresAt: new Date(timestamp).toISOString() } : {})
  };
}

export function readsRechargePresentation(method, path, status, contentType) {
  if (method === 'GET') return taskStatusPath.test(path);
  return (
    method === 'POST' &&
    path === '/api/run-process' &&
    (status === 200 || status === 503) &&
    /^application\/json\b/i.test(contentType ?? '')
  );
}

/** Add display facts at the browser boundary. The original executor and merchant transport are unchanged. */
export function rechargeBrowserPresentation(path, httpStatus, body, secret) {
  if (path === '/api/run-process') {
    // This exact response is returned by the pinned engine before code reservation or dispatch.
    if (
      httpStatus === 503 &&
      body?.success === false &&
      Object.keys(body).length === 2 &&
      body.message === '系统维护中，请稍后再试'
    ) {
      return {
        success: false,
        notAccepted: true,
        code: 'maintenance_mode',
        message: '系统维护中，充值任务未启动，请待维护结束后再提交'
      };
    }
    if (httpStatus === 200 && body?.success === true &&
        typeof body.jobKey === 'string' && jobKeyPattern.test(body.jobKey)) {
      return {
        success: true,
        jobKey: body.jobKey,
        ...(body.message === '任务已启动，正在为您开通中...' ? { stage: 'preparing' } : {})
      };
    }
    return { success: false, message: '暂时无法确认充值回执，请用原兑换码查询。' };
  }

  const jobKey = readTaskJobKey(path);
  const task = body?.data;
  if (
    !jobKey ||
    httpStatus !== 200 ||
    body?.success !== true ||
    task?.jobKey !== jobKey ||
    !originalStatuses.has(task.status) ||
    task.isTerminal !== (task.status !== 'running')
  ) {
    return { success: false, message: '暂时无法核对任务进度，请用原兑换码查询。' };
  }
  const manualReview =
    task.status === 'manual' ||
    (task.status === 'failed' && originalRechargeNeedsReview(task.message));
  const stage = task.status === 'running' ? originalRechargeStage(task.message) : 'processing';
  const progress = Number.isFinite(task.progress)
    ? Math.max(0, Math.min(task.status === 'success' ? 100 : 99, Math.round(task.progress)))
    : undefined;
  const renewalUnconfirmed =
    task.status === 'success' &&
    task.message === '开通成功，但自动续订取消状态未确认，请到目标账户账单页核对';
  return {
    success: true,
    data: {
      jobKey,
      status: task.status,
      isTerminal: task.isTerminal,
      ...(progress === undefined ? {} : { progress }),
      ...(stage !== 'processing' ? { stage } : {}),
      ...(manualReview ? { manualReview: true } : {}),
      ...(renewalUnconfirmed ? { renewalUnconfirmed: true } : {}),
      ...(Object.hasOwn(task, 'captcha')
        ? { captcha: captchaView(task.captcha, jobKey, secret) }
        : {})
    }
  };
}
