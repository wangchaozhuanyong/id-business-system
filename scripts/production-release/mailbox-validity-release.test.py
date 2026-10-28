"""Local control tests never connect to AWS, a database, or production services."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
spec = importlib.util.spec_from_file_location('validity_controls', HERE / 'mailbox-validity-runtime.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class ValidityControls(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / r.CONTRACT_FILE).read_bytes())

    def test_executable_payload_excludes_and_preserves_existing_declarations(self):
        modules = {n.removesuffix('.js') + e: 'a' * 64 for n in self.c['apiModules'] for e in ('.js', '.js.map', '.d.ts')}
        plan = {'commit': 'b' * 40, 'tree': 'c' * 40, 'workflowRunId': '1', 'workflowRunAttempt': '1',
                'contractSha256': 'd' * 64, 'controlSources': {}, 'nativeParentCapture': {'baseline': {'baselineApiModules': modules}},
                'qualitySourceEvidence': {'fixtureOnly': True}}
        runtime = {n: 'e' * 64 for n in modules if not n.endswith('.d.ts')}
        declarations = {n: v for n, v in modules.items() if n.endswith('.d.ts')}
        proof = {**plan, 'scope': r.SCOPE, 'sources': self.c['sources'], 'baselineApiModulesReproduced': True,
                 'baselineAdminReproduced': True, 'migrationPerformed': False, 'businessActions': 0,
                 'retainedSourceBase': self.c['sourceBase'], 'reviewBase': self.c['reviewBase'],
                 'apiModules': runtime, 'preservedApiDeclarations': declarations, 'baselineAdminFiles': self.c['baselineAdminFiles'],
                 'adminFiles': {'index.html': 'f' * 64}, 'prismaClientFiles': {'schema.prisma': 'f' * 64}}
        files = {**{'source/' + n: v for n, v in self.c['sources'].items()},
                 **{'api/modules/' + n: v for n, v in runtime.items()},
                 'admin/html/index.html': 'f' * 64, 'api/prisma-client/schema.prisma': 'f' * 64,
                 'api/schema.prisma': self.c['sources']['apps/api/prisma-mysql/schema.prisma']}
        proof['files'] = files
        r.verify_proof(proof, plan, self.c, files)
        bad = copy.deepcopy(proof)
        bad['apiModules'][next(iter(declarations))] = 'a' * 64
        with self.assertRaisesRegex(RuntimeError, 'BUILD_SCOPE_CHANGED'):
            r.verify_proof(bad, plan, self.c, files)
        bad = copy.deepcopy(proof)
        bad['preservedApiDeclarations'][next(iter(declarations))] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'PRESERVED_DECLARATIONS_CHANGED'):
            r.verify_proof(bad, plan, self.c, files)

    def test_image_bytes_are_checked_without_network_or_application_startup(self):
        proof = {'apiModules': {'module.js': 'a' * 64}, 'preservedApiDeclarations': {'module.d.ts': 'b' * 64},
                 'prismaClientFiles': {'schema.prisma': 'c' * 64}}
        expected = {'/app/apps/api/dist/module.js': 'a' * 64, '/app/apps/api/dist/module.d.ts': 'b' * 64,
                    '/app/node_modules/.prisma/client/schema.prisma': 'c' * 64}
        d = Mock()
        d.run.return_value = json.dumps(expected)
        r.verify_api_image(d, 'fixture-image', proof)
        self.assertIn('--read-only', d.run.call_args.args)
        self.assertIn('none', d.run.call_args.args)
        d.run.return_value = json.dumps({**expected, '/app/apps/api/dist/module.d.ts': '0' * 64})
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_CONTENT_CHANGED'):
            r.verify_api_image(d, 'fixture-image', proof)

    def test_exact_additive_scope(self):
        r.validate_contract(self.c)
        for change in ['DROP TABLE id_business_v2_managed_mailboxes;', 'DELETE FROM id_business_v2_managed_mailboxes;', self.c['migration']['sql'] + 'SELECT 1;']:
            bad = copy.deepcopy(self.c)
            bad['migration']['sql'] = change
            with self.assertRaisesRegex(RuntimeError, 'MIGRATION_SCOPE_CHANGED'):
                r.validate_contract(bad)

    def test_no_unrelated_sources_or_services(self):
        for key, value in [('sources', {'apps/api/src/auth/strategy.ts': '0' * 64}), ('updatedServices', ['api', 'admin', 'online-recharge'])]:
            bad = copy.deepcopy(self.c)
            if key == 'sources':
                bad[key].update(value)
            else:
                bad[key] = value
            with self.assertRaises(RuntimeError):
                r.validate_contract(bad)

    def test_database_gate_rejects_partial_or_duplicate_migration(self):
        parent = {'ledgerSha256': 'a' * 64}
        original = {'ledgerSha256': 'a' * 64, 'pending': 0, 'selected': [], 'columns': []}
        r.check_database(original, parent, self.c)
        for key, value in [('pending', 1), ('ledgerSha256', 'b' * 64), ('columns', [{'type': 'int'}])]:
            bad = {**original, key: value}
            with self.assertRaises(RuntimeError):
                r.check_database(bad, parent, self.c)

    def test_migration_preserves_old_values_and_executes_only_once(self):
        output = ROOT / '.runtime/mailbox-validity-controls'
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as temporary:
            target = Path(temporary) / 'target'
            path = target / self.c['migration']['path']
            path.parent.mkdir(parents=True)
            path.write_text(self.c['migration']['sql'])
            stage = Path(temporary) / 'stage'
            stage.mkdir()
            parent = {'database': {'ledgerSha256': 'a' * 64}}
            before = {'ledgerSha256': 'a' * 64, 'pending': 0, 'selected': [], 'columns': []}
            after = {'ledgerSha256': 'a' * 64, 'pending': 0, 'selected': [{'name': self.c['migration']['name'], 'checksum': self.c['migration']['sha256'], 'finished': True, 'rolledBack': False}], 'columns': [{'type': 'int', 'nullable': 'NO', 'default': '30'}]}
            d = Mock()
            with patch.object(r, 'database', side_effect=[before, after]), patch.object(r, 'old_codes', return_value={'count': 2, 'sha256': 'c' * 64}):
                self.assertEqual(r.apply_migration(d, target, self.c, parent, stage), {'existingCodesPreserved': True, 'rowCount': 2})
            self.assertEqual(d.compose.call_count, 2)
            calls = d.compose.call_args_list
            self.assertIn('execute', calls[0].args)
            self.assertIn('resolve', calls[1].args)
            with patch.object(r, 'database', return_value=before), patch.object(r, 'old_codes', return_value={'count': 2}):
                with self.assertRaisesRegex(RuntimeError, 'MIGRATION_ALREADY_ACCEPTED'):
                    r.apply_migration(d, target, self.c, parent, stage)
            self.assertEqual(d.compose.call_count, 2)

    def test_workflow_retains_global_lock_and_exact_main(self):
        workflow = (ROOT / '.github/workflows/mailbox-validity-publication.yml').read_text()
        self.assertIn('group: id-business-v2-production-release', workflow)
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertEqual(workflow.count("inputs.commit == github.sha"), 2)
        self.assertNotIn('--admin', workflow)
        self.assertIn('migration without production data', (ROOT / '.github/workflows/recharge-billing-allocation-validation.yml').read_text())


if __name__ == '__main__':
    unittest.main()
