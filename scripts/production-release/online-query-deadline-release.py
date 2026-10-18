"""Finite engine-only response deadline repair over the accepted seven-role 8fef release."""
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
SCOPE = 'ONLINE_QUERY_DEADLINE_REPAIR'
SOURCE_BASE = '8fef357efc8f2d94bdc5175de427db0c621e32ac'
REVIEW_BASE = SOURCE_BASE
CONTRACT_FILE = 'online-query-deadline-contract.json'
WORKFLOW = '.github/workflows/online-query-deadline-validation.yml'
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine'
FILES = frozenset(('SOURCE_MANIFEST.json', 'upstream/subscription-check.js',
    'test/query-network-browser.test.cjs', 'test/renewal-state.test.cjs'))
VALIDATION = frozenset(('docs/ONLINE_RECHARGE.md',))
REVIEW_CONTROLS = frozenset(('scripts/ci-online-settings-scope.mjs',
    'scripts/ci-online-settings-scope.test.mjs', 'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-scope.test.mjs'))
PUBLIC_CONTROLS = frozenset((WORKFLOW, *REVIEW_CONTROLS, *['scripts/production-release/online-query-deadline-' + suffix
    for suffix in ('build.py', 'release.py', 'release.test.py', 'contract.json')]))
PRESERVED = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge')
SERVICES = (*PRESERVED, 'online-recharge')
QUALITY_PARTS = ('guards', 'online-engine')
CONTROLS = frozenset(('online-query-deadline-release.py', 'online-query-deadline-build.py',
    'online-query-deadline-release.test.py', 'online-query-network-release.py',
    'online-checkout-load-release.py', 'online-checkout-release.py', 'online-pending-features-release.py',
    'api-admin-scope.py', 'remote-deploy.py', 'recharge-record-release.py',
    'recharge-availability-release.py', 'proxy-result-identity-release.py',
    'shared-bank-card-release.py', 'recharge-source-recovery-release.py'))
BEFORE_ENGINE_SHA256 = '7e2647bdd825df6654291f2d87b5b4727d17fa8caee81a4380aa0f955e233fd1'
PREDECESSOR_PROOF_SHA256 = '07a2daa01e2c019e53cf3aadb9434918a76397a3f8819648af53f22f0fd07814'
SQL_FENCE = '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925'
HEALTH = {'ready': True, 'mode': 'enabled', 'activeTasks': 0, 'stopping': False, 'rpcConnected': True}


def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_QUERY_DEADLINE_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def fingerprint(value):
    return sha(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())


