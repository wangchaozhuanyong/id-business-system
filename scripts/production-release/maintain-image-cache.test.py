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
        self.assertEqual(result['plan'], self.plan)

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
                 dangling=False, recovery_failure=False, root_override=None, inventory_failure=None,
                 dependencies_override=None, inventory_out=None):
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
        deps=dependencies_override if dependencies_override is not None else {'version':1,'imageIds':[self.kept],'serviceRollback':{},'evidenceSha256':{}}
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
        if inventory_out is not None:inventory_out.extend(copy.deepcopy(state['inventory']))
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

    def test_excluded_source_diagnostics_classify_aliases_without_secret_or_untrusted_hex_output(self):
        import io
        secret='PRIVATE_LABEL_AND_ALIAS_DO_NOT_PRINT';b='b'*40;c='c'*40;d='d'*40
        tag=lambda source,attempt=1:cache.REPOSITORY+':'+source+'-1-'+str(attempt)+'-api'
        cases=[(None,[],'UNTAGGED','MISSING',None,None),
            (None,[tag(b),secret+':secret'],'FOREIGN_OR_MIXED_REPOSITORY','MISSING',None,None),
            (secret,[cache.REPOSITORY+':'+secret],'PROJECT_NON_RELEASE_TAG','INVALID',None,None),
            (b,[tag(b),tag(c)],'PROJECT_RELEASE_SOURCE_MISMATCH','UNVERIFIED_HEX',None,None),
            (b,[tag(b),tag(b,2)],'PROJECT_RELEASE','CANONICAL_TAG_MATCH',b,b),
            (None,[tag(b)],'PROJECT_RELEASE','MISSING',None,b),
            (d,[tag(b)],'PROJECT_RELEASE','RELEASE_TAG_MISMATCH',None,b),
            (b,['foreign:'+secret],'FOREIGN_OR_MIXED_REPOSITORY','UNVERIFIED_HEX',None,None)]
        rows=[{'id':'sha256:'+f'{n+1:064x}','sourceCommit':source,'repoTags':tags,'sizeBytesEstimate':n}
            for n,(source,tags,*unused) in enumerate(cases)]
        protected='sha256:'+f'{99:064x}'
        rows.append({'id':protected,'sourceCommit':secret,'repoTags':[secret+':secret'],'sizeBytesEstimate':2**63-1})
        rows.append({'id':'sha256:'+f'{100:064x}','sourceCommit':self.old,'repoTags':['foreign:'+secret],'sizeBytesEstimate':1})
        stream=io.StringIO()
        with contextlib.redirect_stdout(stream):diagnostic=cache.cache_source_diagnostics(self.binding(),rows,{protected})
        self.assertEqual((diagnostic['totalCount'],diagnostic['truncated'],len(diagnostic['items'])),(8,False,8))
        self.assertEqual(stream.getvalue(),'');self.assertNotIn(secret,cache.cache_canonical(diagnostic).decode())
        self.assertNotIn(d,cache.cache_canonical(diagnostic).decode());self.assertNotIn(protected,cache.cache_canonical(diagnostic).decode())
        for row,(_,_,alias,claim,source,tag_source) in zip(diagnostic['items'],cases):
            self.assertEqual((row['aliasClass'],row['sourceClaimClass'],row['sourceCommit'],row['tagSourceCommit']),
                (alias,claim,source,tag_source))
            self.assertEqual(set(row),{'imageId','sourceCommit','sourceClaimClass','sizeBytesEstimate','tagCount','aliasClass','tagSourceCommit'})
        allowed,excluded=cache.cache_filter_inventory(self.binding(),rows,{protected})
        self.assertEqual(allowed,[]);self.assertEqual(excluded['SOURCE_NOT_PROVEN_OLD'],8)

    def test_excluded_source_diagnostics_are_sorted_bounded_and_omit_all_protected(self):
        for count in (0,8,9,128):
            rows=[{'id':'sha256:'+f'{n+1:064x}','sourceCommit':None,'repoTags':[],'sizeBytesEstimate':1}
                for n in range(count)]
            diagnostic=cache.cache_source_diagnostics(self.binding(),list(reversed(rows)),set())
            self.assertEqual(diagnostic['totalCount'],count);self.assertEqual(diagnostic['truncated'],count>8)
            self.assertEqual([r['imageId'] for r in diagnostic['items']],[r['id'] for r in rows[:8]])
            self.assertEqual(cache.cache_source_diagnostics(self.binding(),rows,{r['id'] for r in rows}),
                {'totalCount':0,'truncated':False,'items':[]})

    def test_excluded_source_diagnostic_validator_rejects_extra_raw_fields_and_inconsistent_shapes(self):
        import copy
        value=self.safe_plan();plan=value['plan'];unknown={'id':'sha256:'+'2'*64,'sourceCommit':'b'*40,
            'repoTags':[cache.REPOSITORY+':'+('b'*40)+'-1-1-api'],'sizeBytesEstimate':10}
        plan['excludedSources']=cache.cache_source_diagnostics(self.binding(),[unknown],set())
        plan['excludedCounts']['SOURCE_NOT_PROVEN_OLD']=1;value['planSha256']=cache.plan_digest(plan)
        cache.validate_result(value,self.binding())
        changes=[('diagnostic-extra',lambda p:p['excludedSources'].update(raw='private')),
            ('boolean-count',lambda p:p['excludedSources'].update(totalCount=True)),
            ('huge-count',lambda p:p['excludedSources'].update(totalCount=129)),
            ('wrong-count',lambda p:p['excludedCounts'].update(SOURCE_NOT_PROVEN_OLD=0)),
            ('wrong-truncation',lambda p:p['excludedSources'].update(truncated=True)),
            ('missing-row',lambda p:p['excludedSources'].update(items=[])),
            ('duplicate-row',lambda p:(p['excludedSources'].update(totalCount=2),p['excludedCounts'].update(SOURCE_NOT_PROVEN_OLD=2),
                p['excludedSources']['items'].append(copy.deepcopy(p['excludedSources']['items'][0]))))]
        fields=[('RepoTags',['private']),('sourceCommit','private'),('sourceCommit',self.old),('sourceCommit','c'*40),
            ('sourceCommit',None),('imageId',self.kept),('imageId',plan['items'][0]['imageId']),('imageId','private'),
            ('sizeBytesEstimate',True),('sizeBytesEstimate',-1),('sizeBytesEstimate',2**63),
            ('tagCount',True),('tagCount',0),('tagCount',33),('aliasClass','private'),
            ('aliasClass','UNTAGGED'),('aliasClass','FOREIGN_OR_MIXED_REPOSITORY'),
            ('sourceClaimClass','private'),('sourceClaimClass','UNVERIFIED_HEX'),('tagSourceCommit','private')]
        changes.extend((field,lambda p,k=field,v=value:p['excludedSources']['items'][0].update({k:v})) for field,value in fields)
        for name,change in changes:
            with self.subTest(change=name):
                revised=copy.deepcopy(value);change(revised['plan']);revised['planSha256']=cache.plan_digest(revised['plan'])
                with self.assertRaises(cache.CacheRejected):cache.validate_result(revised,self.binding())
        unordered=copy.deepcopy(value);second=copy.deepcopy(unordered['plan']['excludedSources']['items'][0]);second['imageId']='sha256:'+'3'*64
        unordered['plan']['excludedSources'].update(totalCount=2,items=[second,unordered['plan']['excludedSources']['items'][0]])
        unordered['plan']['excludedCounts']['SOURCE_NOT_PROVEN_OLD']=2;unordered['planSha256']=cache.plan_digest(unordered['plan'])
        with self.assertRaises(cache.CacheRejected):cache.validate_result(unordered,self.binding())

    def test_excluded_source_diagnostics_are_plan_bound_and_never_add_cleanup_candidates(self):
        unknown=[{'id':'sha256:'+f'{n+20:064x}','sourceCommit':None,
            'repoTags':[cache.REPOSITORY+':'+('b'*40)+'-1-'+str(n+1)+'-api'],'sizeBytesEstimate':2**63-1}
            for n in range(8)]
        inventory=[self.inventory()[0],*unknown]
        with patch.object(self,'inventory',return_value=inventory):
            planned,removed,commands,_=self.run_host(self.binding(),count=len(inventory))
            self.assertEqual((planned['status'],planned['candidateCount'],removed),('PLANNED',1,[]))
            self.assertEqual(planned['plan']['excludedSources']['totalCount'],8)
            self.assertFalse(planned['plan']['excludedSources']['truncated'])
            approved=self.binding('cleanup_unused_cache',planned['planSha256'])
            applied,removed,_,_=self.run_host(approved,count=len(inventory))
            self.assertEqual((applied['status'],applied['planSha256']),('APPLIED',planned['planSha256']))
            self.assertEqual(removed,[inventory[0]['repoTags'][0]])
        import copy
        changed=copy.deepcopy(inventory);changed[1]['sourceCommit']='private-new-label'
        with patch.object(self,'inventory',return_value=changed):
            revised,_,_,_=self.run_host(self.binding(),count=len(changed))
            self.assertNotEqual(revised['planSha256'],planned['planSha256'])
            rejected,removed,_,_=self.run_host(approved,count=len(changed))
            self.assertEqual((rejected['status'],rejected['code'],removed),('FAILED','PLAN_CHANGED',[]))
            self.assertNotIn('private-new-label',cache.cache_canonical(rejected).decode())

    def test_excluded_source_diagnostics_fit_real_plan_apply_partial_and_journal_budgets(self):
        binding=self.binding(producer={**self.producer,'workflowRunId':'9'*20,'workflowRunAttempt':'9'*20})
        binding['provenOldSourceCommits']=sorted([self.old,*[f'{n:040x}' for n in range(1,128)]])
        eligible=[{'id':'sha256:'+f'{n+1:064x}','sourceCommit':self.old,'sizeBytesEstimate':1000,
            'repoTags':[cache.REPOSITORY+':'+self.old+'-'+str(n+1)+'-'+str(alias+1)+'-api' for alias in range(3)]}
            for n in range(10)]
        unknown=[{'id':'sha256:'+f'{n+100:064x}','sourceCommit':'b'*40,'sizeBytesEstimate':2**63-1,
            'repoTags':[cache.REPOSITORY+':'+('b'*40)+'-'+str(n+1)+'-'+str(alias+1)+'-api' for alias in range(32)]}
            for n in range(118)]
        inventory=[*eligible,*unknown]
        with patch.object(self,'inventory',return_value=inventory):
            planned,_,_,_=self.run_host(binding,count=len(inventory));self.assertEqual(planned['status'],'PLANNED')
            plan=planned['plan'];count=planned['candidateCount'];self.assertGreater(count,0);self.assertEqual(count%3,0)
            diagnostic=plan['excludedSources'];self.assertEqual(diagnostic['totalCount'],118);self.assertTrue(diagnostic['truncated'])
            self.assertEqual(len(diagnostic['items']),8)
            self.assertTrue(all(row['sourceCommit']==row['tagSourceCommit']=='b'*40 and row['tagCount']==32
                and row['sizeBytesEstimate']==2**63-1 for row in diagnostic['items']))
            self.assertTrue(cache.cache_plan_budget(plan,binding));self.assertLessEqual(len(cache.cache_canonical(plan)),12000)
            approved={**binding,'operation':'cleanup_unused_cache','approvedPlanSha256':planned['planSha256']}
            for fail in (None,count):
                result,_,_,journals=self.run_host(approved,count=len(inventory),fail_remove=fail)
                self.assertEqual(result['status'],'APPLIED' if fail is None else 'FAILED_MUTATED_UNVERIFIED')
                self.assertLess(len(cache.cache_canonical(result)),23500)
                artifact={'kind':'CACHE_RECOVERY_ARTIFACT_V1','operation':'cleanup_unused_cache','producer':approved['producer'],
                    'expectedCurrent':cache.CACHE_BASELINE,'commandId':'12345678-1234-1234-1234-123456789abc',
                    'status':'OPERATION_COMPLETED' if fail is None else 'OPERATION_FAILED','code':result['code'],'result':result}
                cache.validate_artifact(artifact,approved['producer'],approved);self.assertLess(len(cache.cache_canonical(artifact)),24000)
                self.assertLess(len(journals[0]),4*1024**2)
                for line in journals[0].splitlines():self.assertLess(len(line),24000)

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

    def test_compact_dependencies_seal_every_path_and_digest_without_omitting_protection(self):
        import copy
        evidence={'releases/20261001T000000Z-'+f'{n:012x}'+'/manifest.json':'a'*64 for n in range(100)}
        dependencies={'version':1,'imageIds':[self.kept],'serviceRollback':{'api':{'status':'RETAINED','commit':self.old,'imageId':self.kept}},'evidenceSha256':evidence}
        original=copy.deepcopy(dependencies)
        planned,_,_,_=self.run_host(self.binding(),dependencies_override=dependencies)
        self.assertEqual(planned['status'],'PLANNED');compact=planned['plan']['dependencies']
        self.assertEqual(compact,{'version':2,'imageIds':dependencies['imageIds'],'serviceRollback':dependencies['serviceRollback'],
            'evidenceSha256':cache.cache_sha(cache.cache_canonical(evidence)),'evidenceCount':100})
        self.assertEqual(dependencies,original);self.assertIn(self.kept,planned['plan']['protectedImageIds'])
        for change in ('PATH','DIGEST','ORDER'):
            changed=copy.deepcopy(dependencies);key=next(iter(evidence))
            if change=='PATH':changed['evidenceSha256'][key.replace('manifest.json','release-source.json')]=changed['evidenceSha256'].pop(key)
            if change=='DIGEST':changed['evidenceSha256'][key]='b'*64
            if change=='ORDER':changed['evidenceSha256']=dict(reversed(list(evidence.items())))
            value,_,_,_=self.run_host(self.binding(),dependencies_override=changed)
            self.assertEqual(value['status'],'PLANNED')
            self.assertEqual(value['planSha256']==planned['planSha256'],change=='ORDER')
        self.assertGreater(len(cache.cache_canonical(evidence)),12000)
        self.assertLess(len(cache.cache_canonical(compact)),12000)

    def test_compact_dependencies_validator_rejects_old_shape_bad_hash_count_and_extra(self):
        for change in ({'version':1},{'version':True},{'evidenceSha256':{}},{'evidenceSha256':'z'*64},
                {'evidenceCount':True},{'evidenceCount':-1},{'evidenceCount':501},{'extra':'private'}):
            value=self.safe_plan();value['plan']['dependencies'].update(change);value['planSha256']=cache.plan_digest(value['plan'])
            with self.subTest(change=change),self.assertRaises(cache.CacheRejected):cache.validate_result(value,self.binding())
        for evidence in ({'/outside/file':'a'*64},{'releases/../file':'a'*64},{'releases/public':'invalid'}):
            with patch.object(cache,'verify_remote') as remote,self.assertRaisesRegex(cache.CacheRejected,'^DEPENDENCY_INVALID$'):
                cache.cache_plan(self.binding(),{'images':{}},{'commit':cache.CACHE_PREVIOUS,'images':{}},
                    {'version':1,'imageIds':[],'serviceRollback':{},'evidenceSha256':evidence},set(),self.inventory(),{'recovery':{}})
            remote.assert_not_called()

    def test_batches_select_only_complete_groups_and_both_operations_fit_worst_outputs(self):
        binding=self.binding();binding['provenOldSourceCommits']=sorted([self.old,*[f'{n:040x}' for n in range(1,128)]])
        def rows(count=1):
            return [{'id':'sha256:'+f'{n+1:064x}','repoTags':[cache.REPOSITORY+':'+self.old+'-'+str(n+1)+'-'+str(alias+1)+'-api' for alias in range(3)],
                'sourceCommit':self.old,'sizeBytesEstimate':1000} for n in range(count)]
        with patch.object(self,'inventory',side_effect=rows):
            planned,_,_,_=self.run_host(binding,count=10)
            self.assertEqual(planned['status'],'PLANNED');plan=planned['plan'];items=plan['items']
            self.assertGreater(len(items),0);self.assertLess(len(items),30)
            selected={i['imageId'] for i in items};self.assertEqual(len(items),len(selected)*3)
            self.assertEqual(selected,{r['id'] for r in rows(10)[:len(selected)]})
            self.assertTrue(cache.cache_plan_budget(plan,binding));self.assertLessEqual(len(cache.cache_canonical(plan)),12000)
            after=[];apply_binding={**binding,'operation':'cleanup_unused_cache','approvedPlanSha256':planned['planSha256']}
            applied,removed,_,saved=self.run_host(apply_binding,count=10,inventory_out=after)
            self.assertEqual((applied['status'],applied['planSha256']),('APPLIED',planned['planSha256']))
            self.assertEqual({r['id'] for r in after},{r['id'] for r in rows(10)}-selected)
            self.assertEqual(len(removed),len(items));self.assertLess(len(cache.cache_canonical(applied)),23500)
            record={'kind':'CACHE_RECOVERY_ARTIFACT_V1','operation':'cleanup_unused_cache','producer':apply_binding['producer'],
                'expectedCurrent':cache.CACHE_BASELINE,'commandId':'12345678-1234-1234-1234-123456789abc',
                'status':'OPERATION_COMPLETED','code':'OK','result':applied}
            cache.validate_artifact(record,apply_binding['producer'],apply_binding);self.assertLess(len(cache.cache_canonical(record)),24000)
            self.assertLess(len(saved[0]),4*1024**2)
            for line in saved[0].splitlines():self.assertLess(len(line),24000)
            failed,_,_,saved_failure=self.run_host(apply_binding,count=10,fail_remove=len(items))
            self.assertEqual(failed['status'],'FAILED_MUTATED_UNVERIFIED');cache.validate_result(failed,apply_binding)
            self.assertLess(len(cache.cache_canonical(failed)),23500);self.assertLess(len(saved_failure[0]),4*1024**2)

    def test_oversized_first_group_is_skipped_without_splitting_or_removing_it(self):
        def rows(count=1):
            return [{'id':'sha256:'+f'{n+1:064x}','repoTags':[cache.REPOSITORY+':'+self.old+'-'+str(n+1)+'-'+str(alias+1)+'-api' for alias in range(32 if n==0 else 2)],
                'sourceCommit':self.old,'sizeBytesEstimate':1000} for n in range(count)]
        with patch.object(self,'inventory',side_effect=rows):
            planned,_,_,_=self.run_host(self.binding(),count=3)
            self.assertEqual(planned['status'],'PLANNED');self.assertEqual(planned['candidateCount'],4)
            self.assertNotIn(rows(3)[0]['id'],{i['imageId'] for i in planned['plan']['items']})
            after=[];applied,_,_,_=self.run_host(self.binding('cleanup_unused_cache',planned['planSha256']),count=3,inventory_out=after)
            self.assertEqual(applied['status'],'APPLIED');self.assertEqual(after,[rows(3)[0]])
            rejected,removed,_,_=self.run_host(self.binding(),count=1)
            self.assertEqual((rejected['status'],rejected['code']),('FAILED','OUTPUT_BOUND'))
            self.assertEqual(removed,[]);self.assertIsNone(rejected['plan'])

    def test_unavoidably_oversized_fixed_metadata_rejects_before_remote_or_mutation(self):
        images={'sha256:'+f'{n:064x}' for n in range(500)}
        with patch.object(cache,'verify_remote') as remote,self.assertRaisesRegex(cache.CacheRejected,'^OUTPUT_BOUND$'):
            cache.cache_plan(self.binding(),{'images':{}},{'commit':cache.CACHE_PREVIOUS,'images':{}},
                {'version':1,'imageIds':sorted(images),'serviceRollback':{},'evidenceSha256':{}},images,[],{'recovery':{}})
        remote.assert_not_called()

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
        if args[:2]==['git','rev-parse']:
            return SimpleNamespace(returncode=0,stdout=b'false\n' if args[2]=='--is-shallow-repository' else cls.producer['sourceTree'].encode())
        if args[:2]==['git','rev-list']:return SimpleNamespace(returncode=0,stdout=(cache.CACHE_BASELINE+'\n'+cls.old+'\n').encode())
        if args[:2]==['git','show']:
            path=args[2].split(':',1)[1]
            if path.startswith('deploy/aws/cache-cleanup-'):
                return SimpleNamespace(returncode=0,stdout=cache.cache_canonical({'items':[{'tag':cls.old+'-1-1-api'}]}))
            return SimpleNamespace(returncode=0,stdout=(cls.project/path).read_bytes())
        raise AssertionError(args)

    def history_git(self,ancestry,items=None,*,calls=None):
        def git(args,**kwargs):
            if calls is not None:calls.append(args)
            if args[:2]==['git','rev-list']:
                self.assertEqual(args,['git','rev-list',cache.CACHE_BASELINE])
                return SimpleNamespace(returncode=0,stdout=('\n'.join(ancestry)+'\n').encode())
            if args[:2]==['git','show'] and ':deploy/aws/cache-cleanup-' in args[2] and items is not None:
                self.assertTrue(args[2].startswith(self.producer['commit']+':'))
                return SimpleNamespace(returncode=0,stdout=cache.cache_canonical({'items':items}))
            return self.parameter_git(args,**kwargs)
        return git

    def test_complete_ancestry_prioritizes_reviewed_source_beyond_recent_129(self):
        recent=[f'{n:040x}' for n in range(1,372)];old=recent[220]
        ancestry=[cache.CACHE_BASELINE,cache.CACHE_PREVIOUS,*recent]
        with patch.object(cache.subprocess,'run',side_effect=self.history_git(ancestry,[{'tag':old+'-1-1-api'}])):
            bundle,binding=cache.parameters(self.producer,source=self.project)
        proofs=binding['provenOldSourceCommits']
        self.assertEqual(len(proofs),128);self.assertEqual(proofs,sorted(set(proofs)))
        self.assertIn(old,proofs);self.assertIn(recent[0],proofs);self.assertNotIn(recent[-1],proofs)
        self.assertFalse(set(proofs)&{cache.CACHE_BASELINE,cache.CACHE_PREVIOUS,self.producer['commit']})
        self.assertTrue(all(len(cache.cache_canonical(p['parameters']))<20480 for p in bundle['stages']))

    def test_historical_sources_require_ancestry_and_exclude_all_three_live_sources(self):
        future='e'*40;ancestor=[cache.CACHE_BASELINE,cache.CACHE_PREVIOUS,self.producer['commit'],self.old]
        items=[{'tag':commit+'-1-1-api'} for commit in (*ancestor,future)]
        with patch.object(cache.subprocess,'run',side_effect=self.history_git(ancestor,items)):
            _,binding=cache.parameters(self.producer,source=self.project)
        self.assertEqual(binding['provenOldSourceCommits'],[self.old])
        inventory=[{'id':'sha256:'+'1'*64,'repoTags':[cache.REPOSITORY+':'+future+'-1-1-api'],
            'sourceCommit':future,'sizeBytesEstimate':1}]
        allowed,excluded=cache.cache_filter_inventory(binding,inventory,set())
        self.assertEqual(allowed,[]);self.assertEqual(excluded['SOURCE_NOT_PROVEN_OLD'],1)

    def test_historical_plan_reads_exact_git_tree_and_never_mixed_worktree(self):
        original=Path.read_bytes;outside='b'*40;calls=[]
        def protected_read(path):
            if path.name.startswith('cache-cleanup-'):
                raise AssertionError('Mixed working tree historical plan read')
            return original(path)
        ancestry=[cache.CACHE_BASELINE,self.old,outside]
        with patch.object(Path,'read_bytes',autospec=True,side_effect=protected_read), \
                patch.object(cache.subprocess,'run',side_effect=self.history_git(ancestry,[{'tag':outside+'-1-1-api'}],calls=calls)):
            _,binding=cache.parameters(self.producer,source=self.project)
        history=[args[2] for args in calls if args[:2]==['git','show'] and ':deploy/aws/cache-cleanup-' in args[2]]
        self.assertEqual(len(history),8);self.assertEqual(len(set(history)),8)
        self.assertTrue(all(path.startswith(self.producer['commit']+':deploy/aws/') for path in history))
        self.assertFalse(any('legacy' in path for path in history));self.assertIn(outside,binding['provenOldSourceCommits'])

    def test_historical_plan_missing_oversize_malformed_or_legacy_tag_fails_closed(self):
        valid=cache.cache_canonical({'items':[{'tag':self.old+'-1-1-api'}]})
        cases=[(1,valid),(0,b' '*4096),(0,b'{"items":[],"items":[]}'),(0,b'{"items":[]}'),
            (0,b'{"items":[{}]}'),(0,cache.cache_canonical({'items':[{'tag':'id-business-v2-api:'+self.old}]}))]
        for code,raw in cases:
            with self.subTest(code=code,rawSize=len(raw)):
                def git(args,**kwargs):
                    if args[:2]==['git','show'] and ':deploy/aws/cache-cleanup-' in args[2]:
                        return SimpleNamespace(returncode=code,stdout=raw)
                    return self.parameter_git(args,**kwargs)
                with patch.object(cache.subprocess,'run',side_effect=git):
                    with self.assertRaises(Exception):cache.parameters(self.producer,source=self.project)

    def test_shallow_or_incomplete_ancestry_fails_before_historical_source_reads(self):
        for shallow,history in [('true',[cache.CACHE_BASELINE,self.old]),('false',[]),
                ('false',[self.old]),('false',[cache.CACHE_BASELINE,self.old,self.old]),
                ('false',[cache.CACHE_BASELINE,'unknown'])]:
            with self.subTest(shallow=shallow,history=history):
                calls=[]
                def git(args,**kwargs):
                    calls.append(args)
                    if args==['git','rev-parse','--is-shallow-repository']:
                        return SimpleNamespace(returncode=0,stdout=shallow.encode())
                    return self.history_git(history)(args,**kwargs)
                with patch.object(cache.subprocess,'run',side_effect=git):
                    with self.assertRaises(cache.CacheRejected):cache.parameters(self.producer,source=self.project)
                self.assertFalse(any(args[:2]==['git','show'] for args in calls))

    def test_historical_selection_is_deterministic_bounded_and_keeps_two_known_candidates(self):
        known='23c5841b9b7e60be715250cbb985fc0966c0bce3';old='b'*40
        recent=[f'{n:040x}' for n in range(1,372)]
        ancestry=[cache.CACHE_BASELINE,known,*recent,old]
        items=[{'tag':old+'-1-1-api'},{'tag':known+'-1-1-admin'}]
        outputs=[]
        for rows in (items,list(reversed(items))):
            with patch.object(cache.subprocess,'run',side_effect=self.history_git(ancestry,rows)):
                outputs.append(cache.parameters(self.producer,source=self.project))
        self.assertEqual(outputs[0],outputs[1]);bundle,binding=outputs[0]
        self.assertEqual(len(binding['provenOldSourceCommits']),128)
        inventory=[{'id':image,'sourceCommit':known,'repoTags':[cache.REPOSITORY+':'+known+'-37819347936-1-'+role],
            'sizeBytesEstimate':size} for image,role,size in (
                ('sha256:ce5a6eae235159d475dc78e1c1cfee7f775a6f110d6efe9043d0bd578cb39380','admin',51560224),
                ('sha256:a01832a35a95075d810bd8cad61313ffc177a8bc2e8a1f3d272107bc86321823','api',381783671))]
        allowed,_=cache.cache_filter_inventory(binding,inventory,set());self.assertEqual(allowed,inventory)
        for payload in [s['parameters'] for s in bundle['stages']]+[bundle['execute']]:
            self.assertLess(len(cache.cache_canonical(payload)),20480)

    def test_more_than_128_priority_sources_or_oversize_full_history_are_refused(self):
        sources=[f'{n:040x}' for n in range(1,130)]
        ancestry=[cache.CACHE_BASELINE,*sources];counter=0
        def git(args,**kwargs):
            nonlocal counter
            if args[:2]==['git','show'] and ':deploy/aws/cache-cleanup-' in args[2]:
                start=counter*17;counter+=1
                return SimpleNamespace(returncode=0,stdout=cache.cache_canonical({'items':[
                    {'tag':commit+'-1-1-api'} for commit in sources[start:start+17]]}))
            return self.history_git(ancestry)(args,**kwargs)
        with patch.object(cache.subprocess,'run',side_effect=git):
            with self.assertRaises(cache.CacheRejected):cache.parameters(self.producer,source=self.project)
        def huge_history(args,**kwargs):
            if args[:2]==['git','rev-list']:return SimpleNamespace(returncode=0,stdout=b'x'*65536)
            return self.parameter_git(args,**kwargs)
        with patch.object(cache.subprocess,'run',side_effect=huge_history):
            with self.assertRaises(cache.CacheRejected):cache.parameters(self.producer,source=self.project)

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
        for name in ('historical_online_cold_dependencies','failed_online_recovery_dependencies','observed_h_recovery_dependencies','generic_cache_closed'):
            self.assertEqual(original_ast(original,name),original_ast(frame['program'],name))
        for name in ('HISTORICAL_ONLINE_COLD_DEPENDENCIES','HISTORICAL_ONLINE_COLD_POLICY_SHA256','FAILED_ONLINE_RECOVERY_DEPENDENCY',
                'H_RECOVERY_DEPENDENCIES','H_RECOVERY_DEPENDENCIES_SHA256'):
            self.assertEqual(getattr(cache,name),
                next(ast.literal_eval(n.value) for n in ast.parse(frame['program']).body if isinstance(n,ast.Assign)
                    and any(isinstance(t,ast.Name) and t.id==name for t in n.targets)))
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
        raw=subprocess.check_output(['git','show','272ecffba15502ccec0effbef5ed2dee35336462:scripts/production-release/maintain-image-cache.py'],cwd=self.project).decode()
        current=(DIRECTORY/'maintain-image-cache.py').read_text()
        original={n.name:ast.dump(n,include_attributes=False) for n in ast.parse(raw).body if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
        # Project away exactly four authorized diagnostic additions, preserving
        # the prior AST assertion for every original callable, including inputs.
        counts={'metadata':0,'fields':0,'validator':0,'capture':0}
        owner=self
        class PriorDiagnostics(ast.NodeTransformer):
            function=None
            def visit_FunctionDef(unused,node):
                before=unused.function;unused.function=node.name
                value=unused.generic_visit(node);unused.function=before;return value
            def visit_Dict(unused,node):
                for index,key in enumerate(node.keys):
                    if isinstance(key,ast.Constant) and key.value=='excludedSources':
                        owner.assertEqual(unused.function,'cache_plan')
                        owner.assertEqual(ast.dump(node.values[index],include_attributes=False),
                            ast.dump(ast.parse('cache_source_diagnostics(binding,inventory,protected)',mode='eval').body,include_attributes=False))
                        del node.keys[index];del node.values[index];counts['metadata']+=1;break
                return unused.generic_visit(node)
            def visit_Set(unused,node):
                before=len(node.elts);node.elts=[value for value in node.elts
                    if not isinstance(value,ast.Constant) or value.value!='excludedSources']
                if before!=len(node.elts):owner.assertEqual(unused.function,'validate_result')
                counts['fields']+=before-len(node.elts);return unused.generic_visit(node)
            def visit_Expr(unused,node):
                if isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Name) and node.value.func.id=='cache_validate_source_diagnostics':
                    owner.assertEqual(unused.function,'validate_result')
                    owner.assertEqual(ast.dump(node.value,include_attributes=False),
                        ast.dump(ast.parse('cache_validate_source_diagnostics(plan,binding)',mode='eval').body,include_attributes=False))
                    counts['validator']+=1;return None
                return unused.generic_visit(node)
            def visit_Tuple(unused,node):
                before=len(node.elts);node.elts=[value for value in node.elts
                    if not isinstance(value,ast.Constant) or value.value!='cache_source_diagnostics']
                if before!=len(node.elts):owner.assertEqual(unused.function,'parameters')
                counts['capture']+=before-len(node.elts);return unused.generic_visit(node)
        tree=PriorDiagnostics().visit(ast.parse(current))
        self.assertEqual(counts,dict.fromkeys(counts,1))
        # Project away only the reviewed permanent cold-dependency additions.
        # The existing collector and transport must otherwise retain their AST.
        collector=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='collect_dependencies')
        addition=ast.parse('images |= historical_online_cold_dependencies(directory, observed, evidence)').body[0]
        matches=[n for n in collector.body if ast.dump(n,include_attributes=False)==ast.dump(addition,include_attributes=False)]
        self.assertEqual(len(matches),1);collector.body.remove(matches[0])
        addition=ast.parse('images |= observed_h_recovery_dependencies(prior_directory, previous, evidence)').body[0]
        matches=[n for n in collector.body if ast.dump(n,include_attributes=False)==ast.dump(addition,include_attributes=False)]
        self.assertEqual(len(matches),1);collector.body.remove(matches[0])
        addition=ast.parse('images |= observed_h_recovery_dependencies(directory, observed, evidence)').body[0]
        matches=[n for n in collector.body if ast.dump(n,include_attributes=False)==ast.dump(addition,include_attributes=False)]
        self.assertEqual(len(matches),1);collector.body.remove(matches[0])
        constructor=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='parameters')
        projected=set()
        for node in constructor.body:
            if not isinstance(node,ast.Assign) or len(node.targets)!=1 or not isinstance(node.targets[0],ast.Name):continue
            name=node.targets[0].id
            if name=='header':
                self.assertEqual(node.value.value,'import ast,base64,fcntl,hashlib,json,os,re,shutil,stat,subprocess,time,types\nfrom pathlib import Path\n')
                node.value.value=node.value.value.replace('ast,base64,','ast,');projected.add(name)
            elif name in ('constants','old_names'):
                added=('HISTORICAL_REPOSITORY','FAILED_ONLINE_RECOVERY_DEPENDENCY','HISTORICAL_ONLINE_COLD_DEPENDENCIES','HISTORICAL_ONLINE_COLD_POLICY_SHA256',
                    'H_RECOVERY_DEPENDENCIES','H_RECOVERY_DEPENDENCIES_SHA256') \
                    if name=='constants' else ('historical_online_cold_dependencies','failed_online_recovery_dependencies','observed_h_recovery_dependencies','generic_cache_closed')
                self.assertEqual([value.value for value in node.value.elts if value.value in added],list(added))
                node.value.elts=[value for value in node.value.elts if value.value not in added];projected.add(name)
        self.assertEqual(projected,{'header','constants','old_names'})
        revised={n.name:ast.dump(n,include_attributes=False) for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
        # Freeze the exact reviewed source bytes, then parse both witnesses with
        # this interpreter: AST fields such as Python 3.12's empty type_params
        # must match exactly, without a version-dependent ast.dump digest.
        # This exact blob remains reachable from main after its required linear
        # merge and temporary-branch cleanup; a temporary commit need not survive.
        capacity_source = subprocess.check_output(['git', 'cat-file', 'blob',
            'a18f8f39541d4117a701ac8d1e4ad7b63e39b39b'], cwd=self.project)
        self.assertEqual(__import__('hashlib').sha256(capacity_source).hexdigest(),
            '5bfa7a087d8d59400064402e2596ee481eb445a8374ac30546a00a01e9e8bf3f')
        capacity_asts = {n.name: ast.dump(n, include_attributes=False) for n in ast.parse(capacity_source).body
            if isinstance(n, (ast.FunctionDef, ast.ClassDef))}
        for name in ('collect_dependencies', 'make_plan', 'apply_plan', 'maintain'):
            self.assertEqual(revised[name], capacity_asts[name], name)
            revised[name] = original[name]
        self.assertTrue(all(revised[name]==value for name,value in original.items()))
        ordinary={n.name:ast.dump(n,include_attributes=False) for n in ast.parse(raw.split('# Independent fixed-bootstrap plan/apply transport.',1)[0]).body if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
        ordinary['main']=original['main']
        self.assertEqual(len(ordinary),24);self.assertTrue(all(revised[name]==value for name,value in ordinary.items()))


class GenericCacheTransportTests(unittest.TestCase):
    def constructor(self):
        workflow=(DIRECTORY.parents[1]/'.github/workflows/production-release.yml').read_text()
        block=workflow.split('      - name: Verify or maintain recoverable unused project image cache\n',1)[1]
        return '\n'.join(line[10:] for line in block.split("          python3 - <<'PY'\n",1)[1].split('\n          PY\n',1)[0].splitlines())

    @contextlib.contextmanager
    def build(self, operation='verify_unused_cache', digest='d'*64, source=None):
        import os
        root=DIRECTORY.parents[1];runtime=root/'.runtime/central-capacity-control-20261012'
        runtime.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=runtime) as folder:
            directory=Path(folder);program=directory/'scripts/production-release/maintain-image-cache.py'
            program.parent.mkdir(parents=True);program.write_bytes(source if source is not None else (DIRECTORY/'maintain-image-cache.py').read_bytes())
            legacy=directory/'deploy/aws/cache-cleanup-unused-legacy-20261003.json'
            legacy.parent.mkdir(parents=True);legacy.write_bytes((root/'deploy/aws/cache-cleanup-unused-legacy-20261003.json').read_bytes())
            (directory/'.deploy/production-release').mkdir(parents=True)
            previous=Path.cwd()
            try:
                os.chdir(directory)
                with patch.dict(os.environ,{'CACHE_OPERATION':operation,'CACHE_PLAN_SHA256':digest,
                        'EXPECTED_CURRENT':'a'*40,'RELEASE_COMMIT':'b'*40,'GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'2'}):
                    exec(compile(self.constructor(),'<actual-cache-workflow>','exec'),{})
                parameters=json.loads((directory/'.deploy/production-release/unused-image-cache.json').read_bytes())
                yield parameters,program.read_bytes()
            finally:os.chdir(previous)

    def decode(self, parameters, mutate=None):
        import shlex
        args=shlex.split(parameters['commands'][0]);self.assertEqual(args[:2],['python3','-c'])
        captured=[];program=args[2] if mutate is None else mutate(args[2])
        exec(compile(program,'<actual-cache-decoder>','exec'),{'compile':lambda raw,*unused:raw,
            'exec':lambda raw:captured.append(raw)})
        self.assertEqual(len(captured),1)
        return captured[0],args[3:]

    def test_actual_source_roundtrip_and_all_original_operation_arguments_fit_safe_bound(self):
        for operation in ('verify_unused_cache','cleanup_unused_cache','verify_unused_builder_cache',
                'cleanup_unused_builder_cache','verify_unused_legacy_cache','cleanup_unused_legacy_cache','release'):
            with self.subTest(operation=operation),self.build(operation) as (parameters,source):
                raw,args=self.decode(parameters);self.assertEqual(raw,source)
                self.assertEqual(parameters['executionTimeout'],['1200'])
                self.assertLessEqual(len(json.dumps(parameters).encode()),60*1024)
                self.assertEqual(args[:2],['--expected-current',('b' if operation=='release' else 'a')*40])
                self.assertEqual('--apply' in args,operation.startswith('cleanup_') or operation=='release')
                self.assertEqual('--legacy-builder-cache' in args,'builder' in operation)
                self.assertEqual('--legacy-plan-json' in args,'legacy_cache' in operation)
                if operation.startswith('cleanup_'):
                    self.assertEqual(args[-2:],['--approved-plan-sha256','d'*64])
                if operation=='release':self.assertEqual(args[-2:],['--deployment-run','github-actions-123-2'])

    def test_wrong_hash_size_truncated_or_trailing_source_never_executes(self):
        import base64,hashlib,lzma
        with self.build() as (parameters,source):
            original=base64.b64encode(lzma.compress(source,preset=6)).decode()
            for replacement in (base64.b64encode(lzma.compress(source,preset=6)[:-4]).decode(),
                    base64.b64encode(lzma.compress(source,preset=6)+lzma.compress(b'bad')).decode()):
                with self.subTest(case='payload'),self.assertRaises((SystemExit,ValueError,lzma.LZMAError)):
                    self.decode(parameters,lambda text:text.replace(repr(original),repr(replacement),1))
            for mutate in (lambda text:text.replace(hashlib.sha256(source).hexdigest(),'0'*64,1),
                    lambda text:text.replace('len(source)!='+str(len(source)),'len(source)!='+str(len(source)+1),1)):
                with self.subTest(case='binding'),self.assertRaises(SystemExit):self.decode(parameters,mutate)

    def test_invalid_approval_and_excessive_or_empty_source_never_generate_parameters(self):
        for source in (b'',b'x'*(2*1024*1024+1)):
            with self.subTest(size=len(source)),self.assertRaises(SystemExit):
                with self.build(source=source):pass
        with self.assertRaises(SystemExit):
            with self.build('cleanup_unused_cache',digest='invalid'):pass


class CompleteGenericCacheEvidenceTests(unittest.TestCase):
    def large_result(self):
        import hashlib
        identity=lambda value:hashlib.sha256(str(value).encode()).hexdigest()
        dependencies={'version':1,'imageIds':['sha256:'+identity('dependency')],
            'serviceRollback':{'api':{'status':'RETAINED','commit':'c'*40,'imageId':'sha256:'+identity('dependency')}},
            'evidenceSha256':{'releases/20261001T000000Z-'+identity(i)[:12]+'/release-manifest.json':identity('metadata'+str(i)) for i in range(100)}}
        inventory=[{'id':'sha256:'+identity('image'+str(i)),
            'repoTags':[cache.REPOSITORY+':'+identity('source'+str(i))[:40]+'-123-1-api']} for i in range(60)]
        plan=cache.make_plan('a'*40,{'commit':'b'*40},{'sha256:'+identity('protected')},inventory,dependencies)
        return {'mode':'PLAN_ONLY','policy':cache.POLICY,'currentCommit':'a'*40,'planSha256':cache.plan_digest(plan),
            'candidateCount':len(plan['items']),'removed':[],'freeBytesBefore':100,'freeBytesAfter':100,'plan':plan}

    def test_complete_plan_over_old_18k_limit_preserves_every_item_dependency_and_canonical_sha(self):
        value=self.large_result();self.assertGreater(len(json.dumps(value['plan']).encode()),18000)
        output=cache.generic_cache_result_output(value)
        self.assertLessEqual(len(output.encode()),23500)
        decoded=cache.generic_cache_result_readback(output)
        self.assertEqual(decoded,value)
        self.assertEqual(decoded['planSha256'],cache.plan_digest(decoded['plan']))
        self.assertEqual(len(decoded['plan']['dependencies']['evidenceSha256']),100)
        self.assertEqual(len(decoded['plan']['items']),60)

    def test_every_reachable_partial_prefix_has_fixed_compressed_plan_and_bounded_metadata(self):
        import copy
        value=self.large_result();payload=json.loads(cache.generic_cache_result_output(value))['payload']
        for count in range(len(value['plan']['items'])+1):
            for phase in ('VERIFY_ALL_REMOTE','CHECK_CURRENT','CHECK_DEPENDENCIES','CHECK_PROTECTED','CHECK_LOCAL',
                          'VERIFY_ITEM_REMOTE','REMOVE_ITEM','ITEM_REMOVED','FINALIZE'):
                current=(value['plan']['items'][count] if count<len(value['plan']['items']) else None)
                state='ATTEMPTED_RESULT_UNCONFIRMED' if phase=='REMOVE_ITEM' else 'NOT_ATTEMPTED'
                if phase=='ITEM_REMOVED':
                    if count==0:continue
                    current=value['plan']['items'][count-1];state='REMOVED'
                if phase in ('VERIFY_ALL_REMOTE','FINALIZE'):current=None
                result=copy.deepcopy(value);result.update(mode='FAILED',errorType='CACHE_RETENTION_CONTROL_FAILURE',
                    removed=[item['tag'] for item in value['plan']['items'][:count]],freeBytesAfter=2**63-1,
                    progressReceiptPersisted=False,failureReceiptPersisted=False,
                    applyState={'phase':phase,'mutationAttempted':bool(count) or phase=='REMOVE_ITEM',
                        'currentItem':{**current,'state':state} if current is not None else None,'removedCount':count})
                output=cache.generic_cache_result_output(result)
                self.assertLessEqual(len(output.encode()),23500)
                self.assertEqual(json.loads(output)['payload'],payload)
                self.assertEqual(cache.generic_cache_result_readback(output),result)

    def test_bad_digest_size_truncation_tail_duplicate_or_plan_drift_rejects_complete_envelope(self):
        import base64,copy,lzma
        envelope=json.loads(cache.generic_cache_result_output(self.large_result()))
        for kind in ('hash','size','bool-size','truncated','tail','extra','plan-drift'):
            value=copy.deepcopy(envelope)
            if kind=='hash':value['uncompressedSha256']='0'*64
            elif kind=='size':value['uncompressedBytes']=cache.GENERIC_CACHE_RESULT_LIMIT+1
            elif kind=='bool-size':value['uncompressedBytes']=True
            elif kind=='truncated':value['payload']=base64.b64encode(base64.b64decode(value['payload'])[:-4]).decode()
            elif kind=='tail':value['payload']=base64.b64encode(base64.b64decode(value['payload'])+lzma.compress(b'bad')).decode()
            elif kind=='extra':value['trusted']=True
            else:
                changed=self.large_result();changed['plan']['items'].pop()
                value=json.loads(cache.generic_cache_result_output(changed))
            with self.subTest(kind=kind),self.assertRaises(RuntimeError):cache.generic_cache_result_readback(json.dumps(value))
        with self.assertRaises(RuntimeError):cache.generic_cache_result_readback('{"mode":"PLAN_ONLY","mode":"APPLIED"}')

    def test_original_small_json_and_small_applied_without_plan_remain_readable(self):
        value=self.large_result();value['plan']['items']=[];value['plan']['dependencies']['evidenceSha256']={}
        value.update(candidateCount=0,planSha256=cache.plan_digest(value['plan']))
        output=cache.generic_cache_result_output(value);self.assertNotIn('payload',json.loads(output))
        self.assertEqual(cache.generic_cache_result_readback(output),value)
        value.update(mode='APPLIED');value.pop('plan')
        self.assertEqual(cache.generic_cache_result_readback(json.dumps(value)),value)

    def test_output_cannot_fit_refuses_before_apply_or_any_remote_mutation(self):
        import hashlib
        value=self.large_result()
        value['plan']['dependencies']['evidenceSha256']={hashlib.sha256(str(i).encode()).hexdigest():hashlib.sha256(('x'+str(i)).encode()).hexdigest() for i in range(500)}
        value['plan']['items']*=3;value.update(candidateCount=180,planSha256=cache.plan_digest(value['plan']))
        with self.assertRaisesRegex(RuntimeError,'safe transport bound'):cache.generic_cache_result_output(value)
        fixture=RetentionTests();fixture.setUp()
        runtime=DIRECTORY.parents[1]/'.runtime/central-capacity-control-20261012';runtime.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=runtime) as directory,patch.object(cache,'BASE',Path(directory)), \
                patch.object(cache,'current',return_value=(fixture.manifest,fixture.previous)), \
                patch.object(cache,'collect_dependencies',return_value=value['plan']['dependencies']), \
                patch.object(cache,'active_images',return_value=set()),patch.object(cache,'read',return_value='') as command, \
                patch.object(cache,'make_plan',return_value=value['plan']),patch.object(cache,'apply_plan') as apply, \
                patch.object(cache,'verify_remote') as remote,patch.object(cache.shutil,'disk_usage',return_value=SimpleNamespace(free=100)):
            args=SimpleNamespace(expected_current=value['currentCommit'],apply=True,approved_policy=cache.POLICY,
                deployment_run=None,approved_plan_sha256=value['planSha256'])
            with self.assertRaisesRegex(RuntimeError,'safe transport bound'):cache.maintain(args)
            apply.assert_not_called();remote.assert_not_called()
            self.assertTrue(all(call.args[:3]!=('docker','image','rm') for call in command.call_args_list))
            self.assertFalse((Path(directory)/'maintenance').exists())

    def test_process_interruption_during_atomic_progress_update_keeps_last_complete_prefix_and_plan(self):
        fixture=RetentionTests();fixture.setUp();fixture.plan['protectedImageIds']=[]
        runtime=DIRECTORY.parents[1]/'.runtime/central-capacity-control-20261012';runtime.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=runtime) as directory:
            original_replace=cache.os.replace
            def replace(source,destination):
                value=json.loads(Path(source).read_bytes())
                if value['removed'] and value['applyState']['phase']=='CHECK_DEPENDENCIES':
                    previous=json.loads(Path(destination).read_bytes())
                    self.assertEqual(previous['plan'],fixture.plan);self.assertEqual(previous['removed'],[fixture.tags[0]])
                    self.assertEqual(previous['applyState']['phase'],'CHECK_CURRENT')
                    raise SystemExit(77)  # Emulate abrupt exit before replace, not an ordinary caught command failure.
                return original_replace(source,destination)
            def command(*args):
                if args[:3]==('docker','image','ls'):return ''
                return fixture.run_command(*args)
            args=SimpleNamespace(expected_current=fixture.expected,apply=True,approved_policy=cache.POLICY,
                deployment_run=None,approved_plan_sha256=cache.plan_digest(fixture.plan))
            with patch.object(cache,'BASE',Path(directory)),patch.object(cache,'current',return_value=(fixture.manifest,fixture.previous)), \
                    patch.object(cache,'collect_dependencies',return_value=fixture.dependencies),patch.object(cache,'active_images',return_value=set()), \
                    patch.object(cache,'make_plan',return_value=fixture.plan),patch.object(cache,'read',side_effect=command), \
                    patch.object(cache.shutil,'disk_usage',return_value=SimpleNamespace(free=100)),patch.object(cache.os,'replace',side_effect=replace), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                with self.assertRaises(SystemExit) as caught:cache.maintain(args)
            self.assertEqual(caught.exception.code,77);self.assertEqual(output.getvalue(),'')
            progress=list(Path(directory).rglob('*.progress.json'));self.assertEqual(len(progress),1)
            self.assertEqual(json.loads(progress[0].read_bytes())['removed'],[fixture.tags[0]])
            self.assertEqual(len(fixture.removals()),1)

    def test_finalize_disk_failure_keeps_all_removed_and_unknown_capacity_in_complete_receipt(self):
        fixture=RetentionTests();fixture.setUp();fixture.plan['protectedImageIds']=[]
        runtime=DIRECTORY.parents[1]/'.runtime/central-capacity-control-20261012';runtime.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=runtime) as directory:
            def command(*args):
                if args[:3]==('docker','image','ls'):return ''
                return fixture.run_command(*args)
            args=SimpleNamespace(expected_current=fixture.expected,apply=True,approved_policy=cache.POLICY,
                deployment_run=None,approved_plan_sha256=cache.plan_digest(fixture.plan))
            with patch.object(cache,'BASE',Path(directory)),patch.object(cache,'current',return_value=(fixture.manifest,fixture.previous)), \
                    patch.object(cache,'collect_dependencies',return_value=fixture.dependencies),patch.object(cache,'active_images',return_value=set()), \
                    patch.object(cache,'make_plan',return_value=fixture.plan),patch.object(cache,'read',side_effect=command), \
                    patch.object(cache.shutil,'disk_usage',side_effect=[SimpleNamespace(free=100),OSError('private'),OSError('private')]), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                with self.assertRaises(SystemExit):cache.maintain(args)
            value=cache.generic_cache_result_readback(output.getvalue());self.assertEqual(value['mode'],'FAILED')
            self.assertEqual(value['removed'],fixture.tags);self.assertIsNone(value['freeBytesAfter'])
            self.assertEqual(value['applyState']['phase'],'FINALIZE');self.assertIsNone(value['applyState']['currentItem'])
            self.assertEqual(value['plan'],fixture.plan);self.assertNotIn('private',output.getvalue())

    def test_real_successful_apply_exports_complete_exact_plan_progress_and_disk_result(self):
        fixture=RetentionTests();fixture.setUp();fixture.plan['protectedImageIds']=[]
        runtime=DIRECTORY.parents[1]/'.runtime/central-capacity-control-20261012';runtime.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=runtime) as directory:
            def command(*args):
                if args[:3]==('docker','image','ls'):return ''
                return fixture.run_command(*args)
            args=SimpleNamespace(expected_current=fixture.expected,apply=True,approved_policy=cache.POLICY,
                deployment_run=None,approved_plan_sha256=cache.plan_digest(fixture.plan))
            with patch.object(cache,'BASE',Path(directory)),patch.object(cache,'current',return_value=(fixture.manifest,fixture.previous)), \
                    patch.object(cache,'collect_dependencies',return_value=fixture.dependencies),patch.object(cache,'active_images',return_value=set()), \
                    patch.object(cache,'make_plan',return_value=fixture.plan),patch.object(cache,'read',side_effect=command), \
                    patch.object(cache.shutil,'disk_usage',side_effect=[SimpleNamespace(free=100),SimpleNamespace(free=200)]), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                cache.maintain(args)
            value=cache.generic_cache_result_readback(output.getvalue());self.assertEqual(value['mode'],'APPLIED')
            self.assertEqual(value['removed'],fixture.tags);self.assertEqual(value['plan'],fixture.plan)
            self.assertEqual(value['applyState'],{'phase':'COMPLETE','mutationAttempted':True,'currentItem':None,'removedCount':2})
            self.assertEqual(value['freeBytesAfter'],200)
            progress=list(Path(directory).rglob('*.progress.json'));self.assertEqual(json.loads(progress[0].read_bytes()),value)
            self.assertEqual(len(fixture.removals()),2)

    def test_failed_receipt_write_never_makes_last_progress_claim_an_unwritten_receipt(self):
        fixture=RetentionTests();fixture.setUp();fixture.plan['protectedImageIds']=[]
        runtime=DIRECTORY.parents[1]/'.runtime/central-capacity-control-20261012';runtime.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=runtime) as directory:
            original_open=Path.open
            def open_path(path,*args,**kwargs):
                if path.name.endswith('.failed.receipt.json'):raise PermissionError('private')
                return original_open(path,*args,**kwargs)
            def command(*args):
                if args[:3]==('docker','image','ls'):return ''
                if args[:3]==('docker','image','rm') and args[-1].endswith(fixture.tags[1]):raise RuntimeError('private')
                return fixture.run_command(*args)
            args=SimpleNamespace(expected_current=fixture.expected,apply=True,approved_policy=cache.POLICY,
                deployment_run=None,approved_plan_sha256=cache.plan_digest(fixture.plan))
            with patch.object(cache,'BASE',Path(directory)),patch.object(cache,'current',return_value=(fixture.manifest,fixture.previous)), \
                    patch.object(cache,'collect_dependencies',return_value=fixture.dependencies),patch.object(cache,'active_images',return_value=set()), \
                    patch.object(cache,'make_plan',return_value=fixture.plan),patch.object(cache,'read',side_effect=command), \
                    patch.object(cache.shutil,'disk_usage',return_value=SimpleNamespace(free=100)),patch.object(Path,'open',open_path), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                with self.assertRaises(SystemExit):cache.maintain(args)
            value=cache.generic_cache_result_readback(output.getvalue());self.assertIs(value['failureReceiptPersisted'],False)
            progress=list(Path(directory).rglob('*.progress.json'));self.assertEqual(json.loads(progress[0].read_bytes()),value)
            self.assertEqual(value['removed'],[fixture.tags[0]]);self.assertEqual(len(fixture.removals()),1)
            self.assertFalse(list(Path(directory).rglob('*.failed.receipt.json')))
            self.assertNotIn('private',output.getvalue())

    def test_partial_delete_failure_keeps_complete_plan_exact_removed_and_unknown_attempt_receipt(self):
        fixture=RetentionTests();fixture.setUp();fixture.plan['protectedImageIds']=[]
        runtime=DIRECTORY.parents[1]/'.runtime/central-capacity-control-20261012';runtime.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=runtime) as directory:
            def command(*args):
                if args[:3]==('docker','image','ls'):return ''
                if args[:3]==('docker','image','rm') and args[-1].endswith(fixture.plan['items'][1]['tag']):
                    raise RuntimeError('SYNTHETIC_PRIVATE_STDERR')
                return fixture.run_command(*args)
            args=SimpleNamespace(expected_current=fixture.expected,apply=True,approved_policy=cache.POLICY,
                deployment_run=None,approved_plan_sha256=cache.plan_digest(fixture.plan))
            with patch.object(cache,'BASE',Path(directory)),patch.object(cache,'current',return_value=(fixture.manifest,fixture.previous)), \
                    patch.object(cache,'collect_dependencies',return_value=fixture.dependencies),patch.object(cache,'active_images',return_value=set()), \
                    patch.object(cache,'make_plan',return_value=fixture.plan),patch.object(cache,'read',side_effect=command), \
                    patch.object(cache.shutil,'disk_usage',return_value=SimpleNamespace(free=100)),contextlib.redirect_stdout(io.StringIO()) as output:
                with self.assertRaises(SystemExit) as caught:cache.maintain(args)
            self.assertEqual(caught.exception.code,1)
            value=cache.generic_cache_result_readback(output.getvalue())
            self.assertEqual(value['mode'],'FAILED');self.assertEqual(value['plan'],fixture.plan)
            self.assertEqual(value['planSha256'],cache.plan_digest(fixture.plan))
            self.assertEqual(value['removed'],[fixture.plan['items'][0]['tag']])
            self.assertEqual(value['applyState']['phase'],'REMOVE_ITEM')
            self.assertEqual(value['applyState']['currentItem'],{**fixture.plan['items'][1],'state':'ATTEMPTED_RESULT_UNCONFIRMED'})
            self.assertNotIn('SYNTHETIC_PRIVATE',output.getvalue())
            receipts=list(Path(directory).rglob('*.failed.receipt.json'));self.assertEqual(len(receipts),1)
            self.assertEqual(json.loads(receipts[0].read_text()),value)
            progress=list(Path(directory).rglob('*.progress.json'));self.assertEqual(len(progress),1)
            self.assertEqual(json.loads(progress[0].read_text()),value)


