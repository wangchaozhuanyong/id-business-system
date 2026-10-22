'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs/promises');
const childProcess = require('node:child_process');
const rpc = require('../rpc.cjs');
const paths = require('../paths.cjs');

async function withSyntheticWorker(run) {
  const browserPath = require.resolve('../upstream/browser-pool');
  const originalBrowser = require.cache[browserPath];
  const originals = {
    fork: childProcess.fork,
    mkdir: fs.mkdir,
    rm: fs.rm,
    transientRoot: paths.transientRoot
  };
  const envBefore = { ...process.env };
  const observed = { forked: 0 };
  require.cache[browserPath] = {
    id: browserPath,
    filename: browserPath,
    loaded: true,
    exports: {
      setRuntimeEnabled() {},
      setRuntimePoolSize() {},
      setRuntimeProfileRoot() {},
      isEnabled: () => false
    }
  };
  fs.mkdir = async () => {};
  fs.rm = async () => {};
  paths.transientRoot = () =>
    path.resolve(__dirname, '../../../../../../../.runtime/proxy-pool-review-20261016/unit-worker');
  childProcess.fork = () => {
    observed.forked++;
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.send = () =>
      queueMicrotask(() => {
        child.emit('message', {
          type: 'result',
          status: 'succeeded',
          result: {
            success: true,
            results: [{ proxyId: 'synthetic-proxy', ok: true, ip: '8.8.8.8', latencyMs: 21 }]
          },
          message: '执行完成'
        });
        child.exitCode = 0;
        child.emit('exit', 0);
      });
    child.kill = () => {};
    return child;
  };
  const modulePath = require.resolve('../worker.cjs');
  delete require.cache[modulePath];
  try {
    await run(require('../worker.cjs'), observed);
  } finally {
    childProcess.fork = originals.fork;
    fs.mkdir = originals.mkdir;
    fs.rm = originals.rm;
    paths.transientRoot = originals.transientRoot;
    if (originalBrowser) require.cache[browserPath] = originalBrowser;
    else delete require.cache[browserPath];
    delete require.cache[modulePath];
    for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
    Object.assign(process.env, envBefore);
    rpc.setTransportForTest(null);
  }
}

const task = () => ({
  id: 'synthetic-completion-task',
  operation: 'proxy_test',
  workerId: 'synthetic-worker',
  leaseId: 'synthetic-lease',
  leaseVersion: 3,
  leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
  payload: { proxyId: 'synthetic-proxy' }
});

test('proxy worker completion failure preserves probe evidence in its failed completion receipt', async () => {
  await withSyntheticWorker(async (worker, observed) => {
    const calls = [];
    rpc.setTransportForTest(async (method, args) => {
      calls.push({ method, args });
      if (method === 'completeJob') throw new Error('synthetic response lost');
      return { ok: true };
    });
    await worker.runJob(task(), { browserPool: { enabled: false } });
    assert.equal(observed.forked, 1);
    assert.deepEqual(
      calls.map(({ method }) => method),
      ['completeJob', 'failJob']
    );
    const receipt = calls[1].args;
    assert.equal(receipt.taskId, 'synthetic-completion-task');
    assert.equal(receipt.leaseVersion, 3);
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.result.errorCode, 'completion_ack_failed');
    assert.deepEqual(receipt.result.results, [
      { proxyId: 'synthetic-proxy', ok: true, ip: '8.8.8.8', latencyMs: 21 }
    ]);
    assert.match(receipt.message, /回执未能确认/);
  });
});

test('proxy worker never sends another result after the completion lease is lost', async () => {
  await withSyntheticWorker(async (worker) => {
    const calls = [];
    rpc.setTransportForTest(async (method) => {
      calls.push(method);
      throw new rpc.LeaseLostError();
    });
    await worker.runJob(task(), { browserPool: { enabled: false } });
    assert.deepEqual(calls, ['completeJob']);
  });
});

test('non-proxy completion acknowledgement failures retain the received child result for API validation', async () => {
  for (const operation of ['subscription', 'renewal'])
    await withSyntheticWorker(async (worker) => {
      let failure;
      rpc.setTransportForTest(async (method, args) => {
        if (method === 'completeJob') throw new Error('synthetic response lost');
        assert.equal(method, 'failJob');
        failure = structuredClone(args);
        return { ok: true };
      });
      await worker.runJob({ ...task(), operation }, { browserPool: { enabled: false } });
      assert.equal(failure.status, 'succeeded');
      assert.equal(failure.executorInterrupted, false);
      assert.equal(failure.executorTerminated, true);
      assert.deepEqual(failure.result, {
        success: true,
        results: [{ proxyId: 'synthetic-proxy', ok: true, ip: '8.8.8.8', latencyMs: 21 }]
      });
    });
});
