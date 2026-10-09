"""Exercise the real pinned Workspace staging and dispatch contracts offline."""
import hashlib
import copy
import importlib.util
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / '.runtime/bitbrowser-release-20261009/transport-tests'
COMMIT, TREE, PREVIOUS = 'a' * 40, 'b' * 40, 'c' * 40
REPOSITORY = '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'
COMMON_CONTROLLERS = ('remote-deploy.py', 'api-admin-scope.py')
WORKSPACE_CONTROLLERS = (*COMMON_CONTROLLERS, 'online-recharge-scope.py')

spec = importlib.util.spec_from_file_location('api_admin_transport',
    Path(__file__).with_name('api-admin-readonly.py'))
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)


class WorkspaceStagingTests(unittest.TestCase):
    def assert_pinned(self, commands, filenames):
        """Every executable comes from the candidate and is verified before execution."""
        for filename in filenames:
            digest = hashlib.sha256(Path(__file__).with_name(filename).read_bytes()).hexdigest()
            downloads = [index for index, command in enumerate(commands)
                if command.startswith('curl ') and
                f'/{COMMIT}/scripts/production-release/{filename} -o ' in command]
            checks = [index for index, command in enumerate(commands)
                if command.startswith(f'echo "{digest}  ') and
                command.endswith('sha256sum -c - >/dev/null')]
            self.assertEqual(len(downloads), 1, filename)
            self.assertEqual(len(checks), 1, filename)
            self.assertEqual(checks[0], downloads[0] + 1, filename)
            self.assertLess(checks[0], len(commands) - 1, filename)
        self.assertEqual(sum('sha256sum -c -' in command for command in commands), len(filenames))

    def test_workspace_preflight_and_readback_pin_online_reader_before_execution(self):
        for mode in ('preflight', 'readback'):
            with self.subTest(mode=mode):
                parameters = transport.parameters(COMMIT, PREVIOUS, mode, 'API_ADMIN_WORKSPACE')
                self.assert_pinned(parameters['commands'], WORKSPACE_CONTROLLERS)
                self.assertEqual(parameters['executionTimeout'], ['300'])
                self.assertTrue(parameters['commands'][-1].endswith(
                    f'--api-workspace-{mode} --expected-current {PREVIOUS}'))
                self.assertNotIn('--online-recharge-only', '\n'.join(parameters['commands']))
                self.assertNotIn('--online-recharge-preflight', '\n'.join(parameters['commands']))
                self.assertLess(len(json.dumps(parameters).encode()), 48 * 1024)

    def test_other_api_readers_retain_two_controller_contract(self):
        for scope in ('API_ADMIN', 'API_ADMIN_MIGRATION', 'API_REGISTRATION'):
            with self.subTest(scope=scope):
                parameters = transport.parameters(COMMIT, PREVIOUS, 'preflight', scope)
                self.assert_pinned(parameters['commands'], COMMON_CONTROLLERS)
                self.assertNotIn('online-recharge-scope.py', '\n'.join(parameters['commands']))

    def test_command_injection_and_publication_mode_cannot_enter_readonly_transport(self):
        cases = [(COMMIT + '; touch sentinel', PREVIOUS, 'preflight', 'API_ADMIN_WORKSPACE'),
            (COMMIT, PREVIOUS + '$(touch sentinel)', 'readback', 'API_ADMIN_WORKSPACE'),
            (COMMIT, PREVIOUS, 'release', 'API_ADMIN_WORKSPACE'),
            (COMMIT, PREVIOUS, 'preflight', 'ONLINE_RECHARGE')]
        for values in cases:
            with self.subTest(values=values), self.assertRaises(ValueError):
                transport.parameters(*values)

    def dispatch_parameters(self, operation):
        source = (ROOT / 'scripts/production-release/dispatch.sh').read_text()
        program = source.split('python3 - "$parameters_file" <<\'PY\'\n', 1)[1].split('\nPY', 1)[0]
        proof_name = {'release_api_workspace': 'api-workspace',
            'release_api_admin': 'api-admin', 'release_online_recharge': 'online-recharge'}[operation]
        proof_bytes = json.dumps({'offlineTransportFixture': proof_name}).encode()
        original_read = Path.read_bytes
        def read(path):
            if path.as_posix() == f'.deploy/production-release/{proof_name}-build-proof.json':
                return proof_bytes
            return original_read(path)
        environment = {'RELEASE_COMMIT': COMMIT, 'SOURCE_TREE': TREE, 'EXPECTED_CURRENT': PREVIOUS,
            'RELEASE_REPOSITORY': REPOSITORY, 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1',
            'QUALITY_RUN_ID': '456', 'RELEASE_OPERATION': operation, 'HISTORICAL_EXCEPTION': 'none'}
        RUNTIME.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
            output = Path(temporary) / 'parameters.json'
            with patch.dict(os.environ, environment, clear=True), \
                    patch.object(sys, 'argv', ['offline-dispatch', str(output)]), \
                    patch.object(Path, 'read_bytes', read):
                previous_cwd = Path.cwd()
                try:
                    os.chdir(ROOT)
                    exec(compile(program, 'offline-dispatch', 'exec'), {'__name__': '__test__'})
                finally:
                    os.chdir(previous_cwd)
            return json.loads(output.read_text())

    def test_workspace_dispatch_pins_reader_but_cannot_select_online_initial_publication(self):
        parameters = self.dispatch_parameters('release_api_workspace')
        self.assert_pinned(parameters['commands'], WORKSPACE_CONTROLLERS)
        command = parameters['commands'][-1]
        self.assertIn('--api-workspace-only --api-admin-build-proof ', command)
        self.assertNotIn('--online-recharge-only', command)
        self.assertNotIn('--image-commit', command)
        self.assertNotIn('--historical-', command)
        self.assertEqual(parameters['executionTimeout'], ['3600'])
        self.assertLess(len(json.dumps(parameters).encode()), 48 * 1024)

    def test_original_api_and_online_dispatch_remain_explicit(self):
        api = self.dispatch_parameters('release_api_admin')
        self.assert_pinned(api['commands'], COMMON_CONTROLLERS)
        self.assertIn('--api-admin-only --api-admin-build-proof ', api['commands'][-1])
        self.assertNotIn('online-recharge-scope.py', '\n'.join(api['commands']))
        online = self.dispatch_parameters('release_online_recharge')
        self.assert_pinned(online['commands'], WORKSPACE_CONTROLLERS)
        self.assertIn('--online-recharge-only --online-recharge-build-proof ', online['commands'][-1])
        self.assertNotIn('--api-workspace-only', online['commands'][-1])


