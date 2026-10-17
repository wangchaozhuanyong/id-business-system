"""Finite API/engine checkout repair; preserve the complete published website and other roles."""
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
SCOPE = 'ONLINE_CHECKOUT_CS_RECOVERY'
CONTRACT_FILE = 'online-checkout-cs-contract.json'
PUBLISHED_SOURCE_COMMIT = '8df81dca0f08ebdebe6b01b942b033053b8a5c3b'
ENGINE_ROOT = 'apps/api/src/id-business-v2/online-recharge/engine'
UPDATED = ('api', 'online-recharge')
PRESERVED = ('admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration')
API_MODULE = 'id-business-v2/online-recharge/checkout-recovery.js'
DECLARATION = 'id-business-v2/online-recharge/contracts.d.ts'
SQL_FENCE_HELPER_SHA256 = '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925'
BUSINESS_ENGINE_DELTA = frozenset(['SOURCE_MANIFEST.json', 'checkout-recovery.cjs',
    'upstream/chatgpt.js', 'upstream/index.js', 'upstream/payment-retry.js',
    'upstream/stripe-payment.js', 'test/checkout-recovery.test.cjs', 'test/payment-core.test.cjs',
    'test/checkout-cs-browser.test.cjs', 'test/checkout-recovery-evidence.test.cjs'])
ENGINE_ADDED = frozenset(['test/checkout-cs-browser.test.cjs', 'test/checkout-recovery-evidence.test.cjs'])
VALIDATION_ONLY_SOURCES = {
    ENGINE_ROOT + '/test/payment-observation.test.cjs': {
        'commit': PUBLISHED_SOURCE_COMMIT,
        'sha256': '954a2542c2451d72e9e062dfb095315c57530feecf3617343a6e1f2e408a91f3'}}
ENGINE_DELTA = BUSINESS_ENGINE_DELTA | frozenset(
    name.removeprefix(ENGINE_ROOT + '/') for name in VALIDATION_ONLY_SOURCES)
ALLOWED_SOURCES = frozenset([
    'apps/api/src/id-business-v2/online-recharge/checkout-recovery.ts',
    'apps/api/src/id-business-v2/online-recharge/checkout-recovery.spec.ts',
    'apps/api/src/id-business-v2/online-recharge/contracts.ts',
    'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.spec.ts',
    *[ENGINE_ROOT + '/' + name for name in BUSINESS_ENGINE_DELTA], 'docs/ONLINE_RECHARGE.md', 'docs/V2_TASKS.md'])


