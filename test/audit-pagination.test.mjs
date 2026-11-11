import assert from 'node:assert/strict';
import test from 'node:test';
import { handleLocalBusiness, pageAuditRows } from '../server/local-business.mjs';

const rows = Array.from({ length: 1000 }, (_, index) => {
  const id = 1002 - index;
  return {
    id, at: '2026-11-05T08:10:00Z',
    domain: id % 10 === 0 ? 'auth' : 'settings',
    action: id % 10 === 0 ? 'auth_login' : 'fee_rules_save',
    summary: id % 10 === 0 ? '员工登录' : '更新本机业务设置',
    actorName: id % 2 === 0 ? '合成管理员' : '其他员工'
  };
});
const page = (query, source = rows) => pageAuditRows(source, new URLSearchParams(query));

test('audit filtering and counts are computed before slicing the same latest 1000 records', () => {
  const first = page('view=login&query=合成管理员&pageSize=20');
  assert.equal(first.total, 100);
  assert.equal(first.snapshot, 1002);
  assert.equal(first.items.length, 20);
  assert.deepEqual(first.items[0], {
    id: '1000', time: '2026-11-05 16:10:00', actor: '合成管理员',
    action: '员工登录', subject: '员工与权限', result: '员工登录'
  });
  const last = page('view=login&query=合成管理员&pageSize=20&page=9999');
  assert.equal(last.page, 5);
  assert.equal(last.items.at(-1).id, '10');
  assert.equal(page('query=保存费用规则').total, 900);
  assert.deepEqual(page('query=没有记录&page=15'), {
    items: [], total: 0, page: 1, pageSize: 10, snapshot: 1002
  });
  assert.throws(() => page('pageSize=1000'), { status: 400 });
  assert.throws(() => page('view=unsupported'), { status: 400 });
  assert.throws(() => page('page=0'), { status: 400 });
  assert.throws(() => page('page=1&page=2'), { status: 400 });
});

test('snapshot excludes fresh rows so page boundaries are stable across writes', () => {
  const first = page('');
  const incoming = { ...rows[0], id: 1003 };
  const newest = [incoming, ...rows.slice(0, -1)];
  const second = page('page=2&snapshot=' + first.snapshot, newest);
  assert.equal(second.total, 999);
  assert.equal(second.items[0].id, '992');
  assert.equal(page('', newest).items[0].id, '1003');
  assert.equal(page('snapshot=1', newest).total, 0);
});

test('audit page route uses the new reader and leaves the legacy array route intact', async () => {
  async function call(url, origin) {
    const result = {};
    await handleLocalBusiness(
      { method: 'GET', headers: { host: 'local.example.test', origin }, url },
      {
        writeHead(status) { result.status = status; },
        end(body) { result.body = JSON.parse(body); }
      },
      url.split('?')[0],
      { audit: () => rows, auditPage: (search) => pageAuditRows(rows, search) },
      { id: 'synthetic-admin', role: 'admin' }
    );
    return result;
  }
  assert.deepEqual((await call('/api/local/audit')).body, rows);
  assert.equal((await call('/api/local/audit/page?view=login&page=2')).body.page, 2);
  assert.equal((await call('/api/local/audit/page?pageSize=1000')).status, 400);
  assert.equal((await call('/api/local/audit/page', 'https://cross-origin.example.test')).status, 403);
});