class FailedOnlineRecoveryDependencyTests(unittest.TestCase):
    def setUp(self):
        import base64, copy, hashlib
        self.policy=copy.deepcopy(cache.FAILED_ONLINE_RECOVERY_DEPENDENCY)
        self.native=json.loads(base64.b64decode(self.policy['nativeInvocationBase64']))
        self.proof=json.loads(base64.b64decode(self.policy['buildProofBase64']))
        self.failure=(json.dumps(json.loads(self.native['StandardOutputContent']),indent=2)+'\n').encode()
        self.assertEqual(hashlib.sha256(self.failure).hexdigest(),'a1174623f13b3801b8fbea6b03387b03531f8164755a34fb785561006193d160')
        runtime=DIRECTORY.parents[1]/'.runtime/central-capacity-control-20261012';runtime.mkdir(parents=True,exist_ok=True)
        temporary=tempfile.TemporaryDirectory(dir=runtime);self.addCleanup(temporary.cleanup)
        self.base=Path(temporary.name).resolve()
        patcher=patch.object(cache,'BASE',self.base);patcher.start();self.addCleanup(patcher.stop)
        self.target=self.base/'releases/20261011T174625Z-08419dcbe852';self.target.mkdir(parents=True)
        self.old=self.base/'releases/20261011T132910Z-31d2c6885a45';self.old.mkdir()
        (self.base/'current').symlink_to(self.old)
        self.old_compose={'services':{'api':{'image':'original-api','pull_policy':'never'},'mysql':{'image':'mysql:8.4'}}}
        (self.old/'compose.release.json').write_text(json.dumps(self.old_compose))
        self.compose=copy.deepcopy(self.old_compose)
        self.compose['services'].update({name:{'image':image['reference'],'pull_policy':'never'} for name,image in self.proof['images'].items()})
        (self.target/'compose.release.json').write_text(json.dumps(self.compose))
        (self.target/'online-recharge-failure.json').write_bytes(self.failure)
        # A synthetic complete compose fixture is explicit; it grants no production qualification.
        self.policy['composeSha256']=hashlib.sha256((self.target/'compose.release.json').read_bytes()).hexdigest()
        self.commands=[]
    def command(self,*args):
        self.commands.append(args)
        self.assertEqual(args[:5],('docker','image','inspect','--format','{{.Id}}'))
        return next(image['imageId'] for image in self.proof['images'].values() if image['reference']==args[-1])
    def collect(self):
        evidence={}
        with patch.object(cache,'FAILED_ONLINE_RECOVERY_DEPENDENCY',self.policy),patch.object(cache,'read',side_effect=self.command):
            images=cache.failed_online_recovery_dependencies(evidence)
        return images,evidence
    def test_exact_official_four_images_protected_with_complete_unchanged_failure_and_original_compose(self):
        import hashlib
        images,evidence=self.collect()
        self.assertEqual(images,{image['imageId'] for image in self.proof['images'].values()})
        self.assertEqual(len(images),4);self.assertEqual(len(self.commands),4)
        self.assertEqual(evidence[str((self.target/'online-recharge-failure.json').relative_to(self.base))],hashlib.sha256(self.failure).hexdigest())
        self.assertEqual(evidence[str((self.target/'compose.release.json').relative_to(self.base))],self.policy['composeSha256'])
        inventory=[{'id':image['imageId'],'repoTags':[image['reference']]} for image in self.proof['images'].values()]
        self.assertEqual(cache.make_plan('a'*40,{'commit':'b'*40},images,inventory,{'version':1,'imageIds':sorted(images),'serviceRollback':{},'evidenceSha256':evidence})['items'],[])
    def test_missing_policy_wrong_native_proof_compose_failure_or_claim_rejects_before_docker(self):
        import base64,copy
        original=copy.deepcopy(self.policy)
        for kind in ('none','native','proof','compose','failure','claim','version-bool','wrong-old'):
            self.policy=copy.deepcopy(original)
            (self.target/'online-recharge-failure.json').write_bytes(self.failure)
            (self.old/'compose.release.json').write_text(json.dumps(self.old_compose))
            if kind=='none':self.policy=None
            elif kind=='native':self.policy['nativeInvocationBase64']=base64.b64encode(b'{}').decode()
            elif kind=='proof':self.policy['buildProofBase64']=base64.b64encode(b'{}').decode()
            elif kind=='compose':self.policy['composeSha256']='0'*64
            elif kind=='failure':(self.target/'online-recharge-failure.json').write_bytes(self.failure+b'\n')
            elif kind=='claim':self.policy['imageIds']=['sha256:'+'f'*64]
            elif kind=='version-bool':self.policy['version']=True
            elif kind=='wrong-old':(self.old/'compose.release.json').write_text(json.dumps({'services':{}}))
            with self.subTest(kind=kind),self.assertRaises(RuntimeError):self.collect()
            self.assertEqual(self.commands,[])
    def test_absent_exact_target_does_not_require_policy_or_block_unaffected_metadata(self):
        (self.target/'online-recharge-failure.json').unlink();(self.target/'compose.release.json').unlink();self.target.rmdir()
        with self.assertRaisesRegex(RuntimeError,'Declared failed ONLINE recovery evidence unavailable'):self.collect()
        self.policy=None
        self.assertEqual(self.collect(),(set(),{}));self.assertEqual(self.commands,[])
        fixture=DependencyRetentionTests();fixture.setUp();self.addCleanup(fixture.doCleanups)
        with patch.object(cache,'failed_online_recovery_dependencies',side_effect=AssertionError('wrong baseline')):
            result=fixture.collect()
        self.assertEqual(set(result['imageIds']),{fixture.ids[1],fixture.ids[3]})
    def test_missing_or_changed_local_pending_image_rejects_without_mutation(self):
        with patch.object(cache,'FAILED_ONLINE_RECOVERY_DEPENDENCY',self.policy),patch.object(cache,'read',return_value='sha256:'+'f'*64) as command:
            with self.assertRaisesRegex(RuntimeError,'Required failed ONLINE recovery image'):cache.failed_online_recovery_dependencies({})
        self.assertEqual(command.call_count,1)
    def test_pending_compose_drift_blocks_before_first_delete_even_with_unchanged_containers(self):
        fixture=RetentionTests();fixture.setUp()
        fixture.dependencies['evidenceSha256']={'releases/20261011T174625Z-08419dcbe852/compose.release.json':self.policy['composeSha256']}
        fixture.plan=cache.make_plan(fixture.expected,fixture.previous,{'live'},fixture.inventory,fixture.dependencies)
        drift=json.loads(json.dumps(fixture.dependencies));drift['evidenceSha256'][next(iter(drift['evidenceSha256']))]='f'*64
        with patch.object(cache,'current',return_value=(fixture.manifest,fixture.previous)),patch.object(cache,'active_images',return_value=set()), \
                patch.object(cache,'collect_dependencies',return_value=drift),patch.object(cache,'read',side_effect=fixture.run_command):
            with self.assertRaisesRegex(RuntimeError,'Reviewed image dependencies changed'):cache.apply_plan(fixture.plan)
        self.assertEqual(fixture.removals(),[])


