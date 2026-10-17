"""API-only legacy closure publication; no task, card or payment is changed here."""
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
SCOPE = 'ONLINE_LEGACY_UNPAID_CLOSURE'
CONTRACT_FILE = 'online-legacy-close-contract.json'
EXPECTED_PREDECESSOR = 'a37e775636f25cd405e33e014519f9881c094d9b'
PUBLISHED_SOURCE_COMMIT = '055b308bf357d460ee7746c9e60ae46d575f7661'
PUBLISHED_ADMIN_PROOF = ('registration-protocol-repair-20261017-build-proof.json',
                         '3507bc7c9c00de4893fde083d2033168cc8263b74ced19f8e2bcdedae3b04edf')
PRESERVED = ('admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration')
API_MODULE = 'id-business-v2/online-recharge/persistence/tasks.repository.js'
PUBLISHED_MAPS = {
    'beforeApiOnlineFiles': (126, '81c5173967e0981ceb8d1b8c832d917c700d4d9cfbb85b79848cadf5e9c80eeb'),
    'publicFiles': (261, '88f2e4e02dd46722f740943dece93bfcbbed639a2be259c9e5eeb40ee859c176'),
    'engineFiles': (96, '10e16859cb9a5bddb737c04caeeacda90baaf16bdb7846a1031d966381542be6')}
ALLOWED_SOURCES = frozenset([
    'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts',
    'apps/api/src/id-business-v2/online-recharge/persistence/tasks.manual-closure.spec.ts',
    'apps/api/src/id-business-v2/online-recharge/mysql.integration.spec.ts',
    'docs/ONLINE_RECHARGE.md', 'docs/V2_TASKS.md'])


def need(ok, code):
    if not ok:
        raise RuntimeError('ONLINE_LEGACY_CLOSE_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_contract(c):
    need(c.get('scope') == SCOPE and c.get('expectedCurrent') == EXPECTED_PREDECESSOR
         and c.get('publishedSourceCommit') == PUBLISHED_SOURCE_COMMIT,
         'PUBLISHED_PREDECESSOR_CHANGED')
    need((c.get('publishedAdminProofFile'), c.get('publishedAdminProofSha256')) == PUBLISHED_ADMIN_PROOF,
         'PUBLISHED_ADMIN_PROOF_CHANGED')
    need(set(c.get('sources', {})) == ALLOWED_SOURCES and c.get('apiModules') == [API_MODULE],
         'FINITE_SCOPE_CHANGED')
    need(all(re.fullmatch('[a-f0-9]{64}', value) for value in c['sources'].values())
         and all(re.fullmatch('[a-f0-9]{40}', c.get(name, ''))
                 for name in ('reviewBase', 'sourceReviewCommit')),
         'SOURCE_BINDING_CHANGED')
    need(not c.get('validationReuse') and c.get('databaseTestMarker') == '人工结案'
         and c.get('minimumDatabaseTests') == 49 and c.get('minimumClosureDatabaseTests') == 7,
         'DATABASE_VALIDATION_CHANGED')
    need(all(len(c.get(name, {})) == count
             and sha(json.dumps(c[name], sort_keys=True, separators=(',', ':')).encode()) == fingerprint
             for name, (count, fingerprint) in PUBLISHED_MAPS.items()),
         'PUBLISHED_CONTENT_INVENTORY_CHANGED')


def verify_proof(proof, plan, c, files):
    expected_modules = {API_MODULE.removesuffix('.js') + ext for ext in ('.js', '.js.map', '.d.ts')}
    db = proof.get('databaseVerification', {})
    need(proof.get('version') == 1 and proof.get('scope') == SCOPE
         and all(proof.get(k) == plan[k] for k in ('commit', 'tree', 'workflowRunId',
             'workflowRunAttempt', 'contractSha256', 'controlSources'))
         and proof.get('sources') == c['sources'] and set(proof.get('apiModules', {})) == expected_modules
         and proof.get('runtimeBaselineCommit') == c['expectedCurrent']
         and proof.get('publishedSourceCommit') == c['publishedSourceCommit']
         and proof.get('baselineApiReproduced') is True
         and proof.get('preservedAdminFiles') == c['publicFiles']
         and proof.get('preservedEngineFiles') == c['engineFiles']
         and proof.get('updatedServices') == ['api']
         and proof.get('dependentServiceRebound') == 'online-recharge'
         and proof.get('migrationPerformed') is False and proof.get('businessActions') == 0,
         'NATIVE_PROOF_CHANGED')
    need(db.get('isolated') is True and db.get('suite') == 'mysql.integration.spec.ts'
         and type(db.get('passed')) is int and db['passed'] >= c['minimumDatabaseTests']
         and type(db.get('closureTestsPassed')) is int
         and db['closureTestsPassed'] >= c['minimumClosureDatabaseTests'],
         'DATABASE_PROOF_CHANGED')
    expected = {**{'source/' + n: value for n, value in c['sources'].items()},
                **{'api/modules/' + n: value for n, value in proof['apiModules'].items()}}
    need(files == expected == proof.get('files'), 'PAYLOAD_SCOPE_CHANGED')


def verify_runtime(d, h, states, c):
    shared = load('shared-bank-card-release.py')
    need(all(shared.configuration_matches(h, d, state, c['runtimeConfigurationSha256'][role])
             for role, state in states.items()), 'RUNTIME_CONFIGURATION_CHANGED')


def preserved_content(d, states, c):
    load('online-checkout-release.py').read_hashes(d, states['admin']['containerId'],
                                                  '/usr/share/nginx/html/', c['publicFiles'])
    load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], c['engineFiles'])


