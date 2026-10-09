"""Finite first publication of online recharge; never selects the legacy workers.

The shared controller supplies the unchanged lock, strict 49-rule audit, verified
MySQL/S3 backup and Docker helpers. This module does not register another scope
inside those controllers and does not run when imported. Production callers must
select this scope explicitly. Its first predecessor is the approved main SHA.
"""
import base64
import copy
from contextlib import closing
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import sqlite3
import stat
import subprocess
import tarfile
import time
from types import SimpleNamespace
import urllib.request

SCOPE = 'ONLINE_RECHARGE'
BASELINE_COMMIT = '0a03fa28e6b844a18833d5c63f1de700f091fc64'
UPDATED = ('api', 'admin', 'online-recharge')
IMAGE_SERVICES = ('api', 'admin', 'online-recharge', 'migrate')
SWITCH_ORDER = ('admin', 'api', 'online-recharge')
PRESERVED = ('media-resolver', 'auto-recharge', 'auto-registration', 'mysql', 'caddy')
PROOF_FILE = 'online-recharge-build-proof.json'
STATE_FILE = 'online-recharge-preservation.json'
FAILURE_FILE = 'online-recharge-failure.json'
WORKSPACE_BACKUP_FILE = 'online-recharge-workspace-backup.json'
MIGRATION_NAME = '20261009093000_online_recharge'
MIGRATION_FILE = MIGRATION_NAME + '/migration.sql'
MIGRATION_ROOT = 'apps/api/prisma-mysql/migrations'
SCHEMA_FILE = 'apps/api/prisma-mysql/schema.prisma'
SEED_FILE = 'apps/api/prisma-mysql/seed.ts'
ENGINE_ROOT = 'apps/api/src/id-business-v2/online-recharge/engine'
ENGINE_IMAGE_ROOT = '/workspace/engine'
MEDIA_VOLUME = 'online_recharge_data'
API_VOLUME_PATH = '/app/.runtime/online-recharge'
ENGINE_VOLUME_PATH = '/workspace/engine/runtime'
API_MEDIA_PATH = '/app/.runtime/online-recharge/artifacts'
ENGINE_MEDIA_PATH = '/workspace/engine/runtime/media'
MIGRATION_IDENTITY = {
    'name': MIGRATION_NAME,
    'sha256': '44966182c1bf38290b01f665a4c2c863b052677c5e0024b900137f1d7f11eb95',
    'baselineFileCount': 47,
    'baselineFilesSha256': '3baef4b2e1fcc1b1194d5ffa0197dabd09ee01a757abe7478e1f3488f8019a14',
    'schemaBeforeSha256': '8006d3ce6f0b44cf62f3b47bb7b4a0b14d0ddc18ddf113a5da34a901b62fb197',
    'schemaAfterSha256': '8ae09e883e79bfb85cd65edbf630f2ec03b6b397eb46d172b4c4f05514b715a7',
    'seedBeforeSha256': 'ac9940a7977def1ed6eaad38ed154d81963ce6e877f02ffc07234fa61591096b',
    'seedAfterSha256': '2a7becbe8da189adad73b30d7bfe36070fd44ae4f683f7e4a01178d14ae08b5b',
}
TABLES = tuple('online_recharge_' + n for n in (
    'config', 'cards', 'proxies', 'addresses', 'codes', 'tasks', 'events', 'bills', 'webhook_receipts'))
ENV_DEFAULTS = {
    'ONLINE_RECHARGE_RPC_URL': 'http://127.0.0.1:3000/api/id-business-v2/online-recharge/worker/rpc',
    'ONLINE_RECHARGE_CREDENTIALS_URL': 'http://127.0.0.1:8053',
    'ONLINE_RECHARGE_RUNTIME_DIR': '/workspace/engine/runtime',
    'ONLINE_RECHARGE_MEDIA_DIR': ENGINE_MEDIA_PATH,
    'ONLINE_RECHARGE_ARTIFACT_DIR': API_MEDIA_PATH,
    'ONLINE_RECHARGE_ENGINE_ENABLED': '1',
}
ENV_KEYS = frozenset((*ENV_DEFAULTS, 'ONLINE_RECHARGE_WORKER_KEY'))
CONTROL_FILES = ('scripts/production-release/online-recharge-scope.py',
                 'scripts/production-release/api-admin-scope.py',
                 'scripts/production-release/remote-deploy.py')
RECOVERY_FILE = 'online-recharge-recovery.json'
RECOVERY_POLICY_SHA256 = '641fe690c62224eb3d22d69e94493e08b9a2a9309ce04c588627c4aaea7c8f35'
ORIGINAL_RECOVERY_POLICY_SHA256 = '7600c0ed6173896824a9def8857eccbc9f99b41b62290fde6a061e2ab63b756c'
RECOVERY_COMMIT = '28a3ba4ffd17d36001b1104c97394f5ae871d73d'
RECOVERY_TREE = '014959a59519da585928adaa7f76f7236e1786d1'
RECOVERY_RUN = '37933246605'
RECOVERY_ATTEMPT = '1'
RECOVERY_COMMAND = 'ab33d2e0-6135-47ed-8f20-e2defd7c82cd'
RECOVERY_FAILURE_SHA256 = '1959377acd78e7160fec0f85666982d4ea4efbb40dab199b7dcc04ba288ddd5a'
RECOVERY_PROOF_SHA256 = 'ae6a32418e0a0d4ff3d799e3416cf27a150fd1bd925dd91cfa09b56c30e0ffff'
RECOVERY_PREFLIGHT_SHA256 = '212b6c36d98e003d551284342ddd1c4e468018ff0febc85caff4aee6481e83d4'
RESTORED_COMMIT = '296c096af7c4c79a8ffc2f57d9a15ea75684f431'
RESTORED_TREE = '472947076a5b5fb73d6777413505d60ac2379fb1'
RESTORED_RUN = '37944613453'
RESTORED_ATTEMPT = '1'
RESTORED_COMMAND = 'ac5c9f85-e813-499c-8e90-92c1ce011bfa'
RESTORED_FAILURE_SHA256 = 'f04e9356221bc10a33c774ce9e692b40db6afa23fd2a3bde23caf096a4f07485'
RESTORED_PROOF_SHA256 = 'f3eabbd5962011d238ba7323814fb8c14d0007228f9bbb21f02c755fe0171825'
RESTORED_PREFLIGHT_SHA256 = 'b3ff3b000e5b8824e7422cf7eaf2323444d1467361efabc84767a3f21b1e8df7'
GRANT_SOURCE = 'scripts/lib/v2-production-database-access.mjs'
RECOVERY_DELETE_TABLES = ('online_recharge_bills', 'online_recharge_cards', 'online_recharge_proxies')
RECOVERY_ALLOWED_FILES = frozenset((
    'scripts/production-release/online-recharge-scope.py',
    'scripts/production-release/online-recharge-scope.test.py',
    'scripts/production-release/online-recharge-readonly.py',
    'scripts/production-release/online-recharge-readonly.test.py',
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/remote-deploy.test.py',
    'scripts/production-release/online-recharge-recovery.json',
    'scripts/production-release/dispatch.sh',
    'scripts/production-release/online-recharge-entry.test.mjs',
    GRANT_SOURCE, 'scripts/production-database-access.test.mjs',
    'scripts/ci-recharge-scope.mjs', 'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-check.mjs', 'scripts/ci-recharge-check.test.mjs',
    'docs/ONLINE_RECHARGE.md', 'docs/ONLINE_RECHARGE_RELEASE_20261009.md',
))
RECOVERY_GENERATED_FILES = frozenset(('.env.aws.production', 'compose.release.json', 'before-audit.json',
    'backup-verification.json', WORKSPACE_BACKUP_FILE, FAILURE_FILE))
SERVICE_IDENTITY_KEYS = ('status', 'health', 'image', 'reference', 'containerId', 'startedAtSha256',
                         'environmentSha256', 'configurationSha256')
PROJECTION_REASONS = frozenset(('NOT_PROBED', 'INSPECT_FAILED', 'INPUT_INVALID', 'METADATA_MISMATCH',
    'HOSTNAME_MISMATCH', 'RAW_HASH_MISMATCH', 'COMPOSE_LABELS_MISMATCH', 'NAME_MISMATCH',
    'REPLACE_MISMATCH', 'PROJECTED_HASH_MISMATCH', 'PROJECTED_HASH_AMBIGUOUS', 'MATCH', 'OTHER'))


class ProjectionRejection(RuntimeError):
    def __init__(self, reason):
        self.reason = reason
        super().__init__('ONLINE_RECHARGE_CONTAINER_CHANGED')


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def legacy(d):
    return d.api_admin_scope('API_ADMIN_WORKSPACE')[0]


def migration_source_check(d, directory, *, candidate=True):
    rows = legacy(d).migration_files(d, directory)
    added = rows.pop(MIGRATION_FILE, None)
    schema = directory / SCHEMA_FILE
    seed = directory / SEED_FILE
    d.require(schema.is_file() and not schema.is_symlink() and seed.is_file() and not seed.is_symlink(),
              'ONLINE_RECHARGE_MIGRATION_SOURCE_INVALID')
    d.require(len(rows) == MIGRATION_IDENTITY['baselineFileCount']
              and fingerprint(rows) == MIGRATION_IDENTITY['baselineFilesSha256']
              and hashlib.sha256(seed.read_bytes()).hexdigest() == MIGRATION_IDENTITY[
                  'seedAfterSha256' if candidate else 'seedBeforeSha256']
              and added == (MIGRATION_IDENTITY['sha256'] if candidate else None)
              and hashlib.sha256(schema.read_bytes()).hexdigest() == MIGRATION_IDENTITY[
                  'schemaAfterSha256' if candidate else 'schemaBeforeSha256'],
              'ONLINE_RECHARGE_MIGRATION_SCOPE_CHANGED')
    if candidate:
        text = (directory / MIGRATION_ROOT / MIGRATION_FILE).read_text()
        d.require(tuple(re.findall(r'CREATE TABLE `([a-z0-9_]+)`', text)) == TABLES
                  and not re.search(r'\b(?:DROP|TRUNCATE|ALTER|GRANT|REVOKE|DELETE)\b', text, re.I),
                  'ONLINE_RECHARGE_MIGRATION_SCOPE_CHANGED')
    return dict(MIGRATION_IDENTITY)


def schema_expectation(d, directory):
    """Derive complete column/index evidence from the sealed additive migration."""
    migration_source_check(d, directory)
    sql = (directory / MIGRATION_ROOT / MIGRATION_FILE).read_text()
    columns, indexes = [], []
    for table, body in re.findall(r'CREATE TABLE `([a-z0-9_]+)` \(\n(.*?)\n\) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;', sql, re.S):
        for name, definition in re.findall(r'^    `([^`]+)` (.+?)(?:,)?$', body, re.M):
            definition = definition.rstrip(',')
            datatype = re.match(r"(?:ENUM\([^)]*\)|DECIMAL\([^)]*\)|[A-Z]+(?:\([0-9]+\))?)", definition).group()
            column_type = re.sub(r'\s+', '', datatype.lower().replace('integer', 'int').replace('boolean', 'tinyint(1)'))
            kind = column_type.split('(')[0]
            default = re.search(r"\bDEFAULT (CURRENT_TIMESTAMP\(6\)|true|false|[0-9]+|'[^']*')", definition)
            value = default.group(1) if default else None
            if value in ('true', 'false'):
                value = '1' if value == 'true' else '0'
            elif value and value.startswith("'"):
                value = value[1:-1]
            elif value:
                value = value.lower()
            columns.append({'table': table, 'column': name, 'type': kind, 'columnType': column_type,
                            'nullable': 'NO' if 'NOT NULL' in definition else 'YES', 'default': value,
                            'extra': 'DEFAULT_GENERATED' if value == 'current_timestamp(6)' else ''})
        for unique, index, names in re.findall(r'^    (UNIQUE INDEX|INDEX) `([^`]+)`\(([^)]+)\)', body, re.M):
            for sequence, name in enumerate(re.findall(r'`([^`]+)`', names), 1):
                indexes.append({'table': table, 'index': index, 'column': name, 'sequence': sequence,
                                'nonUnique': 0 if unique == 'UNIQUE INDEX' else 1, 'type': 'BTREE', 'prefix': None})
        primary = re.search(r'PRIMARY KEY \(([^)]+)\)', body)
        d.require(primary is not None, 'ONLINE_RECHARGE_MIGRATION_SCHEMA_INVALID')
        for sequence, name in enumerate(re.findall(r'`([^`]+)`', primary.group(1)), 1):
            indexes.append({'table': table, 'index': 'PRIMARY', 'column': name, 'sequence': sequence,
                            'nonUnique': 0, 'type': 'BTREE', 'prefix': None})
    d.require({r['table'] for r in columns} == set(TABLES), 'ONLINE_RECHARGE_MIGRATION_SCHEMA_INVALID')
    return {'tables': [{'name': n, 'engine': 'InnoDB', 'collation': 'utf8mb4_unicode_ci'} for n in sorted(TABLES)],
            'columns': sorted(columns, key=lambda r: (r['table'], r['column'])),
            'indexes': sorted(indexes, key=lambda r: (r['table'], r['index'], r['sequence']))}


def database_read(d, directory, query):
    d.require(isinstance(query, str) and 0 < len(query.encode()) <= 128 * 1024,
              'ONLINE_RECHARGE_DATABASE_RESPONSE_INVALID')
    database = d.current_job_database(directory)
    raw = d.compose(directory, 'exec', '-e', 'MYSQL_DATABASE=' + database, '-T', 'mysql', 'sh', '-c',
        'exec mysql --batch --raw --skip-column-names -u root --password="$MYSQL_ROOT_PASSWORD" '
        '"$MYSQL_DATABASE"', input_data=query + '\n', timeout=60)
    d.require(len(raw) < 1024 * 1024, 'ONLINE_RECHARGE_DATABASE_RESPONSE_INVALID')
    return json.loads(raw)


def migration_database_state(d, directory, *, source=None):
    source = directory if source is None else source
    migration_source_check(d, source, candidate=(source / MIGRATION_ROOT / MIGRATION_FILE).is_file())
    rows = legacy(d).migration_files(d, source)
    baseline = {n.split('/')[0]: digest for n, digest in rows.items() if n.endswith('/migration.sql')}
    baseline[MIGRATION_NAME] = MIGRATION_IDENTITY['sha256']
    names = ','.join("'" + n + "'" for n in TABLES)
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
    value = database_read(d, directory, query)
    d.require(isinstance(value, dict) and set(value) == {'rows', 'tables', 'columns', 'indexes'}
              and isinstance(value['rows'], list) and len(value['rows']) < 200,
              'ONLINE_RECHARGE_MIGRATION_DATABASE_INVALID')
    completed = {}
    for row in value['rows']:
        d.require(isinstance(row, dict) and set(row) == {'name', 'checksum', 'finished', 'rolledBack'}
                  and row['name'] in baseline and row['checksum'] == baseline[row['name']]
                  and all(type(row[n]) in (bool, int) and row[n] in (0, 1) for n in ('finished', 'rolledBack'))
                  and row['finished'] + row['rolledBack'] == 1,
                  'ONLINE_RECHARGE_MIGRATION_HISTORY_CHANGED')
        if row['finished']:
            d.require(row['name'] not in completed, 'ONLINE_RECHARGE_MIGRATION_HISTORY_CHANGED')
            completed[row['name']] = row['checksum']
    applied = MIGRATION_NAME in completed
    d.require(set(completed) == (set(baseline) if applied else set(baseline) - {MIGRATION_NAME}),
              'ONLINE_RECHARGE_MIGRATION_HISTORY_CHANGED')
    if applied:
        expected = schema_expectation(d, source)
        for row in value['columns'] if isinstance(value['columns'], list) else []:
            if row.get('type') in ('datetime', 'timestamp') and isinstance(row.get('default'), str):
                row['default'] = row['default'].lower()
        for field, key in (('tables', lambda r: r['name']), ('columns', lambda r: (r['table'], r['column'])),
                           ('indexes', lambda r: (r['table'], r['index'], r['sequence']))):
            d.require(isinstance(value[field], list) and sorted(value[field], key=key) == expected[field],
                      'ONLINE_RECHARGE_MIGRATION_SCHEMA_CHANGED')
    else:
        d.require(all(value[n] in (None, []) for n in ('tables', 'columns', 'indexes')),
                  'ONLINE_RECHARGE_MIGRATION_PARTIAL_SCHEMA')
    return {'name': MIGRATION_NAME, 'sha256': MIGRATION_IDENTITY['sha256'],
            'status': 'APPLIED' if applied else 'PENDING', 'schemaVerified': True,
            'appliedMigrationsSha256': fingerprint(completed)}


