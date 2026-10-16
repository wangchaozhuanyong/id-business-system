"""Finite mailbox API/Admin overlay, preserving the published component lineage."""
import copy
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
SCOPE = 'MAILBOX_REALTIME_20261016'
CURRENT = 'd44393c5bee8c30c82737fc3e00fa89785a95667'
WORKER = 'apps/api/src/id-business-v2/auto-registration/worker/'
APPLICATION_PATHS = (
    'packages/shared/src/v2/vendure-mailbox.ts',
    'apps/api/src/id-business-v2/auto-registration/apple-mailbox-pool.ts',
    'apps/api/src/id-business-v2/workspace/id-business-v2-vendure-mailbox.controller.ts',
    'apps/api/src/id-business-v2/workspace/id-business-v2-vendure-mailbox.service.ts',
    'apps/api/src/id-business-v2/workspace/providers/id-business-v2-vendure-mailbox.client.ts',
    'apps/admin/src/v2/features/auto-recharge/vendure-mailbox-api.ts',
    'apps/admin/src/v2/features/auto-recharge/VendureMailboxManager.vue',
    'apps/admin/src/v2/features/auto-recharge/VendureMailboxHealth.vue',
    'apps/admin/src/v2/features/auto-recharge/vendure-mailbox-health.ts')


