'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { runInNewContext } = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../worker.cjs'), 'utf8');
const engine = path.join(__dirname, '..');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const settle = async () => {
  for (let count = 0; count < 30; count++) await Promise.resolve();
};

function fixture({
  heartbeat,
  progress,
  initialize = async () => {},
  claimedExpiry,
  clearContexts = async () => true
} = {}) {
  let now = 1800000000000;
  const timers = new Set();
  const effects = {
    rpc: [],
    signals: [],
    forks: 0,
    sent: 0,
    diagnostics: [],
    files: new Map(),
    releases: 0,
    acquired: 0
  };
  const child = new EventEmitter();
  child.connected = true;
  child.exitCode = null;
  child.signalCode = null;
  child.exit = (code = 0, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
  };
  child.kill = (signal) => {
    effects.signals.push({ signal, at: now });
    if (signal === 'SIGKILL') queueMicrotask(() => child.exit(null, signal));
  };
  child.send = () => {
    effects.sent++;
  };
  const pool = {
    setRuntimeEnabled() {},
    setRuntimePoolSize() {},
    setRuntimeProfileRoot() {},
    isEnabled: () => true,
    initBrowserPool: initialize,
    acquireSlot: async () => {
      effects.acquired++;
      return { slotId: 1, cdpUrl: 'http://127.0.0.1:1', port: 1 };
    },
    clearTaskContexts: clearContexts,
    releaseSlot: () => {
      effects.releases++;
    }
  };
  const task = {
    id: 'synthetic-heartbeat-task',
    workerId: 'synthetic-worker',
    leaseId: 'synthetic-private-lease-id',
    leaseVersion: 2,
    leaseExpiresAt:
      claimedExpiry === undefined ? new Date(now + 90000).toISOString() : claimedExpiry,
    operation: 'debug',
    provider: 'local',
    session: 'synthetic-private-session'
  };
  const config = { browserPool: { enabled: true, size: 2 } };
  const module = { exports: {} };
  function timer(callback, milliseconds, repeat) {
    const handle = { callback, at: now + milliseconds, repeat, milliseconds, unref() {} };
    timers.add(handle);
    return handle;
  }
  const rpc = async (method, args) => {
    effects.rpc.push({ method, args });
    if (method === 'heartbeat')
      return heartbeat
        ? heartbeat({
            now,
            task,
            count: effects.rpc.filter((item) => item.method === method).length
          })
        : { ok: true, leaseExpiresAt: new Date(now + 90000).toISOString() };
    if (method === 'progress' && progress) return progress();
    return { ok: true };
  };
  runInNewContext(source, {
    module,
    __dirname: engine,
    Date: class extends Date {
      constructor(...args) {
        super(...(args.length ? args : [now]));
      }
      static now() {
        return now;
      }
    },
    process: {
      env: {},
      stderr: { write: (value) => effects.diagnostics.push(value) }
    },
    setInterval: (callback, milliseconds) => timer(callback, milliseconds, true),
    clearInterval: (handle) => timers.delete(handle),
    setTimeout: (callback, milliseconds) => timer(callback, milliseconds, false),
    clearTimeout: (handle) => timers.delete(handle),
    require(name) {
      if (name === './unpaid-validation.cjs') return require('../unpaid-validation.cjs');
      if (name === 'node:path') return path;
      if (name === 'node:os') return { hostname: () => 'synthetic-host' };
      if (name === 'node:net')
        return {
          createServer: () => ({
            once(_event, callback) {
              this.failed = callback;
            },
            listen(_port, _host, ready) {
              Promise.resolve().then(initialize).then(ready, this.failed);
            },
            address: () => ({ port: 9222 }),
            close(done) {
              done();
            }
          })
        };
      if (name === 'node:fs/promises')
        return {
          mkdir: async () => {},
          rm: async () => {},
          writeFile: async (file, value) => {
            effects.files.set(file, Buffer.from(value));
          },
          realpath: async (file) => file,
          stat: async (file) => ({
            isFile: () => true,
            size: effects.files.get(file)?.length || 0
          }),
          readFile: async (file) => effects.files.get(file)
        };
      if (name === 'node:child_process')
        return {
          fork: (_file, _args, options) => {
            effects.childEnv = options.env;
            effects.forks++;
            return child;
          }
        };
      if (name === './rpc.cjs') return { rpc };
      if (name === './credentials.cjs') return { forgetTask() {} };
      if (name === './paths.cjs')
        return {
          runtimeRoot: () => path.join(engine, 'runtime'),
          mediaRoot: () => path.join(engine, 'runtime', 'media'),
          transientRoot: () => path.join(engine, 'runtime', 'transient')
        };
      if (name === './security.cjs')
        return {
          sanitize: (value) => value,
          sanitizeResult: (value) => value,
          clearSensitive() {},
          rememberSecrets() {},
          redactText: (value) => value
        };
      if (name === './upstream/browser-pool') return pool;
      if (name === './upstream/browser-runtime') return require('../upstream/browser-runtime');
      throw new Error(`Unexpected module: ${name}`);
    }
  });
  async function advance(milliseconds) {
    const until = now + milliseconds;
    for (;;) {
      const next = [...timers].filter((item) => item.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      if (next.repeat) next.at += next.milliseconds;
      else timers.delete(next);
      next.callback();
      await settle();
    }
    now = until;
    await settle();
  }
  return {
    task,
    child,
    effects,
    advance,
    elapseWithoutTimers: (milliseconds) => {
      now += milliseconds;
    },
    timerCount: () => timers.size,
    now: () => now,
    run: () => module.exports.runJob(task, config),
    complete: (result = { debugOnly: true }) => {
      child.emit('message', { type: 'result', status: 'succeeded', result });
      child.exit();
    }
  };
}

for (const failure of ['network', '503', 'invalid']) {
  test(`transient ${failure} heartbeat preserves the confirmed lease and subsequent renewal`, async () => {
    const f = fixture({
      heartbeat: ({ count, now }) => {
        if (count === 1) {
          const error = new Error(
            failure === '503' ? '内部执行接口失败 503' : 'synthetic-private-error'
          );
          if (failure === 'invalid') error.code = 'RPC_RESPONSE_INVALID';
          else error.code = 'synthetic-private-error-code';
          throw error;
        }
        return { ok: true, leaseExpiresAt: new Date(now + 90000).toISOString() };
      }
    });
    const running = f.run();
    await settle();
    assert.equal(f.effects.forks, 1);
    await f.advance(10000);
    assert.equal(f.effects.signals.length, 0);
    const log = JSON.parse(f.effects.diagnostics[0]);
    assert.equal(log.phase, 'heartbeat_transient');
    assert.equal(log.httpStatus, failure === '503' ? 503 : undefined);
    await f.advance(76000);
    assert.equal(
      f.effects.signals.length,
      0,
      'successful heartbeats must replace the old deadline'
    );
    f.complete();
    await running;
    assert.equal(f.effects.rpc.filter((item) => item.method === 'completeJob').length, 1);
    assert.equal(f.effects.rpc.filter((item) => item.method === 'failJob').length, 0);
    assert.doesNotMatch(f.effects.diagnostics.join(''), /synthetic-private/);
  });
}

test('explicit LEASE_LOST stops immediately and escalates once if the child ignores SIGTERM', async () => {
  const f = fixture({
    heartbeat: () => {
      throw Object.assign(new Error('synthetic-private-server-body'), { code: 'LEASE_LOST' });
    }
  });
  const running = f.run();
  await settle();
  await f.advance(10000);
  assert.deepEqual(
    f.effects.signals.map((item) => item.signal),
    ['SIGTERM']
  );
  assert.equal(JSON.parse(f.effects.diagnostics[0]).phase, 'lease_lost');
  await f.advance(5000);
  await running;
  assert.deepEqual(
    f.effects.signals.map((item) => item.signal),
    ['SIGTERM', 'SIGKILL']
  );
  assert.equal(
    f.effects.rpc.some((item) => ['completeJob', 'failJob'].includes(item.method)),
    false
  );
  assert.doesNotMatch(f.effects.diagnostics.join(''), /synthetic-private/);
});

test('continuous failures stop before the original server expiry without inventing renewal', async () => {
  const f = fixture({
    heartbeat: () => {
      throw new Error('内部执行接口暂不可用');
    }
  });
  const running = f.run();
  await settle();
  const expires = Date.parse(f.task.leaseExpiresAt);
  await f.advance(84999);
  assert.equal(f.effects.signals.length, 0);
  await f.advance(1);
  assert.equal(f.effects.signals[0].at, expires - 5000);
  await f.advance(5000);
  await running;
  assert.deepEqual(
    f.effects.signals.map((item) => item.signal),
    ['SIGTERM', 'SIGKILL']
  );
  assert.equal(
    f.effects.diagnostics.filter((line) => JSON.parse(line).phase === 'lease_expired').length,
    1
  );
});

test('invalid successful heartbeat bodies never extend the confirmed server deadline', async () => {
  const f = fixture({ heartbeat: () => ({ ok: true, leaseExpiresAt: 'not-a-date' }) });
  const running = f.run();
  await settle();
  await f.advance(85000);
  assert.equal(f.effects.signals[0].signal, 'SIGTERM');
  assert.equal(JSON.parse(f.effects.diagnostics[0]).code, 'RPC_RESPONSE_INVALID');
  await f.advance(5000);
  await running;
});

test('lease loss during browser preparation prevents fork and send after preparation resumes', async () => {
  const entered = deferred();
  const release = deferred();
  const f = fixture({
    initialize: async () => {
      entered.resolve();
      await release.promise;
    },
    heartbeat: () => {
      throw Object.assign(new Error('lease changed'), { code: 'LEASE_LOST' });
    }
  });
  const running = f.run();
  await entered.promise;
  await f.advance(10000);
  release.resolve();
  await running;
  assert.equal(f.effects.forks, 0);
  assert.equal(f.effects.sent, 0);
});

test('a missing claim expiry must be confirmed by heartbeat before child execution', async () => {
  for (const confirms of [false, true]) {
    const f = fixture({
      claimedExpiry: null,
      heartbeat: ({ now }) =>
        confirms ? { ok: true, leaseExpiresAt: new Date(now + 90000).toISOString() } : { ok: true }
    });
    const running = f.run();
    await settle();
    assert.equal(f.effects.rpc[0].method, 'heartbeat');
    assert.equal(f.effects.forks, confirms ? 1 : 0);
    if (confirms) f.complete();
    await running;
    if (!confirms) assert.equal(JSON.parse(f.effects.diagnostics[0]).phase, 'lease_unconfirmed');
  }
});

test('expired or excessively distant server timestamps fail closed without a local lease extension', async () => {
  for (const offset of [-60000, 300000]) {
    const expiry = new Date(1800000000000 + offset).toISOString();
    const f = fixture({
      claimedExpiry: expiry,
      heartbeat: () => ({ ok: true, leaseExpiresAt: expiry })
    });
    await f.run();
    assert.equal(f.effects.forks, 0);
    assert.equal(f.effects.sent, 0);
    assert.equal(f.effects.rpc.filter((item) => item.method === 'heartbeat').length, 1);
    assert.equal(JSON.parse(f.effects.diagnostics[0]).phase, 'lease_unconfirmed');
  }
});

test('expired wall time prevents completion even before the lease timer callback can run', async () => {
  const entered = deferred();
  const release = deferred();
  const f = fixture({
    heartbeat: () => {
      throw new Error('内部执行接口暂不可用');
    },
    progress: async () => {
      entered.resolve();
      await release.promise;
      return { ok: true };
    }
  });
  const running = f.run();
  await settle();
  f.child.emit('message', { type: 'log', log: { text: '合成核对结果' } });
  f.complete({ confirmedPaid: true, resultUnknown: false });
  await entered.promise;
  f.elapseWithoutTimers(85000);
  release.resolve();
  await running;
  assert.equal(
    f.effects.rpc.some((item) => ['completeJob', 'failJob'].includes(item.method)),
    false
  );
  assert.equal(f.effects.signals.length, 0, 'an exited child must not be signalled again');
  assert.equal(JSON.parse(f.effects.diagnostics.at(-1)).phase, 'lease_expired');
});

test('expired wall time prevents failure writeback before the lease timer callback can run', async () => {
  const entered = deferred();
  const release = deferred();
  const f = fixture({
    initialize: async () => {
      entered.resolve();
      await release.promise;
      throw new Error('synthetic preparation failure');
    }
  });
  const running = f.run();
  await entered.promise;
  f.elapseWithoutTimers(85000);
  release.resolve();
  await running;
  assert.equal(f.effects.forks, 0);
  assert.equal(
    f.effects.rpc.some((item) => ['completeJob', 'failJob'].includes(item.method)),
    false
  );
  assert.equal(JSON.parse(f.effects.diagnostics.at(-1)).phase, 'lease_expired');
});

test('child error clears its maximum execution timer as well as heartbeat timers', async () => {
  const f = fixture();
  const running = f.run();
  await settle();
  f.child.emit('error', new Error('synthetic child start failure'));
  await settle();
  assert.equal(
    f.effects.rpc.some((item) => item.method === 'failJob'),
    false
  );
  await f.advance(5000);
  await running;
  assert.equal(f.effects.rpc.filter((item) => item.method === 'failJob').length, 1);
  assert.equal(f.timerCount(), 0);
});

for (const [operation, payload] of [
  ['subscription', {}],
  ['renewal', { action: 'check' }],
  ['renewal', { action: 'enable' }],
  ['renewal', { action: 'disable' }]
]) {
  test(`${operation} ${payload.action || 'query'} owns a dedicated persistent browser without consuming a generic pool slot`, async () => {
    const f = fixture();
    f.task.operation = operation;
    f.task.payload = payload;
    const running = f.run();
    await settle();
    assert.equal(f.effects.acquired, 0);
    assert.match(f.effects.childEnv.ONLINE_RECHARGE_PROFILE_ROOT, /browser-profiles$/);
    assert.equal(f.effects.childEnv.BROWSER_POOL, '0');
    assert.equal(f.effects.forks, 1);
    f.complete({ ok: true });
    await running;
    assert.equal(f.effects.releases, 0);
    assert.equal(f.effects.rpc.filter((r) => r.method === 'completeJob').length, 1);
  });
}

test('a child exit without result delegates interruption facts to API instead of forcing review', async () => {
  const f = fixture();
  const running = f.run();
  await settle();
  f.child.exit();
  await running;
  const finish = f.effects.rpc.find((item) => item.method === 'completeJob');
  assert.equal(finish.args.status, 'failed');
  assert.equal(finish.args.executorInterrupted, true);
  assert.equal(finish.args.executorTerminated, true);
  assert.equal(finish.args.definitiveFailure, false);
  assert.equal(finish.args.result.resultUnknown, undefined);
});
test('parent ends an unresponsive login phase independently and waits for child exit', async () => {
  const f = fixture();
  const running = f.run();
  await settle();
  f.child.emit('message', {
    type: 'phase',
    phase: 'session_bootstrap',
    active: true,
    lastAwait: 'challenge'
  });
  await f.advance(189000);
  f.child.emit('message', {
    type: 'phase',
    phase: 'session_bootstrap',
    active: true,
    lastAwait: 'challenge'
  });
  await f.advance(999);
  assert.equal(f.effects.signals.length, 0);
  await f.advance(1);
  assert.equal(f.effects.signals[0].signal, 'SIGTERM');
  assert.equal(
    f.effects.rpc.some((item) => item.method === 'completeJob'),
    false
  );
  await f.advance(5000);
  await running;
  const finish = f.effects.rpc.find((item) => item.method === 'completeJob');
  assert.equal(finish.args.executorTerminated, true);
  assert.equal(finish.args.result.bootstrapDiagnostics.lastAwait, 'challenge');
});

test('generic pool cleanup cannot delay a terminated dedicated-browser task', async () => {
  let poolCleanupCalls = 0;
  const f = fixture({
    clearContexts: () => {
      poolCleanupCalls++;
      return new Promise(() => {});
    }
  });
  const running = f.run();
  await settle();
  f.child.exit();
  await running;
  const finish = f.effects.rpc.find((item) => item.method === 'completeJob');
  assert.equal(finish.args.executorInterrupted, true);
  assert.equal(finish.args.executorTerminated, true);
  assert.equal(poolCleanupCalls, 0);
  assert.equal(f.effects.releases, 0);
  assert.equal(f.timerCount(), 0);
});

test('a completed bootstrap clears its phase timer without affecting the ordinary task limit', async () => {
  const f = fixture();
  const running = f.run();
  await settle();
  f.child.emit('message', { type: 'phase', phase: 'session_bootstrap', active: true });
  f.child.emit('message', { type: 'phase', phase: 'session_bootstrap', active: false });
  await f.advance(200000);
  assert.equal(f.effects.signals.length, 0);
  f.complete();
  await running;
  assert.equal(f.effects.releases, 0);
  assert.equal(f.timerCount(), 0);
});

for (const phase of ['login', 'billing_fill'])
  test(`unpaid interrupted ${phase} retains classified diagnostic before completion`, async () => {
    const f = fixture();
    f.task.payload = { validationMode: 'ready_before_payment' };
    const running = f.run();
    await settle();
    f.child.emit('message', {
      type: 'validation_stage',
      stage: phase,
      at: new Date(f.now()).toISOString()
    });
    f.child.exit();
    await running;
    const finished = f.effects.rpc.find((row) => row.method === 'completeJob');
    assert.equal(finished.args.status, 'failed');
    assert.equal(finished.args.executorInterrupted, true);
    assert.equal(finished.args.result.validationReport.failureClass, 'EXECUTOR_INTERRUPTED');
    assert.equal(finished.args.result.validationReport.lastStage, phase);
    const upload = f.effects.rpc.findIndex((row) => row.method === 'evidenceUpload');
    const complete = f.effects.rpc.findIndex((row) => row.method === 'completeJob');
    assert.ok(upload >= 0 && upload < complete);
    const report = JSON.parse([...f.effects.files.values()][0]);
    assert.equal(report.outcome, 'failed_with_class');
    assert.equal(report.executorTerminated, true);
  });

test('unpaid supervisor stops at ten minutes and never inherits the ordinary thirty-minute wait', async () => {
  const f = fixture();
  f.task.payload = { validationMode: 'ready_before_payment' };
  const running = f.run();
  await settle();
  await f.advance(600000);
  assert.equal(f.effects.signals[0]?.signal, 'SIGTERM');
  await f.advance(5000);
  await running;
  assert.equal(f.effects.rpc.find((row) => row.method === 'completeJob').args.status, 'failed');
});
