import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { diagnoseMailbox } from './mailbox-diagnostic.mjs';

const env = {
  VENDURE_MAILBOX_ADMIN_API_URL: 'https://fixture.invalid/admin-api?vendure-token=fixture-channel',
  VENDURE_MAILBOX_API_KEY: 'fixture-secret-key'
};
const roots = ['icloudPrimaryAccounts', 'icloudVirtualEmails'];
const ownerMessage = '共享平台资源仅允许超级管理员在平台管理中心管理';

function response(payload, options) {
  return new Response(JSON.stringify(payload), options);
}

async function run(fetchImpl, config = env) {
  return diagnoseMailbox({ env: config, fetchImpl });
}

test('only two fixed id queries use the actual dedicated header and preserve query in memory', async () => {
  const calls = [];
  const result = await run(async (url, options) => {
    calls.push({ url, options });
    const root = roots[calls.length - 1];
    return response({
      data: { [root]: [{ id: 'fixture-private-id', email: 'private@fixture.invalid' }] }
    });
  });
  assert.equal(calls.length, 2);
  for (const [index, { url, options }] of calls.entries()) {
    assert.equal(url.toString(), env.VENDURE_MAILBOX_ADMIN_API_URL);
    assert.equal(options.headers['vendure-api-key'], 'fixture-secret-key');
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), {
      query: `query { ${roots[index]} { id } }`,
      variables: {}
    });
  }
  assert.deepEqual(result.primaryAccounts, {
    category: 'SUCCESS',
    status: 200,
    count: 1,
    code: 'OK',
    path: ['icloudPrimaryAccounts']
  });
  assert.equal(result.virtualEmails.count, 1);
  assert.equal(result.queryChannelPresent, true);
  assert.doesNotMatch(
    JSON.stringify(result),
    /fixture-secret|fixture-channel|private@|fixture-private-id|https:/
  );
});

test('channel detection uses exact vendure-token, and never exposes any query value', async () => {
  for (const [query, expected] of [
    ['?token=fixture', false],
    ['?vendure-token=', true],
    ['', false]
  ]) {
    const result = await run(
      async () => response({ data: { icloudPrimaryAccounts: [], icloudVirtualEmails: [] } }),
      {
        ...env,
        VENDURE_MAILBOX_ADMIN_API_URL: `https://fixture.invalid/admin-api${query}`
      }
    );
    assert.equal(result.queryChannelPresent, expected);
  }
});

test('invalid, unsafe, wrong path and embedded credentials stop before any request', async () => {
  const cases = [
    [{}, 'INVALID_CONFIGURATION'],
    [{ ...env, VENDURE_MAILBOX_API_KEY: '' }, 'INVALID_CONFIGURATION'],
    [{ ...env, VENDURE_MAILBOX_ADMIN_API_URL: 'invalid-fixture-secret' }, 'INVALID_CONFIGURATION'],
    [
      { ...env, VENDURE_MAILBOX_ADMIN_API_URL: 'http://fixture.invalid/admin-api' },
      'HTTPS_REQUIRED'
    ],
    [
      { ...env, VENDURE_MAILBOX_ADMIN_API_URL: 'https://fixture.invalid/shop-api' },
      'ADMIN_PATH_REQUIRED'
    ],
    [
      {
        ...env,
        VENDURE_MAILBOX_ADMIN_API_URL: 'https://secret-user:secret-pass@fixture.invalid/admin-api'
      },
      'URL_CREDENTIALS_REJECTED'
    ]
  ];
  for (const [config, code] of cases) {
    const result = await run(() => assert.fail('request must not run'), config);
    assert.equal(result.primaryAccounts.code, code);
    assert.equal(result.virtualEmails.code, code);
    assert.doesNotMatch(JSON.stringify(result), /secret-|fixture.invalid/);
    if (code === 'HTTPS_REQUIRED') {
      assert.equal(result.configured, true);
      assert.equal(result.https, false);
    }
  }
});

test('owner refusal requires exact message, USER_INPUT_ERROR and exact operation root path', async () => {
  let calls = 0;
  const result = await run(async () =>
    response({
      errors: [
        {
          message: ownerMessage,
          extensions: { code: 'USER_INPUT_ERROR' },
          path: [roots[calls++]]
        }
      ]
    })
  );
  assert.equal(result.primaryAccounts.code, 'PLATFORM_OWNER_REQUIRED');
  assert.equal(result.virtualEmails.code, 'PLATFORM_OWNER_REQUIRED');
  assert.doesNotMatch(JSON.stringify(result), /共享平台/);
  for (const overrides of [
    { message: ownerMessage + ' ' },
    { extensions: { code: 'INTERNAL_SERVER_ERROR' } },
    { path: ['otherPrivateRoot'] },
    { path: ['icloudPrimaryAccounts', 'secret-child'] },
    { path: undefined }
  ]) {
    const result = await run(async () =>
      response({
        errors: [
          {
            message: ownerMessage,
            extensions: { code: 'USER_INPUT_ERROR' },
            path: ['icloudPrimaryAccounts'],
            ...overrides
          }
        ]
      })
    );
    assert.notEqual(result.primaryAccounts.code, 'PLATFORM_OWNER_REQUIRED');
    assert.doesNotMatch(JSON.stringify(result), /otherPrivateRoot|secret-child|共享平台/);
  }
});