class HistoricalOnlineColdDependencyTests(unittest.TestCase):
    def setUp(self):
        import copy
        runtime=DIRECTORY.parents[1]/'.runtime/central-online-fixed-release-20261012/pre-switch-review'
        runtime.mkdir(parents=True,exist_ok=True)
        temporary=tempfile.TemporaryDirectory(dir=runtime);self.addCleanup(temporary.cleanup)
        self.base=Path(temporary.name).resolve()
        patcher=patch.object(cache,'BASE',self.base);patcher.start();self.addCleanup(patcher.stop)
        self.images=copy.deepcopy(cache.HISTORICAL_ONLINE_COLD_DEPENDENCIES)
        self.workspace=self.base/'releases/20261009T103426Z-0a03fa28e6b8'
        origin_rows={image['service']:{'reference':cache.HISTORICAL_REPOSITORY+':'+tag,'digest':image['imageId']}
            for tag,image in self.images.items() if tag.startswith('0a03')}
        self.origin={'commit':'0a03fa28e6b844a18833d5c63f1de700f091fc64',
            'sourceTree':'668ca1570a8e4898e7f473198087ec549c270239','images':origin_rows}
        self.proof={**self.origin,'images':{name:{'reference':row['reference'],'imageId':row['digest']}
            for name,row in origin_rows.items()}}
        self.write(self.workspace/'release-manifest.json',self.origin)
        self.write(self.workspace/'api-workspace-build-proof.json',self.proof)
        self.previous_directory=self.base/'releases/20261011T000000Z-111111111111'
        self.previous={'commit':'1'*40,'sourceTree':'2'*40,'images':{'api':{'digest':'sha256:'+'3'*64}}}
        self.write(self.previous_directory/'release-manifest.json',self.previous)
        # Only metadata is synthetic: the eight immutable tag/digest/source rows
        # and both failed-attempt build proofs remain the original fixed values.
        self.policy=json.loads((DIRECTORY/'online-recharge-recovery.json').read_text())
        self.policy['preflight']['manifestSha256']=cache.plan_digest(self.origin)
        self.policy['preflight']['workspaceBuildProofSha256']=cache.plan_digest(self.proof)
        patcher=patch.object(cache,'HISTORICAL_ONLINE_COLD_POLICY_SHA256',cache.plan_digest(self.policy))
        patcher.start();self.addCleanup(patcher.stop)
        self.current('31d2c6885a45817cd40d23fce8d6145bc9f18af2')
        self.commands=[]
        failed=patch.object(cache,'failed_online_recovery_dependencies',return_value=set())
        self.failed=failed.start();self.addCleanup(failed.stop)

    def write(self,path,value):
        path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value))

    def current(self,commit,**markers):
        self.directory=self.base/('releases/20261012T000000Z-'+commit[:12])
        self.manifest={'commit':commit,'sourceTree':'4'*40,'previousCommit':self.previous['commit'],
            'previousRelease':str(self.previous_directory),'images':{'api':{'digest':'sha256:'+'5'*64}},**markers}
        self.write(self.directory/'release-manifest.json',self.manifest)
        self.policy_path=self.directory/'scripts/production-release/online-recharge-recovery.json'
        self.write(self.policy_path,self.policy)
        current=self.base/'current'
        if current.is_symlink():current.unlink()
        current.symlink_to(self.directory)

    def command(self,*args):
        self.commands.append(args)
        self.assertEqual(args[:5],('docker','image','inspect','--format','{{.Id}}'))
        value=args[-1]
        if value.startswith(cache.HISTORICAL_REPOSITORY+':'):
            return self.images[value[len(cache.HISTORICAL_REPOSITORY)+1:]]['imageId']
        return value

    def collect(self,command=None):
        with patch.object(cache,'read',side_effect=command or self.command):
            return cache.collect_dependencies(self.manifest,self.previous)

    def test_current31d_retains_only_exact_eight_cold_images_with_file_evidence(self):
        import hashlib
        result=self.collect();ids={row['imageId'] for row in self.images.values()}
        self.assertEqual(set(result['imageIds']),ids|{'sha256:'+'3'*64})
        self.assertEqual(len([c for c in self.commands if c[-1].startswith(cache.HISTORICAL_REPOSITORY+':')]),8)
        self.failed.assert_called_once()
        for path in (self.policy_path,self.workspace/'release-manifest.json',self.workspace/'api-workspace-build-proof.json'):
            self.assertEqual(result['evidenceSha256'][str(path.relative_to(self.base))],hashlib.sha256(path.read_bytes()).hexdigest())
        inventory=[{'id':row['imageId'],'repoTags':[cache.HISTORICAL_REPOSITORY+':'+tag]} for tag,row in self.images.items()]
        unrelated='f'*40+'-999-1-api';inventory.append({'id':'sha256:'+'6'*64,'repoTags':[cache.REPOSITORY+':'+unrelated]})
        plan=cache.make_plan(self.manifest['commit'],self.previous,set(result['imageIds']),inventory,result)
        self.assertEqual([row['tag'] for row in plan['items']],[unrelated])

    def test_online_and_preserving_api_successors_keep_original_cold_dependencies(self):
        markers=({'onlineRechargePublication':{'version':2,'scope':'ONLINE_RECHARGE'}},
            {'preservedOnlineRechargeOrigin':{'version':1,'commit':'a'*40,
                'manifestSha256':'b'*64,'buildProofSha256':'c'*64,'preservationSha256':'d'*64}})
        for marker in markers:
            with self.subTest(marker=next(iter(marker))):
                self.current('7'*40,**marker);self.commands.clear()
                self.assertEqual(set(self.collect()['imageIds']),{row['imageId'] for row in self.images.values()}|{'sha256:'+'3'*64})
        self.failed.assert_not_called()

    def test_unaffected_manifest_does_not_load_or_protect_historical_dependencies(self):
        self.current('7'*40);self.policy_path.unlink()
        result=self.collect();self.assertEqual(result['imageIds'],['sha256:'+'3'*64])
        self.assertFalse(any(c[-1].startswith(cache.HISTORICAL_REPOSITORY+':') for c in self.commands))
        self.failed.assert_not_called()

    def test_each_missing_or_changed_exact_tag_blocks_without_delete_or_pull(self):
        for tag in self.images:
            with self.subTest(tag=tag):
                self.commands.clear()
                def unavailable(*args):
                    value=self.command(*args)
                    return 'sha256:'+'f'*64 if args[-1]==cache.HISTORICAL_REPOSITORY+':'+tag else value
                with self.assertRaisesRegex(RuntimeError,'Required historical ONLINE cold dependency image is unavailable'):
                    self.collect(unavailable)
                self.assertTrue(self.commands)
                self.assertTrue(all(c[:3]==('docker','image','inspect') for c in self.commands))
                self.failed.assert_not_called()

    def test_changed_policy_workspace_manifest_or_proof_rejects_before_inspect(self):
        for path in (self.policy_path,self.workspace/'release-manifest.json',self.workspace/'api-workspace-build-proof.json'):
            with self.subTest(file=path.name):
                raw=path.read_bytes();row=json.loads(raw);row['sourceTree']='f'*40
                self.write(path,row)
                with self.assertRaisesRegex(RuntimeError,'Historical ONLINE .* changed'):self.collect()
                self.assertEqual(self.commands,[]);path.write_bytes(raw)

    def test_symlinked_dependency_evidence_rejects_before_inspect(self):
        original=self.workspace/'api-workspace-build-proof.json'
        other=self.workspace/'synthetic-other.json';original.rename(other);original.symlink_to(other)
        with self.assertRaisesRegex(RuntimeError,'Dependency evidence path is not a regular project file'):self.collect()
        self.assertEqual(self.commands,[])

    def test_duplicate_proof_or_policy_key_rejects_before_inspect(self):
        for path in (self.policy_path,self.workspace/'api-workspace-build-proof.json'):
            with self.subTest(file=path.name):
                raw=path.read_bytes();row=json.loads(raw);key=next(iter(row))
                path.write_text('{'+json.dumps(key)+':'+json.dumps(row[key])+','+raw.decode()[1:])
                with self.assertRaisesRegex(RuntimeError,'Duplicate cache evidence key'):self.collect()
                self.assertEqual(self.commands,[]);path.write_bytes(raw)

    def test_malformed_successor_marker_rejects_before_inspect(self):
        for marker in ({'onlineRechargePublication':{'version':True,'scope':'ONLINE_RECHARGE'}},
                {'onlineRechargePublication':{'version':2,'scope':'FOREIGN'}},
                {'preservedOnlineRechargeOrigin':{'version':1,'imageIds':['sha256:'+'f'*64]}}):
            with self.subTest(marker=marker):
                self.current('7'*40,**marker)
                with self.assertRaisesRegex(RuntimeError,'Historical ONLINE .* dependency changed'):self.collect()
                self.assertEqual(self.commands,[])

    def test_fixed_literal_and_proof_bindings_reject_arbitrary_tag_digest_or_source(self):
        import copy
        self.assertEqual(cache.plan_digest(cache.HISTORICAL_ONLINE_COLD_DEPENDENCIES),
            'df190b221061b96d107d2ab32f409bee2e0938000015b1e00beb6bcd92585d71')
        for name,value in (('imageId','sha256:'+'f'*64),('sourceCommit','f'*40),('sourceTree','f'*40),('service','foreign')):
            mapping=copy.deepcopy(self.images);tag=next(iter(mapping));mapping[tag][name]=value
            with self.subTest(field=name),patch.object(cache,'HISTORICAL_ONLINE_COLD_DEPENDENCIES',mapping):
                self.commands.clear()
                with self.assertRaisesRegex(RuntimeError,'Historical ONLINE dependency .* changed'):self.collect()
                self.assertEqual(self.commands,[])
        mapping=copy.deepcopy(self.images);row=mapping.pop(next(iter(mapping)));mapping['f'*40+'-1-1-admin']=row
        with patch.object(cache,'HISTORICAL_ONLINE_COLD_DEPENDENCIES',mapping),self.assertRaises(RuntimeError):self.collect()