def published_proofs(directory, c):
    for name, expected in [('online-checkout-build-proof.json', c['publishedProofSha256']),
                           (c['publishedAdminProofFile'], c['publishedAdminProofSha256'])]:
        path = directory / name
        need(not path.is_symlink() and sha(path.read_bytes()) == expected, 'PUBLISHED_PROOF_CHANGED')


def baseline(d, h, c):
    previous = (BASE / 'current').resolve()
    need(str(previous) == c['current'] and previous.parent == BASE / 'releases', 'CURRENT_CHANGED')
    raw = (previous / 'release-manifest.json').read_bytes()
    need(sha(raw) == c['manifestSha256'] and json.loads(raw)['commit'] == c['expectedCurrent'],
         'MANIFEST_CHANGED')
    states = h.snapshot(d, previous)
    need(states == c['services'], 'SERVICES_CHANGED')
    need(all(sha((previous / n).read_bytes()) == value for n, value in c['configurationSha256'].items()),
         'HOST_CONFIGURATION_CHANGED')
    published_proofs(previous, c)
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    normalizer = Path(c['backupNormalizerPath'])
    need(normalizer.is_relative_to(BASE / 'releases') and normalizer.is_file()
         and not normalizer.is_symlink() and sha(normalizer.read_bytes()) == c['backupNormalizerSha256'],
         'BACKUP_NORMALIZER_CHANGED')
    verify_runtime(d, h, states, c)
    preserved_content(d, states, c)
    load('online-checkout-release.py').read_hashes(d, states['api']['containerId'],
                                                  '/app/apps/api/dist/', c['beforeApiOnlineFiles'])
    h.guards(d, previous, states, c)
    return previous, raw, states


