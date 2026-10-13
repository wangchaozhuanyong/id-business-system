"""Native lifecycle integration with mocked files, ECR and Docker only."""

import ast
import copy
import importlib.util
import json
from pathlib import Path
import re
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, create_autospec, patch


DIRECTORY = Path(__file__).resolve().parent


def load(name, leaf):
    spec = importlib.util.spec_from_file_location(name, DIRECTORY / leaf)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


disk = load('lifecycle_disk_native', 'disk-retention.py')
fixtures = load('lifecycle_candidate_fixtures', 'candidate-retention.test.py')
registry = fixtures.candidate
cache = load('lifecycle_cache_helper', 'maintain-image-cache.py')
SHA = 'b' * 64
CURRENT = 'a' * 40
SOURCE_BYTES = 5 * 1024**2


def policy():
    return {'kind': disk.KIND, 'version': 1, 'approved': True,
            'sourceSha256': 'c' * 64, 'maintainerSha256': 'd' * 64, 'candidateRegistrySha256': 'e' * 64,
            'protectedCandidateBatches': [], 'supersededOnlineBatches': [],
            'budgets': {'targetFreeBytes': 12 * 1024**3, 'cleanupThresholdBytes': 10 * 1024**3,
                        'criticalFreeBytes': 6 * 1024**3, 'projectArtifactsBytes': 4 * 1024**3,
                        'localBackupsBytes': 1024**3, 'systemLogsBytes': 1024**3}}


def mocked_registry():
    value = SimpleNamespace(**{key: item for key, item in vars(registry).items() if not key.startswith('__')})
    # Signature-aware mocks catch accidental loss of the lock requirement while
    # ensuring no test reads or writes any production registry file.
    value.read_registry = create_autospec(registry.read_registry)
    value.write_registry = create_autospec(registry.write_registry, return_value=SHA)
    return value


def image_rows(record):
    rows = {}
    for image in record['images'].values():
        row = rows.setdefault(image['imageId'], {'id': image['imageId'], 'repoTags': [],
                                                'sizeBytes': image['sizeBytes']})
        row['repoTags'].append(image['reference'])
    return list(rows.values())


def retired_state(policy_value=None):
    policy_value = policy_value or policy()
    old, new = fixtures.record(), fixtures.record(2)
    state = registry.register(registry.new_registry(disk.policy_digest(policy_value)), old, [])
    return registry.register(state, new, [fixtures.replacement(old, new)]), old, new


