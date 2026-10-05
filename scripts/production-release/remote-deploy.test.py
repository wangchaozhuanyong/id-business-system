import importlib.util
import ast
import base64
import gzip
from pathlib import Path
import unittest
import tempfile
import json
import io
import tarfile
import copy
import re
import sqlite3
import shlex
import textwrap
from contextlib import ExitStack, redirect_stdout
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('deployment', Path(__file__).with_name('remote-deploy.py'))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
reuse_spec = importlib.util.spec_from_file_location('reuse', Path(__file__).with_name('reuse-images.py'))
reuse = importlib.util.module_from_spec(reuse_spec)
reuse_spec.loader.exec_module(reuse)


class ReleaseScopeTests(unittest.TestCase):
    def test_admin_only_never_selects_api_workers_or_migration_image(self):
        services, images = deployment.release_services(True, [])
        self.assertEqual(services, ('admin',))
        self.assertEqual(images, ('admin',))

    def test_migration_blocks_admin_only_before_any_service_switch(self):
        with self.assertRaisesRegex(RuntimeError, 'contains migrations'):
            deployment.release_services(True, ['20261001_example'])

    def test_other_scope_retains_the_full_release(self):
        services, images = deployment.release_services(False, ['20261001_example'])
        self.assertEqual(services, deployment.SERVICES)
        self.assertEqual(images, ('media-resolver', 'auto-recharge', 'api', 'admin', 'migrate'))


    def test_edge_changes_switch_caddy_without_building_an_edge_image(self):
        services, images = deployment.release_services(False, [], True)
        self.assertEqual(services, (*deployment.SERVICES, 'caddy'))
        self.assertEqual(images, ('media-resolver', 'auto-recharge', 'api', 'admin', 'migrate'))
        with self.assertRaisesRegex(RuntimeError, 'edge configuration'):
            deployment.release_services(True, [], True)

    def test_only_caddy_can_use_running_status_without_container_health(self):
        state = {'status': 'running', 'health': None}
        with patch.object(deployment, 'service_state', return_value=state), \
                patch.object(deployment.time, 'sleep'):
            self.assertEqual(deployment.wait_healthy(None, 'caddy'), state)
            with self.assertRaisesRegex(RuntimeError, 'did not become healthy'):
                deployment.wait_healthy(None, 'admin')

    def test_independent_workers_pin_the_same_built_image_reference(self):
        services, images = deployment.release_services(False, [], True)
        tags = {service: 'fixture-' + service for service in images}
        references = deployment.release_image_references(services, images, 'fixture-registry', tags)
        self.assertEqual(references['auto-registration'], references['auto-recharge'])
        self.assertEqual(references['auto-registration'], 'fixture-registry:fixture-auto-recharge')
        self.assertIn('migrate', references)
        self.assertNotIn('caddy', references)
        services, images = deployment.release_services(True, [])
        self.assertEqual(deployment.release_image_references(services, images, 'fixture-registry', tags),
                         {'admin': 'fixture-registry:fixture-admin'})

    def test_old_baseline_and_split_layout_select_only_existing_services(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            compose = directory / 'docker-compose.aws-mysql.yml'
            compose.write_text('services:\n  auto-recharge:\n  api:\n')
            self.assertNotIn('auto-registration', deployment.production_services(directory))
            compose.write_text('services:\n  auto-recharge:\n  auto-registration:\n  api:\n')
            self.assertEqual(deployment.production_services(directory), deployment.ALL_SERVICES)

    def test_transition_rollback_removes_only_the_added_worker(self):
        with patch.object(deployment, 'compose', side_effect=['', '']) as compose, \
                patch.object(deployment, 'service_state') as state:
            deployment.rollback_service('old', 'new', 'auto-registration', {})
        self.assertEqual(compose.call_args_list[0].args,
                         ('new', 'rm', '-s', '-f', 'auto-registration'))
        self.assertEqual(compose.call_args_list[1].args,
                         ('new', 'ps', '-q', '--all', 'auto-registration'))
        state.assert_not_called()
        with patch.object(deployment, 'compose', side_effect=['', 'still-running']):
            with self.assertRaisesRegex(RuntimeError, 'worker remains'):
                deployment.rollback_service('old', 'new', 'auto-registration', {})
        with patch.object(deployment, 'compose') as compose:
            with self.assertRaisesRegex(RuntimeError, 'Unexpected added'):
                deployment.rollback_service('old', 'new', 'api', {})
        compose.assert_not_called()

    def test_later_split_rollback_restores_existing_registration_image(self):
        state = {'image': 'sha256:fixture-old'}
        with patch.object(deployment, 'compose') as compose, \
                patch.object(deployment, 'service_state', return_value=state), \
                patch.object(deployment, 'wait_healthy') as health:
            deployment.rollback_service('old', 'new', 'auto-registration', {'auto-registration': state})
        self.assertEqual(compose.call_args.args,
                         ('old', 'up', '-d', '--no-deps', '--no-build', '--pull', 'never',
                          '--force-recreate', 'auto-registration'))
        health.assert_called_once_with('old', 'auto-registration')


class RegistrationReleaseGuardTests(unittest.TestCase):
    def setUp(self):
        self.database = sqlite3.connect(':memory:')
        self.addCleanup(self.database.close)
        self.database.execute('CREATE TABLE id_business_v2_registration_jobs '
                              '(state TEXT, lease_until TEXT, browser_profile_id TEXT)')
        self.database.create_function('UTC_TIMESTAMP', 1, lambda _: '2026-10-03 00:00:00')
        self.idle = {'supported': True, 'registrationBusy': False,
                     'registrationWindowRetained': False}
        self.layout = patch.object(deployment, 'has_registration_worker', return_value=False)
        self.layout.start()
        self.addCleanup(self.layout.stop)

    def row(self, state, lease='2026-10-03 01:00:00', profile='reg_original'):
        self.database.execute('INSERT INTO id_business_v2_registration_jobs VALUES (?, ?, ?)',
                              (state, lease, profile))

    def mysql(self, directory, *args, **kwargs):
        self.assertEqual(args[:5], ('exec', '-T', 'mysql', 'sh', '-c'))
        sql = re.search(r'-e "([^"]+)"$', args[-1]).group(1)
        # Execute the actual gate predicate with only MySQL dialect conversions.
        sql = re.sub(r'0x([0-9a-f]+)',
                     lambda match: "'" + bytes.fromhex(match.group(1)).decode() + "'", sql)
        sql = sql.replace('LEFT(browser_profile_id, 4)', 'substr(browser_profile_id, 1, 4)')
        return str(self.database.execute(sql).fetchone()[0])

    def guard(self, runtime=None):
        with patch.object(deployment, 'registration_runtime_state',
                          return_value=self.idle if runtime is None else runtime), \
                patch.object(deployment, 'compose', side_effect=self.mysql):
            deployment.assert_no_active_registration(None)

    def test_live_running_and_verification_attempts_block_even_before_profile_receipt(self):
        for state in ('running', 'awaiting_email', 'awaiting_user'):
            with self.subTest(state=state):
                self.database.execute('DELETE FROM id_business_v2_registration_jobs')
                self.row(state, profile=None)
                with self.assertRaisesRegex(RuntimeError, 'Active registration jobs'):
                    self.guard()

    def test_history_completed_cancelled_queued_and_expired_rows_do_not_invent_windows(self):
        for state in ('completed', 'cancelled', 'partial'):
            self.row(state)
        self.row('queued', lease=None, profile=None)
        self.row('running', lease='2026-10-02 23:00:00')
        self.guard()

    def test_running_worker_or_retained_partial_window_blocks_without_sql_guessing(self):
        self.row('partial', lease=None)
        for field in ('registrationBusy', 'registrationWindowRetained'):
            with self.subTest(field=field), \
                    patch.object(deployment, 'registration_runtime_state',
                                 return_value={**self.idle, field: True}), \
                    patch.object(deployment, 'compose') as sql:
                with self.assertRaisesRegex(RuntimeError, 'Active registration jobs'):
                    deployment.assert_no_active_registration(None)
                sql.assert_not_called()

    def test_legacy_worker_allows_old_local_jobs_and_history_without_builtin_window(self):
        self.row('awaiting_user', profile='bitbrowser_original')
        self.row('running', profile=None)
        self.row('partial')
        self.guard({'supported': False})

    def test_legacy_worker_cannot_bypass_an_explicit_live_builtin_attempt(self):
        self.row('running')
        with self.assertRaisesRegex(RuntimeError, 'Active registration jobs'):
            self.guard({'supported': False})

    def test_admin_only_keeps_recharge_gate_without_interrupting_registration(self):
        with patch.object(deployment, 'assert_no_active_recharge') as recharge, \
                patch.object(deployment, 'assert_no_active_registration') as registration:
            deployment.assert_no_active_jobs(None, worker_changes=False)
        recharge.assert_called_once_with(None)
        registration.assert_not_called()
        with patch.object(deployment, 'assert_no_active_recharge',
                          side_effect=RuntimeError('Active recharge jobs prevent release')), \
                patch.object(deployment, 'assert_no_active_registration') as registration:
            with self.assertRaisesRegex(RuntimeError, 'Active recharge jobs'):
                deployment.assert_no_active_jobs(None, worker_changes=True)
        registration.assert_not_called()

    def test_full_switch_preserves_both_independent_guards(self):
        with patch.object(deployment, 'assert_no_active_recharge') as recharge, \
                patch.object(deployment, 'assert_no_active_registration') as registration:
            deployment.assert_no_active_jobs('current', worker_changes=True)
        recharge.assert_called_once_with('current')
        registration.assert_called_once_with('current')

    def test_invalid_or_unreadable_runtime_receipt_fails_closed_without_raw_error(self):
        values = ('not-json', '[]', '{"supported":0}',
                  json.dumps({**self.idle, 'registrationBusy': 0}),
                  json.dumps({**self.idle, 'unexpected': 'fixture-sensitive-value'}))
        for value in values:
            with self.subTest(value=value), patch.object(deployment, 'compose', return_value=value):
                with self.assertRaisesRegex(RuntimeError, 'Registration runtime guard unavailable'):
                    deployment.registration_runtime_state(None)
        with patch.object(deployment, 'compose',
                          side_effect=RuntimeError('fixture-sensitive-value')):
            with self.assertRaisesRegex(RuntimeError, '^Registration runtime guard unavailable$'):
                deployment.registration_runtime_state(None)

    def execute_probe(self, response_value=None, error=None, split=False):
        opener = MagicMock()
        if error is not None:
            opener.open.side_effect = error
        else:
            opener.open.return_value.__enter__.return_value.read.return_value = (
                json.dumps(response_value).encode())

        def container(directory, *args, **kwargs):
            service = 'auto-registration' if split else 'auto-recharge'
            self.assertEqual(args[:5], ('exec', '-T', service, 'python', '-c'))
            stdout = io.StringIO()
            with patch('urllib.request.build_opener', return_value=opener), \
                    patch.dict(deployment.os.environ, {'AUTO_RECHARGE_WORKER_TOKEN': 'fixture-token'}), \
                    redirect_stdout(stdout):
                try:
                    exec(args[-1], {})
                except SystemExit:
                    raise RuntimeError('container probe failed') from None
            return stdout.getvalue()

        with patch.object(deployment, 'compose', side_effect=container), \
                patch.object(deployment, 'has_registration_worker', return_value=split):
            result = deployment.registration_runtime_state(None)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, 'http://127.0.0.1:8051/registration/health')
        self.assertEqual(request.get_header('X-recharge-worker'), 'fixture-token')
        self.assertNotIn('fixture-token', json.dumps(result))
        return result

    def test_authenticated_probe_returns_only_boolean_queue_proof(self):
        for split in (False, True):
            with self.subTest(split=split):
                result = self.execute_probe({'ready': True, 'engine': 'camoufox',
                                             'registrationBusy': False, 'registrationWindowRetained': False,
                                             **({'workerRole': 'registration'} if split else {}),
                                             'extra': 'fixture-sensitive-value'}, split=split)
                self.assertEqual(result, self.idle)

    def test_split_worker_requires_registration_role_without_legacy_fallback(self):
        for role in (None, 'recharge', 'unrecognized'):
            value = {'ready': True, 'engine': 'camoufox',
                     'registrationBusy': False, 'registrationWindowRetained': False}
            if role is not None:
                value['workerRole'] = role
            with self.subTest(role=role), \
                    self.assertRaisesRegex(RuntimeError, 'Registration runtime guard unavailable'):
                self.execute_probe(value, split=True)

    def test_only_legacy_404_is_supported_not_auth_failure_redirect_or_timeout(self):
        from urllib.error import HTTPError
        self.assertEqual(self.execute_probe(error=HTTPError('unused', 404, 'old', {}, None)),
                         {'supported': False})
        with self.assertRaisesRegex(RuntimeError, 'Registration runtime guard unavailable'):
            self.execute_probe(error=HTTPError('unused', 404, 'split', {}, None), split=True)
        for status in (301, 401, 403, 500):
            with self.subTest(status=status), \
                    self.assertRaisesRegex(RuntimeError, 'Registration runtime guard unavailable'):
                self.execute_probe(error=HTTPError('unused', status, 'failure', {}, None))
        with self.assertRaisesRegex(RuntimeError, 'Registration runtime guard unavailable'):
            self.execute_probe(error=TimeoutError('fixture-sensitive-value'))

    def test_new_worker_without_boolean_proof_or_readiness_fails_closed(self):
        for value in ({'ready': True, 'engine': 'camoufox'},
                      {'ready': False, 'engine': 'camoufox',
                       'registrationBusy': False, 'registrationWindowRetained': False},
                      {'ready': True, 'engine': 'camoufox',
                       'registrationBusy': 'false', 'registrationWindowRetained': False}):
            with self.subTest(value=value), \
                    self.assertRaisesRegex(RuntimeError, 'Registration runtime guard unavailable'):
                self.execute_probe(value)


class CommandFailureSummaryTests(unittest.TestCase):
    def test_failure_reports_controlled_reason_and_source_line(self):
        result = deployment.command_failure_summary({
            'Status': 'Failed', 'ResponseCode': 1,
            'StandardErrorContent': '  File "/opt/example/remote-deploy.py", line 329\n'
                                    'RuntimeError: Active recharge jobs prevent release\n'})
        self.assertEqual(result['sourceLine'], 329)
        self.assertEqual(result['reason'], 'Active recharge jobs prevent release')

    def test_unknown_error_never_exposes_raw_secret_or_stdout(self):
        result = deployment.command_failure_summary({
            'Status': 'Failed', 'ResponseCode': 1,
            'StandardErrorContent': 'RuntimeError: fixture-sensitive-password',
            'StandardOutputContent': 'fixture-sensitive-cookie'})
        self.assertNotIn('fixture-sensitive', json.dumps(result))
        self.assertEqual(result['reason'], 'raw error suppressed')

    def test_registration_guard_reports_only_approved_reason(self):
        for reason in ('Active registration jobs prevent release',
                       'Registration runtime guard unavailable'):
            result = deployment.command_failure_summary({
                'Status': 'Failed', 'ResponseCode': 1,
                'StandardErrorContent': 'RuntimeError: ' + reason + '\nfixture-sensitive-token'})
            self.assertEqual(result['reason'], reason)
            self.assertNotIn('fixture-sensitive', json.dumps(result))

    def test_diagnostics_preflight_reports_only_six_existing_guard_reasons(self):
        reasons = (
            'Historical diagnostics running manifest changed',
            'Historical diagnostics requires the fixed independent worker layout',
            'Historical continuation running image changed',
            'Historical diagnostics image override changed',
            'Production container identity unavailable',
            'Production container start identity unavailable',
        )
        expected_keys = {'status', 'responseCode', 'errorType', 'sourceLine', 'reason'}
        for reason in reasons:
            with self.subTest(reason=reason):
                result = deployment.command_failure_summary({
                    'Status': 'Failed', 'ResponseCode': 1,
                    'StandardErrorContent': '  File "/fixture-sensitive-path/remote-deploy.py", line 114\n'
                        'RuntimeError: ' + reason + '\nfixture-sensitive-token-and-password',
                    'StandardOutputContent': 'fixture-sensitive-private-receipt',
                    'Private': 'fixture-sensitive-private-field'})
                self.assertEqual(set(result), expected_keys)
                self.assertEqual(result, {'status': 'Failed', 'responseCode': 1,
                    'errorType': 'RuntimeError', 'sourceLine': 114, 'reason': reason})
                self.assertNotIn('fixture-sensitive', json.dumps(result))

    def test_real_summary_cli_returns_fixed_preflight_labels_without_sensitive_body(self):
        script = Path(__file__).with_name('remote-deploy.py')
        for reason in (
            'Historical diagnostics running manifest changed',
            'Historical diagnostics requires the fixed independent worker layout',
            'Historical continuation running image changed',
            'Historical diagnostics image override changed',
            'Production container identity unavailable',
            'Production container start identity unavailable',
        ):
            with self.subTest(reason=reason):
                result = deployment.subprocess.run([deployment.sys.executable, str(script),
                    '--summarize-command-result'], input=json.dumps({
                        'Status': 'Failed', 'ResponseCode': 1,
                        'StandardErrorContent': '  File "/fixture-sensitive-source/remote-deploy.py", line 114\n'
                            'RuntimeError: ' + reason + '\nfixture-sensitive-private-error',
                        'StandardOutputContent': 'fixture-sensitive-private-output'}),
                    capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0)
                self.assertEqual(len(result.stdout.splitlines()), 1)
                self.assertTrue(result.stdout.startswith('RELEASE_FAILURE_DIAGNOSTIC '))
                summary = json.loads(result.stdout.removeprefix('RELEASE_FAILURE_DIAGNOSTIC '))
                self.assertEqual(summary, {'status': 'Failed', 'responseCode': 1,
                    'errorType': 'RuntimeError', 'sourceLine': 114, 'reason': reason})
                self.assertNotIn('fixture-sensitive', result.stdout + result.stderr)

    def test_untrusted_status_and_response_fields_are_filtered(self):
        result = deployment.command_failure_summary({
            'Status': 'fixture-sensitive-token', 'ResponseCode': 'fixture-sensitive-token'})
        self.assertEqual(result['status'], 'Unknown')
        self.assertIsNone(result['responseCode'])


class ReusableImageTests(unittest.TestCase):
    def setUp(self):
        self.run = {'event': 'workflow_dispatch', 'path': '.github/workflows/production-release.yml',
                    'head_branch': 'main', 'status': 'completed', 'head_sha': 'a' * 40,
                    'run_attempt': 1}
        self.jobs = {'jobs': [{'name': 'release', 'steps': [
            {'name': name, 'conclusion': 'success'} for name in (
                'Verify exact source and passing Quality Gate',
                'Build images on the GitHub runner', 'Push immutable images')]}]}

    def test_only_verified_successful_build_steps_are_reused(self):
        self.assertEqual(reuse.build_source(self.run, self.jobs), ('a' * 40, '1'))
        for index in range(3):
            jobs = copy.deepcopy(self.jobs)
            jobs['jobs'][0]['steps'][index]['conclusion'] = 'failure'
            with self.assertRaisesRegex(RuntimeError, 'did not succeed'):
                reuse.build_source(self.run, jobs)

    def test_other_workflow_branch_and_incomplete_run_are_rejected(self):
        for field, value in [('head_branch', 'other'), ('event', 'push'),
                             ('status', 'in_progress'), ('path', '.github/workflows/quality.yml')]:
            with self.assertRaisesRegex(RuntimeError, 'Unverified previous'):
                reuse.build_source({**self.run, field: value}, self.jobs)

    def test_application_dependency_migration_and_runtime_config_changes_reject_reuse(self):
        deployment.require_reusable_paths(['scripts/production-release/remote-deploy.py'])
        for path in ('apps/api/src/example.ts', 'apps/admin/src/v2/example.vue',
                     'apps/api/prisma-mysql/schema.prisma', 'package-lock.json',
                     'docker-compose.aws-mysql.yml', 'deploy/aws/google-drive-sync-folder.json'):
            with self.assertRaisesRegex(RuntimeError, 'source changed'):
                deployment.require_reusable_paths([path])

    def archive(self, files):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
            for path, contents, mode in files:
                member = tarfile.TarInfo('id-business-system-' + 'a' * 40 + '/' + path)
                data = contents.encode()
                member.size = len(data)
                member.mode = mode
                archive.addfile(member, io.BytesIO(data))
        buffer.seek(0)
        return tarfile.open(fileobj=buffer, mode='r:gz')

    def test_server_rechecks_all_non_control_contents_and_executable_modes(self):
        with tempfile.TemporaryDirectory() as root:
            release = Path(root)
            (release / 'apps/api').mkdir(parents=True)
            source = release / 'apps/api/app.ts'
            source.write_text('same application')
            (release / 'docs').mkdir()
            (release / 'docs/PRODUCTION_RELEASE_OIDC.md').write_text('new procedure')
            files = [('apps/api/app.ts', 'same application', 0o644),
                     ('docs/PRODUCTION_RELEASE_OIDC.md', 'old procedure', 0o644)]
            with self.archive(files) as archive:
                deployment.verify_reusable_archive(release, archive, 'a' * 40)
            source.write_text('different application')
            with self.archive(files) as archive:
                with self.assertRaisesRegex(RuntimeError, 'differs from release'):
                    deployment.verify_reusable_archive(release, archive, 'a' * 40)
            source.write_text('same application')
            source.chmod(0o755)
            with self.archive(files) as archive:
                with self.assertRaisesRegex(RuntimeError, 'differs from release'):
                    deployment.verify_reusable_archive(release, archive, 'a' * 40)

    def test_missing_new_files_and_unsafe_archive_paths_fail_closed(self):
        with tempfile.TemporaryDirectory() as root:
            release = Path(root)
            (release / 'package.json').write_text('new dependency')
            for files, reason in [([], 'differs from release'),
                                  ([('../escape', 'bad', 0o644)], 'Unsafe reusable')]:
                with self.archive(files) as archive:
                    with self.assertRaisesRegex(RuntimeError, reason):
                        deployment.verify_reusable_archive(release, archive, 'a' * 40)


class WorkerComposeTransitionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.previous = Path(self.temp.name) / 'previous'
        self.release = Path(self.temp.name) / 'release'
        self.previous.mkdir()
        self.release.mkdir()
        self.split = (Path(__file__).parents[2] / 'docker-compose.aws-mysql.yml').read_text()
        # Legacy layout fixture: preserve every existing service setting while
        # removing only the reviewed new worker, fixed role and API binding.
        self.legacy = re.sub(r'(?ms)^  auto-registration:\n.*?(?=^  api:)', '', self.split)
        self.legacy = self.legacy.replace(
            '    image: &browser-worker-image '
            '${AUTO_RECHARGE_WORKER_IMAGE:-id-business-v2-auto-recharge:local}\n', '')
        for line in ('      AUTO_RECHARGE_WORKER_ROLE: recharge\n',
                     '      AUTO_REGISTRATION_WORKER_URL: http://auto-registration:8051\n',
                     '      - registration-control\n',
                     '  registration-control:\n    internal: true\n  registration-egress:\n'):
            self.legacy = self.legacy.replace(line, '')
        (self.previous / 'docker-compose.aws-mysql.yml').write_text(self.legacy)
        (self.release / 'docker-compose.aws-mysql.yml').write_text(self.split)
        (self.release / '.env.aws.production').write_text('EXISTING_SETTING=fixture\n')

    def test_transition_allows_the_exact_reviewed_layout_without_environment_rewrite(self):
        self.assertIsNone(deployment.configure_google_drive_sync(self.previous, self.release))
        self.assertEqual((self.release / '.env.aws.production').read_text(), 'EXISTING_SETTING=fixture\n')
        (self.previous / 'docker-compose.aws-mysql.yml').write_text(self.split)
        self.assertIsNone(deployment.configure_google_drive_sync(self.previous, self.release))

    def test_worker_role_shared_volume_or_unrelated_mutation_is_rejected(self):
        invalid = (
            self.split.replace('AUTO_RECHARGE_WORKER_ROLE: registration', 'AUTO_RECHARGE_WORKER_ROLE: recharge'),
            self.split.replace('  auto-registration:\n', '  auto-registration:\n    volumes:\n      - shared:/tmp\n'),
            self.split.replace('    image: *browser-worker-image', '    image: unreviewed-image:latest'),
            self.split.replace('AUTO_REGISTRATION_WORKER_URL: http://auto-registration:8051',
                               'AUTO_REGISTRATION_WORKER_URL: http://auto-recharge:8051'),
            self.split.replace('MYSQL_HOST_PORT:-3306', 'MYSQL_HOST_PORT:-3307'),
        )
        for compose in invalid:
            with self.subTest(compose=invalid.index(compose)):
                (self.release / 'docker-compose.aws-mysql.yml').write_text(compose)
                with self.assertRaises(RuntimeError):
                    deployment.configure_google_drive_sync(self.previous, self.release)

    def test_registration_worker_cannot_be_silently_removed_on_later_release(self):
        (self.previous / 'docker-compose.aws-mysql.yml').write_text(self.split)
        (self.release / 'docker-compose.aws-mysql.yml').write_text(self.legacy)
        with self.assertRaisesRegex(RuntimeError, 'Independent registration worker removed'):
            deployment.configure_google_drive_sync(self.previous, self.release)


class GoogleDriveReleaseConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.previous = Path(self.temp.name) / 'previous'
        self.release = Path(self.temp.name) / 'release'
        self.previous.mkdir()
        (self.release / 'deploy/aws').mkdir(parents=True)
        self.original = 'services:\n  api:\n    environment:\n      APP_PUBLIC_URL: ${APP_PUBLIC_URL}\n'
        self.binding = '      GOOGLE_DRIVE_SYNC_FOLDER_ID: ${GOOGLE_DRIVE_SYNC_FOLDER_ID:-}\n'
        (self.previous / 'docker-compose.aws-mysql.yml').write_text(self.original)
        (self.release / 'docker-compose.aws-mysql.yml').write_text(self.original + self.binding)
        (self.release / '.env.aws.production').write_text('APP_PUBLIC_URL=https://example.invalid\n')
        (self.release / 'deploy/aws/google-drive-sync-folder.json').write_text(
            json.dumps({'folderId': 'reviewed-folder-123'}))

    def test_only_reviewed_folder_is_added_and_other_settings_survive(self):
        self.assertEqual(deployment.configure_google_drive_sync(self.previous, self.release),
                         'reviewed-folder-123')
        env = self.release / '.env.aws.production'
        self.assertEqual(env.read_text(), 'APP_PUBLIC_URL=https://example.invalid\n'
                         'GOOGLE_DRIVE_SYNC_FOLDER_ID=reviewed-folder-123\n')
        self.assertEqual(env.stat().st_mode & 0o777, 0o600)
        deployment.configure_google_drive_sync(self.previous, self.release)
        self.assertEqual(env.read_text().count('GOOGLE_DRIVE_SYNC_FOLDER_ID='), 1)

    def test_unrelated_compose_mutation_stops_before_configuration_write(self):
        p = self.release / 'docker-compose.aws-mysql.yml'
        p.write_text(p.read_text().replace('  api:', '  unexpected:'))
        with self.assertRaisesRegex(RuntimeError, 'beyond Google Drive'):
            deployment.configure_google_drive_sync(self.previous, self.release)
        self.assertNotIn('GOOGLE_DRIVE_SYNC_FOLDER_ID=',
                         (self.release / '.env.aws.production').read_text())

    def test_mailbox_binding_addition_with_or_without_folder_configuration(self):
        mailbox = '      VENDURE_MAILBOX_WEBHOOK_SECRET: ${VENDURE_MAILBOX_WEBHOOK_SECRET:-}\n'
        compose = self.release / 'docker-compose.aws-mysql.yml'
        compose.write_text(self.original + self.binding + mailbox)
        self.assertEqual(deployment.configure_google_drive_sync(self.previous, self.release),
                         'reviewed-folder-123')
        (self.release / 'deploy/aws/google-drive-sync-folder.json').unlink()
        compose.write_text(self.original + mailbox)
        self.assertIsNone(deployment.configure_google_drive_sync(self.previous, self.release))
        # A later release keeps the existing binding without changing its value.
        (self.previous / 'docker-compose.aws-mysql.yml').write_text(self.original + mailbox)
        self.assertIsNone(deployment.configure_google_drive_sync(self.previous, self.release))

    def test_mailbox_binding_does_not_allow_unreviewed_compose_changes(self):
        mailbox = '      VENDURE_MAILBOX_WEBHOOK_SECRET: ${VENDURE_MAILBOX_WEBHOOK_SECRET:-}\n'
        compose = self.release / 'docker-compose.aws-mysql.yml'
        for contents in [self.original + self.binding + mailbox * 2,
                         self.original.replace('  api:', '  unexpected:') + self.binding + mailbox]:
            compose.write_text(contents)
            with self.assertRaises(RuntimeError):
                deployment.configure_google_drive_sync(self.previous, self.release)
        (self.previous / 'docker-compose.aws-mysql.yml').write_text(self.original + mailbox)
        for contents in [self.original + self.binding,
                         self.original + self.binding + mailbox.replace(':-}', ':?required}')]:
            compose.write_text(contents)
            with self.assertRaises(RuntimeError):
                deployment.configure_google_drive_sync(self.previous, self.release)

    def test_invalid_folder_and_duplicate_environment_fail_closed(self):
        config = self.release / 'deploy/aws/google-drive-sync-folder.json'
        config.write_text(json.dumps({'folderId': 'bad\ninjected=value'}))
        with self.assertRaisesRegex(RuntimeError, 'Invalid reviewed'):
            deployment.configure_google_drive_sync(self.previous, self.release)
        config.write_text(json.dumps({'folderId': 'reviewed-folder-123'}))
        (self.release / '.env.aws.production').write_text(
            'GOOGLE_DRIVE_SYNC_FOLDER_ID=one\nGOOGLE_DRIVE_SYNC_FOLDER_ID=two\n')
        with self.assertRaisesRegex(RuntimeError, 'Duplicate'):
            deployment.configure_google_drive_sync(self.previous, self.release)



class HistoricalContinuationTests(unittest.TestCase):
    def policy(self):
        return json.loads((Path(__file__).resolve().parents[2] / 'deploy/aws' /
            (deployment.HISTORY_CONTINUATION_POLICY_ID + '.json')).read_text())

    def fixture(self, root):
        policy = self.policy(); proof = policy['continuation']
        sources = {name: group['sha256'] for name, group in policy['sources'].items()}
        reports = {}
        for stage in ('before', 'after'):
            gate = {'accepted': True, 'status': 'APPROVED_HISTORICAL_EXCEPTIONS',
                'policyId': deployment.HISTORY_POLICY_ID, 'expectedCurrent': deployment.HISTORY_BASELINE,
                'stage': stage, 'checkCount': 48, 'violationCount': 10,
                'executedCheckCount': 48, 'unavailableCheckCount': 0, 'sources': sources,
                'metadataSha256': proof['metadataSha256']}
            self.assertEqual(deployment.historical_fingerprint(gate), proof[stage + 'GateSha256'])
            reports[stage] = {'ok': False, 'checkCount': 48, 'violationCount': 10, 'gate': gate}
        manifest = {**proof['manifest'], **{
            'dataAudit' + stage.title(): {'checkCount': 48, 'violationCount': 10,
                'historicalException': report['gate']} for stage, report in reports.items()}}
        values = {'release-manifest.json': manifest,
                  **{stage + '-audit.json': report for stage, report in reports.items()}}
        self.save_fixture(root, policy, values)
        return policy, values

    def save_fixture(self, root, policy, values):
        # Synthetic private files exercise the verifier; real policy identity is tested separately.
        for name, value in values.items():
            data = json.dumps(value).encode(); path = root / name
            path.write_bytes(data); path.chmod(0o600)
            key = {'release-manifest.json': 'manifestSha256',
                   'before-audit.json': 'beforeReceiptSha256',
                   'after-audit.json': 'afterReceiptSha256'}[name]
            policy['continuation'][key] = deployment.hashlib.sha256(data).hexdigest()

    def test_only_original_or_one_fixed_continuation_baseline_is_allowed(self):
        deployment.require_historical_baseline(deployment.HISTORY_POLICY_ID, deployment.HISTORY_BASELINE)
        deployment.require_historical_baseline(deployment.HISTORY_CONTINUATION_POLICY_ID,
                                               deployment.HISTORY_CONTINUATION_BASELINE)
        for policy, baseline in [(deployment.HISTORY_POLICY_ID, deployment.HISTORY_CONTINUATION_BASELINE),
                (deployment.HISTORY_CONTINUATION_POLICY_ID, deployment.HISTORY_BASELINE),
                (deployment.HISTORY_CONTINUATION_POLICY_ID, 'f' * 40), ('unknown', 'f' * 40)]:
            with self.subTest(policy=policy), self.assertRaises(RuntimeError):
                deployment.require_historical_baseline(policy, baseline)

    def test_continuation_policy_requires_the_pinned_complete_identity(self):
        source = Path(__file__).resolve().parents[2]
        deployment.continuation_policy(source)
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            root = Path(name); (root / 'deploy/aws').mkdir(parents=True)
            policy = self.policy(); policy['expectedCurrent'] = 'f' * 40
            (root / 'deploy/aws' / (deployment.HISTORY_CONTINUATION_POLICY_ID + '.json')).write_text(
                json.dumps(policy))
            with self.assertRaisesRegex(RuntimeError, 'policy changed'):
                deployment.continuation_policy(root)

    def test_successful_original_private_manifest_and_both_receipts_are_required(self):
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            root = Path(name); policy, values = self.fixture(root)
            self.assertEqual(deployment.verify_continuation_baseline(root, policy), values['release-manifest.json'])
            for filename in values:
                path = root / filename; original = path.read_bytes()
                path.write_bytes(original + b' ')
                with self.subTest(filename=filename), self.assertRaisesRegex(RuntimeError, 'receipt changed'):
                    deployment.verify_continuation_baseline(root, policy)
                path.write_bytes(original)
            (root / 'after-audit.json').unlink()
            with self.assertRaisesRegex(RuntimeError, 'receipt unavailable'):
                deployment.verify_continuation_baseline(root, policy)

    def test_same_count_but_forged_successful_origin_gate_or_metadata_is_rejected(self):
        mutations = [
            lambda x: x['release-manifest.json'].update(commit='f' * 40),
            lambda x: x['release-manifest.json'].update(sourceTree='f' * 40),
            lambda x: x['before-audit.json']['gate'].update(executedCheckCount=46, unavailableCheckCount=2),
            lambda x: x['after-audit.json']['gate'].update(metadataSha256='f' * 64),
            lambda x: x['after-audit.json']['gate'].update(sources={'unknown': 'f' * 64}),
            lambda x: x['after-audit.json']['gate'].update(accepted=False),
            lambda x: x['release-manifest.json']['dataAuditAfter'].update(violationCount=0),
        ]
        for index, mutate in enumerate(mutations):
            with tempfile.TemporaryDirectory(dir='.deploy') as name:
                root = Path(name); policy, values = self.fixture(root)
                mutate(values); self.save_fixture(root, policy, values)
                with self.subTest(index=index), self.assertRaises(RuntimeError):
                    deployment.verify_continuation_baseline(root, policy)

    def test_receipts_cannot_be_public_symlinks_or_hardlinks(self):
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            root = Path(name); path = root / 'private.json'; path.write_text('{}'); path.chmod(0o600)
            link = root / 'link.json'; link.symlink_to(path.name)
            hard = root / 'hard.json'; deployment.os.link(path, hard)
            for candidate in (link, hard):
                with self.subTest(candidate=candidate.name), self.assertRaises(RuntimeError):
                    deployment.private_historical_receipt(candidate)
            hard.unlink(); path.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError, 'not private'):
                deployment.private_historical_receipt(path)

    def test_running_services_must_match_the_frozen_manifest_images(self):
        states = {service: {'image': 'sha256:' + service} for service in deployment.SERVICES}
        manifest = {'images': {service: {'digest': state['image']} for service, state in states.items()}}
        deployment.verify_continuation_running_images(states, manifest)
        states['auto-registration']['image'] = 'sha256:other'
        with self.assertRaisesRegex(RuntimeError, 'running image changed'):
            deployment.verify_continuation_running_images(states, manifest)

    def audit_report(self, stage):
        policy = self.policy()
        return {'ok': False, 'checkCount': 48, 'violationCount': 10, 'gate': {
            'accepted': True, 'status': 'APPROVED_HISTORICAL_EXCEPTIONS',
            'policyId': policy['id'], 'expectedCurrent': policy['expectedCurrent'],
            'fixedCurrent': policy['expectedCurrent'], 'continuationOf': deployment.HISTORY_POLICY_ID,
            'stage': stage, 'checkCount': 48, 'violationCount': 10, 'executedCheckCount': 48,
            'unavailableCheckCount': 0, 'sources': {
                name: group['sha256'] for name, group in policy['sources'].items()},
            'metadataSha256': policy['continuation']['metadataSha256'],
            'continuation': policy['continuation']}}

    def audit(self, report, stage):
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            root = Path(name); before = root / 'before.json'; before.write_text('{}'); before.chmod(0o600)
            source = Path(__file__).resolve().parents[2]
            with patch.object(deployment, 'environment_values', return_value={
                    'V2_DATA_INTEGRITY_DATABASE_URL': 'mysql://id_business_audit:synthetic@localhost/test'}), \
                    patch.object(deployment.os, 'fchown'), \
                    patch.object(deployment, 'compose', side_effect=lambda directory, *args, **kwargs:
                        json.dumps({'uid':1000,'gid':1000,'user':'node'} if '--entrypoint' in args else report)) as compose:
                result = deployment.audit(root, root / 'receipt.json', historical_continuation=True,
                    stage=stage, source=source, before_receipt=before)
                return result, compose.call_args.args

    def test_new_audit_mounts_exact_continuation_and_reports_original_exception_source(self):
        for stage in ('before', 'after'):
            result, command = self.audit(self.audit_report(stage), stage)
            self.assertEqual(result['violationCount'], 10)
            self.assertEqual(result['historicalException']['continuationOf'], deployment.HISTORY_POLICY_ID)
            self.assertIn('--expected-current=' + deployment.HISTORY_CONTINUATION_BASELINE, command)
            self.assertIn('--policy=/release-policy/' + deployment.HISTORY_CONTINUATION_POLICY_ID + '.json', command)
            self.assertNotIn('--user', command)
            self.assertTrue(all(command[index + 1].endswith(':ro')
                for index, part in enumerate(command) if part == '-v'))

    def test_new_audit_rejects_incomplete_stable_but_changed_or_false_zero_receipts(self):
        mutations = [lambda x: x.update(ok=True), lambda x: x.update(checkCount=46),
            lambda x: x['gate'].update(executedCheckCount=46),
            lambda x: x['gate'].update(unavailableCheckCount=2),
            lambda x: x['gate'].update(metadataSha256='f' * 64),
            lambda x: x['gate'].update(sources={'unknown':'f' * 64}),
            lambda x: x['gate'].update(continuationOf='other'),
            lambda x: x['gate'].update(fixedCurrent='f' * 40),
            lambda x: x['gate']['continuation'].update(manifestSha256='f' * 64)]
        for stage in ('before', 'after'):
            for index, mutate in enumerate(mutations):
                report = self.audit_report(stage); mutate(report)
                with self.subTest(stage=stage, index=index), self.assertRaises(RuntimeError):
                    self.audit(report, stage)

    def test_candidate_allows_only_the_frozen_registration_files_and_named_controls(self):
        policy = self.policy()
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            root = Path(name); (root / 'apps/api').mkdir(parents=True)
            (root / 'apps/api/unrelated.ts').write_text('unchanged')
            for filename in policy['candidateSourceSha256']:
                path = root / filename; path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture-only:' + filename)
                policy['candidateSourceSha256'][filename] = deployment.hashlib.sha256(path.read_bytes()).hexdigest()
            control = root / 'scripts/production-release/remote-deploy.py'
            control.parent.mkdir(parents=True); control.write_text('fixture control')
            content = b'unchanged'; data = io.BytesIO()
            with tarfile.open(fileobj=data, mode='w') as archive:
                item = tarfile.TarInfo(f'id-business-system-{deployment.HISTORY_CONTINUATION_BASELINE}/apps/api/unrelated.ts')
                item.size = len(content); item.mode = 0o644; archive.addfile(item, io.BytesIO(content))
            def verify():
                with tarfile.open(fileobj=io.BytesIO(data.getvalue()), mode='r') as archive:
                    deployment.verify_continuation_archive(root, archive, policy)
            verify()
            (root / 'apps/api/unrelated.ts').write_text('changed')
            with self.assertRaisesRegex(RuntimeError, 'unrelated source'):
                verify()
            (root / 'apps/api/unrelated.ts').write_text('unchanged')
            (root / next(iter(policy['candidateSourceSha256']))).write_text('unfrozen registration')
            with self.assertRaisesRegex(RuntimeError, 'registration source changed'):
                verify()


