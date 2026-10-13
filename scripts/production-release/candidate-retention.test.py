import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


DIRECTORY = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('disk_candidate_retention', DIRECTORY / 'candidate-retention.py')
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)
POLICY = 'f' * 64


def record(number=1, operation='release_online_recharge', admin_only=False):
    commit = f'{number:040x}'
    run = str(900 + number)
    producer = {'commit': commit, 'sourceTree': f'{number + 100:040x}',
                'workflowRunId': run, 'workflowRunAttempt': '1'}
    batch = commit + '-' + run + '-1'
    if operation == 'release':
        module = 'admin' if admin_only else 'full-release'
        roles = ('admin',) if admin_only else ('api', 'admin', 'migrate', 'auto-recharge', 'media-resolver')
    else:
        module, roles = candidate.OPERATION_SCOPES[operation]
    return {'kind': candidate.RECORD_KIND, 'version': 1, 'batch': batch,
            'module': module, 'operation': operation, 'producer': producer,
            'qualityRunId': str(500 + number), 'proofSha256': f'{number + 200:064x}',
            'images': {role: {'reference': candidate.REPOSITORY + ':' + batch + '-' + role,
                             'imageId': 'sha256:' + f'{number * 10 + index:064x}',
                             'sizeBytes': 1024**3, 'compressedBytes': 100 * 1024**2}
                       for index, role in enumerate(sorted(roles))}}


def replacement(old, new, policy_seed=False):
    value = {'batch': old['batch'], 'basis': 'policy_seed' if policy_seed else 'pending',
             'ancestry': {'ancestorCommit': old['producer']['commit'],
                          'descendantCommit': new['producer']['commit'],
                          'approved': True, 'proofSha256': 'a' * 64}}
    if policy_seed:
        value.update(record=copy.deepcopy(old), policySha256=POLICY)
    return value


def publication(value):
    return {'kind': candidate.PUBLICATION_KIND, 'version': 1,
            'commit': value['producer']['commit'], 'workflowRunId': value['producer']['workflowRunId'],
            'workflowRunAttempt': value['producer']['workflowRunAttempt'],
            'candidateProofSha256': value['proofSha256'], 'currentManifestSha256': 'b' * 64,
            'images': {role: image['imageId'] for role, image in value['images'].items()}}


def absence(value):
    return {'kind': candidate.ABSENCE_KIND, 'version': 1, 'batch': value['batch'],
            'recordSha256': candidate.record_sha256(value), 'snapshotSha256': 'c' * 64,
            'absentImageIds': sorted({image['imageId'] for image in value['images'].values()})}


