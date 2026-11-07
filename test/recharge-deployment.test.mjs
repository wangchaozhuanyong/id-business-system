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

test('the ingress gate changes only new recharge mutations and removes only its own marker', () => {
  const gate = fileURLToPath(new URL('../deploy/recharge-core/release-gate.py', import.meta.url));
  const code = `import runpy,json\nm=runpy.run_path(${JSON.stringify(gate)})\ns='original-global-options\\n54-249-61-238.sslip.io {\\n    reverse_proxy 127.0.0.1:44572\\n}\\n'\ng=m['gated_text'](s,'a'*40,True)\nassert m['gated_text'](g,'a'*40,False)==s\nassert 'method POST PUT PATCH DELETE' in g\nassert 'path /integrations/codexdaichong/api/*' in g\nassert 'reverse_proxy 127.0.0.1:44572' in g\ntry: m['gated_text'](g,'b'*40,False); raise AssertionError('wrong marker accepted')\nexcept ValueError: pass\nprint('passed')`;
  assert.equal(execFileSync('python3', ['-c', code]).toString().trim(), 'passed');
});

test('the ingress gate supports the installed Caddy 2.10 without assuming newer signal support', () => {
  const gate = fileURLToPath(new URL('../deploy/recharge-core/release-gate.py', import.meta.url));
  const code = `import runpy,json,copy\nm=runpy.run_path(${JSON.stringify(gate)})
assert m['reload_strategy']('v2.10.2 h1:synthetic')=='restart'
assert m['reload_strategy']('v2.11.0')=='signal'
try: m['reload_strategy']('unknown'); raise AssertionError('unknown version accepted')
except ValueError: pass
before={'Id':'same-container','Image':'same-image','Mounts':[{'Source':'same-config','Destination':'/etc/caddy/Caddyfile'},{'Source':'same-data','Destination':'/data'}],'State':{'Running':True,'StartedAt':'before'}}
after=copy.deepcopy(before); after['State']['StartedAt']='after'; after['Mounts'].reverse()
states=iter([before,after]); commands=[]
def output(args,**kwargs): return 'v2.10.2' if args[-1]=='version' else json.dumps([next(states)]).encode()
def run(args,**kwargs): commands.append(args)
m['subprocess'].check_output=output; m['subprocess'].run=run
result=m['reload_gateway']()
assert commands==[['docker','restart','--time','20','id-business-independent-caddy']]
assert result['strategy']=='restart' and result['containerId']=='same-container'
assert result['beforeStartedAt']=='before' and result['afterStartedAt']=='after'
after['Mounts'][0]['Source']='unexpected-data'
states=iter([before,after])
try: m['reload_gateway'](); raise AssertionError('changed mount accepted')
except ValueError: pass
print('passed')`;
  assert.equal(execFileSync('python3', ['-c', code]).toString().trim(), 'passed');
});

test('the ingress gate rejects unrelated HTTP 503 responses and confirms its unique body and retry header', () => {
  const gate = fileURLToPath(new URL('../deploy/recharge-core/release-gate.py', import.meta.url));
  const code = `import runpy\nm=runpy.run_path(${JSON.stringify(gate)})
body=m['GATE_BODY']; probe=m['probe_matches']
assert probe('HTTP/2 503 \\r\\nRetry-After: 60\\r\\n\\r\\n'+body,True)
assert not probe('HTTP/2 503 \\r\\nRetry-After: 60\\r\\n\\r\\nupstream failed',True)
assert not probe('HTTP/2 503 \\r\\n\\r\\n'+body,True)
assert not probe('HTTP/2 401 \\r\\nRetry-After: 60\\r\\n\\r\\n'+body,True)
assert probe('HTTP/2 401 \\r\\n\\r\\n{"success":false}',False)
assert not probe('HTTP/2 503 \\r\\nRetry-After: 60\\r\\n\\r\\n'+body,False)
print('passed')`;
  assert.equal(execFileSync('python3', ['-c', code]).toString().trim(), 'passed');
});
