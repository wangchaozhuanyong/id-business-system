import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import traceback
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
RUNTIME = HERE.parent.parent / '.runtime/online-recharge-release-20261009/build/runtime-identity-controller-tests'
RUNTIME.mkdir(parents=True, exist_ok=True)
spec = importlib.util.spec_from_file_location('runtime_identity', HERE / 'online-recharge-daemon-identity.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SENTINEL = 'LOCAL_SYNTHETIC_PRIVATE_VALUE_MUST_NOT_ESCAPE'


class SandboxReader(m._Reader):
    def _open_kernel_executable(self, parent, leaf):
        # Only emulate the kernel's proc link resolution, after the production
        # reader has checked the actual sandbox link spelling/ownership.
        return os.open(str(Path(self.root) / 'usr/bin/dockerd'), os.O_RDONLY | os.O_CLOEXEC)


class Controller:
    def __init__(self, case):
        self.case = case
        self.calls = []
        self.actions = {}
        self.systemctl_count = 0
        self.rpm_count = 0
        self.pid = 321
        self.package_override = None

    def run(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if args == m.SYSTEMCTL:
            self.systemctl_count += 1
            self.actions.get(('systemctl', self.systemctl_count), lambda: None)()
            return 'ActiveState=active\nSubState=running\nMainPID=' + str(self.pid)
        if args == m.RPM:
            self.rpm_count += 1
            self.actions.get(('rpm', self.rpm_count), lambda: None)()
            if self.package_override is not None:
                return self.package_override
            digest = hashlib.sha256(self.case.binary.read_bytes()).hexdigest()
            return ('docker|0|25.0.16|1.amzn2023.0.1|x86_64|docker-25.0.16-1.amzn2023.0.1.src.rpm|8\n'
                    '/usr/bin/dockerd|' + digest + '\n/usr/bin/nonsecret-other-file|\n')
        raise AssertionError('Unapproved command attempted')


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sandbox-', dir=RUNTIME)
        self.root = Path(self.temp.name)
        for part in ('usr/bin', 'etc/docker', 'proc/321'):
            (self.root / part).mkdir(parents=True, exist_ok=True)
        self.binary = self.root / 'usr/bin/dockerd'
        self.binary.write_bytes(b'\x7fELF' + b'LOCAL_BINARY_FIXTURE' * 50)
        self.binary.chmod(0o755)
        for tool in ('systemctl', 'rpm'):
            path = self.root / 'usr/bin' / tool
            path.write_bytes(b'\x7fELFLOCAL_TOOL_FIXTURE_' + tool.encode())
            path.chmod(0o755)
        self.status = self.root / 'proc/321/status'
        self.status.write_text('Name:\tdockerd\nUid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\n')
        self.stat = self.root / 'proc/321/stat'
        self.set_starttime(100)
        self.cmdline = self.root / 'proc/321/cmdline'
        self.set_args([m.EXECUTABLE, '-H', 'fd://', '--containerd=/run/containerd/containerd.sock'])
        self.exe = self.root / 'proc/321/exe'
        self.exe.symlink_to(m.EXECUTABLE)
        self.config = self.root / 'etc/docker/daemon.json'
        self.config.write_text(json.dumps({'proxies': {'http-proxy': SENTINEL}}))
        self.config.chmod(0o600)
        self.controller = Controller(self)
        self.reader = SandboxReader(str(self.root))
        self.factory = patch.object(m, '_reader_factory', return_value=self.reader)
        self.owner = patch.object(m, '_root_owned', side_effect=lambda value: value.st_uid == os.getuid())
        self.factory.start()
        self.owner.start()

    def tearDown(self):
        self.owner.stop()
        self.factory.stop()
        self.temp.cleanup()

    def set_starttime(self, value):
        fields = ['S'] + ['0'] * 18 + [str(value)] + ['0'] * 20
        self.stat.write_text('321 (dockerd) ' + ' '.join(fields))

    def set_args(self, args):
        self.cmdline.write_bytes(('\0'.join(args) + '\0').encode())

    def reject(self, code=None):
        with self.assertRaises(m.Rejected) as raised:
            m.runtime_daemon_identity(self.controller)
        self.assertIn(str(raised.exception), m.CODES)
        self.assertNotIn(SENTINEL, str(raised.exception))
        self.assertIsNone(raised.exception.__cause__)
        if code:
            self.assertEqual(str(raised.exception), code)

    def test_nonempty_real_file_fixture_binds_runtime_and_installed_hashes_without_authority(self):
        report = m.runtime_daemon_identity(self.controller)
        self.assertEqual(m.validate_runtime_identity(report), report)
        self.assertEqual(report['runtime']['binarySha256'], hashlib.sha256(self.binary.read_bytes()).hexdigest())
        self.assertEqual(report['package']['fileDigest'], report['runtime']['binarySha256'])
        self.assertEqual(report['runtime']['installedBinding'], 'SAME_INODE_AND_SHA256')
        for key in ('authority', 'productionEligible', 'proofConstructed'):
            self.assertIs(report[key], False)
        self.assertNotIn(SENTINEL, json.dumps(report))
        self.assertEqual(self.controller.systemctl_count, 4)
        self.assertEqual(self.controller.rpm_count, 2)

    def test_only_fixed_readonly_commands_and_no_environ_or_docker_reads(self):
        reads = []
        original = self.reader.read
        def track(path, *args, **kwargs):
            reads.append(path)
            return original(path, *args, **kwargs)
        with patch.object(self.reader, 'read', side_effect=track):
            m.runtime_daemon_identity(self.controller)
        self.assertTrue(reads)
        self.assertFalse(any('environ' in path for path in reads))
        self.assertTrue(all(args in (m.SYSTEMCTL, m.RPM) and kwargs == {'timeout': 30, 'env': m.COLLECTION_ENV}
                            for args, kwargs in self.controller.calls))

    def test_command_collection_ignores_proxy_preload_rpm_and_dbus_shell_overrides(self):
        with patch.dict(os.environ, {'LD_PRELOAD': SENTINEL, 'RPM_CONFIGDIR': SENTINEL,
                                     'DBUS_SYSTEM_BUS_ADDRESS': SENTINEL, 'PATH': SENTINEL}):
            m.runtime_daemon_identity(self.controller)
        for _, options in self.controller.calls:
            self.assertEqual(options['env'], m.COLLECTION_ENV)
            self.assertNotIn(SENTINEL, json.dumps(options))

    def test_collection_tool_leaf_symlink_or_writable_binary_rejected(self):
        tool = self.root / 'usr/bin/rpm'
        tool.chmod(0o777)
        self.reject('PERMISSIONS_INVALID')
        tool.chmod(0o755)
        original = tool.with_name('alternate-rpm')
        tool.rename(original)
        tool.symlink_to(original)
        self.reject()

    def test_collection_tool_replaced_between_observations_rejected(self):
        def replace():
            tool = self.root / 'usr/bin/rpm'
            tool.write_bytes(b'\x7fELFLOCAL_DIFFERENT_TOOL')
        self.controller.actions[('systemctl', 2)] = replace
        self.reject('RUNTIME_DRIFT')

    def test_real_binary_changes_while_descriptor_read_is_rejected(self):
        original_read = m.os.read
        changed = False
        inode = self.binary.stat().st_ino
        def read(fd, size):
            nonlocal changed
            block = original_read(fd, size)
            if not changed and os.fstat(fd).st_ino == inode and block:
                changed = True
                self.binary.write_bytes(b'\x7fELF' + b'X' * (self.binary.stat().st_size - 4))
            return block
        with patch.object(m.os, 'read', side_effect=read):
            self.reject('RUNTIME_DRIFT')
        self.assertTrue(changed)

    def test_atomic_path_replacement_during_descriptor_read_rejected_even_same_bytes(self):
        original_read = m.os.read
        changed = False
        inode = self.binary.stat().st_ino
        def read(fd, size):
            nonlocal changed
            block = original_read(fd, size)
            if not changed and os.fstat(fd).st_ino == inode and block:
                changed = True
                alternate = self.binary.with_name('replacement')
                alternate.write_bytes(self.binary.read_bytes())
                alternate.chmod(0o755)
                os.replace(alternate, self.binary)
            return block
        with patch.object(m.os, 'read', side_effect=read):
            self.reject('RUNTIME_DRIFT')
        self.assertTrue(changed)

    def test_kernel_proc_exe_symlink_is_allowed_only_at_literal_leaf(self):
        self.assertTrue(self.exe.is_symlink())
        self.assertEqual(m.runtime_daemon_identity(self.controller)['status'], 'RUNTIME_BOUND')

    def test_unknown_proc_exe_target_rejected(self):
        self.exe.unlink()
        self.exe.symlink_to('/usr/local/bin/dockerd')
        self.reject('EXECUTABLE_INVALID')

    def test_deleted_proc_exe_target_rejected(self):
        self.exe.unlink()
        self.exe.symlink_to(m.EXECUTABLE + ' (deleted)')
        self.reject('EXECUTABLE_INVALID')

    def test_non_symlink_proc_exe_rejected(self):
        self.exe.unlink()
        self.exe.write_bytes(self.binary.read_bytes())
        self.reject('EXECUTABLE_INVALID')

    def test_installed_leaf_symlink_rejected(self):
        alternate = self.binary.with_name('alternate')
        self.binary.rename(alternate)
        self.binary.symlink_to(alternate)
        self.reject()

    def test_installed_ancestor_symlink_rejected(self):
        original = self.root / 'usr'
        alternate = self.root / 'alternate-usr'
        original.rename(alternate)
        original.symlink_to(alternate, target_is_directory=True)
        self.reject()

    def test_config_leaf_symlink_rejected(self):
        alternate = self.config.with_name('other.json')
        self.config.rename(alternate)
        self.config.symlink_to(alternate)
        self.reject()

    def test_config_ancestor_symlink_rejected(self):
        original = self.root / 'etc/docker'
        alternate = self.root / 'alternate-config'
        original.rename(alternate)
        original.symlink_to(alternate, target_is_directory=True)
        # Linux symlink mode 0777 rejects at the permission check; platforms
        # with a stricter link mode reach the directory-type check instead.
        with patch.object(self.reader, 'read', wraps=self.reader.read) as read:
            self.reject()
        self.assertNotIn(m.CONFIG, [call.args[0] for call in read.call_args_list])

    def test_proc_directory_symlink_rejected(self):
        original = self.root / 'proc/321'
        alternate = self.root / 'alternate-proc'
        original.rename(alternate)
        original.symlink_to(alternate, target_is_directory=True)
        self.reject()

    def test_nonroot_file_ownership_rejected(self):
        with patch.object(m, '_root_owned', return_value=False):
            self.reject('PERMISSIONS_INVALID')

    def test_nonroot_process_real_effective_saved_or_fs_uid_rejected(self):
        for position in range(4):
            uids = ['0'] * 4
            uids[position] = '1000'
            self.status.write_text('Name:\tdockerd\nUid:\t' + '\t'.join(uids) + '\n')
            self.reject('PROCESS_INVALID')

    def test_group_or_world_writable_real_binary_permission_rejected(self):
        for mode in (0o775, 0o757, 0o777):
            self.binary.chmod(mode)
            self.reject('PERMISSIONS_INVALID')

    def test_group_or_world_writable_real_config_permission_rejected(self):
        for mode in (0o620, 0o602):
            self.config.chmod(mode)
            self.reject('PERMISSIONS_INVALID')

    def test_group_or_world_writable_ancestor_permission_rejected(self):
        (self.root / 'usr').chmod(0o777)
        self.reject('PERMISSIONS_INVALID')

    def test_setuid_and_nonexecutable_binary_rejected(self):
        for mode in (0o4755, 0o644):
            self.binary.chmod(mode)
            self.reject('EXECUTABLE_INVALID')

    def test_hardlinked_installed_binary_rejected(self):
        os.link(self.binary, self.binary.with_name('hardlink'))
        self.reject('PATH_INVALID')

    def test_nonelf_binary_rejected(self):
        self.binary.write_bytes(b'#!' + b'NOT_REAL_ELF')
        self.reject('EXECUTABLE_INVALID')

    def test_same_size_real_binary_mutation_between_observations_rejected(self):
        def mutate():
            self.binary.write_bytes(b'\x7fELF' + b'X' * (self.binary.stat().st_size - 4))
        self.controller.actions[('systemctl', 3)] = mutate
        self.reject('RUNTIME_DRIFT')

    def test_atomic_same_bytes_binary_replacement_rejected(self):
        def replace():
            candidate = self.binary.with_name('replacement')
            candidate.write_bytes(self.binary.read_bytes())
            candidate.chmod(0o755)
            os.replace(candidate, self.binary)
        self.controller.actions[('systemctl', 3)] = replace
        self.reject('RUNTIME_DRIFT')

    def test_running_executable_inode_differs_from_installed_rejected(self):
        alternate = self.binary.with_name('old-runtime')
        alternate.write_bytes(self.binary.read_bytes())
        alternate.chmod(0o755)
        with patch.object(self.reader, '_open_kernel_executable', side_effect=lambda *args: os.open(alternate, os.O_RDONLY)):
            self.reject('EXECUTABLE_INVALID')

    def test_pid_switch_during_sample_rejected(self):
        self.controller.actions[('systemctl', 2)] = lambda: setattr(self.controller, 'pid', 322)
        self.reject('RUNTIME_DRIFT')

    def test_same_pid_new_starttime_between_samples_rejected(self):
        self.controller.actions[('systemctl', 3)] = lambda: self.set_starttime(101)
        self.reject('RUNTIME_DRIFT')

    def test_cpu_counters_may_change_without_altering_authority_fields(self):
        def counters():
            fields = ['S'] + ['7'] * 18 + ['100'] + ['8'] * 20
            self.stat.write_text('321 (dockerd) ' + ' '.join(fields))
        self.controller.actions[('rpm', 1)] = counters
        self.assertEqual(m.runtime_daemon_identity(self.controller)['status'], 'RUNTIME_BOUND')

    def test_dead_zombie_or_wrong_comm_process_rejected(self):
        self.stat.write_text(self.stat.read_text().replace('(dockerd)', '(other)'))
        self.reject('PROCESS_INVALID')
        self.set_starttime(100)
        self.stat.write_text(self.stat.read_text().replace(') S ', ') Z '))
        self.reject('PROCESS_INVALID')

    def test_config_bytes_drift_with_synthetic_secret_is_suppressed(self):
        self.controller.actions[('systemctl', 3)] = lambda: self.config.write_text(json.dumps({'secret': SENTINEL, 'x': 1}))
        self.reject('RUNTIME_DRIFT')

    def test_config_atomic_same_bytes_replacement_rejected(self):
        def replace():
            alternate = self.config.with_name('replacement')
            alternate.write_bytes(self.config.read_bytes())
            alternate.chmod(0o600)
            os.replace(alternate, self.config)
        self.controller.actions[('systemctl', 3)] = replace
        self.reject('RUNTIME_DRIFT')

    def test_implicit_absent_default_file_remains_source_not_measured(self):
        self.config.unlink()
        report = m.runtime_daemon_identity(self.controller)
        self.assertEqual(report['configuration']['status'], 'ABSENT')
        self.assertEqual(report['effectivePoolRulesStatus'], 'SOURCE_NOT_MEASURED')

    def test_absent_config_directory_is_observed_without_following_unknown_path(self):
        self.config.unlink()
        self.config.parent.rmdir()
        self.assertEqual(m.runtime_daemon_identity(self.controller)['configuration']['status'], 'ABSENT')

    def test_absent_config_created_between_samples_rejected(self):
        self.config.unlink()
        self.controller.actions[('systemctl', 3)] = lambda: self.config.write_text('{}')
        self.reject('RUNTIME_DRIFT')

    def test_explicit_fixed_config_equals_and_split_forms_supported(self):
        for flags in (['--config-file=' + m.CONFIG], ['--config-file', m.CONFIG]):
            self.set_args([m.EXECUTABLE] + flags)
            self.assertEqual(m.runtime_daemon_identity(self.controller)['cmdline']['configFileEncoding'], 'EXPLICIT_FIXED')

    def test_explicit_missing_config_cannot_be_treated_as_default(self):
        self.config.unlink()
        self.set_args([m.EXECUTABLE, '--config-file=' + m.CONFIG])
        self.reject('CONFIG_INVALID')

    def test_unknown_config_path_duplicates_or_empty_value_rejected_without_leak(self):
        for flags in (['--config-file=' + SENTINEL], ['--config-file'], ['--config-file='],
                      ['--config-file=' + m.CONFIG, '--config-file=' + m.CONFIG], ['--config-file-secret=' + SENTINEL]):
            self.set_args([m.EXECUTABLE] + flags)
            self.reject('CMDLINE_INVALID')

    def test_unknown_flags_and_private_values_are_never_exposed(self):
        self.set_args([m.EXECUTABLE, '--unknown=' + SENTINEL, '--tlskey=' + SENTINEL])
        self.assertNotIn(SENTINEL, json.dumps(m.runtime_daemon_identity(self.controller)))

    def test_valid_pool_flags_and_config_are_only_counts_and_hashes_not_effective_rules(self):
        self.set_args([m.EXECUTABLE, '--default-address-pool=base=10.64.0.0/16,size=24',
                       '--default-address-pool', 'base=fd00::/48,size=64'])
        self.config.write_text(json.dumps({'default-address-pools': [{'base': '10.128.0.0/16', 'size': 24}], 'secret': SENTINEL}))
        report = m.runtime_daemon_identity(self.controller)
        self.assertEqual(report['cmdline']['defaultAddressPoolCount'], 2)
        self.assertEqual(report['configuration']['defaultAddressPoolCount'], 1)
        self.assertNotIn('10.64', json.dumps(report))
        self.assertNotIn('10.128', json.dumps(report))
        self.assertEqual(report['effectivePoolRulesStatus'], 'SOURCE_NOT_MEASURED')

    def test_invalid_pool_flag_shape_size_or_duplicate_rejected(self):
        for flags in (['--default-address-pool=' + SENTINEL], ['--default-address-pool'],
                      ['--default-address-pool=base=10.1.1.1/16,size=24'],
                      ['--default-address-pool=base=10.0.0.0/16,size=15'],
                      ['--default-address-pool=base=10.0.0.0/16,size=24,secret=' + SENTINEL],
                      ['--default-address-pool=base=10.0.0.0/16,size=24'] * 2):
            self.set_args([m.EXECUTABLE] + flags)
            self.reject('CMDLINE_INVALID')

    def test_duplicate_json_keys_even_unknown_nested_secret_fields_rejected(self):
        self.config.write_text('{"secret":{"k":"' + SENTINEL + '","k":1}}')
        self.reject('CONFIG_INVALID')

    def test_invalid_config_pool_null_bool_unknown_keys_and_noncanonical_base_rejected(self):
        for rows in (None, False, [{'base': '10.0.0.0/16', 'size': True}],
                     [{'base': '10.0.0.0/16', 'size': 24, 'secret': SENTINEL}],
                     [{'base': '10.0.0.1/16', 'size': 24}], [{'base': '10.0.0.0/16', 'size': 33}]):
            self.config.write_text(json.dumps({'default-address-pools': rows}))
            self.reject('CONFIG_INVALID')

    def test_invalid_json_nonobject_nan_and_oversize_rejected(self):
        for raw in ('[]', '{"x":NaN}', SENTINEL, '{"x":"' + 'a' * 1024**2 + '"}'):
            self.config.write_text(raw)
            self.reject()

    def test_cmdline_missing_nul_wrong_argv0_oversize_or_empty_argument_rejected(self):
        for raw in (m.EXECUTABLE.encode(), b'/unknown\0', m.EXECUTABLE.encode() + b'\0\0', b'a' * (128 * 1024 + 1)):
            self.cmdline.write_bytes(raw)
            self.reject()

    def test_systemctl_malicious_unknown_duplicate_inactive_or_zero_pid_rejected(self):
        for raw in ('MainPID=0\nActiveState=active\nSubState=running',
                    'MainPID=321\nMainPID=321\nActiveState=active\nSubState=running',
                    'MainPID=321\nActiveState=inactive\nSubState=dead',
                    'MainPID=321\nActiveState=active\nSubState=running\nSecret=' + SENTINEL):
            with patch.object(self.controller, 'run', return_value=raw):
                self.reject('SERVICE_INVALID')

    def test_package_digest_changed_even_matching_filename_rejected(self):
        original = self.controller.run(*m.RPM)
        self.controller.package_override = original.replace(hashlib.sha256(self.binary.read_bytes()).hexdigest(), 'a' * 64)
        self.reject('PACKAGE_BINARY_MISMATCH')

    def test_package_name_or_source_rpm_correlation_unknown_rejected(self):
        original = self.controller.run(*m.RPM)
        for raw in (original.replace('docker|', 'other|', 1),
                    original.replace('docker-25.0.16-1.amzn2023.0.1.src.rpm', SENTINEL)):
            self.controller.package_override = raw
            self.reject('PACKAGE_INVALID')

    def test_md5_package_algorithm_is_not_misrepresented_as_sha256(self):
        self.controller.package_override = self.controller.run(*m.RPM).replace('.src.rpm|8', '.src.rpm|1')
        self.reject('PACKAGE_DIGEST_UNSUPPORTED')

    def test_package_duplicate_filename_or_no_corresponding_file_rejected(self):
        original = self.controller.run(*m.RPM)
        for raw in (original + '\n/usr/bin/dockerd|' + hashlib.sha256(self.binary.read_bytes()).hexdigest(),
                    original.replace('/usr/bin/dockerd|', '/unknown|')):
            self.controller.package_override = raw
            self.reject('PACKAGE_INVALID')

    def test_package_metadata_drift_with_identical_binary_rejected(self):
        original = self.controller.run(*m.RPM)
        def change():
            self.controller.package_override = original.replace('1.amzn2023.0.1', '2.amzn2023.0.1')
        self.controller.actions[('rpm', 3)] = change  # first call above is count 1
        self.reject('RUNTIME_DRIFT')

    def test_subprocess_or_filesystem_exception_text_is_suppressed(self):
        with patch.object(self.controller, 'run', side_effect=RuntimeError(SENTINEL)):
            self.reject('RUNTIME_UNAVAILABLE')
        with patch.object(self.reader, 'read', side_effect=OSError(SENTINEL)):
            self.reject('RUNTIME_UNAVAILABLE')

    def test_dynamic_rejected_code_or_attached_private_exception_context_is_suppressed(self):
        for code in (SENTINEL, 'PROCESS_INVALID'):
            def failure(*args, **kwargs):
                try:
                    raise RuntimeError(SENTINEL)
                except RuntimeError:
                    raise m.Rejected(code)
            with patch.object(self.controller, 'run', side_effect=failure):
                with self.assertRaises(m.Rejected) as raised:
                    m.runtime_daemon_identity(self.controller)
                error = raised.exception
                self.assertEqual(str(error), code if code in m.CODES else 'RUNTIME_UNAVAILABLE')
                self.assertTrue(error.__suppress_context__)
                rendered = ''.join(traceback.format_exception(type(error), error, error.__traceback__))
                self.assertNotIn(SENTINEL, rendered)

    def test_fifo_config_is_rejected_without_blocking_or_reading_data(self):
        self.config.unlink()
        os.mkfifo(self.config, 0o600)
        self.reject('PATH_INVALID')

    def test_cmdline_changes_between_samples_rejected(self):
        self.controller.actions[('systemctl', 3)] = lambda: self.set_args([m.EXECUTABLE, '--unknown=' + SENTINEL])
        self.reject('RUNTIME_DRIFT')

    def test_proc_exe_link_replacement_during_runtime_hash_read_rejected(self):
        original_read = m.os.read
        binary_inode = self.binary.stat().st_ino
        binary_opens = 0
        changed = False
        def read(fd, size):
            nonlocal binary_opens, changed
            block = original_read(fd, size)
            if block and os.fstat(fd).st_ino == binary_inode:
                binary_opens += 1
                if binary_opens == 2:
                    self.exe.unlink()
                    self.exe.symlink_to(m.EXECUTABLE)
                    changed = True
            return block
        with patch.object(m.os, 'read', side_effect=read):
            self.reject('RUNTIME_DRIFT')
        self.assertTrue(changed)

    def test_report_unknown_field_hash_or_true_authority_rejected(self):
        original = m.runtime_daemon_identity(self.controller)
        mutations = (
            lambda r: r.update({'unknown': SENTINEL}),
            lambda r: r.update({'authority': True}),
            lambda r: r['runtime'].update({'binarySha256': SENTINEL}),
            lambda r: r['package'].update({'fileDigest': 'a' * 64}),
            lambda r: r['configuration'].update({'defaultAddressPoolCount': True}),
            lambda r: r['package'].update({'sourceRpmRetrieved': True}),
            lambda r: r.update({'effectivePoolRulesStatus': 'APPROVED'}),
        )
        for mutation in mutations:
            report = copy.deepcopy(original)
            mutation(report)
            with self.assertRaisesRegex(m.Rejected, '^REPORT_INVALID$'):
                m.validate_runtime_identity(report)




class ProcNetPathSealTests(unittest.TestCase):
    fields=('st_dev','st_ino','st_mode','st_uid','st_gid','st_size','st_mtime_ns','st_ctime_ns','st_nlink')
    def setUp(self):
        target=RUNTIME.parent/'proc-net-unix-reader-fix-0ecd2359'/'fixtures'
        target.mkdir(parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(prefix='owned-',dir=target);self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.leaf=self.root/'body'
        self.leaf.write_bytes(b'\x7fELFLOCAL_PROC_NET_FIXTURE');self.leaf.chmod(0o755)
        self.reader=m._Reader()
        sandbox=m._Reader(str(self.root))
        # Map only the private test FD source; production parent/nofollow code
        # still executes unchanged, and no host /proc path is opened.
        item=patch.object(self.reader,'parent',side_effect=lambda path:sandbox.parent('/body'))
        item.start();self.addCleanup(item.stop)
        item=patch.object(m,'_root_owned',side_effect=lambda value:value.st_uid==os.getuid())
        item.start();self.addCleanup(item.stop)
        self.open_flags=[];self.path_checks=0;self.file_fstats=0

    def read(self,path='/proc/321/net/unix',*,root='/',executable=False,path_changes=None,fd_changes=None,limit=1024):
        from types import SimpleNamespace
        original_stat=os.stat;original_fstat=os.fstat;original_open=os.open
        inode=original_stat(self.leaf).st_ino
        self.reader.root=root
        def changed(value,updates):
            attrs={name:getattr(value,name) for name in self.fields}
            attrs.update({name:attrs[name]+delta for name,delta in (updates or {}).items()})
            return SimpleNamespace(**attrs)
        def path_stat(path,*args,**kwargs):
            value=original_stat(path,*args,**kwargs)
            if path=='body' and kwargs.get('follow_symlinks') is False:
                self.path_checks+=1
                return changed(value,path_changes)
            return value
        def fd_stat(fd):
            value=original_fstat(fd)
            if value.st_ino==inode:
                self.file_fstats+=1
                if self.file_fstats==2:return changed(value,fd_changes)
            return value
        def opened(path,flags,*args,**kwargs):
            if path=='body':self.open_flags.append(flags)
            return original_open(path,flags,*args,**kwargs)
        self.open_flags=[];self.path_checks=0;self.file_fstats=0
        with patch.object(m.os,'stat',side_effect=path_stat),patch.object(m.os,'fstat',side_effect=fd_stat),patch.object(m.os,'open',side_effect=opened):
            return self.reader.read(path,limit,executable=executable)

    def reject(self,**kwargs):
        with self.assertRaises(m.Rejected) as caught:self.read(**kwargs)
        self.assertEqual(caught.exception.args,('RUNTIME_DRIFT',))

    def test_strict_default_proc_net_timestamp_only_path_seal_and_nine_field_result(self):
        for changes in ({'st_mtime_ns':1},{'st_ctime_ns':1},{'st_mtime_ns':1,'st_ctime_ns':1}):
            with self.subTest(changedFields=tuple(changes)):
                raw,seal=self.read(path_changes=changes)
                self.assertEqual(raw,self.leaf.read_bytes())
                self.assertEqual(len(seal['file']),9)
                self.assertEqual(seal['file'],m.file_identity(self.leaf.stat()))
                self.assertEqual(self.file_fstats,2);self.assertEqual(self.path_checks,1)
                self.assertEqual(len(self.open_flags),1)
                self.assertTrue(self.open_flags[0]&os.O_NOFOLLOW)
                self.assertTrue(self.open_flags[0]&os.O_NONBLOCK)
                self.assertTrue(self.open_flags[0]&os.O_CLOEXEC)

    def test_strict_proc_net_other_seven_identity_fields_still_reject(self):
        for name in self.fields:
            if name in ('st_mtime_ns','st_ctime_ns'):continue
            with self.subTest(changedField=name):self.reject(path_changes={name:1})

    def test_strict_proc_net_descriptor_timestamp_change_still_rejects_before_path(self):
        for name in ('st_mtime_ns','st_ctime_ns'):
            with self.subTest(changedField=name):
                self.reject(fd_changes={name:1})
                self.assertEqual(self.path_checks,0)

    def test_other_paths_executable_sandbox_and_noncanonical_pid_keep_full_identity(self):
        for path in ('/proc/self/net/unix','/proc/0/net/unix','/proc/0321/net/unix',
                     '/proc/321/net/unix/','/proc/321/net/unix.extra','/proc/321/net/tcp',
                     '/proc/321/status','/usr/bin/systemctl'):
            with self.subTest(pathRole=path):self.reject(path=path,path_changes={'st_mtime_ns':1,'st_ctime_ns':1})
        for root in (str(self.root),'/./',Path('/')):
            with self.subTest(rootType=type(root).__name__):self.reject(root=root,path_changes={'st_mtime_ns':1})
        self.reject(executable=True,path_changes={'st_ctime_ns':1})
        # Nonliteral falsey values do not broaden the fixed-role exception.
        self.reject(executable=0,path_changes={'st_mtime_ns':1})

    def test_strict_proc_net_retains_read_limits_ownership_modes_nlink_and_nofollow(self):
        with self.assertRaises(m.Rejected) as caught:self.read(limit=3)
        self.assertEqual(caught.exception.args,('PATH_INVALID',))
        self.leaf.chmod(0o777)
        with self.assertRaises(m.Rejected) as caught:self.read()
        self.assertEqual(caught.exception.args,('PERMISSIONS_INVALID',));self.leaf.chmod(0o755)
        with patch.object(m,'_root_owned',return_value=False):
            with self.assertRaises(m.Rejected) as caught:self.read()
        self.assertEqual(caught.exception.args,('PERMISSIONS_INVALID',))
        linked=self.root/'hardlink';os.link(self.leaf,linked)
        with self.assertRaises(m.Rejected) as caught:self.read()
        self.assertEqual(caught.exception.args,('PATH_INVALID',));linked.unlink()
        original=self.root/'original';self.leaf.rename(original);self.leaf.symlink_to(original)
        with self.assertRaises(OSError):self.read()
        self.assertTrue(self.open_flags[0]&os.O_NOFOLLOW)

if __name__ == '__main__':
    unittest.main()
