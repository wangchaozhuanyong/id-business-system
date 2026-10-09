"""Pending database provenance, two publications, and independent readback.

Fixtures use no network, Docker, real database or production path writes.
"""
import copy
import base64
import gzip
import hashlib
from contextlib import contextmanager, ExitStack, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import shutil
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / '.runtime/bitbrowser-publish-20261010/pending-control-tests'
OUTPUT.mkdir(parents=True, exist_ok=True)


def load(name, file, selected=None):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    value = importlib.util.module_from_spec(spec)
    if selected:
        value.SCOPE = selected
    spec.loader.exec_module(value)
    return value


s = load('pending_scope', 'api-admin-scope.py', 'API_ADMIN_WORKSPACE')
online = load('pending_online', 'online-recharge-scope.py')
t = load('pending_transport', 'api-admin-readonly.py')


def need(condition, code):
    if not condition:
        raise RuntimeError(code)


def states():
    return {name: {'image': 'sha256:' + str(i) * 64, 'reference': 'sealed-' + name,
        'status': 'running', 'health': None if name == 'caddy' else 'healthy',
        'containerId': str(i) * 64, 'startedAtSha256': 'a' * 64,
        'environmentSha256': 'b' * 64, 'configurationSha256': 'c' * 64}
        for i, name in enumerate(('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration'), 1)}


def context():
    policy = online.recovery_policy(SimpleNamespace(require=need))
    return {'version': 1, 'scope': s.PENDING_ONLINE_SCOPE,
        'baselineRelease': '/opt/id-business-v2/releases/20261009T124501Z-' + s.WORKSPACE_BOOTSTRAP_COMMIT[:12],
        'baselineManifestSha256': 'e' * 64,
        'migrationState': {'name': online.MIGRATION_NAME, 'sha256': online.MIGRATION_IDENTITY['sha256'],
            'status': 'APPLIED', 'schemaVerified': True, 'appliedMigrationsSha256': 'f' * 64},
        'recoveryMarker': online.recovery_marker(policy),
        'restoredOrigin': {'source': '/opt/id-business-v2/releases/20261009T142956Z-' + online.RESTORED_COMMIT[:12],
            'manifestSha256': 'a' * 64, 'recordSha256': 'b' * 64},
        'services': states(), 'priorPublications': []}


def declaration_context(stage=1):
    """A structurally valid synthetic P, with real fixed recovery policy fields."""
    value = context()
    digest = lambda label: hashlib.sha256(('SYNTHETIC:' + label).encode()).hexdigest()
    original = copy.deepcopy(online.recovery_policy(SimpleNamespace(require=need))['preflight']['services'])
    actual = copy.deepcopy(original)
    for name in ('api', 'admin'):
        for key in ('containerId', 'startedAtSha256', 'configurationSha256'):
            actual[name][key] = digest(name + '-' + key)
    producer = {'commit': 'a' * 40, 'sourceTree': 'b' * 40, 'workflowRunId': '123',
        'workflowRunAttempt': '1', 'archiveInventorySha256': digest('inventory'),
        'helpers': {name: digest(name) for name in online.DECLARATION_EQUIVALENCE_HELPERS}}
    source = {name: digest(name) for name in online.DECLARATION_EQUIVALENCE_FIELDS['sourceBindings']}
    source.update(apiImageId=actual['api']['image'], apiImageReference=actual['api']['reference'],
                  expectedEnvironmentSha256=actual['api']['environmentSha256'])
    observation = {'snapshotSha256': online.fingerprint(actual), 'sourceFilesSha256': digest('files'),
        'workspaceVolumeSha256': digest('volume'), 'actualResourceSha256': source['actualResourceSha256']}
    semantic = {'producer': producer,
        'fixedRecovery': {**online.DECLARATION_EQUIVALENCE_FIXED,
                         'recoveryMarkerSha256': online.fingerprint(value['recoveryMarker'])},
        'historicalFiles': {name: digest(name) for name in online.DECLARATION_EQUIVALENCE_FIELDS['historicalFiles']},
        'anchors': {name: {'oldBeforeContainerId': digest(name + '-old'),
                           'candidateAfterContainerId': digest(name + '-296')} for name in ('api', 'admin')},
        'original': original, 'actual': actual, 'sourceBindings': source,
        'apiEquivalence': {'rulesSha256': digest('rules'),
            'oldRawConfigurationSha256': original['api']['configurationSha256'],
            'actualRawConfigurationSha256': actual['api']['configurationSha256'],
            'normalizedActualSha256': digest('model'), 'normalizedReferenceSha256': digest('model')},
        'adminProjection': {'kind': 'ADMIN_OLD_COMPLETE_CONFIGURATION_MATCH',
            'originalConfigurationSha256': original['admin']['configurationSha256'],
            'actualConfigurationSha256': actual['admin']['configurationSha256'],
            'projectedConfigurationSha256': original['admin']['configurationSha256'],
            'helperSha256': producer['helpers'][online.DECLARATION_EQUIVALENCE_HELPERS[2]]},
        'stableObservation': observation}
    measurement = {name: digest(name) for name in online.DECLARATION_EQUIVALENCE_FIELDS['measurement']}
    measurement.update(purpose='INDEPENDENT_PREFLIGHT', executionNonce='1' * 32, neverStarted=True,
        cleanupVerified=True, realEnvironmentPersisted=False,
        referenceCounts={'containers': 1, 'networks': 4, 'volumes': 1},
        stableBefore=copy.deepcopy(observation), stableAfter=copy.deepcopy(observation),
        priorIndependentPreflightBytesSha256=None, priorProofSha256=None)
    first = {'kind': online.DECLARATION_EQUIVALENCE_KIND, 'version': 3, 'service': 'api',
             'semantic': semantic, 'measurement': measurement}
    history = semantic['historicalFiles']
    value.update(version=2, baselineManifestSha256=history['workspaceManifestBytesSha256'],
        restoredConfigurationProof=first, services=actual)
    value['restoredOrigin'].update(manifestSha256=history['restoredManifestBytesSha256'],
                                  recordSha256=history['restoredRecordBytesSha256'])
    if stage == 2:
        value['priorPublications'] = [{'release': '/opt/id-business-v2/releases/20261010T010000Z-' + 'a' * 12,
            'commit': producer['commit'], 'sourceTree': producer['sourceTree'], 'manifestSha256': digest('A-manifest'),
            'recordSha256': digest('A-record'), 'buildProofSha256': digest('A-build')}]
        value['services'] = copy.deepcopy(actual)
        for name in ('api', 'admin'):
            value['services'][name]['containerId'] = digest(name + '-published')
    return value


def namespace():
    return vars(s)


def build_configuration():
    return {'composeSha256': 'd' * 64, 'caddySha256': s.WORKSPACE_CADDY_AFTER,
            'volume': s.WORKSPACE_VOLUME, 'containerDirectory': s.WORKSPACE_DIRECTORY}


def build_acceptance():
    return {'status': 'PASS', 'checks': ['private-health', 'packaged-resources', 'private-sqlite',
            'encrypted-storage', 'restart-persistence', 'wrong-key-rejected'],
            'businessActions': 0, 'temporaryVolumeRemoved': True}


def workspace_build_proof(value=None):
    result = {'version': 1, 'scope': s.SCOPE, 'commit': 'a' * 40, 'sourceTree': 'b' * 40,
        'configuration': build_configuration(), 'acceptance': build_acceptance(), 'images': {
            service: {'reference': '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:'
                + 'a' * 40 + '-123-1-' + service, 'imageId': 'sha256:' + str(index) * 64,
                'fileCount': 1, 'sha256': str(index) * 64}
            for index, service in enumerate(('api', 'admin'), 1)}}
    if value is not None:
        result.update(pendingOnlineProjection={'fixture': 'projection'},
                      pendingOnlineOriginSha256=s.fingerprint(value))
    return result


