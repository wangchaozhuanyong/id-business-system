'use strict';
const PLAN_NAMES = {
  plus: ['plus', 'chatgptplus', 'chatgptplusplan'],
  pro_5x: ['pro_5x', 'pro5x', 'chatgptprolite'],
  pro_20x: ['pro_20x', 'pro20x', 'chatgptpro']
};
function evaluateSubscription(targetPlan, expectedAccountId, result) {
  const data = result?.data || {};
  const observedPlan = String(data.rawPlan || '')
    .trim()
    .toLowerCase();
  const observedAccountId = String(data.upstreamAccountId || '');
  const names = PLAN_NAMES[targetPlan] || [];
  const verified =
    result?.ok === true &&
    data.hasActiveSubscription === true &&
    Boolean(expectedAccountId) &&
    observedAccountId === expectedAccountId &&
    names.includes(observedPlan);
  return {
    verified,
    querySucceeded: result?.ok === true,
    hasActiveSubscription: data.hasActiveSubscription === true,
    source: 'subscription',
    accountId: observedAccountId,
    expectedAccountId,
    targetPlan,
    observedPlan,
    queriedAt: data.queriedAt || null
  };
}
async function confirmSubscription(targetPlan, token, injected = {}) {
  const expectedAccountId =
    require('./upstream/session-auth').extractProfileFromToken(token).accountId || '';
  const query =
    injected.query || require('./upstream/subscription-check').querySubscriptionBySession;
  const result = await query(token, { timezoneOffsetMin: 480 });
  return evaluateSubscription(targetPlan, expectedAccountId, result);
}
async function preflightPayment(targetPlan, token, injected = {}) {
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
      error: '付款前账号或套餐核验未通过，本次未提交付款'
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
  return { allowed: true, alreadyActive: false, confirmation };
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
      result = await query(token, { timezoneOffsetMin: payload.timezoneOffsetMin ?? 480 });
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
  return {
    success: confirmation.verified,
    confirmedPaid: confirmation.verified,
    resultUnknown: !confirmation.verified,
    confirmation,
    recheckTaskId: payload.recheckTaskId || null,
    providerOrderId: payload.providerOrderId || null,
    providerTaskId: payload.providerTaskId || null
  };
}
module.exports = {
  evaluateSubscription,
  confirmSubscription,
  preflightPayment,
  recheck,
  PLAN_NAMES
};