def need(value, code):
    if not value:
        raise RuntimeError('MAILBOX_REALTIME_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def helper(name):
    spec = importlib.util.spec_from_file_location('mailbox_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_contract(c):
    raw = (HERE / 'registration-parity-diagnostics-contract.json').read_bytes()
    need(digest(raw) == c.get('inheritedContractSha256'), 'INHERITED_CONTRACT_CHANGED')
    parent = json.loads(raw)
    helper('registration-parity-diagnostics-release.py').verify_contract(parent)
    need(c.get('version') == 1 and c.get('frozen') is True and c.get('scope') == SCOPE
         and c.get('expectedCurrent') == CURRENT and c.get('migration') is None
         and set(c.get('sources', {})) == set(APPLICATION_PATHS)
         and c.get('workerFiles') == {} and c.get('sharedRuntimeUnchanged') is True,
         'CONTRACT_SCOPE_CHANGED')
    # Retain every runtime, database, configuration and task protection from the measured predecessor.
    retained = ('current', 'manifestSha256', 'services', 'roleSourceCommits', 'runtimeEvidence',
                'sourceProjectionSha256', 'hostSourceInheritance', 'sqliteReviewPolicy',
                'baselineApiFiles', 'baselineAdminFiles', 'runtimeAdminFiles', 'baselineWorkerFiles',
                'baselineEngineFiles', 'baselinePrismaClientFiles', 'runtimePrismaClientFiles',
                'schemaSha256', 'configurationSha256', 'runtimeConfigurationSha256', 'databaseReceipt',
                'runtimePythonDependencies', 'backupNormalizerPath')
    need(all(c.get(n) == parent.get(n) for n in retained), 'BASELINE_PROTECTION_CHANGED')
    modules = {'id-business-v2/auto-registration/apple-mailbox-pool.js',
               'id-business-v2/workspace/id-business-v2-vendure-mailbox.controller.js',
               'id-business-v2/workspace/id-business-v2-vendure-mailbox.service.js',
               'id-business-v2/workspace/providers/id-business-v2-vendure-mailbox.client.js'}
    need(c.get('apiModules') == {n: parent['baselineApiFiles'][n] for n in modules}, 'API_MODULE_SCOPE_CHANGED')
    need(set(c.get('validationSources', {})) == {
        'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.service.spec.ts',
        'apps/api/src/id-business-v2/workspace/mail-health.spec.ts',
        'apps/admin/src/v2/features/auto-recharge/vendure-mailbox-health.spec.ts',
        'apps/admin/src/v2/testing/V2VendureMailboxDesignFixture.vue',
        'scripts/acceptance-v2-mailbox-realtime.mjs'}, 'VALIDATION_SCOPE_CHANGED')
    need(all(re.fullmatch('[a-f0-9]{64}', v) for v in {**c['sources'], **c['validationSources']}.values()),
         'SOURCE_HASH_INVALID')
    for name, expected in c['buildSupportHashes'].items():
        need(digest((HERE / Path(name).name).read_bytes()) == expected, 'INHERITED_EXECUTOR_CHANGED')
    return parent


def runtime_contract(c):
    # The old read-only inspector accepts both generations. This release retains the current worker bytes.
    return {**c, 'workerFiles': c['baselineWorkerFiles']}


def baseline(d, h, a, finite, c, expected=None):
    return helper('registration-parity-diagnostics-release.py').baseline(d, h, a, finite, runtime_contract(c), expected)


def smoke(d, target, states, c, proof, receipt, h, a, finite):
    return helper('registration-parity-diagnostics-release.py').smoke(d, target, states, runtime_contract(c), proof, receipt, h, a, finite)


def inherited_host_source(c):
    return helper('registration-parity-diagnostics-release.py').inherited_host_source(c)


def sqlite_receipt(d, directory, c, expected_logical=None):
    return helper('registration-parity-diagnostics-release.py').sqlite_receipt(d, directory, runtime_contract(c), expected_logical)


def backup_sqlite(old, d, directory, plan, states, marker, safety, c):
    return helper('registration-parity-diagnostics-release.py').backup_sqlite(old, d, directory, plan, states, marker, safety, runtime_contract(c))


def archive(raw, destination):
    return helper('registration-parity-diagnostics-release.py').archive(raw, destination)


def verify_proof(proof, plan, c, payload, h):
    need(all(proof.get(n) == plan[n] for n in ('commit', 'tree', 'contractSha256', 'controlSources'))
         and proof.get('scope') == SCOPE and proof.get('sources') == c['sources']
         and proof.get('workerFiles') == {} and proof.get('sharedRuntimeUnchanged') is True
         and proof.get('baselineApiReproduced') is True and proof.get('baselineAdminReproduced') is True
         and proof.get('updatedServices') == ['api', 'admin'] and proof.get('migrationPerformed') is False,
         'PROOF_INVALID')
    allowed = {name.removesuffix('.js') + suffix for name in c['apiModules'] for suffix in ('.js', '.js.map', '.d.ts')}
    need(proof['apiModules'] and set(proof['apiModules']) <= allowed and len(proof['adminFiles']) > 200,
         'COMPILED_SCOPE_CHANGED')
    expected = {**{'source/' + n: v for n, v in c['sources'].items()},
                **{'api/modules/' + n: v for n, v in proof['apiModules'].items()},
                **{'admin/html/' + n: v for n, v in proof['adminFiles'].items()}}
    files = h.file_inventory(payload)
    files.pop('build-proof.json', None)
    need(files == expected == proof['files'], 'PAYLOAD_SCOPE_CHANGED')
    need(proof.get('validation') == {'scope': SCOPE, 'sources': c['sources'], 'validationSources': c['validationSources'],
         'businessActions': 0, 'externalRequests': 0, 'status': 'PASS'}, 'VALIDATION_MISSING')
    return proof


def release(plan, contract, d, h):
    verify_contract(contract)
    need(plan['mode'] in ('preflight', 'release', 'readback') and contract['scope'] == SCOPE
         and contract['expectedCurrent'] == CURRENT
         and contract['migration'] is None and contract.get('frozen') is True
         and all(re.fullmatch('[a-f0-9]{40}', plan[n]) for n in ('commit', 'tree'))
         and all(re.fullmatch('[1-9][0-9]*', plan[n]) for n in ('workflowRunId', 'workflowRunAttempt')), 'IDENTITY_INVALID')
    a, finite = helper('recharge-availability-release.py'), helper('proxy-result-identity-release.py')
    with (BASE / '.deploy.lock').open('a') as lock:
        a.acquire_release_lock(lock)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve()
            raw = (target / 'release-manifest.json').read_bytes()
            manifest = json.loads(raw)
            need(manifest['commit'] == plan['commit'] and manifest['sourceTree'] == plan['tree']
                 and manifest['scope'] == SCOPE, 'READBACK_CURRENT_CHANGED')
            receipt = json.loads((target / 'mailbox-realtime-preservation.json').read_bytes())
            proof_raw = (target / 'mailbox-realtime-build-proof.json').read_bytes()
            need(digest(proof_raw) == plan['buildProofSha256'], 'READBACK_PROOF_CHANGED')
            proof = json.loads(proof_raw)
            need(all(proof.get(n) == plan[n] for n in ('commit', 'tree', 'contractSha256', 'controlSources'))
                 and proof['sources'] == contract['sources'], 'READBACK_IDENTITY_CHANGED')
            need(all(digest((target / name).read_bytes()) == value for name, value in contract['sources'].items())
                 and all(digest((target / 'scripts/production-release' / name).read_bytes()) == value
                         for name, value in plan['controlSources'].items()), 'READBACK_SOURCE_CHANGED')
            states = h.snapshot(d, target)
            need(states == receipt['after'], 'READBACK_SERVICES_CHANGED')
            smoke(d, target, states, contract, proof, receipt, h, a, finite)
            need(manifest['roleSourceProjections']['online-recharge'] == receipt['previousRoleProjections']['online-recharge']
                 and all(manifest['roleSourceProjections'][n]['parentProjection'] == receipt['previousRoleProjections'][n]
                         for n in ('api', 'admin')), 'ROLE_INHERITANCE_CHANGED')
            finite.release_markers(receipt['maintenance'])
            (target / 'mailbox-realtime-readback.json').write_text(json.dumps({'status': 'VERIFIED',
                'commit': plan['commit'], 'maintenanceReleased': True, 'migrationPerformed': False, 'businessActions': 0}) + '\n')
            return {'status': SCOPE + '_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'],
                    'migrationPerformed': False, 'businessActions': 0, 'maintenanceReleased': True,
                    'updatedServices': ['api', 'admin'], 'reboundServices': ['online-recharge']}
        previous, raw_manifest, before, observed = baseline(d, h, a, finite, contract, plan.get('runtimeBaseline'))
        if plan['mode'] == 'preflight':
            return {'status': SCOPE + '_PREFLIGHT_VERIFIED', 'commit': plan['commit'], 'runtimeBaseline': observed,
                    'migrationPerformed': False, 'businessActions': 0}
        need(type(plan.get('runtimeBaseline')) is dict, 'PREFLIGHT_REQUIRED')
        stage = BASE / '.staging' / ('mailbox-realtime-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        expected_url = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/mailbox-realtime-' + plan['commit'] + '/mailbox-realtime-artifact.tar.gz'
        need(plan['artifactUrl'] == expected_url, 'ARTIFACT_LOCATION_INVALID')
        with urllib.request.urlopen(expected_url, timeout=60) as response:
            raw = response.read(64 * 1024**2 + 1)
        need(0 < len(raw) <= 64 * 1024**2 and digest(raw) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        payload = archive(raw, stage / 'content')
        proof_raw = (payload / 'build-proof.json').read_bytes()
        need(digest(proof_raw) == plan['buildProofSha256'], 'PROOF_CHANGED')
        proof = verify_proof(json.loads(proof_raw), plan, contract, payload, h)
        billing = helper('recharge-billing-release.py')
        images = {}
        for role, copies, count in [('api', 'COPY modules/ /app/apps/api/dist/\n', 1),
                                    ('admin', 'COPY html/ /usr/share/nginx/html/\n', 1)]:
            context = payload / role
            a.normalize_image_context(context)
            original = json.loads(d.run('docker', 'image', 'inspect', before[role]['image']))[0]
            reference = h.base_image_reference(d, before[role])
            (context / 'Dockerfile').write_text('FROM ' + reference + '\n' + copies
                + 'LABEL org.opencontainers.image.revision="' + plan['commit']
                + '" id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n')
            image = 'id-business-v2-mailbox-realtime:' + plan['commit'] + '-' + plan['workflowRunId'] + '-' + role
            h.build_image(d, context, image, role, before[role], stage)
            built = json.loads(d.run('docker', 'image', 'inspect', image))[0]
            finite.verify_overlay_image(original, built, plan, count, billing)
            images[role] = {'reference': image, 'imageId': built['Id']}
        need(baseline(d, h, a, finite, contract, plan['runtimeBaseline']) == (previous, raw_manifest, before, observed), 'BASELINE_MOVED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-mailbox-realtime')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(previous, target, symlinks=True)
        inherited = inherited_host_source(contract)
        for name in contract['hostSourceInheritance']['files']:
            path = target / name
            need(not path.is_symlink(), 'SOURCE_PATH_INVALID')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((inherited / name).read_bytes())
        for name in contract['sources']:
            path = target / name
            need(not path.is_symlink() and path.resolve().is_relative_to(target), 'SOURCE_PATH_INVALID')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((payload / 'source' / name).read_bytes())
            path.chmod(0o644)
        for name, expected in plan['controlSources'].items():
            raw = Path(__file__).with_name(name).read_bytes()
            need(digest(raw) == expected, 'CONTROL_CHANGED')
            path = target / 'scripts/production-release' / name
            need(not path.is_symlink(), 'CONTROL_PATH_INVALID')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        override = json.loads((target / 'compose.release.json').read_bytes())
        for role in ('api', 'admin'):
            override['services'][role]['image'] = images[role]['reference']
        a.write_release_override(target / 'compose.release.json', override)
        baseline(d, h, a, finite, contract, plan['runtimeBaseline'])
        maintenance = finite.claim_markers(d, before, plan)
        journal, fence = stage / 'switch-state.json', None
        try:
            finite.verify_markers(maintenance)
            d.assert_no_active_recharge(previous)
            d.assert_no_active_registration(previous)
            h.engine_idle(d, before['online-recharge'], contract)
            need(sqlite_receipt(d, previous, contract) == observed['sqlite'], 'SQLITE_MOVED')
            backup = h.fresh_scoped_backup(d, previous, plan, normalizer_path=Path(contract['backupNormalizerPath']))
            need(backup.get('s3Verified') is True, 'MYSQL_BACKUP_UNVERIFIED')
            old = helper('registration-closure-release.py')
            marker = Path(maintenance['paths'][1])
            safety = inherited / WORKER / 'release_safety.py'
            need(digest(safety.read_bytes()) == contract['baselineWorkerFiles']['release_safety.py'], 'BASE_SAFETY_CHANGED')
            sqlite_backup = backup_sqlite(old, d, previous, plan, before, marker, safety, contract)
            need(sqlite_backup['s3Verified'] and sqlite_backup['logical'] == observed['sqlite'], 'SQLITE_BACKUP_UNVERIFIED')
            fence = finite.sql_fence_class(contract)(d, previous)
            fence.acquire()
            fence.check_idle()
            finite.verify_markers(maintenance)
            need(sqlite_receipt(d, previous, contract) == observed['sqlite'], 'SQLITE_MOVED_AFTER_FENCE')
            journal.write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target), 'maintenance': maintenance}) + '\n')
            fence.stop(before['api'], grace=30)
            fence.stop(before['online-recharge'], grace=45)
            fence.close()
            fence = None
            d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'api', 'admin', timeout=180)
            for role in ('api', 'admin'):
                d.wait_healthy(target, role)
            d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'online-recharge', timeout=180)
            d.wait_healthy(target, 'online-recharge')
            after = h.snapshot(d, target)
            need(all(after[n]['image'] == images[n]['imageId'] for n in images), 'PUBLISHED_IMAGE_CHANGED')
            manifest = json.loads(raw_manifest)
            projections = copy.deepcopy(manifest['roleSourceProjections'])
            receipt = {'status': SCOPE + '_DEPLOYED', 'commit': plan['commit'], 'tree': plan['tree'], 'before': before,
                'after': after, 'database': observed['database'], 'sqlite': observed['sqlite'], 'mysqlBackup': backup,
                'sqliteBackup': sqlite_backup, 'maintenance': maintenance, 'previousRoleProjections': projections,
                'images': images, 'updatedServices': ['api', 'admin'], 'reboundServices': ['online-recharge'],
                'migrationPerformed': False, 'businessActions': 0}
            receipt['hostSourceInheritance'] = contract['hostSourceInheritance']
            smoke(d, target, after, contract, proof, receipt, h, a, finite)
            for role in ('api', 'admin'):
                manifest['roleSourceProjections'][role] = {'kind': SCOPE, 'commit': plan['commit'], 'sourceTree': plan['tree'],
                    'parentProjection': projections[role], 'publishedBaseImageId': before[role]['image'],
                    'parentObservedSourceProjection': {'kind': 'CANONICAL_PUBLISHED_PROJECTION_HASHES',
                        **contract['sourceProjectionSha256']},
                    'runtimeImageId': images[role]['imageId'], 'buildProofSha256': plan['buildProofSha256'],
                    'runtimeFiles': proof['apiModules'] if role == 'api' else proof['adminFiles'],
                    'workerFiles': proof['workerFiles'] if role == 'api' else {},
                    'sourceDelta': {n: v for n, v in contract['sources'].items() if n.startswith('apps/api/' if role == 'api' else 'apps/admin/')}}
                manifest['images'][role] = {'reference': images[role]['reference'], 'digest': images[role]['imageId'], 'sourceCommit': plan['commit']}
            manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=SCOPE, status='DEPLOYED',
                previousCommit=contract['expectedCurrent'], previousRelease=str(previous), previousManifestSha256=digest(raw_manifest),
                previousRoleSourceProjections=projections, previousSourceProjection=manifest.get('sourceProjection'),
                sourceProjection={'kind': SCOPE, 'baselineCommit': contract['expectedCurrent'],
                                  'sourceBaseline': contract['sourceBaseline'], 'sourceBaselineTree': contract['sourceBaselineTree'],
                                  'method': 'PUBLISHED_RUNTIME_PLUS_TASK_DELTA', 'sources': contract['sources'],
                                  'roleSourceCommits': contract['roleSourceCommits'],
                                  'reviewedApplicationCommit': contract['reviewedApplicationCommit'],
                                  'hostSourceInheritance': contract['hostSourceInheritance'],
                                  'buildProofSha256': plan['buildProofSha256']},
                servicesUpdated=['api', 'admin'], servicesRebound=['online-recharge'], newMigrations=[], migrationPerformed=False,
                paymentActions=0, subscriptionChanged=False, externalNotification=False, validationRun=plan['workflowRunId'],
                actualDeployment=receipt, compiledArtifact={'url': plan['artifactUrl'], 'sha256': plan['artifactSha256']})
            (target / 'mailbox-realtime-build-proof.json').write_bytes(proof_raw)
            (target / 'mailbox-realtime-preservation.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
            (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
            d.point_current(target, stamp + '-mailbox-realtime')
            journal.write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target), 'maintenance': maintenance}) + '\n')
            return {n: receipt[n] for n in ('status', 'commit', 'tree', 'images', 'updatedServices', 'reboundServices', 'migrationPerformed', 'businessActions')}
        except BaseException:
            journal.write_text(json.dumps({'status': 'NEEDS_FORWARD_DIAGNOSIS', 'target': str(target),
                'maintenance': maintenance, 'maintenanceHeld': True, 'rollbackPerformed': False,
                'switchMayHaveStarted': True}) + '\n')
            raise
        finally:
            if fence is not None:
                fence.close()
