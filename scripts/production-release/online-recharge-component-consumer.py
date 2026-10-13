"""Pure, finite preparation for ONLINE after an ordinary component publication.

No producer is approved until its real ended native readback is frozen below.
This module cannot switch services or issue a preflight/publication receipt. The
old workspace path is not a substitute for the missing component runtime adapter.
"""

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
from types import FunctionType


AUTHENTICATED_PREDECESSOR = {'buildProofBytesSha256': '88049211315f89ad01fc7442b934c8845995e2f1fc99f68f4bc9ae81d3ede4e0', 'commandId': '3da05719-0aa6-4258-99b1-a4aa94099377', 'coreSha256': '930c552ee5599ea0b7014426749019e257421878c9bf49fbffdf82a07627b771', 'instanceId': 'i-05836da38606e633c', 'invocationBytesSha256': 'bd6b2a4329452eb928f277efc4afefdd1987640f71a2723b66114c55123ac903', 'manifestBytesSha256': '204182bc2dee9acbd9b0f8594471fcefca69564f2b82893b5fe90d8025852f14', 'preservationRecordBytesSha256': 'b7536f91fcea303bed7e210b79437ab1cd413d88fdfec9609f991bec7f84b982', 'producer': {'commit': '43c31870c9497d900491cdb19c5f61c766f3b344', 'sourceTree': 'ede35ed238c2b0c00f536dbca25014d748637749', 'workflowRunAttempt': '1', 'workflowRunId': '38476335896'}, 'projectionSha256': '973305a109c0044194e86413a8cebfbd1dac8a7ddb741d9ffca6cfee9052e1c8', 'publicationSha256': '376f3fcd9102ea5974ef74e6ab2ef2bfa245c58680ce028df5e514ed54cf76a3', 'receiptSha256': '9bb0f721d87a41b05819fb9510c16ae6dcb786d3d956db7d92b9b722bebf456a'}
# Activation stays closed until the runtime and independent review are complete.
SEALED_ORDINARY_COMPONENT = None
KIND = 'ONLINE_RECHARGE_ORDINARY_COMPONENT'
APPLICATION_SOURCE = '28132dc776ccb94c44e243a81731f27c91ae4ed3'
APPLICATION_TREE = 'a9b0a4ea92ca6448316cd9e5ee9252950f1bacb6'
APPLICATION_COUNT = 2191
APPLICATION_SHA256 = 'c4f1c8d57580412999493e0895faf5c912611dcc8973abffeb11d5f2aae0064b'
ONLINE_SOURCE = '28a3ba4ffd17d36001b1104c97394f5ae871d73d'
ONLINE_TREE = '014959a59519da585928adaa7f76f7236e1786d1'
ONLINE_COUNT = 150
ONLINE_SHA256 = '3f2dc9ac6afe773d6d6c3a584065e213bfd435cd0198f961e837ea7d39e74473'
APP_PREFIXES = ('apps/api/', 'apps/admin/', 'packages/shared/')
APP_FILES = ('package.json', 'package-lock.json', '.dockerignore',
             'tsconfig.base.json', 'deploy/nginx/admin.conf')
ONLINE_PREFIXES = ('apps/admin/src/v2/features/online-recharge/',
                   'apps/api/src/id-business-v2/online-recharge/')
MIGRATION_ROOT = 'apps/api/prisma-mysql/migrations'
ONLINE_MIGRATION = '20261009093000_online_recharge'
PROFILE_MIGRATION = '20261012143000_recharge_connection_profiles'
MIGRATIONS = {
    ONLINE_MIGRATION: '44966182c1bf38290b01f665a4c2c863b052677c5e0024b900137f1d7f11eb95',
    PROFILE_MIGRATION: 'b382d3207ebbffc19b07d28243505ea2d1846529d49bfe906cb07fceb8c7d53e'}
