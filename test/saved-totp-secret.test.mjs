import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { handleLocalBusiness } from '../server/local-business.mjs';
import { revealSavedTotpSecret, savedTotpMetadata, validateTotpWrite } from '../server/tools/saved-totp.mjs';

// Public RFC 6238 fixture; no real account credentials or database.
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const id = '11111111-1111-4111-8111-111111111111';
const actor = { id: 'alice', role: 'employee' };
const snapshot = { version: 2, data: [{ id, name: '公开测试账号', secret }] };
function fixture() {
  const audits = [], reads = [];
  const dependencies = {
    readSnapshot(domain) {
      reads.push(domain);
      return domain === 'saved-totp:alice' ? snapshot : { version: 2, data: [] };
    },
    recordView: (targetId, version) => audits.push({ targetId, version })
  };
  return { dependencies, audits, reads };
}

test('edit reveals only the current owner record and audits identifiers without secret content', () => {
  const { dependencies, audits, reads } = fixture();
  assert.deepEqual(revealSavedTotpSecret({ id, version: 2 }, actor, dependencies), { id, version: 2, secret });
  assert.deepEqual(reads, ['saved-totp:alice']);
  assert.deepEqual(audits, [{ targetId: id, version: 2 }]);
  assert(!JSON.stringify(audits).includes(secret));
  assert(!JSON.stringify(savedTotpMetadata(snapshot)).includes(secret));
  assert.throws(() => revealSavedTotpSecret({ id, version: 2, ownerId: 'alice', actor }, { id: 'bob' }, dependencies), { status: 404 });
  assert.equal(reads.at(-1), 'saved-totp:bob');
  assert.equal(audits.length, 1);
});

test('reveal rejects stale, deleted, unauthenticated and malformed requests without auditing a view', () => {
  const { dependencies, audits } = fixture();
  for (const [body, operator, status] of [
    [{ id, version: 2 }, undefined, 401],
    [{ id, version: 1 }, actor, 409],
    [{ id: '22222222-2222-4222-8222-222222222222', version: 2 }, actor, 404],
    [null, actor, 400], [{ id, version: -1 }, actor, 400], [{ id, version: '2' }, actor, 400]
  ]) assert.throws(() => revealSavedTotpSecret(body, operator, dependencies), error =>
    error.status === status && !error.message.includes(secret));
  assert.deepEqual(audits, []);
});

test('revealing and resaving a URI preserves its original issuer, algorithm, digits and period', async () => {
  const uri = `otpauth://totp/Test?secret=${secret}&issuer=RFC&algorithm=SHA256&digits=8&period=60`;
  const value = revealSavedTotpSecret({ id, version: 2 }, actor, {
    readSnapshot: () => ({ version: 2, data: [{ id, secret: uri }] }), recordView() {}
  });
  const command = await validateTotpWrite({ action: 'update', id, version: 2, name: '改名', secret: value.secret });
  assert.equal(command.secret, uri);
});

test('secret HTTP route requires authenticated same-origin POST and forbids response caching', async () => {
  const { dependencies } = fixture();
  const calls = [];
  const store = { revealSavedTotp(body, operator) {
    calls.push(operator);
    return revealSavedTotpSecret(body, operator, dependencies);
  } };
  async function call({ method = 'POST', origin = 'https://fixture.invalid', operator = actor, type = 'application/json' } = {}) {
    const request = Readable.from([Buffer.from(JSON.stringify({ id, version: 2, ownerId: 'bob' }))]);
    request.method = method;
    request.headers = { host: 'fixture.invalid', origin, 'content-type': type };
    const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; },
      writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
      end(body) { this.body = JSON.parse(body); } };
    await handleLocalBusiness(request, response, '/api/local/saved-totp/secret', store, operator, { publicOrigin: 'https://fixture.invalid' });
    return response;
  }
  const success = await call();
  assert.equal(success.status, 200);
  assert.deepEqual(success.body, { id, version: 2, secret });
  assert.equal(success.headers['Cache-Control'], 'private, no-store');
  assert.equal((await call({ origin: 'https://other.invalid' })).status, 403);
  assert.equal((await call({ origin: '' })).status, 403);
  assert.equal((await call({ operator: null })).status, 401);
  assert.equal((await call({ method: 'GET' })).status, 405);
  assert.equal((await call({ type: 'text/plain' })).status, 415);
  assert.deepEqual(calls, [actor]);
});
