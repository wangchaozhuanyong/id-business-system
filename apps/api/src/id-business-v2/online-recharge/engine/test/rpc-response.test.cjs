'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const rpc = require('../rpc.cjs');
const originalFetch = global.fetch;
const originalEnv = { ...process.env };
const engine = path.join(__dirname, '..');
test.before(() => {
  process.env.ONLINE_RECHARGE_RPC_URL = 'http://127.0.0.1/rpc';
  process.env.ONLINE_RECHARGE_WORKER_KEY = 'synthetic-worker-key';
});
test.afterEach(() => {
  global.fetch = originalFetch;
  rpc.clearTask();
});
test.after(() => {
  for (const key of ['ONLINE_RECHARGE_RPC_URL', 'ONLINE_RECHARGE_WORKER_KEY']) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});
for (const method of ['claimJob', 'getActiveProxy', 'reserveCard']) {
  test(`${method} accepts Nest's empty successful response as absent resource`, async () => {
    global.fetch = async () => new Response('', { status: 201 });
    assert.equal(await rpc.rpc(method), null);
  });
}
test('Nest text responses retain region and address cursor contracts', async () => {
  for (const [method, value] of [
    ['getPaymentRegion', 'PH'],
    ['getAppConfigValue', ''],
    ['getAppConfigValue', 'synthetic-address']
  ]) {
    global.fetch = async () => new Response(value, { status: 201 });
    assert.equal(await rpc.rpc(method), value);
  }
});
test('plain numeric, boolean and null text values stay strings; JSON envelopes still unwrap', async () => {
  for (const value of ['123', 'false', 'null']) {
    global.fetch = async () => new Response(value, { headers: { 'content-type': 'text/html' } });
    assert.equal(await rpc.rpc('getAppConfigValue'), value);
  }
  global.fetch = async () =>
    new Response('{"result":"123"}', {
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  assert.equal(await rpc.rpc('getAppConfigValue'), '123');
  global.fetch = async () =>
    new Response('bad-json', { headers: { 'content-type': 'application/json' } });
  await assert.rejects(rpc.rpc('getAppConfigValue'), { code: 'RPC_RESPONSE_INVALID' });
});
test('required config and payment authorization reject an empty or malformed body', async () => {
  for (const text of ['', '<html>bad gateway</html>']) {
    global.fetch = async () => new Response(text, { status: 201 });
    await assert.rejects(rpc.rpc('getRuntimeConfig'), { code: 'RPC_RESPONSE_INVALID' });
    await assert.rejects(rpc.beforeExternalSubmit(), { code: 'RPC_RESPONSE_INVALID' });
    assert.equal(rpc.wasSubmitted(), false);
  }
});
test('JSON envelopes, false and zero keep their existing values', async () => {
  for (const [body, expected] of [
    [null, null],
    [{ result: null }, null],
    [{ data: false }, false],
    [{ result: 0 }, 0],
    [{ result: { ok: true } }, { ok: true }]
  ]) {
    global.fetch = async () => new Response(JSON.stringify(body));
    assert.deepEqual(await rpc.rpc('getActiveProxy'), expected);
  }
});
test('HTTP lease errors remain fatal even with an empty response', async () => {
  for (const status of [401, 403, 409, 410]) {
    global.fetch = async () => new Response('', { status });
    await assert.rejects(rpc.rpc('getActiveProxy'), { code: 'LEASE_LOST' });
  }
});
function taskRunnerScenario(failAt) {
  const code = `
    const calls=[],messages=[];let reached=false;
    Object.defineProperty(process,'connected',{value:true,configurable:true});
    process.send=item=>messages.push(item);
    process.env.ONLINE_RECHARGE_RPC_URL='http://127.0.0.1/rpc';
    process.env.ONLINE_RECHARGE_WORKER_KEY='synthetic-worker-key';
    global.fetch=async(_,options)=>{
      const {method}=JSON.parse(options.body);calls.push(method);
      if(method==='getRuntimeConfig')return new Response(JSON.stringify({hcaptcha:{},planNames:{},telegram:{},region:'PH',...(${JSON.stringify(failAt)}==='region'?{planRegion:{policy:'plan',paymentRegion:'CL',expectedCurrency:'CLP'}}:{})}));
      if(method==='getActiveProxy')return new Response(${JSON.stringify(failAt === 'proxy' ? '<html>bad</html>' : failAt === 'empty' ? '' : JSON.stringify({ id: 'synthetic-proxy', connectionMode: 'direct', protocol: 'http', proxy_url: 'http://fixture.example.invalid:8080' }))},{status:201});
      throw Error('unexpected synthetic call');
    };
    const file=require.resolve('./upstream/index');
    require.cache[file]={id:file,filename:file,loaded:true,exports:{run:async()=>{
      reached=true;
      if(${JSON.stringify(failAt)}==='execution')throw Error('synthetic-secret-token-value private@example.invalid');
      return {success:true,debugOnly:true,region:process.env.PAYMENT_REGION_OVERRIDE,currency:process.env.PLAN_REGION_EXPECTED_CURRENCY};
    }}};
    require('./task-runner.cjs').runTask({id:'synthetic-task',operation:'debug',plan:'pro_500',payload:{region:'US'},session:JSON.stringify({accessToken:'synthetic-secret-token-value'})}).then(()=>{
      process.stdout.write(JSON.stringify({calls,messages,reached,cleared:!Object.hasOwn(process.env,'PLAN_REGION_EXPECTED_CURRENCY')}));
    });
  `;
  const result = spawnSync(process.execPath, ['-e', code], {
    cwd: engine,
    encoding: 'utf8',
    timeout: 8000
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
test('real task initialization reaches debug execution only with an explicit proxy', () => {
  const result = taskRunnerScenario('none');
  assert.deepEqual(result.calls, ['getRuntimeConfig', 'getActiveProxy']);
  assert.equal(result.reached, true);
  assert.equal(result.messages.find((item) => item.type === 'result').status, 'succeeded');
  assert.equal(result.calls.includes('beforeExternalSubmit'), false);
});
test('task initialization failure records its phase without exposing credentials', () => {
  for (const phase of ['proxy', 'empty', 'execution']) {
    const result = taskRunnerScenario(phase);
    const finish = result.messages.find((item) => item.type === 'result');
    assert.equal(finish.status, 'failed');
    assert.equal(finish.result.phase, phase === 'empty' ? 'proxy' : phase);
    assert.ok(result.messages.some((item) => item.type === 'log'));
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret-token-value|private@example/);
  }
});

test('task subprocess takes frozen server region before caller input and clears its currency on exit', () => {
  const result = taskRunnerScenario('region');
  const finish = result.messages.find((item) => item.type === 'result');
  assert.equal(finish.result.region, 'CL');
  assert.equal(finish.result.currency, 'CLP');
  assert.equal(result.cleared, true);
  assert.equal(result.calls.includes('beforeExternalSubmit'), false);
});
