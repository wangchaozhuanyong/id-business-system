"""Read-only, bounded runtime evidence after the separately published account successor."""
import base64
import gzip
import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUTPUT = ROOT / '.deploy/mailbox-runtime-inspection'
CURRENT = '13e52ad670c6b6daa94ab2df009aaa8a9d69b97c'
PROOF = 'd48d4ebc5594c27d578be4d61578fc12bb62f34ee313f065c698f60573c5e2bb'


def load(name):
    spec = importlib.util.spec_from_file_location('inspect_' + name.replace('-', '_'), HERE / name)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def execute(*args):
    value = subprocess.run(args, cwd=ROOT, capture_output=True)
    if value.returncode:
        raise RuntimeError('MAILBOX_RUNTIME_PLATFORM_FAILED')
    return value.stdout


REMOTE_PREAMBLE = r"""import fcntl,hashlib,importlib.util,json,os,re,sys
from pathlib import Path
sys.dont_write_bytecode=True
BASE=Path('/opt/id-business-v2')
WORKER='apps/api/src/id-business-v2/auto-registration/worker/'
def need(value,code):
 if not value:raise RuntimeError('MAILBOX_RUNTIME_'+code)
def digest(raw):return hashlib.sha256(raw).hexdigest()
def canonical(value):return digest(json.dumps(value,sort_keys=True,separators=(',',':')).encode())
def load(name):
 p=current/'scripts/production-release'/name
 need(digest(p.read_bytes())==HASHES[name],'EXECUTOR_CHANGED')
 s=importlib.util.spec_from_file_location('runtime_'+name.replace('-','_'),p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
"""

REMOTE_CAPTURE = r'''
try:
 with (BASE/'.deploy.lock').open('r')as lock:
  fcntl.flock(lock,fcntl.LOCK_SH|fcntl.LOCK_NB)
  current=(BASE/'current').resolve();need(current.parent==BASE/'releases','CURRENT_INVALID')
  raw=(current/'release-manifest.json').read_bytes();manifest=json.loads(raw)
  need(manifest['commit']==CURRENT and manifest['scope']=='ACCOUNT_LOGIN_SEARCH_20261016','CURRENT_CHANGED')
  need(digest((current/'account-login-build-proof.json').read_bytes())==PROOF,'SUCCESSOR_PROOF_CHANGED')
  h=load('recharge-record-release.py');d=h.load_utilities(current/'scripts/production-release/remote-deploy.py',HASHES['remote-deploy.py'])
  states=h.snapshot(d,current)
  node="""const f=require('fs'),h=require('crypto');const out={};function scan(prefix,onlyJs=false,flat=false){const rows={};function walk(r=''){for(const n of f.readdirSync(prefix+r).sort()){const p=r+n,s=f.lstatSync(prefix+p);if(s.isSymbolicLink())throw Error('SOURCE_LINK');if(s.isDirectory()){if(!flat)walk(p+'/');}else if(s.isFile()&&(!onlyJs||p.endsWith('.js'))&&(!flat||/\.(py|js|css)$/.test(p)))rows[p]=h.createHash('sha256').update(f.readFileSync(prefix+p)).digest('hex');}}walk();return h.createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(rows).sort().map(k=>[k,rows[k]])))).digest('hex');}out.api=scan('/app/apps/api/dist/',true);out.client=scan('/app/node_modules/.prisma/client/');out.worker=scan('/app/apps/api/src/id-business-v2/auto-registration/worker/',false,true);out.schema=h.createHash('sha256').update(f.readFileSync('/app/apps/api/prisma-mysql/schema.prisma')).digest('hex');console.log(JSON.stringify(out));"""
  inventories=json.loads(d.run('docker','exec',states['api']['containerId'],'node','-e',node))
  prefix='/usr/share/nginx/html/'
  names=d.run('docker','exec',states['admin']['containerId'],'find',prefix,'-type','f').splitlines()
  need(names and all(n.startswith(prefix) and '..'not in Path(n).parts for n in names),'ADMIN_PATH_INVALID')
  lines=d.run('docker','exec',states['admin']['containerId'],'sha256sum',*names).splitlines()
  inventories['admin']=canonical({n.removeprefix(prefix):v for v,n in (line.split('  ',1)for line in lines)})
  database=database_receipt(d,current,CONTRACT)
  sqlite=sqlite_receipt(d,current,CONTRACT)
  result={'status':'MAILBOX_RUNTIME_CAPTURED','current':str(current),'expectedCurrent':CURRENT,'manifestSha256':digest(raw),
   'services':states,'roleSourceCommits':{n:manifest['roleSourceProjections'][n]['commit']for n in ('api','admin','online-recharge')},
   'sourceProjectionSha256':{n:canonical(manifest[n])for n in ('roleSourceProjections','adminSourceProjection')},
   'configurationSha256':{n:digest((current/n).read_bytes())for n in ('.env.aws.production','compose.release.json','docker-compose.aws-mysql.yml')},
   'runtimeConfigurationSha256':{n:h.configuration(d,state)for n,state in states.items()},
   'inventories':inventories,'databaseReceipt':database,'sqlite':sqlite,'businessActions':0}
  need(h.snapshot(d,current)==states and (BASE/'current').resolve()==current and (current/'release-manifest.json').read_bytes()==raw,'CAPTURE_MOVED')
  print(json.dumps(result,sort_keys=True))
except BaseException as error:
 print(json.dumps({'status':'MAILBOX_RUNTIME_CAPTURE_FAILED','errorType':type(error).__name__,'businessActions':0}));sys.exit(1)
'''


