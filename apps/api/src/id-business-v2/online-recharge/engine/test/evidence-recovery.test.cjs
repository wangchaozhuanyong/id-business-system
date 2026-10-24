'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { runInNewContext } = require('node:vm');

const engine = path.join(__dirname, '..');
const project = path.resolve(engine, '../../../../../..');
async function directory(t) {
  const root = path.join(project, '.runtime/execution-repair');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'evidence-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function completed(dir, name, contents = 'synthetic masked image') {
  const data = Buffer.from(contents),
    file = path.join(dir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, data, { mode: 0o600 });
  await fs.writeFile(
    `${file}.ready.json`,
    JSON.stringify({
      version: 1,
      name,
      redacted: true,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex')
    }),
    { mode: 0o600 }
  );
  return file;
}
async function worker(root, { duplicateIpc = false } = {}) {
  const effects = [],
    module = { exports: {} };
  const task = {
    id: 'synthetic-evidence-task',
    operation: 'debug',
    provider: 'local',
    leaseId: 'synthetic-lease',
    leaseVersion: 1,
    workerId: 'synthetic-worker',
    leaseExpiresAt: new Date(Date.now() + 90000).toISOString()
  };
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.connected = true;
  child.send = () =>
    setImmediate(() => {
      if (duplicateIpc) {
        const message = { type: 'evidence', paths: [path.join(root, task.id, 'complete.png')] };
        child.emit('message', message);
        child.emit('message', message);
      }
      child.exitCode = 0;
      child.emit('exit', 0);
    });
  const pool = {
    setRuntimeEnabled() {},
    setRuntimePoolSize() {},
    setRuntimeProfileRoot() {},
    isEnabled: () => true,
    initBrowserPool: async () => {},
    acquireSlot: async () => ({ slotId: 1 }),
    clearTaskContexts: async () => true,
    releaseSlot() {}
  };
  const source = await fs.readFile(path.join(engine, 'worker.cjs'), 'utf8');
  runInNewContext(source, {
    module,
    __dirname: engine,
    process: { env: {}, stderr: { write() {} } },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    require(name) {
      if (name === './unpaid-validation.cjs') return require('../unpaid-validation.cjs');
      if (name === 'node:path') return path;
      if (name === 'node:crypto') return { createHash };
      if (name === 'node:fs/promises') return fs;
      if (name === 'node:os') return { hostname: () => 'synthetic-host' };
      if (name === 'node:net') return {};
      if (name === 'node:child_process') return { fork: () => child };
      if (name === './rpc.cjs')
        return {
          rpc: async (method, args) => {
            effects.push({ method, args });
            return { ok: true, id: 'synthetic-artifact' };
          }
        };
      if (name === './credentials.cjs') return { forgetTask() {} };
      if (name === './paths.cjs')
        return { runtimeRoot: () => root, mediaRoot: () => root, transientRoot: () => root };
      if (name === './security.cjs')
        return {
          sanitize: (value) => value,
          sanitizeResult: (value) => value,
          clearSensitive() {},
          rememberSecrets() {},
          redactText: (value) => value
        };
      if (name === './upstream/browser-pool') return pool;
      if (name === './upstream/browser-runtime') return { buildWorkerRuntimeEnv: (env) => env };
      throw Error(`Unexpected module ${name}`);
    }
  });
  return { ...module.exports, task, effects };
}

test('a masked capture writes a private completion receipt before media finish', async (t) => {
  const root = await directory(t),
    module = { exports: {} };
  runInNewContext(await fs.readFile(path.join(engine, 'safe-media.cjs'), 'utf8'), {
    module,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    process: { env: {} },
    require(name) {
      if (name === './paths.cjs') return { mediaRoot: () => root };
      return require(name);
    }
  });
  let captured = false;
  const page = {
    evaluate: async (fn) => (String(fn).includes('document.fonts') ? true : undefined),
    locator: (selector) => ({ selector }),
    screenshot: async (options) => {
      assert.match(options.mask[0].selector, /cc-number/);
      captured = true;
      return Buffer.from('synthetic masked capture');
    }
  };
  await module.exports.start();
  const file = await module.exports.screenshot(page, 'complete');
  assert.equal(captured, true);
  assert.ok(file);
  const proof = JSON.parse(await fs.readFile(`${file}.ready.json`, 'utf8'));
  assert.equal(proof.redacted, true);
  assert.equal(proof.name, path.basename(file));
  assert.equal(
    proof.sha256,
    createHash('sha256')
      .update(await fs.readFile(file))
      .digest('hex')
  );
  assert.equal((await fs.stat(`${file}.ready.json`)).mode & 0o777, 0o600);
});

test('recovery accepts only complete unchanged regular files in the task media directory', async (t) => {
  const root = await directory(t),
    w = await worker(root),
    dir = path.join(root, w.task.id);
  const valid = await completed(dir, 'complete.png');
  const changed = await completed(dir, 'changed.png');
  await fs.appendFile(changed, 'late');
  await fs.writeFile(path.join(dir, 'partial.webm'), 'partial');
  await fs.writeFile(path.join(dir, 'broken.png.ready.json'), '{');
  await fs.symlink(valid, path.join(dir, 'linked.png'));
  const proof = JSON.parse(await fs.readFile(`${valid}.ready.json`, 'utf8'));
  await fs.writeFile(
    path.join(dir, 'linked.png.ready.json'),
    JSON.stringify({ ...proof, name: 'linked.png' })
  );
  await fs.symlink(`${valid}.ready.json`, path.join(dir, 'marker.png.ready.json'));
  assert.deepEqual(Array.from(await w.completedEvidence(w.task, Date.now() + 1000)), [valid]);
  assert.deepEqual(Array.from(await w.completedEvidence(w.task, Date.now() - 1)), []);
});

for (const duplicateIpc of [false, true])
  test(`child exit recovers receipts before finish and deduplicates IPC: ${duplicateIpc}`, async (t) => {
    const root = await directory(t),
      w = await worker(root, { duplicateIpc });
    await completed(path.join(root, w.task.id), 'complete.png');
    await w.runJob(w.task, { browserPool: { enabled: true, size: 1 } });
    const uploads = w.effects.filter((item) => item.method === 'evidenceUpload');
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].args.redacted, true);
    const finish = w.effects.find((item) => item.method === 'completeJob');
    assert.equal(finish.args.evidence.length, 1);
    assert.equal(finish.args.executorTerminated, true);
    assert.ok(w.effects.indexOf(uploads[0]) < w.effects.indexOf(finish));
  });

test('an expired unconfirmed lease cannot recover or upload a completed file', async (t) => {
  const root = await directory(t),
    w = await worker(root);
  await completed(path.join(root, w.task.id), 'complete.png');
  w.task.leaseExpiresAt = new Date(Date.now() - 1).toISOString();
  await w.runJob(w.task, { browserPool: { enabled: true, size: 1 } });
  assert.equal(
    w.effects.some((item) => ['evidenceUpload', 'completeJob', 'failJob'].includes(item.method)),
    false
  );
});
