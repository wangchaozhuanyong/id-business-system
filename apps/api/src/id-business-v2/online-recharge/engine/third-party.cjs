'use strict';
const { isSuccessGptApiStatus, isTerminalGptApiStatus } = require('./outcomes.cjs');
const { beforeExternalSubmit, ResultUnknownError, scope, wasSubmitted } = require('./rpc.cjs');
const { sanitize, clearSensitive } = require('./security.cjs');
async function executeThirdParty(task, cfg, injected = {}) {
  const client = injected.client || require('./upstream/gpt-api-client');
  const store = injected.store || require('./upstream/mysql-store');
  const progress = injected.progress || (() => Promise.resolve());
  const pause = injected.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const beforeSubmit = injected.beforeSubmit || beforeExternalSubmit;
  let card = null;
  const session = typeof task.session === 'string' ? JSON.parse(task.session) : task.session;
  try {
    if (cfg.gptApi?.enabled === false) return { success: false, error: '第三方代充路径未启用' };
    await progress(10, 'session_check', '正在检查会话');
    const planKey = { pro_5x: 'pro5x', pro_20x: 'pro20x' }[task.plan] || task.plan;
    const inspect = await client.inspectPay(cfg.gptApi, { planKey, session });
    if (!inspect.success || inspect.data?.ok === false)
      return { success: false, error: '会话预检未通过' };
    card = await store.reserveCard(scope().taskId || task.id, []);
    if (!card) return { success: false, error: '银行卡池暂无可用资源', cardPoolEmpty: true };
    const expiry = String(card.card_expiry).split('/');
    const newCard = {
      number: card.card_number,
      exp_month: Number(expiry[0]),
      exp_year: Number(`20${expiry[1].slice(-2)}`),
      cvc: card.card_cvc,
      name: card.card_holder || 'API User',
      country: cfg.gptApi.country || 'PH'
    };
    const proxy = await store.getActiveProxy();
    await progress(20, 'order_submit', '正在提交代充订单');
    await beforeSubmit({
      provider: 'third_party',
      stage: 'order_submit',
      cardId: card.id,
      cardLeaseId: card.leaseId,
      cardLeaseVersion: card.leaseVersion
    });
    let submit;
    try {
      submit = await client.submitPay(cfg.gptApi, {
        planKey: { pro_5x: 'pro5x', pro_20x: 'pro20x' }[task.plan] || task.plan,
        session,
        country: cfg.gptApi.country,
        currency: cfg.gptApi.currency,
        newCard,
        proxy,
        clientRef: task.code ? `kc-cdk-${task.code}-${task.id}` : `kc-task-${task.id}`,
        idempotencyKey: task.code ? `cdk-${task.code}` : `task-${task.id}`
      });
    } finally {
      clearSensitive(newCard);
    }
    if (!submit.success) {
      // Transport loss/timeout and 5xx cannot prove that the provider rejected the order.
      if (
        ![400, 401, 403, 422].includes(submit.status) ||
        submit.orderId ||
        submit.taskId ||
        submit.data?.order_id ||
        submit.data?.task_id ||
        submit.data?.already_submitted
      )
        throw new ResultUnknownError();
      require('./rpc.cjs').recordKnownOutcome();
      return {
        success: false,
        definitiveFailure: true,
        error: '供应商明确拒绝本次提交',
        providerStatus: submit.status
      };
    }
    const orderId = submit.orderId || submit.taskId || submit.id;
    const taskId = submit.taskId || null;
    if (!orderId) throw new ResultUnknownError('供应商受理后未返回订单号，等待核对');
    await progress(35, 'provider_poll', '供应商已受理，等待处理结果', {
      providerOrderId: orderId,
      providerTaskId: taskId
    });
    const maxPolls = Math.max(
      1,
      Number(cfg.gptApiMaxPolls || process.env.GPT_API_MAX_POLLS || 120)
    );
    for (let poll = 1; poll <= maxPolls; poll++) {
      await pause(
        Math.max(
          1,
          Number(cfg.gptApiPollIntervalMs || process.env.GPT_API_POLL_INTERVAL_MS || 5000)
        )
      );
      let out = taskId ? await client.queryTask(cfg.gptApi, taskId) : null;
      if (!out?.success || !out.rawStatus) out = await client.queryOrder(cfg.gptApi, orderId);
      if (!out?.success) continue;
      if (!isTerminalGptApiStatus(out.rawStatus)) {
        await progress(Math.min(95, 40 + poll), 'provider_poll', '供应商仍在处理');
        continue;
      }
      const business = out.data?.result || {};
      if (isSuccessGptApiStatus(out.rawStatus) && business.ok !== false) {
        const identity = out.data?.order_id || out.data?.order?.id;
        const taskIdentity = out.data?.task_id || out.data?.task?.id;
        if (
          (identity && String(identity) !== String(orderId)) ||
          (taskIdentity && String(taskIdentity) !== String(taskId))
        )
          throw new ResultUnknownError('供应商返回的原单身份不一致');
        const token = require('./upstream/session-auth').extractAccessTokenFromRaw(
          task.session || ''
        );
        const confirmation = injected.confirm
          ? await injected.confirm(task, out)
          : await require('./confirmation.cjs').confirmSubscription(task.plan, token);
        if (!confirmation.verified)
          return {
            success: false,
            resultUnknown: true,
            confirmation,
            providerOrderId: orderId,
            providerTaskId: taskId
          };
        const cardLast4 = String(card.card_number || '').slice(-4);
        require('./rpc.cjs').recordKnownOutcome('success');
        await store.recordCardUsage(card.id);
        return {
          success: true,
          confirmedPaid: true,
          confirmation,
          providerOrderId: orderId,
          providerTaskId: taskId,
          providerResult: sanitize(out.data),
          cardLast4
        };
      }
      const decline = String(business.error || out.data?.error || '').toLowerCase();
      if (require('./upstream/payment-retry').isPaymentDeclined(decline))
        await store.recordCardDecline(card.id);
      else require('./rpc.cjs').recordKnownOutcome();
      await store.releaseCard(card.id);
      return {
        success: false,
        definitiveFailure: true,
        providerOrderId: orderId,
        providerTaskId: taskId,
        providerResult: sanitize(out.data),
        error: '供应商返回失败结果'
      };
    }
    throw new ResultUnknownError('供应商订单仍未确认，等待人工核对');
  } catch (error) {
    if (error.code === 'PENDING_CREDENTIALS') return { success: false, pendingCredentials: true };
    if (error.code === 'RESULT_UNKNOWN' || wasSubmitted())
      return { success: false, resultUnknown: true, error: '外部执行结果待核对' };
    throw error;
  } finally {
    if (card?.id && !wasSubmitted() && !require('./rpc.cjs').wasPaymentConfirmed())
      await store.releaseCard(card.id).catch(() => {});
    clearSensitive(card);
    clearSensitive(session);
  }
}
module.exports = { executeThirdParty };
