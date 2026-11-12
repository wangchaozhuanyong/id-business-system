import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { createWebsiteAnalytics } from '../server/tools/website-analytics.mjs';

const day = '2026-11-12';
const now = Date.parse(day + 'T04:05:06Z');
const config = {
  accountId: 'a'.repeat(32),
  apiToken: 'synthetic-cloudflare-test-token',
  sites: {
    'damatong.net': 'b'.repeat(32),
    'moyaoai.com': 'c'.repeat(32),
    'shop.flashcast.com.my': 'd'.repeat(32)
  }
};
const reportPath = '/api/local/tools/website-analytics';

async function request(handler, params, headers = {}) {
  let status, body;
  await handler({ method: 'GET', url: reportPath + '?' + new URLSearchParams(params), headers }, {
    writeHead(code) { status = code; },
    end(content) { body = JSON.parse(content); }
  });
  return { status, body };
}

function rumReport(count, visits) {
  return {
    errors: null,
    data: { viewer: { accounts: [{
      total: [{ count, sum: { visits } }],
      daily: [{ dimensions: { date: day }, count, sum: { visits } }]
    }] } }
  };
}

test('the explicit renovation site keeps the period visitor total and the source timezone', async () => {
  const origin = 'https://business.example.test';
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const metadata = { timeZone: 'Asia/Kuala_Lumpur' };
  const metricHeaders = ['screenPageViews', 'totalUsers', 'sessions'].map(name => ({ name }));
  const row = (values, date) => ({
    metricValues: values.map(value => ({ value: String(value) })),
    ...(date && { dimensionValues: [{ value: date }] })
  });
  let reads = 0;
  const handler = createWebsiteAnalytics({
    publicOrigin: origin,
    config: {
      propertyId: '100', streamId: '200', hosts: ['flashcast.com.my', 'www.flashcast.com.my'],
      serviceAccount: {
        type: 'service_account', client_email: 'fixture@example.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' })
      }
    },
    clock: () => Date.parse('2026-11-12T17:00:00Z'),
    fetchImpl: async (url, options) => {
      if (url === 'https://oauth2.googleapis.com/token')
        return Response.json({ access_token: 'fixture-read-token', expires_in: 3600 });
      reads++;
      const requests = JSON.parse(options.body).requests;
      assert.deepEqual(requests.map(request => request.dateRanges), Array(2).fill([{ startDate: '6daysAgo', endDate: 'today' }]));
      return Response.json({ reports: [
        { metadata, metricHeaders, rowCount: 1, rows: [row([12, 4, 8])] },
        { metadata, metricHeaders, dimensionHeaders: [{ name: 'date' }], rowCount: 2,
          rows: [row([6, 3, 4], '20261112'), row([6, 3, 4], '20261113')] }
      ] });
    }
  });
  const params = { site: 'flashcast.com.my', days: 7 };
  assert.equal((await request(handler, params, { origin: 'https://other.example.test' })).status, 403);
  const { status, body } = await request(handler, params, { origin, 'sec-fetch-site': 'same-origin' });
  assert.equal(status, 200);
  assert.equal(body.provider, 'ga4');
  assert.equal(body.timeZone, 'Asia/Kuala_Lumpur');
  assert.deepEqual(body.summary, { pageViews: 12, visitors: 4, sessions: 8 });
  assert.equal(body.daily[0].date, '2026-11-07');
  assert.equal(body.daily.at(-1).date, '2026-11-13');
  assert.equal(reads, 1);
});

