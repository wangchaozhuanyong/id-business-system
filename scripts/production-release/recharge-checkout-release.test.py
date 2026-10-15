"""Pure release admission regressions. No Docker, database or production calls."""
import ast
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location('test_' + name.replace('-', '_'), HERE / name)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


r = load('recharge-checkout-release.py')
b = load('recharge-checkout-build.py')
h = load('recharge-record-release.py')


class CheckoutPublicationTests(unittest.TestCase):
    def test_proof_rejects_wrong_source_quality_database_or_extra_modules(self):
        output = ROOT / '.runtime/checkout-publication-control-tests'
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as name:
            root = Path(name)
            source = 'apps/api/src/id-business-v2/auto-recharge/recharge-unidentified-checkout.ts'
            module = 'id-business-v2/auto-recharge/recharge-unidentified-checkout.js'
            api = {module.removesuffix('.js') + ext: 'fixture' for ext in ('.js', '.js.map', '.d.ts')}
            files = {'source/' + source: b'source'}
            files.update({'api/modules/' + n: v.encode() for n, v in api.items()})
            files.update({'admin/html/' + ('index.html' if n == 0 else 'assets/' + str(n) + '.js'): str(n).encode() for n in range(250)})
            for path, raw in files.items():
                p = root / path
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(raw)
            inv = h.file_inventory(root)
            database = {'schemaChanged': False, 'sqlChanged': False, 'databaseStarted': False}
            contract = {'scope': 'checkout', 'sources': {source: r.digest(b'source')}, 'apiModules': {module: None},
                        'apiSourceBaseline': 'api-before', 'adminSourceBaseline': 'admin-before', 'databaseVerification': database}
            plan = {n: 'exact-' + n for n in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controllerSha256', 'releaseUtilitySha256', 'helperSha256')}
            plan['qualityVerification'] = {'runId': '123', 'commit': plan['commit'], 'sourceTree': plan['tree'],
                                            'path': '.github/workflows/quality.yml', 'conclusion': 'success'}
            proof = {**plan, 'version': 1, 'scope': 'checkout', 'baselineApiReproduced': True, 'baselineAdminReproduced': True,
                     'baselinePublishedVerified': {'apiSource': 'api-before', 'adminSource': 'admin-before', 'verified': True},
                     'databaseVerification': database, 'updatedServices': ['api', 'admin'], 'migrationPerformed': False,
                     'businessActions': 0, 'files': inv, 'apiModules': {n: inv['api/modules/' + n] for n in api},
                     'adminFiles': {n.removeprefix('admin/html/'): v for n, v in inv.items() if n.startswith('admin/html/')}}
            r.validate_proof(proof, plan, contract, root, h)
            for field in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'baselineApiReproduced',
                          'baselineAdminReproduced', 'baselinePublishedVerified', 'databaseVerification', 'qualityVerification',
                          'migrationPerformed', 'businessActions'):
                bad = copy.deepcopy(proof)
                bad[field] = 'changed'
                with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'PROOF_INVALID'):
                    r.validate_proof(bad, plan, contract, root, h)
            (root / 'api/modules/unreviewed.js').write_text('unreviewed')
            with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_SCOPE_CHANGED'):
                r.validate_proof(proof, plan, contract, root, h)

    def test_runtime_successor_prevents_even_preflight(self):
        c = json.loads(b.CONTRACT.read_bytes())
        output = ROOT / '.runtime/checkout-publication-control-tests'
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as name:
            base = Path(name)
            (base / 'current').mkdir()
            with patch.object(r, 'BASE', base), self.assertRaisesRegex(RuntimeError, 'CURRENT_CHANGED'):
                r.baseline(Mock(), c, Mock())

    def test_artifact_input_contract_has_no_schema_or_cross_module_source(self):
        c = json.loads(b.CONTRACT.read_bytes())
        self.assertEqual(c['databaseVerification'], {'schemaChanged': False, 'sqlChanged': False, 'databaseStarted': False})
        self.assertEqual(len(c['apiModules']), 5)
        self.assertEqual(len(c['publicFiles']), 256)
        self.assertNotEqual(c['apiSourceBaseline'], c['adminSourceBaseline'])
        for name, sha in c['sources'].items():
            self.assertEqual(r.digest((ROOT / name).read_bytes()), sha, name)
            self.assertNotIn('/online-recharge/', name)
            self.assertNotIn('/prisma', name)
        functions = [node.name for node in ast.parse((HERE / 'recharge-checkout-release.py').read_text()).body if isinstance(node, ast.FunctionDef)]
        self.assertNotIn('apply_migration', functions)

    def test_image_configuration_accepts_only_deprecated_parent_marker_difference(self):
        original = {'Image': 'sha256:' + 'a' * 64, 'Env': ['fixture=value'], 'User': '1000', 'Labels': {'x': '1'}}
        built = {**original, 'Image': '', 'Labels': {'x': '1', 'revision': '2'}}
        r.verify_image_configuration(original, built)
        for changed in ({**built, 'User': 'root'}, {**built, 'Env': ['different']}, {**built, 'Image': 'untrusted'}):
            with self.assertRaises(RuntimeError):
                r.verify_image_configuration(original, changed)


if __name__ == '__main__':
    unittest.main()
