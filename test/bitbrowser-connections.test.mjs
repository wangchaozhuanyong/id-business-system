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
  const staticProxyCredentials = { username: 'fixture-proxy-user', password: 'fixture-proxy-password' };
  const staticProfile = { proxyMode: 'static', staticHost: 'proxy.example.test', staticPort: 8082 };
  const secrets = { interfaceToken, staticProxyCredentials };
  let saved;
  try {
    assert.throws(() => store.saveBitBrowserConnection({ ...command(0), ...secrets }, alice), { status: 400 });
    saved = store.saveBitBrowserConnection({ ...command(0, staticProfile), ...secrets }, alice);
    assert.equal(saved.profiles[0].hasInterfaceToken, true);
    assert.equal(saved.profiles[0].hasStaticProxyCredentials, true);
    for (const value of [interfaceToken, ...Object.values(staticProxyCredentials)]) {
      assert.equal(JSON.stringify(saved).includes(value), false);
      assert.equal(JSON.stringify(store.audit()).includes(value), false);
    }
  } finally {
    store.close();
  }
  assert.equal((await readFile(source)).includes(Buffer.from(profile.name)), false);
  const sourceBytes = await readFile(source);
  for (const value of [interfaceToken, ...Object.values(staticProxyCredentials)])
    assert.equal(sourceBytes.includes(Buffer.from(value)), false);
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
    assert.deepEqual(restored.useBitBrowserConnectionSecrets(selection, alice), secrets);
    assert.throws(() => restored.useBitBrowserConnectionSecrets({ ...selection, version: 0 }, bob), { status: 404 });
    const retained = restored.saveBitBrowserConnection(command(1, { ...staticProfile, id: saved.savedId }), alice);
    assert.equal(retained.profiles[0].hasInterfaceToken, true);
    assert.equal(retained.profiles[0].hasStaticProxyCredentials, true);
    const changed = restored.saveBitBrowserConnection(command(2, {
      ...staticProfile, id: saved.savedId, url: 'http://127.0.0.1:54346', staticPort: 8083
    }), alice);
    assert.equal(changed.profiles[0].hasInterfaceToken, undefined);
    assert.equal(changed.profiles[0].hasStaticProxyCredentials, undefined);
    assert.throws(() => restored.useBitBrowserConnectionSecrets(selection, alice), { status: 409 });
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
  const staticProxyCredentials = { username: 'fixture-proxy-user', password: 'fixture-proxy-password' };
  const first = await request(path, {
    method: 'PUT',
    body: {
      ...command(0, { proxyMode: 'static', staticHost: 'proxy.example.test' }),
      interfaceToken: firstToken,
      staticProxyCredentials
    },
    cookie
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('X-ID-BitBrowser-Token-Storage'), 'enabled');
  const { savedId } = await first.json();
  const second = await request(path, {
    method: 'PUT', body: { ...command(1, { name: '另一条连接' }), interfaceToken: secondToken }, cookie
  });
  assert.equal(second.status, 200);
  const secondId = (await second.json()).savedId;
  const summary = await (await request(path, { cookie })).text();
  for (const value of [firstToken, secondToken, ...Object.values(staticProxyCredentials)])
    assert.equal(summary.includes(value), false);
  const use = (id, requestCookie, requestOrigin) => request(path, {
    method: 'POST', body: { id, version: 2 }, cookie: requestCookie, requestOrigin
  });
  assert.equal((await use(savedId)).status, 401);
  assert.equal((await use(savedId, cookie, 'https://other.example.test')).status, 403);
  const firstUse = await use(savedId, cookie);
  assert.equal(firstUse.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await firstUse.json(), { interfaceToken: firstToken, staticProxyCredentials });
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
  const ipPath = 'api/local/bitbrowser-proxies';
  const ip = { version: 0, name: '合成移动 IP', countryCode: 'MY', kind: 'mobile', mode: 'static', protocol: 'http', link: 'http://test:synthetic-proxy-secret@192.0.2.5:8080' };
  assert.equal((await request(ipPath)).status, 401);
  assert.equal((await request(ipPath, { cookie: employeeCookie })).status, 403);
  assert.equal((await request(ipPath, { method: 'PUT', body: ip, cookie, requestOrigin: 'https://other.example.test' })).status, 403);
  const createdIp = await request(ipPath, { method: 'PUT', body: ip, cookie });
  assert.equal(createdIp.status, 200);
  const savedIp = await createdIp.json();
  assert(!JSON.stringify(savedIp).includes('synthetic-proxy-secret'));
  const selectedIp = { id: savedIp.savedId, version: savedIp.version };
  assert.equal((await request(ipPath, { method: 'POST', body: selectedIp, cookie: employeeCookie })).status, 403);
  assert.equal((await request(ipPath, { method: 'POST', body: selectedIp, cookie, requestOrigin: 'https://other.example.test' })).status, 403);
  const ipUse = await request(ipPath, { method: 'POST', body: selectedIp, cookie });
  assert.equal(ipUse.headers.get('cache-control'), 'private, no-store');
  assert.equal((await ipUse.json()).countryCode, 'MY');

  const windowPath = 'api/local/bitbrowser-login-windows';
  const lookup = { connectionKey: 'a'.repeat(64), accountKey: 'b'.repeat(64) };
  const windowCommand = { ...lookup, version: 0, profileId: 'c'.repeat(32), proxyConfiguration: 'd'.repeat(64) };
  assert.equal((await request(windowPath, { method: 'POST', body: lookup })).status, 401);
  assert.equal((await request(windowPath, { method: 'POST', body: lookup, cookie: employeeCookie })).status, 403);
  assert.equal((await request(windowPath, { method: 'PUT', body: windowCommand, cookie, requestOrigin: 'https://other.example.test' })).status, 403);
  const savedWindow = await request(windowPath, { method: 'PUT', body: windowCommand, cookie });
  assert.equal(savedWindow.status, 200);
  assert.equal(savedWindow.headers.get('cache-control'), 'private, no-store');
  const originalWindow = await savedWindow.json();
  assert.equal(originalWindow.record.profileId, windowCommand.profileId);
  assert.deepEqual(await (await request(windowPath, { method: 'POST', body: lookup, cookie })).json(), originalWindow);
  assert.equal((await request(windowPath, { method: 'PUT', body: windowCommand, cookie })).status, 409);
  assert.equal((await request(windowPath, { method: 'PUT', body: { ...windowCommand, version: 1, sessionJson: '{}' }, cookie })).status, 400);

});

