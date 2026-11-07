import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createLocalAuth, initializeLocalAdmin } from '../server/local-auth.mjs';

// In-process auth unit test: no website, listener or database is started.
async function call(auth, path, { method = 'GET', session, body } = {}) {
  const request = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  request.url = '/api/local/auth' + path;
  request.method = method;
  request.headers = { host: 'localhost:1234', origin: 'http://localhost:1234',
    'content-type': 'application/json', ...(session && { cookie: session }) };
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

test('归属人员接口仅供管理员使用，停用立即排除，返回最少人员资料', async t => {
  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(join(runtime, 'owner-directory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'accounts.json');
  const supervisor = { email: 'owner-super@example.test', name: '测试超管', password: 'test-only-owner-supervisor' };
  await initializeLocalAdmin(path, supervisor);
  const auth = createLocalAuth(path);
  const post = (path, body, session) => call(auth, path, { method: 'POST', body, session });
  const superSession = (await post('/login', supervisor)).session;
  const staff = { email: 'owner-staff@example.test', name: '业务员工', password: 'test-only-owner-employee', role: 'employee' };
  const admin = { email: 'owner-admin@example.test', name: '普通管理员', password: 'test-only-owner-administrator', role: 'admin' };
  const employee = (await post('/employees', staff, superSession)).data.employee;
  await post('/employees', admin, superSession);
  const staffSession = (await post('/login', staff)).session;
  const adminSession = (await post('/login', admin)).session;
  assert.equal((await call(auth, '/order-owners')).status, 401);
  assert.equal((await call(auth, '/order-owners', { session: staffSession })).status, 403);
  for (const session of [superSession, adminSession]) {
    const result = await call(auth, '/order-owners', { session });
    assert.equal(result.status, 200);
    assert.equal(result.data.items.length, 3);
    assert(result.data.items.every(row => Object.keys(row).sort().join(',') === 'id,name,role'));
  }
  assert.equal((await call(auth, '/employees/' + employee.id, { method: 'PATCH', session: superSession,
    body: { active: false, version: employee.version } })).status, 200);
  assert(!auth.orderOwners().some(row => row.id === employee.id));
  assert(!(await call(auth, '/order-owners', { session: adminSession })).data.items.some(row => row.id === employee.id));
  assert((await call(auth, '/display-names', { session: adminSession })).data.items.some(row => row.id === employee.id),
    '历史姓名解析仍包含停用人员');
});