SCHEMA = 'apps/api/prisma-mysql/schema.prisma'
FULL_SCHEMA_SHA256 = 'e97b583106de52768ed1408090731f272d7e73a8dc318c7af277142f937a8341'
CORE_SCHEMA_SHA256 = '2d63ec64a4d9aa40cbacfc127857124b296919142ea96318ab196aa2e4ee07f2'
BASELINE_COUNT = 47
BASELINE_SHA256 = '3baef4b2e1fcc1b1194d5ffa0197dabd09ee01a757abe7478e1f3488f8019a14'
SERVICES = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration')
PRESERVED = ('media-resolver', 'auto-recharge', 'auto-registration', 'mysql', 'caddy')
SEAL_FIELDS = frozenset(('producer', 'commandId', 'instanceId', 'invocationBytesSha256',
    'receiptSha256', 'manifestBytesSha256', 'publicationSha256', 'buildProofBytesSha256',
    'preservationRecordBytesSha256', 'projectionSha256', 'coreSha256'))


def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_RECHARGE_COMPONENT_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def fingerprint(value):
    return digest(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode())


def load_core(expected_sha256=AUTHENTICATED_PREDECESSOR['coreSha256']):
    need(type(expected_sha256) is str and re.fullmatch('[a-f0-9]{64}', expected_sha256), 'PREDECESSOR_HELPER_CHANGED')
    path = Path(__file__).with_name('unpublished-component-successor.py')
    raw = path.read_bytes()
    need(digest(raw) == expected_sha256, 'PREDECESSOR_HELPER_CHANGED')
    spec = importlib.util.spec_from_file_location('online_component_preparation_core', path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(raw, str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


def sealed_authority():
    value = SEALED_ORDINARY_COMPONENT
    need(value is not None, 'PREDECESSOR_NOT_SEALED')
    need(type(value) is dict and set(value) == SEAL_FIELDS, 'PREDECESSOR_SEAL_INVALID')
    p = value['producer']
    need(type(p) is dict and set(p) == {'commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'}
         and all(type(p[n]) is str and re.fullmatch('[a-f0-9]{40}', p[n]) for n in ('commit', 'sourceTree'))
         and all(type(p[n]) is str and re.fullmatch('[1-9][0-9]*', p[n]) for n in ('workflowRunId', 'workflowRunAttempt'))
         and type(value['commandId']) is str
         and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value['commandId'])
         and type(value['instanceId']) is str and re.fullmatch('i-[a-f0-9]{8,17}', value['instanceId'])
         and all(type(value[n]) is str and re.fullmatch('[a-f0-9]{64}', value[n])
                 for n in SEAL_FIELDS - {'producer', 'commandId', 'instanceId'}), 'PREDECESSOR_SEAL_INVALID')
    return copy.deepcopy(value)


def load_runtime():
    path = Path(__file__).with_name('online-recharge-component-runtime.py')
    spec = importlib.util.spec_from_file_location('online_component_runtime_entry', path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


def require_runtime_adapter():
    authority = sealed_authority()
    module = load_runtime()
    module.c.SEALED_ORDINARY_COMPONENT = authority
    # A reviewed runtime also has an explicit closed activation gate. This does
    # not return the old workspace publisher or its GRANT synchronization path.
    module.authority()
    return module


def validate_source_files(files):
    core = load_core()
    inventory = core.projection_module().inventory(files)
    app = {n: row for n, row in inventory.items() if n.startswith(APP_PREFIXES) or n in APP_FILES}
    online = {n: row for n, row in inventory.items() if n.startswith(ONLINE_PREFIXES)
              or n == MIGRATION_ROOT + '/' + ONLINE_MIGRATION + '/migration.sql'}
    need(len(app) == APPLICATION_COUNT and fingerprint(app) == APPLICATION_SHA256, 'APPLICATION_SOURCE_CHANGED')
    need(len(online) == ONLINE_COUNT and fingerprint(online) == ONLINE_SHA256, 'ONLINE_SOURCE_CHANGED')
    return {'applicationFileCount': len(app), 'applicationInputSha256': fingerprint(app),
            'onlineFileCount': len(online), 'onlineInputSha256': fingerprint(online)}


def prepare_source_projection(candidate, ordinary, base, online, *, commit, tree, ordinary_producer):
    """Build the exact full application; invert only the original ONLINE exclusion.

    This is an in-memory source comparison, not an executable release authority.
    Candidate and ordinary may have different control files; their complete
    approved application inventories must be identical. No old application is
    copied over the candidate, including the connection profile model/migration.
    """
    core = load_core()
    projection = core.projection_module()
    source = validate_source_files(candidate)
    validate_source_files(ordinary)
    need(projection.source_tree(candidate) == tree, 'CANDIDATE_TREE_CHANGED')
    p = core.producer(ordinary_producer['commit'], ordinary_producer['sourceTree'],
                      ordinary_producer['workflowRunId'], ordinary_producer['workflowRunAttempt'])
    need(projection.source_tree(ordinary) == p['sourceTree'], 'ORDINARY_TREE_CHANGED')
    ordinary_output, inverse = projection.project_files(ordinary, base, online, p['commit'], p['sourceTree'])
    before, after = projection.inventory(ordinary_output), projection.inventory(candidate)
    ordinary_inventory = projection.inventory(ordinary)
    app_names = {n for n in set(before) | set(after) if n.startswith(APP_PREFIXES) or n in APP_FILES}
    changed = {n for n in app_names if before.get(n) != after.get(n)}
    allowed = set(inverse['generatedFiles']) | set(inverse['removedFiles'])
    need(changed == allowed & app_names
         and all(after.get(n) == ordinary_inventory.get(n) for n in app_names),
         'APPLICATION_PROJECTION_CHANGED')
    need(digest(candidate[SCHEMA][0]) == FULL_SCHEMA_SHA256
         and digest(ordinary_output[SCHEMA][0]) == CORE_SCHEMA_SHA256
         and candidate[MIGRATION_ROOT + '/' + PROFILE_MIGRATION + '/migration.sql']
             == ordinary_output[MIGRATION_ROOT + '/' + PROFILE_MIGRATION + '/migration.sql'],
         'PROFILE_SOURCE_CHANGED')
    return dict(candidate), {'version': 1, 'kind': KIND + '_SOURCE_PREPARATION',
        'candidateCommit': commit, 'candidateTree': tree, 'ordinaryProducer': p,
        **source, 'ordinaryProjectionSha256': fingerprint(inverse),
        'ordinaryOutputFilesSha256': fingerprint(before),
        'changedApplicationFiles': sorted(changed), 'outputFilesSha256': fingerprint(after),
        'releaseAuthority': False}


def authenticate_component_records(native_raw, manifest_raw, proof_raw, preservation_raw):
    """Check the original native receipt and byte-sealed records, without I/O."""
    authority = sealed_authority()
    core = load_core(authority['coreSha256'])
    need(digest(Path(core.__file__).read_bytes()) == authority['coreSha256'], 'PREDECESSOR_HELPER_CHANGED')
    need(digest(native_raw) == authority['invocationBytesSha256'], 'NATIVE_CHANGED')
    _invocation, receipt = core.validate_invocation(native_raw, authority['commandId'], authority['instanceId'])
    p = authority['producer']
    need(fingerprint(receipt) == authority['receiptSha256']
         and type(receipt.get('version')) is int and receipt['version'] == 1
         and receipt.get('scope') == core.SCOPE and receipt.get('status') == 'UNPUBLISHED_COMPONENT_VERIFIED'
         and receipt.get('commit') == p['commit'] and receipt.get('sourceTree') == p['sourceTree']
         and receipt.get('servicesUpdated') == ['api', 'admin']
         and type(receipt.get('preservedServiceCount')) is int and receipt['preservedServiceCount'] == len(PRESERVED)
         and receipt.get('onlinePublished') is False and receipt.get('runningImagesAndContentMatched') is True
         and receipt.get('databaseOldGrantsPreserved') is True and receipt.get('volumeDeletionPerformed') is False
         and type(receipt.get('businessActions')) is int and receipt['businessActions'] == 0,
         'NATIVE_RECEIPT_CHANGED')
    for raw, name in ((manifest_raw, 'manifestBytesSha256'), (proof_raw, 'buildProofBytesSha256'),
                      (preservation_raw, 'preservationRecordBytesSha256')):
        need(digest(raw) == authority[name] and receipt.get(name) == authority[name], 'RECORD_BYTES_CHANGED')
    manifest, proof, state = (core.closed_json(raw) for raw in (manifest_raw, proof_raw, preservation_raw))
    ledger = manifest.get('apiComponentPublication', {})
    need(manifest.get('commit') == p['commit'] and manifest.get('sourceTree') == p['sourceTree']
         and ledger.get('producer') == p and ledger.get('scope') == core.SCOPE
         and ledger.get('onlinePublished') is False
         and fingerprint(ledger) == authority['publicationSha256'] == receipt.get('publicationSha256')
         and fingerprint(proof.get('projection')) == authority['projectionSha256'] == receipt.get('projectionSha256'),
         'PUBLICATION_CHANGED')
    need(type(state.get('before')) is dict and type(state.get('after')) is dict
         and set(state['before']) == set(state['after']) == set(SERVICES)
         and all(state['before'][n] == state['after'][n] for n in PRESERVED), 'PRESERVED_SERVICES_CHANGED')
    need(state.get('migration', {}).get('performed') is False
         and state['migration'].get('grants') == {'status': 'EXISTING_GRANTS_READONLY_VERIFIED', 'mutationPerformed': False}
         and ledger.get('migrationPerformed') is False and ledger.get('databaseGrantsChanged') is False
         and manifest.get('newMigrations') == [], 'PREDECESSOR_DATABASE_WRITES_CHANGED')
    grants = state['migration'].get('grantProtection')
    need(type(grants) is dict and set(grants) == {'preservedGrantsSha256', 'schemaGrantsSha256', 'newTablePrivileges'}
         and all(type(grants[n]) is str and re.fullmatch('[a-f0-9]{64}', grants[n])
                 for n in ('preservedGrantsSha256', 'schemaGrantsSha256'))
         and grants['newTablePrivileges'] == [{'grantee': "'id_business_app'@'%'",
             'table': 'id_business_v2_recharge_connection_profiles', 'privilege': privilege, 'grantable': 'NO'}
             for privilege in ('INSERT', 'SELECT', 'UPDATE')], 'PREDECESSOR_GRANTS_INVALID')
    # A later live adapter must execute the byte-authenticated original controller
    # and compare its entire native readback, SQLite/backup/idle/runtime evidence.
    # This return deliberately grants no preflight or deployment authority.
    return {'receipt': receipt, 'manifest': manifest, 'proof': proof, 'preservation': state,
            'releaseAuthority': False}


def migration_source_check(d, workspace, directory, *, candidate=True):
    rows = dict(workspace.migration_files(d, directory))
    for name, sha in MIGRATIONS.items():
        need(rows.pop(name + '/migration.sql', None) == sha, 'MIGRATION_SOURCE_CHANGED')
    need(len(rows) == BASELINE_COUNT and fingerprint(rows) == BASELINE_SHA256, 'MIGRATION_HISTORY_CHANGED')
    schema = Path(directory) / SCHEMA
    need(type(candidate) is bool and schema.is_file() and not schema.is_symlink()
         and digest(schema.read_bytes()) == (FULL_SCHEMA_SHA256 if candidate else CORE_SCHEMA_SHA256),
         'MIGRATION_SCHEMA_CHANGED')
    return {**rows, **{name + '/migration.sql': sha for name, sha in MIGRATIONS.items()}}


def validate_online_metadata(value, files, expected_schema):
    need(type(value) is dict and set(value) == {'rows', 'tables', 'columns', 'indexes'}
         and type(value['rows']) is list and len(value['rows']) < 200, 'MIGRATION_METADATA_INVALID')
    expected = {n.split('/')[0]: sha for n, sha in files.items() if n.endswith('/migration.sql')}
    completed = {}
    for row in value['rows']:
        need(type(row) is dict and set(row) == {'name', 'checksum', 'finished', 'rolledBack'}
             and row['name'] in expected and row['checksum'] == expected[row['name']]
             and all(type(row[n]) in (bool, int) and row[n] in (0, 1) for n in ('finished', 'rolledBack'))
             and row['finished'] + row['rolledBack'] == 1, 'MIGRATION_HISTORY_CHANGED')
        if row['finished']:
            need(row['name'] not in completed, 'MIGRATION_HISTORY_CHANGED')
            completed[row['name']] = row['checksum']
    need(completed == expected and all(completed.get(n) == sha for n, sha in MIGRATIONS.items()),
         'MIGRATION_NOT_APPLIED')
    columns = copy.deepcopy(value['columns'])
    for row in columns if type(columns) is list else []:
        if row.get('type') in ('datetime', 'timestamp') and type(row.get('default')) is str:
            row['default'] = row['default'].lower()
    for field, actual, key in (('tables', value['tables'], lambda r: r['name']),
          ('columns', columns, lambda r: (r['table'], r['column'])),
          ('indexes', value['indexes'], lambda r: (r['table'], r['index'], r['sequence']))):
        need(type(actual) is list and sorted(actual, key=key) == expected_schema[field], 'ONLINE_SCHEMA_CHANGED')
    return {'name': ONLINE_MIGRATION, 'sha256': MIGRATIONS[ONLINE_MIGRATION], 'status': 'APPLIED',
            'schemaVerified': True, 'appliedMigrationsSha256': fingerprint(completed)}


def union_schema_expectation(d, online_scope, workspace, directory, *, candidate=True):
    """Keep the old SQL parser unchanged; isolate only the new source guard."""
    original = online_scope.schema_expectation
    namespace = {**original.__globals__, 'migration_source_check':
        lambda controller, source: migration_source_check(controller, workspace, source, candidate=candidate)}
    parser = FunctionType(original.__code__, namespace, original.__name__, original.__defaults__, original.__closure__)
    return parser(d, directory)


def verify_applied_database(d, online_scope, workspace, directory, *, predecessor_records, migration_plan, source_candidate=True):
    """Read only both existing migrations; never call apply/grant synchronization."""
    authority = sealed_authority()  # Refuse before any SQL even when invoked outside the entry.
    need(type(migration_plan) is list and migration_plan == [], 'MIGRATION_PLAN_NOT_EMPTY')
    need(type(predecessor_records) is tuple and len(predecessor_records) == 4
         and all(type(raw) is bytes for raw in predecessor_records), 'PREDECESSOR_RECORDS_INVALID')
    records = authenticate_component_records(*predecessor_records)
    grants_before = records['preservation']['migration']['grantProtection']
    files = migration_source_check(d, workspace, directory, candidate=source_candidate)
    names = ','.join("'" + name + "'" for name in online_scope.TABLES)
    query = """SELECT JSON_OBJECT('rows', (SELECT JSON_ARRAYAGG(JSON_OBJECT(
        'name',migration_name,'checksum',checksum,'finished',finished_at IS NOT NULL,
        'rolledBack',rolled_back_at IS NOT NULL)) FROM _prisma_migrations),
        'tables', (SELECT JSON_ARRAYAGG(JSON_OBJECT('name',TABLE_NAME,'engine',ENGINE,'collation',TABLE_COLLATION))
        FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (__NAMES__)),
        'columns', (SELECT JSON_ARRAYAGG(JSON_OBJECT('table',TABLE_NAME,'column',COLUMN_NAME,'type',DATA_TYPE,
        'columnType',COLUMN_TYPE,'nullable',IS_NULLABLE,'default',COLUMN_DEFAULT,'extra',EXTRA))
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (__NAMES__)),
        'indexes', (SELECT JSON_ARRAYAGG(JSON_OBJECT('table',TABLE_NAME,'index',INDEX_NAME,'column',COLUMN_NAME,
        'sequence',SEQ_IN_INDEX,'nonUnique',NON_UNIQUE,'type',INDEX_TYPE,'prefix',SUB_PART))
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (__NAMES__)))""".replace('__NAMES__', names)
    online = validate_online_metadata(online_scope.database_read(d, directory, query), files,
                                     union_schema_expectation(d, online_scope, workspace, directory, candidate=source_candidate))
    core = load_core(authority['coreSha256'])
    profile = core.migration_database_state(d, workspace, directory)
    need(profile['status'] == 'APPLIED' and profile['schemaVerified'] is True
         and profile['appliedMigrationsSha256'] == online['appliedMigrationsSha256'], 'PROFILE_NOT_APPLIED')
    grants = core.grant_state(d, directory, applied=True)
    need(grants == grants_before, 'DATABASE_GRANTS_CHANGED')
    return {'online': online, 'connectionProfile': profile, 'migrationPlan': [],
            'migrationPerformed': False, 'databaseGrantsChanged': False, 'databaseGrants': grants}
