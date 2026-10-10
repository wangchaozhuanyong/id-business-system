"""Synthetic local files/systemd/snapshots only; no AWS, Docker or production."""
import ast
import base64
import copy
import gzip
import json
import os
from pathlib import Path
import shlex
import stat
import tempfile
import types
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).parent
OUTPUT = SOURCE.parents[1] / '.runtime/backup-retention-protection-20261011'
INSTALLER = SOURCE / 'backup-retention-install.py'
i = types.ModuleType('synthetic_retention_installer')
i.__file__ = str(INSTALLER)
exec(compile(INSTALLER.read_bytes(), str(INSTALLER), 'exec'), i.__dict__)
t = i.load((SOURCE / 'online-recharge-backup-source-recovery-transport.py').read_bytes(),
           'synthetic_retention_authority', SOURCE / 'online-recharge-backup-source-recovery-transport.py')
PRODUCER = {'commit': '1234567890abcdef' * 2 + '12345678',
            'sourceTree': '0123456789abcdef' * 2 + '01234567',
            'workflowRunId': '12345678901234567890', 'workflowRunAttempt': '98765432109876543210'}


def binding(scripts):
    controllers = {name: i.sha(('synthetic ' + name).encode()) for name in i.CONTROLLERS}
    packages = {name: i.sha(('synthetic ' + name).encode()) for name in i.PACKAGE_FILES}
    extras = {name: i.sha(('synthetic ' + name).encode()) for name in i.EXTRA_FILES}
    pins = {name: i.sha(raw) for name, raw in scripts.items()}
    return {'producer': copy.deepcopy(PRODUCER), 'controllerPins': controllers, 'packagePins': packages,
            'extraPins': extras, 'scriptPins': pins,
            'source21Sha256': i.sha(i.canonical({'controllers': controllers, 'package': packages})),
            'maintenanceSourceSha256': i.sha(i.canonical({'installer': extras[INSTALLER.name], 'scripts': pins}))}


def plan():
    return {'kind': 'MYSQL_BACKUP_RETENTION_V1', 'status': 'PLAN_ONLY', 'code': 'OK',
            'protectedCount': 2, 'countBefore': 3, 'candidateCount': 0, 'removedCount': 0,
            'countAfter': 3, 'retainedBytes': 42, 'rawOutputSuppressed': True}


