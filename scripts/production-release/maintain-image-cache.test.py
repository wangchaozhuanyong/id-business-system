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


class BuilderCacheTests(unittest.TestCase):
    def setUp(self):
        self.expected = 'c7c7cd5fab7138f445c715118b5dd75d0df4ac2f'
        self.previous = {'commit': '220c6f45d9cbca8f4a95f275a24168c41d387a17'}
        self.usage = {'Type': 'Build Cache', 'Active': '0', 'TotalCount': '52',
                      'Size': '1.827GB', 'Reclaimable': '1.827GB'}
        self.args = SimpleNamespace(expected_current=self.expected, deployment_run=None,
            apply=False, approved_policy=cache.BUILDER_POLICY, approved_plan_sha256=None)

    def command(self, *args):
        if args[:3] == ('docker', 'ps', '-a'):
            return '20260821t095106z\n20260821t095106z'
        if args[:3] == ('docker', 'system', 'df'):
            return json.dumps(self.usage)
        raise AssertionError(args)

    def test_readonly_binds_baseline_container_ids_and_legacy_count(self):
        with patch.object(cache, 'current', return_value=({}, self.previous)), \
                patch.object(cache, 'active_images', return_value={'container-image'}), \
                patch.object(cache, 'read', side_effect=self.command), patch.object(cache, 'prune_builder') as prune:
            plan = cache.builder_plan(self.expected)
        self.assertEqual(plan['expectedPrevious'], self.previous['commit'])
        self.assertEqual(plan['protectedContainerImageIds'], ['container-image'])
        self.assertEqual(plan['builderUsage']['TotalCount'], '52')
        prune.assert_not_called()

    def test_active_cache_or_other_project_is_rejected(self):
        with patch.object(cache, 'current', return_value=({}, self.previous)), \
                patch.object(cache, 'read', side_effect=self.command):
            self.usage['Active'] = '1'
            with self.assertRaisesRegex(RuntimeError, 'Active or unavailable'):
                cache.builder_plan(self.expected)
        with patch.object(cache, 'current', return_value=({}, self.previous)), \
                patch.object(cache, 'read', return_value='other-project'):
            with self.assertRaisesRegex(RuntimeError, 'dedicated project host'):
                cache.builder_plan(self.expected)

    def test_cache_count_change_is_rejected(self):
        self.usage['TotalCount'] = '53'
        with patch.object(cache, 'current', return_value=({}, self.previous)), \
                patch.object(cache, 'read', side_effect=self.command):
            with self.assertRaisesRegex(RuntimeError, 'count changed'):
                cache.builder_plan(self.expected)

    def test_missing_approval_and_changed_plan_prevent_prune(self):
        plan = {'expectedPrevious': self.previous['commit'], 'protectedContainerImageIds': []}
        self.args.apply = True
        with tempfile.TemporaryDirectory(dir='.deploy') as directory, \
                patch.object(cache, 'BASE', Path(directory)), \
                patch.object(cache, 'builder_plan', return_value=plan), patch.object(cache, 'prune_builder') as prune:
            with self.assertRaisesRegex(RuntimeError, 'approval required'):
                cache.maintain_builder(self.args)
        self.args.approved_plan_sha256 = cache.plan_digest(plan)
        with tempfile.TemporaryDirectory(dir='.deploy') as directory, \
                patch.object(cache, 'BASE', Path(directory)), \
                patch.object(cache, 'builder_plan', side_effect=[plan, {**plan, 'changed': True}]), \
                patch.object(cache, 'prune_builder') as prune:
            with self.assertRaisesRegex(RuntimeError, 'plan changed'):
                cache.maintain_builder(self.args)
            prune.assert_not_called()

    def test_only_builder_cache_command_is_used_and_raw_output_is_suppressed(self):
        with patch.object(cache.subprocess, 'run', return_value=SimpleNamespace(
                returncode=0, stdout='Total reclaimed space: 1.827GB\n')) as command:
            self.assertEqual(cache.prune_builder(), '1.827GB')
        self.assertEqual(command.call_args.args, (['docker', 'builder', 'prune', '--all'],))
        self.assertEqual(command.call_args.kwargs['input'], 'y\n')

    def test_other_baseline_and_automatic_invocation_stop_before_docker(self):
        for expected, deployment in (('f' * 40, None), (self.expected, 'github-actions-1-1')):
            self.args.expected_current = expected
            self.args.deployment_run = deployment
            with patch.object(cache, 'builder_plan') as plan:
                with self.assertRaisesRegex(RuntimeError, 'manual production baseline'):
                    cache.maintain_builder(self.args)
                plan.assert_not_called()

    def test_success_receipt_requires_same_containers_and_empty_build_cache(self):
        self.args.apply = True
        plan = {'expectedPrevious': self.previous['commit'], 'protectedContainerImageIds': ['kept']}
        self.args.approved_plan_sha256 = cache.plan_digest(plan)
        with tempfile.TemporaryDirectory(dir='.deploy') as directory, \
                patch.object(cache, 'BASE', Path(directory)), patch.object(cache, 'builder_plan', return_value=plan), \
                patch.object(cache, 'prune_builder', return_value='1.827GB'), \
                patch.object(cache, 'current', return_value=({}, self.previous)), \
                patch.object(cache, 'active_images', return_value={'kept'}), \
                patch.object(cache, 'read', return_value=json.dumps({**self.usage, 'TotalCount': '0'})), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            cache.maintain_builder(self.args)
            receipt = json.loads(output.getvalue())
        self.assertEqual(receipt['status'], 'COMPLETE')
        self.assertEqual(receipt['builderUsageAfter']['TotalCount'], '0')


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
        self.dependencies = {'version': 1, 'imageIds': [], 'serviceRollback': {}, 'evidenceSha256': {}}
        self.plan = cache.make_plan(self.expected, self.previous, {'live'}, self.inventory, self.dependencies)
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
                patch.object(cache, 'collect_dependencies', return_value=self.dependencies), \
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
                        {**self.plan, 'items': self.plan['items'][:-1]},
                        {**self.plan, 'dependencies': {**self.dependencies, 'evidenceSha256': {'producer': 'f' * 64}}}):
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

    def test_remote_config_identity_is_rechecked_for_each_exact_reference(self):
        self.apply()
        requests = [args for args in self.commands if args[:3] == ('aws', 'ecr', 'batch-get-image')]
        self.assertEqual(len(requests), 3)
        self.assertEqual([sum(value.startswith('imageTag=') for value in args) for args in requests], [2, 1, 1])

    def test_remote_recovery_disappearing_after_plan_verification_prevents_first_delete(self):
        calls = 0
        def command(*args):
            nonlocal calls
            if args[:3] == ('aws', 'ecr', 'batch-get-image'):
                calls += 1
                if calls > 1:
                    return json.dumps({'images': []})
            return self.run_command(*args)
        with self.assertRaisesRegex(RuntimeError, 'Remote ECR identity'):
            self.apply(command=command)
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
                patch.object(cache, 'collect_dependencies', return_value=self.dependencies), \
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
                patch.object(cache, 'collect_dependencies', return_value=self.dependencies), \
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



class HistoricalReceiptRetentionTests(unittest.TestCase):
    def manifest(self):
        baseline = 'ed2f75b0f4075347224ce3b2c82a90ed514d8d22'
        gate = {'accepted': True, 'policyId': 'historical-finance-20261005',
            'expectedCurrent': baseline, 'stage': 'after', 'checkCount': 48,
            'executedCheckCount': 48, 'unavailableCheckCount': 0, 'violationCount': 10,
            'sources': {'accounts': 'a' * 64}, 'metadataSha256': 'b' * 64}
        return {'previousCommit': baseline, 'deploymentRun': 'github-actions-123-1',
            'dataAuditBefore': {'historicalException': {**gate, 'stage': 'before'}},
            'dataAuditAfter': {'violationCount': 10, 'historicalException': gate}}

    def test_cache_cleanup_requires_exact_successful_exception_receipt(self):
        cache.verify_deployment(self.manifest(), 'github-actions-123-1')

    def test_new_anomaly_or_changed_metadata_or_reused_baseline_prevents_cleanup(self):
        for mutate in [lambda x: x.update(previousCommit='f' * 40),
            lambda x: x['dataAuditAfter'].update(violationCount=11),
            lambda x: x['dataAuditAfter']['historicalException'].update(unavailableCheckCount=1),
            lambda x: x['dataAuditAfter']['historicalException'].update(metadataSha256='c' * 64),
            lambda x: x['dataAuditAfter']['historicalException'].update(policyId='other')]:
            manifest = self.manifest(); mutate(manifest)
            with self.assertRaisesRegex(RuntimeError, 'financial audit'):
                cache.verify_deployment(manifest, 'github-actions-123-1')

class HistoricalContinuationRetentionTests(unittest.TestCase):
    def manifest(self):
        policy = json.loads((DIRECTORY.parent.parent / 'deploy/aws/' /
            (cache.HISTORY_CONTINUATION_POLICY_ID + '.json')).read_text())
        gate = {'accepted': True, 'status': 'APPROVED_HISTORICAL_EXCEPTIONS',
            'policyId': policy['id'], 'expectedCurrent': policy['expectedCurrent'],
            'fixedCurrent': policy['expectedCurrent'], 'continuationOf': 'historical-finance-20261005',
            'checkCount': 48, 'executedCheckCount': 48, 'unavailableCheckCount': 0, 'violationCount': 10,
            'metadataSha256': policy['continuation']['metadataSha256'],
            'sources': {name: group['sha256'] for name, group in policy['sources'].items()},
            'continuation': policy['continuation']}
        return {'previousCommit': cache.HISTORY_CONTINUATION_BASELINE, 'deploymentRun': 'github-actions-123-1',
            **{'dataAudit' + stage.title(): {'checkCount': 48, 'violationCount': 10,
                'historicalException': {**gate, 'stage': stage}} for stage in ('before', 'after')}}

    def test_only_the_fixed_original_exception_provenance_allows_post_release_cleanup(self):
        cache.verify_deployment(self.manifest(), 'github-actions-123-1')

    def test_partial_execution_or_same_new_source_fingerprints_and_metadata_are_rejected(self):
        import copy
        mutations = [lambda x: x.update(previousCommit='f' * 40),
            lambda x: x['dataAuditBefore']['historicalException'].update(executedCheckCount=46),
            lambda x: x['dataAuditBefore']['historicalException'].update(unavailableCheckCount=2),
            lambda x: x['dataAuditBefore']['historicalException'].update(status='UNKNOWN'),
            lambda x: x['dataAuditAfter']['historicalException'].update(continuationOf='other'),
            lambda x: x['dataAuditAfter']['historicalException']['continuation'].update(manifestSha256='f' * 64)]
        for stage in ('before', 'after'):
            mutations.extend([
                lambda x, stage=stage: x['dataAudit' + stage.title()]['historicalException'].update(
                    sources={'accounts':'f' * 64}),
                lambda x, stage=stage: x['dataAudit' + stage.title()]['historicalException'].update(
                    metadataSha256='f' * 64)])
        for index, mutate in enumerate(mutations):
            manifest = copy.deepcopy(self.manifest()); mutate(manifest)
            with self.subTest(index=index), self.assertRaisesRegex(RuntimeError, 'financial audit'):
                cache.verify_deployment(manifest, 'github-actions-123-1')