class RecordTests(unittest.TestCase):
    def test_complete_sets_match_supported_build_operations(self):
        for operation in list(candidate.OPERATION_SCOPES) + ['release']:
            with self.subTest(operation=operation):
                self.assertEqual(candidate.validate_record(record(operation=operation)), record(operation=operation))
        admin = record(operation='release', admin_only=True)
        self.assertEqual(candidate.validate_record(admin)['module'], 'admin')

    def test_any_missing_component_preserves_entire_old_candidate(self):
        previous = record()
        registry = candidate.register(candidate.new_registry(POLICY), previous, [])
        original = copy.deepcopy(registry)
        complete = record(2)
        for role in complete['images']:
            partial = copy.deepcopy(complete)
            del partial['images'][role]
            with self.subTest(role=role), self.assertRaisesRegex(candidate.CandidateRejected, 'BATCH_INCOMPLETE'):
                candidate.register(registry, partial, [replacement(previous, partial)])
            self.assertEqual(registry, original)
            self.assertEqual(candidate.effective_candidates(registry)['pending'], [previous])

    def test_extra_role_and_foreign_operation_never_register(self):
        value = record()
        value['images']['auto-recharge'] = copy.deepcopy(value['images']['online-recharge'])
        with self.assertRaisesRegex(candidate.CandidateRejected, 'BATCH_INCOMPLETE'):
            candidate.validate_record(value)
        for operation in ('verify_online_recharge', 'release_api_registration', 'workflow_failed', 'prepare_order_archive_release'):
            value = record(); value['operation'] = operation
            with self.subTest(operation=operation), self.assertRaisesRegex(candidate.CandidateRejected, 'OPERATION_UNSUPPORTED'):
                candidate.validate_record(value)

    def test_tag_repository_commit_run_attempt_and_role_are_exact(self):
        value = record(); image = value['images']['online-recharge']
        variants = ['foreign:' + value['batch'] + '-online-recharge',
                    candidate.REPOSITORY + ':latest',
                    image['reference'].replace(value['producer']['commit'], 'a' * 40),
                    image['reference'].replace('-901-1-', '-902-1-'),
                    image['reference'].replace('-901-1-', '-901-2-'),
                    image['reference'].replace('-online-recharge', '-auto-recharge')]
        for reference in variants:
            changed = copy.deepcopy(value); changed['images']['online-recharge']['reference'] = reference
            with self.subTest(reference=reference), self.assertRaisesRegex(candidate.CandidateRejected, 'TAG_DRIFT'):
                candidate.validate_record(changed)

    def test_source_identity_and_batch_must_be_well_formed(self):
        for field, incorrect in [('commit', 'a' * 39), ('sourceTree', 'tree'), ('workflowRunId', '0'),
                                 ('workflowRunId', '001'), ('workflowRunAttempt', True), ('workflowRunAttempt', '-1')]:
            value = record(); value['producer'][field] = incorrect
            with self.subTest(field=field, value=incorrect), self.assertRaises(candidate.CandidateRejected):
                candidate.validate_record(value)
        value = record(); value['batch'] = 'a' * 40 + '-901-1'
        with self.assertRaisesRegex(candidate.CandidateRejected, 'PRODUCER_DRIFT'):
            candidate.validate_record(value)

    def test_closed_schema_rejects_secret_and_status_fields(self):
        cases = []
        value = record(); value['token'] = 'must-not-be-accepted'; cases.append(value)
        value = record(); value['producer']['workflowStatus'] = 'failed'; cases.append(value)
        value = record(); value['images']['api']['ecrPresent'] = False; cases.append(value)
        value = record(); value['version'] = True; cases.append(value)
        for value in cases:
            with self.subTest(keys=set(value)), self.assertRaises(candidate.CandidateRejected):
                candidate.validate_record(value)

    def test_absent_or_invalid_ecr_measurement_is_not_a_complete_candidate(self):
        for field in ('sizeBytes', 'compressedBytes'):
            for amount in (None, 0, -1, True, 1.5, '1', candidate.MAX_IMAGE_BYTES + 1):
                value = record(); value['images']['api'][field] = amount
                with self.subTest(field=field, amount=amount), self.assertRaisesRegex(candidate.CandidateRejected, 'MEASUREMENT_MISSING'):
                    candidate.validate_record(value)
            value = record(); del value['images']['api'][field]
            with self.assertRaises(candidate.CandidateRejected):
                candidate.validate_record(value)

    def test_image_id_and_module_drift_reject(self):
        for image_id in ('sha256:' + 'A' * 64, 'sha256:' + '1' * 63, 'latest'):
            value = record(); value['images']['api']['imageId'] = image_id
            with self.assertRaisesRegex(candidate.CandidateRejected, 'IMAGE_ID_INVALID'):
                candidate.validate_record(value)
        value = record(); value['module'] = 'api-admin'
        with self.assertRaisesRegex(candidate.CandidateRejected, 'MODULE_DRIFT'):
            candidate.validate_record(value)