def capture_source():
    parent = load('registration-parity-diagnostics-release.py')
    finite = load('proxy-result-identity-release.py')
    original = json.loads((HERE / 'registration-parity-diagnostics-contract.json').read_bytes())
    c = {name: original[name] for name in ('baselineWorkerFiles', 'sqliteReviewPolicy',
         'runtimePythonDependencies', 'accountCount', 'protectedMigrations')}
    c['workerFiles'] = c['baselineWorkerFiles']
    helpers = '\n\n'.join(inspect.getsource(fn) for fn in [parent.sqlite_inspection_source,
        parent.validate_sqlite_receipt, parent.sqlite_receipt, finite.database_receipt])
    hashes = {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest()
              for name in ('recharge-record-release.py', 'remote-deploy.py')}
    return ('CURRENT=' + repr(CURRENT) + '\nPROOF=' + repr(PROOF) + '\nHASHES=' + repr(hashes)
            + '\nCONTRACT=' + repr(c) + '\n' + REMOTE_PREAMBLE + helpers + REMOTE_CAPTURE)


def main():
    assert os.environ['GITHUB_REF']=='refs/heads/main' and os.environ['GITHUB_REPOSITORY']=='wangchaozhuanyong/id-business-system'
    assert os.environ['EXPECTED_CURRENT']==CURRENT and os.environ['GITHUB_SHA']==os.environ['RELEASE_COMMIT']
    latest=json.loads(execute('gh','api','repos/wangchaozhuanyong/id-business-system/git/ref/heads/main'))['object']['sha']
    assert latest==os.environ['RELEASE_COMMIT']
    assert not OUTPUT.exists();OUTPUT.mkdir(parents=True,mode=0o700)
    program=capture_source();packed=base64.b64encode(gzip.compress(program.encode())).decode()
    command="python3 -B - <<'MAILBOX_CAPTURE'\nimport base64,gzip\nexec(compile(gzip.decompress(base64.b64decode("+repr(packed)+")), '<mailbox-readonly-capture>', 'exec'))\nMAILBOX_CAPTURE"
    parameters={'commands':[command],'executionTimeout':['120']}
    value=json.loads(execute('aws','ssm','send-command','--region','ap-northeast-1','--instance-ids','i-05836da38606e633c','--document-name','AWS-RunShellScript','--comment','mailbox-runtime-readonly','--parameters',json.dumps(parameters),'--output','json'))
    command_id=value['Command']['CommandId'];(OUTPUT/'accepted-command.json').write_text(json.dumps({'CommandId':command_id})+'\n')
    for _ in range(24):
        raw=execute('aws','ssm','get-command-invocation','--region','ap-northeast-1','--command-id',command_id,'--instance-id','i-05836da38606e633c','--output','json');value=json.loads(raw)
        if value['Status']in('Pending','InProgress','Delayed'):time.sleep(5);continue
        (OUTPUT/'invocation.json').write_bytes(raw)
        result=json.loads(value['StandardOutputContent'])
        assert value['Status']=='Success' and result['status']=='MAILBOX_RUNTIME_CAPTURED'
        (OUTPUT/'runtime.json').write_text(json.dumps(result,sort_keys=True,indent=2)+'\n')
        print(json.dumps({'status':result['status'],'commit':CURRENT,'commandId':command_id,'businessActions':0}));return
    raise RuntimeError('MAILBOX_RUNTIME_CAPTURE_PENDING')


if __name__=='__main__':main()