def need(ok, code):
    if not ok:
        raise RuntimeError('ONLINE_CHECKOUT_CS_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_contract(c):
    need(c.get('sqlFenceHelperSha256') == SQL_FENCE_HELPER_SHA256, 'SQL_FENCE_BINDING_CHANGED')
    helper = HERE / 'api-admin-scope.py'
    need(not helper.is_symlink() and helper.is_file() and sha(helper.read_bytes()) == SQL_FENCE_HELPER_SHA256,
         'SQL_FENCE_SOURCE_CHANGED')
    # Admission compiles only the reviewed class; no driver, subprocess or database is opened.
    load('proxy-result-identity-release.py').sql_fence_class(c)
    need(c.get('version') == 1 and c.get('scope') == SCOPE
         and c.get('publishedSourceCommit') == PUBLISHED_SOURCE_COMMIT,
         'PUBLISHED_PREDECESSOR_CHANGED')
    need(all(re.fullmatch('[a-f0-9]{40}', c.get(name, ''))
             for name in ('expectedCurrent', 'reviewBase', 'sourceReviewCommit')), 'SOURCE_BINDING_CHANGED')
    need(set(c.get('sources', {})) == ALLOWED_SOURCES
         and all(re.fullmatch('[a-f0-9]{64}', digest) for digest in c['sources'].values()),
         'FINITE_SCOPE_CHANGED')
    need(c.get('validationOnlySources') == VALIDATION_ONLY_SOURCES, 'VALIDATION_SOURCE_CHANGED')
    need(c.get('apiModules') == [API_MODULE]
         and set(c.get('apiDeclarationOnly', {})) == {DECLARATION}
         and re.fullmatch('[a-f0-9]{64}', c['apiDeclarationOnly'][DECLARATION]), 'API_SCOPE_CHANGED')
    need(c.get('engineRoot') == ENGINE_ROOT and bool(c.get('beforeEngineFiles'))
         and bool(c.get('afterEngineFiles')), 'ENGINE_INVENTORY_CHANGED')
    before, after = c['beforeEngineFiles'], c['afterEngineFiles']
    need(set(before) <= set(after) and set(after) - set(before) == ENGINE_ADDED
         and {name for name in after if before.get(name) != after[name]} == ENGINE_DELTA
         and all(c['sources'][ENGINE_ROOT + '/' + name] == after[name] for name in BUSINESS_ENGINE_DELTA)
         and all(after[name.removeprefix(ENGINE_ROOT + '/')] == pin['sha256']
                 for name, pin in c['validationOnlySources'].items()),
         'ENGINE_SCOPE_CHANGED')
    need(bool(c.get('beforeApiOnlineFiles'))
         and all(name.startswith('id-business-v2/online-recharge/') for name in c['beforeApiOnlineFiles'])
         and bool(c.get('publicFiles')) and 'index.html' in c['publicFiles'],
         'PUBLISHED_CONTENT_INVENTORY_CHANGED')
    for inventory in (before, after, c['beforeApiOnlineFiles'], c['publicFiles']):
        need(all(isinstance(name, str) and re.fullmatch('[A-Za-z0-9_./-]+', name)
                 and not name.startswith('/') and '..' not in Path(name).parts
                 and re.fullmatch('[a-f0-9]{64}', digest) for name, digest in inventory.items()),
             'CONTENT_PATH_CHANGED')
    need(set(c.get('services', {})) == set(UPDATED + PRESERVED)
         and set(c.get('runtimeConfigurationSha256', {})) == set(UPDATED + PRESERVED)
         and set(c.get('configurationSha256', {})) == {
             '.env.aws.production', 'compose.release.json', 'docker-compose.aws-mysql.yml'},
         'RUNTIME_SCOPE_CHANGED')
    overlays = c.get('publishedOverlays', [])
    need(isinstance(overlays, list) and len(overlays) >= 3
         and len({row['proofFile'] for row in overlays}) == len(overlays)
         and all(re.fullmatch('[a-z0-9-]+-build-proof.json', row.get('proofFile', ''))
                 and re.fullmatch('[a-f0-9]{64}', row.get('proofSha256', '')) for row in overlays),
         'PUBLISHED_PROOF_SCOPE_CHANGED')
    need('online-legacy-close-build-proof.json' in {row['proofFile'] for row in overlays}
         and re.fullmatch('[a-f0-9]{64}', c.get('predecessorContractSha256', ''))
         and not c.get('validationReuse'), 'PREDECESSOR_RECIPE_CHANGED')
    controls = c.get('controlFiles', [])
    need(isinstance(controls, list) and len(set(controls)) == len(controls)
         and all(re.fullmatch('[a-z0-9][a-z0-9.-]+', name) and Path(name).name == name for name in controls)
         and {'online-checkout-cs-build.py', 'online-checkout-cs-release.py', 'online-checkout-release.py',
              'recharge-record-release.py', 'remote-deploy.py', 'recharge-availability-release.py',
              'recharge-source-recovery-release.py', 'proxy-result-identity-release.py',
              'shared-bank-card-release.py', 'api-admin-scope.py'} <= set(controls), 'CONTROL_SCOPE_CHANGED')


def verify_proof(proof, plan, c, files):
    expected_modules = {API_MODULE.removesuffix('.js') + ext for ext in ('.js', '.js.map', '.d.ts')} | {DECLARATION}
    need(proof.get('version') == 1 and proof.get('scope') == SCOPE
         and all(proof.get(key) == plan[key] for key in ('commit', 'tree', 'workflowRunId',
             'workflowRunAttempt', 'contractSha256', 'controlSources'))
         and proof.get('sources') == c['sources']
         and proof.get('validationOnlySources') == c['validationOnlySources']
         and set(proof.get('apiModules', {})) == expected_modules
         and proof['apiModules'][DECLARATION] == c['apiDeclarationOnly'][DECLARATION]
         and proof.get('runtimeBaselineCommit') == c['expectedCurrent']
         and proof.get('publishedSourceCommit') == c['publishedSourceCommit']
         and proof.get('predecessorContractSha256') == c['predecessorContractSha256']
         and proof.get('beforeEngineFiles') == c['beforeEngineFiles']
         and proof.get('afterEngineFiles') == c['afterEngineFiles']
         and proof.get('baselineApiReproduced') is True
         and proof.get('preservedAdminFiles') == c['publicFiles']
         and proof.get('updatedServices') == list(UPDATED)
         and proof.get('preservedServices') == list(PRESERVED)
         and proof.get('migrationPerformed') is False
         and type(proof.get('businessActions')) is int and proof['businessActions'] == 0,
         'NATIVE_PROOF_CHANGED')
    expected = {**{'source/' + name: value for name, value in c['sources'].items()},
                **{'api/modules/' + name: value for name, value in proof['apiModules'].items()},
                **{'engine/' + name: c['afterEngineFiles'][name] for name in ENGINE_DELTA}}
    need(files == expected == proof.get('files'), 'PAYLOAD_SCOPE_CHANGED')


def published_proofs(directory, c):
    for row in c['publishedOverlays']:
        path = directory / row['proofFile']
        need(not path.is_symlink() and sha(path.read_bytes()) == row['proofSha256'], 'PUBLISHED_PROOF_CHANGED')


def verify_runtime(d, h, states, c):
    shared = load('shared-bank-card-release.py')
    need(all(shared.configuration_matches(h, d, state, c['runtimeConfigurationSha256'][role])
             for role, state in states.items()), 'RUNTIME_CONFIGURATION_CHANGED')
    row = json.loads(d.run('docker', 'inspect', states['online-recharge']['containerId']))[0]
    need(row['HostConfig']['NetworkMode'] == 'container:' + states['api']['containerId'], 'API_BINDING_CHANGED')


def preserved_admin(d, states, c):
    prefix = '/usr/share/nginx/html/'
    output = d.run('docker', 'exec', states['admin']['containerId'], 'find', prefix,
                   '-type', 'f', '-exec', 'sha256sum', '{}', '+', timeout=60)
    actual = {}
    for line in output.splitlines():
        digest, name = line.split('  ', 1)
        need(name.startswith(prefix) and name.removeprefix(prefix) not in actual,
             'ADMIN_CONTENT_INVALID')
        actual[name.removeprefix(prefix)] = digest
    need(actual == c['publicFiles'], 'PRESERVED_ADMIN_CONTENT_CHANGED')
    need(d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum',
               '/etc/nginx/conf.d/default.conf').split()[0] == c['nginxSha256'], 'NGINX_CHANGED')