class RegistrationEventTests(unittest.TestCase):
    def setUp(self):
        self.policy = policy()
        self.module = mocked_registry()
        self.helper = SimpleNamespace(verify_remote=Mock())
        self.record = fixtures.record()
        self.state = registry.new_registry(disk.policy_digest(self.policy))
        self.event = {'record': self.record, 'supersedes': [], 'sourceArchiveBytes': SOURCE_BYTES}

    def test_ecr_failure_never_writes_or_discards_existing_pending(self):
        previous = fixtures.record(9)
        self.state = registry.register(self.state, previous, [])
        original = copy.deepcopy(self.state)
        self.event['supersedes'] = [fixtures.replacement(previous, self.record)]
        self.helper.verify_remote.side_effect = RuntimeError('ECR_UNAVAILABLE')
        with self.assertRaisesRegex(RuntimeError, 'ECR_UNAVAILABLE'):
            disk.register_event(self.policy, self.helper, self.module, self.state, self.event)
        self.module.write_registry.assert_not_called()
        self.assertEqual(self.state, original)

    def test_complete_remote_verified_record_is_written_under_deployment_lock(self):
        result = disk.register_event(self.policy, self.helper, self.module, self.state, self.event)
        self.helper.verify_remote.assert_called_once_with({'items': [
            {'tag': image['reference'].split(':', 1)[1], 'imageId': image['imageId']}
            for image in self.record['images'].values()]})
        self.module.write_registry.assert_called_once_with(disk.INSTALL / 'candidates.json', result,
                                                          deployment_lock_held=True)
        self.assertEqual(result['pending'], {'online-recharge': self.record['batch']})
        self.assertEqual(self.state['pending'], {})

    def test_incomplete_role_or_invalid_source_size_rejects_before_remote_and_write(self):
        partial = copy.deepcopy(self.event); del partial['record']['images']['api']
        source_invalid = copy.deepcopy(self.event); source_invalid['sourceArchiveBytes'] = 0
        for event in (partial, source_invalid):
            with self.assertRaises(RuntimeError):
                disk.register_event(self.policy, self.helper, self.module, self.state, event)
        self.helper.verify_remote.assert_not_called()
        self.module.write_registry.assert_not_called()

    def test_policy_seed_cannot_be_manufactured_by_event_caller(self):
        old = fixtures.record(3)
        self.event['supersedes'] = [fixtures.replacement(old, self.record, policy_seed=True)]
        with self.assertRaisesRegex(RuntimeError, 'SEED_REPLACEMENT_FORBIDDEN'):
            disk.register_event(self.policy, self.helper, self.module, self.state, self.event)
        self.helper.verify_remote.assert_not_called()
        self.module.write_registry.assert_not_called()

    def test_candidate_state_read_requires_deployment_lock_and_policy_binding(self):
        self.module.read_registry.return_value = self.state
        with patch.object(Path, 'exists', return_value=True):
            self.assertEqual(disk.candidate_state(self.policy, self.module), self.state)
        self.module.read_registry.assert_called_once_with(disk.INSTALL / 'candidates.json', deployment_lock_held=True)
        self.module.read_registry.return_value = registry.new_registry('f' * 64)
        with patch.object(Path, 'exists', return_value=True), self.assertRaisesRegex(RuntimeError, 'REGISTRY_POLICY_CHANGED'):
            disk.candidate_state(self.policy, self.module)


