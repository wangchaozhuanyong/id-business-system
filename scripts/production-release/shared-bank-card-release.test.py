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

    def test_mysql_read_explicitly_selects_current_api_database(self):
        class Compose:
            calls = []

            def compose(self, directory, *args, **kwargs):
                self.calls.append(args)
                if args[0] == 'config':
                    return json.dumps({'services': {'api': {'environment': {'DATABASE_URL': 'mysql://fixture@mysql/formal_current'}}}})
                return 'owned-result'
        d = Compose()
        self.assertEqual(r.mysql_read(d, Path('/owned-release'), 'SELECT 1'), 'owned-result')
        self.assertEqual(d.calls[1][:6], ('exec', '-e', 'MYSQL_DATABASE=formal_current', '-T', 'mysql', 'sh'))

    def test_native_control_reuse_remains_bound_to_original_artifact(self):
        old = '7b727c352ed133b84e7188df5a54c7776819acee2cebdf02a5ffc5023444f89d'
        plan = {'commit': 'e84a44d86c289354bc7ed15dcd0ec68f7210e18e', 'tree': 'a' * 40,
            'workflowRunId': '38916394747', 'workflowRunAttempt': '1', 'contractSha256': 'a' * 64,
            'controlSources': {'shared-bank-card-release.py': 'b' * 64},
            'validatedControlSources': {'shared-bank-card-release.py': old}}
        c = {'scope': r.SCOPE, 'sources': {'apps/api/prisma-mysql/schema.prisma': 'a' * 64},
            'afterEngineFiles': {}, 'apiModules': ['id-business-v2/pool.js'], 'migration': {'name': 'owned'}}
        modules = {'id-business-v2/pool' + ext: 'a' * 64 for ext in ('.js', '.js.map', '.d.ts')}
        clients = {'index.js': 'a' * 64, 'schema.prisma': 'a' * 64}
        files = {**{'source/' + n: v for n, v in c['sources'].items()},
            **{'api/modules/' + n: v for n, v in modules.items()},
            **{'api/prisma-client/' + n: v for n, v in clients.items()},
            'api/schema.prisma': 'a' * 64, 'admin/html/index.html': 'a' * 64}
        proof = {**plan, 'version': 1, 'scope': r.SCOPE, 'controlSources': plan['validatedControlSources'],
            'sources': c['sources'], 'afterEngineFiles': {}, 'baselineApiReproduced': True,
            'baselineAdminSourceReproduced': True, 'migrationPerformed': False, 'plannedMigration': c['migration'],
            'databaseVerification': {'isolated': True, 'tests': 5, 'passed': 5}, 'businessActions': 0,
            'apiModules': modules, 'prismaClientFiles': clients, 'files': files,
            'baselineAdminFiles': {'index.html': 'a' * 64}, 'adminFiles': {'index.html': 'a' * 64}}
        r.verify_proof(proof, plan, c, files)
        for field, value in [('workflowRunId', '1'), ('commit', 'b' * 40),
            ('validatedControlSources', {'shared-bank-card-release.py': 'unreviewed'})]:
            with self.assertRaisesRegex(RuntimeError, 'REUSED_EXECUTOR_SCOPE_CHANGED'):
                r.verify_proof(proof, {**plan, field: value}, c, files)

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
