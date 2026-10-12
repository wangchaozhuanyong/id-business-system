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
import itertools
import json
import math
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
API_NATIVE_PATHS = ('Config.Labels.com.docker.compose.depends_on', 'HostConfig.Mounts', 'HostConfig.NetworkMode')
API_NATIVE_FAILURE_REASONS = frozenset(('ELIGIBILITY', 'OLD_SOURCE_BEFORE_PATH_CURRENT',
    'OLD_SOURCE_BEFORE_WORKSPACE_FILES', 'OLD_SOURCE_BEFORE_CONFIGURATION_FILES', 'OLD_SOURCE_BEFORE_ENV_FILE',
    'OLD_SOURCE_AFTER_WORKSPACE_FILES', 'OLD_SOURCE_AFTER_CONFIGURATION_FILES', 'OLD_SOURCE_AFTER_ENV_FILE',
    'DECLARATION_RENDER', 'DECLARATION', 'DEPENDENCY_DECLARATION_TYPE', 'DEPENDENCY_COUNT_LIMIT',
    'DEPENDENCY_NAME', 'DEPENDENCY_SERVICE', 'DEPENDENCY_ROW_TYPE', 'DEPENDENCY_CONDITION', 'DEPENDENCY_RESTART',
    'DEPENDENCY_LABEL_TYPE', 'DEPENDENCY_LABEL_SIZE', 'DEPENDENCY_LABEL_CONTENT', 'MOUNT_NULL_OR_TYPE',
    'MOUNT_COUNT_LIMIT', 'MOUNT_ROW_TARGET', 'MOUNT_DUPLICATE_TARGET', 'MOUNT_DECLARED_VOLUMES',
    'MOUNT_TARGET_SET_MISMATCH', 'MOUNT_BIND_DECLARATION', 'MOUNT_BIND_NAME', 'MOUNT_BIND_INSPECT',
    'MOUNT_BIND_HOST', 'MOUNT_BIND_MIXED', 'NETWORK_INPUT_TYPE', 'NETWORK_INPUT_SIZE', 'COMBINATION_LIMIT', 'PAYLOAD_LIMIT'))
API_NATIVE_REASONS = frozenset(('NOT_PROBED', 'PROBE_FAILED', 'NO_MATCH', 'AMBIGUOUS', 'MATCH')) | API_NATIVE_FAILURE_REASONS
API_NATIVE_MAX_BYTES = 16 * 1024 * 1024


class ProjectionRejection(RuntimeError):
    def __init__(self, reason):
        self.reason = reason
        super().__init__('ONLINE_RECHARGE_CONTAINER_CHANGED')


class ApiNativeProbeRejection(RuntimeError):
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
            'recordSha256': file_digest(source / STATE_FILE), 'configurationAnchors': anchors,
            'previous': previous, 'workspaceOriginFiles': evidence['workspaceOriginFiles'],
            'configurationBefore': record['configurationBefore'], 'environmentSha256': evidence['environmentSha256']}


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
        api_probe = {'matched': False, 'reason': 'NOT_PROBED', 'changedPaths': []}
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
                    if name == 'api' and reasons[name] == 'PROJECTED_HASH_MISMATCH':
                        api_probe = api_native_projection_probe(d, metadata[0], states[name], original[name], restored)
                except Exception:
                    # Never inspect arbitrary exceptions, Docker values or credentials.
                    reasons[name] = 'OTHER'
        d._onlineRechargeIdentityDiagnostic = {'identityDiff': diff, 'restoredProjectionMatch': matched,
                                               'restoredProjectionReason': reasons, 'apiNativeProbe': api_probe}
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
    # Compose v2.39.4 recreateContainer uses service.Name + api.Separator + number.
    native_slot = service + '-1'
    replace_key = 'com.docker.compose.replace'
    check(labels.get(replace_key) in (anchors['candidateAfterContainerId'], stable_name, native_slot), 'REPLACE_MISMATCH')
    projected = copy.deepcopy(configuration)
    projected['Config']['Hostname'] = original['containerId'][:12]
    matches = []
    for replacement in (anchors['oldBeforeContainerId'], stable_name, native_slot, None):
        if replacement is None:
            projected['Config']['Labels'].pop(replace_key, None)
        else:
            projected['Config']['Labels'][replace_key] = replacement
        if fingerprint(projected) == original['configurationSha256']:
            matches.append(replacement)
    check(len(matches) == 1, 'PROJECTED_HASH_AMBIGUOUS' if len(matches) > 1 else 'PROJECTED_HASH_MISMATCH')
    return {'rawSha256': raw_sha, 'projectedSha256': original['configurationSha256']}


def api_native_projection_probe(d, metadata, actual, original, restored):
    """Read-only bounded hypotheses; a match never approves the failed API gate."""
    failed = {'matched': False, 'reason': 'PROBE_FAILED', 'changedPaths': []}
    try:
        stage = 'ELIGIBILITY'
        def need(condition, unused):
            if not condition:
                raise ApiNativeProbeRejection(stage)
        # Only this probe's helpers classify their existing require checks.
        d = SimpleNamespace(**vars(d))
        d.require = need
        anchors = restored['configurationAnchors']['api']
        try:
            restored_configuration_projection(d, 'api', metadata, actual, original, anchors)
        except ProjectionRejection as error:
            d.require(error.reason == 'PROJECTED_HASH_MISMATCH', 'ONLINE_RECHARGE_CONTAINER_CHANGED')
        else:
            raise ApiNativeProbeRejection('ELIGIBILITY')
        previous = restored['previous']
        stage = 'OLD_SOURCE_BEFORE_PATH_CURRENT'
        d.require(isinstance(previous, Path) and previous.parent == d.BASE / 'releases'
                  and (d.BASE / 'current').resolve() == previous,
                  'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED')
        stage = 'OLD_SOURCE_BEFORE_WORKSPACE_FILES'
        d.require(workspace_files(d, previous) == restored['workspaceOriginFiles'],
                  'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED')
        stage = 'OLD_SOURCE_BEFORE_CONFIGURATION_FILES'
        d.require(configuration_hashes(previous) == restored['configurationBefore'],
                  'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED')
        stage = 'OLD_SOURCE_BEFORE_ENV_FILE'
        d.require(file_digest(previous / '.env.aws.production') == restored['environmentSha256'],
                  'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED')
        stage = 'DECLARATION_RENDER'
        declaration = rendered_configuration(d, previous)
        stage = 'OLD_SOURCE_AFTER_WORKSPACE_FILES'
        d.require(workspace_files(d, previous) == restored['workspaceOriginFiles'],
                  'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED')
        stage = 'OLD_SOURCE_AFTER_CONFIGURATION_FILES'
        d.require(configuration_hashes(previous) == restored['configurationBefore'],
                  'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED')
        stage = 'OLD_SOURCE_AFTER_ENV_FILE'
        d.require(file_digest(previous / '.env.aws.production') == restored['environmentSha256'],
                  'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED')
        config, host = metadata['Config'], metadata['HostConfig']
        stage = 'DECLARATION'
        d.require(declaration.get('name') == config['Labels']['com.docker.compose.project']
                  and isinstance(declaration['services'].get('api'), dict), 'ONLINE_RECHARGE_COMPOSE_INVALID')
        api = declaration['services']['api']
        dependencies = api.get('depends_on', {})
        stage = 'DEPENDENCY_DECLARATION_TYPE'
        d.require(isinstance(dependencies, dict), 'ONLINE_RECHARGE_COMPOSE_INVALID')
        stage = 'DEPENDENCY_COUNT_LIMIT'
        d.require(len(dependencies) <= 4,
                  'ONLINE_RECHARGE_COMPOSE_INVALID')
        triples = []
        for name, row in dependencies.items():
            stage = 'DEPENDENCY_NAME'
            d.require(isinstance(name, str) and re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,62}', name),
                      'ONLINE_RECHARGE_COMPOSE_INVALID')
            stage = 'DEPENDENCY_SERVICE'
            d.require(name in declaration['services'], 'ONLINE_RECHARGE_COMPOSE_INVALID')
            stage = 'DEPENDENCY_ROW_TYPE'
            d.require(isinstance(row, dict), 'ONLINE_RECHARGE_COMPOSE_INVALID')
            stage = 'DEPENDENCY_CONDITION'
            d.require(row.get('condition') in ('service_started', 'service_healthy', 'service_completed_successfully'),
                      'ONLINE_RECHARGE_COMPOSE_INVALID')
            stage = 'DEPENDENCY_RESTART'
            d.require(type(row.get('restart', False)) is bool, 'ONLINE_RECHARGE_COMPOSE_INVALID')
            triples.append(name + ':' + row['condition'] + ':' + str(row.get('restart', False)).lower())
        dependency_label = config['Labels'].get('com.docker.compose.depends_on')
        stage = 'DEPENDENCY_LABEL_TYPE'
        d.require(isinstance(dependency_label, str), 'ONLINE_RECHARGE_COMPOSE_INVALID')
        stage = 'DEPENDENCY_LABEL_SIZE'
        d.require(len(dependency_label) <= 2048, 'ONLINE_RECHARGE_COMPOSE_INVALID')
        stage = 'DEPENDENCY_LABEL_CONTENT'
        d.require(dependency_label == '' or sorted(dependency_label.split(',')) == sorted(triples),
                  'ONLINE_RECHARGE_COMPOSE_INVALID')
        mounts, volumes = host.get('Mounts'), api.get('volumes', [])
        bind_representation = mounts is None or mounts == []
        if bind_representation:
            shared = legacy(d)
            stage = 'MOUNT_BIND_DECLARATION'
            d.require(isinstance(volumes, list) and len(volumes) == 1 and isinstance(volumes[0], dict)
                      and {'type', 'source', 'target'} <= set(volumes[0])
                      and set(volumes[0]) <= {'type', 'source', 'target', 'read_only', 'volume'}
                      and volumes[0]['type'] == 'volume' and volumes[0]['source'] == shared.WORKSPACE_VOLUME
                      and volumes[0]['target'] == shared.WORKSPACE_DIRECTORY
                      and volumes[0].get('read_only', False) is False and volumes[0].get('volume', {}) == {},
                      'ONLINE_RECHARGE_COMPOSE_INVALID')
            name = config['Labels']['com.docker.compose.project'] + '_' + shared.WORKSPACE_VOLUME
            stage = 'MOUNT_BIND_NAME'
            d.require(declaration.get('volumes', {}).get(shared.WORKSPACE_VOLUME) == {'name': name},
                      'ONLINE_RECHARGE_COMPOSE_INVALID')
            stage = 'MOUNT_BIND_INSPECT'
            observed = metadata['Mounts']
            d.require(len(observed) == 1 and set(observed[0]) == {
                      'Type', 'Name', 'Source', 'Destination', 'Driver', 'Mode', 'RW', 'Propagation'}
                      and observed[0]['Type'] == 'volume' and observed[0]['Name'] == name
                      and observed[0]['Destination'] == shared.WORKSPACE_DIRECTORY
                      and observed[0]['Mode'] == 'rw' and observed[0]['RW'] is True
                      and observed[0]['Driver'] == 'local' and observed[0]['Propagation'] == ''
                      and isinstance(observed[0]['Source'], str) and observed[0]['Source'].startswith('/')
                      and observed[0]['Source'].endswith('/' + name + '/_data'), 'ONLINE_RECHARGE_COMPOSE_INVALID')
            stage = 'MOUNT_BIND_HOST'
            d.require(host.get('Binds') == [name + ':' + shared.WORKSPACE_DIRECTORY + ':rw'],
                      'ONLINE_RECHARGE_COMPOSE_INVALID')
        else:
            stage = 'MOUNT_NULL_OR_TYPE'
            d.require(isinstance(mounts, list), 'ONLINE_RECHARGE_COMPOSE_INVALID')
            stage = 'MOUNT_COUNT_LIMIT'
            d.require(len(mounts) <= 4, 'ONLINE_RECHARGE_COMPOSE_INVALID')
            stage = 'MOUNT_ROW_TARGET'
            d.require(all(isinstance(m, dict) and isinstance(m.get('Target'), str)
                          and m['Target'].startswith('/') for m in mounts), 'ONLINE_RECHARGE_COMPOSE_INVALID')
            stage = 'MOUNT_DUPLICATE_TARGET'
            d.require(len({m['Target'] for m in mounts}) == len(mounts), 'ONLINE_RECHARGE_COMPOSE_INVALID')
            stage = 'MOUNT_DECLARED_VOLUMES'
            d.require(isinstance(volumes, list) and all(isinstance(v, dict) and isinstance(v.get('target'), str)
                      for v in volumes), 'ONLINE_RECHARGE_COMPOSE_INVALID')
            stage = 'MOUNT_TARGET_SET_MISMATCH'
            d.require({m['Target'] for m in mounts} == {v['target'] for v in volumes},
                      'ONLINE_RECHARGE_COMPOSE_INVALID')
            stage = 'MOUNT_BIND_MIXED'
            d.require(host.get('Binds') in (None, []), 'ONLINE_RECHARGE_COMPOSE_INVALID')
        mode = host.get('NetworkMode')
        stage = 'NETWORK_INPUT_TYPE'
        d.require(isinstance(mode, str), 'ONLINE_RECHARGE_COMPOSE_INVALID')
        stage = 'NETWORK_INPUT_SIZE'
        d.require(len(mode) <= 256, 'ONLINE_RECHARGE_COMPOSE_INVALID')
        network_modes = [mode]
        # Insufficient network binding disables this hypothesis, preserving the live value.
        selected, declared = api.get('networks'), declaration.get('networks')
        live = metadata.get('NetworkSettings', {}).get('Networks')
        if (not api.get('network_mode') and isinstance(selected, dict) and 0 < len(selected) <= 4
                and isinstance(declared, dict) and all(isinstance(declared.get(n), dict)
                    and isinstance(declared[n].get('name'), str)
                    and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', declared[n]['name']) for n in selected)
                and isinstance(live, dict) and all(isinstance(v, dict) for v in live.values())):
            names = [declared[n]['name'] for n in selected]
            if len(set(names)) == len(names) and set(live) == set(names) and mode in names:
                network_modes = [mode, *sorted(n for n in names if n != mode)]
        stage = 'COMBINATION_LIMIT'
        dependency_count = math.factorial(len(triples)) + int(dependency_label == '' and bool(triples))
        mount_count = 1 if bind_representation else math.factorial(len(mounts))
        d.require(4 * dependency_count * mount_count * len(network_modes) <= 768,
                  'ONLINE_RECHARGE_SOURCE_TOO_LARGE')
        dependency_variants = list(itertools.permutations(triples))
        if dependency_label == '' and triples:
            dependency_variants.append(())
        base = {'Config': copy.deepcopy(config), 'HostConfig': copy.deepcopy(host),
                'Mounts': sorted(copy.deepcopy(metadata['Mounts']), key=lambda m: m['Destination'])}
        base['Config']['Hostname'] = original['containerId'][:12]
        replacements = (anchors['oldBeforeContainerId'], metadata['Name'][1:], 'api-1', None)
        seen, matches, candidate_bytes = set(), [], 0
        # This order checks dependencies, then complete mount rows, then primary network.
        for network in network_modes:
            for ordered_mounts in ((None,) if bind_representation else itertools.permutations(mounts)):
                for ordered_dependencies in dependency_variants:
                    for replacement in replacements:
                        candidate = copy.deepcopy(base)
                        if replacement is None:
                            candidate['Config']['Labels'].pop('com.docker.compose.replace', None)
                        else:
                            candidate['Config']['Labels']['com.docker.compose.replace'] = replacement
                        candidate['Config']['Labels']['com.docker.compose.depends_on'] = ','.join(ordered_dependencies)
                        if not bind_representation:
                            candidate['HostConfig']['Mounts'] = list(ordered_mounts)
                        candidate['HostConfig']['NetworkMode'] = network
                        encoded = json.dumps(candidate, sort_keys=True, separators=(',', ':'))
                        if encoded in seen:
                            continue
                        candidate_bytes += len(encoded.encode())
                        stage = 'PAYLOAD_LIMIT'
                        d.require(candidate_bytes <= API_NATIVE_MAX_BYTES, 'ONLINE_RECHARGE_SOURCE_TOO_LARGE')
                        seen.add(encoded)
                        if fingerprint(candidate) == original['configurationSha256']:
                            values = (candidate['Config']['Labels']['com.docker.compose.depends_on'] != dependency_label,
                                      candidate['HostConfig'].get('Mounts') != mounts, network != mode)
                            matches.append([p for p, changed in zip(API_NATIVE_PATHS, values) if changed])
        if len(matches) != 1:
            return {'matched': False, 'reason': 'AMBIGUOUS' if matches else 'NO_MATCH', 'changedPaths': []}
        return {'matched': True, 'reason': 'MATCH', 'changedPaths': matches[0]}
    except ApiNativeProbeRejection as error:
        if type(error) is not ApiNativeProbeRejection:
            return failed
        reason = vars(error).get('reason')
        if type(reason) is str and reason in API_NATIVE_FAILURE_REASONS and reason == stage:
            return {'matched': False, 'reason': reason, 'changedPaths': []}
        return failed
    except Exception:
        return failed


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
        if not _workspace_reviewed_worker_protected(d, previous, target, worker):
            d.require(inventory(previous, worker) == inventory(target, worker), 'ONLINE_RECHARGE_LEGACY_SOURCE_CHANGED')
    for name in ('scripts/v2-data-integrity-audit.mjs', 'scripts/lib/v2-data-integrity-audit.mjs',
                 'scripts/sync-v2-new-table-grants.mjs', 'scripts/lib/v2-production-database-access.mjs'):
        d.require((previous / name).is_file() and (target / name).is_file()
                  and not (previous / name).is_symlink() and not (target / name).is_symlink(),
                  'ONLINE_RECHARGE_SHARED_GATE_SOURCE_CHANGED')
        if name == GRANT_SOURCE and (previous / name).read_bytes() != (target / name).read_bytes():
            if not _workspace_bank_policy_protected(d, previous, target):
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
    probed = classified | {'apiNativeProbe'}
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
              or (not value['baselineConfirmed'] and set(value) in (failed, failed | details, failed | classified, failed | probed)
                  and isinstance(value.get('reason'), str) and value['reason'] in reasons
                  and isinstance(value.get('causeType'), str) and value['causeType'] in kinds
                  and isinstance(value.get('gateCode'), str)
                  and re.fullmatch(r'(?:ONLINE_RECHARGE|API_ADMIN)_[A-Z0-9_]+', value.get('gateCode', ''))),
              'ONLINE_RECHARGE_DIAGNOSTIC_RECEIPT_INVALID')
    if set(value) in (failed | details, failed | classified, failed | probed):
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
        if 'apiNativeProbe' in value:
            probe = value['apiNativeProbe']
            d.require(isinstance(probe, dict) and set(probe) == {'matched', 'reason', 'changedPaths'}
                      and type(probe['matched']) is bool and isinstance(probe['reason'], str)
                      and probe['reason'] in API_NATIVE_REASONS and probe['matched'] is (probe['reason'] == 'MATCH')
                      and isinstance(probe['changedPaths'], list)
                      and all(isinstance(p, str) and p in API_NATIVE_PATHS for p in probe['changedPaths'])
                      and probe['changedPaths'] == [p for p in API_NATIVE_PATHS if p in probe['changedPaths']]
                      and (bool(probe['changedPaths']) if probe['matched'] else probe['changedPaths'] == [])
                      and (probe['reason'] == 'NOT_PROBED'
                           or value['restoredProjectionReason']['api'] == 'PROJECTED_HASH_MISMATCH'),
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
        # Preserve archive content and executable/read-only bits while sealing staged source.
        for member in entries:
            member.mode &= ~0o022
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


# Pure v3 primitives only. No production caller or source authority is registered.
DECLARATION_EQUIVALENCE_KIND = 'API_FIXED_DECLARATION_EQUIVALENCE'


DECLARATION_EQUIVALENCE_VERSION = 3
DECLARATION_EQUIVALENCE_MARKER_SHA256 = '8c6488af34870b662cc3733ec7b10958aa9e532e3e64638e372ea00b08855385'


DECLARATION_EQUIVALENCE_SERVICES = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration')


DECLARATION_EQUIVALENCE_STABLE_KEYS = ('status', 'health', 'image', 'reference', 'environmentSha256')


DECLARATION_EQUIVALENCE_HELPERS = tuple('scripts/production-release/' + name for name in (
    'remote-deploy.py', 'api-admin-scope.py', 'online-recharge-scope.py', 'api-admin-readonly.py'))


DECLARATION_EQUIVALENCE_FIXED = {
    'policySha256': '641fe690c62224eb3d22d69e94493e08b9a2a9309ce04c588627c4aaea7c8f35',
    'workspaceCommit': '0a03fa28e6b844a18833d5c63f1de700f091fc64',
    'firstFailedCommit': '28a3ba4ffd17d36001b1104c97394f5ae871d73d',
    'secondFailedCommit': '296c096af7c4c79a8ffc2f57d9a15ea75684f431',
    'firstFailureReceiptSha256': '1959377acd78e7160fec0f85666982d4ea4efbb40dab199b7dcc04ba288ddd5a',
    'secondFailureReceiptSha256': 'f04e9356221bc10a33c774ce9e692b40db6afa23fd2a3bde23caf096a4f07485',
}


DECLARATION_EQUIVALENCE_FIELDS = {'proof': ('kind', 'version', 'service', 'semantic', 'measurement'),
 'semantic': ('producer',
              'fixedRecovery',
              'historicalFiles',
              'anchors',
              'original',
              'actual',
              'sourceBindings',
              'apiEquivalence',
              'adminProjection',
              'stableObservation'),
 'producer': ('commit',
              'sourceTree',
              'workflowRunId',
              'workflowRunAttempt',
              'archiveInventorySha256',
              'helpers'),
 'historicalFiles': ('workspaceManifestBytesSha256',
                     'workspaceRecordBytesSha256',
                     'workspaceBuildProofBytesSha256',
                     'restoredManifestBytesSha256',
                     'restoredRecordBytesSha256',
                     'restoredBuildProofBytesSha256'),
 'sourceBindings': ('configurationFilesSha256',
                    'workspaceFilesSha256',
                    'environmentFileSha256',
                    'renderedDeclarationSha256',
                    'normalizedModelSha256',
                    'apiImageId',
                    'apiImageReference',
                    'apiDeclaredHash',
                    'expectedEnvironmentSha256',
                    'referenceEnvironmentSha256',
                    'actualResourceSha256'),
 'apiEquivalence': ('rulesSha256',
                    'oldRawConfigurationSha256',
                    'actualRawConfigurationSha256',
                    'normalizedActualSha256',
                    'normalizedReferenceSha256'),
 'adminProjection': ('kind',
                     'originalConfigurationSha256',
                     'actualConfigurationSha256',
                     'projectedConfigurationSha256',
                     'helperSha256'),
 'stableObservation': ('snapshotSha256',
                       'sourceFilesSha256',
                       'workspaceVolumeSha256',
                       'actualResourceSha256'),
 'measurement': ('purpose',
                 'executionNonce',
                 'sourceArchiveBytesSha256',
                 'referenceRegistrySha256',
                 'referenceRawConfigurationSha256',
                 'referenceModelSha256',
                 'engineVersionSha256',
                 'composeVersionSha256',
                 'neverStarted',
                 'cleanupVerified',
                 'realEnvironmentPersisted',
                 'referenceCounts',
                 'stableBefore',
                 'stableAfter',
                 'priorIndependentPreflightBytesSha256',
                 'priorProofSha256'),
 'origin': ('version',
            'scope',
            'baselineRelease',
            'baselineManifestSha256',
            'migrationState',
            'recoveryMarker',
            'restoredOrigin',
            'services',
            'priorPublications',
            'restoredConfigurationProof')}


def _declaration_require(condition, unused=None):
    if not condition:
        raise RuntimeError('ONLINE_RECHARGE_DECLARATION_PROOF_INVALID')


def _declaration_exact(value, fields):
    _declaration_require(type(value) is dict and set(value) == set(fields))
    return value


def _declaration_hash(value):
    return type(value) is str and re.fullmatch('[a-f0-9]{64}', value) is not None


def _declaration_states(value):
    _declaration_exact(value, DECLARATION_EQUIVALENCE_SERVICES)
    for name, row in value.items():
        _declaration_exact(row, SERVICE_IDENTITY_KEYS)
        _declaration_require(row['status'] == 'running' and (row['health'] in ('healthy', None)
             if name == 'caddy' else row['health'] == 'healthy'))
        _declaration_require(type(row['image']) is str and re.fullmatch('sha256:[a-f0-9]{64}', row['image'])
             and type(row['reference']) is str
             and re.fullmatch('[A-Za-z0-9][A-Za-z0-9:/@._-]{0,511}', row['reference'])
             and all(_declaration_hash(row[k]) for k in SERVICE_IDENTITY_KEYS[-4:]))


def validate_declaration_equivalence_proof(d, value):
    """Pure structure only; measured source/Env/resources require a real entry."""
    _declaration_exact(value, DECLARATION_EQUIVALENCE_FIELDS['proof'])
    _declaration_require(value['kind'] == DECLARATION_EQUIVALENCE_KIND and type(value['version']) is int and value['version'] == DECLARATION_EQUIVALENCE_VERSION
         and value['service'] == 'api', 'EQUIVALENCE_VERSION_INVALID')
    s, m = value['semantic'], value['measurement']
    _declaration_exact(s, DECLARATION_EQUIVALENCE_FIELDS['semantic'])
    _declaration_exact(m, DECLARATION_EQUIVALENCE_FIELDS['measurement'])
    producer = _declaration_exact(s['producer'], DECLARATION_EQUIVALENCE_FIELDS['producer'])
    _declaration_require(all(type(producer[k]) is str and re.fullmatch('[a-f0-9]{40}', producer[k])
             for k in ('commit', 'sourceTree'))
         and all(type(producer[k]) is str and re.fullmatch('[1-9][0-9]*', producer[k])
                 for k in ('workflowRunId', 'workflowRunAttempt'))
         and _declaration_hash(producer['archiveInventorySha256']))
    _declaration_require(all(_declaration_hash(v) for v in _declaration_exact(producer['helpers'], DECLARATION_EQUIVALENCE_HELPERS).values()))
    fixed = _declaration_exact(s['fixedRecovery'], (*DECLARATION_EQUIVALENCE_FIXED, 'recoveryMarkerSha256'))
    _declaration_require(all(fixed[k] == v for k, v in DECLARATION_EQUIVALENCE_FIXED.items())
                         and fixed['recoveryMarkerSha256'] == DECLARATION_EQUIVALENCE_MARKER_SHA256)
    _declaration_require(all(_declaration_hash(v) for v in _declaration_exact(s['historicalFiles'], DECLARATION_EQUIVALENCE_FIELDS['historicalFiles']).values()))
    _declaration_exact(s['anchors'], ('api', 'admin'))
    for row in s['anchors'].values():
        _declaration_require(all(_declaration_hash(v) for v in _declaration_exact(row, ('oldBeforeContainerId', 'candidateAfterContainerId')).values()))
    original, actual = s['original'], s['actual']
    _declaration_states(original)
    _declaration_states(actual)
    _declaration_require(all(actual[n] == original[n] for n in PRESERVED), 'EQUIVALENCE_PRESERVATION_INVALID')
    _declaration_require(all(actual[n][k] == original[n][k] for n in ('api', 'admin') for k in DECLARATION_EQUIVALENCE_STABLE_KEYS),
         'EQUIVALENCE_PRESERVATION_INVALID')
    source = _declaration_exact(s['sourceBindings'], DECLARATION_EQUIVALENCE_FIELDS['sourceBindings'])
    _declaration_require(source['apiImageId'] == actual['api']['image']
         and source['apiImageReference'] == actual['api']['reference']
         and source['expectedEnvironmentSha256'] == actual['api']['environmentSha256']
         and all(_declaration_hash(v) for k, v in source.items() if k not in ('apiImageId', 'apiImageReference')))
    api = _declaration_exact(s['apiEquivalence'], DECLARATION_EQUIVALENCE_FIELDS['apiEquivalence'])
    _declaration_require(all(_declaration_hash(v) for v in api.values())
         and api['oldRawConfigurationSha256'] == original['api']['configurationSha256']
         and api['actualRawConfigurationSha256'] == actual['api']['configurationSha256']
         and api['normalizedActualSha256'] == api['normalizedReferenceSha256'])
    admin = _declaration_exact(s['adminProjection'], DECLARATION_EQUIVALENCE_FIELDS['adminProjection'])
    _declaration_require(admin['kind'] == 'ADMIN_OLD_COMPLETE_CONFIGURATION_MATCH'
         and admin['originalConfigurationSha256'] == admin['projectedConfigurationSha256']
             == original['admin']['configurationSha256']
         and admin['actualConfigurationSha256'] == actual['admin']['configurationSha256']
         and admin['helperSha256'] == producer['helpers'][DECLARATION_EQUIVALENCE_HELPERS[2]])
    obs = _declaration_exact(s['stableObservation'], DECLARATION_EQUIVALENCE_FIELDS['stableObservation'])
    _declaration_require(all(_declaration_hash(v) for v in obs.values()) and obs['snapshotSha256'] == fingerprint(actual)
         and obs['actualResourceSha256'] == source['actualResourceSha256']
         and m['stableBefore'] == m['stableAfter'] == obs)
    _declaration_require(m['purpose'] in ('INDEPENDENT_PREFLIGHT', 'DEPLOYMENT_REMEASURE')
         and type(m['executionNonce']) is str and re.fullmatch('[a-f0-9]{32}', m['executionNonce'])
         and all(_declaration_hash(m[k]) for k in ('sourceArchiveBytesSha256', 'referenceRegistrySha256',
             'referenceRawConfigurationSha256', 'referenceModelSha256', 'engineVersionSha256', 'composeVersionSha256'))
         and m['neverStarted'] is True and m['cleanupVerified'] is True
         and m['realEnvironmentPersisted'] is False
         and _declaration_exact(m['referenceCounts'], ('containers', 'networks', 'volumes'))
             == {'containers': 1, 'networks': 4, 'volumes': 1})
    _declaration_require(all(type(v) is int for v in m['referenceCounts'].values()))
    if m['purpose'] == 'INDEPENDENT_PREFLIGHT':
        _declaration_require(m['priorIndependentPreflightBytesSha256'] is None and m['priorProofSha256'] is None)
    else:
        _declaration_require(_declaration_hash(m['priorIndependentPreflightBytesSha256']) and _declaration_hash(m['priorProofSha256']))
    return value


def declaration_equivalence_pair_seal(d, first, second, preflight_raw):
    """Bind P1/P2 to exact full F_A bytes without prescribing its old schema."""
    validate_declaration_equivalence_proof(d, first)
    validate_declaration_equivalence_proof(d, second)
    before = closed_recovery_json(d, preflight_raw)
    _declaration_require(type(before) is dict and type(before.get('pendingOnlineMigrationOrigin')) is dict
        and before['pendingOnlineMigrationOrigin'].get('restoredConfigurationProof') == first
        and first['measurement']['purpose'] == 'INDEPENDENT_PREFLIGHT'
        and second['measurement']['purpose'] == 'DEPLOYMENT_REMEASURE'
        and first['semantic'] == second['semantic'])
    producer = first['semantic']['producer']
    _declaration_require(before.get('mode') == 'preflight'
        and before.get('status') == 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED'
        and before.get('commit') == BASELINE_COMMIT
        and before.get('services') == first['semantic']['actual']
        and before.get('releaseCandidateCommit') == producer['commit']
        and before.get('workflowRunId') == producer['workflowRunId']
        and before.get('workflowRunAttempt') == producer['workflowRunAttempt'])
    one, two = first['measurement'], second['measurement']
    raw_sha = hashlib.sha256(preflight_raw).hexdigest()
    _declaration_require(two['priorIndependentPreflightBytesSha256'] == raw_sha
        and two['priorProofSha256'] == fingerprint(first)
        and all(one[k] == two[k] for k in ('engineVersionSha256', 'composeVersionSha256')))
    return {'kind': DECLARATION_EQUIVALENCE_KIND, 'version': DECLARATION_EQUIVALENCE_VERSION,
        'preflightBytesSha256': raw_sha, 'preflightProofSha256': fingerprint(first),
        'deploymentProofSha256': fingerprint(second), 'semanticSha256': fingerprint(first['semantic'])}


def declaration_equivalence_source_binding(d, value, *, producer, archive_bytes, historical_files):
    """Consume actual byte inputs; caller must independently acquire their sources.

    This does not grant provenance to a hash-only context or perform file I/O.
    Existing fixed source/permission/manifest/run guards remain mandatory.
    """
    validate_declaration_equivalence_proof(d, value)
    semantic = value['semantic']
    _declaration_require(type(producer) is dict and producer == semantic['producer'])
    inventory = archive_inventory(d, archive_bytes, producer['commit'], producer['sourceTree'])
    _declaration_require(fingerprint(inventory) == producer['archiveInventorySha256']
        and all(inventory.get(name, {}).get('sha256') == digest
                for name, digest in producer['helpers'].items()))
    fields = DECLARATION_EQUIVALENCE_FIELDS['historicalFiles']
    _declaration_exact(historical_files, (*fields, 'firstFailure', 'secondFailure', 'recoveryPolicy'))
    documents = {name: closed_recovery_json(d, raw) for name, raw in historical_files.items()}
    _declaration_require(all(type(v) is dict for v in documents.values())
        and fingerprint(documents['recoveryPolicy']) == RECOVERY_POLICY_SHA256
        and documents['recoveryPolicy']['preflight']['services'] == semantic['original']
        and fingerprint(recovery_marker(documents['recoveryPolicy']))
            == semantic['fixedRecovery']['recoveryMarkerSha256']
        and all(hashlib.sha256(historical_files[name]).hexdigest()
        == semantic['historicalFiles'][name] for name in fields)
        and fingerprint(documents['firstFailure']) == RECOVERY_FAILURE_SHA256
        and fingerprint(documents['secondFailure']) == RESTORED_FAILURE_SHA256)
    workspace = documents['workspaceRecordBytesSha256']
    restored = documents['restoredRecordBytesSha256']
    _declaration_require(type(workspace) is dict and type(restored) is dict
        and type(workspace.get('before')) is dict and type(restored.get('after')) is dict
        and all(type(workspace['before'].get(n)) is dict and type(restored['after'].get(n)) is dict
                for n in ('api', 'admin'))
        and workspace.get('after') == semantic['original']
        and restored.get('before') == semantic['original']
        and documents['workspaceManifestBytesSha256'].get('commit') == BASELINE_COMMIT
        and documents['restoredManifestBytesSha256'].get('commit') == RESTORED_COMMIT
        and documents['workspaceBuildProofBytesSha256'].get('commit') == BASELINE_COMMIT
        and documents['restoredBuildProofBytesSha256'].get('commit') == RESTORED_COMMIT
        and all(semantic['anchors'][name] == {
            'oldBeforeContainerId': workspace.get('before', {}).get(name, {}).get('containerId'),
            'candidateAfterContainerId': restored.get('after', {}).get(name, {}).get('containerId')}
            for name in ('api', 'admin')))
    return {'producer': copy.deepcopy(producer), 'historicalFiles': copy.deepcopy(semantic['historicalFiles']),
            'proofSha256': fingerprint(value)}


def declaration_equivalence_publication_binding(d, *, origin, second, preflight_raw, build_raw,
        record_raw, manifest_raw, producer, archive_bytes, historical_files):
    """Artifact seal only; caller must first run all original full validators.

    This does not verify the ordinary workspace manifest/build-proof semantics,
    acquire private files, or grant a successful status. The source adapter must
    bind any separately executed measurement helper bytes to the same archive.
    """
    _declaration_exact(origin, DECLARATION_EQUIVALENCE_FIELDS['origin'])
    _declaration_require(type(origin['version']) is int and origin['version'] == 2
        and origin.get('scope') == 'PENDING_ONLINE_MIGRATION'
        and origin.get('priorPublications') == [] and 'restoredConfigurationProof' in origin)
    first = origin['restoredConfigurationProof']
    declaration_equivalence_source_binding(d, first, producer=producer,
        archive_bytes=archive_bytes, historical_files=historical_files)
    seal = declaration_equivalence_pair_seal(d, first, second, preflight_raw)
    before = closed_recovery_json(d, preflight_raw)
    build, record, manifest = (closed_recovery_json(d, raw) for raw in (build_raw, record_raw, manifest_raw))
    _declaration_require(all(type(v) is dict for v in (before, build, record, manifest))
        and type(manifest.get('pendingOnlineMigration')) is dict
        and type(origin.get('restoredOrigin')) is dict
        and origin.get('baselineManifestSha256') == first['semantic']['historicalFiles']['workspaceManifestBytesSha256']
        and fingerprint(origin.get('recoveryMarker')) == first['semantic']['fixedRecovery']['recoveryMarkerSha256']
        and origin['restoredOrigin'].get('manifestSha256')
            == first['semantic']['historicalFiles']['restoredManifestBytesSha256']
        and origin['restoredOrigin'].get('recordSha256')
            == first['semantic']['historicalFiles']['restoredRecordBytesSha256']
        and before.get('pendingOnlineMigrationOrigin') == origin
        and record.get('pendingOnlineMigrationOrigin') == origin
        and record.get('pendingOnlineConfigurationMeasurement') == second
        and record.get('before') == first['semantic']['actual'] == origin.get('services')
        and build.get('commit') == manifest.get('commit') == producer['commit']
        and build.get('sourceTree') == manifest.get('sourceTree') == producer['sourceTree']
        and build.get('pendingOnlineOriginSha256') == fingerprint(origin)
        and build.get('pendingOnlinePreflightSha256') == seal['preflightBytesSha256']
        and build.get('declarationEquivalenceSeal') == {k: seal[k] for k in
            ('kind', 'version', 'preflightProofSha256', 'semanticSha256')}
        and manifest['pendingOnlineMigration'].get('originSha256') == fingerprint(origin)
        and manifest['pendingOnlineMigration'].get('configurationEquivalenceSeal') == seal
        and type(before.get('commandId')) is str
        and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', before['commandId']))
    _declaration_states(record.get('after'))
    _declaration_require(all(record['after'][n] == record['before'][n] for n in PRESERVED))
    return {'kind': DECLARATION_EQUIVALENCE_KIND, 'version': DECLARATION_EQUIVALENCE_VERSION,
        'producer': copy.deepcopy(producer), 'preflightCommandId': before['commandId'],
        'preflightBytesSha256': seal['preflightBytesSha256'],
        'manifestBytesSha256': hashlib.sha256(manifest_raw).hexdigest(),
        'recordBytesSha256': hashlib.sha256(record_raw).hexdigest(),
        'buildProofBytesSha256': hashlib.sha256(build_raw).hexdigest(),
        'buildProofCanonicalSha256': fingerprint(build),
        'archiveInventorySha256': producer['archiveInventorySha256'],
        'configurationEquivalenceSeal': seal, 'afterServices': copy.deepcopy(record['after']),
        'configurationAfter': copy.deepcopy(record.get('configurationAfter'))}


def declaration_equivalence_issuer_binding(d, publication, *, live_services, live_configuration, execution_producer):
    """Require the issuer's actual new runtime/source measurements, never a bool."""
    _declaration_exact(publication, ('kind', 'version', 'producer', 'preflightCommandId',
        'preflightBytesSha256', 'manifestBytesSha256', 'recordBytesSha256', 'buildProofBytesSha256', 'buildProofCanonicalSha256',
        'archiveInventorySha256', 'configurationEquivalenceSeal', 'afterServices', 'configurationAfter'))
    _declaration_states(live_services)
    _declaration_exact(live_configuration, ('docker-compose.aws-mysql.yml', 'deploy/caddy/Caddyfile.aws',
                                          SCHEMA_FILE, 'compose.release.json'))
    _declaration_require(execution_producer == publication['producer']
        and live_services == publication['afterServices']
        and all(_declaration_hash(v) for v in live_configuration.values())
        and live_configuration == publication['configurationAfter'])
    return {k: copy.deepcopy(v) for k, v in publication.items()
            if k not in ('afterServices', 'configurationAfter')}


def declaration_equivalence_receipt_binding(d, publication, invocation_raw, *, command_id, wire_decoder):
    """Later cold requires an independently acquired ended SSM invocation.

    Raw bytes must come from the trusted transport, not the release record.
    This pure comparison cannot establish AWS/file-source authority itself or
    replace the original full readback validator. Its seal is not a trust flag.
    The decoder is independently bound to the producer archive by the caller;
    framing is decoded without replacing the original invocation bytes.
    """
    invocation = closed_recovery_json(d, invocation_raw)
    _declaration_require(type(invocation) is dict and invocation.get('Status') == 'Success'
        and type(invocation.get('ResponseCode')) is int and invocation['ResponseCode'] == 0
        and type(command_id) is str
        and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', command_id)
        and invocation.get('CommandId') == command_id
        and type(invocation.get('StandardOutputContent')) is str)
    _declaration_require(callable(wire_decoder))
    try:
        result = wire_decoder(invocation['StandardOutputContent'], scope='API_ADMIN_WORKSPACE')
    except Exception:
        raise RuntimeError('ONLINE_RECHARGE_DECLARATION_PROOF_INVALID') from None
    seal_fields = ('kind', 'version', 'producer', 'preflightCommandId', 'preflightBytesSha256',
        'manifestBytesSha256', 'recordBytesSha256', 'buildProofBytesSha256', 'buildProofCanonicalSha256',
        'archiveInventorySha256', 'configurationEquivalenceSeal')
    expected = {k: publication[k] for k in seal_fields}
    _declaration_require(type(result) is dict
        and result.get('status') == 'API_ADMIN_WORKSPACE_VERIFIED'
        and result.get('declarationEquivalencePublication') == expected)
    return {**expected, 'readbackCommandId': command_id}


def declaration_equivalence_successor_preflight_binding(d, preflight_raw, *, initial_origin,
        initial_publication, current_producer, current_services, current_archive_bytes,
        initial_invocation_raw, initial_command_id, wire_decoder):
    """Bind F_B to B's run and A.after while retaining P1_A; no P2_B."""
    first = initial_origin.get('restoredConfigurationProof') if type(initial_origin) is dict else None
    validate_declaration_equivalence_proof(d, first)
    declaration_equivalence_receipt_binding(d, initial_publication, initial_invocation_raw,
                                           command_id=initial_command_id, wire_decoder=wire_decoder)
    before = closed_recovery_json(d, preflight_raw)
    _declaration_require(type(before) is dict and type(current_producer) is dict
        and set(current_producer) == set(first['semantic']['producer'])
        and current_producer != first['semantic']['producer'])
    _declaration_require(all(type(current_producer[k]) is str and re.fullmatch(r'[a-f0-9]{40}', current_producer[k])
        for k in ('commit', 'sourceTree')) and all(type(current_producer[k]) is str
        and re.fullmatch(r'[1-9][0-9]*', current_producer[k]) for k in ('workflowRunId', 'workflowRunAttempt')))
    inventory = archive_inventory(d, current_archive_bytes, current_producer['commit'], current_producer['sourceTree'])
    _declaration_exact(current_producer['helpers'], DECLARATION_EQUIVALENCE_HELPERS)
    _declaration_require(fingerprint(inventory) == current_producer['archiveInventorySha256']
        and all(inventory.get(n, {}).get('sha256') == v for n, v in current_producer['helpers'].items()))
    context = before.get('pendingOnlineMigrationOrigin')
    _declaration_require(type(context) is dict and set(context) == set(initial_origin)
        and all(context[k] == initial_origin[k] for k in initial_origin
                if k not in ('services', 'priorPublications'))
        and type(context.get('priorPublications')) is list and len(context['priorPublications']) == 1)
    prior = context['priorPublications'][0]
    _declaration_exact(prior, ('release', 'commit', 'sourceTree', 'manifestSha256',
                              'recordSha256', 'buildProofSha256'))
    _declaration_states(current_services)
    _declaration_require(current_services == initial_publication['afterServices'] == before.get('services')
        == context.get('services') and before.get('mode') == 'preflight'
        and before.get('status') == 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED'
        and before.get('commit') == initial_publication['producer']['commit']
        and before.get('releaseCandidateCommit') == current_producer['commit']
        and before.get('workflowRunId') == current_producer['workflowRunId']
        and before.get('workflowRunAttempt') == current_producer['workflowRunAttempt']
        and prior['commit'] == initial_publication['producer']['commit']
        and prior['sourceTree'] == initial_publication['producer']['sourceTree']
        and prior['manifestSha256'] == initial_publication['manifestBytesSha256']
        and prior['recordSha256'] == initial_publication['recordBytesSha256']
        and prior['buildProofSha256'] == initial_publication['buildProofCanonicalSha256'])
    return {'initialProofSha256': fingerprint(first), 'preflightBytesSha256': hashlib.sha256(preflight_raw).hexdigest(),
            'currentProducer': copy.deepcopy(current_producer), 'currentServicesSha256': fingerprint(current_services)}


DECLARATION_SUCCESSOR_KIND = 'ONLINE_RECHARGE_DECLARATION_SUCCESSOR_B_PUBLICATION'
DECLARATION_SUCCESSOR_FIELDS = ('kind', 'version', 'producer', 'preflightCommandId', 'preflightBytesSha256',
    'originSha256', 'manifestBytesSha256', 'recordBytesSha256', 'buildProofBytesSha256',
    'buildProofCanonicalSha256', 'archiveInventorySha256', 'successorConfigurationSeal',
    'afterServices', 'configurationAfter')


def _declaration_successor_publication_shape(publication, *, issued=False):
    _declaration_exact(publication, tuple(n for n in DECLARATION_SUCCESSOR_FIELDS
                                       if not issued or n not in ('afterServices', 'configurationAfter')))
    if not issued:
        _declaration_states(publication['afterServices'])
        _declaration_exact(publication['configurationAfter'], ('docker-compose.aws-mysql.yml', 'deploy/caddy/Caddyfile.aws',
                                                             SCHEMA_FILE, 'compose.release.json'))
        _declaration_require(all(_declaration_hash(v) for v in publication['configurationAfter'].values()))
    seal = _declaration_exact(publication['successorConfigurationSeal'], ('kind', 'version', 'initialProofSha256',
        'preflightBytesSha256', 'currentProducer', 'currentServicesSha256', 'initialPublication',
        'initialReadbackInvocationBytesSha256', 'preflightCommandId', 'currentConfigurationSha256'))
    initial = _declaration_exact(seal['initialPublication'], ('kind', 'version', 'producer', 'preflightCommandId',
        'preflightBytesSha256', 'manifestBytesSha256', 'recordBytesSha256', 'buildProofBytesSha256',
        'buildProofCanonicalSha256', 'archiveInventorySha256', 'configurationEquivalenceSeal', 'readbackCommandId'))
    pair = _declaration_exact(initial['configurationEquivalenceSeal'], ('kind', 'version', 'preflightBytesSha256',
        'preflightProofSha256', 'deploymentProofSha256', 'semanticSha256'))
    _declaration_require(publication['kind'] == seal['kind'] == DECLARATION_SUCCESSOR_KIND
        and type(publication['version']) is int and publication['version'] == 1
        and type(seal['version']) is int and seal['version'] == 1
        and initial['kind'] == pair['kind'] == DECLARATION_EQUIVALENCE_KIND
        and type(initial['version']) is int and initial['version'] == DECLARATION_EQUIVALENCE_VERSION
        and type(pair['version']) is int and pair['version'] == DECLARATION_EQUIVALENCE_VERSION
        and publication['producer'] == seal['currentProducer'] != initial['producer']
        and publication['preflightBytesSha256'] == seal['preflightBytesSha256']
        and publication['preflightCommandId'] == seal['preflightCommandId']
        and seal['initialProofSha256'] == pair['preflightProofSha256']
        and all(_declaration_hash(v) for mapping in (publication, seal, initial, pair)
                for k, v in mapping.items() if k.endswith('Sha256')))
    for producer in (publication['producer'], initial['producer']):
        _declaration_exact(producer, DECLARATION_EQUIVALENCE_FIELDS['producer'])
        _declaration_exact(producer['helpers'], DECLARATION_EQUIVALENCE_HELPERS)
        _declaration_require(all(type(producer[k]) is str and re.fullmatch(r'[a-f0-9]{40}', producer[k]) for k in ('commit', 'sourceTree'))
            and all(type(producer[k]) is str and re.fullmatch(r'[1-9][0-9]*', producer[k]) for k in ('workflowRunId', 'workflowRunAttempt'))
            and _declaration_hash(producer['archiveInventorySha256']) and all(_declaration_hash(v) for v in producer['helpers'].values()))
    _declaration_require(publication['archiveInventorySha256'] == publication['producer']['archiveInventorySha256'])
    _declaration_require(all(type(v) is str and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', v)
        for v in (publication['preflightCommandId'], initial['preflightCommandId'], initial['readbackCommandId']))
        and publication['preflightCommandId'] not in (initial['preflightCommandId'], initial['readbackCommandId']))


def declaration_equivalence_successor_seal(d, preflight_raw, *, initial_origin, initial_publication,
        current_producer, current_services, current_configuration, current_archive_bytes,
        initial_invocation_raw, initial_command_id, wire_decoder):
    """Only A->B: inherit acquired Q_A; never create a second measurement for B."""
    binding = declaration_equivalence_successor_preflight_binding(d, preflight_raw,
        initial_origin=initial_origin, initial_publication=initial_publication, current_producer=current_producer,
        current_services=current_services, current_archive_bytes=current_archive_bytes,
        initial_invocation_raw=initial_invocation_raw, initial_command_id=initial_command_id, wire_decoder=wire_decoder)
    before = closed_recovery_json(d, preflight_raw)
    _declaration_exact(current_configuration, ('docker-compose.aws-mysql.yml', 'deploy/caddy/Caddyfile.aws',
                                              SCHEMA_FILE, 'compose.release.json'))
    _declaration_require(current_configuration == initial_publication['configurationAfter']
        and all(_declaration_hash(v) for v in current_configuration.values())
        and type(before.get('commandId')) is str
        and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', before['commandId'])
        and before['commandId'] not in (initial_publication['preflightCommandId'], initial_command_id))
    initial = declaration_equivalence_receipt_binding(d, initial_publication, initial_invocation_raw,
        command_id=initial_command_id, wire_decoder=wire_decoder)
    return {'kind': DECLARATION_SUCCESSOR_KIND, 'version': 1, **binding,
        'initialPublication': initial, 'initialReadbackInvocationBytesSha256': hashlib.sha256(initial_invocation_raw).hexdigest(),
        'preflightCommandId': before['commandId'], 'currentConfigurationSha256': fingerprint(current_configuration)}


def declaration_equivalence_successor_publication_binding(d, *, origin, preflight_raw, build_raw, record_raw,
        manifest_raw, initial_origin, initial_publication, current_producer, current_services,
        current_configuration, current_archive_bytes, initial_invocation_raw, initial_command_id, wire_decoder):
    """B artifact seal; original full source/runtime validators remain mandatory.

    Initial publication and Q_A must be independently acquired and validated.
    This pure function does not turn caller hashes or synthetic data into file,
    source, completed-invocation or production authority.
    """
    _declaration_exact(origin, DECLARATION_EQUIVALENCE_FIELDS['origin'])
    before = closed_recovery_json(d, preflight_raw)
    _declaration_require(type(origin['version']) is int and origin['version'] == 2
        and origin.get('scope') == 'PENDING_ONLINE_MIGRATION'
        and type(origin.get('priorPublications')) is list and len(origin['priorPublications']) == 1
        and before.get('pendingOnlineMigrationOrigin') == origin)
    seal = declaration_equivalence_successor_seal(d, preflight_raw, initial_origin=initial_origin,
        initial_publication=initial_publication, current_producer=current_producer, current_services=current_services,
        current_configuration=current_configuration, current_archive_bytes=current_archive_bytes,
        initial_invocation_raw=initial_invocation_raw, initial_command_id=initial_command_id, wire_decoder=wire_decoder)
    build, record, manifest = (closed_recovery_json(d, raw) for raw in (build_raw, record_raw, manifest_raw))
    first = initial_origin['restoredConfigurationProof']
    _declaration_require(all(type(v) is dict for v in (build, record, manifest))
        and type(build.get('version')) is int and build['version'] == 2
        and record.get('pendingOnlineMigrationOrigin') == origin
        and record.get('pendingOnlineSuccessorPreflight') == seal
        and 'pendingOnlineConfigurationMeasurement' not in record
        and record.get('before') == current_services == origin.get('services')
        and record.get('configurationBefore') == current_configuration
        and build.get('commit') == manifest.get('commit') == current_producer['commit']
        and build.get('sourceTree') == manifest.get('sourceTree') == current_producer['sourceTree']
        and build.get('pendingOnlineOriginSha256') == fingerprint(origin)
        and build.get('pendingOnlinePreflightSha256') == seal['preflightBytesSha256']
        and build.get('declarationEquivalenceSeal') == {'kind': first['kind'], 'version': first['version'],
            'preflightProofSha256': fingerprint(first), 'semanticSha256': fingerprint(first['semantic'])}
        and manifest.get('pendingOnlineMigration', {}).get('originSha256') == fingerprint(origin)
        and manifest['pendingOnlineMigration'].get('successorConfigurationSeal') == seal
        and 'configurationEquivalenceSeal' not in manifest['pendingOnlineMigration'])
    _declaration_states(record.get('after'))
    _declaration_exact(record.get('configurationAfter'), ('docker-compose.aws-mysql.yml', 'deploy/caddy/Caddyfile.aws',
                                                        SCHEMA_FILE, 'compose.release.json'))
    _declaration_require(all(_declaration_hash(v) for v in record['configurationAfter'].values())
        and all(record['after'][n] == record['before'][n] for n in PRESERVED))
    return {'kind': DECLARATION_SUCCESSOR_KIND, 'version': 1, 'producer': copy.deepcopy(current_producer),
        'preflightCommandId': seal['preflightCommandId'], 'preflightBytesSha256': seal['preflightBytesSha256'],
        'originSha256': fingerprint(origin), 'manifestBytesSha256': hashlib.sha256(manifest_raw).hexdigest(),
        'recordBytesSha256': hashlib.sha256(record_raw).hexdigest(), 'buildProofBytesSha256': hashlib.sha256(build_raw).hexdigest(),
        'buildProofCanonicalSha256': fingerprint(build), 'archiveInventorySha256': current_producer['archiveInventorySha256'],
        'successorConfigurationSeal': seal, 'afterServices': copy.deepcopy(record['after']),
        'configurationAfter': copy.deepcopy(record['configurationAfter'])}


def declaration_equivalence_successor_issuer_binding(d, publication, *, live_services, live_configuration, execution_producer):
    """The independent fixed B READBACK supplies actual current B measurements."""
    _declaration_successor_publication_shape(publication)
    _declaration_states(live_services)
    _declaration_require(publication['kind'] == DECLARATION_SUCCESSOR_KIND
        and type(publication['version']) is int and publication['version'] == 1
        and execution_producer == publication['producer']
        and live_services == publication['afterServices'] and live_configuration == publication['configurationAfter'])
    return {k: copy.deepcopy(v) for k, v in publication.items() if k not in ('afterServices', 'configurationAfter')}


def declaration_equivalence_successor_receipt_binding(d, publication, invocation_raw, *, command_id, wire_decoder):
    """Cold B consumes Q_B; an initial-A seal or absent receipt never substitutes."""
    _declaration_successor_publication_shape(publication)
    _declaration_require(publication['kind'] == DECLARATION_SUCCESSOR_KIND
        and type(publication['version']) is int and publication['version'] == 1)
    invocation = closed_recovery_json(d, invocation_raw)
    _declaration_require(type(invocation) is dict and invocation.get('Status') == 'Success'
        and type(invocation.get('ResponseCode')) is int and invocation['ResponseCode'] == 0
        and type(command_id) is str and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', command_id)
        and invocation.get('CommandId') == command_id and type(invocation.get('StandardOutputContent')) is str
        and callable(wire_decoder))
    try:
        receipt = wire_decoder(invocation['StandardOutputContent'], scope='API_ADMIN_WORKSPACE')
    except Exception:
        raise RuntimeError('ONLINE_RECHARGE_DECLARATION_PROOF_INVALID') from None
    expected = {k: publication[k] for k in publication if k not in ('afterServices', 'configurationAfter')}
    _declaration_require(type(receipt) is dict and receipt.get('status') == 'API_ADMIN_WORKSPACE_VERIFIED'
        and receipt.get('declarationEquivalenceSuccessorPublication') == expected
        and fingerprint(receipt.get('pendingOnlineMigrationOrigin')) == publication['originSha256'])
    return {**expected, 'readbackCommandId': command_id}


def _declaration_source_bytes(path, *, limit=256 * 1024):
    """Read one owned ordinary file without following a path or inode change."""
    path = Path(path)
    _declaration_require(path.is_absolute() and path.parent.resolve() == path.parent)
    before = path.lstat()
    _declaration_require(stat.S_ISREG(before.st_mode) and before.st_uid == os.geteuid()
        and before.st_nlink == 1 and stat.S_IMODE(before.st_mode) in (0o600, 0o644, 0o664)
        and 0 < before.st_size <= limit)

    def identity(row):
        return (row.st_dev, row.st_ino, row.st_uid, row.st_gid, row.st_mode, row.st_nlink,
                row.st_size, row.st_mtime_ns, row.st_ctime_ns)

    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        _declaration_require(identity(os.fstat(stream.fileno())) == identity(before))
        raw = stream.read(limit + 1)
        _declaration_require(len(raw) == before.st_size and len(raw) <= limit
            and identity(os.fstat(stream.fileno())) == identity(before)
            and identity(path.lstat()) == identity(before))
    return raw


def declaration_equivalence_materials(d, directory, recovery, *, producer, phase):
    """Acquire real source bytes for the trusted first/issuer/cold entry points.

    LIVE verifies the executing helpers against the actual immutable archive.
    COLD reads the old producer archive and stored historical files; it never
    inspects a retired container. Neither phase grants authority to a proof or
    replaces the caller's original historical/runtime/ended-command validators.
    The phase is selected by that fixed entry, never by a proof/configuration.
    """
    _declaration_require(phase in ('LIVE', 'COLD'))
    _declaration_exact(producer, ('commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'))
    _declaration_require(all(type(producer[k]) is str and re.fullmatch('[a-f0-9]{40}', producer[k])
        for k in ('commit', 'sourceTree')) and all(type(producer[k]) is str
        and re.fullmatch('[1-9][0-9]*', producer[k]) for k in ('workflowRunId', 'workflowRunAttempt')))
    directory = Path(directory)
    root = d.BASE / 'releases'
    _declaration_require(directory.parent == root and directory.is_dir()
        and directory.resolve() == directory and not directory.is_symlink()
        and re.fullmatch('[0-9]{8}T[0-9]{6}Z-' + BASELINE_COMMIT[:12], directory.name)
        and directory.stat().st_uid == os.geteuid()
        and stat.S_IMODE(directory.stat().st_mode) & 0o077 == 0)
    _declaration_require(type(recovery) is dict and type(recovery.get('restored')) is dict
        and fingerprint(recovery.get('policy')) == RECOVERY_POLICY_SHA256
        and recovery.get('marker') == recovery_marker(recovery['policy']))
    first, second = Path(recovery['source']), Path(recovery['restored']['source'])
    for folder, commit in ((first, RECOVERY_COMMIT), (second, RESTORED_COMMIT)):
        _declaration_require(folder.parent == root and folder.is_dir() and folder.resolve() == folder
            and not folder.is_symlink() and folder.stat().st_uid == os.geteuid()
            and stat.S_IMODE(folder.stat().st_mode) & 0o077 == 0
            and re.fullmatch('[0-9]{8}T[0-9]{6}Z-' + commit[:12], folder.name))
    old = legacy(d)
    paths = {
        'workspaceManifestBytesSha256': directory / 'release-manifest.json',
        'workspaceRecordBytesSha256': directory / old.STATE_FILE,
        'workspaceBuildProofBytesSha256': directory / old.PROOF_FILE,
        'restoredManifestBytesSha256': second / 'release-manifest.json',
        'restoredRecordBytesSha256': second / STATE_FILE,
        'restoredBuildProofBytesSha256': second / PROOF_FILE,
        'firstFailure': first / FAILURE_FILE, 'secondFailure': second / FAILURE_FILE,
        'recoveryPolicy': Path(__file__).with_name(RECOVERY_FILE)}
    historical = {name: _declaration_source_bytes(path) for name, path in paths.items()}
    documents = {name: closed_recovery_json(d, raw) for name, raw in historical.items()}
    workspace_files = recovery['restored'].get('workspaceOriginFiles')
    _declaration_require(type(workspace_files) is dict and all(
        _declaration_hash(workspace_files.get(filename))
        and hashlib.sha256(historical[name]).hexdigest() == workspace_files[filename]
        for name, filename in (
            ('workspaceManifestBytesSha256', 'release-manifest.json'),
            ('workspaceRecordBytesSha256', old.STATE_FILE),
            ('workspaceBuildProofBytesSha256', old.PROOF_FILE))))
    _declaration_require(fingerprint(documents['recoveryPolicy']) == RECOVERY_POLICY_SHA256
        and fingerprint(documents['firstFailure']) == RECOVERY_FAILURE_SHA256
        and fingerprint(documents['secondFailure']) == RESTORED_FAILURE_SHA256
        and documents['workspaceManifestBytesSha256'].get('commit') == BASELINE_COMMIT
        and documents['workspaceBuildProofBytesSha256'].get('commit') == BASELINE_COMMIT
        and documents['restoredManifestBytesSha256'].get('commit') == RESTORED_COMMIT
        and documents['restoredBuildProofBytesSha256'].get('commit') == RESTORED_COMMIT
        and documents['restoredBuildProofBytesSha256'] == recovery['policy']['restoredAttempt']['buildProof']
        and fingerprint(documents['restoredBuildProofBytesSha256']) == RESTORED_PROOF_SHA256
        and hashlib.sha256(historical['restoredManifestBytesSha256']).hexdigest()
            == recovery['restored']['manifestSha256']
        and hashlib.sha256(historical['restoredRecordBytesSha256']).hexdigest()
            == recovery['restored']['recordSha256'])
    key = (producer['commit'], producer['sourceTree'])
    cache = getattr(d, '_declarationSourceArchiveCache', {})
    raw = cache.get(key)
    if raw is None:
        url = ('https://github.com/wangchaozhuanyong/id-business-system/archive/'
               + producer['commit'] + '.tar.gz')
        with urllib.request.urlopen(url, timeout=60) as response:
            raw = response.read(128 * 1024 * 1024 + 1)
    inventory = archive_inventory(d, raw, producer['commit'], producer['sourceTree'])
    names = (*DECLARATION_EQUIVALENCE_HELPERS,
        'scripts/production-release/online-recharge-declaration-measurement.py',
        'scripts/production-release/api-admin-pending-receipt-wire.py',
        'scripts/production-release/online-recharge-daemon-identity.py',
        'scripts/production-release/online-recharge-daemon-listener.py',
        'scripts/production-release/online-recharge-daemon-socket.py')
    _declaration_require(all(n in inventory for n in names))
    if phase == 'LIVE':
        for name in names:
            actual = _declaration_source_bytes(Path(__file__).with_name(Path(name).name),
                limit=2 * 1024 * 1024 if name.endswith('/remote-deploy.py') else 1024 * 1024)
            _declaration_require(hashlib.sha256(actual).hexdigest() == inventory[name]['sha256'])
    # Cache bytes only after validating the entire tree. Every LIVE invocation
    # still rechecks the executing bytes and all historical files above.
    d._declarationSourceArchiveCache = {**cache, key: raw}
    full_producer = {**producer, 'archiveInventorySha256': fingerprint(inventory),
        'helpers': {n: inventory[n]['sha256'] for n in DECLARATION_EQUIVALENCE_HELPERS}}
    return {'producer': full_producer, 'archive_bytes': raw, 'historical_files': historical}


def _declaration_saved_artifact(d, producer, filename):
    _declaration_exact(producer, ('commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'))
    _declaration_require(all(type(producer[k]) is str and re.fullmatch('[a-f0-9]{40}', producer[k])
        for k in ('commit', 'sourceTree')) and all(type(producer[k]) is str
        and re.fullmatch('[1-9][0-9]*', producer[k]) for k in ('workflowRunId', 'workflowRunAttempt')))
    _declaration_require(filename in ('api-workspace-preflight-result.json', 'api-workspace-readback-invocation.json'))
    folder = d.BASE / '.staging' / ('api-workspace-preflight-' + producer['commit'] + '-'
        + producer['workflowRunId'] + '-' + producer['workflowRunAttempt'])
    _declaration_require(folder.is_dir() and folder.resolve() == folder and not folder.is_symlink()
        and folder.stat().st_uid == os.geteuid() and stat.S_IMODE(folder.stat().st_mode) == 0o700)
    path = folder / filename
    _declaration_require(stat.S_IMODE(path.lstat().st_mode) == 0o600)
    return _declaration_source_bytes(path, limit=65535)


def declaration_equivalence_preflight_bytes(d, *, producer, expected_sha):
    """Read the one transport-installed F_A/F_B, with exact original bytes."""
    _declaration_require(_declaration_hash(expected_sha))
    raw = _declaration_saved_artifact(d, producer, 'api-workspace-preflight-result.json')
    _declaration_require(hashlib.sha256(raw).hexdigest() == expected_sha)
    value = closed_recovery_json(d, raw)
    _declaration_require(type(value) is dict and value.get('mode') == 'preflight'
        and value.get('status') == 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED'
        and value.get('releaseCandidateCommit') == producer['commit']
        and value.get('workflowRunId') == producer['workflowRunId']
        and value.get('workflowRunAttempt') == producer['workflowRunAttempt']
        and type(value.get('commandId')) is str
        and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value['commandId']))
    return raw


def _declaration_instance_id():
    """Get the current EC2 identity from IMDSv2, without ambient proxy routing."""
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, message, headers, url):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request('http://169.254.169.254/latest/api/token',
        method='PUT', headers={'X-aws-ec2-metadata-token-ttl-seconds': '60'})
    with opener.open(request, timeout=3) as response:
        token = response.read(4097)
    _declaration_require(0 < len(token) <= 4096 and b'\n' not in token and b'\r' not in token)
    request = urllib.request.Request('http://169.254.169.254/latest/meta-data/instance-id',
        headers={'X-aws-ec2-metadata-token': token.decode('ascii')})
    with opener.open(request, timeout=3) as response:
        instance_id = response.read(129).decode('ascii')
    _declaration_require(re.fullmatch('i-(?:[a-f0-9]{8}|[a-f0-9]{17})', instance_id))
    return instance_id


def declaration_equivalence_saved_invocation(d, *, producer):
    """Read the immutable transport-installed ended Q invocation, without rewrite.

    This file is installed only after trusted AWS transport/full validation.
    The cold caller must still verify original publication files and the actual
    finite decoder from that producer archive, then bind the decoded Q seal.
    """
    raw = _declaration_saved_artifact(d, producer, 'api-workspace-readback-invocation.json')
    value = closed_recovery_json(d, raw)
    _declaration_require(type(value) is dict and value.get('Status') == 'Success'
        and type(value.get('ResponseCode')) is int and value['ResponseCode'] == 0
        and value.get('StandardErrorContent') == ''
        and type(value.get('StandardOutputContent')) is str
        and type(value.get('CommandId')) is str
        and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value['CommandId']))
    # The immutable file is installed by the fixed, fully validated AWS client.
    # A cold reader still binds the ended command to this actual host. It never
    # obtains host identity or completion metadata from a P/Q claim.
    _declaration_require(value.get('InstanceId') == _declaration_instance_id()
        and value.get('DocumentName') == 'AWS-RunShellScript'
        and value.get('PluginName') == 'aws:runShellScript'
        and type(value.get('ExecutionEndDateTime')) is str
        and re.fullmatch('[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(?:Z|\\+00:00)', value['ExecutionEndDateTime']))
    import datetime
    ended = datetime.datetime.fromisoformat(value['ExecutionEndDateTime'].replace('Z', '+00:00'))
    _declaration_require(ended.utcoffset() == datetime.timedelta(0)
        and ended <= datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=5))
    return {'raw_bytes': raw, 'command_id': value['CommandId']}


FORMAL_RUNTIME_DRIVER_SHA256 = '8b0f0f0d699a6d44e962d94a1e76a3361b8767917cf8973edd29a972afce8481'


class DeclarationDriverError(RuntimeError):
    """Non-authorizing bounded cause from the captured fixed driver only."""

DECLARATION_DIAGNOSTIC_STAGES = frozenset((
    'PACKAGE_BIND','LOCAL_PACKAGE','SOURCE_PROFILE',
    'ARCHIVE_BIND','CONFIGURE','ENTRY',
    'ACQUISITION','RULES','ACQUIRE',
    'MEASURE','AFTER','CONSTRUCT',
    'CLOSE','REGISTRY','QUALIFIER_PROFILE',
    'FACTORY','SESSION','INSTALL',
    'VFS_SOURCE','CLIENT_DIRECTORY','CLIENT_CONFIG',
    'RUNTIME_VFS','COLLECTION_TOOLS','NATIVE_PERMISSIONS',
    'NATIVE_TOOLS','DAEMON_INFO','STABILITY',
    'YIELD','CLEANUP',
))
DECLARATION_DIAGNOSTIC_CODES = frozenset((
    'ACTUAL_IDENTITY','ACTUAL_IDENTITY_CHANGED','ACTUAL_INSPECT_CHANGED',
    'ACTUAL_NETWORK_ADDRESS','ACTUAL_NETWORK_DECLARATION','ACTUAL_NETWORK_ID_OR_MEMBERS',
    'ACTUAL_NETWORK_INSPECT_CHANGED','ACTUAL_NETWORK_MEMBERS','ACTUAL_NETWORK_SET',
    'ACTUAL_PRIMARY_NETWORK','ACTUAL_STATE_OR_ENV','ACTUAL_VOLUME_INSPECT_CHANGED',
    'ATTRIBUTE_ERROR','BASE_SOURCE_UNMEASURED','BINDING_REPORT_INVALID',
    'BOUND_LABEL','CLEANUP_FAILED','CLEANUP_REMAINING',
    'CLEANUP_SEAL_CHANGED','CLIENT_DEFAULT_INJECTION','CLIENT_SOURCE_CHANGED',
    'CLI_SOURCE_CHANGED','CMDLINE_INVALID','COMPLETE_CONFIGURATION_DIFFERENCE',
    'COMPLETE_CONFIG_HOSTNAME','COMPLETE_CONFIG_DOMAINNAME','COMPLETE_CONFIG_USER',
    'COMPLETE_CONFIG_ATTACHSTDIN','COMPLETE_CONFIG_ATTACHSTDOUT','COMPLETE_CONFIG_ATTACHSTDERR',
    'COMPLETE_CONFIG_EXPOSEDPORTS','COMPLETE_CONFIG_TTY','COMPLETE_CONFIG_OPENSTDIN',
    'COMPLETE_CONFIG_STDINONCE','COMPLETE_CONFIG_ENV','COMPLETE_CONFIG_CMD',
    'COMPLETE_CONFIG_HEALTHCHECK','COMPLETE_CONFIG_ARGSESCAPED','COMPLETE_CONFIG_IMAGE',
    'COMPLETE_CONFIG_VOLUMES','COMPLETE_CONFIG_WORKINGDIR','COMPLETE_CONFIG_ENTRYPOINT',
    'COMPLETE_CONFIG_NETWORKDISABLED','COMPLETE_CONFIG_MACADDRESS','COMPLETE_CONFIG_ONBUILD',
    'COMPLETE_CONFIG_LABELS','COMPLETE_CONFIG_STOPSIGNAL','COMPLETE_CONFIG_STOPTIMEOUT',
    'COMPLETE_CONFIG_SHELL','COMPLETE_HOSTCONFIG_BINDS','COMPLETE_HOSTCONFIG_CONTAINERIDFILE',
    'COMPLETE_HOSTCONFIG_LOGCONFIG','COMPLETE_HOSTCONFIG_NETWORKMODE','COMPLETE_HOSTCONFIG_PORTBINDINGS',
    'COMPLETE_HOSTCONFIG_RESTARTPOLICY','COMPLETE_HOSTCONFIG_AUTOREMOVE','COMPLETE_HOSTCONFIG_VOLUMEDRIVER',
    'COMPLETE_HOSTCONFIG_VOLUMESFROM','COMPLETE_HOSTCONFIG_CONSOLESIZE','COMPLETE_HOSTCONFIG_ANNOTATIONS',
    'COMPLETE_HOSTCONFIG_CAPADD','COMPLETE_HOSTCONFIG_CAPDROP','COMPLETE_HOSTCONFIG_CGROUPNSMODE',
    'COMPLETE_HOSTCONFIG_DNS','COMPLETE_HOSTCONFIG_DNSOPTIONS','COMPLETE_HOSTCONFIG_DNSSEARCH',
    'COMPLETE_HOSTCONFIG_EXTRAHOSTS','COMPLETE_HOSTCONFIG_GROUPADD','COMPLETE_HOSTCONFIG_IPCMODE',
    'COMPLETE_HOSTCONFIG_CGROUP','COMPLETE_HOSTCONFIG_LINKS','COMPLETE_HOSTCONFIG_OOMSCOREADJ',
    'COMPLETE_HOSTCONFIG_PIDMODE','COMPLETE_HOSTCONFIG_PRIVILEGED','COMPLETE_HOSTCONFIG_PUBLISHALLPORTS',
    'COMPLETE_HOSTCONFIG_READONLYROOTFS','COMPLETE_HOSTCONFIG_SECURITYOPT','COMPLETE_HOSTCONFIG_STORAGEOPT',
    'COMPLETE_HOSTCONFIG_TMPFS','COMPLETE_HOSTCONFIG_UTSMODE','COMPLETE_HOSTCONFIG_USERNSMODE',
    'COMPLETE_HOSTCONFIG_SHMSIZE','COMPLETE_HOSTCONFIG_SYSCTLS','COMPLETE_HOSTCONFIG_RUNTIME',
    'COMPLETE_HOSTCONFIG_ISOLATION','COMPLETE_HOSTCONFIG_CPUSHARES','COMPLETE_HOSTCONFIG_MEMORY',
    'COMPLETE_HOSTCONFIG_NANOCPUS','COMPLETE_HOSTCONFIG_CGROUPPARENT','COMPLETE_HOSTCONFIG_BLKIOWEIGHT',
    'COMPLETE_HOSTCONFIG_BLKIOWEIGHTDEVICE','COMPLETE_HOSTCONFIG_BLKIODEVICEREADBPS','COMPLETE_HOSTCONFIG_BLKIODEVICEWRITEBPS',
    'COMPLETE_HOSTCONFIG_BLKIODEVICEREADIOPS','COMPLETE_HOSTCONFIG_BLKIODEVICEWRITEIOPS','COMPLETE_HOSTCONFIG_CPUPERIOD',
    'COMPLETE_HOSTCONFIG_CPUQUOTA','COMPLETE_HOSTCONFIG_CPUREALTIMEPERIOD','COMPLETE_HOSTCONFIG_CPUREALTIMERUNTIME',
    'COMPLETE_HOSTCONFIG_CPUSETCPUS','COMPLETE_HOSTCONFIG_CPUSETMEMS','COMPLETE_HOSTCONFIG_DEVICES',
    'COMPLETE_HOSTCONFIG_DEVICECGROUPRULES','COMPLETE_HOSTCONFIG_DEVICEREQUESTS','COMPLETE_HOSTCONFIG_KERNELMEMORY',
    'COMPLETE_HOSTCONFIG_KERNELMEMORYTCP','COMPLETE_HOSTCONFIG_MEMORYRESERVATION','COMPLETE_HOSTCONFIG_MEMORYSWAP',
    'COMPLETE_HOSTCONFIG_MEMORYSWAPPINESS','COMPLETE_HOSTCONFIG_OOMKILLDISABLE','COMPLETE_HOSTCONFIG_PIDSLIMIT',
    'COMPLETE_HOSTCONFIG_ULIMITS','COMPLETE_HOSTCONFIG_CPUCOUNT','COMPLETE_HOSTCONFIG_CPUPERCENT',
    'COMPLETE_HOSTCONFIG_IOMAXIMUMIOPS','COMPLETE_HOSTCONFIG_IOMAXIMUMBANDWIDTH','COMPLETE_HOSTCONFIG_MOUNTS',
    'COMPLETE_HOSTCONFIG_MASKEDPATHS','COMPLETE_HOSTCONFIG_READONLYPATHS','COMPLETE_HOSTCONFIG_INIT',
    'COMPLETE_CONFIG_OTHER','COMPLETE_HOSTCONFIG_OTHER','COMPLETE_MOUNTS_DIFFERENCE',
    'CONFIGURATION_INVALID','CONFIG_INVALID','DAEMON_CHANGED',
    'DAEMON_FD_MISSING','DAEMON_SOURCE_NOT_MEASURED','DEPENDENCY_LABEL',
    'ENV_INVALID','EXECUTABLE_INVALID','EXISTING_REFERENCE_REFUSED',
    'FD_INVALID','GENERATOR_SOURCE_CHANGED','HOST_MOUNTS_SHAPE',
    'HTTP_ERROR','IMAGE_INSPECT_CHANGED','LISTENER_INVALID',
    'MEASUREMENT_FAILED','MOUNT_BINDING','NAMESPACE_MISMATCH',
    'NATIVE_TOOL_CHANGED','ORIGIN_CHANGED','OS_ERROR',
    'PACKAGE_ARCHIVE_CHANGED','PACKAGE_BINARY_MISMATCH','PACKAGE_DIGEST_UNSUPPORTED',
    'PACKAGE_FILE_CHANGED','PACKAGE_INPUT_INVALID','PACKAGE_INVALID',
    'PACKAGE_SCHEMA_CHANGED','PACKAGE_SOURCE_CHANGED','PACK_IMAGE_OR_NATIVE_IDENTITY',
    'PACK_INVALID','PATH_INVALID','PERMISSIONS_INVALID',
    'PERMISSION_ERROR','POOL_SOURCE_CHANGED','PRIMARY_NETWORK',
    'PRIMARY_NETWORK_OR_IMAGE','PROCESS_INVALID','PROC_ALIAS_INVALID',
    'QUALIFIER_FROZEN_INPUT_CHANGED','QUALIFIER_UNAVAILABLE','REFERENCE_ID_CHANGED',
    'REFERENCE_MODEL_CHANGED','REFERENCE_NETWORK_OVERLAP','REFERENCE_NETWORK_SET',
    'REFERENCE_PATH_INVALID','REFERENCE_PENDING_ENDPOINT','REFERENCE_RESOURCE_CHANGED',
    'REFERENCE_STARTED_OR_OWNER_CHANGED','REFERENCE_STATE_OWNER_OR_ENV','REPLACE_LABEL',
    'REPORT_INVALID','RESOURCE_DEFAULT_POOL_INVALID','RESOURCE_INVENTORY_INVALID',
    'RESOURCE_IPAM_INVALID','RESOURCE_OWNER_OR_MEMBERS_INVALID','RESOURCE_PROPERTIES_INVALID',
    'RESOURCE_READ_INVALID','RESOURCE_SCHEMA_INVALID','RESOURCE_VOLUME_INVALID',
    'ROOT_ACQUISITION_UNAVAILABLE','ROOT_ADMIN_PROJECTION_FAILED','ROOT_DRIVER_SOURCE_UNMEASURED',
    'ROOT_DRIVER_UNAVAILABLE','ROOT_ENTRY_INVALID','ROOT_GENERATOR_SOURCE_UNMEASURED',
    'ROOT_HISTORY_CHANGED','ROOT_MEASUREMENT_INVALID','ROOT_OBSERVATION_CHANGED',
    'ROOT_PREFLIGHT_CHANGED','ROOT_PRODUCER_CHANGED','ROOT_REGISTRY_CHANGED',
    'ROOT_REGISTRY_EXISTS','ROOT_REGISTRY_INVALID','ROOT_REGISTRY_MISSING',
    'ROOT_SOURCE_CHANGED','RUNTIME_BINARY_CHANGED','RUNTIME_CAPABILITY_REQUIRED',
    'RUNTIME_DRIFT','RUNTIME_ERROR','RUNTIME_IDENTITY_INVALID',
    'RUNTIME_PACKAGE_CHANGED','RUNTIME_UNAVAILABLE','SERVICE_INVALID',
    'SOCKET_BINDING_CHANGED','SOCKET_BINDING_DRIFT','SOCKET_BINDING_INVALID',
    'SOCKET_BINDING_UNAVAILABLE','SOCKET_PATH_INVALID','SOCKET_PERMISSIONS_INVALID',
    'SOURCE_DECLARATION_INVALID','SOURCE_ENV_INVALID','SOURCE_ENV_SEAL_CHANGED',
    'SOURCE_FILES_CHANGED','SOURCE_FILE_INVALID','SOURCE_FILE_PERMISSIONS',
    'SOURCE_IMAGE_INVALID','SOURCE_MODEL_HASH_INVALID','SOURCE_NETWORK_DECLARATION',
    'SOURCE_NOT_MEASURED','SOURCE_PATH_INVALID','SOURCE_PROFILE_INVALID',
    'SOURCE_PROJECT_INVALID','SOURCE_REPLACE_ANCHOR_INVALID','SOURCE_SEAL_INVALID',
    'SOURCE_VOLUME_DECLARATION','TIMEOUT','TYPE_ERROR',
    'UNKNOWN','URL_ERROR','VFS_BINDING_UNAVAILABLE',
    'VFS_BOUND_CAPABILITY_REQUIRED','VFS_DIAG_UNAVAILABLE','VFS_DRIFT',
    'VFS_NODE_MISMATCH','VFS_QUERY_INVALID','VFS_REPORT_INVALID',
    'VFS_SOURCE_UNMEASURED','VFS_WIRE_INVALID',
    'FILE_EXISTS_ERROR','FILE_NOT_FOUND_ERROR',
    'CLI_COMPOSE_LEAF_SYMLINK','CLI_COMPOSE_NLINK','CLI_COMPOSE_NOT_REGULAR',
    'CLI_COMPOSE_OWNER_EXEC','CLI_COMPOSE_SPECIAL_MODE','CLI_COMPOSE_UID',
    'CLI_COMPOSE_WRITABLE','CLI_DOCKER_LEAF_SYMLINK','CLI_DOCKER_NLINK',
    'CLI_DOCKER_NOT_REGULAR','CLI_DOCKER_OWNER_EXEC','CLI_DOCKER_SPECIAL_MODE',
    'CLI_DOCKER_UID','CLI_DOCKER_WRITABLE',
    'SOURCE_COMPOSE_PARENT_UID',
    'SOURCE_COMPOSE_PARENT_WRITABLE',
    'SOURCE_COMPOSE_PUBLIC_WRITABLE',
    'SOURCE_RELEASE_PARENT_UID',
    'SOURCE_RELEASE_PARENT_WRITABLE',
    'SOURCE_RELEASE_PUBLIC_WRITABLE',
    'SOURCE_CLIENT_PARENT_UID',
    'SOURCE_CLIENT_PARENT_WRITABLE',
    'SOURCE_CLIENT_PRIVATE_MODE',
    'FACTS_FILE_CHANGED','FACTS_INPUT_INVALID','FACTS_NETWORK_CHANGED',
    'FACTS_OBSERVATION_CHANGED','FACTS_PATH_CHANGED','FACTS_READER_FAILED',
    'FACTS_READER_INVALID','FACTS_READ_BOUND','FACTS_READ_JSON',
    'FACTS_RESOURCE_CHANGED','FACTS_ROOT_CAPABILITY_REQUIRED','FACTS_SNAPSHOT_CHANGED',
    'FACTS_SOURCE_CHANGED','FACTS_UNAPPROVED_COMMAND',
))

def declaration_failure_diagnostic(error):
    if type(error) is DeclarationDriverError:
        value=error.__dict__.get('_declaration_failure')
        if (type(value) is tuple and len(value)==2 and type(value[0]) is str and type(value[1]) is str
                and value[0] in DECLARATION_DIAGNOSTIC_STAGES and value[1] in DECLARATION_DIAGNOSTIC_CODES):
            return {'stage':value[0],'code':value[1]}
    return None

def _declaration_driver_failure(message,failure):
    error=DeclarationDriverError(message)
    if (type(failure) is dict and set(failure)=={'stage','code'} and type(failure['stage']) is str
            and type(failure['code']) is str and failure['stage'] in DECLARATION_DIAGNOSTIC_STAGES
            and failure['code'] in DECLARATION_DIAGNOSTIC_CODES):
        error._declaration_failure=(failure['stage'],failure['code'])
    else:error._declaration_failure=('PACKAGE_BIND','UNKNOWN')
    return error


def _declaration_runtime_driver():
    """Compile only captured fixed driver bytes; package binds the full archive."""
    try:
        import types
        path = Path(__file__).with_name('formal-runtime-package') / 'driver.py'
        raw = _declaration_source_bytes(path, limit=256 * 1024)
        _declaration_require(hashlib.sha256(raw).hexdigest() == FORMAL_RUNTIME_DRIVER_SHA256)
        module = types.ModuleType('_online_formal_runtime_driver')
        module.__file__ = str(path)
        exec(compile(raw, str(path), 'exec'), module.__dict__)
        return module
    except Exception:
        raise _declaration_driver_failure('ONLINE_RECHARGE_DECLARATION_DRIVER_UNAVAILABLE',
            {'stage':'LOCAL_PACKAGE','code':'UNKNOWN'}) from None


def measure_declaration_equivalence(d, directory, recovery, *, producer, purpose, preflight_raw=None):
    """Fixed source/runtime entry; unsupported sources fail before references."""
    _declaration_require(purpose in ('INDEPENDENT_PREFLIGHT', 'DEPLOYMENT_REMEASURE'))
    _declaration_require(preflight_raw is None if purpose == 'INDEPENDENT_PREFLIGHT'
                         else type(preflight_raw) is bytes and 0 < len(preflight_raw) < 65536)
    driver = _declaration_runtime_driver()
    try:
        return driver.measure_declaration_equivalence(d, directory, recovery,
            producer=producer, purpose=purpose, preflight_raw=preflight_raw)
    except Exception as error:
        failure=driver.failure_diagnostic(error)
        message='ONLINE_RECHARGE_DECLARATION_DRIVER_UNAVAILABLE'
        if type(error) is driver.Rejected and BaseException.args.__get__(error)==('ROOT_GENERATOR_SOURCE_UNMEASURED',):
            message='ONLINE_RECHARGE_DECLARATION_SOURCE_NOT_MEASURED'
        raise _declaration_driver_failure(message,failure) from None

# Same immutable main candidate: initial WORKSPACE publication then ONLINE.
# Finite initial WORKSPACE type/argv/transport adapter.
ONLINE_PENDING_WORKSPACE_KIND = 'ONLINE_RECHARGE_PENDING_WORKSPACE_ORIGIN'
ONLINE_AFTER_BIT_KIND = 'ONLINE_RECHARGE_AFTER_BIT_SUCCESSOR_ORIGIN'
_WORKSPACE_ORIGIN_TYPES = {
    ONLINE_PENDING_WORKSPACE_KIND: ('onlinePendingWorkspaceOrigin', 'ONLINE_RECHARGE_PENDING_WORKSPACE'),
    ONLINE_AFTER_BIT_KIND: ('onlineAfterBitOrigin', 'ONLINE_RECHARGE_AFTER_BIT'),
}
ONLINE_PENDING_WORKSPACE_FIELDS = ('kind', 'version', 'baselineRelease', 'baselineCommit', 'baselineProducer',
    'manifestBytesSha256', 'recordBytesSha256', 'buildProofBytesSha256', 'buildProofCanonicalSha256', 'environmentFileSha256',
    'publicationSha256', 'pendingOriginSha256', 'readbackCommandId', 'readbackInvocationBytesSha256',
    'initialReadbackInvocationBytesSha256', 'originalWorkspace', 'migrationRecovery', 'migrationState',
    'services', 'configurationAfter')


def _workspace_bridge_shape(d, value, kind):
    """Shape only: the cold consumer must acquire and derive this exact value."""
    try:
        _declaration_exact(value, ONLINE_PENDING_WORKSPACE_FIELDS)
        _declaration_require(kind in _WORKSPACE_ORIGIN_TYPES and value['kind'] == kind
            and type(value['version']) is int and value['version'] == 1)
        _declaration_exact(value['baselineProducer'], ('commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'))
        p = value['baselineProducer']
        _declaration_require(all(type(p[n]) is str and re.fullmatch('[a-f0-9]{40}', p[n]) for n in ('commit', 'sourceTree'))
            and all(type(p[n]) is str and re.fullmatch('[1-9][0-9]*', p[n]) for n in ('workflowRunId', 'workflowRunAttempt'))
            and value['baselineCommit'] == p['commit'])
        _declaration_require(type(value['baselineRelease']) is str and re.fullmatch(
            re.escape(str(d.BASE / 'releases')) + '/[0-9]{8}T[0-9]{6}Z-' + p['commit'][:12], value['baselineRelease']))
        _declaration_require(all(_declaration_hash(v) for k, v in value.items() if k.endswith('Sha256')))
        _declaration_require(type(value['readbackCommandId']) is str and re.fullmatch(
            '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value['readbackCommandId']))
        _declaration_states(value['services']); _declaration_exact(value['configurationAfter'],
            ('docker-compose.aws-mysql.yml', 'deploy/caddy/Caddyfile.aws', SCHEMA_FILE, 'compose.release.json'))
        _declaration_require(all(_declaration_hash(v) for v in value['configurationAfter'].values()))
        _declaration_exact(value['originalWorkspace'], ('release', 'manifestSha256'))
        _declaration_require(type(value['originalWorkspace']['release']) is str and re.fullmatch(
            '/opt/id-business-v2/releases/[0-9]{8}T[0-9]{6}Z-' + BASELINE_COMMIT[:12], value['originalWorkspace']['release'])
            and _declaration_hash(value['originalWorkspace']['manifestSha256']))
        _declaration_require(value['migrationRecovery'] == recovery_marker(recovery_policy(d))
            and type(value['migrationState']) is dict and set(value['migrationState']) == {'name','sha256','status','schemaVerified','appliedMigrationsSha256'}
            and value['migrationState']['name'] == MIGRATION_NAME and value['migrationState']['sha256'] == MIGRATION_IDENTITY['sha256']
            and value['migrationState']['status'] == 'APPLIED' and value['migrationState']['schemaVerified'] is True
            and _declaration_hash(value['migrationState']['appliedMigrationsSha256']))
        if kind == ONLINE_AFTER_BIT_KIND:
            _declaration_require(value['readbackInvocationBytesSha256'] != value['initialReadbackInvocationBytesSha256'])
        return value
    except Exception:
        raise RuntimeError('ONLINE_RECHARGE_PENDING_WORKSPACE_ORIGIN_CHANGED') from None


def online_pending_workspace_bridge_shape(d, value):
    return _workspace_bridge_shape(d, value, ONLINE_PENDING_WORKSPACE_KIND)


def online_after_bit_bridge_shape(d, value):
    return _workspace_bridge_shape(d, value, ONLINE_AFTER_BIT_KIND)


def _online_after_bit_audit_queries(d, reader, directory, api_identity, *, history_cutoff=None):
    """Pure fixed SQL generation; the caller must bind this original API to real B."""
    code = 'ONLINE_RECHARGE_AFTER_BIT_AUDIT_QUERY_CHANGED'
    anchor = 'CONVERT(0xe887aae58aa8e6b3a8e5868c USING utf8mb4)'
    original = ("SELECT JSON_OBJECT('connectionId',CONNECTION_ID(),'auditCount',"
        "CAST(COALESCE(SUM(module=" + anchor + "),0) AS UNSIGNED),"
        "'onlineAuditCount',CAST(COALESCE(SUM(module='online_recharge'),0) AS UNSIGNED),'tables',JSON_OBJECT("
        + ','.join("'" + name + "',(SELECT COUNT(*) FROM `" + name + "`)" for name in TABLES)
        + ")) FROM audit_logs")
    d.require(getattr(reader, 'ONLINE_TABLES', None) == TABLES
              and getattr(reader, 'ONLINE_AUDIT_QUERY', None) == original
              and original.count(anchor) == 1, code)
    d.require(type(api_identity) is dict and set(api_identity) == {
        'containerId', 'image', 'startedAtSha256', 'startedAt'}
        and type(api_identity['startedAt']) is str and re.fullmatch(
            r'20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z', api_identity['startedAt'])
        and hashlib.sha256(api_identity['startedAt'].encode()).hexdigest() == api_identity['startedAtSha256'], code)
    # Exact original WorkspaceAuditBarrier Date/Prisma boundary and predicate.
    since = api_identity['startedAt'].replace('T', ' ').rstrip('Z')
    if '.' in since:
        first, fraction = since.split('.', 1)
        since = first + '.' + fraction[:3].ljust(3, '0')
    stamp = 'CONVERT(0x' + since.encode().hex() + ' USING utf8mb4)'
    if history_cutoff is not None:
        from datetime import datetime, timedelta
        d.require(type(history_cutoff) is str and re.fullmatch(
            r'20[0-9]{2}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}', history_cutoff), code)
        try:
            seconds, _, fraction = api_identity['startedAt'][:-1].partition('.')
            boot = datetime.fromisoformat(seconds + '.' + fraction[:6].ljust(6, '0'))
            if len(fraction) > 6 and any(v != '0' for v in fraction[6:]):
                boot += timedelta(microseconds=1)
            valid = datetime.fromisoformat(history_cutoff) >= boot
        except ValueError:
            valid = False
        d.require(valid, code)
    cutoff = ('UTC_TIMESTAMP(6)' if history_cutoff is None else
              'CAST(CONVERT(0x' + history_cutoff.encode().hex() + ' USING utf8mb4) AS DATETIME(6))')
    cutoff_text = "DATE_FORMAT(" + cutoff + ",'%Y-%m-%d %H:%i:%s.%f')"
    literal = lambda value: 'CONVERT(0x' + value.encode().hex() + ' USING utf8mb4) COLLATE utf8mb4_unicode_ci'
    predicate = ('created_at>=CAST(' + stamp + ' AS DATETIME(6)) AND module=' + literal('自动注册')
        + ' AND action=' + literal('操作请求') + ' AND object_type=' + literal('开源注册模块')
        + " AND (remark LIKE '% /api/registration%' OR remark LIKE '% /api/ws/%')")
    legacy_query = ("SELECT JSON_OBJECT('version',1,'connectionId',CONNECTION_ID(),'busy',"
        'IF(UTC_TIMESTAMP(6)<CAST(' + stamp + ' AS DATETIME(6)),1,(SELECT COUNT(*) FROM audit_logs '
        'WHERE ' + predicate + ')));\n')
    metadata = ("(SELECT JSON_ARRAYAGG(JSON_OBJECT('event',EVENT_MANIPULATION,'timing',ACTION_TIMING,"
        "'statement',ACTION_STATEMENT)) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() "
        "AND EVENT_OBJECT_TABLE='audit_logs')")
    query = ("SELECT JSON_OBJECT('connectionId',CONNECTION_ID(),'historicalRegistrationAuditCount',"
        'CAST(COALESCE(SUM(module=' + literal('自动注册') + '),0) AS UNSIGNED),'
        "'historicalRegistrationPrefixCount',CAST(COALESCE(SUM(module=" + literal('自动注册')
        + ' AND created_at<=' + cutoff + "),0) AS UNSIGNED),'historyCutoff'," + cutoff_text
        + ",'clockBeforeCutoff',IF(UTC_TIMESTAMP(6)<" + cutoff + ',1,0),'
        "'registrationMutationCount',IF(UTC_TIMESTAMP(6)<CAST(" + stamp + ' AS DATETIME(6)),1,'
        'CAST(COALESCE(SUM(' + predicate + '),0) AS UNSIGNED)),'
        "'onlineAuditCount',CAST(COALESCE(SUM(module='online_recharge'),0) AS UNSIGNED),'tables',JSON_OBJECT("
        + ','.join("'" + name + "',(SELECT COUNT(*) FROM `" + name + "`)" for name in TABLES)
        + "),'triggers'," + metadata + ') FROM audit_logs')
    history_query = ("SELECT JSON_OBJECT('connectionId',CONNECTION_ID(),'historicalRegistrationPrefixCount',"
        'CAST(COALESCE(SUM(module=' + literal('自动注册') + ' AND created_at<=' + cutoff
        + "),0) AS UNSIGNED),'historyCutoff'," + cutoff_text
        + ",'clockBeforeCutoff',IF(UTC_TIMESTAMP(6)<" + cutoff + ",1,0),'triggers'," + metadata + ') FROM audit_logs')
    expected = {}
    for event, migration in (('DELETE', '20261002123500_routine_audit_retention_exception'),
                              ('UPDATE', '20260830182500_mysql_trigger_service_definers')):
        raw = (directory / reader.MIGRATION_ROOT / migration / 'migration.sql').read_text()
        name = 'idv2_audit_log_no_' + ('delete' if event == 'DELETE' else 'update')
        body = raw.split('CREATE TRIGGER `' + name + '`', 1)[1].split('FOR EACH ROW', 1)[1]
        body = body.split('END;', 1)[0] + 'END' if event == 'DELETE' else body.split(';', 1)[0]
        expected[event] = ' '.join(body.split()).rstrip(';')
    return {'frameQuery': query, 'historyQuery': history_query,
        'metadataQuery': "SELECT JSON_OBJECT('connectionId',CONNECTION_ID(),'triggers'," + metadata + ')',
        'expectedTriggers': expected, 'expectedTriggersSha256': fingerprint(expected),
        'legacyRegistrationQuery': legacy_query, 'originalOnlineQuery': original}


def _online_after_bit_audit_binding(d, bridge, proof):
    actual, producer = _pending_workspace_session(d)
    d.require(actual == bridge and bridge['kind'] == ONLINE_AFTER_BIT_KIND,
              'ONLINE_RECHARGE_AFTER_BIT_ORIGIN_CHANGED')
    raw = online_after_bit_preflight_bytes(d, producer=producer, expected_sha256=proof.get('preflightBytesSha256'))
    online_after_bit_build_shape(d, proof, producer=producer, bridge=bridge, preflight_raw=raw)
    return {'baselineOriginSha256': fingerprint(bridge), 'baselineProducer': bridge['baselineProducer'],
        'producer': producer, 'preflightBytesSha256': hashlib.sha256(raw).hexdigest(),
        'buildProofSha256': fingerprint(proof), 'sourceHelpers': {name: hashlib.sha256(
            _declaration_source_bytes(Path(__file__).with_name(name), limit=512 * 1024)).hexdigest()
            for name in ('api-admin-scope.py', 'online-recharge-scope.py')}}


def _online_after_bit_mysql_check(d, directory, expected, deadline):
    code = 'ONLINE_RECHARGE_AFTER_BIT_MYSQL_CHANGED'
    def remaining():
        value = min(5, deadline - time.monotonic())
        d.require(value > 0, 'API_ADMIN_WORKSPACE_GUARD_TIMEOUT')
        return value
    identifier = d.compose(directory, 'ps', '-q', 'mysql', timeout=remaining()).strip()
    d.require(identifier == expected['containerId'], code)
    metadata = json.loads(d.run('docker', 'inspect', identifier, timeout=remaining()))[0]
    environment = metadata.get('Config', {}).get('Env')
    d.require(type(environment) is list and environment and all(type(v) is str for v in environment), code)
    state = metadata.get('State', {})
    d.require(metadata.get('Id') == expected['containerId'] and metadata.get('Image') == expected['image']
        and metadata.get('Config', {}).get('Image') == expected['reference']
        and state.get('Status') == expected['status'] == 'running'
        and state.get('Health', {}).get('Status') == expected['health'] == 'healthy'
        and type(state.get('StartedAt')) is str
        and hashlib.sha256(state['StartedAt'].encode()).hexdigest() == expected['startedAtSha256']
        and fingerprint(sorted(environment)) == expected['environmentSha256']
        and time.monotonic() < deadline, code)


def _online_after_bit_audit_transport(d, directory, bridge, reader, identity, plan, basis, *, history_record=None, first_api_check=None):
    """Private verified B publication or sealed historical-prefix readback fence."""
    code = 'ONLINE_RECHARGE_AFTER_BIT_AUDIT_GUARD_LOST'
    class Barrier(reader.WorkspaceUnusedAuditBarrier):
        def __init__(self):
            super().__init__(d, directory, online=True)
            d.require(self.query == plan['originalOnlineQuery'], 'ONLINE_RECHARGE_AFTER_BIT_AUDIT_QUERY_CHANGED')
            self.plan = plan
            self.query = plan['frameQuery'] if history_record is None else plan['historyQuery']
            self.initial_query = self.query
            self.before, self.after, self.receipt = None, None, None
            self.source_api_identity = dict(identity)

        def check(self, value=None):
            if value is None:
                self.pipe.send(self.query + ';\n')
                value = self.pipe.read(limit=4096)
            fields = {'connectionId', 'historicalRegistrationPrefixCount', 'historyCutoff', 'clockBeforeCutoff', 'triggers'}
            if history_record is None:
                fields |= {'historicalRegistrationAuditCount', 'registrationMutationCount', 'onlineAuditCount', 'tables'}
            d.require(type(value) is dict and set(value) == fields
                and type(self.connection_id) is int and self.connection_id > 0
                and type(value['connectionId']) is int and value['connectionId'] == self.connection_id
                and type(value['historicalRegistrationPrefixCount']) is int and 0 <= value['historicalRegistrationPrefixCount'] < 2**63
                and type(value['clockBeforeCutoff']) is int and value['clockBeforeCutoff'] == 0
                and self.pipe.process.poll() is None and time.monotonic() < self.pipe.deadline, code)
            bound = _online_after_bit_audit_queries(d, reader, directory, identity, history_cutoff=value['historyCutoff'])
            if history_record is None:
                d.require(type(value['historicalRegistrationAuditCount']) is int
                    and value['historicalRegistrationAuditCount'] == value['historicalRegistrationPrefixCount']
                    and type(value['registrationMutationCount']) is int and value['registrationMutationCount'] == 0
                    and type(value['onlineAuditCount']) is int and value['onlineAuditCount'] == 0
                    and type(value['tables']) is dict and value['tables'] == {n: 0 for n in TABLES}
                    and all(type(v) is int for v in value['tables'].values()), code)
            else:
                d.require(value['historyCutoff'] == history_record['historyCutoff']
                    and value['historicalRegistrationPrefixCount'] == history_record['historicalRegistrationAuditCount'], code)
            rows = value['triggers']
            d.require(type(rows) is list and len(rows) == 2 and all(type(row) is dict
                and set(row) == {'event', 'timing', 'statement'} and row['timing'] == 'BEFORE'
                and type(row['statement']) is str for row in rows)
                and {row['event']: ' '.join(row['statement'].split()).rstrip(';') for row in rows} == self.plan['expectedTriggers'], code)
            summary = {n: value[n] for n in fields - {'connectionId', 'triggers'}}
            summary['triggerDefinitionsSha256'] = self.plan['expectedTriggersSha256']
            d.require(self.before is None or fingerprint(summary) == fingerprint(self.before), code)
            _online_after_bit_mysql_check(d, directory, bridge['services']['mysql'], self.pipe.deadline)
            if self.before is None and first_api_check is not None:
                first_api_check(self.pipe.deadline)
            d.require(self.pipe.process.poll() is None and time.monotonic() < self.pipe.deadline, code)
            if self.before is None:
                self.before = json.loads(json.dumps(summary))
                self.plan = bound
                if history_record is None:
                    self.query = bound['frameQuery']
            self.after = summary

        def before_stop(self):
            d.require(first_api_check is not None and history_record is None, code)
            first_api_check(self.pipe.deadline)
            super().before_stop()
            # API identity 30s + stop 45s + inspect 15s, two SQL/MySQL checks
            # 44s, final inspect 5s and transport close 9s, with bounded slack.
            d.require(time.monotonic() + 170 < self.pipe.deadline, 'API_ADMIN_WORKSPACE_GUARD_TIMEOUT')

        def confirm_stopped(self, sqlite_gate):
            remaining = min(5, self.pipe.deadline - time.monotonic())
            d.require(remaining > 0 and history_record is None and self.before is not None
                and fingerprint(self.before) == fingerprint(self.after) and self.pipe.process.poll() is None, code)
            metadata = json.loads(d.run('docker', 'inspect', identity['containerId'], timeout=remaining))[0]
            state = metadata.get('State', {})
            d.require(metadata.get('Id') == identity['containerId'] and metadata.get('Image') == identity['image']
                and type(state.get('StartedAt')) is str and hashlib.sha256(state['StartedAt'].encode()).hexdigest() == identity['startedAtSha256']
                and state.get('Running') is False and type(state.get('Pid')) is int and state['Pid'] == 0
                and self.pipe.process.poll() is None and time.monotonic() < self.pipe.deadline
                and type(sqlite_gate.record) is dict and sqlite_gate.record.get('sourceApiIdentity') == {
                    n: identity[n] for n in ('containerId', 'image', 'startedAtSha256')}, code)
            # Seal one final unchanged frame after the actual old PID reached zero.
            self.check()
            d.require(self.pipe.process.poll() is None and time.monotonic() < self.pipe.deadline, code)
            self.receipt = {'version': 1, 'kind': 'ONLINE_RECHARGE_AFTER_BIT_AUDIT_PROTECTION', 'basis': basis,
                'sourceApiIdentity': identity, 'mysqlIdentitySha256': fingerprint(bridge['services']['mysql']),
                'initialQuerySha256': hashlib.sha256(self.initial_query.encode()).hexdigest(),
                'querySha256': hashlib.sha256(self.query.encode()).hexdigest(),
                'historyQuerySha256': hashlib.sha256(self.plan['historyQuery'].encode()).hexdigest(),
                'triggerDefinitionsSha256': self.plan['expectedTriggersSha256'],
                'connectionIdSha256': fingerprint(self.connection_id), 'before': self.before, 'after': self.after,
                'oldApiStop': {'identity': {n: identity[n] for n in ('containerId', 'image', 'startedAtSha256')}, 'running': False, 'pid': 0},
                'sqliteProtectionSha256': fingerprint(sqlite_gate.record)}
            return self.receipt
    return Barrier()


def _online_after_bit_unused_audit_barrier(d, directory, bridge, proof):
    if 'restoration' in getattr(d,'_onlinePendingWorkspaceSession',{}):
        return _restored_workspace_unused_audit_barrier(d,directory,bridge,proof)
    online_after_bit_bridge_shape(d, bridge)
    d.require(str(directory) == bridge['baselineRelease'], 'ONLINE_RECHARGE_AFTER_BIT_ORIGIN_CHANGED')
    basis = _online_after_bit_audit_binding(d, bridge, proof)
    reader = legacy(d)
    admission = reader.WorkspaceAuditBarrier(d, directory)
    identity = admission.api_identity
    d.require(all(identity[n] == bridge['services']['api'][n] for n in ('containerId', 'image', 'startedAtSha256')),
              'ONLINE_RECHARGE_AFTER_BIT_API_CHANGED')
    plan = _online_after_bit_audit_queries(d, reader, directory, identity)
    d.require(admission.QUERY == plan['legacyRegistrationQuery'], 'ONLINE_RECHARGE_AFTER_BIT_AUDIT_QUERY_CHANGED')
    d.require(reader.workspace_audit_protection(d, directory) == plan['expectedTriggersSha256'],
              'API_ADMIN_WORKSPACE_AUDIT_HISTORY_UNPROVEN')
    def api_check(deadline):
        remaining = min(5, deadline - time.monotonic())
        d.require(remaining > 0, 'API_ADMIN_WORKSPACE_GUARD_TIMEOUT')
        d.require(reader.workspace_api_identity(d, directory, expected=identity, timeout=remaining) == identity,
                  'ONLINE_RECHARGE_AFTER_BIT_API_CHANGED')
    return _online_after_bit_audit_transport(d, directory, bridge, reader, identity, plan, basis, first_api_check=api_check)


def _online_after_bit_audit_receipt(d, directory, bridge, proof, manifest, record):
    """Rebind the original publication proof, preserve its prefix and allow later business."""
    if 'restoration' in getattr(d,'_onlinePendingWorkspaceSession',{}):
        return _restored_workspace_audit_receipt(d,directory,bridge,proof,manifest,record)
    code = 'ONLINE_RECHARGE_AFTER_BIT_AUDIT_RECEIPT_CHANGED'
    value = record.get('afterBitAuditProtection')
    d.require(type(value) is dict and set(value) == {'version', 'kind', 'basis', 'sourceApiIdentity',
        'mysqlIdentitySha256', 'initialQuerySha256', 'querySha256', 'historyQuerySha256', 'triggerDefinitionsSha256',
        'connectionIdSha256', 'before', 'after', 'oldApiStop', 'sqliteProtectionSha256'}
        and type(value['version']) is int and value['version'] == 1
        and value['kind'] == 'ONLINE_RECHARGE_AFTER_BIT_AUDIT_PROTECTION', code)
    basis = _online_after_bit_audit_binding(d, bridge, proof)
    reader = legacy(d)
    identity = value['sourceApiIdentity']
    d.require(type(identity) is dict and set(identity) == {'containerId', 'image', 'startedAtSha256', 'startedAt'}
        and all(identity[n] == bridge['services']['api'][n] for n in ('containerId', 'image', 'startedAtSha256')), code)
    before = value['before']
    d.require(type(before) is dict and set(before) == {'historicalRegistrationAuditCount', 'historicalRegistrationPrefixCount',
        'historyCutoff', 'clockBeforeCutoff', 'registrationMutationCount', 'onlineAuditCount', 'tables', 'triggerDefinitionsSha256'}
        and type(before['historicalRegistrationAuditCount']) is int and 0 <= before['historicalRegistrationAuditCount'] < 2**63
        and type(before['historicalRegistrationPrefixCount']) is int
        and before['historicalRegistrationPrefixCount'] == before['historicalRegistrationAuditCount']
        and all(type(before[n]) is int and before[n] == 0 for n in ('clockBeforeCutoff', 'registrationMutationCount', 'onlineAuditCount'))
        and type(before['tables']) is dict and before['tables'] == {n: 0 for n in TABLES}
        and all(type(v) is int for v in before['tables'].values())
        and type(value['after']) is dict and fingerprint(value['after']) == fingerprint(before), code)
    initial = _online_after_bit_audit_queries(d, reader, Path(bridge['baselineRelease']), identity)
    plan = _online_after_bit_audit_queries(d, reader, Path(bridge['baselineRelease']), identity, history_cutoff=before['historyCutoff'])
    from datetime import datetime, timedelta
    try:
        published = datetime.strptime(manifest.get('deployedAt', ''), '%Y-%m-%dT%H:%M:%SZ')
        cutoff_bounded = datetime.fromisoformat(before['historyCutoff']) < published + timedelta(seconds=1)
    except ValueError:
        cutoff_bounded = False
    d.require(cutoff_bounded and before['triggerDefinitionsSha256'] == plan['expectedTriggersSha256']
        and value['basis'] == basis and value['mysqlIdentitySha256'] == fingerprint(bridge['services']['mysql'])
        and value['initialQuerySha256'] == hashlib.sha256(initial['frameQuery'].encode()).hexdigest()
        and value['querySha256'] == hashlib.sha256(plan['frameQuery'].encode()).hexdigest()
        and value['historyQuerySha256'] == hashlib.sha256(plan['historyQuery'].encode()).hexdigest()
        and value['triggerDefinitionsSha256'] == plan['expectedTriggersSha256'] and _declaration_hash(value['connectionIdSha256'])
        and type(value['oldApiStop']) is dict and set(value['oldApiStop']) == {'identity', 'running', 'pid'}
        and value['oldApiStop']['identity'] == {n: identity[n] for n in ('containerId', 'image', 'startedAtSha256')}
        and value['oldApiStop']['running'] is False and type(value['oldApiStop']['pid']) is int and value['oldApiStop']['pid'] == 0
        and value['sqliteProtectionSha256'] == record.get('sqliteProtectionSha256')
        and manifest.get('onlineRechargePublication', {}).get('afterBitAuditProtectionSha256') == fingerprint(value), code)
    sqlite = closed_recovery_json(d, _declaration_source_bytes(directory / reader.WORKSPACE_SQLITE_RECEIPT))
    d.require(fingerprint(sqlite) == value['sqliteProtectionSha256']
        and sqlite.get('sourceApiIdentity') == value['oldApiStop']['identity'], code)
    d.require(reader.workspace_audit_protection(d, directory) == plan['expectedTriggersSha256'], code)
    # Old B may have been removed. Current C activity uses its existing idle guards;
    # legitimate newer rows are not reclassified as first-publication qualification.
    reader.online_idle(d, directory)
    reader.workspace_idle(d, directory, legacy=False)
    barrier = _online_after_bit_audit_transport(d, directory, bridge, reader, identity, plan, basis, history_record=before)
    with barrier:
        barrier.check()
    reader.online_idle(d, directory)
    reader.workspace_idle(d, directory, legacy=False)
    return {'afterBitAuditProtectionSha256': fingerprint(value),
        'preservedRegistrationAuditCount': before['historicalRegistrationAuditCount'], 'auditHistoryCutoff': before['historyCutoff']}


def _workspace_origin_type(d, bridge):
    kind = bridge.get('kind') if type(bridge) is dict else None
    d.require(kind in _WORKSPACE_ORIGIN_TYPES, 'ONLINE_RECHARGE_PENDING_WORKSPACE_ORIGIN_CHANGED')
    _workspace_bridge_shape(d, bridge, kind)
    return _WORKSPACE_ORIGIN_TYPES[kind]


def _workspace_evidence_origin(d, evidence):
    d.require(type(evidence) is dict, 'ONLINE_RECHARGE_PENDING_WORKSPACE_ORIGIN_CHANGED')
    selected = [name for name, unused in _WORKSPACE_ORIGIN_TYPES.values() if name in evidence]
    d.require(len(selected) == 1, 'ONLINE_RECHARGE_PENDING_WORKSPACE_ORIGIN_CHANGED')
    bridge = evidence[selected[0]]
    d.require(_workspace_origin_type(d, bridge)[0] == selected[0], 'ONLINE_RECHARGE_PENDING_WORKSPACE_ORIGIN_CHANGED')
    return bridge


def online_pending_workspace_argv(argv):
    """A distinct namespace; never forge the API READBACK execution capability."""
    import base64
    try:
        flags = {'--online-recharge-preflight': 'PREFLIGHT','--online-recharge-only': 'STAGE',
                 '--online-recharge-readback': 'READBACK',
}
        _declaration_require(type(argv) in (list, tuple) and len(argv) == 5
            and argv[0] in flags and argv[1] == '--expected-current' and argv[3] == '--declaration-producer'
            and type(argv[2]) is str and re.fullmatch('[a-f0-9]{40}', argv[2])
            and type(argv[4]) is str and len(argv[4]) < 1024)
        def need(c, _unused): _declaration_require(c)
        p = closed_recovery_json(SimpleNamespace(require=need), base64.b64decode(argv[4], validate=True))
        _declaration_exact(p, ('commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'))
        _declaration_require(all(type(p[n]) is str and re.fullmatch('[a-f0-9]{40}', p[n]) for n in ('commit', 'sourceTree'))
            and all(type(p[n]) is str and re.fullmatch('[1-9][0-9]*', p[n]) for n in ('workflowRunId', 'workflowRunAttempt')))
        return {'entry': flags[argv[0]], 'expectedCommit': argv[2], 'producer': p}
    except Exception:
        raise RuntimeError('ONLINE_RECHARGE_PENDING_WORKSPACE_INPUT_INVALID') from None


def _workspace_preflight_binding(d, raw, *, producer, bridge, kind):
    """Pure same-run F_O binding, not a trusted-file authority or live measurement."""
    if kind==ONLINE_AFTER_BIT_KIND and closed_recovery_json(d,raw).get('version')==3:
        return _restored_workspace_preflight_binding(d,raw,producer,bridge)
    try:
        _workspace_bridge_shape(d, bridge, kind)
        field, namespace = _WORKSPACE_ORIGIN_TYPES[kind]
        _declaration_require(type(raw) is bytes and 0 < len(raw) < 65536)
        value = closed_recovery_json(d, raw)
        _declaration_exact(value, ('kind', 'version', 'mode', 'status', 'commandId', 'releaseCandidateCommit',
            'workflowRunId', 'workflowRunAttempt', 'sourceTree', 'baseline', 'services',
            *(('ordinaryPreflight',) if value.get('version') == 2 else ())))
        _declaration_require(value['kind'] == namespace + '_PREFLIGHT' and type(value['version']) is int
            and value['version'] in (1,2) and value['mode'] == 'preflight'
            and value['status'] == namespace + '_BASELINE_VERIFIED'
            and type(value['commandId']) is str and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value['commandId'])
            and value['releaseCandidateCommit'] == producer['commit'] and value['sourceTree'] == producer['sourceTree']
            and value['workflowRunId'] == producer['workflowRunId'] and value['workflowRunAttempt'] == producer['workflowRunAttempt']
            and value['baseline'] == bridge and value['services'] == bridge['services'])
        if value['version'] == 2:
            receipt=value['ordinaryPreflight']
            _pending_workspace_pref_fields(d,receipt)
            _declaration_require(type(receipt) is dict and receipt.get(field)==bridge
                and receipt.get('services')==bridge['services'] and receipt.get('migrationPerformed') is False)
            _pending_workspace_validate_receipt(d,receipt,'preflight',producer['commit'],bridge['baselineCommit'])
        return {'kind': namespace + '_PREFLIGHT_SEAL', 'version': value['version'],
                'bytesSha256': hashlib.sha256(raw).hexdigest(), 'commandId': value['commandId'],
                'baselineSha256': fingerprint(bridge), 'producer': producer}
    except Exception:
        raise RuntimeError('ONLINE_RECHARGE_PENDING_WORKSPACE_PREFLIGHT_CHANGED') from None


def online_pending_workspace_preflight_binding(d, raw, *, producer, bridge):
    return _workspace_preflight_binding(d, raw, producer=producer, bridge=bridge, kind=ONLINE_PENDING_WORKSPACE_KIND)


def online_after_bit_preflight_binding(d, raw, *, producer, bridge):
    return _workspace_preflight_binding(d, raw, producer=producer, bridge=bridge, kind=ONLINE_AFTER_BIT_KIND)


def _workspace_preflight_bytes(d, *, producer, expected_sha256, kind):
    """Actual 0600 F_O installed by trusted ended-preflight transport only.

    The fixed private artifact installer/transport is not implemented here;
    absence or a wrong file fails closed, never a default provider.
    """
    try:
        _declaration_exact(producer, ('commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'))
        _declaration_require(all(type(producer[n]) is str and re.fullmatch('[a-f0-9]{40}', producer[n]) for n in ('commit', 'sourceTree'))
            and all(type(producer[n]) is str and re.fullmatch('[1-9][0-9]*', producer[n]) for n in ('workflowRunId', 'workflowRunAttempt'))
            and _declaration_hash(expected_sha256))
        folder=d.BASE/'.staging'/('online-recharge-pending-workspace-preflight-'+producer['commit']+'-'
                                 +producer['workflowRunId']+'-'+producer['workflowRunAttempt'])
        _declaration_require(folder.is_dir() and folder.resolve()==folder and not folder.is_symlink()
            and folder.stat().st_uid==os.geteuid() and stat.S_IMODE(folder.stat().st_mode)==0o700)
        path=folder/'online-recharge-pending-workspace-preflight-result.json'
        _declaration_require(stat.S_IMODE(path.lstat().st_mode)==0o600)
        raw=_declaration_source_bytes(path,limit=65535)
        _declaration_require(hashlib.sha256(raw).hexdigest()==expected_sha256)
        value=closed_recovery_json(d,raw)
        _workspace_preflight_binding(d,raw,producer=producer,bridge=value.get('baseline'),kind=kind)
        return raw
    except Exception:
        raise RuntimeError('ONLINE_RECHARGE_PENDING_WORKSPACE_PREFLIGHT_CHANGED') from None


def online_pending_workspace_preflight_bytes(d, *, producer, expected_sha256):
    return _workspace_preflight_bytes(d, producer=producer, expected_sha256=expected_sha256, kind=ONLINE_PENDING_WORKSPACE_KIND)


def online_after_bit_preflight_bytes(d, *, producer, expected_sha256):
    return _workspace_preflight_bytes(d, producer=producer, expected_sha256=expected_sha256, kind=ONLINE_AFTER_BIT_KIND)


def _workspace_owned_preflight(d, *, producer, expected_sha256, bridge):
    _workspace_origin_type(d, bridge)
    reader = online_after_bit_preflight_bytes if bridge['kind'] == ONLINE_AFTER_BIT_KIND else online_pending_workspace_preflight_bytes
    return reader(d, producer=producer, expected_sha256=expected_sha256)


def _workspace_build_shape(d, proof, *, producer, bridge, preflight_raw, kind):
    """An explicit different proof kind, not a normalized legacy v1 proof."""
    if kind==ONLINE_AFTER_BIT_KIND and type(proof) is dict and proof.get('version')==3:
        return _restored_workspace_build_shape(d,proof,producer,bridge,preflight_raw)
    try:
        _workspace_bridge_shape(d, bridge, kind)
        namespace = _WORKSPACE_ORIGIN_TYPES[kind][1]
        _declaration_exact(proof, ('kind','version','scope','commit','sourceTree','baselineCommit',
            'migration','images','engineSourceSha256','composeSourceSha256','baselineOriginSha256','preflightBytesSha256'))
        _declaration_require(proof['kind']==namespace + '_BUILD_PROOF'
            and type(proof['version']) is int and proof['version']==2 and proof['scope']==SCOPE
            and proof['commit']==producer['commit'] and proof['sourceTree']==producer['sourceTree']
            and proof['baselineCommit']==bridge['baselineCommit'] and proof['migration']==MIGRATION_IDENTITY
            and proof['baselineOriginSha256']==fingerprint(bridge)
            and proof['preflightBytesSha256']==hashlib.sha256(preflight_raw).hexdigest()
            and _declaration_hash(proof['engineSourceSha256']) and _declaration_hash(proof['composeSourceSha256'])
            and type(proof['images']) is dict and set(proof['images'])==set(IMAGE_SERVICES))
        for name,row in proof['images'].items():
            _declaration_exact(row, ('reference','imageId','fileCount','sha256'))
            _declaration_require(type(row['reference']) is str and re.fullmatch(
                '[0-9]{12}\\.dkr\\.ecr\\.ap-northeast-1\\.amazonaws\\.com/id-business-v2-release:'
                +producer['commit']+'-'+producer['workflowRunId']+'-'+producer['workflowRunAttempt']+'-'+name,row['reference'])
                and type(row['imageId']) is str and re.fullmatch('sha256:[a-f0-9]{64}',row['imageId'])
                and type(row['fileCount']) is int and 0<row['fileCount']<30000 and _declaration_hash(row['sha256']))
        return proof
    except Exception:
        raise RuntimeError('ONLINE_RECHARGE_PENDING_WORKSPACE_BUILD_PROOF_INVALID') from None


def online_pending_workspace_build_shape(d, proof, *, producer, bridge, preflight_raw):
    return _workspace_build_shape(d, proof, producer=producer, bridge=bridge, preflight_raw=preflight_raw,
        kind=ONLINE_PENDING_WORKSPACE_KIND)


def online_after_bit_build_shape(d, proof, *, producer, bridge, preflight_raw):
    return _workspace_build_shape(d, proof, producer=producer, bridge=bridge, preflight_raw=preflight_raw,
        kind=ONLINE_AFTER_BIT_KIND)


def _workspace_typed_build(d, proof, *, producer, bridge, preflight_raw):
    _workspace_origin_type(d, bridge)
    shape = online_after_bit_build_shape if bridge['kind'] == ONLINE_AFTER_BIT_KIND else online_pending_workspace_build_shape
    return shape(d, proof, producer=producer, bridge=bridge, preflight_raw=preflight_raw)

def _pending_workspace_preserved(d, previous, target, before, original, *, all_services=False, include_engine=False):
    env = verify_environment(d, previous, target, original)
    infrastructure = verify_compose(d, previous, target)
    caddy = verify_caddy_projection(d, previous, target)
    migration_source_check(d, previous, candidate=False)
    migration_source_check(d, target)
    workspace = json.loads((previous / legacy(d).STATE_FILE).read_text()).get('workspaceVolumeAfter')
    d.require(isinstance(workspace, dict), 'ONLINE_RECHARGE_WORKSPACE_ORIGIN_INVALID')
    workspace_guard(d, target if include_engine else previous, workspace)
    d.require(d.migration_plan(previous, target) == [], 'ONLINE_RECHARGE_MIGRATION_SCOPE_CHANGED')
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


def _online_after_bit_switch(d, previous, target, before, environment, evidence, proof, args, bridge, changed, timing):
    """Prepare outside the MySQL fence; mark API rollback only at actual stop dispatch."""
    phases = ('ADMIN_PRECHECKS', 'AUDIT_PREPARE', 'ADMIN_SWITCH', 'ADMIN_HEALTH', 'API_PRECHECKS',
        'SQLITE_PREPARE', 'API_IDLE', 'MYSQL_LOCK', 'API_STOP_GUARD', 'API_STOP_CHECK', 'API_STOP_DISPATCH',
        'API_STOP_CONFIRM', 'MYSQL_AFTER_STOP', 'API_STOP_PROOF', 'MYSQL_UNLOCK', 'API_SWITCH',
        'API_HEALTH', 'ENGINE_PRECHECKS', 'ENGINE_SWITCH', 'ENGINE_HEALTH', 'COMPLETE')
    started = phase_started = time.monotonic()
    phase, completed = phases[0], []
    audit, gate, entered, stop_attempted, stop_completed = None, None, False, False, False
    mysql_entered, mysql_closed = False, None
    source_api = {name: before['api'][name] for name in ('containerId', 'image', 'startedAtSha256')}

    def save():
        now = time.monotonic()
        pipe = getattr(audit, 'pipe', None)
        deadline = getattr(pipe, 'deadline', None)
        timing.clear()
        timing.update(phase=phase, phaseElapsedSeconds=round(max(0, now - phase_started), 3),
            elapsedSeconds=round(max(0, now - started), 3), completedPhases=list(completed),
            mysqlFenceEntered=mysql_entered, mysqlFenceClosed=mysql_closed is not None,
            mysqlLockElapsedSeconds=round(max(0, (mysql_closed if mysql_closed is not None else now) - (deadline - 210)), 3)
                if deadline is not None else 0.0,
            mysqlLockRemainingSeconds=round(max(0, deadline - (mysql_closed if mysql_closed is not None else now)), 3)
                if deadline is not None else 0.0,
            apiStopAttempted=stop_attempted, apiStopCompleted=stop_completed)

    def mark(value):
        nonlocal phase, phase_started
        d.require(value in phases, 'ONLINE_RECHARGE_AFTER_BIT_SWITCH_PHASE_INVALID')
        now = time.monotonic()
        completed.append({'phase': phase, 'elapsedSeconds': round(max(0, now - phase_started), 3)})
        phase, phase_started = value, now
        save()

    def prechecks():
        require_preserved(d, previous, target, before, environment)
        jobs_idle(d, previous, migrated=True)
        historical_guard(d, previous, evidence, target)
        require_fresh_resources(d, target)

    def fresh_jobs(reader, database_identity):
        # Reuse the original running-worker/lease predicates without repeating
        # cold source proofs or API database discovery inside SQLite's 150s fence.
        deadline = min(gate.deadline, time.monotonic() + 40)
        class Controller:
            def __getattr__(self, name):
                return getattr(d, name)

            def compose(self, directory, *command, **kwargs):
                remaining = min(5, deadline - time.monotonic())
                d.require(directory == previous and command[:7] == ('exec', '-e',
                    'MYSQL_DATABASE=' + database_identity['database'], '-T', 'mysql', 'sh', '-c')
                    and len(command) == 8 and not kwargs and remaining > 0,
                    'API_ADMIN_WORKSPACE_SQLITE_FENCE_TIMEOUT')
                value = d.compose(directory, *command, timeout=remaining)
                d.require(time.monotonic() < deadline, 'API_ADMIN_WORKSPACE_SQLITE_FENCE_TIMEOUT')
                return value

            def service_state(self, directory, service, **kwargs):
                d.require(directory == previous and service == 'mysql'
                    and kwargs == {'include_container_id': True, 'include_environment_hash': True},
                    'API_ADMIN_WORKSPACE_DATABASE_IDENTITY_CHANGED')
                _online_after_bit_mysql_check(d, directory, database_identity['mysql'], deadline)
                return dict(database_identity['mysql'])

            def registration_runtime_state(self, directory):
                d.require(directory == previous and time.monotonic() + 15 < deadline,
                    'API_ADMIN_WORKSPACE_SQLITE_FENCE_TIMEOUT')
                value = d.registration_runtime_state(directory)  # Original fixed 15s command.
                d.require(time.monotonic() < deadline, 'API_ADMIN_WORKSPACE_SQLITE_FENCE_TIMEOUT')
                return value
        reader.jobs_idle(Controller(), previous, database_identity=database_identity)
        d.require(time.monotonic() < gate.deadline, 'API_ADMIN_WORKSPACE_SQLITE_FENCE_TIMEOUT')

    class StopController:
        def __getattr__(self, name):
            return getattr(d, name)

        def run(self, *command, **kwargs):
            nonlocal stop_attempted
            if command[:2] == ('docker', 'stop'):
                # Only the original fixed helper's first actual stop may change rollback scope.
                d.require(command == ('docker', 'stop', '--time', '30', source_api['containerId'])
                    and set(kwargs) == {'timeout'} and type(kwargs['timeout']) in (int, float)
                    and 0 < kwargs['timeout'] <= 45 and phase == 'API_STOP_CHECK'
                    and entered and not stop_attempted and 'api' not in changed,
                    'ONLINE_RECHARGE_AFTER_BIT_STOP_DISPATCH_INVALID')
                stop_attempted = True
                changed.append('api')
                mark('API_STOP_DISPATCH')
                result = d.run(*command, **kwargs)
                mark('API_STOP_CONFIRM')
                return result
            return d.run(*command, **kwargs)

    try:
        prechecks()
        # Prepare the read-only audit and database identity before replacing admin.
        # Their locks still begin after admin is healthy, preserving both deadlines.
        mark('AUDIT_PREPARE')
        audit = _online_after_bit_unused_audit_barrier(d, previous, bridge, proof)
        d.require(type(audit.source_api_identity) is dict
            and all(audit.source_api_identity.get(name) == value for name, value in source_api.items()),
            'ONLINE_RECHARGE_AFTER_BIT_API_CHANGED')
        reader = legacy(d)
        database_identity = reader.workspace_database_identity(d, previous)
        mark('ADMIN_SWITCH')
        changed.append('admin')
        d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'admin', timeout=300)
        mark('ADMIN_HEALTH'); d.wait_healthy(target, 'admin')
        mark('API_PRECHECKS'); prechecks()
        mark('SQLITE_PREPARE')
        gate = reader.workspace_prepare(d, previous, target, proof, args, evidence, legacy=False)
        d.require(gate is not None and gate.d is d and type(gate.api_identity) is dict
            and all(gate.api_identity.get(name) == value for name, value in source_api.items()),
            'ONLINE_RECHARGE_WORKSPACE_DATABASE_INVALID')
        mark('API_IDLE'); fresh_jobs(reader, database_identity)
        # BEGIN IMMEDIATE, the maintenance marker and verified backup/restore now
        # protect SQLite. The first MySQL frame closes any mutation race before stop.
        mark('MYSQL_LOCK'); audit.__enter__(); entered = mysql_entered = True
        mark('API_STOP_GUARD'); audit.before_stop()
        gate.d = StopController()
        mark('API_STOP_CHECK')
        try:
            gate.stop_previous()
        finally:
            gate.d = d
        d.require(stop_attempted, 'ONLINE_RECHARGE_AFTER_BIT_STOP_DISPATCH_INVALID')
        stop_completed = True
        mark('MYSQL_AFTER_STOP'); audit.check()
        mark('API_STOP_PROOF'); protection = audit.confirm_stopped(gate)
        mark('MYSQL_UNLOCK'); audit.__exit__(None, None, None); entered = False; mysql_closed = time.monotonic()
        mark('API_SWITCH')
        d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'api', timeout=300)
        mark('API_HEALTH'); d.wait_healthy(target, 'api')
        mark('ENGINE_PRECHECKS'); prechecks()
        mark('ENGINE_SWITCH'); changed.append('online-recharge')
        d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'online-recharge', timeout=300)
        mark('ENGINE_HEALTH'); d.wait_healthy(target, 'online-recharge')
        mark('COMPLETE'); save()
        return gate, protection
    except Exception as error:
        save()
        if gate is not None:
            error.sqlite_gate = gate
        raise
    finally:
        if entered:
            audit.__exit__(None, None, None)


def _pending_workspace_release_locked(d, args):
    proof = validate_arguments(d, args)
    previous, old, before, evidence = baseline(d, args.expected_current)
    recovery = release_recovery(d, previous) if evidence.get('migrationRecovery') is not None else None
    d.require(recovery is not None and evidence['migrationRecovery'] == recovery['marker'] and recovery['state']['status']=='APPLIED',
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
    sqlite_gate = None
    audit_barrier = None
    after_bit_audit_protection = None
    after_bit_control_timing = {}
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
        # Already APPLIED recovery is mandatory; DDL is unreachable here.
        migration_attempted = False
        migration = {**migration_database_state(d, target), 'performed': migration_attempted}
        d.require(migration['status'] == 'APPLIED', 'ONLINE_RECHARGE_MIGRATION_NOT_APPLIED')
        verify_permission_seed(d, target)
        require_fresh_resources(d, target)
        step = 'grants'
        grants = d.sync_new_table_grants(target, [MIGRATION_FILE])
        d.require(grants.get('ok') is True and grants.get('newTableCount') == len(TABLES), 'ONLINE_RECHARGE_DATABASE_GRANTS_FAILED')
        require_preserved(d, previous, target, before, environment, all_services=True)
        historical_guard(d, previous, evidence, target)
        step = 'workspace-protection'
        bridge = _workspace_evidence_origin(d, evidence)
        if bridge['kind'] == ONLINE_AFTER_BIT_KIND:
            step = 'switch'
            sqlite_gate, after_bit_audit_protection = _online_after_bit_switch(d, previous, target, before,
                environment, evidence, proof, args, bridge, changed, after_bit_control_timing)
        else:
            audit_barrier = legacy(d).WorkspaceUnusedAuditBarrier(d, previous, online=True)
            audit_barrier.__enter__()
            sqlite_gate = legacy(d).workspace_prepare(d, previous, target, proof, args, evidence, legacy=False)
            d.require(sqlite_gate is not None, 'ONLINE_RECHARGE_WORKSPACE_DATABASE_INVALID')
            step = 'switch'
            for service in SWITCH_ORDER:
                require_preserved(d, previous, target, before, environment)
                jobs_idle(d, previous, migrated=True)
                historical_guard(d, previous, evidence, target)
                # The first executor publication accepts no imported cards/CDKs/tasks.
                require_fresh_resources(d, target)
                changed.append(service)
                if service == 'api':
                    audit_barrier.before_stop()
                    sqlite_gate.stop_previous()
                    audit_barrier.check()
                    audit_barrier.__exit__(None,None,None)
                    audit_barrier = None
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
                  'workspaceBackupSha256': fingerprint(sqlite_backup),
                  'sqliteProtectionSha256': fingerprint(sqlite_gate.record),
                  'workspaceVolumeBefore': evidence['workspaceVolume'],
                  'workspaceVolumeAfter': workspace_guard(d,target,evidence['workspaceVolume'])}
        if bridge['kind'] == ONLINE_AFTER_BIT_KIND:
            d.require(type(after_bit_audit_protection) is dict, 'ONLINE_RECHARGE_AFTER_BIT_AUDIT_RECEIPT_CHANGED')
            record['afterBitAuditProtection'] = after_bit_audit_protection
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
            'newMigrations': [], 'dataAuditBefore': first, 'dataAuditAfter': second,
            'databaseGrants': grants, 'rollback': {'release': str(previous),
                'images': {n: before[n]['image'] for n in ('api', 'admin')}, 'servicesAdded': ['online-recharge'],
                'inverseMigrationAllowed': False, 'mediaVolumePreserved': True, 'workspaceVolumePreserved': True},
            'onlineRechargePublication': {'version': 2,
                'baselineOriginSha256': fingerprint(_workspace_evidence_origin(d,evidence)),
                'sqliteProtectionSha256': fingerprint(sqlite_gate.record), 'scope': SCOPE, 'buildProofSha256': fingerprint(proof),
                'migration': dict(MIGRATION_IDENTITY), 'legacyWorkersPublished': False,
                'configurationScope': 'ONLINE_RECHARGE_VOLUME_LOOPBACK_ONLY'}}
        if bridge['kind'] == ONLINE_AFTER_BIT_KIND:
            manifest['onlineRechargePublication']['afterBitAuditProtectionSha256'] = fingerprint(after_bit_audit_protection)
        if evidence.get('migrationOrigin') is not None:
            manifest['preservedMigrationOrigin'] = legacy(d).migration_successor_marker(evidence['migrationOrigin'])
        if recovery is not None:
            manifest['migrationRecovery'] = recovery['marker']
        (target / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        d.require((d.BASE / 'current').resolve() == previous, 'ONLINE_RECHARGE_BASELINE_MOVED')
        d.point_current(target, f'{stamp}-publish')
        result = readback(d, args.commit)
        sqlite_gate.finish()
        print(json.dumps(result))
        return 0
    except Exception as error:
        if audit_barrier is not None:
            audit_barrier.__exit__(None,None,None)
            audit_barrier = None
        if sqlite_gate is None:
            sqlite_gate = getattr(error,'sqlite_gate',None)
        if sqlite_gate is not None:
            sqlite_gate.close()
        if migration_attempted:
            try:
                observed = migration_database_state(d, target)
                migration = {**observed, 'performed': observed['status'] == 'APPLIED'}
            except Exception:
                migration = {'status': 'UNVERIFIED', 'performed': None}
        okay, restored = rollback(d, previous, target, changed, before,
                                 migrated=migration.get('status') == 'APPLIED', workspace=evidence['workspaceVolume'])
        if okay and sqlite_gate is not None:
            try:
                sqlite_gate.abort()
            except Exception:
                okay = False
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
        if after_bit_control_timing:
            result['afterBitControlTiming'] = after_bit_control_timing
        try:
            (target / FAILURE_FILE).write_text(json.dumps(result, indent=2) + '\n')
        except Exception:
            result['receiptPersisted'] = False
        print(json.dumps(result))
        return 1
    finally:
        if audit_barrier is not None:
            audit_barrier.__exit__(None,None,None)
        if sqlite_gate is not None:
            sqlite_gate.close()

def _pending_workspace_readback(d, expected):
    directory = (d.BASE / 'current').resolve()
    d.require(directory.parent == d.BASE / 'releases' and not directory.is_symlink(),
              'ONLINE_RECHARGE_READBACK_PATH_INVALID')
    manifest_raw = (directory / 'release-manifest.json').read_bytes()
    manifest = json.loads(manifest_raw)
    proof = validate_proof(d, json.loads((directory / PROOF_FILE).read_text()), expected, manifest.get('sourceTree'))
    record = json.loads((directory / STATE_FILE).read_text())
    bridge = _workspace_evidence_origin(d,record.get('baselineEvidence'))
    origin_field = _workspace_origin_type(d,bridge)[0]
    previous = Path(manifest.get('previousRelease', ''))
    d.require(previous.parent == d.BASE / 'releases' and not previous.is_symlink()
              and manifest.get('commit') == expected and manifest.get('previousCommit') == bridge['baselineCommit']
              and manifest.get('servicesUpdated') == list(UPDATED)
              and manifest.get('newMigrations') == [] and manifest.get('migrationApplied') is True
              and manifest.get('onlineRechargePublication') == {
                  'version': 2, 'baselineOriginSha256': fingerprint(bridge),
                  'sqliteProtectionSha256': record.get('sqliteProtectionSha256'), 'scope': SCOPE, 'buildProofSha256': fingerprint(proof),
                  'migration': dict(MIGRATION_IDENTITY), 'legacyWorkersPublished': False,
                  'configurationScope': 'ONLINE_RECHARGE_VOLUME_LOOPBACK_ONLY',
                  **({'afterBitAuditProtectionSha256': fingerprint(record.get('afterBitAuditProtection'))}
                     if bridge['kind'] == ONLINE_AFTER_BIT_KIND else {})}
              and record.get('buildProofSha256') == fingerprint(proof)
              and hashlib.sha256((previous / 'release-manifest.json').read_bytes()).hexdigest()
                  == manifest.get('previousManifestSha256') == record['baselineEvidence']['manifestSha256'],
              'ONLINE_RECHARGE_READBACK_PROVENANCE_CHANGED')
    d.require(json.loads((previous / 'release-manifest.json').read_text()).get('commit') == bridge['baselineCommit']
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
    _pending_workspace_sqlite_receipt(d,directory,manifest,record)
    protection = (_online_after_bit_audit_receipt(d, directory, bridge, proof, manifest, record)
                  if bridge['kind'] == ONLINE_AFTER_BIT_KIND else {})
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
            'legacyWorkersPublished': False, 'externalAcceptancePerformed': False, origin_field: bridge, **recovered, **protection}

def _pending_workspace_validate_receipt(d, value, mode, commit, expected):
    """Bounded public summary; never return raw remote output or credentials."""
    d.require(mode in ('preflight', 'readback')
              and all(re.fullmatch(r'[a-f0-9]{40}', v or '') for v in (commit, expected))
              and isinstance(value, dict) and value.get('commit') == expected,
              'ONLINE_RECHARGE_RECEIPT_INVALID')
    status = SCOPE + ('_BASELINE_VERIFIED' if mode == 'preflight' else '_VERIFIED')
    d.require(value.get('status') == status and isinstance(value.get('services'), dict),
              'ONLINE_RECHARGE_RECEIPT_INVALID')
    bridge = _workspace_evidence_origin(d,value)
    origin_field = _workspace_origin_type(d,bridge)[0]
    services = value['services']
    restored=value.get(_RESTORED_B_FIELD)
    if _RESTORED_B_FIELD in value:
        d.require(bridge['kind']==ONLINE_AFTER_BIT_KIND,_RESTORED_B_CODE)
        if mode=='preflight':
            _restored_workspace_sidecar(d,bridge,restored,services)
        else:
            observed,unused=_restored_workspace_materials(d,bridge)
            _restored_workspace_sidecar(d,bridge,restored,observed['currentServices'])
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
        d.require(expected == bridge['baselineCommit'] and value.get('migration') == MIGRATION_IDENTITY
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
        resumed = {origin_field: bridge,**({_RESTORED_B_FIELD:restored} if restored is not None else {})}
        if value.get('migrationRecovery') is not None:
            d.require(value['migrationRecovery'] == recovery_marker(recovery_policy(d))
                      and value.get('migrationPerformed', False) is False
                      and value.get('migrationState', {}).get('status') == 'APPLIED'
                      and value['migrationState'].get('name') == MIGRATION_NAME
                      and value['migrationState'].get('sha256') == MIGRATION_IDENTITY['sha256']
                      and value['migrationState'].get('schemaVerified') is True,
                      'ONLINE_RECHARGE_RECEIPT_BASELINE_CHANGED')
            resumed = {**resumed, 'migrationRecovery': value['migrationRecovery'], 'migrationPerformed': False}
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
    resumed = {origin_field: bridge,**({_RESTORED_B_FIELD:restored} if restored is not None else {})}
    if bridge['kind'] == ONLINE_AFTER_BIT_KIND:
        d.require(_declaration_hash(value.get('afterBitAuditProtectionSha256'))
            and type(value.get('preservedRegistrationAuditCount')) is int
            and 0 <= value['preservedRegistrationAuditCount'] < 2**63
            and type(value.get('auditHistoryCutoff')) is str and re.fullmatch(
                r'20[0-9]{2}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}', value['auditHistoryCutoff']),
            'ONLINE_RECHARGE_AFTER_BIT_AUDIT_RECEIPT_CHANGED')
        resumed.update({n: value[n] for n in ('afterBitAuditProtectionSha256', 'preservedRegistrationAuditCount', 'auditHistoryCutoff')})
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



def _pending_workspace_sqlite_receipt(d,directory,manifest,record):
    """Map the actual ONLINE publication's SQLite digest to the shared validator."""
    publication=manifest.get('onlineRechargePublication')
    d.require(type(publication) is dict and publication.get('version')==2
        and publication.get('scope')==SCOPE and publication.get('sqliteProtectionSha256')==record.get('sqliteProtectionSha256')
        and _declaration_hash(record.get('sqliteProtectionSha256')),
        'ONLINE_RECHARGE_WORKSPACE_BACKUP_RECEIPT_CHANGED')
    proof=validate_proof(d,closed_recovery_json(d,_declaration_source_bytes(directory/PROOF_FILE)),manifest['commit'],manifest['sourceTree'])
    result=legacy(d).workspace_sqlite_receipt(d,directory,proof,record,{'apiWorkspacePublication':publication})
    d.require(type(result) is dict and result.get('backupVerified') is True and result.get('restoreVerified') is True,
              'ONLINE_RECHARGE_WORKSPACE_BACKUP_RECEIPT_CHANGED')
    return result

_PENDING_WORKSPACE_CONTROL_NAMES = (*DECLARATION_EQUIVALENCE_HELPERS,
    'scripts/production-release/online-recharge-declaration-measurement.py',
    'scripts/production-release/api-admin-pending-receipt-wire.py',
    'scripts/production-release/online-recharge-daemon-identity.py',
    'scripts/production-release/online-recharge-daemon-listener.py',
    'scripts/production-release/online-recharge-daemon-socket.py')
_PENDING_WORKSPACE_RECEIPT_COMPATIBILITY_FILES = frozenset((
    'scripts/production-release/online-recharge-scope.py',
    'scripts/production-release/online-recharge-scope.test.py',
    'scripts/production-release/online-recharge-readonly.py',
    'scripts/production-release/online-recharge-readonly.test.py'))
_AFTER_BIT_BANK_POLICY_FILES = {
    'scripts/lib/v2-production-database-access.mjs': (
        '7ece1de5cbba89b26615d749a671d32a380f4dc377548071746d14f1f2e2a546',
        '36bfe57d9fd802fc647d09dd8871f1af4cee6cd03a68bf05a2509dd0e554570d'),
    'scripts/production-database-access.test.mjs': (
        'eb2ea9b434ea744589ce2210fcbd501b54bedcda05e614521aab9b30be002590',
        'd914b4646ced503e432697b410b9dcbbf07d9087375ba0e6ea41df8b7a9c5000'),
    'scripts/acceptance-v2-production-database-access.mjs': (
        '15adadb670cdbd7645761b161f487b74550b271455289e60a97108e9e4ac46f1',
        'd39b620aa33ac21cecc0b9229dc0cc59967af1e890ea65c4e61d20fb1dbe269e'),
    'scripts/production-release/api-admin-scope.test.py': (
        '551b052262643dc8b9ccb9cd56a08bc0b566dab03e634643517fe3ce3c168b06',
        'bec32298136ff61d8e69820179b8c3f51f8e5221f4e6b449aaf5f5ec8f7d4625'),
    'scripts/production-release/online-recharge-scope.test.py': (
        '4aa063af4054ff98d2bb622056556ab643ed39abb3d373facc636509ff98ad8e',
        '4a8e005636e0b8a7ff858be24beb626e2c59900fc57d7560855866447288c026'),
}
_AFTER_BIT_RELEASE_CI_FILES = {
    'scripts/ci-recharge-scope.mjs': ('3fe9c33ea883b7e2ad15305d1c7fe26873ddf648645b7a05acc8aecd5f858cfd', 'c066be2f8811237e6fd82448d79c9fbd93aace6457033984c4fb1a2457eb892c'),
    'scripts/ci-recharge-scope.test.mjs': ('f7df520b417f7d681050073e5e8b9cd882effebd10a458a7afc620a39ab17550', 'dee5bb67add0563539d5ca181a8712cd30082637cb4a941a8d55c878da897302'),
    'scripts/ci-recharge-check.mjs': ('8863a78075b234faa0b048c56277bff81f7df88ad72d6261bc5493f08d525932', '96153e6f010d7a6c9b1028ea3d95d91ad1b321f5ab04768011fddb9819790ff7'),
    'scripts/ci-recharge-check.test.mjs': ('53e1376a2e36d3f492075547d4a0ceb8e65a915cec0c572ac6952356b045ea04', '0ff6dca9335d102fcdacfd7c0a9ad2ecafc245aa086d2cbda4655f58ff1b6767'),
}
_PENDING_WORKSPACE_FIRST = {n: globals()[n] for n in ('baseline','validate_arguments','validate_proof','build_proof',
    'readback','validate_receipt','release_recovery','workspace_origin','historical_guard',
    'candidate_recovery_source','migration_source_check','require_preserved','_release_locked','preflight')}


def _pending_workspace_producer(d, args=None):
    if args is None:
        value=getattr(d,'_onlinePendingWorkspaceProducer',None)
    else:
        value={'commit':args.commit,'sourceTree':args.source_tree,'workflowRunId':args.run_id,'workflowRunAttempt':args.run_attempt}
    _declaration_exact(value,('commit','sourceTree','workflowRunId','workflowRunAttempt'))
    _declaration_require(all(type(value[n]) is str and re.fullmatch('[a-f0-9]{40}',value[n]) for n in ('commit','sourceTree'))
        and all(type(value[n]) is str and re.fullmatch('[1-9][0-9]*',value[n]) for n in ('workflowRunId','workflowRunAttempt')))
    return value


def _pending_workspace_reader(d):
    reader=legacy(d)
    d.require(callable(getattr(reader,'online_pending_workspace_cold',None))
              and callable(getattr(reader,'online_pending_workspace_measure_before',None))
              and callable(getattr(reader,'online_pending_workspace_readback_origin',None)),
              'ONLINE_RECHARGE_DECLARATION_SOURCE_NOT_MEASURED')
    return reader


def _workspace_baseline_kind(d, reader, directory):
    """Select from actual private A/B state, never from an F/P claim or fallback."""
    raw = _declaration_source_bytes(directory / reader.STATE_FILE)
    record = closed_recovery_json(d, raw)
    context = reader.validate_pending_online_origin(record.get('pendingOnlineMigrationOrigin'))
    d.require(type(context['version']) is int and context['version'] == 2
        and type(context['priorPublications']) is list and len(context['priorPublications']) in (0, 1),
        'ONLINE_RECHARGE_PENDING_WORKSPACE_ORIGIN_CHANGED')
    return ONLINE_AFTER_BIT_KIND if context['priorPublications'] else ONLINE_PENDING_WORKSPACE_KIND


def _workspace_baseline_reader(d, reader, directory, *, live):
    kind = _workspace_baseline_kind(d, reader, directory)
    name = ('online_after_bit_' if kind == ONLINE_AFTER_BIT_KIND else 'online_pending_workspace_')
    name += 'measure_before' if live else 'cold'
    method = getattr(reader, name, None)
    d.require(callable(method), 'ONLINE_RECHARGE_DECLARATION_SOURCE_NOT_MEASURED')
    return kind, method


def _workspace_after_bit_materials(d, directory, *, bridge):
    """Reacquire B, Q_A/Q_B and its exact runtime projection; trust no material cache."""
    reader = _pending_workspace_reader(d)
    first = reader.online_after_bit_cold(d, directory, expected_commit=bridge['baselineCommit'])
    d.require(first == bridge and _workspace_baseline_kind(d, reader, directory) == ONLINE_AFTER_BIT_KIND,
        'ONLINE_RECHARGE_AFTER_BIT_ORIGIN_CHANGED')
    raw = _declaration_source_bytes(directory / reader.STATE_FILE)
    context = reader.validate_pending_online_origin(closed_recovery_json(d, raw).get('pendingOnlineMigrationOrigin'))
    unused, recovery = reader.pending_online_recovery(d, Path(context['baselineRelease']))
    material_reader, materials, publication, marker, record = reader.pending_online_declaration_b_files(
        d, directory, context, recovery, phase='COLD')
    d.require(type(materials) is dict and set(materials) == {'producer', 'archive_bytes', 'historical_files'}
        and {n: materials['producer'][n] for n in bridge['baselineProducer']} == bridge['baselineProducer']
        and fingerprint(publication) == bridge['publicationSha256']
        and fingerprint(context) == bridge['pendingOriginSha256']
        and hashlib.sha256(raw).hexdigest() == bridge['recordBytesSha256']
        and record == closed_recovery_json(d, raw), 'ONLINE_RECHARGE_AFTER_BIT_ORIGIN_CHANGED')
    inventory = material_reader.archive_inventory(d, materials['archive_bytes'],
        bridge['baselineProducer']['commit'], bridge['baselineProducer']['sourceTree'])
    d.require(fingerprint(inventory) == publication['producer']['archiveInventorySha256'],
        'ONLINE_RECHARGE_AFTER_BIT_ORIGIN_CHANGED')
    proof_raw = _declaration_source_bytes(directory / reader.PROOF_FILE)
    d.require(hashlib.sha256(proof_raw).hexdigest() == bridge['buildProofBytesSha256'],
        'ONLINE_RECHARGE_AFTER_BIT_ORIGIN_CHANGED')
    proof = closed_recovery_json(d, proof_raw)
    runtime = reader.online_pending_workspace_runtime_sources(d, directory, material_reader, materials, proof)
    d.require(reader.online_after_bit_cold(d, directory, expected_commit=bridge['baselineCommit']) == first
        and _declaration_source_bytes(directory / reader.STATE_FILE) == raw
        and _declaration_source_bytes(directory / reader.PROOF_FILE) == proof_raw
        and reader.online_pending_workspace_runtime_sources(d, directory, material_reader, materials, proof) == runtime,
        'ONLINE_RECHARGE_AFTER_BIT_ORIGIN_CHANGED')
    return materials


def _pending_workspace_current_source_inventory(d,producer):
    """Independent actual N immutable archive/tree, never a P/F source claim.

    Transport supplies producer metadata from its actual checkout/run. Cached
    immutable raw bytes still undergo the complete Git tree calculation.
    """
    _declaration_exact(producer,('commit','sourceTree','workflowRunId','workflowRunAttempt'))
    _declaration_require(all(type(producer[n]) is str and re.fullmatch('[a-f0-9]{40}',producer[n]) for n in ('commit','sourceTree'))
        and all(type(producer[n]) is str and re.fullmatch('[1-9][0-9]*',producer[n]) for n in ('workflowRunId','workflowRunAttempt')))
    key=(producer['commit'],producer['sourceTree'])
    cached=getattr(d,'_onlinePendingWorkspaceArchiveBytes',{})
    raw=cached.get(key)
    if raw is None:
        with urllib.request.urlopen('https://github.com/wangchaozhuanyong/id-business-system/archive/'+producer['commit']+'.tar.gz',timeout=60) as response:
            raw=response.read(128*1024*1024+1)
    result=archive_inventory(d,raw,*key)
    cached[key]=raw;d._onlinePendingWorkspaceArchiveBytes=cached
    return result



_BITBROWSER_SCOPE_POLICY_FILE = 'deploy/aws/bitbrowser-reviewed-release-20261012.json'
_BITBROWSER_SCOPE_POLICY_SHA256 = 'b2221e6c2cfe3eece93c1492c1ddd1df0e8aa8a572805ce1c841682478b12852'


def _workspace_reviewed_application_inventory(d,bridge,original,inventory,producer=None):
    """The complete reviewed #446 group, from the already tree-verified archive."""
    name=_BITBROWSER_SCOPE_POLICY_FILE
    if name not in original and name not in inventory:return frozenset()
    code='ONLINE_RECHARGE_PENDING_WORKSPACE_APPLICATION_SOURCE_CHANGED'
    d.require(name not in original and inventory.get(name)=={
        'sha256':_BITBROWSER_SCOPE_POLICY_SHA256,'mode':'100644'}
        and type(bridge) is dict and bridge.get('kind')==ONLINE_AFTER_BIT_KIND,code)
    _workspace_bridge_shape(d,bridge,ONLINE_AFTER_BIT_KIND)
    actual=_pending_workspace_producer(d)
    d.require(producer is None or producer==actual,code)
    raw=getattr(d,'_onlinePendingWorkspaceArchiveBytes',{}).get((actual['commit'],actual['sourceTree']))
    d.require(type(raw) is bytes,code)
    with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as archive:
        row=archive.getmember('id-business-system-'+actual['commit']+'/'+name)
        data=archive.extractfile(row).read(16668)
        d.require(row.isfile() and row.mode&0o111==0 and row.size==len(data)==16667
            and hashlib.sha256(data).hexdigest()==_BITBROWSER_SCOPE_POLICY_SHA256,code)
    policy=closed_recovery_json(d,data)
    d.require(type(policy) is dict and set(policy)=={'kind','version','baselineOriginSha256',
        'baselineProducer','reviewedProducer','files'}
        and policy['kind']=='ONLINE_RECHARGE_FIXED_BITBROWSER_SCOPE_MAPPING'
        and type(policy['version']) is int and policy['version']==1
        and policy['baselineOriginSha256']==fingerprint(bridge)
        and policy['baselineProducer']==bridge['baselineProducer']
        and policy['reviewedProducer']=={'commit':'b61ea7ea5a1903ecd6ebfe01cb7b7b0b770bc390',
            'sourceTree':'119c8e069e8c1d94f15462e54e2ab2b1f3c30ba0','pullRequest':446}
        and type(policy['files']) is dict and len(policy['files'])==40,code)
    files=policy['files']
    for side,values,p in (('before',original,bridge['baselineProducer']),('after',inventory,actual)):
        source=getattr(d,'_onlinePendingWorkspaceArchiveBytes',{}).get((p['commit'],p['sourceTree']))
        d.require(type(source) is bytes,code)
        with tarfile.open(fileobj=io.BytesIO(source),mode='r:gz') as archive:
            for n,pair in files.items():
                d.require(type(pair) is dict and set(pair)=={'before','after'}
                    and pair['before']!=pair['after'],code)
                expected=pair[side]
                if expected is None:
                    d.require(side=='before' and n not in values,code)
                    continue
                d.require(type(expected) is dict and set(expected)=={'sha256','mode','bytes'}
                    and _declaration_hash(expected['sha256']) and expected['mode']=='100644'
                    and type(expected['bytes']) is int and 0<expected['bytes']<512*1024
                    and values.get(n)=={k:expected[k] for k in ('sha256','mode')},code)
                row=archive.getmember('id-business-system-'+p['commit']+'/'+n)
                data=archive.extractfile(row).read(expected['bytes']+1)
                d.require(row.isfile() and row.mode&0o111==0 and row.size==len(data)==expected['bytes']
                    and hashlib.sha256(data).hexdigest()==expected['sha256'],code)
    return frozenset(files)|frozenset((name,))


def _workspace_release_ci_inventory(d, bridge, original, inventory):
    """Admit only the complete reviewed B receipt-checker source group."""
    names = frozenset(_AFTER_BIT_RELEASE_CI_FILES)
    changed = {name for name in names if original.get(name) != inventory.get(name)}
    if not changed:
        return frozenset()
    code = 'ONLINE_RECHARGE_PENDING_WORKSPACE_APPLICATION_SOURCE_CHANGED'
    d.require(type(bridge) is dict and bridge.get('kind') == ONLINE_AFTER_BIT_KIND, code)
    _workspace_bridge_shape(d, bridge, ONLINE_AFTER_BIT_KIND)
    capacity=_workspace_capacity_control_inventory(d,bridge,original,inventory)|_workspace_release_rules_inventory(d,bridge,original,inventory)|_workspace_reviewed_application_inventory(d,bridge,original,inventory)
    d.require((set(original)^set(inventory))<=capacity and changed == names
        and all(original.get(name) == {'sha256': before, 'mode': '100644'}
            and inventory.get(name) == {'sha256': after, 'mode': '100644'}
            for name, (before, after) in _AFTER_BIT_RELEASE_CI_FILES.items()), code)
    return names


def _workspace_bank_policy_inventory(d, bridge, original, inventory):
    """One reviewed five-file source mapping, admitted only by complete B type."""
    code='ONLINE_RECHARGE_PENDING_WORKSPACE_APPLICATION_SOURCE_CHANGED'
    d.require(type(bridge) is dict and bridge.get('kind')==ONLINE_AFTER_BIT_KIND,code)
    _workspace_bridge_shape(d,bridge,ONLINE_AFTER_BIT_KIND)
    extra=frozenset(_AFTER_BIT_BANK_POLICY_FILES)-_PENDING_WORKSPACE_RECEIPT_COMPATIBILITY_FILES
    ci = _workspace_release_ci_inventory(d, bridge, original, inventory)
    capacity=_workspace_capacity_control_inventory(d,bridge,original,inventory)|_workspace_release_rules_inventory(d,bridge,original,inventory)|_workspace_reviewed_application_inventory(d,bridge,original,inventory)
    d.require((set(original)^set(inventory))<=capacity
        and {n for n in inventory if original.get(n)!=inventory[n]
             and n not in _PENDING_WORKSPACE_RECEIPT_COMPATIBILITY_FILES and n not in ci and n not in capacity}==extra
        and all(original.get(n)=={'sha256':before,'mode':'100644'}
            and inventory.get(n)=={'sha256':after,'mode':'100644'}
            for n,(before,after) in _AFTER_BIT_BANK_POLICY_FILES.items()),code)
    return extra


def _pending_workspace_profile(d, bridge, producer):
    """Keep the actual predecessor; admit only the receipt-control repair.

    Both immutable archives still undergo complete Git tree verification. Only
    complete fixed reviewed mappings can differ; all other entries stay exact.
    """
    initial=bridge['baselineProducer']
    d.require(producer['workflowRunId']!=initial['workflowRunId'],
        'ONLINE_RECHARGE_PENDING_WORKSPACE_ORIGIN_CHANGED')
    inventory=_pending_workspace_current_source_inventory(d,producer)
    if producer['commit']!=initial['commit'] or producer['sourceTree']!=initial['sourceTree']:
        original=_pending_workspace_current_source_inventory(d,initial)
        compatible=_PENDING_WORKSPACE_RECEIPT_COMPATIBILITY_FILES
        capacity=_workspace_capacity_control_inventory(d,bridge,original,inventory)|_workspace_release_rules_inventory(d,bridge,original,inventory)|_workspace_reviewed_application_inventory(d,bridge,original,inventory)
        d.require((set(original)^set(inventory))<=capacity,
            'ONLINE_RECHARGE_PENDING_WORKSPACE_APPLICATION_SOURCE_CHANGED')
        _workspace_reviewed_application_inventory(d,bridge,original,inventory,producer)
        compatible = compatible | capacity | _workspace_release_ci_inventory(d, bridge, original, inventory)
        if any(original.get(name)!=inventory[name] for name in inventory if name not in compatible):
            compatible=compatible|_workspace_bank_policy_inventory(d,bridge,original,inventory)
        d.require((set(original)^set(inventory))<=capacity
            and _PENDING_WORKSPACE_RECEIPT_COMPATIBILITY_FILES.issubset(inventory)
            and all(original[name]==inventory[name] for name in inventory
                if name not in compatible)
            and all(original[name]['mode']==inventory[name]['mode']
                for name in _PENDING_WORKSPACE_RECEIPT_COMPATIBILITY_FILES),
            'ONLINE_RECHARGE_PENDING_WORKSPACE_APPLICATION_SOURCE_CHANGED')
    for name in _PENDING_WORKSPACE_CONTROL_NAMES:
        raw=_declaration_source_bytes(Path(__file__).with_name(Path(name).name),
            limit=2*1024*1024 if name.endswith('/remote-deploy.py') else 1024*1024)
        d.require(inventory.get(name,{}).get('sha256')==hashlib.sha256(raw).hexdigest(),
                  'ONLINE_RECHARGE_EXECUTOR_SOURCE_CHANGED')
    return inventory


def _workspace_reviewed_worker_protected(d, previous, target, worker):
    """Carry the complete reviewed N source; never replace the retained B worker."""
    saved=getattr(d,'_onlinePendingWorkspaceSession',None)
    if worker!='apps/api/src/id-business-v2/auto-recharge/worker' or type(saved) is not dict \
            or type(saved.get('bridge')) is not dict or saved['bridge'].get('kind')!=ONLINE_AFTER_BIT_KIND \
            or previous!=Path(saved['bridge'].get('baselineRelease','')):
        return False
    bridge,producer=_pending_workspace_session(d)
    inventory=_pending_workspace_current_source_inventory(d,producer)
    original=_pending_workspace_current_source_inventory(d,bridge['baselineProducer'])
    reviewed=_workspace_reviewed_application_inventory(d,bridge,original,inventory,producer)
    names=frozenset(n for n in reviewed if n.startswith(worker+'/'))
    if not names:return False
    code='ONLINE_RECHARGE_LEGACY_SOURCE_CHANGED'
    d.require(len(names)==25 and previous==Path(bridge['baselineRelease'])
        and previous.resolve()==previous and target.parent==d.BASE/'releases'
        and target.resolve()==target and target.is_dir() and not target.is_symlink()
        and re.fullmatch('[0-9]{8}T[0-9]{6}Z-'+producer['commit'][:12],target.name),code)
    materials=_workspace_after_bit_materials(d,previous,bridge=bridge)
    d.require(fingerprint(original)==materials['producer']['archiveInventorySha256'],code)
    current=(d.BASE/'current').resolve()
    if current==previous:
        d.require(not any((target/n).exists() or (target/n).is_symlink() for n in
            (STATE_FILE,PROOF_FILE,'release-manifest.json','.env.aws.production','compose.release.json')),code)
    else:
        d.require(current==target,code)
        manifest=closed_recovery_json(d,_declaration_source_bytes(target/'release-manifest.json'))
        for name in (STATE_FILE,PROOF_FILE):
            _declaration_source_bytes(target/name)
        d.require(all(manifest.get(n)==v for n,v in {'commit':producer['commit'],
            'sourceTree':producer['sourceTree'],'previousRelease':str(previous),
            'previousCommit':bridge['baselineCommit'],
            'previousManifestSha256':bridge['manifestBytesSha256']}.items()),code)
    for directory,source in ((previous,original),(target,inventory)):
        for name in reviewed-names:
            path=directory/name
            if name not in source:
                d.require(not path.exists() and not path.is_symlink(),code)
            else:
                raw=_declaration_source_bytes(path,limit=512*1024)
                d.require(source[name]=={'sha256':hashlib.sha256(raw).hexdigest(),'mode':'100644'},code)
        folder=directory/worker
        d.require(folder.is_dir() and folder.resolve()==folder and not folder.is_symlink(),code)
        paths=list(folder.rglob('*'));actual={}
        for path in paths:
            d.require(not path.is_symlink(),code)
            if path.is_dir():continue
            raw=_declaration_source_bytes(path,limit=512*1024)
            actual[path.relative_to(directory).as_posix()]={'sha256':hashlib.sha256(raw).hexdigest(),
                'mode':'100755' if path.stat().st_mode&0o111 else '100644'}
        d.require(actual=={n:v for n,v in source.items() if n.startswith(worker+'/')}
            and set(folder.rglob('*'))==set(paths),code)
    d.require((d.BASE/'current').resolve()==current,code)
    return True


def _workspace_bank_policy_protected(d, previous, target):
    """Recheck actual B and both source groups before the single library change."""
    saved=getattr(d,'_onlinePendingWorkspaceSession',None)
    if type(saved) is not dict or type(saved.get('bridge')) is not dict \
            or saved['bridge'].get('kind')!=ONLINE_AFTER_BIT_KIND:
        return False
    bridge,producer=_pending_workspace_session(d)
    d.require(previous==Path(bridge['baselineRelease']), 'ONLINE_RECHARGE_AFTER_BIT_ORIGIN_CHANGED')
    materials=_workspace_after_bit_materials(d,previous,bridge=bridge)
    inventory=_pending_workspace_profile(d,bridge,producer)
    original=_pending_workspace_current_source_inventory(d,bridge['baselineProducer'])
    d.require(fingerprint(original)==materials['producer']['archiveInventorySha256'],
        'ONLINE_RECHARGE_AFTER_BIT_ORIGIN_CHANGED')
    _workspace_bank_policy_inventory(d,bridge,original,inventory)
    raw={}
    for directory,index in ((previous,0),(target,1)):
        for name,pair in _AFTER_BIT_BANK_POLICY_FILES.items():
            path=directory/name;data=_declaration_source_bytes(path,limit=1024*1024)
            d.require(hashlib.sha256(data).hexdigest()==pair[index]
                and not path.stat().st_mode&0o111, 'ONLINE_RECHARGE_SHARED_GATE_SOURCE_CHANGED')
            raw[directory,name]=data
    anchor=b'export const V2_RUNTIME_DELETE_TABLES = Object.freeze([\n'
    before,after=raw[previous,GRANT_SOURCE],raw[target,GRANT_SOURCE]
    d.require(before.count(anchor)==1 and after==before.replace(anchor,
        anchor+b"  'id_business_v2_bank_recharge_cards',\n",1), 'ONLINE_RECHARGE_SHARED_GATE_SOURCE_CHANGED')
    return True


def _pending_workspace_session(d, *, expected=None, producer=None):
    saved=getattr(d,'_onlinePendingWorkspaceSession',None)
    if type(saved) is dict and 'restoration' in saved:
        return _restored_workspace_session(d,saved,expected,_pending_workspace_producer(d) if producer is None else producer)
    d.require(type(saved) is dict and set(saved)=={'bridge','producer'},'ONLINE_RECHARGE_PENDING_WORKSPACE_ORIGIN_CHANGED')
    producer=_pending_workspace_producer(d) if producer is None else producer
    reader=_pending_workspace_reader(d)
    directory=Path(saved['bridge']['baselineRelease'])
    kind, cold = _workspace_baseline_reader(d, reader, directory, live=False)
    bridge=cold(d,directory,expected_commit=saved['bridge']['baselineCommit'])
    _workspace_bridge_shape(d, bridge, kind)
    d.require(bridge==saved['bridge'] and producer==saved['producer']
        and (expected is None or expected==bridge['baselineCommit']), 'ONLINE_RECHARGE_PENDING_WORKSPACE_ORIGIN_CHANGED')
    _pending_workspace_profile(d,bridge,producer)
    return bridge,producer


def _pending_workspace_begin(d, expected, producer, *, live):
    d.require(hasattr(d,'BASE') and type(expected) is str and re.fullmatch('[a-f0-9]{40}',expected),
              'ONLINE_RECHARGE_PENDING_WORKSPACE_INPUT_INVALID')
    if live and _restored_workspace_selected(d,expected):
        return _restored_workspace_begin(d,expected,producer)
    previous=(d.BASE/'current').resolve()
    reader=_pending_workspace_reader(d)
    kind, measure = _workspace_baseline_reader(d, reader, previous, live=live)
    bridge=measure(d,previous,expected_commit=expected)
    _workspace_bridge_shape(d,bridge,kind)
    d.require(bridge['baselineCommit']==expected, 'ONLINE_RECHARGE_PENDING_WORKSPACE_ORIGIN_CHANGED')
    _pending_workspace_profile(d,bridge,producer)
    d._onlinePendingWorkspaceProducer=producer
    d._onlinePendingWorkspaceSession={'bridge':bridge,'producer':producer}
    return previous,bridge


def baseline(d, expected):
    if expected==BASELINE_COMMIT:
        return _PENDING_WORKSPACE_FIRST['baseline'](d,expected)
    d.require(type(getattr(d,'_onlinePendingWorkspaceProducer',None)) is dict, 'ONLINE_RECHARGE_BASELINE_NOT_APPROVED')
    if _restored_workspace_selected(d,expected):
        return _restored_workspace_baseline(d,expected)
    previous,bridge=_pending_workspace_begin(d,expected,_pending_workspace_producer(d),live=True)
    reader=legacy(d)
    manifest=closed_recovery_json(d,_declaration_source_bytes(previous/'release-manifest.json'))
    record=closed_recovery_json(d,_declaration_source_bytes(previous/reader.STATE_FILE))
    proof=reader.validate_proof(d,closed_recovery_json(d,_declaration_source_bytes(previous/reader.PROOF_FILE)),
                               expected,bridge['baselineProducer']['sourceTree'])
    # Complete live checks omitted from no cold proof: run existing image/content,
    # attached volume, workspace health, backup and current job guards unchanged.
    reader.verify_running(d,previous,proof)
    volume=workspace_guard(d,previous,record.get('workspaceVolumeAfter'))
    reader.workspace_health(d,previous)
    protection=reader.workspace_sqlite_receipt(d,previous,proof,record,manifest)
    if protection is None:
        reader.workspace_backup_receipt(d,previous,record)
    guards=jobs_idle(d,previous,migrated=True)
    recovery=release_recovery(d,previous)
    verify_permission_seed(d,recovery['source']);require_fresh_resources(d,recovery['source'])
    evidence={**({ 'migrationOrigin':record['baselineEvidence']['migrationOrigin']} if record['baselineEvidence'].get('migrationOrigin') is not None else {}),
        'manifestSha256':bridge['manifestBytesSha256'],
        'environmentSha256':bridge['environmentFileSha256'],
        'apiSource':{'imageId':bridge['services']['api']['image'],'revision':expected,'kind':'API_WORKSPACE_BUILD_PROVEN'},
        'guards':guards,'workspaceIdle':True,'workspaceVolume':volume,'workspaceOriginFiles':workspace_files(d,previous),
        'workspaceBuildProofSha256':bridge['buildProofCanonicalSha256'],'migrationRecovery':bridge['migrationRecovery'],
        _workspace_origin_type(d,bridge)[0]:bridge,'freeBytes':shutil.disk_usage(d.BASE).free}
    workspace_origin(d,previous,previous,evidence,bridge['services'])
    d.require(evidence['freeBytes']>6*1024**3 and snapshot(d,previous)==bridge['services']
        and (d.BASE/'current').resolve()==previous,'ONLINE_RECHARGE_BASELINE_MOVED')
    return previous,manifest,bridge['services'],evidence


def release_recovery(d, previous):
    if re.fullmatch('[0-9]{8}T[0-9]{6}Z-' + BASELINE_COMMIT[:12], previous.name):
        return _PENDING_WORKSPACE_FIRST['release_recovery'](d,previous)
    if not hasattr(d,'_onlinePendingWorkspaceSession'):
        return _PENDING_WORKSPACE_FIRST['release_recovery'](d,previous)
    bridge,_producer=_pending_workspace_session(d,expected=None)
    d.require(str(previous)==bridge['baselineRelease'],'ONLINE_RECHARGE_PENDING_WORKSPACE_ORIGIN_CHANGED')
    recovery=_PENDING_WORKSPACE_FIRST['release_recovery'](d,Path(bridge['originalWorkspace']['release']))
    d.require(recovery is not None and recovery['marker']==bridge['migrationRecovery']
        and recovery['state']==bridge['migrationState'],'ONLINE_RECHARGE_PENDING_WORKSPACE_ORIGIN_CHANGED')
    return recovery


def workspace_origin(d, previous, directory, evidence, before):
    if not any(n in evidence for n, unused in _WORKSPACE_ORIGIN_TYPES.values()):
        return _PENDING_WORKSPACE_FIRST['workspace_origin'](d,previous,directory,evidence,before)
    bridge,_producer=_pending_workspace_session(d)
    saved=d._onlinePendingWorkspaceSession
    expected_before=saved['beforeServices'] if 'restoration' in saved else bridge['services']
    d.require((evidence.get(_RESTORED_B_FIELD)==saved['restoration'] if 'restoration' in saved else _RESTORED_B_FIELD not in evidence),_RESTORED_B_CODE)
    d.require(_workspace_evidence_origin(d,evidence)==bridge and str(previous)==bridge['baselineRelease']
        and before==expected_before and workspace_files(d,previous)==evidence['workspaceOriginFiles']
        and evidence['workspaceBuildProofSha256']==bridge['buildProofCanonicalSha256'],
        'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED')
    # Cold actual initial Q evidence establishes retired owner provenance. The current
    # attached volume and current API health still get their original live guards.
    workspace_guard(d,directory,evidence['workspaceVolume']);legacy(d).workspace_health(d,directory)


def historical_guard(d, previous, evidence, source):
    if not any(n in evidence for n, unused in _WORKSPACE_ORIGIN_TYPES.values()):
        return _PENDING_WORKSPACE_FIRST['historical_guard'](d,previous,evidence,source)
    bridge,_producer=_pending_workspace_session(d)
    d.require(_workspace_evidence_origin(d,evidence)==bridge,'ONLINE_RECHARGE_PENDING_WORKSPACE_ORIGIN_CHANGED')
    return _PENDING_WORKSPACE_FIRST['historical_guard'](d,Path(bridge['originalWorkspace']['release']),evidence,source)


def migration_source_check(d,directory,*,candidate=True):
    saved=getattr(d,'_onlinePendingWorkspaceSession',None)
    if type(saved) is dict and str(directory)==saved['bridge']['baselineRelease']:
        reader=legacy(d)
        d.require(reader.pending_online_migrations(d,directory)==MIGRATION_FILE,
                  'ONLINE_RECHARGE_MIGRATION_SCOPE_CHANGED')
        return None
    return _PENDING_WORKSPACE_FIRST['migration_source_check'](d,directory,candidate=candidate)


def candidate_recovery_source(d, directory, context):
    if not hasattr(d,'_onlinePendingWorkspaceSession') or any(directory.name.endswith('-'+c[:12])
            for c in (RECOVERY_COMMIT,RESTORED_COMMIT)):
        return _PENDING_WORKSPACE_FIRST['candidate_recovery_source'](d,directory,context)
    bridge,producer=_pending_workspace_session(d)
    if bridge['kind'] == ONLINE_AFTER_BIT_KIND:
        _workspace_after_bit_materials(d, Path(bridge['baselineRelease']), bridge=bridge)
    expected=_pending_workspace_profile(d,bridge,producer)
    actual=release_source_inventory(d,directory,published=True)
    # Only the own, independently verified SQLite receipt may account for two
    # extra stage files; no directory-wide generated-file exemption exists.
    extra={legacy(d).WORKSPACE_SQLITE_RECEIPT,'backups/auto-registration/database.db'}
    observed=set(actual)-set(expected)
    if observed:
        d.require(observed==extra,'ONLINE_RECHARGE_BUILD_SOURCE_CHANGED')
        manifest=closed_recovery_json(d,_declaration_source_bytes(directory/'release-manifest.json'))
        record=closed_recovery_json(d,_declaration_source_bytes(directory/STATE_FILE))
        _pending_workspace_sqlite_receipt(d,directory,manifest,record)
    d.require({n:v for n,v in actual.items() if n not in observed}==expected,
              'ONLINE_RECHARGE_BUILD_SOURCE_CHANGED')
    fixed=fixed_recovery_inventory(d)
    roots=(ENGINE_ROOT+'/', 'apps/admin/src/v2/features/online-recharge/', 'apps/api/src/id-business-v2/online-recharge/')
    d.require({n:v for n,v in actual.items() if n.startswith(roots)}
        =={n:v for n,v in fixed.items() if n.startswith(roots)},'ONLINE_RECHARGE_BUILD_SOURCE_CHANGED')
    migration_source_check(d,directory)


def require_preserved(d, previous, target, before, original, *, all_services=False, include_engine=False):
    if not hasattr(d,'_onlinePendingWorkspaceSession'):
        return _PENDING_WORKSPACE_FIRST['require_preserved'](d,previous,target,before,original,
            all_services=all_services,include_engine=include_engine)
    _pending_workspace_session(d)
    return _pending_workspace_preserved(d,previous,target,before,original,all_services=all_services,include_engine=include_engine)


def validate_arguments(d, args):
    if args.expected_current==BASELINE_COMMIT:
        return _PENDING_WORKSPACE_FIRST['validate_arguments'](d,args)
    d.require(getattr(args,'online_recharge_only',False) is True and not any(value for key,value in vars(args).items()
        if key.startswith(('historical_','registration_worker_','recharge_pro_')) or key in
        ('admin_only','api_admin_only','api_registration_only','api_admin_migration_only','api_workspace_only',
         'image_commit','image_run_id','image_run_attempt','post_cleanup_seal_sha256',
         'order_archive_seal_sha256','order_archive_prepared_images_sha256')), 'ONLINE_RECHARGE_SCOPE_CONFLICT')
    producer=_pending_workspace_producer(d,args)
    restored=_restored_workspace_selected(d,args.expected_current)
    _previous,bridge=_pending_workspace_begin(d,args.expected_current,producer,live=not restored)
    encoded=getattr(args,'online_recharge_build_proof','')
    d.require(type(encoded) is str and len(encoded)<32768,'ONLINE_RECHARGE_BUILD_PROOF_TOO_LARGE')
    raw=base64.b64decode(encoded,validate=True)
    d.require(len(raw)<24000,'ONLINE_RECHARGE_BUILD_PROOF_TOO_LARGE')
    proof=closed_recovery_json(d,raw)
    before=_workspace_owned_preflight(d,producer=producer,expected_sha256=proof.get('preflightBytesSha256'),bridge=bridge)
    _pending_workspace_complete_preflight(d,before,producer=producer,bridge=bridge)
    d.require(re.fullmatch('[0-9]{12}\\.dkr\\.ecr\\.ap-northeast-1\\.amazonaws\\.com/id-business-v2-release',args.repository or '')
        and type(args.ci_run_id) is str and re.fullmatch('[1-9][0-9]*',args.ci_run_id),'ONLINE_RECHARGE_INPUT_INVALID')
    return validate_proof(d,proof,args.commit,args.source_tree,args.repository,args.run_id,args.run_attempt)


def validate_proof(d, value, commit, tree, repository=None, run_id=None, attempt=None):
    if type(value) is not dict or 'kind' not in value:
        return _PENDING_WORKSPACE_FIRST['validate_proof'](d,value,commit,tree,repository,run_id,attempt)
    bridge,producer=_pending_workspace_session(d)
    d.require(value.get('kind')==_workspace_origin_type(d,bridge)[1]+'_BUILD_PROOF','ONLINE_RECHARGE_BUILD_PROOF_INVALID')
    d.require(commit==producer['commit'] and tree==producer['sourceTree']
        and (run_id is None or run_id==producer['workflowRunId'])
        and (attempt is None or attempt==producer['workflowRunAttempt']),'ONLINE_RECHARGE_BUILD_RUN_CHANGED')
    raw=_workspace_owned_preflight(d,producer=producer,expected_sha256=value.get('preflightBytesSha256'),bridge=bridge)
    _pending_workspace_complete_preflight(d,raw,producer=producer,bridge=bridge)
    if repository is not None:
        d.require(all(row['reference']==repository+':'+commit+'-'+str(run_id)+'-'+str(attempt)+'-'+name
            for name,row in value.get('images',{}).items()),'ONLINE_RECHARGE_BUILD_RUN_CHANGED')
    return _workspace_typed_build(d,value,producer=producer,bridge=bridge,preflight_raw=raw)


def build_proof(d):
    expected=os.environ.get('EXPECTED_CURRENT',BASELINE_COMMIT)
    if expected==BASELINE_COMMIT:
        return _PENDING_WORKSPACE_FIRST['build_proof'](d)
    # CI build has no server file authority: use only the original F_O from
    # the fixed ended transport. The same-candidate source binding remains mandatory.
    before_path=Path('.deploy/production-release/online-recharge-pending-workspace-preflight-result.json').absolute()
    raw=_declaration_source_bytes(before_path,limit=65535)
    before=closed_recovery_json(d,raw);bridge=before.get('baseline');_workspace_origin_type(d,bridge)
    producer={n:os.environ.get(e,'') for n,e in (('commit','RELEASE_COMMIT'),('sourceTree','SOURCE_TREE'),
        ('workflowRunId','GITHUB_RUN_ID'),('workflowRunAttempt','GITHUB_RUN_ATTEMPT'))}
    _pending_workspace_complete_preflight(d,raw,producer=producer,bridge=bridge)
    _pending_workspace_profile(d,bridge,producer)
    d.require(d.run('git','rev-parse','HEAD')==producer['commit'] and d.run('git','rev-parse','HEAD^{tree}')==producer['sourceTree']
        and d.run('git','status','--porcelain','--untracked-files=all')=='','ONLINE_RECHARGE_BUILD_WORKTREE_DIRTY')
    directory=Path.cwd();migration_source_check(d,directory)
    proof={'kind':_workspace_origin_type(d,bridge)[1]+'_BUILD_PROOF','version':2,'scope':SCOPE,
        'commit':producer['commit'],'sourceTree':producer['sourceTree'],'baselineCommit':expected,
        'migration':dict(MIGRATION_IDENTITY),'images':{},'engineSourceSha256':fingerprint(file_inventory(d,directory/ENGINE_ROOT)),
        'composeSourceSha256':file_digest(directory/'docker-compose.aws-mysql.yml'),
        'baselineOriginSha256':fingerprint(bridge),'preflightBytesSha256':hashlib.sha256(raw).hexdigest()}
    if before.get('version')==3:
        proof.update(version=3,restorationSha256=fingerprint(before['restoration']),beforeServicesSha256=fingerprint(before['services']))
    for service in IMAGE_SERVICES:
        reference=os.environ['RELEASE_REPOSITORY']+':'+producer['commit']+'-'+producer['workflowRunId']+'-'+producer['workflowRunAttempt']+'-'+service
        metadata=json.loads(d.run('docker','image','inspect',reference))[0]
        proof['images'][service]={'reference':reference,'imageId':metadata['Id'],**content_summary(d,service,d.run('docker','run','--rm',
            '--network','none','--read-only','--entrypoint','/bin/sh',reference,'-c',content_command(service)))}
    _workspace_typed_build(d,proof,producer=producer,bridge=bridge,preflight_raw=raw)
    for service in IMAGE_SERVICES:
        verify_image_content(d,directory,proof,service)
    target=directory/'.deploy/production-release'/PROOF_FILE
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(proof,sort_keys=True,indent=2)+'\n')
    print(json.dumps({'status':SCOPE+'_BUILD_PROVEN','proofSha256':fingerprint(proof)}))
    return proof


def _release_locked(d,args):
    if args.expected_current==BASELINE_COMMIT:
        return _PENDING_WORKSPACE_FIRST['_release_locked'](d,args)
    return _pending_workspace_release_locked(d,args)


def _pending_workspace_compatibility_readback_origin(d,directory,*,expected_commit,producer):
    """Retain every actual origin check when only receipt controls changed.

    The API reader's same-tree entry remains unchanged. This entry binds its
    original cold Workspace Q to the new actual ONLINE F/proof and validates
    complete old/new archives instead of claiming they have the same Git tree.
    """
    code='ONLINE_RECHARGE_AFTER_BIT_READBACK_CHANGED'
    try:
        reader=_pending_workspace_reader(d)
        d.require(reader.WORKSPACE and directory.parent==d.BASE/'releases' and directory.resolve()==directory
            and directory.is_dir() and not directory.is_symlink()
            and directory.stat().st_uid==os.geteuid() and stat.S_IMODE(directory.stat().st_mode)&0o077==0
            and (d.BASE/'current').resolve()==directory and expected_commit==producer['commit'],code)
        files=(STATE_FILE,PROOF_FILE,'release-manifest.json')
        raw={name:_declaration_source_bytes(directory/name) for name in files}
        record,proof,manifest=(closed_recovery_json(d,raw[name]) for name in files)
        previous=Path(manifest.get('previousRelease',''))
        bridge=reader.online_pending_workspace_cold(d,previous,expected_commit=manifest.get('previousCommit'))
        online_pending_workspace_bridge_shape(d,bridge)
        _pending_workspace_profile(d,bridge,producer)
        before_raw=online_pending_workspace_preflight_bytes(d,producer=producer,
            expected_sha256=proof.get('preflightBytesSha256'))
        online_pending_workspace_preflight_binding(d,before_raw,producer=producer,bridge=bridge)
        online_pending_workspace_build_shape(d,proof,producer=producer,bridge=bridge,preflight_raw=before_raw)
        states=snapshot(d,directory,include_engine=True)
        d.require(record.get('baselineEvidence',{}).get('onlinePendingWorkspaceOrigin')==bridge
            and record.get('before')==bridge['services']
            and record.get('buildProofSha256')==fingerprint(proof)
            and record.get('configurationBefore')==bridge['configurationAfter']
            and record.get('configurationAfter')==configuration_hashes(directory)
            and manifest.get('commit')==expected_commit and manifest.get('sourceTree')==producer['sourceTree']
            and manifest.get('previousManifestSha256')==bridge['manifestBytesSha256']
            and manifest.get('migrationPerformed') is False and record.get('migration',{}).get('performed') is False
            and record.get('migration')=={**bridge['migrationState'],'performed':False}
            and set(states)==set((*PRESERVED,*UPDATED)) and record.get('after')==states
            and all(states[name]==bridge['services'][name] for name in PRESERVED)
            and all(states[name]['image']==proof['images'][name]['imageId']
                and states[name]['reference']==proof['images'][name]['reference'] for name in UPDATED),code)
        d.require({name:_declaration_source_bytes(directory/name) for name in files}==raw
            and (d.BASE/'current').resolve()==directory
            and snapshot(d,directory,include_engine=True)==states,code)
        return bridge
    except Exception:
        raise RuntimeError(code) from None


def readback(d,expected):
    if not hasattr(d,'_onlinePendingWorkspaceProducer'):
        return _PENDING_WORKSPACE_FIRST['readback'](d,expected)
    directory=(d.BASE/'current').resolve()
    record=closed_recovery_json(d,_declaration_source_bytes(directory/STATE_FILE))
    evidence=record.get('baselineEvidence',{})
    if not any(n in evidence for n, unused in _WORKSPACE_ORIGIN_TYPES.values()):
        return _PENDING_WORKSPACE_FIRST['readback'](d,expected)
    producer=_pending_workspace_producer(d)
    recorded = _workspace_evidence_origin(d,evidence)
    initial=recorded['baselineProducer']
    if _RESTORED_B_FIELD in evidence:
        bridge=_restored_workspace_readback_origin(d,directory,expected,producer,recorded)
    elif recorded['kind'] == ONLINE_AFTER_BIT_KIND:
        reader = _pending_workspace_reader(d)
        d.require(callable(getattr(reader,'online_after_bit_readback_origin',None)),
            'ONLINE_RECHARGE_DECLARATION_SOURCE_NOT_MEASURED')
        _pending_workspace_profile(d,recorded,producer)
        bridge=reader.online_after_bit_readback_origin(d,directory,expected_commit=expected,producer=producer)
        online_after_bit_bridge_shape(d,bridge)
        d.require(bridge == recorded,'ONLINE_RECHARGE_AFTER_BIT_READBACK_CHANGED')
    elif all(producer[n]==initial[n] for n in ('commit','sourceTree')):
        bridge=_pending_workspace_reader(d).online_pending_workspace_readback_origin(d,directory,expected_commit=expected,producer=producer)
    else:
        bridge=_pending_workspace_compatibility_readback_origin(d,directory,expected_commit=expected,producer=producer)
    _pending_workspace_profile(d,bridge,producer)
    if _RESTORED_B_FIELD not in evidence:
        d._onlinePendingWorkspaceSession={'bridge':bridge,'producer':producer}
    return _restored_wire_encode(_pending_workspace_readback(d,expected))


def validate_receipt(d,value,mode,commit,expected):
    if type(value) is not dict or not any(n in value for n, unused in _WORKSPACE_ORIGIN_TYPES.values()):
        return _PENDING_WORKSPACE_FIRST['validate_receipt'](d,value,mode,commit,expected)
    bridge=_workspace_evidence_origin(d,value)
    d.require(mode in ('preflight','readback') and value.get('migrationPerformed') is False
        and (mode!='preflight' or expected==bridge['baselineCommit']),'ONLINE_RECHARGE_RECEIPT_INVALID')
    return _pending_workspace_validate_receipt(d,value,mode,commit,expected)


def preflight(d,expected):
    if expected==BASELINE_COMMIT:
        return _PENDING_WORKSPACE_FIRST['preflight'](d,expected)
    result=_PENDING_WORKSPACE_FIRST['preflight'](d,expected)
    # This calls the complete original preflight body, with its independently
    # checked actual initial WORKSPACE baseline, source48, APPLIED database, strict49 audit and
    # final full7/current comparison. It is not a shape-only F construction.
    bridge,producer=_pending_workspace_session(d,expected=expected)
    result={**result,_workspace_origin_type(d,bridge)[0]:bridge,'migrationPerformed':False}
    _pending_workspace_pref_fields(d,result)
    _pending_workspace_validate_receipt(d,result,'preflight',producer['commit'],expected)
    return _restored_wire_encode(result)


def _pending_workspace_complete_preflight(d,raw,*,producer,bridge):
    value=closed_recovery_json(d,raw)
    if value.get('version')==3:
        return _restored_workspace_preflight_binding(d,raw,producer,bridge)
    d.require(value.get('version')==2 and type(value.get('version')) is int,
              'ONLINE_RECHARGE_PENDING_WORKSPACE_PREFLIGHT_CHANGED')
    _workspace_origin_type(d,bridge)
    binding=online_after_bit_preflight_binding if bridge['kind']==ONLINE_AFTER_BIT_KIND else online_pending_workspace_preflight_binding
    return binding(d,raw,producer=producer,bridge=bridge)


def online_pending_workspace_ended_preflight(d,invocation_raw,*,command_id,instance_id,producer,wire_decoder):
    """Client adapter for an ACTUALLY acquired ended invocation.

    Transport must provide the actual AWS command/target and fixed same-tree
    decoder bytes, not metadata claimed by P/F/proof. This pure helper cannot
    acquire AWS or grant authority to caller-supplied bytes. Its result is F_O
    installed by the existing root-private trusted artifact transport only.
    """
    import datetime
    try:
        _declaration_require(type(invocation_raw) is bytes and 0<len(invocation_raw)<65536
            and type(command_id) is str and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',command_id)
            and type(instance_id) is str and re.fullmatch('i-[a-f0-9]{8}(?:[a-f0-9]{9})?',instance_id)
            and callable(wire_decoder))
        value=closed_recovery_json(d,invocation_raw)
        ended=datetime.datetime.fromisoformat(value.get('ExecutionEndDateTime','').replace('Z','+00:00'))
        _declaration_require(value.get('CommandId')==command_id and value.get('InstanceId')==instance_id
            and value.get('DocumentName')=='AWS-RunShellScript' and value.get('PluginName')=='aws:runShellScript'
            and value.get('Status')=='Success' and type(value.get('ResponseCode')) is int and value['ResponseCode']==0
            and value.get('StandardErrorContent')=='' and ended.tzinfo is not None
            and ended.utcoffset()==datetime.timedelta(0)
            and ended<=datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=5))
        receipt=wire_decoder(value.get('StandardOutputContent'),scope=SCOPE)
        bridge=_workspace_evidence_origin(d,receipt)
        namespace = _workspace_origin_type(d,bridge)[1]
        _pending_workspace_validate_receipt(d,receipt,'preflight',producer['commit'],bridge['baselineCommit'])
        f={'kind':namespace+'_PREFLIGHT','version':2,'mode':'preflight',
            'status':namespace+'_BASELINE_VERIFIED','commandId':command_id,
            'releaseCandidateCommit':producer['commit'],'workflowRunId':producer['workflowRunId'],
            'workflowRunAttempt':producer['workflowRunAttempt'],'sourceTree':producer['sourceTree'],
            'baseline':bridge,'services':bridge['services'],'ordinaryPreflight':receipt}
        if _RESTORED_B_FIELD in receipt:
            f.update(version=3,services=receipt['services'],restoration=receipt[_RESTORED_B_FIELD],ordinaryPreflight=_restored_wire_encode(receipt))
        raw=(json.dumps(f,separators=(',',':') if f['version']==3 else None,indent=None if f['version']==3 else 2)+'\n').encode()
        _pending_workspace_complete_preflight(d,raw,producer=producer,bridge=bridge)
        return {'preflight_raw':raw,'invocation_raw':invocation_raw,
            'command_id':command_id,'invocation_bytes_sha256':hashlib.sha256(invocation_raw).hexdigest()}
    except Exception:
        raise RuntimeError('ONLINE_RECHARGE_PENDING_WORKSPACE_PREFLIGHT_CHANGED') from None


def _pending_workspace_pref_fields(d,value):
    # This producer owns an explicit finite evidence schema. Inherited full P,
    # arbitrary old baseline fields, raw Env and extra stdout keys never enter F.
    bridge=_workspace_evidence_origin(d,value)
    origin_field=_workspace_origin_type(d,bridge)[0]
    required={'status','commit','services','manifestSha256','environmentSha256','apiSource','guards','freeBytes',
        'workspaceIdle','workspaceVolume','workspaceOriginFiles','workspaceBuildProofSha256','migrationRecovery',
        origin_field,'audit','migration','migrationState','workersPreserved','requiresWindowHandoff','migrationPerformed'}
    if _RESTORED_B_FIELD in value:
        d.require(bridge['kind']==ONLINE_AFTER_BIT_KIND,_RESTORED_B_CODE)
        _restored_workspace_sidecar(d,bridge,value[_RESTORED_B_FIELD],value['services'])
        required.add(_RESTORED_B_FIELD)
    d.require(type(value) is dict and required<=set(value) and set(value)<=required|{'migrationOrigin'},
              'ONLINE_RECHARGE_PENDING_WORKSPACE_PREFLIGHT_CHANGED')
    d.require(value['apiSource']=={'imageId':bridge['services']['api']['image'],'revision':bridge['baselineCommit'],
        'kind':'API_WORKSPACE_BUILD_PROVEN'} and value['environmentSha256']==bridge['environmentFileSha256']
        and value['manifestSha256']==bridge['manifestBytesSha256'] and type(value['freeBytes']) is int
        and value['freeBytes']>6*1024**3 and value['workspaceBuildProofSha256']==bridge['buildProofCanonicalSha256']
        and type(value['workspaceOriginFiles']) is dict and set(value['workspaceOriginFiles'])==
            {'release-manifest.json','api-workspace-preservation.json','api-workspace-build-proof.json','backup-verification.json','before-audit.json','after-audit.json'}
        and all(_declaration_hash(v) for v in value['workspaceOriginFiles'].values()),
        'ONLINE_RECHARGE_PENDING_WORKSPACE_PREFLIGHT_CHANGED')


"""Local candidate only; this pure material check is not a release authority.

The caller must acquire old B/Q_A/Q_B and the actual fixed Q_R invocation,
bind native anchors to the failed C operation, and validate their immutable
source carriers before consuming this result. No production command is run.
"""
import copy
import hashlib
import json
import re
_restore_cfg_IDENTITY_KEYS = frozenset(('status', 'health', 'image', 'reference', 'containerId', 'startedAtSha256', 'environmentSha256', 'configurationSha256'))
_restore_cfg_HASH = re.compile('[a-f0-9]{64}')

def _restore_cfg_fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def _restore_cfg_need(ok):
    if not ok:
        raise RuntimeError('ONLINE_RECHARGE_B_RESTORE_CONFIGURATION_UNPROVEN')

def _restore_cfg_complete_configuration_material(service, metadata, actual, original, *, original_before_container_id, acquired_actual_replace_anchors):
    """Prove full configuration equality under two specific native identities.

    acquired_actual_replace_anchors is supplied only by the native caller after
    it has verified fixed B / failed C timeline material. It is never trusted
    when read from a Q/F/proof claim. Every unmatched field fails the complete
    original configuration hash comparison. Secret values stay in memory.
    """
    _restore_cfg_need(service in ('api', 'admin') and type(metadata) is dict)
    for row in (actual, original):
        _restore_cfg_need(type(row) is dict and set(row) == _restore_cfg_IDENTITY_KEYS and all((type(row[n]) is str and _restore_cfg_HASH.fullmatch(row[n]) for n in ('containerId', 'startedAtSha256', 'environmentSha256', 'configurationSha256'))))
    _restore_cfg_need(all((actual[n] == original[n] for n in ('status', 'health', 'image', 'reference', 'environmentSha256'))))
    _restore_cfg_need(type(original_before_container_id) is str and _restore_cfg_HASH.fullmatch(original_before_container_id) and (type(acquired_actual_replace_anchors) in (tuple, list)) and (len(acquired_actual_replace_anchors) <= 4) and all((type(v) is str and _restore_cfg_HASH.fullmatch(v) for v in acquired_actual_replace_anchors)) and (len(set(acquired_actual_replace_anchors)) == len(acquired_actual_replace_anchors)))
    (config, host, mounts, state) = (metadata.get(n) for n in ('Config', 'HostConfig', 'Mounts', 'State'))
    _restore_cfg_need(type(config) is dict and type(host) is dict and (type(state) is dict) and (type(mounts) is list) and all((type(v) is dict and type(v.get('Destination')) is str and v['Destination'].startswith('/') for v in mounts)) and (len({v['Destination'] for v in mounts}) == len(mounts)) and (type(config.get('Env')) is list) and bool(config['Env']) and all((type(v) is str for v in config['Env'])) and (metadata.get('Id') == actual['containerId']) and (metadata.get('Image') == actual['image']) and (config.get('Image') == actual['reference']) and (state.get('Status') == actual['status']) and ((state.get('Health') or {}).get('Status') == actual['health']) and (type(state.get('StartedAt')) is str) and (hashlib.sha256(state['StartedAt'].encode()).hexdigest() == actual['startedAtSha256']) and (_restore_cfg_fingerprint(sorted(config['Env'])) == actual['environmentSha256']))
    _restore_cfg_need(config.get('Hostname') == actual['containerId'][:12])
    complete = {'Config': config, 'HostConfig': host, 'Mounts': sorted(mounts, key=lambda v: v['Destination'])}
    _restore_cfg_need(_restore_cfg_fingerprint(complete) == actual['configurationSha256'])
    labels = config.get('Labels')
    _restore_cfg_need(type(labels) is dict and all((type(k) is str and type(v) is str for (k, v) in labels.items())) and (labels.get('com.docker.compose.service') == service) and (labels.get('com.docker.compose.container-number') == '1') and (type(labels.get('com.docker.compose.project')) is str) and re.fullmatch('[a-z0-9][a-z0-9_-]{0,62}', labels['com.docker.compose.project']))
    project = labels['com.docker.compose.project']
    names = tuple((separator.join((project, service, '1')) for separator in ('-', '_')))
    _restore_cfg_need(type(metadata.get('Name')) is str and metadata['Name'] in tuple(('/' + n for n in names)))
    (stable_name, native_slot) = (metadata['Name'][1:], service + '-1')
    replace_key = 'com.docker.compose.replace'
    actual_replace = labels.get(replace_key)
    _restore_cfg_need(actual_replace in (*acquired_actual_replace_anchors, stable_name, native_slot))
    matches = []
    for old_replace in (original_before_container_id, stable_name, native_slot, None):
        projected = copy.deepcopy(complete)
        projected['Config']['Hostname'] = original['containerId'][:12]
        if old_replace is None:
            projected['Config']['Labels'].pop(replace_key, None)
        else:
            projected['Config']['Labels'][replace_key] = old_replace
        if _restore_cfg_fingerprint(projected) == original['configurationSha256']:
            matches.append(old_replace)
    _restore_cfg_need(len(matches) == 1)
    old_replace = matches[0]
    return {'kind': 'ONLINE_RECHARGE_B_RESTORE_COMPLETE_CONFIGURATION_MATERIAL', 'version': 1, 'service': service, 'actualServiceSha256': _restore_cfg_fingerprint(actual), 'originalServiceSha256': _restore_cfg_fingerprint(original), 'actualConfigurationSha256': actual['configurationSha256'], 'originalConfigurationSha256': original['configurationSha256'], 'reconstructedConfigurationSha256': original['configurationSha256'], 'changedIdentityPaths': ['Config.Hostname', 'Config.Labels.com.docker.compose.replace'], 'hostnameMappingSha256': _restore_cfg_fingerprint({'actual': config['Hostname'], 'original': original['containerId'][:12]}), 'replaceMappingSha256': _restore_cfg_fingerprint({'actual': actual_replace, 'original': old_replace}), 'acquiredReplaceAnchorsSha256': _restore_cfg_fingerprint(acquired_actual_replace_anchors)}

def _restore_cfg_original_boot_identity(bridge, started_at):
    row = bridge['services']['api']
    _restore_cfg_need(type(started_at) is str and re.fullmatch('20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z', started_at) and (hashlib.sha256(started_at.encode()).hexdigest() == row['startedAtSha256']))
    return {**{n: row[n] for n in ('containerId', 'image', 'startedAtSha256')}, 'startedAt': started_at}
_restore_cfg_FINITE_RESTORE_WITNESS = None

def _restore_cfg_require_finite_restore_policy():
    if _restore_cfg_FINITE_RESTORE_WITNESS is None:
        raise RuntimeError('ONLINE_RECHARGE_B_RESTORE_WITNESS_UNAVAILABLE')
    raise RuntimeError('ONLINE_RECHARGE_B_RESTORE_DRAFT_NOT_INSTALLED')

"""Local pure prototype: safe material binding, never a native authority issuer.

To integrate, copy reviewed bodies into ONLINE scope, execute original API cold
and unchanged source qualification, acquire root-private pinned materials, and
bind the independent native F. There is no deployment or command capability.
"""
import datetime
import hashlib
import json
import re
_restore_pure_SERVICES = frozenset(('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration'))
_restore_pure_IDENTITY_KEYS = frozenset(('status', 'health', 'image', 'reference', 'containerId', 'startedAtSha256', 'environmentSha256', 'configurationSha256'))
_restore_pure_QR_KEYS = frozenset(('version', 'readOnlyObservation', 'measurementsComplete', 'publicationQualified', 'productionMutationCommandsInvoked', 'databaseFreshlyMeasured', 'nativeGrantSyncReached', 'nativeMigrationAttempted', 'inputBindingSha256', 'currentIsOriginalB', 'originalManifestBytesMatch', 'originalEnvironmentAndConfigurationFilesMatch', 'originalManifestNewMigrationCount', 'runtimeContentMatchesOriginal', 'apiAdminRuntimeConfigurationProof', 'apiCurrentStartedAt', 'apiCurrentStartedAtSha256', 'failedTarget', 'workspaceObservation', 'originalStoppedApiObservation', 'currentServices', 'services', 'disk', 'twoRuntimeFramesStable', 'currentPointerStable', 'preservedFullIdentityCount', 'apiAdminImageReferenceEnvironmentContentMatchesOriginal', 'deadlineExceeded'))
_restore_pure_POLICY_KEYS = frozenset(('kind', 'version', 'baselineBridgeSha256', 'originalBootStartedAt', 'failedProducer', 'failedCommandId', 'failedNativeEnd', 'failedRelease', 'failureCanonicalSha256', 'failedPreflightBytesSha256', 'failedBuildProofSha256', 'failedSourceHelpers', 'instanceId', 'readbackCommandId', 'readbackInvocationBytesSha256', 'readbackBodySha256', 'readbackInputBindingSha256'))
_restore_pure_FINITE_RESTORE_POLICY = None

def _restore_pure_need(ok):
    if not ok:
        raise RuntimeError('ONLINE_RECHARGE_B_RESTORE_MATERIAL_CHANGED')

def _restore_pure_fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def _restore_pure_closed(raw):

    def pairs(rows):
        result = {}
        for (key, value) in rows:
            _restore_pure_need(key not in result)
            result[key] = value
        return result
    _restore_pure_need(type(raw) in (str, bytes))
    result = json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda unused: _restore_pure_need(False))
    _restore_pure_need(type(result) is dict)
    return result

def _restore_pure_utc(value):
    _restore_pure_need(type(value) is str)
    result = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    _restore_pure_need(result.utcoffset() == datetime.timedelta(0))
    return result

def _restore_pure_service_shape(states):
    _restore_pure_need(type(states) is dict and set(states) == _restore_pure_SERVICES)
    for (service, row) in states.items():
        _restore_pure_need(type(row) is dict and set(row) == _restore_pure_IDENTITY_KEYS and (row['status'] == 'running') and (row['health'] == 'healthy' or (service == 'caddy' and row['health'] is None)) and (type(row['image']) is str) and re.fullmatch('sha256:[a-f0-9]{64}', row['image']) and (type(row['reference']) is str) and (0 < len(row['reference']) < 512) and all((type(row[n]) is str and re.fullmatch('[a-f0-9]{64}', row[n]) for n in ('containerId', 'startedAtSha256', 'environmentSha256', 'configurationSha256'))))

def _restore_pure_validate_observation_material(bridge, invocation_raw, policy):
    """A fixed observation remains explicitly non-qualifying after validation.

    The root-reviewed policy is not a producer/F/UUID claim supplied by users.
    Pure binding of actually acquired invocation bytes cannot create native
    transport authority, complete configuration equivalence, or a release F.
    """
    _restore_pure_need(type(policy) is dict and set(policy) == _restore_pure_POLICY_KEYS and (policy['kind'] == 'ONLINE_RECHARGE_B_RESTORE_FINITE_OBSERVATION') and (policy['version'] == 1) and (type(invocation_raw) is bytes) and (0 < len(invocation_raw) < 65536) and (hashlib.sha256(invocation_raw).hexdigest() == policy['readbackInvocationBytesSha256']) and (_restore_pure_fingerprint(bridge) == policy['baselineBridgeSha256']) and (bridge['kind'] == 'ONLINE_RECHARGE_AFTER_BIT_SUCCESSOR_ORIGIN'))
    _restore_pure_service_shape(bridge['services'])
    q = _restore_pure_closed(invocation_raw)
    required = {'CommandId', 'InstanceId', 'DocumentName', 'PluginName', 'Status', 'ResponseCode', 'ExecutionStartDateTime', 'ExecutionEndDateTime', 'StandardOutputContent', 'StandardErrorContent'}
    allowed = required | {'Comment', 'DocumentVersion', 'ExecutionElapsedTime', 'StatusDetails', 'StandardOutputUrl', 'StandardErrorUrl', 'CloudWatchOutputConfig'}
    _restore_pure_need(required <= set(q) <= allowed and q['CommandId'] == policy['readbackCommandId'] and (q['InstanceId'] == policy['instanceId']) and (q['DocumentName'] == 'AWS-RunShellScript') and (q['PluginName'] == 'aws:runShellScript') and (q['Status'] == 'Success') and (type(q['ResponseCode']) is int) and (q['ResponseCode'] == 0) and (q['StandardErrorContent'] == '') and (_restore_pure_utc(policy['failedNativeEnd']) < _restore_pure_utc(q['ExecutionStartDateTime'])) and (_restore_pure_utc(q['ExecutionStartDateTime']) <= _restore_pure_utc(q['ExecutionEndDateTime'])))
    r = _restore_pure_closed(q['StandardOutputContent'])
    _restore_pure_need(set(r) == _restore_pure_QR_KEYS and type(r['version']) is int and (r['version'] == 1) and (r['inputBindingSha256'] == policy['readbackInputBindingSha256']) and all((r[n] is True for n in ('readOnlyObservation', 'measurementsComplete', 'currentIsOriginalB', 'originalManifestBytesMatch', 'originalEnvironmentAndConfigurationFilesMatch', 'twoRuntimeFramesStable', 'currentPointerStable', 'apiAdminImageReferenceEnvironmentContentMatchesOriginal', 'nativeGrantSyncReached'))) and all((r[n] is False for n in ('publicationQualified', 'productionMutationCommandsInvoked', 'databaseFreshlyMeasured', 'nativeMigrationAttempted', 'deadlineExceeded'))) and (type(r['preservedFullIdentityCount']) is int) and (r['preservedFullIdentityCount'] == 5) and (type(r['originalManifestNewMigrationCount']) is int) and (r['originalManifestNewMigrationCount'] == 0) and (r['runtimeContentMatchesOriginal'] == {'api': True, 'admin': True}))
    actual = r['currentServices']
    _restore_pure_service_shape(actual)
    _restore_pure_need(all((actual[n] == bridge['services'][n] for n in _restore_pure_SERVICES - {'api', 'admin'})) and all((actual[n][k] == bridge['services'][n][k] for n in ('api', 'admin') for k in ('status', 'health', 'image', 'reference', 'environmentSha256'))) and (type(r['apiCurrentStartedAt']) is str) and (hashlib.sha256(r['apiCurrentStartedAt'].encode()).hexdigest() == r['apiCurrentStartedAtSha256'] == actual['api']['startedAtSha256']))
    _restore_pure_need(hashlib.sha256(policy['originalBootStartedAt'].encode()).hexdigest() == bridge['services']['api']['startedAtSha256'])
    target = r['failedTarget']
    _restore_pure_need(type(target) is dict and target.get('uniqueTargetKnown') is True and (target.get('targetSourceBound') is True) and (target.get('actualReleasePath') == policy['failedRelease']) and (target.get('failureCanonicalSha256') == policy['failureCanonicalSha256']) and (target.get('sourceHelpersSha256') == policy['failedSourceHelpers']))
    cfg = r['apiAdminRuntimeConfigurationProof']
    _restore_pure_need(type(cfg) is dict and set(cfg) == {'formalConfigurationQualificationMeasured', 'services'} and (cfg['formalConfigurationQualificationMeasured'] is False) and (type(cfg['services']) is dict) and (set(cfg['services']) == {'api', 'admin'}))
    for (name, material) in cfg['services'].items():
        _restore_pure_need(type(material) is dict and set(material) == {'configSha256', 'hostConfigSha256', 'destinationSortedMountsSha256', 'completeConfigurationSha256', 'mountCount'} and (material['completeConfigurationSha256'] == actual[name]['configurationSha256']) and (type(material['mountCount']) is int) and (0 <= material['mountCount'] < 64) and all((type(material[n]) is str and re.fullmatch('[a-f0-9]{64}', material[n]) for n in material if n.endswith('Sha256'))))
    return {'kind': 'ONLINE_RECHARGE_B_RESTORE_BOUND_OBSERVATION', 'version': 1, 'baselineOriginSha256': _restore_pure_fingerprint(bridge), 'invocationBytesSha256': hashlib.sha256(invocation_raw).hexdigest(), 'commandId': policy['readbackCommandId'], 'bodySha256': policy['readbackBodySha256'], 'currentServices': actual, 'configurationSummaries': cfg['services'], 'sourceApiStartedAt': r['apiCurrentStartedAt'], 'originalApiStartedAt': policy['originalBootStartedAt'], 'failureCanonicalSha256': policy['failureCanonicalSha256'], 'formalConfigurationQualificationMeasured': False, 'publicationQualified': False}

def _restore_pure_complete_restore_material(bridge, observed, native_configuration_materials):
    """Combine native re-reading full-config hash proofs; not a Q/F issuer.

    In the actual native F this must run on complete_configuration_material()
    results produced from live docker inspect, not on F/Q caller claims.
    """
    _restore_pure_need(type(observed) is dict and observed.get('kind') == 'ONLINE_RECHARGE_B_RESTORE_BOUND_OBSERVATION' and (observed.get('formalConfigurationQualificationMeasured') is False) and (observed.get('publicationQualified') is False) and (observed.get('baselineOriginSha256') == _restore_pure_fingerprint(bridge)) and (type(native_configuration_materials) is dict) and (set(native_configuration_materials) == {'api', 'admin'}))
    for (service, proof) in native_configuration_materials.items():
        _restore_pure_need(type(proof) is dict and proof.get('kind') == 'ONLINE_RECHARGE_B_RESTORE_COMPLETE_CONFIGURATION_MATERIAL' and (proof.get('version') == 1) and (proof.get('service') == service) and (proof.get('actualServiceSha256') == _restore_pure_fingerprint(observed['currentServices'][service])) and (proof.get('originalServiceSha256') == _restore_pure_fingerprint(bridge['services'][service])) and (proof.get('actualConfigurationSha256') == observed['currentServices'][service]['configurationSha256']) and (proof.get('originalConfigurationSha256') == proof.get('reconstructedConfigurationSha256') == bridge['services'][service]['configurationSha256']) and (proof.get('changedIdentityPaths') == ['Config.Hostname', 'Config.Labels.com.docker.compose.replace']))
    return {'kind': 'ONLINE_RECHARGE_B_RESTORE_COMPLETE_MATERIAL', 'version': 1, 'baselineOriginSha256': _restore_pure_fingerprint(bridge), 'observationSha256': _restore_pure_fingerprint(observed), 'actualServicesSha256': _restore_pure_fingerprint(observed['currentServices']), 'configurationProofSha256': _restore_pure_fingerprint(native_configuration_materials), 'historyApiIdentity': {**{n: bridge['services']['api'][n] for n in ('containerId', 'image', 'startedAtSha256')}, 'startedAt': observed['originalApiStartedAt']}, 'stopApiIdentity': {**{n: observed['currentServices']['api'][n] for n in ('containerId', 'image', 'startedAtSha256')}, 'startedAt': observed['sourceApiStartedAt']}, 'publicationQualified': False}

def _restore_pure_restored_f_shape(f, bridge, producer, complete):
    """Explicit v3 schema; no normalization into original v2 before identity."""
    _restore_pure_need(type(f) is dict and set(f) == {'kind', 'version', 'mode', 'status', 'commandId', 'releaseCandidateCommit', 'workflowRunId', 'workflowRunAttempt', 'sourceTree', 'baseline', 'services', 'ordinaryPreflight', 'restoration'} and (f['kind'] == 'ONLINE_RECHARGE_AFTER_BIT_PREFLIGHT') and (type(f['version']) is int) and (f['version'] == 3) and (f['mode'] == 'preflight') and (f['status'] == 'ONLINE_RECHARGE_AFTER_BIT_BASELINE_VERIFIED') and (f['baseline'] == bridge) and (f['restoration'] == complete) and (f['releaseCandidateCommit'] == producer['commit']) and (f['sourceTree'] == producer['sourceTree']) and (f['workflowRunId'] == producer['workflowRunId']) and (f['workflowRunAttempt'] == producer['workflowRunAttempt']) and (_restore_pure_fingerprint(f['services']) == complete['actualServicesSha256']))
    _restore_pure_service_shape(f['services'])
    receipt = f['ordinaryPreflight']
    _restore_pure_need(type(receipt) is dict and receipt.get('onlineAfterBitOrigin') == bridge and (receipt.get('afterBitRestoration') == complete) and (receipt.get('services') == f['services']) and (receipt.get('migrationPerformed') is False))
    return {'kind': 'ONLINE_RECHARGE_AFTER_BIT_RESTORED_PREFLIGHT_SEAL', 'version': 3, 'baselineOriginSha256': _restore_pure_fingerprint(bridge), 'restorationSha256': _restore_pure_fingerprint(complete), 'actualServicesSha256': complete['actualServicesSha256']}

def _restore_pure_restored_build_shape(proof, f, producer):
    _restore_pure_need(type(proof) is dict and proof.get('version') == 3 and (proof.get('kind') == 'ONLINE_RECHARGE_AFTER_BIT_BUILD_PROOF') and (proof.get('commit') == producer['commit']) and (proof.get('sourceTree') == producer['sourceTree']) and (proof.get('baselineOriginSha256') == _restore_pure_fingerprint(f['baseline'])) and (proof.get('restorationSha256') == _restore_pure_fingerprint(f['restoration'])) and (proof.get('beforeServicesSha256') == _restore_pure_fingerprint(f['services'])))
    return proof

def _restore_pure_restored_before_and_stop_shape(record, f, sqlite_receipt, audit_receipt):
    restore = f['restoration']
    _restore_pure_need(record.get('before') == f['services'] and record.get('baselineEvidence', {}).get('onlineAfterBitOrigin') == f['baseline'] and (record.get('baselineEvidence', {}).get('restoration') == restore) and (sqlite_receipt.get('sourceApiIdentity') == {n: restore['stopApiIdentity'][n] for n in ('containerId', 'image', 'startedAtSha256')}) and (audit_receipt.get('version') == 2) and (audit_receipt.get('historyApiIdentity') == restore['historyApiIdentity']) and (audit_receipt.get('sourceApiIdentity') == restore['stopApiIdentity']) and (audit_receipt.get('oldApiStop') == {'identity': sqlite_receipt['sourceApiIdentity'], 'running': False, 'pid': 0}) and (audit_receipt.get('restorationSha256') == _restore_pure_fingerprint(restore)))
    return True

def _restore_pure_require_reviewed_restore_policy():
    if _restore_pure_FINITE_RESTORE_POLICY is None:
        raise RuntimeError('ONLINE_RECHARGE_B_RESTORE_WITNESS_UNAVAILABLE')
    raise RuntimeError('ONLINE_RECHARGE_B_RESTORE_DRAFT_NOT_INSTALLED')

"""Project-local read-only failed-C event material; no dispatch or create call.

Docker retains a bounded event history. Missing/ambiguous events are UNPROVEN,
never permission to accept an unbound com.docker.compose.replace container ID.
Caller first validates the failed C's own full four-image proof and source tree.
"""
import datetime
import hashlib
import json
import re
_restore_events_FAILED_PRODUCER = {'commit': '08419dcbe85212a203906c86c98e5c3ae0695d72', 'sourceTree': 'b6fd81cc0c94a8e5971c5df8b2570716a13fa042', 'workflowRunId': '38160127343', 'workflowRunAttempt': '1'}
_restore_events_FAILED_START = '2026-10-11T17:42:42.942Z'
_restore_events_FAILED_END = '2026-10-11T17:58:11.942Z'
_restore_events_FAILED_PROOF_SHA = 'eaa990d402ef921c816c561de4d2b2f1aee7a554ac30fa284fc079293f8a7483'

def _restore_events_need(ok):
    if not ok:
        raise RuntimeError('ONLINE_RECHARGE_B_RESTORE_EVENT_ANCHOR_UNPROVEN')

def _restore_events_fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def _restore_events_nanoseconds(stamp):
    value = datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
    _restore_events_need(value.utcoffset() == datetime.timedelta(0))
    elapsed = value - datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
    return (elapsed.days * 86400 + elapsed.seconds) * 1000000000 + elapsed.microseconds * 1000

def _restore_events_failed_candidate_event_anchor(d, service, proof, failed_release):
    """Only fixed run/image/service/working-directory create/start/destroy."""
    _restore_events_need(service in ('api', 'admin') and _restore_events_fingerprint(proof) == _restore_events_FAILED_PROOF_SHA and (proof.get('commit') == _restore_events_FAILED_PRODUCER['commit']) and (proof.get('sourceTree') == _restore_events_FAILED_PRODUCER['sourceTree']) and (type(proof.get('images')) is dict) and (set(proof['images']) == {'api', 'admin', 'migrate', 'online-recharge'}) and (type(failed_release) is str) and re.fullmatch('/opt/id-business-v2/releases/[0-9]{8}T[0-9]{6}Z-' + _restore_events_FAILED_PRODUCER['commit'][:12], failed_release))
    image = proof['images'][service]
    _restore_events_need(type(image) is dict and type(image.get('reference')) is str and re.fullmatch('[0-9]{12}\\.dkr\\.ecr\\.ap-northeast-1\\.amazonaws\\.com/id-business-v2-release:' + _restore_events_FAILED_PRODUCER['commit'] + '-38160127343-1-' + service, image['reference']) and re.fullmatch('sha256:[a-f0-9]{64}', image.get('imageId', '')))
    metadata = json.loads(d.run('docker', 'image', 'inspect', image['reference'], timeout=5))
    _restore_events_need(type(metadata) is list and len(metadata) == 1 and (metadata[0].get('Id') == image['imageId']))
    output = d.run('docker', 'events', '--since', _restore_events_FAILED_START, '--until', _restore_events_FAILED_END, '--filter', 'type=container', '--filter', 'label=com.docker.compose.service=' + service, '--filter', 'image=' + image['reference'], '--filter', 'event=create', '--filter', 'event=start', '--filter', 'event=destroy', '--format', '{{json .}}', timeout=8)
    _restore_events_need(type(output) is str and 0 < len(output.encode()) <= 65535)
    rows = [json.loads(line) for line in output.splitlines() if line]
    _restore_events_need(0 < len(rows) < 128)
    (events, ids) = ([], set())
    for row in rows:
        (actor, attributes) = (row.get('Actor', {}), row.get('Actor', {}).get('Attributes', {}))
        (cid, stamp, action) = (actor.get('ID'), row.get('timeNano'), row.get('Action'))
        _restore_events_need(row.get('Type') == 'container' and type(cid) is str and re.fullmatch('[a-f0-9]{64}', cid) and (type(stamp) is int) and (_restore_events_nanoseconds(_restore_events_FAILED_START) <= stamp <= _restore_events_nanoseconds(_restore_events_FAILED_END)) and (action in ('create', 'start', 'destroy')) and (type(attributes) is dict) and (attributes.get('com.docker.compose.service') == service) and (attributes.get('com.docker.compose.container-number') == '1') and (attributes.get('image') == image['reference']) and (attributes.get('com.docker.compose.project.working_dir') == failed_release))
        ids.add(cid)
        events.append({'containerId': cid, 'timeNano': stamp, 'action': action})
    _restore_events_need(len(ids) == 1 and events == sorted(events, key=lambda value: value['timeNano']))
    actions = [row['action'] for row in events]
    _restore_events_need(actions.count('create') == actions.count('start') == actions.count('destroy') == 1 and actions.index('create') < actions.index('start') < actions.index('destroy'))
    return {'kind': 'ONLINE_RECHARGE_B_RESTORE_FAILED_C_EVENT_ANCHOR', 'version': 1, 'service': service, 'containerId': next(iter(ids)), 'failedProducer': _restore_events_FAILED_PRODUCER, 'failedBuildProofSha256': _restore_events_FAILED_PROOF_SHA, 'failedRelease': failed_release, 'nativeInterval': {'start': _restore_events_FAILED_START, 'end': _restore_events_FAILED_END}, 'image': image, 'events': events, 'eventMaterialSha256': _restore_events_fingerprint(events)}

"""New restored-B acquisition uses the original sealed complete comparison.

Only safe public facts and qualification reports leave the native session.
Config/HostConfig/Env/full resource inspect remain in memory. No old raw hash
is manufactured; the old B API hash remains explicitly historical only.
"""

_RESTORED_B_OOM_WITNESS = {'raw': '{\n  "CommandId": "0a3d27f7-9d86-400c-9c8e-c578cbca3342",\n  "InstanceId": "i-05836da38606e633c",\n  "Status": "Success",\n  "ResponseCode": 0,\n  "ExecutionStartDateTime": "2026-10-11T19:43:11.831Z",\n  "ExecutionEndDateTime": "2026-10-11T19:43:14.831Z",\n  "StandardOutputContent": "{\\"currentPointerStable\\": true, \\"databaseFreshlyMeasured\\": false, \\"diagnosticPredicates\\": {\\"admin\\": {\\"actualOomKillDisable\\": \\"NULL\\", \\"currentCompleteConfigurationSha256\\": \\"dcc6ae6ce35fb2771b9f14e8ae2191d68cba9a4e32c98cf6a46257687ce8fe00\\", \\"expectedCurrentCompleteConfigurationSha256\\": \\"dcc6ae6ce35fb2771b9f14e8ae2191d68cba9a4e32c98cf6a46257687ce8fe00\\", \\"failedPredicates\\": [], \\"finiteOomCandidates\\": [{\\"candidateCompleteConfigurationSha256\\": \\"7131dc83741efea394a61c43a5f3c6da6f17631f82ff137c2726a6c1d46f4509\\", \\"matchesOriginalCompleteConfiguration\\": false, \\"oldOomKillDisable\\": \\"NULL\\", \\"oldReplaceBasis\\": \\"ORIGINAL_BEFORE_CID\\"}, {\\"candidateCompleteConfigurationSha256\\": \\"1865e3234428fd0a799b88fb5cd9d5eb3b9e1f46b33691accace3549cef7d1bd\\", \\"matchesOriginalCompleteConfiguration\\": false, \\"oldOomKillDisable\\": \\"FALSE\\", \\"oldReplaceBasis\\": \\"ORIGINAL_BEFORE_CID\\"}, {\\"candidateCompleteConfigurationSha256\\": \\"466ecc2a33faba4825f6215a724f393f4f970ab7fc874b1f17cf5dae4dfd5ba1\\", \\"matchesOriginalCompleteConfiguration\\": false, \\"oldOomKillDisable\\": \\"NULL\\", \\"oldReplaceBasis\\": \\"OBSERVED_CONTAINER_NAME\\"}, {\\"candidateCompleteConfigurationSha256\\": \\"2290c67a0023fb6b588a7e978534e3ff6ffb52b8ae92d61d2e1bad19a48015c2\\", \\"matchesOriginalCompleteConfiguration\\": false, \\"oldOomKillDisable\\": \\"FALSE\\", \\"oldReplaceBasis\\": \\"OBSERVED_CONTAINER_NAME\\"}, {\\"candidateCompleteConfigurationSha256\\": \\"be8b5cdfbe02bb3b7863d52151ce2ec904ac4a41ef8d0d8741b2098608069571\\", \\"matchesOriginalCompleteConfiguration\\": true, \\"oldOomKillDisable\\": \\"NULL\\", \\"oldReplaceBasis\\": \\"NATIVE_SERVICE_SLOT\\"}, {\\"candidateCompleteConfigurationSha256\\": \\"0a928c0762145dac94cc6aaae9dce28260dd83c0998e2ac070c39e4626e6c211\\", \\"matchesOriginalCompleteConfiguration\\": false, \\"oldOomKillDisable\\": \\"FALSE\\", \\"oldReplaceBasis\\": \\"NATIVE_SERVICE_SLOT\\"}, {\\"candidateCompleteConfigurationSha256\\": \\"4139072f72abf35fca31d3a01b1595e30b5d39d8904c623aff16600870723665\\", \\"matchesOriginalCompleteConfiguration\\": false, \\"oldOomKillDisable\\": \\"NULL\\", \\"oldReplaceBasis\\": \\"ABSENT\\"}, {\\"candidateCompleteConfigurationSha256\\": \\"68e22decc14f349b52779244292e3bce18ef7a76682b359b9e6de2e1d836abd7\\", \\"matchesOriginalCompleteConfiguration\\": false, \\"oldOomKillDisable\\": \\"FALSE\\", \\"oldReplaceBasis\\": \\"ABSENT\\"}], \\"finiteOomMatchCount\\": 1, \\"fixedPredicateBooleans\\": {\\"CFG_BEFORE_CID\\": true, \\"CFG_COMPLETE_CURRENT_SHA\\": true, \\"CFG_COMPOSE_PROJECT\\": true, \\"CFG_COMPOSE_SERVICE_SLOT\\": true, \\"CFG_ENV_SHA\\": true, \\"CFG_ENV_VALID\\": true, \\"CFG_HOSTNAME_CURRENT_CID\\": true, \\"CFG_LABELS_STRING_MAP\\": true, \\"CFG_NATIVE_CID_IMAGE_REFERENCE\\": true, \\"CFG_NATIVE_STATUS_HEALTH\\": true, \\"CFG_NATIVE_STRUCTURES\\": true, \\"CFG_OLD_ACTUAL_STABLE_FIELDS\\": true, \\"CFG_REPLACE_ORIGINAL_B_OR_STABLE\\": true, \\"CFG_SERVICE_SHAPE\\": true, \\"CFG_STABLE_CONTAINER_NAME\\": true, \\"CFG_STARTED_SHA\\": true, \\"CFG_UNIQUE_TWO_FIELD_OLD_MATCH\\": true}, \\"originalCompleteConfigurationSha256\\": \\"be8b5cdfbe02bb3b7863d52151ce2ec904ac4a41ef8d0d8741b2098608069571\\", \\"priorFrozenSourceSha256\\": \\"2e50ff8907862f5ea0b600707d5046642f34c2afc1f6280cc654610749a618a0\\", \\"priorSourceNeedChecks\\": [{\\"line\\": 144, \\"matched\\": true}, {\\"line\\": 146, \\"matched\\": true}, {\\"line\\": 149, \\"matched\\": true}, {\\"line\\": 151, \\"matched\\": true}, {\\"line\\": 158, \\"matched\\": true}, {\\"line\\": 170, \\"matched\\": true}, {\\"line\\": 173, \\"matched\\": true}, {\\"line\\": 175, \\"matched\\": true}, {\\"line\\": 182, \\"matched\\": true}, {\\"line\\": 186, \\"matched\\": true}, {\\"line\\": 197, \\"matched\\": true}], \\"safeNativeFields\\": {\\"composeProject\\": {\\"safeValue\\": \\"20260821t095106z\\", \\"sha256\\": \\"534a241e408178fa37b56c6f07f2ec087b0f81520ec426557390505bb81e2421\\"}, \\"composeReplace\\": {\\"safeValue\\": \\"admin-1\\", \\"sha256\\": \\"90b1b286043f1b7612e423c74608f5ea2f676340507f0b67219b20d09fc4777b\\"}, \\"containerName\\": {\\"safeValue\\": \\"20260821t095106z-admin-1\\", \\"sha256\\": \\"a617ea16ad05d0684e6a815b6f33a9a355e00161b07edbb3fc1a5c1744c36fef\\"}, \\"hostname\\": {\\"safeValue\\": \\"bddd1b41836c\\", \\"sha256\\": \\"108d7e7f0725b073a4de36ae58cb771a935778ee0aad4658bfb0dce5a59e3744\\"}}, \\"twoFieldMappingCandidates\\": [{\\"candidateConfigurationSha256\\": \\"7131dc83741efea394a61c43a5f3c6da6f17631f82ff137c2726a6c1d46f4509\\", \\"matchesOriginalCompleteConfiguration\\": false, \\"oldReplaceBasis\\": \\"ORIGINAL_BEFORE_CID\\", \\"originalHostnameBasis\\": \\"ORIGINAL_B_CID_PREFIX\\"}, {\\"candidateConfigurationSha256\\": \\"466ecc2a33faba4825f6215a724f393f4f970ab7fc874b1f17cf5dae4dfd5ba1\\", \\"matchesOriginalCompleteConfiguration\\": false, \\"oldReplaceBasis\\": \\"OBSERVED_CONTAINER_NAME\\", \\"originalHostnameBasis\\": \\"ORIGINAL_B_CID_PREFIX\\"}, {\\"candidateConfigurationSha256\\": \\"be8b5cdfbe02bb3b7863d52151ce2ec904ac4a41ef8d0d8741b2098608069571\\", \\"matchesOriginalCompleteConfiguration\\": true, \\"oldReplaceBasis\\": \\"NATIVE_SERVICE_SLOT\\", \\"originalHostnameBasis\\": \\"ORIGINAL_B_CID_PREFIX\\"}, {\\"candidateConfigurationSha256\\": \\"4139072f72abf35fca31d3a01b1595e30b5d39d8904c623aff16600870723665\\", \\"matchesOriginalCompleteConfiguration\\": false, \\"oldReplaceBasis\\": \\"ABSENT\\", \\"originalHostnameBasis\\": \\"ORIGINAL_B_CID_PREFIX\\"}]}, \\"api\\": {\\"actualOomKillDisable\\": \\"NULL\\", \\"currentCompleteConfigurationSha256\\": \\"394d782259b5384f071204bc9232fa88778a4f2d668384ebbd8a68fe27ebc0b8\\", \\"expectedCurrentCompleteConfigurationSha256\\": \\"394d782259b5384f071204bc9232fa88778a4f2d668384ebbd8a68fe27ebc0b8\\", \\"failedPredicates\\": [\\"CFG_UNIQUE_TWO_FIELD_OLD_MATCH\\"], \\"finiteOomCandidates\\": [{\\"candidateCompleteConfigurationSha256\\": \\"578309899a22a177330c9875909160d50f1d3468635b52fae516d5c44c26be42\\", \\"matchesOriginalCompleteConfiguration\\": false, \\"oldOomKillDisable\\": \\"NULL\\", \\"oldReplaceBasis\\": \\"ORIGINAL_BEFORE_CID\\"}, {\\"candidateCompleteConfigurationSha256\\": \\"caa5d0f6173ae96313cb7be82f514ea19985845e9f108bf02718f0f1c608232f\\", \\"matchesOriginalCompleteConfiguration\\": false, \\"oldOomKillDisable\\": \\"FALSE\\", \\"oldReplaceBasis\\": \\"ORIGINAL_BEFORE_CID\\"}, {\\"candidateCompleteConfigurationSha256\\": \\"87f2ab2a50305f008012411cb57026a82973a025ebf8c86e469420d44c8f0ae7\\", \\"matchesOriginalCompleteConfiguration\\": false, \\"oldOomKillDisable\\": \\"NULL\\", \\"oldReplaceBasis\\": \\"OBSERVED_CONTAINER_NAME\\"}, {\\"candidateCompleteConfigurationSha256\\": \\"22db7696caf00b8f805edd6ff3123a1c9e19ff193daceed4fbf343c3f7510ea2\\", \\"matchesOriginalCompleteConfiguration\\": false, \\"oldOomKillDisable\\": \\"FALSE\\", \\"oldReplaceBasis\\": \\"OBSERVED_CONTAINER_NAME\\"}, {\\"candidateCompleteConfigurationSha256\\": \\"4191e4299ded8a1ebcd57a9626319fa22d2a60af62e46c16b6053bb1d1b27330\\", \\"matchesOriginalCompleteConfiguration\\": false, \\"oldOomKillDisable\\": \\"NULL\\", \\"oldReplaceBasis\\": \\"NATIVE_SERVICE_SLOT\\"}, {\\"candidateCompleteConfigurationSha256\\": \\"31c5810ca491da1a29ed2a58d95191847b66075e36ef85bf2dea1b956d3ab82e\\", \\"matchesOriginalCompleteConfiguration\\": false, \\"oldOomKillDisable\\": \\"FALSE\\", \\"oldReplaceBasis\\": \\"NATIVE_SERVICE_SLOT\\"}, {\\"candidateCompleteConfigurationSha256\\": \\"65d5b0201470a63ca028e97b96574d30a6db7e0e1d3c82df534d019fcf793bbe\\", \\"matchesOriginalCompleteConfiguration\\": false, \\"oldOomKillDisable\\": \\"NULL\\", \\"oldReplaceBasis\\": \\"ABSENT\\"}, {\\"candidateCompleteConfigurationSha256\\": \\"7f517662dbb395bcc6edc7edcb58f6a964ac7d837ec7f3be5b77b3ffdd2ff6fb\\", \\"matchesOriginalCompleteConfiguration\\": false, \\"oldOomKillDisable\\": \\"FALSE\\", \\"oldReplaceBasis\\": \\"ABSENT\\"}], \\"finiteOomMatchCount\\": 0, \\"fixedPredicateBooleans\\": {\\"CFG_BEFORE_CID\\": true, \\"CFG_COMPLETE_CURRENT_SHA\\": true, \\"CFG_COMPOSE_PROJECT\\": true, \\"CFG_COMPOSE_SERVICE_SLOT\\": true, \\"CFG_ENV_SHA\\": true, \\"CFG_ENV_VALID\\": true, \\"CFG_HOSTNAME_CURRENT_CID\\": true, \\"CFG_LABELS_STRING_MAP\\": true, \\"CFG_NATIVE_CID_IMAGE_REFERENCE\\": true, \\"CFG_NATIVE_STATUS_HEALTH\\": true, \\"CFG_NATIVE_STRUCTURES\\": true, \\"CFG_OLD_ACTUAL_STABLE_FIELDS\\": true, \\"CFG_REPLACE_ORIGINAL_B_OR_STABLE\\": true, \\"CFG_SERVICE_SHAPE\\": true, \\"CFG_STABLE_CONTAINER_NAME\\": true, \\"CFG_STARTED_SHA\\": true, \\"CFG_UNIQUE_TWO_FIELD_OLD_MATCH\\": false}, \\"originalCompleteConfigurationSha256\\": \\"f28dcf5a382376c898c462fa0d86c6a28f37f6a1ba0bc4ba66a7c4a467a972c8\\", \\"priorFrozenSourceSha256\\": \\"2e50ff8907862f5ea0b600707d5046642f34c2afc1f6280cc654610749a618a0\\", \\"priorSourceNeedChecks\\": [{\\"line\\": 144, \\"matched\\": true}, {\\"line\\": 146, \\"matched\\": true}, {\\"line\\": 149, \\"matched\\": true}, {\\"line\\": 151, \\"matched\\": true}, {\\"line\\": 158, \\"matched\\": true}, {\\"line\\": 170, \\"matched\\": true}, {\\"line\\": 173, \\"matched\\": true}, {\\"line\\": 175, \\"matched\\": true}, {\\"line\\": 182, \\"matched\\": true}, {\\"line\\": 186, \\"matched\\": true}, {\\"line\\": 197, \\"matched\\": false}], \\"safeNativeFields\\": {\\"composeProject\\": {\\"safeValue\\": \\"20260821t095106z\\", \\"sha256\\": \\"534a241e408178fa37b56c6f07f2ec087b0f81520ec426557390505bb81e2421\\"}, \\"composeReplace\\": {\\"safeValue\\": \\"api-1\\", \\"sha256\\": \\"f9811b73ac5d1a8db842634fc0f871e03207ae44105fc9c2b7f1985e70f90d5a\\"}, \\"containerName\\": {\\"safeValue\\": \\"20260821t095106z-api-1\\", \\"sha256\\": \\"e8edc4ff94d2838975a9661e2abb37c9c33abe41f23cf10fc90d023b338f1023\\"}, \\"hostname\\": {\\"safeValue\\": \\"cfaf13170d1f\\", \\"sha256\\": \\"b740561a8840005698e384547e8a9ca629bba222932882dff49ea8d30526d0a9\\"}}, \\"twoFieldMappingCandidates\\": [{\\"candidateConfigurationSha256\\": \\"578309899a22a177330c9875909160d50f1d3468635b52fae516d5c44c26be42\\", \\"matchesOriginalCompleteConfiguration\\": false, \\"oldReplaceBasis\\": \\"ORIGINAL_BEFORE_CID\\", \\"originalHostnameBasis\\": \\"ORIGINAL_B_CID_PREFIX\\"}, {\\"candidateConfigurationSha256\\": \\"87f2ab2a50305f008012411cb57026a82973a025ebf8c86e469420d44c8f0ae7\\", \\"matchesOriginalCompleteConfiguration\\": false, \\"oldReplaceBasis\\": \\"OBSERVED_CONTAINER_NAME\\", \\"originalHostnameBasis\\": \\"ORIGINAL_B_CID_PREFIX\\"}, {\\"candidateConfigurationSha256\\": \\"4191e4299ded8a1ebcd57a9626319fa22d2a60af62e46c16b6053bb1d1b27330\\", \\"matchesOriginalCompleteConfiguration\\": false, \\"oldReplaceBasis\\": \\"NATIVE_SERVICE_SLOT\\", \\"originalHostnameBasis\\": \\"ORIGINAL_B_CID_PREFIX\\"}, {\\"candidateConfigurationSha256\\": \\"65d5b0201470a63ca028e97b96574d30a6db7e0e1d3c82df534d019fcf793bbe\\", \\"matchesOriginalCompleteConfiguration\\": false, \\"oldReplaceBasis\\": \\"ABSENT\\", \\"originalHostnameBasis\\": \\"ORIGINAL_B_CID_PREFIX\\"}]}}, \\"existingOomValueRuleMatched\\": true, \\"existingVersionRuleMatched\\": true, \\"formalConfigurationMaterialMeasured\\": false, \\"generatorVersions\\": {\\"composeVersion\\": \\"5.5.0\\", \\"engineApiVersion\\": \\"1.44\\", \\"engineVersion\\": \\"25.0.16\\"}, \\"inputBindingSha256\\": \\"3f0e236cea6b772691fd9a6ddfeaabafd798821049d32c9e5da71d3523384231\\", \\"measurementsComplete\\": true, \\"originalSourceApiValidateMatched\\": true, \\"productionMutationCommandsInvoked\\": false, \\"publicationQualified\\": false, \\"pureSourceCarriersBound\\": true, \\"readOnlyObservation\\": true, \\"sourceErrorNamespace\\": \\"OOM_FINITE_CANDIDATE\\", \\"twoRuntimeFramesStable\\": true, \\"version\\": 1}\\n",\n  "StandardErrorContent": ""\n}\n', 'bytesSha256': '01bf7acab289e2e4a7a0c82e8783eef54bf971c76a2f0792356a9a7b52d953be', 'sourceSha256': '6e1bd38b3b8978075a8ff04c989eca31c89081290e7fa1c383163f20121171ff', 'parametersSha256': '46d90424d68dd26fbf5f945b07b59cd992de4d9ca3bb97a9a1695c13d2eb558d', 'inputBindingSha256': '3f0e236cea6b772691fd9a6ddfeaabafd798821049d32c9e5da71d3523384231'}
_RESTORED_B_HISTORY_VOLUME = {'name': '20260821t095106z_auto_registration_data', 'status': 'PRESENT', 'identitySha256': 'cc39b3f3777d1e53f9b332994ed22af58fdf15daf72779a482d86272f9eb61e1'}
_RESTORED_B_QUALIFIED_CODE = 'ONLINE_RECHARGE_B_RESTORE_DECLARATION_UNPROVEN'


def _restored_workspace_qualification_call(operation, *, driver=None, caps=None, owner=None, stage='PACKAGE_BIND'):
    """Preserve fixed rejected diagnostics; never grant or weaken qualification."""
    try:
        return operation()
    except Exception as error:
        args = BaseException.args.__get__(error)
        if (len(args) == 1 and type(args[0]) is str
                and re.fullmatch(r'(?:ONLINE_RECHARGE|API_ADMIN)_[A-Z0-9_]+', args[0])):
            raise
        from types import FunctionType, ModuleType
        if caps is None and owner is not None:
            saved = vars(owner).get('_restoredWorkspaceCapabilities')
            if type(saved) is dict:
                caps = saved.get('caps')
        details = None
        qualified = vars(caps).get('qualified') if type(caps) is SimpleNamespace else None
        for module, leaf in ((driver, 'driver.py'), (qualified, 'qualified.py')):
            if type(module) is not ModuleType:
                continue
            namespace = vars(module); getter = namespace.get('failure_diagnostic')
            if (type(getter) is FunctionType and getter.__globals__ is namespace
                    and getter.__name__ == 'failure_diagnostic'
                    and getter.__code__.co_filename == str(Path(__file__).with_name('formal-runtime-package') / leaf)
                    and type(error) is namespace.get('Rejected')):
                try:
                    details = getter(error)
                except Exception:
                    details = None
                # The profile getter has no session annotation: only its exact
                # owned exception class and fixed literal may supply this stage.
                codes = namespace.get('CODES')
                if (details is None and stage == 'SOURCE_PROFILE' and type(codes) is frozenset
                        and len(args) == 1 and type(args[0]) is str and args[0] in codes):
                    details = {'stage': stage, 'code': args[0]}
                if details is not None:
                    break
        if details is None and type(caps) is SimpleNamespace:
            package = vars(caps).get('package')
            stable = vars(type(package)).get('assert_stable')
            if (type(stable) is FunctionType and stable.__code__.co_filename
                    == str(Path(__file__).with_name('formal-runtime-package') / 'package_io.py')):
                namespace = stable.__globals__; codes = namespace.get('CODES')
                if (type(error) is namespace.get('Rejected') and type(codes) is frozenset
                        and len(args) == 1 and type(args[0]) is str and args[0] in codes):
                    details = {'stage': 'PACKAGE_BIND', 'code': args[0]}
        if (type(details) is dict and set(details) == {'stage', 'code'}
                and type(details['stage']) is str and details['stage'] in DECLARATION_DIAGNOSTIC_STAGES
                and type(details['code']) is str and details['code'] in DECLARATION_DIAGNOSTIC_CODES):
            message = 'ONLINE_RECHARGE_DECLARATION_' + details['stage'] + '_' + details['code']
            if len(message) <= 128:
                raise _declaration_driver_failure(message, details) from None
        # Unrecognized classes, attributes and messages remain rejected without
        # being copied into a public diagnostic or replaced by invented evidence.
        raise


def _restored_qualified_capabilities(d):
    """One unchanged source-bound package instance in this controller lifetime."""
    producer=_pending_workspace_producer(d)
    saved=getattr(d,'_restoredWorkspaceCapabilities',None)
    if saved is None:
        driver=_declaration_runtime_driver()
        caps=_restored_workspace_qualification_call(lambda:driver._capabilities(producer),driver=driver)
        profile=_restored_workspace_qualification_call(lambda:fingerprint(caps.qualified._reviewed_profile()),
            caps=caps,stage='SOURCE_PROFILE')
        d._restoredWorkspaceCapabilities={'producer':copy.deepcopy(producer),'caps':caps,'profileSha256':profile}
    else:
        d.require(type(saved) is dict and set(saved)=={'producer','caps','profileSha256'}
            and fingerprint(saved['producer'])==fingerprint(producer),
            _RESTORED_B_QUALIFIED_CODE)
        caps=saved['caps']
    _restored_workspace_qualification_call(caps.package.assert_stable,caps=caps)
    profile=_restored_workspace_qualification_call(lambda:fingerprint(caps.qualified._reviewed_profile()),
        caps=caps,stage='SOURCE_PROFILE')
    d.require(profile==d._restoredWorkspaceCapabilities['profileSha256'],
        _RESTORED_B_QUALIFIED_CODE)
    return caps


def _restored_qualified_exact(d, value, fields):
    d.require(type(value) is dict and set(value)==set(fields),_RESTORED_B_QUALIFIED_CODE)
    return value


def _restored_qualified_hashes(d, value, fields):
    _restored_qualified_exact(d,value,fields)
    d.require(all(_declaration_hash(v) for v in value.values()),_RESTORED_B_QUALIFIED_CODE)
    return value


def _restored_qualified_tools(d, rows, expected, *, native=False, capture=False):
    """Only the original reader's fixed inode tuple schema becomes JSON lists."""
    _restored_qualified_exact(d,rows,expected)
    result=copy.deepcopy(rows)
    for name,row in result.items():
        key='sha256' if native else 'bytesSha256'
        _restored_qualified_exact(d,row,(key,'identity'))
        d.require(row[key]==expected[name],_RESTORED_B_QUALIFIED_CODE)
        identity=_restored_qualified_exact(d,row['identity'],('file','parents'))
        for field,size in (('file',9),):
            value=identity[field]
            d.require(type(value) is (tuple if capture else list) and len(value)==size
                and all(type(v) is int for v in value),_RESTORED_B_QUALIFIED_CODE)
            identity[field]=list(value)
        parents=identity['parents']
        d.require(type(parents) is list and len(parents)==(6 if name.endswith('/docker-compose') else 3),
            _RESTORED_B_QUALIFIED_CODE)
        for i,value in enumerate(parents):
            d.require(type(value) is (tuple if capture else list) and len(value)==5
                and all(type(v) is int for v in value),_RESTORED_B_QUALIFIED_CODE)
            parents[i]=list(value)
        f=identity['file']
        d.require(f[3]==0 and f[8]==1 and stat.S_ISREG(f[2]) and f[2]&0o111
            and f[2]&0o022==0 and f[2]&0o6000==0 and 4<f[5]<=128*1024**2
            and all(v[3]==0 and stat.S_ISDIR(v[2]) and v[2]&0o022==0 for v in parents),
            _RESTORED_B_QUALIFIED_CODE)
    return result


def _restored_qualified_binding(d, q, value):
    """Exact original VFS/listener predicates without their source-file I/O."""
    _restored_qualified_exact(d,value,q.VFS_KEYS)
    d.require(type(value['version']) is int and value['version']==2
        and value['kind']=='DOCKERD_FIXED_UNIX_VFS_BINDING' and value['status']=='VFS_BOUND_TO_RUNTIME_DAEMON'
        and value['unixHost']==q.UNIX_HOST and value['rawOutputSuppressed'] is True
        and all(value[k] is False for k in ('authority','productionEligible','proofConstructed')),
        _RESTORED_B_QUALIFIED_CODE)
    row=_restored_qualified_exact(d,value['vfsBinding'],(*q.VFS_HASHES,'protocol','status'))
    d.require(row['protocol']=='AF_NETLINK_NETLINK_SOCK_DIAG_UNIX_DIAG_VFS'
        and row['status']=='EXACT_VFS_MATCH' and all(_declaration_hash(row[k]) for k in q.VFS_HASHES),
        _RESTORED_B_QUALIFIED_CODE)
    listener=_restored_qualified_exact(d,value['listenerBinding'],q.BINDING_KEYS)
    d.require(type(listener['version']) is int and listener['version']==1
        and listener['kind']=='DOCKERD_FIXED_UNIX_SOCKET_BINDING'
        and listener['status']=='LISTENER_HELD_BY_RUNTIME_DAEMON' and listener['unixHost']==q.UNIX_HOST
        and listener['rawOutputSuppressed'] is True
        and all(listener[k] is False for k in ('authority','productionEligible','proofConstructed'))
        and type(listener['listenerRowCount']) is int and listener['listenerRowCount']==1
        and type(listener['daemonListenerFdCount']) is int and 1<=listener['daemonListenerFdCount']<=8
        and listener['socketActivationCreatorStatus']=='NOT_MEASURED'
        and listener['exclusiveAcceptingProcessStatus']=='NOT_MEASURED'
        and all(_declaration_hash(listener[k]) for k in ('socketNodeSha256','networkNamespaceSha256',
            'listenerSha256','daemonFdSha256','observationSha256')),_RESTORED_B_QUALIFIED_CODE)
    q.IDENTITY.validate_runtime_identity(listener['runtimeIdentity'])
    return listener['runtimeIdentity']


def _restored_qualified_capsule(d, caps, value):
    q=caps.qualified
    q.DERIVE.canonical(value)
    _restored_qualified_exact(d,value,('binding','nativeTools','collectionTools','daemonSha256','profileSha256','rules'))
    profile=q._reviewed_profile()
    d.require(value['profileSha256']==q.REVIEWED_PROFILE_CANONICAL_SHA256==fingerprint(profile)
        and _declaration_hash(value['daemonSha256']),_RESTORED_B_QUALIFIED_CODE)
    expected={'spec':profile['spec'],'rulesSha256':fingerprint(profile['spec']),
        'sourceInputsSha256':fingerprint(profile['sourceInputs']),
        'sourceReviewReportSha256':profile['sourceReviewReportSha256']}
    _restored_qualified_exact(d,value['rules'],expected)
    d.require(value['rules']==expected and fingerprint(value['rules'])==fingerprint(expected),_RESTORED_B_QUALIFIED_CODE)
    runtime=_restored_qualified_binding(d,q,value['binding'])
    _restored_qualified_tools(d,value['nativeTools'],{profile['spec']['dockerPath']:q.DOCKER_SHA,
        profile['spec']['composePath']:q.COMPOSE_SHA},native=True)
    _restored_qualified_tools(d,value['collectionTools'],profile['reviewedCollectionToolSha256'])
    d.require(runtime['runtime']['binarySha256']==profile['dockerdBinarySha256']
        and runtime['runtime']['collectionToolsSha256']==fingerprint(value['collectionTools'])
        and runtime['package']['name']=='docker' and runtime['package']['nevraSha256']==fingerprint(q.RPM)
        and runtime['package']['sourceRpmSha256']==q.sha(q.SRPM_NAME)
        and runtime['package']['fileDigest']==q.DOCKERD_SHA,_RESTORED_B_QUALIFIED_CODE)
    # Original complete pool/flag semantics, using the reviewed immutable row.
    q._Session.pools(SimpleNamespace(profile=profile),
        {'status':profile['spec']['defaultPoolsStatement'],
            'pools':[] if profile['poolMode']=='REVIEWED_BUILTIN_ZERO_INPUTS' else profile['spec']['defaultPools']},runtime)
    return value


def _restored_qualified_capture(d, caps, session):
    q=caps.qualified;s=session._session
    d.require(type(session) is q._AcquiredSession and type(s) is q._Session
        and session.runner is s.runner and s.runner.session is s,_RESTORED_B_QUALIFIED_CODE)
    profile=s.profile
    value={'binding':copy.deepcopy(s.initial_binding),
        'nativeTools':_restored_qualified_tools(d,s.initial_tools,
            {profile['spec']['dockerPath']:q.DOCKER_SHA,profile['spec']['composePath']:q.COMPOSE_SHA},
            native=True,capture=True),
        'collectionTools':_restored_qualified_tools(d,s.initial_collection_tools,
            profile['reviewedCollectionToolSha256'],capture=True),
        'daemonSha256':s.daemon_sha,'profileSha256':s.profile_sha,'rules':session.reviewed_rules()}
    return _restored_qualified_capsule(d,caps,value)


def _restored_qualified_proof(d, caps, value, bridge, services, admin_material):
    """Typed complete result, never an admission from matched/diagnostic bool."""
    caps.qualified.DERIVE.canonical(value)
    fields=('kind','version','purpose','preflightQualificationSha256','preflightBytesSha256',
        'preflightReferenceRegistrySha256','producer','baselineOriginSha256',
        'observationSha256','diagnosticInvocationSha256','sourceSeal','configurationFiles','workspaceFiles',
        'workspaceVolume','stableObservation','sourceFileSeals','qualification','measured','facts','adminMaterialSha256',
        'historicalApiConfigurationSha256','actualApiConfigurationSha256','historicalRawHashMatchClaimed')
    _restored_qualified_exact(d,value,fields)
    d.require(value['kind']=='ONLINE_RECHARGE_B_RESTORED_SOURCE_QUALIFICATION'
        and type(value['version']) is int and value['version']==1
        and value['purpose'] in ('INDEPENDENT_PREFLIGHT','DEPLOYMENT_REMEASURE')
        and (value['preflightQualificationSha256'] is None if value['purpose']=='INDEPENDENT_PREFLIGHT'
            else _declaration_hash(value['preflightQualificationSha256']))
        and all(value[k] is None if value['purpose']=='INDEPENDENT_PREFLIGHT' else _declaration_hash(value[k])
            for k in ('preflightBytesSha256','preflightReferenceRegistrySha256'))
        and value['producer']==_pending_workspace_producer(d)
        and value['baselineOriginSha256']==fingerprint(bridge)
        and value['observationSha256']==_RESTORED_B_WITNESS['policy']['readbackInvocationBytesSha256']
        and value['diagnosticInvocationSha256']==_RESTORED_B_OOM_WITNESS['bytesSha256']
        and value['configurationFiles']==bridge['configurationAfter']
        and value['workspaceVolume']==_RESTORED_B_HISTORY_VOLUME
        and value['adminMaterialSha256']==fingerprint(admin_material)
        and value['historicalApiConfigurationSha256']==bridge['services']['api']['configurationSha256']
        and value['actualApiConfigurationSha256']==services['api']['configurationSha256']
        and value['historicalRawHashMatchClaimed'] is False,_RESTORED_B_QUALIFIED_CODE)
    _restored_qualified_hashes(d,value['workspaceFiles'],caps.reader.WORKSPACE_FILES)
    _restored_qualified_hashes(d,value['configurationFiles'],caps.reader.CONFIG_FILES)
    volume=_restored_qualified_exact(d,value['workspaceVolume'],('name','status','identitySha256'))
    d.require(type(volume['name']) is str and volume['status']=='PRESENT' and _declaration_hash(volume['identitySha256'])
        and fingerprint(volume)==fingerprint(_RESTORED_B_HISTORY_VOLUME),_RESTORED_B_QUALIFIED_CODE)
    d.require(all(value['workspaceFiles'][name]==bridge[key] for name,key in (
        ('release-manifest.json','manifestBytesSha256'),('api-workspace-preservation.json','recordBytesSha256'),
        ('api-workspace-build-proof.json','buildProofBytesSha256'))),_RESTORED_B_QUALIFIED_CODE)
    seal=_restored_qualified_exact(d,value['sourceSeal'],caps.reader.SEAL_KEYS)
    d.require(seal['baselineCommit']==caps.reader.INVENTORY.BASELINE
        and seal['directory']==bridge['baselineRelease'] and seal['files']=={
            'docker-compose.aws-mysql.yml':bridge['configurationAfter']['docker-compose.aws-mysql.yml'],
            'compose.release.json':bridge['configurationAfter']['compose.release.json'],
            '.env.aws.production':bridge['environmentFileSha256']}
        and seal['servicesSha256']==fingerprint(services)
        and seal['stabilitySha256']==fingerprint(value['stableObservation']),_RESTORED_B_QUALIFIED_CODE)
    anchors=_restored_qualified_exact(d,seal['replaceAnchors'],('candidateAfterContainerId','stableName'))
    d.require(anchors['candidateAfterContainerId']==bridge['services']['api']['containerId']
        and type(anchors['stableName']) is str and caps.reader.NAME.fullmatch(anchors['stableName']),
        _RESTORED_B_QUALIFIED_CODE)
    stable=_restored_qualified_hashes(d,value['stableObservation'],
        ('snapshotSha256','sourceFilesSha256','workspaceVolumeSha256','actualResourceSha256'))
    d.require(stable['snapshotSha256']==fingerprint(services)
        and stable['sourceFilesSha256']==fingerprint({'configurationFiles':seal['files'],
            'workspaceFiles':value['workspaceFiles']})
        and stable['workspaceVolumeSha256']==fingerprint(value['workspaceVolume']),_RESTORED_B_QUALIFIED_CODE)
    capsule=_restored_qualified_capsule(d,caps,value['qualification'])
    seals=_restored_qualified_exact(d,value['sourceFileSeals'],caps.reader.SOURCE_FILES)
    for name,row in seals.items():
        _restored_qualified_hashes(d,row,('sha256','identitySha256'))
        d.require(row['sha256']==seal['files'][name],_RESTORED_B_QUALIFIED_CODE)
    c=caps.constructor;m=_restored_qualified_exact(d,value['measured'],c.MEASURED_KEYS)
    f=_restored_qualified_exact(d,value['facts'],c.FACT_KEYS)
    d.require(m['matched'] is True and m['reason']=='COMPLETE_EQUAL'
        and m['status']=='CONTROL_ONLY_DECLARATION_MEASURED'
        and all(m[k] is False for k in ('historicalRawHashMatchClaimed','authority','productionEligible'))
        and all(_declaration_hash(v) for k,v in m.items() if k.endswith('Sha256'))
        and m['actualRawConfigurationSha256']==services['api']['configurationSha256']
        and m['actualDeclarationNormalizedSha256']==m['referenceDeclarationNormalizedSha256']
        and m['actualResourceSha256']==stable['actualResourceSha256']
        and m['sourceUnchangedBeforeAndAfter'] is True and m['referenceNeverStarted'] is True,
        _RESTORED_B_QUALIFIED_CODE)
    d.require(type(f['version']) is int and f['version']==1 and f['formalTableSha256']==c.FORMAL_TABLE_SHA
        and f['sourceFileSealsSha256']==m['sourceFileSealsSha256']==fingerprint(seals)
        and f['generator']=={'engineVersion':'25.0.16','composeVersion':'5.5.0',
            'rulesSha256':capsule['rules']['rulesSha256']}
        and f['stableBefore']==f['stableAfter']==stable,_RESTORED_B_QUALIFIED_CODE)
    source=_restored_qualified_hashes(d,f['source'],c.SOURCE_FACT_KEYS)
    d.require(source['normalizedModelSha256']!=m['referenceModelSha256']
        and source['expectedEnvironmentSha256']==services['api']['environmentSha256'],_RESTORED_B_QUALIFIED_CODE)
    owner=c.registry(f['referenceRegistry'])
    d.require(fingerprint(c.adapter42_registered(f['referenceRegistry']))==m['referenceResourceSha256'],
        _RESTORED_B_QUALIFIED_CODE)
    inputs=_restored_qualified_hashes(d,f['referenceInputs'],c.INPUT_KEYS)
    d.require(inputs['modelCanonicalSha256']==m['referenceModelSha256']
        and inputs['surrogateEnvironmentSha256']==source['referenceEnvironmentSha256']
        and inputs['emptyEnvironmentBytesSha256']==hashlib.sha256(b'').hexdigest()
        and inputs['emptyDockerConfigBytesSha256']==hashlib.sha256(b'{}\n').hexdigest()
        and inputs['beforeFileSealsSha256']==inputs['afterFileSealsSha256'],_RESTORED_B_QUALIFIED_CODE)
    cleanup=_restored_qualified_exact(d,m['cleanup'],('ownedContainersRemaining','ownedNetworksRemaining',
        'ownedVolumesRemaining','exactOwnerCreationSealsVerified','existingResourcesMutated'))
    d.require(all(type(cleanup[k]) is int and cleanup[k]==0 for k in ('ownedContainersRemaining',
        'ownedNetworksRemaining','ownedVolumesRemaining')) and cleanup['exactOwnerCreationSealsVerified'] is True
        and cleanup['existingResourcesMutated'] is False
        and f['referenceRegistry']['container']['id'] not in {r['containerId'] for r in services.values()}
        and f['referenceRegistry']['volume']['name']!=value['workspaceVolume']['name'],_RESTORED_B_QUALIFIED_CODE)
    return owner


def _restored_qualified_pair(d,caps,first,second,bridge,services,admin_material):
    owners=[_restored_qualified_proof(d,caps,v,bridge,services,admin_material) for v in (first,second)]
    def semantic(v):
        # Every omitted value is validated above in its UUID-specific round.
        qualification=copy.deepcopy(v['qualification'])
        listener=qualification['binding']['listenerBinding']
        # These exact two complete hashes stay in BOTH sealed round capsules.
        # b4ca705b listener.proc_namespace proves collector namespace==daemon
        # namespace; cba4b373 VFS+02fe3e qualified original successful session
        # bind the observation to that round's different collector PID. Neither
        # raw namespace nor an old hash is fabricated. All other fields compare.
        del listener['networkNamespaceSha256'];del listener['observationSha256']
        return {'qualification':qualification,**{k:v[k] for k in ('producer','baselineOriginSha256','observationSha256','diagnosticInvocationSha256',
            'sourceSeal','configurationFiles','workspaceFiles','workspaceVolume','stableObservation','sourceFileSeals',
            'adminMaterialSha256','historicalApiConfigurationSha256','actualApiConfigurationSha256',
            'historicalRawHashMatchClaimed')},
            'measured':{k:v['measured'][k] for k in ('actualRawConfigurationSha256','actualDeclarationNormalizedSha256',
                'referenceDeclarationNormalizedSha256','actualResourceSha256','sourceFileSealsSha256')},
            'facts':{k:v['facts'][k] for k in ('version','formalTableSha256','sourceFileSealsSha256','generator',
                'source','stableBefore','stableAfter')}}
    a,b=(v['facts']['referenceRegistry'] for v in (first,second))
    d.require(first['purpose']=='INDEPENDENT_PREFLIGHT' and second['purpose']=='DEPLOYMENT_REMEASURE'
        and second['preflightQualificationSha256']==fingerprint(first) and semantic(first)==semantic(second)
        and type(getattr(d,'_restoredWorkspacePreflightRaw',None)) is bytes
        and second['preflightBytesSha256']==hashlib.sha256(d._restoredWorkspacePreflightRaw).hexdigest()
        and second['preflightReferenceRegistrySha256']==fingerprint(first['facts']['referenceRegistry'])
        and len(set(owners))==2 and a['container']['id']!=b['container']['id']
        and a['volume']['name']!=b['volume']['name']
        and not({r['id'] for r in a['networks'].values()} & {r['id'] for r in b['networks'].values()}),
        _RESTORED_B_QUALIFIED_CODE)


def _restored_qualified_measure(d,previous,bridge,services,admin_material,*,first=None):
    """One original owned acquisition lifetime; no raw inspect persistence."""
    driver=_declaration_runtime_driver();producer=_pending_workspace_producer(d)
    caps=_restored_qualified_capabilities(d)
    d.require(os.geteuid()==0 and (d.BASE/'current').resolve()==previous==Path(bridge['baselineRelease'])
        and snapshot(d,previous)==services,_RESTORED_B_QUALIFIED_CODE)
    with caps.qualified.acquisition_session(driver._ArchiveBoundController(d,caps)) as session:
        runner=driver._SourceReadDriver(session.runner);session.assert_stable();caps.package.assert_stable()
        before_capsule=_restored_qualified_capture(d,caps,session)
        files=caps.reader.files(previous,tuple(dict.fromkeys((*caps.reader.CONFIG_FILES,
            *caps.reader.SOURCE_FILES,*caps.reader.WORKSPACE_FILES))),0)
        seals={n:{'sha256':files[n]['sha256'],'identitySha256':fingerprint({
            k:files[n]['identity'][k] for k in ('device','inode','uid','gid','mode','size','links')})}
            for n in caps.reader.SOURCE_FILES}
        configuration=configuration_hashes(previous);workspace=workspace_files(runner,previous)
        source={n:files[n]['sha256'] for n in caps.reader.SOURCE_FILES}
        d.require(configuration==bridge['configurationAfter'] and all(workspace[name]==bridge[key] for name,key in (
            ('release-manifest.json','manifestBytesSha256'),('api-workspace-preservation.json','recordBytesSha256'),
            ('api-workspace-build-proof.json','buildProofBytesSha256'))),
            _RESTORED_B_QUALIFIED_CODE)
        api=driver._inspect(caps.reader,runner,'docker','inspect',services['api']['containerId'])
        project=api['Config']['Labels']['com.docker.compose.project']
        d.require(type(project) is str and caps.reader.NAME.fullmatch(project),_RESTORED_B_QUALIFIED_CODE)
        endpoints=api['NetworkSettings']['Networks']
        d.require(set(endpoints)=={project+'_'+r for r in caps.reader.INVENTORY.NETWORK_ROLES},
            _RESTORED_B_QUALIFIED_CODE)
        networks={r:driver._inspect(caps.reader,runner,'docker','network','inspect',
            endpoints[project+'_'+r]['NetworkID']) for r in caps.reader.INVENTORY.NETWORK_ROLES}
        volume=driver._inspect(caps.reader,runner,'docker','volume','inspect',project+'_'+caps.reader.WORKSPACE['WORKSPACE_VOLUME'])
        summary=caps.workspace.workspace_volume(runner,previous,attached=True,api_metadata=api)
        d.require(summary==caps.reader.volume_summary(volume)==_RESTORED_B_HISTORY_VOLUME,_RESTORED_B_QUALIFIED_CODE)
        raw={'snapshot':services,'sourceFiles':{'configurationFiles':source,'workspaceFiles':workspace},
            'workspaceVolume':volume,'actualResource':{'networks':networks,'volume':volume}}
        stable=caps.reader.DERIVE.observation(raw,services,source,raw['actualResource'])
        seal={'baselineCommit':driver.BASELINE,'directory':str(previous),'files':source,
            'servicesSha256':fingerprint(services),'stabilitySha256':fingerprint(stable),
            'replaceAnchors':{'candidateAfterContainerId':bridge['services']['api']['containerId'],
                'stableName':api['Name'].lstrip('/')}}
        callback=caps.reader.make_reader(runner,previous,source_seal=seal,services=services,
            configuration=configuration,workspace_files=workspace,workspace_volume=summary)
        d.require(callback()==raw,_RESTORED_B_QUALIFIED_CODE)
        d.require((d.BASE/'current').resolve()==previous,_RESTORED_B_QUALIFIED_CODE)
        result=session.measure(previous,services=services,image_reference=services['api']['reference'],
            image_id=services['api']['image'],source_seal=seal,stability_reader=callback)
        _restored_qualified_exact(d,result,('measured','facts'))
        d.require(callback()==raw and snapshot(d,previous)==services and (d.BASE/'current').resolve()==previous,
            _RESTORED_B_QUALIFIED_CODE)
        # Admin is not the API reference model: preserve its strict old full proof.
        admin=driver._inspect(caps.reader,runner,'docker','inspect',services['admin']['containerId'])
        old=closed_recovery_json(d,_declaration_source_bytes(previous/caps.workspace.STATE_FILE))
        repeated=_restore_cfg_complete_configuration_material('admin',admin,services['admin'],bridge['services']['admin'],
            original_before_container_id=old['before']['admin']['containerId'],
            acquired_actual_replace_anchors=[bridge['services']['admin']['containerId']])
        d.require(repeated==admin_material,_RESTORED_B_QUALIFIED_CODE)
        session.assert_stable();caps.package.assert_stable()
        capsule=_restored_qualified_capture(d,caps,session)
        d.require(capsule==before_capsule,_RESTORED_B_QUALIFIED_CODE)
        proof={'kind':'ONLINE_RECHARGE_B_RESTORED_SOURCE_QUALIFICATION','version':1,
            'purpose':'INDEPENDENT_PREFLIGHT' if first is None else 'DEPLOYMENT_REMEASURE',
            'preflightQualificationSha256':None if first is None else fingerprint(first),'producer':producer,
            'preflightBytesSha256':None if first is None else hashlib.sha256(d._restoredWorkspacePreflightRaw).hexdigest(),
            'preflightReferenceRegistrySha256':None if first is None else fingerprint(first['facts']['referenceRegistry']),
            'baselineOriginSha256':fingerprint(bridge),
            'observationSha256':_RESTORED_B_WITNESS['policy']['readbackInvocationBytesSha256'],
            'diagnosticInvocationSha256':_RESTORED_B_OOM_WITNESS['bytesSha256'],
            'sourceSeal':seal,'configurationFiles':configuration,'workspaceFiles':workspace,'workspaceVolume':summary,
            'stableObservation':stable,'sourceFileSeals':seals,'qualification':capsule,'measured':copy.deepcopy(result['measured']),
            'facts':copy.deepcopy(result['facts']),'adminMaterialSha256':fingerprint(admin_material),
            'historicalApiConfigurationSha256':bridge['services']['api']['configurationSha256'],
            'actualApiConfigurationSha256':services['api']['configurationSha256'],'historicalRawHashMatchClaimed':False}
        _restored_qualified_proof(d,caps,proof,bridge,services,admin_material)
        d.require(not({r['id'] for r in proof['facts']['referenceRegistry']['networks'].values()}
            & {r['Id'] for r in networks.values()}),_RESTORED_B_QUALIFIED_CODE)
        if first is not None:_restored_qualified_pair(d,caps,first,proof,bridge,services,admin_material)
    # Successful original session final stability+cleanup is mandatory before issuance.
    caps.package.assert_stable()
    return proof


def _restored_qualified_oom_history(d,observed):
    witness=_RESTORED_B_OOM_WITNESS
    _restored_qualified_exact(d,witness,('raw','bytesSha256','sourceSha256','parametersSha256','inputBindingSha256'))
    d.require(type(witness['raw']) is str and hashlib.sha256(witness['raw'].encode()).hexdigest()==witness['bytesSha256']
        and witness['bytesSha256']=='01bf7acab289e2e4a7a0c82e8783eef54bf971c76a2f0792356a9a7b52d953be'
        and witness['sourceSha256']=='6e1bd38b3b8978075a8ff04c989eca31c89081290e7fa1c383163f20121171ff'
        and witness['parametersSha256']=='46d90424d68dd26fbf5f945b07b59cd992de4d9ca3bb97a9a1695c13d2eb558d',
        _RESTORED_B_QUALIFIED_CODE)
    q=closed_recovery_json(d,witness['raw'].encode());body=closed_recovery_json(d,q['StandardOutputContent'].encode())
    d.require(q['CommandId']=='0a3d27f7-9d86-400c-9c8e-c578cbca3342' and q['InstanceId']=='i-05836da38606e633c'
        and q['Status']=='Success' and type(q['ResponseCode']) is int and q['ResponseCode']==0
        and q['ExecutionStartDateTime']=='2026-10-11T19:43:11.831Z'
        and q['ExecutionEndDateTime']=='2026-10-11T19:43:14.831Z'
        and hashlib.sha256(q['StandardOutputContent'].encode()).hexdigest()=='77cba24803b4e766dd53edc991b842c9dbacfec28e05aeba9c078c0ec358e6ac'
        and body['inputBindingSha256']==witness['inputBindingSha256']=='3f0e236cea6b772691fd9a6ddfeaabafd798821049d32c9e5da71d3523384231'
        and all(body[k] is False for k in ('databaseFreshlyMeasured','formalConfigurationMaterialMeasured',
            'productionMutationCommandsInvoked','publicationQualified'))
        and all(body['diagnosticPredicates'][n]['currentCompleteConfigurationSha256']==
            observed['currentServices'][n]['configurationSha256'] for n in ('api','admin')),
        _RESTORED_B_QUALIFIED_CODE)
    return witness['bytesSha256']

"""Only restored-B complete receipts use bounded framing; old output is exact."""


def _restored_wire_need(condition):
    if not condition:raise RuntimeError('ONLINE_RECHARGE_B_RESTORED_WIRE_INVALID')


def _restored_wire_json(raw):
    _restored_wire_need(type(raw) in (str,bytes) and 0<len(raw)<65536)
    def pairs(items):
        value={}
        for key,item in items:
            _restored_wire_need(key not in value);value[key]=item
        return value
    value=json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda unused:_restored_wire_need(False))
    _restored_wire_need(type(value) is dict)
    return value


def _restored_wire_selected(value):
    if type(value) is not dict or 'afterBitRestoration' not in value:return False
    side=value['afterBitRestoration'];origin=value.get('onlineAfterBitOrigin')
    _restored_wire_need(type(origin) is dict and origin.get('kind')=='ONLINE_RECHARGE_AFTER_BIT_SUCCESSOR_ORIGIN'
        and origin.get('baselineCommit')=='31d2c6885a45817cd40d23fce8d6145bc9f18af2'
        and type(side) is dict and side.get('kind')=='ONLINE_RECHARGE_B_RESTORE_COMPLETE_MATERIAL'
        and type(side.get('version')) is int and side['version']==2 and side.get('publicationQualified') is False
        and type(side.get('apiDeclarationQualification')) is dict
        and side['apiDeclarationQualification'].get('kind')=='ONLINE_RECHARGE_B_RESTORED_SOURCE_QUALIFICATION')
    return True


def _restored_wire_encode(value):
    if not _restored_wire_selected(value):return value
    import gzip,base64
    raw=json.dumps(value,separators=(',',':'),allow_nan=False).encode()
    _restored_wire_json(raw)
    envelope={'kind':'ONLINE_RECHARGE_B_RESTORED_RECEIPT','version':1,'encoding':'gzip-base64',
        'decodedLength':len(raw),'decodedSha256':hashlib.sha256(raw).hexdigest(),
        'payload':base64.b64encode(gzip.compress(raw,compresslevel=9,mtime=0)).decode('ascii')}
    _restored_wire_need(len(json.dumps(envelope).encode())+1<24000)
    return envelope


def _restored_wire_decode(output):
    import base64,zlib
    _restored_wire_need(type(output) is str and 0<len(output.encode())<24000)
    value=_restored_wire_json(output)
    _restored_wire_need(set(value)=={'kind','version','encoding','decodedLength','decodedSha256','payload'}
        and value['kind']=='ONLINE_RECHARGE_B_RESTORED_RECEIPT'
        and type(value['version']) is int and value['version']==1 and value['encoding']=='gzip-base64'
        and type(value['decodedLength']) is int and 0<value['decodedLength']<65536
        and type(value['decodedSha256']) is str and re.fullmatch('[a-f0-9]{64}',value['decodedSha256'])
        and type(value['payload']) is str and value['payload'].isascii() and 0<len(value['payload'])<24000)
    packed=base64.b64decode(value['payload'],validate=True)
    _restored_wire_need(base64.b64encode(packed).decode('ascii')==value['payload'])
    inflater=zlib.decompressobj(31);raw=inflater.decompress(packed,65536)
    _restored_wire_need(0<len(raw)<65536 and len(raw)==value['decodedLength']
        and hashlib.sha256(raw).hexdigest()==value['decodedSha256'] and inflater.eof
        and not inflater.unused_data and not inflater.unconsumed_tail)
    decoded=_restored_wire_json(raw)
    _restored_wire_need(_restored_wire_selected(decoded) and decoded.get('kind')!='ONLINE_RECHARGE_B_RESTORED_RECEIPT')
    return decoded


def _restored_workspace_f_value(d,raw):
    value=closed_recovery_json(d,raw)
    if value.get('version')==3:
        d.require(type(value['version']) is int and value.get('kind')=='ONLINE_RECHARGE_AFTER_BIT_PREFLIGHT',
            'ONLINE_RECHARGE_B_RESTORED_WIRE_INVALID')
        value={**value,'ordinaryPreflight':_restored_wire_decode(json.dumps(value['ordinaryPreflight']))}
        d.require(value['ordinaryPreflight'].get('afterBitRestoration')==value.get('restoration'),
            'ONLINE_RECHARGE_B_RESTORED_WIRE_INVALID')
    return value

"""Append-only helper bodies for the four-file ONLINE recovery path draft.

The generated candidate wires these helpers into the existing ONLINE overrides.
Original API504 and the fourteen ordinary first-stage bodies remain unchanged.
This file itself grants no native invocation, deployment or restored admission.
"""

_RESTORED_B_WITNESS = {'policy': {'kind': 'ONLINE_RECHARGE_B_RESTORE_FINITE_OBSERVATION', 'version': 1, 'baselineBridgeSha256': '4b81b0d398de0c4b0198803950354c286f7107a8a19b99e519d5404007b0c1ca', 'originalBootStartedAt': '2026-10-11T13:37:28.606112575Z', 'failedProducer': {'commit': '08419dcbe85212a203906c86c98e5c3ae0695d72', 'sourceTree': 'b6fd81cc0c94a8e5971c5df8b2570716a13fa042', 'workflowRunId': '38160127343', 'workflowRunAttempt': '1'}, 'failedCommandId': 'c03fdc8a-9f39-40e5-8181-0071b3bc8f89', 'failedNativeEnd': '2026-10-11T17:58:11.942Z', 'failedRelease': '/opt/id-business-v2/releases/20261011T174625Z-08419dcbe852', 'failureCanonicalSha256': '11ebbf13b670afc207ab6268b297293e99792aadd625276acd05003c987a8bae', 'failedPreflightBytesSha256': 'aba6144845be3836c4fe56a1def9a755018634f26710b8d17ec74b2d2660c4db', 'failedBuildProofSha256': 'eaa990d402ef921c816c561de4d2b2f1aee7a554ac30fa284fc079293f8a7483', 'failedSourceHelpers': {'scripts/production-release/api-admin-scope.py': '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925', 'scripts/production-release/online-recharge-scope.py': '93992e3258c015bcf1f1b9943fa9cd37149e995748433988cc4d1367d4f1b5d8', 'scripts/production-release/remote-deploy.py': '889aedb75bbcb53863a55dc2a4c40a84e06dea1d64d493f6a4fca6dc233f855c'}, 'instanceId': 'i-05836da38606e633c', 'readbackCommandId': '5c5827d6-b67d-4e84-acec-75e102534d14', 'readbackInvocationBytesSha256': '593476978b87c2fda0a69f9df08d27550524e918a38ff6a603c6a33f5f7b5231', 'readbackBodySha256': 'e630d1917b4d32865649f22e5c9a87c24b3fa27ca5e925912d53a06fa644389c', 'readbackInputBindingSha256': 'f7ca11611426a8283872f43accdc056f4b01506515d67bd88b58d0f30d4f1dfc'}, 'observationInvocation': '{"CloudWatchOutputConfig":{"CloudWatchLogGroupName":"","CloudWatchOutputEnabled":false},"CommandId":"5c5827d6-b67d-4e84-acec-75e102534d14","Comment":"ID root readonly recovery observation 38160127343 v3 precise source bounds","DocumentName":"AWS-RunShellScript","DocumentVersion":"$DEFAULT","ExecutionElapsedTime":"PT6.534S","ExecutionEndDateTime":"2026-10-11T18:44:51.880Z","ExecutionStartDateTime":"2026-10-11T18:44:45.880Z","InstanceId":"i-05836da38606e633c","PluginName":"aws:runShellScript","ResponseCode":0,"StandardErrorContent":"","StandardErrorUrl":"","StandardOutputContent":"{\\"apiAdminImageReferenceEnvironmentContentMatchesOriginal\\":true,\\"apiAdminRuntimeConfigurationProof\\":{\\"formalConfigurationQualificationMeasured\\":false,\\"services\\":{\\"admin\\":{\\"completeConfigurationSha256\\":\\"dcc6ae6ce35fb2771b9f14e8ae2191d68cba9a4e32c98cf6a46257687ce8fe00\\",\\"configSha256\\":\\"f426d3db677db193d604faabdf46200db1cc134fe3b6e37925bbd110c8343f5c\\",\\"destinationSortedMountsSha256\\":\\"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945\\",\\"hostConfigSha256\\":\\"e6c9300ac7256d92422bfda869f12d565de48b3b0b009bde7b3b47556221d0f0\\",\\"mountCount\\":0},\\"api\\":{\\"completeConfigurationSha256\\":\\"394d782259b5384f071204bc9232fa88778a4f2d668384ebbd8a68fe27ebc0b8\\",\\"configSha256\\":\\"85fa58b5118b426ae13d4d78474aa97331e2d0cd7f5351a489df2b064a586c70\\",\\"destinationSortedMountsSha256\\":\\"c5455f18bda298aa776a83b898709421838c70452e8df5b3b204b8e31a2a5a6d\\",\\"hostConfigSha256\\":\\"542c591a4a49212a1876ef0aaf1a8bef801f1c646d05434eae975b1ef9f897e2\\",\\"mountCount\\":1}}},\\"apiCurrentStartedAt\\":\\"2026-10-11T17:56:28.727522656Z\\",\\"apiCurrentStartedAtSha256\\":\\"4da45a6e44d66105e94098ad93143bc6f162c0869251ad1de342d89e6ac269ca\\",\\"currentIsOriginalB\\":true,\\"currentPointerStable\\":true,\\"currentServices\\":{\\"admin\\":{\\"configurationSha256\\":\\"dcc6ae6ce35fb2771b9f14e8ae2191d68cba9a4e32c98cf6a46257687ce8fe00\\",\\"containerId\\":\\"bddd1b41836c082273f95f4559caffe4a91b65f092bdc4f32b6ab95e8351ac47\\",\\"environmentSha256\\":\\"03ddab553858482dcbcc4a93d989902d31b41753eb155fb8162011e218bc0ad4\\",\\"health\\":\\"healthy\\",\\"image\\":\\"sha256:f3a6b231e914f087722b87f704b7583f93ba0a462444afe6a0b68e8580917eab\\",\\"reference\\":\\"079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:31d2c6885a45817cd40d23fce8d6145bc9f18af2-38142818370-1-admin\\",\\"startedAtSha256\\":\\"76d073e207e21d2ba7ae771edb45a9349f8be1677fcf9064c2060c822d576048\\",\\"status\\":\\"running\\"},\\"api\\":{\\"configurationSha256\\":\\"394d782259b5384f071204bc9232fa88778a4f2d668384ebbd8a68fe27ebc0b8\\",\\"containerId\\":\\"cfaf13170d1f631583747dd4daa5bcf7185c017039f3ebe4683a6bc7f3d3dec4\\",\\"environmentSha256\\":\\"9f88452817b9343fb1751d8bfbee6e70b82d4098be9ee5034d9b3dbfc80d705c\\",\\"health\\":\\"healthy\\",\\"image\\":\\"sha256:74c28d510a434d599b86188ec7a38d5830b1a4e39b615d92b960963c14aac379\\",\\"reference\\":\\"079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:31d2c6885a45817cd40d23fce8d6145bc9f18af2-38142818370-1-api\\",\\"startedAtSha256\\":\\"4da45a6e44d66105e94098ad93143bc6f162c0869251ad1de342d89e6ac269ca\\",\\"status\\":\\"running\\"},\\"auto-recharge\\":{\\"configurationSha256\\":\\"1c341043b62969f855cc1f5852181c949b8ea7831f8c82f15cd7364ee7767120\\",\\"containerId\\":\\"0190045c800bd6cda576b66ccce0986de6792390d01cf19fe19e02cd16316f97\\",\\"environmentSha256\\":\\"5169582dea47a65076d5f7a3a3defbc824fa4f772b2dc0904eb64659209757ae\\",\\"health\\":\\"healthy\\",\\"image\\":\\"sha256:5bd2ab25ebcadcd99f8d339d604e0268cec3fc2cfdac54e2a215f085e3fac00e\\",\\"reference\\":\\"079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:04570d75c779fd91a0933ef9416f6d62698b6b91-37694009463-1-auto-recharge\\",\\"startedAtSha256\\":\\"b54ae0f7bbf6ae90e14b78e4d86fa39ae8d5fef49c5f3a95cd4bd811e3645eda\\",\\"status\\":\\"running\\"},\\"auto-registration\\":{\\"configurationSha256\\":\\"0da1fad093493de7997af6d9c2c855e1e4272711eb63a3a0f36f4a3fea1fb0c8\\",\\"containerId\\":\\"16de5229289255cd47c3f9336e24aa611c0f9bbc76af2fcdfc5e5e1928d68add\\",\\"environmentSha256\\":\\"de69bd06209b17619f8cb7ae38bace36c27dc4203c67e09fd1b8d21023fbcb17\\",\\"health\\":\\"healthy\\",\\"image\\":\\"sha256:759f60543c2fc5661c5d21644fdc1e9cb0e5cb39c930e9c400f869e0c72be568\\",\\"reference\\":\\"079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:18e23ee1ab1a8d5c988ff6ba24149e1c741d62f8-37788833835-1-auto-recharge\\",\\"startedAtSha256\\":\\"463587855c649edc70eb7ce82744c1caf57a49d7fbbfb10206bf1531443bb229\\",\\"status\\":\\"running\\"},\\"caddy\\":{\\"configurationSha256\\":\\"3662db0efe0d9d7854a52da2c4fe71e626ebc9a122d9c2da76ed497b403815a0\\",\\"containerId\\":\\"0ee2a1ea26eec74fef64362fd77a69894e3dc4dddd412c38ebd59c747aa6e203\\",\\"environmentSha256\\":\\"33ea62b4e1f4de93e333bdbbea4ec88904661f1cb616907b185fce31b22b7181\\",\\"health\\":null,\\"image\\":\\"sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510\\",\\"reference\\":\\"caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d\\",\\"startedAtSha256\\":\\"8c855d6048304bfcba4e29cbde6443070cdbbf778fe722648b491c763f285d24\\",\\"status\\":\\"running\\"},\\"media-resolver\\":{\\"configurationSha256\\":\\"88cfc4c67adc0d0fe78e5434d8c1ebfcaeaef7e2726f3f2b30b0d4c85e0c70cb\\",\\"containerId\\":\\"0c4fd25ba8fbf2fdab7639e680c3a3433d814cdb2d71ebd7ad39531aaa639471\\",\\"environmentSha256\\":\\"8473962ae5df6f8e5553ab658ccce662a8816f83631b221484daf5fa42e3b163\\",\\"health\\":\\"healthy\\",\\"image\\":\\"sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56\\",\\"reference\\":\\"079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver\\",\\"startedAtSha256\\":\\"8814f073adf9a0964f3beaf17b261fea765db8d0059e2425ee39fe0afdf31d1f\\",\\"status\\":\\"running\\"},\\"mysql\\":{\\"configurationSha256\\":\\"47f62efcca224ee71466bf71a0337d791b9f6d8b42b024208cc3a29c6585beaf\\",\\"containerId\\":\\"7e5a5abe42c5503e6196f736d532793aaec3796b7eb518f02db614d4025d0074\\",\\"environmentSha256\\":\\"bb8d63d18769016c14d8664a551d2b3da9e251701ed62f87b04cba964fc9e299\\",\\"health\\":\\"healthy\\",\\"image\\":\\"sha256:bced325a4ab7aec848f4688371c7433351dcb5dba26fbcc29c67727d898ae5cb\\",\\"reference\\":\\"mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb\\",\\"startedAtSha256\\":\\"de8aff8d3d7634b524828ded3df29bba37d7ef4cf817deff61402fdfcf767ec7\\",\\"status\\":\\"running\\"}},\\"databaseFreshlyMeasured\\":false,\\"deadlineExceeded\\":false,\\"disk\\":{\\"aboveSixGiB\\":false,\\"aboveTenGiB\\":false,\\"freeBytes\\":2698186752,\\"totalBytes\\":68639764480},\\"failedTarget\\":{\\"actualReleasePath\\":\\"/opt/id-business-v2/releases/20261011T174625Z-08419dcbe852\\",\\"candidateManifest\\":{\\"exists\\":false,\\"fileSha256\\":\\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\\"},\\"candidateProof\\":{\\"exists\\":false,\\"fileSha256\\":\\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\\"},\\"canonicalMatchingDirectoryCount\\":1,\\"directoryReadErrorCount\\":0,\\"eligibleDirectoryCount\\":1,\\"failureCanonicalSha256\\":\\"11ebbf13b670afc207ab6268b297293e99792aadd625276acd05003c987a8bae\\",\\"failureReceiptSha256\\":\\"a1174623f13b3801b8fbea6b03387b03531f8164755a34fb785561006193d160\\",\\"onlineProtectionRecord\\":{\\"exists\\":false,\\"fileSha256\\":\\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\\"},\\"sourceHelpersSha256\\":{\\"scripts/production-release/api-admin-scope.py\\":\\"50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925\\",\\"scripts/production-release/online-recharge-scope.py\\":\\"93992e3258c015bcf1f1b9943fa9cd37149e995748433988cc4d1367d4f1b5d8\\",\\"scripts/production-release/remote-deploy.py\\":\\"889aedb75bbcb53863a55dc2a4c40a84e06dea1d64d493f6a4fca6dc233f855c\\"},\\"sqliteProtection\\":{\\"backupBytes\\":61440,\\"boundReceiptObserved\\":true,\\"exists\\":true,\\"fileSha256\\":\\"c5f35e921ef44ab01cbe327d019a857f05456b1d3a76ee4e1684055a7ad45445\\",\\"maintenanceSha256\\":\\"d7cd87a94c708125356c61b3ef083a643ab66a6b24aa448a7027db28fb021a30\\",\\"receiptCanonicalSha256\\":\\"d95becc7e692f09d940b60021b4bd7d4a2bd8dd16ebe1ca52b38005d9be6b827\\"},\\"targetDirectorySha256\\":\\"a48665a80da2ea143ca612041957ebeb0aeaeb0b3dc6e6d297e3c905b62f6ef4\\",\\"targetSourceBound\\":true,\\"uniqueTargetKnown\\":true},\\"inputBindingSha256\\":\\"f7ca11611426a8283872f43accdc056f4b01506515d67bd88b58d0f30d4f1dfc\\",\\"measurementsComplete\\":true,\\"nativeGrantSyncReached\\":true,\\"nativeMigrationAttempted\\":false,\\"originalEnvironmentAndConfigurationFilesMatch\\":true,\\"originalManifestBytesMatch\\":true,\\"originalManifestNewMigrationCount\\":0,\\"originalStoppedApiObservation\\":{\\"identityMatchesOriginal\\":false,\\"metadataAvailable\\":false,\\"stoppedPidZeroObserved\\":false},\\"preservedFullIdentityCount\\":5,\\"productionMutationCommandsInvoked\\":false,\\"publicationQualified\\":false,\\"readOnlyObservation\\":true,\\"runtimeContentMatchesOriginal\\":{\\"admin\\":true,\\"api\\":true},\\"services\\":{\\"admin\\":{\\"containerIdentityChanged\\":true,\\"currentConfigurationSha256\\":\\"dcc6ae6ce35fb2771b9f14e8ae2191d68cba9a4e32c98cf6a46257687ce8fe00\\",\\"currentIdentitySha256\\":\\"2c28c50bdda4d3e7aac18511494d2ef4ee5bbcff1c9dfb34ec368d33700d6285\\",\\"environmentMatchesOriginal\\":true,\\"fullConfigurationMatchesOriginal\\":false,\\"fullIdentityMatchesOriginal\\":false,\\"healthyRunning\\":true,\\"imageAndReferenceMatchOriginal\\":true,\\"startedIdentityChanged\\":true},\\"api\\":{\\"containerIdentityChanged\\":true,\\"currentConfigurationSha256\\":\\"394d782259b5384f071204bc9232fa88778a4f2d668384ebbd8a68fe27ebc0b8\\",\\"currentIdentitySha256\\":\\"bc2700d2cf9e686ffb8ffa3201ab19193dd5f66bde4e5804ab40cd9cccfe3d5d\\",\\"environmentMatchesOriginal\\":true,\\"fullConfigurationMatchesOriginal\\":false,\\"fullIdentityMatchesOriginal\\":false,\\"healthyRunning\\":true,\\"imageAndReferenceMatchOriginal\\":true,\\"startedIdentityChanged\\":true},\\"auto-recharge\\":{\\"containerIdentityChanged\\":false,\\"currentConfigurationSha256\\":\\"1c341043b62969f855cc1f5852181c949b8ea7831f8c82f15cd7364ee7767120\\",\\"currentIdentitySha256\\":\\"264db89a71af5a8af88f58d1eb717ae64948754ad08441146143918c45d859dc\\",\\"environmentMatchesOriginal\\":true,\\"fullConfigurationMatchesOriginal\\":true,\\"fullIdentityMatchesOriginal\\":true,\\"healthyRunning\\":true,\\"imageAndReferenceMatchOriginal\\":true,\\"startedIdentityChanged\\":false},\\"auto-registration\\":{\\"containerIdentityChanged\\":false,\\"currentConfigurationSha256\\":\\"0da1fad093493de7997af6d9c2c855e1e4272711eb63a3a0f36f4a3fea1fb0c8\\",\\"currentIdentitySha256\\":\\"d32a18a6537e18d94fb05a755a7d5d550d5fa7e2b4c7517e66817de44dc07f10\\",\\"environmentMatchesOriginal\\":true,\\"fullConfigurationMatchesOriginal\\":true,\\"fullIdentityMatchesOriginal\\":true,\\"healthyRunning\\":true,\\"imageAndReferenceMatchOriginal\\":true,\\"startedIdentityChanged\\":false},\\"caddy\\":{\\"containerIdentityChanged\\":false,\\"currentConfigurationSha256\\":\\"3662db0efe0d9d7854a52da2c4fe71e626ebc9a122d9c2da76ed497b403815a0\\",\\"currentIdentitySha256\\":\\"10e9f0e654eba2fbb0e8a20758298d0e681e63caf115ebcfa43d8a218a94e876\\",\\"environmentMatchesOriginal\\":true,\\"fullConfigurationMatchesOriginal\\":true,\\"fullIdentityMatchesOriginal\\":true,\\"healthyRunning\\":true,\\"imageAndReferenceMatchOriginal\\":true,\\"startedIdentityChanged\\":false},\\"media-resolver\\":{\\"containerIdentityChanged\\":false,\\"currentConfigurationSha256\\":\\"88cfc4c67adc0d0fe78e5434d8c1ebfcaeaef7e2726f3f2b30b0d4c85e0c70cb\\",\\"currentIdentitySha256\\":\\"4dc31bb448725c629cfed048882125846f53f9260b56a5058f28ebbf8223bbea\\",\\"environmentMatchesOriginal\\":true,\\"fullConfigurationMatchesOriginal\\":true,\\"fullIdentityMatchesOriginal\\":true,\\"healthyRunning\\":true,\\"imageAndReferenceMatchOriginal\\":true,\\"startedIdentityChanged\\":false},\\"mysql\\":{\\"containerIdentityChanged\\":false,\\"currentConfigurationSha256\\":\\"47f62efcca224ee71466bf71a0337d791b9f6d8b42b024208cc3a29c6585beaf\\",\\"currentIdentitySha256\\":\\"4e5ceb53bcfc877d298eedf15e6eb102037dac6508e457f47a3b7206b66fbbc9\\",\\"environmentMatchesOriginal\\":true,\\"fullConfigurationMatchesOriginal\\":true,\\"fullIdentityMatchesOriginal\\":true,\\"healthyRunning\\":true,\\"imageAndReferenceMatchOriginal\\":true,\\"startedIdentityChanged\\":false}},\\"twoRuntimeFramesStable\\":true,\\"version\\":1,\\"workspaceObservation\\":{\\"databaseBytes\\":61440,\\"databaseFileObserved\\":true,\\"databaseIdentitySha256\\":\\"8cba2658730149199c8e5dc99ab609843399102ab6786db34fd64d679db040cf\\",\\"markerBindsFailedRun\\":false,\\"markerObserved\\":false,\\"volumeIdentityMatchesOriginal\\":true}}\\n","StandardOutputUrl":"","Status":"Success","StatusDetails":"Success"}\n', 'failedPreflight': '{\n  "kind": "ONLINE_RECHARGE_AFTER_BIT_PREFLIGHT",\n  "version": 2,\n  "mode": "preflight",\n  "status": "ONLINE_RECHARGE_AFTER_BIT_BASELINE_VERIFIED",\n  "commandId": "49a863bb-8bb8-4fe3-8f53-4741c8cfa6b8",\n  "releaseCandidateCommit": "08419dcbe85212a203906c86c98e5c3ae0695d72",\n  "workflowRunId": "38160127343",\n  "workflowRunAttempt": "1",\n  "sourceTree": "b6fd81cc0c94a8e5971c5df8b2570716a13fa042",\n  "baseline": {\n    "kind": "ONLINE_RECHARGE_AFTER_BIT_SUCCESSOR_ORIGIN",\n    "version": 1,\n    "baselineRelease": "/opt/id-business-v2/releases/20261011T132910Z-31d2c6885a45",\n    "baselineCommit": "31d2c6885a45817cd40d23fce8d6145bc9f18af2",\n    "baselineProducer": {\n      "commit": "31d2c6885a45817cd40d23fce8d6145bc9f18af2",\n      "sourceTree": "8cd7679461682d9c103e3130852431508c5e812c",\n      "workflowRunId": "38142818370",\n      "workflowRunAttempt": "1"\n    },\n    "manifestBytesSha256": "84936d13d8cd241d62e606a13faf1a0d5d8fd4fa1abdfb21fb091c4298bfc382",\n    "recordBytesSha256": "9387de0d7f4b093a93a87c8ac5ca7300142699cbf0cc5f05a29832c283114545",\n    "buildProofBytesSha256": "097721f049b91eb5abe4ca09f909858a131b93ac9de4c3b49225d60c0e76da65",\n    "buildProofCanonicalSha256": "68636f115875f628a54d64229b4aed43cf86dac0704a8807f51c99475ea8e250",\n    "environmentFileSha256": "a812aef2a536de5b18a31824cdac09e195672f158429a423643232134b1108af",\n    "publicationSha256": "5ec9ef3e4426e0bbd08782462254dbd845b99349bb5a7b617c1a41974a62052f",\n    "pendingOriginSha256": "2f4bb4397bedf82e85330ddc2d157757aae8868b625febe426fe1fc3f2907aa3",\n    "readbackCommandId": "a1209a57-f27a-4fe7-8595-7c9ae2138ee8",\n    "readbackInvocationBytesSha256": "f023c717552727b06a817ec775adb48955d5934cb3b40243279c33af4ec90bf2",\n    "initialReadbackInvocationBytesSha256": "332925aa8524ec54394d7f7561a02c3063a6b2c23a5ccbdc16dd9146b22cbbaf",\n    "originalWorkspace": {\n      "release": "/opt/id-business-v2/releases/20261009T103426Z-0a03fa28e6b8",\n      "manifestSha256": "317fbcd0e307789539009a2798b7017ff5b977041cc1b8ab617f5f3f2dc5efa3"\n    },\n    "migrationRecovery": {\n      "version": 1,\n      "failedCommit": "28a3ba4ffd17d36001b1104c97394f5ae871d73d",\n      "failedSourceTree": "014959a59519da585928adaa7f76f7236e1786d1",\n      "failedWorkflowRunId": "37933246605",\n      "failedWorkflowRunAttempt": "1",\n      "failedCommandId": "ab33d2e0-6135-47ed-8f20-e2defd7c82cd",\n      "failureReceiptSha256": "1959377acd78e7160fec0f85666982d4ea4efbb40dab199b7dcc04ba288ddd5a",\n      "buildProofSha256": "ae6a32418e0a0d4ff3d799e3416cf27a150fd1bd925dd91cfa09b56c30e0ffff",\n      "preflightSha256": "212b6c36d98e003d551284342ddd1c4e468018ff0febc85caff4aee6481e83d4",\n      "policySha256": "641fe690c62224eb3d22d69e94493e08b9a2a9309ce04c588627c4aaea7c8f35",\n      "restoredAttempt": {\n        "version": 1,\n        "commit": "296c096af7c4c79a8ffc2f57d9a15ea75684f431",\n        "sourceTree": "472947076a5b5fb73d6777413505d60ac2379fb1",\n        "workflowRunId": "37944613453",\n        "workflowRunAttempt": "1",\n        "commandId": "ac5c9f85-e813-499c-8e90-92c1ce011bfa",\n        "failureReceiptSha256": "f04e9356221bc10a33c774ce9e692b40db6afa23fd2a3bde23caf096a4f07485",\n        "buildProofSha256": "f3eabbd5962011d238ba7323814fb8c14d0007228f9bbb21f02c755fe0171825",\n        "preflightSha256": "b3ff3b000e5b8824e7422cf7eaf2323444d1467361efabc84767a3f21b1e8df7"\n      }\n    },\n    "migrationState": {\n      "name": "20261009093000_online_recharge",\n      "sha256": "44966182c1bf38290b01f665a4c2c863b052677c5e0024b900137f1d7f11eb95",\n      "status": "APPLIED",\n      "schemaVerified": true,\n      "appliedMigrationsSha256": "792ed62e35a3110ae1a0e4dec9d1d8a67430972d8bd9f7b9c2f7ff1d0a679088"\n    },\n    "services": {\n      "media-resolver": {\n        "image": "sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56",\n        "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver",\n        "status": "running",\n        "health": "healthy",\n        "containerId": "0c4fd25ba8fbf2fdab7639e680c3a3433d814cdb2d71ebd7ad39531aaa639471",\n        "startedAtSha256": "8814f073adf9a0964f3beaf17b261fea765db8d0059e2425ee39fe0afdf31d1f",\n        "environmentSha256": "8473962ae5df6f8e5553ab658ccce662a8816f83631b221484daf5fa42e3b163",\n        "configurationSha256": "88cfc4c67adc0d0fe78e5434d8c1ebfcaeaef7e2726f3f2b30b0d4c85e0c70cb"\n      },\n      "auto-recharge": {\n        "image": "sha256:5bd2ab25ebcadcd99f8d339d604e0268cec3fc2cfdac54e2a215f085e3fac00e",\n        "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:04570d75c779fd91a0933ef9416f6d62698b6b91-37694009463-1-auto-recharge",\n        "status": "running",\n        "health": "healthy",\n        "containerId": "0190045c800bd6cda576b66ccce0986de6792390d01cf19fe19e02cd16316f97",\n        "startedAtSha256": "b54ae0f7bbf6ae90e14b78e4d86fa39ae8d5fef49c5f3a95cd4bd811e3645eda",\n        "environmentSha256": "5169582dea47a65076d5f7a3a3defbc824fa4f772b2dc0904eb64659209757ae",\n        "configurationSha256": "1c341043b62969f855cc1f5852181c949b8ea7831f8c82f15cd7364ee7767120"\n      },\n      "auto-registration": {\n        "image": "sha256:759f60543c2fc5661c5d21644fdc1e9cb0e5cb39c930e9c400f869e0c72be568",\n        "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:18e23ee1ab1a8d5c988ff6ba24149e1c741d62f8-37788833835-1-auto-recharge",\n        "status": "running",\n        "health": "healthy",\n        "containerId": "16de5229289255cd47c3f9336e24aa611c0f9bbc76af2fcdfc5e5e1928d68add",\n        "startedAtSha256": "463587855c649edc70eb7ce82744c1caf57a49d7fbbfb10206bf1531443bb229",\n        "environmentSha256": "de69bd06209b17619f8cb7ae38bace36c27dc4203c67e09fd1b8d21023fbcb17",\n        "configurationSha256": "0da1fad093493de7997af6d9c2c855e1e4272711eb63a3a0f36f4a3fea1fb0c8"\n      },\n      "api": {\n        "image": "sha256:74c28d510a434d599b86188ec7a38d5830b1a4e39b615d92b960963c14aac379",\n        "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:31d2c6885a45817cd40d23fce8d6145bc9f18af2-38142818370-1-api",\n        "status": "running",\n        "health": "healthy",\n        "containerId": "e6ed2826edac1e6bee03683735de798330d3c880d3fe6d84b216334c18fce429",\n        "startedAtSha256": "ecb84a9b0a89d49fead5ea7f1ace52f7f79db66091e818dc81d52bbd2233c14c",\n        "environmentSha256": "9f88452817b9343fb1751d8bfbee6e70b82d4098be9ee5034d9b3dbfc80d705c",\n        "configurationSha256": "f28dcf5a382376c898c462fa0d86c6a28f37f6a1ba0bc4ba66a7c4a467a972c8"\n      },\n      "admin": {\n        "image": "sha256:f3a6b231e914f087722b87f704b7583f93ba0a462444afe6a0b68e8580917eab",\n        "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:31d2c6885a45817cd40d23fce8d6145bc9f18af2-38142818370-1-admin",\n        "status": "running",\n        "health": "healthy",\n        "containerId": "eefe5933f6ee04ffe02f532beb57b017710edc523cd82c5ce8e85229e319ca85",\n        "startedAtSha256": "f3d8e4752110a0a7579a845414e07b0125b9eed76f8eb8ef27b10122b0e61e93",\n        "environmentSha256": "03ddab553858482dcbcc4a93d989902d31b41753eb155fb8162011e218bc0ad4",\n        "configurationSha256": "be8b5cdfbe02bb3b7863d52151ce2ec904ac4a41ef8d0d8741b2098608069571"\n      },\n      "mysql": {\n        "image": "sha256:bced325a4ab7aec848f4688371c7433351dcb5dba26fbcc29c67727d898ae5cb",\n        "reference": "mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb",\n        "status": "running",\n        "health": "healthy",\n        "containerId": "7e5a5abe42c5503e6196f736d532793aaec3796b7eb518f02db614d4025d0074",\n        "startedAtSha256": "de8aff8d3d7634b524828ded3df29bba37d7ef4cf817deff61402fdfcf767ec7",\n        "environmentSha256": "bb8d63d18769016c14d8664a551d2b3da9e251701ed62f87b04cba964fc9e299",\n        "configurationSha256": "47f62efcca224ee71466bf71a0337d791b9f6d8b42b024208cc3a29c6585beaf"\n      },\n      "caddy": {\n        "image": "sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510",\n        "reference": "caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d",\n        "status": "running",\n        "health": null,\n        "containerId": "0ee2a1ea26eec74fef64362fd77a69894e3dc4dddd412c38ebd59c747aa6e203",\n        "startedAtSha256": "8c855d6048304bfcba4e29cbde6443070cdbbf778fe722648b491c763f285d24",\n        "environmentSha256": "33ea62b4e1f4de93e333bdbbea4ec88904661f1cb616907b185fce31b22b7181",\n        "configurationSha256": "3662db0efe0d9d7854a52da2c4fe71e626ebc9a122d9c2da76ed497b403815a0"\n      }\n    },\n    "configurationAfter": {\n      "docker-compose.aws-mysql.yml": "953c6264f157b00218f2a019d5e2c0b6bc4a34f687f2ec42ad782e0009e7672c",\n      "deploy/caddy/Caddyfile.aws": "f3d253904be6acbe24184b6a317eb3c9ded71636d9622dc9636c196dd7a56674",\n      "apps/api/prisma-mysql/schema.prisma": "8006d3ce6f0b44cf62f3b47bb7b4a0b14d0ddc18ddf113a5da34a901b62fb197",\n      "compose.release.json": "9a7e58f648528dc989e07b4004553138b39c79613aedc0717f7b5a4005740403"\n    }\n  },\n  "services": {\n    "media-resolver": {\n      "image": "sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56",\n      "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver",\n      "status": "running",\n      "health": "healthy",\n      "containerId": "0c4fd25ba8fbf2fdab7639e680c3a3433d814cdb2d71ebd7ad39531aaa639471",\n      "startedAtSha256": "8814f073adf9a0964f3beaf17b261fea765db8d0059e2425ee39fe0afdf31d1f",\n      "environmentSha256": "8473962ae5df6f8e5553ab658ccce662a8816f83631b221484daf5fa42e3b163",\n      "configurationSha256": "88cfc4c67adc0d0fe78e5434d8c1ebfcaeaef7e2726f3f2b30b0d4c85e0c70cb"\n    },\n    "auto-recharge": {\n      "image": "sha256:5bd2ab25ebcadcd99f8d339d604e0268cec3fc2cfdac54e2a215f085e3fac00e",\n      "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:04570d75c779fd91a0933ef9416f6d62698b6b91-37694009463-1-auto-recharge",\n      "status": "running",\n      "health": "healthy",\n      "containerId": "0190045c800bd6cda576b66ccce0986de6792390d01cf19fe19e02cd16316f97",\n      "startedAtSha256": "b54ae0f7bbf6ae90e14b78e4d86fa39ae8d5fef49c5f3a95cd4bd811e3645eda",\n      "environmentSha256": "5169582dea47a65076d5f7a3a3defbc824fa4f772b2dc0904eb64659209757ae",\n      "configurationSha256": "1c341043b62969f855cc1f5852181c949b8ea7831f8c82f15cd7364ee7767120"\n    },\n    "auto-registration": {\n      "image": "sha256:759f60543c2fc5661c5d21644fdc1e9cb0e5cb39c930e9c400f869e0c72be568",\n      "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:18e23ee1ab1a8d5c988ff6ba24149e1c741d62f8-37788833835-1-auto-recharge",\n      "status": "running",\n      "health": "healthy",\n      "containerId": "16de5229289255cd47c3f9336e24aa611c0f9bbc76af2fcdfc5e5e1928d68add",\n      "startedAtSha256": "463587855c649edc70eb7ce82744c1caf57a49d7fbbfb10206bf1531443bb229",\n      "environmentSha256": "de69bd06209b17619f8cb7ae38bace36c27dc4203c67e09fd1b8d21023fbcb17",\n      "configurationSha256": "0da1fad093493de7997af6d9c2c855e1e4272711eb63a3a0f36f4a3fea1fb0c8"\n    },\n    "api": {\n      "image": "sha256:74c28d510a434d599b86188ec7a38d5830b1a4e39b615d92b960963c14aac379",\n      "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:31d2c6885a45817cd40d23fce8d6145bc9f18af2-38142818370-1-api",\n      "status": "running",\n      "health": "healthy",\n      "containerId": "e6ed2826edac1e6bee03683735de798330d3c880d3fe6d84b216334c18fce429",\n      "startedAtSha256": "ecb84a9b0a89d49fead5ea7f1ace52f7f79db66091e818dc81d52bbd2233c14c",\n      "environmentSha256": "9f88452817b9343fb1751d8bfbee6e70b82d4098be9ee5034d9b3dbfc80d705c",\n      "configurationSha256": "f28dcf5a382376c898c462fa0d86c6a28f37f6a1ba0bc4ba66a7c4a467a972c8"\n    },\n    "admin": {\n      "image": "sha256:f3a6b231e914f087722b87f704b7583f93ba0a462444afe6a0b68e8580917eab",\n      "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:31d2c6885a45817cd40d23fce8d6145bc9f18af2-38142818370-1-admin",\n      "status": "running",\n      "health": "healthy",\n      "containerId": "eefe5933f6ee04ffe02f532beb57b017710edc523cd82c5ce8e85229e319ca85",\n      "startedAtSha256": "f3d8e4752110a0a7579a845414e07b0125b9eed76f8eb8ef27b10122b0e61e93",\n      "environmentSha256": "03ddab553858482dcbcc4a93d989902d31b41753eb155fb8162011e218bc0ad4",\n      "configurationSha256": "be8b5cdfbe02bb3b7863d52151ce2ec904ac4a41ef8d0d8741b2098608069571"\n    },\n    "mysql": {\n      "image": "sha256:bced325a4ab7aec848f4688371c7433351dcb5dba26fbcc29c67727d898ae5cb",\n      "reference": "mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb",\n      "status": "running",\n      "health": "healthy",\n      "containerId": "7e5a5abe42c5503e6196f736d532793aaec3796b7eb518f02db614d4025d0074",\n      "startedAtSha256": "de8aff8d3d7634b524828ded3df29bba37d7ef4cf817deff61402fdfcf767ec7",\n      "environmentSha256": "bb8d63d18769016c14d8664a551d2b3da9e251701ed62f87b04cba964fc9e299",\n      "configurationSha256": "47f62efcca224ee71466bf71a0337d791b9f6d8b42b024208cc3a29c6585beaf"\n    },\n    "caddy": {\n      "image": "sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510",\n      "reference": "caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d",\n      "status": "running",\n      "health": null,\n      "containerId": "0ee2a1ea26eec74fef64362fd77a69894e3dc4dddd412c38ebd59c747aa6e203",\n      "startedAtSha256": "8c855d6048304bfcba4e29cbde6443070cdbbf778fe722648b491c763f285d24",\n      "environmentSha256": "33ea62b4e1f4de93e333bdbbea4ec88904661f1cb616907b185fce31b22b7181",\n      "configurationSha256": "3662db0efe0d9d7854a52da2c4fe71e626ebc9a122d9c2da76ed497b403815a0"\n    }\n  },\n  "ordinaryPreflight": {\n    "status": "ONLINE_RECHARGE_BASELINE_VERIFIED",\n    "commit": "31d2c6885a45817cd40d23fce8d6145bc9f18af2",\n    "services": {\n      "media-resolver": {\n        "image": "sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56",\n        "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver",\n        "status": "running",\n        "health": "healthy",\n        "containerId": "0c4fd25ba8fbf2fdab7639e680c3a3433d814cdb2d71ebd7ad39531aaa639471",\n        "startedAtSha256": "8814f073adf9a0964f3beaf17b261fea765db8d0059e2425ee39fe0afdf31d1f",\n        "environmentSha256": "8473962ae5df6f8e5553ab658ccce662a8816f83631b221484daf5fa42e3b163",\n        "configurationSha256": "88cfc4c67adc0d0fe78e5434d8c1ebfcaeaef7e2726f3f2b30b0d4c85e0c70cb"\n      },\n      "auto-recharge": {\n        "image": "sha256:5bd2ab25ebcadcd99f8d339d604e0268cec3fc2cfdac54e2a215f085e3fac00e",\n        "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:04570d75c779fd91a0933ef9416f6d62698b6b91-37694009463-1-auto-recharge",\n        "status": "running",\n        "health": "healthy",\n        "containerId": "0190045c800bd6cda576b66ccce0986de6792390d01cf19fe19e02cd16316f97",\n        "startedAtSha256": "b54ae0f7bbf6ae90e14b78e4d86fa39ae8d5fef49c5f3a95cd4bd811e3645eda",\n        "environmentSha256": "5169582dea47a65076d5f7a3a3defbc824fa4f772b2dc0904eb64659209757ae",\n        "configurationSha256": "1c341043b62969f855cc1f5852181c949b8ea7831f8c82f15cd7364ee7767120"\n      },\n      "auto-registration": {\n        "image": "sha256:759f60543c2fc5661c5d21644fdc1e9cb0e5cb39c930e9c400f869e0c72be568",\n        "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:18e23ee1ab1a8d5c988ff6ba24149e1c741d62f8-37788833835-1-auto-recharge",\n        "status": "running",\n        "health": "healthy",\n        "containerId": "16de5229289255cd47c3f9336e24aa611c0f9bbc76af2fcdfc5e5e1928d68add",\n        "startedAtSha256": "463587855c649edc70eb7ce82744c1caf57a49d7fbbfb10206bf1531443bb229",\n        "environmentSha256": "de69bd06209b17619f8cb7ae38bace36c27dc4203c67e09fd1b8d21023fbcb17",\n        "configurationSha256": "0da1fad093493de7997af6d9c2c855e1e4272711eb63a3a0f36f4a3fea1fb0c8"\n      },\n      "api": {\n        "image": "sha256:74c28d510a434d599b86188ec7a38d5830b1a4e39b615d92b960963c14aac379",\n        "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:31d2c6885a45817cd40d23fce8d6145bc9f18af2-38142818370-1-api",\n        "status": "running",\n        "health": "healthy",\n        "containerId": "e6ed2826edac1e6bee03683735de798330d3c880d3fe6d84b216334c18fce429",\n        "startedAtSha256": "ecb84a9b0a89d49fead5ea7f1ace52f7f79db66091e818dc81d52bbd2233c14c",\n        "environmentSha256": "9f88452817b9343fb1751d8bfbee6e70b82d4098be9ee5034d9b3dbfc80d705c",\n        "configurationSha256": "f28dcf5a382376c898c462fa0d86c6a28f37f6a1ba0bc4ba66a7c4a467a972c8"\n      },\n      "admin": {\n        "image": "sha256:f3a6b231e914f087722b87f704b7583f93ba0a462444afe6a0b68e8580917eab",\n        "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:31d2c6885a45817cd40d23fce8d6145bc9f18af2-38142818370-1-admin",\n        "status": "running",\n        "health": "healthy",\n        "containerId": "eefe5933f6ee04ffe02f532beb57b017710edc523cd82c5ce8e85229e319ca85",\n        "startedAtSha256": "f3d8e4752110a0a7579a845414e07b0125b9eed76f8eb8ef27b10122b0e61e93",\n        "environmentSha256": "03ddab553858482dcbcc4a93d989902d31b41753eb155fb8162011e218bc0ad4",\n        "configurationSha256": "be8b5cdfbe02bb3b7863d52151ce2ec904ac4a41ef8d0d8741b2098608069571"\n      },\n      "mysql": {\n        "image": "sha256:bced325a4ab7aec848f4688371c7433351dcb5dba26fbcc29c67727d898ae5cb",\n        "reference": "mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb",\n        "status": "running",\n        "health": "healthy",\n        "containerId": "7e5a5abe42c5503e6196f736d532793aaec3796b7eb518f02db614d4025d0074",\n        "startedAtSha256": "de8aff8d3d7634b524828ded3df29bba37d7ef4cf817deff61402fdfcf767ec7",\n        "environmentSha256": "bb8d63d18769016c14d8664a551d2b3da9e251701ed62f87b04cba964fc9e299",\n        "configurationSha256": "47f62efcca224ee71466bf71a0337d791b9f6d8b42b024208cc3a29c6585beaf"\n      },\n      "caddy": {\n        "image": "sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510",\n        "reference": "caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d",\n        "status": "running",\n        "health": null,\n        "containerId": "0ee2a1ea26eec74fef64362fd77a69894e3dc4dddd412c38ebd59c747aa6e203",\n        "startedAtSha256": "8c855d6048304bfcba4e29cbde6443070cdbbf778fe722648b491c763f285d24",\n        "environmentSha256": "33ea62b4e1f4de93e333bdbbea4ec88904661f1cb616907b185fce31b22b7181",\n        "configurationSha256": "3662db0efe0d9d7854a52da2c4fe71e626ebc9a122d9c2da76ed497b403815a0"\n      }\n    },\n    "migrationOrigin": {\n      "version": 1,\n      "release": "/opt/id-business-v2/releases/20261008T175148Z-23c5841b9b7e",\n      "commit": "23c5841b9b7e60be715250cbb985fc0966c0bce3",\n      "manifestSha256": "117ca444e81623f372a2d9c34ecc16effd52141dcfb5e511f74624280092f639",\n      "buildProofSha256": "6208643f01babb412956fe43f537990adf951c14447645e7f56303d03a6b1d6c",\n      "migration": {\n        "name": "20261008180000_quick_action_user_order",\n        "sha256": "2617684e1c9c4f7ecf5cc40009239c2972d9569c3c1cea1324ecfe5d58871678",\n        "schemaBeforeSha256": "c70cbcb110bb48c395b7e7284dedc0486a9afc125d940c455c0bafc1cffc701d",\n        "schemaAfterSha256": "8006d3ce6f0b44cf62f3b47bb7b4a0b14d0ddc18ddf113a5da34a901b62fb197",\n        "baselineFilesSha256": "c2179090dd600b3b33a56fe8384e8a7020a4e0cb6eb9a97f509352ee22f4df0a"\n      },\n      "migrationState": {\n        "name": "20261008180000_quick_action_user_order",\n        "sha256": "2617684e1c9c4f7ecf5cc40009239c2972d9569c3c1cea1324ecfe5d58871678",\n        "status": "APPLIED",\n        "schemaVerified": true,\n        "appliedMigrationsSha256": "4d69ef3bc2c189ab93527abd6cf80d3b4d64b53a61b645026c476d70bcd99fae"\n      },\n      "task": {\n        "taskId": "252ab243-d96b-4928-8116-b83dedc1d240",\n        "attempt": 12,\n        "registered": true,\n        "passwordVerified": false,\n        "mfaVerified": false,\n        "leaseActive": false,\n        "noncePresent": false,\n        "passwordCandidatePresent": true,\n        "binding": {\n          "accountSha256": "4764c0440ec5bde3d20c74064096b3720a3d7d6ac637361452b9f544b9287ba5",\n          "profileSha256": "052ad861dc0da2f8611d422bd384e328e1d856a126bc86434846861f90728f00",\n          "ownerSha256": "ed198d0daf9ef5910f54dc16b3a7a6f4db0cf55c1935309f838071365ab7196d"\n        },\n        "emailHashHmac": "99e7d0edf61acf0d0228c67fa52bdf3065e86dda2356d06b8dc6f44125a3429b",\n        "jobHmac": "78bc1a85e9857512b534e8b23d6beae677f15cd45bbc76253812bc65396003f9",\n        "accountHmac": "763310b009d8c2c099ac94d2265570d9ca9d2886dcd6eb31d3133556571f3e9a",\n        "auditHmac": "500789997c0d6f006b7c70a07f21be06b1785b355eba2c36e10f3eb37d75edac",\n        "state": "partial",\n        "step": "password",\n        "reason": "session_load_timeout",\n        "updatedAt": "2026-10-08T14:18:32.726Z",\n        "auditCount": 5\n      },\n      "guards": {\n        "rechargeIdle": true,\n        "registrationBusy": false,\n        "registrationLeaseActive": false,\n        "registrationWindowRetained": true\n      }\n    },\n    "manifestSha256": "84936d13d8cd241d62e606a13faf1a0d5d8fd4fa1abdfb21fb091c4298bfc382",\n    "environmentSha256": "a812aef2a536de5b18a31824cdac09e195672f158429a423643232134b1108af",\n    "apiSource": {\n      "imageId": "sha256:74c28d510a434d599b86188ec7a38d5830b1a4e39b615d92b960963c14aac379",\n      "revision": "31d2c6885a45817cd40d23fce8d6145bc9f18af2",\n      "kind": "API_WORKSPACE_BUILD_PROVEN"\n    },\n    "guards": {\n      "rechargeIdle": true,\n      "registrationBusy": false,\n      "registrationLeaseActive": false,\n      "registrationWindowRetained": true\n    },\n    "workspaceIdle": true,\n    "workspaceVolume": {\n      "name": "20260821t095106z_auto_registration_data",\n      "status": "PRESENT",\n      "identitySha256": "cc39b3f3777d1e53f9b332994ed22af58fdf15daf72779a482d86272f9eb61e1"\n    },\n    "workspaceOriginFiles": {\n      "release-manifest.json": "84936d13d8cd241d62e606a13faf1a0d5d8fd4fa1abdfb21fb091c4298bfc382",\n      "api-workspace-build-proof.json": "097721f049b91eb5abe4ca09f909858a131b93ac9de4c3b49225d60c0e76da65",\n      "api-workspace-preservation.json": "9387de0d7f4b093a93a87c8ac5ca7300142699cbf0cc5f05a29832c283114545",\n      "backup-verification.json": "f93fc3c8a4549478aeda54cb6c7175c4bd13ab5bb50a654185118656696e6a5a",\n      "before-audit.json": "da59b8dbe78e2ecd669303082d12db47e34898a57edd5cbb629894100260979a",\n      "after-audit.json": "16e9a830d57385119a79c6f7c039c6b74b464d6fe57b3bbff78f1ba280dc9ca3"\n    },\n    "workspaceBuildProofSha256": "68636f115875f628a54d64229b4aed43cf86dac0704a8807f51c99475ea8e250",\n    "migrationRecovery": {\n      "version": 1,\n      "failedCommit": "28a3ba4ffd17d36001b1104c97394f5ae871d73d",\n      "failedSourceTree": "014959a59519da585928adaa7f76f7236e1786d1",\n      "failedWorkflowRunId": "37933246605",\n      "failedWorkflowRunAttempt": "1",\n      "failedCommandId": "ab33d2e0-6135-47ed-8f20-e2defd7c82cd",\n      "failureReceiptSha256": "1959377acd78e7160fec0f85666982d4ea4efbb40dab199b7dcc04ba288ddd5a",\n      "buildProofSha256": "ae6a32418e0a0d4ff3d799e3416cf27a150fd1bd925dd91cfa09b56c30e0ffff",\n      "preflightSha256": "212b6c36d98e003d551284342ddd1c4e468018ff0febc85caff4aee6481e83d4",\n      "policySha256": "641fe690c62224eb3d22d69e94493e08b9a2a9309ce04c588627c4aaea7c8f35",\n      "restoredAttempt": {\n        "version": 1,\n        "commit": "296c096af7c4c79a8ffc2f57d9a15ea75684f431",\n        "sourceTree": "472947076a5b5fb73d6777413505d60ac2379fb1",\n        "workflowRunId": "37944613453",\n        "workflowRunAttempt": "1",\n        "commandId": "ac5c9f85-e813-499c-8e90-92c1ce011bfa",\n        "failureReceiptSha256": "f04e9356221bc10a33c774ce9e692b40db6afa23fd2a3bde23caf096a4f07485",\n        "buildProofSha256": "f3eabbd5962011d238ba7323814fb8c14d0007228f9bbb21f02c755fe0171825",\n        "preflightSha256": "b3ff3b000e5b8824e7422cf7eaf2323444d1467361efabc84767a3f21b1e8df7"\n      }\n    },\n    "onlineAfterBitOrigin": {\n      "kind": "ONLINE_RECHARGE_AFTER_BIT_SUCCESSOR_ORIGIN",\n      "version": 1,\n      "baselineRelease": "/opt/id-business-v2/releases/20261011T132910Z-31d2c6885a45",\n      "baselineCommit": "31d2c6885a45817cd40d23fce8d6145bc9f18af2",\n      "baselineProducer": {\n        "commit": "31d2c6885a45817cd40d23fce8d6145bc9f18af2",\n        "sourceTree": "8cd7679461682d9c103e3130852431508c5e812c",\n        "workflowRunId": "38142818370",\n        "workflowRunAttempt": "1"\n      },\n      "manifestBytesSha256": "84936d13d8cd241d62e606a13faf1a0d5d8fd4fa1abdfb21fb091c4298bfc382",\n      "recordBytesSha256": "9387de0d7f4b093a93a87c8ac5ca7300142699cbf0cc5f05a29832c283114545",\n      "buildProofBytesSha256": "097721f049b91eb5abe4ca09f909858a131b93ac9de4c3b49225d60c0e76da65",\n      "buildProofCanonicalSha256": "68636f115875f628a54d64229b4aed43cf86dac0704a8807f51c99475ea8e250",\n      "environmentFileSha256": "a812aef2a536de5b18a31824cdac09e195672f158429a423643232134b1108af",\n      "publicationSha256": "5ec9ef3e4426e0bbd08782462254dbd845b99349bb5a7b617c1a41974a62052f",\n      "pendingOriginSha256": "2f4bb4397bedf82e85330ddc2d157757aae8868b625febe426fe1fc3f2907aa3",\n      "readbackCommandId": "a1209a57-f27a-4fe7-8595-7c9ae2138ee8",\n      "readbackInvocationBytesSha256": "f023c717552727b06a817ec775adb48955d5934cb3b40243279c33af4ec90bf2",\n      "initialReadbackInvocationBytesSha256": "332925aa8524ec54394d7f7561a02c3063a6b2c23a5ccbdc16dd9146b22cbbaf",\n      "originalWorkspace": {\n        "release": "/opt/id-business-v2/releases/20261009T103426Z-0a03fa28e6b8",\n        "manifestSha256": "317fbcd0e307789539009a2798b7017ff5b977041cc1b8ab617f5f3f2dc5efa3"\n      },\n      "migrationRecovery": {\n        "version": 1,\n        "failedCommit": "28a3ba4ffd17d36001b1104c97394f5ae871d73d",\n        "failedSourceTree": "014959a59519da585928adaa7f76f7236e1786d1",\n        "failedWorkflowRunId": "37933246605",\n        "failedWorkflowRunAttempt": "1",\n        "failedCommandId": "ab33d2e0-6135-47ed-8f20-e2defd7c82cd",\n        "failureReceiptSha256": "1959377acd78e7160fec0f85666982d4ea4efbb40dab199b7dcc04ba288ddd5a",\n        "buildProofSha256": "ae6a32418e0a0d4ff3d799e3416cf27a150fd1bd925dd91cfa09b56c30e0ffff",\n        "preflightSha256": "212b6c36d98e003d551284342ddd1c4e468018ff0febc85caff4aee6481e83d4",\n        "policySha256": "641fe690c62224eb3d22d69e94493e08b9a2a9309ce04c588627c4aaea7c8f35",\n        "restoredAttempt": {\n          "version": 1,\n          "commit": "296c096af7c4c79a8ffc2f57d9a15ea75684f431",\n          "sourceTree": "472947076a5b5fb73d6777413505d60ac2379fb1",\n          "workflowRunId": "37944613453",\n          "workflowRunAttempt": "1",\n          "commandId": "ac5c9f85-e813-499c-8e90-92c1ce011bfa",\n          "failureReceiptSha256": "f04e9356221bc10a33c774ce9e692b40db6afa23fd2a3bde23caf096a4f07485",\n          "buildProofSha256": "f3eabbd5962011d238ba7323814fb8c14d0007228f9bbb21f02c755fe0171825",\n          "preflightSha256": "b3ff3b000e5b8824e7422cf7eaf2323444d1467361efabc84767a3f21b1e8df7"\n        }\n      },\n      "migrationState": {\n        "name": "20261009093000_online_recharge",\n        "sha256": "44966182c1bf38290b01f665a4c2c863b052677c5e0024b900137f1d7f11eb95",\n        "status": "APPLIED",\n        "schemaVerified": true,\n        "appliedMigrationsSha256": "792ed62e35a3110ae1a0e4dec9d1d8a67430972d8bd9f7b9c2f7ff1d0a679088"\n      },\n      "services": {\n        "media-resolver": {\n          "image": "sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56",\n          "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver",\n          "status": "running",\n          "health": "healthy",\n          "containerId": "0c4fd25ba8fbf2fdab7639e680c3a3433d814cdb2d71ebd7ad39531aaa639471",\n          "startedAtSha256": "8814f073adf9a0964f3beaf17b261fea765db8d0059e2425ee39fe0afdf31d1f",\n          "environmentSha256": "8473962ae5df6f8e5553ab658ccce662a8816f83631b221484daf5fa42e3b163",\n          "configurationSha256": "88cfc4c67adc0d0fe78e5434d8c1ebfcaeaef7e2726f3f2b30b0d4c85e0c70cb"\n        },\n        "auto-recharge": {\n          "image": "sha256:5bd2ab25ebcadcd99f8d339d604e0268cec3fc2cfdac54e2a215f085e3fac00e",\n          "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:04570d75c779fd91a0933ef9416f6d62698b6b91-37694009463-1-auto-recharge",\n          "status": "running",\n          "health": "healthy",\n          "containerId": "0190045c800bd6cda576b66ccce0986de6792390d01cf19fe19e02cd16316f97",\n          "startedAtSha256": "b54ae0f7bbf6ae90e14b78e4d86fa39ae8d5fef49c5f3a95cd4bd811e3645eda",\n          "environmentSha256": "5169582dea47a65076d5f7a3a3defbc824fa4f772b2dc0904eb64659209757ae",\n          "configurationSha256": "1c341043b62969f855cc1f5852181c949b8ea7831f8c82f15cd7364ee7767120"\n        },\n        "auto-registration": {\n          "image": "sha256:759f60543c2fc5661c5d21644fdc1e9cb0e5cb39c930e9c400f869e0c72be568",\n          "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:18e23ee1ab1a8d5c988ff6ba24149e1c741d62f8-37788833835-1-auto-recharge",\n          "status": "running",\n          "health": "healthy",\n          "containerId": "16de5229289255cd47c3f9336e24aa611c0f9bbc76af2fcdfc5e5e1928d68add",\n          "startedAtSha256": "463587855c649edc70eb7ce82744c1caf57a49d7fbbfb10206bf1531443bb229",\n          "environmentSha256": "de69bd06209b17619f8cb7ae38bace36c27dc4203c67e09fd1b8d21023fbcb17",\n          "configurationSha256": "0da1fad093493de7997af6d9c2c855e1e4272711eb63a3a0f36f4a3fea1fb0c8"\n        },\n        "api": {\n          "image": "sha256:74c28d510a434d599b86188ec7a38d5830b1a4e39b615d92b960963c14aac379",\n          "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:31d2c6885a45817cd40d23fce8d6145bc9f18af2-38142818370-1-api",\n          "status": "running",\n          "health": "healthy",\n          "containerId": "e6ed2826edac1e6bee03683735de798330d3c880d3fe6d84b216334c18fce429",\n          "startedAtSha256": "ecb84a9b0a89d49fead5ea7f1ace52f7f79db66091e818dc81d52bbd2233c14c",\n          "environmentSha256": "9f88452817b9343fb1751d8bfbee6e70b82d4098be9ee5034d9b3dbfc80d705c",\n          "configurationSha256": "f28dcf5a382376c898c462fa0d86c6a28f37f6a1ba0bc4ba66a7c4a467a972c8"\n        },\n        "admin": {\n          "image": "sha256:f3a6b231e914f087722b87f704b7583f93ba0a462444afe6a0b68e8580917eab",\n          "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:31d2c6885a45817cd40d23fce8d6145bc9f18af2-38142818370-1-admin",\n          "status": "running",\n          "health": "healthy",\n          "containerId": "eefe5933f6ee04ffe02f532beb57b017710edc523cd82c5ce8e85229e319ca85",\n          "startedAtSha256": "f3d8e4752110a0a7579a845414e07b0125b9eed76f8eb8ef27b10122b0e61e93",\n          "environmentSha256": "03ddab553858482dcbcc4a93d989902d31b41753eb155fb8162011e218bc0ad4",\n          "configurationSha256": "be8b5cdfbe02bb3b7863d52151ce2ec904ac4a41ef8d0d8741b2098608069571"\n        },\n        "mysql": {\n          "image": "sha256:bced325a4ab7aec848f4688371c7433351dcb5dba26fbcc29c67727d898ae5cb",\n          "reference": "mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb",\n          "status": "running",\n          "health": "healthy",\n          "containerId": "7e5a5abe42c5503e6196f736d532793aaec3796b7eb518f02db614d4025d0074",\n          "startedAtSha256": "de8aff8d3d7634b524828ded3df29bba37d7ef4cf817deff61402fdfcf767ec7",\n          "environmentSha256": "bb8d63d18769016c14d8664a551d2b3da9e251701ed62f87b04cba964fc9e299",\n          "configurationSha256": "47f62efcca224ee71466bf71a0337d791b9f6d8b42b024208cc3a29c6585beaf"\n        },\n        "caddy": {\n          "image": "sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510",\n          "reference": "caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d",\n          "status": "running",\n          "health": null,\n          "containerId": "0ee2a1ea26eec74fef64362fd77a69894e3dc4dddd412c38ebd59c747aa6e203",\n          "startedAtSha256": "8c855d6048304bfcba4e29cbde6443070cdbbf778fe722648b491c763f285d24",\n          "environmentSha256": "33ea62b4e1f4de93e333bdbbea4ec88904661f1cb616907b185fce31b22b7181",\n          "configurationSha256": "3662db0efe0d9d7854a52da2c4fe71e626ebc9a122d9c2da76ed497b403815a0"\n        }\n      },\n      "configurationAfter": {\n        "docker-compose.aws-mysql.yml": "953c6264f157b00218f2a019d5e2c0b6bc4a34f687f2ec42ad782e0009e7672c",\n        "deploy/caddy/Caddyfile.aws": "f3d253904be6acbe24184b6a317eb3c9ded71636d9622dc9636c196dd7a56674",\n        "apps/api/prisma-mysql/schema.prisma": "8006d3ce6f0b44cf62f3b47bb7b4a0b14d0ddc18ddf113a5da34a901b62fb197",\n        "compose.release.json": "9a7e58f648528dc989e07b4004553138b39c79613aedc0717f7b5a4005740403"\n      }\n    },\n    "freeBytes": 7854866432,\n    "audit": {\n      "checkCount": 49,\n      "violationCount": 0,\n      "mode": "STRICT_ZERO_49",\n      "checksSha256": "65c2813269458f1eb2f84516969e8b81520f9f86beb36a2dc0b5179e4dfbbefa"\n    },\n    "migration": {\n      "name": "20261009093000_online_recharge",\n      "sha256": "44966182c1bf38290b01f665a4c2c863b052677c5e0024b900137f1d7f11eb95",\n      "baselineFileCount": 47,\n      "baselineFilesSha256": "3baef4b2e1fcc1b1194d5ffa0197dabd09ee01a757abe7478e1f3488f8019a14",\n      "schemaBeforeSha256": "8006d3ce6f0b44cf62f3b47bb7b4a0b14d0ddc18ddf113a5da34a901b62fb197",\n      "schemaAfterSha256": "8ae09e883e79bfb85cd65edbf630f2ec03b6b397eb46d172b4c4f05514b715a7",\n      "seedBeforeSha256": "ac9940a7977def1ed6eaad38ed154d81963ce6e877f02ffc07234fa61591096b",\n      "seedAfterSha256": "2a7becbe8da189adad73b30d7bfe36070fd44ae4f683f7e4a01178d14ae08b5b"\n    },\n    "migrationState": {\n      "name": "20261009093000_online_recharge",\n      "sha256": "44966182c1bf38290b01f665a4c2c863b052677c5e0024b900137f1d7f11eb95",\n      "status": "APPLIED",\n      "schemaVerified": true,\n      "appliedMigrationsSha256": "792ed62e35a3110ae1a0e4dec9d1d8a67430972d8bd9f7b9c2f7ff1d0a679088"\n    },\n    "workersPreserved": true,\n    "requiresWindowHandoff": false,\n    "migrationPerformed": false\n  }\n}\n', 'failedBuildProof': '{\n  "baselineCommit": "31d2c6885a45817cd40d23fce8d6145bc9f18af2",\n  "baselineOriginSha256": "4b81b0d398de0c4b0198803950354c286f7107a8a19b99e519d5404007b0c1ca",\n  "commit": "08419dcbe85212a203906c86c98e5c3ae0695d72",\n  "composeSourceSha256": "8250b0b74da9271e4254448dd97c53b30129f6e37e9fc5203ccd1a01200c2792",\n  "engineSourceSha256": "309ad31694045d49d2577b9bafe74d6e598e111084b2ada7f9d1d1beba20ed73",\n  "images": {\n    "admin": {\n      "fileCount": 257,\n      "imageId": "sha256:4f77a7f383187f96edc59901a9f4e5895b53b86233557a41dfa2c4f68b6a371d",\n      "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:08419dcbe85212a203906c86c98e5c3ae0695d72-38160127343-1-admin",\n      "sha256": "3b0510427d36b80c06d3146e2f0ee207dd807066bc34822a12f8a0b96826a8bd"\n    },\n    "api": {\n      "fileCount": 4343,\n      "imageId": "sha256:29539eb7825877e2e303c3567a4f4f00b8dba8773001e6de170de45f0e3987d7",\n      "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:08419dcbe85212a203906c86c98e5c3ae0695d72-38160127343-1-api",\n      "sha256": "0e9154402fae3f6760427e85dc1f3658050a6d059beb9009b1459522d65d1467"\n    },\n    "migrate": {\n      "fileCount": 50,\n      "imageId": "sha256:aa0cdad461ded3bb6d75c716c057b5ffc2e785438509310744c1230b83547dd7",\n      "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:08419dcbe85212a203906c86c98e5c3ae0695d72-38160127343-1-migrate",\n      "sha256": "42e5d67fac62e54889591c85b95b7ad26d552e919427c905743ca3125477b1c9"\n    },\n    "online-recharge": {\n      "fileCount": 62,\n      "imageId": "sha256:b7af34d635187117b1336f3b87505a17b082006b275c283802806c362e84a55d",\n      "reference": "079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:08419dcbe85212a203906c86c98e5c3ae0695d72-38160127343-1-online-recharge",\n      "sha256": "56cd07b61bfcc6f993e8dc417c515b24f1ecec9638942185aeff9756664a066b"\n    }\n  },\n  "kind": "ONLINE_RECHARGE_AFTER_BIT_BUILD_PROOF",\n  "migration": {\n    "baselineFileCount": 47,\n    "baselineFilesSha256": "3baef4b2e1fcc1b1194d5ffa0197dabd09ee01a757abe7478e1f3488f8019a14",\n    "name": "20261009093000_online_recharge",\n    "schemaAfterSha256": "8ae09e883e79bfb85cd65edbf630f2ec03b6b397eb46d172b4c4f05514b715a7",\n    "schemaBeforeSha256": "8006d3ce6f0b44cf62f3b47bb7b4a0b14d0ddc18ddf113a5da34a901b62fb197",\n    "seedAfterSha256": "2a7becbe8da189adad73b30d7bfe36070fd44ae4f683f7e4a01178d14ae08b5b",\n    "seedBeforeSha256": "ac9940a7977def1ed6eaad38ed154d81963ce6e877f02ffc07234fa61591096b",\n    "sha256": "44966182c1bf38290b01f665a4c2c863b052677c5e0024b900137f1d7f11eb95"\n  },\n  "preflightBytesSha256": "aba6144845be3836c4fe56a1def9a755018634f26710b8d17ec74b2d2660c4db",\n  "scope": "ONLINE_RECHARGE",\n  "sourceTree": "b6fd81cc0c94a8e5971c5df8b2570716a13fa042",\n  "version": 2\n}\n', 'failedNativeFailure': '{\n  "InstanceId": "i-05836da38606e633c",\n  "ExecutionEndDateTime": "2026-10-11T17:58:11.942Z",\n  "ExecutionStartDateTime": "2026-10-11T17:42:42.942Z",\n  "ResponseCode": 1,\n  "StatusDetails": "Failed",\n  "Status": "Failed",\n  "CommandId": "c03fdc8a-9f39-40e5-8181-0071b3bc8f89",\n  "ExecutionElapsedTime": "PT15M29.741S",\n  "StandardOutputContent": "{\\"status\\": \\"ONLINE_RECHARGE_FAILED_RESTORED\\", \\"step\\": \\"switch\\", \\"code\\": \\"API_ADMIN_WORKSPACE_GUARD_TIMEOUT\\", \\"errorType\\": \\"RuntimeError\\", \\"rollbackOk\\": true, \\"rollback\\": {\\"api\\": \\"RESTORED\\", \\"admin\\": \\"RESTORED\\"}, \\"servicesAttempted\\": [\\"admin\\", \\"api\\"], \\"candidateCommit\\": \\"08419dcbe85212a203906c86c98e5c3ae0695d72\\", \\"previousCommit\\": \\"31d2c6885a45817cd40d23fce8d6145bc9f18af2\\", \\"migration\\": {\\"name\\": \\"20261009093000_online_recharge\\", \\"sha256\\": \\"44966182c1bf38290b01f665a4c2c863b052677c5e0024b900137f1d7f11eb95\\", \\"status\\": \\"APPLIED\\", \\"schemaVerified\\": true, \\"appliedMigrationsSha256\\": \\"792ed62e35a3110ae1a0e4dec9d1d8a67430972d8bd9f7b9c2f7ff1d0a679088\\", \\"performed\\": false}, \\"migrationAttempted\\": false, \\"inverseMigrationPerformed\\": false, \\"mediaVolumeDeleted\\": false, \\"currentPointsToCandidate\\": false, \\"receiptPersisted\\": true}\\n",\n  "standardErrorBytes": 37,\n  "standardErrorSha256": "08025ada7b927f2b1e3d41b1a64c9d6bfe5880a375645f340a42137a3d3de3b3"\n}\n'}
_RESTORED_B_FIELD = 'afterBitRestoration'
_RESTORED_B_CODE = 'ONLINE_RECHARGE_B_RESTORE_MATERIAL_CHANGED'
_WORKSPACE_CAPACITY_CONTROL_POLICY = {'kind': 'ONLINE_RECHARGE_FIXED_CAPACITY_CONTROL_MAPPING', 'version': 1, 'baselineOriginSha256': '4b81b0d398de0c4b0198803950354c286f7107a8a19b99e519d5404007b0c1ca', 'files': {'.github/workflows/production-release.yml': {'before': {'mode': '100644', 'bytes': 270930, 'sha256': '22f57d24c7b5712cf454cde428e9e09f86d29ce63de4a2b7309ea9c483b0a95f'}, 'after': {'mode': '100644', 'bytes': 280322, 'sha256': 'cc839f9555051b5b103050e9ea0a0243fa600d0f401a86a60ddd51f56c348324'}}, 'scripts/production-release/maintain-image-cache.py': {'before': {'mode': '100644', 'bytes': 95264, 'sha256': '696099662a0ef6d2b646fa67d3949e3a8633b2f4c90478c895e8af4055d0bf3f'}, 'after': {'mode': '100644', 'bytes': 131394, 'sha256': '9e77b6448a613f206237144f786c307c906fcff34a67173d0f62b6612537e79a'}}, 'scripts/production-release/maintain-image-cache.test.py': {'before': {'mode': '100644', 'bytes': 132058, 'sha256': '48ecd690afffce133dae9a9da8012d2afd9e9646728eeb9da7c58a59f6d7d67e'}, 'after': {'mode': '100644', 'bytes': 181946, 'sha256': 'a15b0477389f255633b6f384c0857073cecde82ef3711ef905905a50fc7b193d'}}, 'scripts/production-release/service-image-retention.py': {'before': {'mode': '100644', 'bytes': 12921, 'sha256': '0e4b8e4fd6ce0cc3928e8e938a50847ccb1953fd6f0fddc9a176171b8d557e1d'}, 'after': {'mode': '100644', 'bytes': 16748, 'sha256': '72f8932cc4f29e24071439286aa6f7e5125876789cab95904dddde6b1c2ba198'}}, 'scripts/production-release/service-image-retention.test.py': {'before': {'mode': '100644', 'bytes': 12111, 'sha256': 'c34f27e6c822828b0a75445c100aa12d23a1fa85f47b722ffa327504fff954f6'}, 'after': {'mode': '100644', 'bytes': 24682, 'sha256': '427440c40ff9288291234f4bae89f0b15445a01808e563754732522846ebe1fe'}}}}
_WORKSPACE_RELEASE_RULES_POLICY = {'kind': 'ONLINE_RECHARGE_FIXED_RELEASE_RULES_MAPPING', 'version': 1, 'baselineOriginSha256': '4b81b0d398de0c4b0198803950354c286f7107a8a19b99e519d5404007b0c1ca', 'files': {'AGENTS.md': {'after': {'bytes': 11154, 'mode': '100644', 'sha256': 'ca02346af72d53f166aadb76c221c8aefbc11755f9f758946c426cc2855e4f18'}, 'before': {'bytes': 10224, 'mode': '100644', 'sha256': '4095fddefee98a6b8b3f67f80f31496e4fc3cc42e2b3846b3c464a23e467c06c'}}, 'docs/CENTRAL_RELEASE_20261002.md': {'after': {'bytes': 4413, 'mode': '100644', 'sha256': 'f4e9a287e319f2d1a1702f123b7b0b726310ff4954c92c7aa90b5019b02f22e4'}, 'before': {'bytes': 3812, 'mode': '100644', 'sha256': '643f1beba19afbb616ad421cd2d93cb789142478f5cb7135bf315faa68f968f6'}}}}
_RESTORED_FAILED_C_BANK_SOURCE_PAIRS = {'scripts/lib/v2-production-database-access.mjs': ('7ece1de5cbba89b26615d749a671d32a380f4dc377548071746d14f1f2e2a546', '36bfe57d9fd802fc647d09dd8871f1af4cee6cd03a68bf05a2509dd0e554570d'), 'scripts/production-database-access.test.mjs': ('eb2ea9b434ea744589ce2210fcbd501b54bedcda05e614521aab9b30be002590', 'd914b4646ced503e432697b410b9dcbbf07d9087375ba0e6ea41df8b7a9c5000'), 'scripts/acceptance-v2-production-database-access.mjs': ('15adadb670cdbd7645761b161f487b74550b271455289e60a97108e9e4ac46f1', 'd39b620aa33ac21cecc0b9229dc0cc59967af1e890ea65c4e61d20fb1dbe269e'), 'scripts/production-release/api-admin-scope.test.py': ('551b052262643dc8b9ccb9cd56a08bc0b566dab03e634643517fe3ce3c168b06', 'bec32298136ff61d8e69820179b8c3f51f8e5221f4e6b449aaf5f5ec8f7d4625'), 'scripts/production-release/online-recharge-scope.test.py': ('4aa063af4054ff98d2bb622056556ab643ed39abb3d373facc636509ff98ad8e', '59f3221f1326865a958f6f50fd0fb5211c3f2ee29ca915884f05202d426cf5d2')}


_RESTORED_FAILED_C_RELEASE_CI_FILES = {
    'scripts/ci-recharge-scope.mjs': ('3fe9c33ea883b7e2ad15305d1c7fe26873ddf648645b7a05acc8aecd5f858cfd', '04c8451b64ebf75755a108761a1a73430e4f31e807f7bb4f356b790417ee7ec1'),
    'scripts/ci-recharge-scope.test.mjs': ('f7df520b417f7d681050073e5e8b9cd882effebd10a458a7afc620a39ab17550', 'b487febe298fd3934dfe7c02d3fd610e99300f17712463daa958660aa2e51934'),
    'scripts/ci-recharge-check.mjs': ('8863a78075b234faa0b048c56277bff81f7df88ad72d6261bc5493f08d525932', '96153e6f010d7a6c9b1028ea3d95d91ad1b321f5ab04768011fddb9819790ff7'),
    'scripts/ci-recharge-check.test.mjs': ('53e1376a2e36d3f492075547d4a0ceb8e65a915cec0c572ac6952356b045ea04', '0ff6dca9335d102fcdacfd7c0a9ad2ecafc245aa086d2cbda4655f58ff1b6767'),
}

def _restored_workspace_failed_source_inventory(d,bridge,producer):
    """Complete authentic failed-C Git archive, usable by native F and CI.

    No fabricated private path or snapshot permits this archived source proof.
    Original failed five-file mapping is distinct from the later candidate's
    updated ONLINE test after pin and capacity mapping.
    """
    code='ONLINE_RECHARGE_B_RESTORE_FAILED_SOURCE_CHANGED'
    original=_pending_workspace_current_source_inventory(d,bridge['baselineProducer'])
    inventory=_pending_workspace_current_source_inventory(d,producer)
    bank=_RESTORED_FAILED_C_BANK_SOURCE_PAIRS
    ci=frozenset(_RESTORED_FAILED_C_RELEASE_CI_FILES)
    d.require(producer==_RESTORED_B_WITNESS['policy']['failedProducer']
        and type(bank) is dict and set(bank)==set(_AFTER_BIT_BANK_POLICY_FILES)
        and ci==frozenset(_AFTER_BIT_RELEASE_CI_FILES)
        and all(original.get(n)=={'sha256':before,'mode':'100644'}
            and inventory.get(n)=={'sha256':after,'mode':'100644'}
            for n,(before,after) in _RESTORED_FAILED_C_RELEASE_CI_FILES.items()),code)
    compatible=_PENDING_WORKSPACE_RECEIPT_COMPATIBILITY_FILES|frozenset(bank)|ci
    d.require(set(original)==set(inventory)
        and all(original.get(name)=={'sha256':before,'mode':'100644'}
            and inventory.get(name)=={'sha256':after,'mode':'100644'}
            for name,(before,after) in bank.items())
        and all(original[name]==inventory[name] for name in original if name not in compatible)
        and all(original[name]['mode']==inventory[name]['mode']
            for name in _PENDING_WORKSPACE_RECEIPT_COMPATIBILITY_FILES),code)
    return inventory


def _restored_workspace_native_failure_anchor(d):
    policy=_RESTORED_B_WITNESS['policy'];directory=Path(policy['failedRelease'])
    d.require(directory.parent==d.BASE/'releases' and directory.resolve()==directory and not directory.is_symlink(),
        _RESTORED_B_CODE)
    for name,sha in policy['failedSourceHelpers'].items():
        _restored_workspace_failed_helper_bytes(d,directory,name)
    failure=_declaration_source_bytes(directory/'online-recharge-failure.json',limit=16384)
    expected=closed_recovery_json(d,closed_recovery_json(d,_RESTORED_B_WITNESS['failedNativeFailure'].encode())['StandardOutputContent'].encode())
    d.require(closed_recovery_json(d,failure)==expected and fingerprint(expected)==policy['failureCanonicalSha256']
        and hashlib.sha256(failure).hexdigest()=='a1174623f13b3801b8fbea6b03387b03531f8164755a34fb785561006193d160',
        _RESTORED_B_CODE)
    return fingerprint({'sourceHelpers':policy['failedSourceHelpers'],'failureBytesSha256':hashlib.sha256(failure).hexdigest()})


def _restored_workspace_failed_helper_bytes(d,directory,name):
    sizes={'scripts/production-release/api-admin-scope.py':402206,
        'scripts/production-release/online-recharge-scope.py':314958,
        'scripts/production-release/remote-deploy.py':1136742}
    hashes=_RESTORED_B_WITNESS['policy']['failedSourceHelpers']
    d.require(name in sizes and name in hashes,_RESTORED_B_CODE)
    raw=_declaration_source_bytes(directory/name,limit=sizes[name])
    d.require(len(raw)==sizes[name] and (directory/name).stat().st_size==sizes[name]
        and hashlib.sha256(raw).hexdigest()==hashes[name],_RESTORED_B_CODE)
    return raw


def _workspace_fixed_mapping_inventory(d,bridge,original,inventory,policy,kind,names):
    if policy is None:return frozenset()
    code='ONLINE_RECHARGE_FIXED_CONTROL_SOURCE_CHANGED'
    d.require(type(policy) is dict and set(policy)=={'kind','version','baselineOriginSha256','files'}
        and policy['kind']==kind and type(policy['version']) is int and policy['version']==1
        and type(policy['files']) is dict and set(policy['files'])==set(names),code)
    files=policy['files'];changed={n for n in files if original.get(n)!=inventory.get(n)}
    if not changed:return frozenset()
    # An unchanged group grants no exception; retain the ordinary bank-only path.
    d.require(policy['baselineOriginSha256']==fingerprint(bridge) and bridge['kind']==ONLINE_AFTER_BIT_KIND,code)
    _workspace_bridge_shape(d,bridge,ONLINE_AFTER_BIT_KIND)
    d.require(changed==set(files),code)
    for side,values,producer in (('before',original,bridge['baselineProducer']),
        ('after',inventory,_pending_workspace_producer(d))):
        # The caller acquired each complete archive and verified its real Git tree.
        raw=getattr(d,'_onlinePendingWorkspaceArchiveBytes',{}).get((producer['commit'],producer['sourceTree']))
        d.require(type(raw) is bytes,code)
        prefix='id-business-system-'+producer['commit']+'/'
        with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as archive:
            for name,pair in files.items():
                d.require(type(pair) is dict and set(pair)=={'before','after'},code)
                expected=pair[side]
                d.require(type(expected) is dict and set(expected)=={'sha256','mode','bytes'}
                    and _declaration_hash(expected['sha256']) and expected['mode']=='100644'
                    and type(expected['bytes']) is int and 0<expected['bytes']<512*1024
                    and values.get(name)=={k:expected[k] for k in ('sha256','mode')},code)
                row=archive.getmember(prefix+name)
                data=archive.extractfile(row).read(expected['bytes']+1)
                d.require(row.isfile() and row.size==len(data)==expected['bytes'] and row.mode&0o111==0
                    and hashlib.sha256(data).hexdigest()==expected['sha256'],code)
    return frozenset(files)


def _workspace_capacity_control_inventory(d,bridge,original,inventory):
    return _workspace_fixed_mapping_inventory(d,bridge,original,inventory,_WORKSPACE_CAPACITY_CONTROL_POLICY,
        'ONLINE_RECHARGE_FIXED_CAPACITY_CONTROL_MAPPING',('.github/workflows/production-release.yml',
        'scripts/production-release/maintain-image-cache.py','scripts/production-release/maintain-image-cache.test.py',
        'scripts/production-release/service-image-retention.py','scripts/production-release/service-image-retention.test.py'))


def _workspace_release_rules_inventory(d,bridge,original,inventory):
    return _workspace_fixed_mapping_inventory(d,bridge,original,inventory,_WORKSPACE_RELEASE_RULES_POLICY,
        'ONLINE_RECHARGE_FIXED_RELEASE_RULES_MAPPING',('AGENTS.md','docs/CENTRAL_RELEASE_20261002.md'))


def _restored_workspace_materials(d, bridge):
    """Source-pinned, single failure / independent observation; no UUID issuer."""
    witness = _RESTORED_B_WITNESS
    d.require(type(witness) is dict and set(witness) == {'policy', 'observationInvocation',
        'failedPreflight', 'failedBuildProof', 'failedNativeFailure'},
        'ONLINE_RECHARGE_B_RESTORE_WITNESS_UNAVAILABLE')
    policy = witness['policy']
    raw = {n: witness[n].encode() for n in ('observationInvocation', 'failedPreflight',
        'failedBuildProof', 'failedNativeFailure')}
    d.require(all(type(witness[n]) is str and 0 < len(raw[n]) < 65536 for n in raw), _RESTORED_B_CODE)
    observed = _restore_pure_validate_observation_material(bridge, raw['observationInvocation'], policy)
    _restored_qualified_oom_history(d,observed)
    failed = policy['failedProducer']
    d.require(failed == _restore_events_FAILED_PRODUCER
        and policy['failedCommandId'] == 'c03fdc8a-9f39-40e5-8181-0071b3bc8f89'
        and policy['failedNativeEnd'] == _restore_events_FAILED_END
        and policy['originalBootStartedAt'] == '2026-10-11T13:37:28.606112575Z', _RESTORED_B_CODE)
    # Full original B/Q_A/Q_B cold validation and full failed-C source archive
    # qualification remain mandatory. These are not diagnostic summary bools.
    inventory = _restored_workspace_failed_source_inventory(d,bridge,failed)
    d.require(all(inventory[name]['sha256'] == sha for name, sha in policy['failedSourceHelpers'].items()),
        _RESTORED_B_CODE)
    d.require(hashlib.sha256(raw['failedPreflight']).hexdigest() == policy['failedPreflightBytesSha256'],
        _RESTORED_B_CODE)
    _workspace_preflight_binding(d, raw['failedPreflight'], producer=failed, bridge=bridge, kind=ONLINE_AFTER_BIT_KIND)
    proof = closed_recovery_json(d, raw['failedBuildProof'])
    _workspace_build_shape(d, proof, producer=failed, bridge=bridge,
        preflight_raw=raw['failedPreflight'], kind=ONLINE_AFTER_BIT_KIND)
    d.require(fingerprint(proof) == policy['failedBuildProofSha256'] == _restore_events_FAILED_PROOF_SHA,
        _RESTORED_B_CODE)
    failure = closed_recovery_json(d, raw['failedNativeFailure'])
    receipt = closed_recovery_json(d, failure.get('StandardOutputContent', '').encode())
    d.require(failure.get('CommandId') == policy['failedCommandId']
        and failure.get('InstanceId') == policy['instanceId'] and failure.get('Status') == 'Failed'
        and type(failure.get('ResponseCode')) is int and failure['ResponseCode'] == 1
        and failure.get('ExecutionStartDateTime') == _restore_events_FAILED_START
        and failure.get('ExecutionEndDateTime') == _restore_events_FAILED_END
        and hashlib.sha256(failure['StandardOutputContent'].encode()).hexdigest()
            == 'a973effc90e3b0d6e68489bd2f0472f0309ee2feb78344ea07e2c28c6bc1fef6'
        and receipt.get('status') == 'ONLINE_RECHARGE_FAILED_RESTORED'
        and receipt.get('candidateCommit') == failed['commit'] and receipt.get('previousCommit') == bridge['baselineCommit']
        and receipt.get('code') == 'API_ADMIN_WORKSPACE_GUARD_TIMEOUT' and receipt.get('step') == 'switch'
        and receipt.get('rollback') == {'api': 'RESTORED', 'admin': 'RESTORED'}
        and receipt.get('rollbackOk') is True and receipt.get('currentPointsToCandidate') is False
        and all(receipt.get(n) is False for n in ('migrationAttempted', 'inverseMigrationPerformed', 'mediaVolumeDeleted'))
        and receipt.get('migration') == {**bridge['migrationState'], 'performed': False}, _RESTORED_B_CODE)
    return observed, proof


def _restored_workspace_sidecar(d, bridge, value, services):
    """New typed B path: historical API hash stays historical, full source match separate."""
    observed, unused = _restored_workspace_materials(d, bridge)
    fields = {'kind','version','baselineOriginSha256','observationSha256','actualServicesSha256',
        'configurationProofSha256','historyApiIdentity','stopApiIdentity','publicationQualified',
        'configurationMaterials','apiDeclarationQualification'}
    d.require(type(value) is dict and set(value)==fields
        and value['kind']=='ONLINE_RECHARGE_B_RESTORE_COMPLETE_MATERIAL'
        and type(value['version']) is int and value['version']==2 and value['publicationQualified'] is False
        and services==observed['currentServices'] and value['baselineOriginSha256']==fingerprint(bridge)
        and value['observationSha256']==fingerprint(observed) and value['actualServicesSha256']==fingerprint(services)
        and type(value['configurationMaterials']) is dict and set(value['configurationMaterials'])=={'admin'},
        _RESTORED_B_CODE)
    m=value['configurationMaterials']['admin']
    d.require(type(m) is dict and set(m)=={'kind','version','service','actualServiceSha256',
        'originalServiceSha256','actualConfigurationSha256','originalConfigurationSha256',
        'reconstructedConfigurationSha256','changedIdentityPaths','hostnameMappingSha256',
        'replaceMappingSha256','acquiredReplaceAnchorsSha256'} and m['kind']=='ONLINE_RECHARGE_B_RESTORE_COMPLETE_CONFIGURATION_MATERIAL'
        and type(m['version']) is int and m['version']==1 and m['service']=='admin'
        and all(_declaration_hash(v) for k,v in m.items() if k.endswith('Sha256'))
        and m['actualServiceSha256']==fingerprint(services['admin'])
        and m['originalServiceSha256']==fingerprint(bridge['services']['admin'])
        and m['actualConfigurationSha256']==services['admin']['configurationSha256']
        and m['reconstructedConfigurationSha256']==m['originalConfigurationSha256']==bridge['services']['admin']['configurationSha256']
        and m['changedIdentityPaths']==['Config.Hostname','Config.Labels.com.docker.compose.replace']
        and m['hostnameMappingSha256']==fingerprint({'actual':services['admin']['containerId'][:12],
            'original':bridge['services']['admin']['containerId'][:12]}),_RESTORED_B_CODE)
    proof=value['apiDeclarationQualification'];caps=_restored_qualified_capabilities(d)
    _restored_qualified_proof(d,caps,proof,bridge,services,m)
    d.require(proof['purpose']=='INDEPENDENT_PREFLIGHT'
        and value['configurationProofSha256']==fingerprint({'admin':m,'api':proof})
        and value['historyApiIdentity']=={**{n:bridge['services']['api'][n] for n in
            ('containerId','image','startedAtSha256')},'startedAt':observed['originalApiStartedAt']}
        and value['stopApiIdentity']=={**{n:services['api'][n] for n in
            ('containerId','image','startedAtSha256')},'startedAt':observed['sourceApiStartedAt']},_RESTORED_B_CODE)
    return value


def _restored_workspace_native_before(d, previous, bridge):
    """Original complete qualified reference comparison; only Admin maps old full hash."""
    observed, failed_proof = _restored_workspace_materials(d, bridge)
    failure_anchor=_restored_workspace_native_failure_anchor(d)
    _workspace_after_bit_materials(d, previous, bridge=bridge)
    reader = legacy(d);services=observed['currentServices']
    d.require((d.BASE/'current').resolve()==previous and str(previous)==bridge['baselineRelease']
        and snapshot(d,previous)==services and configuration_hashes(previous)==bridge['configurationAfter'],
        'ONLINE_RECHARGE_BASELINE_MOVED')
    old_record=closed_recovery_json(d,_declaration_source_bytes(previous/reader.STATE_FILE))
    meta=closed_recovery_json_list(d,d.run('docker','inspect',services['admin']['containerId'],timeout=5).encode())
    d.require(len(meta)==1,_RESTORED_B_CODE)
    admin=_restore_cfg_complete_configuration_material('admin',meta[0],services['admin'],bridge['services']['admin'],
        original_before_container_id=old_record['before']['admin']['containerId'],
        acquired_actual_replace_anchors=[bridge['services']['admin']['containerId']])
    seed=getattr(d,'_restoredWorkspacePreflight',None)
    first=None if seed is None else seed['restoration']['apiDeclarationQualification']
    proof=_restored_workspace_qualification_call(
        lambda:_restored_qualified_measure(d,previous,bridge,services,admin,first=first),
        owner=d)
    if seed is None:
        sidecar={'kind':'ONLINE_RECHARGE_B_RESTORE_COMPLETE_MATERIAL','version':2,
            'baselineOriginSha256':fingerprint(bridge),'observationSha256':fingerprint(observed),
            'actualServicesSha256':fingerprint(services),'configurationProofSha256':fingerprint({'admin':admin,'api':proof}),
            'historyApiIdentity':{**{n:bridge['services']['api'][n] for n in ('containerId','image','startedAtSha256')},
                'startedAt':observed['originalApiStartedAt']},
            'stopApiIdentity':{**{n:services['api'][n] for n in ('containerId','image','startedAtSha256')},
                'startedAt':observed['sourceApiStartedAt']},'publicationQualified':False,
            'configurationMaterials':{'admin':admin},'apiDeclarationQualification':proof}
    else:
        d.require(seed['services']==services and seed['baseline']==bridge
            and seed['restoration']['configurationMaterials']['admin']==admin,_RESTORED_B_CODE)
        sidecar=seed['restoration'];d._restoredWorkspaceDeploymentQualification=proof
    _restored_workspace_sidecar(d,bridge,sidecar,services)
    d.require(snapshot(d,previous)==services and (d.BASE/'current').resolve()==previous
        and _restored_workspace_native_failure_anchor(d)==failure_anchor,_RESTORED_B_CODE)
    return sidecar,services


def closed_recovery_json_list(d, raw):
    # Dedicated native inspect list parser; original object parser is unchanged.
    def pairs(items):
        result={}
        for key,value in items:
            d.require(key not in result,_RESTORED_B_CODE);result[key]=value
        return result
    value=json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda unused:d.require(False,_RESTORED_B_CODE))
    d.require(type(value) is list and all(type(row) is dict for row in value),_RESTORED_B_CODE)
    return value


_RESTORED_B_COLD_IMAGE_CACHE = {
    '0a03fa28e6b844a18833d5c63f1de700f091fc64-37918150573-1-admin': ('sha256:9e2092779d6c7acb9a854011d09040f8927cb010216cce4be65138a2a6471a30', '668ca1570a8e4898e7f473198087ec549c270239'),
    '0a03fa28e6b844a18833d5c63f1de700f091fc64-37918150573-1-api': ('sha256:74fdce6e4f05c10bd7f52f94fb9a53a36349bafd8ca8e2637d047f62a92bee42', '668ca1570a8e4898e7f473198087ec549c270239'),
    '28a3ba4ffd17d36001b1104c97394f5ae871d73d-37933246605-1-admin': ('sha256:d3bd11533809817405a2b23e177ee3f22c08825f920db0102248996a188999e9', '014959a59519da585928adaa7f76f7236e1786d1'),
    '28a3ba4ffd17d36001b1104c97394f5ae871d73d-37933246605-1-api': ('sha256:e2e2db4fdf3b39ac1742d816ff943630765c22ef7260730c86762f1de2229cfe', '014959a59519da585928adaa7f76f7236e1786d1'),
    '28a3ba4ffd17d36001b1104c97394f5ae871d73d-37933246605-1-migrate': ('sha256:0f98d36ae15ae80efe9a09609f826b5aa8ebaee2b851c386d8260b67aa144140', '014959a59519da585928adaa7f76f7236e1786d1'),
    '296c096af7c4c79a8ffc2f57d9a15ea75684f431-37944613453-1-admin': ('sha256:fe78934db0a717dfc5dd5752d6a96118d72662e994f7d418fa6ae43afce0ac85', '472947076a5b5fb73d6777413505d60ac2379fb1'),
    '296c096af7c4c79a8ffc2f57d9a15ea75684f431-37944613453-1-api': ('sha256:34ba5b3a31bf4d82900d481a9f5d7b061834400adcab1458f1c0bbbb8b7eca5e', '472947076a5b5fb73d6777413505d60ac2379fb1'),
    '296c096af7c4c79a8ffc2f57d9a15ea75684f431-37944613453-1-migrate': ('sha256:51f80ed0fd62cfd767e31dd52ef53dcafa8565531c950d66d4c52962df89617a', '472947076a5b5fb73d6777413505d60ac2379fb1'),
}


def _restored_workspace_cold_cache(d, directory, expected):
    """Acquire only eight exact cold-proof images; never start or replace services."""
    code = 'ONLINE_RECHARGE_HISTORICAL_IMAGE_CACHE_CHANGED'
    d.require(expected == '31d2c6885a45817cd40d23fce8d6145bc9f18af2'
        and type(_RESTORED_B_WITNESS) is dict, code)
    bridge = closed_recovery_json(d, _RESTORED_B_WITNESS['failedPreflight'].encode())['baseline']
    d.require(directory == (d.BASE/'current').resolve() == Path(bridge['baselineRelease'])
        and hashlib.sha256(_declaration_source_bytes(directory/'release-manifest.json')).hexdigest()
        == bridge['manifestBytesSha256'], code)
    key = fingerprint(_RESTORED_B_COLD_IMAGE_CACHE)
    if getattr(d, '_restoredWorkspaceColdCacheReady', None) == key:
        return
    repository = '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'
    deadline = time.monotonic() + 120

    def bounded(method, *command, **kwargs):
        remaining = min(60, deadline-time.monotonic())
        d.require(remaining > 0, 'ONLINE_RECHARGE_HISTORICAL_IMAGE_CACHE_TIMEOUT')
        requested = kwargs.get('timeout', remaining)
        d.require(type(requested) in (int, float) and requested > 0, code)
        kwargs['timeout'] = min(requested, remaining)
        try:
            value = method(*command, **kwargs)
        except subprocess.TimeoutExpired:
            raise RuntimeError('ONLINE_RECHARGE_HISTORICAL_IMAGE_CACHE_TIMEOUT') from None
        except Exception:
            phase = ('ECR_AUTH' if command[:3] == ('aws', 'ecr', 'get-login-password') else
                'ECR_READ' if command[:3] == ('aws', 'ecr', 'batch-get-image') else
                'IMAGE_INSPECT' if command[:3] in (('docker', 'image', 'ls'), ('docker', 'image', 'inspect'))
                else 'SERVICE_SNAPSHOT')
            raise RuntimeError('ONLINE_RECHARGE_HISTORICAL_IMAGE_CACHE_' + phase + '_FAILED') from None
        d.require(time.monotonic() < deadline, 'ONLINE_RECHARGE_HISTORICAL_IMAGE_CACHE_TIMEOUT')
        return value

    def run(*command):
        return bounded(d.run, *command)

    class TimedSnapshotController:
        def run(self, *command, **kwargs):
            return bounded(d.run, *command, **kwargs)

        def compose(self, *command, **kwargs):
            return bounded(d.compose, *command, **kwargs)

        def __getattr__(self, name):
            original = getattr(d, name)
            if name not in ('production_services', 'service_state'):
                return original
            # Keep the original implementations without their unbounded globals.
            from types import FunctionType
            d.require(type(original) is FunctionType, code)
            namespace = {**original.__globals__, 'run': self.run, 'compose': self.compose}
            copied = FunctionType(original.__code__, namespace, original.__name__,
                original.__defaults__, original.__closure__)
            copied.__kwdefaults__ = original.__kwdefaults__
            return copied

    timed = TimedSnapshotController()

    def service_snapshot():
        try:
            return snapshot(timed, directory)
        except Exception as error:
            if type(error) is RuntimeError and len(error.args) == 1 and type(error.args[0]) is str \
                    and error.args[0].startswith('ONLINE_RECHARGE_HISTORICAL_IMAGE_CACHE_'):
                raise
            raise RuntimeError('ONLINE_RECHARGE_HISTORICAL_IMAGE_CACHE_SERVICE_SNAPSHOT_FAILED') from None

    before = service_snapshot()
    d.require(time.monotonic() < deadline, 'ONLINE_RECHARGE_HISTORICAL_IMAGE_CACHE_TIMEOUT')

    def guard():
        d.require((d.BASE/'current').resolve() == directory
            and hashlib.sha256(_declaration_source_bytes(directory/'release-manifest.json')).hexdigest()
            == bridge['manifestBytesSha256'], code)

    def inspect(tag, image, tree):
        raw = run('docker', 'image', 'inspect', repository + ':' + tag)
        value = closed_recovery_json_list(d, raw.encode())
        d.require(len(value) == 1 and value[0].get('Id') == image
            and value[0].get('Architecture') == 'amd64'
            and value[0].get('Config', {}).get('Labels', {}).get('org.opencontainers.image.revision') == tag[:40]
            and value[0].get('Config', {}).get('Labels', {}).get('id-business-v2.source-tree') == tree, code)

    missing = []
    for tag, (image, tree) in _RESTORED_B_COLD_IMAGE_CACHE.items():
        ids = run('docker', 'image', 'ls', '--no-trunc', '--filter', 'reference=' + repository + ':' + tag,
            '--format', '{{.ID}}').splitlines()
        d.require(ids in ([], [image]), code)
        if ids:
            inspect(tag, image, tree)
        else:
            missing.append(tag)
    if missing:
        # Recheck every missing immutable ECR config digest before the first pull.
        raw = run('aws', 'ecr', 'batch-get-image', '--region', 'ap-northeast-1', '--repository-name',
            'id-business-v2-release', '--image-ids', *('imageTag=' + tag for tag in missing), '--output', 'json')
        remote = closed_recovery_json(d, raw.encode())
        rows = remote.get('images')
        d.require(remote.get('failures') == [] and type(rows) is list and len(rows) == len(missing), code)
        found = {}
        for row in rows:
            tag = row.get('imageId', {}).get('imageTag')
            d.require(tag in missing and tag not in found and row.get('repositoryName') == 'id-business-v2-release'
                and type(row.get('imageManifest')) is str, code)
            manifest = closed_recovery_json(d, row['imageManifest'].encode())
            d.require(manifest.get('schemaVersion') == 2 and manifest.get('config', {}).get('digest')
                == _RESTORED_B_COLD_IMAGE_CACHE[tag][0], code)
            found[tag] = True
        d.require(set(found) == set(missing), code)
        # Registry credentials stay in memory; never write Docker configuration
        # or pass a token through command arguments, environment or receipts.
        password = run('aws', 'ecr', 'get-login-password', '--region', 'ap-northeast-1').strip()
        d.require(bool(password) and '\n' not in password and '\r' not in password,
            'ONLINE_RECHARGE_HISTORICAL_IMAGE_CACHE_ECR_AUTH_FAILED')
        authentication = base64.urlsafe_b64encode(json.dumps({'username': 'AWS', 'password': password,
            'serveraddress': repository.split('/')[0]}, separators=(',', ':')).encode()).decode()
        password = None

        def pull(tag):
            import http.client
            import socket
            from urllib.parse import urlencode
            pull_deadline = min(deadline, time.monotonic() + 60)

            def remaining():
                seconds = pull_deadline - time.monotonic()
                d.require(seconds > 0, 'ONLINE_RECHARGE_HISTORICAL_IMAGE_CACHE_TIMEOUT')
                return seconds

            class TimedSocket(socket.socket):
                def connect(self, address):
                    self.settimeout(remaining())
                    result = super().connect(address)
                    remaining()
                    return result

                def sendall(self, data, flags=0):
                    self.settimeout(remaining())
                    result = super().sendall(data, flags)
                    remaining()
                    return result

                def recv_into(self, buffer, nbytes=0, flags=0):
                    self.settimeout(remaining())
                    result = super().recv_into(buffer, nbytes, flags)
                    remaining()
                    return result

            class LocalDockerConnection(http.client.HTTPConnection):
                def connect(self):
                    self.sock = TimedSocket(socket.AF_UNIX, socket.SOCK_STREAM)
                    self.sock.connect('/var/run/docker.sock')

            connection = LocalDockerConnection('localhost', timeout=remaining())
            response = None
            try:
                connection.request('POST', '/images/create?' + urlencode({'fromImage': repository, 'tag': tag}),
                    headers={'X-Registry-Auth': authentication})
                response = connection.getresponse()
                remaining()
                d.require(response.status == 200, 'ONLINE_RECHARGE_HISTORICAL_IMAGE_CACHE_IMAGE_PULL_FAILED')
                progress = False
                while True:
                    remaining()
                    line = response.readline(65537)
                    remaining()
                    if not line:
                        break
                    d.require(len(line) <= 65536, 'ONLINE_RECHARGE_HISTORICAL_IMAGE_CACHE_IMAGE_PULL_FAILED')
                    row = closed_recovery_json(d, line)
                    d.require(not row.get('error') and not row.get('errorDetail'),
                        'ONLINE_RECHARGE_HISTORICAL_IMAGE_CACHE_IMAGE_PULL_FAILED')
                    progress = True
                d.require(progress and response.length in (None, 0)
                    and (not response.chunked or response.chunk_left is None),
                    'ONLINE_RECHARGE_HISTORICAL_IMAGE_CACHE_IMAGE_PULL_FAILED')
            except Exception as error:
                if isinstance(error, TimeoutError) or (type(error) is RuntimeError
                        and error.args == ('ONLINE_RECHARGE_HISTORICAL_IMAGE_CACHE_TIMEOUT',)):
                    raise RuntimeError('ONLINE_RECHARGE_HISTORICAL_IMAGE_CACHE_TIMEOUT') from None
                raise RuntimeError('ONLINE_RECHARGE_HISTORICAL_IMAGE_CACHE_IMAGE_PULL_FAILED') from None
            finally:
                try:
                    if response is not None:
                        response.close()
                finally:
                    connection.close()

        for tag in missing:
            guard()
            d.require(shutil.disk_usage(d.BASE).free > 6 * 1024**3,
                'ONLINE_RECHARGE_HISTORICAL_IMAGE_CACHE_DISK_TOO_LOW')
            pull(tag)
            inspect(tag, *_RESTORED_B_COLD_IMAGE_CACHE[tag])
            d.require(shutil.disk_usage(d.BASE).free > 6 * 1024**3,
                'ONLINE_RECHARGE_HISTORICAL_IMAGE_CACHE_DISK_TOO_LOW')
        authentication = None
    guard()
    d.require(service_snapshot() == before, code)
    d.require(time.monotonic() < deadline, 'ONLINE_RECHARGE_HISTORICAL_IMAGE_CACHE_TIMEOUT')
    d._restoredWorkspaceColdCacheReady = key


def _restored_workspace_cold_origin(d, cold, directory, expected):
    """Keep the original cold validator; expose only its failed source location."""
    try:
        return cold(d, directory, expected_commit=expected)
    except RuntimeError as error:
        if error.args != ('ONLINE_RECHARGE_AFTER_BIT_ORIGIN_CHANGED',):
            raise
        cause, seen = error, set()
        while cause.__context__ is not None and id(cause) not in seen:
            seen.add(id(cause))
            cause = cause.__context__
        frame, location = cause.__traceback__, None
        while frame is not None:
            filename = Path(frame.tb_frame.f_code.co_filename).name
            function = frame.tb_frame.f_code.co_name
            if filename in ('api-admin-scope.py', 'online-recharge-scope.py') \
                    and function != '_restored_workspace_cold_origin' \
                    and re.fullmatch('[a-z_][a-z0-9_]{0,95}', function) \
                    and type(frame.tb_lineno) is int and 0 < frame.tb_lineno < 100000:
                location = (function.upper()[:48], frame.tb_lineno)
            frame = frame.tb_next
        if location is None:
            raise
        # Exception values, inspected data, paths and source text are never emitted.
        kind = type(cause).__name__ if type(cause) in (RuntimeError, ValueError, TypeError,
            KeyError, OSError, FileNotFoundError) else 'Error'
        function, line = location
        raise RuntimeError('ONLINE_RECHARGE_AFTER_BIT_ORIGIN_CHANGED_AT_' + function
            + '_L' + str(line) + '_' + kind.upper()) from None


def _restored_workspace_begin(d, expected, producer):
    previous = (d.BASE/'current').resolve()
    reader = _pending_workspace_reader(d)
    kind, cold = _workspace_baseline_reader(d, reader, previous, live=False)
    d.require(kind == ONLINE_AFTER_BIT_KIND, _RESTORED_B_CODE)
    _restored_workspace_cold_cache(d, previous, expected)
    bridge = _restored_workspace_cold_origin(d, cold, previous, expected)
    online_after_bit_bridge_shape(d, bridge)
    _pending_workspace_profile(d, bridge, producer)
    d._onlinePendingWorkspaceProducer = producer
    sidecar, services = _restored_workspace_native_before(d, previous, bridge)
    d._onlinePendingWorkspaceSession = {'bridge': bridge, 'producer': producer,
        'restoration': sidecar, 'beforeServices': services,
        **({'deploymentQualification':d._restoredWorkspaceDeploymentQualification}
            if getattr(d,'_restoredWorkspacePreflight',None) is not None else {})}
    return previous, bridge


def _restored_workspace_session(d, saved, expected, producer):
    d.require(type(saved) is dict and set(saved) in ({'bridge','producer','restoration','beforeServices'},
        {'bridge','producer','restoration','beforeServices','deploymentQualification'}),
        _RESTORED_B_CODE)
    reader = _pending_workspace_reader(d)
    bridge = reader.online_after_bit_cold(d, Path(saved['bridge']['baselineRelease']),
        expected_commit=saved['bridge']['baselineCommit'])
    d.require(bridge == saved['bridge'] and producer == saved['producer']
        and (expected is None or expected == bridge['baselineCommit']), _RESTORED_B_CODE)
    _pending_workspace_profile(d, bridge, producer)
    _restored_workspace_sidecar(d, bridge, saved['restoration'], saved['beforeServices'])
    if 'deploymentQualification' in saved:
        caps=_restored_qualified_capabilities(d)
        _restored_qualified_pair(d,caps,saved['restoration']['apiDeclarationQualification'],
            saved['deploymentQualification'],bridge,saved['beforeServices'],saved['restoration']['configurationMaterials']['admin'])
    return bridge, producer


def _restored_workspace_baseline(d, expected):
    previous, bridge = _restored_workspace_begin(d, expected, _pending_workspace_producer(d))
    reader = legacy(d)
    saved = d._onlinePendingWorkspaceSession
    before = saved['beforeServices']
    manifest = closed_recovery_json(d, _declaration_source_bytes(previous/'release-manifest.json'))
    record = closed_recovery_json(d, _declaration_source_bytes(previous/reader.STATE_FILE))
    proof = reader.validate_proof(d, closed_recovery_json(d, _declaration_source_bytes(previous/reader.PROOF_FILE)),
        expected, bridge['baselineProducer']['sourceTree'])
    reader.verify_running(d, previous, proof)
    volume = workspace_guard(d, previous, record.get('workspaceVolumeAfter'))
    reader.workspace_health(d, previous)
    protection = reader.workspace_sqlite_receipt(d, previous, proof, record, manifest)
    if protection is None:
        reader.workspace_backup_receipt(d, previous, record)
    guards = jobs_idle(d, previous, migrated=True)
    recovery = release_recovery(d, previous)
    verify_permission_seed(d, recovery['source']); require_fresh_resources(d, recovery['source'])
    evidence = {**({'migrationOrigin': record['baselineEvidence']['migrationOrigin']}
        if record['baselineEvidence'].get('migrationOrigin') is not None else {}),
        'manifestSha256': bridge['manifestBytesSha256'], 'environmentSha256': bridge['environmentFileSha256'],
        'apiSource': {'imageId': bridge['services']['api']['image'], 'revision': expected, 'kind': 'API_WORKSPACE_BUILD_PROVEN'},
        'guards': guards, 'workspaceIdle': True, 'workspaceVolume': volume,
        'workspaceOriginFiles': workspace_files(d, previous),
        'workspaceBuildProofSha256': bridge['buildProofCanonicalSha256'], 'migrationRecovery': bridge['migrationRecovery'],
        'onlineAfterBitOrigin': bridge, _RESTORED_B_FIELD: saved['restoration'], 'freeBytes': shutil.disk_usage(d.BASE).free}
    workspace_origin(d, previous, previous, evidence, before)
    d.require(evidence['freeBytes'] > 6*1024**3 and snapshot(d, previous) == before
        and (d.BASE/'current').resolve() == previous, 'ONLINE_RECHARGE_BASELINE_MOVED')
    return previous, manifest, before, evidence


def _restored_workspace_selected(d, expected):
    if expected != '31d2c6885a45817cd40d23fce8d6145bc9f18af2' or _RESTORED_B_WITNESS is None:
        return False
    reader = _pending_workspace_reader(d)
    directory = (d.BASE/'current').resolve()
    kind, cold = _workspace_baseline_reader(d, reader, directory, live=False)
    if kind != ONLINE_AFTER_BIT_KIND:
        return False
    _restored_workspace_cold_cache(d, directory, expected)
    bridge = _restored_workspace_cold_origin(d, cold, directory, expected)
    # Unrestored B keeps its original live/identity path byte-for-byte.
    return snapshot(d, directory) != bridge['services']


def _restored_workspace_preflight_binding(d, raw, producer, bridge):
    value = _restored_workspace_f_value(d, raw)
    _workspace_bridge_shape(d, bridge, ONLINE_AFTER_BIT_KIND)
    d.require(type(value) is dict and value.get('baseline') == bridge, _RESTORED_B_CODE)
    d._onlinePendingWorkspaceProducer=producer
    restore = _restored_workspace_sidecar(d, bridge, value.get('restoration'), value.get('services'))
    _restore_pure_restored_f_shape(value, bridge, producer, restore)
    _pending_workspace_pref_fields(d, value['ordinaryPreflight'])
    _pending_workspace_validate_receipt(d, value['ordinaryPreflight'], 'preflight', producer['commit'], bridge['baselineCommit'])
    d.require(value['ordinaryPreflight'].get(_RESTORED_B_FIELD) == restore
        and type(value['commandId']) is str and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value['commandId']),
        _RESTORED_B_CODE)
    d._restoredWorkspacePreflight=value
    d._restoredWorkspacePreflightRaw=raw
    return {'kind': 'ONLINE_RECHARGE_AFTER_BIT_RESTORED_PREFLIGHT_SEAL', 'version': 3,
        'bytesSha256': hashlib.sha256(raw).hexdigest(), 'commandId': value['commandId'],
        'baselineSha256': fingerprint(bridge), 'producer': producer, 'restorationSha256': fingerprint(restore)}


def _restored_workspace_build_shape(d, proof, producer, bridge, raw):
    _restored_workspace_preflight_binding(d, raw, producer, bridge)
    f = _restored_workspace_f_value(d, raw)
    fields = {'kind','version','scope','commit','sourceTree','baselineCommit','migration','images',
        'engineSourceSha256','composeSourceSha256','baselineOriginSha256','preflightBytesSha256',
        'restorationSha256','beforeServicesSha256'}
    d.require(type(proof) is dict and set(proof) == fields and type(proof['version']) is int and proof['version'] == 3
        and proof['kind'] == 'ONLINE_RECHARGE_AFTER_BIT_BUILD_PROOF' and proof['scope'] == SCOPE
        and proof['commit'] == producer['commit'] and proof['sourceTree'] == producer['sourceTree']
        and proof['baselineCommit'] == bridge['baselineCommit'] and proof['migration'] == MIGRATION_IDENTITY
        and proof['baselineOriginSha256'] == fingerprint(bridge)
        and proof['preflightBytesSha256'] == hashlib.sha256(raw).hexdigest()
        and proof['restorationSha256'] == fingerprint(f['restoration'])
        and proof['beforeServicesSha256'] == fingerprint(f['services'])
        and _declaration_hash(proof['engineSourceSha256']) and _declaration_hash(proof['composeSourceSha256'])
        and type(proof['images']) is dict and set(proof['images']) == set(IMAGE_SERVICES), _RESTORED_B_CODE)
    for name, row in proof['images'].items():
        d.require(type(row) is dict and set(row) == {'reference','imageId','fileCount','sha256'}
            and type(row['reference']) is str and re.fullmatch(
                '[0-9]{12}\\.dkr\\.ecr\\.ap-northeast-1\\.amazonaws\\.com/id-business-v2-release:'
                +producer['commit']+'-'+producer['workflowRunId']+'-'+producer['workflowRunAttempt']+'-'+name, row['reference'])
            and type(row['imageId']) is str and re.fullmatch('sha256:[a-f0-9]{64}', row['imageId'])
            and type(row['fileCount']) is int and 0 < row['fileCount'] < 30000 and _declaration_hash(row['sha256']),
            _RESTORED_B_CODE)
    return proof


def _restored_workspace_readback_origin(d, directory, expected, producer, recorded):
    """Explicit recovered-B origin: original API reader remains unmodified."""
    code = 'ONLINE_RECHARGE_AFTER_BIT_READBACK_CHANGED'
    reader = _pending_workspace_reader(d)
    d.require(directory.parent == d.BASE/'releases' and directory.resolve() == directory and directory.is_dir()
        and not directory.is_symlink() and directory.stat().st_uid == os.geteuid()
        and stat.S_IMODE(directory.stat().st_mode)&0o077 == 0
        and (d.BASE/'current').resolve() == directory and expected == producer['commit'], code)
    files = (STATE_FILE, PROOF_FILE, 'release-manifest.json')
    raw = {n: _declaration_source_bytes(directory/n) for n in files}
    record, proof, manifest = (closed_recovery_json(d, raw[n]) for n in files)
    bridge = reader.online_after_bit_cold(d, Path(manifest.get('previousRelease', '')),
        expected_commit=manifest.get('previousCommit'))
    d.require(bridge == recorded, code)
    _pending_workspace_profile(d, bridge, producer)
    fraw = online_after_bit_preflight_bytes(d, producer=producer, expected_sha256=proof.get('preflightBytesSha256'))
    _restored_workspace_build_shape(d, proof, producer, bridge, fraw)
    f = _restored_workspace_f_value(d, fraw)
    restore = f['restoration']; before = f['services']
    states = snapshot(d, directory, include_engine=True)
    d.require(record.get('baselineEvidence', {}).get('onlineAfterBitOrigin') == bridge
        and record['baselineEvidence'].get(_RESTORED_B_FIELD) == restore and record.get('before') == before
        and record.get('buildProofSha256') == fingerprint(proof)
        and record.get('configurationBefore') == bridge['configurationAfter']
        and record.get('configurationAfter') == configuration_hashes(directory)
        and manifest.get('commit') == expected and manifest.get('sourceTree') == producer['sourceTree']
        and manifest.get('previousManifestSha256') == bridge['manifestBytesSha256']
        and manifest.get('migrationPerformed') is False and record.get('migration') == {**bridge['migrationState'], 'performed': False}
        and set(states) == set((*PRESERVED,*UPDATED)) and record.get('after') == states
        and all(states[n] == before[n] == bridge['services'][n] for n in PRESERVED)
        and all(states[n]['image'] == proof['images'][n]['imageId']
            and states[n]['reference'] == proof['images'][n]['reference'] for n in UPDATED), code)
    d.require({n: _declaration_source_bytes(directory/n) for n in files} == raw
        and (d.BASE/'current').resolve() == directory and snapshot(d, directory, include_engine=True) == states, code)
    deployment=record.get('afterBitAuditProtection',{}).get('basis',{}).get('deploymentQualification')
    caps=_restored_qualified_capabilities(d)
    _restored_qualified_pair(d,caps,restore['apiDeclarationQualification'],deployment,bridge,before,
        restore['configurationMaterials']['admin'])
    d._onlinePendingWorkspaceSession = {'bridge':bridge,'producer':producer,
        'restoration':restore,'beforeServices':before,'deploymentQualification':deployment}
    return bridge


def _restored_workspace_audit_binding(d, bridge, proof):
    actual, producer = _pending_workspace_session(d)
    saved = d._onlinePendingWorkspaceSession
    d.require(actual == bridge and 'restoration' in saved, _RESTORED_B_CODE)
    raw = online_after_bit_preflight_bytes(d, producer=producer, expected_sha256=proof.get('preflightBytesSha256'))
    _restored_workspace_build_shape(d, proof, producer, bridge, raw)
    d.require(closed_recovery_json(d, raw)['restoration'] == saved['restoration'], _RESTORED_B_CODE)
    d.require('deploymentQualification' in saved,_RESTORED_B_QUALIFIED_CODE)
    caps=_restored_qualified_capabilities(d)
    _restored_qualified_pair(d,caps,saved['restoration']['apiDeclarationQualification'],saved['deploymentQualification'],
        bridge,saved['beforeServices'],saved['restoration']['configurationMaterials']['admin'])
    return {'deploymentQualification':saved['deploymentQualification'],'baselineOriginSha256': fingerprint(bridge), 'baselineProducer': bridge['baselineProducer'],
        'producer': producer, 'preflightBytesSha256': hashlib.sha256(raw).hexdigest(), 'buildProofSha256': fingerprint(proof),
        'restorationSha256': fingerprint(saved['restoration']), 'sourceHelpers': {name: hashlib.sha256(
            _declaration_source_bytes(Path(__file__).with_name(name), limit=512*1024)).hexdigest()
            for name in ('api-admin-scope.py', 'online-recharge-scope.py')}}


def _restored_workspace_unused_audit_barrier(d, directory, bridge, proof):
    saved = d._onlinePendingWorkspaceSession
    restore = _restored_workspace_sidecar(d, bridge, saved['restoration'], saved['beforeServices'])
    d.require(str(directory) == bridge['baselineRelease'], _RESTORED_B_CODE)
    reader = legacy(d)
    history, source = restore['historyApiIdentity'], restore['stopApiIdentity']
    d.require(reader.workspace_api_identity(d, directory, expected=source, timeout=5) == source, _RESTORED_B_CODE)
    plan = _online_after_bit_audit_queries(d, reader, directory, history)
    d.require(reader.workspace_audit_protection(d, directory) == plan['expectedTriggersSha256'],
        'API_ADMIN_WORKSPACE_AUDIT_HISTORY_UNPROVEN')
    basis = _restored_workspace_audit_binding(d, bridge, proof)
    def api_check(deadline):
        remaining = min(5, deadline-time.monotonic())
        d.require(remaining > 0, 'API_ADMIN_WORKSPACE_GUARD_TIMEOUT')
        d.require(reader.workspace_api_identity(d, directory, expected=source, timeout=remaining) == source, _RESTORED_B_CODE)
    return _restored_workspace_audit_transport(d, directory, bridge, reader, history, source, plan, basis,
        restore=restore, first_api_check=api_check)


def _restored_workspace_audit_receipt(d, directory, bridge, proof, manifest, record):
    code = 'ONLINE_RECHARGE_AFTER_BIT_AUDIT_RECEIPT_CHANGED'
    saved = d._onlinePendingWorkspaceSession
    restore = saved['restoration']; value = record.get('afterBitAuditProtection')
    d.require(type(value) is dict and set(value) == {'version','kind','basis','historyApiIdentity','sourceApiIdentity',
        'restorationSha256','mysqlIdentitySha256','initialQuerySha256','querySha256','historyQuerySha256',
        'triggerDefinitionsSha256','connectionIdSha256','before','after','oldApiStop','sqliteProtectionSha256'}
        and type(value['version']) is int and value['version'] == 2
        and value['kind'] == 'ONLINE_RECHARGE_AFTER_BIT_RESTORED_AUDIT_PROTECTION'
        and value['historyApiIdentity'] == restore['historyApiIdentity']
        and value['sourceApiIdentity'] == restore['stopApiIdentity']
        and value['restorationSha256'] == fingerprint(restore)
        and value['basis'] == _restored_workspace_audit_binding(d, bridge, proof), code)
    before = value['before']; reader = legacy(d); history = restore['historyApiIdentity']
    d.require(type(before) is dict and set(before) == {'historicalRegistrationAuditCount','historicalRegistrationPrefixCount',
        'historyCutoff','clockBeforeCutoff','registrationMutationCount','onlineAuditCount','tables','triggerDefinitionsSha256'}
        and type(before['historicalRegistrationAuditCount']) is int and 0 <= before['historicalRegistrationAuditCount'] < 2**63
        and type(before['historicalRegistrationPrefixCount']) is int
        and before['historicalRegistrationPrefixCount'] == before['historicalRegistrationAuditCount']
        and all(type(before[n]) is int and before[n] == 0 for n in ('clockBeforeCutoff','registrationMutationCount','onlineAuditCount'))
        and before['tables'] == {n:0 for n in TABLES} and all(type(v) is int for v in before['tables'].values())
        and fingerprint(value['after']) == fingerprint(before), code)
    initial = _online_after_bit_audit_queries(d, reader, Path(bridge['baselineRelease']), history)
    plan = _online_after_bit_audit_queries(d, reader, Path(bridge['baselineRelease']), history, history_cutoff=before['historyCutoff'])
    from datetime import datetime, timedelta
    try:
        bounded = datetime.fromisoformat(before['historyCutoff']) < datetime.strptime(manifest.get('deployedAt',''), '%Y-%m-%dT%H:%M:%SZ') + timedelta(seconds=1)
    except ValueError:
        bounded = False
    source3 = {n:restore['stopApiIdentity'][n] for n in ('containerId','image','startedAtSha256')}
    d.require(bounded and before['triggerDefinitionsSha256'] == plan['expectedTriggersSha256']
        and value['mysqlIdentitySha256'] == fingerprint(bridge['services']['mysql'])
        and value['initialQuerySha256'] == hashlib.sha256(initial['frameQuery'].encode()).hexdigest()
        and value['querySha256'] == hashlib.sha256(plan['frameQuery'].encode()).hexdigest()
        and value['historyQuerySha256'] == hashlib.sha256(plan['historyQuery'].encode()).hexdigest()
        and value['triggerDefinitionsSha256'] == plan['expectedTriggersSha256'] and _declaration_hash(value['connectionIdSha256'])
        and value['oldApiStop'] == {'identity':source3, 'running':False, 'pid':0}
        and type(value['oldApiStop']['pid']) is int and value['sqliteProtectionSha256'] == record.get('sqliteProtectionSha256')
        and manifest.get('onlineRechargePublication',{}).get('afterBitAuditProtectionSha256') == fingerprint(value), code)
    sqlite = closed_recovery_json(d, _declaration_source_bytes(directory/reader.WORKSPACE_SQLITE_RECEIPT))
    d.require(fingerprint(sqlite) == value['sqliteProtectionSha256'] and sqlite.get('sourceApiIdentity') == source3, code)
    d.require(reader.workspace_audit_protection(d, directory) == plan['expectedTriggersSha256'], code)
    reader.online_idle(d,directory); reader.workspace_idle(d,directory,legacy=False)
    barrier = _restored_workspace_audit_transport(d,directory,bridge,reader,history,restore['stopApiIdentity'],plan,
        value['basis'],restore=restore,history_record=before)
    with barrier:
        barrier.check()
    reader.online_idle(d,directory); reader.workspace_idle(d,directory,legacy=False)
    return {'afterBitAuditProtectionSha256':fingerprint(value),
        'preservedRegistrationAuditCount':before['historicalRegistrationAuditCount'], 'auditHistoryCutoff':before['historyCutoff'],
        _RESTORED_B_FIELD:restore}

def _restored_workspace_audit_transport(d, directory, bridge, reader, history, identity, plan, basis, *, restore, history_record=None, first_api_check=None):
    """Private verified B publication or sealed historical-prefix readback fence."""
    code = 'ONLINE_RECHARGE_AFTER_BIT_AUDIT_GUARD_LOST'
    class Barrier(reader.WorkspaceUnusedAuditBarrier):
        def __init__(self):
            super().__init__(d, directory, online=True)
            d.require(self.query == plan['originalOnlineQuery'], 'ONLINE_RECHARGE_AFTER_BIT_AUDIT_QUERY_CHANGED')
            self.source_api_identity = json.loads(json.dumps(identity))
            self.plan = plan
            self.query = plan['frameQuery'] if history_record is None else plan['historyQuery']
            self.initial_query = self.query
            self.before, self.after, self.receipt = None, None, None

        def check(self, value=None):
            if value is None:
                self.pipe.send(self.query + ';\n')
                value = self.pipe.read(limit=4096)
            fields = {'connectionId', 'historicalRegistrationPrefixCount', 'historyCutoff', 'clockBeforeCutoff', 'triggers'}
            if history_record is None:
                fields |= {'historicalRegistrationAuditCount', 'registrationMutationCount', 'onlineAuditCount', 'tables'}
            d.require(type(value) is dict and set(value) == fields
                and type(self.connection_id) is int and self.connection_id > 0
                and type(value['connectionId']) is int and value['connectionId'] == self.connection_id
                and type(value['historicalRegistrationPrefixCount']) is int and 0 <= value['historicalRegistrationPrefixCount'] < 2**63
                and type(value['clockBeforeCutoff']) is int and value['clockBeforeCutoff'] == 0
                and self.pipe.process.poll() is None and time.monotonic() < self.pipe.deadline, code)
            bound = _online_after_bit_audit_queries(d, reader, directory, history, history_cutoff=value['historyCutoff'])
            if history_record is None:
                d.require(type(value['historicalRegistrationAuditCount']) is int
                    and value['historicalRegistrationAuditCount'] == value['historicalRegistrationPrefixCount']
                    and type(value['registrationMutationCount']) is int and value['registrationMutationCount'] == 0
                    and type(value['onlineAuditCount']) is int and value['onlineAuditCount'] == 0
                    and type(value['tables']) is dict and value['tables'] == {n: 0 for n in TABLES}
                    and all(type(v) is int for v in value['tables'].values()), code)
            else:
                d.require(value['historyCutoff'] == history_record['historyCutoff']
                    and value['historicalRegistrationPrefixCount'] == history_record['historicalRegistrationAuditCount'], code)
            rows = value['triggers']
            d.require(type(rows) is list and len(rows) == 2 and all(type(row) is dict
                and set(row) == {'event', 'timing', 'statement'} and row['timing'] == 'BEFORE'
                and type(row['statement']) is str for row in rows)
                and {row['event']: ' '.join(row['statement'].split()).rstrip(';') for row in rows} == self.plan['expectedTriggers'], code)
            summary = {n: value[n] for n in fields - {'connectionId', 'triggers'}}
            summary['triggerDefinitionsSha256'] = self.plan['expectedTriggersSha256']
            d.require(self.before is None or fingerprint(summary) == fingerprint(self.before), code)
            _online_after_bit_mysql_check(d, directory, bridge['services']['mysql'], self.pipe.deadline)
            if self.before is None and first_api_check is not None:
                first_api_check(self.pipe.deadline)
            d.require(self.pipe.process.poll() is None and time.monotonic() < self.pipe.deadline, code)
            if self.before is None:
                self.before = json.loads(json.dumps(summary))
                self.plan = bound
                if history_record is None:
                    self.query = bound['frameQuery']
            self.after = summary

        def before_stop(self):
            d.require(first_api_check is not None and history_record is None, code)
            first_api_check(self.pipe.deadline)
            super().before_stop()
            # API identity 30s + stop 45s + inspect 15s, two SQL/MySQL checks
            # 44s, final inspect 5s and transport close 9s, with bounded slack.
            d.require(time.monotonic() + 170 < self.pipe.deadline, 'API_ADMIN_WORKSPACE_GUARD_TIMEOUT')

        def confirm_stopped(self, sqlite_gate):
            remaining = min(5, self.pipe.deadline - time.monotonic())
            d.require(remaining > 0 and history_record is None and self.before is not None
                and fingerprint(self.before) == fingerprint(self.after) and self.pipe.process.poll() is None, code)
            metadata = json.loads(d.run('docker', 'inspect', identity['containerId'], timeout=remaining))[0]
            state = metadata.get('State', {})
            d.require(metadata.get('Id') == identity['containerId'] and metadata.get('Image') == identity['image']
                and type(state.get('StartedAt')) is str and hashlib.sha256(state['StartedAt'].encode()).hexdigest() == identity['startedAtSha256']
                and state.get('Running') is False and type(state.get('Pid')) is int and state['Pid'] == 0
                and self.pipe.process.poll() is None and time.monotonic() < self.pipe.deadline
                and type(sqlite_gate.record) is dict and sqlite_gate.record.get('sourceApiIdentity') == {
                    n: identity[n] for n in ('containerId', 'image', 'startedAtSha256')}, code)
            # Seal one final unchanged frame after the actual old PID reached zero.
            self.check()
            d.require(self.pipe.process.poll() is None and time.monotonic() < self.pipe.deadline, code)
            self.receipt = {'version': 2, 'kind': 'ONLINE_RECHARGE_AFTER_BIT_RESTORED_AUDIT_PROTECTION', 'basis': basis,
                'historyApiIdentity': history, 'restorationSha256': fingerprint(restore),
                'sourceApiIdentity': identity, 'mysqlIdentitySha256': fingerprint(bridge['services']['mysql']),
                'initialQuerySha256': hashlib.sha256(self.initial_query.encode()).hexdigest(),
                'querySha256': hashlib.sha256(self.query.encode()).hexdigest(),
                'historyQuerySha256': hashlib.sha256(self.plan['historyQuery'].encode()).hexdigest(),
                'triggerDefinitionsSha256': self.plan['expectedTriggersSha256'],
                'connectionIdSha256': fingerprint(self.connection_id), 'before': self.before, 'after': self.after,
                'oldApiStop': {'identity': {n: identity[n] for n in ('containerId', 'image', 'startedAtSha256')}, 'running': False, 'pid': 0},
                'sqliteProtectionSha256': fingerprint(sqlite_gate.record)}
            return self.receipt
    return Barrier()
