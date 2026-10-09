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
async function recheck(task, cfg, injected = {}) {
  const payload = task.payload || {};
  const token = require('./upstream/session-auth').extractAccessTokenFromRaw(task.session || '');
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
module.exports = { evaluateSubscription, confirmSubscription, recheck, PLAN_NAMES };
