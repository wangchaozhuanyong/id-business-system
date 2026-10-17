"""Finite Admin-only fresh Session preflight publication; preserve seven services."""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = Path('/opt/id-business-v2')
SCOPE = 'ONLINE_SESSION_SUBSCRIPTION_PREFLIGHT'
SOURCE_BASE = '0d76d6ca0c287750d2d04f16c80e9d63a334b84b'
CONTRACT_FILE = 'online-session-preflight-contract.json'
WORKFLOW = '.github/workflows/online-session-preflight-validation.yml'
UPDATED = ('admin',)
PRESERVED = ('api', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration', 'online-recharge')
SERVICES = (*UPDATED, *PRESERVED)
APPLICATION = frozenset(('apps/admin/src/v2/features/online-recharge/sections.ts',
    'apps/admin/src/v2/features/online-recharge/api.spec.ts', 'docs/ONLINE_RECHARGE.md', 'docs/V2_TASKS.md'))
RUNTIME_SOURCE = 'apps/admin/src/v2/features/online-recharge/sections.ts'
SELECTION_CONTROLS = frozenset((WORKFLOW,
    *['scripts/production-release/online-session-preflight-' + suffix
      for suffix in ('build.py', 'release.py', 'release.test.py', 'contract.json')],
    'scripts/ci-online-settings-scope.mjs', 'scripts/ci-online-settings-scope.test.mjs',
    'scripts/ci-recharge-scope.mjs', 'scripts/ci-recharge-scope.test.mjs'))
QUALITY_PARTS = ('guards', 'admin')
SCOPE_CONTROLS = frozenset(('scripts/ci-online-settings-scope.mjs', 'scripts/ci-online-settings-scope.test.mjs',
    'scripts/ci-recharge-scope.mjs', 'scripts/ci-recharge-scope.test.mjs'))
RECONSTRUCTION_FILES = frozenset(('online-pending-features-build.py', 'online-pending-features-release.py',
    'online-pending-features-contract.json', 'recharge-checkout-build.py', 'recharge-checkout-contract.json',
    'recharge-record-build.py', 'registration-flow-v4-build.py', 'registration-flow-v4-contract.json',
    'registration-flow-v4-release.py'))
PREDECESSOR_REVIEW = 'a1e65b996b0c527a562a14c470b5c7650a00bd25'
PREDECESSOR_PROOF_SHA256 = '0a2eae3b0f70d521eb74def9e8448b6efab9e873ea2cfe64ec7c69d210e808f4'
PREDECESSOR_ADMIN_IMAGE = 'sha256:5c16095333b6d9e35ffbd0bc246a60935259ef382859106e8581353a4a92a03d'
HEALTH = {'ready': True, 'mode': 'enabled', 'activeTasks': 0, 'stopping': False, 'rpcConnected': True}
CONTROLS = frozenset(('online-session-preflight-build.py', 'online-session-preflight-release.py',
    'online-session-preflight-release.test.py', 'remote-deploy.py', 'recharge-record-release.py',
    'recharge-availability-release.py', 'recharge-source-recovery-release.py',
    'online-checkout-release.py', 'online-checkout-load-release.py', 'registration-closure-dispatch.py',
    'proxy-result-identity-release.py'))


def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_SESSION_PREFLIGHT_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def fingerprint(value):
    return sha(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())


def load(name):
    spec = importlib.util.spec_from_file_location('session_preflight_' + name.replace('-', '_'), HERE / name)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def inventory_valid(value):
    return type(value) is dict and bool(value) and all(type(name) is str
        and re.fullmatch('[A-Za-z0-9_./-]+', name) and not name.startswith('/')
        and '..' not in Path(name).parts and type(digest) is str
        and re.fullmatch('[a-f0-9]{64}', digest) for name, digest in value.items())


def validate_contract(c, *, require_baseline=True):
    need(c.get('version') == 1 and c.get('scope') == SCOPE
         and c.get('reviewBase') == SOURCE_BASE and c.get('expectedCurrent') == SOURCE_BASE
         and re.fullmatch('[a-f0-9]{40}', c.get('sourceReviewCommit', ''))
         and c.get('sourceReviewTag') == 'online-session-preflight-source-review-' + c['sourceReviewCommit'][:12]
         and inventory_valid(c.get('reviewedControlSources')) and set(c['reviewedControlSources']) == SCOPE_CONTROLS
         and c.get('requiredQualityParts') == list(QUALITY_PARTS)
         and c.get('updatedServices') == list(UPDATED) and c.get('preservedServices') == list(PRESERVED)
         and c.get('migrationPerformed') is False and type(c.get('businessActions')) is int
         and c['businessActions'] == 0, 'CONTRACT_IDENTITY_INVALID')
    need(inventory_valid(c.get('sources')) and set(c['sources']) == APPLICATION
         and inventory_valid(c.get('controlPins')) and set(c['controlPins']) == CONTROLS
         and re.fullmatch('[a-f0-9]{64}', c.get('workflowSha256', '')), 'SOURCE_SCOPE_CHANGED')
    r = c.get('reconstruction', {})
    need(r.get('publishedAdminCommit') == SOURCE_BASE
         and r.get('reviewCommit') == PREDECESSOR_REVIEW
         and r.get('predecessorProofSha256') == PREDECESSOR_PROOF_SHA256
         and inventory_valid(r.get('pins')) and set(r['pins']) == RECONSTRUCTION_FILES
         and inventory_valid(r.get('publishedAdminSources'))
         and inventory_valid(r.get('publishedAdminFiles')) and len(r['publishedAdminFiles']) == 262,
         'PUBLISHED_RECONSTRUCTION_CHANGED')
    b = c.get('baseline')
    if b is None:
        need(not require_baseline, 'BASELINE_NOT_BOUND')
        return
    need(b.get('commit') == SOURCE_BASE
         and re.fullmatch('/opt/id-business-v2/releases/[A-Za-z0-9_-]+', b.get('current', ''))
         and re.fullmatch('[a-f0-9]{64}', b.get('manifestSha256', ''))
         and set(b.get('services', {})) == set(SERVICES)
         and b['services']['admin'].get('image') == PREDECESSOR_ADMIN_IMAGE
         and inventory_valid(b.get('runtimeConfigurationSha256'))
         and set(b['runtimeConfigurationSha256']) == set(SERVICES)
         and inventory_valid(b.get('configurationSha256'))
         and set(b['configurationSha256']) == {'.env.aws.production', 'compose.release.json', 'docker-compose.aws-mysql.yml'}
         and inventory_valid(b.get('adminFiles')) and inventory_valid(b.get('apiOnlineFiles'))
         and inventory_valid(b.get('engineFiles')) and b.get('engineHealth') == HEALTH
         and all(b['adminFiles'].get(name) == digest for name, digest in r['publishedAdminFiles'].items())
         and re.fullmatch('[a-f0-9]{64}', b.get('nginxSha256', '')),
         'BASELINE_CHANGED')
    need(b.get('backupNormalizerSha256') == 'ca9b05f832e9ed73bb36b7e76c083c99a40b13e067850166f8715bae469e5202'
         and re.fullmatch('/opt/id-business-v2/releases/[A-Za-z0-9_-]+/scripts/mysql-dump-restore-normalizer.sed',
                          b.get('backupNormalizerPath', '')), 'BACKUP_NORMALIZER_CHANGED')


def artifact_url(commit):
    return ('https://github.com/wangchaozhuanyong/id-business-system/releases/download/'
            'online-session-preflight-' + commit + '/online-session-preflight-artifact.tar.gz')


def validate_quality(evidence, commit, tree):
    load('online-checkout-load-release.py').validate_quality(evidence, commit, tree)


def validate_plan(plan, c):
    validate_contract(c)
    need(plan.get('mode') in ('preflight', 'release', 'readback')
         and all(re.fullmatch('[a-f0-9]{40}', plan.get(key, '')) for key in ('commit', 'tree'))
         and all(re.fullmatch('[1-9][0-9]*', plan.get(key, '')) for key in ('workflowRunId', 'workflowRunAttempt'))
         and plan.get('contractSha256') == sha((HERE / CONTRACT_FILE).read_bytes())
         and c == json.loads((HERE / CONTRACT_FILE).read_bytes())
         and plan.get('controlSources') == c['controlPins']
         and plan.get('artifactUrl') == artifact_url(plan['commit'])
         and all(re.fullmatch('[a-f0-9]{64}', plan.get(key, '')) for key in ('artifactSha256', 'buildProofSha256')),
         'PLAN_BINDING_CHANGED')
    validate_quality(plan.get('qualitySourceEvidence'), plan['commit'], plan['tree'])


def verify_proof(proof, plan, c, files):
    validate_contract(c)
    need(proof.get('version') == 1 and proof.get('scope') == SCOPE
         and all(proof.get(key) == plan.get(key) for key in (
             'commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controlSources', 'qualitySourceEvidence'))
         and proof.get('workflow') == WORKFLOW and proof.get('workflowSha256') == c['workflowSha256']
         and proof.get('sources') == c['sources'] and proof.get('baselineAdminSourceReproduced') is True
         and proof.get('baselineAdminFiles') == c['reconstruction']['publishedAdminFiles']
         and proof.get('updatedServices') == list(UPDATED) and proof.get('preservedServices') == list(PRESERVED)
         and proof.get('migrationPerformed') is False and type(proof.get('businessActions')) is int
         and proof['businessActions'] == 0 and inventory_valid(proof.get('adminFiles')),
         'PROOF_CHANGED')
    parts, quality = proof.get('qualityPartEvidence', {}), proof['qualitySourceEvidence']
    need(parts.get('parts') == list(QUALITY_PARTS) and parts.get('runId') == quality.get('runId')
         and parts.get('runAttempt') == quality.get('runAttempt') and parts.get('testedTree') == plan['tree']
         and set(parts.get('jobs', {})) == set(QUALITY_PARTS)
         and all(type(value) is int and value > 0 for value in parts['jobs'].values()), 'QUALITY_PARTS_MISSING')
    validate_quality(quality, plan['commit'], plan['tree'])
    expected = {**{'source/' + name: value for name, value in c['sources'].items()},
                **{'admin/html/' + name: value for name, value in proof['adminFiles'].items()}}
    need(files == expected == proof.get('files') and 'index.html' in proof['adminFiles']
         and any(name.startswith('assets/index-') and name.endswith('.js') for name in proof['adminFiles']), 'PAYLOAD_SCOPE_CHANGED')


def download_artifact(plan):
    need(plan['artifactUrl'] == artifact_url(plan['commit']), 'ARTIFACT_LOCATION_INVALID')
    with urllib.request.urlopen(plan['artifactUrl'], timeout=60) as response:
        raw = response.read(24 * 1024**2 + 1)
    need(0 < len(raw) <= 24 * 1024**2 and sha(raw) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
    return raw


def read_admin_inventory(d, state, expected):
    need(inventory_valid(expected), 'ADMIN_INVENTORY_INVALID')
    load('online-checkout-release.py').read_hashes(d, state['containerId'], '/usr/share/nginx/html/', expected)
    names = d.run('docker', 'exec', state['containerId'], 'find', '/usr/share/nginx/html', '-type', 'f', timeout=30).splitlines()
    need(set(name.removeprefix('/usr/share/nginx/html/') for name in names) == set(expected), 'ADMIN_INVENTORY_CHANGED')


def verify_preserved_content(d, states, b):
    load('online-checkout-release.py').read_hashes(d, states['api']['containerId'],
        '/app/apps/api/dist/id-business-v2/online-recharge/', b['apiOnlineFiles'])
    load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], b['engineFiles'])
    metadata = json.loads(d.run('docker', 'inspect', states['online-recharge']['containerId']))[0]
    need(metadata['HostConfig']['NetworkMode'] == 'container:' + states['api']['containerId'], 'API_NAMESPACE_CHANGED')


