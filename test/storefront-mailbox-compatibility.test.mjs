import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { initializeLocalAdmin } from '../server/local-auth.mjs';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { startPreview } from '../server/preview.mjs';
import {
  applyMailboxPoolWrite, findMailboxQuery, managedMailboxDomain,
  managedMailboxQueryRoute, storefrontMailboxQueryRoute
} from '../server/tools/mailbox-pool.mjs';

const code = 'AbCdEfGhJkMnPqRsTuV2';
const newCode = 'MBX-' + 'F'.repeat(32);
const publicOrigin = 'https://id.example.test';
const expiry = '2099-12-31T00:00:00.123456+00:00';
const mail = {
  from: 'Fixture Sender <sender@example.test>', to: 'legacy@example.test',
  subject: '邮箱验证', body: '<p>验证码 472081</p><a href="https://example.test/verify?proof=fixture">验证</a>',
  receivedAt: '2026-11-06T11:05:00+08:00'
};

function savedMailbox(queryCode = code, overrides = {}) {
  return {
    id: randomUUID(), provider: 'google', active: true, email: 'legacy@example.test',
    queryCode, appPassword: 'fixture-mailbox-password',
    expiresAt: expiry, updatedAt: '2026-11-06T00:00:00Z',
    lastQueriedAt: '2026-11-05T23:00:00Z', ...overrides
  };
}

async function seedSavedMailboxes(database, items) {
  createLocalBusinessStore(database).close();
  const key = await readFile(database + '.key');
  const db = new DatabaseSync(database);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(managedMailboxDomain + ':1'));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify({ items, defaultValidDays: 30 })), cipher.final()]);
    db.prepare('INSERT INTO business_document (domain, version, payload) VALUES (?, 1, ?)')
      .run(managedMailboxDomain, Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
  } finally {
    key.fill(0);
    db.close();
  }
}

async function temporary(t) {
  const root = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, 'mailbox-compat-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('已保存的旧查询码继续遵守启停、授权、过期和重置规则', () => {
  const active = savedMailbox();
  const disabledCode = 'AbCdEfGhJkMnPqRsTuV3';
  const disabled = savedMailbox(disabledCode, { provider: 'apple', active: false, email: 'disabled@example.test' });
  const failedCode = 'AbCdEfGhJkMnPqRsTuV4';
  const failed = savedMailbox(failedCode, { provider: 'microsoft', authFailed: true, email: 'failed@example.test' });
  const expiredCode = 'AbCdEfGhJkMnPqRsTuV5';
  const expired = savedMailbox(expiredCode, { expiresAt: '2000-01-01T00:00:00Z' });
  const at = Date.parse('2026-11-13T00:00:00Z');
  const before = { version: 1, data: { items: [active, disabled, failed, expired], defaultValidDays: 30 } };
  assert.equal(findMailboxQuery(before, code, at).id, active.id);
  for (const rejected of [code.toLowerCase(), disabledCode, failedCode, expiredCode])
    assert.equal(findMailboxQuery(before, rejected, at), null);
  const { items, defaultValidDays, issuedCode } = applyMailboxPoolWrite(before, { action: 'rotate', version: 1, id: active.id }, at);
  const after = { version: 2, data: { items, defaultValidDays } };
  assert.equal(findMailboxQuery(after, code, at), null);
  assert.equal(findMailboxQuery(after, issuedCode, at).id, active.id);
});

function post(origin, path, body, headers, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, origin), {
      method, headers: { 'Content-Type': 'application/json', ...headers }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers,
          data: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : text });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('商城旧路径只接受配置的正式主机，旧码和新码均返回 Vendure 契约', async (t) => {
  const dir = await temporary(t);
  const authPath = join(dir, 'auth.json');
  const databasePath = join(dir, 'fixture.sqlite');
  await initializeLocalAdmin(authPath, {
    email: 'fixture-admin@example.test', name: '接口测试', password: 'fixture-local-test-password'
  });
  await seedSavedMailboxes(databasePath, [savedMailbox(), savedMailbox(newCode, { email: 'new@example.test' })]);
  const calls = [];
  const { server, url } = await startPreview(0, {
    databasePath, authPath, mailboxPublicOrigin: publicOrigin,
    readManagedMailbox: async (item) => { calls.push(item); return [{ ...mail, to: item.email }]; }
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const host = new URL(publicOrigin).host;
  const legacy = (queryCode, headers = {}) =>
    post(url, storefrontMailboxQueryRoute, { queryCode, limit: 5 }, { Host: host, ...headers });
  for (const [queryCode, email] of [[code, 'legacy@example.test'], [newCode, 'new@example.test']]) {
    const result = await legacy(queryCode);
    assert.equal(result.status, 200);
    assert.equal(result.headers['cache-control'], 'private, no-store');
    assert.equal(result.data.success, true);
    assert.equal(result.data.data.email, email);
    assert.deepEqual(result.data.data.items, [{
      from: mail.from, to: email, subject: mail.subject, body: mail.body, savedAt: '2026-11-06T03:05:00.000Z'
    }]);
    assert.equal(calls.at(-1).storefront, true);
    assert.equal(calls.at(-1).limit, 5);
  }
  for (const rejected of ['BUY-fixture123', 'MSTR-fixture123', 'AbCdEfGhJkMnPqRsTuV9'])
    assert.equal((await legacy(rejected)).status, 400);
  assert.equal(calls.length, 2);
  assert.equal((await legacy(code, { Host: 'wrong.example.test', 'X-Forwarded-Host': host })).status, 403);
  assert.equal((await legacy(code, { Origin: 'https://wrong.example.test' })).status, 403);
  assert.equal((await post(url, storefrontMailboxQueryRoute, undefined, { Host: host }, 'GET')).status, 405);
  assert.equal((await post(url, '/api/local/inventory', undefined, { Host: host }, 'GET')).status, 403);
  assert.equal((await post(url, storefrontMailboxQueryRoute, { queryCode: code }, {})).status, 404);
  const local = await post(url, managedMailboxQueryRoute, { queryCode: code }, { Origin: new URL(url).origin });
  assert.equal(local.status, 200);
  assert.equal(local.data.primaryEmail, 'l***@example.test');
  assert.equal(calls.at(-1).storefront, undefined);
});
