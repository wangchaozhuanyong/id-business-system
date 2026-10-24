"""Finite unpaid validation publication, reusing the accepted three-component switch."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import urllib.request
HERE=Path(__file__).resolve().parent
PREFIX='online-unpaid-validation'
SCOPE='ONLINE_UNPAID_VALIDATION_20261024'
CURRENT='a046d8413e3cb6c3edd6429dbdb922593dc32064'
SOURCE='a00a3e0edeb9e3c83055103333ee35772bc0b5c6'
CONTRACT_FILE=PREFIX+'-contract.json'
ENGINE='apps/api/src/id-business-v2/online-recharge/engine/'
UPDATED=('api','admin','online-recharge')
PRESERVED=('mysql','caddy','media-resolver','auto-recharge')
SERVICES=(*UPDATED,*PRESERVED)
def need(v,code):
 if not v:raise RuntimeError('ONLINE_UNPAID_'+code)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':')).encode()
def load(name):
 s=importlib.util.spec_from_file_location('unpaid_'+name.replace('-','_'),HERE/name);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
def validate_contract(c):
 need(c['scope']==SCOPE and c['expectedCurrent']==CURRENT and c['sourceReviewCommit']==SOURCE,'IDENTITY')
 need(c['awsTargetAccount']=='098208446664' and c['awsTargetInstance']=='i-0838cebf64f0e2a89','AWS_TARGET_CHANGED')
 need(c['updatedServices']==list(UPDATED) and c['preservedServices']==list(PRESERVED) and c['migrationPerformed'] is False and c['businessActions']==0,'SIDE_EFFECT_SCOPE')
 need(sha(canonical(c['sources']))=='68fd5094a1589880e469d216eedcb5ea7a08ac2ff1a9e30063b10c610cde0a4a','SOURCE_HASHES_CHANGED')
 need(len(c['sources'])==37 and all(n.startswith(('apps/admin/src/v2/features/online-recharge/','apps/api/src/id-business-v2/online-recharge/','docs/')) and '..' not in Path(n).parts and re.fullmatch('[a-f0-9]{64}',v) for n,v in c['sources'].items()),'SOURCE_SCOPE')
 need(c['apiModules']==['id-business-v2/online-recharge/persistence/'+n+'.js' for n in ('artifacts.repository','tasks.repository','worker.repository')],'MODULE_SCOPE')
 need(set(c.get('apiDeclarationOnly',{}))=={'id-business-v2/online-recharge/'+n+'.d.ts' for n in ('artifacts.service','public.controller','tasks.service')} and all(re.fullmatch('[a-f0-9]{64}',v) for v in c['apiDeclarationOnly'].values()),'DECLARATION_SCOPE')
 need(set(c['beforeEngineFiles'])<=set(c['afterEngineFiles']) and all(c['afterEngineFiles'].get(n)==v for n,v in c['beforeEngineFiles'].items() if ENGINE+n not in c['sources']),'ENGINE_SCOPE')
 need({ENGINE+n:v for n,v in c['afterEngineFiles'].items() if c['beforeEngineFiles'].get(n)!=v}=={n:v for n,v in c['sources'].items() if n.startswith(ENGINE)},'ENGINE_DELTA')
 need(c['sqlFenceHelperSha256']=='50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925','FENCE_CHANGED')
def verify_quality(q,commit,tree):
 need(q.get('commit')==commit and q.get('tree')==tree and isinstance(q.get('pullRequest'),int) and q['pullRequest']>=697 and q.get('sourceReviewCommit')==SOURCE and re.fullmatch('[a-f0-9]{64}',q.get('sourceReceiptSha256','')),'QUALITY_REQUIRED')
 if q['pullRequest']!=697:
  need(q.get('sourceVerification')==json.loads((HERE/CONTRACT_FILE).read_bytes())['sourceQuality'],'SOURCE_QA_BINDING_REQUIRED')
def verify_proof(proof,plan,c,files):
 validate_contract(c);verify_quality(proof['qualitySourceEvidence'],plan['commit'],plan['tree'])
 need(proof.get('nativeParentCapture')==plan.get('nativeParentCapture') and proof['nativeParentCapture']['manifestSha256']==c['manifestSha256'],'PARENT_CHANGED')
 core=load('online-checkout-release.py');core.SCOPE=SCOPE;core.verify_proof(proof,plan,c,files)
def release(plan,c):
 validate_contract(c)
 if plan['mode']=='observe':return observe_target(c)
 if plan['mode']=='parent':
  core=load('online-checkout-release.py');h=load('recharge-record-release.py');h.SERVICES=SERVICES
  retired=load('online-query-network-release.py');h.guards=lambda d,directory,states,selected:retired.retired_guards(d,directory,states,selected,h)
  d=h.load_utilities(HERE/'remote-deploy.py',c['controlPins']['remote-deploy.py'])
  core.baseline(d,c,h)
  return {'status':'ONLINE_UNPAID_PARENT_VERIFIED','manifestSha256':c['manifestSha256'],'businessActions':0}
 core=load('online-checkout-release.py');core.SCOPE=SCOPE;core.CONTRACT_FILE=CONTRACT_FILE;core.UPDATED=UPDATED;core.PRESERVED=PRESERVED
 core.verify_proof=verify_proof
 original=core.load
 def helpers(name):
  m=original(name)
  retired=load('online-query-network-release.py')
  if name=='recharge-record-release.py':
   m.SERVICES=SERVICES
   m.guards=lambda d,directory,states,selected:retired.retired_guards(d,directory,states,selected,m)
  elif name=='proxy-result-identity-release.py':m.claim_markers=retired.claim_retired_markers
  return m
 core.load=helpers
 def artifact(selected):
  expected='https://github.com/wangchaozhuanyong/id-business-system/releases/download/'+PREFIX+'-'+selected['commit']+'/'+PREFIX+'-artifact.tar.gz'
  need(selected['artifactUrl']==expected,'ARTIFACT_LOCATION')
  with urllib.request.urlopen(expected,timeout=60) as r:raw=r.read(24*1024**2+1)
  need(0<len(raw)<=24*1024**2 and sha(raw)==selected['artifactSha256'],'ARTIFACT_CHANGED');return raw
 core.download_artifact=artifact
 result=core.release(plan,c)
 result['status']=result['status'].replace('ONLINE_CHECKOUT_',SCOPE+'_')
 return result

def observe_target(c):
    current=(Path('/opt/id-business-v2')/'current').resolve(strict=True)
    need(current.parent==Path('/opt/id-business-v2/releases'),'TARGET_PATH_CHANGED')
    if c.get('acceptedSwitch'):return observe_accepted_switch(c)
    h=load('recharge-record-release.py');h.SERVICES=SERVICES
    d=load('remote-deploy.py');retired=load('online-query-network-release.py')
    states=h.snapshot(d,current)
    retired.retired_guards(d,current,states,c,h)
    load('proxy-result-identity-release.py').engine_content(d,states['online-recharge'],c['beforeEngineFiles'])
    live=load('recharge-checkout-release.py').admin_inventory(d,states['admin'])
    admin=json.loads((current/'bitbrowser-history-build-proof.json').read_bytes())['adminFiles']
    need(all(live.get(n)==v for n,v in admin.items()),'ADMIN_PROOF_CHANGED')
    before_api={}
    for name in c['apiModules']:
        for ext in ('.js','.js.map','.d.ts'):
            path=name.removesuffix('.js')+ext
            before_api[path.removeprefix('id-business-v2/online-recharge/')]=d.run('docker','exec',states['api']['containerId'],'sha256sum','/app/apps/api/dist/'+path).split()[0]
    legacy=json.loads((current/'scripts/production-release/online-country-interaction-contract.json').read_bytes())
    normalizer=legacy['parentPlan']['nativeParentCapture']['baseline']['backupNormalizerPath']
    env=json.loads(d.run('docker','inspect',states['api']['containerId']))[0]['Config']['Env']
    public_url=next(v.split('=',1)[1] for v in env if v.startswith('APP_PUBLIC_URL='))
    raw=(current/'release-manifest.json').read_bytes()
    return {'status':'ONLINE_UNPAID_TARGET_OBSERVED','publicUrl':public_url,
        'current':str(current),'expectedCurrent':json.loads(raw)['commit'],'manifestSha256':sha(raw),
        'services':states,'configurationSha256':{n:sha((current/n).read_bytes()) for n in ('.env.aws.production','compose.release.json','docker-compose.aws-mysql.yml')},
        'runtimeConfigurationSha256':{n:h.configuration(d,state) for n,state in states.items()},
        'beforeApiOnlineFiles':before_api,'baselineAdminFilesSha256':h.fingerprint(admin),
        'nginxSha256':d.run('docker','exec',states['admin']['containerId'],'sha256sum','/etc/nginx/conf.d/default.conf').split()[0],
        'backupNormalizerPath':normalizer,'backupNormalizerExists':Path(normalizer).is_file(),
        'publishedOverlays':[{'proofFile':'online-country-interaction-build-proof.json','proofSha256':sha((current/'online-country-interaction-build-proof.json').read_bytes())}],
        'businessActions':0,'migrationPerformed':False}

def failure_report(error,plan):
    import traceback
    code=str(error)
    if not re.fullmatch(r'(?:ONLINE_UNPAID|ONLINE_CHECKOUT|RECHARGE_RECORD|RECHARGE_AVAILABILITY|PROXY_RESULT_IDENTITY|ONLINE_QUERY_NETWORK)_[A-Z0-9_]{1,110}',code):code='ONLINE_UNPAID_REMOTE_FAILED'
    frames=[{'file':Path(f.filename).name,'function':f.name,'line':f.lineno}
        for f in traceback.extract_tb(error.__traceback__) if Path(f.filename).name in plan['controlSources']]
    return {'status':'FAILED','code':code,'exceptionType':type(error).__name__,'mode':plan['mode'],'frames':frames[-8:],'businessActions':0}


def configuration_equivalence(h,d,state,expected):
    import itertools,copy
    fingerprint=h.fingerprint
    try:
        h.fingerprint=lambda v:v
        model=h.configuration(d,state)
    finally:h.fingerprint=fingerprint
    binds=model['HostConfig'].get('Binds')
    orders=list(itertools.permutations(binds)) if isinstance(binds,list) and 1<len(binds)<=5 else [binds]
    fields=[n for n in ('Dns','DnsOptions','DnsSearch') if n in model['HostConfig'] and model['HostConfig'][n] in (None,[])]
    for order in orders:
        for values in itertools.product((None,[]),repeat=len(fields)):
            candidate=copy.deepcopy(model);changes=[]
            if binds is not None:candidate['HostConfig']['Binds']=list(order)
            for name,value in zip(fields,values):
                if type(candidate['HostConfig'][name]) is not type(value):changes.append('HostConfig.'+name)
                candidate['HostConfig'][name]=copy.deepcopy(value)
            if fingerprint(candidate)==expected:return {'exact':fingerprint(model)==expected,'matched':True,'representationOnly':changes,'bindOrderOnly':tuple(order)!=tuple(binds) if isinstance(binds,list) else False}
    return {'exact':False,'matched':False,'representationOnly':[],'bindOrderOnly':False}


def observe_accepted_switch(c):
    accepted=c['acceptedSwitch'];plan=accepted['plan'];base=Path('/opt/id-business-v2')
    need(sha(canonical(plan))==accepted['planSha256'] and plan['commit']=='9bf179b2c6dbf643404cf083171f7d3fee88944e' and plan['workflowRunId']=='40103226091','ACCEPTED_IDENTITY')
    stage=base/'.staging'/('online-checkout-'+plan['commit']+'-'+plan['workflowRunId'])
    journal=json.loads((stage/'switch-state.json').read_bytes())
    need(journal['status']=='SWITCH_FAILED' and journal['previous']==c['current'] and (base/'current').resolve()==Path(c['current']),'ACCEPTED_JOURNAL_CHANGED')
    target=Path(journal['target']);need(target.parent==base/'releases' and target.name.endswith(plan['commit'][:12]+'-online-checkout'),'ACCEPTED_TARGET_CHANGED')
    need(sha((stage/'content/payload/build-proof.json').read_bytes())==plan['buildProofSha256'],'ACCEPTED_PROOF_CHANGED')
    h=load('recharge-record-release.py');h.SERVICES=SERVICES;d=load('remote-deploy.py')
    states=h.snapshot(d,target)
    models={role:configuration_equivalence(h,d,state,c['runtimeConfigurationSha256'][role]) for role,state in states.items()}
    return {'status':'ONLINE_UNPAID_ACCEPTED_SWITCH_OBSERVED','current':str((base/'current').resolve()),'target':str(target),'journalStatus':journal['status'],'services':states,'configuration':models,'allConfigurationMatched':all(v['matched'] for v in models.values()),'businessActions':0,'containersRecreated':False}