def baseline(d, c, h):
    b = c['baseline']
    previous = (BASE / 'current').resolve()
    need(str(previous) == b['current'] and previous.parent == BASE / 'releases', 'CURRENT_CHANGED')
    raw = (previous / 'release-manifest.json').read_bytes()
    need(sha(raw) == b['manifestSha256'] and json.loads(raw).get('commit') == SOURCE_BASE, 'MANIFEST_CHANGED')
    need(sha((previous / 'online-checkout-build-proof.json').read_bytes()) == PREDECESSOR_PROOF_SHA256,
         'PREDECESSOR_PROOF_CHANGED')
    states = h.snapshot(d, previous)
    need(states == b['services']
         and {role: h.configuration(d, state) for role, state in states.items()} == b['runtimeConfigurationSha256'], 'SERVICES_CHANGED')
    need(all(sha((previous / name).read_bytes()) == digest for name, digest in b['configurationSha256'].items()), 'CONFIGURATION_CHANGED')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    normalizer = Path(b['backupNormalizerPath'])
    need(not normalizer.is_symlink() and sha(normalizer.read_bytes()) == b['backupNormalizerSha256'], 'BACKUP_NORMALIZER_CHANGED')
    read_admin_inventory(d, states['admin'], b['adminFiles'])
    verify_preserved_content(d, states, b)
    need(d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum', '/etc/nginx/conf.d/default.conf').split()[0]
         == b['nginxSha256'], 'NGINX_CHANGED')
    h.guards(d, previous, states, b)
    return previous, raw, states


