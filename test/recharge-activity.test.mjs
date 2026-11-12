import assert from 'node:assert/strict';
import test from 'node:test';
import { createRechargeActivity, rechargeActivityDomain, rechargeActivityRoute } from '../server/recharge-activity.mjs';

const start = Date.parse('2026-11-12T05:00:00Z');
const origin = 'https://operations.example.test';
const actor = (id, role = 'employee') => ({ id, role, active: true });
const admin = actor('admin', 'admin');
const superAdmin = actor('super', 'super');
const ana = actor('staff-a');
const ben = actor('staff-b');
const alphaCode = 'KC-ABCDEFGHJKLMNPQ';
const betaCode = 'KC-RSTUVWXYZ234567';
const otherCode = 'KC-BCDEFGHJKLMNPQR';
const job = (createdAt, suffix) => createdAt + '-' + suffix.padStart(12, '0');
const issue = (employee, code, plan, batchNo) => ({
  id: 'issue-' + employee.id, applicantId: employee.id, applicantName: '员工 ' + employee.id,
  status: 'issued', plan, batchNo, issuedAt: new Date(start - 60_000).toISOString(), codes: [code]
});
const native = (job_key, cdk_code, extra = {}) => ({
  job_key, cdk_code, status: 'running', progress: 3, has_session: true, token_preview: 'customer@example.test', ...extra
});

function harness() {
  let now = start, unavailable = false;
  const docs = new Map([['recharge-codes', { version: 1, data: {
    requests: [issue(ana, alphaCode, 'pro200', 'PC-001'), issue(ben, betaCode, 'plus', 'PC-002')]
  } }]]);
  const nativeRows = [], logSteps = new Map(), calls = [];
  const store = {
    featureDocument: name => structuredClone(docs.get(name) || { version: 0, data: null }),
    saveFeatureDocument(name, version, data) {
      assert.equal(name, rechargeActivityDomain);
      assert.equal(version, this.featureDocument(name).version);
      const next = { version: version + 1, data: structuredClone(data) };
      docs.set(name, next);
      return structuredClone(next);
    },
    notifyChanges() {}
  };
  const client = {
    async listCodes() {
      return [
        { code: alphaCode, type: '自助', plan_type: 'pro_20x' },
        { code: betaCode, type: '自助', plan_type: 'plus' },
        { code: otherCode, type: '自助', plan_type: 'pro500' }
      ];
    },
    async get(path) {
      calls.push(path);
      if (unavailable) throw new Error('fixture unavailable');
      const url = new URL(path, origin);
      if (url.pathname === '/api/admin/sessions') {
        const search = url.searchParams.get('search');
        const offset = Number(url.searchParams.get('offset'));
        const matches = search ? nativeRows.filter(row => row.job_key.includes(search)) : nativeRows;
        return { items: matches.slice(offset, offset + Number(url.searchParams.get('limit'))), total: matches.length };
      }
      const id = url.pathname.split('/').at(-1);
      const row = nativeRows.find(row => row.job_key === id);
      return { success: true, task: { jobKey: id, cdk: row?.cdk_code, status: row?.status },
        runtimeEntries: logSteps.get(id) || [] };
    }
  };
  const make = (extra = {}) => createRechargeActivity({ store, client, publicOrigin: origin, clock: () => now, ...extra });
  return { nativeRows, logSteps, docs, calls, make, tick: (ms = 5000) => (now += ms), offline: value => { unavailable = value; } };
}

async function request(service, actor, path = rechargeActivityRoute, method = 'GET', requestOrigin = origin) {
  const result = {};
  await service.handle({ method, url: path, headers: { host: new URL(origin).host, origin: requestOrigin } }, {
    writeHead(status, headers) { Object.assign(result, { status, headers }); },
    end(payload) { result.body = JSON.parse(payload); }
  }, actor);
  return result;
}

