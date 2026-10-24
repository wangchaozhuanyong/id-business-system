import base64
import ast
import copy
import gzip
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('release_storage_transport', HERE / 'release-storage.py')
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)
candidate = storage.candidate_module()
COMMIT = 'a' * 40
TREE = 'b' * 40
# These fixtures exercise the preserved historical ONLINE protocol. Current
# ordinary-component coverage below uses the authenticated current predecessor.
BASELINE = '0a03fa28e6b844a18833d5c63f1de700f091fc64'
POLICY = 'd' * 64
SOURCE = 'e' * 64
COMMAND = '00000000-0000-0000-0000-000000000001'


class ProjectTemporaryDirectory(tempfile.TemporaryDirectory):
    def __init__(self):
        directory = storage.PROJECT / '.runtime'
        directory.mkdir(mode=0o700, exist_ok=True)
        super().__init__(prefix='release-storage-test-', dir=directory)


def environment(operation='release_online_recharge'):
    return {'RELEASE_OPERATION': operation, 'RELEASE_COMMIT': COMMIT, 'SOURCE_TREE': TREE,
            'GITHUB_RUN_ID': '900', 'GITHUB_RUN_ATTEMPT': '2', 'QUALITY_RUN_ID': '800',
            'EXPECTED_CURRENT': BASELINE, 'RELEASE_REPOSITORY': storage.REPOSITORY,
            'GITHUB_REPOSITORY': storage.GITHUB_REPOSITORY, 'PRODUCTION_INSTANCE_ID': storage.INSTANCE,
            'AWS_REGION': storage.REGION, 'GITHUB_REF': 'refs/heads/main', 'HISTORICAL_EXCEPTION': 'none',
            'RELEASE_ADMIN_ONLY': 'false'}


def selected(operation='release_online_recharge'):
    return storage.selection(environment(operation))


def proof(operation='release_online_recharge'):
    value = selected(operation)
    result = {'version': 1, 'commit': COMMIT, 'sourceTree': TREE}
    scope = storage.PROOFS[operation][1]
    if scope is not None:
        result['scope'] = scope
    roles = candidate.OPERATION_SCOPES[operation][1]
    images = {role: {'reference': storage.REPOSITORY + ':' + value['batch'] + '-' + role,
                     'imageId': 'sha256:' + f'{number:064x}', 'fileCount': 1, 'sha256': 'f' * 64}
              for number, role in enumerate(sorted(roles), 1)}
    if operation in ('release_admin', 'release_unpublished_components', 'release_recharge_flow'):
        result.update(runId='900', runAttempt='2', qualityRunId='800')
    if operation == 'release_admin':
        row = images['admin']
        result['image'] = {key: row[key] for key in ('reference', 'imageId')}
    else:
        result['images'] = images
    return result


def record(operation='release_online_recharge', commit=COMMIT, tree=TREE, run='900'):
    roles = candidate.OPERATION_SCOPES[operation][1]
    producer = {'commit': commit, 'sourceTree': tree, 'workflowRunId': run, 'workflowRunAttempt': '2'}
    batch = commit + '-' + run + '-2'
    return {'kind': candidate.RECORD_KIND, 'version': 1, 'batch': batch,
            'module': candidate.OPERATION_SCOPES[operation][0], 'operation': operation,
            'producer': producer, 'qualityRunId': '800', 'proofSha256': storage.digest(proof(operation)),
            'images': {role: {'reference': storage.REPOSITORY + ':' + batch + '-' + role,
                             'imageId': 'sha256:' + f'{number:064x}', 'sizeBytes': 1024**3,
                             'compressedBytes': 100 * 1024**2}
                       for number, role in enumerate(sorted(roles), 1)}}


def remote_result(phase='before-build'):
    value = {'status': 'APPLIED', 'phase': phase, 'policySha256': POLICY,
             'freeBytesAfter': 12 * 1024**3}
    if phase == 'before-build':
        value.update(pendingRecords=[], seedRecords=[])
    elif phase == 'before-pull':
        value['capacityVerified'] = True
    else:
        value['publicationVerified'] = True
    return value


def invocation(result=None):
    return {'CommandId': COMMAND, 'InstanceId': storage.INSTANCE, 'DocumentName': 'AWS-RunShellScript',
            'PluginName': 'aws:runShellScript', 'Status': 'Success', 'ResponseCode': 0,
            'StandardOutputContent': json.dumps(result or remote_result()), 'StandardErrorContent': ''}


class SelectionTests(unittest.TestCase):
    def test_current_normal_operation_set_and_producer_are_exact(self):
        for operation in storage.OPERATIONS:
            with self.subTest(operation=operation):
                value = storage.selection(environment(operation))
                self.assertEqual(value['producer'], {'commit': COMMIT, 'sourceTree': TREE,
                    'workflowRunId': '900', 'workflowRunAttempt': '2'})
                self.assertEqual(value['batch'], COMMIT + '-900-2')

    def test_verification_removed_registration_and_prepare_never_mutate(self):
        for operation in ('verify_online_recharge', 'release_api_registration', 'prepare_order_archive_release'):
            with self.subTest(operation=operation), self.assertRaises(storage.StorageRejected):
                storage.selection(environment(operation))

    def test_historical_reused_wrong_project_and_injection_fail_closed(self):
        for key, altered in (('HISTORICAL_EXCEPTION', 'recharge-pro-974-20261007'),
                             ('REUSE_IMAGE_RUN', '123'), ('REUSE_IMAGE_COMMIT', COMMIT),
                             ('GITHUB_REPOSITORY', 'other/project'), ('AWS_REGION', 'other'),
                             ('SOURCE_TREE', TREE + '; token'), ('QUALITY_RUN_ID', '0'),
                             ('GITHUB_RUN_ATTEMPT', True), ('GITHUB_REF', 'refs/heads/feature')):
            value = environment(); value[key] = altered
            with self.subTest(key=key), self.assertRaises(storage.StorageRejected):
                storage.selection(value)

    def test_git_tree_main_and_exact_successful_quality_run(self):
        commands = Mock()
        commands.git.side_effect = [(0, (COMMIT+'\n').encode()), (0, (TREE+'\n').encode()),
                                    (0, (COMMIT+'\trefs/heads/main\n').encode())]
        commands.quality.return_value = {'id': 800, 'head_sha': COMMIT, 'head_branch': 'main',
            'event': 'push', 'status': 'completed', 'conclusion': 'success', 'path': '.github/workflows/quality.yml'}
        storage.verify_source(selected(), commands)
        commands.quality.assert_called_once_with('800')
        for field, bad in (('head_sha', BASELINE), ('head_branch', 'feature'), ('event', 'pull_request'),
                           ('conclusion', 'failure'), ('id', 801), ('path', '.github/workflows/other.yml')):
            client = Mock()
            client.git.side_effect = [(0, (COMMIT+'\n').encode()), (0, (TREE+'\n').encode()),
                                     (0, (COMMIT+'\trefs/heads/main\n').encode())]
            client.quality.return_value = {**commands.quality.return_value, field: bad}
            with self.subTest(field=field), self.assertRaisesRegex(storage.StorageRejected, 'QUALITY_NOT_BOUND'):
                storage.verify_source(selected(), client)

    def test_after_publication_need_not_assert_main_has_not_advanced(self):
        client = Mock()
        client.git.side_effect = [(0, (COMMIT+'\n').encode()), (0, (TREE+'\n').encode())]
        client.quality.return_value = {'id': 800, 'head_sha': COMMIT, 'head_branch': 'main',
            'event': 'push', 'status': 'completed', 'conclusion': 'success', 'path': '.github/workflows/quality.yml'}
        storage.verify_source(selected(), client, require_main=False)
        self.assertEqual(client.git.call_count, 2)


