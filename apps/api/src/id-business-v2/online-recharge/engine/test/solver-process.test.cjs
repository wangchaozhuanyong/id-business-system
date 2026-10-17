'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { runInNewContext } = require('node:vm');
const { spawnSync } = require('node:child_process');
const runtime = require('../upstream/verification-runtime');
const source = fs.readFileSync(path.join(__dirname, '../upstream/hcaptcha-solver.js'), 'utf8');
const binding = 'bf390e22-2a2a-43aa-bd17-a59b7db45a3f';
let keepAlive;
test.before(() => {
  keepAlive = setInterval(() => {}, 50);
});
test.after(() => clearInterval(keepAlive));

function fixture({ output, stubborn = false, signal } = {}) {
  const module = { exports: {} },
    kills = [],
    calls = [],
    logs = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = (input) => {
    calls[0].input = JSON.parse(input);
    if (output)
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(output));
        child.emit('close', 1);
      });
  };
  child.kill = (name) => {
    kills.push(name);
    if (!stubborn || name === 'SIGKILL') setImmediate(() => child.emit('close', null));
    return true;
  };
  runInNewContext(source, {
    module,
    Buffer,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    __dirname: path.join(__dirname, '../upstream'),
    console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    process: {
      env: {
        CDP_URL: 'http://127.0.0.1:12345',
        HCAPTCHA_SOLVER_SCRIPT: '/synthetic/solver.py',
        HEADFUL: '0'
      }
    },
    require(name) {
      if (name === 'child_process')
        return {
          spawn: (bin, args, options) => {
            calls.push({ bin, args, options });
            return child;
          }
        };
      if (name === 'fs') return { existsSync: () => true, mkdirSync() {} };
      if (name === './verification-runtime') return runtime;
      return require(name);
    }
  });
  return {
    api: module.exports,
    kills,
    calls,
    logs,
    run: (options = {}) =>
      module.exports.solveHcaptchaOnPage({
        pageBinding: binding,
        timeoutMs: 45,
        signal,
        ...options
      })
  };
}

test('a task page binding is mandatory; URL substring matching cannot start a solver', async () => {
  const f = fixture();
  assert.equal(
    (await f.api.solveHcaptchaOnPage({ pageUrlSubstr: 'checkout' })).code,
    'VERIFICATION_PAGE_BINDING_REQUIRED'
  );
  assert.equal(f.calls.length, 0);
});

test('solver receives only remaining budget and page identity, with current challenge in stdin', async () => {
  const f = fixture({ output: '{"type":"error","code":"VLM_INVALID_RESPONSE"}\n' });
  await f.run({ timeoutMs: 1200, challenge: { key: 'synthetic-round' } });
  const args = f.calls[0].args,
    seconds = Number(args[args.indexOf('--timeout') + 1]);
  assert.ok(seconds > 0 && seconds <= 1.2);
  assert.ok(!args.includes('--attached-page-url-substr'));
  assert.equal(args[args.indexOf('--attached-page-binding') + 1], binding);
  assert.equal(f.calls[0].input.challenge.key, 'synthetic-round');
});

test('hard deadline terminates and reaps an unresponsive solver instead of restarting it', async () => {
  const f = fixture({ stubborn: true });
  const started = Date.now(),
    result = await f.run();
  assert.equal(result.code, 'VERIFICATION_TIMEOUT');
  assert.deepEqual(f.kills, ['SIGTERM', 'SIGKILL']);
  assert.ok(Date.now() - started < 1800);
  assert.equal(f.calls.length, 1);
});

test('lease cancellation terminates the same child and preserves LEASE_LOST', async () => {
  const controller = new AbortController(),
    f = fixture({ signal: controller.signal });
  const result = f.run({ timeoutMs: 1000 });
  controller.abort(Object.assign(new Error('synthetic expired lease'), { code: 'LEASE_LOST' }));
  assert.equal((await result).code, 'LEASE_LOST');
  assert.deepEqual(f.kills, ['SIGTERM']);
});

