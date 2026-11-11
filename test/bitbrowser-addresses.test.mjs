import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { listBitBrowserAddresses } from '../server/bitbrowser-addresses.mjs';
import { initializeLocalAdmin } from '../server/local-auth.mjs';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { startPreview } from '../server/preview.mjs';

const owner = { id: 'fixture-owner', name: '地址录入人' };
const other = { id: 'fixture-other', name: '其他管理员' };

async function fixtureDirectory(t) {
  const runtime = new URL('../.runtime/', import.meta.url);
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(new URL('bitbrowser-addresses-test-', runtime));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('address page size policy supports shared and legacy sizes', () => {
  const rows = Array.from({ length: 21 }, (_, index) => ({
    id: 'fixture-' + index, line1: 'Fixture Street ' + index, status: 'unused',
    createdAt: '2026-11-09T00:00:00.000Z'
  }));
  const list = (query = '') => listBitBrowserAddresses(rows, new URLSearchParams(query));
  assert.equal(list().pageSize, 20);
  for (const pageSize of [10, 20, 50, 100, 2000]) {
    const result = list(`pageSize=${pageSize}`);
    assert.equal(result.pageSize, pageSize);
    assert.equal(result.items.length, Math.min(rows.length, pageSize));
    assert.equal(result.total, rows.length);
  }
  assert.equal(list('page=3&pageSize=10').items.length, 1);
  assert.throws(() => list('pageSize=11'), { status: 400 });
});

test('generated addresses stay encrypted and owner scoped; removed import requests cannot change data or audit', async (t) => {
  const path = join(await fixtureDirectory(t), 'addresses.sqlite');
  let store = createLocalBusinessStore(path);
  const filter = (query = '', actor = owner) =>
    store.listBitBrowserAddresses(new URLSearchParams(query), actor);
  try {
    const { items } = store.saveBitBrowserAddresses({ count: 2 }, owner);
    const selected = items.reduce((longest, item) => item.line1.length > longest.line1.length ? item : longest);
    const street = selected.line1;
    const query = 'keyword=' + encodeURIComponent(street.toLowerCase());
    assert.equal(filter('', other).total, 0);
    assert.equal(filter('', other).version, 0);
    assert.throws(() => filter('pageSize=11'), { status: 400 });
    const filtered = filter(query);
    assert.equal(filtered.total, 1);
    assert.equal(filtered.version, 1);
    assert.deepEqual(filtered.totals, { unused: 2, used: 0, disabled: 0 });
    assert.deepEqual(filtered.items[0], selected);
    assert.equal(filter('page=2').items.length, 0);
    assert.equal(filter('page=2').total, 2);
    const before = filter();
    const auditBefore = store.audit();
    for (const data of [
      { streets: ['123 Removed Import Street'] },
      { streets: [] },
      { streets: ['123 Removed Import Street'], count: 1 },
      { streets: ['123 Removed Import Street'], id: items[0].id, status: 'used', expectedStatus: 'unused' },
      { streets: ['123 Removed Import Street'], deleteUsed: true, version: before.version }
    ]) assert.throws(() => store.saveBitBrowserAddresses(data, owner), { status: 400 });
    assert.deepEqual(filter(), before);
    assert.deepEqual(store.audit(), auditBefore);
    assert.throws(
      () =>
        store.saveBatch([{ domain: 'bitbrowser-addresses', version: 1, data: {} }], {
          actor: owner
        }),
      { status: 404 }
    );
    assert.equal(JSON.stringify(store.audit()).includes(street), false);
    assert.ok(store.audit().every((entry) => entry.actorId === owner.id));
    store.close();
    store = undefined;
    assert.equal((await readFile(path)).includes(Buffer.from(street)), false);
    store = createLocalBusinessStore(path);
    assert.deepEqual(filter(query), filtered);
  } finally {
    store?.close();
  }
});

test('marking used is idempotent and deleting used requires the reviewed document version', () => {
  const store = createLocalBusinessStore(':memory:');
  const list = (query = '', actor = owner) =>
    store.listBitBrowserAddresses(new URLSearchParams(query), actor);
  try {
    store.saveBitBrowserAddresses({ count: 2 }, owner);
    store.saveBitBrowserAddresses({ count: 1 }, other);
    const { id } = list().items[0];
    const pendingVersion = list().version;
    const markUsed = { id, status: 'used', expectedStatus: 'unused' };
    assert.throws(() => store.saveBitBrowserAddresses(markUsed, other), { status: 404 });
    assert.throws(() => store.saveBitBrowserAddresses({ ...markUsed, status: 'disabled' }, owner), {
      status: 400
    });
    const used = store.saveBitBrowserAddresses(markUsed, owner);
    assert.equal(used.status, 'used');
    assert.ok(used.usedAt);
    const reviewedVersion = list().version;
    assert.equal(reviewedVersion, pendingVersion + 1);
    assert.deepEqual(store.saveBitBrowserAddresses(markUsed, owner), used);
    assert.equal(list().version, reviewedVersion);
    assert.deepEqual(list('status=used').items, [used]);
    assert.throws(() => store.saveBitBrowserAddresses({ deleteUsed: true, version: pendingVersion }, owner), {
      status: 409
    });
    assert.deepEqual(list('status=used').items, [used]);
    assert.deepEqual(store.saveBitBrowserAddresses({ deleteUsed: true, version: reviewedVersion }, owner), {
      deleted: 1
    });
    assert.equal(list('status=used').total, 0);
    assert.equal(list('status=unused').total, 1);
    assert.equal(list().version, reviewedVersion + 1);
    assert.equal(list('', other).total, 1);
    assert.throws(() => store.saveBitBrowserAddresses({ deleteUsed: true, version: reviewedVersion }, owner), {
      status: 409
    });
    const audit = store.audit();
    const statusAudit = audit.filter(({ action }) => action === 'bitbrowser_address_status');
    assert.equal(statusAudit.length, 1);
    assert.equal(statusAudit[0].targetId, id);
    assert.equal(statusAudit[0].actorId, owner.id);
    assert.equal(audit[0].action, 'bitbrowser_address_delete_used');
    assert.equal(audit[0].actorId, owner.id);
    assert.equal(audit[0].version, reviewedVersion + 1);
    assert.equal(JSON.stringify(audit).includes(used.line1), false);
  } finally {
    store.close();
  }
});

test('generates exactly the requested unused addresses without changing existing addresses or owner scope', () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const { items: [existing] } = store.saveBitBrowserAddresses({ count: 1 }, owner);
    for (const count of [0, 101, 1.5, '10', null]) {
      assert.throws(() => store.saveBitBrowserAddresses({ count }, owner), { status: 400 });
    }
    assert.throws(() => store.saveBitBrowserAddresses({ count: 1, ownerId: other.id }, owner), {
      status: 400
    });
    const { count, items } = store.saveBitBrowserAddresses({ count: 100 }, owner);
    assert.equal(count, 100);
    assert.equal(new Set(items.map(({ line1 }) => line1)).size, 100);
    for (const item of items) {
      assert.match(item.postalCode, /^\d{5}$/);
      assert.equal(item.country, 'US');
      assert.equal(item.status, 'unused');
      assert.equal(item.usedAt, null);
    }
    assert.equal(store.listBitBrowserAddresses(new URLSearchParams(), owner).total, 101);
    assert.equal(store.listBitBrowserAddresses(new URLSearchParams(), other).total, 0);
    assert.deepEqual(
      store.listBitBrowserAddresses(new URLSearchParams({ keyword: existing.line1 }), owner).items.find(({ id }) => id === existing.id),
      existing
    );
    const audit = store.audit();
    assert.equal(audit.filter(({ action }) => action === 'bitbrowser_address_generate').length, 2);
    assert.equal(JSON.stringify(audit).includes(items[0].line1), false);
  } finally {
    store.close();
  }
});

