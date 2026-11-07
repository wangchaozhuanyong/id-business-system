import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { initializeLocalAdmin } from '../server/local-auth.mjs';
import { startPreview } from '../server/preview.mjs';

const takenAt = '2026-11-06 09:15';
const returnedAt = '2026-11-06 09:30';
const aliasIds = ['relay-fixture-a', 'relay-fixture-b'];
const parentId = 'parent-fixture';
const parent = { id: parentId, email: 'parent@example.test', status: 'ACTIVE' };
const mailbox = (id) => ({
  id,
  type: 'relay',
  relayStatus: 'ACTIVE',
  parentMailboxId: parentId,
  email: `${id}@example.test`,
  inventoryState: 'available',
  used: false,
  status: '正常',
  health: 'normal',
  inventoryHistory: [],
  usageLinks: [],
  version: 1
});

const emptyStock = () => ({
  mailboxes: aliasIds.map(mailbox),
  accounts: [],
  batches: [],
  returnRecords: [],
  importRecords: [],
  registrationRecords: [],
  tableSettings: [],
  undo: [],
  appleRelay: { parents: [parent], imports: [], events: [] }
});

function extract(stock, actor, ids = aliasIds, batchId = 'fixture-batch') {
  const next = structuredClone(stock);
  const batch = {
    id: batchId,
    kind: 'mail',
    purpose: '业务备用',
    notes: '',
    time: takenAt,
    actorId: actor.id,
    actorName: actor.name,
    items: []
  };
  for (const id of ids) {
    const row = next.mailboxes.find((item) => item.id === id);
    const claimId = `${batchId}-${id}`;
    batch.items.push({
      id: claimId,
      assetId: row.id,
      type: 'relay',
      email: row.email,
      parentMailboxId: row.parentMailboxId,
      status: 'pending',
      claimedAt: takenAt,
      usedAt: '',
      returnedAt: '',
      reason: '',
      notes: '',
      taskId: '',
      orderId: '',
      registrationId: ''
    });
    Object.assign(row, {
      inventoryState: 'claimed',
      used: true,
      claimId,
      claimBatchId: batchId,
      lastOperatedById: actor.id,
      lastOperatedBy: actor.name,
      lastOperatedAt: takenAt,
      version: row.version + 1
    });
  }
  next.batches.unshift(batch);
  return next;
}

function returnFirst(stock, actor) {
  const next = structuredClone(stock);
  const batch = next.batches[0];
  const item = batch.items[0];
  const row = next.mailboxes.find(({ id }) => id === item.assetId);
  Object.assign(item, { status: 'returned', reason: '未使用', returnedAt });
  Object.assign(row, {
    inventoryState: 'available',
    used: false,
    claimId: '',
    claimBatchId: '',
    lastOperatedAt: returnedAt,
    version: row.version + 1
  });
  next.returnRecords.unshift({
    id: 'fixture-return',
    batchId: batch.id,
    assetId: row.id,
    email: row.email,
    reason: '未使用',
    time: returnedAt,
    actorId: actor.id,
    actor: actor.name,
    notes: ''
  });
  return next;
}