test('a confirmed worker step routes one masked notice to the issued employee and every administrator', async () => {
  const h = harness(), service = h.make();
  await service.collect();
  const versions = [ana, ben, admin].map(person => service.version(person));
  const started = h.tick(), task = native(job(started - 1000, 'a1'), alphaCode);
  h.nativeRows.push(task, native(job(started - 2000, 'old'), '[checkout-debug]', { progress: 50 }));
  h.logSteps.set(task.job_key, [{ jobKey: task.job_key, ts: started - 500, source: 'task', text: '尝试 1 启动自动化 proxy=yes' }]);
  await service.collect();
  assert.equal((await request(service, admin)).body.items.length, 0, '登记及准备浏览器时没有弹开始');
  assert.deepEqual([ana, ben, admin].map(person => service.version(person)), versions);

  h.logSteps.get(task.job_key).push({ jobKey: task.job_key, ts: started - 100, source: 'spawn/a1/stdout',
    text: '正在检查代理连通性...' });
  h.tick();
  await service.collect();
  const first = (await request(service, ana)).body;
  assert.equal(first.unread, 1);
  assert.equal(first.items[0].status, 'running');
  assert.equal(first.items[0].plan, 'Pro 200');
  assert.equal(first.items[0].email, 'cu•••@example.test');
  assert.equal(first.items[0].codeTail, alphaCode.slice(-4));
  assert.deepEqual(first.items[0].owner, { name: '员工 staff-a' });
  assert.notEqual(service.version(ana), versions[0]);
  assert.equal(service.version(ben), versions[1], '他人的动态不改变员工的事件版本');
  assert.equal((await request(service, ben)).body.items.length, 0);
  assert.equal((await request(service, admin)).body.items[0].id, first.items[0].id);
  assert.equal((await request(service, superAdmin)).body.items[0].id, first.items[0].id);
  const { id } = first.items[0], path = rechargeActivityRoute + '/' + id;
  assert.equal((await request(service, null)).status, 401);
  assert.equal((await request(service, ben, path)).status, 404);
  assert.equal((await request(service, ben, path + '/read?event=1', 'POST')).status, 404);
  assert.equal((await request(service, ana, path + '/read?event=1', 'POST', 'https://other.example.test')).status, 403);

  const employeeDetail = await request(service, ana, path);
  assert.equal(employeeDetail.body.fullCode, alphaCode);
  assert.equal(employeeDetail.body.fullEmail, undefined);
  assert.equal(employeeDetail.body.batchNo, 'PC-001');
  assert.deepEqual(employeeDetail.body.events, [{ status: 'running', at: started - 100 }]);
  const managerDetail = await request(service, admin, path);
  assert.equal(managerDetail.body.fullEmail, 'customer@example.test');
  assert.equal(managerDetail.body.fullCode, alphaCode);
  assert.match(managerDetail.headers['Cache-Control'], /no-store/);
  for (const value of [first, employeeDetail.body, managerDetail.body, h.docs.get(rechargeActivityDomain)]) {
    assert.equal(JSON.stringify(value).includes(task.job_key), false, '查询原任务的完整凭据只留在原系统');
  }
  assert.equal(JSON.stringify(h.docs.get(rechargeActivityDomain)).includes(alphaCode), false);
  assert.equal(JSON.stringify(h.docs.get(rechargeActivityDomain)).includes('customer@example.test'), false);

  await request(service, ana, path + '/read?event=1', 'POST');
  assert.equal((await request(service, ana)).body.unread, 0);
  assert.equal((await request(service, admin)).body.unread, 1);
  await service.collect();
  assert.equal((await request(service, ana)).body.items[0].event, 1, '重复采集不产生新动态');

  task.status = 'failed';
  task.message = '付款结果待核实，已转人工确认，请勿重复充值，请联系客服处理。';
  h.tick();
  await service.collect();
  assert.equal((await request(service, ana, path + '/read?event=1', 'POST')).status, 409);
  const updated = (await request(service, ana)).body;
  assert.equal(updated.unread, 1);
  assert.deepEqual(updated.items.map(row => [row.id, row.status, row.event]), [[id, 'review', 2]]);

  const restarted = h.make();
  h.offline(true);
  await restarted.collect();
  const offline = (await request(restarted, ana)).body;
  assert.equal(offline.coverage, 'unavailable');
  assert.equal(offline.unread, 1);
  assert.equal(offline.items[0].status, 'review');
});