def smoke(d, h, target, states, proof, c):
    load('online-checkout-release.py').read_hashes(d, states['api']['containerId'],
                                                  '/app/apps/api/dist/',
                                                  {**c['beforeApiOnlineFiles'], **proof['apiModules']})
    need(all(states[role] == c['services'][role] for role in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
    need(states['online-recharge']['image'] == c['services']['online-recharge']['image']
         and all(states[role]['environmentSha256'] == c['services'][role]['environmentSha256']
                 for role in ('api', 'online-recharge')), 'ENGINE_OR_ENVIRONMENT_CHANGED')
    verify_runtime(d, h, states, c)
    preserved_content(d, states, c)
    h.engine_idle(d, states['online-recharge'], c, wait_connected=True)
    # Reject an unauthenticated action before any task logic is entered.
    code = "fetch('http://127.0.0.1:3000/api/id-business-v2/online-recharge/admin/jobs/resolve-not-charged',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>{if(![401,403].includes(r.status))process.exit(1);console.log('UNAUTHORIZED_REJECTED')}).catch(()=>process.exit(1))"
    need(d.run('docker', 'exec', states['api']['containerId'], 'node', '-e', code) == 'UNAUTHORIZED_REJECTED',
         'AUTH_SMOKE_FAILED')


def release(plan, c):
    validate_contract(c)
    need(plan['mode'] in ('preflight', 'release', 'readback')
         and all(re.fullmatch('[a-f0-9]{40}', plan[name]) for name in ('commit', 'tree'))
         and re.fullmatch('[1-9][0-9]*', plan['workflowRunId']), 'IDENTITY_INVALID')
    need(sha((HERE / CONTRACT_FILE).read_bytes()) == plan['contractSha256'], 'CONTRACT_CHANGED')
    need(set(plan['controlSources']) == set(c['controlFiles'])
         and all(sha((HERE / n).read_bytes()) == value for n, value in plan['controlSources'].items()),
         'CONTROL_CHANGED')
    h = load('recharge-record-release.py')
    d = h.load_utilities(HERE / 'remote-deploy.py', plan['controlSources']['remote-deploy.py'])
    a = load('recharge-availability-release.py')
    p = load('proxy-result-identity-release.py')
    p.SCOPE = SCOPE
    with (BASE / '.deploy.lock').open('a') as lock:
        a.acquire_release_lock(lock)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve()
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            need(manifest.get('commit') == plan['commit'] and manifest.get('scope') == SCOPE,
                 'READBACK_CURRENT_CHANGED')
            published_proofs(target, c)
            raw_proof = (target / 'online-legacy-close-build-proof.json').read_bytes()
            receipt = json.loads((target / 'online-legacy-close-preservation.json').read_bytes())
            need(sha(raw_proof) == plan['buildProofSha256'], 'READBACK_PROOF_CHANGED')
            states = h.snapshot(d, target)
            need(states == receipt['after'], 'READBACK_SERVICES_CHANGED')
            smoke(d, h, target, states, json.loads(raw_proof), c)
            h.guards(d, target, states, c)
            return {'status': 'ONLINE_LEGACY_CLOSE_INDEPENDENT_READBACK_VERIFIED',
                    'commit': plan['commit'], 'migrationPerformed': False, 'businessActions': 0}
        previous, raw_manifest, before = baseline(d, h, c)
        if plan['mode'] == 'preflight':
            return {'status': 'ONLINE_LEGACY_CLOSE_PREFLIGHT_VERIFIED',
                    'commit': plan['commit'], 'businessActions': 0}
        stage = BASE / '.staging' / ('online-legacy-close-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        expected = ('https://github.com/wangchaozhuanyong/id-business-system/releases/download/'
                    'online-legacy-close-' + plan['commit'] + '/online-legacy-close-artifact.tar.gz')
        need(plan['artifactUrl'] == expected, 'ARTIFACT_LOCATION_INVALID')
        with urllib.request.urlopen(expected, timeout=60) as response:
            artifact = response.read(4 * 1024**2 + 1)
        need(0 < len(artifact) <= 4 * 1024**2 and sha(artifact) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        payload = h.safe_archive(artifact, stage / 'content')
        raw_proof = (payload / 'build-proof.json').read_bytes()
        need(sha(raw_proof) == plan['buildProofSha256'], 'PROOF_CHANGED')
        proof = json.loads(raw_proof)
        files = h.file_inventory(payload)
        files.pop('build-proof.json')
        verify_proof(proof, plan, c, files)
        context = stage / 'image-api'
        shutil.copytree(payload / 'api', context)
        a.normalize_image_context(context)
        reference = 'id-business-v2-online-legacy-close:' + plan['commit'] + '-' + plan['workflowRunId']
        base_ref = h.base_image_reference(d, before['api'])
        (context / 'Dockerfile').write_text('FROM ' + base_ref
            + '\nCOPY modules/ /app/apps/api/dist/\nLABEL org.opencontainers.image.revision="'
            + plan['commit'] + '" id-business-v2.recharge-record-build-proof-sha256="'
            + plan['buildProofSha256'] + '"\n')
        h.build_image(d, context, reference, 'api', before['api'], stage)
        original = json.loads(d.run('docker', 'image', 'inspect', before['api']['image']))[0]
        built = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
        load('online-checkout-release.py').verify_image(original, built, plan)
        baseline(d, h, c)
        backup = h.fresh_scoped_backup(d, previous, plan, normalizer_path=Path(c['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-online-legacy-close')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(previous, target, symlinks=True)
        for name in c['sources']:
            path = target / name
            need(path.resolve().is_relative_to(target) and not path.is_symlink(), 'HOST_SOURCE_PATH_CHANGED')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((payload / 'source' / name).read_bytes())
            path.chmod(0o644)
        for name in [*plan['controlSources'], CONTRACT_FILE]:
            path = target / 'scripts/production-release' / name
            need(not path.is_symlink(), 'CONTROL_PATH_CHANGED')
            path.write_bytes((HERE / name).read_bytes())
        override = json.loads((target / 'compose.release.json').read_bytes())
        override['services']['api']['image'] = reference
        a.write_release_override(target / 'compose.release.json', override)
        baseline(d, h, c)
        marker = p.claim_markers(d, before, plan)
        fence = p.sql_fence_class(c)(d, previous)
        journal = stage / 'switch-state.json'
        journal.write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target),
                                       'previous': str(previous)}) + '\n')
        try:
            fence.acquire()
            d.compose(previous, 'stop', 'online-recharge', timeout=90)
            fence.check_idle()
            d.compose(previous, 'stop', 'api', timeout=90)
            fence.check_idle()
            fence.close()
            d.compose(target, 'up', '-d', '--no-deps', 'api', timeout=180)
            d.wait_healthy(target, 'api')
            d.compose(target, 'up', '-d', '--no-deps', '--force-recreate', 'online-recharge', timeout=180)
            d.wait_healthy(target, 'online-recharge')
            after = h.snapshot(d, target)
            need(after['api']['image'] == built['Id'], 'API_IMAGE_CHANGED')
            smoke(d, h, target, after, proof, c)
        except BaseException:
            journal.write_text(json.dumps({'status': 'SWITCH_FAILED', 'target': str(target),
                                           'previous': str(previous), 'businessActions': 0}) + '\n')
            raise
        finally:
            fence.close()
        p.release_markers(marker)
        h.guards(d, target, after, c)
        receipt = {'status': 'DEPLOYED', 'commit': plan['commit'], 'before': before, 'after': after,
                   'apiImage': {'reference': reference, 'imageId': built['Id']}, 'backup': backup,
                   'artifactSha256': plan['artifactSha256'], 'buildProofSha256': plan['buildProofSha256'],
                   'updatedServices': ['api'], 'dependentServiceRebound': 'online-recharge',
                   'migrationPerformed': False, 'businessActions': 0}
        (target / 'online-legacy-close-preservation.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
        (target / 'online-legacy-close-build-proof.json').write_bytes(raw_proof)
        manifest = json.loads(raw_manifest)
        manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=SCOPE,
                        previousCommit=c['expectedCurrent'], previousRelease=str(previous),
                        previousManifestSha256=sha(raw_manifest), status='DEPLOYED', servicesUpdated=['api'],
                        servicesRebound=['online-recharge'], newMigrations=[], migrationPerformed=False,
                        paymentActions=0, onlineLegacyClosePublication=receipt)
        manifest['images']['api'] = {'reference': reference, 'digest': built['Id'], 'sourceCommit': plan['commit']}
        projections = manifest.setdefault('roleSourceProjections', {})
        projections['api'] = {'kind': SCOPE, 'commit': plan['commit'], 'parentProjection': projections.get('api'),
                              'buildProofSha256': plan['buildProofSha256'], 'sources': c['sources'],
                              'runtimeModules': proof['apiModules']}
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-online-legacy-close')
        journal.write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target), 'commit': plan['commit']}) + '\n')
        return {'status': 'ONLINE_LEGACY_CLOSE_DEPLOYED', 'commit': plan['commit'],
                'updatedServices': ['api'], 'dependentServiceRebound': 'online-recharge',
                'migrationPerformed': False, 'businessActions': 0}
