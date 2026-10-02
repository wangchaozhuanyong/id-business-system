import contextlib
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

DIRECTORY = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('cleanup', DIRECTORY / 'cleanup-reviewed-cache.py')
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class ReviewedCacheTests(unittest.TestCase):
    plan_name = 'cache-cleanup-20261001.json'

    def setUp(self):
        self.plan = json.loads((DIRECTORY.parent.parent / 'deploy/aws' / self.plan_name).read_text())
        self.digest = hashlib.sha256(json.dumps(self.plan, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        self.manifest = {'commit': self.plan['expectedCurrent'],
                         'previousRelease': '/opt/id-business-v2/releases/previous',
                         'images': {'admin': {'digest': 'protected-current'}},
                         'rollback': {'images': {'admin': 'protected-rollback'}}}
        self.previous = {'commit': self.plan['expectedPrevious'],
                         'images': {'admin': {'digest': 'protected-previous'}}}
        self.active = {'protected-current'}
        self.commands = []
        self.remote_wrong = False
        self.local_wrong = False

    def run_command(self, *args):
        self.commands.append(args)
        if args[:3] == ('docker', 'image', 'inspect'):
            item = next(item for item in self.plan['items']
                        if self.plan['repository'] + ':' + item['tag'] == args[-1])
            return 'changed-local' if self.local_wrong else item['imageId']
        if args[:3] == ('docker', 'image', 'rm'):
            return ''
        if args[:3] == ('aws', 'ecr', 'batch-get-image'):
            return json.dumps({'images': [
                {'imageId': {'imageTag': item['tag']},
                 'imageManifest': json.dumps({'config': {'digest':
                     'changed-remote' if self.remote_wrong else item['imageId']}})}
                for item in self.plan['items']]})
        raise AssertionError(args)

    def invoke(self, apply=False, plan=None, expected_current=None):
        argv = ['cleanup', '--plan-json', json.dumps(plan or self.plan)]
        if expected_current:
            argv.extend(['--expected-current', expected_current])
        if apply:
            argv.extend(['--apply', '--approved-plan-sha256', self.digest])
        with patch.object(sys, 'argv', argv), \
                patch.object(cleanup, 'current', return_value=self.manifest), \
                patch.object(cleanup, 'active_images', side_effect=lambda: self.active), \
                patch.object(cleanup, 'run', side_effect=self.run_command), \
                patch.object(Path, 'read_text', return_value=json.dumps(self.previous)), \
                patch.object(Path, 'open', return_value=io.StringIO()), \
                patch.object(cleanup.fcntl, 'flock'), \
                patch.object(cleanup.shutil, 'disk_usage', return_value=SimpleNamespace(free=100)), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            cleanup.main()
        return json.loads(output.getvalue())

    def removals(self):
        return [command for command in self.commands if command[:3] == ('docker', 'image', 'rm')]

    def test_default_is_plan_only(self):
        self.assertEqual(self.invoke()['mode'], 'PLAN_ONLY')
        self.assertEqual(self.removals(), [])

    def test_apply_removes_only_exact_reviewed_references_without_prune_or_force(self):
        receipt = self.invoke(True)
        expected = [('docker', 'image', 'rm', '--no-prune', self.plan['repository'] + ':' + item['tag'])
                    for item in self.plan['items']]
        self.assertEqual(self.removals(), expected)
        self.assertEqual(receipt['removed'], [item['tag'] for item in self.plan['items']])

    def test_changed_current_is_rejected_before_any_removal(self):
        self.manifest['commit'] = 'changed'
        with self.assertRaisesRegex(RuntimeError, 'Production baseline changed'):
            self.invoke(True)
        self.assertEqual(self.removals(), [])

    def test_apply_requires_the_explicit_approved_digest(self):
        with patch.object(sys, 'argv', ['cleanup', '--plan-json', json.dumps(self.plan), '--apply']):
            with self.assertRaisesRegex(RuntimeError, 'Explicit plan approval required'):
                cleanup.main()
        self.assertEqual(self.commands, [])

    def test_changed_previous_is_rejected_before_any_removal(self):
        self.previous['commit'] = 'changed'
        with self.assertRaisesRegex(RuntimeError, 'Previous rollback version changed'):
            self.invoke(True)
        self.assertEqual(self.removals(), [])

    def test_approval_for_another_reviewed_plan_is_rejected(self):
        other_digest = next(digest for digest in cleanup.REVIEWED_PLANS if digest != self.digest)
        with patch.object(sys, 'argv', ['cleanup', '--plan-json', json.dumps(self.plan),
                                       '--apply', '--approved-plan-sha256', other_digest]):
            with self.assertRaisesRegex(RuntimeError, 'Explicit plan approval required'):
                cleanup.main()
        self.assertEqual(self.commands, [])

    def test_current_release_is_protected(self):
        self.manifest['images']['admin']['digest'] = self.plan['items'][0]['imageId']
        with self.assertRaisesRegex(RuntimeError, 'protected release'):
            self.invoke(True)
        self.assertEqual(self.removals(), [])

    def test_current_rollback_image_is_protected(self):
        self.manifest['rollback']['images']['admin'] = self.plan['items'][0]['imageId']
        with self.assertRaisesRegex(RuntimeError, 'protected release'):
            self.invoke(True)
        self.assertEqual(self.removals(), [])

    def test_container_reference_is_protected(self):
        self.active.add(self.plan['items'][0]['imageId'])
        with self.assertRaisesRegex(RuntimeError, 'protected release'):
            self.invoke(True)
        self.assertEqual(self.removals(), [])

    def test_previous_release_is_protected(self):
        self.previous['images']['admin']['digest'] = self.plan['items'][0]['imageId']
        with self.assertRaisesRegex(RuntimeError, 'protected release'):
            self.invoke(True)
        self.assertEqual(self.removals(), [])

    def test_remote_identity_must_be_recoverable_before_any_removal(self):
        self.remote_wrong = True
        with self.assertRaisesRegex(RuntimeError, 'Remote ECR image identity differs'):
            self.invoke(True)
        self.assertEqual(self.removals(), [])

    def test_approved_older_version_does_not_extend_the_previous_rollback_chain(self):
        self.previous['rollback'] = {'images': {'admin': self.plan['items'][0]['imageId']}}
        self.invoke(True)
        self.assertEqual(len(self.removals()), len(self.plan['items']))

    def test_local_identity_change_is_rejected(self):
        self.local_wrong = True
        with self.assertRaisesRegex(RuntimeError, 'Image identity changed'):
            self.invoke(True)
        self.assertEqual(self.removals(), [])

    def test_plan_change_requires_new_authorization(self):
        changed = copy.deepcopy(self.plan)
        changed['items'].pop()
        with self.assertRaisesRegex(RuntimeError, 'reviewed cache digest'):
            self.invoke(True, changed)
        self.assertEqual(self.removals(), [])


class FxSubscriptionCacheTests(ReviewedCacheTests):
    plan_name = 'cache-cleanup-fx-subscription-20261002.json'


class UnifiedReleaseCacheTests(ReviewedCacheTests):
    plan_name = 'cache-cleanup-unified-20261002.json'

    def setUp(self):
        super().setUp()
        self.manifest['commit'] = 'a' * 40

    def invoke(self, apply=False, plan=None, expected_current=None):
        return super().invoke(apply, plan, expected_current or 'a' * 40)

    def test_post_release_requires_the_exact_new_current_and_preserves_previous(self):
        self.manifest['commit'] = 'a' * 40
        self.assertEqual(self.invoke(expected_current='a' * 40)['mode'], 'PLAN_ONLY')
        with self.assertRaisesRegex(RuntimeError, 'Production baseline changed'):
            self.invoke(True, expected_current='b' * 40)
        self.assertEqual(self.removals(), [])

    def test_capacity_recovery_accepts_only_the_exact_current_previous_pair(self):
        self.manifest['commit'] = self.plan['expectedCurrent']
        self.previous['commit'] = 'd1ed460eff55df7167a806dd3e1f7abdef5ef24d'
        self.assertEqual(self.invoke(True, expected_current=self.manifest['commit'])['approvedCount'], 12)

    def test_pre_release_pair_cannot_be_used_after_another_current_is_running(self):
        self.previous['commit'] = 'd1ed460eff55df7167a806dd3e1f7abdef5ef24d'
        with self.assertRaisesRegex(RuntimeError, 'Previous rollback version changed'):
            self.invoke(True)
        self.assertEqual(self.removals(), [])

    def test_capacity_recovery_still_protects_the_previous_admin_image(self):
        self.manifest['commit'] = self.plan['expectedCurrent']
        self.previous['commit'] = 'd1ed460eff55df7167a806dd3e1f7abdef5ef24d'
        self.previous['images']['admin']['digest'] = self.plan['items'][0]['imageId']
        with self.assertRaisesRegex(RuntimeError, 'protected release'):
            self.invoke(True, expected_current=self.manifest['commit'])
        self.assertEqual(self.removals(), [])


class UnifiedRecoveryCacheTests(ReviewedCacheTests):
    plan_name = 'cache-cleanup-unified-recovery-20261002.json'

    def test_post_release_override_requires_the_exact_running_current(self):
        self.manifest['commit'] = 'c' * 40
        self.assertEqual(self.invoke(expected_current='c' * 40)['approvedCount'], 6)
        with self.assertRaisesRegex(RuntimeError, 'Production baseline changed'):
            self.invoke(True, expected_current='d' * 40)
        self.assertEqual(self.removals(), [])


class RechargeNamesCacheTests(ReviewedCacheTests):
    plan_name = 'cache-cleanup-recharge-names-20261002.json'

    def test_candidate_images_are_explicitly_protected(self):
        self.assertEqual(len(self.plan['protectedCandidateImageIds']), 5)
        self.assertTrue(set(self.plan['protectedCandidateImageIds']).isdisjoint(
            item['imageId'] for item in self.plan['items']))

    def test_running_baseline_cannot_be_overridden(self):
        with self.assertRaisesRegex(RuntimeError, 'does not allow a post-release baseline'):
            self.invoke(True, expected_current='b' * 40)
        self.assertEqual(self.removals(), [])


class RechargeExecutionCacheTests(RechargeNamesCacheTests):
    plan_name = 'cache-cleanup-recharge-execution-20261002.json'

    def test_release_candidate_is_blocked_even_if_not_in_live_manifests(self):
        self.plan['protectedCandidateImageIds'][0] = self.plan['items'][0]['imageId']
        self.digest = hashlib.sha256(json.dumps(self.plan, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        with patch.dict(cleanup.REVIEWED_PLANS, {self.digest: ('c59861de03df8b71d5dc3442951d82ee859d4d97-36965061061-1-',)}), \
                patch.dict(cleanup.REVIEWED_PLAN_COUNTS, {self.digest: 5}):
            with self.assertRaisesRegex(RuntimeError, 'protected release'):
                self.invoke(True)
        self.assertEqual(self.removals(), [])


class StorageCacheTests(RechargeNamesCacheTests):
    plan_name = 'cache-cleanup-storage-20261002.json'

    def test_all_targets_are_superseded_execution_build(self):
        self.assertTrue(all(item['tag'].startswith(
            '4c811392268c19aae803131166b6070344549d1d-36993584579-1-')
            for item in self.plan['items']))
        self.assertEqual(len(self.plan['items']), 5)


if __name__ == '__main__':
    unittest.main()
