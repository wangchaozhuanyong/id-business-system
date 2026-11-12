import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeLocalAdmin } from '../server/local-auth.mjs';
import { startPreview } from '../server/preview.mjs';

test('订单保存分别回读业务归属和实际操作人，人员失效或转移归属时整批不写入', () => {
  const store = createLocalBusinessStore(':memory:');
  const actor = { id: 'admin', name: '代录管理员', role: 'admin' };
  const staff = { id: 'staff', name: '业务员工', role: 'employee' };
  let enabled = true;
  const options = { actor, readOrderOwners: () => enabled ? [staff] : [] };
  const data = { customers: [], tenants: [], orders: [{
    id: 'order', product: 'GPT', plan: 'Plus', businessType: '续费', email: 'synthetic@example.test',
    payment: '银行卡', ownerId: staff.id, owner: '伪造名称', createdById: staff.id, createdBy: staff.name, version: 1
  }], operating: [], rentBatches: [], logs: [{ id: 'log', actorId: staff.id, actor: staff.name }] };
  try {
    const [saved] = store.saveBatch([{ domain: 'commerce', version: 0, data, action: '新增独立订单' }], options);
    const order = saved.data.orders[0];
    assert.equal(order.ownerId, staff.id);
    assert.equal(order.owner, staff.name);
    assert.equal(order.createdById, actor.id);
    assert.equal(order.createdBy, actor.name);
    assert.equal(saved.data.logs[0].actorId, actor.id);
    assert.equal(store.audit()[0].actorId, actor.id);
    const transfer = structuredClone(saved.data);
    transfer.orders[0].ownerId = actor.id;
    assert.throws(() => store.saveBatch([{ domain: 'commerce', version: 1, data: transfer }], options), { status: 409 });
    enabled = false;
    const next = structuredClone(saved.data);
    next.orders.push({ ...next.orders[0], id: 'new-order' });
    assert.throws(() => store.saveBatch([{ domain: 'commerce', version: 1, data: next }], options), { status: 409 });
    assert.deepEqual(store.load('commerce'), { version: saved.version, data: saved.data });
    assert.equal(store.audit().length, 1);
  } finally { store.close(); }
});

test('HTTP 保存使用服务端实时人员目录，管理员代录不冒充员工，员工无代录权限', async t => {
  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(join(runtime, 'order-owner-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authPath = join(directory, 'accounts.json');
  const superUser = { email: 'http-super@example.test', name: '测试超管', password: 'test-only-http-supervisor' };
  await initializeLocalAdmin(authPath, superUser);
  const { server, url } = await startPreview(0, { databasePath: ':memory:', authPath });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = async (path, { method = 'GET', session, body } = {}) => {
    const response = await fetch(url + 'api/local/' + path, { method,
      headers: { Origin: new URL(url).origin, ...(session && {Cookie:session}), ...(body && {'Content-Type':'application/json'}) },
      ...(body && {body:JSON.stringify(body)}) });
    return { status: response.status, data: await response.json(), session: response.headers.get('set-cookie')?.split(';',1)[0] };
  };
  const supervisor = await call('auth/login', { method:'POST', body:superUser });
  const adminData = { email:'http-admin@example.test', name:'代录管理员', password:'test-only-http-administrator',role:'admin' };
  const staffData = { email:'http-staff@example.test', name:'业务员工',password:'test-only-http-employee',role:'employee' };
  await call('auth/employees',{method:'POST',session:supervisor.session,body:adminData});
  const staff = (await call('auth/employees',{method:'POST',session:supervisor.session,body:staffData})).data.employee;
  const administrator = await call('auth/login',{method:'POST',body:adminData});
  const employee = await call('auth/login',{method:'POST',body:staffData});
  const command = { version:0, action:'新增独立订单', data:{customers:[{ id:'customer', name:'合成客户', active:true }],tenants:[],orders:[{
    id:'http-order',version:1,product:'GPT',plan:'Plus',businessType:'续费',email:'synthetic@example.test',
    source:'管理员手工',customerId:'customer',start:'2026-11-11T10:00',expiry:'2026-12-11T10:00',
    payment:'银行卡',paidAmount:'20',paidCurrency:'USD',saleAmount:'120',saleCurrency:'CNY',
    paidConfirmed:true,receiptConfirmed:true,costBasis:'standard',
    ownerId:staff.id,owner:'伪造名称',createdById:staff.id,createdBy:staff.name
  }],operating:[],rentBatches:[],logs:[]} };
  assert.equal((await call('commerce',{method:'PUT',session:employee.session,body:command})).status,403);
  const pending = structuredClone(command);
  pending.data.orders[0].saleAmount = '';
  assert.equal((await call('commerce',{method:'PUT',session:administrator.session,body:pending})).status,400);
  assert.equal((await call('commerce',{session:administrator.session})).data.version,0);
  command.data.orders[0].paidConfirmed = false;
  command.data.orders[0].receiptConfirmed = false;
  const saved = await call('commerce',{method:'PUT',session:administrator.session,body:command});
  assert.equal(saved.data.data.orders[0].paidConfirmed, true);
  assert.equal(saved.data.data.orders[0].receiptConfirmed, true);
  assert.equal(saved.status,200);
  assert.equal(saved.data.data.orders[0].ownerId,staff.id);
  assert.equal(saved.data.data.orders[0].owner,staff.name);
  assert.equal(saved.data.data.orders[0].createdById,administrator.data.actor.id);
  assert.equal(saved.data.data.orders[0].createdBy,adminData.name);
  assert.equal(saved.data.data.orders[0].entitlementStatus,'active');
  await call('auth/employees/'+staff.id,{method:'PATCH',session:supervisor.session,body:{active:false,version:staff.version}});
  const next = structuredClone(saved.data);
  next.data.orders.push({...next.data.orders[0],id:'disabled-owner-order'});
  assert.equal((await call('commerce',{method:'PUT',session:administrator.session,body:next})).status,409);
  assert.equal((await call('commerce',{session:administrator.session})).data.version,1);
});