class RegistrationTests(unittest.TestCase):
    def setUp(self):
        self.old, self.new = record(), record(2)
        self.empty = candidate.new_registry(POLICY)
        self.registry = candidate.register(self.empty, self.old, [])

    def test_new_registry_is_closed_and_valid(self):
        self.assertEqual(candidate.validate_registry(self.empty), self.empty)
        with self.assertRaises(candidate.CandidateRejected):
            candidate.new_registry('bad')

    def test_complete_replacement_retires_whole_old_producer(self):
        result = candidate.register(self.registry, self.new, [replacement(self.old, self.new)])
        effective = candidate.effective_candidates(result)
        self.assertEqual(effective['pending'], [self.new])
        self.assertEqual(effective['retiredOnline'], [self.old])
        self.assertEqual(result['batches'][self.old['batch']]['supersededBy'], self.new['batch'])
        self.assertEqual(self.registry['pending'], {'online-recharge': self.old['batch']})

    def test_pending_cannot_be_lost_without_explicit_replacement(self):
        with self.assertRaisesRegex(candidate.CandidateRejected, 'PENDING_REPLACEMENT_REQUIRED'):
            candidate.register(self.registry, self.new, [])

    def test_cross_module_replacement_rejects(self):
        other = record(3, 'release_api_admin')
        with self.assertRaisesRegex(candidate.CandidateRejected, 'CROSS_MODULE'):
            candidate.register(self.registry, other, [replacement(self.old, other)])

    def test_each_module_can_keep_one_whole_pending_batch(self):
        result = self.registry
        for number, operation in enumerate(('release_admin', 'release_api_admin', 'release_api_admin_migration',
                                            'release_unpublished_components', 'release_recharge_flow', 'release'), 3):
            result = candidate.register(result, record(number, operation), [])
        self.assertEqual(len(result['pending']), 7)
        self.assertEqual(len(candidate.effective_candidates(result)['pending']), 7)

    def test_frozen_pending_prevents_supersession(self):
        self.registry['frozen'] = [self.old['batch']]
        with self.assertRaisesRegex(candidate.CandidateRejected, 'CANDIDATE_FROZEN'):
            candidate.register(self.registry, self.new, [replacement(self.old, self.new)])
        effective = candidate.effective_candidates(self.registry)
        self.assertEqual(effective['frozen'], [self.old])
        self.assertEqual(effective['retiredOnline'], [])

    def test_unknown_and_failed_workflows_never_grant_retirement(self):
        replacement_request = replacement(record(99), self.new)
        with self.assertRaisesRegex(candidate.CandidateRejected, 'UNKNOWN_SUPERSESSION'):
            candidate.register(self.registry, self.new, [replacement_request])
        bad = copy.deepcopy(self.registry)
        bad['batches'][self.old['batch']]['status'] = 'failed'
        with self.assertRaisesRegex(candidate.CandidateRejected, 'STATUS_INVALID'):
            candidate.validate_registry(bad)
        self.assertEqual(candidate.effective_candidates(self.registry)['retiredOnline'], [])

    def test_ancestry_commit_pair_and_approved_predicate_are_required(self):
        for field, value in [('ancestorCommit', 'a' * 40), ('descendantCommit', 'b' * 40),
                             ('approved', False), ('approved', 1), ('proofSha256', 'missing')]:
            instruction = replacement(self.old, self.new); instruction['ancestry'][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(candidate.CandidateRejected, 'ANCESTRY_NOT_VERIFIED'):
                candidate.register(self.registry, self.new, [instruction])

    def test_exact_policy_seed_can_be_retired_as_complete_batch(self):
        result = candidate.register(self.empty, self.new, [replacement(self.old, self.new, True)])
        self.assertEqual(candidate.effective_candidates(result)['retiredOnline'], [self.old])
        instruction = replacement(self.old, self.new, True); instruction['policySha256'] = 'd' * 64
        with self.assertRaisesRegex(candidate.CandidateRejected, 'POLICY_DRIFT'):
            candidate.register(self.empty, self.new, [instruction])

    def test_seed_cannot_overwrite_existing_pending_or_foreign_scope(self):
        with self.assertRaisesRegex(candidate.CandidateRejected, 'SEED_ALREADY_REGISTERED'):
            candidate.register(self.registry, self.new, [replacement(self.old, self.new, True)])
        other = record(3, 'release_admin')
        with self.assertRaisesRegex(candidate.CandidateRejected, 'CROSS_MODULE'):
            candidate.register(self.empty, self.new, [replacement(other, self.new, True)])

    def test_repeated_registration_is_idempotent_but_producer_cannot_change(self):
        self.assertEqual(candidate.register(self.registry, self.old, []), self.registry)
        changed = copy.deepcopy(self.old); changed['proofSha256'] = 'd' * 64
        with self.assertRaisesRegex(candidate.CandidateRejected, 'PRODUCER_REUSED'):
            candidate.register(self.registry, changed, [])
        instruction = replacement(self.old, self.new)
        result = candidate.register(self.registry, self.new, [instruction])
        self.assertEqual(candidate.register(result, self.new, [instruction]), result)
        with self.assertRaisesRegex(candidate.CandidateRejected, 'RETIRED_REUSE'):
            candidate.register(result, self.old, [])

    def test_retry_does_not_accept_new_unverified_or_unclosed_supersession(self):
        instruction = replacement(self.old, self.new)
        result = candidate.register(self.registry, self.new, [instruction])
        cases = []
        value = copy.deepcopy(instruction); value['basis'] = 'unverified'; cases.append(value)
        value = copy.deepcopy(instruction); value['ancestry']['approved'] = False; cases.append(value)
        value = copy.deepcopy(instruction); value['ancestry']['ancestorCommit'] = 'd' * 40; cases.append(value)
        value = copy.deepcopy(instruction); value['untrusted'] = True; cases.append(value)
        for value in cases:
            with self.assertRaises(candidate.CandidateRejected):
                candidate.register(result, self.new, [value])
        with self.assertRaises(candidate.CandidateRejected):
            candidate.register(result, self.new, [instruction, instruction])

    def test_exact_policy_seed_retry_is_idempotent(self):
        instruction = replacement(self.old, self.new, True)
        result = candidate.register(self.empty, self.new, [instruction])
        self.assertEqual(candidate.register(result, self.new, [instruction]), result)
        altered = copy.deepcopy(instruction)
        altered['record']['proofSha256'] = 'd' * 64
        with self.assertRaisesRegex(candidate.CandidateRejected, 'RETRY_DRIFT'):
            candidate.register(result, self.new, [altered])

    def test_duplicate_supersession_and_registry_bounds_reject(self):
        instruction = replacement(self.old, self.new)
        with self.assertRaisesRegex(candidate.CandidateRejected, 'DUPLICATE_SUPERSESSION'):
            candidate.register(self.registry, self.new, [instruction, instruction])
        with patch.object(candidate, 'MAX_RECORDS', 1), self.assertRaisesRegex(candidate.CandidateRejected, 'REGISTRY_BOUND'):
            candidate.register(self.registry, self.new, [instruction])

    def test_inconsistent_pending_index_frozen_entry_and_successor_reject(self):
        result = candidate.register(self.registry, self.new, [replacement(self.old, self.new)])
        cases = []
        value = copy.deepcopy(result); value['pending'] = {}; cases.append(value)
        value = copy.deepcopy(result); value['frozen'] = [record(99)['batch']]; cases.append(value)
        value = copy.deepcopy(result); value['batches'][self.old['batch']]['supersededBy'] = record(99)['batch']; cases.append(value)
        for value in cases:
            with self.assertRaises(candidate.CandidateRejected):
                candidate.validate_registry(value)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.record = record()
        self.registry = candidate.register(candidate.new_registry(POLICY), self.record, [])

    def test_exact_current_manifest_producer_and_all_candidate_ids_mark_published(self):
        result = candidate.publish(self.registry, self.record['batch'], publication(self.record))
        self.assertEqual(result['pending'], {})
        self.assertEqual(result['batches'][self.record['batch']]['status'], 'published')
        self.assertEqual(candidate.effective_candidates(result)['retiredOnline'], [])
        self.assertEqual(self.registry['batches'][self.record['batch']]['status'], 'pending')

    def test_publication_identity_drift_never_discards_pending(self):
        fields = {'commit': 'a' * 40, 'workflowRunId': '999', 'workflowRunAttempt': '2',
                  'candidateProofSha256': 'd' * 64, 'currentManifestSha256': 'bad'}
        for field, wrong in fields.items():
            proof = publication(self.record); proof[field] = wrong
            with self.subTest(field=field), self.assertRaises(candidate.CandidateRejected):
                candidate.publish(self.registry, self.record['batch'], proof)
        proof = publication(self.record); del proof['images']['api']
        with self.assertRaisesRegex(candidate.CandidateRejected, 'PUBLICATION_IMAGE_DRIFT'):
            candidate.publish(self.registry, self.record['batch'], proof)
        proof = publication(self.record); proof['images']['api'] = 'sha256:' + 'f' * 64
        with self.assertRaisesRegex(candidate.CandidateRejected, 'PUBLICATION_IMAGE_DRIFT'):
            candidate.publish(self.registry, self.record['batch'], proof)
        self.assertEqual(candidate.effective_candidates(self.registry)['pending'], [self.record])

    def test_successor_registration_does_not_retire_prior_publication(self):
        result = candidate.publish(self.registry, self.record['batch'], publication(self.record))
        new = record(2)
        result = candidate.register(result, new, [])
        self.assertEqual(result['batches'][self.record['batch']]['status'], 'published')
        self.assertEqual(candidate.effective_candidates(result)['retiredOnline'], [])
        result = candidate.publish(result, new['batch'], publication(new))
        self.assertEqual(result['batches'][self.record['batch']]['status'], 'retired')
        self.assertEqual(candidate.effective_candidates(result)['retiredOnline'], [self.record])

    def test_frozen_prior_publication_stays_protected_as_whole_record(self):
        result = candidate.publish(self.registry, self.record['batch'], publication(self.record))
        result['frozen'] = [self.record['batch']]
        new = record(2)
        result = candidate.register(result, new, [])
        result = candidate.publish(result, new['batch'], publication(new))
        self.assertEqual(result['batches'][self.record['batch']]['status'], 'published')
        self.assertEqual(candidate.effective_candidates(result)['frozen'], [self.record])
        self.assertEqual(candidate.effective_candidates(result)['retiredOnline'], [])

    def test_unknown_retired_and_unverified_publication_reject(self):
        with self.assertRaisesRegex(candidate.CandidateRejected, 'UNKNOWN_PUBLICATION'):
            candidate.publish(self.registry, record(99)['batch'], publication(record(99)))
        new = record(2)
        result = candidate.register(self.registry, new, [replacement(self.record, new)])
        with self.assertRaisesRegex(candidate.CandidateRejected, 'PUBLICATION_NOT_PENDING'):
            candidate.publish(result, self.record['batch'], publication(self.record))
        proof = publication(new); proof['workflowStatus'] = 'success'
        with self.assertRaises(candidate.CandidateRejected):
            candidate.publish(result, new['batch'], proof)

    def test_retry_exact_published_proof_is_idempotent(self):
        result = candidate.publish(self.registry, self.record['batch'], publication(self.record))
        self.assertEqual(candidate.publish(result, self.record['batch'], publication(self.record)), result)
        proof = publication(self.record); proof['currentManifestSha256'] = 'c' * 64
        with self.assertRaisesRegex(candidate.CandidateRejected, 'PUBLICATION_PROOF_DRIFT'):
            candidate.publish(result, self.record['batch'], proof)


class CompactionTests(unittest.TestCase):
    def setUp(self):
        self.old, self.new = record(), record(2)
        initial = candidate.register(candidate.new_registry(POLICY), self.old, [])
        self.registry = candidate.register(initial, self.new, [replacement(self.old, self.new)])

    def test_absent_whole_batch_compacts_without_losing_pending(self):
        result = candidate.compact_retired(self.registry, [absence(self.old)])
        self.assertNotIn(self.old['batch'], result['batches'])
        self.assertEqual(result['compacted'][self.old['batch']]['recordSha256'], candidate.record_sha256(self.old))
        self.assertEqual(candidate.effective_candidates(result)['pending'], [self.new])
        self.assertEqual(candidate.effective_candidates(result)['retiredOnline'], [])
        with self.assertRaisesRegex(candidate.CandidateRejected, 'PRODUCER_REUSED'):
            candidate.register(result, self.old, [])
        self.assertIn(self.old['batch'], self.registry['batches'])

    def test_missing_image_id_and_wrong_snapshot_cannot_compact(self):
        for field in ('absentImageIds', 'recordSha256', 'snapshotSha256'):
            proof = absence(self.old)
            proof[field] = proof[field][:-1]
            with self.subTest(field=field), self.assertRaises(candidate.CandidateRejected):
                candidate.compact_retired(self.registry, [proof])

    def test_pending_published_and_frozen_metadata_cannot_compact(self):
        with self.assertRaisesRegex(candidate.CandidateRejected, 'ABSENCE_NOT_RETIRED'):
            candidate.compact_retired(self.registry, [absence(self.new)])
        published = candidate.publish(self.registry, self.new['batch'], publication(self.new))
        with self.assertRaisesRegex(candidate.CandidateRejected, 'ABSENCE_NOT_RETIRED'):
            candidate.compact_retired(published, [absence(self.new)])
        self.registry['frozen'] = [self.old['batch']]
        with self.assertRaisesRegex(candidate.CandidateRejected, 'ABSENCE_NOT_RETIRED'):
            candidate.compact_retired(self.registry, [absence(self.old)])

    def test_compacted_chain_remains_valid_when_successor_later_retires(self):
        result = candidate.compact_retired(self.registry, [absence(self.old)])
        third = record(3)
        result = candidate.register(result, third, [replacement(self.new, third)])
        result = candidate.compact_retired(result, [absence(self.new)])
        self.assertEqual(len(result['compacted']), 2)
        self.assertEqual(candidate.effective_candidates(result)['pending'], [third])
        bad = copy.deepcopy(result)
        bad['compacted'][self.old['batch']]['supersededBy'] = self.old['batch']
        with self.assertRaises(candidate.CandidateRejected):
            candidate.validate_registry(bad)

    def test_return_values_and_nested_inputs_never_alias(self):
        original = copy.deepcopy(self.registry)
        value = candidate.validate_registry(self.registry)
        value['batches'][self.old['batch']]['record']['images']['api']['sizeBytes'] = 1
        effective = candidate.effective_candidates(self.registry)
        effective['pending'][0]['producer']['commit'] = 'f' * 40
        proof = absence(self.old); original_proof = copy.deepcopy(proof)
        candidate.compact_retired(self.registry, [proof])
        self.assertEqual(self.registry, original)
        self.assertEqual(proof, original_proof)


class NativeProtectionCompatibilityTests(unittest.TestCase):
    """Exercise the real existing collector without reading remote files/Docker."""

    @classmethod
    def setUpClass(cls):
        source = importlib.util.spec_from_file_location('candidate_native_cache', DIRECTORY / 'maintain-image-cache.py')
        cls.cache = importlib.util.module_from_spec(source)
        source.loader.exec_module(cls.cache)

    def setUp(self):
        self.paths = [self.cache.BASE / 'releases' / ('20261014T00000' + str(index) + 'Z-' + digit * 12)
                      for index, digit in enumerate(('a', 'b', 'c', 'd'))]
        self.ids = ['sha256:' + f'{number:064x}' for number in (3, 3, 2, 1)]
        self.rows = [{'commit': digit * 40, 'images': {'online-recharge': {'digest': self.ids[index]}}}
                     for index, digit in enumerate(('a', 'b', 'c', 'd'))]
        for index in range(3):
            self.rows[index].update(previousRelease=str(self.paths[index + 1]), previousCommit=self.rows[index + 1]['commit'])
        self.lookups = []

    def metadata(self, path, evidence):
        self.lookups.append(path)
        row = self.rows[self.paths.index(path)]
        evidence[str(path.relative_to(self.cache.BASE)) + '/release-manifest.json'] = hashlib.sha256(candidate.canonical(row)).hexdigest()
        return copy.deepcopy(row)

    def docker_identity(self, *arguments):
        self.assertEqual(arguments[:5], ('docker', 'image', 'inspect', '--format', '{{.Id}}'))
        return arguments[-1]

    def collect(self):
        with patch.object(Path, 'resolve', return_value=self.paths[0]), \
                patch.object(self.cache, 'release_metadata', side_effect=self.metadata), \
                patch.object(self.cache, 'observed_h_recovery_dependencies', return_value=set()), \
                patch.object(self.cache, 'historical_online_cold_dependencies', return_value=set()), \
                patch.object(self.cache, 'fixed_dependencies', return_value=set()), \
                patch.object(self.cache, 'read', side_effect=self.docker_identity):
            return self.cache.collect_dependencies(self.rows[0], self.rows[1])

    def test_online_distinct_rollback_skips_same_global_previous_and_keeps_only_first_different(self):
        result = self.collect()
        self.assertEqual(result['serviceRollback']['online-recharge'],
                         {'status': 'RETAINED', 'commit': self.rows[2]['commit'], 'imageId': self.ids[2]})
        self.assertEqual(result['imageIds'], [self.ids[2]])
        self.assertNotIn(self.paths[3], self.lookups)
        protected = self.cache.protected_images(self.rows[0], self.rows[1], set(), result)
        self.assertEqual(protected, {self.ids[0], self.ids[2]})
        self.assertNotIn(self.ids[3], protected)

    def test_first_online_introduction_does_not_guess_older_service_history(self):
        self.rows[1]['images'] = {'admin': {'digest': 'sha256:' + 'e' * 64}}
        result = self.collect()
        self.assertEqual(result['serviceRollback']['online-recharge'], {'status': 'NO_EARLIER_SERVICE_VERSION'})
        self.assertEqual(result['imageIds'], [])
        self.assertNotIn(self.paths[2], self.lookups)

    def test_unchanged_online_chain_has_no_distinct_predecessor(self):
        for row in self.rows:
            row['images']['online-recharge']['digest'] = self.ids[0]
        result = self.collect()
        self.assertEqual(result['serviceRollback']['online-recharge'], {'status': 'NO_DISTINCT_PREDECESSOR'})
        self.assertEqual(result['imageIds'], [])

    def test_incomplete_previous_chain_blocks_retention_instead_of_guessing(self):
        del self.rows[1]['previousRelease']
        with self.assertRaisesRegex(RuntimeError, 'chain is incomplete'):
            self.collect()

    def test_previous_cycle_blocks_retention_instead_of_guessing(self):
        self.rows[1].update(previousRelease=str(self.paths[0]), previousCommit=self.rows[0]['commit'])
        with self.assertRaisesRegex(RuntimeError, 'cycle'):
            self.collect()

    def test_current_previous_containers_explicit_rollback_and_dependencies_all_protect_online_ids(self):
        self.rows[1]['images']['online-recharge']['digest'] = self.ids[2]
        self.rows[0]['rollback'] = {'images': {'online-recharge': self.ids[3]}}
        container_id, dependency_id = 'sha256:' + 'e' * 64, 'sha256:' + 'f' * 64
        result = self.cache.protected_images(self.rows[0], self.rows[1], {container_id}, {'imageIds': [dependency_id]})
        self.assertEqual(result, {self.ids[0], self.ids[2], self.ids[3], container_id, dependency_id})


class PrivateFileTests(unittest.TestCase):
    def test_root_and_explicit_deployment_lock_are_required_before_io(self):
        with patch.object(candidate.os, 'geteuid', return_value=0), self.assertRaisesRegex(candidate.CandidateRejected, 'DEPLOYMENT_LOCK_REQUIRED'):
            candidate.read_registry('/opt/id-business-v2/candidate-registry.json', deployment_lock_held=False)
        with patch.object(candidate.os, 'geteuid', return_value=501), self.assertRaisesRegex(candidate.CandidateRejected, 'ROOT_REQUIRED'):
            candidate.write_registry('/opt/id-business-v2/candidate-registry.json', candidate.new_registry(POLICY), deployment_lock_held=True)

    def test_private_parent_rejects_non_root_or_group_writable_directory(self):
        for uid, mode in ((501, 0o755), (0, 0o775), (0, 0o777)):
            metadata = SimpleNamespace(st_mode=stat.S_IFDIR | mode, st_uid=uid)
            with self.subTest(uid=uid, mode=mode), patch.object(candidate.os, 'geteuid', return_value=0), \
                    patch.object(candidate.os, 'open', side_effect=[10, 11]), \
                    patch.object(candidate.os, 'fstat', return_value=metadata), \
                    patch.object(candidate.os, 'close'), self.assertRaisesRegex(candidate.CandidateRejected, 'DIRECTORY_INVALID'):
                candidate._private_directory('/opt/candidate.json', True)

    def test_directory_walk_always_uses_no_follow_and_never_traversal(self):
        metadata = SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0)
        with patch.object(candidate.os, 'geteuid', return_value=0), \
                patch.object(candidate.os, 'open', side_effect=[10, 11, 12]) as opened, \
                patch.object(candidate.os, 'fstat', return_value=metadata), patch.object(candidate.os, 'close'):
            self.assertEqual(candidate._private_directory('/opt/id-business-v2/candidate.json', True), (12, 'candidate.json'))
            self.assertTrue(all(call.args[1] & os.O_NOFOLLOW for call in opened.call_args_list))
        for path in ('relative.json', '/opt/../tmp/registry.json'):
            with patch.object(candidate.os, 'geteuid', return_value=0), self.assertRaisesRegex(candidate.CandidateRejected, 'PATH_INVALID'):
                candidate._private_directory(path, True)

    def test_private_file_rejects_symlink_hardlink_wrong_owner_and_mode(self):
        for mode, uid, links in ((stat.S_IFLNK | 0o600, 0, 1), (stat.S_IFREG | 0o600, 0, 2),
                                 (stat.S_IFREG | 0o600, 501, 1), (stat.S_IFREG | 0o644, 0, 1)):
            metadata = SimpleNamespace(st_mode=mode, st_uid=uid, st_nlink=links, st_size=10)
            with self.subTest(mode=mode, uid=uid, links=links), patch.object(candidate.os, 'stat', return_value=metadata), \
                    self.assertRaisesRegex(candidate.CandidateRejected, 'PRIVATE_FILE_INVALID'):
                candidate._file_metadata(10, 'candidate.json')

    def test_atomic_private_io_fsync_and_exact_round_trip(self):
        # Exercise the actual file/replace/fsync operations in this project;
        # root directory ownership is tested separately without requiring sudo.
        with tempfile.TemporaryDirectory(prefix='.candidate-retention-test-', dir=DIRECTORY) as folder:
            root = Path(folder)
            target = root / 'registry.json'
            original_stat = os.stat

            def directory(path, deployment_lock_held):
                self.assertTrue(deployment_lock_held)
                return os.open(root, os.O_RDONLY | os.O_DIRECTORY), Path(path).name

            def root_file_stat(*args, **kwargs):
                actual = original_stat(*args, **kwargs)
                return SimpleNamespace(st_mode=actual.st_mode, st_uid=0, st_nlink=actual.st_nlink,
                                       st_size=actual.st_size, st_dev=actual.st_dev, st_ino=actual.st_ino,
                                       st_mtime_ns=actual.st_mtime_ns, st_ctime_ns=actual.st_ctime_ns)

            value = candidate.register(candidate.new_registry(POLICY), record(), [])
            with patch.object(candidate, '_private_directory', side_effect=directory), \
                    patch.object(candidate.os, 'stat', side_effect=root_file_stat), \
                    patch.object(candidate.os, 'fsync', wraps=os.fsync) as synced:
                digest = candidate.write_registry(target, value, deployment_lock_held=True)
                self.assertEqual(len(digest), 64)
                self.assertEqual(candidate.read_registry(target, deployment_lock_held=True), value)
                self.assertEqual(stat.S_IMODE(original_stat(target).st_mode), 0o600)
                self.assertEqual(synced.call_count, 2)
                candidate.write_registry(target, value, deployment_lock_held=True)
                self.assertEqual(candidate.read_registry(target, deployment_lock_held=True), value)
            self.assertEqual([path.name for path in root.iterdir()], ['registry.json'])

    def test_duplicate_json_key_rejects(self):
        with self.assertRaisesRegex(candidate.CandidateRejected, 'DUPLICATE_JSON_KEY'):
            json.loads('{"version":1,"version":1}', object_pairs_hook=candidate._unique_json)


if __name__ == '__main__':
    unittest.main()
