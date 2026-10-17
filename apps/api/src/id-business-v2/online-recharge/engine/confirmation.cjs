'use strict';
const { PLAN_NAMES, assertPlan, observedCanonicalPlan, classifyChange } = require('./plans.cjs');
function providerOrderReceipt(provider) {
  const data = provider.data || {};
  const id = (value) => {
    const text =
      typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : '';
    return /^[A-Za-z0-9:_-]{1,190}$/.test(text) ? text : null;
  };
  const amount =
    data.payment?.actual_paid_amount ?? data.result?.actual_paid_amount ?? data.actual_paid_amount;
  const currency = data.payment?.paid_currency ?? data.result?.paid_currency ?? data.paid_currency;
  return {
    order_id: id(data.order_id ?? data.order?.id),
    task_id: id(data.task_id ?? data.task?.id),
    status: provider.rawStatus,
    result: { ok: data.result?.ok !== false },
    ...(typeof amount === 'string' && /^\d{1,14}(\.\d{1,4})?$/.test(amount)
      ? { actual_paid_amount: amount }
      : {}),
    ...(typeof currency === 'string' && /^[A-Z]{3}$/.test(currency)
      ? { paid_currency: currency }
      : {})
  };
}
function evaluateSubscription(targetPlan, expectedAccountId, result, options = {}) {
  const data = result?.data || {};
  const observedPlan = String(data.rawPlan || '')
    .trim()
    .toLowerCase();
  const observedAccountId = String(data.upstreamAccountId || '');
  const canonicalPlan = observedCanonicalPlan(observedPlan, options);
  const verified =
    result?.ok === true &&
    data.hasActiveSubscription === true &&
    Boolean(expectedAccountId) &&
    observedAccountId === expectedAccountId &&
    canonicalPlan === targetPlan;
  return {
    verified,
    querySucceeded: result?.ok === true,
    ...(result?.ok === false ? { queryErrorCode: result.errorCode, queryError: result.error } : {}),
    hasActiveSubscription: data.hasActiveSubscription === true,
    source: 'subscription',
    accountId: observedAccountId,
    expectedAccountId,
    targetPlan,
    observedPlan,
    observedCanonicalPlan: canonicalPlan,
    tierVerified: Boolean(canonicalPlan),
    ...(typeof data.expiresAt === 'string' ? { expiresAt: data.expiresAt } : {}),
    currency:
      result?.ok === true &&
      Boolean(expectedAccountId) &&
      observedAccountId === expectedAccountId &&
      /^[A-Z]{3}$/.test(
        String(data.currency || '')
          .trim()
          .toUpperCase()
      )
        ? String(data.currency).trim().toUpperCase()
        : null,
    queriedAt: data.queriedAt || null
  };
}
function resolvePaymentCurrency(preflight, configuredCurrency, { debugOnly = false } = {}) {
  const expected = String(process.env.PLAN_REGION_EXPECTED_CURRENCY || '');
  const checked = (currency) => {
    if (expected && currency !== expected)
      throw new Error(
        `套餐地区要求 ${expected}，官网原订阅币种为 ${currency || '未知'}，本次未提交付款`
      );
    return currency;
  };
  if (preflight?.allowed !== true || !['initial', 'upgrade'].includes(preflight.kind))
    throw new Error('付款前账号或套餐核验未通过');
  if (preflight.kind === 'initial') return checked(configuredCurrency);
  const confirmation = preflight.confirmation;
  const currency = confirmation?.currency;
  if (
    confirmation?.querySucceeded === true &&
    confirmation.expectedAccountId &&
    confirmation.accountId === confirmation.expectedAccountId &&
    /^[A-Z]{3}$/.test(String(currency || ''))
  )
    return checked(currency);
  if (debugOnly && !expected) return null;
  throw new Error('无法核实原订阅币种，本次未提交付款');
}
async function confirmSubscription(targetPlan, token, injected = {}) {
  const expectedAccountId =
    require('./upstream/session-auth').extractProfileFromToken(token).accountId || '';
  const query =
    injected.query || require('./upstream/subscription-check').querySubscriptionBySession;
  const result = await query(token, {
    timezoneOffsetMin: 480,
    ...(injected.browserContext ? { browserContext: injected.browserContext } : {}),
    ...(injected.sessionRaw ? { sessionRaw: injected.sessionRaw, allowBrowserFallback: true } : {})
  });
  return evaluateSubscription(targetPlan, expectedAccountId, result, {
    pro500Name:
      injected.pro500Name || (targetPlan === 'pro_500' ? process.env.PLAN_NAME_OVERRIDE : '')
  });
}
async function preflightPayment(targetPlan, token, injected = {}) {
  try {
    assertPlan(targetPlan);
  } catch (error) {
    return { allowed: false, alreadyActive: false, error: error.message };
  }
  const pro500Name = String(injected.pro500Name || process.env.PLAN_NAME_OVERRIDE || '').trim();
  if (
    targetPlan === 'pro_500' &&
    observedCanonicalPlan(pro500Name, { pro500Name }) !== 'pro_500' &&
    injected.allowUnverifiedTarget !== true
  )
    return {
      allowed: false,
      alreadyActive: false,
      error: 'Pro 500 的准确订阅标识尚未核实，请先完成付款前调试并核实配置；本次未提交付款'
    };
  let confirmation;
  let activeSubscription;
  try {
    const query =
      injected.query || require('./upstream/subscription-check').querySubscriptionBySession;
    confirmation = await confirmSubscription(targetPlan, token, {
      ...injected,
      query: async (...args) => {
        const result = await query(...args);
        activeSubscription = result?.data?.hasActiveSubscription;
        return result;
      }
    });
  } catch (error) {
    if (error.code === 'LEASE_LOST') throw error;
    return {
      allowed: false,
      alreadyActive: false,
      error: '付款前无法核实原账号套餐，本次未提交付款'
    };
  }
  if (
    !confirmation.querySucceeded ||
    !confirmation.expectedAccountId ||
    confirmation.accountId !== confirmation.expectedAccountId ||
    typeof activeSubscription !== 'boolean' ||
    (!confirmation.observedPlan && activeSubscription !== false)
  ) {
    return {
      allowed: false,
      alreadyActive: false,
      confirmation,
      error: confirmation.queryError
        ? `${confirmation.queryError}；本次未提交付款`
        : '付款前账号或套餐核验未通过，本次未提交付款'
    };
  }
  if (confirmation.verified) {
    return {
      allowed: false,
      alreadyActive: true,
      confirmation,
      error: '账号已是目标套餐，本次未提交付款，无需重复充值'
    };
  }
  return {
    alreadyActive: false,
    confirmation,
    ...classifyChange(targetPlan, confirmation, activeSubscription)
  };
}