def baseline(d, h, c):
    previous = (BASE / 'current').resolve()
    need(str(previous) == c['current'] and previous.parent == BASE / 'releases', 'CURRENT_CHANGED')
    raw = (previous / 'release-manifest.json').read_bytes()
    need(sha(raw) == c['manifestSha256'] and json.loads(raw)['commit'] == c['expectedCurrent'], 'MANIFEST_CHANGED')
    states = h.snapshot(d, previous)
    need(states == c['services'], 'SERVICES_CHANGED')
    need(all(sha((previous / name).read_bytes()) == value for name, value in c['configurationSha256'].items()),
         'HOST_CONFIGURATION_CHANGED')
    published_proofs(previous, c)
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    normalizer = Path(c['backupNormalizerPath'])
    need(normalizer.is_relative_to(BASE / 'releases') and normalizer.is_file()
         and not normalizer.is_symlink() and sha(normalizer.read_bytes()) == c['backupNormalizerSha256'],
         'BACKUP_NORMALIZER_CHANGED')
    verify_runtime(d, h, states, c)
    preserved_admin(d, states, c)
    load('online-checkout-release.py').read_hashes(d, states['api']['containerId'],
                                                  '/app/apps/api/dist/', c['beforeApiOnlineFiles'])
    load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], c['beforeEngineFiles'])
    h.guards(d, previous, states, c)
    return previous, raw, states


