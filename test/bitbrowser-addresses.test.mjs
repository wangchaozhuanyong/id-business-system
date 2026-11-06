import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { initializeLocalAdmin } from '../server/local-auth.mjs';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { startPreview } from '../server/preview.mjs';

const owner = { id: 'fixture-owner', name: '地址录入人' };
const other = { id: 'fixture-other', name: '其他管理员' };
const street = '456 Fixture Street';
const fixedLocation = { city: 'Portland', state: 'OR', postalCode: '97204', country: 'US' };

async function fixtureDirectory(t) {
  const runtime = new URL('../.runtime/', import.meta.url);
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(new URL('bitbrowser-addresses-test-', runtime));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('normalizes and deduplicates TXT rows, returns legacy columns and scopes by owner', async (t) => {
  const path = join(await fixtureDirectory(t), 'addresses.sqlite');
  let store = createLocalBusinessStore(path);
  const filter = (query = '', actor = owner) =>
    store.listBitBrowserAddresses(new URLSearchParams(query), actor);
  try {
    assert.deepEqual(
      store.saveBitBrowserAddresses(
        {
          streets: [' 456   Fixture Street ', '456 fixture street', '第七号街道', '88 Other Street']
        },
        owner
      ),
      { imported: 2, duplicated: 1, rejected: 1 }
    );
    assert.deepEqual(store.saveBitBrowserAddresses({ streets: [street] }, owner), {
      imported: 0,
      duplicated: 1,
      rejected: 0
    });
    assert.equal(filter('', other).total, 0);
    assert.throws(() => filter('pageSize=10'), { status: 400 });
    const filtered = filter('keyword=fIxTuRe');
    assert.equal(filtered.total, 1);
    assert.deepEqual(filtered.totals, { unused: 2, used: 0, disabled: 0 });
    assert.deepEqual(filtered.items[0], {
      id: filtered.items[0].id,
      createdAt: filtered.items[0].createdAt,
      line1: street,
      ...fixedLocation,
      status: 'unused',
      usedAt: null
    });
    assert.equal(filter('page=2').items.length, 0);
    assert.equal(filter('page=2').total, 2);
    assert.throws(() => store.saveBitBrowserAddresses({ streets: ['abc\r\ndef', ''] }, owner), {
      status: 400
    });
    assert.throws(
      () => store.saveBitBrowserAddresses({ streets: Array(2001).fill(street) }, owner),
      { status: 400 }
    );
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
    assert.deepEqual(filter('keyword=fixture'), filtered);
  } finally {
    store?.close();
  }
});

test('address state is checked against the reviewed status and used addresses stay locked', () => {
  const store = createLocalBusinessStore(':memory:');
  const list = (query = '') => store.listBitBrowserAddresses(new URLSearchParams(query), owner);
  try {
    store.saveBitBrowserAddresses({ streets: [street] }, owner);
    const { id } = list().items[0];
    const change = (status, expectedStatus, actor = owner) =>
      store.saveBitBrowserAddresses({ id, status, expectedStatus }, actor);
    assert.throws(() => change('disabled', 'unused', other), { status: 404 });
    assert.equal(change('disabled', 'unused').status, 'disabled');
    assert.throws(() => change('used', 'unused'), { status: 409 });
    assert.equal(list('status=unused').total, 0);
    assert.equal(change('unused', 'disabled').usedAt, null);
    assert.equal(change('disabled', 'unused').status, 'disabled');
    const used = change('used', 'disabled');
    assert.equal(used.status, 'used');
    assert.ok(used.usedAt);
    assert.throws(() => change('unused', 'used'), { status: 409 });
    assert.throws(() => change('disabled', 'used'), { status: 409 });
    assert.deepEqual(list('status=used').items, [used]);
    const audit = store.audit();
    assert.equal(audit[0].targetId, id);
    assert.equal(audit[0].actorId, owner.id);
    assert.equal(audit.length, 5);
  } finally {
    store.close();
  }
});

test('generates exactly the requested unused addresses without changing imported addresses or owner scope', () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    store.saveBitBrowserAddresses({ streets: [street] }, owner);
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
    assert.equal(
      store.listBitBrowserAddresses(new URLSearchParams('keyword=Fixture'), owner).items[0]
        .postalCode,
      '97204'
    );
    const audit = store.audit();
    assert.equal(audit.filter(({ action }) => action === 'bitbrowser_address_generate').length, 1);
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
    const data = { streets: [street] };
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
    const importResult = await request(resource, { method: 'PUT', cookie, data });
    assert.equal(importResult.status, 200);
    assert.deepEqual(await importResult.json(), { imported: 1, duplicated: 0, rejected: 0 });
    const otherList = await request(resource, { cookie: otherAdminCookie });
    assert.equal(otherList.status, 200);
    assert.equal((await otherList.json()).total, 0);
    const response = await request(resource + '?page=1&pageSize=50&keyword=fixture&status=unused', {
      cookie
    });
    assert.equal(response.status, 200);
    const { items, pageSize } = await response.json();
    assert.equal(pageSize, 50);
    assert.equal(items[0].line1, street);
    const competing = (status) =>
      request(resource, {
        method: 'PUT',
        cookie,
        data: { id: items[0].id, status, expectedStatus: 'unused' }
      });
    const outcomes = await Promise.all([competing('disabled'), competing('used')]);
    assert.deepEqual(outcomes.map((entry) => entry.status).sort(), [200, 409]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('unconfigured local mode records the existing local operator and still requires same origin', async () => {
  const { url, server } = await startPreview(0, { databasePath: ':memory:' });
  const resource = url + 'api/local/bitbrowser-addresses';
  const data = JSON.stringify({ streets: [street] });
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
    assert.equal(items[0].line1, street);
    const [audit] = await (await fetch(url + 'api/local/audit')).json();
    assert.equal(audit.actorId, 'local-operator');
    assert.equal(audit.action, 'bitbrowser_address_import');
    assert.equal(
      (await fetch(resource + ':local-operator')).status,
      404,
      'the internal backup document cannot be read through the generic endpoint'
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
