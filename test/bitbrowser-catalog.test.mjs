import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  BitBrowserCatalogError,
  readBitBrowserCatalog
} from '../modules/recharge/bitbrowser/catalog.mjs';

const token = 'bitbrowser-fixture-key';
const errorCode = (code) => (error) =>
  error instanceof BitBrowserCatalogError && error.code === code && !error.message.includes(token);

async function withLoopbackFixture(handler, check) {
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const { status = 200, headers, payload } = handler(request, body);
      response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      response.end(JSON.stringify(payload ?? {}));
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    return await check(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

test('reads only the three local catalog operations and paginates the original group contract', async () => {
  const requests = [];
  const groups = Array.from({ length: 101 }, (_, index) => ({
    id: `group-${String(index).padStart(3, '0')}`,
    groupName: `分组 ${index}`
  }));
  await withLoopbackFixture(
    (request, body) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers['x-api-key'], token);
      assert.equal(request.headers.cookie, undefined);
      requests.push([request.url, body]);
      switch (request.url) {
        case '/health':
          return { payload: { success: true } };
        case '/group/list':
          return {
            payload: {
              success: true,
              data: { list: groups.slice(body.page * 100, (body.page + 1) * 100) }
            }
          };
        case '/browserTag/list':
          return { payload: { success: true, data: [{ id: 'fixture-tag', tagName: '本机标签' }] } };
        default:
          return { status: 404 };
      }
    },
    async (url) => {
      assert.deepEqual(await readBitBrowserCatalog({ url, token }), {
        groups: groups.map(({ id, groupName }) => ({ id, name: groupName })),
        tags: [{ id: 'fixture-tag', name: '本机标签' }]
      });
      assert.deepEqual(requests, [
        ['/health', {}],
        ['/group/list', { page: 0, pageSize: 100, all: true }],
        ['/group/list', { page: 1, pageSize: 100, all: true }],
        ['/browserTag/list', {}]
      ]);
    }
  );
});

test('rejects nonliteral loopback origins, non-origin paths and malformed keys before networking', async () => {
  for (const url of [
    'http://example.test:54345',
    'http://127.1:54345',
    'http://2130706433:54345',
    'http://127.0.0.1:54345/path',
    'http://localhost:54345/?key=x',
    'http://user@localhost:54345',
    'https://localhost:54345',
    'http://localhost',
    'http://localhost:0',
    'http://localhost:65536'
  ]) {
    await assert.rejects(
      readBitBrowserCatalog({ url, token }),
      errorCode('bitbrowser_direct_protocol')
    );
  }
  await assert.rejects(
    readBitBrowserCatalog({ url: 'http://localhost:54345', token: 'key\r\nbad' }),
    errorCode('bitbrowser_direct_token_invalid')
  );
});

test('refuses redirects and reports fixed errors without disclosing response text', async () => {
  let redirects = 0;
  await withLoopbackFixture(
    (request) => {
      if (request.url === '/redirected') redirects++;
      return { status: 302, headers: { Location: '/redirected' } };
    },
    (url) =>
      assert.rejects(
        readBitBrowserCatalog({ url, token }),
        errorCode('bitbrowser_direct_unreachable')
      )
  );
  assert.equal(redirects, 0);

  await withLoopbackFixture(
    () => ({ payload: { success: false, msg: `请先登录 ${token}` } }),
    (url) =>
      assert.rejects(readBitBrowserCatalog({ url, token }), errorCode('local_api_login_required'))
  );
  await withLoopbackFixture(
    () => ({ status: 403, payload: { success: false, msg: token } }),
    (url) =>
      assert.rejects(
        readBitBrowserCatalog({ url, token }),
        errorCode('bitbrowser_direct_token_invalid')
      )
  );
});
