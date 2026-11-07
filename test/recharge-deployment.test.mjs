import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyNativeNetworkProof } from '../modules/recharge/codexdaichong/native-network.mjs';

const launcher = fileURLToPath(new URL('../deploy/recharge-core/run-recharge.py', import.meta.url));
test('the host supervisor keeps credentials off Docker arguments and isolates only the native role', () => {
  const code = `import runpy,json\nm=runpy.run_path(${JSON.stringify(launcher)})\nprint(json.dumps([m['docker_arguments']('native','a'*40,'172.17.0.2','synthetic-image'),m['docker_arguments']('adapter','a'*40,'172.17.0.2','synthetic-image','http://127.0.0.1:44579')]))`;
  const [native, adapter] = JSON.parse(execFileSync('python3', ['-c', code]));
  assert(native.includes('127.0.0.1:44579:3000'));
  assert(native.includes('DB_HOST=172.17.0.2'));
  assert(native.includes('type=bind,src=/opt/id-business-independent/formal/recharge-data/debug_screenshots,dst=/candidate/.runtime/codexdaichong/debug_screenshots'));
  assert(native.includes('type=bind,src=/opt/id-business-independent/formal/recharge-data/product_files,dst=/candidate/.runtime/codexdaichong/product_files'));
  assert(adapter.includes('DB_HOST=127.0.0.1'));
  assert.equal(adapter.includes('/var/run/docker.sock'), false);
  assert.equal(native.some((arg) => /DB_PASSWORD|BRIDGE_SECRET|ADMIN_TOKEN_SECRET/.test(arg)), false);
  assert.equal(adapter.some((arg) => /DB_PASSWORD|BRIDGE_SECRET|ADMIN_TOKEN_SECRET/.test(arg)), false);
});

test('the deployed Python proof is accepted by the actual adapter verifier and is not a boolean bypass', () => {
  const secret = randomBytes(32).toString('hex');
  const now = Date.now();
  const state = { Id: 'a'.repeat(64), HostConfig: { NetworkMode: 'bridge' },
    NetworkSettings: { Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '44579' }] } },
    State: { Running: true } };
  const code = `import runpy,json,sys\nm=runpy.run_path(${JSON.stringify(launcher)})\nv=json.loads(sys.stdin.read())\nprint(m['network_proof'](v['state'],v['secret'],'http://127.0.0.1:44579',now=v['now']))`;
  const proof = execFileSync('python3', ['-c', code], { input: JSON.stringify({ state, secret, now }) }).toString().trim();
  assert.equal(verifyNativeNetworkProof({ proof, secret, now, nativeUrl: 'http://127.0.0.1:44579',
    container: 'id-business-independent-recharge-native' }).containerId, state.Id);
});

test('deployment launches the pristine entrypoint and keeps role shutdown separate', async () => {
  const source = await readFile(new URL('../deploy/recharge-core/entry.mjs', import.meta.url), 'utf8');
  assert.match(source, /verifyCodexdaichongSource/);
  assert.match(source, /'--import', runtime/);
  assert.match(source, /codexdaichong\/server\.js/);
  assert.match(source, /Object.assign\(env, options\)/);
  assert.doesNotMatch(source, /writeFile|replaceSource|ID_VENDURE_SINGLE_ATTEMPT|expectedPlan/);
});
