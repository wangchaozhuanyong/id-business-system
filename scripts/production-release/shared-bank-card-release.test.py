"""Check untrusted payload rejection and forward-only publication boundaries offline."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


r = load('shared-bank-card-release.py')
b = load('shared-bank-card-build.py')


class PublicationTests(unittest.TestCase):
    def test_contract_preserves_runtime_and_exact_migration(self):
        c = json.loads((HERE / 'shared-bank-card-contract.json').read_bytes())
        r.verify_contract(c)
        changed = copy.deepcopy(c)
        changed['afterEngineFiles']['worker.cjs'] = 'tampered'
        with self.assertRaises(RuntimeError):
            r.verify_contract(changed)
        self.assertEqual(r.UPDATED, ('api', 'admin'))
        self.assertEqual(r.REBOUND, ('online-recharge',))
        self.assertEqual(r.PRESERVED, ('mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration'))

    def test_compiled_delta_rejects_unrelated_auth_module(self):
        c = {'apiModules': ['id-business-v2/bank-card-pool/public-api.js'], 'apiDeclarationOnly': {}}
        files = {'id-business-v2/bank-card-pool/public-api' + ext: 'digest' for ext in ('.js', '.js.map', '.d.ts')}
        self.assertEqual(b.module_delta({}, files, c), files)
        with self.assertRaises(RuntimeError):
            b.module_delta({}, {**files, 'auth/auth.service.js': 'unreviewed'}, c)

    def test_migration_cannot_hide_old_ledger_or_partial_apply(self):
        c = {'migrationLedgerSha256': 'old-ledger', 'migration': {'name': 'new_migration', 'sha256': 'new-checksum'}}
        before = {'ledgerSha256': 'old-ledger', 'pending': 0, 'columns': 0, 'rows': []}
        r.check_migration(before, c)
        for damaged in [{**before, 'pending': 1}, {**before, 'columns': 1}, {**before, 'ledgerSha256': 'changed'}]:
            with self.assertRaises(RuntimeError):
                r.check_migration(damaged, c)
        after = {**before, 'columns': 1, 'rows': [{'name': 'new_migration', 'checksum': 'new-checksum', 'finished': True, 'rolledBack': False}]}
        r.check_migration(after, c, applied=True)
        with self.assertRaises(RuntimeError):
            r.check_migration(after, c)

    def test_failure_keeps_owned_maintenance_for_forward_repair(self):
        # Parse the actual finally block: cleanup cannot run there after an
        # uncertain ALTER or switch, while the SQL fence must always close.
        import ast
        tree = ast.parse((HERE / 'shared-bank-card-release.py').read_text())
        release = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'release')
        finalizers = [n.finalbody for n in ast.walk(release) if isinstance(n, ast.Try) and n.finalbody]
        self.assertEqual(len(finalizers), 1)
        self.assertFalse(any(isinstance(n, ast.Attribute) and n.attr == 'release_markers' for item in finalizers[0] for n in ast.walk(item)))
        self.assertTrue(any(isinstance(n, ast.Attribute) and n.attr == 'close' for item in finalizers[0] for n in ast.walk(item)))


if __name__ == '__main__':
    unittest.main()
