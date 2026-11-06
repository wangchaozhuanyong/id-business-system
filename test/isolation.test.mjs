import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { startPreview } from '../server/preview.mjs';
import { parseInventoryCsv } from '../modules/inventory/inventory-csv.ts';
import { inventorySelectedItems } from '../modules/inventory/inventory-selection.ts';

test('independent server exposes only design assets and rejects old routes and host overrides', async (t) => {
  const { server, url } = await startPreview(0);
  t.after(() => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));
  assert.equal(server.address().address, '127.0.0.1');
  const home = await fetch(url);
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('x-id-workspace'), 'independent-redesign-20261105');
  assert.match(await home.text(), /connect-src 'self'; frame-src 'self'/);
  const css = await fetch(new URL('/prototype.css', url), { method: 'HEAD' });
  assert.equal(css.status, 200);
  assert.equal(await css.text(), '');
  const blocked = [
    '/login',
    '/v2/workbench/order-entry',
    '/api/health',
    '/.env',
    '/package.json',
    '/SOURCE-SNAPSHOT.json',
    '/modules/inventory/inventory-csv.ts',
    '/handoff/apps/admin'
  ];
  for (const path of blocked) {
    assert.equal((await fetch(new URL(path, url), { redirect: 'manual' })).status, 404, path);
  }
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = request(url, { headers: { Host: 'example.test' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.once('error', reject);
    req.end();
  });
  assert.equal(hostStatus, 403);
});

test('ported inventory validates duplicate records and preserves Beijing registration time', () => {
  const source = {
    id: 'source-1',
    scope: 'google_mailbox',
    kind: 'source',
    name: '自己注册',
    active: true
  };
  const result = parseInventoryCsv(
    '谷歌邮箱,邮箱密码,来源渠道,未绑定确认,注册时间\n' +
      'MAIL@example.test,fixture,自己注册,是,2026-11-05 08:15\n' +
      'mail@example.test,fixture,自己注册,是,2026-11-05 08:15',
    [source],
    { countryOptionId: '', sourceOptionId: '', phoneUnboundConfirmed: false }
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].input.registeredAt, '2026-11-05T00:15:00.000Z');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /重复邮箱/);
});

test('ported inventory returns only the selected and still eligible rows', () => {
  const rows = new Map(
    Array.from({ length: 10 }, (_, i) => {
      const id = 'row-' + i;
      return [
        id,
        {
          id,
          version: 1,
          state: 'pending',
          mailbox: {
            health: 'normal',
            stock: { state: 'extracted', currentExtractionItemId: id }
          }
        }
      ];
    })
  );
  const selected = { 'row-0': 1, 'row-2': 1, 'row-3': 1, 'row-6': 1 };
  assert.deepEqual(inventorySelectedItems(selected, [...rows.values()]), {
    requests: Object.keys(selected).map((id) => ({ id, expectedVersion: 1 })),
    blocked: 0
  });
  rows.get('row-3').version++;
  const stale = inventorySelectedItems(selected, [...rows.values()]);
  assert.equal(stale.blocked, 1);
  assert.ok(!stale.requests.some(({ id }) => id === 'row-3'));
});
