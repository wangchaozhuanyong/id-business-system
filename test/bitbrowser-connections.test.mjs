import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createSnapshot, restoreSnapshot } from '../server/backup/local-sqlite.mjs';
import { initializeLocalAdmin } from '../server/local-auth.mjs';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { startPreview } from '../server/preview.mjs';

const alice = { id: '85463b17-c1a3-4371-83c5-5e150801ff3c', name: '甲' };
const bob = { id: '37482a24-1f9b-4b87-bb98-0e0328563209', name: '乙' };
const profile = {
  name: '连接配置演练',
  url: 'http://127.0.0.1:54345',
  groupName: '测试分组',
  tagName: '',
  coreVersion: '152',
  proxyMode: 'dynamic',
  proxyType: 'http',
  expectedCountryCode: 'us',
  staticHost: '',
  staticPort: 8080,
  sessionWaitMinutes: 2,
  sessionRetryLimit: 9
};
const empty = { version: 0, profiles: [] };
const command = (version, values) => ({ version, profile: { ...profile, ...values } });

async function privateDirectory(t) {
  const runtime = new URL('../.runtime/', import.meta.url);
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(new URL('bitbrowser-connections-test-', runtime));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('isolates profiles by operator, preserves one revision and audits without content', () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    assert.deepEqual(store.loadBitBrowserConnections(alice), empty);
    const first = store.saveBitBrowserConnection(command(0), alice);
    const { savedId: id } = first;
    assert.deepEqual(first, {
      version: 1,
      savedId: id,
      profiles: [{ ...profile, id, expectedCountryCode: 'US' }]
    });
    assert.deepEqual(store.loadBitBrowserConnections(bob), empty);
    assert.throws(() => store.saveBitBrowserConnection(command(0, { id }), bob), { status: 404 });
    assert.throws(() => store.saveBitBrowserConnection(command(0, { id }), alice), { status: 409 });
    const updated = store.saveBitBrowserConnection(
      command(1, {
        id,
        proxyMode: 'static',
        proxyType: 'socks5',
        staticHost: 'proxy.example.test'
      }),
      alice
    );
    assert.equal(updated.version, 2);
    assert.equal(updated.savedId, id);
    assert.equal(updated.profiles.length, 1);
    assert.equal(updated.profiles[0].staticHost, 'proxy.example.test');
    assert.throws(() => store.load('bitbrowser-connections:' + alice.id), { status: 404 });
    assert.throws(
      () =>
        store.saveBatch([{ domain: 'bitbrowser-connections:' + alice.id, version: 2, data: {} }]),
      { status: 404 }
    );
    assert.deepEqual(
      store.audit().map(({ action, actorId, targetId }) => ({ action, actorId, targetId })),
      [
        { action: 'bitbrowser_connection_update', actorId: alice.id, targetId: id },
        { action: 'bitbrowser_connection_create', actorId: alice.id, targetId: id }
      ]
    );
    assert.equal(JSON.stringify(store.audit()).includes(profile.name), false);
    assert.equal(JSON.stringify(store.audit()).includes('proxy.example.test'), false);
  } finally {
    store.close();
  }
});

test('rejects credentials, undeclared fields and values that cannot run in the local browser', () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    for (const values of [
      { token: 'fixture' },
      { authorizationJson: '{}' },
      { proxyPassword: 'fixture' },
      { dynamicProxyUrl: 'https://fixture.test/secret' },
      { selected: true },
      { url: 'http://user:fixture@127.0.0.1:54345' },
      { url: 'http://localhost:54345/?token=fixture' },
      { url: 'http://localhost:54345/path' },
      { url: 'http://127.0.0.2:54345' },
      { url: 'http://127.1:54345' },
      { url: 'https://localhost:54345' },
      { staticHost: 'proxy.example.test' },
      { proxyMode: 'static' },
      { proxyMode: 'static', staticHost: 'user:fixture@proxy.example.test' },
      { staticPort: 0 },
      { sessionWaitMinutes: 11 },
      { sessionRetryLimit: '9' }
    ]) {
      assert.throws(() => store.saveBitBrowserConnection(command(0, values), alice), {
        status: 400
      });
    }
    assert.throws(() => store.saveBitBrowserConnection({ ...command(0), ownerId: bob.id }, alice), {
      status: 400
    });
    assert.deepEqual(store.loadBitBrowserConnections(alice), empty);
    assert.deepEqual(store.audit(), []);
  } finally {
    store.close();
  }
});

