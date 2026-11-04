"""Check finite source and payload boundaries without a database or Docker."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('interaction_runtime_test', HERE / 'interaction-flow-runtime.py')
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)
C = json.loads((HERE / R.CONTRACT_FILE).read_bytes())


class ScopeTests(unittest.TestCase):
    def test_pr_reproduction_refuses_local_main_and_production_credentials(self):
        validator = R.load('interaction-flow-validation.py')
        env = {'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'pull_request',
               'GITHUB_REPOSITORY': 'wangchaozhuanyong/id-business-system',
               'GITHUB_HEAD_REF': 'codex/interaction-release-20261104', 'GITHUB_SHA': 'a' * 40}
        validator.validate_context(env)
        for change in [{'GITHUB_ACTIONS': ''}, {'GITHUB_EVENT_NAME': 'workflow_dispatch'},
                       {'GITHUB_HEAD_REF': 'main'}, {'AWS_ACCESS_KEY_ID': 'synthetic'},
                       {'DATABASE_URL': 'synthetic'}, {'DOCKER_HOST': 'synthetic'}]:
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                validator.validate_context({**env, **change})

    def test_exact_admin_contract(self):
        R.validate_contract(copy.deepcopy(C))

    def test_database_workers_payment_and_old_parent_are_rejected(self):
        for key, value in [('updatedServices', ['api', 'admin']), ('migrationPerformed', True),
                           ('businessActions', 1), ('businessActions', False),
                           ('expectedCurrent', 'a' * 40), ('sourceBase', 'a' * 40),
                           ('preservedServices', ['api', 'mysql', 'caddy'])]:
            c = copy.deepcopy(C)
            c[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(RuntimeError):
                R.validate_contract(c)

    def test_non_admin_and_auth_sources_are_rejected(self):
        for name in ['apps/api/src/main.ts', 'apps/admin/src/auth/sessionCoordinator.ts',
                     'apps/admin/src/v2/../../secrets.ts', '/private/secret',
                     'apps/admin/src/v2/example.spec.ts']:
            c = copy.deepcopy(C)
            c['sources'] = {name: '0' * 64}
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                R.validate_contract(c)

    def test_artifact_paths_cannot_escape_the_static_root(self):
        c = copy.deepcopy(C)
        c['baselineAdminFiles']['../database.sql'] = '0' * 64
        with self.assertRaises(RuntimeError):
            R.validate_contract(c)

    def proof(self):
        plan = {k: 'value' for k in ['commit', 'tree', 'workflowRunId', 'workflowRunAttempt',
                                    'contractSha256', 'controlSources', 'qualitySourceEvidence', 'nativeParentCapture']}
        files = {'source/' + n: v for n, v in C['sources'].items()}
        files['admin/html/index.html'] = 'f' * 64
        proof = {**plan, 'scope': R.SCOPE, 'sources': C['sources'], 'baselineAdminReproduced': True,
                 'baselineAdminFiles': C['baselineAdminFiles'], 'migrationPerformed': False,
                 'businessActions': 0, 'adminFiles': {'index.html': 'f' * 64}, 'files': files}
        return plan, proof, files

    def test_extra_payload_and_relabeled_build_are_rejected(self):
        plan, proof, files = self.proof()
        R.verify_proof(proof, plan, C, files)
        bad = {**files, 'source/apps/api/schema.prisma': '0' * 64}
        with self.assertRaises(RuntimeError):
            R.verify_proof(proof, plan, C, bad)
        proof['commit'] = 'different'
        with self.assertRaises(RuntimeError):
            R.verify_proof(proof, plan, C, files)

    def test_parent_static_reproduction_cannot_be_skipped(self):
        plan, proof, files = self.proof()
        proof['baselineAdminReproduced'] = False
        with self.assertRaises(RuntimeError):
            R.verify_proof(proof, plan, C, files)


if __name__ == '__main__':
    unittest.main()