class CandidateTests(unittest.TestCase):
    def test_each_real_proof_maps_exact_complete_service_set(self):
        for operation in storage.PROOFS:
            with self.subTest(operation=operation):
                module, images = storage.proof_images(selected(operation), proof(operation))
                self.assertEqual(module, candidate.OPERATION_SCOPES[operation][0])
                self.assertEqual(set(images), candidate.OPERATION_SCOPES[operation][1])

    def test_online_pending_workspace_and_after_bit_versions_are_supported(self):
        for version in (1, 2, 3):
            value = proof(); value['version'] = version
            storage.proof_images(selected(), value)

    def test_missing_component_bad_tag_scope_or_producer_cannot_replace(self):
        values = []
        value = proof(); del value['images']['migrate']; values.append(value)
        value = proof(); value['images']['api']['reference'] += 'other'; values.append(value)
        value = proof(); value['sourceTree'] = BASELINE; values.append(value)
        value = proof(); value['scope'] = 'OTHER'; values.append(value)
        for value in values:
            with self.subTest(value=value), self.assertRaises(storage.StorageRejected):
                storage.proof_images(selected(), value)
        value = proof('release_admin'); value['runId'] = '899'
        with self.assertRaisesRegex(storage.StorageRejected, 'BUILD_PRODUCER_DRIFT'):
            storage.proof_images(selected('release_admin'), value)

    def test_same_module_supersession_requires_real_git_ancestry_and_prior_tree(self):
        old = record(commit=BASELINE, tree='f'*40, run='1000')
        before = {**remote_result(), 'pendingRecords': [old]}
        client = Mock(); client.git.side_effect = [(0, ('f'*40+'\n').encode()), (0, b'')]
        result = storage.supersedes(record(), before, client)
        self.assertEqual(result[0]['batch'], old['batch'])
        self.assertEqual(result[0]['basis'], 'pending')
        self.assertEqual(result[0]['ancestry']['ancestorCommit'], BASELINE)
        self.assertEqual(result[0]['ancestry']['descendantCommit'], COMMIT)
        self.assertTrue(result[0]['ancestry']['approved'])
        # The old run is numerically greater. That does not invent chronology:
        # only the explicit ancestry predicate grants supersession.
        client.git.assert_any_call('merge-base', '--is-ancestor', BASELINE, COMMIT, limit=200, allowed=(0, 1))

    def test_other_module_pending_is_preserved_without_git_guess(self):
        client = Mock()
        self.assertEqual(storage.supersedes(record(), {**remote_result(),
            'pendingRecords': [record('release_admin')]}, client), [])
        client.git.assert_not_called()

    def test_nonancestor_wrong_tree_seed_or_duplicate_module_reject(self):
        old = record(commit=BASELINE, tree='f'*40, run='1000')
        for responses in (((0, ('f'*40+'\n').encode()), (1, b'')), ((0, (TREE+'\n').encode()),)):
            client = Mock(); client.git.side_effect = responses
            with self.subTest(responses=responses), self.assertRaises(storage.StorageRejected):
                storage.supersedes(record(), {**remote_result(), 'pendingRecords': [old]}, client)
        with self.assertRaises(storage.StorageRejected):
            storage.supersedes(record(), {**remote_result(), 'seedRecords': [old]}, Mock())
        with self.assertRaisesRegex(storage.StorageRejected, 'DUPLICATE_PENDING_MODULE'):
            storage.supersedes(record(), {**remote_result(), 'pendingRecords': [record(), record()]}, Mock())

    def test_same_batch_is_idempotent_but_proof_drift_is_not(self):
        client = Mock()
        self.assertEqual(storage.supersedes(record(), {**remote_result(), 'pendingRecords': [record()]}, client), [])
        altered = record(); altered['proofSha256'] = '1'*64
        with self.assertRaisesRegex(storage.StorageRejected, 'REGISTERED_RECORD_DRIFT'):
            storage.supersedes(record(), {**remote_result(), 'pendingRecords': [altered]}, client)
        client.git.assert_not_called()

    def test_full_release_constructs_proof_from_real_images_and_selector(self):
        value = selected('release')
        identity = 'sha256:' + '1'*64
        client = Mock()
        client.run.side_effect = [(0, b'false\n'), *[(0, json.dumps(identity).encode())]*5]
        def measured(reference, expected, _selection, _commands):
            return {'reference': reference, 'imageId': expected, 'sizeBytes': 1024**3, 'compressedBytes': 100}
        with patch.object(storage, 'image_measurement', side_effect=measured):
            value = storage.build_record(value, client)
        self.assertEqual(value['operation'], 'release')
        self.assertEqual(value['module'], 'full-release')
        self.assertEqual(set(value['images']), {'api', 'admin', 'migrate', 'auto-recharge', 'media-resolver'})
        candidate.validate_record(value)

    def test_full_release_environment_cannot_shrink_a_five_image_build(self):
        value = selected('release'); value['adminOnly'] = 'true'
        client = Mock(); client.run.return_value = (0, b'false\n')
        with self.assertRaisesRegex(storage.StorageRejected, 'NORMAL_BUILD_SELECTION_DRIFT'):
            storage.build_record(value, client)
        self.assertEqual(client.run.call_count, 1)

    def test_source_archive_bound_and_tar_measurement_are_real(self):
        client = Mock(); client.archive_size.return_value = 10240
        self.assertEqual(storage.source_archive_bytes(selected(), client), 10240)
        client.archive_size.assert_called_once_with(COMMIT)
        for size in (0, True, 100, storage.MAX_SOURCE_ARCHIVE + 512):
            client.archive_size.return_value = size
            with self.subTest(size=size), self.assertRaises(storage.StorageRejected):
                storage.source_archive_bytes(selected(), client)


