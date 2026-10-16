'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const security = require('../security.cjs');
const publishedApiRoot = process.env.PROXY_RESULT_API_MODULE_ROOT;
const apiModuleRoot = publishedApiRoot || path.resolve(__dirname, '../../../../../src');
const apiBindings = {
  'id-business-v2/proxy-pool/proxy-test.js': {
    source: 'f9da11d08607269802d2a2abde80659d8a83c1a511f64628518ab51cc26c17fd',
    compiled: '6e46a6ad29a90e3f7f5bfd625e46dedba7f9aea15a3818b9f466e610008ccaad'
  },
  'id-business-v2/proxy-pool/persistence/online-proxy.repository.js': {
    source: 'e00a489a70481314d5a4e8c06e55b4d292ca0e35465aa87c1af40897496713d2',
    compiled: 'a335c9f9fdcc61dc785856b4e6e7d36831af0156dce5604960784954cb624387'
  }
};

function loadPublishedApi(relativePath, dependencies) {
  const filename = path.join(
    apiModuleRoot,
    publishedApiRoot ? relativePath : relativePath.replace(/\.js$/, '.ts')
  );
  const raw = fs.readFileSync(filename);
  assert.equal(
    createHash('sha256').update(raw).digest('hex'),
    apiBindings[relativePath][publishedApiRoot ? 'compiled' : 'source'],
    'The strict API consumer must remain the verified published 7c source'
  );
  let code = raw.toString('utf8');
  if (!publishedApiRoot) {
    // A pure transpile executes the exact frozen consumer without building an API or client.
    const ts = require('typescript');
    const transpiled = ts.transpileModule(code, {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        esModuleInterop: true
      },
      reportDiagnostics: true
    });
    assert.equal(
      (transpiled.diagnostics || []).filter((item) => item.category === ts.DiagnosticCategory.Error)
        .length,
      0
    );
    code = transpiled.outputText;
  }
  const module = { exports: {} };
  const requireDependency = (name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected API dependency: ${name}`);
    return dependencies[name];
  };
  vm.compileFunction(code, ['exports', 'require', 'module'], {
    filename
  })(module.exports, requireDependency, module);
  return module.exports;
}

const apiProxyTest = loadPublishedApi('id-business-v2/proxy-pool/proxy-test.js', {
  'node:crypto': require('node:crypto'),
  'node:net': require('node:net')
});
const { safeProxyTestTaskResult, proxyConnectionVersion } = apiProxyTest;
const { OnlineProxyPoolRepository } = loadPublishedApi(
  'id-business-v2/proxy-pool/persistence/online-proxy.repository.js',
  {
    '@nestjs/common': {
      Injectable: () => (target) => target,
      BadRequestException: class extends Error {},
      ConflictException: class extends Error {}
    },
    'node:crypto': require('node:crypto'),
    '../../../common/crypto/field-encryption.service': { FieldEncryptionService: class {} },
    './proxy-pool.repository': { RechargeProxyRepository: class {} },
    '../proxy-pool.service': { RechargeProxyService: class {} },
    '../validation': {
      bankRechargeObject: () => assert.fail('No command input is used in this receipt test'),
      bankRechargeId: () => assert.fail('No command input is used in this receipt test')
    },
    '../proxy-test': apiProxyTest
  }
);

const proxyId = '0ae77e06-f2e4-4d9c-bee8-c9424c8905fb';
const otherId = '1f2e3d4c-5b6a-4789-8abc-0123456789ab';
const numericId = '00000000-0000-4000-8000-000000000000';

function transportResult(
  task,
  result,
  parentSecret = 'synthetic-worker-key-at-least-32-characters'
) {
  security.clearSecrets();
  try {
    security.rememberSecrets(task);
    const child = security.sanitizeResult(result);
    // The parent is a separate process and remembers its own worker key, not the child task.
    security.clearSecrets();
    security.rememberSecrets(parentSecret, 'secret');
    return { child, parent: security.sanitizeResult(child) };
  } finally {
    security.clearSecrets();
  }
}

for (const id of [proxyId, numericId])
  test(`successful probe retains canonical resource UUID ${id} through both worker boundaries`, () => {
    const task = { operation: 'proxy_test', payload: { proxyId: id } };
    const result = {
      success: true,
      results: [{ proxyId: id, ok: true, ip: '8.8.8.8', latencyMs: 23 }]
    };
    const { child, parent } = transportResult(task, result);
    assert.equal(child.results[0].proxyId, id);
    assert.equal(parent.results[0].proxyId, id);
    assert.deepEqual(safeProxyTestTaskResult(parent, id), {
      ok: true,
      ip: '8.8.8.8',
      latencyMs: 23,
      message: '检测成功'
    });
  });

test('nested and array result identities survive while UUID values in sensitive fields stay hidden', () => {
  const value = {
    results: [{ proxyId }, { nested: [{ proxyId: numericId }] }],
    password: otherId,
    session: otherId,
    token: otherId
  };
  const { parent } = transportResult(
    { payload: { proxyId }, password: otherId, session: otherId, token: otherId },
    value
  );
  assert.equal(parent.results[0].proxyId, proxyId);
  assert.equal(parent.results[1].nested[0].proxyId, numericId);
  assert.equal(parent.password, '[已隐藏]');
  assert.equal(parent.session, '[已隐藏]');
  assert.equal(parent.token, '[已隐藏]');
});

test('a child credential with the same UUID remains secret and cannot become a valid receipt', () => {
  const { child, parent } = transportResult(
    { payload: { proxyId }, password: proxyId },
    { success: true, results: [{ proxyId, ok: true, ip: '8.8.8.8', latencyMs: 23 }] }
  );
  assert.equal(child.results[0].proxyId, '[已隐藏]');
  assert.equal(parent.results[0].proxyId, '[已隐藏]');
  assert.equal(safeProxyTestTaskResult(parent, proxyId).ok, false);
});

test('a parent worker key with the same UUID remains secret after the child transport', () => {
  const { child, parent } = transportResult(
    { payload: { proxyId } },
    { success: true, results: [{ proxyId, ok: true, ip: '8.8.8.8', latencyMs: 23 }] },
    proxyId
  );
  assert.equal(child.results[0].proxyId, proxyId);
  assert.equal(parent.results[0].proxyId, '[已隐藏]');
  assert.equal(safeProxyTestTaskResult(parent, proxyId).ok, false);
});

test('controlled probe failure keeps its exact error instead of becoming a generic network failure', () => {
  const { parent } = transportResult(
    { payload: { proxyId } },
    {
      success: false,
      results: [{ proxyId, ok: false, ip: null, latencyMs: 12, errorCode: 'proxy_auth_failed' }]
    }
  );
  assert.equal(parent.results[0].proxyId, proxyId);
  assert.deepEqual(safeProxyTestTaskResult(parent, proxyId), {
    ok: false,
    ip: null,
    latencyMs: 12,
    errorCode: 'proxy_auth_failed',
    message: '检测失败：代理认证失败，请检查账号和密码'
  });
});

test('proxy URLs, credentials and malformed proxyId values receive no UUID exemption', () => {
  const malformed = [
    ` ${proxyId}`,
    `${proxyId} `,
    proxyId.toUpperCase(),
    '00000000-0000-0000-8000-000000000000',
    '00000000-0000-4000-0000-000000000000',
    proxyId.replace(/-/g, ''),
    'http://synthetic-user:synthetic-password@proxy.example.invalid:8080',
    'synthetic-proxy-password'
  ];
  for (const id of malformed) {
    const { parent } = transportResult(
      { payload: { proxyId: id } },
      { results: [{ proxyId: id }] }
    );
    assert.equal(parent.results[0].proxyId, '[已隐藏]');
  }
  const secrets = {
    proxy_url: 'socks5://synthetic-user:synthetic-password@proxy.example.invalid:1080',
    proxy: 'http://synthetic-user:synthetic-password@proxy.example.invalid:8080',
    password: 'synthetic-password',
    apiKey: 'synthetic-api-key',
    accessToken: 'synthetic-access-token'
  };
  const { parent } = transportResult(secrets, secrets);
  for (const value of Object.values(secrets)) assert.ok(!JSON.stringify(parent).includes(value));
});

test('API still rejects a successful receipt for a different resource UUID', () => {
  const { parent } = transportResult(
    { payload: { proxyId } },
    { success: true, results: [{ proxyId: otherId, ok: true, ip: '8.8.8.8', latencyMs: 23 }] }
  );
  assert.equal(parent.results[0].proxyId, otherId);
  assert.equal(safeProxyTestTaskResult(parent, proxyId).ok, false);
  assert.equal(safeProxyTestTaskResult(parent, proxyId).ip, null);
});

test('actual API repository refuses stale connection versions before decrypting or writing', async () => {
  const row = {
    id: proxyId,
    urlHash: 'synthetic-connection-hash',
    protocol: 'http',
    connectionMode: 'direct',
    urlEncrypted: 'synthetic-unused-ciphertext'
  };
  let decrypted = 0;
  const writes = [];
  const repository = {
    lock: async () => {},
    active: async () => [row],
    findInTransaction: async () => row,
    update: async (_, id, data) => writes.push({ id, data })
  };
  const pool = new OnlineProxyPoolRepository({}, repository, {
    decrypt: () => {
      decrypted++;
      assert.fail('A stale connection version must never decrypt saved credentials');
    }
  });
  const currentVersion = proxyConnectionVersion(row);
  const staleVersion = proxyConnectionVersion({ ...row, urlHash: 'synthetic-old-connection' });
  const result = { ok: true, ip: '8.8.8.8', latencyMs: 23 };
  await assert.rejects(pool.active({}, proxyId, true, staleVersion), /连接资料已修改/);
  assert.deepEqual(await pool.result({}, proxyId, result, true, staleVersion), { applied: false });
  assert.deepEqual(await pool.result({}, proxyId, result, true), { applied: false });
  assert.equal(decrypted, 0);
  assert.equal(writes.length, 0);
  assert.deepEqual(await pool.result({}, proxyId, result, true, currentVersion), { applied: true });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, proxyId);
  assert.equal(writes[0].data.exitIp, '8.8.8.8');
});
