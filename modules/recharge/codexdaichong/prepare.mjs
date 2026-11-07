import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sourceRoot = resolve(projectRoot, '.upstream/codexdaichong');
const runtimeRoot = resolve(projectRoot, '.runtime');

export const CODEXDAICHONG_REVISION = 'f4d7761e0036892e6dd68ec64c5447b513ca37da';
export const PRODUCTION_GUARD_REVISION = '1';

function replaceSource(source, oldText, newText) {
  const offset = source.indexOf(oldText);
  if (offset === -1 || source.indexOf(oldText, offset + oldText.length) !== -1) {
    throw new Error('上游源码与锁定版本的适配点不一致');
  }
  return source.slice(0, offset) + newText + source.slice(offset + oldText.length);
}

function replaceSection(source, start, end, replacement) {
  const from = source.indexOf(start);
  const to = from >= 0 ? source.indexOf(end, from + start.length) : -1;
  if (from === -1 || to === -1 || source.indexOf(start, from + start.length) !== -1) {
    throw new Error('上游源码与锁定版本的适配区段不一致');
  }
  return source.slice(0, from) + replacement + '\n\n' + source.slice(to);
}

export function adaptCodexdaichongServer(source) {
  let result = replaceSource(
    source,
    "const express = require('express');",
    "const integratedBridge = require('./upstream-bridge.cjs');\nconst express = require('express');"
  );
  result = replaceSource(
    result,
    'const app = express();',
    'const app = express();\napp.use(integratedBridge.requireGateway);'
  );
  result = replaceSource(
    result,
    'const requireSecondaryAuth = adminAuth.createRequireSecondaryAuth(store, ensureStoreReady);',
    'const requireSecondaryAuth = integratedBridge.requireSensitive;'
  );
  result = replaceSection(
    result,
    'function getBearerToken(req) {',
    "const CDK_PREFIX = 'KC-';",
    'const authenticateAdmin = integratedBridge.authenticateAdmin;'
  );
  result = replaceSection(
    result,
    "app.use(async (req, res, next) => {\n    if (req.method !== 'GET')",
    "app.use(express.static(path.join(__dirname, 'public')));",
    '// 页面由统一站点提供；此服务处理经过内部签名验证的请求。'
  );
  result = replaceSection(
    result,
    "app.get('/api/admin/session', (req, res) => {",
    "app.get('/api/admin/security/status'",
    `app.get('/api/admin/session', (req, res) => {
    return res.json({
        success: true,
        refreshed: false,
        token: null,
        expiresAt: null,
        issuedAt: null,
        permissions: ['admin'],
        email: req.admin.email
    });
});`
  );
  result = replaceSource(
    result,
    'const server = app.listen(PORT, () => {',
    "const server = app.listen(PORT, '127.0.0.1', () => {"
  );
  result = replaceSource(
    result,
    'new WebSocket.Server({ server, maxPayload: 64 * 1024 })',
    'new WebSocket.Server({ server, maxPayload: 64 * 1024, verifyClient: integratedBridge.verifyWebSocket })'
  );
  result = replaceSource(
    result,
    "const integratedBridge = require('./upstream-bridge.cjs');",
    "const integratedBridge = require('./upstream-bridge.cjs');\nintegratedBridge.requireDedicatedRuntime();"
  );
  result = replaceSource(
    result,
    '    // 启动时把所有遗留的 in_use 锁清空',
    "    if (process.env.ID_RECHARGE_RUNTIME_MODE !== 'production') {\n    // 启动时把所有遗留的 in_use 锁清空"
  );
  result = replaceSource(
    result,
    "    const server = app.listen(PORT, '127.0.0.1', () => {",
    "    }\n\n    const server = app.listen(PORT, '127.0.0.1', () => {"
  );
  return adaptVendureActivation(adaptLocalCheckoutDebugServer(result));
}

