'use strict';
const path = require('node:path');
const { configureTask, rpc, clearTask, wasSubmitted, ResultUnknownError } = require('./rpc.cjs');
const {
  rememberSecrets,
  installSafeConsole,
  sanitizeResult,
  clearSensitive,
  clearSecrets
} = require('./security.cjs');
const send = (item) => {
  if (process.connected) process.send(item);
};
async function execute(task, cfg) {
  const store = require('./upstream/mysql-store');
  const payload = task.payload || {};
  const session = require('./upstream/session-auth');
  const token = session.extractAccessTokenFromRaw(task.session || '');
  const progress = (progress, stage, message, extra = {}) =>
    rpc('progress', { progress, stage, message, ...extra });
  switch (task.operation) {
    case 'recharge':
      if (task.provider === 'third_party')
        return require('./third-party.cjs').executeThirdParty(task, cfg, { progress });
      return require('./upstream/index').run({ paymentLimit: payload.paymentLimit });
    case 'debug':
      return require('./upstream/index').run({
        paymentLimit: payload.paymentLimit,
        unpaidValidation: require('./unpaid-validation.cjs').enabled(task)
      });
    case 'subscription':
      if (payload.recheckTaskId)
        return require('./confirmation.cjs').recheck(task, cfg, { sessionRaw: task.session });
      return require('./upstream/subscription-check').querySubscriptionBySession(token, {
        timezoneOffsetMin: payload.timezoneOffsetMin ?? 480,
        sessionRaw: task.session,
        allowBrowserFallback: true,
        ...(payload.queryTransportMode === 'transport_compare'
          ? { queryTransportMode: 'transport_compare' }
          : {})
      });
    case 'renewal': {
      if (payload.action === 'check')
        return require('./upstream/subscription-check').querySubscriptionBySession(token, {
          timezoneOffsetMin: payload.timezoneOffsetMin ?? 480,
          sessionRaw: task.session,
          allowBrowserFallback: true
        });
      const method = payload.action === 'enable' ? 'resumeAutoRenew' : 'cancelAutoRenew';
      const result = await require('./upstream/subscription-check')[method](token, {
        timezoneOffsetMin: payload.timezoneOffsetMin ?? 480,
        sessionRaw: task.session,
        allowBrowserFallback: true
      });
      if (result.resultUnknown || (!result.ok && wasSubmitted()))
        throw new ResultUnknownError('续费变更结果未能确认');
      require('./rpc.cjs').recordKnownOutcome();
      return result;
    }
    case 'proxy_test': {
      const probe = require('./proxy-test.cjs');
      const results = [];
      for (const proxyId of probe.selectedIds(task)) {
        let result;
        try {
          const proxy = await store.getActiveProxy(proxyId);
          result = await probe.testProxyUrl(proxy);
        } catch (error) {
          if (error.code === 'LEASE_LOST') throw error;
          result = probe.failure(probe.errorCode(error));
        }
        try {
          await rpc('proxyTestResult', { proxyId, ...result });
        } catch (error) {
          if (error.code === 'LEASE_LOST') throw error;
          throw Object.assign(new Error('检测结果回写未能确认'), {
            code: 'result_write_failed',
            proxyResults: [...results, { ...result, proxyId }]
          });
        }
        results.push({ ...result, proxyId });
      }
      return { success: results.length > 0 && results.every((r) => r.ok), results };
    }
    case 'config_test': {
      const target = payload.target || payload.kind;
      if (target === 'solver')
        return require('./upstream/hcaptcha-solver').checkHcaptchaSolverHealth();
      if (target === 'vlm')
        return require('./upstream/hcaptcha-solver').testVlmConnectivity(cfg.hcaptcha);
      if (target === 'captcha_platform')
        return require('./upstream/captcha-platform').testCaptchaPlatformConnectivity({
          apiKey: cfg.hcaptcha.platform_api_key,
          apiUrl: cfg.hcaptcha.platform_api_url
        });
      if (target === 'gpt_api')
        return require('./upstream/gpt-api-client').testConnection(cfg.gptApi);
      if (target === 'gpt_status') {
        const client = require('./upstream/gpt-api-client');
        const [plans, balance] = await Promise.all([
          client.fetchPlans(cfg.gptApi),
          client.queryBalance(cfg.gptApi)
        ]);
        return { success: plans.success && balance.success, plans, balance };
      }
      if (target === 'telegram')
        return require('./upstream/telegram-notify').sendTelegramTest(
          { getTelegramConfig: async () => cfg.telegram },
          { jobKey: task.id }
        );
      if (target === 'solver_logs')
        return rpc('getSolverLogs', { limit: Math.min(500, Number(payload.limit || 100)) });
      throw new Error('不支持的配置检测');
    }
    case 'notification': {
      const event = payload.event;
      if (
        ![
          'success',
          'failure',
          'card_pool_empty',
          'admin_login_success',
          'admin_login_failed',
          'admin_2fa_failed',
          'admin_secondary_success'
        ].includes(event)
      )
        throw new Error('不支持的通知事件');
      return require('./upstream/telegram-notify').dispatchTelegramNotification(
        cfg.telegram,
        event,
        {
          jobKey: task.id,
          cdk: task.code ? `…${task.code.slice(-4)}` : '',
          ip: payload.maskedIp || '',
          message: payload.message
            ? require('./security.cjs').redactText(payload.message)
            : '线上代充任务状态已更新'
        }
      );
    }
    default:
      throw new Error('不支持的执行任务');
  }
}
async function runTask(task) {
  configureTask(task);
  const validation = require('./unpaid-validation.cjs').enabled(task)
    ? require('./unpaid-validation.cjs')
    : null;
  validation?.start(send);
  rememberSecrets(task);
  rememberSecrets(task.code, 'secret');
  rememberSecrets(process.env.ONLINE_RECHARGE_WORKER_KEY, 'secret');
  installSafeConsole((log) => send({ type: 'log', log }));
  let config;
  let phase = 'runtime_config';
  let executionStarted = false;
  try {
    config = await rpc('getRuntimeConfig');
    rememberSecrets(config);
    const hcaptcha = {
      ...config.hcaptcha,
      enabled: config.hcaptcha?.solver_enabled,
      cdp_port: process.env.CDP_PORT || config.hcaptcha?.cdp_port,
      no_vlm: config.hcaptcha?.solver_no_vlm,
      captcha_platform_api_key: config.hcaptcha?.platform_api_key,
      captcha_platform_api_url: config.hcaptcha?.platform_api_url,
      captcha_platform_timeout: config.hcaptcha?.platform_timeout
    };
    phase = 'proxy';
    validation?.stage('proxy');
    const proxy = ['recharge', 'debug', 'subscription', 'renewal'].includes(task.operation)
      ? (await require('./upstream/mysql-store').getActiveProxy()) || ''
      : '';
    phase = 'environment';
    Object.assign(
      process.env,
      require('./upstream/hcaptcha-runtime').buildHcaptchaEnvFromConfig(hcaptcha).env,
      {
        JOB_KEY: task.id,
        CHATGPT_SESSION_JSON: task.session || '',
        CHATGPT_TOKEN: require('./upstream/session-auth').extractAccessTokenFromRaw(
          task.session || ''
        ),
        CDK_CODE: task.code || '',
        CDK_PLAN_TYPE: task.plan || 'plus',
        PLAN_NAME_OVERRIDE: task.payload?.planName || config.planNames?.[task.plan] || '',
        PAYMENT_REGION_OVERRIDE:
          config.planRegion?.paymentRegion || task.payload?.region || config.region || 'PH',
        PLAN_REGION_EXPECTED_CURRENCY:
          config.planRegion?.policy === 'plan' ? config.planRegion.expectedCurrency : '',
        PAYMENT_MAX_CARD_ATTEMPTS: String(config.paymentMaxCardAttempts || 3),
        CHECKOUT_MODE: config.checkoutMode || 'api',
        CHECKOUT_DEBUG_ONLY: task.operation === 'debug' ? '1' : '0',
        HEADFUL: config.headful ? '1' : '0',
        RECORD_VIDEO: '0',
        PROXY: proxy,
        HCAPTCHA_SOLVER_OUT_DIR: path.join(
          process.env.ONLINE_RECHARGE_RUNTIME_DIR || path.join(__dirname, 'runtime', task.id),
          'solver'
        )
      }
    );
    phase = 'execution';
    executionStarted = true;
    let result = await execute(task, config);
    if (validation) {
      if (wasSubmitted() || require('./rpc.cjs').wasPaymentConfirmed())
        throw new ResultUnknownError('不付款模式提交状态异常，必须核对');
      const validationReport = validation.finish(result);
      result = {
        ...result,
        validationReport,
        success: validationReport.outcome === 'ready_before_payment',
        pendingCredentials: false,
        resultUnknown: false,
        error: validation.message(validationReport)
      };
    }
    if (require('./rpc.cjs').taskSignal().aborted) return;
    if (task.operation === 'recharge' && !result?.resultUnknown && !result?.pendingCredentials) {
      const event = result?.success
        ? 'success'
        : result?.cardPoolEmpty
          ? 'card_pool_empty'
          : 'failure';
      await require('./upstream/telegram-notify')
        .dispatchTelegramNotification(config.telegram, event, {
          jobKey: task.id,
          cdk: task.code ? `…${task.code.slice(-4)}` : '',
          cardLast4: result?.cardLast4 || '',
          message: result?.success ? '充值已完成' : '充值执行未完成'
        })
        .catch(() => {});
    }
    require('./rpc.cjs').taskSignal().throwIfAborted();
    const status = result?.pendingCredentials
      ? 'pending_credentials'
      : result?.resultUnknown
        ? 'awaiting_review'
        : result?.success === false ||
            result?.ok === false ||
            result?.ready === false ||
            (result?.sent === 0 && !result?.skipped)
          ? 'failed'
          : 'succeeded';
    send({
      type: 'result',
      status,
      result: sanitizeResult(result),
      message:
        validation && result?.validationReport
          ? validation.message(result.validationReport)
          : status === 'succeeded'
            ? '执行完成'
            : status === 'awaiting_review'
              ? '外部结果待核对，禁止重试'
              : status === 'pending_credentials'
                ? '等待补齐本次临时安全码'
                : '执行未完成'
    });
  } catch (error) {
    // Cancellation has no business outcome. The parent/server lease recovery
    // retains the original payment state instead of persisting a guessed failure.
    if (require('./rpc.cjs').taskSignal().aborted) return;
    const proxyFailure =
      task.operation === 'proxy_test' ? require('./proxy-test.cjs').taskFailure(task, error) : null;
    // Preparation failures must also reach the proxy row while this task still owns its lease.
    // A failed result acknowledgement is not permission to overwrite the actual probe outcome.
    if (proxyFailure && !executionStarted && error.code !== 'LEASE_LOST')
      for (const result of proxyFailure.results) {
        try {
          await rpc('proxyTestResult', result);
        } catch {
          break;
        }
      }
    // installSafeConsole redacts registered credentials and sensitive text
    // before sending this diagnostic to the parent or persisted task log.
    console.error(
      '[执行异常]',
      phase,
      error?.name || 'Error',
      error?.code || '',
      error?.message || '执行未完成'
    );
    send({
      type: 'result',
      status:
        error.code === 'PENDING_CREDENTIALS' && !validation
          ? 'pending_credentials'
          : wasSubmitted() ||
              require('./rpc.cjs').wasPaymentConfirmed() ||
              error.code === 'RESULT_UNKNOWN'
            ? 'awaiting_review'
            : 'failed',
      result:
        proxyFailure ||
        sanitizeResult({
          code: error.code || 'EXECUTION_FAILED',
          phase,
          ...(validation && !wasSubmitted() && !require('./rpc.cjs').wasPaymentConfirmed()
            ? { validationReport: validation.finish(error) }
            : {})
        }),
      message: proxyFailure ? proxyFailure.error : '执行未完成，请查看受限诊断'
    });
  } finally {
    require('./upstream/mysql-store').clearCredentials();
    clearSensitive(task);
    clearSensitive(config);
    clearSecrets();
    clearTask();
    for (const key of Object.keys(process.env))
      if (/CHATGPT_|CDK_CODE|PROXY|API_KEY|WORKER_KEY|PLAN_REGION_EXPECTED_CURRENCY/.test(key))
        delete process.env[key];
  }
}
if (require.main === module) {
  const stop = () => {
    require('./rpc.cjs').abortTask();
    // Allow cancellation listeners to terminate solvers before this task process exits.
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.once('disconnect', stop);
  process.once('message', (message) => {
    runTask(message.task).finally(() => setTimeout(() => process.exit(0), 20));
  });
}
module.exports = { runTask, execute };
