import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createNativeAdminTokenIssuer } from '../modules/recharge/codexdaichong/native-adapter.mjs';
import { resolveNativeAdminTokenSecret } from '../modules/recharge/codexdaichong/native-secret.mjs';
import { CODEXDAICHONG_REVISION } from '../modules/recharge/codexdaichong/prepare.mjs';

const sourceRoot = fileURLToPath(new URL('../.upstream/codexdaichong/', import.meta.url));
const originalAuthSource = execFileSync('git', [
  '-C', sourceRoot, 'show', CODEXDAICHONG_REVISION + ':admin-auth.js'
], { encoding: 'utf8' });
const require = createRequire(import.meta.url);

function nativeAuth(env) {
  const module = { exports: {} };
  runInNewContext(originalAuthSource, {
    module, require, Buffer, process: { env },
    console: { warn() { throw new Error('原版不得回退到随机进程签名'); } }
  }, { filename: 'pinned-admin-auth.js' });
  return module.exports;
}

test('existing valid native signing configuration stays effective without mutation or derivation', () => {
  const configured = randomBytes(32).toString('hex');
  const env = { ADMIN_TOKEN_SECRET: ' ' + configured + ' ', ID_RECHARGE_BRIDGE_SECRET: randomBytes(32).toString('hex') };
  const before = { ...env };
  assert.equal(resolveNativeAdminTokenSecret(env), nativeAuth(env).resolveAdminTokenSecret());
  assert.equal(resolveNativeAdminTokenSecret(env), configured);
  assert.deepEqual(env, before);
});

test('missing native configuration derives a stable domain-separated in-memory value from the existing bridge secret', () => {
  const bridge = randomBytes(32).toString('hex');
  const env = { ID_RECHARGE_BRIDGE_SECRET: bridge };
  const before = { ...env };
  const native = resolveNativeAdminTokenSecret(env);
  assert.equal(native, resolveNativeAdminTokenSecret({ ...env, PORT: '3000', DB_HOST: '172.18.0.2' }));
  assert.equal(native, resolveNativeAdminTokenSecret({ ...env, ADMIN_TOKEN_SECRET: '  ' }));
  assert.equal(native, createHmac('sha256', bridge)
    .update('id-business/codexdaichong/native-admin-token/f4d7761/v1').digest('base64url'));
  assert.notEqual(native, bridge);
  assert.notEqual(native, resolveNativeAdminTokenSecret({ ID_RECHARGE_BRIDGE_SECRET: randomBytes(32).toString('hex') }));
  assert(native.length >= 32);
  assert.deepEqual(env, before);
  assert.throws(() => resolveNativeAdminTokenSecret({}), /既有桥接配置/);
  assert.throws(() => resolveNativeAdminTokenSecret({ ID_RECHARGE_BRIDGE_SECRET: 'short' }), /既有桥接配置/);
  assert.throws(() => resolveNativeAdminTokenSecret({ ...env, ADMIN_TOKEN_SECRET: 'short' }), /长度不足/);
});

test('the adapter issuer and a separate pristine process validate the same original native token without a stored secret', async () => {
  for (const existing of [undefined, randomBytes(32).toString('hex')]) {
    const env = { ID_RECHARGE_BRIDGE_SECRET: randomBytes(32).toString('hex'),
      ...(existing === undefined ? {} : { ADMIN_TOKEN_SECRET: existing }) };
    const nativeProcessEnv = { ...env, ADMIN_TOKEN_SECRET: resolveNativeAdminTokenSecret(env) };
    const pristine = nativeAuth(nativeProcessEnv);
    const adapterAuth = nativeAuth({});
    const issuer = createNativeAdminTokenIssuer({
      issueSignedToken: adapterAuth.issueSignedToken,
      secret: resolveNativeAdminTokenSecret({ ...env }),
      readPasswordVersion: async () => 7
    });
    const token = await issuer({ admin: true, email: 'synthetic-admin@example.test' });
    const claims = pristine.verifyAdminToken(token);
    assert.equal(claims?.sub, 'admin');
    assert.equal(claims?.pv, 7);
    assert.equal(claims?.email, 'synthetic-admin@example.test');
    assert.equal(claims.exp - claims.iat, 15_000);
    assert.equal(env.ADMIN_TOKEN_SECRET, existing);
    assert.equal(nativeAuth({ ADMIN_TOKEN_SECRET: randomBytes(32).toString('hex') }).verifyAdminToken(token), null);
  }
});
