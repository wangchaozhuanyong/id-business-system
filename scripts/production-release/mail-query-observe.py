"""Bounded, read-only observation for the mailbox API/Admin publication."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.deploy/mail-query-observe'
INSTANCE = 'i-0838cebf64f0e2a89'


def source(expected):
    if not re.fullmatch('[a-f0-9]{40}', expected):
        raise ValueError('Invalid expected current revision')
    program = r'''
import hashlib,json,re,subprocess
from pathlib import Path
base=Path('/opt/id-business-v2')
current=(base/'current').resolve(strict=True)
assert current.parent==base/'releases'
raw=(current/'release-manifest.json').read_bytes()
manifest=json.loads(raw)
assert manifest['commit']==EXPECTED and manifest['status']=='DEPLOYED'
def sha(value):return hashlib.sha256(value).hexdigest()
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()
def run(*args):return subprocess.check_output(args,stderr=subprocess.DEVNULL,timeout=60).decode().strip()
def compose(*args):return run('docker','compose','--env-file',str(current/'.env.aws.production'),'-f',str(current/'docker-compose.aws-mysql.yml'),'-f',str(current/'compose.release.json'),*args)
services=('api','admin','online-recharge','auto-recharge','media-resolver','mysql','caddy')
def snapshot():
 result={}
 for name in services:
  container=compose('ps','-a','-q',name)
  assert re.fullmatch('[a-f0-9]{12,64}',container)
  data=json.loads(run('docker','inspect',container))[0]
  result[name]={'containerId':data['Id'],'image':data['Image'],'status':data['State']['Status'],'health':data['State'].get('Health',{}).get('Status'),'environmentSha256':sha(canonical(sorted(data['Config']['Env']))),'startedAtSha256':sha(data['State']['StartedAt'].encode())}
 return result
before=snapshot()
configs={n:sha((current/n).read_bytes()) for n in ('.env.aws.production','compose.release.json','docker-compose.aws-mysql.yml')}
modules=['id-business-v2/workspace/id-business-v2-vendure-mailbox.service.js','id-business-v2/workspace/vendure-mailbox-list.js','id-business-v2/workspace/providers/id-business-v2-vendure-mailbox.client.js','id-business-v2/workspace/id-business-v2-mail-viewer.service.js']
script="const fs=require('fs'),crypto=require('crypto');const out={};for(const p of "+json.dumps(modules)+"){const f='/app/apps/api/dist/'+p;out[p]=fs.existsSync(f)?crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'):null;}console.log(JSON.stringify(out));"
api=json.loads(run('docker','exec',before['api']['containerId'],'node','-e',script))
assert snapshot()==before and (base/'current').resolve()==current and (current/'release-manifest.json').read_bytes()==raw
assert configs=={n:sha((current/n).read_bytes()) for n in configs}
print(json.dumps({'status':'MAIL_QUERY_READONLY_OBSERVED','commit':EXPECTED,'manifestSha256':sha(raw),'services':before,'configurationSha256':configs,'apiModules':api,'businessActions':0,'newBuilds':0,'restarts':0},sort_keys=True))
'''
    return 'EXPECTED=' + repr(expected) + '\n' + program


def main():
    expected = os.environ['EXPECTED_CURRENT']
    code = source(expected)
    target = os.environ['RELEASE_COMMIT']
    if not re.fullmatch('[a-f0-9]{40}', target):
        raise ValueError('Invalid source revision')
    def execute(*args):
        return subprocess.check_output(args, cwd=ROOT, stderr=subprocess.DEVNULL).decode().strip()
    if execute('git', 'rev-parse', 'HEAD') != target or execute('gh', 'api', 'repos/wangchaozhuanyong/id-business-system/git/ref/heads/main', '--jq', '.object.sha') != target:
        raise RuntimeError('Publication source is not exact latest main')
    if json.loads(execute('aws', 'sts', 'get-caller-identity', '--output', 'json'))['Account'] != '098208446664':
        raise RuntimeError('Unexpected AWS account')
    OUT.mkdir(parents=True, exist_ok=True)
    parameters = json.dumps({'commands':["python3 - <<'MAIL_QUERY_READONLY'\n"+code+'\nMAIL_QUERY_READONLY'], 'executionTimeout':['180']})
    command = execute('aws','--region','ap-northeast-1','ssm','send-command','--instance-ids',INSTANCE,'--document-name','AWS-RunShellScript','--parameters',parameters,'--query','Command.CommandId','--output','text')
    (OUT/'request.json').write_text(json.dumps({'commandId':command,'instanceId':INSTANCE,'sourceCommit':target,'expectedCurrent':expected}))
    deadline=time.monotonic()+210
    while time.monotonic()<deadline:
        try:
            receipt=json.loads(execute('aws','--region','ap-northeast-1','ssm','get-command-invocation','--command-id',command,'--instance-id',INSTANCE,'--output','json'))
        except subprocess.CalledProcessError:
            time.sleep(3)
            continue
        if receipt['Status'] in ('Pending','InProgress','Delayed'):
            time.sleep(3)
            continue
        if receipt['Status']!='Success' or receipt['ResponseCode']!=0:
            (OUT/'failure.json').write_text(json.dumps({'status':receipt['Status'],'responseCode':receipt['ResponseCode'],'commandId':command}))
            raise RuntimeError('Read-only production observation failed; raw output suppressed')
        result=json.loads(receipt['StandardOutputContent'])
        if result.get('status')!='MAIL_QUERY_READONLY_OBSERVED' or result.get('commit')!=expected or result.get('businessActions')!=0:
            raise RuntimeError('Invalid read-only receipt')
        (OUT/'observation.json').write_text(json.dumps(result,sort_keys=True,indent=2)+'\n')
        print(json.dumps(result,sort_keys=True))
        return
    raise RuntimeError('Observation still pending; inspect recorded command rather than resend')


if __name__=='__main__':
    main()
