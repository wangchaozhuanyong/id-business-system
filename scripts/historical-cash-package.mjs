#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { projectRoot, resolveProjectFile } from './historical-cash-runner.mjs';

export const historicalCashRuntimeFiles = [
  'apps/api/dist/id-business-v2/finance/public-api.js',
  'apps/api/dist/id-business-v2/finance/id-business-v2-historical-cash.service.js',
  'apps/api/dist/id-business-v2/finance/id-business-v2-historical-cash.types.js',
  'apps/api/dist/id-business-v2/finance/persistence/id-business-v2-historical-cash.repository.js',
  'apps/api/dist/id-business-v2/finance/persistence/id-business-v2-finance-historical-reversal.repository.js',
  'apps/api/dist/id-business-v2/finance/id-business-v2-finance-posting.service.js',
  'apps/api/dist/id-business-v2/finance/id-business-v2-finance-cash-cost.js',
  'apps/api/dist/id-business-v2/finance/persistence/id-business-v2-finance-command.repository.js',
  'apps/api/dist/id-business-v2/finance/persistence/id-business-v2-finance-posting.repository.js',
  'apps/api/dist/id-business-v2/finance/id-business-v2-finance-input.js',
  'apps/api/dist/id-business-v2/runtime/public-api.js',
  'apps/api/dist/id-business-v2/runtime/id-business-v2-decimal.js',
  'apps/api/dist/id-business-v2/runtime/id-business-v2-row-mapper.js',
  'apps/api/dist/id-business-v2/runtime/id-business-v2-prisma-error.js',
  'apps/api/dist/id-business-v2/runtime/id-business-v2-time.js',
  'apps/api/dist/id-business-v2/runtime/id-business-v2-command-transaction.service.js',
  'apps/api/dist/id-business-v2/runtime/persistence/id-business-v2-transactional-audit.repository.js',
  'apps/api/dist/common/prisma/mysql-transaction-lock.js',
  'apps/api/dist/common/prisma/prisma.service.js',
  'apps/api/dist/common/prisma/bump-v2-scope-versions.js',
  'apps/api/dist/audit-logs/audit-log-sanitizer.js',
  'apps/api/dist/v2-auth/v2-identity.service.js',
  'apps/api/dist/v2-auth/system-super-admin.js',
  'packages/shared/dist/v2/decimal.js',
  'packages/shared/dist/index.js'
];

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function buildHistoricalCashStdinPackage({
  mode = 'execute',
  frozenBatch = null,
  offlinePreview = null,
  sourceSnapshotJson = null,
  approvedBatchHash = null,
  operatorId = null,
  expectedReleaseSHA = null,
  expectedApiImage = null,
  observedRuntime = null,
  runtimeRoot = '/app'
} = {}) {
  if (![projectRoot, '/app'].includes(runtimeRoot)) throw new Error('INVALID_RUNTIME_ROOT');
  if (!['preview', 'execute'].includes(mode)) throw new Error('INVALID_PACKAGE_MODE');
  const source = readFileSync(path.join(projectRoot, 'scripts/historical-cash-runner.mjs'), 'utf8');
  const rootDeclaration =
    "export const projectRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));";
  const directInvocation =
    'if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))\n  await main();';
  if (!source.includes(rootDeclaration) || !source.includes(directInvocation))
    throw new Error('RUNNER_SOURCE_CHANGED');
  const envelope = {
    version: 1,
    mode,
    frozenBatch,
    offlinePreview,
    sourceSnapshotJson,
    approvedBatchHash,
    operatorId,
    expectedReleaseSHA,
    expectedApiImage,
    observedRuntime,
    compiledServiceHashes: Object.fromEntries(
      historicalCashRuntimeFiles.map((file) => [
        file,
        hash(readFileSync(path.join(projectRoot, file)))
      ])
    )
  };
  const result = await build({
    stdin: {
      contents: source
        .replace(
          rootDeclaration,
          `export const projectRoot = realpathSync(${JSON.stringify(runtimeRoot)});`
        )
        .replace(directInvocation, ''),
      resolveDir: path.join(projectRoot, 'scripts'),
      sourcefile: 'historical-cash-runner.mjs'
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    sourcemap: false
  });
  const entrySuffix = `
try {
  const expected = historicalCashReviewEnvelope;
  const observed = expected.observedRuntime;
  if (!/^[a-f0-9]{40}$/.test(expected.expectedReleaseSHA ?? '') ||
      !/^sha256:[a-f0-9]{64}$/.test(expected.expectedApiImage ?? '') ||
      observed?.releaseSHA !== expected.expectedReleaseSHA || observed?.apiImage !== expected.expectedApiImage) {
    throw new Error('APPROVED_RUNTIME_IDENTITY_REQUIRED');
  }
  for (const [file, expectedHash] of Object.entries(expected.compiledServiceHashes)) {
    if (sha256(readFileSync(path.join(projectRoot, file))) !== expectedHash) throw new Error('COMPILED_SERVICE_HASH_MISMATCH');
  }
  let result;
  if (expected.mode === 'preview') {
    const offline = expected.offlinePreview;
    if (!offline?.factsComplete || !offline.plan || offline.planHash !== sha256(canonicalJson(offline.plan)) ||
        typeof expected.sourceSnapshotJson !== 'string' || sha256(expected.sourceSnapshotJson) !== offline.plan.snapshotSha256) {
      const error = new Error('FACTS_REQUIRED_FOR_LIVE_PREVIEW'); error.runnerCode = error.message; throw error;
    }
    result = await createHistoricalCashLivePreview({'operator-id': expected.operatorId}, offline, JSON.parse(expected.sourceSnapshotJson));
  } else {
    result = await executeHistoricalCashFrozenBatch(expected.frozenBatch, expected.approvedBatchHash, expected.operatorId);
  }
  console.log(JSON.stringify({ok: true, verifiedReleaseSHA: observed.releaseSHA, verifiedApiImage: observed.apiImage, ...result}));
} catch (error) {
  const code = ['APPROVED_RUNTIME_IDENTITY_REQUIRED', 'COMPILED_SERVICE_HASH_MISMATCH'].includes(error?.message)
    ? error.message : error?.runnerCode ?? 'HISTORICAL_CASH_RUNTIME_FAILED';
  console.error(JSON.stringify({ok: false, code}));
  process.exitCode = 1;
}
`;
  const bundlePrefix = result.outputFiles[0].text;
  return {
    source: `${bundlePrefix}\nconst historicalCashReviewEnvelope = ${JSON.stringify(envelope, null, 2)};\n${entrySuffix}`,
    bundlePrefix,
    entrySuffix,
    envelope
  };
}

async function main() {
  try {
    const outputArgument = process.argv[2];
    if (!outputArgument || process.argv.length !== 3)
      throw new Error('PROJECT_OUTPUT_PATH_REQUIRED');
    const output = resolveProjectFile(outputArgument, true);
    const prepared = await buildHistoricalCashStdinPackage();
    writeFileSync(output, prepared.source, { flag: 'wx', mode: 0o600 });
    const manifest = `${output}.json`;
    writeFileSync(
      manifest,
      `${JSON.stringify({ mode: 'REVIEWABLE_STDIN_TEMPLATE_NOT_EXECUTED', sourceSha256: hash(prepared.source), expectedRuntime: { releaseSHA: null, apiImage: null }, compiledServiceHashes: prepared.envelope.compiledServiceHashes, frozenBatch: null, approvedBatchHash: null, productionWrites: 0, packagingRequiresNewApprovedRuntime: true }, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 }
    );
    const callPayload = `${output}.call.json`;
    writeFileSync(
      callPayload,
      `${JSON.stringify({ bundlePrefix: prepared.bundlePrefix, entrySuffix: prepared.entrySuffix, envelope: prepared.envelope, bundleSha256: hash(prepared.bundlePrefix), entrySha256: hash(prepared.entrySuffix) }, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 }
    );
    console.log(JSON.stringify({ ok: true, output, manifest, callPayload, productionWrites: 0 }));
  } catch {
    console.error(JSON.stringify({ ok: false, code: 'HISTORICAL_CASH_PACKAGE_NOT_READY' }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
