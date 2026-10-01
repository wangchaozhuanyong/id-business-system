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

    def invoke(self, apply=False, plan=None):
        argv = ['cleanup', '--plan-json', json.dumps(plan or self.plan)]
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

    def test_apply_removes_only_the_exact_ten_references_without_prune_or_force(self):
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
        self.assertEqual(len(self.removals()), 10)

    def test_local_identity_change_is_rejected(self):
        self.local_wrong = True
        with self.assertRaisesRegex(RuntimeError, 'Image identity changed'):
            self.invoke(True)
        self.assertEqual(self.removals(), [])

    def test_plan_change_requires_new_authorization(self):
        changed = copy.deepcopy(self.plan)
        changed['items'].pop()
        with self.assertRaisesRegex(RuntimeError, 'reviewed ten-reference digest'):
            self.invoke(True, changed)
        self.assertEqual(self.removals(), [])


class FxSubscriptionCacheTests(ReviewedCacheTests):
    plan_name = 'cache-cleanup-fx-subscription-20261002.json'


if __name__ == '__main__':
    unittest.main()
