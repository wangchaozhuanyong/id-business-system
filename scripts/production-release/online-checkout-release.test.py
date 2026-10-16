"""Offline publication guards; no production, database or payment calls."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


r = load('online-checkout-release.py')
b = load('online-checkout-build.py')


class PublicationTests(unittest.TestCase):
    def fixture(self):
        plan = dict(commit='a' * 40, tree='b' * 40, workflowRunId='123', workflowRunAttempt='1', contractSha256='c' * 64, controlSources={})
        modules = {'id-business-v2/online-recharge/validation' + ext: 'd' * 64 for ext in ('.js', '.js.map', '.d.ts')}
        files = {'source/apps/api/source.ts': 'e' * 64, 'admin/html/index.html': 'f' * 64,
                 **{'api/modules/' + n: v for n, v in modules.items()}}
        admin = {'index.html': 'f' * 64}
        c = dict(scope=r.SCOPE, sources={'apps/api/source.ts': 'e' * 64}, afterEngineFiles={}, beforeEngineFiles={}, apiModules=['id-business-v2/online-recharge/validation.js'], baselineAdminFilesSha256=r.load('recharge-record-release.py').fingerprint(admin))
        proof = dict(**plan, version=1, scope=r.SCOPE, sources=c['sources'], afterEngineFiles={},
                     baselineApiReproduced=True, baselineAdminSourceReproduced=True, migrationPerformed=False,
                     businessActions=0, apiModules=modules, adminFiles=admin, baselineAdminFiles=admin, files=files)
        return plan, c, proof, files

    def test_proof_accepts_only_native_finite_payload(self):
        p, c, proof, files = self.fixture()
        r.verify_proof(proof, p, c, files)
        for key, value in [('businessActions', 1), ('baselineApiReproduced', False), ('migrationPerformed', True), ('workflowRunId', '456')]:
            damaged = {**proof, key: value}
            with self.assertRaises(RuntimeError):
                r.verify_proof(damaged, p, c, files)

    def test_extra_secret_auth_or_schema_payload_is_rejected(self):
        p, c, proof, files = self.fixture()
        for extra in ['engine/.env', 'api/modules/auth/auth.service.js', 'api/schema.prisma']:
            with self.assertRaises(RuntimeError):
                r.verify_proof(proof, p, c, {**files, extra: 'x' * 64})

    def test_admin_baseline_cannot_be_replaced_with_an_unproved_subset(self):
        p, c, proof, files = self.fixture()
        proof['baselineAdminFiles']['assets/unreviewed.js'] = 'a' * 64
        with self.assertRaises(RuntimeError):
            r.verify_proof(proof, p, c, files)

    def test_compiled_modules_cannot_expand_or_delete(self):
        _, _, proof, _ = self.fixture()
        modules = proof['apiModules']
        expected = ['id-business-v2/online-recharge/validation.js']
        self.assertEqual(b.module_delta({}, modules, expected), modules)
        with self.assertRaises(RuntimeError):
            b.module_delta({}, {**modules, 'auth/unsafe.js': 'x'}, expected)
        with self.assertRaises(RuntimeError):
            b.module_delta(modules, {}, expected)

    def test_frozen_contract_has_no_schema_dependencies_or_resource_changes(self):
        c = json.loads((HERE / 'online-checkout-contract.json').read_bytes())
        self.assertEqual(c['scope'], r.SCOPE)
        self.assertEqual(r.UPDATED, ('api', 'admin', 'online-recharge'))
        self.assertTrue(all(n.startswith('id-business-v2/online-recharge/') for n in c['apiModules']))
        self.assertFalse(any('/migrations/' in n or n.endswith('schema.prisma') or n.endswith('package.json') for n in c['sources']))
        self.assertEqual(set(c['beforeEngineFiles']) - set(c['afterEngineFiles']), set())

    def test_published_removals_are_confined_to_exact_build_context_bytes(self):
        output = HERE.parents[1] / '.runtime/online-checkout-control-tests'
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as directory:
            context = Path(directory)
            source = context / 'apps/withdrawn.ts'
            source.parent.mkdir()
            source.write_bytes(b'published')
            outside = context / 'outside.ts'
            outside.write_bytes(b'published')
            expected = b.sha(b'published')
            for invalid in [{'apps/withdrawn.ts': '0' * 64}, {'apps/../outside.ts': expected},
                            {'apps/withdrawn.ts': None}]:
                with self.assertRaises(RuntimeError):
                    b.remove_published_sources(context, invalid)
                self.assertEqual(source.read_bytes(), b'published')
                self.assertEqual(outside.read_bytes(), b'published')
            link = context / 'apps/link.ts'
            link.symlink_to(source)
            with self.assertRaises(RuntimeError):
                b.remove_published_sources(context, {'apps/link.ts': expected})
            b.remove_published_sources(context, {'apps/withdrawn.ts': expected, 'apps/absent.ts': None})
            self.assertFalse(source.exists())


if __name__ == '__main__':
    unittest.main()