function adaptVendureActivation(source) {
  source = replaceSource(source, "app.get('/api/public/runtime', async (req, res) => {",
    `app.get('/api/public/runtime', async (req, res) => {
    if (req.idRechargeActor?.id === 'vendure-recharge-executor') res.set('X-ID-Vendure-Plan-Lock', '1');`);
  const start = source.indexOf('async function handleActivationRequest(req, res) {');
  const end = source.indexOf("app.post('/api/run-process',", start);
  if (start < 0 || end < 0) throw new Error('上游开通入口版本不符');
  let handler = source.slice(start, end);
  handler = replaceSource(handler, "    const cdk = String(req.body?.cdk || '').trim();",
    `    const cdk = String(req.body?.cdk || '').trim();
    const vendure = req.idRechargeActor?.id === 'vendure-recharge-executor';
    const expectedPlan = vendure ? req.body?.expectedPlan : undefined;
    if (vendure && !['plus', 'pro_5x', 'pro_20x'].includes(expectedPlan)) {
        return res.status(400).json({ success: false, message: '商城套餐无效' });
    }`);
  handler = replaceSource(handler, '        if (runningTask) {', `        if (runningTask) {
            if (vendure) return res.status(409).json({ success: false, message: '需核对已存在的开通任务' });`);
  handler = replaceSource(handler, "        const rawPlanType = String(cdkDetails.plan_type || 'plus').trim();",
    `        const rawPlanType = String(cdkDetails.plan_type || 'plus').trim();
        if (vendure && cdkDetails.plan_type !== expectedPlan) {
            return res.status(409).json({ success: false, message: '兑换码套餐已经变化' });
        }`);
  handler = replaceSource(handler, 'await store.markCdkUsed(cdk)', 'await store.markCdkUsed(cdk, expectedPlan)');
  handler = replaceSource(handler,
    '    console.log(`[Activation] 收到开通请求 path=${req.path} cdk=${cdk}',
    '    console.log(`[Activation] 收到开通请求 path=${req.path} cdk=${vendure ? "[商城]" : cdk}');
  handler = replaceSource(handler,
    'logTask(task.jobKey, `任务已创建，CDK=${cdk}',
    'logTask(task.jobKey, `任务已创建，CDK=${vendure ? "[商城]" : cdk}');
  handler = replaceSource(handler, '        if (!useGptApi) {', `        if (vendure && useGptApi) {
            return res.status(503).json({ success: false, message: '商城供应商通道尚未验收' });
        }
        if (!useGptApi) {`);
  handler = replaceSource(handler, 'sessionPayload: storedSession,', 'sessionPayload: vendure ? null : storedSession,');
  handler = replaceSource(handler, 'tokenPreview: extractSessionPreview(storedSession),',
    "tokenPreview: vendure ? '' : extractSessionPreview(storedSession),");
  handler = replaceSource(handler, "fireTelegramNotification('card_pool_empty', {",
    "if (!vendure) fireTelegramNotification('card_pool_empty', {");
  handler = replaceSource(handler, 'cdkDetails, clientIp });', 'cdkDetails, clientIp, vendure });');
  handler = replaceSource(handler, 'try { await store.markCdkUnused(cdk); } catch (_) { }',
    'if (!vendure) { try { await store.markCdkUnused(cdk); } catch (_) { } }');
  const activationSource = source.slice(0, start) + handler + source.slice(end);
  const workerStart = activationSource.indexOf('function spawnActivationWorker(');
  const workerEnd = activationSource.indexOf('async function handleActivationRequest(', workerStart);
  if (workerStart < 0 || workerEnd < 0) throw new Error('上游执行入口版本不符');
  let worker = activationSource.slice(workerStart, workerEnd);
  worker = replaceSource(worker, 'cdkDetails, clientIp })', 'cdkDetails, clientIp, vendure = false })');
  worker = replaceSource(worker, 'let shouldRollbackCdk = true;', 'let shouldRollbackCdk = !vendure;');
  worker = replaceSource(worker, '        try {\n            for (let attempt = 1; attempt <= MAX_PROCESS_ATTEMPTS; attempt += 1) {',
    `        const maxAttempts = vendure ? 1 : MAX_PROCESS_ATTEMPTS;
        try {
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {`);
  worker = replaceSource(worker, 'attempt >= MAX_PROCESS_ATTEMPTS', 'attempt >= maxAttempts');
  worker = replaceSource(worker, '${attempt}/${MAX_PROCESS_ATTEMPTS}', '${attempt}/${maxAttempts}');
  worker = replaceSource(worker, '                    JOB_KEY: task.jobKey,',
    "                    JOB_KEY: task.jobKey,\n                    ID_VENDURE_SINGLE_ATTEMPT: vendure ? '1' : '',");
  worker = replaceSource(worker, "if (finalStatus !== 'success') {\n                await store.markCdkUnused(cdk);",
    "if (!vendure && finalStatus !== 'success') {\n                await store.markCdkUnused(cdk);");
  worker = worker.replaceAll('notifyTaskOutcome({', 'if (!vendure) notifyTaskOutcome({');
  return activationSource.slice(0, workerStart) + worker + activationSource.slice(workerEnd);
}

