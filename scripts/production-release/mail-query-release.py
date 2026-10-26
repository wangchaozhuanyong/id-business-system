"""Finite Admin-only mailbox publication; API and business services remain untouched."""
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
CURRENT = '31f1b57902b3f442b15aa703b0ff1911bbb15c3a'
BILLING_CURRENT = '21f63083dd8044726811f6d055b3da675ced31d7'
SOURCE = '937926725c2cf357e8ed3238c3b78a173a8f082b'
SOURCE_TREE = '7bed2fcb118dcf03eb97331e8732c46f3ef2ec45'
PRESERVED = ('api', 'online-recharge', 'mysql', 'caddy', 'media-resolver', 'auto-recharge')


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
         and proof['baselineAdminFiles'] == c['adminFiles']
         and proof['apiModules'] == proof['baselineApiModules'] == c['baselineApiModules'], 'BASELINE_NOT_REPRODUCED')
    expected = {'admin/html/' + n: v for n,v in proof['adminFiles'].items()}
    expected.update({'source/' + n: v for n,v in c['sources'].items()})
    need(files == expected and sha(canonical(c['sources'])) == c['sourceProjectionSha256'], 'PAYLOAD_SCOPE_CHANGED')


def verify_availability(c, states, original):
    binding=c.get('availabilityRecovery')
    if states==original and binding is None:return None
    need(type(binding) is dict,'PARENT_SERVICES_CHANGED')
    path=Path(binding['path'])
    need(path.parent.resolve()==(BASE/'.staging').resolve() and not path.is_symlink()
         and re.fullmatch('mail-query-original-availability-[1-9][0-9]*[.]json',path.name), 'RECOVERY_PATH_CHANGED')
    raw=path.read_bytes();need(sha(raw)==binding['sha256'],'RECOVERY_PROOF_CHANGED')
    recovery=json.loads(raw)
    need(recovery['status']=='ORIGINAL_SERVICE_AVAILABILITY_RESTORED' and recovery['commit']==CURRENT
         and recovery['manifestSha256']==c['parentFiles']['release-manifest.json']
         and recovery['before']==original and recovery['after']==states
         and recovery['imagesRebuilt'] is False and recovery['migrationPerformed'] is False
         and recovery['versionRolledBack'] is False and type(recovery['businessActions']) is int
         and recovery['businessActions']==0,'RECOVERY_IDENTITY_CHANGED')
    need(set(states)==set(original),'RECOVERY_SERVICES_CHANGED')
    for role,state in states.items():
        if role in ('api','online-recharge'):
            need({k:v for k,v in state.items() if k!='startedAtSha256'}==
                 {k:v for k,v in original[role].items() if k!='startedAtSha256'}
                 and state['status']=='running' and state['health']=='healthy','RECOVERY_SERVICE_CHANGED')
        else:need(state==original[role],'RECOVERY_PRESERVED_SERVICE_CHANGED')
    return binding['sha256']


