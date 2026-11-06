import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';

const exec = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sourceRoot = resolve(projectRoot, '.upstream/codexdaichong');
const runtimeRoot = resolve(projectRoot, '.runtime');

export const CODEXDAICHONG_REVISION = 'f4d7761e0036892e6dd68ec64c5447b513ca37da';

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
  return adaptLocalCheckoutDebugServer(result);
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

function waitForExit(child, message) {
  return new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) done();
      else reject(new Error(message));
    });
  });
}

async function extractPinnedSource(directory) {
  const archive = spawn(
    'git',
    ['-C', sourceRoot, 'archive', '--format=tar', CODEXDAICHONG_REVISION],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const extract = spawn('tar', ['-xf', '-', '-C', directory], {
    stdio: ['pipe', 'ignore', 'inherit']
  });
  await Promise.all([
    waitForExit(archive, '无法读取锁定的上游源码'),
    waitForExit(extract, '无法解包上游源码'),
    pipeline(archive.stdout, extract.stdin)
  ]);
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
  await exec(process.execPath, ['--check', bridgePath]);
  await exec(process.execPath, ['--check', serverPath]);
  await exec(process.execPath, ['--check', workerPath]);
  await writeFile(
    resolve(destination, '.id-business-integrated-runtime'),
    CODEXDAICHONG_REVISION + '\n',
    { flag: 'wx' }
  );
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