class ObservedHRecoveryDependencyTests(unittest.TestCase):
    def setUp(self):
        import copy, hashlib
        runtime=DIRECTORY.parents[1]/'.runtime/cache-retention-tests';runtime.mkdir(parents=True,exist_ok=True)
        temporary=tempfile.TemporaryDirectory(dir=runtime);self.addCleanup(temporary.cleanup)
        self.base=Path(temporary.name).resolve()
        patcher=patch.object(cache,'BASE',self.base);patcher.start();self.addCleanup(patcher.stop)
        self.original_policy=copy.deepcopy(cache.H_RECOVERY_DEPENDENCIES)
        self.policy=copy.deepcopy(self.original_policy)
        self.images=self.policy['images']
        self.directory=self.base/self.policy['currentDirectory'];self.directory.mkdir(parents=True)
        self.previous_directory=self.base/'releases/20261011T000000Z-111111111111';self.previous_directory.mkdir()
        self.previous={'commit':'1'*40,'images':{'api':{'digest':'sha256:'+'2'*64}}}
        self.manifest={'commit':self.policy['currentCommit'],'previousCommit':self.previous['commit'],
            'previousRelease':str(self.previous_directory),'images':{'api':{'digest':'sha256:'+'3'*64}}}
        self.manifest_path=self.directory/'release-manifest.json'
        self.manifest_path.write_text(json.dumps(self.manifest))
        (self.previous_directory/'release-manifest.json').write_text(json.dumps(self.previous))
        (self.base/'current').symlink_to(self.directory)
        # The manifest is synthetic and explicitly unqualified. Only its file
        # SHA pin changes; all eight observed tag/ID identities stay immutable.
        self.policy['currentManifestSha256']=hashlib.sha256(self.manifest_path.read_bytes()).hexdigest()
        self.policy_sha=cache.plan_digest(self.policy)
        for name,value in (('H_RECOVERY_DEPENDENCIES',self.policy),('H_RECOVERY_DEPENDENCIES_SHA256',self.policy_sha)):
            patcher=patch.object(cache,name,value);patcher.start();self.addCleanup(patcher.stop)
        failed=patch.object(cache,'failed_online_recovery_dependencies',side_effect=AssertionError('B-only origin'))
        self.failed=failed.start();self.addCleanup(failed.stop)
        self.commands=[]

    def command(self,*args):
        self.commands.append(args)
        self.assertEqual(args[:5],('docker','image','inspect','--format','{{.Id}}'))
        reference=args[-1]
        return self.images[reference[len(cache.REPOSITORY)+1:]] if reference.startswith(cache.REPOSITORY+':') else reference

    def collect(self,command=None):
        with patch.object(cache,'read',side_effect=command or self.command):
            return cache.collect_dependencies(self.manifest,self.previous)

    def test_exact_h_keeps_all_eight_plus_existing_rollback_with_source_and_tag_evidence(self):
        import hashlib
        result=self.collect()
        self.assertEqual(set(result['imageIds']),set(self.images.values())|{'sha256:'+'2'*64})
        self.assertEqual(result['evidenceSha256']['literal/H_RECOVERY_DEPENDENCIES'],self.policy_sha)
        self.assertEqual(result['evidenceSha256'][str(self.manifest_path.relative_to(self.base))],self.policy['currentManifestSha256'])
        for tag,image in self.images.items():
            self.assertEqual(result['evidenceSha256']['docker-image-inspect/'+tag],hashlib.sha256(image.encode()).hexdigest())
        self.assertEqual(len([command for command in self.commands if command[-1].startswith(cache.REPOSITORY+':')]),8)
        self.failed.assert_not_called()
        protected=cache.protected_images(self.manifest,self.previous,{'sha256:'+'4'*64},result)
        self.assertTrue(set(self.images.values())|{'sha256:'+'2'*64,'sha256:'+'3'*64,'sha256:'+'4'*64}<=protected)
        inventory=[{'id':image,'repoTags':[cache.REPOSITORY+':'+tag]} for tag,image in self.images.items()]
        eligible='f'*40+'-999-1-api'
        inventory.append({'id':'sha256:'+'5'*64,'repoTags':[cache.REPOSITORY+':'+eligible]})
        plan=cache.make_plan(self.manifest['commit'],self.previous,protected,inventory,result)
        self.assertEqual(plan['items'],[{'tag':eligible,'imageId':'sha256:'+'5'*64}])
        self.assertEqual(plan['policy'],cache.POLICY)

    def test_each_missing_or_mismatched_exact_tag_rejects_without_pull_or_delete(self):
        for tag in self.images:
            for absent in (False,True):
                with self.subTest(tag=tag,absent=absent):
                    self.commands.clear()
                    def unavailable(*args):
                        value=self.command(*args)
                        if args[-1]==cache.REPOSITORY+':'+tag:
                            if absent:raise RuntimeError('Cache command failed; raw output suppressed')
                            return 'sha256:'+'f'*64
                        return value
                    with self.assertRaises(RuntimeError):self.collect(unavailable)
                    self.assertTrue(self.commands)
                    self.assertTrue(all(command[:3]==('docker','image','inspect') for command in self.commands))
                    self.failed.assert_not_called()

    def test_same_h_path_changed_manifest_or_commit_rejects_before_docker(self):
        raw=self.manifest_path.read_bytes()
        self.manifest_path.write_bytes(raw+b'\n')
        with self.assertRaisesRegex(RuntimeError,'Observed H recovery baseline changed'):self.collect()
        self.assertEqual(self.commands,[])
        self.manifest['commit']='6'*40;self.manifest_path.write_text(json.dumps(self.manifest))
        with self.assertRaises(RuntimeError):self.collect()
        self.assertEqual(self.commands,[])

    def test_missing_manifest_and_symlinked_manifest_reject_before_docker(self):
        self.manifest_path.unlink()
        with self.assertRaises(FileNotFoundError):self.collect()
        alternate=self.directory/'synthetic-other.json';alternate.write_text(json.dumps(self.manifest))
        self.manifest_path.symlink_to(alternate)
        with self.assertRaisesRegex(RuntimeError,'Dependency evidence path is not a regular project file'):self.collect()
        self.assertEqual(self.commands,[])

    def test_unknown_missing_changed_reference_or_digest_rejects_source_pin_before_docker(self):
        import copy
        for kind in ('extra','missing','tag','id','current','qualification'):
            changed=copy.deepcopy(self.policy);tag=next(iter(changed['images']))
            if kind=='extra':changed['images']['f'*40+'-1-1-api']='sha256:'+'f'*64
            elif kind=='missing':changed['images'].pop(tag)
            elif kind=='tag':changed['images']['f'*40+'-1-1-api']=changed['images'].pop(tag)
            elif kind=='id':changed['images'][tag]='sha256:'+'f'*64
            elif kind=='current':changed['currentManifestSha256']='f'*64
            else:changed['publicationQualified']=True
            with self.subTest(kind=kind),patch.object(cache,'H_RECOVERY_DEPENDENCIES',changed):
                with self.assertRaisesRegex(RuntimeError,'Observed H recovery dependency policy changed'):self.collect()
                self.assertEqual(self.commands,[])

    def test_other_release_directory_even_same_commit_preserves_generic_behavior(self):
        other=self.base/'releases/20261012T182212Z-60e164b75d1e';self.directory.rename(other)
        (self.base/'current').unlink();(self.base/'current').symlink_to(other)
        with patch.object(cache,'H_RECOVERY_DEPENDENCIES',None):result=self.collect()
        self.assertEqual(result['imageIds'],['sha256:'+'2'*64])
        self.assertNotIn('literal/H_RECOVERY_DEPENDENCIES',result['evidenceSha256'])
        self.assertFalse(any(command[-1].startswith(cache.REPOSITORY+':') for command in self.commands))
        self.failed.assert_not_called()

    def test_successor_c_with_exact_h_previous_keeps_all_eight_cold_dependencies(self):
        directory=self.base/'releases/20261013T000000Z-777777777777';directory.mkdir()
        successor={'commit':'7'*40,'previousCommit':self.manifest['commit'],
            'previousRelease':str(self.directory),'images':{'api':{'digest':'sha256:'+'8'*64}}}
        (directory/'release-manifest.json').write_text(json.dumps(successor))
        (self.base/'current').unlink();(self.base/'current').symlink_to(directory)
        with patch.object(cache,'read',side_effect=self.command):result=cache.collect_dependencies(successor,self.manifest)
        self.assertEqual(set(result['imageIds']),set(self.images.values())|{'sha256:'+'3'*64})
        self.assertEqual(result['serviceRollback']['api'],{'status':'RETAINED','commit':self.manifest['commit'],'imageId':'sha256:'+'3'*64})
        self.assertEqual(len([command for command in self.commands if command[-1].startswith(cache.REPOSITORY+':')]),8)
        self.assertIn('literal/H_RECOVERY_DEPENDENCIES',result['evidenceSha256'])
        self.failed.assert_not_called()

    def test_original_literal_is_only_observed_retention_with_exact_immutable_source_identity(self):
        self.assertEqual(cache.plan_digest(self.original_policy),'084306aa18f7cb49933f075164cd888b89384b678714ea60389ddff5a90989ef')
        self.assertEqual(self.original_policy['kind'],'OBSERVED_H_RECOVERY_IMAGE_PROTECTIONS_V1')
        self.assertEqual(self.original_policy['basis'],'READONLY_CACHE_INVENTORY')
        self.assertIs(self.original_policy['publicationQualified'],False)
        self.assertEqual(len(self.original_policy['images']),8)
        self.assertTrue(all(cache.TAG.fullmatch(tag) and cache.IMAGE_ID.fullmatch(image) for tag,image in self.original_policy['images'].items()))

    def test_old_plan_with_missing_h_protections_rejects_before_any_removal(self):
        result=self.collect();old={**result,'imageIds':[],'evidenceSha256':{}}
        image=next(iter(self.images.values()));tag=next(iter(self.images))
        plan=cache.make_plan(self.manifest['commit'],self.previous,set(),[{'id':image,'repoTags':[cache.REPOSITORY+':'+tag]}],old)
        self.commands.clear()
        with patch.object(cache,'current',return_value=(self.manifest,self.previous)), \
                patch.object(cache,'read',side_effect=self.command),patch.object(cache,'verify_remote'), \
                patch.object(cache,'active_images',return_value=set()):
            with self.assertRaisesRegex(RuntimeError,'Reviewed image dependencies changed'):cache.apply_plan(plan)
        self.assertFalse(any(command[:3]==('docker','image','rm') for command in self.commands))


