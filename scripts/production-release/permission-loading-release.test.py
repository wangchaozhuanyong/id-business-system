"""Exercise finite payload and predecessor guards without AWS, Docker or a database."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('permission_loading_runtime', HERE / 'permission-loading-runtime.py')
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)


class PermissionLoadingPublicationTests(unittest.TestCase):
    def setUp(self):
        self.contract = json.loads((HERE / R.CONTRACT_FILE).read_bytes())

    def test_contract_accepts_only_the_admin_loading_repair(self):
        R.validate_contract(self.contract)
        for field, value in [('expectedCurrent', '0' * 40), ('updatedServices', ['api']),
                             ('migrationPerformed', True), ('businessActions', 1)]:
            changed = copy.deepcopy(self.contract)
            changed[field] = value
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                R.validate_contract(changed)
        changed = copy.deepcopy(self.contract)
        changed['sources']['apps/api/prisma-mysql/schema.prisma'] = '0' * 64
        with self.assertRaises(RuntimeError):
            R.validate_contract(changed)

    def test_proof_binds_the_complete_built_payload_and_workflow(self):
        c = self.contract
        plan = {'commit': '1' * 40, 'tree': '2' * 40, 'workflowRunId': '12',
                'workflowRunAttempt': '1', 'contractSha256': '3' * 64,
                'controlSources': {'permission-loading-runtime.py': '4' * 64},
                'qualitySourceEvidence': {'review': 'checked'}, 'nativeParentCapture': {'baseline': 'checked'}}
        proof = {**plan, 'scope': R.SCOPE, 'sources': c['sources'], 'baselineAdminReproduced': True,
                 'baselineAdminFiles': c['baselineAdminFiles'], 'adminFiles': {'index.html': '5' * 64},
                 'migrationPerformed': False, 'businessActions': 0}
        files = {**{'source/' + n: v for n, v in c['sources'].items()}, 'admin/html/index.html': '5' * 64}
        proof['files'] = files
        R.verify_proof(proof, plan, c, files)
        for name, value in [('workflowRunId', '99'), ('baselineAdminReproduced', False),
                            ('adminFiles', {'index.html': '0' * 64})]:
            bad = copy.deepcopy(proof)
            bad[name] = value
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                R.verify_proof(bad, plan, c, files)
        with self.assertRaises(RuntimeError):
            R.verify_proof(proof, plan, c, {**files, 'api/schema.prisma': '0' * 64})

    def test_rebuilt_admin_baseline_matches_the_published_build_proof(self):
        files = self.contract['baselineAdminFiles']
        raw = json.dumps(files, sort_keys=True, separators=(',', ':')).encode()
        self.assertEqual(len(files), 267)
        self.assertEqual(self.contract['baselineAdminFilesSha256'], hashlib.sha256(raw).hexdigest())
        # The live image also retains old hashed assets for already-open tabs.
        self.assertGreater(self.contract['baselineRuntime']['adminInventory']['count'], len(files))

    def test_source_and_inherited_controls_are_pinned(self):
        for name, digest in self.contract['helperPins'].items():
            self.assertEqual(hashlib.sha256((HERE / name).read_bytes()).hexdigest(), digest, name)
        root = HERE.parents[1]
        for name, digest in {**self.contract['sources'], **self.contract['validationSources']}.items():
            self.assertEqual(hashlib.sha256((root / name).read_bytes()).hexdigest(), digest, name)

    def test_parent_diagnostics_strip_messages_and_cannot_authorize_release(self):
        output = HERE.parents[1] / '.runtime' / 'permission-loading-20261102'
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as directory:
            def unavailable(_contract, _driver, _helpers, diagnostics):
                diagnostics['stage'] = 'HOST_SOURCES'
                raise FileNotFoundError('private-secret-value-must-not-leave-server')
            with patch.object(R, 'BASE', Path(directory)), patch.object(R, 'capture', unavailable):
                result = R.inspect_parent(self.contract, None, None)
            self.assertEqual(result['stage'], 'HOST_SOURCES')
            self.assertEqual(result['exceptionType'], 'FileNotFoundError')
            self.assertFalse(result['baselineCaptured'])
            self.assertFalse(result['releaseAuthority'])
            self.assertEqual(result['businessActions'], 0)
            self.assertNotIn('private-secret-value', json.dumps(result))
            self.assertEqual(result['hostSourcePresence'], dict.fromkeys(R.SOURCES, False))
            def available(_contract, _driver, _helpers, diagnostics):
                diagnostics['stage'] = 'CONFIGURATION'
                return {'private': 'not part of diagnostic result'}
            with patch.object(R, 'BASE', Path(directory)), patch.object(R, 'capture', available):
                success = R.inspect_parent(self.contract, None, None)
            self.assertTrue(success['baselineCaptured'])
            self.assertFalse(success['releaseAuthority'])
            self.assertNotIn('private', success)

    def test_only_shipped_helpers_can_initialize_the_parent_reader(self):
        output = HERE.parents[1] / '.runtime' / 'permission-loading-20261102'
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as directory:
            target = Path(directory)
            for name in {*self.contract['helperPins'], R.CONTRACT_FILE}:
                shutil.copyfile(HERE / name, target / name)
            spec = importlib.util.spec_from_file_location('staged_permission_runtime', target / 'permission-loading-runtime.py')
            staged = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(staged)
            driver, helpers = staged.utilities(self.contract)
            self.assertEqual(set(helpers.SERVICES), set(self.contract['preservedServices']) | {'admin'})
            self.assertTrue(callable(driver.service_state))


if __name__ == '__main__':
    unittest.main()
