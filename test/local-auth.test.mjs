import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createLocalAuth, initializeLocalAdmin, localAdminEmail } from '../server/local-auth.mjs';
import { calculateTotp } from '../modules/tools/totp.mjs';
import { startPreview } from '../server/preview.mjs';
import { productionDataPaths } from '../server/production-data.mjs';

const supervisor = {
  email: 'supervisor@example.test',
  name: '测试管理员',
  password: 'Test-Only!Password#247'
};
const ordinaryAdmin = {
  email: 'admin@example.test',
  name: '测试员工',
  password: 'Test-Only!Employee#618',
  role: 'admin'
};
const cookie = (response) => response.headers.get('set-cookie')?.split(';', 1)[0];

async function useAccounts(t) {
  const directory = await mkdtemp(join(tmpdir(), 'id-business-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'employees.json');
}

async function startAuth(t, options) {
  const accountPath = await useAccounts(t);
  const superUser = await initializeLocalAdmin(accountPath, supervisor);
  const auth = createLocalAuth(accountPath, options);
  const server = createServer((request, response) => void auth.handle(request, response));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  function request(route, { method = 'GET', body, session, requestOrigin = origin } = {}) {
    return fetch(origin + '/api/local/auth' + route, {
      method,
      headers: {
        ...(method !== 'GET' && requestOrigin !== null ? { Origin: requestOrigin } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(session ? { Cookie: session } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }
  const login = (body = supervisor) => request('/login', { method: 'POST', body });
  return { request, login, accountPath, superUser };
}

test('first administrator provisioning is exclusive and stores only a salted hash', async (t) => {
  const accountPath = await useAccounts(t);
  assert.equal(createLocalAuth(accountPath), null);
  await assert.rejects(initializeLocalAdmin(accountPath, { ...supervisor, password: 'short' }), {
    status: 400
  });
  const contenders = await Promise.allSettled([
    initializeLocalAdmin(accountPath, supervisor),
    initializeLocalAdmin(accountPath, supervisor)
  ]);
  const first = contenders.find((entry) => entry.status === 'fulfilled')?.value;
  const conflicts = contenders.filter((entry) => entry.status === 'rejected');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason.status, 409);
  assert.equal(first.role, 'super');
  assert.equal((await stat(accountPath)).mode & 0o777, 0o600);
  assert.equal((await readFile(accountPath, 'utf8')).includes(supervisor.password), false);
  assert.equal(first.credential, undefined);
  await assert.rejects(initializeLocalAdmin(accountPath, ordinaryAdmin), { status: 409 });
  await chmod(accountPath, 0o644);
  assert.throws(() => createLocalAuth(accountPath), /权限/);
});

test('production requires initialized staff and authenticates only the canonical HTTPS origin', async (t) => {
  const directory = await realpath(dirname(await useAccounts(t)));
  const { authPath, databasePath } = await productionDataPaths(directory);
  const publicOrigin = 'https://id.example.test';
  const options = { databasePath, authPath, publicOrigin };
  await assert.rejects(startPreview(0, options), /管理员尚未初始化/);
  await assert.rejects(startPreview(0, { ...options, bootstrapLocalAdmin: true }), /预先初始化/);
  await initializeLocalAdmin(authPath, supervisor);
  let { server, url } = await startPreview(0, options);
  const stop = () => new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
  t.after(() => server.listening ? stop() : undefined);
  const host = new URL(publicOrigin).host;
  function request(path, { method = 'GET', origin, body, session, requestHost = host } = {}) {
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(new URL(path, url), {
        method,
        headers: {
          Host: requestHost,
          'X-Forwarded-Host': host,
          'X-Forwarded-Proto': 'https',
          ...(origin ? { Origin: origin } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(session ? { Cookie: session } : {})
        }
      }, async (incoming) => {
        try {
          const chunks = [];
          for await (const chunk of incoming) chunks.push(chunk);
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers))
            headers.set(name, Array.isArray(value) ? value[0] : value);
          resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers }));
        } catch (error) {
          reject(error);
        }
      });
      outgoing.on('error', reject);
      outgoing.end(body ? JSON.stringify(body) : undefined);
    });
  }
  const login = (origin, requestHost) => request('/api/local/auth/login', {
    method: 'POST', body: supervisor, origin, requestHost
  });
  assert.equal((await login(publicOrigin, 'untrusted.example.test')).status, 403);
  assert.equal((await login('http://' + host)).status, 403);
  assert.equal((await login('https://untrusted.example.test')).status, 403);
  assert.equal((await request('/api/local/inventory')).status, 401);
  assert.equal((await request('/api/local/auth/setup', { method: 'POST', origin: publicOrigin })).status, 404);
  assert.equal((await request('/design-preview.html')).status, 404);
  const legacyLogin = await request('/login?redirect=https://untrusted.example.test');
  assert.equal(legacyLogin.status, 302);
  assert.equal(legacyLogin.headers.get('location'), '/');
  assert.equal(legacyLogin.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(await (await request('/')).text(), /name="id-local-admin-setup"/);
  const authenticated = await login(publicOrigin);
  assert.equal(authenticated.status, 200);
  const session = cookie(authenticated);
  assert.match(authenticated.headers.get('set-cookie'), /^__Host-id_session_v2=.*; Path=\/; HttpOnly; SameSite=Strict;.*; Secure$/);
  const security = await (await request('/api/local/auth/security', { session })).json();
  assert.equal(security.available, true);
  assert.equal(security.bound, false);
  assert.equal(security.requiredForExistingActions, false);
  assert.equal((await request('/api/local/auth/security/network', { session, method: 'POST', origin: publicOrigin,
    body: { action: 'add', version: 0 } })).status, 403);
  assert.equal((await request('/api/local/inventory', { session })).status, 200);
  assert.equal((await request('/api/local/inventory', {
    session, method: 'PUT', origin: 'http://' + host, body: {}
  })).status, 403);
  assert.equal((await request('/api/local/inventory', {
    session, method: 'PUT', origin: publicOrigin, body: {}
  })).status, 400);
  assert.equal((await request('/api/id-business-v2/workspace-website-monitor/visits/ingest')).status, 405);
  const saved = await request('/api/local/toolbox', {
    session, method: 'PUT', origin: publicOrigin,
    body: { version: 0, data: { shortcuts: [], phrases: [] } }
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).version, 1);
  const logout = await request('/api/local/auth/logout', { session, method: 'POST', origin: publicOrigin });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0; Secure$/);
  assert.equal((await request('/api/local/inventory', { session })).status, 401);
  const newSession = cookie(await login(publicOrigin));
  await stop();
  ({ server, url } = await startPreview(0, options));
  assert.equal((await request('/api/local/inventory', { session })).status, 401);
  assert.equal((await request('/api/local/inventory', { session: newSession })).status, 200);
  const persisted = await request('/api/local/toolbox', { session: newSession });
  assert.equal(persisted.status, 200);
  assert.equal((await persisted.json()).version, 1);
  const securityCommand = (action, body, session) => request('/api/local/auth/security/' + action, {
    method: 'POST', origin: publicOrigin, session, body
  });
  const start = await securityCommand('start', { password: supervisor.password }, newSession);
  assert.equal(start.status, 200);
  const { enrollment, setupKey } = await start.json();
  const { code } = await calculateTotp(setupKey, Date.now());
  const enrolled = await securityCommand('confirm', { enrollment, code }, newSession);
  assert.equal(enrolled.status, 200);
  const { recoveryCodes } = await enrolled.json();
  await stop();
  ({ server, url } = await startPreview(0, options));
  const pending = await login(publicOrigin);
  assert.equal(pending.status, 202);
  const { verification } = await pending.json();
  const verified = await request('/api/local/auth/login/verify', { method: 'POST', origin: publicOrigin,
    body: { verification, code: recoveryCodes[0] } });
  assert.equal(verified.status, 200);
  const bound = await (await request('/api/local/auth/security', { session: cookie(verified) })).json();
  assert.equal(bound.bound, true);
  assert.equal(bound.requiredForExistingActions, true);
  assert.equal(bound.recoveryRemaining, 7);
});

