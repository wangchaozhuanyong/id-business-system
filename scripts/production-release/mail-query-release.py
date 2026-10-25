"""Finite mailbox API/Admin publication using the existing lock, backup and SQL fence."""
import datetime
import importlib.util
import json
import re
import traceback
from pathlib import Path
import shutil
import urllib.request

HERE = Path(__file__).resolve().parent
BASE = Path('/opt/id-business-v2')
SCOPE = 'MAIL_QUERY_20261026'
PREFIX = 'mail-query'
CONTRACT_FILE = 'mail-query-contract.json'
CURRENT = 'e317136851edfe3b49c0c44a8deed01b7de62a53'
SOURCE = '2581f4e6a5f01aec692c5856a3aa7a70307a714b'
SOURCE_TREE = '311ce78f5d8930de3e5241efd0fa104bee5a6e82'
PRESERVED = ('mysql', 'caddy', 'media-resolver', 'auto-recharge')


def load(name):
    spec = importlib.util.spec_from_file_location('mail_query_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


H = load('recharge-record-release.py')
sha, canonical = H.digest, lambda value: json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def need(value, code):
    if not value:
        raise RuntimeError('MAIL_QUERY_' + code)


def verify_proof(proof, plan, c, files):
    need(c['scope'] == SCOPE and c['expectedCurrent'] == CURRENT and c['migrationPerformed'] is False
         and type(c['businessActions']) is int and c['businessActions'] == 0, 'CONTRACT_CHANGED')
    need(all(proof.get(n) == plan[n] for n in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt',
         'contractSha256', 'controlSources', 'nativeParentCapture', 'qualitySourceEvidence')), 'PROVENANCE_CHANGED')
    need(proof['scope'] == SCOPE and proof['sources'] == c['sources'] and proof['files'] == files
         and proof['migrationPerformed'] is False and type(proof['businessActions']) is int
         and proof['businessActions'] == 0, 'PAYLOAD_CHANGED')
    need(set(proof['apiModules']) == set(proof['baselineApiModules']) == set(c['apiModules'])
         and proof['baselineApiModules'] == plan['nativeParentCapture']['apiModules']
         and proof['baselineAdminFiles'] == c['adminFiles'], 'BASELINE_NOT_REPRODUCED')
    expected = {'api/modules/' + n: v for n,v in proof['apiModules'].items()}
    expected.update({'admin/html/' + n: v for n,v in proof['adminFiles'].items()})
    expected.update({'source/' + n: v for n,v in c['sources'].items()})
    need(files == expected and sha(canonical(c['sources'])) == c['sourceProjectionSha256'], 'PAYLOAD_SCOPE_CHANGED')


def snapshot(c):
    profile = load('online-profile-lock-release.py')
    prior = json.loads((HERE / 'online-profile-lock-contract.json').read_bytes())
    h, d, p = profile.helpers(prior)
    previous = (BASE / 'current').resolve(strict=True)
    need(previous.parent == BASE / 'releases' and str(previous) == c['parentRelease'], 'CURRENT_PATH_CHANGED')
    parent_files = {'release-manifest.json', 'online-profile-lock-preservation.json',
                    'online-profile-lock-build-proof.json', 'online-checkout-build-proof.json'}
    need(set(c['parentFiles']) == parent_files and all(
         sha((previous / name).read_bytes()) == digest for name,digest in c['parentFiles'].items()), 'PARENT_PROOF_CHANGED')
    manifest = json.loads((previous / 'release-manifest.json').read_bytes())
    receipt = json.loads((previous / 'online-profile-lock-preservation.json').read_bytes())
    need(manifest['commit'] == c['expectedCurrent'] == CURRENT and manifest['status'] == 'DEPLOYED'
         and manifest['profileLockPublication'] == receipt and receipt['commit'] == CURRENT
         and receipt['imagesRebuilt'] is False and receipt['businessActions'] == 0, 'PARENT_IDENTITY_CHANGED')
    states = h.snapshot(d, previous)
    need(states == receipt['after'], 'PARENT_SERVICES_CHANGED')
    h.guards(d, previous, states, prior)
    profile.content(d, states, prior, h, p)
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    captured = {'current':str(previous), 'expectedCurrent':CURRENT,
        'manifestSha256':c['parentFiles']['release-manifest.json'], 'parentFiles':c['parentFiles'],
        'services':states, 'configurationSha256':{name:sha((previous / name).read_bytes())
            for name in ('.env.aws.production','compose.release.json','docker-compose.aws-mysql.yml')},
        'runtimeConfigurationSha256':{name:h.configuration(d,state) for name,state in states.items()}}
    root = '/app/apps/api/dist/'
    lines = d.run('docker', 'exec', states['api']['containerId'], 'sha256sum',
                  *(root + n for n in c['apiModules'])).splitlines()
    modules = {}
    for line in lines:
        digest, name = line.split('  ', 1)
        need(name.startswith(root) and name.removeprefix(root) in c['apiModules'], 'MODULE_PATH_CHANGED')
        modules[name.removeprefix(root)] = digest
    need(set(modules) == set(c['apiModules']) and modules == c['baselineApiModules'], 'MAILBOX_BASELINE_CHANGED')
    captured['businessActions'] = 0
    captured['apiModules'] = modules
    captured['nginxSha256'] = d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum',
                                  '/etc/nginx/conf.d/default.conf').split()[0]
    return captured, prior, h, d, p


