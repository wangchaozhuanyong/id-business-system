import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { reportColumns } from '../server/backup/sheets-source.mjs';
import { createWorkerReceipt, sheetsReceiptMaxAge } from '../server/monitoring-worker-receipts.mjs';
import { createSheetsStatusHandler, sheetsStatusRoute } from '../server/tools/sheets-status.mjs';

const host = 'admin.example.test';
const origin = 'https://' + host;
const admin = { id: 'fixture-admin', role: 'admin' };
const now = Date.parse('2026-11-12T03:00:00Z');

async function read(handler, actor = admin, request = {}) {
  const headers = {};
  let status, body;
  await handler({ method: 'GET', url: sheetsStatusRoute, headers: { host }, ...request }, {
    setHeader(name, value) { headers[name] = value; },
    writeHead(code, fields) { status = code; Object.assign(headers, fields); },
    end(payload) { body = JSON.parse(payload); }
  }, actor);
  return { status, headers, body };
}

test('status uses the existing worker receipt, keeps the last success, and reports stale evidence', async (t) => {
  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true });
  const directory = await realpath(await mkdtemp(join(runtime, 'sheets-status-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDirectory = join(directory, 'unused-business-source');
  let tick = now - 10_000, current = now;
  const publish = createWorkerReceipt(directory, 'sheets', dataDirectory, () => tick);
  const options = { receiptDirectory: directory, dataDirectory, publicOrigin: origin, clock: () => current };
  const handler = createSheetsStatusHandler(options);
  const tabs = Object.entries(reportColumns).map(([name, columns]) => ({ name, columns }));
  const empty = { reportedAt: null, verifiedAt: null, failures: null, tabs };
  assert.deepEqual((await read(createSheetsStatusHandler({ ...options, receiptDirectory: dataDirectory }))).body,
    { state: 'unconfigured', ...empty });
  assert.deepEqual((await read(handler)).body, { state: 'no_receipt', ...empty });
  await publish();
  assert.deepEqual((await read(handler)).body, { state: 'waiting', reportedAt: tick, verifiedAt: null, failures: 0, tabs });

  const verifiedAt = ++tick;
  await publish({ verified: true });
  assert.deepEqual((await read(handler)).body,
    { state: 'healthy', reportedAt: tick, verifiedAt, failures: 0, tabs });
  tick++;
  await publish({ failures: 1 });
  assert.deepEqual((await read(handler)).body,
    { state: 'retrying', reportedAt: tick, verifiedAt, failures: 1, tabs });
  tick++;
  await publish({ failures: 3 });
  assert.deepEqual((await read(handler)).body,
    { state: 'failed', reportedAt: tick, verifiedAt, failures: 3, tabs });
  current = tick + sheetsReceiptMaxAge + 1;
  assert.deepEqual((await read(handler)).body,
    { state: 'stale', reportedAt: tick, verifiedAt, failures: 3, tabs });

  const receipt = join(directory, 'monitoring-sheets.json');
  await writeFile(receipt, JSON.stringify({
    at: current + 61_000, verifiedAt: current, failures: 0, integrityFailure: false, privatePath: 'fixture-only'
  }));
  assert.deepEqual((await read(handler)).body, { state: 'no_receipt', ...empty });
  current += 61_000;
  await writeFile(receipt, JSON.stringify({ at: current + 61_000, verifiedAt: null, failures: 0, integrityFailure: false }));
  assert.deepEqual((await read(handler)).body, { state: 'stale', ...empty });
  await writeFile(receipt, JSON.stringify({
    at: current, verifiedAt: current, failures: 0, integrityFailure: true, privatePath: 'fixture-only'
  }));
  assert.deepEqual((await read(handler)).body,
    { state: 'failed', reportedAt: current, verifiedAt: current, failures: 0, tabs });
});

test('status is a private, same-origin GET with the existing administrator role boundary', async () => {
  const handler = createSheetsStatusHandler({ publicOrigin: origin });
  assert.equal((await read(handler, null)).status, 401);
  const denied = await read(handler, { id: 'fixture-employee', role: 'employee' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.tabs, undefined);
  assert.equal((await read(handler, admin, { headers: { host, origin: 'https://other.example.test' } })).status, 403);
  assert.equal((await read(handler, admin, { headers: { host, 'sec-fetch-site': 'same-site' } })).status, 403);
  const mutation = await read(handler, admin, { method: 'POST' });
  assert.equal(mutation.status, 405);
  assert.equal(mutation.headers.Allow, 'GET');
  const response = await read(handler, { id: 'fixture-super', role: 'super' });
  assert.equal(response.status, 200);
  assert.equal(response.headers['Cache-Control'], 'private, no-store');
});

test('the production read-only collector can supply status without a dedicated worker mount', async () => {
  const directory = fileURLToPath(new URL('../.runtime/collector-fixture', import.meta.url));
  let received = 0;
  const handler = createSheetsStatusHandler({
    collectorDirectory: directory,
    dataDirectory: join(directory, 'separate-data'),
    clock: () => now,
    readCollectorReceipt: (path) => {
      assert.equal(path, directory);
      received++;
      return { at: now, verifiedAt: now - 60_000, failures: 1, integrityFailure: false };
    }
  });
  assert.equal((await read(handler, { id: 'fixture-employee', role: 'employee' })).status, 403);
  assert.equal(received, 0);
  const { status, body } = await read(handler);
  assert.equal(status, 200);
  assert.equal(received, 1);
  assert.equal(body.state, 'retrying');
  assert.equal(body.verifiedAt, now - 60_000);
});
