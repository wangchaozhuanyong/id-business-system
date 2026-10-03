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
        self.assertEqual(images, (*deployment.SERVICES, 'migrate'))


    def test_edge_changes_switch_caddy_without_building_an_edge_image(self):
        services, images = deployment.release_services(False, [], True)
        self.assertEqual(services, (*deployment.SERVICES, 'caddy'))
        self.assertEqual(images, (*deployment.SERVICES, 'migrate'))
        with self.assertRaisesRegex(RuntimeError, 'edge configuration'):
            deployment.release_services(True, [], True)

    def test_only_caddy_can_use_running_status_without_container_health(self):
        state = {'status': 'running', 'health': None}
        with patch.object(deployment, 'service_state', return_value=state), \
                patch.object(deployment.time, 'sleep'):
            self.assertEqual(deployment.wait_healthy(None, 'caddy'), state)
            with self.assertRaisesRegex(RuntimeError, 'did not become healthy'):
                deployment.wait_healthy(None, 'admin')


class RegistrationReleaseGuardTests(unittest.TestCase):
    def setUp(self):
        self.database = sqlite3.connect(':memory:')
        self.addCleanup(self.database.close)
        self.database.execute('CREATE TABLE id_business_v2_registration_jobs '
                              '(state TEXT, lease_until TEXT, browser_profile_id TEXT)')
        self.database.create_function('UTC_TIMESTAMP', 1, lambda _: '2026-10-03 00:00:00')
        self.idle = {'supported': True, 'registrationBusy': False,
                     'registrationWindowRetained': False}

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

    def execute_probe(self, response_value=None, error=None):
        opener = MagicMock()
        if error is not None:
            opener.open.side_effect = error
        else:
            opener.open.return_value.__enter__.return_value.read.return_value = (
                json.dumps(response_value).encode())

        def container(directory, *args, **kwargs):
            self.assertEqual(args[:5], ('exec', '-T', 'auto-recharge', 'python', '-c'))
            stdout = io.StringIO()
            with patch('urllib.request.build_opener', return_value=opener), \
                    patch.dict(deployment.os.environ, {'AUTO_RECHARGE_WORKER_TOKEN': 'fixture-token'}), \
                    redirect_stdout(stdout):
                try:
                    exec(args[-1], {})
                except SystemExit:
                    raise RuntimeError('container probe failed') from None
            return stdout.getvalue()

        with patch.object(deployment, 'compose', side_effect=container):
            result = deployment.registration_runtime_state(None)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, 'http://127.0.0.1:8051/registration/health')
        self.assertEqual(request.get_header('X-recharge-worker'), 'fixture-token')
        self.assertNotIn('fixture-token', json.dumps(result))
        return result

    def test_authenticated_probe_returns_only_boolean_queue_proof(self):
        result = self.execute_probe({'ready': True, 'engine': 'camoufox',
                                     'registrationBusy': False, 'registrationWindowRetained': False,
                                     'extra': 'fixture-sensitive-value'})
        self.assertEqual(result, self.idle)

    def test_only_legacy_404_is_supported_not_auth_failure_redirect_or_timeout(self):
        from urllib.error import HTTPError
        self.assertEqual(self.execute_probe(error=HTTPError('unused', 404, 'old', {}, None)),
                         {'supported': False})
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


if __name__ == '__main__':
    unittest.main()
