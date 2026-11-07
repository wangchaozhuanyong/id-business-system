import { setTimeout as sleep } from 'node:timers/promises';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { signRechargeAssertion } from '../assertion.mjs';
import { validateRuntimeOrigin } from '../codexdaichong/runtime-health.mjs';
import { rechargeWorkerPrefix, signRechargeWorkerRequest } from './loopback-bridge.mjs';

const actor = Object.freeze({
  id: 'vendure-recharge-executor', email: 'vendure-worker@localhost', admin: false, sensitive: false
});
const jobIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
// Public task messages from the pinned engine are often just “正在开通中”.
// Do not infer card entry or payment success from percentages or raw diagnostics.
export function originalRechargeStage(message) {
  const value = typeof message === 'string' ? message.trim() : '';
  const stages = new Map([
    ['正在填写支付资料', 'payment_details'], ['正在填写银行卡信息', 'payment_details'],
    ['正在填写账单资料', 'payment_details'], ['正在付款', 'paying'],
    ['正在执行付款', 'paying'], ['付款成功', 'paid'], ['支付成功', 'paid'],
    ['正在确认订阅', 'subscription_check'], ['正在核对订阅状态', 'subscription_check']
  ]);
  return stages.get(value.replace(/[。.!！…]+$/, '')) ?? 'processing';
}

async function requestJson(url, options, timeout) {
  const response = await fetch(url, {
    ...options, redirect: 'error', signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return { response };
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 131072) throw new Error('代充服务回执超过限制');
    chunks.push(chunk);
  }
  return { response, data: JSON.parse(Buffer.concat(chunks)) };
}