def historical_controller(d, directory, source):
    """A finite reader for the prior quick-action origin after this migration.

    First verify the complete database history and all nine new tables. Only the
    one new, checksum-verified row is omitted from the old reader's history view;
    no old row, schema field, task/HMAC, image or backup evidence is altered.
    """
    migration_database_state(d, directory, source=source)
    proxy = SimpleNamespace(**vars(d))

    def compose(folder, *args, **kwargs):
        raw = d.compose(folder, *args, **kwargs)
        query = args[-1] if args else ''
        if (isinstance(query, str) and "TABLE_NAME='id_business_v2_quick_actions'" in query
                and 'FROM _prisma_migrations' in query):
            value = json.loads(raw)
            d.require(set(value) == {'rows', 'columns', 'indexes'} and isinstance(value['rows'], list),
                      'ONLINE_RECHARGE_HISTORY_VIEW_INVALID')
            added = [r for r in value['rows'] if r.get('name') == MIGRATION_NAME]
            d.require(len(added) <= 1 and all(r.get('checksum') == MIGRATION_IDENTITY['sha256']
                      and r.get('finished') in (True, 1) and r.get('rolledBack') in (False, 0) for r in added),
                      'ONLINE_RECHARGE_HISTORY_VIEW_INVALID')
            value['rows'] = [r for r in value['rows'] if r.get('name') != MIGRATION_NAME]
            return json.dumps(value)
        return raw

    proxy.compose = compose
    return proxy


def historical_guard(d, previous, evidence, source):
    origin = evidence.get('migrationOrigin')
    if origin is not None:
        legacy(d).migration_successor_guard(historical_controller(d, previous, source), previous, origin)


def closed_recovery_json(d, raw):
    d.require(isinstance(raw, bytes) and 0 < len(raw) <= 256 * 1024, 'ONLINE_RECHARGE_INPUT_INVALID')
    def unique(items):
        value = {}
        for key, item in items:
            d.require(key not in value, 'ONLINE_RECHARGE_INPUT_INVALID')
            value[key] = item
        return value
    try:
        return json.loads(raw, object_pairs_hook=unique)
    except (ValueError, UnicodeError):
        raise RuntimeError('ONLINE_RECHARGE_INPUT_INVALID') from None


def recovery_policy(d):
    path = Path(__file__).with_name(RECOVERY_FILE)
    d.require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 256 * 1024,
              'ONLINE_RECHARGE_INPUT_INVALID')
    value = closed_recovery_json(d, path.read_bytes())
    fields = {'version', 'scope', 'previousCommit', 'failedCommit', 'failedSourceTree', 'failedWorkflowRunId',
              'failedWorkflowRunAttempt', 'failedCommandId', 'failureReceiptSha256', 'buildProof', 'preflight',
              'sharedGrant', 'candidateAllowedFiles', 'restoredAttempt'}
    d.require(isinstance(value, dict) and set(value) == fields and type(value['version']) is int
              and value['version'] == 1 and value['scope'] == 'ONLINE_RECHARGE_RECOVERY'
              and fingerprint(value) == RECOVERY_POLICY_SHA256
              and value['previousCommit'] == BASELINE_COMMIT and value['failedCommit'] == RECOVERY_COMMIT
              and value['failedSourceTree'] == RECOVERY_TREE and value['failedWorkflowRunId'] == RECOVERY_RUN
              and value['failedWorkflowRunAttempt'] == RECOVERY_ATTEMPT and value['failedCommandId'] == RECOVERY_COMMAND
              and value['failureReceiptSha256'] == RECOVERY_FAILURE_SHA256,
              'ONLINE_RECHARGE_INPUT_INVALID')
    allowed = value['candidateAllowedFiles']
    grant = value['sharedGrant']
    d.require(isinstance(allowed, list) and all(isinstance(n, str) for n in allowed)
              and len(allowed) == len(set(allowed)) and set(allowed) <= RECOVERY_ALLOWED_FILES
              and isinstance(grant, dict) and set(grant) == {'path', 'beforeSha256', 'afterSha256', 'addedDeleteTables'}
              and grant['path'] == GRANT_SOURCE and grant['addedDeleteTables'] == list(RECOVERY_DELETE_TABLES)
              and all(re.fullmatch(r'[a-f0-9]{64}', grant[n] or '') for n in ('beforeSha256', 'afterSha256')),
              'ONLINE_RECHARGE_INPUT_INVALID')
    proof = validate_proof(d, value['buildProof'], RECOVERY_COMMIT, RECOVERY_TREE,
                          '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release',
                          RECOVERY_RUN, RECOVERY_ATTEMPT)
    before = value['preflight']
    d.require(fingerprint(proof) == RECOVERY_PROOF_SHA256 and isinstance(before, dict)
              and fingerprint(before) == RECOVERY_PREFLIGHT_SHA256
              and before.get('status') == 'ONLINE_RECHARGE_BASELINE_VERIFIED'
              and before.get('commit') == BASELINE_COMMIT and before.get('releaseCandidateCommit') == RECOVERY_COMMIT
              and before.get('workflowRunId') == RECOVERY_RUN and before.get('workflowRunAttempt') == RECOVERY_ATTEMPT
              and before.get('checkCount') == 49 and before.get('violationCount') == 0
              and before.get('migration') == MIGRATION_IDENTITY and before.get('workspaceIdle') is True
              and before.get('workspaceVolumePreserved') is True and before.get('legacyWorkersPreserved') is True,
              'ONLINE_RECHARGE_READBACK_PROVENANCE_CHANGED')
    restored = value['restoredAttempt']
    d.require(isinstance(restored, dict) and set(restored) == {'version', 'commit', 'sourceTree',
              'workflowRunId', 'workflowRunAttempt', 'commandId', 'failureReceiptSha256', 'buildProof', 'preflight'}
              and type(restored['version']) is int and restored['version'] == 1
              and restored['commit'] == RESTORED_COMMIT and restored['sourceTree'] == RESTORED_TREE
              and restored['workflowRunId'] == RESTORED_RUN and restored['workflowRunAttempt'] == RESTORED_ATTEMPT
              and restored['commandId'] == RESTORED_COMMAND and restored['failureReceiptSha256'] == RESTORED_FAILURE_SHA256
              and fingerprint({k: v for k, v in value.items() if k != 'restoredAttempt'}) == ORIGINAL_RECOVERY_POLICY_SHA256,
              'ONLINE_RECHARGE_INPUT_INVALID')
    restored_proof = validate_proof(d, restored['buildProof'], RESTORED_COMMIT, RESTORED_TREE,
        '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release', RESTORED_RUN, RESTORED_ATTEMPT)
    restored_before = restored['preflight']
    d.require(fingerprint(restored_proof) == RESTORED_PROOF_SHA256 and isinstance(restored_before, dict)
              and fingerprint(restored_before) == RESTORED_PREFLIGHT_SHA256
              and restored_before == {**before, 'releaseCandidateCommit': RESTORED_COMMIT,
                  'workflowRunId': RESTORED_RUN, 'workflowRunAttempt': RESTORED_ATTEMPT,
                  'migrationRecovery': original_recovery_marker(value), 'migrationPerformed': False},
              'ONLINE_RECHARGE_READBACK_PROVENANCE_CHANGED')
    return value


def original_recovery_marker(policy):
    return {'version': 1, 'failedCommit': RECOVERY_COMMIT, 'failedSourceTree': RECOVERY_TREE,
            'failedWorkflowRunId': RECOVERY_RUN, 'failedWorkflowRunAttempt': RECOVERY_ATTEMPT,
            'failedCommandId': RECOVERY_COMMAND, 'failureReceiptSha256': RECOVERY_FAILURE_SHA256,
            'buildProofSha256': RECOVERY_PROOF_SHA256, 'preflightSha256': RECOVERY_PREFLIGHT_SHA256,
            'policySha256': fingerprint({k: v for k, v in policy.items() if k != 'restoredAttempt'})}


def recovery_marker(policy):
    restored = policy['restoredAttempt']
    return {**original_recovery_marker(policy), 'policySha256': fingerprint(policy),
            'restoredAttempt': {n: restored[n] for n in ('version', 'commit', 'sourceTree', 'workflowRunId',
                'workflowRunAttempt', 'commandId', 'failureReceiptSha256')} | {
                'buildProofSha256': fingerprint(restored['buildProof']),
                'preflightSha256': fingerprint(restored['preflight'])}}


def archive_inventory(d, data, commit, tree):
    """Verify the immutable Git tree before trusting any failed-release source file."""
    d.require(isinstance(data, bytes) and len(data) <= 128 * 1024 * 1024, 'ONLINE_RECHARGE_SOURCE_TOO_LARGE')
    inventory, entries = {}, {}
    prefix = 'id-business-system-' + commit + '/'
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            members = archive.getmembers()
            d.require(len(members) < 100000 and sum(m.size for m in members) < 512 * 1024 * 1024,
                      'ONLINE_RECHARGE_SOURCE_ARCHIVE_INVALID')
            for member in members:
                d.require((member.name == prefix[:-1] or member.name.startswith(prefix))
                          and '..' not in Path(member.name).parts and (member.isfile() or member.isdir()),
                          'ONLINE_RECHARGE_SOURCE_ARCHIVE_INVALID')
                if member.isdir():
                    continue
                name = member.name[len(prefix):]
                d.require(name and name not in inventory and member.size <= 16 * 1024 * 1024,
                          'ONLINE_RECHARGE_SOURCE_ARCHIVE_INVALID')
                raw = archive.extractfile(member).read()
                mode = '100755' if member.mode & 0o111 else '100644'
                inventory[name] = {'sha256': hashlib.sha256(raw).hexdigest(), 'mode': mode}
                parent = entries
                for part in Path(name).parts[:-1]:
                    d.require(part not in parent or isinstance(parent[part], dict), 'ONLINE_RECHARGE_SOURCE_ARCHIVE_INVALID')
                    parent = parent.setdefault(part, {})
                d.require(Path(name).name not in parent, 'ONLINE_RECHARGE_SOURCE_ARCHIVE_INVALID')
                parent[Path(name).name] = (mode, hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).digest())
    except (tarfile.TarError, OSError):
        raise RuntimeError('ONLINE_RECHARGE_SOURCE_ARCHIVE_INVALID') from None
    def encode(items):
        raw = b''
        for name, value in sorted(items.items(), key=lambda item: (item[0] + '/' if isinstance(item[1], dict) else item[0]).encode()):
            mode, oid = ('40000', encode(value)) if isinstance(value, dict) else value
            raw += mode.encode() + b' ' + name.encode() + b'\0' + oid
        return hashlib.sha1(b'tree ' + str(len(raw)).encode() + b'\0' + raw).digest()
    d.require(inventory and encode(entries).hex() == tree, 'ONLINE_RECHARGE_SOURCE_TREE_CHANGED')
    return inventory


def fixed_recovery_inventory(d, commit=RECOVERY_COMMIT, tree=RECOVERY_TREE):
    d.require((commit, tree) in ((RECOVERY_COMMIT, RECOVERY_TREE), (RESTORED_COMMIT, RESTORED_TREE)),
              'ONLINE_RECHARGE_SOURCE_TREE_CHANGED')
    cached = getattr(d, '_onlineRechargeRecoveryInventory', {})
    if (commit, tree) in cached:
        return cached[(commit, tree)]
    with urllib.request.urlopen('https://github.com/wangchaozhuanyong/id-business-system/archive/'
                                + commit + '.tar.gz', timeout=60) as response:
        data = response.read(128 * 1024 * 1024 + 1)
    result = archive_inventory(d, data, commit, tree)
    cached[(commit, tree)] = result
    d._onlineRechargeRecoveryInventory = cached
    return result


def release_source_inventory(d, directory, *, published=False):
    d.require(directory.is_dir() and not directory.is_symlink() and directory.resolve() == directory,
              'ONLINE_RECHARGE_SOURCE_INVALID')
    result = {}
    paths = list(directory.rglob('*'))
    d.require(len(paths) < 100000, 'ONLINE_RECHARGE_SOURCE_INVALID')
    for path in paths:
        d.require(not path.is_symlink(), 'ONLINE_RECHARGE_SOURCE_INVALID')
        if path.is_dir():
            continue
        name = path.relative_to(directory).as_posix()
        d.require(path.is_file() and path.stat().st_size <= 16 * 1024 * 1024, 'ONLINE_RECHARGE_SOURCE_INVALID')
        generated = RECOVERY_GENERATED_FILES | (frozenset(('after-audit.json', 'release-manifest.json', STATE_FILE, PROOF_FILE))
                                               if published else frozenset())
        if name in generated:
            d.require(path.stat().st_size <= 256 * 1024, 'ONLINE_RECHARGE_SOURCE_INVALID')
            continue
        result[name] = {'sha256': file_digest(path), 'mode': '100755' if path.stat().st_mode & 0o111 else '100644'}
    return result


def recovery_origin(d, previous):
    """Only the sealed, ended first attempt may explain a pre-existing additive migration."""
    root = d.BASE / 'releases'
    d.require(root.is_dir() and not root.is_symlink() and root.resolve() == root, 'ONLINE_RECHARGE_SOURCE_INVALID')
    folders = list(root.glob('*-' + RECOVERY_COMMIT[:12]))
    if not folders:
        state = migration_database_state(d, previous)
        d.require(state['status'] == 'PENDING', 'ONLINE_RECHARGE_MIGRATION_ALREADY_PRESENT')
        return None
    d.require(len(folders) == 1, 'ONLINE_RECHARGE_SOURCE_INVALID')
    source = folders[0]
    d.require(re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + RECOVERY_COMMIT[:12], source.name)
              and source.is_dir() and not source.is_symlink() and source.resolve() == source
              and source.stat().st_uid == os.geteuid() and stat.S_IMODE(source.stat().st_mode) & 0o077 == 0,
              'ONLINE_RECHARGE_SOURCE_INVALID')
    policy = recovery_policy(d)
    failure = source / FAILURE_FILE
    d.require(failure.is_file() and not failure.is_symlink() and failure.stat().st_size <= 256 * 1024,
              'ONLINE_RECHARGE_READBACK_PROVENANCE_CHANGED')
    receipt = closed_recovery_json(d, failure.read_bytes())
    d.require(isinstance(receipt, dict) and fingerprint(receipt) == RECOVERY_FAILURE_SHA256
              and receipt.get('status') == 'ONLINE_RECHARGE_FAILED_BEFORE_SWITCH' and receipt.get('step') == 'migration'
              and receipt.get('rollbackOk') is True and receipt.get('servicesAttempted') == []
              and receipt.get('candidateCommit') == RECOVERY_COMMIT and receipt.get('previousCommit') == BASELINE_COMMIT
              and receipt.get('migrationAttempted') is True and receipt.get('inverseMigrationPerformed') is False
              and receipt.get('mediaVolumeDeleted') is False and receipt.get('currentPointsToCandidate') is False
              and receipt.get('receiptPersisted') is True,
              'ONLINE_RECHARGE_READBACK_PROVENANCE_CHANGED')
    inventory = release_source_inventory(d, source)
    d.require(inventory == fixed_recovery_inventory(d), 'ONLINE_RECHARGE_SOURCE_TREE_CHANGED')
    migration_source_check(d, source)
    state = migration_database_state(d, previous, source=source)
    d.require(state['status'] == 'APPLIED' and receipt.get('migration') == {**state, 'performed': True},
              'ONLINE_RECHARGE_READBACK_MIGRATION_CHANGED')
    d.require(fingerprint(file_inventory(d, source / ENGINE_ROOT)) == policy['buildProof']['engineSourceSha256']
              and file_digest(source / 'docker-compose.aws-mysql.yml') == policy['buildProof']['composeSourceSha256'],
              'ONLINE_RECHARGE_BUILD_SOURCE_CHANGED')
    key = fingerprint({'source': source.name, 'policy': fingerprint(policy), 'failure': fingerprint(receipt),
        'inventory': fingerprint(inventory), 'files': {n: file_digest(source / n)
        for n in ('before-audit.json', 'backup-verification.json', WORKSPACE_BACKUP_FILE)}})
    if getattr(d, '_onlineRechargeVerifiedOrigin', None) != key:
        for service in IMAGE_SERVICES:
            verify_image_content(d, source, policy['buildProof'], service)
        recovery_backups(d, source, previous)
        d._onlineRechargeVerifiedOrigin = key
    else:
        # Content-addressed images cannot acquire new bytes under the same ID.
        # Current database, source and failure evidence were measured again above.
        for row in policy['buildProof']['images'].values():
            inspect_image(d, row, RECOVERY_COMMIT, RECOVERY_TREE)
    return {'source': source, 'policy': policy, 'state': state, 'marker': recovery_marker(policy)}


