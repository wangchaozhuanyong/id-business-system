import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const skip = process.env.GITHUB_ACTIONS === 'true' ? false : 'requires the isolated GitHub Actions runner';

function changeContact({ version, data }, id, name, logId) {
  const next = structuredClone(data);
  const index = next.customers.findIndex(row => row.id === id);
  assert.ok(index >= 0, 'the contact must exist in the session snapshot');
  const before = next.customers[index];
  const after = { ...before, name, version: before.version + 1 };
  const log = { id: logId, entityId: id, type: '修改资料' };
  next.customers[index] = after;
  next.logs.unshift(log);
  return { version, data: next, action: '修改资料', recordChange: { list: 'customers', before, after, log } };
}

test('two signed-in accounts save independently, detect conflicts, and only replay their own writes', {
  skip, timeout: 30_000
}, async t => {
  const { initializeLocalAdmin } = await import('../server/local-auth.mjs');
  const { startPreview } = await import('../server/preview.mjs');
  const runtime = new URL('../.runtime/', import.meta.url);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(new URL('dual-session-write-', runtime));
  const authPath = join(directory, 'accounts.json');
  let server;
  t.after(async () => {
    try {
      if (server) {
        const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeAllConnections();
        await closed;
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  const ownerAccount = { email: 'owner@example.test', name: '隔离站初始化账号', password: randomUUID() };
  await initializeLocalAdmin(authPath, ownerAccount);
  const preview = await startPreview(0, {
    databasePath: ':memory:', authPath,
    storefrontAdmissionDirectory: null, monitoringProbeSecret: null,
    monitoringWorkerReceiptsDirectory: null, monitoringBackupReceiptsDirectory: null
  });
  server = preview.server;
  const origin = new URL(preview.url).origin;
  assert.equal(new URL(origin).hostname, '127.0.0.1');

  const request = (path, { cookie, method = 'GET', body, operation } = {}) =>
    fetch(origin + '/api/local/' + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: {
        ...(cookie && { Cookie: cookie }),
        ...(body && { Origin: origin, 'Content-Type': 'application/json' }),
        ...(operation && { 'X-ID-Operation': operation })
      },
      body: body && JSON.stringify(body)
    });
  const read = async (path, cookie) => {
    const response = await request(path, { cookie });
    assert.equal(response.status, 200, path + ' read');
    return response.json();
  };
  const login = async ({ email, password }) => {
    const response = await request('auth/login', { method: 'POST', body: { email, password } });
    assert.equal(response.status, 200, 'fixture login');
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie, 'login issued a session cookie');
    const { actor } = await response.json();
    assert.equal(actor.email, email);
    return { actor, cookie };
  };
  const save = (session, body, operation) => request('commerce', {
    cookie: session.cookie, method: 'PUT', body, operation
  });

  assert.equal((await request('commerce')).status, 401);
  const owner = await login(ownerAccount);
  const sessions = [];
  // Both writers have the same role, so a receipt scoped only by role would collide.
  for (const suffix of ['a', 'b']) {
    const account = { email: 'writer-' + suffix + '@example.test', name: '隔离管理员 ' + suffix, password: randomUUID() };
    const created = await request('auth/employees', {
      cookie: owner.cookie, method: 'POST', body: { ...account, role: 'admin' }
    });
    assert.equal(created.status, 201, 'create isolated writer');
    const { employee } = await created.json();
    const session = await login(account);
    assert.equal(session.actor.id, employee.id);
    assert.equal(session.actor.role, 'admin');
    sessions.push(session);
  }
  const [first, second] = sessions;
  assert.notEqual(first.actor.id, second.actor.id);
  assert.ok(first.cookie !== second.cookie, 'each account has its own session');
  for (const session of sessions) {
    const { actor } = await read('auth/session', session.cookie);
    assert.equal(actor.id, session.actor.id);
  }

  const customers = ['a', 'b'].map(id => ({
    id, name: '隔离客户 ' + id, version: 1, updatedById: owner.actor.id
  }));
  const seeded = await save(owner, {
    version: 0, action: '新增资料',
    data: { customers, tenants: [], orders: [], operating: [], rentBatches: [], logs: [] }
  });
  assert.equal(seeded.status, 200, 'seed isolated contacts');
  const { version: seedVersion } = await seeded.json();

  const snapshots = () => Promise.all(sessions.map(({ cookie }) => read('commerce', cookie)));
  const [initialA, initialB] = await snapshots();
  assert.deepEqual([initialA.version, initialB.version], [seedVersion, seedVersion]);
  const distinctEdits = [
    changeContact(initialA, 'a', '甲的保存', 'different-a'),
    changeContact(initialB, 'b', '乙的保存', 'different-b')
  ];
  // The same operation key belongs to two different users. Both edits must commit.
  const operation = 'dual-session-different-0001';
  const distinct = await Promise.all(sessions.map((session, index) => save(session, distinctEdits[index], operation)));
  assert.deepEqual(distinct.map(response => response.status), [200, 200]);
  // Discard the original responses and retry the exact requests from both sessions.
  await Promise.all(distinct.map(response => response.body.cancel()));
  const retries = await Promise.all(sessions.map((session, index) => save(session, distinctEdits[index], operation)));
  for (const response of retries) {
    assert.equal(response.status, 200, 'replay the committed operation');
    const { version, data } = await response.json();
    assert.equal(version, seedVersion + 2);
    assert.deepEqual(data.customers.map(row => row.name), ['甲的保存', '乙的保存']);
    assert.deepEqual(data.customers.map(row => row.updatedById), sessions.map(({ actor }) => actor.id));
    assert.deepEqual(data.logs.map(row => row.id).sort(), ['different-a', 'different-b']);
  }
  const reused = await save(first, distinctEdits[1], operation);
  assert.equal(reused.status, 409, 'another account’s exact payload cannot reuse this account’s receipt');
  assert.match((await reused.json()).error, /同一保存操作的内容已变化/);
  const audit = async () => (await read('audit', first.cookie))
    .filter(row => row.domain === 'commerce' && row.action === '修改资料');
  assert.deepEqual((await audit()).map(row => row.actorId).sort(), sessions.map(row => row.actor.id).sort());

  const conflictSnapshots = await snapshots();
  assert.deepEqual(conflictSnapshots.map(row => row.version), [seedVersion + 2, seedVersion + 2]);
  const competing = conflictSnapshots.map((snapshot, index) =>
    changeContact(snapshot, 'a', '争用者 ' + index, 'same-' + index));
  const conflictKey = 'dual-session-conflict-0001';
  const replies = await Promise.all(sessions.map((session, index) => save(session, competing[index], conflictKey)));
  assert.deepEqual(replies.map(response => response.status).sort(), [200, 409]);
  const winner = replies.findIndex(response => response.status === 200);
  const loser = 1 - winner;
  await replies[winner].json();
  assert.match((await replies[loser].json()).error, /这条资料已被其他操作更新/);
  const retryConflict = await save(sessions[loser], competing[loser], conflictKey);
  assert.equal(retryConflict.status, 409, 'a failed edit cannot be replayed as a successful write');
  await retryConflict.json();
  for (const { version, data } of await snapshots()) {
    assert.equal(version, seedVersion + 3);
    assert.deepEqual(data.customers.map(row => row.name), [competing[winner].recordChange.after.name, '乙的保存']);
    assert.equal(data.customers[0].updatedById, sessions[winner].actor.id);
    assert.deepEqual(data.logs.map(row => row.id).sort(), ['different-a', 'different-b', 'same-' + winner]);
  }
  const editors = [...sessions.map(row => row.actor.id), sessions[winner].actor.id].sort();
  assert.deepEqual((await audit()).map(row => row.actorId).sort(), editors);

  // An independent owner-scoped readback checks the session boundary for personal data.
  const toolboxes = sessions.map((_, index) => ({
    shortcuts: [{ id: 'same-id', name: '个人工具 ' + index, url: '' }], phrases: []
  }));
  const toolboxWrites = await Promise.all(sessions.map(({ cookie }, index) => request('toolbox', {
    cookie, method: 'PUT', body: { version: 0, data: toolboxes[index] }
  })));
  assert.deepEqual(toolboxWrites.map(response => response.status), [200, 200]);
  await Promise.all(toolboxWrites.map(response => response.json()));
  for (const [index, { cookie }] of sessions.entries()) {
    assert.deepEqual(await read('toolbox', cookie), { version: 1, data: toolboxes[index] });
  }
});
