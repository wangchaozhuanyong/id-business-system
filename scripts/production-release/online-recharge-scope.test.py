import base64
import copy
from contextlib import ExitStack, contextmanager, redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
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
shared = load('online_recharge_legacy_scope_tests', 'api-admin-scope.py')


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
        with patch.object(shared, 'jobs_idle', return_value={}), patch.object(scope, 'database_read', return_value={'busy': 1}), self.assertRaisesRegex(RuntimeError, 'TASKS_BUSY'):
            scope.jobs_idle(controller(), self.new, migrated=True)


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
        for key, value in (('api_registration_only', True), ('historical_mailbox', True), ('expected_current', COMMIT)):
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

    def test_projection_diagnostic_retains_gate_and_exposes_only_bounded_cause(self):
        try:
            try:
                raise KeyError('SECRET_MUST_NOT_ESCAPE')
            except KeyError:
                raise RuntimeError('API_ADMIN_BASELINE_PROJECTION_FAILED') from None
        except RuntimeError as error:
            failure = error
        with patch.object(shared, 'baseline', side_effect=failure):
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


class ReleaseSequenceTests(unittest.TestCase):
    def execute(self, fail=None, busy=False):
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
                'migration_source_check': MagicMock(), 'protected_source': MagicMock(),
                'require_preserved': MagicMock(return_value=(states(True), {})),
                'migration_database_state': MagicMock(side_effect=[{'status': 'PENDING'}, {'status': 'APPLIED'}, {'status': 'APPLIED'}]),
                'configuration_hashes': MagicMock(return_value={}),
                'verify_image_content': MagicMock(), 'verify_running': MagicMock(), 'historical_guard': MagicMock(),
                'verify_permission_seed': MagicMock(), 'require_fresh_resources': lambda *a: events.append('empty9'),
                'jobs_idle': idle, 'snapshot': MagicMock(return_value=states()),
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
        selected = [e for e in events if e.startswith(('audit:', 'switch:')) or e in ('backup', 'migration', 'grants')]
        self.assertEqual(selected, ['audit:before-audit.json', 'backup', 'migration', 'grants',
                                   'switch:admin', 'switch:api', 'switch:online-recharge', 'audit:after-audit.json'])
        self.assertEqual(events.count('empty9'), 4)

    def test_post_migration_grant_failure_keeps_additive_schema_and_never_switches(self):
        result, receipt, events = self.execute(fail='grants')
        self.assertEqual(result, 1)
        self.assertEqual(receipt['status'], 'ONLINE_RECHARGE_FAILED_BEFORE_SWITCH')
        self.assertFalse(any(e.startswith('switch:') for e in events))
        self.assertEqual(receipt['migration']['status'], 'APPLIED')
        self.assertFalse(receipt['inverseMigrationPerformed'])
        self.assertNotIn('RAW_SYNTHETIC_SECRET', json.dumps(receipt))

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


if __name__ == '__main__':
    unittest.main()