test('Cloudflare reports isolate site tags, exact hosts and periods, and share in-flight reads for the same selection', async () => {
  const hosts = Object.keys(config.sites);
  const calls = [];
  let time = now;
  const handler = createWebsiteAnalytics({
    cloudflareConfig: config,
    clock: () => time,
    fetchImpl: async (target, options) => {
      assert.equal(target, 'https://api.cloudflare.com/client/v4/graphql');
      assert.equal(options.headers.Authorization, 'Bearer ' + config.apiToken);
      const { query, variables } = JSON.parse(options.body);
      assert.match(query, /rumPageloadEventsAdaptiveGroups/);
      assert.match(query, /dimensions \{ date \}/);
      assert.equal(variables.accountTag, config.accountId);
      const [range, bot, hostFilter, tagFilter] = variables.filter.AND;
      const { requestHost } = hostFilter;
      assert.deepEqual(bot, { bot: 0 });
      assert.deepEqual(tagFilter, { siteTag_in: [config.sites[requestHost]] });
      calls.push({ host: requestHost, range });
      return Response.json(rumReport(hosts.indexOf(requestHost) + 10, 6));
    }
  });
  const all = hosts.map(site => request(handler, { days: 7, site }));
  const [a, b, c, duplicate, month] = await Promise.all([
    ...all,
    request(handler, { days: 7, site: hosts[0] }),
    request(handler, { days: 30, site: hosts[0] })
  ]);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(({ range }) => range.datetime_geq), [
    '2026-11-06T00:00:00Z', '2026-11-06T00:00:00Z', '2026-11-06T00:00:00Z', '2026-10-14T00:00:00Z'
  ]);
  assert(calls.every(({ range }) => range.datetime_leq === day + 'T04:05:06Z'));
  [a, b, c].forEach(({ status, body }, index) => {
    assert.equal(status, 200);
    assert.equal(body.site, hosts[index]);
    assert.equal(body.provider, 'cloudflare');
    assert.equal(body.timeZone, 'UTC');
    assert.deepEqual(body.summary, { pageViews: 10 + index, visits: 6 });
    assert.deepEqual(body.daily[0], { date: '2026-11-06', metrics: null });
    assert.deepEqual(body.daily.at(-1), { date: day, metrics: body.summary });
    const link = new URL(body.reportUrl);
    assert.equal(link.hostname, 'dash.cloudflare.com');
    assert.equal(link.searchParams.get('host'), hosts[index]);
    assert.equal(link.searchParams.get('siteTag~in'), config.sites[hosts[index]]);
    assert(!JSON.stringify(body).includes(config.apiToken));
  });
  assert.deepEqual(duplicate, a);
  assert.equal(month.body.daily.length, 30);
  assert.deepEqual(await request(handler, { days: 7, site: hosts[0] }), a);
  assert.equal(calls.length, 4);
  time += 60_001;
  assert.equal((await request(handler, { days: 7, site: hosts[0] })).status, 200);
  assert.equal(calls.length, 5);
});

test('an unconfigured site is distinct from an invalid site, period or request origin', async () => {
  const handler = createWebsiteAnalytics({ fetchImpl: () => assert.fail('Unexpected upstream request') });
  assert.equal((await request(handler, { days: 7 })).status, 503, 'preserve the original route contract');
  assert.deepEqual(await request(handler, { days: 7, site: 'moyaoai.com' }), {
    status: 200,
    body: { status: 'unconfigured', site: 'moyaoai.com', provider: 'cloudflare', days: 7, summary: null, daily: [] }
  });
  assert.equal((await request(handler, { days: 7, site: 'console.moyaoai.com' })).status, 400);
  assert.equal((await request(handler, { days: 7, site: '__proto__' })).status, 400);
  assert.equal((await request(handler, { days: 90, site: 'damatong.net' })).status, 400);
  assert.equal((await request(handler, { days: 7 }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.throws(() => createWebsiteAnalytics({ cloudflareConfig: {
    ...config, sites: { 'unknown.example.test': 'e'.repeat(32) }
  } }), /域名或 Cloudflare 站点标识无效/);
});

test('Cloudflare errors and incomplete responses stay distinct from empty reports and returned zeros', async () => {
  const empty = { errors: null, data: { viewer: { accounts: [{ total: [], daily: [] }] } } };
  const partial = rumReport(30, 9);
  partial.data.viewer.accounts[0].daily = [];
  const duplicate = rumReport(30, 9);
  duplicate.data.viewer.accounts[0].daily.push(duplicate.data.viewer.accounts[0].daily[0]);
  const responses = [
    { errors: [{ message: 'synthetic upstream details' }], data: null },
    partial, duplicate, empty, rumReport(0, 0)
  ];
  const handler = createWebsiteAnalytics({
    cloudflareConfig: config,
    clock: () => now,
    fetchImpl: async () => Response.json(responses.shift())
  });
  const params = { days: 7, site: 'damatong.net' };
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await request(handler, params);
    assert.equal(result.status, 502);
    assert.doesNotMatch(JSON.stringify(result.body), /synthetic/);
  }
  const noData = await request(handler, params);
  assert.equal(noData.body.status, 'empty');
  assert.equal(noData.body.summary, null);
  assert(noData.body.daily.every(row => row.metrics === null));
  const zero = await request(handler, { ...params, days: 30 });
  assert.equal(zero.body.status, 'ready');
  assert.deepEqual(zero.body.summary, { pageViews: 0, visits: 0 });
});
