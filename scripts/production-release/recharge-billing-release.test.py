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
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


r = load('recharge-billing-release.py')
b = load('recharge-billing-build.py')
h = load('recharge-record-release.py')
d = load('recharge-billing-dispatch.py')


class BillingReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT / '.runtime/bit-recharge-billing-generation-20261016').mkdir(parents=True, exist_ok=True)

    def test_proof_requires_exact_native_identity_and_finite_payload(self):
        output = ROOT / '.runtime/bit-recharge-billing-generation-20261016'
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as name:
            root = Path(name)
            source = 'apps/api/src/id-business-v2/auto-recharge/billing.ts'
            module = 'id-business-v2/auto-recharge/billing.js'
            api = {module.removesuffix('.js') + ext: 'module-' + ext for ext in ('.js', '.js.map', '.d.ts')}
            files = {'source/' + source: b'source'}
            files.update({'api/modules/' + n: v.encode() for n, v in api.items()})
            files.update({'admin/html/' + ('index.html' if n == 0 else 'assets/' + str(n) + '.js'): str(n).encode() for n in range(250)})
            for path, raw in files.items():
                p = root / path
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(raw)
            inv = h.file_inventory(root)
            contract = {'scope': 'billing', 'sources': {source: r.digest(b'source')}, 'apiModules': {module: None}, 'baselineNative': {'artifactDigest': 'original'}, 'migration': {'name': 'reviewed'}}
            plan = {n: 'exact-' + n for n in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controllerSha256', 'releaseUtilitySha256', 'helperSha256')}
            proof = {**plan, 'version': 1, 'scope': 'billing', 'baselineApiReproduced': True, 'baselineNativeVerified': {**contract['baselineNative'], 'verified': True}, 'databaseVerification': {'isolated': True, 'suite': 'recharge-billing.mysql.integration.spec.ts'}, 'updatedServices': ['api', 'admin'], 'migrationPerformed': False, 'businessActions': 0, 'files': inv, 'apiModules': {n: inv['api/modules/' + n] for n in api}, 'adminFiles': {n.removeprefix('admin/html/'): v for n, v in inv.items() if n.startswith('admin/html/')}}
            proof['plannedMigration'] = contract['migration']
            r.validate_proof(proof, plan, contract, root, h)
            for field in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'baselineApiReproduced', 'baselineNativeVerified', 'databaseVerification', 'migrationPerformed', 'businessActions'):
                bad = copy.deepcopy(proof)
                bad[field] = 'changed'
                with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'PROOF_INVALID'):
                    r.validate_proof(bad, plan, contract, root, h)
            extra = root / 'api/modules/foreign.js'
            extra.write_text('foreign')
            with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_SCOPE_CHANGED'):
                r.validate_proof(proof, plan, contract, root, h)

    def test_contract_contains_only_the_six_reviewed_modules_and_no_worker_or_schema(self):
        c = json.loads(b.CONTRACT.read_bytes())
        self.assertEqual(len(c['apiModules']), 6)
        self.assertEqual(len(c['sources']), 21)
        for n, sha in c['sources'].items():
            self.assertNotIn('/worker/', n)
            self.assertNotIn('/online-recharge/', n)
            if '/prisma' in n:
                self.assertEqual(n, c['migration']['path'])
            self.assertEqual(r.digest((ROOT / n).read_bytes()), sha)
        self.assertEqual(c['services']['online-recharge']['health'], 'healthy')

    def test_migration_preserves_other_checks_and_requires_recorded_sql_checksum(self):
        c = json.loads(b.CONTRACT.read_bytes())
        before = {'checks': c['addressChecksBefore'], 'rows': [], 'pending': 0}
        r.verify_migration_state(before, c)
        m = c['migration']
        after = {'checks': [x for x in before['checks'] if x['CONSTRAINT_NAME'] != m['oldCheck']] + [{'CONSTRAINT_NAME': m['newCheck'], 'CHECK_CLAUSE': 'reviewed new US check'}], 'rows': [{'checksum': m['sha256'], 'finished': True, 'rolledBack': False}], 'pending': 0}
        r.verify_migration_state(after, c, applied=True)
        for changed in ({**after, 'pending': 1}, {**after, 'rows': []}, {**after, 'checks': after['checks'][1:]}):
            with self.assertRaises(RuntimeError):
                r.verify_migration_state(changed, c, applied=True)
        with self.assertRaisesRegex(RuntimeError, 'MIGRATION_BASELINE_CHANGED'):
            r.verify_migration_state(after, c)
        sql = (ROOT / m['path']).read_text()
        self.assertEqual(r.digest(sql.encode()), m['sha256'])
        self.assertEqual(sql.count('ALTER TABLE'), 1)
        self.assertNotIn('DELETE ', sql)
        self.assertNotIn('DROP TABLE', sql)
        source = (HERE / 'recharge-billing-release.py').read_text()
        self.assertNotIn("*command, 'migrate', 'deploy'", source)
        self.assertIn("*command, 'migrate', 'resolve', '--applied'", source)
        self.assertIn("'--no-build', '--pull', 'never'", source)

    def test_baseline_refuses_changed_current_before_touching_services(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.runtime/bit-recharge-billing-generation-20261016') as directory:
            base = Path(directory)
            (base / 'releases/original').mkdir(parents=True)
            (base / 'releases/moved').mkdir()
            (base / 'current').symlink_to(base / 'releases/moved')
            platform = Mock()
            with patch.object(r, 'BASE', base), self.assertRaisesRegex(RuntimeError, 'CURRENT_CHANGED'):
                r.baseline(platform, {'current': str(base / 'releases/original')}, h)
            self.assertEqual(platform.mock_calls, [])

    def test_payload_scope_rejects_sibling_runtime_outputs(self):
        a = load('recharge-availability-build.py')
        modules = {'a.js': None}
        valid = {'a.js': '1', 'a.js.map': '2', 'a.d.ts': '3'}
        self.assertEqual(a.verify_api_outputs({}, valid, modules), set(valid))
        with self.assertRaisesRegex(RuntimeError, 'API_OUTPUT_SCOPE_CHANGED'):
            a.verify_api_outputs({}, {**valid, 'online/foreign.js': '4'}, modules)

    def test_publication_keeps_all_control_sources_and_independent_readback(self):
        source = (HERE / 'recharge-billing-dispatch.py').read_text()
        self.assertIn("'recharge-availability-release.py','availabilityHelperSha256'", source)
        self.assertIn("for mode in ('release', 'readback'):", source)
        self.assertIn("need(not receipt_path.exists(), 'COMMAND_ALREADY_ACCEPTED')", source)
        workflow = (ROOT / '.github/workflows/recharge-billing-validation.yml').read_text()
        self.assertIn('group: id-business-v2-production-release', workflow)
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertIn('recharge-billing.mysql.integration.spec.ts', workflow)
        self.assertEqual(workflow.count('recharge-billing.mysql.integration.spec.ts'), 1)
        self.assertIn('recharge-availability.mysql.integration.spec.ts', workflow)
        self.assertIn('recharge-callback-receipts.mysql.integration.spec.ts', workflow)
        self.assertIn('working-directory: .deploy/recharge-billing-release/candidate', workflow)
        self.assertNotIn("database_evidence.outputs.reuse", workflow)
        self.assertNotIn('continue-on-error', workflow)


if __name__ == '__main__':
    unittest.main()
