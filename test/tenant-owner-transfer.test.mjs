import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { planTenantOwnerTransfer, checkTenantTransferHistory, tenantOwnerTransferView } from '../server/tenant-owner-transfer.mjs';
import { attributeCommerce, handleLocalBusiness } from '../server/local-business.mjs';

const actor = { id: 'manager', name: '管理人员', role: 'admin' };
const staff = { id: 'staff', name: '接手员工', role: 'employee' };
const fixture = () => ({ version: 3, data: { customers: [], tenants: [
  { id: 'tenant', name: '合成租户', ownerId: 'old', owner: '原负责人', version: 2,
    createdById: 'creator', createdBy: '原录入人', phone: '合成电话' }
], orders: [{ id: 'order', tenantId: 'tenant', ownerId: 'sales', owner: '录单员工' }],
operating: [], rentBatches: [{ id: 'rent', items: [{ tenantId: 'tenant' }] }], logs: [] } });
const command = (patch = {}) => ({ tenantId: 'tenant', ownerId: staff.id, version: 3, tenantVersion: 2,
  reason: '员工交接', operationId: 'tenant-transfer-00000000-0000-4000-8000-000000000001', ...patch });

test('管理员和超管可转交，原录入人、历史订单及付租对象逐项保持', () => {
  for (const role of ['admin', 'super']) {
    const before = fixture(), original = structuredClone(before);
    const result = planTenantOwnerTransfer(before, command(), { ...actor, role }, () => [staff], '2026-11-08T05:00:00Z');
    assert.deepEqual(before, original, '不改调用者的快照');
    assert.equal(result.version, 4);
    const tenant = result.data.tenants[0];
    assert.equal(tenant.version, 3); assert.equal(tenant.ownerId, staff.id); assert.equal(tenant.owner, staff.name);
    assert.equal(tenant.createdById, 'creator'); assert.equal(tenant.updatedById, actor.id);
    assert.deepEqual(result.data.orders, before.data.orders); assert.deepEqual(result.data.rentBatches, before.data.rentBatches);
    assert.deepEqual(result.data.logs, before.data.logs);
    assert.deepEqual(tenant.ownerTransfers, [result.receipt]);
    assert.equal(result.receipt.fromOwnerId, 'old'); assert.equal(result.receipt.fromOwner, '原负责人');
    assert.equal(result.receipt.toOwner, staff.name); assert.equal(result.receipt.actorId, actor.id);
    assert.equal(result.receipt.reason, '员工交接');
  }
});
test('历史文字归属通过管理员明确选择补绑，停用租户也可办理交接', () => {
  const before = fixture(); delete before.data.tenants[0].ownerId; before.data.tenants[0].active = false;
  before.data.tenants[0].owner = staff.name;
  const result = planTenantOwnerTransfer(before, command(), actor, () => [staff]);
  assert.equal(result.receipt.fromOwnerId, ''); assert.equal(result.receipt.fromOwner, staff.name);
  assert.equal(result.data.tenants[0].ownerId, staff.id); assert.equal(result.data.tenants[0].active, false);
});
test('非管理员、失效员工、非法字段、空原因、版本冲突和相同归属均拒绝', () => {
  for (const role of ['employee', 'unknown']) assert.throws(() => planTenantOwnerTransfer(fixture(), command(), { ...actor, role }, () => [staff]), { status: 403 });
  for (const rows of [[], [{ ...staff, active: false }], [{ ...staff, role: 'customer' }]])
    assert.throws(() => planTenantOwnerTransfer(fixture(), command(), actor, () => rows), { status: 409 });
  for (const patch of [{ reason: '' }, { reason: 'a'.repeat(501) }, { reason: '\0' }, { version: '3' }, { ownerId: {} }, { extra: 'ignored' }])
    assert.throws(() => planTenantOwnerTransfer(fixture(), command(patch), actor, () => [staff]), { status: 400 });
  for (const patch of [{ version: 2 }, { tenantVersion: 1 }, { ownerId: 'old' }])
    assert.throws(() => planTenantOwnerTransfer(fixture(), command(patch), actor, () => [staff]), { status: 409 });
  assert.throws(() => planTenantOwnerTransfer(fixture(), command({ tenantId: 'missing' }), actor, () => [staff]), { status: 404 });
  assert.throws(() => planTenantOwnerTransfer(fixture(), command(), actor, () => { throw Error('private directory failure'); }), { status: 503 });
});
test('丢失响应重试回读原回执，员工后来停用或再次转交也不重复改变结果', () => {
  const saved = planTenantOwnerTransfer(fixture(), command(), actor, () => [staff]);
  const after = structuredClone(saved); after.version++;
  after.data.tenants[0].ownerId = 'newer'; after.data.tenants[0].owner = '后续负责人';
  const replay = planTenantOwnerTransfer(after, command(), actor, () => { throw Error('must not read directory'); });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, saved.receipt);
  assert.equal(replay.data.tenants[0].ownerId, 'newer'); assert.equal(replay.version, after.version);
  for (const patch of [{ ownerId: 'other' }, { reason: '另一原因' }, { version: 4 }])
    assert.throws(() => planTenantOwnerTransfer(saved, command(patch), actor, () => [staff]), { status: 409 });
  assert.throws(() => planTenantOwnerTransfer(saved, command(), { ...actor, id: 'other-admin' }, () => [staff]), { status: 409 });
});
test('普通保存不能转移归属、伪造或移除历史，也不能删除有交接记录的租户', () => {
  const saved = planTenantOwnerTransfer(fixture(), command(), actor, () => [staff]);
  for (const mutate of [d => { d.tenants[0].ownerId = actor.id; }, d => { d.tenants[0].ownerTransfers[0].reason = '伪造'; },
    d => { delete d.tenants[0].ownerTransfers; }, d => { d.tenants = []; }]) {
    const next = structuredClone(saved.data); mutate(next);
    assert.throws(() => attributeCommerce(next, saved.data, actor, [staff]), { status: 409 });
  }
  const forged = fixture(); forged.data.tenants[0].ownerTransfers = [saved.receipt];
  assert.throws(() => checkTenantTransferHistory(forged.data.tenants, fixture().data.tenants), { status: 409 });
  const edited = structuredClone(saved.data); edited.tenants[0].notes = '正常更正备注'; edited.tenants[0].version++;
  attributeCommerce(edited, saved.data, actor, []);
  assert.deepEqual(edited.tenants[0].ownerTransfers, saved.data.tenants[0].ownerTransfers);
});