class HistoricalAuditTests(unittest.TestCase):
    reader_identity = {'uid': 1000, 'gid': 1000, 'user': 'node'}

    def report(self):
        return {'ok': False, 'checkCount': 48, 'violationCount': 10, 'gate': {
            'accepted': True, 'policyId': 'historical-finance-20261005',
            'expectedCurrent': 'ed2f75b0f4075347224ce3b2c82a90ed514d8d22',
            'stage': 'after', 'checkCount': 48, 'violationCount': 10, 'unavailableCheckCount': 0}}

    def audit(self, report, historical=True):
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            root = Path(name); source = root / 'candidate'
            (source / 'deploy/aws').mkdir(parents=True)
            (source / 'scripts').mkdir()
            (source / 'deploy/aws/historical-finance-20261005.json').write_text('{}')
            (root / 'before.json').write_text('{}')
            (root / 'before.json').chmod(0o600)
            with patch.object(deployment, 'environment_values', return_value={
                    'V2_DATA_INTEGRITY_DATABASE_URL': 'mysql://id_business_audit:synthetic@localhost/test'}), \
                    patch.object(deployment.os, 'fchown'), \
                    patch.object(deployment, 'compose', side_effect=lambda directory, *command, **kwargs:
                        json.dumps(self.reader_identity if '--entrypoint' in command else report)) as compose:
                result = deployment.audit(root, root / 'receipt.json', historical_exception=historical,
                    stage='after', source=source, before_receipt=root / 'before.json')
                saved = json.loads((root / 'receipt.json').read_text())
                self.assertEqual(saved['ok'], report['ok'])
                return result, compose.call_args.args

    def test_regular_audit_never_accepts_legacy_exception(self):
        with self.assertRaisesRegex(RuntimeError, 'Financial data integrity audit failed'):
            self.audit(self.report(), False)

    def test_special_audit_preserves_actual_violation_count_and_mounts_exact_source(self):
        result, command = self.audit(self.report())
        self.assertEqual(result['violationCount'], 10)
        self.assertIn('scripts/v2-release-history-audit.mjs', command)
        self.assertIn('--stage=after', command)
        self.assertIn('--before-receipt=/release-before-audit.json', command)
        self.assertTrue(any(str(mount).endswith(':/release-before-audit.json:ro') for mount in command))

    def test_receipt_mount_does_not_need_a_missing_target_inside_read_only_policy_directory(self):
        def inspect_mounts(directory, *command, **kwargs):
            if '--entrypoint' in command:
                return json.dumps(self.reader_identity)
            mounts = [command[index + 1].rsplit(':', 2)
                      for index, part in enumerate(command) if part == '-v']
            for parent_host, parent_target, parent_mode in mounts:
                if parent_mode != 'ro' or not Path(parent_host).is_dir():
                    continue
                for _child_host, child_target, _child_mode in mounts:
                    parent = Path(parent_target)
                    child = Path(child_target)
                    if parent != child and parent in child.parents:
                        target = Path(parent_host) / child.relative_to(parent)
                        self.assertTrue(target.exists(),
                            'Nested mount target must exist inside a read-only parent bind')
            return json.dumps(self.report())

        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            root = Path(name); source = root / 'candidate'
            (source / 'scripts').mkdir(parents=True)
            (source / 'deploy/aws').mkdir(parents=True)
            before = root / 'before-audit.json'
            before.write_text('{}')
            before.chmod(0o600)
            self.assertFalse((source / 'deploy/aws/before-audit.json').exists())
            with patch.object(deployment, 'environment_values', return_value={
                    'V2_DATA_INTEGRITY_DATABASE_URL': 'mysql://id_business_audit:synthetic@localhost/test'}), \
                    patch.object(deployment.os, 'fchown'), \
                    patch.object(deployment, 'compose', side_effect=inspect_mounts):
                deployment.audit(root, root / 'receipt.json', historical_exception=True,
                                 stage='after', source=source, before_receipt=before)

    def test_private_receipt_is_owned_by_actual_non_root_reader_and_remains_owner_read_only(self):
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            root = Path(name); before = root / 'before-audit.json'
            before.write_text('{}'); before.chmod(0o600)
            parent_mode = root.stat().st_mode
            with patch.object(deployment, 'compose', return_value=json.dumps(self.reader_identity)) as compose, \
                    patch.object(deployment.os, 'fchown') as ownership:
                deployment.prepare_historical_before_receipt(root, before)
            self.assertEqual(ownership.call_args.args[1:], (1000, 1000))
            self.assertEqual(before.stat().st_mode & 0o777, 0o400)
            self.assertEqual(root.stat().st_mode, parent_mode)
            self.assertEqual(compose.call_args.args[:8],
                (root, 'run', '--rm', '--no-deps', '--entrypoint', 'node', 'migrate', '-e'))

    def test_root_malformed_or_unexpected_reader_identity_cannot_change_the_private_receipt(self):
        invalid = [None, [], {'uid': 0, 'gid': 1000, 'user': 'node'},
            {'uid': 1000, 'gid': 0, 'user': 'node'}, {'uid': 1000, 'gid': 1000, 'user': 'root'},
            {'uid': True, 'gid': 1000, 'user': 'node'}, {'uid': '1000', 'gid': 1000, 'user': 'node'},
            {'uid': -1, 'gid': 1000, 'user': 'node'}, {'uid': 2147483648, 'gid': 1000, 'user': 'node'},
            {**self.reader_identity, 'unexpected': 'fixture-sensitive-value'}]
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            before = Path(name) / 'before-audit.json'; before.write_text('{}'); before.chmod(0o600)
            for identity in invalid:
                with self.subTest(identity=identity), \
                        patch.object(deployment, 'compose', return_value=json.dumps(identity)), \
                        patch.object(deployment.os, 'fchown') as ownership:
                    with self.assertRaisesRegex(RuntimeError, '^Historical audit reader identity unavailable$'):
                        deployment.prepare_historical_before_receipt(Path(name), before)
                    ownership.assert_not_called()
                    self.assertEqual(before.stat().st_mode & 0o777, 0o600)

    def test_shared_permissions_symlink_or_hardlink_receipt_cannot_be_reowned(self):
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            root = Path(name); original = root / 'before-audit.json'; original.write_text('{}')
            original.chmod(0o644)
            symlink_target = root / 'symlink-target-audit.json'
            symlink_target.write_text('{}'); symlink_target.chmod(0o600)
            link = root / 'linked-audit.json'; link.symlink_to(symlink_target.name)
            private = root / 'private-audit.json'; private.write_text('{}'); private.chmod(0o600)
            hardlink = root / 'hardlinked-audit.json'; deployment.os.link(private, hardlink)
            for receipt in (original, link, hardlink):
                with self.subTest(receipt=receipt.name), \
                        patch.object(deployment, 'compose', return_value=json.dumps(self.reader_identity)), \
                        patch.object(deployment.os, 'fchown') as ownership:
                    with self.assertRaisesRegex(RuntimeError, '^Historical before audit receipt'):
                        deployment.prepare_historical_before_receipt(root, receipt)
                    ownership.assert_not_called()

    def test_changed_report_count_stage_schema_baseline_or_policy_is_rejected(self):
        mutations = [lambda x: x.update(violationCount=11),
            lambda x: x['gate'].update(policyId='other'),
            lambda x: x['gate'].update(expectedCurrent='f' * 40),
            lambda x: x['gate'].update(stage='before'),
            lambda x: x['gate'].update(unavailableCheckCount=1),
            lambda x: x['gate'].update(accepted=False)]
        for mutate in mutations:
            report = self.report(); mutate(report)
            with self.subTest(report=report), self.assertRaisesRegex(RuntimeError, 'historical integrity gate failed'):
                self.audit(report)

class ReadOnlyReleaseProofTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        workflow = Path(__file__).resolve().parents[2] / '.github/workflows/production-release.yml'
        step = workflow.read_text().split('      - name: Read production release diagnostics\n', 1)[1]
        program = textwrap.dedent(step.split("program = r'''\n", 1)[1].split("\n          '''", 1)[0])
        cls.program = ast.parse(program)
        nodes = [node for node in cls.program.body if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef))
                 or (isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
                     and node.targets[0].id.startswith('PROOF_'))]
        cls.namespace = {}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(workflow), 'exec'), cls.namespace)

    def setUp(self):
        output = Path(__file__).resolve().parents[2] / '.runtime/recharge-registration-isolation-20261005'
        output.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=output)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.proof = self.namespace['fixed_release_proof']
        self.fingerprint = self.namespace['proof_fingerprint']
        self.states = {service: {'image': 'sha256:' + 'a' * 64, 'status': 'running', 'health': 'healthy'}
                       for service in self.namespace['PROOF_SERVICES']}
        self.manifest = {'commit': self.namespace['PROOF_CURRENT'],
            'previousCommit': self.namespace['PROOF_PREVIOUS'],
            'sourceTree': 'a329e268cf7afcb9967789dcb998e0177cad5ddf',
            'releaseTag': 'v2-production-20261005T050620Z',
            'deploymentRun': 'github-actions-37265858979-1',
            'imageBuildRun': 'github-actions-37265858979-1', 'ciWorkflowRunId': 37265801532,
            'images': {service: {'digest': state['image']} for service, state in self.states.items()},
            'privateFixture': 'SENTINEL_PRIVATE_TEXT'}
        self.reports = {}
        for stage in ('before', 'after'):
            gate = {'accepted': True, 'policyId': 'historical-finance-20261005-registration-continuation',
                'expectedCurrent': self.namespace['PROOF_PREVIOUS'], 'fixedCurrent': self.namespace['PROOF_PREVIOUS'],
                'stage': stage, 'checkCount': 48, 'executedCheckCount': 48,
                'unavailableCheckCount': 0, 'violationCount': 10,
                'metadataSha256': 'b' * 64, 'sources': {'fixture': 'c' * 64},
                'continuation': {'fixture': 'd' * 64}}
            self.reports[stage] = {'ok': False, 'checkCount': 48, 'violationCount': 10, 'gate': gate,
                'checks': [{'code': 'fixture_' + str(index), 'status': 'EXECUTED',
                            'count': 10 if index == 0 else 0} for index in range(48)],
                'privateFixture': 'SENTINEL_PRIVATE_TEXT'}
            self.manifest['dataAudit' + stage.title()] = {'checkCount': 48, 'violationCount': 10,
                                                       'historicalException': copy.deepcopy(gate)}
        original = self.namespace['PROOF_GATE_HASHES']
        self.namespace['PROOF_GATE_HASHES'] = tuple((stage, self.fingerprint(report['gate']))
                                                   for stage, report in self.reports.items())
        self.addCleanup(self.namespace.__setitem__, 'PROOF_GATE_HASHES', original)
        self.write_fixture()

    def write_fixture(self):
        for name, value in [('release-manifest.json', self.manifest),
                            *[(stage + '-audit.json', report) for stage, report in self.reports.items()]]:
            path = self.root / name
            path.write_text(json.dumps(value, indent=2))
            path.chmod(0o600)

    def assert_rejected(self):
        output = io.StringIO()
        with redirect_stdout(output), self.assertRaisesRegex(RuntimeError, '^Read-only fixed release proof unavailable$') as error:
            self.proof(self.root, self.manifest, self.states)
        self.assertEqual(output.getvalue(), '')
        self.assertNotIn('SENTINEL_PRIVATE_TEXT', str(error.exception))
        self.assertTrue(error.exception.__suppress_context__)

    def test_real_private_file_hashes_and_only_safe_compact_projection(self):
        (self.root / 'before-audit.json').chmod(0o400)
        result = self.proof(self.root, self.manifest, self.states)
        for field, name in [('manifestSha256', 'release-manifest.json'),
                            ('beforeReceiptSha256', 'before-audit.json'), ('afterReceiptSha256', 'after-audit.json')]:
            self.assertEqual(result[field], deployment.hashlib.sha256((self.root / name).read_bytes()).hexdigest())
        for stage in ('before', 'after'):
            self.assertEqual(result[stage + 'GateSha256'], self.fingerprint(self.reports[stage]['gate']))
        self.assertEqual(result['metadataSha256'], 'b' * 64)
        self.assertEqual(result['sourcesSha256'], self.fingerprint({'fixture': 'c' * 64}))
        self.assertEqual(result['continuationSha256'], self.fingerprint({'fixture': 'd' * 64}))
        serialized = json.dumps(result, separators=(',', ':'))
        self.assertNotIn('SENTINEL_PRIVATE_TEXT', serialized)
        self.assertNotIn('privateFixture', serialized)
        self.assertNotIn('fixture_0', serialized)
        self.assertLess(len(serialized.encode()), 4000)
        self.assertTrue(result['receiptsMatchManifest'] and result['sameManifest'] and result['runningImagesMatchManifest'])

    def test_public_permissions_symlink_hardlink_missing_and_oversized_receipts_reject(self):
        path = self.root / 'before-audit.json'
        original = path.read_bytes()
        for mode in (0o644, 0o660, 0o700):
            path.chmod(mode); self.assert_rejected()
        path.chmod(0o600)
        extra = self.root / 'private-original.json'
        extra.write_bytes(original); extra.chmod(0o600)
        path.unlink(); path.symlink_to(extra.name); self.assert_rejected()
        path.unlink(); deployment.os.link(extra, path); self.assert_rejected()
        path.unlink(); self.assert_rejected()
        path.write_bytes(b'x' * (8 * 1024 * 1024 + 1)); path.chmod(0o600); self.assert_rejected()

    def test_malformed_private_text_and_unknown_gate_text_never_escape(self):
        path = self.root / 'before-audit.json'
        path.write_text('SENTINEL_PRIVATE_TEXT'); self.assert_rejected()
        self.write_fixture()
        self.reports['before']['gate']['unknown'] = 'SENTINEL_PRIVATE_TEXT'
        self.manifest['dataAuditBefore']['historicalException'] = copy.deepcopy(self.reports['before']['gate'])
        self.write_fixture(); self.assert_rejected()

    def test_manifest_provenance_and_snapshot_mismatch_reject(self):
        original = copy.deepcopy(self.manifest)
        for field in ('commit', 'previousCommit', 'sourceTree', 'releaseTag',
                      'deploymentRun', 'imageBuildRun', 'ciWorkflowRunId'):
            with self.subTest(field=field):
                self.manifest = copy.deepcopy(original)
                self.manifest[field] = 'SENTINEL_PRIVATE_TEXT'
                self.write_fixture(); self.assert_rejected()
        self.manifest = copy.deepcopy(original); self.write_fixture()
        disk = {**self.manifest, 'changed': True}
        (self.root / 'release-manifest.json').write_text(json.dumps(disk))
        self.assert_rejected()

    def test_reports_must_match_manifest_and_all_48_checks_execute(self):
        original = copy.deepcopy(self.reports)
        mutations = [lambda report: report.update(ok=True), lambda report: report.update(violationCount=0),
            lambda report: report['gate'].update(accepted=False),
            lambda report: report['gate'].update(expectedCurrent='f' * 40),
            lambda report: report['gate'].update(policyId='other'),
            lambda report: report['checks'].pop(),
            lambda report: report['checks'][0].update(status='SCHEMA_NOT_DEPLOYED'),
            lambda report: report['checks'][0].update(count=True),
            lambda report: report['checks'][0].update(count=11),
            lambda report: report['checks'][0].update(code='fixture_1')]
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                self.reports = copy.deepcopy(original); mutate(self.reports['before'])
                self.write_fixture(); self.assert_rejected()

    def test_each_current_service_digest_and_healthy_state_required(self):
        for service in self.states:
            for field, value in [('image', 'sha256:' + 'f' * 64), ('status', 'exited'), ('health', 'unhealthy')]:
                with self.subTest(service=service, field=field):
                    original = self.states[service][field]
                    self.states[service][field] = value; self.assert_rejected()
                    self.states[service][field] = original
        self.states.pop('auto-registration'); self.assert_rejected()

    def test_manifest_changed_during_proof_read_rejects(self):
        original = self.namespace['proof_private_bytes']
        count = 0
        def changed(path):
            nonlocal count
            data = original(path)
            count += 1
            return data + b' ' if count == 4 else data
        with patch.dict(self.namespace, {'proof_private_bytes': changed}):
            self.assert_rejected()

    def test_fixed_baseline_alone_selects_early_compact_output(self):
        selector = next(node for node in self.program.body if isinstance(node, ast.If)
                        and isinstance(node.test, ast.Compare))
        test = compile(ast.Expression(selector.test), '<readonly-selector>', 'eval')
        self.assertTrue(eval(test, {**self.namespace, 'manifest': self.manifest}))
        self.assertFalse(eval(test, {**self.namespace, 'manifest': {'commit': 'f' * 40}}))
        self.assertTrue(any(isinstance(node, ast.Raise) for node in selector.body))

class ReadOnlyReleaseLockTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ReadOnlyReleaseProofTests.setUpClass()
        cls.program = ReadOnlyReleaseProofTests.program
        cls.namespace = dict(ReadOnlyReleaseProofTests.namespace)

    def setUp(self):
        output = Path(__file__).resolve().parents[2] / '.runtime/recharge-registration-isolation-20261005'
        output.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=output)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.lock = self.root / '.deploy.lock'
        self.lock.touch()
        self.proc = self.root / 'proc'
        self.proc.mkdir()
        self.pid = 12345
        self.process_directory = self.proc / str(self.pid)
        self.process_directory.mkdir()
        (self.proc / 'uptime').write_text('1000.00 400.00\n')
        (self.process_directory / 'cmdline').write_bytes(b'/usr/bin/python3\0-c\0SENTINEL_PRIVATE_SOURCE\0')
        self.write_stat()
        (self.proc / 'locks').write_text(self.lock_line())

    def write_stat(self, comm='python3', started=10000, state='S', parent=0):
        tail = [state, str(parent), *(['0'] * 17), str(started), '0']
        (self.process_directory / 'stat').write_text(f'{self.pid} ({comm}) ' + ' '.join(tail) + '\n')

    def lock_line(self, *, inode=None, pid=None, waiting=False):
        info = self.lock.stat()
        device = f'{deployment.os.major(info.st_dev):02x}:{deployment.os.minor(info.st_dev):02x}'
        return (f'1: {"-> " if waiting else ""}FLOCK ADVISORY WRITE {pid or self.pid} '
                f'{device}:{info.st_ino if inode is None else inode} 0 EOF\n')

    def summary(self):
        with patch.object(self.namespace['os'], 'sysconf', return_value=100):
            return self.namespace['release_lock_summary'](self.lock, self.proc)

    def assert_unknown(self):
        result = self.summary()
        self.assertEqual(result, {'status': 'NOT_MEASURED', 'holders': []})
        self.assertNotIn('SENTINEL', json.dumps(result))

    def test_holder_identity_and_elapsed_use_only_controlled_fields(self):
        self.assertEqual(self.summary(), {'status': 'HELD', 'holders': [{
            'kind': 'FLOCK', 'mode': 'WRITE', 'pid': self.pid, 'comm': 'python3',
            'state': 'S', 'elapsedSeconds': 900, 'script': 'PYTHON_INLINE', 'cwd': 'NOT_MEASURED',
            'commandUuid': None, 'parent': {'pid': None, 'comm': 'NOT_MEASURED', 'state': 'NOT_MEASURED'}}]})

    def test_stdin_owner_ssm_cwd_and_only_one_parent_are_closed(self):
        command = '12345678-1234-1234-1234-123456789abc'
        (self.process_directory / 'cmdline').write_bytes(b'python3\0-\0SENTINEL_PRIVATE_THIRD_ARG\0')
        cwd = self.process_directory / 'cwd'
        cwd.symlink_to('/var/lib/amazon/ssm/i-123456789abcdef01/document/orchestration/' + command
                       + '/awsrunShellScript/0.awsrunShellScript')
        data = (self.process_directory / 'stat').read_text().replace(') S 0 ', ') S 23456 ', 1)
        (self.process_directory / 'stat').write_text(data)
        parent = self.proc / '23456'
        parent.mkdir()
        (parent / 'stat').write_text('23456 (bash) S ' + ' '.join(['34567', *(['0'] * 17), '10000', '0']) + '\n')
        original_open = deployment.os.open
        paths = []
        def opened(path, flags, *args, **kwargs):
            paths.append(str(path))
            return original_open(path, flags, *args, **kwargs)
        with patch.object(deployment.os, 'open', side_effect=opened):
            holder = self.summary()['holders'][0]
        self.assertEqual(holder['script'], 'PYTHON_STDIN')
        self.assertEqual(holder['cwd'], 'SSM_ORCHESTRATION')
        self.assertEqual(holder['commandUuid'], command)
        self.assertEqual(holder['parent'], {'pid': 23456, 'comm': 'bash', 'state': 'S'})
        self.assertFalse(any('/34567/' in path for path in paths))
        self.assertNotIn('SENTINEL', json.dumps(holder))
        self.assertNotIn('/var/', json.dumps(holder))
        self.assertEqual(self.namespace['readonly_receipts'](json.dumps({'releaseLock': self.summary()}), False),
                         [{'releaseLock': self.summary()}])

    def test_reparented_holder_during_read_is_unmeasured(self):
        self.write_stat(parent=23456)
        parent = self.proc / '23456'
        parent.mkdir()
        (parent / 'stat').write_text('23456 (bash) S ' + ' '.join(['0', *(['0'] * 17), '10000', '0']) + '\n')
        original_open = deployment.os.open
        reads = 0
        def changed(path, flags, *args, **kwargs):
            nonlocal reads
            if Path(path) == self.process_directory / 'stat':
                reads += 1
                if reads == 2:
                    self.write_stat(parent=34567)
            return original_open(path, flags, *args, **kwargs)
        with patch.object(deployment.os, 'open', side_effect=changed):
            self.assert_unknown()
        self.assertEqual(reads, 2)

    def test_reused_parent_during_read_is_unmeasured_without_losing_holder(self):
        self.write_stat(parent=23456)
        parent = self.proc / '23456'
        parent.mkdir()
        path = parent / 'stat'
        path.write_text('23456 (bash) S ' + ' '.join(['0', *(['0'] * 17), '10000', '0']) + '\n')
        original_open = deployment.os.open
        reads = 0
        def changed(candidate, flags, *args, **kwargs):
            nonlocal reads
            if Path(candidate) == path:
                reads += 1
                if reads == 2:
                    path.write_text('23456 (bash) S ' + ' '.join(['0', *(['0'] * 17), '10001', '0']) + '\n')
            return original_open(candidate, flags, *args, **kwargs)
        with patch.object(deployment.os, 'open', side_effect=changed):
            result = self.summary()
        self.assertEqual(result['status'], 'HELD')
        self.assertEqual(result['holders'][0]['pid'], self.pid)
        self.assertEqual(result['holders'][0]['parent'], {'pid': None, 'comm': 'NOT_MEASURED', 'state': 'NOT_MEASURED'})
        self.assertEqual(reads, 2)

    def test_disappearing_parent_during_read_is_unmeasured_without_losing_holder(self):
        self.write_stat(parent=23456)
        parent = self.proc / '23456'
        parent.mkdir()
        path = parent / 'stat'
        path.write_text('23456 (bash) S ' + ' '.join(['0', *(['0'] * 17), '10000', '0']) + '\n')
        original_open = deployment.os.open
        reads = 0
        def changed(candidate, flags, *args, **kwargs):
            nonlocal reads
            if Path(candidate) == path:
                reads += 1
                if reads == 2:
                    path.unlink()
            return original_open(candidate, flags, *args, **kwargs)
        with patch.object(deployment.os, 'open', side_effect=changed):
            result = self.summary()
        self.assertEqual(result['status'], 'HELD')
        self.assertEqual(result['holders'][0]['pid'], self.pid)
        self.assertEqual(result['holders'][0]['parent'], {'pid': None, 'comm': 'NOT_MEASURED', 'state': 'NOT_MEASURED'})
        self.assertEqual(reads, 2)

    def test_cwd_parent_and_new_owner_unknown_text_never_escape(self):
        cwd = self.process_directory / 'cwd'
        for path, expected in (('/private/SENTINEL_PRIVATE_PATH', 'OTHER'),
                               ('/opt/id-business-v2/releases/SENTINEL_PRIVATE_PATH', 'PROJECT')):
            cwd.symlink_to(path)
            holder = self.summary()['holders'][0]
            self.assertEqual(holder['cwd'], expected)
            self.assertIsNone(holder['commandUuid'])
            self.assertNotIn('SENTINEL', json.dumps(holder))
            cwd.unlink()
        lock = {'releaseLock': self.summary()}
        for path, value in ((('cwd',), 'SENTINEL'), (('commandUuid',), 'SENTINEL'),
                            (('parent', 'comm'), 'SENTINEL'), (('parent', 'private'), 'SENTINEL')):
            bad = copy.deepcopy(lock)
            row = bad['releaseLock']['holders'][0]
            for key in path[:-1]:
                row = row[key]
            row[path[-1]] = value
            self.assertEqual(self.namespace['readonly_receipts'](json.dumps(bad), False),
                             [{'releaseLock': {'status': 'NOT_MEASURED', 'holders': []}}])

    def test_only_readonly_nofollow_nonblocking_opens_and_first_two_arguments_are_read(self):
        original_open, original_read = deployment.os.open, deployment.os.read
        opened, argument_bytes = [], bytearray()
        argument_descriptor = None
        def opened_file(path, flags, *args, **kwargs):
            nonlocal argument_descriptor
            opened.append(flags)
            descriptor = original_open(path, flags, *args, **kwargs)
            if Path(path).name == 'cmdline':
                argument_descriptor = descriptor
            return descriptor
        def read_file(descriptor, count):
            data = original_read(descriptor, count)
            if descriptor == argument_descriptor:
                argument_bytes.extend(data)
            return data
        with patch.object(deployment.os, 'open', side_effect=opened_file), \
                patch.object(deployment.os, 'read', side_effect=read_file):
            self.assertEqual(self.summary()['status'], 'HELD')
        self.assertEqual(set(opened), {deployment.os.O_RDONLY | deployment.os.O_NOFOLLOW | deployment.os.O_NONBLOCK})
        self.assertEqual(bytes(argument_bytes), b'/usr/bin/python3\0-c\0')

    def test_no_holder_or_different_inode_is_unlocked_and_waiter_is_not_an_owner(self):
        for content in ('', self.lock_line(inode=self.lock.stat().st_ino + 1)):
            with self.subTest(content=bool(content)):
                (self.proc / 'locks').write_text(content)
                self.assertEqual(self.summary(), {'status': 'UNLOCKED', 'holders': []})
        (self.proc / 'locks').write_text(self.lock_line() + self.lock_line(pid=23456, waiting=True))
        self.assertEqual([holder['pid'] for holder in self.summary()['holders']], [self.pid])

    def test_malicious_comm_and_arguments_never_escape_the_projection(self):
        self.write_stat(comm='SENTINEL_PRIVATE_COMM\nwith injected text')
        (self.process_directory / 'cmdline').write_bytes(b'SENTINEL_PRIVATE_ARG\0SECRET_SECOND_ARGUMENT\0')
        result = self.summary()
        self.assertEqual(result['status'], 'HELD')
        self.assertEqual(result['holders'][0]['comm'], 'OTHER')
        self.assertEqual(result['holders'][0]['script'], 'UNKNOWN')
        self.assertNotIn('SENTINEL', json.dumps(result))
        self.assertNotIn('SECRET', json.dumps(result))

    def test_only_the_exact_staged_remote_script_path_is_identified(self):
        staged = b'/opt/id-business-v2/.staging/oidc-' + b'a' * 40 + b'/remote-deploy.py'
        for path, expected in ((staged, 'REMOTE_DEPLOY'), (staged + b'.evil', 'UNKNOWN'),
                               (staged.replace(b'oidc-', b'SENTINEL-'), 'UNKNOWN'),
                               (b'/tmp/remote-deploy.py', 'UNKNOWN')):
            with self.subTest(expected=expected):
                (self.process_directory / 'cmdline').write_bytes(b'python3\0' + path + b'\0SENTINEL_PRIVATE_ARG\0')
                result = self.summary()
                self.assertEqual(result['holders'][0]['script'], expected)
                self.assertNotIn('SENTINEL', json.dumps(result))

    def test_missing_lock_or_proc_data_is_unknown_not_unlocked(self):
        for path in (self.lock, self.proc / 'locks', self.process_directory / 'stat',
                     self.process_directory / 'cmdline', self.proc / 'uptime'):
            with self.subTest(path=path.name):
                data = path.read_bytes()
                path.unlink()
                self.assert_unknown()
                path.write_bytes(data)
                (self.proc / 'locks').write_text(self.lock_line())

    def test_permission_error_is_unknown_and_does_not_print_exception_text(self):
        with patch.object(deployment.os, 'open', side_effect=PermissionError('SENTINEL_PRIVATE_ERROR')):
            output = io.StringIO()
            with redirect_stdout(output):
                self.assert_unknown()
            self.assertEqual(output.getvalue(), '')

    def test_symlink_hardlink_and_nonregular_lock_are_unknown(self):
        saved = self.root / 'saved-lock'
        self.lock.rename(saved)
        self.lock.symlink_to(saved)
        self.assert_unknown()
        self.lock.unlink()
        deployment.os.link(saved, self.lock)
        self.assert_unknown()
        self.lock.unlink()
        self.lock.mkdir()
        self.assert_unknown()

    def test_read_bounds_and_malformed_proc_data_are_unknown(self):
        for path, content in ((self.proc / 'locks', b' ' * (256 * 1024 + 1)),
                              (self.proc / 'locks', b'SENTINEL_PRIVATE_LOCK\n'),
                              (self.process_directory / 'stat', b'SENTINEL_PRIVATE_STAT'),
                              (self.proc / 'uptime', b'SENTINEL_PRIVATE_UPTIME')):
            with self.subTest(path=path.name, length=len(content)):
                original = path.read_bytes()
                path.write_bytes(content)
                self.assert_unknown()
                path.write_bytes(original)

    def test_lock_holder_changes_during_read_are_unknown(self):
        original_open = deployment.os.open
        count = 0
        def changed(path, flags, *args, **kwargs):
            nonlocal count
            if Path(path) == self.proc / 'locks':
                count += 1
                if count == 2:
                    (self.proc / 'locks').write_text('')
            return original_open(path, flags, *args, **kwargs)
        with patch.object(deployment.os, 'open', side_effect=changed):
            self.assert_unknown()

    def test_replaced_lock_inode_and_reused_process_are_unknown(self):
        original_open = deployment.os.open
        for change in ('inode', 'process'):
            count = 0
            def changed(path, flags, *args, **kwargs):
                nonlocal count
                if Path(path) == self.process_directory / 'stat':
                    count += 1
                    if count == 2:
                        if change == 'inode':
                            self.lock.rename(self.root / 'old-lock')
                            self.lock.touch()
                        else:
                            self.write_stat(started=10001)
                return original_open(path, flags, *args, **kwargs)
            with self.subTest(change=change), patch.object(deployment.os, 'open', side_effect=changed):
                self.assert_unknown()
            self.write_stat()
            (self.proc / 'locks').write_text(self.lock_line())

    def test_manifest_and_fixed_proof_failures_still_emit_real_lock_snapshot(self):
        selector = next(index for index, node in enumerate(self.program.body)
                        if isinstance(node, ast.If) and isinstance(node.test, ast.Compare))
        nodes = [node for node in self.program.body[:selector + 1]
                 if not isinstance(node, (ast.Import, ast.ImportFrom))]
        for manifest in ('SENTINEL_PRIVATE_MANIFEST', json.dumps({'commit': self.namespace['PROOF_CURRENT']})):
            current = self.root / 'current'
            current.mkdir(exist_ok=True)
            (current / 'release-manifest.json').write_text(manifest)
            def fixture_path(value):
                if value == '/proc':
                    return self.proc
                if value.startswith('/opt/id-business-v2'):
                    return self.root / value.removeprefix('/opt/id-business-v2').lstrip('/')
                return Path(value)
            def docker(*args, **kwargs):
                command = args[0]
                return SimpleNamespace(returncode=0, stdout='a' * 64 if 'compose' in command
                    else 'sha256:' + 'b' * 64 + ' running healthy')
            namespace = {**self.namespace, 'Path': fixture_path}
            output = io.StringIO()
            with self.subTest(fixed=manifest.startswith('{')), redirect_stdout(output), \
                    patch.object(deployment.os, 'sysconf', return_value=100), \
                    patch.object(self.namespace['subprocess'], 'run', side_effect=docker):
                with self.assertRaises(SystemExit):
                    exec(compile(ast.Module(body=nodes, type_ignores=[]), '<readonly-failure>', 'exec'), namespace)
            receipts = self.namespace['readonly_receipts'](output.getvalue(), False)
            self.assertEqual(receipts[0]['releaseLock']['status'], 'HELD')
            self.assertEqual(receipts[1], {'readOnlyFailure': 'FIXED_PROOF_UNAVAILABLE'
                             if manifest.startswith('{') else 'MANIFEST_UNAVAILABLE'})
            if manifest.startswith('{'):
                self.assertEqual(len(receipts), 3)
                detail = receipts[2]['fixedProofDiagnostic']
                self.assertFalse(detail['proofAccepted'])
                self.assertEqual(detail['currentCommit'], self.namespace['PROOF_CURRENT'])
                self.assertEqual(detail['receipts']['release-manifest.json']['fileStatus'], 'UNSAFE_MODE')
            else:
                self.assertEqual(len(receipts), 2)
            self.assertNotIn('SENTINEL', output.getvalue())

    def test_failed_stdout_filter_suppresses_unknown_text_and_extra_receipts(self):
        lock = {'releaseLock': self.summary()}
        output = json.dumps(lock) + '\n' + json.dumps({'secret': 'SENTINEL_PRIVATE_RECEIPT'})
        self.assertEqual(self.namespace['readonly_receipts'](output, False), [lock])
        for value in ('SENTINEL_PRIVATE_OUTPUT', json.dumps({'releaseLock': {'status': 'SENTINEL', 'holders': []}}),
                      json.dumps({'releaseLock': {'status': 'UNLOCKED', 'holders': [], 'secret': 'SENTINEL'}})):
            with self.subTest(length=len(value)):
                self.assertEqual(self.namespace['readonly_receipts'](value, False),
                    [{'releaseLock': {'status': 'NOT_MEASURED', 'holders': []}}])

    def test_success_filter_preserves_existing_proof_object_and_rejects_truncation(self):
        lock = {'releaseLock': self.summary()}
        diagnostics = {'currentCommit': self.namespace['PROOF_CURRENT'],
                       'safeProof': copy.deepcopy(self.namespace['PROOF_RECEIPT'])}
        output = json.dumps(lock) + '\n' + json.dumps(diagnostics)
        self.assertEqual(self.namespace['readonly_receipts'](output, True), [lock, diagnostics])
        with self.assertRaisesRegex(RuntimeError, '^Read-only diagnostic output unavailable$'):
            self.namespace['readonly_receipts'](output[:-1], True)

    def test_fixed_success_rejects_unknown_missing_false_wrong_hash_and_wrong_types(self):
        good = {'currentCommit': self.namespace['PROOF_CURRENT'],
                'safeProof': copy.deepcopy(self.namespace['PROOF_RECEIPT'])}
        candidates = []
        for path, value in ((('private',), 'SENTINEL_PRIVATE_TOP'),
                            (('safeProof', 'private'), 'SENTINEL_PRIVATE_PROOF'),
                            (('safeProof', 'manifest', 'private'), 'SENTINEL_PRIVATE_MANIFEST'),
                            (('safeProof', 'images', 'private'), 'SENTINEL_PRIVATE_IMAGE'),
                            (('safeProof', 'accepted'), False), (('safeProof', 'sameManifest'), 1),
                            (('safeProof', 'checkCount'), True), (('safeProof', 'checkCount'), '48'),
                            (('safeProof', 'manifest', 'ciWorkflowRunId'), str(37265801532))):
            bad = copy.deepcopy(good)
            target = bad
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            candidates.append(bad)
        for key in good['safeProof']:
            bad = copy.deepcopy(good)
            del bad['safeProof'][key]
            candidates.append(bad)
            if key.endswith('Sha256'):
                bad = copy.deepcopy(good)
                bad['safeProof'][key] = '0' * 64
                candidates.append(bad)
        candidates.extend(({'currentCommit': good['currentCommit']},
                           {'currentCommit': good['currentCommit'], 'safeProof': {}}))
        for bad in candidates:
            with self.subTest(keys=sorted(bad)):
                with self.assertRaisesRegex(RuntimeError, '^Read-only diagnostic output unavailable$'):
                    self.namespace['readonly_receipts'](json.dumps({'releaseLock': self.summary()})
                        + '\n' + json.dumps(bad), True)

    def generic_diagnostics(self):
        policy = 'historical-finance-20261005-recharge-diagnostics'
        value = {'currentCommit': 'a' * 40, 'sourceTree': 'b' * 40, 'previousCommit': self.namespace['PROOF_CURRENT'],
            'releaseTag': 'v2-production-20261005T120000Z', 'servicesUpdated': ['auto-recharge'], 'newMigrations': [],
            'backupBeforeRelease': 'id-business-v2-20261005T120000Z.sql.gz',
            'services': {service: {'image': 'sha256:' + 'c' * 64, 'status': 'running', 'health': 'healthy'}
                         for service in self.namespace['PROOF_SERVICES']}}
        for stage in ('before', 'after'):
            gate = {'accepted': True, 'status': 'APPROVED_HISTORICAL_EXCEPTIONS', 'policyId': policy, 'stage': stage,
                'expectedCurrent': self.namespace['PROOF_CURRENT'], 'fixedCurrent': self.namespace['PROOF_CURRENT'],
                'continuationOf': 'historical-finance-20261005', 'checkCount': 48, 'executedCheckCount': 48,
                'unavailableCheckCount': 0, 'violationCount': 10, 'gateSha256': 'd' * 64,
                'sourcesSha256': self.namespace['PROOF_RECEIPT']['sourcesSha256'],
                'metadataSha256': self.namespace['PROOF_RECEIPT']['metadataSha256'],
                'continuationSha256': self.namespace['PROOF_CONTINUATIONS'][policy]}
            value['dataAudit' + stage.title()] = {'checkCount': 48, 'executedCheckCount': 48,
                'unavailableCheckCount': 0, 'violationCount': 10, 'historicalException': gate}
        return value

    def test_generic_projection_is_closed_without_raw_audit_or_inventory(self):
        value = self.generic_diagnostics()
        lock = {'releaseLock': self.summary()}
        self.assertEqual(self.namespace['readonly_receipts'](json.dumps(lock) + '\n' + json.dumps(value), True),
                         [lock, value])
        changes = [(('private',), 'SENTINEL_PRIVATE'), (('newMigrations',), ['../../SENTINEL']),
                   (('newMigrations',), ['20261005120000_unapproved']),
                   (('servicesUpdated',), ['auto-registration']), (('previousCommit',), '0' * 40),
                   (('backupBeforeRelease',), '/private/SENTINEL.sql.gz'),
                   (('services', 'auto-registration', 'private'), 'SENTINEL'),
                   (('services', 'auto-registration', 'image'), 'SENTINEL'),
                   (('services', 'auto-registration', 'health'), 'SENTINEL'),
                   (('dataAuditBefore', 'ok'), False),
                   (('dataAuditBefore', 'historicalException', 'accepted'), False),
                   (('dataAuditBefore', 'historicalException', 'sources'), {'private': 'SENTINEL'}),
                   (('dataAuditBefore', 'historicalException', 'metadataSha256'), '0' * 64),
                   (('dataAuditBefore', 'historicalException', 'expectedCurrent'), '0' * 40)]
        for path, item in changes:
            bad = copy.deepcopy(value)
            target = bad
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = item
            with self.subTest(path=path), self.assertRaisesRegex(RuntimeError, '^Read-only diagnostic output unavailable$'):
                self.namespace['readonly_receipts'](json.dumps(lock) + '\n' + json.dumps(bad), True)

    def test_raw_generic_audit_projection_hashes_private_data_without_emitting_it(self):
        raw = self.generic_diagnostics()
        sources = {'fixture': 'SENTINEL_PRIVATE_SOURCE'}
        continuation = {'fixture': 'SENTINEL_PRIVATE_CONTINUATION'}
        fingerprint = self.namespace['proof_fingerprint']
        pins = {**self.namespace['PROOF_RECEIPT'], 'sourcesSha256': fingerprint(sources)}
        continuations = {**self.namespace['PROOF_CONTINUATIONS'],
            'historical-finance-20261005-recharge-diagnostics': fingerprint(continuation)}
        for stage in ('before', 'after'):
            audit = raw['dataAudit' + stage.title()]
            gate = audit['historicalException']
            for key in ('gateSha256', 'sourcesSha256', 'continuationSha256'):
                del gate[key]
            gate.update(sources=sources, continuation=continuation, private='SENTINEL_PRIVATE_GATE')
            raw['dataAudit' + stage.title()] = {'checkCount': 48, 'violationCount': 10, 'historicalException': gate}
        raw['privateInventory'] = 'SENTINEL_PRIVATE_INVENTORY'
        function = self.namespace['project_readonly_diagnostics']
        with patch.dict(function.__globals__, {'PROOF_RECEIPT': pins, 'PROOF_CONTINUATIONS': continuations}):
            projected = function(raw, False)
            self.assertEqual(function(projected), projected)
        self.assertNotIn('SENTINEL', json.dumps(projected))
        self.assertNotIn('ok', projected['dataAuditBefore'])

    def test_only_exact_controlled_second_failure_receipt_is_returned(self):
        lock = {'releaseLock': self.summary()}
        for reason in self.namespace['PROOF_FAILURES']:
            failure = {'readOnlyFailure': reason}
            self.assertEqual(self.namespace['readonly_receipts'](json.dumps(lock) + '\n' + json.dumps(failure), False),
                             [lock, failure])
        for failure in ({'readOnlyFailure': 'SENTINEL'}, {'readOnlyFailure': 'MANIFEST_UNAVAILABLE', 'raw': 'SENTINEL'}):
            self.assertEqual(self.namespace['readonly_receipts'](json.dumps(lock) + '\n' + json.dumps(failure), False), [lock])

    def test_docker_failure_and_timeout_emit_only_controlled_enum(self):
        for result in (SimpleNamespace(returncode=1, stdout='SENTINEL_PRIVATE_DOCKER'),
                       TimeoutError('SENTINEL_PRIVATE_TIMEOUT')):
            output = io.StringIO()
            options = {'side_effect': result} if isinstance(result, Exception) else {'return_value': result}
            with self.subTest(timeout=isinstance(result, Exception)), redirect_stdout(output), \
                    patch.object(self.namespace['subprocess'], 'run', **options):
                with self.assertRaisesRegex(RuntimeError, '^Read-only Docker diagnostic failed$'):
                    self.namespace['read']('docker', 'ps')
            self.assertEqual(json.loads(output.getvalue()), {'readOnlyFailure': 'DOCKER_DIAGNOSTIC_FAILED'})
            self.assertNotIn('SENTINEL', output.getvalue())

    def test_image_inventory_bound_emits_controlled_enum_without_image_text(self):
        limit = next(node for node in self.program.body if isinstance(node, ast.If)
            and isinstance(node.test, ast.Compare) and isinstance(node.test.left, ast.Call)
            and isinstance(node.test.left.args[0], ast.Name) and node.test.left.args[0].id == 'image_ids')
        output = io.StringIO()
        with redirect_stdout(output), self.assertRaisesRegex(RuntimeError, '^Read-only image inventory exceeds bound$'):
            exec(compile(ast.Module(body=[limit], type_ignores=[]), '<inventory-bound>', 'exec'),
                 {**self.namespace, 'image_ids': ['SENTINEL_PRIVATE_IMAGE'] * 501})
        self.assertEqual(json.loads(output.getvalue()), {'readOnlyFailure': 'IMAGE_INVENTORY_BOUND'})
        self.assertNotIn('SENTINEL', output.getvalue())

    def test_real_workflow_wait_failure_returns_only_lock_and_existing_redacted_summary(self):
        project = Path(__file__).resolve().parents[2]
        workflow = project / '.github/workflows/production-release.yml'
        step = workflow.read_text().split('      - name: Read production release diagnostics\n', 1)[1]
        shell = textwrap.dedent(step.split('        run: |\n', 1)[1].split('\n      - name:', 1)[0])
        executable_directory = self.root / 'bin'
        executable_directory.mkdir()
        lock = {'releaseLock': self.summary()}
        output_path = self.root / 'fake-stdout.jsonl'
        output_path.write_text(json.dumps(lock) + '\n' + json.dumps({'secret': 'SENTINEL_PRIVATE_STDOUT'}) + '\n')
        result_path = self.root / 'fake-invocation.json'
        result_path.write_text(json.dumps({'Status': 'Failed', 'ResponseCode': 1,
            'StandardErrorContent': 'BlockingIOError: Resource temporarily unavailable SENTINEL_PRIVATE_STDERR'}))
        aws = executable_directory / 'aws'
        aws.write_text('#!/bin/sh\ncase "$1 $2" in\n'
            '  "ssm send-command") echo "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" ;;\n'
            '  "ssm wait") exit 1 ;;\n'
            '  "ssm get-command-invocation") case "$*" in\n'
            '    *StandardOutputContent*) cat ' + shlex.quote(str(output_path)) + ' ;;\n'
            '    *) cat ' + shlex.quote(str(result_path)) + ' ;; esac ;;\n'
            '  *) exit 99 ;;\nesac\n')
        python = executable_directory / 'python3'
        python.write_text('#!/bin/sh\nif [ "$1" = "scripts/production-release/remote-deploy.py" ]; then\n'
            '  shift\n  exec ' + shlex.quote(deployment.sys.executable) + ' '
            + shlex.quote(str(project / 'scripts/production-release/remote-deploy.py')) + ' "$@"\nfi\n'
            'exec ' + shlex.quote(deployment.sys.executable) + ' "$@"\n')
        aws.chmod(0o700)
        python.chmod(0o700)
        result = deployment.subprocess.run(['bash', '-c', shell], cwd=self.root,
            env={'PATH': str(executable_directory) + ':/bin:/usr/bin', 'PRODUCTION_INSTANCE_ID': 'i-fixture'},
            capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 1, result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual(json.loads(lines[0]), lock)
        summary = json.loads(lines[1].removeprefix('RELEASE_FAILURE_DIAGNOSTIC '))
        self.assertEqual(summary['errorType'], 'BlockingIOError')
        self.assertEqual(summary['reason'], 'Resource temporarily unavailable')
        self.assertNotIn('SENTINEL', result.stdout + result.stderr)
        self.assertFalse((self.root / '.deploy/production-release/readonly-diagnostics-result.json').exists())
        detail = self.namespace['fixed_proof_diagnostic'](self.root / 'missing-current',
            {'commit': self.namespace['PROOF_CURRENT']}, {})
        failure = {'readOnlyFailure': 'FIXED_PROOF_UNAVAILABLE'}
        envelope = {'fixedProofDiagnostic': detail}
        output_path.write_text('\n'.join(json.dumps(item) for item in (lock, failure, envelope))
            + '\nSENTINEL_PRIVATE_TRAILING_OUTPUT\n')
        failed_proof = deployment.subprocess.run(['bash', '-c', shell], cwd=self.root,
            env={'PATH': str(executable_directory) + ':/bin:/usr/bin', 'PRODUCTION_INSTANCE_ID': 'i-fixture'},
            capture_output=True, text=True, timeout=30)
        self.assertEqual(failed_proof.returncode, 1, failed_proof.stderr)
        proof_lines = failed_proof.stdout.splitlines()
        self.assertEqual([json.loads(line) for line in proof_lines[:3]], [lock, failure, envelope])
        self.assertFalse(json.loads(proof_lines[2])['fixedProofDiagnostic']['proofAccepted'])
        self.assertEqual(json.loads(proof_lines[3].removeprefix('RELEASE_FAILURE_DIAGNOSTIC '))['errorType'],
                         'BlockingIOError')
        self.assertNotIn('SENTINEL', failed_proof.stdout + failed_proof.stderr)
        self.assertLess(len(failed_proof.stdout.encode()), 24000)
        output_path.write_text(json.dumps(lock) + '\n' + json.dumps({'secret': 'SENTINEL_PRIVATE_STDOUT'}) + '\n')
        aws.write_text(aws.read_text().replace('"ssm wait") exit 1 ;;', '"ssm wait") exit 0 ;;'))
        rejected = deployment.subprocess.run(['bash', '-c', shell], cwd=self.root,
            env={'PATH': str(executable_directory) + ':/bin:/usr/bin', 'PRODUCTION_INSTANCE_ID': 'i-fixture'},
            capture_output=True, text=True, timeout=30)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertEqual(rejected.stdout.splitlines(), [json.dumps(lock, separators=(',', ':'))])
        self.assertIn('Read-only diagnostic output unavailable', rejected.stderr)
        self.assertNotIn('SENTINEL', rejected.stdout + rejected.stderr)
        diagnostics = {'currentCommit': self.namespace['PROOF_CURRENT'],
                       'safeProof': copy.deepcopy(self.namespace['PROOF_RECEIPT'])}
        output_path.write_text(json.dumps(lock) + '\n' + json.dumps(diagnostics) + '\n')
        accepted = deployment.subprocess.run(['bash', '-c', shell], cwd=self.root,
            env={'PATH': str(executable_directory) + ':/bin:/usr/bin', 'PRODUCTION_INSTANCE_ID': 'i-fixture'},
            capture_output=True, text=True, timeout=30)
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        self.assertEqual([json.loads(line) for line in accepted.stdout.splitlines()], [lock, diagnostics])
        side = {'fixedIsolationDiagnostic': self.namespace['fixed_isolation_diagnostic'](
            self.root / 'missing-current', {'images': {}}, None)}
        output_path.write_text('\n'.join(json.dumps(item) for item in (lock, diagnostics, side)) + '\n')
        accepted_side = deployment.subprocess.run(['bash', '-c', shell], cwd=self.root,
            env={'PATH': str(executable_directory) + ':/bin:/usr/bin', 'PRODUCTION_INSTANCE_ID': 'i-fixture'},
            capture_output=True, text=True, timeout=30)
        self.assertEqual(accepted_side.returncode, 0, accepted_side.stderr)
        self.assertEqual([json.loads(line) for line in accepted_side.stdout.splitlines()], [lock, diagnostics, side])
        side['fixedIsolationDiagnostic']['private'] = 'SENTINEL_PRIVATE_ISOLATION'
        output_path.write_text('\n'.join(json.dumps(item) for item in (lock, diagnostics, side)) + '\n')
        rejected_side = deployment.subprocess.run(['bash', '-c', shell], cwd=self.root,
            env={'PATH': str(executable_directory) + ':/bin:/usr/bin', 'PRODUCTION_INSTANCE_ID': 'i-fixture'},
            capture_output=True, text=True, timeout=30)
        self.assertNotEqual(rejected_side.returncode, 0)
        self.assertEqual(rejected_side.stdout.splitlines(), [json.dumps(lock, separators=(',', ':'))])
        self.assertNotIn('SENTINEL', rejected_side.stdout + rejected_side.stderr)


class ReadOnlyFixedProofDiagnosticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ReadOnlyReleaseProofTests.setUpClass()
        cls.namespace = dict(ReadOnlyReleaseProofTests.namespace)

    def setUp(self):
        output = Path(__file__).resolve().parents[2] / '.runtime/recharge-registration-isolation-20261005'
        output.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=output)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.diagnostic = self.namespace['fixed_proof_diagnostic']
        self.manifest = copy.deepcopy(self.namespace['PROOF_RECEIPT']['manifest'])
        self.manifest['private'] = 'SENTINEL_PRIVATE_MANIFEST'
        self.files = {}
        gates = []
        for stage in ('before', 'after'):
            gate = {'stage': stage, 'checkCount': 48, 'executedCheckCount': 48,
                    'unavailableCheckCount': 0, 'violationCount': 10}
            report = {'ok': False, 'checkCount': 48, 'violationCount': 10, 'gate': gate,
                'checks': [{'code': f'fixture-{index}', 'status': 'EXECUTED', 'count': 10 if index == 0 else 0}
                           for index in range(48)], 'private': 'SENTINEL_PRIVATE_AUDIT'}
            self.files[stage + '-audit.json'] = report
            self.manifest['dataAudit' + stage.title()] = {'checkCount': 48, 'violationCount': 10,
                                                        'historicalException': gate}
            gates.append((stage, self.namespace['proof_fingerprint'](gate)))
        self.files['release-manifest.json'] = self.manifest
        pins = copy.deepcopy(self.namespace['PROOF_RECEIPT'])
        for name, value in self.files.items():
            path = self.root / name
            path.write_text(json.dumps(value))
            path.chmod(0o600)
            key = {'release-manifest.json': 'manifestSha256', 'before-audit.json': 'beforeReceiptSha256',
                   'after-audit.json': 'afterReceiptSha256'}[name]
            pins[key] = deployment.hashlib.sha256(path.read_bytes()).hexdigest()
        self.patcher = patch.dict(self.diagnostic.__globals__, {'PROOF_RECEIPT': pins, 'PROOF_GATE_HASHES': tuple(gates)})
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.states = {service: {'image': image, 'status': 'running', 'health': 'healthy'}
                       for service, image in pins['images'].items()}

    def summary(self):
        result = self.diagnostic(self.root, self.manifest, self.states)
        self.assertNotIn('SENTINEL', json.dumps(result))
        self.assertIs(result['proofAccepted'], False)
        self.assertEqual(self.namespace['closed_fixed_proof_diagnostic'](result), result)
        return result

    def test_matching_receipts_are_diagnostic_only_without_acceptance(self):
        result = self.summary()
        self.assertTrue(result['provenanceMatched'])
        self.assertEqual(result['currentCommit'], self.namespace['PROOF_CURRENT'])
        for row in result['receipts'].values():
            self.assertEqual(row['fileStatus'], 'READABLE')
            self.assertTrue(row['readable'])
            self.assertTrue(row['rawHashMatched'])
            self.assertTrue(row['gateHashMatched'])
            self.assertTrue(row['countersMatched'])

    def test_file_metadata_statuses_do_not_read_rejected_body(self):
        path = self.root / 'before-audit.json'
        original = path.read_bytes()
        for status in ('MISSING', 'SYMLINK', 'NOT_REGULAR', 'HARDLINK', 'UNSAFE_MODE', 'OVERSIZED'):
            with self.subTest(status=status):
                path.unlink()
                other = self.root / 'other'
                if status == 'SYMLINK':
                    other.write_bytes(original)
                    path.symlink_to(other)
                elif status == 'NOT_REGULAR':
                    path.mkdir()
                elif status != 'MISSING':
                    path.write_bytes(original)
                    path.chmod(0o644 if status == 'UNSAFE_MODE' else 0o600)
                    if status == 'HARDLINK':
                        deployment.os.link(path, other)
                    elif status == 'OVERSIZED':
                        with path.open('r+b') as source:
                            source.truncate(8 * 1024 * 1024 + 1)
                reader = self.diagnostic.__globals__['proof_private_bytes']
                reads = []
                def observed(candidate):
                    reads.append(candidate)
                    return reader(candidate)
                with patch.dict(self.diagnostic.__globals__, {'proof_private_bytes': observed}):
                    row = self.summary()['receipts']['before-audit.json']
                self.assertEqual(row['fileStatus'], status)
                self.assertFalse(row['readable'])
                self.assertIsNone(row['actualSha256'])
                self.assertNotIn(path, reads)
                if path.is_dir():
                    path.rmdir()
                elif path.exists() or path.is_symlink():
                    path.unlink()
                if other.exists():
                    other.unlink()
                path.write_bytes(original)
                path.chmod(0o600)

    def test_permission_failure_and_changed_read_remain_unmeasured(self):
        reader = self.diagnostic.__globals__['proof_private_bytes']
        path = self.root / 'before-audit.json'
        def denied(candidate):
            if candidate == path:
                raise PermissionError('SENTINEL_PRIVATE_PERMISSION')
            return reader(candidate)
        with patch.dict(self.diagnostic.__globals__, {'proof_private_bytes': denied}):
            row = self.summary()['receipts'][path.name]
            self.assertEqual(row['fileStatus'], 'NOT_MEASURED')
            self.assertFalse(row['readable'])
        def changed(candidate):
            raw = reader(candidate)
            if candidate == path:
                with candidate.open('ab') as source:
                    source.write(b' ')
            return raw
        with patch.dict(self.diagnostic.__globals__, {'proof_private_bytes': changed}):
            row = self.summary()['receipts'][path.name]
            self.assertEqual(row['fileStatus'], 'CHANGED_DURING_READ')
            self.assertFalse(row['readable'])
            self.assertIsNone(row['rawHashMatched'])

    def test_hash_gate_and_counter_failures_are_distinct_without_financial_values(self):
        path = self.root / 'before-audit.json'
        value = copy.deepcopy(self.files[path.name])
        value['checks'][0]['count'] = 11
        path.write_text(json.dumps(value))
        row = self.summary()['receipts'][path.name]
        self.assertFalse(row['rawHashMatched'])
        self.assertTrue(row['gateHashMatched'])
        self.assertFalse(row['countersMatched'])
        value['gate']['stage'] = 'SENTINEL_PRIVATE_STAGE'
        path.write_text(json.dumps(value))
        row = self.summary()['receipts'][path.name]
        self.assertFalse(row['gateHashMatched'])
        path.write_text('SENTINEL_PRIVATE_BAD_JSON')
        row = self.summary()['receipts'][path.name]
        self.assertEqual(row['fileStatus'], 'READABLE')
        self.assertFalse(row['gateHashMatched'])
        self.assertFalse(row['countersMatched'])

    def test_service_missing_or_unknown_values_are_not_filled_with_health(self):
        self.states['api'] = {'image': 'SENTINEL_PRIVATE_IMAGE', 'status': 'SENTINEL', 'health': None}
        del self.states['admin']
        result = self.summary()
        for service in ('api', 'admin'):
            self.assertEqual(result['services'][service], {'image': None, 'status': 'NOT_MEASURED', 'health': 'NOT_MEASURED'})

    def test_failed_third_receipt_is_closed_and_never_accepted_on_success(self):
        lock = {'releaseLock': {'status': 'NOT_MEASURED', 'holders': []}}
        failure = {'readOnlyFailure': 'FIXED_PROOF_UNAVAILABLE'}
        detail = {'fixedProofDiagnostic': self.summary()}
        wire = '\n'.join(json.dumps(item) for item in (lock, failure, detail))
        self.assertEqual(self.namespace['readonly_receipts'](wire, False), [lock, failure, detail])
        with self.assertRaisesRegex(RuntimeError, '^Read-only diagnostic output unavailable$'):
            self.namespace['readonly_receipts'](wire, True)
        for path, value in ((('private',), 'SENTINEL'), (('proofAccepted',), True),
                            (('currentCommit',), 'SENTINEL'), (('provenanceMatched',), 1),
                            (('services', 'api', 'image'), 'SENTINEL'),
                            (('receipts', 'before-audit.json', 'fileStatus'), 'SENTINEL'),
                            (('receipts', 'before-audit.json', 'private'), 'SENTINEL'),
                            (('receipts', 'before-audit.json', 'actualSha256'), 'SENTINEL'),
                            (('receipts', 'before-audit.json', 'rawHashMatched'), 1)):
            bad = copy.deepcopy(detail)
            target = bad['fixedProofDiagnostic']
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            with self.subTest(path=path):
                receipts = self.namespace['readonly_receipts']('\n'.join(json.dumps(item) for item in (lock, failure, bad)), False)
                self.assertEqual(receipts, [lock, failure])


class ReadOnlyFixedIsolationDiagnosticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ReadOnlyReleaseProofTests.setUpClass()
        cls.namespace = dict(ReadOnlyReleaseProofTests.namespace)

    def setUp(self):
        output = Path(__file__).resolve().parents[2] / '.runtime/recharge-registration-isolation-20261005'
        output.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=output)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.diagnostic = self.namespace['fixed_isolation_diagnostic']
        self.compose = self.root / 'docker-compose.aws-mysql.yml'
        self.compose.write_text('services:\n' + ''.join('  ' + service + ':\n'
            for service in self.namespace['PROOF_ISOLATION_SERVICES']))
        self.compose.chmod(0o644)
        self.path = self.root / 'compose.release.json'
        self.manifest = {'commit': self.namespace['PROOF_CURRENT'], 'images': {
            service: {'reference': 'SENTINEL_PRIVATE_REFERENCE_' + service}
            for service in self.namespace['PROOF_ISOLATION_SERVICES']}}
        self.override = {'services': {service: {'image': image['reference'], 'pull_policy': 'never'}
            for service, image in self.manifest['images'].items()}}
        self.write_override()
        self.lock = {'releaseLock': {'status': 'NOT_MEASURED', 'holders': []}}
        self.proof = {'currentCommit': self.namespace['PROOF_CURRENT'],
                      'safeProof': copy.deepcopy(self.namespace['PROOF_RECEIPT'])}

    def write_override(self):
        self.path.write_text(json.dumps(self.override, indent=2) + '\n')
        self.path.chmod(0o644)

    def generated_readonly_command(self):
        workflow = Path(__file__).resolve().parents[2] / '.github/workflows/production-release.yml'
        step = workflow.read_text().split('      - name: Read production release diagnostics\n', 1)[1]
        shell = textwrap.dedent(step.split('        run: |\n', 1)[1].split('\n      - name:', 1)[0])
        builder = shell.split("python3 - <<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
        destination = self.root / '.deploy/production-release'
        destination.mkdir(parents=True, exist_ok=True)
        result = deployment.subprocess.run([deployment.sys.executable, '-c', builder], cwd=self.root,
            capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, 'Read-only command builder failed')
        self.assertEqual(result.stdout + result.stderr, '')
        parameters = json.loads((destination / 'readonly-diagnostics.json').read_text())
        command = shlex.split(parameters['commands'][0])
        self.assertEqual(command[:2], ['python3', '-c'])
        self.assertEqual(len(command), 3)
        return builder, parameters, command[2], destination / 'readonly-diagnostics-filter.py'

    def test_real_generated_compressed_command_decodes_exact_trusted_program_and_is_bounded(self):
        builder, parameters, decoder, _filter = self.generated_readonly_command()
        program = next(ast.literal_eval(node.value) for node in ast.parse(builder).body
            if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'program'
                for target in node.targets))
        payload = next(ast.literal_eval(node.args[0]) for node in ast.walk(ast.parse(decoder))
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'b64decode')
        decoded = gzip.decompress(base64.b64decode(payload, validate=True))
        self.assertEqual(decoded, program.encode('utf-8'))
        self.assertEqual(parameters['executionTimeout'], ['120'])
        self.assertLessEqual(len(json.dumps(parameters).encode('utf-8')), 20 * 1024)
        self.assertLess(len(json.dumps(parameters).encode('utf-8')), len(program.encode('utf-8')))
        compile(decoded, '<decoded-trusted-program>', 'exec')

    def test_actual_compressed_producer_and_generated_filter_suppress_sensitive_failed_manifest(self):
        _builder, _parameters, decoder, filter_path = self.generated_readonly_command()
        current = self.root / 'current'; current.mkdir()
        (current / 'release-manifest.json').write_text('SENTINEL_PRIVATE_MANIFEST_CONTENT')
        real_path = Path
        def fixture_path(value):
            if value == '/opt/id-business-v2':
                return self.root
            if value == '/opt/id-business-v2/.deploy.lock':
                return self.root / 'missing-lock'
            if value == '/proc':
                return self.root / 'synthetic-proc'
            return real_path(value)
        output = io.StringIO()
        with patch('pathlib.Path', side_effect=fixture_path), redirect_stdout(output):
            with self.assertRaises(SystemExit) as stopped:
                exec(compile(decoder, '<generated-readonly-decoder>', 'exec'), {})
        self.assertEqual(str(stopped.exception), 'Read-only manifest unavailable')
        expected = [self.lock, {'readOnlyFailure': 'MANIFEST_UNAVAILABLE'}]
        self.assertEqual([json.loads(line) for line in output.getvalue().splitlines()], expected)
        self.assertNotIn('SENTINEL', output.getvalue())
        filtered = deployment.subprocess.run([deployment.sys.executable, str(filter_path), '1'],
            input=output.getvalue() + 'SENTINEL_PRIVATE_UNKNOWN_TRAILING_OUTPUT\n',
            capture_output=True, text=True, timeout=30)
        self.assertEqual(filtered.returncode, 0)
        self.assertEqual([json.loads(line) for line in filtered.stdout.splitlines()], expected)
        self.assertNotIn('SENTINEL', filtered.stdout + filtered.stderr)

    def test_actual_builder_rejects_oversized_parameters_before_writing_payload(self):
        builder, _parameters, _decoder, _filter = self.generated_readonly_command()
        destination = self.root / 'oversized'
        destination.mkdir()
        def fixture_path(value):
            return destination / Path(value).name
        namespace = {}
        nodes = [node for node in ast.parse(builder).body if not isinstance(node, ast.ImportFrom)]
        output = io.StringIO()
        with patch.object(gzip, 'compress', return_value=b'x' * (20 * 1024)), redirect_stdout(output):
            with self.assertRaisesRegex(SystemExit, '^Read-only command exceeds transfer bound$'):
                exec(compile(ast.Module(body=nodes, type_ignores=[]), '<oversized-readonly-builder>', 'exec'),
                    {'Path': fixture_path, **namespace})
        self.assertEqual(output.getvalue(), '')
        self.assertFalse((destination / 'readonly-diagnostics.json').exists())

    def summary(self, response=None):
        response = response or SimpleNamespace(returncode=0,
            stdout=self.manifest['images']['auto-registration']['reference'] + '\n')
        with patch.object(self.namespace['subprocess'], 'run', return_value=response) as command:
            result = self.diagnostic(self.root, self.manifest, 'a' * 64)
        self.assertEqual(command.call_args.args[0], ('docker', 'inspect', '--format', '{{.Config.Image}}', 'a' * 64))
        self.assertEqual(self.namespace['closed_fixed_isolation_diagnostic'](result), result)
        self.assertNotIn('SENTINEL', json.dumps(result))
        return result

    def test_config_644_reads_real_hashes_and_only_boolean_reference(self):
        result = self.summary()
        self.assertEqual(result['runtimeCompose'], {'fileStatus': 'READABLE',
            'sha256': deployment.hashlib.sha256(self.compose.read_bytes()).hexdigest(),
            'pinMatched': False, 'registrationDeclared': True})
        self.assertEqual(result['override'], {'fileStatus': 'READABLE',
            'rawSha256': deployment.hashlib.sha256(self.path.read_bytes()).hexdigest(),
            'canonicalSha256': self.namespace['proof_fingerprint'](self.override),
            'topLevelExact': True, 'topLevelKeyCount': 1, 'servicesExact': True, 'serviceCount': 6})
        self.assertTrue(result['registrationReferenceMatched'])
        self.assertTrue(all(row == {'present': True, 'declared': True, 'imageMatched': True,
            'pullPolicyMatched': True, 'extraFieldCount': 0, 'extraKnownKeys': [],
            'roleOverrideStatus': 'ABSENT' if service in ('auto-recharge', 'auto-registration') else None}
            for service, row in result['services'].items()))
        self.path.write_text(json.dumps(self.override, sort_keys=True))
        reordered = self.summary()['override']
        self.assertNotEqual(reordered['rawSha256'], result['override']['rawSha256'])
        self.assertEqual(reordered['canonicalSha256'], result['override']['canonicalSha256'])
        with self.assertRaisesRegex(RuntimeError, '^Read-only fixed release proof unavailable$'):
            self.namespace['proof_private_bytes'](self.path)

    def test_top_service_extra_and_reference_differences_never_print_values_or_unknown_names(self):
        self.override['SENTINEL_PRIVATE_TOP_KEY'] = {'value': 'SENTINEL_PRIVATE_TOP_VALUE'}
        registration = self.override['services']['auto-registration']
        registration.update(environment={'SECRET': 'SENTINEL_PRIVATE_ENV'},
            labels={'secret': 'SENTINEL_PRIVATE_LABEL'}, volumes=['SENTINEL_PRIVATE_VOLUME'],
            SENTINEL_PRIVATE_UNKNOWN_KEY='SENTINEL_PRIVATE_UNKNOWN_VALUE', image='SENTINEL_PRIVATE_DIFFERENT_REF')
        registration['pull_policy'] = 'always'
        self.override['services']['SENTINEL_PRIVATE_UNKNOWN_SERVICE'] = {'secret': 'SENTINEL_PRIVATE_VALUE'}
        self.write_override()
        result = self.summary(SimpleNamespace(returncode=0, stdout='SENTINEL_PRIVATE_ACTUAL_REF\n'))
        self.assertFalse(result['override']['topLevelExact'])
        self.assertEqual(result['override']['topLevelKeyCount'], 2)
        self.assertFalse(result['override']['servicesExact'])
        self.assertEqual(result['override']['serviceCount'], 7)
        row = result['services']['auto-registration']
        self.assertEqual(row['extraFieldCount'], 4)
        self.assertEqual(row['extraKnownKeys'], ['environment', 'labels', 'volumes'])
        self.assertFalse(row['imageMatched'])
        self.assertFalse(row['pullPolicyMatched'])
        self.assertFalse(result['registrationReferenceMatched'])

    def test_safe_config_metadata_rejections_never_open_body(self):
        original = self.path.read_bytes()
        original_open = deployment.os.open
        for status in ('MISSING', 'SYMLINK', 'NOT_REGULAR', 'HARDLINK', 'UNSAFE_MODE', 'OVERSIZED'):
            with self.subTest(status=status):
                self.path.unlink()
                other = self.root / 'other'
                if status == 'SYMLINK':
                    other.write_bytes(original); self.path.symlink_to(other)
                elif status == 'NOT_REGULAR':
                    self.path.mkdir()
                elif status != 'MISSING':
                    self.path.write_bytes(original); self.path.chmod(0o666 if status == 'UNSAFE_MODE' else 0o644)
                    if status == 'HARDLINK':
                        deployment.os.link(self.path, other)
                    elif status == 'OVERSIZED':
                        with self.path.open('r+b') as source:
                            source.truncate(8 * 1024 * 1024 + 1)
                opened = []
                def observed(path, flags, *args, **kwargs):
                    opened.append(Path(path))
                    return original_open(path, flags, *args, **kwargs)
                with patch.object(deployment.os, 'open', side_effect=observed):
                    row = self.summary()['override']
                self.assertEqual(row['fileStatus'], status)
                self.assertTrue(all(value is None for key, value in row.items() if key != 'fileStatus'))
                self.assertNotIn(self.path, opened)
                if self.path.is_dir():
                    self.path.rmdir()
                elif self.path.exists() or self.path.is_symlink():
                    self.path.unlink()
                if other.exists():
                    other.unlink()
                self.path.write_bytes(original); self.path.chmod(0o644)

    def test_permission_and_changed_read_have_no_hash_or_fake_success(self):
        original_open = deployment.os.open
        def denied(path, flags, *args, **kwargs):
            if Path(path) == self.path:
                raise PermissionError('SENTINEL_PRIVATE_PERMISSION')
            return original_open(path, flags, *args, **kwargs)
        with patch.object(deployment.os, 'open', side_effect=denied):
            self.assertEqual(self.summary()['override']['fileStatus'], 'NOT_MEASURED')
        original_fstat = deployment.os.fstat
        descriptor = None
        calls = 0
        def observed_open(path, flags, *args, **kwargs):
            nonlocal descriptor
            result = original_open(path, flags, *args, **kwargs)
            if Path(path) == self.path:
                descriptor = result
            return result
        def changed(fd):
            nonlocal calls
            if fd == descriptor:
                calls += 1
                if calls == 2:
                    with self.path.open('ab') as source:
                        source.write(b' ')
            return original_fstat(fd)
        with patch.object(deployment.os, 'open', side_effect=observed_open), \
                patch.object(deployment.os, 'fstat', side_effect=changed):
            row = self.summary()['override']
        self.assertEqual(row['fileStatus'], 'CHANGED_DURING_READ')
        self.assertIsNone(row['rawSha256'])

    def test_malformed_configuration_and_failed_docker_remain_unmeasured(self):
        self.path.write_text('SENTINEL_PRIVATE_INVALID_JSON')
        result = self.summary(SimpleNamespace(returncode=1, stdout='SENTINEL_PRIVATE_ERROR'))
        self.assertEqual(result['override']['fileStatus'], 'READABLE')
        self.assertIsNone(result['override']['canonicalSha256'])
        self.assertIsNone(result['override']['topLevelExact'])
        self.assertIsNone(result['registrationReferenceMatched'])
        self.assertTrue(all(row['present'] is None for row in result['services'].values()))

    def test_only_worker_role_override_status_is_classified_without_environment_values(self):
        key = 'AUTO_RECHARGE_WORKER_ROLE'
        for service, expected in (('auto-recharge', 'recharge'), ('auto-registration', 'registration')):
            for environment, status in (
                ({key: expected, 'SECRET': 'SENTINEL_PRIVATE_NEIGHBOUR'}, 'EXPECTED'),
                ([key + '=' + expected, 'SECRET=SENTINEL_PRIVATE_NEIGHBOUR'], 'EXPECTED'),
                ({key: 'SENTINEL_PRIVATE_WRONG_ROLE'}, 'DIFFERENT'),
                ({key: None}, 'NOT_MEASURED'), ({key: '${SENTINEL_PRIVATE_INHERITED}'}, 'NOT_MEASURED'),
                ([key], 'NOT_MEASURED'), ([key + '=${SENTINEL_PRIVATE_INHERITED}'], 'NOT_MEASURED'),
                ([key + '=' + expected, key + '=' + expected], 'INVALID'),
                ({key: True}, 'INVALID'), (None, 'NOT_MEASURED'),
                ({'SECRET': 'SENTINEL_PRIVATE_NEIGHBOUR'}, 'ABSENT'),
            ):
                with self.subTest(service=service, status=status):
                    self.override['services'][service]['environment'] = environment
                    self.write_override()
                    result = self.summary()
                    self.assertEqual(result['services'][service]['roleOverrideStatus'], status)
                    self.assertTrue(all(result['services'][other]['roleOverrideStatus'] is None
                        for other in ('api', 'admin', 'media-resolver', 'migrate')))

    def test_optional_success_side_is_closed_and_cannot_replace_or_weaken_original_proof(self):
        side = {'fixedIsolationDiagnostic': self.summary()}
        def wire(item, proof=None):
            return '\n'.join(json.dumps(value) for value in (self.lock, proof or self.proof, item))
        self.assertEqual(self.namespace['readonly_receipts'](wire(side), True), [self.lock, self.proof, side])
        bad_proof = copy.deepcopy(self.proof); bad_proof['safeProof']['accepted'] = False
        with self.assertRaises(RuntimeError):
            self.namespace['readonly_receipts'](wire(side, bad_proof), True)
        generic = ReadOnlyReleaseLockTests.generic_diagnostics(self)
        with self.assertRaises(RuntimeError):
            self.namespace['readonly_receipts'](wire(side, generic), True)
        mutations = [(('private',), 'SENTINEL'), (('currentCommit',), 'a' * 40),
            (('registrationReferenceMatched',), 1), (('override', 'rawSha256'), 'SENTINEL'),
            (('override', 'topLevelKeyCount'), True), (('override', 'private'), 'SENTINEL'),
            (('runtimeCompose', 'pinMatched'), True), (('runtimeCompose', 'sha256'), None),
            (('services', 'api', 'extraKnownKeys'), ['SENTINEL']),
            (('services', 'api', 'extraKnownKeys'), ['volumes', 'labels']),
            (('services', 'api', 'extraKnownKeys'), ['labels', 'labels']),
            (('services', 'api', 'extraFieldCount'), -1),
            (('services', 'api', 'extraKnownKeys'), ['labels']),
            (('services', 'api', 'imageMatched'), 'SENTINEL'),
            (('services', 'api', 'roleOverrideStatus'), 'EXPECTED'),
            (('services', 'auto-registration', 'roleOverrideStatus'), 'SENTINEL')]
        for path, value in mutations:
            bad = copy.deepcopy(side); target = bad['fixedIsolationDiagnostic']
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            with self.subTest(path=path), self.assertRaisesRegex(RuntimeError, '^Read-only diagnostic output unavailable$'):
                self.namespace['readonly_receipts'](wire(bad), True)
        for bad in ({'private': 'SENTINEL'}, {'fixedIsolationDiagnostic': {}},
                    {'fixedIsolationDiagnostic': side['fixedIsolationDiagnostic'], 'private': 'SENTINEL'}):
            with self.assertRaises(RuntimeError):
                self.namespace['readonly_receipts'](wire(bad), True)
        self.assertLess(len(wire(side).encode()), 24000)

    def test_actual_embedded_fixed_success_emits_independent_third_receipt(self):
        current = self.root / 'current'; current.mkdir()
        for path in (self.compose, self.path):
            path.rename(current / path.name)
        (current / 'release-manifest.json').write_text(json.dumps(self.manifest))
        def fixture_path(value):
            return self.root if value == '/opt/id-business-v2' else Path(value)
        def docker(*args, **kwargs):
            command = args[0]
            if 'compose' in command:
                return SimpleNamespace(returncode=0, stdout='a' * 64)
            if '{{.Config.Image}}' in command:
                return SimpleNamespace(returncode=0, stdout=self.manifest['images']['auto-registration']['reference'])
            return SimpleNamespace(returncode=0, stdout='sha256:' + 'b' * 64 + ' running healthy')
        tree = ReadOnlyReleaseProofTests.program
        selector = next(index for index, node in enumerate(tree.body) if isinstance(node, ast.If)
                        and isinstance(node.test, ast.Compare))
        nodes = [node for node in tree.body[:selector + 1]
            if not isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef))
            and not (isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
                and node.targets[0].id.startswith('PROOF_'))]
        namespace = {**self.namespace, 'Path': fixture_path, 'release_lock_summary': lambda: self.lock['releaseLock'],
                     'fixed_release_proof': lambda *args: copy.deepcopy(self.proof['safeProof'])}
        output = io.StringIO()
        with redirect_stdout(output), patch.object(self.namespace['subprocess'], 'run', side_effect=docker):
            with self.assertRaises(SystemExit) as stopped:
                exec(compile(ast.Module(body=nodes, type_ignores=[]), '<fixed-isolation-server>', 'exec'), namespace)
        self.assertEqual(stopped.exception.code, 0)
        receipts = self.namespace['readonly_receipts'](output.getvalue(), True)
        self.assertEqual(receipts[:2], [self.lock, self.proof])
        self.assertTrue(receipts[2]['fixedIsolationDiagnostic']['registrationReferenceMatched'])
        self.assertNotIn('SENTINEL', output.getvalue())


