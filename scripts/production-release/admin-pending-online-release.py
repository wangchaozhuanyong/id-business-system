"""Admin-only successor of B while ONLINE stays unpublished.

This adapter never enters Workspace/ONLINE qualification or alters their old
receipts. Exact inverse source projection is reused, but only Admin build inputs
and the three already-projected runtime files are adopted.
"""
import argparse
import base64
import copy
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import time

BASELINE = '31d2c6885a45817cd40d23fce8d6145bc9f18af2'
BASELINE_MANIFEST_SHA256 = '84936d13d8cd241d62e606a13faf1a0d5d8fd4fa1abdfb21fb091c4298bfc382'
CONTEXT = '.deploy/production-release/admin-pending-online-build-context'
RECORD = '.deploy/production-release/admin-pending-online-build-projection.json'
PROOF = '.deploy/production-release/admin-pending-online-build-proof.json'
ADMIN_FILES = ('apps/admin/src/v2-router.ts', 'apps/admin/src/v2/features/feature.ts',
    'apps/admin/src/v2/features/registry.spec.ts', 'apps/admin/src/v2/features/registry.ts',
    'apps/admin/src/v2/features/roles/rolePermissionWorkspace.ts',
    'apps/admin/src/v2/features/tableSchemas.ts', 'apps/admin/src/v2/layouts/V2AdminLayout.vue',
    'deploy/nginx/admin.conf', 'packages/shared/src/v2/data-scopes.ts')
APPROVED_ADMIN_INPUT_SHA256 = '013dff883299fd84c31919e2294ec725a2de8331a3a8f8892f26b502e71d6c13'
ADMIN_DIRECTORY = 'apps/admin/src/v2/features/online-recharge/'
ORIGIN_MARKERS = ('apiWorkspacePublication', 'pendingOnlineMigration', 'preservedMigrationOrigin')
REPOSITORY = '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'


