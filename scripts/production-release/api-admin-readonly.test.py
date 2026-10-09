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
RUNTIME = ROOT / '.runtime/apple-hidden-mailbox-20261009/main373-merge/readonly-transport-tests'
COMMIT, TREE, PREVIOUS = 'a' * 40, 'b' * 40, 'c' * 40
REPOSITORY = '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'
COMMON_CONTROLLERS = ('remote-deploy.py', 'api-admin-scope.py')
WORKSPACE_CONTROLLERS = (*COMMON_CONTROLLERS, 'online-recharge-scope.py', 'online-recharge-recovery.json')

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
        self.origin = {'version': 1, 'commit': PREVIOUS,
            'release': f'/opt/id-business-v2/releases/20261009T000000Z-{PREVIOUS[:12]}',
            'manifestSha256': '1' * 64, 'buildProofSha256': '2' * 64, 'files': files,
            'migrationState': {'name': '20261009093000_online_recharge',
                'sha256': '44966182c1bf38290b01f665a4c2c863b052677c5e0024b900137f1d7f11eb95',
                'status': 'APPLIED', 'schemaVerified': True, 'appliedMigrationsSha256': '3' * 64}}
        self.volume = {'name': 'fixture_auto_registration_data', 'status': 'PRESENT',
            'identitySha256': '5' * 64}
        names = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge',
            'auto-registration', 'online-recharge')
        self.services = {name: {'image': 'sha256:' + str(index) * 64,
            'reference': 'fixture:' + name, 'status': 'running', 'health': 'healthy',
            'containerId': str(index) * 64, 'startedAtSha256': 'a' * 64,
            'environmentSha256': 'b' * 64, 'configurationSha256': 'c' * 64}
            for index, name in enumerate(names, 1)}
        self.services['online-recharge']['reference'] = f'{REPOSITORY}:{PREVIOUS}-123-1-online-recharge'
        self.origin['binding'] = {key: self.services['online-recharge'][key] for key in
            ('image', 'reference', 'environmentSha256', 'configurationSha256', 'containerId', 'startedAtSha256')}
        self.origin['binding'].update(volumeIdentitySha256='6' * 64,
            apiContainerId=self.services['api']['containerId'])
        self.marker = self.namespace['online_marker'](self.origin)
        self.before = {'status': 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED', 'mode': 'preflight',
            'commit': PREVIOUS, 'releaseCandidateCommit': COMMIT, 'workflowRunId': '123',
            'workflowRunAttempt': '1', 'onlineRechargeOrigin': copy.deepcopy(self.origin),
            'services': copy.deepcopy(self.services)}
        self.migration_origin = {'version': 1, 'commit': self.namespace['MIGRATION_SUCCESSOR_COMMIT'],
            'release': '/opt/id-business-v2/releases/20261008T000000Z-' + self.namespace['MIGRATION_SUCCESSOR_COMMIT'][:12],
            'manifestSha256': self.namespace['MIGRATION_SUCCESSOR_MANIFEST_SHA'],
            'buildProofSha256': self.namespace['MIGRATION_SUCCESSOR_PROOF_SHA'],
            'migration': copy.deepcopy(self.namespace['MIGRATION_IDENTITY']),
            'migrationState': {'name': self.namespace['MIGRATION_NAME'],
                'sha256': self.namespace['MIGRATION_IDENTITY']['sha256'], 'status': 'APPLIED',
                'schemaVerified': True, 'appliedMigrationsSha256': 'f' * 64},
            'task': copy.deepcopy(self.namespace['MIGRATION_TASK']),
            'guards': {'rechargeIdle': True, 'registrationBusy': False,
                'registrationLeaseActive': False, 'registrationWindowRetained': True}}
        self.before.update(migrationOrigin=copy.deepcopy(self.migration_origin),
            guards=copy.deepcopy(self.migration_origin['guards']), freeBytes=7 * 1024**3)
        after = copy.deepcopy(self.services)
        after['api'].update(containerId='9' * 64, startedAtSha256='d' * 64)
        after['online-recharge']['containerId'] = 'e' * 64
        after['online-recharge']['startedAtSha256'] = 'f' * 64
        binding = {**self.origin['binding'], 'apiContainerId': after['api']['containerId'],
            'containerId': after['online-recharge']['containerId'],
            'startedAtSha256': after['online-recharge']['startedAtSha256']}
        self.receipt = {'servicesRebound': ['online-recharge'], 'migrationPerformed': False,
            'preservedOnlineRechargeOrigin': copy.deepcopy(self.marker), 'services': after,
            'onlineNetworkRebind': {'version': 1, 'before': copy.deepcopy(self.origin['binding']),
                'after': binding, 'businessActions': 0,
                'sqlFence': {'version': 1, 'busyCount': 0, 'sameConnection': True,
                    'mysqlIdentitySha256': '7' * 64, 'connectionIdSha256': '8' * 64, 'businessActions': 0}}}
        self.receipt.update(preservedMigrationOrigin=self.namespace['migration_successor_marker'](self.migration_origin),
            migrationPreserved=True, taskHmacMatched=True, windowPreserved=True, registrationWindowRetained=True)
        self.environment = {'RELEASE_COMMIT': COMMIT, 'EXPECTED_CURRENT': PREVIOUS,
            'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1'}

    def validate_readback(self, receipt=None, before=None, environment=None):
        return transport.validate_online_workspace_receipt(self.namespace,
            self.receipt if receipt is None else receipt, COMMIT, 'readback',
            before=self.before if before is None else before,
            environment=self.environment if environment is None else environment)

    def test_original_workspace_contract_does_not_select_online_successor(self):
        self.assertFalse(transport.validate_online_workspace_receipt(self.namespace,
            {'services': {'api': {}}}, PREVIOUS, 'preflight'))

    def test_eighth_service_requires_verified_origin_and_full_service_set(self):
        self.assertTrue(transport.validate_online_workspace_receipt(self.namespace,
            self.before, PREVIOUS, 'preflight'))
        cases = []
        for key, value in [('onlineRechargeOrigin', None), ('migrationOrigin', None),
                ('guards', {}), ('freeBytes', 6 * 1024**3)]:
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
        for key, value in [('configurationSha256', '9' * 64), ('containerId', None), ('extra', 'unsealed')]:
            malformed = copy.deepcopy(self.before)
            malformed['services']['online-recharge'][key] = value
            cases.append(malformed)
        for value in cases:
            with self.subTest(receipt=value), self.assertRaisesRegex(RuntimeError, 'ONLINE_ORIGIN_RECEIPT_CHANGED'):
                transport.validate_online_workspace_receipt(self.namespace, value, PREVIOUS, 'preflight')

    def test_successor_readback_binds_same_run_origin_and_actual_rebound(self):
        self.assertTrue(self.validate_readback())
        for key, value in [('mode', 'readback'), ('commit', '9' * 40),
                ('releaseCandidateCommit', '9' * 40), ('workflowRunId', '124'),
                ('workflowRunAttempt', '2'), ('onlineRechargeOrigin', None)]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.validate_readback(before={**self.before, key: value})
        for key, value in [('preservedOnlineRechargeOrigin', {}), ('servicesRebound', []),
                ('migrationPerformed', True), ('onlineNetworkRebind', {})]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.validate_readback({**self.receipt, key: value})
        with self.assertRaises(RuntimeError):
            self.validate_readback(before={})
        with self.assertRaises(RuntimeError):
            self.validate_readback(environment={**self.environment, 'EXPECTED_CURRENT': '9' * 40})
        for key, value in [('GITHUB_RUN_ID', '124'), ('GITHUB_RUN_ATTEMPT', '2')]:
            with self.subTest(environment=key), self.assertRaises(RuntimeError):
                self.validate_readback(environment={**self.environment, key: value})

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
        for side, key, value in [('before', 'apiContainerId', '9' * 64),
                ('after', 'volumeIdentitySha256', '9' * 64), ('after', 'extra', 'unsealed')]:
            receipt = copy.deepcopy(self.receipt)
            receipt['onlineNetworkRebind'][side][key] = value
            with self.subTest(side=side, key=key), self.assertRaises(RuntimeError):
                self.validate_readback(receipt)
        for key, value in [('sameConnection', False), ('busyCount', 1), ('businessActions', True)]:
            receipt = copy.deepcopy(self.receipt)
            receipt['onlineNetworkRebind']['sqlFence'][key] = value
            with self.subTest(fence=key), self.assertRaises(RuntimeError):
                self.validate_readback(receipt)

    def test_omitted_successor_fields_cannot_fall_back_after_online_preflight(self):
        with self.assertRaises(RuntimeError):
            self.validate_readback({'services': {'api': {}, 'admin': {}, 'caddy': {}}})

    def test_other_valid_first_publication_origin_cannot_enter_this_baseline(self):
        foreign = {**copy.deepcopy(self.origin), 'commit': '9' * 40,
            'release': '/opt/id-business-v2/releases/20261009T000000Z-' + '9' * 12}
        transport.validate_online_origin(self.namespace, foreign)
        # A later Workspace predecessor legitimately retains the initial online commit.
        continued = {**self.before, 'commit': '9' * 40}
        self.assertTrue(transport.validate_online_workspace_receipt(self.namespace,
            continued, '9' * 40, 'preflight'))
        self.assertTrue(self.validate_readback(before=continued,
            environment={**self.environment, 'EXPECTED_CURRENT': '9' * 40}))
        before = {**self.before, 'onlineRechargeOrigin': foreign}
        receipt = {**self.receipt, 'preservedOnlineRechargeOrigin': self.namespace['online_marker'](foreign)}
        with self.assertRaisesRegex(RuntimeError, 'ONLINE_ORIGIN_RECEIPT_CHANGED'):
            self.validate_readback(before=before)
        with self.assertRaisesRegex(RuntimeError, 'ONLINE_ORIGIN_RECEIPT_CHANGED'):
            self.validate_readback(receipt)

    def full_readback_contract(self):
        acceptance = {'status': 'PASS', 'checks': ['private-health', 'packaged-resources', 'private-sqlite',
            'encrypted-storage', 'restart-persistence', 'wrong-key-rejected'],
            'businessActions': 0, 'temporaryVolumeRemoved': True}
        proof = {'version': 1, 'scope': 'API_ADMIN_WORKSPACE', 'commit': COMMIT, 'sourceTree': TREE,
            'images': {name: {'reference': f'{REPOSITORY}:{COMMIT}-123-1-{name}',
                'imageId': 'sha256:' + str(index) * 64, 'fileCount': 1, 'sha256': str(index) * 64}
                for index, name in enumerate(('api', 'admin'), 1)},
            'configuration': {'composeSha256': 'c' * 64,
                'caddySha256': self.namespace['WORKSPACE_CADDY_AFTER'],
                'volume': self.namespace['WORKSPACE_VOLUME'],
                'containerDirectory': self.namespace['WORKSPACE_DIRECTORY']},
            'acceptance': acceptance}
        receipt = {**copy.deepcopy(self.receipt), 'status': 'API_ADMIN_WORKSPACE_VERIFIED',
            'commit': COMMIT, 'sourceTree': TREE, 'buildProofSha256': self.namespace['fingerprint'](proof),
            'servicesUpdated': list(self.namespace['UPDATED']), 'preservedServiceCount': 4,
            'runningImagesAndContentMatched': True, 'environmentUnchanged': True,
            'workspaceVolume': copy.deepcopy(self.volume),
            'volumePreserved': True, 'volumeDeletionPerformed': False, 'registrationHealthChecked': True,
            'offlineAcceptance': acceptance}
        for name, row in proof['images'].items():
            receipt['services'][name].update(image=row['imageId'], reference=row['reference'])
        return proof, receipt

    def test_real_proof_and_both_origins_integrate_with_full_independent_preflight_and_readback(self):
        self.assertEqual(transport.validate_receipt(self.before, PREVIOUS, 'preflight',
            'API_ADMIN_WORKSPACE'), self.before)
        proof, receipt = self.full_readback_contract()
        def read(path):
            return json.dumps(proof if path.name == self.namespace['PROOF_FILE'] else self.before)
        with patch.object(Path, 'is_file', return_value=True), patch.object(Path, 'read_text', read), \
                patch.dict(os.environ, self.environment, clear=True):
            self.assertEqual(transport.validate_receipt(receipt, COMMIT, 'readback',
                'API_ADMIN_WORKSPACE'), receipt)
            with self.assertRaisesRegex(RuntimeError, 'READBACK_BUILD_CHANGED'):
                transport.validate_receipt({**receipt, 'servicesUpdated': [*self.namespace['UPDATED'], 'online-recharge']},
                    COMMIT, 'readback', 'API_ADMIN_WORKSPACE')
            changed = copy.deepcopy(receipt)
            changed['services']['api']['image'] = 'sha256:' + '9' * 64
            with self.assertRaisesRegex(RuntimeError, 'READBACK_BUILD_CHANGED'):
                transport.validate_receipt(changed, COMMIT, 'readback', 'API_ADMIN_WORKSPACE')
            protection = {'backupVerified': True, 'restoreVerified': True,
                'sqliteProtectionSha256': '1' * 64, 'backupSha256': '2' * 64, 'backupSize': 4096}
            self.assertEqual(transport.validate_receipt({**receipt, 'sqliteProtection': protection},
                COMMIT, 'readback', 'API_ADMIN_WORKSPACE')['sqliteProtection'], protection)
            for key, value in [('backupVerified', False), ('restoreVerified', False),
                    ('backupSize', 0), ('backupSha256', 'invalid')]:
                with self.subTest(sqlite=key), self.assertRaisesRegex(RuntimeError, 'SQLITE_RECEIPT_CHANGED'):
                    transport.validate_receipt({**receipt, 'sqliteProtection': {**protection, key: value}},
                        COMMIT, 'readback', 'API_ADMIN_WORKSPACE')

    def test_coexisting_origins_preflight_refuses_omission_unknown_services_and_wrong_migration(self):
        cases = []
        for key in ('onlineRechargeOrigin', 'migrationOrigin'):
            omitted = copy.deepcopy(self.before); omitted.pop(key); cases.append((key, omitted))
        unknown = copy.deepcopy(self.before)
        unknown['services']['unapproved-service'] = copy.deepcopy(self.services['mysql'])
        cases.append(('unknown-service', unknown))
        foreign = copy.deepcopy(self.before); foreign['migrationOrigin']['commit'] = '9' * 40
        cases.append(('wrong-migration-origin', foreign))
        wrong_guards = copy.deepcopy(self.before); wrong_guards['guards']['registrationBusy'] = True
        cases.append(('wrong-guards', wrong_guards))
        cases.append(('insufficient-disk', {**copy.deepcopy(self.before), 'freeBytes': 6 * 1024**3}))
        stopped = copy.deepcopy(self.before); stopped['services']['mysql']['status'] = 'exited'
        cases.append(('stopped-service', stopped))
        for label, value in cases:
            with self.subTest(label=label), self.assertRaises(RuntimeError):
                transport.validate_receipt(value, PREVIOUS, 'preflight', 'API_ADMIN_WORKSPACE')

    def test_coexisting_origins_readback_refuses_omission_unknown_services_and_wrong_migration(self):
        proof, valid = self.full_readback_contract()
        cases = []
        for key in ('onlineRechargeOrigin', 'migrationOrigin'):
            before = copy.deepcopy(self.before); before.pop(key)
            cases.append((key, before, copy.deepcopy(valid)))
        for key in ('preservedOnlineRechargeOrigin', 'preservedMigrationOrigin'):
            receipt = copy.deepcopy(valid); receipt.pop(key)
            cases.append((key, copy.deepcopy(self.before), receipt))
        # Removing both migration fields must not fall back to an origin-free path.
        before = copy.deepcopy(self.before); before.pop('migrationOrigin')
        receipt = copy.deepcopy(valid); receipt.pop('preservedMigrationOrigin')
        cases.append(('both-migration-fields', before, receipt))
        foreign = copy.deepcopy(self.before); foreign['migrationOrigin']['migration']['sha256'] = '9' * 64
        cases.append(('wrong-migration-origin', foreign, copy.deepcopy(valid)))
        unknown = copy.deepcopy(valid)
        unknown['services']['unapproved-service'] = copy.deepcopy(self.services['mysql'])
        cases.append(('unknown-service', copy.deepcopy(self.before), unknown))
        for label, before, receipt in cases:
            def read(path):
                return json.dumps(proof if path.name == self.namespace['PROOF_FILE'] else before)
            with self.subTest(label=label), patch.object(Path, 'is_file', return_value=True), \
                    patch.object(Path, 'read_text', read), patch.dict(os.environ, self.environment, clear=True), \
                    self.assertRaises(RuntimeError):
                transport.validate_receipt(receipt, COMMIT, 'readback', 'API_ADMIN_WORKSPACE')

    def test_original_api_admin_migration_origin_remains_exactly_seven_services(self):
        receipt = copy.deepcopy(self.before); receipt['status'] = 'API_ADMIN_BASELINE_VERIFIED'
        for key in ('onlineRechargeOrigin',):
            receipt.pop(key)
        receipt['services'].pop('online-recharge')
        self.assertEqual(transport.validate_receipt(receipt, PREVIOUS, 'preflight', 'API_ADMIN'), receipt)
        receipt['services']['online-recharge'] = copy.deepcopy(self.services['online-recharge'])
        with self.assertRaisesRegex(RuntimeError, 'MIGRATION_ORIGIN_RECEIPT_CHANGED'):
            transport.validate_receipt(receipt, PREVIOUS, 'preflight', 'API_ADMIN')


if __name__ == '__main__':
    unittest.main()