def load(name):
    spec = importlib.util.spec_from_file_location('query_deadline_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def inventory_valid(value):
    return type(value) is dict and bool(value) and all(type(name) is str
        and re.fullmatch('[A-Za-z0-9_./-]+', name) and not name.startswith('/')
        and all(part not in ('', '.', '..') for part in name.split('/'))
        and type(digest) is str and re.fullmatch('[a-f0-9]{64}', digest) for name, digest in value.items())


def validate_contract(c, *, require_baseline=True):
    need(c.get('version') == 1 and c.get('scope') == SCOPE and c.get('sourceBaseCommit') == SOURCE_BASE
        and c.get('reviewBase') == REVIEW_BASE and c.get('engineRoot') == ENGINE
        and re.fullmatch('[a-f0-9]{40}', c.get('sourceReviewCommit', ''))
        and c.get('sourceReviewTag') == 'online-query-deadline-source-review-' + c['sourceReviewCommit'][:12]
        and c.get('requiredQualityParts') == list(QUALITY_PARTS)
        and c.get('updatedServices') == ['online-recharge'] and c.get('preservedServices') == list(PRESERVED)
        and c.get('migrationPerformed') is False and type(c.get('businessActions')) is int
        and c['businessActions'] == 0, 'CONTRACT_IDENTITY_INVALID')
    need(inventory_valid(c.get('runtimeSources')) and set(c['runtimeSources']) == {ENGINE + '/' + name for name in FILES}
        and type(c.get('validationSources')) is dict and set(c['validationSources']) <= VALIDATION
        and (not c['validationSources'] or inventory_valid(c['validationSources']))
        and inventory_valid(c.get('reviewedControlSources')) and set(c['reviewedControlSources']) == REVIEW_CONTROLS
        and inventory_valid(c.get('controlPins')) and set(c['controlPins']) == CONTROLS
        and c['controlPins']['api-admin-scope.py'] == SQL_FENCE
        and c.get('sqlFenceHelperSha256') == SQL_FENCE and c.get('engineHealth') == HEALTH
        and re.fullmatch('[a-f0-9]{64}', c.get('workflowSha256', '')), 'SOURCE_SCOPE_CHANGED')
    before, after = c.get('beforeEngineFiles'), c.get('afterEngineFiles')
    need(inventory_valid(before) and inventory_valid(after) and len(before) == len(after) == 103
        and set(before) == set(after) and fingerprint(before) == BEFORE_ENGINE_SHA256
        and {name for name in after if before.get(name) != after[name]} == FILES
        and all(c['runtimeSources'][ENGINE + '/' + name] == after[name] for name in FILES), 'ENGINE_SCOPE_CHANGED')
    b = c.get('baseline')
    if b is None:
        need(not require_baseline, 'BASELINE_NOT_BOUND')
        return
    need(type(b) is dict and b.get('commit') == SOURCE_BASE
        and re.fullmatch('/opt/id-business-v2/releases/[A-Za-z0-9_-]+', b.get('current', ''))
        and re.fullmatch('[a-f0-9]{64}', b.get('manifestSha256', ''))
        and set(b.get('services', {})) == set(SERVICES)
        and inventory_valid(b.get('runtimeConfigurationSha256')) and set(b['runtimeConfigurationSha256']) == set(SERVICES)
        and inventory_valid(b.get('configurationSha256')) and set(b['configurationSha256']) == {
            '.env.aws.production', 'compose.release.json', 'docker-compose.aws-mysql.yml'}
        and b.get('engineFiles') == before and b.get('engineHealth') == HEALTH
        and inventory_valid(b.get('apiOnlineFiles')) and len(b['apiOnlineFiles']) == 129
        and inventory_valid(b.get('adminFiles')) and 'index.html' in b['adminFiles']
        and re.fullmatch('[a-f0-9]{64}', b.get('nginxSha256', ''))
        and re.fullmatch('/opt/id-business-v2/releases/[A-Za-z0-9_-]+/scripts/mysql-dump-restore-normalizer.sed',
            b.get('backupNormalizerPath', '')) and b.get('backupNormalizerSha256') ==
            'ca9b05f832e9ed73bb36b7e76c083c99a40b13e067850166f8715bae469e5202', 'BASELINE_CHANGED')


def artifact_url(commit):
    return ('https://github.com/wangchaozhuanyong/id-business-system/releases/download/'
        'online-query-deadline-' + commit + '/online-query-deadline-artifact.tar.gz')


def validate_quality(evidence, commit, tree):
    load('online-checkout-load-release.py').validate_quality(evidence, commit, tree)


def validate_plan(plan, c):
    validate_contract(c)
    need(plan.get('mode') in ('preflight', 'release', 'readback')
        and all(re.fullmatch('[a-f0-9]{40}', plan.get(key, '')) for key in ('commit', 'tree'))
        and all(re.fullmatch('[1-9][0-9]*', plan.get(key, '')) for key in ('workflowRunId', 'workflowRunAttempt'))
        and plan.get('contractSha256') == sha((HERE / CONTRACT_FILE).read_bytes())
        and c == json.loads((HERE / CONTRACT_FILE).read_bytes()) and plan.get('controlSources') == c['controlPins']
        and all(re.fullmatch('[a-f0-9]{64}', plan.get(key, '')) for key in ('artifactSha256', 'buildProofSha256'))
        and plan.get('artifactUrl') == artifact_url(plan['commit']), 'PLAN_BINDING_CHANGED')
    validate_quality(plan.get('qualitySourceEvidence'), plan['commit'], plan['tree'])


def verify_proof(proof, plan, c, files):
    validate_contract(c)
    parts, quality = proof.get('qualityPartEvidence', {}), proof.get('qualitySourceEvidence', {})
    expected = {'engine/' + name: c['afterEngineFiles'][name] for name in FILES}
    need(proof.get('version') == 1 and proof.get('scope') == SCOPE
        and all(proof.get(key) == plan.get(key) for key in ('commit', 'tree', 'workflowRunId',
            'workflowRunAttempt', 'contractSha256', 'controlSources', 'qualitySourceEvidence'))
        and proof.get('runtimeSources') == c['runtimeSources'] and proof.get('validationSources') == c['validationSources']
        and proof.get('beforeEngineFiles') == c['beforeEngineFiles'] and proof.get('afterEngineFiles') == c['afterEngineFiles']
        and proof.get('baselineSha256') == fingerprint(c['baseline']) and proof.get('workflow') == WORKFLOW
        and proof.get('workflowSha256') == c['workflowSha256'] and proof.get('controlSources') == c['controlPins']
        and parts.get('parts') == list(QUALITY_PARTS) and parts.get('runId') == quality.get('runId')
        and parts.get('runAttempt') == quality.get('runAttempt') and parts.get('testedTree') == plan.get('tree')
        and set(parts.get('jobs', {})) == set(QUALITY_PARTS)
        and all(type(value) is int and value > 0 for value in parts['jobs'].values())
        and len(set(parts['jobs'].values())) == len(QUALITY_PARTS)
        and proof.get('updatedServices') == ['online-recharge'] and proof.get('preservedServices') == list(PRESERVED)
        and proof.get('migrationPerformed') is False and type(proof.get('businessActions')) is int
        and proof['businessActions'] == 0 and files == expected == proof.get('files'), 'PROOF_CHANGED')
    validate_quality(quality, plan['commit'], plan['tree'])


def helpers():
    h, old = load('recharge-record-release.py'), load('online-checkout-release.py')
    d = h.load_utilities(HERE / 'remote-deploy.py', sha((HERE / 'remote-deploy.py').read_bytes()))
    retired = load('online-query-network-release.py')
    retired.SCOPE = SCOPE
    h.SERVICES = SERVICES
    h.guards = lambda driver, directory, states, c: retired.retired_guards(driver, directory, states, c, h)
    p = load('proxy-result-identity-release.py')
    p.SCOPE, p.claim_markers = SCOPE, retired.claim_retired_markers
    return h, old, d, load('recharge-availability-release.py'), p, retired


def verify_runtime(d, h, states, c, original, engine_files):
    need(set(states) == set(SERVICES) and all(states[role] == original[role] for role in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
    need(states['online-recharge']['environmentSha256'] == original['online-recharge']['environmentSha256'], 'ENVIRONMENT_CHANGED')
    shared = load('shared-bank-card-release.py')
    need(all(shared.configuration_matches(h, d, state, c['baseline']['runtimeConfigurationSha256'][role])
        for role, state in states.items()), 'RUNTIME_CONFIGURATION_CHANGED')
    load('online-pending-features-release.py').verify_runtime_inventory(d, states, c)
    load('online-query-network-release.py').verify_retired_runtime(d, states)
    load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], engine_files)
    need(d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum', '/etc/nginx/conf.d/default.conf').split()[0]
        == c['baseline']['nginxSha256'], 'NGINX_CHANGED')
    h.engine_idle(d, states['online-recharge'], c, wait_connected=True)


def baseline(d, h, c):
    b = c['baseline']
    current = (BASE / 'current').resolve()
    raw = (current / 'release-manifest.json').read_bytes()
    manifest = json.loads(raw)
    need(str(current) == b['current'] and current.parent == BASE / 'releases' and sha(raw) == b['manifestSha256']
        and manifest.get('commit') == SOURCE_BASE and manifest.get('status') == 'DEPLOYED'
        and sha((current / 'online-checkout-build-proof.json').read_bytes()) == PREDECESSOR_PROOF_SHA256, 'BASELINE_CHANGED')
    states = h.snapshot(d, current)
    need(states == b['services'] and all(sha((current / name).read_bytes()) == digest
        for name, digest in b['configurationSha256'].items()), 'BASELINE_CHANGED')
    normalizer = Path(b['backupNormalizerPath'])
    need(normalizer.is_file() and not normalizer.is_symlink() and sha(normalizer.read_bytes()) == b['backupNormalizerSha256']
        and shutil.disk_usage(BASE).free > 6 * 1024**3, 'BASELINE_STORAGE_CHANGED')
    verify_runtime(d, h, states, c, states, c['beforeEngineFiles'])
    h.guards(d, current, states, c)
    return current, raw, states


def verify_host(target, states, c, plan):
    need(all(not (target / name).is_symlink() and sha((target / name).read_bytes()) == digest
        for name, digest in c['runtimeSources'].items()), 'HOST_SOURCE_CHANGED')
    need(sha((target / 'scripts/production-release' / CONTRACT_FILE).read_bytes()) == plan['contractSha256']
        and all(not (target / 'scripts/production-release' / name).is_symlink()
            and sha((target / 'scripts/production-release' / name).read_bytes()) == digest
            for name, digest in c['controlPins'].items()), 'HOST_CONTROL_CHANGED')
    need(all(sha((target / name).read_bytes()) == digest for name, digest in c['baseline']['configurationSha256'].items()
        if name != 'compose.release.json'), 'HOST_CONFIGURATION_CHANGED')
    expected = json.loads((Path(c['baseline']['current']) / 'compose.release.json').read_bytes())
    expected['services']['online-recharge']['image'] = states['online-recharge']['reference']
    need(json.loads((target / 'compose.release.json').read_bytes()) == expected, 'COMPOSE_SCOPE_CHANGED')


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
    need(all(not (HERE / name).is_symlink() and sha((HERE / name).read_bytes()) == digest
        for name, digest in c['controlPins'].items()), 'CONTROL_CHANGED')
    h, old, d, a, p, _retired = helpers()
    with (BASE / '.deploy.lock').open('a') as lock:
        a.acquire_release_lock(lock)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve()
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            receipt = json.loads((target / 'online-query-deadline-preservation.json').read_bytes())
            raw_proof = (target / 'online-query-deadline-build-proof.json').read_bytes()
            need(manifest.get('commit') == plan['commit'] and manifest.get('scope') == SCOPE
                and manifest.get('status') == 'DEPLOYED' and receipt.get('buildProofSha256') == plan['buildProofSha256']
                and sha(raw_proof) == plan['buildProofSha256'], 'READBACK_CHANGED')
            proof = json.loads(raw_proof)
            verify_proof(proof, plan, c, proof.get('files'))
            states = h.snapshot(d, target)
            need(states == receipt['after'], 'READBACK_SERVICES_CHANGED')
            verify_runtime(d, h, states, c, receipt['before'], c['afterEngineFiles'])
            verify_host(target, states, c, plan)
            h.guards(d, target, states, c)
            return {'status': 'ONLINE_QUERY_DEADLINE_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'],
                'updatedServices': ['online-recharge'], 'preservedServices': list(PRESERVED), 'migrationPerformed': False, 'businessActions': 0}
        current, manifest_raw, before = baseline(d, h, c)
        if plan['mode'] == 'preflight':
            return {'status': 'ONLINE_QUERY_DEADLINE_PREFLIGHT_VERIFIED', 'commit': plan['commit'], 'businessActions': 0}
        stage = BASE / '.staging' / ('online-query-deadline-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        with urllib.request.urlopen(plan['artifactUrl'], timeout=60) as response:
            raw = response.read(4 * 1024**2 + 1)
        need(0 < len(raw) <= 4 * 1024**2 and sha(raw) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        payload = load('shared-bank-card-release.py').safe_archive(raw, stage / 'content')
        raw_proof = (payload / 'build-proof.json').read_bytes()
        need(sha(raw_proof) == plan['buildProofSha256'], 'PROOF_BYTES_CHANGED')
        files = h.file_inventory(payload)
        files.pop('build-proof.json')
        verify_proof(json.loads(raw_proof), plan, c, files)
        context = stage / 'image'
        shutil.copytree(payload / 'engine', context / 'source')
        a.normalize_image_context(context)
        reference = 'id-business-v2-online-query-deadline:' + plan['commit'] + '-' + plan['workflowRunId']
        original = json.loads(d.run('docker', 'image', 'inspect', before['online-recharge']['image']))[0]
        (context / 'Dockerfile').write_text('FROM ' + h.base_image_reference(d, before['online-recharge'])
            + '\nCOPY source/ /workspace/engine/\nLABEL org.opencontainers.image.revision="' + plan['commit']
            + '" id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n')
        h.build_image(d, context, reference, 'online-recharge', before['online-recharge'], stage)
        built = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
        old.verify_image(original, built, plan)
        need(baseline(d, h, c)[1:] == (manifest_raw, before), 'BASELINE_CHANGED')
        backup = h.fresh_scoped_backup(d, current, plan, normalizer_path=Path(c['baseline']['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-online-query-deadline')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(current, target, symlinks=True)
        for name in FILES:
            path = target / ENGINE / name
            need(not path.is_symlink() and path.resolve().is_relative_to(target), 'HOST_SOURCE_PATH_CHANGED')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((payload / 'engine' / name).read_bytes())
            path.chmod(0o644)
        for name in [*CONTROLS, CONTRACT_FILE]:
            path = target / 'scripts/production-release' / name
            need(not path.is_symlink(), 'HOST_CONTROL_PATH_CHANGED')
            path.write_bytes((HERE / name).read_bytes())
        override = json.loads((target / 'compose.release.json').read_bytes())
        override['services']['online-recharge']['image'] = reference
        (target / 'compose.release.json').write_text(json.dumps(override, sort_keys=True, indent=2) + '\n')
        (target / 'compose.release.json').chmod(0o600)
        need(baseline(d, h, c)[1:] == (manifest_raw, before), 'BASELINE_CHANGED')
        marker = p.claim_markers(d, before, plan)
        fence = p.sql_fence_class(c)(d, current)
        journal = stage / 'switch-state.json'
        journal.write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target)}) + '\n')
        try:
            switch_engine(d, current, target, fence)
            after = h.snapshot(d, target)
            need(after['online-recharge']['image'] == built['Id'], 'IMAGE_CHANGED')
            verify_runtime(d, h, after, c, before, c['afterEngineFiles'])
            verify_host(target, after, c, plan)
        except BaseException:
            journal.write_text(json.dumps({'status': 'SWITCH_FAILED', 'target': str(target)}) + '\n')
            raise
        p.release_markers(marker)
        h.guards(d, target, after, c)
        receipt = {'commit': plan['commit'], 'before': before, 'after': after, 'image': built['Id'], 'backup': backup,
            'buildProofSha256': plan['buildProofSha256'], 'qualitySourceEvidence': plan['qualitySourceEvidence'],
            'preservedServices': list(PRESERVED), 'updatedServices': ['online-recharge'], 'migrationPerformed': False, 'businessActions': 0}
        (target / 'online-query-deadline-preservation.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
        (target / 'online-query-deadline-build-proof.json').write_bytes(raw_proof)
        manifest = json.loads(manifest_raw)
        manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=SCOPE,
            previousCommit=SOURCE_BASE, previousRelease=str(current), previousManifestSha256=sha(manifest_raw),
            status='DEPLOYED', servicesUpdated=['online-recharge'], migrationPerformed=False, newMigrations=[], paymentActions=0)
        manifest['images']['online-recharge'] = {'reference': reference, 'digest': built['Id'], 'sourceCommit': plan['commit']}
        projections = manifest.setdefault('roleSourceProjections', {})
        projections['online-recharge'] = {'kind': SCOPE, 'commit': plan['commit'], 'parentProjection': projections.get('online-recharge'),
            'buildProofSha256': plan['buildProofSha256'], 'sources': c['runtimeSources']}
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-online-query-deadline')
        journal.write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target)}) + '\n')
        return {'status': 'ONLINE_QUERY_DEADLINE_DEPLOYED', 'commit': plan['commit'], 'updatedServices': ['online-recharge'],
            'preservedServices': list(PRESERVED), 'migrationPerformed': False, 'businessActions': 0}
