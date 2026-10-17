"""Finite engine-only checkout loading repair. No API/Admin replacement or payment."""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import urllib.request

BASE = Path('/opt/id-business-v2')
HERE = Path(__file__).resolve().parent
SCOPE = 'ONLINE_CHECKOUT_LOAD_RECOVERY'
CONTRACT_FILE = 'online-checkout-load-contract.json'
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine'
SOURCE_BASE = 'a0e633a610ff67400cc2fa8bd2926148a2479ecd'
FILES = frozenset(('SOURCE_MANIFEST.json', 'checkout-form.cjs', 'checkout-recovery.cjs',
    'safe-media.cjs', 'upstream/chatgpt.js', 'upstream/human-verification.js', 'upstream/index.js',
    'test/checkout-form.test.cjs', 'test/checkout-recovery.test.cjs', 'test/verification-state.test.cjs',
    'test/checkout-load-recovery.test.cjs', 'test/checkout-navigation.test.cjs',
    'test/recharge-flow-acceptance.test.cjs', 'test/regressions.test.cjs',
    'test/safe-media-finish.test.cjs'))
ADDED = frozenset(('test/checkout-navigation.test.cjs',))
VALIDATION = frozenset(('apps/api/src/id-business-v2/online-recharge/local-chain-acceptance.spec.ts',
    'docs/ONLINE_RECHARGE.md', 'docs/V2_TASKS.md'))
PRESERVED = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration')
SERVICES = (*PRESERVED, 'online-recharge')
CONTROLS = frozenset(('api-admin-scope.py', 'remote-deploy.py', 'recharge-record-release.py',
    'recharge-availability-release.py', 'proxy-result-identity-release.py', 'shared-bank-card-release.py',
    'online-checkout-release.py', 'recharge-source-recovery-release.py',
    'registration-closure-dispatch.py',
    'online-checkout-load-release.py', 'online-checkout-load-build.py',
    'online-checkout-load-release.test.py'))
HEALTH = {'ready': True, 'mode': 'enabled', 'activeTasks': 0, 'stopping': False, 'rpcConnected': True}
SQL_FENCE = '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925'
WORKFLOW = '.github/workflows/online-checkout-load-validation.yml'


