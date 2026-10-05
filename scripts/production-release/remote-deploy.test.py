import importlib.util
from pathlib import Path
import unittest
import tempfile
import json
import io
import tarfile
import copy
import re
import sqlite3
from contextlib import redirect_stdout
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

if __name__ == '__main__':
    unittest.main()
