"""Negative release gates run without Docker, network, a database or production access."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


r = load('online-settings-release.py')
b = load('online-settings-build.py')


class ReleaseGates(unittest.TestCase):
    def fixture(self):
        plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '123', 'workflowRunAttempt': '1',
                'contractSha256': 'c' * 64, 'controlSources': {'fixture.py': 'd' * 64}}
        c = {'scope': r.SCOPE, 'sources': {'apps/api/src/id-business-v2/online-recharge/fixture.ts': 'e' * 64},
             'beforeEngineFiles': {'fixture.cjs': 'f' * 64}, 'afterEngineFiles': {'fixture.cjs': '1' * 64},
             'apiModules': ['id-business-v2/online-recharge/fixture.js']}
        modules = {c['apiModules'][0].removesuffix('.js') + ext: '2' * 64 for ext in ('.js', '.js.map', '.d.ts')}
        files = {**{'source/' + key: value for key, value in c['sources'].items()},
                 **{'api/modules/' + key: value for key, value in modules.items()},
                 'admin/html/index.html': '3' * 64, 'engine/fixture.cjs': '1' * 64}
        proof = {**plan, 'version': 1, 'scope': r.SCOPE, 'sources': c['sources'], 'apiModules': modules,
                 'afterEngineFiles': c['afterEngineFiles'], 'baselineApiReproduced': True,
                 'baselineAdminSourceReproduced': True, 'migrationPerformed': False, 'businessActions': 0,
                 'baselineAdminFiles': {'index.html': '4' * 64}, 'adminFiles': {'index.html': '3' * 64}, 'files': files}
        return plan, c, proof, files

    def test_exact_proof_and_payload_are_accepted(self):
        plan, c, proof, files = self.fixture()
        r.verify_proof(proof, plan, c, files)

    def test_wrong_commit_source_or_unverified_baseline_is_rejected(self):
        for change in [{'commit': '9' * 40}, {'migrationPerformed': True}, {'businessActions': 1},
                       {'baselineApiReproduced': False}, {'sources': {}}, {'afterEngineFiles': {}}]:
            plan, c, proof, files = self.fixture()
            with self.assertRaises(RuntimeError):
                r.verify_proof({**proof, **change}, plan, c, files)

    def test_extra_credential_file_or_unrelated_api_module_is_rejected(self):
        for name in ['source/.env.aws.production', 'api/modules/auth/auth.service.js', 'engine/extra.cjs']:
            plan, c, proof, files = self.fixture()
            changed = {**files, name: '5' * 64}
            with self.assertRaises(RuntimeError):
                r.verify_proof({**proof, 'files': changed}, plan, c, changed)

    def test_declared_module_delta_preserves_unrelated_modules_and_unchanged_types(self):
        before = {'m.js': 'old', 'm.d.ts': 'same', 'm.js.map': 'old-map', 'auth.js': 'same'}
        after = {**before, 'm.js': 'new', 'm.js.map': 'new-map'}
        self.assertEqual(set(b.module_delta(before, after, ['m.js'])), {'m.js', 'm.js.map', 'm.d.ts'})
        with self.assertRaises(RuntimeError):
            b.module_delta(before, {**after, 'auth.js': 'changed'}, ['m.js'])

    def test_path_traversal_stops_before_docker(self):
        d = Mock()
        with self.assertRaises(RuntimeError):
            r.read_hashes(d, 'fixture', '/app/', {'../secret': '0' * 64})
        d.run.assert_not_called()

    def test_different_live_target_stops_before_runtime_calls(self):
        old = r.BASE
        with tempfile.TemporaryDirectory() as folder:
            r.BASE = Path(folder)
            d = Mock()
            with self.assertRaises(RuntimeError):
                r.baseline(d, {'current': str(Path(folder) / 'other')}, Mock())
            d.run.assert_not_called()
        r.BASE = old

    def test_image_layers_and_original_runtime_configuration_are_preserved(self):
        plan, _, _, _ = self.fixture()
        plan['buildProofSha256'] = 'e' * 64
        original = {'RootFS': {'Layers': ['base']}, 'Config': {'User': '1000', 'Env': ['MODE=enabled'], 'Labels': {'owner': 'existing'}}}
        built = copy.deepcopy(original)
        built['RootFS']['Layers'].append('overlay')
        built['Config']['Labels'].update({'org.opencontainers.image.revision': plan['commit'], 'id-business-v2.recharge-record-build-proof-sha256': plan['buildProofSha256']})
        r.verify_image(original, built, plan)
        for changed in [{'User': 'root'}, {'Env': ['MODE=disabled']}]:
            bad = copy.deepcopy(built)
            bad['Config'].update(changed)
            with self.assertRaises(RuntimeError):
                r.verify_image(original, bad, plan)
        bad = copy.deepcopy(built)
        bad['RootFS']['Layers'][0] = 'other-base'
        with self.assertRaises(RuntimeError):
            r.verify_image(original, bad, plan)


if __name__ == '__main__':
    unittest.main()