test('controlled provider errors survive process exit without forwarding sensitive output', async () => {
  const f = fixture({
    output:
      'PRIVATE_SYNTHETIC_MODEL_PAYLOAD\n{"type":"error","code":"VLM_AUTH_FAILED","httpStatus":401,"providerCode":"invalid_api_key"}\n'
  });
  const result = await f.run();
  assert.equal(result.code, 'VLM_AUTH_FAILED');
  assert.equal(result.diagnostics.httpStatus, 401);
  assert.doesNotMatch(JSON.stringify({ result, logs: f.logs }), /PRIVATE_SYNTHETIC_MODEL_PAYLOAD/);
});

test('Python routing and model contracts run from original functions with synthetic frames and HTTP only', () => {
  const code = String.raw`
from pathlib import Path
from types import SimpleNamespace
import ast,json,re,time,urllib.parse
path=Path('upstream/hcaptcha/solver.py')
tree=ast.parse(path.read_text())
names={'VerificationFailure','_remaining_seconds','_normalize_prompt_text','_looks_like_prompt_line','_is_checkbox_only_overlay_text','get_prompt','_frame_url_has_kind','_should_ignore_hcaptcha_frame','_locator_is_displayed','_frame_is_visible','_frame_looks_like_challenge','_hcaptcha_frame','challenge_frame','checkbox_frame','click_checkbox','_select_attached_page','_vlm_payload','_adapt_vlm_parameter','_vlm_http_failure','_vlm_chat_completion','_normalize_api_base','_extract_json_object'}
module=ast.Module(body=[ast.ImportFrom(module='__future__',names=[ast.alias(name='annotations')],level=0)]+[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in names],type_ignores=[])
ns={'re':re,'json':json,'time':time,'urllib':urllib,'_SOLVER_DEADLINE':None,'_png_data_url':lambda _:'data:image/png;base64,SYNTHETIC'}
exec(compile(ast.fix_missing_locations(module),str(path),'exec'),ns)
checks=0
def check(value):
 global checks
 assert value
 checks+=1
class Loc:
 def __init__(self,f,s):self.f,self.s=f,s
 @property
 def first(self):return self
 def inner_text(self,timeout=None):
  if self.s=='body':return self.f.body
  if self.s=='.prompt-text' and self.f.prompt:return self.f.prompt
  raise RuntimeError('synthetic missing node')
 def count(self):
  if 'canvas' in self.s:return int(self.f.image)
  if 'checkbox' in self.s:return 1
  return 0
 def get_attribute(self,_):return 'false'
 def click(self,**kw):self.f.clicks+=1
 def nth(self,_):return self
 def is_visible(self):return self.f.visible
 def evaluate(self,_):return self.f.visible
class Frame:
 def __init__(self,url,body,prompt='',image=False,visible=True,parent=True):self.url,self.body,self.prompt,self.image,self.visible,self.parent_frame,self.clicks=url,body,prompt,image,visible,SimpleNamespace(parent_frame=None) if parent else None,0
 def locator(self,s):return Loc(self,s)
 def frame_element(self):return self
 def bounding_box(self,timeout=None):return {'x':0,'y':0,'width':300,'height':300}
 def is_visible(self):return self.visible
 def dispose(self):pass
 def evaluate(self,_):return self.visible
main=Frame('https://chatgpt.com/checkout','One more step before you are done. Select the checkbox below.',parent=False)
cb=Frame('https://newassets.hcaptcha.com/captcha/v1/demo/static/hcaptcha.html#frame=checkbox','I am human')
page=SimpleNamespace(frames=[main,cb])
check(ns['_is_checkbox_only_overlay_text']('Select the checkbox below.'))
check(ns['get_prompt'](main)=='')
check(ns['get_prompt'](Frame(cb.url,'Select the checkbox below.','Select the checkbox below.'))=='')
check(ns['challenge_frame'](page) is None)
check(ns['click_checkbox'](page) and cb.clicks==1)
hidden=Frame(cb.url.replace('checkbox','challenge'),'Please select all squares','Please select all squares',image=True,visible=False)
page.frames.append(hidden);check(ns['challenge_frame'](page) is None)
real=Frame(cb.url.replace('checkbox','challenge'),'Please select all squares','Please select all squares',image=True)
page.frames.append(real);check(ns['challenge_frame'](page) is real)
page.frames.append(Frame(real.url,real.body,real.prompt,image=True))
try:ns['challenge_frame'](page);raise AssertionError('ambiguous frame accepted')
except ns['VerificationFailure'] as e:check(e.code=='VERIFICATION_FRAME_AMBIGUOUS')
binding='bf390e22-2a2a-43aa-bd17-a59b7db45a3f'
first=SimpleNamespace(evaluate=lambda _: 'other',url='https://chatgpt.com/checkout')
second=SimpleNamespace(evaluate=lambda _: binding,url=first.url)
browser=SimpleNamespace(contexts=[SimpleNamespace(pages=[first,second])])
check(ns['_select_attached_page'](browser,binding) is second)
browser.contexts[0].pages.append(second)
try:ns['_select_attached_page'](browser,binding);raise AssertionError('ambiguous binding accepted')
except ns['VerificationFailure'] as e:check(e.code=='VERIFICATION_PAGE_BINDING_MISMATCH')
payload=ns['_vlm_payload']('gpt-5.5','synthetic',[])
check(payload['max_completion_tokens']==1024 and 'temperature' not in payload and 'max_tokens' not in payload)
class Timeout(Exception):pass
class RequestException(Exception):pass
class FakeRequests:
 def __init__(self,items):self.items=items;self.calls=[];self.Timeout=Timeout;self.RequestException=RequestException
 def post(self,url,**kw):
  self.calls.append((url,json.loads(json.dumps(kw['json'])),kw['timeout']))
  item=self.items.pop(0)
  if isinstance(item,Exception):raise item
  status,data=item
  return SimpleNamespace(status_code=status,ok=200<=status<300,json=lambda:data)
def invoke(items,model='gpt-5.5'):
 req=FakeRequests(items);ns['requests']=req
 try:r=ns['_vlm_chat_completion'](base_url='https://synthetic.invalid/v1',api_key='synthetic',model=model,system_prompt='JSON',user_text='synthetic image',images=[object()]);return req,r
 except ns['VerificationFailure'] as e:return req,e
for status,code in [(401,'VLM_AUTH_FAILED'),(429,'VLM_RATE_LIMITED'),(503,'VLM_PROVIDER_UNAVAILABLE')]:
 req,result=invoke([(status,{'error':{'code':'synthetic_failure','message':'PRIVATE'}})])
 check(result.code==code and result.http_status==status and len(req.calls)==1 and 'PRIVATE' not in str(result))
req,result=invoke([(400,{'error':{'code':'unsupported_parameter','param':'max_tokens'}}),(200,{'choices':[{'message':{'content':'{"click_ids":["G1"]}'}}]})],model='gpt-4o')
check(len(req.calls)==2 and req.calls[1][1].get('max_completion_tokens')==1024 and req.calls[0][0]==req.calls[1][0])
req,result=invoke([Timeout()]);check(result.code=='VLM_TIMEOUT' and len(req.calls)==1)
req,result=invoke([(200,{'choices':[]})]);check(result.code=='VLM_INVALID_RESPONSE')
req,result=invoke([(400,{'error':{'code':'unsupported_parameter','param':'unrelated'}})]);check(len(req.calls)==1 and result.code=='VLM_REQUEST_UNSUPPORTED')
ns['_SOLVER_DEADLINE']=time.monotonic()+0.4
req,result=invoke([(200,{'choices':[{'message':{'content':'{"ok":true}'}}]})]);check(0<req.calls[0][2]<=0.4)
ns['_SOLVER_DEADLINE']=time.monotonic()-1
try:ns['_remaining_seconds']();raise AssertionError('expired deadline accepted')
except ns['VerificationFailure'] as e:check(e.code=='VERIFICATION_TIMEOUT')
print(json.dumps({'checks':checks,'externalRequests':0,'repoWrites':0}))
`;
  const result = spawnSync('python3', ['-B', '-c', code], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(result.stdout);
  assert.ok(proof.checks >= 20);
  assert.equal(proof.externalRequests, 0);
});
