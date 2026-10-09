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
const active = new Map();
let stopping = false;
let pool = null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
      /^(PATH|LANG|LC_.*|DISPLAY|SystemRoot|TMPDIR|TZ|PYTHON.*|PLAYWRIGHT_BROWSERS_PATH|CHROMIUM_CHANNEL|RUNNING_IN_DOCKER|HF_HOME|TRANSFORMERS_CACHE|GPT_API_MAX_POLLS|GPT_API_POLL_INTERVAL_MS|ONLINE_RECHARGE_RPC_URL|ONLINE_RECHARGE_WORKER_KEY|ONLINE_RECHARGE_FFMPEG_PATH)$/.test(
        key
      )
    )
      env[key] = value;
  }
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(task.id)) throw new Error('任务临时目录标识无效');
  env.ONLINE_RECHARGE_RUNTIME_DIR = path.join(transientRoot(), 'tasks', task.id);
  env.ONLINE_RECHARGE_MEDIA_DIR = path.join(mediaRoot(), task.id);
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
async function uploadEvidence(task, files, artifacts) {
  const mediaRoot = path.resolve(childEnvironment(task).ONLINE_RECHARGE_MEDIA_DIR);
  for (const file of files.slice(-40)) {
    try {
      const resolved = await fs.realpath(file);
      if (!resolved.startsWith(`${mediaRoot}${path.sep}`)) continue;
      const stat = await fs.stat(resolved);
      const kind = resolved.endsWith('.webm')
        ? 'video'
        : resolved.endsWith('.png')
          ? 'screenshot'
          : null;
      if (!stat.isFile() || !kind || stat.size > (kind === 'video' ? 100 : 10) * 1024 * 1024)
        continue;
      const buffer = await fs.readFile(resolved);
      const artifact = await rpc('evidenceUpload', {
        ...scope(task),
        kind,
        name: path.basename(resolved),
        mimeType: kind === 'video' ? 'video/webm' : 'image/png',
        redacted: true,
        dataBase64: buffer.toString('base64')
      });
      artifacts.push(artifact);
    } catch {
      /* A missing diagnostic must never cause another payment. */
    }
  }
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
    result: null,
    lost: false,
    slot: null
  };
  active.set(task.id, entry);
  let heartbeatBusy = false;
  const heartbeat = setInterval(async () => {
    if (heartbeatBusy || entry.lost) return;
    heartbeatBusy = true;
    try {
      await rpc('heartbeat', scope(task));
    } catch {
      entry.lost = true;
      credentials.forgetTask(task.id);
      entry.child?.kill('SIGTERM');
    } finally {
      heartbeatBusy = false;
    }
  }, 10000);
  let flushBusy = false;
  async function flush() {
    if (flushBusy || !entry.logs.length || entry.lost) return;
    flushBusy = true;
    const logs = entry.logs.splice(0, 40);
    try {
      await rpc('progress', { ...scope(task), logs, message: logs.at(-1).text });
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
    if (task.operation === 'browser_manage') {
      entry.result = {
        status: 'succeeded',
        result: await manageBrowser(task, config),
        message: '浏览器管理已完成'
      };
    } else {
      const requiresBrowser =
        task.operation === 'debug' ||
        (task.operation === 'recharge' && task.provider !== 'third_party');
      await configurePool(config);
      if (requiresBrowser && pool.isEnabled()) {
        await pool.initBrowserPool();
        entry.slot = await pool.acquireSlot(task.id);
      }
      const env = require('./upstream/browser-runtime').buildWorkerRuntimeEnv(
        childEnvironment(task),
        entry.slot,
        pool.isEnabled() ? 'pool' : 'standalone'
      );
      if (requiresBrowser && !entry.slot) {
        env.CDP_PORT = String(await allocateStandalonePort());
        env.CDP_URL = `http://127.0.0.1:${env.CDP_PORT}`;
      }
      await fs.mkdir(env.ONLINE_RECHARGE_RUNTIME_DIR, { recursive: true, mode: 0o700 });
      const child = fork(path.join(__dirname, 'task-runner.cjs'), [], {
        cwd: __dirname,
        env,
        execArgv: [],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      });
      entry.child = child;
      child.on('message', (message) => {
        if (message?.type === 'credential') {
          const cvc = !entry.lost ? credentials.take(String(message.cardId), task.id) : '';
          if (child.connected)
            child.send({ type: 'credential', requestId: message.requestId, cvc });
        } else if (message?.type === 'credential_forget') {
          // A child can only forget the card currently leased to its task.
          if (credentials.take(String(message.cardId), task.id))
            credentials.forget([String(message.cardId)]);
        } else if (message?.type === 'log') {
          if (entry.logs.length < 200) entry.logs.push(sanitize(message.log));
        } else if (message?.type === 'evidence' && Array.isArray(message.paths)) {
          entry.evidence = entry.evidence.then(() =>
            uploadEvidence(task, message.paths, entry.artifacts)
          );
        } else if (message?.type === 'result')
          entry.result = { ...sanitize(message), result: sanitizeResult(message.result) };
      });
      const deadline = setTimeout(
        () => {
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5000).unref();
        },
        30 * 60 * 1000
      );
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
        child.send({ task });
      });
      clearTimeout(deadline);
    }
    await flush();
    await entry.evidence;
    // 停机中断且子进程没有结果时交由数据库租约恢复：付款前可恢复原任务，已提交则待核对。
    if (entry.lost || (stopping && !entry.result)) return;
    const result = entry.result || {
      status: 'awaiting_review',
      result: { resultUnknown: true },
      message: '执行器中断，等待核对，禁止自动重试'
    };
    await rpc('completeJob', {
      ...scope(task),
      status: result.status,
      result: result.result || {},
      message: result.message,
      definitiveFailure: result.result?.definitiveFailure === true,
      confirmedPaid: result.result?.confirmedPaid === true,
      evidence: entry.artifacts
    });
  } catch {
    const uncertain = ['recharge', 'renewal'].includes(task.operation);
    if (!entry.lost)
      await rpc('failJob', {
        ...scope(task),
        status: uncertain ? 'awaiting_review' : 'failed',
        result: uncertain ? { resultUnknown: true } : { error: '执行器准备或管理操作失败' },
        message: uncertain ? '执行未能完整确认，请核对任务状态' : '执行未完成，请查看受限诊断'
      }).catch(() => {});
  } finally {
    clearInterval(heartbeat);
    clearInterval(logTimer);
    credentials.forgetTask(task.id);
    if (entry.slot) {
      await pool.clearTaskContexts(entry.slot.slotId).catch(() => {});
      pool.releaseSlot(entry.slot.slotId);
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
  manageBrowser,
  allocateStandalonePort
};