class WorkspaceSuccessorReceiptTests(unittest.TestCase):
    """Exercise the actual pure origin validator with a complete synthetic receipt."""
    def setUp(self):
        self.namespace = runpy.run_path(str(Path(__file__).with_name('api-admin-scope.py')),
            init_globals={'SCOPE': 'API_ADMIN_WORKSPACE'})
        files = {name: '3' * 64 for name in self.namespace['ONLINE_ORIGIN_FILES']}
        files['release-manifest.json'] = '1' * 64
        bootstrap = self.namespace['WORKSPACE_BOOTSTRAP_COMMIT']
        self.origin = {'version': 1, 'commit': PREVIOUS, 'sourceTree': 'd' * 40,
            'release': f'/opt/id-business-v2/releases/20261009T000000Z-{PREVIOUS[:12]}',
            'manifestSha256': '1' * 64, 'buildProofSha256': '2' * 64, 'files': files,
            'engineConfigurationSha256': 'c' * 64,
            'workspaceOrigin': {'release': f'/opt/id-business-v2/releases/20261008T000000Z-{bootstrap[:12]}',
                'commit': bootstrap, 'recordSha256': '4' * 64,
                'volume': {'name': 'fixture_auto_registration_data', 'status': 'PRESENT',
                    'identitySha256': '5' * 64}}}
        self.marker = self.namespace['online_successor_marker'](self.origin)
        names = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge',
            'auto-registration', 'online-recharge')
        self.services = {name: {'image': 'sha256:' + str(index) * 64,
            'reference': 'fixture:' + name, 'status': 'running', 'health': 'healthy',
            'containerId': str(index) * 64, 'startedAtSha256': 'a' * 64,
            'environmentSha256': 'b' * 64, 'configurationSha256': 'c' * 64}
            for index, name in enumerate(names, 1)}
        self.before = {'status': 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED', 'mode': 'preflight',
            'commit': PREVIOUS, 'releaseCandidateCommit': COMMIT, 'workflowRunId': '123',
            'workflowRunAttempt': '1', 'onlineOrigin': copy.deepcopy(self.origin),
            'onlineSuccessorVerified': True, 'observedServiceCount': 8,
            'services': copy.deepcopy(self.services)}
        after = copy.deepcopy(self.services)
        after['online-recharge']['containerId'] = 'e' * 64
        self.receipt = {'onlineSuccessorVerified': True, 'onlineEngineRebound': True,
            'observedServiceCount': 8, 'migrationPerformed': False,
            'preservedOnlineOrigin': copy.deepcopy(self.marker), 'services': after}
        self.environment = {'RELEASE_COMMIT': COMMIT, 'EXPECTED_CURRENT': PREVIOUS,
            'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1'}

    def validate_readback(self, receipt=None, before=None, environment=None):
        with patch.object(Path, 'is_file', return_value=True), \
                patch.object(Path, 'read_text', return_value=json.dumps(self.before if before is None else before)), \
                patch.dict(os.environ, self.environment if environment is None else environment, clear=True):
            return transport.validate_online_workspace_receipt(self.namespace,
                self.receipt if receipt is None else receipt, COMMIT, 'readback')

    def test_original_workspace_contract_does_not_select_online_successor(self):
        self.assertFalse(transport.validate_online_workspace_receipt(self.namespace,
            {'services': {'api': {}}}, PREVIOUS, 'preflight'))

    def test_eighth_service_requires_verified_origin_and_full_service_set(self):
        self.assertTrue(transport.validate_online_workspace_receipt(self.namespace,
            self.before, PREVIOUS, 'preflight'))
        cases = []
        for key, value in [('onlineOrigin', None), ('onlineSuccessorVerified', False),
                ('observedServiceCount', 7), ('observedServiceCount', 8.0)]:
            cases.append({**copy.deepcopy(self.before), key: value})
        missing = copy.deepcopy(self.before)
        missing['services'].pop('auto-recharge')
        cases.append(missing)
        extra = copy.deepcopy(self.before)
        extra['services']['unapproved-service'] = copy.deepcopy(self.services['mysql'])
        cases.append(extra)
        unhealthy = copy.deepcopy(self.before)
        unhealthy['services']['online-recharge']['health'] = 'unhealthy'
        cases.append(unhealthy)
        for value in cases:
            with self.subTest(receipt=value), self.assertRaisesRegex(RuntimeError, 'ONLINE_ORIGIN_RECEIPT_CHANGED'):
                transport.validate_online_workspace_receipt(self.namespace, value, PREVIOUS, 'preflight')

    def test_successor_readback_binds_same_run_origin_and_actual_rebound(self):
        self.assertTrue(self.validate_readback())
        for key, value in [('mode', 'readback'), ('commit', '9' * 40),
                ('releaseCandidateCommit', '9' * 40), ('workflowRunId', '124'),
                ('workflowRunAttempt', '2'), ('onlineOrigin', None)]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.validate_readback(before={**self.before, key: value})
        for key, value in [('preservedOnlineOrigin', {}), ('onlineEngineRebound', False),
                ('migrationPerformed', True), ('onlineSuccessorVerified', False)]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.validate_readback({**self.receipt, key: value})
        with self.assertRaises(RuntimeError):
            self.validate_readback(before={})
        with self.assertRaises(RuntimeError):
            self.validate_readback(environment={**self.environment, 'EXPECTED_CURRENT': '9' * 40})

    def test_engine_and_preserved_services_cannot_silently_change(self):
        for name, key, value in [('online-recharge', 'image', 'sha256:' + '9' * 64),
                ('online-recharge', 'reference', 'fixture:replacement'),
                ('online-recharge', 'environmentSha256', '9' * 64),
                ('online-recharge', 'configurationSha256', '9' * 64),
                ('online-recharge', 'containerId', self.services['online-recharge']['containerId']),
                ('mysql', 'configurationSha256', '9' * 64),
                ('caddy', 'image', 'sha256:' + '9' * 64)]:
            receipt = copy.deepcopy(self.receipt)
            receipt['services'][name][key] = value
            with self.subTest(name=name, key=key), self.assertRaises(RuntimeError):
                self.validate_readback(receipt)

    def test_omitted_successor_fields_cannot_fall_back_after_online_preflight(self):
        with self.assertRaises(RuntimeError):
            self.validate_readback({'services': {'api': {}, 'admin': {}, 'caddy': {}}})

    def test_other_valid_first_publication_origin_cannot_enter_this_baseline(self):
        foreign = {**copy.deepcopy(self.origin), 'commit': '9' * 40,
            'release': '/opt/id-business-v2/releases/20261009T000000Z-' + '9' * 12}
        self.namespace['validate_online_successor_origin'](foreign)
        before = {**self.before, 'onlineOrigin': foreign}
        with self.assertRaisesRegex(RuntimeError, 'ONLINE_ORIGIN_RECEIPT_CHANGED'):
            transport.validate_online_workspace_receipt(self.namespace, before, PREVIOUS, 'preflight')
        receipt = {**self.receipt,
            'preservedOnlineOrigin': self.namespace['online_successor_marker'](foreign)}
        with self.assertRaisesRegex(RuntimeError, 'ONLINE_ORIGIN_RECEIPT_CHANGED'):
            self.validate_readback(receipt, before)

    def test_real_proof_and_origin_contract_integrate_with_full_independent_readback(self):
        acceptance = {'status': 'PASS', 'checks': ['private-health', 'packaged-resources', 'private-sqlite',
            'encrypted-storage', 'restart-persistence', 'wrong-key-rejected'],
            'businessActions': 0, 'temporaryVolumeRemoved': True}
        proof = {'version': 1, 'scope': 'API_ADMIN_WORKSPACE', 'commit': COMMIT, 'sourceTree': TREE,
            'images': {name: {'reference': f'{REPOSITORY}:{COMMIT}-123-1-{name}',
                'imageId': 'sha256:' + str(index) * 64, 'fileCount': 1, 'sha256': str(index) * 64}
                for index, name in enumerate(('api', 'admin'), 1)},
            'configuration': {'composeSha256': self.namespace['ONLINE_COMPOSE_SEAL'],
                'caddySha256': self.namespace['WORKSPACE_CADDY_AFTER'],
                'volume': self.namespace['WORKSPACE_VOLUME'],
                'containerDirectory': self.namespace['WORKSPACE_DIRECTORY']},
            'acceptance': acceptance}
        receipt = {**copy.deepcopy(self.receipt), 'status': 'API_ADMIN_WORKSPACE_VERIFIED',
            'commit': COMMIT, 'sourceTree': TREE, 'buildProofSha256': self.namespace['fingerprint'](proof),
            'servicesUpdated': ['api', 'admin', 'caddy', 'online-recharge'], 'preservedServiceCount': 4,
            'runningImagesAndContentMatched': True, 'environmentUnchanged': True,
            'workspaceVolume': copy.deepcopy(self.origin['workspaceOrigin']['volume']),
            'volumePreserved': True, 'volumeDeletionPerformed': False, 'registrationHealthChecked': True,
            'offlineAcceptance': acceptance}
        for name, row in proof['images'].items():
            receipt['services'][name].update(image=row['imageId'], reference=row['reference'])
        def read(path):
            return json.dumps(proof if path.name == self.namespace['PROOF_FILE'] else self.before)
        with patch.object(Path, 'is_file', return_value=True), patch.object(Path, 'read_text', read), \
                patch.dict(os.environ, self.environment, clear=True):
            self.assertEqual(transport.validate_receipt(receipt, COMMIT, 'readback',
                'API_ADMIN_WORKSPACE'), receipt)
            with self.assertRaisesRegex(RuntimeError, 'READBACK_BUILD_CHANGED'):
                transport.validate_receipt({**receipt, 'servicesUpdated': ['api', 'admin', 'caddy']},
                    COMMIT, 'readback', 'API_ADMIN_WORKSPACE')
            changed = copy.deepcopy(receipt)
            changed['services']['api']['image'] = 'sha256:' + '9' * 64
            with self.assertRaisesRegex(RuntimeError, 'READBACK_BUILD_CHANGED'):
                transport.validate_receipt(changed, COMMIT, 'readback', 'API_ADMIN_WORKSPACE')


if __name__ == '__main__':
    unittest.main()