class DynamicPlanningTests(unittest.TestCase):
    def setUp(self):
        self.policy = policy()
        self.state, self.old, self.new = retired_state(self.policy)
        self.rows = image_rows(self.old) + image_rows(self.new)
        self.manifest = {'commit': CURRENT, 'previousCommit': '9' * 40,
                         'deploymentRun': 'github-actions-100-1', 'images': {}, 'rollback': {}}
        self.previous = {'commit': '9' * 40, 'images': {}}
        self.dependencies = {'version': 1, 'imageIds': [], 'serviceRollback': {}, 'evidenceSha256': {}}
        self.helper = SimpleNamespace(REPOSITORY=registry.REPOSITORY, current=Mock(return_value=(self.manifest, self.previous)),
            protected_images=cache.protected_images, active_images=Mock(return_value=set()),
            collect_dependencies=Mock(return_value=self.dependencies), make_plan=cache.make_plan,
            verify_remote=Mock(), read=Mock())

    def planned(self, state=None, rows=None):
        with patch.object(disk, 'manifest_digest', return_value=SHA):
            return disk.plan(self.policy, self.helper, CURRENT, rows=self.rows if rows is None else rows,
                             state=self.state if state is None else state)

    def test_pending_every_image_id_is_protected_as_whole_batch(self):
        result = self.planned()
        expected = {image['imageId'] for image in self.new['images'].values()}
        self.assertTrue(expected <= set(result['corePlan']['protectedImageIds']))
        self.assertFalse(expected & {item['imageId'] for item in result['corePlan']['items']})
        self.assertEqual(result['registrySha256'], disk.digest(self.state))

    def test_explicit_retired_candidate_is_reclaimable_even_when_newer_than_current_run(self):
        self.assertGreater(int(self.old['producer']['workflowRunId']), 100)
        result = self.planned()
        self.assertEqual({item['imageId'] for item in result['corePlan']['items']},
                         {image['imageId'] for image in self.old['images'].values()})
        self.assertEqual(result['candidateCount'], 4)

    def test_unknown_newer_batch_stays_protected_and_never_treated_as_failed(self):
        unknown = fixtures.record(99)
        result = self.planned(rows=self.rows + image_rows(unknown))
        self.assertTrue({image['imageId'] for image in unknown['images'].values()} <=
                        set(result['corePlan']['protectedImageIds']))
        self.assertEqual(result['candidateCount'], 4)

    def test_shared_pending_alias_protects_whole_image_through_retired_alias(self):
        new = copy.deepcopy(self.new)
        shared = self.old['images']['online-recharge']['imageId']
        new['images']['online-recharge']['imageId'] = shared
        initial = registry.register(registry.new_registry(disk.policy_digest(self.policy)), self.old, [])
        state = registry.register(initial, new, [fixtures.replacement(self.old, new)])
        merged = {}
        for row in image_rows(self.old) + image_rows(new):
            existing = merged.setdefault(row['id'], {**row, 'repoTags': []})
            existing['repoTags'].extend(row['repoTags'])
        result = self.planned(state, list(merged.values()))
        self.assertIn(shared, result['corePlan']['protectedImageIds'])
        self.assertNotIn(shared, {item['imageId'] for item in result['corePlan']['items']})
        self.assertEqual(result['candidateCount'], 3)

    def test_frozen_retired_record_is_protected_as_complete_batch(self):
        state = copy.deepcopy(self.state); state['frozen'] = [self.old['batch']]
        pending, retired, fingerprint = disk.effective_state(state)
        self.assertEqual({value['batch'] for value in pending}, {self.old['batch'], self.new['batch']})
        self.assertEqual(retired, set())
        self.assertEqual(fingerprint, disk.digest(state))
        self.assertEqual(self.planned(state)['candidateCount'], 0)

    def test_registry_change_before_apply_rejects_before_remote_or_delete(self):
        reviewed = self.planned()
        changed = copy.deepcopy(self.state); changed['frozen'] = [self.old['batch']]
        with patch.object(disk, 'manifest_digest', return_value=SHA), \
                patch.object(disk, 'inventory', return_value=self.rows), self.assertRaisesRegex(RuntimeError, 'PLAN_CHANGED'):
            disk.apply(self.policy, self.helper, reviewed, disk.digest(reviewed), state_reader=lambda: changed)
        self.helper.verify_remote.assert_not_called()
        self.helper.read.assert_not_called()

    def test_registry_change_during_apply_rejects_before_first_delete(self):
        reviewed = self.planned()
        changed = copy.deepcopy(self.state); changed['frozen'] = [self.old['batch']]
        states = iter((self.state, changed))
        with patch.object(disk, 'manifest_digest', return_value=SHA), \
                patch.object(disk, 'inventory', return_value=self.rows), self.assertRaisesRegex(RuntimeError, 'STATE_CHANGED_DURING_APPLY'):
            disk.apply(self.policy, self.helper, reviewed, disk.digest(reviewed), state_reader=lambda: next(states))
        self.helper.read.assert_not_called()

    def test_previous_online_marker_keeps_historical_cold_images_and_evidence(self):
        historical = 'sha256:' + 'f' * 64
        self.manifest['previousRelease'] = '/opt/id-business-v2/releases/20261013T000000Z-' + '9' * 12
        for marker, value in (('onlineRechargePublication', {'version': 2, 'scope': 'ONLINE_RECHARGE'}),
                              ('preservedOnlineRechargeOrigin', {'version': 1})):
            with self.subTest(marker=marker):
                self.previous.pop('onlineRechargePublication', None)
                self.previous.pop('preservedOnlineRechargeOrigin', None)
                self.previous[marker] = value

                def cold(path, manifest, evidence):
                    self.assertEqual(path, Path(self.manifest['previousRelease']))
                    self.assertIs(manifest, self.previous)
                    evidence['previous/cold-proof.json'] = SHA
                    return {historical}

                self.helper.historical_online_cold_dependencies = Mock(side_effect=cold)
                result = self.planned()
                self.helper.historical_online_cold_dependencies.assert_called_once()
                self.assertIn(historical, result['corePlan']['protectedImageIds'])
                self.assertEqual(result['corePlan']['dependencies']['evidenceSha256']['previous/cold-proof.json'], SHA)
                self.assertEqual(self.dependencies['evidenceSha256'], {})

    def test_previous_fixed_original_online_baseline_keeps_cold_images_without_marker(self):
        historical = 'sha256:' + 'f' * 64
        self.previous['commit'] = '31d2c6885a45817cd40d23fce8d6145bc9f18af2'
        self.manifest['previousRelease'] = '/opt/id-business-v2/releases/20261011T000000Z-31d2c6885a45'
        self.helper.historical_online_cold_dependencies = Mock(return_value={historical})
        result = self.planned()
        self.helper.historical_online_cold_dependencies.assert_called_once()
        self.assertIn(historical, result['corePlan']['protectedImageIds'])


