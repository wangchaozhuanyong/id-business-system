"""Separate governed ONLINE lifecycle after one byte-sealed ordinary publication.

The component authority is absent by default. Importing this file does nothing;
every operational entry authenticates it before loading a controller or doing I/O.
No migration executor or GRANT synchronizer belongs to this lifecycle.
"""

import base64
import argparse
import copy
from contextlib import nullcontext
import fcntl
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import time
import zlib
from types import FunctionType, ModuleType, SimpleNamespace


def load(filename):
    path = Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location('online_component_' + filename.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


c = load('online-recharge-component-consumer.py')
# A real predecessor seal alone is insufficient while lifecycle review is open.
RUNTIME_ADAPTER_READY = False
SCOPE = 'ONLINE_RECHARGE'
KIND = c.KIND
PREFIX = 'online-recharge-component'
CONTEXT = '.deploy/production-release/' + PREFIX + '-build-context'
PROJECTION = '.deploy/production-release/' + PREFIX + '-build-projection.json'
PROOF = '.deploy/production-release/' + PREFIX + '-build-proof.json'
PREFLIGHT = '.deploy/production-release/' + PREFIX + '-preflight.json'
LABEL = 'id-business-v2.online-component-source-sha256'
UPDATED = ('api', 'admin', 'online-recharge')
IMAGES = (*UPDATED, 'migrate')
SERVICES = (*c.SERVICES, 'online-recharge')
PRESERVED = c.PRESERVED
HELPERS = ('online-recharge-component-consumer.py', 'online-recharge-component-runtime.py',
           'online-recharge-component-readonly.py', 'online-recharge-scope.py')


def need(value, code):
    c.need(value, code)


def authority():
    result = c.sealed_authority()
    need(RUNTIME_ADAPTER_READY is True, 'RUNTIME_ADAPTER_NOT_READY')
    return result


def modules(d=None):
    a = authority()
    core = c.load_core(a['coreSha256'])
    d, admin, workspace, _projection = core.modules(d)
    online = load('online-recharge-scope.py')
    return d, core, admin, workspace, online


def producer(commit, tree, run, attempt):
    a = authority()
    return c.load_core(a['coreSha256']).producer(commit, tree, run, attempt)


def native_path(d):
    a = authority()
    return d.BASE / '.staging' / ('online-component-origin-' + a['invocationBytesSha256']) / 'invocation.json'


def predecessor_records(d, core, directory):
    authority()
    old_prefix = core.PREFIX
    return (core.private_bytes(native_path(d), cap=128 * 1024),
        core.private_bytes(directory / 'release-manifest.json'),
        core.private_bytes(directory / (old_prefix + '-build-proof.json')),
        core.private_bytes(directory / (old_prefix + '-preservation.json')))


def original_controller(d, core, directory):
    """Execute the exact archived producer helpers in their original directory."""
    a = authority(); p = a['producer']
    raw = d.registration_download(p['commit'])
    files = d.registration_archive(raw, p['commit'])
    need(core.projection_module().source_tree(files) == p['sourceTree'], 'ORDINARY_SOURCE_TREE_CHANGED')
    for name in core.HELPERS:
        relative = 'scripts/production-release/' + name
        path = directory / relative
        need(path.parent.resolve() == path.parent and not path.is_symlink() and path.is_file()
             and relative in files and path.read_bytes() == files[relative][0]
             and ('100755' if path.stat().st_mode & 0o111 else '100644') == files[relative][1],
             'ORDINARY_HELPER_CHANGED')
    name = 'scripts/production-release/unpublished-component-successor.py'
    need(c.digest(files[name][0]) == a['coreSha256'], 'ORDINARY_HELPER_CHANGED')
    original = ModuleType('original_online_component_predecessor')
    original.__file__ = str(directory / name)
    exec(compile(files[name][0], original.__file__, 'exec', dont_inherit=True), original.__dict__)
    return original, files, c.digest(raw)


def baseline(d, expected):
    a = authority()
    need(expected == a['producer']['commit'], 'PREDECESSOR_CHANGED')
    d, core, admin, workspace, online = modules(d)
    previous = (d.BASE / 'current').resolve()
    need(previous.parent == d.BASE / 'releases', 'CURRENT_PATH_CHANGED')
    records = predecessor_records(d, core, previous)
    authenticated = c.authenticate_component_records(*records)
    original, files, archive_sha = original_controller(d, core, previous)
    need(original.readback(None, expected) == authenticated['receipt'], 'ORDINARY_LIVE_READBACK_CHANGED')
    manifest, proof, state = (authenticated[n] for n in ('manifest', 'proof', 'preservation'))
    ledger = manifest['apiComponentPublication']
    need(ledger['sourceArchiveSha256'] == archive_sha
         and ledger['sourceFilesSha256'] == c.fingerprint(core.projection_module().inventory(files)),
         'ORDINARY_ARCHIVE_CHANGED')
    states = workspace.snapshot(d, previous)
    need(set(states) == set(c.SERVICES) and states == state['after']
         and all(state['before'][n] == states[n] for n in PRESERVED), 'ORDINARY_SERVICES_CHANGED')
    need(not d.compose(previous, 'ps', '-q', '--all', 'online-recharge'), 'ENGINE_ALREADY_PRESENT')
    volume = workspace.workspace_volume(d, previous, attached=True)
    need(volume == state['workspaceVolumeAfter'], 'WORKSPACE_VOLUME_CHANGED')
    guards = workspace.jobs_idle(d, previous)
    workspace.workspace_idle(d, previous, legacy=False)
    workspace.workspace_audit_protection(d, previous)
    workspace.workspace_private_inspect(d, previous, states['api']['reference'], volume['name'])
    online.verify_permission_seed(d, previous)
    online.require_fresh_resources(d, previous)
    database = c.verify_applied_database(d, online, workspace, previous,
        predecessor_records=records, migration_plan=[], source_candidate=False)
    verify_online_grants(d, online, previous)
    backup = backup_cas(d, core, workspace, previous, manifest, states, files)
    need((d.BASE / 'current').resolve() == previous
         and core.private_bytes(previous / 'release-manifest.json') == records[1]
         and workspace.snapshot(d, previous) == states, 'BASELINE_MOVED')
    return previous, manifest, {'version': 1, 'kind': KIND + '_BASELINE',
        'ordinaryProducer': copy.deepcopy(a['producer']), 'ordinaryAuthoritySha256': c.fingerprint(a),
        'currentRelease': str(previous), 'manifestBytesSha256': c.digest(records[1]),
        'ordinaryArchiveSha256': archive_sha, 'ordinarySourceFilesSha256': ledger['sourceFilesSha256'],
        'ordinaryProjectionSha256': c.fingerprint(proof['projection']),
        'ordinaryOutputFilesSha256': proof['projection']['outputFilesSha256'],
        'environmentFileSha256': c.digest(core.private_bytes(previous / '.env.aws.production')),
        'services': states, 'workspaceVolume': volume, 'guards': guards,
        'configurationModels': {n: core.configuration_model(d, states[n]) for n in ('api', 'admin')},
        'databaseGrants': copy.deepcopy(state['migration']['grantProtection']),
        'migrationState': copy.deepcopy(authenticated['receipt']['migration']),
        'appliedDatabase': database, 'backupInstallation': backup,
        'originMarkersSha256': c.fingerprint({n: manifest[n] for n in admin.ORIGIN_MARKERS})}


def verify_online_grants(d, online, directory):
    authority()
    names = ','.join("'" + name + "'" for name in online.TABLES)
    query = """SELECT JSON_OBJECT('rows',(SELECT JSON_ARRAYAGG(JSON_OBJECT(
        'table',TABLE_NAME,'privilege',PRIVILEGE_TYPE,'grantable',IS_GRANTABLE))
        FROM information_schema.TABLE_PRIVILEGES WHERE TABLE_SCHEMA=DATABASE()
        AND GRANTEE=CONCAT(CHAR(39),'id_business_app',CHAR(39),'@',CHAR(39),'%',CHAR(39))
        AND TABLE_NAME IN (__NAMES__)))""".replace('__NAMES__', names)
    value = online.database_read(d, directory, query)
    expected = [{'table': table, 'privilege': privilege, 'grantable': 'NO'}
        for table in online.TABLES for privilege in ('INSERT', 'SELECT', 'UPDATE',
            *(('DELETE',) if table in ('online_recharge_bills', 'online_recharge_cards', 'online_recharge_proxies') else ()))]
    need(type(value) is dict and set(value) == {'rows'} and type(value['rows']) is list
         and all(type(row) is dict and set(row) == {'table', 'privilege', 'grantable'} for row in value['rows'])
         and sorted(value['rows'], key=c.fingerprint) == sorted(expected, key=c.fingerprint), 'ONLINE_GRANTS_MISSING')
    return {'status': 'EXISTING_ONLINE_GRANTS_READONLY_VERIFIED', 'sha256': c.fingerprint(expected), 'mutationPerformed': False}


def backup_cas(d, core, workspace, previous, manifest, states, ordinary_files, *, pointer_target=None):
    """Verify the installed namespace without installing, deleting or restarting."""
    a = authority()
    need(os.getuid() == os.geteuid() == 0, 'BACKUP_ROOT_REQUIRED')
    names = ('backup-aws-mysql.sh', 'backup-retention-protection.py')
    scripts = {name: ordinary_files['scripts/' + name][0] for name in names}
    need(c.digest(scripts[names[0]]) == core.BACKUP_SCRIPT_SHA256, 'BACKUP_SCRIPT_CHANGED')
    pins = {name: c.digest(raw) for name, raw in scripts.items()}
    namespace = c.fingerprint(pins)
    destination = d.BASE / 'maintenance' / ('mysql-backup-' + namespace[:16])
    entry = destination / names[0]
    dropin = ('[Service]\nExecStart=\nExecStart=' + str(entry) + '\n').encode()
    old = d.BASE / 'maintenance' / core.BACKUP_OLD_NAMESPACE
    held = core.BackupMaintenanceAuthority(); lock_fd = None
    control = lambda *args: core.backup_native(d, ['/usr/bin/systemctl', *args])
    try:
        base_fd = held.directory(d.BASE)
        pointer = os.stat('current', dir_fd=base_fd, follow_symlinks=False)
        need(stat.S_ISLNK(pointer.st_mode) and pointer.st_uid == 0 and pointer.st_nlink == 1,
             'BACKUP_CURRENT_CHANGED')
        text = os.readlink('current', dir_fd=base_fd)
        pointer_target = previous if pointer_target is None else pointer_target
        need(pointer_target.parent == d.BASE / 'releases'
             and text in (str(pointer_target), 'releases/' + pointer_target.name), 'BACKUP_CURRENT_CHANGED')
        raw, _ = held.read(previous / 'release-manifest.json', mode=0o600)
        need(c.digest(raw) == a['manifestBytesSha256'], 'BACKUP_MANIFEST_CHANGED')
        env, _ = held.read(previous / '.env.aws.production', mode=0o600)
        limits = core.backup_limits(env)
        actual_dropin, _ = held.read(core.BACKUP_DROPIN, mode=0o600)
        need(actual_dropin == dropin, 'BACKUP_DROPIN_CHANGED')
        for name in names:
            raw, _ = held.read(destination / name, mode=0o700 if name.endswith('.sh') else 0o600)
            need(raw == scripts[name], 'BACKUP_NAMESPACE_CHANGED')
        need(set(os.listdir(held.directory(destination))) == set(names), 'BACKUP_NAMESPACE_CHANGED')
        raw, _ = held.read(old / names[0], mode=0o700)
        need(c.digest(raw) == core.BACKUP_SCRIPT_SHA256, 'BACKUP_OLD_SOURCE_CHANGED')
        raw, _ = held.read(old / names[1], mode=0o600)
        need(c.digest(raw) == core.BACKUP_OLD_HELPER_SHA256, 'BACKUP_OLD_SOURCE_CHANGED')
        parent = held.directory(d.BASE / 'backups/mysql')
        visible = os.stat('.backup.lock', dir_fd=parent, follow_symlinks=False)
        need(stat.S_ISREG(visible.st_mode) and visible.st_uid == 0 and visible.st_nlink == 1
             and stat.S_IMODE(visible.st_mode) == 0o600, 'BACKUP_LOCK_CHANGED')
        lock_fd = os.open('.backup.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
        need(core.BackupMaintenanceAuthority.identity(visible) == core.BackupMaintenanceAuthority.identity(os.fstat(lock_fd)),
             'BACKUP_LOCK_CHANGED')
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        timer = control('show', core.BACKUP_TIMER, '--property=ActiveState', '--value')
        need(timer in ('active', 'inactive'), 'BACKUP_TIMER_CHANGED')
        def guard():
            held.check()
            need(core.BackupMaintenanceAuthority.identity(os.stat('current', dir_fd=base_fd, follow_symlinks=False))
                 == core.BackupMaintenanceAuthority.identity(pointer)
                 and os.readlink('current', dir_fd=base_fd) == text, 'BACKUP_CURRENT_CHANGED')
            need(workspace.snapshot(d, previous) == states, 'BACKUP_SERVICES_CHANGED')
            need(control('show', core.BACKUP_SERVICE, '--property=ActiveState', '--value') in ('inactive', 'failed')
                 and control('show', core.BACKUP_TIMER, '--property=ActiveState', '--value') == timer
                 and control('show', core.BACKUP_SERVICE, '--property=DropInPaths', '--value') == str(core.BACKUP_DROPIN)
                 and core.backup_entry_matches(control('show', core.BACKUP_SERVICE, '--property=ExecStart', '--value'), entry),
                 'BACKUP_UNIT_CHANGED')
            need(core.BackupMaintenanceAuthority.identity(os.fstat(lock_fd))
                 == core.BackupMaintenanceAuthority.identity(os.stat('.backup.lock', dir_fd=parent, follow_symlinks=False)),
                 'BACKUP_LOCK_CHANGED')
        guard()
        # An installed-source CAS is enough here. The fresh backup runs only
        # after this held lock is released, followed by a second identical CAS.
        result = {'version': 1, 'kind': KIND + '_BACKUP_INSTALLED_CAS', 'scriptPins': pins,
            'namespaceSha256': namespace, 'entry': str(entry), 'dropInSha256': c.digest(dropin),
            'timerState': timer, 'limits': list(limits), 'manifestBytesSha256': c.digest(held.read(previous / 'release-manifest.json', mode=0o600)[0]),
            'environmentFileSha256': c.digest(env), 'servicesSha256': c.fingerprint(states),
            'installationModified': False, 'backupDeletedByCas': False}
        guard()
        return result
    finally:
        if lock_fd is not None:
            fcntl.flock(lock_fd, fcntl.LOCK_UN); os.close(lock_fd)
        held.close()


def source(d, p, evidence):
    a = authority()
    need(evidence['ordinaryProducer'] == a['producer']
         and evidence['ordinaryAuthoritySha256'] == c.fingerprint(a), 'SOURCE_ORIGIN_CHANGED')
    core = c.load_core(a['coreSha256']); projection = core.projection_module()
    candidate_raw = d.registration_download(p['commit'])
    candidate = d.registration_archive(candidate_raw, p['commit'])
    need(projection.source_tree(candidate) == p['sourceTree'], 'SOURCE_TREE_CHANGED')
    for name in (*core.HELPERS, *HELPERS):
        relative = 'scripts/production-release/' + name
        path = Path(__file__).with_name(name)
        need(relative in candidate and path.is_file() and not path.is_symlink()
             and candidate[relative] == (path.read_bytes(), '100755' if path.stat().st_mode & 0o111 else '100644'),
             'EXECUTOR_SOURCE_CHANGED')
    ordinary_raw = d.registration_download(a['producer']['commit'])
    ordinary = d.registration_archive(ordinary_raw, a['producer']['commit'])
    need(c.digest(ordinary_raw) == evidence['ordinaryArchiveSha256']
         and c.fingerprint(projection.inventory(ordinary)) == evidence['ordinarySourceFilesSha256'],
         'ORDINARY_ARCHIVE_CHANGED')
    base, fixed_online = projection.source_references(d)
    output, preparation = c.prepare_source_projection(candidate, ordinary, base, fixed_online,
        commit=p['commit'], tree=p['sourceTree'], ordinary_producer=a['producer'])
    need(preparation['ordinaryProjectionSha256'] == evidence['ordinaryProjectionSha256'] == a['projectionSha256']
         and preparation['ordinaryOutputFilesSha256'] == evidence['ordinaryOutputFilesSha256'],
         'ORDINARY_BUILD_OUTPUT_CHANGED')
    record = {**preparation, 'kind': KIND + '_SOURCE', 'contextPath': CONTEXT,
        'candidateProducer': copy.deepcopy(p), 'ordinaryAuthoritySha256': c.fingerprint(a),
        'candidateArchiveSha256': c.digest(candidate_raw), 'releaseAuthority': False}
    return candidate, output, record


def validate_preflight(core, transport, p, expected):
    a = authority()
    need(type(transport) is dict and set(transport) == {'version', 'kind', 'producer', 'expectedCurrent',
        'commandId', 'instanceId', 'invocationBytesSha256', 'invocationRawBase64', 'serverReceipt'}
        and type(transport['version']) is int and transport['version'] == 1
        and transport['kind'] == KIND + '_PREFLIGHT_TRANSPORT'
        and transport['producer'] == p and transport['expectedCurrent'] == expected == a['producer']['commit'],
        'PREFLIGHT_TRANSPORT_CHANGED')
    raw = base64.b64decode(transport['invocationRawBase64'], validate=True)
    need(c.digest(raw) == transport['invocationBytesSha256'], 'PREFLIGHT_NATIVE_CHANGED')
    need(transport['instanceId'] == a['instanceId'], 'PREFLIGHT_INSTANCE_CHANGED')
    _invocation, receipt = validate_component_invocation(core, raw, transport['commandId'], transport['instanceId'])
    need(receipt == transport['serverReceipt'] and receipt.get('kind') == KIND
         and receipt.get('producer') == p and receipt.get('scope') == SCOPE
         and receipt.get('status') == 'ONLINE_RECHARGE_BASELINE_VERIFIED'
         and receipt.get('migrationPerformed') is False and receipt.get('databaseGrantsChanged') is False
         and receipt.get('executionMigrationPlan') == [] and receipt.get('onlinePublished') is False
         and type(receipt.get('businessActions')) is int and receipt['businessActions'] == 0
         and receipt['baseline']['ordinaryAuthoritySha256'] == c.fingerprint(a), 'PREFLIGHT_RECEIPT_CHANGED')
    return receipt


def preflight(d, p, expected):
    authority()
    d, core, _admin, workspace, online = modules(d)
    previous, _manifest, evidence = baseline(d, expected)
    _files, _output, record = source(d, p, evidence)
    # The ordinary source directory retains both SQL files even though its
    # migration image excludes ONLINE; no file increment authorizes execution.
    c.validate_source_files(_files)
    need(d.shutil.disk_usage(d.BASE).free > 6 * 1024**3, 'DISK_LOW_BEFORE_PULL')
    return {'version': 1, 'scope': SCOPE, 'kind': KIND, 'status': 'ONLINE_RECHARGE_BASELINE_VERIFIED',
        'producer': p, 'baseline': evidence, 'sourceProjectionSha256': c.fingerprint(record),
        'applicationInputSha256': c.APPLICATION_SHA256, 'onlineInputSha256': c.ONLINE_SHA256,
        'onlinePublished': False, 'migrationPerformed': False, 'databaseGrantsChanged': False,
        'executionMigrationPlan': [], 'businessActions': 0}


def prepare(d, p, transport):
    authority()
    need(os.environ.get('GITHUB_ACTIONS') == 'true', 'BUILD_RUNNER_REQUIRED')
    core = c.load_core(authority()['coreSha256']); receipt = validate_preflight(core, transport, p, transport['expectedCurrent'])
    _files, output, record = source(d, p, receipt['baseline'])
    need(c.fingerprint(record) == receipt['sourceProjectionSha256'], 'BUILD_SOURCE_CHANGED')
    root = Path.cwd().resolve(); context = root / CONTEXT
    need(not context.exists(), 'BUILD_CONTEXT_EXISTS')
    d.write_registration_files(context, output)
    core.write_private(root / PROJECTION, record)
    core.write_private(root / PREFLIGHT, transport)
    return record


def verify_context(core, output, record):
    authority()
    root = Path.cwd().resolve(); context = root / CONTEXT
    need(context.is_dir() and context.resolve() == context and not context.is_symlink()
         and all(not parent.is_symlink() for parent in context.parents), 'BUILD_CONTEXT_CHANGED')
    actual = {}
    for path in context.rglob('*'):
        need(not path.is_symlink(), 'BUILD_CONTEXT_CHANGED')
        if path.is_file():
            actual[path.relative_to(context).as_posix()] = (path.read_bytes(), '100755' if path.stat().st_mode & 0o111 else '100644')
        else:
            need(path.is_dir(), 'BUILD_CONTEXT_CHANGED')
    need(actual == output and c.fingerprint(core.projection_module().inventory(actual)) == record['outputFilesSha256'],
         'BUILD_CONTEXT_CHANGED')


def migration_content(d, online, files):
    rows = {('/app/' + name): c.digest(row[0]) for name, row in files.items()
            if name.startswith(c.MIGRATION_ROOT + '/') or name in (c.SCHEMA, online.SEED_FILE)}
    return online.content_summary(d, 'migrate', '\n'.join(sorted(sha + '  ' + name for name, sha in rows.items())))


def verify_image_identity(d, online, row, p, projection):
    authority()
    online.inspect_image(d, row, p['commit'], p['sourceTree'])
    metadata = json.loads(d.run('docker', 'image', 'inspect', row['reference'], timeout=10))[0]
    labels = metadata.get('Config', {}).get('Labels', {})
    need(metadata['Id'] == row['imageId'] and metadata.get('Architecture') == 'amd64'
         and labels.get('org.opencontainers.image.revision') == p['commit']
         and labels.get('id-business-v2.source-tree') == p['sourceTree']
         and labels.get(LABEL) == c.fingerprint(projection), 'IMAGE_PROVENANCE_CHANGED')


def verify_image(d, online, directory, output, p, proof, name):
    authority()
    row = proof['images'][name]
    verify_image_identity(d, online, row, p, proof['sourceProjection'])
    measured = online.content_summary(d, name, d.run('docker', 'run', '--rm', '--network', 'none', '--read-only',
        '--entrypoint', '/bin/sh', row['reference'], '-c', online.content_command(name)))
    need(measured == {key: row[key] for key in ('fileCount', 'sha256')}, 'IMAGE_CONTENT_CHANGED')
    expected = (online.engine_content(d, directory) if name == 'online-recharge' else
                migration_content(d, online, output) if name == 'migrate' else None)
    need(expected is None or measured == expected, 'IMAGE_SOURCE_CHANGED')


def validate_build(value, p, record, transport, quality_run, repository):
    authority()
    need(type(repository) is str and re.fullmatch('[0-9]{12}\\.dkr\\.ecr\\.ap-northeast-1\\.amazonaws\\.com/id-business-v2-release', repository)
         and type(quality_run) is str and re.fullmatch('[1-9][0-9]*', quality_run)
         and type(value) is dict and set(value) == {'version', 'scope', 'kind', 'producer', 'qualityRunId',
             'sourceProjection', 'preflightSha256', 'migrations', 'images'}
         and type(value['version']) is int and value['version'] == 1
         and value.get('kind') == KIND + '_BUILD_PROOF'
         and value.get('scope') == SCOPE and value.get('producer') == p
         and value.get('sourceProjection') == record
         and value.get('preflightSha256') == c.fingerprint(transport)
         and value.get('qualityRunId') == quality_run
         and value.get('migrations') == c.MIGRATIONS
         and type(value.get('images')) is dict and set(value['images']) == set(IMAGES), 'BUILD_PROOF_CHANGED')
    for name, row in value['images'].items():
        need(type(row) is dict and set(row) == {'reference', 'imageId', 'fileCount', 'sha256'}
             and row['reference'] == repository + ':' + p['commit'] + '-' + p['workflowRunId'] + '-'
                 + p['workflowRunAttempt'] + '-' + name
             and re.fullmatch('sha256:[a-f0-9]{64}', row['imageId'] or '')
             and type(row['fileCount']) is int and 0 < row['fileCount'] < 30000
             and re.fullmatch('[a-f0-9]{64}', row['sha256'] or ''), 'BUILD_IMAGE_CHANGED')
    return value


def build_proof(d, p, transport, quality_run, repository):
    authority()
    need(os.environ.get('GITHUB_ACTIONS') == 'true', 'BUILD_RUNNER_REQUIRED')
    d, core, _admin, _workspace, online = modules(d)
    receipt = validate_preflight(core, transport, p, transport['expectedCurrent'])
    _files, output, record = source(d, p, receipt['baseline'])
    need(core.closed_json(core.private_bytes(Path(PROJECTION).resolve())) == record,
         'BUILD_CONTEXT_CHANGED')
    verify_context(core, output, record)
    result = {'version': 1, 'scope': SCOPE, 'kind': KIND + '_BUILD_PROOF', 'producer': p,
        'qualityRunId': quality_run, 'sourceProjection': record, 'preflightSha256': c.fingerprint(transport),
        'migrations': dict(c.MIGRATIONS), 'images': {}}
    for name in IMAGES:
        ref = repository + ':' + p['commit'] + '-' + p['workflowRunId'] + '-' + p['workflowRunAttempt'] + '-' + name
        metadata = json.loads(d.run('docker', 'image', 'inspect', ref))[0]
        labels = metadata.get('Config', {}).get('Labels', {})
        need(metadata.get('Architecture') == 'amd64' and labels.get('org.opencontainers.image.revision') == p['commit']
             and labels.get('id-business-v2.source-tree') == p['sourceTree']
             and labels.get(LABEL) == c.fingerprint(record), 'BUILD_IMAGE_LABEL_CHANGED')
        content = online.content_summary(d, name, d.run('docker', 'run', '--rm', '--network', 'none', '--read-only',
            '--entrypoint', '/bin/sh', ref, '-c', online.content_command(name)))
        result['images'][name] = {'reference': ref, 'imageId': metadata['Id'], **content}
    validate_build(result, p, record, transport, quality_run, repository)
    for name in IMAGES:
        verify_image(d, online, Path(CONTEXT).resolve(), output, p, result, name)
    core.write_private(Path(PROOF).resolve(), result)
    return result


def preserve(d, core, workspace, online, previous, target, evidence, proof, *, pointer, all_services=False, engine=False):
    authority()
    need((d.BASE / 'current').resolve() == pointer
         and c.digest(core.private_bytes(previous / 'release-manifest.json')) == evidence['manifestBytesSha256'],
         'BASELINE_MOVED')
    original = core.private_bytes(previous / '.env.aws.production')
    need(c.digest(original) == evidence['environmentFileSha256'], 'ENVIRONMENT_CHANGED')
    online.verify_environment(d, previous, target, original)
    online.verify_compose(d, previous, target)
    online.verify_caddy_projection(d, previous, target)
    c.migration_source_check(d, workspace, previous, candidate=False)
    c.migration_source_check(d, workspace, target, candidate=True)
    need(d.migration_plan(previous, target) == [], 'MIGRATION_PLAN_NOT_EMPTY')
    # The target Compose already declares the engine before it exists. The
    # workspace snapshot auto-includes declared engines, so pre-engine CAS must
    # read the same seven actual services through the ordinary Compose context.
    states = online.snapshot(d, target, include_engine=True) if engine else workspace.snapshot(d, previous)
    need(set(states) == set(SERVICES if engine else c.SERVICES)
         and all(states[n] == evidence['services'][n] for n in (c.SERVICES if all_services else PRESERVED)),
         'PRESERVED_SERVICE_CHANGED')
    need(workspace.workspace_volume(d, target, attached=True) == evidence['workspaceVolume'], 'WORKSPACE_VOLUME_CHANGED')
    return states


def audit_barrier(d, workspace, online, previous, evidence, *, history_record=None):
    authority()
    admission = workspace.WorkspaceAuditBarrier(d, previous)
    identity = admission.api_identity
    need(all(identity[n] == evidence['services']['api'][n] for n in ('containerId', 'image', 'startedAtSha256')),
         'AUDIT_API_IDENTITY_CHANGED')
    plan = online._online_after_bit_audit_queries(d, workspace, previous, identity,
        **({'history_cutoff': history_record['historyCutoff']} if history_record else {}))
    need(workspace.workspace_audit_protection(d, previous) == plan['expectedTriggersSha256'], 'AUDIT_TRIGGERS_CHANGED')
    def check_api(deadline):
        remaining = min(5, deadline - time.monotonic())
        need(remaining > 0 and workspace.workspace_api_identity(d, previous, expected=identity, timeout=remaining) == identity,
             'AUDIT_API_IDENTITY_CHANGED')
    # Only fixed MySQL/API data are passed to the low-level transport. This is
    # not an AFTER_BIT bridge and carries no legacy Q/session/declaration seal.
    return online._online_after_bit_audit_transport(d, previous, {'services': evidence['services']}, workspace,
        identity, plan, {'kind': KIND, 'ordinaryProducer': evidence['ordinaryProducer'],
            'ordinaryAuthoritySha256': evidence['ordinaryAuthoritySha256']},
        history_record=history_record, first_api_check=check_api if history_record is None else None,
        receipt_kind=KIND + '_AUDIT_PROTECTION')


def wait_healthy(d, directory, name, deadline):
    authority()
    while time.monotonic() + 5 < deadline:
        state = d.service_state(directory, name, include_container_id=True)
        if state.get('status') == 'running' and state.get('health') == 'healthy':
            return state
        time.sleep(min(1, max(0, deadline - time.monotonic())))
    need(False, 'SERVICE_HEALTH_TIMEOUT')


class DeadlineController:
    """Bound every subprocess/readiness call inside the existing 210s fence."""
    def __init__(self, original, deadline):
        self.original, self.deadline = original, deadline
        self.subprocess = SimpleNamespace(run=self.subprocess_run)
        self.urllib = SimpleNamespace(request=SimpleNamespace(urlopen=self.urlopen))
        self.bound_helpers = {}
        names = ('current_job_database', 'assert_no_active_recharge', 'registration_runtime_state', 'rollback_service')
        functions = {name: getattr(original, name) for name in names}
        genuine = {name: fn for name, fn in functions.items() if type(fn) is FunctionType}
        if genuine:
            first = next(iter(genuine.values()))
            need(all(fn.__globals__ is first.__globals__ for fn in genuine.values()), 'FENCED_HELPER_CHANGED')
            namespace = {**first.__globals__, 'run': self.run, 'compose': self.compose,
                'service_state': self.service_state,
                'wait_healthy': lambda directory, service: wait_healthy(self, directory, service, self.deadline)}
            for name, fn in genuine.items():
                self.bound_helpers[name] = FunctionType(fn.__code__, namespace, fn.__name__, fn.__defaults__, fn.__closure__)
            namespace.update(self.bound_helpers)

    def __getattr__(self, name):
        # Archive downloads are prepared before the locks. Never silently start
        # an unbounded source transfer while the live audit fence is held.
        need(name not in ('registration_download', 'wait_healthy'), 'FENCED_UNBOUNDED_OPERATION')
        if name in self.bound_helpers: return self.bound_helpers[name]
        return getattr(self.original, name)

    def timeout(self, requested):
        remaining = self.deadline - time.monotonic() - 3
        need(remaining > 0 and type(requested) in (int, float) and requested > 0, 'FENCE_TIMEOUT')
        return min(requested, remaining)

    def run(self, *command, **kwargs):
        kwargs['timeout'] = self.timeout(kwargs.get('timeout', 30))
        result = self.original.run(*command, **kwargs)
        self.timeout(1)
        return result

    def compose(self, directory, *command, **kwargs):
        kwargs['timeout'] = self.timeout(kwargs.get('timeout', 30))
        result = self.original.compose(directory, *command, **kwargs)
        self.timeout(1)
        return result

    def subprocess_run(self, *args, **kwargs):
        kwargs['timeout'] = self.timeout(kwargs.get('timeout', 30))
        result = self.original.subprocess.run(*args, **kwargs)
        self.timeout(1)
        return result

    def urlopen(self, *args, **kwargs):
        kwargs['timeout'] = self.timeout(kwargs.get('timeout', 10))
        result = self.original.urllib.request.urlopen(*args, **kwargs)
        self.timeout(1)
        return result

    def service_state(self, directory, name, *, include_container_id=False, include_environment_hash=False):
        container = self.compose(directory, 'ps', '-q', name)
        need(type(container) is str and re.fullmatch('[a-f0-9]{64}', container), 'CONTAINER_IDENTITY_CHANGED')
        metadata = json.loads(self.run('docker', 'inspect', container))[0]
        need(metadata['Id'] == container, 'CONTAINER_IDENTITY_CHANGED')
        started = metadata['State'].get('StartedAt')
        env = metadata.get('Config', {}).get('Env')
        need(not include_container_id or (type(started) is str and 0 < len(started) <= 128), 'CONTAINER_START_CHANGED')
        need(not include_environment_hash or (type(env) is list and env and all(type(v) is str for v in env)),
             'CONTAINER_ENVIRONMENT_CHANGED')
        return {'image': metadata['Image'], 'reference': metadata['Config']['Image'],
            'status': metadata['State']['Status'], 'health': metadata['State'].get('Health', {}).get('Status'),
            **({'containerId': container, 'startedAtSha256': c.digest(started.encode())} if include_container_id else {}),
            **({'environmentSha256': self.original.historical_fingerprint(sorted(env))} if include_environment_hash else {})}


def switch(d, core, workspace, online, previous, target, evidence, proof, args, changed, *, gate_holder):
    authority()
    # Admin and all slow prechecks precede the original SQLite 150s fence.
    preserve(d, core, workspace, online, previous, target, evidence, proof, pointer=previous, all_services=True)
    workspace.jobs_idle(d, previous); online.require_fresh_resources(d, target)
    audit = audit_barrier(d, workspace, online, previous, evidence)
    gate = None
    try:
        changed.append('admin')
        d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'admin', timeout=120)
        d.wait_healthy(target, 'admin')
        workspace.jobs_idle(d, previous); online.require_fresh_resources(d, target)
        gate = workspace.workspace_prepare(d, previous, target, proof, args,
            {'workspaceVolume': evidence['workspaceVolume']}, legacy=False)
        gate_holder['gate'] = gate
        need(gate is not None and gate.record is not None, 'SQLITE_PROTECTION_REQUIRED')
        audit.__enter__()
        gate_holder['audit'] = audit
        d = DeadlineController(d, audit.pipe.deadline)
        gate_holder['controller'] = d
        gate.check_locked(); audit.before_stop()
        class StopController:
            def __getattr__(self, name):
                return getattr(d, name)
            def run(self, *command, **kwargs):
                if command[:2] == ('docker', 'stop'):
                    need(command == ('docker', 'stop', '--time', '30', evidence['services']['api']['containerId'])
                         and set(kwargs) == {'timeout'} and type(kwargs['timeout']) in (int, float)
                         and 0 < kwargs['timeout'] <= 45 and 'api' not in changed, 'STOP_DISPATCH_CHANGED')
                    changed.append('api')
                return d.run(*command, **kwargs)
        gate.d = StopController()
        try:
            gate.stop_previous()
        finally:
            gate.d = d
        audit.confirm_stopped(gate)
        d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'api', timeout=60)
        wait_healthy(d, target, 'api', audit.pipe.deadline)
        gate.check_marker(); audit.check()
        preserve(d, core, workspace, online, previous, target, evidence, proof, pointer=previous)
        # Keep the same READ fence through executor startup: no accepted queued,
        # notification or config-test job can race the empty-nine-table proof.
        online.require_fresh_resources(d, target)
        changed.append('online-recharge')
        d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'online-recharge', timeout=60)
        state = wait_healthy(d, target, 'online-recharge', audit.pipe.deadline)
        workspace.online_engine_idle(d, {'Id': state['containerId']})
        online.require_fresh_resources(d, target); audit.check()
        preserve(d, core, workspace, online, previous, target, evidence, proof, pointer=previous, engine=True)
        return gate, audit.receipt
    except Exception as error:
        if gate is None:
            gate_holder['gate'] = getattr(error, 'sqlite_gate', None)
        raise


