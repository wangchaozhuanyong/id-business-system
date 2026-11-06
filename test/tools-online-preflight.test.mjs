import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { preflightOnlineTools } from '../server/tools/online-tools-preflight.mjs';

const secretMarker = 'synthetic-preflight-secret-never-in-output';
const cli = fileURLToPath(new URL('../server/tools/online-tools-preflight.mjs', import.meta.url));
const workspace = fileURLToPath(new URL('../', import.meta.url));
const preview = 'http://127.0.0.1:4348';

function runCli(...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: workspace, encoding: 'utf8' });
}

async function testDirectory(t) {
  const root = join(workspace, '.runtime');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, 'tools-preflight-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fixture(dir, name, text, mode = 0o600) {
  const path = join(dir, name);
  await writeFile(path, text, { flag: 'wx', mode });
  await chmod(path, mode);
  return path;
}

async function withWorker(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

test('CLI classifies four missing inputs and rejects invalid arguments without echoing them', () => {
  const empty = runCli();
  assert.equal(empty.status, 2);
  const report = JSON.parse(empty.stdout);
  assert.deepEqual(report.counts, { valid: 0, missing: 4, invalid: 0, unavailable: 0 });
  for (const result of Object.values(report.tools)) {
    assert.equal(result.issues[0].code, 'OPTION_MISSING');
    assert.ok(result.needsForRealIntegration.length);
    assert.equal(result.realIntegration, 'not_verified');
  }
  assert.equal(runCli('--help').status, 0);
  const bad = runCli('--preview-origin', 'https://' + secretMarker + '.example.test');
  assert.equal(bad.status, 1);
  assert.doesNotMatch(bad.stdout + bad.stderr, new RegExp(secretMarker));
});

test('private synthetic inputs pass runtime checks without network or outputting credentials and paths', async (t) => {
  const dir = await testDirectory(t);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ga4 = await fixture(dir, 'analytics.json', JSON.stringify({
    type: 'service_account', client_email: 'synthetic@example.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' })
  }));
  const visits = await fixture(dir, 'visits.txt', secretMarker);
  const microsoft = await fixture(dir, 'microsoft.json', JSON.stringify({
    clientId: 'bf8dd7d2-8387-4c86-8133-eb267c62d508', clientSecret: secretMarker,
    redirectUri: preview + '/api/local/tools/mailbox-microsoft/callback'
  }));
  let requests = 0;
  const worker = await withWorker(t, (_req, res) => {
    requests++;
    res.end();
  });
  const passed = runCli(
    '--website-analytics-config', ga4,
    '--website-visits-secret-file', visits,
    '--microsoft-mailbox-config', microsoft,
    '--media-resolver-url', worker,
    '--preview-origin', preview
  );
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(requests, 0);
  const result = JSON.parse(passed.stdout);
  assert.deepEqual(result.counts, { valid: 4, missing: 0, invalid: 0, unavailable: 0 });
  assert.equal(result.tools.mediaResolver.checks.loopbackHealth, 'not_requested');
  assert.equal(result.tools.microsoftMailbox.checks.callbackOrigin, 'passed');
  for (const privateValue of [dir, worker, secretMarker, 'PRIVATE KEY', 'example.iam.gserviceaccount.com']) {
    assert.ok(!(passed.stdout + passed.stderr).includes(privateValue));
  }
});

test('public preflight requires explicit HTTPS and validates the deployed Microsoft callback without connecting', async (t) => {
  const dir = await testDirectory(t);
  const publicOrigin = 'https://admin.example.test';
  const config = await fixture(dir, 'microsoft.json', JSON.stringify({
    clientId: 'bf8dd7d2-8387-4c86-8133-eb267c62d508', clientSecret: secretMarker,
    redirectUri: publicOrigin + '/api/public/mailbox/microsoft-oauth/callback'
  }));
  const read = (...options) => runCli('--microsoft-mailbox-config', config, ...options);
  const passed = read('--public-origin', publicOrigin);
  assert.equal(passed.status, 2, passed.stderr);
  const result = JSON.parse(passed.stdout);
  assert.equal(result.scope, 'public_config_preflight');
  assert.equal(result.tools.microsoftMailbox.status, 'valid');
  assert.equal(result.tools.microsoftMailbox.checks.callbackOrigin, 'passed');
  assert.equal(result.tools.microsoftMailbox.realIntegration, 'not_verified');
  assert.ok(!passed.stdout.includes(publicOrigin) && !passed.stdout.includes(secretMarker));
  for (const options of [[], ['--public-origin', 'https://other.example.test']]) {
    assert.equal(JSON.parse(read(...options).stdout).tools.microsoftMailbox.status, 'invalid');
  }
  for (const invalid of ['http://admin.example.test', publicOrigin + '/api', publicOrigin + '?', 'https://user@admin.example.test']) {
    assert.equal(read('--public-origin', invalid).status, 1);
  }
  assert.equal(read('--public-origin', publicOrigin, '--preview-origin', preview).status, 1);
});

