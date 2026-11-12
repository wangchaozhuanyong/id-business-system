import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createAppleRelayService } from '../server/apple-relay/local-service.mjs';
import { createLocalBusinessStore } from '../server/local-business.mjs';

function fixture(count = 51) {
  const parent = { id: 'parent', remotePrimaryId: 'remote-parent', email: 'parent@example.test',
    status: 'ACTIVE', version: 1 };
  const rows = Array.from({ length: count }, (_, index) => ({ id: `alias-${index}`,
    remoteAliasId: `remote-${index}`, email: `alias-${index}@example.test`,
    parentMailboxId: parent.id, type: 'relay', version: 1 }));
  const inventory = { appleRelay: { parents: [parent] }, mailboxes: rows };
  const primaries = [{ id: parent.remotePrimaryId, email: parent.email, status: 'ACTIVE',
    masterQueryCode: 'SYNTHETIC-MASTER' }];
  const aliases = rows.map(row => ({ id: row.remoteAliasId, primaryAccountId: parent.remotePrimaryId,
    aliasEmail: row.email, status: 'ACTIVE', buyerQueryCode: `SYNTHETIC-${row.id}`,
    codeExpiresAt: '2099-01-01T00:00:00Z', mailCount: 7,
    lastMailReceivedAt: '2026-11-11T00:00:00Z', lastQueriedAt: null }));
  const calls = [], audit = [];
  const auditBatches = [];
  let onAudit = () => {}, fail = false;
  const service = createAppleRelayService({
    config: { adminUrl: 'http://127.0.0.1:9017/admin-api', apiKey: 'synthetic-fixture' },
    publicOrigin: 'https://fixture.invalid',
    readInventory: () => structuredClone(inventory),
    fetchImpl: async (_url, init) => {
      const { query, variables } = JSON.parse(init.body);
      assert.match(query, /icloudRelayTargets/);
      calls.push(variables);
      if (fail) return new Response('{}', { status: 503 });
      return Response.json({ data: { icloudRelayTargets: {
        primaries: primaries.filter(row => variables.primaryIds.includes(row.id)),
        aliases: aliases.filter(row => variables.aliasIds.includes(row.id))
          .map(({ buyerQueryCode, ...row }) => ({ ...row, ...(variables.includeCodes && { buyerQueryCode }) }))
      } } });
    },
    recordAction: async entry => { audit.push(entry); await onAudit(entry); },
    recordActions: async entries => {
      auditBatches.push(entries.length);
      audit.push(...entries);
      await onAudit(entries);
    }
  });
  async function request(input, { actor = { id: 'admin-fixture', role: 'admin' },
    origin = 'https://fixture.invalid' } = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(input))]);
    req.method = 'POST';
    req.headers = { host: 'fixture.invalid', origin, 'content-type': 'application/json' };
    const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; },
      writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
      end(body) { this.body = JSON.parse(body); } };
    await service.handle(req, res, '/api/local/apple-relay/code-read', actor);
    return res;
  }
  return { rows, aliases, primaries, calls, audit, auditBatches, request,
    onAudit: callback => { onAudit = callback; }, fail: () => { fail = true; } };
}

test('one visible page sends only its IDs upstream and writes one batch of per-row audits', async () => {
  const state = fixture(1000);
  const ids = state.rows.slice(0, 20).map(row => row.id).reverse();
  const individual = [];
  for (const id of ids) individual.push((await state.request({ kind: 'alias', id })).body);
  assert.equal(state.calls.length, 20);
  state.calls.length = 0; state.audit.length = 0;
  const response = await state.request({ kind: 'alias', ids });
  assert.equal(response.status, 200);
  assert.deepEqual(state.calls, [{ primaryIds: ['remote-parent'],
    aliasIds: ids.map(id => state.rows.find(row => row.id === id).remoteAliasId), includeCodes: true }]);
  assert.deepEqual(response.body.items.map(item => item.id), ids);
  assert.equal(response.body.items.length, 20);
  assert(response.body.items.every(item => item.queryCode === `SYNTHETIC-${item.id}`));
  assert.deepEqual(response.body.items.map(({ id, ...item }) => item), individual);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.match(response.headers['Server-Timing'], /^inventory;dur=[\d.]+, vendure_targets;dur=[\d.]+, audit;dur=[\d.]+, relay_total;dur=[\d.]+$/);
  assert.deepEqual(state.audit.map(entry => entry.aliasId).sort(), [...ids].sort());
  assert(state.audit.every(entry => entry.action === 'read_code' && entry.parentId === 'parent'));
  assert.deepEqual(state.auditBatches, [20]);
  assert.equal(response.body.items[0].mailCount, 7);
  assert(!JSON.stringify(state.audit).includes('SYNTHETIC-'));
  assert(!JSON.stringify(response.body).includes('SYNTHETIC-MASTER'));
});

test('50-row pages remain bounded and a missing or mismatched row does not block its neighbours', async () => {
  const state = fixture();
  state.aliases[1].buyerQueryCode = '';
  state.aliases[2].primaryAccountId = 'other-parent';
  const response = await state.request({ kind: 'alias', ids: state.rows.slice(0, 50).map(row => row.id) });
  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 50);
  assert.equal(response.body.items[1].status, 404);
  assert.equal(response.body.items[2].status, 409);
  assert.equal(response.body.items[1].queryCode, undefined);
  assert.equal(response.body.items[2].queryCode, undefined);
  assert.equal(state.audit.length, 48);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].aliasIds.length, 50);
  assert.deepEqual(state.auditBatches, [48]);
});