test('opt-in browser setup creates the fixed local admin once and protects the business API', async (t) => {
  const authPath = await useAccounts(t);
  const { server, url } = await startPreview(0, {
    databasePath: ':memory:',
    authPath,
    bootstrapLocalAdmin: true
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = new URL(url).origin;
  const post = (path, body, headers = {}) => fetch(url + 'api/local/auth/' + path, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers },
    body: JSON.stringify(body)
  });
  const password = supervisor.password;
  const setup = { password, confirmation: password, email: ordinaryAdmin.email, role: 'employee' };
  assert.match(await (await fetch(url)).text(), /name="id-local-admin-setup"/);
  assert.equal((await fetch(url + 'api/local/inventory')).status, 401);
  assert.equal((await post('setup', setup, { Origin: 'https://other.example.test' })).status, 403);
  assert.equal((await post('setup', setup, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post('setup', { ...setup, confirmation: 'different' })).status, 400);
  const results = await Promise.all([post('setup', setup), post('setup', setup)]);
  assert.deepEqual(results.map((response) => response.status).sort(), [201, 409]);
  assert.equal((await post('setup', setup)).status, 409);
  assert.doesNotMatch(await (await fetch(url)).text(), /name="id-local-admin-setup"/);
  const login = await post('login', { email: localAdminEmail, password });
  assert.equal(login.status, 200);
  const headers = { Cookie: cookie(login) };
  const employees = await (await fetch(url + 'api/local/auth/employees', { headers })).json();
  assert.deepEqual(employees.employees.map(({ email, role }) => ({ email, role })), [
    { email: localAdminEmail, role: 'super' }
  ]);
  assert.equal((await fetch(url + 'api/local/inventory', { headers })).status, 200);
  assert.equal((await readFile(authPath, 'utf8')).includes(password), false);
});

test('loopback same-origin login yields an opaque, expiring HttpOnly session', async (t) => {
  let now = 1_000_000;
  const seen = [];
  const { request, login, superUser } = await startAuth(t, {
    now: () => now,
    onEvent(event) {
      seen.push(event);
      throw new Error('simulated unavailable audit sink');
    }
  });
  assert.deepEqual(await (await request('/session')).json(), { configured: true, actor: null });
  for (const requestOrigin of [null, 'http://malicious.example.test']) {
    assert.equal(
      (await request('/login', { method: 'POST', requestOrigin, body: supervisor })).status,
      403
    );
  }
  assert.equal((await login({ ...supervisor, password: 'incorrect' })).status, 401);
  const signedIn = await login({ ...supervisor, email: supervisor.email.toUpperCase() });
  assert.equal(signedIn.status, 200);
  assert.match(signedIn.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=28800/);
  assert.deepEqual(await signedIn.json(), { actor: superUser });
  const first = cookie(signedIn);
  assert.deepEqual(await (await request('/session', { session: first })).json(), {
    configured: true,
    actor: superUser
  });
  const signedOut = await request('/logout', { method: 'POST', session: first });
  assert.match(signedOut.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await (await request('/session', { session: first })).json()).actor, null);
  assert.equal((await request('/employees', { session: first })).status, 401);

  const second = cookie(await login());
  assert.notEqual(second, first);
  now += 8 * 60 * 60 * 1000;
  assert.equal((await (await request('/session', { session: second })).json()).actor, null);
  assert.deepEqual(
    seen.map(({ action }) => action),
    ['auth_login', 'auth_logout', 'auth_login']
  );
  assert.equal(
    seen.some(({ actor }) => actor.credential),
    false
  );
});