async function recheck(task, cfg, injected = {}) {
  const payload = task.payload || {};
  const token = require('./upstream/session-auth').extractAccessTokenFromRaw(task.session || '');
  if (payload.originalOperation === 'renewal') {
    const expectedAccountId =
      require('./upstream/session-auth').extractProfileFromToken(token).accountId || '';
    const action = payload.renewalAction;
    const unknown = {
      success: false,
      renewalVerified: false,
      confirmedPaid: false,
      resultUnknown: true,
      recheckTaskId: payload.recheckTaskId || null
    };
    if (!expectedAccountId || !['enable', 'disable'].includes(action))
      return { ...unknown, error: '原续费变更资料不完整，禁止重新提交' };
    const query =
      injected.query || require('./upstream/subscription-check').querySubscriptionBySession;
    let result;
    try {
      result = await query(token, {
        timezoneOffsetMin: payload.timezoneOffsetMin ?? 480,
        ...(injected.sessionRaw
          ? { sessionRaw: injected.sessionRaw, allowBrowserFallback: true }
          : {})
      });
    } catch (error) {
      if (error.code === 'LEASE_LOST') throw error;
      return { ...unknown, error: '原续费变更结果仍待核对' };
    }
    const verified =
      result?.ok === true &&
      result.data?.upstreamAccountId === expectedAccountId &&
      result.data?.autoRenewRaw === (action === 'enable');
    return {
      ...unknown,
      success: verified,
      renewalVerified: verified,
      resultUnknown: !verified,
      data: result?.data || {},
      ...(verified ? {} : { error: '原续费变更结果仍待核对' })
    };
  }
  const targetPlan = payload.targetPlan || task.plan;
  let provider = null;
  if ((payload.originalProvider || task.provider) === 'third_party') {
    const client = injected.client || require('./upstream/gpt-api-client');
    if (!payload.providerOrderId && !payload.providerTaskId)
      return { success: false, resultUnknown: true, error: '原单编号缺失，禁止重新提交' };
    provider = payload.providerTaskId
      ? await client.queryTask(cfg.gptApi, payload.providerTaskId)
      : null;
    if (!provider?.success || !provider.rawStatus)
      provider = await client.queryOrder(cfg.gptApi, payload.providerOrderId);
    if (!provider?.success || !require('./outcomes.cjs').isTerminalGptApiStatus(provider.rawStatus))
      return { success: false, resultUnknown: true, error: '原单仍待核对' };
    const identity = provider.data?.order_id || provider.data?.order?.id;
    const taskIdentity = provider.data?.task_id || provider.data?.task?.id;
    if (
      (!identity && !taskIdentity) ||
      (identity && String(identity) !== String(payload.providerOrderId)) ||
      (taskIdentity && String(taskIdentity) !== String(payload.providerTaskId))
    )
      return { success: false, resultUnknown: true, error: '原单身份不一致' };
  }
  const confirmation = await confirmSubscription(targetPlan, token, injected);
  if (
    provider &&
    (!require('./outcomes.cjs').isSuccessGptApiStatus(provider.rawStatus) ||
      provider.data?.result?.ok === false)
  ) {
    const definitiveFailure =
      confirmation.querySucceeded &&
      Boolean(confirmation.expectedAccountId) &&
      confirmation.accountId === confirmation.expectedAccountId &&
      !confirmation.verified &&
      (!confirmation.hasActiveSubscription ||
        Object.values(PLAN_NAMES).flat().includes(confirmation.observedPlan));
    return {
      success: false,
      definitiveFailure,
      confirmedPaid: false,
      providerFinalStatus: 'failed',
      resultUnknown: !definitiveFailure,
      confirmation,
      recheckTaskId: payload.recheckTaskId || null,
      providerOrderId: payload.providerOrderId || null,
      providerTaskId: payload.providerTaskId || null
    };
  }
  const context = payload.paymentContext;
  const evidence = payload.originalPaymentEvidence;
  const decimal = (value) => {
    const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(String(value ?? ''));
    return match ? BigInt(match[1]) * 10000n + BigInt((match[2] || '').padEnd(4, '0')) : null;
  };
  const evidenceMatches =
    context &&
    evidence?.verified === true &&
    ['checkout', 'subscription_change'].includes(evidence.source) &&
    ['kind', 'sourcePlan', 'targetPlan', 'accountId', 'cardId', 'cardLast4', 'currency'].every(
      (key) => evidence[key] === context[key]
    ) &&
    (!context.quoteId || context.quoteId === evidence.quoteId) &&
    decimal(context.amount) !== null &&
    decimal(context.amount) === decimal(evidence.amount);
  const verified = confirmation.verified && (!context || evidenceMatches);
  return {
    success: Boolean(verified),
    confirmedPaid: Boolean(verified && (!context || decimal(context.amount) > 0n)),
    ...(context
      ? {
          subscriptionChangedVerified: confirmation.verified,
          paymentEvidence: evidenceMatches ? evidence : undefined
        }
      : {}),
    resultUnknown: !verified,
    ...(context && !evidenceMatches
      ? { error: '已核对订阅，但缺少对应原单的实际付款证据，请继续核对原单' }
      : {}),
    confirmation,
    recheckTaskId: payload.recheckTaskId || null,
    // Keep only bounded order facts from the read-only original provider receipt.
    // Payment and subscription success conditions above remain authoritative.
    ...(verified && provider ? { providerResult: providerOrderReceipt(provider) } : {}),
    providerOrderId: payload.providerOrderId || null,
    providerTaskId: payload.providerTaskId || null
  };
}
module.exports = {
  evaluateSubscription,
  confirmSubscription,
  preflightPayment,
  resolvePaymentCurrency,
  recheck,
  PLAN_NAMES
};