test('unknown ownership stays administrator-only, and opening success is separate from the order receipt', async () => {
  const h = harness(), service = h.make();
  await service.collect();
  const at = h.tick(), unowned = native(job(at - 1000, 'u1'), otherCode, {
    progress: 10, token_preview: 'invalid-token-preview...'
  });
  const ownerTask = native(job(at - 1500, 'b1'), betaCode.toLowerCase(), { status: 'success', progress: 100 });
  const prior = native(job(start - 10_000, 'history'), alphaCode, { status: 'success', progress: 100 });
  h.nativeRows.push(unowned, ownerTask, prior);
  await service.collect();
  const all = (await request(service, admin)).body.items;
  assert.equal(all.length, 2);
  assert.deepEqual([all[0].owner, all[0].plan, all[0].email], [null, 'Pro 500', '']);
  assert.equal((await request(service, ana)).body.items.length, 0);
  const [own] = (await request(service, ben)).body.items;
  assert.equal(own.status, 'success');
  const path = rechargeActivityRoute + '/' + own.id;
  assert.equal((await request(service, ben, path)).body.fullCode, betaCode, '沿用原领取记录的码值');
  assert.equal((await request(service, ben, path)).body.orderSynced, false);
  h.docs.set('order-sync', { version: 1, data: { rows: [{ jobKey: ownerTask.job_key, orderNo: 'fixture-order' }] } });
  assert.equal((await request(service, ben, path)).body.orderSynced, true);
  assert.equal((await request(service, ben, rechargeActivityRoute + '/' + all[0].id)).status, 404);

  const revoked = h.make({ getActor: () => actor(admin.id, 'employee') });
  assert.equal((await request(revoked, admin, path)).status, 403, '返回完整字段前复查实时角色');
});

test('a task that leaves the recent batch is reconciled by its saved reference without publishing old tasks', async () => {
  const h = harness(), service = h.make();
  await service.collect();
  const at = h.tick(), task = native(job(at - 1000, 'running'), alphaCode, { progress: 8 });
  h.nativeRows.push(task);
  await service.collect();
  const [first] = (await request(service, ana)).body.items;
  assert.equal(first.status, 'running');

  const later = h.tick(3 * 60_000);
  const filler = Array.from({ length: 100 }, (_, i) => native(job(later - i * 25, 'f' + i), '[checkout-debug]'));
  h.nativeRows.unshift(...filler);
  task.status = 'success';
  task.progress = 100;
  // The process restarts with the task reference, without the raw upstream identifier.
  const restarted = h.make();
  await restarted.collect();
  let row = (await request(restarted, ana)).body.items[0];
  assert.deepEqual([row.id, row.status, row.event], [first.id, 'success', 2]);
  assert(h.calls.includes('/api/admin/sessions?limit=100&offset=100'));

  const next = native(job(later + 1000, 'stillrun'), alphaCode, { progress: 8 });
  h.nativeRows.unshift(next);
  h.tick();
  await restarted.collect();
  row = (await request(restarted, ana)).body.items[0];
  assert.equal(row.status, 'running');
  h.tick(3 * 60_000);
  await restarted.collect();
  const end = h.tick(10_000);
  h.nativeRows.unshift(...Array.from({ length: 100 }, (_, i) => native(job(end - i * 1000, 'n' + i), '[checkout-debug]')));
  next.status = 'failed';
  next.message = '该账号无激活权限';
  await restarted.collect();
  const finished = (await request(restarted, ana)).body.items.find(item => item.id === row.id);
  assert.equal(finished.status, 'failed');
  assert(h.calls.includes('/api/admin/sessions?limit=10&offset=0&search=' + row.jobTail));
});
