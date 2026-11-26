import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  appendWebsiteVisit, createWebsiteVisits, parseWebsiteUniqueIpsQuery, reportWebsiteUniqueIps,
  websiteVisitDocument, websiteVisitSignaturePayload
} from '../server/tools/website-visits.mjs';

const now = Date.parse('2026-11-26T01:00:00.000Z');
const store = 'damatong.net';
const token = 'a'.repeat(64);
const event = (occurredAt, host = store, ipToken = token) => ({ eventId: randomUUID(), host, ipToken, occurredAt });

test('storefront IP totals deduplicate across dates and preserve the UTC reporting boundary', () => {
  const before = event('2026-11-25T23:59:59.999Z');
  const after = event('2026-11-26T00:00:00.000Z');
  let rows = appendWebsiteVisit([], before, now);
  rows = appendWebsiteVisit(rows, after, now);
  assert.equal(appendWebsiteVisit(rows, event('2026-11-26T00:00:01.000Z'), now), null);
  const report = (from, to, site = store, items = rows) =>
    reportWebsiteUniqueIps(items, parseWebsiteUniqueIpsQuery({ site, from, to }, now), now);
  assert.equal(report('2026-11-25', '2026-11-26').uniqueIps, 1);
  assert.equal(report('2026-11-26', '2026-11-26').uniqueIps, 1);
  assert.equal(report('2026-11-25', '2026-11-25').uniqueIps, 1);
  assert.equal(report('2026-11-24', '2026-11-24').status, 'not-collected');
  assert.equal(report('2026-11-26', '2026-11-26', 'moyaoai.com', []).uniqueIps, null);
  assert.notEqual(websiteVisitDocument(store), websiteVisitDocument('moyaoai.com'));
  assert.equal(websiteVisitDocument('www.flashcast.com.my'), websiteVisitDocument('flashcast.com.my'));
  assert.throws(() => report('2026-11-26', '2026-11-26', 'other.example'));
  assert.throws(() => report('2026-10-27', '2026-11-26'));
});

test('the existing receiver accepts scoped signed storefront tokens and returns only aggregate counts', async () => {
  const secret = 's'.repeat(32);
  const origin = 'https://id.example';
  const stored = new Map();
  const handler = createWebsiteVisits({ secret, publicOrigin: origin, clock: () => now, store: {
    appendWebsiteVisit(value, time) {
      const site = websiteVisitDocument(value.host);
      const next = appendWebsiteVisit(stored.get(site) || [], value, time);
      if (next) stored.set(site, next);
    },
    searchWebsiteUniqueIps(query, time) {
      return reportWebsiteUniqueIps(stored.get(websiteVisitDocument(query.site)) || [], query, time);
    }
  } });
  const key = createHmac('sha256', secret).update('storefront-website-visits-v1').digest();
  const sign = value => createHmac('sha256', key)
    .update(JSON.stringify([value.eventId, value.host, value.ipToken, value.occurredAt])).digest('hex');
  async function send(operation, value, signature, requestOrigin = origin) {
    const req = Readable.from([Buffer.from(JSON.stringify(value))]);
    req.method = 'POST';
    req.headers = { host: 'id.example', origin: requestOrigin, 'content-type': 'application/json',
      'x-website-visit-signature': signature };
    let status, body;
    await handler(req, { writeHead(code) { status = code; }, end(payload) { body = JSON.parse(payload); } }, operation);
    return { status, body };
  }
  const occurrence = new Date(now).toISOString();
  const renovation = { eventId: randomUUID(), host: 'flashcast.com.my', path: '/zh/gallery',
    ip: '203.0.113.8', occurredAt: occurrence };
  const renovationSignature = signingKey => createHmac('sha256', signingKey)
    .update(websiteVisitSignaturePayload(renovation)).digest('hex');
  assert.equal((await send('ingest', renovation, renovationSignature(key))).status, 401);
  assert.equal((await send('ingest', renovation, renovationSignature(secret))).status, 200);
  const first = event(occurrence);
  assert.equal((await send('ingest', first, '0'.repeat(64))).status, 401);
  assert.equal((await send('ingest', { ...first, host: 'moyaoai.com' }, sign(first))).status, 401);
  assert.equal((await send('ingest', { ...first, ip: '203.0.113.8' }, sign(first))).status, 400);
  assert.equal((await send('ingest', first, sign(first))).status, 200);
  assert.equal((await send('ingest', first, sign(first))).status, 200);
  const other = event(occurrence, 'moyaoai.com');
  assert.equal((await send('ingest', other, sign(other))).status, 200);
  const otherIp = event(occurrence, 'moyaoai.com', 'b'.repeat(64));
  assert.equal((await send('ingest', otherIp, sign(otherIp))).status, 200);
  const query = { site: store, from: '2026-11-26', to: '2026-11-26' };
  assert.deepEqual(await send('unique-ips', query), { status: 200,
    body: { ...query, status: 'ready', uniqueIps: 1 } });
  assert.equal((await send('unique-ips', { ...query, site: 'moyaoai.com' })).body.uniqueIps, 2);
  assert.equal((await send('unique-ips', query, undefined, 'https://other.example')).status, 403);
});