test('address endpoint requires the existing administrator session and a same-origin write', async (t) => {
  const directory = await fixtureDirectory(t);
  const authPath = join(directory, 'auth.json');
  const admin = {
    email: 'addresses-admin@example.test',
    name: '测试管理员',
    password: randomUUID()
  };
  await initializeLocalAdmin(authPath, admin);
  const { url, server } = await startPreview(0, { databasePath: ':memory:', authPath });
  const origin = new URL(url).origin;
  const resource = 'api/local/bitbrowser-addresses';
  function request(path, { method = 'GET', cookie, data, requestOrigin = origin } = {}) {
    return fetch(url + path, {
      method,
      headers: {
        ...(cookie && { Cookie: cookie }),
        ...(data && { 'Content-Type': 'application/json', Origin: requestOrigin })
      },
      body: data && JSON.stringify(data)
    });
  }
  async function login({ email, password }) {
    const response = await request('api/local/auth/login', {
      method: 'POST',
      data: { email, password }
    });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';', 1)[0];
  }
  try {
    assert.equal((await request(resource)).status, 401);
    const cookie = await login(admin);
    const employee = {
      email: 'addresses-employee@example.test',
      name: '测试员工',
      password: randomUUID(),
      role: 'employee'
    };
    assert.equal(
      (await request('api/local/auth/employees', { method: 'POST', data: employee, cookie }))
        .status,
      201
    );
    const employeeCookie = await login(employee);
    const otherAdmin = {
      ...employee,
      email: 'second-addresses-admin@example.test',
      role: 'admin'
    };
    assert.equal(
      (await request('api/local/auth/employees', { method: 'POST', data: otherAdmin, cookie }))
        .status,
      201
    );
    const otherAdminCookie = await login(otherAdmin);
    const data = { count: 1 };
    assert.equal((await request(resource, { cookie: employeeCookie })).status, 403);
    assert.equal(
      (await request(resource, { method: 'PUT', cookie: employeeCookie, data })).status,
      403
    );
    assert.equal(
      (
        await request(resource, {
          method: 'PUT',
          cookie,
          data,
          requestOrigin: 'https://untrusted.example.test'
        })
      ).status,
      403
    );
    const removedImport = await request(resource, {
      method: 'PUT', cookie, data: { streets: ['123 Removed Import Street'] }
    });
    assert.equal(removedImport.status, 400);
    const unchanged = await (await request(resource, { cookie })).json();
    assert.equal(unchanged.total, 0);
    assert.equal(unchanged.version, 0);
    const generated = await request(resource, { method: 'PUT', cookie, data });
    assert.equal(generated.status, 200);
    const generatedResult = await generated.json();
    assert.equal(generatedResult.count, 1);
    const otherList = await request(resource, { cookie: otherAdminCookie });
    assert.equal(otherList.status, 200);
    assert.equal((await otherList.json()).total, 0);
    const response = await request(resource + '?page=1&pageSize=50&status=unused', {
      cookie
    });
    assert.equal(response.status, 200);
    const { items, pageSize, version } = await response.json();
    assert.equal(pageSize, 50);
    assert.equal(version, 1);
    assert.deepEqual(items, generatedResult.items);
    const competing = (status) =>
      request(resource, {
        method: 'PUT',
        cookie,
        data: { id: items[0].id, status, expectedStatus: 'unused' }
      });
    assert.equal((await competing('disabled')).status, 400);
    const outcomes = await Promise.all([competing('used'), competing('used')]);
    assert.deepEqual(outcomes.map((entry) => entry.status), [200, 200]);
    const [first, second] = await Promise.all(outcomes.map((entry) => entry.json()));
    assert.deepEqual(first, second);
    const deleteUsed = (reviewedVersion) =>
      request(resource, { method: 'PUT', cookie, data: { deleteUsed: true, version: reviewedVersion } });
    assert.equal((await deleteUsed(version)).status, 409);
    const { version: currentVersion } = await (await request(resource, { cookie })).json();
    const deleted = await deleteUsed(currentVersion);
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deleted: 1 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('unconfigured local mode records the existing local operator and still requires same origin', async () => {
  const { url, server } = await startPreview(0, { databasePath: ':memory:' });
  const resource = url + 'api/local/bitbrowser-addresses';
  const data = JSON.stringify({ count: 1 });
  try {
    assert.equal(
      (await fetch(resource, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status,
      403
    );
    assert.equal(
      (
        await fetch(resource, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: data
        })
      ).status,
      403
    );
    assert.equal(
      (
        await fetch(resource, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Origin: new URL(url).origin },
          body: data
        })
      ).status,
      200
    );
    const { items } = await (await fetch(resource)).json();
    assert.equal(items.length, 1);
    assert.equal(items[0].status, 'unused');
    const [audit] = await (await fetch(url + 'api/local/audit')).json();
    assert.equal(audit.actorId, 'local-operator');
    assert.equal(audit.action, 'bitbrowser_address_generate');
    assert.equal(
      (await fetch(resource + ':local-operator')).status,
      404,
      'the internal backup document cannot be read through the generic endpoint'
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