def smoke(d, target, before, states, proof, c, prior, h, p, captured):
    need(all(states[n] == before[n] for n in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
    need(all(states[n]['environmentSha256'] == before[n]['environmentSha256'] for n in ('api','admin','online-recharge'))
         and states['online-recharge']['image'] == before['online-recharge']['image'], 'ENVIRONMENT_OR_ENGINE_CHANGED')
    p.read_hashes(d, states['api']['containerId'], '/app/apps/api/dist/', proof['apiModules'])
    p.read_hashes(d, states['api']['containerId'], '/app/apps/api/dist/', prior['apiFiles'])
    p.read_hashes(d, states['admin']['containerId'], '/usr/share/nginx/html/', proof['adminFiles'])
    load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], prior['engineFiles'])
    need(d.run('docker','exec',states['admin']['containerId'],'sha256sum','/etc/nginx/conf.d/default.conf').split()[0]
         == captured['nginxSha256'], 'NGINX_CHANGED')
    equivalence = load('online-unpaid-validation-release.py').configuration_equivalence
    need(all(equivalence(h,d,state,captured['runtimeConfigurationSha256'][role])['matched']
         for role,state in states.items()), 'RUNTIME_CONFIGURATION_CHANGED')
    code = """const {syncVendureMailboxScope}=require('/app/apps/api/dist/id-business-v2/workspace/vendure-mailbox-list.js');
(async()=>{const ids=[];const client={primaryAccounts:async()=>[{id:'fixture-primary',status:'ACTIVE'},{id:'fixture-disabled',status:'DISABLED'}],virtualEmails:async()=>[{id:'fixture-alias',primaryAccountId:'fixture-primary'}]};
await syncVendureMailboxScope(client,{virtualEmailId:'fixture-alias'},async id=>{ids.push(id);return {success:true};});
let invalid=false,failed=false;try{await syncVendureMailboxScope(client,{virtualEmailId:'missing'},async()=>{throw Error('unexpected');});}catch(e){invalid=e.getStatus?.()===400;}
try{await syncVendureMailboxScope(client,{},async()=>({success:false}));}catch(e){failed=e.getStatus?.()===503;}
console.log(JSON.stringify({selected:ids.length===1&&ids[0]==='fixture-primary',invalid,failed,businessActions:0}));})().catch(()=>process.exit(1));"""
    need(json.loads(d.run('docker','exec',states['api']['containerId'],'node','-e',code))
         == {'selected':True,'invalid':True,'failed':True,'businessActions':0}, 'MAILBOX_RUNTIME_SMOKE_FAILED')
    h.engine_idle(d, states['online-recharge'], prior, wait_connected=True)


