import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

DIRECTORY = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('disk_install', DIRECTORY / 'disk-retention-install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
ORIGINAL_COMMAND = installer.command
ORIGINAL_LEGACY_LOADER = installer.load_legacy
COMMIT = 'a' * 40
CONTAINER = 'b' * 64
NATIVE = b'''import re
def validate_policy(value):
    assert type(value) is dict and set(value) == {'kind', 'version', 'approved',
        'sourceSha256', 'maintainerSha256', 'candidateRegistrySha256', 'protectedCandidateBatches',
        'supersededOnlineBatches', 'budgets'}
    assert value['kind'] == 'ID_DISK_RETENTION_POLICY_V1'
    assert type(value['version']) is int and value['version'] == 1
    assert type(value['approved']) is bool
    assert re.fullmatch('[a-f0-9]{64}', value['sourceSha256'])
    assert re.fullmatch('[a-f0-9]{64}', value['maintainerSha256'])
    assert re.fullmatch('[a-f0-9]{64}', value['candidateRegistrySha256'])
    return value
'''
HELPER = b"POLICY = 'test-fixed-retention'\n"
# The installer must only freeze these bytes, never execute the registry module.
CANDIDATE_REGISTRY = b'raise RuntimeError("CANDIDATE_SOURCE_EXECUTED")\n'


class InstallerTests(unittest.TestCase):
    def setUp(self):
        runtime = DIRECTORY.parents[1] / '.runtime/disk-retention-20261014'
        runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=runtime)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.base = self.root / 'opt/id-business-v2'
        self.release = self.base / ('releases/20261014T010203Z-' + COMMIT[:12])
        self.release.mkdir(mode=0o700, parents=True)
        self.manifest = self.release / 'release-manifest.json'
        self.manifest.write_text(json.dumps({'commit': COMMIT, 'images': {}}))
        self.manifest.chmod(0o600)
        (self.base / 'current').symlink_to(self.release, target_is_directory=True)
        (self.base / '.deploy.lock').write_bytes(b'')
        (self.base / '.deploy.lock').chmod(0o600)
        self.units = self.root / 'units'
        self.units.mkdir(mode=0o700)
        self.sources = self.root / 'scripts/production-release'
        self.sources.mkdir(mode=0o700, parents=True)
        (self.sources / 'disk-retention.py').write_bytes(NATIVE)
        (self.sources / 'maintain-image-cache.py').write_bytes(HELPER)
        (self.sources / 'candidate-retention.py').write_bytes(CANDIDATE_REGISTRY)
        self.policy_path = self.root / 'policy.json'
        self.policy = {'kind': 'ID_DISK_RETENTION_POLICY_V1', 'version': 1, 'approved': False,
            'sourceSha256': installer.sha(NATIVE), 'maintainerSha256': installer.sha(HELPER),
            'candidateRegistrySha256': installer.sha(CANDIDATE_REGISTRY),
            'protectedCandidateBatches': [COMMIT + '-123-1'], 'supersededOnlineBatches': [],
            'budgets': {'targetFreeBytes': 12 * 1024**3, 'cleanupThresholdBytes': 10 * 1024**3,
                'criticalFreeBytes': 6 * 1024**3, 'projectArtifactsBytes': 4 * 1024**3,
                'localBackupsBytes': 1024**3, 'systemLogsBytes': 1024**3}}
        self.write_policy()
        self.commands = []
        self.command_timeouts = []
        self.enabled = False
        self.state_overrides = {}
        self.container_ids = [CONTAINER]
        self.legacy_confirmation = {'ok': True, 'status': 'LEGACY_RETENTION_UNITS_ABSENT',
            'timerMutations': 0, 'deletedFiles': 0, 'databaseWrites': 0}
        self.legacy_error = False
        self.legacy_calls = []
        for target, value in (('BASE', self.base), ('UNIT_DIRECTORY', self.units),
            ('SOURCE_DIRECTORY', self.sources), ('PROJECT', self.root),
            ('ROOT_UID', os.getuid()), ('ROOT_GID', os.getgid())):
            replacement = patch.object(installer, target, value)
            replacement.start()
            self.addCleanup(replacement.stop)
        root_patch = patch.object(installer.os, 'geteuid', return_value=0)
        root_patch.start()
        self.addCleanup(root_patch.stop)
        command_patch = patch.object(installer, 'command', side_effect=self.command)
        command_patch.start()
        self.addCleanup(command_patch.stop)
        legacy_patch = patch.object(installer, 'load_legacy', return_value=('c' * 64, self.legacy_retire))
        legacy_patch.start()
        self.addCleanup(legacy_patch.stop)

    def legacy_retire(self, apply=False):
        self.legacy_calls.append(apply)
        if self.legacy_error:
            raise RuntimeError('PRIVATE_LEGACY_EXECSTART')
        if not apply:
            return copy.deepcopy(self.legacy_confirmation)
        self.assertTrue(self.enabled)
        self.assertEqual(self.legacy_confirmation['status'], installer.LEGACY_READY)
        return {**self.legacy_confirmation,
            'status': 'LEGACY_RETENTION_TIMER_RETIRED_FAILURE_HISTORY_PRESERVED',
            'timerMutations': 1, 'unitsDeleted': 0, 'failureHistoryReset': False}

    def write_policy(self):
        self.policy_path.write_text(json.dumps(self.policy))

    def state(self, unit):
        names = installer.SERVICE_PROPERTIES if unit == installer.SERVICE else installer.TIMER_PROPERTIES
        state = dict.fromkeys(names, '')
        present = (self.units / unit).exists()
        state.update(Id=unit, Names=unit, LoadState='loaded' if present else 'not-found',
            FragmentPath=str(self.units / unit) if present else '',
            ActiveState='inactive', SubState='dead',
            UnitFileState=('static' if unit == installer.SERVICE else 'disabled') if present else '')
        if unit == installer.SERVICE:
            state.update(MainPID='0', ControlPID='0')
        else:
            state['Triggers'] = installer.SERVICE if present else ''
            if self.enabled:
                state.update(ActiveState='active', SubState='waiting', UnitFileState='enabled')
        state.update(self.state_overrides.get(unit, {}))
        return state

    def command(self, *arguments, timeout=45):
        self.commands.append(arguments)
        self.command_timeouts.append((arguments, timeout))
        if arguments[:5] == ('docker', 'ps', '-a', '--no-trunc', '--quiet'):
            return '\n'.join(self.container_ids)
        if arguments[:2] == ('systemctl', 'show'):
            return '\n'.join(key + '=' + value for key, value in self.state(arguments[2]).items())
        if arguments == ('systemctl', 'daemon-reload'):
            return ''
        if arguments == ('systemctl', 'enable', '--now', installer.TIMER):
            self.enabled = True
            return ''
        raise AssertionError(arguments)

    def preview(self):
        return installer.install(COMMIT, self.policy_path)

    def apply(self, digest=None):
        return installer.install(COMMIT, self.policy_path, apply=True,
            approved_plan_sha256=digest or self.preview()['planSha256'])

    def mutations(self):
        return [arguments for arguments in self.commands if arguments[:2] in
            (('systemctl', 'daemon-reload'), ('systemctl', 'enable'))]

    def test_preview_has_no_files_or_systemd_mutations_and_plan_binds_sources(self):
        result = self.preview()
        self.assertEqual(result['status'], 'PLAN_ONLY')
        self.assertFalse(result['mutationAttempted'])
        self.assertFalse((self.base / 'maintenance').exists())
        self.assertEqual(self.mutations(), [])
        self.assertEqual(result['plan']['baseline']['containerIds'], [CONTAINER])
        self.assertEqual(result['planSha256'], installer.sha(installer.canonical(result['plan'])))
        self.assertEqual(result['plan']['targets'][str(self.base /
            'maintenance/disk-retention/disk-retention.py')]['sha256'], installer.sha(NATIVE))
        self.assertEqual(result['plan']['targets'][str(self.base /
            'maintenance/disk-retention/candidate-retention.py')]['sha256'], installer.sha(CANDIDATE_REGISTRY))
        self.assertNotIn('supersededOnlineBatches', json.dumps(result))

    def test_missing_or_wrong_approval_never_creates_any_target(self):
        for digest in (None, 'wrong', 'f' * 64):
            with self.subTest(digest=digest), self.assertRaises(installer.Rejected):
                installer.install(COMMIT, self.policy_path, apply=True, approved_plan_sha256=digest)
            self.assertFalse((self.base / 'maintenance').exists())
        self.assertEqual(self.mutations(), [])

    def test_apply_creates_only_approved_entry_and_private_receipts(self):
        result = self.apply()
        destination = self.base / 'maintenance/disk-retention'
        self.assertEqual(result['status'], 'INSTALLED')
        self.assertEqual((destination / 'disk-retention.py').read_bytes(), NATIVE)
        self.assertEqual((destination / 'maintain-image-cache.py').read_bytes(), HELPER)
        self.assertEqual((destination / 'candidate-retention.py').read_bytes(), CANDIDATE_REGISTRY)
        self.assertFalse((destination / 'candidates.json').exists())
        saved = json.loads((destination / 'config.json').read_text())
        self.assertEqual(saved, {**self.policy, 'approved': True})
        self.assertIs(json.loads(self.policy_path.read_text())['approved'], False)
        for leaf in ('disk-retention.py', 'maintain-image-cache.py', 'candidate-retention.py', 'config.json'):
            self.assertEqual((destination / leaf).stat().st_mode & 0o777, 0o600)
        for unit in (installer.SERVICE, installer.TIMER):
            self.assertEqual((self.units / unit).stat().st_mode & 0o777, 0o644)
        for receipt in (destination / 'receipts').glob('*.json'):
            self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.mutations(), [('systemctl', 'daemon-reload'),
            ('systemctl', 'enable', '--now', installer.TIMER)])
        self.assertTrue(result['currentUnchanged'])
        self.assertTrue(result['containersUnchanged'])
        self.assertFalse(result['legacyTimerChanged'])
        self.assertFalse(result['websiteServicesChanged'])

    def test_timer_is_daily_utc_with_jitter_and_source_bound_native_command(self):
        service, timer = installer.units(installer.sha(NATIVE))
        self.assertIn(b'OnCalendar=*-*-* 03:15:00 UTC', timer)
        self.assertIn(b'RandomizedDelaySec=15m', timer)
        self.assertIn(b'Persistent=true', timer)
        self.assertIn(b'--scheduled --config ', service)
        self.assertIn(b'--expected-source-sha256 ' + installer.sha(NATIVE).encode(), service)
        self.assertNotIn(b'cleanup-aws-production-retention.sh', service)
        self.assertNotIn(b'ExecStop', service)

    def test_repeated_matching_install_does_not_rewrite_existing_files(self):
        self.apply()
        destination = self.base / 'maintenance/disk-retention'
        before = {path: installer.identity(path.stat()) for path in (*destination.glob('*.py'),
            destination / 'config.json', self.units / installer.SERVICE, self.units / installer.TIMER)}
        result = self.apply()
        self.assertEqual(result['filesCreated'], [])
        self.assertEqual(before, {path: installer.identity(path.stat()) for path in before})

    def test_current_commit_manifest_bytes_or_container_set_change_invalidates_plan(self):
        digest = self.preview()['planSha256']
        self.manifest.write_text(json.dumps({'commit': COMMIT, 'images': {}, 'changed': True}))
        with self.assertRaisesRegex(installer.Rejected, 'PLAN_CHANGED'):
            self.apply(digest)
        self.assertEqual(self.mutations(), [])
        digest = self.preview()['planSha256']
        self.container_ids.append('c' * 64)
        with self.assertRaisesRegex(installer.Rejected, 'PLAN_CHANGED'):
            self.apply(digest)
        self.manifest.write_text(json.dumps({'commit': 'd' * 40}))
        with self.assertRaisesRegex(installer.Rejected, 'BASELINE_INVALID'):
            self.preview()
        self.assertFalse((self.base / 'maintenance').exists())

    def test_source_bytes_policy_seals_and_approved_input_must_match(self):
        for field, value in (('sourceSha256', 'f' * 64), ('maintainerSha256', 'f' * 64),
            ('candidateRegistrySha256', 'f' * 64),
            ('approved', True), ('approved', 0), ('unknownSecret', 'PRIVATE_TOKEN')):
            original = dict(self.policy)
            self.policy[field] = value
            self.write_policy()
            with self.subTest(field=field), self.assertRaises(installer.Rejected) as error:
                self.preview()
            self.assertNotIn('PRIVATE_TOKEN', str(error.exception))
            self.policy = original
        self.write_policy()
        (self.sources / 'disk-retention.py').write_bytes(NATIVE + b'\n')
        with self.assertRaisesRegex(installer.Rejected, 'POLICY_INVALID'):
            self.preview()
        self.assertEqual(self.mutations(), [])

    def test_policy_duplicates_nonfinite_and_outside_project_are_rejected(self):
        for raw in ('{"approved":false,"approved":true}', '{"number":NaN}'):
            self.policy_path.write_text(raw)
            with self.assertRaises(installer.Rejected):
                self.preview()
        self.write_policy()
        with self.assertRaises(installer.Rejected):
            installer.install(COMMIT, self.root.parent / 'outside.json')
        self.assertEqual(self.mutations(), [])

    def test_existing_unknown_units_dropins_or_active_service_are_rejected(self):
        self.state_overrides[installer.SERVICE] = {'LoadState': 'loaded',
            'FragmentPath': '/lib/systemd/system/other.service'}
        with self.assertRaisesRegex(installer.Rejected, 'UNIT_INVALID'):
            self.preview()
        self.state_overrides.clear()
        service, timer = installer.units(installer.sha(NATIVE))
        (self.units / installer.SERVICE).write_bytes(service)
        (self.units / installer.SERVICE).chmod(0o644)
        for overrides, reason in (({'DropInPaths': '/tmp/unknown.conf'}, 'UNIT_INVALID'),
            ({'Names': installer.SERVICE + ' other.service'}, 'UNIT_INVALID'),
            ({'ActiveState': 'active', 'SubState': 'running', 'MainPID': '123'}, 'SERVICE_BUSY')):
            self.state_overrides[installer.SERVICE] = overrides
            with self.assertRaisesRegex(installer.Rejected, reason):
                self.preview()
        self.assertFalse((self.base / 'maintenance').exists())
        self.assertEqual(self.mutations(), [])

    def test_conflicting_file_permissions_symlinks_and_hardlinks_are_not_overwritten(self):
        service, unused = installer.units(installer.sha(NATIVE))
        target = self.units / installer.SERVICE
        for raw, mode in ((b'unknown PRIVATE_TOKEN', 0o644), (service, 0o666)):
            target.write_bytes(raw)
            target.chmod(mode)
            with self.assertRaisesRegex(installer.Rejected, 'TARGET_INVALID'):
                self.preview()
            self.assertEqual(target.read_bytes(), raw)
        target.unlink()
        source = self.units / 'other'
        source.write_bytes(service)
        target.symlink_to(source)
        with self.assertRaisesRegex(installer.Rejected, 'TARGET_INVALID'):
            self.preview()
        target.unlink()
        os.link(source, target)
        with self.assertRaisesRegex(installer.Rejected, 'TARGET_INVALID'):
            self.preview()
        self.assertEqual(self.mutations(), [])

    def test_unsafe_existing_directory_blocks_installation(self):
        maintenance = self.base / 'maintenance'
        maintenance.mkdir(mode=0o777)
        maintenance.chmod(0o777)
        with self.assertRaisesRegex(installer.Rejected, 'TARGET_INVALID'):
            self.preview()
        self.assertEqual(self.mutations(), [])

    def test_lock_contention_prevents_installation(self):
        digest = self.preview()['planSha256']
        with patch.object(installer.fcntl, 'flock', side_effect=BlockingIOError('PRIVATE_TOKEN')):
            with self.assertRaises(BlockingIOError):
                self.apply(digest)
        self.assertFalse((self.base / 'maintenance').exists())
        self.assertEqual(self.mutations(), [])

    def test_before_mutation_recheck_blocks_changed_unit_state(self):
        digest = self.preview()['planSha256']
        original = installer.plan
        calls = 0
        def changing(*arguments):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.container_ids.append('c' * 64)
            return original(*arguments)
        with patch.object(installer, 'plan', side_effect=changing):
            with self.assertRaisesRegex(installer.Rejected, 'PLAN_CHANGED'):
                self.apply(digest)
        self.assertFalse((self.base / 'maintenance').exists())

    def test_systemd_failure_preserves_created_entry_and_private_failure_receipt(self):
        original = self.command
        def failing(*arguments, **keywords):
            if arguments == ('systemctl', 'enable', '--now', installer.TIMER):
                raise RuntimeError('PRIVATE_TOKEN')
            return original(*arguments, **keywords)
        with patch.object(installer, 'command', side_effect=failing):
            with self.assertRaisesRegex(installer.Rejected, 'IO_FAILURE'):
                self.apply()
        destination = self.base / 'maintenance/disk-retention'
        self.assertEqual((destination / 'disk-retention.py').read_bytes(), NATIVE)
        receipts = [json.loads(path.read_text()) for path in (destination / 'receipts').glob('*.json')]
        failure = next(row for row in receipts if row['status'] == 'FAILED_CLOSED')
        self.assertTrue(failure['mutationAttempted'])
        self.assertIsNone(failure['currentUnchanged'])
        self.assertNotIn('PRIVATE_TOKEN', json.dumps(receipts))

    def test_postinstall_current_change_refuses_success_receipt(self):
        original = self.command
        def changed(*arguments, **keywords):
            result = original(*arguments, **keywords)
            if arguments == ('systemctl', 'enable', '--now', installer.TIMER):
                self.manifest.write_text(json.dumps({'commit': COMMIT, 'changed': True}))
            return result
        with patch.object(installer, 'command', side_effect=changed):
            with self.assertRaisesRegex(installer.Rejected, 'STATE_CHANGED'):
                self.apply()
        receipts = [json.loads(path.read_text()) for path in
            (self.base / 'maintenance/disk-retention/receipts').glob('*.json')]
        self.assertNotIn('INSTALLED', [row['status'] for row in receipts])

    def test_command_failure_and_cli_never_expose_raw_outputs(self):
        with patch.object(installer.subprocess, 'run', return_value=type('Result', (), {
            'returncode': 1, 'stdout': 'PRIVATE_TOKEN', 'stderr': 'PRIVATE_COOKIE'})()):
            # Use the original function: the mocked native command normally avoids all tools.
            with self.assertRaises(installer.Rejected) as error:
                ORIGINAL_COMMAND('test')
            self.assertNotIn('PRIVATE', str(error.exception))
        with patch.object(installer, 'install', side_effect=RuntimeError('PRIVATE_TOKEN')), \
                patch.object(sys, 'argv', ['install', '--expected-current', COMMIT,
                    '--policy-json', str(self.policy_path)]), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(installer.main(), 1)
        receipt = json.loads(output.getvalue())
        self.assertEqual(receipt['reason'], 'IO_FAILURE')
        self.assertNotIn('PRIVATE_TOKEN', output.getvalue())

    def test_actual_native_policy_contract_accepts_source_sealed_install_payload(self):
        native = (DIRECTORY / 'disk-retention.py').read_bytes()
        helper = (DIRECTORY / 'maintain-image-cache.py').read_bytes()
        candidate_registry = (DIRECTORY / 'candidate-retention.py').read_bytes()
        self.policy.update(sourceSha256=installer.sha(native), maintainerSha256=installer.sha(helper),
            candidateRegistrySha256=installer.sha(candidate_registry))
        self.write_policy()
        with patch.object(installer, 'SOURCE_DIRECTORY', DIRECTORY), \
                patch.object(installer, 'PROJECT', DIRECTORY.parents[1]):
            native_result, helper_result, candidate_result, config, unused = installer.sources(self.policy_path)
        self.assertEqual(native_result, native)
        self.assertEqual(helper_result, helper)
        self.assertEqual(candidate_result, candidate_registry)
        self.assertEqual(json.loads(config), {**self.policy, 'approved': True})

    def test_confirmed_removed_script_failure_is_retired_only_after_new_timer_verified(self):
        self.legacy_confirmation.update(status=installer.LEGACY_READY,
            unitSha256={name: 'e' * 64 for name in ('fixed.service', 'fixed.timer')},
            serviceFailureBefore={'execStartPath': '/opt/id-business-v2/current/scripts/cleanup-aws-production-retention.sh',
                'ExecMainStatus': '203', 'MainPID': '0'}, unitsDeleted=0, failureHistoryReset=False)
        preview = self.preview()
        legacy = preview['plan']['legacyRetention']
        self.assertEqual(legacy['sourceSha256'], 'c' * 64)
        self.assertEqual(legacy['confirmationSha256'], installer.sha(installer.canonical(self.legacy_confirmation)))
        self.assertNotIn(True, self.legacy_calls)
        result = self.apply(preview['planSha256'])
        self.assertEqual(self.legacy_calls.count(True), 1)
        self.assertTrue(result['legacyTimerChanged'])
        self.assertFalse(result['legacyRetention']['failureHistoryReset'])
        self.assertEqual(result['legacyRetention']['unitsDeleted'], 0)

    def test_unknown_old_unit_is_kept_without_private_output_or_retirement(self):
        self.legacy_error = True
        result = self.apply()
        self.assertEqual(result['status'], 'INSTALLED')
        self.assertEqual(result['legacyRetention']['status'], 'SKIPPED_UNKNOWN_LEGACY')
        self.assertFalse(result['legacyTimerChanged'])
        self.assertNotIn(True, self.legacy_calls)
        self.assertNotIn('PRIVATE_LEGACY_EXECSTART', json.dumps(result))

    def test_changed_legacy_confirmation_invalidates_approval_or_skips_retirement(self):
        self.legacy_confirmation['status'] = installer.LEGACY_READY
        self.legacy_confirmation['unitSha256'] = {'fixed.timer': 'e' * 64}
        digest = self.preview()['planSha256']
        self.legacy_confirmation['unitSha256']['fixed.timer'] = 'f' * 64
        with self.assertRaisesRegex(installer.Rejected, 'PLAN_CHANGED'):
            self.apply(digest)
        self.assertFalse(self.enabled)
        original = self.command
        def changed(*arguments, **keywords):
            output = original(*arguments, **keywords)
            if arguments == ('systemctl', 'enable', '--now', installer.TIMER):
                self.legacy_error = True
            return output
        with patch.object(installer, 'command', side_effect=changed):
            result = self.apply()
        self.assertEqual(result['legacyRetention']['status'], 'SKIPPED_UNKNOWN_LEGACY')
        self.assertNotIn(True, self.legacy_calls)

    def test_actual_legacy_source_is_bound_without_running_its_main_or_retirement(self):
        with patch.object(installer, 'SOURCE_DIRECTORY', DIRECTORY):
            # Call the actual loader, which only compiles definitions.
            source_sha, retire = ORIGINAL_LEGACY_LOADER()
        self.assertEqual(source_sha, installer.sha((DIRECTORY / 'retire-orphan-retention.py').read_bytes()))
        self.assertTrue(callable(retire))
        self.assertEqual(self.legacy_calls, [])

    def test_unapproved_or_mismatched_native_and_helper_sources_are_never_executed(self):
        for field, value in (('approved', True), ('sourceSha256', 'f' * 64),
            ('maintainerSha256', 'f' * 64), ('candidateRegistrySha256', 'f' * 64)):
            original = dict(self.policy)
            self.policy[field] = value
            self.write_policy()
            with self.subTest(field=field), patch.object(installer, 'exec', create=True) as execute:
                with self.assertRaisesRegex(installer.Rejected, 'POLICY_INVALID'):
                    installer.sources(self.policy_path)
                execute.assert_not_called()
            self.policy = original
        self.write_policy()
        (self.sources / 'disk-retention.py').write_bytes(NATIVE + b'\nraise RuntimeError("SOURCE_EXECUTED")\n')
        with patch.object(installer, 'exec', create=True) as execute:
            with self.assertRaisesRegex(installer.Rejected, 'POLICY_INVALID'):
                installer.sources(self.policy_path)
            execute.assert_not_called()

    def test_missing_or_modified_registry_source_rejects_before_native_exec(self):
        path = self.sources / 'candidate-retention.py'
        path.unlink()
        with patch.object(installer, 'exec', create=True) as execute:
            with self.assertRaises(FileNotFoundError):
                installer.sources(self.policy_path)
            execute.assert_not_called()
        path.write_bytes(CANDIDATE_REGISTRY + b'\n')
        with patch.object(installer, 'exec', create=True) as execute:
            with self.assertRaisesRegex(installer.Rejected, 'POLICY_INVALID'):
                installer.sources(self.policy_path)
            execute.assert_not_called()

    def test_modified_legacy_source_is_never_executed_or_retired(self):
        path = self.sources / 'retire-orphan-retention.py'
        path.write_bytes((DIRECTORY / 'retire-orphan-retention.py').read_bytes()
            + b'\nraise RuntimeError("SOURCE_EXECUTED")\n')
        with patch.object(installer, 'exec', create=True) as execute:
            with self.assertRaisesRegex(installer.Rejected, 'SOURCE_INVALID'):
                ORIGINAL_LEGACY_LOADER()
            execute.assert_not_called()
        self.assertEqual(self.legacy_calls, [])

    def test_post_enable_transient_owned_service_waits_then_completes(self):
        original = self.state
        attempts = 0
        def transient(unit):
            nonlocal attempts
            state = original(unit)
            if self.enabled and unit == installer.SERVICE:
                attempts += 1
                if attempts <= 2:
                    state.update(ActiveState='activating', SubState='start', MainPID='123')
            return state
        clock = {'now': 0}
        def advance(duration):
            clock['now'] += duration
        with patch.object(self, 'state', side_effect=transient), \
                patch.object(installer.time, 'monotonic', side_effect=lambda: clock['now']), \
                patch.object(installer.time, 'sleep', side_effect=advance) as sleep:
            result = self.apply()
        self.assertEqual(result['status'], 'INSTALLED')
        self.assertEqual(attempts, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [0.5, 0.5])
        self.assertEqual([timeout for arguments, timeout in self.command_timeouts
            if arguments[:3] == ('systemctl', 'show', installer.SERVICE) and timeout != 45], [15, 14.5, 14])
        self.assertEqual(self.mutations(), [('systemctl', 'daemon-reload'),
            ('systemctl', 'enable', '--now', installer.TIMER)])

    def test_post_enable_unknown_service_state_is_rejected_without_retry(self):
        original = self.state
        attempts = 0
        def unknown(unit):
            nonlocal attempts
            state = original(unit)
            if self.enabled and unit == installer.SERVICE:
                attempts += 1
                state.update(ActiveState='unknown', SubState='PRIVATE_UNKNOWN_STATE', MainPID='123')
            return state
        with patch.object(self, 'state', side_effect=unknown), \
                patch.object(installer.time, 'monotonic', return_value=0), \
                patch.object(installer.time, 'sleep') as sleep:
            with self.assertRaisesRegex(installer.Rejected, 'UNIT_INVALID'):
                self.apply()
            sleep.assert_not_called()
        self.assertEqual(attempts, 1)
        receipts = [json.loads(path.read_text()) for path in
            (self.base / 'maintenance/disk-retention/receipts').glob('*.json')]
        self.assertIn('FAILED_CLOSED', [row['status'] for row in receipts])
        self.assertNotIn('PRIVATE_UNKNOWN_STATE', json.dumps(receipts))

    def test_post_enable_busy_timeout_stops_waiting_and_preserves_failure_receipt(self):
        original = self.state
        attempts = 0
        def busy(unit):
            nonlocal attempts
            state = original(unit)
            if self.enabled and unit == installer.SERVICE:
                attempts += 1
                state.update(ActiveState='active', SubState='running', MainPID='123')
            return state
        with patch.object(self, 'state', side_effect=busy), \
                patch.object(installer.time, 'monotonic', side_effect=[0, 0, 0, 14.75, 14.75, 15]), \
                patch.object(installer.time, 'sleep') as sleep:
            with self.assertRaisesRegex(installer.Rejected, 'SERVICE_BUSY'):
                self.apply()
        self.assertEqual(attempts, 2)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [0.5, 0.25])
        self.assertEqual([timeout for arguments, timeout in self.command_timeouts
            if arguments[:3] == ('systemctl', 'show', installer.SERVICE) and timeout != 45], [15, 0.25])
        self.assertEqual(self.mutations(), [('systemctl', 'daemon-reload'),
            ('systemctl', 'enable', '--now', installer.TIMER)])
        receipts = [json.loads(path.read_text()) for path in
            (self.base / 'maintenance/disk-retention/receipts').glob('*.json')]
        failure = next(row for row in receipts if row['status'] == 'FAILED_CLOSED')
        self.assertEqual(failure['reason'], 'SERVICE_BUSY')
        self.assertTrue(failure['mutationAttempted'])


if __name__ == '__main__':
    unittest.main()