class EcrIdentityTests(unittest.TestCase):
    def setUp(self):
        self.selected = selected()
        self.reference = storage.REPOSITORY + ':' + self.selected['batch'] + '-api'
        self.identity = 'sha256:' + '1'*64
        self.runner = {'Id': self.identity, 'Size': 4096, 'Architecture': 'amd64',
            'Labels': {'org.opencontainers.image.revision': COMMIT, 'id-business-v2.source-tree': TREE}}
        self.manifest = {'schemaVersion': 2, 'config': {'digest': self.identity, 'size': 10},
            'layers': [{'digest': 'sha256:'+'2'*64, 'size': 20}, {'digest': 'sha256:'+'3'*64, 'size': 30}]}

    def remote(self):
        raw = storage.canonical(self.manifest).decode()
        return {'failures': [], 'images': [{'registryId': '098208446664',
            'repositoryName': 'id-business-v2-release', 'imageId': {
                'imageTag': self.reference.split(':', 1)[1],
                'imageDigest': 'sha256:' + storage.hashlib.sha256(raw.encode()).hexdigest()}, 'imageManifest': raw}]}

    def client(self):
        client = Mock(); client.run.return_value = (0, storage.canonical(self.runner)); client.aws.return_value = self.remote()
        return client

    def test_remote_manifest_config_matches_local_id_and_sizes_stay_distinct(self):
        value = storage.image_measurement(self.reference, self.identity, self.selected, self.client())
        self.assertEqual(value['sizeBytes'], 4096)
        self.assertEqual(value['compressedBytes'], 60)
        self.assertEqual(value['imageId'], self.identity)

    def test_manifest_digest_is_not_mistaken_for_docker_image_id(self):
        client = self.client()
        self.assertNotEqual(client.aws.return_value['images'][0]['imageId']['imageDigest'], self.identity)
        storage.image_measurement(self.reference, self.identity, self.selected, client)
        self.manifest['config']['digest'] = 'sha256:'+'4'*64
        with self.assertRaisesRegex(storage.StorageRejected, 'ECR_CONFIG_DRIFT'):
            storage.image_measurement(self.reference, self.identity, self.selected, self.client())

    def test_ecr_partial_tag_digest_or_size_drift_rejects(self):
        for field in ('missing', 'extra', 'foreign', 'digest', 'tag'):
            client = self.client()
            remote = client.aws.return_value
            if field == 'missing': remote['failures'] = [{'failureCode': 'ImageNotFound'}]
            if field == 'extra': remote['images'] *= 2
            if field == 'foreign': remote['images'][0]['registryId'] = '000000000000'
            if field == 'digest': remote['images'][0]['imageId']['imageDigest'] = self.identity
            if field == 'tag': remote['images'][0]['imageId']['imageTag'] += '-other'
            with self.subTest(field=field), self.assertRaises(storage.StorageRejected):
                storage.image_measurement(self.reference, self.identity, self.selected, client)
        for bad in (True, 0, -1, 1024**4 + 1):
            self.manifest['layers'][0]['size'] = bad
            with self.subTest(bad=bad), self.assertRaisesRegex(storage.StorageRejected, 'ECR_SIZE_INVALID'):
                storage.image_measurement(self.reference, self.identity, self.selected, self.client())

    def test_wrong_runner_revision_tree_architecture_or_size_rejects_before_ecr(self):
        for field, bad in (('Id', 'sha256:'+'4'*64), ('Architecture', 'arm64'), ('Size', True)):
            client = self.client()
            altered = {**self.runner, field: bad}; client.run.return_value = (0, storage.canonical(altered))
            with self.subTest(field=field), self.assertRaisesRegex(storage.StorageRejected, 'RUNNER_IMAGE_DRIFT'):
                storage.image_measurement(self.reference, self.identity, self.selected, client)
            client.aws.assert_not_called()
        for label in ('org.opencontainers.image.revision', 'id-business-v2.source-tree'):
            altered = copy.deepcopy(self.runner); altered['Labels'][label] = BASELINE
            client = self.client(); client.run.return_value = (0, storage.canonical(altered))
            with self.subTest(label=label), self.assertRaises(storage.StorageRejected):
                storage.image_measurement(self.reference, self.identity, self.selected, client)

    def test_normal_release_accepts_missing_tree_label_only_with_real_revision(self):
        del self.runner['Labels']['id-business-v2.source-tree']
        storage.image_measurement(self.reference, self.identity, selected('release'), self.client())
        self.runner['Labels']['id-business-v2.source-tree'] = BASELINE
        with self.assertRaises(storage.StorageRejected):
            storage.image_measurement(self.reference, self.identity, selected('release'), self.client())


