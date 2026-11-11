import assert from 'node:assert/strict';
import test from 'node:test';
import { assignTenantOwner } from '../server/order-policy.mjs';
import { attributeCommerce, createLocalBusinessStore } from '../server/local-business.mjs';

const admin = { id: 'admin', name: '代录管理员', role: 'admin' };
const staff = { id: 'staff', name: '业务员工', role: 'employee' };
const commerce = (tenants = [], orders = []) => ({ customers: [], tenants, orders, operating: [], rentBatches: [], logs: [] });

test('租户保存拒绝其他租户已占用的号码，查重包含停用租户和常见号码格式', t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const data = commerce([
    { id: 'active', name: '合成租户甲', phone: '+1 (202) 555-0101', version: 1, active: true },
    { id: 'disabled', name: '合成租户乙', phone: '001 202 555 0102', version: 1, active: false }
  ]);
  data.customers.push({ id: 'customer', name: '合成客户', phone: data.tenants[0].phone, version: 1 });
  const save = (version, data) => store.saveBatch([{ domain: 'commerce', version, data }], { actor: admin })[0];
  const saved = save(0, data);
  const duplicate = { status: 409, message: '此联系电话已被其他租户使用。' };

  const adding = structuredClone(saved.data);
  adding.tenants.unshift({ id: 'new', name: '不同姓名的租户', phone: '＋１ ２０２ ５５５ ０１０１', version: 1 });
  assert.throws(() => save(saved.version, adding), duplicate);

  const editing = structuredClone(saved.data);
  Object.assign(editing.tenants[0], { phone: '+1 202-555-0102', version: 2 });
  assert.throws(() => save(saved.version, editing), duplicate);
  assert.deepEqual(store.load('commerce'), { version: saved.version, data: saved.data });

  editing.tenants[0].phone = '001 202.555.0101';
  assert.equal(save(saved.version, editing).data.tenants[0].phone, '001 202.555.0101');
});

test('历史重复号码允许修改其他资料，也可以更正为新号码', () => {
  const previous = commerce([
    { id: 'a', phone: '+1 202 555 0101', version: 1 },
    { id: 'b', phone: '001 202 555 0101', version: 1 }
  ]);
  const changed = structuredClone(previous);
  Object.assign(changed.tenants[0], { notes: '更正备注', version: 2 });
  assert.doesNotThrow(() => attributeCommerce(changed, previous, admin, []));
  changed.tenants[0].phone = '+1 202 555 0103';
  assert.doesNotThrow(() => attributeCommerce(changed, previous, admin, []));
});

test('租户新增默认实际录入人，管理员代录按启用员工编号保存姓名快照', () => {
  for (const role of ['super', 'admin', 'employee']) {
    const actor = { ...admin, role };
    const tenant = { owner: '任意填写的文字' };
    assert.equal(assignTenantOwner(tenant, null, actor), undefined);
    assert.deepEqual(tenant, { ownerId: actor.id, owner: actor.name });
    const data = commerce([{ id: 'new-tenant', version: 1 }]);
    attributeCommerce(data, commerce(), actor, []);
    assert.equal(data.tenants[0].ownerId, actor.id);
    assert.equal(data.tenants[0].createdById, actor.id, '客户端省略录入和修改字段仍由服务端生成');
    assert.equal(data.tenants[0].updatedById, actor.id);
  }
  for (const role of ['admin', 'super']) {
    const tenant = { ownerId: staff.id, owner: '伪造员工姓名', createdById: admin.id };
    assert.equal(assignTenantOwner(tenant, null, { ...admin, role }, [staff]), undefined);
    assert.equal(tenant.ownerId, staff.id);
    assert.equal(tenant.owner, staff.name);
    assert.equal(tenant.createdById, admin.id);
  }
});

