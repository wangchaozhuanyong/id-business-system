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


if __name__ == '__main__':
    unittest.main()