class BuildOriginBinding(unittest.TestCase):
    def origin(self, stage):
        value = context()
        if stage == 2:
            value['priorPublications'] = [{'release': '/opt/id-business-v2/releases/20261010T010000Z-' + '1' * 12,
                'commit': '1' * 40, 'sourceTree': '2' * 40, 'manifestSha256': '3' * 64,
                'recordSha256': '4' * 64, 'buildProofSha256': '5' * 64}]
        return value

    def seal_path(self, output):
        return output / 'api-admin-pending-build-origin-seal.json'

    def expected_seal(self, before):
        return {'version': 1, 'scope': s.PENDING_ONLINE_SCOPE,
            'commit': os.environ['RELEASE_COMMIT'], 'sourceTree': os.environ['SOURCE_TREE'],
            'expectedCurrent': os.environ['EXPECTED_CURRENT'], 'workflowRunId': os.environ['GITHUB_RUN_ID'],
            'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
            'pendingOnlineOriginSha256': s.fingerprint(before['pendingOnlineMigrationOrigin'])}

    def replace_preflight_origin(self, before, output):
        changed = copy.deepcopy(before)
        changed['pendingOnlineMigrationOrigin']['services']['api']['configurationSha256'] = '0' * 64
        changed['services'] = copy.deepcopy(changed['pendingOnlineMigrationOrigin']['services'])
        (output / 'api-workspace-preflight-result.json').write_text(json.dumps(changed))
        return changed

    def assert_no_image_reads(self, controller):
        self.assertFalse(any(call.args[:2] == ('docker', 'image') for call in controller.run.call_args_list))
        self.assertFalse(any(call.args[:2] == ('docker', 'run') for call in controller.run.call_args_list))

    @contextmanager
    def fixture(self, value=None, *, candidate='a' * 40, source_tree='b' * 40):
        value = context() if value is None else value
        predecessor = value['priorPublications'][-1]['commit'] if value['priorPublications'] else online.BASELINE_COMMIT
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary, ExitStack() as stack:
            original = os.getcwd(); os.chdir(temporary)
            stack.callback(os.chdir, original)
            output = Path('.deploy/production-release'); output.mkdir(parents=True)
            preflight = {'status': 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED', 'mode': 'preflight',
                'commit': predecessor, 'releaseCandidateCommit': candidate,
                'workflowRunId': '123', 'workflowRunAttempt': '1',
                'pendingOnlineMigrationOrigin': value,
                'pendingOnlineEndedFailures': s.pending_online_ended_failures(value),
                'services': value['services'], 'onlinePublished': False, 'migrationPerformed': False}
            (output / 'api-workspace-preflight-result.json').write_text(json.dumps(preflight))
            projection_record = {'contextPath': '.deploy/production-release/pending-fixture-context'}
            (output / 'api-admin-pending-build-projection.json').write_text(json.dumps(projection_record))
            helper = SimpleNamespace(prepare_build=MagicMock(return_value=projection_record),
                                     validate_record=MagicMock(), verify_build_context=MagicMock())
            env = {'RELEASE_OPERATION': 'release_api_workspace', 'RELEASE_COMMIT': candidate,
                   'SOURCE_TREE': source_tree, 'EXPECTED_CURRENT': predecessor,
                   'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1',
                   'RELEASE_REPOSITORY': '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'}
            stack.enter_context(patch.dict(os.environ, env, clear=True))
            stack.enter_context(patch.object(s, 'pending_projection', return_value=helper))
            stack.enter_context(patch.object(s, 'workspace_configuration', return_value=build_configuration()))
            stack.enter_context(patch.object(s, 'workspace_acceptance', return_value=build_acceptance()))

            def run(*args):
                if args == ('git', 'rev-parse', 'HEAD'): return env['RELEASE_COMMIT']
                if args == ('git', 'rev-parse', 'HEAD^{tree}'): return env['SOURCE_TREE']
                if args[:3] == ('docker', 'image', 'inspect'):
                    service = args[-1].rsplit('-', 1)[1]
                    return json.dumps([{'Id': 'sha256:' + ('1' if service == 'api' else '2') * 64,
                        'Architecture': 'amd64', 'Config': {'Labels': {
                            'org.opencontainers.image.revision': env['RELEASE_COMMIT'],
                            'id-business-v2.source-tree': env['SOURCE_TREE'],
                            'id-business-v2.pending-online-projection-sha256': s.fingerprint(projection_record)}}}])
                if args[:2] == ('docker', 'run'):
                    service = args[8].rsplit('-', 1)[1]
                    return '1' * 64 + '  ' + ('/app/apps/api/dist/main.js' if service == 'api'
                                                       else '/usr/share/nginx/html/index.html')
                raise AssertionError('unexpected command')

            controller = SimpleNamespace(require=need, run=MagicMock(side_effect=run))
            yield controller, preflight, output, helper

    def test_actual_prepare_and_build_bind_the_same_complete_preflight_origin(self):
        for stage in (1, 2):
            with self.subTest(stage=stage), self.fixture(self.origin(stage)) as (controller, before, output, helper):
                self.assertEqual(s.prepare_workspace_build(controller), helper.prepare_build.return_value)
                helper.prepare_build.assert_called_once_with(controller)
                seal = self.seal_path(output); metadata = seal.lstat()
                self.assertTrue(stat.S_ISREG(metadata.st_mode)); self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o600)
                self.assertEqual(metadata.st_uid, os.getuid()); self.assertEqual(metadata.st_nlink, 1)
                expected = self.expected_seal(before)
                self.assertEqual(seal.read_bytes(), (json.dumps(expected, sort_keys=True, separators=(',', ':')) + '\n').encode())
                self.assertLessEqual(metadata.st_size, 1024)
                self.assertNotIn('services', seal.read_text()); self.assertNotIn('recoveryMarker', seal.read_text())
                self.assertNotIn(before['pendingOnlineMigrationOrigin']['baselineRelease'], seal.read_text())
                with redirect_stdout(io.StringIO()): s.build_proof(controller)
                proof = json.loads((output / s.PROOF_FILE).read_text())
                self.assertEqual(proof['pendingOnlineOriginSha256'], expected['pendingOnlineOriginSha256'])
                s.validate_proof(controller, proof, 'a' * 40, 'b' * 40)
                self.assertEqual(s.pending_online_build_origin(controller), before['pendingOnlineMigrationOrigin'])
                helper.verify_build_context.assert_called_once()
                self.assertFalse(any(call.args[:2] == ('docker', 'build') for call in controller.run.call_args_list))

    def test_prepare_then_same_runner_valid_origin_replacement_is_rejected_before_image_read(self):
        for stage in (1, 2):
            with self.subTest(stage=stage), self.fixture(self.origin(stage)) as (controller, before, output, helper):
                s.prepare_workspace_build(controller)
                original = self.seal_path(output).read_bytes()
                changed = self.replace_preflight_origin(before, output)
                self.assertEqual(s.pending_online_build_origin(controller), changed['pendingOnlineMigrationOrigin'])
                self.assertNotEqual(s.fingerprint(before['pendingOnlineMigrationOrigin']),
                                    s.fingerprint(changed['pendingOnlineMigrationOrigin']))
                with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_BUILD_ORIGIN_CHANGED$'):
                    with redirect_stdout(io.StringIO()): s.build_proof(controller)
                self.assert_no_image_reads(controller)
                helper.validate_record.assert_not_called(); helper.verify_build_context.assert_not_called()
                self.assertEqual(self.seal_path(output).read_bytes(), original)
                self.assertFalse((output / s.PROOF_FILE).exists())

    def test_prepared_pending_origin_cannot_downgrade_to_ordinary_prepare_or_build(self):
        for stage in (1, 2):
            for operation in ('prepare', 'build'):
                with self.subTest(stage=stage, operation=operation), self.fixture(self.origin(stage)) as (controller, before, output, helper):
                    s.prepare_workspace_build(controller)
                    seal = self.seal_path(output); original = seal.read_bytes(); metadata = seal.stat()
                    before.pop('pendingOnlineMigrationOrigin'); before.pop('pendingOnlineEndedFailures')
                    (output / 'api-workspace-preflight-result.json').write_text(json.dumps(before))
                    (output / 'api-admin-pending-build-projection.json').unlink()
                    with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_BUILD_ORIGIN_CHANGED$'):
                        if operation == 'prepare': s.prepare_workspace_build(controller)
                        else:
                            with redirect_stdout(io.StringIO()): s.build_proof(controller)
                    self.assert_no_image_reads(controller)
                    helper.prepare_build.assert_called_once(); helper.validate_record.assert_not_called()
                    helper.verify_build_context.assert_not_called()
                    self.assertFalse((output / s.PROOF_FILE).exists())
                    self.assertEqual((seal.read_bytes(), seal.stat().st_ino, seal.stat().st_mtime_ns),
                                     (original, metadata.st_ino, metadata.st_mtime_ns))

    def test_broken_seal_symlink_cannot_downgrade_pending_prepare_or_build(self):
        for stage in (1, 2):
            for operation in ('prepare', 'build'):
                with self.subTest(stage=stage, operation=operation), self.fixture(self.origin(stage)) as (controller, before, output, helper):
                    s.prepare_workspace_build(controller)
                    seal = self.seal_path(output); original = seal.read_bytes(); metadata = seal.stat()
                    preserved = output / 'preserved-origin-seal.json'; seal.rename(preserved)
                    target = (output / 'missing-origin-seal.json').resolve(); seal.symlink_to(target)
                    self.assertTrue(seal.is_symlink()); self.assertFalse(seal.exists())
                    before.pop('pendingOnlineMigrationOrigin'); before.pop('pendingOnlineEndedFailures')
                    (output / 'api-workspace-preflight-result.json').write_text(json.dumps(before))
                    (output / 'api-admin-pending-build-projection.json').unlink()
                    with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_BUILD_ORIGIN_CHANGED$'):
                        if operation == 'prepare': s.prepare_workspace_build(controller)
                        else:
                            with redirect_stdout(io.StringIO()): s.build_proof(controller)
                    self.assert_no_image_reads(controller)
                    helper.prepare_build.assert_called_once(); helper.validate_record.assert_not_called()
                    helper.verify_build_context.assert_not_called()
                    self.assertFalse((output / s.PROOF_FILE).exists())
                    self.assertEqual((preserved.read_bytes(), preserved.stat().st_ino, preserved.stat().st_mtime_ns),
                                     (original, metadata.st_ino, metadata.st_mtime_ns))
                    self.assertTrue(seal.is_symlink()); self.assertFalse(seal.exists())
                    self.assertEqual(seal.readlink(), target)

    def test_repeated_prepare_cannot_replace_the_original_origin_seal(self):
        for stage in (1, 2):
            with self.subTest(stage=stage), self.fixture(self.origin(stage)) as (controller, before, output, helper):
                s.prepare_workspace_build(controller)
                seal = self.seal_path(output); original = seal.read_bytes(); metadata = seal.stat()
                changed = self.replace_preflight_origin(before, output)
                self.assertEqual(s.pending_online_build_origin(controller), changed['pendingOnlineMigrationOrigin'])
                with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_BUILD_ORIGIN_CHANGED$'):
                    s.prepare_workspace_build(controller)
                self.assertEqual((seal.read_bytes(), seal.stat().st_ino, seal.stat().st_mtime_ns),
                                 (original, metadata.st_ino, metadata.st_mtime_ns))
                helper.prepare_build.assert_called_once(); self.assert_no_image_reads(controller)

    def test_repeated_prepare_of_same_origin_keeps_exclusive_seal_bytes_and_inode(self):
        with self.fixture() as (controller, before, output, helper):
            s.prepare_workspace_build(controller)
            seal = self.seal_path(output); raw = seal.read_bytes(); metadata = seal.stat()
            s.prepare_workspace_build(controller)
            self.assertEqual((seal.read_bytes(), seal.stat().st_ino, seal.stat().st_mtime_ns),
                             (raw, metadata.st_ino, metadata.st_mtime_ns))
            self.assertEqual(helper.prepare_build.call_count, 2)

    def test_existing_seal_missing_identity_digest_shape_or_file_metadata_rejects_before_image_read(self):
        cases = ('missing', 'version', 'scope', 'commit', 'sourceTree', 'expectedCurrent', 'workflowRunId',
                 'workflowRunAttempt', 'digest', 'extra', 'malformed', 'noncanonical', 'oversize',
                 'mode', 'symlink', 'hardlink', 'directory', 'uid')
        for operation in ('build', 'prepare'):
            for changed in cases:
                if operation == 'prepare' and changed == 'missing': continue
                with self.subTest(operation=operation, changed=changed), self.fixture() as (controller, before, output, helper), ExitStack() as stack:
                    s.prepare_workspace_build(controller)
                    seal = self.seal_path(output); payload = self.expected_seal(before)
                    if changed == 'missing': seal.unlink()
                    elif changed == 'mode': seal.chmod(0o640)
                    elif changed == 'symlink':
                        target = output / 'seal-link-target.json'; seal.rename(target); seal.symlink_to(target.resolve())
                    elif changed == 'hardlink': os.link(seal, output / 'seal-hardlink.json')
                    elif changed == 'directory': seal.unlink(); seal.mkdir()
                    elif changed == 'uid': stack.enter_context(patch.object(s.os, 'getuid', return_value=seal.stat().st_uid + 1))
                    elif changed == 'malformed': seal.write_bytes(b'{')
                    elif changed == 'noncanonical': seal.write_text(json.dumps(payload))
                    elif changed == 'oversize': seal.write_bytes(b' ' * 1025)
                    else:
                        if changed == 'version': payload['version'] = 2
                        elif changed == 'scope': payload['scope'] = 'other'
                        elif changed in ('workflowRunId', 'workflowRunAttempt'): payload[changed] = '2'
                        elif changed == 'digest': payload['pendingOnlineOriginSha256'] = '0' * 64
                        elif changed == 'extra': payload['extra'] = 'fixture-unapproved-field'
                        else: payload[changed] = '0' * 40
                        seal.write_text(json.dumps(payload, sort_keys=True, separators=(',', ':')) + '\n')
                    with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_BUILD_ORIGIN_CHANGED$'):
                        if operation == 'prepare': s.prepare_workspace_build(controller)
                        else:
                            with redirect_stdout(io.StringIO()): s.build_proof(controller)
                    self.assert_no_image_reads(controller)
                    helper.prepare_build.assert_called_once(); helper.validate_record.assert_not_called()
                    self.assertFalse((output / s.PROOF_FILE).exists())

    def test_seal_parent_symlinks_are_rejected_before_image_read(self):
        for parent in ('.deploy', '.deploy/production-release'):
            with self.subTest(parent=parent), self.fixture() as (controller, before, output, helper):
                s.prepare_workspace_build(controller)
                path = Path(parent); target = path.with_name(path.name + '-original')
                path.rename(target); path.symlink_to(target.resolve(), target_is_directory=True)
                with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_BUILD_ORIGIN_CHANGED$'):
                    with redirect_stdout(io.StringIO()): s.build_proof(controller)
                self.assert_no_image_reads(controller)

    def test_actual_nonpending_prepare_and_build_keep_the_original_proof_fields(self):
        with self.fixture() as (controller, before, output, helper):
            before.pop('pendingOnlineMigrationOrigin'); before.pop('pendingOnlineEndedFailures')
            (output / 'api-workspace-preflight-result.json').write_text(json.dumps(before))
            (output / 'api-admin-pending-build-projection.json').unlink()
            self.assertEqual(s.prepare_workspace_build(controller), {'contextPath': '.'})
            with redirect_stdout(io.StringIO()): s.build_proof(controller)
            proof = json.loads((output / s.PROOF_FILE).read_text())
            self.assertNotIn('pendingOnlineOriginSha256', proof)
            self.assertNotIn('pendingOnlineProjection', proof)
            self.assertFalse(self.seal_path(output).exists())
            s.validate_proof(controller, proof, 'a' * 40, 'b' * 40)
            helper.prepare_build.assert_not_called(); helper.verify_build_context.assert_not_called()

    def test_prepare_and_build_reject_different_candidate_predecessor_run_attempt_or_failure_receipts(self):
        for operation in ('prepare', 'build'):
            for changed in ('candidate', 'predecessor', 'origin-predecessor', 'run', 'attempt', 'ended', 'ended-first', 'ended-second',
                            'status', 'mode', 'services', 'online', 'migration', 'run-empty', 'attempt-zero'):
                with self.subTest(operation=operation, changed=changed), self.fixture() as (controller, before, output, helper):
                    if changed == 'candidate': before['releaseCandidateCommit'] = 'c' * 40
                    elif changed == 'predecessor': before['commit'] = 'd' * 40
                    elif changed == 'origin-predecessor':
                        before['pendingOnlineMigrationOrigin']['priorPublications'] = [{
                            'release': '/opt/id-business-v2/releases/20261010T010000Z-' + '1' * 12,
                            'commit': '1' * 40, 'sourceTree': '2' * 40, 'manifestSha256': '3' * 64,
                            'recordSha256': '4' * 64, 'buildProofSha256': '5' * 64}]
                    elif changed == 'run': before['workflowRunId'] = '124'
                    elif changed == 'attempt': before['workflowRunAttempt'] = '2'
                    elif changed == 'ended': before['pendingOnlineEndedFailures'].pop()
                    elif changed in ('ended-first', 'ended-second'):
                        before['pendingOnlineEndedFailures'][0 if changed == 'ended-first' else 1]['receiptSha256'] = '0' * 64
                    elif changed == 'status': before['status'] = 'other'
                    elif changed == 'mode': before['mode'] = 'readback'
                    elif changed == 'services': before['services'] = copy.deepcopy(before['services']); before['services']['api']['containerId'] = '0' * 64
                    elif changed == 'online': before['onlinePublished'] = True
                    elif changed == 'migration': before['migrationPerformed'] = True
                    elif changed == 'run-empty': os.environ['GITHUB_RUN_ID'] = ''; before['workflowRunId'] = ''
                    else: os.environ['GITHUB_RUN_ATTEMPT'] = '0'; before['workflowRunAttempt'] = '0'
                    (output / 'api-workspace-preflight-result.json').write_text(json.dumps(before))
                    with self.assertRaises(RuntimeError):
                        if operation == 'prepare': s.prepare_workspace_build(controller)
                        else:
                            with redirect_stdout(io.StringIO()): s.build_proof(controller)
                    helper.prepare_build.assert_not_called()
                    self.assertFalse(any(call.args[:2] == ('docker', 'image') for call in controller.run.call_args_list))

    def test_build_rejects_projection_presence_that_disagrees_with_preflight_pending_origin(self):
        for change in ('no-projection', 'no-pending'):
            with self.subTest(change=change), self.fixture() as (controller, before, output, helper):
                if change == 'no-projection': (output / 'api-admin-pending-build-projection.json').unlink()
                else:
                    before.pop('pendingOnlineMigrationOrigin'); before.pop('pendingOnlineEndedFailures')
                    (output / 'api-workspace-preflight-result.json').write_text(json.dumps(before))
                with self.assertRaises(RuntimeError):
                    with redirect_stdout(io.StringIO()): s.build_proof(controller)
                self.assertFalse((output / s.PROOF_FILE).exists())

    def test_proof_only_pending_projection_requires_and_allows_origin_digest(self):
        helper = SimpleNamespace(validate_record=MagicMock())
        with patch.object(s, 'pending_projection', return_value=helper):
            good = workspace_build_proof(context())
            s.validate_proof(SimpleNamespace(require=need), good, 'a' * 40, 'b' * 40)
            for changed in ('missing', 'short', 'uppercase', 'integer', 'null', 'ordinary-digest', 'ordinary-projection',
                            'null-projection', 'list-projection', 'false-projection'):
                proof = copy.deepcopy(good)
                if changed == 'missing': proof.pop('pendingOnlineOriginSha256')
                elif changed == 'short': proof['pendingOnlineOriginSha256'] = 'a' * 63
                elif changed == 'uppercase': proof['pendingOnlineOriginSha256'] = 'A' * 64
                elif changed == 'integer': proof['pendingOnlineOriginSha256'] = 1
                elif changed == 'null': proof['pendingOnlineOriginSha256'] = None
                elif changed == 'ordinary-digest': proof.pop('pendingOnlineProjection')
                elif changed == 'ordinary-projection': proof = workspace_build_proof(); proof['pendingOnlineProjection'] = {}
                elif changed == 'null-projection': proof['pendingOnlineProjection'] = None
                elif changed == 'list-projection': proof['pendingOnlineProjection'] = []
                else: proof['pendingOnlineProjection'] = False
                with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                    s.validate_proof(SimpleNamespace(require=need), proof, 'a' * 40, 'b' * 40)
            normal = workspace_build_proof()
            s.validate_proof(SimpleNamespace(require=need), normal, 'a' * 40, 'b' * 40)
            helper.validate_record.assert_called()

    def test_other_api_admin_proof_branch_cannot_carry_pending_origin_or_projection_fields(self):
        normal = workspace_build_proof()
        for name in ('scope', 'configuration', 'acceptance'): normal.pop(name)
        with patch.object(s, 'WORKSPACE', False):
            s.validate_proof(SimpleNamespace(require=need), normal, 'a' * 40, 'b' * 40)
            for field in ('pendingOnlineOriginSha256', 'pendingOnlineProjection'):
                proof = copy.deepcopy(normal)
                proof[field] = '0' * 64 if field == 'pendingOnlineOriginSha256' else {}
                with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'API_ADMIN_BUILD_PROOF_INVALID'):
                    s.validate_proof(SimpleNamespace(require=need), proof, 'a' * 40, 'b' * 40)


class OriginValidation(unittest.TestCase):
    def test_fixed_pending_origin_does_not_assert_online_publication(self):
        value = context()
        self.assertIs(s.validate_pending_online_origin(value), value)
        marker = s.pending_online_marker(value)
        self.assertEqual(marker['publicationIndex'], 1)
        self.assertEqual(marker['scope'], 'PENDING_ONLINE_MIGRATION')
        self.assertNotIn('onlineOrigin', value)

    def test_wrong_migration_schema_or_pending_status_rejects(self):
        for key, change in [('sha256', '0' * 64), ('status', 'PENDING'), ('schemaVerified', False), ('name', 'other')]:
            value = context(); value['migrationState'][key] = change
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'API_ADMIN_PENDING_ONLINE_ORIGIN_CHANGED'):
                s.validate_pending_online_origin(value)

    def test_both_failure_sources_and_exact_keys_are_required(self):
        for change in ('first', 'second', 'extra', 'secret'):
            value = context()
            if change == 'first': value['recoveryMarker']['failureReceiptSha256'] = '0' * 64
            elif change == 'second': value['recoveryMarker']['restoredAttempt']['failureReceiptSha256'] = '0' * 64
            elif change == 'extra': value['onlineOrigin'] = {}
            else: value['recoveryMarker']['privateToken'] = 'DO_NOT_EMIT_SENTINEL'
            with self.subTest(change=change), self.assertRaisesRegex(RuntimeError, 'API_ADMIN_PENDING_ONLINE_ORIGIN_CHANGED'):
                s.validate_pending_online_origin(value)

    def test_two_publication_limit_and_safe_service_identity(self):
        value = context()
        entry = {'release': '/opt/id-business-v2/releases/20261010T010000Z-' + '1' * 12,
            'commit': '1' * 40, 'sourceTree': '2' * 40, 'manifestSha256': '3' * 64,
            'recordSha256': '4' * 64, 'buildProofSha256': '5' * 64}
        value['priorPublications'] = [entry]
        self.assertEqual(s.pending_online_marker(value)['publicationIndex'], 2)
        value['priorPublications'].append(entry)
        with self.assertRaises(RuntimeError): s.validate_pending_online_origin(value)
        value = context(); value['services']['online-recharge'] = value['services']['api']
        with self.assertRaises(RuntimeError): s.validate_pending_online_origin(value)