def published_billing(directory, c):
    raw = (directory / 'recharge-plan-billing-build-proof.json').read_bytes()
    need(sha(raw) == c['billingProofSha256'], 'BILLING_PROOF_CHANGED')
    proof = json.loads(raw)
    need(proof['commit'] == BILLING_CURRENT and proof['scope'] == 'RECHARGE_PLAN_BILLING_20261026', 'BILLING_IDENTITY_CHANGED')
    controls = directory / 'scripts/production-release'
    for name in ('recharge-plan-billing-release.py', 'recharge-plan-billing-contract.json'):
        need(sha((controls / name).read_bytes()) == proof['controlSources'][name], 'BILLING_CONTROL_CHANGED')
    spec = importlib.util.spec_from_file_location('mail_query_published_billing', controls / 'recharge-plan-billing-release.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    contract_raw = (controls / 'recharge-plan-billing-contract.json').read_bytes()
    contract = json.loads(contract_raw)
    need(sha(contract_raw) == proof['contractSha256'] and contract['sources'] == proof['sources'], 'BILLING_CONTRACT_CHANGED')
    return module, contract, proof


def snapshot(c):
    profile = load('online-profile-lock-release.py')
    prior = json.loads((HERE / 'online-profile-lock-contract.json').read_bytes())
    h, d, p = profile.helpers(prior)
    previous = (BASE / 'current').resolve(strict=True)
    need(previous.parent == BASE / 'releases' and str(previous) == c['parentRelease'], 'CURRENT_PATH_CHANGED')
    parent_files = {'release-manifest.json', 'mail-query-preservation.json', 'mail-query-build-proof.json'}
    need(set(c['parentFiles']) == parent_files and all(
         sha((previous / name).read_bytes()) == digest for name,digest in c['parentFiles'].items()), 'PARENT_PROOF_CHANGED')
    manifest = json.loads((previous / 'release-manifest.json').read_bytes())
    receipt = json.loads((previous / 'mail-query-preservation.json').read_bytes())
    need(manifest['commit'] == c['expectedCurrent'] == CURRENT and manifest['status'] == 'DEPLOYED'
         and manifest['scope'] == SCOPE
         and manifest['actualDeployment'] == receipt and receipt['commit'] == CURRENT
         and type(receipt['businessActions']) is int and receipt['businessActions'] == 0, 'PARENT_IDENTITY_CHANGED')
    states = h.snapshot(d, previous)
    need(states == receipt['after'], 'PARENT_SERVICES_CHANGED')
    parent_proof=json.loads((previous/'mail-query-build-proof.json').read_bytes())
    need(parent_proof['commit']==CURRENT and parent_proof['apiModules']==c['baselineApiModules']
         and parent_proof['adminFiles']==c['adminFiles'], 'PARENT_RUNTIME_CHANGED')
    smoke(d,previous,states,states,parent_proof,c,prior,h,p,parent_proof['nativeParentCapture'])
    h.guards(d,previous,states,prior)
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
    billing, billing_contract, billing_proof = published_billing(target, c)
    billing.verify_files(d, states['api']['containerId'], '/app/apps/api/dist/', billing_proof['apiModules'])
    billing.verify_files(d, states['api']['containerId'], '/app/node_modules/.prisma/client/', billing_proof['prismaClientFiles'])
    billing.verify_db(billing.db_state(d, target), billing_contract, True)
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
                 and all(manifest.get(n) == plan['commit'] for n in ('applicationCommit','controlCommit'))
                 and manifest.get('version') == 'v2-'+plan['commit']
                 and manifest.get('actualDeployment') == receipt
                 and manifest.get('sourceTree') == plan['tree']
                 and manifest.get('buildProofSha256') == sha(raw) == plan['buildProofSha256'], 'READBACK_CHANGED')
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
        for role,copy in (('admin','COPY html/ /usr/share/nginx/html/'),):
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
        journal=stage/'switch-state.json'
        journal.write_text(json.dumps({'status':'SWITCH_STARTED','target':str(target)})+'\n')
        try:
            d.compose(target,'up','-d','--no-deps','--no-build','--pull','never','admin',timeout=180)
            d.wait_healthy(target,'admin')
            after=h.snapshot(d,target)
            need(after['admin']['image']==images['admin']['imageId'],'IMAGE_CHANGED')
            smoke(d,target,before,after,proof,c,prior,h,p,captured)
            h.guards(d,target,after,prior)
        except BaseException:
            journal.write_text(json.dumps({'status':'NEEDS_FORWARD_DIAGNOSIS','target':str(target),'rollbackPerformed':False})+'\n')
            raise
        receipt={'commit':plan['commit'],'before':before,'after':after,'images':images,'businessActions':0}
        (target/'mail-query-preservation.json').write_text(json.dumps(receipt,sort_keys=True,indent=2)+'\n')
        (target/'mail-query-build-proof.json').write_bytes(raw_proof)
        manifest=json.loads((previous/'release-manifest.json').read_bytes())
        artifact={'url':url,'sha256':plan['artifactSha256'],'validationRun':plan['workflowRunId']}
        manifest.update(commit=plan['commit'],applicationCommit=plan['commit'],controlCommit=plan['commit'],
            version='v2-'+plan['commit'],sourceTree=plan['tree'],scope=SCOPE,status='DEPLOYED',sourceBranch='main',
            sourceLayout='PUBLISHED_PREDECESSOR_WITH_REVIEWED_MAIN_MAILBOX_OVERLAY',
            deploymentMethod='NATIVE_MAIN_REBUILD_AND_SSM_FORWARD',validationRun=plan['workflowRunId'],
            previousCommit=CURRENT,previousRelease=str(previous),previousManifestSha256=captured['manifestSha256'],
            servicesUpdated=['admin'],servicesRebound=[],actualDeployment=receipt,
            sourceProjection={'changedSources':c['sources'],'apiModules':proof['apiModules'],
                              'buildProofSha256':plan['buildProofSha256']},
            newMigrations=[],migrationPerformed=False,paymentActions=0,buildProofSha256=plan['buildProofSha256'],
            compiledArtifact=artifact,adminCompiledArtifact=artifact)
        for name in ('acceptedSwitchCommandId','publicationFinalization','deploymentRun'):
            manifest.pop(name,None)
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
