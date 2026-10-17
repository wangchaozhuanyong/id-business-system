"""Offline finite publication, preservation and native database evidence guards."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


r = load('online-legacy-close-release.py')
b = load('online-legacy-close-build.py')


class ClosurePublicationTests(unittest.TestCase):
    def contract(self):
        return json.loads((HERE / r.CONTRACT_FILE).read_bytes())

    def fixture(self):
        c = self.contract()
        plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '123',
                'workflowRunAttempt': '1', 'contractSha256': 'c' * 64,
                'controlSources': {name: 'd' * 64 for name in c['controlFiles']}}
        modules = {r.API_MODULE.removesuffix('.js') + ext: 'e' * 64
                   for ext in ('.js', '.js.map', '.d.ts')}
        files = {**{'source/' + n: value for n, value in c['sources'].items()},
                 **{'api/modules/' + n: value for n, value in modules.items()}}
        proof = {**plan, 'version': 1, 'scope': r.SCOPE, 'sources': c['sources'],
                 'apiModules': modules, 'files': files, 'baselineApiReproduced': True,
                 'runtimeBaselineCommit': c['expectedCurrent'],
                 'publishedSourceCommit': c['publishedSourceCommit'],
                 'preservedAdminFiles': c['publicFiles'], 'preservedEngineFiles': c['engineFiles'],
                 'databaseVerification': {'isolated': True, 'suite': 'mysql.integration.spec.ts',
                                          'passed': 49, 'closureTestsPassed': 7},
                 'updatedServices': ['api'], 'dependentServiceRebound': 'online-recharge',
                 'migrationPerformed': False, 'businessActions': 0}
        return c, plan, proof, files

    def test_contract_limits_application_sources_and_one_api_module(self):
        c = self.contract()
        r.validate_contract(c)
        self.assertEqual(len(c['sources']), 5)
        self.assertEqual(c['apiModules'], [r.API_MODULE])
        for source in ['apps/api/src/auth/auth.service.ts', 'apps/api/prisma-mysql/schema.prisma',
                       'package-lock.json', 'apps/admin/src/v2/features/online-recharge/labels.ts',
                       'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs']:
            bad = copy.deepcopy(c)
            bad['sources'][source] = 'f' * 64
            with self.subTest(source=source), self.assertRaises(RuntimeError):
                r.validate_contract(bad)
        for change in [{'expectedCurrent': r.PUBLISHED_SOURCE_COMMIT},
                       {'publishedSourceCommit': r.EXPECTED_PREDECESSOR},
                       {'publishedAdminProofSha256': 'f' * 64},
                       {'apiModules': [r.API_MODULE, 'auth/extra.js']},
                       {'validationReuse': {'run': '123'}}, {'databaseTestMarker': ''},
                       {'minimumDatabaseTests': 48}, {'minimumClosureDatabaseTests': 6}]:
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                r.validate_contract({**c, **change})
        for field in r.PUBLISHED_MAPS:
            for change in ('missing', 'modified'):
                bad = copy.deepcopy(c)
                first = next(iter(bad[field]))
                if change == 'missing':
                    del bad[field][first]
                else:
                    bad[field][first] = 'f' * 64
                with self.subTest(field=field, change=change), self.assertRaises(RuntimeError):
                    r.validate_contract(bad)

    def test_exact_native_proof_and_payload_are_required(self):
        c, plan, proof, files = self.fixture()
        r.verify_proof(proof, plan, c, files)
        for change in [{'commit': 'f' * 40}, {'controlSources': {}}, {'baselineApiReproduced': False},
                       {'runtimeBaselineCommit': r.PUBLISHED_SOURCE_COMMIT},
                       {'publishedSourceCommit': r.EXPECTED_PREDECESSOR},
                       {'preservedAdminFiles': {}}, {'preservedEngineFiles': {}},
                       {'updatedServices': ['api', 'admin']}, {'dependentServiceRebound': None},
                       {'migrationPerformed': True}, {'businessActions': 1}]:
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                r.verify_proof({**proof, **change}, plan, c, files)
        for path in ['api/schema.prisma', 'api/modules/auth/auth.service.js', 'admin/html/index.html',
                     'engine/.env', 'source/.env.aws.production']:
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                r.verify_proof(proof, plan, c, {**files, path: 'f' * 64})

    def test_existing_database_tests_cannot_replace_real_closure_assertions(self):
        c, plan, proof, files = self.fixture()
        valid = {'success': True, 'numFailedTests': 0, 'numPendingTests': 0, 'numPassedTests': 49,
                 'testResults': [{'assertionResults': [{'fullName': '历史付款人工结案 场景' + str(n),
                                                       'status': 'passed'} for n in range(7)]}]}
        self.assertEqual(b.database_evidence(valid, c)['closureTestsPassed'], 7)
        for changed in [{'success': False}, {'numFailedTests': 1}, {'numPendingTests': 1},
                        {'numPassedTests': 48}, {'testResults': []},
                        {'testResults': [{'assertionResults': valid['testResults'][0]['assertionResults'][:6]}]},
                        {'testResults': [{'assertionResults': [{'fullName': '其他测试', 'status': 'passed'}]}]},
                        {'testResults': [{'assertionResults': [{'fullName': '人工结案', 'status': 'pending'}]}]}]:
            with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                b.database_evidence({**valid, **changed}, c)
        for change in [{'closureTestsPassed': 6}, {'isolated': False}, {'passed': 48}]:
            damaged = {**proof, 'databaseVerification': {**proof['databaseVerification'], **change}}
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                r.verify_proof(damaged, plan, c, files)

    def test_current_registration_and_online_predecessor_proofs_are_both_preserved(self):
        output = ROOT / '.runtime/online-legacy-close-control-tests'
        output.mkdir(parents=True, exist_ok=True)
        c = self.contract()
        with tempfile.TemporaryDirectory(dir=output) as temporary:
            directory = Path(temporary)
            for field, name in [('publishedProofSha256', 'online-checkout-build-proof.json'),
                                ('publishedAdminProofSha256', c['publishedAdminProofFile'])]:
                raw = name.encode()
                (directory / name).write_bytes(raw)
                c[field] = r.sha(raw)
            r.published_proofs(directory, c)
            for name in ('online-checkout-build-proof.json', c['publishedAdminProofFile']):
                path = directory / name
                original = path.read_bytes()
                path.write_bytes(b'changed')
                with self.subTest(name=name), self.assertRaises(RuntimeError):
                    r.published_proofs(directory, c)
                path.write_bytes(original)

    def test_compilation_cannot_expand_delete_or_change_other_modules(self):
        delta = load('online-checkout-build.py').module_delta
        before = {r.API_MODULE.removesuffix('.js') + ext: 'a' * 64
                  for ext in ('.js', '.js.map', '.d.ts')}
        after = {**before, r.API_MODULE: 'b' * 64}
        self.assertEqual(set(delta(before, after, [r.API_MODULE])), set(before))
        for damaged in [{}, {**after, 'auth/auth.service.js': 'f' * 64},
                        {**after, 'id-business-v2/online-recharge/contracts.d.ts': 'f' * 64}]:
            with self.subTest(damaged=damaged), self.assertRaises(RuntimeError):
                delta(before, damaged, [r.API_MODULE])

    def test_newer_runtime_retains_exact_055b_online_source_reconstruction(self):
        output = ROOT / '.runtime/online-legacy-close-control-tests'
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as temporary:
            directory = Path(temporary)
            controls = directory / 'controls'
            controls.mkdir()
            sources = {'apps/api/published.ts': b'published-055b'}
            old = {'sources': {name: b.sha(raw) for name, raw in sources.items()}}
            raw_old = json.dumps(old).encode()
            (controls / 'online-unattended-contract.json').write_bytes(raw_old)
            context = directory / 'context'
            engine = {'worker.cjs': b'published-engine'}
            c = {'predecessorRecipeSha256': b.sha(raw_old), 'expectedCurrent': r.EXPECTED_PREDECESSOR,
                 'publishedSourceCommit': r.PUBLISHED_SOURCE_COMMIT,
                 'engineRoot': 'engine', 'engineFiles': {n: b.sha(raw) for n, raw in engine.items()}}
            def reconstruct(target, recipe, _):
                self.assertEqual(recipe, old)
                for name, content in engine.items():
                    path = target / 'engine' / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(content)
            builder = types.SimpleNamespace(reconstruct=reconstruct)
            def helper(name):
                if name == 'online-unattended-build.py':
                    return types.SimpleNamespace(configure=lambda _: builder)
                if name == 'online-checkout-build.py':
                    return builder
                if name == 'recharge-record-release.py':
                    return load(name)
                self.fail('Unexpected reconstruction import ' + name)
            def git(*args):
                self.assertEqual(args[0], 'show')
                commit, name = args[1].split(':', 1)
                self.assertEqual(commit, r.PUBLISHED_SOURCE_COMMIT)
                return sources[name]
            with patch.object(b, 'HERE', controls), patch.object(b, 'load', side_effect=helper), \
                    patch.object(b, 'git', side_effect=git):
                b.reconstruct(context, c)
            self.assertEqual((context / 'apps/api/published.ts').read_bytes(), b'published-055b')
            c['predecessorRecipeSha256'] = '0' * 64
            with patch.object(b, 'HERE', controls), self.assertRaises(RuntimeError):
                b.reconstruct(context, c)

    def test_smoke_preserves_all_other_roles_and_sidecar_image(self):
        c, _, proof, _ = self.fixture()
        states = copy.deepcopy(c['services'])
        states['api'] = {**states['api'], 'image': 'sha256:new', 'containerId': 'new-api'}
        states['online-recharge'] = {**states['online-recharge'], 'containerId': 'rebound-sidecar'}
        driver = types.SimpleNamespace(run=Mock(return_value='UNAUTHORIZED_REJECTED'))
        helper = types.SimpleNamespace(engine_idle=Mock())
        read = Mock()
        def loader(name):
            self.assertEqual(name, 'online-checkout-release.py')
            return types.SimpleNamespace(read_hashes=read)
        with patch.object(r, 'load', side_effect=loader), patch.object(r, 'verify_runtime'), \
                patch.object(r, 'preserved_content'):
            r.smoke(driver, helper, Path('/not-used'), states, proof, c)
            self.assertEqual(read.call_args.args[-1], {**c['beforeApiOnlineFiles'], **proof['apiModules']})
            for role in r.PRESERVED:
                altered = copy.deepcopy(states)
                altered[role]['containerId'] = 'changed-container'
                with self.subTest(role=role), self.assertRaises(RuntimeError):
                    r.smoke(driver, helper, Path('/not-used'), altered, proof, c)
            for role, field in [('online-recharge', 'image'), ('online-recharge', 'environmentSha256'),
                                ('api', 'environmentSha256')]:
                altered = copy.deepcopy(states)
                altered[role][field] = 'unexpected'
                with self.subTest(role=role, field=field), self.assertRaises(RuntimeError):
                    r.smoke(driver, helper, Path('/not-used'), altered, proof, c)

    def test_preflight_rejects_identity_and_control_drift_before_cloud_calls(self):
        c, plan, _, _ = self.fixture()
        for identity in [{'mode': 'finalize'}, {'commit': 'invalid'}, {'workflowRunId': '0'}]:
            with self.subTest(identity=identity), patch.object(r, 'load') as loader, \
                    self.assertRaises(RuntimeError):
                r.release({**plan, 'mode': 'preflight', **identity}, c)
            loader.assert_not_called()
        raw = (HERE / r.CONTRACT_FILE).read_bytes()
        with patch.object(r, 'load') as loader, self.assertRaises(RuntimeError):
            r.release({**plan, 'mode': 'preflight', 'contractSha256': r.sha(raw)}, c)
        loader.assert_not_called()


if __name__ == '__main__':
    unittest.main()
