import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { handleLocalBusiness } from '../server/local-business.mjs';
import { changeAccountLifecycle, accountLifecycleSummaries } from '../server/account-lifecycle.mjs';
import { lifecycleFixture } from './helpers/account-lifecycle-fixture.mjs';

test('专用回库接口通过现有路由返回资料、保留校验错误且阻止跨站请求，无数据库或网站服务', async () => {
  for (const [role, overrides, origin, status] of [
    ['admin', {}, 'http://fixture.test', 200],
    ['admin', { controlled: false }, 'http://fixture.test', 400],
    ['employee', {}, 'http://fixture.test', 403],
    ['admin', {}, 'https://other.test', 403]
  ]) {
    const f = lifecycleFixture();
    const request = Readable.from([Buffer.from(JSON.stringify({ version: 1, commerceVersion: 1,
      data: { assetId: 'account-a', action: 'release', assetVersion: 1, commandId: 'route-test',
        reason: '客户停止使用', controlled: true, accessReviewed: true, tasksReviewed: true, ...overrides } }))]);
    request.method = 'PUT';
    request.headers = { host: 'fixture.test', origin, 'content-type': 'application/json' };
    const response = { destroyed: false, setHeader() {}, writeHead(value) { this.status = value; }, end(value) { this.body = JSON.parse(value); } };
    const actor = { id: 'qa', name: '隔离管理员', role };
    const store = { saveAccountLifecycle(body, owner) {
      changeAccountLifecycle(f.inventory, f.commerce, body.data, owner, new Date('2026-11-07T08:00:00Z'));
      return { version: 2, commerceVersion: 1, data: f.inventory, accountSummaries: accountLifecycleSummaries(f.inventory, f.commerce) };
    } };
    await handleLocalBusiness(request, response, '/api/local/inventory/account-lifecycle', store, actor);
    assert.equal(response.status, status);
    if (status === 200) assert.equal(response.body.accountSummaries[0].disposition, 'recovered');
    else assert.equal(typeof response.body.error, 'string');
  }
});