def remove_added_engine(d, workspace, online, target, proof, evidence, *, held_audit=None):
    authority()
    workspace.jobs_idle(d, target)
    state = d.service_state(target, 'online-recharge', include_container_id=True, include_environment_hash=True)
    need(state['image'] == proof['images']['online-recharge']['imageId']
         and state['reference'] == proof['images']['online-recharge']['reference'], 'ENGINE_IDENTITY_CHANGED')
    metadata = json.loads(d.run('docker', 'inspect', state['containerId']))[0]
    api = d.service_state(target, 'api', include_container_id=True)
    need(metadata['Id'] == state['containerId'] and metadata['Image'] == state['image']
         and metadata.get('Config', {}).get('Labels', {}).get('com.docker.compose.service') == 'online-recharge'
         and metadata.get('HostConfig', {}).get('NetworkMode') == 'container:' + api['containerId'],
         'ENGINE_IDENTITY_CHANGED')
    image = json.loads(d.run('docker', 'image', 'inspect', state['reference']))[0]
    labels = image.get('Config', {}).get('Labels', {})
    rendered = online.rendered_configuration(d, target)['services']['online-recharge']
    env = dict(row.split('=', 1) for row in metadata.get('Config', {}).get('Env', []))
    need(image['Id'] == metadata['Image']
         and labels.get('org.opencontainers.image.revision') == proof['producer']['commit']
         and labels.get('id-business-v2.source-tree') == proof['producer']['sourceTree']
         and all(env.get(k) == str(v) for k, v in rendered.get('environment', {}).items()),
         'ENGINE_IDENTITY_CHANGED')
    # READ on all nine tables already blocks every accepted task/card write.
    # Taking a separate WRITE lock while our READ is held would deadlock.
    fence = nullcontext(held_audit) if held_audit is not None else workspace.OnlineSqlFence(d, target)
    with fence:
        if held_audit is not None:
            held_audit.check()
            need(isinstance(d, DeadlineController) and d.deadline == held_audit.pipe.deadline
                 and time.monotonic() + 65 < d.deadline, 'ENGINE_STOP_FENCE_TIMEOUT')
        workspace.online_engine_idle(d, metadata)
        online.require_fresh_resources(d, target)
        # Container-only removal; no volume flag, prune or other service action.
        d.run('docker', 'stop', '--time', '30', metadata['Id'], timeout=45)
        stopped = json.loads(d.run('docker', 'inspect', metadata['Id']))[0]
        need(stopped['Id'] == metadata['Id'] and stopped['Image'] == metadata['Image']
             and stopped.get('State', {}).get('Running') is False
             and stopped.get('State', {}).get('Pid') == 0, 'ENGINE_NOT_STOPPED')
        d.run('docker', 'rm', metadata['Id'], timeout=30)
        need(not d.compose(target, 'ps', '-q', '--all', 'online-recharge'), 'ENGINE_NOT_REMOVED')
        if held_audit is not None:
            held_audit.check()