def release(plan, c):
    need(sha((HERE / CONTRACT_FILE).read_bytes()) == plan['contractSha256']
         and all(sha((HERE / n).read_bytes()) == v for n,v in plan['controlSources'].items()), 'CONTROL_CHANGED')
    availability = load('recharge-availability-release.py')
    with (BASE / '.deploy.lock').open('a') as lock:
        availability.acquire_release_lock(lock)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve(strict=True)
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            receipt = json.loads((target / 'mail-query-preservation.json').read_bytes())
            raw = (target / 'mail-query-build-proof.json').read_bytes()
            need(manifest['commit'] == receipt['commit'] == plan['commit'] and manifest['scope'] == SCOPE
                 and manifest.get('sourceTree') == plan['tree']
                 and sha(raw) == plan['buildProofSha256'], 'READBACK_CHANGED')
            profile = load('online-profile-lock-release.py')
            prior = json.loads((HERE / 'online-profile-lock-contract.json').read_bytes())
            h,d,p = profile.helpers(prior)
            states = h.snapshot(d,target)
            need(states == receipt['after'], 'READBACK_SERVICES_CHANGED')
            smoke(d,target,receipt['before'],states,json.loads(raw),c,prior,h,p,plan['nativeParentCapture'])
            h.guards(d,target,states,prior)
            return {'status':'MAIL_QUERY_INDEPENDENT_READBACK_VERIFIED','commit':plan['commit'],'businessActions':0}
        captured,prior,h,d,p = snapshot(c)
        if plan['mode'] == 'parent':
            return {**captured,'businessActions':0}
        need(captured == plan['nativeParentCapture'], 'PARENT_MOVED')
        if plan['mode'] == 'preflight':
            return {'status':'MAIL_QUERY_PREFLIGHT_VERIFIED','businessActions':0}
        need(plan['mode'] == 'release', 'MODE_INVALID')
        stage = BASE / '.staging' / ('mail-query-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        url = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/mail-query-' + plan['commit'] + '/mail-query-artifact.tar.gz'
        need(plan['artifactUrl'] == url, 'ARTIFACT_LOCATION')
        with urllib.request.urlopen(url, timeout=60) as response:
            bundle = response.read(24 * 1024**2 + 1)
        need(sha(bundle) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        payload = h.safe_archive(bundle,stage/'content')
        raw_proof = (payload/'build-proof.json').read_bytes()
        need(sha(raw_proof) == plan['buildProofSha256'], 'PROOF_CHANGED')
        proof = json.loads(raw_proof)
        files = h.file_inventory(payload);files.pop('build-proof.json')
        verify_proof(proof,plan,c,files)
        before = captured['services'];previous = Path(captured['current'])
        images = {}
        for role,copy in (('api','COPY modules/ /app/apps/api/dist/'),('admin','COPY html/ /usr/share/nginx/html/')):
            context=payload/role
            availability.normalize_image_context(context)
            reference='id-business-v2-mail-query:'+plan['commit']+'-'+plan['workflowRunId']+'-'+role
            original=json.loads(d.run('docker','image','inspect',before[role]['image']))[0]
            (context/'Dockerfile').write_text('FROM '+h.base_image_reference(d,before[role])+'\n'+copy+'\nLABEL org.opencontainers.image.revision="'+plan['commit']+'" id-business-v2.recharge-record-build-proof-sha256="'+plan['buildProofSha256']+'"\n')
            h.build_image(d,context,reference,role,before[role],stage)
            built=json.loads(d.run('docker','image','inspect',reference))[0]
            p.verify_image(original,built,plan)
            images[role]={'reference':reference,'imageId':built['Id']}
        need(snapshot(c)[0] == captured, 'PARENT_MOVED')
        backup=h.fresh_scoped_backup(d,previous,plan,normalizer_path=Path(prior['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target=BASE/'releases'/(stamp+'-'+plan['commit'][:12]+'-mail-query')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(previous,target,symlinks=True)
        for name in c['sources']:
            path=target/name;need(not path.is_symlink() and path.resolve().is_relative_to(target),'SOURCE_PATH')
            path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes((payload/'source'/name).read_bytes())
        for name in plan['controlSources']:
            path=target/'scripts/production-release'/name
            need(not path.is_symlink(),'CONTROL_PATH')
            path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes((HERE/name).read_bytes())
        override=json.loads((target/'compose.release.json').read_bytes())
        for role in images:override['services'][role]['image']=images[role]['reference']
        (target/'compose.release.json').write_text(json.dumps(override,sort_keys=True,indent=2)+'\n')
        need(snapshot(c)[0] == captured, 'PARENT_MOVED')
        finite=load('proxy-result-identity-release.py')
        retired=load('online-query-network-release.py');retired.SCOPE=SCOPE
        finite.claim_markers=retired.claim_retired_markers
        marker=finite.claim_markers(d,before,plan)
        fence=finite.sql_fence_class(prior)(d,previous)
        journal=stage/'switch-state.json'
        journal.write_text(json.dumps({'status':'SWITCH_STARTED','target':str(target)})+'\n')
        try:
            fence.acquire();fence.check_idle()
            d.compose(previous,'stop','online-recharge',timeout=90)
            fence.check_idle()
            d.compose(previous,'stop','api',timeout=90)
            fence.check_idle();fence.close()
            d.compose(target,'up','-d','--no-deps','--no-build','--pull','never','api','admin',timeout=180)
            for role in ('api','admin'):d.wait_healthy(target,role)
            d.compose(target,'up','-d','--no-deps','--no-build','--pull','never','--force-recreate','online-recharge',timeout=180)
            d.wait_healthy(target,'online-recharge')
            after=h.snapshot(d,target)
            need(all(after[n]['image']==images[n]['imageId'] for n in images),'IMAGE_CHANGED')
            smoke(d,target,before,after,proof,c,prior,h,p,captured)
        except BaseException:
            journal.write_text(json.dumps({'status':'NEEDS_FORWARD_DIAGNOSIS','target':str(target),'rollbackPerformed':False})+'\n')
            raise
        finally:
            fence.close()
        finite.release_markers(marker);h.guards(d,target,after,prior)
        receipt={'commit':plan['commit'],'before':before,'after':after,'images':images,'backup':backup,'businessActions':0}
        (target/'mail-query-preservation.json').write_text(json.dumps(receipt,sort_keys=True,indent=2)+'\n')
        (target/'mail-query-build-proof.json').write_bytes(raw_proof)
        manifest=json.loads((previous/'release-manifest.json').read_bytes())
        manifest.update(commit=plan['commit'],sourceTree=plan['tree'],scope=SCOPE,status='DEPLOYED',sourceBranch='main',
            previousCommit=CURRENT,previousRelease=str(previous),servicesUpdated=['api','admin'],servicesRebound=['online-recharge'],
            newMigrations=[],migrationPerformed=False,paymentActions=0,compiledArtifact={'url':url,'sha256':plan['artifactSha256']})
        for role in images:
            manifest['images'][role]={'reference':images[role]['reference'],'digest':images[role]['imageId'],'sourceCommit':plan['commit']}
            projections=manifest.setdefault('roleSourceProjections',{})
            projections[role]={'kind':SCOPE,'commit':plan['commit'],'parentProjection':projections.get(role),
                'buildProofSha256':plan['buildProofSha256'],'runtimeFiles':proof['apiModules' if role=='api' else 'adminFiles']}
        (target/'release-manifest.json').write_text(json.dumps(manifest,sort_keys=True,indent=2)+'\n')
        d.point_current(target,stamp+'-mail-query')
        journal.write_text(json.dumps({'status':'DEPLOYED','commit':plan['commit']})+'\n')
        return {'status':'MAIL_QUERY_DEPLOYED','commit':plan['commit'],'businessActions':0}


def failure_report(error, plan):
    code = str(error) if re.fullmatch('[A-Z][A-Z0-9_]{1,120}', str(error)) else 'MAIL_QUERY_UNCONFIRMED'
    frames = [{'file':Path(f.filename).name,'line':f.lineno,'function':f.name}
              for f in traceback.extract_tb(error.__traceback__)[-5:]]
    return {'status':'FAILED','mode':plan['mode'],'code':code,'sourceFrames':frames,
            'errorClass':type(error).__name__,'businessActions':0}
