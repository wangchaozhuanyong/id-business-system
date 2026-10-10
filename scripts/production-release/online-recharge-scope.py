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


FORMAL_RUNTIME_DRIVER_SHA256 = '27d0913dd1ed070973168a2d5e656f54ce9d9679279c986570b253194bf96c53'


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
ONLINE_PENDING_WORKSPACE_FIELDS = ('kind', 'version', 'baselineRelease', 'baselineCommit', 'baselineProducer',
    'manifestBytesSha256', 'recordBytesSha256', 'buildProofBytesSha256', 'buildProofCanonicalSha256', 'environmentFileSha256',
    'publicationSha256', 'pendingOriginSha256', 'readbackCommandId', 'readbackInvocationBytesSha256',
    'initialReadbackInvocationBytesSha256', 'originalWorkspace', 'migrationRecovery', 'migrationState',
    'services', 'configurationAfter')


def online_pending_workspace_bridge_shape(d, value):
    """Shape only: the cold consumer must acquire and derive this exact value."""
    try:
        _declaration_exact(value, ONLINE_PENDING_WORKSPACE_FIELDS)
        _declaration_require(value['kind'] == ONLINE_PENDING_WORKSPACE_KIND and type(value['version']) is int and value['version'] == 1)
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
        return value
    except Exception:
        raise RuntimeError('ONLINE_RECHARGE_PENDING_WORKSPACE_ORIGIN_CHANGED') from None


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


def online_pending_workspace_preflight_binding(d, raw, *, producer, bridge):
    """Pure same-run F_O binding, not a trusted-file authority or live measurement."""
    try:
        _declaration_require(type(raw) is bytes and 0 < len(raw) < 65536)
        value = closed_recovery_json(d, raw)
        _declaration_exact(value, ('kind', 'version', 'mode', 'status', 'commandId', 'releaseCandidateCommit',
            'workflowRunId', 'workflowRunAttempt', 'sourceTree', 'baseline', 'services',
            *(('ordinaryPreflight',) if value.get('version') == 2 else ())))
        _declaration_require(value['kind'] == 'ONLINE_RECHARGE_PENDING_WORKSPACE_PREFLIGHT' and type(value['version']) is int
            and value['version'] in (1,2) and value['mode'] == 'preflight'
            and value['status'] == 'ONLINE_RECHARGE_PENDING_WORKSPACE_BASELINE_VERIFIED'
            and type(value['commandId']) is str and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value['commandId'])
            and value['releaseCandidateCommit'] == producer['commit'] and value['sourceTree'] == producer['sourceTree']
            and value['workflowRunId'] == producer['workflowRunId'] and value['workflowRunAttempt'] == producer['workflowRunAttempt']
            and value['baseline'] == bridge and value['services'] == bridge['services'])
        if value['version'] == 2:
            receipt=value['ordinaryPreflight']
            _pending_workspace_pref_fields(d,receipt)
            _declaration_require(type(receipt) is dict and receipt.get('onlinePendingWorkspaceOrigin')==bridge
                and receipt.get('services')==bridge['services'] and receipt.get('migrationPerformed') is False)
            _pending_workspace_validate_receipt(d,receipt,'preflight',producer['commit'],bridge['baselineCommit'])
        return {'kind': 'ONLINE_RECHARGE_PENDING_WORKSPACE_PREFLIGHT_SEAL', 'version': value['version'],
                'bytesSha256': hashlib.sha256(raw).hexdigest(), 'commandId': value['commandId'],
                'baselineSha256': fingerprint(bridge), 'producer': producer}
    except Exception:
        raise RuntimeError('ONLINE_RECHARGE_PENDING_WORKSPACE_PREFLIGHT_CHANGED') from None


def online_pending_workspace_preflight_bytes(d, *, producer, expected_sha256):
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
        online_pending_workspace_preflight_binding(d,raw,producer=producer,bridge=value.get('baseline'))
        return raw
    except Exception:
        raise RuntimeError('ONLINE_RECHARGE_PENDING_WORKSPACE_PREFLIGHT_CHANGED') from None