test('window links survive store reopening, remain encrypted and belong to one operator', async t => {
  const directory = await privateDirectory(t);
  const file = join(directory, 'windows.sqlite');
  const lookup = { connectionKey: 'a'.repeat(64), accountKey: 'b'.repeat(64) };
  const body = { ...lookup, version: 0, profileId: 'c'.repeat(32), proxyConfiguration: 'd'.repeat(64) };
  let store = createLocalBusinessStore(file);
  let saved;
  try {
    saved = store.saveBitBrowserWindow(body, alice);
    assert.deepEqual(store.loadBitBrowserWindow(lookup, bob), { record: null });
    assert.throws(() => store.saveBitBrowserWindow({ ...body, version: 1 }, bob), { status: 409 });
    assert.throws(() => store.load('bitbrowser-login-windows:' + alice.id), { status: 404 });
    const audit = JSON.stringify(store.audit());
    for (const value of [lookup.accountKey, lookup.connectionKey, body.profileId, body.proxyConfiguration]) assert(!audit.includes(value));
  } finally { store.close(); }
  const bytes = await readFile(file);
  for (const value of [lookup.accountKey, lookup.connectionKey, body.profileId, body.proxyConfiguration]) assert(!bytes.includes(Buffer.from(value)));
  store = createLocalBusinessStore(file);
  try { assert.deepEqual(store.loadBitBrowserWindow(lookup, alice), saved); }
  finally { store.close(); }
});

test('account label is optional for old clients, independent of computer remarks and preserved on older writes', () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const first = store.saveBitBrowserConnection(command(0, { accountName: 'fixture-bit-account' }), alice);
    assert.equal(first.profiles[0].accountName, 'fixture-bit-account');
    const second = store.saveBitBrowserConnection(command(1, { id: first.savedId, name: '新电脑备注' }), alice);
    assert.equal(second.profiles[0].accountName, 'fixture-bit-account');
    assert.equal(second.profiles[0].name, '新电脑备注');
    assert.throws(() => store.saveBitBrowserConnection(command(2, { id: first.savedId, accountName: 123 }), alice), { status: 400 });
  } finally { store.close(); }
});
