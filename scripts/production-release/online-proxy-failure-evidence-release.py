"""Finite artifact-validator/API and executor diagnostic overlay; no business actions."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
BASE = Path('/opt/id-business-v2')
PREFIX = 'online-proxy-failure-evidence'
SCOPE = 'ONLINE_PROXY_FAILURE_EVIDENCE_20261025'
CURRENT = '3d7ff9d0721c158289b25c3f6fadb96ad859fc31'
SOURCE = 'd8bd4086607666d3f2a0b5425e75f0ac1d84dccd'
SOURCE_TREE = 'bad8374fcb1b56dc25834fd4f1c426dcbb60f7ee'
CONTRACT_FILE = PREFIX + '-contract.json'
UPDATED = ('api', 'admin', 'online-recharge')
PRESERVED = ('mysql', 'caddy', 'media-resolver', 'auto-recharge')
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine/'
SOURCES = frozenset(['apps/admin/src/v2/features/online-recharge/unpaid-validation-labels.spec.ts', 'apps/admin/src/v2/features/online-recharge/unpaid-validation-labels.ts', 'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json', 'apps/api/src/id-business-v2/online-recharge/engine/test/browser-profile.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/test/recharge-flow-acceptance.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/test/unpaid-validation.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/unpaid-validation.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/upstream/index.js', 'apps/api/src/id-business-v2/online-recharge/persistence/artifacts.repository.ts', 'apps/api/src/id-business-v2/online-recharge/persistence/artifacts.unpaid.spec.ts', 'docs/ONLINE_RECHARGE.md', 'docs/V2_TASKS.md'])
API = ['id-business-v2/online-recharge/persistence/artifacts.repository.js']


def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_CHECKOUT_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location('card_read_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_contract(c):
    need(c.get('version') == 1 and c.get('scope') == SCOPE and c.get('expectedCurrent') == CURRENT
         and c.get('sourceReviewCommit') == SOURCE and c.get('sourcePullRequest') == 710, 'CONTRACT_IDENTITY')
    need(c.get('updatedServices') == list(UPDATED) and c.get('preservedServices') == list(PRESERVED)
         and c.get('awsTargetAccount') == '098208446664' and c.get('awsTargetInstance') == 'i-0838cebf64f0e2a89'
         and c.get('migrationPerformed') is False and c.get('businessActions') == 0, 'SIDE_EFFECT_SCOPE')
    need(c.get('apiModules') == API and set(c.get('sources', {})) == SOURCES and len(SOURCES) == 12
         and all(re.fullmatch('[a-f0-9]{64}', v) and '..' not in Path(n).parts for n, v in c['sources'].items()), 'SOURCE_SCOPE')
    need(sha(canonical(c['sources'])) == 'e26d11afb7dd17284acfa07066eac91f334132bf33270d1299367118488febe7' and sha(canonical(c['expectedApiFiles'])) == '00f4ed83b408868813d15be61dbce02b8ab1b6ed1ec220e1f0d4014af8775f97', 'SOURCE_RUNTIME_HASHES_CHANGED')
    need(set(c['beforeEngineFiles']) == set(c['afterEngineFiles']) and {
        ENGINE + n: v for n, v in c['afterEngineFiles'].items() if c['beforeEngineFiles'].get(n) != v
    } == {n: v for n, v in c['sources'].items() if n.startswith(ENGINE)}, 'ENGINE_DELTA')
    need(c['parentPlan']['commit'] == CURRENT and c['parentPlan']['workflowRunId'] == '40176051849'
         and c['parentArtifact']['commit'] == CURRENT
         and c['parentArtifact']['buildProofSha256'] == 'f5fa702ee0a1b750caf165fd7c836cc2483403034ee5e2234c5be4788045555f'
         and c['sqlFenceHelperSha256'] == c['controlPins']['api-admin-scope.py']
         == '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925', 'PARENT_BINDING')


def verify_quality(q, commit, tree):
    source_tree = SOURCE_TREE
    need(q.get('commit') == commit and q.get('tree') == tree
         and q.get('source', {}).get('head') == SOURCE and q['source'].get('pullRequest') == 710
         and q['source'].get('tree') == source_tree
         and q.get('control', {}).get('pullRequest', 0) > 710 and q['control'].get('tree') == tree
         and q.get('main', {}).get('head') == commit, 'QUALITY_REQUIRED')
    for part in ('source', 'control'):
        need(re.fullmatch('[a-f0-9]{40}', q[part].get('head', ''))
             and re.fullmatch('[a-f0-9]{64}', q[part].get('sourceReceiptSha256', ''))
             and re.fullmatch('[1-9][0-9]*', q[part].get('runId', '')), 'QUALITY_RECEIPT_REQUIRED')


def core():
    impl = load('online-checkout-resume-release.py')
    for name in ('BASE', 'PREFIX', 'SCOPE', 'CURRENT', 'SOURCE', 'CONTRACT_FILE', 'UPDATED', 'PRESERVED'):
        setattr(impl, name, globals()[name])
    impl.validate_contract = validate_contract
    impl.capture_parent = capture_parent
    impl.verify_proof = verify_payload
    return impl


def verify_payload(proof, plan, c, files):
    validate_contract(c)
    verify_quality(proof.get('qualitySourceEvidence', {}), plan['commit'], plan['tree'])
    need(proof.get('qualitySourceEvidence') == plan.get('qualitySourceEvidence'), 'QUALITY_PROOF_CHANGED')
    need(proof.get('version') == 1 and proof.get('scope') == SCOPE
         and all(proof.get(k) == plan[k] for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controlSources'))
         and proof.get('sources') == c['sources'] and proof.get('afterEngineFiles') == c['afterEngineFiles']
         and proof.get('nativeParentCapture') == plan.get('nativeParentCapture')
         and proof.get('baselineApiReproduced') is True and proof.get('baselineAdminSourceReproduced') is True
         and proof.get('migrationPerformed') is False and proof.get('businessActions') == 0, 'PROOF_CHANGED')
    selected = {n.removesuffix('.js') + ext for n in c['apiModules'] for ext in ('.js', '.js.map', '.d.ts')}
    modules = proof.get('apiModules', {})
    need(selected <= set(modules) and all(n.startswith('id-business-v2/online-recharge/') and n.endswith('.d.ts') and '..' not in Path(n).parts for n in set(modules) - selected), 'API_MODULE_SCOPE_CHANGED')
    h = load('recharge-record-release.py')
    need(h.fingerprint(proof.get('baselineAdminFiles', {})) == c['baselineAdminFilesSha256']
         and bool(proof.get('adminFiles')) and all('..' not in Path(n).parts and not Path(n).is_absolute() and re.fullmatch('[a-f0-9]{64}', v) for n,v in proof['adminFiles'].items()), 'ADMIN_INVENTORY_CHANGED')
    expected = {**{'source/' + n: v for n,v in c['sources'].items()},
                **{'api/modules/' + n: v for n,v in modules.items()},
                **{'admin/html/' + n: v for n,v in proof['adminFiles'].items()},
                **{'engine/' + n: v for n,v in c['afterEngineFiles'].items() if c['beforeEngineFiles'].get(n) != v}}
    need(files == expected == proof['files'], 'PAYLOAD_SCOPE_CHANGED')


def verify_proof(proof, plan, c, files):
    return core().verify_proof(proof, plan, c, files)


def capture_parent(plan, c):
    # First independently verify the actual latest engine-only release. Its API
    # predecessor artifact remains the source of the exact unchanged API bytes.
    prior = load('online-card-read-diagnostics-release.py')
    receipt = prior.release({**c['parentPlan'], 'mode': 'readback'},
                           json.loads((HERE / prior.CONTRACT_FILE).read_bytes()))
    need(receipt['status'] == 'ONLINE_CHECKOUT_INDEPENDENT_READBACK_VERIFIED', 'PARENT_READBACK_FAILED')
    impl = core()
    h = impl.load('recharge-record-release.py')
    d = h.load_utilities(HERE / 'remote-deploy.py', plan['controlSources']['remote-deploy.py'])
    with (BASE / '.deploy.lock').open('a') as lock:
        impl.load('recharge-availability-release.py').acquire_release_lock(lock)
        current = (BASE / 'current').resolve(strict=True)
        need(current.parent == BASE / 'releases', 'CURRENT_PATH')
        raw = (current / 'release-manifest.json').read_bytes()
        need(json.loads(raw)['commit'] == CURRENT, 'CURRENT_CHANGED')
        parent_raw = (current / 'online-checkout-build-proof.json').read_bytes()
        need(sha(parent_raw) == c['parentArtifact']['buildProofSha256'], 'PARENT_PROOF_CHANGED')
        parent = json.loads(parent_raw)
        need(parent['commit'] == c['parentArtifact']['commit'] and parent['afterEngineFiles'] == c['apiParentEngineFiles'], 'API_PARENT_CHANGED')
        states = h.snapshot(d, current)
        h.guards(d, current, states, c)
        impl.read_hashes(d, states['api']['containerId'], '/app/apps/api/dist/', parent['apiModules'])
        impl.read_hashes(d, states['admin']['containerId'], '/usr/share/nginx/html/', parent['adminFiles'])
        impl.load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], c['beforeEngineFiles'])
        impl.read_hashes(d, states['api']['containerId'], '/app/apps/api/dist/', c['expectedApiFiles'])
        before_api = {n.removeprefix('id-business-v2/online-recharge/'): v for n,v in c['expectedApiFiles'].items()}
        baseline = {'current': str(current), 'expectedCurrent': CURRENT, 'manifestSha256': sha(raw),
            'services': states, 'runtimeConfigurationSha256': {n: h.configuration(d, s) for n, s in states.items()},
            'configurationSha256': {n: sha((current / n).read_bytes()) for n in ('.env.aws.production', 'compose.release.json', 'docker-compose.aws-mysql.yml')},
            'beforeApiOnlineFiles': before_api, 'baselineAdminFilesSha256': h.fingerprint(parent['adminFiles']),
            'nginxSha256': d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum', '/etc/nginx/conf.d/default.conf').split()[0],
            'publishedOverlays': [{'proofFile': 'online-checkout-build-proof.json', 'proofSha256': sha(parent_raw)},
                ],
        }
        impl.baseline(d, {**c, **baseline}, h)
        return {'status': 'ONLINE_CHECKOUT_RESUME_PARENT_VERIFIED', 'baseline': baseline,
                'commit': plan['commit'], 'businessActions': 0, 'migrationPerformed': False}


def release(plan, c):
    validate_contract(c)
    if plan['mode'] == 'recovery_observe': return recovery_snapshot(c)
    if plan['mode'] in ('recovery_complete', 'recovery_readback'): return recovery_complete(plan,c)
    need(not c.get('acceptedRecovery'), 'ORIGINAL_RELEASE_ALREADY_ACCEPTED')
    return core().release(plan, c)


def failure_report(error, plan):
    return core().failure_report(error, plan)

def recovery_material(c):
    import importlib.util
    accepted = c['acceptedRecovery']; original = accepted['plan']
    need(sha(canonical(original)) == accepted['planSha256'] == 'f6e90663cbd2f0fc2b953d462e119c410a625f2fbc2b711efa6201370ac96bc7'
         and accepted['commandId'] == '84f5966d-b539-4099-b243-d8be39fe9e3f'
         and original['commit'] == 'd84159da515e915b0734f5dcd5fe3d9ed4f843aa'
         and original['workflowRunId'] == '40178946393', 'ACCEPTED_IDENTITY')
    entry = BASE / '.staging' / ('checkout-resume-entry-' + original['commit'] + '-' + original['workflowRunId'])
    need(all(sha((entry/n).read_bytes()) == v for n,v in original['controlSources'].items()), 'ORIGINAL_CONTROLS_CHANGED')
    spec = importlib.util.spec_from_file_location('accepted_original_release', entry / (PREFIX + '-release.py'))
    original_module = importlib.util.module_from_spec(spec); spec.loader.exec_module(original_module)
    core = original_module.core()
    raw = (entry / CONTRACT_FILE).read_bytes()
    need(sha(raw) == original['contractSha256'], 'ORIGINAL_CONTRACT_CHANGED')
    old = {**json.loads(raw), **original['nativeParentCapture']['baseline']}
    original_module.validate_contract(old)
    stage = BASE / '.staging' / ('online-checkout-' + original['commit'] + '-' + original['workflowRunId'])
    journal = json.loads((stage/'switch-state.json').read_bytes())
    target = Path(journal['target']); previous = Path(old['current'])
    need(target.parent == BASE/'releases' and target.name.endswith(original['commit'][:12]+'-online-checkout')
         and journal.get('previous',str(previous)) == str(previous), 'ACCEPTED_TARGET_CHANGED')
    payload=stage/'content/payload'; proof_raw=(payload/'build-proof.json').read_bytes()
    need(sha(proof_raw) == original['buildProofSha256'], 'ORIGINAL_PROOF_CHANGED')
    proof=json.loads(proof_raw); h=core.load('recharge-record-release.py')
    files=h.file_inventory(payload);files.pop('build-proof.json');original_module.verify_proof(proof,original,old,files)
    d=h.load_utilities(entry/'remote-deploy.py',original['controlSources']['remote-deploy.py'])
    images={}
    for role in UPDATED:
        built=json.loads((stage/(role+'-image-build.json')).read_bytes())
        need(built['status']=='BUILT' and built['baseImageId']==old['services'][role]['image'],'ORIGINAL_IMAGE_BUILD_CHANGED')
        image=json.loads(d.run('docker','image','inspect',built['reference']))[0]
        parent=json.loads(d.run('docker','image','inspect',built['baseImageId']))[0]
        core.verify_image(parent,image,original)
        images[role]={'reference':built['reference'],'imageId':image['Id']}
    return original,old,stage,journal,target,previous,proof_raw,proof,h,d,core,images


def recovery_snapshot(c):
    original,old,stage,journal,target,previous,raw,proof,h,d,core,images=recovery_material(c)
    with (BASE/'.deploy.lock').open('a') as lock:
        core.load('recharge-availability-release.py').acquire_release_lock(lock)
        need(journal == {'status':'SWITCH_FAILED','target':str(target),'previous':str(previous),'businessActions':0}
             and (BASE/'current').resolve()==previous and not (stage/'forward-finalization.json').exists(),'ACCEPTED_JOURNAL_CHANGED')
        states=h.snapshot(d,target)
        need(all(states[r] == old['services'][r] for r in PRESERVED),'PRESERVED_SERVICE_CHANGED')
        need(all(states[r]['image']==images[r]['imageId'] for r in ('api','online-recharge'))
             and states['admin']==old['services']['admin'],'PARTIAL_SWITCH_CHANGED')
        helper=load('online-unpaid-validation-release.py')
        models={r:helper.configuration_equivalence(h,d,s,old['runtimeConfigurationSha256'][r]) for r,s in states.items()}
        need(all(v['matched'] for v in models.values()),'RUNTIME_CONFIGURATION_CHANGED')
        core.read_hashes(d,states['api']['containerId'],'/app/apps/api/dist/',proof['apiModules'])
        core.read_hashes(d,states['admin']['containerId'],'/usr/share/nginx/html/',proof['baselineAdminFiles'])
        core.load('proxy-result-identity-release.py').engine_content(d,states['online-recharge'],old['afterEngineFiles'])
        return {'status':'ONLINE_PROXY_ACCEPTED_SWITCH_OBSERVED','commit':original['commit'],'target':str(target),
                'previous':str(previous),'services':states,'configuration':models,'allConfigurationMatched':True,
                'adminPending':True,'containersRecreated':False,'businessActions':0}


def recovery_complete(plan,c):
    import datetime,base64
    observed=plan['acceptedObservation']
    need(observed['status']=='ONLINE_PROXY_ACCEPTED_SWITCH_OBSERVED' and observed['allConfigurationMatched'] is True,'OBSERVATION_REQUIRED')
    original,old,stage,journal,target,previous,raw,proof,h,d,core,images=recovery_material(c)
    helper=load('online-unpaid-validation-release.py')
    loader=core.load
    def qualified(name):
        value=loader(name)
        if name=='shared-bank-card-release.py':
            value.configuration_matches=lambda selected,transport,state,expected:helper.configuration_equivalence(selected,transport,state,expected)['matched']
        return value
    core.load=qualified
    with (BASE/'.deploy.lock').open('a') as lock:
        core.load('recharge-availability-release.py').acquire_release_lock(lock)
        states=h.snapshot(d,target)
        need(states==observed['services'],'OBSERVED_SERVICES_CHANGED')
        if plan['mode']=='recovery_readback':
            receipt=json.loads((target/'online-checkout-preservation.json').read_bytes())
            need((BASE/'current').resolve()==target and receipt['after']==states
                 and receipt['commit']==original['commit'] and journal['status']=='DEPLOYED','FINALIZE_READBACK_CHANGED')
            core.smoke(d,target,states,proof,old,h);h.guards(d,target,states,old)
            return {'status':'ONLINE_PROXY_COMPLETION_READBACK_VERIFIED','commit':original['commit'],
                    'controlCommit':plan['commit'],'updatedServices':list(UPDATED),'preservedServices':list(PRESERVED),
                    'migrationPerformed':False,'businessActions':0}
        need(plan['mode']=='recovery_complete' and journal=={'status':'SWITCH_FAILED','target':str(target),'previous':str(previous),'businessActions':0}
             and (BASE/'current').resolve()==previous and not (stage/'forward-finalization.json').exists(),'COMPLETION_ALREADY_ACCEPTED_OR_MOVED')
        need(all(states[r]==old['services'][r] for r in PRESERVED)
             and all(states[r]['image']==images[r]['imageId'] for r in ('api','online-recharge'))
             and states['admin']==old['services']['admin'],'PARTIAL_SWITCH_CHANGED')
        manifest_raw=(previous/'release-manifest.json').read_bytes()
        need(sha(manifest_raw)==old['manifestSha256'] and (target/'release-manifest.json').read_bytes()==manifest_raw,'ORIGINAL_MANIFEST_CHANGED')
        backup_dir=BASE/'backups'/('recharge-record-'+original['commit']+'-'+original['workflowRunId'])
        need(json.loads((backup_dir/'backup-operation.json').read_bytes())['status']=='VERIFIED','ORIGINAL_BACKUP_UNVERIFIED')
        backup=json.loads((backup_dir/'backup-verification.json').read_bytes());backup_path=Path(backup['path'])
        need(backup_path.parent==backup_dir and backup_path.is_file() and not backup_path.is_symlink(),'ORIGINAL_BACKUP_PATH_CHANGED')
        backup_raw=backup_path.read_bytes()
        need(len(backup_raw)==backup['size'] and sha(backup_raw)==backup['sha256'],'ORIGINAL_BACKUP_CHANGED')
        env=d.environment_values(previous/'.env.aws.production')
        head=json.loads(d.run('aws','s3api','head-object','--region',env.get('MYSQL_BACKUP_S3_REGION') or 'ap-northeast-1','--bucket',backup['s3Bucket'],'--key',backup['s3Key'],'--checksum-mode','ENABLED',timeout=60))
        need(head.get('ContentLength')==len(backup_raw) and head.get('ChecksumSHA256')==base64.b64encode(hashlib.sha256(backup_raw).digest()).decode() and head.get('ServerSideEncryption')=='AES256','ORIGINAL_BACKUP_S3_CHANGED')
        retired=load('online-query-network-release.py')
        marker_raw=json.dumps({'scope':retired.SCOPE,'commit':original['commit'],'workflowRunId':original['workflowRunId']},sort_keys=True).encode()
        marker={'paths':[str(BASE/'maintenance.json')],'ownerSha256':sha(marker_raw)}
        markers=load('proxy-result-identity-release.py');markers.verify_markers(marker)
        d.assert_no_active_recharge(target);h.engine_idle(d,states['online-recharge'],old,wait_connected=True)
        intent={'status':'STARTED','commit':original['commit'],'controlCommit':plan['commit'],'observationSha256':sha(canonical(observed)),
                'containersToUpdate':['admin'],'apiExecutorRecreated':False,'backupRepeated':False,'migrationPerformed':False,'businessActions':0}
        intent_path=stage/'forward-finalization.json'
        with intent_path.open('x') as f:
            json.dump(intent,f,sort_keys=True);f.flush();__import__('os').fsync(f.fileno())
        # Only the omitted Admin switch is performed. Never restart API/executor or repeat backup/build.
        d.compose(target,'up','-d','--no-deps','admin',timeout=180);d.wait_healthy(target,'admin')
        after=h.snapshot(d,target)
        need(all(after[r]['image']==images[r]['imageId'] for r in UPDATED),'COMPLETION_IMAGE_CHANGED')
        core.smoke(d,target,after,proof,old,h)
        markers.release_markers(marker);h.guards(d,target,after,old)
        receipt={'status':'DEPLOYED','commit':original['commit'],'before':old['services'],'after':after,'images':images,
                 'backup':backup,'artifactSha256':original['artifactSha256'],'buildProofSha256':original['buildProofSha256'],
                 'preservedServices':list(PRESERVED),'migrationPerformed':False,'businessActions':0,'controlCommit':plan['commit']}
        (target/'online-checkout-preservation.json').write_text(json.dumps(receipt,sort_keys=True,indent=2)+'\n')
        (target/'online-checkout-build-proof.json').write_bytes(raw)
        manifest=json.loads(manifest_raw);manifest.update(commit=original['commit'],sourceTree=original['tree'],sourceBranch='main',scope=SCOPE,
            previousCommit=old['expectedCurrent'],previousRelease=str(previous),previousManifestSha256=sha(manifest_raw),status='DEPLOYED',
            servicesUpdated=list(UPDATED),newMigrations=[],migrationPerformed=False,paymentActions=0,onlineSettingsPublication=receipt)
        for role in UPDATED:
            manifest['images'][role]={'reference':images[role]['reference'],'digest':images[role]['imageId'],'sourceCommit':original['commit']}
            projections=manifest.setdefault('roleSourceProjections',{})
            projections[role]={'kind':'PUBLISHED_PREDECESSOR_PLUS_ONLINE_SETTINGS','commit':original['commit'],'parentProjection':projections.get(role),
                'buildProofSha256':original['buildProofSha256'],'sources':{n:v for n,v in old['sources'].items() if
                    (n.startswith('apps/admin/') if role=='admin' else n.startswith(old['engineRoot']+'/') if role=='online-recharge' else n.startswith('apps/api/') and not n.startswith(old['engineRoot']+'/'))}}
        (target/'release-manifest.json').write_text(json.dumps(manifest,sort_keys=True,indent=2)+'\n')
        stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ');d.point_current(target,stamp+'-online-checkout')
        (stage/'switch-state.json').write_text(json.dumps({'status':'DEPLOYED','target':str(target),'commit':original['commit']})+'\n')
        intent['status']='FINALIZED';intent_path.write_text(json.dumps(intent,sort_keys=True,indent=2)+'\n')
        return {'status':'ONLINE_PROXY_FORWARD_COMPLETED','commit':original['commit'],'controlCommit':plan['commit'],
                'apiExecutorRecreated':False,'adminUpdated':True,'migrationPerformed':False,'businessActions':0,
                'observation':{**observed,'services':after,'adminPending':False}}
