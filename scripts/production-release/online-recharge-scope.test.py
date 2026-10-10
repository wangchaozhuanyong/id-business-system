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
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
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
        with self.fixture() as (d, previous, source, *_):
            target = previous.parent / 'new-candidate'
            shutil.copytree(self.prepared, target)
            for name in self.policy['candidateAllowedFiles']:
                path = target / name; path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((ROOT / name).read_bytes())
                path.chmod(0o755 if (ROOT / name).stat().st_mode & 0o111 else 0o644)
            context = {'policy': self.policy, 'source': source}
            scope.candidate_recovery_source(d, target, context)
            helper = target / scope.GRANT_SOURCE
            helper.write_bytes(helper.read_bytes().replace(b"  'online_recharge_bills',\n", b"  'online_recharge_bills',\n  'online_recharge_tasks',\n"))
            with self.assertRaisesRegex(RuntimeError, 'SHARED_GATE_SOURCE_CHANGED'):
                scope.candidate_recovery_source(d, target, context)
            helper.write_bytes((ROOT / scope.GRANT_SOURCE).read_bytes())
            path = target / 'apps/admin/src/v2/features/online-recharge/unapproved.ts'
            path.write_text('unapproved UI change')
            with self.assertRaisesRegex(RuntimeError, 'BUILD_SOURCE_CHANGED'):
                scope.candidate_recovery_source(d, target, context)

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
    def execute(self, fail=None, busy=False, recovered=False):
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
                'workspace_guard': MagicMock(),
                'workspace_origin': origin,
                'readback': lambda *a: {'status': 'ONLINE_RECHARGE_VERIFIED'},
            }.items():
                stack.enter_context(patch.object(scope, name, return_value=value) if name == 'legacy' else patch.object(scope, name, value))
            stack.enter_context(patch.object(scope.subprocess, 'run', return_value=SimpleNamespace(returncode=0)))
            stack.enter_context(patch.object(scope.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * 1024**3)))
            stack.enter_context(patch.object(scope.urllib.request, 'urlopen', return_value=response))
            stack.enter_context(redirect_stdout(output))
            result = scope._release_locked(d, args)
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

    def test_old_all_functions_classes_and_constants_remain_exact_ast(self):
        import ast
        # The preservation witness is the reviewed pre-capability baseline.
        # HEAD is the fixture's producer archive and changes after committing.
        old_commit = 'd8466a58cc577ed83189503f260a9c914fcac3be'
        old = ast.parse(subprocess.check_output(['git', 'show', old_commit + ':scripts/production-release/online-recharge-scope.py'], cwd=ROOT))
        current = ast.parse((ROOT / 'scripts/production-release/online-recharge-scope.py').read_text())
        by_name = {n.name: n for n in current.body if isinstance(n, (ast.FunctionDef, ast.ClassDef))}
        for node in old.body:
            if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
                actual = copy.deepcopy(by_name[node.name])
                if node.name == 'measure_declaration_equivalence':
                    # This previously closed stub is the sole replaced entry.
                    # Its ABI and two purpose/input guards remain exact; the
                    # source-bound delegate is exercised below with table0.
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

    def test_formal_measurement_is_closed_before_source_or_runtime_authority(self):
        for purpose, raw in (('INDEPENDENT_PREFLIGHT', None), ('DEPLOYMENT_REMEASURE', b'{}')):
            # This test's synthetic helper directory has no trusted package.
            with self.assertRaisesRegex(RuntimeError, '^ONLINE_RECHARGE_DECLARATION_DRIVER_UNAVAILABLE$'):
                scope.measure_declaration_equivalence(self.d, self.previous, self.recovery,
                    producer=self.producer, purpose=purpose, preflight_raw=raw)
            with patch.object(scope, '__file__', str(ROOT / 'scripts/production-release/online-recharge-scope.py')):
                # Native acquisition requires actual root; nonroot local/CI
                # callers fail before the package's separately tested table0.
                code = ('SOURCE_NOT_MEASURED' if os.geteuid() == 0 else 'DRIVER_UNAVAILABLE')
                with self.assertRaisesRegex(RuntimeError, '^ONLINE_RECHARGE_DECLARATION_' + code + '$'):
                    scope.measure_declaration_equivalence(self.d, self.previous, self.recovery,
                        producer=self.producer, purpose=purpose, preflight_raw=raw)
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


if __name__ == '__main__':
    unittest.main()