def restored_origin(d, previous, context):
    """Verify the ended, rolled-back publication before permitting recreated API/Admin IDs."""
    policy, state = context['policy'], context['state']
    restored = policy['restoredAttempt']
    folders = list((d.BASE / 'releases').glob('*-' + RESTORED_COMMIT[:12]))
    d.require(len(folders) == 1, 'ONLINE_RECHARGE_SOURCE_INVALID')
    source = folders[0]
    d.require(re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + RESTORED_COMMIT[:12], source.name)
              and source.is_dir() and not source.is_symlink() and source.resolve() == source
              and source.stat().st_uid == os.geteuid() and stat.S_IMODE(source.stat().st_mode) & 0o077 == 0,
              'ONLINE_RECHARGE_SOURCE_INVALID')
    inventory = release_source_inventory(d, source, published=True)
    for name in (FAILURE_FILE, 'release-manifest.json', STATE_FILE, PROOF_FILE,
                 'before-audit.json', 'after-audit.json', 'backup-verification.json', WORKSPACE_BACKUP_FILE):
        path = source / name
        d.require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 256 * 1024,
                  'ONLINE_RECHARGE_READBACK_PROVENANCE_CHANGED')
    receipt = closed_recovery_json(d, (source / FAILURE_FILE).read_bytes())
    # This expectation must also match the independently read ended SSM command
    # in the controlled preflight workflow; deriving it alone cannot authorize release.
    d.require(fingerprint(receipt) == RESTORED_FAILURE_SHA256 == restored['failureReceiptSha256']
              and receipt == {'status': 'ONLINE_RECHARGE_FAILED_RESTORED', 'step': 'audit-after',
                  'code': 'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED', 'errorType': 'RuntimeError',
                  'rollbackOk': True, 'rollback': {n: 'RESTORED' for n in SWITCH_ORDER},
                  'servicesAttempted': list(SWITCH_ORDER), 'candidateCommit': RESTORED_COMMIT,
                  'previousCommit': BASELINE_COMMIT, 'migration': {**state, 'performed': False},
                  'migrationAttempted': False, 'inverseMigrationPerformed': False,
                  'mediaVolumeDeleted': False, 'currentPointsToCandidate': False, 'receiptPersisted': True},
              'ONLINE_RECHARGE_READBACK_PROVENANCE_CHANGED')
    d.require(inventory == fixed_recovery_inventory(d, RESTORED_COMMIT, RESTORED_TREE),
              'ONLINE_RECHARGE_SOURCE_TREE_CHANGED')
    candidate_recovery_source(d, source, context)
    documents = {n: closed_recovery_json(d, (source / n).read_bytes())
                 for n in ('release-manifest.json', STATE_FILE, PROOF_FILE)}
    manifest, record, proof = (documents[n] for n in ('release-manifest.json', STATE_FILE, PROOF_FILE))
    old = closed_recovery_json(d, (previous / 'release-manifest.json').read_bytes())
    d.require(proof == restored['buildProof'] and fingerprint(proof) == RESTORED_PROOF_SHA256,
              'ONLINE_RECHARGE_READBACK_PROVENANCE_CHANGED')
    fields = {'commit', 'sourceBranch', 'sourceTree', 'previousCommit', 'previousRelease', 'previousManifestSha256',
        'releaseTag', 'deployedAt', 'ciWorkflow', 'ciWorkflowRunId', 'deploymentRun', 'imageBuildRun', 'servicesUpdated',
        'sourceArchiveSha256', 'images', 'backupBeforeRelease', 'migrationApplied', 'migrationPerformed',
        'workspaceBackupBeforeRelease', 'workspaceBackupSha256', 'newMigrations', 'dataAuditBefore', 'dataAuditAfter',
        'databaseGrants', 'rollback', 'onlineRechargePublication', 'preservedMigrationOrigin', 'migrationRecovery'}
    d.require(isinstance(manifest, dict) and set(manifest) == fields
              and manifest['commit'] == RESTORED_COMMIT and manifest['sourceTree'] == RESTORED_TREE
              and manifest['previousCommit'] == BASELINE_COMMIT and manifest['previousRelease'] == str(previous)
              and manifest['previousManifestSha256'] == file_digest(previous / 'release-manifest.json')
                  == restored['preflight']['manifestSha256']
              and manifest['sourceBranch'] == 'main' and manifest['ciWorkflow'] == 'Quality Gate'
              and type(manifest['ciWorkflowRunId']) is int and manifest['ciWorkflowRunId'] > 0
              and manifest['deploymentRun'] == manifest['imageBuildRun'] == f'github-actions-{RESTORED_RUN}-{RESTORED_ATTEMPT}'
              and manifest['releaseTag'] == 'v2-production-' + source.name[:16]
              and isinstance(manifest['deployedAt'], str)
              and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z', manifest['deployedAt'])
              and re.fullmatch(r'[a-f0-9]{64}', manifest['sourceArchiveSha256'] or '')
              and manifest['servicesUpdated'] == list(UPDATED) and manifest['newMigrations'] == [MIGRATION_FILE]
              and manifest['migrationApplied'] is True and manifest['migrationPerformed'] is False
              and manifest['migrationRecovery'] == original_recovery_marker(policy)
              and manifest['images'] == {**old['images'], **{n: {
                  'reference': proof['images'][n]['reference'], 'digest': proof['images'][n]['imageId'],
                  'sourceCommit': RESTORED_COMMIT} for n in IMAGE_SERVICES}}
              and manifest['onlineRechargePublication'] == {'version': 1, 'scope': SCOPE,
                  'buildProofSha256': fingerprint(proof), 'migration': dict(MIGRATION_IDENTITY),
                  'legacyWorkersPublished': False, 'configurationScope': 'ONLINE_RECHARGE_VOLUME_LOOPBACK_ONLY'},
              'ONLINE_RECHARGE_READBACK_PROVENANCE_CHANGED')
    d.require(isinstance(record, dict) and set(record) == {'before', 'after', 'baselineEvidence', 'buildProofSha256',
              'configurationBefore', 'configurationAfter', 'preservation', 'migration', 'databaseGrants', 'workspaceBackupSha256'}
              and record['before'] == restored['preflight']['services'] == policy['preflight']['services']
              and record['buildProofSha256'] == fingerprint(proof) and record['migration'] == {**state, 'performed': False}
              and record['configurationBefore'] == configuration_hashes(previous)
              and record['configurationAfter'] == configuration_hashes(source)
              and record['workspaceBackupSha256'] == manifest['workspaceBackupSha256'],
              'ONLINE_RECHARGE_READBACK_PROVENANCE_CHANGED')
    evidence, after = record['baselineEvidence'], record['after']
    d.require(isinstance(evidence, dict) and set(evidence) == {'manifestSha256', 'environmentSha256', 'apiSource',
              'guards', 'freeBytes', 'migrationOrigin', 'workspaceVolume', 'workspaceIdle', 'workspaceOriginFiles',
              'workspaceBuildProofSha256', 'migrationRecovery'}
              and evidence['manifestSha256'] == manifest['previousManifestSha256']
              and evidence['environmentSha256'] == file_digest(previous / '.env.aws.production')
              and evidence['apiSource'] == {'imageId': record['before']['api']['image'], 'revision': BASELINE_COMMIT,
                                          'kind': 'API_WORKSPACE_BUILD_PROVEN'}
              and evidence['workspaceBuildProofSha256'] == policy['preflight']['workspaceBuildProofSha256']
              and evidence['workspaceIdle'] is True and evidence['migrationRecovery'] == original_recovery_marker(policy)
              and type(evidence['freeBytes']) is int and evidence['freeBytes'] > 6 * 1024**3
              and isinstance(after, dict) and set(after) == set((*PRESERVED, *UPDATED))
              and all(isinstance(row, dict) and set(row) == set(SERVICE_IDENTITY_KEYS)
                      and row['status'] == 'running' and (row['health'] == 'healthy' if n != 'caddy' else row['health'] in ('healthy', None))
                      and all(re.fullmatch(r'[a-f0-9]{64}', row[k] or '') for k in
                              ('containerId', 'startedAtSha256', 'environmentSha256', 'configurationSha256'))
                      for n, row in after.items())
              and all(after[n] == record['before'][n] for n in PRESERVED)
              and all(after[n]['image'] == proof['images'][n]['imageId']
                      and after[n]['reference'] == proof['images'][n]['reference'] for n in UPDATED),
              'ONLINE_RECHARGE_READBACK_PRESERVATION_CHANGED')
    d.require(isinstance(evidence['guards'], dict) and set(evidence['guards']) == {'rechargeIdle',
              'registrationBusy', 'registrationLeaseActive', 'registrationWindowRetained'}
              and evidence['guards']['rechargeIdle'] is True and evidence['guards']['registrationBusy'] is False
              and evidence['guards']['registrationLeaseActive'] is False
              and type(evidence['guards']['registrationWindowRetained']) is bool
              and manifest['preservedMigrationOrigin'] == legacy(d).migration_successor_marker(evidence['migrationOrigin'])
              and manifest['rollback'] == {'release': str(previous),
                  'images': {n: record['before'][n]['image'] for n in ('api', 'admin')},
                  'servicesAdded': ['online-recharge'], 'inverseMigrationAllowed': False,
                  'mediaVolumePreserved': True, 'workspaceVolumePreserved': True},
              'ONLINE_RECHARGE_READBACK_PROVENANCE_CHANGED')
    grants = record['databaseGrants']
    d.require(isinstance(grants, dict) and set(grants) == {'ok', 'newTableCount', 'runtimeTableCount'}
              and grants['ok'] is True and type(grants['newTableCount']) is int and grants['newTableCount'] == len(TABLES)
              and type(grants['runtimeTableCount']) is int and grants['runtimeTableCount'] > len(TABLES)
              and grants == manifest['databaseGrants'], 'ONLINE_RECHARGE_DATABASE_GRANTS_FAILED')
    preservation = {'environment': verify_environment(d, previous, source, (previous / '.env.aws.production').read_bytes()),
                    'compose': verify_compose(d, previous, source), 'caddy': verify_caddy_projection(d, previous, source)}
    d.require(preservation == record['preservation'], 'ONLINE_RECHARGE_READBACK_PRESERVATION_CHANGED')
    audit_before = legacy(d).audit_receipt(d, source / 'before-audit.json')
    audit_after = legacy(d).audit_receipt(d, source / 'after-audit.json')
    original_audit = legacy(d).audit_receipt(d, previous / 'after-audit.json')
    d.require(audit_before == manifest['dataAuditBefore'] and audit_after == manifest['dataAuditAfter']
              and audit_before['checksSha256'] == audit_after['checksSha256'] == original_audit['checksSha256'],
              'ONLINE_RECHARGE_AUDIT_RULES_CHANGED')
    key = fingerprint({'source': source.name, 'inventory': inventory, 'documents': documents, 'receipt': receipt,
        'policy': fingerprint(policy), 'backups': {n: file_digest(source / n)
            for n in ('backup-verification.json', WORKSPACE_BACKUP_FILE)}})
    if getattr(d, '_onlineRechargeVerifiedRestored', None) != key:
        for service in IMAGE_SERVICES:
            verify_image_content(d, source, proof, service)
        recovery_backups(d, source, previous, commit=RESTORED_COMMIT, manifest=manifest, record=record)
        workspace_origin(d, previous, previous, evidence, record['before'])
        d._onlineRechargeVerifiedRestored = key
    else:
        for row in proof['images'].values():
            inspect_image(d, row, RESTORED_COMMIT, RESTORED_TREE)
    historical_guard(d, previous, evidence, source)
    workspace_record = previous / legacy(d).STATE_FILE
    d.require(workspace_record.is_file() and not workspace_record.is_symlink()
              and file_digest(workspace_record) == evidence['workspaceOriginFiles'].get(legacy(d).STATE_FILE),
              'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED')
    workspace = closed_recovery_json(d, workspace_record.read_bytes())
    anchors = {n: {'oldBeforeContainerId': workspace.get('before', {}).get(n, {}).get('containerId'),
                   'candidateAfterContainerId': after[n]['containerId']} for n in ('api', 'admin')}
    d.require(all(re.fullmatch(r'[a-f0-9]{64}', v or '') for row in anchors.values() for v in row.values()),
              'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED')
    return {'source': source, 'manifestSha256': file_digest(source / 'release-manifest.json'),
            'recordSha256': file_digest(source / STATE_FILE), 'configurationAnchors': anchors}


def release_recovery(d, previous):
    context = recovery_origin(d, previous)
    if context is None:
        return None
    return {**context, 'restored': restored_origin(d, previous, context)}


def recovery_services(d, states, context):
    original = context['policy']['preflight']['services']
    d.require(set(states) == set(original), 'ONLINE_RECHARGE_PRESERVED_CONTAINER_CHANGED')
    if getattr(d, '_onlineRechargeProjectionDiagnostic', False):
        diff = {n: [k for k in SERVICE_IDENTITY_KEYS if states[n].get(k) != original[n][k]] for n in original}
        matched = {n: False for n in ('api', 'admin')}
        reasons = {n: 'NOT_PROBED' for n in matched}
        restored = context.get('restored')
        if restored is not None and 'configurationAnchors' in restored:
            for name in matched:
                try:
                    raw = d.run('docker', 'inspect', states[name]['containerId'])
                    d.require(isinstance(raw, str) and len(raw.encode()) <= 1024 * 1024,
                              'ONLINE_RECHARGE_CONTAINER_CHANGED')
                    metadata = json.loads(raw)
                    d.require(isinstance(metadata, list) and len(metadata) == 1,
                              'ONLINE_RECHARGE_CONTAINER_CHANGED')
                except Exception:
                    reasons[name] = 'INSPECT_FAILED'
                    continue
                try:
                    restored_configuration_projection(d, name, metadata[0], states[name], original[name],
                                                      restored['configurationAnchors'][name])
                    matched[name] = True
                    reasons[name] = 'MATCH'
                except ProjectionRejection as error:
                    reasons[name] = error.reason if (isinstance(error.reason, str)
                        and error.reason in PROJECTION_REASONS and error.reason != 'MATCH') else 'OTHER'
                except Exception:
                    # Never inspect arbitrary exceptions, Docker values or credentials.
                    reasons[name] = 'OTHER'
        d._onlineRechargeIdentityDiagnostic = {'identityDiff': diff, 'restoredProjectionMatch': matched,
                                               'restoredProjectionReason': reasons}
    for name, row in states.items():
        keys = SERVICE_IDENTITY_KEYS
        if context.get('restored') is not None and name in ('api', 'admin'):
            keys = tuple(k for k in keys if k not in ('containerId', 'startedAtSha256'))
            d.require(all(re.fullmatch(r'[a-f0-9]{64}', row.get(k, '')) for k in ('containerId', 'startedAtSha256')),
                      'ONLINE_RECHARGE_PRESERVED_CONTAINER_CHANGED')
        d.require({k: row[k] for k in keys} == {k: original[name][k] for k in keys},
                  'ONLINE_RECHARGE_PRESERVED_CONTAINER_CHANGED')


