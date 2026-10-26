"""Publish only the reviewed mailbox provider UI on the verified current native runtime."""
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
SCOPE = 'MAILBOX_PROVIDER_20261026'
PREFIX = 'mailbox-provider'
CONTRACT_FILE = PREFIX + '-contract.json'
CURRENT = 'ec5af94ceca92ae5e6fe26b81881843f926a42e5'
ADMIN_CURRENT = '7c5ddc35e15aeecbf54f71acce96498c38b73d45'
SOURCE_BASE = ADMIN_CURRENT
SOURCE = '94b08486800227b728dcdee68a161debd179aa43'
SOURCE_TREE = 'e9afad96f9918a58eddb8b225c0f5c68fd557d52'
SOURCE_SHA256 = '33fb09b1185cfcad3ba85a33bf96b64670e2487a4c2d6004fd56c636eb8a0aa7'
BASELINE_SHA256 = 'c0838623d17e65eb67a90e365e933e4d4a2e55bf70546e9051bea3a541b98851'
PRESERVED = ('api', 'online-recharge', 'mysql', 'caddy', 'media-resolver', 'auto-recharge')
SERVICES = ('admin', *PRESERVED)


def load(name):
    spec = importlib.util.spec_from_file_location('mailbox_provider_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


H = load('recharge-record-release.py')
sha = H.digest
canonical = lambda value: json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def need(value, code):
    if not value:
        raise RuntimeError('MAILBOX_PROVIDER_' + code)


def validate_contract(c):
    need(c.get('version') == 1 and c.get('scope') == SCOPE and c.get('expectedCurrent') == CURRENT
         and c.get('sourceReviewCommit') == SOURCE and c.get('sourceReviewTree') == SOURCE_TREE, 'IDENTITY_CHANGED')
    need(c.get('updatedServices') == ['admin'] and c.get('preservedServices') == list(PRESERVED)
         and c.get('migrationPerformed') is False and type(c.get('businessActions')) is int
         and c['businessActions'] == 0, 'SIDE_EFFECT_SCOPE')
    need(sha(canonical(c['sources'])) == SOURCE_SHA256 and len(c['sources']) == 4, 'SOURCE_CHANGED')
    need(sha(canonical(c['baseline'])) == BASELINE_SHA256, 'BASELINE_CHANGED')
    need(c['baseline']['runtime']['expectedCurrent'] == CURRENT
         and set(c['baseline']['runtime']['services']) == {*PRESERVED, 'admin'}, 'SERVICES_CHANGED')


def verify_proof(proof, plan, c, files):
    validate_contract(c)
    need(all(proof.get(k) == plan[k] for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt',
         'contractSha256', 'controlSources', 'nativeParentCapture', 'qualitySourceEvidence')), 'PROVENANCE_CHANGED')
    need(proof['scope'] == SCOPE and proof['sources'] == c['sources'] and proof['files'] == files
         and proof['migrationPerformed'] is False and type(proof['businessActions']) is int
         and proof['businessActions'] == 0, 'PAYLOAD_CHANGED')
    need(proof['baselineAdminFiles'] == c['baseline']['baselineAdminFiles']
         and proof['apiModules'] == proof['baselineApiModules'] == c['baseline']['baselineApiModules'], 'BASELINE_NOT_REPRODUCED')
    need(proof.get('baselineApiReproduced') is True and proof.get('baselineAdminSourceReproduced') is True, 'REPRODUCTION_REQUIRED')
    q = proof['qualitySourceEvidence']
    need(q.get('sourceReviewCommit') == SOURCE and q.get('commit') == plan['commit']
         and q.get('tree') == plan['tree'] and q.get('main', {}).get('head') == plan['commit'], 'QUALITY_REQUIRED')
    expected = {'admin/html/' + n: v for n, v in proof['adminFiles'].items()}
    expected.update({'source/' + n: v for n, v in c['sources'].items()})
    need(files == expected and 'index.html' in proof['adminFiles'], 'PAYLOAD_SCOPE_CHANGED')


