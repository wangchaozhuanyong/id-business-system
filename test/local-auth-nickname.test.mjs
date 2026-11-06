import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createLocalAuth, initializeLocalAdmin } from '../server/local-auth.mjs';

async function call(auth, path, { method = 'GET', session, body } = {}) {
  const request = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  request.url = '/api/local/auth' + path;
  request.method = method;
  request.headers = {
    host: 'localhost:1234',
    origin: 'http://localhost:1234',
    'content-type': 'application/json',
    ...(session ? { cookie: session } : {})
  };
  const headers = {};
  let status, data;
  const response = {
    setHeader(name, value) { headers[name] = value; },
    writeHead(value) { status = value; },
    end(value) { data = JSON.parse(value); }
  };
  await auth.handle(request, response);
  return { status, data, session: headers['Set-Cookie']?.split(';', 1)[0] };
}

test('employees set their nickname once and historical IDs resolve the latest administrator change', async t => {
  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(join(runtime, 'nickname-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const accounts = join(directory, 'employees.json');
  const supervisor = { email: 'supervisor@example.test', name: '测试超管', password: 'test-only-supervisor' };
  const staff = { email: 'staff@example.test', name: '初始姓名', password: 'test-only-employee', role: 'employee' };
  const audit = [];
  const administrator = await initializeLocalAdmin(accounts, supervisor);
  const auth = createLocalAuth(accounts, { onEvent: event => audit.push(event) });
  const post = (path, body, session) => call(auth, path, { method: 'POST', body, session });
  const superSession = (await post('/login', supervisor)).session;
  assert(superSession);
  const { data: { employee } } = await post('/employees', staff, superSession);
  const session = (await post('/login', staff)).session;
  assert(session);

  assert.equal((await call(auth, '/display-names')).status, 401);
  assert.equal(employee.nicknameSet, false);
  assert.equal((await post('/nickname', { nickname: '员工昵称', id: administrator.id }, session)).status, 400);
  const result = await post('/nickname', { nickname: '员工昵称' }, session);
  assert.equal(result.status, 200);
  assert.equal(result.data.actor.name, '员工昵称');
  assert.equal(result.data.actor.nicknameSet, true);
  assert.equal((await post('/nickname', { nickname: '第二次' }, session)).status, 409);
  assert.equal((await call(auth, '/employees/' + employee.id, {
    method: 'PATCH', session, body: { nickname: '第二次', version: result.data.actor.version }
  })).status, 403);

  const changed = await call(auth, '/employees/' + employee.id, {
    method: 'PATCH', session: superSession,
    body: { nickname: '超管更新后的昵称', version: result.data.actor.version }
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.employee.id, employee.id);
  assert.equal((await call(auth, '/session', { session })).data.actor.name, '超管更新后的昵称');
  assert.deepEqual((await call(auth, '/display-names', { session })).data.items, [
    { id: administrator.id, name: supervisor.name },
    { id: employee.id, name: '超管更新后的昵称' }
  ]);
  assert.equal((await call(auth, '/employees/' + employee.id, {
    method: 'PATCH', session: superSession, body: { active: false, version: changed.data.employee.version }
  })).status, 200);
  assert.equal((await call(auth, '/display-names', { session })).status, 401);
  assert.deepEqual((await call(auth, '/display-names', { session: superSession })).data.items[1], {
    id: employee.id, name: '超管更新后的昵称'
  });
  assert(audit.some(event => event.action === 'auth_nickname_set' && event.targetId === employee.id));
});
