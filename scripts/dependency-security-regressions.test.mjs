import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const load = createRequire(new URL('../apps/api/package.json', import.meta.url));

function isolatedProbe(source) {
  const result = spawnSync(process.execPath, ['-e', source], {
    cwd: root,
    encoding: 'utf8',
    timeout: 4000
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
}

async function listen(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

// GHSA-27r3-jxmh-p828: isolate the process so a decoder crash fails only this probe.
test('compressed JSON trailing bytes cannot terminate the parser process', () => {
  isolatedProbe(`
    const assert = require('node:assert/strict');
    const http = require('node:http');
    const { gzipSync } = require('node:zlib');
    const parse = require('body-parser').json();
    let client;
    const body = Buffer.concat([
      gzipSync('{"ok":true}'), Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)
    ]);
    const server = http.createServer((req, res) => {
      parse(req, res, (error) => {
        assert.ifError(error);
        res.end(JSON.stringify(req.body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      client = http.request({
        host: '127.0.0.1', port: server.address().port, method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip',
          'content-length': body.length }
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          assert.equal(res.statusCode, 200);
          assert.deepEqual(JSON.parse(body), { ok: true });
          setTimeout(() => server.close(), 200);
        });
      });
      client.on('error', (error) => { throw error; });
      client.setTimeout(2000, () => client.destroy(new Error('parser did not finish')));
      client.end(body);
    });
  `);
});

// GHSA-mrwp-f3q8-3g9p: only local fixture endpoints receive synthetic headers.
test('cross-realm sensitive headers are removed on cross-origin redirects', async (t) => {
  let received;
  const target = await listen(t, (req, res) => {
    received = req.headers;
    res.end('ok');
  });
  const origin = await listen(t, (_req, res) => {
    res.writeHead(302, { location: target });
    res.end();
  });
  await new Promise((resolve, reject) => {
    const request = load('follow-redirects').http.get(
      origin,
      {
        headers: { 'x-fixture-credential': 'fixture-only', 'x-harmless': 'keep' },
        sensitiveHeaders: runInNewContext("['x-fixture-credential']")
      },
      (response) => {
        response.resume();
        response.on('end', resolve);
        response.on('error', reject);
      }
    );
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('redirect did not finish')));
  });
  assert.equal(received['x-fixture-credential'], undefined);
  assert.equal(received['x-harmless'], 'keep');
});

// GHSA-8c8m-p3m8-cjg8: exercise the same real MIME parser used by mailbox reads.
test('nested address comments do not replace the actual mailbox address', async () => {
  const message = await load('mailparser').simpleParser(
    [
      'From: Support (x(y) <other@example.test>) <support@example.test>',
      'To: Buyer <buyer@example.test>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '中文邮件正文'
    ].join('\r\n')
  );
  assert.deepEqual(
    message.from.value.map((entry) => entry.address),
    ['support@example.test']
  );
  assert.equal(message.text.trim(), '中文邮件正文');
});

test('query serialization handles a non-callable own toString in comma arrays', () => {
  const qs = load('qs');
  assert.doesNotThrow(() =>
    qs.stringify({ values: [{ toString: null }] }, { arrayFormat: 'comma' })
  );
  assert.equal(
    qs.stringify({ values: ['one', 'two'] }, { arrayFormat: 'comma' }),
    'values=one%2Ctwo'
  );
});

// GHSA-rxp7-6hxx-x8q5: the child timeout bounds a potential event-loop stall.
test('IPv6 validation rejects a large malformed zone within a bounded process', () => {
  isolatedProbe(`
    const assert = require('node:assert/strict');
    const { Address6 } = require('ip-address');
    assert.equal(Address6.isValid('%'.repeat(256 * 1024) + '\\n'), false);
    assert.equal(Address6.isValid('fe80::1%eth0'), true);
  `);
});
