import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { signRechargeAssertion } from '../assertion.mjs';
import { validateRuntimeOrigin } from '../codexdaichong/runtime-health.mjs';
import { rechargeWorkerPrefix, signRechargeWorkerRequest } from './loopback-bridge.mjs';

const actor = Object.freeze({
  id: 'vendure-recharge-executor', email: 'vendure-worker@localhost', admin: false, sensitive: false
});
const jobIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const plans = new Set(['plus', 'pro_5x', 'pro_20x']);

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

  const upstreamRequest = (path, body) => {
    const method = body === undefined ? 'GET' : 'POST';
    return requestJson(upstream + path, {
      method,
      headers: {
        'x-id-recharge-assertion': signRechargeAssertion(upstreamSecret, method, path, actor),
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
    if (!canContinue() || !plans.has(task.plan) || typeof task.executionCode !== 'string' ||
        !task.executionCode || typeof task.session !== 'string') return unknown;
    let jobKey;
    try {
      const { data: verified } = await upstreamRequest('/api/verify-cdk', { cdk: task.executionCode });
      if (verified?.success !== true || verified.data?.status === 'processing' || !verified.data) return unknown;
      if (verified.data.type !== '自助' || verified.data.plan_type !== task.plan)
        return { outcome: 'confirmed_failure', evidenceId: 'plan-check:' + task.id };
      if (!canContinue()) return unknown;
      const { data: accepted } = await upstreamRequest('/api/run-process', {
        cdk: task.executionCode, session: task.session, expectedPlan: task.plan
      });
      if (accepted?.success !== true || typeof accepted.jobKey !== 'string' || !jobIdPattern.test(accepted.jobKey))
        return unknown;
      jobKey = accepted.jobKey;
      while (canContinue()) {
        const { data: receipt } = await upstreamRequest('/api/task-status/' + jobKey);
        const status = receipt?.data;
        if (receipt?.success !== true || status?.jobKey !== jobKey || status.cdkCode !== task.executionCode)
          break;
        if (status.status === 'success' && status.isTerminal === true)
          return { outcome: 'confirmed_success', evidenceId: 'codexdaichong:' + jobKey, upstreamJobId: jobKey };
        if (status.status !== 'running' || status.isTerminal !== false) break;
        await sleep(pollIntervalMs);
      }
    } catch {
      // A timeout or unreadable receipt cannot determine whether payment happened.
    }
    return jobKey ? { ...unknown, upstreamJobId: jobKey } : unknown;
  }

  return async function runOnce() {
    const health = await upstreamRequest('/api/public/runtime');
    if (health.data?.success !== true || health.response.headers.get('x-id-vendure-plan-lock') !== '1')
      throw new Error('代充上游未就绪或缺少商城套餐锁');
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