test('connection profiles stay encrypted and are readable after backup and recovery', async (t) => {
  const directory = await privateDirectory(t);
  const source = join(directory, 'source.sqlite');
  const snapshot = join(directory, 'snapshot');
  const recovered = join(directory, 'recovered');
  const store = createLocalBusinessStore(source);
  const interfaceToken = 'fixture-local-interface-token';
  let saved;
  try {
    saved = store.saveBitBrowserConnection({ ...command(0), interfaceToken }, alice);
    assert.equal(saved.profiles[0].hasInterfaceToken, true);
    assert.equal(JSON.stringify(saved).includes(interfaceToken), false);
    assert.equal(JSON.stringify(store.audit()).includes(interfaceToken), false);
  } finally {
    store.close();
  }
  assert.equal((await readFile(source)).includes(Buffer.from(profile.name)), false);
  assert.equal((await readFile(source)).includes(Buffer.from(interfaceToken)), false);
  await createSnapshot({ source, output: snapshot });
  await restoreSnapshot({ input: snapshot, key: source + '.key', output: recovered });
  const restored = createLocalBusinessStore(join(recovered, 'local-business.sqlite'));
  try {
    assert.deepEqual(restored.loadBitBrowserConnections(alice), {
      version: 1,
      profiles: saved.profiles
    });
    assert.deepEqual(restored.loadBitBrowserConnections(bob), empty);
    const selection = { id: saved.savedId, version: 1 };
    assert.deepEqual(restored.useBitBrowserConnectionToken(selection, alice), { interfaceToken });
    assert.throws(() => restored.useBitBrowserConnectionToken({ ...selection, version: 0 }, bob), { status: 404 });
    const retained = restored.saveBitBrowserConnection(command(1, { id: saved.savedId }), alice);
    assert.equal(retained.profiles[0].hasInterfaceToken, true);
    const changed = restored.saveBitBrowserConnection(command(2, {
      id: saved.savedId, url: 'http://127.0.0.1:54346'
    }), alice);
    assert.equal(changed.profiles[0].hasInterfaceToken, undefined);
  } finally {
    restored.close();
  }
});

test('uses the preview server existing administrator gate and same-origin write check', async (t) => {
  const directory = await privateDirectory(t);
  const authPath = join(directory, 'auth.json');
  const admin = {
    email: 'bit-connection-admin@example.test',
    name: '配置测试管理员',
    password: 'test-only-connection-admin-password'
  };
  const employee = {
    email: 'bit-connection-employee@example.test',
    name: '配置测试员工',
    password: 'test-only-connection-employee-password',
    role: 'employee'
  };
  await initializeLocalAdmin(authPath, admin);
  const { server, url } = await startPreview(0, { databasePath: ':memory:', authPath });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = new URL(url).origin;
  const path = 'api/local/bitbrowser-connections';
  const request = (route, { method = 'GET', body, cookie, requestOrigin = origin } = {}) =>
    fetch(url + route, {
      method,
      headers: {
        ...(cookie && { Cookie: cookie }),
        ...(body && { Origin: requestOrigin, 'Content-Type': 'application/json' })
      },
      body: body && JSON.stringify(body)
    });
  async function login({ email, password }) {
    const response = await request('api/local/auth/login', {
      method: 'POST',
      body: { email, password }
    });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';', 1)[0];
  }
  assert.equal((await request(path)).status, 401);
  const cookie = await login(admin);
  assert.deepEqual(await (await request(path, { cookie })).json(), empty);
  assert.equal(
    (
      await request(path, {
        method: 'PUT',
        body: command(0),
        cookie,
        requestOrigin: 'https://other.example.test'
      })
    ).status,
    403
  );
  const firstToken = 'fixture-interface-token-one';
  const secondToken = 'fixture-interface-token-two';
  const first = await request(path, { method: 'PUT', body: { ...command(0), interfaceToken: firstToken }, cookie });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('X-ID-BitBrowser-Token-Storage'), 'enabled');
  const { savedId } = await first.json();
  const second = await request(path, {
    method: 'PUT', body: { ...command(1, { name: '另一条连接' }), interfaceToken: secondToken }, cookie
  });
  assert.equal(second.status, 200);
  const secondId = (await second.json()).savedId;
  const summary = await (await request(path, { cookie })).text();
  assert.ok(!summary.includes(firstToken) && !summary.includes(secondToken));
  const use = (id, requestCookie, requestOrigin) => request(path, {
    method: 'POST', body: { id, version: 2 }, cookie: requestCookie, requestOrigin
  });
  assert.equal((await use(savedId)).status, 401);
  assert.equal((await use(savedId, cookie, 'https://other.example.test')).status, 403);
  const firstUse = await use(savedId, cookie);
  assert.equal(firstUse.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await firstUse.json(), { interfaceToken: firstToken });
  assert.deepEqual(await (await use(secondId, cookie)).json(), { interfaceToken: secondToken });
  const added = await request('api/local/auth/employees', {
    method: 'POST',
    body: employee,
    cookie
  });
  assert.equal(added.status, 201);
  const employeeCookie = await login(employee);
  assert.equal((await request(path, { cookie: employeeCookie })).status, 403);
  assert.equal((await use(savedId, employeeCookie)).status, 403);
});
