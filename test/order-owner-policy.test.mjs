import assert from 'node:assert/strict';
import test from 'node:test';
import { assignOrderOwner } from '../server/order-policy.mjs';

const admin = { id: 'admin', name: '代录管理员', role: 'admin' };
const staff = { id: 'staff', name: '业务员工', role: 'employee' };

test('管理员选择系统人员，服务端按编号确定姓名，默认归属实际操作人', () => {
  for (const role of ['admin', 'super']) {
    const order = { ownerId: staff.id, owner: '客户端伪造姓名', createdById: 'creator' };
    assert.equal(assignOrderOwner(order, null, { ...admin, role }, [staff]), undefined);
    assert.equal(order.ownerId, staff.id);
    assert.equal(order.owner, staff.name);
    assert.equal(order.createdById, 'creator', '归属处理不得冒充录入人');
  }
  const own = {};
  assignOrderOwner(own, null, admin);
  assert.deepEqual(own, { ownerId: admin.id, owner: admin.name });
});

test('员工不能代其他人指定，停用、已删除及非法归属均拒绝', () => {
  assert.equal(assignOrderOwner({ ownerId: admin.id }, null, staff, [admin]).status, 403);
  for (const owners of [[], [{ ...staff, active: false }], [{ ...staff, role: 'unknown' }]])
    assert.equal(assignOrderOwner({ ownerId: staff.id }, null, admin, owners).status, 409);
  assert.equal(assignOrderOwner({ ownerId: {} }, null, admin, [staff]).status, 400);
});

test('原单归属不可通过更正转移，保留历史姓名快照且不补写旧记录', () => {
  const prior = { ownerId: staff.id, owner: '原姓名' };
  const retained = { ...prior, owner: '伪造修改' };
  assignOrderOwner(retained, prior, admin, [{ ...staff, name: '新昵称' }]);
  assert.deepEqual(retained, prior);
  assert.equal(assignOrderOwner({ ownerId: admin.id }, prior, admin, [staff]).status, 409);
  const historical = { createdById: staff.id, owner: '旧资料' };
  const copy = { ...historical, owner: '' };
  assignOrderOwner(copy, historical, admin);
  assert.deepEqual(copy, historical);
  assert.equal(assignOrderOwner({ ...copy, ownerId: admin.id }, historical, admin).status, 409);
});