class FinitePublicationChain(unittest.TestCase):
    def test_a_to_b_transition_is_sealed_and_a_third_is_rejected(self):
        value = context()
        previous = MagicMock()
        previous.__str__.return_value = '/opt/id-business-v2/releases/20261010T010000Z-' + '1' * 12
        (previous / s.STATE_FILE).read_bytes.return_value = b'{"sealed":"A"}'
        new_states = states(); new_states['api']['containerId'] = '9' * 64
        manifest = {'commit': '1' * 40, 'sourceTree': '2' * 40}
        successor = s.pending_online_successor(SimpleNamespace(require=need), value, previous,
            manifest, b'{"commit":"A"}', {'proof': 'A'}, new_states)
        self.assertEqual(s.pending_online_marker(value)['publicationIndex'], 1)
        self.assertEqual(s.pending_online_marker(successor)['publicationIndex'], 2)
        self.assertEqual(successor['priorPublications'][0]['recordSha256'], s.hashlib.sha256(b'{"sealed":"A"}').hexdigest())
        self.assertEqual(value['priorPublications'], [])
        with self.assertRaisesRegex(RuntimeError, 'API_ADMIN_PENDING_ONLINE_PUBLICATION_LIMIT'):
            s.pending_online_successor(SimpleNamespace(require=need), successor, previous,
                manifest, b'{}', {}, new_states)

    @contextmanager
    def sealed_chain(self):
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary:
            base = Path(temporary); (base / 'releases').mkdir()
            value = context(); origin = base / 'releases' / Path(value['baselineRelease']).name; origin.mkdir()
            raw = b'{"original":"sealed"}'; (origin / 'release-manifest.json').write_bytes(raw)
            value['baselineManifestSha256'] = s.hashlib.sha256(raw).hexdigest()
            first = copy.deepcopy(value)
            prior_commit = '1' * 40; prior = base / 'releases' / ('20261010T010000Z-' + prior_commit[:12]); prior.mkdir()
            after = states(); after['api']['containerId'] = '9' * 64; after['admin']['containerId'] = '8' * 64
            proof = {'pendingOnlineProjection': {'sealed': 'A'},
                     'pendingOnlineOriginSha256': s.fingerprint(first)}
            manifest = {'commit': prior_commit, 'sourceTree': '2' * 40, 'pendingOnlineMigration': s.pending_online_marker(first),
                'servicesUpdated': ['api', 'admin'], 'migrationApplied': False, 'newMigrations': []}
            record = {'pendingOnlineMigrationOrigin': first, 'before': first['services'], 'after': after}
            for name, row in [('release-manifest.json', manifest), (s.STATE_FILE, record), (s.PROOF_FILE, proof)]:
                (prior / name).write_text(json.dumps(row))
            value['services'] = after
            value['priorPublications'] = [{'release': '/opt/id-business-v2/releases/' + prior.name,
                'commit': prior_commit, 'sourceTree': '2' * 40,
                'manifestSha256': s.hashlib.sha256((prior / 'release-manifest.json').read_bytes()).hexdigest(),
                'recordSha256': s.hashlib.sha256((prior / s.STATE_FILE).read_bytes()).hexdigest(),
                'buildProofSha256': s.fingerprint(proof)}]
            module = SimpleNamespace(verify_permission_seed=MagicMock(), require_fresh_resources=MagicMock(),
                recovery_services=MagicMock(side_effect=AssertionError('retired container live reader forbidden')))
            recovery = {'state': value['migrationState'], 'marker': value['recoveryMarker'],
                'restored': value['restoredOrigin'], 'source': base / 'sealed-failure-source',
                'policy': {'preflight': {'services': states()}}}
            def mapped_path(item):
                path = Path(item)
                return base / 'releases' / path.name if str(path).startswith('/opt/id-business-v2/releases/') else path
            controller = SimpleNamespace(require=need, BASE=base, run=MagicMock(side_effect=AssertionError('no retired Docker inspect')))
            with patch.object(s, 'Path', side_effect=mapped_path), patch.object(s, 'pending_online_recovery', return_value=(module, recovery)), \
                    patch.object(s, 'pending_online_migrations'), patch.object(s, 'snapshot', return_value=after):
                yield controller, value, prior, module, recovery

    def test_b_origin_cold_read_succeeds_without_retired_containers(self):
        with self.sealed_chain() as (controller, value, prior, module, recovery):
            self.assertEqual(s.pending_online_guard(controller, prior, value, all_services=True), recovery)
            controller.run.assert_not_called(); module.recovery_services.assert_not_called()
            module.verify_permission_seed.assert_called_once(); module.require_fresh_resources.assert_called_once()

    def test_b_source_record_proof_or_before_after_drift_is_rejected(self):
        for changed in ('manifest', 'record', 'proof', 'sealed-configuration', 'preserved-live'):
            with self.subTest(changed=changed), self.sealed_chain() as (controller, value, prior, module, recovery):
                if changed == 'manifest': (prior / 'release-manifest.json').write_text('{}')
                elif changed == 'record': (prior / s.STATE_FILE).write_text('{}')
                elif changed == 'proof': (prior / s.PROOF_FILE).write_text('{}')
                elif changed == 'sealed-configuration': recovery['policy']['preflight']['services']['api']['configurationSha256'] = '0' * 64
                else: value['services']['caddy']['containerId'] = '0' * 64
                with self.assertRaises(RuntimeError): s.pending_online_guard(controller, prior, value)
                controller.run.assert_not_called()

    def test_b_cold_chain_rejects_wrong_origin_in_an_otherwise_resealed_prior_proof(self):
        with self.sealed_chain() as (controller, value, prior, module, recovery):
            proof = json.loads((prior / s.PROOF_FILE).read_text())
            proof['pendingOnlineOriginSha256'] = '0' * 64
            (prior / s.PROOF_FILE).write_text(json.dumps(proof))
            value['priorPublications'][0]['buildProofSha256'] = s.fingerprint(proof)
            with self.assertRaisesRegex(RuntimeError, 'API_ADMIN_PENDING_ONLINE_CHAIN_CHANGED'):
                s.pending_online_guard(controller, prior, value)
            controller.run.assert_not_called(); module.recovery_services.assert_not_called()


class BoundedProofTransport(unittest.TestCase):
    def test_only_pending_workspace_proof_uses_large_compressed_envelope(self):
        value = {'pendingOnlineProjection': {'inventory': 'a' * 33059}}
        encoded = 'gzip:' + base64.b64encode(gzip.compress(json.dumps(value).encode(), mtime=0)).decode()
        self.assertEqual(s.decode_build_proof(SimpleNamespace(require=need), encoded), value)
        with patch.object(s, 'WORKSPACE', False), self.assertRaises(RuntimeError):
            s.decode_build_proof(SimpleNamespace(require=need), encoded)
        ordinary = base64.b64encode(json.dumps(value).encode()).decode()
        with self.assertRaisesRegex(RuntimeError, 'API_ADMIN_BUILD_PROOF_TOO_LARGE'):
            s.decode_build_proof(SimpleNamespace(require=need), ordinary)

    def test_bomb_trailing_stream_and_missing_projection_are_rejected(self):
        for value, tail in [({'pendingOnlineProjection': {'inventory': 'a' * 65536}}, b''), ({'version': 1}, b''),
                            ({'pendingOnlineProjection': {}}, b'unsigned-extra-stream')]:
            encoded = 'gzip:' + base64.b64encode(gzip.compress(json.dumps(value).encode(), mtime=0) + tail).decode()
            with self.subTest(tail=bool(tail)), self.assertRaises(RuntimeError):
                s.decode_build_proof(SimpleNamespace(require=need), encoded)

    def test_real_dispatch_envelope_binds_unchanged_proof_and_fits_ssm_budget(self):
        value = {'pendingOnlineProjection': {'removedFiles': {('f' + str(i) + '.ts'):
            {'mode': '100644', 'sha256': s.hashlib.sha256(str(i).encode()).hexdigest()} for i in range(152)},
            'generatedFiles': {('g' + str(i) + '.ts'): {'before': s.hashlib.sha256(('b' + str(i)).encode()).hexdigest(),
                'after': s.hashlib.sha256(('a' + str(i)).encode()).hexdigest()} for i in range(26)}, 'padding': 'x' * 10000}}
        raw = json.dumps(value, separators=(',', ':')).encode()
        self.assertGreater(len(raw), 16384); self.assertLess(len(raw), 65536)
        text = (ROOT / 'scripts/production-release/dispatch.sh').read_text()
        program = text.split('python3 - "$parameters_file" <<\'PY\'\n', 1)[1].split('\nPY', 1)[0]
        env = {'RELEASE_COMMIT': 'a' * 40, 'SOURCE_TREE': 'b' * 40, 'EXPECTED_CURRENT': online.BASELINE_COMMIT,
            'RELEASE_REPOSITORY': '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release',
            'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1', 'QUALITY_RUN_ID': '456',
            'RELEASE_OPERATION': 'release_api_workspace', 'HISTORICAL_EXCEPTION': 'none'}
        original = Path.read_bytes
        def local_read(path):
            return raw if path.name == 'api-workspace-build-proof.json' else original(path)
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary, patch.dict(os.environ, env, clear=True), \
                patch.object(sys, 'argv', ['generate', str(Path(temporary) / 'parameters.json')]), \
                patch.object(Path, 'read_bytes', local_read):
            exec(compile(program, '<pending-dispatch>', 'exec'), {})
            encoded_parameters = (Path(temporary) / 'parameters.json').read_bytes()
        self.assertLess(len(encoded_parameters), 65536)
        commands = json.loads(encoded_parameters)['commands']
        self.assertEqual(sum('sha256sum -c -' in command for command in commands), 11)
        for name in ('api-admin-pending-receipt-wire.py', 'online-recharge-declaration-measurement.py',
                     'api-admin-readonly.py', 'online-recharge-daemon-identity.py',
                     'online-recharge-daemon-listener.py', 'online-recharge-daemon-socket.py'):
            self.assertTrue(any(name in command for command in commands))
        argument = next(command for command in commands if '--api-admin-build-proof ' in command).split('--api-admin-build-proof ', 1)[1].split()[0]
        self.assertTrue(argument.startswith('gzip:'))
        self.assertEqual(s.decode_build_proof(SimpleNamespace(require=need), argument), value)


class IndependentEndedFailures(unittest.TestCase):
    def fixture(self):
        value = context()
        value['migrationState']['appliedMigrationsSha256'] = '792ed62e35a3110ae1a0e4dec9d1d8a67430972d8bd9f7b9c2f7ff1d0a679088'
        shared = {'errorType': 'RuntimeError', 'rollbackOk': True, 'previousCommit': online.BASELINE_COMMIT,
                  'inverseMigrationPerformed': False, 'mediaVolumeDeleted': False,
                  'currentPointsToCandidate': False, 'receiptPersisted': True}
        first = {**shared, 'status': 'ONLINE_RECHARGE_FAILED_BEFORE_SWITCH', 'step': 'migration',
            'code': 'ONLINE_RECHARGE_STEP_FAILED', 'rollback': {}, 'servicesAttempted': [],
            'candidateCommit': online.RECOVERY_COMMIT, 'migration': {**value['migrationState'], 'performed': True},
            'migrationAttempted': True}
        second = {**shared, 'status': 'ONLINE_RECHARGE_FAILED_RESTORED', 'step': 'audit-after',
            'code': 'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED', 'rollback': {n: 'RESTORED' for n in online.SWITCH_ORDER},
            'servicesAttempted': list(online.SWITCH_ORDER), 'candidateCommit': online.RESTORED_COMMIT,
            'migration': {**value['migrationState'], 'performed': False}, 'migrationAttempted': False}
        expected = s.pending_online_ended_failures(value)
        for row, receipt in zip(expected, (first, second)):
            self.assertEqual(s.fingerprint(receipt), row['receiptSha256'])
        invocations = [{'commandId': row['commandId'], 'instanceId': 'i-1234567890abcdef0',
            'documentName': 'AWS-RunShellScript', 'status': 'Failed', 'responseCode': 1,
            'executionEnd': '2026-10-09T15:00:00.000Z', 'output': json.dumps(receipt)}
            for row, receipt in zip(expected, (first, second))]
        return value, invocations

    def test_exact_two_failures_are_independently_read_and_only_hashes_return(self):
        value, invocations = self.fixture()
        with patch.dict(os.environ, {'AWS_REGION': 'ap-northeast-1', 'PRODUCTION_INSTANCE_ID': 'i-1234567890abcdef0'}), \
                patch.object(t, 'command', side_effect=[json.dumps(v) for v in invocations]) as read:
            result = t.validate_pending_ended_failures(namespace(), value)
        self.assertEqual(result, s.pending_online_ended_failures(value)); self.assertEqual(read.call_count, 2)
        for call, invocation in zip(read.call_args_list, invocations):
            self.assertIn('get-command-invocation', call.args); self.assertIn(invocation['commandId'], call.args)
        self.assertNotIn('output', json.dumps(result)); self.assertNotIn('migrationAttempted', json.dumps(result))

    def test_not_ended_wrong_instance_command_receipt_and_duplicate_fields_are_rejected(self):
        for changed in ('status', 'responseCode', 'instanceId', 'commandId', 'documentName', 'executionEnd',
                        'hash', 'duplicate', 'oversize', 'read-error'):
            value, invocations = self.fixture()
            second = invocations[1]
            changes = {'status': 'InProgress', 'responseCode': 0, 'instanceId': 'i-other', 'commandId': '0' * 36,
                       'documentName': 'other', 'executionEnd': ''}
            if changed in changes: second[changed] = changes[changed]
            elif changed == 'hash': second['output'] = '{"private":"DO_NOT_EMIT_SENTINEL"}'
            elif changed == 'duplicate': second['output'] = '{"status":"one","status":"two"}'
            elif changed == 'oversize': second['output'] = 'a' * 16385
            responses = [json.dumps(v) for v in invocations]
            if changed == 'read-error': responses[1] = RuntimeError('DO_NOT_EMIT_SENTINEL')
            with self.subTest(changed=changed), patch.dict(os.environ, {'AWS_REGION': 'ap-northeast-1',
                    'PRODUCTION_INSTANCE_ID': 'i-1234567890abcdef0'}), patch.object(t, 'command', side_effect=responses):
                with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_ENDED_FAILURE_CHANGED$'):
                    t.validate_pending_ended_failures(namespace(), value)