def smoke(d, h, target, states, proof, c):
    load('online-checkout-release.py').read_hashes(d, states['api']['containerId'], '/app/apps/api/dist/',
                                                  {**c['beforeApiOnlineFiles'], **proof['apiModules']})
    load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], c['afterEngineFiles'])
    need(all(states[role] == c['services'][role] for role in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
    need(all(states[role]['environmentSha256'] == c['services'][role]['environmentSha256'] for role in UPDATED),
         'ENVIRONMENT_CHANGED')
    verify_runtime(d, h, states, c)
    preserved_admin(d, states, c)
    h.engine_idle(d, states['online-recharge'], c, wait_connected=True)


def switch_services(d, h, p, previous, target, plan, before, images, proof, c, journal):
    fence = p.sql_fence_class(c)(d, previous)
    marker = p.claim_markers(d, before, plan)
    journal.write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target), 'previous': str(previous)}) + '\n')
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
        need(all(after[role]['image'] == images[role]['imageId'] for role in UPDATED), 'IMAGE_CHANGED')
        smoke(d, h, target, after, proof, c)
    except BaseException:
        journal.write_text(json.dumps({'status': 'SWITCH_FAILED', 'target': str(target),
                                       'previous': str(previous), 'businessActions': 0}) + '\n')
        raise
    finally:
        fence.close()
    p.release_markers(marker)
    h.guards(d, target, after, c)
    return after