function adaptVendureCdkLock(source) {
  const start = source.indexOf('async function markCdkUsed(cdk) {');
  const end = source.indexOf('async function markCdkUnused(cdk) {', start);
  if (start < 0 || end < 0) throw new Error('上游兑换码锁版本不符');
  let lock = source.slice(start, end);
  lock = replaceSource(lock, 'markCdkUsed(cdk)', 'markCdkUsed(cdk, expectedPlan)');
  lock = replaceSource(lock, 'AND used_at IS NULL`,\n        [String(cdk)]',
    'AND used_at IS NULL\n           AND (? IS NULL OR (CAST(plan_type AS BINARY) = CAST(? AS BINARY) AND type = \'自助\'))`,\n        [String(cdk), expectedPlan ?? null, expectedPlan ?? null]');
  return source.slice(0, start) + lock + source.slice(end);
}

function protectProductionAssetReservations(source) {
  const condition = 'AND (in_use = 0 OR locked_at IS NULL OR locked_at < ?)';
  const reserveOnlyFree = 'AND (in_use = 0 OR (? AND (locked_at IS NULL OR locked_at < ?)))';
  const staleArgs = '[staleThreshold]';
  const reserveArgs = "[process.env.ID_RECHARGE_RUNTIME_MODE !== 'production', staleThreshold]";
  for (const [name, next] of [
    ['reserveAssetRow', 'reserveRuntimeAssets'],
    ['reservePoolEmail', 'releasePoolEmailReservation']
  ]) {
    const start = source.indexOf('async function ' + name + '(');
    const end = source.indexOf('async function ' + next + '(', start);
    if (start < 0 || end < 0) throw new Error('上游资产占用版本不符');
    const section = replaceSource(replaceSource(source.slice(start, end), condition, reserveOnlyFree),
      staleArgs, reserveArgs);
    source = source.slice(0, start) + section + source.slice(end);
  }
  return source;
}

function adaptVendureCardAttempts(source) {
  source = replaceSource(source, '    const screenshots = [];', `    const maxCardAttempts =
        process.env.ID_VENDURE_SINGLE_ATTEMPT === '1' ? 1 : MAX_CARD_ATTEMPTS;
    const screenshots = [];`);
  source = replaceSource(source, '${MAX_CARD_ATTEMPTS} 张卡', '${maxCardAttempts} 张卡');
  source = replaceSource(source, '${cardAttempt}/${MAX_CARD_ATTEMPTS}', '${cardAttempt}/${maxCardAttempts}');
  source = replaceSource(source, 'cardAttempt < MAX_CARD_ATTEMPTS', 'cardAttempt < maxCardAttempts');
  source = replaceSource(source, 'cardAttempt <= MAX_CARD_ATTEMPTS', 'cardAttempt <= maxCardAttempts');
  return source;
}

export function adaptLocalCheckoutDebugServer(source) {
  const anchor = "const checkoutScript = path.join(__dirname, 'index.js');\n        try {\n            const proxy = await store.getActiveProxy();";
  return replaceSource(source, anchor, anchor.replace(
    'const proxy = await store.getActiveProxy();',
    "const proxy = process.env.ID_RECHARGE_CHECKOUT_DEBUG_PROXY || await store.getActiveProxy();"
  ));
}