def online_pending_workspace_build_shape(d, proof, *, producer, bridge, preflight_raw):
    """An explicit different proof kind, not a normalized legacy v1 proof."""
    try:
        _declaration_exact(proof, ('kind','version','scope','commit','sourceTree','baselineCommit',
            'migration','images','engineSourceSha256','composeSourceSha256','baselineOriginSha256','preflightBytesSha256'))
        _declaration_require(proof['kind']=='ONLINE_RECHARGE_PENDING_WORKSPACE_BUILD_PROOF'
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
                'baselineOriginSha256': fingerprint(evidence['onlinePendingWorkspaceOrigin']),
                'sqliteProtectionSha256': fingerprint(sqlite_gate.record), 'scope': SCOPE, 'buildProofSha256': fingerprint(proof),
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
    previous = Path(manifest.get('previousRelease', ''))
    d.require(previous.parent == d.BASE / 'releases' and not previous.is_symlink()
              and manifest.get('commit') == expected and manifest.get('previousCommit') == record['baselineEvidence']['onlinePendingWorkspaceOrigin']['baselineCommit']
              and manifest.get('servicesUpdated') == list(UPDATED)
              and manifest.get('newMigrations') == [] and manifest.get('migrationApplied') is True
              and manifest.get('onlineRechargePublication') == {
                  'version': 2, 'baselineOriginSha256': fingerprint(record['baselineEvidence']['onlinePendingWorkspaceOrigin']),
                  'sqliteProtectionSha256': record.get('sqliteProtectionSha256'), 'scope': SCOPE, 'buildProofSha256': fingerprint(proof),
                  'migration': dict(MIGRATION_IDENTITY), 'legacyWorkersPublished': False,
                  'configurationScope': 'ONLINE_RECHARGE_VOLUME_LOOPBACK_ONLY'}
              and record.get('buildProofSha256') == fingerprint(proof)
              and hashlib.sha256((previous / 'release-manifest.json').read_bytes()).hexdigest()
                  == manifest.get('previousManifestSha256') == record['baselineEvidence']['manifestSha256'],
              'ONLINE_RECHARGE_READBACK_PROVENANCE_CHANGED')
    d.require(json.loads((previous / 'release-manifest.json').read_text()).get('commit') == record['baselineEvidence']['onlinePendingWorkspaceOrigin']['baselineCommit']
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
            'legacyWorkersPublished': False, 'externalAcceptancePerformed': False, 'onlinePendingWorkspaceOrigin': record['baselineEvidence']['onlinePendingWorkspaceOrigin'], **recovered}

def _pending_workspace_validate_receipt(d, value, mode, commit, expected):
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
        d.require(expected == value['onlinePendingWorkspaceOrigin']['baselineCommit'] and value.get('migration') == MIGRATION_IDENTITY
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
        resumed = {'onlinePendingWorkspaceOrigin': value['onlinePendingWorkspaceOrigin']}
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
    resumed = {'onlinePendingWorkspaceOrigin': value['onlinePendingWorkspaceOrigin']}
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


def _pending_workspace_profile(d, bridge, producer):
    """The two real runs must publish the identical complete immutable source."""
    initial=bridge['baselineProducer']
    d.require(producer['commit']==initial['commit'] and producer['sourceTree']==initial['sourceTree']
        and producer['workflowRunId']!=initial['workflowRunId'],
        'ONLINE_RECHARGE_PENDING_WORKSPACE_ORIGIN_CHANGED')
    inventory=_pending_workspace_current_source_inventory(d,producer)
    for name in _PENDING_WORKSPACE_CONTROL_NAMES:
        raw=_declaration_source_bytes(Path(__file__).with_name(Path(name).name),
            limit=2*1024*1024 if name.endswith('/remote-deploy.py') else 1024*1024)
        d.require(inventory.get(name,{}).get('sha256')==hashlib.sha256(raw).hexdigest(),
                  'ONLINE_RECHARGE_EXECUTOR_SOURCE_CHANGED')
    return inventory


def _pending_workspace_session(d, *, expected=None, producer=None):
    saved=getattr(d,'_onlinePendingWorkspaceSession',None)
    d.require(type(saved) is dict and set(saved)=={'bridge','producer'},'ONLINE_RECHARGE_PENDING_WORKSPACE_ORIGIN_CHANGED')
    producer=_pending_workspace_producer(d) if producer is None else producer
    reader=_pending_workspace_reader(d)
    directory=Path(saved['bridge']['baselineRelease'])
    bridge=reader.online_pending_workspace_cold(d,directory,expected_commit=saved['bridge']['baselineCommit'])
    d.require(bridge==saved['bridge'] and producer==saved['producer']
        and (expected is None or expected==bridge['baselineCommit']), 'ONLINE_RECHARGE_PENDING_WORKSPACE_ORIGIN_CHANGED')
    _pending_workspace_profile(d,bridge,producer)
    return bridge,producer


def _pending_workspace_begin(d, expected, producer, *, live):
    d.require(hasattr(d,'BASE') and expected==producer['commit'], 'ONLINE_RECHARGE_PENDING_WORKSPACE_INPUT_INVALID')
    previous=(d.BASE/'current').resolve()
    reader=_pending_workspace_reader(d)
    bridge=(reader.online_pending_workspace_measure_before if live else reader.online_pending_workspace_cold)(
        d,previous,expected_commit=expected)
    online_pending_workspace_bridge_shape(d,bridge)
    _pending_workspace_profile(d,bridge,producer)
    d._onlinePendingWorkspaceProducer=producer
    d._onlinePendingWorkspaceSession={'bridge':bridge,'producer':producer}
    return previous,bridge


def baseline(d, expected):
    if expected==BASELINE_COMMIT:
        return _PENDING_WORKSPACE_FIRST['baseline'](d,expected)
    d.require(type(getattr(d,'_onlinePendingWorkspaceProducer',None)) is dict, 'ONLINE_RECHARGE_BASELINE_NOT_APPROVED')
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
        'onlinePendingWorkspaceOrigin':bridge,'freeBytes':shutil.disk_usage(d.BASE).free}
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
    if 'onlinePendingWorkspaceOrigin' not in evidence:
        return _PENDING_WORKSPACE_FIRST['workspace_origin'](d,previous,directory,evidence,before)
    bridge,_producer=_pending_workspace_session(d)
    d.require(evidence['onlinePendingWorkspaceOrigin']==bridge and str(previous)==bridge['baselineRelease']
        and before==bridge['services'] and workspace_files(d,previous)==evidence['workspaceOriginFiles']
        and evidence['workspaceBuildProofSha256']==bridge['buildProofCanonicalSha256'],
        'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED')
    # Cold actual initial Q evidence establishes retired owner provenance. The current
    # attached volume and current API health still get their original live guards.
    workspace_guard(d,directory,evidence['workspaceVolume']);legacy(d).workspace_health(d,directory)


def historical_guard(d, previous, evidence, source):
    if 'onlinePendingWorkspaceOrigin' not in evidence:
        return _PENDING_WORKSPACE_FIRST['historical_guard'](d,previous,evidence,source)
    bridge,_producer=_pending_workspace_session(d)
    d.require(evidence['onlinePendingWorkspaceOrigin']==bridge,'ONLINE_RECHARGE_PENDING_WORKSPACE_ORIGIN_CHANGED')
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
    _previous,bridge=_pending_workspace_begin(d,args.expected_current,producer,live=True)
    encoded=getattr(args,'online_recharge_build_proof','')
    d.require(type(encoded) is str and len(encoded)<32768,'ONLINE_RECHARGE_BUILD_PROOF_TOO_LARGE')
    raw=base64.b64decode(encoded,validate=True)
    d.require(len(raw)<24000,'ONLINE_RECHARGE_BUILD_PROOF_TOO_LARGE')
    proof=closed_recovery_json(d,raw)
    before=online_pending_workspace_preflight_bytes(d,producer=producer,expected_sha256=proof.get('preflightBytesSha256'))
    _pending_workspace_complete_preflight(d,before,producer=producer,bridge=bridge)
    d.require(re.fullmatch('[0-9]{12}\\.dkr\\.ecr\\.ap-northeast-1\\.amazonaws\\.com/id-business-v2-release',args.repository or '')
        and type(args.ci_run_id) is str and re.fullmatch('[1-9][0-9]*',args.ci_run_id),'ONLINE_RECHARGE_INPUT_INVALID')
    return validate_proof(d,proof,args.commit,args.source_tree,args.repository,args.run_id,args.run_attempt)


def validate_proof(d, value, commit, tree, repository=None, run_id=None, attempt=None):
    if type(value) is not dict or 'kind' not in value:
        return _PENDING_WORKSPACE_FIRST['validate_proof'](d,value,commit,tree,repository,run_id,attempt)
    d.require(value.get('kind')=='ONLINE_RECHARGE_PENDING_WORKSPACE_BUILD_PROOF','ONLINE_RECHARGE_BUILD_PROOF_INVALID')
    bridge,producer=_pending_workspace_session(d)
    d.require(commit==producer['commit'] and tree==producer['sourceTree']
        and (run_id is None or run_id==producer['workflowRunId'])
        and (attempt is None or attempt==producer['workflowRunAttempt']),'ONLINE_RECHARGE_BUILD_RUN_CHANGED')
    raw=online_pending_workspace_preflight_bytes(d,producer=producer,expected_sha256=value.get('preflightBytesSha256'))
    _pending_workspace_complete_preflight(d,raw,producer=producer,bridge=bridge)
    if repository is not None:
        d.require(all(row['reference']==repository+':'+commit+'-'+str(run_id)+'-'+str(attempt)+'-'+name
            for name,row in value.get('images',{}).items()),'ONLINE_RECHARGE_BUILD_RUN_CHANGED')
    return online_pending_workspace_build_shape(d,value,producer=producer,bridge=bridge,preflight_raw=raw)


def build_proof(d):
    expected=os.environ.get('EXPECTED_CURRENT',BASELINE_COMMIT)
    if expected==BASELINE_COMMIT:
        return _PENDING_WORKSPACE_FIRST['build_proof'](d)
    # CI build has no server file authority: use only the original F_O from
    # the fixed ended transport. The same-candidate source binding remains mandatory.
    before_path=Path('.deploy/production-release/online-recharge-pending-workspace-preflight-result.json').absolute()
    raw=_declaration_source_bytes(before_path,limit=65535)
    before=closed_recovery_json(d,raw);bridge=online_pending_workspace_bridge_shape(d,before.get('baseline'))
    producer={n:os.environ.get(e,'') for n,e in (('commit','RELEASE_COMMIT'),('sourceTree','SOURCE_TREE'),
        ('workflowRunId','GITHUB_RUN_ID'),('workflowRunAttempt','GITHUB_RUN_ATTEMPT'))}
    _pending_workspace_complete_preflight(d,raw,producer=producer,bridge=bridge)
    _pending_workspace_profile(d,bridge,producer)
    d.require(d.run('git','rev-parse','HEAD')==producer['commit'] and d.run('git','rev-parse','HEAD^{tree}')==producer['sourceTree']
        and d.run('git','status','--porcelain','--untracked-files=all')=='','ONLINE_RECHARGE_BUILD_WORKTREE_DIRTY')
    directory=Path.cwd();migration_source_check(d,directory)
    proof={'kind':'ONLINE_RECHARGE_PENDING_WORKSPACE_BUILD_PROOF','version':2,'scope':SCOPE,
        'commit':producer['commit'],'sourceTree':producer['sourceTree'],'baselineCommit':expected,
        'migration':dict(MIGRATION_IDENTITY),'images':{},'engineSourceSha256':fingerprint(file_inventory(d,directory/ENGINE_ROOT)),
        'composeSourceSha256':file_digest(directory/'docker-compose.aws-mysql.yml'),
        'baselineOriginSha256':fingerprint(bridge),'preflightBytesSha256':hashlib.sha256(raw).hexdigest()}
    for service in IMAGE_SERVICES:
        reference=os.environ['RELEASE_REPOSITORY']+':'+producer['commit']+'-'+producer['workflowRunId']+'-'+producer['workflowRunAttempt']+'-'+service
        metadata=json.loads(d.run('docker','image','inspect',reference))[0]
        proof['images'][service]={'reference':reference,'imageId':metadata['Id'],**content_summary(d,service,d.run('docker','run','--rm',
            '--network','none','--read-only','--entrypoint','/bin/sh',reference,'-c',content_command(service)))}
    online_pending_workspace_build_shape(d,proof,producer=producer,bridge=bridge,preflight_raw=raw)
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


def readback(d,expected):
    if not hasattr(d,'_onlinePendingWorkspaceProducer'):
        return _PENDING_WORKSPACE_FIRST['readback'](d,expected)
    directory=(d.BASE/'current').resolve()
    record=closed_recovery_json(d,_declaration_source_bytes(directory/STATE_FILE))
    evidence=record.get('baselineEvidence',{})
    if 'onlinePendingWorkspaceOrigin' not in evidence:
        return _PENDING_WORKSPACE_FIRST['readback'](d,expected)
    producer=_pending_workspace_producer(d)
    bridge=_pending_workspace_reader(d).online_pending_workspace_readback_origin(d,directory,expected_commit=expected,producer=producer)
    _pending_workspace_profile(d,bridge,producer)
    d._onlinePendingWorkspaceSession={'bridge':bridge,'producer':producer}
    return _pending_workspace_readback(d,expected)


def validate_receipt(d,value,mode,commit,expected):
    if type(value) is not dict or 'onlinePendingWorkspaceOrigin' not in value:
        return _PENDING_WORKSPACE_FIRST['validate_receipt'](d,value,mode,commit,expected)
    bridge=online_pending_workspace_bridge_shape(d,value['onlinePendingWorkspaceOrigin'])
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
    result={**result,'onlinePendingWorkspaceOrigin':bridge,'migrationPerformed':False}
    _pending_workspace_pref_fields(d,result)
    _pending_workspace_validate_receipt(d,result,'preflight',producer['commit'],expected)
    return result


def _pending_workspace_complete_preflight(d,raw,*,producer,bridge):
    value=closed_recovery_json(d,raw)
    d.require(value.get('version')==2 and type(value.get('version')) is int,
              'ONLINE_RECHARGE_PENDING_WORKSPACE_PREFLIGHT_CHANGED')
    return online_pending_workspace_preflight_binding(d,raw,producer=producer,bridge=bridge)


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
        bridge=online_pending_workspace_bridge_shape(d,receipt.get('onlinePendingWorkspaceOrigin'))
        _pending_workspace_validate_receipt(d,receipt,'preflight',producer['commit'],bridge['baselineCommit'])
        f={'kind':'ONLINE_RECHARGE_PENDING_WORKSPACE_PREFLIGHT','version':2,'mode':'preflight',
            'status':'ONLINE_RECHARGE_PENDING_WORKSPACE_BASELINE_VERIFIED','commandId':command_id,
            'releaseCandidateCommit':producer['commit'],'workflowRunId':producer['workflowRunId'],
            'workflowRunAttempt':producer['workflowRunAttempt'],'sourceTree':producer['sourceTree'],
            'baseline':bridge,'services':bridge['services'],'ordinaryPreflight':receipt}
        raw=(json.dumps(f,indent=2)+'\n').encode()
        _pending_workspace_complete_preflight(d,raw,producer=producer,bridge=bridge)
        return {'preflight_raw':raw,'invocation_raw':invocation_raw,
            'command_id':command_id,'invocation_bytes_sha256':hashlib.sha256(invocation_raw).hexdigest()}
    except Exception:
        raise RuntimeError('ONLINE_RECHARGE_PENDING_WORKSPACE_PREFLIGHT_CHANGED') from None


def _pending_workspace_pref_fields(d,value):
    # This producer owns an explicit finite evidence schema. Inherited full P,
    # arbitrary old baseline fields, raw Env and extra stdout keys never enter F.
    required={'status','commit','services','manifestSha256','environmentSha256','apiSource','guards','freeBytes',
        'workspaceIdle','workspaceVolume','workspaceOriginFiles','workspaceBuildProofSha256','migrationRecovery',
        'onlinePendingWorkspaceOrigin','audit','migration','migrationState','workersPreserved','requiresWindowHandoff','migrationPerformed'}
    d.require(type(value) is dict and required<=set(value) and set(value)<=required|{'migrationOrigin'},
              'ONLINE_RECHARGE_PENDING_WORKSPACE_PREFLIGHT_CHANGED')
    bridge=online_pending_workspace_bridge_shape(d,value['onlinePendingWorkspaceOrigin'])
    d.require(value['apiSource']=={'imageId':bridge['services']['api']['image'],'revision':bridge['baselineCommit'],
        'kind':'API_WORKSPACE_BUILD_PROVEN'} and value['environmentSha256']==bridge['environmentFileSha256']
        and value['manifestSha256']==bridge['manifestBytesSha256'] and type(value['freeBytes']) is int
        and value['freeBytes']>6*1024**3 and value['workspaceBuildProofSha256']==bridge['buildProofCanonicalSha256']
        and type(value['workspaceOriginFiles']) is dict and set(value['workspaceOriginFiles'])==
            {'release-manifest.json','api-workspace-preservation.json','api-workspace-build-proof.json','backup-verification.json','before-audit.json','after-audit.json'}
        and all(_declaration_hash(v) for v in value['workspaceOriginFiles'].values()),
        'ONLINE_RECHARGE_PENDING_WORKSPACE_PREFLIGHT_CHANGED')