def restored_configuration_projection(d, service, metadata, actual, original, anchors):
    """Diagnostic only: uniquely reconstruct two native identity fields in memory.

    No caller uses this projection to authorize publication. Every other byte in
    Config, HostConfig and destination-sorted complete Mounts must match the
    original sealed configuration hash, including environment and all labels.
    """
    def check(value, reason):
        if not value:
            raise ProjectionRejection(reason)
    check(service in ('api', 'admin') and isinstance(metadata, dict)
              and all(isinstance(row, dict) and set(row) == set(SERVICE_IDENTITY_KEYS)
                      and all(isinstance(row[k], str) and re.fullmatch(r'[a-f0-9]{64}', row[k]) for k in
                              ('containerId', 'startedAtSha256', 'environmentSha256', 'configurationSha256'))
                      for row in (actual, original))
              and isinstance(anchors, dict) and set(anchors) == {'oldBeforeContainerId', 'candidateAfterContainerId'}
              and all(isinstance(v, str) and re.fullmatch(r'[a-f0-9]{64}', v) for v in anchors.values())
              and all(actual[k] == original[k] for k in ('status', 'health', 'image', 'reference', 'environmentSha256')),
              'INPUT_INVALID')
    config, host, mounts, state = (metadata.get(k) for k in ('Config', 'HostConfig', 'Mounts', 'State'))
    check(isinstance(config, dict) and isinstance(host, dict) and isinstance(state, dict)
              and isinstance(mounts, list) and all(isinstance(m, dict) and isinstance(m.get('Destination'), str)
                  and m['Destination'].startswith('/') for m in mounts)
              and len({m['Destination'] for m in mounts}) == len(mounts)
              and isinstance(config.get('Env'), list) and bool(config['Env'])
              and all(isinstance(v, str) for v in config['Env'])
              and isinstance(state.get('StartedAt'), str) and 0 < len(state['StartedAt']) <= 100
              and metadata.get('Id') == actual['containerId'] and metadata.get('Image') == actual['image']
              and config.get('Image') == actual['reference'] and state.get('Status') == actual['status']
              and (state.get('Health') or {}).get('Status') == actual['health']
              and hashlib.sha256(state['StartedAt'].encode()).hexdigest() == actual['startedAtSha256']
              and fingerprint(sorted(config['Env'])) == actual['environmentSha256'], 'METADATA_MISMATCH')
    check(config.get('Hostname') == actual['containerId'][:12], 'HOSTNAME_MISMATCH')
    configuration = {'Config': config, 'HostConfig': host, 'Mounts': sorted(mounts, key=lambda m: m['Destination'])}
    raw_sha = fingerprint(configuration)
    check(raw_sha == actual['configurationSha256'], 'RAW_HASH_MISMATCH')
    labels = config.get('Labels')
    check(isinstance(labels, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in labels.items())
              and labels.get('com.docker.compose.service') == service
              and labels.get('com.docker.compose.container-number') == '1'
              and re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,62}', labels.get('com.docker.compose.project', '')),
              'COMPOSE_LABELS_MISMATCH')
    project = labels['com.docker.compose.project']
    names = tuple(separator.join((project, service, '1')) for separator in ('-', '_'))
    check(isinstance(metadata.get('Name'), str) and metadata['Name'] in tuple('/' + n for n in names), 'NAME_MISMATCH')
    stable_name = metadata['Name'][1:]
    replace_key = 'com.docker.compose.replace'
    check(labels.get(replace_key) in (anchors['candidateAfterContainerId'], stable_name), 'REPLACE_MISMATCH')
    projected = copy.deepcopy(configuration)
    projected['Config']['Hostname'] = original['containerId'][:12]
    matches = []
    for replacement in (anchors['oldBeforeContainerId'], stable_name, None):
        if replacement is None:
            projected['Config']['Labels'].pop(replace_key, None)
        else:
            projected['Config']['Labels'][replace_key] = replacement
        if fingerprint(projected) == original['configurationSha256']:
            matches.append(replacement)
    check(len(matches) == 1, 'PROJECTED_HASH_AMBIGUOUS' if len(matches) > 1 else 'PROJECTED_HASH_MISMATCH')
    return {'rawSha256': raw_sha, 'projectedSha256': original['configurationSha256']}


def recovery_backups(d, source, previous, *, commit=RECOVERY_COMMIT, manifest=None, record=None):
    audit = legacy(d).audit_receipt(d, source / 'before-audit.json')
    original = legacy(d).audit_receipt(d, previous / 'after-audit.json')
    d.require(audit['checksSha256'] == original['checksSha256'], 'ONLINE_RECHARGE_AUDIT_RULES_CHANGED')
    backup = closed_recovery_json(d, (source / 'backup-verification.json').read_bytes())
    d.require(isinstance(backup, dict) and set(backup) == {'name', 'sha256', 'size', 's3Verified'}
              and re.fullmatch(r'id-business-v2-[0-9]{8}T[0-9]{6}Z\.sql\.gz', backup.get('name', ''))
              and re.fullmatch(r'[a-f0-9]{64}', backup.get('sha256', '')) and type(backup.get('size')) is int
              and backup['size'] > 0 and backup.get('s3Verified') is True, 'ONLINE_RECHARGE_BACKUP_RECEIPT_CHANGED')
    path = d.BASE / 'backups/mysql' / backup['name']
    d.require(path.is_file() and not path.is_symlink() and path.resolve() == path
              and path.stat().st_size == backup['size'] and file_digest(path) == backup['sha256'],
              'ONLINE_RECHARGE_BACKUP_RECEIPT_CHANGED')
    values = d.environment_values(previous / '.env.aws.production')
    key = values.get('MYSQL_BACKUP_S3_PREFIX', 'mysql/daily').rstrip('/') + '/' + backup['name']
    head = json.loads(d.run('aws', 's3api', 'head-object', '--bucket', values['MYSQL_BACKUP_S3_BUCKET'], '--key', key,
                           '--checksum-mode', 'ENABLED', '--region', values.get('MYSQL_BACKUP_S3_REGION') or 'ap-northeast-1'))
    d.require(head.get('ContentLength') == backup['size'] and head.get('ServerSideEncryption') == 'AES256'
              and head.get('ChecksumSHA256') == base64.b64encode(bytes.fromhex(backup['sha256'])).decode(),
              'ONLINE_RECHARGE_BACKUP_UNVERIFIED')
    workspace = closed_recovery_json(d, (source / WORKSPACE_BACKUP_FILE).read_bytes())
    d.require(isinstance(workspace, dict), 'ONLINE_RECHARGE_WORKSPACE_BACKUP_RECEIPT_CHANGED')
    volume = legacy(d).workspace_volume(d, previous, attached=True)
    if manifest is None:
        manifest = {'commit': commit, 'workspaceBackupBeforeRelease': workspace.get('name'),
                    'workspaceBackupSha256': fingerprint(workspace)}
    else:
        d.require(manifest.get('backupBeforeRelease') == backup['name'], 'ONLINE_RECHARGE_BACKUP_RECEIPT_CHANGED')
    workspace_backup_receipt(d, source, previous, {'workspaceVolume': volume}, manifest,
                             {'workspaceBackupSha256': fingerprint(workspace)} if record is None else record)


def candidate_recovery_source(d, directory, context):
    policy = context['policy']
    expected, actual = fixed_recovery_inventory(d), release_source_inventory(d, directory, published=True)
    allowed = set(policy['candidateAllowedFiles'])
    d.require({n: row for n, row in actual.items() if n not in allowed}
              == {n: row for n, row in expected.items() if n not in allowed}
              and set(expected) <= set(actual), 'ONLINE_RECHARGE_BUILD_SOURCE_CHANGED')
    grant_source_change(d, context['source'], directory, policy)


def grant_source_change(d, previous, target, policy=None):
    policy = recovery_policy(d) if policy is None else policy
    grant = policy['sharedGrant']
    old, new = (previous / GRANT_SOURCE).read_bytes(), (target / GRANT_SOURCE).read_bytes()
    anchor = b"  'ip_whitelists',\n"
    added = ''.join("  '" + n + "',\n" for n in RECOVERY_DELETE_TABLES).encode()
    d.require(hashlib.sha256(old).hexdigest() == grant['beforeSha256']
              and hashlib.sha256(new).hexdigest() == grant['afterSha256'] and old.count(anchor) == 1
              and new == old.replace(anchor, anchor + added, 1), 'ONLINE_RECHARGE_SHARED_GATE_SOURCE_CHANGED')


def content_command(service):
    if service == 'online-recharge':
        return ('set -eu; export LC_ALL=C; cd /workspace/engine; '
                'find . -type f ! -path "./runtime/*" ! -path "./upstream/node_modules/*" '
                '-exec sha256sum {} + | sort')
    return _load_legacy().content_command(service)


def _load_legacy():
    import runpy
    return SimpleNamespace(**runpy.run_path(str(Path(__file__).with_name('api-admin-scope.py')),
                                          init_globals={'SCOPE': 'API_ADMIN_WORKSPACE'}))


def content_summary(d, service, output):
    if service != 'online-recharge':
        return legacy(d).content_summary(d, service, output)
    lines = output.splitlines()
    d.require(0 < len(lines) < 30000 and len(output) < 8 * 1024 * 1024
              and all(re.fullmatch(r'[a-f0-9]{64}  \./[^\r\n]+', line)
                      and '..' not in Path(line[66:]).parts and not line[66:].startswith(('./runtime/', './upstream/node_modules/'))
                      for line in lines), 'ONLINE_RECHARGE_ENGINE_CONTENT_INVALID')
    d.require(len({line[66:] for line in lines}) == len(lines), 'ONLINE_RECHARGE_ENGINE_CONTENT_INVALID')
    return {'fileCount': len(lines), 'sha256': hashlib.sha256(('\n'.join(sorted(lines)) + '\n').encode()).hexdigest()}