async function call({ method = 'POST', actor: operator = actor, origin = 'https://tenant.invalid', body = command(), store } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.url = '/api/local/tenant-owner-transfer?tenantId=tenant'; req.method = method;
  req.headers = { host: 'tenant.invalid', origin, 'content-type': 'application/json' };
  let status, output; const headers = {};
  const res = { setHeader: (key, value) => { headers[key] = value; }, writeHead: code => { status = code; }, end: value => { output = JSON.parse(value); } };
  await handleLocalBusiness(req, res, '/api/local/tenant-owner-transfer', store, operator,
    { publicOrigin: 'https://tenant.invalid', readOrderOwners: () => [staff] });
  return { status, output, headers };
}
test('HTTP 入口校验管理员、来源及方法，使用服务端人员目录而非请求姓名', async () => {
  let snapshot = fixture(), writes = 0;
  const store = { tenantOwnerTransferView: id => tenantOwnerTransferView(snapshot, id),
    transferTenantOwner(body, user, readOwners) {
      const result = planTenantOwnerTransfer(snapshot, body, user, readOwners);
      if (!result.replayed) { writes++; snapshot = { version: result.version, data: result.data }; }
      return result;
    } };
  for (const operator of [null, { ...actor, role: 'employee' }]) assert.equal((await call({ actor: operator, store })).status, 403);
  assert.equal((await call({ origin: 'https://other.invalid', store })).status, 403);
  assert.equal((await call({ store })).status, 200);
  assert.equal(writes, 1);
  const retry = await call({ store }); assert.equal(retry.status, 200); assert.equal(retry.output.replayed, true); assert.equal(writes, 1);
  assert.equal((await call({ method: 'PATCH', store })).status, 405);
  const view = await call({ method: 'GET', store }); assert.equal(view.status, 200);
  assert.equal(view.output.tenant.ownerId, staff.id); assert.equal(view.output.history.length, 1);
  assert.equal(view.headers['Cache-Control'], 'private, no-store');
  assert.equal((await call({ origin: '', store })).status, 403);
});