export function adaptLocalCheckoutDebugWorker(source) {
  return replaceSource(
    source,
    '// --- Phase 0: Proxy Connectivity Check ---\n        if (proxyConfig) {',
    '// The local debug proxy already checks the destination when opening the session page.\n' +
      "        const localDebugProxy = process.env.CHECKOUT_DEBUG_ONLY === '1' && process.env.ID_RECHARGE_CHECKOUT_DEBUG_PROXY;\n" +
      '        if (proxyConfig && !localDebugProxy) {'
  );
}

function isDescendant(base, target) {
  const path = relative(base, target);
  return path !== '' && path !== '..' && !path.startsWith('../') && !isAbsolute(path);
}

async function extractPinnedSource(directory) {
  // tar may exit after its end marker before git's trailing padding drains into
  // stdin. A completed archive file makes extraction independent of pipe timing.
  const temporary = await mkdtemp(resolve(runtimeRoot, 'pinned-source-'));
  const archive = resolve(temporary, 'source.tar');
  try {
    await exec('git', ['-C', sourceRoot, 'archive', '--format=tar', '--output', archive, CODEXDAICHONG_REVISION]);
    await exec('tar', ['-xf', archive, '-C', directory]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function prepareCodexdaichong(outputDir = resolve(runtimeRoot, 'codexdaichong')) {
  const destination = resolve(outputDir);
  if (!isDescendant(runtimeRoot, destination)) {
    throw new Error('运行副本须放在本项目的 .runtime 下');
  }
  const { stdout } = await exec('git', [
    '-C',
    sourceRoot,
    'rev-parse',
    CODEXDAICHONG_REVISION + '^{commit}'
  ]);
  if (stdout.trim() !== CODEXDAICHONG_REVISION) {
    throw new Error('未找到锁定的线上代充源码');
  }

  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const realRuntimeRoot = await realpath(runtimeRoot);
  const realProjectRoot = await realpath(projectRoot);
  if (realRuntimeRoot !== resolve(realProjectRoot, '.runtime')) {
    throw new Error('运行副本目录不能是符号链接');
  }
  const parent = await realpath(dirname(destination));
  if (parent !== realRuntimeRoot && !isDescendant(realRuntimeRoot, parent)) {
    throw new Error('运行副本的父目录不在本项目 .runtime 下');
  }
  await mkdir(destination, { mode: 0o700 });
  await extractPinnedSource(destination);

  const bridgePath = resolve(destination, 'upstream-bridge.cjs');
  await writeFile(bridgePath, await readFile(new URL('./upstream-bridge.cjs', import.meta.url)), {
    flag: 'wx'
  });
  const serverPath = resolve(destination, 'server.js');
  await writeFile(serverPath, adaptCodexdaichongServer(await readFile(serverPath, 'utf8')));
  const workerPath = resolve(destination, 'index.js');
  await writeFile(workerPath, adaptLocalCheckoutDebugWorker(await readFile(workerPath, 'utf8')));
  const storePath = resolve(destination, 'mysql-store.js');
  await writeFile(storePath, protectProductionAssetReservations(adaptVendureCdkLock(await readFile(storePath, 'utf8'))));
  const paymentPath = resolve(destination, 'payment-retry.js');
  await writeFile(paymentPath, adaptVendureCardAttempts(await readFile(paymentPath, 'utf8')));
  await exec(process.execPath, ['--check', bridgePath]);
  await exec(process.execPath, ['--check', serverPath]);
  await exec(process.execPath, ['--check', workerPath]);
  await exec(process.execPath, ['--check', storePath]);
  await exec(process.execPath, ['--check', paymentPath]);
  await writeFile(
    resolve(destination, '.id-business-integrated-runtime'),
    CODEXDAICHONG_REVISION + '\n',
    { flag: 'wx' }
  );
  await writeFile(resolve(destination, '.id-business-production-guard'), PRODUCTION_GUARD_REVISION + '\n', { flag: 'wx' });
  return destination;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const directory = await prepareCodexdaichong(process.argv[2]);
    console.log('线上代充隔离运行副本已准备：' + directory);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