test('员工不能指定他人；停用、删除、非法类型和非系统角色归属被拒绝', () => {
  assert.equal(assignTenantOwner({ ownerId: admin.id }, null, staff, [admin]).status, 403);
  for (const owners of [[], [{ ...staff, active: false }], [{ ...staff, role: 'unknown' }]])
    assert.equal(assignTenantOwner({ ownerId: staff.id }, null, admin, owners).status, 409);
  for (const ownerId of [{}, [], 123, null])
    assert.equal(assignTenantOwner({ ownerId }, null, admin, [staff]).status, 400);
});

test('租户历史文字不按同名员工猜测编号，已绑定归属保留原快照', () => {
  for (const prior of [{ owner: staff.name }, {}, { ownerId: staff.id, owner: '原姓名' }]) {
    const tenant = { ...prior, owner: '伪造改名' };
    assert.equal(assignTenantOwner(tenant, prior, admin, [{ ...staff, name: '新姓名' }]), undefined);
    assert.deepEqual(tenant, prior);
    assert.equal(assignTenantOwner({ ...prior, ownerId: admin.id }, prior, admin).status, 409);
  }
});

test('真实保存归属处理分别记录租户业务归属、实际录入和修改人，不改订单归属', () => {
  const previous = commerce([], [{ id: 'order', ownerId: admin.id, owner: admin.name }]);
  const next = structuredClone(previous);
  next.tenants.push({ id: 'tenant', version: 1, ownerId: staff.id, owner: '伪造名称', createdById: staff.id,
    createdBy: staff.name, updatedById: staff.id, updatedBy: staff.name });
  next.logs.push({ id: 'log', actorId: staff.id, actor: staff.name });
  attributeCommerce(next, previous, admin, [staff]);
  const tenant = next.tenants[0];
  assert.equal(tenant.ownerId, staff.id);
  assert.equal(tenant.owner, staff.name);
  assert.equal(tenant.createdById, admin.id);
  assert.equal(tenant.createdBy, admin.name);
  assert.equal(tenant.updatedById, admin.id);
  assert.equal(tenant.updatedBy, admin.name);
  assert.equal(next.logs[0].actorId, admin.id);
  assert.deepEqual(next.orders, previous.orders);

  const changed = structuredClone(next);
  Object.assign(changed.tenants[0], { notes: '修改备注', version: 2, createdById: staff.id, createdBy: staff.name });
  delete changed.tenants[0].updatedById;
  attributeCommerce(changed, next, { id: 'editor', name: '修改管理员', role: 'admin' }, []);
  assert.equal(changed.tenants[0].createdById, admin.id);
  assert.equal(changed.tenants[0].updatedById, 'editor');
  assert.equal(changed.tenants[0].ownerId, staff.id, '员工停用后编辑备注仍保留原归属');
  assert.deepEqual(changed.orders, previous.orders);
});

test('保存入口阻止越权和失效归属，历史租户不补造录入人，未修改租户保持不变', () => {
  for (const [actor, owners, status] of [[staff, [admin], 403], [admin, [], 409]]) {
    const next = commerce([{ id: 'tenant', ownerId: actor === staff ? admin.id : staff.id }]);
    assert.throws(() => attributeCommerce(next, commerce(), actor, owners), { status });
  }
  const previous = commerce([{ id: 'old', owner: staff.name, version: 1 }]);
  const next = structuredClone(previous);
  Object.assign(next.tenants[0], { notes: '历史备注更正', version: 2, createdById: admin.id, createdBy: admin.name });
  attributeCommerce(next, previous, admin, [staff]);
  assert.equal(Object.hasOwn(next.tenants[0], 'ownerId'), false);
  assert.equal(Object.hasOwn(next.tenants[0], 'createdById'), false);
  assert.equal(Object.hasOwn(next.tenants[0], 'createdBy'), false);
  assert.equal(next.tenants[0].owner, staff.name);
  assert.equal(next.tenants[0].updatedById, admin.id);
  const unchanged = structuredClone(next);
  attributeCommerce(unchanged, next, staff, []);
  assert.deepEqual(unchanged, next);
});