class PublicationFlow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.existing = load('pending_existing_release_test', 'api-admin-scope.test.py')
        cls.runner = cls.existing.ReleaseFailureTests()

    def origin(self, stage):
        value = context()
        if stage == 2:
            value['priorPublications'] = [{'release': '/opt/id-business-v2/releases/20261010T010000Z-' + '1' * 12,
                'commit': '1' * 40, 'sourceTree': '2' * 40, 'manifestSha256': '3' * 64,
                'recordSha256': '4' * 64, 'buildProofSha256': '5' * 64}]
        return value

    def test_each_stage_writes_pending_record_and_switches_only_api_admin(self):
        for stage in (1, 2):
            with self.subTest(stage=stage):
                value = self.origin(stage)
                code, result, controller, manifest, failure = self.runner.run_release(
                    selected_scope=self.existing.workspace, pending_origin=value)
                self.assertEqual((code, failure), (0, False), result)
                self.assertEqual([call.args[-1] for call in controller.compose.call_args_list], ['admin', 'api'])
                self.assertEqual(manifest['servicesUpdated'], ['api', 'admin'])
                self.assertFalse(manifest['migrationApplied']); self.assertEqual(manifest['newMigrations'], [])
                publication = manifest['apiWorkspacePublication']
                self.assertEqual(publication['version'], 4)
                self.assertFalse(publication['configurationChanged']); self.assertFalse(publication['onlinePublished'])
                self.assertEqual(publication['pendingOnlineMigration']['publicationIndex'], stage)
                self.assertEqual(controller.pending_record['pendingOnlineMigrationOrigin'], value)
                self.assertEqual(controller.pending_record['baselineEvidence']['pendingOnlineMigrationOrigin'], value)
                self.assertNotIn('onlineOrigin', controller.pending_record); self.assertNotIn('onlineRechargePublication', manifest)
                self.assertEqual(controller.pending_build_proof['pendingOnlineOriginSha256'], s.fingerprint(value))
                controller.pending_projection.assert_called_once(); controller.rollback_service.assert_not_called()

    def test_a_and_b_reject_wrong_or_missing_build_origin_before_any_service_switch(self):
        for stage in (1, 2):
            for digest in ('0' * 64, 'MISSING'):
                with self.subTest(stage=stage, digest=digest):
                    code, result, controller, manifest, failure = self.runner.run_release(
                        selected_scope=self.existing.workspace, pending_origin=self.origin(stage),
                        pending_proof_origin_sha=digest)
                    self.assertNotEqual(code, 0)
                    expected = 'API_ADMIN_BUILD_PROOF_INVALID' if digest == 'MISSING' else 'API_ADMIN_PENDING_ONLINE_BUILD_ORIGIN_CHANGED'
                    self.assertIn(expected, str(result))
                    controller.compose.assert_not_called(); controller.point_current.assert_not_called()
                    controller.rollback_service.assert_not_called(); self.assertIsNone(manifest)

    def test_a_and_b_reject_actual_baseline_origin_drift_after_build_before_switch(self):
        for stage in (1, 2):
            value = self.origin(stage); changed = copy.deepcopy(value)
            changed['services']['api']['configurationSha256'] = '0' * 64
            with self.subTest(stage=stage):
                code, result, controller, manifest, failure = self.runner.run_release(
                    selected_scope=self.existing.workspace, pending_origin=value,
                    pending_origin_after_build=changed)
                self.assertNotEqual(code, 0)
                self.assertIn('API_ADMIN_PENDING_ONLINE_BUILD_ORIGIN_CHANGED', str(result))
                controller.compose.assert_not_called(); controller.point_current.assert_not_called()
                controller.rollback_service.assert_not_called(); self.assertIsNone(manifest)

    def test_pending_api_failure_rolls_back_only_the_two_switched_services(self):
        code, result, controller, manifest, failure = self.runner.run_release(
            selected_scope=self.existing.workspace, pending_origin=self.origin(1), fail_at='api-health')
        self.assertEqual(code, 1); self.assertTrue(failure); self.assertIsNone(manifest)
        self.assertEqual([call.args[2] for call in controller.rollback_service.call_args_list], ['api', 'admin'])
        self.assertEqual(result['servicesAttempted'], ['admin', 'api'])

    @contextmanager
    def server_readback(self, stage):
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary, ExitStack() as stack:
            value = self.origin(stage)
            code, result, controller, manifest, _ = self.runner.run_release(
                selected_scope=self.existing.workspace, pending_origin=value)
            self.assertEqual(code, 0, result)
            base = Path(temporary); prior = base / 'releases' / 'prior'; current = base / 'releases' / 'current'
            prior.mkdir(parents=True); current.mkdir(); (base / 'current').symlink_to(current)
            manifest['previousRelease'] = str(prior)
            record = controller.pending_record; proof = controller.pending_build_proof
            (current / s.STATE_FILE).write_text(json.dumps(record)); (current / s.PROOF_FILE).write_text(json.dumps(proof))
            (current / '.env.aws.production').write_bytes(b'fixture')
            controller.BASE = base; observed = record['after']; evidence = record['baselineEvidence']
            stack.enter_context(patch.object(s, 'baseline', return_value=(current, manifest, observed, evidence)))
            stack.enter_context(patch.object(s, 'configuration_hashes', return_value={'config': 'hash'}))
            stack.enter_context(patch.object(s, 'require_preserved'))
            stack.enter_context(patch.object(s, 'pending_projection', return_value=SimpleNamespace(validate_record=MagicMock())))
            stack.enter_context(patch.object(s, 'workspace_volume', return_value=record['workspaceVolumeAfter']))
            stack.enter_context(patch.object(s, 'workspace_configuration', return_value=proof['configuration']))
            stack.enter_context(patch.object(s, 'workspace_health'))
            stack.enter_context(patch.object(s, 'workspace_public_origin', return_value='https://example.test'))
            stack.enter_context(patch.object(s, 'workspace_backup_receipt', return_value=record['workspaceBackup']))
            stack.enter_context(patch.object(s, 'audit_receipt', return_value=manifest['dataAuditBefore']))
            stack.enter_context(patch.object(s, 'verify_running'))
            stack.enter_context(patch.object(s, 'snapshot', return_value=observed))
            guard = stack.enter_context(patch.object(s, 'pending_online_guard'))
            controller.compose.reset_mock()
            yield controller, current, value, record, proof, manifest, guard

    def test_each_independent_scope_readback_keeps_same_pending_origin(self):
        for stage in (1, 2):
            with self.subTest(stage=stage), self.server_readback(stage) as (controller, current, value, record, proof, manifest, guard):
                readback = s.readback(controller, self.existing.COMMIT)
                self.assertEqual(readback['pendingOnlineMigrationOrigin'], value)
                self.assertEqual(readback['preservedPendingOnlineMigration']['publicationIndex'], stage)
                self.assertEqual((readback['observedServiceCount'], readback['preservedServiceCount']), (7, 5))
                self.assertFalse(readback['onlinePublished']); self.assertFalse(readback['migrationPerformed'])
                guard.assert_called_once_with(controller, current, value)

    def test_server_readback_rejects_saved_build_digest_or_complete_origin_drift(self):
        for stage in (1, 2):
            for changed in ('digest', 'missing', 'origin', 'evidence-origin'):
                with self.subTest(stage=stage, changed=changed), self.server_readback(stage) as (controller, current, value, record, proof, manifest, guard):
                    if changed == 'digest': proof['pendingOnlineOriginSha256'] = '0' * 64
                    elif changed == 'missing': proof.pop('pendingOnlineOriginSha256')
                    elif changed == 'origin': record['pendingOnlineMigrationOrigin']['restoredOrigin']['recordSha256'] = '0' * 64
                    else:
                        record['baselineEvidence']['pendingOnlineMigrationOrigin'] = copy.deepcopy(value)
                        record['baselineEvidence']['pendingOnlineMigrationOrigin']['baselineManifestSha256'] = '0' * 64
                    (current / s.STATE_FILE).write_text(json.dumps(record))
                    (current / s.PROOF_FILE).write_text(json.dumps(proof))
                    with self.assertRaises(RuntimeError): s.readback(controller, self.existing.COMMIT)
                    controller.compose.assert_not_called()


class MigrationSource(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(dir=OUTPUT)
        cls.source = Path(cls.directory.name)
        names = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', online.RECOVERY_COMMIT,
            online.MIGRATION_ROOT], cwd=ROOT).decode().splitlines()
        for name in [*names, online.SCHEMA_FILE, online.SEED_FILE]:
            revision = online.BASELINE_COMMIT if name in (online.SCHEMA_FILE, online.SEED_FILE) else online.RECOVERY_COMMIT
            path = cls.source / name; path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(subprocess.check_output(['git', 'show', revision + ':' + name], cwd=ROOT))

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def test_old_47_files_and_only_fixed_new_sql_are_recognized(self):
        controller = SimpleNamespace(require=need, online_recharge_scope=lambda: (online, None))
        self.assertEqual(s.pending_online_migrations(controller, self.source), online.MIGRATION_FILE)
        self.assertEqual(len(s.migration_files(SimpleNamespace(require=need), self.source)), 48)

    def test_extra_migration_changed_sql_and_after_schema_are_rejected(self):
        names = [online.MIGRATION_ROOT + '/20261010000000_unknown/migration.sql',
                 online.MIGRATION_ROOT + '/' + online.MIGRATION_FILE, online.SCHEMA_FILE]
        for name in names:
            target = self.source / name
            old = target.read_bytes() if target.exists() else None
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b'ALTER TABLE unexpected;')
            try:
                with self.subTest(name=name), self.assertRaises(RuntimeError):
                    s.pending_online_migrations(SimpleNamespace(require=need,
                        online_recharge_scope=lambda: (online, None)), self.source)
            finally:
                if old is None: target.unlink(); target.parent.rmdir()
                else: target.write_bytes(old)


class TransportBinding(unittest.TestCase):
    @contextmanager
    def receipts(self, value=None):
        value = context() if value is None else value
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary:
            old_cwd = os.getcwd(); os.chdir(temporary)
            output = Path('.deploy/production-release'); output.mkdir(parents=True)
            before = {'status': 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED', 'mode': 'preflight',
                'commit': online.BASELINE_COMMIT, 'releaseCandidateCommit': 'a' * 40,
                'workflowRunId': '123', 'workflowRunAttempt': '1',
                'pendingOnlineMigrationOrigin': value, 'pendingOnlineEndedFailures': s.pending_online_ended_failures(value),
                'services': value['services'],
                'onlinePublished': False, 'migrationPerformed': False}
            (output / 'api-workspace-preflight-result.json').write_text(json.dumps(before))
            receipt = {'pendingOnlineMigrationOrigin': value,
                'preservedPendingOnlineMigration': s.pending_online_marker(value),
                'services': copy.deepcopy(value['services']), 'observedServiceCount': 7,
                'servicesUpdated': ['api', 'admin'], 'onlinePublished': False, 'migrationPerformed': False}
            receipt['services']['api']['containerId'] = '9' * 64
            receipt['services']['admin']['containerId'] = '8' * 64
            env = {'RELEASE_COMMIT': 'a' * 40, 'EXPECTED_CURRENT': online.BASELINE_COMMIT,
                   'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1'}
            try:
                with patch.dict(os.environ, env): yield before, receipt, output
            finally:
                os.chdir(old_cwd)

    def test_preflight_and_independent_readback_share_pending_origin(self):
        with self.receipts() as (before, receipt, output):
            self.assertTrue(t.validate_pending_workspace_receipt(namespace(), before, online.BASELINE_COMMIT, 'preflight'))
            self.assertTrue(t.validate_pending_workspace_receipt(namespace(), receipt, 'a' * 40, 'readback',
                proof={'pendingOnlineProjection': {}, 'pendingOnlineOriginSha256': s.fingerprint(before['pendingOnlineMigrationOrigin'])}))

    def test_readback_rejects_missing_origin_same_run_drift_and_all_five_preserved_services(self):
        for change in ('missing', 'online', 'run', 'candidate', 'proof', 'ended', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration'):
            with self.subTest(change=change), self.receipts() as (before, receipt, output):
                proof = {'pendingOnlineProjection': {},
                         'pendingOnlineOriginSha256': s.fingerprint(before['pendingOnlineMigrationOrigin'])}
                if change == 'missing': receipt.pop('pendingOnlineMigrationOrigin')
                elif change == 'online': receipt['onlinePublished'] = True
                elif change == 'run': before['workflowRunId'] = '124'
                elif change == 'candidate': before['releaseCandidateCommit'] = 'b' * 40
                elif change == 'proof': proof = {}
                elif change == 'ended': before.pop('pendingOnlineEndedFailures')
                else: receipt['services'][change]['configurationSha256'] = '0' * 64
                (output / 'api-workspace-preflight-result.json').write_text(json.dumps(before))
                with self.assertRaisesRegex(RuntimeError, 'API_ADMIN_PENDING_ONLINE_RECEIPT_CHANGED'):
                    t.validate_pending_workspace_receipt(namespace(), receipt, 'a' * 40, 'readback', proof=proof)

    def test_projection_cannot_select_fallback_reader_when_origin_is_removed(self):
        with self.receipts() as (before, receipt, output):
            before.pop('pendingOnlineMigrationOrigin')
            receipt.pop('pendingOnlineMigrationOrigin'); receipt.pop('preservedPendingOnlineMigration')
            (output / 'api-workspace-preflight-result.json').write_text(json.dumps(before))
            with self.assertRaises(RuntimeError):
                t.validate_pending_workspace_receipt(namespace(), receipt, 'a' * 40, 'readback',
                    proof={'pendingOnlineProjection': {}, 'pendingOnlineOriginSha256': s.fingerprint(context())})

    def test_independent_transport_rejects_missing_wrong_or_illegal_proof_origin_digest(self):
        for change in ('missing', 'wrong', 'short', 'integer', 'null', 'ordinary-extra'):
            with self.subTest(change=change), self.receipts() as (before, receipt, output):
                proof = {'pendingOnlineProjection': {},
                         'pendingOnlineOriginSha256': s.fingerprint(before['pendingOnlineMigrationOrigin'])}
                if change == 'missing': proof.pop('pendingOnlineOriginSha256')
                elif change == 'wrong': proof['pendingOnlineOriginSha256'] = '0' * 64
                elif change == 'short': proof['pendingOnlineOriginSha256'] = 'a' * 63
                elif change == 'integer': proof['pendingOnlineOriginSha256'] = 1
                elif change == 'null': proof['pendingOnlineOriginSha256'] = None
                else:
                    proof.pop('pendingOnlineProjection')
                    receipt.pop('pendingOnlineMigrationOrigin'); receipt.pop('preservedPendingOnlineMigration')
                    before.pop('pendingOnlineMigrationOrigin'); before.pop('pendingOnlineEndedFailures')
                    (output / 'api-workspace-preflight-result.json').write_text(json.dumps(before))
                with self.assertRaisesRegex(RuntimeError, 'API_ADMIN_PENDING_ONLINE_RECEIPT_CHANGED'):
                    t.validate_pending_workspace_receipt(namespace(), receipt, 'a' * 40, 'readback', proof=proof)

    def test_independent_transport_rejects_different_full_receipt_origin_despite_correct_build_digest(self):
        for changed in ('baseline', 'restored', 'service'):
            with self.subTest(changed=changed), self.receipts() as (before, receipt, output):
                proof = {'pendingOnlineProjection': {},
                         'pendingOnlineOriginSha256': s.fingerprint(before['pendingOnlineMigrationOrigin'])}
                receipt['pendingOnlineMigrationOrigin'] = copy.deepcopy(receipt['pendingOnlineMigrationOrigin'])
                value = receipt['pendingOnlineMigrationOrigin']
                if changed == 'baseline': value['baselineManifestSha256'] = '0' * 64
                elif changed == 'restored': value['restoredOrigin']['recordSha256'] = '0' * 64
                else: value['services']['api']['containerId'] = '0' * 64
                with self.assertRaisesRegex(RuntimeError, 'API_ADMIN_PENDING_ONLINE_RECEIPT_CHANGED'):
                    t.validate_pending_workspace_receipt(namespace(), receipt, 'a' * 40, 'readback', proof=proof)

    def test_workspace_downloads_pin_projection_and_pending_source_readers(self):
        commands = t.parameters('a' * 40, online.BASELINE_COMMIT, 'preflight', 'API_ADMIN_WORKSPACE')['commands']
        for file in ('api-admin-pending-projection.py', 'online-recharge-scope.py', 'online-recharge-recovery.json'):
            self.assertTrue(any(file in command and 'curl -fsSL' in command for command in commands))
            self.assertTrue(any(file in command and 'sha256sum -c' in command for command in commands))


class RecoveryGate(unittest.TestCase):
    def test_missing_ended_second_failure_is_never_accepted(self):
        module = SimpleNamespace(release_recovery=MagicMock(return_value={'state': context()['migrationState']}))
        controller = SimpleNamespace(require=need, online_recharge_scope=lambda: (module, None))
        with self.assertRaisesRegex(RuntimeError, 'API_ADMIN_PENDING_ONLINE_RECOVERY_REQUIRED'):
            s.pending_online_recovery(controller, Path('/not-production'))

    def test_diagnostic_projection_is_not_a_recovery_witness(self):
        recovery = {'state': context()['migrationState'], 'restored': {}, 'source': Path('/sealed')}
        module = SimpleNamespace(release_recovery=MagicMock(return_value=recovery),
            recovery_services=MagicMock(side_effect=RuntimeError('ONLINE_RECHARGE_PRESERVED_CONTAINER_CHANGED')))
        controller = SimpleNamespace(require=need, online_recharge_scope=lambda: (module, None), BASE=OUTPUT)
        directory = OUTPUT / 'releases/placeholder'
        with patch.object(s, 'snapshot', return_value=states()):
            with self.assertRaisesRegex(RuntimeError, 'ONLINE_RECHARGE_PRESERVED_CONTAINER_CHANGED'):
                s.pending_online_first(controller, directory)
        module.recovery_services.assert_called_once()

    def test_successor_context_is_removed_from_original_failed_publication_reader(self):
        module = SimpleNamespace(release_recovery=MagicMock(return_value={'state': context()['migrationState'], 'restored': {}}))
        controller = SimpleNamespace(require=need, online_recharge_scope=lambda: (module, None),
            _pendingOnlineMigrationOrigin=context(), _pendingOnlineHistoryProjected=True)
        s.pending_online_recovery(controller, Path('/sealed'))
        reader = module.release_recovery.call_args.args[0]
        self.assertFalse(hasattr(reader, '_pendingOnlineMigrationOrigin'))
        self.assertFalse(hasattr(reader, '_pendingOnlineHistoryProjected'))


class PreservationGate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(dir=OUTPUT)
        cls.sealed = Path(cls.directory.name) / 'sealed'; cls.sealed.mkdir()
        names = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', online.RECOVERY_COMMIT,
            online.MIGRATION_ROOT], cwd=ROOT).decode().splitlines()
        for name in [*names, online.SCHEMA_FILE, online.SEED_FILE, *s.CONFIG_FILES[:2]]:
            revision = online.BASELINE_COMMIT if name not in names else online.RECOVERY_COMMIT
            path = cls.sealed / name; path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(subprocess.check_output(['git', 'show', revision + ':' + name], cwd=ROOT))

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    @contextmanager
    def fixture(self):
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary:
            old, new = (Path(temporary) / n for n in ('old', 'new'))
            for directory in (old, new):
                shutil.copytree(self.sealed, directory)
                (directory / '.env.aws.production').write_bytes(b'TEST_ONLY=fixture\n')
                (directory / 'compose.release.json').write_text(json.dumps({'services': {
                    n: {'image': 'old-' + n, 'pull_policy': 'never'} for n in ('api', 'admin', 'media-resolver', 'auto-recharge', 'auto-registration')}}))
            (old / online.MIGRATION_ROOT / online.MIGRATION_FILE).unlink()
            (old / online.MIGRATION_ROOT / online.MIGRATION_NAME).rmdir()
            before = states()
            controller = SimpleNamespace(require=need, _pendingOnlineMigrationOrigin=context(),
                online_recharge_scope=lambda: (online, None), migration_plan=MagicMock(return_value=[online.MIGRATION_FILE]),
                compose=MagicMock(), apply_migration=MagicMock(), run_release_migrations=MagicMock())
            with patch.object(s, 'pending_online_guard') as guard, patch.object(s, 'snapshot', return_value=before) as snapshot:
                yield controller, old, new, before, guard, snapshot

    def test_projected_schema_compose_and_only_known_migration_plan_pass_without_migrating(self):
        with self.fixture() as (controller, old, new, before, guard, snapshot):
            self.assertEqual(s.require_preserved(controller, old, new, before, b'TEST_ONLY=fixture\n', all_services=True), before)
            guard.assert_called_once_with(controller, old, controller._pendingOnlineMigrationOrigin, all_services=True)
            controller.apply_migration.assert_not_called(); controller.run_release_migrations.assert_not_called()
            controller.compose.assert_not_called()

    def test_raw_online_schema_compose_and_unrelated_migration_still_block(self):
        for changed in ('schema', 'compose', 'migration'):
            with self.subTest(changed=changed), self.fixture() as (controller, old, new, before, guard, snapshot):
                if changed in ('schema', 'compose'):
                    name = online.SCHEMA_FILE if changed == 'schema' else s.CONFIG_FILES[0]
                    (new / name).write_bytes(subprocess.check_output(['git', 'show', online.RECOVERY_COMMIT + ':' + name], cwd=ROOT))
                else: controller.migration_plan.return_value = ['20261010000000_other/migration.sql']
                with self.assertRaises(RuntimeError): s.require_preserved(controller, old, new, before, b'TEST_ONLY=fixture\n')
                controller.apply_migration.assert_not_called(); controller.run_release_migrations.assert_not_called()

    def test_caddy_is_preserved_as_fifth_service_and_never_restartable_in_pending_mode(self):
        with self.fixture() as (controller, old, new, before, guard, snapshot):
            changed = copy.deepcopy(before); changed['caddy']['containerId'] = '0' * 64
            snapshot.return_value = changed
            with self.assertRaisesRegex(RuntimeError, 'API_ADMIN_PRESERVED_CONTAINER_CHANGED'):
                s.require_preserved(controller, old, new, before, b'TEST_ONLY=fixture\n')

    def test_changed_old_47_file_is_not_hidden_by_new_migration_admission(self):
        with self.fixture() as (controller, old, new, before, guard, snapshot):
            (new / online.MIGRATION_ROOT / 'migration_lock.toml').write_bytes(b'provider="other"')
            with self.assertRaisesRegex(RuntimeError, 'API_ADMIN_PENDING_ONLINE_MIGRATION_SOURCE_CHANGED'):
                s.require_preserved(controller, old, new, before, b'TEST_ONLY=fixture\n')