class HistoricalDiagnosticsRetentionTests(unittest.TestCase):
    def manifest(self):
        import copy
        manifest = HistoricalContinuationRetentionTests().manifest()
        manifest['previousCommit'] = cache.HISTORY_DIAGNOSTICS_BASELINE
        for stage in ('before', 'after'):
            gate = manifest['dataAudit' + stage.title()]['historicalException']
            gate['policyId'] = cache.HISTORY_DIAGNOSTICS_POLICY_ID
            gate['expectedCurrent'] = gate['fixedCurrent'] = cache.HISTORY_DIAGNOSTICS_BASELINE
            gate['continuation'] = copy.deepcopy(gate['continuation'])
            gate['continuation']['fixedCurrent'] = cache.HISTORY_DIAGNOSTICS_BASELINE
            gate['continuation']['manifest']['commit'] = cache.HISTORY_DIAGNOSTICS_BASELINE
            gate['continuation']['manifest']['previousCommit'] = cache.HISTORY_CONTINUATION_BASELINE
        return manifest

    def verify(self, manifest):
        proof = self.manifest()['dataAuditAfter']['historicalException']['continuation']
        with patch.object(cache, 'DIAGNOSTICS_PROOF_SHA256', cache.plan_digest(proof)):
            cache.verify_deployment(manifest, 'github-actions-123-1')

    def test_third_entry_requires_the_exact_successful_fixed_proof(self):
        manifest = self.manifest()
        with self.assertRaisesRegex(RuntimeError, 'financial audit'):
            cache.verify_deployment(manifest, 'github-actions-123-1')
        self.verify(manifest)
        with self.assertRaisesRegex(RuntimeError, 'successful release'):
            cache.verify_deployment(manifest, 'github-actions-124-1')

    def test_claimed_new_entry_cannot_fall_through_zero_anomalies_or_other_policy(self):
        cases = [lambda x: x['dataAuditAfter'].update(violationCount=0),
            lambda x: x['dataAuditBefore']['historicalException'].update(policyId=cache.HISTORY_CONTINUATION_POLICY_ID),
            lambda x: x['dataAuditAfter']['historicalException'].update(policyId=cache.HISTORY_CONTINUATION_POLICY_ID),
            lambda x: x.update(previousCommit=cache.HISTORY_CONTINUATION_BASELINE),
            lambda x: x['dataAuditAfter']['historicalException'].update(accepted=False)]
        for index, mutate in enumerate(cases):
            manifest = self.manifest(); mutate(manifest)
            # Zero summary must not bypass a claimed third entry on either stage.
            manifest['dataAuditAfter']['violationCount'] = 0
            with self.subTest(index=index), self.assertRaisesRegex(RuntimeError, 'financial audit'):
                self.verify(manifest)

    def test_default_none_on_6a_with_all_checks_and_zero_anomalies_remains_valid(self):
        manifest = {'previousCommit': cache.HISTORY_DIAGNOSTICS_BASELINE,
            'deploymentRun': 'github-actions-123-1',
            'dataAuditBefore': {'checkCount': 48, 'violationCount': 0},
            'dataAuditAfter': {'checkCount': 48, 'violationCount': 0}}
        cache.verify_deployment(manifest, 'github-actions-123-1')

    def test_partial_rehashed_changed_or_wrong_stage_new_gate_prevents_cleanup(self):
        mutations = [lambda x: x.update(previousCommit='f' * 40),
            lambda x: x['dataAuditBefore'].update(checkCount=46),
            lambda x: x['dataAuditBefore']['historicalException'].update(executedCheckCount=46),
            lambda x: x['dataAuditBefore']['historicalException'].update(unavailableCheckCount=2),
            lambda x: x['dataAuditAfter']['historicalException'].update(stage='before'),
            lambda x: x['dataAuditAfter']['historicalException'].update(expectedCurrent=cache.HISTORY_CONTINUATION_BASELINE),
            lambda x: x['dataAuditAfter']['historicalException'].update(fixedCurrent=cache.HISTORY_CONTINUATION_BASELINE),
            lambda x: x['dataAuditAfter']['historicalException'].update(continuationOf='other'),
            lambda x: x['dataAuditAfter']['historicalException'].update(status='UNKNOWN'),
            lambda x: x['dataAuditAfter']['historicalException']['continuation'].update(manifestSha256='f' * 64)]
        for stage in ('before', 'after'):
            mutations.extend([
                lambda x, stage=stage: x['dataAudit' + stage.title()]['historicalException'].update(
                    sources={'accounts': 'f' * 64}),
                lambda x, stage=stage: x['dataAudit' + stage.title()]['historicalException'].update(
                    metadataSha256='f' * 64)])
        for index, mutate in enumerate(mutations):
            manifest = self.manifest(); mutate(manifest)
            with self.subTest(index=index), self.assertRaisesRegex(RuntimeError, 'financial audit'):
                self.verify(manifest)

    def test_default_zero_audit_and_both_old_fixed_entries_keep_their_existing_behavior(self):
        cache.verify_deployment({'deploymentRun': 'github-actions-123-1',
            'dataAuditAfter': {'violationCount': 0}}, 'github-actions-123-1')
        cache.verify_deployment(HistoricalReceiptRetentionTests().manifest(), 'github-actions-123-1')
        cache.verify_deployment(HistoricalContinuationRetentionTests().manifest(), 'github-actions-123-1')


class HistoricalMaintenanceRetentionTests(unittest.TestCase):
    def manifest(self):
        policy = json.loads((DIRECTORY.parent.parent /
            'deploy/aws/historical-finance-20261005-maintenance-continuation.json').read_text())
        gate = {
            'accepted': True, 'status': 'APPROVED_MAINTENANCE_SUBSET',
            'policyId': policy['id'], 'expectedCurrent': policy['expectedCurrent'],
            'fixedCurrent': policy['expectedCurrent'], 'checkCount': 48,
            'executedCheckCount': 48, 'unavailableCheckCount': 0, 'violationCount': 6,
            'databaseName': policy['databaseName'], 'policySha256': cache.plan_digest(policy),
            'rulesSha256': policy['rulesSha256'], 'schemaSha256': policy['schemaSha256'],
            'entitySetSha256': policy['candidateEntitySetSha256'],
            'closureItemsSha256': cache.plan_digest(sorted(policy['items'],
                key=lambda item: item['entitySha256'])),
            'receiptSetSha256': cache.plan_digest(policy['receiptSha256']),
            'sourceSha256': cache.plan_digest(policy['candidateSourceSha256'])
        }
        return {'deploymentRun': 'github-actions-123-1', 'previousCommit': policy['expectedCurrent'],
            **{'dataAudit' + stage.title(): {'checkCount': 48, 'violationCount': 6,
                'historicalException': {**gate, 'stage': stage}} for stage in ('before', 'after')}}

    def test_fourth_entry_matches_tracked_policy_and_both_complete_six_fact_receipts(self):
        manifest = self.manifest()
        self.assertEqual(manifest['dataAuditAfter']['historicalException']['policySha256'],
            '2103ab9a701fca15af406284874ef70d91004d6b2ac5cdd92fa91a8403399135')
        cache.verify_deployment(manifest, 'github-actions-123-1')
        with self.assertRaisesRegex(RuntimeError, 'successful release'):
            cache.verify_deployment(manifest, 'github-actions-124-1')

    def test_each_fixed_gate_field_missing_changed_or_extra_prevents_cleanup(self):
        import copy
        for stage in ('before', 'after'):
            name = 'dataAudit' + stage.title()
            for field, value in self.manifest()[name]['historicalException'].items():
                for missing in (True, False):
                    manifest = self.manifest()
                    gate = manifest[name]['historicalException']
                    if missing:
                        del gate[field]
                    else:
                        gate[field] = False if isinstance(value, bool) else (
                            value + 1 if isinstance(value, int) else 'changed')
                    # The other stage still claims this entry, even when policyId is removed.
                    with self.subTest(stage=stage, field=field, missing=missing), \
                            self.assertRaisesRegex(RuntimeError, 'financial audit'):
                        cache.verify_deployment(manifest, 'github-actions-123-1')
            manifest = copy.deepcopy(self.manifest())
            manifest[name]['historicalException']['rawRows'] = ['unexpected']
            with self.subTest(stage=stage, extra=True), self.assertRaisesRegex(RuntimeError, 'financial audit'):
                cache.verify_deployment(manifest, 'github-actions-123-1')

    def test_hashes_changed_identically_on_both_stages_are_not_self_approved(self):
        for field in ('policySha256', 'rulesSha256', 'schemaSha256', 'entitySetSha256',
                      'closureItemsSha256', 'receiptSetSha256', 'sourceSha256'):
            manifest = self.manifest()
            for stage in ('Before', 'After'):
                manifest['dataAudit' + stage]['historicalException'][field] = 'f' * 64
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'financial audit'):
                cache.verify_deployment(manifest, 'github-actions-123-1')

    def test_summary_counts_and_exact_primitive_types_are_required(self):
        for stage in ('Before', 'After'):
            for field, values in (('checkCount', (47, 49, 48.0, '48')),
                                  ('violationCount', (0, 5, 7, 10, 6.0, '6'))):
                for value in values:
                    manifest = self.manifest(); manifest['dataAudit' + stage][field] = value
                    with self.subTest(stage=stage, field=field, value=value), \
                            self.assertRaisesRegex(RuntimeError, 'financial audit'):
                        cache.verify_deployment(manifest, 'github-actions-123-1')
            for field, value in (('accepted', 1), ('checkCount', 48.0), ('violationCount', 6.0),
                                 ('unavailableCheckCount', False)):
                manifest = self.manifest()
                manifest['dataAudit' + stage]['historicalException'][field] = value
                with self.subTest(stage=stage, gateField=field), \
                        self.assertRaisesRegex(RuntimeError, 'financial audit'):
                    cache.verify_deployment(manifest, 'github-actions-123-1')

    def test_missing_stage_receipt_or_summary_is_rejected(self):
        for stage in ('Before', 'After'):
            for target in ('summary', 'gate'):
                manifest = self.manifest()
                if target == 'summary':
                    del manifest['dataAudit' + stage]
                else:
                    del manifest['dataAudit' + stage]['historicalException']
                with self.subTest(stage=stage, target=target), \
                        self.assertRaisesRegex(RuntimeError, 'financial audit'):
                    cache.verify_deployment(manifest, 'github-actions-123-1')

    def test_new_claim_cannot_fall_through_zero_or_a_different_old_entry(self):
        old_ids = ('historical-finance-20261005', cache.HISTORY_CONTINUATION_POLICY_ID,
                   cache.HISTORY_DIAGNOSTICS_POLICY_ID)
        for stage in ('Before', 'After'):
            for policy_id in old_ids:
                manifest = self.manifest()
                manifest['dataAudit' + stage]['historicalException']['policyId'] = policy_id
                manifest['dataAuditAfter']['violationCount'] = 0
                with self.subTest(stage=stage, policy=policy_id), \
                        self.assertRaisesRegex(RuntimeError, 'financial audit'):
                    cache.verify_deployment(manifest, 'github-actions-123-1')
        manifest = self.manifest(); manifest['previousCommit'] = 'f' * 40
        manifest['dataAuditAfter']['violationCount'] = 0
        with self.assertRaisesRegex(RuntimeError, 'financial audit'):
            cache.verify_deployment(manifest, 'github-actions-123-1')

    def test_normal_zero_and_all_three_old_entries_keep_their_behavior(self):
        cache.verify_deployment({'previousCommit': '6a82a774f2a65e00d4f260c629f7152bf7935d1d',
            'deploymentRun': 'github-actions-123-1', 'dataAuditBefore': {'checkCount': 48, 'violationCount': 0},
            'dataAuditAfter': {'checkCount': 48, 'violationCount': 0}}, 'github-actions-123-1')
        cache.verify_deployment(HistoricalReceiptRetentionTests().manifest(), 'github-actions-123-1')
        cache.verify_deployment(HistoricalContinuationRetentionTests().manifest(), 'github-actions-123-1')
        diagnostics = HistoricalDiagnosticsRetentionTests()
        diagnostics.verify(diagnostics.manifest())

    def test_invalid_new_receipt_stops_automatic_cleanup_before_plan_file_or_delete(self):
        retention = RetentionTests(); retention.setUp()
        manifest = self.manifest(); manifest['dataAuditAfter']['historicalException']['sourceSha256'] = 'f' * 64
        args = SimpleNamespace(expected_current=retention.expected, apply=True,
            approved_policy=cache.POLICY, deployment_run='github-actions-123-1')
        with tempfile.TemporaryDirectory() as root, \
                patch.object(cache, 'BASE', Path(root)), \
                patch.object(cache, 'current', return_value=(manifest, retention.previous)), \
                patch.object(cache, 'collect_dependencies', return_value=retention.dependencies), \
                patch.object(cache, 'active_images', return_value=set()), \
                patch.object(cache, 'read', return_value=''), \
                patch.object(cache, 'make_plan', return_value=retention.plan), \
                patch.object(cache, 'apply_plan') as apply, \
                patch.object(cache, 'verify_remote') as remote, \
                patch.object(cache.shutil, 'disk_usage', return_value=SimpleNamespace(free=100)):
            with self.assertRaisesRegex(RuntimeError, 'financial audit'):
                cache.maintain(args)
            apply.assert_not_called(); remote.assert_not_called()
            self.assertFalse((Path(root) / 'maintenance').exists())

    def test_valid_new_receipt_allows_existing_automatic_plan_and_cleanup_flow(self):
        retention = RetentionTests(); retention.setUp()
        retention.manifest = self.manifest()
        result, calls = retention.invoke(['--apply', '--approved-policy', cache.POLICY,
            '--deployment-run', 'github-actions-123-1'])
        self.assertEqual(result['mode'], 'APPLIED')
        self.assertEqual(calls, 1)