export function createVendureCodexdaichongWorker({
  bridgeUrl, upstreamUrl, workerSecret, upstreamSecret, timeoutMs = 5000, pollIntervalMs = 2000
}) {
  const bridge = validateRuntimeOrigin(bridgeUrl);
  const upstream = validateRuntimeOrigin(upstreamUrl);
  if (bridge === upstream || ![workerSecret, upstreamSecret].every((value) =>
      typeof value === 'string' && Buffer.byteLength(value) >= 32) || workerSecret === upstreamSecret)
    throw new TypeError('商城任务和代充上游需要独立回环地址及独立服务凭据');
  if (![timeoutMs, pollIntervalMs].every((value) => Number.isInteger(value) && value > 0 && value <= 10_000))
    throw new TypeError('请求和轮询时长无效');

  const upstreamRequest = (path, body, clientIp) => {
    const method = body === undefined ? 'GET' : 'POST';
    return requestJson(upstream + path, {
      method,
      headers: {
        'x-id-recharge-assertion': signRechargeAssertion(upstreamSecret, method, path,
          isIP(clientIp ?? '') ? { ...actor, clientIp } : actor),
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    }, timeoutMs);
  };
  const workerRequest = (action, value) => {
    const path = rechargeWorkerPrefix + '/' + action;
    const body = JSON.stringify(value);
    return requestJson(bridge + path, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', ...signRechargeWorkerRequest(workerSecret, path, body) }
    }, timeoutMs);
  };

  async function execute(task) {
    const canContinue = () => Number.isSafeInteger(task.leaseUntil) && Date.now() + timeoutMs * 2 < task.leaseUntil;
    const unknown = { outcome: 'unknown' };
    if (!canContinue() || typeof task.executionCode !== 'string' ||
        !task.executionCode || typeof task.session !== 'string') return unknown;
    let jobKey;
    try {
      const { data: accepted } = await upstreamRequest('/api/run-process', {
        cdk: task.executionCode, session: task.session
      }, task.clientIp);
      if (accepted?.success !== true || typeof accepted.jobKey !== 'string' || !jobIdPattern.test(accepted.jobKey))
        return unknown;
      jobKey = accepted.jobKey;
      let lastStage;
      let heartbeatAt = 0;
      const collectProgress = async (stage) => {
        if (lastStage === stage && Date.now() < heartbeatAt) return;
        try {
          const progress = await workerRequest('progress', {
            id: task.id, leaseToken: task.leaseToken, upstreamJobId: jobKey, stage
          });
          if (progress.response.ok && progress.data?.id === task.id &&
              Number.isSafeInteger(progress.data.leaseUntil)) {
            task.leaseUntil = progress.data.leaseUntil;
            lastStage = stage;
            heartbeatAt = Date.now() + 60_000;
          }
        } catch {
          // Collection never cancels or repeats the original activation.
        }
      };
      await collectProgress('started');
      while (canContinue()) {
        const { data: receipt } = await upstreamRequest('/api/task-status/' + jobKey, undefined, task.clientIp);
        const status = receipt?.data;
        if (receipt?.success !== true || status?.jobKey !== jobKey || status.cdkCode !== task.executionCode)
          break;
        if (status.status === 'success' && status.isTerminal === true)
          return { outcome: 'confirmed_success', evidenceId: 'codexdaichong:' + jobKey, upstreamJobId: jobKey };
        if (status.status === 'failed' && status.isTerminal === true &&
            /转人工|人工确认|人工核|待核实|结果.*(?:未知|不明)|processing.*timeout/i.test(String(status.message ?? '')))
          return { outcome: 'unknown', upstreamJobId: jobKey };
        if (status.status === 'failed' && status.isTerminal === true)
          return { outcome: 'confirmed_failure', evidenceId: 'codexdaichong:' + jobKey, upstreamJobId: jobKey };
        if (status.status !== 'running' || status.isTerminal !== false) break;
        await collectProgress(originalRechargeStage(status.message));
        await sleep(pollIntervalMs);
      }
    } catch {
      // A timeout or unreadable receipt cannot determine whether payment happened.
    }
    return jobKey ? { ...unknown, upstreamJobId: jobKey } : unknown;
  }

  return async function runOnce() {
    const health = await upstreamRequest('/api/public/runtime');
    if (!health.response.ok || health.data?.success !== true)
      throw new Error('代充上游未就绪');
    const claim = await workerRequest('claim', {});
    if (!claim.response.ok || !claim.data || !Object.hasOwn(claim.data, 'task'))
      throw new Error('无法核对任务领取结果');
    const task = claim.data.task;
    if (task === null) return { status: 'idle' };
    if (!task || typeof task.id !== 'string' || typeof task.leaseToken !== 'string')
      throw new Error('任务租约格式无效');
    const result = await execute(task);
    const body = { id: task.id, leaseToken: task.leaseToken, ...result };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const receipt = await workerRequest('result', body);
        if (receipt.response.ok && receipt.data?.id === task.id)
          return { status: receipt.data.status };
        if (receipt.response.status < 500) break;
      } catch {
        // Only the idempotent result receipt is retried, never activation.
      }
    }
    throw new Error('无法确认回执已写入，请按原任务核对');
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [bridgeUrl, upstreamUrl, mode, extra] = process.argv.slice(2);
    if (extra !== undefined || (mode !== undefined && mode !== '--watch'))
      throw new Error('商城执行器启动参数无效');
    const runOnce = createVendureCodexdaichongWorker({
      bridgeUrl, upstreamUrl, workerSecret: process.env.ID_VENDURE_WORKER_SECRET,
      upstreamSecret: process.env.ID_RECHARGE_BRIDGE_SECRET
    });
    if (mode !== '--watch') console.log(JSON.stringify(await runOnce()));
    else {
      const shutdown = new AbortController();
      const stop = () => shutdown.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        while (!shutdown.signal.aborted) {
          let delay = 2000;
          try {
            const result = await runOnce();
            if (result.status !== 'idle') console.log(JSON.stringify(result));
          } catch {
            delay = 5000;
            console.error('商城代充执行未确认，请查询原任务及独立服务健康状态。');
          }
          await sleep(delay, undefined, { signal: shutdown.signal }).catch((error) => {
            if (error.name !== 'AbortError') throw error;
          });
        }
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }
    }
  } catch {
    console.error('商城代充执行未确认，请查询原任务及独立服务健康状态。');
    process.exitCode = 1;
  }
}