class PublicationEventTests(unittest.TestCase):
    def setUp(self):
        self.module = mocked_registry()
        self.record = fixtures.record()
        self.state = registry.register(registry.new_registry(disk.policy_digest(policy())), self.record, [])
        self.manifest = {'commit': self.record['producer']['commit'], 'sourceTree': self.record['producer']['sourceTree'],
                         'ciWorkflowRunId': int(self.record['qualityRunId']),
                         'deploymentRun': 'github-actions-' + self.record['producer']['workflowRunId'] + '-1',
                         'images': {role: {'reference': image['reference'], 'digest': image['imageId']}
                                    for role, image in self.record['images'].items()}}
        self.running = {f'{index + 1:064x}': image['imageId']
                        for index, (role, image) in enumerate(self.record['images'].items()) if role != 'migrate'}
        self.helper = SimpleNamespace(current=Mock(return_value=(self.manifest, {})),
                                      read=Mock(side_effect=self.docker), verify_remote=Mock())

    def docker(self, *arguments):
        if arguments == ('docker', 'ps', '--no-trunc', '--quiet'):
            return '\n'.join(self.running)
        if arguments[:4] == ('docker', 'inspect', '--format', '{{.Image}}'):
            return self.running[arguments[-1]]
        raise AssertionError(arguments)

    def publication(self, record=None):
        with patch.object(disk, 'manifest_digest', return_value=SHA):
            return disk.publication_event(self.helper, self.module, self.state,
                                          {'record': self.record if record is None else record})

    def test_actual_manifest_producer_and_running_full_batch_write_exact_verified_proof(self):
        original = copy.deepcopy(self.state)
        result = self.publication()
        self.module.write_registry.assert_called_once_with(disk.INSTALL / 'candidates.json', result,
                                                          deployment_lock_held=True)
        proof = result['batches'][self.record['batch']]['publicationProof']
        expected = fixtures.publication(self.record); expected['currentManifestSha256'] = SHA
        self.assertEqual(proof, expected)
        self.assertEqual(result['batches'][self.record['batch']]['status'], 'published')
        self.assertEqual(self.state, original)
        self.helper.verify_remote.assert_called_once()

    def test_manifest_tree_quality_or_run_mismatch_never_marks_published(self):
        for key, wrong in (('sourceTree', 'f' * 40), ('ciWorkflowRunId', 999), ('deploymentRun', 'github-actions-1-2')):
            with self.subTest(key=key):
                original = self.manifest[key]; self.manifest[key] = wrong
                with self.assertRaisesRegex(RuntimeError, 'PUBLICATION_PRODUCER_CHANGED'):
                    self.publication()
                self.manifest[key] = original
        self.module.write_registry.assert_not_called()
        self.assertEqual(self.state['batches'][self.record['batch']]['status'], 'pending')

    def test_manifest_image_reference_or_digest_mismatch_never_marks_published(self):
        for key, wrong in (('reference', 'foreign:latest'), ('digest', 'sha256:' + 'f' * 64)):
            with self.subTest(key=key):
                original = self.manifest['images']['api'][key]; self.manifest['images']['api'][key] = wrong
                with self.assertRaisesRegex(RuntimeError, 'PUBLICATION_IMAGE_CHANGED'):
                    self.publication()
                self.manifest['images']['api'][key] = original
        self.module.write_registry.assert_not_called()

    def test_missing_running_api_never_marks_published_even_when_workflow_claims_success(self):
        api_id = self.record['images']['api']['imageId']
        self.running = {container: image for container, image in self.running.items() if image != api_id}
        with self.assertRaisesRegex(RuntimeError, 'PUBLISHED_SERVICE_NOT_RUNNING'):
            self.publication()
        self.module.write_registry.assert_not_called()
        self.assertEqual(self.state['pending'], {'online-recharge': self.record['batch']})

    def test_changed_event_build_proof_and_ecr_failure_never_write(self):
        altered = copy.deepcopy(self.record); altered['proofSha256'] = 'f' * 64
        with self.assertRaisesRegex(RuntimeError, 'PUBLICATION_PROOF_DRIFT'):
            self.publication(altered)
        self.module.write_registry.assert_not_called()
        self.helper.verify_remote.side_effect = RuntimeError('ECR_UNAVAILABLE')
        with self.assertRaisesRegex(RuntimeError, 'ECR_UNAVAILABLE'):
            self.publication()
        self.module.write_registry.assert_not_called()


