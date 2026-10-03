import contextlib
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch

DIRECTORY = Path(__file__).resolve().parent
PROJECT = DIRECTORY.parent.parent
spec = importlib.util.spec_from_file_location('mailbox_diagnostic', DIRECTORY / 'mailbox-diagnostic.py')
diagnostic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostic)
EXPECTED = 'a' * 40
SOURCE = 'b' * 40
IMAGE = 'sha256:' + 'c' * 64
CONTAINER = 'd' * 64


def receipt():
    return {'configured': True, 'https': True, 'adminPath': True, 'queryChannelPresent': False,
            'primaryAccounts': {'category': 'SUCCESS', 'status': 200, 'count': 2,
                                'code': 'OK', 'path': ['icloudPrimaryAccounts']},
            'virtualEmails': {'category': 'SUCCESS', 'status': 200, 'count': 0,
                              'code': 'OK', 'path': ['icloudVirtualEmails']}}


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        output = PROJECT / '.runtime'
        output.mkdir(exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(prefix='mailbox-diagnostic-test-', dir=output)
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name)
        self.release = self.base / 'releases' / 'fixture-release'
        self.release.mkdir(parents=True)
        (self.base / 'current').symlink_to(self.release)
        (self.base / '.deploy.lock').touch()
        self.manifest = {'commit': EXPECTED, 'images': {'api': {'digest': IMAGE, 'sourceCommit': SOURCE}}}
        self.save_manifest()
        self.state = {'image': IMAGE, 'status': 'running', 'health': 'healthy',
                      'service': 'api', 'project': 'id-business-v2-prod'}
        self.containers = CONTAINER
        self.revision = SOURCE
        self.calls = []
        self.raw = json.dumps(receipt())
        self.patch_base = patch.object(diagnostic, 'BASE', self.base)
        self.patch_base.start()
        self.addCleanup(self.patch_base.stop)
        self.patch_program = patch.object(diagnostic, 'MAILBOX_PROGRAM', 'fixed fixture node source')
        self.patch_program.start()
        self.addCleanup(self.patch_program.stop)

    def save_manifest(self):
        (self.release / 'release-manifest.json').write_text(json.dumps(self.manifest))

    def command(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if args[:2] == ('docker', 'compose'):
            self.assertEqual(args[-5:], ('ps', '--status', 'running', '--quiet', 'api'))
            self.assertEqual(args[3], str(self.release / '.env.aws.production'))
            return self.containers
        if args[:2] == ('docker', 'inspect'):
            self.assertNotIn('.Config.Env', args[3])
            return json.dumps(self.state)
        if args[:3] == ('docker', 'image', 'inspect'):
            return self.revision
        if args[:3] == ('docker', 'exec', '-i'):
            self.assertEqual(args, ('docker', 'exec', '-i', CONTAINER, 'node', '--input-type=module', '-'))
            self.assertEqual(kwargs['data'], b'fixed fixture node source')
            self.assertLessEqual(kwargs['timeout'], 45)
            return self.raw
        self.fail('Unexpected fixed command')

    def diagnose(self):
        with patch.object(diagnostic, 'run', side_effect=self.command):
            return diagnostic.diagnose(EXPECTED)

    def assert_no_exec(self):
        self.assertFalse(any(args[:2] == ('docker', 'exec') for args, _ in self.calls))

    def test_runtime_binds_current_manifest_unique_container_and_actual_image_origin(self):
        result = self.diagnose()
        self.assertTrue(result['baselineVerified'])
        self.assertTrue(result['containerVerified'])
        self.assertEqual(result['mode'], 'READ_ONLY')
        self.assertEqual(result['primaryAccounts']['count'], 2)
        self.assertEqual(sum(args[:2] == ('docker', 'exec') for args, _ in self.calls), 1)
        self.assertEqual(sum(args[:2] == ('docker', 'compose') for args, _ in self.calls), 2)
        # An admin-only/control release can legitimately retain an older API sourceCommit.
        self.assertNotEqual(SOURCE, EXPECTED)
        self.assertNotIn('sourceCommit', result)

    def test_other_baseline_and_invalid_expected_stop_before_docker(self):
        self.manifest['commit'] = 'e' * 40
        self.save_manifest()
        with self.assertRaises(diagnostic.DiagnosticError) as error:
            self.diagnose()
        self.assertEqual(error.exception.code, 'BASELINE_MISMATCH')
        self.assertEqual(self.calls, [])
        with patch.object(diagnostic, 'run') as command:
            for expected in ('private-invalid', 'A' * 40, None):
                with self.assertRaises(diagnostic.DiagnosticError) as error:
                    diagnostic.diagnose(expected)
                self.assertEqual(error.exception.code, 'INVALID_EXPECTED_CURRENT')
            command.assert_not_called()

    def test_missing_or_nonmatching_image_revision_stops_before_query(self):
        self.revision = 'e' * 40
        with self.assertRaises(diagnostic.DiagnosticError) as error:
            self.diagnose()
        self.assertEqual(error.exception.code, 'IMAGE_MISMATCH')
        self.assert_no_exec()
        del self.manifest['images']['api']['sourceCommit']
        self.save_manifest()
        with self.assertRaises(diagnostic.DiagnosticError) as error:
            self.diagnose()
        self.assertEqual(error.exception.code, 'IMAGE_MISMATCH')

    def test_no_or_multiple_or_invalid_container_is_rejected(self):
        for containers in ('', CONTAINER + '\n' + 'e' * 64, 'private-container;command'):
            self.containers = containers
            with self.assertRaises(diagnostic.DiagnosticError) as error:
                self.diagnose()
            self.assertEqual(error.exception.code, 'API_CONTAINER_MISMATCH')
            self.assert_no_exec()

    def test_unhealthy_wrong_service_wrong_project_or_image_stops_before_query(self):
        original = dict(self.state)
        for update in ({'health': 'starting'}, {'service': 'mysql'}, {'status': 'exited'},
                       {'image': 'sha256:' + 'e' * 64}, {'project': None}, {'project': 'private bad project'}):
            self.state = {**original, **update}
            with self.assertRaises(diagnostic.DiagnosticError) as error:
                self.diagnose()
            self.assertEqual(error.exception.code, 'API_CONTAINER_MISMATCH')
            self.assert_no_exec()

    def test_current_release_change_or_container_change_invalidates_receipt(self):
        def change(*args, **kwargs):
            value = self.command(*args, **kwargs)
            if args[:2] == ('docker', 'exec'):
                self.manifest['commit'] = 'e' * 40
                self.save_manifest()
            return value
        with patch.object(diagnostic, 'run', side_effect=change):
            with self.assertRaises(diagnostic.DiagnosticError) as error:
                diagnostic.diagnose(EXPECTED)
        self.assertEqual(error.exception.code, 'BASELINE_MISMATCH')
        self.manifest['commit'] = EXPECTED
        self.save_manifest()
        def change_container(*args, **kwargs):
            value = self.command(*args, **kwargs)
            if args[:2] == ('docker', 'exec'):
                self.containers = 'e' * 64
            return value
        with patch.object(diagnostic, 'run', side_effect=change_container):
            with self.assertRaises(diagnostic.DiagnosticError) as error:
                diagnostic.diagnose(EXPECTED)
        self.assertEqual(error.exception.code, 'API_CONTAINER_MISMATCH')

    def test_held_deploy_lock_or_missing_lock_stops_before_docker(self):
        with (self.base / '.deploy.lock').open('r') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(diagnostic.DiagnosticError) as error:
                self.diagnose()
            self.assertEqual(error.exception.code, 'DEPLOYMENT_LOCKED')
        (self.base / '.deploy.lock').unlink()
        with self.assertRaises(diagnostic.DiagnosticError) as error:
            self.diagnose()
        self.assertEqual(error.exception.code, 'LOCK_UNAVAILABLE')
        self.assertEqual(self.calls, [])

    def test_manifest_cannot_point_outside_releases_or_follow_a_manifest_symlink(self):
        (self.base / 'current').unlink()
        (self.base / 'current').symlink_to(self.base)
        with self.assertRaises(diagnostic.DiagnosticError) as error:
            self.diagnose()
        self.assertEqual(error.exception.code, 'BASELINE_MISMATCH')
        self.assertEqual(self.calls, [])

    def test_parent_strips_extra_properties_and_rejects_uncontrolled_known_values(self):
        data = receipt()
        data['url'] = 'private-url-key'
        data['primaryAccounts']['raw'] = 'private-mail-body'
        filtered = diagnostic.filter_receipt(json.dumps(data))
        self.assertNotIn('url', filtered)
        self.assertNotIn('raw', filtered['primaryAccounts'])
        for name, value in (('code', 'private-token'), ('category', 'private-category'),
                            ('status', True), ('count', -1), ('count', True),
                            ('path', ['icloudPrimaryAccounts', 'private-child'])):
            data = receipt()
            data['primaryAccounts'][name] = value
            with self.assertRaises(diagnostic.DiagnosticError) as error:
                diagnostic.filter_receipt(json.dumps(data))
            self.assertEqual(error.exception.code, 'INVALID_RECEIPT')
        with self.assertRaises(diagnostic.DiagnosticError):
            diagnostic.filter_receipt('private-invalid-json')
        with self.assertRaises(diagnostic.DiagnosticError) as error:
            diagnostic.filter_receipt('x' * 4097)
        self.assertEqual(error.exception.code, 'OUTPUT_LIMIT_EXCEEDED')

    def test_non_success_requires_null_count_and_safe_error_classes_survive_filter(self):
        data = receipt()
        data['primaryAccounts'].update(category='AUTHORIZATION', code='PLATFORM_OWNER_REQUIRED', count=None)
        self.assertEqual(diagnostic.filter_receipt(json.dumps(data))['primaryAccounts']['code'], 'PLATFORM_OWNER_REQUIRED')
        data['primaryAccounts']['count'] = 2
        with self.assertRaises(diagnostic.DiagnosticError):
            diagnostic.filter_receipt(json.dumps(data))

    def test_main_prints_safe_failure_only_even_for_raw_exception_or_arbitrary_cli_args(self):
        with patch.object(sys, 'argv', ['mailbox-diagnostic.py', '--expected-current', EXPECTED]), \
                patch.object(diagnostic, 'diagnose', side_effect=RuntimeError('private-secret-cause')), \
                contextlib.redirect_stdout(io.StringIO()) as output, \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            diagnostic.main()
        self.assertEqual(json.loads(output.getvalue())['code'], 'DIAGNOSTIC_FAILED')
        self.assertEqual(errors.getvalue(), '')
        self.assertNotIn('private-secret', output.getvalue())
        with patch.object(sys, 'argv', ['mailbox-diagnostic.py', '--endpoint', 'private-url']), \
                patch.object(diagnostic, 'diagnose') as call, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            diagnostic.main()
        call.assert_not_called()
        self.assertEqual(json.loads(output.getvalue())['code'], 'INVALID_EXPECTED_CURRENT')


class BoundedTransportTests(unittest.TestCase):
    def test_stderr_is_discarded_and_stdin_is_only_fixed_program_bytes(self):
        program = 'import sys; data=sys.stdin.buffer.read(); sys.stderr.write("private-key"); print(len(data))'
        self.assertEqual(diagnostic.run(sys.executable, '-c', program, data=b'fixed bytes').strip(), '11')

    def test_large_output_failure_and_waiting_child_are_bounded(self):
        for program, timeout, expected in (
            ('print("private" * 1000)', 2, 'OUTPUT_LIMIT_EXCEEDED'),
            ('import time; time.sleep(2)', 0.02, 'TOTAL_TIMEOUT'),
            ('import sys; sys.stderr.write("private-key"); sys.exit(1)', 2, 'COMMAND_FAILED')
        ):
            with self.assertRaises(diagnostic.DiagnosticError) as error:
                diagnostic.run(sys.executable, '-c', program, timeout=timeout)
            self.assertEqual(error.exception.code, expected)

    def test_large_stdin_to_child_that_never_reads_cannot_block_past_timeout(self):
        with self.assertRaises(diagnostic.DiagnosticError) as error:
            diagnostic.run(sys.executable, '-c', 'import time; time.sleep(2)', data=b'x' * 16384, timeout=0.02)
        self.assertEqual(error.exception.code, 'TOTAL_TIMEOUT')

    def test_malformed_utf8_is_rejected_without_exposing_bytes(self):
        with self.assertRaises(diagnostic.DiagnosticError) as error:
            diagnostic.run(sys.executable, '-c', 'import sys; sys.stdout.buffer.write(bytes([255]))')
        self.assertEqual(error.exception.code, 'INVALID_RECEIPT')

    def test_runtime_program_and_workflow_are_fixed_readonly_and_no_env_inspect(self):
        source = (DIRECTORY / 'mailbox-diagnostic.mjs').read_text()
        self.assertLessEqual(len(source.encode()), 16384)
        self.assertNotIn('mutation ', source)
        self.assertNotIn('receivedMails', source)
        workflow = (PROJECT / '.github/workflows/production-release.yml').read_text()
        self.assertIn('- verify_mailbox', workflow)
        self.assertIn("if: inputs.operation == 'verify_mailbox'", workflow)
        self.assertIn('mailbox-diagnostic.py', workflow)
        self.assertIn('mailbox-diagnostic.mjs', workflow)
        self.assertNotIn('.Config.Env', (DIRECTORY / 'mailbox-diagnostic.py').read_text())
        self.assertNotIn('--endpoint', (DIRECTORY / 'mailbox-diagnostic.py').read_text())


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        output = PROJECT / '.runtime'
        output.mkdir(exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(prefix='mailbox-workflow-test-', dir=output)
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name)
        scripts = self.base / 'scripts/production-release'
        scripts.mkdir(parents=True)
        for name in ('mailbox-diagnostic.mjs', 'mailbox-diagnostic.py'):
            (scripts / name).write_text((DIRECTORY / name).read_text())
        self.output = self.base / '.deploy/production-release'
        self.output.mkdir(parents=True)
        workflow = (PROJECT / '.github/workflows/production-release.yml').read_text()
        block = workflow.split('- name: Verify fixed read-only mailbox queries in the running API\n')[1]
        self.block = block.split('      - name:')[0]
        self.programs = [textwrap.dedent(program) for program in re.findall(
            r"python3 - <<'PY'\n(.*?)\n          PY", self.block, re.DOTALL)]
        self.assertEqual(len(self.programs), 2)

    def execute(self, index, expected=EXPECTED):
        return subprocess.run([sys.executable, '-c', self.programs[index]], cwd=self.base,
                              env={**os.environ, 'EXPECTED_CURRENT': expected,
                                   'PYTHONDONTWRITEBYTECODE': '1'}, capture_output=True,
                              text=True, timeout=5)

    def test_actual_workflow_generates_fixed_ssm_program_with_only_sha_argument(self):
        result = self.execute(0)
        self.assertEqual(result.returncode, 0, result.stderr)
        parameters = json.loads((self.output / 'mailbox-diagnostics.json').read_text())
        self.assertEqual(set(parameters), {'commands', 'executionTimeout'})
        self.assertEqual(parameters['executionTimeout'], ['120'])
        self.assertEqual(len(parameters['commands']), 1)
        command = shlex.split(parameters['commands'][0])
        self.assertEqual(command[:2], ['python3', '-c'])
        self.assertEqual(command[3:], ['--expected-current', EXPECTED])
        self.assertTrue(command[2].startswith('MAILBOX_PROGRAM = '))
        compile(command[2], '<fixed-mailbox-transport>', 'exec')
        self.assertLessEqual(len(parameters['commands'][0].encode()), 24000)
        self.assertIn('--document-name AWS-RunShellScript', self.block)
        self.assertIn('--instance-ids "$PRODUCTION_INSTANCE_ID"', self.block)
        self.assertNotIn('dispatch.sh', self.block)
        self.assertNotIn('StandardErrorContent', self.block)
        self.assertEqual(self.execute(0, 'private-invalid').returncode, 1)

    def test_actual_runner_filters_secrets_and_rejects_oversized_or_uncontrolled_receipt(self):
        data = {'mode': 'READ_ONLY', 'baselineVerified': True, 'containerVerified': True, **receipt()}
        data['url'] = 'private-host-with-key'
        data['primaryAccounts']['rawMessage'] = 'private-mail-body'
        path = self.output / 'mailbox-diagnostics-result.json'
        path.write_text(json.dumps(data))
        result = self.execute(1)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {
            'mode': 'READ_ONLY', 'baselineVerified': True, 'containerVerified': True, **receipt()})
        self.assertNotIn('private-', result.stdout + result.stderr)
        for payload in ('private-secret' * 400, '{"mode":"private-uncontrolled"}'):
            path.write_text(payload)
            result = self.execute(1)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, '')
            self.assertNotIn('private-', result.stderr)
            self.assertIn('raw output suppressed', result.stderr)
        path.write_text(json.dumps({'mode': 'READ_ONLY', 'baselineVerified': False,
                                   'containerVerified': False, 'code': 'DEPLOYMENT_LOCKED',
                                   'rawError': 'private-lock-cause'}))
        result = self.execute(1)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)['code'], 'DEPLOYMENT_LOCKED')
        self.assertNotIn('private-', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
