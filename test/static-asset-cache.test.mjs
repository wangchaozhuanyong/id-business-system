import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { startPreview } from '../server/preview.mjs';

function get(url, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const pending = request(new URL(path, url), { headers, method }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
      response.on('error', reject);
    });
    pending.on('error', reject);
    pending.end();
  });
}

test('public CSS is compressed once and revalidated by content without caching HTML or errors', async (t) => {
  const { server, url } = await startPreview(0);
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const asset = '/prototype.css';
  const plain = await get(url, asset, { 'Accept-Encoding': 'gzip;q=0, *;q=1' });
  assert.equal(plain.status, 200);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.headers['cache-control'], 'public, no-cache');
  const digest = createHash('sha256').update(plain.body).digest('hex');
  assert.equal(plain.headers.etag, 'W/"' + digest + '"');

  const compressed = await get(url, asset, { 'Accept-Encoding': 'gzip' });
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.equal(compressed.headers.vary, 'Accept-Encoding');
  assert.deepEqual(gunzipSync(compressed.body), plain.body);
  assert.ok(compressed.body.length < plain.body.length);

  const head = await get(url, asset, { 'Accept-Encoding': 'gzip' }, 'HEAD');
  assert.equal(head.headers['content-length'], String(compressed.body.length));
  assert.equal(head.body.length, 0);
  const cached = await get(url, asset, {
    'Accept-Encoding': 'gzip', 'If-None-Match': plain.headers.etag.slice(2)
  });
  assert.equal(cached.status, 304);
  assert.equal(cached.headers.etag, plain.headers.etag);
  assert.equal(cached.headers.vary, 'Accept-Encoding');
  assert.equal(cached.body.length, 0);
  const old = await get(url, asset, { 'If-None-Match': 'W/"old-version"' });
  assert.equal(old.status, 200);
  assert.deepEqual(old.body, plain.body);

  const page = await get(url, '/');
  const scripts = [...page.body.toString().matchAll(/<script\b[^>]*\bsrc="([^\"]+)"/g)].map(match => match[1]);
  assert(scripts.some(path => path.includes('search-input.js')), 'shared search must be loaded by the real page');
  for (const path of scripts) {
    const response = await get(url, path);
    assert.equal(response.status, 200, path + ': page scripts must be registered by the HTTP server');
    assert.match(response.headers['content-type'], /javascript/, path);
  }

  for (const path of ['/', '/mailbox-query', '/api/nonexistent', '/missing.css']) {
    const response = await get(url, path, { 'Accept-Encoding': 'gzip', 'If-None-Match': '*' });
    assert.notEqual(response.status, 304);
    assert.match(response.headers['cache-control'], /\bno-store\b/);
    assert.equal(response.headers.etag, undefined);
    assert.equal(response.headers['content-encoding'], undefined);
  }
  t.diagnostic('prototype.css transferred bytes: ' + plain.body.length + ' → ' + compressed.body.length);
});
