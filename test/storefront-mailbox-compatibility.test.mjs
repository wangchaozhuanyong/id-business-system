import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { initializeLocalAdmin } from '../server/local-auth.mjs';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { startPreview } from '../server/preview.mjs';
import { decodeLegacyMailboxPool } from '../server/tools/legacy-mailbox-import.mjs';
import { managedMailboxQueryRoute, storefrontMailboxQueryRoute } from '../server/tools/mailbox-pool.mjs';

const run = promisify(execFile);
const secrets = { fieldEncryptionKey: 'fixture-field-encryption-key', hashSecret: 'fixture-hash-secret' };
const code = 'AbCdEfGhJkMnPqRsTuV2';
const appPassword = 'fixture-legacy-mailbox-password';
const publicOrigin = 'https://id.example.test';
const expiry = '2099-12-31T00:00:00.123456+00:00';
const mail = {
  from: 'Fixture Sender <sender@example.test>', to: 'legacy@example.test',
  subject: '邮箱验证', body: '<p>验证码 472081</p><a href="https://example.test/verify?proof=fixture">验证</a>',
  receivedAt: '2026-11-06T11:05:00+08:00'
};

function encryptLegacy(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secrets.fieldEncryptionKey).digest(), iv);
  const body = Buffer.concat([cipher.update(value), cipher.final()]);
  return 'v1:' + [iv, cipher.getAuthTag(), body].map((value) => value.toString('base64url')).join(':');
}

function row(queryCode = code, options = {}) {
  return {
    id: randomUUID(), provider: 'gmail', status: 'active', email: 'legacy@example.test', label: '旧店铺',
    queryCodeEncrypted: encryptLegacy(queryCode),
    queryCodeHash: createHmac('sha256', secrets.hashSecret).update(queryCode).digest('hex'),
    providerCredentialEncrypted: encryptLegacy(appPassword),
    queryCodeExpiresAt: expiry, updatedAt: '2026-11-06T00:00:00Z',
    lastQueriedAt: '2026-11-05T23:00:00Z', ...options
  };
}
const bundle = (...rows) => ({ format: 'id-managed-mailbox-v1', defaultValidDays: 30, rows });

async function temporary(t) {
  const root = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, 'mailbox-compat-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('旧版导入保留三种邮箱授权、状态和到期时间，版本冲突不覆盖', (t) => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const active = row();
  const disabledCode = 'AbCdEfGhJkMnPqRsTuV3';
  const disabled = row(disabledCode, { provider: 'icloud', status: 'disabled', email: 'disabled@example.test' });
  const failedCode = 'AbCdEfGhJkMnPqRsTuV4';
  const failed = row(failedCode, {
    provider: 'microsoft', status: 'auth_failed', email: 'failed@example.test',
    queryCodeEncrypted: null, recoveredQueryCode: failedCode
  });
  const expiredCode = 'AbCdEfGhJkMnPqRsTuV5';
  const expired = row(expiredCode, { email: 'expired@example.test', queryCodeExpiresAt: '2000-01-01T00:00:00Z' });
  const source = bundle(active, disabled, failed, expired);
  assert.deepEqual(store.importLegacyManagedMailboxPool(source, secrets, 0), { imported: 4, unchanged: 0, version: 1 });
  const metadata = store.loadManagedMailboxPool();
  assert.equal(metadata.defaultValidDays, 30);
  assert.equal(metadata.items[0].expiresAt, expiry);
  assert.equal(metadata.items[0].lastQueriedAt, active.lastQueriedAt);
  assert.deepEqual(metadata.items.map((item) => item.provider), ['google', 'apple', 'microsoft', 'google']);
  assert.equal(metadata.items[2].authFailed, true);
  assert.equal(store.findManagedMailbox(code).id, active.id);
  assert.equal(store.findManagedMailbox(code.toLowerCase()), null);
  for (const rejected of [disabledCode, failedCode, expiredCode]) assert.equal(store.findManagedMailbox(rejected), null);
  assert.deepEqual(store.importLegacyManagedMailboxPool(source, secrets, 1), { imported: 0, unchanged: 4, version: 1 });
  assert.throws(() => store.importLegacyManagedMailboxPool(source, secrets, 0), { status: 409 });
  assert.throws(() => store.importLegacyManagedMailboxPool(bundle({ ...active, label: '不同记录' }), secrets, 1), { status: 409 });
  assert.deepEqual(store.loadManagedMailboxPool(), metadata);
  assert.throws(() => decodeLegacyMailboxPool(bundle({ ...failed, recoveredQueryCode: undefined }), secrets), /缺少可恢复/);
  assert.throws(() => decodeLegacyMailboxPool(source, { ...secrets, hashSecret: 'wrong' }), /校验值不一致/);
  assert.throws(() => decodeLegacyMailboxPool(source, { ...secrets, fieldEncryptionKey: 'wrong' }), /解密失败/);
  const rotated = store.saveManagedMailboxPool({ action: 'rotate', version: 1, id: active.id });
  assert.equal(store.findManagedMailbox(code), null);
  assert.equal(store.findManagedMailbox(rotated.issuedCode).id, active.id);
});

test('离线命令默认只验，显式导入后数据库和输出均无明文授权', async (t) => {
  const dir = await temporary(t);
  const input = join(dir, 'source.json');
  const key = join(dir, 'key.json');
  const database = join(dir, 'fixture.sqlite');
  await writeFile(input, JSON.stringify(bundle(row())), { mode: 0o600 });
  await writeFile(key, JSON.stringify(secrets), { mode: 0o600 });
  createLocalBusinessStore(database).close();
  const script = fileURLToPath(new URL('../server/tools/legacy-mailbox-import-cli.mjs', import.meta.url));
  const args = [script, '--input', input, '--legacy-key-file', key];
  const validate = await run(process.execPath, args);
  assert.deepEqual(JSON.parse(validate.stdout), { mode: 'validate', rows: 1 });
  const apply = await run(process.execPath, [...args, '--database', database, '--expected-version', '0', '--apply']);
  assert.deepEqual(JSON.parse(apply.stdout), { mode: 'apply', imported: 1, unchanged: 0, version: 1 });
  const bytes = await readFile(database);
  for (const secret of [appPassword, code, secrets.fieldEncryptionKey, secrets.hashSecret]) {
    assert.equal(bytes.includes(Buffer.from(secret)), false);
    assert.equal(apply.stdout.includes(secret), false);
  }
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
  const fixture = createLocalBusinessStore(databasePath);
  fixture.importLegacyManagedMailboxPool(bundle(row()), secrets, 0);
  const { issuedCode } = fixture.saveManagedMailboxPool({
    action: 'create', version: 1, email: 'new@example.test', provider: 'google', appPassword: 'fixture-new-password'
  });
  fixture.close();
  const calls = [];
  const { server, url } = await startPreview(0, {
    databasePath, authPath, mailboxPublicOrigin: publicOrigin,
    readManagedMailbox: async (item) => { calls.push(item); return [{ ...mail, to: item.email }]; }
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const host = new URL(publicOrigin).host;
  const legacy = (queryCode, headers = {}) =>
    post(url, storefrontMailboxQueryRoute, { queryCode, limit: 5 }, { Host: host, ...headers });
  for (const [queryCode, email] of [[code, 'legacy@example.test'], [issuedCode, 'new@example.test']]) {
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
