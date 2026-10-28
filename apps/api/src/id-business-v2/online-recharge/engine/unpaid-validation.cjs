'use strict';
// This module never imports or calls a payment submitter.
const STAGES = [
  'input',
  'proxy',
  'login',
  'preflight',
  'checkout_create',
  'checkout_open',
  'card_readiness',
  'card_fill',
  'billing_fill',
  'button_ready',
  'cleanup'
];
const CLASSES = [
  'NONE',
  'INPUT_MISSING',
  'PROXY_UNAVAILABLE',
  'BROWSER_PROFILE_UNAVAILABLE',
  'LOGIN_READ_FAILED',
  'NETWORK_READ_FAILED',
  'LOGIN_UNCONFIRMED',
  'CHECKOUT_REJECTED',
  'CHECKOUT_CREATION_UNKNOWN',
  'PAYMENT_COMPONENT_NOT_LOADED',
  'CARD_NOT_READY',
  'BILLING_FILL_FAILED',
  'BUTTON_NOT_READY',
  'READ_INCOMPLETE',
  'CHALLENGE_BLOCKED',
  'EXECUTOR_INTERRUPTED',
  'OTHER'
];
const CODES = [
  'UNKNOWN',
  ...CLASSES,
  'PROXY_CONNECTION_FAILED',
  'PROFILE_IDENTITY_MISSING',
  'PROFILE_PROXY_INVALID',
  'PROFILE_BUSY',
  'PROFILE_EXIT_CHANGED',
  'PROFILE_BINDING_INVALID',
  'PROFILE_DIRECTORY_INVALID',
  'PROFILE_LAUNCH_FAILED',
  'PROFILE_CLEANUP_FAILED',
  'PENDING_CREDENTIALS',
  'CHECKOUT_FORM_DATA_MISSING',
  'CHECKOUT_AUTH_READ_FAILED',
  'SESSION_INVALID',
  'SESSION_NOT_CONFIRMED',
  'SESSION_API_UNCONFIRMED',
  'SESSION_VERIFICATION_BLOCKED',
  'SESSION_BOOTSTRAP_FAILED',
  'ACCOUNT_MISMATCH',
  'NETWORK_TIMEOUT',
  'NETWORK_UNAVAILABLE',
  'UPSTREAM_INVALID_RESPONSE',
  'UPSTREAM_BLOCKED',
  'UPSTREAM_FORBIDDEN',
  'CHECKOUT_CREATION_REJECTED',
  'CHECKOUT_OPEN_FAILED',
  'CHECKOUT_CARD_NOT_READY',
  'CHECKOUT_PLAN_PREPARING',
  'CHECKOUT_FORM_NOT_READY',
  'CHECKOUT_CONTROL_READ_FAILED',
  'CHECKOUT_CONTROL_BLOCKED',
  'CHECKOUT_CONTENT_LOAD_FAILED',
  'CHECKOUT_FORM_TIMEOUT',
  'CHECKOUT_PAGE_CLOSED',
  'EXECUTION_FAILED'
];
let current;
function enabled(task) {
  return task?.operation === 'debug' && task.payload?.validationMode === 'ready_before_payment';
}
function start(emit = () => {}) {
  current = {
    format: 'unpaid-validation-v1',
    startedAt: new Date().toISOString(),
    timeline: [],
    emit
  };
  stage('input');
}
function stage(value) {
  if (!current || !STAGES.includes(value)) return;
  const now = new Date().toISOString();
  const previous = current.timeline.at(-1);
  if (previous?.stage === value) return;
  if (previous && !previous.endedAt) previous.endedAt = now;
  current.timeline.push({ stage: value, startedAt: now });
  current.emit({ type: 'validation_stage', stage: value, at: now });
}
// Reuse the existing controlled inspection projection; never copy DOM, values or errors.
function safeFormDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const inspection = require('./upstream/chatgpt').safeCheckoutFormInspection(value.inspection);
  const fields = [
    'number',
    'expiry',
    'month',
    'year',
    'cvc',
    'country',
    'line1',
    'city',
    'postal',
    'name',
    'state'
  ];
  const phases = ['locate', 'precheck', 'input', 'readback'];
  const readPhases = [
    'frame_scan',
    'candidate_handles',
    'candidate_eligibility',
    'value',
    'control_read'
  ];
  const steps = Array.isArray(value.steps)
    ? value.steps
        .slice(-32)
        .filter(
          (row) =>
            row &&
            fields.includes(row.field) &&
            phases.includes(row.phase) &&
            ['pending', 'completed', 'failed'].includes(row.state)
        )
        .map((row) => {
          const step = { field: row.field, phase: row.phase, state: row.state };
          for (const key of ['durationMs', 'frameId', 'candidateCount', 'eligibleCount'])
            if (
              Number.isInteger(row[key]) &&
              row[key] >= 0 &&
              row[key] <= (key === 'durationMs' ? 600000 : 10000)
            )
              step[key] = row[key];
          for (const key of ['inShadowRoot', 'readOnly', 'visible', 'matched'])
            if (typeof row[key] === 'boolean') step[key] = row[key];
          const enums = {
            frameKind: ['main', 'embedded'],
            tag: ['input', 'select', 'textarea', 'other'],
            role: ['combobox'],
            locatorKind: [
              'id',
              'data-elements-stable-field-name',
              'data-testid',
              'autocomplete',
              'name',
              'label',
              'placeholder'
            ],
            method: ['fill', 'select_option', 'combobox'],
            readPhase: readPhases,
            errorClass: [
              'timeout',
              'closed',
              'detached',
              'context_destroyed',
              'aborted',
              'read_failed'
            ]
          };
          for (const [key, allowed] of Object.entries(enums))
            if (allowed.includes(row[key])) step[key] = row[key];
          return step;
        })
    : [];
  return inspection || steps.length ? { ...(inspection ? { inspection } : {}), steps } : undefined;
}
function classify(result = {}, lastStage) {
  const code =
    result.validationErrorCode ||
    result.errorCode ||
    result.code ||
    result.confirmation?.queryErrorCode ||
    '';
  if (
    result.challengeDetected === true ||
    result.checkoutCreationDiagnostics?.classification === 'CF_CHALLENGE' ||
    result.confirmation?.queryErrorCode === 'UPSTREAM_BLOCKED' ||
    result.confirmation?.queryErrorCode === 'CHALLENGE_BLOCKED' ||
    code === 'CHALLENGE_BLOCKED' ||
    code === 'HUMAN_VERIFICATION_REQUIRED' ||
    (['UPSTREAM_BLOCKED', 'SESSION_VERIFICATION_BLOCKED'].includes(code) &&
      result.bootstrapDiagnostics?.challengeDetected === true)
  )
    return 'CHALLENGE_BLOCKED';
  if (
    code === 'PENDING_CREDENTIALS' ||
    code === 'CHECKOUT_FORM_DATA_MISSING' ||
    code === 'INPUT_MISSING'
  )
    return 'INPUT_MISSING';
  if (code === 'CHECKOUT_AUTH_READ_FAILED' || code === 'LOGIN_READ_FAILED')
    return 'LOGIN_READ_FAILED';
  if (
    [
      'PROXY_CONNECTION_FAILED',
      'PROXY_UNAVAILABLE',
      'PROFILE_PROXY_INVALID',
      'PROFILE_EXIT_CHANGED'
    ].includes(code)
  )
    return 'PROXY_UNAVAILABLE';
  if (CODES.includes(code) && code.startsWith('PROFILE_')) return 'BROWSER_PROFILE_UNAVAILABLE';
  if (['NETWORK_TIMEOUT', 'NETWORK_UNAVAILABLE'].includes(code)) return 'NETWORK_READ_FAILED';
  if (code === 'CHECKOUT_CREATION_REJECTED') return 'CHECKOUT_REJECTED';
  if (code === 'CHECKOUT_CREATION_UNKNOWN') return 'CHECKOUT_CREATION_UNKNOWN';
  if (code === 'EXECUTOR_INTERRUPTED') return 'EXECUTOR_INTERRUPTED';
  if (
    code === 'CHECKOUT_CONTENT_LOAD_FAILED' ||
    result.checkoutOpenDiagnostics?.inspection?.contentLoadFailed
  )
    return 'PAYMENT_COMPONENT_NOT_LOADED';
  if (
    code === 'CHECKOUT_CONTROL_READ_FAILED' ||
    result.formDiagnostics?.inspection?.complete === false ||
    result.inspection?.complete === false ||
    result.checkoutOpenDiagnostics?.inspection?.complete === false
  )
    return 'READ_INCOMPLETE';
  if (code === 'CHECKOUT_CARD_NOT_READY') return 'CARD_NOT_READY';
  if (['CHECKOUT_PLAN_PREPARING', 'CHECKOUT_FORM_NOT_READY'].includes(code))
    return 'PAYMENT_COMPONENT_NOT_LOADED';
  if (lastStage === 'billing_fill') return 'BILLING_FILL_FAILED';
  if (lastStage === 'card_fill' || lastStage === 'card_readiness') return 'CARD_NOT_READY';
  if (lastStage === 'button_ready') return 'BUTTON_NOT_READY';
  if (lastStage === 'login') return 'LOGIN_UNCONFIRMED';
  if (result.checkoutOpenDiagnostics?.inspection?.complete === false) return 'READ_INCOMPLETE';
  return 'OTHER';
}
function finish(result = {}, snapshot = current) {
  if (!snapshot)
    snapshot = {
      format: 'unpaid-validation-v1',
      startedAt: new Date().toISOString(),
      timeline: []
    };
  if (!snapshot.timeline.length)
    snapshot.timeline.push({ stage: 'input', startedAt: snapshot.startedAt });
  const endedAt = new Date().toISOString();
  const lastStage =
    snapshot.timeline.filter((row) => row.stage !== 'cleanup').at(-1)?.stage || 'input';
  const last = snapshot.timeline.at(-1);
  if (last && !last.endedAt) last.endedAt = endedAt;
  const ready =
    result.validationOutcome === 'ready_before_payment' &&
    result.cardVerified === true &&
    result.billingVerified === true &&
    result.buttonReady === true;
  const failureClass = ready
    ? 'NONE'
    : classify(
        {
          ...result,
          challengeDetected: result.challengeDetected === true || snapshot.pendingChallenge === true
        },
        lastStage
      );
  const formDiagnostics = safeFormDiagnostics(result.formDiagnostics);
  const checkoutOpenDiagnostics = result.checkoutOpenDiagnostics
    ? require('./upstream/chatgpt').safeCheckoutOpenDiagnostics(result.checkoutOpenDiagnostics)
    : undefined;
  const missing =
    checkoutOpenDiagnostics?.inspection?.lastReadFailure?.probe === 'load_precheck'
      ? []
      : result.validationMissing || result.missing || checkoutOpenDiagnostics?.missing;
  return {
    format: snapshot.format,
    startedAt: snapshot.startedAt,
    endedAt,
    lastStage,
    outcome: ready
      ? 'ready_before_payment'
      : failureClass === 'CHALLENGE_BLOCKED'
        ? 'challenge_blocked'
        : 'failed_with_class',
    failureClass,
    failureCode: CODES.includes(
      result.validationErrorCode ||
        result.errorCode ||
        result.code ||
        result.confirmation?.queryErrorCode
    )
      ? result.validationErrorCode ||
        result.errorCode ||
        result.code ||
        result.confirmation?.queryErrorCode
      : 'UNKNOWN',
    timeline: snapshot.timeline.map((row) => ({
      ...row,
      state: row.stage === lastStage && failureClass !== 'NONE' ? 'failed' : 'completed'
    })),
    cardVerified: result.cardVerified === true,
    billingVerified: result.billingVerified === true,
    buttonReady: result.buttonReady === true,
    submitted: false,
    missing: Array.isArray(missing)
      ? missing
          .filter((key) =>
            [
              'number',
              'expiry',
              'cvc',
              'country',
              'line1',
              'city',
              'postal',
              'name',
              'state'
            ].includes(key)
          )
          .slice(0, 9)
      : [],
    ...(formDiagnostics ? { formDiagnostics } : {}),
    ...(result.bootstrapDiagnostics
      ? {
          bootstrapDiagnostics: require('./upstream/session-auth').safeBootstrapDiagnostics(
            result.bootstrapDiagnostics
          )
        }
      : {}),
    ...(checkoutOpenDiagnostics ? { checkoutOpenDiagnostics } : {}),
    ...(Number.isInteger(result.checkoutCreationDiagnostics?.httpStatus)
      ? { httpStatus: result.checkoutCreationDiagnostics.httpStatus }
      : {})
  };
}
// Limit the complete JSON document, not a substring. Business verdicts and all
// stage summaries are immutable; only explicitly marked diagnostic detail shrinks.
const DIAGNOSTIC_MAX_BYTES = 24576;
function boundedReport(value) {
  const report = JSON.parse(JSON.stringify(value));
  delete report.diagnosticUploaded;
  const omitted = new Set(report.diagnosticsOmitted || []);
  report.diagnosticsTruncated = omitted.size > 0;
  report.diagnosticsOmitted = [...omitted];
  const over = () => Buffer.byteLength(JSON.stringify(report), 'utf8') > DIAGNOSTIC_MAX_BYTES;
  const mark = (group) => {
    omitted.add(group);
    report.diagnosticsTruncated = true;
    report.diagnosticsOmitted = [...omitted];
  };
  const trim = (owner, key, group, minimum = 0, preserve = () => false, changed = () => {}) => {
    if (!Array.isArray(owner?.[key])) return;
    const rows = owner[key];
    while (over() && rows.length > minimum) {
      const index = rows.findIndex((row, index) => !preserve(row, index, rows));
      if (index < 0) break;
      rows.splice(index, 1);
      changed();
      mark(group);
    }
  };
  const open = report.checkoutOpenDiagnostics,
    init = open?.initialization;
  trim(init, 'events', 'events', 0, undefined, () => {
    init.truncated = true;
  });
  trim(open, 'controls', 'control_details');
  trim(open?.exclusionProbe, 'rows', 'exclusion_rows', 0, undefined, () => {
    open.exclusionProbe.truncated = true;
    open.exclusionProbe.complete = false;
  });
  trim(init, 'criticalEvents', 'critical_events', 1, undefined, () => {
    init.criticalTruncated = true;
  });
  // Keep the newest pending request of every observed endpoint, including both
  // Stripe script and iframe categories; original counts remain untouched.
  trim(
    init,
    'pendingRequests',
    'pending_requests',
    0,
    (row, index, rows) => !rows.slice(index + 1).some((next) => next.endpoint === row.endpoint),
    () => {
      init.pendingRequestsTruncated = true;
    }
  );
  trim(
    init,
    'failureClasses',
    'failure_classes',
    1,
    (row, index, rows) =>
      index ===
      rows.reduce(
        (latest, item, i) => (item.lastElapsedMs >= rows[latest].lastElapsedMs ? i : latest),
        0
      ),
    () => {
      init.failureClassesTruncated = true;
    }
  );
  const lastStep = (row, index, rows) =>
    index === rows.length - 1 ||
    (['failed', 'read_failed'].includes(row.state) &&
      !rows.slice(index + 1).some((next) => ['failed', 'read_failed'].includes(next.state))) ||
    (row.state === 'pending' && !rows.slice(index + 1).some((next) => next.state === 'pending'));
  trim(open?.awaits, 'steps', 'await_steps', 1, lastStep);
  trim(report.formDiagnostics, 'steps', 'form_steps', 1, lastStep);
  for (const inspection of [open?.inspection, report.formDiagnostics?.inspection]) {
    trim(inspection, 'interactionChecks', 'control_details', 1);
    // At least the last failure of each existing attempt must survive trimming.
    trim(
      inspection,
      'readFailures',
      'control_details',
      1,
      (row, index, rows) =>
        [1, 2].includes(row.attempt) &&
        !rows.slice(index + 1).some((next) => next.attempt === row.attempt)
    );
  }
  if (over())
    throw Object.assign(new Error('诊断必需字段超过附件预算'), {
      code: 'DIAGNOSTIC_REPORT_TOO_LARGE'
    });
  return report;
}
async function automaticVerification(page, options) {
  if (current) current.pendingChallenge = true;
  if (process.env.HCAPTCHA_SOLVER_ENABLED === '0')
    throw Object.assign(new Error('自动验证未启用，已停止本次不付款验证'), {
      code: 'CHALLENGE_BLOCKED',
      challengeDetected: true,
      automaticAttempted: false,
      automaticResult: 'solver_disabled'
    });
  let verification;
  try {
    verification = await require('./upstream/human-verification').clearHumanVerification(page, {
      ...options,
      requireCheckoutReady: false,
      checkCheckoutLoad: false
    });
  } catch (error) {
    if (error?.code === 'LEASE_LOST' || options?.signal?.aborted) throw error;
    throw Object.assign(new Error('自动验证未完成，已停止本次不付款验证'), {
      code: 'CHALLENGE_BLOCKED',
      challengeDetected: true,
      automaticAttempted: true,
      automaticResult: error?.code === 'VERIFICATION_TIMEOUT' ? 'timeout' : 'failed'
    });
  }
  if (verification.sessionRequired === true && current) current.pendingChallenge = false;
  if (!verification.cleared)
    throw Object.assign(new Error('官网验证未完成，已停止本次不付款验证'), {
      code: verification.sessionRequired ? 'SESSION_INVALID' : 'CHALLENGE_BLOCKED',
      challengeDetected: verification.sessionRequired !== true,
      automaticAttempted: true,
      automaticResult: verification.sessionRequired
        ? 'session_invalid'
        : verification.code === 'VERIFICATION_TIMEOUT'
          ? 'timeout'
          : 'failed'
    });
  if (current) current.pendingChallenge = false;
  return { completed: true, automaticAttempted: true, automaticResult: 'cleared' };
}
function usesAutomaticVerification(callback) {
  return callback === automaticVerification;
}
async function buttonReady(page) {
  const locator = page.getByRole('button', {
    name: /^(?:Subscribe|订阅|Pay|Pay now|立即支付|Subscribe and pay|Upgrade to Pro|升级至 Pro)$/i
  });
  if ((await locator.count()) !== 1 || !(await locator.isVisible()) || !(await locator.isEnabled()))
    return false;
  await locator.scrollIntoViewIfNeeded({ timeout: 500 });
  return locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const hit = node.ownerDocument.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return box.width > 0 && box.height > 0 && (hit === node || node.contains(hit));
  });
}
async function prepare(
  page,
  {
    signal,
    store = require('./upstream/mysql-store'),
    form = require('./checkout-form.cjs'),
    payment = require('./upstream/stripe-payment')
  } = {}
) {
  let card;
  try {
    stage('card_readiness');
    card = await store.reserveCard(require('./rpc.cjs').scope().taskId);
    if (!card) throw Object.assign(new Error('缺少可用银行卡'), { code: 'INPUT_MISSING' });
    const info = { number: card.card_number, expiry: card.card_expiry, cvc: card.card_cvc };
    let address = card.billing_address;
    if (!address) {
      try {
        address = await require('./upstream/tax-free-address').pickBillingAddressForCheckout(
          null,
          card.address_id
        );
      } catch (error) {
        if (error.message === '缺少现有账单地址，请先为银行卡添加账单资料')
          error.code = 'INPUT_MISSING';
        throw error;
      }
    }
    const holder =
      card.card_holder || [address.firstName, address.lastName].filter(Boolean).join(' ');
    if (
      !holder ||
      !address.line1 ||
      !address.city ||
      !address.postal_code ||
      !(address.country || address.region)
    )
      throw Object.assign(new Error('缺少现有账单资料'), { code: 'INPUT_MISSING' });
    await payment.prepareCheckoutCardSection(page);
    const deadline = Date.now() + 120000;
    const check = async (read) => {
      const result = await read;
      if (!result.ok)
        throw Object.assign(new Error('付款前资料检查未完成'), {
          code: result.errorCode,
          missing: result.missing,
          inspection: result.inspection,
          formDiagnostics: result.formDiagnostics
        });
    };
    stage('card_fill');
    await check(form.fillCard(page, info, { deadline, signal }));
    stage('billing_fill');
    await check(form.fillBilling(page, address, holder, { deadline, signal }));
    // Billing changes may replace card controls; use the same existing recheck sequence.
    stage('card_fill');
    await check(form.fillCard(page, info, { deadline, signal }));
    stage('billing_fill');
    await check(form.fillBilling(page, address, holder, { deadline, signal }));
    stage('card_fill');
    if ((await form.verifyCard(page, info, { deadline })).length)
      throw Object.assign(new Error('卡片回读未通过'), { code: 'CHECKOUT_CARD_NOT_READY' });
    stage('button_ready');
    const ready = await buttonReady(page);
    if (!ready) throw Object.assign(new Error('付款按钮尚未就绪'), { code: 'BUTTON_NOT_READY' });
    return {
      success: true,
      debugOnly: true,
      validationOutcome: 'ready_before_payment',
      cardVerified: true,
      billingVerified: true,
      buttonReady: true,
      submitted: false
    };
  } finally {
    if (card) await store.releaseCard(card.id);
  }
}
function message(report) {
  const labels = {
    NONE: '卡号和账单已回读，付款按钮就绪，未提交付款',
    INPUT_MISSING: '所需资料缺失或已失效',
    PROXY_UNAVAILABLE: '代理检查未通过',
    BROWSER_PROFILE_UNAVAILABLE: '专用浏览器不可用',
    LOGIN_READ_FAILED: '登录页面读取失败',
    LOGIN_UNCONFIRMED: '登录状态未确认',
    NETWORK_READ_FAILED: '官网接口网络读取失败',
    CHECKOUT_REJECTED: '官网拒绝建单',
    CHECKOUT_CREATION_UNKNOWN: '建单响应未确认',
    PAYMENT_COMPONENT_NOT_LOADED: '支付组件未加载',
    CARD_NOT_READY: '卡号控件或填写未就绪',
    BILLING_FILL_FAILED: '账单填写或回读失败',
    BUTTON_NOT_READY: '付款按钮未就绪',
    READ_INCOMPLETE: '控件读取未完成',
    CHALLENGE_BLOCKED: '官网验证未完成',
    EXECUTOR_INTERRUPTED: '执行器中断',
    OTHER: '其他执行异常，详见诊断'
  };
  const codeLabels = {
    NETWORK_TIMEOUT: '官网接口网络读取超时',
    NETWORK_UNAVAILABLE: '官网接口网络连接或响应体读取失败',
    UPSTREAM_INVALID_RESPONSE: '官网订阅响应格式无效',
    PROXY_CONNECTION_FAILED: '代理连通性检测已用尽5次，仍未完成核验，已停止后续操作',
    PROFILE_IDENTITY_MISSING: '缺少账号及用户标识，不能复用浏览器会话',
    PROFILE_PROXY_INVALID: '代理绑定格式无效，未继续执行',
    PROFILE_BUSY: '同一账号与代理的浏览器正在使用，本次未继续',
    PROFILE_EXIT_CHANGED: '代理出口与浏览器会话绑定不一致，已停止；未切换代理',
    PROFILE_BINDING_INVALID: '浏览器出口绑定记录无效，已停止',
    PROFILE_DIRECTORY_INVALID: '浏览器会话目录无效，已停止',
    PROFILE_LAUNCH_FAILED: '专用浏览器启动未完成，请检查运行环境',
    PROFILE_CLEANUP_FAILED: '浏览器关闭未确认，会话尚未释放'
  };
  const failed = report.formDiagnostics?.steps?.findLast((row) => row.state === 'failed');
  const fieldLabel = {
    number: '卡号',
    expiry: '有效期',
    month: '有效月份',
    year: '有效年份',
    cvc: '安全码',
    country: '国家',
    line1: '街道',
    city: '城市',
    postal: '邮编',
    name: '账单姓名',
    state: '州省'
  }[failed?.field];
  const phaseLabel = {
    locate: '定位',
    precheck: '交互前检查',
    input: '输入',
    readback: '填写后回读'
  }[failed?.phase];
  const errorLabel = {
    timeout: '读取超时',
    closed: '页面已关闭',
    detached: '控件已脱离',
    context_destroyed: '页面执行环境已替换',
    aborted: '读取已取消',
    read_failed: '读取失败'
  }[failed?.errorClass];
  const detail =
    report.failureClass === 'READ_INCOMPLETE' && fieldLabel && phaseLabel
      ? `（${[fieldLabel, phaseLabel, errorLabel].filter(Boolean).join('／')}）`
      : '';
  const stopLabel =
    report.failureClass === 'READ_INCOMPLETE' &&
    report.checkoutOpenDiagnostics?.inspection?.lastReadFailure?.probe === 'load_precheck'
      ? '官网加载状态预检读取未完成'
      : codeLabels[report.failureCode] || labels[report.failureClass] || labels.OTHER;
  return report.failureClass === 'NONE'
    ? labels.NONE
    : `不付款验证已结束：${stopLabel}${detail}${report.httpStatus ? `（HTTP ${report.httpStatus}）` : ''}`;
}
module.exports = {
  boundedReport,
  DIAGNOSTIC_MAX_BYTES,
  message,
  enabled,
  start,
  stage,
  finish,
  classify,
  safeFormDiagnostics,
  automaticVerification,
  usesAutomaticVerification,
  prepare,
  buttonReady,
  STAGES,
  CLASSES,
  CODES
};
