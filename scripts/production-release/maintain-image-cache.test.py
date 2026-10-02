import contextlib
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import patch

DIRECTORY = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('cache', DIRECTORY / 'maintain-image-cache.py')
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


class ObsoleteCacheTests(unittest.TestCase):
    def setUp(self):
        self.payload = Path('deploy/aws/cache-cleanup-unused-legacy-20261003.json').read_text()
        self.plan = cache.legacy_plan(self.payload)
        self.live = {'commit': self.plan['expectedCurrent'], 'images': {}, 'rollback': {'images': {}}}
        self.previous = {'commit': self.plan['expectedPrevious'], 'images': {}}
        self.args = SimpleNamespace(expected_current=self.plan['expectedCurrent'],
            legacy_plan_json=self.payload, apply=False, deployment_run=None,
            approved_policy=cache.LEGACY_POLICY, approved_plan_sha256=cache.LEGACY_PLAN_SHA256)
        self.tags = {item['id']: list(item['repoTags']) for item in self.plan['items']}
        self.commands = []

    def command(self, *args):
        self.commands.append(args)
        if args[:3] == ('docker', 'image', 'inspect'):
            item = next(item for item in self.plan['items'] if item['id'] == args[-1])
            return json.dumps({key: self.tags[item['id']] if key == 'repoTags' else item[key]
                for key in ('id', 'repoTags', 'repoDigests', 'sourceCommit', 'composeProject')})
        if args[:3] == ('docker', 'image', 'rm'):
            for item in self.plan['items']:
                if args[-1] in self.tags[item['id']]:
                    self.tags[item['id']].remove(args[-1])
                    return ''
            self.assertIn(args[-1], self.tags)
            return ''
        raise AssertionError(args)

    def run_plan(self, active=None, current=None, command=None):
        with tempfile.TemporaryDirectory(dir='.deploy') as directory, \
                patch.object(cache, 'BASE', Path(directory)), \
                patch.object(cache, 'current', side_effect=current or (lambda _: (self.live, self.previous))), \
                patch.object(cache, 'active_images', side_effect=active or (lambda: set())), \
                patch.object(cache, 'read', side_effect=command or self.command), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            cache.maintain_legacy(self.args)
            return json.loads(output.getvalue().splitlines()[-1])

    def removals(self):
        return [command for command in self.commands if command[:3] == ('docker', 'image', 'rm')]

    def test_modified_plan_is_rejected_before_docker_access(self):
        self.plan['items'][0]['repoTags'] = ['foreign/project:latest']
        with patch.object(cache, 'read') as command, self.assertRaisesRegex(RuntimeError, 'reviewed digest'):
            cache.legacy_plan(json.dumps(self.plan))
        command.assert_not_called()

    def test_read_only_mode_never_removes_images(self):
        result = self.run_plan()
        self.assertEqual(result['mode'], 'PLAN_ONLY')
        self.assertEqual(result['candidateCount'], 17)
        self.assertEqual(self.removals(), [])

    def test_current_previous_rollback_and_stopped_container_protection_precedes_all_deletion(self):
        image = self.plan['items'][0]['id']
        self.args.apply = True
        for location in ('current', 'previous', 'rollback', 'stopped'):
            self.live['images'] = {'admin': {'digest': image}} if location == 'current' else {}
            self.previous['images'] = {'admin': {'digest': image}} if location == 'previous' else {}
            self.live['rollback']['images'] = {'admin': image} if location == 'rollback' else {}
            with self.assertRaisesRegex(RuntimeError, 'used or protected'):
                self.run_plan(active=lambda: {image} if location == 'stopped' else set())
        self.assertEqual(self.removals(), [])

    def test_all_aliases_and_untagged_exact_ids_are_removed_without_prune_or_force(self):
        self.args.apply = True
        result = self.run_plan()
        expected = [reference for item in self.plan['items'] for reference in item['repoTags'] or [item['id']]]
        self.assertEqual(result['removed'], expected)
        self.assertEqual(result['status'], 'COMPLETE')
        self.assertEqual(self.removals(), [('docker', 'image', 'rm', '--no-prune', ref) for ref in expected])

    def test_changed_ownership_or_extra_alias_stops_before_any_removal(self):
        self.args.apply = True
        self.tags[self.plan['items'][-1]['id']].append('foreign/project:latest')
        with self.assertRaisesRegex(RuntimeError, 'identity or ownership changed'):
            self.run_plan()
        self.assertEqual(self.removals(), [])

    def test_new_container_and_changed_rollback_stop_the_apply(self):
        self.args.apply = True
        calls = 0
        def active():
            nonlocal calls
            calls += 1
            return {self.plan['items'][0]['id']} if calls > 17 else set()
        with self.assertRaisesRegex(RuntimeError, 'used or protected'):
            self.run_plan(active=active)
        self.previous['commit'] = 'f' * 40
        with self.assertRaisesRegex(RuntimeError, 'rollback baseline changed'):
            self.run_plan()
        self.assertEqual(self.removals(), [])

    def test_missing_exact_approval_and_automatic_deployment_are_rejected(self):
        self.args.apply = True
        self.args.approved_plan_sha256 = None
        with self.assertRaisesRegex(RuntimeError, 'approval required'):
            self.run_plan()
        self.args.deployment_run = 'github-actions-123-1'
        with self.assertRaisesRegex(RuntimeError, 'cannot run automatically'):
            self.run_plan()
        self.assertEqual(self.removals(), [])


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.expected = 'a' * 40
        self.manifest = {'commit': self.expected, 'previousCommit': 'b' * 40,
                         'deploymentRun': 'github-actions-123-1',
                         'dataAuditAfter': {'violationCount': 0},
                         'images': {'admin': {'digest': 'live'}},
                         'rollback': {'images': {'admin': 'rollback'}}}
        self.previous = {'commit': 'b' * 40, 'images': {'admin': {'digest': 'previous'}}}
        self.ids = ['sha256:' + 'c' * 64, 'sha256:' + 'd' * 64]
        self.tags = ['e' * 40 + '-123-1-admin', 'f' * 40 + '-124-1-api']
        self.inventory = [{'id': image_id, 'repoTags': [cache.REPOSITORY + ':' + tag]}
                          for image_id, tag in zip(self.ids, self.tags)]
        self.plan = cache.make_plan(self.expected, self.previous, {'live'}, self.inventory)
        self.commands = []

    def run_command(self, *args):
        self.commands.append(args)
        if args[:3] == ('docker', 'image', 'inspect'):
            return next(item['imageId'] for item in self.plan['items']
                        if cache.REPOSITORY + ':' + item['tag'] == args[-1])
        if args[:3] == ('docker', 'image', 'rm'):
            return ''
        if args[:3] == ('aws', 'ecr', 'batch-get-image'):
            return json.dumps({'images': [
                {'imageId': {'imageTag': item['tag']},
                 'imageManifest': json.dumps({'config': {'digest': item['imageId']}})}
                for item in self.plan['items']]})
        raise AssertionError(args)

    def apply(self, active=None, command=None):
        with patch.object(cache, 'current', return_value=(self.manifest, self.previous)), \
                patch.object(cache, 'active_images', side_effect=active or (lambda: set())), \
                patch.object(cache, 'read', side_effect=command or self.run_command):
            return cache.apply_plan(self.plan)

    def removals(self):
        return [command for command in self.commands if command[:3] == ('docker', 'image', 'rm')]

    def test_running_stopped_current_previous_and_rollback_references_are_protected(self):
        self.assertEqual(cache.protected_images(self.manifest, self.previous, {'running', 'stopped'}),
                         {'running', 'stopped', 'live', 'previous', 'rollback'})
        self.assertEqual(cache.make_plan(self.expected, self.previous, set(self.ids),
                                        self.inventory)['items'], [])

    def test_foreign_untagged_and_unrecognized_images_are_outside_policy(self):
        inventory = [{'id': self.ids[0], 'repoTags': ['other/project:latest']},
                     {'id': self.ids[0], 'repoTags': [cache.REPOSITORY + ':latest']},
                     {'id': self.ids[1], 'repoTags': None}]
        self.assertEqual(cache.make_plan(self.expected, self.previous, set(), inventory)['items'], [])

    def test_invalid_duplicate_and_excessive_inventory_stop_before_deletion(self):
        for inventory in ([{'id': 'invalid', 'repoTags': []}], self.inventory * 2,
                          self.inventory * 251):
            with self.assertRaises(RuntimeError):
                cache.make_plan(self.expected, self.previous, set(), inventory)
        self.assertEqual(self.removals(), [])

    def test_plan_digest_binds_both_baselines_exact_references_and_protection(self):
        digest = cache.plan_digest(self.plan)
        for changed in ({**self.plan, 'expectedCurrent': 'x'},
                        {**self.plan, 'expectedPrevious': 'x'},
                        {**self.plan, 'protectedImageIds': ['x']},
                        {**self.plan, 'items': self.plan['items'][:-1]}):
            self.assertNotEqual(cache.plan_digest(changed), digest)

    def test_remote_identity_is_verified_for_entire_plan_before_any_removal(self):
        def command(*args):
            if args[:3] == ('aws', 'ecr', 'batch-get-image'):
                return json.dumps({'images': []})
            return self.run_command(*args)
        with self.assertRaisesRegex(RuntimeError, 'Remote ECR identity'):
            self.apply(command=command)
        self.assertEqual(self.removals(), [])

    def test_missing_remote_recovery_blocks_deletion(self):
        with patch.object(cache, 'verify_remote', side_effect=RuntimeError('missing')):
            with self.assertRaisesRegex(RuntimeError, 'missing'):
                self.apply()
        self.assertEqual(self.removals(), [])

    def test_deletion_uses_only_exact_references_without_force_or_prune(self):
        self.assertEqual(self.apply(), self.tags)
        self.assertEqual(self.removals(), [
            ('docker', 'image', 'rm', '--no-prune', cache.REPOSITORY + ':' + tag)
            for tag in self.tags])
        self.assertEqual(self.commands[0][:3], ('aws', 'ecr', 'batch-get-image'))

    def test_a_new_container_reference_blocks_that_image_during_apply(self):
        with self.assertRaisesRegex(RuntimeError, 'used or protected'):
            self.apply(active=iter([set(), {self.ids[1]}]).__next__)
        self.assertEqual(len(self.removals()), 1)

    def test_changed_local_identity_blocks_removal(self):
        def command(*args):
            if args[:3] == ('docker', 'image', 'inspect'):
                return 'changed'
            return self.run_command(*args)
        with patch.object(cache, 'verify_remote'), \
                patch.object(cache, 'current', return_value=(self.manifest, self.previous)), \
                patch.object(cache, 'active_images', return_value=set()), \
                patch.object(cache, 'read', side_effect=command):
            with self.assertRaisesRegex(RuntimeError, 'Local image identity'):
                cache.apply_plan(self.plan)
        self.assertEqual(self.removals(), [])

    def test_automatic_retention_requires_this_successful_release_and_passed_audit(self):
        cache.verify_deployment(self.manifest, 'github-actions-123-1')
        for manifest, deployment in ((self.manifest, 'github-actions-124-1'),
                                     ({**self.manifest, 'dataAuditAfter': {}}, 'github-actions-123-1'),
                                     ({**self.manifest, 'dataAuditAfter': {'violationCount': 1}},
                                      'github-actions-123-1')):
            with self.assertRaises(RuntimeError):
                cache.verify_deployment(manifest, deployment)

    def invoke(self, flags):
        runtime = DIRECTORY.parent.parent / '.runtime/cache-retention-tests'
        runtime.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=runtime) as root, \
                patch.object(cache, 'BASE', Path(root)), \
                patch.object(cache, 'current', return_value=(self.manifest, self.previous)), \
                patch.object(cache, 'active_images', return_value={'live'}), \
                patch.object(cache, 'read', return_value=''), \
                patch.object(cache, 'make_plan', return_value=self.plan), \
                patch.object(cache, 'verify_remote'), \
                patch.object(cache, 'apply_plan', return_value=self.tags) as apply, \
                patch.object(cache.shutil, 'disk_usage', return_value=SimpleNamespace(free=100)), \
                patch.object(sys, 'argv', ['cache', '--expected-current', self.expected, *flags]), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            cache.main()
            return json.loads(output.getvalue()), apply.call_count

    def test_default_is_read_only_without_deletion(self):
        result, calls = self.invoke([])
        self.assertEqual(result['mode'], 'PLAN_ONLY')
        self.assertEqual(calls, 0)

    def test_manual_cleanup_needs_policy_and_exact_verified_plan(self):
        for flags in (['--apply'], ['--apply', '--approved-policy', cache.POLICY],
                      ['--apply', '--approved-policy', cache.POLICY,
                       '--approved-plan-sha256', 'a' * 64]):
            with self.assertRaises(RuntimeError):
                self.invoke(flags)
        result, calls = self.invoke(['--apply', '--approved-policy', cache.POLICY,
                                     '--approved-plan-sha256', cache.plan_digest(self.plan)])
        self.assertEqual(result['mode'], 'APPLIED')
        self.assertEqual(calls, 1)
        self.assertNotIn('plan', result)

    def test_failed_or_other_deployment_cannot_trigger_automatic_deletion(self):
        with self.assertRaisesRegex(RuntimeError, 'successful release'):
            self.invoke(['--apply', '--approved-policy', cache.POLICY,
                         '--deployment-run', 'github-actions-124-1'])
        result, calls = self.invoke(['--apply', '--approved-policy', cache.POLICY,
                                     '--deployment-run', 'github-actions-123-1'])
        self.assertEqual(result['mode'], 'APPLIED')
        self.assertEqual(calls, 1)


if __name__ == '__main__':
    unittest.main()
