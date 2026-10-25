'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const net = require('node:net');
const { fork } = require('node:child_process');
const { rpc } = require('./rpc.cjs');
const credentials = require('./credentials.cjs');
const { runtimeRoot, mediaRoot, transientRoot, clearTransientRoot } = require('./paths.cjs');
const {
  sanitize,
  sanitizeResult,
  clearSensitive,
  rememberSecrets,
  redactText
} = require('./security.cjs');
const unpaid = require('./unpaid-validation.cjs');
const active = new Map();
let stopping = false;
let pool = null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LEASE_SAFETY_MS = 5000;
// Validation ceiling for the API's 90 second lease, never a local renewal.
const MAX_CONFIRMED_LEASE_MS = 90000;
function capacity(cfg, env = process.env) {
  const configured = Math.max(1, Math.min(100, Math.floor(Number(cfg.maxConcurrent) || 1)));
  const cap = Number(env.ONLINE_RECHARGE_WORKER_CONCURRENCY);
  return cap > 0 ? Math.min(configured, Math.max(1, Math.floor(cap))) : configured;
}
function scope(task) {
  return {
    taskId: task.id,
    workerId: task.workerId,
    leaseId: task.leaseId,
    leaseVersion: task.leaseVersion
  };
}
async function allocateStandalonePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
function childEnvironment(task) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /^(PATH|LANG|LC_.*|DISPLAY|XAUTHORITY|SystemRoot|TMPDIR|TZ|PYTHON.*|PLAYWRIGHT_BROWSERS_PATH|CHROMIUM_CHANNEL|RUNNING_IN_DOCKER|HF_HOME|TRANSFORMERS_CACHE|GPT_API_MAX_POLLS|GPT_API_POLL_INTERVAL_MS|ONLINE_RECHARGE_RPC_URL|ONLINE_RECHARGE_WORKER_KEY|ONLINE_RECHARGE_FFMPEG_PATH)$/.test(
        key
      )
    )
      env[key] = value;
  }
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(task.id)) throw new Error('任务临时目录标识无效');
  env.ONLINE_RECHARGE_RUNTIME_DIR = path.join(transientRoot(), 'tasks', task.id);
  env.ONLINE_RECHARGE_MEDIA_DIR = path.join(mediaRoot(), task.id);
  // Parent-owned persistent storage must never inherit the child's /tmp runtime root.
  env.ONLINE_RECHARGE_PROFILE_ROOT = process.env.ONLINE_RECHARGE_PROFILE_ROOT
    ? require('./paths.cjs').resolveProjectPath(process.env.ONLINE_RECHARGE_PROFILE_ROOT)
    : path.join(runtimeRoot(), 'browser-profiles');
  return env;
}
async function configurePool(config) {
  pool ||= require('./upstream/browser-pool');
  pool.setRuntimeEnabled(Boolean(config.browserPool?.enabled));
  pool.setRuntimePoolSize(Number(config.browserPool?.size) || 2);
  pool.setRuntimeProfileRoot(transientRoot());
  process.env.HEADFUL = config.headful === false ? '0' : '1';
  process.env.ONLINE_RECHARGE_RUNTIME_DIR ||= runtimeRoot();
}
async function manageBrowser(task, config) {
  await configurePool(config);
  const action = task.payload?.action || 'stats';
  if (action === 'reload') {
    await pool.reloadBrowserPool(task.payload?.size || config.browserPool?.size);
  } else if (action === 'test') {
    if (pool.isEnabled()) {
      await pool.initBrowserPool();
      return {
        success: pool.getStats().initialized,
        mode: 'pool',
        ...(await pool.getDetailedStats())
      };
    }
    const browserSession = await require('./upstream/browser-standalone').connectStandaloneBrowser({
      headful: config.headful !== false,
      cdpPort: String(await allocateStandalonePort())
    });
    try {
      return {
        success: true,
        mode: 'standalone',
        browserVersion: browserSession.browser.version()
      };
    } finally {
      await browserSession.browser.close();
    }
  } else if (action === 'mode') {
    if (pool.getStats().busy) throw new Error('浏览器正在处理任务，请待任务结束后切换');
    await pool.shutdownBrowserPool();
    pool.setRuntimeEnabled(task.payload?.mode === 'pool');
    if (pool.isEnabled()) await pool.initBrowserPool();
  } else if (action !== 'stats') throw new Error('浏览器操作无效');
  const totalGb = os.totalmem() / 1024 ** 3,
    usedGb = (os.totalmem() - os.freemem()) / 1024 ** 3;
  return { success: true, ...(await pool.getDetailedStats({ totalGb, usedGb })) };
}
async function uploadEvidence(task, files, artifacts, options = {}) {
  const mediaRoot = path.resolve(childEnvironment(task).ONLINE_RECHARGE_MEDIA_DIR);
  for (const file of files.slice(-40)) {
    if ((options.deadline && Date.now() >= options.deadline) || options.active?.() === false) break;
    try {
      const resolved = await fs.realpath(file);
      if (!resolved.startsWith(`${mediaRoot}${path.sep}`) || options.seen?.has(resolved)) continue;
      const stat = await fs.stat(resolved);
      const kind =
        unpaid.enabled(task) && resolved.endsWith('.json')
          ? 'diagnostic'
          : resolved.endsWith('.webm')
            ? 'video'
            : resolved.endsWith('.png')
              ? 'screenshot'
              : null;
      if (!stat.isFile() || !kind || stat.size > (kind === 'video' ? 100 : 10) * 1024 * 1024)
        continue;
      const buffer = await fs.readFile(resolved);
      const artifact = await rpc(
        'evidenceUpload',
        {
          ...scope(task),
          kind,
          name: path.basename(resolved),
          mimeType:
            kind === 'diagnostic'
              ? 'application/json'
              : kind === 'video'
                ? 'video/webm'
                : 'image/png',
          redacted: true,
          dataBase64: buffer.toString('base64')
        },
        { timeoutMs: options.deadline ? Math.max(1, options.deadline - Date.now()) : 20000 }
      );
      options.seen?.add(resolved);
      artifacts.push(artifact);
    } catch {
      /* A missing diagnostic must never cause another payment. */
    }
  }
}
async function completedEvidence(task, deadline) {
  const mediaRoot = path.resolve(childEnvironment(task).ONLINE_RECHARGE_MEDIA_DIR);
  const files = [];
  let total = 0;
  try {
    const names = (await fs.readdir(mediaRoot))
      .filter((name) => /^[a-zA-Z0-9_-]+\.(png|webm)\.ready\.json$/.test(name))
      .sort()
      .slice(-40);
    for (const name of names) {
      if (Date.now() >= deadline) break;
      try {
        const marker = path.join(mediaRoot, name);
        const markerStat = await fs.lstat(marker);
        if (!markerStat.isFile() || markerStat.size > 1024) continue;
        const proof = JSON.parse(await fs.readFile(marker, 'utf8'));
        if (
          proof.version !== 1 ||
          proof.redacted !== true ||
          proof.name !== name.slice(0, -11) ||
          !/^[a-f0-9]{64}$/.test(proof.sha256) ||
          !Number.isInteger(proof.bytes) ||
          proof.bytes < 1 ||
          proof.bytes > 20 * 1024 * 1024 ||
          total + proof.bytes > 20 * 1024 * 1024
        )
          continue;
        const file = path.join(mediaRoot, proof.name);
        if (!(await fs.lstat(file)).isFile() || (await fs.realpath(file)) !== file) continue;
        const buffer = await fs.readFile(file);
        if (
          buffer.length !== proof.bytes ||
          require('node:crypto').createHash('sha256').update(buffer).digest('hex') !== proof.sha256
        )
          continue;
        total += buffer.length;
        files.push(file);
      } catch {
        /* Incomplete, unmarked, changed or escaping evidence is not recovered. */
      }
    }
  } catch {
    /* No completion receipts is an allowed diagnostic outcome. */
  }
  return files;
}
async function runJob(task, config) {
  task.workerId ||=
    process.env.ONLINE_RECHARGE_WORKER_ID || `online-recharge-${os.hostname()}-${process.pid}`;
  let resolveFinished;
  const entry = {
    finished: new Promise((resolve) => {
      resolveFinished = resolve;
    }),
    child: null,
    logs: [],
    artifacts: [],
    evidence: Promise.resolve(),
    evidenceDeadline: null,
    evidenceSeen: new Set(),
    result: null,
    lost: false,
    closed: false,
    slot: null,
    validation: unpaid.enabled(task)
      ? { format: 'unpaid-validation-v1', startedAt: new Date().toISOString(), timeline: [] }
      : null
  };
  active.set(task.id, entry);
  let leaseUntil = 0;
  let lastHeartbeatAt = 0;
  let leaseTimer;
  let childStopTimer;
  let childDeadline;
  let phaseDeadline;
  let contextCleanup;
  let contextsCleared = false;
  let childStopRequested = false;
  async function clearOwnedContexts() {
    if (!entry.slot) return true;
    contextCleanup ||= (async () => {
      let timer;
      try {
        contextsCleared = await Promise.race([
          Promise.resolve()
            .then(() => pool.clearTaskContexts(entry.slot.slotId))
            .then((value) => value === true),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), 3000);
          })
        ]);
      } catch {
        contextsCleared = false;
      } finally {
        clearTimeout(timer);
      }
      return contextsCleared;
    })();
    return contextCleanup;
  }
  async function validationEvidence(executorTerminated) {
    if (entry.validation && !entry.lost && !entry.validationRecorded) {
      entry.validationRecorded = true;
      const report =
        entry.result?.result?.validationReport ||
        unpaid.finish({ code: 'EXECUTOR_INTERRUPTED' }, entry.validation);
      report.executorTerminated = executorTerminated;
      try {
        report.sourceManifestSha256 = require('node:crypto')
          .createHash('sha256')
          .update(await fs.readFile(path.join(__dirname, 'SOURCE_MANIFEST.json')))
          .digest('hex');
      } catch {
        /* Missing source evidence is not a different business result. */
      }
      if (!entry.result)
        entry.result = {
          status: 'failed',
          result: { code: 'EXECUTOR_INTERRUPTED', validationReport: report }
        };
      else entry.result.result.validationReport = report;
      try {
        const file = path.join(
          childEnvironment(task).ONLINE_RECHARGE_MEDIA_DIR,
          'unpaid-validation.json'
        );
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.writeFile(file, JSON.stringify(report), { mode: 0o600 });
        requireLease();
        await uploadEvidence(task, [file], entry.artifacts, {
          deadline: Date.now() + 5000,
          active: () => !entry.lost
        });
        report.diagnosticUploaded = entry.artifacts.some((item) => item.kind === 'diagnostic');
      } catch {
        report.diagnosticUploaded = false;
      }
    }
  }
  function leaseDiagnostic(phase, error) {
    const code =
      phase === 'lease_expired'
        ? 'LEASE_EXPIRED'
        : ['LEASE_LOST', 'RPC_RESPONSE_INVALID', 'RESULT_UNKNOWN'].includes(error?.code)
          ? error.code
          : 'RPC_UNAVAILABLE';
    const status = /^内部执行接口失败 (\d{3})$/.exec(error?.message || '');
    process.stderr.write(
      `${JSON.stringify({
        event: 'online_recharge_lease',
        taskId: task.id,
        operation: task.operation,
        leaseVersion: task.leaseVersion,
        phase,
        code,
        ...(status ? { httpStatus: Number(status[1]) } : {}),
        ...(lastHeartbeatAt ? { sinceHeartbeatMs: Date.now() - lastHeartbeatAt } : {})
      })}\n`
    );
  }
  function stopChild() {
    const child = entry.child;
    if (!child || childStopRequested || child.exitCode !== null || child.signalCode !== null)
      return;
    childStopRequested = true;
    try {
      child.kill('SIGTERM');
    } catch {
      /* The process may already have exited. */
    }
    childStopTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* The process may already have exited. */
        }
      }
    }, 5000);
    childStopTimer.unref();
    child.once('exit', () => clearTimeout(childStopTimer));
  }
  function loseLease(phase, error) {
    if (entry.lost || entry.closed) return;
    entry.lost = true;
    leaseDiagnostic(phase, error);
    credentials.forgetTask(task.id);
    stopChild();
  }
  function confirmLease(value) {
    const until =
      typeof value === 'string' || value instanceof Date ? new Date(value).getTime() : NaN;
    const remaining = until - Date.now();
    if (
      !Number.isFinite(until) ||
      remaining <= LEASE_SAFETY_MS ||
      remaining > MAX_CONFIRMED_LEASE_MS
    )
      return false;
    leaseUntil = until;
    clearTimeout(leaseTimer);
    leaseTimer = setTimeout(() => loseLease('lease_expired'), until - LEASE_SAFETY_MS - Date.now());
    return true;
  }
  function requireLease() {
    if (!entry.lost && (!leaseUntil || Date.now() >= leaseUntil - LEASE_SAFETY_MS))
      loseLease('lease_expired');
    if (entry.lost)
      throw Object.assign(new Error('任务租约未确认或已失效'), { code: 'LEASE_LOST' });
  }
  let heartbeatBusy = false;
  async function renewLease() {
    if (heartbeatBusy || entry.lost || entry.closed) return;
    heartbeatBusy = true;
    try {
      const response = await rpc('heartbeat', scope(task));
      if (entry.lost || entry.closed) return;
      if (response?.ok !== true || !confirmLease(response.leaseExpiresAt))
        throw Object.assign(new Error('心跳未返回有效租约期限'), { code: 'RPC_RESPONSE_INVALID' });
      lastHeartbeatAt = Date.now();
    } catch (error) {
      if (entry.lost || entry.closed) return;
      if (error?.code === 'LEASE_LOST') loseLease('lease_lost', error);
      else if (!leaseUntil || Date.now() >= leaseUntil - LEASE_SAFETY_MS)
        loseLease('lease_unconfirmed', error);
      else leaseDiagnostic('heartbeat_transient', error);
    } finally {
      heartbeatBusy = false;
    }
  }
  const claimedLeaseConfirmed = confirmLease(task.leaseExpiresAt);
  const heartbeat = setInterval(renewLease, 10000);
  let flushBusy = false;
  async function flush() {
    if (flushBusy || !entry.logs.length || entry.lost) return;
    flushBusy = true;
    const logs = entry.logs.splice(0, 40);
    try {
      await rpc('progress', {
        ...scope(task),
        logs,
        message: logs.at(-1).text,
        ...(entry.validation?.timeline.at(-1)
          ? { stage: entry.validation.timeline.at(-1).stage }
          : {})
      });
    } catch {
      /* Heartbeat owns lease failure handling. */
    } finally {
      flushBusy = false;
    }
  }
  const logTimer = setInterval(() => {
    flush().catch(() => {});
  }, 1000);
  try {
    if (!claimedLeaseConfirmed) await renewLease();
    requireLease();
    if (task.operation === 'browser_manage') {
      entry.result = {
        status: 'succeeded',
        result: await manageBrowser(task, config),
        message: '浏览器管理已完成'
      };
    } else {
      const requiresBrowser =
        task.operation === 'debug' ||
        task.operation === 'subscription' ||
        task.operation === 'renewal' ||
        (task.operation === 'recharge' && task.provider !== 'third_party');
      await configurePool(config);
      requireLease();
      // Account tasks own a persistent context; the generic warm pool is not an account session.
      const env = require('./upstream/browser-runtime').buildWorkerRuntimeEnv(
        childEnvironment(task),
        entry.slot,
        pool.isEnabled() ? 'pool' : 'standalone'
      );
      if (requiresBrowser && !entry.slot) {
        env.CDP_PORT = String(await allocateStandalonePort());
        requireLease();
        env.CDP_URL = `http://127.0.0.1:${env.CDP_PORT}`;
      }
      await fs.mkdir(env.ONLINE_RECHARGE_RUNTIME_DIR, { recursive: true, mode: 0o700 });
      requireLease();
      const child = fork(path.join(__dirname, 'task-runner.cjs'), [], {
        cwd: __dirname,
        env,
        execArgv: [],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      });
      entry.child = child;
      child.on('message', (message) => {
        if (message?.type === 'validation_stage' && entry.validation) {
          if (
            unpaid.STAGES.includes(message.stage) &&
            typeof message.at === 'string' &&
            Number.isFinite(Date.parse(message.at)) &&
            entry.validation.timeline.length < 32
          ) {
            const previous = entry.validation.timeline.at(-1);
            if (previous) previous.endedAt = message.at;
            entry.validation.timeline.push({ stage: message.stage, startedAt: message.at });
            if (entry.logs.length < 200)
              entry.logs.push({
                level: 'info',
                timestamp: message.at,
                text: `不付款验证执行到第 ${unpaid.STAGES.indexOf(message.stage) + 1} 个阶段，尚未提交付款`
              });
          }
        } else if (message?.type === 'credential') {
          const cvc = !entry.lost ? credentials.take(String(message.cardId), task.id) : '';
          if (child.connected)
            child.send({ type: 'credential', requestId: message.requestId, cvc });
        } else if (message?.type === 'credential_forget') {
          // A child can only forget the card currently leased to its task.
          if (credentials.take(String(message.cardId), task.id))
            credentials.forget([String(message.cardId)]);
        } else if (message?.type === 'phase' && message.phase === 'session_bootstrap') {
          if (
            [
              'navigation',
              'wait',
              'challenge',
              'login_controls',
              'logged_in_ui',
              'ui_stability',
              'verification',
              'session_api'
            ].includes(message.lastAwait)
          )
            entry.bootstrapAwait = message.lastAwait;
          if (message.active === true && !phaseDeadline)
            phaseDeadline = setTimeout(stopChild, 190000);
          else if (message.active === false) {
            clearTimeout(phaseDeadline);
            phaseDeadline = null;
            if (message.cleanupFailed === true) stopChild();
          }
        } else if (message?.type === 'log') {
          if (entry.logs.length < 200) entry.logs.push(sanitize(message.log));
        } else if (message?.type === 'evidence' && Array.isArray(message.paths)) {
          entry.evidenceDeadline ||= Date.now() + 5000;
          entry.evidence = entry.evidence.then(() =>
            uploadEvidence(task, message.paths, entry.artifacts, {
              deadline: entry.evidenceDeadline,
              seen: entry.evidenceSeen,
              active: () => !entry.lost
            })
          );
        } else if (message?.type === 'result')
          entry.result = { ...sanitize(message), result: sanitizeResult(message.result) };
      });
      // Only the new non-payment mode has this bounded supervisor; existing payment deadlines are unchanged.
      childDeadline = setTimeout(stopChild, entry.validation ? 10 * 60 * 1000 : 30 * 60 * 1000);
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
        requireLease();
        child.send({ task });
      });
      clearTimeout(childDeadline);
    }
    const executorTerminated = await clearOwnedContexts();
    const missingResult = !entry.result;
    await validationEvidence(executorTerminated);
    await flush();
    if (!entry.lost) {
      const deadline = entry.evidenceDeadline || Date.now() + 5000;
      let evidenceTimer;
      try {
        await Promise.race([
          entry.evidence
            .then(async () => {
              requireLease();
              await uploadEvidence(task, await completedEvidence(task, deadline), entry.artifacts, {
                deadline,
                seen: entry.evidenceSeen,
                active: () => !entry.lost
              });
            })
            .catch(() => {}),
          new Promise((resolve) => {
            evidenceTimer = setTimeout(resolve, Math.max(1, deadline - Date.now()));
          })
        ]);
      } finally {
        clearTimeout(evidenceTimer);
      }
    }
    // 停机中断且子进程没有结果时交由数据库租约恢复：付款前可恢复原任务，已提交则待核对。
    if (entry.lost || (stopping && !entry.result)) return;
    const result = entry.result || {
      status: 'failed',
      result: {
        code: 'EXECUTOR_INTERRUPTED',
        ...(entry.bootstrapAwait
          ? { bootstrapDiagnostics: { reason: 'runtime_failed', lastAwait: entry.bootstrapAwait } }
          : {})
      },
      message: '执行器已中断，由服务端核对提交事实'
    };
    requireLease();
    await rpc('completeJob', {
      ...scope(task),
      ...(missingResult || !executorTerminated
        ? { executorInterrupted: true, executorTerminated }
        : {}),
      status: result.status,
      result: result.result || {},
      message: result.message,
      definitiveFailure: result.result?.definitiveFailure === true,
      confirmedPaid: result.result?.confirmedPaid === true,
      evidence: entry.artifacts
    });
  } catch (error) {
    let terminated =
      !entry.child || entry.child.exitCode !== null || entry.child.signalCode !== null;
    if (!terminated) {
      stopChild();
      let exitTimer;
      try {
        terminated = await Promise.race([
          new Promise((resolve) => entry.child.once('exit', () => resolve(true))),
          new Promise((resolve) => {
            exitTimer = setTimeout(() => resolve(false), 7000);
          })
        ]);
      } finally {
        clearTimeout(exitTimer);
      }
    }
    // An unresponsive child must never outlive a successful resource release.
    if (!terminated) return;
    terminated = await clearOwnedContexts();
    const proxyFailure =
      task.operation === 'proxy_test'
        ? require('./proxy-test.cjs').completionFailure(task, entry.result?.result)
        : null;
    if (proxyFailure && error?.code === 'LEASE_LOST') loseLease('lease_lost', error);
    if (!entry.lost && (!leaseUntil || Date.now() >= leaseUntil - LEASE_SAFETY_MS))
      loseLease('lease_expired');
    if (!entry.lost) await validationEvidence(terminated);
    if (!entry.lost)
      await rpc('failJob', {
        ...scope(task),
        executorInterrupted: !entry.result || !terminated,
        executorTerminated: terminated,
        status: proxyFailure ? 'failed' : entry.result?.status || 'failed',
        result: proxyFailure || entry.result?.result || { code: 'EXECUTOR_INTERRUPTED' },
        message: proxyFailure ? proxyFailure.error : '执行未完成，请查看受限诊断'
      }).catch(() => {});
  } finally {
    entry.closed = true;
    clearInterval(heartbeat);
    clearInterval(logTimer);
    clearTimeout(leaseTimer);
    clearTimeout(childDeadline);
    clearTimeout(phaseDeadline);
    if (!entry.child || entry.child.exitCode !== null || entry.child.signalCode !== null)
      clearTimeout(childStopTimer);
    credentials.forgetTask(task.id);
    if (
      entry.slot &&
      (!entry.child || entry.child.exitCode !== null || entry.child.signalCode !== null)
    ) {
      if (await clearOwnedContexts()) pool.releaseSlot(entry.slot.slotId);
    }
    clearSensitive(task);
    if (/^[a-zA-Z0-9_-]{1,100}$/.test(task.id))
      await fs
        .rm(path.join(transientRoot(), 'tasks', task.id), { recursive: true, force: true })
        .catch(() => {});
    active.delete(task.id);
    if (entry.result?.result) entry.result.result.checkoutUrl = null;
    resolveFinished();
  }
}
async function main() {
  stopping = false;
  rememberSecrets(process.env.ONLINE_RECHARGE_WORKER_KEY, 'secret');
  const credentialsOnly =
    process.argv.includes('--credentials-only') ||
    process.env.ONLINE_RECHARGE_ENGINE_ENABLED !== '1';
  let lastRpcAt = 0;
  let shutdownDeadline;
  const credentialService = await credentials.start({
    health: () => ({
      ready: !stopping && (credentialsOnly || (lastRpcAt > 0 && Date.now() - lastRpcAt < 60000)),
      mode: credentialsOnly ? 'credentials-only' : 'enabled',
      activeTasks: active.size,
      stopping,
      rpcConnected: lastRpcAt > 0 && Date.now() - lastRpcAt < 60000
    })
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const [id, entry] of active) {
      credentials.forgetTask(id);
      entry.child?.kill('SIGTERM');
    }
    shutdownDeadline = setTimeout(() => {
      for (const [id, entry] of active) {
        credentials.forgetTask(id);
        entry.child?.kill('SIGKILL');
      }
      try {
        clearTransientRoot();
      } catch {
        /* The container tmpfs also disappears on exit. */
      }
      process.stderr.write('执行器关停等待超时，未确认结果交由租约核对。\n');
      process.exit(1);
    }, 20000);
    shutdownDeadline.unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    if (credentialsOnly) {
      process.stdout.write('临时凭据服务已启动；充值执行未启用。\n');
      while (!stopping) await sleep(500);
      return;
    }
    const workerId =
      process.env.ONLINE_RECHARGE_WORKER_ID || `online-recharge-${os.hostname()}-${process.pid}`;
    while (!stopping) {
      try {
        const config = await rpc('getRuntimeConfig');
        lastRpcAt = Date.now();
        if (stopping) break;
        if (active.size < capacity(config)) {
          const task = await rpc('claimJob', { workerId });
          if (stopping) break;
          if (task) {
            task.workerId = workerId;
            void runJob(task, config);
            continue;
          }
        }
      } catch (error) {
        process.stderr.write(`${redactText(error.code || '内部执行连接暂不可用')}\n`);
      }
      await sleep(1000);
    }
    await Promise.all([...active.values()].map((entry) => entry.finished));
  } finally {
    try {
      await pool?.shutdownBrowserPool();
    } finally {
      await credentialService.close();
      clearTransientRoot();
      clearTimeout(shutdownDeadline);
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
    }
  }
}
if (require.main === module)
  main().catch(() => {
    process.stderr.write('执行器未能启动，请检查私网配置。\n');
    process.exitCode = 1;
  });
module.exports = {
  main,
  capacity,
  childEnvironment,
  runJob,
  uploadEvidence,
  completedEvidence,
  manageBrowser,
  allocateStandalonePort
};