class CapacityTests(unittest.TestCase):
    def setUp(self):
        self.record = fixtures.record()
        self.reserve = SOURCE_BYTES * 3 + 2 * 1024**3

    def test_all_missing_images_reserve_unpacked_compressed_source_and_final_headroom(self):
        expected = sum(image['sizeBytes'] + image['compressedBytes'] for image in self.record['images'].values()) + self.reserve
        self.assertEqual(disk.capacity_requirement(self.record, [], SOURCE_BYTES), expected)

    def test_existing_exact_local_image_ids_do_not_reserve_another_copy(self):
        image = self.record['images']['api']
        all_required = disk.capacity_requirement(self.record, [], SOURCE_BYTES)
        self.assertEqual(disk.capacity_requirement(self.record, [{'id': image['imageId']}], SOURCE_BYTES),
                         all_required - image['sizeBytes'] - image['compressedBytes'])
        self.assertEqual(disk.capacity_requirement(self.record, image_rows(self.record), SOURCE_BYTES), self.reserve)

    def test_same_image_id_under_distinct_role_references_is_counted_once(self):
        value = copy.deepcopy(self.record)
        value['images']['admin']['imageId'] = value['images']['api']['imageId']
        unique = {image['imageId']: image for image in value['images'].values()}
        expected = sum(image['sizeBytes'] + image['compressedBytes'] for image in unique.values()) + self.reserve
        self.assertEqual(disk.capacity_requirement(value, [], SOURCE_BYTES), expected)

    def test_same_image_id_with_inconsistent_size_or_compression_measurement_rejects(self):
        for field in ('sizeBytes', 'compressedBytes'):
            value = copy.deepcopy(self.record)
            value['images']['admin']['imageId'] = value['images']['api']['imageId']
            value['images']['admin'][field] += 1
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'IMAGE_MEASUREMENT_CHANGED'):
                disk.capacity_requirement(value, [], SOURCE_BYTES)

    def test_source_bytes_require_positive_bounded_integer(self):
        for amount in (None, False, 0, -1, 1.1, '1', 256 * 1024**2 + 1):
            with self.subTest(amount=amount), self.assertRaisesRegex(RuntimeError, 'SOURCE_SIZE_INVALID'):
                disk.capacity_requirement(self.record, [], amount)
        self.assertGreater(disk.capacity_requirement(self.record, [], 256 * 1024**2), 2 * 1024**3)


