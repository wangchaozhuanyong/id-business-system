"""Finite native checkout publication; preserve the current API/Admin images and all other roles."""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import urllib.request

BASE = Path('/opt/id-business-v2')
PRESERVED = ('admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration')


def need(value, code):
    if not value:
        raise RuntimeError('RECHARGE_SOURCE_RECOVERY_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def verify_image_configuration(original, built):
    # Docker clears the deprecated parent-image build marker when inheriting an
    # image. It is not the selected image ID or a container runtime setting.
    for config in (original, built):
        marker = config.get('Image')
        need(marker in (None, '') or (isinstance(marker, str) and re.fullmatch('sha256:[a-f0-9]{64}', marker)), 'IMAGE_PARENT_MARKER_INVALID')
    need({k: v for k, v in built.items() if k not in ('Labels', 'Image')} ==
         {k: v for k, v in original.items() if k not in ('Labels', 'Image')}, 'IMAGE_CONFIGURATION_CHANGED')


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def utilities():
    return load(Path(__file__).with_name('recharge-availability-release.py'), 'billing_generic_helpers')










def validate_proof(proof, plan, contract, payload, h):
    database = contract['databaseVerification']
    need(proof.get('version') == 1 and proof.get('scope') == contract['scope']
         and all(proof.get(k) == plan[k] for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controllerSha256', 'releaseUtilitySha256', 'helperSha256'))
         and proof.get('baselineApiReproduced') is True
         and proof.get('baselinePublishedVerified') == {'apiSource': contract['apiSourceBaseline'], 'adminSource': contract['adminSourceBaseline'], 'verified': True}
         and proof.get('baselineAdminPreserved') is True
         and proof.get('databaseVerification') == database
         and proof.get('qualityVerification') == plan['qualityVerification']
         and plan['qualityVerification'].get('commit') == plan['commit']
         and plan['qualityVerification'].get('sourceTree') == plan['tree']
         and plan['qualityVerification'].get('conclusion') == 'success'
         and plan['qualityVerification'].get('path') == '.github/workflows/quality.yml'
         and proof.get('updatedServices') == ['api'] and proof.get('migrationPerformed') is False
         and type(proof.get('businessActions')) is int and proof['businessActions'] == 0, 'PROOF_INVALID')
    actual = h.file_inventory(payload)
    actual.pop('build-proof.json', None)
    allowed = {n.removesuffix('.js') + ext for n in contract['apiModules'] for ext in ('.js', '.js.map', '.d.ts')}
    need(actual == proof.get('files') and set(proof['apiModules']) == allowed
         and proof['adminFiles'] == {}
         and {n.removeprefix('source/'): v for n, v in actual.items() if n.startswith('source/')} == contract['sources']
         and {n.removeprefix('api/modules/'): v for n, v in actual.items() if n.startswith('api/modules/')} == proof['apiModules']
         and {n.removeprefix('admin/html/'): v for n, v in actual.items() if n.startswith('admin/html/')} == proof['adminFiles']
         and all(n.startswith(('source/', 'api/modules/')) for n in actual), 'PAYLOAD_SCOPE_CHANGED')
    return proof


def baseline(d, contract, h, expected=None):
    a = utilities()
    previous = (BASE / 'current').resolve()
    need(previous == Path(contract['current']) and previous.parent == BASE / 'releases', 'CURRENT_CHANGED')
    raw = (previous / 'release-manifest.json').read_bytes()
    need(digest(raw) == contract['manifestSha256'] and json.loads(raw)['commit'] == contract['expectedCurrent'], 'MANIFEST_CHANGED')
    states = h.snapshot(d, previous)
    need(states == contract['services'], 'SERVICES_CHANGED')
    need(all(digest((previous / n).read_bytes()) == v for n, v in contract['configurationSha256'].items()), 'CONFIGURATION_CHANGED')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    normalizer = Path(contract['backupNormalizerPath'])
    need(normalizer.is_relative_to(BASE / 'releases') and not normalizer.is_symlink()
         and digest(normalizer.read_bytes()) == contract['backupNormalizerSha256'], 'BACKUP_NORMALIZER_CHANGED')
    a.verify_modules(d, previous, contract['apiModules'])
    a.verify_admin(d, states['admin'], contract['publicFiles'])
    need(d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum', '/etc/nginx/conf.d/default.conf').split()[0]
         == contract['nginxSha256'], 'NGINX_CHANGED')
    h.guards(d, previous, states, contract)
    if expected is not None:
        a.verify_runtime_receipt(a.runtime_receipt(previous, raw, states), expected)
    return previous, raw, states


def smoke(d, target, proof, states, contract, h):
    a = utilities()
    a.verify_modules(d, target, proof['apiModules'])
    a.verify_admin(d, states['admin'], {**contract['publicFiles'], **proof['adminFiles']})
    need(d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum', '/etc/nginx/conf.d/default.conf').split()[0]
         == contract['nginxSha256'], 'NGINX_CHANGED')
    with urllib.request.urlopen(urllib.request.Request('https://54-249-61-238.sslip.io/', headers={'Cache-Control': 'no-cache'}), timeout=25) as response:
        html = response.read(2 * 1024**2)
    need(digest(html) == contract['publicFiles']['index.html'] and ('v2-' + contract['adminSourceBaseline']).encode() in html, 'PUBLIC_BUILD_CHANGED')
    for name, expected in contract['sources'].items():
        path = target / name
        need(not path.is_symlink() and path.resolve().is_relative_to(target) and digest(path.read_bytes()) == expected, 'HOST_SOURCE_CHANGED')
    h.guards(d, target, states, contract)
    # Pure classification only: no database, new checkout or payment.
    code = """const a=require('/app/apps/api/dist/id-business-v2/auto-recharge/recharge-availability.js');
const g=require('/app/apps/api/dist/id-business-v2/auto-recharge/recharge-unidentified-checkout.js');
const r=a.rechargeAvailability({state:'finished',leaseUntil:new Date(0),ownerId:'fixture',accountKey:null,result:{payment_attempted:true,payment_requests_sent:1,payment_status:'unknown'}},[]);
const x={status:'blocked',reason:'checkout_unknown_write',stage:'checkout_create',account_matched:true,payment_status:'not_attempted',payment_attempted:false,checkout_requests_sent:1,payment_requests_sent:0};
const owner='fixture',key='a'.repeat(64),oldProfile='b'.repeat(32),newProfile='c'.repeat(32);
const source={id:'original',ownerId:owner,accountKey:key,action:'bitbrowser',state:'finished',plan:'plus',result:{...x,browser_profile_id:oldProfile}};
const login={...source,id:'login',result:{mode:'open_browser',status:'session_ready',account_matched:true,payment_attempted:false,payment_requests_sent:0,browser_profile_id:newProfile,browser_profile_missing_confirmed:true,replaced_browser_profile_id:oldProfile}};
console.log(JSON.stringify({released:r.execution==='released',unknownProtected:r.accountPaymentRestricted&&r.payment==='unknown',discoveryOnly:g.isUnidentifiedUnpaidCheckout(x)&&!g.isUnidentifiedUnpaidCheckout({...x,payment_attempted:true}),replacementSource:g.findUnidentifiedCheckoutSource([login,source],owner,key,'plus',newProfile)?.id==='original',replacementRiskBlocked:!g.findUnidentifiedCheckoutSource([{...login,result:{...login.result,payment_attempted:true}},source],owner,key,'plus',newProfile)}));"""
    need(json.loads(d.compose(target, 'exec', '-T', 'api', 'node', '-e', code)) == {
        'released': True, 'unknownProtected': True, 'discoveryOnly': True,
        'replacementSource': True, 'replacementRiskBlocked': True}, 'BUSINESS_MODULE_SMOKE_FAILED')



def release(plan, contract, d, h):
    a = utilities()
    need(plan['mode'] in ('preflight', 'release', 'readback') and re.fullmatch('[a-f0-9]{40}', plan['commit'])
         and re.fullmatch('[a-f0-9]{40}', plan['tree']) and re.fullmatch('[1-9][0-9]*', plan['workflowRunId'])
         and re.fullmatch('[1-9][0-9]*', plan['workflowRunAttempt']), 'IDENTITY_INVALID')
    with (BASE / '.deploy.lock').open('a') as lock:
        a.acquire_release_lock(lock)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve()
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            need(manifest.get('commit') == plan['commit'] and manifest.get('scope') == contract['scope'], 'READBACK_CURRENT_CHANGED')
            receipt = json.loads((target / 'recharge-source-recovery-preservation.json').read_bytes())
            states = h.snapshot(d, target)
            need(states == receipt['after'] and all(states[n] == receipt['before'][n] for n in PRESERVED), 'READBACK_SERVICES_CHANGED')
            raw = (target / 'recharge-source-recovery-build-proof.json').read_bytes()
            need(digest(raw) == plan['buildProofSha256'], 'READBACK_PROOF_CHANGED')
            need(all(digest((target / 'scripts/production-release' / n).read_bytes()) == v for n, v in plan['controlSources'].items()), 'READBACK_EXECUTOR_CHANGED')
            smoke(d, target, json.loads(raw), states, contract, h)
            return {'status': 'RECHARGE_SOURCE_RECOVERY_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'], 'images': receipt['images'], 'preservedServices': list(PRESERVED), 'businessActions': 0, 'migrationPerformed': False}
        if plan['mode'] == 'release':
            need(type(plan.get('runtimeBaseline')) is dict, 'PREFLIGHT_RECEIPT_MISSING')
        previous, raw_manifest, before = baseline(d, contract, h, plan.get('runtimeBaseline'))
        if plan['mode'] == 'preflight':
            return {'status': 'RECHARGE_SOURCE_RECOVERY_PREFLIGHT_VERIFIED', 'commit': plan['commit'], 'runtimeBaseline': a.runtime_receipt(previous, raw_manifest, before), 'businessActions': 0, 'migrationPerformed': False}
        stage = BASE / '.staging' / ('recharge-source-recovery-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        expected_url = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/recharge-source-recovery-' + plan['commit'] + '/recharge-source-recovery-artifact.tar.gz'
        need(plan['artifactUrl'] == expected_url, 'ARTIFACT_LOCATION_INVALID')
        with urllib.request.urlopen(expected_url, timeout=60) as response:
            bundle = response.read(32 * 1024**2 + 1)
        need(0 < len(bundle) <= 32 * 1024**2 and digest(bundle) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        payload = h.safe_archive(bundle, stage / 'content')
        raw_proof = (payload / 'build-proof.json').read_bytes()
        need(digest(raw_proof) == plan['buildProofSha256'], 'PROOF_CHANGED')
        proof = validate_proof(json.loads(raw_proof), plan, contract, payload, h)
        models = {n: h.configuration(d, before[n]) for n in ('api', 'online-recharge')}
        images = {}
        for role in ('api',):
            original = json.loads(d.run('docker', 'image', 'inspect', before[role]['image']))[0]
            reference = h.base_image_reference(d, before[role])
            a.normalize_image_context(payload / role)
            lines = 'FROM ' + reference + '\n' + ('COPY modules/ /app/apps/api/dist/\n' if role == 'api' else 'COPY html/ /usr/share/nginx/html/\n')
            label = 'id-business-v2.recharge-record-build-proof-sha256'
            lines += 'LABEL org.opencontainers.image.revision="' + plan['commit'] + '" ' + label + '="' + plan['buildProofSha256'] + '"\n'
            (payload / role / 'Dockerfile').write_text(lines)
            image = 'id-business-v2-checkout:' + plan['commit'] + '-' + plan['workflowRunId'] + '-' + role
            h.build_image(d, payload / role, image, role, before[role], stage)
            built = json.loads(d.run('docker', 'image', 'inspect', image))[0]
            need(built['RootFS']['Layers'][:len(original['RootFS']['Layers'])] == original['RootFS']['Layers'], 'BASE_LAYERS_CHANGED')
            verify_image_configuration(original['Config'], built['Config'])
            need(built['Config']['Labels'] == {**(original['Config'].get('Labels') or {}), 'org.opencontainers.image.revision': plan['commit'], label: plan['buildProofSha256']}, 'IMAGE_LABELS_CHANGED')
            images[role] = {'reference': image, 'imageId': built['Id']}
        need(baseline(d, contract, h, plan['runtimeBaseline']) == (previous, raw_manifest, before), 'BASELINE_MOVED')
        backup = h.fresh_scoped_backup(d, previous, plan, normalizer_path=Path(contract['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-recharge-source-recovery')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(previous, target, symlinks=True)
        for name in contract['sources']:
            destination = target / name
            need(destination.resolve().is_relative_to(target) and not destination.is_symlink(), 'HOST_SOURCE_PATH_INVALID')
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((payload / 'source' / name).read_bytes())
            destination.chmod(0o644)
        for name, expected in plan['controlSources'].items():
            raw = Path(__file__).with_name(name).read_bytes()
            need(digest(raw) == expected, 'EXECUTOR_CHANGED')
            path = target / 'scripts/production-release' / name
            need(not path.is_symlink() and path.resolve().is_relative_to(target), 'EXECUTOR_PATH_INVALID')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        override = json.loads((target / 'compose.release.json').read_bytes())
        for role in images:
            override['services'][role]['image'] = images[role]['reference']
        a.write_release_override(target / 'compose.release.json', override)
        need(baseline(d, contract, h, plan['runtimeBaseline']) == (previous, raw_manifest, before), 'BASELINE_MOVED')
        h.guards(d, previous, before, contract)
        state_path = stage / 'switch-state.json'
        state_path.write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target), 'previous': str(previous)}) + '\n')
        d.compose(previous, 'stop', 'online-recharge', timeout=90)
        d.compose(target, 'up', '-d', '--no-deps', 'api', timeout=180)
        for role in ('api',):
            d.wait_healthy(target, role)
        d.compose(target, 'up', '-d', '--no-deps', '--force-recreate', 'online-recharge', timeout=180)
        d.wait_healthy(target, 'online-recharge')
        h.engine_idle(d, h.snapshot(d, target)['online-recharge'], contract, wait_connected=True)
        after = h.snapshot(d, target)
        need(all(after[n] == before[n] for n in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
        for role in ('api', 'online-recharge'):
            need(h.configuration(d, after[role]) == models[role] and after[role]['environmentSha256'] == before[role]['environmentSha256'], 'RUNTIME_CONFIGURATION_CHANGED')
        need(all(after[n]['image'] == images[n]['imageId'] for n in images) and after['online-recharge']['image'] == before['online-recharge']['image'], 'RUNTIME_IMAGE_CHANGED')
        online = json.loads(d.run('docker', 'inspect', after['online-recharge']['containerId']))[0]
        need(online['HostConfig']['NetworkMode'] == 'container:' + after['api']['containerId'], 'ONLINE_BINDING_CHANGED')
        smoke(d, target, proof, after, contract, h)
        receipt = {'status': 'RECHARGE_SOURCE_RECOVERY_DEPLOYED', 'commit': plan['commit'], 'tree': plan['tree'], 'before': before, 'after': after, 'images': images, 'backup': backup, 'workflowRunId': plan['workflowRunId'], 'businessActions': 0, 'migrationPerformed': False}
        (target / 'recharge-source-recovery-preservation.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
        (target / 'recharge-source-recovery-build-proof.json').write_bytes(raw_proof)
        manifest = json.loads(raw_manifest)
        manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=contract['scope'], status='DEPLOYED', previousCommit=contract['expectedCurrent'], previousRelease=str(previous), previousManifestSha256=digest(raw_manifest), servicesUpdated=['api'], dependentServiceRebound='online-recharge', newMigrations=[], migrationPerformed=False, paymentActions=0, validationRun=plan['workflowRunId'], actualDeployment=receipt, sourceProjection={'sourceBaseline': contract['sourceBaseline'], 'changedSources': contract['sources'], 'apiModules': proof['apiModules'], 'buildProofSha256': plan['buildProofSha256']}, sourceLayout='PUBLISHED_PREDECESSOR_WITH_NATIVE_CHECKOUT_OVERLAY', deploymentMethod='NATIVE_CI_APPROVED_SSM_FORWARD', compiledArtifact={'url': plan['artifactUrl'], 'sha256': plan['artifactSha256'], 'validationRun': plan['workflowRunId']})
        for field in ('acceptedSwitchCommandId', 'publicationFinalization', 'deploymentRun'):
            manifest.pop(field, None)
        for role in images:
            manifest['images'][role] = {'reference': images[role]['reference'], 'digest': images[role]['imageId'], 'sourceCommit': plan['commit']}
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-recharge-source-recovery')
        state_path.write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target), 'commit': plan['commit']}) + '\n')
        return {k: receipt[k] for k in ('status', 'commit', 'tree', 'images', 'workflowRunId', 'businessActions', 'migrationPerformed')}