def release(plan, c):
    validate_contract(c)
    need(plan['mode'] in ('preflight', 'release', 'readback')
         and all(re.fullmatch('[a-f0-9]{40}', plan[name]) for name in ('commit', 'tree'))
         and all(re.fullmatch('[1-9][0-9]*', plan[name])
                 for name in ('workflowRunId', 'workflowRunAttempt')), 'IDENTITY_INVALID')
    need(sha((HERE / CONTRACT_FILE).read_bytes()) == plan['contractSha256'], 'CONTRACT_CHANGED')
    need(set(plan['controlSources']) == set(c['controlFiles'])
         and all(sha((HERE / name).read_bytes()) == digest for name, digest in plan['controlSources'].items()),
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
            need(manifest.get('commit') == plan['commit'] and manifest.get('scope') == SCOPE, 'READBACK_CURRENT_CHANGED')
            published_proofs(target, c)
            raw_proof = (target / 'online-checkout-cs-build-proof.json').read_bytes()
            receipt = json.loads((target / 'online-checkout-cs-preservation.json').read_bytes())
            need(sha(raw_proof) == plan['buildProofSha256'], 'READBACK_PROOF_CHANGED')
            states = h.snapshot(d, target)
            need(states == receipt['after'], 'READBACK_SERVICES_CHANGED')
            smoke(d, h, target, states, json.loads(raw_proof), c)
            h.guards(d, target, states, c)
            return {'status': 'ONLINE_CHECKOUT_CS_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'],
                    'migrationPerformed': False, 'businessActions': 0}
        previous, raw_manifest, before = baseline(d, h, c)
        if plan['mode'] == 'preflight':
            return {'status': 'ONLINE_CHECKOUT_CS_PREFLIGHT_VERIFIED', 'commit': plan['commit'], 'businessActions': 0}
        stage = BASE / '.staging' / ('online-checkout-cs-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        expected = ('https://github.com/wangchaozhuanyong/id-business-system/releases/download/'
                    'online-checkout-cs-' + plan['commit'] + '/online-checkout-cs-artifact.tar.gz')
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
        images = {}
        for role, copy_line in [('api', 'COPY modules/ /app/apps/api/dist/'),
                                ('online-recharge', 'COPY source/ /workspace/engine/')]:
            context = stage / ('image-' + role)
            if role == 'api':
                shutil.copytree(payload / 'api', context)
            else:
                shutil.copytree(payload / 'engine', context / 'source')
            a.normalize_image_context(context)
            reference = 'id-business-v2-online-checkout-cs:' + plan['commit'] + '-' + plan['workflowRunId'] + '-' + role
            original = json.loads(d.run('docker', 'image', 'inspect', before[role]['image']))[0]
            base_ref = h.base_image_reference(d, before[role])
            (context / 'Dockerfile').write_text('FROM ' + base_ref + '\n' + copy_line
                + '\nLABEL org.opencontainers.image.revision="' + plan['commit']
                + '" id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n')
            h.build_image(d, context, reference, role, before[role], stage)
            built = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
            load('online-checkout-release.py').verify_image(original, built, plan)
            images[role] = {'reference': reference, 'imageId': built['Id']}
        baseline(d, h, c)
        backup = h.fresh_scoped_backup(d, previous, plan, normalizer_path=Path(c['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-online-checkout-cs')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(previous, target, symlinks=True)
        for name in c['sources']:
            path = target / name
            need(path.resolve().is_relative_to(target) and not path.is_symlink(), 'HOST_SOURCE_PATH_CHANGED')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((payload / 'source' / name).read_bytes())
            path.chmod(0o644)
        for name, pin in c['validationOnlySources'].items():
            path = target / name
            need(path.resolve().is_relative_to(target) and not path.is_symlink(), 'HOST_SOURCE_PATH_CHANGED')
            raw = (payload / 'engine' / name.removeprefix(ENGINE_ROOT + '/')).read_bytes()
            need(sha(raw) == pin['sha256'], 'VALIDATION_SOURCE_CHANGED')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
            path.chmod(0o644)
        for name in [*plan['controlSources'], CONTRACT_FILE]:
            path = target / 'scripts/production-release' / name
            need(not path.is_symlink(), 'CONTROL_PATH_CHANGED')
            path.write_bytes((HERE / name).read_bytes())
        override = json.loads((target / 'compose.release.json').read_bytes())
        for role in UPDATED:
            override['services'][role]['image'] = images[role]['reference']
        a.write_release_override(target / 'compose.release.json', override)
        baseline(d, h, c)
        journal = stage / 'switch-state.json'
        after = switch_services(d, h, p, previous, target, plan, before, images, proof, c, journal)
        receipt = {'status': 'DEPLOYED', 'commit': plan['commit'], 'before': before, 'after': after,
                   'images': images, 'backup': backup, 'artifactSha256': plan['artifactSha256'],
                   'buildProofSha256': plan['buildProofSha256'], 'updatedServices': list(UPDATED),
                   'preservedServices': list(PRESERVED), 'migrationPerformed': False, 'businessActions': 0}
        (target / 'online-checkout-cs-preservation.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
        (target / 'online-checkout-cs-build-proof.json').write_bytes(raw_proof)
        manifest = json.loads(raw_manifest)
        manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=SCOPE,
                        previousCommit=c['expectedCurrent'], previousRelease=str(previous),
                        previousManifestSha256=sha(raw_manifest), status='DEPLOYED', servicesUpdated=list(UPDATED),
                        newMigrations=[], migrationPerformed=False, paymentActions=0,
                        onlineCheckoutCsPublication=receipt)
        for role in UPDATED:
            manifest['images'][role] = {'reference': images[role]['reference'], 'digest': images[role]['imageId'],
                                        'sourceCommit': plan['commit']}
            projections = manifest.setdefault('roleSourceProjections', {})
            projections[role] = {'kind': SCOPE, 'commit': plan['commit'], 'parentProjection': projections.get(role),
                                 'buildProofSha256': plan['buildProofSha256'],
                                 'sources': {name: digest for name, digest in c['sources'].items()
                                             if (name.startswith(ENGINE_ROOT + '/') if role == 'online-recharge'
                                                 else name.startswith('apps/api/') and not name.startswith(ENGINE_ROOT + '/'))},
                                 'runtimeModules': proof['apiModules'] if role == 'api' else c['afterEngineFiles']}
            if role == 'online-recharge':
                projections[role]['validationOnlySources'] = c['validationOnlySources']
                projections[role]['sources'].update({name: pin['sha256']
                                                     for name, pin in c['validationOnlySources'].items()})
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-online-checkout-cs')
        journal.write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target), 'commit': plan['commit']}) + '\n')
        return {'status': 'ONLINE_CHECKOUT_CS_DEPLOYED', 'commit': plan['commit'],
                'updatedServices': list(UPDATED), 'preservedServices': list(PRESERVED),
                'migrationPerformed': False, 'businessActions': 0}