async function startFixture(t) {
  const runtime = new URL('../.runtime/', import.meta.url);
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(new URL('relay-extraction-integration-', runtime));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authPath = join(directory, 'accounts.json');
  const admin = { email: 'relay-admin@example.test', name: '验收管理员', password: randomUUID() };
  await initializeLocalAdmin(authPath, admin);

  const apiKey = randomUUID();
  const expiry = '2099-01-01T00:00:00Z';
  const remoteParent = {
    ...parent,
    id: 'vendure-parent',
    masterQueryCode: 'FIXTURE-MASTER',
    codeExpiresAt: expiry
  };
  const aliases = new Map(
    aliasIds.map((id, index) => [
      id,
      {
        id: `vendure-${id}`,
        primaryAccountId: remoteParent.id,
        aliasEmail: mailbox(id).email,
        buyerQueryCode: `FIXTURE-BUYER-${index + 1}`,
        status: 'ACTIVE',
        codeExpiresAt: expiry
      }
    ])
  );
  const upstream = { calls: [], available: true, aliases };
  const { url, server } = await startPreview(0, {
    databasePath: ':memory:',
    authPath,
    relayConfig: {
      adminUrl: 'http://127.0.0.1:9017/admin-api',
      shopUrl: 'http://127.0.0.1:9017/shop-api',
      apiKey,
      primaryBindings: { [parentId]: remoteParent.id },
      aliasBindings: Object.fromEntries([...aliases].map(([id, row]) => [id, row.id]))
    },
    async relayFetch(target, request) {
      assert.equal(new URL(target).pathname, '/admin-api');
      assert.ok(request.headers['vendure-api-key'] === apiKey);
      const { query, variables } = JSON.parse(request.body);
      assert.deepEqual(variables, {});
      const field = query.includes('icloudPrimaryAccounts')
        ? 'icloudPrimaryAccounts'
        : 'icloudVirtualEmails';
      assert.match(query, new RegExp(`^query \\w+ \\{ ${field} \\{`));
      upstream.calls.push(field);
      if (!upstream.available) return new Response(null, { status: 503 });
      const rows = field === 'icloudPrimaryAccounts' ? [remoteParent] : [...aliases.values()];
      return Response.json({ data: { [field]: rows } });
    }
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = new URL(url).origin;
  async function request(route, { method = 'GET', body, cookie } = {}) {
    const response = await fetch(`${origin}/api/local/${route}`, {
      method,
      headers: {
        ...(cookie && { Cookie: cookie }),
        ...(body !== undefined && { Origin: origin, 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json()
    };
  }
  async function login({ email, password }) {
    const result = await request('auth/login', { method: 'POST', body: { email, password } });
    assert.equal(result.status, 200);
    return { actor: result.body.actor, cookie: result.headers.get('set-cookie').split(';', 1)[0] };
  }
  const { actor, cookie } = await login(admin);
  const call = (route, options = {}) => request(route, { ...options, cookie });
  const relay = (action, body) =>
    call(`apple-relay/${action}`, {
      ...(body !== undefined && { method: 'POST', body })
    });
  const save = (version, data, action, route = 'inventory') =>
    call(route, {
      method: 'PUT',
      body:
        route === 'batch'
          ? [{ domain: 'inventory', version, data, action }]
          : { version, data, action }
    });
  const seeded = await save(0, emptyStock(), 'inventory_relay_alias_import');
  assert.equal(seeded.status, 200, seeded.body.error);
  return { actor, request, login, call, relay, save, upstream, seeded: seeded.body };
}

test('startPreview wires bound relay qualification, stock extraction, code copy and partial return', async (t) => {
  const { actor, request, login, call, relay, save, upstream, seeded } = await startFixture(t);
  assert.equal((await request('apple-relay/status')).status, 401);
  const employee = {
    email: 'relay-employee@example.test',
    name: '验收员工',
    password: randomUUID(),
    role: 'employee'
  };
  assert.equal((await call('auth/employees', { method: 'POST', body: employee })).status, 201);
  const employeeSession = await login(employee);
  assert.equal(
    (
      await request('apple-relay/extraction-eligibility', {
        method: 'POST',
        body: { aliasIds },
        cookie: employeeSession.cookie
      })
    ).status,
    403
  );
  const status = await relay('status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, {
    configured: true,
    codeQueryConfigured: true,
    numbers: { parent: { [parentId]: 'vendure-parent' },
      alias: Object.fromEntries(aliasIds.map((id) => [id, `vendure-${id}`])) },
    parentIds: [parentId],
    aliasIds
  });
  const eligible = await relay('extraction-eligibility', { aliasIds });
  assert.equal(eligible.status, 200);
  assert.deepEqual(
    eligible.body.items,
    aliasIds.map((id) => ({ id, eligible: true, reason: null }))
  );
  assert.doesNotMatch(JSON.stringify(eligible.body), /FIXTURE-BUYER/);
  const extracted = await save(seeded.version, extract(seeded.data, actor), 'inventory_extract');
  assert.equal(extracted.status, 200, extracted.body.error);
  assert.equal(extracted.body.version, seeded.version + 1);
  assert.equal(upstream.calls.length, 4, 'the save must recheck both directories');
  const claims = extracted.body.data.batches[0].items;
  const claimIds = claims.map(({ id }) => id);
  const copy = await relay('extraction-codes', { claimIds });
  assert.equal(copy.status, 200);
  assert.deepEqual(
    copy.body.items,
    claims.map(({ id, email }, index) => ({
      id,
      email,
      queryCode: `FIXTURE-BUYER-${index + 1}`
    }))
  );
  assert.equal(upstream.calls.length, 6);

  upstream.available = false;
  const partialReturn = await save(
    extracted.body.version,
    returnFirst(extracted.body.data, actor),
    'inventory_return'
  );
  upstream.available = true;
  assert.equal(partialReturn.status, 200, partialReturn.body.error);
  assert.equal(upstream.calls.length, 6, 'return does not require a provider lookup');
  assert.deepEqual(
    partialReturn.body.data.batches[0].items.map(({ status: state }) => state),
    ['returned', 'pending']
  );
  assert.deepEqual(
    partialReturn.body.data.mailboxes.map(({ inventoryState }) => inventoryState),
    ['available', 'claimed']
  );
  assert.equal(partialReturn.body.data.returnRecords[0].assetId, aliasIds[0]);
  const blocked = await relay('extraction-codes', { claimIds });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.items, undefined);
  const stillPending = await relay('extraction-codes', { claimIds: [claimIds[1]] });
  assert.deepEqual(stillPending.body.items, [copy.body.items[1]]);
  const inventory = await call('inventory');
  assert.deepEqual(inventory.body, partialReturn.body);
  const audit = await call('audit');
  assert.equal(audit.body.filter(({ action }) => action === 'relay_read_code').length, 3);
  assert.ok(
    audit.body
      .filter(({ action }) =>
        ['inventory_extract', 'inventory_return', 'relay_read_code'].includes(action)
      )
      .every(({ actorId }) => actorId === actor.id)
  );
  assert.doesNotMatch(
    JSON.stringify({ inventory: inventory.body, audit: audit.body }),
    /FIXTURE-BUYER/
  );
});

test('a previously qualified claim is rejected atomically after upstream disablement on PUT and batch', async (t) => {
  const { actor, call, relay, save, upstream, seeded } = await startFixture(t);
  const ready = await relay('extraction-eligibility', { aliasIds });
  assert.ok(ready.body.items.every(({ eligible }) => eligible));
  upstream.aliases.get(aliasIds[1]).status = 'DISABLED';
  const requested = extract(seeded.data, actor);
  for (const route of ['inventory', 'batch']) {
    const rejected = await save(seeded.version, requested, 'inventory_extract', route);
    assert.equal(rejected.status, 409, rejected.body.error);
    assert.match(rejected.body.error, /未全部通过提取核验/);
    assert.deepEqual((await call('inventory')).body, seeded);
  }
  assert.equal(upstream.calls.length, 6);
  assert.equal(
    (await call('audit')).body.some(({ action }) => action === 'inventory_extract'),
    false
  );
});