test('the largest valid IDs fit one page and parent pages request only their parent IDs', async () => {
  const state = fixture(50);
  state.rows.forEach((row, index) => { row.id = String(index).padEnd(180, 'a'); });
  const response = await state.request({ kind: 'alias', ids: state.rows.map(row => row.id) });
  assert.equal(response.status, 200);
  assert.equal(response.body.items.filter(item => item.queryCode).length, 50);
  assert.equal(state.calls.length, 1);
  state.calls.length = 0;
  const parents = await state.request({ kind: 'parent', ids: ['parent'] });
  assert.equal(parents.status, 200);
  assert.equal(parents.body.items[0].queryCode, 'SYNTHETIC-MASTER');
  assert.deepEqual(state.calls, [{ primaryIds: ['remote-parent'], aliasIds: [], includeCodes: true }]);
});

test('hidden code column reads real statistics without requesting or auditing any code', async () => {
  const state = fixture();
  const response = await state.request({ kind: 'alias', ids: ['alias-0'], includeCode: false });
  assert.equal(response.status, 200);
  assert.equal(response.body.items[0].mailCount, 7);
  assert(!Object.hasOwn(response.body.items[0], 'queryCode'));
  assert.equal(state.calls[0].includeCodes, false);
  assert.deepEqual(state.audit, []);
  assert.deepEqual(state.auditBatches, []);
  assert.match(response.headers['Server-Timing'], /^inventory;dur=[\d.]+, vendure_targets;dur=[\d.]+, relay_total;dur=[\d.]+$/);
});

test('the real audit store records each mailbox and publishes a single committed change', t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  let commits = 0;
  store.subscribeChanges(() => commits++);
  const actor = { id: 'fixture-admin', name: 'Fixture admin', role: 'admin' };
  store.recordAuthEvents(Array.from({ length: 20 }, (_, i) => ({
    action: 'relay_read_code', actor, targetId: 'fixture-alias-' + i
  })));
  assert.equal(commits, 1);
  assert.equal(store.audit().filter(row => row.action === 'relay_read_code').length, 20);
});

test('batch input, identity and origin are checked before upstream reads', async () => {
  const state = fixture();
  for (const body of [
    { kind: 'alias', ids: [] }, { kind: 'alias', ids: ['alias-0', 'alias-0'] },
    { kind: 'alias', ids: [1] }, { kind: 'alias', ids: ['a'.repeat(181)] },
    { kind: 'alias', ids: state.rows.map(row => row.id) },
    { kind: 'invalid', ids: ['alias-0'] }, { kind: 'alias', ids: ['alias-0'], id: 'alias-1' },
    { kind: 'alias', ids: ['alias-0'], ownerId: 'other' }
  ]) assert.equal((await state.request(body)).status, 400);
  const input = { kind: 'alias', ids: ['alias-0'] };
  assert.equal((await state.request(input, { actor: null })).status, 401);
  assert.equal((await state.request(input, { actor: { id: 'worker', role: 'employee' } })).status, 403);
  assert.equal((await state.request(input, { origin: '' })).status, 403);
  assert.equal((await state.request(input, { origin: 'https://other.invalid' })).status, 403);
  assert.deepEqual(state.calls, []);
  assert.deepEqual(state.audit, []);
});

test('changes during asynchronous auditing cannot return the previous mailbox credentials', async () => {
  const state = fixture();
  state.onAudit(() => { state.rows[0].version++; state.rows[0].email = 'changed@example.test'; });
  const response = await state.request({ kind: 'alias', ids: ['alias-0', 'alias-1'] });
  assert.equal(response.status, 200);
  assert.equal(response.body.items[0].status, 409);
  assert.equal(response.body.items[0].queryCode, undefined);
  assert.equal(response.body.items[1].queryCode, 'SYNTHETIC-alias-1');
  assert.equal(state.calls.length, 1);
});

test('an audit failure never returns a successful page', async () => {
  const state = fixture();
  state.onAudit(() => { throw new Error('synthetic audit failure'); });
  const response = await state.request({ kind: 'alias', ids: ['alias-0', 'alias-1'] });
  assert.equal(response.status, 500);
  assert.equal(response.body.items, undefined);
  assert(!JSON.stringify(response.body).includes('SYNTHETIC-'));
});

test('upstream failures fail the page without returning or logging credentials; single reads stay compatible', async () => {
  const state = fixture();
  const single = await state.request({ kind: 'alias', id: 'alias-0' });
  assert.equal(single.status, 200);
  assert.equal(single.body.queryCode, 'SYNTHETIC-alias-0');
  assert.equal(single.body.email, state.rows[0].email);
  state.calls.length = 0; state.audit.length = 0;
  state.fail();
  const response = await state.request({ kind: 'alias', ids: ['alias-0', 'alias-1'] });
  assert.equal(response.status, 502);
  assert(!JSON.stringify(response.body).includes('SYNTHETIC-'));
  assert.deepEqual(state.audit, []);
  assert.equal(state.calls.length, 1);
});
