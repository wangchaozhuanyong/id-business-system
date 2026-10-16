"""Validate immutable native inputs and the Admin-only publication boundary."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import Mock

HERE = Path(__file__).resolve().parent


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / name)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


r = module('workspace-drag-release.py')
c = json.loads((HERE / 'workspace-drag-contract.json').read_bytes())


class DragReleaseTests(unittest.TestCase):
    def test_only_admin_may_change_and_no_role_may_disappear(self):
        before = {'admin': {'id': 'old'}, 'api': {'id': 'a'}, 'mysql': {'id': 'm'}, 'auto-recharge': {'id': 'w'}}
        after = {**before, 'admin': {'id': 'new'}}
        r.preserved(before, after)
        for name in ('api', 'mysql', 'auto-recharge'):
            with self.assertRaisesRegex(RuntimeError, 'PRESERVED_SERVICES_CHANGED'):
                r.preserved(before, {**after, name: {'id': 'changed'}})
        del after['mysql']
        with self.assertRaisesRegex(RuntimeError, 'PRESERVED_SERVICES_CHANGED'):
            r.preserved(before, after)

    def test_image_environment_entrypoint_and_user_cannot_change(self):
        original = {'Env': ['A=B'], 'Entrypoint': ['nginx'], 'User': '101', 'Image': 'sha256:' + 'a' * 64}
        built = {**original, 'Image': '', 'Labels': {'revision': 'new'}}
        r.verify_image_configuration(original, built)
        for name in ('Env', 'Entrypoint', 'User'):
            with self.assertRaisesRegex(RuntimeError, 'IMAGE_CONFIGURATION_CHANGED'):
                r.verify_image_configuration(original, {**built, name: 'changed'})

    def fixture(self):
        plan = {k: 'fixture' for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt',
                'contractSha256', 'controllerSha256', 'releaseUtilitySha256', 'helperSha256')}
        plan['qualityVerification'] = {'passed': True}
        admin = {'assets/' + str(i) + '.js': 'b' for i in range(250)}
        files = {**{'source/' + n: v for n, v in c['sources'].items()},
                 **{'admin/html/' + n: v for n, v in admin.items()}}
        proof = {**plan, 'version': 1, 'scope': c['scope'], 'sources': c['sources'],
                 'publishedProofSha256': c['publishedProofSha256'], 'browserChecks': 13,
                 'updatedServices': ['admin'], 'migrationPerformed': False, 'businessActions': 0,
                 'files': files, 'baselineAdminFiles': admin, 'adminFiles': admin}
        h = Mock()
        h.file_inventory.side_effect = lambda _: copy.deepcopy({**files, 'build-proof.json': 'a'})
        return proof, plan, h

    def test_proof_requires_successful_browser_origin_and_no_database_or_business_actions(self):
        proof, plan, h = self.fixture()
        r.validate_proof(proof, plan, c, Path('/fixture'), h)
        for key, value in [('browserChecks', 12), ('migrationPerformed', True), ('businessActions', 1),
                           ('updatedServices', ['admin', 'api']), ('publishedProofSha256', 'changed'),
                           ('qualityVerification', {'passed': False})]:
            with self.assertRaisesRegex(RuntimeError, 'PROOF_INVALID'):
                r.validate_proof({**proof, key: value}, plan, c, Path('/fixture'), h)

    def test_api_or_unlisted_payload_is_rejected_even_with_matching_inventory(self):
        proof, plan, h = self.fixture()
        for name in ('api/modules/pay.js', 'source/unrelated.vue', 'admin/nginx.conf'):
            bad = {**proof['files'], name: 'injected'}
            h.file_inventory.side_effect = lambda _, bad=bad: copy.deepcopy(bad)
            with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_SCOPE_CHANGED'):
                r.validate_proof({**proof, 'files': bad}, plan, c, Path('/fixture'), h)

    def test_runtime_sources_match_frozen_three_file_boundary(self):
        self.assertEqual(len(c['sources']), 3)
        for name, expected in c['sources'].items():
            self.assertEqual(r.sha((HERE.parents[1] / name).read_bytes()), expected)


if __name__ == '__main__':
    unittest.main()