class CompactionEventTests(unittest.TestCase):
    def setUp(self):
        self.module = mocked_registry()
        self.state, self.old, self.new = retired_state()

    def test_complete_local_image_id_absence_compacts_only_retired_batch(self):
        original = copy.deepcopy(self.state)
        result = disk.compact_registry(self.module, self.state, image_rows(self.new))
        self.assertNotIn(self.old['batch'], result['batches'])
        self.assertIn(self.old['batch'], result['compacted'])
        self.assertIn(self.new['batch'], result['batches'])
        self.module.write_registry.assert_called_once_with(disk.INSTALL / 'candidates.json', result,
                                                          deployment_lock_held=True)
        self.assertEqual(self.state, original)

    def test_one_remaining_id_without_old_tag_prevents_whole_batch_compaction(self):
        row = {'id': self.old['images']['online-recharge']['imageId'], 'repoTags': ['unrelated:alias']}
        self.assertEqual(disk.compact_registry(self.module, self.state, [row]), self.state)
        self.module.write_registry.assert_not_called()

    def test_no_local_ids_never_compacts_pending_or_frozen_records(self):
        state = copy.deepcopy(self.state); state['frozen'] = [self.old['batch']]
        self.assertEqual(disk.compact_registry(self.module, state, []), state)
        self.module.write_registry.assert_not_called()
        pending_only = registry.register(registry.new_registry(disk.policy_digest(policy())), self.new, [])
        self.assertEqual(disk.compact_registry(self.module, pending_only, []), pending_only)
        self.module.write_registry.assert_not_called()


def workflow_steps(source):
    """Read only top-level step boundaries; no YAML dependency or execution."""
    starts = list(re.finditer(r'^      - name: (.+)$', source, flags=re.MULTILINE))
    result = []
    for index, start in enumerate(starts):
        block = source[start.start():starts[index + 1].start() if index + 1 < len(starts) else len(source)]
        condition = re.search(r'^        if: (.+)$', block, flags=re.MULTILINE)
        result.append({'name': start.group(1).strip(), 'block': block,
                       'condition': condition.group(1).strip() if condition else 'true'})
    return result


def predicate(expression, **inputs):
    """Evaluate the small expression subset used by these workflow gates."""
    tree = ast.parse(expression.replace('&&', ' and ').replace('||', ' or '), mode='eval')

    def evaluate(node):
        if isinstance(node, ast.Expression):
            return evaluate(node.body)
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name) and node.id in ('true', 'false'):
            return node.id == 'true'
        if isinstance(node, ast.Name) and node.id == 'steps':
            return inputs.get('steps', {})
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == 'inputs':
            return inputs.get(node.attr, '')
        if isinstance(node, ast.Attribute):
            value = evaluate(node.value)
            return value.get(node.attr, '') if isinstance(value, dict) else ''
        if isinstance(node, ast.BoolOp):
            if isinstance(node.op, ast.And):
                return all(evaluate(value) for value in node.values)
            if isinstance(node.op, ast.Or):
                return any(evaluate(value) for value in node.values)
        if isinstance(node, ast.Compare) and len(node.ops) == len(node.comparators) == 1:
            left, right = evaluate(node.left), evaluate(node.comparators[0])
            if isinstance(node.ops[0], ast.Eq):
                return left == right
            if isinstance(node.ops[0], ast.NotEq):
                return left != right
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
            if node.func.id in ('always', 'success', 'failure') and not node.args:
                return node.func.id != 'failure'
            if node.func.id == 'startsWith' and len(node.args) == 2:
                return evaluate(node.args[0]).startswith(evaluate(node.args[1]))
        raise AssertionError('Unsupported workflow gate: ' + ast.dump(node))

    return evaluate(tree)


class WorkflowLifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = (DIRECTORY.parent.parent / '.github/workflows/production-release.yml').read_text()
        cls.steps = workflow_steps(cls.source)
        cls.transport = load('lifecycle_storage_transport', 'release-storage.py')
        cls.modern = set(registry.OPERATION_SCOPES) | {'release'}

    def named(self, name):
        found = [value for value in self.steps if value['name'] == name]
        self.assertEqual(len(found), 1)
        return found[0]

    def hook(self, phase):
        found = [value for value in self.steps if re.search(
            r'^        run: python3 -B scripts/production-release/release-storage\.py ' + re.escape(phase) + r'$',
            value['block'], flags=re.MULTILINE)]
        self.assertEqual(len(found), 1)
        return found[0]

    def test_three_phases_surround_preflight_push_deploy_and_modern_readbacks(self):
        before_build, before_pull, after_publish = [self.hook(phase) for phase in ('before-build', 'before-pull', 'after-publish')]
        index = lambda value: self.steps.index(value)
        preflights = [self.named(name) for name in (
            'Verify online recharge predecessor and idle workers before building',
            'Verify unpublished component predecessor and idle workers before building',
            'Verify recharge flow predecessor and idle workers before building',
            'Verify API Admin baseline and idle workers before building')]
        self.assertLess(index(before_build), min(index(value) for value in preflights))
        self.assertLess(index(self.named('Push immutable images')), index(before_pull))
        self.assertLess(index(before_pull), index(self.named('Deploy through the production instance')))
        readbacks = [self.named(name) for name in (
            'Independently read back Admin publication and preserved services',
            'Independently read back API Admin running images and preserved services',
            'Independently read back recharge flow images and preserved services',
            'Independently read back unpublished component images and preserved services',
            'Independently read back online recharge runtime and preserved services')]
        self.assertGreater(index(after_publish), max(index(value) for value in readbacks))

    def test_every_modern_scope_runs_hooks_and_verify_operations_never_run_them(self):
        self.assertEqual(self.modern, set(self.transport.OPERATIONS))
        self.assertEqual(len(self.modern), 8)
        verify = set(re.findall(r"'(verify_[a-z_]+)'", self.source))
        self.assertTrue(verify)
        for phase in ('before-build', 'before-pull', 'after-publish'):
            condition = self.hook(phase)['condition']
            for operation in self.modern:
                with self.subTest(phase=phase, operation=operation):
                    self.assertTrue(predicate(condition, operation=operation, historical_exception='none', reuse_image_run=''))
            for operation in verify | {'release_api_registration', 'cleanup_unused_cache'}:
                with self.subTest(phase=phase, operation=operation):
                    self.assertFalse(predicate(condition, operation=operation, historical_exception='none', reuse_image_run=''))

    def test_historical_reused_or_failed_readback_does_not_bypass_lifecycle_boundary(self):
        for phase in ('before-build', 'before-pull', 'after-publish'):
            condition = self.hook(phase)['condition']
            self.assertFalse(predicate(condition, operation='release', historical_exception='registration-worker-96-20261008', reuse_image_run=''))
            self.assertFalse(predicate(condition, operation='release', historical_exception='none', reuse_image_run='123'))
            # Without always()/failure(), GitHub retains its normal success gate:
            # a failed preflight or readback cannot trigger the mutating hook.
            self.assertNotIn('always(', condition)
            self.assertNotIn('failure(', condition)

    def test_legacy_maintenance_is_excluded_from_every_modern_none_scope(self):
        legacy = [self.named(name) for name in (
            'Verify or maintain recoverable unused project image cache',
            'Maintain service rollback image cache independently after fixed release')]
        for step in legacy:
            for operation in self.modern:
                with self.subTest(name=step['name'], operation=operation):
                    self.assertFalse(predicate(step['condition'], operation=operation, historical_exception='none',
                                               reuse_image_run='', expected_current=CURRENT))

    def test_stable_owner_detection_and_rejection_precede_any_legacy_cleanup(self):
        owner = self.named('Read stable disk maintenance ownership before legacy image operations')
        reject = self.named('Reject legacy image cleanup after stable disk policy installation')
        self.assertIn('        id: disk_owner\n', owner['block'])
        self.assertLess(self.steps.index(self.named('Obtain short-lived AWS credentials through OIDC')),
                        self.steps.index(owner))
        self.assertLess(self.steps.index(owner), self.steps.index(reject))
        self.assertLess(self.steps.index(reject), self.steps.index(self.hook('before-build')))
        manual = [value for value in self.steps if value is not owner and value is not reject
                  and 'cleanup_' in value['condition'] and 'run:' in value['block']]
        self.assertTrue(manual)
        self.assertTrue(all(self.steps.index(reject) < self.steps.index(value) for value in manual))
        # Failure of the rejection step must retain the normal workflow success
        # gate, rather than allowing a later cleanup via always()/failure().
        self.assertTrue(all('always(' not in value['condition'] and 'failure(' not in value['condition']
                            for value in manual))

    def test_owner_probe_is_a_readonly_stable_config_check_with_closed_boolean_output(self):
        owner = self.named('Read stable disk maintenance ownership before legacy image operations')
        parameter = re.search(r"--parameters '([^']+)'", owner['block'])
        self.assertIsNotNone(parameter)
        payload = json.loads(parameter.group(1))
        self.assertEqual(set(payload), {'commands'})
        self.assertEqual(len(payload['commands']), 1)
        self.assertRegex(payload['commands'][0],
                         r'^if test -(?:e|f) /opt/id-business-v2/maintenance/disk-retention/config\.json; '
                         r'then printf true; else printf false; fi$')
        self.assertIn('aws ssm wait command-executed', owner['block'])
        self.assertIn('case "$installed" in true|false)', owner['block'])
        self.assertIn('*) exit 1', owner['block'])
        self.assertIn('"$GITHUB_OUTPUT"', owner['block'])

    def test_installed_owner_rejects_five_legacy_image_cleanup_operations(self):
        owner = self.named('Read stable disk maintenance ownership before legacy image operations')
        reject = self.named('Reject legacy image cleanup after stable disk policy installation')
        cleanups = {'cleanup_cache', 'cleanup_unused_cache', 'cleanup_unused_legacy_cache',
                    'cleanup_unused_builder_cache', 'cleanup_legacy_cache'}
        self.assertRegex(reject['block'], r'(?m)^          exit 1$')
        for operation in cleanups:
            self.assertTrue(predicate(owner['condition'], operation=operation))
            for installed in ('true', 'false', ''):
                with self.subTest(operation=operation, installed=installed):
                    self.assertEqual(predicate(reject['condition'], operation=operation,
                                               steps={'disk_owner': {'outputs': {'installed': installed}}}), installed == 'true')
        for operation in self.modern | {'verify_cache', 'verify_unused_cache', 'cleanup_backups', 'cleanup_audit'}:
            self.assertFalse(predicate(reject['condition'], operation=operation,
                                       steps={'disk_owner': {'outputs': {'installed': 'true'}}}))

    def test_installed_owner_disables_both_automatic_legacy_maintainers_without_changing_old_bounds(self):
        cases = (
            ('Verify or maintain recoverable unused project image cache', 'historical-finance-20261005'),
            ('Maintain service rollback image cache independently after fixed release', 'registration-worker-95-20261008'),
        )
        for name, historical in cases:
            step = self.named(name)
            for installed in ('true', 'false'):
                with self.subTest(name=name, installed=installed):
                    self.assertEqual(predicate(step['condition'], operation='release', historical_exception=historical,
                                               reuse_image_run='', expected_current=CURRENT,
                                               steps={'disk_owner': {'outputs': {'installed': installed}}}), installed == 'false')
            self.assertFalse(predicate(step['condition'], operation='release', historical_exception='none',
                                       reuse_image_run='', expected_current=CURRENT,
                                       steps={'disk_owner': {'outputs': {'installed': 'false'}}}))


if __name__ == '__main__':
    unittest.main()