def file_inventory(d, root):
    d.require(root.is_dir() and not root.is_symlink(), 'ONLINE_RECHARGE_SOURCE_INVALID')
    result = {}
    for path in root.rglob('*'):
        relative = path.relative_to(root)
        if relative.parts[0] == 'runtime' or relative.parts[:2] == ('upstream', 'node_modules'):
            continue
        d.require(not path.is_symlink(), 'ONLINE_RECHARGE_SOURCE_INVALID')
        if path.is_dir():
            continue
        d.require(path.is_file() and path.stat().st_size < 16 * 1024 * 1024
                  and not any(p in ('__pycache__', '.git', '.env') for p in relative.parts)
                  and path.suffix not in ('.pyc', '.log'), 'ONLINE_RECHARGE_SOURCE_INVALID')
        result[relative.as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    d.require(0 < len(result) < 1000, 'ONLINE_RECHARGE_SOURCE_INVALID')
    return result


def engine_content(d, directory):
    rows = file_inventory(d, directory / ENGINE_ROOT)
    return content_summary(d, 'online-recharge', '\n'.join(digest + '  ./' + name for name, digest in sorted(rows.items())))


def migration_content(d, directory):
    migration_source_check(d, directory)
    rows = {('/app/' + MIGRATION_ROOT + '/' + n): digest for n, digest in legacy(d).migration_files(d, directory).items()}
    for name in (SCHEMA_FILE, SEED_FILE):
        rows['/app/' + name] = hashlib.sha256((directory / name).read_bytes()).hexdigest()
    return content_summary(d, 'migrate', '\n'.join(sorted(digest + '  ' + name for name, digest in rows.items())))


def validate_proof(d, value, commit, tree, repository=None, run_id=None, attempt=None):
    d.require(isinstance(value, dict) and set(value) == {'version', 'scope', 'commit', 'sourceTree', 'baselineCommit',
              'migration', 'images', 'engineSourceSha256', 'composeSourceSha256'}
              and value['version'] == 1 and value['scope'] == SCOPE and value['commit'] == commit
              and value['sourceTree'] == tree and value['baselineCommit'] == BASELINE_COMMIT
              and value['migration'] == MIGRATION_IDENTITY and isinstance(value['images'], dict)
              and set(value['images']) == set(IMAGE_SERVICES)
              and all(re.fullmatch(r'[a-f0-9]{64}', value[n] or '') for n in ('engineSourceSha256', 'composeSourceSha256')),
              'ONLINE_RECHARGE_BUILD_PROOF_INVALID')
    for service, row in value['images'].items():
        d.require(isinstance(row, dict) and set(row) == {'reference', 'imageId', 'fileCount', 'sha256'}
                  and re.fullmatch(r'sha256:[a-f0-9]{64}', row['imageId'] or '')
                  and re.fullmatch(r'[a-f0-9]{64}', row['sha256'] or '')
                  and type(row['fileCount']) is int and 0 < row['fileCount'] < 30000
                  and re.fullmatch(r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release:'
                  + commit + r'-[1-9][0-9]*-[1-9][0-9]*-' + service, row['reference'] or ''),
                  'ONLINE_RECHARGE_BUILD_IMAGE_INVALID')
        if repository is not None:
            d.require(row['reference'] == f'{repository}:{commit}-{run_id}-{attempt}-{service}',
                      'ONLINE_RECHARGE_BUILD_RUN_CHANGED')
    return value


def inspect_image(d, row, commit, tree):
    metadata = json.loads(d.run('docker', 'image', 'inspect', row['reference']))[0]
    labels = metadata.get('Config', {}).get('Labels', {})
    d.require(metadata['Id'] == row['imageId'] and metadata['Architecture'] == 'amd64'
              and labels.get('org.opencontainers.image.revision') == commit
              and labels.get('id-business-v2.source-tree') == tree, 'ONLINE_RECHARGE_IMAGE_PROVENANCE_CHANGED')
    return metadata


def verify_image_content(d, directory, proof, service):
    row = proof['images'][service]
    inspect_image(d, row, proof['commit'], proof['sourceTree'])
    measured = content_summary(d, service, d.run('docker', 'run', '--rm', '--network', 'none',
        '--read-only', '--entrypoint', '/bin/sh', row['reference'], '-c', content_command(service)))
    d.require(measured == {n: row[n] for n in ('fileCount', 'sha256')}, 'ONLINE_RECHARGE_IMAGE_CONTENT_CHANGED')
    expected = engine_content(d, directory) if service == 'online-recharge' else migration_content(d, directory) if service == 'migrate' else None
    d.require(expected is None or measured == expected, 'ONLINE_RECHARGE_IMAGE_SOURCE_CHANGED')


def build_proof(d):
    commit, tree = os.environ['RELEASE_COMMIT'], os.environ['SOURCE_TREE']
    d.require(d.run('git', 'rev-parse', 'HEAD') == commit and d.run('git', 'rev-parse', 'HEAD^{tree}') == tree,
              'ONLINE_RECHARGE_BUILD_SOURCE_CHANGED')
    d.require(d.run('git', 'status', '--porcelain', '--untracked-files=all') == '',
              'ONLINE_RECHARGE_BUILD_WORKTREE_DIRTY')
    directory = Path.cwd()
    migration_source_check(d, directory)
    result = {'version': 1, 'scope': SCOPE, 'commit': commit, 'sourceTree': tree,
              'baselineCommit': BASELINE_COMMIT, 'migration': dict(MIGRATION_IDENTITY), 'images': {},
              'engineSourceSha256': fingerprint(file_inventory(d, directory / ENGINE_ROOT)),
              'composeSourceSha256': hashlib.sha256((directory / 'docker-compose.aws-mysql.yml').read_bytes()).hexdigest()}
    for service in IMAGE_SERVICES:
        reference = (os.environ['RELEASE_REPOSITORY'] + ':' + commit + '-' + os.environ['GITHUB_RUN_ID']
                     + '-' + os.environ['GITHUB_RUN_ATTEMPT'] + '-' + service)
        metadata = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
        result['images'][service] = {'reference': reference, 'imageId': metadata['Id'],
            **content_summary(d, service, d.run('docker', 'run', '--rm', '--network', 'none', '--read-only',
                '--entrypoint', '/bin/sh', reference, '-c', content_command(service)))}
    validate_proof(d, result, commit, tree, os.environ['RELEASE_REPOSITORY'], os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT'])
    for service in IMAGE_SERVICES:
        verify_image_content(d, directory, result, service)
    target = directory / '.deploy/production-release' / PROOF_FILE
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')
    print(json.dumps({'status': SCOPE + '_BUILD_PROVEN', 'proofSha256': fingerprint(result)}))


def snapshot(d, directory, *, include_engine=False):
    states = legacy(d).snapshot(d, directory)
    if include_engine:
        row = d.service_state(directory, 'online-recharge', include_container_id=True, include_environment_hash=True)
        metadata = json.loads(d.run('docker', 'inspect', row['containerId']))[0]
        mounts = metadata.get('Mounts')
        d.require(metadata['Id'] == row['containerId'] and metadata['Image'] == row['image']
                  and isinstance(mounts, list) and all(isinstance(m, dict) and isinstance(m.get('Destination'), str)
                  for m in mounts) and len({m['Destination'] for m in mounts}) == len(mounts)
                  and row['status'] == 'running' and row['health'] == 'healthy',
                  'ONLINE_RECHARGE_EXECUTOR_UNHEALTHY')
        row['configurationSha256'] = fingerprint({'Config': metadata.get('Config'),
            'HostConfig': metadata.get('HostConfig'), 'Mounts': sorted(mounts, key=lambda m: m['Destination'])})
        d.require(metadata.get('HostConfig', {}).get('NetworkMode') == 'container:' + states['api']['containerId']
                  and not metadata.get('HostConfig', {}).get('PortBindings'),
                  'ONLINE_RECHARGE_EXECUTOR_NETWORK_CHANGED')
        api_metadata = json.loads(d.run('docker', 'inspect', states['api']['containerId']))[0]
        engine_mount = [m for m in mounts if m.get('Destination') == ENGINE_VOLUME_PATH]
        api_mount = [m for m in api_metadata.get('Mounts', []) if m.get('Destination') == API_VOLUME_PATH]
        d.require(len(engine_mount) == len(api_mount) == 1
                  and engine_mount[0].get('Type') == api_mount[0].get('Type') == 'volume'
                  and engine_mount[0].get('Name') == api_mount[0].get('Name')
                  and isinstance(engine_mount[0].get('Name'), str)
                  and engine_mount[0]['Name'].endswith('_' + MEDIA_VOLUME)
                  and engine_mount[0].get('RW') is True and api_mount[0].get('RW') is True,
                  'ONLINE_RECHARGE_SHARED_VOLUME_CHANGED')
        environment = metadata.get('Config', {}).get('Env', [])
        d.require(isinstance(environment, list)
                  and not any(re.match(r'(?:DATABASE_URL|MIGRATION_DATABASE_URL|MYSQL_[A-Z_]+|JWT_SECRET|FIELD_ENCRYPTION_KEY|HASH_SECRET|AUTO_RECHARGE_WORKER_TOKEN)=', e)
                              for e in environment), 'ONLINE_RECHARGE_EXECUTOR_SECRET_SCOPE_CHANGED')
        states['online-recharge'] = row
    return states


def jobs_idle(d, directory, *, migrated=False):
    guards = legacy(d).jobs_idle(d, directory)
    workspace_guard(d, directory)
    if migrated:
        value = database_read(d, directory, "SELECT JSON_OBJECT('busy', (SELECT COUNT(*) FROM online_recharge_tasks "
            "WHERE status IN ('queued','running') OR lease_expires_at > UTC_TIMESTAMP(6)))")
        d.require(value == {'busy': 0}, 'ONLINE_RECHARGE_TASKS_BUSY')
    return guards


def require_fresh_resources(d, directory):
    query = 'SELECT JSON_OBJECT(' + ','.join("'" + n + "',(SELECT COUNT(*) FROM `" + n + '`)' for n in TABLES) + ')'
    value = database_read(d, directory, query)
    d.require(isinstance(value, dict) and set(value) == set(TABLES)
              and all(type(v) is int and v == 0 for v in value.values()),
              'ONLINE_RECHARGE_FIRST_PUBLICATION_RESOURCES_NOT_EMPTY')


def verify_permission_seed(d, directory):
    value = database_read(d, directory, """SELECT JSON_OBJECT('permissions', (SELECT JSON_ARRAYAGG(JSON_OBJECT(
        'id',id,'code',code,'module',module,'action',action)) FROM permissions
        WHERE module='id_business_v2.online_recharge'),
        'adminGranted', (SELECT COUNT(*) FROM role_permissions rp JOIN roles r ON r.id=rp.role_id
        JOIN permissions p ON p.id=rp.permission_id WHERE r.code='admin'
        AND p.module='id_business_v2.online_recharge' AND rp.sensitive_approval_required=false))""")
    expected = [{'id': '9c965f64-b3b5-4f06-bc0b-7612366d100' + str(index),
                 'code': 'id_business_v2.online_recharge.' + action,
                 'module': 'id_business_v2.online_recharge', 'action': action}
                for index, action in enumerate(('read', 'manage', 'sensitive'), 1)]
    d.require(isinstance(value, dict) and set(value) == {'permissions', 'adminGranted'}
              and isinstance(value['permissions'], list)
              and sorted(value['permissions'], key=lambda r: r['id']) == expected
              and value['adminGranted'] == 3, 'ONLINE_RECHARGE_PERMISSION_SEED_CHANGED')


def extend_environment(d, previous, target):
    old = (previous / '.env.aws.production').read_bytes()
    values = d.environment_values(previous / '.env.aws.production')
    d.require(not (set(values) & ENV_KEYS), 'ONLINE_RECHARGE_ENV_ALREADY_PRESENT')
    key = secrets.token_urlsafe(32)
    d.require(len(key) >= 32 and key != values.get('AUTO_RECHARGE_WORKER_TOKEN'), 'ONLINE_RECHARGE_KEY_INVALID')
    additions = {**ENV_DEFAULTS, 'ONLINE_RECHARGE_WORKER_KEY': key}
    # No existing line is rewritten; the extra newline preserves an unterminated final line.
    raw = old + (b'' if old.endswith(b'\n') else b'\n') + ''.join(
        name + '=' + value + '\n' for name, value in additions.items()).encode()
    path = target / '.env.aws.production'
    path.write_bytes(raw)
    path.chmod(0o600)
    verify_environment(d, previous, target, old)
    return old


def verify_environment(d, previous, target, original):
    d.require((previous / '.env.aws.production').read_bytes() == original, 'ONLINE_RECHARGE_PREVIOUS_ENV_CHANGED')
    raw = (target / '.env.aws.production').read_bytes()
    d.require(raw.startswith(original + (b'' if original.endswith(b'\n') else b'\n')),
              'ONLINE_RECHARGE_EXISTING_ENV_CHANGED')
    old = d.environment_values(previous / '.env.aws.production')
    new = d.environment_values(target / '.env.aws.production')
    d.require(set(new) == set(old) | ENV_KEYS and all(new[k] == v for k, v in old.items())
              and all(new.get(k) == v for k, v in ENV_DEFAULTS.items())
              and re.fullmatch(r'[A-Za-z0-9_-]{43}', new.get('ONLINE_RECHARGE_WORKER_KEY', ''))
              and new['ONLINE_RECHARGE_WORKER_KEY'] != old.get('AUTO_RECHARGE_WORKER_TOKEN'),
              'ONLINE_RECHARGE_ENV_SCOPE_CHANGED')
    tail = raw[len(original + (b'' if original.endswith(b'\n') else b'\n')):].decode()
    d.require(len(tail.splitlines()) == len(ENV_KEYS)
              and set(line.split('=', 1)[0] for line in tail.splitlines()) == ENV_KEYS,
              'ONLINE_RECHARGE_ENV_SCOPE_CHANGED')
    return {'beforeSha256': hashlib.sha256(original).hexdigest(), 'afterSha256': hashlib.sha256(raw).hexdigest(),
            'addedKeys': sorted(ENV_KEYS), 'existingValuesPreserved': True, 'dedicatedKey': True}


def rendered_configuration(d, directory):
    value = json.loads(d.compose(directory, 'config', '--format', 'json'))
    d.require(isinstance(value, dict) and isinstance(value.get('services'), dict),
              'ONLINE_RECHARGE_COMPOSE_INVALID')
    # Build paths and bind roots vary with the immutable release directory, not behavior.
    def normalized(item):
        if isinstance(item, str) and item.startswith(str(directory) + '/'):
            return '${RELEASE}/' + item[len(str(directory)) + 1:]
        if isinstance(item, list):
            return [normalized(row) for row in item]
        if isinstance(item, dict):
            return {k: normalized(v) for k, v in item.items() if k != 'build'}
        return item
    return normalized(value)


def verify_compose(d, previous, target):
    old, new = rendered_configuration(d, previous), rendered_configuration(d, target)
    d.require(set(new) == set(old) and set(new['services']) == set(old['services']) | {'online-recharge'}
              and all(new['services'][n] == old['services'][n] for n in old['services'] if n not in ('api', 'admin', 'migrate')),
              'ONLINE_RECHARGE_PRESERVED_SERVICE_DEFINITION_CHANGED')
    for field in new:
        if field not in ('services', 'volumes'):
            d.require(new[field] == old[field], 'ONLINE_RECHARGE_PRESERVED_INFRASTRUCTURE_CHANGED')
    d.require(set(new.get('volumes', {})) == set(old.get('volumes', {})) | {MEDIA_VOLUME}
              and all(new['volumes'][n] == v for n, v in old.get('volumes', {}).items()),
              'ONLINE_RECHARGE_VOLUME_SCOPE_CHANGED')
    volume = new['volumes'][MEDIA_VOLUME]
    d.require(set(volume) <= {'name', 'driver'} and volume.get('driver', 'local') == 'local'
              and not volume.get('external'), 'ONLINE_RECHARGE_VOLUME_SCOPE_CHANGED')
    for service in ('admin', 'migrate'):
        a, b = dict(old['services'][service]), dict(new['services'][service])
        for key in ('image', 'pull_policy'):
            a.pop(key, None); b.pop(key, None)
        d.require(a == b, 'ONLINE_RECHARGE_EXISTING_SERVICE_CHANGED')
    a, b = dict(old['services']['api']), dict(new['services']['api'])
    for key in ('image', 'pull_policy'):
        a.pop(key, None); b.pop(key, None)
    api_env = dict(b.pop('environment', {})); old_env = a.pop('environment', {})
    d.require(set(api_env) == set(old_env) | {'ONLINE_RECHARGE_WORKER_KEY', 'ONLINE_RECHARGE_CREDENTIALS_URL', 'ONLINE_RECHARGE_ARTIFACT_DIR'}
              and all(api_env[k] == v for k, v in old_env.items())
              and api_env['ONLINE_RECHARGE_CREDENTIALS_URL'] == ENV_DEFAULTS['ONLINE_RECHARGE_CREDENTIALS_URL']
              and api_env['ONLINE_RECHARGE_ARTIFACT_DIR'] == API_MEDIA_PATH,
              'ONLINE_RECHARGE_API_ENV_CHANGED')
    old_mounts, new_mounts = a.pop('volumes', []), b.pop('volumes', [])
    added = {'type': 'volume', 'source': MEDIA_VOLUME, 'target': API_VOLUME_PATH, 'volume': {}}
    d.require(a == b and new_mounts == [*old_mounts, added], 'ONLINE_RECHARGE_API_MOUNT_CHANGED')
    engine = new['services']['online-recharge']
    env = engine.get('environment', {})
    d.require(engine.get('network_mode') == 'service:api' and not engine.get('networks')
              and not engine.get('ports') and not engine.get('privileged') and engine.get('read_only') is True
              and 'ALL' in engine.get('cap_drop', []) and 'no-new-privileges:true' in engine.get('security_opt', [])
              and engine.get('volumes') == [{'type': 'volume', 'source': MEDIA_VOLUME, 'target': ENGINE_VOLUME_PATH, 'volume': {}}]
              and env.get('ONLINE_RECHARGE_WORKER_KEY') == api_env['ONLINE_RECHARGE_WORKER_KEY']
              and len(str(env.get('ONLINE_RECHARGE_WORKER_KEY', ''))) >= 32
              and env.get('ONLINE_RECHARGE_ENGINE_ENABLED') == '1'
              and env.get('ONLINE_RECHARGE_RPC_URL') == ENV_DEFAULTS['ONLINE_RECHARGE_RPC_URL']
              and env.get('ONLINE_RECHARGE_CREDENTIALS_URL') == ENV_DEFAULTS['ONLINE_RECHARGE_CREDENTIALS_URL']
              and env.get('ONLINE_RECHARGE_RUNTIME_DIR') == ENGINE_VOLUME_PATH
              and env.get('ONLINE_RECHARGE_MEDIA_DIR') == ENGINE_MEDIA_PATH
              and set(env) <= {'NODE_ENV', 'ONLINE_RECHARGE_ENGINE_ENABLED', 'ONLINE_RECHARGE_WORKER_KEY',
                              'ONLINE_RECHARGE_RPC_URL', 'ONLINE_RECHARGE_CREDENTIALS_URL',
                              'ONLINE_RECHARGE_RUNTIME_DIR', 'ONLINE_RECHARGE_MEDIA_DIR', 'ONLINE_RECHARGE_FFMPEG_PATH'},
              'ONLINE_RECHARGE_EXECUTOR_ISOLATION_CHANGED')
    return {'beforeSha256': fingerprint(old), 'afterSha256': fingerprint(new), 'dedicatedVolume': MEDIA_VOLUME,
            'sharedApiNetworkNamespace': True, 'credentialsLoopback': True, 'databaseSecretsExcluded': True}


def verify_caddy_projection(d, previous, target):
    name = 'deploy/caddy/Caddyfile.aws'
    old, new = (previous / name).read_bytes(), (target / name).read_bytes()
    d.require(old == new,
              'ONLINE_RECHARGE_CADDY_PROJECTION_CHANGED')
    return {'beforeSha256': hashlib.sha256(old).hexdigest(), 'afterSha256': hashlib.sha256(new).hexdigest(),
            'configurationUnchanged': True, 'imageUnchanged': True}


def configuration_hashes(directory):
    return {n: hashlib.sha256((directory / n).read_bytes()).hexdigest() for n in (
        'docker-compose.aws-mysql.yml', 'deploy/caddy/Caddyfile.aws', SCHEMA_FILE, 'compose.release.json')}


def require_preserved(d, previous, target, before, original, *, all_services=False, include_engine=False):
    env = verify_environment(d, previous, target, original)
    infrastructure = verify_compose(d, previous, target)
    caddy = verify_caddy_projection(d, previous, target)
    migration_source_check(d, previous, candidate=False)
    migration_source_check(d, target)
    workspace = json.loads((previous / legacy(d).STATE_FILE).read_text()).get('workspaceVolumeAfter')
    d.require(isinstance(workspace, dict), 'ONLINE_RECHARGE_WORKSPACE_ORIGIN_INVALID')
    workspace_guard(d, target if include_engine else previous, workspace)
    d.require(d.migration_plan(previous, target) == [MIGRATION_FILE], 'ONLINE_RECHARGE_MIGRATION_SCOPE_CHANGED')
    states = snapshot(d, target if include_engine else previous, include_engine=include_engine)
    d.require(all(states[n] == before[n] for n in before if all_services or n in PRESERVED),
              'ONLINE_RECHARGE_PRESERVED_CONTAINER_CHANGED')
    if not all_services:
        d.require(states['caddy']['image'] == before['caddy']['image']
                  and states['caddy']['reference'] == before['caddy']['reference'],
                  'ONLINE_RECHARGE_CADDY_IMAGE_CHANGED')
    old = json.loads((previous / 'compose.release.json').read_text())
    new = json.loads((target / 'compose.release.json').read_text())
    d.require(set(old) == set(new) == {'services'} and set(new['services']) == set(old['services']) | {'online-recharge'}
              and all(new['services'][n] == old['services'][n] for n in old['services'] if n not in IMAGE_SERVICES),
              'ONLINE_RECHARGE_PRESERVED_IMAGE_REFERENCE_CHANGED')
    return states, {'environment': env, 'compose': infrastructure, 'caddy': caddy}


def protected_source(d, previous, target):
    """Preserve the published registration resources and legacy worker sources."""
    def inventory(root, worker):
        rows = {}
        for path in (root / worker).rglob('*'):
            d.require(not path.is_symlink(), 'ONLINE_RECHARGE_LEGACY_SOURCE_CHANGED')
            if path.is_file():
                rows[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
        d.require(bool(rows), 'ONLINE_RECHARGE_LEGACY_SOURCE_UNAVAILABLE')
        return rows
    for worker in ('apps/api/src/id-business-v2/auto-recharge/worker',
                   'apps/api/src/id-business-v2/auto-registration'):
        d.require(inventory(previous, worker) == inventory(target, worker), 'ONLINE_RECHARGE_LEGACY_SOURCE_CHANGED')
    for name in ('scripts/v2-data-integrity-audit.mjs', 'scripts/lib/v2-data-integrity-audit.mjs',
                 'scripts/sync-v2-new-table-grants.mjs', 'scripts/lib/v2-production-database-access.mjs'):
        d.require((previous / name).is_file() and (target / name).is_file()
                  and not (previous / name).is_symlink() and not (target / name).is_symlink(),
                  'ONLINE_RECHARGE_SHARED_GATE_SOURCE_CHANGED')
        if name == GRANT_SOURCE and (previous / name).read_bytes() != (target / name).read_bytes():
            grant_source_change(d, previous, target)
        else:
            d.require((previous / name).read_bytes() == (target / name).read_bytes(),
                      'ONLINE_RECHARGE_SHARED_GATE_SOURCE_CHANGED')


def workspace_guard(d, directory, expected=None):
    volume = legacy(d).workspace_volume(d, directory, attached=True)
    d.require(volume.get('status') == 'PRESENT' and (expected is None or volume == expected),
              'ONLINE_RECHARGE_WORKSPACE_VOLUME_CHANGED')
    d.require(legacy(d).workspace_idle(d, directory) == volume, 'ONLINE_RECHARGE_WORKSPACE_VOLUME_CHANGED')
    return volume


def workspace_files(d, directory):
    names = ('release-manifest.json', legacy(d).PROOF_FILE, legacy(d).STATE_FILE,
             'backup-verification.json', 'before-audit.json', 'after-audit.json')
    result = {}
    for name in names:
        path = directory / name
        d.require(path.is_file() and not path.is_symlink(), 'ONLINE_RECHARGE_WORKSPACE_ORIGIN_INVALID')
        result[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def baseline(d, expected):
    """Only the genuinely published workspace release can be the predecessor.

    The workspace reader's empty-volume first-publication rule is deliberately
    not reused: its complete readback proves publication, and this scope backs
    up the already active SQLite workspace before stopping its owner API.
    """
    d.require(expected == BASELINE_COMMIT, 'ONLINE_RECHARGE_BASELINE_NOT_APPROVED')
    previous = (d.BASE / 'current').resolve()
    d.require(previous.parent == d.BASE / 'releases', 'ONLINE_RECHARGE_READBACK_PATH_INVALID')
    recovery = release_recovery(d, previous)
    reader = historical_controller(d, previous, recovery['source']) if recovery is not None else d
    previous, manifest, states, evidence = legacy(d).baseline(reader, expected, check_jobs=False)
    d.require(manifest.get('apiWorkspacePublication', {}).get('scope') == 'API_ADMIN_WORKSPACE'
              and evidence.get('apiSource', {}).get('kind') == 'API_WORKSPACE_BUILD_PROVEN'
              and not manifest.get('apiAdminPublication'), 'ONLINE_RECHARGE_WORKSPACE_NOT_PUBLISHED')
    receipt = legacy(d).readback(reader, expected)
    d.require(receipt.get('status') == 'API_ADMIN_WORKSPACE_VERIFIED'
              and receipt.get('volumePreserved') is True and receipt.get('volumeDeletionPerformed') is False
              and receipt.get('registrationHealthChecked') is True and receipt.get('services') == states,
              'ONLINE_RECHARGE_WORKSPACE_ORIGIN_INVALID')
    if recovery is not None:
        original = recovery['policy']['preflight']
        d.require(evidence['manifestSha256'] == original['manifestSha256'],
                  'ONLINE_RECHARGE_READBACK_PROVENANCE_CHANGED')
        d.require(receipt['buildProofSha256'] == original['workspaceBuildProofSha256'],
                  'ONLINE_RECHARGE_PRESERVED_CONTAINER_CHANGED')
        recovery_services(d, states, recovery)
        verify_permission_seed(d, recovery['source'])
        require_fresh_resources(d, recovery['source'])
        jobs_idle(d, previous, migrated=True)
    volume = workspace_guard(d, previous, evidence.get('workspaceVolume'))
    evidence = {**evidence, 'guards': jobs_idle(d, previous), 'workspaceIdle': True,
                'workspaceVolume': volume, 'workspaceOriginFiles': workspace_files(d, previous),
                'workspaceBuildProofSha256': receipt['buildProofSha256']}
    if recovery is not None:
        evidence['migrationRecovery'] = recovery['marker']
    workspace_origin(d, previous, previous, evidence, states)
    d.require(shutil.disk_usage(d.BASE).free > 6 * 1024**3, 'ONLINE_RECHARGE_DISK_LOW_BEFORE_PULL')
    d.require((d.BASE / 'current').resolve() == previous and snapshot(d, previous) == states,
              'ONLINE_RECHARGE_BASELINE_MOVED')
    return previous, manifest, states, evidence


def workspace_origin(d, previous, directory, evidence, before):
    """Prove the sealed predecessor before and after replacement of its API."""
    shared = legacy(d)
    # The predecessor manifest records managed images; MySQL and Caddy are
    # protected by the complete snapshot and separate configuration guards.
    d.require(isinstance(before, dict) and set(before) == set((*PRESERVED, 'api', 'admin'))
              and all(n in before for n in d.SERVICES), 'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED')
    d.require(workspace_files(d, previous) == evidence.get('workspaceOriginFiles'),
              'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED')
    manifest = json.loads((previous / 'release-manifest.json').read_text())
    record = json.loads((previous / shared.STATE_FILE).read_text())
    proof = shared.validate_proof(d, json.loads((previous / shared.PROOF_FILE).read_text()),
                                  BASELINE_COMMIT, manifest.get('sourceTree'))
    d.require(manifest.get('commit') == BASELINE_COMMIT and manifest.get('servicesUpdated') == list(shared.UPDATED)
              and manifest.get('apiWorkspacePublication') == {'version': 1, 'scope': 'API_ADMIN_WORKSPACE',
                  'buildProofSha256': fingerprint(proof), 'workersPublished': False, 'cacheStatus': 'SKIPPED',
                  'configurationChanged': True, 'volume': record.get('workspaceVolumeAfter'),
                  'volumeDeletionPerformed': False}
              and fingerprint(proof) == evidence.get('workspaceBuildProofSha256') == record.get('buildProofSha256')
              and record.get('workspaceVolumeAfter') == evidence.get('workspaceVolume')
              and isinstance(record.get('after'), dict) and set(record['after']) == set(before)
              and all(record['after'][n] == before[n] for n in PRESERVED)
              and all(isinstance(record['after'][n], dict)
                      and set(record['after'][n]) == set(SERVICE_IDENTITY_KEYS)
                      and all(record['after'][n][k] == before[n][k] for k in SERVICE_IDENTITY_KEYS
                              if k not in ('containerId', 'startedAtSha256'))
                      for n in ('api', 'admin'))
              and all(manifest.get('images', {}).get(n, {}).get('digest') == before[n]['image']
                      and manifest['images'][n].get('reference') == before[n]['reference'] for n in d.SERVICES),
              'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED')
    for service in shared.IMAGE_SERVICES:
        row = proof['images'][service]
        inspect_image(d, row, BASELINE_COMMIT, proof['sourceTree'])
        measured = shared.content_summary(d, service, d.run('docker', 'run', '--rm', '--network', 'none',
            '--read-only', '--entrypoint', '/bin/sh', row['reference'], '-c', shared.content_command(service)))
        d.require(measured == {n: row[n] for n in ('fileCount', 'sha256')},
                  'ONLINE_RECHARGE_WORKSPACE_IMAGE_CHANGED')
    workspace_guard(d, directory, evidence['workspaceVolume'])
    shared.workspace_health(d, directory)


def preflight(d, expected):
    previous, manifest, states, evidence = baseline(d, expected)
    migration_source_check(d, previous, candidate=False)
    recovery = release_recovery(d, previous) if evidence.get('migrationRecovery') is not None else None
    migration = recovery['state'] if recovery is not None else migration_database_state(d, previous)
    d.require(migration['status'] == ('APPLIED' if recovery is not None else 'PENDING'),
              'ONLINE_RECHARGE_MIGRATION_ALREADY_PRESENT')
    # Running legacy browser windows are preserved; no close/cancel endpoint is called.
    audit = legacy(d).strict_audit(d, previous, Path(__file__).parent / 'online-recharge-preflight-audit.json')
    d.require(snapshot(d, previous) == states and (d.BASE / 'current').resolve() == previous,
              'ONLINE_RECHARGE_PREFLIGHT_MOVED')
    return {'status': SCOPE + '_BASELINE_VERIFIED', 'commit': expected, 'services': states,
            **evidence, 'audit': audit, 'migration': dict(MIGRATION_IDENTITY), 'migrationState': migration,
            'workersPreserved': True, 'requiresWindowHandoff': False}


def file_digest(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def workspace_database(d, directory, expected):
    workspace_guard(d, directory, expected)
    rows = json.loads(d.run('docker', 'volume', 'inspect', expected['name']))
    d.require(isinstance(rows, list) and len(rows) == 1, 'ONLINE_RECHARGE_WORKSPACE_VOLUME_CHANGED')
    root = Path(rows[0].get('Mountpoint', ''))
    path = root / 'database.db'
    d.require(root.is_absolute() and root.resolve() == root and root.is_dir() and not root.is_symlink()
              and path.is_file() and not path.is_symlink()
              and all(not (root / ('database.db' + suffix)).is_symlink() for suffix in ('-wal', '-shm', '-journal')),
              'ONLINE_RECHARGE_WORKSPACE_DATABASE_INVALID')
    return path


def sqlite_verified(d, connection):
    d.require(connection.execute('PRAGMA integrity_check').fetchall() == [('ok',)],
              'ONLINE_RECHARGE_WORKSPACE_INTEGRITY_FAILED')
    rows = connection.execute('SELECT status, COUNT(*) FROM registration_tasks GROUP BY status').fetchall()
    d.require(all(status in ('pending', 'running', 'completed', 'failed', 'cancelled')
                  and type(count) is int and count >= 0 for status, count in rows)
              and sum(count for status, count in rows if status in ('pending', 'running')) == 0,
              'ONLINE_RECHARGE_WORKSPACE_TASK_ACTIVE')


def workspace_backup_location(d, directory, name):
    d.require(re.fullmatch(r'id-business-v2-online-recharge-workspace-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}\.sqlite3\.gz', name or ''),
              'ONLINE_RECHARGE_WORKSPACE_BACKUP_NAME_INVALID')
    values = d.environment_values(directory / '.env.aws.production')
    bucket = values.get('MYSQL_BACKUP_S3_BUCKET', '')
    region = values.get('MYSQL_BACKUP_S3_REGION') or 'ap-northeast-1'
    prefix = values.get('MYSQL_BACKUP_S3_PREFIX', 'mysql/daily').rstrip('/')
    d.require(re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', bucket)
              and re.fullmatch(r'[a-z0-9-]+', region)
              and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9/_-]{0,199}', prefix)
              and '..' not in prefix.split('/'), 'ONLINE_RECHARGE_WORKSPACE_BACKUP_CONFIG_INVALID')
    root = d.BASE / 'backups/registration-workspace'
    d.require(d.BASE.is_absolute() and d.BASE.resolve() == d.BASE and not root.is_symlink(),
              'ONLINE_RECHARGE_WORKSPACE_BACKUP_PATH_INVALID')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    d.require(root.resolve() == root and root.is_dir(), 'ONLINE_RECHARGE_WORKSPACE_BACKUP_PATH_INVALID')
    os.chmod(root, 0o700)
    return root / name, bucket, prefix + '/' + name, region


def workspace_s3_verify(d, path, bucket, key, region, digest):
    head = json.loads(d.run('aws', 's3api', 'head-object', '--bucket', bucket, '--key', key,
                           '--checksum-mode', 'ENABLED', '--region', region))
    d.require(head.get('ContentLength') == path.stat().st_size
              and head.get('ChecksumSHA256') == base64.b64encode(bytes.fromhex(digest)).decode()
              and head.get('ServerSideEncryption') == 'AES256', 'ONLINE_RECHARGE_WORKSPACE_S3_UNVERIFIED')


def workspace_backup(d, directory, expected, commit, stamp):
    """Consistent SQLite online backup includes committed WAL without copying raw files."""
    source = workspace_database(d, directory, expected)
    name = f'id-business-v2-online-recharge-workspace-{stamp}-{commit[:12]}.sqlite3.gz'
    path, bucket, key, region = workspace_backup_location(d, directory, name)
    working = path.with_suffix('.working')
    d.require(not path.exists() and not working.exists(), 'ONLINE_RECHARGE_WORKSPACE_BACKUP_EXISTS')
    try:
        descriptor = os.open(working, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(descriptor)
        with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=2)) as origin:
            origin.execute('PRAGMA query_only = ON')
            sqlite_verified(d, origin)
            with closing(sqlite3.connect(working, timeout=2)) as destination:
                # Bound contention rather than waiting forever on an active writer.
                deadline = time.monotonic() + 60
                def progress(status, remaining, total):
                    d.require(time.monotonic() < deadline, 'ONLINE_RECHARGE_WORKSPACE_BACKUP_TIMEOUT')
                origin.backup(destination, pages=256, progress=progress, sleep=0.05)
                d.require(destination.execute('PRAGMA journal_mode=DELETE').fetchall() == [('delete',)],
                          'ONLINE_RECHARGE_WORKSPACE_BACKUP_FAILED')
                sqlite_verified(d, destination)
        workspace_guard(d, directory, expected)
        with path.open('xb') as output:
            os.chmod(path, 0o600)
            with gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0) as zipped, working.open('rb') as copied:
                shutil.copyfileobj(copied, zipped)
        digest = file_digest(path)
        d.run('aws', 's3api', 'put-object', '--bucket', bucket, '--key', key, '--body', str(path),
              '--server-side-encryption', 'AES256', '--checksum-algorithm', 'SHA256',
              '--checksum-sha256', base64.b64encode(bytes.fromhex(digest)).decode(), '--region', region, timeout=300)
        workspace_s3_verify(d, path, bucket, key, region, digest)
        workspace_guard(d, directory, expected)
        return {'version': 1, 'name': name, 'sha256': digest, 'size': path.stat().st_size,
                'workspaceVolume': expected, 'integrityCheck': 'ok', 'idleSnapshot': True,
                'onlineBackup': True, 's3Verified': True}
    except sqlite3.Error:
        raise RuntimeError('ONLINE_RECHARGE_WORKSPACE_BACKUP_FAILED') from None
    finally:
        if working.exists():
            working.unlink()


def workspace_backup_receipt(d, directory, previous, evidence, manifest, record):
    value = json.loads((directory / WORKSPACE_BACKUP_FILE).read_text())
    d.require(set(value) == {'version', 'name', 'sha256', 'size', 'workspaceVolume', 'integrityCheck',
                             'idleSnapshot', 'onlineBackup', 's3Verified'}
              and value.get('version') == 1 and value.get('workspaceVolume') == evidence['workspaceVolume']
              and value.get('name') == manifest.get('workspaceBackupBeforeRelease')
              and value['name'].endswith('-' + manifest.get('commit', '')[:12] + '.sqlite3.gz')
              and fingerprint(value) == manifest.get('workspaceBackupSha256') == record.get('workspaceBackupSha256')
              and value.get('integrityCheck') == 'ok'
              and all(value.get(n) is True for n in ('idleSnapshot', 'onlineBackup', 's3Verified'))
              and type(value.get('size')) is int and value['size'] > 0
              and re.fullmatch(r'[a-f0-9]{64}', value.get('sha256', '')),
              'ONLINE_RECHARGE_WORKSPACE_BACKUP_RECEIPT_CHANGED')
    path, bucket, key, region = workspace_backup_location(d, previous, value['name'])
    d.require(path.is_file() and not path.is_symlink() and path.stat().st_size == value['size']
              and file_digest(path) == value['sha256'], 'ONLINE_RECHARGE_WORKSPACE_BACKUP_CHANGED')
    working = path.with_suffix('.readback')
    d.require(not working.exists(), 'ONLINE_RECHARGE_WORKSPACE_BACKUP_PATH_INVALID')
    try:
        with working.open('xb') as output:
            os.chmod(working, 0o600)
            with gzip.open(path, 'rb') as zipped:
                shutil.copyfileobj(zipped, output)
        with closing(sqlite3.connect(working.as_uri() + '?mode=ro', uri=True, timeout=2)) as connection:
            connection.execute('PRAGMA query_only = ON')
            sqlite_verified(d, connection)
        workspace_s3_verify(d, path, bucket, key, region, value['sha256'])
    except (sqlite3.Error, OSError, EOFError):
        raise RuntimeError('ONLINE_RECHARGE_WORKSPACE_BACKUP_INVALID') from None
    finally:
        if working.exists():
            working.unlink()
    workspace_guard(d, directory, evidence['workspaceVolume'])
    return value


def projection_diagnostic(d, expected):
    """Read only, bounded cause classification for an existing baseline failure.

    Python retains the original exception context even when the legacy controller
    intentionally suppresses its message. Inspect types and known function names,
    never its message, arbitrary key, path, stdout or production configuration.
    This diagnostic does not authorize or relax the failed gate.
    """
    d.require(expected == BASELINE_COMMIT, 'ONLINE_RECHARGE_BASELINE_NOT_APPROVED')
    d._onlineRechargeIdentityDiagnostic = None
    d._onlineRechargeProjectionDiagnostic = True
    try:
        baseline(d, expected)
        return {'status': 'ONLINE_RECHARGE_PROJECTION_DIAGNOSTIC', 'commit': expected,
                'baselineConfirmed': True, 'reason': 'BASELINE_GATE_PASSED', 'rawOutputSuppressed': True}
    except Exception as error:
        inner = error.__context__ or error
        known = {'FileNotFoundError', 'KeyError', 'TypeError', 'AttributeError', 'ValueError',
                 'RuntimeError', 'JSONDecodeError', 'PermissionError'}
        kind = type(inner).__name__
        kind = kind if kind in known else 'OtherError'
        traceback = inner.__traceback__
        names = []
        while traceback is not None:
            names.append(traceback.tb_frame.f_code.co_name)
            traceback = traceback.tb_next
        phases = (
            ('migration_successor_guard', 'HISTORICAL_MIGRATION_ORIGIN'),
            ('migration_successor_origin', 'HISTORICAL_MIGRATION_ORIGIN'),
            ('verify_running', 'PUBLISHED_IMAGE_CONTENT'),
            ('validate_proof', 'PUBLISHED_BUILD_PROOF'),
            ('registration_recovery_image_labels', 'LEGACY_API_PROJECTION_LABELS'),
            ('registration_recovery_api_hashes', 'LEGACY_API_PROJECTION_SOURCE'),
            ('registration_profile', 'LEGACY_PROFILE_SCHEMA'),
            ('check_registration_interstitial_deployment', 'RETAINED_PROFILE_ORIGIN'),
            ('check_registration_followup_deployment', 'RETAINED_PROFILE_ORIGIN'),
        )
        phase = next((label for name, label in phases if name in names), 'BASELINE_PROJECTION')
        result = {'status': 'ONLINE_RECHARGE_PROJECTION_DIAGNOSTIC', 'commit': expected,
                  'baselineConfirmed': False, 'gateCode': safe_code(error), 'reason': phase,
                  'causeType': kind, 'rawOutputSuppressed': True}
        if (result['gateCode'] == 'ONLINE_RECHARGE_PRESERVED_CONTAINER_CHANGED'
                and phase == 'BASELINE_PROJECTION' and d._onlineRechargeIdentityDiagnostic is not None):
            result.update(d._onlineRechargeIdentityDiagnostic)
        return validate_diagnostic(d, result, expected)
    finally:
        d._onlineRechargeProjectionDiagnostic = False
        d._onlineRechargeIdentityDiagnostic = None


def validate_diagnostic(d, value, expected):
    passed = {'status', 'commit', 'baselineConfirmed', 'reason', 'rawOutputSuppressed'}
    failed = passed | {'gateCode', 'causeType'}
    details = {'identityDiff', 'restoredProjectionMatch'}
    classified = details | {'restoredProjectionReason'}
    reasons = {'HISTORICAL_MIGRATION_ORIGIN', 'PUBLISHED_IMAGE_CONTENT', 'PUBLISHED_BUILD_PROOF',
               'LEGACY_API_PROJECTION_LABELS', 'LEGACY_API_PROJECTION_SOURCE', 'LEGACY_PROFILE_SCHEMA',
               'RETAINED_PROFILE_ORIGIN', 'BASELINE_PROJECTION'}
    kinds = {'FileNotFoundError', 'KeyError', 'TypeError', 'AttributeError', 'ValueError',
             'RuntimeError', 'JSONDecodeError', 'PermissionError', 'OtherError'}
    d.require(expected == BASELINE_COMMIT and isinstance(value, dict)
              and value.get('status') == 'ONLINE_RECHARGE_PROJECTION_DIAGNOSTIC'
              and value.get('commit') == expected and value.get('rawOutputSuppressed') is True
              and type(value.get('baselineConfirmed')) is bool,
              'ONLINE_RECHARGE_DIAGNOSTIC_RECEIPT_INVALID')
    d.require((value['baselineConfirmed'] and set(value) == passed and value.get('reason') == 'BASELINE_GATE_PASSED')
              or (not value['baselineConfirmed'] and set(value) in (failed, failed | details, failed | classified)
                  and isinstance(value.get('reason'), str) and value['reason'] in reasons
                  and isinstance(value.get('causeType'), str) and value['causeType'] in kinds
                  and isinstance(value.get('gateCode'), str)
                  and re.fullmatch(r'(?:ONLINE_RECHARGE|API_ADMIN)_[A-Z0-9_]+', value.get('gateCode', ''))),
              'ONLINE_RECHARGE_DIAGNOSTIC_RECEIPT_INVALID')
    if set(value) in (failed | details, failed | classified):
        diff, matches = value['identityDiff'], value['restoredProjectionMatch']
        d.require(value['reason'] == 'BASELINE_PROJECTION'
                  and value['gateCode'] == 'ONLINE_RECHARGE_PRESERVED_CONTAINER_CHANGED'
                  and isinstance(diff, dict) and set(diff) == set((*PRESERVED, 'api', 'admin'))
                  and all(isinstance(fields, list) and len(fields) <= len(SERVICE_IDENTITY_KEYS)
                          and all(isinstance(k, str) and k in SERVICE_IDENTITY_KEYS for k in fields)
                          and fields == [k for k in SERVICE_IDENTITY_KEYS if k in fields] for fields in diff.values())
                  and isinstance(matches, dict) and set(matches) == {'api', 'admin'}
                  and all(type(v) is bool for v in matches.values()), 'ONLINE_RECHARGE_DIAGNOSTIC_RECEIPT_INVALID')
        if 'restoredProjectionReason' in value:
            reason = value['restoredProjectionReason']
            d.require(isinstance(reason, dict) and set(reason) == {'api', 'admin'}
                      and all(isinstance(v, str) and v in PROJECTION_REASONS
                              and matches[n] is (v == 'MATCH') for n, v in reason.items()),
                      'ONLINE_RECHARGE_DIAGNOSTIC_RECEIPT_INVALID')
    return {k: value[k] for k in sorted(value)}


def validate_receipt(d, value, mode, commit, expected):
    """Bounded public summary; never return raw remote output or credentials."""
    d.require(mode in ('preflight', 'readback')
              and all(re.fullmatch(r'[a-f0-9]{40}', v or '') for v in (commit, expected))
              and isinstance(value, dict) and value.get('commit') == expected,
              'ONLINE_RECHARGE_RECEIPT_INVALID')
    status = SCOPE + ('_BASELINE_VERIFIED' if mode == 'preflight' else '_VERIFIED')
    d.require(value.get('status') == status and isinstance(value.get('services'), dict),
              'ONLINE_RECHARGE_RECEIPT_INVALID')
    services = value['services']
    expected_services = set((*PRESERVED, 'api', 'admin', *(() if mode == 'preflight' else ('online-recharge',))))
    d.require(set(services) == expected_services
              and all(isinstance(r, dict) and r.get('status') == 'running'
                      and (r.get('health') == 'healthy' if n != 'caddy' else r.get('health') in ('healthy', None))
                      and re.fullmatch(r'sha256:[a-f0-9]{64}', r.get('image', ''))
                      and re.fullmatch(r'[a-f0-9]{64}', r.get('containerId', ''))
                      and all(re.fullmatch(r'[a-f0-9]{64}', r.get(k, '')) for k in
                              ('startedAtSha256', 'environmentSha256', 'configurationSha256'))
                      for n, r in services.items()), 'ONLINE_RECHARGE_RECEIPT_SERVICES_CHANGED')
    if mode == 'preflight':
        guards, audit = value.get('guards', {}), value.get('audit', {})
        d.require(expected == BASELINE_COMMIT and value.get('migration') == MIGRATION_IDENTITY
                  and value.get('workersPreserved') is True and value.get('requiresWindowHandoff') is False
                  and guards.get('rechargeIdle') is True and guards.get('registrationBusy') is False
                  and guards.get('registrationLeaseActive') is False
                  and type(guards.get('registrationWindowRetained')) is bool
                  and audit.get('checkCount') == 49 and audit.get('violationCount') == 0
                  and audit.get('mode') == 'STRICT_ZERO_49'
                  and re.fullmatch(r'[a-f0-9]{64}', audit.get('checksSha256', ''))
                  and re.fullmatch(r'[a-f0-9]{64}', value.get('manifestSha256', ''))
                  and value.get('workspaceIdle') is True
                  and value.get('workspaceVolume', {}).get('status') == 'PRESENT'
                  and re.fullmatch(r'[a-f0-9]{64}', value.get('workspaceVolume', {}).get('identitySha256', ''))
                  and re.fullmatch(r'[a-f0-9]{64}', value.get('workspaceBuildProofSha256', '')),
                  'ONLINE_RECHARGE_RECEIPT_BASELINE_CHANGED')
        resumed = {}
        if value.get('migrationRecovery') is not None:
            d.require(value['migrationRecovery'] == recovery_marker(recovery_policy(d))
                      and value.get('migrationPerformed', False) is False
                      and value.get('migrationState', {}).get('status') == 'APPLIED'
                      and value['migrationState'].get('name') == MIGRATION_NAME
                      and value['migrationState'].get('sha256') == MIGRATION_IDENTITY['sha256']
                      and value['migrationState'].get('schemaVerified') is True,
                      'ONLINE_RECHARGE_RECEIPT_BASELINE_CHANGED')
            resumed = {'migrationRecovery': value['migrationRecovery'], 'migrationPerformed': False}
        return {'status': status, 'commit': expected, 'manifestSha256': value['manifestSha256'],
                'checkCount': 49, 'violationCount': 0, 'legacyWorkersPreserved': True,
                'requiresWindowHandoff': False, 'workspaceIdle': True,
                'workspaceVolumePreserved': True, 'workspaceBuildProofSha256': value['workspaceBuildProofSha256'],
                'migration': dict(MIGRATION_IDENTITY), **resumed}
    migration = value.get('migration', {})
    d.require(expected == commit and value.get('servicesUpdated') == list(UPDATED)
              and value.get('preservedServiceCount') == len(PRESERVED)
              and value.get('runningImagesAndContentMatched') is True and value.get('migrationApplied') is True
              and type(value.get('migrationPerformed')) is bool
              and migration.get('name') == MIGRATION_NAME and migration.get('sha256') == MIGRATION_IDENTITY['sha256']
              and migration.get('status') == 'APPLIED' and migration.get('schemaVerified') is True
              and re.fullmatch(r'[a-f0-9]{64}', migration.get('appliedMigrationsSha256', ''))
              and all(value.get(n) is True for n in ('existingEnvironmentPreserved', 'credentialsLoopback', 'backupVerified',
                                                    'workspaceBackupVerified', 'workspaceVolumePreserved'))
              and value.get('legacyWorkersPublished') is False and value.get('externalAcceptancePerformed') is False
              and value.get('dedicatedVolume') == MEDIA_VOLUME and value.get('checkCount') == 49
              and value.get('violationCount') == 0
              and re.fullmatch(r'[a-f0-9]{40}', value.get('sourceTree', ''))
              and re.fullmatch(r'[a-f0-9]{64}', value.get('buildProofSha256', '')),
              'ONLINE_RECHARGE_RECEIPT_READBACK_CHANGED')
    resumed = {}
    if value.get('migrationRecovery') is not None:
        d.require(value['migrationRecovery'] == recovery_marker(recovery_policy(d))
                  and value['migrationPerformed'] is False, 'ONLINE_RECHARGE_RECEIPT_READBACK_CHANGED')
        resumed['migrationRecovery'] = value['migrationRecovery']
    else:
        d.require(value['migrationPerformed'] is True, 'ONLINE_RECHARGE_RECEIPT_READBACK_CHANGED')
    return {**{n: value[n] for n in ('status', 'commit', 'sourceTree', 'servicesUpdated', 'preservedServiceCount',
        'buildProofSha256', 'migrationApplied', 'migrationPerformed', 'backupVerified', 'checkCount', 'violationCount',
        'workspaceBackupVerified', 'workspaceVolumePreserved', 'existingEnvironmentPreserved', 'credentialsLoopback',
        'dedicatedVolume', 'legacyWorkersPublished', 'externalAcceptancePerformed')}, **resumed}


def verify_running(d, directory, proof):
    for service in UPDATED:
        row = proof['images'][service]
        state = d.service_state(directory, service)
        d.require(state['image'] == row['imageId'] and state['reference'] == row['reference'],
                  'ONLINE_RECHARGE_RUNNING_IMAGE_CHANGED')
        inspect_image(d, row, proof['commit'], proof['sourceTree'])
        measured = content_summary(d, service, d.compose(directory, 'exec', '-T', service,
            '/bin/sh', '-c', content_command(service)))
        d.require(measured == {n: row[n] for n in ('fileCount', 'sha256')},
                  'ONLINE_RECHARGE_RUNNING_CONTENT_CHANGED')


def backup_receipt(d, directory, manifest):
    value = json.loads((directory / 'backup-verification.json').read_text())
    d.require(value.get('name') == manifest.get('backupBeforeRelease') and value.get('s3Verified') is True
              and type(value.get('size')) is int and value['size'] > 0
              and re.fullmatch(r'[a-f0-9]{64}', value.get('sha256', '')),
              'ONLINE_RECHARGE_BACKUP_RECEIPT_CHANGED')
    return value


def readback(d, expected):
    directory = (d.BASE / 'current').resolve()
    d.require(directory.parent == d.BASE / 'releases' and not directory.is_symlink(),
              'ONLINE_RECHARGE_READBACK_PATH_INVALID')
    manifest_raw = (directory / 'release-manifest.json').read_bytes()
    manifest = json.loads(manifest_raw)
    proof = validate_proof(d, json.loads((directory / PROOF_FILE).read_text()), expected, manifest.get('sourceTree'))
    record = json.loads((directory / STATE_FILE).read_text())
    previous = Path(manifest.get('previousRelease', ''))
    d.require(previous.parent == d.BASE / 'releases' and not previous.is_symlink()
              and manifest.get('commit') == expected and manifest.get('previousCommit') == BASELINE_COMMIT
              and manifest.get('servicesUpdated') == list(UPDATED)
              and manifest.get('newMigrations') == [MIGRATION_FILE] and manifest.get('migrationApplied') is True
              and manifest.get('onlineRechargePublication') == {
                  'version': 1, 'scope': SCOPE, 'buildProofSha256': fingerprint(proof),
                  'migration': dict(MIGRATION_IDENTITY), 'legacyWorkersPublished': False,
                  'configurationScope': 'ONLINE_RECHARGE_VOLUME_LOOPBACK_ONLY'}
              and record.get('buildProofSha256') == fingerprint(proof)
              and hashlib.sha256((previous / 'release-manifest.json').read_bytes()).hexdigest()
                  == manifest.get('previousManifestSha256') == record['baselineEvidence']['manifestSha256'],
              'ONLINE_RECHARGE_READBACK_PROVENANCE_CHANGED')
    d.require(json.loads((previous / 'release-manifest.json').read_text()).get('commit') == BASELINE_COMMIT
              and configuration_hashes(previous) == record['configurationBefore']
              and configuration_hashes(directory) == record['configurationAfter'],
              'ONLINE_RECHARGE_READBACK_SOURCE_CHANGED')
    recovered = {}
    if record['baselineEvidence'].get('migrationRecovery') is not None:
        recovery = release_recovery(d, previous)
        d.require(recovery is not None and manifest.get('migrationRecovery') == recovery['marker']
                  == record['baselineEvidence']['migrationRecovery'] and record['migration']['performed'] is False,
                  'ONLINE_RECHARGE_READBACK_PROVENANCE_CHANGED')
        candidate_recovery_source(d, directory, recovery)
        recovered['migrationRecovery'] = recovery['marker']
    else:
        d.require(manifest.get('migrationRecovery') is None and record['migration']['performed'] is True,
                  'ONLINE_RECHARGE_READBACK_PROVENANCE_CHANGED')
    d.require(fingerprint(file_inventory(d, directory / ENGINE_ROOT)) == proof['engineSourceSha256']
              and hashlib.sha256((directory / 'docker-compose.aws-mysql.yml').read_bytes()).hexdigest() == proof['composeSourceSha256'],
              'ONLINE_RECHARGE_READBACK_SOURCE_CHANGED')
    protected_source(d, previous, directory)
    states, preservation = require_preserved(d, previous, directory, record['before'],
        (previous / '.env.aws.production').read_bytes(), include_engine=True)
    d.require(preservation == record['preservation']
              and all(states[n] == record['after'][n] for n in PRESERVED),
              'ONLINE_RECHARGE_READBACK_PRESERVATION_CHANGED')
    historical_guard(d, previous, record['baselineEvidence'], directory)
    workspace_origin(d, previous, directory, record['baselineEvidence'], record['before'])
    migration = migration_database_state(d, directory)
    d.require(migration['status'] == 'APPLIED'
              and all(record['migration'].get(n) == v for n, v in migration.items())
              and manifest.get('migrationPerformed') is record['migration']['performed'],
              'ONLINE_RECHARGE_READBACK_MIGRATION_CHANGED')
    verify_permission_seed(d, directory)
    before = legacy(d).audit_receipt(d, directory / 'before-audit.json')
    after = legacy(d).audit_receipt(d, directory / 'after-audit.json')
    d.require(before == manifest.get('dataAuditBefore') and after == manifest.get('dataAuditAfter')
              and before['checksSha256'] == after['checksSha256'], 'ONLINE_RECHARGE_READBACK_AUDIT_CHANGED')
    backup_receipt(d, directory, manifest)
    workspace_backup_receipt(d, directory, previous, record['baselineEvidence'], manifest, record)
    verify_running(d, directory, proof)
    verify_image_content(d, directory, proof, 'migrate')
    d.require(snapshot(d, directory, include_engine=True) == states and (d.BASE / 'current').resolve() == directory
              and (directory / 'release-manifest.json').read_bytes() == manifest_raw,
              'ONLINE_RECHARGE_READBACK_MOVED')
    return {'status': SCOPE + '_VERIFIED', 'commit': expected, 'sourceTree': proof['sourceTree'],
            'servicesUpdated': list(UPDATED), 'preservedServiceCount': len(PRESERVED),
            'services': states, 'runningImagesAndContentMatched': True,
            'buildProofSha256': fingerprint(proof), 'migration': migration,
            'migrationApplied': True, 'migrationPerformed': record['migration']['performed'],
            'existingEnvironmentPreserved': True, 'credentialsLoopback': True, 'dedicatedVolume': MEDIA_VOLUME,
            'backupVerified': True, 'workspaceBackupVerified': True, 'workspaceVolumePreserved': True,
            'checkCount': 49, 'violationCount': 0,
            'legacyWorkersPublished': False, 'externalAcceptancePerformed': False, **recovered}


def safe_code(error):
    code = str(error)
    return code if re.fullmatch(r'(?:ONLINE_RECHARGE|API_ADMIN)_[A-Z0-9_]+', code) else 'ONLINE_RECHARGE_STEP_FAILED'


def release(d, args):
    os.umask(0o077)
    try:
        with (d.BASE / '.deploy.lock').open('a') as lock:
            d.fcntl.flock(lock, d.fcntl.LOCK_EX | d.fcntl.LOCK_NB)
            return _release_locked(d, args)
    except Exception as error:
        print(json.dumps({'status': SCOPE + '_FAILED_STATE_UNVERIFIED', 'step': 'controller',
                          'code': safe_code(error), 'errorType': type(error).__name__}))
        return 1


def validate_arguments(d, args):
    d.require(getattr(args, 'online_recharge_only', False) is True
              and not any(value for key, value in vars(args).items()
                          if key.startswith(('historical_', 'registration_worker_', 'recharge_pro_'))
                          or key in ('admin_only', 'api_admin_only', 'api_registration_only', 'api_admin_migration_only',
                                     'api_workspace_only', 'image_commit', 'image_run_id', 'image_run_attempt', 'post_cleanup_seal_sha256',
                                     'order_archive_seal_sha256', 'order_archive_prepared_images_sha256')),
              'ONLINE_RECHARGE_SCOPE_CONFLICT')
    d.require(args.expected_current == BASELINE_COMMIT
              and all(re.fullmatch(r'[a-f0-9]{40}', v or '') for v in (args.commit, args.source_tree))
              and re.fullmatch(r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release', args.repository or '')
              and all(re.fullmatch(r'[1-9][0-9]*', v or '') for v in (args.run_id, args.run_attempt, args.ci_run_id)),
              'ONLINE_RECHARGE_INPUT_INVALID')
    encoded = getattr(args, 'online_recharge_build_proof', '')
    d.require(isinstance(encoded, str) and len(encoded) < 32768, 'ONLINE_RECHARGE_BUILD_PROOF_TOO_LARGE')
    raw = base64.b64decode(encoded, validate=True)
    d.require(len(raw) < 24000, 'ONLINE_RECHARGE_BUILD_PROOF_TOO_LARGE')
    return validate_proof(d, json.loads(raw), args.commit, args.source_tree, args.repository, args.run_id, args.run_attempt)


def extract_source(d, commit, target):
    with urllib.request.urlopen(f'https://github.com/wangchaozhuanyong/id-business-system/archive/{commit}.tar.gz', timeout=60) as response:
        data = response.read(128 * 1024 * 1024 + 1)
    d.require(len(data) <= 128 * 1024 * 1024, 'ONLINE_RECHARGE_SOURCE_TOO_LARGE')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        prefix = f'id-business-system-{commit}/'
        entries = archive.getmembers()
        d.require(len(entries) < 100000 and sum(m.size for m in entries) < 512 * 1024 * 1024
                  and all((m.name == prefix[:-1] or m.name.startswith(prefix))
                          and '..' not in Path(m.name).parts and (m.isfile() or m.isdir()) for m in entries),
                  'ONLINE_RECHARGE_SOURCE_ARCHIVE_INVALID')
        archive.extractall(target)
    extracted = target / prefix[:-1]
    for item in extracted.iterdir():
        item.rename(target / item.name)
    extracted.rmdir()
    return data


def rollback(d, previous, target, changed, before, *, migrated, workspace=None):
    restored, okay = {}, True
    for service in reversed(changed):
        try:
            # Never interrupt a newly accepted payment/maintenance task for rollback.
            jobs_idle(d, target if 'api' in changed else previous, migrated=migrated)
            if workspace is not None:
                workspace_guard(d, target if 'api' in changed else previous, workspace)
            if service == 'online-recharge':
                d.compose(target, 'rm', '-s', '-f', service, timeout=300)
                d.require(not d.compose(target, 'ps', '-q', '--all', service), 'ONLINE_RECHARGE_ROLLBACK_EXECUTOR_REMAINS')
            else:
                d.rollback_service(previous, target, service, before)
            restored[service] = 'RESTORED'
        except Exception:
            restored[service] = 'BLOCKED_OR_FAILED'
            okay = False
            # API owns the executor network namespace. If executor removal is
            # blocked, restoring API would terminate that active executor.
            if service in ('online-recharge', 'api'):
                break
    return okay, restored


def _release_locked(d, args):
    proof = validate_arguments(d, args)
    previous, old, before, evidence = baseline(d, args.expected_current)
    recovery = release_recovery(d, previous) if evidence.get('migrationRecovery') is not None else None
    d.require(recovery is None or evidence['migrationRecovery'] == recovery['marker'],
              'ONLINE_RECHARGE_READBACK_PROVENANCE_CHANGED')
    migration_source_check(d, previous, candidate=False)
    environment = (previous / '.env.aws.production').read_bytes()
    configuration_before = configuration_hashes(previous)
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    target = d.BASE / 'releases' / f'{stamp}-{args.commit[:12]}'
    d.require(not target.exists(), 'ONLINE_RECHARGE_RELEASE_EXISTS')
    target.mkdir(mode=0o700)
    changed, step = [], 'source'
    migration = {**recovery['state'], 'performed': False} if recovery is not None else {'status': 'NOT_ATTEMPTED', 'performed': False}
    migration_attempted = False
    try:
        workspace_origin(d, previous, previous, evidence, before)
        archive = extract_source(d, args.commit, target)
        d.require(legacy(d).source_tree(d, target) == args.source_tree, 'ONLINE_RECHARGE_SOURCE_TREE_CHANGED')
        migration_source_check(d, target)
        if recovery is not None:
            candidate_recovery_source(d, target, recovery)
        protected_source(d, previous, target)
        d.require(fingerprint(file_inventory(d, target / ENGINE_ROOT)) == proof['engineSourceSha256']
                  and hashlib.sha256((target / 'docker-compose.aws-mysql.yml').read_bytes()).hexdigest() == proof['composeSourceSha256'],
                  'ONLINE_RECHARGE_BUILD_SOURCE_CHANGED')
        for name in CONTROL_FILES:
            current = Path(__file__) if name.endswith('online-recharge-scope.py') else Path(d.__file__) if name.endswith('remote-deploy.py') else Path(__file__).with_name('api-admin-scope.py')
            d.require((target / name).read_bytes() == current.read_bytes(), 'ONLINE_RECHARGE_EXECUTOR_SOURCE_CHANGED')
        extend_environment(d, previous, target)
        override = json.loads((previous / 'compose.release.json').read_text())
        for service in IMAGE_SERVICES:
            override['services'][service] = {'image': proof['images'][service]['reference'], 'pull_policy': 'never'}
        (target / 'compose.release.json').write_text(json.dumps(override, indent=2) + '\n')
        require_preserved(d, previous, target, before, environment, all_services=True)
        migration = {**migration_database_state(d, previous, source=target), 'performed': False}
        d.require(migration['status'] == ('APPLIED' if recovery is not None else 'PENDING'),
                  'ONLINE_RECHARGE_MIGRATION_ALREADY_PRESENT')
        step = 'images'
        d.require(shutil.disk_usage(d.BASE).free > 6 * 1024**3, 'ONLINE_RECHARGE_DISK_LOW_BEFORE_PULL')
        password = d.run('aws', 'ecr', 'get-login-password', '--region', 'ap-northeast-1')
        registry = args.repository.split('/')[0]
        login = subprocess.run(['docker', 'login', '--username', 'AWS', '--password-stdin', registry],
                               input=password, capture_output=True, text=True)
        d.require(login.returncode == 0, 'ONLINE_RECHARGE_ECR_LOGIN_FAILED')
        try:
            for service in IMAGE_SERVICES:
                d.run('docker', 'pull', proof['images'][service]['reference'], timeout=900)
                verify_image_content(d, target, proof, service)
        finally:
            subprocess.run(['docker', 'logout', registry], capture_output=True, text=True)
        d.require(shutil.disk_usage(d.BASE).free > 2 * 1024**3, 'ONLINE_RECHARGE_DISK_LOW')
        step = 'audit-before'
        first = legacy(d).strict_audit(d, target, target / 'before-audit.json')
        step = 'backup'
        backup = d.fresh_backup(previous)
        (target / 'backup-verification.json').write_text(json.dumps(backup, indent=2) + '\n')
        d.require(backup.get('s3Verified') is True, 'ONLINE_RECHARGE_BACKUP_UNVERIFIED')
        step = 'workspace-backup'
        sqlite_backup = workspace_backup(d, previous, evidence['workspaceVolume'], args.commit, stamp)
        (target / WORKSPACE_BACKUP_FILE).write_text(json.dumps(sqlite_backup, indent=2) + '\n')
        d.require((d.BASE / 'current').resolve() == previous and hashlib.sha256((previous / 'release-manifest.json').read_bytes()).hexdigest() == evidence['manifestSha256'],
                  'ONLINE_RECHARGE_BASELINE_MOVED')
        require_preserved(d, previous, target, before, environment, all_services=True)
        jobs_idle(d, previous)
        historical_guard(d, previous, evidence, target)
        step = 'migration'
        migration_attempted = recovery is None
        if migration_attempted:
            d.compose(target, 'run', '--rm', '--no-deps', '--pull', 'never', 'migrate', timeout=900)
        migration = {**migration_database_state(d, target), 'performed': migration_attempted}
        d.require(migration['status'] == 'APPLIED', 'ONLINE_RECHARGE_MIGRATION_NOT_APPLIED')
        verify_permission_seed(d, target)
        require_fresh_resources(d, target)
        step = 'grants'
        grants = d.sync_new_table_grants(target, [MIGRATION_FILE])
        d.require(grants.get('ok') is True and grants.get('newTableCount') == len(TABLES), 'ONLINE_RECHARGE_DATABASE_GRANTS_FAILED')
        require_preserved(d, previous, target, before, environment, all_services=True)
        historical_guard(d, previous, evidence, target)
        step = 'switch'
        for service in SWITCH_ORDER:
            require_preserved(d, previous, target, before, environment)
            jobs_idle(d, previous, migrated=True)
            historical_guard(d, previous, evidence, target)
            # The first executor publication accepts no imported cards/CDKs/tasks.
            require_fresh_resources(d, target)
            changed.append(service)
            d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', service, timeout=300)
            d.wait_healthy(target, service)
        step = 'audit-after'
        second = legacy(d).strict_audit(d, target, target / 'after-audit.json')
        d.require(first['checksSha256'] == second['checksSha256'], 'ONLINE_RECHARGE_AUDIT_RULES_CHANGED')
        verify_running(d, target, proof)
        after, preservation = require_preserved(d, previous, target, before, environment, include_engine=True)
        historical_guard(d, previous, evidence, target)
        public = d.environment_values(target / '.env.aws.production')['APP_PUBLIC_URL'].rstrip('/')
        for suffix in ('/api/health/ready', '/'):
            with urllib.request.urlopen(public + suffix, timeout=20) as response:
                d.require(response.status == 200, 'ONLINE_RECHARGE_PUBLIC_HEALTH_FAILED')
        record = {'before': before, 'after': after, 'baselineEvidence': evidence, 'buildProofSha256': fingerprint(proof),
                  'configurationBefore': configuration_before, 'configurationAfter': configuration_hashes(target),
                  'preservation': preservation, 'migration': migration, 'databaseGrants': grants,
                  'workspaceBackupSha256': fingerprint(sqlite_backup)}
        (target / STATE_FILE).write_text(json.dumps(record, indent=2) + '\n')
        (target / PROOF_FILE).write_text(json.dumps(proof, indent=2) + '\n')
        manifest = {'commit': args.commit, 'sourceBranch': 'main', 'sourceTree': args.source_tree,
            'previousCommit': args.expected_current, 'previousRelease': str(previous),
            'previousManifestSha256': evidence['manifestSha256'], 'releaseTag': f'v2-production-{stamp}',
            'deployedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'ciWorkflow': 'Quality Gate', 'ciWorkflowRunId': int(args.ci_run_id),
            'deploymentRun': f'github-actions-{args.run_id}-{args.run_attempt}',
            'imageBuildRun': f'github-actions-{args.run_id}-{args.run_attempt}',
            'servicesUpdated': list(UPDATED), 'sourceArchiveSha256': hashlib.sha256(archive).hexdigest(),
            'images': {**old['images'], **{n: {'reference': proof['images'][n]['reference'], 'digest': proof['images'][n]['imageId'],
                       'sourceCommit': args.commit} for n in IMAGE_SERVICES}},
            'backupBeforeRelease': backup['name'], 'migrationApplied': True, 'migrationPerformed': migration['performed'],
            'workspaceBackupBeforeRelease': sqlite_backup['name'], 'workspaceBackupSha256': fingerprint(sqlite_backup),
            'newMigrations': [MIGRATION_FILE], 'dataAuditBefore': first, 'dataAuditAfter': second,
            'databaseGrants': grants, 'rollback': {'release': str(previous),
                'images': {n: before[n]['image'] for n in ('api', 'admin')}, 'servicesAdded': ['online-recharge'],
                'inverseMigrationAllowed': False, 'mediaVolumePreserved': True, 'workspaceVolumePreserved': True},
            'onlineRechargePublication': {'version': 1, 'scope': SCOPE, 'buildProofSha256': fingerprint(proof),
                'migration': dict(MIGRATION_IDENTITY), 'legacyWorkersPublished': False,
                'configurationScope': 'ONLINE_RECHARGE_VOLUME_LOOPBACK_ONLY'}}
        if evidence.get('migrationOrigin') is not None:
            manifest['preservedMigrationOrigin'] = legacy(d).migration_successor_marker(evidence['migrationOrigin'])
        if recovery is not None:
            manifest['migrationRecovery'] = recovery['marker']
        (target / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        d.require((d.BASE / 'current').resolve() == previous, 'ONLINE_RECHARGE_BASELINE_MOVED')
        d.point_current(target, f'{stamp}-publish')
        result = readback(d, args.commit)
        print(json.dumps(result))
        return 0
    except Exception as error:
        if migration_attempted:
            try:
                observed = migration_database_state(d, target)
                migration = {**observed, 'performed': observed['status'] == 'APPLIED'}
            except Exception:
                migration = {'status': 'UNVERIFIED', 'performed': None}
        okay, restored = rollback(d, previous, target, changed, before,
                                 migrated=migration.get('status') == 'APPLIED', workspace=evidence['workspaceVolume'])
        if okay:
            try:
                states = snapshot(d, previous)
                d.require((previous / '.env.aws.production').read_bytes() == environment
                          and configuration_hashes(previous) == configuration_before
                          and all(states[n] == before[n] for n in PRESERVED)
                          and all(states[n]['image'] == before[n]['image'] and states[n]['reference'] == before[n]['reference']
                                  for n in ('api', 'admin')), 'ONLINE_RECHARGE_ROLLBACK_NOT_RESTORED')
                workspace_guard(d, previous, evidence['workspaceVolume'])
                if migration.get('status') == 'APPLIED':
                    historical_guard(d, previous, evidence, target)
            except Exception:
                okay = False
        if migration.get('status') == 'UNVERIFIED':
            okay = False
        if okay and (d.BASE / 'current').resolve() == target:
            try:
                d.point_current(previous, f'{stamp}-recover')
            except Exception:
                okay = False
        result = {'status': SCOPE + '_FAILED_RESTORED' if changed and okay else SCOPE + '_FAILED_BEFORE_SWITCH'
                  if not changed and okay else SCOPE + '_PARTIAL_RECOVERY_REQUIRED',
                  'step': step, 'code': safe_code(error), 'errorType': type(error).__name__,
                  'rollbackOk': okay, 'rollback': restored, 'servicesAttempted': changed,
                  'candidateCommit': args.commit, 'previousCommit': args.expected_current,
                  'migration': migration, 'migrationAttempted': migration_attempted,
                  'inverseMigrationPerformed': False, 'mediaVolumeDeleted': False,
                  'currentPointsToCandidate': (d.BASE / 'current').resolve() == target, 'receiptPersisted': True}
        try:
            (target / FAILURE_FILE).write_text(json.dumps(result, indent=2) + '\n')
        except Exception:
            result['receiptPersisted'] = False
        print(json.dumps(result))
        return 1