class TransportTests(unittest.TestCase):
    def test_short_native_command_uses_fixed_installed_paths_and_closed_event(self):
        event = {'record': record(), 'supersedes': [], 'sourceArchiveBytes': 10240}
        params = storage.remote_parameters('before-pull', BASELINE, SOURCE, event)
        command = params['commands'][0]
        words = shlex.split(command)
        self.assertIn(storage.NATIVE, words)
        self.assertIn(storage.CONFIG, words)
        self.assertNotIn('curl', words)
        self.assertNotIn('docker', words)
        self.assertEqual(json.loads(base64.b64decode(words[words.index('--event-base64')+1])), event)
        self.assertLess(len(command.encode()), 32*1024)

    def test_before_build_encodes_json_null_not_empty_object(self):
        words = shlex.split(storage.remote_parameters('before-build', BASELINE, SOURCE, None)['commands'][0])
        self.assertIsNone(json.loads(base64.b64decode(words[-1])))

    def test_wrong_phase_sha_or_oversized_event_never_dispatches(self):
        for phase, sha, event in (('unknown', SOURCE, None), ('before-build', 'bad', None),
                                   ('before-pull', SOURCE, {'oversized': 'x'*25000})):
            with self.subTest(phase=phase), self.assertRaises(storage.StorageRejected):
                storage.remote_parameters(phase, BASELINE, sha, event)

    def client(self, directory, responses):
        commands = Mock(); commands.aws.side_effect = responses
        client = storage.LifecycleClient(commands, sleep=lambda _: None, monotonic=lambda: 0)
        return client, commands

    def dispatch(self):
        return {'Command': {'CommandId': COMMAND, 'InstanceIds': [storage.INSTANCE], 'DocumentName': 'AWS-RunShellScript'}}

    def test_exact_ssm_terminal_receipt_persists_private_intent_and_reuses_result(self):
        with ProjectTemporaryDirectory() as temporary:
            directory = Path(temporary)
            client, commands = self.client(directory, [self.dispatch(), invocation()])
            params = storage.remote_parameters('before-build', BASELINE, SOURCE, None)
            self.assertEqual(client.execute('before-build', params, directory, POLICY), remote_result())
            self.assertEqual(commands.aws.call_count, 2)
            for path in directory.iterdir():
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(client.execute('before-build', params, directory, POLICY), remote_result())
            self.assertEqual(commands.aws.call_count, 2)

    def test_accepted_result_unknown_resumes_polling_without_second_send(self):
        with ProjectTemporaryDirectory() as temporary:
            directory = Path(temporary)
            client, commands = self.client(directory, [self.dispatch(), storage.StorageRejected('STORAGE_AWS_FAILED')])
            params = storage.remote_parameters('before-build', BASELINE, SOURCE, None)
            with self.assertRaises(storage.StorageRejected): client.execute('before-build', params, directory, POLICY)
            commands.aws.side_effect = [invocation()]
            self.assertEqual(client.execute('before-build', params, directory, POLICY), remote_result())
            self.assertEqual(commands.aws.call_count, 3)
            self.assertEqual(commands.aws.call_args.args[:2], ('ssm', 'get-command-invocation'))

    def test_send_response_loss_never_repeats_non_idempotent_send(self):
        with ProjectTemporaryDirectory() as temporary:
            directory = Path(temporary)
            client, commands = self.client(directory, [storage.StorageRejected('STORAGE_AWS_FAILED')])
            params = storage.remote_parameters('before-build', BASELINE, SOURCE, None)
            with self.assertRaises(storage.StorageRejected): client.execute('before-build', params, directory, POLICY)
            with self.assertRaisesRegex(storage.StorageRejected, 'SEND_RESULT_UNKNOWN'):
                client.execute('before-build', params, directory, POLICY)
            self.assertEqual(commands.aws.call_count, 1)

    def test_terminal_wrong_identity_nonzero_failed_or_unbound_output_rejects(self):
        for key, bad in (('CommandId', '00000000-0000-0000-0000-000000000002'),
                          ('InstanceId', 'i-other'), ('DocumentName', 'Other'), ('PluginName', 'Other'),
                          ('ResponseCode', True), ('ResponseCode', 1), ('Status', 'Failed'),
                          ('StandardOutputContent', 'secret-token-untrusted-output')):
            with self.subTest(key=key), ProjectTemporaryDirectory() as temporary:
                response = invocation(); response[key] = bad
                directory = Path(temporary); client, commands = self.client(directory, [self.dispatch(), response])
                with self.assertRaises(storage.StorageRejected):
                    client.execute('before-build', storage.remote_parameters('before-build', BASELINE, SOURCE, None), directory, POLICY)
                self.assertFalse((directory/'before-build.result.json').exists())
        with self.assertRaisesRegex(storage.StorageRejected, 'NATIVE_CAPACITY_UNVERIFIED'):
            storage.validate_native({**remote_result('before-pull'), 'capacityVerified': False}, 'before-pull', POLICY)
        with self.assertRaisesRegex(storage.StorageRejected, 'NATIVE_PUBLICATION_UNVERIFIED'):
            storage.validate_native({**remote_result('after-publish'), 'publicationVerified': False}, 'after-publish', POLICY)

    def test_existing_acceptance_cannot_be_rebound_to_different_event(self):
        with ProjectTemporaryDirectory() as temporary:
            directory = Path(temporary)
            client, commands = self.client(directory, [self.dispatch(), storage.StorageRejected('STORAGE_AWS_FAILED')])
            params = storage.remote_parameters('before-build', BASELINE, SOURCE, None)
            with self.assertRaises(storage.StorageRejected): client.execute('before-build', params, directory, POLICY)
            changed = storage.remote_parameters('before-build', COMMIT, SOURCE, None)
            with self.assertRaisesRegex(storage.StorageRejected, 'ACCEPTED_COMMAND_DRIFT'):
                client.execute('before-build', changed, directory, POLICY)
            self.assertEqual(commands.aws.call_count, 2)

    def test_json_duplicate_and_nonfinite_metadata_reject(self):
        for raw in ('{"id":1,"id":2}', '{"id":NaN}', '{"id":Infinity}', 'invalid'):
            with self.subTest(raw=raw), self.assertRaises(storage.StorageRejected): storage.closed(raw)


class LifecycleTests(unittest.TestCase):
    def lifecycle_context(self, directory):
        return (patch.object(storage, 'verify_source'),
                patch.object(storage, 'policy_binding', return_value=(SOURCE, POLICY)),
                patch.object(storage, 'output_directory', return_value=directory))

    def test_before_build_precedes_proof_and_never_invokes_docker(self):
        with ProjectTemporaryDirectory() as temporary:
            directory = Path(temporary); commands = Mock(); client = Mock()
            client.execute.return_value = remote_result()
            first, second, third = self.lifecycle_context(directory)
            with first, second, third, patch.object(storage, 'build_record') as build:
                self.assertEqual(storage.lifecycle('before-build', environment(), commands, client), remote_result())
                build.assert_not_called()
            words = shlex.split(client.execute.call_args.args[1]['commands'][0])
            self.assertEqual(words[words.index('--expected-current')+1], BASELINE)

    def test_before_pull_requires_before_build_record_and_real_archive_measurement(self):
        with ProjectTemporaryDirectory() as temporary:
            directory = Path(temporary); commands = Mock(); client = Mock()
            client.execute.return_value = remote_result('before-pull')
            storage.save(directory/'before-build.result.json', {'result': remote_result()})
            first, second, third = self.lifecycle_context(directory)
            with first, second, third, patch.object(storage, 'build_record', return_value=record()), \
                 patch.object(storage, 'source_archive_bytes', return_value=10240):
                storage.lifecycle('before-pull', environment(), commands, client)
            words = shlex.split(client.execute.call_args.args[1]['commands'][0])
            event = json.loads(base64.b64decode(words[-1]))
            self.assertEqual(event, {'record': record(), 'supersedes': [], 'sourceArchiveBytes': 10240})
            self.assertEqual(storage.closed(storage.read_file(directory/'candidate.json', private=True)), record())

    def test_after_publish_independent_native_current_uses_new_commit(self):
        with ProjectTemporaryDirectory() as temporary:
            directory = Path(temporary); commands = Mock(); client = Mock()
            client.execute.return_value = remote_result('after-publish')
            storage.save(directory/'candidate.json', record())
            first, second, third = self.lifecycle_context(directory)
            original = storage.read_file
            with first, second, third, patch.object(storage, 'validate_readback') as readback, \
                 patch.object(storage, 'read_file', wraps=storage.read_file) as read, \
                 patch.object(storage, 'digest', wraps=storage.digest):
                def files(path, *args, **kwargs):
                    if str(path).endswith('online-recharge-build-proof.json'):
                        return storage.canonical(proof())
                    return original(path, *args, **kwargs)
                read.side_effect = files
                storage.lifecycle('after-publish', environment(), commands, client)
                readback.assert_called_once()
            words = shlex.split(client.execute.call_args.args[1]['commands'][0])
            self.assertEqual(words[words.index('--expected-current')+1], COMMIT)
            self.assertEqual(json.loads(base64.b64decode(words[-1])), {'record': record()})

    def test_unavailable_installation_or_changed_policy_source_never_returns_success(self):
        with patch.object(storage, 'read_file', side_effect=storage.StorageRejected('STORAGE_FILE_UNAVAILABLE')):
            with self.assertRaises(storage.StorageRejected): storage.policy_binding()
        with patch.object(storage, 'read_file', side_effect=[storage.canonical({'sourceSha256': SOURCE}), b'changed']):
            with self.assertRaisesRegex(storage.StorageRejected, 'NATIVE_SOURCE_DRIFT'): storage.policy_binding()


class ExistingReadbackContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        def load(name, filename):
            spec = importlib.util.spec_from_file_location(name, HERE / filename)
            module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
            return module
        cls.online = load('storage_existing_online_scope_tests', 'online-recharge-scope.test.py')
        cls.workspace = load('storage_existing_workspace_transport_tests', 'api-admin-readonly.test.py')

    def files(self, root, mapping):
        original = storage.read_file
        def read(path, *arguments, **keywords):
            relative = Path(path).relative_to(root).as_posix()
            if relative in mapping:
                return storage.canonical(mapping[relative])
            return original(path, *arguments, **keywords)
        return read

    def test_real_online_summary_validator_omits_running_flag_and_command_id(self):
        module = self.online
        build = module.proof()
        value = record()
        for role, row in value['images'].items():
            build['images'][role].update(reference=row['reference'], imageId=row['imageId'])
        value['proofSha256'] = storage.digest(build)
        services = module.states(True)
        for role in module.scope.UPDATED:
            services[role].update(image=value['images'][role]['imageId'], reference=value['images'][role]['reference'])
        native = {'status': 'ONLINE_RECHARGE_VERIFIED', 'commit': COMMIT, 'sourceTree': TREE,
            'services': services, 'servicesUpdated': list(module.scope.UPDATED),
            'preservedServiceCount': len(module.scope.PRESERVED), 'runningImagesAndContentMatched': True,
            'migrationApplied': True, 'migrationPerformed': True,
            'migration': {'name': module.scope.MIGRATION_NAME, 'sha256': module.scope.MIGRATION_IDENTITY['sha256'],
                'status': 'APPLIED', 'schemaVerified': True, 'appliedMigrationsSha256': 'f'*64},
            'existingEnvironmentPreserved': True, 'credentialsLoopback': True, 'backupVerified': True,
            'workspaceBackupVerified': True, 'workspaceVolumePreserved': True,
            'legacyWorkersPublished': False, 'externalAcceptancePerformed': False,
            'dedicatedVolume': module.scope.MEDIA_VOLUME, 'checkCount': 49, 'violationCount': 0,
            'buildProofSha256': value['proofSha256']}
        summary = module.scope.validate_receipt(module.controller(), native, 'readback', COMMIT, COMMIT)
        self.assertNotIn('runningImagesAndContentMatched', summary)
        self.assertNotIn('commandId', summary)
        # These are precisely the fields added by online-recharge-readonly.validate
        # and pending_workspace_client_binding after the real scope summary.
        summary.update(services=services, releaseCandidateCommit=COMMIT, workflowRunId='900', workflowRunAttempt='2')
        root = storage.PROJECT
        mapping = {'.deploy/production-release/online-recharge-readback-result.json': summary,
                   '.deploy/production-release/online-recharge-readback-command.json': {'commandId': COMMAND}}
        with patch.object(storage, 'read_file', side_effect=self.files(root, mapping)), \
             patch.object(Path, 'exists', return_value=False):
            storage.validate_readback(selected(), value)
        mapping['.deploy/production-release/online-recharge-readback-invocation.json'] = invocation()
        with patch.object(storage, 'read_file', side_effect=self.files(root, mapping)), \
             patch.object(Path, 'exists', return_value=True):
            storage.validate_readback(selected(), value)
        summary['services']['api']['image'] = 'sha256:' + '9'*64
        with patch.object(storage, 'read_file', side_effect=self.files(root, mapping)), \
             patch.object(Path, 'exists', return_value=True), \
             self.assertRaisesRegex(storage.StorageRejected, 'READBACK_IMAGE_DRIFT'):
            storage.validate_readback(selected(), value)

    def test_actual_after_bit_proof_and_exact_version_three_contract_are_admitted(self):
        # Consume the sealed, actual failed producer proof already embedded in
        # the existing ONLINE source. It is fixture data, never publication input.
        build = json.loads(self.online.scope._RESTORED_B_WITNESS['failedBuildProof'])
        witness = self.online.scope._RESTORED_B_WITNESS['policy']['failedProducer']
        value = selected(); value.update(producer=witness,
            batch='-'.join(witness[key] for key in ('commit', 'workflowRunId', 'workflowRunAttempt')))
        module, images = storage.proof_images(value, build)
        self.assertEqual(module, 'online-recharge')
        self.assertEqual(set(images), {'api', 'admin', 'migrate', 'online-recharge'})
        # The current native _restored_workspace_build_shape adds exactly these
        # two SHA fields to the historical version-two public build metadata.
        changed = {**build, 'version': 3, 'restorationSha256': '1'*64, 'beforeServicesSha256': '2'*64}
        storage.proof_images(value, changed)

    def test_existing_workspace_fixture_passes_original_validator_and_storage_readback(self):
        fixture = self.workspace.WorkspaceSuccessorReceiptTests()
        fixture.setUp()
        build, native = fixture.full_readback_contract()
        # Exercise the existing complete receipt validator first, as its own
        # fixture does. No native service, Docker or database is invoked.
        def read_text(path):
            return json.dumps(build if path.name == fixture.namespace['PROOF_FILE'] else fixture.before)
        with patch.object(Path, 'is_file', return_value=True), patch.object(Path, 'read_text', read_text), \
             patch.object(Path, 'read_bytes', lambda path: read_text(path).encode()), \
             patch.dict(os.environ, fixture.environment, clear=True):
            validated = self.workspace.transport.validate_receipt(native, COMMIT, 'readback', 'API_ADMIN_WORKSPACE')
        self.assertIs(validated, native)
        value = record('release_api_workspace')
        for role, row in value['images'].items():
            native['services'][role].update(image=row['imageId'], reference=row['reference'])
        native.update(buildProofSha256=value['proofSha256'], commandId=COMMAND,
                      workflowRunId='900', workflowRunAttempt='2', releaseCandidateCommit=COMMIT)
        mapping = {'.deploy/production-release/api-workspace-readback-result.json': native}
        with patch.object(storage, 'read_file', side_effect=self.files(storage.PROJECT, mapping)):
            storage.validate_readback(selected('release_api_workspace'), value)


