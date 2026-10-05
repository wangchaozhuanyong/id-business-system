import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildHistoricalCashStdinPackage } from './historical-cash-package.mjs';
import { projectRoot } from './historical-cash-runner.mjs';

function runSource(source) {
  const secretFixture = 'synthetic-only-secret';
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    input: source,
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: `mysql://fake:${secretFixture}@invalid.invalid/test` },
    encoding: 'utf8',
    timeout: 15_000
  });
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secretFixture));
  return result;
}

test('stdin template requires an approved observed release and image before connecting', async () => {
  const packageResult = await buildHistoricalCashStdinPackage({ runtimeRoot: projectRoot });
  const result = runSource(packageResult.source);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false,
    code: 'APPROVED_RUNTIME_IDENTITY_REQUIRED'
  });
  assert.equal(result.stdout, '');
});

test('compiled service tampering is rejected before loading the writer client', async () => {
  const releaseSHA = 'a'.repeat(40);
  const apiImage = `sha256:${'b'.repeat(64)}`;
  const packageResult = await buildHistoricalCashStdinPackage({
    runtimeRoot: projectRoot,
    expectedReleaseSHA: releaseSHA,
    expectedApiImage: apiImage,
    observedRuntime: { releaseSHA, apiImage }
  });
  const originalHash = Object.values(packageResult.envelope.compiledServiceHashes)[0];
  const result = runSource(packageResult.source.replace(originalHash, 'c'.repeat(64)));
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false,
    code: 'COMPILED_SERVICE_HASH_MISMATCH'
  });
});

test('an unfrozen plan cannot execute even when runtime identity and compiled code match', async () => {
  const releaseSHA = 'a'.repeat(40);
  const apiImage = `sha256:${'b'.repeat(64)}`;
  const packageResult = await buildHistoricalCashStdinPackage({
    runtimeRoot: projectRoot,
    expectedReleaseSHA: releaseSHA,
    expectedApiImage: apiImage,
    observedRuntime: { releaseSHA, apiImage }
  });
  const result = runSource(packageResult.source);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false,
    code: 'APPROVED_FROZEN_BATCH_REQUIRED'
  });
});

test('readonly preview refuses unknown facts before connecting to an auditor', async () => {
  const releaseSHA = 'a'.repeat(40);
  const apiImage = `sha256:${'b'.repeat(64)}`;
  const packageResult = await buildHistoricalCashStdinPackage({
    mode: 'preview',
    offlinePreview: { factsComplete: false },
    runtimeRoot: projectRoot,
    expectedReleaseSHA: releaseSHA,
    expectedApiImage: apiImage,
    observedRuntime: { releaseSHA, apiImage }
  });
  const result = runSource(packageResult.source);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false,
    code: 'FACTS_REQUIRED_FOR_LIVE_PREVIEW'
  });
});