test('public route checks issue only two safe GETs and reject redirects or missing endpoints', async () => {
  const publicOrigin = 'https://admin.example.test';
  const options = { 'public-origin': publicOrigin, 'probe-public-routes': true };
  const microsoftPath = '/api/public/mailbox/microsoft-oauth/callback';
  const visitPath = '/api/id-business-v2/workspace-website-monitor/visits/ingest';
  const requests = [];
  const report = await preflightOnlineTools(options, {
    fetchImpl: async (url, request) => {
      requests.push([url.href, request.method, request.redirect, request.body]);
      if (url.pathname === microsoftPath)
        return new Response('<h1>未授权</h1>', { status: 400, headers: { 'Content-Type': 'text/html' } });
      return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    }
  });
  assert.deepEqual(requests, [
    [publicOrigin + microsoftPath, 'GET', 'manual', undefined],
    [publicOrigin + visitPath, 'GET', 'manual', undefined]
  ]);
  assert.deepEqual(report.publicRoutes, { microsoftCallback: 'passed', visitIngest: 'passed' });
  const unready = await preflightOnlineTools(options, {
    fetchImpl: async (url) => url.pathname === microsoftPath
      ? Response.redirect(publicOrigin + '/login')
      : new Response(null, { status: 404 })
  });
  assert.deepEqual(unready.publicRoutes, {
    microsoftCallback: 'unexpected_response', visitIngest: 'unexpected_response'
  });
  assert.equal(runCli('--probe-public-routes').status, 1);
});

test('insecure files, missing fields, invalid key and callback origin mismatch are distinct failures', async (t) => {
  const dir = await testDirectory(t);
  const badGa4 = await fixture(dir, 'analytics-missing.json', '{"propertyId":"100"}');
  const badVisits = await fixture(dir, 'too-permissive.txt', secretMarker, 0o644);
  const callback = await fixture(dir, 'microsoft.json', JSON.stringify({
    clientId: 'bf8dd7d2-8387-4c86-8133-eb267c62d508', clientSecret: secretMarker,
    redirectUri: 'http://localhost:4348/api/local/tools/mailbox-microsoft/callback'
  }));
  const result = await preflightOnlineTools({
    'website-analytics-config': badGa4, 'website-visits-secret-file': badVisits,
    'microsoft-mailbox-config': callback, 'preview-origin': preview
  });
  assert.equal(result.tools.websiteVisits.issues[0].code, 'CONFIG_FILE_REJECTED');
  assert.deepEqual(result.tools.websiteAnalytics.issues[0].fields, [
    'streamId', 'hosts', 'serviceAccount.type', 'serviceAccount.client_email', 'serviceAccount.private_key'
  ]);
  assert.equal(result.tools.microsoftMailbox.issues[0].code, 'CALLBACK_ORIGIN_MISMATCH');
  assert.ok(!JSON.stringify(result).includes(secretMarker));
  const brokenKey = await fixture(dir, 'broken-key.json', JSON.stringify({
    propertyId: '100', streamId: '200', hosts: ['example.test'],
    serviceAccount: { type: 'service_account', client_email: 'fake@example.iam.gserviceaccount.com', private_key: secretMarker }
  }));
  const bad = await preflightOnlineTools({ 'website-analytics-config': brokenKey });
  assert.equal(bad.tools.websiteAnalytics.issues[0].code, 'RUNTIME_CONFIG_INVALID');
  const badJson = await fixture(dir, 'broken-json.json', '{ "clientSecret": "' + secretMarker);
  const malformed = await preflightOnlineTools({ 'microsoft-mailbox-config': badJson });
  assert.equal(malformed.tools.microsoftMailbox.issues[0].code, 'CONFIG_FORMAT_INVALID');
  assert.ok(!JSON.stringify(malformed).includes(secretMarker));
});

test('media probes one GET on literal loopback only and rejects reserved ports, redirects and malformed health', async (t) => {
  const calls = [];
  let mode = 'ok';
  const origin = await withWorker(t, (req, res) => {
    calls.push([req.method, req.url, req.headers.authorization, req.headers.cookie]);
    if (mode === 'disconnect') {
      req.socket.destroy();
      return;
    }
    if (mode === 'redirect') {
      res.writeHead(302, { Location: origin + '/resolve' }).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      .end(mode === 'ok' ? '{"ok":true}' : mode === 'too_large' ? 'x'.repeat(1025) : '{"ok":false}');
  });
  const check = (address = origin, previewOrigin) => preflightOnlineTools({
    'media-resolver-url': address, 'preview-origin': previewOrigin, 'probe-media': true
  });
  for (const invalid of ['https://example.test:8080', 'http://2130706433:99', 'http://127.0.0.1:0', origin + '/resolve']) {
    assert.equal((await check(invalid)).tools.mediaResolver.issues[0].code, 'MEDIA_ORIGIN_INVALID');
  }
  assert.equal((await check('http://127.0.0.1:4348')).tools.mediaResolver.issues[0].code, 'MEDIA_PORT_CONFLICT');
  assert.equal((await check(origin, origin)).tools.mediaResolver.issues[0].code, 'MEDIA_PORT_CONFLICT');
  assert.equal(calls.length, 0);

  const passed = (await check()).tools.mediaResolver;
  assert.equal(passed.checks.loopbackHealth, 'passed');
  assert.equal(passed.realIntegration, 'not_verified');
  for (const next of ['redirect', 'too_large', 'invalid']) {
    mode = next;
    const failed = (await check()).tools.mediaResolver;
    assert.equal(failed.status, 'unavailable');
    assert.equal(failed.issues[0].code, 'MEDIA_HEALTH_INVALID');
  }
  mode = 'disconnect';
  assert.equal((await check()).tools.mediaResolver.issues[0].code, 'MEDIA_HEALTH_UNAVAILABLE');
  assert.deepEqual(calls, Array.from({ length: 5 }, () => ['GET', '/health', undefined, undefined]));
});