class OrdinaryComponentStorageTests(unittest.TestCase):
    """Real source/proof/storage files and validators; external systems are fixtures."""

    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('storage_component_lifecycle_fixture',
            HERE / 'online-recharge-component-lifecycle.test.py')
        cls.module = importlib.util.module_from_spec(spec); spec.loader.exec_module(cls.module)
        cls.module.ContinuousLifecycleTests.setUpClass()

    def setUp(self):
        self.fixture = self.module.ContinuousLifecycleTests()
        self.fixture.setUp(); self.addCleanup(self.fixture.doCleanups)
        self.online = self.module.client
        self.root = self.fixture.directory
        self.source_sha256, self.policy_sha256 = storage.policy_binding()
        for patcher in (
            patch.object(storage, 'PROJECT', self.root),
            patch.object(storage, 'OUTPUT', self.root / '.deploy/production-release/storage'),
            patch.object(storage, 'online_component_module', return_value=self.online),
            patch.dict(os.environ, {'GITHUB_REPOSITORY': storage.GITHUB_REPOSITORY,
                                  'RELEASE_ADMIN_ONLY': 'false',
                                  'RELEASE_REPOSITORY': storage.REPOSITORY,
                                  'PRODUCTION_INSTANCE_ID': storage.INSTANCE}),
            patch.object(self.online, 'command_raw', side_effect=self.fixture.command)):
            patcher.start(); self.addCleanup(patcher.stop)
        directory = self.module.working_directory(self.root)
        directory.__enter__(); self.addCleanup(directory.__exit__, None, None, None)
        self.calls = []
        self.commands = self.external_commands()
        self.lifecycle_client = storage.LifecycleClient(self.commands, sleep=lambda _: None)
        self.selected = storage.selection(dict(os.environ))

    def external_commands(self):
        fixture, calls, policy = self.fixture, self.calls, self.policy_sha256
        accepted = {}
        class External:
            def git(self, *arguments, **_kwargs):
                calls.append(('git', *arguments))
                if arguments == ('rev-parse', 'HEAD'): return 0, (fixture.p['commit'] + '\n').encode()
                if arguments == ('rev-parse', 'HEAD^{tree}'): return 0, (fixture.p['sourceTree'] + '\n').encode()
                if arguments == ('ls-remote', 'origin', 'refs/heads/main'):
                    return 0, (fixture.p['commit'] + '\trefs/heads/main\n').encode()
                raise AssertionError('unexpected source query')

            def quality(self, run):
                calls.append(('quality', run))
                return {'id': int(run), 'head_sha': fixture.p['commit'], 'head_branch': 'main',
                    'event': 'push', 'status': 'completed', 'conclusion': 'success',
                    'path': '.github/workflows/quality.yml'}

            def archive_size(self, revision):
                if revision != fixture.p['commit']: raise AssertionError('source archive drift')
                return len(fixture.candidate_raw)

            def run(self, arguments, **_kwargs):
                calls.append(tuple(arguments))
                if arguments[:3] == ['docker', 'image', 'inspect']:
                    reference = arguments[-1]
                    name = reference.rsplit('-', 1)[-1]
                    if name == 'recharge': name = 'online-recharge'
                    return 0, storage.canonical({'Id': 'sha256:' + self_outer.online.r.c.digest(name.encode()),
                        'Size': 4096, 'Architecture': 'amd64', 'Labels': {
                            'org.opencontainers.image.revision': fixture.p['commit'],
                            'id-business-v2.source-tree': fixture.p['sourceTree']}})
                expected = ['aws', '--region', storage.REGION, 'ssm', 'get-command-invocation',
                            '--command-id', self_outer.module.COMMAND, '--instance-id', storage.INSTANCE,
                            '--output', 'json']
                if arguments != expected: raise AssertionError('only the original readback GET is permitted')
                return 0, fixture.return_native

            def aws(self, *arguments, **_kwargs):
                calls.append(('aws', *arguments))
                if arguments[:2] == ('ecr', 'batch-get-image'):
                    tag = arguments[arguments.index('--image-ids') + 1].removeprefix('imageTag=')
                    role = tag.rsplit('-', 1)[-1]
                    if role == 'recharge': role = 'online-recharge'
                    identity = 'sha256:' + self_outer.online.r.c.digest(role.encode())
                    manifest = storage.canonical({'schemaVersion': 2,
                        'config': {'digest': identity, 'size': 10},
                        'layers': [{'digest': 'sha256:' + '2' * 64, 'size': 20}]}).decode()
                    return {'failures': [], 'images': [{'registryId': '098208446664',
                        'repositoryName': 'id-business-v2-release', 'imageId': {'imageTag': tag,
                        'imageDigest': 'sha256:' + storage.hashlib.sha256(manifest.encode()).hexdigest()},
                        'imageManifest': manifest}]}
                if arguments[:2] == ('ssm', 'send-command'):
                    value = json.loads(arguments[arguments.index('--cli-input-json') + 1])
                    phase = value['Comment'].removeprefix('ID disk lifecycle ')
                    command = '00000000-0000-0000-0000-' + f'{len(accepted) + 1:012d}'
                    accepted[command] = phase
                    return {'Command': {'CommandId': command, 'InstanceIds': [storage.INSTANCE],
                                        'DocumentName': 'AWS-RunShellScript'}}
                if arguments[:2] != ('ssm', 'get-command-invocation'):
                    raise AssertionError('unexpected external operation')
                command = arguments[arguments.index('--command-id') + 1]
                phase = accepted[command]
                result = {**remote_result(phase), 'policySha256': policy}
                return {**invocation(result), 'CommandId': command}
        self_outer = self
        return External()

    def prepare_candidate(self):
        storage.lifecycle('before-build', commands=self.commands, client=self.lifecycle_client)
        self.fixture.prepare()
        self.proof = self.fixture.build()
        storage.lifecycle('before-pull', commands=self.commands, client=self.lifecycle_client)
        self.storage_directory = storage.OUTPUT / self.selected['batch']
        self.record = storage.closed(storage.read_file(self.storage_directory / 'candidate.json', private=True))

    def save_readback(self):
        core, producer = self.fixture.core, self.fixture.p
        parameters = self.online.parameters('readback', core, producer)
        prefix = self.root / '.deploy/production-release' / self.online.r.PREFIX
        self.readback_paths = {
            'parameters': Path(str(prefix) + '-readback-parameters.json'),
            'intent': Path(str(prefix) + '-readback-send-intent.json'),
            'metadata': Path(str(prefix) + '-readback-invocation-metadata.json'),
            'result': Path(str(prefix) + '-readback.json')}
        receipt = self.fixture.returned_receipt()
        self.fixture.return_native = self.module.native(receipt, self.module.COMMAND, storage.INSTANCE)
        values = {'parameters': parameters,
            'intent': {'producer': producer, 'mode': 'readback',
                'expectedCurrent': self.selected['expectedCurrent'],
                'parametersSha256': self.online.r.c.fingerprint(parameters), 'status': 'SUBMITTING_ONCE'},
            'metadata': {'producer': producer, 'mode': 'readback', 'commandId': self.module.COMMAND,
                'instanceId': storage.INSTANCE, 'status': 'ACCEPTED'},
            'result': self.online.validate_native(core, self.fixture.return_native, 'readback', producer,
                                                  self.module.COMMAND, storage.INSTANCE)}
        for name, path in self.readback_paths.items(): core.write_private(path, values[name])
        return receipt

    def test_real_continuous_component_storage_publisher_and_after_publish(self):
        self.prepare_candidate()
        self.assertTrue(self.selected['onlineComponent'])
        self.assertEqual(set(self.record['images']), set(self.online.r.IMAGES))
        self.assertEqual(self.record['producer'], self.fixture.p)
        self.assertEqual(self.record['proofSha256'], storage.digest(self.proof))
        build_path = self.root / self.online.r.PROOF
        before = storage.private_snapshot([build_path])
        parameters = self.online.parameters('release', self.fixture.core, self.fixture.p,
            input_artifacts=(self.fixture.core.private_bytes(build_path),
                self.fixture.core.private_bytes(self.root / self.online.r.PREFLIGHT)))
        self.assertEqual(parameters['executionTimeout'], ['1800'])
        self.assertIn('python3 -B -c', parameters['commands'][0])
        carrier = shlex.split(parameters['commands'][0])[-1]
        packed = ast.literal_eval(carrier.split('base64.b64decode(', 1)[1].split(',validate=True)', 1)[0])
        program = ast.parse(gzip.decompress(base64.b64decode(packed)).decode())
        argument_call = next(node.value.right for node in program.body if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Attribute) and target.attr == 'argv' for target in node.targets))
        arguments, _origin, _current, descriptor, packed_f, packed_proof = [ast.literal_eval(arg) for arg in argument_call.args]
        self.assertEqual(arguments[0], 'release')
        for argument, field in (('--commit', 'commit'), ('--source-tree', 'sourceTree'),
                                ('--run-id', 'workflowRunId'), ('--run-attempt', 'workflowRunAttempt')):
            self.assertEqual(arguments[arguments.index(argument) + 1], self.fixture.p[field])
        self.assertEqual(json.loads(gzip.decompress(base64.b64decode(packed_proof.removeprefix('gzip-base64:')))), self.proof)
        self.assertEqual(gzip.decompress(base64.b64decode(packed_f)), self.fixture.preflight_native)
        self.assertEqual(descriptor['producer'], self.record['producer'])
        receipt = self.save_readback()
        self.assertNotEqual(receipt['buildProofBytesSha256'], self.record['proofSha256'])
        result = storage.lifecycle('after-publish', commands=self.commands, client=self.lifecycle_client)
        self.assertTrue(result['publicationVerified'])
        after = storage.closed(storage.read_file(self.storage_directory / 'after-publish.intent.json', private=True))
        expected_parameters = storage.remote_parameters('after-publish', self.fixture.p['commit'],
            self.source_sha256, {'record': self.record})
        self.assertEqual(after['binding']['parametersSha256'], storage.digest(expected_parameters))
        native_intent = next(json.loads(call[call.index('--cli-input-json') + 1]) for call in reversed(self.calls)
            if call[:3] == ('aws', 'ssm', 'send-command'))
        args = shlex.split(native_intent['Parameters']['commands'][0])
        self.assertEqual(args[args.index('--expected-current') + 1], self.fixture.p['commit'])
        self.assertEqual(json.loads(base64.b64decode(args[-1])), {'record': self.record})
        self.assertEqual(storage.private_snapshot([build_path]), before)
        self.assertFalse((self.root / '.deploy/production-release/online-recharge-build-proof.json').exists())
        self.assertFalse((self.root / '.deploy/production-release/online-recharge-readback-result.json').exists())
        self.assertEqual(len([call for call in self.fixture.aws if 'send-command' in call]), 0)

    def test_original_formal_source_reproduces_missing_legacy_file(self):
        self.prepare_candidate(); self.save_readback()
        original = subprocess.check_output(['git', 'show',
            'c7a800b931311cd5c6da4c4b2320743b7a3015a1:scripts/production-release/release-storage.py'],
            cwd=HERE.parents[1])
        namespace = {'__file__': str(HERE / 'release-storage.py'), '__name__': 'storage_failed_formal_regression'}
        exec(compile(original, str(HERE / 'release-storage.py'), 'exec'), namespace)
        namespace['PROJECT'] = self.root
        with self.assertRaisesRegex(namespace['StorageRejected'], 'STORAGE_FILE_UNAVAILABLE'):
            namespace['build_record'](self.selected, self.commands)
        with self.assertRaisesRegex(namespace['StorageRejected'], 'STORAGE_FILE_UNAVAILABLE'):
            namespace['validate_readback'](self.selected, self.record)
        storage.validate_readback(self.selected, self.record, self.commands)

    def test_component_cannot_select_an_unknown_or_other_baseline(self):
        for key, bad in (('EXPECTED_CURRENT', 'd' * 40), ('API_FAULT_RESTORE_APPROVED', 'false'),
                         ('RELEASE_ADMIN_ONLY', 'true'), ('DIAGNOSTIC_COMMAND_ID', self.module.COMMAND)):
            value = dict(os.environ); value[key] = bad
            with self.subTest(key=key), self.assertRaises(storage.StorageRejected): storage.selection(value)

    def test_build_proof_source_run_quality_images_and_symlinks_reject(self):
        self.fixture.prepare(); self.proof = self.fixture.build()
        path = self.root / self.online.r.PROOF
        raw = path.read_bytes()
        for key in ('producer', 'qualityRunId', 'sourceProjection', 'images', 'version'):
            changed = copy.deepcopy(self.proof)
            if key == 'producer': changed[key]['sourceTree'] = 'b' * 40
            if key == 'qualityRunId': changed[key] = '999'
            if key == 'sourceProjection': changed[key]['candidateArchiveSha256'] = 'd' * 64
            if key == 'images': changed[key]['api']['imageId'] = 'sha256:' + 'd' * 64
            if key == 'version': changed[key] = 2
            path.write_bytes(storage.canonical(changed) + b'\n')
            with self.subTest(key=key), self.assertRaises(storage.StorageRejected):
                storage.build_record(self.selected, self.commands)
            path.write_bytes(raw)
        for name in (self.online.r.PROOF, self.online.r.PROJECTION, self.online.r.PREFLIGHT):
            path = self.root / name; target = path.with_suffix('.original')
            path.rename(target); path.symlink_to(target)
            with self.subTest(name=name), self.assertRaises(storage.StorageRejected):
                storage.build_record(self.selected, self.commands)
            path.unlink(); target.rename(path)

    def test_proof_file_identity_cannot_change_while_ecr_is_measured(self):
        self.fixture.prepare(); self.proof = self.fixture.build()
        original = self.commands.aws
        path = self.root / self.online.r.PROOF
        def replace(*arguments, **kwargs):
            if arguments[:2] == ('ecr', 'batch-get-image'):
                raw = path.read_bytes(); path.unlink(); self.fixture.core.write_private(path, json.loads(raw))
            return original(*arguments, **kwargs)
        self.commands.aws = replace
        with self.assertRaisesRegex(storage.StorageRejected, 'COMPONENT_INPUT_CHANGED'):
            storage.build_record(self.selected, self.commands)

    def test_readback_native_hash_command_producer_and_proof_drift_never_acknowledge(self):
        self.prepare_candidate(); self.save_readback()
        authenticated = storage.component_build(self.selected)
        original_native = self.fixture.return_native
        original_files = {name: path.read_bytes() for name, path in self.readback_paths.items()}
        for field in ('hash', 'command', 'producer', 'proof', 'projection', 'parameters', 'native'):
            if field == 'native':
                self.fixture.return_native = original_native + b'\n'
            else:
                name = 'metadata' if field == 'command' else 'parameters' if field == 'parameters' else 'result'
                changed = json.loads(original_files[name])
                if field == 'hash': changed['invocationBytesSha256'] = 'd' * 64
                if field == 'command': changed['commandId'] = COMMAND
                if field == 'producer': changed['receipt']['producer']['workflowRunId'] = '999'
                if field == 'proof': changed['receipt']['buildProofBytesSha256'] = 'd' * 64
                if field == 'projection': changed['receipt']['sourceProjectionSha256'] = 'd' * 64
                if field == 'parameters': changed['executionTimeout'] = ['601']
                if field in ('proof', 'projection'):
                    # The complete native envelope and saved wrapper agree.
                    # Only the independent exact proof/projection binding fails.
                    self.fixture.return_native = self.module.native(changed['receipt'], self.module.COMMAND, storage.INSTANCE)
                    changed = self.online.validate_native(self.fixture.core, self.fixture.return_native,
                        'readback', self.fixture.p, self.module.COMMAND, storage.INSTANCE)
                self.readback_paths[name].write_bytes(storage.canonical(changed) + b'\n')
            with self.subTest(field=field), self.assertRaises(storage.StorageRejected):
                storage.validate_readback(self.selected, self.record, self.commands, authenticated)
            for name, path in self.readback_paths.items(): path.write_bytes(original_files[name])
            self.fixture.return_native = original_native
        self.assertFalse((self.storage_directory / 'after-publish.intent.json').exists())
        self.assertEqual(len([call for call in self.fixture.aws if 'send-command' in call]), 0)

    def test_unavailable_original_native_does_not_acknowledge_or_resend(self):
        self.prepare_candidate(); self.save_readback()
        authenticated = storage.component_build(self.selected)
        before = len([call for call in self.calls if call[:3] == ('aws', 'ssm', 'send-command')])
        original = self.commands.run
        def unavailable(arguments, **keywords):
            if arguments[:5] == ['aws', '--region', storage.REGION, 'ssm', 'get-command-invocation']:
                raise storage.StorageRejected('STORAGE_PROCESS_FAILED')
            return original(arguments, **keywords)
        self.commands.run = unavailable
        with self.assertRaisesRegex(storage.StorageRejected, 'STORAGE_PROCESS_FAILED'):
            storage.validate_readback(self.selected, self.record, self.commands, authenticated)
        self.assertFalse((self.storage_directory / 'after-publish.intent.json').exists())
        self.assertEqual(len([call for call in self.calls if call[:3] == ('aws', 'ssm', 'send-command')]), before)

    def test_after_publish_requires_complete_bound_readback_and_all_candidate_images(self):
        self.prepare_candidate(); self.save_readback()
        result_path = self.readback_paths['result']; target = result_path.with_suffix('.original')
        result_path.rename(target); result_path.symlink_to(target)
        with self.assertRaises(storage.StorageRejected):
            storage.lifecycle('after-publish', commands=self.commands, client=self.lifecycle_client)
        self.assertFalse((self.storage_directory / 'after-publish.intent.json').exists())
        result_path.unlink(); target.rename(result_path)
        altered = copy.deepcopy(self.record); altered['images']['online-recharge']['imageId'] = 'sha256:' + 'd' * 64
        with self.assertRaisesRegex(storage.StorageRejected, 'READBACK_IMAGE_DRIFT'):
            storage.validate_readback(self.selected, altered, self.commands)


if __name__ == '__main__':
    unittest.main()
