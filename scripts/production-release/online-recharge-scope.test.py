import base64
import gzip
import copy
from contextlib import ExitStack, contextmanager, redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
# The first ONLINE admission is a fixed reviewed source contract. Later
# independent business batches must not become its positive test fixture.
# This commit is an existing main ancestor, retained after branch cleanup.
REVIEWED_APPLICATION_TEMPLATE_COMMIT = '4a35c9c9d8f4a2df9e28503ffe491d4af5d8052e'
REVIEWED_APPLICATION_TEMPLATE_TREE = '1aee6c41c593ede8869b07757bc2d69f6de2c3f5'
RUNTIME = ROOT / '.runtime/online-recharge/release-tests'
RUNTIME.mkdir(parents=True, exist_ok=True)


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


scope = load('online_recharge_scope_tests', 'online-recharge-scope.py')
shared = scope._load_legacy()


def require(value, code):
    if not value:
        raise RuntimeError(code)


def controller(**values):
    return SimpleNamespace(require=require, api_admin_scope=lambda selected: (shared, None), **values)


COMMIT, TREE = 'a' * 40, 'b' * 40
REPOSITORY = '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'


def proof():
    return {'version': 1, 'scope': scope.SCOPE, 'commit': COMMIT, 'sourceTree': TREE,
            'baselineCommit': scope.BASELINE_COMMIT, 'migration': dict(scope.MIGRATION_IDENTITY),
            'engineSourceSha256': '1' * 64, 'composeSourceSha256': '2' * 64,
            'images': {name: {'reference': f'{REPOSITORY}:{COMMIT}-123-1-{name}',
                'imageId': 'sha256:' + str(index) * 64, 'fileCount': 1, 'sha256': str(index) * 64}
                for index, name in enumerate(scope.IMAGE_SERVICES, 1)}}


def states(engine=False):
    names = (*scope.PRESERVED, 'api', 'admin', *(('online-recharge',) if engine else ()))
    return {name: {'image': 'sha256:' + 'c' * 64, 'reference': 'old-' + name,
                  'status': 'running', 'health': None if name == 'caddy' else 'healthy',
                  'containerId': 'd' * 64, 'startedAtSha256': 'e' * 64,
                  'environmentSha256': 'f' * 64, 'configurationSha256': '0' * 64} for name in names}


def env_values(path):
    return dict(line.split('=', 1) for line in path.read_text().splitlines() if '=' in line)


@contextmanager
def directories():
    with tempfile.TemporaryDirectory(prefix='scope-', dir=RUNTIME) as name:
        folder = Path(name)
        old, new = folder / 'old', folder / 'new'
        old.mkdir(); new.mkdir()
        yield old, new


def source_fixture(old, new):
    names = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', scope.BASELINE_COMMIT,
        scope.MIGRATION_ROOT, scope.SCHEMA_FILE, scope.SEED_FILE], cwd=ROOT).decode().splitlines()
    for name in names:
        target = old / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(subprocess.check_output(['git', 'show', scope.BASELINE_COMMIT + ':' + name], cwd=ROOT))
    shutil.copytree(old, new, dirs_exist_ok=True)
    for name in (scope.SCHEMA_FILE, scope.SEED_FILE, scope.MIGRATION_ROOT + '/' + scope.MIGRATION_FILE):
        target = new / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())


def database_fixture(directory, applied):
    rows = shared.migration_files(controller(), directory)
    migration_rows = [{'name': n.split('/')[0], 'checksum': digest, 'finished': 1, 'rolledBack': 0}
                      for n, digest in rows.items() if n.endswith('/migration.sql')
                      and (applied or n != scope.MIGRATION_FILE)]
    expected = scope.schema_expectation(controller(), directory)
    return {'rows': migration_rows, **(expected if applied else {'tables': None, 'columns': None, 'indexes': None})}


class DatabaseReadTests(unittest.TestCase):
    def test_sql_reaches_client_stdin_without_shell_expansion_or_requoting(self):
        with directories() as (folder, _):
            marker, captured = folder / 'must-not-exist', folder / 'stdin.txt'
            client = folder / 'mysql'
            client.write_text('#!/usr/bin/env python3\nimport json,sys\nfrom pathlib import Path\n'
                + 'Path(' + repr(str(captured)) + ').write_text(sys.stdin.read())\n'
                + 'print(json.dumps({"result":"literal SQL received"}))\n')
            client.chmod(0o700)
            query = ("SELECT JSON_OBJECT('table', `online_recharge_cards`, 'quoted', '\"literal\"', "
                     "'payload', '$(touch " + str(marker) + ")', 'backtick', '`touch " + str(marker)
                     + "`');\n-- keep newlines and spaces")
            calls = []
            def compose(directory, *args, **kwargs):
                calls.append((args, kwargs))
                environment = {**os.environ, 'PATH': str(folder) + os.pathsep + os.environ['PATH'],
                               'MYSQL_ROOT_PASSWORD': 'local-fixture-only', 'MYSQL_DATABASE': 'fixture'}
                result = subprocess.run(['sh', '-c', args[-1]], input=kwargs['input_data'],
                    capture_output=True, text=True, env=environment, check=True)
                return result.stdout.strip()
            d = controller(current_job_database=lambda _: 'fixture', compose=compose)
            self.assertEqual(scope.database_read(d, folder, query), {'result': 'literal SQL received'})
            self.assertEqual(captured.read_text(), query + '\n')
            self.assertFalse(marker.exists())
            args, kwargs = calls[0]
            self.assertEqual(args[:-1], ('exec', '-e', 'MYSQL_DATABASE=fixture', '-T', 'mysql', 'sh', '-c'))
            self.assertNotIn(query, args[-1])
            self.assertNotIn('-e "', args[-1])
            self.assertIn('mysql --batch --raw --skip-column-names', args[-1])
            self.assertEqual(kwargs['timeout'], 60)

    def test_invalid_or_oversized_sql_never_invokes_compose(self):
        d = controller(current_job_database=MagicMock(), compose=MagicMock())
        for value in ('', None, 'x' * (128 * 1024 + 1)):
            with self.subTest(value_type=type(value).__name__), self.assertRaises(RuntimeError):
                scope.database_read(d, ROOT, value)
        d.current_job_database.assert_not_called()
        d.compose.assert_not_called()


class MigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='migration-', dir=RUNTIME)
        cls.old, cls.new = Path(cls.temporary.name) / 'old', Path(cls.temporary.name) / 'new'
        cls.old.mkdir(); cls.new.mkdir()
        source_fixture(cls.old, cls.new)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_baseline_contains_46_migrations_and_lock_and_only_one_addition(self):
        scope.migration_source_check(controller(), self.old, candidate=False)
        scope.migration_source_check(controller(), self.new)
        self.assertEqual(len(shared.migration_files(controller(), self.old)), 47)
        self.assertEqual(len(shared.migration_files(controller(), self.new)), 48)

    def test_source_refuses_extra_migration_schema_seed_and_symlinks(self):
        with directories() as (_, new):
            shutil.copytree(self.new, new, dirs_exist_ok=True)
            target = new / scope.MIGRATION_ROOT / '20261010000000_unapproved/migration.sql'
            target.parent.mkdir(); target.write_text('SELECT 1;')
            with self.assertRaisesRegex(RuntimeError, 'SCOPE_CHANGED'):
                scope.migration_source_check(controller(), new)
            target.unlink(); target.parent.rmdir()
            for name in (scope.SCHEMA_FILE, scope.SEED_FILE, scope.MIGRATION_ROOT + '/' + scope.MIGRATION_FILE):
                path = new / name
                original = path.read_bytes()
                path.write_bytes(original + b'\n')
                with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'SCOPE_CHANGED'):
                    scope.migration_source_check(controller(), new)
                path.write_bytes(original)
            path = new / scope.MIGRATION_ROOT / scope.MIGRATION_FILE
            path.unlink(); path.symlink_to(self.new / scope.MIGRATION_ROOT / scope.MIGRATION_FILE)
            with self.assertRaises(RuntimeError):
                scope.migration_source_check(controller(), new)

    def test_nine_tables_all_columns_indexes_and_real_decimal_verified(self):
        expectation = scope.schema_expectation(controller(), self.new)
        self.assertEqual(len(expectation['tables']), 9)
        amount = next(r for r in expectation['columns'] if r['table'] == 'online_recharge_bills' and r['column'] == 'amount')
        self.assertEqual(amount['columnType'], 'decimal(18,4)')
        self.assertEqual(amount['nullable'], 'YES')
        self.assertFalse(any('cvc' in r['column'] or 'cvv' in r['column'] for r in expectation['columns']))
        for applied in (False, True):
            with self.subTest(applied=applied), patch.object(scope, 'database_read', return_value=database_fixture(self.new, applied)):
                state = scope.migration_database_state(controller(), self.old, source=self.new)
                self.assertEqual(state['status'], 'APPLIED' if applied else 'PENDING')

    def test_database_rejects_checksum_unknown_history_duplicate_and_partial_schema(self):
        valid = database_fixture(self.new, True)
        variations = []
        value = copy.deepcopy(valid); value['rows'][0]['checksum'] = '0' * 64; variations.append(value)
        value = copy.deepcopy(valid); value['rows'][0]['name'] = '20261010000000_unapproved'; variations.append(value)
        value = copy.deepcopy(valid); value['rows'].append(value['rows'][0]); variations.append(value)
        value = copy.deepcopy(valid); value['columns'][0]['nullable'] = 'UNKNOWN'; variations.append(value)
        value = copy.deepcopy(valid); value['indexes'][0]['nonUnique'] = 9; variations.append(value)
        value = database_fixture(self.new, False); value['tables'] = valid['tables']; variations.append(value)
        for value in variations:
            with self.subTest(), patch.object(scope, 'database_read', return_value=value), self.assertRaises(RuntimeError):
                scope.migration_database_state(controller(), self.new)

    def test_historical_reader_removes_only_verified_addition_and_preserves_quick_action_evidence(self):
        raw = {'rows': [{'name': 'old', 'checksum': 'x', 'finished': 1, 'rolledBack': 0},
                        {'name': scope.MIGRATION_NAME, 'checksum': scope.MIGRATION_IDENTITY['sha256'], 'finished': 1, 'rolledBack': 0}],
               'columns': [{'keep': 'exact'}], 'indexes': [{'keep': 'exact'}]}
        d = controller(compose=MagicMock(return_value=json.dumps(raw)))
        with patch.object(scope, 'database_read', return_value=database_fixture(self.new, True)):
            proxy = scope.historical_controller(d, self.old, self.new)
        actual = json.loads(proxy.compose(self.old, 'exec', "TABLE_NAME='id_business_v2_quick_actions' FROM _prisma_migrations"))
        self.assertEqual(actual, {'rows': raw['rows'][:1], 'columns': raw['columns'], 'indexes': raw['indexes']})
        self.assertEqual(proxy.compose(self.old, 'exec', 'different query'), json.dumps(raw))
        raw['rows'][1]['checksum'] = 'f' * 64
        d.compose.return_value = json.dumps(raw)
        with self.assertRaisesRegex(RuntimeError, 'HISTORY_VIEW_INVALID'):
            proxy.compose(self.old, 'exec', "TABLE_NAME='id_business_v2_quick_actions' FROM _prisma_migrations")

    def test_active_queued_task_and_nonempty_assets_block_publication(self):
        for key in scope.TABLES:
            value = {n: 0 for n in scope.TABLES}; value[key] = 1
            with self.subTest(table=key), patch.object(scope, 'database_read', return_value=value), self.assertRaisesRegex(RuntimeError, 'NOT_EMPTY'):
                scope.require_fresh_resources(controller(), self.new)
        with patch.object(shared, 'jobs_idle', return_value={}), patch.object(scope, 'workspace_guard'), patch.object(scope, 'database_read', return_value={'busy': 1}), self.assertRaisesRegex(RuntimeError, 'TASKS_BUSY'):
            scope.jobs_idle(controller(), self.new, migrated=True)

    def test_timestamp_default_case_and_mysql_sort_order_are_normalized_without_weakening_enum(self):
        data = database_fixture(self.new, True)
        data['columns'].reverse(); data['indexes'].reverse()
        for row in data['columns']:
            if row['type'] == 'datetime' and row['default']:
                row['default'] = row['default'].upper()
        with patch.object(scope, 'database_read', return_value=data):
            self.assertEqual(scope.migration_database_state(controller(), self.new)['status'], 'APPLIED')
        enum = next(row for row in data['columns'] if row['type'] == 'enum' and row['default'])
        enum['default'] = enum['default'].upper()
        with patch.object(scope, 'database_read', return_value=data), self.assertRaisesRegex(RuntimeError, 'SCHEMA_CHANGED'):
            scope.migration_database_state(controller(), self.new)


class RecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='recovery-source-', dir=RUNTIME)
        cls.prepared = Path(cls.temporary.name)
        cls.archive = subprocess.check_output(['git', 'archive', '--format=tar.gz',
            '--prefix=id-business-system-' + scope.RECOVERY_COMMIT + '/', scope.RECOVERY_COMMIT], cwd=ROOT)
        cls.inventory = scope.archive_inventory(controller(), cls.archive, scope.RECOVERY_COMMIT, scope.RECOVERY_TREE)
        with tarfile.open(fileobj=io.BytesIO(cls.archive), mode='r:gz') as archive:
            prefix = 'id-business-system-' + scope.RECOVERY_COMMIT + '/'
            for member in archive.getmembers():
                if not member.isfile():
                    continue
                path = cls.prepared / member.name[len(prefix):]
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(archive.extractfile(member).read())
                path.chmod(0o755 if member.mode & 0o111 else 0o644)
        cls.policy = scope.recovery_policy(controller())
        # Recovery verifies the sealed three-table patch, not the mutable main
        # helper (which can contain independently authorised later repairs).
        cls.grant_before = (cls.prepared / scope.GRANT_SOURCE).read_bytes()
        cls.grant_after = cls.grant_before.replace(b"  'ip_whitelists',\n",
            b"  'ip_whitelists',\n  'online_recharge_bills',\n  'online_recharge_cards',\n  'online_recharge_proxies',\n", 1)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    @contextmanager
    def fixture(self):
        with tempfile.TemporaryDirectory(prefix='recovery-', dir=RUNTIME) as name:
            base = Path(name)
            previous = base / 'releases/old'
            source = base / 'releases' / ('20261009T120000Z-' + scope.RECOVERY_COMMIT[:12])
            previous.mkdir(parents=True)
            shutil.copytree(self.prepared, source)
            source.chmod(0o700)
            (base / 'current').symlink_to(previous)
            data = database_fixture(source, True)
            with patch.object(scope, 'database_read', return_value=data):
                state = scope.migration_database_state(controller(), previous, source=source)
            receipt = {'status': 'ONLINE_RECHARGE_FAILED_BEFORE_SWITCH', 'step': 'migration',
                'code': 'ONLINE_RECHARGE_STEP_FAILED', 'errorType': 'RuntimeError', 'rollbackOk': True,
                'rollback': {}, 'servicesAttempted': [], 'candidateCommit': scope.RECOVERY_COMMIT,
                'previousCommit': scope.BASELINE_COMMIT, 'migration': {**state, 'performed': True},
                'migrationAttempted': True, 'inverseMigrationPerformed': False, 'mediaVolumeDeleted': False,
                'currentPointsToCandidate': False, 'receiptPersisted': True}
            (source / scope.FAILURE_FILE).write_text(json.dumps(receipt))
            for filename in ('before-audit.json', 'backup-verification.json', scope.WORKSPACE_BACKUP_FILE):
                (source / filename).write_text('{}')
            d = controller(BASE=base)
            with ExitStack() as stack:
                stack.enter_context(patch.object(scope, 'RECOVERY_FAILURE_SHA256', scope.fingerprint(receipt)))
                stack.enter_context(patch.object(scope, 'recovery_policy', return_value=copy.deepcopy(self.policy)))
                stack.enter_context(patch.object(scope, 'database_read', return_value=data))
                stack.enter_context(patch.object(scope, 'fixed_recovery_inventory', return_value=self.inventory))
                image = stack.enter_context(patch.object(scope, 'verify_image_content'))
                backups = stack.enter_context(patch.object(scope, 'recovery_backups'))
                inspected = stack.enter_context(patch.object(scope, 'inspect_image'))
                yield d, previous, source, receipt, image, backups, inspected

    def test_fixed_policy_and_duplicate_json_are_closed(self):
        self.assertEqual(scope.fingerprint(self.policy), scope.RECOVERY_POLICY_SHA256)
        self.assertEqual(self.policy['sharedGrant']['addedDeleteTables'], list(scope.RECOVERY_DELETE_TABLES))
        for raw in (b'{"version":1,"version":1}', b'x' * (256 * 1024 + 1), b'{'):
            with self.subTest(raw_length=len(raw)), self.assertRaises(RuntimeError):
                scope.closed_recovery_json(controller(), raw)
        cases = []
        value = copy.deepcopy(self.policy); value['unknown'] = True; cases.append(value)
        value = copy.deepcopy(self.policy); value['candidateAllowedFiles'].append('apps/api/src/id-business-v2/online-recharge/online-recharge.service.ts'); cases.append(value)
        value = copy.deepcopy(self.policy); value['failedCommandId'] = 'f' * 36; cases.append(value)
        for value in cases:
            with self.subTest(fields=set(value)), patch.object(scope, 'closed_recovery_json', return_value=value), \
                    patch.object(scope, 'RECOVERY_POLICY_SHA256', scope.fingerprint(value)), self.assertRaises(RuntimeError):
                scope.recovery_policy(controller())

    def test_git_archive_tree_is_independent_of_failed_folder_name(self):
        self.assertEqual(scope.archive_inventory(controller(), self.archive, scope.RECOVERY_COMMIT, scope.RECOVERY_TREE), self.inventory)
        with self.assertRaisesRegex(RuntimeError, 'TREE_CHANGED'):
            scope.archive_inventory(controller(), self.archive, scope.RECOVERY_COMMIT, 'f' * 40)
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w:gz') as archive:
            member = tarfile.TarInfo('id-business-system-' + scope.RECOVERY_COMMIT + '/forged-link')
            member.type = tarfile.SYMTYPE; member.linkname = '/outside'
            archive.addfile(member)
        with self.assertRaisesRegex(RuntimeError, 'ARCHIVE_INVALID'):
            scope.archive_inventory(controller(), data.getvalue(), scope.RECOVERY_COMMIT, scope.RECOVERY_TREE)

    def test_applied_origin_rechecks_database_and_source_while_reusing_static_proofs(self):
        with self.fixture() as (d, previous, source, receipt, images, backups, inspected):
            first = scope.recovery_origin(d, previous)
            self.assertEqual(first['source'], source)
            self.assertEqual(first['state'], {k: v for k, v in receipt['migration'].items() if k != 'performed'})
            self.assertEqual(images.call_count, 4)
            backups.assert_called_once()
            self.assertEqual(scope.recovery_origin(d, previous)['marker'], first['marker'])
            self.assertEqual(images.call_count, 4)
            self.assertEqual(inspected.call_count, 4)
            (source / 'apps/api/src/id-business-v2/online-recharge/online-recharge.service.ts').write_text('forged source')
            with self.assertRaisesRegex(RuntimeError, 'TREE_CHANGED'):
                scope.recovery_origin(d, previous)

    def test_unsealed_or_changed_failure_is_rejected_before_any_image_execution(self):
        with self.fixture() as (d, previous, source, receipt, images, _, _):
            receipt['servicesAttempted'] = ['admin']
            (source / scope.FAILURE_FILE).write_text(json.dumps(receipt))
            with self.assertRaisesRegex(RuntimeError, 'PROVENANCE_CHANGED'):
                scope.recovery_origin(d, previous)
            images.assert_not_called()

    def test_unknown_file_symlink_and_second_matching_directory_are_rejected(self):
        for variation in ('unknown', 'symlink', 'second'):
            with self.subTest(variation=variation), self.fixture() as (d, previous, source, _, images, _, _):
                if variation == 'unknown':
                    (source / 'unapproved-source.txt').write_text('unapproved')
                elif variation == 'symlink':
                    path = source / 'package.json'; path.unlink(); path.symlink_to(ROOT / 'package.json')
                else:
                    (source.parent / ('20261009T120001Z-' + scope.RECOVERY_COMMIT[:12])).mkdir()
                with self.assertRaises(RuntimeError):
                    scope.recovery_origin(d, previous)
                images.assert_not_called()

    def test_partial_schema_and_nonmatching_completed_migration_cannot_be_resumed(self):
        with self.fixture() as (d, previous, source, _, images, _, _):
            data = database_fixture(source, True)
            data['columns'][0]['nullable'] = 'UNKNOWN'
            with patch.object(scope, 'database_read', return_value=data), self.assertRaisesRegex(RuntimeError, 'SCHEMA_CHANGED'):
                scope.recovery_origin(d, previous)
            data = database_fixture(source, True)
            data['rows'].append({'name': '20261010000000_unknown', 'checksum': 'f' * 64, 'finished': 1, 'rolledBack': 0})
            with patch.object(scope, 'database_read', return_value=data), self.assertRaisesRegex(RuntimeError, 'HISTORY_CHANGED'):
                scope.recovery_origin(d, previous)
            images.assert_not_called()

    def test_only_exact_three_delete_lines_and_control_changes_are_allowed(self):
        self.assertEqual(hashlib.sha256(self.grant_before).hexdigest(), self.policy['sharedGrant']['beforeSha256'])
        self.assertEqual(hashlib.sha256(self.grant_after).hexdigest(), self.policy['sharedGrant']['afterSha256'])
        with self.fixture() as (d, previous, source, *_):
            target = previous.parent / 'new-candidate'
            shutil.copytree(self.prepared, target)
            for name in self.policy['candidateAllowedFiles']:
                path = target / name; path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(self.grant_after if name == scope.GRANT_SOURCE else (ROOT / name).read_bytes())
                path.chmod(0o755 if (ROOT / name).stat().st_mode & 0o111 else 0o644)
            context = {'policy': self.policy, 'source': source}
            scope.candidate_recovery_source(d, target, context)
            helper = target / scope.GRANT_SOURCE
            helper.write_bytes(helper.read_bytes().replace(b"  'online_recharge_bills',\n", b"  'online_recharge_bills',\n  'online_recharge_tasks',\n"))
            with self.assertRaisesRegex(RuntimeError, 'SHARED_GATE_SOURCE_CHANGED'):
                scope.candidate_recovery_source(d, target, context)
            helper.write_bytes(self.grant_after)
            path = target / 'apps/admin/src/v2/features/online-recharge/unapproved.ts'
            path.write_text('unapproved UI change')
            with self.assertRaisesRegex(RuntimeError, 'BUILD_SOURCE_CHANGED'):
                scope.candidate_recovery_source(d, target, context)

    def test_historical_grant_rejects_bank_and_other_unsealed_source_changes(self):
        anchor = b'export const V2_RUNTIME_DELETE_TABLES = Object.freeze([\n'
        cases = {
            'later-bank-repair': self.grant_after.replace(anchor,
                anchor + b"  'id_business_v2_bank_recharge_cards',\n", 1),
            'fourth-online-table': self.grant_after.replace(b"  'online_recharge_bills',\n",
                b"  'online_recharge_bills',\n  'online_recharge_tasks',\n", 1),
            'duplicate-table': self.grant_after.replace(b"  'online_recharge_bills',\n",
                b"  'online_recharge_bills',\n  'online_recharge_bills',\n", 1),
            'reordered-tables': self.grant_after.replace(
                b"  'online_recharge_bills',\n  'online_recharge_cards',\n",
                b"  'online_recharge_cards',\n  'online_recharge_bills',\n", 1),
            'surrounding-source': self.grant_after + b'// unsealed change\n',
        }
        with self.fixture() as (d, previous, source, *_):
            target = previous.parent / 'new-candidate'; target.mkdir()
            helper = target / scope.GRANT_SOURCE; helper.parent.mkdir(parents=True)
            helper.write_bytes(self.grant_after)
            scope.grant_source_change(d, source, target, self.policy)
            for case, content in cases.items():
                with self.subTest(case=case):
                    self.assertNotEqual(content, self.grant_after)
                    helper.write_bytes(content)
                    with self.assertRaisesRegex(RuntimeError, 'SHARED_GATE_SOURCE_CHANGED'):
                        scope.grant_source_change(d, source, target, self.policy)
            helper.write_bytes(self.grant_after)
            (source / scope.GRANT_SOURCE).write_bytes(self.grant_before + b'// changed predecessor\n')
            with self.assertRaisesRegex(RuntimeError, 'SHARED_GATE_SOURCE_CHANGED'):
                scope.grant_source_change(d, source, target, self.policy)

    def test_current_seven_services_and_complete_predecessor_are_verified_through_projection(self):
        with self.fixture() as (d, previous, source, *_):
            context = {'source': source, 'policy': self.policy, 'state': {'status': 'APPLIED'},
                       'marker': scope.recovery_marker(self.policy)}
            original = self.policy['preflight']
            running = copy.deepcopy(original['services'])
            manifest = {'apiWorkspacePublication': {'scope': 'API_ADMIN_WORKSPACE'}}
            evidence = {'apiSource': {'kind': 'API_WORKSPACE_BUILD_PROVEN'},
                        'manifestSha256': original['manifestSha256']}
            receipt = {'status': 'API_ADMIN_WORKSPACE_VERIFIED', 'volumePreserved': True,
                'volumeDeletionPerformed': False, 'registrationHealthChecked': True,
                'services': running, 'buildProofSha256': original['workspaceBuildProofSha256']}
            reader = SimpleNamespace(projected=True)
            legacy = SimpleNamespace(baseline=MagicMock(return_value=(previous, manifest, running, evidence)),
                                     readback=MagicMock(return_value=receipt))
            with ExitStack() as stack:
                for name, mock in {'release_recovery': MagicMock(return_value=context),
                    'historical_controller': MagicMock(return_value=reader), 'legacy': MagicMock(return_value=legacy),
                    'workspace_guard': MagicMock(return_value={}), 'workspace_files': MagicMock(return_value={}),
                    'workspace_origin': MagicMock(),
                    'verify_permission_seed': MagicMock(), 'require_fresh_resources': MagicMock(),
                    'jobs_idle': MagicMock(return_value={}), 'snapshot': MagicMock(return_value=running)}.items():
                    stack.enter_context(patch.object(scope, name, mock))
                stack.enter_context(patch.object(scope.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * 1024**3)))
                _, _, _, verified = scope.baseline(d, scope.BASELINE_COMMIT)
                self.assertEqual(verified['migrationRecovery'], context['marker'])
                self.assertIs(legacy.baseline.call_args.args[0], reader)
                self.assertIs(legacy.readback.call_args.args[0], reader)
                for service in running:
                    old = running[service]['containerId']; running[service]['containerId'] = '0' * 64
                    with self.subTest(service=service), self.assertRaisesRegex(RuntimeError, 'PRESERVED_CONTAINER_CHANGED'):
                        scope.baseline(d, scope.BASELINE_COMMIT)
                    running[service]['containerId'] = old

    def test_original_mysql_backup_file_and_s3_checksum_are_reverified_without_age_limit(self):
        verify = scope.recovery_backups
        with self.fixture() as (d, previous, source, *_):
            backup_root = d.BASE / 'backups/mysql'; backup_root.mkdir(parents=True)
            path = backup_root / 'id-business-v2-20261009T120001Z.sql.gz'
            path.write_bytes(gzip.compress(b'-- synthetic isolated recovery backup\n', mtime=0))
            os.utime(path, (1, 1))
            digest = scope.file_digest(path)
            (source / 'backup-verification.json').write_text(json.dumps({'name': path.name, 'sha256': digest,
                'size': path.stat().st_size, 's3Verified': True}))
            (source / scope.WORKSPACE_BACKUP_FILE).write_text(json.dumps({'name': 'synthetic-workspace'}))
            head = {'ContentLength': path.stat().st_size, 'ServerSideEncryption': 'AES256',
                    'ChecksumSHA256': base64.b64encode(bytes.fromhex(digest)).decode()}
            d.run = MagicMock(return_value=json.dumps(head))
            d.environment_values = lambda _: {'MYSQL_BACKUP_S3_BUCKET': 'isolated-fixture-bucket'}
            with patch.object(shared, 'audit_receipt', return_value={'checksSha256': 'f' * 64}), \
                    patch.object(shared, 'workspace_volume', return_value={'fixture': 'volume'}), \
                    patch.object(scope, 'workspace_backup_receipt') as workspace:
                verify(d, source, previous)
                workspace.assert_called_once()
                manifest = {'commit': scope.RESTORED_COMMIT, 'backupBeforeRelease': path.name,
                    'workspaceBackupBeforeRelease': 'synthetic-workspace', 'workspaceBackupSha256': 'e' * 64}
                record = {'workspaceBackupSha256': 'e' * 64}
                verify(d, source, previous, commit=scope.RESTORED_COMMIT, manifest=manifest, record=record)
                self.assertEqual(workspace.call_args.args[-2:], (manifest, record))
                with self.assertRaisesRegex(RuntimeError, 'BACKUP_RECEIPT_CHANGED'):
                    verify(d, source, previous, commit=scope.RESTORED_COMMIT,
                           manifest={**manifest, 'backupBeforeRelease': 'forged.sql.gz'}, record=record)
                head['ChecksumSHA256'] = base64.b64encode(b'\0' * 32).decode()
                d.run.return_value = json.dumps(head)
                with self.assertRaisesRegex(RuntimeError, 'BACKUP_UNVERIFIED'):
                    verify(d, source, previous)
                path.write_bytes(path.read_bytes() + b'changed')
                with self.assertRaisesRegex(RuntimeError, 'BACKUP_RECEIPT_CHANGED'):
                    verify(d, source, previous)


class RestoredRecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='restored-source-', dir=RUNTIME)
        cls.prepared = Path(cls.temporary.name)
        cls.inventories = {}
        for commit, tree in ((scope.RECOVERY_COMMIT, scope.RECOVERY_TREE), (scope.RESTORED_COMMIT, scope.RESTORED_TREE)):
            archive = subprocess.check_output(['git', 'archive', '--format=tar.gz',
                '--prefix=id-business-system-' + commit + '/', commit], cwd=ROOT)
            cls.inventories[commit] = scope.archive_inventory(controller(), archive, commit, tree)
            with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as opened:
                for member in opened.getmembers():
                    if not member.isfile():
                        continue
                    path = cls.prepared / commit / member.name[len('id-business-system-' + commit + '/'):]
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(opened.extractfile(member).read())
                    path.chmod(0o755 if member.mode & 0o111 else 0o644)
        cls.policy = scope.recovery_policy(controller())

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    @contextmanager
    def fixture(self):
        with tempfile.TemporaryDirectory(prefix='restored-', dir=RUNTIME) as name:
            base = Path(name); previous = base / 'releases/old'
            previous.mkdir(parents=True)
            source = base / 'releases' / ('20261009T140000Z-' + scope.RESTORED_COMMIT[:12])
            shutil.copytree(self.prepared / scope.RESTORED_COMMIT, source); source.chmod(0o700)
            (base / 'current').symlink_to(previous)
            for filename in ('docker-compose.aws-mysql.yml', 'deploy/caddy/Caddyfile.aws', scope.SCHEMA_FILE):
                path = previous / filename; path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(subprocess.check_output(['git', 'show', scope.BASELINE_COMMIT + ':' + filename], cwd=ROOT))
            (previous / '.env.aws.production').write_text('APP_PUBLIC_URL=https://fixture.invalid\n')
            old_images = {n: {'reference': r['reference'], 'digest': r['image'], 'sourceCommit': scope.BASELINE_COMMIT}
                          for n, r in self.policy['preflight']['services'].items() if n not in ('mysql', 'caddy')}
            old_images['migrate'] = {'reference': 'old-migrate', 'digest': 'sha256:' + 'f' * 64, 'sourceCommit': scope.BASELINE_COMMIT}
            (previous / 'release-manifest.json').write_text(json.dumps({'commit': scope.BASELINE_COMMIT, 'images': old_images}))
            old_before = copy.deepcopy(self.policy['preflight']['services'])
            for name in ('api', 'admin'):
                old_before[name]['containerId'] = '9' * 64
            (previous / shared.STATE_FILE).write_text(json.dumps({'before': old_before}))
            (previous / 'compose.release.json').write_text(json.dumps({'services': {n: {'image': r['reference']} for n, r in old_images.items()}}))
            policy = copy.deepcopy(self.policy)
            for before in (policy['preflight'], policy['restoredAttempt']['preflight']):
                before['manifestSha256'] = scope.file_digest(previous / 'release-manifest.json')
            proof_value = policy['restoredAttempt']['buildProof']
            (source / 'compose.release.json').write_text(json.dumps({'services': {n: {'image': r['reference']} for n, r in proof_value['images'].items()}}))
            data = database_fixture(source, True)
            with patch.object(scope, 'database_read', return_value=data):
                state = scope.migration_database_state(controller(), previous, source=source)
            receipt = {'status': 'ONLINE_RECHARGE_FAILED_RESTORED', 'step': 'audit-after',
                'code': 'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED', 'errorType': 'RuntimeError',
                'rollbackOk': True, 'rollback': {n: 'RESTORED' for n in scope.SWITCH_ORDER},
                'servicesAttempted': list(scope.SWITCH_ORDER), 'candidateCommit': scope.RESTORED_COMMIT,
                'previousCommit': scope.BASELINE_COMMIT, 'migration': {**state, 'performed': False},
                'migrationAttempted': False, 'inverseMigrationPerformed': False, 'mediaVolumeDeleted': False,
                'currentPointsToCandidate': False, 'receiptPersisted': True}
            self.assertEqual(scope.fingerprint(receipt), scope.RESTORED_FAILURE_SHA256)
            migration_origin = {'commit': 'c' * 40, 'manifestSha256': 'd' * 64, 'buildProofSha256': 'e' * 64}
            evidence = {'manifestSha256': policy['preflight']['manifestSha256'],
                'environmentSha256': scope.file_digest(previous / '.env.aws.production'),
                'apiSource': {'imageId': policy['preflight']['services']['api']['image'], 'revision': scope.BASELINE_COMMIT,
                              'kind': 'API_WORKSPACE_BUILD_PROVEN'},
                'guards': {'rechargeIdle': True, 'registrationBusy': False, 'registrationLeaseActive': False,
                           'registrationWindowRetained': False},
                'freeBytes': 10 * 1024**3, 'migrationOrigin': migration_origin, 'workspaceVolume': {'fixture': 'volume'},
                'workspaceIdle': True, 'workspaceOriginFiles': {
                    shared.STATE_FILE: scope.file_digest(previous / shared.STATE_FILE)},
                'workspaceBuildProofSha256': policy['preflight']['workspaceBuildProofSha256'],
                'migrationRecovery': scope.original_recovery_marker(policy)}
            after = copy.deepcopy(policy['preflight']['services'])
            for n in scope.UPDATED:
                row = copy.deepcopy(after['api']); row.update(image=proof_value['images'][n]['imageId'],
                    reference=proof_value['images'][n]['reference'], containerId='0' * 64, startedAtSha256='1' * 64)
                after[n] = row
            audit = {'checkCount': 49, 'violationCount': 0, 'mode': 'STRICT_ZERO_49', 'checksSha256': 'f' * 64}
            grants = {'ok': True, 'newTableCount': 9, 'runtimeTableCount': 70}
            preservation = {'environment': {'fixture': 'environment'}, 'compose': {'fixture': 'compose'},
                            'caddy': scope.verify_caddy_projection(controller(), previous, source)}
            manifest = {'commit': scope.RESTORED_COMMIT, 'sourceBranch': 'main', 'sourceTree': scope.RESTORED_TREE,
                'previousCommit': scope.BASELINE_COMMIT, 'previousRelease': str(previous),
                'previousManifestSha256': evidence['manifestSha256'], 'releaseTag': 'v2-production-' + source.name[:16],
                'deployedAt': '2026-10-09T14:00:00Z', 'ciWorkflow': 'Quality Gate', 'ciWorkflowRunId': 123,
                'deploymentRun': f'github-actions-{scope.RESTORED_RUN}-{scope.RESTORED_ATTEMPT}',
                'imageBuildRun': f'github-actions-{scope.RESTORED_RUN}-{scope.RESTORED_ATTEMPT}',
                'servicesUpdated': list(scope.UPDATED), 'sourceArchiveSha256': '2' * 64,
                'images': {**old_images, **{n: {'reference': r['reference'], 'digest': r['imageId'],
                          'sourceCommit': scope.RESTORED_COMMIT} for n, r in proof_value['images'].items()}},
                'backupBeforeRelease': 'fixture.sql.gz', 'migrationApplied': True, 'migrationPerformed': False,
                'workspaceBackupBeforeRelease': 'fixture.sqlite3.gz', 'workspaceBackupSha256': '3' * 64,
                'newMigrations': [scope.MIGRATION_FILE], 'dataAuditBefore': audit, 'dataAuditAfter': audit,
                'databaseGrants': grants, 'rollback': {'release': str(previous),
                    'images': {n: policy['preflight']['services'][n]['image'] for n in ('api', 'admin')},
                    'servicesAdded': ['online-recharge'], 'inverseMigrationAllowed': False,
                    'mediaVolumePreserved': True, 'workspaceVolumePreserved': True},
                'onlineRechargePublication': {'version': 1, 'scope': scope.SCOPE,
                    'buildProofSha256': scope.fingerprint(proof_value), 'migration': dict(scope.MIGRATION_IDENTITY),
                    'legacyWorkersPublished': False, 'configurationScope': 'ONLINE_RECHARGE_VOLUME_LOOPBACK_ONLY'},
                'preservedMigrationOrigin': shared.migration_successor_marker(migration_origin),
                'migrationRecovery': scope.original_recovery_marker(policy)}
            record = {'before': copy.deepcopy(policy['preflight']['services']), 'after': after, 'baselineEvidence': evidence,
                'buildProofSha256': scope.fingerprint(proof_value), 'configurationBefore': scope.configuration_hashes(previous),
                'configurationAfter': scope.configuration_hashes(source), 'preservation': preservation,
                'migration': {**state, 'performed': False}, 'databaseGrants': grants, 'workspaceBackupSha256': '3' * 64}
            documents = {scope.FAILURE_FILE: receipt, 'release-manifest.json': manifest, scope.STATE_FILE: record,
                scope.PROOF_FILE: proof_value, 'before-audit.json': audit, 'after-audit.json': audit,
                'backup-verification.json': {}, scope.WORKSPACE_BACKUP_FILE: {}}
            def save():
                for filename, value in documents.items():
                    (source / filename).write_text(json.dumps(value))
            save()
            context = {'policy': policy, 'state': state, 'source': self.prepared / scope.RECOVERY_COMMIT,
                       'marker': scope.recovery_marker(policy)}
            d = controller(BASE=base)
            with ExitStack() as stack:
                stack.enter_context(patch.object(scope, 'fixed_recovery_inventory',
                    side_effect=lambda d, commit=scope.RECOVERY_COMMIT, tree=scope.RECOVERY_TREE: self.inventories[commit]))
                stack.enter_context(patch.object(shared, 'audit_receipt', side_effect=lambda d, path: json.loads(path.read_text())
                    if path.parent == source else audit))
                stack.enter_context(patch.object(scope, 'verify_environment', return_value=preservation['environment']))
                stack.enter_context(patch.object(scope, 'verify_compose', return_value=preservation['compose']))
                images = stack.enter_context(patch.object(scope, 'verify_image_content'))
                backups = stack.enter_context(patch.object(scope, 'recovery_backups'))
                workspace = stack.enter_context(patch.object(scope, 'workspace_origin'))
                historical = stack.enter_context(patch.object(scope, 'historical_guard'))
                inspected = stack.enter_context(patch.object(scope, 'inspect_image'))
                yield d, previous, source, context, documents, save, images, backups, workspace, historical, inspected

    def test_policy_closes_and_seals_the_second_attempt_and_original_marker(self):
        self.assertEqual(scope.original_recovery_marker(self.policy)['policySha256'], scope.ORIGINAL_RECOVERY_POLICY_SHA256)
        self.assertEqual(scope.recovery_marker(self.policy)['policySha256'], scope.RECOVERY_POLICY_SHA256)
        self.assertEqual(scope.recovery_marker(self.policy)['restoredAttempt']['buildProofSha256'], scope.RESTORED_PROOF_SHA256)
        for key, bad in (('version', True), ('commit', '0' * 40), ('sourceTree', '0' * 40), ('workflowRunId', '123'),
                         ('workflowRunAttempt', '2'), ('commandId', scope.RECOVERY_COMMAND),
                         ('failureReceiptSha256', '0' * 64), ('unknown', True)):
            candidate = copy.deepcopy(self.policy); candidate['restoredAttempt'][key] = bad
            with self.subTest(key=key), patch.object(scope, 'closed_recovery_json', return_value=candidate), \
                    patch.object(scope, 'RECOVERY_POLICY_SHA256', scope.fingerprint(candidate)), self.assertRaises(RuntimeError):
                scope.recovery_policy(controller())
        for key in ('buildProof', 'preflight'):
            candidate = copy.deepcopy(self.policy); candidate['restoredAttempt'][key]['sourceTree'] = '0' * 40
            with self.subTest(key=key), patch.object(scope, 'closed_recovery_json', return_value=candidate), \
                    patch.object(scope, 'RECOVERY_POLICY_SHA256', scope.fingerprint(candidate)), self.assertRaises(RuntimeError):
                scope.recovery_policy(controller())

    def test_both_immutable_sources_and_complete_second_publication_are_required(self):
        with self.fixture() as (d, previous, source, context, documents, save, images, backups, workspace, historical, inspected):
            result = scope.restored_origin(d, previous, context)
            self.assertEqual(result['source'], source)
            self.assertEqual(result['configurationAnchors']['api'], {
                'oldBeforeContainerId': '9' * 64, 'candidateAfterContainerId': '0' * 64})
            self.assertEqual(images.call_count, 4); backups.assert_called_once()
            workspace.assert_called_once_with(d, previous, previous, documents[scope.STATE_FILE]['baselineEvidence'],
                                              documents[scope.STATE_FILE]['before'])
            scope.restored_origin(d, previous, context)
            self.assertEqual(images.call_count, 4); self.assertEqual(inspected.call_count, 4)
            self.assertEqual(historical.call_count, 2)
            with patch.object(scope, 'recovery_origin', return_value=context), patch.object(scope, 'restored_origin', return_value=result) as second:
                combined = scope.release_recovery(d, previous)
                self.assertEqual(combined['restored'], result); second.assert_called_once()
            (previous / shared.STATE_FILE).write_text(json.dumps({'before': {'api': {'containerId': '8' * 64}}}))
            with self.assertRaisesRegex(RuntimeError, 'WORKSPACE_ORIGIN_CHANGED'):
                scope.restored_origin(d, previous, context)

    def test_missing_or_forged_failure_never_reaches_images_backups_or_identity_exception(self):
        changes = [('step', 'switch'), ('status', 'ONLINE_RECHARGE_FAILED_BEFORE_SWITCH'), ('rollbackOk', False),
            ('rollback', {'api': 'RESTORED'}), ('servicesAttempted', ['api']), ('migrationAttempted', True),
            ('currentPointsToCandidate', True), ('receiptPersisted', False), ('unknown', True)]
        with self.fixture() as (d, previous, source, context, documents, save, images, backups, *_):
            original = copy.deepcopy(documents[scope.FAILURE_FILE])
            for key, bad in changes:
                documents[scope.FAILURE_FILE] = {**original, key: bad}; save()
                with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'PROVENANCE_CHANGED'):
                    scope.restored_origin(d, previous, context)
            images.assert_not_called(); backups.assert_not_called()
            (source / scope.FAILURE_FILE).unlink()
            with self.assertRaisesRegex(RuntimeError, 'PROVENANCE_CHANGED'):
                scope.restored_origin(d, previous, context)

    def test_second_folder_unknown_source_symlink_wrong_tree_and_duplicate_are_rejected(self):
        with self.fixture() as (d, previous, source, context, _, save, images, *_):
            extra = source / 'forged-extra.txt'; extra.write_text('forged')
            with self.assertRaisesRegex(RuntimeError, 'TREE_CHANGED'):
                scope.restored_origin(d, previous, context)
            extra.unlink(); extra.symlink_to(source / scope.PROOF_FILE)
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_INVALID'):
                scope.restored_origin(d, previous, context)
            extra.unlink()
            with patch.object(scope, 'fixed_recovery_inventory', return_value=self.inventories[scope.RECOVERY_COMMIT]), \
                    self.assertRaisesRegex(RuntimeError, 'TREE_CHANGED'):
                scope.restored_origin(d, previous, context)
            duplicate = source.with_name('20261009T140001Z-' + scope.RESTORED_COMMIT[:12]); duplicate.mkdir()
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_INVALID'):
                scope.restored_origin(d, previous, context)
            images.assert_not_called()

    def test_every_publication_document_change_and_missing_backup_is_rejected(self):
        changes = [('release-manifest.json', 'commit', '0' * 40), ('release-manifest.json', 'sourceTree', '0' * 40),
            ('release-manifest.json', 'deploymentRun', 'github-actions-123-1'),
            ('release-manifest.json', 'migrationPerformed', True), ('release-manifest.json', 'sourceArchiveSha256', 'invalid'),
            ('release-manifest.json', 'migrationRecovery', scope.recovery_marker(self.policy)),
            (scope.STATE_FILE, 'before', {}), (scope.STATE_FILE, 'after', {}),
            (scope.STATE_FILE, 'configurationBefore', {}), (scope.STATE_FILE, 'configurationAfter', {}),
            (scope.STATE_FILE, 'migration', {'status': 'APPLIED', 'performed': True}),
            (scope.PROOF_FILE, 'commit', '0' * 40)]
        with self.fixture() as (d, previous, source, context, documents, save, images, *_):
            original = copy.deepcopy(documents)
            for filename, key, bad in changes:
                documents.clear(); documents.update(copy.deepcopy(original)); documents[filename][key] = bad; save()
                with self.subTest(file=filename, key=key), self.assertRaises(RuntimeError):
                    scope.restored_origin(d, previous, context)
            documents.clear(); documents.update(original); save()
            for filename in ('release-manifest.json', scope.PROOF_FILE, scope.STATE_FILE, 'backup-verification.json', scope.WORKSPACE_BACKUP_FILE):
                raw = (source / filename).read_bytes(); (source / filename).unlink()
                with self.subTest(file=filename), self.assertRaises(RuntimeError):
                    scope.restored_origin(d, previous, context)
                (source / filename).write_bytes(raw)
            images.assert_not_called()

    def test_all_five_retained_identities_and_second_updated_images_are_fully_bound(self):
        with self.fixture() as (d, previous, _, context, documents, save, *_):
            original = copy.deepcopy(documents[scope.STATE_FILE]['after'])
            for name in scope.PRESERVED:
                for key in scope.SERVICE_IDENTITY_KEYS:
                    documents[scope.STATE_FILE]['after'] = copy.deepcopy(original)
                    documents[scope.STATE_FILE]['after'][name][key] = 'forged'; save()
                    with self.subTest(service=name, key=key), self.assertRaises(RuntimeError):
                        scope.restored_origin(d, previous, context)
            for name in scope.UPDATED:
                for key in ('image', 'reference'):
                    documents[scope.STATE_FILE]['after'] = copy.deepcopy(original)
                    documents[scope.STATE_FILE]['after'][name][key] = 'forged'; save()
                    with self.subTest(service=name, key=key), self.assertRaises(RuntimeError):
                        scope.restored_origin(d, previous, context)

    def test_only_proven_restoration_permits_two_api_admin_identity_fields(self):
        context = {'policy': self.policy, 'restored': {'source': 'sealed'}}
        original = copy.deepcopy(self.policy['preflight']['services'])
        recreated = copy.deepcopy(original)
        for name in ('api', 'admin'):
            recreated[name]['containerId'] = '0' * 64; recreated[name]['startedAtSha256'] = '1' * 64
        scope.recovery_services(controller(), recreated, context)
        with self.assertRaisesRegex(RuntimeError, 'PRESERVED_CONTAINER_CHANGED'):
            scope.recovery_services(controller(), recreated, {'policy': self.policy})
        for name in original:
            for key in scope.SERVICE_IDENTITY_KEYS:
                if name in ('api', 'admin') and key in ('containerId', 'startedAtSha256'):
                    continue
                forged = copy.deepcopy(recreated); forged[name][key] = 'forged'
                with self.subTest(service=name, key=key), self.assertRaisesRegex(RuntimeError, 'PRESERVED_CONTAINER_CHANGED'):
                    scope.recovery_services(controller(), forged, context)
        for name in ('api', 'admin'):
            forged = copy.deepcopy(recreated); forged[name]['containerId'] = 'invalid'
            with self.assertRaisesRegex(RuntimeError, 'PRESERVED_CONTAINER_CHANGED'):
                scope.recovery_services(controller(), forged, context)

    def test_image_backup_workspace_and_current_history_failures_cannot_seal_restoration(self):
        with self.fixture() as (d, previous, _, context, _, _, images, backups, workspace, historical, _):
            for guard, code in ((images, 'ONLINE_RECHARGE_IMAGE_CONTENT_CHANGED'),
                                (backups, 'ONLINE_RECHARGE_BACKUP_UNVERIFIED'),
                                (workspace, 'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED'),
                                (historical, 'API_ADMIN_MIGRATION_ORIGIN_CHANGED')):
                d._onlineRechargeVerifiedRestored = None
                guard.side_effect = RuntimeError(code)
                with self.subTest(code=code), self.assertRaisesRegex(RuntimeError, code):
                    scope.restored_origin(d, previous, context)
                guard.side_effect = None
                if guard is not historical:
                    self.assertIsNone(d._onlineRechargeVerifiedRestored)


class RestoredConfigurationDiagnosticTests(unittest.TestCase):
    def fixture(self, service='api', original_replace='cid', current_replace='cid', separator='-'):
        anchors = {'oldBeforeContainerId': '1' * 64, 'candidateAfterContainerId': '2' * 64}
        stable_name = separator.join(('fixture', service, '1'))
        metadata = {'Id': '3' * 64, 'Image': 'sha256:' + 'c' * 64, 'Name': '/' + stable_name,
            'State': {'Status': 'running', 'Health': {'Status': 'healthy'}, 'StartedAt': '2026-10-10T01:00:00Z'},
            'Config': {'Image': 'old-' + service, 'Hostname': '3' * 12, 'Env': ['FIXTURE=SECRET_MUST_NOT_ESCAPE'],
                'Labels': {'com.docker.compose.project': 'fixture', 'com.docker.compose.service': service,
                    'com.docker.compose.container-number': '1', 'com.docker.compose.replace':
                        anchors['candidateAfterContainerId'] if current_replace == 'cid'
                        else service + '-1' if current_replace == 'slot' else stable_name,
                    'unrelated.label': 'unchanged'}},
            'HostConfig': {'NetworkMode': 'fixture_default', 'ReadonlyRootfs': True},
            'Mounts': [{'Destination': '/z', 'Source': '/fixture/z', 'RW': False},
                       {'Destination': '/a', 'Source': '/fixture/a', 'RW': True}]}
        configuration = {k: copy.deepcopy(metadata[k]) for k in ('Config', 'HostConfig', 'Mounts')}
        configuration['Mounts'].sort(key=lambda m: m['Destination'])
        actual = {**states()[service], 'containerId': metadata['Id'],
            'startedAtSha256': hashlib.sha256(metadata['State']['StartedAt'].encode()).hexdigest(),
            'environmentSha256': scope.fingerprint(sorted(metadata['Config']['Env'])),
            'configurationSha256': scope.fingerprint(configuration)}
        configuration['Config']['Hostname'] = '4' * 12
        if original_replace == 'absent':
            configuration['Config']['Labels'].pop('com.docker.compose.replace')
        else:
            configuration['Config']['Labels']['com.docker.compose.replace'] = (
                anchors['oldBeforeContainerId'] if original_replace == 'cid'
                else service + '-1' if original_replace == 'slot' else stable_name)
        original = {**actual, 'containerId': '4' * 64, 'startedAtSha256': '5' * 64,
                    'configurationSha256': scope.fingerprint(configuration)}
        return metadata, actual, original, anchors

    def test_only_two_native_fields_uniquely_reconstruct_four_finite_historical_forms(self):
        for service in ('api', 'admin'):
            for old in ('cid', 'name', 'slot', 'absent'):
                for current in ('cid', 'name', 'slot'):
                    for separator in ('-', '_'):
                        values = self.fixture(service, old, current, separator)
                        preserved = copy.deepcopy(values)
                        with self.subTest(service=service, old=old, current=current, separator=separator):
                            result = scope.restored_configuration_projection(controller(), service, *values)
                            self.assertEqual(result, {'rawSha256': values[1]['configurationSha256'],
                                                      'projectedSha256': values[2]['configurationSha256']})
                            self.assertEqual(values, preserved)

    def test_native_slot_rejects_wrong_service_number_secret_and_other_configuration_drift(self):
        for service in ('api', 'admin'):
            for bad in (('admin' if service == 'api' else 'api') + '-1', service + '-0',
                        service + '-2', service + '_1', 'SECRET_MUST_NOT_ESCAPE'):
                values = self.fixture(service, 'slot', 'slot')
                values[0]['Config']['Labels']['com.docker.compose.replace'] = bad
                configuration = {k: values[0][k] for k in ('Config', 'HostConfig', 'Mounts')}
                configuration['Mounts'] = sorted(configuration['Mounts'], key=lambda m: m['Destination'])
                values[1]['configurationSha256'] = scope.fingerprint(configuration)
                with self.subTest(service=service, kind='replace'), self.assertRaises(scope.ProjectionRejection) as error:
                    scope.restored_configuration_projection(controller(), service, *values)
                self.assertEqual(error.exception.reason, 'REPLACE_MISMATCH')
                self.assertNotIn('SECRET_MUST_NOT_ESCAPE', str(error.exception))
            changes = [(('Config', 'Labels', 'unrelated.label'), 'changed'),
                       (('Config', 'Env'), ['FIXTURE=changed']), (('HostConfig', 'ReadonlyRootfs'), False),
                       (('Mounts',), [{'Destination': '/z', 'Source': '/changed', 'RW': False}])]
            for path, changed in changes:
                values = self.fixture(service, 'slot', 'slot'); target = values[0]
                for key in path[:-1]:
                    target = target[key]
                target[path[-1]] = changed
                configuration = {k: values[0][k] for k in ('Config', 'HostConfig', 'Mounts')}
                configuration['Mounts'] = sorted(configuration['Mounts'], key=lambda m: m['Destination'])
                values[1]['configurationSha256'] = scope.fingerprint(configuration)
                with self.subTest(service=service, path=path), self.assertRaises(scope.ProjectionRejection):
                    scope.restored_configuration_projection(controller(), service, *values)

    def test_raw_snapshot_and_every_identity_field_are_verified_before_projection(self):
        paths = [('Id',), ('Image',), ('Config', 'Image'), ('State', 'Status'),
                 ('State', 'Health', 'Status'), ('State', 'StartedAt')]
        for path in paths:
            values = self.fixture(); target = values[0]
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = 'forged'
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                scope.restored_configuration_projection(controller(), 'api', *values)
        for key in ('configurationSha256', 'startedAtSha256', 'environmentSha256', 'containerId'):
            values = self.fixture(); values[1][key] = '0' * 64
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                scope.restored_configuration_projection(controller(), 'api', *values)

    def test_names_hostname_replace_labels_environment_host_config_and_mount_changes_are_rejected(self):
        changes = [(('Name',), '/arbitrary-name'), (('Config', 'Hostname'), 'custom-host'),
            (('Config', 'Labels', 'com.docker.compose.replace'), 'unsealed'),
            (('Config', 'Labels', 'com.docker.compose.project'), 'other'),
            (('Config', 'Labels', 'com.docker.compose.service'), 'admin'),
            (('Config', 'Labels', 'com.docker.compose.container-number'), '2'),
            (('Config', 'Labels', 'unrelated.label'), 'changed'),
            (('Config', 'Env'), ['FIXTURE=changed']), (('HostConfig', 'ReadonlyRootfs'), False),
            (('Mounts',), [{'Destination': '/changed', 'Source': '/fixture/z', 'RW': False}])]
        for path, changed in changes:
            values = self.fixture(); target = values[0]
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = changed
            configuration = {k: values[0][k] for k in ('Config', 'HostConfig', 'Mounts')}
            configuration['Mounts'] = sorted(configuration['Mounts'], key=lambda m: m['Destination'])
            values[1]['configurationSha256'] = scope.fingerprint(configuration)
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                scope.restored_configuration_projection(controller(), 'api', *values)
        values = self.fixture(); values[3]['unsealed'] = '0' * 64
        with self.assertRaises(RuntimeError):
            scope.restored_configuration_projection(controller(), 'api', *values)

    def test_no_match_or_ambiguous_match_never_proves_projection(self):
        values = self.fixture(); values[2]['configurationSha256'] = '0' * 64
        with self.assertRaises(RuntimeError):
            scope.restored_configuration_projection(controller(), 'api', *values)
        values = self.fixture()
        for row in values[1:3]:
            row['environmentSha256'] = row['configurationSha256'] = '0' * 64
        with patch.object(scope, 'fingerprint', return_value='0' * 64), self.assertRaises(scope.ProjectionRejection) as error:
            scope.restored_configuration_projection(controller(), 'api', *values)
        self.assertEqual(error.exception.reason, 'PROJECTED_HASH_AMBIGUOUS')

    def test_every_fixed_rejection_stage_retains_the_existing_projection_predicates(self):
        changes = [(3, ('extra',), 'secret', 'INPUT_INVALID'),
            (0, ('Id',), 'forged', 'METADATA_MISMATCH'),
            (0, ('Config', 'Hostname'), 'custom', 'HOSTNAME_MISMATCH'),
            (1, ('configurationSha256',), '0' * 64, 'RAW_HASH_MISMATCH'),
            (0, ('Config', 'Labels', 'com.docker.compose.service'), 'admin', 'COMPOSE_LABELS_MISMATCH'),
            (0, ('Name',), '/arbitrary', 'NAME_MISMATCH'),
            (0, ('Config', 'Labels', 'com.docker.compose.replace'), 'unsealed', 'REPLACE_MISMATCH'),
            (0, ('Config', 'Labels', 'unrelated.label'), 'changed', 'PROJECTED_HASH_MISMATCH')]
        for index, path, changed, expected in changes:
            values = self.fixture(); target = values[index]
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = changed
            if index == 0:
                configuration = {k: values[0][k] for k in ('Config', 'HostConfig', 'Mounts')}
                configuration['Mounts'] = sorted(configuration['Mounts'], key=lambda m: m['Destination'])
                values[1]['configurationSha256'] = scope.fingerprint(configuration)
            with self.subTest(reason=expected), self.assertRaises(scope.ProjectionRejection) as error:
                scope.restored_configuration_projection(controller(), 'api', *values)
            self.assertEqual(error.exception.reason, expected)
            self.assertEqual(str(error.exception), 'ONLINE_RECHARGE_CONTAINER_CHANGED')

    def test_finite_diagnostic_reports_all_seven_services_but_does_not_relax_main_gate(self):
        original, actual = states(), states()
        metadata, anchors = {}, {}
        for name in ('api', 'admin'):
            data, actual[name], original[name], anchors[name] = self.fixture(name)
            metadata[name] = data
        actual['mysql']['containerId'] = '6' * 64
        context = {'policy': {'preflight': {'services': original}}, 'restored': {'configurationAnchors': anchors}}
        d = controller(run=MagicMock(side_effect=[json.dumps([metadata[n]]) for n in ('api', 'admin')]))
        def probe(d, expected):
            scope.recovery_services(d, actual, context)
        with patch.object(scope, 'baseline', side_effect=probe):
            result = scope.projection_diagnostic(d, scope.BASELINE_COMMIT)
        self.assertFalse(result['baselineConfirmed'])
        self.assertEqual(result['gateCode'], 'ONLINE_RECHARGE_PRESERVED_CONTAINER_CHANGED')
        self.assertEqual(result['restoredProjectionMatch'], {'api': True, 'admin': True})
        self.assertEqual(result['restoredProjectionReason'], {'api': 'MATCH', 'admin': 'MATCH'})
        self.assertEqual(result['identityDiff']['mysql'], ['containerId'])
        self.assertEqual(set(result['identityDiff']), set(original))
        self.assertNotIn('SECRET_MUST_NOT_ESCAPE', json.dumps(result))
        self.assertFalse(d._onlineRechargeProjectionDiagnostic)
        self.assertIsNone(d._onlineRechargeIdentityDiagnostic)
        with self.assertRaisesRegex(RuntimeError, 'PRESERVED_CONTAINER_CHANGED'):
            scope.recovery_services(d, actual, context)
        self.assertEqual(d.run.call_count, 2)
        candidates = []
        for field, changed in (('identityDiff', {}), ('restoredProjectionMatch', {'api': 1, 'admin': True}),
                               ('reason', 'PUBLISHED_BUILD_PROOF'), ('rawSecret', 'secret')):
            candidates.append({**result, field: changed})
        candidate = copy.deepcopy(result); candidate['identityDiff']['api'] = ['secret']; candidates.append(candidate)
        candidate = copy.deepcopy(result); candidate['identityDiff']['api'] = ['image', 'image']; candidates.append(candidate)
        candidate = copy.deepcopy(result); candidate['identityDiff']['api'] = ['image', 'status']; candidates.append(candidate)
        candidate = copy.deepcopy(result); candidate['restoredProjectionMatch']['extra'] = True; candidates.append(candidate)
        candidate = copy.deepcopy(result); candidate.pop('restoredProjectionMatch'); candidates.append(candidate)
        for bad in ('secret', True, ['MATCH']):
            candidate = copy.deepcopy(result); candidate['restoredProjectionReason']['api'] = bad; candidates.append(candidate)
        candidate = copy.deepcopy(result); candidate['restoredProjectionReason']['api'] = 'OTHER'; candidates.append(candidate)
        candidate = copy.deepcopy(result); candidate['restoredProjectionReason']['extra'] = 'MATCH'; candidates.append(candidate)
        for candidate in candidates:
            with self.subTest(candidate_keys=sorted(candidate)), self.assertRaises(RuntimeError):
                scope.validate_diagnostic(controller(), candidate, scope.BASELINE_COMMIT)
        historical = copy.deepcopy(result); historical.pop('restoredProjectionReason'); historical.pop('apiNativeProbe')
        scope.validate_diagnostic(controller(), historical, scope.BASELINE_COMMIT)

    def test_inspect_and_unknown_projection_errors_never_expose_raw_values(self):
        original, actual = states(), states()
        metadata, anchors = {}, {}
        for name in ('api', 'admin'):
            metadata[name], actual[name], original[name], anchors[name] = self.fixture(name)
        context = {'policy': {'preflight': {'services': original}}, 'restored': {'configurationAnchors': anchors}}
        cases = [('INSPECT_FAILED', RuntimeError('SECRET_MUST_NOT_ESCAPE'), None),
                 ('INSPECT_FAILED', '[{"raw":"SECRET_MUST_NOT_ESCAPE"},{}]', None),
                 ('OTHER', None, RuntimeError('SECRET_MUST_NOT_ESCAPE')),
                 ('OTHER', None, scope.ProjectionRejection('SECRET_MUST_NOT_ESCAPE')),
                 ('OTHER', None, scope.ProjectionRejection(['MATCH'])),
                 ('OTHER', None, scope.ProjectionRejection('MATCH')), ('NOT_PROBED', None, None)]
        for expected, raw, failure in cases:
            d = controller(run=MagicMock(side_effect=raw if isinstance(raw, Exception) else None,
                return_value=raw))
            if raw is None:
                d.run.side_effect = [json.dumps([metadata[n]]) for n in ('api', 'admin')]
            selected = context if expected != 'NOT_PROBED' else {'policy': context['policy'], 'restored': {}}
            def probe(d, approved):
                scope.recovery_services(d, actual, selected)
            with self.subTest(reason=expected), patch.object(scope, 'baseline', side_effect=probe), \
                    patch.object(scope, 'restored_configuration_projection', side_effect=failure):
                result = scope.projection_diagnostic(d, scope.BASELINE_COMMIT)
            self.assertEqual(result['restoredProjectionReason'], {n: expected for n in ('api', 'admin')})
            self.assertEqual(result['restoredProjectionMatch'], {'api': False, 'admin': False})
            self.assertNotIn('SECRET_MUST_NOT_ESCAPE', json.dumps(result))
            self.assertFalse(d._onlineRechargeProjectionDiagnostic)
            self.assertIsNone(d._onlineRechargeIdentityDiagnostic)
            scope.validate_diagnostic(controller(), result, scope.BASELINE_COMMIT)

    def test_later_baseline_failure_discards_identity_details_and_clears_probe_state(self):
        d = controller()
        original = states()
        def later_failure(d, expected):
            scope.recovery_services(d, original, {'policy': {'preflight': {'services': original}}})
            self.assertIsNotNone(d._onlineRechargeIdentityDiagnostic)
            raise RuntimeError('ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED')
        with patch.object(scope, 'baseline', side_effect=later_failure):
            result = scope.projection_diagnostic(d, scope.BASELINE_COMMIT)
        self.assertEqual(result['gateCode'], 'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED')
        self.assertNotIn('identityDiff', result)
        self.assertNotIn('restoredProjectionMatch', result)
        self.assertNotIn('restoredProjectionReason', result)
        self.assertNotIn('apiNativeProbe', result)
        self.assertFalse(d._onlineRechargeProjectionDiagnostic)
        self.assertIsNone(d._onlineRechargeIdentityDiagnostic)
        scope.validate_diagnostic(controller(), result, scope.BASELINE_COMMIT)


class ApiNativeDiagnosticTests(unittest.TestCase):
    @contextmanager
    def fixture(self, changes=(0,), dependency_count=2, mount_count=2, network_count=2):
        with tempfile.TemporaryDirectory(prefix='api-native-', dir=RUNTIME) as name:
            base = Path(name); previous = base / 'releases/old'; previous.mkdir(parents=True)
            (base / 'current').symlink_to(previous)
            for filename in ('release-manifest.json', shared.PROOF_FILE, shared.STATE_FILE,
                             'backup-verification.json', 'before-audit.json', 'after-audit.json'):
                (previous / filename).write_text(json.dumps({'commit': scope.BASELINE_COMMIT}))
            for filename in ('docker-compose.aws-mysql.yml', 'deploy/caddy/Caddyfile.aws', scope.SCHEMA_FILE, 'compose.release.json'):
                path = previous / filename; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('fixture source')
            (previous / '.env.aws.production').write_text('FIXTURE=opaque\n')
            metadata, actual, original, anchors = RestoredConfigurationDiagnosticTests().fixture('api', 'slot', 'slot')
            triples = [f'dep{i}:service_healthy:false' for i in range(dependency_count)]
            metadata['Config']['Labels']['com.docker.compose.depends_on'] = ','.join(triples)
            mounts = [{'Type': 'volume', 'Source': f'fixture_v{i}', 'Target': f'/mount{i}',
                       'ReadOnly': False, 'VolumeOptions': {'NoCopy': False}} for i in range(mount_count)]
            metadata['HostConfig']['Mounts'] = mounts
            metadata['HostConfig']['NetworkMode'] = 'fixture_n0'
            metadata['NetworkSettings'] = {'Networks': {f'fixture_n{i}': {'NetworkID': str(i) * 64}
                                                        for i in range(network_count)}}
            configuration = {k: copy.deepcopy(metadata[k]) for k in ('Config', 'HostConfig', 'Mounts')}
            configuration['Mounts'].sort(key=lambda m: m['Destination'])
            actual['configurationSha256'] = scope.fingerprint(configuration)
            configuration['Config']['Hostname'] = original['containerId'][:12]
            if 0 in changes:
                configuration['Config']['Labels']['com.docker.compose.depends_on'] = ','.join(reversed(triples))
            if 1 in changes:
                configuration['HostConfig']['Mounts'].reverse()
            if 2 in changes:
                configuration['HostConfig']['NetworkMode'] = 'fixture_n1'
            original['configurationSha256'] = scope.fingerprint(configuration)
            declaration = {'name': 'fixture', 'services': {'api': {
                'depends_on': {f'dep{i}': {'condition': 'service_healthy', 'restart': False, 'required': True}
                               for i in range(dependency_count)},
                'volumes': [{'target': m['Target']} for m in mounts],
                'networks': {f'n{i}': {} for i in range(network_count)}},
                **{f'dep{i}': {} for i in range(dependency_count)}},
                'networks': {f'n{i}': {'name': f'fixture_n{i}'} for i in range(network_count)}}
            restored = {'previous': previous, 'workspaceOriginFiles': scope.workspace_files(controller(), previous),
                        'configurationAnchors': {'api': anchors}, 'configurationBefore': scope.configuration_hashes(previous),
                        'environmentSha256': scope.file_digest(previous / '.env.aws.production')}
            d = controller(BASE=base)
            with patch.object(scope, 'rendered_configuration', return_value=declaration):
                yield d, metadata, actual, original, restored, declaration

    def test_only_complete_dependency_mount_and_network_variants_can_match(self):
        for changed in ((0,), (1,), (2,), (0, 1), (0, 1, 2)):
            with self.subTest(paths=changed), self.fixture(changed) as (d, metadata, actual, original, restored, _):
                captured = copy.deepcopy((metadata, actual, original))
                result = scope.api_native_projection_probe(d, metadata, actual, original, restored)
                self.assertEqual(result, {'matched': True, 'reason': 'MATCH',
                                         'changedPaths': [scope.API_NATIVE_PATHS[i] for i in changed]})
                self.assertEqual((metadata, actual, original), captured)
        with self.fixture(()) as (d, metadata, actual, original, restored, _):
            self.assertEqual(scope.api_native_projection_probe(d, metadata, actual, original, restored)['reason'], 'ELIGIBILITY')

    def test_source_content_dependency_and_mount_binding_fail_closed_without_values(self):
        mutations = [(('Config', 'Labels', 'com.docker.compose.depends_on'), 'dep0:service_started:false,dep1:service_healthy:false'),
            (('Config', 'Labels', 'com.docker.compose.depends_on'), 'dep0:service_healthy:false,dep0:service_healthy:false'),
            (('Config', 'Labels', 'com.docker.compose.depends_on'), 'SECRET_MUST_NOT_ESCAPE'),
            (('Config', 'Labels', 'unrelated.label'), 'changed'), (('Config', 'Env'), ['SECRET_MUST_NOT_ESCAPE']),
            (('HostConfig', 'Memory'), 4096), (('HostConfig', 'Mounts'),
             [{'Type': 'volume', 'Source': 'changed', 'Target': '/mount0', 'ReadOnly': False}])]
        for path, value in mutations:
            with self.subTest(path=path), self.fixture() as (d, metadata, actual, original, restored, _):
                target = metadata
                for key in path[:-1]:
                    target = target[key]
                target[path[-1]] = value
                configuration = {k: metadata[k] for k in ('Config', 'HostConfig', 'Mounts')}
                configuration['Mounts'] = sorted(configuration['Mounts'], key=lambda m: m['Destination'])
                actual['configurationSha256'] = scope.fingerprint(configuration)
                result = scope.api_native_projection_probe(d, metadata, actual, original, restored)
                self.assertFalse(result['matched']); self.assertEqual(result['changedPaths'], [])
                self.assertNotIn('SECRET_MUST_NOT_ESCAPE', json.dumps(result))
        with self.fixture() as (d, metadata, actual, original, restored, declaration):
            declaration['name'] = 'other'
            self.assertEqual(scope.api_native_projection_probe(d, metadata, actual, original, restored)['reason'], 'DECLARATION')
        with self.fixture() as (d, metadata, actual, original, restored, _):
            (restored['previous'] / shared.PROOF_FILE).write_text('changed source')
            self.assertEqual(scope.api_native_projection_probe(d, metadata, actual, original, restored)['reason'], 'OLD_SOURCE_BEFORE_WORKSPACE_FILES')
        for filename in ('docker-compose.aws-mysql.yml', '.env.aws.production'):
            with self.subTest(source=filename), self.fixture() as (d, metadata, actual, original, restored, declaration):
                def changed_during_render(d, directory):
                    (directory / filename).write_text('SECRET_MUST_NOT_ESCAPE')
                    return declaration
                with patch.object(scope, 'rendered_configuration', side_effect=changed_during_render):
                    result = scope.api_native_projection_probe(d, metadata, actual, original, restored)
                expected = 'OLD_SOURCE_AFTER_CONFIGURATION_FILES' if filename.endswith('.yml') else 'OLD_SOURCE_AFTER_ENV_FILE'
                self.assertEqual(result['reason'], expected); self.assertNotIn('SECRET_MUST_NOT_ESCAPE', json.dumps(result))

    def test_incomplete_network_binding_never_attempts_other_network_modes(self):
        for variation in ('missing', 'extra', 'undeclared', 'explicit'):
            with self.subTest(variation=variation), self.fixture((2,)) as (d, metadata, actual, original, restored, declaration):
                if variation == 'missing':
                    metadata['NetworkSettings']['Networks'].pop('fixture_n1')
                elif variation == 'extra':
                    metadata['NetworkSettings']['Networks']['other'] = {}
                elif variation == 'undeclared':
                    declaration['networks']['n1'].pop('name')
                else:
                    declaration['services']['api']['network_mode'] = 'host'
                self.assertEqual(scope.api_native_projection_probe(d, metadata, actual, original, restored)['reason'], 'NO_MATCH')

    def test_candidate_budget_is_bounded_and_overflow_rejected_before_permutations(self):
        with self.fixture((0,), mount_count=4, network_count=4) as (d, metadata, actual, original, restored, _):
            original['configurationSha256'] = '0' * 64
            with patch.object(scope, 'fingerprint', wraps=scope.fingerprint) as hashes:
                result = scope.api_native_projection_probe(d, metadata, actual, original, restored)
            self.assertEqual(result['reason'], 'NO_MATCH'); self.assertLessEqual(hashes.call_count, 768 + 6)
        for counts, reason in (((3, 4, 4), 'COMBINATION_LIMIT'), ((2, 5, 2), 'MOUNT_COUNT_LIMIT')):
            with self.subTest(counts=counts), self.fixture((0,), *counts) as (d, metadata, actual, original, restored, _):
                with patch.object(scope.itertools, 'permutations') as permutations:
                    result = scope.api_native_projection_probe(d, metadata, actual, original, restored)
                self.assertEqual(result['reason'], reason); permutations.assert_not_called()
        with self.fixture() as (d, metadata, actual, original, restored, _), \
                patch.object(scope, 'API_NATIVE_MAX_BYTES', 1):
            result = scope.api_native_projection_probe(d, metadata, actual, original, restored)
            self.assertEqual(result, {'matched': False, 'reason': 'PAYLOAD_LIMIT', 'changedPaths': []})
            self.assertNotIn('SECRET_MUST_NOT_ESCAPE', json.dumps(result))

    def test_ambiguous_complete_objects_and_unknown_errors_do_not_match(self):
        with self.fixture() as (d, metadata, actual, original, restored, _):
            native = scope.fingerprint
            expected = 'dep1:service_healthy:false,dep0:service_healthy:false'
            def collide(value):
                if isinstance(value, dict) and value.get('Config', {}).get('Labels', {}).get('com.docker.compose.depends_on') == expected:
                    return original['configurationSha256']
                return native(value)
            with patch.object(scope, 'fingerprint', side_effect=collide):
                self.assertEqual(scope.api_native_projection_probe(d, metadata, actual, original, restored)['reason'], 'AMBIGUOUS')
            with patch.object(scope, 'rendered_configuration', side_effect=RuntimeError('SECRET_MUST_NOT_ESCAPE')):
                result = scope.api_native_projection_probe(d, metadata, actual, original, restored)
            self.assertEqual(result, {'matched': False, 'reason': 'PROBE_FAILED', 'changedPaths': []})

    def test_old_source_before_after_and_nested_require_stages_are_closed(self):
        for filename, suffix in ((shared.PROOF_FILE, 'WORKSPACE_FILES'),
                                 ('docker-compose.aws-mysql.yml', 'CONFIGURATION_FILES'),
                                 ('.env.aws.production', 'ENV_FILE')):
            for phase in ('BEFORE', 'AFTER'):
                with self.subTest(file=filename, phase=phase), self.fixture() as (d, metadata, actual, original, restored, declaration):
                    def changed(d, previous):
                        (previous / filename).write_text('SECRET_MUST_NOT_ESCAPE')
                        return declaration
                    if phase == 'BEFORE':
                        changed(d, restored['previous'])
                    with patch.object(scope, 'rendered_configuration', side_effect=changed if phase == 'AFTER' else None,
                                      return_value=declaration):
                        result = scope.api_native_projection_probe(d, metadata, actual, original, restored)
                    self.assertEqual(result, {'matched': False, 'reason': f'OLD_SOURCE_{phase}_{suffix}', 'changedPaths': []})
                    self.assertNotIn('SECRET_MUST_NOT_ESCAPE', json.dumps(result))
        with self.fixture() as (d, metadata, actual, original, restored, _):
            (d.BASE / 'current').unlink()
            self.assertEqual(scope.api_native_projection_probe(d, metadata, actual, original, restored)['reason'],
                             'OLD_SOURCE_BEFORE_PATH_CURRENT')
        with self.fixture() as (d, metadata, actual, original, restored, _):
            (restored['previous'] / shared.PROOF_FILE).unlink()
            self.assertEqual(scope.api_native_projection_probe(d, metadata, actual, original, restored)['reason'],
                             'OLD_SOURCE_BEFORE_WORKSPACE_FILES')
            self.assertIs(d.require, require)
        with self.fixture() as (d, metadata, actual, original, restored, _):
            def invalid_render(d, unused):
                d.require(False, 'SECRET_MUST_NOT_ESCAPE')
            with patch.object(scope, 'rendered_configuration', side_effect=invalid_render):
                result = scope.api_native_projection_probe(d, metadata, actual, original, restored)
            self.assertEqual(result, {'matched': False, 'reason': 'DECLARATION_RENDER', 'changedPaths': []})

    def test_each_dependency_mount_and_network_predicate_has_a_literal_stage(self):
        cases = [
            ('declaration', ('services', 'api', 'depends_on'), None, 'DEPENDENCY_DECLARATION_TYPE'),
            ('declaration', ('services', 'api', 'depends_on'), {str(i): {} for i in range(5)}, 'DEPENDENCY_COUNT_LIMIT'),
            ('declaration', ('services', 'api', 'depends_on'), {'bad name': {}}, 'DEPENDENCY_NAME'),
            ('declaration', ('services', 'api', 'depends_on'), {'missing': {}}, 'DEPENDENCY_SERVICE'),
            ('declaration', ('services', 'api', 'depends_on', 'dep0'), None, 'DEPENDENCY_ROW_TYPE'),
            ('declaration', ('services', 'api', 'depends_on', 'dep0', 'condition'), 'secret', 'DEPENDENCY_CONDITION'),
            ('declaration', ('services', 'api', 'depends_on', 'dep0', 'restart'), 'false', 'DEPENDENCY_RESTART'),
            ('metadata', ('Config', 'Labels', 'com.docker.compose.depends_on'), None, 'DEPENDENCY_LABEL_TYPE'),
            ('metadata', ('Config', 'Labels', 'com.docker.compose.depends_on'), 'X' * 2049, 'DEPENDENCY_LABEL_SIZE'),
            ('metadata', ('Config', 'Labels', 'com.docker.compose.depends_on'), 'SECRET_MUST_NOT_ESCAPE', 'DEPENDENCY_LABEL_CONTENT'),
            ('metadata', ('HostConfig', 'Mounts'), None, 'MOUNT_BIND_DECLARATION'),
            ('metadata', ('HostConfig', 'Mounts'), [{}] * 5, 'MOUNT_COUNT_LIMIT'),
            ('metadata', ('HostConfig', 'Mounts'), [{'Target': 'secret'}], 'MOUNT_ROW_TARGET'),
            ('metadata', ('HostConfig', 'Mounts'), [{'Target': '/same'}] * 2, 'MOUNT_DUPLICATE_TARGET'),
            ('declaration', ('services', 'api', 'volumes'), [None], 'MOUNT_DECLARED_VOLUMES'),
            ('declaration', ('services', 'api', 'volumes'), [{'target': '/other'}], 'MOUNT_TARGET_SET_MISMATCH'),
            ('metadata', ('HostConfig', 'NetworkMode'), None, 'NETWORK_INPUT_TYPE'),
            ('metadata', ('HostConfig', 'NetworkMode'), 'X' * 257, 'NETWORK_INPUT_SIZE'),
        ]
        for target, path, value, reason in cases:
            with self.subTest(reason=reason), self.fixture() as (d, metadata, actual, original, restored, declaration):
                item = metadata if target == 'metadata' else declaration
                for key in path[:-1]:
                    item = item[key]
                if reason == 'DEPENDENCY_LABEL_TYPE':
                    item.pop(path[-1])
                else:
                    item[path[-1]] = value
                raw = {k: metadata[k] for k in ('Config', 'HostConfig', 'Mounts')}
                raw['Mounts'] = sorted(raw['Mounts'], key=lambda m: m['Destination'])
                actual['configurationSha256'] = scope.fingerprint(raw)
                result = scope.api_native_projection_probe(d, metadata, actual, original, restored)
                self.assertEqual(result, {'matched': False, 'reason': reason, 'changedPaths': []})
                self.assertNotIn('SECRET_MUST_NOT_ESCAPE', json.dumps(result))

    def test_unknown_exception_and_forged_reason_cannot_claim_match_or_stage(self):
        class SecretException(RuntimeError):
            def __str__(self):
                raise AssertionError('exception text must never be read')
        class ForgedRejection(scope.ApiNativeProbeRejection):
            def __getattribute__(self, name):
                if name == '__dict__':
                    raise AssertionError('forged exception fields must never be read')
                return super().__getattribute__(name)
        class ForgedReason(str):
            def __hash__(self):
                raise AssertionError('forged reason must never be hashed')
        for error in (SecretException('SECRET_MUST_NOT_ESCAPE'), ForgedRejection('DECLARATION_RENDER'),
                      scope.ApiNativeProbeRejection(ForgedReason('DECLARATION_RENDER')),
                      *(scope.ApiNativeProbeRejection(v) for v in
                        ('MATCH', 'NO_MATCH', 'PROBE_FAILED', 'secret', None, [], 'PAYLOAD_LIMIT'))):
            with self.subTest(type=type(error).__name__), self.fixture() as (d, metadata, actual, original, restored, _):
                with patch.object(scope, 'rendered_configuration', side_effect=error), io.StringIO() as output, redirect_stdout(output):
                    result = scope.api_native_projection_probe(d, metadata, actual, original, restored)
                    self.assertEqual(output.getvalue(), '')
                self.assertEqual(result, {'matched': False, 'reason': 'PROBE_FAILED', 'changedPaths': []})
                self.assertIs(d.require, require)
                self.assertNotIn('SECRET_MUST_NOT_ESCAPE', json.dumps(result))

    def test_classified_probe_failure_keeps_formal_rejection_and_resets_flags(self):
        with self.fixture() as (d, metadata, actual, original, restored, _):
            metadata['HostConfig']['Mounts'] = None
            raw = {k: metadata[k] for k in ('Config', 'HostConfig', 'Mounts')}
            raw['Mounts'] = sorted(raw['Mounts'], key=lambda m: m['Destination'])
            actual['configurationSha256'] = scope.fingerprint(raw)
            admin_metadata, admin_actual, admin_original, admin_anchors = RestoredConfigurationDiagnosticTests().fixture('admin', 'slot', 'slot')
            restored['configurationAnchors']['admin'] = admin_anchors
            before, live = states(), states()
            before.update(api=original, admin=admin_original); live.update(api=actual, admin=admin_actual)
            context = {'policy': {'preflight': {'services': before}}, 'restored': restored}
            d.run = MagicMock(side_effect=[json.dumps([metadata]), json.dumps([admin_metadata])])
            with patch.object(scope, 'baseline', side_effect=lambda d, expected: scope.recovery_services(d, live, context)):
                result = scope.projection_diagnostic(d, scope.BASELINE_COMMIT)
            self.assertEqual(result['apiNativeProbe'], {'matched': False, 'reason': 'MOUNT_BIND_DECLARATION', 'changedPaths': []})
            self.assertEqual(result['restoredProjectionReason']['api'], 'PROJECTED_HASH_MISMATCH')
            self.assertEqual(result['gateCode'], 'ONLINE_RECHARGE_PRESERVED_CONTAINER_CHANGED')
            self.assertFalse(result['baselineConfirmed']); self.assertFalse(result['restoredProjectionMatch']['api'])
            self.assertFalse(d._onlineRechargeProjectionDiagnostic); self.assertIsNone(d._onlineRechargeIdentityDiagnostic)

    def test_probe_match_does_not_change_original_failure_and_closed_transport_validation(self):
        with self.fixture() as (d, metadata, actual, original, restored, _):
            admin_metadata, admin_actual, admin_original, admin_anchors = RestoredConfigurationDiagnosticTests().fixture('admin', 'slot', 'slot')
            restored['configurationAnchors']['admin'] = admin_anchors
            before, live = states(), states()
            before.update(api=original, admin=admin_original); live.update(api=actual, admin=admin_actual)
            context = {'policy': {'preflight': {'services': before}}, 'restored': restored}
            d.run = MagicMock(side_effect=[json.dumps([metadata]), json.dumps([admin_metadata])])
            def baseline(d, approved):
                scope.recovery_services(d, live, context)
            with patch.object(scope, 'baseline', side_effect=baseline):
                result = scope.projection_diagnostic(d, scope.BASELINE_COMMIT)
            self.assertFalse(result['baselineConfirmed']); self.assertFalse(result['restoredProjectionMatch']['api'])
            self.assertEqual(result['restoredProjectionReason']['api'], 'PROJECTED_HASH_MISMATCH')
            self.assertTrue(result['apiNativeProbe']['matched'])
            self.assertNotIn('SECRET_MUST_NOT_ESCAPE', json.dumps(result))
            self.assertFalse(d._onlineRechargeProjectionDiagnostic); self.assertIsNone(d._onlineRechargeIdentityDiagnostic)
            scope.validate_diagnostic(d, result, scope.BASELINE_COMMIT)
            for reason in scope.API_NATIVE_FAILURE_REASONS | {'PROBE_FAILED', 'NO_MATCH', 'AMBIGUOUS'}:
                candidate = copy.deepcopy(result)
                candidate['apiNativeProbe'] = {'matched': False, 'reason': reason, 'changedPaths': []}
                scope.validate_diagnostic(d, candidate, scope.BASELINE_COMMIT)
            for key, value in (('reason', 'secret'), ('matched', 1), ('changedPaths', ['Env']),
                               ('changedPaths', list(reversed(scope.API_NATIVE_PATHS))), ('extra', 'secret')):
                candidate = copy.deepcopy(result); candidate['apiNativeProbe'][key] = value
                with self.subTest(key=key), self.assertRaises(RuntimeError):
                    scope.validate_diagnostic(d, candidate, scope.BASELINE_COMMIT)
            for removed in ('apiNativeProbe', 'restoredProjectionReason'):
                result.pop(removed)
                scope.validate_diagnostic(d, result, scope.BASELINE_COMMIT)

    @contextmanager
    def bind_fixture(self, shape, old_empty=False):
        with self.fixture(mount_count=1) as (d, metadata, actual, original, restored, declaration):
            declaration['services']['api']['volumes'] = [{'type': 'volume', 'source': shared.WORKSPACE_VOLUME,
                'target': shared.WORKSPACE_DIRECTORY, 'volume': {}}]
            name = 'fixture_' + shared.WORKSPACE_VOLUME
            declaration['volumes'] = {shared.WORKSPACE_VOLUME: {'name': name}}
            metadata['Mounts'] = [{'Type': 'volume', 'Name': name, 'Source': '/var/lib/docker/volumes/' + name + '/_data',
                'Destination': shared.WORKSPACE_DIRECTORY, 'Driver': 'local', 'Mode': 'rw', 'RW': True, 'Propagation': ''}]
            metadata['HostConfig']['Binds'] = [name + ':' + shared.WORKSPACE_DIRECTORY + ':rw']
            if shape == 'missing':
                metadata['HostConfig'].pop('Mounts')
            else:
                metadata['HostConfig']['Mounts'] = None if shape == 'null' else []
            metadata['Config']['Labels']['com.docker.compose.depends_on'] = ''
            raw = {k: copy.deepcopy(metadata[k]) for k in ('Config', 'HostConfig', 'Mounts')}
            actual['configurationSha256'] = scope.fingerprint(raw)
            raw['Config']['Hostname'] = original['containerId'][:12]
            if old_empty:
                raw['HostConfig']['NetworkMode'] = 'fixture_n1'
            else:
                raw['Config']['Labels']['com.docker.compose.depends_on'] = 'dep1:service_healthy:false,dep0:service_healthy:false'
            original['configurationSha256'] = scope.fingerprint(raw)
            yield d, metadata, actual, original, restored, declaration

    def test_exact_empty_label_adds_only_complete_declaration_and_empty_candidates(self):
        with self.fixture() as (d, metadata, actual, original, restored, _):
            metadata['Config']['Labels']['com.docker.compose.depends_on'] = ''
            raw = {k: metadata[k] for k in ('Config', 'HostConfig', 'Mounts')}
            raw['Mounts'] = sorted(raw['Mounts'], key=lambda m: m['Destination'])
            actual['configurationSha256'] = scope.fingerprint(raw)
            result = scope.api_native_projection_probe(d, metadata, actual, original, restored)
            self.assertEqual(result, {'matched': True, 'reason': 'MATCH', 'changedPaths': [scope.API_NATIVE_PATHS[0]]})
        for label in (' ', 'dep0:service_healthy:false', 'dep0:service_started:false,dep1:service_healthy:false',
                      'dep0:service_healthy:true,dep1:service_healthy:false',
                      'dep0:service_healthy:false,dep0:service_healthy:false', 'SECRET_MUST_NOT_ESCAPE'):
            with self.subTest(label=label), self.fixture() as (d, metadata, actual, original, restored, _):
                metadata['Config']['Labels']['com.docker.compose.depends_on'] = label
                raw = {k: metadata[k] for k in ('Config', 'HostConfig', 'Mounts')}
                raw['Mounts'] = sorted(raw['Mounts'], key=lambda m: m['Destination'])
                actual['configurationSha256'] = scope.fingerprint(raw)
                result = scope.api_native_projection_probe(d, metadata, actual, original, restored)
                self.assertEqual(result, {'matched': False, 'reason': 'DEPENDENCY_LABEL_CONTENT', 'changedPaths': []})
                self.assertNotIn('SECRET_MUST_NOT_ESCAPE', json.dumps(result))

    def test_plain_binds_keep_missing_null_empty_complete_host_shape(self):
        for shape in ('missing', 'null', 'empty'):
            for old_empty in (False, True):
                with self.subTest(shape=shape, old_empty=old_empty), self.bind_fixture(shape, old_empty) as (d, metadata, actual, original, restored, _):
                    before = copy.deepcopy(metadata)
                    result = scope.api_native_projection_probe(d, metadata, actual, original, restored)
                    self.assertEqual(result, {'matched': True, 'reason': 'MATCH',
                        'changedPaths': [scope.API_NATIVE_PATHS[2 if old_empty else 0]]})
                    self.assertEqual(metadata, before)
                    self.assertEqual('Mounts' in metadata['HostConfig'], shape != 'missing')
            with self.bind_fixture(shape) as (d, metadata, actual, original, restored, _):
                raw = {k: copy.deepcopy(metadata[k]) for k in ('Config', 'HostConfig', 'Mounts')}
                raw['Config']['Hostname'] = original['containerId'][:12]
                raw['Config']['Labels']['com.docker.compose.depends_on'] = 'dep1:service_healthy:false,dep0:service_healthy:false'
                raw['HostConfig']['Mounts'] = None if shape == 'empty' else []
                original['configurationSha256'] = scope.fingerprint(raw)
                self.assertEqual(scope.api_native_projection_probe(d, metadata, actual, original, restored)['reason'], 'NO_MATCH')

    def test_plain_bind_requires_exact_declaration_top_mount_and_one_host_bind(self):
        cases = [
            ('declaration', ('services', 'api', 'volumes', 0, 'source'), 'external', 'MOUNT_BIND_DECLARATION'),
            ('declaration', ('services', 'api', 'volumes', 0, 'target'), '/other', 'MOUNT_BIND_DECLARATION'),
            ('declaration', ('services', 'api', 'volumes', 0, 'read_only'), True, 'MOUNT_BIND_DECLARATION'),
            ('declaration', ('services', 'api', 'volumes', 0, 'volume'), {'nocopy': False}, 'MOUNT_BIND_DECLARATION'),
            ('declaration', ('services', 'api', 'volumes', 0, 'unknown'), 'secret', 'MOUNT_BIND_DECLARATION'),
            ('declaration', ('volumes', shared.WORKSPACE_VOLUME), {'name': 'external'}, 'MOUNT_BIND_NAME'),
            ('metadata', ('Mounts', 0, 'Type'), 'bind', 'MOUNT_BIND_INSPECT'),
            ('metadata', ('Mounts', 0, 'Name'), 'external', 'MOUNT_BIND_INSPECT'),
            ('metadata', ('Mounts', 0, 'Destination'), '/other', 'MOUNT_BIND_INSPECT'),
            ('metadata', ('Mounts', 0, 'Mode'), 'ro', 'MOUNT_BIND_INSPECT'),
            ('metadata', ('Mounts', 0, 'RW'), False, 'MOUNT_BIND_INSPECT'),
            ('metadata', ('Mounts', 0, 'Driver'), 'external', 'MOUNT_BIND_INSPECT'),
            ('metadata', ('Mounts', 0, 'unknown'), 'secret', 'MOUNT_BIND_INSPECT'),
            ('metadata', ('HostConfig', 'Binds'), [], 'MOUNT_BIND_HOST'),
            ('metadata', ('HostConfig', 'Binds'), ['SECRET_MUST_NOT_ESCAPE'], 'MOUNT_BIND_HOST'),
        ]
        for target, path, value, reason in cases:
            with self.subTest(reason=reason, path=path), self.bind_fixture('null') as (d, metadata, actual, original, restored, declaration):
                item = declaration if target == 'declaration' else metadata
                for key in path[:-1]:
                    item = item[key]
                item[path[-1]] = value
                actual['configurationSha256'] = scope.fingerprint({k: metadata[k] for k in ('Config', 'HostConfig', 'Mounts')})
                result = scope.api_native_projection_probe(d, metadata, actual, original, restored)
                self.assertEqual(result, {'matched': False, 'reason': reason, 'changedPaths': []})
                self.assertNotIn('SECRET_MUST_NOT_ESCAPE', json.dumps(result))
        with self.bind_fixture('null') as (d, metadata, actual, original, restored, _):
            metadata['HostConfig']['Binds'] *= 2
            actual['configurationSha256'] = scope.fingerprint({k: metadata[k] for k in ('Config', 'HostConfig', 'Mounts')})
            self.assertEqual(scope.api_native_projection_probe(d, metadata, actual, original, restored)['reason'], 'MOUNT_BIND_HOST')
        with self.fixture() as (d, metadata, actual, original, restored, _):
            metadata['HostConfig']['Binds'] = ['SECRET_MUST_NOT_ESCAPE']
            raw = {k: metadata[k] for k in ('Config', 'HostConfig', 'Mounts')}
            raw['Mounts'] = sorted(raw['Mounts'], key=lambda m: m['Destination'])
            actual['configurationSha256'] = scope.fingerprint(raw)
            self.assertEqual(scope.api_native_projection_probe(d, metadata, actual, original, restored)['reason'], 'MOUNT_BIND_MIXED')

    def test_empty_label_keeps_source_anchor_and_both_candidate_budgets(self):
        with self.bind_fixture('null') as (d, metadata, actual, original, restored, declaration):
            (restored['previous'] / 'docker-compose.aws-mysql.yml').write_text('changed dependency condition')
            declaration['services']['api']['depends_on']['dep0']['condition'] = 'service_started'
            self.assertEqual(scope.api_native_projection_probe(d, metadata, actual, original, restored)['reason'],
                             'OLD_SOURCE_BEFORE_CONFIGURATION_FILES')
        with self.fixture(mount_count=4, network_count=4) as (d, metadata, actual, original, restored, _):
            metadata['Config']['Labels']['com.docker.compose.depends_on'] = ''
            raw = {k: metadata[k] for k in ('Config', 'HostConfig', 'Mounts')}
            raw['Mounts'] = sorted(raw['Mounts'], key=lambda m: m['Destination'])
            actual['configurationSha256'] = scope.fingerprint(raw)
            with patch.object(scope.itertools, 'permutations') as permutations:
                self.assertEqual(scope.api_native_projection_probe(d, metadata, actual, original, restored)['reason'], 'COMBINATION_LIMIT')
                permutations.assert_not_called()
        with self.bind_fixture('null') as (d, metadata, actual, original, restored, _), patch.object(scope, 'API_NATIVE_MAX_BYTES', 1):
            self.assertEqual(scope.api_native_projection_probe(d, metadata, actual, original, restored)['reason'], 'PAYLOAD_LIMIT')


class ProofTests(unittest.TestCase):
    def test_build_proof_rejects_tracked_or_untracked_wip_before_any_image_or_source_read(self):
        for status in (' M apps/api/src/example.ts', '?? apps/api/src/id-business-v2/online-recharge/engine/worker.cjs'):
            d = controller(run=MagicMock(side_effect=[COMMIT, TREE, status]))
            with self.subTest(status=status), patch.dict(os.environ, {'RELEASE_COMMIT': COMMIT, 'SOURCE_TREE': TREE}), self.assertRaisesRegex(RuntimeError, 'WORKTREE_DIRTY'):
                scope.build_proof(d)
            self.assertEqual(d.run.call_count, 3)

    def test_exact_four_images_and_source_build_attempt(self):
        scope.validate_proof(controller(), proof(), COMMIT, TREE, REPOSITORY, '123', '1')
        cases = []
        for field, value in (('baselineCommit', COMMIT), ('scope', 'API_ADMIN'), ('commit', scope.BASELINE_COMMIT), ('sourceTree', COMMIT)):
            row = proof(); row[field] = value; cases.append(row)
        row = proof(); row['images']['auto-registration'] = row['images']['api']; cases.append(row)
        row = proof(); row['migration']['sha256'] = '0' * 64; cases.append(row)
        for row in cases:
            with self.subTest(), self.assertRaises(RuntimeError):
                scope.validate_proof(controller(), row, COMMIT, TREE)
        with self.assertRaisesRegex(RuntimeError, 'BUILD_RUN_CHANGED'):
            scope.validate_proof(controller(), proof(), COMMIT, TREE, REPOSITORY, '123', '2')

    def test_engine_content_is_source_only_and_rejects_other_paths(self):
        valid = 'a' * 64 + '  ./worker.cjs'
        self.assertEqual(scope.content_summary(controller(), 'online-recharge', valid)['fileCount'], 1)
        for value in ('', 'a' * 64 + '  /etc/passwd', 'a' * 64 + '  ./../secret',
                      'a' * 64 + '  ./runtime/secret', valid + '\n' + valid):
            with self.subTest(value=value[:90]), self.assertRaises(RuntimeError):
                scope.content_summary(controller(), 'online-recharge', value)

    def test_inspection_never_starts_engine_entrypoint_and_has_no_network(self):
        candidate = proof(); row = candidate['images']['online-recharge']
        content = 'a' * 64 + '  ./worker.cjs'
        row.update(scope.content_summary(controller(), 'online-recharge', content))
        metadata = [{'Id': row['imageId'], 'Architecture': 'amd64', 'Config': {'Labels': {
            'org.opencontainers.image.revision': COMMIT, 'id-business-v2.source-tree': TREE}}}]
        d = controller(run=MagicMock(side_effect=[json.dumps(metadata), content]))
        with patch.object(scope, 'engine_content', return_value={n: row[n] for n in ('fileCount', 'sha256')}):
            scope.verify_image_content(d, ROOT, candidate, 'online-recharge')
        command = d.run.call_args.args
        self.assertIn('--network', command); self.assertIn('none', command)
        self.assertIn('--read-only', command); self.assertIn('--entrypoint', command)
        self.assertIn('/bin/sh', command)
        self.assertNotIn('node worker.cjs', ' '.join(command))

    def test_selection_refuses_old_scope_and_arbitrary_baseline(self):
        args = SimpleNamespace(online_recharge_only=True, commit=COMMIT, source_tree=TREE,
            expected_current=scope.BASELINE_COMMIT, repository=REPOSITORY, run_id='123', run_attempt='1', ci_run_id='234',
            online_recharge_build_proof=base64.b64encode(json.dumps(proof()).encode()).decode())
        scope.validate_arguments(controller(), args)
        for key, value in (('api_registration_only', True), ('api_workspace_only', True), ('historical_mailbox', True), ('expected_current', COMMIT)):
            test = copy.copy(args); setattr(test, key, value)
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                scope.validate_arguments(controller(), test)


class EnvironmentTests(unittest.TestCase):
    def test_only_new_keys_added_and_existing_env_bytes_and_independent_key_preserved(self):
        with directories() as (old, new):
            raw = b'APP_PUBLIC_URL=https://fixture.invalid\nAUTO_RECHARGE_WORKER_TOKEN=synthetic-old-key\n'
            (old / '.env.aws.production').write_bytes(raw)
            d = controller(environment_values=env_values)
            scope.extend_environment(d, old, new)
            self.assertEqual((old / '.env.aws.production').read_bytes(), raw)
            value = env_values(new / '.env.aws.production')
            self.assertEqual(value['ONLINE_RECHARGE_ENGINE_ENABLED'], '1')
            self.assertNotEqual(value['ONLINE_RECHARGE_WORKER_KEY'], value['AUTO_RECHARGE_WORKER_TOKEN'])
            receipt = scope.verify_environment(d, old, new, raw)
            self.assertNotIn(value['ONLINE_RECHARGE_WORKER_KEY'], json.dumps(receipt))
            for name in ('APP_PUBLIC_URL', 'ONLINE_RECHARGE_RPC_URL'):
                actual = (new / '.env.aws.production').read_text()
                (new / '.env.aws.production').write_text(actual + name + '=http://evil.invalid\n')
                with self.subTest(name=name), self.assertRaises(RuntimeError):
                    scope.verify_environment(d, old, new, raw)
                (new / '.env.aws.production').write_text(actual)

    def test_existing_new_key_never_rotated_or_overridden(self):
        with directories() as (old, new):
            (old / '.env.aws.production').write_text('ONLINE_RECHARGE_WORKER_KEY=synthetic\n')
            with self.assertRaisesRegex(RuntimeError, 'ENV_ALREADY_PRESENT'):
                scope.extend_environment(controller(environment_values=env_values), old, new)
            self.assertFalse((new / '.env.aws.production').exists())


def configurations():
    old = {'name': 'id-business-v2-prod', 'services': {n: {'image': 'old-' + n, 'pull_policy': 'never'}
        for n in (*scope.PRESERVED, 'api', 'admin', 'migrate')}, 'volumes': {'mysql_data': {'name': 'prod_mysql_data'}},
        'networks': {'default': {'name': 'prod_default'}}}
    old['services']['api']['environment'] = {'DATABASE_URL': 'synthetic-db-url', 'AUTO_RECHARGE_WORKER_TOKEN': 'synthetic'}
    new = copy.deepcopy(old)
    for n in ('api', 'admin', 'migrate'):
        new['services'][n]['image'] = 'new-' + n
    new['volumes'][scope.MEDIA_VOLUME] = {'name': 'prod_' + scope.MEDIA_VOLUME}
    mount = lambda path: {'type': 'volume', 'source': scope.MEDIA_VOLUME, 'target': path, 'volume': {}}
    new['services']['api']['environment'].update({'ONLINE_RECHARGE_WORKER_KEY': 'a' * 43,
        'ONLINE_RECHARGE_CREDENTIALS_URL': scope.ENV_DEFAULTS['ONLINE_RECHARGE_CREDENTIALS_URL'],
        'ONLINE_RECHARGE_ARTIFACT_DIR': scope.API_MEDIA_PATH})
    new['services']['api']['volumes'] = [mount(scope.API_VOLUME_PATH)]
    env = {k: v for k, v in scope.ENV_DEFAULTS.items() if k != 'ONLINE_RECHARGE_ARTIFACT_DIR'}
    new['services']['online-recharge'] = {'image': 'engine', 'network_mode': 'service:api', 'read_only': True,
        'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'], 'volumes': [mount(scope.ENGINE_VOLUME_PATH)],
        'environment': {**env, 'NODE_ENV': 'production', 'ONLINE_RECHARGE_WORKER_KEY': 'a' * 43}}
    return old, new


class WorkspaceTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory(prefix='workspace-', dir=RUNTIME)
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        directory, volume = base / 'releases/old', base / 'workspace-volume'
        directory.mkdir(parents=True); volume.mkdir()
        (base / 'current').symlink_to(directory)
        (directory / '.env.aws.production').write_text(
            'MYSQL_BACKUP_S3_BUCKET=fixture-backups\nMYSQL_BACKUP_S3_PREFIX=mysql/daily\n')
        connection = sqlite3.connect(volume / 'database.db')
        self.addCleanup(connection.close)
        connection.execute('PRAGMA journal_mode=WAL')
        connection.execute('CREATE TABLE registration_tasks(id INTEGER PRIMARY KEY, status TEXT, payload TEXT)')
        connection.execute("INSERT INTO registration_tasks VALUES(1,'completed','SYNTHETIC_PRIVATE_FIXTURE')")
        connection.commit()
        metadata = {'Name': 'prod_auto_registration_data', 'Driver': 'local', 'Scope': 'local',
                    'Options': None, 'Mountpoint': str(volume), 'CreatedAt': '2026-10-09T00:00:00Z',
                    'Labels': {'com.docker.compose.project': 'prod', 'com.docker.compose.volume': 'auto_registration_data'}}
        api = {'Config': {'Labels': {'com.docker.compose.project': 'prod'}},
               'Mounts': [{'Destination': shared.WORKSPACE_DIRECTORY, 'Name': metadata['Name'],
                           'Type': 'volume', 'RW': True}]}
        uploaded, calls = {}, []
        def run(*args, **kwargs):
            calls.append(args)
            if args[:3] == ('docker', 'volume', 'ls'):
                return metadata['Name']
            if args[:3] == ('docker', 'volume', 'inspect'):
                return json.dumps([metadata])
            if args[:2] == ('docker', 'inspect'):
                return json.dumps([api])
            if args[:3] == ('aws', 's3api', 'put-object'):
                body = Path(args[args.index('--body') + 1])
                uploaded.update(ContentLength=body.stat().st_size,
                    ChecksumSHA256=base64.b64encode(bytes.fromhex(scope.file_digest(body))).decode(),
                    ServerSideEncryption=args[args.index('--server-side-encryption') + 1])
                return '{}'
            if args[:3] == ('aws', 's3api', 'head-object'):
                return json.dumps(uploaded)
            raise AssertionError('Unexpected local fixture tool selection')
        d = controller(BASE=base, service_state=MagicMock(return_value={'containerId': 'fixture-api'}),
                       run=run, environment_values=env_values)
        identity = scope.workspace_guard(d, directory)
        return d, directory, volume, identity, connection, metadata, api, uploaded, calls

    def test_nonempty_published_workspace_is_required_and_empty_gate_never_used(self):
        d, directory, _, identity, _, _, _, _, _ = self.fixture()
        evidence = {'workspaceVolume': identity, 'apiSource': {'kind': 'API_WORKSPACE_BUILD_PROVEN'}}
        manifest = {'apiWorkspacePublication': {'scope': 'API_ADMIN_WORKSPACE'}}
        receipt = {'status': 'API_ADMIN_WORKSPACE_VERIFIED', 'services': states(), 'volumePreserved': True,
                   'volumeDeletionPerformed': False, 'registrationHealthChecked': True, 'buildProofSha256': '1' * 64}
        with patch.object(shared, 'baseline', return_value=(directory, manifest, states(), evidence)) as reader, \
                patch.object(shared, 'readback', return_value=receipt), patch.object(scope, 'workspace_files', return_value={}), \
                patch.object(scope, 'release_recovery', return_value=None), patch.object(scope, 'workspace_origin') as origin, \
                patch.object(shared, 'jobs_idle', return_value={}), patch.object(scope, 'snapshot', return_value=states()), \
                patch.object(scope.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * 1024**3)):
            result = scope.baseline(d, scope.BASELINE_COMMIT)
            self.assertTrue(result[3]['workspaceIdle'])
            origin.assert_called_once_with(d, directory, directory, result[3], states())
            reader.assert_called_once_with(d, scope.BASELINE_COMMIT, check_jobs=False)
            manifest.clear()
            with self.assertRaisesRegex(RuntimeError, 'NOT_PUBLISHED'):
                scope.baseline(d, scope.BASELINE_COMMIT)
            with self.assertRaisesRegex(RuntimeError, 'BASELINE_NOT_APPROVED'):
                scope.baseline(d, '554eaff77d67cce4b760d24a5c358ccabf2b3a4c')

    def test_real_wal_online_backup_s3_integrity_and_receipt_readback(self):
        d, directory, volume, identity, _, _, _, _, calls = self.fixture()
        self.assertTrue((volume / 'database.db-wal').exists())
        receipt = scope.workspace_backup(d, directory, identity, COMMIT, '20261009T120000Z')
        self.assertTrue(receipt['onlineBackup']); self.assertTrue(receipt['s3Verified'])
        path = d.BASE / 'backups/registration-workspace' / receipt['name']
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        copied = d.BASE / 'copied.sqlite3'
        with gzip.open(path, 'rb') as stream:
            copied.write_bytes(stream.read())
        with sqlite3.connect(copied) as connection:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM registration_tasks').fetchone(), (1,))
            self.assertEqual(connection.execute('PRAGMA integrity_check').fetchone(), ('ok',))
        copied.unlink()
        (directory / scope.WORKSPACE_BACKUP_FILE).write_text(json.dumps(receipt))
        manifest = {'commit': COMMIT, 'workspaceBackupBeforeRelease': receipt['name'], 'workspaceBackupSha256': scope.fingerprint(receipt)}
        record = {'workspaceBackupSha256': scope.fingerprint(receipt)}
        result = scope.workspace_backup_receipt(d, directory, directory, {'workspaceVolume': identity}, manifest, record)
        self.assertEqual(result, receipt)
        uploads = [args for args in calls if args[:3] == ('aws', 's3api', 'put-object')]
        self.assertEqual(len(uploads), 1)
        self.assertEqual(uploads[0][uploads[0].index('--key') + 1], 'mysql/daily/' + receipt['name'])
        self.assertNotIn('SYNTHETIC_PRIVATE_FIXTURE', json.dumps(receipt))
        self.assertTrue((volume / 'database.db').is_file())
        self.assertFalse(any('empty' in str(args) or 'rm' in args for args in calls))

    def test_active_workspace_blocks_backup_and_rollback_before_any_service_stop(self):
        d, directory, _, identity, connection, _, _, _, calls = self.fixture()
        connection.execute("UPDATE registration_tasks SET status='running'"); connection.commit()
        with self.assertRaisesRegex(RuntimeError, 'TASK_ACTIVE'):
            scope.workspace_backup(d, directory, identity, COMMIT, '20261009T120000Z')
        self.assertFalse(any(args[:3] == ('aws', 's3api', 'put-object') for args in calls))
        d.compose = MagicMock(); d.rollback_service = MagicMock()
        with patch.object(shared, 'jobs_idle', return_value={}):
            okay, result = scope.rollback(d, directory, directory, ['admin', 'api', 'online-recharge'], states(), migrated=False)
        self.assertFalse(okay); self.assertEqual(result, {'online-recharge': 'BLOCKED_OR_FAILED'})
        d.compose.assert_not_called(); d.rollback_service.assert_not_called()

    def test_identity_attachment_and_symlinks_cannot_be_substituted(self):
        d, directory, volume, identity, _, metadata, api, _, _ = self.fixture()
        metadata['CreatedAt'] = 'changed'
        with self.assertRaisesRegex(RuntimeError, 'VOLUME_CHANGED'):
            scope.workspace_guard(d, directory, identity)
        metadata['CreatedAt'] = '2026-10-09T00:00:00Z'
        api['Mounts'][0]['RW'] = False
        with self.assertRaisesRegex(RuntimeError, 'MOUNT_CHANGED'):
            scope.workspace_guard(d, directory, identity)
        api['Mounts'][0]['RW'] = True
        (volume / 'database.db-journal').symlink_to(volume / 'database.db')
        with self.assertRaisesRegex(RuntimeError, 'TASK_STATE_UNAVAILABLE'):
            scope.workspace_backup(d, directory, identity, COMMIT, '20261009T120000Z')

    def test_failed_s3_checksum_or_corrupted_backup_never_proves_success(self):
        d, directory, _, identity, _, _, _, uploaded, _ = self.fixture()
        original = d.run
        def mismatched(*args, **kwargs):
            if args[:3] == ('aws', 's3api', 'head-object'):
                return json.dumps({**uploaded, 'ChecksumSHA256': 'wrong'})
            return original(*args, **kwargs)
        d.run = mismatched
        with self.assertRaisesRegex(RuntimeError, 'S3_UNVERIFIED'):
            scope.workspace_backup(d, directory, identity, COMMIT, '20261009T120000Z')
        d.run = original
        receipt = scope.workspace_backup(d, directory, identity, COMMIT, '20261009T120001Z')
        (directory / scope.WORKSPACE_BACKUP_FILE).write_text(json.dumps(receipt))
        path = d.BASE / 'backups/registration-workspace' / receipt['name']
        path.write_bytes(b'corrupted synthetic backup')
        manifest = {'commit': COMMIT, 'workspaceBackupBeforeRelease': receipt['name'], 'workspaceBackupSha256': scope.fingerprint(receipt)}
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_CHANGED'):
            scope.workspace_backup_receipt(d, directory, directory, {'workspaceVolume': identity}, manifest,
                                           {'workspaceBackupSha256': scope.fingerprint(receipt)})

    def test_api_proof_contains_all_published_workspace_runtime_resources(self):
        command = scope.content_command('api')
        for name in shared.WORKSPACE_API_ROOTS:
            self.assertIn(name, command)
        rows = '\n'.join('a' * 64 + '  ' + (name if name.endswith(('.css', '.json')) else name + '/fixture')
                         for name in shared.WORKSPACE_API_ROOTS)
        self.assertEqual(scope.content_summary(controller(), 'api', rows)['fileCount'], len(shared.WORKSPACE_API_ROOTS))


class IsolationTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('docker'), 'Docker Compose parser unavailable')
    def test_real_compose_parser_accepts_only_the_reviewed_production_delta(self):
        with directories() as (old, new):
            old_compose = subprocess.check_output(['git', 'show', scope.BASELINE_COMMIT + ':docker-compose.aws-mysql.yml'], cwd=ROOT)
            new_compose = (ROOT / 'docker-compose.aws-mysql.yml').read_bytes()
            import re
            keys = set(re.findall(r'\$\{([A-Z0-9_]+)', (old_compose + new_compose).decode()))
            values = {key: 'synthetic_fixture_value' for key in keys}
            values.update({'COMPOSE_PROJECT_NAME': 'online-recharge-fixture', 'MYSQL_HOST_PORT': '3306',
                           'DOCKER_LOG_MAX_SIZE': '20m', 'DOCKER_LOG_MAX_FILE': '10',
                           'AUTO_RECHARGE_WORKER_IMAGE': 'fixture-old-worker',
                           'ONLINE_RECHARGE_WORKER_KEY': 'a' * 43, **scope.ENV_DEFAULTS})
            old_override = {'services': {n: {'image': 'fixture-old-' + n, 'pull_policy': 'never'}
                            for n in (*scope.PRESERVED, 'api', 'admin', 'migrate')}}
            new_override = copy.deepcopy(old_override)
            for name in scope.IMAGE_SERVICES:
                new_override['services'][name] = {'image': 'fixture-new-' + name, 'pull_policy': 'never'}
            for root, text, override in ((old, old_compose, old_override), (new, new_compose, new_override)):
                (root / 'docker-compose.aws-mysql.yml').write_bytes(text)
                (root / 'compose.release.json').write_text(json.dumps(override))
                (root / '.env.aws.production').write_text(''.join(k + '=' + v + '\n' for k, v in values.items()))
            def compose(root, *args):
                return subprocess.check_output(['docker', 'compose', '--env-file', str(root / '.env.aws.production'),
                    '-f', str(root / 'docker-compose.aws-mysql.yml'), '-f', str(root / 'compose.release.json'), *args],
                    cwd=ROOT, stderr=subprocess.PIPE, text=True, timeout=30)
            receipt = scope.verify_compose(controller(compose=compose), old, new)
            self.assertTrue(receipt['sharedApiNetworkNamespace'])

    def test_compose_allows_only_api_media_loopback_keys_and_independent_executor(self):
        old, new = configurations()
        d = controller(compose=MagicMock(side_effect=[json.dumps(old), json.dumps(new)]))
        receipt = scope.verify_compose(d, Path('/old'), Path('/new'))
        self.assertTrue(receipt['databaseSecretsExcluded'])
        changes = []
        for service in scope.PRESERVED:
            value = copy.deepcopy(new); value['services'][service]['image'] = 'wrong'; changes.append(value)
        value = copy.deepcopy(new); value['services']['online-recharge']['network_mode'] = 'host'; changes.append(value)
        value = copy.deepcopy(new); value['services']['online-recharge']['ports'] = ['8053:8053']; changes.append(value)
        value = copy.deepcopy(new); value['services']['online-recharge']['environment']['DATABASE_URL'] = 'synthetic'; changes.append(value)
        value = copy.deepcopy(new); value['services']['api']['environment']['DATABASE_URL'] = 'different'; changes.append(value)
        value = copy.deepcopy(new); value['volumes']['mysql_data']['name'] = 'different'; changes.append(value)
        value = copy.deepcopy(new); value['networks']['default']['name'] = 'different'; changes.append(value)
        for value in changes:
            d.compose.side_effect = [json.dumps(old), json.dumps(value)]
            with self.subTest(), self.assertRaises(RuntimeError):
                scope.verify_compose(d, Path('/old'), Path('/new'))

    def test_caddy_projection_requires_identical_bytes(self):
        with directories() as (old, new):
            for root in (old, new):
                path = root / 'deploy/caddy/Caddyfile.aws'; path.parent.mkdir(parents=True)
                path.write_text('original-caddy-fixture\n')
            scope.verify_caddy_projection(controller(), old, new)
            (new / 'deploy/caddy/Caddyfile.aws').write_text('changed\n')
            with self.assertRaisesRegex(RuntimeError, 'CADDY_PROJECTION_CHANGED'):
                scope.verify_caddy_projection(controller(), old, new)

    def test_runtime_namespace_must_reference_current_api_container(self):
        d = controller(service_state=MagicMock(return_value=states(True)['online-recharge']), run=MagicMock())
        metadata = {'Id': 'd' * 64, 'Image': 'sha256:' + 'c' * 64, 'Config': {},
                    'HostConfig': {'NetworkMode': 'container:' + 'd' * 64},
                    'Mounts': [{'Destination': scope.ENGINE_VOLUME_PATH, 'Type': 'volume',
                                'Name': 'prod_' + scope.MEDIA_VOLUME, 'RW': True}]}
        api = {'Mounts': [{'Destination': scope.API_VOLUME_PATH, 'Type': 'volume',
                           'Name': 'prod_' + scope.MEDIA_VOLUME, 'RW': True}]}
        d.run.side_effect = [json.dumps([metadata]), json.dumps([api])]
        with patch.object(shared, 'snapshot', return_value=states()):
            scope.snapshot(d, ROOT, include_engine=True)
            metadata['HostConfig']['NetworkMode'] = 'container:' + 'e' * 64
            d.run.side_effect = [json.dumps([metadata])]
            with self.assertRaisesRegex(RuntimeError, 'NETWORK_CHANGED'):
                scope.snapshot(d, ROOT, include_engine=True)

    def test_busy_executor_blocks_removal_and_api_rollback(self):
        d = controller(compose=MagicMock(), rollback_service=MagicMock())
        with patch.object(scope, 'jobs_idle', side_effect=RuntimeError('ONLINE_RECHARGE_TASKS_BUSY')):
            okay, result = scope.rollback(d, ROOT, ROOT, ['admin', 'api', 'online-recharge'], states(), migrated=True)
        self.assertFalse(okay)
        self.assertEqual(result, {'online-recharge': 'BLOCKED_OR_FAILED'})
        d.compose.assert_not_called(); d.rollback_service.assert_not_called()

    def test_idle_rollback_removes_only_added_executor_and_reuses_old_api_admin(self):
        d = controller(compose=MagicMock(return_value=''), rollback_service=MagicMock())
        with patch.object(scope, 'jobs_idle'):
            okay, result = scope.rollback(d, ROOT, ROOT, ['admin', 'api', 'online-recharge'], states(), migrated=True)
        self.assertTrue(okay)
        self.assertEqual(list(result), ['online-recharge', 'api', 'admin'])
        self.assertEqual([call.args[2] for call in d.rollback_service.call_args_list], ['api', 'admin'])
        self.assertEqual(d.compose.call_args_list[0].args[1:], ('rm', '-s', '-f', 'online-recharge'))
        self.assertFalse(any('volume' in str(call) for call in d.compose.call_args_list))


class ReceiptTests(unittest.TestCase):
    def test_preflight_requires_historical_guard_zero49_and_only_returns_summary(self):
        value = {'status': 'ONLINE_RECHARGE_BASELINE_VERIFIED', 'commit': scope.BASELINE_COMMIT,
            'services': states(), 'manifestSha256': 'a' * 64, 'migration': dict(scope.MIGRATION_IDENTITY),
            'workspaceIdle': True, 'workspaceVolume': {'status': 'PRESENT', 'identitySha256': '1' * 64},
            'workspaceBuildProofSha256': '2' * 64,
            'workersPreserved': True, 'requiresWindowHandoff': False,
            'guards': {'rechargeIdle': True, 'registrationBusy': False, 'registrationLeaseActive': False,
                       'registrationWindowRetained': True},
            'audit': {'checkCount': 49, 'violationCount': 0, 'mode': 'STRICT_ZERO_49', 'checksSha256': 'b' * 64},
            'rawSecretFixture': 'MUST_NEVER_SURVIVE_SUMMARY'}
        result = scope.validate_receipt(controller(), value, 'preflight', COMMIT, scope.BASELINE_COMMIT)
        self.assertNotIn('rawSecretFixture', result)
        value['audit']['checkCount'] = 48
        with self.assertRaisesRegex(RuntimeError, 'BASELINE_CHANGED'):
            scope.validate_receipt(controller(), value, 'preflight', COMMIT, scope.BASELINE_COMMIT)

    def test_failure_codes_suppress_raw_exception_output(self):
        self.assertEqual(scope.safe_code(RuntimeError('API_ADMIN_BASELINE_PROJECTION_FAILED')), 'API_ADMIN_BASELINE_PROJECTION_FAILED')
        self.assertEqual(scope.safe_code(RuntimeError('synthetic secret must not escape')), 'ONLINE_RECHARGE_STEP_FAILED')

    def test_readback_requires_sealed_marker_when_migration_was_preserved(self):
        policy = scope.recovery_policy(controller())
        value = {'status': 'ONLINE_RECHARGE_VERIFIED', 'commit': COMMIT, 'sourceTree': TREE,
            'services': states(True), 'servicesUpdated': list(scope.UPDATED), 'preservedServiceCount': len(scope.PRESERVED),
            'runningImagesAndContentMatched': True, 'migrationApplied': True, 'migrationPerformed': False,
            'migration': {'name': scope.MIGRATION_NAME, 'sha256': scope.MIGRATION_IDENTITY['sha256'],
                'status': 'APPLIED', 'schemaVerified': True, 'appliedMigrationsSha256': 'f' * 64},
            'existingEnvironmentPreserved': True, 'credentialsLoopback': True, 'backupVerified': True,
            'workspaceBackupVerified': True, 'workspaceVolumePreserved': True,
            'legacyWorkersPublished': False, 'externalAcceptancePerformed': False, 'dedicatedVolume': scope.MEDIA_VOLUME,
            'checkCount': 49, 'violationCount': 0, 'buildProofSha256': 'e' * 64,
            'migrationRecovery': scope.recovery_marker(policy)}
        result = scope.validate_receipt(controller(), value, 'readback', COMMIT, COMMIT)
        self.assertEqual(result['migrationRecovery'], value['migrationRecovery'])
        self.assertFalse(result['migrationPerformed'])
        for variation in ('missing', 'performed', 'forged', 'second-forged', 'second-missing'):
            candidate = copy.deepcopy(value)
            if variation == 'missing':
                candidate.pop('migrationRecovery')
            elif variation == 'performed':
                candidate['migrationPerformed'] = True
            elif variation == 'forged':
                candidate['migrationRecovery']['failureReceiptSha256'] = '0' * 64
            elif variation == 'second-forged':
                candidate['migrationRecovery']['restoredAttempt']['failureReceiptSha256'] = '0' * 64
            else:
                candidate['migrationRecovery'].pop('restoredAttempt')
            with self.subTest(variation=variation), self.assertRaisesRegex(RuntimeError, 'READBACK_CHANGED'):
                scope.validate_receipt(controller(), candidate, 'readback', COMMIT, COMMIT)

    def test_projection_diagnostic_retains_gate_and_exposes_only_bounded_cause(self):
        try:
            try:
                raise KeyError('SECRET_MUST_NOT_ESCAPE')
            except KeyError:
                raise RuntimeError('API_ADMIN_BASELINE_PROJECTION_FAILED') from None
        except RuntimeError as error:
            failure = error
        with patch.object(scope, 'baseline', side_effect=failure):
            result = scope.projection_diagnostic(controller(), scope.BASELINE_COMMIT)
        self.assertFalse(result['baselineConfirmed'])
        self.assertEqual(result['causeType'], 'KeyError')
        self.assertEqual(result['gateCode'], 'API_ADMIN_BASELINE_PROJECTION_FAILED')
        self.assertNotIn('SECRET_MUST_NOT_ESCAPE', json.dumps(result))
        scope.validate_diagnostic(controller(), result, scope.BASELINE_COMMIT)
        for field, value in (('reason', 'arbitrary secret'), ('causeType', 'Unknown'), ('rawSecret', 'secret')):
            candidate = {**result, field: value}
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                scope.validate_diagnostic(controller(), candidate, scope.BASELINE_COMMIT)

    def test_deploy_lock_precedes_any_release_action_and_lock_failure_is_safe(self):
        with directories() as (folder, _):
            d = controller(BASE=folder, fcntl=SimpleNamespace(LOCK_EX=1, LOCK_NB=2, flock=MagicMock()))
            with patch.object(scope, '_release_locked', return_value=0) as action, redirect_stdout(io.StringIO()):
                self.assertEqual(scope.release(d, SimpleNamespace()), 0)
                d.fcntl.flock.assert_called_once(); action.assert_called_once()
            d.fcntl.flock.side_effect = BlockingIOError('synthetic secret')
            out = io.StringIO()
            with patch.object(scope, '_release_locked') as action, redirect_stdout(out):
                self.assertEqual(scope.release(d, SimpleNamespace()), 1)
                action.assert_not_called()
            self.assertNotIn('synthetic secret', out.getvalue())

    def test_archive_refuses_symlink_traversal_and_foreign_root(self):
        for name, kind in ((f'id-business-system-{COMMIT}/link', 'link'),
                           (f'id-business-system-{COMMIT}/../escape', 'file'), ('foreign/path', 'file')):
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode='w:gz') as archive:
                item = tarfile.TarInfo(name)
                if kind == 'link':
                    item.type = tarfile.SYMTYPE; item.linkname = '/etc/passwd'
                archive.addfile(item)
            response = MagicMock(); response.__enter__.return_value.read.return_value = data.getvalue()
            with directories() as (_, target), patch.object(scope.urllib.request, 'urlopen', return_value=response), self.assertRaisesRegex(RuntimeError, 'ARCHIVE_INVALID'):
                scope.extract_source(controller(), COMMIT, target)


class ExtractSourcePermissionTests(unittest.TestCase):
    def archive(self, entries):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w:gz') as archive:
            root = tarfile.TarInfo(f'id-business-system-{COMMIT}/')
            root.type = tarfile.DIRTYPE; root.mode = 0o775
            root.uid = 21; root.gid = 22
            archive.addfile(root)
            for name, raw, mode in entries:
                item = tarfile.TarInfo(f'id-business-system-{COMMIT}/' + name)
                item.mode = mode; item.uid = 21; item.gid = 22
                if raw is None:
                    item.type = tarfile.DIRTYPE
                    archive.addfile(item)
                else:
                    item.size = len(raw)
                    archive.addfile(item, io.BytesIO(raw))
        return data.getvalue()

    def extract(self, raw, target):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = raw
        with patch.object(scope.urllib.request, 'urlopen', return_value=response):
            return scope.extract_source(controller(), COMMIT, target)

    def test_archive_write_bits_are_removed_without_changing_content_or_git_execution(self):
        entries = (('deploy/', None, 0o775), ('deploy/caddy/', None, 0o775),
                   ('deploy/caddy/Caddyfile.aws', b'fixed-caddy-content\n', 0o664),
                   ('plain.txt', b'fixed-ordinary-content\n', 0o664),
                   ('bin/', None, 0o775), ('bin/worker.sh', b'#!/bin/sh\nexit 0\n', 0o775))
        raw = self.archive(entries)
        with directories() as (previous, target):
            target.chmod(0o700)
            retained = previous / 'retained.txt'; retained.write_bytes(b'previous-untouched\n')
            retained.chmod(0o664)
            self.assertEqual(self.extract(raw, target), raw)
            self.assertEqual(target.stat().st_mode & 0o7777, 0o700)
            for name, content, mode in entries:
                path = target / name
                self.assertEqual(path.stat().st_mode & 0o7777, mode & ~0o022)
                self.assertEqual(bool(path.stat().st_mode & 0o111), bool(mode & 0o111))
                if content is not None:
                    self.assertEqual(path.read_bytes(), content)
            self.assertEqual(retained.read_bytes(), b'previous-untouched\n')
            self.assertEqual(retained.stat().st_mode & 0o7777, 0o664)
        # Returned bytes preserve the original member UID/GID and tar modes.
        with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
            for member in archive.getmembers():
                self.assertEqual((member.uid, member.gid), (21, 22))
            self.assertEqual(archive.getmember(f'id-business-system-{COMMIT}/plain.txt').mode, 0o664)

    def test_existing_private_and_read_only_modes_are_preserved(self):
        entries = (('private/', None, 0o700), ('private/config', b'private-fixture\n', 0o600),
                   ('read-only.txt', b'read-only-fixture\n', 0o400),
                   ('owner-exec.sh', b'#!/bin/sh\nexit 0\n', 0o740))
        with directories() as (_, target):
            self.extract(self.archive(entries), target)
            for name, content, mode in entries:
                self.assertEqual((target / name).stat().st_mode & 0o7777, mode)
                if content is not None:
                    self.assertEqual((target / name).read_bytes(), content)

    def test_invalid_entries_are_rejected_before_any_extraction(self):
        for kind in ('symlink', 'hardlink', 'traversal', 'foreign-root'):
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode='w:gz') as archive:
                valid = tarfile.TarInfo(f'id-business-system-{COMMIT}/valid.txt')
                valid.size = 4; valid.mode = 0o664
                archive.addfile(valid, io.BytesIO(b'safe'))
                invalid = tarfile.TarInfo(f'id-business-system-{COMMIT}/invalid')
                if kind in ('symlink', 'hardlink'):
                    invalid.type = tarfile.SYMTYPE if kind == 'symlink' else tarfile.LNKTYPE
                    invalid.linkname = 'valid.txt'
                elif kind == 'traversal':
                    invalid.name = f'id-business-system-{COMMIT}/../escaped.txt'
                else:
                    invalid.name = 'foreign-root/invalid.txt'
                archive.addfile(invalid)
            with self.subTest(kind=kind), directories() as (_, target):
                with self.assertRaisesRegex(RuntimeError, 'SOURCE_ARCHIVE_INVALID'):
                    self.extract(data.getvalue(), target)
                self.assertEqual(list(target.iterdir()), [])
                self.assertFalse((target.parent / 'escaped.txt').exists())


class WorkspaceOriginTests(unittest.TestCase):
    def fixture(self, previous):
        managed = ('media-resolver', 'auto-recharge', 'auto-registration', 'api', 'admin')
        before = states()
        content = {'api': '\n'.join('1' * 64 + '  ' + path
            + ('' if path.endswith(('.css', '.json')) else '/fixture.js')
            for path in shared.WORKSPACE_API_ROOTS),
            'admin': '2' * 64 + '  /usr/share/nginx/html/index.html'}
        published = {'version': 1, 'scope': 'API_ADMIN_WORKSPACE', 'commit': scope.BASELINE_COMMIT,
            'sourceTree': TREE, 'configuration': {'composeSha256': '3' * 64,
                'caddySha256': shared.WORKSPACE_CADDY_AFTER, 'volume': shared.WORKSPACE_VOLUME,
                'containerDirectory': shared.WORKSPACE_DIRECTORY},
            'acceptance': {'status': 'PASS', 'checks': ['private-health', 'packaged-resources',
                'private-sqlite', 'encrypted-storage', 'restart-persistence', 'wrong-key-rejected'],
                'businessActions': 0, 'temporaryVolumeRemoved': True},
            'images': {name: {'reference': f'{REPOSITORY}:{scope.BASELINE_COMMIT}-123-1-{name}',
                'imageId': before[name]['image'], **shared.content_summary(controller(), name, content[name])}
                for name in shared.IMAGE_SERVICES}}
        for name in shared.IMAGE_SERVICES:
            before[name]['reference'] = published['images'][name]['reference']
        volume = {'name': 'fixture_auto_registration_data', 'status': 'PRESENT'}
        digest = scope.fingerprint(published)
        manifest = {'commit': scope.BASELINE_COMMIT, 'sourceTree': TREE, 'servicesUpdated': list(shared.UPDATED),
            'images': {name: {'reference': before[name]['reference'], 'digest': before[name]['image'],
                'sourceCommit': scope.BASELINE_COMMIT if name in shared.IMAGE_SERVICES else '8' * 40}
                for name in managed},
            'apiWorkspacePublication': {'version': 1, 'scope': 'API_ADMIN_WORKSPACE',
                'buildProofSha256': digest, 'workersPublished': False, 'cacheStatus': 'SKIPPED',
                'configurationChanged': True, 'volume': volume, 'volumeDeletionPerformed': False}}
        record = {'workspaceVolumeAfter': volume, 'buildProofSha256': digest, 'after': copy.deepcopy(before)}
        for name, value in {'release-manifest.json': manifest, shared.PROOF_FILE: published,
                shared.STATE_FILE: record, 'backup-verification.json': {'verified': True},
                'before-audit.json': {'violationCount': 0}, 'after-audit.json': {'violationCount': 0}}.items():
            (previous / name).write_text(json.dumps(value))
        evidence = {'workspaceVolume': volume, 'workspaceBuildProofSha256': digest,
                    'workspaceOriginFiles': scope.workspace_files(controller(), previous)}
        def run(*args):
            if args[:3] == ('docker', 'image', 'inspect'):
                name = next(n for n, row in published['images'].items() if row['reference'] == args[3])
                return json.dumps([{'Id': published['images'][name]['imageId'], 'Architecture': 'amd64',
                    'Config': {'Labels': {'org.opencontainers.image.revision': scope.BASELINE_COMMIT,
                        'id-business-v2.source-tree': TREE}}}])
            if args[:2] == ('docker', 'run'):
                name = next(n for n, row in published['images'].items() if row['reference'] in args)
                return content[name]
            raise AssertionError('Unexpected workspace origin fixture command')
        d = controller(SERVICES=managed, run=MagicMock(side_effect=run), compose=MagicMock(return_value='{"ready":true}'))
        return d, before, evidence, manifest, record, published, content

    def reseal(self, d, previous, evidence):
        # Model a structure being accepted initially, then independently check
        # its semantics instead of testing only the immutable-file guard.
        evidence['workspaceOriginFiles'] = scope.workspace_files(d, previous)

    def test_seven_runtime_services_and_only_five_manifest_images_are_valid(self):
        with directories() as (previous, current):
            d, before, evidence, manifest, _, _, _ = self.fixture(previous)
            self.assertEqual(len(before), 7)
            self.assertEqual(set(manifest['images']), set(d.SERVICES))
            self.assertNotIn('mysql', manifest['images']); self.assertNotIn('caddy', manifest['images'])
            with patch.object(scope, 'workspace_guard') as guard:
                scope.workspace_origin(d, previous, current, evidence, before)
            guard.assert_called_once_with(d, current, evidence['workspaceVolume'])
            self.assertEqual(d.run.call_count, 4)
            d.compose.assert_called_once()
            self.assertEqual(d.compose.call_args.args[0], current)
            self.assertEqual(d.compose.call_args.args[1:5], ('exec', '-T', 'api', 'node'))

    def test_every_managed_reference_digest_and_missing_entry_are_rejected(self):
        for name in ('media-resolver', 'auto-recharge', 'auto-registration', 'api', 'admin'):
            for field in ('reference', 'digest', 'missing'):
                with self.subTest(service=name, field=field), directories() as (previous, current):
                    d, before, evidence, manifest, _, _, _ = self.fixture(previous)
                    if field == 'missing':
                        del manifest['images'][name]
                    else:
                        manifest['images'][name][field] = 'changed-fixture-image'
                    (previous / 'release-manifest.json').write_text(json.dumps(manifest))
                    self.reseal(d, previous, evidence)
                    with self.assertRaisesRegex(RuntimeError, 'WORKSPACE_ORIGIN_CHANGED'):
                        scope.workspace_origin(d, previous, current, evidence, before)
                    d.run.assert_not_called(); d.compose.assert_not_called()

    def test_seven_published_after_services_and_all_preserved_identities_are_required(self):
        changes = [(n, k) for n in scope.PRESERVED for k in scope.SERVICE_IDENTITY_KEYS]
        changes += [(n, k) for n in ('api', 'admin') for k in scope.SERVICE_IDENTITY_KEYS
                    if k not in ('containerId', 'startedAtSha256')]
        with directories() as (previous, current):
            d, before, evidence, _, record, _, _ = self.fixture(previous)
            original = copy.deepcopy(record['after'])
            for name, key in changes:
                record['after'] = copy.deepcopy(original); record['after'][name][key] = 'forged'
                (previous / shared.STATE_FILE).write_text(json.dumps(record)); self.reseal(d, previous, evidence)
                with self.subTest(service=name, key=key), self.assertRaisesRegex(RuntimeError, 'WORKSPACE_ORIGIN_CHANGED'):
                    scope.workspace_origin(d, previous, current, evidence, before)
            for name in ('api', 'mysql', 'caddy', 'extra'):
                record['after'] = copy.deepcopy(original)
                if name == 'extra':
                    record['after'][name] = copy.deepcopy(original['api'])
                else:
                    del record['after'][name]
                (previous / shared.STATE_FILE).write_text(json.dumps(record)); self.reseal(d, previous, evidence)
                with self.subTest(service=name), self.assertRaisesRegex(RuntimeError, 'WORKSPACE_ORIGIN_CHANGED'):
                    scope.workspace_origin(d, previous, current, evidence, before)
            d.run.assert_not_called(); d.compose.assert_not_called()

    def test_sealed_source_commit_and_every_predecessor_file_change_are_rejected(self):
        for name in ('media-resolver', 'auto-recharge', 'auto-registration', 'api', 'admin'):
            with self.subTest(service=name), directories() as (previous, current):
                d, before, evidence, manifest, _, _, _ = self.fixture(previous)
                manifest['images'][name]['sourceCommit'] = '9' * 40
                (previous / 'release-manifest.json').write_text(json.dumps(manifest))
                with self.assertRaisesRegex(RuntimeError, 'WORKSPACE_ORIGIN_CHANGED'):
                    scope.workspace_origin(d, previous, current, evidence, before)
        with directories() as (previous, current):
            d, before, evidence, _, _, _, _ = self.fixture(previous)
            for name in evidence['workspaceOriginFiles']:
                path = previous / name
                original = path.read_bytes()
                path.write_bytes(original + b'\n')
                with self.subTest(file=name), self.assertRaisesRegex(RuntimeError, 'WORKSPACE_ORIGIN_CHANGED'):
                    scope.workspace_origin(d, previous, current, evidence, before)
                path.write_bytes(original)

    def test_commit_proof_and_volume_mismatch_fail_even_with_fresh_file_seal(self):
        for changed in ('manifest-commit', 'proof-commit', 'proof-tree', 'proof-fingerprint', 'volume'):
            with self.subTest(changed=changed), directories() as (previous, current):
                d, before, evidence, manifest, record, published, _ = self.fixture(previous)
                if changed == 'manifest-commit':
                    manifest['commit'] = COMMIT
                elif changed == 'volume':
                    record['workspaceVolumeAfter'] = {'name': 'other_volume', 'status': 'PRESENT'}
                elif changed == 'proof-fingerprint':
                    published['images']['api']['sha256'] = '0' * 64
                else:
                    published['commit' if changed == 'proof-commit' else 'sourceTree'] = '9' * 40
                for name, value in {'release-manifest.json': manifest, shared.STATE_FILE: record,
                        shared.PROOF_FILE: published}.items():
                    (previous / name).write_text(json.dumps(value))
                self.reseal(d, previous, evidence)
                with self.assertRaises(RuntimeError):
                    scope.workspace_origin(d, previous, current, evidence, before)
                d.run.assert_not_called(); d.compose.assert_not_called()

    def test_missing_infrastructure_or_managed_snapshot_and_extra_service_are_rejected(self):
        for changed in (*states(), 'extra'):
            with self.subTest(changed=changed), directories() as (previous, current):
                d, before, evidence, _, _, _, _ = self.fixture(previous)
                if changed == 'extra':
                    before['online-recharge'] = before['api']
                else:
                    del before[changed]
                with self.assertRaisesRegex(RuntimeError, 'WORKSPACE_ORIGIN_CHANGED'):
                    scope.workspace_origin(d, previous, current, evidence, before)
                d.run.assert_not_called(); d.compose.assert_not_called()

    def test_actual_image_provenance_and_content_must_still_match_the_proof(self):
        for changed in ('image-label', 'image-content'):
            with self.subTest(changed=changed), directories() as (previous, current):
                d, before, evidence, _, _, _, content = self.fixture(previous)
                if changed == 'image-content':
                    content['api'] = content['api'].replace('1' * 64, '0' * 64)
                else:
                    original = d.run.side_effect
                    def run(*args):
                        output = original(*args)
                        return output.replace(scope.BASELINE_COMMIT, COMMIT) if args[:3] == ('docker', 'image', 'inspect') else output
                    d.run.side_effect = run
                with patch.object(scope, 'workspace_guard') as guard, self.assertRaisesRegex(RuntimeError,
                        'IMAGE_PROVENANCE_CHANGED|WORKSPACE_IMAGE_CHANGED'):
                    scope.workspace_origin(d, previous, current, evidence, before)
                guard.assert_not_called(); d.compose.assert_not_called()

    def test_workspace_volume_guard_and_real_health_reader_remain_mandatory(self):
        for changed in ('volume', 'health'):
            with self.subTest(changed=changed), directories() as (previous, current):
                d, before, evidence, _, _, _, _ = self.fixture(previous)
                d.compose.return_value = '{"ready":false}'
                with patch.object(scope, 'workspace_guard', side_effect=(RuntimeError(
                        'ONLINE_RECHARGE_WORKSPACE_VOLUME_CHANGED') if changed == 'volume' else None)) as guard:
                    with self.assertRaisesRegex(RuntimeError, 'WORKSPACE_VOLUME_CHANGED|WORKSPACE_HEALTH_FAILED'):
                        scope.workspace_origin(d, previous, current, evidence, before)
                guard.assert_called_once_with(d, current, evidence['workspaceVolume'])
                if changed == 'volume':
                    d.compose.assert_not_called()
                else:
                    d.compose.assert_called_once()


class ReleaseSequenceTests(unittest.TestCase):
    def execute(self, fail=None, busy=False, recovered=False, stage2=False):
        temporary = tempfile.TemporaryDirectory(prefix='release-', dir=RUNTIME)
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        previous = base / 'releases/old'
        previous.mkdir(parents=True)
        (base / 'current').symlink_to(previous)
        events, broken = [], [False]
        old_manifest = {'commit': scope.BASELINE_COMMIT, 'images': {
            n: {'reference': 'old-' + n, 'digest': 'sha256:' + 'c' * 64, 'sourceCommit': scope.BASELINE_COMMIT}
            for n in (*scope.PRESERVED, 'api', 'admin', 'migrate')}}
        raw = json.dumps(old_manifest).encode()
        (previous / 'release-manifest.json').write_bytes(raw)
        (previous / '.env.aws.production').write_text('APP_PUBLIC_URL=https://fixture.invalid\n')
        (previous / 'compose.release.json').write_text(json.dumps({'services': {n: {
            'image': r['reference'], 'pull_policy': 'never'} for n, r in old_manifest['images'].items()}}))
        candidate = proof()
        def extract(d, commit, target):
            for name in scope.CONTROL_FILES:
                path = target / name; path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((ROOT / name).read_bytes())
            (target / scope.ENGINE_ROOT).mkdir(parents=True)
            (target / scope.ENGINE_ROOT / 'worker.cjs').write_text('synthetic fixture\n')
            candidate['engineSourceSha256'] = scope.fingerprint(scope.file_inventory(controller(), target / scope.ENGINE_ROOT))
            (target / 'docker-compose.aws-mysql.yml').write_text('synthetic-compose')
            candidate['composeSourceSha256'] = hashlib.sha256(b'synthetic-compose').hexdigest()
            return b'synthetic archive'
        # The same synthetic source inventory is available before the proof is validated.
        candidate['engineSourceSha256'] = scope.fingerprint({'worker.cjs': hashlib.sha256(b'synthetic fixture\n').hexdigest()})
        candidate['composeSourceSha256'] = hashlib.sha256(b'synthetic-compose').hexdigest()
        args = SimpleNamespace(online_recharge_only=True, commit=COMMIT, source_tree=TREE,
            expected_current=scope.BASELINE_COMMIT, repository=REPOSITORY, run_id='123', run_attempt='1', ci_run_id='234',
            online_recharge_build_proof=base64.b64encode(json.dumps(candidate).encode()).decode())
        def audit(d, folder, receipt):
            events.append('audit:' + receipt.name)
            return {'checkCount': 49, 'violationCount': 0, 'mode': 'STRICT_ZERO_49', 'checksSha256': 'f' * 64}
        fake_legacy = SimpleNamespace(baseline=MagicMock(return_value=(previous, old_manifest, states(),
            {'manifestSha256': hashlib.sha256(raw).hexdigest()})), source_tree=MagicMock(return_value=TREE), strict_audit=audit)
        baseline_evidence = {'manifestSha256': hashlib.sha256(raw).hexdigest(),
                             'workspaceVolume': {'name': 'fixture_auto_registration_data'}}
        recovery = {'source': previous, 'policy': {}, 'state': {'status': 'APPLIED'},
                    'marker': {'fixed-recovery-fixture': True}}
        if recovered:
            baseline_evidence['migrationRecovery'] = recovery['marker']
        if stage2:
            args.expected_current = COMMIT
            baseline_evidence['onlinePendingWorkspaceOrigin'] = {'kind':scope.ONLINE_PENDING_WORKSPACE_KIND,'syntheticOnly':True}
            class Fence:
                def __init__(self,*a,**kw): pass
                def __enter__(self): events.append('sql-lock'); return self
                def before_stop(self): events.append('sql-before-stop')
                def check(self): events.append('sql-check')
                def __exit__(self,*a): events.append('sql-unlock')
            class Gate:
                record={'syntheticOnly':True}
                def stop_previous(self):
                    events.append('sqlite-stop-confirmed')
                    if fail=='sqlite-stop': raise RuntimeError('API_ADMIN_WORKSPACE_OLD_API_NOT_STOPPED')
                def finish(self): events.append('sqlite-finish')
                def abort(self): events.append('sqlite-abort')
                def close(self): events.append('sqlite-close')
            def prepare(*a,**kw):
                self.assertIs(kw['legacy'],False)
                events.append('sqlite-protect'); return Gate()
            fake_legacy.WorkspaceUnusedAuditBarrier=Fence
            fake_legacy.workspace_prepare=prepare
        def sqlite_backup(*args):
            events.append('sqlite-backup')
            return {'name': 'synthetic.sqlite3.gz', 's3Verified': True}
        def backup(folder):
            events.append('backup')
            return {'s3Verified': True, 'name': 'synthetic.sql.gz', 'sha256': 'e' * 64, 'size': 123}
        def compose(folder, *args, **kwargs):
            if args[0] == 'run':
                events.append('migration')
            elif args[0] == 'up':
                service = args[-1]; events.append('switch:' + service)
                if fail == service:
                    broken[0] = True
                    raise RuntimeError('RAW_SYNTHETIC_SECRET_SUPPRESSED')
            elif args[0] == 'rm':
                events.append('remove:' + args[-1])
            return ''
        def grants(*args):
            events.append('grants')
            if fail == 'grants':
                raise RuntimeError('RAW_SYNTHETIC_SECRET_SUPPRESSED')
            return {'ok': True, 'newTableCount': 9}
        def idle(*args, **kwargs):
            if busy and broken[0]:
                raise RuntimeError('ONLINE_RECHARGE_TASKS_BUSY')
            events.append('idle')
        def origin(d, source, running, evidence, before):
            self.assertEqual(source, previous); self.assertEqual(running, previous)
            events.append('workspace-origin')
            if fail == 'workspace-origin':
                raise RuntimeError('ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED')
        d = controller(BASE=base, __file__=str(ROOT / 'scripts/production-release/remote-deploy.py'),
            run=MagicMock(return_value='synthetic-login-password'), compose=compose, wait_healthy=MagicMock(),
            environment_values=env_values, fresh_backup=backup, sync_new_table_grants=grants,
            rollback_service=lambda a, b, service, before: events.append('restore:' + service),
            point_current=lambda target, name: ((base / 'current').unlink(), (base / 'current').symlink_to(target)))
        response = MagicMock(); response.__enter__.return_value.status = 200
        output = io.StringIO()
        with ExitStack() as stack:
            for name, value in {
                'legacy': fake_legacy, 'extract_source': extract,
                'baseline': MagicMock(return_value=(previous, old_manifest, states(), baseline_evidence)),
                'release_recovery': MagicMock(return_value=recovery),
                'candidate_recovery_source': MagicMock(),
                'workspace_backup': sqlite_backup,
                'migration_source_check': MagicMock(), 'protected_source': MagicMock(),
                'require_preserved': MagicMock(return_value=(states(True), {})),
                'migration_database_state': MagicMock(side_effect=[{'status': 'APPLIED' if recovered else 'PENDING'}, {'status': 'APPLIED'}, {'status': 'APPLIED'}]),
                'configuration_hashes': MagicMock(return_value={}),
                'verify_image_content': MagicMock(), 'verify_running': MagicMock(), 'historical_guard': MagicMock(),
                'verify_permission_seed': MagicMock(), 'require_fresh_resources': lambda *a: events.append('empty9'),
                'jobs_idle': idle, 'snapshot': MagicMock(return_value=states()),
                'workspace_guard': MagicMock(return_value=baseline_evidence['workspaceVolume']),
                'workspace_origin': origin,
                'readback': lambda *a: {'status': 'ONLINE_RECHARGE_VERIFIED'},
            }.items():
                stack.enter_context(patch.object(scope, name, return_value=value) if name == 'legacy' else patch.object(scope, name, value))
            stack.enter_context(patch.object(scope.subprocess, 'run', return_value=SimpleNamespace(returncode=0)))
            stack.enter_context(patch.object(scope.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * 1024**3)))
            stack.enter_context(patch.object(scope.urllib.request, 'urlopen', return_value=response))
            stack.enter_context(redirect_stdout(output))
            if stage2:
                stack.enter_context(patch.object(scope,'validate_arguments',return_value=candidate))
                stack.enter_context(patch.object(scope,'_workspace_evidence_origin',return_value=baseline_evidence['onlinePendingWorkspaceOrigin']))
            result = (scope._pending_workspace_release_locked if stage2 else scope._release_locked)(d, args)
        return result, json.loads(output.getvalue()), events

    def test_audit_backup_migration_grants_and_three_service_order(self):
        result, receipt, events = self.execute()
        self.assertEqual(result, 0)
        self.assertEqual(receipt['status'], 'ONLINE_RECHARGE_VERIFIED')
        selected = [e for e in events if e.startswith(('audit:', 'switch:')) or e in ('workspace-origin', 'backup', 'sqlite-backup', 'migration', 'grants')]
        self.assertEqual(selected, ['workspace-origin', 'audit:before-audit.json', 'backup', 'sqlite-backup', 'migration', 'grants',
                                   'switch:admin', 'switch:api', 'switch:online-recharge', 'audit:after-audit.json'])
        self.assertEqual(events.count('empty9'), 4)

    def test_invalid_predecessor_is_rejected_before_migration_grants_or_switch(self):
        result, receipt, events = self.execute(fail='workspace-origin')
        self.assertEqual(result, 1)
        self.assertEqual(receipt['status'], 'ONLINE_RECHARGE_FAILED_BEFORE_SWITCH')
        self.assertEqual(receipt['step'], 'source')
        self.assertEqual(receipt['code'], 'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED')
        self.assertEqual(receipt['servicesAttempted'], [])
        self.assertEqual(receipt['migration'], {'status': 'NOT_ATTEMPTED', 'performed': False})
        self.assertFalse(any(e.startswith('switch:') or e in ('migration', 'grants', 'backup', 'sqlite-backup') for e in events))

    def test_post_migration_grant_failure_keeps_additive_schema_and_never_switches(self):
        result, receipt, events = self.execute(fail='grants')
        self.assertEqual(result, 1)
        self.assertEqual(receipt['status'], 'ONLINE_RECHARGE_FAILED_BEFORE_SWITCH')
        self.assertFalse(any(e.startswith('switch:') for e in events))
        self.assertEqual(receipt['migration']['status'], 'APPLIED')
        self.assertFalse(receipt['inverseMigrationPerformed'])
        self.assertNotIn('RAW_SYNTHETIC_SECRET', json.dumps(receipt))

    def test_sealed_applied_recovery_skips_migration_but_takes_new_backups_and_runs_grants(self):
        result, receipt, events = self.execute(recovered=True)
        self.assertEqual(result, 0)
        self.assertEqual(receipt['status'], 'ONLINE_RECHARGE_VERIFIED')
        selected = [e for e in events if e.startswith(('audit:', 'switch:')) or e in ('backup', 'sqlite-backup', 'migration', 'grants')]
        self.assertEqual(selected, ['audit:before-audit.json', 'backup', 'sqlite-backup', 'grants',
                                   'switch:admin', 'switch:api', 'switch:online-recharge', 'audit:after-audit.json'])

    def test_recovery_second_failure_keeps_schema_without_repeating_migration_or_switch(self):
        result, receipt, events = self.execute(fail='grants', recovered=True)
        self.assertEqual(result, 1)
        self.assertEqual(receipt['status'], 'ONLINE_RECHARGE_FAILED_BEFORE_SWITCH')
        self.assertEqual(receipt['migration'], {'status': 'APPLIED', 'performed': False})
        self.assertFalse(receipt['migrationAttempted'])
        self.assertFalse(receipt['inverseMigrationPerformed'])
        self.assertNotIn('migration', events)
        self.assertFalse(any(e.startswith('switch:') for e in events))

    def test_executor_start_failure_removes_only_executor_and_restores_api_admin(self):
        result, receipt, events = self.execute(fail='online-recharge')
        self.assertEqual(result, 1)
        self.assertEqual(receipt['status'], 'ONLINE_RECHARGE_FAILED_RESTORED')
        self.assertEqual([e for e in events if e.startswith(('remove:', 'restore:'))],
                         ['remove:online-recharge', 'restore:api', 'restore:admin'])

    def test_new_active_task_prevents_executor_removal_and_api_rollback(self):
        result, receipt, events = self.execute(fail='online-recharge', busy=True)
        self.assertEqual(result, 1)
        self.assertEqual(receipt['status'], 'ONLINE_RECHARGE_PARTIAL_RECOVERY_REQUIRED')
        self.assertFalse(receipt['rollbackOk'])
        self.assertFalse(any(e.startswith(('remove:', 'restore:')) for e in events))


class DeclarationEquivalencePureTests(unittest.TestCase):
    """Synthetic publication bytes; real immutable Git source and fixed policy.

    No producer/run/payment/production equivalence is claimed by these fixtures.
    """
    @classmethod
    def setUpClass(cls):
        cls.commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT).decode().strip()
        cls.tree = subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=ROOT).decode().strip()
        cls.archive = subprocess.check_output(['git', 'archive', '--format=tar.gz',
            '--prefix=id-business-system-' + cls.commit + '/', cls.commit], cwd=ROOT)
        cls.inventory = scope.archive_inventory(controller(), cls.archive, cls.commit, cls.tree)
        cls.policy_raw = (ROOT / 'scripts/production-release/online-recharge-recovery.json').read_bytes()
        cls.policy = scope.closed_recovery_json(controller(), cls.policy_raw)
        cls.completed = {name.split('/')[-2]: row['sha256'] for name, row in cls.inventory.items()
                         if name.startswith(scope.MIGRATION_ROOT + '/') and name.endswith('/migration.sql')}

    @staticmethod
    def raw(value):
        return (json.dumps(value, indent=2) + '\n').encode()

    @staticmethod
    def sha(value):
        return hashlib.sha256(value).hexdigest()

    def fixture(self):
        h = lambda label: self.sha(('SYNTHETIC:' + label).encode())
        original = copy.deepcopy(self.policy['preflight']['services'])
        actual = copy.deepcopy(original)
        candidate = copy.deepcopy(original)
        workspace_before = copy.deepcopy(original)
        for name in ('api', 'admin'):
            workspace_before[name]['containerId'] = h(name + '-prior-cid')
            candidate[name]['containerId'] = h(name + '-296-cid')
            for key in ('containerId', 'startedAtSha256', 'configurationSha256'):
                actual[name][key] = h(name + '-restored-' + key)
        state = {'name': scope.MIGRATION_NAME, 'sha256': scope.MIGRATION_IDENTITY['sha256'],
            'status': 'APPLIED', 'schemaVerified': True, 'appliedMigrationsSha256': scope.fingerprint(self.completed)}
        common = {'errorType': 'RuntimeError', 'rollbackOk': True, 'previousCommit': scope.BASELINE_COMMIT,
            'inverseMigrationPerformed': False, 'mediaVolumeDeleted': False,
            'currentPointsToCandidate': False, 'receiptPersisted': True}
        one = {**common, 'status': 'ONLINE_RECHARGE_FAILED_BEFORE_SWITCH', 'step': 'migration',
            'code': 'ONLINE_RECHARGE_STEP_FAILED', 'rollback': {}, 'servicesAttempted': [],
            'candidateCommit': scope.RECOVERY_COMMIT, 'migration': {**state, 'performed': True}, 'migrationAttempted': True}
        two = {**common, 'status': 'ONLINE_RECHARGE_FAILED_RESTORED', 'step': 'audit-after',
            'code': 'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED', 'rollback': {n: 'RESTORED' for n in scope.SWITCH_ORDER},
            'servicesAttempted': list(scope.SWITCH_ORDER), 'candidateCommit': scope.RESTORED_COMMIT,
            'migration': {**state, 'performed': False}, 'migrationAttempted': False}
        self.assertEqual(scope.fingerprint(one), scope.RECOVERY_FAILURE_SHA256)
        self.assertEqual(scope.fingerprint(two), scope.RESTORED_FAILURE_SHA256)
        history = {'workspaceManifestBytesSha256': self.raw({'commit': scope.BASELINE_COMMIT}),
            'workspaceRecordBytesSha256': self.raw({'before': workspace_before, 'after': original}),
            'workspaceBuildProofBytesSha256': self.raw({'commit': scope.BASELINE_COMMIT}),
            'restoredManifestBytesSha256': self.raw({'commit': scope.RESTORED_COMMIT}),
            'restoredRecordBytesSha256': self.raw({'before': original, 'after': candidate}),
            'restoredBuildProofBytesSha256': self.raw({'commit': scope.RESTORED_COMMIT}),
            'firstFailure': self.raw(one), 'secondFailure': self.raw(two), 'recoveryPolicy': self.policy_raw}
        producer = {'commit': self.commit, 'sourceTree': self.tree, 'workflowRunId': '70000000001',
            'workflowRunAttempt': '1', 'archiveInventorySha256': scope.fingerprint(self.inventory),
            'helpers': {n: self.inventory[n]['sha256'] for n in scope.DECLARATION_EQUIVALENCE_HELPERS}}
        source = {n: h(n) for n in scope.DECLARATION_EQUIVALENCE_FIELDS['sourceBindings']}
        source.update(apiImageId=actual['api']['image'], apiImageReference=actual['api']['reference'],
                      expectedEnvironmentSha256=actual['api']['environmentSha256'])
        observation = {'snapshotSha256': scope.fingerprint(actual), 'sourceFilesSha256': h('files'),
            'workspaceVolumeSha256': h('volume'), 'actualResourceSha256': source['actualResourceSha256']}
        semantic = {'producer': producer,
            'fixedRecovery': {**scope.DECLARATION_EQUIVALENCE_FIXED,
                             'recoveryMarkerSha256': scope.fingerprint(scope.recovery_marker(self.policy))},
            'historicalFiles': {n: self.sha(history[n]) for n in scope.DECLARATION_EQUIVALENCE_FIELDS['historicalFiles']},
            'anchors': {n: {'oldBeforeContainerId': workspace_before[n]['containerId'],
                           'candidateAfterContainerId': candidate[n]['containerId']} for n in ('api', 'admin')},
            'original': original, 'actual': actual, 'sourceBindings': source,
            'apiEquivalence': {'rulesSha256': h('synthetic-rules'),
                'oldRawConfigurationSha256': original['api']['configurationSha256'],
                'actualRawConfigurationSha256': actual['api']['configurationSha256'],
                'normalizedActualSha256': h('normalized'), 'normalizedReferenceSha256': h('normalized')},
            'adminProjection': {'kind': 'ADMIN_OLD_COMPLETE_CONFIGURATION_MATCH',
                'originalConfigurationSha256': original['admin']['configurationSha256'],
                'actualConfigurationSha256': actual['admin']['configurationSha256'],
                'projectedConfigurationSha256': original['admin']['configurationSha256'],
                'helperSha256': producer['helpers'][scope.DECLARATION_EQUIVALENCE_HELPERS[2]]},
            'stableObservation': observation}
        measurement = {n: h(n) for n in scope.DECLARATION_EQUIVALENCE_FIELDS['measurement']}
        measurement.update(purpose='INDEPENDENT_PREFLIGHT', executionNonce='1' * 32,
            neverStarted=True, cleanupVerified=True, realEnvironmentPersisted=False,
            referenceCounts={'containers': 1, 'networks': 4, 'volumes': 1},
            stableBefore=copy.deepcopy(observation), stableAfter=copy.deepcopy(observation),
            priorIndependentPreflightBytesSha256=None, priorProofSha256=None)
        first = {'kind': scope.DECLARATION_EQUIVALENCE_KIND, 'version': 3, 'service': 'api',
                 'semantic': semantic, 'measurement': measurement}
        origin = {'version': 2, 'scope': 'PENDING_ONLINE_MIGRATION', 'baselineRelease': '/synthetic/0a',
            'baselineManifestSha256': semantic['historicalFiles']['workspaceManifestBytesSha256'],
            'migrationState': state, 'recoveryMarker': scope.recovery_marker(self.policy),
            'restoredOrigin': {'source': '/synthetic/296',
                'manifestSha256': semantic['historicalFiles']['restoredManifestBytesSha256'],
                'recordSha256': semantic['historicalFiles']['restoredRecordBytesSha256']},
            'services': actual, 'priorPublications': [], 'restoredConfigurationProof': first}
        f = self.raw({'commandId': '00000000-0000-0000-0000-000000000001', 'mode': 'preflight',
            'status': 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED', 'commit': scope.BASELINE_COMMIT,
            'releaseCandidateCommit': self.commit, 'workflowRunId': '70000000001', 'workflowRunAttempt': '1',
            'services': actual, 'pendingOnlineMigrationOrigin': origin, 'existingFullReceiptField': 'retained'})
        second = copy.deepcopy(first)
        second['measurement'].update(purpose='DEPLOYMENT_REMEASURE', executionNonce='2' * 32,
            referenceRegistrySha256=h('new-owner-cid'), referenceRawConfigurationSha256=h('new-reference'),
            referenceModelSha256=h('new-model'), priorIndependentPreflightBytesSha256=self.sha(f),
            priorProofSha256=scope.fingerprint(first))
        pair = scope.declaration_equivalence_pair_seal(controller(), first, second, f)
        after = copy.deepcopy(actual)
        for n in ('api', 'admin'):
            after[n]['containerId'] = h('published-' + n)
            after[n]['image'] = 'sha256:' + h('new-' + n)
            after[n]['reference'] = 'synthetic-' + n
        configuration = {n: h(n) for n in ('docker-compose.aws-mysql.yml', 'deploy/caddy/Caddyfile.aws',
                                         scope.SCHEMA_FILE, 'compose.release.json')}
        build = self.raw({'commit': self.commit, 'sourceTree': self.tree,
            'pendingOnlineOriginSha256': scope.fingerprint(origin), 'pendingOnlinePreflightSha256': self.sha(f),
            'declarationEquivalenceSeal': {k: pair[k] for k in ('kind', 'version', 'preflightProofSha256', 'semanticSha256')}})
        record = self.raw({'before': actual, 'after': after, 'configurationAfter': configuration,
            'pendingOnlineMigrationOrigin': origin, 'pendingOnlineConfigurationMeasurement': second})
        manifest = self.raw({'commit': self.commit, 'sourceTree': self.tree,
            'pendingOnlineMigration': {'originSha256': scope.fingerprint(origin), 'configurationEquivalenceSeal': pair}})
        return {'origin': origin, 'second': second, 'preflight_raw': f, 'build_raw': build,
            'record_raw': record, 'manifest_raw': manifest, 'producer': producer,
            'archive_bytes': self.archive, 'historical_files': history}

    def publication(self, fixture):
        return scope.declaration_equivalence_publication_binding(controller(), **fixture)

    @staticmethod
    def decode_wire(output, *, scope):
        # The plain-only fixture supplies a pure decoder capability; it does not
        # establish real AWS/source authority. Framing is covered separately.
        if scope != 'API_ADMIN_WORKSPACE':
            raise RuntimeError('SYNTHETIC_SCOPE_INVALID')
        return json.loads(output)

    def invocation(self, publication):
        issued = scope.declaration_equivalence_issuer_binding(controller(), publication,
            live_services=publication['afterServices'], live_configuration=publication['configurationAfter'],
            execution_producer=publication['producer'])
        return self.raw({'CommandId': '00000000-0000-0000-0000-000000000002', 'Status': 'Success', 'ResponseCode': 0,
            'StandardOutputContent': json.dumps({'status': 'API_ADMIN_WORKSPACE_VERIFIED',
                                               'declarationEquivalencePublication': issued})})

    def test_structure_pair_real_git_and_synthetic_artifact_bindings(self):
        fixture = self.fixture(); before = copy.deepcopy(fixture)
        pub = self.publication(fixture)
        self.assertEqual(fixture, before)
        self.assertEqual(pub['configurationEquivalenceSeal']['semanticSha256'],
                         scope.fingerprint(fixture['origin']['restoredConfigurationProof']['semantic']))
        result = scope.declaration_equivalence_receipt_binding(controller(), pub, self.invocation(pub),
            command_id='00000000-0000-0000-0000-000000000002', wire_decoder=self.decode_wire)
        self.assertEqual(result['recordBytesSha256'], self.sha(fixture['record_raw']))

    def test_kind_version_unknown_fields_full8_and_expected_env_are_closed(self):
        f = self.fixture(); first = f['origin']['restoredConfigurationProof']
        cases = []
        for key, wrong in (('kind', 'OLD_FULL_HASH_WITNESS'), ('version', 2), ('version', True), ('extra', 'SECRET')):
            v = copy.deepcopy(first); v[key] = wrong; cases.append(v)
        v = copy.deepcopy(first); v['semantic']['sourceBindings']['expectedEnvironmentSha256'] = '9' * 64; cases.append(v)
        v = copy.deepcopy(first); v['semantic']['adminProjection']['projectedConfigurationSha256'] = '9' * 64; cases.append(v)
        v = copy.deepcopy(first); v['semantic']['producer']['helpers']['scripts/production-release/online-recharge-readonly.py'] = '9' * 64; cases.append(v)
        v = copy.deepcopy(first); v['semantic']['fixedRecovery']['recoveryMarkerSha256'] = '9' * 64; cases.append(v)
        for n in scope.PRESERVED:
            for key in scope.SERVICE_IDENTITY_KEYS:
                v = copy.deepcopy(first); v['semantic']['actual'][n][key] = 'SECRET'; cases.append(v)
        for value in cases:
            with self.subTest(index=cases.index(value)), self.assertRaises(RuntimeError):
                scope.validate_declaration_equivalence_proof(controller(), value)

    def test_pair_rejects_p1_wrong_phase_crossrun_drift_and_exactbyte_change(self):
        f = self.fixture(); first = f['origin']['restoredConfigurationProof']
        for phase in (True, False):
            one, two = copy.deepcopy(first), copy.deepcopy(f['second'])
            (one if phase else two)['measurement']['purpose'] = 'DEPLOYMENT_REMEASURE' if phase else 'INDEPENDENT_PREFLIGHT'
            with self.assertRaises(RuntimeError):scope.declaration_equivalence_pair_seal(controller(), one, two, f['preflight_raw'])
        for raw in (f['preflight_raw'] + b' ', b'{"pendingOnlineMigrationOrigin":null}',
                    b'{"x":1,"x":1}', b'x' * (256 * 1024 + 1)):
            with self.assertRaises(RuntimeError):scope.declaration_equivalence_pair_seal(controller(), first, f['second'], raw)
        changed = copy.deepcopy(f['second']); changed['semantic']['apiEquivalence']['rulesSha256'] = '9' * 64
        with self.assertRaises(RuntimeError):scope.declaration_equivalence_pair_seal(controller(), first, changed, f['preflight_raw'])

    def test_source_missing_archive_file_tree_helper_policy_or_anchor_blocks(self):
        f = self.fixture(); first = f['origin']['restoredConfigurationProof']
        for what in ('archive', 'file', 'tree', 'helper', 'policy', 'anchor'):
            x = copy.deepcopy(f)
            if what == 'archive':x['archive_bytes'] = None
            elif what == 'file':del x['historical_files']['firstFailure']
            elif what == 'tree':x['producer']['sourceTree'] = '9' * 40
            elif what == 'helper':x['producer']['helpers'][scope.DECLARATION_EQUIVALENCE_HELPERS[3]] = '9' * 64
            elif what == 'policy':x['historical_files']['recoveryPolicy'] = b'{}'
            else:x['historical_files']['workspaceRecordBytesSha256'] = b'{}'
            with self.subTest(what=what), self.assertRaises(RuntimeError):self.publication(x)

    def test_malformed_origin_or_proof_does_not_invoke_normal_gate(self):
        f = self.fixture()
        for value in (None, True, {'version': 3}, {**f['origin'], 'unknown': 'SECRET'}):
            x = copy.deepcopy(f);x['origin'] = value
            with self.assertRaises(RuntimeError):self.publication(x)

    def test_issuer_bootstrap_no_q_but_requires_actual_new_runtime_source_and_run(self):
        pub = self.publication(self.fixture())
        scope.declaration_equivalence_issuer_binding(controller(), pub, live_services=pub['afterServices'],
            live_configuration=pub['configurationAfter'], execution_producer=pub['producer'])
        for role in ('services', 'source', 'producer'):
            live, config, producer = copy.deepcopy(pub['afterServices']), copy.deepcopy(pub['configurationAfter']), copy.deepcopy(pub['producer'])
            if role == 'services':live['api']['containerId'] = '9' * 64
            elif role == 'source':config['compose.release.json'] = '9' * 64
            else:producer['workflowRunId'] = '70000000002'
            with self.assertRaises(RuntimeError):scope.declaration_equivalence_issuer_binding(controller(), pub,
                live_services=live, live_configuration=config, execution_producer=producer)
        with self.assertRaises(TypeError):scope.declaration_equivalence_issuer_binding(controller(), pub, trusted=True)

    def test_later_cold_missing_failed_crosscommand_or_bad_bytes_cannot_issue_q(self):
        pub = self.publication(self.fixture()); invocation = json.loads(self.invocation(pub))
        for role in ('missing', 'status', 'code', 'boolcode', 'command', 'output', 'proof'):
            v = copy.deepcopy(invocation)
            if role == 'missing':raw = None
            else:
                if role == 'status':v['Status'] = 'InProgress'
                elif role == 'code':v['ResponseCode'] = 1
                elif role == 'boolcode':v['ResponseCode'] = False
                elif role == 'command':v['CommandId'] = '00000000-0000-0000-0000-000000000003'
                elif role == 'output':v['StandardOutputContent'] = 'SECRET'
                else:
                    result = json.loads(v['StandardOutputContent']);result['declarationEquivalencePublication']['recordBytesSha256'] = '9' * 64
                    v['StandardOutputContent'] = json.dumps(result)
                raw = self.raw(v)
            with self.subTest(role=role), self.assertRaises(RuntimeError):scope.declaration_equivalence_receipt_binding(controller(), pub, raw,
                command_id='00000000-0000-0000-0000-000000000002', wire_decoder=self.decode_wire)

    def test_actual_wire_helper_roundtrip_preserves_invocation_bytes_and_rejects_bad_frames(self):
        wire = load('declaration_equivalence_receipt_wire_tests', 'api-admin-pending-receipt-wire.py')
        fixture = self.fixture(); pub = self.publication(fixture)
        invocation = json.loads(self.invocation(pub))
        receipt = json.loads(invocation['StandardOutputContent'])
        receipt['pendingOnlineMigrationOrigin'] = fixture['origin']
        invocation['StandardOutputContent'] = wire.receipt_output(receipt, scope='API_ADMIN_WORKSPACE')
        raw = self.raw(invocation); original = bytes(raw)
        command = '00000000-0000-0000-0000-000000000002'
        result = scope.declaration_equivalence_receipt_binding(controller(), pub, raw,
            command_id=command, wire_decoder=wire.decode_receipt_output)
        self.assertEqual(raw, original)
        self.assertEqual(result['recordBytesSha256'], self.sha(fixture['record_raw']))
        self.assertEqual(json.loads(raw)['StandardOutputContent'], invocation['StandardOutputContent'])
        for role in ('kind', 'length', 'hash', 'payload', 'extra', 'seal', 'unframed_declared'):
            value = copy.deepcopy(invocation); envelope = json.loads(value['StandardOutputContent'])
            if role == 'kind': envelope['kind'] = 'UNKNOWN_SECRET'
            elif role == 'length': envelope['decodedLength'] += 1
            elif role == 'hash': envelope['decodedSha256'] = '9' * 64
            elif role == 'payload': envelope['payload'] += '!'
            elif role == 'extra': envelope['SECRET'] = 'SECRET'
            elif role == 'seal':
                wrong = copy.deepcopy(receipt)
                wrong['declarationEquivalencePublication']['recordBytesSha256'] = '9' * 64
                value['StandardOutputContent'] = wire.receipt_output(wrong, scope='API_ADMIN_WORKSPACE')
            else: value['StandardOutputContent'] = json.dumps(receipt)
            if role not in ('seal', 'unframed_declared'):
                value['StandardOutputContent'] = json.dumps(envelope)
            with self.subTest(role=role), self.assertRaises(RuntimeError) as caught:
                scope.declaration_equivalence_receipt_binding(controller(), pub, self.raw(value),
                    command_id=command, wire_decoder=wire.decode_receipt_output)
            self.assertNotIn('SECRET', str(caught.exception))
        def malicious_decoder(unused, **kwargs):
            raise ValueError('SECRET_EXCEPTION')
        with self.assertRaisesRegex(RuntimeError, '^ONLINE_RECHARGE_DECLARATION_PROOF_INVALID$'):
            scope.declaration_equivalence_receipt_binding(controller(), pub, raw,
                command_id=command, wire_decoder=malicious_decoder)
        with self.assertRaises(TypeError):
            scope.declaration_equivalence_receipt_binding(controller(), pub, raw, command_id=command)

    def test_successor_b_uses_a_after_and_new_run_without_new_p2(self):
        f = self.fixture();pub = self.publication(f)
        context = copy.deepcopy(f['origin']);context['services'] = pub['afterServices']
        context['priorPublications'] = [{'release': '/synthetic/A', 'commit': self.commit, 'sourceTree': self.tree,
            'manifestSha256': pub['manifestBytesSha256'], 'recordSha256': pub['recordBytesSha256'],
            'buildProofSha256': pub['buildProofCanonicalSha256']}]
        producer = copy.deepcopy(f['producer']);producer['workflowRunId'] = '70000000002'
        before = {'mode': 'preflight', 'status': 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED', 'commit': self.commit,
            'releaseCandidateCommit': producer['commit'], 'workflowRunId': producer['workflowRunId'], 'workflowRunAttempt': '1',
            'services': pub['afterServices'], 'pendingOnlineMigrationOrigin': context}
        kwargs = {'initial_origin': f['origin'], 'initial_publication': pub, 'current_producer': producer,
            'current_services': pub['afterServices'], 'current_archive_bytes': self.archive,
            'initial_invocation_raw': self.invocation(pub), 'initial_command_id': '00000000-0000-0000-0000-000000000002',
            'wire_decoder': self.decode_wire}
        result = scope.declaration_equivalence_successor_preflight_binding(controller(), self.raw(before), **kwargs)
        self.assertEqual(result['initialProofSha256'], scope.fingerprint(context['restoredConfigurationProof']))
        for role in ('run', 'oldstates', 'prior', 'q'):
            x = copy.deepcopy(before);values = copy.deepcopy(kwargs)
            if role == 'run':x['workflowRunId'] = '70000000001'
            elif role == 'oldstates':x['services'] = f['origin']['services']
            elif role == 'prior':x['pendingOnlineMigrationOrigin']['priorPublications'][0]['buildProofSha256'] = '9' * 64
            else:values['initial_invocation_raw'] = None
            with self.assertRaises(RuntimeError):scope.declaration_equivalence_successor_preflight_binding(controller(), self.raw(x), **values)

    def assert_extract_source_permission_hardening(self, original, current):
        import ast
        # The only admitted delta is this exact loop after archive validation
        # and immediately before extraction. All original predicates, limits,
        # arguments, relocation and returned archive bytes remain exact.
        expected = copy.deepcopy(original)
        archives = [node for node in ast.walk(expected) if isinstance(node, ast.With)
            and any(isinstance(item.optional_vars, ast.Name) and item.optional_vars.id == 'archive'
                    for item in node.items)]
        self.assertEqual(len(archives), 1)
        extraction = ast.dump(ast.parse('archive.extractall(target)').body[0])
        positions = [index for index, node in enumerate(archives[0].body) if ast.dump(node) == extraction]
        self.assertEqual(len(positions), 1)
        archives[0].body.insert(positions[0], ast.parse(
            'for member in entries:\n'
            '    member.mode &= ~0o022\n').body[0])
        self.assertEqual(ast.dump(expected), ast.dump(current))

    def test_extract_source_permission_witness_rejects_other_semantic_changes(self):
        import ast
        old_commit = 'd8466a58cc577ed83189503f260a9c914fcac3be'
        old = ast.parse(subprocess.check_output(['git', 'show',
            old_commit + ':scripts/production-release/online-recharge-scope.py'], cwd=ROOT))
        original = next(node for node in old.body if isinstance(node, ast.FunctionDef)
                        and node.name == 'extract_source')
        source = (ROOT / 'scripts/production-release/online-recharge-scope.py').read_text()
        current = next(node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef)
                       and node.name == 'extract_source')
        self.assert_extract_source_permission_hardening(original, current)
        source = ast.get_source_segment(source, current)
        loop = '        for member in entries:\n            member.mode &= ~0o022\n'
        mutations = (
            ('wider-mask', '~0o022', '0o755'),
            ('group-write-retained', '~0o022', '~0o002'),
            ('wrong-member-field', 'member.mode &=', 'member.uid &='),
            ('wrong-operation', 'member.mode &=', 'member.mode |='),
            ('partial-members', 'for member in entries:', 'for member in entries[:1]:'),
            ('missing-loop', loop, ''),
            ('duplicate-loop', loop, loop + loop),
            ('late-loop', loop + '        archive.extractall(target)\n',
                '        archive.extractall(target)\n' + loop),
            ('extra-loop-body', 'member.mode &= ~0o022', 'member.mode &= ~0o022\n            member.uid = 0'),
            ('size-limit', 'len(data) <= 128 * 1024 * 1024', 'len(data) <= 256 * 1024 * 1024'),
            ('entry-type-guard', '(m.isfile() or m.isdir())', 'True'),
            ('extraction-target', 'archive.extractall(target)', 'archive.extractall(target.parent)'),
            ('returned-bytes', 'return data', 'return b""'),
        )
        for role, before, after in mutations:
            with self.subTest(role=role):
                self.assertEqual(source.count(before), 1)
                mutated = ast.parse(source.replace(before, after)).body[0]
                with self.assertRaises(AssertionError):
                    self.assert_extract_source_permission_hardening(original, mutated)

    def test_old_all_functions_classes_and_constants_remain_exact_ast(self):
        import ast
        # The preservation witness is the reviewed pre-capability baseline.
        # HEAD is the fixture's producer archive and changes after committing.
        old_commit = 'd8466a58cc577ed83189503f260a9c914fcac3be'
        old = ast.parse(subprocess.check_output(['git', 'show', old_commit + ':scripts/production-release/online-recharge-scope.py'], cwd=ROOT))
        current = ast.parse((ROOT / 'scripts/production-release/online-recharge-scope.py').read_text())
        by_name = {}
        for item in current.body:
            if isinstance(item, (ast.FunctionDef, ast.ClassDef)):
                # The initial bodies are retained and captured by the finite
                # same-candidate adapter; compare these original bodies.
                by_name.setdefault(item.name,item)
        for node in old.body:
            if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
                actual = copy.deepcopy(by_name[node.name])
                if node.name == 'extract_source':
                    self.assert_extract_source_permission_hardening(node, actual)
                    continue
                if node.name == 'measure_declaration_equivalence':
                    # This previously closed stub is the sole replaced entry.
                    # Its ABI and two purpose/input guards remain exact; the
                    # source-bound delegate is exercised below with the reviewed singleton.
                    self.assertEqual(ast.dump(node.args), ast.dump(actual.args))
                    self.assertEqual([ast.dump(n) for n in node.body[1:3]],
                                     [ast.dump(n) for n in actual.body[1:3]])
                    continue
                if node.name == 'declaration_equivalence_materials':
                    # Only three fixed actually-executed capabilities are added;
                    # all historical/owner/path/version predicates stay exact.
                    previous_names = next(n for n in node.body if isinstance(n, ast.Assign)
                                          and isinstance(n.targets[0], ast.Name) and n.targets[0].id == 'names')
                    current_names = next(n for n in actual.body if isinstance(n, ast.Assign)
                                         and isinstance(n.targets[0], ast.Name) and n.targets[0].id == 'names')
                    self.assertEqual([ast.dump(n) for n in current_names.value.elts],
                        [ast.dump(n) for n in previous_names.value.elts] + [ast.dump(ast.Constant(value='scripts/production-release/' + name))
                            for name in ('online-recharge-daemon-identity.py', 'online-recharge-daemon-listener.py',
                                         'online-recharge-daemon-socket.py')])
                    current_names.value = previous_names.value
                if node.name == 'protected_source':
                    expected_worker = ast.parse(
                        'if not _workspace_reviewed_worker_protected(d, previous, target, worker):\n'
                        '    d.require(inventory(previous, worker) == inventory(target, worker), '\
                        "'ONLINE_RECHARGE_LEGACY_SOURCE_CHANGED')\n").body[0]
                    workers = [item for item in ast.walk(actual)
                        if isinstance(item, ast.If) and isinstance(item.test, ast.UnaryOp)
                        and isinstance(item.test.operand, ast.Call)
                        and isinstance(item.test.operand.func, ast.Name)
                        and item.test.operand.func.id == '_workspace_reviewed_worker_protected']
                    self.assertEqual(len(workers), 1)
                    self.assertEqual(ast.dump(workers[0]), ast.dump(expected_worker))
                    replacements = 0
                    for parent in ast.walk(actual):
                        for _, items in ast.iter_fields(parent):
                            if isinstance(items, list) and workers[0] in items:
                                items[items.index(workers[0])] = copy.deepcopy(workers[0].body[0])
                                replacements += 1
                    self.assertEqual(replacements, 1)
                    # The B-only bank source adapter wraps the original grant
                    # check. Admit exactly this guard, then compare every
                    # historical predicate and fallback body unchanged.
                    expected_guard = ast.parse(
                        'if not _workspace_bank_policy_protected(d, previous, target):\n'
                        '    grant_source_change(d, previous, target)\n').body[0]
                    guards = [item for item in ast.walk(actual)
                        if isinstance(item, ast.If) and isinstance(item.test, ast.UnaryOp)
                        and isinstance(item.test.operand, ast.Call)
                        and isinstance(item.test.operand.func, ast.Name)
                        and item.test.operand.func.id == '_workspace_bank_policy_protected']
                    self.assertEqual(len(guards), 1)
                    guard = guards[0]
                    self.assertEqual(ast.dump(guard), ast.dump(expected_guard))
                    replacements = 0
                    for parent in ast.walk(actual):
                        for _, items in ast.iter_fields(parent):
                            if isinstance(items, list) and guard in items:
                                items[items.index(guard)] = copy.deepcopy(guard.body[0])
                                replacements += 1
                    self.assertEqual(replacements, 1)
                self.assertEqual(ast.dump(node), ast.dump(actual))
        old_assigns = [ast.dump(n) for n in old.body if isinstance(n, ast.Assign)]
        current_assigns = [ast.dump(n) for n in current.body if isinstance(n, ast.Assign)
                           and not any(isinstance(t, ast.Name) and t.id == 'FORMAL_RUNTIME_DRIVER_SHA256'
                                       for t in n.targets)]
        self.assertEqual(current_assigns[:len(old_assigns)], old_assigns)


class DeclarationEquivalenceMaterialsTests(unittest.TestCase):
    """Real temporary Git/helper bytes; synthetic historical files and F/Q only.

    The fixed 641 policy and two canonical failure models are reused. These
    fixtures never claim an actual producer, AWS command, or production proof.
    """
    @classmethod
    def setUpClass(cls):
        DeclarationEquivalencePureTests.setUpClass()
        cls.pure = DeclarationEquivalencePureTests('test_structure_pair_real_git_and_synthetic_artifact_bindings')
        cls.fixture = cls.pure.fixture()
        cls.history = copy.deepcopy(cls.fixture['historical_files'])
        cls.policy = copy.deepcopy(DeclarationEquivalencePureTests.policy)
        cls.history['restoredBuildProofBytesSha256'] = cls.pure.raw(cls.policy['restoredAttempt']['buildProof'])
        cls.output = ROOT / '.runtime/online-recharge-release-20261009/build/declaration-materials-tests'
        cls.output.mkdir(parents=True, exist_ok=True)
        cls.class_temp = tempfile.TemporaryDirectory(prefix='git-fixture-', dir=cls.output)
        cls.repo = Path(cls.class_temp.name)
        cls.names = (*scope.DECLARATION_EQUIVALENCE_HELPERS,
            'scripts/production-release/online-recharge-declaration-measurement.py',
            'scripts/production-release/api-admin-pending-receipt-wire.py',
            'scripts/production-release/online-recharge-daemon-identity.py',
            'scripts/production-release/online-recharge-daemon-listener.py',
            'scripts/production-release/online-recharge-daemon-socket.py')
        cls.helper_bytes = {name: (ROOT / name).read_bytes() for name in cls.names}
        cls.commit, cls.tree, cls.archive = cls.make_archive(cls.repo, cls.helper_bytes)
        cls.inventory = scope.archive_inventory(controller(), cls.archive, cls.commit, cls.tree)
        cls.wire = load('materials_actual_wire_tests', 'api-admin-pending-receipt-wire.py')
        cls.identity_reader = staticmethod(scope._declaration_instance_id)

    @classmethod
    def tearDownClass(cls):
        cls.class_temp.cleanup()

    @classmethod
    def make_archive(cls, directory, helpers):
        directory.mkdir(parents=True, exist_ok=True)
        for name, raw in {**helpers, 'scripts/production-release/online-recharge-recovery.json': cls.history['recoveryPolicy']}.items():
            path = directory / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(raw)
        def git(*args):
            return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null',
                '-c', 'commit.gpgsign=false', '-c', 'user.name=Local Synthetic Fixture',
                '-c', 'user.email=fixture@example.invalid', *args], cwd=directory, stderr=subprocess.DEVNULL)
        git('init', '-q'); git('add', 'scripts')
        git('commit', '-q', '-m', 'Local synthetic helper source fixture')
        commit = git('rev-parse', 'HEAD').decode().strip(); tree = git('rev-parse', 'HEAD^{tree}').decode().strip()
        archive = git('archive', '--format=tar.gz', '--prefix=id-business-system-' + commit + '/', commit)
        return commit, tree, archive

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='materials-', dir=self.output)
        self.base = Path(self.temp.name); self.d = controller(BASE=self.base,
            run=MagicMock(side_effect=AssertionError('COLD_RUNTIME_ACCESS_FORBIDDEN')),
            service_state=MagicMock(side_effect=AssertionError('COLD_RETIRED_INSPECT_FORBIDDEN')))
        releases = self.base / 'releases'; releases.mkdir(mode=0o700)
        self.previous = releases / ('20261010T000000Z-' + scope.BASELINE_COMMIT[:12])
        self.first = releases / ('20261010T000000Z-' + scope.RECOVERY_COMMIT[:12])
        self.second = releases / ('20261010T000000Z-' + scope.RESTORED_COMMIT[:12])
        for folder in (self.previous, self.first, self.second): folder.mkdir(mode=0o700)
        self.paths = {
            'workspaceManifestBytesSha256': self.previous / 'release-manifest.json',
            'workspaceRecordBytesSha256': self.previous / shared.STATE_FILE,
            'workspaceBuildProofBytesSha256': self.previous / shared.PROOF_FILE,
            'restoredManifestBytesSha256': self.second / 'release-manifest.json',
            'restoredRecordBytesSha256': self.second / scope.STATE_FILE,
            'restoredBuildProofBytesSha256': self.second / scope.PROOF_FILE,
            'firstFailure': self.first / scope.FAILURE_FILE, 'secondFailure': self.second / scope.FAILURE_FILE}
        for name, path in self.paths.items(): self.write(path, self.history[name])
        self.helpers = self.base / 'executing-helpers'; self.helpers.mkdir(mode=0o700)
        for name, raw in self.helper_bytes.items(): self.write(self.helpers / Path(name).name, raw)
        self.write(self.helpers / scope.RECOVERY_FILE, self.history['recoveryPolicy'])
        old_files = {self.paths[name].name: self.pure.sha(self.history[name]) for name in
            ('workspaceManifestBytesSha256', 'workspaceRecordBytesSha256', 'workspaceBuildProofBytesSha256')}
        old_files.update({name: self.pure.sha(('SYNTHETIC:' + name).encode()) for name in
                          ('backup-verification.json', 'before-audit.json', 'after-audit.json')})
        self.recovery = {'source': self.first, 'policy': copy.deepcopy(self.policy),
            'marker': scope.recovery_marker(self.policy), 'restored': {'source': self.second,
                'manifestSha256': self.pure.sha(self.history['restoredManifestBytesSha256']),
                'recordSha256': self.pure.sha(self.history['restoredRecordBytesSha256']),
                'workspaceOriginFiles': old_files}}
        self.producer = {'commit': self.commit, 'sourceTree': self.tree,
                         'workflowRunId': '80000000001', 'workflowRunAttempt': '1'}
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(scope, '__file__', str(self.helpers / 'online-recharge-scope.py')))
        self.download = self.stack.enter_context(patch.object(scope.urllib.request, 'urlopen',
            side_effect=lambda *args, **kwargs: io.BytesIO(self.archive)))
        self.instance_id = 'i-0123456789abcdef0'
        self.identity = self.stack.enter_context(patch.object(scope, '_declaration_instance_id',
            return_value=self.instance_id))
        self.stack.enter_context(patch.object(scope.urllib.request, 'build_opener',
            side_effect=AssertionError('UNMOCKED_METADATA_NETWORK_FORBIDDEN')))

    def tearDown(self):
        self.stack.close(); self.temp.cleanup()

    @staticmethod
    def write(path, raw):
        path.write_bytes(raw); path.chmod(0o600)

    def materials(self, phase='LIVE', **changes):
        return scope.declaration_equivalence_materials(self.d, changes.get('directory', self.previous),
            changes.get('recovery', self.recovery), producer=changes.get('producer', self.producer), phase=phase)

    def artifact_folder(self, producer=None):
        p = producer or self.producer
        folder = self.base / '.staging' / ('api-workspace-preflight-' + p['commit'] + '-'
            + p['workflowRunId'] + '-' + p['workflowRunAttempt'])
        folder.mkdir(parents=True, mode=0o700, exist_ok=True); folder.chmod(0o700)
        return folder

    def preflight(self):
        value = json.loads(self.fixture['preflight_raw'])
        value.update(releaseCandidateCommit=self.producer['commit'], workflowRunId=self.producer['workflowRunId'],
                     workflowRunAttempt=self.producer['workflowRunAttempt'])
        raw = self.pure.raw(value); path = self.artifact_folder() / 'api-workspace-preflight-result.json'
        self.write(path, raw); return path, raw

    def invocation(self):
        publication = self.pure.publication(self.fixture)
        value = json.loads(self.pure.invocation(publication)); receipt = json.loads(value['StandardOutputContent'])
        receipt['pendingOnlineMigrationOrigin'] = self.fixture['origin']
        value['StandardOutputContent'] = self.wire.receipt_output(receipt, scope='API_ADMIN_WORKSPACE') + '\n'
        value['StandardErrorContent'] = ''
        value.update(InstanceId=self.instance_id, DocumentName='AWS-RunShellScript',
            PluginName='aws:runShellScript', ExecutionEndDateTime='2026-01-01T00:00:00Z')
        raw = self.pure.raw(value); path = self.artifact_folder() / 'api-workspace-readback-invocation.json'
        self.write(path, raw); return path, raw, publication

    def test_live_acquires_real_git_tree_and_exact_executing_six_helper_bytes(self):
        result = self.materials()
        self.assertEqual(result['archive_bytes'], self.archive)
        self.assertEqual(result['historical_files'], self.history)
        self.assertEqual(result['producer']['archiveInventorySha256'], scope.fingerprint(self.inventory))
        self.assertEqual(result['producer']['helpers'], {n: self.inventory[n]['sha256'] for n in scope.DECLARATION_EQUIVALENCE_HELPERS})
        self.download.assert_called_once_with('https://github.com/wangchaozhuanyong/id-business-system/archive/'
                                              + self.commit + '.tar.gz', timeout=60)
        self.d.run.assert_not_called(); self.d.service_state.assert_not_called()

    def test_live_cache_rechecks_executing_helper_tamper_and_missing_file(self):
        self.materials(); helper = self.helpers / 'online-recharge-declaration-measurement.py'
        original = helper.read_bytes(); self.write(helper, original + b'\n# LOCAL_SYNTHETIC_TAMPER\n')
        with self.assertRaises(RuntimeError): self.materials()
        self.download.assert_called_once()
        self.write(helper, original); helper.unlink()
        with self.assertRaises(OSError): self.materials()

    def test_archive_wrong_tree_and_missing_required_helper_cannot_claim_source(self):
        with self.assertRaises(RuntimeError): self.materials(producer={**self.producer, 'sourceTree': '9' * 40})
        missing = {n: raw for n, raw in self.helper_bytes.items() if not n.endswith('/api-admin-readonly.py')}
        commit, tree, archive = self.make_archive(self.base / 'missing-helper-git', missing)
        with patch.object(scope.urllib.request, 'urlopen', side_effect=lambda *a, **k: io.BytesIO(archive)):
            with self.assertRaises(RuntimeError): self.materials(producer={**self.producer, 'commit': commit, 'sourceTree': tree})

    def test_historical_source_drift_rejects_every_role_without_rewriting_capture(self):
        for name in (*self.paths, 'recoveryPolicy'):
            path = self.paths.get(name, self.helpers / scope.RECOVERY_FILE); original = path.read_bytes()
            changed = json.loads(original); changed['LOCAL_SYNTHETIC_EXTRA'] = True
            self.write(path, self.pure.raw(changed))
            with self.subTest(role=name), self.assertRaises(RuntimeError): self.materials()
            self.write(path, original)

    def test_private_fixed_directories_and_closed_producer_are_required(self):
        for folder in (self.previous, self.first, self.second):
            folder.chmod(0o750)
            with self.assertRaises(RuntimeError): self.materials()
            folder.chmod(0o700)
        alias = self.base / 'alias'; alias.symlink_to(self.previous)
        with self.assertRaises(RuntimeError): self.materials(directory=alias)
        for producer in ({**self.producer, 'workflowRunAttempt': True}, {**self.producer, 'trusted': True}):
            with self.assertRaises(RuntimeError): self.materials(producer=producer)
        with self.assertRaises(RuntimeError): self.materials(phase='UNREVIEWED')

    def test_cold_uses_real_archive_and_private_history_without_retired_runtime_reads(self):
        (self.helpers / 'api-admin-readonly.py').unlink()
        with patch.object(scope, 'snapshot', side_effect=AssertionError('COLD_SNAPSHOT_FORBIDDEN')):
            result = self.materials('COLD')
        self.assertEqual(result['archive_bytes'], self.archive)
        self.assertEqual(result['historical_files'], self.history)
        self.d.run.assert_not_called(); self.d.service_state.assert_not_called()

    def test_preflight_exact_bytes_sha_and_run_metadata_bound(self):
        path, raw = self.preflight()
        self.assertEqual(scope.declaration_equivalence_preflight_bytes(self.d, producer=self.producer,
                         expected_sha=self.pure.sha(raw)), raw)
        with self.assertRaises(RuntimeError): scope.declaration_equivalence_preflight_bytes(self.d,
            producer=self.producer, expected_sha='9' * 64)
        wrong = json.loads(raw); wrong['workflowRunId'] = '80000000002'; changed = self.pure.raw(wrong); self.write(path, changed)
        with self.assertRaises(RuntimeError): scope.declaration_equivalence_preflight_bytes(self.d,
            producer=self.producer, expected_sha=self.pure.sha(changed))
        self.write(path, raw)
        with self.assertRaises((OSError, RuntimeError)): scope.declaration_equivalence_preflight_bytes(self.d,
            producer={**self.producer, 'workflowRunAttempt': '2'}, expected_sha=self.pure.sha(raw))

    def test_private_f_and_q_files_reject_mode_symlink_and_hardlink(self):
        for filename in ('api-workspace-preflight-result.json', 'api-workspace-readback-invocation.json'):
            folder = self.artifact_folder(); path = folder / filename; self.write(path, b'{}')
            path.chmod(0o644)
            with self.assertRaises(RuntimeError): scope._declaration_saved_artifact(self.d, self.producer, filename)
            path.chmod(0o600); alias = folder / 'link'; os.link(path, alias)
            with self.assertRaises(RuntimeError): scope._declaration_saved_artifact(self.d, self.producer, filename)
            alias.unlink(); path.unlink(); path.symlink_to(self.helpers / scope.RECOVERY_FILE)
            with self.assertRaises(RuntimeError): scope._declaration_saved_artifact(self.d, self.producer, filename)
            path.unlink()
        path, raw = self.preflight(); path.parent.chmod(0o750)
        with self.assertRaises(RuntimeError): scope.declaration_equivalence_preflight_bytes(self.d,
            producer=self.producer, expected_sha=self.pure.sha(raw))

    def test_q_loader_keeps_raw_framed_stdout_bytes_for_independent_decoder(self):
        path, raw, publication = self.invocation()
        result = scope.declaration_equivalence_saved_invocation(self.d, producer=self.producer)
        self.assertEqual(result['raw_bytes'], raw); self.assertEqual(path.read_bytes(), raw)
        bound = scope.declaration_equivalence_receipt_binding(self.d, publication, result['raw_bytes'],
            command_id=result['command_id'], wire_decoder=self.wire.decode_receipt_output)
        self.assertEqual(bound['readbackCommandId'], '00000000-0000-0000-0000-000000000002')

    def test_q_failed_boolean_code_stderr_or_crossrun_rejects(self):
        path, raw, _publication = self.invocation()
        for key, value in (('Status', 'Failed'), ('ResponseCode', False),
                           ('StandardErrorContent', 'LOCAL_SYNTHETIC_PRIVATE_SENTINEL'), ('CommandId', 'invalid')):
            changed = json.loads(raw); changed[key] = value; self.write(path, self.pure.raw(changed))
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                scope.declaration_equivalence_saved_invocation(self.d, producer=self.producer)
        self.write(path, raw)
        with self.assertRaises((OSError, RuntimeError)): scope.declaration_equivalence_saved_invocation(self.d,
            producer={**self.producer, 'workflowRunId': '80000000002'})

    def test_q_completion_metadata_is_bound_to_actual_host_and_utc_completion(self):
        import datetime
        path, raw, _publication = self.invocation()
        future = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=1)).isoformat()
        invalid = [('InstanceId', 'i-11111111111111111'), ('InstanceId', None),
            ('DocumentName', 'LOCAL_SYNTHETIC_OTHER_DOCUMENT'), ('PluginName', 'otherPlugin'),
            ('ExecutionEndDateTime', future), ('ExecutionEndDateTime', '2026-01-01T00:00:00+08:00'),
            ('ExecutionEndDateTime', '2026-01-01T00:00:00'), ('ExecutionEndDateTime', '2026-99-99T00:00:00Z')]
        for key in ('InstanceId', 'DocumentName', 'PluginName', 'ExecutionEndDateTime'):
            changed = json.loads(raw); del changed[key]; self.write(path, self.pure.raw(changed))
            with self.subTest(missing=key), self.assertRaises(RuntimeError):
                scope.declaration_equivalence_saved_invocation(self.d, producer=self.producer)
        for key, value in invalid:
            changed = json.loads(raw); changed[key] = value; self.write(path, self.pure.raw(changed))
            with self.subTest(key=key, value_type=type(value).__name__), self.assertRaises((RuntimeError, ValueError)):
                scope.declaration_equivalence_saved_invocation(self.d, producer=self.producer)
        # A self-claimed host cannot replace the independently read instance ID.
        changed = json.loads(raw); changed['trustedInstanceId'] = changed['InstanceId']
        self.write(path, self.pure.raw(changed))
        with patch.object(scope, '_declaration_instance_id', return_value='i-11111111111111111'):
            with self.assertRaises(RuntimeError): scope.declaration_equivalence_saved_invocation(self.d, producer=self.producer)
        changed = json.loads(raw); changed['ExecutionEndDateTime'] = '2026-01-01T00:00:00+00:00'
        self.write(path, self.pure.raw(changed))
        self.assertEqual(scope.declaration_equivalence_saved_invocation(self.d, producer=self.producer)['raw_bytes'], path.read_bytes())
        self.identity.assert_called()

    def test_imdsv2_uses_fixed_local_endpoint_without_proxy_or_redirect(self):
        token = b'LOCAL_SYNTHETIC_PUBLIC_TOKEN'
        opener = MagicMock(); opener.open.side_effect = [io.BytesIO(token), io.BytesIO(self.instance_id.encode())]
        with patch.object(scope.urllib.request, 'build_opener', return_value=opener) as build:
            self.assertEqual(self.identity_reader(), self.instance_id)
        handlers = build.call_args.args
        self.assertEqual(handlers[0].proxies, {})
        self.assertIsInstance(handlers[1], scope.urllib.request.HTTPRedirectHandler)
        self.assertIsNone(handlers[1].redirect_request(None, None, 302, None, None, 'https://example.invalid'))
        first, second = opener.open.call_args_list
        self.assertEqual(first.args[0].full_url, 'http://169.254.169.254/latest/api/token')
        self.assertEqual(first.args[0].method, 'PUT')
        self.assertEqual(first.args[0].get_header('X-aws-ec2-metadata-token-ttl-seconds'), '60')
        self.assertEqual(first.kwargs, {'timeout': 3})
        self.assertEqual(second.args[0].full_url, 'http://169.254.169.254/latest/meta-data/instance-id')
        self.assertEqual(second.args[0].get_header('X-aws-ec2-metadata-token'), token.decode())
        self.assertEqual(second.kwargs, {'timeout': 3})
        for bad_token in (b'', b'x' * 4097, b'a\n', b'a\r', b'\xff'):
            opener = MagicMock(); opener.open.side_effect = [io.BytesIO(bad_token), io.BytesIO(self.instance_id.encode())]
            with patch.object(scope.urllib.request, 'build_opener', return_value=opener):
                with self.subTest(token_length=len(bad_token)), self.assertRaises((RuntimeError, UnicodeDecodeError)):
                    self.identity_reader()
            self.assertEqual(opener.open.call_count, 1)
        for bad_id in (b'LOCAL_SYNTHETIC_PRIVATE_SENTINEL', b'i-0123456789abcdef0\n', b'i-' + b'a' * 18, b'x' * 129):
            opener = MagicMock(); opener.open.side_effect = [io.BytesIO(token), io.BytesIO(bad_id)]
            with patch.object(scope.urllib.request, 'build_opener', return_value=opener):
                with self.subTest(id_length=len(bad_id)), self.assertRaisesRegex(RuntimeError, '^ONLINE_RECHARGE_DECLARATION_PROOF_INVALID$'):
                    self.identity_reader()

    def test_live_only_remote_source_may_use_two_mib_literal_limit(self):
        cases = [('remote-deploy.py', 2 * 1024 * 1024, True),
                 ('remote-deploy.py', 2 * 1024 * 1024 + 1, False),
                 ('api-admin-scope.py', 1024 * 1024 + 1, False)]
        for index, (name, length, allowed) in enumerate(cases):
            helpers = dict(self.helper_bytes); key = 'scripts/production-release/' + name
            helpers[key] += b'\n#' + b'x' * (length - len(helpers[key]) - 2)
            commit, tree, archive = self.make_archive(self.base / ('cap-git-' + str(index)), helpers)
            self.write(self.helpers / name, helpers[key])
            producer = {**self.producer, 'commit': commit, 'sourceTree': tree}
            with patch.object(scope.urllib.request, 'urlopen', side_effect=lambda *a, **k: io.BytesIO(archive)):
                if allowed:
                    with self.subTest(helper=name, length=length):
                        self.assertEqual(self.materials(producer=producer)['archive_bytes'], archive)
                else:
                    with self.subTest(helper=name, length=length), self.assertRaises(RuntimeError):
                        self.materials(producer=producer)
            self.write(self.helpers / name, self.helper_bytes[key])

    def test_source_bytes_exact_limit_soft_hard_link_fifo_and_owner_modes(self):
        path = self.base / 'ordinary'; self.write(path, b'LOCAL_SYNTHETIC_PUBLIC_BYTES')
        self.assertEqual(scope._declaration_source_bytes(path), path.read_bytes())
        alias = self.base / 'alias-file'; alias.symlink_to(path)
        with self.assertRaises(RuntimeError): scope._declaration_source_bytes(alias)
        alias.unlink(); os.link(path, alias)
        with self.assertRaises(RuntimeError): scope._declaration_source_bytes(path)
        alias.unlink(); path.chmod(0o666)
        with self.assertRaises(RuntimeError): scope._declaration_source_bytes(path)
        path.chmod(0o600)
        with patch.object(scope.os, 'geteuid', return_value=os.geteuid() + 1):
            with self.assertRaises(RuntimeError): scope._declaration_source_bytes(path)
        fifo = self.base / 'fifo'; os.mkfifo(fifo, 0o600)
        with patch.object(scope.os, 'open', side_effect=AssertionError('FIFO_MUST_NOT_OPEN')):
            with self.assertRaises(RuntimeError): scope._declaration_source_bytes(fifo)
        path.write_bytes(b'x' * (2 * 1024 * 1024)); path.chmod(0o600)
        self.assertEqual(len(scope._declaration_source_bytes(path, limit=2 * 1024 * 1024)), 2 * 1024 * 1024)
        with self.assertRaises(RuntimeError): scope._declaration_source_bytes(path, limit=1024 * 1024)
        path.write_bytes(b'x' * (2 * 1024 * 1024 + 1))
        with self.assertRaises(RuntimeError): scope._declaration_source_bytes(path, limit=2 * 1024 * 1024)

    def test_source_bytes_real_inode_replacement_after_open_rejects(self):
        path = self.base / 'ordinary'; self.write(path, b'LOCAL_SYNTHETIC_PUBLIC_BYTES')
        replacement = self.base / 'replacement'; self.write(replacement, path.read_bytes())
        original_open = os.open
        def replace_after_open(filename, flags):
            self.assertTrue(flags & os.O_NOFOLLOW); self.assertTrue(flags & os.O_NONBLOCK)
            descriptor = original_open(filename, flags); os.replace(replacement, path); return descriptor
        with patch.object(scope.os, 'open', side_effect=replace_after_open):
            with self.assertRaises(RuntimeError): scope._declaration_source_bytes(path)

    def test_reviewed_source_still_requires_archive_and_runtime_authority(self):
        for purpose, raw in (('INDEPENDENT_PREFLIGHT', None), ('DEPLOYMENT_REMEASURE', b'{}')):
            # This test's synthetic helper directory still has no trusted package.
            with self.assertRaisesRegex(RuntimeError, '^ONLINE_RECHARGE_DECLARATION_DRIVER_UNAVAILABLE$'):
                scope.measure_declaration_equivalence(self.d, self.previous, self.recovery,
                    producer=self.producer, purpose=purpose, preflight_raw=raw)
            with patch.object(scope, '__file__', str(ROOT / 'scripts/production-release/online-recharge-scope.py')):
                driver = scope._declaration_runtime_driver()
                selected = driver._local_package().load_leaf('qualified.py')
                self.assertEqual(len(selected.REVIEWED_SOURCE_TABLE), 1); selected._reviewed_profile()
                # Root entry is simulated only after ordinary bytes are owner-verified.
                with patch.object(scope, '_declaration_runtime_driver', return_value=driver), \
                        patch.object(scope.os, 'geteuid', return_value=0), \
                        patch.object(scope.urllib.request, 'urlopen', side_effect=RuntimeError('SYNTHETIC_ARCHIVE_UNAVAILABLE')) as archive:
                    with self.assertRaisesRegex(RuntimeError, '^ONLINE_RECHARGE_DECLARATION_DRIVER_UNAVAILABLE$'):
                        scope.measure_declaration_equivalence(self.d, self.previous, self.recovery,
                            producer=self.producer, purpose=purpose, preflight_raw=raw)
                    archive.assert_called_once()
        self.d.run.assert_not_called(); self.download.assert_not_called()


class DeclarationSuccessorPureTests(unittest.TestCase):
    """Synthetic A/B artifacts, real immutable source; no production authority."""
    @classmethod
    def setUpClass(cls):
        DeclarationEquivalencePureTests.setUpClass()
        cls.pure = DeclarationEquivalencePureTests()
        cls.wire = load('successor_actual_wire', 'api-admin-pending-receipt-wire.py')

    def fixture(self):
        f = self.pure.fixture(); a = self.pure.publication(f)
        origin = copy.deepcopy(f['origin']); origin['services'] = a['afterServices']
        origin['priorPublications'] = [{'release': '/synthetic/A', 'commit': a['producer']['commit'],
            'sourceTree': a['producer']['sourceTree'], 'manifestSha256': a['manifestBytesSha256'],
            'recordSha256': a['recordBytesSha256'], 'buildProofSha256': a['buildProofCanonicalSha256']}]
        producer = copy.deepcopy(f['producer']); producer['workflowRunId'] = '70000000002'
        before = {'mode': 'preflight', 'commandId': '00000000-0000-0000-0000-000000000003',
            'status': 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED', 'commit': a['producer']['commit'],
            'releaseCandidateCommit': producer['commit'], 'workflowRunId': producer['workflowRunId'],
            'workflowRunAttempt': '1', 'services': a['afterServices'], 'pendingOnlineMigrationOrigin': origin}
        raw = self.pure.raw(before)
        inputs = {'initial_origin': f['origin'], 'initial_publication': a, 'current_producer': producer,
            'current_services': a['afterServices'], 'current_configuration': a['configurationAfter'],
            'current_archive_bytes': f['archive_bytes'], 'initial_invocation_raw': self.pure.invocation(a),
            'initial_command_id': '00000000-0000-0000-0000-000000000002', 'wire_decoder': self.wire.decode_receipt_output}
        seal = scope.declaration_equivalence_successor_seal(controller(), raw, **inputs)
        build = json.loads(f['build_raw']); build.update(version=2, pendingOnlineOriginSha256=scope.fingerprint(origin),
            pendingOnlinePreflightSha256=self.pure.sha(raw))
        after = copy.deepcopy(a['afterServices'])
        for name in ('api', 'admin'): after[name]['containerId'] = self.pure.sha(('B-' + name).encode())
        record = {'before': a['afterServices'], 'after': after, 'configurationBefore': a['configurationAfter'],
            'configurationAfter': a['configurationAfter'], 'pendingOnlineMigrationOrigin': origin,
            'pendingOnlineSuccessorPreflight': seal}
        manifest = {'commit': producer['commit'], 'sourceTree': producer['sourceTree'],
            'pendingOnlineMigration': {'originSha256': scope.fingerprint(origin), 'successorConfigurationSeal': seal}}
        return {'origin': origin, 'preflight_raw': raw, 'build_raw': self.pure.raw(build),
            'record_raw': self.pure.raw(record), 'manifest_raw': self.pure.raw(manifest), **inputs}

    def test_distinct_b_kind_inherits_real_byte_a_seal_without_p2_b(self):
        f = self.fixture(); unchanged = copy.deepcopy(f)
        b = scope.declaration_equivalence_successor_publication_binding(controller(), **f)
        self.assertEqual(f, unchanged)
        self.assertEqual((b['kind'], b['version']), (scope.DECLARATION_SUCCESSOR_KIND, 1))
        self.assertEqual(b['successorConfigurationSeal']['initialReadbackInvocationBytesSha256'],
                         self.pure.sha(f['initial_invocation_raw']))
        self.assertEqual(b['successorConfigurationSeal']['initialPublication']['configurationEquivalenceSeal'],
                         f['initial_publication']['configurationEquivalenceSeal'])
        with self.assertRaises(RuntimeError): scope.declaration_equivalence_issuer_binding(controller(), b,
            live_services=b['afterServices'], live_configuration=b['configurationAfter'], execution_producer=b['producer'])

    def test_stale_cross_run_missing_a_q_and_source_artifact_drift_reject(self):
        for change in ('q', 'fb-run', 'helpers', 'configuration', 'old-states', 'third', 'p2-b', 'state-seal', 'old-f', 'kind'):
            with self.subTest(change=change):
                f = self.fixture()
                if change == 'q': f['initial_invocation_raw'] = None
                elif change == 'fb-run':
                    before = json.loads(f['preflight_raw']); before['workflowRunId'] = '70000000001'; f['preflight_raw'] = self.pure.raw(before)
                elif change == 'helpers': f['current_producer']['helpers'][scope.DECLARATION_EQUIVALENCE_HELPERS[0]] = '0' * 64
                elif change == 'configuration': f['current_configuration']['compose.release.json'] = '0' * 64
                elif change == 'old-states': f['current_services'] = f['initial_origin']['services']
                elif change == 'third': f['origin']['priorPublications'].append(copy.deepcopy(f['origin']['priorPublications'][0]))
                elif change in ('p2-b', 'state-seal'):
                    record = json.loads(f['record_raw'])
                    if change == 'p2-b': record['pendingOnlineConfigurationMeasurement'] = f['origin']['restoredConfigurationProof']
                    else: record['pendingOnlineSuccessorPreflight']['initialReadbackInvocationBytesSha256'] = '0' * 64
                    f['record_raw'] = self.pure.raw(record)
                elif change == 'old-f':
                    build = json.loads(f['build_raw']); build['pendingOnlinePreflightSha256'] = f['initial_publication']['preflightBytesSha256']; f['build_raw'] = self.pure.raw(build)
                else:
                    manifest = json.loads(f['manifest_raw']); manifest['pendingOnlineMigration']['configurationEquivalenceSeal'] = {}; f['manifest_raw'] = self.pure.raw(manifest)
                with self.assertRaises(RuntimeError): scope.declaration_equivalence_successor_publication_binding(controller(), **f)

    def test_b_fixed_issuer_actual_wire_cold_and_malicious_receipts(self):
        f = self.fixture(); b = scope.declaration_equivalence_successor_publication_binding(controller(), **f)
        issued = scope.declaration_equivalence_successor_issuer_binding(controller(), b, live_services=b['afterServices'],
            live_configuration=b['configurationAfter'], execution_producer=b['producer'])
        command = '00000000-0000-0000-0000-000000000004'
        receipt = {'status': 'API_ADMIN_WORKSPACE_VERIFIED', 'pendingOnlineMigrationOrigin': f['origin'],
                   'declarationEquivalenceSuccessorPublication': issued}
        invocation = {'CommandId': command, 'Status': 'Success', 'ResponseCode': 0,
                      'StandardOutputContent': self.wire.receipt_output(receipt, scope='API_ADMIN_WORKSPACE')}
        raw = self.pure.raw(invocation)
        result = scope.declaration_equivalence_successor_receipt_binding(controller(), b, raw,
            command_id=command, wire_decoder=self.wire.decode_receipt_output)
        self.assertEqual(result['readbackCommandId'], command)
        for field in ('command', 'status', 'bool', 'initial-only', 'extra-seal', 'bad-wire', 'origin'):
            value = copy.deepcopy(invocation); output = copy.deepcopy(receipt)
            if field == 'command': value['CommandId'] = '00000000-0000-0000-0000-000000000099'
            elif field == 'status': value['Status'] = 'Failed'
            elif field == 'bool': value['ResponseCode'] = False
            elif field == 'initial-only': output = {'status': receipt['status'], 'declarationEquivalencePublication': issued}
            elif field == 'extra-seal': output['declarationEquivalenceSuccessorPublication']['trusted'] = True
            elif field == 'origin': output['pendingOnlineMigrationOrigin']['services']['api']['containerId'] = '0' * 64
            else: value['StandardOutputContent'] = 'SECRET_INVALID_FRAME'
            if field != 'bad-wire': value['StandardOutputContent'] = self.wire.receipt_output(output, scope='API_ADMIN_WORKSPACE')
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, '^ONLINE_RECHARGE_DECLARATION_PROOF_INVALID$'):
                scope.declaration_equivalence_successor_receipt_binding(controller(), b, self.pure.raw(value), command_id=command,
                    wire_decoder=self.wire.decode_receipt_output)
        wrong = copy.deepcopy(b['afterServices']); wrong['mysql']['containerId'] = '0' * 64
        with self.assertRaises(RuntimeError): scope.declaration_equivalence_successor_issuer_binding(controller(), b,
            live_services=wrong, live_configuration=b['configurationAfter'], execution_producer=b['producer'])

    def test_closed_b_schema_and_reused_preflight_command_cannot_issue(self):
        f = self.fixture(); b = scope.declaration_equivalence_successor_publication_binding(controller(), **f)
        for change in ('extra', 'bool', 'seal-extra', 'a-extra', 'unknown-kind', 'duplicate-command', 'producer-helpers'):
            value = copy.deepcopy(b)
            if change == 'extra': value['trusted'] = True
            elif change == 'bool': value['version'] = True
            elif change == 'seal-extra': value['successorConfigurationSeal']['unmeasured'] = True
            elif change == 'a-extra': value['successorConfigurationSeal']['initialPublication']['rawEnv'] = 'SECRET_NEVER_OUTPUT'
            elif change == 'unknown-kind': value['kind'] = scope.DECLARATION_EQUIVALENCE_KIND
            elif change == 'duplicate-command':
                value['preflightCommandId'] = value['successorConfigurationSeal']['initialPublication']['readbackCommandId']
                value['successorConfigurationSeal']['preflightCommandId'] = value['preflightCommandId']
            else: value['producer']['helpers']['unknown'] = '0' * 64
            with self.subTest(change=change), self.assertRaisesRegex(RuntimeError, '^ONLINE_RECHARGE_DECLARATION_PROOF_INVALID$') as error:
                scope.declaration_equivalence_successor_issuer_binding(controller(), value, live_services=value['afterServices'],
                    live_configuration=value['configurationAfter'], execution_producer=value['producer'])
            self.assertNotIn('SECRET', str(error.exception))
        before = json.loads(f['preflight_raw']); before['commandId'] = f['initial_command_id']
        with self.assertRaises(RuntimeError): scope.declaration_equivalence_successor_publication_binding(controller(),
            **{**f, 'preflight_raw': self.pure.raw(before)})




class PendingWorkspaceStageTests(unittest.TestCase):
    """Synthetic local witnesses never qualify a production F or publication."""
    def producer(self,run='124'):
        return {'commit':COMMIT,'sourceTree':TREE,'workflowRunId':run,'workflowRunAttempt':'1'}

    def bridge(self):
        d=controller(BASE=Path('/opt/id-business-v2'))
        return {'kind':scope.ONLINE_PENDING_WORKSPACE_KIND,'version':1,
            'baselineRelease':'/opt/id-business-v2/releases/20261010T120000Z-'+COMMIT[:12],
            'baselineCommit':COMMIT,'baselineProducer':self.producer('123'),
            **{n:'1'*64 for n in scope.ONLINE_PENDING_WORKSPACE_FIELDS if n.endswith('Sha256')},
            'readbackCommandId':'12345678-1234-1234-1234-123456789abc',
            'originalWorkspace':{'release':'/opt/id-business-v2/releases/20261009T120000Z-'+scope.BASELINE_COMMIT[:12],
                'manifestSha256':'2'*64},'migrationRecovery':scope.recovery_marker(scope.recovery_policy(d)),
            'migrationState':{'name':scope.MIGRATION_NAME,'sha256':scope.MIGRATION_IDENTITY['sha256'],
                'status':'APPLIED','schemaVerified':True,'appliedMigrationsSha256':'3'*64},
            'services':states(),'configurationAfter':{n:'4'*64 for n in ('docker-compose.aws-mysql.yml',
                'deploy/caddy/Caddyfile.aws',scope.SCHEMA_FILE,'compose.release.json')}}

    def inventory(self):
        return {n:{'sha256':hashlib.sha256((ROOT/n).read_bytes()).hexdigest(),'mode':'100644'}
            for n in (*scope._PENDING_WORKSPACE_CONTROL_NAMES,
                *scope._PENDING_WORKSPACE_RECEIPT_COMPATIBILITY_FILES,
                'apps/api/src/id-business-v2/online-recharge/online-recharge.service.ts',
                'apps/admin/src/v2/features/online-recharge/OnlineRechargePage.vue',
                'docker-compose.aws-mysql.yml','prisma/schema.prisma') if (ROOT/n).is_file()}

    def test_only_same_source_and_different_real_run_is_admitted(self):
        b=self.bridge();p=self.producer();inventory=self.inventory()
        with patch.object(scope,'_pending_workspace_current_source_inventory',return_value=inventory) as acquire:
            self.assertEqual(scope._pending_workspace_profile(controller(),b,p),inventory)
            acquire.assert_called_once_with(unittest.mock.ANY,p)

    def test_same_run_rejected_before_source_acquire(self):
        with patch.object(scope,'_pending_workspace_current_source_inventory') as acquire:
            with self.assertRaisesRegex(RuntimeError,'ORIGIN_CHANGED'):
                scope._pending_workspace_profile(controller(),self.bridge(),self.producer('123'))
            acquire.assert_not_called()

    def compatibility(self, mutate=None):
        current=self.inventory();original=copy.deepcopy(current)
        for name in scope._PENDING_WORKSPACE_RECEIPT_COMPATIBILITY_FILES:
            original[name]['sha256']='0'*64
        if mutate:mutate(original,current)
        p={**self.producer(),'commit':'9'*40,'sourceTree':'8'*40}
        return p,original,current

    def test_only_four_control_files_may_differ_between_real_source_trees(self):
        p,original,current=self.compatibility()
        with patch.object(scope,'_pending_workspace_current_source_inventory',side_effect=[current,original]) as acquire:
            self.assertEqual(scope._pending_workspace_profile(controller(),self.bridge(),p),current)
            self.assertEqual([c.args[1] for c in acquire.call_args_list],[p,self.bridge()['baselineProducer']])

    def test_application_config_migration_and_other_controls_cannot_change(self):
        for name in ('apps/api/src/id-business-v2/online-recharge/online-recharge.service.ts',
                'apps/admin/src/v2/features/online-recharge/OnlineRechargePage.vue',
                'docker-compose.aws-mysql.yml','prisma/schema.prisma',
                'prisma/migrations/not-an-approved-migration/migration.sql',
                'scripts/production-release/api-admin-scope.py'):
            p,original,current=self.compatibility()
            original[name]={'sha256':'1'*64,'mode':'100644'}
            current[name]={'sha256':'2'*64,'mode':'100644'}
            with self.subTest(name=name),patch.object(scope,'_pending_workspace_current_source_inventory',side_effect=[current,original]):
                with self.assertRaisesRegex(RuntimeError,'APPLICATION_SOURCE_CHANGED'):
                    scope._pending_workspace_profile(controller(),self.bridge(),p)

    def test_added_deleted_and_executable_mode_changes_are_rejected(self):
        for case in ('added','deleted','application-mode','control-mode'):
            p,original,current=self.compatibility()
            if case=='added':current['new-file']={'sha256':'1'*64,'mode':'100644'}
            elif case=='deleted':current.pop('scripts/production-release/api-admin-scope.py')
            else:
                name=('docker-compose.aws-mysql.yml' if case=='application-mode'
                    else next(iter(scope._PENDING_WORKSPACE_RECEIPT_COMPATIBILITY_FILES)))
                original[name]['mode']='100755'
            with self.subTest(case=case),patch.object(scope,'_pending_workspace_current_source_inventory',side_effect=[current,original]):
                with self.assertRaisesRegex(RuntimeError,'APPLICATION_SOURCE_CHANGED'):
                    scope._pending_workspace_profile(controller(),self.bridge(),p)

    def test_invalid_candidate_or_predecessor_archive_is_never_accepted(self):
        p,original,current=self.compatibility()
        for outcomes in ([RuntimeError('ONLINE_RECHARGE_ARCHIVE_INVALID')],
                [current,RuntimeError('ONLINE_RECHARGE_ARCHIVE_INVALID')]):
            with self.subTest(count=len(outcomes)),patch.object(scope,'_pending_workspace_current_source_inventory',side_effect=outcomes):
                with self.assertRaisesRegex(RuntimeError,'ARCHIVE_INVALID'):
                    scope._pending_workspace_profile(controller(),self.bridge(),p)

    def test_baseline_keeps_actual_current_commit_with_control_repair_candidate(self):
        p,original,current=self.compatibility();b=self.bridge()
        with directories() as (old,new):
            base=old.parent;(base/'current').symlink_to(old)
            reader=SimpleNamespace(online_pending_workspace_measure_before=MagicMock(return_value=b))
            d=controller(BASE=base)
            with patch.object(scope,'_pending_workspace_reader',return_value=reader),patch.object(scope,'_workspace_baseline_kind',return_value=scope.ONLINE_PENDING_WORKSPACE_KIND),patch.object(scope,'_workspace_bridge_shape'),patch.object(scope,'_pending_workspace_profile'):
                self.assertEqual(scope._pending_workspace_begin(d,COMMIT,p,live=True),(old,b))
                reader.online_pending_workspace_measure_before.assert_called_once_with(d,old,expected_commit=COMMIT)
                b['baselineCommit']='f'*40
                with self.assertRaisesRegex(RuntimeError,'ORIGIN_CHANGED'):
                    scope._pending_workspace_begin(d,COMMIT,p,live=True)

    def test_new_sqlite_receipt_is_checked_before_legacy_fallback_and_jobs(self):
        for case in ('new','legacy','invalid'):
            with self.subTest(case=case),directories() as (old,new),ExitStack() as stack:
                b=self.bridge();b['baselineRelease']=str(old)
                events=[];protection={'backupVerified':True,'restoreVerified':True}
                def sqlite_receipt(*args):
                    events.append('sqlite')
                    if case=='invalid':raise RuntimeError('API_ADMIN_WORKSPACE_SQLITE_RECEIPT_INVALID')
                    return None if case=='legacy' else protection
                reader=SimpleNamespace(STATE_FILE='state.json',PROOF_FILE='proof.json',
                    validate_proof=MagicMock(return_value=proof()),verify_running=MagicMock(),workspace_health=MagicMock(),
                    workspace_sqlite_receipt=MagicMock(side_effect=sqlite_receipt),
                    workspace_backup_receipt=MagicMock(side_effect=lambda *a:events.append('legacy')))
                for name,value in (('release-manifest.json',{}),('state.json',{'baselineEvidence':{}}),('proof.json',{})):
                    (old/name).write_text(json.dumps(value))
                d=controller(BASE=old.parent,_onlinePendingWorkspaceProducer=self.producer())
                (old.parent/'current').symlink_to(old)
                stack.enter_context(patch.object(scope,'_pending_workspace_begin',return_value=(old,b)))
                stack.enter_context(patch.object(scope,'_workspace_origin_type',return_value=('onlinePendingWorkspaceOrigin','ONLINE_RECHARGE_PENDING_WORKSPACE')))
                stack.enter_context(patch.object(scope,'legacy',return_value=reader))
                for name in ('workspace_guard','release_recovery','verify_permission_seed','require_fresh_resources',
                        'workspace_files','workspace_origin'):
                    stack.enter_context(patch.object(scope,name,return_value={'source':old}))
                stack.enter_context(patch.object(scope,'snapshot',return_value=b['services']))
                stack.enter_context(patch.object(scope.shutil,'disk_usage',return_value=SimpleNamespace(free=7*1024**3)))
                jobs=stack.enter_context(patch.object(scope,'jobs_idle',side_effect=lambda *a,**k:events.append('jobs') or {}))
                if case=='invalid':
                    with self.assertRaisesRegex(RuntimeError,'SQLITE_RECEIPT_INVALID'):scope.baseline(d,COMMIT)
                    jobs.assert_not_called();reader.workspace_backup_receipt.assert_not_called()
                    self.assertEqual(events,['sqlite'])
                else:
                    scope.baseline(d,COMMIT)
                    self.assertEqual(events,['sqlite','legacy','jobs'] if case=='legacy' else ['sqlite','jobs'])
                reader.workspace_sqlite_receipt.assert_called_once_with(d,old,proof(),{'baselineEvidence':{}},{})

    def test_each_executed_helper_still_bound_to_complete_archive(self):
        for name in scope._PENDING_WORKSPACE_CONTROL_NAMES:
            rows=self.inventory();rows[name]['sha256']='0'*64
            with self.subTest(name=name),patch.object(scope,'_pending_workspace_current_source_inventory',return_value=rows):
                with self.assertRaisesRegex(RuntimeError,'EXECUTOR_SOURCE_CHANGED'):
                    scope._pending_workspace_profile(controller(),self.bridge(),self.producer())

    def compatibility_readback(self,mutation=None):
        with tempfile.TemporaryDirectory(prefix='compat-origin-',dir=RUNTIME) as name,ExitStack() as stack:
            base=Path(name);directory=base/'releases'/'new';directory.mkdir(parents=True,mode=0o700)
            (base/'current').symlink_to(directory)
            p={**self.producer(),'commit':'9'*40,'sourceTree':'8'*40};b=self.bridge()
            b['baselineRelease']=str(base/'releases'/('20261010T120000Z-'+COMMIT[:12]))
            image_states=states(True)
            images={n:{'imageId':image_states[n]['image'],'reference':image_states[n]['reference']} for n in scope.UPDATED}
            build={'images':images,'preflightBytesSha256':'6'*64}
            record={'baselineEvidence':{'onlinePendingWorkspaceOrigin':copy.deepcopy(b)},'before':copy.deepcopy(b['services']),
                'buildProofSha256':scope.fingerprint(build),'configurationBefore':copy.deepcopy(b['configurationAfter']),
                'configurationAfter':copy.deepcopy(b['configurationAfter']),'migration':{**b['migrationState'],'performed':False},
                'after':image_states}
            manifest={'commit':p['commit'],'sourceTree':p['sourceTree'],'previousRelease':b['baselineRelease'],
                'previousCommit':COMMIT,'previousManifestSha256':b['manifestBytesSha256'],'migrationPerformed':False}
            if mutation:mutation(record,build,manifest,image_states)
            for n,value in ((scope.STATE_FILE,record),(scope.PROOF_FILE,build),('release-manifest.json',manifest)):
                path=directory/n;path.write_text(json.dumps(value));path.chmod(0o600)
            reader=SimpleNamespace(WORKSPACE=True,online_pending_workspace_cold=MagicMock(return_value=b))
            stack.enter_context(patch.object(scope,'_pending_workspace_reader',return_value=reader))
            profile=stack.enter_context(patch.object(scope,'_pending_workspace_profile'))
            before=stack.enter_context(patch.object(scope,'online_pending_workspace_preflight_bytes',return_value=b'original actual F'))
            binding=stack.enter_context(patch.object(scope,'online_pending_workspace_preflight_binding'))
            shape=stack.enter_context(patch.object(scope,'online_pending_workspace_build_shape'))
            stack.enter_context(patch.object(scope,'snapshot',return_value=image_states))
            stack.enter_context(patch.object(scope,'configuration_hashes',return_value=b['configurationAfter']))
            result=scope._pending_workspace_compatibility_readback_origin(controller(BASE=base),directory,
                expected_commit=p['commit'],producer=p)
            self.assertEqual(result,b)
            profile.assert_called_once_with(unittest.mock.ANY,b,p)
            reader.online_pending_workspace_cold.assert_called_once_with(unittest.mock.ANY,Path(b['baselineRelease']),expected_commit=COMMIT)
            before.assert_called_once_with(unittest.mock.ANY,producer=p,expected_sha256=build['preflightBytesSha256'])
            binding.assert_called_once_with(unittest.mock.ANY,b'original actual F',producer=p,bridge=b)
            shape.assert_called_once_with(unittest.mock.ANY,build,producer=p,bridge=b,preflight_raw=b'original actual F')

    def test_control_repair_readback_keeps_old_actual_q_and_new_actual_f_proof(self):
        self.compatibility_readback()

    def test_control_repair_readback_rejects_changed_record_manifest_and_runtime(self):
        changes=(lambda r,p,m,s:r['before'].clear(),lambda r,p,m,s:r.update(buildProofSha256='0'*64),
            lambda r,p,m,s:r['configurationBefore'].clear(),lambda r,p,m,s:r['configurationAfter'].clear(),
            lambda r,p,m,s:m.update(commit=COMMIT),lambda r,p,m,s:m.update(sourceTree=TREE),
            lambda r,p,m,s:m.update(previousManifestSha256='0'*64),lambda r,p,m,s:m.update(migrationPerformed=True),
            lambda r,p,m,s:r['migration'].update(performed=True),
            lambda r,p,m,s:r['migration'].update(sha256='0'*64),
            lambda r,p,m,s:s[next(iter(scope.PRESERVED))].update(image='sha256:'+'0'*64),
            lambda r,p,m,s:p['images']['api'].update(imageId='sha256:'+'0'*64),
            lambda r,p,m,s:p['images']['admin'].update(reference='unrelated-image'))
        for i,change in enumerate(changes):
            with self.subTest(case=i),self.assertRaisesRegex(RuntimeError,'AFTER_BIT_READBACK_CHANGED'):
                self.compatibility_readback(change)

    def test_readback_keeps_original_reader_for_same_source(self):
        with directories() as (old,new):
            (old.parent/'current').symlink_to(new)
            (new/scope.STATE_FILE).write_text(json.dumps({'baselineEvidence':{'onlinePendingWorkspaceOrigin':self.bridge()}}))
            reader=SimpleNamespace(online_pending_workspace_readback_origin=MagicMock(return_value=self.bridge()))
            d=controller(BASE=old.parent,_onlinePendingWorkspaceProducer=self.producer())
            with patch.object(scope,'_pending_workspace_reader',return_value=reader),patch.object(scope,'_workspace_bridge_shape'),patch.object(scope,'_pending_workspace_profile'),patch.object(scope,'_pending_workspace_readback',return_value={'actual':'Q'}),patch.object(scope,'_pending_workspace_compatibility_readback_origin') as compat:
                self.assertEqual(scope.readback(d,COMMIT),{'actual':'Q'})
                compat.assert_not_called()
                reader.online_pending_workspace_readback_origin.assert_called_once_with(d,new,expected_commit=COMMIT,producer=self.producer())

    def test_only_initial_kind_seven_services_and_applied_state_shape(self):
        scope.online_pending_workspace_bridge_shape(controller(BASE=Path('/opt/id-business-v2')),self.bridge())
        for key,value in (('kind','ONLINE_RECHARGE_AFTER_BIT_SUCCESSOR_ORIGIN'),('services',states(True)),
                ('migrationState',{**self.bridge()['migrationState'],'status':'PENDING'})):
            b=self.bridge();b[key]=value
            with self.subTest(key=key),self.assertRaisesRegex(RuntimeError,'ORIGIN_CHANGED'):
                scope.online_pending_workspace_bridge_shape(controller(BASE=Path('/opt/id-business-v2')),b)

    def test_argv_is_finite_and_does_not_grant_api_readback_entry(self):
        p=self.producer();encoded=base64.b64encode(json.dumps(p).encode()).decode()
        argv=['--online-recharge-preflight','--expected-current',COMMIT,'--declaration-producer',encoded]
        self.assertEqual(scope.online_pending_workspace_argv(argv)['producer'],p)
        for bad in (argv+['--api-workspace-readback'],['--api-workspace-readback',*argv[1:]],
                [argv[0],argv[1],COMMIT+';true',*argv[3:]], [*argv[:3],'--arbitrary',encoded]):
            with self.assertRaisesRegex(RuntimeError,'INPUT_INVALID'):
                scope.online_pending_workspace_argv(bad)

    def test_projected_predecessor_schema_is_checked_as_pending_not_full(self):
        b=self.bridge();d=controller(_onlinePendingWorkspaceSession={'bridge':b,'producer':self.producer()})
        reader=SimpleNamespace(pending_online_migrations=MagicMock(return_value=scope.MIGRATION_FILE))
        with patch.object(scope,'legacy',return_value=reader),patch.dict(scope._PENDING_WORKSPACE_FIRST,
                {'migration_source_check':MagicMock()}) as unused:
            self.assertIsNone(scope.migration_source_check(d,Path(b['baselineRelease']),candidate=False))
            reader.pending_online_migrations.assert_called_once()
            reader.pending_online_migrations.return_value=None
            with self.assertRaisesRegex(RuntimeError,'MIGRATION_SCOPE_CHANGED'):
                scope.migration_source_check(d,Path(b['baselineRelease']),candidate=False)

    def test_ordinary14_original_bodies_are_exact_and_no_registry_added(self):
        import ast, re
        text=(ROOT/'scripts/production-release/online-recharge-scope.py').read_text()
        nodes={}
        for n in ast.parse(text).body:
            if isinstance(n,ast.FunctionDef):nodes.setdefault(n.name,n)
        for name,fn in scope._PENDING_WORKSPACE_FIRST.items():
            self.assertEqual(fn.__code__.co_firstlineno,nodes[name].lineno)
        added=text[text.index('# Same immutable main candidate:'):]
        # Only the immutable qualification profile and its existing pool mode
        # may use this prefix; no new review registry or exception is admitted.
        self.assertEqual(sorted(re.findall(r'REVIEWED_[A-Z0-9_]+',added)),
            ['REVIEWED_BUILTIN_ZERO_INPUTS','REVIEWED_PROFILE_CANONICAL_SHA256'])
        self.assertNotIn('declaration_equivalence_successor',added)
        self.assertEqual(added.count('reader.pending_online_declaration_b_files('),1)
        self.assertNotIn('sync_new_table_grants',scope._workspace_after_bit_materials.__code__.co_names)

    def test_stage2_holds_fences_until_old_api_exits_and_never_runs_ddl(self):
        helper=ReleaseSequenceTests();helper.addCleanup=lambda *a: self.addCleanup(*a)
        result,receipt,events=helper.execute(recovered=True,stage2=True)
        self.assertEqual(result,0);self.assertEqual(receipt['status'],'ONLINE_RECHARGE_VERIFIED')
        self.assertNotIn('migration',events)
        for before,after in (('backup','sqlite-protect'),('sql-lock','sqlite-protect'),
                ('sqlite-protect','sqlite-stop-confirmed'),('sqlite-stop-confirmed','sql-unlock'),
                ('sql-unlock','switch:api'),('switch:api','switch:online-recharge'),
                ('audit:after-audit.json','sqlite-finish')):
            self.assertLess(events.index(before),events.index(after))

    def test_failed_old_api_stop_never_starts_new_api_or_engine(self):
        helper=ReleaseSequenceTests();helper.addCleanup=lambda *a: self.addCleanup(*a)
        result,receipt,events=helper.execute(recovered=True,stage2=True,fail='sqlite-stop')
        self.assertEqual(result,1);self.assertFalse(receipt['migrationAttempted'])
        self.assertFalse(receipt['inverseMigrationPerformed'])
        self.assertNotIn('switch:api',events);self.assertNotIn('switch:online-recharge',events)
        self.assertIn('sqlite-abort',events)

    def test_unknown_baseline_has_no_implicit_source_or_live_reader(self):
        with patch.object(scope,'_pending_workspace_begin') as acquire:
            with self.assertRaisesRegex(RuntimeError,'BASELINE_NOT_APPROVED'):
                scope.baseline(controller(),'9'*40)
            acquire.assert_not_called()


class AfterBitFormalTests(unittest.TestCase):
    """Real A/B type and API cold/binding bodies; external acquisition is synthetic."""
    @classmethod
    def setUpClass(cls):
        # All five approved policy blobs come from the retained main commit.
        # This test file and the Admin adapter tests may change independently.
        tree=subprocess.check_output(['git','rev-parse',REVIEWED_APPLICATION_TEMPLATE_COMMIT+'^{tree}'],cwd=ROOT).decode().strip()
        if tree != REVIEWED_APPLICATION_TEMPLATE_TREE:
            raise AssertionError('reviewed ONLINE policy fixture tree changed')
        cls.reviewed_policy_sources={}
        cls.reviewed_policy_modes={}
        for name,(before_hash,after_hash) in scope._AFTER_BIT_BANK_POLICY_FILES.items():
            raw=subprocess.check_output(['git','show',REVIEWED_APPLICATION_TEMPLATE_COMMIT+':'+name],cwd=ROOT)
            entry=subprocess.check_output(['git','ls-tree',REVIEWED_APPLICATION_TEMPLATE_COMMIT,'--',name],cwd=ROOT).decode().split()
            if (hashlib.sha256(raw).hexdigest()!=after_hash or len(entry)!=4
                    or entry[0]!='100644' or entry[1]!='blob' or entry[3]!=name):
                raise AssertionError('reviewed ONLINE policy fixture bytes or mode changed')
            cls.reviewed_policy_sources[name]=raw
            cls.reviewed_policy_modes[name]=entry[0]

    @contextmanager
    def fixture(self,policy=False):
        with tempfile.TemporaryDirectory(prefix='formal-b-',dir=RUNTIME) as temporary,ExitStack() as stack:
            base=Path(temporary);old=base/'releases'/('20261011T000000Z-'+COMMIT[:12]);old.mkdir(parents=True,mode=0o700)
            (base/'current').symlink_to(old)
            reader=scope._load_legacy();g=reader.online_after_bit_cold.__globals__
            p={'commit':COMMIT,'sourceTree':TREE,'workflowRunId':'123','workflowRunAttempt':'1'}
            candidate={**p,'workflowRunId':'124'}
            inventory=PendingWorkspaceStageTests().inventory()
            for name in ('scripts/lib/v2-production-database-access.mjs','scripts/sync-v2-new-table-grants.mjs'):
                inventory[name]={'sha256':hashlib.sha256((ROOT/name).read_bytes()).hexdigest(),'mode':'100644'}
            candidate_inventory=inventory
            if policy:
                for name,(before_hash,after_hash) in scope._AFTER_BIT_BANK_POLICY_FILES.items():
                    inventory[name]={'sha256':before_hash,'mode':'100644'}
                candidate_inventory=copy.deepcopy(inventory)
                for name,(before_hash,after_hash) in scope._AFTER_BIT_BANK_POLICY_FILES.items():
                    candidate_inventory[name]={'sha256':after_hash,'mode':'100644'}
                candidate.update(commit='e'*40,sourceTree='f'*40)
                for name in scope._AFTER_BIT_BANK_POLICY_FILES:
                    path=old/name;path.parent.mkdir(parents=True,exist_ok=True)
                    path.write_bytes(subprocess.check_output(['git','show','31d2c6885a45817cd40d23fce8d6145bc9f18af2:'+name],cwd=ROOT));path.chmod(0o644)
                for name in ('apps/api/src/id-business-v2/auto-recharge/worker/fixture.cjs',
                        'apps/api/src/id-business-v2/auto-registration/fixture.cjs',
                        'scripts/v2-data-integrity-audit.mjs','scripts/lib/v2-data-integrity-audit.mjs',
                        'scripts/sync-v2-new-table-grants.mjs'):
                    path=old/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'SYNTHETIC_PROTECTED');path.chmod(0o644)
            before=states();config={n:'4'*64 for n in ('docker-compose.aws-mysql.yml','deploy/caddy/Caddyfile.aws',scope.SCHEMA_FILE,'compose.release.json')}
            hashes={n:'1'*64 for n in ('preflightBytesSha256','manifestBytesSha256','recordBytesSha256','buildProofBytesSha256','buildProofCanonicalSha256')}
            producer={**p,'archiveInventorySha256':scope.fingerprint(inventory),
                'helpers':{n:inventory[n]['sha256'] for n in scope.DECLARATION_EQUIVALENCE_HELPERS}}
            pair={'kind':scope.DECLARATION_EQUIVALENCE_KIND,'version':3,
                **{n:'2'*64 for n in ('preflightBytesSha256','preflightProofSha256','deploymentProofSha256','semanticSha256')}}
            initial={'kind':scope.DECLARATION_EQUIVALENCE_KIND,'version':3,
                'producer':{**producer,'commit':'c'*40,'sourceTree':'d'*40,'workflowRunId':'121'},
                'preflightCommandId':'00000000-0000-0000-0000-000000000001',**hashes,
                'archiveInventorySha256':producer['archiveInventorySha256'],'configurationEquivalenceSeal':pair}
            qa={'CommandId':'00000000-0000-0000-0000-000000000002','Status':'Success','ResponseCode':0,
                'StandardOutputContent':json.dumps({'status':'API_ADMIN_WORKSPACE_VERIFIED','declarationEquivalencePublication':initial})}
            qa_path=base/'qa.json';qa_path.write_text(json.dumps(qa));qa_path.chmod(0o600)
            initial_issued={**initial,'readbackCommandId':qa['CommandId']}
            seal={'kind':scope.DECLARATION_SUCCESSOR_KIND,'version':1,'initialProofSha256':pair['preflightProofSha256'],
                'preflightBytesSha256':'1'*64,'currentProducer':producer,'currentServicesSha256':scope.fingerprint(before),
                'initialPublication':initial_issued,'initialReadbackInvocationBytesSha256':hashlib.sha256(qa_path.read_bytes()).hexdigest(),
                'preflightCommandId':'00000000-0000-0000-0000-000000000003','currentConfigurationSha256':scope.fingerprint(config)}
            migration={'name':scope.MIGRATION_NAME,'sha256':scope.MIGRATION_IDENTITY['sha256'],'status':'APPLIED',
                'schemaVerified':True,'appliedMigrationsSha256':'3'*64}
            context={'version':2,'priorPublications':[{'release':'/synthetic/A'}],
                'baselineRelease':'/opt/id-business-v2/releases/20261009T000000Z-'+scope.BASELINE_COMMIT[:12],
                'baselineManifestSha256':'2'*64,'recoveryMarker':scope.recovery_marker(scope.recovery_policy(controller())),
                'migrationState':migration}
            audit={'checkCount':49,'violationCount':0,'mode':'STRICT_ZERO_49','checksSha256':'5'*64}
            env=b'APP_PUBLIC_URL=https://fixture.invalid\n';volume={'status':'PRESENT','name':'fixture','identitySha256':'6'*64}
            api_record={'pendingOnlineMigrationOrigin':context,'workspaceVolumeAfter':volume,
                'environmentSha256':hashlib.sha256(env).hexdigest(),'baselineEvidence':{}}
            api_proof={'pendingOnlineProjection':{'synthetic':True}}
            manifest={'commit':COMMIT,'sourceTree':TREE,'images':{},'dataAuditBefore':audit,'dataAuditAfter':audit}
            for n,value in ((reader.STATE_FILE,api_record),(reader.PROOF_FILE,api_proof),('release-manifest.json',manifest)):
                path=old/n;path.write_text(json.dumps(value));path.chmod(0o600)
            (old/'.env.aws.production').write_bytes(env);(old/'.env.aws.production').chmod(0o600)
            pub={'kind':scope.DECLARATION_SUCCESSOR_KIND,'version':1,'producer':producer,
                'preflightCommandId':seal['preflightCommandId'],**hashes,'originSha256':scope.fingerprint(context),
                'archiveInventorySha256':producer['archiveInventorySha256'],'successorConfigurationSeal':seal,
                'afterServices':before,'configurationAfter':config}
            for key,name in (('manifestBytesSha256','release-manifest.json'),('recordBytesSha256',reader.STATE_FILE),('buildProofBytesSha256',reader.PROOF_FILE)):
                pub[key]=hashlib.sha256((old/name).read_bytes()).hexdigest()
            pub['buildProofCanonicalSha256']=scope.fingerprint(api_proof)
            issued=scope.declaration_equivalence_successor_issuer_binding(controller(),pub,
                live_services=before,live_configuration=config,execution_producer=producer)
            receipt={'status':'API_ADMIN_WORKSPACE_VERIFIED','commit':COMMIT,'sourceTree':TREE,'services':before,
                'servicesUpdated':['api','admin'],'preservedServiceCount':5,'runningImagesAndContentMatched':True,
                'buildProofSha256':pub['buildProofCanonicalSha256'],'environmentUnchanged':True,'onlinePublished':False,
                'migrationPerformed':False,'observedServiceCount':7,'volumePreserved':True,'volumeDeletionPerformed':False,
                'registrationHealthChecked':True,'workspaceVolume':volume,'pendingOnlineMigrationOrigin':context,
                'preservedPendingOnlineMigration':{'synthetic':True},'declarationEquivalenceSuccessorPublication':issued}
            qb={'CommandId':'00000000-0000-0000-0000-000000000004','Status':'Success','ResponseCode':0,
                'StandardOutputContent':json.dumps(receipt)}
            qb_path=base/'qb.json';qb_path.write_text(json.dumps(qb));qb_path.chmod(0o600)
            materials={'producer':producer,'archive_bytes':b'SYNTHETIC_ACQUIRED_ARCHIVE','historical_files':{}}
            material_reader=SimpleNamespace(archive_inventory=MagicMock(return_value=inventory),
                _declaration_source_bytes=scope._declaration_source_bytes,
                declaration_equivalence_saved_invocation=lambda *a,**k:{'raw_bytes':qb_path.read_bytes(),'command_id':qb['CommandId']})
            runtime_names=('docker-compose.aws-mysql.yml',reader.MIGRATION_SCHEMA,reader.MIGRATION_SEED)
            archive_files={n:(('SYNTHETIC_ORIGINAL_'+n).encode(),'100644') for n in runtime_names}
            projected={n:(('SYNTHETIC_PROJECTED_'+n).encode(),'100644') for n in runtime_names}
            for root,rows in ((old,projected),(old/'.deploy/production-release/pending-original-source',archive_files)):
                for n,(raw,mode) in rows.items():
                    path=root/n;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw);path.chmod(0o644)
            def files(*a,**k):
                scope.declaration_equivalence_receipt_binding(controller(),initial,qa_path.read_bytes(),
                    command_id=qa['CommandId'],wire_decoder=lambda raw,**unused:json.loads(raw))
                require(hashlib.sha256(qa_path.read_bytes()).hexdigest()==seal['initialReadbackInvocationBytesSha256'],'SYNTHETIC_Q_A_CHANGED')
                return material_reader,materials,pub,{'synthetic':True},api_record
            recovery={'source':old,'marker':context['recoveryMarker'],'state':migration}
            changes={'pending_online_equivalence':lambda:scope,'validate_pending_online_origin':lambda v:v,
                'pending_online_recovery':lambda *a:(scope,recovery),'pending_online_declaration_b_files':files,
                'pending_online_declaration_wire':lambda *a:lambda raw,**unused:json.loads(raw),
                'pending_online_declaration_call':lambda d,name,*a,**k:getattr(scope,name)(d,*a,**k),
                'configuration_hashes':lambda path:config,'audit_receipt':lambda *a:audit,'snapshot':lambda *a:before,
                'pending_projection':lambda:SimpleNamespace(runtime_config_files=lambda *a:projected)}
            stack.enter_context(patch.dict(g,changes));stack.enter_context(patch.multiple(reader,**changes))
            a_reader=MagicMock(side_effect=AssertionError('B must never fall back to A'))
            for name in ('online_pending_workspace_cold','online_pending_workspace_measure_before','online_pending_workspace_readback_origin'):
                stack.enter_context(patch.object(reader,name,a_reader))
            reader.validate_proof=MagicMock(return_value=api_proof);reader.verify_running=MagicMock();reader.workspace_health=MagicMock()
            reader.workspace_sqlite_receipt=MagicMock(return_value={'backupVerified':True,'restoreVerified':True})
            reader.strict_audit=MagicMock(return_value=audit);reader.pending_online_migrations=MagicMock(return_value=scope.MIGRATION_FILE)
            d=controller(BASE=base,_onlinePendingWorkspaceProducer=candidate,
                run=MagicMock(),compose=MagicMock(),sync_new_table_grants=MagicMock(),point_current=MagicMock())
            d.registration_archive=MagicMock(return_value=archive_files)
            # Controller factory's API selector is replaced explicitly below.
            d.api_admin_scope=lambda selected:(reader,None)
            stack.enter_context(patch.object(scope,'_pending_workspace_current_source_inventory',
                side_effect=lambda d,p:candidate_inventory if policy and p['commit']==candidate['commit'] else inventory))
            stack.enter_context(patch.dict(scope._PENDING_WORKSPACE_FIRST,release_recovery=lambda *a:recovery,migration_source_check=lambda *a,**k:None))
            for name,value in {'workspace_guard':volume,'jobs_idle':{'rechargeIdle':True,'registrationBusy':False,
                    'registrationLeaseActive':False,'registrationWindowRetained':False},'verify_permission_seed':None,
                    'require_fresh_resources':None,'workspace_files':{n:'7'*64 for n in ('release-manifest.json',reader.STATE_FILE,
                    reader.PROOF_FILE,'backup-verification.json','before-audit.json','after-audit.json')}}.items():
                stack.enter_context(patch.object(scope,name,return_value=value))
            stack.enter_context(patch.object(scope,'snapshot',return_value=before))
            stack.enter_context(patch.object(scope.shutil,'disk_usage',return_value=SimpleNamespace(free=8*1024**3)))
            yield SimpleNamespace(d=d,base=base,old=old,reader=reader,producer=candidate,context=context,publication=pub,
                qa=qa_path,qb=qb_path,inventory=inventory,materials=materials,material_reader=material_reader,
                a_reader=a_reader,audit=audit,recovery=recovery,volume=volume,stack=stack,config=config,
                candidate_inventory=candidate_inventory)

    def preflight_and_f(self,f):
        result=scope.preflight(f.d,COMMIT)
        self.assertIn('onlineAfterBitOrigin',result);self.assertNotIn('onlinePendingWorkspaceOrigin',result)
        invocation={'CommandId':'00000000-0000-0000-0000-000000000005','InstanceId':'i-12345678901234567',
            'DocumentName':'AWS-RunShellScript','PluginName':'aws:runShellScript','Status':'Success','ResponseCode':0,
            'ExecutionEndDateTime':'2026-01-01T00:00:00Z','StandardErrorContent':'','StandardOutputContent':json.dumps(result)}
        bound=scope.online_pending_workspace_ended_preflight(f.d,json.dumps(invocation).encode(),
            command_id=invocation['CommandId'],instance_id=invocation['InstanceId'],producer=f.producer,
            wire_decoder=lambda raw,**unused:json.loads(raw))
        raw=bound['preflight_raw'];self.assertEqual(json.loads(raw)['kind'],'ONLINE_RECHARGE_AFTER_BIT_PREFLIGHT')
        folder=f.base/'.staging'/('online-recharge-pending-workspace-preflight-'+f.producer['commit']+'-124-1')
        folder.mkdir(parents=True,mode=0o700);path=folder/'online-recharge-pending-workspace-preflight-result.json'
        path.write_bytes(raw);path.chmod(0o600)
        return result,raw,path

    def test_actual_b_begin_full_preflight_f_and_four_image_build_contract(self):
        with self.fixture() as f:
            result,raw,path=self.preflight_and_f(f);bridge=result['onlineAfterBitOrigin']
            build=proof();build.update(kind='ONLINE_RECHARGE_AFTER_BIT_BUILD_PROOF',version=2,baselineCommit=COMMIT,
                baselineOriginSha256=scope.fingerprint(bridge),preflightBytesSha256=hashlib.sha256(raw).hexdigest())
            for name in build['images']:build['images'][name]['reference']=f'{REPOSITORY}:{COMMIT}-124-1-{name}'
            args=SimpleNamespace(online_recharge_only=True,commit=COMMIT,source_tree=TREE,expected_current=COMMIT,
                repository=REPOSITORY,run_id='124',run_attempt='1',ci_run_id='234',
                online_recharge_build_proof=base64.b64encode(json.dumps(build).encode()).decode())
            self.assertEqual(scope.validate_arguments(f.d,args),build)
            self.assertEqual(set(build['images']),set(scope.IMAGE_SERVICES));f.a_reader.assert_not_called()
            f.reader.verify_running.assert_called();f.reader.workspace_health.assert_called();f.reader.strict_audit.assert_called()
            f.d.compose.assert_not_called();f.d.sync_new_table_grants.assert_not_called();f.d.point_current.assert_not_called()

    def test_q_a_q_b_state_and_producer_drift_stop_before_mutable_stage(self):
        for mutation in ('q-a','q-b','state-third','bool-version','producer','source-lib'):
            with self.subTest(mutation=mutation),self.fixture() as f:
                if mutation in ('q-a','q-b'):
                    path=f.qa if mutation=='q-a' else f.qb;value=json.loads(path.read_text());value['Status']='Failed';path.write_text(json.dumps(value))
                elif mutation in ('state-third','bool-version'):
                    path=f.old/f.reader.STATE_FILE;value=json.loads(path.read_text())
                    if mutation=='state-third':value['pendingOnlineMigrationOrigin']['priorPublications']*=2
                    else:value['pendingOnlineMigrationOrigin']['version']=True
                    path.write_text(json.dumps(value))
                elif mutation=='producer':f.d._onlinePendingWorkspaceProducer={**f.producer,'workflowRunId':'123'}
                else:
                    original=copy.deepcopy(f.inventory);original['scripts/lib/v2-production-database-access.mjs']['sha256']='0'*64
                    f.producer.update(commit='e'*40,sourceTree='f'*40)
                    f.stack.enter_context(patch.object(scope,'_pending_workspace_current_source_inventory',side_effect=[f.inventory,original]))
                with self.assertRaises(RuntimeError):scope.preflight(f.d,COMMIT)
                f.a_reader.assert_not_called();f.d.compose.assert_not_called();f.d.sync_new_table_grants.assert_not_called();f.d.point_current.assert_not_called()

    def test_b_f_cannot_be_relabelled_as_a_or_cross_run(self):
        with self.fixture() as f:
            result,raw,path=self.preflight_and_f(f);bridge=result['onlineAfterBitOrigin']
            for mutation in ('kind','origin-field','q-a','run','extra'):
                value=json.loads(raw)
                if mutation=='kind':value['kind']='ONLINE_RECHARGE_PENDING_WORKSPACE_PREFLIGHT'
                elif mutation=='origin-field':value['ordinaryPreflight']['onlinePendingWorkspaceOrigin']=value['ordinaryPreflight'].pop('onlineAfterBitOrigin')
                elif mutation=='q-a':value['baseline']['readbackInvocationBytesSha256']=bridge['initialReadbackInvocationBytesSha256']
                elif mutation=='run':value['workflowRunId']='125'
                else:value['trusted']=True
                with self.subTest(mutation=mutation),self.assertRaises(RuntimeError):
                    scope.online_after_bit_preflight_binding(f.d,json.dumps(value).encode(),producer=f.producer,bridge=bridge)

    def test_b_materials_reacquire_qs_archive_and_both_runtime_originals(self):
        with self.fixture() as f:
            result,raw,path=self.preflight_and_f(f);bridge=result['onlineAfterBitOrigin']
            self.assertIs(scope._workspace_after_bit_materials(f.d,f.old,bridge=bridge),f.materials)
            f.material_reader.archive_inventory.assert_called_once_with(f.d,f.materials['archive_bytes'],COMMIT,TREE)
            f.a_reader.assert_not_called()
            for root in (f.old,f.old/'.deploy/production-release/pending-original-source'):
                path=root/f.reader.MIGRATION_SCHEMA;original=path.read_bytes();path.write_bytes(b'DRIFT')
                with self.subTest(root=root),self.assertRaises(RuntimeError):scope._workspace_after_bit_materials(f.d,f.old,bridge=bridge)
                path.write_bytes(original)
            f.material_reader.archive_inventory.return_value={}
            with self.assertRaises(RuntimeError):scope._workspace_after_bit_materials(f.d,f.old,bridge=bridge)

    def test_missing_q_a_q_b_f_and_source_do_not_start_stage(self):
        for missing in ('q-a','q-b','f','source'):
            with self.subTest(missing=missing),self.fixture() as f:
                result,raw,path=self.preflight_and_f(f);bridge=result['onlineAfterBitOrigin']
                build=proof();build.update(kind='ONLINE_RECHARGE_AFTER_BIT_BUILD_PROOF',version=2,baselineCommit=COMMIT,
                    baselineOriginSha256=scope.fingerprint(bridge),preflightBytesSha256=hashlib.sha256(raw).hexdigest())
                for name in build['images']:build['images'][name]['reference']=f'{REPOSITORY}:{COMMIT}-124-1-{name}'
                args=SimpleNamespace(online_recharge_only=True,commit=COMMIT,source_tree=TREE,expected_current=COMMIT,
                    repository=REPOSITORY,run_id='124',run_attempt='1',ci_run_id='234',
                    online_recharge_build_proof=base64.b64encode(json.dumps(build).encode()).decode())
                if missing=='f':path.unlink()
                elif missing=='source':f.stack.enter_context(patch.object(scope,'_pending_workspace_current_source_inventory',side_effect=RuntimeError('SOURCE_UNAVAILABLE')))
                else:(f.qa if missing=='q-a' else f.qb).unlink()
                with self.assertRaises((RuntimeError,OSError)):scope._release_locked(f.d,args)
                f.a_reader.assert_not_called();f.d.compose.assert_not_called();f.d.sync_new_table_grants.assert_not_called();f.d.point_current.assert_not_called()

    def test_policy_group_hashes_are_the_actual_reviewed_five_files(self):
        self.assertEqual(len(scope._AFTER_BIT_BANK_POLICY_FILES),5)
        self.assertEqual(len(set(scope._AFTER_BIT_BANK_POLICY_FILES)-scope._PENDING_WORKSPACE_RECEIPT_COMPATIBILITY_FILES),4)
        for name,(before_hash,after_hash) in scope._AFTER_BIT_BANK_POLICY_FILES.items():
            before=subprocess.check_output(['git','show','31d2c6885a45817cd40d23fce8d6145bc9f18af2:'+name],cwd=ROOT)
            self.assertEqual(hashlib.sha256(before).hexdigest(),before_hash)
            self.assertEqual(hashlib.sha256(self.reviewed_policy_sources[name]).hexdigest(),after_hash)
            self.assertEqual(self.reviewed_policy_modes[name],'100644')

    def test_policy_group_source_test_mode_partial_and_other_source_drift_reject(self):
        for mutation in ('library','permission-test','acceptance-test','historical-test','online-test',
                'mode','partial','source-extra','worker-extra','original','cross-a','q-a','q-b'):
            with self.subTest(mutation=mutation),self.fixture(policy=True) as f:
                if mutation in ('q-a','q-b'):
                    (f.qa if mutation=='q-a' else f.qb).unlink()
                elif mutation=='original':f.inventory[scope.GRANT_SOURCE]['sha256']='0'*64
                elif mutation in ('source-extra','worker-extra'):
                    name='apps/api/src/id-business-v2/'+('online-recharge/unsealed.ts' if mutation=='source-extra' else 'auto-recharge/worker/unsealed.cjs')
                    f.candidate_inventory[name]={'sha256':'0'*64,'mode':'100644'}
                else:
                    name={'library':scope.GRANT_SOURCE,'permission-test':'scripts/production-database-access.test.mjs',
                        'acceptance-test':'scripts/acceptance-v2-production-database-access.mjs',
                        'historical-test':'scripts/production-release/api-admin-scope.test.py',
                        'online-test':'scripts/production-release/online-recharge-scope.test.py'}.get(mutation,scope.GRANT_SOURCE)
                    if mutation=='mode':f.candidate_inventory[name]['mode']='100755'
                    elif mutation=='partial':f.candidate_inventory[name]=copy.deepcopy(f.inventory[name])
                    elif mutation!='cross-a':f.candidate_inventory[name]['sha256']='0'*64
                if mutation=='cross-a':
                    bridge=f.reader.online_after_bit_cold(f.d,f.old,expected_commit=COMMIT)
                    bridge['kind']=scope.ONLINE_PENDING_WORKSPACE_KIND
                    with self.assertRaises(RuntimeError):scope._pending_workspace_profile(f.d,bridge,f.producer)
                else:
                    with self.assertRaises((RuntimeError,OSError)):scope.preflight(f.d,COMMIT)
                f.a_reader.assert_not_called();f.d.compose.assert_not_called();f.d.sync_new_table_grants.assert_not_called();f.d.point_current.assert_not_called()

    def test_actual_policy_protected_gate_rechecks_cold_group_original_and_workers(self):
        with self.fixture(policy=True) as f:
            self.preflight_and_f(f);target=f.base/'policy-candidate';target.mkdir(mode=0o700)
            for name in scope._AFTER_BIT_BANK_POLICY_FILES:
                dest=target/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(self.reviewed_policy_sources[name]);dest.chmod(0o644)
            protected=('apps/api/src/id-business-v2/auto-recharge/worker/fixture.cjs',
                'apps/api/src/id-business-v2/auto-registration/fixture.cjs',
                'scripts/v2-data-integrity-audit.mjs','scripts/lib/v2-data-integrity-audit.mjs','scripts/sync-v2-new-table-grants.mjs')
            for name in protected:
                dest=target/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes((f.old/name).read_bytes());dest.chmod(0o644)
            scope.protected_source(f.d,f.old,target)
            for name in (*scope._AFTER_BIT_BANK_POLICY_FILES,*protected):
                for directory in ((f.old,target) if name in scope._AFTER_BIT_BANK_POLICY_FILES else (target,)):
                    dest=directory/name;raw=dest.read_bytes();dest.write_bytes(raw+b'UNSEALED')
                    with self.subTest(name=name,original=directory==f.old),self.assertRaises(RuntimeError):scope.protected_source(f.d,f.old,target)
                    dest.write_bytes(raw)
            f.qb.unlink()
            with self.assertRaises((RuntimeError,OSError)):scope.protected_source(f.d,f.old,target)
            f.a_reader.assert_not_called();f.d.compose.assert_not_called();f.d.sync_new_table_grants.assert_not_called();f.d.point_current.assert_not_called()

    def test_unreviewed_current_policy_test_file_cannot_enter_fixed_group(self):
        name='scripts/production-release/online-recharge-scope.test.py'
        current=(ROOT/name).read_bytes()
        self.assertNotEqual(current,self.reviewed_policy_sources[name])
        with self.fixture(policy=True) as f:
            self.preflight_and_f(f);target=f.base/'unreviewed-policy-candidate';target.mkdir(mode=0o700)
            for path,raw in self.reviewed_policy_sources.items():
                dest=target/path;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(raw);dest.chmod(0o644)
            for path in ('apps/api/src/id-business-v2/auto-recharge/worker/fixture.cjs',
                    'apps/api/src/id-business-v2/auto-registration/fixture.cjs',
                    'scripts/v2-data-integrity-audit.mjs','scripts/lib/v2-data-integrity-audit.mjs',
                    'scripts/sync-v2-new-table-grants.mjs'):
                dest=target/path;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes((f.old/path).read_bytes());dest.chmod(0o644)
            (target/name).write_bytes(current)
            with self.assertRaisesRegex(RuntimeError,'SHARED_GATE_SOURCE_CHANGED'):
                scope.protected_source(f.d,f.old,target)
            f.d.compose.assert_not_called();f.d.point_current.assert_not_called()

    def test_formal_b_stage_existing_api_origin_and_ordinary_readback(self):
        self.formal_stage()

    def test_formal_b_policy_group_stage_readback_and_client(self):
        self.formal_stage(policy=True)

    def test_formal_b_guard_sqlite_stop_and_final_proof_failures_release_fences_before_any_new_api(self):
        for failure in ('fence', 'sqlite-prepare', 'before-stop', 'stop', 'after-stop', 'confirm'):
            with self.subTest(failure=failure): self.formal_stage(failure=failure)

    def formal_stage(self,policy=False,failure=None,confirmation=None):
        with self.fixture(policy=policy) as f:
            result,raw,path=self.preflight_and_f(f);bridge=result['onlineAfterBitOrigin'];events=[]
            build=proof();build.update(kind='ONLINE_RECHARGE_AFTER_BIT_BUILD_PROOF',version=2,baselineCommit=COMMIT,
                commit=f.producer['commit'],sourceTree=f.producer['sourceTree'],
                baselineOriginSha256=scope.fingerprint(bridge),preflightBytesSha256=hashlib.sha256(raw).hexdigest(),
                engineSourceSha256=scope.fingerprint({'worker.cjs':hashlib.sha256(b'synthetic').hexdigest()}),
                composeSourceSha256=hashlib.sha256(b'synthetic-compose').hexdigest())
            for n in build['images']:build['images'][n]['reference']=f"{REPOSITORY}:{f.producer['commit']}-124-1-{n}"
            after=states(True)
            for n in scope.UPDATED:after[n].update(image=build['images'][n]['imageId'],reference=build['images'][n]['reference'])
            args=SimpleNamespace(online_recharge_only=True,commit=f.producer['commit'],source_tree=f.producer['sourceTree'],expected_current=COMMIT,
                repository=REPOSITORY,run_id='124',run_attempt='1',ci_run_id='234',
                online_recharge_build_proof=base64.b64encode(json.dumps(build).encode()).decode())
            (f.old/'compose.release.json').write_text(json.dumps({'services':{n:{'image':r['reference']} for n,r in bridge['services'].items()}}))
            def extract(d,commit,target):
                for name in scope.CONTROL_FILES:
                    dest=target/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes((ROOT/name).read_bytes())
                engine=target/scope.ENGINE_ROOT;engine.mkdir(parents=True);(engine/'worker.cjs').write_bytes(b'synthetic')
                (target/'docker-compose.aws-mysql.yml').write_bytes(b'synthetic-compose')
                if policy:
                    for name in scope._AFTER_BIT_BANK_POLICY_FILES:
                        dest=target/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(self.reviewed_policy_sources[name]);dest.chmod(0o644)
                    for name in ('apps/api/src/id-business-v2/auto-recharge/worker/fixture.cjs',
                            'apps/api/src/id-business-v2/auto-registration/fixture.cjs',
                            'scripts/v2-data-integrity-audit.mjs','scripts/lib/v2-data-integrity-audit.mjs',
                            'scripts/sync-v2-new-table-grants.mjs'):
                        dest=target/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(b'SYNTHETIC_PROTECTED');dest.chmod(0o644)
                return b'SYNTHETIC_ARCHIVE'
            def point(target,name):
                events.append('point');(f.base/'current').unlink();(f.base/'current').symlink_to(target)
            class Fence:
                def __init__(self,*a,**k):
                    self.query=f.reader.ONLINE_AUDIT_QUERY
                    self.source_api_identity={n:bridge['services']['api'][n] for n in ('containerId','image','startedAtSha256')}
                def __enter__(self):
                    events.append('fence')
                    if failure=='fence':
                        events.append('unfence');raise RuntimeError('SYNTHETIC_GUARD_FAILED')
                    return self
                def before_stop(self):
                    events.append('before-stop')
                    if failure=='before-stop':raise RuntimeError('SYNTHETIC_GUARD_FAILED')
                def check(self):
                    if failure=='after-stop' and 'old-api-stopped' in events:raise RuntimeError('SYNTHETIC_GUARD_FAILED')
                def confirm_stopped(self,gate):
                    events.append('stopped-proof')
                    if confirmation is not None:return confirmation()
                    if failure=='confirm':raise RuntimeError('SYNTHETIC_GUARD_FAILED')
                    return {'synthetic':True}
                def __exit__(self,*a):events.append('unfence')
            class Gate:
                d=f.d
                deadline=scope.time.monotonic()+150
                api_identity={n:bridge['services']['api'][n] for n in ('containerId','image','startedAtSha256')}
                record={'synthetic':True}
                def stop_previous(self):
                    self.d.run('docker','stop','--time','30',bridge['services']['api']['containerId'],timeout=45)
                    events.append('old-api-stopped')
                    if failure=='stop':raise RuntimeError('SYNTHETIC_STOP_FAILED')
                def finish(self):events.append('finish')
                def close(self):events.append('sqlite-close')
                def abort(self):events.append('abort')
            f.reader.WorkspaceUnusedAuditBarrier=Fence;f.reader.workspace_prepare=MagicMock(return_value=Gate())
            f.reader.workspace_database_identity=MagicMock(return_value={'database':'fixture',
                'environmentSha256':hashlib.sha256((f.old/'.env.aws.production').read_bytes()).hexdigest(),
                'mysql':bridge['services']['mysql']})
            f.reader.jobs_idle=MagicMock(return_value={'rechargeIdle':True,'registrationBusy':False,
                'registrationLeaseActive':False,'registrationWindowRetained':False})
            if failure=='sqlite-prepare':f.reader.workspace_prepare.side_effect=RuntimeError('SYNTHETIC_SQLITE_FAILED')
            if failure is not None:
                def rollback(*a,**k):events.append('rollback');return True,{}
                f.stack.enter_context(patch.object(scope,'rollback',side_effect=rollback))
            f.reader.source_tree=MagicMock(return_value=f.producer['sourceTree']);f.reader.audit_receipt=MagicMock(return_value=f.audit)
            f.d.__file__=str(ROOT/'scripts/production-release/remote-deploy.py');f.d.environment_values=env_values
            f.d.fresh_backup=MagicMock(return_value={'s3Verified':True,'name':'synthetic.sql.gz'})
            f.d.run=MagicMock(return_value='SYNTHETIC_ECR_LOGIN');f.d.wait_healthy=MagicMock()
            f.d.point_current=MagicMock(side_effect=point)
            f.d.compose=MagicMock(side_effect=lambda folder,*a,**k:events.append('switch:'+a[-1]))
            f.d.sync_new_table_grants=MagicMock(return_value={'ok':True,'newTableCount':9})
            f.stack.enter_context(patch.dict(scope._PENDING_WORKSPACE_FIRST,historical_guard=lambda *a:None))
            for name,value in {'extract_source':extract,**({} if policy else {'protected_source':MagicMock()}),'verify_image_content':MagicMock(),
                    'verify_running':MagicMock(),'configuration_hashes':MagicMock(return_value=f.config),
                    'migration_database_state':MagicMock(return_value=f.recovery['state']),
                    'require_preserved':lambda *a,**k:(after if k.get('include_engine') else bridge['services'],{}),
                    'backup_receipt':MagicMock(),'workspace_backup_receipt':MagicMock(),'_pending_workspace_sqlite_receipt':MagicMock(),
                    '_online_after_bit_unused_audit_barrier':lambda *a:Fence(),
                    '_online_after_bit_audit_receipt':lambda d,directory,bridge,proof,manifest,record:{
                        'afterBitAuditProtectionSha256':scope.fingerprint(record['afterBitAuditProtection']),
                        'preservedRegistrationAuditCount':9,'auditHistoryCutoff':'2026-10-11 00:00:01.000001'},
                    'workspace_backup':MagicMock(return_value={'name':'synthetic.sqlite3.gz','s3Verified':True}),
                    'extend_environment':lambda d,old,new:(new/'.env.aws.production').write_bytes((old/'.env.aws.production').read_bytes()),
                    'snapshot':lambda *a,**k:after if k.get('include_engine') else bridge['services'],
                    'release_source_inventory':MagicMock(return_value=f.candidate_inventory),'fixed_recovery_inventory':MagicMock(return_value=f.inventory)}.items():
                f.stack.enter_context(patch.object(scope,name,value))
            response=MagicMock();response.__enter__.return_value.status=200
            f.stack.enter_context(patch.object(scope.subprocess,'run',return_value=SimpleNamespace(returncode=0)))
            f.stack.enter_context(patch.object(scope.urllib.request,'urlopen',return_value=response))
            output=io.StringIO()
            with redirect_stdout(output):code=scope._release_locked(f.d,args)
            if failure is not None:
                self.assertEqual(code,1,output.getvalue())
                self.assertNotIn('switch:api',events);self.assertNotIn('switch:online-recharge',events)
                if failure=='sqlite-prepare':
                    self.assertNotIn('fence',events);self.assertNotIn('unfence',events)
                else:self.assertIn('unfence',events)
                if failure not in ('fence','sqlite-prepare'):
                    self.assertLess(events.index('unfence'),events.index('sqlite-close'))
                    self.assertLess(events.index('sqlite-close'),events.index('rollback'))
                    self.assertLess(events.index('rollback'),events.index('abort'))
                self.assertNotIn('finish',events)
                return json.loads(output.getvalue()),events
            self.assertEqual(code,0,output.getvalue());q=json.loads(output.getvalue())
            self.assertEqual(q['onlineAfterBitOrigin'],bridge);self.assertNotIn('onlinePendingWorkspaceOrigin',q)
            self.assertFalse(q['migrationPerformed']);self.assertEqual(q['checkCount'],49)
            self.assertEqual([e for e in events if e.startswith('switch:')],['switch:admin','switch:api','switch:online-recharge'])
            self.assertLess(events.index('old-api-stopped'),events.index('switch:api'));self.assertIn('finish',events)
            self.assertLess(events.index('old-api-stopped'),events.index('stopped-proof'))
            self.assertLess(events.index('stopped-proof'),events.index('unfence'))
            self.assertEqual(q['preservedRegistrationAuditCount'],9)
            self.assertEqual(q['afterBitAuditProtectionSha256'],scope.fingerprint({'synthetic':True}))
            f.a_reader.assert_not_called();f.d.compose.assert_any_call(unittest.mock.ANY,'up','-d','--no-deps','--no-build','--pull','never','--force-recreate','api',timeout=300)
            f.d.sync_new_table_grants.assert_called_once();self.assertEqual(f.d.point_current.call_count,1)
            # Independent Q re-enters the existing API B origin and ordinary ONLINE body.
            self.assertEqual(scope.readback(f.d,f.producer['commit'])['onlineAfterBitOrigin'],bridge)
            transport=load('formal_b_readonly_client','online-recharge-readonly.py')
            client=f.base/'client';client.mkdir(mode=0o700)
            invocation={'CommandId':json.loads(raw)['commandId'],'InstanceId':'i-12345678901234567',
                'DocumentName':'AWS-RunShellScript','PluginName':'aws:runShellScript','Status':'Success','ResponseCode':0,
                'ExecutionEndDateTime':'2026-01-01T00:00:00Z','StandardErrorContent':'','StandardOutputContent':json.dumps(result)}
            for name,data in {'online-recharge-pending-workspace-preflight-result.json':raw,
                    'online-recharge-pending-workspace-preflight-invocation.json':json.dumps(invocation).encode(),
                    'online-recharge-build-proof.json':json.dumps(build).encode()}.items():
                item=client/name;item.write_bytes(data);item.chmod(0o600)
            with patch.dict(os.environ,EXPECTED_CURRENT=COMMIT,PRODUCTION_INSTANCE_ID=invocation['InstanceId']), \
                    patch.object(transport,'_pending_workspace_modules',return_value=(f.d,scope,None)):
                client_q=transport.pending_workspace_client_binding(q,'readback',f.producer,client)
            self.assertEqual(client_q['onlineAfterBitOrigin'],bridge)
            self.assertNotIn('onlinePendingWorkspaceOrigin',client_q);f.a_reader.assert_not_called()



class AfterBitUnusedAuditBarrierTests(unittest.TestCase):
    """Real immutable API pipe/lock factory; only external acquisition is synthetic."""
    @contextmanager
    def fixture(self, *, eof=False, malformed=False):
        with tempfile.TemporaryDirectory(prefix='b-audit-', dir=RUNTIME) as temporary, ExitStack() as stack:
            base = Path(temporary)
            directory = base / 'releases' / ('20261011T000000Z-' + COMMIT[:12])
            directory.mkdir(parents=True)
            for migration in ('20261002123500_routine_audit_retention_exception', '20260830182500_mysql_trigger_service_definers'):
                name = shared.MIGRATION_ROOT + '/' + migration + '/migration.sql'
                dest = directory / name; dest.parent.mkdir(parents=True, exist_ok=True); dest.write_bytes((ROOT / name).read_bytes())
            stamp = '2026-10-11T00:00:00.123456789Z'
            identity = {'containerId': 'a' * 64, 'image': 'sha256:' + 'c' * 64, 'startedAt': stamp,
                'startedAtSha256': hashlib.sha256(stamp.encode()).hexdigest()}
            before = states()
            before['api'].update({n: identity[n] for n in ('containerId', 'image', 'startedAtSha256')})
            mysql_stamp, environment = '2026-10-10T00:00:00.000000000Z', ['SAFE_FIXTURE=1']
            before['mysql'].update(startedAtSha256=hashlib.sha256(mysql_stamp.encode()).hexdigest(),
                environmentSha256=scope.fingerprint(environment))
            holder = SimpleNamespace(stopped=False, pid=0, mysql=copy.deepcopy(before['mysql']))
            def inspect(*args, **kw):
                cid = args[-1]
                if cid == identity['containerId']:
                    return json.dumps([{'Id': cid, 'Image': identity['image'], 'State': {'StartedAt': stamp,
                        'Running': not holder.stopped, 'Pid': holder.pid}}])
                row = holder.mysql
                return json.dumps([{'Id': row['containerId'], 'Image': row['image'],
                    'Config': {'Image': row['reference'], 'Env': environment}, 'State': {'StartedAt': mysql_stamp,
                        'Status': row['status'], 'Health': {'Status': row['health']}}}])
            d = controller(BASE=base, current_job_database=MagicMock(return_value='fixture'), run=MagicMock(side_effect=inspect),
                service_state=MagicMock(side_effect=lambda folder, name, **kw: before[name]))
            bridge = {name: '1' * 64 for name in scope.ONLINE_PENDING_WORKSPACE_FIELDS if name.endswith('Sha256')}
            bridge.update(kind=scope.ONLINE_AFTER_BIT_KIND, version=1, baselineRelease=str(directory), baselineCommit=COMMIT,
                baselineProducer={'commit': COMMIT, 'sourceTree': TREE, 'workflowRunId': '123', 'workflowRunAttempt': '1'},
                readbackCommandId='00000000-0000-0000-0000-000000000002', initialReadbackInvocationBytesSha256='2' * 64,
                originalWorkspace={'release': '/opt/id-business-v2/releases/20261009T000000Z-' + scope.BASELINE_COMMIT[:12], 'manifestSha256': '3' * 64},
                migrationRecovery=scope.recovery_marker(scope.recovery_policy(d)),
                migrationState={'name': scope.MIGRATION_NAME, 'sha256': scope.MIGRATION_IDENTITY['sha256'], 'status': 'APPLIED',
                    'schemaVerified': True, 'appliedMigrationsSha256': '4' * 64}, services=before,
                configurationAfter={name: '5' * 64 for name in ('docker-compose.aws-mysql.yml', 'deploy/caddy/Caddyfile.aws', scope.SCHEMA_FILE, 'compose.release.json')})
            scope.online_after_bit_bridge_shape(d, bridge)
            producer = {'commit': COMMIT, 'sourceTree': TREE, 'workflowRunId': '124', 'workflowRunAttempt': '1'}
            raw = b'SYNTHETIC_OWNED_F_O'
            build = proof(); build.update(kind='ONLINE_RECHARGE_AFTER_BIT_BUILD_PROOF', version=2,
                baselineCommit=COMMIT, baselineOriginSha256=scope.fingerprint(bridge), preflightBytesSha256=hashlib.sha256(raw).hexdigest())
            plan = scope._online_after_bit_audit_queries(d, shared, directory, identity)
            rows = [{'event': event, 'timing': 'BEFORE', 'statement': statement} for event, statement in plan['expectedTriggers'].items()]
            d.compose = MagicMock(side_effect=lambda folder, *args, **kw: holder.mysql['containerId'] if args[:3] == ('ps', '-q', 'mysql') else json.dumps(rows))
            cutoff = '2026-10-11 00:00:01.000001'
            frame = {'connectionId': 47, 'historicalRegistrationAuditCount': 9, 'historicalRegistrationPrefixCount': 9,
                'historyCutoff': cutoff, 'clockBeforeCutoff': 0, 'registrationMutationCount': 0, 'onlineAuditCount': 0,
                'tables': {name: 0 for name in shared.ONLINE_TABLES}, 'triggers': copy.deepcopy(rows)}
            prefix = {n: copy.deepcopy(frame[n]) for n in ('connectionId', 'historicalRegistrationPrefixCount', 'historyCutoff', 'clockBeforeCutoff', 'triggers')}
            frames_path, captured = base / 'frames.json', base / 'stdin.sql'
            def save(): frames_path.write_text(json.dumps({'publication': frame, 'prefix': prefix}))
            save()
            child = ('import json,sys\n'
                'for line in sys.stdin:\n'
                '    with open(sys.argv[1], "a") as output: output.write(line)\n'
                + ('    sys.exit(1)\n' if eof else '    print("{broken", flush=True)\n' if malformed else
                   '    with open(sys.argv[2]) as source: frames=json.load(source)\n'
                   '    key="publication" if "registrationMutationCount" in line else "prefix"\n'
                   '    print(json.dumps(frames[key]), flush=True)\n'))
            native, calls, processes = subprocess.Popen, [], []
            def spawn(command, **kwargs):
                calls.append((command, kwargs)); process = native([sys.executable, '-u', '-c', child, str(captured), str(frames_path)], **kwargs)
                processes.append(process); return process
            stack.enter_context(patch.object(shared.subprocess, 'Popen', side_effect=spawn))
            stack.enter_context(patch.object(scope, '_pending_workspace_session', return_value=(bridge, producer)))
            stack.enter_context(patch.object(scope, 'online_after_bit_preflight_bytes', return_value=raw))
            stack.enter_context(patch.object(scope, 'online_after_bit_build_shape', return_value=build))
            online_idle = stack.enter_context(patch.object(shared, 'online_idle'))
            workspace_idle = stack.enter_context(patch.object(shared, 'workspace_idle'))
            sqlite_record = {'sourceApiIdentity': {n: identity[n] for n in ('containerId', 'image', 'startedAtSha256')}, 'synthetic': True}
            sqlite = SimpleNamespace(record=sqlite_record)
            try:
                yield SimpleNamespace(d=d, directory=directory, bridge=bridge, identity=identity, holder=holder, proof=build,
                    plan=plan, frame=frame, prefix=prefix, save=save, captured=captured, calls=calls, processes=processes,
                    stack=stack, sqlite=sqlite, online_idle=online_idle, workspace_idle=workspace_idle)
            finally:
                for process in processes:
                    if not process.stdin.closed: process.stdin.close()
                    if process.poll() is None: process.wait(timeout=3)
                    if not process.stdout.closed: process.stdout.close()

    def barrier(self, f):
        return scope._online_after_bit_unused_audit_barrier(f.d, f.directory, f.bridge, f.proof)

    def publication(self, f):
        with self.barrier(f) as barrier:
            barrier.before_stop(); f.holder.stopped = True; barrier.check(); receipt = barrier.confirm_stopped(f.sqlite)
        path = f.directory / shared.WORKSPACE_SQLITE_RECEIPT
        path.write_text(json.dumps(f.sqlite.record)); path.chmod(0o600)
        # Production serializes the record; keep the trusted fixture session separate.
        receipt = json.loads(json.dumps(receipt))
        record = {'afterBitAuditProtection': receipt, 'sqliteProtectionSha256': scope.fingerprint(f.sqlite.record)}
        manifest = {'deployedAt': '2026-10-11T00:00:02Z', 'onlineRechargePublication': {'afterBitAuditProtectionSha256': scope.fingerprint(receipt)}}
        return manifest, record

    def test_cutoff_parser_accepts_docker_nanoseconds_and_preserves_exact_time_boundary(self):
        with self.fixture() as f:
            def plan(stamp, cutoff):
                identity = dict(f.identity, startedAt=stamp, startedAtSha256=hashlib.sha256(stamp.encode()).hexdigest())
                return scope._online_after_bit_audit_queries(f.d, shared, f.directory, identity, history_cutoff=cutoff)
            actual = plan('2026-10-11T13:37:28.606112575Z', '2026-10-11 16:42:07.011897')
            self.assertIn('CAST(CONVERT(0x', actual['frameQuery'])
            for fraction in ('1','12','123','1234','12345','123456','123456000'):
                cutoff = '2026-10-11 00:00:00.' + fraction[:6].ljust(6, '0')
                plan('2026-10-11T00:00:00.' + fraction + 'Z', cutoff)
            for stamp, floor, ceil in (
                    ('2026-10-11T00:00:00.123456789Z','2026-10-11 00:00:00.123456','2026-10-11 00:00:00.123457'),
                    ('2026-10-11T00:00:00.999999999Z','2026-10-11 00:00:00.999999','2026-10-11 00:00:01.000000')):
                with self.assertRaises(RuntimeError): plan(stamp, floor)
                plan(stamp, ceil)
            plan('2026-10-11T00:00:00Z', '2026-10-11 00:00:00.000000')
            for stamp, cutoff in (
                    ('2026-02-30T00:00:00.123456789Z','2026-10-11 00:00:00.123457'),
                    ('2026-10-11T00:00:00.123456789Z','2026-02-30 00:00:00.123457'),
                    ('2026-10-11T00:00:00.123456789Z','2026-10-11 00:00:00.123456789')):
                with self.assertRaises(RuntimeError): plan(stamp, cutoff)

    def test_real_first_frame_fixed_cutoff_history_and_exact_read_locks(self):
        with self.fixture() as f:
            barrier = self.barrier(f)
            self.assertIs(type(barrier).__mro__[1], shared.WorkspaceUnusedAuditBarrier)
            initial = f.plan['frameQuery']
            with barrier:
                self.assertIs(type(barrier.pipe), shared.WorkspacePipe)
                self.assertEqual(barrier.connection_id, 47)
                self.assertEqual(barrier.before['historicalRegistrationAuditCount'], 9)
                bound = scope._online_after_bit_audit_queries(f.d, shared, f.directory, f.identity, history_cutoff=f.frame['historyCutoff'])
                self.assertEqual(barrier.query, bound['frameQuery'])
                barrier.check(); barrier.before_stop(); barrier.check()
            self.assertEqual(f.captured.read_text().splitlines(), ['SET SESSION autocommit=0; SET SESSION lock_wait_timeout=10; '
                'SET SESSION wait_timeout=240; LOCK TABLES ' + ','.join('`' + name + '` READ' for name in ('audit_logs', *shared.ONLINE_TABLES))
                + '; ' + initial + ';', *([bound['frameQuery'] + ';'] * 3)])
            self.assertEqual(len(f.calls), 1)
            command, kwargs = f.calls[0]
            self.assertEqual(command[:7], ['docker', 'exec', '-i', '-e', 'MYSQL_DATABASE=fixture', 'd' * 64, 'sh'])
            self.assertIn('--skip-reconnect', command[-1])
            self.assertEqual(kwargs, {'stdin': subprocess.PIPE, 'stdout': subprocess.PIPE, 'stderr': subprocess.DEVNULL})
            self.assertTrue(barrier.pipe.process.stdin.closed and barrier.pipe.process.stdout.closed)
            self.assertIsNotNone(barrier.pipe.process.poll())

    def test_first_frame_eof_and_invalid_json_close_original_transport(self):
        for mode in ('eof', 'malformed'):
            with self.subTest(mode=mode), self.fixture(**{mode: True}) as f:
                barrier = self.barrier(f)
                with self.assertRaises((RuntimeError, ValueError)): barrier.__enter__()
                self.assertTrue(barrier.pipe.process.stdin.closed and barrier.pipe.process.stdout.closed)
                self.assertIsNotNone(barrier.pipe.process.poll())

    def test_current_mutation_online_audit_and_every_new_business_table_reject(self):
        for item in ('registrationMutationCount', 'onlineAuditCount', *shared.ONLINE_TABLES):
            with self.subTest(item=item), self.fixture() as f:
                if item in f.frame: f.frame[item] = 1
                else: f.frame['tables'][item] = 1
                f.save(); barrier = self.barrier(f)
                with self.assertRaisesRegex(RuntimeError, '^ONLINE_RECHARGE_AFTER_BIT_AUDIT_GUARD_LOST$'): barrier.__enter__()
                self.assertTrue(barrier.pipe.process.stdin.closed and barrier.pipe.process.stdout.closed)

    def test_arbitrary_actual_nonzero_history_is_preserved_without_a_fixed_accepted_count(self):
        for count in (1, 9, 137):
            with self.subTest(count=count), self.fixture() as f:
                f.frame.update(historicalRegistrationAuditCount=count, historicalRegistrationPrefixCount=count)
                f.prefix['historicalRegistrationPrefixCount'] = count; f.save()
                manifest, record = self.publication(f)
                self.assertEqual(record['afterBitAuditProtection']['before']['historicalRegistrationAuditCount'], count)
                self.assertEqual(scope._online_after_bit_audit_receipt(f.d, f.directory, f.bridge, f.proof, manifest, record)
                    ['preservedRegistrationAuditCount'], count)

    def test_same_connection_history_cutoff_shape_and_process_drift_reject(self):
        for mutation in ('connection', 'history', 'prefix', 'cutoff', 'clock', 'bool', 'extra', 'dead', 'mysql'):
            with self.subTest(mutation=mutation), self.fixture() as f, self.barrier(f) as barrier, ExitStack() as changes:
                value = copy.deepcopy(f.frame)
                if mutation == 'connection': value['connectionId'] += 1
                elif mutation == 'history': value['historicalRegistrationAuditCount'] += 1
                elif mutation == 'prefix': value['historicalRegistrationPrefixCount'] += 1
                elif mutation == 'cutoff': value['historyCutoff'] = '2026-10-11 00:00:02.000001'
                elif mutation == 'clock': value['clockBeforeCutoff'] = 1
                elif mutation == 'bool': value['tables'][shared.ONLINE_TABLES[0]] = False
                elif mutation == 'extra': value['tables']['unknown'] = 0
                elif mutation == 'dead': changes.enter_context(patch.object(barrier.pipe.process, 'poll', return_value=1))
                else: f.holder.mysql['containerId'] = 'e' * 64
                with self.assertRaises(RuntimeError): barrier.check(value)

    def test_future_dated_old_rows_bad_cutoff_and_changed_triggers_close_the_first_guard(self):
        for mutation in ('future-row', 'before-boot', 'malformed', 'trigger-delete', 'trigger-update', 'trigger-extra'):
            with self.subTest(mutation=mutation), self.fixture() as f:
                if mutation == 'future-row': f.frame['historicalRegistrationPrefixCount'] -= 1
                elif mutation == 'before-boot': f.frame['historyCutoff'] = '2026-10-11 00:00:00.123456'
                elif mutation == 'malformed': f.frame['historyCutoff'] = '2026-10-11 00:00:01'
                elif mutation == 'trigger-extra': f.frame['triggers'].append(copy.deepcopy(f.frame['triggers'][0]))
                else: f.frame['triggers'][0 if mutation == 'trigger-delete' else 1]['statement'] += ' changed'
                f.save(); barrier = self.barrier(f)
                with self.assertRaises(RuntimeError): barrier.__enter__()
                self.assertTrue(barrier.pipe.process.stdin.closed and barrier.pipe.process.stdout.closed)
        with self.fixture() as f:
            f.d.compose.side_effect = None; f.d.compose.return_value = '[]'
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_WORKSPACE_AUDIT_HISTORY_UNPROVEN$'): self.barrier(f)
            self.assertEqual(f.calls, [])

    def test_before_stop_rechecks_original_api_identity_and_stronger_deadline(self):
        with self.fixture() as f, self.barrier(f) as barrier:
            barrier.pipe.deadline = shared.time.monotonic() + 169
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_WORKSPACE_GUARD_TIMEOUT$'): barrier.before_stop()
        with self.fixture() as f, self.barrier(f) as barrier:
            now=shared.time.monotonic();barrier.pipe.deadline=now+170
            with patch.object(shared.time,'monotonic',return_value=now):
                with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_WORKSPACE_GUARD_TIMEOUT$'):barrier.before_stop()
        with self.fixture() as f, self.barrier(f) as barrier:
            now=shared.time.monotonic();barrier.pipe.deadline=now+170.001
            with patch.object(shared.time,'monotonic',return_value=now):barrier.before_stop()
        with self.fixture() as f, self.barrier(f) as barrier:
            f.holder.stopped = True
            with self.assertRaises(RuntimeError): barrier.before_stop()

    def test_stop_pid_identity_and_sqlite_bindings_are_required_before_release(self):
        for mutation in ('running', 'pid', 'sqlite'):
            with self.subTest(mutation=mutation), self.fixture() as f, self.barrier(f) as barrier:
                barrier.before_stop()
                f.holder.stopped = mutation != 'running'
                if mutation == 'pid': f.holder.pid = 1
                if mutation == 'sqlite': f.sqlite.record['sourceApiIdentity']['containerId'] = 'f' * 64
                barrier.check()
                with self.assertRaisesRegex(RuntimeError, '^ONLINE_RECHARGE_AFTER_BIT_AUDIT_GUARD_LOST$'): barrier.confirm_stopped(f.sqlite)
                self.assertIsNone(barrier.receipt)

    def test_child_exit_or_frame_drift_during_stopped_inspect_never_issues_receipt_or_starts_new_api(self):
        original = {n:getattr(scope,n) for n in ('_pending_workspace_session','online_after_bit_preflight_bytes','online_after_bit_build_shape')}
        for mutation in ('child-exit', 'history-drift', 'connection-drift'):
            with self.subTest(mutation=mutation), self.fixture() as f, self.barrier(f) as barrier:
                barrier.before_stop(); f.holder.stopped=True; barrier.check()
                inspect = f.d.run.side_effect
                def stopped_inspect(*args,**kw):
                    result=inspect(*args,**kw)
                    if args[-1]==f.identity['containerId']:
                        if mutation=='child-exit':
                            barrier.pipe.process.terminate();barrier.pipe.process.wait(timeout=3)
                        elif mutation=='history-drift':
                            f.frame['historicalRegistrationAuditCount']+=1;f.save()
                        else:
                            f.frame['connectionId']+=1;f.save()
                    return result
                f.d.run.side_effect=stopped_inspect
                # The real guard failure reaches the existing release caller;
                # other external release acquisition remains explicitly synthetic.
                helper=AfterBitFormalTests();helper.addCleanup=self.addCleanup
                with patch.multiple(scope,**original):
                    helper.formal_stage(failure='confirm-live-guard',confirmation=lambda:barrier.confirm_stopped(f.sqlite))
                self.assertIsNone(barrier.receipt)

    def test_unknown_query_tables_legacy_predicate_and_captured_factory_query_reject_before_transport(self):
        original, anchor = shared.ONLINE_AUDIT_QUERY, 'CONVERT(0xe887aae58aa8e6b3a8e5868c USING utf8mb4)'
        queries = (original.replace(anchor, "'different'"), original + anchor, original.replace(anchor, anchor + ' COLLATE utf8mb4_unicode_ci'),
            original.replace("module='online_recharge'", "module='changed'"), original + ' ')
        for query in queries:
            with self.subTest(query=query), self.fixture() as f, patch.object(shared, 'ONLINE_AUDIT_QUERY', query):
                with self.assertRaises(RuntimeError): self.barrier(f)
                self.assertEqual(f.calls, [])
        with self.fixture() as f, patch.object(shared, 'ONLINE_TABLES', (*shared.ONLINE_TABLES, 'unknown')):
            with self.assertRaises(RuntimeError): self.barrier(f)
            self.assertEqual(f.calls, [])
        with self.fixture() as f, patch.object(shared, 'WorkspaceAuditBarrier', return_value=SimpleNamespace(api_identity=f.identity, QUERY=f.plan['legacyRegistrationQuery']+' ')):
            with self.assertRaises(RuntimeError): self.barrier(f)
            self.assertEqual(f.calls, [])
        globals_ = shared.WorkspaceUnusedAuditBarrier.__init__.__globals__
        with self.fixture() as f, patch.dict(globals_, ONLINE_AUDIT_QUERY=original+' '):
            with self.assertRaises(RuntimeError): self.barrier(f)
            self.assertEqual(f.calls, [])

    def test_future_clock_and_original_millisecond_predicate_are_exact(self):
        with self.fixture() as f:
            actual = shared.WorkspaceAuditBarrier(f.d, f.directory).QUERY
            self.assertEqual(actual, f.plan['legacyRegistrationQuery'])
            self.assertEqual(f.plan['frameQuery'].count('FROM audit_logs'), 1)
            stamp = '2026-10-11 00:00:00.123'.encode().hex()
            self.assertIn('IF(UTC_TIMESTAMP(6)<CAST(CONVERT(0x'+stamp+' USING utf8mb4) AS DATETIME(6)),1,', f.plan['frameQuery'])
            f.frame['registrationMutationCount'] = 1; f.save(); barrier = self.barrier(f)
            with self.assertRaises(RuntimeError): barrier.__enter__()

    def test_independent_readback_preserves_prefix_and_permits_legitimate_later_rows(self):
        with self.fixture() as f:
            manifest, record = self.publication(f)
            f.frame.update(historicalRegistrationAuditCount=21, historicalRegistrationPrefixCount=9,
                registrationMutationCount=4, onlineAuditCount=7, tables={n: 3 for n in shared.ONLINE_TABLES}); f.save()
            result = scope._online_after_bit_audit_receipt(f.d, f.directory, f.bridge, f.proof, manifest, record)
            self.assertEqual(result['preservedRegistrationAuditCount'], 9)
            self.assertEqual(result['auditHistoryCutoff'], f.frame['historyCutoff'])
            self.assertEqual(result['afterBitAuditProtectionSha256'], scope.fingerprint(record['afterBitAuditProtection']))
            self.assertEqual(f.online_idle.call_count, 2); self.assertEqual(f.workspace_idle.call_count, 2)
            final = f.captured.read_text().splitlines()[-1]
            self.assertNotIn('registrationMutationCount', final); self.assertNotIn('online_recharge_cards', final)
            self.assertIn('historicalRegistrationPrefixCount', final)

    def test_readback_history_deletion_clock_trigger_or_connection_drift_still_reject(self):
        for mutation in ('history', 'clock', 'trigger', 'connection'):
            with self.subTest(mutation=mutation), self.fixture() as f:
                manifest, record = self.publication(f)
                if mutation == 'history': f.prefix['historicalRegistrationPrefixCount'] -= 1
                elif mutation == 'clock': f.prefix['clockBeforeCutoff'] = 1
                elif mutation == 'trigger': f.prefix['triggers'][0]['statement'] += ' altered'
                else: f.prefix['connectionId'] = 0
                f.save()
                with self.assertRaises(RuntimeError): scope._online_after_bit_audit_receipt(f.d, f.directory, f.bridge, f.proof, manifest, record)
                self.assertTrue(f.processes[-1].stdin.closed and f.processes[-1].stdout.closed)

    def test_readback_current_online_or_workspace_activity_rejects_without_fake_zeros(self):
        for guard in ('online_idle', 'workspace_idle'):
            with self.subTest(guard=guard), self.fixture() as f:
                manifest, record = self.publication(f)
                getattr(f, guard).side_effect = RuntimeError('CURRENT_TASK_ACTIVE')
                before = len(f.calls)
                with self.assertRaisesRegex(RuntimeError, 'CURRENT_TASK_ACTIVE'):
                    scope._online_after_bit_audit_receipt(f.d, f.directory, f.bridge, f.proof, manifest, record)
                self.assertEqual(len(f.calls), before)

    def test_readback_real_idle_guards_accept_completed_rows_and_reject_each_active_state(self):
        online_idle, workspace_idle = shared.online_idle, shared.workspace_idle
        for active in (None, 'queued', 'running', 'task-lease', 'card-lease', 'engine-active', 'pending-registration', 'running-registration'):
            with self.subTest(active=active), self.fixture() as f, ExitStack() as checks:
                manifest, record = self.publication(f)
                volume = f.directory / 'sqlite'; volume.mkdir()
                with sqlite3.connect(volume/'database.db') as db:
                    db.execute('CREATE TABLE registration_tasks (status TEXT)')
                    db.executemany('INSERT INTO registration_tasks VALUES (?)', [('completed',),('cancelled',),('failed',)])
                    if active in ('pending-registration', 'running-registration'):
                        db.execute('INSERT INTO registration_tasks VALUES (?)', (active.split('-')[0],))
                run = f.d.run.side_effect
                f.d.run.side_effect = lambda *args,**kw: (json.dumps([{'Mountpoint':str(volume)}])
                    if args[:3] == ('docker','volume','inspect') else run(*args,**kw))
                state = f.d.service_state.side_effect
                f.d.service_state.side_effect = lambda folder,name,**kw: (states(True)[name]
                    if name == shared.ONLINE_SERVICE else state(folder,name,**kw))
                checks.enter_context(patch.dict(workspace_idle.__globals__,workspace_volume=MagicMock(return_value={'status':'PRESENT','name':'fixture'})))
                checks.enter_context(patch.object(shared,'online_idle',online_idle))
                checks.enter_context(patch.object(shared,'workspace_idle',workspace_idle))
                checks.enter_context(patch.dict(online_idle.__globals__,online_reader=MagicMock(return_value=scope)))
                checks.enter_context(patch.object(shared,'jobs_idle',return_value={}))
                checks.enter_context(patch.object(scope,'workspace_guard',return_value={}))
                checks.enter_context(patch.object(scope,'database_read',side_effect=lambda d,folder,query:{'busy':int(
                    active in ('queued','running','task-lease') if 'FROM online_recharge_tasks' in query else active=='card-lease')}))
                engine = shared.online_engine_idle
                def engine_check(d,metadata):
                    with patch.object(d,'run',return_value=json.dumps({'ready':True,'mode':'enabled',
                            'activeTasks':int(active=='engine-active'),'stopping':False,'rpcConnected':True})):
                        engine(d,metadata)
                checks.enter_context(patch.dict(online_idle.__globals__,online_engine_idle=engine_check))
                # This is a successor with legitimate rows, not first-C qualification.
                f.frame.update(historicalRegistrationAuditCount=21,registrationMutationCount=4,
                    onlineAuditCount=7,tables={n:3 for n in shared.ONLINE_TABLES}); f.save()
                before = len(f.calls)
                if active is None:
                    self.assertEqual(scope._online_after_bit_audit_receipt(f.d,f.directory,f.bridge,f.proof,manifest,record)
                        ['preservedRegistrationAuditCount'],9)
                else:
                    with self.assertRaises(RuntimeError):
                        scope._online_after_bit_audit_receipt(f.d,f.directory,f.bridge,f.proof,manifest,record)
                    self.assertEqual(len(f.calls),before)

    def test_readback_missing_cross_producer_query_sqlite_or_boolean_after_receipt_rejects(self):
        for mutation in ('missing', 'producer', 'source', 'query', 'history-query', 'initial-query', 'sqlite', 'pid', 'after-bool', 'cutoff', 'late-cutoff', 'digest'):
            with self.subTest(mutation=mutation), self.fixture() as f:
                manifest, record = self.publication(f)
                value = record['afterBitAuditProtection']
                if mutation == 'missing': value.pop('before')
                elif mutation == 'producer': value['basis']['producer']['workflowRunId'] = '999'
                elif mutation == 'source': value['basis']['sourceHelpers']['api-admin-scope.py'] = '0'*64
                elif mutation in ('query','history-query','initial-query'): value[{'query':'querySha256','history-query':'historyQuerySha256','initial-query':'initialQuerySha256'}[mutation]] = '0'*64
                elif mutation == 'sqlite': value['sqliteProtectionSha256'] = '0'*64
                elif mutation == 'pid': value['oldApiStop']['pid'] = 1
                elif mutation == 'after-bool': value['after']['tables'][shared.ONLINE_TABLES[0]] = False
                elif mutation == 'cutoff': value['before']['historyCutoff'] = value['after']['historyCutoff'] = '2026-10-11 00:00:00.123456'
                elif mutation == 'late-cutoff': value['before']['historyCutoff'] = value['after']['historyCutoff'] = '2026-10-11 00:00:03.000000'
                if mutation != 'digest': manifest['onlineRechargePublication']['afterBitAuditProtectionSha256'] = scope.fingerprint(value)
                else: manifest['onlineRechargePublication']['afterBitAuditProtectionSha256'] = '0'*64
                with self.assertRaises(RuntimeError): scope._online_after_bit_audit_receipt(f.d, f.directory, f.bridge, f.proof, manifest, record)

    def test_a_bridge_rejects_b_factory_and_reused_factories_constants_remain_exact_ast(self):
        import ast
        source = 'scripts/production-release/api-admin-scope.py'
        immutable = ast.parse(subprocess.check_output(['git', 'show', '34a2ad26def934dcaed6bdd1e3188ca977fcdc30:'+source], cwd=ROOT))
        actual = ast.parse((ROOT/source).read_text())
        names = {'WorkspacePipe', 'WorkspaceUnusedAuditBarrier', 'WorkspaceAuditBarrier', 'workspace_api_identity', 'workspace_audit_protection'}
        before = {n.name: ast.dump(n) for n in immutable.body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in names}
        after = {n.name: ast.dump(n) for n in actual.body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in names}
        self.assertEqual(before,after)
        constants = {'ONLINE_TABLES','ONLINE_AUDIT_QUERY','WORKSPACE_AUDIT_QUERY'}
        for name in constants:
            nodes = [next(n for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(v,ast.Name) and v.id==name for v in n.targets)) for tree in (immutable,actual)]
            self.assertEqual(ast.dump(nodes[0]),ast.dump(nodes[1]))
        with self.fixture() as f:
            a = copy.deepcopy(f.bridge); a['kind'] = scope.ONLINE_PENDING_WORKSPACE_KIND
            scope.online_pending_workspace_bridge_shape(f.d,a)
            with self.assertRaises(RuntimeError): scope._online_after_bit_unused_audit_barrier(f.d,f.directory,a,f.proof)
            for online,query in ((True,shared.ONLINE_AUDIT_QUERY),(False,shared.WORKSPACE_AUDIT_QUERY)):
                self.assertEqual(shared.WorkspaceUnusedAuditBarrier(f.d,f.directory,online=online).query,query)
            self.assertEqual(f.calls, [])


class AfterBitSwitchControlTests(unittest.TestCase):
    """Real B pipe and immutable API stop body; external SQLite acquisition is synthetic."""
    @contextmanager
    def fixture(self, failure=None, admin_seconds=120, sqlite_seconds=60, actual_before=None, source_seconds=0):
        helper = AfterBitUnusedAuditBarrierTests()
        with helper.fixture() as f, ExitStack() as stack:
            f.base = f.d.BASE
            if actual_before is True:
                actual_before = copy.deepcopy(f.bridge['services'])
                actual_before['api']['containerId'] = 'b' * 64
            events, changed, timing, clock = [], [], {}, [1000.0]
            (f.directory / '.env.aws.production').write_bytes(b'SAFE_FIXTURE=1\n')
            stack.enter_context(patch.object(scope.time, 'monotonic', side_effect=lambda: clock[0]))
            gate = object.__new__(shared.WorkspaceSqliteProtection)
            gate.d, gate.previous, gate.api_identity, gate.record = f.d, f.directory, f.identity, f.sqlite.record
            gate.close = MagicMock(side_effect=lambda: events.append('sqlite-close'))
            gate.abort = MagicMock(side_effect=lambda: events.append('sqlite-abort'))
            gate.finish = MagicMock()
            def check_locked():
                events.append('sqlite-check')
                require(clock[0] < gate.deadline, 'API_ADMIN_WORKSPACE_SQLITE_FENCE_TIMEOUT')
                if failure == 'sqlite-check': raise RuntimeError('API_ADMIN_WORKSPACE_SQLITE_FENCE_TIMEOUT')
                if failure in ('wrong-cid', 'wrong-time', 'extra-stop-arg', 'bool-timeout', 'duplicate-stop'):
                    command = ['docker', 'stop', '--time', '30', f.identity['containerId']]
                    kwargs = {'timeout': 45}
                    if failure == 'wrong-cid': command[-1] = 'f' * 64
                    elif failure == 'wrong-time': command[3] = '31'
                    elif failure == 'extra-stop-arg': command.append('unexpected')
                    elif failure == 'bool-timeout': kwargs['timeout'] = True
                    gate.d.run(*command, **kwargs)
            gate.check_locked = MagicMock(side_effect=check_locked)
            inspect, compose = f.d.run.side_effect, f.d.compose.side_effect
            def run(*command, **kwargs):
                if command[:2] == ('docker', 'stop'):
                    self.assertEqual(command, ('docker', 'stop', '--time', '30',
                        f.identity['containerId'] if actual_before is None else actual_before['api']['containerId']))
                    self.assertEqual(changed, ['admin', 'api'])
                    events.append('docker-stop'); clock[0] += 2
                    f.holder.stopped = True
                    if failure == 'partial-stop': raise RuntimeError('SYNTHETIC_SECRET_STOP_OUTPUT')
                    return ''
                if command[-1] == f.identity['containerId'] and f.holder.stopped:
                    events.append('old-api-pid-inspect')
                    if failure == 'stop-inspect': raise RuntimeError('SYNTHETIC_SECRET_INSPECT_OUTPUT')
                return inspect(*command, **kwargs)
            f.d.run.side_effect = run
            def switch(directory, *command, **kwargs):
                if command[0] == 'up':
                    events.append('switch:' + command[-1])
                    self.assertEqual(len(f.processes), 0 if command[-1] == 'admin' else 1)
                    if failure == 'admin' and command[-1] == 'admin': raise RuntimeError('SYNTHETIC_SECRET_ADMIN_OUTPUT')
                    if command[-1] != 'admin': self.assertIsNotNone(f.processes[0].poll())
                    return ''
                if command[:2] == ('exec', '-e') and 'SELECT COUNT(*) FROM id_business_v2_' in command[-1]:
                    self.assertLessEqual(kwargs['timeout'], 5)
                    kind = 'recharge' if 'id_business_v2_recharge_jobs' in command[-1] else 'registration'
                    events.append('lease:' + kind)
                    if failure == 'idle-' + kind: return '1'
                    if failure == 'idle-query-timeout': raise subprocess.TimeoutExpired('SYNTHETIC_PRIVATE_COMMAND', kwargs['timeout'])
                    return '0'
                return compose(directory, *command, **kwargs)
            f.d.compose.side_effect = switch
            def runtime(directory):
                events.append('worker-idle')
                if failure == 'idle-worker-timeout': raise subprocess.TimeoutExpired('SYNTHETIC_PRIVATE_COMMAND', 15)
                return {'supported':True,'registrationBusy':failure == 'idle-worker', 'registrationWindowRetained':False}
            f.d.registration_runtime_state = MagicMock(side_effect=runtime)
            def healthy(directory, service):
                events.append('health:' + service)
                if service == 'admin': clock[0] += admin_seconds
            f.d.wait_healthy = MagicMock(side_effect=healthy)
            f.d.rollback_service = MagicMock(side_effect=lambda previous, target, service, before: events.append('restore:' + service))
            def prepare(*args, **kwargs):
                self.assertIs(kwargs['legacy'], False)
                self.assertEqual(f.processes, [])
                self.assertIn('health:admin', events)
                events.append('sqlite-prepare')
                gate.deadline = clock[0] + 150
                clock[0] += sqlite_seconds
                if failure == 'sqlite-prepare':
                    error = RuntimeError('API_ADMIN_WORKSPACE_SQLITE_PREPARATION_FAILED'); error.sqlite_gate = gate
                    raise error
                if failure == 'gate-identity': gate.api_identity = {**f.identity, 'containerId': 'f' * 64}
                if failure == 'idle-mysql-drift': f.holder.mysql['image'] = 'sha256:' + 'f' * 64
                return gate
            original_factory = scope._online_after_bit_unused_audit_barrier
            def factory(*args):
                self.assertNotIn('switch:admin', events)
                self.assertEqual(changed, [])
                self.assertFalse(hasattr(gate, 'deadline'))
                self.assertEqual(f.processes, [])
                events.append('audit-prepare')
                if failure == 'factory-prepare': raise RuntimeError('API_ADMIN_WORKSPACE_AUDIT_HISTORY_UNPROVEN')
                if actual_before is None:
                    barrier = original_factory(*args)
                else:
                    # Recovery qualification belongs to the caller. Here only
                    # its separately supplied source identity is synthetic.
                    identity = {**f.identity, **{name: actual_before['api'][name]
                        for name in ('containerId', 'image', 'startedAtSha256')}}
                    gate.api_identity = identity
                    barrier = scope._online_after_bit_audit_transport(f.d, f.directory, f.bridge, shared,
                        identity, f.plan, scope._online_after_bit_audit_binding(f.d, f.bridge, f.proof),
                        first_api_check=lambda deadline: None)
                if failure == 'factory-identity': barrier.source_api_identity['containerId'] = 'f' * 64
                enter, before_stop, check, confirm, close = (getattr(barrier, name)
                    for name in ('__enter__', 'before_stop', 'check', 'confirm_stopped', '__exit__'))
                def locked():
                    self.assertIn('sqlite-prepare', events)
                    events.append('mysql-lock')
                    result = enter()
                    if failure == 'reserve': clock[0] += 41
                    return result
                def guard():
                    events.append('before-stop'); return before_stop()
                def checked(*args):
                    events.append('mysql-check'); return check(*args)
                def confirmed(sqlite):
                    self.assertTrue(f.holder.stopped)
                    events.append('stopped-proof'); return confirm(sqlite)
                def closed(*args):
                    events.append('mysql-unlock'); return close(*args)
                barrier.__enter__, barrier.before_stop, barrier.check = locked, guard, checked
                barrier.confirm_stopped, barrier.__exit__ = confirmed, closed
                return barrier
            for name in ('require_preserved', 'jobs_idle', 'historical_guard', 'require_fresh_resources'):
                def checked(*args, _name=name, **kwargs):
                    events.append(_name)
                    self.assertFalse(any(p.poll() is None for p in f.processes), 'full prechecks must run outside MySQL lock')
                    if failure == 'api-precheck' and events.count('health:admin') and _name == 'jobs_idle':
                        raise RuntimeError('ONLINE_RECHARGE_TASKS_BUSY')
                    if _name == 'historical_guard' and events.count('historical_guard') == 2:
                        self.assertFalse(hasattr(gate, 'deadline'), 'complete source checks must precede SQLite lock')
                        clock[0] += source_seconds
                stack.enter_context(patch.object(scope, name, side_effect=checked))
            original_database_identity = shared.workspace_database_identity
            def database_identity(directory_controller, directory, identity=None):
                if identity is None:
                    self.assertNotIn('switch:admin', events)
                    self.assertEqual(changed, [])
                    self.assertFalse(hasattr(gate, 'deadline'))
                    self.assertEqual(f.processes, [])
                    events.append('database-identity')
                    if failure == 'database-identity': raise RuntimeError('API_ADMIN_WORKSPACE_DATABASE_IDENTITY_CHANGED')
                return original_database_identity(directory_controller, directory, identity)
            stack.enter_context(patch.object(shared, 'workspace_database_identity', side_effect=database_identity))
            stack.enter_context(patch.object(scope, '_online_after_bit_unused_audit_barrier', side_effect=factory))
            stack.enter_context(patch.object(shared, 'workspace_prepare', side_effect=prepare))
            f.changed, f.timing, f.events, f.clock, f.gate = changed, timing, events, clock, gate
            f.actual_before = actual_before
            f.switch = lambda: scope._online_after_bit_switch(f.d, f.directory, f.base / 'target',
                f.bridge['services'] if actual_before is None else actual_before,
                b'SAFE_FIXTURE', {}, f.proof, SimpleNamespace(), f.bridge, changed, timing)
            yield f

    def test_slow_admin_and_sqlite_preparation_leave_fresh_210_second_guard_and_original_150_sqlite_deadline(self):
        with self.fixture() as f:
            gate, receipt = f.switch()
            self.assertIs(gate, f.gate); self.assertIs(gate.d, f.d)
            self.assertEqual(receipt['oldApiStop']['pid'], 0)
            self.assertGreater(f.timing['elapsedSeconds'], 170)
            self.assertLess(f.timing['mysqlLockElapsedSeconds'], 40)
            self.assertGreater(f.timing['mysqlLockRemainingSeconds'], 170)
            self.assertEqual(f.gate.deadline, 1270)
            self.assertEqual([e for e in f.events if e.startswith('switch:')], ['switch:admin', 'switch:api', 'switch:online-recharge'])
            self.assertEqual(f.events.count('docker-stop'), 1)
            self.assertLess(f.events.index('audit-prepare'), f.events.index('database-identity'))
            self.assertLess(f.events.index('database-identity'), f.events.index('switch:admin'))
            self.assertLess(f.events.index('health:admin'), f.events.index('sqlite-prepare'))
            self.assertLess(f.events.index('sqlite-prepare'), f.events.index('mysql-lock'))
            self.assertLess(f.events.index('stopped-proof'), f.events.index('mysql-unlock'))
            self.assertLess(f.events.index('mysql-unlock'), f.events.index('switch:api'))
            captured = f.captured.read_text()
            self.assertIn('wait_timeout=240', captured)
            self.assertEqual(captured.count('LOCK TABLES'), 1)
            self.assertTrue(f.timing['apiStopAttempted']); self.assertTrue(f.timing['apiStopCompleted'])

    def test_slow_full_api_source_prechecks_do_not_consume_sqlite_150_seconds(self):
        with self.fixture(source_seconds=100) as f:
            gate, receipt = f.switch()
            self.assertEqual(gate.deadline, 1370)
            self.assertEqual(f.clock[0], 1282)
            self.assertEqual(f.timing['mysqlLockElapsedSeconds'], 2)
            self.assertEqual(receipt['oldApiStop']['pid'], 0)
            self.assertLess(f.events.index('audit-prepare'), f.events.index('sqlite-prepare'))
            self.assertLess(f.events.index('sqlite-prepare'), f.events.index('lease:recharge'))
            self.assertLess(f.events.index('lease:registration'), f.events.index('mysql-lock'))
            self.assertEqual(f.events.count('historical_guard'), 3)
            self.assertEqual(f.events.count('docker-stop'), 1)

    def test_fresh_original_activity_predicates_and_database_drift_refuse_before_mysql_lock(self):
        for failure, expected in (('idle-recharge', 'API_ADMIN_RECHARGE_LEASE_ACTIVE'),
                ('idle-registration', 'API_ADMIN_REGISTRATION_LEASE_ACTIVE'),
                ('idle-worker', 'API_ADMIN_REGISTRATION_BUSY'),
                ('idle-mysql-drift', 'ONLINE_RECHARGE_AFTER_BIT_MYSQL_CHANGED'),
                ('idle-query-timeout', None), ('idle-worker-timeout', None)):
            with self.subTest(failure=failure), self.fixture(failure=failure) as f:
                with self.assertRaises((RuntimeError, subprocess.TimeoutExpired)) as caught: f.switch()
                if expected is not None: self.assertEqual(str(caught.exception), expected)
                self.assertEqual(f.timing['phase'], 'API_IDLE')
                self.assertEqual(f.changed, ['admin'])
                self.assertEqual(f.processes, [])
                self.assertFalse(f.timing['apiStopAttempted'])
                self.assertNotIn('switch:api', f.events)
                self.assertNotIn('SYNTHETIC_PRIVATE', json.dumps(f.timing))

    def test_fresh_worker_probe_refuses_insufficient_sqlite_deadline_without_extending_it(self):
        with self.fixture(sqlite_seconds=136) as f:
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_WORKSPACE_SQLITE_FENCE_TIMEOUT$'): f.switch()
            self.assertEqual(f.gate.deadline, 1270)
            self.assertEqual(f.timing['phase'], 'API_IDLE')
            f.d.registration_runtime_state.assert_not_called()
            self.assertEqual(f.processes, [])
            self.assertFalse(f.timing['apiStopAttempted'])

    def test_audit_preparation_and_database_identity_failures_do_not_switch_or_restore_services(self):
        for failure, code in (('factory-prepare', 'API_ADMIN_WORKSPACE_AUDIT_HISTORY_UNPROVEN'),
                ('factory-identity', 'ONLINE_RECHARGE_AFTER_BIT_API_CHANGED'),
                ('database-identity', 'API_ADMIN_WORKSPACE_DATABASE_IDENTITY_CHANGED')):
            with self.subTest(failure=failure), self.fixture(failure=failure) as f:
                with self.assertRaisesRegex(RuntimeError, '^' + code + '$'): f.switch()
                self.assertEqual(f.changed, [])
                self.assertEqual(f.timing['phase'], 'AUDIT_PREPARE')
                self.assertEqual(f.processes, [])
                self.assertFalse(hasattr(f.gate, 'deadline'))
                self.assertFalse(f.timing['mysqlFenceEntered'])
                self.assertFalse(f.timing['apiStopAttempted'])
                self.assertFalse(f.timing['apiStopCompleted'])
                self.assertFalse(any(event.startswith(('switch:', 'restore:')) for event in f.events))
                okay, restored = scope.rollback(f.d, f.directory, f.base / 'target', f.changed,
                    f.bridge['services'], migrated=True)
                self.assertTrue(okay); self.assertEqual(restored, {})
                f.d.rollback_service.assert_not_called()
                f.gate.abort.assert_not_called(); f.gate.close.assert_not_called()

    def test_preparation_guard_and_sqlite_check_failures_never_dispatch_or_recreate_api(self):
        phases = {'admin': 'ADMIN_SWITCH', 'api-precheck': 'API_PRECHECKS', 'sqlite-prepare': 'SQLITE_PREPARE',
            'reserve': 'API_STOP_GUARD', 'sqlite-check': 'API_STOP_CHECK',
            'gate-identity': 'SQLITE_PREPARE'}
        for failure, phase in phases.items():
            with self.subTest(failure=failure), self.fixture(failure=failure) as f:
                with self.assertRaises(RuntimeError): f.switch()
                self.assertEqual(f.changed, ['admin'])
                self.assertNotIn('docker-stop', f.events); self.assertNotIn('switch:api', f.events)
                self.assertEqual(f.timing['phase'], phase)
                self.assertFalse(f.timing['apiStopAttempted']); self.assertFalse(f.timing['apiStopCompleted'])
                self.assertIs(f.gate.d, f.d)
                okay, restored = scope.rollback(f.d, f.directory, f.base / 'target', f.changed, f.bridge['services'], migrated=True)
                self.assertEqual(okay, failure != 'api-precheck')
                self.assertEqual(restored, {'admin': 'BLOCKED_OR_FAILED' if failure == 'api-precheck' else 'RESTORED'})
                self.assertNotIn('restore:api', f.events)
                if failure == 'reserve':
                    self.assertEqual(f.timing['mysqlLockElapsedSeconds'], 41)
                    self.assertEqual(f.timing['mysqlLockRemainingSeconds'], 169)

    def test_partial_stop_and_confirmation_failure_are_marked_before_dispatch_and_restore_api_once(self):
        for failure, phase in (('partial-stop', 'API_STOP_DISPATCH'), ('stop-inspect', 'API_STOP_CONFIRM')):
            with self.subTest(failure=failure), self.fixture(failure=failure) as f:
                with self.assertRaises(RuntimeError) as caught: f.switch()
                self.assertIs(caught.exception.sqlite_gate, f.gate)
                self.assertEqual(f.changed, ['admin', 'api']); self.assertEqual(f.events.count('docker-stop'), 1)
                self.assertTrue(f.timing['apiStopAttempted']); self.assertFalse(f.timing['apiStopCompleted'])
                self.assertEqual(f.timing['phase'], phase); self.assertIs(f.gate.d, f.d)
                self.assertNotIn('switch:api', f.events); self.assertNotIn('switch:online-recharge', f.events)
                self.assertIsNotNone(f.processes[0].poll())
                okay, restored = scope.rollback(f.d, f.directory, f.base / 'target', f.changed, f.bridge['services'], migrated=True)
                self.assertTrue(okay); self.assertEqual(restored, {'api': 'RESTORED', 'admin': 'RESTORED'})
                self.assertEqual(f.events.count('restore:api'), 1)
                self.assertNotIn('SYNTHETIC_SECRET', json.dumps(f.timing))

    def test_wrong_stop_command_timeout_or_duplicate_dispatch_is_fail_closed(self):
        for failure in ('wrong-cid', 'wrong-time', 'extra-stop-arg', 'bool-timeout', 'duplicate-stop'):
            with self.subTest(failure=failure), self.fixture(failure=failure) as f:
                with self.assertRaisesRegex(RuntimeError, '^ONLINE_RECHARGE_AFTER_BIT_STOP_DISPATCH_INVALID$'): f.switch()
                calls = 1 if failure == 'duplicate-stop' else 0
                self.assertEqual(f.events.count('docker-stop'), calls)
                self.assertEqual(f.changed, ['admin', 'api'] if calls else ['admin'])
                self.assertNotIn('switch:api', f.events); self.assertIs(f.gate.d, f.d)

    def test_immutable_bridge_cid_cannot_replace_the_explicit_actual_before_stop_cid(self):
        with self.fixture(failure='partial-stop', actual_before=True) as f:
            self.assertNotEqual(f.actual_before['api']['containerId'], f.bridge['services']['api']['containerId'])
            with self.assertRaisesRegex(RuntimeError, '^SYNTHETIC_SECRET_STOP_OUTPUT$'): f.switch()
            self.assertEqual(f.events.count('docker-stop'), 1)
            self.assertTrue(f.timing['apiStopAttempted'])
            self.assertEqual(f.bridge['services']['api']['containerId'], 'a' * 64)
            self.assertIs(f.gate.d, f.d)

    def test_original_sqlite_150_second_fence_can_refuse_stop_without_marking_api(self):
        with self.fixture(sqlite_seconds=116) as f:
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_WORKSPACE_SQLITE_FENCE_TIMEOUT$'): f.switch()
            self.assertEqual(f.gate.deadline, 1270)
            self.assertEqual(f.changed, ['admin'])
            self.assertFalse(f.timing['apiStopAttempted'])
            self.assertNotIn('docker-stop', f.events); self.assertNotIn('switch:api', f.events)

    def test_failure_receipt_exposes_only_safe_phase_seconds_and_booleans(self):
        helper = AfterBitFormalTests(); helper.addCleanup = self.addCleanup
        receipt, events = helper.formal_stage(failure='before-stop')
        timing = receipt['afterBitControlTiming']
        self.assertEqual(receipt['servicesAttempted'], ['admin'])
        self.assertEqual(timing['phase'], 'API_STOP_GUARD')
        self.assertEqual(set(timing), {'phase', 'phaseElapsedSeconds', 'elapsedSeconds', 'completedPhases',
            'mysqlFenceEntered', 'mysqlFenceClosed', 'mysqlLockElapsedSeconds', 'mysqlLockRemainingSeconds',
            'apiStopAttempted', 'apiStopCompleted'})
        self.assertFalse(timing['apiStopAttempted']); self.assertFalse(timing['apiStopCompleted'])
        self.assertNotIn('SYNTHETIC_SECRET', json.dumps(receipt))
        self.assertNotIn('switch:api', events)


class AfterBitReceiptCISourceTests(unittest.TestCase):
    @contextmanager
    def fixture(self):
        helper = AfterBitFormalTests()
        with helper.fixture(policy=True) as value:
            self.assertEqual(len(scope._AFTER_BIT_RELEASE_CI_FILES), 4)
            for name, (before, after) in scope._AFTER_BIT_RELEASE_CI_FILES.items():
                value.inventory[name] = {'sha256': before, 'mode': '100644'}
                value.candidate_inventory[name] = {'sha256': after, 'mode': '100644'}
            inventory_hash = scope.fingerprint(value.inventory)
            value.publication['producer']['archiveInventorySha256'] = inventory_hash
            value.publication['archiveInventorySha256'] = inventory_hash
            issued = scope.declaration_equivalence_successor_issuer_binding(controller(), value.publication,
                live_services=value.publication['afterServices'],
                live_configuration=value.publication['configurationAfter'],
                execution_producer=value.publication['producer'])
            invocation = json.loads(value.qb.read_text())
            receipt = json.loads(invocation['StandardOutputContent'])
            receipt['declarationEquivalenceSuccessorPublication'] = issued
            invocation['StandardOutputContent'] = json.dumps(receipt)
            value.qb.write_text(json.dumps(invocation))
            yield helper, value

    def test_exact_ci_group_and_bank_policy_bind_real_b_preflight(self):
        with self.fixture() as (helper, value):
            result, raw, path = helper.preflight_and_f(value)
            bridge = result['onlineAfterBitOrigin']
            inventory = scope._pending_workspace_profile(value.d, bridge, value.producer)
            self.assertIs(inventory, value.candidate_inventory)
            self.assertEqual(scope._workspace_bank_policy_inventory(value.d, bridge,
                value.inventory, inventory), set(scope._AFTER_BIT_BANK_POLICY_FILES)
                - scope._PENDING_WORKSPACE_RECEIPT_COMPATIBILITY_FILES)
            value.a_reader.assert_not_called()
            value.d.compose.assert_not_called()
            value.d.sync_new_table_grants.assert_not_called()
            value.d.point_current.assert_not_called()

    def test_partial_ci_wrong_hash_mode_source_and_a_relabel_are_rejected(self):
        mutations = ('partial', 'candidate-hash', 'original-hash', 'mode', 'unrelated-source', 'cross-a')
        for name in scope._AFTER_BIT_RELEASE_CI_FILES:
            for mutation in mutations:
                with self.subTest(name=name, mutation=mutation), self.fixture() as (helper, value):
                    bridge = value.reader.online_after_bit_cold(value.d, value.old, expected_commit=COMMIT)
                    if mutation == 'partial':
                        value.candidate_inventory[name] = copy.deepcopy(value.inventory[name])
                    elif mutation == 'candidate-hash':
                        value.candidate_inventory[name]['sha256'] = '0' * 64
                    elif mutation == 'original-hash':
                        value.inventory[name]['sha256'] = '0' * 64
                    elif mutation == 'mode':
                        value.candidate_inventory[name]['mode'] = '100755'
                    elif mutation == 'unrelated-source':
                        key = 'apps/api/src/id-business-v2/online-recharge/unapproved.ts'
                        value.inventory[key] = {'sha256': '1' * 64, 'mode': '100644'}
                        value.candidate_inventory[key] = {'sha256': '2' * 64, 'mode': '100644'}
                    else:
                        bridge['kind'] = scope.ONLINE_PENDING_WORKSPACE_KIND
                    with self.assertRaises(RuntimeError):
                        scope._pending_workspace_profile(value.d, bridge, value.producer)
                    value.d.compose.assert_not_called()
                    value.d.sync_new_table_grants.assert_not_called()
                    value.d.point_current.assert_not_called()

    def test_ci_hash_group_is_the_exact_checked_source_and_mode(self):
        self.assertEqual(len(scope._AFTER_BIT_RELEASE_CI_FILES), 4)
        tree = subprocess.check_output(['git', 'rev-parse', REVIEWED_APPLICATION_TEMPLATE_COMMIT + '^{tree}'], cwd=ROOT).decode().strip()
        self.assertEqual(tree, REVIEWED_APPLICATION_TEMPLATE_TREE)
        for name, (before, after) in scope._AFTER_BIT_RELEASE_CI_FILES.items():
            raw = subprocess.check_output(['git', 'show', '31d2c6885a45817cd40d23fce8d6145bc9f18af2:' + name], cwd=ROOT)
            self.assertEqual(hashlib.sha256(raw).hexdigest(), before)
            reviewed = subprocess.check_output(['git', 'show', REVIEWED_APPLICATION_TEMPLATE_COMMIT + ':' + name], cwd=ROOT)
            self.assertEqual(hashlib.sha256(reviewed).hexdigest(), after)
            entry = subprocess.check_output(['git', 'ls-tree', REVIEWED_APPLICATION_TEMPLATE_COMMIT, '--', name], cwd=ROOT).decode().split()
            self.assertEqual(entry[0], '100644')
            self.assertEqual(entry[1], 'blob')
            self.assertEqual(entry[3], name)




_RestoreCfg = SimpleNamespace(**{'IDENTITY_KEYS': scope._restore_cfg_IDENTITY_KEYS,'HASH': scope._restore_cfg_HASH,'need': scope._restore_cfg_need,'complete_configuration_material': scope._restore_cfg_complete_configuration_material,'require_finite_restore_policy': scope._restore_cfg_require_finite_restore_policy,'fingerprint': scope._restore_cfg_fingerprint,'original_boot_identity': scope._restore_cfg_original_boot_identity,'FINITE_RESTORE_WITNESS': scope._restore_cfg_FINITE_RESTORE_WITNESS})
_RestoreMaterial = SimpleNamespace(**{'IDENTITY_KEYS': scope._restore_pure_IDENTITY_KEYS,'closed': scope._restore_pure_closed,'restored_build_shape': scope._restore_pure_restored_build_shape,'service_shape': scope._restore_pure_service_shape,'fingerprint': scope._restore_pure_fingerprint,'SERVICES': scope._restore_pure_SERVICES,'utc': scope._restore_pure_utc,'complete_restore_material': scope._restore_pure_complete_restore_material,'require_reviewed_restore_policy': scope._restore_pure_require_reviewed_restore_policy,'validate_observation_material': scope._restore_pure_validate_observation_material,'need': scope._restore_pure_need,'restored_before_and_stop_shape': scope._restore_pure_restored_before_and_stop_shape,'restored_f_shape': scope._restore_pure_restored_f_shape,'QR_KEYS': scope._restore_pure_QR_KEYS,'POLICY_KEYS': scope._restore_pure_POLICY_KEYS,'FINITE_RESTORE_POLICY': scope._restore_pure_FINITE_RESTORE_POLICY})
def _restore_draft_fixture(service='api', old_replace='b' * 64, actual_replace='a' * 64):
    (original_cid, actual_cid) = ('a' * 64, 'c' * 64)
    reference = 'example.invalid/id:' + service
    config = {'Hostname': original_cid[:12], 'Image': reference, 'Env': ['EXAMPLE_LABEL=测试'], 'Cmd': ['node', 'main.js'], 'Labels': {'com.docker.compose.service': service, 'com.docker.compose.project': 'id-test', 'com.docker.compose.container-number': '1'}}
    if old_replace is not None:
        config['Labels']['com.docker.compose.replace'] = old_replace
    complete = {'Config': config, 'HostConfig': {'Privileged': False, 'ReadonlyRootfs': True, 'PortBindings': {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3000'}]}}, 'Mounts': [{'Destination': '/app/data', 'Type': 'volume', 'Name': 'example-data', 'RW': True}, {'Destination': '/app/logs', 'Type': 'volume', 'Name': 'example-logs', 'RW': True}]}
    (boot_old, boot_new) = ('2026-10-11T13:37:28.606112575Z', '2026-10-11T18:00:00.000000001Z')
    original = {'image': 'sha256:' + 'd' * 64, 'reference': reference, 'status': 'running', 'health': 'healthy', 'containerId': original_cid, 'startedAtSha256': hashlib.sha256(boot_old.encode()).hexdigest(), 'environmentSha256': _RestoreCfg.fingerprint(sorted(config['Env'])), 'configurationSha256': _RestoreCfg.fingerprint(complete)}
    actual_config = copy.deepcopy(complete)
    actual_config['Config']['Hostname'] = actual_cid[:12]
    actual_config['Config']['Labels']['com.docker.compose.replace'] = actual_replace
    actual = {**original, 'containerId': actual_cid, 'startedAtSha256': hashlib.sha256(boot_new.encode()).hexdigest(), 'configurationSha256': _RestoreCfg.fingerprint(actual_config)}
    metadata = {**actual_config, 'Id': actual_cid, 'Image': actual['image'], 'Name': '/id-test-' + service + '-1', 'State': {'StartedAt': boot_new, 'Status': 'running', 'Health': {'Status': 'healthy'}}}
    return (metadata, actual, original, boot_old, boot_new)

def _restore_draft_material(f, service='api'):
    (metadata, actual, original, unused, unused2) = f
    return _RestoreCfg.complete_configuration_material(service, metadata, actual, original, original_before_container_id='b' * 64, acquired_actual_replace_anchors=('a' * 64,))

def _restore_draft_rebuild(metadata, actual):
    actual['configurationSha256'] = _RestoreCfg.fingerprint({n: metadata[n] for n in ('Config', 'HostConfig', 'Mounts')})

class RestoredCompleteConfigurationDraftTests(unittest.TestCase):

    def test_full_native_identity_mapping_matches_original_and_no_raw_config_output(self):
        value = _restore_draft_material(_restore_draft_fixture())
        self.assertEqual(value['reconstructedConfigurationSha256'], value['originalConfigurationSha256'])
        self.assertNotIn('Config', value)
        self.assertNotIn('测试', json.dumps(value, ensure_ascii=False))

    def test_original_four_replace_forms_are_unique_and_supported(self):
        for old in ('b' * 64, 'id-test-api-1', 'api-1', None):
            with self.subTest(old=old):
                _restore_draft_material(_restore_draft_fixture(old_replace=old))

    def test_actual_stable_native_names_do_not_need_an_unknown_cid(self):
        for actual in ('id-test-api-1', 'api-1'):
            with self.subTest(actual=actual):
                _restore_draft_material(_restore_draft_fixture(actual_replace=actual))

    def test_unknown_actual_replace_candidate_is_not_accepted(self):
        with self.assertRaises(RuntimeError):
            _restore_draft_material(_restore_draft_fixture(actual_replace='f' * 64))

    def test_complete_config_env_cmd_and_other_labels_cannot_be_normalized_away(self):
        mutations = (lambda m: m['Config']['Env'].append('EXAMPLE_EXTRA=changed'), lambda m: m['Config']['Cmd'].append('changed'), lambda m: m['Config']['Labels'].update({'example-extra': 'changed'}))
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                f = _restore_draft_fixture()
                mutate(f[0])
                _restore_draft_rebuild(f[0], f[1])
                with self.assertRaises(RuntimeError):
                    _restore_draft_material(f)

    def test_complete_host_config_privilege_port_and_readonly_changes_reject(self):
        for (key, value) in (('Privileged', True), ('ReadonlyRootfs', False), ('PortBindings', {})):
            with self.subTest(key=key):
                f = _restore_draft_fixture()
                f[0]['HostConfig'][key] = value
                _restore_draft_rebuild(f[0], f[1])
                with self.assertRaises(RuntimeError):
                    _restore_draft_material(f)

    def test_mount_destination_name_type_permission_change_reject(self):
        for (key, value) in (('Destination', '/different'), ('Name', 'different'), ('Type', 'bind'), ('RW', False)):
            with self.subTest(key=key):
                f = _restore_draft_fixture()
                f[0]['Mounts'][0][key] = value
                f[0]['Mounts'].sort(key=lambda row: row['Destination'])
                _restore_draft_rebuild(f[0], f[1])
                with self.assertRaises(RuntimeError):
                    _restore_draft_material(f)

    def test_mount_order_only_is_non_semantic(self):
        f = _restore_draft_fixture()
        f[0]['Mounts'].reverse()
        _restore_draft_material(f)

    def test_duplicate_mount_destination_rejects(self):
        f = _restore_draft_fixture()
        f[0]['Mounts'][1]['Destination'] = f[0]['Mounts'][0]['Destination']
        _restore_draft_rebuild(f[0], f[1])
        with self.assertRaises(RuntimeError):
            _restore_draft_material(f)

    def test_wrong_hostname_image_reference_identity_or_started_hash_reject(self):
        for key in ('Hostname', 'image', 'reference', 'containerId', 'startedAtSha256'):
            with self.subTest(key=key):
                f = _restore_draft_fixture()
                if key == 'Hostname':
                    f[0]['Config']['Hostname'] = 'incorrect'
                    _restore_draft_rebuild(f[0], f[1])
                else:
                    f[1][key] = 'e' * 64
                with self.assertRaises(RuntimeError):
                    _restore_draft_material(f)

    def test_original_boot_binding_never_uses_current_boot_as_history_origin(self):
        f = _restore_draft_fixture()
        bridge = {'services': {'api': f[2]}}
        self.assertEqual(_RestoreCfg.original_boot_identity(bridge, f[3])['containerId'], f[2]['containerId'])
        with self.assertRaises(RuntimeError):
            _RestoreCfg.original_boot_identity(bridge, f[4])

    def test_missing_reviewed_policy_is_fail_closed(self):
        with self.assertRaisesRegex(RuntimeError, 'WITNESS_UNAVAILABLE'):
            _RestoreCfg.require_finite_restore_policy()
        with self.assertRaisesRegex(RuntimeError, 'WITNESS_UNAVAILABLE'):
            _RestoreMaterial.require_reviewed_restore_policy()

class RestoredBindingDraftTests(unittest.TestCase):

    def setUp(self):
        (self.api, self.admin) = (_restore_draft_fixture(), _restore_draft_fixture(service='admin'))
        self.original = {name: copy.deepcopy(self.api[2]) for name in _RestoreMaterial.SERVICES}
        self.original['admin'] = copy.deepcopy(self.admin[2])
        self.original['caddy']['health'] = None
        self.actual = copy.deepcopy(self.original)
        self.actual['api'] = copy.deepcopy(self.api[1])
        self.actual['admin'] = copy.deepcopy(self.admin[1])
        self.bridge = {'kind': 'ONLINE_RECHARGE_AFTER_BIT_SUCCESSOR_ORIGIN', 'services': self.original}
        self.policy = dict.fromkeys(_RestoreMaterial.POLICY_KEYS, 'e' * 64)
        self.policy.update(kind='ONLINE_RECHARGE_B_RESTORE_FINITE_OBSERVATION', version=1, baselineBridgeSha256=_RestoreMaterial.fingerprint(self.bridge), originalBootStartedAt=self.api[3], failedProducer={'commit': '1' * 40, 'sourceTree': '2' * 40, 'workflowRunId': '123', 'workflowRunAttempt': '1'}, failedCommandId='22222222-2222-2222-2222-222222222222', failedNativeEnd='2026-10-11T17:58:11.942Z', failedRelease='/opt/id-business-v2/releases/20261011T174300Z-' + '1' * 12, instanceId='i-11111111111111111', readbackCommandId='11111111-1111-1111-1111-111111111111', failedSourceHelpers={'api-admin-scope.py': 'a' * 64, 'online-recharge-scope.py': 'b' * 64})
        self.receipt = dict.fromkeys(_RestoreMaterial.QR_KEYS, False)
        self.receipt.update(version=1, readOnlyObservation=True, measurementsComplete=True, nativeGrantSyncReached=True, inputBindingSha256=self.policy['readbackInputBindingSha256'], currentIsOriginalB=True, originalManifestBytesMatch=True, originalEnvironmentAndConfigurationFilesMatch=True, originalManifestNewMigrationCount=0, runtimeContentMatchesOriginal={'api': True, 'admin': True}, apiCurrentStartedAt=self.api[4], apiCurrentStartedAtSha256=self.api[1]['startedAtSha256'], failedTarget={'uniqueTargetKnown': True, 'targetSourceBound': True, 'actualReleasePath': self.policy['failedRelease'], 'failureCanonicalSha256': self.policy['failureCanonicalSha256'], 'sourceHelpersSha256': self.policy['failedSourceHelpers']}, currentServices=self.actual, twoRuntimeFramesStable=True, currentPointerStable=True, preservedFullIdentityCount=5, apiAdminImageReferenceEnvironmentContentMatchesOriginal=True, apiAdminRuntimeConfigurationProof={'formalConfigurationQualificationMeasured': False, 'services': {name: {'configSha256': 'a' * 64, 'hostConfigSha256': 'b' * 64, 'destinationSortedMountsSha256': 'c' * 64, 'completeConfigurationSha256': self.actual[name]['configurationSha256'], 'mountCount': 2} for name in ('api', 'admin')}})
        self.invocation = {'CommandId': self.policy['readbackCommandId'], 'InstanceId': self.policy['instanceId'], 'DocumentName': 'AWS-RunShellScript', 'PluginName': 'aws:runShellScript', 'Status': 'Success', 'ResponseCode': 0, 'ExecutionStartDateTime': '2026-10-11T18:01:00Z', 'ExecutionEndDateTime': '2026-10-11T18:02:00Z', 'StandardErrorContent': '', 'StandardOutputContent': json.dumps(self.receipt)}
        self.raw = json.dumps(self.invocation).encode()
        self.repin()

    def repin(self):
        self.policy['readbackInvocationBytesSha256'] = hashlib.sha256(self.raw).hexdigest()

    def observe(self):
        return _RestoreMaterial.validate_observation_material(self.bridge, self.raw, self.policy)

    def complete(self):
        return _RestoreMaterial.complete_restore_material(self.bridge, self.observe(), {'api': _restore_draft_material(self.api), 'admin': _restore_draft_material(self.admin, 'admin')})

    def test_observation_binding_cannot_claim_full_config_or_publication(self):
        value = self.observe()
        self.assertFalse(value['formalConfigurationQualificationMeasured'])
        self.assertFalse(value['publicationQualified'])

    def test_raw_wrong_native_uuid_instance_status_time_or_stderr_rejects(self):
        for (key, value) in (('CommandId', 'changed'), ('InstanceId', 'changed'), ('Status', 'Failed'), ('ResponseCode', 1), ('ExecutionStartDateTime', '2026-10-11T17:00:00Z'), ('StandardErrorContent', 'changed')):
            with self.subTest(key=key):
                saved = self.raw
                changed = copy.deepcopy(self.invocation)
                changed[key] = value
                self.raw = json.dumps(changed).encode()
                self.repin()
                with self.assertRaises(RuntimeError):
                    self.observe()
                self.raw = saved
                self.repin()

    def test_replacing_original_b_identity_or_qr_digest_rejects(self):
        altered = copy.deepcopy(self.bridge)
        altered['services']['api'] = self.actual['api']
        with self.assertRaises(RuntimeError):
            _RestoreMaterial.validate_observation_material(altered, self.raw, self.policy)
        with self.assertRaises(RuntimeError):
            _RestoreMaterial.validate_observation_material(self.bridge, self.raw + b' ', self.policy)

    def test_complete_config_material_required_for_both_services(self):
        with self.assertRaises(RuntimeError):
            _RestoreMaterial.complete_restore_material(self.bridge, self.observe(), {'api': _restore_draft_material(self.api)})

    def test_two_identities_are_distinct_and_history_remains_old(self):
        complete = self.complete()
        self.assertEqual(complete['historyApiIdentity']['startedAt'], self.api[3])
        self.assertEqual(complete['stopApiIdentity']['startedAt'], self.api[4])
        self.assertNotEqual(complete['historyApiIdentity']['containerId'], complete['stopApiIdentity']['containerId'])
        self.assertFalse(complete['publicationQualified'])

    def test_restored_f_v3_does_not_replace_immutable_bridge_services(self):
        complete = self.complete()
        producer = self.policy['failedProducer']
        receipt = {'onlineAfterBitOrigin': self.bridge, 'services': self.actual, 'afterBitRestoration': complete, 'migrationPerformed': False}
        f = {'kind': 'ONLINE_RECHARGE_AFTER_BIT_PREFLIGHT', 'version': 3, 'mode': 'preflight', 'status': 'ONLINE_RECHARGE_AFTER_BIT_BASELINE_VERIFIED', 'commandId': 'id', 'releaseCandidateCommit': producer['commit'], 'workflowRunId': producer['workflowRunId'], 'workflowRunAttempt': producer['workflowRunAttempt'], 'sourceTree': producer['sourceTree'], 'baseline': self.bridge, 'services': self.actual, 'ordinaryPreflight': receipt, 'restoration': complete}
        _RestoreMaterial.restored_f_shape(f, self.bridge, producer, complete)
        with self.assertRaises(RuntimeError):
            _RestoreMaterial.restored_f_shape({**f, 'version': 2}, self.bridge, producer, complete)
        with self.assertRaises(RuntimeError):
            _RestoreMaterial.restored_f_shape({**f, 'services': self.original}, self.bridge, producer, complete)

    def test_actual_stop_identity_and_sqlite_required_original_identity_cannot_masquerade(self):
        complete = self.complete()
        f = {'restoration': complete, 'services': self.actual, 'baseline': self.bridge}
        record = {'before': self.actual, 'baselineEvidence': {'onlineAfterBitOrigin': self.bridge, 'restoration': complete}}
        identity = {n: complete['stopApiIdentity'][n] for n in ('containerId', 'image', 'startedAtSha256')}
        sqlite = {'sourceApiIdentity': identity}
        audit = {'version': 2, 'historyApiIdentity': complete['historyApiIdentity'], 'sourceApiIdentity': complete['stopApiIdentity'], 'oldApiStop': {'identity': identity, 'running': False, 'pid': 0}, 'restorationSha256': _RestoreMaterial.fingerprint(complete)}
        _RestoreMaterial.restored_before_and_stop_shape(record, f, sqlite, audit)
        old = {n: complete['historyApiIdentity'][n] for n in identity}
        with self.assertRaises(RuntimeError):
            _RestoreMaterial.restored_before_and_stop_shape(record, f, {'sourceApiIdentity': old}, audit)

class RestoredEntryTests(unittest.TestCase):
    def test_actual_failed_source_and_material_are_full_archive_bound_without_native_paths(self):
        witness=scope._RESTORED_B_WITNESS
        bridge=scope.closed_recovery_json(controller(),witness['failedPreflight'].encode())['baseline']
        cached={}
        for producer in (bridge['baselineProducer'],witness['policy']['failedProducer']):
            commit=producer['commit']
            cached[commit,producer['sourceTree']]=subprocess.check_output(['git','archive','--format=tar.gz',
                '--prefix=id-business-system-'+commit+'/',commit],cwd=ROOT)
        d=controller(BASE=Path('/opt/id-business-v2'),_onlinePendingWorkspaceArchiveBytes=cached)
        # A CI consumer validates the full immutable source archives and original
        # F/build/failure material. It must not open a fabricated /opt directory.
        with patch.object(scope,'_declaration_source_bytes',side_effect=AssertionError('CI must not read native files')):
            observed,proof=scope._restored_workspace_materials(d,bridge)
        self.assertEqual(observed['currentServices']['api']['containerId'],
            'cfaf13170d1f631583747dd4daa5bcf7185c017039f3ebe4683a6bc7f3d3dec4')
        self.assertEqual(scope.fingerprint(proof),witness['policy']['failedBuildProofSha256'])
        self.assertFalse(observed['publicationQualified'])
        key=(witness['policy']['failedProducer']['commit'],witness['policy']['failedProducer']['sourceTree'])
        original=cached[key]
        # Rebuilding an actual archive with one changed business source retains
        # the claimed producer but fails the independently calculated Git tree.
        with tarfile.open(fileobj=io.BytesIO(original),mode='r:gz') as archive:
            files=[(member,archive.extractfile(member).read() if member.isfile() else None)
                for member in archive.getmembers()]
        output=io.BytesIO()
        with tarfile.open(fileobj=output,mode='w:gz') as archive:
            for member,raw in files:
                if raw is not None and member.name.endswith('/apps/api/src/main.ts'):
                    raw+=b'\n';member.size=len(raw)
                archive.addfile(member,io.BytesIO(raw) if raw is not None else None)
        cached[key]=output.getvalue()
        with self.assertRaisesRegex(RuntimeError,'SOURCE_TREE_CHANGED'):
            scope._restored_workspace_materials(d,bridge)

    def test_failed_online_source_exact_314958_boundary_and_one_byte_overflow(self):
        name='scripts/production-release/online-recharge-scope.py'
        raw=subprocess.check_output(['git','show','08419dcbe85212a203906c86c98e5c3ae0695d72:'+name],cwd=ROOT)
        self.assertEqual(len(raw),314958)
        self.assertEqual(hashlib.sha256(raw).hexdigest(),'93992e3258c015bcf1f1b9943fa9cd37149e995748433988cc4d1367d4f1b5d8')
        with tempfile.TemporaryDirectory(dir=RUNTIME) as folder:
            directory=Path(folder);path=directory/name;path.parent.mkdir(parents=True)
            path.write_bytes(raw)
            self.assertEqual(scope._restored_workspace_failed_helper_bytes(controller(),directory,name),raw)
            path.write_bytes(raw+b'\n')
            with self.assertRaises(RuntimeError):
                scope._restored_workspace_failed_helper_bytes(controller(),directory,name)
            path.write_bytes(raw[:-1])
            with self.assertRaises(RuntimeError):
                scope._restored_workspace_failed_helper_bytes(controller(),directory,name)
    def test_capacity_control_missing_policy_is_empty_and_atomic_exact_mapping_required(self):
        import ast
        witness=scope._RESTORED_B_WITNESS
        bridge=scope.closed_recovery_json(controller(),witness['failedPreflight'].encode())['baseline']
        frozen_main='caf6c440324f83fb76e03eea8e9f2dd2f5ee5a20'
        frozen_source=subprocess.check_output(['git','show',frozen_main+':scripts/production-release/online-recharge-scope.py'],cwd=ROOT)
        policy=next(ast.literal_eval(node.value) for node in ast.parse(frozen_source).body
            if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name)
                and target.id=='_WORKSPACE_CAPACITY_CONTROL_POLICY' for target in node.targets))
        names=frozenset(policy['files'])
        # Historical V5 remains checked against its permanent real main source;
        # a later maintenance change must not rewrite this historical fixture.
        producer={'commit':frozen_main,
            'sourceTree':'b35b80e65b4dd63cd9143c3ca59ec1cec2391eff',
            'workflowRunId':'123','workflowRunAttempt':'1'}
        cached={}
        for source in (bridge['baselineProducer'],producer):
            commit=source['commit']
            cached[commit,source['sourceTree']]=subprocess.check_output(['git','archive','--format=tar.gz',
                '--prefix=id-business-system-'+commit+'/',commit],cwd=ROOT)
        d=controller(BASE=Path('/opt/id-business-v2'),_onlinePendingWorkspaceProducer=producer,
            _onlinePendingWorkspaceArchiveBytes=cached)
        # Both complete archives are independently Git-tree checked; this only
        # tests the fixed control mapping, without claiming native qualification.
        original=scope._pending_workspace_current_source_inventory(d,bridge['baselineProducer'])
        inventory=scope._pending_workspace_current_source_inventory(d,producer)
        with patch.object(scope,'_WORKSPACE_CAPACITY_CONTROL_POLICY',None):
            self.assertEqual(scope._workspace_capacity_control_inventory(d,bridge,original,inventory),frozenset())
        with patch.object(scope,'_WORKSPACE_CAPACITY_CONTROL_POLICY',policy):
            self.assertEqual(scope._workspace_capacity_control_inventory(d,bridge,original,original),frozenset())
            self.assertEqual(scope._workspace_capacity_control_inventory(d,bridge,original,inventory),names)
            path='scripts/production-release/maintain-image-cache.py'
            for replacement in ({'sha256':'c'*64,'mode':'100644'},
                {'sha256':inventory[path]['sha256'],'mode':'100755'},original[path]):
                changed={**inventory,path:replacement}
                with self.assertRaises(RuntimeError):
                    scope._workspace_capacity_control_inventory(d,bridge,original,changed)
            key=(producer['commit'],producer['sourceTree'])
            raw=cached.pop(key)
            with self.assertRaises(RuntimeError):
                scope._workspace_capacity_control_inventory(d,bridge,original,inventory)
            cached[key]=raw
            policy['files']['scripts/production-release/other.py']=copy.deepcopy(policy['files'][path])
            with self.assertRaises(RuntimeError):
                scope._workspace_capacity_control_inventory(d,bridge,original,inventory)

    def test_current_capacity_mapping_binds_all_five_owned_files_and_closed_full_archive(self):
        witness=scope._RESTORED_B_WITNESS
        bridge=json.loads(witness['failedPreflight'])['baseline']
        policy=copy.deepcopy(scope._WORKSPACE_CAPACITY_CONTROL_POLICY)
        owned={name:(ROOT/name).read_bytes() for name in policy['files']}
        for name,data in owned.items():
            self.assertEqual(policy['files'][name]['after'],{
                'mode':'100644','bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
            self.assertFalse((ROOT/name).stat().st_mode&0o111)
        base_commit='caf6c440324f83fb76e03eea8e9f2dd2f5ee5a20'
        synthetic_commit='e'*40
        base_prefix='id-business-system-'+base_commit+'/'
        prefix='id-business-system-'+synthetic_commit+'/'
        raw=subprocess.check_output(['git','archive','--format=tar.gz','--prefix='+base_prefix,base_commit],cwd=ROOT)
        with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as archive:
            entries=[(copy.copy(row),archive.extractfile(row).read() if row.isfile() else None)
                for row in archive.getmembers()]
        def rebuilt(replacements):
            output=io.BytesIO()
            with tarfile.open(fileobj=output,mode='w:gz') as archive:
                for row,old in entries:
                    row=copy.copy(row)
                    relative=row.name[len(base_prefix):] if row.name.startswith(base_prefix) else ''
                    row.name=prefix+relative if relative else prefix.rstrip('/')
                    data=replacements.get(relative,old)
                    if data is not None:
                        row.size=len(data)
                        if relative in replacements:row.mode=0o644
                    archive.addfile(row,io.BytesIO(data) if data is not None else None)
            return output.getvalue()
        # An isolated temporary index lets Git itself calculate the complete
        # source tree. This synthetic producer is never a run or publication.
        with tempfile.TemporaryDirectory(prefix='capacity-index-',dir=RUNTIME) as temporary:
            environment={**os.environ,'GIT_INDEX_FILE':str(Path(temporary)/'index')}
            subprocess.run(['git','read-tree',base_commit],cwd=ROOT,env=environment,check=True)
            for name,data in owned.items():
                blob=subprocess.check_output(['git','hash-object','-w','--stdin'],input=data,cwd=ROOT).decode().strip()
                subprocess.run(['git','update-index','--add','--cacheinfo','100644',blob,name],
                    cwd=ROOT,env=environment,check=True)
            tree=subprocess.check_output(['git','write-tree'],cwd=ROOT,env=environment).decode().strip()
        producer={'commit':synthetic_commit,'sourceTree':tree,'workflowRunId':'123','workflowRunAttempt':'1'}
        before_source=bridge['baselineProducer']
        before_raw=subprocess.check_output(['git','archive','--format=tar.gz',
            '--prefix=id-business-system-'+before_source['commit']+'/',before_source['commit']],cwd=ROOT)
        after_raw=rebuilt(owned)
        cached={(before_source['commit'],before_source['sourceTree']):before_raw,
            (synthetic_commit,tree):after_raw}
        d=controller(BASE=Path('/opt/id-business-v2'),_onlinePendingWorkspaceProducer=producer,
            _onlinePendingWorkspaceArchiveBytes=cached)
        original=scope._pending_workspace_current_source_inventory(d,before_source)
        inventory=scope._pending_workspace_current_source_inventory(d,producer)
        self.assertEqual(scope._workspace_capacity_control_inventory(d,bridge,original,inventory),frozenset(owned))
        for name in owned:
            for bad in ({'sha256':'0'*64,'mode':'100644'},
                {'sha256':inventory[name]['sha256'],'mode':'100755'},original[name]):
                with self.subTest(path=name,variation=bad):
                    with self.assertRaises(RuntimeError):
                        scope._workspace_capacity_control_inventory(d,bridge,original,{**inventory,name:bad})
        key=(synthetic_commit,tree)
        cached.pop(key)
        with self.assertRaises(RuntimeError):scope._workspace_capacity_control_inventory(d,bridge,original,inventory)
        cached[key]=rebuilt({**owned,next(iter(owned)):owned[next(iter(owned))]+b'\n'})
        with self.assertRaises(RuntimeError):scope._workspace_capacity_control_inventory(d,bridge,original,inventory)
        cached[key]=after_raw
        with self.assertRaisesRegex(RuntimeError,'SOURCE_TREE_CHANGED'):
            scope.archive_inventory(d,after_raw,synthetic_commit,'0'*40)

    def test_real_observation_diagnostic_bools_and_preserved_mysql_cannot_grant_restoration(self):
        witness=scope._RESTORED_B_WITNESS
        bridge=scope.closed_recovery_json(controller(),witness['failedPreflight'].encode())['baseline']
        changes=(lambda body:body.update(publicationQualified=True),
            lambda body:body['apiAdminRuntimeConfigurationProof'].update(formalConfigurationQualificationMeasured=True),
            lambda body:body['apiAdminRuntimeConfigurationProof']['services']['admin'].update(matched=True),
            lambda body:body['currentServices']['mysql'].update(startedAtSha256='0'*64))
        for change in changes:
            q=json.loads(witness['observationInvocation']);body=json.loads(q['StandardOutputContent']);change(body)
            q['StandardOutputContent']=json.dumps(body);raw=json.dumps(q).encode()
            policy={**witness['policy'],'readbackInvocationBytesSha256':hashlib.sha256(raw).hexdigest()}
            with self.assertRaises(RuntimeError):
                scope._restore_pure_validate_observation_material(bridge,raw,policy)

    def test_actual_independent_observation_preserves_not_measured_and_original_bridge(self):
        witness=scope._RESTORED_B_WITNESS
        original=scope.closed_recovery_json(controller(),witness['failedPreflight'].encode())['baseline']
        before=copy.deepcopy(original)
        observed=scope._restore_pure_validate_observation_material(original,witness['observationInvocation'].encode(),witness['policy'])
        self.assertEqual(original,before)
        self.assertFalse(observed['formalConfigurationQualificationMeasured'])
        self.assertFalse(observed['publicationQualified'])
        self.assertNotEqual(observed['currentServices']['api']['containerId'],original['services']['api']['containerId'])
        self.assertEqual(observed['originalApiStartedAt'],'2026-10-11T13:37:28.606112575Z')

    def test_invalid_failed_v2_observation_cannot_become_restored_f(self):
        witness=copy.deepcopy(scope._RESTORED_B_WITNESS)
        b=scope.closed_recovery_json(controller(),witness['failedPreflight'].encode())['baseline']
        q=json.loads(witness['observationInvocation']);q['Status']='Failed';q['ResponseCode']=1
        raw=json.dumps(q).encode();witness['policy']['readbackInvocationBytesSha256']=hashlib.sha256(raw).hexdigest()
        with self.assertRaises(RuntimeError):
            scope._restore_pure_validate_observation_material(b,raw,witness['policy'])

    def test_current_boot_cannot_replace_original_b_history_anchor(self):
        witness=copy.deepcopy(scope._RESTORED_B_WITNESS)
        b=scope.closed_recovery_json(controller(),witness['failedPreflight'].encode())['baseline']
        q=json.loads(witness['observationInvocation']);r=json.loads(q['StandardOutputContent'])
        witness['policy']['originalBootStartedAt']=r['apiCurrentStartedAt']
        with self.assertRaises(RuntimeError):
            scope._restore_pure_validate_observation_material(b,witness['observationInvocation'].encode(),witness['policy'])

    def test_unavailable_witness_keeps_stage_a_and_unrestored_b_on_old_path(self):
        with patch.object(scope,'_RESTORED_B_WITNESS',None),patch.object(scope,'_pending_workspace_reader',side_effect=AssertionError('must not read')):
            self.assertFalse(scope._restored_workspace_selected(controller(),scope.BASELINE_COMMIT))
            self.assertFalse(scope._restored_workspace_selected(controller(),'31d2c6885a45817cd40d23fce8d6145bc9f18af2'))
        with self.assertRaisesRegex(RuntimeError,'WITNESS_UNAVAILABLE'),patch.object(scope,'_RESTORED_B_WITNESS',None):
            scope._restored_workspace_materials(controller(),{})

    def test_v3_never_enters_stage_a_preflight_or_build_shape(self):
        d=controller()
        with self.assertRaises(RuntimeError):
            scope._workspace_preflight_binding(d,b'{"version":3}',producer={},bridge={},kind=scope.ONLINE_PENDING_WORKSPACE_KIND)
        with self.assertRaises(RuntimeError):
            scope._workspace_build_shape(d,{'version':3},producer={},bridge={},preflight_raw=b'{}',kind=scope.ONLINE_PENDING_WORKSPACE_KIND)

    def test_real_restore_transport_uses_original_b_sql_for_new_stop_identity(self):
        witness=scope._RESTORED_B_WITNESS
        bridge=scope.closed_recovery_json(controller(),witness['failedPreflight'].encode())['baseline']
        obs=scope._restore_pure_validate_observation_material(bridge,witness['observationInvocation'].encode(),witness['policy'])
        history=scope._restore_cfg_original_boot_identity(bridge,obs['originalApiStartedAt'])
        source={**{n:obs['currentServices']['api'][n] for n in ('containerId','image','startedAtSha256')},'startedAt':obs['sourceApiStartedAt']}
        # Use actual planner and actual transport.check body. Only fixed native
        # migration bytes, connection/deadline and live MySQL observation are fixtures.
        from unittest.mock import mock_open
        migration="CREATE TRIGGER `idv2_audit_log_no_delete` BEFORE DELETE ON audit_logs FOR EACH ROW BEGIN END;\nCREATE TRIGGER `idv2_audit_log_no_update` BEFORE UPDATE ON audit_logs FOR EACH ROW SET NEW.id=OLD.id;"
        reader=SimpleNamespace(ONLINE_TABLES=scope.TABLES,ONLINE_AUDIT_QUERY=shared.ONLINE_AUDIT_QUERY,
            MIGRATION_ROOT=shared.MIGRATION_ROOT,WorkspaceUnusedAuditBarrier=shared.WorkspaceUnusedAuditBarrier)
        with patch.object(Path,'read_text',return_value=migration):
            plan=scope._online_after_bit_audit_queries(controller(),reader,Path('/original-b'),history)
            current_plan=scope._online_after_bit_audit_queries(controller(),reader,Path('/original-b'),source)
            self.assertNotEqual(plan['frameQuery'],current_plan['frameQuery'])
            barrier=scope._restored_workspace_audit_transport(controller(),Path('/original-b'),bridge,reader,history,source,plan,{},restore={},first_api_check=lambda deadline:None)
            self.assertEqual(barrier.source_api_identity,source)
            self.assertEqual(barrier.query,plan['frameQuery'])
            barrier.connection_id=7
            barrier.pipe=SimpleNamespace(process=SimpleNamespace(poll=lambda:None),deadline=scope.time.monotonic()+210)
            frame={'connectionId':7,'historicalRegistrationAuditCount':1,'historicalRegistrationPrefixCount':1,
                'historyCutoff':'2026-10-11 18:44:51.000000','clockBeforeCutoff':0,'registrationMutationCount':1,
                'onlineAuditCount':0,'tables':{n:0 for n in scope.TABLES},'triggers':[
                    {'event':event,'timing':'BEFORE','statement':statement} for event,statement in plan['expectedTriggers'].items()]}
            # This row could fall after original B boot and before current boot.
            # The actual first frame must reject, instead of resetting the window.
            with self.assertRaisesRegex(RuntimeError,'AUDIT_GUARD_LOST'):
                barrier.check(frame)
            frame['registrationMutationCount']=0
            with patch.object(scope,'_online_after_bit_mysql_check',return_value=None):
                barrier.check(frame)
            self.assertEqual(barrier.query,scope._online_after_bit_audit_queries(controller(),reader,Path('/original-b'),history,history_cutoff=frame['historyCutoff'])['frameQuery'])

    def test_restore_transport_stopped_current_api_and_sqlite_must_match(self):
        source={'containerId':'c'*64,'image':'sha256:'+'d'*64,'startedAtSha256':hashlib.sha256(b'2026-10-11T17:56:28Z').hexdigest(),'startedAt':'2026-10-11T17:56:28Z'}
        history={**source,'containerId':'a'*64,'startedAt':'2026-10-11T13:37:28Z','startedAtSha256':hashlib.sha256(b'2026-10-11T13:37:28Z').hexdigest()}
        d=controller(run=lambda *args,**kwargs:json.dumps([{'Id':source['containerId'],'Image':source['image'],
            'State':{'StartedAt':source['startedAt'],'Running':False,'Pid':0}}]))
        plan={'originalOnlineQuery':shared.ONLINE_AUDIT_QUERY,'frameQuery':'before','historyQuery':'history','expectedTriggers':{},'expectedTriggersSha256':'f'*64}
        barrier=scope._restored_workspace_audit_transport(d,Path('/original-b'),{'services':{'mysql':{}}},shared,history,source,plan,{},restore={},first_api_check=lambda deadline:None)
        barrier.before=barrier.after={}
        barrier.pipe=SimpleNamespace(process=SimpleNamespace(poll=lambda:None),deadline=scope.time.monotonic()+210)
        old={n:history[n] for n in ('containerId','image','startedAtSha256')}
        with self.assertRaisesRegex(RuntimeError,'AUDIT_GUARD_LOST'):
            barrier.confirm_stopped(SimpleNamespace(record={'sourceApiIdentity':old}))
        actual={n:source[n] for n in ('containerId','image','startedAtSha256')}
        with patch.object(barrier,'check',return_value=None):
            value=barrier.confirm_stopped(SimpleNamespace(record={'sourceApiIdentity':actual}))
        self.assertEqual(value['version'],2)
        self.assertEqual(value['historyApiIdentity'],history)
        self.assertEqual(value['oldApiStop']['identity'],actual)

    def test_event_anchor_rejects_unknown_removed_admin_and_non_native_commands(self):
        witness=scope._RESTORED_B_WITNESS; proof=json.loads(witness['failedBuildProof'])
        calls=[]
        def run(*args,**kwargs):
            calls.append(args)
            if args[:3]==('docker','image','inspect'): return json.dumps([{'Id':proof['images']['admin']['imageId']}])
            return ''
        with self.assertRaisesRegex(RuntimeError,'EVENT_ANCHOR_UNPROVEN'):
            scope._restore_events_failed_candidate_event_anchor(controller(run=run),'admin',proof,witness['policy']['failedRelease'])
        self.assertTrue(calls)
        self.assertTrue(all(command[:2] in (('docker','image'),('docker','events')) for command in calls))
        command=calls[-1]
        self.assertIn('2026-10-11T17:42:42.942Z',command)
        self.assertIn('2026-10-11T17:58:11.942Z',command)
        self.assertIn('image='+proof['images']['admin']['reference'],command)


class RestoredQualifiedTests(unittest.TestCase):
    """Offline closed-schema checks only; these do not claim native qualification."""
    def fixture(self,nonce='1'*32):
        import stat
        root=Path(scope.__file__).with_name('formal-runtime-package')
        def leaf(name):
            spec=importlib.util.spec_from_file_location('_restore_test_'+name,root/(name+'.py'))
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
        pure=leaf('pure');q=leaf('qualified');c=leaf('constructor');r=leaf('reader')
        q.DERIVE=pure;q._SOURCE_TABLE_BYTES=(root/'reviewed-source-table.json').read_bytes()
        q.IDENTITY=load('_restore_test_identity','online-recharge-daemon-identity.py')
        c._configure(scope,json.loads((root/'contract.json').read_text()))
        profile=q._reviewed_profile();h=lambda v:hashlib.sha256(v.encode()).hexdigest();fp=scope.fingerprint
        producer={'commit':COMMIT,'sourceTree':TREE,'workflowRunId':'123','workflowRunAttempt':'1'}
        d=controller(_onlinePendingWorkspaceProducer=producer)
        bridge=json.loads(scope._RESTORED_B_WITNESS['failedPreflight'])['baseline']
        observed=scope._restore_pure_validate_observation_material(bridge,
            scope._RESTORED_B_WITNESS['observationInvocation'].encode(),scope._RESTORED_B_WITNESS['policy'])
        services=observed['currentServices'];summary=scope._RESTORED_B_HISTORY_VOLUME
        workspace={n:h(n) for n in r.WORKSPACE_FILES}
        workspace.update({'release-manifest.json':bridge['manifestBytesSha256'],
            'api-workspace-preservation.json':bridge['recordBytesSha256'],
            'api-workspace-build-proof.json':bridge['buildProofBytesSha256']})
        source={'docker-compose.aws-mysql.yml':bridge['configurationAfter']['docker-compose.aws-mysql.yml'],
            'compose.release.json':bridge['configurationAfter']['compose.release.json'],
            '.env.aws.production':bridge['environmentFileSha256']}
        stable={'snapshotSha256':fp(services),'sourceFilesSha256':fp({'configurationFiles':source,'workspaceFiles':workspace}),
            'workspaceVolumeSha256':fp(summary),'actualResourceSha256':h('actual resource')}
        def tools(expected,native=False):
            result={}
            for path,digest in expected.items():
                identity={'file':[1,2,stat.S_IFREG|0o755,0,0,1024,6,7,1],
                    'parents':[[1,2,stat.S_IFDIR|0o755,0,0] for _ in range(6 if path.endswith('/docker-compose') else 3)]}
                result[path]={'sha256' if native else 'bytesSha256':digest,'identity':identity}
            return result
        collection=tools(profile['reviewedCollectionToolSha256'])
        runtime={'version':1,'kind':'DOCKERD_RUNTIME_IDENTITY','status':'RUNTIME_BOUND','authority':False,
            'productionEligible':False,'proofConstructed':False,'rawOutputSuppressed':True,
            'effectivePoolRulesStatus':'SOURCE_NOT_MEASURED',
            'runtime':{**{k:h(k) for k in ('pidSha256','starttimeSha256','processSha256','executableIdentitySha256',
                'installedIdentitySha256','runtimeIdentitySha256')},'binarySha256':profile['dockerdBinarySha256'],
                'collectionToolsSha256':fp(collection),'executablePathKind':'FIXED_USR_BIN_DOCKERD',
                'rootIdentity':'OBSERVED_ROOT','installedBinding':'SAME_INODE_AND_SHA256'},
            'cmdline':{'sha256':h('args'),'argumentCount':1,'configFileEncoding':'DEFAULT_FIXED',
                'defaultAddressPoolCount':0,'defaultAddressPoolSha256':fp([])},
            'configuration':{'status':'ABSENT','sourceSha256':h('config'),'defaultAddressPoolsEncoding':'ABSENT',
                'defaultAddressPoolCount':0,'defaultAddressPoolSha256':fp(None),'effectiveRulesStatus':'SOURCE_NOT_MEASURED'},
            'package':{'name':'docker','nevraSha256':fp(q.RPM),'sourceRpmSha256':q.sha(q.SRPM_NAME),
                'fileDigestAlgorithm':'SHA256','fileDigest':profile['dockerdBinarySha256'],'querySha256':h('rpm'),
                'signatureStatus':'NOT_MEASURED','sourceRpmRetrieved':False,'patchesStatus':'NOT_MEASURED'}}
        listener={'version':1,'kind':'DOCKERD_FIXED_UNIX_SOCKET_BINDING','status':'LISTENER_HELD_BY_RUNTIME_DAEMON',
            'authority':False,'productionEligible':False,'proofConstructed':False,'rawOutputSuppressed':True,
            'unixHost':q.UNIX_HOST,'runtimeIdentity':runtime,'daemonListenerFdCount':1,'listenerRowCount':1,
            'socketActivationCreatorStatus':'NOT_MEASURED','exclusiveAcceptingProcessStatus':'NOT_MEASURED',
            **{k:h(k) for k in ('socketNodeSha256','networkNamespaceSha256','listenerSha256','daemonFdSha256','observationSha256')}}
        binding={'version':2,'kind':'DOCKERD_FIXED_UNIX_VFS_BINDING','status':'VFS_BOUND_TO_RUNTIME_DAEMON',
            'authority':False,'productionEligible':False,'proofConstructed':False,'rawOutputSuppressed':True,
            'unixHost':q.UNIX_HOST,'listenerBinding':listener,'vfsBinding':{
                **{k:h(k) for k in q.VFS_HASHES},'protocol':'AF_NETLINK_NETLINK_SOCK_DIAG_UNIX_DIAG_VFS','status':'EXACT_VFS_MATCH'}}
        rules={'spec':profile['spec'],'rulesSha256':fp(profile['spec']),'sourceInputsSha256':fp(profile['sourceInputs']),
            'sourceReviewReportSha256':profile['sourceReviewReportSha256']}
        capsule={'binding':binding,'nativeTools':tools({profile['spec']['dockerPath']:q.DOCKER_SHA,
            profile['spec']['composePath']:q.COMPOSE_SHA},True),'collectionTools':collection,
            'daemonSha256':h('daemon'),'profileSha256':q.REVIEWED_PROFILE_CANONICAL_SHA256,'rules':rules}
        state={'status':'created','running':False,'pid':0,'startedAtSha256':hashlib.sha256(b'0001-01-01T00:00:00Z').hexdigest(),
            'restartCount':0};project='online-recharge-reference-'+nonce
        def row(tag):return {'owner':nonce,'createdAtSha256':h(nonce+tag+'created'),
            'creationMetadataSha256':h(nonce+tag+'meta'),'preCleanupMetadataSha256':h(nonce+tag+'meta')}
        registry={'container':{**row('c'),'id':h(nonce+'c'),'name':'/'+project+'-api-1',
            'stateAtCreate':copy.deepcopy(state),'stateBeforeCleanup':copy.deepcopy(state)},
            'networks':{role:{**row(role),'id':h(nonce+role),'name':project+'_'+role} for role in c.ROLES},
            'volume':{**row('v'),'name':project+'_auto_registration_data'}}
        facts={'version':1,'formalTableSha256':c.FORMAL_TABLE_SHA,'sourceFileSealsSha256':fp({n:{'sha256':v,'identitySha256':h(n+' identity')} for n,v in source.items()}),
            'generator':{'engineVersion':'25.0.16','composeVersion':'5.5.0','rulesSha256':rules['rulesSha256']},
            'source':{k:h(k) for k in c.SOURCE_FACT_KEYS},'referenceRegistry':registry,
            'referenceInputs':{'modelCanonicalSha256':h(nonce+'model'),'surrogateEnvironmentSha256':h('reference env'),
                'emptyEnvironmentBytesSha256':hashlib.sha256(b'').hexdigest(),
                'emptyDockerConfigBytesSha256':hashlib.sha256(b'{}\n').hexdigest(),
                'beforeFileSealsSha256':h(nonce+'files'),'afterFileSealsSha256':h(nonce+'files')},
            'stableBefore':stable,'stableAfter':copy.deepcopy(stable)}
        facts['source']['expectedEnvironmentSha256']=services['api']['environmentSha256']
        facts['source']['referenceEnvironmentSha256']=h('reference env')
        measured={k:h(k) for k in c.MEASURED_KEYS if k.endswith('Sha256')}
        measured.update(matched=True,reason='COMPLETE_EQUAL',status='CONTROL_ONLY_DECLARATION_MEASURED',
            historicalRawHashMatchClaimed=False,authority=False,productionEligible=False,
            actualRawConfigurationSha256=services['api']['configurationSha256'],
            referenceRawConfigurationSha256=h(nonce+'raw'),actualDeclarationNormalizedSha256=h('normalized'),
            referenceDeclarationNormalizedSha256=h('normalized'),actualResourceSha256=stable['actualResourceSha256'],
            sourceFileSealsSha256=facts['sourceFileSealsSha256'],referenceResourceSha256=fp(c.adapter42_registered(registry)),
            referenceModelSha256=facts['referenceInputs']['modelCanonicalSha256'],sourceUnchangedBeforeAndAfter=True,
            referenceNeverStarted=True,cleanup={'ownedContainersRemaining':0,'ownedNetworksRemaining':0,
                'ownedVolumesRemaining':0,'exactOwnerCreationSealsVerified':True,'existingResourcesMutated':False})
        admin={'kind':'ONLINE_RECHARGE_B_RESTORE_COMPLETE_CONFIGURATION_MATERIAL','version':1,'service':'admin',
            'actualServiceSha256':fp(services['admin']),'originalServiceSha256':fp(bridge['services']['admin']),
            'actualConfigurationSha256':services['admin']['configurationSha256'],
            'originalConfigurationSha256':bridge['services']['admin']['configurationSha256'],
            'reconstructedConfigurationSha256':bridge['services']['admin']['configurationSha256'],
            'changedIdentityPaths':['Config.Hostname','Config.Labels.com.docker.compose.replace'],
            'hostnameMappingSha256':fp({'actual':services['admin']['containerId'][:12],
                'original':bridge['services']['admin']['containerId'][:12]}),
            'replaceMappingSha256':h('offline replace mapping'),'acquiredReplaceAnchorsSha256':h('offline anchor')}
        proof={'kind':'ONLINE_RECHARGE_B_RESTORED_SOURCE_QUALIFICATION','version':1,'purpose':'INDEPENDENT_PREFLIGHT',
            'preflightQualificationSha256':None,'preflightBytesSha256':None,'preflightReferenceRegistrySha256':None,'producer':producer,'baselineOriginSha256':fp(bridge),
            'observationSha256':scope._RESTORED_B_WITNESS['policy']['readbackInvocationBytesSha256'],
            'diagnosticInvocationSha256':scope._RESTORED_B_OOM_WITNESS['bytesSha256'],
            'sourceSeal':{'baselineCommit':scope.BASELINE_COMMIT,'directory':bridge['baselineRelease'],'files':source,
                'servicesSha256':fp(services),'stabilitySha256':fp(stable),
                'replaceAnchors':{'candidateAfterContainerId':bridge['services']['api']['containerId'],
                    'stableName':'20260821t095106z-api-1'}},'configurationFiles':bridge['configurationAfter'],
            'workspaceFiles':workspace,'workspaceVolume':summary,'stableObservation':stable,'sourceFileSeals':{n:{'sha256':v,'identitySha256':h(n+' identity')} for n,v in source.items()},'qualification':capsule,
            'measured':measured,'facts':facts,'adminMaterialSha256':fp(admin),
            'historicalApiConfigurationSha256':bridge['services']['api']['configurationSha256'],
            'actualApiConfigurationSha256':services['api']['configurationSha256'],'historicalRawHashMatchClaimed':False}
        caps=SimpleNamespace(qualified=q,constructor=c,reader=r)
        r.INVENTORY=SimpleNamespace(BASELINE=scope.BASELINE_COMMIT)
        return d,caps,proof,bridge,services,admin

    def test_new_b_closed_schema_preserves_history_and_current_full_hash_separately(self):
        args=self.fixture();self.assertEqual(scope._restored_qualified_proof(*args), '1'*32)
        self.assertNotEqual(args[2]['historicalApiConfigurationSha256'],args[2]['actualApiConfigurationSha256'])
        self.assertFalse(args[2]['measured']['productionEligible'])
        scope._restored_qualified_oom_history(args[0],{'currentServices':args[4]})

    def test_new_b_qualification_rejects_bool_only_missing_extra_and_source_config_tampering(self):
        for path,value in ((('measured','matched'),False),(('measured','authority'),True),
            (('measured','actualRawConfigurationSha256'),'f'*64),(('measured','referenceDeclarationNormalizedSha256'),'e'*64),
            (('facts','source','expectedEnvironmentSha256'),'e'*64),(('sourceSeal','files','docker-compose.aws-mysql.yml'),'e'*64),
            (('sourceSeal','replaceAnchors','candidateAfterContainerId'),'e'*64),
            (('workspaceVolume','identitySha256'),'e'*64),(('qualification','profileSha256'),'e'*64),
            (('qualification','binding','vfsBinding','protocol'),'OTHER'),
            (('qualification','binding','listenerBinding','runtimeIdentity','package','nevraSha256'),'e'*64),
            (('qualification','rules','sourceInputsSha256'),'e'*64),
            (('qualification','rules','spec','renderedDependencies','media-resolver','required'),1),
            (('facts','referenceInputs','afterFileSealsSha256'),'e'*64),
            (('measured','cleanup','ownedContainersRemaining'),False),
            (('facts','referenceRegistry','container','stateBeforeCleanup','pid'),True)):
            args=self.fixture();v=args[2]
            for part in path[:-1]:v=v[part]
            v[path[-1]]=value
            with self.subTest(path=path),self.assertRaises(RuntimeError):scope._restored_qualified_proof(*args)
        for node in ('measured','facts','qualification'):
            args=self.fixture();args[2][node]['extra']=True
            with self.assertRaises(RuntimeError):scope._restored_qualified_proof(*args)
        args=self.fixture();del args[2]['measured']['referenceRawConfigurationSha256']
        with self.assertRaises(RuntimeError):scope._restored_qualified_proof(*args)

    def test_new_b_second_reference_has_distinct_owned_resources_and_same_complete_semantics(self):
        d,caps,one,bridge,services,admin=self.fixture();two=self.fixture('2'*32)[2]
        two['purpose']='DEPLOYMENT_REMEASURE';two['preflightQualificationSha256']=scope.fingerprint(one)
        d._restoredWorkspacePreflightRaw=b'OFFLINE ENTRY FIXTURE ONLY'
        two['preflightBytesSha256']=hashlib.sha256(d._restoredWorkspacePreflightRaw).hexdigest()
        two['preflightReferenceRegistrySha256']=scope.fingerprint(one['facts']['referenceRegistry'])
        two['qualification']['binding']['listenerBinding']['networkNamespaceSha256']='e'*64
        two['qualification']['binding']['listenerBinding']['observationSha256']='f'*64
        scope._restored_qualified_pair(d,caps,one,two,bridge,services,admin)
        for row in ('container','volume','networks'):
            changed=copy.deepcopy(two);changed['facts']['referenceRegistry'][row]=copy.deepcopy(one['facts']['referenceRegistry'][row])
            changed['measured']['referenceResourceSha256']=scope.fingerprint(caps.constructor.adapter42_registered(changed['facts']['referenceRegistry']))
            with self.assertRaises(RuntimeError):scope._restored_qualified_pair(d,caps,one,changed,bridge,services,admin)
        for field in ('preflightQualificationSha256','preflightBytesSha256','preflightReferenceRegistrySha256'):
            for value in (None,'0'*64):
                changed=copy.deepcopy(two);changed[field]=value
                with self.subTest(field=field,value=value),self.assertRaises(RuntimeError):
                    scope._restored_qualified_pair(d,caps,one,changed,bridge,services,admin)
        for path in (('qualification','daemonSha256'),('qualification','binding','listenerBinding','socketNodeSha256'),
            ('qualification','binding','listenerBinding','listenerSha256'),('facts','source','renderedDeclarationSha256'),('facts','sourceFileSealsSha256')):
            changed=copy.deepcopy(two);v=changed
            for part in path[:-1]:v=v[part]
            v[path[-1]]='e'*64
            with self.assertRaises(RuntimeError):scope._restored_qualified_pair(d,caps,one,changed,bridge,services,admin)

    def acquisition_fixture(self,events,*,exit_error=None):
        """Fake native edges, real measure orchestration and complete proof validators."""
        d,caps,proof,bridge,services,admin=self.fixture()
        previous=Path(bridge['baselineRelease']);d.BASE=previous.parent.parent
        workspace=proof['workspaceFiles'];source=proof['sourceSeal']['files'];fp=scope.fingerprint
        volume={'Name':proof['workspaceVolume']['name'],'Driver':'local','Scope':'local','Mountpoint':'/fixture',
            'Labels':{},'CreatedAt':'fixture','Options':None}
        summary={'name':volume['Name'],'status':'PRESENT','identitySha256':fp(volume)}
        # The synthetic full inspect has its own real full hash; no historical
        # production hash is reconstructed or treated as native evidence here.
        project='20260821t095106z';roles=caps.constructor.ROLES
        networks={role:{'Id':hashlib.sha256(role.encode()).hexdigest()} for role in roles}
        api={'Name':'/'+project+'-api-1','Config':{'Labels':{'com.docker.compose.project':project}},
            'NetworkSettings':{'Networks':{project+'_'+role:{'NetworkID':value['Id']} for role,value in networks.items()}}}
        raw={'snapshot':services,'sourceFiles':{'configurationFiles':source,'workspaceFiles':workspace},
            'workspaceVolume':volume,'actualResource':{'networks':networks,'volume':volume}}
        stable=caps.qualified.DERIVE.observation(raw,services,source,raw['actualResource'])
        identity={'device':1,'inode':2,'uid':0,'gid':0,'mode':0o100600,'size':32,'links':1}
        seals={name:{'sha256':digest,'identitySha256':fp(identity)} for name,digest in source.items()}
        proof['workspaceVolume']=summary;proof['stableObservation']=stable;proof['sourceFileSeals']=seals
        proof['facts'].update(stableBefore=stable,stableAfter=stable,sourceFileSealsSha256=fp(seals))
        proof['measured'].update(actualResourceSha256=stable['actualResourceSha256'],sourceFileSealsSha256=fp(seals))
        next_proof=self.fixture('2'*32)[2]
        next_proof['facts'].update(stableBefore=stable,stableAfter=stable,sourceFileSealsSha256=fp(seals))
        next_proof['measured'].update(actualResourceSha256=stable['actualResourceSha256'],sourceFileSealsSha256=fp(seals))
        class Session:
            runner=object()
            def __enter__(self):events.append('acquisition-enter');return self
            def __exit__(self,*unused):
                events.extend(('context-final-stability','context-owned-cleanup'))
                if exit_error:raise RuntimeError(exit_error)
            def assert_stable(self):events.append('session-stability')
            def measure(self,directory,**kwargs):
                events.append('native-reference-measure')
                require(directory==previous and kwargs['services']==services
                    and kwargs['stability_reader']()==raw,'BAD_OFFLINE_DISPATCH')
                round_proof=proof if events.count('native-reference-measure')==1 else next_proof
                return {k:copy.deepcopy(round_proof[k]) for k in ('measured','facts')}
        caps.package=SimpleNamespace(assert_stable=lambda:events.append('package-stability'))
        caps.workspace=SimpleNamespace(STATE_FILE='api-workspace-preservation.json',
            workspace_volume=lambda *args,**kwargs:summary)
        caps.reader.INVENTORY.NETWORK_ROLES=roles;caps.reader.WORKSPACE={'WORKSPACE_VOLUME':'auto_registration_data'}
        caps.reader.DERIVE=caps.qualified.DERIVE
        def inspect(reader,runner,*args):
            if args[:2]==('docker','network'):return next(v for v in networks.values() if v['Id']==args[-1])
            if args[:2]==('docker','volume'):return volume
            return api if args[-1]==services['api']['containerId'] else {'fixtureAdmin':True}
        driver=SimpleNamespace(BASELINE=scope.BASELINE_COMMIT,_SourceReadDriver=lambda runner:runner,
            _ArchiveBoundController=lambda actual,cap:actual,_inspect=inspect,
            _capabilities=lambda producer:(events.append('archive-bound-capabilities') or caps))
        original_resolve=Path.resolve
        stack=ExitStack()
        for target,name,value in ((scope,'_declaration_runtime_driver',lambda:driver),
            (scope,'_restored_qualified_capture',lambda actual,cap,session:copy.deepcopy(proof['qualification'])),
            (caps.qualified,'acquisition_session',lambda owner:Session()),
            (caps.reader,'files',lambda *args,**kwargs:{n:{'sha256':source.get(n,workspace.get(n,
                bridge['configurationAfter'].get(n))),'identity':identity} for n in args[1]}),
            (caps.reader,'make_reader',lambda *args,**kwargs:lambda:copy.deepcopy(raw)),
            (caps.reader,'volume_summary',lambda value:summary),(scope,'configuration_hashes',lambda unused:bridge['configurationAfter']),
            (scope,'workspace_files',lambda *args:workspace),(scope,'snapshot',lambda *args,**kwargs:services),
            (scope,'_declaration_source_bytes',lambda *args,**kwargs:json.dumps({'before':{'admin':{'containerId':'a'*64}}}).encode()),
            (scope,'_restore_cfg_complete_configuration_material',lambda *args,**kwargs:admin),
            (scope,'_RESTORED_B_HISTORY_VOLUME',summary),(os,'geteuid',lambda:0),
            (Path,'resolve',lambda path,*args,**kwargs:previous if path==d.BASE/'current' else original_resolve(path,*args,**kwargs))):
            stack.enter_context(patch.object(target,name,value))
        return stack,d,caps,bridge,services,admin,previous

    def test_new_b_actual_measure_dispatch_closes_context_before_issuance_and_cleanup_error_blocks_return(self):
        for failure in (None,'CONTEXT_FINAL_STABILITY_FAILED','CONTEXT_OWNED_CLEANUP_FAILED'):
            events=[];stack,d,caps,bridge,services,admin,previous=self.acquisition_fixture(events,exit_error=failure)
            with stack:
                if failure:
                    with self.assertRaisesRegex(RuntimeError,failure):
                        scope._restored_qualified_measure(d,previous,bridge,services,admin)
                    self.assertEqual(events[-1],'context-owned-cleanup')
                else:
                    result=scope._restored_qualified_measure(d,previous,bridge,services,admin)
                    events.append('proof-issued')
                    self.assertEqual(result['purpose'],'INDEPENDENT_PREFLIGHT')
                    self.assertLess(events.index('context-owned-cleanup'),events.index('proof-issued'))
                    self.assertIs(scope._restored_qualified_capabilities(d),caps)
                    with patch.object(caps.package,'assert_stable',side_effect=RuntimeError('PACKAGE_SOURCE_CHANGED')):
                        with self.assertRaisesRegex(RuntimeError,'PACKAGE_SOURCE_CHANGED'):
                            scope._restored_qualified_capabilities(d)
                    profile=caps.qualified._reviewed_profile()
                    with patch.object(caps.qualified,'_reviewed_profile',return_value={**profile,'changedSource':True}):
                        with self.assertRaises(RuntimeError):scope._restored_qualified_capabilities(d)
                    d._onlinePendingWorkspaceProducer={**d._onlinePendingWorkspaceProducer,'workflowRunId':'124'}
                    with self.assertRaises(RuntimeError):scope._restored_qualified_capabilities(d)
                self.assertEqual(events.count('native-reference-measure'),1)
                self.assertEqual(events.count('archive-bound-capabilities'),1)

    def test_new_b_stage_owned_f_precedes_one_remeasure_and_checks_do_not_reacquire(self):
        events=[];stack,d,caps,bridge,services,admin,previous=self.acquisition_fixture(events)
        with stack:
            original=json.loads(scope._RESTORED_B_WITNESS['failedPreflight']);held=[]
            def preflight_baseline(actual,expected):
                require(actual is d and expected==bridge['baselineCommit'],'BAD_OFFLINE_PREFLIGHT')
                events.append('original-preflight-baseline')
                held.append(scope._restored_qualified_measure(d,previous,bridge,services,admin))
                return previous,{},services,original['ordinaryPreflight']
            with patch.object(scope,'baseline',side_effect=preflight_baseline),\
                patch.object(scope,'migration_source_check',side_effect=lambda *a,**kw:events.append('original-migration-source-check')),\
                patch.object(scope,'release_recovery',return_value={'state':original['ordinaryPreflight']['migrationState']}),\
                patch.object(scope,'legacy',return_value=SimpleNamespace(strict_audit=lambda *a:original['ordinaryPreflight']['audit'])):
                scope._PENDING_WORKSPACE_FIRST['preflight'](d,bridge['baselineCommit'])
            first=held[0]
            self.assertEqual(events.count('original-preflight-baseline'),1)
            self.assertEqual(events.count('native-reference-measure'),1)
            observed=scope._restore_pure_validate_observation_material(bridge,
                scope._RESTORED_B_WITNESS['observationInvocation'].encode(),scope._RESTORED_B_WITNESS['policy'])
            side={'kind':'ONLINE_RECHARGE_B_RESTORE_COMPLETE_MATERIAL','version':2,'publicationQualified':False,
                'baselineOriginSha256':scope.fingerprint(bridge),'observationSha256':scope.fingerprint(observed),
                'actualServicesSha256':scope.fingerprint(services),'configurationProofSha256':scope.fingerprint({'admin':admin,'api':first}),
                'historyApiIdentity':{**{k:bridge['services']['api'][k] for k in ('containerId','image','startedAtSha256')},
                    'startedAt':observed['originalApiStartedAt']},
                'stopApiIdentity':{**{k:services['api'][k] for k in ('containerId','image','startedAtSha256')},
                    'startedAt':observed['sourceApiStartedAt']},'configurationMaterials':{'admin':admin},
                'apiDeclarationQualification':first}
            receipt={**original['ordinaryPreflight'],'services':services,'afterBitRestoration':side}
            producer=d._onlinePendingWorkspaceProducer
            f={**original,'version':3,'releaseCandidateCommit':producer['commit'],'sourceTree':producer['sourceTree'],
                'workflowRunId':producer['workflowRunId'],'workflowRunAttempt':producer['workflowRunAttempt'],
                'ordinaryPreflight':scope._restored_wire_encode(receipt),'restoration':side,'services':services}
            fraw=(json.dumps(f,separators=(',',':'))+'\n').encode()
            build={**proof(),'kind':'ONLINE_RECHARGE_AFTER_BIT_BUILD_PROOF','version':3,
                'commit':producer['commit'],'sourceTree':producer['sourceTree'],'baselineCommit':bridge['baselineCommit'],
                'baselineOriginSha256':scope.fingerprint(bridge),'preflightBytesSha256':hashlib.sha256(fraw).hexdigest(),
                'restorationSha256':scope.fingerprint(side),'beforeServicesSha256':scope.fingerprint(services)}
            args=SimpleNamespace(online_recharge_only=True,expected_current=bridge['baselineCommit'],
                commit=producer['commit'],source_tree=producer['sourceTree'],run_id=producer['workflowRunId'],
                run_attempt=producer['workflowRunAttempt'],repository=REPOSITORY,ci_run_id='123',
                online_recharge_build_proof=base64.b64encode(json.dumps(build).encode()).decode())
            reader=SimpleNamespace(**vars(shared));reader.online_after_bit_cold=lambda *a,**kw:copy.deepcopy(bridge)
            reader.STATE_FILE='api-workspace-preservation.json';reader.PROOF_FILE='api-workspace-build-proof.json'
            reader.validate_proof=lambda *a:build;reader.verify_running=lambda *a:events.append('old-B-running-check')
            reader.workspace_health=lambda *a:events.append('old-B-health-check')
            reader.workspace_sqlite_receipt=lambda *a:{'fixture':'existing protected backup'}
            old={'before':{'admin':{'containerId':'a'*64}},'baselineEvidence':{},'workspaceVolumeAfter':first['workspaceVolume']}
            def source_bytes(path,**kwargs):return json.dumps(old).encode()
            def owned(*a,**kw):events.append('owned-F-acquired');return fraw
            def receipt_check(actual,value,mode,commit,expected):
                require(value==receipt and mode=='preflight' and expected==bridge['baselineCommit'],'BAD_OFFLINE_RECEIPT')
                events.append('complete-F-receipt-checked')
            with ExitStack() as edges:
                for name,value in (('_pending_workspace_reader',lambda actual:reader),('legacy',lambda actual:reader),
                    ('_workspace_baseline_reader',lambda *a,**kw:(scope.ONLINE_AFTER_BIT_KIND,reader.online_after_bit_cold)),
                    ('_restored_workspace_cold_cache',lambda *a:events.append('offline-historical-cache-checked')),
                    ('_pending_workspace_profile',lambda *a:events.append('full-source-profile-check')),
                    ('_workspace_owned_preflight',owned),('online_after_bit_preflight_bytes',owned),
                    ('_pending_workspace_validate_receipt',receipt_check),
                    ('_restored_workspace_materials',lambda *a:(observed,{})),
                    ('_restored_workspace_native_failure_anchor',lambda *a:'closed failed-C fixture'),
                    ('_workspace_after_bit_materials',lambda *a,**kw:{'fixture':'closed immutable B'}),
                    ('_declaration_source_bytes',source_bytes),('workspace_guard',lambda *a:first['workspaceVolume']),
                    ('jobs_idle',lambda *a,**kw:receipt['guards']),
                    ('release_recovery',lambda *a:{'source':previous,'marker':bridge['migrationRecovery'],'state':{'status':'APPLIED'}}),
                    ('verify_permission_seed',lambda *a:events.append('permission-seed-checked')),
                    ('require_fresh_resources',lambda *a:events.append('fresh-resource-checked')),
                    ('workspace_origin',lambda *a:events.append('full-origin-check'))):
                    edges.enter_context(patch.object(scope,name,value))
                edges.enter_context(patch.object(scope.shutil,'disk_usage',return_value=SimpleNamespace(free=7*1024**3)))
                d.run=lambda *a,**kw:json.dumps([{'fixtureAdmin':True}])
                mark=len(events)
                scope.validate_arguments(d,args)
                self.assertEqual(events[mark:].count('native-reference-measure'),0)
                self.assertEqual(d._restoredWorkspacePreflightRaw,fraw)
                before_baseline=len(events)
                scope.baseline(d,bridge['baselineCommit'])
                self.assertEqual(events[before_baseline:].count('native-reference-measure'),1)
                self.assertEqual(events.count('native-reference-measure'),2)
                self.assertLess(events.index('owned-F-acquired'),before_baseline)
                self.assertEqual(d._onlinePendingWorkspaceSession['restoration'],side)
                deployment=d._onlinePendingWorkspaceSession['deploymentQualification']
                self.assertEqual(deployment['purpose'],'DEPLOYMENT_REMEASURE')
                checks_start=len(events)
                scope._pending_workspace_session(d)
                scope._restored_workspace_audit_binding(d,bridge,build)
                self.assertEqual(events[checks_start:].count('native-reference-measure'),0)
                self.assertEqual(events.count('archive-bound-capabilities'),1)
                self.assertEqual(events.count('context-owned-cleanup'),2)
                target=d.BASE/'releases'/('20261012T200000Z-'+producer['commit'][:12])
                after=copy.deepcopy(services)
                for service in scope.UPDATED:
                    after[service]={**services.get(service,services['api']),
                        'image':build['images'][service]['imageId'],'reference':build['images'][service]['reference']}
                record={'baselineEvidence':{'onlineAfterBitOrigin':bridge,'afterBitRestoration':side},
                    'before':services,'after':after,'buildProofSha256':scope.fingerprint(build),
                    'configurationBefore':bridge['configurationAfter'],'configurationAfter':bridge['configurationAfter'],
                    'migration':{**bridge['migrationState'],'performed':False},
                    'afterBitAuditProtection':{'basis':{'deploymentQualification':deployment}}}
                manifest={'previousRelease':str(previous),'previousCommit':bridge['baselineCommit'],
                    'commit':producer['commit'],'sourceTree':producer['sourceTree'],
                    'previousManifestSha256':bridge['manifestBytesSha256'],'migrationPerformed':False}
                rawfiles={scope.STATE_FILE:record,scope.PROOF_FILE:build,'release-manifest.json':manifest}
                cold=controller(BASE=d.BASE,_onlinePendingWorkspaceProducer=copy.deepcopy(producer))
                for name in ('_restoredWorkspaceCapabilities','_onlinePendingWorkspaceSession',
                        '_restoredWorkspacePreflight','_restoredWorkspacePreflightRaw'):
                    self.assertFalse(hasattr(cold,name))
                original_resolve=Path.resolve;original_stat=Path.stat
                with patch.object(Path,'resolve',lambda path,*a,**kw:target if path==d.BASE/'current'
                        else (target if path==target else original_resolve(path,*a,**kw))),\
                    patch.object(Path,'is_dir',return_value=True),patch.object(Path,'is_symlink',return_value=False),\
                    patch.object(Path,'stat',lambda path,*a,**kw:SimpleNamespace(st_uid=0,st_mode=0o40700)
                        if path==target else original_stat(path,*a,**kw)),\
                    patch.object(scope,'snapshot',side_effect=lambda *a,**kw:after if kw.get('include_engine') else services),\
                    patch.object(scope,'_declaration_source_bytes',side_effect=lambda path,**kw:json.dumps(rawfiles[path.name]).encode()):
                    readback_start=len(events)
                    self.assertEqual(scope._restored_workspace_readback_origin(cold,target,producer['commit'],producer,bridge),bridge)
                    self.assertEqual(events[readback_start:].count('native-reference-measure'),0)
                    self.assertEqual(events[readback_start:].count('owned-F-acquired'),1)
                    self.assertEqual(events[readback_start:].count('archive-bound-capabilities'),1)
                    self.assertEqual(cold._restoredWorkspacePreflightRaw,fraw)
                    self.assertEqual(cold._onlinePendingWorkspaceSession['deploymentQualification'],deployment)

    def test_new_b_fixed_identity_serialization_rejects_permission_and_tuple_shape_changes(self):
        d,caps,proof,*unused=self.fixture();row=proof['qualification']['nativeTools'];expected={k:v['sha256'] for k,v in row.items()}
        raw=copy.deepcopy(row)
        for value in raw.values():
            value['identity']['file']=tuple(value['identity']['file'])
            value['identity']['parents']=[tuple(v) for v in value['identity']['parents']]
        self.assertEqual(scope._restored_qualified_tools(d,raw,expected,native=True,capture=True),row)
        raw['/usr/bin/docker']['identity']['file']=raw['/usr/bin/docker']['identity']['file'][:-1]
        with self.assertRaises(RuntimeError):scope._restored_qualified_tools(d,raw,expected,native=True,capture=True)
        row=copy.deepcopy(row);row['/usr/bin/docker']['identity']['file'][2]|=0o002
        with self.assertRaises(RuntimeError):scope._restored_qualified_tools(d,row,expected,native=True)

    def test_new_b_acquisition_entry_is_original_measure_and_issues_after_successful_context_close(self):
        source=Path(scope.__file__).read_text();import ast
        node=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=='_restored_qualified_measure')
        body=ast.get_source_segment(source,node)
        self.assertIn('caps.qualified.acquisition_session(driver._ArchiveBoundController(d,caps))',body)
        self.assertIn('session.measure(previous,services=services',body)
        self.assertIn('caps.reader.make_reader(runner,previous',body)
        self.assertNotIn('construct_preview',body);self.assertNotIn('driver.acquire(',body)
        self.assertGreater(body.rfind('return proof'),body.rfind('    caps.package.assert_stable()'))
        validate=[n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=='validate_arguments'][-1]
        self.assertIn('live=not restored',ast.get_source_segment(source,validate))

    def test_new_b_fixed_capacity_and_docs_mapping_exact_five_and_two_groups(self):
        self.assertEqual(set(scope._WORKSPACE_CAPACITY_CONTROL_POLICY['files']),{
            '.github/workflows/production-release.yml','scripts/production-release/maintain-image-cache.py',
            'scripts/production-release/maintain-image-cache.test.py',
            'scripts/production-release/service-image-retention.py',
            'scripts/production-release/service-image-retention.test.py'})
        self.assertEqual(set(scope._WORKSPACE_RELEASE_RULES_POLICY['files']),{'AGENTS.md','docs/CENTRAL_RELEASE_20261002.md'})
        self.assertEqual(scope._WORKSPACE_CAPACITY_CONTROL_POLICY['files']['scripts/production-release/maintain-image-cache.test.py']['after']['sha256'],
            hashlib.sha256((ROOT/'scripts/production-release/maintain-image-cache.test.py').read_bytes()).hexdigest())
        for policy in (scope._WORKSPACE_CAPACITY_CONTROL_POLICY,scope._WORKSPACE_RELEASE_RULES_POLICY):
            for pair in policy['files'].values():
                for value in pair.values():
                    self.assertEqual(set(value),{'mode','bytes','sha256'});self.assertEqual(value['mode'],'100644')
        args=self.fixture();d=args[0]
        original={n:{k:p['before'][k] for k in ('sha256','mode')} for n,p in scope._WORKSPACE_CAPACITY_CONTROL_POLICY['files'].items()}
        inventory={n:{k:p['after'][k] for k in ('sha256','mode')} for n,p in scope._WORKSPACE_CAPACITY_CONTROL_POLICY['files'].items()}
        inventory['scripts/production-release/maintain-image-cache.py']['sha256']='f'*64
        with self.assertRaises(RuntimeError):scope._workspace_capacity_control_inventory(d,args[3],original,inventory)

    def test_new_b_complete_f_and_native_receipt_fit_original_wire_budgets(self):
        d,caps,proof,bridge,services,admin=self.fixture()
        # Complete ordinary F fixture preserves original unchanged evidence.
        original=json.loads(scope._RESTORED_B_WITNESS['failedPreflight'])
        observed=scope._restore_pure_validate_observation_material(bridge,
            scope._RESTORED_B_WITNESS['observationInvocation'].encode(),scope._RESTORED_B_WITNESS['policy'])
        side={'kind':'ONLINE_RECHARGE_B_RESTORE_COMPLETE_MATERIAL','version':2,'publicationQualified':False,
            'baselineOriginSha256':scope.fingerprint(bridge),'observationSha256':scope.fingerprint(observed),
            'actualServicesSha256':scope.fingerprint(services),'configurationProofSha256':scope.fingerprint({'admin':admin,'api':proof}),
            'apiDeclarationQualification':proof,'historyApiIdentity':{**{k:bridge['services']['api'][k]
                for k in ('containerId','image','startedAtSha256')},'startedAt':observed['originalApiStartedAt']},
            'stopApiIdentity':{**{k:services['api'][k] for k in ('containerId','image','startedAtSha256')},
                'startedAt':observed['sourceApiStartedAt']},'configurationMaterials':{'admin':admin}}
        receipt={**original['ordinaryPreflight'],'afterBitRestoration':side,'services':services}
        wire=scope._restored_wire_encode(receipt)
        self.assertLess(len(json.dumps(wire))+1,24000)
        self.assertEqual(scope._restored_wire_decode(json.dumps(wire)),receipt)
        f={**original,'version':3,'ordinaryPreflight':wire,'restoration':side,'services':services}
        raw=(json.dumps(f,separators=(',',':'))+'\n').encode()
        self.assertLess(len(raw),65535)
        self.assertEqual(scope._restored_workspace_f_value(d,raw)['ordinaryPreflight'],receipt)
        native=json.loads(scope._RESTORED_B_WITNESS['observationInvocation'])
        native['StandardOutputContent']=json.dumps(wire)+'\n'
        self.assertLess(len(json.dumps(native).encode()),65535)
        readback={**receipt,'status':scope.SCOPE+'_VERIFIED','sourceTree':TREE,'servicesUpdated':list(scope.UPDATED),
            'preservedServiceCount':len(scope.PRESERVED),'runningImagesAndContentMatched':True,
            'buildProofSha256':'a'*64,'migrationApplied':True,'existingEnvironmentPreserved':True,'credentialsLoopback':True,
            'dedicatedVolume':scope.MEDIA_VOLUME,'backupVerified':True,'workspaceBackupVerified':True,
            'workspaceVolumePreserved':True,'checkCount':49,'violationCount':0,
            'legacyWorkersPublished':False,'externalAcceptancePerformed':False,
            'afterBitAuditProtectionSha256':'b'*64,'preservedRegistrationAuditCount':0,
            'auditHistoryCutoff':'2026-10-12 20:00:00.000000'}
        self.assertLess(len(json.dumps(scope._restored_wire_encode(readback)).encode())+1,24000)
        changed=copy.deepcopy(f);changed['restoration']['publicationQualified']=True
        with self.assertRaises(RuntimeError):scope._restored_workspace_f_value(d,json.dumps(changed).encode())

    def test_new_b_compressed_wire_rejects_truncation_concat_bomb_and_wrong_scope(self):
        import zlib
        d,caps,proof,bridge,services,admin=self.fixture()
        receipt={'onlineAfterBitOrigin':bridge,'afterBitRestoration':{'kind':'ONLINE_RECHARGE_B_RESTORE_COMPLETE_MATERIAL',
            'version':2,'publicationQualified':False,'apiDeclarationQualification':proof}}
        envelope=scope._restored_wire_encode(receipt)
        for field,value in (('version',True),('decodedLength',False),('decodedSha256','f'*64),('encoding','gzip'),('extra',True)):
            changed={**envelope,field:value}
            with self.assertRaises(RuntimeError):scope._restored_wire_decode(json.dumps(changed))
        packed=base64.b64decode(envelope['payload'])
        for raw in (packed[:-1],packed+b'junk',packed+packed,gzip.compress(b'x'*65536,mtime=0)):
            changed={**envelope,'payload':base64.b64encode(raw).decode()}
            with self.assertRaises(RuntimeError):scope._restored_wire_decode(json.dumps(changed))
        boundary={**receipt,'offlineCodecPadding':''}
        boundary['offlineCodecPadding']='x'*(65535-len(json.dumps(boundary,separators=(',',':')).encode()))
        self.assertEqual(len(json.dumps(boundary,separators=(',',':')).encode()),65535)
        self.assertEqual(scope._restored_wire_decode(json.dumps(scope._restored_wire_encode(boundary))),boundary)
        boundary['offlineCodecPadding']+='x'
        with self.assertRaises(RuntimeError):scope._restored_wire_encode(boundary)
        for raw in ('{"duplicate":1,"duplicate":2}','{"notFinite":NaN}'):
            with self.assertRaises(RuntimeError):scope._restored_wire_json(raw)
        legacy={'status':'ONLINE_RECHARGE_BASELINE_VERIFIED','ordinary':True}
        self.assertIs(scope._restored_wire_encode(legacy),legacy)
        wrong=copy.deepcopy(receipt);wrong['onlineAfterBitOrigin']['baselineCommit']=scope.BASELINE_COMMIT
        with self.assertRaises(RuntimeError):scope._restored_wire_encode(wrong)


class RestoredColdCacheTests(unittest.TestCase):
    """Offline cache acquisition with synthetic files and command responses only."""
    def test_download_and_retention_tables_match_the_frozen_actual_gap_tuple(self):
        import ast
        source=(ROOT/'scripts/production-release/maintain-image-cache.py').read_text()
        retention=next(ast.literal_eval(node.value) for node in ast.parse(source).body
            if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name)
                and target.id=='HISTORICAL_ONLINE_COLD_DEPENDENCIES' for target in node.targets))
        # Frozen from the reviewed gap report's eight tag/image/source/service
        # tuples; CI does not need an untracked runtime report or any AWS access.
        self.assertEqual(scope.fingerprint(retention),
            'df190b221061b96d107d2ab32f409bee2e0938000015b1e00beb6bcd92585d71')
        self.assertEqual(len(retention),8)
        self.assertEqual(scope._RESTORED_B_COLD_IMAGE_CACHE,
            {tag:(row['imageId'],row['sourceTree']) for tag,row in retention.items()})
        self.assertTrue(all(row['sourceCommit']==tag[:40] and row['service']==tag.rsplit('-1-',1)[1]
            for tag,row in retention.items()))

    @contextmanager
    def fixture(self, present=False, *, real_snapshot=False):
        with tempfile.TemporaryDirectory(prefix='cold-cache-', dir=RUNTIME) as temporary, ExitStack() as stack:
            base = Path(temporary).resolve()
            directory = base / 'releases' / '20261011T132910Z-31d2c6885a45'
            directory.mkdir(parents=True, mode=0o700)
            (base / 'current').symlink_to(directory)
            manifest = directory / 'release-manifest.json'
            manifest.write_bytes(b'{"offlineSyntheticManifest":true}\n')
            manifest.chmod(0o600)
            witness = copy.deepcopy(scope._RESTORED_B_WITNESS)
            before = json.loads(witness['failedPreflight'])
            before['baseline']['baselineRelease'] = str(directory)
            before['baseline']['manifestBytesSha256'] = hashlib.sha256(manifest.read_bytes()).hexdigest()
            witness['failedPreflight'] = json.dumps(before)
            images = copy.deepcopy(scope._RESTORED_B_COLD_IMAGE_CACHE)
            repository = '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'
            local = {tag: image for tag, (image, _) in images.items()} if present else {}
            metadata = {tag: {'Id': image, 'Architecture': 'amd64', 'Config': {'Labels': {
                'org.opencontainers.image.revision': tag[:40], 'id-business-v2.source-tree': tree}}}
                for tag, (image, tree) in images.items()}
            remote = {'failures': [], 'images': [{'repositoryName': 'id-business-v2-release',
                'imageId': {'imageTag': tag}, 'imageManifest': json.dumps({'schemaVersion': 2,
                    'config': {'digest': image}})} for tag, (image, _) in images.items()]}
            events = []
            clock = SimpleNamespace(now=0)
            state = SimpleNamespace(free=7 * 1024**3, remote=remote, hook=None,
                password='offline-synthetic-registry-password', http_status=200,
                body=b'{"status":"Pulling image"}\n{"status":"Pull complete"}\n',
                advertised_length=None, chunked=False, recv_size=8192, socket_hook=None, sockets=[],
                requests=[], io_events=[], command_error=None)

            def run(*command, **kwargs):
                # Any service command, shell, image deletion, volume command or
                # unexpected AWS operation makes this synthetic fixture fail.
                self.assertTrue(command[:3] in (('docker', 'image', 'ls'),
                    ('docker', 'image', 'inspect'), ('aws', 'ecr', 'batch-get-image'),
                    ('aws', 'ecr', 'get-login-password')))
                self.assertEqual(set(kwargs), {'timeout'})
                self.assertGreater(kwargs['timeout'], 0)
                self.assertLessEqual(kwargs['timeout'], 60)
                events.append((command, kwargs))
                if state.hook is not None:
                    state.hook(command)
                if state.command_error is not None:
                    state.command_error(command)
                if command[:3] == ('docker', 'image', 'ls'):
                    self.assertEqual(command[3:5], ('--no-trunc', '--filter'))
                    self.assertEqual(command[6:], ('--format', '{{.ID}}'))
                    tag = command[5].split('reference=' + repository + ':', 1)[1]
                    return local.get(tag, '')
                if command[:3] == ('docker', 'image', 'inspect'):
                    self.assertEqual(len(command), 4)
                    tag = command[3].split(repository + ':', 1)[1]
                    return json.dumps([metadata[tag]])
                if command[:3] == ('aws', 'ecr', 'get-login-password'):
                    self.assertEqual(command, ('aws', 'ecr', 'get-login-password', '--region', 'ap-northeast-1'))
                    return state.password
                self.assertEqual(command[:8], ('aws', 'ecr', 'batch-get-image', '--region',
                    'ap-northeast-1', '--repository-name', 'id-business-v2-release', '--image-ids'))
                self.assertEqual(command[-2:], ('--output', 'json'))
                requested = [value.removeprefix('imageTag=') for value in command[8:-2]]
                self.assertEqual(set(requested), set(images) - set(local))
                return json.dumps(state.remote)

            import socket
            from urllib.parse import parse_qs, urlsplit

            class SocketReader(io.RawIOBase):
                def __init__(self, transport):
                    super().__init__()
                    self.transport = transport

                def readable(self):
                    return True

                def readinto(self, buffer):
                    return self.transport.recv_into(buffer)

            class MemorySocket:
                """Real HTTPConnection/HTTPResponse run over this offline socket."""
                def __init__(self, family, kind):
                    self.created = clock.now
                    self.deadline = min(120, self.created + 60)
                    self.timeout = None
                    self.sent = bytearray()
                    self.response = None
                    self.offset = 0
                    self.closed = False
                    self.readers = []
                    self.tag = None
                    self.test.assertEqual((family, kind), (socket.AF_UNIX, socket.SOCK_STREAM))
                    state.sockets.append(self)

                def settimeout(self, seconds):
                    self.test.assertGreater(seconds, 0)
                    self.test.assertLessEqual(seconds, 60)
                    self.test.assertLessEqual(seconds, self.deadline - clock.now)
                    self.timeout = seconds

                def step(self, operation):
                    state.io_events.append((operation, self.timeout, clock.now))
                    if state.socket_hook is not None:
                        state.socket_hook(self, operation)

                def connect(self, address):
                    self.test.assertEqual(address, '/var/run/docker.sock')
                    self.step('connect')

                def sendall(self, data, flags=0):
                    self.test.assertEqual(flags, 0)
                    self.sent.extend(data)
                    self.step('sendall')
                    if b'\r\n\r\n' not in self.sent:
                        return
                    header, unused_body = bytes(self.sent).split(b'\r\n\r\n', 1)
                    rows = header.decode('ascii').split('\r\n')
                    method, target, version = rows[0].split(' ')
                    self.test.assertEqual((method, version), ('POST', 'HTTP/1.1'))
                    parsed = urlsplit(target)
                    self.test.assertEqual(parsed.path, '/images/create')
                    query = parse_qs(parsed.query, strict_parsing=True)
                    self.test.assertEqual(set(query), {'fromImage', 'tag'})
                    self.test.assertEqual(query['fromImage'], [repository])
                    self.test.assertEqual(len(query['tag']), 1)
                    self.tag = query['tag'][0]
                    self.test.assertIn(self.tag, images)
                    headers = dict(row.split(': ', 1) for row in rows[1:])
                    authentication = json.loads(base64.urlsafe_b64decode(headers['X-Registry-Auth']))
                    self.test.assertEqual(authentication, {'username': 'AWS',
                        'password': state.password.strip(), 'serveraddress': repository.split('/')[0]})
                    self.test.assertNotIn(state.password.strip(), rows[0])
                    state.requests.append({'method': method, 'path': parsed.path, 'tag': self.tag,
                        'authentication': authentication, 'headers': headers})
                    # This is an in-memory Docker API event, never a CLI pull.
                    event = ('docker-socket', 'image-create', repository + ':' + self.tag)
                    events.append((event, {'timeout': self.timeout}))
                    if state.hook is not None:
                        state.hook(event)
                    length = len(state.body) if state.advertised_length is None else state.advertised_length
                    framing = 'Transfer-Encoding: chunked' if state.chunked else 'Content-Length: ' + str(length)
                    self.response = ('HTTP/1.1 ' + str(state.http_status) + ' Offline\r\n'
                        + framing + '\r\n\r\n').encode() + state.body

                def recv_into(self, buffer, nbytes=0, flags=0):
                    self.test.assertEqual(flags, 0)
                    self.test.assertIsNotNone(self.response)
                    self.step('recv_into')
                    count = min(len(buffer), nbytes or len(buffer), state.recv_size,
                        len(self.response) - self.offset)
                    buffer[:count] = self.response[self.offset:self.offset + count]
                    self.offset += count
                    if self.offset == len(self.response) and state.http_status == 200:
                        local[self.tag] = images[self.tag][0]
                    return count

                def makefile(self, mode):
                    self.test.assertEqual(mode, 'rb')
                    reader = io.BufferedReader(SocketReader(self))
                    self.readers.append(reader)
                    return reader

                def close(self):
                    self.closed = True

            MemorySocket.test = self
            stack.enter_context(patch.object(socket, 'socket', MemorySocket))

            d = controller(BASE=base, run=run, compose=MagicMock(side_effect=AssertionError('no service commands')))
            snapshot = None if real_snapshot else stack.enter_context(
                patch.object(scope, 'snapshot', return_value=states()))
            stack.enter_context(patch.object(scope, '_RESTORED_B_WITNESS', witness))
            stack.enter_context(patch.object(scope.shutil, 'disk_usage', side_effect=lambda unused: SimpleNamespace(free=state.free)))
            stack.enter_context(patch.object(scope.time, 'monotonic', side_effect=lambda: clock.now))
            yield SimpleNamespace(d=d, directory=directory, manifest=manifest, images=images, local=local,
                metadata=metadata, events=events, state=state, clock=clock, snapshot=snapshot,
                expected=before['baseline']['baselineCommit'], repository=repository)

    @staticmethod
    def pulls(value):
        return [command for command, _ in value.events if command[:2] == ('docker-socket', 'image-create')]

    def test_all_eight_missing_images_are_digest_bound_before_any_pull(self):
        with self.fixture() as value:
            scope._restored_workspace_cold_cache(value.d, value.directory, value.expected)
            self.assertEqual(len(value.images), 8)
            self.assertEqual(self.pulls(value), [('docker-socket', 'image-create', value.repository + ':' + tag)
                for tag in value.images])
            aws = [index for index, (command, _) in enumerate(value.events)
                if command[:3] == ('aws', 'ecr', 'batch-get-image')]
            first_pull = next(index for index, (command, _) in enumerate(value.events)
                if command[:2] == ('docker-socket', 'image-create'))
            self.assertEqual(len(aws), 1)
            self.assertLess(aws[0], first_pull)
            self.assertEqual(sum(command[:3] == ('docker', 'image', 'inspect')
                for command, _ in value.events), 8)
            self.assertEqual(value.d._restoredWorkspaceColdCacheReady, scope.fingerprint(value.images))
            self.assertEqual(value.snapshot.call_count, 2)
            value.d.compose.assert_not_called()

    def test_existing_exact_images_are_inspected_and_never_pulled(self):
        with self.fixture(present=True) as value:
            scope._restored_workspace_cold_cache(value.d, value.directory, value.expected)
            self.assertFalse(self.pulls(value))
            self.assertTrue(all(command[:2] == ('docker', 'image') for command, _ in value.events))
            self.assertEqual(len(value.events), 16)

    def test_mixed_local_cache_requests_and_pulls_only_missing_exact_tags(self):
        with self.fixture() as value:
            present = list(value.images)[::2]
            value.local.update({tag: value.images[tag][0] for tag in present})
            value.state.remote['images'] = [row for row in value.state.remote['images']
                if row['imageId']['imageTag'] not in present]
            scope._restored_workspace_cold_cache(value.d, value.directory, value.expected)
            self.assertEqual(self.pulls(value), [('docker-socket', 'image-create', value.repository + ':' + tag)
                for tag in value.images if tag not in present])
            self.assertEqual(len(value.local), 8)

    def test_every_remote_digest_failure_blocks_all_pulls(self):
        for index in range(8):
            with self.subTest(image=index), self.fixture() as value:
                row = value.state.remote['images'][index]
                row['imageManifest'] = json.dumps({'schemaVersion': 2, 'config': {'digest': 'sha256:' + '0' * 64}})
                with self.assertRaisesRegex(RuntimeError, 'HISTORICAL_IMAGE_CACHE_CHANGED'):
                    scope._restored_workspace_cold_cache(value.d, value.directory, value.expected)
                self.assertFalse(self.pulls(value))
                self.assertFalse(hasattr(value.d, '_restoredWorkspaceColdCacheReady'))

    def test_missing_duplicate_foreign_repository_and_ecr_failure_block_all_pulls(self):
        for variation in ('missing', 'duplicate', 'foreign', 'failure', 'schema', 'extra'):
            with self.subTest(variation=variation), self.fixture() as value:
                remote = value.state.remote
                if variation == 'missing': remote['images'].pop()
                if variation == 'duplicate': remote['images'][-1] = copy.deepcopy(remote['images'][0])
                if variation == 'foreign': remote['images'][-1]['repositoryName'] = 'other-project'
                if variation == 'failure': remote['failures'] = [{'failureCode': 'ImageNotFound'}]
                if variation == 'schema':
                    remote['images'][-1]['imageManifest'] = json.dumps({'schemaVersion': 1})
                if variation == 'extra': remote['images'].append(copy.deepcopy(remote['images'][0]))
                with self.assertRaisesRegex(RuntimeError, 'HISTORICAL_IMAGE_CACHE_CHANGED'):
                    scope._restored_workspace_cold_cache(value.d, value.directory, value.expected)
                self.assertFalse(self.pulls(value))

    def test_wrong_local_tag_or_configuration_is_never_overwritten(self):
        for variation in ('id', 'architecture', 'revision', 'tree'):
            with self.subTest(variation=variation), self.fixture(present=True) as value:
                tag = next(iter(value.images))
                if variation == 'id': value.local[tag] = 'sha256:' + '0' * 64
                if variation == 'architecture': value.metadata[tag]['Architecture'] = 'arm64'
                if variation == 'revision': value.metadata[tag]['Config']['Labels']['org.opencontainers.image.revision'] = '0' * 40
                if variation == 'tree': value.metadata[tag]['Config']['Labels']['id-business-v2.source-tree'] = '0' * 40
                with self.assertRaisesRegex(RuntimeError, 'HISTORICAL_IMAGE_CACHE_CHANGED'):
                    scope._restored_workspace_cold_cache(value.d, value.directory, value.expected)
                self.assertFalse(self.pulls(value))
                self.assertFalse(any(command[0] == 'aws' for command, _ in value.events))

    def test_baseline_manifest_or_current_pointer_drift_blocks_image_mutation(self):
        for variation in ('manifest', 'pointer', 'before-pull'):
            with self.subTest(variation=variation), self.fixture() as value:
                if variation == 'manifest': value.manifest.write_bytes(b'{"offlineChanged":true}')
                if variation == 'pointer':
                    (value.d.BASE / 'current').unlink()
                    (value.d.BASE / 'current').symlink_to(value.d.BASE)
                if variation == 'before-pull':
                    def change_after_ecr(command):
                        if command[0] == 'aws': value.manifest.write_bytes(b'{"offlineChanged":true}')
                    value.state.hook = change_after_ecr
                with self.assertRaisesRegex(RuntimeError, 'HISTORICAL_IMAGE_CACHE_CHANGED'):
                    scope._restored_workspace_cold_cache(value.d, value.directory, value.expected)
                self.assertFalse(self.pulls(value))
                if variation != 'before-pull': self.assertFalse(value.events)

    def test_capacity_at_or_below_threshold_blocks_pull_and_post_pull_drop_blocks_readiness(self):
        for variation in ('at', 'below', 'post-pull'):
            with self.subTest(variation=variation), self.fixture() as value:
                if variation == 'at': value.state.free = 6 * 1024**3
                if variation == 'below': value.state.free = 6 * 1024**3 - 1
                if variation == 'post-pull':
                    def consume_space(command):
                        if command[:2] == ('docker-socket', 'image-create'): value.state.free = 6 * 1024**3
                    value.state.hook = consume_space
                with self.assertRaisesRegex(RuntimeError, 'HISTORICAL_IMAGE_CACHE_DISK_TOO_LOW'):
                    scope._restored_workspace_cold_cache(value.d, value.directory, value.expected)
                self.assertEqual(len(self.pulls(value)), 1 if variation == 'post-pull' else 0)
                self.assertFalse(hasattr(value.d, '_restoredWorkspaceColdCacheReady'))

    def test_shared_120_second_budget_exhaustion_stops_before_pull(self):
        with self.fixture() as value:
            def expire_after_ecr(command):
                if command[0] == 'aws': value.clock.now = 120
            value.state.hook = expire_after_ecr
            with self.assertRaisesRegex(RuntimeError, 'HISTORICAL_IMAGE_CACHE_TIMEOUT'):
                scope._restored_workspace_cold_cache(value.d, value.directory, value.expected)
            self.assertFalse(self.pulls(value))
            self.assertFalse(hasattr(value.d, '_restoredWorkspaceColdCacheReady'))

    def test_service_snapshot_change_prevents_cache_readiness(self):
        with self.fixture(present=True) as value:
            before, after = states(), states()
            after['api']['containerId'] = '0' * 64
            value.snapshot.side_effect = [before, after]
            with self.assertRaisesRegex(RuntimeError, 'HISTORICAL_IMAGE_CACHE_CHANGED'):
                scope._restored_workspace_cold_cache(value.d, value.directory, value.expected)
            self.assertFalse(hasattr(value.d, '_restoredWorkspaceColdCacheReady'))
            self.assertFalse(self.pulls(value))

    def test_successful_session_reuses_cache_but_rechecks_original_baseline(self):
        with self.fixture() as value:
            scope._restored_workspace_cold_cache(value.d, value.directory, value.expected)
            count = len(value.events)
            scope._restored_workspace_cold_cache(value.d, value.directory, value.expected)
            self.assertEqual(len(value.events), count)
            self.assertEqual(value.snapshot.call_count, 2)
            value.manifest.write_bytes(b'{"offlineChanged":true}')
            with self.assertRaisesRegex(RuntimeError, 'HISTORICAL_IMAGE_CACHE_CHANGED'):
                scope._restored_workspace_cold_cache(value.d, value.directory, value.expected)
            self.assertEqual(len(value.events), count)


class RestoredColdSnapshotDeadlineTests(unittest.TestCase):
    """Original remote functions and API snapshot, with only their I/O stubbed."""
    @contextmanager
    def fixture(self, expire=None):
        cache = RestoredColdCacheTests('test_existing_exact_images_are_inspected_and_never_pulled')
        with cache.fixture(present=True, real_snapshot=True) as value:
            remote = load('cold_snapshot_deadline_remote_tests', 'remote-deploy.py')
            (value.directory / 'docker-compose.aws-mysql.yml').write_text(
                'services:\n  auto-registration:\n    image: synthetic-only\n')
            value.d.ALL_SERVICES = remote.ALL_SERVICES
            value.d.production_services = remote.production_services
            value.d.service_state = remote.service_state
            metadata, expected = {}, {}
            for service in remote.ALL_SERVICES:
                container = hashlib.sha256(('offline-container-' + service).encode()).hexdigest()
                started = '2026-10-12T00:00:00.000000000Z'
                row = {'Id': container,
                    'Image': 'sha256:' + hashlib.sha256(('offline-image-' + service).encode()).hexdigest(),
                    'Config': {'Image': 'synthetic-only:' + service,
                        'Env': ['SYNTHETIC_ONLY=two', 'OFFLINE_ONLY=one']},
                    'State': {'Status': 'running', 'StartedAt': started,
                        **({} if service == 'caddy' else {'Health': {'Status': 'healthy'}})},
                    'HostConfig': {'NetworkMode': 'synthetic-only'},
                    'Mounts': [{'Destination': '/z', 'Source': 'synthetic-z', 'Type': 'volume'},
                               {'Destination': '/a', 'Source': 'synthetic-a', 'Type': 'volume'}]}
                metadata[container] = row
                expected[service] = {'image': row['Image'], 'reference': row['Config']['Image'],
                    'status': 'running', 'health': None if service == 'caddy' else 'healthy',
                    'containerId': container, 'startedAtSha256': hashlib.sha256(started.encode()).hexdigest(),
                    'environmentSha256': scope.fingerprint(sorted(row['Config']['Env'])),
                    'configurationSha256': scope.fingerprint({'Config': row['Config'],
                        'HostConfig': row['HostConfig'],
                        'Mounts': sorted(row['Mounts'], key=lambda mount: mount['Destination'])})}
            image_run = value.d.run
            io_events, snapshots, function_calls = [], [], []
            counts = SimpleNamespace(compose=0, inspect=0)
            original_globals = remote.service_state.__globals__
            original_bindings = (original_globals['run'], original_globals['compose'])

            def complete(kind, command, kwargs, result):
                self.assertEqual(set(kwargs), {'timeout'})
                self.assertGreater(kwargs['timeout'], 0)
                self.assertLessEqual(kwargs['timeout'], 60)
                self.assertLessEqual(kwargs['timeout'], 120 - value.clock.now)
                io_events.append((kind, command, dict(kwargs), value.clock.now))
                # A fake monotonic clock makes the complete 120-second budget
                # observable without waiting or executing Docker/AWS commands.
                value.clock.now += 2
                if (expire == 'first-snapshot' and counts.compose == 1
                        or expire == 'last-snapshot' and counts.inspect == 4 * len(remote.ALL_SERVICES)):
                    value.clock.now = 120
                return result

            def run(*command, **kwargs):
                if command[:2] == ('docker', 'inspect'):
                    self.assertEqual(len(command), 3)
                    self.assertIn(command[2], metadata)
                    counts.inspect += 1
                    result = json.dumps([metadata[command[2]]])
                    return complete('snapshot-inspect', command, kwargs, result)
                result = image_run(*command, **kwargs)
                return complete('image-cache', command, kwargs, result)

            def compose(directory, *command, **kwargs):
                self.assertEqual(directory, value.directory)
                self.assertEqual(command[:2], ('ps', '-q'))
                self.assertEqual(len(command), 3)
                self.assertIn(command[2], expected)
                counts.compose += 1
                return complete('snapshot-compose', command, kwargs, expected[command[2]]['containerId'])

            value.d.run, value.d.compose = run, compose
            prior_profile = sys.getprofile()

            def observe_original_functions(frame, event, result):
                # Observe real return values without replacing snapshot or any
                # service-state/production-services implementation.
                if event == 'return' and frame.f_code is shared.snapshot.__code__ and result is not None:
                    snapshots.append(copy.deepcopy(result))
                if event == 'call' and frame.f_code in (remote.service_state.__code__,
                                                        remote.production_services.__code__):
                    function_calls.append((frame.f_code, frame.f_globals))

            # A regression back to the original unbounded globals must fail
            # locally instead of invoking real Docker through subprocess.run.
            with patch.object(remote.subprocess, 'run', side_effect=AssertionError('native commands forbidden')) as native:
                sys.setprofile(observe_original_functions)
                try:
                    yield SimpleNamespace(cache=value, remote=remote, expected=expected,
                        io_events=io_events, snapshots=snapshots, function_calls=function_calls,
                        counts=counts, metadata=metadata)
                finally:
                    sys.setprofile(prior_profile)
                    native.assert_not_called()
                    self.assertIs(remote.service_state.__globals__, original_globals)
                    self.assertIs(remote.production_services.__globals__, original_globals)
                    self.assertIs(original_globals['run'], original_bindings[0])
                    self.assertIs(original_globals['compose'], original_bindings[1])
                    for unused, namespace in function_calls:
                        self.assertIsNot(namespace, original_globals)
                        self.assertIsNot(namespace['run'], original_bindings[0])
                        self.assertIsNot(namespace['compose'], original_bindings[1])
                        self.assertIs(namespace['run'].__self__, namespace['compose'].__self__)

    def test_both_original_snapshots_share_bounded_io_and_preserve_all_eight_identity_fields(self):
        with self.fixture() as value:
            cache = value.cache
            scope._restored_workspace_cold_cache(cache.d, cache.directory, cache.expected)
            self.assertEqual(value.snapshots, [value.expected, value.expected])
            self.assertEqual(len(value.expected), 7)
            self.assertTrue(all(len(row) == 8 for row in value.snapshots[0].values()))
            self.assertEqual(value.counts.compose, 14)
            self.assertEqual(value.counts.inspect, 28)
            self.assertEqual(len(value.io_events), 58)
            self.assertEqual(cache.clock.now, 116)
            self.assertTrue(any(kwargs['timeout'] < 60 for _, _, kwargs, _ in value.io_events))
            self.assertEqual(sum(code is value.remote.service_state.__code__
                for code, _ in value.function_calls), 14)
            self.assertEqual(sum(code is value.remote.production_services.__code__
                for code, _ in value.function_calls), 2)
            self.assertEqual(cache.d._restoredWorkspaceColdCacheReady, scope.fingerprint(cache.images))
            self.assertFalse(RestoredColdCacheTests.pulls(cache))

    def test_original_first_snapshot_exhausting_budget_prevents_image_operations_and_readiness(self):
        with self.fixture(expire='first-snapshot') as value:
            cache = value.cache
            with self.assertRaisesRegex(RuntimeError, 'HISTORICAL_IMAGE_CACHE_TIMEOUT'):
                scope._restored_workspace_cold_cache(cache.d, cache.directory, cache.expected)
            self.assertEqual(value.counts.compose, 1)
            self.assertEqual(value.counts.inspect, 0)
            self.assertEqual(len(value.io_events), 1)
            self.assertFalse(cache.events)
            self.assertFalse(value.snapshots)
            self.assertEqual(cache.clock.now, 120)
            self.assertFalse(hasattr(cache.d, '_restoredWorkspaceColdCacheReady'))

    def test_original_last_snapshot_finishing_at_budget_boundary_cannot_mark_cache_ready(self):
        with self.fixture(expire='last-snapshot') as value:
            cache = value.cache
            with self.assertRaisesRegex(RuntimeError, 'HISTORICAL_IMAGE_CACHE_TIMEOUT'):
                scope._restored_workspace_cold_cache(cache.d, cache.directory, cache.expected)
            self.assertEqual(value.snapshots, [value.expected])
            self.assertEqual(value.counts.compose, 14)
            self.assertEqual(value.counts.inspect, 28)
            self.assertEqual(len(value.io_events), 58)
            self.assertEqual(cache.clock.now, 120)
            self.assertEqual(value.io_events[-1][0], 'snapshot-inspect')
            self.assertFalse(RestoredColdCacheTests.pulls(cache))
            self.assertFalse(hasattr(cache.d, '_restoredWorkspaceColdCacheReady'))


class RestoredColdRegistryTransportTests(unittest.TestCase):
    @contextmanager
    def fixture(self, **kwargs):
        cache = RestoredColdCacheTests('test_existing_exact_images_are_inspected_and_never_pulled')
        with cache.fixture(**kwargs) as value:
            yield value

    @staticmethod
    def auth_events(value):
        return [command for command, unused in value.events
            if command[:3] == ('aws', 'ecr', 'get-login-password')]

    def assert_closed(self, value):
        self.assertTrue(all(transport.closed for transport in value.state.sockets))
        self.assertTrue(all(reader.closed for transport in value.state.sockets for reader in transport.readers))

    def assert_sanitized_failure(self, value, expected):
        import traceback
        from contextlib import redirect_stderr
        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors), self.assertRaises(RuntimeError) as raised:
            scope._restored_workspace_cold_cache(value.d, value.directory, value.expected)
        self.assertEqual(raised.exception.args, ('ONLINE_RECHARGE_HISTORICAL_IMAGE_CACHE_' + expected,))
        rendered = ''.join(traceback.format_exception(type(raised.exception), raised.exception,
            raised.exception.__traceback__))
        for text in (output.getvalue(), errors.getvalue(), rendered):
            self.assertNotIn(value.state.password, text)
            self.assertNotIn('offline-private-error-detail', text)
        for path in value.d.BASE.rglob('*'):
            if path.is_file():
                self.assertNotIn(value.state.password.encode(), path.read_bytes())
        self.assertFalse(hasattr(value.d, '_restoredWorkspaceColdCacheReady'))
        self.assert_closed(value)

    def test_single_memory_only_auth_follows_all_digest_checks_and_actual_http_streams_close(self):
        with self.fixture() as value:
            scope._restored_workspace_cold_cache(value.d, value.directory, value.expected)
            self.assertEqual(len(self.auth_events(value)), 1)
            batch = next(index for index, (command, unused) in enumerate(value.events)
                if command[:3] == ('aws', 'ecr', 'batch-get-image'))
            auth = next(index for index, (command, unused) in enumerate(value.events)
                if command[:3] == ('aws', 'ecr', 'get-login-password'))
            first_pull = next(index for index, (command, unused) in enumerate(value.events)
                if command[:2] == ('docker-socket', 'image-create'))
            self.assertLess(batch, auth)
            self.assertLess(auth, first_pull)
            self.assertEqual([request['tag'] for request in value.state.requests], list(value.images))
            self.assertEqual(len(value.state.sockets), 8)
            self.assertTrue(all(transport.offset == len(transport.response) for transport in value.state.sockets))
            self.assertTrue(all(operation in ('connect', 'sendall', 'recv_into')
                and 0 < timeout <= 60 for operation, timeout, unused in value.state.io_events))
            self.assert_closed(value)
            self.assertFalse((value.d.BASE / '.docker').exists())
            self.assertFalse(any(value.state.password in str(command) for command, unused in value.events))
            for path in value.d.BASE.rglob('*'):
                if path.is_file(): self.assertNotIn(value.state.password.encode(), path.read_bytes())

    def test_all_present_images_never_request_auth_or_open_a_socket(self):
        with self.fixture(present=True) as value:
            scope._restored_workspace_cold_cache(value.d, value.directory, value.expected)
            self.assertFalse(self.auth_events(value))
            self.assertFalse(value.state.sockets)

    def test_last_remote_digest_failure_rejects_before_auth_and_socket_creation(self):
        with self.fixture() as value:
            value.state.remote['images'][-1]['imageManifest'] = json.dumps(
                {'schemaVersion': 2, 'config': {'digest': 'sha256:' + '0' * 64}})
            self.assert_sanitized_failure(value, 'CHANGED')
            self.assertFalse(self.auth_events(value))
            self.assertFalse(value.state.sockets)

    def test_empty_or_multiline_auth_rejects_without_transport(self):
        for password in ('', '  ', 'offline\nsynthetic', 'offline\rsynthetic'):
            with self.subTest(password_kind=repr(password)), self.fixture() as value:
                value.state.password = password
                with self.assertRaisesRegex(RuntimeError, 'HISTORICAL_IMAGE_CACHE_ECR_AUTH_FAILED'):
                    scope._restored_workspace_cold_cache(value.d, value.directory, value.expected)
                self.assertFalse(value.state.sockets)
                self.assertEqual(len(self.auth_events(value)), 1)
                self.assertFalse(hasattr(value.d, '_restoredWorkspaceColdCacheReady'))

    def test_http_error_statuses_are_sanitized_and_always_close_transport(self):
        for status in (401, 403, 500):
            with self.subTest(status=status), self.fixture() as value:
                value.state.http_status = status
                value.state.body = (value.state.password + ' offline-private-error-detail').encode()
                self.assert_sanitized_failure(value, 'IMAGE_PULL_FAILED')
                self.assertEqual(len(value.state.sockets), 1)
                self.assertFalse(any(command[:3] == ('docker', 'image', 'inspect')
                    for command, unused in value.events))

    def test_empty_invalid_oversized_and_late_error_streams_reject(self):
        progress = b'{"status":"Pulling"}\n'
        bodies = (b'', b'[]\n', b'{"status":', b'\xff\n', b'{"status":"a","status":"b"}\n',
            b'{"status":"' + b'x' * 65536 + b'"}\n',
            progress + b'{"error":"offline-private-error-detail"}\n',
            progress + b'{"errorDetail":{"message":"offline-private-error-detail"}}\n')
        for index, body in enumerate(bodies):
            with self.subTest(stream=index), self.fixture() as value:
                value.state.body = body
                self.assert_sanitized_failure(value, 'IMAGE_PULL_FAILED')
                self.assertEqual(len(value.state.sockets), 1)
                self.assertFalse(any(command[:3] == ('docker', 'image', 'inspect')
                    for command, unused in value.events))

    def test_http_body_ending_before_advertised_length_rejects_even_when_json_rows_are_valid(self):
        with self.fixture() as value:
            value.state.advertised_length = len(value.state.body) + 100
            self.assert_sanitized_failure(value, 'IMAGE_PULL_FAILED')
            self.assertEqual(len(value.state.sockets), 1)

    def test_real_chunked_http_stream_requires_complete_chunks_and_terminal_zero_chunk(self):
        progress = b'{"status":"Pull complete"}\n'
        chunk = format(len(progress), 'x').encode() + b'\r\n' + progress + b'\r\n'
        with self.fixture() as value:
            value.state.chunked = True
            value.state.body = chunk + b'0\r\n\r\n'
            scope._restored_workspace_cold_cache(value.d, value.directory, value.expected)
            self.assertEqual(len(value.state.requests), 8)
            self.assert_closed(value)
        for body in (chunk, chunk[:-2], b'not-hex\r\n' + progress, b'100\r\n' + progress):
            with self.subTest(chunked_body=body[:10]), self.fixture() as value:
                value.state.chunked = True
                value.state.body = body
                self.assert_sanitized_failure(value, 'IMAGE_PULL_FAILED')
                self.assertEqual(len(value.state.sockets), 1)

    def test_continuous_progress_cannot_extend_single_pull_or_shared_deadline(self):
        for variation in ('pull', 'shared'):
            with self.subTest(budget=variation), self.fixture() as value:
                value.state.body = b'{"status":"Pulling image"}\n' * 200
                value.state.recv_size = 64
                if variation == 'shared':
                    def consume_before_pull(command):
                        if command[:3] == ('aws', 'ecr', 'get-login-password'): value.clock.now = 90
                    value.state.hook = consume_before_pull
                def progress(transport, operation):
                    if operation == 'recv_into': value.clock.now += 10
                value.state.socket_hook = progress
                self.assert_sanitized_failure(value, 'TIMEOUT')
                self.assertEqual(value.clock.now, 60 if variation == 'pull' else 120)
                self.assertEqual(len(value.state.sockets), 1)
                reads = [(timeout, instant) for operation, timeout, instant in value.state.io_events
                    if operation == 'recv_into']
                self.assertGreater(len(reads), 1)
                self.assertTrue(all(timeout <= (60 if variation == 'pull' else 30) for timeout, unused in reads))
                self.assertLess(reads[-1][0], reads[0][0])

    def test_each_socket_operation_checks_deadline_after_return_and_sanitizes_io_errors(self):
        for operation in ('connect', 'sendall', 'recv_into'):
            for failure in ('deadline', 'error', 'socket-timeout'):
                with self.subTest(operation=operation, failure=failure), self.fixture() as value:
                    def fail(transport, current):
                        if current == operation:
                            if failure == 'deadline': value.clock.now = 60
                            elif failure == 'socket-timeout':
                                raise TimeoutError(value.state.password + ' offline-private-error-detail')
                            else: raise OSError(value.state.password + ' offline-private-error-detail')
                    value.state.socket_hook = fail
                    self.assert_sanitized_failure(value,
                        'IMAGE_PULL_FAILED' if failure == 'error' else 'TIMEOUT')
                    self.assertEqual(len(value.state.sockets), 1)

    def test_command_failures_have_phase_codes_and_only_timeout_expired_maps_to_timeout(self):
        commands = (('aws', 'ecr', 'batch-get-image'), ('aws', 'ecr', 'get-login-password'),
                    ('docker', 'image', 'ls'), ('docker', 'image', 'inspect'))
        phases = ('ECR_READ_FAILED', 'ECR_AUTH_FAILED', 'IMAGE_INSPECT_FAILED', 'IMAGE_INSPECT_FAILED')
        for prefix, phase in zip(commands, phases):
            for timeout in (False, True):
                with self.subTest(command=prefix, timeout=timeout), self.fixture(
                        present=prefix == ('docker', 'image', 'inspect')) as value:
                    def fail(command):
                        if command[:3] == prefix:
                            if timeout: raise subprocess.TimeoutExpired(command, 60,
                                output=value.state.password, stderr='offline-private-error-detail')
                            raise RuntimeError(value.state.password + ' offline-private-error-detail')
                    value.state.command_error = fail
                    self.assert_sanitized_failure(value, 'TIMEOUT' if timeout else phase)

    def test_real_snapshot_command_and_identity_failures_are_sanitized(self):
        helper = RestoredColdSnapshotDeadlineTests('test_both_original_snapshots_share_bounded_io_and_preserve_all_eight_identity_fields')
        for variation in ('compose', 'inspect', 'unhealthy', 'timeout'):
            with self.subTest(snapshot=variation), helper.fixture() as real:
                value = real.cache
                if variation == 'unhealthy':
                    next(iter(real.metadata.values()))['State']['Health']['Status'] = 'unhealthy'
                elif variation in ('compose', 'timeout'):
                    def fail_compose(*command, **kwargs):
                        if variation == 'timeout': raise subprocess.TimeoutExpired(command, 60,
                            output=value.state.password, stderr='offline-private-error-detail')
                        raise RuntimeError(value.state.password + ' offline-private-error-detail')
                    value.d.compose = fail_compose
                else:
                    previous = value.d.run
                    def fail_inspect(*command, **kwargs):
                        if command[:2] == ('docker', 'inspect'):
                            raise RuntimeError(value.state.password + ' offline-private-error-detail')
                        return previous(*command, **kwargs)
                    value.d.run = fail_inspect
                self.assert_sanitized_failure(value, 'TIMEOUT' if variation == 'timeout' else 'SERVICE_SNAPSHOT_FAILED')
                self.assertFalse(value.state.sockets)


class RestoredColdOriginTests(unittest.TestCase):
    """Real API loader integration; no native files, commands or credentials."""
    def test_real_api_cold_loader_preserves_context_and_reports_location_without_secret_value(self):
        reader = scope._load_legacy()
        api_path = Path(scope.__file__).with_name('api-admin-scope.py')
        self.assertEqual(hashlib.sha256(api_path.read_bytes()).hexdigest(),
            '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925')
        namespace = reader.online_after_bit_cold.__globals__
        original = namespace['pending_online_equivalence']
        secret_fixture = 'offline-exception-value-must-never-be-emitted'
        def reject(condition, unused):
            if not condition: raise RuntimeError(secret_fixture)
        with tempfile.TemporaryDirectory(prefix='cold-origin-', dir=RUNTIME) as temporary:
            base = Path(temporary).resolve()
            d = SimpleNamespace(BASE=base, require=reject,
                run=MagicMock(side_effect=AssertionError('no native commands')))
            bad = base / 'wrong-parent'
            # Wrap the original loader rather than substituting its namespace.
            with patch.dict(namespace, pending_online_equivalence=MagicMock(wraps=original)):
                with self.assertRaises(RuntimeError) as raised:
                    scope._restored_workspace_cold_origin(d, reader.online_after_bit_cold, bad, 'a' * 40)
                namespace['pending_online_equivalence'].assert_called_once_with()
            message = str(raised.exception)
            self.assertRegex(message,
                r'^ONLINE_RECHARGE_AFTER_BIT_ORIGIN_CHANGED_AT_ONLINE_AFTER_BIT_COLD_L[0-9]+_RUNTIMEERROR$')
            self.assertLess(len(message), 128)
            self.assertNotIn(secret_fixture, message)
            self.assertNotIn(str(base), message)
            self.assertTrue(raised.exception.__suppress_context__)
            cause = raised.exception
            while cause.__context__ is not None: cause = cause.__context__
            self.assertEqual(cause.args, (secret_fixture,))
            d.run.assert_not_called()

    def test_success_returns_original_result_without_rewriting_it(self):
        original = {'offline': {'unchanged': True}}
        cold = MagicMock(return_value=original)
        d = controller()
        directory = ROOT / '.runtime' / 'synthetic-not-read'
        self.assertIs(scope._restored_workspace_cold_origin(d, cold, directory, 'a' * 40), original)
        cold.assert_called_once_with(d, directory, expected_commit='a' * 40)

    def test_unrelated_error_and_unrecognized_source_location_are_not_reclassified(self):
        for error in (RuntimeError('OTHER_OFFLINE_CODE'), RuntimeError('ONLINE_RECHARGE_AFTER_BIT_ORIGIN_CHANGED')):
            cold = MagicMock(side_effect=error)
            with self.subTest(code=error.args[0]), self.assertRaises(RuntimeError) as raised:
                scope._restored_workspace_cold_origin(controller(), cold, ROOT, 'a' * 40)
            self.assertIs(raised.exception, error)


class RestoredQualificationFailureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.driver = scope._declaration_runtime_driver()
        def leaf(name):
            path = ROOT / 'scripts/production-release/formal-runtime-package' / (name + '.py')
            spec = importlib.util.spec_from_file_location('offline_qualified_failure_' + name, path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
        cls.qualified, cls.package = leaf('qualified'), leaf('package_io')

    @staticmethod
    def fail(error):
        raise error

    def assert_public_failure(self, operation, expected, **kwargs):
        import traceback
        from contextlib import redirect_stderr
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err), self.assertRaises(scope.DeclarationDriverError) as raised:
            scope._restored_workspace_qualification_call(operation, **kwargs)
        self.assertEqual(raised.exception.args, ('ONLINE_RECHARGE_DECLARATION_' + expected[0] + '_' + expected[1],))
        self.assertEqual(scope.declaration_failure_diagnostic(raised.exception), {'stage': expected[0], 'code': expected[1]})
        self.assertLessEqual(len(raised.exception.args[0]), 128)
        self.assertTrue(raised.exception.__suppress_context__)
        rendered = ''.join(traceback.format_exception(type(raised.exception), raised.exception,
            raised.exception.__traceback__))
        self.assertNotIn('OFFLINE_DIAGNOSTIC_SECRET_MUST_NOT_BE_PUBLISHED', rendered)
        self.assertEqual((out.getvalue(), err.getvalue()), ('', ''))
        return raised.exception

    def test_actual_driver_getter_preserves_archive_and_profile_reasons(self):
        import urllib.error
        http = urllib.error.HTTPError('https://offline.invalid', 403,
            'OFFLINE_DIAGNOSTIC_SECRET_MUST_NOT_BE_PUBLISHED', {}, None)
        cases = ((self.driver._rejected(http, 'ARCHIVE_BIND'), ('ARCHIVE_BIND', 'HTTP_ERROR')),
            (self.driver._rejected(self.qualified.Rejected('SOURCE_NOT_MEASURED'), 'SOURCE_PROFILE',
                [(self.qualified.Rejected, self.qualified.CODES)]), ('SOURCE_PROFILE', 'SOURCE_NOT_MEASURED')))
        for error, expected in cases:
            with self.subTest(stage=expected[0]):
                self.assert_public_failure(lambda:self.fail(error), expected, driver=self.driver)

    def test_capabilities_uses_the_same_actual_driver_exception_identity(self):
        producer = {'commit': 'a' * 40, 'sourceTree': 'b' * 40,
                    'workflowRunId': '123', 'workflowRunAttempt': '1'}
        error = self.driver._rejected(self.qualified.Rejected('SOURCE_NOT_MEASURED'), 'SOURCE_PROFILE',
            [(self.qualified.Rejected, self.qualified.CODES)])
        with patch.object(scope, '_pending_workspace_producer', return_value=producer), \
                patch.object(scope, '_declaration_runtime_driver', return_value=self.driver) as loader, \
                patch.object(self.driver, '_capabilities', side_effect=error) as acquire:
            with self.assertRaises(scope.DeclarationDriverError) as raised:
                scope._restored_qualified_capabilities(controller())
            self.assertEqual(raised.exception.args, ('ONLINE_RECHARGE_DECLARATION_SOURCE_PROFILE_SOURCE_NOT_MEASURED',))
            loader.assert_called_once_with()
            acquire.assert_called_once_with(producer)

    def test_actual_qualified_getter_is_resolved_after_first_acquisition_and_context_closes(self):
        owner, events = controller(), []
        error = self.qualified.Rejected('QUALIFIER_UNAVAILABLE')
        error._qualified_failure = ('RUNTIME_VFS', 'SOCKET_BINDING_UNAVAILABLE')
        error.unknown_private_field = 'OFFLINE_DIAGNOSTIC_SECRET_MUST_NOT_BE_PUBLISHED'
        @contextmanager
        def session():
            events.append('enter')
            try: yield object()
            finally: events.append('closed')
        def operation():
            owner._restoredWorkspaceCapabilities = {'caps': SimpleNamespace(qualified=self.qualified)}
            with session(): self.fail(error)
        self.assert_public_failure(operation, ('RUNTIME_VFS', 'SOCKET_BINDING_UNAVAILABLE'), owner=owner)
        self.assertEqual(events, ['enter', 'closed'])

    def test_real_package_assert_stable_rejection_uses_its_own_class_and_literal(self):
        package = object.__new__(self.package.Package)
        package.directory = RUNTIME / 'synthetic-no-package-io'
        caps = SimpleNamespace(package=package, qualified=self.qualified)
        with patch.object(self.package, 'read_owned', side_effect=self.package.Rejected('PACKAGE_FILE_CHANGED')):
            self.assert_public_failure(package.assert_stable, ('PACKAGE_BIND', 'PACKAGE_FILE_CHANGED'), caps=caps)

    def test_real_unannotated_profile_error_keeps_only_fixed_profile_literal(self):
        caps = SimpleNamespace(qualified=self.qualified)
        self.assert_public_failure(self.qualified._reviewed_profile,
            ('SOURCE_PROFILE', 'SOURCE_NOT_MEASURED'), caps=caps, stage='SOURCE_PROFILE')

    def test_success_returns_same_object_and_preserves_single_context_close(self):
        marker, events = object(), []
        @contextmanager
        def session():
            events.append('enter')
            try: yield marker
            finally: events.append('closed')
        def operation():
            with session() as value: return value
        self.assertIs(scope._restored_workspace_qualification_call(operation), marker)
        self.assertEqual(events, ['enter', 'closed'])

    def test_spoofed_class_and_attrs_are_never_treated_as_actual_qualified_exceptions(self):
        class Rejected(RuntimeError):pass
        for error in (Rejected('QUALIFIER_UNAVAILABLE'), RuntimeError('offline-unknown-private-value')):
            error._qualified_failure = ('RUNTIME_VFS', 'SOCKET_BINDING_UNAVAILABLE')
            error._declaration_failure = ('ARCHIVE_BIND', 'HTTP_ERROR')
            with self.subTest(error_class=type(error).__name__), self.assertRaises(type(error)) as raised:
                scope._restored_workspace_qualification_call(lambda:self.fail(error),
                    driver=self.driver, caps=SimpleNamespace(qualified=self.qualified))
            self.assertIs(raised.exception, error)

    def test_unknown_annotation_shapes_and_codes_preserve_original_failure(self):
        for detail in (None, {'stage':'RUNTIME_VFS','code':'SOCKET_BINDING_UNAVAILABLE'},
                ('RUNTIME_VFS', 'OFFLINE_DIAGNOSTIC_SECRET_MUST_NOT_BE_PUBLISHED'),
                ('UNKNOWN_PRIVATE_STAGE', 'UNKNOWN'), ('RUNTIME_VFS', 'UNKNOWN', 'extra')):
            error = self.qualified.Rejected('QUALIFIER_UNAVAILABLE')
            error._qualified_failure = detail
            with self.subTest(annotation_type=type(detail).__name__), self.assertRaises(self.qualified.Rejected) as raised:
                scope._restored_workspace_qualification_call(lambda:self.fail(error),
                    caps=SimpleNamespace(qualified=self.qualified))
            self.assertIs(raised.exception, error)

    def test_existing_cache_and_restore_codes_remain_original(self):
        for code in ('ONLINE_RECHARGE_HISTORICAL_IMAGE_CACHE_ECR_AUTH_FAILED',
                'ONLINE_RECHARGE_B_RESTORE_DECLARATION_UNPROVEN', 'API_ADMIN_CONTAINER_CHANGED'):
            error = RuntimeError(code)
            with self.subTest(code=code), self.assertRaises(RuntimeError) as raised:
                scope._restored_workspace_qualification_call(lambda:self.fail(error),
                    driver=self.driver, caps=SimpleNamespace(qualified=self.qualified))
            self.assertIs(raised.exception, error)


class ReviewedApplicationMappingTests(unittest.TestCase):
    """Real closed Git archives; synthetic metadata never publishes or grants F."""
    @classmethod
    def setUpClass(cls):
        cls.bridge=json.loads(scope._RESTORED_B_WITNESS['failedPreflight'])['baseline']
        cls.policy_name=scope._BITBROWSER_SCOPE_POLICY_FILE
        cls.policy_raw=(ROOT/cls.policy_name).read_bytes()
        cls.policy=json.loads(cls.policy_raw)
        cls.candidate_scope=(ROOT/'scripts/production-release/online-recharge-scope.py').read_bytes()
        cls.template_commit=REVIEWED_APPLICATION_TEMPLATE_COMMIT
        template_tree=subprocess.check_output(['git','rev-parse',cls.template_commit+'^{tree}'],cwd=ROOT).decode().strip()
        if template_tree != REVIEWED_APPLICATION_TEMPLATE_TREE:
            raise AssertionError('reviewed ONLINE application fixture tree changed')
        cls.template_test=subprocess.check_output(['git','show',cls.template_commit+':scripts/production-release/online-recharge-scope.test.py'],cwd=ROOT)
        cls.template_prefix='id-business-system-'+cls.template_commit+'/'
        raw=subprocess.check_output(['git','archive','--format=tar.gz','--prefix='+cls.template_prefix,cls.template_commit],cwd=ROOT)
        with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as archive:
            cls.rows=[(copy.copy(row),archive.extractfile(row).read() if row.isfile() else None) for row in archive.getmembers()]
        p=cls.bridge['baselineProducer']
        cls.before_raw=subprocess.check_output(['git','archive','--format=tar.gz','--prefix=id-business-system-'+p['commit']+'/',p['commit']],cwd=ROOT)
        cls.full=cls.build()
        cls.before=scope._pending_workspace_current_source_inventory(cls.full[0],p)
        cls.after=scope._pending_workspace_current_source_inventory(cls.full[0],cls.full[1])
        assert scope.fingerprint(cls.bridge)==cls.policy['baselineOriginSha256']
        assert len(cls.policy['files'])==40

    @classmethod
    def build(cls,replacements=None,deletions=(),modes=None):
        own={'scripts/production-release/online-recharge-scope.py':cls.candidate_scope,
            'scripts/production-release/online-recharge-scope.test.py':cls.template_test,
            cls.policy_name:cls.policy_raw}
        own.update(replacements or {})
        modes=modes or {};deleted=set(deletions)
        synthetic_commit='e'*40;prefix='id-business-system-'+synthetic_commit+'/'
        data_by_name={row.name[len(cls.template_prefix):]:data for row,data in cls.rows if row.isfile()}
        data_by_name.update(own)
        for name in deleted:data_by_name.pop(name,None)
        with tempfile.TemporaryDirectory(prefix='reviewed-index-',dir=RUNTIME) as folder:
            environment={**os.environ,'GIT_INDEX_FILE':str(Path(folder)/'index')}
            subprocess.run(['git','read-tree',cls.template_commit],cwd=ROOT,env=environment,check=True)
            for name in deleted:
                subprocess.run(['git','update-index','--force-remove',name],cwd=ROOT,env=environment,check=True)
            for name in set(own)|set(modes):
                if name in deleted:continue
                blob=subprocess.check_output(['git','hash-object','-w','--stdin'],input=data_by_name[name],cwd=ROOT).decode().strip()
                subprocess.run(['git','update-index','--add','--cacheinfo',modes.get(name,'100644'),blob,name],cwd=ROOT,env=environment,check=True)
            tree=subprocess.check_output(['git','write-tree'],cwd=ROOT,env=environment).decode().strip()
        output=io.BytesIO();written=set()
        with tarfile.open(fileobj=output,mode='w:gz',compresslevel=1) as archive:
            for old,data in cls.rows:
                row=copy.copy(old);relative=row.name[len(cls.template_prefix):] if row.name.startswith(cls.template_prefix) else ''
                row.name=prefix+relative if relative else prefix.rstrip('/')
                if relative in deleted:continue
                if row.isfile():
                    data=data_by_name[relative];row.size=len(data)
                    if relative in own or relative in modes:row.mode=0o755 if modes.get(relative)=='100755' else 0o644
                    written.add(relative)
                archive.addfile(row,io.BytesIO(data) if data is not None else None)
            for relative in sorted(set(data_by_name)-written):
                data=data_by_name[relative];row=tarfile.TarInfo(prefix+relative);row.size=len(data)
                row.mode=0o755 if modes.get(relative)=='100755' else 0o644
                archive.addfile(row,io.BytesIO(data))
        producer={'commit':synthetic_commit,'sourceTree':tree,'workflowRunId':'124','workflowRunAttempt':'1'}
        before_source=cls.bridge['baselineProducer']
        cached={(before_source['commit'],before_source['sourceTree']):cls.before_raw,(synthetic_commit,tree):output.getvalue()}
        d=controller(BASE=Path('/opt/id-business-v2'),_onlinePendingWorkspaceProducer=producer,_onlinePendingWorkspaceArchiveBytes=cached)
        return d,producer,output.getvalue()

    @contextmanager
    def carrier(self):
        with patch.object(scope.urllib.request,'urlopen',side_effect=AssertionError('no new network')):
            yield

    def inventory_for(self,fixture):
        d,producer,raw=fixture
        return scope._pending_workspace_current_source_inventory(d,producer)

    @contextmanager
    def physical_workers(self,published=False):
        # Actual B/N Git archives and all 40 fixed hashes; only the preceding
        # cold B/Q acquisition is synthetic. Never touch a production path.
        with tempfile.TemporaryDirectory(prefix='reviewed-workers-',dir=RUNTIME) as folder, ExitStack() as stack:
            base=Path(folder);bridge=copy.deepcopy(self.bridge)
            previous=base/'releases'/('20261011T000000Z-'+bridge['baselineCommit'][:12])
            previous.mkdir(parents=True,mode=0o700);bridge['baselineRelease']=str(previous)
            policy=copy.deepcopy(self.policy);policy['baselineOriginSha256']=scope.fingerprint(bridge)
            encoded=json.dumps(policy,separators=(',',':')).encode()
            raw=encoded+b' '*(len(self.policy_raw)-len(encoded))
            stack.enter_context(patch.object(scope,'_BITBROWSER_SCOPE_POLICY_SHA256',hashlib.sha256(raw).hexdigest()))
            for key in ('_WORKSPACE_CAPACITY_CONTROL_POLICY','_WORKSPACE_RELEASE_RULES_POLICY'):
                value=copy.deepcopy(getattr(scope,key));value['baselineOriginSha256']=scope.fingerprint(bridge)
                stack.enter_context(patch.object(scope,key,value))
            d,p,after_raw=self.build({self.policy_name:raw});d.BASE=base
            target=base/'releases'/('20261012T000000Z-'+p['commit'][:12]);target.mkdir(mode=0o700)
            d._onlinePendingWorkspaceSession={'bridge':bridge,'producer':p}
            reader=SimpleNamespace(online_after_bit_cold=MagicMock(return_value=bridge))
            stack.enter_context(patch.object(scope,'_pending_workspace_reader',return_value=reader))
            stack.enter_context(patch.object(scope,'_workspace_baseline_reader',return_value=(scope.ONLINE_AFTER_BIT_KIND,reader.online_after_bit_cold)))
            stack.enter_context(patch.object(scope,'_workspace_after_bit_materials',return_value={
                'producer':{'archiveInventorySha256':scope.fingerprint(self.before)}}))
            stack.enter_context(self.carrier())
            worker='apps/api/src/id-business-v2/auto-recharge/worker'
            roots=(worker+'/', 'apps/api/src/id-business-v2/auto-registration/')
            shared_names=('scripts/v2-data-integrity-audit.mjs','scripts/lib/v2-data-integrity-audit.mjs',
                'scripts/sync-v2-new-table-grants.mjs',scope.GRANT_SOURCE)
            for directory,producer,archive_raw in ((previous,bridge['baselineProducer'],self.before_raw),(target,p,after_raw)):
                prefix='id-business-system-'+producer['commit']+'/'
                with tarfile.open(fileobj=io.BytesIO(archive_raw),mode='r:gz') as archive:
                    for row in archive.getmembers():
                        name=row.name[len(prefix):]
                        if row.isfile() and (name.startswith(roots) or name in shared_names
                                or name in self.policy['files'] or name==self.policy_name
                                or name in scope._AFTER_BIT_BANK_POLICY_FILES):
                            path=directory/name;path.parent.mkdir(parents=True,exist_ok=True)
                            path.write_bytes(archive.extractfile(row).read());path.chmod(0o644)
            (base/'current').symlink_to(target if published else previous)
            manifest={'commit':p['commit'],'sourceTree':p['sourceTree'],'previousRelease':str(previous),
                'previousCommit':bridge['baselineCommit'],'previousManifestSha256':bridge['manifestBytesSha256']}
            if published:
                for name,value in (('release-manifest.json',manifest),(scope.STATE_FILE,{}),(scope.PROOF_FILE,{})):
                    path=target/name;path.write_text(json.dumps(value)+'\n');path.chmod(0o600)
            yield SimpleNamespace(d=d,p=p,bridge=bridge,previous=previous,target=target,base=base,
                worker=worker,manifest=manifest,reader=reader)

    def test_reviewed_worker_source_carry_passes_stage_and_published_without_rewriting_b(self):
        for published in (False,True):
            with self.subTest(published=published),self.physical_workers(published) as f:
                name=f.worker+'/server.py';before=(f.previous/name).read_bytes();after=(f.target/name).read_bytes()
                self.assertNotEqual(before,after)
                scope.protected_source(f.d,f.previous,f.target)
                self.assertEqual((f.previous/name).read_bytes(),before)
                self.assertEqual((f.target/name).read_bytes(),after)
                self.assertEqual((f.base/'current').resolve(),f.target if published else f.previous)
                self.assertGreater(f.reader.online_after_bit_cold.call_count,0)

    def test_physical_worker_mapped_unmapped_bytes_modes_and_complete_sets_are_closed(self):
        for side in ('before','after'):
            for variation in ('mapped-byte','unmapped-byte','delete','mode','extra','symlink','hardlink','fifo'):
                with self.subTest(side=side,variation=variation),self.physical_workers() as f:
                    root=f.previous if side=='before' else f.target
                    name=f.worker+('/attempt_ledger.py' if variation=='unmapped-byte' else '/server.py')
                    path=root/name
                    if variation.endswith('byte'):path.write_bytes(path.read_bytes()+b'UNSEALED')
                    elif variation=='delete':path.unlink()
                    elif variation=='mode':path.chmod(0o755)
                    elif variation=='extra':(root/f.worker/'unreviewed.py').write_bytes(b'UNSEALED')
                    elif variation=='symlink':path.unlink();path.symlink_to('attempt_ledger.py')
                    elif variation=='hardlink':os.link(path,root/f.worker/'unreviewed.py')
                    else:path.unlink();os.mkfifo(path)
                    with self.assertRaises((RuntimeError,OSError)):
                        scope.protected_source(f.d,f.previous,f.target)

    def test_worker_carry_requires_complete_mapping_and_fresh_old_materials(self):
        with self.physical_workers() as f:
            actual=scope._pending_workspace_current_source_inventory(f.d,f.p)
            name=next(n for n in self.policy['files'] if not n.startswith(f.worker+'/'))
            actual.pop(name)
            with patch.object(scope,'_pending_workspace_profile',return_value=actual):
                with self.assertRaisesRegex(RuntimeError,'APPLICATION_SOURCE_CHANGED'):
                    scope.protected_source(f.d,f.previous,f.target)
        with self.physical_workers() as f,patch.object(scope,'_workspace_after_bit_materials',
                side_effect=RuntimeError('ONLINE_RECHARGE_AFTER_BIT_ORIGIN_CHANGED')):
            with self.assertRaisesRegex(RuntimeError,'AFTER_BIT_ORIGIN_CHANGED'):
                scope.protected_source(f.d,f.previous,f.target)

    def test_reviewed_nonworker_physical_files_and_before_absence_remain_exact(self):
        name=next(n for n,pair in self.policy['files'].items()
            if n.startswith('apps/admin/') and pair['before'] is not None)
        for side in ('before','after'):
            for variation in ('byte','mode','delete'):
                with self.subTest(side=side,variation=variation),self.physical_workers() as f:
                    path=(f.previous if side=='before' else f.target)/name
                    if variation=='byte':path.write_bytes(path.read_bytes()+b'UNSEALED')
                    elif variation=='mode':path.chmod(0o755)
                    else:path.unlink()
                    with self.assertRaises((RuntimeError,OSError)):
                        scope.protected_source(f.d,f.previous,f.target)
        for name in (self.policy_name,'docs/BITBROWSER_FLOW_RELEASE_20261012.md'):
            with self.subTest(added_before=name),self.physical_workers() as f:
                path=f.previous/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'UNSEALED')
                with self.assertRaisesRegex(RuntimeError,'LEGACY_SOURCE_CHANGED'):
                    scope.protected_source(f.d,f.previous,f.target)

    def test_worker_carry_stage_and_published_phase_bindings_are_closed(self):
        for published,variation in ((False,'old-current-moved'),(False,'stage-receipt'),
                (False,'wrong-target-name'),(True,'manifest-commit'),(True,'manifest-tree'),
                (True,'manifest-previous'),(True,'manifest-previous-commit'),
                (True,'manifest-old-sha'),(True,'proof-missing')):
            with self.subTest(published=published,variation=variation),self.physical_workers(published) as f:
                if variation=='old-current-moved':
                    (f.base/'current').unlink();(f.base/'current').symlink_to(f.base)
                elif variation=='stage-receipt':(f.target/scope.STATE_FILE).write_text('{}\n')
                elif variation=='wrong-target-name':
                    other=f.base/'releases'/'unbound-candidate';f.target.rename(other);f.target=other
                elif variation=='proof-missing':(f.target/scope.PROOF_FILE).unlink()
                else:
                    key={'manifest-commit':'commit','manifest-tree':'sourceTree','manifest-previous':'previousRelease',
                        'manifest-previous-commit':'previousCommit',
                        'manifest-old-sha':'previousManifestSha256'}[variation]
                    f.manifest[key]='unbound';(f.target/'release-manifest.json').write_text(json.dumps(f.manifest)+'\n')
                with self.assertRaises((RuntimeError,OSError)):
                    scope.protected_source(f.d,f.previous,f.target)

    def test_worker_carry_source_scan_rejects_current_pointer_drift(self):
        with self.physical_workers() as f:
            read=scope._declaration_source_bytes
            def moved(path,**kwargs):
                result=read(path,**kwargs)
                if path==f.target/(f.worker+'/server.py'):
                    (f.base/'current').unlink();(f.base/'current').symlink_to(f.target)
                return result
            with patch.object(scope,'_declaration_source_bytes',side_effect=moved):
                with self.assertRaisesRegex(RuntimeError,'LEGACY_SOURCE_CHANGED'):
                    scope.protected_source(f.d,f.previous,f.target)

    def test_worker_carry_accepts_actual_restoration_session_dispatch(self):
        for published in (False,True):
            with self.subTest(published=published),self.physical_workers(published) as f:
                f.d._onlinePendingWorkspaceSession.update(restoration={},beforeServices={})
                with patch.object(scope,'_restored_workspace_sidecar',return_value={}) as sidecar:
                    scope.protected_source(f.d,f.previous,f.target)
                    self.assertGreater(sidecar.call_count,0)

    def test_registration_and_historical_or_ordinary_worker_paths_keep_original_equality(self):
        with self.physical_workers() as f:
            path=next((f.target/'apps/api/src/id-business-v2/auto-registration').rglob('*.ts'))
            path.write_bytes(path.read_bytes()+b'UNSEALED')
            with self.assertRaisesRegex(RuntimeError,'LEGACY_SOURCE_CHANGED'):
                scope.protected_source(f.d,f.previous,f.target)
        for historical in (False,True):
            with self.subTest(historical=historical),self.physical_workers() as f:
                if historical:f.d._onlinePendingWorkspaceSession['bridge']['baselineRelease']=str(f.base/'historical-b')
                else:del f.d._onlinePendingWorkspaceSession
                with patch.object(scope,'_pending_workspace_session',side_effect=AssertionError('no source exception')):
                    with self.assertRaisesRegex(RuntimeError,'LEGACY_SOURCE_CHANGED'):
                        scope.protected_source(f.d,f.previous,f.target)

    def test_complete_forty_files_and_added_policy_pass_all_three_active_gates(self):
        d,p,raw=self.full
        names=frozenset(self.policy['files'])|{self.policy_name}
        with self.carrier():
            self.assertEqual(scope._workspace_reviewed_application_inventory(d,self.bridge,self.before,self.after,p),names)
            self.assertEqual(scope._workspace_release_ci_inventory(d,self.bridge,self.before,self.after),frozenset(scope._AFTER_BIT_RELEASE_CI_FILES))
            self.assertEqual(scope._workspace_bank_policy_inventory(d,self.bridge,self.before,self.after),frozenset(scope._AFTER_BIT_BANK_POLICY_FILES)-scope._PENDING_WORKSPACE_RECEIPT_COMPATIBILITY_FILES)
            self.assertEqual(scope._pending_workspace_profile(d,self.bridge,p),self.after)
        self.assertEqual(len(self.policy['files']),40)
        self.assertEqual(sum(pair['before'] is None for pair in self.policy['files'].values()),1)

    def test_each_reviewed_file_hash_revert_delete_or_executable_mode_is_rejected(self):
        d,p,raw=self.full
        for name,pair in self.policy['files'].items():
            for variation in ('hash','revert','delete','executable'):
                changed=copy.deepcopy(self.after)
                if variation=='hash':changed[name]['sha256']='0'*64
                elif variation=='revert':
                    if pair['before'] is None:changed.pop(name)
                    else:changed[name]=copy.deepcopy(self.before[name])
                elif variation=='delete':changed.pop(name)
                else:changed[name]['mode']='100755'
                with self.subTest(name=name,variation=variation):
                    with self.assertRaisesRegex(RuntimeError,'APPLICATION_SOURCE_CHANGED'):
                        scope._workspace_reviewed_application_inventory(d,self.bridge,self.before,changed,p)

    def test_real_archive_deleted_reviewed_file_is_rejected_after_successful_tree_validation(self):
        name=next(iter(self.policy['files']))
        d,p,raw=self.build(deletions=(name,))
        inventory=self.inventory_for((d,p,raw))
        self.assertNotIn(name,inventory)
        with self.assertRaisesRegex(RuntimeError,'APPLICATION_SOURCE_CHANGED'):
            scope._workspace_reviewed_application_inventory(d,self.bridge,self.before,inventory,p)

    def test_real_archive_single_application_byte_drift_is_rejected(self):
        name='apps/api/src/id-business-v2/auto-recharge/worker/server.py'
        data=subprocess.check_output(['git','show',self.template_commit+':'+name],cwd=ROOT)+b'\n'
        d,p,raw=self.build({name:data});inventory=self.inventory_for((d,p,raw))
        with self.assertRaisesRegex(RuntimeError,'APPLICATION_SOURCE_CHANGED'):
            scope._workspace_reviewed_application_inventory(d,self.bridge,self.before,inventory,p)

    def test_real_archive_executable_application_mode_is_rejected(self):
        name='apps/api/src/id-business-v2/auto-recharge/worker/server.py'
        d,p,raw=self.build(modes={name:'100755'});inventory=self.inventory_for((d,p,raw))
        with self.assertRaisesRegex(RuntimeError,'APPLICATION_SOURCE_CHANGED'):
            scope._workspace_reviewed_application_inventory(d,self.bridge,self.before,inventory,p)

    def test_added_doc_cannot_have_a_fabricated_before_entry(self):
        d,p,raw=self.full;before=copy.deepcopy(self.before)
        before['docs/BITBROWSER_FLOW_RELEASE_20261012.md']=copy.deepcopy(self.after['docs/BITBROWSER_FLOW_RELEASE_20261012.md'])
        with self.assertRaisesRegex(RuntimeError,'APPLICATION_SOURCE_CHANGED'):
            scope._workspace_reviewed_application_inventory(d,self.bridge,before,self.after,p)

    def test_policy_missing_unknown_hash_executable_or_preexisting_is_rejected(self):
        d,p,raw=self.full
        for variation in ('missing','hash','mode','preexisting'):
            before=copy.deepcopy(self.before);after=copy.deepcopy(self.after)
            if variation=='missing':after.pop(self.policy_name)
            elif variation=='hash':after[self.policy_name]['sha256']='f'*64
            elif variation=='mode':after[self.policy_name]['mode']='100755'
            else:before[self.policy_name]=copy.deepcopy(after[self.policy_name])
            with self.subTest(variation=variation),self.carrier():
                with self.assertRaises(RuntimeError):
                    if variation=='missing':
                        with patch.object(scope,'_pending_workspace_current_source_inventory',side_effect=[after,before]):scope._pending_workspace_profile(d,self.bridge,p)
                    else:scope._workspace_reviewed_application_inventory(d,self.bridge,before,after,p)

    def test_changed_policy_in_a_valid_new_tree_is_not_accepted(self):
        raw=self.policy_raw.replace(b'"pullRequest": 446',b'"pullRequest": 447')
        self.assertNotEqual(raw,self.policy_raw)
        self.assertEqual(len(raw),len(self.policy_raw))
        d,p,source=self.build({self.policy_name:raw});inventory=self.inventory_for((d,p,source))
        with self.assertRaisesRegex(RuntimeError,'APPLICATION_SOURCE_CHANGED'):
            scope._workspace_reviewed_application_inventory(d,self.bridge,self.before,inventory,p)

    def test_policy_after_none_and_boolean_bytes_fail_schema_even_with_test_only_digest_pin(self):
        for variation in ('after-none','bytes-bool','before-identity','partial-files'):
            policy=copy.deepcopy(self.policy);name=next(iter(policy['files']))
            if variation=='after-none':policy['files'][name]['after']=None
            elif variation=='bytes-bool':policy['files'][name]['after']['bytes']=True
            elif variation=='before-identity':policy['baselineProducer']['workflowRunId']='125'
            else:policy['files'].pop(name)
            encoded=json.dumps(policy,sort_keys=True,separators=(',',':')).encode()
            self.assertLessEqual(len(encoded),len(self.policy_raw))
            raw=encoded+b' '*(len(self.policy_raw)-len(encoded))
            d,p,source=self.build({self.policy_name:raw});inventory=self.inventory_for((d,p,source))
            # This isolated schema test supplies an explicit test-only digest;
            # production remains pinned to the immutable approved JSON bytes.
            with self.subTest(variation=variation),patch.object(scope,'_BITBROWSER_SCOPE_POLICY_SHA256',hashlib.sha256(raw).hexdigest()):
                with self.assertRaisesRegex(RuntimeError,'APPLICATION_SOURCE_CHANGED'):
                    scope._workspace_reviewed_application_inventory(d,self.bridge,self.before,inventory,p)

    def test_only_exact_actual_b_bridge_and_controller_producer_are_accepted(self):
        d,p,raw=self.full
        for variation in ('kind','baseline','fingerprint'):
            bridge=copy.deepcopy(self.bridge)
            if variation=='kind':bridge['kind']=scope.ONLINE_PENDING_WORKSPACE_KIND
            elif variation=='baseline':bridge['baselineProducer']['workflowRunId']='125'
            else:bridge['publicationSha256']='f'*64
            with self.subTest(variation=variation):
                with self.assertRaises(RuntimeError):scope._workspace_reviewed_application_inventory(d,bridge,self.before,self.after,p)
        with self.assertRaisesRegex(RuntimeError,'APPLICATION_SOURCE_CHANGED'):
            scope._workspace_reviewed_application_inventory(d,self.bridge,self.before,self.after,{**p,'workflowRunId':'125'})

    def test_missing_cached_archives_and_changed_cache_bytes_do_not_grant_mapping(self):
        d,p,raw=self.full
        for producer in (p,self.bridge['baselineProducer']):
            key=(producer['commit'],producer['sourceTree']);saved=d._onlinePendingWorkspaceArchiveBytes.pop(key)
            try:
                with self.assertRaisesRegex(RuntimeError,'APPLICATION_SOURCE_CHANGED'):
                    scope._workspace_reviewed_application_inventory(d,self.bridge,self.before,self.after,p)
            finally:d._onlinePendingWorkspaceArchiveBytes[key]=saved
        name=next(iter(self.policy['files']))
        changed=subprocess.check_output(['git','show',self.template_commit+':'+name],cwd=ROOT)+b'\n'
        other,unused,changed_raw=self.build({name:changed});key=(p['commit'],p['sourceTree'])
        saved=d._onlinePendingWorkspaceArchiveBytes[key];d._onlinePendingWorkspaceArchiveBytes[key]=changed_raw
        try:
            with self.assertRaisesRegex(RuntimeError,'APPLICATION_SOURCE_CHANGED'):
                scope._workspace_reviewed_application_inventory(d,self.bridge,self.before,self.after,p)
            with self.assertRaisesRegex(RuntimeError,'SOURCE_TREE_CHANGED'):
                scope._pending_workspace_current_source_inventory(d,p)
        finally:d._onlinePendingWorkspaceArchiveBytes[key]=saved

    def test_additional_application_config_migration_and_unknown_policy_still_fail_profile(self):
        paths=('apps/api/src/main.ts','docker-compose.aws-mysql.yml','prisma/schema.prisma',
            'prisma/migrations/unauthorized/migration.sql','deploy/aws/unknown-reviewed-policy.json')
        for name in paths:
            raw=(subprocess.check_output(['git','show',self.template_commit+':'+name],cwd=ROOT)+b'\n') if name in self.after else b'unapproved\n'
            d,p,source=self.build({name:raw});inventory=self.inventory_for((d,p,source))
            with self.subTest(name=name),self.carrier():
                with self.assertRaisesRegex(RuntimeError,'APPLICATION_SOURCE_CHANGED'):
                    scope._pending_workspace_profile(d,self.bridge,p)

    def test_unrelated_deleted_file_still_fails_profile(self):
        name='apps/api/src/main.ts'
        d,p,raw=self.build(deletions=(name,));self.inventory_for((d,p,raw))
        with self.carrier(),self.assertRaisesRegex(RuntimeError,'APPLICATION_SOURCE_CHANGED'):
            scope._pending_workspace_profile(d,self.bridge,p)

    def test_later_mailbox_batch_and_ci_source_do_not_enter_first_online_mapping(self):
        paths=('apps/api/src/id-business-v2/auto-registration/worker/apple_closed_loop.py',
            'apps/api/src/id-business-v2/auto-registration/worker/apple_mailboxes.py',
            'scripts/ci-recharge-check.mjs')
        for name in paths:
            with self.subTest(name=name):
                current=(ROOT/name).read_bytes() if (ROOT/name).is_file() else b'unreviewed-independent-batch\n'
                if name in self.after:
                    original=subprocess.check_output(['git','show',self.template_commit+':'+name],cwd=ROOT)
                    if current == original:
                        current += b'\nunreviewed-independent-batch\n'
                d,p,raw=self.build({name:current})
                with self.carrier(),self.assertRaisesRegex(RuntimeError,'APPLICATION_SOURCE_CHANGED'):
                    scope._pending_workspace_profile(d,self.bridge,p)

    def test_historical_ci_mapping_is_exact_and_rejects_current_or_partial_pins(self):
        historical=scope._RESTORED_B_WITNESS['policy']['failedProducer']
        archive=subprocess.check_output(['git','archive','--format=tar.gz',
            '--prefix=id-business-system-'+historical['commit']+'/',historical['commit']],cwd=ROOT)
        other=controller(BASE=Path('/opt/id-business-v2'),
            _onlinePendingWorkspaceArchiveBytes={(historical['commit'],historical['sourceTree']):archive})
        genuine=scope._pending_workspace_current_source_inventory(other,historical)
        for mutation in ('current','partial','mode','extra'):
            altered=copy.deepcopy(genuine)
            key='scripts/ci-recharge-scope.mjs'
            if mutation=='current':
                altered[key]={'sha256':scope._AFTER_BIT_RELEASE_CI_FILES[key][1],'mode':'100644'}
            elif mutation=='partial':altered[key]=copy.deepcopy(self.before[key])
            elif mutation=='mode':altered[key]['mode']='100755'
            else:altered[self.policy_name]=copy.deepcopy(self.after[self.policy_name])
            with self.subTest(mutation=mutation),patch.object(scope,'_pending_workspace_current_source_inventory',
                    side_effect=[self.before,altered]):
                with self.assertRaisesRegex(RuntimeError,'B_RESTORE_FAILED_SOURCE_CHANGED'):
                    scope._restored_workspace_failed_source_inventory(other,self.bridge,historical)
        with patch.object(scope,'_pending_workspace_current_source_inventory',
                side_effect=[self.before,genuine]):
            with self.assertRaisesRegex(RuntimeError,'B_RESTORE_FAILED_SOURCE_CHANGED'):
                scope._restored_workspace_failed_source_inventory(other,self.bridge,self.full[1])

    def test_historical_failed_c_mapping_has_no_reviewed_application_exception(self):
        d,p,raw=self.full
        historical=scope._RESTORED_B_WITNESS['policy']['failedProducer']
        archive=subprocess.check_output(['git','archive','--format=tar.gz','--prefix=id-business-system-'+historical['commit']+'/',historical['commit']],cwd=ROOT)
        other=controller(BASE=Path('/opt/id-business-v2'),_onlinePendingWorkspaceProducer=p,
            _onlinePendingWorkspaceArchiveBytes={**d._onlinePendingWorkspaceArchiveBytes,(historical['commit'],historical['sourceTree']):archive})
        result=scope._restored_workspace_failed_source_inventory(other,self.bridge,historical)
        self.assertEqual(scope._workspace_reviewed_application_inventory(other,self.bridge,self.before,result),frozenset())
        self.assertNotIn(self.policy_name,result)



if __name__ == '__main__':
    unittest.main()