class MailboxRetentionGateTests(unittest.TestCase):
    def manifest(self):
        return {'deploymentRun': 'github-actions-123-1', 'previousCommit': cache.MAILBOX_BASELINE,
            'dataAuditBefore': {'checkCount': 48, 'violationCount': 6,
                'historicalException': {**cache.MAILBOX_EXPECTED_GATE, 'stage': 'before'}},
            'dataAuditAfter': {'checkCount': 48, 'violationCount': 6,
                'historicalException': {**cache.MAILBOX_EXPECTED_GATE, 'stage': 'after'}}}

    def test_fixed_mailbox_receipts_admit_retention_only_after_verified_deployment(self):
        cache.verify_deployment(self.manifest(), 'github-actions-123-1')
        for key in ['policySha256', 'snapshotSha256', 'imageCommit', 'imageRun', 'stage']:
            value = self.manifest(); value['dataAuditAfter']['historicalException'][key] = 'changed'
            with self.assertRaisesRegex(RuntimeError, 'mailbox financial audit'):
                cache.verify_deployment(value, 'github-actions-123-1')
        value = self.manifest(); value['previousCommit'] = 'a' * 40
        with self.assertRaises(RuntimeError):
            cache.verify_deployment(value, 'github-actions-123-1')
        value = self.manifest(); value['dataAuditBefore']['historicalException']['executedCheckCount'] = 47
        with self.assertRaises(RuntimeError):
            cache.verify_deployment(value, 'github-actions-123-1')


