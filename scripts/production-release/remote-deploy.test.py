import importlib.util
import ast
from pathlib import Path
import unittest
import tempfile
import json
import io
import tarfile
import copy
import re
import sqlite3
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

    def test_third_policy_keeps_original_rules_and_exact_three_candidate_files(self):
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
                lambda x: x['candidateSourceSha256'].update({'docs/V2_TASKS.md': 'f' * 64}),
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
            policy['candidateSourceSha256']['docs/V2_TASKS.md'] = 'f' * 64
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
    def archive(commit, files):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w:gz') as archive:
            for name, content in files.items():
                member = tarfile.TarInfo(f'id-business-system-{commit}/' + name)
                member.mode = 0o644; member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
        return data.getvalue()

    def publication(self, *, recharge_failure=None, registration_rebuilt=False,
                    compose_mutation=False, override_mutation=False,
                    candidate_mutation=False, full_release=False,
                    manifest_mutation=False, legacy_layout=False, running_image_mutation=False,
                    registration_restarted=False):
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
            override = {'services': {service: {'image': image['reference'], 'pull_policy': 'never'}
                        for service, image in manifest['images'].items()}}
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
            elif override_mutation:
                override['services']['auto-registration']['environment'] = {'AUTO_RECHARGE_WORKER_ROLE': 'recharge'}
            (previous / 'compose.release.json').write_text(json.dumps(override))
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
            candidate_archive = self.archive(commit, candidate)
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
