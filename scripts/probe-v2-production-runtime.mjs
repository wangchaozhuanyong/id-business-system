#!/usr/bin/env node
import assert from 'node:assert/strict';

const confirmation = process.env.V2_PRODUCTION_PROBE_CONFIRM;
assert.equal(
  confirmation,
  'read-only-maintenance',
  '生产探针必须显式设置 V2_PRODUCTION_PROBE_CONFIRM=read-only-maintenance'
);
assert.ok(process.env.BASE_URL, '缺少生产地址 BASE_URL');
assert.ok(process.env.SMOKE_TEST_USERNAME, '缺少生产只读巡检账号');
assert.ok(process.env.SMOKE_TEST_PASSWORD, '缺少生产只读巡检密码');

const baseUrl = new URL(
  process.env.BASE_URL.endsWith('/') ? process.env.BASE_URL : `${process.env.BASE_URL}/`
);
const allowLocal = process.env.V2_PRODUCTION_PROBE_ALLOW_LOCAL === 'true';
if (!allowLocal) {
  assert.equal(baseUrl.protocol, 'https:', '生产探针只允许 HTTPS 地址');
  assert.ok(
    !['localhost', '127.0.0.1', '0.0.0.0'].includes(baseUrl.hostname),
    '生产探针不得把本机地址误当成生产环境'
  );
}

const durationSeconds = readBoundedInteger(
  'V2_PRODUCTION_SSE_DURATION_SECONDS',
  7200,
  allowLocal ? 30 : 300,
  28800
);
const requestsPerPhase = readBoundedInteger('V2_PRODUCTION_REQUESTS_PER_PHASE', 120, 20, 500);
const p99StopMs = readBoundedInteger('V2_PRODUCTION_P99_STOP_MS', 2500, 500, 10000);
const maxRequestMs = readBoundedInteger('V2_PRODUCTION_MAX_REQUEST_MS', 5000, 1000, 20000);
const concurrencyPhases = parseConcurrencyPhases(
  process.env.V2_PRODUCTION_CONCURRENCY_PHASES ?? '1,5,10,20'
);
const username = process.env.SMOKE_TEST_USERNAME;
const password = process.env.SMOKE_TEST_PASSWORD;
const userAgent = 'id-business-v2-production-runtime-probe';

let token = '';
let logoutStatus = 0;
let streamAbortController;
const phaseResults = [];
const continuityChecks = [];

try {
  token = await login();
  const stream = startEventStream(token, durationSeconds * 1000);
  await stream.connected;

  for (const concurrency of concurrencyPhases) {
    const result = await runReadPhase(token, concurrency, requestsPerPhase);
    phaseResults.push(result);
    console.log(`PRODUCTION_LOAD_PHASE ${JSON.stringify(result)}`);
    if (result.failures > 0 || result.p99Ms > p99StopMs || result.maxMs > maxRequestMs) {
      throw new Error(
        `生产渐进压测触发停止阈值：concurrency=${concurrency} failures=${result.failures} p99=${result.p99Ms} max=${result.maxMs}`
      );
    }
    await delay(1500);
  }

  const soakStartedAt = Date.now();
  const soakDeadline = soakStartedAt + durationSeconds * 1000;
  while (Date.now() < soakDeadline) {
    await delay(Math.min(60_000, Math.max(1, soakDeadline - Date.now())));
    if (Date.now() >= soakDeadline) break;
    const check = await runContinuityCheck(token);
    continuityChecks.push(check);
    const elapsedSeconds = Math.round((Date.now() - soakStartedAt) / 1000);
    console.log(
      `PRODUCTION_SSE_PROGRESS ${JSON.stringify({
        elapsedSeconds,
        durationSeconds,
        ...stream.metrics(),
        continuityStatus: check
      })}`
    );
    if (check.healthStatus !== 200 || check.protectedStatus !== 200) {
      throw new Error(`生产 SSE soak 连续性检查失败：${JSON.stringify(check)}`);
    }
  }

  streamAbortController.abort();
  const streamResult = await stream.completed;
  const minimumHeartbeats = Math.max(1, Math.floor(durationSeconds / 25) - 2);
  assert.equal(streamResult.endedEarly, false, '生产 SSE 在计划结束前断开');
  assert.equal(streamResult.snapshots, 1, '生产 SSE 初始快照数量异常');
  assert.ok(
    streamResult.heartbeats >= minimumHeartbeats,
    `生产 SSE 心跳不足：${streamResult.heartbeats}/${minimumHeartbeats}`
  );
  assert.ok(streamResult.maxHeartbeatGapMs < 40_000, '生产 SSE 心跳间隔超过 40 秒');

  logoutStatus = await logout(token);
  assert.ok([200, 201].includes(logoutStatus), `生产只读巡检登出失败：${logoutStatus}`);

  console.log(
    `PRODUCTION_RUNTIME_RESULT ${JSON.stringify({
      ok: true,
      durationSeconds,
      phaseResults,
      continuityChecks: continuityChecks.length,
      stream: streamResult,
      logoutStatus
    })}`
  );
} catch (error) {
  streamAbortController?.abort();
  if (token && logoutStatus === 0) {
    await logout(token).catch(() => 0);
  }
  throw error;
}