def helpers(name):
    module = load(name)
    retired = load('online-query-network-release.py')
    retired.SCOPE, retired.SERVICES = SCOPE, SERVICES
    if name == 'recharge-record-release.py':
        module.SERVICES = SERVICES
        module.guards = lambda d, directory, states, c: retired.retired_guards(d, directory, states, c, module)
        original = module.load_utilities

        def utilities(*args):
            d = original(*args)
            point = d.point_current

            def point_current(target, stamp):
                path = target / 'release-manifest.json'
                value = json.loads(path.read_bytes())
                value.update(applicationCommit=value['commit'], controlCommit=value['commit'],
                             version='v2-' + value['commit'],
                             sourceLayout='PUBLISHED_PREDECESSOR_WITH_REVIEWED_MAILBOX_PROVIDER_OVERLAY')
                path.write_text(json.dumps(value, sort_keys=True, indent=2) + '\n')
                return point(target, stamp)

            d.point_current = point_current
            return d

        module.load_utilities = utilities
    elif name == 'proxy-result-identity-release.py':
        module.claim_markers = retired.claim_retired_markers
    elif name == 'shared-bank-card-release.py':
        equivalence = load('online-unpaid-validation-release.py').configuration_equivalence
        module.configuration_matches = lambda h, d, state, digest: equivalence(h, d, state, digest)['matched']
    return module


def snapshot(c):
    validate_contract(c)
    runtime = c['baseline']['runtime']
    h = helpers('recharge-record-release.py')
    d = h.load_utilities(HERE / 'remote-deploy.py', c['controlPins']['remote-deploy.py'])
    core = load('online-checkout-release.py')
    core.load = helpers
    previous, raw, states = core.baseline(d, runtime, h)
    core.read_hashes(d, states['admin']['containerId'], '/usr/share/nginx/html/', c['baseline']['baselineAdminFiles'])
    core.read_hashes(d, states['api']['containerId'], '/app/apps/api/dist/', c['baseline']['baselineApiModules'])
    captured = {'status': 'MAILBOX_PROVIDER_PARENT_VERIFIED', 'businessActions': 0, 'current': str(previous), 'manifestSha256': sha(raw), 'services': states,
                'runtimeSha256': sha(canonical(runtime))}
    return captured, runtime, h, d, core