def smoke(d, target, states, proof, c, h):
    b = c['baseline']
    need(all(states[role] == b['services'][role] for role in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
    need(states['admin']['environmentSha256'] == b['services']['admin']['environmentSha256']
         and {role: h.configuration(d, state) for role, state in states.items()} == b['runtimeConfigurationSha256'], 'RUNTIME_CONFIGURATION_CHANGED')
    read_admin_inventory(d, states['admin'], {**b['adminFiles'], **proof['adminFiles']})
    verify_preserved_content(d, states, b)
    need(d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum', '/etc/nginx/conf.d/default.conf').split()[0]
         == b['nginxSha256'], 'NGINX_CHANGED')
    need(all(not (target / name).is_symlink() and sha((target / name).read_bytes()) == digest
             for name, digest in c['sources'].items()), 'HOST_SOURCE_CHANGED')
    need(sha((target / 'scripts/production-release' / CONTRACT_FILE).read_bytes()) == sha((HERE / CONTRACT_FILE).read_bytes())
         and all(sha((target / 'scripts/production-release' / name).read_bytes()) == digest
                 for name, digest in c['controlPins'].items()), 'READBACK_CONTROL_CHANGED')
    need(all(sha((target / name).read_bytes()) == digest for name, digest in b['configurationSha256'].items()
             if name != 'compose.release.json'), 'HOST_CONFIGURATION_CHANGED')
    before_override = json.loads((Path(b['current']) / 'compose.release.json').read_bytes())
    current_override = json.loads((target / 'compose.release.json').read_bytes())
    before_override['services']['admin']['image'] = states['admin']['reference']
    need(current_override == before_override, 'OVERRIDE_SCOPE_CHANGED')


def release(plan, c):
    validate_plan(plan, c)
    need(all(sha((HERE / name).read_bytes()) == digest for name, digest in c['controlPins'].items()), 'CONTROL_SOURCE_CHANGED')
    h = load('recharge-record-release.py')
    d = h.load_utilities(HERE / 'remote-deploy.py', c['controlPins']['remote-deploy.py'])
    a = load('recharge-availability-release.py')
    with (BASE / '.deploy.lock').open('a') as lock:
        a.acquire_release_lock(lock)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve()
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            need(manifest.get('commit') == plan['commit'] and manifest.get('sourceTree') == plan['tree']
                 and manifest.get('scope') == SCOPE, 'READBACK_CURRENT_CHANGED')
            receipt = json.loads((target / 'online-session-preflight-preservation.json').read_bytes())
            raw_proof = (target / 'online-session-preflight-build-proof.json').read_bytes()
            need(sha(raw_proof) == plan['buildProofSha256'], 'READBACK_PROOF_CHANGED')
            proof = json.loads(raw_proof)
            verify_proof(proof, plan, c, proof['files'])
            states = h.snapshot(d, target)
            need(states == receipt['after'] and states['admin']['image'] == receipt['images']['admin']['imageId'], 'READBACK_SERVICES_CHANGED')
            smoke(d, target, states, proof, c, h)
            return {'status': 'ONLINE_SESSION_PREFLIGHT_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'],
                    'updatedServices': list(UPDATED), 'preservedServices': list(PRESERVED), 'migrationPerformed': False, 'businessActions': 0}
        previous, raw_manifest, before = baseline(d, c, h)
        if plan['mode'] == 'preflight':
            return {'status': 'ONLINE_SESSION_PREFLIGHT_VERIFIED', 'commit': plan['commit'], 'businessActions': 0}
        stage = BASE / '.staging' / ('online-session-preflight-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        payload = h.safe_archive(download_artifact(plan), stage / 'content')
        raw_proof = (payload / 'build-proof.json').read_bytes()
        need(sha(raw_proof) == plan['buildProofSha256'], 'PROOF_CHANGED')
        proof = json.loads(raw_proof)
        files = h.file_inventory(payload)
        files.pop('build-proof.json')
        verify_proof(proof, plan, c, files)
        context = stage / 'image-admin'
        shutil.copytree(payload / 'admin', context)
        a.normalize_image_context(context)
        original = json.loads(d.run('docker', 'image', 'inspect', before['admin']['image']))[0]
        reference = 'id-business-v2-online-session-preflight:' + plan['commit'] + '-' + plan['workflowRunId'] + '-admin'
        base_ref = h.base_image_reference(d, before['admin'])
        (context / 'Dockerfile').write_text('FROM ' + base_ref + '\nCOPY html/ /usr/share/nginx/html/\n'
            + 'LABEL org.opencontainers.image.revision="' + plan['commit']
            + '" id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n')
        h.build_image(d, context, reference, 'admin', before['admin'], stage)
        built = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
        load('online-checkout-release.py').verify_image(original, built, plan)
        images = {'admin': {'reference': reference, 'imageId': built['Id']}}
        baseline(d, c, h)
        backup = h.fresh_scoped_backup(d, previous, plan, normalizer_path=Path(c['baseline']['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-online-session-preflight')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(previous, target, symlinks=True)
        for name, digest in c['sources'].items():
            path = target / name
            need(path.resolve().is_relative_to(target) and not path.is_symlink(), 'HOST_SOURCE_PATH_CHANGED')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((payload / 'source' / name).read_bytes())
            path.chmod(0o644)
        for name in (*c['controlPins'], CONTRACT_FILE):
            path = target / 'scripts/production-release' / name
            path.write_bytes((HERE / name).read_bytes())
        override = json.loads((target / 'compose.release.json').read_bytes())
        override['services']['admin']['image'] = reference
        (target / 'compose.release.json').write_text(json.dumps(override, sort_keys=True, indent=2) + '\n')
        (target / 'compose.release.json').chmod(0o600)
        baseline(d, c, h)
        journal = stage / 'switch-state.json'
        journal.write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target), 'previous': str(previous)}) + '\n')
        try:
            # Static Admin publication never restarts the API or payment worker.
            d.compose(target, 'up', '-d', '--no-deps', 'admin', timeout=180)
            d.wait_healthy(target, 'admin')
            after = h.snapshot(d, target)
            need(after['admin']['image'] == built['Id'], 'IMAGE_CHANGED')
            smoke(d, target, after, proof, c, h)
        except BaseException:
            journal.write_text(json.dumps({'status': 'SWITCH_FAILED', 'target': str(target),
                'previous': str(previous), 'businessActions': 0}) + '\n')
            raise
        receipt = {'status': 'DEPLOYED', 'commit': plan['commit'], 'before': before, 'after': after,
            'images': images, 'backup': backup, 'artifactSha256': plan['artifactSha256'],
            'buildProofSha256': plan['buildProofSha256'], 'updatedServices': list(UPDATED),
            'preservedServices': list(PRESERVED), 'migrationPerformed': False, 'businessActions': 0}
        (target / 'online-session-preflight-preservation.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
        (target / 'online-session-preflight-build-proof.json').write_bytes(raw_proof)
        manifest = json.loads(raw_manifest)
        manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=SCOPE,
            previousCommit=SOURCE_BASE, previousRelease=str(previous), previousManifestSha256=sha(raw_manifest),
            status='DEPLOYED', servicesUpdated=list(UPDATED), newMigrations=[], migrationPerformed=False,
            paymentActions=0, onlineSessionPreflightPublication=receipt)
        manifest['images']['admin'] = {'reference': reference, 'digest': built['Id'], 'sourceCommit': plan['commit']}
        projections = manifest.setdefault('roleSourceProjections', {})
        projections['admin'] = {'kind': 'PUBLISHED_PREDECESSOR_PLUS_SESSION_PREFLIGHT', 'commit': plan['commit'],
            'parentProjection': projections.get('admin'), 'buildProofSha256': plan['buildProofSha256'],
            'sources': {RUNTIME_SOURCE: c['sources'][RUNTIME_SOURCE]}}
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-online-session-preflight')
        journal.write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target), 'commit': plan['commit']}) + '\n')
        return {'status': 'ONLINE_SESSION_PREFLIGHT_DEPLOYED', 'commit': plan['commit'], 'images': images,
            'updatedServices': list(UPDATED), 'preservedServices': list(PRESERVED), 'migrationPerformed': False, 'businessActions': 0}