async function login() {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await request('api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    lastStatus = response.status;
    const body = await readJson(response);
    const accessToken = body?.data?.accessToken;
    if ([200, 201].includes(response.status) && accessToken) return accessToken;
    if (response.status !== 429 || attempt === 3) break;
    await delay(30_000);
  }
  throw new Error(`生产只读巡检登录失败：${lastStatus}`);
}

async function logout(accessToken) {
  const response = await request('api/auth/logout', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` }
  });
  await response.arrayBuffer();
  return response.status;
}

function startEventStream(accessToken, durationMs) {
  streamAbortController = new AbortController();
  let resolveConnected;
  let rejectConnected;
  const connected = new Promise((resolve, reject) => {
    resolveConnected = resolve;
    rejectConnected = reject;
  });
  const state = {
    snapshots: 0,
    heartbeats: 0,
    changes: 0,
    bytes: 0,
    firstSnapshotMs: null,
    maxHeartbeatGapMs: 0,
    lastHeartbeatAt: null,
    connectedAt: null
  };
  const startedAt = performance.now();
  let plannedAbort = false;
  const abortTimer = setTimeout(() => {
    plannedAbort = true;
    streamAbortController.abort();
  }, durationMs + 30_000);

  const completed = (async () => {
    try {
      const response = await fetch(new URL('api/realtime/events', baseUrl), {
        headers: {
          accept: 'text/event-stream',
          authorization: `Bearer ${accessToken}`,
          'user-agent': userAgent
        },
        signal: streamAbortController.signal
      });
      if (
        !response.ok ||
        !String(response.headers.get('content-type')).includes('text/event-stream')
      ) {
        throw new Error(`生产 SSE 建连失败：${response.status}`);
      }
      state.connectedAt = performance.now();
      resolveConnected();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const result = await reader.read();
        if (result.done) {
          return finish(true);
        }
        state.bytes += result.value.byteLength;
        buffer += decoder.decode(result.value, { stream: true }).replaceAll('\r\n', '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const eventBlock = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          consumeEventBlock(eventBlock, state, startedAt);
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return finish(!plannedAbort && performance.now() - startedAt < durationMs - 1000);
      }
      rejectConnected(error);
      throw error;
    } finally {
      clearTimeout(abortTimer);
    }
  })();

  function finish(endedEarly) {
    return {
      endedEarly,
      snapshots: state.snapshots,
      heartbeats: state.heartbeats,
      changes: state.changes,
      bytes: state.bytes,
      firstSnapshotMs: round(state.firstSnapshotMs ?? -1),
      maxHeartbeatGapMs: round(state.maxHeartbeatGapMs),
      elapsedMs: round(performance.now() - startedAt)
    };
  }

  return {
    connected,
    completed,
    metrics: () => ({
      snapshots: state.snapshots,
      heartbeats: state.heartbeats,
      changes: state.changes,
      bytes: state.bytes,
      maxHeartbeatGapMs: round(state.maxHeartbeatGapMs)
    })
  };
}

function consumeEventBlock(eventBlock, state, startedAt) {
  const typeLine = eventBlock.split('\n').find((line) => line.startsWith('event:'));
  const type = typeLine?.slice(6).trim();
  if (type === 'snapshot') {
    state.snapshots += 1;
    if (state.firstSnapshotMs === null) state.firstSnapshotMs = performance.now() - startedAt;
  } else if (type === 'heartbeat') {
    state.heartbeats += 1;
    const now = performance.now();
    if (state.lastHeartbeatAt !== null) {
      state.maxHeartbeatGapMs = Math.max(state.maxHeartbeatGapMs, now - state.lastHeartbeatAt);
    }
    state.lastHeartbeatAt = now;
  } else if (type === 'change') {
    state.changes += 1;
  }
}

async function runReadPhase(accessToken, concurrency, totalRequests) {
  const paths = [
    'api/id-business-v2/orders?page=1&pageSize=20',
    'api/id-business-v2/renewals/workbench',
    'api/id-business-v2/accounts?page=1&pageSize=20',
    'api/id-business-v2/customers?page=1&pageSize=20',
    'api/id-business-v2/exchange-rates?page=1&pageSize=20'
  ];
  let cursor = 0;
  let failures = 0;
  const samples = [];
  const startedAt = performance.now();

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= totalRequests) return;
      const requestStartedAt = performance.now();
      try {
        const response = await request(paths[index % paths.length], {
          headers: { authorization: `Bearer ${accessToken}` }
        });
        await response.arrayBuffer();
        samples.push(performance.now() - requestStartedAt);
        if (response.status !== 200) failures += 1;
      } catch {
        samples.push(maxRequestMs);
        failures += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsedMs = performance.now() - startedAt;
  return {
    concurrency,
    requests: totalRequests,
    failures,
    p50Ms: round(percentile(samples, 0.5)),
    p95Ms: round(percentile(samples, 0.95)),
    p99Ms: round(percentile(samples, 0.99)),
    maxMs: round(Math.max(...samples)),
    throughputRps: round(totalRequests / (elapsedMs / 1000))
  };
}

async function runContinuityCheck(accessToken) {
  const startedAt = performance.now();
  const [health, protectedResponse] = await Promise.all([
    request('api/health/ready'),
    request('api/id-business-v2/orders?page=1&pageSize=1', {
      headers: { authorization: `Bearer ${accessToken}` }
    })
  ]);
  await Promise.all([health.arrayBuffer(), protectedResponse.arrayBuffer()]);
  return {
    healthStatus: health.status,
    protectedStatus: protectedResponse.status,
    totalMs: round(performance.now() - startedAt)
  };
}

function request(path, options = {}) {
  return fetch(new URL(path, baseUrl), {
    ...options,
    signal: AbortSignal.timeout(maxRequestMs),
    headers: {
      accept: 'application/json',
      'user-agent': userAgent,
      ...(options.headers ?? {})
    }
  });
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`生产探针收到无效 JSON：${response.status}`);
  }
}

function parseConcurrencyPhases(value) {
  const phases = value.split(',').map((item) => Number(item.trim()));
  assert.ok(phases.length >= 1 && phases.length <= 6, '生产并发阶段数量必须为 1 到 6');
  assert.ok(
    phases.every((item) => Number.isInteger(item) && item >= 1 && item <= 40),
    '生产并发值必须是 1 到 40 之间的整数'
  );
  return [...new Set(phases)].sort((left, right) => left - right);
}

function readBoundedInteger(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(
    Number.isInteger(value) && value >= minimum && value <= maximum,
    `${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`
  );
  return value;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
