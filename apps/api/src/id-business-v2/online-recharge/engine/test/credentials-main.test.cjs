'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
test('credentials-only main boots without RPC, browser or external execution', async () => {
  const child = spawn(
    process.execPath,
    [path.join(__dirname, '..', 'worker.cjs'), '--credentials-only'],
    {
      cwd: path.join(__dirname, '..'),
      env: {
        PATH: process.env.PATH,
        ONLINE_RECHARGE_WORKER_KEY: 'synthetic-internal-main-test-key-32-characters',
        ONLINE_RECHARGE_CREDENTIALS_URL: 'http://127.0.0.1:0',
        ONLINE_RECHARGE_ENGINE_ENABLED: '0'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
  const exit = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  try {
    const output = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('data', (data) => resolve(String(data)));
      child.once('exit', () => reject(new Error('listener exited before readiness')));
    });
    assert.match(output, /临时凭据服务已启动/);
    assert.doesNotMatch(output + stderr, /synthetic-internal/);
    child.kill('SIGTERM');
    assert.equal(await exit, 0);
    assert.equal(stderr, '');
  } finally {
    clearTimeout(timer);
    if (!child.killed) child.kill('SIGKILL');
  }
});
