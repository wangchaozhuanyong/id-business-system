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
 need(c['updatedServices']==list(UPDATED) and c['preservedServices']==list(PRESERVED) and c['migrationPerformed'] is False and c['businessActions']==0,'SIDE_EFFECT_SCOPE')
 need(sha(canonical(c['sources']))=='68fd5094a1589880e469d216eedcb5ea7a08ac2ff1a9e30063b10c610cde0a4a','SOURCE_HASHES_CHANGED')
 need(len(c['sources'])==37 and all(n.startswith(('apps/admin/src/v2/features/online-recharge/','apps/api/src/id-business-v2/online-recharge/','docs/')) and '..' not in Path(n).parts and re.fullmatch('[a-f0-9]{64}',v) for n,v in c['sources'].items()),'SOURCE_SCOPE')
 need(c['apiModules']==['id-business-v2/online-recharge/persistence/'+n+'.js' for n in ('artifacts.repository','tasks.repository','worker.repository')],'MODULE_SCOPE')
 need(set(c['beforeEngineFiles'])<=set(c['afterEngineFiles']) and all(c['afterEngineFiles'].get(n)==v for n,v in c['beforeEngineFiles'].items() if ENGINE+n not in c['sources']),'ENGINE_SCOPE')
 need({ENGINE+n:v for n,v in c['afterEngineFiles'].items() if c['beforeEngineFiles'].get(n)!=v}=={n:v for n,v in c['sources'].items() if n.startswith(ENGINE)},'ENGINE_DELTA')
 need(c['sqlFenceHelperSha256']=='50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925','FENCE_CHANGED')
def verify_quality(q,commit,tree):
 need(q.get('commit')==commit and q.get('tree')==tree and q.get('pullRequest')==697 and q.get('sourceReviewCommit')==SOURCE and re.fullmatch('[a-f0-9]{64}',q.get('sourceReceiptSha256','')),'QUALITY_REQUIRED')
def verify_proof(proof,plan,c,files):
 validate_contract(c);verify_quality(proof['qualitySourceEvidence'],plan['commit'],plan['tree'])
 need(proof.get('nativeParentCapture')==plan.get('nativeParentCapture') and proof['nativeParentCapture']['manifestSha256']==c['manifestSha256'],'PARENT_CHANGED')
 core=load('online-checkout-release.py');core.SCOPE=SCOPE;core.verify_proof(proof,plan,c,files)
def release(plan,c):
 validate_contract(c)
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