class DeclarationConsumerBinding(unittest.TestCase):
    fixture = BuildOriginBinding.fixture
    seal_path = BuildOriginBinding.seal_path
    assert_no_image_reads = BuildOriginBinding.assert_no_image_reads

    @contextmanager
    def private_fixture(self, stage=1):
        kwargs = {} if stage == 1 else {'candidate': 'd' * 40, 'source_tree': 'e' * 40}
        with self.fixture(declaration_context(stage), **kwargs) as fixture:
            fixture[2].joinpath('api-workspace-preflight-result.json').chmod(0o600)
            yield fixture

    def test_origin_v2_is_closed_and_preserves_initial_proof_across_a_and_b(self):
        for stage in (1, 2):
            value = declaration_context(stage)
            self.assertIs(s.validate_pending_online_origin(value), value)
            self.assertEqual(value['restoredConfigurationProof'], declaration_context()['restoredConfigurationProof'])
        for mutate in ('extra', 'version-bool', 'downgrade', 'purpose', 'historical', 'marker',
                       'actual-api', 'stable-service', 'prior-producer', 'second-prior'):
            value = declaration_context(2 if mutate in ('stable-service', 'prior-producer', 'second-prior') else 1)
            if mutate == 'extra': value['authority'] = True
            elif mutate == 'version-bool': value['version'] = True
            elif mutate == 'downgrade': value['version'] = 1
            elif mutate == 'purpose': value['restoredConfigurationProof']['measurement']['purpose'] = 'DEPLOYMENT_REMEASURE'
            elif mutate == 'historical': value['baselineManifestSha256'] = '0' * 64
            elif mutate == 'marker': value['restoredConfigurationProof']['semantic']['fixedRecovery']['recoveryMarkerSha256'] = '0' * 64
            elif mutate == 'actual-api': value['services']['api']['configurationSha256'] = '0' * 64
            elif mutate == 'stable-service': value['services']['mysql']['containerId'] = '0' * 64
            elif mutate == 'prior-producer': value['priorPublications'][0]['sourceTree'] = '0' * 40
            else: value['priorPublications'].append(copy.deepcopy(value['priorPublications'][0]))
            with self.subTest(mutate=mutate), self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_ORIGIN_CHANGED$'):
                s.validate_pending_online_origin(value)

    def test_v2_has_no_native_guard_fallback_or_source_authority_from_structure(self):
        controller = SimpleNamespace(require=need)
        with patch.object(s, 'pending_online_recovery') as recovery, patch.object(s, 'snapshot') as snapshot:
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_RECOVERY_REQUIRED$'):
                s.pending_online_guard(controller, Path('/unused'), declaration_context())
            recovery.assert_not_called(); snapshot.assert_not_called()
        with patch.object(s, 'pending_online_equivalence', return_value=SimpleNamespace()):
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_RECOVERY_REQUIRED$'):
                s.pending_online_declaration_call(controller, 'declaration_equivalence_issuer_binding', {})

    def test_actual_formal_initial_and_remeasure_stay_source_not_measured_before_io(self):
        controller = SimpleNamespace(require=need)
        value = declaration_context()
        producer = {name: value['restoredConfigurationProof']['semantic']['producer'][name]
                    for name in ('commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt')}
        # Use the real frozen closed generator, not a success-producing fixture.
        materials = MagicMock(side_effect=AssertionError('unmeasured source I/O'))
        helper = SimpleNamespace(measure_declaration_equivalence=online.measure_declaration_equivalence,
            declaration_equivalence_materials=materials,
            declaration_equivalence_source_binding=online.declaration_equivalence_source_binding)
        with patch.object(s, 'pending_online_equivalence', return_value=helper):
            with self.assertRaisesRegex(RuntimeError, '^ONLINE_RECHARGE_DECLARATION_SOURCE_NOT_MEASURED$'):
                s.pending_online_declaration_initial_measure(controller, Path('/unused'), {}, producer=producer)
            materials.assert_not_called()
        with self.private_fixture() as (controller, before, output, projection):
            raw = output.joinpath('api-workspace-preflight-result.json').read_bytes()
            # Origin validation uses the actual pure module before the shared
            # measuring helper is selected; neither branch enables publication.
            with self.assertRaisesRegex(RuntimeError, '^ONLINE_RECHARGE_DECLARATION_SOURCE_NOT_MEASURED$'):
                s.pending_online_declaration_remeasure(controller, Path('/unused'), {},
                    producer=producer, origin=value, preflight_raw=raw)
            self.assert_no_image_reads(controller)
        with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_CHAIN_CHANGED$'):
            s.pending_online_declaration_remeasure(controller, Path('/unused'), {},
                producer=producer, origin=declaration_context(2), preflight_raw=b'{}')

    def test_actual_prepare_and_build_bind_exact_private_f_for_a_and_b(self):
        for stage in (1, 2):
            with self.subTest(stage=stage), self.private_fixture(stage) as (controller, before, output, helper):
                raw = output.joinpath('api-workspace-preflight-result.json').read_bytes()
                s.prepare_workspace_build(controller)
                seal = json.loads(self.seal_path(output).read_bytes())
                self.assertEqual(seal['version'], 2)
                self.assertEqual(seal['pendingOnlinePreflightSha256'], hashlib.sha256(raw).hexdigest())
                self.assertLessEqual(self.seal_path(output).stat().st_size, 1024)
                with redirect_stdout(io.StringIO()): s.build_proof(controller)
                proof = json.loads(output.joinpath(s.PROOF_FILE).read_bytes())
                self.assertEqual(proof['version'], 2)
                self.assertEqual(proof['pendingOnlinePreflightSha256'], seal['pendingOnlinePreflightSha256'])
                first = before['pendingOnlineMigrationOrigin']['restoredConfigurationProof']
                self.assertEqual(proof['declarationEquivalenceSeal'], {
                    'kind': first['kind'], 'version': 3, 'preflightProofSha256': s.fingerprint(first),
                    'semanticSha256': s.fingerprint(first['semantic'])})
                s.validate_proof(controller, proof, os.environ['RELEASE_COMMIT'], os.environ['SOURCE_TREE'])
                self.assertEqual(s.prepare_workspace_build(controller), helper.prepare_build.return_value)

    def test_semantically_identical_f_byte_replacement_rejects_repeat_prepare_and_build(self):
        for stage in (1, 2):
            for operation in (s.prepare_workspace_build, s.build_proof):
                with self.subTest(stage=stage, operation=operation.__name__), self.private_fixture(stage) as (controller, before, output, helper):
                    s.prepare_workspace_build(controller)
                    seal = self.seal_path(output).read_bytes()
                    path = output / 'api-workspace-preflight-result.json'
                    path.write_bytes(path.read_bytes() + b'\n')
                    self.assertEqual(s.pending_online_build_origin(controller), before['pendingOnlineMigrationOrigin'])
                    with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_BUILD_ORIGIN_CHANGED$'):
                        with redirect_stdout(io.StringIO()): operation(controller)
                    self.assertEqual(self.seal_path(output).read_bytes(), seal)
                    self.assert_no_image_reads(controller)
                    self.assertFalse(output.joinpath(s.PROOF_FILE).exists())

    def test_private_f_rejects_mode_link_size_and_duplicate_keys(self):
        for mutate in ('mode', 'symlink', 'hardlink', 'oversize', 'duplicate'):
            with self.subTest(mutate=mutate), self.private_fixture() as (controller, before, output, helper):
                path = output / 'api-workspace-preflight-result.json'
                if mutate == 'mode': path.chmod(0o644)
                elif mutate == 'symlink':
                    target = output / 'other.json'; path.rename(target); path.symlink_to(target.name)
                elif mutate == 'hardlink': os.link(path, output / 'other.json')
                elif mutate == 'oversize': path.write_bytes(path.read_bytes() + b' ' * 65536)
                else:
                    raw = path.read_bytes()
                    path.write_bytes(b'{"mode":"preflight",' + raw[1:])
                with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_PREFLIGHT_CHANGED$'):
                    s.prepare_workspace_build(controller)
                helper.prepare_build.assert_not_called()
                self.assertFalse(self.seal_path(output).exists())

    def test_initial_producer_must_match_actual_runner_candidate_tree_run_attempt(self):
        for key in ('commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'):
            with self.subTest(key=key), self.private_fixture() as (controller, before, output, helper):
                producer = before['pendingOnlineMigrationOrigin']['restoredConfigurationProof']['semantic']['producer']
                producer[key] = '9' * 40 if key in ('commit', 'sourceTree') else '9'
                output.joinpath('api-workspace-preflight-result.json').write_text(json.dumps(before))
                with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_PREFLIGHT_CHANGED$'):
                    s.prepare_workspace_build(controller)
                self.assertFalse(self.seal_path(output).exists())

    def test_prepared_v2_cannot_remove_origin_projection_or_change_runner(self):
        for stage in (1, 2):
            for mutate in ('remove', 'candidate', 'tree', 'run', 'attempt'):
                for operation in (s.prepare_workspace_build, s.build_proof):
                    with self.subTest(stage=stage, mutate=mutate, operation=operation.__name__), self.private_fixture(stage) as (controller, before, output, helper):
                        s.prepare_workspace_build(controller)
                        seal = self.seal_path(output).read_bytes()
                        if mutate == 'remove':
                            before.pop('pendingOnlineMigrationOrigin')
                            output.joinpath('api-admin-pending-build-projection.json').unlink()
                        else:
                            names = {'candidate': ('RELEASE_COMMIT', 'releaseCandidateCommit', 'commit'),
                                'tree': ('SOURCE_TREE', None, 'sourceTree'),
                                'run': ('GITHUB_RUN_ID', 'workflowRunId', 'workflowRunId'),
                                'attempt': ('GITHUB_RUN_ATTEMPT', 'workflowRunAttempt', 'workflowRunAttempt')}
                            envkey, wrapperkey, producerkey = names[mutate]
                            changed = '9' * 40 if mutate in ('candidate', 'tree') else '9'
                            os.environ[envkey] = changed
                            if mutate in ('candidate', 'tree'):
                                original_run = controller.run.side_effect
                                def changed_git(*arguments):
                                    if arguments == ('git', 'rev-parse', 'HEAD'): return os.environ['RELEASE_COMMIT']
                                    if arguments == ('git', 'rev-parse', 'HEAD^{tree}'): return os.environ['SOURCE_TREE']
                                    return original_run(*arguments)
                                controller.run.side_effect = changed_git
                            if wrapperkey: before[wrapperkey] = changed
                            if stage == 1:
                                before['pendingOnlineMigrationOrigin']['restoredConfigurationProof']['semantic']['producer'][producerkey] = changed
                        output.joinpath('api-workspace-preflight-result.json').write_text(json.dumps(before))
                        with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_BUILD_ORIGIN_CHANGED$'):
                            with redirect_stdout(io.StringIO()): operation(controller)
                        self.assertEqual(self.seal_path(output).read_bytes(), seal)
                        self.assert_no_image_reads(controller)

    def test_build_cannot_seal_different_bytes_than_the_fields_it_will_publish(self):
        with self.private_fixture() as (controller, before, output, helper):
            s.prepare_workspace_build(controller)
            raw = output.joinpath('api-workspace-preflight-result.json').read_bytes()
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_BUILD_ORIGIN_CHANGED$'):
                s.pending_online_build_seal(controller, before['pendingOnlineMigrationOrigin'], preflight_raw=raw + b'\n')

    def test_pair_binds_p2_to_actual_full_f_bytes_and_initial_p(self):
        with self.private_fixture() as (controller, before, output, helper):
            raw = output.joinpath('api-workspace-preflight-result.json').read_bytes()
            origin = before['pendingOnlineMigrationOrigin']
            second = copy.deepcopy(origin['restoredConfigurationProof'])
            second['measurement'].update(purpose='DEPLOYMENT_REMEASURE', executionNonce='2' * 32,
                priorIndependentPreflightBytesSha256=hashlib.sha256(raw).hexdigest(),
                priorProofSha256=s.fingerprint(origin['restoredConfigurationProof']))
            seal = s.pending_online_declaration_pair(controller, origin, second, raw)
            self.assertEqual(seal['preflightBytesSha256'], hashlib.sha256(raw).hexdigest())
            for mutate in ('bytes', 'prior-proof', 'semantic', 'phase'):
                changed = copy.deepcopy(second); changed_origin = copy.deepcopy(origin); changed_raw = raw
                if mutate == 'bytes': changed_raw += b'\n'
                elif mutate == 'prior-proof': changed['measurement']['priorProofSha256'] = '0' * 64
                elif mutate == 'semantic': changed['semantic']['apiEquivalence']['rulesSha256'] = '0' * 64
                else: changed_origin = declaration_context(2)
                with self.subTest(mutate=mutate), self.assertRaisesRegex(RuntimeError, 'API_ADMIN_PENDING_ONLINE_(ORIGIN|CHAIN)_CHANGED'):
                    s.pending_online_declaration_pair(controller, changed_origin, changed, changed_raw)

    def test_publication_without_real_source_bytes_is_rejected(self):
        value = declaration_context(); controller = SimpleNamespace(require=need)
        with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_ORIGIN_CHANGED$'):
            s.pending_online_declaration_publication(controller, origin=value,
                second=value['restoredConfigurationProof'], preflight_raw=b'{}', build_raw=b'{}',
                record_raw=b'{}', manifest_raw=b'{}', producer=value['restoredConfigurationProof']['semantic']['producer'],
                archive_bytes=b'', historical_files={})

    def test_issuer_and_cold_are_separate_pure_consumers_of_live_state_and_ended_q(self):
        controller = SimpleNamespace(require=need); value = declaration_context()
        producer = value['restoredConfigurationProof']['semantic']['producer']
        configuration = {name: 'f' * 64 for name in ('docker-compose.aws-mysql.yml',
            'deploy/caddy/Caddyfile.aws', online.SCHEMA_FILE, 'compose.release.json')}
        publication = {'kind': online.DECLARATION_EQUIVALENCE_KIND, 'version': 3,
            'producer': producer, 'preflightCommandId': '00000000-0000-0000-0000-000000000001',
            **{name: 'f' * 64 for name in ('preflightBytesSha256', 'manifestBytesSha256', 'recordBytesSha256',
                'buildProofBytesSha256', 'buildProofCanonicalSha256', 'archiveInventorySha256')},
            'configurationEquivalenceSeal': {'fixture': 'not-production'},
            'afterServices': value['services'], 'configurationAfter': configuration}
        issuer = s.pending_online_declaration_issuer(controller, publication,
            live_services=value['services'], live_configuration=configuration, execution_producer=producer)
        wire = load('pending_v3_wire', 'api-admin-pending-receipt-wire.py')
        output = wire.receipt_output({'status': 'API_ADMIN_WORKSPACE_VERIFIED',
            'declarationEquivalencePublication': issuer}, scope='API_ADMIN_WORKSPACE')
        command = '00000000-0000-0000-0000-000000000002'
        invocation = {'CommandId': command, 'Status': 'Success', 'ResponseCode': 0, 'StandardOutputContent': output}
        raw = json.dumps(invocation).encode()
        result = s.pending_online_declaration_cold(controller, publication, raw,
            command_id=command, wire_decoder=wire.decode_receipt_output)
        self.assertEqual(result['readbackCommandId'], command)
        self.assertEqual(raw, json.dumps(invocation).encode())
        for mutate in ('missing', 'pending', 'failed', 'bool-response', 'wrong-command', 'missing-decoder', 'bad-output'):
            changed = copy.deepcopy(invocation); decoder = wire.decode_receipt_output
            if mutate == 'missing': changed = {}
            elif mutate == 'pending': changed['Status'] = 'InProgress'
            elif mutate == 'failed': changed['ResponseCode'] = 1
            elif mutate == 'bool-response': changed['ResponseCode'] = False
            elif mutate == 'wrong-command': changed['CommandId'] = '00000000-0000-0000-0000-000000000003'
            elif mutate == 'missing-decoder': decoder = None
            else: changed['StandardOutputContent'] += ' untrusted'
            with self.subTest(mutate=mutate), self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_ORIGIN_CHANGED$'):
                s.pending_online_declaration_cold(controller, publication, json.dumps(changed).encode(),
                    command_id=command, wire_decoder=decoder)
        changed = copy.deepcopy(value['services']); changed['api']['containerId'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_ORIGIN_CHANGED$'):
            s.pending_online_declaration_issuer(controller, publication,
                live_services=changed, live_configuration=configuration, execution_producer=producer)


class DeclarationEntryFoundation(unittest.TestCase):
    def producer(self):
        return {'commit': 'a' * 40, 'sourceTree': 'b' * 40, 'workflowRunId': '123', 'workflowRunAttempt': '1'}

    def controller(self, entry):
        flags = {'PREFLIGHT': '--api-workspace-preflight', 'STAGE': '--api-workspace-only',
                 'READBACK': '--api-workspace-readback'}
        return SimpleNamespace(require=need, _apiWorkspaceDeclarationProducer=self.producer(),
            _apiWorkspaceDeclarationEntry=entry, sys=SimpleNamespace(argv=['remote.py', flags[entry]]))

    def test_actual_cli_entry_and_private_producer_are_both_required(self):
        for entry in ('PREFLIGHT', 'STAGE', 'READBACK'):
            controller = self.controller(entry)
            self.assertEqual(s.pending_online_declaration_entry(controller), entry)
            self.assertEqual(s.pending_online_declaration_producer(controller), self.producer())
        for mutate in ('missing-entry', 'unknown-entry', 'wrong-flag', 'multiple-flags', 'missing-producer',
                       'extra-producer', 'bool-producer', 'bad-tree', 'bad-run'):
            controller = self.controller('PREFLIGHT')
            if mutate == 'missing-entry': del controller._apiWorkspaceDeclarationEntry
            elif mutate == 'unknown-entry': controller._apiWorkspaceDeclarationEntry = 'CALLER_TRUSTED'
            elif mutate == 'wrong-flag': controller.sys.argv = ['remote.py', '--api-workspace-readback']
            elif mutate == 'multiple-flags': controller.sys.argv.append('--api-workspace-only')
            elif mutate == 'missing-producer': del controller._apiWorkspaceDeclarationProducer
            elif mutate == 'extra-producer': controller._apiWorkspaceDeclarationProducer['trusted'] = True
            elif mutate == 'bool-producer': controller._apiWorkspaceDeclarationProducer = True
            elif mutate == 'bad-tree': controller._apiWorkspaceDeclarationProducer['sourceTree'] = '0' * 64
            else: controller._apiWorkspaceDeclarationProducer['workflowRunId'] = '0'
            with self.subTest(mutate=mutate), self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_RECOVERY_REQUIRED$'):
                s.pending_online_declaration_entry(controller)
                s.pending_online_declaration_producer(controller)

    def test_native_transition_requires_real_configuration_mismatch_and_all_other_identities(self):
        value = declaration_context(); original = value['restoredConfigurationProof']['semantic']['original']
        actual = value['services']; recovery = {'policy': {'preflight': {'services': original}}}
        controller = self.controller('PREFLIGHT')
        s.pending_online_declaration_native_mismatch(controller, actual, recovery)
        for mutate in ('native-match', 'missing-service', 'extra-row-key', 'mysql', 'api-image',
                       'api-environment', 'admin-status', 'bad-cid'):
            changed = copy.deepcopy(actual)
            if mutate == 'native-match': changed = copy.deepcopy(original)
            elif mutate == 'missing-service': changed.pop('auto-registration')
            elif mutate == 'extra-row-key': changed['api']['trusted'] = True
            elif mutate == 'mysql': changed['mysql']['containerId'] = '0' * 64
            elif mutate == 'api-image': changed['api']['image'] = 'sha256:' + '0' * 64
            elif mutate == 'api-environment': changed['api']['environmentSha256'] = '0' * 64
            elif mutate == 'admin-status': changed['admin']['status'] = 'stopped'
            else: changed['api']['containerId'] = 'not-a-hash'
            with self.subTest(mutate=mutate), self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_SERVICES_CHANGED$'):
                s.pending_online_declaration_native_mismatch(controller, changed, recovery)

    @contextmanager
    def initial_fixture(self, *, entry='PREFLIGHT', native_error=None):
        value = declaration_context()
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary, ExitStack() as stack:
            base = Path(temporary).resolve(); directory = base / 'releases' / Path(value['baselineRelease']).name
            directory.mkdir(parents=True); (directory / 'release-manifest.json').write_text(json.dumps({'commit': online.BASELINE_COMMIT}))
            failure = directory.parent / ('20261009T132000Z-' + online.RECOVERY_COMMIT[:12]); failure.mkdir()
            (base / 'current').symlink_to(directory)
            controller = self.controller(entry); controller.BASE = base
            module = SimpleNamespace(**vars(online))
            module.verify_permission_seed = MagicMock(); module.require_fresh_resources = MagicMock(); module.jobs_idle = MagicMock()
            if native_error is not None: module.recovery_services = MagicMock(side_effect=RuntimeError(native_error))
            recovery = {'policy': {'preflight': {'services': value['restoredConfigurationProof']['semantic']['original']}},
                'state': value['migrationState'], 'marker': value['recoveryMarker'],
                'restored': value['restoredOrigin'], 'source': failure}
            stack.enter_context(patch.object(s, 'pending_online_recovery', return_value=(module, recovery)))
            stack.enter_context(patch.object(s, 'snapshot', return_value=value['services']))
            yield controller, directory, value, module, recovery

    def test_known_initial_mismatch_reaches_actual_closed_generator_before_any_create(self):
        with self.initial_fixture() as (controller, directory, value, module, recovery):
            with self.assertRaisesRegex(RuntimeError, '^ONLINE_RECHARGE_DECLARATION_SOURCE_NOT_MEASURED$'):
                s.pending_online_first(controller, directory)
            module.verify_permission_seed.assert_called_once()
            module.require_fresh_resources.assert_called_once()
            module.jobs_idle.assert_called_once_with(controller, directory, migrated=True)
            self.assertEqual(list(directory.iterdir()), [directory / 'release-manifest.json'])

    def test_unknown_error_and_nonpreflight_entry_cannot_select_measurement(self):
        for entry, error in (('PREFLIGHT', 'UNEXPECTED_FAILURE'), ('READBACK', None), ('STAGE', None)):
            with self.subTest(entry=entry, error=error), self.initial_fixture(entry=entry, native_error=error) as (controller, directory, value, module, recovery), \
                    patch.object(s, 'pending_online_declaration_initial_measure') as measure:
                with self.assertRaisesRegex(RuntimeError, '^UNEXPECTED_FAILURE$' if error else '^API_ADMIN_PENDING_ONLINE_RECOVERY_REQUIRED$'):
                    s.pending_online_first(controller, directory)
                measure.assert_not_called()

    def test_baseline_reports_only_the_exact_fixed_source_not_measured_literal(self):
        with self.initial_fixture() as (controller, directory, value, module, recovery):
            with self.assertRaisesRegex(s.WorkspaceBaselineError, '^API_ADMIN_PENDING_ONLINE_SOURCE_NOT_MEASURED$') as rejected:
                s.baseline(controller, online.BASELINE_COMMIT)
            self.assertEqual(rejected.exception.workspaceDiagnostic['phase'], 'MANIFEST')
            self.assertTrue(rejected.exception.workspaceDiagnostic['rawOutputSuppressed'])

    def test_stage_private_getter_binds_actual_metadata_and_exact_raw_sha(self):
        # Consumer-only synthetic I/O; it does not claim server source authority.
        fixture = BuildOriginBinding.fixture
        for stage in (1, 2):
            kwargs = {} if stage == 1 else {'candidate': 'd' * 40, 'source_tree': 'e' * 40}
            with self.subTest(stage=stage), fixture(self, declaration_context(stage), **kwargs) as (_, before, output, projection):
                controller = self.controller('STAGE')
                controller._apiWorkspaceDeclarationProducer.update(commit=os.environ['RELEASE_COMMIT'], sourceTree=os.environ['SOURCE_TREE'])
                raw = output.joinpath('api-workspace-preflight-result.json').read_bytes()
                controller._apiWorkspaceDeclarationPreflightSha256 = hashlib.sha256(raw).hexdigest()
                module = SimpleNamespace(**vars(online)); getter = MagicMock(return_value=raw)
                module.declaration_equivalence_preflight_bytes = getter
                with patch.object(s, 'pending_online_equivalence', return_value=module):
                    result, origin, actual_raw = s.pending_online_declaration_stage_preflight(controller)
                    self.assertEqual(result, before); self.assertEqual(origin, before['pendingOnlineMigrationOrigin'])
                    self.assertEqual(actual_raw, raw)
                    getter.assert_called_once_with(controller, producer=controller._apiWorkspaceDeclarationProducer,
                                                   expected_sha=controller._apiWorkspaceDeclarationPreflightSha256)
                    getter.return_value = raw + b'\n'
                    with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_PREFLIGHT_CHANGED$'):
                        s.pending_online_declaration_stage_preflight(controller)
                for entry in ('PREFLIGHT', 'READBACK'):
                    other = self.controller(entry); other._apiWorkspaceDeclarationPreflightSha256 = '0' * 64
                    with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_RECOVERY_REQUIRED$'):
                        s.pending_online_declaration_stage_preflight(other)


class DeclarationPublicationConsumers(unittest.TestCase):
    """Synthetic publication files; real Git archive/wire and pure bindings.

    Mocked acquired byte capabilities never claim production measurement or AWS
    authority. The real closed generator and normal v1 suites remain separate.
    """
    @classmethod
    def setUpClass(cls):
        cls.pure_module = load('consumer_pure_fixture', 'online-recharge-scope.test.py')
        cls.pure_module.DeclarationEquivalencePureTests.setUpClass()
        cls.pure = cls.pure_module.DeclarationEquivalencePureTests()
        cls.output = ROOT / '.runtime/online-recharge-release-20261009/build/declaration-consumer-implementation'
        cls.output.mkdir(parents=True, exist_ok=True)
        cls.wire = load('consumer_wire', 'api-admin-pending-receipt-wire.py')

    @contextmanager
    def fixture(self, entry='READBACK'):
        f = self.pure.fixture(); value = f['origin']; producer = f['producer']
        metadata = {name: producer[name] for name in ('commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt')}
        value['baselineRelease'] = '/opt/id-business-v2/releases/20261009T124501Z-' + online.BASELINE_COMMIT[:12]
        value['restoredOrigin']['source'] = '/opt/id-business-v2/releases/20261009T142956Z-' + online.RESTORED_COMMIT[:12]
        before = json.loads(f['preflight_raw'])
        before.update(pendingOnlineMigrationOrigin=value, onlinePublished=False, migrationPerformed=False,
                      pendingOnlineEndedFailures=s.pending_online_ended_failures(value))
        raw_f = self.pure.raw(before); second = f['second']
        second['measurement']['priorIndependentPreflightBytesSha256'] = hashlib.sha256(raw_f).hexdigest()
        second['measurement']['priorProofSha256'] = s.fingerprint(value['restoredConfigurationProof'])
        seal = online.declaration_equivalence_pair_seal(SimpleNamespace(require=need), value['restoredConfigurationProof'], second, raw_f)
        marker = {**s.pending_online_marker(value), 'configurationEquivalenceSeal': seal}
        with tempfile.TemporaryDirectory(dir=self.output) as temporary, ExitStack() as stack:
            base = Path(temporary).resolve(); releases = base / 'releases'; releases.mkdir(mode=0o700)
            original = releases / Path(value['baselineRelease']).name; original.mkdir(mode=0o700)
            directory = releases / ('20261010T010000Z-' + producer['commit'][:12]); directory.mkdir(mode=0o700)
            for folder in (original, directory):
                for name in (*s.CONFIG_FILES, 'compose.release.json'):
                    path = folder / name; path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(('LOCAL_SYNTHETIC_PUBLIC:' + name).encode()); path.chmod(0o600)
            (original / 'release-manifest.json').write_bytes(f['historical_files']['workspaceManifestBytesSha256'])
            (base / 'current').symlink_to(directory)
            def mapped(item):
                path = Path(item)
                return releases / path.name if str(path).startswith('/opt/id-business-v2/releases/') else path
            stack.enter_context(patch.object(s, 'Path', side_effect=mapped))
            configuration_before = s.configuration_hashes(original); configuration_after = s.configuration_hashes(directory)
            proof = workspace_build_proof(value); proof.update(version=2, commit=producer['commit'], sourceTree=producer['sourceTree'],
                pendingOnlinePreflightSha256=hashlib.sha256(raw_f).hexdigest(),
                declarationEquivalenceSeal={name: seal[name] for name in ('kind', 'version', 'preflightProofSha256', 'semanticSha256')})
            after = json.loads(f['record_raw'])['after']
            for name, row in proof['images'].items():
                row['reference'] = '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:' + producer['commit'] + '-' + producer['workflowRunId'] + '-' + producer['workflowRunAttempt'] + '-' + name
                row['imageId'] = after[name]['image']; after[name]['reference'] = row['reference']
            record = {'before': value['services'], 'after': after,
                'baselineEvidence': {'pendingOnlineMigrationOrigin': value},
                'buildProofSha256': s.fingerprint(proof), 'configurationBefore': configuration_before,
                'configurationAfter': configuration_after, 'pendingOnlineMigrationOrigin': value,
                'pendingOnlineConfigurationMeasurement': second}
            tag = 'github-actions-' + producer['workflowRunId'] + '-' + producer['workflowRunAttempt']
            manifest = {'commit': producer['commit'], 'sourceTree': producer['sourceTree'],
                'previousCommit': online.BASELINE_COMMIT, 'previousRelease': value['baselineRelease'],
                'previousManifestSha256': value['baselineManifestSha256'], 'deploymentRun': tag, 'imageBuildRun': tag,
                'servicesUpdated': ['api', 'admin'], 'migrationApplied': False, 'newMigrations': [],
                'images': {name: {'reference': row['reference'], 'digest': row['imageId'], 'sourceCommit': producer['commit']}
                           for name, row in proof['images'].items()},
                'pendingOnlineMigration': marker, 'apiWorkspacePublication': {'pendingOnlineMigration': marker}}
            for name, data in ((s.STATE_FILE, record), (s.PROOF_FILE, proof), ('release-manifest.json', manifest)):
                path = directory / name; path.write_bytes(self.pure.raw(data)); path.chmod(0o600)
            controller = SimpleNamespace(require=need, BASE=base, sys=SimpleNamespace(argv=['remote.py',
                {'READBACK': '--api-workspace-readback', 'STAGE': '--api-workspace-only', 'PREFLIGHT': '--api-workspace-preflight'}[entry]]),
                _apiWorkspaceDeclarationEntry=entry, _apiWorkspaceDeclarationProducer=copy.deepcopy(metadata),
                _apiWorkspaceDeclarationPreflightSha256=hashlib.sha256(raw_f).hexdigest(),
                _apiWorkspaceDeclarationDeploymentMeasurement=second, _apiWorkspaceDeclarationDeploymentSeal=seal,
                run=MagicMock(side_effect=AssertionError('RETIRED_OR_UNPLANNED_RUNTIME_READ')))
            materials = {name: f[name] for name in ('producer', 'archive_bytes', 'historical_files')}
            acquired = SimpleNamespace(**vars(online))
            acquired.declaration_equivalence_materials = MagicMock(return_value=materials)
            acquired.declaration_equivalence_preflight_bytes = MagicMock(return_value=raw_f)
            acquired.declaration_equivalence_saved_invocation = MagicMock(side_effect=RuntimeError('LOCAL_SYNTHETIC_Q_MISSING'))
            acquired.verify_permission_seed = MagicMock(); acquired.require_fresh_resources = MagicMock()
            recovery = {'state': value['migrationState'], 'marker': value['recoveryMarker'],
                'source': base / 'synthetic-first-failure', 'restored': value['restoredOrigin']}
            stack.enter_context(patch.object(s, 'pending_online_equivalence', return_value=acquired))
            stack.enter_context(patch.object(s, 'pending_online_recovery', return_value=(acquired, recovery)))
            stack.enter_context(patch.object(s, 'pending_online_migrations'))
            stack.enter_context(patch.object(s, 'pending_projection', return_value=SimpleNamespace(validate_record=MagicMock())))
            stack.enter_context(patch.object(s, 'snapshot', return_value=after))
            yield SimpleNamespace(d=controller, context=value, original=original, directory=directory,
                proof=proof, record=record, manifest=manifest, preflight=raw_f, second=second, seal=seal,
                module=acquired, recovery=recovery, materials=materials, after=after)

    def test_stage_record_persists_only_actual_p2_and_exact_transported_pair(self):
        with self.fixture('STAGE') as f:
            record = copy.deepcopy(f.record); record.pop('pendingOnlineConfigurationMeasurement')
            marker = s.pending_online_declaration_stage_record(f.d, f.context, record, f.proof)
            self.assertEqual(record['pendingOnlineConfigurationMeasurement'], f.second)
            self.assertEqual(marker, f.manifest['pendingOnlineMigration'])
            self.assertIsNot(record['pendingOnlineConfigurationMeasurement'], f.second)
        for change in ('missing-p2', 'seal', 'proof-f', 'proof-p', 'before', 'source-role', 'phase'):
            with self.subTest(change=change), self.fixture('STAGE') as f:
                if change == 'missing-p2': del f.d._apiWorkspaceDeclarationDeploymentMeasurement
                elif change == 'seal': f.d._apiWorkspaceDeclarationDeploymentSeal = {'trusted': True}
                elif change == 'proof-f': f.proof['pendingOnlinePreflightSha256'] = '0' * 64
                elif change == 'proof-p': f.proof['declarationEquivalenceSeal']['preflightProofSha256'] = '0' * 64
                elif change == 'before': f.record['before'] = {}
                elif change == 'source-role': f.d._apiWorkspaceDeclarationProducer['workflowRunId'] = '9'
                else: f.d._apiWorkspaceDeclarationEntry = 'READBACK'
                f.record.pop('pendingOnlineConfigurationMeasurement')
                with self.assertRaises(RuntimeError): s.pending_online_declaration_stage_record(f.d, f.context, f.record, f.proof)
                self.assertNotIn('pendingOnlineConfigurationMeasurement', f.record)

    def test_actual_private_artifacts_bind_full_git_history_and_publication_files(self):
        with self.fixture() as f:
            _reader, material, publication, marker, record = s.pending_online_declaration_files(f.d,
                f.directory, f.context, f.recovery, phase='COLD')
            self.assertEqual(publication['afterServices'], f.after)
            self.assertEqual(marker, f.manifest['pendingOnlineMigration'])
            self.assertEqual(publication['recordBytesSha256'], hashlib.sha256((f.directory / s.STATE_FILE).read_bytes()).hexdigest())
            f.d.run.assert_not_called()
        for field in ('state', 'seal', 'tag', 'image', 'mode', 'source-history', 'source-archive'):
            with self.subTest(field=field), self.fixture() as f:
                if field == 'state': f.record['pendingOnlineConfigurationMeasurement']['measurement']['priorProofSha256'] = '0' * 64
                elif field == 'seal': f.manifest['pendingOnlineMigration']['configurationEquivalenceSeal'] = {}
                elif field == 'tag': f.manifest['deploymentRun'] = 'github-actions-9-9'
                elif field == 'image': f.manifest['images']['api']['digest'] = 'sha256:' + '0' * 64
                elif field == 'mode': (f.directory / s.STATE_FILE).chmod(0o666)
                elif field == 'source-history': f.materials['historical_files']['workspaceRecordBytesSha256'] += b'\n'
                else: f.materials['archive_bytes'] = b'LOCAL_SYNTHETIC_FORGED_ARCHIVE'
                for name, data in ((s.STATE_FILE, f.record), ('release-manifest.json', f.manifest)):
                    (f.directory / name).write_bytes(self.pure.raw(data))
                with self.assertRaises(Exception): s.pending_online_declaration_files(f.d, f.directory, f.context, f.recovery, phase='COLD')

    def test_only_fixed_independent_readback_issues_after_live_measurement(self):
        with self.fixture() as f:
            s.pending_online_guard(f.d, f.directory, f.context)
            issued = s.pending_online_declaration_readback(f.d, f.directory, f.context, f.after)
            self.assertEqual(issued['recordBytesSha256'], hashlib.sha256((f.directory / s.STATE_FILE).read_bytes()).hexdigest())
            f.module.declaration_equivalence_saved_invocation.assert_not_called()
        for change in ('stage', 'producer', 'live', 'configuration', 'current'):
            with self.subTest(change=change), self.fixture() as f:
                if change == 'stage': f.d._apiWorkspaceDeclarationEntry = 'STAGE'
                elif change == 'producer': f.d._apiWorkspaceDeclarationProducer['workflowRunId'] = '9'
                elif change == 'live': f.after['api']['containerId'] = '0' * 64
                elif change == 'configuration': (f.directory / 'compose.release.json').write_bytes(b'LOCAL_SYNTHETIC_CHANGED')
                else: (f.d.BASE / 'current').unlink(); (f.d.BASE / 'current').symlink_to(f.original)
                with self.assertRaises(Exception): s.pending_online_declaration_readback(f.d, f.directory, f.context, f.after)

    @contextmanager
    def complete_readback(self):
        """Real readback/preservation/guards; ordinary runtime callbacks synthetic."""
        with self.fixture() as f, ExitStack() as stack:
            for directory in (f.original, f.directory):
                (directory / '.env.aws.production').write_bytes(b'LOCAL_SYNTHETIC_PUBLIC=readback\n')
                (directory / 'compose.release.json').write_bytes(self.pure.raw({'services': {
                    name: {'image': 'synthetic-' + name, 'pull_policy': 'never'} for name in f.after}}))
            f.record.update(environmentSha256=hashlib.sha256((f.directory / '.env.aws.production').read_bytes()).hexdigest(),
                configurationBefore=s.configuration_hashes(f.original),
                configurationAfter=s.configuration_hashes(f.directory),
                workspaceVolumeAfter={'fixture': 'LOCAL_SYNTHETIC_VOLUME'},
                workspaceBackup={'fixture': 'LOCAL_SYNTHETIC_BACKUP'})
            audit = {'ok': True, 'checkCount': 49, 'violationCount': 0,
                     'checks': [{'code': 'LOCAL_' + str(i), 'count': 0} for i in range(49)]}
            for name in ('before-audit.json', 'after-audit.json'):
                (f.directory / name).write_bytes(self.pure.raw(audit))
            receipt = s.audit_receipt(f.d, f.directory / 'before-audit.json')
            f.manifest.update(dataAuditBefore=receipt, dataAuditAfter=receipt)
            f.manifest['apiWorkspacePublication']['version'] = 4
            for name, value in ((s.STATE_FILE, f.record), ('release-manifest.json', f.manifest)):
                (f.directory / name).write_bytes(self.pure.raw(value))
            evidence = {'environmentSha256': f.record['environmentSha256'],
                        'pendingOnlineMigrationOrigin': f.context}
            f.d._pendingOnlineMigrationOrigin = f.context
            f.d.migration_plan = MagicMock(return_value=[])
            # Baseline/runtime callbacks are explicitly synthetic; no Docker or
            # production authority is supplied by this integration fixture.
            stack.enter_context(patch.object(s, 'baseline', return_value=(f.directory, f.manifest, f.after, evidence)))
            stack.enter_context(patch.object(s, 'pending_online_migrations', return_value=online.MIGRATION_FILE))
            stack.enter_context(patch.object(s, 'workspace_volume', return_value=f.record['workspaceVolumeAfter']))
            stack.enter_context(patch.object(s, 'workspace_configuration', return_value=f.proof['configuration']))
            stack.enter_context(patch.object(s, 'workspace_health'))
            stack.enter_context(patch.object(s, 'workspace_public_origin', return_value='https://local.example.test'))
            stack.enter_context(patch.object(s, 'workspace_backup_receipt', return_value=f.record['workspaceBackup']))
            stack.enter_context(patch.object(s, 'verify_running'))
            f.preserved = stack.enter_context(patch.object(s, 'require_preserved', wraps=s.require_preserved))
            f.guard = stack.enter_context(patch.object(s, 'pending_online_guard', wraps=s.pending_online_guard))
            f.issuer = stack.enter_context(patch.object(s, 'pending_online_declaration_readback', wraps=s.pending_online_declaration_readback))
            yield f

    def test_complete_readback_traverses_real_predecessor_guard_before_current_issuer(self):
        with self.complete_readback() as f:
            result = s.readback(f.d, f.proof['commit'])
            self.assertEqual(result['status'], 'API_ADMIN_WORKSPACE_VERIFIED')
            self.assertEqual(result['declarationEquivalencePublication']['recordBytesSha256'],
                             hashlib.sha256((f.directory / s.STATE_FILE).read_bytes()).hexdigest())
            f.preserved.assert_called_once_with(f.d, f.original, f.directory, f.record['before'],
                                               (f.directory / '.env.aws.production').read_bytes())
            self.assertEqual([call.args[1] for call in f.guard.call_args_list], [f.original, f.directory])
            f.issuer.assert_called_once_with(f.d, f.directory, f.context, f.after)
            f.module.declaration_equivalence_saved_invocation.assert_not_called()
            f.d.run.assert_not_called()

    def test_complete_readback_cannot_issue_on_old_pointer_wrong_producer_or_failed_audit(self):
        for change in ('old-pointer', 'wrong-producer', 'normal-audit', 'live-identity'):
            with self.subTest(change=change), self.complete_readback() as f:
                if change == 'old-pointer':
                    (f.d.BASE / 'current').unlink(); (f.d.BASE / 'current').symlink_to(f.original)
                elif change == 'wrong-producer': f.d._apiWorkspaceDeclarationProducer['workflowRunId'] = '9'
                elif change == 'normal-audit':
                    (f.directory / 'after-audit.json').write_bytes(self.pure.raw({'ok': False}))
                else: f.after['api']['containerId'] = '0' * 64
                with self.assertRaises(RuntimeError): s.readback(f.d, f.proof['commit'])
                f.issuer.assert_not_called()
                f.module.declaration_equivalence_saved_invocation.assert_not_called()
                f.d.run.assert_not_called()
        with self.complete_readback() as f:
            s.pending_online_guard(f.d, f.original, f.context)
            f.issuer.assert_not_called()
            with self.assertRaises(RuntimeError):
                s.pending_online_declaration_readback(f.d, f.original, f.context, f.after)

    def test_later_cold_requires_real_q_and_archived_wire_without_retired_inspect(self):
        with self.fixture('PREFLIGHT') as f:
            f.d._apiWorkspaceDeclarationProducer['workflowRunId'] = '9'
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_RECOVERY_REQUIRED$'):
                s.pending_online_guard(f.d, f.directory, f.context)
            _reader, _material, publication, _marker, _record = s.pending_online_declaration_files(f.d, f.directory, f.context, f.recovery, phase='COLD')
            issued = online.declaration_equivalence_issuer_binding(f.d, publication, live_services=f.after,
                live_configuration=s.configuration_hashes(f.directory), execution_producer=f.materials['producer'])
            command = '00000000-0000-0000-0000-000000000002'
            raw = self.pure.raw({'CommandId': command, 'Status': 'Success', 'ResponseCode': 0,
                'StandardOutputContent': self.wire.receipt_output({'status': 'API_ADMIN_WORKSPACE_VERIFIED',
                    'pendingOnlineMigrationOrigin': f.context, 'declarationEquivalencePublication': issued}, scope='API_ADMIN_WORKSPACE')})
            f.module.declaration_equivalence_saved_invocation.side_effect = None
            f.module.declaration_equivalence_saved_invocation.return_value = {'raw_bytes': raw, 'command_id': command}
            self.assertEqual(s.pending_online_guard(f.d, f.directory, f.context), f.recovery)
            f.d.run.assert_not_called()
            f.module.declaration_equivalence_saved_invocation.return_value['raw_bytes'] = raw.replace(b'Success', b'Failed')
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_RECOVERY_REQUIRED$'):
                s.pending_online_guard(f.d, f.directory, f.context)

    def test_v2_prior_publication_remains_closed_without_claiming_b_or_online_support(self):
        with self.fixture() as f:
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_RECOVERY_REQUIRED$'):
                s.pending_online_guard(f.d, f.directory, declaration_context(2))
            f.module.declaration_equivalence_materials.assert_not_called()


class DeclarationSuccessorConsumers(unittest.TestCase):
    """Full synthetic consumer path; real Git/wire, no AWS or Docker authority."""
    fixture = DeclarationPublicationConsumers.fixture
    complete_readback = DeclarationPublicationConsumers.complete_readback

    @classmethod
    def setUpClass(cls):
        DeclarationPublicationConsumers.setUpClass()
        cls.pure = DeclarationPublicationConsumers.pure
        cls.wire = DeclarationPublicationConsumers.wire
        cls.output = ROOT / '.runtime/online-recharge-release-20261009/build/declaration-successor-consumer-implementation'
        cls.output.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def successor(self):
        with self.complete_readback() as a, ExitStack() as stack:
            actual_a_receipt = s.readback(a.d, a.proof['commit'])
            metadata_a = copy.deepcopy(a.d._apiWorkspaceDeclarationProducer)
            producer_b = copy.deepcopy(a.materials['producer']); producer_b['workflowRunId'] = '70000000002'
            metadata_b = {n: producer_b[n] for n in metadata_a}
            command_a = '00000000-0000-0000-0000-000000000002'
            qa = {'raw_bytes': self.pure.raw({'CommandId': command_a, 'Status': 'Success', 'ResponseCode': 0,
                'StandardOutputContent': self.wire.receipt_output(actual_a_receipt, scope='API_ADMIN_WORKSPACE')}), 'command_id': command_a}
            saved = {'a': qa, 'b': None}
            def invocation(_d, *, producer):
                if producer == metadata_a: return saved['a']
                if producer == metadata_b and saved['b'] is not None: return saved['b']
                raise RuntimeError('LOCAL_SYNTHETIC_Q_MISSING')
            a.module.declaration_equivalence_saved_invocation.side_effect = invocation
            a.d._apiWorkspaceDeclarationEntry = 'PREFLIGHT'; a.d.sys.argv = ['remote.py', '--api-workspace-preflight']
            a.d._apiWorkspaceDeclarationProducer = metadata_b
            s.pending_online_guard(a.d, a.directory, a.context, all_services=True)
            # Only a logical public path is substituted; all artifact bytes are
            # the owned local A fixture. This never writes to /opt.
            class LogicalRelease:
                def __str__(self): return '/opt/id-business-v2/releases/' + a.directory.name
                def __truediv__(self, name): return a.directory / name
            origin = s.pending_online_successor(a.d, a.context, LogicalRelease(), a.manifest,
                (a.directory / 'release-manifest.json').read_bytes(), a.proof, a.after)
            before = {'mode': 'preflight', 'commandId': '00000000-0000-0000-0000-000000000003',
                'status': 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED', 'commit': a.proof['commit'],
                'releaseCandidateCommit': producer_b['commit'], 'workflowRunId': producer_b['workflowRunId'],
                'workflowRunAttempt': producer_b['workflowRunAttempt'], 'services': a.after,
                'pendingOnlineMigrationOrigin': origin, 'pendingOnlineEndedFailures': s.pending_online_ended_failures(origin),
                'onlinePublished': False, 'migrationPerformed': False}
            preflight = self.pure.raw(before)
            def materials(_d, _original, _recovery, *, producer, phase):
                if producer == metadata_a: return a.materials
                if producer == metadata_b: return {**a.materials, 'producer': producer_b}
                raise RuntimeError('LOCAL_SYNTHETIC_PRODUCER_CHANGED')
            def get_preflight(_d, *, producer, expected_sha):
                value = a.preflight if producer == metadata_a else preflight if producer == metadata_b else None
                if value is None or hashlib.sha256(value).hexdigest() != expected_sha:
                    raise RuntimeError('LOCAL_SYNTHETIC_F_CHANGED')
                return value
            a.module.declaration_equivalence_materials.side_effect = materials
            a.module.declaration_equivalence_preflight_bytes.side_effect = get_preflight
            del a.d._apiWorkspaceDeclarationDeploymentMeasurement
            del a.d._apiWorkspaceDeclarationDeploymentSeal
            a.d._apiWorkspaceDeclarationPreflightSha256 = hashlib.sha256(preflight).hexdigest()
            a.d._pendingOnlineMigrationOrigin = origin
            a.d._apiWorkspaceDeclarationEntry = 'STAGE'; a.d.sys.argv = ['remote.py', '--api-workspace-only']
            directory = a.d.BASE / 'releases' / ('20261010T020000Z-' + producer_b['commit'][:12]); directory.mkdir(mode=0o700)
            for name in (*s.CONFIG_FILES, 'compose.release.json', '.env.aws.production'):
                destination = directory / name; destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes((a.directory / name).read_bytes()); destination.chmod(0o600)
            after = copy.deepcopy(a.after); proof = copy.deepcopy(a.proof)
            proof.update(pendingOnlineOriginSha256=s.fingerprint(origin), pendingOnlinePreflightSha256=hashlib.sha256(preflight).hexdigest())
            for name in ('api', 'admin'):
                after[name]['containerId'] = hashlib.sha256(('SYNTHETIC_B:' + name).encode()).hexdigest()
                after[name]['image'] = 'sha256:' + hashlib.sha256(('SYNTHETIC_B_IMAGE:' + name).encode()).hexdigest()
                after[name]['reference'] = '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:' + producer_b['commit'] + '-70000000002-1-' + name
                proof['images'][name].update(reference=after[name]['reference'], imageId=after[name]['image'])
            record = copy.deepcopy(a.record); record.pop('pendingOnlineConfigurationMeasurement')
            record.update(before=a.after, after=after, pendingOnlineMigrationOrigin=origin,
                baselineEvidence={'pendingOnlineMigrationOrigin': origin}, buildProofSha256=s.fingerprint(proof),
                configurationBefore=s.configuration_hashes(a.directory), configurationAfter=s.configuration_hashes(directory))
            s.pending_online_guard(a.d, a.directory, origin, all_services=True)
            marker = s.pending_online_declaration_stage_record(a.d, origin, record, proof)
            manifest = copy.deepcopy(a.manifest)
            manifest.update(previousCommit=a.proof['commit'], previousRelease=origin['priorPublications'][0]['release'],
                previousManifestSha256=origin['priorPublications'][0]['manifestSha256'],
                deploymentRun='github-actions-70000000002-1', imageBuildRun='github-actions-70000000002-1',
                pendingOnlineMigration=marker,
                images={name: {'reference': row['reference'], 'digest': row['imageId'], 'sourceCommit': producer_b['commit']}
                        for name, row in proof['images'].items()})
            manifest['apiWorkspacePublication']['pendingOnlineMigration'] = marker
            for name, value in ((s.STATE_FILE, record), (s.PROOF_FILE, proof), ('release-manifest.json', manifest)):
                (directory / name).write_bytes(self.pure.raw(value)); (directory / name).chmod(0o600)
            for name in ('before-audit.json', 'after-audit.json'):
                (directory / name).write_bytes((a.directory / name).read_bytes())
            live = stack.enter_context(patch.object(s, 'snapshot', return_value=after))
            # Execute the real preservation guard with B's switched runtime.
            s.require_preserved(a.d, a.directory, directory, record['before'], (directory / '.env.aws.production').read_bytes())
            (a.d.BASE / 'current').unlink(); (a.d.BASE / 'current').symlink_to(directory)
            evidence = {'environmentSha256': record['environmentSha256'], 'pendingOnlineMigrationOrigin': origin}
            baseline = stack.enter_context(patch.object(s, 'baseline', return_value=(directory, manifest, after, evidence)))
            a.issuer.reset_mock(); a.guard.reset_mock(); a.preserved.reset_mock()
            yield SimpleNamespace(a=a, d=a.d, context=origin, directory=directory, producer=producer_b, proof=proof,
                record=record, manifest=manifest, preflight=preflight, after=after, saved=saved, live=live, baseline=baseline)

    def test_complete_b_preflight_stage_readback_and_cold_require_separate_b_q(self):
        with self.successor() as b:
            stage_result = s.readback(b.d, b.proof['commit'])
            self.assertNotIn('declarationEquivalencePublication', stage_result)
            self.assertNotIn('declarationEquivalenceSuccessorPublication', stage_result)
            b.a.issuer.assert_not_called()
            self.assertNotIn('pendingOnlineConfigurationMeasurement', b.record)
            b.d._apiWorkspaceDeclarationEntry = 'READBACK'; b.d.sys.argv = ['remote.py', '--api-workspace-readback']
            result = s.readback(b.d, b.proof['commit'])
            self.assertEqual(result['declarationEquivalenceSuccessorPublication']['kind'], online.DECLARATION_SUCCESSOR_KIND)
            self.assertNotIn('declarationEquivalencePublication', result)
            self.assertEqual([call.args[1] for call in b.a.guard.call_args_list],
                             [b.a.directory, b.directory, b.a.directory, b.directory])
            b.d._apiWorkspaceDeclarationEntry = 'PREFLIGHT'; b.d.sys.argv = ['remote.py', '--api-workspace-preflight']
            b.d._apiWorkspaceDeclarationProducer = {**b.d._apiWorkspaceDeclarationProducer, 'workflowRunId': '9'}
            with self.assertRaises(RuntimeError): s.pending_online_guard(b.d, b.directory, b.context)
            command = '00000000-0000-0000-0000-000000000004'
            b.saved['b'] = {'command_id': command, 'raw_bytes': self.pure.raw({'CommandId': command, 'Status': 'Success', 'ResponseCode': 0,
                'StandardOutputContent': self.wire.receipt_output(result, scope='API_ADMIN_WORKSPACE')})}
            s.pending_online_guard(b.d, b.directory, b.context)
            b.d.run.assert_not_called()
            with self.assertRaises(RuntimeError): s.pending_online_successor(b.d, b.context, b.directory, b.manifest,
                (b.directory / 'release-manifest.json').read_bytes(), b.proof, b.after)

    def test_b_rejects_missing_a_q_repeated_f_cross_source_stale_state_config_and_p2_b(self):
        for change in ('missing-a-q', 'f-a', 'producer', 'stale-a', 'live-five', 'configuration', 'p2-b', 'prior', 'audit'):
            with self.subTest(change=change), self.successor() as b:
                b.d._apiWorkspaceDeclarationEntry = 'READBACK'; b.d.sys.argv = ['remote.py', '--api-workspace-readback']
                if change == 'missing-a-q': b.saved['a'] = None
                elif change == 'f-a':
                    b.proof['pendingOnlinePreflightSha256'] = hashlib.sha256(b.a.preflight).hexdigest()
                    (b.directory / s.PROOF_FILE).write_bytes(self.pure.raw(b.proof))
                elif change == 'producer': b.d._apiWorkspaceDeclarationProducer['workflowRunId'] = '9'
                elif change == 'stale-a': b.record['before'] = b.a.context['services']
                elif change == 'live-five': b.after['mysql']['containerId'] = '0' * 64
                elif change == 'configuration': (b.a.directory / 'compose.release.json').write_bytes(b'LOCAL_CHANGED')
                elif change == 'p2-b': b.record['pendingOnlineConfigurationMeasurement'] = b.context['restoredConfigurationProof']
                elif change == 'prior': b.context['priorPublications'][0]['manifestSha256'] = '0' * 64
                else: (b.directory / 'after-audit.json').write_bytes(self.pure.raw({'ok': False}))
                (b.directory / s.STATE_FILE).write_bytes(self.pure.raw(b.record))
                with self.assertRaises(RuntimeError): s.readback(b.d, b.proof['commit'])
                b.a.issuer.assert_not_called(); b.d.run.assert_not_called()

    def test_closed_transport_summary_binds_actual_f_and_build_without_claiming_file_authority(self):
        with self.successor() as b:
            a_receipt = self.wire.decode_receipt_output(json.loads(b.saved['a']['raw_bytes'])['StandardOutputContent'], scope='API_ADMIN_WORKSPACE')
            a_summary = a_receipt['declarationEquivalencePublication']
            a_producer = {n: b.a.context['restoredConfigurationProof']['semantic']['producer'][n]
                          for n in ('commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt')}
            self.assertIs(s.pending_online_declaration_summary(b.d, a_summary, b.a.context, producer=a_producer,
                preflight_raw=b.a.preflight, build_proof_sha256=s.fingerprint(b.a.proof)), a_summary)
            b.d._apiWorkspaceDeclarationEntry = 'READBACK'; b.d.sys.argv = ['remote.py', '--api-workspace-readback']
            result = s.readback(b.d, b.proof['commit']); summary = result['declarationEquivalenceSuccessorPublication']
            actual = s.pending_online_declaration_summary(b.d, summary, b.context, producer=b.d._apiWorkspaceDeclarationProducer,
                preflight_raw=b.preflight, build_proof_sha256=s.fingerprint(b.proof))
            self.assertIs(actual, summary)
            self.assertEqual({**s.pending_online_marker(b.context), 'successorConfigurationSeal': actual['successorConfigurationSeal']},
                             b.manifest['pendingOnlineMigration'])
            for change in ('extra', 'bool', 'producer', 'f', 'build', 'initial-reference', 'kind', 'secret-nested'):
                value = copy.deepcopy(summary); producer = copy.deepcopy(b.d._apiWorkspaceDeclarationProducer)
                raw = b.preflight; build_sha = s.fingerprint(b.proof)
                if change == 'extra': value['trusted'] = True
                elif change == 'bool': value['version'] = True
                elif change == 'producer': producer['workflowRunId'] = '9'
                elif change == 'f': raw = b.a.preflight
                elif change == 'build': build_sha = '0' * 64
                elif change == 'initial-reference': value['successorConfigurationSeal']['initialPublication']['recordBytesSha256'] = '0' * 64
                elif change == 'kind': value['kind'] = online.DECLARATION_EQUIVALENCE_KIND
                else: value['successorConfigurationSeal']['rawEnv'] = 'SECRET_MUST_NOT_LEAK'
                with self.subTest(change=change), self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_ORIGIN_CHANGED$') as error:
                    s.pending_online_declaration_summary(b.d, value, b.context, producer=producer, preflight_raw=raw,
                                                         build_proof_sha256=build_sha)
                self.assertNotIn('SECRET', str(error.exception))


if __name__ == '__main__':
    unittest.main()