def smoke(d, target, before, states, proof, c, prior, h, p, captured):
    need(all(states[role] == before[role] for role in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
    need(states['admin']['environmentSha256'] == before['admin']['environmentSha256'], 'ENVIRONMENT_CHANGED')
    core = load('online-checkout-release.py')
    core.load, core.PRESERVED, core.UPDATED = helpers, PRESERVED, ('admin',)
    core.smoke(d, target, states, proof, prior, h)
    with urllib.request.urlopen(prior['publicUrl'], timeout=30) as response:
        html = response.read(2 * 1024**2).decode()
    need('v2-' + proof['commit'] in html, 'PUBLIC_VERSION_CHANGED')


def release(plan, c):
    validate_contract(c)
    need(plan['mode'] in ('parent', 'preflight', 'release', 'readback'), 'MODE_INVALID')
    need(plan['controlSources'] == {**c['controlPins'], CONTRACT_FILE: plan['contractSha256']}, 'CONTROL_SCOPE_CHANGED')
    need(sha((HERE / CONTRACT_FILE).read_bytes()) == plan['contractSha256']
         and all(sha((HERE / n).read_bytes()) == v for n,v in plan['controlSources'].items()), 'CONTROL_CHANGED')
    availability = load('recharge-availability-release.py')
    with (BASE / '.deploy.lock').open('a') as lock:
        availability.acquire_release_lock(lock)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve(strict=True)
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            receipt = json.loads((target / 'mailbox-provider-preservation.json').read_bytes())
            raw = (target / 'mailbox-provider-build-proof.json').read_bytes()
            need(manifest['commit'] == receipt['commit'] == plan['commit'] and manifest['scope'] == SCOPE
                 and all(manifest.get(n) == plan['commit'] for n in ('applicationCommit','controlCommit'))
                 and manifest.get('version') == 'v2-'+plan['commit']
                 and manifest.get('actualDeployment') == receipt
                 and manifest.get('sourceTree') == plan['tree']
                 and manifest.get('buildProofSha256') == sha(raw) == plan['buildProofSha256'], 'READBACK_CHANGED')
            prior = c['baseline']['runtime']
            h = helpers('recharge-record-release.py')
            d = h.load_utilities(HERE / 'remote-deploy.py', c['controlPins']['remote-deploy.py'])
            p = load('online-checkout-release.py')
            states = h.snapshot(d,target)
            need(states == receipt['after'], 'READBACK_SERVICES_CHANGED')
            smoke(d,target,receipt['before'],states,json.loads(raw),c,prior,h,p,plan['nativeParentCapture'])
            h.guards(d,target,states,prior)
            return {'status':'MAILBOX_PROVIDER_INDEPENDENT_READBACK_VERIFIED','commit':plan['commit'],'businessActions':0}
        captured,prior,h,d,p = snapshot(c)
        if plan['mode'] == 'parent':
            return {**captured,'businessActions':0}
        need(captured == plan['nativeParentCapture'], 'PARENT_MOVED')
        if plan['mode'] == 'preflight':
            return {'status':'MAILBOX_PROVIDER_PREFLIGHT_VERIFIED','businessActions':0}
        need(plan['mode'] == 'release', 'MODE_INVALID')
        stage = BASE / '.staging' / ('mailbox-provider-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        url = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/mailbox-provider-' + plan['commit'] + '/mailbox-provider-artifact.tar.gz'
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
        backup = h.fresh_scoped_backup(d, previous, plan, normalizer_path=Path(prior['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        images = {}
        for role,copy in (('admin','COPY html/ /usr/share/nginx/html/'),):
            context=payload/role
            availability.normalize_image_context(context)
            reference='id-business-v2-mailbox-provider:'+plan['commit']+'-'+plan['workflowRunId']+'-'+role
            original=json.loads(d.run('docker','image','inspect',before[role]['image']))[0]
            (context/'Dockerfile').write_text('FROM '+h.base_image_reference(d,before[role])+'\n'+copy+'\nLABEL org.opencontainers.image.revision="'+plan['commit']+'" id-business-v2.recharge-record-build-proof-sha256="'+plan['buildProofSha256']+'"\n')
            h.build_image(d,context,reference,role,before[role],stage)
            built=json.loads(d.run('docker','image','inspect',reference))[0]
            p.verify_image(original,built,plan)
            images[role]={'reference':reference,'imageId':built['Id']}
        need(snapshot(c)[0] == captured, 'PARENT_MOVED')
        stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target=BASE/'releases'/(stamp+'-'+plan['commit'][:12]+'-mailbox-provider')
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
        receipt={'commit':plan['commit'],'before':before,'after':after,'images':images,'backup':backup,'businessActions':0}
        (target/'mailbox-provider-preservation.json').write_text(json.dumps(receipt,sort_keys=True,indent=2)+'\n')
        (target/'mailbox-provider-build-proof.json').write_bytes(raw_proof)
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
        d.point_current(target,stamp+'-mailbox-provider')
        journal.write_text(json.dumps({'status':'DEPLOYED','commit':plan['commit']})+'\n')
        return {'status':'MAILBOX_PROVIDER_DEPLOYED','commit':plan['commit'],'businessActions':0}


def failure_report(error, plan):
    code = str(error) if re.fullmatch('[A-Z][A-Z0-9_]{1,120}', str(error)) else 'MAILBOX_PROVIDER_UNCONFIRMED'
    frames = [{'file':Path(f.filename).name,'line':f.lineno,'function':f.name}
              for f in traceback.extract_tb(error.__traceback__)[-5:]]
    return {'status':'FAILED','mode':plan['mode'],'code':code,'sourceFrames':frames,
            'errorClass':type(error).__name__,'businessActions':0}
