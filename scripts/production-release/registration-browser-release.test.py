"""Pure control checks. No socket, SQLite connection, website or production action."""
import copy
import importlib.util
import inspect
import json
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUTPUT = ROOT / '.runtime/registration-browser-20261016/control-tests'


def load(name):
    spec = importlib.util.spec_from_file_location('browser_test_' + name.replace('-', '_'), HERE / name)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


r = load('registration-browser-release.py')
b = load('registration-browser-build.py')
d = load('registration-browser-dispatch.py')


class BrowserReleaseControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        OUTPUT.mkdir(parents=True, exist_ok=True)
        cls.contract = json.loads((HERE / 'registration-browser-contract.json').read_bytes())

    def setUp(self):
        self.socket = patch.object(socket.socket, 'connect', side_effect=AssertionError('SOCKET_FORBIDDEN'))
        self.sqlite = patch.object(sqlite3, 'connect', side_effect=AssertionError('SQLITE_FORBIDDEN'))
        self.socket.start()
        self.sqlite.start()
        self.addCleanup(self.socket.stop)
        self.addCleanup(self.sqlite.stop)

    def frozen(self):
        value = copy.deepcopy(self.contract)
        value['frozen'] = True
        value['expectedGitChanges'] = sorted(set(value['sources']) | set(value['validationSources']) | set(value['controlPaths']))
        value['sourceDeltaPaths'] = value['expectedGitChanges']
        value['reviewedFileHashes'] = {name: 'a' * 64 for name in value['expectedGitChanges']
            if name != 'scripts/production-release/registration-browser-contract.json'}
        return value

    def test_prior_files_are_exact_and_old_native_proof_still_requires_success(self):
        prior = r.prior_recipe()
        self.assertEqual(prior['expectedCurrent'], 'c0238525bb4b2a1c3fe6688eaed5f74f504ee529')
        for name, expected in r.PRIOR_CONTROLS.items():
            self.assertEqual(r.digest((HERE / name).read_bytes()), expected)
        original = (HERE / 'registration-parity-diagnostics-build.py').read_text()
        self.assertIn("meta['conclusion'] == 'success'", original)

    def test_frozen_contract_and_current_native_are_admitted(self):
        r.verify_contract(self.frozen())
        r.verify_predecessor_binding(self.contract['predecessorNative'])

    def test_unfrozen_every_build_mode_stops_before_process_and_output(self):
        contract = {**self.contract, 'frozen': False}
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary:
            path = Path(temporary) / 'contract.json'
            path.write_text(json.dumps(contract))
            output = Path(temporary) / 'uncreated'
            with patch.object(b, 'CONTRACT', path), patch.object(b, 'OUTPUT', output), \
                    patch.object(b, 'run') as execute, patch.object(b, 'published_proof') as native:
                for mode in ('prepare', 'build', 'validate', 'package'):
                    with self.subTest(mode=mode), self.assertRaisesRegex(RuntimeError, 'CONTRACT_NOT_FROZEN'):
                        getattr(b, mode)()
                execute.assert_not_called()
                native.assert_not_called()
                self.assertFalse(output.exists())

    def test_unfrozen_all_remote_modes_stop_before_driver_and_helpers(self):
        for mode in ('preflight', 'release', 'readback'):
            driver, helper = Mock(), Mock()
            with self.subTest(mode=mode), patch.object(r, 'helper') as imports, \
                    self.assertRaisesRegex(RuntimeError, 'CONTRACT_NOT_FROZEN'):
                r.release({'mode': mode}, {**self.contract, 'frozen': False}, driver, helper)
            self.assertFalse(driver.mock_calls)
            imports.assert_not_called()

    def test_unfrozen_dispatch_has_no_platform_action(self):
        with patch.object(d, 'verified_contract', side_effect=RuntimeError('CONTRACT_NOT_FROZEN')), \
                patch.object(d, 'execute') as execute:
            for action in (d.prepare_plan, lambda: d.transport({}, 'release')):
                with self.assertRaisesRegex(RuntimeError, 'CONTRACT_NOT_FROZEN'):
                    action()
            execute.assert_not_called()

    def test_only_exact_prior_failed_run_is_eligible(self):
        for changed in ({'runId': '38883922526'}, {'originalRunConclusion': 'success'},
                        {'forwardCommandId': 'unknown'}, {'artifactId': 1}, {'commit': '0' * 40},
                        {'instanceId': 'another-instance'}, {'proofSha256': '0' * 64}):
            with self.subTest(changed=changed), patch.object(b.subprocess, 'check_output') as external, \
                    self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_NATIVE_BINDING_CHANGED'):
                b.published_proof({**self.contract['predecessorNative'], **changed})
            external.assert_not_called()

    def forward_fixture(self):
        result = {'status': 'ORIGINAL_RELEASE_FORWARD_FINALIZED', 'commit': r.CURRENT,
            'workflowRunId': '38883922525', 'originalGithubRunConclusion': 'failure',
            'originalReleaseCommandId': self.contract['predecessorNative']['originalReleaseCommandId'],
            'maintenanceReleased': True, 'migrationPerformed': False, 'businessActions': 0,
            'newBuilds': 0, 'newBackups': 0, 'restarts': 0,
            'independentReadback': {'status': 'REGISTRATION_PARITY_DIAGNOSTICS_INDEPENDENT_READBACK_VERIFIED',
                'commit': r.CURRENT, 'maintenanceReleased': True, 'migrationPerformed': False,
                'businessActions': 0, 'updatedServices': ['api', 'admin'], 'reboundServices': ['online-recharge']},
            'originalTailResult': {'status': 'REGISTRATION_PARITY_DIAGNOSTICS_DEPLOYED',
                'commit': r.CURRENT, 'tree': r.CURRENT_TREE, 'migrationPerformed': False,
                'businessActions': 0, 'updatedServices': ['api', 'admin'], 'reboundServices': ['online-recharge']}}
        native = {'CommandId': r.FORWARD_COMMAND, 'InstanceId': r.INSTANCE, 'DocumentName': 'AWS-RunShellScript',
            'Status': 'Success', 'ResponseCode': 0, 'StandardErrorContent': '',
            'StandardOutputContent': json.dumps(result)}
        binding = {**self.contract['predecessorNative'], 'forwardNativeSha256': r.digest(r.canonical(native))}
        return native, binding

    def test_forward_receipt_needs_original_identity_and_independent_readback(self):
        native, binding = self.forward_fixture()
        self.assertEqual(r.verify_forward_native(native, binding)['commit'], r.CURRENT)
        for changed in ({'Status': 'Failed'}, {'ResponseCode': 1}, {'CommandId': 'different'},
                        {'StandardErrorContent': 'unsafe'}, {'InstanceId': 'different'}):
            with self.subTest(changed=changed), self.assertRaisesRegex(RuntimeError, 'FORWARD_RECEIPT_CHANGED'):
                r.verify_forward_native({**native, **changed}, binding)
        result = json.loads(native['StandardOutputContent'])
        result['independentReadback']['maintenanceReleased'] = False
        native['StandardOutputContent'] = json.dumps(result)
        binding['forwardNativeSha256'] = r.digest(r.canonical(native))
        with self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_READBACK_CHANGED'):
            r.verify_forward_native(native, binding)

    def test_dispatch_checks_original_ssm_before_any_new_release(self):
        with patch.object(d, 'verified_contract', return_value=(b'', self.contract)), \
                patch.object(d, 'execute', return_value=b'{}') as execute, \
                self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_FORWARD_RECEIPT_CHANGED'):
            d.prepare_plan()
        self.assertEqual(execute.call_count, 1)
        self.assertEqual(execute.call_args.args[:3], ('aws', 'ssm', 'get-command-invocation'))

    def row(self):
        return {'Config': {'Labels': {'com.docker.compose.service': 'api'}, 'Env': ['B=2', 'A=1'],
                'Hostname': 'actual', 'Image': 'actual'},
            'HostConfig': {'Binds': ['registration-volume:/app/.runtime/auto-registration:rw',
                'online-volume:/app/.runtime/online-recharge:rw'], 'ReadonlyRootfs': False},
            'Mounts': [{'Source': '/actual/registration', 'Destination': r.BIND_DESTINATIONS[0]},
                       {'Source': '/actual/online', 'Destination': r.BIND_DESTINATIONS[1]}]}

    def config_hash(self, row):
        driver = Mock()
        driver.run.return_value = json.dumps([row])
        h = r.helper('recharge-record-release.py')
        value = r.configuration(driver, {'containerId': 'synthetic'}, h.configuration)
        self.assertEqual(driver.run.call_count, 1)
        return value

    def test_complete_bind_permutation_is_equivalent_and_input_is_not_changed(self):
        original = self.row()
        swapped = copy.deepcopy(original)
        swapped['HostConfig']['Binds'].reverse()
        self.assertEqual(self.config_hash(original), self.config_hash(swapped))
        self.assertNotEqual(original, swapped)
        self.assertEqual(r.canonical_bindings(swapped), original)
        absolute = self.row()
        absolute['HostConfig']['Binds'][0] = '/host/registration:/app/.runtime/auto-registration:rw'
        self.assertNotEqual(self.config_hash(original), self.config_hash(absolute))

    def test_source_permissions_mount_env_and_other_host_fields_are_not_normalized_away(self):
        baseline = self.config_hash(self.row())
        for mutate in (
            lambda row: row['HostConfig']['Binds'].__setitem__(0, 'different-volume:/app/.runtime/auto-registration:rw'),
            lambda row: row['HostConfig']['Binds'].__setitem__(0, 'registration-volume:/app/.runtime/auto-registration:ro'),
            lambda row: row['Mounts'][0].__setitem__('Source', '/different'),
            lambda row: row['Config']['Env'].append('EXTRA=1'),
            lambda row: row['HostConfig'].__setitem__('ReadonlyRootfs', True)):
            row = self.row()
            mutate(row)
            with self.subTest(row=row):
                self.assertNotEqual(self.config_hash(row), baseline)

    def test_extra_duplicate_nested_and_unknown_bind_destinations_are_rejected(self):
        for binds in (
            self.row()['HostConfig']['Binds'] + ['third:/another:rw'],
            ['a:/app/.runtime/auto-registration:rw', 'b:/app/.runtime/auto-registration:rw'],
            ['a:/app/.runtime/auto-registration:rw', 'b:/app/.runtime/auto-registration/nested:rw'],
            ['a:/unknown:rw', 'b:/app/.runtime/online-recharge:rw']):
            row = self.row()
            row['HostConfig']['Binds'] = binds
            with self.subTest(binds=binds), self.assertRaisesRegex(RuntimeError, 'API_BIND_SCOPE_CHANGED'):
                self.config_hash(row)

    def test_other_role_uses_original_configuration_without_bind_sorting(self):
        row = self.row()
        row['Config']['Labels']['com.docker.compose.service'] = 'other'
        driver, original = Mock(), Mock(return_value='unchanged')
        driver.run.return_value = json.dumps([row])
        state = {'containerId': 'synthetic'}
        self.assertEqual(r.configuration(driver, state, original), 'unchanged')
        original.assert_called_once_with(driver, state)

    def test_frozen_publisher_bytecode_retains_lock_backups_smoke_and_readback(self):
        old = r.helper('registration-parity-diagnostics-release.py')
        namespace = r.private_namespace('registration-parity-diagnostics-release.py', {})
        for name in ('release', 'baseline', 'smoke', 'backup_sqlite', 'inherited_host_source'):
            self.assertEqual(namespace[name].__code__.co_code, getattr(old, name).__code__.co_code)
            self.assertIs(namespace[name].__globals__, namespace)
        names = namespace['release'].__code__.co_names
        for name in ('acquire_release_lock', 'baseline', 'fresh_scoped_backup', 'backup_sqlite',
                     'sql_fence_class', 'assert_no_active_recharge', 'assert_no_active_registration',
                     'smoke', 'release_markers', 'point_current'):
            self.assertIn(name, names)
        self.assertEqual(namespace['CURRENT'], r.CURRENT)
        self.assertEqual(old.CURRENT, 'c0238525bb4b2a1c3fe6688eaed5f74f504ee529')

    def test_private_functions_preserve_keyword_defaults_and_signature(self):
        for filename in r.PRIOR_CONTROLS:
            if not filename.endswith('.py'):
                continue
            old = r.helper(filename)
            namespace = r.private_namespace(filename, {})
            for name, function in vars(old).items():
                if isinstance(function, types.FunctionType) and function.__globals__ is vars(old):
                    with self.subTest(file=filename, function=name):
                        self.assertEqual(inspect.signature(namespace[name]), inspect.signature(function))
                        self.assertEqual(namespace[name].__kwdefaults__, function.__kwdefaults__)
        # Client inventory intentionally omits javascript_only; retain False.
        namespace = r.private_namespace('registration-parity-diagnostics-release.py', {})
        driver = Mock()
        driver.run.return_value = '{}'
        namespace['api_inventory'](driver, {'containerId': 'synthetic'}, '/client/', {})
        driver.run.assert_called_once()

    def test_sqlite_old_facts_and_princes_task_must_be_preserved(self):
        c = self.contract
        policy = c['sqliteReviewPolicy']
        expected = {'version': 1, 'status': 'PASS', **policy['summary'], 'activeAppleLeaseCount': 1,
            'executingTaskCount': 0, 'retainedReviewLeaseCount': 1, 'corruptEncryptedValueCount': 0,
            'leaseFacts': policy['leaseFacts'], 'protectedTaskFacts': policy['protectedTaskFacts'],
            'dependencies': c['runtimePythonDependencies'], 'businessActions': 0}
        self.assertEqual(r.validate_sqlite_receipt(expected, c), expected)
        self.assertEqual(policy['protectedTaskFacts'][3]['taskUuid'], '60bb7317-6a91-49aa-9593-b3cf063f642b')
        for key in ('protectedTaskFacts', 'leaseFacts', 'summary'):
            moved = copy.deepcopy(expected)
            moved[key] = {} if key == 'summary' else []
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'SQLITE_PRESERVATION_CHANGED'):
                r.validate_sqlite_receipt(moved, c)
        source = r.sqlite_inspection_source()
        self.assertIn("for task in cfg['protectedTaskUuids']:", source)
        self.assertIn("assert leases==cfg['expectedLeaseCount']", source)
        self.assertIn('mode=ro', source)
        self.assertIn('PRAGMA query_only=ON', source)

    def test_client_schema_dependencies_and_engine_cannot_change(self):
        for key in ('schemaSha256', 'baselinePrismaClientFiles', 'runtimePrismaClientFiles',
                    'runtimePythonDependencies', 'baselineEngineFiles', 'unchangedInputs',
                    'accountSources', 'checkoutSources', 'parentNative', 'sourceTreeInputs'):
            value = self.frozen()
            value[key] = 'changed'
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'PRESERVED_INPUT_CHANGED'):
                r.verify_contract(value)

    def test_api_delta_allows_reviewed_new_modules_but_no_other_output_or_deletion(self):
        old = {'id-business-v2/auto-registration/existing.js': 'old'}
        new = {**old, 'id-business-v2/auto-registration/browser.js': 'new'}
        approved = {'id-business-v2/auto-registration/browser.js': None}
        self.assertEqual(b.api_delta(old, new, approved), {'id-business-v2/auto-registration/browser.js': 'new'})
        for changed in ({**new, 'unrelated.js': 'x'}, {}, {'unrelated.js': 'x'}):
            with self.subTest(changed=changed), self.assertRaisesRegex(RuntimeError, 'API_OUTPUT_SCOPE_CHANGED'):
                b.api_delta(old, changed, approved)

    def test_workflow_is_manual_single_flight_and_has_all_validation_stages(self):
        source = (ROOT / '.github/workflows/registration-browser-validation.yml').read_text()
        self.assertIn('workflow_dispatch:', source)
        self.assertIn('default: false', source)
        self.assertIn('group: id-business-v2-production-release', source)
        self.assertIn('cancel-in-progress: false', source)
        for suffix in ('prepare', 'build', 'validate', 'package'):
            self.assertIn('registration-browser-build.py ' + suffix, source)
        self.assertIn('registration-browser-release.test.py', source)
        self.assertIn('registration-browser-dispatch.py', source)
        self.assertIn('if: always()', source)

    def test_actual_cli_entries_dispatch_only_the_requested_public_mode(self):
        harness = r'''import json,runpy,subprocess,socket,sqlite3,sys
from pathlib import Path
from unittest.mock import patch
script=Path(sys.argv[1]).resolve();mode=sys.argv[2];args=json.loads(sys.argv[3]);calls=[]
class Captured(Exception):pass
def observe(frame,event,arg):
 if event=='call' and Path(frame.f_code.co_filename).resolve()==script and frame.f_code.co_name==mode:
  calls.append(mode);raise Captured()
def forbidden(*a,**k):raise AssertionError('EXTERNAL_FORBIDDEN')
sys.argv=[str(script),*args]
with patch.object(subprocess,'run',forbidden),patch.object(subprocess,'check_output',forbidden),patch.object(socket.socket,'connect',forbidden),patch.object(sqlite3,'connect',forbidden):
 sys.setprofile(observe)
 try:runpy.run_path(str(script),run_name='__main__')
 except Captured:pass
 finally:sys.setprofile(None)
print(json.dumps(calls))
'''
        for suffix, mode, arguments in [*[('build.py', m, [m]) for m in ('prepare', 'build', 'validate', 'package')],
                                         ('dispatch.py', 'publish', [])]:
            script = HERE / ('registration-browser-' + suffix)
            result = subprocess.run([sys.executable, '-B', '-c', harness, str(script), mode, json.dumps(arguments)],
                                    cwd=ROOT, check=True, capture_output=True, text=True, timeout=15)
            self.assertEqual(json.loads(result.stdout), [mode])
            self.assertFalse(result.stderr)


if __name__ == '__main__':
    unittest.main()
