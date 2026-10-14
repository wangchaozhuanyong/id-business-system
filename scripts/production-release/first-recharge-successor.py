"""Finite first-recharge publisher over authenticated API43 and Admin568.

The historical publisher and ONLINE authorities stay byte-for-byte unchanged.
Only this private module instance admits the frozen repair and mixed predecessor.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
from types import ModuleType

HERE = Path(__file__).parent
PREFIX = 'first-recharge-successor'
SCOPE = 'FIRST_RECHARGE_API_ADMIN_SUCCESSOR'
CONTEXT = '.deploy/production-release/' + PREFIX + '-build-context'
PROJECTION = '.deploy/production-release/' + PREFIX + '-build-projection.json'
PROOF = '.deploy/production-release/' + PREFIX + '-build-proof.json'
PREFLIGHT = '.deploy/production-release/' + PREFIX + '-preflight.json'
LABEL = 'id-business-v2.first-recharge-successor-projection-sha256'
ORIGIN_SCOPE = 'FIRST_RECHARGE_EXACT_PUBLISHED_COMPONENT_PAIR'


def load(name, filename):
    path = HERE / filename
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


projection = load('first_recharge_source_projection', 'first-recharge-successor-projection.py')
history = projection.history


def need(value, code):
    if not value:
        raise RuntimeError('FIRST_RECHARGE_' + code)


def native_path(d, role):
    need(role in ('api', 'admin'), 'ORIGIN_ROLE_INVALID')
    authority = history.sealed_authority() if role == 'api' else history.admin_successor_authority()
    return d.BASE / '.staging' / ('first-recharge-' + role + '-origin-'
        + authority['invocationBytesSha256']) / 'invocation.json'


def ordinary_directory(d, current, manifest):
    authority = history.sealed_authority()
    previous = Path(manifest.get('previousRelease', ''))
    need(manifest.get('previousCommit') == authority['producer']['commit']
         and previous.parent == d.BASE / 'releases' and previous.resolve() == previous
         and previous != current and not previous.is_symlink()
         and projection.digest(reused.private_bytes(previous / 'release-manifest.json'))
             == authority['manifestBytesSha256'], 'API_ORIGIN_DIRECTORY_CHANGED')
    return previous


def archived_controller(d, directory, authority, names, filename, expected_sha):
    producer = authority['producer']
    raw = d.registration_download(producer['commit'])
    files = d.registration_archive(raw, producer['commit'])
    need(projection.source_tree(files) == producer['sourceTree'], 'ORIGIN_SOURCE_TREE_CHANGED')
    for name in names:
        relative = 'scripts/production-release/' + name
        path = directory / relative
        need(path.is_file() and not path.is_symlink() and path.resolve() == path
             and files.get(relative) == (path.read_bytes(), '100755' if path.stat().st_mode & 0o111 else '100644'),
             'ORIGIN_HELPER_CHANGED')
    relative = 'scripts/production-release/' + filename
    need(projection.digest(files[relative][0]) == expected_sha, 'ORIGIN_CONTROLLER_CHANGED')
    module = ModuleType('first_recharge_authenticated_' + filename.replace('-', '_'))
    module.__file__ = str(directory / relative)
    exec(compile(files[relative][0], module.__file__, 'exec', dont_inherit=True), module.__dict__)
    return module, files, projection.digest(raw)


def component_successor_origin(evidence):
    value = evidence.get('componentSuccessorOrigin')
    fields = {'version', 'scope', 'authenticated', 'apiAuthority', 'adminAuthority', 'migration', 'databaseGrants'}
    need(type(value) is dict and set(value) == fields and type(value['version']) is int and value['version'] == 1
         and value['scope'] == ORIGIN_SCOPE and value['authenticated'] is True
         and value['apiAuthority'] == history.sealed_authority()
         and value['adminAuthority'] == history.admin_successor_authority()
         and all(evidence[n] == expected for n, expected in
             (('currentCommit', projection.ADMIN_COMMIT), ('apiCurrentSourceCommit', projection.API_COMMIT))
             if n in evidence), 'COMPONENT_PAIR_CHANGED')
    migration = value['migration']
    need(type(migration) is dict and set(migration) == {
        'name', 'sha256', 'status', 'schemaVerified', 'appliedMigrationsSha256'}
         and migration['name'] == reused.MIGRATION_NAME and migration['sha256'] == reused.MIGRATION_IDENTITY['sha256']
         and migration['status'] == 'APPLIED' and migration['schemaVerified'] is True
         and type(migration['appliedMigrationsSha256']) is str
         and re.fullmatch('[a-f0-9]{64}', migration['appliedMigrationsSha256']), 'MIGRATION_ORIGIN_CHANGED')
    grants = value['databaseGrants']
    expected = [{'grantee': "'id_business_app'@'%'", 'table': reused.MIGRATION_TABLE,
                 'privilege': n, 'grantable': 'NO'} for n in ('INSERT', 'SELECT', 'UPDATE')]
    need(type(grants) is dict and set(grants) == {
        'preservedGrantsSha256', 'schemaGrantsSha256', 'newTablePrivileges'}
         and all(type(grants[n]) is str and re.fullmatch('[a-f0-9]{64}', grants[n])
             for n in ('preservedGrantsSha256', 'schemaGrantsSha256'))
         and grants['newTablePrivileges'] == expected, 'GRANTS_ORIGIN_CHANGED')
    return value


def baseline(d, admin, workspace, expected):
    need(expected == projection.ADMIN_COMMIT, 'PREDECESSOR_CHANGED')
    api_authority, admin_authority = history.sealed_authority(), history.admin_successor_authority()
    current = (d.BASE / 'current').resolve()
    need(current.parent == d.BASE / 'releases' and not current.is_symlink(), 'CURRENT_PATH_CHANGED')
    admin_raw = reused.private_bytes(current / 'release-manifest.json')
    manifest = reused.closed_json(admin_raw)
    need(projection.digest(admin_raw) == admin_authority['manifestBytesSha256'], 'ADMIN_MANIFEST_CHANGED')
    old = ordinary_directory(d, current, manifest)
    original_prefix = projection.core.PREFIX
    ordinary_records = (reused.private_bytes(native_path(d, 'api'), cap=128 * 1024),
        reused.private_bytes(old / 'release-manifest.json'),
        reused.private_bytes(old / (original_prefix + '-build-proof.json')),
        reused.private_bytes(old / (original_prefix + '-preservation.json')))
    authenticated = history.authenticate_component_records(*ordinary_records)
    successor = history.authenticate_admin_records(reused.private_bytes(native_path(d, 'admin'), cap=128 * 1024),
        admin_raw, reused.private_bytes(current / 'admin-build-proof.json'), ordinary_records)
    _original, api_files, api_archive_sha = archived_controller(d, old, api_authority,
        projection.core.HELPERS, 'unpublished-component-successor.py', api_authority['coreSha256'])
    current_reader, _admin_files, admin_archive_sha = archived_controller(d, current, admin_authority,
        ('remote-deploy.py', 'api-admin-pending-projection.py', 'admin-pending-online-release.py',
         'unpublished-component-successor.py', 'api-admin-scope.py'),
        'admin-pending-online-release.py', admin_authority['controllerSha256'])
    # Use the exact original Admin controller, not a future seal or metadata
    # summary, for runtime images, content, source, volume and public readback.
    need(current_reader.readback(d, expected) == successor['receipt'], 'ADMIN_LIVE_READBACK_CHANGED')
    ledger = authenticated['manifest']['apiComponentPublication']
    proof, state = authenticated['proof'], authenticated['preservation']
    need(ledger['sourceArchiveSha256'] == api_archive_sha
         and ledger['sourceFilesSha256'] == projection.fingerprint(projection.inventory(api_files))
         and manifest['sourceArchiveSha256'] == admin_archive_sha, 'ORIGIN_ARCHIVE_CHANGED')
    states = workspace.snapshot(d, current)
    need(set(states) == set(reused.SERVICES)
         and all(states[n] == state['after'][n] for n in reused.SERVICES if n != 'admin')
         and states['admin']['image'] == successor['proof']['image']['imageId']
         and states['admin']['reference'] == successor['proof']['image']['reference'], 'CURRENT_SERVICES_CHANGED')
    need(not d.compose(current, 'ps', '-q', '--all', 'online-recharge'), 'ONLINE_ENGINE_PRESENT')
    images = {'api': proof['images']['api'], 'admin': successor['proof']['image']}
    for role in reused.UPDATED:
        reused.image_content(d, workspace, current, role, images[role])
    volume = workspace.workspace_volume(d, current, attached=True)
    need(volume == state['workspaceVolumeAfter'], 'WORKSPACE_VOLUME_CHANGED')
    guards = workspace.jobs_idle(d, current)
    workspace.workspace_idle(d, current, legacy=False)
    workspace.workspace_audit_protection(d, current)
    workspace.workspace_private_inspect(d, current, states['api']['reference'], volume['name'])
    origin = {'version': 1, 'scope': ORIGIN_SCOPE, 'authenticated': True,
        'apiAuthority': copy.deepcopy(api_authority), 'adminAuthority': copy.deepcopy(admin_authority),
        'migration': copy.deepcopy(authenticated['receipt']['migration']),
        'databaseGrants': copy.deepcopy(state['migration']['grantProtection'])}
    component_successor_origin({'componentSuccessorOrigin': origin})
    reused.migration_source_check(d, workspace, current, candidate=True)
    migration, grants = reused.migration_database_state(d, workspace, current), reused.grant_state(d, current, applied=True)
    need(migration == origin['migration'] and grants == origin['databaseGrants'], 'DATABASE_ORIGIN_CHANGED')
    evidence = copy.deepcopy(ledger['baseline'])
    evidence.update(currentRelease=str(current), currentCommit=expected,
        currentManifestBytesSha256=projection.digest(admin_raw),
        adminPublicationSha256=projection.fingerprint(manifest['adminPublication']),
        apiCurrentSourceCommit=projection.API_COMMIT, apiCurrentSourceTree=api_authority['producer']['sourceTree'],
        services=states, componentCurrentImages=images,
        configurationModels={n: reused.configuration_model(d, states[n]) for n in reused.UPDATED},
        configurationFilesSha256={n: projection.digest((current / n).read_bytes())
            for n in evidence['configurationFilesSha256']},
        environmentFileSha256=projection.digest(reused.private_bytes(current / '.env.aws.production')),
        workspaceVolume=volume, guards=guards, migrationState=migration, databaseGrants=grants,
        restorationBinding=None, nativeRestartBinding=None, componentSuccessorOrigin=origin)
    need(evidence['originMarkersSha256'] == projection.fingerprint({n: manifest[n] for n in admin.ORIGIN_MARKERS})
         and (d.BASE / 'current').resolve() == current
         and reused.private_bytes(current / 'release-manifest.json') == admin_raw
         and workspace.snapshot(d, current) == states, 'BASELINE_MOVED')
    return current, manifest, evidence


def source(d, producer):
    raw = d.registration_download(producer['commit'])
    need(type(raw) is bytes and 0 < len(raw) <= 128 * 1024 * 1024, 'SOURCE_ARCHIVE_INVALID')
    candidate = d.registration_archive(raw, producer['commit'])
    need(projection.source_tree(candidate) == producer['sourceTree'], 'SOURCE_TREE_CHANGED')
    for name in reused.HELPERS:
        path = HERE / name
        need(candidate.get('scripts/production-release/' + name) ==
             (path.read_bytes(), '100755' if path.stat().st_mode & 0o111 else '100644'), 'EXECUTOR_SOURCE_CHANGED')
    output, record = projection.project_sources(d, candidate, producer['commit'], producer['sourceTree'])
    projection.verify_output(output, record)
    return candidate, output, record, projection.contract()['applicationInputSha256'], projection.digest(raw)


def configure_reused():
    c = history.load_core()
    spec = projection.contract()
    for name, value in {'PREFIX': PREFIX, 'SCOPE': SCOPE, 'BUILD_SCOPE': 'FIRST_RECHARGE_BUILD',
        'TRANSPORT_SCOPE': 'FIRST_RECHARGE_PREFLIGHT_TRANSPORT', 'CONTEXT': CONTEXT,
        'PROJECTION': PROJECTION, 'PROOF': PROOF, 'PREFLIGHT': PREFLIGHT, 'LABEL': LABEL,
        'APPLICATION_SOURCE': projection.BUSINESS_COMMIT, 'APPLICATION_TREE': projection.BUSINESS_TREE,
        'APPROVED_APPLICATION_INPUT_SHA256': spec['applicationInputSha256'],
        'APPLICATION_INPUT_COUNT': spec['applicationInputCount'], 'COMPONENT_PREDECESSOR_SCOPE': ORIGIN_SCOPE,
        # The reused backup CAS consumes only the current manifest seal here.
        # This is the real Admin predecessor, not API43 or the dormant f193.
        'COMPONENT_PREDECESSOR': copy.deepcopy(history.admin_successor_authority())}.items():
        setattr(c, name, value)
    c.HELPERS = (*c.HELPERS, 'online-recharge-component-consumer.py', 'first-recharge-successor.py',
        'first-recharge-successor-readonly.py', 'first-recharge-successor-projection.py', 'first-recharge-successor-contract.json')
    c.source, c.baseline, c.component_successor_origin = source, baseline, component_successor_origin
    c.projection_module = projection.projection_module
    original_content, original_migration = c.migration_image_content, c.apply_migration
    c.migration_image_content = lambda module, output: original_content(
        module, {path[4:]: row for path, row in output.items() if path.startswith('api/')})
    def applied_readonly(d, scope, previous, target, retained=None):
        component_successor_origin({'componentSuccessorOrigin': retained})
        return original_migration(d, scope, previous, target, retained)
    c.apply_migration = applied_readonly
    return c


reused = configure_reused()


def __getattr__(name):
    return getattr(reused, name)


def cli(argv=None):
    args = list(argv if argv is not None else sys.argv[1:])
    need(bool(args) and args[0] in ('prepare', 'proof', 'preflight', 'readback', 'release', 'restore-readback'),
         'SELECTION_INVALID')
    previous = sys.argv
    try:
        sys.argv = [str(HERE / 'first-recharge-successor.py'), *args]
        return reused.cli()
    finally:
        sys.argv = previous


if __name__ == '__main__':
    try:
        print(json.dumps(cli(), sort_keys=True, separators=(',', ':')))
    except Exception as error:
        code = str(error) if re.fullmatch('(?:FIRST_RECHARGE|UNPUBLISHED_COMPONENT)_[A-Z0-9_]+', str(error)) else 'FIRST_RECHARGE_UNAVAILABLE'
        receipt = {'scope': SCOPE, 'status': 'FIRST_RECHARGE_FAILED', 'code': code,
                   'onlinePublished': False, 'migrationPerformed': False, 'businessActions': 0}
        if isinstance(error, reused.ComponentFailure):
            receipt = error.receipt
        print(json.dumps(receipt, sort_keys=True, separators=(',', ':')))
        raise SystemExit(1) from None