class HistoricalDiagnosticsTests(unittest.TestCase):
    def policy(self):
        policy = HistoricalContinuationTests().policy()
        policy['id'] = deployment.HISTORY_DIAGNOSTICS_POLICY_ID
        policy['expectedCurrent'] = deployment.HISTORY_DIAGNOSTICS_BASELINE
        policy['candidateSourceSha256'] = {name: deployment.hashlib.sha256(
            ('synthetic-diagnostics:' + name).encode()).hexdigest()
            for name in deployment.DIAGNOSTICS_CANDIDATE_FILES}
        proof = policy['continuation']
        proof['fixedCurrent'] = deployment.HISTORY_DIAGNOSTICS_BASELINE
        proof['manifest']['commit'] = deployment.HISTORY_DIAGNOSTICS_BASELINE
        proof['manifest']['previousCommit'] = deployment.HISTORY_CONTINUATION_BASELINE
        return policy

    def save_fixture(self, root, policy, values):
        for stage in ('before', 'after'):
            policy['continuation'][stage + 'GateSha256'] = deployment.historical_fingerprint(
                values[stage + '-audit.json']['gate'])
        HistoricalContinuationTests.save_fixture(self, root, policy, values)

    def fixture(self, root):
        policy = self.policy()
        reports = {stage: HistoricalContinuationTests().audit_report(stage)
                   for stage in ('before', 'after')}
        manifest = {**policy['continuation']['manifest'], **{
            'dataAudit' + stage.title(): {'checkCount': 48, 'violationCount': 10,
                'historicalException': report['gate']} for stage, report in reports.items()}}
        values = {'release-manifest.json': manifest,
                  **{stage + '-audit.json': report for stage, report in reports.items()}}
        self.save_fixture(root, policy, values)
        return policy, values

    def verify_fixture(self, root, policy):
        with patch.object(deployment, 'DIAGNOSTICS_PROOF_SHA256',
                          deployment.historical_fingerprint(policy['continuation'])):
            return deployment.verify_continuation_baseline(root, policy,
                deployment.HISTORY_DIAGNOSTICS_POLICY_ID)

    def test_third_policy_only_accepts_the_fixed_6a_baseline(self):
        deployment.require_historical_baseline(deployment.HISTORY_DIAGNOSTICS_POLICY_ID,
                                               deployment.HISTORY_DIAGNOSTICS_BASELINE)
        for policy, baseline in [
            (deployment.HISTORY_DIAGNOSTICS_POLICY_ID, deployment.HISTORY_BASELINE),
            (deployment.HISTORY_DIAGNOSTICS_POLICY_ID, deployment.HISTORY_CONTINUATION_BASELINE),
            (deployment.HISTORY_DIAGNOSTICS_POLICY_ID, 'f' * 40),
            (deployment.HISTORY_POLICY_ID, deployment.HISTORY_DIAGNOSTICS_BASELINE),
            (deployment.HISTORY_CONTINUATION_POLICY_ID, deployment.HISTORY_DIAGNOSTICS_BASELINE),
            ('unknown', deployment.HISTORY_DIAGNOSTICS_BASELINE)]:
            with self.subTest(policy=policy, baseline=baseline), self.assertRaises(RuntimeError):
                deployment.require_historical_baseline(policy, baseline)
        with self.assertRaises(RuntimeError):
            deployment.fixed_continuation('unknown')

    def test_third_policy_keeps_original_rules_and_exact_seven_candidate_files(self):
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            root = Path(name); (root / 'deploy/aws').mkdir(parents=True)
            policy = self.policy()
            path = root / 'deploy/aws' / (deployment.HISTORY_DIAGNOSTICS_POLICY_ID + '.json')
            path.write_text(json.dumps(policy))
            with self.assertRaisesRegex(RuntimeError, 'policy changed'):
                deployment.continuation_policy(root, deployment.HISTORY_DIAGNOSTICS_POLICY_ID)
            with patch.object(deployment, 'DIAGNOSTICS_POLICY_SHA256',
                    deployment.historical_fingerprint(policy)), patch.object(deployment,
                    'DIAGNOSTICS_PROOF_SHA256', deployment.historical_fingerprint(policy['continuation'])):
                self.assertEqual(deployment.continuation_policy(root,
                    deployment.HISTORY_DIAGNOSTICS_POLICY_ID), policy)
            mutations = [lambda x: x.update(expectedCurrent='f' * 40),
                lambda x: x['candidateSourceSha256'].update({'docs/unapproved-source.md': 'f' * 64}),
                lambda x: x.update(extraUnapprovedRule=True),
                lambda x: x['continuation'].update(continuationOf='other'),
                lambda x: x['continuation']['manifest'].update(previousCommit=deployment.HISTORY_BASELINE)]
            for index, mutate in enumerate(mutations):
                changed = copy.deepcopy(policy); mutate(changed); path.write_text(json.dumps(changed))
                # Even a re-pinned complete new-policy hash cannot broaden the approved origin.
                with self.subTest(index=index), patch.object(deployment, 'DIAGNOSTICS_POLICY_SHA256',
                        deployment.historical_fingerprint(changed)), patch.object(deployment,
                        'DIAGNOSTICS_PROOF_SHA256', deployment.historical_fingerprint(changed['continuation'])), \
                        self.assertRaises(RuntimeError):
                    deployment.continuation_policy(root, deployment.HISTORY_DIAGNOSTICS_POLICY_ID)

    def test_seven_source_policy_rejects_each_new_wrong_hash_missing_or_extra_path(self):
        project = Path(__file__).resolve().parents[2]
        policy = deployment.continuation_policy(project, deployment.HISTORY_DIAGNOSTICS_POLICY_ID)
        added = (
            'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py',
            'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_auto_code.py',
            'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py',
            'docs/V2_TASKS.md',
        )
        self.assertEqual(len(policy['candidateSourceSha256']), 7)
        self.assertEqual(len(deployment.DIAGNOSTICS_CONTROL_FILES), 13)
        self.assertTrue(set(added) <= deployment.DIAGNOSTICS_CANDIDATE_FILES)
        self.assertTrue(set(added).isdisjoint(deployment.DIAGNOSTICS_CONTROL_FILES))
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            root = Path(name); target = root / 'deploy/aws' / (policy['id'] + '.json')
            target.parent.mkdir(parents=True)
            for filename in added:
                for mutation in ('wrong-hash', 'missing', 'extra'):
                    changed = copy.deepcopy(policy); candidates = changed['candidateSourceSha256']
                    if mutation == 'wrong-hash':
                        candidates[filename] = 'f' * 64
                    elif mutation == 'missing':
                        del candidates[filename]
                    else:
                        candidates[filename + '.extra'] = candidates[filename]
                    target.write_text(json.dumps(changed))
                    with self.subTest(filename=filename, mutation=mutation), self.assertRaises(RuntimeError):
                        deployment.continuation_policy(root, deployment.HISTORY_DIAGNOSTICS_POLICY_ID)

    def test_each_new_candidate_rejects_wrong_hash_missing_extra_mode_and_symlink(self):
        policy = self.policy()
        added = (
            'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py',
            'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_auto_code.py',
            'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py',
            'docs/V2_TASKS.md',
        )
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            directory = Path(name); root = directory / 'candidate'; root.mkdir()
            for filename in policy['candidateSourceSha256']:
                path = root / filename; path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('synthetic-diagnostics:' + filename); path.chmod(0o644)
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode='w') as archive:
                member = tarfile.TarInfo(f'id-business-system-{deployment.HISTORY_DIAGNOSTICS_BASELINE}/frozen.txt')
                member.size = 6; member.mode = 0o644; archive.addfile(member, io.BytesIO(b'frozen'))
            (root / 'frozen.txt').write_bytes(b'frozen'); (root / 'frozen.txt').chmod(0o644)
            def verify():
                with tarfile.open(fileobj=io.BytesIO(data.getvalue()), mode='r') as archive:
                    deployment.verify_continuation_archive(root, archive, policy,
                        deployment.HISTORY_DIAGNOSTICS_POLICY_ID)
            verify()
            for index, filename in enumerate(added):
                path = root / filename; original = path.read_bytes()
                extra = root / (filename + '.extra')
                link_target = directory / ('private-link-target-' + str(index))
                link_target.write_bytes(original); link_target.chmod(0o644)
                for mutation in ('wrong-hash', 'missing', 'extra', 0o600, 0o444, 0o664, 0o755, 'symlink'):
                    if mutation == 'wrong-hash':
                        path.write_bytes(b'unapproved')
                    elif mutation == 'missing':
                        path.unlink()
                    elif mutation == 'extra':
                        extra.write_bytes(original)
                    elif mutation == 'symlink':
                        path.unlink(); path.symlink_to(link_target.resolve())
                    else:
                        path.chmod(mutation)
                    with self.subTest(filename=filename, mutation=mutation), self.assertRaises(RuntimeError):
                        verify()
                    if path.is_symlink():
                        path.unlink()
                    if path.exists():
                        path.chmod(0o644)
                    path.write_bytes(original); path.chmod(0o644)
                    if extra.exists():
                        extra.unlink()
                    verify()

    def mode_archive_fixture(self, directory, mode):
        policy = self.policy(); data = io.BytesIO(); prefix = 'id-business-system-' + 'a' * 40 + '/'
        contents = {name: ('synthetic-diagnostics:' + name).encode()
                    for name in policy['candidateSourceSha256']}
        contents['frozen.txt'] = b'unchanged full-mode baseline'
        with tarfile.open(fileobj=data, mode='w:gz') as source:
            for name, content in contents.items():
                item = tarfile.TarInfo(prefix + name); item.size = len(content)
                item.mode = mode if name in policy['candidateSourceSha256'] else 0o664
                source.addfile(item, io.BytesIO(content))
        with tarfile.open(fileobj=io.BytesIO(data.getvalue()), mode='r:gz') as source:
            source.extractall(directory)
        release = directory / prefix[:-1]
        baseline = io.BytesIO()
        with tarfile.open(fileobj=baseline, mode='w') as source:
            item = tarfile.TarInfo(f'id-business-system-{deployment.HISTORY_DIAGNOSTICS_BASELINE}/frozen.txt')
            item.size = len(contents['frozen.txt']); item.mode = 0o664
            source.addfile(item, io.BytesIO(contents['frozen.txt']))
        return release, policy, contents, baseline.getvalue()

    def test_github_0664_and_original_0644_candidates_normalize_only_the_exact_seven(self):
        for mode in (0o644, 0o664):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(dir='.deploy') as name:
                release, policy, contents, baseline = self.mode_archive_fixture(Path(name), mode)
                with patch.object(deployment.os, 'fchmod', wraps=deployment.os.fchmod) as chmod:
                    deployment.normalize_diagnostics_candidate_modes(release, policy)
                self.assertEqual(chmod.call_count, 7 if mode == 0o664 else 0)
                for filename, content in contents.items():
                    path = release / filename
                    self.assertEqual(path.read_bytes(), content)
                    self.assertEqual(path.stat().st_mode & 0o7777,
                                     0o644 if filename in policy['candidateSourceSha256'] else 0o664)
                with tarfile.open(fileobj=io.BytesIO(baseline), mode='r') as archive:
                    deployment.verify_continuation_archive(release, archive, policy,
                        deployment.HISTORY_DIAGNOSTICS_POLICY_ID)

    def test_mode_normalization_rejects_before_chmod_on_any_unverified_candidate(self):
        filenames = sorted(deployment.DIAGNOSTICS_CANDIDATE_FILES)
        for filename in filenames:
            for mutation in ('wrong-hash', 'missing', 'symlink', 'hardlink', 0o600, 0o444, 0o755, 0o2664):
                with self.subTest(filename=filename, mutation=mutation), tempfile.TemporaryDirectory(dir='.deploy') as name:
                    directory = Path(name)
                    release, policy, contents, _baseline = self.mode_archive_fixture(directory, 0o664)
                    path = release / filename
                    if mutation == 'wrong-hash':
                        path.write_bytes(b'changed')
                    elif mutation == 'missing':
                        path.unlink()
                    elif mutation in ('symlink', 'hardlink'):
                        outside = directory / 'outside'; outside.write_bytes(contents[filename])
                        path.unlink()
                        if mutation == 'symlink':
                            path.symlink_to(outside.resolve())
                        else:
                            deployment.os.link(outside, path)
                    else:
                        path.chmod(mutation)
                    with patch.object(deployment.os, 'fchmod') as chmod, self.assertRaises(RuntimeError):
                        deployment.normalize_diagnostics_candidate_modes(release, policy)
                    chmod.assert_not_called()
                    for untouched in set(filenames) - {filename}:
                        self.assertEqual((release / untouched).stat().st_mode & 0o7777, 0o664)

    def test_mode_normalization_cannot_broaden_policy_or_allow_unrelated_archive_changes(self):
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            release, policy, _contents, baseline = self.mode_archive_fixture(Path(name), 0o664)
            for mutation in ('extra', 'missing', 'old-policy', 'wrong-baseline'):
                changed = copy.deepcopy(policy)
                if mutation == 'extra':
                    changed['candidateSourceSha256']['docs/unapproved.md'] = 'f' * 64
                elif mutation == 'missing':
                    changed['candidateSourceSha256'].pop(next(iter(changed['candidateSourceSha256'])))
                elif mutation == 'old-policy':
                    changed['id'] = deployment.HISTORY_CONTINUATION_POLICY_ID
                else:
                    changed['expectedCurrent'] = deployment.HISTORY_CONTINUATION_BASELINE
                with self.subTest(mutation=mutation), patch.object(deployment.os, 'fchmod') as chmod, \
                        self.assertRaises(RuntimeError):
                    deployment.normalize_diagnostics_candidate_modes(release, changed)
                chmod.assert_not_called()
            unapproved = release / 'unapproved.txt'; unapproved.write_bytes(b'unapproved'); unapproved.chmod(0o664)
            deployment.normalize_diagnostics_candidate_modes(release, policy)
            self.assertEqual(unapproved.stat().st_mode & 0o7777, 0o664)
            with tarfile.open(fileobj=io.BytesIO(baseline), mode='r') as archive, \
                    self.assertRaisesRegex(RuntimeError, 'unrelated source'):
                deployment.verify_continuation_archive(release, archive, policy,
                    deployment.HISTORY_DIAGNOSTICS_POLICY_ID)

    def test_mode_normalization_ignores_read_atime_but_rejects_a_changed_open_file(self):
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            release, policy, _contents, _baseline = self.mode_archive_fixture(Path(name), 0o664)
            for filename in policy['candidateSourceSha256']:
                path = release / filename
                deployment.os.utime(path, ns=(1, path.stat().st_mtime_ns))
            deployment.normalize_diagnostics_candidate_modes(release, policy)
            for filename in policy['candidateSourceSha256']:
                (release / filename).chmod(0o664)
            victim = release / next(iter(policy['candidateSourceSha256']))
            original_sha256 = deployment.hashlib.sha256
            def changed_during_hash(data):
                digest = original_sha256(data)
                victim.write_bytes(data + b'changed during read')
                return digest
            with patch.object(deployment.hashlib, 'sha256', side_effect=changed_during_hash), \
                    patch.object(deployment.os, 'fchmod') as chmod, self.assertRaises(RuntimeError):
                deployment.normalize_diagnostics_candidate_modes(release, policy)
            chmod.assert_not_called()

    def test_mode_normalization_rejects_symlinked_candidate_parent(self):
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            directory = Path(name)
            release, policy, _contents, _baseline = self.mode_archive_fixture(directory, 0o664)
            (release / 'apps').rename(directory / 'outside-apps')
            (release / 'apps').symlink_to((directory / 'outside-apps').resolve())
            with patch.object(deployment.os, 'fchmod') as chmod, self.assertRaises(RuntimeError):
                deployment.normalize_diagnostics_candidate_modes(release, policy)
            chmod.assert_not_called()

    def test_actual_git_archives_freeze_every_other_path_hash_and_full_mode_at_6a(self):
        project = Path(__file__).resolve().parents[2]
        policy = deployment.continuation_policy(project, deployment.HISTORY_DIAGNOSTICS_POLICY_ID)
        excluded = deployment.DIAGNOSTICS_CANDIDATE_FILES | deployment.DIAGNOSTICS_CONTROL_FILES
        self.assertEqual(len(excluded), 20)
        def snapshot(revision):
            result = deployment.subprocess.run(['git', '-c', 'tar.umask=0022', 'archive', '--format=tar', revision],
                cwd=project, capture_output=True)
            self.assertEqual(result.returncode, 0, 'Local Git archive unavailable')
            with tarfile.open(fileobj=io.BytesIO(result.stdout), mode='r') as archive:
                self.assertTrue(all(item.isfile() or item.isdir() for item in archive.getmembers()))
                return {item.name: (deployment.hashlib.sha256(archive.extractfile(item).read()).hexdigest(),
                                   item.mode & 0o7777)
                        for item in archive.getmembers() if item.isfile()}
        baseline = snapshot(deployment.HISTORY_DIAGNOSTICS_BASELINE); candidate = snapshot('HEAD')
        self.assertTrue({key: value for key, value in baseline.items() if key not in excluded} ==
                        {key: value for key, value in candidate.items() if key not in excluded},
                        'Unapproved path, source hash or full mode changed outside seven candidates and thirteen controls')
        for filename, digest in policy['candidateSourceSha256'].items():
            with self.subTest(filename=filename):
                self.assertEqual(candidate.get(filename), (digest, 0o644))

    def test_actual_6a_receipts_must_prove_the_previous_registration_gate_at_d0(self):
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            root = Path(name); policy, values = self.fixture(root)
            self.assertEqual(self.verify_fixture(root, policy), values['release-manifest.json'])
            with self.assertRaisesRegex(RuntimeError, 'proof changed'):
                deployment.verify_continuation_baseline(root, policy, deployment.HISTORY_DIAGNOSTICS_POLICY_ID)
            path = root / 'after-audit.json'; path.write_bytes(path.read_bytes() + b' ')
            with self.assertRaisesRegex(RuntimeError, 'receipt changed'):
                self.verify_fixture(root, policy)

    def test_self_consistent_rehashed_previous_receipts_cannot_change_the_registration_origin(self):
        mutations = [lambda x: x['release-manifest.json'].update(commit='f' * 40),
            lambda x: x['release-manifest.json'].update(previousCommit=deployment.HISTORY_BASELINE),
            lambda x: x['before-audit.json']['gate'].update(policyId=deployment.HISTORY_POLICY_ID),
            lambda x: x['after-audit.json']['gate'].update(expectedCurrent=deployment.HISTORY_DIAGNOSTICS_BASELINE),
            lambda x: x['after-audit.json']['gate'].update(fixedCurrent=deployment.HISTORY_DIAGNOSTICS_BASELINE),
            lambda x: x['after-audit.json']['gate'].update(executedCheckCount=46, unavailableCheckCount=2),
            lambda x: x['after-audit.json']['gate'].update(continuationOf='other'),
            lambda x: x['after-audit.json']['gate']['continuation'].update(manifestSha256='f' * 64),
            lambda x: x['release-manifest.json']['dataAuditAfter'].update(violationCount=0)]
        for index, mutate in enumerate(mutations):
            with tempfile.TemporaryDirectory(dir='.deploy') as name:
                root = Path(name); policy, values = self.fixture(root); mutate(values)
                self.save_fixture(root, policy, values)
                with self.subTest(index=index), self.assertRaises(RuntimeError):
                    self.verify_fixture(root, policy)

    def test_runtime_rejects_all_flag_pairs_wrong_baseline_admin_only_and_every_reused_image_dimension(self):
        base = ['remote-deploy.py', '--commit', 'a' * 40, '--source-tree', 'b' * 40,
            '--repository', '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release',
            '--expected-current', deployment.HISTORY_DIAGNOSTICS_BASELINE,
            '--run-id', '123', '--run-attempt', '1', '--ci-run-id', '111']
        flags = ['--historical-finance-exception', '--historical-finance-continuation',
                 '--historical-finance-recharge-diagnostics']
        cases = [[flags[0], flags[1]], [flags[0], flags[2]], [flags[1], flags[2]],
                 [flags[2], '--admin-only'], [flags[2], '--image-commit', 'c' * 40],
                 [flags[2], '--image-run-id', '122'], [flags[2], '--image-run-attempt', '2']]
        for index, extra in enumerate(cases):
            with self.subTest(index=index), patch.object(deployment.sys, 'argv', base + extra), \
                    patch.object(deployment.os, 'umask') as umask, self.assertRaises(RuntimeError):
                deployment.main()
            umask.assert_not_called()
        wrong = list(base); wrong[wrong.index('--expected-current') + 1] = deployment.HISTORY_CONTINUATION_BASELINE
        with patch.object(deployment.sys, 'argv', wrong + [flags[2]]), self.assertRaises(RuntimeError):
            deployment.main()

    def test_diagnostics_forbids_new_migrations_edge_changes_and_never_executes_migrate(self):
        deployment.require_diagnostics_migration_scope([], False)
        for additions, edge in [(['20261005_unreviewed/migration.sql'], False), ([], True)]:
            with self.assertRaises(RuntimeError):
                deployment.require_diagnostics_migration_scope(additions, edge)
        with patch.object(deployment, 'compose') as compose:
            deployment.run_release_migrations(Path('.'), False, True)
            deployment.run_release_migrations(Path('.'), True)
            compose.assert_not_called()
            deployment.run_release_migrations(Path('.'), False)
            compose.assert_called_once_with(Path('.'), 'run', '--rm', '--no-deps', 'migrate', timeout=900)

    def test_source_migration_guard_rejects_before_any_candidate_compose_command(self):
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            root = Path(name); previous = root / 'previous'; release = root / 'release'
            for directory in (previous, release):
                (directory / 'apps/api/prisma-mysql/migrations').mkdir(parents=True)
                caddy = directory / 'deploy/caddy/Caddyfile.aws'; caddy.parent.mkdir(parents=True)
                caddy.write_text('unchanged edge')
            with patch.object(deployment, 'compose') as compose:
                deployment.require_diagnostics_source_scope(previous, release)
                new = release / 'apps/api/prisma-mysql/migrations/20261005_unapproved/migration.sql'
                new.parent.mkdir(); new.write_text('CREATE TABLE unapproved (id INT);')
                with self.assertRaisesRegex(RuntimeError, 'forbids migrations'):
                    deployment.require_diagnostics_source_scope(previous, release)
                compose.assert_not_called()

    def test_fixed_6a_archive_freezes_old_policies_sql_and_modes_and_pins_ci_candidate(self):
        policy = self.policy()
        frozen = ['apps/api/unrelated.ts', 'apps/api/prisma-mysql/schema.prisma',
            'apps/api/prisma-mysql/migrations/20261001_existing/migration.sql',
            'deploy/aws/historical-finance-20261005.json',
            'deploy/aws/historical-finance-20261005-registration-continuation.json',
            'scripts/v2-data-integrity-audit.mjs', 'docker-compose.aws-mysql.yml',
            'deploy/caddy/Caddyfile.aws']
        self.assertTrue(all(name not in deployment.DIAGNOSTICS_CONTROL_FILES for name in frozen))
        self.assertNotIn('scripts/ci-recharge-check.mjs', deployment.DIAGNOSTICS_CONTROL_FILES)
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            root = Path(name); data = io.BytesIO()
            for filename in frozen + list(policy['candidateSourceSha256']):
                path = root / filename; path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(('synthetic-diagnostics:' if filename in policy['candidateSourceSha256']
                                 else 'frozen:') + filename); path.chmod(0o644)
            control = root / 'scripts/production-release/remote-deploy.py'; control.parent.mkdir(parents=True)
            control.write_text('reviewed control')
            with tarfile.open(fileobj=data, mode='w') as archive:
                for filename in frozen:
                    content = (root / filename).read_bytes()
                    item = tarfile.TarInfo(f'id-business-system-{deployment.HISTORY_DIAGNOSTICS_BASELINE}/' + filename)
                    item.size = len(content); item.mode = 0o644; archive.addfile(item, io.BytesIO(content))
            def verify():
                with tarfile.open(fileobj=io.BytesIO(data.getvalue()), mode='r') as archive:
                    deployment.verify_continuation_archive(root, archive, policy,
                        deployment.HISTORY_DIAGNOSTICS_POLICY_ID)
            verify()
            for filename in frozen + ['scripts/ci-recharge-check.mjs']:
                path = root / filename; original = path.read_bytes(); path.write_text('unapproved')
                with self.subTest(filename=filename), self.assertRaises(RuntimeError):
                    verify()
                path.write_bytes(original)
            path = root / frozen[0]; path.chmod(0o600)
            with self.assertRaisesRegex(RuntimeError, 'unrelated source'):
                verify()
            path.chmod(0o644)
            link = root / 'unapproved-link'; link.symlink_to(frozen[0])
            with self.assertRaisesRegex(RuntimeError, 'Unsafe diagnostics candidate'):
                verify()
            link.unlink()
            extra = root / 'new-unapproved.ts'; extra.write_text('unapproved')
            with self.assertRaisesRegex(RuntimeError, 'unrelated source'):
                verify()
            extra.unlink()
            policy['candidateSourceSha256']['docs/unapproved-source.md'] = 'f' * 64
            with self.assertRaisesRegex(RuntimeError, 'candidate scope changed'):
                verify()

    def test_archive_rejects_wrong_baseline_unsafe_types_and_duplicates(self):
        policy = self.policy()
        prefix = f'id-business-system-{deployment.HISTORY_DIAGNOSTICS_BASELINE}/'
        cases = [('wrong', f'id-business-system-{deployment.HISTORY_CONTINUATION_BASELINE}/file'),
                 ('symlink', prefix + 'file'), ('duplicate', prefix + 'file')]
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            root = Path(name)
            for kind, path in cases:
                data = io.BytesIO()
                with tarfile.open(fileobj=data, mode='w') as archive:
                    item = tarfile.TarInfo(path); item.mode = 0o644
                    if kind == 'symlink':
                        item.type = tarfile.SYMTYPE; item.linkname = '/unrelated'
                        archive.addfile(item)
                    else:
                        item.size = 1; archive.addfile(item, io.BytesIO(b'x'))
                        if kind == 'duplicate':
                            archive.addfile(item, io.BytesIO(b'x'))
                with self.subTest(kind=kind), tarfile.open(fileobj=io.BytesIO(data.getvalue()), mode='r') as archive, \
                        self.assertRaises(RuntimeError):
                    deployment.verify_continuation_archive(root, archive, policy,
                        deployment.HISTORY_DIAGNOSTICS_POLICY_ID)
    def audit_report(self, stage):
        policy = self.policy()
        return {'ok': False, 'checkCount': 48, 'violationCount': 10, 'gate': {
            'accepted': True, 'status': 'APPROVED_HISTORICAL_EXCEPTIONS',
            'policyId': policy['id'], 'expectedCurrent': policy['expectedCurrent'],
            'fixedCurrent': policy['expectedCurrent'], 'continuationOf': deployment.HISTORY_POLICY_ID,
            'stage': stage, 'checkCount': 48, 'violationCount': 10, 'executedCheckCount': 48,
            'unavailableCheckCount': 0, 'sources': {
                name: group['sha256'] for name, group in policy['sources'].items()},
            'metadataSha256': policy['continuation']['metadataSha256'], 'continuation': policy['continuation']}}

    def audit(self, report, stage):
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            root = Path(name); before = root / 'before.json'; before.write_text('{}'); before.chmod(0o600)
            with patch.object(deployment, 'environment_values', return_value={
                    'V2_DATA_INTEGRITY_DATABASE_URL': 'mysql://id_business_audit:synthetic@localhost/test'}), \
                    patch.object(deployment, 'continuation_policy', return_value=self.policy()) as policy_loader, \
                    patch.object(deployment.os, 'fchown'), \
                    patch.object(deployment, 'compose', side_effect=lambda directory, *args, **kwargs:
                        json.dumps({'uid':1000,'gid':1000,'user':'node'} if '--entrypoint' in args else report)) as compose:
                result = deployment.audit(root, root / 'receipt.json', historical_diagnostics=True,
                    stage=stage, source=root, before_receipt=before)
                policy_loader.assert_called_once_with(root, deployment.HISTORY_DIAGNOSTICS_POLICY_ID)
                self.assertEqual((root / 'receipt.json').stat().st_mode & 0o777, 0o600)
                return result, compose.call_args.args

    def test_audit_selects_exact_new_policy_6a_and_retains_private_independent_ro_receipt(self):
        for stage in ('before', 'after'):
            result, command = self.audit(self.audit_report(stage), stage)
            self.assertEqual(result['violationCount'], 10)
            self.assertEqual(result['historicalException']['continuationOf'], deployment.HISTORY_POLICY_ID)
            self.assertIn('--expected-current=' + deployment.HISTORY_DIAGNOSTICS_BASELINE, command)
            self.assertIn('--policy=/release-policy/' + deployment.HISTORY_DIAGNOSTICS_POLICY_ID + '.json', command)
            self.assertNotIn('--user', command)
            self.assertTrue(all(command[index + 1].endswith(':ro')
                for index, part in enumerate(command) if part == '-v'))
            if stage == 'after':
                self.assertIn('--before-receipt=/release-before-audit.json', command)
                self.assertTrue(any(isinstance(value, str) and
                    value.endswith(':/release-before-audit.json:ro') for value in command))

    def test_new_gate_rejects_partial_false_zero_changed_sources_metadata_and_proof(self):
        mutations = [lambda x: x.update(ok=True), lambda x: x.update(checkCount=46),
            lambda x: x.update(violationCount=0), lambda x: x['gate'].update(executedCheckCount=46),
            lambda x: x['gate'].update(unavailableCheckCount=2),
            lambda x: x['gate'].update(expectedCurrent=deployment.HISTORY_CONTINUATION_BASELINE),
            lambda x: x['gate'].update(fixedCurrent=deployment.HISTORY_CONTINUATION_BASELINE),
            lambda x: x['gate'].update(continuationOf=deployment.HISTORY_CONTINUATION_POLICY_ID),
            lambda x: x['gate'].update(metadataSha256='f' * 64),
            lambda x: x['gate'].update(sources={'unknown': 'f' * 64}),
            lambda x: x['gate']['continuation'].update(manifestSha256='f' * 64)]
        for stage in ('before', 'after'):
            for index, mutate in enumerate(mutations):
                report = self.audit_report(stage); mutate(report)
                with self.subTest(stage=stage, index=index), self.assertRaises(RuntimeError):
                    self.audit(report, stage)


