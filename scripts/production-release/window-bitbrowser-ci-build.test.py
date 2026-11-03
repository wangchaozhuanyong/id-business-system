"""CI routing and evidence regressions; no Docker, network or database calls."""
import importlib.util
import inspect
from pathlib import Path
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('window_ci', HERE / 'window-bitbrowser-ci-build.py')
W = importlib.util.module_from_spec(spec)
spec.loader.exec_module(W)


class CurrentCi(unittest.TestCase):
    def test_exact_manifest_required_and_unknown_paths_fail_closed(self):
        c = {'scope': W.SCOPE, 'reviewBase': '1cd5045d811b8ce3d5f87dd9fc1182a0f787d1ea',
            'candidateFiles': [W.SELF, 'fixture'], 'sources': {'fixture': W.sha(b'fixture')},
            'validationSources': {}, 'packageLockSha256': W.sha(b'lock'), 'businessActions': 0}
        read = lambda n: b'fixture' if n == 'fixture' else b'lock'
        self.assertTrue(W.contract_admitted(c, [W.SELF, 'fixture'], read))
        self.assertFalse(W.contract_admitted(c, ['unrelated'], read))
        self.assertFalse(W.contract_admitted({**c, 'scope': 'other'}, ['fixture'], read))
        self.assertFalse(W.contract_admitted(c, ['fixture'], lambda _n: b'changed'))

    def test_workflow_changes_only_route_two_controls_and_one_build(self):
        old = '\n'.join([W.OLD_BUILD, W.OLD_BUILD, 'node scripts/ci-recharge-check.mjs release-controls "$CHECK_BASE"',
            'node scripts/ci-recharge-check.mjs guards "$CHECK_BASE"',
            '      - name: Verify affected release entry and maintenance controls\n',
            '      - name: Verify changed browser worker\n',
            '      - name: Verify frozen online recharge engine\n'])
        value = W.expected_workflow(old)
        self.assertEqual(value.count(W.NEW_BUILD), 4)
        self.assertIn('--controls release-controls', value)
        self.assertIn('--controls guards', value)
        with self.assertRaises(RuntimeError):
            W.expected_workflow(old + '\n' + W.OLD_BUILD)

    def test_partial_pass_receipt_cannot_hide_a_failed_control_or_another_failure(self):
        run = {'id': W.RUN, 'head_sha': W.PRIOR, 'path': '.github/workflows/quality.yml',
            'event': 'pull_request', 'conclusion': 'failure', 'repository': {'full_name': W.REPO}}
        steps = [{'name': W.STEP['guards'], 'conclusion': 'success'},
            {'name': 'Build and verify sealed ONLINE images without production access', 'conclusion': 'failure'},
            {'name': 'Verify changed browser worker', 'conclusion': 'success'},
            {'name': 'Verify frozen online recharge engine', 'conclusion': 'success'}]
        jobs = {'jobs': [{'name': 'full-quality', 'steps': steps}]}
        W.verify_prior(run, jobs, 'guards')
        for field, value in [('head_sha', 'b' * 40), ('id', 1), ('event', 'push')]:
            with self.assertRaises(RuntimeError):
                W.verify_prior({**run, field: value}, jobs, 'guards')
        with self.assertRaises(RuntimeError):
            W.verify_prior(run, {'jobs': [{'name': 'full-quality', 'steps': [{**steps[0], 'conclusion': 'failure'}, steps[1]]}]}, 'guards')
        with self.assertRaises(RuntimeError):
            W.verify_prior(run, {'jobs': [{'name': 'full-quality', 'steps': steps + [{'name': 'other', 'conclusion': 'failure'}]}]}, 'guards')

    def test_other_changes_keep_the_existing_legacy_checks(self):
        with patch.object(W, 'admitted', return_value=False), patch.object(W, 'run') as child:
            with patch.object(W.sys, 'argv', ['ci', '--controls', 'guards', '--base', 'a' * 40]):
                W.main()
            child.assert_called_once_with(['node', 'scripts/ci-recharge-check.mjs', 'guards', 'a' * 40])
        with patch.object(W, 'admitted', return_value=False), patch.object(W, 'run') as child:
            with patch.object(W.sys, 'argv', ['ci']):
                W.main()
            self.assertIn('online-recharge-ci-build.py', child.call_args.args[0][-1])

    def test_changed_application_input_cannot_reuse_prior_controls(self):
        with patch.object(W, 'git', return_value=b'apps/api/src/changed.ts\n'):
            with self.assertRaisesRegex(RuntimeError, 'CONTROL_INPUT_CHANGED'):
                W.reuse_inputs()

    def test_build_is_linux_ci_only_and_only_runs_readonly_content_checks(self):
        with patch.dict(W.os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, 'ISOLATED_RUNNER_REQUIRED'):
                W.build()
        source = inspect.getsource(W.build)
        for flag in ("'--network', 'none'", "'--read-only'", "'--no-healthcheck'", 'NOT_FOR_RELEASE'):
            self.assertIn(flag, source)
        self.assertNotIn("'docker', 'push'", source)
        self.assertNotIn('migrate deploy', source)


if __name__ == '__main__':
    unittest.main()
