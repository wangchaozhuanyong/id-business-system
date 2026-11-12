export const RECHARGE_STAGE_LABELS = Object.freeze({
  preparing: '任务已受理，正在准备开通',
  payment_details: '正在填写支付资料',
  paying: '正在付款',
  paid: '付款已确认，等待开通结果',
  subscription_check: '正在确认订阅状态'
});

export const RECHARGE_STEP_LABELS = Object.freeze({
  created_browser: '任务已登记，交给浏览器执行流程',
  created_provider: '任务已登记，交给第三方执行流程',
  attempt_started: '开始本次执行尝试',
  started: '正在启动本次自动化',
  worker_retry: '本次尝试未完成，服务准备重试',
  network_check: '正在检查线路连接',
  network_ready: '线路连接已确认',
  account_prepare: '正在准备开通资料',
  checkout_api_ready: '已通过接口取得结账页面',
  checkout_page_ready: '已通过网页流程取得结账页面',
  checkout_wait: '正在等待结账页面',
  checkout_open: '结账页面已打开',
  payment_form: '正在等待支付表单',
  payment_method: '正在选择支付方式',
  payment_method_selected: '信用卡支付方式已选中',
  payment_details: '正在填写支付资料',
  card_number_entered: '卡号字段已填写',
  card_expiry_entered: '有效期字段已填写',
  card_security_entered: '安全码字段已填写',
  card_fields_entered: '银行卡字段已填写',
  billing_form_wait: '正在等待账单地址表单',
  billing_details: '正在填写账单资料',
  billing_entered: '账单地址已填写',
  terms_check: '正在检查服务协议',
  terms_selected: '服务协议已勾选',
  amount_checked: '已读取提交前的应付金额',
  payment_submit_attempt: '正在尝试提交付款表单',
  payment_submitted: '已发起付款，等待结果确认',
  payment_check: '正在核对付款结果',
  payment_decline_detected: '支付页出现明确的银行卡拒付提示',
  card_retry: '本次执行进入换卡重试',
  verification_detected: '已检测到人机验证',
  verification_passed: '验证已通过，继续核对付款结果',
  subscription_check: '正在确认订阅状态',
  provider_input_checked: '第三方流程已通过账号资料格式检查',
  provider_query: '已收到第三方订单查询回执',
  provider_query_failed: '本次第三方订单查询未取得回执',
  provider_verification: '第三方回执要求完成验证'
});