class RechargeOnlyPublicationTests(unittest.TestCase):
    def test_fixed_diagnostics_selects_only_the_recharge_runtime_and_image(self):
        services, images = deployment.release_services(False, [], historical_diagnostics=True)
        self.assertEqual(services, ('auto-recharge',))
        self.assertEqual(images, ('auto-recharge',))
        references = deployment.release_image_references(services, images, 'fixture-registry',
            {'auto-recharge': 'new-recharge'})
        self.assertEqual(references, {'auto-recharge': 'fixture-registry:new-recharge'})
        for admin, additions, edge in [(True, [], False), (False, ['new.sql'], False), (False, [], True)]:
            with self.subTest(admin=admin, additions=additions, edge=edge), self.assertRaises(RuntimeError):
                deployment.release_services(admin, additions, edge, historical_diagnostics=True)

    def test_registration_guard_tracks_the_actual_updated_worker_including_legacy_shared_worker(self):
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            root = Path(name); compose = root / 'docker-compose.aws-mysql.yml'
            compose.write_text('services:\n  auto-recharge:\n  auto-registration:\n')
            self.assertFalse(deployment.registration_worker_changes(root, ('auto-recharge',)))
            self.assertTrue(deployment.registration_worker_changes(root, ('auto-registration',)))
            self.assertTrue(deployment.registration_worker_changes(root, deployment.SERVICES))
            self.assertFalse(deployment.registration_worker_changes(root, ('admin',)))
            compose.write_text('services:\n  auto-recharge:\n')
            self.assertTrue(deployment.registration_worker_changes(root, ('auto-recharge',)))

    def test_container_identity_is_opt_in_and_must_be_the_real_full_identity(self):
        value = {'Id': 'a' * 64, 'Image': 'sha256:fixture', 'Config': {'Image': 'fixture:old'},
            'State': {'Status': 'running', 'Health': {'Status': 'healthy'},
                'StartedAt': '2026-10-05T14:00:00.000000000Z'}}
        with patch.object(deployment, 'compose', return_value='a' * 64), \
                patch.object(deployment, 'run', side_effect=lambda *args: json.dumps([value])):
            regular = deployment.service_state(None, 'auto-registration')
            self.assertNotIn('containerId', regular)
            self.assertEqual(deployment.service_state(None, 'auto-registration',
                include_container_id=True), {**regular, 'containerId': 'a' * 64,
                    'startedAtSha256': deployment.hashlib.sha256(value['State']['StartedAt'].encode()).hexdigest()})
            for identity in (None, '', 'a' * 12):
                value['Id'] = identity
                with self.subTest(identity=identity), self.assertRaisesRegex(RuntimeError, 'identity unavailable'):
                    deployment.service_state(None, 'auto-registration', include_container_id=True)
            value['Id'] = 'a' * 64
            for started in (None, '', 'a' * 129):
                value['State']['StartedAt'] = started
                with self.subTest(started=started), self.assertRaisesRegex(RuntimeError, 'start identity unavailable'):
                    deployment.service_state(None, 'auto-registration', include_container_id=True)

    def test_private_environment_has_to_remain_byte_identical_on_both_releases(self):
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            root = Path(name); old = root / 'old'; new = root / 'new'; old.mkdir(); new.mkdir()
            expected = b'APP_PUBLIC_URL=http://synthetic.test\nGOOGLE_DRIVE_SYNC_FOLDER_ID=synthetic\n'
            for path in (old / '.env.aws.production', new / '.env.aws.production'):
                path.write_bytes(expected)
            deployment.require_diagnostics_environment_unchanged(old, new, expected)
            for path in (old / '.env.aws.production', new / '.env.aws.production'):
                path.write_bytes(expected + b'UNREVIEWED=changed\n')
                with self.assertRaisesRegex(RuntimeError, 'environment changed'):
                    deployment.require_diagnostics_environment_unchanged(old, new, expected)
                path.write_bytes(expected)

    @staticmethod
    def archive(commit, files, candidate_mode=0o644):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w:gz') as archive:
            for name, content in files.items():
                member = tarfile.TarInfo(f'id-business-system-{commit}/' + name)
                member.mode = candidate_mode if name in deployment.DIAGNOSTICS_CANDIDATE_FILES else 0o644
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
        return data.getvalue()

    def publication(self, *, recharge_failure=None, registration_rebuilt=False,
                    compose_mutation=False, override_mutation=False,
                    candidate_mutation=False, full_release=False,
                    manifest_mutation=False, legacy_layout=False, running_image_mutation=False,
                    registration_restarted=False, manifest_extra_image=False,
                    repin_override=False, candidate_mode=0o644):
        # Real release orchestration, guards, private receipts, source archive comparison,
        # override writes and mixed-image manifest. All external calls are synthetic.
        with tempfile.TemporaryDirectory(dir='.deploy') as name:
            base = Path(name).resolve(); (base / 'releases').mkdir()
            previous = base / 'releases/previous'; previous.mkdir()
            (base / 'current').symlink_to(previous)
            fixture = HistoricalDiagnosticsTests()
            policy, values = fixture.fixture(previous)
            manifest = values['release-manifest.json']
            repository = '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'
            commit = 'a' * 40; new_reference = repository + ':' + commit + '-123-1-auto-recharge'
            new_image = 'sha256:' + deployment.hashlib.sha256(b'new-recharge').hexdigest()
            manifest['googleDriveSyncFolderId'] = 'synthetic-existing-folder'
            manifest['images'] = {service: {
                'reference': repository + ':' + deployment.HISTORY_DIAGNOSTICS_BASELINE +
                    '-122-1-' + deployment.image_service(service),
                'digest': 'sha256:' + deployment.hashlib.sha256(deployment.image_service(service).encode()).hexdigest(),
                'sourceCommit': deployment.HISTORY_DIAGNOSTICS_BASELINE}
                for service in (*deployment.SERVICES, 'migrate')}
            if manifest_extra_image:
                manifest['images']['synthetic-historical-image'] = {
                    'reference': 'fixture:historical', 'digest': 'sha256:' + 'f' * 64,
                    'sourceCommit': 'c' * 40}
            fixture.save_fixture(previous, policy, values)
            manifest_digest = deployment.hashlib.sha256((previous / 'release-manifest.json').read_bytes()).hexdigest()
            proof_digest = deployment.historical_fingerprint(policy['continuation'])
            if manifest_mutation:
                path = previous / 'release-manifest.json'; path.write_bytes(path.read_bytes() + b' ')
            states = {service: {'image': manifest['images'].get(service, {}).get('digest', 'sha256:' + service),
                'reference': manifest['images'].get(service, {}).get('reference', 'fixture:' + service),
                'status': 'running', 'health': None if service == 'caddy' else 'healthy',
                'containerId': deployment.hashlib.sha256(service.encode()).hexdigest(),
                'startedAtSha256': deployment.hashlib.sha256(('old-start:' + service).encode()).hexdigest()}
                for service in deployment.ALL_SERVICES}
            if running_image_mutation:
                states['auto-registration']['image'] = 'sha256:' + 'f' * 64
            compose_text = (Path(__file__).resolve().parents[2] / 'docker-compose.aws-mysql.yml').read_bytes()
            frozen = {'docker-compose.aws-mysql.yml': compose_text,
                'deploy/caddy/Caddyfile.aws': b'unchanged synthetic edge'}
            for filename, content in frozen.items():
                path = previous / filename; path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content); path.chmod(0o644)
            (previous / 'apps/api/prisma-mysql/migrations').mkdir(parents=True)
            (previous / '.env.aws.production').write_text('APP_PUBLIC_URL=http://synthetic.test\n'
                'GOOGLE_DRIVE_SYNC_FOLDER_ID=synthetic-existing-folder\n')
            (previous / '.env.aws.production').chmod(0o600)
            override = {'services': {service: {'image': manifest['images'][service]['reference'],
                        'pull_policy': 'never'} for service in (*deployment.SERVICES, 'migrate')}}
            override_data = json.dumps(override).encode()
            override_raw_digest = deployment.hashlib.sha256(override_data).hexdigest()
            override_canonical_digest = deployment.historical_fingerprint(override)
            if override_mutation == 'image':
                override['services']['auto-registration']['image'] = 'fixture:unreviewed'
            elif override_mutation == 'recharge-role':
                override['services']['auto-recharge']['environment'] = {'AUTO_RECHARGE_WORKER_ROLE': 'registration'}
            elif override_mutation == 'recharge-volume':
                override['services']['auto-recharge']['volumes'] = ['shared-profile:/tmp/profile']
            elif override_mutation == 'top-networks':
                override['networks'] = {'registration-egress': {'external': True}}
            elif override_mutation == 'top-volumes':
                override['volumes'] = {'shared-profile': {'external': True}}
            elif isinstance(override_mutation, str) and override_mutation.startswith('missing:'):
                override['services'].pop(override_mutation.split(':', 1)[1])
            elif override_mutation == 'extra-service':
                override['services']['synthetic-historical-image'] = {
                    'image': 'fixture:historical', 'pull_policy': 'never'}
            elif override_mutation == 'pull':
                override['services']['auto-registration']['pull_policy'] = 'always'
            elif override_mutation == 'canonical-pin':
                override_canonical_digest = 'f' * 64
            elif override_mutation == 'raw':
                pass
            elif override_mutation:
                override['services']['auto-registration']['environment'] = {'AUTO_RECHARGE_WORKER_ROLE': 'recharge'}
            override_data = json.dumps(override).encode() + (b' ' if override_mutation == 'raw' else b'')
            if repin_override:
                override_raw_digest = deployment.hashlib.sha256(override_data).hexdigest()
                override_canonical_digest = deployment.historical_fingerprint(override)
            (previous / 'compose.release.json').write_bytes(override_data)
            if compose_mutation:
                (previous / 'docker-compose.aws-mysql.yml').write_bytes(compose_text.replace(
                    b'AUTO_RECHARGE_WORKER_ROLE: registration', b'AUTO_RECHARGE_WORKER_ROLE: recharge'))
            if legacy_layout:
                (previous / 'docker-compose.aws-mysql.yml').write_bytes(compose_text.replace(
                    b'  auto-registration:', b'  retired-registration:'))
            candidate = {**frozen, **{filename: ('synthetic-diagnostics:' + filename).encode()
                for filename in policy['candidateSourceSha256']}}
            if candidate_mutation:
                candidate['apps/api/unapproved.ts'] = b'unreviewed'
            candidate_archive = self.archive(commit, candidate, candidate_mode)
            baseline_archive = self.archive(deployment.HISTORY_DIAGNOSTICS_BASELINE, frozen)
            argv = ['remote-deploy.py', '--commit', commit, '--source-tree', 'b' * 40,
                '--repository', repository, '--expected-current', deployment.HISTORY_DIAGNOSTICS_BASELINE,
                '--run-id', '123', '--run-attempt', '1', '--ci-run-id', '111']
            if not full_release:
                argv.append('--historical-finance-recharge-diagnostics')

            def state(directory, service, *, include_container_id=False):
                value = dict(states[service])
                if directory != previous:
                    if service == 'auto-recharge':
                        value.update(image=new_image, reference=new_reference, containerId='c' * 64)
                    elif service == 'auto-registration' and registration_rebuilt:
                        value['containerId'] = 'd' * 64
                    elif service == 'auto-registration' and registration_restarted:
                        value['startedAtSha256'] = 'e' * 64
                if not include_container_id:
                    value.pop('containerId')
                    value.pop('startedAtSha256')
                return value

            def external_run(*args, **kwargs):
                if args[:3] == ('aws', 'ecr', 'get-login-password'):
                    return 'synthetic-login'
                if args[:2] == ('docker', 'pull'):
                    return ''
                if args[:3] == ('docker', 'image', 'inspect'):
                    return json.dumps([{'Architecture': 'amd64', 'Id': new_image,
                        'Config': {'Labels': {'org.opencontainers.image.revision': commit}}}])
                raise AssertionError(args)

            def external_compose(directory, *args, **kwargs):
                if args == ('config', '--format', 'json'):
                    return json.dumps({'name': 'synthetic-project'})
                if args[:2] == ('up', '-d'):
                    return ''
                raise AssertionError(args)

            def response(url, **kwargs):
                if '/archive/' in url:
                    return io.BytesIO(candidate_archive if commit in url else baseline_archive)
                value = io.BytesIO(b'ready'); value.status = 200; value.headers = {}
                return value

            def audit(directory, receipt, **kwargs):
                report = fixture.audit_report(kwargs['stage'])
                return {'checkCount': 48, 'violationCount': 10, 'historicalException': report['gate']}

            output = io.StringIO()
            with ExitStack() as stack:
                original_open = Path.open
                def track_release_lock(path, *args, **kwargs):
                    stream = original_open(path, *args, **kwargs)
                    if path.name == '.deploy.lock':
                        stack.callback(stream.close)
                    return stream
                stack.enter_context(patch.object(Path, 'open', new=track_release_lock))
                for obj, attr, kwargs in [
                    (deployment, 'BASE', {'new': base}),
                    (deployment.sys, 'argv', {'new': argv}),
                    (deployment, 'DIAGNOSTICS_MANIFEST_SHA256', {'new': manifest_digest}),
                    (deployment, 'DIAGNOSTICS_OVERRIDE_RAW_SHA256', {'new': override_raw_digest}),
                    (deployment, 'DIAGNOSTICS_OVERRIDE_CANONICAL_SHA256', {'new': override_canonical_digest}),
                    (deployment, 'DIAGNOSTICS_PROOF_SHA256', {'new': proof_digest}),
                    (deployment, 'continuation_policy', {'return_value': policy}),
                    (deployment, 'service_state', {'side_effect': state}),
                    (deployment, 'run', {'side_effect': external_run}),
                    (deployment, 'compose', {'side_effect': external_compose}),
                    (deployment.urllib.request, 'urlopen', {'side_effect': response}),
                    (deployment.subprocess, 'run', {'return_value': SimpleNamespace(returncode=0)}),
                    (deployment.shutil, 'disk_usage', {'return_value': SimpleNamespace(free=3 * 1024 ** 3)}),
                    (deployment, 'fresh_backup', {'return_value': {'name': 'synthetic-verified-backup'}}),
                    (deployment, 'audit', {'side_effect': audit}),
                    (deployment, 'sync_new_table_grants', {'return_value': {'ok': True}}),
                    (deployment, 'wait_healthy', {'return_value': {}})]:
                    stack.enter_context(patch.object(obj, attr, **kwargs))
                recharge = stack.enter_context(patch.object(deployment, 'assert_no_active_recharge',
                    side_effect=recharge_failure))
                registration = stack.enter_context(patch.object(deployment, 'assert_no_active_registration',
                    side_effect=RuntimeError('Active registration jobs prevent release')))
                guards = stack.enter_context(patch.object(deployment, 'assert_no_active_jobs',
                    wraps=deployment.assert_no_active_jobs))
                isolation = stack.enter_context(patch.object(deployment, 'require_diagnostics_registration_isolation',
                    wraps=deployment.require_diagnostics_registration_isolation))
                rollback = stack.enter_context(patch.object(deployment, 'rollback_service'))
                google_drive = stack.enter_context(patch.object(deployment, 'configure_google_drive_sync',
                    wraps=deployment.configure_google_drive_sync))
                with redirect_stdout(output):
                    try:
                        result = deployment.main(); error = None
                    except RuntimeError as failure:
                        result = None; error = str(failure)
                run = deployment.run; compose = deployment.compose; audited = deployment.audit
                releases = [path for path in (base / 'releases').iterdir() if path != previous]
                target = releases[0] if releases else None
                saved = json.loads((target / 'release-manifest.json').read_text()) if target and (
                    target / 'release-manifest.json').exists() else None
                target_override = json.loads((target / 'compose.release.json').read_text()) if target and (
                    target / 'compose.release.json').exists() else None
                return SimpleNamespace(result=result, error=error, output=output.getvalue(),
                    guards=guards.call_args_list, recharge_calls=recharge.call_count,
                    registration_calls=registration.call_count, isolation_calls=isolation.call_count,
                    run=run.call_args_list, compose=compose.call_args_list, audits=audited.call_count,
                    rollback=rollback.call_args_list, google_drive_calls=google_drive.call_count,
                    previous=previous, current=(base / 'current').resolve(), manifest=saved,
                    old_manifest=manifest, old_override=override, override=target_override)

    def test_real_orchestration_preserves_live_registration_and_writes_mixed_image_manifest(self):
        result = self.publication()
        self.assertEqual(result.result, 0, result.output or result.error)
        self.assertEqual(result.registration_calls, 0)
        self.assertEqual(result.recharge_calls, 2)
        self.assertEqual(result.isolation_calls, 2)
        self.assertTrue(all(call.kwargs == {'worker_changes': False} for call in result.guards))
        self.assertEqual(result.google_drive_calls, 0)
        self.assertEqual(result.manifest['servicesUpdated'], ['auto-recharge'])
        self.assertFalse(result.manifest['migrationApplied'])
        self.assertEqual(result.manifest['newMigrations'], [])
        self.assertEqual(result.manifest['googleDriveSyncFolderId'], result.old_manifest['googleDriveSyncFolderId'])
        for service in result.old_manifest['images']:
            if service != 'auto-recharge':
                self.assertEqual(result.manifest['images'][service], result.old_manifest['images'][service])
                self.assertEqual(result.override['services'][service], result.old_override['services'][service])
        self.assertEqual(result.manifest['images']['auto-recharge']['sourceCommit'], 'a' * 40)
        self.assertNotEqual(result.manifest['images']['auto-recharge']['digest'],
                            result.manifest['images']['auto-registration']['digest'])
        self.assertEqual([call.args[-1] for call in result.compose if call.args[1:3] == ('up', '-d')],
                         ['auto-recharge'])
        pulls = [call.args[-1] for call in result.run if call.args[:2] == ('docker', 'pull')]
        self.assertEqual(len(pulls), 1); self.assertTrue(pulls[0].endswith('-auto-recharge'))
        self.assertFalse(any('migrate' in call.args or 'caddy' in call.args for call in result.compose))
        self.assertIn('"unchangedServiceContainersPreserved": true', result.output)

    def test_active_recharge_at_either_guard_prevents_switch_without_touching_registration(self):
        failure = RuntimeError('Active recharge jobs prevent release')
        for index, failures in enumerate(([failure], [None, failure])):
            result = self.publication(recharge_failure=failures)
            self.assertEqual(result.registration_calls, 0)
            self.assertEqual(result.recharge_calls, index + 1)
            self.assertEqual(result.current, result.previous)
            self.assertFalse(any(call.args[1:3] == ('up', '-d') for call in result.compose))
            self.assertEqual(result.rollback, [])
            self.assertNotIn('"unchangedServiceContainersPreserved": true', result.output)

    def test_exact_six_override_preserves_manifest_only_historical_image_records(self):
        result = self.publication(manifest_extra_image=True)
        self.assertEqual(result.result, 0, result.output or result.error)
        self.assertEqual(set(result.override['services']), {*deployment.SERVICES, 'migrate'})
        self.assertEqual(result.manifest['images']['synthetic-historical-image'],
                         result.old_manifest['images']['synthetic-historical-image'])
        self.assertNotIn('synthetic-historical-image', result.override['services'])
        self.assertEqual(result.registration_calls, 0)
        self.assertEqual(result.recharge_calls, 2)

    def test_real_orchestration_accepts_github_0664_candidates_after_verified_baseline(self):
        result = self.publication(candidate_mode=0o664, manifest_extra_image=True)
        self.assertEqual(result.result, 0, result.output or result.error)
        self.assertEqual(result.registration_calls, 0)
        self.assertEqual(result.recharge_calls, 2)
        self.assertEqual(result.manifest['servicesUpdated'], ['auto-recharge'])

    def test_fixed_override_pins_match_the_independent_closed_receipt(self):
        self.assertEqual(deployment.DIAGNOSTICS_OVERRIDE_RAW_SHA256,
                         '10b7d30b6bd08d356b516d67dd54b39620b9b6fc1ca7e22bb760008a7cd0a635')
        self.assertEqual(deployment.DIAGNOSTICS_OVERRIDE_CANONICAL_SHA256,
                         '9437772305ea1d18f790c528c3db05e126970153c77cdbe55d644122fe8b7313')

    def test_override_bytes_and_canonical_pin_are_independently_required(self):
        for mutation in ('raw', 'canonical-pin'):
            with self.subTest(mutation=mutation):
                result = self.publication(override_mutation=mutation)
                self.assertEqual(result.error, 'Historical diagnostics image override changed')
                self.assertEqual(result.recharge_calls, 0)
                self.assertEqual(result.run, [])
                self.assertEqual(result.compose, [])

    def test_exact_six_structure_rejects_changes_even_with_synthetic_matching_hashes(self):
        mutations = [*(f'missing:{service}' for service in (*deployment.SERVICES, 'migrate')),
                     'extra-service', 'image', 'pull', True, 'recharge-role',
                     'recharge-volume', 'top-networks', 'top-volumes']
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                result = self.publication(override_mutation=mutation, repin_override=True,
                                          manifest_extra_image=True)
                self.assertEqual(result.error, 'Historical diagnostics image override changed')
                self.assertEqual(result.recharge_calls, 0)
                self.assertEqual(result.registration_calls, 0)
                self.assertEqual(result.run, [])
                self.assertEqual(result.compose, [])

    def test_shared_tampered_layout_or_override_cannot_skip_protection(self):
        for kwargs in ({'compose_mutation': True}, {'override_mutation': True},
                       {'override_mutation': 'image'}, {'manifest_mutation': True},
                       {'legacy_layout': True}, {'running_image_mutation': True},
                       {'override_mutation': 'recharge-role'}, {'override_mutation': 'recharge-volume'},
                       {'override_mutation': 'top-networks'}, {'override_mutation': 'top-volumes'}):
            result = self.publication(**kwargs)
            self.assertIsNotNone(result.error)
            self.assertEqual(result.recharge_calls, 0)
            self.assertEqual(result.registration_calls, 0)
            self.assertEqual(result.run, [])
            self.assertEqual(result.compose, [])

    def test_unreviewed_source_stops_before_audit_and_switch_despite_live_registration(self):
        result = self.publication(candidate_mutation=True)
        self.assertEqual(result.result, 1)
        self.assertEqual(result.audits, 0)
        self.assertEqual(result.registration_calls, 0)
        self.assertEqual(result.current, result.previous)
        self.assertEqual(result.compose, [])

    def test_same_image_but_recreated_registration_container_fails_and_rolls_back_only_recharge(self):
        result = self.publication(registration_rebuilt=True)
        self.assertEqual(result.result, 1)
        self.assertEqual(result.registration_calls, 0)
        self.assertEqual(result.current, result.previous)
        self.assertEqual([call.args[2] for call in result.rollback], ['auto-recharge'])
        self.assertNotIn('"unchangedServiceContainersPreserved": true', result.output)
        self.assertNotIn('auto-registration', [call.args[-1] for call in result.compose
            if call.args[1:3] == ('up', '-d')])

    def test_same_container_id_but_restarted_registration_fails_without_claiming_preservation(self):
        result = self.publication(registration_restarted=True)
        self.assertEqual(result.result, 1)
        self.assertEqual(result.registration_calls, 0)
        self.assertEqual(result.current, result.previous)
        self.assertEqual([call.args[2] for call in result.rollback], ['auto-recharge'])
        self.assertNotIn('"unchangedServiceContainersPreserved": true', result.output)

    def test_ordinary_full_release_still_requires_registration_idle_before_source(self):
        result = self.publication(full_release=True)
        self.assertEqual(result.error, 'Active registration jobs prevent release')
        self.assertEqual(result.recharge_calls, 1)
        self.assertEqual(result.registration_calls, 1)
        self.assertEqual(result.guards[0].kwargs, {'worker_changes': True})
        self.assertEqual(result.run, [])


if __name__ == '__main__':
    unittest.main()