class RootView:
    """Fixture-only owner view; production root/owner checks remain unchanged."""
    def __init__(self, item, wrong_owner=False):
        self.item = item
        self.st_uid = 1 if wrong_owner else 0

    def __getattr__(self, name):
        return getattr(self.item, name)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        OUTPUT.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='installer-synthetic-', dir=OUTPUT)
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        for name in ('releases', 'backups', 'backups/mysql', '.staging'):
            (self.base / name).mkdir(mode=0o700)
        self.current = self.base / 'releases' / ('20261011T000000Z-' + i.BASELINE[:12])
        self.current.mkdir(mode=0o700)
        (self.current / 'scripts').mkdir(mode=0o700)
        self.original = {
            self.current / 'scripts/backup-aws-mysql.sh': b'#!/bin/bash\necho synthetic old backup\n',
            self.current / 'scripts/mysql-dump-restore-normalizer.sed': b's/synthetic/synthetic/\n',
            self.current / '.env.aws.production': b'UNRELATED_SECRET=synthetic-never-print\n',
            self.current / 'docker-compose.aws-mysql.yml': b'services: synthetic\n'}
        for path, raw in self.original.items():
            path.write_bytes(raw)
            path.chmod(0o600)
        (self.base / 'current').symlink_to(self.current)
        self.dropin = self.base / 'systemd' / (i.SERVICE + '.d') / '20-release-retention.conf'
        self.dropin.parent.parent.mkdir(mode=0o700)
        self.scripts = {'backup-aws-mysql.sh': b'#!/bin/bash\ntrue\n',
                        'backup-retention-protection.py': b'# synthetic no execution\n'}
        self.binding = binding(self.scripts)
        self.destination = self.base / 'maintenance' / ('mysql-backup-' + self.binding['maintenanceSourceSha256'][:16])
        self.entry = self.destination / 'backup-aws-mysql.sh'
        self.timer = 'active'
        self.dropins = ''
        self.exec_entry = self.base / 'current/scripts/backup-aws-mysql.sh'
        self.busy = False
        self.timer_change = False
        self.calls, self.native_calls = [], []
        self.native_hook = None
        self.snapshot_calls = 0
        self.snapshot_hook = None
        self.source_hook = None
        self.wrong_owners = set()
        real_stat, real_fstat = os.stat, os.fstat
        def owner_view(item):
            return RootView(item, (item.st_dev, item.st_ino) in self.wrong_owners)
        for handle in (
            patch.object(i, 'BASE', self.base), patch.object(i, 'DROPIN', self.dropin),
            patch.object(t, 'BASE', self.base),
            patch.object(os, 'stat', lambda *a, **kw: owner_view(real_stat(*a, **kw))),
            patch.object(os, 'fstat', lambda *a, **kw: owner_view(real_fstat(*a, **kw))),
            patch.object(os, 'getuid', return_value=0), patch.object(os, 'geteuid', return_value=0),
            patch.object(i, 'systemctl', self.systemctl), patch.object(i, 'native', self.native)):
            handle.start()
            self.addCleanup(handle.stop)

    def systemctl(self, *args, timeout=30):
        self.assertGreater(timeout, 0)
        self.assertLessEqual(timeout, 30)
        self.calls.append(args)
        self.assertFalse(args[0] in ('stop', 'start') and args[1] == i.TIMER)
        if args == ('daemon-reload',):
            self.exec_entry = self.entry
            self.dropins = str(self.dropin)
            if self.timer_change:
                self.timer = 'inactive'
            return ''
        if args[0] == 'show' and args[1] == i.TIMER:
            return self.timer
        if args[0] == 'show' and args[1] == i.SERVICE:
            if args[2] == '--property=ExecStart':
                return '{ path=' + str(self.exec_entry) + ' ; argv[]=' + str(self.exec_entry) + ' ; ignore_errors=no ; }'
            if args[2] == '--property=DropInPaths':
                return self.dropins
            return 'active' if self.busy else 'inactive'
        self.fail('Unexpected synthetic systemctl arguments')

    def native(self, args, timeout=30):
        self.assertGreater(timeout, 0)
        self.assertLessEqual(timeout, 30)
        self.native_calls.append(args)
        if self.native_hook:
            self.native_hook(args)
        if args[:2] == ['/usr/bin/bash', '-n']:
            return ''
        self.assertEqual(args[:2], ['/usr/bin/python3', '-B'])
        self.assertNotIn('--apply', args)
        self.assertNotIn('--backup-lock-fd', args)
        return i.canonical(plan()).decode()

    def snapshot(self, unused):
        self.snapshot_calls += 1
        if self.snapshot_hook:
            return self.snapshot_hook(self.snapshot_calls)
        return 'a' * 64

    def source_check(self):
        if self.source_hook:
            self.source_hook()

    def run_install(self, **kwargs):
        authority = t.Authority()
        try:
            kwargs.setdefault('transport', t)
            result = i.install(self.binding, self.scripts, authority, self.snapshot,
                               source_check=self.source_check, **kwargs)
            self.assertEqual(i.validate_result(result, self.binding), result)
            self.assertNotIn('synthetic-never-print', i.canonical(result).decode())
            return result
        finally:
            authority.close()

    def assert_original(self):
        for path, raw in self.original.items():
            self.assertEqual(path.read_bytes(), raw)

    def test_original_service_entry_installs_only_maintenance_and_dropin(self):
        value = self.run_install()
        self.assertEqual(value['status'], 'COMPLETED')
        self.assertTrue(value['timerRestored'])
        for name, raw in self.scripts.items():
            path = self.destination / name
            self.assertEqual(path.read_bytes(), raw)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if name.endswith('.sh') else 0o600)
        self.assertEqual(self.dropin.read_bytes(), ('[Service]\nExecStart=\nExecStart=' + str(self.entry) + '\n').encode())
        self.assertEqual(stat.S_IMODE(self.dropin.stat().st_mode), 0o600)
        self.assertEqual(self.native_calls[-1][-4:], ['--retention-count', '48', '--max-bytes', '1073741824'])
        self.assert_original()

    def test_retry_same_entry_retains_exact_files_and_inode(self):
        self.assertEqual(self.run_install()['status'], 'COMPLETED')
        before = {p: i.file_identity(p.stat()) for p in [self.entry, self.destination / 'backup-retention-protection.py', self.dropin]}
        self.assertEqual(self.run_install()['status'], 'COMPLETED')
        self.assertEqual(before, {p: i.file_identity(p.stat()) for p in before})
        self.assert_original()

    def test_another_dropin_rejected_before_timer_or_files(self):
        self.dropins = str(self.dropin.parent / '99-unreviewed.conf')
        value = self.run_install()
        self.assertEqual(value['code'], 'ENTRY_CHANGED')
        self.assertFalse(value['mutationAttempted'])
        self.assertNotIn(('stop', i.TIMER), self.calls)
        self.assertFalse(self.destination.exists())

    def test_another_service_entry_rejected(self):
        self.exec_entry = self.base / 'other.sh'
        value = self.run_install()
        self.assertEqual(value['code'], 'ENTRY_CHANGED')
        self.assertFalse(value['mutationAttempted'])

    def test_symlink_maintenance_file_is_never_replaced(self):
        self.destination.mkdir(parents=True, mode=0o700)
        self.entry.symlink_to(self.current / 'scripts/backup-aws-mysql.sh')
        value = self.run_install()
        self.assertEqual(value['status'], 'FAILED_MUTATED_UNVERIFIED')
        self.assertTrue(self.entry.is_symlink())
        self.assertTrue(value['timerRestored'])
        self.assert_original()

    def test_wrong_owner_maintenance_file_is_never_replaced(self):
        self.destination.mkdir(parents=True, mode=0o700)
        self.entry.write_bytes(self.scripts['backup-aws-mysql.sh'])
        self.entry.chmod(0o700)
        item = self.entry.stat()
        self.wrong_owners.add((item.st_dev, item.st_ino))
        value = self.run_install()
        self.assertEqual(value['code'], 'ENTRY_CHANGED')
        self.assertTrue(value['timerRestored'])
        self.assertEqual(self.entry.read_bytes(), self.scripts['backup-aws-mysql.sh'])

    def test_symlink_parent_is_never_followed(self):
        other = self.base / 'other'; other.mkdir(mode=0o700)
        (self.base / 'maintenance').symlink_to(other)
        value = self.run_install()
        self.assertEqual(value['code'], 'SOURCE_INVALID')
        self.assertEqual(list(other.iterdir()), [])
        self.assertTrue(value['timerRestored'])

    def test_existing_changed_dropin_is_never_overwritten(self):
        self.dropin.parent.mkdir(mode=0o700)
        self.dropin.write_bytes(b'[Service]\nExecStart=/other\n'); self.dropin.chmod(0o600)
        self.dropins = str(self.dropin)
        value = self.run_install()
        self.assertEqual(value['code'], 'ENTRY_CHANGED')
        self.assertEqual(self.dropin.read_bytes(), b'[Service]\nExecStart=/other\n')
        self.assertTrue(value['timerRestored'])

    def test_dropin_symlink_is_never_followed(self):
        self.dropin.parent.mkdir(mode=0o700)
        self.dropin.symlink_to(self.current / 'docker-compose.aws-mysql.yml')
        self.dropins = str(self.dropin)
        value = self.run_install()
        self.assertEqual(value['status'], 'FAILED_MUTATED_UNVERIFIED')
        self.assertTrue(value['timerRestored'])
        self.assertTrue(self.dropin.is_symlink())
        self.assert_original()

    def test_dropin_wrong_owner_is_never_replaced(self):
        self.dropin.parent.mkdir(mode=0o700)
        raw = ('[Service]\nExecStart=\nExecStart=' + str(self.entry) + '\n').encode()
        self.dropin.write_bytes(raw); self.dropin.chmod(0o600)
        item = self.dropin.stat(); self.wrong_owners.add((item.st_dev, item.st_ino))
        self.dropins = str(self.dropin)
        value = self.run_install()
        self.assertEqual(value['code'], 'ENTRY_CHANGED')
        self.assertTrue(value['timerRestored'])
        self.assertEqual(self.dropin.read_bytes(), raw)

    def test_parent_identity_change_while_reading_is_rejected(self):
        parent = self.base / 'held-parent'; parent.mkdir(mode=0o700)
        path = parent / 'fixed'; path.write_bytes(b'synthetic fixed'); path.chmod(0o600)
        original_read = os.read
        def changed(fd, size):
            raw = original_read(fd, size)
            parent.rename(self.base / 'moved-parent')
            parent.mkdir(mode=0o700)
            return raw
        with patch.object(os, 'read', changed), self.assertRaisesRegex(i.Rejected, '^SOURCE_INVALID$'):
            i.store_exact(path, b'synthetic fixed', 0o600, create=False)
        self.assertFalse(path.exists())
        self.assertEqual((self.base / 'moved-parent/fixed').read_bytes(), b'synthetic fixed')

    def test_readonly_recheck_does_not_recreate_missing_leaf(self):
        parent = self.base / 'readonly-parent'; parent.mkdir(mode=0o700)
        path = parent / 'missing'
        with self.assertRaises(FileNotFoundError):
            i.store_exact(path, b'synthetic', 0o600, create=False)
        self.assertFalse(path.exists())

    def test_inactive_timer_remains_inactive(self):
        self.timer = 'inactive'
        value = self.run_install()
        self.assertEqual(value['status'], 'COMPLETED')
        self.assertTrue(value['timerRestored'])
        self.assertNotIn(('stop', i.TIMER), self.calls)
        self.assertNotIn(('start', i.TIMER), self.calls)

    def test_external_timer_change_never_reports_completed(self):
        self.timer_change = True
        value = self.run_install()
        self.assertEqual(value['status'], 'FAILED_MUTATED_UNVERIFIED')
        self.assertEqual(value['code'], 'TIMER_CHANGED')
        self.assertFalse(value['timerRestored'])

    def test_busy_service_total_deadline_never_stops_timer(self):
        self.busy = True
        elapsed = [0]
        value = self.run_install(clock=lambda: elapsed[0], pause=lambda unused: elapsed.__setitem__(0, 761))
        self.assertEqual(value['code'], 'SERVICE_BUSY')
        self.assertEqual(value['status'], 'FAILED')
        self.assertEqual(self.timer, 'active')
        self.assertFalse(value['mutationAttempted'])
        self.assertFalse(self.destination.exists())

    def test_service_busy_waits_until_oneshot_ends(self):
        self.busy = True
        value = self.run_install(clock=lambda: 0, pause=lambda unused: setattr(self, 'busy', False))
        self.assertEqual(value['status'], 'COMPLETED')
        self.assertEqual(self.calls.count(('show', i.SERVICE, '--property=ActiveState', '--value')), 3)

    def test_post_reload_waits_for_original_oneshot_without_timer_stop(self):
        original = self.systemctl
        elapsed = [0]
        def control(*args, **kwargs):
            value = original(*args, **kwargs)
            if args == ('daemon-reload',):
                self.busy = True
            return value
        with patch.object(i, 'systemctl', control):
            value = self.run_install(clock=lambda: elapsed[0], pause=lambda unused: (elapsed.__setitem__(0, elapsed[0] + 2), setattr(self, 'busy', False)))
        self.assertEqual(value['status'], 'COMPLETED')
        self.assertEqual(elapsed[0], 2)
        self.assertEqual(self.timer, 'active')

    def test_post_reload_wait_uses_same_total_deadline_and_remaining_timeout(self):
        original = self.systemctl
        elapsed, timeouts = [0], []
        def control(*args, **kwargs):
            timeouts.append(kwargs['timeout'])
            value = original(*args, **kwargs)
            if args == ('daemon-reload',):
                self.busy = True
                elapsed[0] = 759
            return value
        with patch.object(i, 'systemctl', control):
            value = self.run_install(clock=lambda: elapsed[0], pause=lambda seconds: elapsed.__setitem__(0, elapsed[0] + seconds))
        self.assertEqual(value['status'], 'FAILED_MUTATED_UNVERIFIED')
        self.assertEqual(value['code'], 'SERVICE_BUSY')
        self.assertEqual(self.timer, 'active')
        self.assertIn(1, timeouts)
        self.assertEqual(elapsed[0], 760)

    def test_atomic_files_have_complete_bytes_when_destination_first_appears(self):
        original_link = os.link
        linked = []
        def link(source, target, **kwargs):
            with self.assertRaises(FileNotFoundError):
                os.stat(target, dir_fd=kwargs['dst_dir_fd'], follow_symlinks=False)
            value = original_link(source, target, **kwargs)
            fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=kwargs['dst_dir_fd'])
            try:
                linked.append((target, os.read(fd, 1024**2)))
            finally:
                os.close(fd)
            return value
        with patch.object(os, 'link', link):
            value = self.run_install()
        self.assertEqual(value['status'], 'COMPLETED')
        actual = dict(linked)
        self.assertEqual(actual['backup-aws-mysql.sh'], self.scripts['backup-aws-mysql.sh'])
        self.assertEqual(actual['backup-retention-protection.py'], self.scripts['backup-retention-protection.py'])
        self.assertEqual(actual['20-release-retention.conf'], self.dropin.read_bytes())
        self.assertEqual(list(self.base.rglob('.backup-retention-*')), [])

    def test_original_source_change_rejected_before_dropin(self):
        changed = self.current / 'docker-compose.aws-mysql.yml'
        self.native_hook = lambda unused: changed.write_bytes(b'synthetic changed original')
        value = self.run_install()
        self.assertEqual(value['status'], 'FAILED_MUTATED_UNVERIFIED')
        self.assertFalse(value['entryVerified'])
        self.assertFalse(self.dropin.exists())
        self.assertTrue(value['timerRestored'])

    def test_current_pointer_change_rejected_before_dropin(self):
        other = self.base / 'releases/20261011T000001Z-ffffffffffff'; other.mkdir(mode=0o700)
        def change(unused):
            (self.base / 'current').unlink()
            (self.base / 'current').symlink_to(other)
        self.native_hook = change
        value = self.run_install()
        self.assertEqual(value['status'], 'FAILED_MUTATED_UNVERIFIED')
        self.assertFalse(self.dropin.exists())
        self.assertTrue(value['timerRestored'])

    def test_snapshot_change_after_first_wait_blocks_install(self):
        self.snapshot_hook = lambda count: ('a' if count == 1 else 'b') * 64
        value = self.run_install()
        self.assertEqual(value['code'], 'SERVICES_CHANGED')
        self.assertFalse(self.destination.exists())
        self.assertTrue(value['timerRestored'])

    def test_snapshot_change_after_reload_blocks_success(self):
        self.snapshot_hook = lambda count: ('b' if count == 4 else 'a') * 64
        value = self.run_install()
        self.assertEqual(value['code'], 'SERVICES_CHANGED')
        self.assertTrue(value['entryVerified'])
        self.assertTrue(value['timerRestored'])

    def test_unknown_snapshot_value_never_enters_result(self):
        self.snapshot_hook = lambda count: 'untrusted-raw-fixture' if count == 4 else 'a' * 64
        value = self.run_install()
        self.assertEqual(value['code'], 'SERVICES_CHANGED')
        self.assertEqual(value['servicesAfterSha256'], 'NOT_MEASURED')
        self.assertNotIn('untrusted-raw-fixture', i.canonical(value).decode())

    def test_source_check_change_preserves_timer_without_dropin(self):
        checks = [0]
        def changed():
            checks[0] += 1
            if checks[0] == 2:
                raise i.Rejected('SOURCE_INVALID')
        self.source_hook = changed
        value = self.run_install()
        self.assertEqual(value['code'], 'SOURCE_INVALID')
        self.assertTrue(value['timerRestored'])
        self.assertFalse(self.dropin.exists())

    def test_helper_plan_failure_preserves_timer_without_dropin(self):
        def fail(args):
            if args[0] == '/usr/bin/python3':
                raise i.Rejected('SYSTEMD_FAILED')
        self.native_hook = fail
        value = self.run_install()
        self.assertEqual(value['code'], 'SYSTEMD_FAILED')
        self.assertFalse(self.dropin.exists())
        self.assertTrue(value['timerRestored'])

    def test_installed_helper_change_during_plan_rejected_before_dropin(self):
        def change(args):
            if args[0] == '/usr/bin/python3':
                (self.destination / 'backup-retention-protection.py').write_bytes(b'synthetic changed helper')
        self.native_hook = change
        value = self.run_install()
        self.assertEqual(value['code'], 'ENTRY_CHANGED')
        self.assertFalse(self.dropin.exists())
        self.assertTrue(value['timerRestored'])

    def test_script_pin_change_rejected_before_mutation(self):
        self.scripts['backup-aws-mysql.sh'] += b'# changed synthetic source\n'
        value = self.run_install()
        self.assertEqual(value['code'], 'SOURCE_INVALID')
        self.assertFalse(value['mutationAttempted'])

    def test_remote_reads_all_source21_and_rechecks_package_changes(self):
        directory = self.base / '.staging' / ('api-workspace-verify-' + PRODUCER['commit'])
        directory.mkdir(mode=0o700)
        (directory / 'formal-runtime-package').mkdir(mode=0o700)
        for name in [*i.CONTROLLERS, *i.EXTRA_FILES]:
            (directory / name).write_bytes(('synthetic ' + name).encode())
        for name in i.PACKAGE_FILES:
            (directory / 'formal-runtime-package' / name).write_bytes(('synthetic ' + name).encode())
        observed = []
        def fixed(path, expected):
            observed.append(path)
            raw = path.read_bytes()
            if i.sha(raw) != expected:
                raise RuntimeError('synthetic fixed source mismatch')
            return raw
        snapshot = types.SimpleNamespace(read_fixed=fixed, literal_module=lambda *unused: object(),
            snapshot_state=lambda: object(), NativeSnapshotDriver=lambda *unused: types.SimpleNamespace(snapshot=self.snapshot, native=lambda *unused, **kwargs: 'synthetic'))
        self.native_hook = lambda unused: (directory / 'formal-runtime-package/contract.json').write_bytes(b'synthetic changed package')
        value = i.remote_execute(self.binding, self.scripts, directory, snapshot, t)
        self.assertEqual(value['code'], 'SOURCE_INVALID')
        self.assertTrue(value['timerRestored'])
        self.assertFalse(self.dropin.exists())
        initial = observed[:24]
        self.assertEqual(set(initial), {directory / name for name in [*i.CONTROLLERS, *i.EXTRA_FILES]}
                         | {directory / 'formal-runtime-package' / name for name in i.PACKAGE_FILES})
        i.validate_result(value, self.binding)

    def test_remote_source21_mismatch_rejected_before_authority_or_systemd(self):
        directory = self.base / '.staging' / ('api-workspace-verify-' + PRODUCER['commit'])
        snapshot = types.SimpleNamespace(read_fixed=lambda *unused: (_ for _ in ()).throw(RuntimeError('synthetic raw forbidden')))
        with patch.object(t, 'Authority', side_effect=AssertionError('must not open authority')):
            value = i.remote_execute(self.binding, self.scripts, directory, snapshot, t)
        self.assertEqual(value['code'], 'SOURCE_INVALID')
        self.assertFalse(value['mutationAttempted'])
        self.assertEqual(self.calls, [])
        self.assertNotIn('synthetic raw forbidden', i.canonical(value).decode())
        i.validate_result(value, self.binding)

    def test_diagnostic_original_leaf_owner_is_only_finite_reason(self):
        cases = (('BACKUP_SCRIPT', self.current / 'scripts/backup-aws-mysql.sh'),
                 ('NORMALIZER', self.current / 'scripts/mysql-dump-restore-normalizer.sed'),
                 ('ENV_LIMITS', self.current / '.env.aws.production'),
                 ('COMPOSE', self.current / 'docker-compose.aws-mysql.yml'))
        for stage, path in cases:
            with self.subTest(stage=stage):
                item = path.stat(); self.wrong_owners.add((item.st_dev, item.st_ino))
                value = self.run_install()
                self.wrong_owners.clear()
                self.assertEqual(value['code'], stage + '_SOURCE_OWNER')
                self.assertFalse(value['mutationAttempted'])
                self.assertEqual(self.calls, [])
                self.assertEqual(self.native_calls, [])
                self.assertFalse(self.destination.exists())
                self.assertNotIn(str(path), i.canonical(value).decode())
                self.assertEqual(set(value), i.FIELDS)

    def test_diagnostic_original_leaf_existing_fd_type_links_mode_size(self):
        path = self.current / 'scripts/backup-aws-mysql.sh'
        raw = path.read_bytes()
        path.unlink(); path.mkdir(mode=0o700)
        value = self.run_install(); self.assertEqual(value['code'], 'BACKUP_SCRIPT_SOURCE_TYPE')
        path.rmdir(); path.write_bytes(raw); path.chmod(0o600)
        extra = self.current / 'synthetic-hardlink'; os.link(path, extra)
        value = self.run_install(); self.assertEqual(value['code'], 'BACKUP_SCRIPT_SOURCE_LINKS')
        extra.unlink(); path.chmod(0o622)
        value = self.run_install(); self.assertEqual(value['code'], 'BACKUP_SCRIPT_SOURCE_WRITABLE')
        path.chmod(0o600); path.write_bytes(b'')
        value = self.run_install(); self.assertEqual(value['code'], 'BACKUP_SCRIPT_SOURCE_SIZE')
        self.assertFalse(value['mutationAttempted'])
        self.assertEqual(self.calls, [])

    def test_diagnostic_missing_link_utf8_and_directory_rejection_are_finite(self):
        path = self.current / 'scripts/backup-aws-mysql.sh'; raw = path.read_bytes()
        path.unlink()
        value = self.run_install(); self.assertEqual(value['code'], 'BACKUP_SCRIPT_MISSING')
        path.symlink_to(self.current / 'scripts/mysql-dump-restore-normalizer.sed')
        value = self.run_install(); self.assertEqual(value['code'], 'BACKUP_SCRIPT_LINK_REJECTED')
        path.unlink(); path.write_bytes(raw); path.chmod(0o600)
        env = self.current / '.env.aws.production'; env.write_bytes(b'\xffSYNTHETIC_OPAQUE')
        value = self.run_install(); self.assertEqual(value['code'], 'ENV_LIMITS_UTF8_INVALID')
        env.write_bytes(self.original[env])
        item = (self.current / 'scripts').stat(); self.wrong_owners.add((item.st_dev, item.st_ino))
        value = self.run_install(); self.assertEqual(value['code'], 'CURRENT_SCRIPTS_ANCESTOR_CURRENT_RELEASE_OWNER')
        self.assertFalse(value['mutationAttempted'])
        self.assertEqual(self.calls, [])
        self.assertNotIn('SYNTHETIC_OPAQUE', i.canonical(value).decode())

    def test_diagnostic_rejection_fd_only_no_second_open_or_content_read(self):
        path = self.current / 'scripts/backup-aws-mysql.sh'; item = path.stat()
        self.wrong_owners.add((item.st_dev, item.st_ino))
        authority = t.Authority()
        try:
            scripts = authority.child(authority.current_fd, 'scripts', role='CURRENT_RELEASE')
            original_open, original_read, original_fstat = os.open, os.read, os.fstat
            calls = {'open': 0, 'read': 0, 'fstat': 0}
            def opened(*args, **kwargs):
                calls['open'] += 1; return original_open(*args, **kwargs)
            def read(*args, **kwargs):
                calls['read'] += 1; return original_read(*args, **kwargs)
            def measured(*args, **kwargs):
                calls['fstat'] += 1; return original_fstat(*args, **kwargs)
            with patch.object(os, 'open', opened), patch.object(os, 'read', read), patch.object(os, 'fstat', measured):
                with self.assertRaisesRegex(i.Rejected, '^BACKUP_SCRIPT_SOURCE_OWNER$'):
                    i.read_original(authority, scripts, path.name, stage='BACKUP_SCRIPT', transport=t)
            self.assertEqual(calls, {'open': 1, 'read': 0, 'fstat': 2})
        finally:
            authority.close()

    def test_diagnostic_snapshot_requires_original_issued_empty_exception(self):
        snapshot = i.load((SOURCE / 'online-recharge-source-permission-repair-transport.py').read_bytes(),
            'synthetic_installer_snapshot', SOURCE / 'online-recharge-source-permission-repair-transport.py')
        diagnostic = snapshot.snapshot_state()
        def failed(count):
            if count == 2:
                diagnostic.mark('PROJECT_IDS'); diagnostic.fail('IDS_INVALID')
            return 'a' * 64
        self.snapshot_hook = failed
        value = self.run_install(diagnostic=diagnostic, snapshot_validate=snapshot.snapshot_validate)
        self.assertEqual(value['code'], 'SNAPSHOT_RECHECK_IDS_INVALID')
        self.assertFalse(value['mutationAttempted'])
        self.assertTrue(value['timerRestored'])
        self.assertFalse(self.destination.exists())
        for error in (RuntimeError(), RuntimeError('IDS_INVALID'), t.Rejected('IDS_INVALID')):
            self.assertEqual(i.failure_code(error, 'SNAPSHOT_RECHECK', transport=t,
                diagnostic=diagnostic, snapshot_validate=snapshot.snapshot_validate), 'IO_FAILURE')

    def test_diagnostic_exact_classes_literal_args_only_and_owned_schema_closed(self):
        class Foreign(RuntimeError): pass
        class OwnSub(i.Rejected): pass
        class ForeignSub(t.Rejected): pass
        class Text(str): pass
        self.assertEqual(i.failure_code(i.Rejected('SOURCE_INVALID'), 'SOURCE_INITIAL', transport=t), 'SOURCE_INVALID')
        self.assertEqual(i.failure_code(t.Rejected('SOURCE_INVALID'), 'BACKUP_SCRIPT', transport=t), 'BACKUP_SCRIPT_SOURCE_INVALID')
        for error in (Foreign('SOURCE_INVALID'), OwnSub('SOURCE_INVALID'), ForeignSub('SOURCE_INVALID'),
                      i.Rejected(Text('SOURCE_INVALID')), t.Rejected(Text('SOURCE_INVALID')),
                      i.Rejected('SOURCE_INVALID','extra'), t.Rejected('SOURCE_INVALID','extra'),
                      i.Rejected('SYNTHETIC_SECRET'), t.Rejected('SYNTHETIC_SECRET'),
                      i.Rejected('OK'), t.Rejected('CURRENT_INVALID')):
            self.assertEqual(i.failure_code(error, 'BACKUP_SCRIPT', transport=t), 'IO_FAILURE')
        snapshot = i.load((SOURCE / 'online-recharge-source-permission-repair-transport.py').read_bytes(),
            'synthetic_installer_snapshot_schema', SOURCE / 'online-recharge-source-permission-repair-transport.py')
        diagnostic = snapshot.snapshot_state(); diagnostic.mark('CURRENT_IDS')
        try: diagnostic.fail('IDS_INVALID')
        except RuntimeError as caught: error = caught
        row = diagnostic.get()
        for changed in ({**row,'raw':'SYNTHETIC_SECRET'}, {**row,'code':Text('IDS_INVALID')},
                        {**row,'stage':'SYNTHETIC_SECRET'}):
            with patch.object(diagnostic, 'get', return_value=changed):
                self.assertEqual(i.failure_code(error, 'SNAPSHOT_RECHECK', transport=t,
                    diagnostic=diagnostic, snapshot_validate=snapshot.snapshot_validate), 'IO_FAILURE')

    def test_diagnostic_native_timeout_keeps_timer_running_and_suppresses_details(self):
        original = self.systemctl
        def control(*args, **kwargs):
            if args[:3] == ('show', i.SERVICE, '--property=ExecStart'):
                raise i.subprocess.TimeoutExpired('SYNTHETIC_SECRET_PATH', 30)
            return original(*args, **kwargs)
        with patch.object(i, 'systemctl', control):
            value = self.run_install()
        self.assertEqual(value['code'], 'SERVICE_ENTRY_TIMEOUT')
        self.assertFalse(value['mutationAttempted'])
        self.assertEqual(self.timer, 'active')
        self.assertNotIn('SYNTHETIC_SECRET_PATH', i.canonical(value).decode())

    def test_diagnostic_authority_constructor_loaded_rejection_keeps_source_rules(self):
        directory = self.base / '.staging' / ('api-workspace-verify-' + PRODUCER['commit'])
        directory.mkdir(mode=0o700)
        snapshot = types.SimpleNamespace(read_fixed=lambda *unused: b'synthetic public source',
            literal_module=lambda *unused: object(), snapshot_state=lambda: object())
        with patch.object(t, 'Authority', side_effect=t.Rejected('ANCESTOR_MYSQL_OWNER')):
            value = i.remote_execute(self.binding, self.scripts, directory, snapshot, t)
        self.assertEqual(value['code'], 'AUTHORITY_OPEN_ANCESTOR_MYSQL_OWNER')
        self.assertFalse(value['mutationAttempted'])
        self.assertEqual(self.calls, [])
        i.validate_result(value, self.binding)

    def test_current_scripts_writable_only_tightens_directory_preserving_other_bits_and_sources(self):
        path = self.current / 'scripts'
        unknown = path / 'unknown-synthetic-file'
        unknown.write_bytes(b'synthetic opaque content not read by repair')
        original_chmod = os.fchmod
        for mode in (0o775, 0o777, 0o1702, 0o3777):
            with self.subTest(mode=mode):
                path.chmod(mode)
                before = i.file_identity(path.stat())
                leaves = {p: i.file_identity(p.stat()) for p in [*self.original, unknown]}
                changes = []
                def chmod(fd, target):
                    changes.append((os.fstat(fd).st_ino, target))
                    return original_chmod(fd, target)
                with patch.object(os, 'fchmod', chmod):
                    value = self.run_install()
                self.assertEqual(value['status'], 'COMPLETED')
                self.assertEqual(changes, [(before[1], mode & ~0o022)])
                after = i.file_identity(path.stat())
                self.assertEqual(stat.S_IMODE(after[2]), mode & ~0o022)
                self.assertEqual(tuple(before[n] for n in (0, 1, 3, 4, 5, 6, 7)),
                                 tuple(after[n] for n in (0, 1, 3, 4, 5, 6, 7)))
                self.assertEqual(leaves, {p: i.file_identity(p.stat()) for p in leaves})
                self.assert_original()
                self.assertEqual(self.timer, 'active')

    def test_current_scripts_safe_directory_uses_original_strict_path_without_chmod(self):
        path = self.current / 'scripts'
        for mode in (0o700, 0o755, 0o1755):
            with self.subTest(mode=mode):
                path.chmod(mode)
                before = i.file_identity(path.stat())
                with patch.object(os, 'fchmod', side_effect=AssertionError('no directory repair')):
                    self.assertEqual(self.run_install()['status'], 'COMPLETED')
                self.assertEqual(i.file_identity(path.stat()), before)

    def test_current_scripts_wrong_owner_type_and_symlink_are_never_repaired(self):
        path = self.current / 'scripts'
        path.chmod(0o777)
        item = path.stat(); self.wrong_owners.add((item.st_dev, item.st_ino))
        with patch.object(os, 'fchmod', side_effect=AssertionError('not authorized')):
            value = self.run_install()
        self.assertEqual(value['code'], 'CURRENT_SCRIPTS_ANCESTOR_CURRENT_RELEASE_OWNER')
        self.assertFalse(value['mutationAttempted'])
        self.wrong_owners.clear()
        saved = self.current / 'synthetic-scripts-original'
        path.rename(saved)
        for shape in ('file', 'symlink'):
            with self.subTest(shape=shape):
                if shape == 'file': path.write_bytes(b'synthetic wrong type')
                else: path.symlink_to(saved)
                with patch.object(os, 'fchmod', side_effect=AssertionError('not authorized')):
                    value = self.run_install()
                self.assertEqual(value['code'], 'CURRENT_SCRIPTS_ANCESTOR_CURRENT_RELEASE_TYPE')
                self.assertFalse(value['mutationAttempted'])
                path.unlink()
        saved.rename(path)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o777)
        self.assert_original()

    def test_current_scripts_only_exact_loaded_single_literal_authorizes_repair(self):
        class Foreign(RuntimeError): pass
        class Sub(t.Rejected): pass
        class Text(str): pass
        literal = 'ANCESTOR_CURRENT_RELEASE_WRITABLE'
        path = self.current / 'scripts'; path.chmod(0o777)
        authority = t.Authority()
        try:
            for error in (Foreign(literal), Sub(literal), i.Rejected(literal),
                          t.Rejected(Text(literal)), t.Rejected(literal, 'extra'),
                          t.Rejected('ANCESTOR_CURRENT_RELEASE_OWNER'), t.Rejected('SYNTHETIC_SECRET')):
                result = i.empty_result(self.binding)
                with self.subTest(error_type=type(error).__name__), patch.object(authority, 'child', side_effect=error), \
                     patch.object(os, 'fchmod', side_effect=AssertionError('not authorized')):
                    with self.assertRaises(type(error)) as caught:
                        i.current_scripts(authority, t, result, lambda: self.fail('must not guard'))
                    self.assertIs(caught.exception, error)
                self.assertFalse(result['mutationAttempted'])
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o777)
        finally:
            authority.close()

    def test_current_scripts_fd_cleanup_and_no_unknown_file_reads(self):
        path = self.current / 'scripts'
        for refusal in (None, 1, 2):
            with self.subTest(refusal=refusal):
                path.chmod(0o777)
                authority = t.Authority()
                opened = set()
                original_open, original_close = os.open, os.close
                def opening(*args, **kwargs):
                    fd = original_open(*args, **kwargs); opened.add(fd); return fd
                def closing(fd):
                    opened.discard(fd); return original_close(fd)
                guards = [0]
                def guard():
                    guards[0] += 1
                    if guards[0] == refusal: raise i.Rejected('SOURCE_INVALID')
                    authority.check()
                result = i.empty_result(self.binding)
                with patch.object(os, 'open', opening), patch.object(os, 'close', closing), \
                     patch.object(os, 'read', side_effect=AssertionError('no contents')), \
                     patch.object(os, 'listdir', side_effect=AssertionError('no listing')), \
                     patch.object(os, 'scandir', side_effect=AssertionError('no scan')):
                    try:
                        if refusal is None:
                            child = i.current_scripts(authority, t, result, guard)
                            self.assertIn(child, authority.fds)
                            self.assertTrue(result['mutationAttempted'])
                        else:
                            with self.assertRaisesRegex(i.Rejected, '^SOURCE_INVALID$'):
                                i.current_scripts(authority, t, result, guard)
                            self.assertEqual(result['mutationAttempted'], refusal == 2)
                    finally:
                        authority.close()
                self.assertEqual(opened, set())

    def test_current_scripts_replacement_before_open_rejected_without_mutation(self):
        path = self.current / 'scripts'; path.chmod(0o777)
        saved = self.current / 'synthetic-scripts-original'
        authority = t.Authority()
        original_open = os.open
        swapped = [False]
        def opening(name, *args, **kwargs):
            if name == 'scripts' and kwargs.get('dir_fd') == authority.current_fd and not swapped[0]:
                swapped[0] = True; path.rename(saved); path.mkdir(mode=0o777); path.chmod(0o777)
            return original_open(name, *args, **kwargs)
        result = i.empty_result(self.binding)
        try:
            with patch.object(os, 'open', opening), patch.object(os, 'fchmod', side_effect=AssertionError('identity changed')):
                with self.assertRaisesRegex(i.Rejected, '^CURRENT_SCRIPTS_ANCESTOR_CURRENT_RELEASE_IDENTITY$'):
                    i.current_scripts(authority, t, result, lambda: self.fail('not reached'))
            self.assertFalse(result['mutationAttempted'])
            self.assertEqual(stat.S_IMODE(saved.stat().st_mode), 0o777)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o777)
        finally:
            authority.close()

    def test_current_scripts_namespace_replacement_during_guard_is_never_followed(self):
        path = self.current / 'scripts'
        for phase in (2, 3):
            with self.subTest(phase=phase):
                path.chmod(0o777)
                saved = self.current / 'synthetic-scripts-original'
                source_calls = [0]
                def source():
                    source_calls[0] += 1
                    if source_calls[0] == phase:
                        path.rename(saved); path.mkdir(mode=0o777); path.chmod(0o777)
                self.source_hook = source
                value = self.run_install()
                self.source_hook = None
                self.assertEqual(value['code'], 'CURRENT_SCRIPTS_ANCESTOR_CURRENT_RELEASE_IDENTITY')
                self.assertEqual(value['mutationAttempted'], phase == 3)
                self.assertEqual(value['status'], 'FAILED_MUTATED_UNVERIFIED' if phase == 3 else 'FAILED')
                self.assertEqual(stat.S_IMODE(saved.stat().st_mode), 0o755 if phase == 3 else 0o777)
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o777)
                self.assertFalse(self.destination.exists())
                path.rmdir(); saved.rename(path)
                self.assert_original()

    def test_current_scripts_current_source_and_services_guards_before_and_after_chmod(self):
        path = self.current / 'scripts'
        other = self.base / 'releases' / ('20261011T000001Z-' + i.BASELINE[:12])
        other.mkdir(mode=0o700)
        for change in ('current', 'source', 'services', 'owner'):
            for phase in (2, 3):
                with self.subTest(change=change, phase=phase):
                    path.chmod(0o777)
                    self.snapshot_calls = 0
                    source_calls = [0]
                    def source():
                        source_calls[0] += 1
                        if source_calls[0] == phase:
                            if change == 'current':
                                (self.base / 'current').unlink(); (self.base / 'current').symlink_to(other)
                            elif change == 'source': raise i.Rejected('SOURCE_INVALID')
                            elif change == 'owner':
                                row = path.stat(); self.wrong_owners.add((row.st_dev, row.st_ino))
                    self.source_hook = source
                    self.snapshot_hook = lambda count: ('b' if change == 'services' and count == phase else 'a') * 64
                    value = self.run_install()
                    expected = {'current': 'AUTHORITY_RECHECK_AUTHORITY_CHANGED', 'source': 'SOURCE_INVALID',
                                'services': 'SERVICES_CHANGED', 'owner': 'CURRENT_SCRIPTS_ANCESTOR_CURRENT_RELEASE_IDENTITY'}[change]
                    self.assertEqual(value['code'], expected)
                    self.assertEqual(value['mutationAttempted'], phase == 3)
                    self.assertEqual(value['status'], 'FAILED_MUTATED_UNVERIFIED' if phase == 3 else 'FAILED')
                    self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o755 if phase == 3 else 0o777)
                    self.assertFalse(self.destination.exists())
                    self.assertEqual(self.timer, 'active')
                    self.source_hook = self.snapshot_hook = None
                    self.wrong_owners.clear()
                    (self.base / 'current').unlink(); (self.base / 'current').symlink_to(self.current)
                    self.assert_original()

    def test_current_scripts_fchmod_failure_is_unverified_and_suppresses_raw_error(self):
        path = self.current / 'scripts'; path.chmod(0o777)
        with patch.object(os, 'fchmod', side_effect=PermissionError(i.errno.EACCES, 'SYNTHETIC_SECRET_PATH')):
            value = self.run_install()
        self.assertEqual(value['code'], 'CURRENT_SCRIPTS_ACCESS_DENIED')
        self.assertEqual(value['status'], 'FAILED_MUTATED_UNVERIFIED')
        self.assertTrue(value['mutationAttempted'])
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o777)
        self.assertFalse(self.destination.exists())
        self.assertNotIn('SYNTHETIC_SECRET_PATH', i.canonical(value).decode())
        self.assertEqual(self.timer, 'active')

    def test_current_scripts_following_leaf_writable_refusal_is_not_repaired(self):
        path = self.current / 'scripts'
        original_chmod = os.fchmod
        for leaf, stage in (('backup-aws-mysql.sh', 'BACKUP_SCRIPT'), ('mysql-dump-restore-normalizer.sed', 'NORMALIZER')):
            with self.subTest(leaf=leaf):
                path.chmod(0o777); target = path / leaf; target.chmod(0o622)
                changes = []
                def chmod(fd, mode):
                    changes.append((os.fstat(fd).st_ino, mode)); return original_chmod(fd, mode)
                with patch.object(os, 'fchmod', chmod):
                    value = self.run_install()
                self.assertEqual(value['code'], stage + '_SOURCE_WRITABLE')
                self.assertEqual(value['status'], 'FAILED_MUTATED_UNVERIFIED')
                self.assertEqual(changes, [(path.stat().st_ino, 0o755)])
                self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o622)
                self.assertFalse(self.destination.exists())
                target.chmod(0o600)
                self.assert_original()

    def test_current_scripts_budget_exhaustion_prevents_chmod(self):
        path = self.current / 'scripts'; path.chmod(0o777)
        with patch.object(os, 'fchmod', side_effect=AssertionError('budget expired')):
            value = self.run_install(clock=lambda: 760, deadline=760)
        self.assertEqual(value['code'], 'SERVICE_BUSY')
        self.assertFalse(value['mutationAttempted'])
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o777)
        self.assertEqual(self.timer, 'active')

    def test_current_scripts_repaired_directory_is_tracked_by_original_authority(self):
        path = self.current / 'scripts'; path.chmod(0o777)
        authority = t.Authority()
        result = i.empty_result(self.binding)
        try:
            child = i.current_scripts(authority, t, result, authority.check)
            self.assertTrue(any(row[2] == child for row in authority.directories))
            authority.check()
            path.chmod(0o777)
            with self.assertRaisesRegex(t.Rejected, '^AUTHORITY_CHANGED$'):
                authority.check()
        finally:
            authority.close()


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.binding = binding({'backup-aws-mysql.sh': b'synthetic shell', 'backup-retention-protection.py': b'synthetic helper'})

    def test_payload_under_ssm_20k_and_source21_exact(self):
        payload, value = i.parameters(PRODUCER)
        self.assertLess(len(i.canonical(payload)), 20480)
        self.assertEqual(set(value['controllerPins']), set(i.CONTROLLERS))
        self.assertEqual(set(value['packagePins']), set(i.PACKAGE_FILES))
        self.assertEqual(len(value['controllerPins']) + len(value['packagePins']), 21)
        i.binding_validate(value)
        # Decode fixed public source only, never execute the generated carrier.
        boot = ast.parse(shlex.split(payload['commands'][-1])[-1])
        encoded = next(n.args[0].value for n in ast.walk(boot)
                       if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == 'b85decode')
        body = gzip.decompress(base64.b85decode(encoded))
        ast.parse(body)
        self.assertIn(repr(value['packagePins']).encode(), body)
        self.assertNotIn(b'def _store_files', body)

    def test_source21_binding_unknown_or_changed_pin_rejected(self):
        for change in ('unknown', 'changed', 'missing'):
            value = copy.deepcopy(self.binding)
            if change == 'unknown': value['packagePins']['unknown.py'] = 'a' * 64
            elif change == 'changed': value['packagePins']['driver.py'] = 'b' * 64
            else: del value['controllerPins']['remote-deploy.py']
            with self.subTest(change=change), self.assertRaises(i.Rejected):
                i.binding_validate(value)

    def test_result_closed_fields_types_and_failed_semantics(self):
        valid = i.empty_result(self.binding)
        i.validate_result(valid, self.binding)
        for name, replacement in [('extra', 'synthetic raw'), ('producer', {**PRODUCER, 'token': 'synthetic'}),
                                  ('mutationAttempted', 1), ('status', 'UNKNOWN'), ('code', 'OK'),
                                  ('rawOutputSuppressed', False), ('servicesBeforeSha256', 'raw')]:
            value = copy.deepcopy(valid); value[name] = replacement
            with self.subTest(name=name), self.assertRaises(i.Rejected):
                i.validate_result(value, self.binding)

    def test_result_string_subclasses_rejected(self):
        class Text(str): pass
        for name in ('kind', 'status', 'code', 'source21Sha256', 'maintenanceSourceSha256', 'servicesBeforeSha256'):
            value = i.empty_result(self.binding); value[name] = Text(value[name])
            with self.subTest(name=name), self.assertRaises(i.Rejected):
                i.validate_result(value, self.binding)

    def test_plan_is_no_apply_and_closed(self):
        values = []
        for key, item in [('token', 'synthetic'), ('removedCount', 1), ('countAfter', 2),
                          ('status', 'APPLIED'), ('candidateCount', True), ('rawOutputSuppressed', False)]:
            value = plan(); value[key] = item; values.append(value)
        values.append('{"kind":"MYSQL_BACKUP_RETENTION_V1","kind":"MYSQL_BACKUP_RETENTION_V1"}')
        for value in values:
            output = value if type(value) is str else i.canonical(value).decode()
            with patch.object(i, 'native', return_value=output), self.subTest(output=output), self.assertRaises(i.Rejected):
                i.references_plan(Path('/synthetic/helper.py'), ('48', '1073741824'))

    def test_retention_limits_match_original_defaults_and_exact_env_keys(self):
        self.assertEqual(i.retention_limits(b'UNRELATED_SECRET=synthetic\n'), ('48', '1073741824'))
        self.assertEqual(i.retention_limits(b'MYSQL_BACKUP_LOCAL_RETENTION_COUNT=3\nMYSQL_BACKUP_LOCAL_MAX_BYTES=67108864\n'), ('3', '67108864'))
        for raw in [b'MYSQL_BACKUP_LOCAL_RETENTION_COUNT=1\n', b'MYSQL_BACKUP_LOCAL_MAX_BYTES=10\n',
                    b'MYSQL_BACKUP_LOCAL_RETENTION_COUNT=3\nMYSQL_BACKUP_LOCAL_RETENTION_COUNT=4\n']:
            with self.subTest(raw=raw), self.assertRaises(i.Rejected):
                i.retention_limits(raw)

    def test_selection_fixed_main_operation_and_old_current(self):
        env = {'RELEASE_OPERATION': i.OPERATION, 'EXPECTED_CURRENT': i.BASELINE, 'GITHUB_REF': 'refs/heads/main',
               'RELEASE_COMMIT': PRODUCER['commit'], 'SOURCE_TREE': PRODUCER['sourceTree'],
               'GITHUB_RUN_ID': PRODUCER['workflowRunId'], 'GITHUB_RUN_ATTEMPT': PRODUCER['workflowRunAttempt']}
        self.assertEqual(i.selection(env), PRODUCER)
        for key, value in [('EXPECTED_CURRENT', 'f' * 40), ('GITHUB_REF', 'refs/heads/fixture'),
                           ('RELEASE_OPERATION', 'verify_api_workspace'), ('REUSE_IMAGE_RUN', '123')]:
            with self.subTest(key=key), self.assertRaises(i.Rejected):
                i.selection({**env, key: value})


if __name__ == '__main__':
    unittest.main()