class DependencyRetentionTests(unittest.TestCase):
    def setUp(self):
        runtime = DIRECTORY.parent.parent / '.runtime/cache-retention-tests'
        runtime.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=runtime)
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.base_patch = patch.object(cache, 'BASE', self.base)
        self.base_patch.start(); self.addCleanup(self.base_patch.stop)
        self.ids = ['sha256:' + str(number) * 64 for number in range(1, 8)]
        self.paths = []
        self.rows = []
        # Registration changes in the latest release while recharge has stayed
        # unchanged across it. Its usable rollback is in the third release.
        for index, commit in enumerate(('a' * 40, 'b' * 40, 'c' * 40, 'd' * 40)):
            path = self.base / ('releases/20261007T00000' + str(index) + 'Z-' + commit[:12])
            path.mkdir(parents=True)
            row = {'commit': commit, 'sourceTree': 'f' * 40, 'images': {
                'auto-registration': {'digest': self.ids[0 if index == 0 else 1]},
                'auto-recharge': {'digest': self.ids[2 if index < 2 else 3]}}}
            if index == 3:
                row['images'] = {'auto-registration': {'digest': self.ids[4]},
                    'auto-recharge': {'digest': self.ids[5]}}
            self.paths.append(path); self.rows.append(row)
        for index, row in enumerate(self.rows):
            if index + 1 < len(self.rows):
                row.update(previousCommit=self.rows[index + 1]['commit'], previousRelease=str(self.paths[index + 1]))
            self.write(self.paths[index] / 'release-manifest.json', row)
        (self.base / 'current').symlink_to(self.paths[0])
        self.commands = []

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))

    def command(self, *args):
        self.commands.append(args)
        self.assertEqual(args[:5], ('docker', 'image', 'inspect', '--format', '{{.Id}}'))
        return args[-1]

    def collect(self):
        with patch.object(cache, 'read', side_effect=self.command):
            return cache.collect_dependencies(self.rows[0], self.rows[1])

    def test_fixed93_retains_original_sealed_finance_images_and_pro_rollback(self):
        self.fixed('registration-worker-93-20261007')
        result = self.collect()
        self.assertTrue(set(self.ids[4:7]) <= set(result['imageIds']))
        self.assertIn('registration-worker-93-20261007', cache.FIXED_REGISTRATION_IDS)

    def test_fixed94_retains_original_sealed_finance_images_and_pro_rollback(self):
        self.fixed('registration-worker-94-20261007')
        result = self.collect()
        self.assertTrue(set(self.ids[4:7]) <= set(result['imageIds']))
        self.assertIn('registration-worker-94-20261007', cache.FIXED_REGISTRATION_IDS)

    def test_fixed95_retains_original_sealed_finance_images_and_pro_rollback(self):
        self.fixed('registration-worker-95-20261008')
        result = self.collect()
        self.assertTrue(set(self.ids[4:7]) <= set(result['imageIds']))
        self.assertIn('registration-worker-95-20261008', cache.FIXED_REGISTRATION_IDS)

    def test_fixed96_retains_sealed_finance_pro_and_per_service_rollback_images(self):
        import hashlib
        profile, _, _ = self.fixed('registration-worker-96-20261008')
        result = self.collect()
        self.assertEqual(set(result['imageIds']), {self.ids[1], self.ids[3], self.pro_image, *self.ids[4:]})
        self.assertEqual(result['evidenceSha256'][str(profile.relative_to(self.base))],
            hashlib.sha256(profile.read_bytes()).hexdigest())
        self.assertEqual(result['serviceRollback']['auto-registration']['commit'], self.rows[1]['commit'])
        self.assertEqual(result['serviceRollback']['auto-recharge']['commit'], self.rows[2]['commit'])
        active = 'sha256:' + '9' * 64
        protected = cache.protected_images(self.rows[0], self.rows[1], {active}, result)
        inventory = [{'id': image, 'repoTags': [cache.REPOSITORY + ':' + 'e' * 40
            + '-' + str(index + 1) + '-1-auto-recharge']}
            for index, image in enumerate(sorted(protected))]
        self.assertEqual(cache.make_plan(self.rows[0]['commit'], self.rows[1], protected,
            inventory, result)['items'], [])
        self.assertTrue(all(command[:5] == ('docker', 'image', 'inspect', '--format', '{{.Id}}')
            for command in self.commands))

    def test_fixed96_changed_profile_seal_pro_or_unknown97_blocks_before_docker(self):
        for location, reason in (('profile', 'profile changed'), ('seal', 'seal changed'),
                ('pro', 'Pro image dependency changed'), ('id', 'Unknown fixed release dependency')):
            with self.subTest(location=location):
                profile, seal, _ = self.fixed('registration-worker-96-20261008')
                if location == 'profile':
                    profile.write_text(profile.read_text() + '\n')
                elif location == 'seal':
                    self.write(seal, {'images': {}})
                elif location == 'pro':
                    changed = json.loads(json.dumps(self.rows[3]))
                    changed['images']['auto-recharge']['digest'] = 'sha256:' + '9' * 64
                    self.write(self.paths[3] / 'release-manifest.json', changed)
                else:
                    self.rows[0]['fixedRegistrationRelease']['id'] = 'registration-worker-97-20261008'
                    self.write(self.paths[0] / 'release-manifest.json', self.rows[0])
                with self.assertRaisesRegex(RuntimeError, reason):
                    self.collect()
                self.assertEqual(self.commands, [])

    def test_fixed96_skipped_cache_still_requires_manual_exact_plan(self):
        retention = RetentionTests(); retention.setUp()
        retention.manifest['fixedRegistrationRelease'] = {
            'id': 'registration-worker-96-20261008', 'cacheStatus': 'SKIPPED'}
        retention.manifest['dataAuditAfter'] = {'checkCount': 49, 'violationCount': 0}
        with patch.object(cache, 'verify_deployment') as audit:
            with self.assertRaisesRegex(RuntimeError, 'separately approved exact plan'):
                retention.invoke(['--apply', '--approved-policy', cache.POLICY,
                    '--deployment-run', 'github-actions-123-1'])
            audit.assert_not_called()
        result, calls = retention.invoke(['--apply', '--approved-policy', cache.POLICY,
            '--approved-plan-sha256', cache.plan_digest(retention.plan)])
        self.assertEqual((result['mode'], calls), ('APPLIED', 1))

    def fixed(self, profile_id='registration-worker-91-20261007'):
        import hashlib
        seal = {'images': {'admin': self.ids[4], 'api': self.ids[5], 'migrate': self.ids[6]}}
        seal_path = self.base / cache.ORDER_ARCHIVE_SEAL_RELATIVE
        self.write(seal_path, seal)
        digest = hashlib.sha256(seal_path.read_bytes()).hexdigest()
        finance = {'kind': 'EXISTING_SEALED_ORDER_ARCHIVE_49', 'releaseSealSha256': digest}
        profile = {'id': profile_id, 'financeValidator': finance}
        path = self.paths[0] / ('deploy/aws/' + profile['id'] + '.json')
        self.write(path, profile)
        self.rows[0]['fixedRegistrationRelease'] = {'id': profile['id'],
            'profileRawSha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'cacheStatus': 'SKIPPED'}
        self.write(self.paths[0] / 'release-manifest.json', self.rows[0])
        self.pro_image = 'sha256:' + '8' * 64
        self.rows[3]['images']['auto-recharge'] = {'digest': self.pro_image}
        self.write(self.paths[3] / 'release-manifest.json', self.rows[3])
        pro = {'status': 'VERIFIED_PRO_AFTER_88_RUNTIME_BASELINE', 'current': str(self.paths[3]),
            'manifest': self.rows[3]}
        producer = self.paths[0] / 'scripts/production-release/remote-deploy.py'
        producer.parent.mkdir(parents=True, exist_ok=True)
        producer.write_text('REGISTRATION_FINANCE = ' + repr(finance) + '\n'
            + 'REGISTRATION_EMAIL_OBSERVATION_PRO_BASELINE = ' + repr(pro) + '\n'
            + 'raise AssertionError("must never execute producer")\n')
        return path, seal_path, producer

    def test_each_service_keeps_its_last_different_version_without_all_history_images(self):
        result = self.collect()
        self.assertEqual(result['imageIds'], [self.ids[1], self.ids[3]])
        self.assertEqual(result['serviceRollback']['auto-recharge']['commit'], self.rows[2]['commit'])
        self.assertEqual(result['serviceRollback']['auto-registration']['commit'], self.rows[1]['commit'])
        self.assertEqual(set(command[-1] for command in self.commands), {self.ids[1], self.ids[3]})

    def test_missing_chain_file_cycle_and_wrong_predecessor_fail_closed(self):
        original = dict(self.rows[1])
        cases = ({**original, 'previousCommit': 'e' * 40},
            {**original, 'previousCommit': self.rows[0]['commit'], 'previousRelease': str(self.paths[0])},
            {**original, 'previousRelease': str(self.base / 'releases/missing')},
            {**original, 'previousRelease': None})
        for row in cases:
            self.write(self.paths[1] / 'release-manifest.json', row)
            with self.assertRaises((RuntimeError, FileNotFoundError)):
                with patch.object(cache, 'read', side_effect=self.command):
                    cache.collect_dependencies(self.rows[0], row)

    def test_fixed_seal_and_pro_dependencies_are_collected_without_executing_old_producer(self):
        self.fixed()
        result = self.collect()
        self.assertEqual(set(result['imageIds']), {self.ids[1], self.ids[3], self.pro_image, *self.ids[4:]})
        self.assertIn(cache.ORDER_ARCHIVE_SEAL_RELATIVE, result['evidenceSha256'])
        self.assertIn(str((self.paths[0] / 'scripts/production-release/remote-deploy.py').relative_to(self.base)),
            result['evidenceSha256'])

    def test_released_92_profile_preserves_same_sealed_finance_and_pro_dependencies(self):
        self.fixed('registration-worker-92-20261007')
        result = self.collect()
        self.assertEqual(set(result['imageIds']), {self.ids[1], self.ids[3], self.pro_image, *self.ids[4:]})

    def recharge(self, profile_id='recharge-pro-2f-20261007'):
        path, seal, producer = self.fixed(profile_id)
        claim = self.rows[0].pop('fixedRegistrationRelease')
        profile = json.loads(path.read_text())
        self.rows[0]['fixedRechargeRelease'] = {'id': profile_id,
            'profileSha256': cache.plan_digest(profile), 'cacheStatus': claim['cacheStatus']}
        self.write(self.paths[0] / 'release-manifest.json', self.rows[0])
        return path, seal, producer

    def test_released_2f_recharge_keeps_exact_finance_pro_and_service_rollback_dependencies(self):
        profile, _, _ = self.recharge()
        result = self.collect()
        self.assertEqual(set(result['imageIds']), {self.ids[1], self.ids[3], self.pro_image, *self.ids[4:]})
        self.assertIn(str(profile.relative_to(self.base)), result['evidenceSha256'])
        self.assertEqual(result['serviceRollback']['auto-registration']['commit'], self.rows[1]['commit'])
        self.assertEqual(result['serviceRollback']['auto-recharge']['commit'], self.rows[2]['commit'])
        self.assertTrue(all(command[:5] == ('docker', 'image', 'inspect', '--format', '{{.Id}}')
            for command in self.commands))

    def test_d3fb_successor_retains_original_finance_bridge_and_service_rollback_images(self):
        profile, _, _ = self.recharge('recharge-pro-4c-20261008')
        result = self.collect()
        expected = {self.ids[1], self.ids[3], self.pro_image, *self.ids[4:]}
        self.assertEqual(set(result['imageIds']), expected)
        self.assertIn(str(profile.relative_to(self.base)), result['evidenceSha256'])
        self.assertEqual(result['serviceRollback']['auto-registration']['commit'], self.rows[1]['commit'])
        self.assertEqual(result['serviceRollback']['auto-recharge']['commit'], self.rows[2]['commit'])
        protected = cache.protected_images(self.rows[0], self.rows[1], set(), result)
        inventory = [{'id': image, 'repoTags': [cache.REPOSITORY + ':' + 'e' * 40
            + '-' + str(index + 1) + '-1-auto-recharge']}
            for index, image in enumerate(sorted(expected))]
        self.assertEqual(cache.make_plan(self.rows[0]['commit'], self.rows[1], protected,
            inventory, result)['items'], [])
        self.assertTrue(all(command[:5] == ('docker', 'image', 'inspect', '--format', '{{.Id}}')
            for command in self.commands))

    def test_d3fb_profile_seal_bridge_or_unknown_id_blocks_before_docker(self):
        for location in ('profile', 'seal', 'bridge', 'id'):
            with self.subTest(location=location):
                profile, seal, _ = self.recharge('recharge-pro-4c-20261008')
                if location == 'profile':
                    value = json.loads(profile.read_text())
                    value['financeValidator']['releaseSealSha256'] = 'f' * 64
                    self.write(profile, value)
                elif location == 'seal':
                    self.write(seal, {'images': {}})
                elif location == 'bridge':
                    changed = json.loads(json.dumps(self.rows[3]))
                    changed['images']['auto-recharge']['digest'] = 'sha256:' + '9' * 64
                    self.write(self.paths[3] / 'release-manifest.json', changed)
                else:
                    self.rows[0]['fixedRechargeRelease']['id'] = 'recharge-pro-d3fb-unreviewed'
                    self.write(self.paths[0] / 'release-manifest.json', self.rows[0])
                with self.assertRaises(RuntimeError):
                    self.collect()
                self.assertEqual(self.commands, [])

    def test_d3fb_skipped_cache_rejects_automatic_maintenance_despite_zero_finance_violations(self):
        retention = RetentionTests(); retention.setUp()
        retention.manifest['fixedRechargeRelease'] = {
            'id': 'recharge-pro-4c-20261008', 'cacheStatus': 'SKIPPED'}
        retention.manifest['dataAuditAfter'] = {'checkCount': 49, 'violationCount': 0}
        with patch.object(cache, 'verify_deployment') as audit:
            with self.assertRaisesRegex(RuntimeError, 'separately approved exact plan'):
                retention.invoke(['--apply', '--approved-policy', cache.POLICY,
                    '--deployment-run', 'github-actions-123-1'])
            audit.assert_not_called()

    def test_6f5_successor_retains_original_finance_bridge_and_service_rollback_images(self):
        profile, _, _ = self.recharge('recharge-pro-6f5-20261008')
        result = self.collect()
        expected = {self.ids[1], self.ids[3], self.pro_image, *self.ids[4:]}
        self.assertEqual(set(result['imageIds']), expected)
        self.assertIn(str(profile.relative_to(self.base)), result['evidenceSha256'])
        self.assertEqual(result['serviceRollback']['auto-registration']['commit'], self.rows[1]['commit'])
        self.assertEqual(result['serviceRollback']['auto-recharge']['commit'], self.rows[2]['commit'])
        protected = cache.protected_images(self.rows[0], self.rows[1], set(), result)
        inventory = [{'id': image, 'repoTags': [cache.REPOSITORY + ':' + 'e' * 40
            + '-' + str(index + 1) + '-1-auto-recharge']}
            for index, image in enumerate(sorted(expected))]
        self.assertEqual(cache.make_plan(self.rows[0]['commit'], self.rows[1], protected,
            inventory, result)['items'], [])
        self.assertTrue(all(command[:5] == ('docker', 'image', 'inspect', '--format', '{{.Id}}')
            for command in self.commands))

    def test_6f5_profile_seal_bridge_or_unknown_id_blocks_before_docker(self):
        for location in ('profile', 'seal', 'bridge', 'id'):
            with self.subTest(location=location):
                profile, seal, _ = self.recharge('recharge-pro-6f5-20261008')
                if location == 'profile':
                    value = json.loads(profile.read_text())
                    value['financeValidator']['releaseSealSha256'] = 'f' * 64
                    self.write(profile, value)
                elif location == 'seal':
                    self.write(seal, {'images': {}})
                elif location == 'bridge':
                    changed = json.loads(json.dumps(self.rows[3]))
                    changed['images']['auto-recharge']['digest'] = 'sha256:' + '9' * 64
                    self.write(self.paths[3] / 'release-manifest.json', changed)
                else:
                    self.rows[0]['fixedRechargeRelease']['id'] = 'recharge-pro-6f5-unreviewed'
                    self.write(self.paths[0] / 'release-manifest.json', self.rows[0])
                with self.assertRaises(RuntimeError):
                    self.collect()
                self.assertEqual(self.commands, [])

    def test_6f5_skipped_cache_rejects_automatic_maintenance_despite_zero_finance_violations(self):
        retention = RetentionTests(); retention.setUp()
        retention.manifest['fixedRechargeRelease'] = {
            'id': 'recharge-pro-6f5-20261008', 'cacheStatus': 'SKIPPED'}
        retention.manifest['dataAuditAfter'] = {'checkCount': 49, 'violationCount': 0}
        with patch.object(cache, 'verify_deployment') as audit:
            with self.assertRaisesRegex(RuntimeError, 'separately approved exact plan'):
                retention.invoke(['--apply', '--approved-policy', cache.POLICY,
                    '--deployment-run', 'github-actions-123-1'])
            audit.assert_not_called()

    def test_pricing_045_skipped_cache_rejects_automatic_maintenance_before_docker_or_finance_reads(self):
        retention = RetentionTests(); retention.setUp()
        retention.manifest['fixedRechargeRelease'] = {
            'id': 'recharge-pro-pricing-045-20261008', 'cacheStatus': 'SKIPPED'}
        retention.manifest['dataAuditAfter'] = {'checkCount': 49, 'violationCount': 0}
        with patch.object(cache, 'verify_deployment') as audit, patch.object(cache.subprocess, 'run') as command:
            with self.assertRaisesRegex(RuntimeError, 'separately approved exact plan'):
                retention.invoke(['--apply', '--approved-policy', cache.POLICY,
                    '--deployment-run', 'github-actions-123-1'])
            audit.assert_not_called();command.assert_not_called()

    def test_2f_recharge_changed_profile_seal_or_unknown_id_blocks_before_docker(self):
        for location in ('profile', 'seal', 'id'):
            with self.subTest(location=location):
                profile, seal, _ = self.recharge()
                if location == 'profile':
                    value = json.loads(profile.read_text()); value['financeValidator']['releaseSealSha256'] = 'f' * 64
                    self.write(profile, value)
                elif location == 'seal':
                    self.write(seal, {'images': {}})
                else:
                    self.rows[0]['fixedRechargeRelease']['id'] = 'recharge-pro-unreviewed'
                    self.write(self.paths[0] / 'release-manifest.json', self.rows[0])
                with self.assertRaises(RuntimeError): self.collect()
        self.assertEqual(self.commands, [])

    def test_unknown_fixed_profile_finance_or_dynamic_declaration_stops_before_docker(self):
        profile_path, _, producer = self.fixed()
        import hashlib
        self.rows[0]['fixedRegistrationRelease']['id'] = 'registration-worker-unreviewed'
        self.write(self.paths[0] / 'release-manifest.json', self.rows[0])
        with self.assertRaisesRegex(RuntimeError, 'Unknown fixed release dependency'):
            self.collect()
        self.fixed()
        for finance in ({'kind': 'UNREVIEWED'}, {'kind': 'EXISTING_SEALED_ORDER_ARCHIVE_49', 'releaseSealSha256': 'f' * 64}):
            profile = json.loads(profile_path.read_text()); profile['financeValidator'] = finance
            self.write(profile_path, profile)
            self.rows[0]['fixedRegistrationRelease']['profileRawSha256'] = hashlib.sha256(profile_path.read_bytes()).hexdigest()
            self.write(self.paths[0] / 'release-manifest.json', self.rows[0])
            with self.assertRaises(RuntimeError): self.collect()
        self.fixed()
        producer.write_text('REGISTRATION_FINANCE = dangerous()\n')
        with self.assertRaisesRegex(RuntimeError, 'Unknown fixed dependency'):
            self.collect()
        self.assertEqual(self.commands, [])

    def test_tampered_seal_and_symlinked_producer_do_not_produce_a_plan(self):
        _, seal, producer = self.fixed()
        seal.write_text('{}')
        with self.assertRaisesRegex(RuntimeError, 'seal changed'): self.collect()
        self.fixed()
        actual = producer.with_suffix('.saved'); producer.rename(actual); producer.symlink_to(actual)
        with self.assertRaisesRegex(RuntimeError, 'regular project file'): self.collect()

    def test_unavailable_required_rollback_image_is_not_called_usable(self):
        with patch.object(cache, 'read', return_value='other-image'):
            with self.assertRaisesRegex(RuntimeError, 'unavailable'):
                cache.collect_dependencies(self.rows[0], self.rows[1])

    def test_dependency_change_blocks_delete_even_when_container_set_is_unchanged(self):
        retention = RetentionTests(); retention.setUp()
        with patch.object(cache, 'verify_remote'), \
                patch.object(cache, 'current', return_value=(retention.manifest, retention.previous)), \
                patch.object(cache, 'collect_dependencies', return_value={**retention.dependencies, 'imageIds': [retention.ids[0]]}), \
                patch.object(cache, 'read') as command:
            with self.assertRaisesRegex(RuntimeError, 'dependencies changed'):
                cache.apply_plan(retention.plan)
            command.assert_not_called()

    def test_fixed_skipped_cache_requires_manual_exact_plan_instead_of_weakening_finance_gate(self):
        retention = RetentionTests(); retention.setUp()
        retention.manifest['fixedRechargeRelease'] = {'cacheStatus': 'SKIPPED'}
        with self.assertRaisesRegex(RuntimeError, 'separately approved exact plan'):
            retention.invoke(['--apply', '--approved-policy', cache.POLICY, '--deployment-run', 'github-actions-123-1'])
        result, calls = retention.invoke(['--apply', '--approved-policy', cache.POLICY,
            '--approved-plan-sha256', cache.plan_digest(retention.plan)])
        self.assertEqual((result['mode'], calls), ('APPLIED', 1))


class FixedBootstrapCacheTests(unittest.TestCase):
    """All host, ECR and mutation calls are synthetic; files stay in project runtime."""
    @classmethod
    def setUpClass(cls):
        cls.project = DIRECTORY.parents[1]
        cls.output = cls.project / '.runtime/cache-recovery-0a-20261011/fixtures'
        cls.output.mkdir(parents=True, exist_ok=True)
        storage_spec = importlib.util.spec_from_file_location('cache_test_storage', DIRECTORY / 'storage-maintenance.py')
        cls.storage = importlib.util.module_from_spec(storage_spec); storage_spec.loader.exec_module(cls.storage)
        for name in ('StorageGuard','StorageRejected','storage_identity'):
            setattr(cache,name,getattr(cls.storage,name))
        cls.producer = {'commit':'c'*40,'sourceTree':'d'*40,'workflowRunId':'123','workflowRunAttempt':'1'}
        cls.old = 'a'*40
        cls.candidate = 'sha256:'+'a'*64
        cls.kept = 'sha256:'+'b'*64

    @classmethod
    def binding(cls, operation='verify_unused_cache', approval=None, producer=None):
        return {'producer':producer or cls.producer.copy(),'expectedCurrent':cache.CACHE_BASELINE,
            'operation':operation,'approvedPlanSha256':approval,
            'sourcePins':{p:{'bytes':10,'sha256':'e'*64} for p in cache.CACHE_PINS},
            'provenOldSourceCommits':[cls.old],'capturedProgramBytes':10,'capturedProgramSha256':'f'*64}

    @classmethod
    def inventory(cls, count=1):
        return [{'id':'sha256:'+str(n+1)*64,'repoTags':[cache.REPOSITORY+':'+cls.old+'-1-1-api'],
            'sourceCommit':cls.old,'sizeBytesEstimate':1000} for n in range(count)]

    @classmethod
    def safe_plan(cls, binding=None):
        binding=binding or cls.binding(); inventory=cls.inventory(); candidate=inventory[0]['id']
        deps={'version':1,'imageIds':[cls.kept],'serviceRollback':{'migrate':{
            'status':'RETAINED','commit':'b'*40,'imageId':cls.kept}},'evidenceSha256':{}}
        holder={'recovery':{}}
        def recover(plan):
            holder['recovery']={i['tag']:{'remoteImageId':i['imageId'],'remoteManifestDigest':'sha256:'+'9'*64,
                'remoteManifestSha256':'9'*64,'recoveryVerified':True} for i in plan['items']}
        with patch.object(cache,'verify_remote',side_effect=recover):
            plan=cache.cache_plan(binding,{'images':{'api':{'digest':cls.kept}}},
                {'commit':cache.CACHE_PREVIOUS,'images':{}},deps,{cls.kept},inventory,holder)
        value={'kind':'CACHE_RECOVERY_RESULT_V1','version':1,'operation':'verify_unused_cache','mode':'PLAN_ONLY',
            'producer':binding['producer'],'sourceBinding':binding,'status':'PLANNED','code':'OK','phase':'COMPLETE',
            'baseline':{'currentCommit':cache.CACHE_BASELINE,'currentManifestSha256':cache.CACHE_CURRENT_SHA,
                'previousCommit':cache.CACHE_PREVIOUS,'previousManifestSha256':cache.CACHE_PREVIOUS_SHA},
            'plan':plan,'planSha256':cache.plan_digest(plan),'candidateCount':1,'candidateSizeBytesEstimateSum':1000,
            'exclusiveBytesReclaimable':None,'freeBytesBefore':100,'freeBytesAfter':100,
            'guards':{**dict.fromkeys(('currentUnchanged','servicesUnchanged','dependenciesUnchanged',
                'containerImagesUnchanged','inventoryVerified','clientCleanupVerified','remoteRecoveryVerified'),True),
                'servicesBeforeSha256':cache.CACHE_SERVICES_SHA,'servicesAfterSha256':cache.CACHE_SERVICES_SHA},
            'mutationAttempted':False,'itemReceipts':[],'receiptSha256':None,'removedCount':0,
            'authority':False,'productionEligible':False,'cleanupEligible':False,'rawOutputSuppressed':True}
        return cache.validate_result(value,binding)

    def run_host(self, binding, *, count=1, fail_remove=None, change_after_remove=False,
                 wrong_services=False, wrong_baseline=False, dependencies_failure=False, inventory_drift=False,
                 dangling=False, recovery_failure=False, root_override=None, inventory_failure=None):
        import copy
        import os
        import stat
        directory=tempfile.TemporaryDirectory(dir=self.output) if root_override is None else None; root=Path(directory.name) if directory else Path(root_override)
        (root/'.staging').mkdir(exist_ok=True);(root/'maintenance/docker-cache-retention').mkdir(parents=True,exist_ok=True)
        if not (root/'.deploy.lock').exists():(root/'.deploy.lock').write_bytes(b'');(root/'.deploy.lock').chmod(0o600)
        inventory=copy.deepcopy(self.inventory(count)); removals=[]; commands=[]; snapshots=[]
        state={'inventory':inventory,'inspectCount':0}
        manifest={'commit':cache.CACHE_BASELINE,'previousCommit':cache.CACHE_PREVIOUS,
            'images':{'api':{'digest':self.kept}}}
        previous={'commit':cache.CACHE_PREVIOUS,'images':{}}
        deps={'version':1,'imageIds':[self.kept],'serviceRollback':{},'evidenceSha256':{}}
        class Guard:
            def __init__(unused,deadline): unused.fds=[];unused.nodes=[]; unused.current=root/'releases/20261008T000000Z-0a03fa28e6b8'; unused.manifests=[manifest,previous]; unused.previous_sha=cache.CACHE_PREVIOUS_SHA
            def open(unused): unused.base=os.open(root,os.O_RDONLY|os.O_DIRECTORY);unused.fds.append(unused.base)
            def verify(unused):
                if wrong_baseline: raise cache.StorageRejected('BASELINE_INVALID')
            def remaining(unused): pass
            def child(unused,parent,name):
                fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent);unused.fds.append(fd);return fd
            def close(unused):
                for fd in reversed(unused.fds): os.close(fd)
        class Driver:
            def native(unused,*args,timeout=30):
                commands.append(args)
                if args==('ps','-a','-q'): return '7'*64
                if args[:3]==('inspect','--format','{{.Image}}'): return self.kept
                if args==('image','ls','--no-trunc','--quiet'):
                    if inventory_failure=='LIST': raise RuntimeError('private-inventory-error')
                    return '\n'.join(r['id'] for r in state['inventory'])
                if args[:3]==('image','inspect','--format'):
                    if inventory_failure=='INSPECT': raise RuntimeError('private-inventory-error')
                    row=next(r for r in state['inventory'] if r['id']==args[-1]);state['inspectCount']+=1
                    if inventory_drift and state['inspectCount']>count: row['sizeBytesEstimate']+=1
                    return cache.cache_canonical(row).decode()
                if args[:3]==('image','rm','--no-prune'):
                    removals.append(args[-1])
                    if fail_remove==len(removals): raise OSError('secret-error-must-not-escape')
                    row=next(r for r in state['inventory'] if args[-1] in r['repoTags']);row['repoTags'].remove(args[-1])
                    if not row['repoTags'] and not dangling:state['inventory'].remove(row)
                    return 'raw-docker-secret-must-not-escape'
                raise AssertionError(args)
            def snapshot(unused,current):
                snapshots.append(current)
                return '0'*64 if wrong_services or change_after_remove and removals else cache.CACHE_SERVICES_SHA
        def ecr(args,**kwargs):
            self.assertEqual(kwargs['stderr'],cache.subprocess.DEVNULL);self.assertLessEqual(kwargs['timeout'],30)
            self.assertEqual(args[:3],['aws','ecr','batch-get-image'])
            rows=[]
            for text in args[8:-2]:
                tag=text[9:]; image=next(r for r in inventory if cache.REPOSITORY+':'+tag in r['repoTags'])
                raw=cache.cache_canonical({'config':{'digest':image['id']}}).decode()
                rows.append({'imageId':{'imageTag':tag,'imageDigest':'sha256:'+cache.cache_sha(raw.encode())},'imageManifest':raw})
            return SimpleNamespace(returncode=0,stdout=cache.cache_canonical({'images':rows,'failures':['REJECT'] if recovery_failure else []}))
        original_fstat,original_stat=os.fstat,os.stat
        class Owned:
            def __init__(unused,info):unused.info=info
            def __getattr__(unused,name):return 0 if name=='st_uid' else getattr(unused.info,name)
        with contextlib.ExitStack() as stack:
            for name,value in (('BASE',root),('StorageGuard',Guard)):
                stack.enter_context(patch.object(cache,name,value))
            stack.enter_context(patch.object(cache.os,'getuid',return_value=0));stack.enter_context(patch.object(cache.os,'geteuid',return_value=0))
            stack.enter_context(patch.object(cache.os,'fstat',side_effect=lambda fd:Owned(original_fstat(fd))))
            stack.enter_context(patch.object(cache.os,'stat',side_effect=lambda *a,**kw:Owned(original_stat(*a,**kw))))
            stack.enter_context(patch.object(cache,'current',return_value=(manifest,previous)))
            stack.enter_context(patch.object(cache,'collect_dependencies',side_effect=RuntimeError('raw-private-path') if dependencies_failure else lambda *unused:deps))
            stack.enter_context(patch.object(cache.subprocess,'run',side_effect=ecr))
            value=cache.cache_execute(binding,lambda *unused:Driver())
            cache.validate_result(value,binding)
        receipts=list((root/'maintenance/docker-cache-retention').glob('*.json')) if (root/'maintenance/docker-cache-retention').exists() else []
        saved=[p.read_bytes() for p in receipts]
        if directory:directory.cleanup()
        return value,removals,commands,saved

    def test_plan_protects_current_previous_all_containers_dependencies_and_pending(self):
        binding=self.binding();rows=self.inventory()
        protected={rows[0]['id']}
        self.assertEqual(cache.cache_filter_inventory(binding,rows,protected)[0],[])
        for commit in (cache.CACHE_BASELINE,cache.CACHE_PREVIOUS,self.producer['commit'],'0'*40,None):
            with self.subTest(commit=commit):
                row={**rows[0],'sourceCommit':commit}
                self.assertEqual(cache.cache_filter_inventory(binding,[row],set())[0],[])
        self.assertIn(self.kept,self.safe_plan()['plan']['protectedImageIds'])

    def test_unknown_alias_foreign_repo_new_service_wrong_source_never_candidate(self):
        row=self.inventory()[0]
        for tag in ('other:tag',cache.REPOSITORY+':'+self.old+'-1-1-auto-registration',cache.REPOSITORY+':'+('b'*40)+'-1-1-api'):
            with self.subTest(tag=tag):
                value={**row,'repoTags':row['repoTags']+[tag]}
                self.assertEqual(cache.cache_filter_inventory(self.binding(),[value],set())[0],[])

    def test_inventory_read_failures_are_finite_and_suppress_raw_exception(self):
        for stage,code in (('LIST','INVENTORY_LIST_EXEC'),('INSPECT','INVENTORY_INSPECT_EXEC')):
            def read(*args):
                if stage=='LIST' or args[:3]==('docker','image','inspect'):
                    raise RuntimeError('private-inventory-error')
                return self.candidate
            with self.subTest(stage=stage),patch.object(cache,'read',side_effect=read):
                with self.assertRaisesRegex(cache.CacheRejected,'^'+code+'$'):cache.cache_inventory()

    def test_inventory_list_deadline_remains_controlled(self):
        for rejected in (cache.CacheRejected,cache.StorageRejected):
            error=rejected('DEADLINE_EXCEEDED')
            with self.subTest(kind=rejected.__name__),patch.object(cache,'read',side_effect=error):
                with self.assertRaises(rejected) as actual:cache.cache_inventory()
                self.assertIs(actual.exception,error)
        with patch.object(cache,'read',side_effect=RuntimeError('DEADLINE_EXCEEDED')):
            with self.assertRaisesRegex(cache.CacheRejected,'^INVENTORY_LIST_EXEC$'):cache.cache_inventory()

    def test_inventory_inspect_deadline_remains_controlled(self):
        for rejected in (cache.CacheRejected,cache.StorageRejected):
            error=rejected('DEADLINE_EXCEEDED')
            with self.subTest(kind=rejected.__name__),patch.object(cache,'read',side_effect=[self.candidate,error]):
                with self.assertRaises(rejected) as actual:cache.cache_inventory()
                self.assertIs(actual.exception,error)
        with patch.object(cache,'read',side_effect=[self.candidate,RuntimeError('DEADLINE_EXCEEDED')]):
            with self.assertRaisesRegex(cache.CacheRejected,'^INVENTORY_INSPECT_EXEC$'):cache.cache_inventory()

    def test_inventory_list_bound_remains_before_dedup_and_ids_stay_strict(self):
        row=self.inventory()[0]
        with patch.object(cache,'read',side_effect=['\n'.join([row['id']]*128),cache.cache_canonical(row)] ) as read:
            self.assertEqual(cache.cache_inventory(),[row]);self.assertEqual(read.call_count,2)
        for raw,code in (('\n'.join([row['id']]*129),'INVENTORY_LIST_COUNT'),
                ('a'*64,'INVENTORY_LIST_ID'),(row['id']+'\n\ninvalid','INVENTORY_LIST_ID'),
                (row['id'].encode(),'INVENTORY_LIST_ID')):
            with self.subTest(code=code),patch.object(cache,'read',return_value=raw) as read:
                with self.assertRaisesRegex(cache.CacheRejected,'^'+code+'$'):cache.cache_inventory()
                self.assertEqual(read.call_count,1)

    def test_inventory_json_failure_covers_invalid_duplicate_nonfinite_and_bound(self):
        for raw in ('not-json','{"id":1,"id":2}','{"size":NaN}',' '*(2*1024**2),None):
            with self.subTest(raw_type=type(raw).__name__),patch.object(cache,'read',side_effect=[self.candidate,raw]):
                with self.assertRaisesRegex(cache.CacheRejected,'^INVENTORY_JSON$'):cache.cache_inventory()

    def test_inventory_row_shape_rejects_unknown_wrong_id_types_and_size(self):
        row=self.inventory()[0]
        for value in (None,[],{**row,'unknown':'private'}, {**row,'id':self.kept},
                {**row,'sizeBytesEstimate':True},{**row,'sizeBytesEstimate':-1},
                {**row,'sizeBytesEstimate':2**63},{**row,'sourceCommit':False},{**row,'repoTags':False}):
            with self.subTest(value_type=type(value).__name__),patch.object(cache,'read',side_effect=[row['id'],cache.cache_canonical(value)]):
                with self.assertRaisesRegex(cache.CacheRejected,'^INVENTORY_SHAPE$'):cache.cache_inventory()

    def test_inventory_dense_aliases_and_malformed_tags_keep_original_limits(self):
        row=self.inventory()[0];tags=['public:'+str(n) for n in range(32)]
        dense={**row,'repoTags':tags}
        with patch.object(cache,'read',side_effect=[row['id'],cache.cache_canonical(dense)]):
            self.assertEqual(cache.cache_inventory(),[{**dense,'repoTags':sorted(tags)}])
        for values in (tags+['public:32'],['same','same'],[''],['x'*513],[False],[{}],['\ud800']):
            with self.subTest(tag_count=len(values)),patch.object(cache,'read',side_effect=[row['id'],cache.cache_canonical({**row,'repoTags':values})]):
                with self.assertRaisesRegex(cache.CacheRejected,'^INVENTORY_TAGS$'):cache.cache_inventory()

    def test_inventory_without_source_label_remains_non_candidate(self):
        row=self.inventory()[0]
        for source in (None,''):
            with self.subTest(source=source),patch.object(cache,'read',side_effect=[row['id'],cache.cache_canonical({**row,'sourceCommit':source,'repoTags':None})]):
                inventory=cache.cache_inventory();self.assertEqual(inventory[0]['repoTags'],[])
                candidates,excluded=cache.cache_filter_inventory(self.binding(),inventory,set())
                self.assertEqual(candidates,[]);self.assertEqual(excluded['SOURCE_NOT_PROVEN_OLD'],1)
        self.assertIn('{{if eq .Config nil}}null{{else}}',cache.CACHE_IMAGE_FORMAT)
        self.assertIn('{{if eq (index .Config "Labels") nil}}null{{else}}',cache.CACHE_IMAGE_FORMAT)

    def test_inventory_subcodes_survive_host_and_artifact_with_no_mutation(self):
        for operation,approval in (('verify_unused_cache',None),('cleanup_unused_cache','a'*64)):
            for stage,code in (('LIST','INVENTORY_LIST_EXEC'),('INSPECT','INVENTORY_INSPECT_EXEC')):
                binding=self.binding(operation,approval)
                with self.subTest(operation=operation,stage=stage):
                    value,removals,commands,saved=self.run_host(binding,inventory_failure=stage)
                    self.assertEqual((value['status'],value['code'],value['phase']),('FAILED',code,'INVENTORY'))
                    self.assertFalse(value['mutationAttempted']);self.assertIsNone(value['plan'])
                    self.assertEqual((removals,saved),([],[]));self.assertNotIn('private-inventory-error',json.dumps(value))
                    record={'kind':'CACHE_RECOVERY_ARTIFACT_V1','operation':operation,'producer':binding['producer'],
                        'expectedCurrent':cache.CACHE_BASELINE,'commandId':'12345678-1234-1234-1234-123456789abc',
                        'status':'OPERATION_FAILED','code':code,'result':value}
                    cache.validate_artifact(record,binding['producer'],binding)

    def test_plan_canonical_excludes_run_and_deduplicates_size_estimate(self):
        first=self.safe_plan();second=self.safe_plan(self.binding(producer={**self.producer,'workflowRunId':'456'}))
        self.assertEqual(first['planSha256'],second['planSha256']);self.assertIsNone(first['exclusiveBytesReclaimable'])
        for field in ('sourceTree','pendingCandidateCommit','inventorySha256','sourcePinsSha256'):
            changed=json.loads(json.dumps(first['plan']));changed[field]='1'*len(changed[field]);self.assertNotEqual(cache.plan_digest(changed),first['planSha256'])

    def test_binding_requires_explicit_exact_approval_and_closed_source_pins(self):
        for binding in (self.binding('cleanup_unused_cache'),self.binding(approval='f'*64),
                {**self.binding(),'unexpected':'raw'}, {**self.binding(),'provenOldSourceCommits':[cache.CACHE_BASELINE]}):
            with self.subTest(binding=binding):
                with self.assertRaises(cache.CacheRejected):cache.cache_binding(binding)
        cache.cache_binding(self.binding('cleanup_unused_cache','f'*64))

    def test_readonly_actual_execute_has_no_mutations_receipts_and_proves_ecr(self):
        value,removals,commands,saved=self.run_host(self.binding())
        self.assertEqual((value['status'],value['candidateCount']),('PLANNED',1));self.assertEqual(removals,[]);self.assertEqual(saved,[])
        self.assertTrue(value['plan']['items'][0]['recoveryVerified']);self.assertNotIn('raw-docker',json.dumps(value))

    def test_services_baseline_dependencies_inventory_and_remote_failure_stop_without_mutation(self):
        for options,code,phase in (({'wrong_services':True},'SERVICES_CHANGED','SERVICES_BEFORE'),
                ({'wrong_baseline':True},'BASELINE_INVALID','SERVICES_BEFORE'),
                ({'dependencies_failure':True},'DEPENDENCY_INVALID','DEPENDENCIES'),
                ({'inventory_drift':True},'STATE_CHANGED','PLAN_BINDING'),
                ({'recovery_failure':True},'RECOVERY_INVALID','RECOVERY')):
            with self.subTest(options=options):
                value,removals,_,_=self.run_host(self.binding(),**options)
                self.assertEqual((value['status'],value['code'],value['phase']),('FAILED',code,phase));self.assertEqual(removals,[])
                self.assertNotIn('raw-private',json.dumps(value))

    def test_wrong_approved_plan_stops_before_receipt_or_removal(self):
        value,removals,_,saved=self.run_host(self.binding('cleanup_unused_cache','0'*64))
        self.assertEqual(value['code'],'PLAN_CHANGED');self.assertEqual(removals,[]);self.assertEqual(saved,[])

    def test_exact_plan_apply_only_removes_one_approved_reference_and_persists_receipts(self):
        planned,_,_,_=self.run_host(self.binding());binding=self.binding('cleanup_unused_cache',planned['planSha256'])
        value,removals,commands,saved=self.run_host(binding)
        self.assertEqual((value['status'],value['removedCount']),('APPLIED',1));self.assertEqual(len(removals),1)
        self.assertTrue(all(args[:3]==('image','rm','--no-prune') for args in commands if args[:2]==('image','rm')))
        self.assertEqual(cache.cache_sha(saved[0]),value['receiptSha256'])
        self.assertEqual(json.loads(saved[0].splitlines()[-1])['itemReceipts'][0]['state'],'REMOVED')

    def test_successful_untag_can_leave_known_dangling_image_without_touching_it(self):
        planned,_,_,_=self.run_host(self.binding())
        value,removals,commands,_=self.run_host(self.binding('cleanup_unused_cache',planned['planSha256']),dangling=True)
        self.assertEqual(value['status'],'APPLIED');self.assertEqual(len(removals),1)
        self.assertFalse(any(args[-1].startswith('sha256:') for args in commands if args[:2]==('image','rm')))

    def test_partial_failure_retains_attempt_and_removed_identities_no_rollback(self):
        # Two distinct image IDs use different run tags to avoid duplicate references.
        original=self.inventory
        def rows(count=1):
            values=original(count)
            for index,row in enumerate(values):row['repoTags']=[cache.REPOSITORY+':'+self.old+'-'+str(index+1)+'-1-api']
            return values
        with patch.object(self,'inventory',side_effect=rows):
            planned,_,_,_=self.run_host(self.binding(),count=2)
            value,removals,commands,saved=self.run_host(self.binding('cleanup_unused_cache',planned['planSha256']),count=2,fail_remove=2)
        self.assertEqual((value['status'],value['removedCount']),('FAILED_MUTATED_UNVERIFIED',1))
        self.assertEqual([r['state'] for r in value['itemReceipts']],['REMOVED','FAILED_MUTATED_UNVERIFIED'])
        self.assertEqual(len(removals),2);self.assertNotIn('secret-error',json.dumps(value))
        self.assertEqual(json.loads(saved[0].splitlines()[-1])['removedCount'],1)

    def test_service_drift_after_mutation_does_not_undo_or_start_anything(self):
        planned,_,_,_=self.run_host(self.binding());value,removals,commands,_=self.run_host(
            self.binding('cleanup_unused_cache',planned['planSha256']),change_after_remove=True)
        self.assertEqual(value['status'],'FAILED_MUTATED_UNVERIFIED');self.assertEqual(len(removals),1)
        self.assertFalse(any(args[0] in ('start','restart','compose','system','builder') for args in commands))

    def test_safe_validator_accepts_migrate_dependency_but_rejects_unknown_or_unprotected(self):
        for mutate in (lambda p:p['dependencies']['serviceRollback'].update(unknown={'status':'NO_DISTINCT_PREDECESSOR'}),
                lambda p:p['dependencies']['imageIds'].clear(),lambda p:p['protectedImageIds'].clear()):
            value=self.safe_plan();mutate(value['plan']);value['planSha256']=cache.plan_digest(value['plan'])
            with self.assertRaises(cache.CacheRejected):cache.validate_result(value,self.binding())

    def test_result_and_artifact_reject_raw_fields_status_lie_and_transport_null_misuse(self):
        value=self.safe_plan();binding=self.binding();uuid='12345678-1234-1234-1234-123456789abc'
        record={'kind':'CACHE_RECOVERY_ARTIFACT_V1','operation':'verify_unused_cache','producer':self.producer,
            'expectedCurrent':cache.CACHE_BASELINE,'commandId':uuid,'status':'OPERATION_COMPLETED','code':'OK','result':value}
        cache.validate_artifact(record,self.producer,binding)
        for change in ({'raw':'secret'}, {'status':'OPERATION_FAILED'}, {'result':None}, {'commandId':None}):
            with self.subTest(change=change):
                with self.assertRaises(cache.CacheRejected):cache.validate_artifact({**record,**change},self.producer,binding)
        cache.validate_artifact({**record,'status':'OPERATION_FAILED','code':'TRANSPORT_UNAVAILABLE','result':None},self.producer,binding)
        with self.assertRaises(cache.CacheRejected):cache.validate_result({**value,'operation':'cleanup_unused_cache','mode':'APPLY_EXACT_APPROVED','sourceBinding':self.binding('cleanup_unused_cache','f'*64)},self.binding('cleanup_unused_cache','f'*64))
        for raw in ('{"a":1,"a":2}','{"a":NaN}'):
            with self.assertRaises(cache.CacheRejected):cache.cache_closed(raw)

    @classmethod
    def parameter_git(cls,args,**kwargs):
        if args[:2]==['git','rev-parse']:return SimpleNamespace(returncode=0,stdout=cls.producer['sourceTree'].encode())
        if args[:2]==['git','rev-list']:return SimpleNamespace(returncode=0,stdout=(cache.CACHE_BASELINE+'\n'+cls.old+'\n').encode())
        if args[:2]==['git','show']:
            path=args[2].split(':',1)[1];return SimpleNamespace(returncode=0,stdout=(cls.project/path).read_bytes())
        raise AssertionError(args)

    def test_actual_carrier_compiles_sha_binds_every_source_and_keeps_original_snapshot_ast(self):
        import ast,base64,lzma,shlex
        with patch.object(cache.subprocess,'run',side_effect=self.parameter_git):
            payload,binding=cache.parameters(self.producer,source=self.project)
        self.assertEqual(set(payload),{'stages','execute'});self.assertIn(len(payload['stages']),(2,3))
        self.assertEqual(payload['execute']['executionTimeout'],['600'])
        chunks=[]
        for stage in payload['stages']:
            self.assertLess(len(cache.cache_canonical(stage['parameters'])),20480)
            tree=ast.parse(shlex.split(stage['parameters']['commands'][-1])[2]);compile(tree,'<stage>','exec')
            spec=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='SPEC' for t in n.targets))
            chunks.append(spec['fragment']);cache.validate_stage_ack(stage['ack'],spec['ack'])
        self.assertLess(len(cache.cache_canonical(payload['execute'])),20480)
        frame=cache.cache_closed(lzma.decompress(base64.b85decode(''.join(chunks))),262145)
        captured=cache.cache_canonical({'program':frame['program'],'modules':frame['modules']})
        self.assertEqual(cache.cache_sha(captured),binding['capturedProgramSha256']);compile(frame['program'],'<synthetic-cache>','exec')
        def original_ast(text,name):return ast.dump(next(n for n in ast.parse(text).body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name==name),include_attributes=False)
        original=(self.project/cache.CACHE_PINS[1]).read_text()
        for name in ('current','collect_dependencies','fixed_dependencies','make_plan','verify_remote','cache_execute'):
            self.assertEqual(original_ast(original,name),original_ast(frame['program'],name))
        snapshot=(self.project/cache.CACHE_PINS[3]).read_text()
        for name in ('NativeSnapshotDriver','snapshot_state','snapshot_validate','closed_json'):
            self.assertEqual(original_ast(snapshot,name),original_ast(frame['modules']['snapshot'],name))
        for path,row in binding['sourcePins'].items():self.assertEqual(row['sha256'],cache.cache_sha((self.project/path).read_bytes()))
        # Execute only definitions: no factory/host/SSM operation. Exercise the actual closed labels helper.
        namespace={};tree=ast.parse(frame['program']);tree.body=[n for n in tree.body if not (isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='VALUE' for t in n.targets)) and not (isinstance(n,ast.Expr) and isinstance(n.value,ast.Call) and isinstance(n.value.func,ast.Name) and n.value.func.id=='print') and not isinstance(n,ast.Raise)]
        namespace.update(BINDING=binding,MODULES=frame['modules']);exec(compile(tree,'<synthetic-cache-defs>','exec'),namespace)
        directory=Path('/opt/id-business-v2/releases/20261008T000000Z-0a03fa28e6b8');driver=namespace['factory'](directory,Path('/synthetic/client'))
        cid='1'*64;driver.native=lambda *unused:cache.cache_canonical({'id':cid,'project':'id-business-v2','role':'api','directory':str(directory),'files':','.join(str(directory/n) for n in ('docker-compose.aws-mysql.yml','compose.release.json'))}).decode()
        self.assertEqual(driver.public_labels(cid)['role'],'api')
        self.assertIn('APPLY_EXACT_APPROVED',frame['program'])

    def test_both_operations_all_stages_fit_cap_with_128_old_proofs_and_twenty_digit_producer(self):
        import ast,shlex
        producer={**self.producer,'workflowRunId':'9'*20,'workflowRunAttempt':'9'*20}
        commits=[f'{number:040x}' for number in range(1,129)]
        def git(args,**kwargs):
            if args[:2]==['git','rev-list']:return SimpleNamespace(returncode=0,stdout=('\n'.join([cache.CACHE_BASELINE,*commits])+'\n').encode())
            return self.parameter_git(args,**kwargs)
        for operation,approval in (('verify_unused_cache',None),('cleanup_unused_cache','a'*64)):
            with self.subTest(operation=operation),patch.object(cache.subprocess,'run',side_effect=git):
                bundle,binding=cache.parameters(producer,source=self.project,operation=operation,approved_plan_sha256=approval)
                self.assertEqual(len(binding['provenOldSourceCommits']),128)
                for payload in [s['parameters'] for s in bundle['stages']]+[bundle['execute']]:
                    self.assertLess(len(cache.cache_canonical(payload)),20480);compile(ast.parse(shlex.split(payload['commands'][-1])[2]),'<synthetic-stage>','exec')

    def test_source_stage_ack_rejects_extra_wrong_hash_order_and_boolean_index(self):
        with patch.object(cache.subprocess,'run',side_effect=self.parameter_git):bundle,_=cache.parameters(self.producer,source=self.project)
        expected=bundle['stages'][0]['ack'];cache.validate_stage_ack(expected,expected)
        for change in ({'index':False},{'index':1},{'partSha256':'0'*64},{'raw':'secret'}):
            with self.subTest(change=change):
                with self.assertRaises(cache.CacheRejected):cache.validate_stage_ack({**expected,**change},expected)

    def test_source_stages_joint_merge_cleanup_and_unknown_replacement_preserved(self):
        import ast,copy,os,shlex,hashlib
        with patch.object(cache.subprocess,'run',side_effect=self.parameter_git):bundle,binding=cache.parameters(self.producer,source=self.project)
        specs=[]
        for payload in [s['parameters'] for s in bundle['stages']]+[bundle['execute']]:
            tree=ast.parse(shlex.split(payload['commands'][-1])[2])
            specs.append(next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='SPEC' for t in n.targets)))
        original_open,original_stat,original_fstat=os.open,os.stat,os.fstat
        class Owned:
            def __init__(unused,info):unused.info=info
            def __getattr__(unused,name):return 0 if name=='st_uid' else getattr(unused.info,name)
        for drift in ('NONE','PRE_EXEC_UNKNOWN','POST_EXEC_UNKNOWN'):
            with self.subTest(drift=drift),tempfile.TemporaryDirectory(dir=self.output) as directory,contextlib.ExitStack() as stack:
                root=Path(directory);(root/'opt/id-business-v2/.staging').mkdir(parents=True)
                stack.enter_context(patch.object(cache.os,'open',side_effect=lambda path,*args,**kw:original_open(root if path=='/' else path,*args,**kw)))
                stack.enter_context(patch.object(cache.os,'getuid',return_value=0));stack.enter_context(patch.object(cache.os,'geteuid',return_value=0))
                stack.enter_context(patch.object(cache.os,'fstat',side_effect=lambda fd:Owned(original_fstat(fd))))
                stack.enter_context(patch.object(cache.os,'stat',side_effect=lambda *a,**kw:Owned(original_stat(*a,**kw))))
                for spec in specs[:-1]:self.assertEqual(cache.cache_source_stage(spec),spec['ack'])
                scratch=next((root/'opt/id-business-v2/.staging').iterdir());calls=[]
                if drift=='PRE_EXEC_UNKNOWN':(scratch/'part-0').write_bytes(b'unknown-WIP')
                def execute(raw):
                    calls.append(raw)
                    self.assertEqual(hashlib.sha256(__import__('lzma').decompress(__import__('base64').b85decode(raw))).hexdigest(),specs[-1]['frameSha256'])
                    if drift=='POST_EXEC_UNKNOWN':(scratch/'part-0').write_bytes(b'unknown-WIP')
                    return self.safe_plan(binding)
                if drift=='PRE_EXEC_UNKNOWN':
                    with self.assertRaisesRegex(RuntimeError,'SOURCE_STAGE_REJECTED'):cache.cache_source_stage(specs[-1],execute)
                    self.assertEqual(calls,[]);self.assertEqual((scratch/'part-0').read_bytes(),b'unknown-WIP')
                else:
                    value,_=cache.cache_source_stage(specs[-1],execute)
                    self.assertEqual(len(calls),1);cache.validate_result(value,binding)
                    if drift=='NONE':self.assertFalse(scratch.exists());self.assertTrue(value['guards']['clientCleanupVerified'])
                    else:self.assertTrue(scratch.exists());self.assertEqual((scratch/'part-0').read_bytes(),b'unknown-WIP');self.assertEqual(value['status'],'FAILED')

    def test_full_source_stage_to_exact_apply_same_base_has_no_directory_creation_drift(self):
        import ast,os,shlex
        planned,_,_,_=self.run_host(self.binding());binding=self.binding('cleanup_unused_cache',planned['planSha256'])
        with patch.object(cache.subprocess,'run',side_effect=self.parameter_git):bundle,_=cache.parameters(self.producer,source=self.project,operation='cleanup_unused_cache',approved_plan_sha256=planned['planSha256'])
        specs=[]
        for payload in [s['parameters'] for s in bundle['stages']]+[bundle['execute']]:
            tree=ast.parse(shlex.split(payload['commands'][-1])[2]);specs.append(next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='SPEC' for t in n.targets)))
        original_open,original_stat,original_fstat=os.open,os.stat,os.fstat
        class Owned:
            def __init__(unused,info):unused.info=info
            def __getattr__(unused,name):return 0 if name=='st_uid' else getattr(unused.info,name)
        with tempfile.TemporaryDirectory(dir=self.output) as directory,contextlib.ExitStack() as stack:
            root=Path(directory);base=root/'opt/id-business-v2';(base/'.staging').mkdir(parents=True)
            (base/'maintenance/docker-cache-retention').mkdir(parents=True);(base/'.deploy.lock').write_bytes(b'');(base/'.deploy.lock').chmod(0o600)
            stack.enter_context(patch.object(cache.os,'open',side_effect=lambda path,*args,**kw:original_open(root if path=='/' else path,*args,**kw)))
            stack.enter_context(patch.object(cache.os,'getuid',return_value=0));stack.enter_context(patch.object(cache.os,'geteuid',return_value=0))
            stack.enter_context(patch.object(cache.os,'fstat',side_effect=lambda fd:Owned(original_fstat(fd))))
            stack.enter_context(patch.object(cache.os,'stat',side_effect=lambda *a,**kw:Owned(original_stat(*a,**kw))))
            for spec in specs[:-1]:cache.cache_source_stage(spec)
            result,_=cache.cache_source_stage(specs[-1],lambda unused:self.run_host(binding,root_override=base)[0])
            cache.validate_result(result,binding);self.assertEqual(result['status'],'APPLIED')
            self.assertTrue(result['guards']['clientCleanupVerified']);self.assertEqual(list((base/'.staging').iterdir()),[])

    def test_source_staging_unknown_directory_and_out_of_order_never_overwritten(self):
        import ast,os,shlex
        with patch.object(cache.subprocess,'run',side_effect=self.parameter_git):bundle,_=cache.parameters(self.producer,source=self.project)
        tree=ast.parse(shlex.split(bundle['stages'][0]['parameters']['commands'][-1])[2])
        spec=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='SPEC' for t in n.targets))
        with tempfile.TemporaryDirectory(dir=self.output) as directory:
            path=Path(directory)/'opt/id-business-v2/.staging';path.mkdir(parents=True)
            target=path/('cache-recovery-'+self.producer['workflowRunId']+'-'+self.producer['workflowRunAttempt']+'-'+spec['frameSha256']);target.mkdir();(target/'existing').write_bytes(b'unknown-WIP')
            original=os.open
            with patch.object(cache.os,'getuid',return_value=0),patch.object(cache.os,'geteuid',return_value=0),patch.object(cache.os,'open',side_effect=lambda path,*a,**kw:original(Path(directory) if path=='/' else path,*a,**kw)):
                with self.assertRaises(Exception):cache.cache_source_stage(spec)
            self.assertEqual((target/'existing').read_bytes(),b'unknown-WIP')

    def test_git_source_drift_refused_before_packaging(self):
        def changed(args,**kwargs):
            result=self.parameter_git(args,**kwargs)
            if args[:2]==['git','show'] and args[2].endswith('storage-maintenance.py'):result.stdout+=b'\n'
            return result
        with patch.object(cache.subprocess,'run',side_effect=changed):
            with self.assertRaisesRegex(cache.CacheRejected,'STATE_CHANGED'):cache.parameters(self.producer,source=self.project)

    def test_old_function_ast_and_six_gib_release_threshold_unchanged(self):
        import ast,subprocess
        raw=subprocess.check_output(['git','show','HEAD:scripts/production-release/maintain-image-cache.py'],cwd=self.project).decode()
        current=(DIRECTORY/'maintain-image-cache.py').read_text()
        original={n.name:ast.dump(n,include_attributes=False) for n in ast.parse(raw).body if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
        revised={n.name:ast.dump(n,include_attributes=False) for n in ast.parse(current).body if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
        self.assertTrue(all(revised[name]==value for name,value in original.items() if name!='cache_inventory'))
        ordinary={n.name:ast.dump(n,include_attributes=False) for n in ast.parse(raw.split('# Independent fixed-bootstrap plan/apply transport.',1)[0]).body if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
        ordinary['main']=original['main']
        self.assertEqual(len(ordinary),24);self.assertTrue(all(revised[name]==value for name,value in ordinary.items()))


if __name__ == '__main__':
    unittest.main()
