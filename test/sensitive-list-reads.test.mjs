import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { handleLocalBusiness } from '../server/local-business.mjs';
import { mailboxPoolCodePage } from '../server/tools/mailbox-pool.mjs';
import { generateSavedCodePage } from '../server/tools/saved-totp.mjs';

test('mailbox page reads only requested codes from the matching list version', () => {
  const snapshot = { version: 3, data: { items: [
    { id: 'visible', queryCode: 'SYNTHETIC-QUERY', appPassword: 'SYNTHETIC-PASSWORD' },
    { id: 'pending' },
    { id: 'other-page', queryCode: 'SYNTHETIC-OTHER-QUERY' }
  ] } };
  assert.deepEqual(mailboxPoolCodePage(snapshot, { ids: ['visible', 'pending'], version: 3 }), {
    version: 3, items: [{ id: 'visible', code: 'SYNTHETIC-QUERY' }, { id: 'pending', code: '' }]
  });
  assert.throws(() => mailboxPoolCodePage(snapshot, { ids: ['visible'], version: 2 }), { status: 409 });
});

test('saved TOTP page shares one calculation time and isolates individual errors', async () => {
  // Public RFC 6238 vector, with an invalid row to cover older stored data.
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const snapshot = { version: 3, data: [
    { id: 'standard', secret },
    { id: 'long-period', secret: `otpauth://totp/Test?secret=${secret}&digits=8&period=60` },
    { id: 'invalid', secret: '!' },
    { id: 'other-page', secret }
  ] };
  const ids = ['standard', 'invalid', 'long-period', 'missing'];
  assert.deepEqual(await generateSavedCodePage(snapshot, { ids, version: 3 }, 59_000), {
    version: 3, serverNow: 59_000, items: [
      { id: 'standard', code: '287082', expiresAt: 60_000 },
      { id: 'invalid', error: '验证码无法生成，请核对密钥' },
      { id: 'long-period', code: '84755224', expiresAt: 60_000 },
      { id: 'missing', error: '找不到已保存的账号' }
    ]
  });
  await assert.rejects(generateSavedCodePage(snapshot, { ids, version: 2 }), { status: 409 });
});

test('existing code routes enforce origin, role, and bounded page input and remain private', async () => {
  const origin = 'https://fixture.invalid';
  const admin = { id: 'fixture-admin', role: 'admin' };
  const employee = { id: 'fixture-employee', role: 'employee' };
  const routes = [
    { resource: 'tools/mailbox-pool', method: 'readManagedMailboxCodePage', single: 'copyManagedMailboxCode', actor: admin },
    { resource: 'saved-totp/code', method: 'readSavedTotpCodePage', single: 'useSavedTotp', actor: employee }
  ];
  const calls = [];
  const store = Object.fromEntries(routes.flatMap(({ method, single }) => [
    [method, (page, actor) => { calls.push([method, page, actor]); return { version: page.version, items: [] }; }],
    [single, (id, actor) => { calls.push([single, id, actor]); return { code: '000000' }; }]
  ]));
  async function post(resource, body, actor, requestOrigin = origin) {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]);
    request.method = 'POST';
    request.headers = { host: 'fixture.invalid', origin: requestOrigin, 'content-type': 'application/json' };
    const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; },
      writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
      end(body) { this.body = JSON.parse(body); } };
    await handleLocalBusiness(request, response, '/api/local/' + resource, store, actor, { publicOrigin: origin });
    return response;
  }
  for (const { resource, method, single, actor } of routes) {
    const page = { ids: ['visible', 'next-visible'], version: 3 };
    const before = calls.length;
    for (const invalid of [
      { ...page, ids: [] }, { ...page, ids: ['visible', 'visible'] }, { ...page, ids: [1] },
      { ...page, ids: Array.from({ length: 51 }, (_, index) => `fixture-${index}`) },
      { ...page, version: -1 }, { ...page, ownerId: 'different-actor' }
    ]) assert.equal((await post(resource, invalid, actor)).status, 400);
    assert.equal((await post(resource, page, actor, 'https://other.invalid')).status, 403);
    assert.equal((await post(resource, page, actor, '')).status, 403);
    const success = await post(resource, page, actor);
    assert.equal(success.status, 200);
    assert.equal(success.headers['Cache-Control'], 'private, no-store');
    assert.deepEqual(success.body, { version: 3, items: [] });
    assert.deepEqual((await post(resource, { id: 'visible' }, actor)).body, { code: '000000' });
    assert.deepEqual(calls.slice(before), [[method, page, actor], [single, 'visible', actor]]);
  }
  assert.equal((await post(routes[0].resource, { ids: ['visible'], version: 3 }, employee)).status, 403);
  assert.equal((await post(routes[1].resource, { ids: ['visible'], version: 3 }, null)).status, 401);
  assert.equal(calls.length, 4);
});
