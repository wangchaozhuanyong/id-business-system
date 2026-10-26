"""Reproduce the deployed mailbox build, then compile the two reviewed Admin sources."""
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
CURRENT = '31f1b57902b3f442b15aa703b0ff1911bbb15c3a'
SOURCES = tuple('apps/admin/src/v2/features/auto-recharge/' + n for n in (
    'VendureMailboxManager.vue', 'vendure-mailbox-refresh.ts'))


def need(value, code):
    if not value:
        raise RuntimeError('MAIL_QUERY_' + code)


def load(path):
    spec = importlib.util.spec_from_file_location(path.stem.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build(plan, out):
    need(not out.exists(), 'BUILD_OUTPUT_EXISTS')
    out.mkdir(parents=True, mode=0o700)
    c=json.loads((HERE/'mail-query-contract.json').read_bytes())
    h=load(HERE/'recharge-record-release.py')
    binding=c['parentNativeArtifact']
    with urllib.request.urlopen(binding['url'],timeout=60) as response:raw=response.read(96*1024**2+1)
    need(h.digest(raw)==binding['sha256'],'PUBLISHED_ARTIFACT_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:proof_raw=archive.extractfile('payload/build-proof.json').read()
    need(h.digest(proof_raw)==binding['buildProofSha256'],'PUBLISHED_PROOF_CHANGED')
    proof=json.loads(proof_raw)
    need(proof['commit']==CURRENT and proof['workflowRunId']==binding['workflowRunId'],'PUBLISHED_IDENTITY_CHANGED')
    published=ROOT/'.codex-worktrees/mail-query-parent-source31'
    need(not published.exists(),'BASE_SOURCE_EXISTS')
    subprocess.run(['git','worktree','add','--detach',str(published),CURRENT],cwd=ROOT,check=True)
    recipe=load(published/'scripts/production-release/mail-query-build.py')
    contexts={}
    original=recipe.overlay
    def capture(*args,**kwargs):
        result=original(*args,**kwargs)
        contexts.update(kwargs)
        return result
    recipe.overlay=capture
    reproduced=recipe.build({'commit':CURRENT},out/'published31')
    need(reproduced['adminFiles']==proof['adminFiles']==c['adminFiles']
         and reproduced['apiModules']==proof['apiModules']==c['baselineApiModules'],'PUBLISHED_RUNTIME_NOT_REPRODUCED')
    admin=contexts['admin_context']
    for name in SOURCES:
        destination=admin/name
        original_source=subprocess.run(['git','show',CURRENT+':'+name],cwd=ROOT,capture_output=True)
        if name.endswith('vendure-mailbox-refresh.ts'):
            need(original_source.returncode!=0 and not destination.exists(),'NEW_HELPER_ALREADY_EXISTS')
        else:
            need(original_source.returncode==0 and destination.read_bytes()==original_source.stdout,'UNREVIEWED_BASE_SOURCE')
        raw=(ROOT/name).read_bytes()
        need(h.digest(raw)==c['sources'][name],'REVIEWED_SOURCE_CHANGED')
        destination.write_bytes(raw)
    env={**os.environ,'NODE_ENV':'production','V2_BUILD_ID':'v2-'+plan['commit']}
    subprocess.run(['npm','run','build','--workspace','apps/admin'],cwd=admin,env=env,check=True)
    payload=out/'payload'
    shutil.copytree(admin/'apps/admin/dist',payload/'admin/html')
    for name in SOURCES:
        target=payload/'source'/name
        target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(ROOT/name,target)
    result={**plan,'scope':'MAIL_QUERY_20261026','sources':c['sources'],
            'baselineApiModules':proof['apiModules'],'apiModules':proof['apiModules'],
            'baselineAdminFiles':proof['adminFiles'],'adminFiles':h.file_inventory(admin/'apps/admin/dist'),
            'files':h.file_inventory(payload),'migrationPerformed':False,'businessActions':0}
    (payload/'build-proof.json').write_text(json.dumps(result,sort_keys=True,indent=2)+'\n')
    return result