def need(condition, code):
    if not condition:
        raise RuntimeError('ADMIN_PENDING_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def fingerprint(value):
    return digest(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def projection_module():
    return load_module('admin_existing_pending_projection', 'api-admin-pending-projection.py')


def controller_module():
    return load_module('admin_existing_deployment', 'remote-deploy.py')


def private_bytes(path, cap=65536):
    path = Path(path)
    need(not path.is_symlink() and path.resolve() == path, 'PRIVATE_PATH_CHANGED')
    identity = lambda row: (row.st_dev, row.st_ino, row.st_mode, row.st_nlink,
        row.st_uid, row.st_gid, row.st_size, row.st_mtime_ns, row.st_ctime_ns)
    initial = path.lstat()
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
        before = os.fstat(stream.fileno())
        need(identity(initial) == identity(before) and stat.S_ISREG(before.st_mode)
             and stat.S_IMODE(before.st_mode) == 0o600 and before.st_nlink == 1
             and before.st_uid == os.geteuid() and 0 < before.st_size <= cap, 'PRIVATE_FILE_CHANGED')
        raw = stream.read(cap + 1)
        need(identity(before) == identity(os.fstat(stream.fileno()))
             == identity(path.lstat()) and len(raw) == before.st_size, 'PRIVATE_FILE_CHANGED')
    return raw


def read_json(path):
    def unique(rows):
        result = {}
        for key, value in rows:
            need(key not in result, 'DUPLICATE_FIELD')
            result[key] = value
        return result
    path = Path(path)
    if not path.is_absolute():
        path = Path.cwd().resolve() / path
    return json.loads(private_bytes(path), object_pairs_hook=unique)


def write_json(path, value):
    path = Path(path)
    need(not path.exists() and not path.is_symlink(), 'OUTPUT_EXISTS')
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, sort_keys=True, separators=(',', ':'))
        stream.write('\n')
    path.chmod(0o600)


def project_admin(candidate, baseline, online, commit, tree):
    projection = projection_module()
    approved_inputs = {name: row for name, row in projection.inventory(candidate).items()
        if name.startswith(('apps/admin/', 'packages/shared/')) or name in (
            'package.json', 'package-lock.json', 'apps/api/package.json', '.dockerignore',
            'deploy/nginx/admin.conf', 'tsconfig.base.json')}
    need(fingerprint(approved_inputs) == APPROVED_ADMIN_INPUT_SHA256, 'UNREVIEWED_ADMIN_SOURCE')
    full, sealed = projection.project_files(candidate, baseline, online, commit, tree)
    output = dict(candidate)
    generated = {name: sealed['generatedFiles'][name] for name in ADMIN_FILES}
    for name in ADMIN_FILES:
        output[name] = full[name]
    removed = {name: row for name, row in sealed['removedFiles'].items()
               if name.startswith(ADMIN_DIRECTORY)}
    need(removed and all(name in candidate for name in removed), 'ADMIN_SOURCE_UNAVAILABLE')
    for name in removed:
        del output[name]
    unchanged = {name: row for name, row in projection.inventory(candidate).items()
                 if name not in generated and name not in removed}
    rows = projection.inventory(output)
    need(all(rows[name] == row for name, row in unchanged.items())
         and set(rows) == set(unchanged) | set(generated), 'UNRELATED_BUILD_SOURCE_CHANGED')
    record = {'version': 1, 'scope': 'ADMIN_PENDING_ONLINE_BUILD_PROJECTION',
        'candidateCommit': commit, 'candidateTree': tree,
        'baselineCommit': projection.BASELINE_COMMIT, 'baselineTree': projection.BASELINE_TREE,
        'onlineCommit': projection.ONLINE_COMMIT, 'onlineTree': projection.ONLINE_TREE,
        'approvedAdminInputSha256': APPROVED_ADMIN_INPUT_SHA256,
        'sourceProjectionSha256': sealed['projectionSha256'], 'contextPath': CONTEXT,
        'outputTree': projection.source_tree(output), 'outputFilesSha256': fingerprint(rows),
        'generatedFiles': generated, 'removedFiles': removed,
        'unchangedFilesSha256': fingerprint(unchanged),
        'runtimeFiles': {name: {'mode': full[name][1], 'sha256': digest(full[name][0])}
                         for name in projection.RUNTIME_FILES}}
    record['projectionSha256'] = fingerprint(record)
    return output, record, {name: full[name] for name in projection.RUNTIME_FILES}


def git_files(d, commit):
    raw = subprocess.check_output(['git', 'archive', '--format=tar',
        '--prefix=id-business-system-' + commit + '/', commit])
    return d.registration_archive(raw, commit)


def source_projection(d, commit, tree, *, local=False):
    archives = {}
    def read(sha):
        if local:
            return git_files(d, sha)
        raw = d.registration_download(sha)
        archives[sha] = raw
        return d.registration_archive(raw, sha)
    projection = projection_module()
    candidate = read(commit)
    output, record, runtime = project_admin(candidate, read(projection.BASELINE_COMMIT),
                                           read(projection.ONLINE_COMMIT), commit, tree)
    return candidate, output, record, runtime, (None if local else digest(archives[commit]))


def prepare_build(d):
    commit, tree = os.environ.get('RELEASE_COMMIT'), os.environ.get('SOURCE_TREE')
    need(os.environ.get('RELEASE_OPERATION') == 'release_admin'
         and os.environ.get('EXPECTED_CURRENT') == BASELINE
         and re.fullmatch(r'[a-f0-9]{40}', commit or '')
         and re.fullmatch(r'[a-f0-9]{40}', tree or '')
         and d.run('git', 'rev-parse', 'HEAD') == commit
         and d.run('git', 'rev-parse', 'HEAD^{tree}') == tree, 'BUILD_SELECTION_CHANGED')
    _, output, record, _, _ = source_projection(d, commit, tree, local=True)
    root = Path.cwd().resolve()
    context, target = root / CONTEXT, root / RECORD
    need(not context.exists() and not context.is_symlink() and not target.exists()
         and not target.is_symlink() and all(not p.is_symlink() for p in context.parents), 'OUTPUT_EXISTS')
    context.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    d.write_registration_files(context, output)
    write_json(target, record)
    return record


def image_proof(d):
    record = read_json(RECORD)
    commit, tree = os.environ.get('RELEASE_COMMIT'), os.environ.get('SOURCE_TREE')
    need(os.environ.get('RELEASE_OPERATION') == 'release_admin'
         and os.environ.get('EXPECTED_CURRENT') == BASELINE, 'BUILD_SELECTION_CHANGED')
    _, output, expected, _, _ = source_projection(d, commit, tree, local=True)
    need(record == expected, 'BUILD_RECORD_CHANGED')
    context = Path(CONTEXT).resolve()
    actual = {}
    for path in context.rglob('*'):
        need(not path.is_symlink(), 'CONTEXT_CHANGED')
        if path.is_file():
            actual[path.relative_to(context).as_posix()] = (
                path.read_bytes(), '100755' if path.stat().st_mode & 0o111 else '100644')
        else:
            need(path.is_dir(), 'CONTEXT_CHANGED')
    need(actual == output, 'CONTEXT_CHANGED')
    run, attempt, quality = (os.environ.get(name) for name in (
        'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'QUALITY_RUN_ID'))
    need(all(re.fullmatch(r'[1-9][0-9]*', n or '') for n in (run, attempt, quality))
         and os.environ.get('RELEASE_REPOSITORY') == REPOSITORY, 'BUILD_SELECTION_CHANGED')
    reference = f'{REPOSITORY}:{commit}-{run}-{attempt}-admin'
    image = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
    labels = image['Config']['Labels']
    need(image['Architecture'] == 'amd64' and re.fullmatch(r'sha256:[a-f0-9]{64}', image['Id'])
         and labels.get('org.opencontainers.image.revision') == commit
         and labels.get('id-business-v2.source-tree') == tree
         and labels.get('id-business-v2.admin-pending-projection-sha256') == record['projectionSha256'],
         'IMAGE_PROVENANCE_CHANGED')
    value = {'version': 1, 'scope': 'ADMIN_PENDING_ONLINE_BUILD', 'commit': commit,
        'sourceTree': tree, 'runId': run, 'runAttempt': attempt, 'qualityRunId': quality,
        'projection': record, 'image': {'reference': reference, 'imageId': image['Id']}}
    write_json(Path(PROOF).resolve(), value)
    return value


def snapshot(d, directory):
    need(set(d.production_services(directory)) == set(d.ALL_SERVICES), 'SERVICE_SET_CHANGED')
    result = {name: d.service_state(directory, name, include_container_id=True,
              include_environment_hash=True) for name in d.ALL_SERVICES}
    need(all(row['status'] == 'running' and (name == 'caddy' or row['health'] == 'healthy')
             for name, row in result.items()), 'SERVICE_NOT_HEALTHY')
    return result


def volume_state(d, directory, manifest):
    name = manifest['apiWorkspacePublication']['volume']['name']
    need(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', name), 'VOLUME_CHANGED')
    rows = json.loads(d.run('docker', 'volume', 'inspect', name))
    need(isinstance(rows, list) and len(rows) == 1 and rows[0].get('Name') == name, 'VOLUME_CHANGED')
    api_id = d.compose(directory, 'ps', '-q', 'api')
    api = json.loads(d.run('docker', 'inspect', api_id))[0]
    mounts = [row for row in api.get('Mounts', [])
              if row.get('Destination') == '/app/.runtime/auto-registration']
    need(api.get('Id') == api_id and len(mounts) == 1
         and mounts[0].get('Type') == 'volume' and mounts[0].get('Name') == name
         and mounts[0].get('RW') is True and mounts[0].get('Source') == rows[0].get('Mountpoint'),
         'API_VOLUME_BINDING_CHANGED')
    return fingerprint({'volume': rows[0], 'apiContainerId': api_id, 'mount': mounts[0]})


def bind_baseline_images(manifest, states):
    images = manifest.get('images')
    need(isinstance(images, dict) and {'api', 'admin'} <= set(images), 'BASELINE_IMAGES_UNAVAILABLE')
    for name, image in images.items():
        if name in states:
            need(isinstance(image, dict) and states[name]['image'] == image.get('digest')
                 and states[name]['reference'] == image.get('reference'), 'BASELINE_IMAGE_CHANGED')


def preserve(d, previous, target, manifest, manifest_sha, before, environment, runtime, volume):
    need((d.BASE / 'current').resolve() == previous
         and digest(private_bytes(previous / 'release-manifest.json')) == manifest_sha,
         'BASELINE_CHANGED')
    need(private_bytes(previous / '.env.aws.production') == environment
         and private_bytes(target / '.env.aws.production') == environment, 'ENVIRONMENT_CHANGED')
    for name, (raw, _mode) in runtime.items():
        need((previous / name).read_bytes() == raw and (target / name).read_bytes() == raw,
             'RUNTIME_CONFIGURATION_CHANGED')
    need((previous / 'deploy/caddy/Caddyfile.aws').read_bytes()
         == (target / 'deploy/caddy/Caddyfile.aws').read_bytes(), 'EDGE_CONFIGURATION_CHANGED')
    after = snapshot(d, target)
    need(all(after[name] == before[name] for name in before if name != 'admin'), 'PRESERVED_SERVICE_CHANGED')
    need(volume_state(d, target, manifest) == volume, 'VOLUME_CHANGED')
    return after


def validate_proof(proof, args, expected):
    need(set(proof) == {'version', 'scope', 'commit', 'sourceTree', 'runId', 'runAttempt',
         'qualityRunId', 'projection', 'image'} and proof['version'] == 1
         and proof['scope'] == 'ADMIN_PENDING_ONLINE_BUILD'
         and proof['commit'] == args.commit and proof['sourceTree'] == args.source_tree
         and proof['runId'] == args.run_id and proof['runAttempt'] == args.run_attempt
         and proof['qualityRunId'] == args.ci_run_id and proof['projection'] == expected
         and set(proof['image']) == {'reference', 'imageId'}
         and proof['image']['reference'] == f'{REPOSITORY}:{args.commit}-{args.run_id}-{args.run_attempt}-admin'
         and re.fullmatch(r'sha256:[a-f0-9]{64}', proof['image']['imageId'] or ''), 'BUILD_PROOF_CHANGED')


def publish(d, args, proof):
    need(args.expected_current == BASELINE and args.repository == REPOSITORY
         and all(re.fullmatch(r'[a-f0-9]{40}', n or '') for n in (args.commit, args.source_tree))
         and all(re.fullmatch(r'[1-9][0-9]*', n or '') for n in (
             args.run_id, args.run_attempt, args.ci_run_id)), 'RELEASE_SELECTION_CHANGED')
    candidate, _output, expected, runtime, archive_sha = source_projection(d, args.commit, args.source_tree)
    validate_proof(proof, args, expected)
    os.umask(0o077)
    with (d.BASE / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        previous = (d.BASE / 'current').resolve()
        need(previous.parent == d.BASE / 'releases', 'BASELINE_PATH_CHANGED')
        manifest_raw = private_bytes(previous / 'release-manifest.json')
        manifest = json.loads(manifest_raw)
        need(digest(manifest_raw) == BASELINE_MANIFEST_SHA256 and manifest['commit'] == BASELINE
             and all(name in manifest for name in ORIGIN_MARKERS)
             and manifest['apiWorkspacePublication']['version'] == 4
             and manifest['apiWorkspacePublication']['onlinePublished'] is False
             and manifest['apiWorkspacePublication']['migrationPerformed'] is False, 'BASELINE_CHANGED')
        environment = private_bytes(previous / '.env.aws.production')
        before = snapshot(d, previous)
        bind_baseline_images(manifest, before)
        volume = volume_state(d, previous, manifest)
        for name, (raw, _mode) in runtime.items():
            need((previous / name).read_bytes() == raw, 'RUNTIME_CONFIGURATION_CHANGED')
            source = previous / '.deploy/production-release/pending-original-source' / name
            need(private_bytes(source) == candidate[name][0], 'ORIGINAL_RUNTIME_SOURCE_CHANGED')
        stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
        target = d.BASE / 'releases' / f'{stamp}-{args.commit[:12]}'
        changed = False
        phase = 'source'
        try:
            d.write_registration_files(target, candidate)
            original = target / '.deploy/production-release/pending-original-source'
            for name, (raw, mode) in runtime.items():
                saved = original / name
                saved.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                saved.write_bytes(candidate[name][0]); saved.chmod(0o600)
                (target / name).write_bytes(raw); (target / name).chmod(0o755 if mode == '100755' else 0o644)
            shutil.copy2(previous / '.env.aws.production', target / '.env.aws.production')
            (target / '.env.aws.production').chmod(0o600)
            need(not d.migration_plan(previous, target)
                 and (previous / 'deploy/caddy/Caddyfile.aws').read_bytes()
                     == (target / 'deploy/caddy/Caddyfile.aws').read_bytes(), 'MIGRATION_OR_EDGE_CHANGED')
            override = read_json(previous / 'compose.release.json')
            override['services']['admin']['image'] = proof['image']['reference']
            override['services']['admin']['pull_policy'] = 'never'
            write_json(target / 'compose.release.json', override)
            preserve(d, previous, target, manifest, digest(manifest_raw), before, environment, runtime, volume)
            phase = 'audit-before'
            write_json(target / 'admin-build-proof.json', proof)
            audit_before = d.audit(previous, target / 'before-audit.json', api_admin_only=True)
            need(audit_before.get('violationCount') == 0, 'AUDIT_FAILED')
            phase = 'backup'
            backup = d.fresh_backup(previous)
            write_json(target / 'backup-verification.json', backup)
            phase = 'images'
            password = d.run('aws', 'ecr', 'get-login-password', '--region', 'ap-northeast-1')
            login = d.subprocess.run(['docker', 'login', '--username', 'AWS', '--password-stdin',
                REPOSITORY.split('/')[0]], input=password, capture_output=True, text=True)
            need(login.returncode == 0, 'IMAGE_LOGIN_FAILED')
            try:
                d.run('docker', 'pull', proof['image']['reference'], timeout=900)
                image = json.loads(d.run('docker', 'image', 'inspect', proof['image']['reference']))[0]
                labels = image['Config']['Labels']
                need(image['Id'] == proof['image']['imageId'] and image['Architecture'] == 'amd64'
                     and labels.get('org.opencontainers.image.revision') == args.commit
                     and labels.get('id-business-v2.source-tree') == args.source_tree
                     and labels.get('id-business-v2.admin-pending-projection-sha256') == expected['projectionSha256'],
                     'IMAGE_PROVENANCE_CHANGED')
            finally:
                d.subprocess.run(['docker', 'logout', REPOSITORY.split('/')[0]], capture_output=True, text=True)
            need(d.shutil.disk_usage(d.BASE).free > 2 * 1024**3, 'DISK_CAPACITY_INSUFFICIENT')
            preserve(d, previous, target, manifest, digest(manifest_raw), before, environment, runtime, volume)
            d.assert_release_jobs_idle(previous, ('admin',))
            phase = 'admin-switch'
            changed = True
            d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'admin', timeout=300)
            d.wait_healthy(target, 'admin')
            phase = 'audit-after'
            audit_after = d.audit(target, target / 'after-audit.json', api_admin_only=True)
            need(audit_after.get('violationCount') == 0, 'AUDIT_FAILED')
            after = preserve(d, previous, target, manifest, digest(manifest_raw), before, environment, runtime, volume)
            need(after['admin']['image'] == proof['image']['imageId'], 'RUNNING_IMAGE_CHANGED')
            phase = 'public-verification'
            public = d.environment_values(target / '.env.aws.production')['APP_PUBLIC_URL'].rstrip('/')
            with d.urllib.request.urlopen(public + '/', timeout=20) as response:
                need(response.status == 200, 'PUBLIC_ADMIN_NOT_READY')
                need(('v2-' + args.commit).encode() in response.read(4 * 1024 * 1024), 'PUBLIC_ADMIN_VERSION_CHANGED')
            with d.urllib.request.urlopen(public + '/api/health/ready', timeout=20) as response:
                need(response.status == 200, 'PUBLIC_API_NOT_READY')
            after = preserve(d, previous, target, manifest, digest(manifest_raw), before, environment, runtime, volume)
            phase = 'manifest'
            ledger = {'version': 1, 'scope': 'ADMIN_ONLY_PENDING_ONLINE_SUCCESSOR',
                'commit': args.commit, 'sourceTree': args.source_tree, 'projection': expected,
                'buildProofSha256': fingerprint(proof), 'inheritedOriginCommit': BASELINE,
                'inheritedManifestSha256': digest(manifest_raw),
                'componentBaselines': {'api': BASELINE}, 'onlinePublished': False,
                'migrationPerformed': False, 'databaseGrantsChanged': False,
                'environmentSha256': digest(environment), 'volumeIdentitySha256': volume,
                'preservedServices': {name: {'before': before[name], 'after': after[name]}
                                      for name in before if name != 'admin'}}
            result = copy.deepcopy(manifest)
            result.update(commit=args.commit, sourceTree=args.source_tree, sourceBranch='main',
                previousCommit=BASELINE, previousRelease=str(previous), previousManifestSha256=digest(manifest_raw),
                releaseTag='v2-production-' + stamp, deployedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                ciWorkflow='Quality Gate', ciWorkflowRunId=int(args.ci_run_id),
                deploymentRun=f'github-actions-{args.run_id}-{args.run_attempt}',
                imageBuildRun=f'github-actions-{args.run_id}-{args.run_attempt}', servicesUpdated=['admin'],
                sourceArchiveSha256=archive_sha, backupBeforeRelease=backup['name'], migrationApplied=False,
                newMigrations=[], dataAuditBefore=audit_before, dataAuditAfter=audit_after,
                databaseGrants={'status': 'SKIPPED', 'reason': 'ADMIN_ONLY_UNCHANGED_DATABASE'}, adminPublication=ledger)
            result['images']['admin'] = {'reference': proof['image']['reference'],
                'digest': proof['image']['imageId'], 'sourceCommit': args.commit}
            result['rollback'] = {'release': str(previous), 'images': {'admin': before['admin']['image']},
                                  'servicesAdded': [], 'scope': 'ADMIN_ONLY'}
            need(all(result[name] == manifest[name] for name in ORIGIN_MARKERS), 'ORIGIN_MARKER_CHANGED')
            write_json(target / 'release-manifest.json', result)
            d.point_current(target, args.run_id)
            return {'status': 'ADMIN_ONLY_PUBLISHED', 'commit': args.commit,
                    'projectionSha256': expected['projectionSha256'], 'servicesUpdated': ['admin']}
        except Exception as error:
            code = str(error) if re.fullmatch(r'ADMIN_PENDING_[A-Z_]+', str(error)) else 'ADMIN_PENDING_UNAVAILABLE'
            recovery = {'attempted': changed, 'status': 'NOT_REQUIRED' if not changed else 'UNKNOWN'}
            if changed:
                try:
                    d.rollback_service(previous, target, 'admin', before)
                    if (d.BASE / 'current').resolve() != previous:
                        d.point_current(previous, args.run_id + '-admin-restore')
                    observed = d.service_state(previous, 'admin', include_container_id=True, include_environment_hash=True)
                    recovery['status'] = ('RESTORED' if observed['image'] == before['admin']['image']
                        and observed['reference'] == before['admin']['reference']
                        and (d.BASE / 'current').resolve() == previous else 'FAILED')
                except Exception:
                    recovery['status'] = 'FAILED'
            observed = {'currentCommit': None, 'adminImage': None, 'preservedServicesUnchanged': None}
            try:
                current = (d.BASE / 'current').resolve()
                observed['currentCommit'] = read_json(current / 'release-manifest.json')['commit']
                state = snapshot(d, current)
                observed['adminImage'] = state['admin']['image']
                observed['preservedServicesUnchanged'] = all(
                    state[name] == before[name] for name in before if name != 'admin')
            except Exception:
                pass
            failure = {'status': 'ADMIN_ONLY_RELEASE_FAILED', 'code': code, 'phase': phase,
                'commit': args.commit, 'release': str(target), 'adminRecovery': recovery, 'observed': observed,
                'receiptPersisted': False}
            try:
                failure['receiptPersisted'] = True
                write_json(target / 'admin-release-failure.json', failure)
            except Exception:
                failure['receiptPersisted'] = False
            d._adminFailureReceipt = failure
            raise RuntimeError(code) from None


def readback(d, commit):
    need(re.fullmatch(r'[a-f0-9]{40}', commit or ''), 'READBACK_SELECTION_CHANGED')
    current = (d.BASE / 'current').resolve()
    need(current.parent == d.BASE / 'releases', 'BASELINE_PATH_CHANGED')
    manifest = read_json(current / 'release-manifest.json')
    ledger = manifest.get('adminPublication', {})
    need(manifest.get('commit') == ledger.get('commit') == commit
         and ledger.get('scope') == 'ADMIN_ONLY_PENDING_ONLINE_SUCCESSOR'
         and manifest.get('servicesUpdated') == ['admin'] and manifest.get('migrationApplied') is False
         and manifest.get('newMigrations') == [] and ledger.get('onlinePublished') is False
         and ledger.get('componentBaselines') == {'api': BASELINE}, 'READBACK_CHANGED')
    previous = Path(manifest['previousRelease'])
    old_raw = private_bytes(previous / 'release-manifest.json')
    old = json.loads(old_raw)
    need(previous.parent == d.BASE / 'releases' and old['commit'] == BASELINE
         and digest(old_raw) == BASELINE_MANIFEST_SHA256 == ledger['inheritedManifestSha256']
         and all(manifest[name] == old[name] for name in ORIGIN_MARKERS), 'ORIGIN_MARKER_CHANGED')
    proof = read_json(current / 'admin-build-proof.json')
    projection = ledger['projection']
    need(fingerprint(proof) == ledger['buildProofSha256'] and proof['commit'] == commit
         and proof['sourceTree'] == projection.get('candidateTree') == manifest.get('sourceTree')
         and projection.get('candidateCommit') == commit
         and projection.get('scope') == 'ADMIN_PENDING_ONLINE_BUILD_PROJECTION'
         and projection.get('projectionSha256') == fingerprint({k:v for k,v in projection.items() if k != 'projectionSha256'})
         and set(projection.get('runtimeFiles', {})) == set(projection_module().RUNTIME_FILES)
         and proof['projection'] == projection, 'BUILD_PROOF_CHANGED')
    image = json.loads(d.run('docker', 'image', 'inspect', proof['image']['reference']))[0]
    labels = image['Config']['Labels']
    need(image.get('Id') == proof['image']['imageId'] and image.get('Architecture') == 'amd64'
         and labels.get('org.opencontainers.image.revision') == commit
         and labels.get('id-business-v2.source-tree') == manifest['sourceTree']
         and labels.get('id-business-v2.admin-pending-projection-sha256') == projection['projectionSha256'],
         'IMAGE_PROVENANCE_CHANGED')
    states = snapshot(d, current)
    for name, preserved in ledger['preservedServices'].items():
        need(name != 'admin' and preserved['before'] == preserved['after'] == states[name],
             'PRESERVED_SERVICE_CHANGED')
    need(set(ledger['preservedServices']) == set(d.ALL_SERVICES) - {'admin'}
         and states['admin']['image'] == proof['image']['imageId']
         and states['admin']['reference'] == proof['image']['reference'], 'RUNNING_IMAGE_CHANGED')
    environment = private_bytes(current / '.env.aws.production')
    need(digest(environment) == ledger['environmentSha256']
         and environment == private_bytes(previous / '.env.aws.production'), 'ENVIRONMENT_CHANGED')
    for name, row in ledger['projection']['runtimeFiles'].items():
        need(digest((current / name).read_bytes()) == row['sha256']
             and (current / name).read_bytes() == (previous / name).read_bytes(), 'RUNTIME_CONFIGURATION_CHANGED')
    need((current / 'deploy/caddy/Caddyfile.aws').read_bytes()
         == (previous / 'deploy/caddy/Caddyfile.aws').read_bytes(), 'EDGE_CONFIGURATION_CHANGED')
    need(volume_state(d, current, manifest) == ledger['volumeIdentitySha256'], 'VOLUME_CHANGED')
    public = d.environment_values(current / '.env.aws.production')['APP_PUBLIC_URL'].rstrip('/')
    with d.urllib.request.urlopen(public + '/', timeout=20) as response:
        need(response.status == 200 and ('v2-' + commit).encode() in response.read(4 * 1024 * 1024),
             'PUBLIC_ADMIN_VERSION_CHANGED')
    return {'status': 'ADMIN_ONLY_READBACK_VERIFIED', 'commit': commit,
            'apiComponentBaseline': BASELINE, 'servicesUpdated': ['admin'],
            'preservedServiceCount': len(ledger['preservedServices']), 'onlinePublished': False,
            'projectionSha256': ledger['projection']['projectionSha256']}


def cli(d=None):
    d = controller_module() if d is None else d
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=('prepare', 'proof', 'release', 'readback'))
    for name in ('commit', 'source-tree', 'repository', 'expected-current', 'run-id', 'run-attempt', 'ci-run-id', 'build-proof'):
        parser.add_argument('--' + name)
    args = parser.parse_args()
    if args.operation == 'readback':
        need(args.commit is not None and all(value is None for key, value in vars(args).items()
            if key not in ('operation', 'commit')), 'SCOPE_CONFLICT')
        print(json.dumps(readback(d, args.commit)))
        return 0
    if args.operation in ('prepare', 'proof'):
        need(all(value is None for key, value in vars(args).items() if key != 'operation'), 'SCOPE_CONFLICT')
        result = prepare_build(d) if args.operation == 'prepare' else image_proof(d)
        print(json.dumps({'status': 'ADMIN_BUILD_PREPARED' if args.operation == 'prepare' else 'ADMIN_BUILD_PROVEN',
                          'proofSha256': fingerprint(result)}))
        return 0
    need(all(value is not None for value in vars(args).values())
         and len(args.build_proof) < 49152, 'SCOPE_CONFLICT')
    raw = base64.b64decode(args.build_proof, validate=True)
    need(len(raw) < 65536, 'SCOPE_CONFLICT')
    try:
        result = publish(d, args, json.loads(raw))
    except Exception:
        failure = getattr(d, '_adminFailureReceipt', None)
        if isinstance(failure, dict):
            print(json.dumps(failure))
            return 1
        raise
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(cli())
    except Exception as error:
        code = str(error)
        if not re.fullmatch(r'ADMIN_PENDING_[A-Z_]+', code):
            code = 'ADMIN_PENDING_UNAVAILABLE'
        print(json.dumps({'status': 'ADMIN_ONLY_RELEASE_FAILED', 'code': code}))
        raise SystemExit(1) from None