def need(ok, code):
    if not ok:
        raise RuntimeError('ONLINE_CHECKOUT_LOAD_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def fingerprint(value):
    return sha(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())


def load(name):
    path = HERE / name
    spec = importlib.util.spec_from_file_location('checkout_load_' + name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def inventory_valid(value):
    return type(value) is dict and bool(value) and all(
        type(name) is str and re.fullmatch('[A-Za-z0-9_./-]+', name)
        and not name.startswith('/') and '..' not in Path(name).parts
        and type(digest) is str and re.fullmatch('[a-f0-9]{64}', digest)
        for name, digest in value.items())


def validate_contract(c, *, require_baseline=True):
    need(c.get('version') == 1 and c.get('scope') == SCOPE and c.get('engineRoot') == ENGINE,
         'CONTRACT_IDENTITY_INVALID')
    need(c.get('sourceBaseCommit') == SOURCE_BASE,
         'SOURCE_BASE_INVALID')
    need(set(c.get('runtimeSources', {})) == {ENGINE + '/' + name for name in FILES}
         and set(c.get('validationSources', {})) == VALIDATION
         and inventory_valid(c['runtimeSources']) and inventory_valid(c['validationSources']),
         'SOURCE_SCOPE_CHANGED')
    before, after = c.get('beforeEngineFiles'), c.get('afterEngineFiles')
    need(inventory_valid(before) and inventory_valid(after)
         and set(after) == set(before) | ADDED and not set(before) & ADDED
         and {name for name in after if before.get(name) != after[name]} == FILES
         and all(c['runtimeSources'][ENGINE + '/' + name] == after[name] for name in FILES),
         'ENGINE_SCOPE_CHANGED')
    need(c.get('engineHealth') == HEALTH and c.get('sqlFenceHelperSha256') == SQL_FENCE,
         'GUARD_BINDING_CHANGED')
    need(re.fullmatch('[a-f0-9]{64}', c.get('workflowSha256', '')) is not None,
         'WORKFLOW_BINDING_CHANGED')
    pins = c.get('controlPins', {})
    need(set(pins) == CONTROLS and inventory_valid(pins) and pins.get('api-admin-scope.py') == SQL_FENCE
         and all(not (HERE / name).is_symlink() and sha((HERE / name).read_bytes()) == digest
                 for name, digest in pins.items()), 'CONTROL_CHANGED')
    baseline = c.get('baseline')
    if baseline is None:
        need(not require_baseline, 'BASELINE_NOT_BOUND')
        return
    need(type(baseline) is dict and Path(baseline.get('current', '')).parent == BASE / 'releases'
         and re.fullmatch('[a-f0-9]{40}', baseline.get('commit', '')) is not None
         and re.fullmatch('[a-f0-9]{64}', baseline.get('manifestSha256', '')) is not None
         and set(baseline.get('services', {})) == set(SERVICES)
         and set(baseline.get('runtimeConfigurationSha256', {})) == set(SERVICES)
         and set(baseline.get('configurationSha256', {})) == {
             '.env.aws.production', 'compose.release.json', 'docker-compose.aws-mysql.yml'}
         and baseline.get('engineFiles') == before and baseline.get('engineHealth') == HEALTH,
         'BASELINE_INVALID')
    need(all(re.fullmatch('[a-f0-9]{64}', digest) for digest in
             [*baseline['runtimeConfigurationSha256'].values(), *baseline['configurationSha256'].values()])
         and Path(baseline.get('backupNormalizerPath', '')).is_relative_to(BASE / 'releases')
         and baseline.get('backupNormalizerSha256') ==
             'ca9b05f832e9ed73bb36b7e76c083c99a40b13e067850166f8715bae469e5202',
         'BASELINE_CONFIGURATION_INVALID')


def validate_plan(plan, c):
    validate_contract(c)
    need(plan.get('mode') in ('preflight', 'release', 'readback')
         and all(re.fullmatch('[a-f0-9]{40}', plan.get(key, '')) for key in ('commit', 'tree'))
         and all(re.fullmatch('[1-9][0-9]*', plan.get(key, ''))
                 for key in ('workflowRunId', 'workflowRunAttempt'))
         and plan.get('contractSha256') == sha((HERE / CONTRACT_FILE).read_bytes())
         and c == json.loads((HERE / CONTRACT_FILE).read_bytes())
         and plan.get('controlSources') == c['controlPins'], 'PLAN_BINDING_CHANGED')
    need(all(re.fullmatch('[a-f0-9]{64}', plan.get(key, ''))
             for key in ('artifactSha256', 'buildProofSha256'))
         and plan.get('artifactUrl') == artifact_url(plan['commit']), 'ARTIFACT_BINDING_INVALID')
    validate_quality(plan.get('qualitySourceEvidence'), plan['commit'], plan['tree'])


def artifact_url(commit):
    return ('https://github.com/wangchaozhuanyong/id-business-system/releases/download/'
            'online-checkout-load-' + commit + '/online-checkout-load-artifact.tar.gz')


def validate_quality(evidence, commit, tree):
    need(type(evidence) is dict and re.fullmatch('[1-9][0-9]*', evidence.get('runId', '')) is not None
         and type(evidence.get('runAttempt')) is int and evidence['runAttempt'] > 0
         and evidence.get('testedTree') == tree, 'QUALITY_SOURCE_INVALID')
    if evidence.get('kind') == 'EXACT_MAIN_SUCCESS':
        need(evidence.get('commit') == commit, 'QUALITY_SOURCE_INVALID')
        return
    proof = evidence.get('proof', {})
    need(evidence.get('kind') == 'IDENTICAL_PR_TESTED_TREE'
         and type(evidence.get('pullRequest')) is int and evidence['pullRequest'] > 0
         and re.fullmatch('sha256:[a-f0-9]{64}', evidence.get('artifactDigest', '')) is not None
         and type(proof) is dict and proof.get('repository') == 'wangchaozhuanyong/id-business-system'
         and proof.get('runId') == int(evidence['runId'])
         and proof.get('runAttempt') == evidence['runAttempt']
         and proof.get('pullRequest') == evidence['pullRequest'] and proof.get('testedTree') == tree
         and all(re.fullmatch('[a-f0-9]{40}', proof.get(key, '')) for key in ('headSha', 'baseSha')),
         'QUALITY_SOURCE_INVALID')


def verify_proof(proof, plan, c, files):
    validate_quality(proof.get('qualitySourceEvidence'), plan['commit'], plan['tree'])
    expected = {'engine/' + name: c['afterEngineFiles'][name] for name in FILES}
    need(proof.get('version') == 1 and proof.get('scope') == SCOPE
         and all(proof.get(key) == plan[key] for key in ('commit', 'tree', 'workflowRunId',
             'workflowRunAttempt', 'contractSha256', 'controlSources'))
         and proof.get('runtimeSources') == c['runtimeSources']
         and proof.get('controlSources') == c['controlPins']
         and proof.get('qualitySourceEvidence') == plan.get('qualitySourceEvidence')
         and proof.get('validationSources') == c['validationSources']
         and proof.get('beforeEngineFiles') == c['beforeEngineFiles']
         and proof.get('afterEngineFiles') == c['afterEngineFiles']
         and proof.get('baselineSha256') == fingerprint(c['baseline'])
         and proof.get('workflow') == WORKFLOW
         and proof.get('workflowSha256') == c['workflowSha256']
         and proof.get('updatedServices') == ['online-recharge']
         and proof.get('preservedServices') == list(PRESERVED)
         and proof.get('migrationPerformed') is False
         and type(proof.get('businessActions')) is int and proof['businessActions'] == 0
         and files == expected == proof.get('files'), 'NATIVE_PROOF_CHANGED')


def verify_runtime(d, h, states, c, *, original):
    baseline = c['baseline']
    need(all(states[role] == original[role] for role in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
    need(states['online-recharge']['environmentSha256'] == original['online-recharge']['environmentSha256'],
         'ENVIRONMENT_CHANGED')
    shared = load('shared-bank-card-release.py')
    need(all(shared.configuration_matches(h, d, row, baseline['runtimeConfigurationSha256'][role])
             for role, row in states.items()), 'RUNTIME_CONFIGURATION_CHANGED')
    metadata = json.loads(d.run('docker', 'inspect', states['online-recharge']['containerId']))[0]
    need(metadata['HostConfig']['NetworkMode'] == 'container:' + states['api']['containerId'],
         'API_NAMESPACE_CHANGED')
    if 'adminIndexSha256' in baseline:
        index = d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum',
                      '/usr/share/nginx/html/index.html', timeout=15)
        need(index.split()[0] == baseline['adminIndexSha256'], 'PRESERVED_ADMIN_INDEX_CHANGED')


def baseline(d, h, c):
    binding = c['baseline']
    current = (BASE / 'current').resolve()
    raw = (current / 'release-manifest.json').read_bytes()
    need(str(current) == binding['current'] and sha(raw) == binding['manifestSha256']
         and json.loads(raw).get('commit') == binding['commit'], 'BASELINE_CHANGED')
    states = h.snapshot(d, current)
    need(states == binding['services'] and all(sha((current / name).read_bytes()) == digest
         for name, digest in binding['configurationSha256'].items()), 'BASELINE_CHANGED')
    verify_runtime(d, h, states, c, original=binding['services'])
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    normalizer = Path(binding['backupNormalizerPath'])
    need(not normalizer.is_symlink() and normalizer.is_file()
         and sha(normalizer.read_bytes()) == binding['backupNormalizerSha256'], 'BACKUP_NORMALIZER_CHANGED')
    h.guards(d, current, states, c)
    load('online-checkout-release.py').read_hashes(d, states['online-recharge']['containerId'],
        '/workspace/engine/', c['beforeEngineFiles'])
    return current, raw, states


def switch_engine(d, current, target, fence):
    try:
        fence.acquire()
        d.compose(current, 'stop', 'online-recharge', timeout=90)
        fence.check_idle()
        fence.close()
        d.compose(target, 'up', '-d', '--no-deps', 'online-recharge', timeout=180)
        d.wait_healthy(target, 'online-recharge')
    finally:
        fence.close()


def release(plan, c):
    validate_plan(plan, c)
    h, old = load('recharge-record-release.py'), load('online-checkout-release.py')
    d = h.load_utilities(HERE / 'remote-deploy.py', c['controlPins']['remote-deploy.py'])
    a, p = load('recharge-availability-release.py'), load('proxy-result-identity-release.py')
    p.SCOPE = SCOPE
    with (BASE / '.deploy.lock').open('a') as lock:
        a.acquire_release_lock(lock)
        if plan['mode'] == 'readback':
            current = (BASE / 'current').resolve()
            manifest = json.loads((current / 'release-manifest.json').read_bytes())
            receipt = json.loads((current / 'online-checkout-load-preservation.json').read_bytes())
            need(manifest.get('commit') == plan['commit'] and manifest.get('scope') == SCOPE
                 and receipt.get('buildProofSha256') == plan['buildProofSha256']
                 and receipt.get('qualitySourceEvidence') == plan['qualitySourceEvidence'], 'READBACK_IDENTITY_CHANGED')
            raw_proof = (current / 'online-checkout-load-build-proof.json').read_bytes()
            need(sha(raw_proof) == plan['buildProofSha256'], 'READBACK_PROOF_CHANGED')
            proof = json.loads(raw_proof)
            verify_proof(proof, plan, c, proof.get('files'))
            need(sha((current / 'scripts/production-release' / CONTRACT_FILE).read_bytes()) == plan['contractSha256']
                 and all(sha((current / 'scripts/production-release' / name).read_bytes()) == digest
                         for name, digest in c['controlPins'].items()), 'READBACK_CONTROL_CHANGED')
            need(all(not (current / name).is_symlink() and sha((current / name).read_bytes()) == digest
                     for name, digest in c['runtimeSources'].items()), 'READBACK_HOST_SOURCE_CHANGED')
            states = h.snapshot(d, current)
            need(states == receipt['after'], 'READBACK_SERVICES_CHANGED')
            verify_runtime(d, h, states, c, original=receipt['before'])
            old.read_hashes(d, states['online-recharge']['containerId'], '/workspace/engine/', c['afterEngineFiles'])
            h.guards(d, current, states, c)
            return {'status': 'ONLINE_CHECKOUT_LOAD_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'],
                    'updatedServices': ['online-recharge'], 'migrationPerformed': False, 'businessActions': 0}
        current, raw_manifest, before = baseline(d, h, c)
        if plan['mode'] == 'preflight':
            return {'status': 'ONLINE_CHECKOUT_LOAD_PREFLIGHT_VERIFIED', 'commit': plan['commit'], 'businessActions': 0}
        stage = BASE / '.staging' / ('online-checkout-load-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        expected_url = artifact_url(plan['commit'])
        need(plan.get('artifactUrl') == expected_url, 'ARTIFACT_LOCATION_INVALID')
        with urllib.request.urlopen(expected_url, timeout=60) as response:
            raw = response.read(4 * 1024**2 + 1)
        need(0 < len(raw) <= 4 * 1024**2 and sha(raw) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        payload = load('shared-bank-card-release.py').safe_archive(raw, stage / 'content')
        raw_proof = (payload / 'build-proof.json').read_bytes()
        need(sha(raw_proof) == plan['buildProofSha256'], 'PROOF_CHANGED')
        files = h.file_inventory(payload)
        files.pop('build-proof.json')
        verify_proof(json.loads(raw_proof), plan, c, files)
        context = stage / 'image'
        shutil.copytree(payload / 'engine', context / 'source')
        a.normalize_image_context(context)
        reference = 'id-business-v2-online-checkout-load:' + plan['commit'] + '-' + plan['workflowRunId']
        original = json.loads(d.run('docker', 'image', 'inspect', before['online-recharge']['image']))[0]
        base_ref = h.base_image_reference(d, before['online-recharge'])
        (context / 'Dockerfile').write_text('FROM ' + base_ref + '\nCOPY source/ /workspace/engine/\nLABEL '
            'org.opencontainers.image.revision="' + plan['commit'] + '" '
            'id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n')
        h.build_image(d, context, reference, 'online-recharge', before['online-recharge'], stage)
        built = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
        old.verify_image(original, built, plan)
        need(baseline(d, h, c)[1:] == (raw_manifest, before), 'BASELINE_CHANGED')
        backup = h.fresh_scoped_backup(d, current, plan, normalizer_path=Path(c['baseline']['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-online-checkout-load')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(current, target, symlinks=True)
        for name in FILES:
            path = target / ENGINE / name
            need(not path.is_symlink() and path.resolve().is_relative_to(target), 'HOST_SOURCE_CHANGED')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((payload / 'engine' / name).read_bytes())
            path.chmod(0o644)
        for name in [*CONTROLS, CONTRACT_FILE]:
            path = target / 'scripts/production-release' / name
            need(not path.is_symlink(), 'CONTROL_PATH_CHANGED')
            path.write_bytes((HERE / name).read_bytes())
        override = json.loads((target / 'compose.release.json').read_bytes())
        override['services']['online-recharge']['image'] = reference
        (target / 'compose.release.json').write_text(json.dumps(override, sort_keys=True, indent=2) + '\n')
        (target / 'compose.release.json').chmod(0o600)
        need(baseline(d, h, c)[1:] == (raw_manifest, before), 'BASELINE_CHANGED')
        marker = p.claim_markers(d, before, plan)
        fence = p.sql_fence_class(c)(d, current)
        journal = stage / 'switch-state.json'
        journal.write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target)}) + '\n')
        try:
            switch_engine(d, current, target, fence)
            after = h.snapshot(d, target)
            need(after['online-recharge']['image'] == built['Id'], 'IMAGE_CHANGED')
            verify_runtime(d, h, after, c, original=before)
            old.read_hashes(d, after['online-recharge']['containerId'], '/workspace/engine/', c['afterEngineFiles'])
        except BaseException:
            journal.write_text(json.dumps({'status': 'SWITCH_FAILED', 'target': str(target)}) + '\n')
            raise
        p.release_markers(marker)
        h.guards(d, target, after, c)
        receipt = {'commit': plan['commit'], 'before': before, 'after': after, 'image': built['Id'],
            'runtimeSources': c['runtimeSources'], 'validationSources': c['validationSources'],
            'buildProofSha256': plan['buildProofSha256'], 'backup': backup,
            'qualitySourceEvidence': plan['qualitySourceEvidence'],
            'preservedServices': list(PRESERVED), 'updatedServices': ['online-recharge'],
            'migrationPerformed': False, 'businessActions': 0}
        (target / 'online-checkout-load-preservation.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
        (target / 'online-checkout-load-build-proof.json').write_bytes(raw_proof)
        manifest = json.loads(raw_manifest)
        manifest.update(commit=plan['commit'], sourceTree=plan['tree'], scope=SCOPE,
            previousCommit=c['baseline']['commit'], previousRelease=str(current),
            previousManifestSha256=sha(raw_manifest), status='DEPLOYED', servicesUpdated=['online-recharge'],
            migrationPerformed=False, newMigrations=[], paymentActions=0)
        manifest['images']['online-recharge'] = {'reference': reference, 'digest': built['Id'], 'sourceCommit': plan['commit']}
        projections = manifest.setdefault('roleSourceProjections', {})
        projections['online-recharge'] = {'kind': SCOPE, 'commit': plan['commit'],
            'parentProjection': projections.get('online-recharge'), 'sources': c['runtimeSources']}
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-online-checkout-load')
        journal.write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target)}) + '\n')
        return {'status': 'ONLINE_CHECKOUT_LOAD_DEPLOYED', 'commit': plan['commit'],
                'updatedServices': ['online-recharge'], 'preservedServices': list(PRESERVED),
                'migrationPerformed': False, 'businessActions': 0}