test('GraphQL codes and paths are whitelisted and errors take precedence over partial data', async () => {
  const cases = [
    ['FORBIDDEN', 'AUTHORIZATION'],
    ['UNAUTHENTICATED', 'AUTHORIZATION'],
    ['GRAPHQL_VALIDATION_FAILED', 'GRAPHQL'],
    ['INTERNAL_SERVER_ERROR', 'GRAPHQL'],
    ['USER_INPUT_ERROR', 'GRAPHQL'],
    ['secret-code', 'GRAPHQL']
  ];
  for (const [code, category] of cases) {
    const result = await run(async () =>
      response({
        data: { icloudPrimaryAccounts: [{ id: 'private-id' }] },
        errors: [
          {
            message: 'private-raw-message',
            extensions: { code },
            path: ['icloudPrimaryAccounts', 'private-child']
          }
        ]
      })
    );
    assert.equal(result.primaryAccounts.category, category);
    assert.equal(result.primaryAccounts.count, null);
    assert.equal(result.primaryAccounts.code, code === 'secret-code' ? 'GRAPHQL_ERROR' : code);
    assert.deepEqual(result.primaryAccounts.path, ['icloudPrimaryAccounts']);
    assert.deepEqual(result.virtualEmails.path, []);
    assert.doesNotMatch(JSON.stringify(result), /secret-code|private-/);
  }
});

test('HTTP auth, non JSON upstream, GraphQL HTTP 400 and redirects have safe distinctions', async () => {
  for (const [status, code, category] of [
    [401, 'HTTP_AUTHORIZATION', 'AUTHORIZATION'],
    [403, 'HTTP_AUTHORIZATION', 'AUTHORIZATION'],
    [502, 'HTTP_ERROR', 'HTTP'],
    [302, 'REDIRECT_BLOCKED', 'HTTP']
  ]) {
    const result = await run(async () => new Response('private response html', { status }));
    assert.equal(result.primaryAccounts.code, code);
    assert.equal(result.primaryAccounts.category, category);
    assert.equal(result.primaryAccounts.status, status);
    assert.doesNotMatch(JSON.stringify(result), /private/);
  }
  const result = await run(async () =>
    response({ errors: [{ extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] }, { status: 400 })
  );
  assert.equal(result.primaryAccounts.code, 'GRAPHQL_VALIDATION_FAILED');
  assert.equal(result.primaryAccounts.status, 400);
});

test('invalid JSON, invalid envelope and absent id fields never become success', async () => {
  for (const payload of [
    'html',
    null,
    { data: { icloudPrimaryAccounts: [] }, errors: 'private-malformed-errors' },
    { data: null },
    { data: { icloudPrimaryAccounts: {} } },
    { data: { icloudPrimaryAccounts: [{ email: 'secret-email' }] } }
  ]) {
    const result = await run(async () =>
      payload === 'html' ? new Response('private-html') : response(payload)
    );
    assert.notEqual(result.primaryAccounts.category, 'SUCCESS');
    assert.equal(result.primaryAccounts.count, null);
  }
});

test('declared or streamed bodies over 2 MiB are rejected and cancelled', async () => {
  let cancelled = 0;
  for (const headers of [{ 'content-length': String(2 * 1024 * 1024 + 1) }, {}]) {
    const result = await run(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
            },
            cancel() {
              cancelled += 1;
            }
          }),
          { headers }
        )
    );
    assert.equal(result.primaryAccounts.code, 'RESPONSE_TOO_LARGE');
    assert.equal(result.virtualEmails.code, 'RESPONSE_TOO_LARGE');
  }
  assert.equal(cancelled, 4);
});

test('network codes remain safe and exception messages, URL and causes never escape', async () => {
  for (const [cause, expected] of [
    [{ code: 'ENOTFOUND' }, 'DNS_ERROR'],
    [{ code: 'EAI_AGAIN' }, 'DNS_ERROR'],
    [{ code: 'CERT_HAS_EXPIRED' }, 'TLS_ERROR'],
    [{ code: 'ECONNREFUSED' }, 'CONNECTION_REFUSED'],
    [{ code: 'ECONNRESET' }, 'CONNECTION_RESET'],
    [{ code: 'UND_ERR_CONNECT_TIMEOUT' }, 'TIMEOUT'],
    [{ message: 'unexpected redirect' }, 'REDIRECT_BLOCKED'],
    [{ code: 'private-code' }, 'NETWORK_ERROR']
  ]) {
    const result = await run(async () => {
      throw new Error('private-url-with-key', { cause });
    });
    assert.equal(result.primaryAccounts.code, expected);
    assert.doesNotMatch(JSON.stringify(result), /private-/);
  }
});

test('20 second timeout applies separately to both fixed requests, including a stalled body', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const pending = run(async () => {
    calls += 1;
    if (calls === 1) return new Promise(() => {});
    return new Response(
      new ReadableStream({
        pull() {
          return new Promise(() => {});
        }
      })
    );
  });
  await setImmediate();
  context.mock.timers.tick(20_000);
  await setImmediate();
  assert.equal(calls, 2);
  context.mock.timers.tick(20_000);
  const result = await pending;
  assert.equal(result.primaryAccounts.code, 'TIMEOUT');
  assert.equal(result.virtualEmails.code, 'TIMEOUT');
});

test('stdin container entry emits one bounded JSON line with no raw secrets', () => {
  const source = readFileSync(new URL('./mailbox-diagnostic.mjs', import.meta.url), 'utf8');
  const output = execFileSync(process.execPath, ['--input-type=module', '-'], {
    input: `globalThis.fetch = async () => { throw new Error('private-runtime-secret'); };\n${source}`,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  assert.equal(output.trim().split('\n').length, 1);
  assert.ok(Buffer.byteLength(output) < 4096);
  assert.equal(JSON.parse(output).primaryAccounts.code, 'NETWORK_ERROR');
  assert.doesNotMatch(output, /private-runtime|fixture-secret|fixture-channel|https:/);
});
