"""Finite OIDC/SSM read-only capture and one blank-context proxy comparison."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import zlib

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
ACCOUNT = '098208446664'
INSTANCE = 'i-0838cebf64f0e2a89'
PREDECESSOR = '1467a766701cf78a4da40f6871b7a66a1bf806a8'
PROXY = '0ae77e06-f2e4-4d9c-bee8-c9424c8905fb'
DIAGNOSTIC_SHA = 'ab84521fa4431f3e6bc8f21b50dad6aa6f78d92f9c5410d3818db3d9273ad5a7'

CAPTURE = r'''
import hashlib,importlib.util,json
from pathlib import Path
base=Path('/opt/id-business-v2');current=(base/'current').resolve(strict=True)
assert current.parent==base/'releases'
assert json.loads((current/'release-manifest.json').read_bytes())['commit']==EXPECTED
helper=current/'scripts/production-release/online-browser-region-release.py'
assert hashlib.sha256(helper.read_bytes()).hexdigest()==PLAN['controlSources']['online-browser-region-release.py']
spec=importlib.util.spec_from_file_location('parent',helper);p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
c=json.loads((helper.parent/p.CONTRACT_FILE).read_bytes())
assert p.release({**PLAN,'mode':'readback'},c)['status']=='ONLINE_BROWSER_REGION_20261030_INDEPENDENT_READBACK_VERIFIED'
core=p.engine(c,PLAN);h,_old,d,*_=core.LEGACY.helpers()
raw=(current/'release-manifest.json').read_bytes();states=h.snapshot(d,current)
history=p.load('bitbrowser-history-release.py');history.MODULES=frozenset()
normalizer=Path(c['baseline']['backupNormalizerPath'])
b={'commit':EXPECTED,'current':str(current),'manifestSha256':p.sha(raw),'services':states,
'configurationSha256':{n:p.sha((current/n).read_bytes()) for n in c['baseline']['configurationSha256']},
'runtimeConfigurationSha256':{n:h.configuration(d,s) for n,s in states.items()},
'runtime':history.runtime(d,states),'database':history.database(d,states['api']),
'backupNormalizerPath':str(normalizer),'backupNormalizerSha256':p.sha(normalizer.read_bytes())}
assert (base/'current').resolve()==current and h.snapshot(d,current)==states
result={'status':'PROXY_CLIENT_PARENT_CAPTURE_VERIFIED','baseline':b,
'parentProofSha256':p.sha((current/'online-frame-attempts-build-proof.json').read_bytes()),
'parentPreservationSha256':p.sha((current/'online-frame-attempts-preservation.json').read_bytes()),'businessActions':0}
'''

# Plain proxy configuration crosses only the existing API->host->engine pipes
# in memory. No proxy, key, Session or Cookie enters an argument, file or log.
READ_PROXY = r'''
const {PrismaClient}=require('@prisma/client'),crypto=require('crypto');const db=new PrismaClient({log:[]});
(async()=>{try{
const row=await db.idBusinessV2RechargeProxy.findUnique({where:{id:'0ae77e06-f2e4-4d9c-bee8-c9424c8905fb'},select:{active:true,countryCode:true,protocol:true,connectionMode:true,urlEncrypted:true,urlHash:true}});
if(!row?.active||row.countryCode!=='PH'||row.protocol!=='http'||row.connectionMode!=='direct'||!process.env.FIELD_ENCRYPTION_KEY)throw Error();
if(crypto.createHash('sha256').update(JSON.stringify([row.urlHash,row.protocol,row.connectionMode])).digest('hex')!=='38b4a98afa6e6b2f8e4d13f08095ecb1ee12a2b315559dcc90bcd5f3e688453c')throw Error();
const [v,iv,tag,ct]=row.urlEncrypted.split(':');if(v!=='v1')throw Error();
const d=crypto.createDecipheriv('aes-256-gcm',crypto.createHash('sha256').update(process.env.FIELD_ENCRYPTION_KEY).digest(),Buffer.from(iv,'base64url'));d.setAuthTag(Buffer.from(tag,'base64url'));
let raw=Buffer.concat([d.update(Buffer.from(ct,'base64url')),d.final()]).toString('utf8');if(/\{session\}/i.test(raw))throw Error();
const u=new URL(raw);process.stdout.write(JSON.stringify({server:u.protocol+'//'+u.hostname+(u.port?':'+u.port:''),username:decodeURIComponent(u.username),password:decodeURIComponent(u.password)}));raw='';
}catch{process.exitCode=2;}finally{await db.$disconnect();}})();
'''
RUN_COMPARISON = r'''
const fs=require('fs'),crypto=require('crypto');
if(crypto.createHash('sha256').update(fs.readFileSync('proxy-client-diagnostic.cjs')).digest('hex')!==EXPECTED_HASH)process.exit(2);
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',async()=>{
try{const proxyConfig=JSON.parse(input);input='';const report=await require('./proxy-client-diagnostic.cjs').runProxyClientDiagnostic({proxyConfig});proxyConfig.username='';proxyConfig.password='';console.log(JSON.stringify(report));}
catch{process.exitCode=2;}});
'''
COMPARE = r'''
import hashlib,json,subprocess
from pathlib import Path
base=Path('/opt/id-business-v2');current=(base/'current').resolve(strict=True)
assert json.loads((current/'release-manifest.json').read_bytes())['commit']==EXPECTED
def container(service):
 ids=subprocess.check_output(['docker','ps','-q','--filter','label=com.docker.compose.service='+service],text=True).split()
 assert len(ids)==1
 return ids[0]
api,engine=container('api'),container('online-recharge')
credentials=subprocess.run(['docker','exec','-i','-w','/app',api,'node'],input=READ_PROXY,text=True,capture_output=True,timeout=20)
assert credentials.returncode==0 and len(credentials.stdout)<4096
code='const EXPECTED_HASH='+json.dumps(DIAGNOSTIC_SHA)+';'+RUN_COMPARISON
comparison=subprocess.run(['docker','exec','-i','-w','/workspace/engine',engine,'node','-e',code],input=credentials.stdout,text=True,capture_output=True,timeout=100)
credentials=None
assert comparison.returncode==0 and len(comparison.stdout)<20000
report=json.loads(comparison.stdout)
assert report['format']=='proxy-client-comparison-v1' and report['maximumRequests']==5 and report['requestsIssued']<=5 and report['maximumDurationMs']==90000 and report['chatgptRequests']==0
assert (base/'current').resolve()==current and container('online-recharge')==engine
result={'status':'PROXY_CLIENT_COMPARISON_RECORDED','commit':EXPECTED,'comparison':report,'businessActions':0}
'''


def command(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True, timeout=45)


def source(mode, expected):
    assert mode in ('capture', 'compare') and re.fullmatch('[a-f0-9]{40}', expected)
    if mode == 'capture':
        assert expected == PREDECESSOR
        plan = json.loads((HERE / 'online-proxy-client-parent-plan.json').read_bytes())
        assert plan['commit'] == PREDECESSOR
        code = 'PLAN=' + repr(plan) + '\n' + CAPTURE
    else:
        code = ('READ_PROXY=' + repr(READ_PROXY) + '\nRUN_COMPARISON=' + repr(RUN_COMPARISON)
                + '\nDIAGNOSTIC_SHA=' + repr(DIAGNOSTIC_SHA) + '\n' + COMPARE)
    return ('EXPECTED=' + repr(expected) + '\n' + code +
            "\nimport base64,zlib\nprint(json.dumps({'zlibBase64':base64.b64encode(zlib.compress(json.dumps(result).encode())).decode()}))\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('capture', 'compare'))
    parser.add_argument('--expected-current', required=True)
    args = parser.parse_args()
    assert json.loads(command('aws', 'sts', 'get-caller-identity', '--output', 'json'))['Account'] == ACCOUNT
    script = source(args.mode, args.expected_current)
    compile(script, '<finite-readonly>', 'exec')
    output = ROOT / '.deploy' / 'online-proxy-client-observation' / args.mode
    output.mkdir(parents=True, exist_ok=True)
    intent, accepted = output / 'intent.json', output / 'accepted.json'
    assert not intent.exists() and not accepted.exists(), 'ORIGINAL_COMMAND_MUST_BE_RESOLVED'
    params = {'commands': ["python3 - <<'READ_ONLY'\n" + script + '\nREAD_ONLY'], 'executionTimeout': ['180']}
    with intent.open('x') as f:
        json.dump({'mode': args.mode, 'expectedCurrent': args.expected_current,
                   'parametersSha256': hashlib.sha256(json.dumps(params, sort_keys=True).encode()).hexdigest()}, f)
        f.flush(); os.fsync(f.fileno())
    sent = subprocess.run(['aws','--region','ap-northeast-1','ssm','send-command','--instance-ids',INSTANCE,
        '--document-name','AWS-RunShellScript','--parameters',json.dumps(params),'--query','Command.CommandId','--output','text'],
        capture_output=True, text=True, timeout=45, env={**os.environ,'AWS_MAX_ATTEMPTS':'1'})
    assert sent.returncode == 0, 'ACCEPTANCE_UNCONFIRMED'
    ident = sent.stdout.strip()
    assert re.fullmatch('[a-f0-9-]{36}', ident)
    accepted.write_text(json.dumps({'CommandId':ident,'InstanceId':INSTANCE})+'\n')
    for _ in range(42):
        time.sleep(5)
        raw = command('aws','--region','ap-northeast-1','ssm','get-command-invocation','--command-id',ident,'--instance-id',INSTANCE,'--output','json')
        invocation=json.loads(raw)
        if invocation['Status'] in ('Pending','InProgress','Delayed'): continue
        (output/'invocation.json').write_text(raw)
        assert invocation['Status']=='Success' and invocation['ResponseCode']==0 and not invocation.get('StandardErrorContent'), 'READ_ONLY_FAILED'
        envelope=json.loads(invocation['StandardOutputContent'])
        decoder=zlib.decompressobj();body=decoder.decompress(base64.b64decode(envelope['zlibBase64']),128*1024+1)
        assert len(body)<=128*1024 and decoder.eof and not decoder.unused_data
        report=json.loads(body);assert report['businessActions']==0
        (output/'result.json').write_text(json.dumps(report,sort_keys=True,indent=2)+'\n')
        print(json.dumps({'status':report['status'],'businessActions':0}));return
    raise RuntimeError('ORIGINAL_RESULT_PENDING_DO_NOT_REPEAT')


if __name__ == '__main__':
    main()