def current_backup_cas(d, core, workspace, previous, target, evidence, ordinary_files, states, *, pointer=None):
    """The manifest/pointer is held at the ordinary origin until publication."""
    manifest = core.closed_json(core.private_bytes(previous / 'release-manifest.json'))
    # Updated API/Admin are permitted only as their exact current snapshots;
    # five preserved services and the previous pointer are checked separately.
    result = backup_cas(d, core, workspace, previous, manifest, states, ordinary_files,
                        pointer_target=previous if pointer is None else pointer)
    need(all(states[n] == evidence['services'][n] for n in PRESERVED), 'BACKUP_PRESERVED_SERVICE_CHANGED')
    return result


def verify_fresh_backup(d, core, current, manifest, ledger, state):
    authority()
    raw = core.private_bytes(current / 'backup-verification.json')
    receipt = core.backup_guard(core.closed_json(raw))
    need(c.digest(raw) == ledger['backupReceiptBytesSha256']
         and c.fingerprint(receipt) == ledger['backupReceiptSha256']
         and receipt == state['freshBackup'] and receipt['name'] == manifest['backupBeforeRelease'],
         'BACKUP_RECEIPT_CHANGED')
    held = core.BackupMaintenanceAuthority(); descriptor = None
    try:
        parent = held.directory(d.BASE / 'backups/mysql')
        visible = os.stat(receipt['name'], dir_fd=parent, follow_symlinks=False)
        need(stat.S_ISREG(visible.st_mode) and visible.st_uid == 0 and visible.st_nlink == 1
             and stat.S_IMODE(visible.st_mode) == 0o600 and visible.st_size == receipt['size'], 'BACKUP_FILE_CHANGED')
        descriptor = os.open(receipt['name'], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
        identity = core.BackupMaintenanceAuthority.identity(visible)
        need(core.BackupMaintenanceAuthority.identity(os.fstat(descriptor)) == identity, 'BACKUP_FILE_CHANGED')
        sha = hashlib.sha256()
        while True:
            if isinstance(d, DeadlineController): d.timeout(1)
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk: break
            sha.update(chunk)
        need(sha.hexdigest() == receipt['sha256'], 'BACKUP_FILE_CHANGED')
        values = d.environment_values(current / '.env.aws.production')
        bucket = values['MYSQL_BACKUP_S3_BUCKET']; region = values.get('MYSQL_BACKUP_S3_REGION') or 'ap-northeast-1'
        key = values.get('MYSQL_BACKUP_S3_PREFIX', 'mysql/daily').rstrip('/') + '/' + receipt['name']
        head = json.loads(d.run('aws', 's3api', 'head-object', '--bucket', bucket, '--key', key,
            '--checksum-mode', 'ENABLED', '--region', region, timeout=20))
        verify_backup_head(receipt, sha.digest(), head)
        held.check()
        need(core.BackupMaintenanceAuthority.identity(os.fstat(descriptor)) == identity
             == core.BackupMaintenanceAuthority.identity(os.stat(receipt['name'], dir_fd=parent, follow_symlinks=False)),
             'BACKUP_FILE_CHANGED')
        return {'backupReceiptBytesSha256': c.digest(raw), 'localBytesVerified': True,
                's3ChecksumAndEncryptionVerified': True}
    finally:
        if descriptor is not None: os.close(descriptor)
        held.close()


def verify_backup_head(receipt, digest, head):
    authority()
    need(type(digest) is bytes and len(digest) == 32 and digest.hex() == receipt['sha256']
         and type(head) is dict and type(head.get('ContentLength')) is int and head['ContentLength'] == receipt['size']
         and head.get('ChecksumSHA256') == base64.b64encode(digest).decode()
         and head.get('ServerSideEncryption') == 'AES256', 'S3_BACKUP_CHANGED')


def verify_live_sqlite(d, core, workspace, record_directory, current_directory, image_reference, digest):
    authority()
    value = core.closed_json(core.private_bytes(record_directory / workspace.WORKSPACE_SQLITE_RECEIPT))
    need(c.fingerprint(value) == digest, 'SQLITE_LIVE_RECORD_CHANGED')
    summary = value['sourceSummary']
    need(set(summary) == {'schemaSha256', 'logicalSha256', 'tableCounts', 'taskCounts'}
         and workspace.workspace_volume(d, current_directory, attached=True) == value['volume'], 'SQLITE_LIVE_VOLUME_CHANGED')
    workspace.workspace_idle(d, current_directory, legacy=False)
    actual = workspace.workspace_private_inspect(d, current_directory, image_reference,
        value['volume']['name'], expected=summary['logicalSha256'], timeout=30)
    need(all(actual[key] == summary[key] for key in summary), 'SQLITE_LIVE_DATA_CHANGED')
    workspace.workspace_idle(d, current_directory, legacy=False)
    need(workspace.workspace_volume(d, current_directory, attached=True) == value['volume'], 'SQLITE_LIVE_VOLUME_CHANGED')
    return {'liveSchemaAndLogicalDataVerified': True, 'sqliteProtectionSha256': digest}


def audit_readback(d, workspace, online, directory, evidence, value, sqlite_sha):
    authority()
    fields = {'version', 'kind', 'basis', 'sourceApiIdentity', 'mysqlIdentitySha256',
        'initialQuerySha256', 'querySha256', 'historyQuerySha256', 'triggerDefinitionsSha256',
        'connectionIdSha256', 'before', 'after', 'oldApiStop', 'sqliteProtectionSha256'}
    need(type(value) is dict and set(value) == fields and type(value['version']) is int and value['version'] == 1
         and value['kind'] == KIND + '_AUDIT_PROTECTION'
         and value['basis'] == {'kind': KIND, 'ordinaryProducer': evidence['ordinaryProducer'],
             'ordinaryAuthoritySha256': evidence['ordinaryAuthoritySha256']}
         and value['before'] == value['after']
         and value['before']['registrationMutationCount'] == value['before']['onlineAuditCount'] == 0
         and value['before']['tables'] == {n: 0 for n in online.TABLES}
         and value['mysqlIdentitySha256'] == c.fingerprint(evidence['services']['mysql'])
         and value['sqliteProtectionSha256'] == sqlite_sha
         and value['oldApiStop'] == {'identity': {n: evidence['services']['api'][n]
             for n in ('containerId', 'image', 'startedAtSha256')}, 'running': False, 'pid': 0}
         and all(value['sourceApiIdentity'][n] == evidence['services']['api'][n]
             for n in ('containerId', 'image', 'startedAtSha256')), 'AUDIT_RECEIPT_CHANGED')
    identity = value['sourceApiIdentity']
    plan = online._online_after_bit_audit_queries(d, workspace, directory, identity,
        history_cutoff=value['before']['historyCutoff'])
    need(value['historyQuerySha256'] == c.digest(plan['historyQuery'].encode())
         and value['triggerDefinitionsSha256'] == plan['expectedTriggersSha256'], 'AUDIT_QUERY_CHANGED')
    fence = online._online_after_bit_audit_transport(d, directory, {'services': evidence['services']},
        workspace, identity, plan, value['basis'], history_record=value['before'],
        receipt_kind=KIND + '_AUDIT_PROTECTION')
    with fence:
        online.require_fresh_resources(d, directory)
        workspace.jobs_idle(d, directory)
        api = d.service_state(directory, 'api', include_container_id=True)
        engine = d.service_state(directory, 'online-recharge', include_container_id=True)
        workspace.online_engine_idle(d, {'Id': engine['containerId']})
        workspace.workspace_health(d, directory)
        fence.check()
        need(d.service_state(directory, 'api', include_container_id=True) == api
             and d.service_state(directory, 'online-recharge', include_container_id=True) == engine, 'READBACK_IDENTITY_CHANGED')
    return {'historicalPrefixPreserved': True, 'emptyOnlineResources': True, 'executorIdle': True,
            'auditProtectionSha256': c.fingerprint(value)}


def restore(d, core, workspace, online, previous, target, evidence, proof, args, changed, holder, *, transport=None):
    """Idle startup faults only. An accepted/unknown task leaves all fences intact."""
    authority()
    need(args.api_fault_restore_approved is True, 'API_FAULT_RESTORE_APPROVAL_REQUIRED')
    gate = holder.get('gate')
    workspace.jobs_idle(d, target)
    online.require_fresh_resources(d, target)
    if 'api' in changed:
        need(gate is not None and gate.record is not None, 'SQLITE_PROTECTION_REQUIRED')
        gate.check_marker()
        workspace.workspace_idle(d, target, legacy=False)
        workspace.workspace_private_inspect(d, target, proof['images']['api']['reference'],
            gate.volume['name'], expected=gate.summary['logicalSha256'])
    if 'online-recharge' in changed:
        need(d.compose(target, 'ps', '-q', '--all', 'online-recharge'), 'ENGINE_RESULT_UNKNOWN')
        remove_added_engine(d, workspace, online, target, proof, evidence, held_audit=holder.get('audit'))
    if 'api' in changed:
        core.stop_failed_api(d, workspace, target, proof, evidence, gate, None)
        d.rollback_service(previous, target, 'api', evidence['services'])
    if 'admin' in changed:
        d.rollback_service(previous, target, 'admin', evidence['services'])
    states = workspace.snapshot(d, previous)
    need(set(states) == set(c.SERVICES)
         and all(states[n] == evidence['services'][n] for n in PRESERVED)
         and all(states[n]['image'] == evidence['services'][n]['image']
             and states[n]['reference'] == evidence['services'][n]['reference']
             and states[n]['environmentSha256'] == evidence['services'][n]['environmentSha256']
             and core.configuration_model(d, states[n]) == evidence['configurationModels'][n]
             and states[n]['status'] == 'running' and states[n]['health'] == 'healthy'
             for n in ('api', 'admin'))
         and workspace.workspace_volume(d, previous, attached=True) == evidence['workspaceVolume']
         and not d.compose(target, 'ps', '-q', '--all', 'online-recharge'), 'FAULT_RESTORE_NOT_PROVEN')
    records = predecessor_records(d, core, previous)
    db = c.verify_applied_database(d, online, workspace, previous, predecessor_records=records,
        migration_plan=[], source_candidate=False)
    verify_online_grants(d, online, previous)
    need(c.digest(core.private_bytes(previous / '.env.aws.production')) == evidence['environmentFileSha256'],
         'FAULT_RESTORE_ENVIRONMENT_CHANGED')
    if gate is not None:
        gate.d = d
        gate.abort()
    if (d.BASE / 'current').resolve() == target:
        d.point_current(previous, args.run_id + '-online-component-restore')
    need((d.BASE / 'current').resolve() == previous, 'FAULT_RESTORE_POINTER_CHANGED')
    restore_proof_raw = core.write_private(target / (PREFIX + '-fault-build-proof.json'), proof)
    restore_pref_raw = core.write_private(target / (PREFIX + '-fault-preflight.json'), transport)
    value = {'version': 1, 'scope': SCOPE, 'kind': KIND + '_FAULT_RESTORE',
        'status': 'RESTORED_INDEPENDENT_READBACK_REQUIRED', 'producer': proof['producer'],
        'baseline': evidence, 'servicesAttempted': list(changed), 'servicesAfter': states,
        'engineAddedRemoved': 'online-recharge' in changed, 'workspaceVolume': evidence['workspaceVolume'],
        'sqliteProtectionSha256': c.fingerprint(gate.record) if gate is not None else None,
        'buildProofBytesSha256': c.digest(restore_proof_raw), 'preflightBytesSha256': c.digest(restore_pref_raw),
        'appliedDatabase': db, 'onlineGrants': verify_online_grants(d, online, previous),
        'migrationPerformed': False, 'databaseGrantsChanged': False, 'executionMigrationPlan': [],
        'volumeDeletionPerformed': False, 'businessActions': 0}
    raw = core.write_private(target / (PREFIX + '-fault-restore.json'), value)
    return {'status': value['status'], 'independentReadbackRequired': True,
            'recordSha256': c.fingerprint(value), 'recordBytesSha256': c.digest(raw), 'failedRelease': str(target)}


class ComponentFailure(RuntimeError):
    def __init__(self, code, receipt):
        super().__init__(code)
        self.receipt = receipt


def fault_restore_controller(original, holder):
    authority()
    audit = holder.get('audit')
    if audit is None: return original
    bounded = holder.get('controller')
    need(isinstance(bounded, DeadlineController) and bounded.deadline == audit.pipe.deadline,
         'RESTORE_FENCE_CONTROLLER_REQUIRED')
    audit.check()
    bounded.timeout(1)
    return bounded


def release(d, args, proof, transport):
    authority()  # Must run before loading a controller, acquiring a lock or building.
    need(args.api_fault_restore_approved is True, 'API_FAULT_RESTORE_APPROVAL_REQUIRED')
    d, core, admin, workspace, online = modules(d)
    p = producer(args.commit, args.source_tree, args.run_id, args.run_attempt)
    pref = validate_preflight(core, transport, p, args.expected_current)
    files, output, record = source(d, p, pref['baseline'])
    validate_build(proof, p, record, transport, args.ci_run_id, args.repository)
    need(pref['sourceProjectionSha256'] == c.fingerprint(record), 'SOURCE_PROJECTION_CHANGED')
    os.umask(0o077)
    with (d.BASE / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        previous, old, evidence = baseline(d, args.expected_current)
        need(evidence == pref['baseline'], 'PREFLIGHT_BASELINE_CHANGED')
        stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
        target = d.BASE / 'releases' / (stamp + '-' + p['commit'][:12])
        need(not target.exists(), 'RELEASE_EXISTS')
        changed, holder, phase = [], {}, 'source'
        try:
            d.write_registration_files(target, output)
            original_env = online.extend_environment(d, previous, target)
            need(c.digest(original_env) == evidence['environmentFileSha256'], 'ENVIRONMENT_CHANGED')
            override = core.closed_json(core.private_bytes(previous / 'compose.release.json'))
            for name in IMAGES:
                override['services'][name] = {'image': proof['images'][name]['reference'], 'pull_policy': 'never'}
            core.write_private(target / 'compose.release.json', override)
            preserve(d, core, workspace, online, previous, target, evidence, proof,
                pointer=previous, all_services=True)
            phase = 'images'
            need(d.shutil.disk_usage(d.BASE).free > 6 * 1024**3, 'DISK_LOW_BEFORE_PULL')
            password = d.run('aws', 'ecr', 'get-login-password', '--region', 'ap-northeast-1')
            registry = args.repository.split('/')[0]
            login = d.subprocess.run(['docker', 'login', '--username', 'AWS', '--password-stdin', registry],
                input=password, capture_output=True, text=True)
            need(login.returncode == 0, 'IMAGE_LOGIN_FAILED')
            try:
                for name in IMAGES:
                    d.run('docker', 'pull', proof['images'][name]['reference'], timeout=900)
                    verify_image(d, online, target, output, p, proof, name)
            finally:
                d.subprocess.run(['docker', 'logout', registry], capture_output=True, text=True)
            need(d.shutil.disk_usage(d.BASE).free > 2 * 1024**3, 'DISK_LOW')
            phase = 'backup'
            ordinary_raw = d.registration_download(authority()['producer']['commit'])
            ordinary_files = d.registration_archive(ordinary_raw, authority()['producer']['commit'])
            need(c.digest(ordinary_raw) == evidence['ordinaryArchiveSha256'], 'ORDINARY_ARCHIVE_CHANGED')
            installed = backup_cas(d, core, workspace, previous, old, evidence['services'], ordinary_files)
            need(installed == evidence['backupInstallation'], 'BACKUP_INSTALLATION_CHANGED')
            backup = d.fresh_backup(previous)  # Existing standard S3/restore check; CAS lock already released.
            core.backup_guard(backup)
            backup_raw = core.write_private(target / 'backup-verification.json', backup)
            need(backup_cas(d, core, workspace, previous, old, evidence['services'], ordinary_files)
                 == installed, 'BACKUP_INSTALLATION_CHANGED')
            migration = c.verify_applied_database(d, online, workspace, target,
                predecessor_records=predecessor_records(d, core, previous), migration_plan=d.migration_plan(previous, target))
            need(migration == evidence['appliedDatabase'], 'APPLIED_DATABASE_CHANGED')
            verify_online_grants(d, online, target)
            migration_raw = core.write_private(target / (PREFIX + '-migration.json'), migration)
            phase = 'service-switch'
            gate, audit = switch(d, core, workspace, online, previous, target, evidence, proof, args,
                changed, gate_holder=holder)
            d = holder['controller']
            audit_raw = core.write_private(target / (PREFIX + '-audit-protection.json'), audit)
            phase = 'protected-readback'
            states = preserve(d, core, workspace, online, previous, target, evidence, proof, pointer=previous, engine=True)
            for name in UPDATED:
                need(states[name]['image'] == proof['images'][name]['imageId']
                     and states[name]['reference'] == proof['images'][name]['reference'], 'RUNNING_IMAGE_CHANGED')
            current_backup_cas(d, core, workspace, previous, target, evidence, ordinary_files,
                {n: states[n] for n in c.SERVICES})
            holder['audit'].check()
            state = {'version': 1, 'scope': SCOPE, 'kind': KIND + '_PRESERVATION', 'producer': p,
                'baseline': evidence, 'before': evidence['services'], 'after': states,
                'workspaceVolumeBefore': evidence['workspaceVolume'],
                'workspaceVolumeAfter': workspace.workspace_volume(d, target, attached=True),
                'sqliteProtectionSha256': c.fingerprint(gate.record), 'auditProtectionSha256': c.fingerprint(audit),
                'migration': migration, 'backupInstallation': installed, 'freshBackup': backup, 'onlinePublished': True,
                'migrationPerformed': False, 'databaseGrantsChanged': False, 'businessActions': 0}
            state_raw = core.write_private(target / (PREFIX + '-preservation.json'), state)
            proof_raw = core.write_private(target / (PREFIX + '-build-proof.json'), proof)
            core.write_private(target / (PREFIX + '-preflight.json'), transport)
            core.write_private(target / (PREFIX + '-build-projection.json'), record)
            ledger = {'version': 1, 'scope': SCOPE, 'kind': KIND, 'producer': p, 'baseline': evidence,
                'sourceProjectionSha256': c.fingerprint(record),
                'sourceFilesSha256': c.fingerprint(core.projection_module().inventory(files)),
                'sourceArchiveSha256': record['candidateArchiveSha256'], 'buildProofBytesSha256': c.digest(proof_raw),
                'preservationRecordBytesSha256': c.digest(state_raw), 'preflightSha256': c.fingerprint(transport),
                'sqliteProtectionSha256': c.fingerprint(gate.record), 'auditProtectionSha256': c.fingerprint(audit),
                'auditRecordBytesSha256': c.digest(audit_raw), 'migrationRecordBytesSha256': c.digest(migration_raw),
                'backupInstallationSha256': c.fingerprint(installed), 'originMarkersSha256': evidence['originMarkersSha256'],
                'backupReceiptBytesSha256': c.digest(backup_raw), 'backupReceiptSha256': c.fingerprint(backup),
                'servicesUpdated': list(UPDATED), 'ordinaryPublishedProducer': evidence['ordinaryProducer'],
                'onlinePublished': True, 'migrationPerformed': False, 'databaseGrantsChanged': False,
                'executionMigrationPlan': [], 'businessActions': 0}
            manifest = copy.deepcopy(old)
            manifest.update(commit=p['commit'], sourceTree=p['sourceTree'], sourceBranch='main',
                previousCommit=args.expected_current, previousRelease=str(previous),
                previousManifestSha256=evidence['manifestBytesSha256'], releaseTag='v2-production-' + stamp,
                deployedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                ciWorkflowRunId=int(args.ci_run_id), deploymentRun=f'github-actions-{args.run_id}-{args.run_attempt}',
                imageBuildRun=f'github-actions-{args.run_id}-{args.run_attempt}', servicesUpdated=list(UPDATED),
                sourceArchiveSha256=record['candidateArchiveSha256'], backupBeforeRelease=backup['name'],
                migrationApplied=True, migrationPerformed=False, newMigrations=[], onlineComponentPublication=ledger,
                databaseGrants={'status': 'EXISTING_GRANTS_READONLY_VERIFIED', 'newTables': [], 'mutationPerformed': False},
                rollback={'release': str(previous), 'scope': KIND + '_IDLE_STARTUP_FAULT_RESTORE',
                    'images': {n: evidence['services'][n]['image'] for n in ('api', 'admin')},
                    'servicesAdded': ['online-recharge']})
            for name in IMAGES:
                manifest['images'][name] = {'reference': proof['images'][name]['reference'],
                    'digest': proof['images'][name]['imageId'], 'sourceCommit': p['commit']}
            need(all(manifest[n] == old[n] for n in (*admin.ORIGIN_MARKERS, 'apiComponentPublication',
                'adminPublication', 'apiHotfixPublication')), 'HISTORICAL_ORIGIN_CHANGED')
            core.write_private(target / 'release-manifest.json', manifest)
            phase = 'publication'
            d.point_current(target, args.run_id)
            # The original same-connection READ fence is retained across the
            # complete candidate validation and pointer/readback publication.
            result = readback(d, p['commit'], held_audit=holder['audit'], prepared_source=(files, output, record),
                              prepared_ordinary=ordinary_files)
            holder['audit'].check()
            gate.finish()
            holder['audit'].__exit__(None, None, None); holder['audit'] = None
            return result
        except Exception as error:
            gate = holder.get('gate') or getattr(error, 'sqlite_gate', None)
            if gate is not None:
                gate.close()
            recovery = {'status': 'NOT_REQUIRED' if not changed else 'UNKNOWN'}
            try:
                # Expired fences may never lend their authority to recovery.
                d = fault_restore_controller(d, holder)
                if changed or gate is not None:
                    recovery = restore(d, core, workspace, online, previous, target, evidence, proof, args, changed,
                        holder, transport=transport)
            except Exception:
                recovery = {'status': 'BLOCKED_OR_FAILED', 'sqliteMaintenanceRetained': gate is not None}
            code = str(error)
            if not re.fullmatch('(?:ONLINE_RECHARGE_COMPONENT|ONLINE_RECHARGE|API_ADMIN|UNPUBLISHED_COMPONENT)_[A-Z0-9_]+', code):
                code = 'ONLINE_RECHARGE_COMPONENT_PROTECTED_OPERATION_FAILED'
            publication = {'attempted': phase == 'publication', 'currentRole': 'UNAVAILABLE', 'onlinePublished': None}
            try:
                actual_pointer = (d.BASE / 'current').resolve()
                if actual_pointer == previous and core.private_bytes(previous / 'release-manifest.json') == predecessor_records(d, core, previous)[1]:
                    publication.update(currentRole='PREDECESSOR', onlinePublished=False)
                elif actual_pointer == target:
                    actual_manifest = core.closed_json(core.private_bytes(target / 'release-manifest.json'))
                    actual_ledger = actual_manifest.get('onlineComponentPublication', {})
                    need(actual_ledger.get('producer') == p and actual_ledger.get('kind') == KIND
                         and actual_ledger.get('onlinePublished') is True, 'FAILURE_PUBLICATION_UNKNOWN')
                    publication.update(currentRole='CANDIDATE', onlinePublished=True)
            except Exception:
                pass
            failure = {'version': 1, 'scope': SCOPE, 'kind': KIND, 'status': 'ONLINE_RECHARGE_COMPONENT_FAILED',
                'producer': p, 'phase': phase, 'code': code, 'servicesAttempted': changed, 'recovery': recovery,
                'publication': publication, 'onlinePublished': publication['onlinePublished'],
                'migrationPerformed': False, 'databaseGrantsChanged': False,
                'executionMigrationPlan': [], 'volumeDeletionPerformed': False,
                'businessActions': None if recovery['status'] == 'BLOCKED_OR_FAILED' else 0}
            validate_failure_receipt(failure, p)
            try:
                core.write_private(target / (PREFIX + '-failure.json'), failure)
            except Exception:
                pass
            raise ComponentFailure(code, failure) from None
        finally:
            audit = holder.get('audit')
            if audit is not None:
                audit.__exit__(None, None, None)


RETURN_FIELDS = frozenset(('version', 'scope', 'kind', 'status', 'producer', 'manifestBytesSha256',
    'publicationSha256', 'buildProofBytesSha256', 'preservationRecordBytesSha256', 'sourceProjectionSha256',
    'sqliteProtectionSha256', 'auditProtectionSha256', 'backupInstallationSha256',
    'migrationPerformed', 'databaseGrantsChanged', 'executionMigrationPlan', 'servicesUpdated',
    'preservedServiceCount', 'onlinePublished', 'businessActions', 'volumeDeletionPerformed',
    'runningImagesAndContentMatched', 'databaseOldGrantsPreserved', 'appliedDatabase',
    'onlineGrants', 'backupVerified', 'backupReceiptBytesSha256'))


def validate_failure_receipt(value, p):
    authority()
    fields = {'version', 'scope', 'kind', 'status', 'producer', 'phase', 'code', 'servicesAttempted',
        'recovery', 'publication', 'onlinePublished', 'migrationPerformed', 'databaseGrantsChanged',
        'executionMigrationPlan', 'volumeDeletionPerformed', 'businessActions'}
    need(type(value) is dict and set(value) == fields and type(value['version']) is int and value['version'] == 1
         and value['scope'] == SCOPE and value['kind'] == KIND and value['producer'] == p
         and value['status'] == 'ONLINE_RECHARGE_COMPONENT_FAILED'
         and value['phase'] in ('source', 'images', 'backup', 'service-switch', 'protected-readback', 'publication')
         and type(value['code']) is str and re.fullmatch('(?:ONLINE_RECHARGE_COMPONENT|ONLINE_RECHARGE|API_ADMIN|UNPUBLISHED_COMPONENT)_[A-Z0-9_]+', value['code'])
         and type(value['servicesAttempted']) is list
         and value['servicesAttempted'] in ([], ['admin'], ['admin', 'api'], ['admin', 'api', 'online-recharge'])
         and value['migrationPerformed'] is False and value['databaseGrantsChanged'] is False
         and type(value['executionMigrationPlan']) is list and value['executionMigrationPlan'] == []
         and value['volumeDeletionPerformed'] is False, 'FAILURE_RECEIPT_CHANGED')
    publication = value['publication']; recovery = value['recovery']
    need(type(publication) is dict and set(publication) == {'attempted', 'currentRole', 'onlinePublished'}
         and type(publication['attempted']) is bool and publication['attempted'] is (value['phase'] == 'publication')
         and publication['currentRole'] in ('UNAVAILABLE', 'PREDECESSOR', 'CANDIDATE')
         and publication['onlinePublished'] is {'UNAVAILABLE': None, 'PREDECESSOR': False, 'CANDIDATE': True}[publication['currentRole']]
         and value['onlinePublished'] is publication['onlinePublished']
         and type(recovery) is dict, 'FAILURE_PUBLICATION_CHANGED')
    if recovery.get('status') == 'NOT_REQUIRED':
        need(set(recovery) == {'status'} and not value['servicesAttempted'], 'FAILURE_RECOVERY_CHANGED')
    elif recovery.get('status') == 'BLOCKED_OR_FAILED':
        need(set(recovery) == {'status', 'sqliteMaintenanceRetained'}
             and type(recovery['sqliteMaintenanceRetained']) is bool
             and value['businessActions'] is None, 'FAILURE_RECOVERY_CHANGED')
    else:
        need(set(recovery) == {'status', 'independentReadbackRequired', 'recordSha256', 'recordBytesSha256', 'failedRelease'}
             and recovery['status'] == 'RESTORED_INDEPENDENT_READBACK_REQUIRED'
             and recovery['independentReadbackRequired'] is True
             and all(type(recovery[n]) is str and re.fullmatch('[a-f0-9]{64}', recovery[n])
                 for n in ('recordSha256', 'recordBytesSha256'))
             and type(recovery['failedRelease']) is str
             and re.fullmatch('/opt/id-business-v2/releases/[0-9]{8}T[0-9]{6}Z-' + p['commit'][:12], recovery['failedRelease']),
             'FAILURE_RECOVERY_CHANGED')
    need(value['businessActions'] is None or (type(value['businessActions']) is int and value['businessActions'] == 0),
         'FAILURE_BUSINESS_STATE_CHANGED')
    return value


def validate_return_receipt(value, p, *, status='ONLINE_RECHARGE_VERIFIED'):
    authority()
    need(type(value) is dict and set(value) == RETURN_FIELDS
         and type(value['version']) is int and value['version'] == 1
         and value['scope'] == SCOPE and value['kind'] == KIND and value['status'] == status
         and value['producer'] == p and value['servicesUpdated'] == list(UPDATED)
         and type(value['preservedServiceCount']) is int and value['preservedServiceCount'] == len(PRESERVED)
         and value['onlinePublished'] is True and value['migrationPerformed'] is False
         and value['databaseGrantsChanged'] is False and type(value['executionMigrationPlan']) is list
         and value['executionMigrationPlan'] == [] and type(value['businessActions']) is int and value['businessActions'] == 0
         and value['volumeDeletionPerformed'] is False and value['runningImagesAndContentMatched'] is True
         and value['databaseOldGrantsPreserved'] is True and value['backupVerified'] is True
         and all(type(value[n]) is str and re.fullmatch('[a-f0-9]{64}', value[n])
                 for n in RETURN_FIELDS if n.endswith('Sha256'))
         and value['appliedDatabase']['online']['status'] == 'APPLIED'
         and value['appliedDatabase']['connectionProfile']['status'] == 'APPLIED'
         and value['appliedDatabase']['online']['schemaVerified'] is True
         and value['appliedDatabase']['connectionProfile']['schemaVerified'] is True
         and value['appliedDatabase']['migrationPerformed'] is False
         and value['appliedDatabase']['databaseGrantsChanged'] is False
         and value['appliedDatabase']['migrationPlan'] == []
         and value['onlineGrants']['status'] == 'EXISTING_ONLINE_GRANTS_READONLY_VERIFIED'
         and value['onlineGrants']['mutationPerformed'] is False, 'RETURN_RECEIPT_CHANGED')
    return value


def readback(d, commit, *, held_audit=None, prepared_source=None, prepared_ordinary=None):
    a = authority()
    d, core, admin, workspace, online = modules(d)
    current = (d.BASE / 'current').resolve()
    need(current.parent == d.BASE / 'releases', 'CURRENT_PATH_CHANGED')
    manifest_raw = core.private_bytes(current / 'release-manifest.json')
    manifest = core.closed_json(manifest_raw)
    ledger = manifest.get('onlineComponentPublication', {})
    p = ledger.get('producer', {})
    need(p == producer(p.get('commit'), p.get('sourceTree'), p.get('workflowRunId'), p.get('workflowRunAttempt'))
         and commit == manifest.get('commit') == p['commit'] and manifest.get('sourceTree') == p['sourceTree']
         and manifest.get('servicesUpdated') == list(UPDATED) and manifest.get('migrationApplied') is True
         and manifest.get('migrationPerformed') is False and manifest.get('newMigrations') == []
         and ledger.get('kind') == KIND and ledger.get('scope') == SCOPE and ledger.get('onlinePublished') is True
         and ledger.get('migrationPerformed') is False and ledger.get('databaseGrantsChanged') is False
         and ledger.get('executionMigrationPlan') == [] and type(ledger.get('businessActions')) is int
         and ledger['businessActions'] == 0 and ledger.get('servicesUpdated') == list(UPDATED), 'PUBLICATION_CHANGED')
    proof_raw = core.private_bytes(current / (PREFIX + '-build-proof.json'))
    state_raw = core.private_bytes(current / (PREFIX + '-preservation.json'))
    proof, state = core.closed_json(proof_raw), core.closed_json(state_raw)
    transport = core.closed_json(core.private_bytes(current / (PREFIX + '-preflight.json')))
    evidence = validate_preflight(core, transport, p, a['producer']['commit'])['baseline']
    previous = Path(evidence['currentRelease'])
    need(previous.parent == d.BASE / 'releases' and previous != current
         and manifest.get('previousRelease') == str(previous) and manifest.get('previousCommit') == a['producer']['commit']
         and manifest.get('previousManifestSha256') == evidence['manifestBytesSha256'], 'PREVIOUS_RELEASE_CHANGED')
    predecessor = c.authenticate_component_records(*predecessor_records(d, core, previous))
    old = predecessor['manifest']
    need(all(manifest[n] == old[n] for n in (*admin.ORIGIN_MARKERS, 'apiComponentPublication',
         'adminPublication', 'apiHotfixPublication'))
         and c.fingerprint({n: manifest[n] for n in admin.ORIGIN_MARKERS})
             == evidence['originMarkersSha256'] == ledger['originMarkersSha256'], 'HISTORICAL_ORIGIN_CHANGED')
    files, output, record = source(d, p, evidence) if prepared_source is None else prepared_source
    need(held_audit is not None or (prepared_source is None and prepared_ordinary is None), 'SOURCE_REUSE_INVALID')
    c.validate_source_files(files)
    need(core.projection_module().source_tree(files) == p['sourceTree']
         and core.closed_json(core.private_bytes(current / (PREFIX + '-build-projection.json'))) == record,
         'SOURCE_PROJECTION_CHANGED')
    repository = proof['images']['api']['reference'].rsplit(':', 1)[0]
    validate_build(proof, p, record, transport, str(manifest['ciWorkflowRunId']), repository)
    need(ledger['baseline'] == evidence == state['baseline'] and state['before'] == evidence['services']
         and state.get('producer') == p and state.get('kind') == KIND + '_PRESERVATION'
         and state.get('migrationPerformed') is False and state.get('databaseGrantsChanged') is False
         and state.get('onlinePublished') is True and type(state.get('businessActions')) is int and state['businessActions'] == 0
         and ledger['buildProofBytesSha256'] == c.digest(proof_raw)
         and ledger['preservationRecordBytesSha256'] == c.digest(state_raw)
         and ledger['sourceProjectionSha256'] == c.fingerprint(record)
         and ledger['sourceFilesSha256'] == c.fingerprint(core.projection_module().inventory(files))
         and ledger['sourceArchiveSha256'] == manifest['sourceArchiveSha256'] == record['candidateArchiveSha256']
         and ledger['preflightSha256'] == c.fingerprint(transport)
         and ledger['ordinaryPublishedProducer'] == a['producer'], 'RECORD_BINDING_CHANGED')
    for name, (raw, mode) in output.items():
        path = current / name
        need(path.is_file() and not path.is_symlink() and path.read_bytes() == raw
             and ('100755' if path.stat().st_mode & 0o111 else '100644') == mode, 'PUBLISHED_SOURCE_CHANGED')
    states = preserve(d, core, workspace, online, previous, current, evidence, proof, pointer=current, engine=True)
    need(states == state['after'] and all(states[n]['image'] == proof['images'][n]['imageId']
         and states[n]['reference'] == proof['images'][n]['reference']
         and states[n]['status'] == 'running' and states[n]['health'] == 'healthy' for n in UPDATED), 'RUNNING_IDENTITY_CHANGED')
    for name in IMAGES:
        row = proof['images'][name]
        verify_image_identity(d, online, row, p, record)
        if held_audit is None:
            verify_image(d, online, current, output, p, proof, name)
    # Executable bytes of each running process must match the isolated image
    # proof, including the fixed executor. These commands never invoke a task.
    for name in UPDATED:
        content = online.content_summary(d, name, d.compose(current, 'exec', '-T', name,
            '/bin/sh', '-c', online.content_command(name), timeout=20))
        need(content == {k: proof['images'][name][k] for k in ('fileCount', 'sha256')}, 'RUNNING_CONTENT_CHANGED')
    migration_raw = core.private_bytes(current / (PREFIX + '-migration.json'))
    actual = c.verify_applied_database(d, online, workspace, current,
        predecessor_records=predecessor_records(d, core, previous), migration_plan=d.migration_plan(previous, current))
    need(c.digest(migration_raw) == ledger['migrationRecordBytesSha256']
         and core.closed_json(migration_raw) == actual == state['migration'] == evidence['appliedDatabase'],
         'MIGRATION_READBACK_CHANGED')
    grants = verify_online_grants(d, online, current)
    sqlite = workspace.workspace_sqlite_receipt(d, current, proof, state,
        {'apiWorkspacePublication': {'sqliteProtectionSha256': ledger['sqliteProtectionSha256']}})
    need(sqlite is not None and state['sqliteProtectionSha256'] == ledger['sqliteProtectionSha256'], 'SQLITE_RECEIPT_CHANGED')
    verify_live_sqlite(d, core, workspace, current, current, proof['images']['api']['reference'],
        ledger['sqliteProtectionSha256'])
    audit_raw = core.private_bytes(current / (PREFIX + '-audit-protection.json'))
    audit = core.closed_json(audit_raw)
    need(c.digest(audit_raw) == ledger['auditRecordBytesSha256']
         and c.fingerprint(audit) == ledger['auditProtectionSha256'] == state['auditProtectionSha256'], 'AUDIT_RECORD_CHANGED')
    if held_audit is None:
        audit_readback(d, workspace, online, current, evidence, audit, ledger['sqliteProtectionSha256'])
    else:
        need(held_audit.receipt == audit, 'AUDIT_FENCE_CHANGED')
        held_audit.check(); online.require_fresh_resources(d, current)
        workspace.jobs_idle(d, current); workspace.workspace_health(d, current)
        workspace.online_engine_idle(d, {'Id': states['online-recharge']['containerId']})
        held_audit.check()
    if prepared_ordinary is None:
        ordinary_raw = d.registration_download(a['producer']['commit'])
        need(c.digest(ordinary_raw) == evidence['ordinaryArchiveSha256'], 'ORDINARY_ARCHIVE_CHANGED')
        ordinary_files = d.registration_archive(ordinary_raw, a['producer']['commit'])
    else:
        ordinary_files = prepared_ordinary
    need(core.projection_module().source_tree(ordinary_files) == a['producer']['sourceTree']
         and c.fingerprint(core.projection_module().inventory(ordinary_files)) == evidence['ordinarySourceFilesSha256'],
         'ORDINARY_ARCHIVE_CHANGED')
    backup = current_backup_cas(d, core, workspace, previous, current, evidence, ordinary_files,
        {n: states[n] for n in c.SERVICES}, pointer=current)
    need({k: backup[k] for k in backup if k != 'servicesSha256'}
         == {k: state['backupInstallation'][k] for k in state['backupInstallation'] if k != 'servicesSha256'}
         and ledger['backupInstallationSha256'] == c.fingerprint(state['backupInstallation']), 'BACKUP_READBACK_CHANGED')
    fresh_backup = verify_fresh_backup(d, core, current, manifest, ledger, state)
    public = d.environment_values(current / '.env.aws.production')['APP_PUBLIC_URL'].rstrip('/')
    for path in ('/', '/api/health/ready'):
        with d.urllib.request.urlopen(public + path, timeout=10) as response:
            need(response.status == 200, 'PUBLIC_NOT_READY')
            if path == '/':
                need(('v2-' + commit).encode() in response.read(4 * 1024 * 1024), 'PUBLIC_VERSION_CHANGED')
    need((d.BASE / 'current').resolve() == current and core.private_bytes(current / 'release-manifest.json') == manifest_raw
         and online.snapshot(d, current, include_engine=True) == states, 'READBACK_MOVED')
    result = {'version': 1, 'scope': SCOPE, 'kind': KIND, 'status': 'ONLINE_RECHARGE_VERIFIED', 'producer': p,
        'manifestBytesSha256': c.digest(manifest_raw), 'publicationSha256': c.fingerprint(ledger),
        'buildProofBytesSha256': c.digest(proof_raw), 'preservationRecordBytesSha256': c.digest(state_raw),
        'sourceProjectionSha256': c.fingerprint(record), 'sqliteProtectionSha256': ledger['sqliteProtectionSha256'],
        'auditProtectionSha256': ledger['auditProtectionSha256'], 'backupInstallationSha256': ledger['backupInstallationSha256'],
        'migrationPerformed': False, 'databaseGrantsChanged': False, 'executionMigrationPlan': [],
        'servicesUpdated': list(UPDATED), 'preservedServiceCount': len(PRESERVED), 'onlinePublished': True,
        'businessActions': 0, 'volumeDeletionPerformed': False, 'runningImagesAndContentMatched': True,
        'databaseOldGrantsPreserved': True, 'appliedDatabase': actual, 'onlineGrants': grants, 'backupVerified': True,
        'backupReceiptBytesSha256': fresh_backup['backupReceiptBytesSha256']}
    return validate_return_receipt(result, p)


def restore_readback(d, p, failed_release):
    """New native proof of an idle restore, never reuse the old container IDs."""
    a = authority()
    d, core, _admin, workspace, online = modules(d)
    target = Path(failed_release)
    need(target.is_absolute() and target.resolve() == target and not target.is_symlink()
         and target.parent == d.BASE / 'releases', 'RESTORE_PATH_CHANGED')
    raw = core.private_bytes(target / (PREFIX + '-fault-restore.json'))
    value = core.closed_json(raw)
    need(value.get('version') == 1 and type(value.get('version')) is int and value.get('scope') == SCOPE
         and value.get('kind') == KIND + '_FAULT_RESTORE' and value.get('producer') == p
         and value.get('status') == 'RESTORED_INDEPENDENT_READBACK_REQUIRED'
         and value.get('migrationPerformed') is False and value.get('databaseGrantsChanged') is False
         and value.get('executionMigrationPlan') == [] and value.get('volumeDeletionPerformed') is False
         and type(value.get('businessActions')) is int and value['businessActions'] == 0, 'RESTORE_RECORD_CHANGED')
    proof_raw = core.private_bytes(target / (PREFIX + '-fault-build-proof.json'))
    pref_raw = core.private_bytes(target / (PREFIX + '-fault-preflight.json'))
    need(c.digest(proof_raw) == value['buildProofBytesSha256']
         and c.digest(pref_raw) == value['preflightBytesSha256'], 'RESTORE_RECORD_CHANGED')
    proof, transport = core.closed_json(proof_raw), core.closed_json(pref_raw)
    evidence = validate_preflight(core, transport, p, a['producer']['commit'])['baseline']
    need(value['baseline'] == evidence, 'RESTORE_BASELINE_CHANGED')
    previous = Path(evidence['currentRelease'])
    need(previous.parent == d.BASE / 'releases' and (d.BASE / 'current').resolve() == previous, 'RESTORE_POINTER_CHANGED')
    records = predecessor_records(d, core, previous)
    original = c.authenticate_component_records(*records)
    # Restore creates new API/Admin IDs. Authenticate the old interpreter and
    # all ten archived helper bytes without pretending its old live receipt is
    # valid for those new processes.
    _historical_controller, _historical_files, historical_archive_sha = original_controller(d, core, previous)
    need(historical_archive_sha == evidence['ordinaryArchiveSha256'], 'RESTORE_ARCHIVE_CHANGED')
    need(c.digest(records[1]) == evidence['manifestBytesSha256'], 'RESTORE_MANIFEST_CHANGED')
    files, output, projection = source(d, p, evidence)
    validate_build(proof, p, projection, transport, proof['qualityRunId'],
        proof['images']['api']['reference'].rsplit(':', 1)[0])
    for name, (content, mode) in output.items():
        path = target / name
        need(path.is_file() and not path.is_symlink() and path.read_bytes() == content
             and ('100755' if path.stat().st_mode & 0o111 else '100644') == mode, 'RESTORE_SOURCE_CHANGED')
    states = workspace.snapshot(d, previous)
    need(states == value['servicesAfter'] and set(states) == set(c.SERVICES)
         and all(states[n] == evidence['services'][n] for n in PRESERVED)
         and all(states[n]['image'] == evidence['services'][n]['image']
             and states[n]['reference'] == evidence['services'][n]['reference']
             and states[n]['environmentSha256'] == evidence['services'][n]['environmentSha256']
             and core.configuration_model(d, states[n]) == evidence['configurationModels'][n]
             and states[n]['status'] == 'running' and states[n]['health'] == 'healthy' for n in ('api', 'admin'))
         and workspace.workspace_volume(d, previous, attached=True) == value['workspaceVolume'] == evidence['workspaceVolume']
         and c.digest(core.private_bytes(previous / '.env.aws.production')) == evidence['environmentFileSha256']
         and not d.compose(target, 'ps', '-q', '--all', 'online-recharge'), 'RESTORE_PROTECTION_CHANGED')
    workspace.jobs_idle(d, previous); workspace.workspace_idle(d, previous, legacy=False)
    workspace.workspace_audit_protection(d, previous); workspace.workspace_health(d, previous)
    online.require_fresh_resources(d, previous)
    applied = c.verify_applied_database(d, online, workspace, previous, predecessor_records=records,
        migration_plan=[], source_candidate=False)
    need(applied == value['appliedDatabase'] == evidence['appliedDatabase'], 'RESTORE_DATABASE_CHANGED')
    grants = verify_online_grants(d, online, previous)
    need(grants == value['onlineGrants'], 'RESTORE_GRANTS_CHANGED')
    for name in ('api', 'admin'):
        row = original['proof']['images'][name]
        online.inspect_image(d, row, a['producer']['commit'], a['producer']['sourceTree'])
        actual = online.content_summary(d, name, d.compose(previous, 'exec', '-T', name,
            '/bin/sh', '-c', online.content_command(name), timeout=30))
        need(actual == {key: row[key] for key in ('fileCount', 'sha256')}, 'RESTORE_CONTENT_CHANGED')
    sqlite_sha = value['sqliteProtectionSha256']
    if sqlite_sha is not None:
        workspace.workspace_sqlite_receipt(d, target, proof,
            {'before': evidence['services'], 'workspaceVolumeBefore': evidence['workspaceVolume'],
             'workspaceVolumeAfter': evidence['workspaceVolume'], 'sqliteProtectionSha256': sqlite_sha},
            {'apiWorkspacePublication': {'sqliteProtectionSha256': sqlite_sha}})
        verify_live_sqlite(d, core, workspace, target, previous, original['proof']['images']['api']['reference'], sqlite_sha)
    ordinary_raw = d.registration_download(a['producer']['commit'])
    need(c.digest(ordinary_raw) == evidence['ordinaryArchiveSha256'], 'RESTORE_ARCHIVE_CHANGED')
    ordinary_files = d.registration_archive(ordinary_raw, a['producer']['commit'])
    installed = backup_cas(d, core, workspace, previous, original['manifest'], states, ordinary_files)
    need({k: installed[k] for k in installed if k != 'servicesSha256'}
         == {k: evidence['backupInstallation'][k] for k in evidence['backupInstallation'] if k != 'servicesSha256'},
         'RESTORE_BACKUP_CHANGED')
    public = d.environment_values(previous / '.env.aws.production')['APP_PUBLIC_URL'].rstrip('/')
    with d.urllib.request.urlopen(public + '/', timeout=20) as response:
        need(response.status == 200 and ('v2-' + a['producer']['commit']).encode()
             in response.read(4 * 1024 * 1024), 'RESTORE_PUBLIC_VERSION_CHANGED')
    need((d.BASE / 'current').resolve() == previous and workspace.snapshot(d, previous) == states
         and core.private_bytes(target / (PREFIX + '-fault-restore.json')) == raw
         and core.private_bytes(previous / 'release-manifest.json') == records[1], 'RESTORE_READBACK_MOVED')
    return {'version': 1, 'scope': SCOPE, 'kind': KIND, 'status': 'ONLINE_RECHARGE_COMPONENT_FAULT_RESTORED',
        'producer': p, 'ordinaryProducer': a['producer'], 'restoreRecordBytesSha256': c.digest(raw),
        'manifestBytesSha256': c.digest(records[1]), 'ordinaryAuthoritySha256': c.fingerprint(a),
        'servicesAfter': states, 'engineAddedRemoved': value['engineAddedRemoved'], 'executorAbsent': True,
        'preservedServiceCount': len(PRESERVED), 'migrationPerformed': False, 'databaseGrantsChanged': False,
        'executionMigrationPlan': [], 'onlinePublished': False, 'volumeDeletionPerformed': False,
        'businessActions': 0, 'databaseOldGrantsPreserved': True, 'sqliteProtectionSha256': sqlite_sha,
        'appliedDatabase': applied, 'onlineGrants': grants, 'backupInstallationVerified': True}


def decode_json(core, text, cap=256 * 1024):
    need(type(text) is str and 0 < len(text) < 512 * 1024, 'TRANSPORT_TOO_LARGE')
    if text.startswith('gzip-base64:'):
        raw = bounded_gzip(base64.b64decode(text[len('gzip-base64:'):], validate=True), cap)
    else:
        raw = base64.b64decode(text, validate=True)
    need(0 < len(raw) < cap, 'TRANSPORT_TOO_LARGE')
    return core.closed_json(raw, cap)


def bounded_gzip(packed, cap):
    need(type(packed) is bytes and 0 < len(packed) < cap, 'WIRE_INVALID')
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    raw = decoder.decompress(packed, cap)
    need(decoder.eof and not decoder.unconsumed_tail and not decoder.unused_data
         and 0 < len(raw) < cap, 'WIRE_INVALID')
    return raw


def wire(value):
    raw = (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()
    need(0 < len(raw) < 256 * 1024, 'WIRE_INVALID')
    result = {'version': 1, 'kind': KIND + '_WIRE', 'encoding': 'gzip-base64',
        'decodedLength': len(raw), 'payloadSha256': c.digest(raw),
        'payload': base64.b64encode(gzip.compress(raw, mtime=0)).decode()}
    need(len((json.dumps(result, sort_keys=True, separators=(',', ':')) + '\n').encode()) < 23000, 'WIRE_TOO_LARGE')
    return result


def validate_component_invocation(core, raw, command_id, instance_id, status='Success'):
    authority()
    invocation, envelope = core.validate_invocation(raw, command_id, instance_id, status=status)
    need(set(envelope) == {'version', 'kind', 'encoding', 'decodedLength', 'payloadSha256', 'payload'}
         and type(envelope['version']) is int and envelope['version'] == 1
         and envelope['kind'] == KIND + '_WIRE' and envelope['encoding'] == 'gzip-base64'
         and type(envelope['decodedLength']) is int and 0 < envelope['decodedLength'] < 256 * 1024
         and type(envelope['payloadSha256']) is str and re.fullmatch('[a-f0-9]{64}', envelope['payloadSha256'])
         and type(envelope['payload']) is str, 'WIRE_INVALID')
    decoded = bounded_gzip(base64.b64decode(envelope['payload'], validate=True), 256 * 1024)
    need(len(decoded) == envelope['decodedLength'] and c.digest(decoded) == envelope['payloadSha256'], 'WIRE_CHANGED')
    receipt = core.closed_json(decoded)
    need(receipt.get('kind') == KIND and receipt.get('scope') == SCOPE, 'WIRE_RECEIPT_CHANGED')
    return invocation, receipt


def cli(d=None):
    authority()
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=('preflight', 'prepare', 'build-proof', 'release', 'readback', 'restore-readback'))
    for name in ('commit', 'source-tree', 'expected-current', 'run-id', 'run-attempt', 'repository',
                 'ci-run-id', 'preflight', 'build-proof', 'failed-release'):
        parser.add_argument('--' + name)
    parser.add_argument('--api-fault-restore-approved', action='store_true')
    args = parser.parse_args()
    names = {'commit', 'source_tree', 'run_id', 'run_attempt'}
    required = names | ({'expected_current'} if args.operation == 'preflight' else
        {'repository', 'ci_run_id', 'preflight', 'build_proof', 'expected_current'} if args.operation == 'release' else
        {'repository', 'ci_run_id', 'preflight'} if args.operation == 'build-proof' else
        {'preflight'} if args.operation == 'prepare' else {'failed_release'} if args.operation == 'restore-readback' else set())
    need(all((getattr(args, n) is not None) == (n in required) for n in names |
        {'repository', 'ci_run_id', 'preflight', 'build_proof', 'expected_current', 'failed_release'})
        and args.api_fault_restore_approved is (args.operation == 'release'), 'SELECTION_INVALID')
    p = producer(args.commit, args.source_tree, args.run_id, args.run_attempt)
    if args.operation == 'restore-readback':
        return restore_readback(d, p, args.failed_release)
    if args.operation == 'readback':
        result = readback(d, p['commit'])
        need(result['producer'] == p, 'READBACK_PRODUCER_CHANGED')
        return result
    d, core, _admin, _workspace, _online = modules(d)
    if args.operation == 'preflight':
        return preflight(d, p, args.expected_current)
    transport = decode_json(core, args.preflight)
    if args.operation == 'prepare':
        return prepare(d, p, transport)
    if args.operation == 'build-proof':
        return build_proof(d, p, transport, args.ci_run_id, args.repository)
    return release(d, args, decode_json(core, args.build_proof), transport)


if __name__ == '__main__':
    try:
        print(json.dumps(wire(cli()), sort_keys=True, separators=(',', ':')))
    except ComponentFailure as error:
        print(json.dumps(wire(error.receipt), sort_keys=True, separators=(',', ':')))
        raise SystemExit(1) from None
    except Exception as error:
        code = str(error)
        if not re.fullmatch('(?:ONLINE_RECHARGE_COMPONENT|ONLINE_RECHARGE|API_ADMIN|UNPUBLISHED_COMPONENT)_[A-Z0-9_]+', code):
            code = 'ONLINE_RECHARGE_COMPONENT_PROTECTED_OPERATION_FAILED'
        print(json.dumps(wire({'version': 1, 'scope': SCOPE, 'kind': KIND, 'status': 'ONLINE_RECHARGE_COMPONENT_REJECTED', 'code': code}),
                         sort_keys=True, separators=(',', ':')))
        raise SystemExit(1) from None
