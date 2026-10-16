"""Successor controls; CI-only guards additionally generate one static client without a database."""
import ast
from contextlib import redirect_stdout
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import Mock, patch
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUTPUT = ROOT / '.runtime/registration-parity-20261016/control-tests'


def load(name):
    spec = importlib.util.spec_from_file_location('parity_control_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


b = load('registration-parity-diagnostics-build.py')
r = load('registration-parity-diagnostics-release.py')
dispatch = load('registration-parity-diagnostics-dispatch.py')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


class ParityDiagnosticsControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        OUTPUT.mkdir(parents=True, exist_ok=True)
        cls.contract = json.loads((HERE / 'registration-parity-diagnostics-contract.json').read_bytes())

    def test_historical_executors_and_contract_remain_byte_exact(self):
        self.assertEqual(b.PARENT_CONTROLS, r.PARENT_CONTROLS)
        for name, expected in b.PARENT_CONTROLS.items():
            self.assertEqual(digest((HERE / name).read_bytes()), expected, name)
        self.assertEqual(b.PARENT_CONTROLS['registration-flow-evidence-contract.json'],
                         '9d5f34916800fb885cb8aabd98bb550900775f47f17d666c8ad40a26f65215ae')

    def test_direct_python_cli_reaches_each_mode_without_external_calls(self):
        # Execute the actual __main__ branch in a fresh interpreter. A profile
        # hook stops at the real mode function before its first statement;
        # platform/process calls are mocked to fail if any escape that hook.
        harness = r'''import json,runpy,socket,subprocess,sys,urllib.request
from pathlib import Path
from unittest.mock import patch
script=Path(sys.argv[1]).resolve();mode=sys.argv[2];arguments=json.loads(sys.argv[3]);calls=[]
class Captured(Exception):pass
def observe(frame,event,arg):
 if event=='call' and Path(frame.f_code.co_filename).resolve()==script and frame.f_code.co_name==mode:
  calls.append(frame.f_code.co_name);raise Captured()
def forbidden(*args,**kwargs):raise AssertionError('UNEXPECTED_EXTERNAL_CALL')
sys.argv=[str(script),*arguments]
with patch.object(subprocess,'run',forbidden),patch.object(subprocess,'check_output',forbidden),patch.object(urllib.request,'urlopen',forbidden),patch.object(socket.socket,'connect',forbidden):
 sys.setprofile(observe)
 try:runpy.run_path(str(script),run_name='__main__')
 except Captured:pass
 finally:sys.setprofile(None)
print(json.dumps(calls))
'''
        for suffix, mode, arguments in [
                *[('build.py', mode, [mode]) for mode in ('prepare', 'build', 'validate', 'package')],
                ('dispatch.py', 'publish', [])]:
            script = HERE / ('registration-parity-diagnostics-' + suffix)
            with self.subTest(mode=mode):
                completed = subprocess.run([sys.executable, '-B', '-c', harness, str(script), mode,
                                            json.dumps(arguments)], cwd=ROOT, capture_output=True, text=True,
                                           timeout=15, check=True)
                self.assertEqual(json.loads(completed.stdout), [mode])
                self.assertEqual(completed.stderr, '')

    def test_unfrozen_build_modes_stop_before_outputs_or_subprocesses(self):
        contract = {**self.contract, 'frozen': False}
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary:
            source = Path(temporary) / 'contract.json'
            source.write_text(json.dumps(contract))
            output = Path(temporary) / 'uncreated'
            with patch.object(b, 'CONTRACT', source), patch.object(b, 'OUTPUT', output), \
                    patch.object(b, 'run') as execute, patch.object(b, 'native_proof') as native:
                for mode in ('prepare', 'build', 'validate', 'package'):
                    with self.subTest(mode=mode), self.assertRaisesRegex(RuntimeError, 'CONTRACT_NOT_FROZEN'):
                        getattr(b, mode)()
                execute.assert_not_called()
                native.assert_not_called()
                self.assertFalse(output.exists())

    def test_unfrozen_preflight_release_readback_stop_before_helpers_or_driver(self):
        for mode in ('preflight', 'release', 'readback'):
            driver = Mock()
            with self.subTest(mode=mode), patch.object(r, 'helper') as helper, \
                    self.assertRaisesRegex(RuntimeError, 'CONTRACT_NOT_FROZEN'):
                r.release({'mode': mode}, {**self.contract, 'frozen': False}, driver, Mock())
            helper.assert_not_called()
            self.assertFalse(driver.mock_calls)

    def test_unfrozen_dispatch_stops_before_platform_calls(self):
        raw = json.dumps({**self.contract, 'frozen': False}).encode()
        original = Path.read_bytes

        def read(path):
            return raw if path.name == 'registration-parity-diagnostics-contract.json' else original(path)

        with patch.object(Path, 'read_bytes', read), patch.object(dispatch, 'execute') as execute:
            for action in (dispatch.prepare_plan, lambda: dispatch.transport({}, 'preflight')):
                with self.assertRaisesRegex(RuntimeError, 'CONTRACT_NOT_FROZEN'):
                    action()
            execute.assert_not_called()

    def test_parent_tampering_and_missing_runtime_are_rejected(self):
        for patch_value, expected in [
                ({'parentControls': {}}, 'PARENT_CONTROL_CHANGED'),
                ({'parentContractSha256': '0' * 64}, 'PARENT_EVIDENCE_CHANGED'),
                ({'parentProofSha256': '0' * 64}, 'PARENT_EVIDENCE_CHANGED'),
                ({'runtimeEvidence': None}, 'RUNTIME_BASELINE_MISSING')]:
            with self.subTest(patch=patch_value), self.assertRaisesRegex(RuntimeError, expected):
                r.verify_contract({**self.contract, 'frozen': True,
                                   'successorProofSha256': r.SUCCESSOR_PROOF, **patch_value})
        with patch.object(r, 'digest', return_value='0' * 64), \
                self.assertRaisesRegex(RuntimeError, 'PARENT_CONTROL_CHANGED'):
            r.verify_contract({**self.contract, 'frozen': True})

    def test_published_successor_recipe_and_native_proof_are_separately_pinned(self):
        self.assertEqual(b.SUCCESSOR_CONTROLS, r.SUCCESSOR_CONTROLS)
        for name, expected in b.SUCCESSOR_CONTROLS.items():
            self.assertEqual(digest((HERE / name).read_bytes()), expected, name)
        for patch_value in [{'successorControls': {}}, {'successorProofSha256': '0' * 64},
                            {'successorContractSha256': '0' * 64}]:
            with self.subTest(patch=patch_value), \
                    self.assertRaisesRegex(RuntimeError, 'PUBLISHED_SUCCESSOR_EVIDENCE_CHANGED'):
                r.verify_contract({**self.contract, 'frozen': True, **patch_value})

    def test_admin_successor_is_only_three_sources_over_the_exact_sales_compilation(self):
        self.assertEqual(b.DRAG_CONTROLS, r.DRAG_CONTROLS)
        for name, expected in b.DRAG_CONTROLS.items():
            self.assertEqual(digest((HERE / name).read_bytes()), expected, name)
        recipe = json.loads((HERE / 'workspace-drag-contract.json').read_bytes())
        sales = {'adminFiles': {'index.html': 'a' * 64}}
        proof = {'version': 1, 'scope': recipe['scope'], 'commit': b.DRAG_COMMIT, 'tree': b.DRAG_TREE,
                 'contractSha256': b.DRAG_CONTROLS['workspace-drag-contract.json'],
                 'controllerSha256': b.DRAG_CONTROLS['workspace-drag-release.py'],
                 'publishedProofSha256': b.SUCCESSOR_PROOF, 'sources': recipe['sources'],
                 'baselineAdminFiles': sales['adminFiles'], 'adminFiles': {'index.html': 'b' * 64},
                 'updatedServices': ['admin'], 'migrationPerformed': False, 'businessActions': 0,
                 'browserChecks': 13}
        proof['files'] = {**{'source/' + n: v for n, v in recipe['sources'].items()},
                          'admin/html/index.html': 'b' * 64}
        self.assertEqual(b.verify_drag_proof(proof, sales, self.contract), proof)
        for changed in [{'sources': {**proof['sources'], 'unreviewed.ts': 'c' * 64}},
                        {'baselineAdminFiles': {}}, {'publishedProofSha256': '0' * 64},
                        {'updatedServices': ['api', 'admin']}, {'migrationPerformed': True},
                        {'businessActions': False}, {'controllerSha256': '0' * 64}]:
            with self.subTest(changed=changed), self.assertRaisesRegex(RuntimeError, 'PUBLISHED_ADMIN_SUCCESSOR_NATIVE_CHANGED'):
                b.verify_drag_proof({**proof, **changed}, sales, self.contract)
        with self.assertRaisesRegex(RuntimeError, 'PUBLISHED_ADMIN_SUCCESSOR_PAYLOAD_CHANGED'):
            b.verify_drag_proof({**proof, 'files': {}}, sales, self.contract)

    def test_account_publication_is_bound_to_separate_source_and_controller_identities(self):
        recipe = b.verify_account_binding(self.contract)
        self.assertEqual(len(self.contract['accountSources']), 107)
        self.assertEqual(self.contract['accountSources'], {**recipe['sources'], **recipe['supportSources']})
        self.assertNotEqual(b.ACCOUNT_COMMIT, b.ACCOUNT_CONTROLLER)
        self.assertNotEqual(b.ACCOUNT_COMMIT, b.DRAG_COMMIT)
        for changed in [{'controllerCommit': b.ACCOUNT_COMMIT}, {'commit': b.ACCOUNT_CONTROLLER},
                        {'runId': '38878982040'}, {'artifactId': 1}, {'proofSha256': '0' * 64}]:
            with self.subTest(changed=changed), patch.object(b.subprocess, 'check_output') as remote, \
                    self.assertRaisesRegex(RuntimeError, 'ACCOUNT_NATIVE_BINDING_CHANGED'):
                b.native_proof({**self.contract['accountNative'], **changed})
            remote.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, 'ACCOUNT_SOURCE_SCOPE_CHANGED'):
            b.account_recipe({**self.contract, 'accountSources': recipe['sources']})

    def test_account_overlay_uses_only_the_exact_published_tree(self):
        values = {'apps/api/known.ts': b'published API', 'scripts/known.mjs': b'published support'}
        contract = {'accountSources': {name: digest(raw) for name, raw in values.items()}}
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary, \
                patch.object(b, 'account_recipe', return_value={'hostSources': {}}), \
                patch.object(b, 'git', side_effect=lambda *args: values[args[1].split(':', 1)[1]]) as read:
            context = Path(temporary)
            b.overlay_account_sources(context, contract)
            self.assertEqual({name: (context / name).read_bytes() for name in values}, values)
            self.assertEqual(read.call_args_list, [unittest.mock.call('show', b.ACCOUNT_COMMIT + ':' + name)
                                                  for name in values])
            with self.assertRaisesRegex(RuntimeError, 'ACCOUNT_PUBLISHED_SOURCE_CHANGED'):
                b.overlay_account_sources(context, {'accountSources': {'apps/api/known.ts': '0' * 64}})

    def test_account_native_proof_closes_payload_validation_and_final_baseline(self):
        recipe = b.account_recipe(self.contract)
        historical_api = recipe['baselineRuntimeApiFiles']
        modules = {name.removesuffix('.js') + suffix: 'a' * 64 for name in recipe['apiModules']
                   for suffix in ('.js', '.js.map', '.d.ts')}
        admin = {'index.html': 'b' * 64}
        proof = {'version': 1, 'scope': recipe['scope'], 'commit': b.ACCOUNT_COMMIT, 'tree': b.ACCOUNT_TREE,
                 'workflowRunId': '38878982040', 'workflowRunAttempt': '1',
                 'contractSha256': self.contract['accountContractSha256'],
                 'controllerSha256': b.ACCOUNT_VALIDATED_CONTROLLER,
                 'baselineSources': {'api': recipe['apiSourceBaseline'], 'admin': recipe['adminSourceBaseline']},
                 'adminPublishedSources': recipe['adminPublishedSources'], 'hostSources': recipe['hostSources'],
                 'baselineAdminFiles': recipe['baselineAdminFiles'],
                 'baselineApiFiles': {name: historical_api.get(name) for name in modules},
                 'apiModules': modules, 'adminFiles': admin, 'migration': recipe['migration'],
                 'generatedSchemaSha256': self.contract['baselinePrismaClientFiles']['schema.prisma'],
                 'updatedServices': ['api', 'admin'], 'businessActions': 0,
                 'qualityVerification': {'commit': b.ACCOUNT_COMMIT, 'conclusion': 'success',
                     'path': '.github/workflows/quality.yml', 'runId': '38878945118', 'sourceTree': b.ACCOUNT_TREE},
                 'databaseVerification': {'businessActions': 0, 'isolated': True, 'legacyDefaultsVerified': True,
                     'migration': recipe['migration']['name'], 'testsPassed': 7, 'testsSkipped': 0},
                 'browserVerification': {'realWrites': 0, 'status': 'PASS'}}
        proof['files'] = {**{'source/' + n: v for n, v in self.contract['accountSources'].items()},
                          **{'host/' + n: v for n, v in recipe['hostSources'].items()},
                          **{'api/modules/' + n: v for n, v in modules.items()}, 'admin/html/index.html': 'b' * 64}
        contract = {**self.contract, 'baselineAdminFiles': admin,
                    'baselineApiFiles': {**historical_api, **{n: v for n, v in modules.items() if n.endswith('.js')}}}
        drag = {'adminFiles': recipe['baselineAdminFiles']}
        self.assertEqual(b.verify_account_proof(proof, drag, historical_api, contract), proof)
        for changed, error in [({'businessActions': False}, 'ACCOUNT_NATIVE_PROOF_CHANGED'),
                               ({'generatedSchemaSha256': '0' * 64}, 'ACCOUNT_NATIVE_PROOF_CHANGED'),
                               ({'baselineAdminFiles': {}}, 'ACCOUNT_NATIVE_PROOF_CHANGED'),
                               ({'databaseVerification': {}}, 'ACCOUNT_NATIVE_VALIDATION_CHANGED'),
                               ({'browserVerification': {'status': 'PASS', 'realWrites': 1}}, 'ACCOUNT_NATIVE_VALIDATION_CHANGED'),
                               ({'files': {**proof['files'], 'source/unpublished.ts': 'c' * 64}}, 'ACCOUNT_NATIVE_PAYLOAD_CHANGED')]:
            with self.subTest(changed=changed), self.assertRaisesRegex(RuntimeError, error):
                b.verify_account_proof({**proof, **changed}, drag, historical_api, contract)
        with self.assertRaisesRegex(RuntimeError, 'ACCOUNT_FINAL_BASELINE_CHANGED'):
            b.verify_account_proof(proof, drag, historical_api, {**contract, 'baselineAdminFiles': {}})

    def test_account_publication_requires_successful_release_and_independent_readback(self):
        binding = self.contract['accountNative']
        controls = {name: digest(b.git('show', b.ACCOUNT_CONTROLLER + ':scripts/production-release/' + name))
                    for name in ('account-login-release.py', 'recharge-record-release.py', 'remote-deploy.py',
                                 'recharge-availability-release.py', 'account-login-contract.json')}
        plan = {'commit': b.ACCOUNT_COMMIT, 'tree': b.ACCOUNT_TREE, 'controllerCommit': b.ACCOUNT_CONTROLLER,
                'controllerSha256': b.ACCOUNT_CONTROLS['account-login-release.py'],
                'validatedControllerSha256': b.ACCOUNT_VALIDATED_CONTROLLER,
                'contractSha256': self.contract['accountContractSha256'],
                'artifactSha256': binding['bundleSha256'], 'buildProofSha256': b.ACCOUNT_PROOF,
                'workflowRunId': binding['runId'], 'workflowRunAttempt': '1',
                'validationRunId': '38878982040', 'validationRunAttempt': '1', 'controlSources': controls}
        images = {'api': {'imageId': 'sha256:' + 'a' * 64}, 'admin': {'imageId': 'sha256:' + 'b' * 64}}
        release = {'status': 'ACCOUNT_LOGIN_DEPLOYED', 'commit': b.ACCOUNT_COMMIT, 'tree': b.ACCOUNT_TREE,
                   'workflowRunId': binding['runId'], 'businessActions': 0, 'migrationPerformed': True, 'images': images}
        readback = {'status': 'ACCOUNT_LOGIN_INDEPENDENT_READBACK_VERIFIED', 'commit': b.ACCOUNT_COMMIT,
                    'businessActions': 0, 'migrationPerformed': True, 'images': images,
                    'preservedServices': ['mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration']}
        receipt = lambda output: {'Status': 'Success', 'StatusDetails': 'Success', 'ResponseCode': 0,
                                  'StandardErrorContent': '', 'StandardOutputContent': json.dumps(output)}
        original = {'publication-plan.json': plan, 'release-native-invocation.json': receipt(release),
                    'readback-native-invocation.json': receipt(readback)}

        def check(entries):
            zipped = io.BytesIO()
            with zipfile.ZipFile(zipped, 'w') as archive:
                for name, value in entries.items():
                    archive.writestr(name, json.dumps(value))
            with zipfile.ZipFile(zipped) as archive:
                b.verify_account_publication(archive, binding)

        check(original)
        for name, changed, error in [
                ('publication-plan.json', {'controllerCommit': b.ACCOUNT_COMMIT}, 'ACCOUNT_PUBLICATION_PLAN_CHANGED'),
                ('release-native-invocation.json', {'Status': 'Failed'}, 'ACCOUNT_PUBLICATION_NOT_SUCCESSFUL'),
                ('readback-native-invocation.json', {'ResponseCode': True}, 'ACCOUNT_PUBLICATION_NOT_SUCCESSFUL'),
                ('readback-native-invocation.json', {'StandardOutputContent': json.dumps({**readback, 'businessActions': 1})}, 'ACCOUNT_PUBLICATION_READBACK_CHANGED'),
                ('readback-native-invocation.json', {'StandardOutputContent': json.dumps({**readback, 'images': {}})}, 'ACCOUNT_PUBLICATION_READBACK_CHANGED')]:
            with self.subTest(name=name, changed=changed), self.assertRaisesRegex(RuntimeError, error):
                check({**original, name: {**original[name], **changed}})

    def test_checkout_inheritance_is_bound_to_three_fixed_sources_and_its_successful_run(self):
        recipe = b.verify_checkout_binding(self.contract)
        self.assertEqual(len(recipe['sources']), 3)
        self.assertEqual(self.contract['checkoutSources'], recipe['sources'])
        self.assertEqual(b.SOURCE_BASE, b.CHECKOUT_COMMIT)
        self.assertNotEqual(b.ACCOUNT_COMMIT, b.CURRENT)
        self.assertNotEqual(b.ACCOUNT_CONTROLLER, b.SOURCE_BASE)
        for changed in [{'tree': b.ACCOUNT_TREE}, {'runId': '38878982040'},
                        {'artifactId': 1}, {'proofSha256': '0' * 64}]:
            with self.subTest(changed=changed), patch.object(b.subprocess, 'check_output') as remote, \
                    self.assertRaisesRegex(RuntimeError, 'CHECKOUT_NATIVE_BINDING_CHANGED'):
                b.native_proof({**self.contract['checkoutNative'], **changed})
            remote.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, 'CHECKOUT_SOURCE_SCOPE_CHANGED'):
            b.checkout_recipe({**self.contract, 'checkoutSources': {}})

    def test_checkout_overlay_copies_only_the_pinned_checkout_tree(self):
        values = {'apps/api/source1.ts': b'published source 1', 'apps/api/source2.ts': b'published source 2'}
        contract = {'checkoutSources': {name: digest(raw) for name, raw in values.items()}}
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary, patch.object(b, 'checkout_recipe'), \
                patch.object(b, 'git', side_effect=lambda *args: values[args[1].split(':', 1)[1]]) as read:
            context = Path(temporary)
            b.overlay_checkout_sources(context, contract)
            self.assertEqual({name: (context / name).read_bytes() for name in values}, values)
            self.assertEqual(read.call_args_list, [unittest.mock.call('show', b.CHECKOUT_COMMIT + ':' + name)
                                                  for name in values])
            with self.assertRaisesRegex(RuntimeError, 'CHECKOUT_PUBLISHED_SOURCE_CHANGED'):
                b.overlay_checkout_sources(context, {'checkoutSources': {'apps/api/source1.ts': '0' * 64}})

    def test_checkout_proof_preserves_account_admin_schema_and_closes_the_final_api_union(self):
        recipe = b.checkout_recipe(self.contract)
        account_api = {**self.contract['baselineApiFiles'], **recipe['apiModules']}
        modules = {name.removesuffix('.js') + suffix: 'a' * 64 for name in recipe['apiModules']
                   for suffix in ('.js', '.js.map', '.d.ts')}
        account = {'adminFiles': self.contract['baselineAdminFiles']}
        proof = {'version': 1, 'scope': recipe['scope'], 'commit': b.CHECKOUT_COMMIT, 'tree': b.CHECKOUT_TREE,
                 'workflowRunId': '38882778676', 'workflowRunAttempt': '1',
                 'contractSha256': self.contract['checkoutContractSha256'],
                 'controllerSha256': b.CHECKOUT_CONTROLS['recharge-source-recovery-release.py'],
                 'baselineApiReproduced': True, 'baselineAdminPreserved': True,
                 'baselinePublishedVerified': {'apiSource': b.ACCOUNT_COMMIT,
                                              'adminSource': b.ACCOUNT_COMMIT, 'verified': True},
                 'apiModules': modules, 'adminFiles': {}, 'updatedServices': ['api'],
                 'migrationPerformed': False, 'businessActions': 0,
                 'qualityVerification': {'commit': b.CHECKOUT_COMMIT, 'conclusion': 'success',
                     'path': '.github/workflows/quality.yml', 'runId': '38882646810', 'sourceTree': b.CHECKOUT_TREE},
                 'databaseVerification': {'databaseStarted': False, 'schemaChanged': False, 'sqlChanged': False}}
        proof['files'] = {**{'source/' + n: v for n, v in recipe['sources'].items()},
                          **{'api/modules/' + n: v for n, v in modules.items()}}
        contract = {**self.contract, 'baselineApiFiles': {
                    **account_api, **{n: v for n, v in modules.items() if n.endswith('.js')}}}
        self.assertEqual(b.verify_checkout_proof(proof, account, account_api, contract), proof)
        for changed, error in [({'businessActions': False}, 'CHECKOUT_NATIVE_PROOF_CHANGED'),
                               ({'updatedServices': ['api', 'admin']}, 'CHECKOUT_NATIVE_PROOF_CHANGED'),
                               ({'adminFiles': {'index.html': 'b' * 64}}, 'CHECKOUT_NATIVE_PROOF_CHANGED'),
                               ({'migrationPerformed': True}, 'CHECKOUT_NATIVE_PROOF_CHANGED'),
                               ({'databaseVerification': {}}, 'CHECKOUT_NATIVE_VALIDATION_CHANGED'),
                               ({'files': {**proof['files'], 'source/unpublished.ts': 'c' * 64}}, 'CHECKOUT_NATIVE_PAYLOAD_CHANGED')]:
            with self.subTest(changed=changed), self.assertRaisesRegex(RuntimeError, error):
                b.verify_checkout_proof({**proof, **changed}, account, account_api, contract)
        with self.assertRaisesRegex(RuntimeError, 'CHECKOUT_FINAL_BASELINE_CHANGED'):
            b.verify_checkout_proof(proof, account, account_api, {**contract, 'baselineApiFiles': account_api})

    def test_checkout_publication_requires_api_only_release_and_independent_preservation_readback(self):
        binding = self.contract['checkoutNative']
        controls = {name: digest(b.git('show', b.CHECKOUT_COMMIT + ':scripts/production-release/' + name))
                    for name in ('recharge-source-recovery-release.py', 'recharge-record-release.py',
                                 'remote-deploy.py', 'recharge-availability-release.py',
                                 'recharge-source-recovery-contract.json')}
        plan = {'commit': b.CHECKOUT_COMMIT, 'tree': b.CHECKOUT_TREE,
                'controllerSha256': b.CHECKOUT_CONTROLS['recharge-source-recovery-release.py'],
                'contractSha256': self.contract['checkoutContractSha256'],
                'artifactSha256': binding['bundleSha256'], 'buildProofSha256': b.CHECKOUT_PROOF,
                'workflowRunId': binding['runId'], 'workflowRunAttempt': '1', 'controlSources': controls}
        images = {'api': {'imageId': 'sha256:' + 'a' * 64}}
        release = {'status': 'RECHARGE_SOURCE_RECOVERY_DEPLOYED', 'commit': b.CHECKOUT_COMMIT,
                   'tree': b.CHECKOUT_TREE, 'workflowRunId': binding['runId'],
                   'businessActions': 0, 'migrationPerformed': False, 'images': images}
        readback = {'status': 'RECHARGE_SOURCE_RECOVERY_INDEPENDENT_READBACK_VERIFIED',
                    'commit': b.CHECKOUT_COMMIT, 'businessActions': 0, 'migrationPerformed': False, 'images': images,
                    'preservedServices': ['admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration']}
        receipt = lambda output: {'Status': 'Success', 'StatusDetails': 'Success', 'ResponseCode': 0,
                                  'StandardErrorContent': '', 'StandardOutputContent': json.dumps(output)}
        original = {'publication-plan.json': plan, 'release-native-invocation.json': receipt(release),
                    'readback-native-invocation.json': receipt(readback)}

        def check(entries):
            zipped = io.BytesIO()
            with zipfile.ZipFile(zipped, 'w') as archive:
                for name, value in entries.items():
                    archive.writestr(name, json.dumps(value))
            with zipfile.ZipFile(zipped) as archive:
                b.verify_checkout_publication(archive, binding)

        check(original)
        for name, changed, error in [
                ('publication-plan.json', {'tree': b.ACCOUNT_TREE}, 'CHECKOUT_PUBLICATION_PLAN_CHANGED'),
                ('release-native-invocation.json', {'Status': 'Failed'}, 'CHECKOUT_PUBLICATION_NOT_SUCCESSFUL'),
                ('readback-native-invocation.json', {'ResponseCode': True}, 'CHECKOUT_PUBLICATION_NOT_SUCCESSFUL'),
                ('readback-native-invocation.json', {'StandardOutputContent': json.dumps({**readback, 'migrationPerformed': True})}, 'CHECKOUT_PUBLICATION_READBACK_CHANGED'),
                ('readback-native-invocation.json', {'StandardOutputContent': json.dumps({**readback, 'preservedServices': []})}, 'CHECKOUT_PUBLICATION_READBACK_CHANGED')]:
            with self.subTest(name=name, changed=changed), self.assertRaisesRegex(RuntimeError, error):
                check({**original, name: {**original[name], **changed}})

    def test_client_generation_uses_the_reconstructed_root_cwd_and_no_workspace(self):
        context = ROOT / '.deploy/registration-parity-diagnostics/isolated-fixture'
        with patch.dict(os.environ, {'PATH': '/synthetic/bin', 'PRISMA_UNRELATED': 'kept'}, clear=True), \
                patch.object(b, 'run') as execute:
            b.generate_unchanged_client(context)
        execute.assert_called_once_with(
            'node', 'node_modules/prisma/build/index.js', 'generate', '--schema', b.SCHEMA,
            cwd=context, env={'PATH': '/synthetic/bin', 'PRISMA_UNRELATED': 'kept',
                             'DATABASE_URL': 'mysql://prisma:prisma@127.0.0.1:3306/id_business_v2'})
        self.assertNotIn('--workspace', execute.call_args.args)

    def test_client_generation_omits_github_actions_only_from_child_environment(self):
        context = ROOT / '.deploy/registration-parity-diagnostics/isolated-fixture'
        for value in ('true', 'false'):
            with self.subTest(value=value), patch.dict(
                    os.environ, {'GITHUB_ACTIONS': value, 'GITHUB_RUN_ID': '123',
                                 'PRISMA_UNRELATED': 'kept'}, clear=True), patch.object(b, 'run') as execute:
                parent_environment = dict(os.environ)
                b.generate_unchanged_client(context)
                self.assertEqual(dict(os.environ), parent_environment)
                child_environment = execute.call_args.kwargs['env']
                self.assertNotIn('GITHUB_ACTIONS', child_environment)
                self.assertEqual(child_environment['GITHUB_RUN_ID'], '123')
                self.assertEqual(child_environment['PRISMA_UNRELATED'], 'kept')
                self.assertEqual(child_environment['DATABASE_URL'],
                                 'mysql://prisma:prisma@127.0.0.1:3306/id_business_v2')
                self.assertEqual(set(child_environment) - {'DATABASE_URL'},
                                 set(parent_environment) - {'GITHUB_ACTIONS'})

    @unittest.skipUnless(os.environ.get('GITHUB_ACTIONS') == 'true'
                         and os.environ.get('CHECK_MODE') == 'ci-only',
                         'Static Linux client generation runs only in GitHub CI-only guards')
    def test_ci_only_generates_real_locked_root_client_and_compares_all_files(self):
        # Missing Prisma, engines or lock-installed dependencies is a failure.
        # generate never connects to the dummy DATABASE_URL; no migration runs.
        b.generate_unchanged_client(ROOT)
        self.assertEqual(b.unchanged_client(ROOT, self.contract), self.contract['baselinePrismaClientFiles'])

    def test_client_inventory_diagnostic_is_bounded_and_does_not_disclose_raw_values(self):
        sensitive = 'https://secret-user:secret-password@example.invalid/?token=secret-token'
        expected = {'schema.prisma': 'a' * 64, 'index.js': 'b' * 64, sensitive: sensitive}
        actual = {'index.js': 'c' * 64, 'package.json': 'd' * 64}
        diagnostic = b.client_inventory_diagnostic(expected, actual)
        self.assertEqual(diagnostic['missingCount'], 2)
        self.assertEqual(diagnostic['unexpectedCount'], 1)
        self.assertEqual(diagnostic['different'], [{'file': 'index.js', 'expectedSha256': 'b' * 64,
                                                  'actualSha256': 'c' * 64}])
        encoded = json.dumps(diagnostic)
        for value in [sensitive, 'secret-password', 'secret-token', 'example.invalid']:
            self.assertNotIn(value, encoded)
        many = b.client_inventory_diagnostic({}, {'untrusted-' + str(i): 'a' * 64 for i in range(100)})
        self.assertEqual(many['unexpectedCount'], 100)
        self.assertEqual(len(many['unexpected']), 32)
        self.assertTrue(many['truncated'])
        self.assertNotIn('untrusted-', json.dumps(many))

    def test_client_mismatch_prints_safe_inventory_and_still_rejects(self):
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary:
            context = Path(temporary)
            directory = context / 'node_modules/.prisma/client'
            directory.mkdir(parents=True)
            raw = ('"output": {\n      "value": ' + json.dumps(str(context / 'node_modules/@prisma/client'), ensure_ascii=False)
                   + ',\n  "sourceFilePath": '
                   + json.dumps(str(context / 'apps/api/prisma-mysql/schema.prisma'), ensure_ascii=False)
                   + '\n// synthetic-secret-body\n')
            normalized = raw.replace(str(context) + '/', '/app/').encode()
            actual = {}
            expected = {}
            for name in ['index.js', 'edge.js', 'wasm.js']:
                (directory / name).write_text(raw)
                actual[name] = digest(raw.encode())
                expected[name] = digest(normalized)
            expected['index.js'] = '0' * 64
            actual['secret-token-filename'] = 'synthetic-secret-value'
            contract = {'prismaPathMetadata': {'files': ['index.js', 'edge.js', 'wasm.js'],
                        'publishedContext': '/app'}, 'baselinePrismaClientFiles': expected}
            output = io.StringIO()
            helper = types.SimpleNamespace(file_inventory=lambda _: actual.copy())
            with patch.object(b, 'load', return_value=helper), redirect_stdout(output), \
                    self.assertRaisesRegex(RuntimeError, 'UNCHANGED_CLIENT_NOT_REPRODUCED'):
                b.unchanged_client(context, contract)
            diagnostic = json.loads(output.getvalue())
            self.assertEqual(diagnostic['status'], 'PRISMA_CLIENT_INVENTORY_MISMATCH')
            self.assertEqual(diagnostic['expectedCount'], 3)
            self.assertEqual(diagnostic['actualCount'], 4)
            self.assertEqual(diagnostic['differentCount'], 1)
            self.assertEqual(diagnostic['unexpectedCount'], 1)
            for sensitive in ['synthetic-secret-body', 'synthetic-secret-value', 'secret-token-filename', str(context)]:
                self.assertNotIn(sensitive, output.getvalue())

    def test_client_comparison_normalizes_only_two_known_metadata_fields_to_runtime_app(self):
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary:
            context = Path(temporary)
            directory = context / 'node_modules/.prisma/client'
            directory.mkdir(parents=True)
            originals = {}
            expected = {}
            for name in ['index.js', 'edge.js', 'wasm.js']:
                raw = ('"output": {\n      "value": ' + json.dumps(str(context / 'node_modules/@prisma/client'), ensure_ascii=False)
                       + ',\n      "fromEnvVar": null\n    },\n  "sourceFilePath": '
                       + json.dumps(str(context / 'apps/api/prisma-mysql/schema.prisma'), ensure_ascii=False) + ',\n')
                if name == 'index.js':
                    raw += 'const alternativePaths = ["node_modules/.prisma/client", ".prisma/client"];\n'
                originals[name] = raw
                (directory / name).write_text(raw)
                expected[name] = digest(raw.replace(str(context) + '/', '/app/').encode())
            (directory / 'schema.prisma').write_text('synthetic fixed schema\n')
            expected['schema.prisma'] = digest(b'synthetic fixed schema\n')
            contract = {'prismaPathMetadata': {'files': ['index.js', 'edge.js', 'wasm.js'],
                        'publishedContext': '/app'}, 'baselinePrismaClientFiles': expected}
            self.assertEqual(b.unchanged_client(context, contract), expected)
            (directory / 'index.js').write_text(originals['index.js'].replace('"sourceFilePath": ', '"foreign": '))
            with self.assertRaisesRegex(RuntimeError, 'CLIENT_METADATA_FIELD_CHANGED'):
                b.unchanged_client(context, contract)
            (directory / 'index.js').write_text(originals['index.js'])
            (directory / 'index.js').write_text(originals['index.js'].replace(
                '"node_modules/.prisma/client"', '"../../node_modules/.prisma/client"'))
            with self.assertRaisesRegex(RuntimeError, 'UNCHANGED_CLIENT_NOT_REPRODUCED'):
                b.unchanged_client(context, contract)
            (directory / 'index.js').write_text(originals['index.js'])
            (directory / 'unexpected.js').write_text('unreviewed')
            with self.assertRaisesRegex(RuntimeError, 'UNCHANGED_CLIENT_NOT_REPRODUCED'):
                b.unchanged_client(context, contract)

    def test_runtime_schema_cannot_follow_an_unreviewed_root_or_runtime_change(self):
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary:
            context = Path(temporary)
            target = context / b.SCHEMA
            target.parent.mkdir(parents=True)
            target.write_bytes(b'known existing schema')
            expected = digest(target.read_bytes())
            contract = {'schemaSha256': expected, 'unchangedInputs': {b.SCHEMA: expected}}
            b.verify_runtime_schema(context, contract)
            with self.assertRaisesRegex(RuntimeError, 'RUNTIME_SCHEMA_CHANGED'):
                b.verify_runtime_schema(context, {**contract, 'schemaSha256': '0' * 64})
            target.write_bytes(b'changed schema')
            with self.assertRaisesRegex(RuntimeError, 'RUNTIME_SCHEMA_CHANGED'):
                b.verify_runtime_schema(context, contract)

    def test_projection_canonical_hash_preserves_complete_parent_identity(self):
        manifest = {'roleSourceProjections': {'api': {'commit': 'first', 'files': {'b': 2, 'a': 1}}},
                    'adminSourceProjection': {'sources': ['first', 'second'], 'commit': 'first'}}
        reordered = {'adminSourceProjection': {'commit': 'first', 'sources': ['first', 'second']},
                     'roleSourceProjections': {'api': {'files': {'a': 1, 'b': 2}, 'commit': 'first'}}}
        self.assertEqual(r.projection_hashes(manifest), r.projection_hashes(reordered))
        changed = copy.deepcopy(manifest)
        changed['roleSourceProjections']['api']['files']['a'] = 3
        self.assertNotEqual(r.projection_hashes(manifest), r.projection_hashes(changed))

    def test_api_delta_is_only_approved_modules_and_never_deletes_runtime(self):
        name = 'id-business-v2/auto-registration/apple-mailboxes.types'
        before = {name + '.js': 'a' * 64, name + '.d.ts': 'b' * 64, 'unrelated.js': 'c' * 64}
        after = {**before, name + '.d.ts': 'd' * 64}
        self.assertEqual(b.api_delta(before, after, {name + '.js': 'a' * 64}),
                         {name + '.d.ts': 'd' * 64})
        for invalid in [before, {**after, 'sales.js': 'a' * 64},
                        {key: value for key, value in after.items() if key != 'unrelated.js'}]:
            with self.assertRaisesRegex(RuntimeError, 'API_OUTPUT_SCOPE_CHANGED'):
                b.api_delta(before, invalid, {name + '.js': 'a' * 64})

    def sqlite_fixture(self):
        parent = json.loads((HERE / 'registration-flow-evidence-contract.json').read_bytes())
        policy = copy.deepcopy(self.contract['sqliteReviewPolicy'])
        contract = {**self.contract, 'sqliteReviewPolicy': policy}
        value = {'version': 1, 'status': 'PASS', **policy['summary'], 'activeAppleLeaseCount': 1,
                 'executingTaskCount': 0, 'retainedReviewLeaseCount': 1,
                 'corruptEncryptedValueCount': 0, 'leaseFacts': policy['leaseFacts'],
                 'protectedTaskFacts': policy['protectedTaskFacts'], 'dependencies': self.contract['runtimePythonDependencies'], 'businessActions': 0}
        return contract, value

    def test_three_terminal_tasks_manual_state_and_review_lease_are_preserved_exactly(self):
        contract, value = self.sqlite_fixture()
        self.assertEqual(r.validate_sqlite_receipt(value, contract), value)
        for collection in ('leaseFacts', 'protectedTaskFacts'):
            for index in range(len(value[collection])):
                changed = copy.deepcopy(value)
                changed[collection][index]['bindingSha256'] = '0' * 64
                with self.assertRaisesRegex(RuntimeError, 'SQLITE_PRESERVATION_CHANGED'):
                    r.validate_sqlite_receipt(changed, contract)
        for field, replacement in [('executingTaskCount', 1), ('activeAppleLeaseCount', 0),
                                   ('businessActions', 1), ('logicalSha256', '0' * 64)]:
            with self.assertRaisesRegex(RuntimeError, 'SQLITE_PRESERVATION_CHANGED'):
                r.validate_sqlite_receipt({**value, field: replacement}, contract)
        with self.assertRaisesRegex(RuntimeError, 'SQLITE_PRESERVATION_CHANGED'):
            r.validate_sqlite_receipt(value, contract, '0' * 64)

    def test_release_inspector_remains_readonly_and_includes_original_three_task_ids(self):
        source = r.sqlite_inspection_source()
        self.assertIn('PRAGMA query_only=ON', source)
        self.assertIn("db.execute('BEGIN')", source)
        self.assertIn('integrity_check', source)
        self.assertIn('encrypted_proof', source)
        self.assertIn('assert leases==1', source)
        self.assertIn('af941d8b-d0a5-4d94-8a43-029d54f017a9', source)
        self.assertNotIn('UPDATE ', source)
        self.assertNotIn('DELETE ', source)

    def test_real_inspector_projects_every_field_of_all_three_fresh_contract_facts(self):
        tree = ast.parse(r.sqlite_inspection_source())
        append = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                  and isinstance(node.func, ast.Attribute) and node.func.attr == 'append'
                  and isinstance(node.func.value, ast.Name) and node.func.value.id == 'protected']
        self.assertEqual(len(append), 1)
        expression = compile(ast.Expression(append[0].args[0]), '<protected_fact_projection>', 'eval')
        for fact in self.contract['sqliteReviewPolicy']['protectedTaskFacts']:
            with self.subTest(task=fact['taskUuid']):
                context = {
                    '__builtins__': {}, 'task': fact['taskUuid'], 'task_status': fact['taskStatus'],
                    'record': {'registrationStatus': fact['recordRegistrationStatus'],
                               'taskStatus': fact['recordTaskStatus'], 'source': fact['recordSource'],
                               'activeTaskUuid': fact['activeTaskUuid']},
                    'binding': {'sideEffectPossible': fact['sideEffectPossible'],
                                'needsReview': fact['needsReview']},
                    'value': 'synthetic-record', 'binding_value': 'synthetic-binding',
                    'task_row': ('synthetic-row',), 's': types.SimpleNamespace(sqlite_value=lambda v: v),
                    'h': lambda value: fact['recordSha256'] if value == 'synthetic-record'
                         else fact['bindingSha256'] if value == 'synthetic-binding' else fact['taskRowSha256']
                }
                projected = eval(expression, context)
                self.assertEqual(set(projected), set(fact))
                self.assertEqual(projected, fact)
                context['record']['activeTaskUuid'] = 'synthetic-drift'
                self.assertNotEqual(eval(expression, context), fact)

    def test_archive_rejects_links_traversal_duplicates_and_outside_payload(self):
        for name, kind in [('outside/file', tarfile.REGTYPE), ('payload/../escape', tarfile.REGTYPE),
                           ('payload/link', tarfile.SYMTYPE)]:
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode='w') as archive:
                item = tarfile.TarInfo(name)
                item.type = kind
                item.size = 0
                archive.addfile(item, io.BytesIO())
            with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary, \
                    self.assertRaisesRegex(RuntimeError, 'ARTIFACT_PATH_INVALID'):
                r.archive(buffer.getvalue(), Path(temporary) / 'extract')

    def test_new_channel_is_no_migration_no_client_overlay_and_separate_namespace(self):
        source = (HERE / 'registration-parity-diagnostics-release.py').read_text()
        self.assertNotIn('apply_migration', source)
        self.assertNotIn('migrate deploy', source)
        self.assertNotIn('prisma-client/', source[source.index('for role, copies, count in'):])
        self.assertIn("('api', 'COPY modules/", source)
        self.assertIn("'--force-recreate', 'online-recharge'", source)
        self.assertIn('registration-parity-diagnostics-preservation.json', source)
        self.assertIn('registration-parity-diagnostics-readback.json', source)
        self.assertIsNone(self.contract['migration'])


if __name__ == '__main__':
    unittest.main()