class GenericWorkflowResultTests(unittest.TestCase):
    def accepted_program(self):
        workflow=(DIRECTORY.parents[1]/'.github/workflows/production-release.yml').read_text()
        source=workflow.split("python3 - <<'PY_CACHE_ACCEPTED'\n",1)[1].split('          PY_CACHE_ACCEPTED',1)[0]
        return '\n'.join(line[10:] if line.startswith(' '*10) else line for line in source.splitlines())
    def result_program(self):
        workflow=(DIRECTORY.parents[1]/'.github/workflows/production-release.yml').read_text()
        source=workflow.split("python3 - <<'PY_CACHE_RESULT'\n",1)[1].split('          PY_CACHE_RESULT',1)[0]
        return '\n'.join(line[10:] if line.startswith(' '*10) else line for line in source.splitlines())
    def save(self,stdout,status='Success',code=0,operation='verify_unused_cache'):
        import os
        runtime=DIRECTORY.parents[1]/'.runtime/central-capacity-control-20261012';runtime.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=runtime) as temporary:
            root=Path(temporary);(root/'scripts/production-release').mkdir(parents=True);(root/'.deploy/production-release').mkdir(parents=True)
            (root/'scripts/production-release/maintain-image-cache.py').write_bytes((DIRECTORY/'maintain-image-cache.py').read_bytes())
            native={'CommandId':'11111111-1111-1111-1111-111111111111','Status':status,'ResponseCode':code,'ExecutionStartDateTime':'2026-10-12T00:00:00Z','ExecutionEndDateTime':'2026-10-12T00:00:01Z','StandardOutputContent':stdout}
            (root/'.deploy/production-release/unused-image-cache-invocation.json').write_text(json.dumps(native))
            (root/'.deploy/production-release/unused-image-cache.json').write_bytes(b'{"fixtureRequest":true}')
            before=Path.cwd()
            try:
                os.chdir(root)
                try:value=cache.generic_cache_result_readback(stdout)
                except Exception:value={}  # Let the real workflow decoder reject the already accepted fixture.
                expected=value.get('currentCommit') or value.get('plan',{}).get('expectedCurrent')
                with patch.dict(os.environ,{'CACHE_COMMAND_ID':native['CommandId'],'CACHE_OPERATION':operation,
                        'EXPECTED_CURRENT':expected or 'a'*40,'RELEASE_COMMIT':expected or 'a'*40,'CACHE_PLAN_SHA256':value.get('planSha256',''),
                        'GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1','PRODUCTION_INSTANCE_ID':'i-synthetic'}),contextlib.redirect_stdout(io.StringIO()) as output:
                    exec(compile(self.accepted_program(),'<actual-workflow-accepted>','exec'),{})
                    accepted=root/'.deploy/production-release/unused-image-cache-accepted-command.json'
                    record=json.loads(accepted.read_bytes());self.assertEqual(record['commandId'],native['CommandId'])
                    self.assertEqual(record['status'],'ACCEPTED_RESULT_UNKNOWN')
                    self.assertEqual(record['sourceSha256'],cache.hashlib.sha256((DIRECTORY/'maintain-image-cache.py').read_bytes()).hexdigest())
                    try:exec(compile(self.result_program(),'<actual-workflow-save>','exec'),{})
                    except Exception:
                        self.assertTrue(accepted.is_file())
                        self.assertTrue((root/'.deploy/production-release/unused-image-cache-invocation.json').is_file())
                        raise
                return json.loads((root/'.deploy/production-release/unused-image-cache-result.json').read_bytes()),json.loads(output.getvalue())
            finally:os.chdir(before)
    def test_actual_legacy_cleanup_stdout_is_saved_by_real_workflow_decoder_without_changing_executor(self):
        fixture=ObsoleteCacheTests();fixture.setUp();fixture.args.apply=True
        runtime=DIRECTORY.parents[1]/'.runtime/central-capacity-control-20261012';runtime.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=runtime) as directory,patch.object(cache,'BASE',Path(directory)), \
                patch.object(cache,'current',return_value=(fixture.live,fixture.previous)),patch.object(cache,'active_images',return_value=set()), \
                patch.object(cache,'read',side_effect=fixture.command),contextlib.redirect_stdout(io.StringIO()) as output:
            cache.maintain_legacy(fixture.args)
        value,binding=self.save(output.getvalue(),operation='cleanup_unused_legacy_cache');self.assertEqual(value['policy'],cache.LEGACY_POLICY)
        self.assertEqual(value['removed'],[command[-1] for command in fixture.removals()])
        self.assertEqual(binding['nativeStatus'],'Success');self.assertEqual(binding['responseCode'],0)
        for changed in (output.getvalue().replace('OBSOLETE_CACHE_REMOVED ','CACHE_IMAGE_REMOVED ',1),
                        'ARBITRARY_PRIVATE_LOG\n'+output.getvalue(),output.getvalue().replace('OBSOLETE_CACHE_REMOVED ', 'OBSOLETE_CACHE_REMOVED foreign:',1)):
            with self.subTest(case=changed[:30]),self.assertRaises(RuntimeError):self.save(changed,operation='cleanup_unused_legacy_cache')
    def test_complete_plan_envelope_failure_and_native_mismatch_are_saved_or_rejected_exactly(self):
        value=CompleteGenericCacheEvidenceTests().large_result()
        decoded,binding=self.save(cache.generic_cache_result_output(value));self.assertEqual(decoded,value)
        self.assertEqual(binding['completeResultSha256'],cache.plan_digest(value))
        for bad in ('','{truncated'):
            with self.subTest(stdout=bad),self.assertRaises((RuntimeError,ValueError)):self.save(bad,'Failed',1)
        for status,code in [('Success',1),('InProgress',-1)]:
            with self.subTest(status=status),self.assertRaises(RuntimeError):self.save(cache.generic_cache_result_output(value),status,code)


if __name__ == '__main__':
    unittest.main()