test('only the unique super administrator can edit employees and stale sessions are revoked', async (t) => {
  const { request, login, accountPath, superUser } = await startAuth(t);
  const adminSession = cookie(await login());
  const created = await request('/employees', {
    method: 'POST',
    body: ordinaryAdmin,
    session: adminSession
  });
  assert.equal(created.status, 201);
  const { employee } = await created.json();
  const list = await (await request('/employees', { session: adminSession })).json();
  assert.deepEqual(list.employees, [superUser, employee]);
  assert.equal(JSON.stringify(list).includes('credential'), false);
  const employeeSession = cookie(await login(ordinaryAdmin));
  assert.ok(employeeSession);
  assert.equal((await request('/employees', { session: employeeSession })).status, 403);

  const update = (id, body, session = adminSession) =>
    request('/employees/' + id, { method: 'PATCH', session, body });
  assert.equal(
    (await update(superUser.id, { active: false, version: superUser.version })).status,
    403
  );
  assert.equal(
    (await update(employee.id, { role: 'super', version: employee.version })).status,
    403
  );
  const disabled = await update(employee.id, { active: false, version: employee.version });
  assert.equal(disabled.status, 200);
  assert.equal(
    (await (await request('/session', { session: employeeSession })).json()).actor,
    null
  );
  assert.equal((await login(ordinaryAdmin)).status, 401);
  assert.equal(
    (await update(employee.id, { role: 'employee', version: employee.version })).status,
    409
  );
  const enabled = await update(employee.id, {
    active: true,
    role: 'employee',
    password: 'New-Password-Only@937',
    version: (await disabled.json()).employee.version
  });
  assert.equal(enabled.status, 200);
  assert.equal((await login(ordinaryAdmin)).status, 401);
  assert.equal(
    (await (await login({ ...ordinaryAdmin, password: 'New-Password-Only@937' })).json()).actor
      .role,
    'employee'
  );
  assert.equal((await readFile(accountPath, 'utf8')).includes('New-Password-Only@937'), false);
  assert.equal(
    (await (await request('/session', { session: employeeSession })).json()).actor,
    null
  );
});

test('login attempts are bounded and recover after the rate window', async (t) => {
  let now = 2_000_000;
  const { login } = await startAuth(t, { now: () => now });
  for (let i = 0; i < 6; i++) {
    assert.equal((await login({ ...supervisor, password: 'x'.repeat(300) })).status, 401);
  }
  const throttled = await login();
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get('retry-after'), '60');
  now += 60_000;
  assert.equal((await login()).status, 200);
});