const workerSteps = [
  [/^正在检查代理连通性\.\.\.$/, 'network_check'],
  [/^✅ \[系统\] 代理连接成功! 代理公网 IP: /, 'network_ready'],
  [/^\[1\] 准备自助充值流程\.\.\.$/, 'account_prepare'],
  [/^CHECKOUT_SOURCE: api$/, 'checkout_api_ready'],
  [/^CHECKOUT_SOURCE: ui$/, 'checkout_page_ready'],
  [/^💳 \[步骤\] 等待跳转到 Checkout 配置套餐页/, 'checkout_wait'],
  [/^✅ \[步骤\] Checkout 页面已打开，开始信用卡支付流程\.\.\.$/, 'checkout_open'],
  [/^\[Stripe\] Step 0: 等待 Checkout 支付页就绪\.\.\.$/, 'payment_form'],
  [/^\[Stripe\] Step 1: 选择信用卡支付方式\.\.\.$/, 'payment_method'],
  [/^\[Stripe\] ✅ 已选择信用卡支付方式 \([^\r\n]+\)$/, 'payment_method_selected'],
  [/^\[Stripe\] Step 2(?: \(重试\))?: 填写(?:信用卡字段（iframe 自动识别）|新信用卡)\.\.\.$/, 'payment_details'],
  [/^\[Stripe\] ✅ 卡号已填写 \(iframe\[0\]\)$/, 'card_number_entered'],
  [/^\[Stripe\] ✅ 有效期已填写 \(iframe\[1\]\)$/, 'card_expiry_entered'],
  [/^\[Stripe\] ✅ CVC 已填写 \(iframe\[2\]\)$/, 'card_security_entered'],
  [/^\[Stripe\] ✅ 卡号\/有效期\/CVC 已填写 \((?:单 iframe 多 input|frame 扫描回退)\)$/, 'card_fields_entered'],
  [/^\[Stripe\] Step 5: 等待账单地址表单出现\.\.\.$/, 'billing_form_wait'],
  [/^\[Stripe\] Step 6: 填写账单地址与姓名\.\.\.$/, 'billing_details'],
  [/^\[Stripe\] ✅ (?:(?:OpenAI 账单地址已填写，姓名: .+)|账单地址已填写)$/, 'billing_entered'],
  [/^\[Stripe\] Step 8: 检查服务协议\.\.\.$/, 'terms_check'],
  [/^\[Stripe\] ✅ 已勾选服务协议$/, 'terms_selected'],
  [/^\[Stripe\] 提交前确认应付: /, 'amount_checked'],
  [/^\[Stripe\] Step 9: 点击订阅\/支付\.\.\.$/, 'payment_submit_attempt'],
  [/^\[Stripe\] ✅ 已点击提交按钮 \([^\r\n]+\)$/, 'payment_submitted'],
  [/^\[Stripe\] ❌ 检测到明确的银行卡拒付提示$/, 'payment_decline_detected'],
  [/^\[Stripe\] 换卡重试 #[1-9]\d*：更换卡号并重新提交\.\.\.$/, 'card_retry'],
  [/^\[Stripe\] 检测到(?: hCaptcha 弹层，开始自动处理|人机验证弹层，开始第 [1-9]\d* 次自动处理)\.\.\.$/, 'verification_detected'],
  [/^\[Stripe\] ✅ (?:人机验证已通过，继续等待支付结果|提交后人机验证已通过|提交后 hCaptcha 已由视觉求解器通过)$/, 'verification_passed'],
  [/^\[Stripe\] Step 10: 等待支付结果（最长 [1-9]\d*s，含 Stripe 处理中）\.\.\.$/, 'payment_check']
];

function taskLogStep(text) {
  const created = /^任务已创建，CDK=[^\r\n]+ mode=(local|gpt-api)$/.exec(text);
  if (created) return { stage: created[1] === 'local' ? 'created_browser' : 'created_provider' };

  const attempt = /^(?:开始第 ([1-9]\d{0,2})\/[1-9]\d{0,2} 次尝试|尝试 ([1-9]\d{0,2}) 启动自动化 proxy=(?:yes|no)|尝试 ([1-9]\d{0,2}) 失败，准备重试)$/.exec(text);
  if (attempt) return {
    stage: attempt[1] ? 'attempt_started' : attempt[2] ? 'started' : 'worker_retry',
    attempt: Number(attempt[1] || attempt[2] || attempt[3])
  };

  if (/^Desolate Open Session 格式检查通过，套餐代码 /i.test(text) ||
      text === 'Session 本機格式／有效期檢查通過；上游將於代充任務中驗證登入狀態')
    return { stage: 'provider_input_checked' };
  const query = /^(?:订单查询第 ([1-9]\d{0,5}) 次：status=|状态轮询第 ([1-9]\d{0,5}) 次失败: )/.exec(text);
  if (query) return { stage: query[1] ? 'provider_query' : 'provider_query_failed', query: Number(query[1] || query[2]) };
  if (/^订单需要人机验证 captcha=[^\r\n]+ url=(?:ready|pending)$/.test(text))
    return { stage: 'provider_verification' };
  return null;
}

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
    let step;
    if (entry.source === 'task') {
      const terminal = /^任务结束 status=(success|failed|manual|maintenance) progress=\d+(?: |$)/.exec(text);
      if (terminal && terminal[1] === status) terminalAt = entry.ts;
      step = taskLogStep(text);
    } else {
      const worker = /^spawn\/a([1-9]\d{0,2})\/stdout$/.exec(entry.source);
      if (worker) {
        const stage = workerSteps.find(([pattern]) => pattern.test(text))?.[1] ||
          (originalRechargeStage(text) === 'subscription_check' ? 'subscription_check' : null);
        if (stage) step = { stage, attempt: Number(worker[1]) };
      }
    }
    if (!step) continue;
    const previous = steps.at(-1);
    if (previous?.stage === step.stage && previous.attempt === step.attempt && previous.query === step.query) continue;
    steps.push({ ...step, at: entry.ts, ...(Number.isSafeInteger(entry.id) && entry.id > 0 && { id: entry.id }) });
  }
  return { steps: steps.slice(-160), ...(terminalAt === undefined ? {} : { terminalAt }) };
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

export function isPlanCardRejection(status, body) {
  return status === 503 && body?.success === false &&
    body.code === 'recharge_plan_cards_unavailable' && body.execution_started === false;
}

/** Add display facts at the browser boundary. The original executor and merchant transport are unchanged. */
export function rechargeBrowserPresentation(path, httpStatus, body) {
  if (path === '/api/run-process') {
    if (isPlanCardRejection(httpStatus, body)) return {
      success: false, notAccepted: true, code: 'recharge_plan_cards_unavailable',
      message: '该套餐暂无可用银行卡，请稍后再试或联系客服。'
    };
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
      ...(Object.hasOwn(task, 'captcha') ? { captcha: null } : {})
    }
  };
}
