import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteStorefrontVisitors, websiteStorefrontVisitorsRoute } from '../server/tools/website-storefront-visitors.mjs';

const token = 'a'.repeat(64);
const publicOrigin = 'https://id-admin.example.test';
const clock = () => Date.parse('2026-11-27T16:10:00Z');
const query = { site: 'damatong.net', from: '2026-10-19', to: '2026-10-20' };

async function send(handler, values = query, { method = 'GET', headers = {} } = {}) {
  const req = { method, url: websiteStorefrontVisitorsRoute + '?' + new URLSearchParams(values),
    headers: { host: new URL(publicOrigin).host, ...headers } };
  const result = {};
  await handler(req, {
    writeHead(status, responseHeaders) { result.status = status; result.headers = responseHeaders; },
    end(payload) { result.body = JSON.parse(payload); }
  });
  return result;
}

test('storefront visitors read a fixed authenticated source and preserve UTC counts, unknown days, and range deduplication', async () => {
  let calls = 0;
  const daily = [{ date: query.from, visitors: 2 }, { date: query.to, visitors: 2 }];
  const handler = createWebsiteStorefrontVisitors({ config: { token }, publicOrigin, clock,
    fetchImpl: async (url, request) => {
      calls++;
      assert.equal(url.origin + url.pathname, 'https://console.moyaoai.com/api/storefront/visitors');
      assert.equal(request.method, 'GET');
      assert.equal(request.redirect, 'error');
      assert.equal(request.headers.Authorization, 'Bearer ' + token);
      assert.ok(request.signal instanceof AbortSignal);
      const values = Object.fromEntries(url.searchParams);
      assert.equal(values.from, query.from);
      assert.equal(values.to, query.to);
      const report = { ...values, timeZone: 'UTC', visitors: 3, daily, hasUnidentifiedViews: false };
      if (values.site === 'moyaoai.com') {
        report.visitors = null;
        report.daily = daily.map(row => ({ date: row.date, visitors: null }));
        report.hasUnidentifiedViews = true;
      }
      if (values.site === 'shop.flashcast.com.my') {
        report.visitors = 0;
        report.daily = daily.map(row => ({ date: row.date, visitors: 0 }));
      }
      return Response.json({ ...report, extra: 'internal upstream field',
        daily: report.daily.map(row => ({ ...row, extra: 'internal row field' })) });
    }
  });

  const first = await send(handler);
  assert.equal(first.status, 200);
  assert.equal(first.headers['Cache-Control'], 'private, no-store');
  assert.deepEqual(first.body, { ...query, status: 'ready', timeZone: 'UTC', visitors: 3, daily,
    hasUnidentifiedViews: false });

  const missing = await send(handler, { ...query, site: 'moyaoai.com' });
  assert.deepEqual(missing.body, { site: 'moyaoai.com', from: query.from, to: query.to, status: 'ready',
    timeZone: 'UTC', visitors: null, daily: daily.map(({ date }) => ({ date, visitors: null })), hasUnidentifiedViews: true });

  const zero = await send(handler, { ...query, site: 'shop.flashcast.com.my' });
  assert.equal(zero.status, 200);
  assert.equal(zero.body.visitors, 0);
  assert.equal(calls, 3);
});

test('unconfigured storefront visitors stay distinct from invalid input and only allow same-origin GET', async () => {
  const handler = createWebsiteStorefrontVisitors({ publicOrigin, clock,
    fetchImpl: () => assert.fail('unconfigured traffic must not call upstream') });
  assert.deepEqual((await send(handler)).body, { ...query, status: 'unconfigured' });
  assert.equal((await send(handler, query, { method: 'POST' })).status, 405);
  for (const headers of [{ host: 'elsewhere.example.test' }, { origin: 'https://elsewhere.example.test' },
    { 'sec-fetch-site': 'same-site' }]) {
    assert.equal((await send(handler, query, { headers })).status, 403);
  }
  for (const values of [
    { ...query, site: 'flashcast.com.my' },
    { ...query, site: 'www.damatong.net' },
    { ...query, from: '2026-02-30' },
    { ...query, from: '2026-10-21' },
    { ...query, from: '2026-09-20' },
    { ...query, from: '2026-11-27', to: '2026-11-28' },
    { ...query, extra: 'unexpected' },
    [['site', query.site], ['site', query.site], ['from', query.from]]
  ]) assert.equal((await send(handler, values)).status, 400);
  assert.equal((await send(handler, { ...query, from: '2026-10-01', to: '2026-10-30' })).status, 200);
  assert.equal((await send(handler, { ...query, to: '2026-11-28' })).status, 400);
  for (const config of [{}, { token: token.toUpperCase() }, { token: token + '\n' }, { token, url: publicOrigin }, null])
    assert.throws(() => createWebsiteStorefrontVisitors({ config }), /商城访客统计专用凭据格式无效/);
});

test('period visitors must agree with the bounds of the known daily counts', async () => {
  for (const [visitors, dailyCounts, status] of [
    [3, [2, 2], 200],
    [1, [2, 2], 502],
    [5, [2, 2], 502],
    [null, [null, 2], 502],
    [0, [null, 0], 200],
    [null, [null, 0], 502],
    [0, [null, null], 502],
    [null, [null, null], 200]
  ]) {
    const daily = dailyCounts.map((count, index) => ({ date: [query.from, query.to][index], visitors: count }));
    const handler = createWebsiteStorefrontVisitors({ config: { token }, clock, publicOrigin,
      fetchImpl: () => Response.json({ ...query, timeZone: 'UTC', visitors, daily, hasUnidentifiedViews: false }) });
    assert.equal((await send(handler)).status, status);
  }
});

test('upstream authorization, transport, or inconsistent reports fail without exposing details', async () => {
  const report = { ...query, timeZone: 'UTC', visitors: 1, hasUnidentifiedViews: false,
    daily: [{ date: query.from, visitors: 1 }, { date: query.to, visitors: 1 }] };
  for (const reply of [
    () => { throw new Error(token); },
    () => new Response(token, { status: 403 }),
    () => new Response('a'.repeat(16 * 1024 + 1)),
    () => Response.json({ ...report, site: 'moyaoai.com' }),
    () => Response.json({ ...report, from: '2026-10-18' }),
    () => Response.json({ ...report, timeZone: 'Asia/Kuala_Lumpur' }),
    () => Response.json({ ...report, visitors: -1 }),
    () => Response.json({ ...report, hasUnidentifiedViews: 1 }),
    () => Response.json({ ...report, daily: [...report.daily].reverse() }),
    () => Response.json({ ...report, daily: report.daily.slice(1) }),
    () => Response.json({ ...report, daily: [{ date: query.from }, report.daily[1]] })
  ]) {
    const handler = createWebsiteStorefrontVisitors({ config: { token }, clock, publicOrigin, fetchImpl: reply });
    const failure = await send(handler);
    assert.equal(failure.status, 502);
    assert.deepEqual(failure.body, { error: '暂时无法读取商城访客统计，请稍后重试' });
  }
});
