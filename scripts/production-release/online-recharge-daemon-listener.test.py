import copy
import importlib.util
import json
import os
from pathlib import Path
import socket
import stat
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

m = load('socket_binding', HERE / 'online-recharge-daemon-listener.py')
fixtures = load('identity_fixture_helpers', HERE / 'online-recharge-daemon-identity.test.py')
fixtures.RUNTIME = HERE.parent.parent / '.runtime/online-recharge-release-20261009/build/runtime-socket-controller-tests'
fixtures.RUNTIME.mkdir(parents=True, exist_ok=True)
SENTINEL = fixtures.SENTINEL


def bind_node(sock, path):
    # The long project absolute path exceeds AF_UNIX.sun_path. Create the node
    # relative to its already-owned directory, then restore this process's cwd.
    previous = os.open('.', os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.chdir(path.parent)
        sock.bind(path.name)
    finally:
        os.fchdir(previous)
        os.close(previous)


class SocketSandboxReader(fixtures.SandboxReader):
    def _collector_pid(self):
        return 900

    def _follow_run_alias(self, parent, leaf):
        return os.stat(str(Path(self.root) / 'run'))

    def _follow_namespace(self, path):
        return SimpleNamespace(st_ino=777, st_uid=os.getuid())

    def _follow_socket_fd(self, parent, leaf):
        return self.fd_value


class SocketTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.IdentityTests('test_only_fixed_readonly_commands_and_no_environ_or_docker_reads')
        self.case.setUp()
        self.addCleanup(self.case.tearDown)
        self.root = self.case.root
        self.base = fixtures.m
        for directory in ('run', 'var', 'proc/321/ns', 'proc/321/fd', 'proc/900/net', 'proc/900/ns'):
            (self.root / directory).mkdir(parents=True, exist_ok=True)
        self.alias = self.root / 'var/run'
        self.alias.symlink_to('/run', target_is_directory=True)
        self.node = self.root / 'run/docker.sock'
        self.local_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(self.local_socket.close)
        bind_node(self.local_socket, self.node)  # Private filesystem node, never listened/connected.
        self.node.chmod(0o660)
        (self.root / 'proc/net').symlink_to('self/net', target_is_directory=True)
        (self.root / 'proc/self').symlink_to('900', target_is_directory=True)
        for pid in (321, 900):
            (self.root / ('proc/' + str(pid) + '/ns/net')).symlink_to('net:[777]')
        self.table = self.root / 'proc/900/net/unix'
        self.row = '0000000000000000: 00000002 00000000 00010000 0001 01 12345 /run/docker.sock'
        self.set_table([self.row])
        self.fd = self.root / 'proc/321/fd/3'
        self.fd.symlink_to('socket:[12345]')
        self.reader = SocketSandboxReader(str(self.root))
        self.reader.fd_value = SimpleNamespace(st_ino=12345, st_dev=0, st_mode=stat.S_IFSOCK | 0o777,
            st_uid=os.getuid(), st_gid=os.getgid(), st_size=0, st_mtime_ns=0, st_ctime_ns=0, st_nlink=1)
        self.get_base = patch.object(m, '_base', return_value=self.base)
        self.get_reader = patch.object(m, '_reader', return_value=self.reader)
        self.get_base.start()
        self.get_reader.start()

    def tearDown(self):
        self.get_reader.stop()
        self.get_base.stop()

    def set_table(self, rows):
        self.table.write_text('Num RefCount Protocol Flags Type St Inode Path\n' + '\n'.join(rows) + '\n')

    def collect(self):
        return m.runtime_daemon_socket_binding(self.case.controller)

    def reject(self, code=None):
        with self.assertRaises(m.Rejected) as raised:
            self.collect()
        self.assertIn(str(raised.exception), m.CODES)
        self.assertNotIn(SENTINEL, str(raised.exception))
        self.assertTrue(raised.exception.__suppress_context__)
        if code:
            self.assertEqual(str(raised.exception), code)

    def test_nonempty_bound_filesystem_socket_and_kernel_fd_fixture_has_no_authority(self):
        report = self.collect()
        self.assertEqual(m.validate_binding(report), report)
        self.assertEqual(report['daemonListenerFdCount'], 1)
        self.assertEqual(report['listenerRowCount'], 1)
        self.assertEqual(report['unixHost'], m.UNIX_HOST)
        self.assertEqual(report['socketActivationCreatorStatus'], 'NOT_MEASURED')
        self.assertEqual(report['exclusiveAcceptingProcessStatus'], 'NOT_MEASURED')
        for key in ('authority', 'productionEligible', 'proofConstructed'):
            self.assertIs(report[key], False)
        self.assertNotIn(SENTINEL, json.dumps(report))
        self.assertTrue(all(args in (self.base.SYSTEMCTL, self.base.RPM) for args, _ in self.case.controller.calls))

    def test_filesystem_inode_is_not_kernel_socket_inode_and_is_not_directly_equated(self):
        self.assertNotEqual(self.node.stat().st_ino, 12345)
        self.assertEqual(self.collect()['status'], 'LISTENER_HELD_BY_RUNTIME_DAEMON')

    def test_run_parent_alias_relative_exact_variant_is_supported(self):
        self.alias.unlink()
        self.alias.symlink_to('../run', target_is_directory=True)
        self.assertEqual(self.collect()['listenerRowCount'], 1)

    def test_kernel_table_exact_var_run_path_supported(self):
        self.set_table([self.row.replace('/run/docker.sock', '/var/run/docker.sock')])
        self.assertEqual(self.collect()['listenerRowCount'], 1)

    def test_root_group_socket_0660_legitimate_but_world_access_rejected(self):
        for mode in (0o666, 0o664, 0o661, 0o700):
            self.node.chmod(mode)
            self.reject('SOCKET_PERMISSIONS_INVALID')

    def test_nonroot_socket_node_rejected(self):
        inode = self.node.stat().st_ino
        with patch.object(self.base, '_root_owned', side_effect=lambda v: v.st_ino != inode and v.st_uid == os.getuid()):
            self.reject('SOCKET_PERMISSIONS_INVALID')

    def test_leaf_symlink_rejected_without_following_it(self):
        self.node.unlink()
        self.node.symlink_to('/untrusted/' + SENTINEL)
        self.reject('SOCKET_PATH_INVALID')

    def test_regular_file_not_misclassified_as_socket(self):
        self.node.unlink()
        self.node.write_text(SENTINEL)
        self.reject('SOCKET_PATH_INVALID')

    def test_unknown_parent_alias_or_nonlink_alias_rejected(self):
        self.alias.unlink()
        self.alias.symlink_to('/unknown/' + SENTINEL)
        self.reject('SOCKET_PATH_INVALID')
        self.alias.unlink()
        self.alias.mkdir()
        self.reject('SOCKET_PATH_INVALID')

    def test_run_alias_followed_directory_must_match_opened_run_directory(self):
        with patch.object(self.reader, '_follow_run_alias', return_value=self.root.stat()):
            self.reject('SOCKET_PATH_INVALID')

    def test_writable_run_parent_rejected(self):
        self.node.parent.chmod(0o777)
        self.reject('PERMISSIONS_INVALID')

    def test_proc_self_net_alias_unknown_rejected(self):
        path = self.root / 'proc/net'
        path.unlink()
        path.symlink_to('other/net')
        self.reject('PROC_ALIAS_INVALID')

    def test_proc_self_pid_must_be_actual_collector_pid(self):
        path = self.root / 'proc/self'
        path.unlink()
        path.symlink_to('321')
        self.reject('PROC_ALIAS_INVALID')

    def test_different_namespace_label_or_namespace_follow_inode_rejected(self):
        path = self.root / 'proc/321/ns/net'
        path.unlink()
        path.symlink_to('net:[778]')
        self.reject('NAMESPACE_MISMATCH')
        path.unlink()
        path.symlink_to('net:[777]')
        with patch.object(self.reader, '_follow_namespace', return_value=SimpleNamespace(st_ino=778, st_uid=os.getuid())):
            self.reject('NAMESPACE_MISMATCH')

    def test_unknown_namespace_magic_link_rejected(self):
        path = self.root / 'proc/321/ns/net'
        path.unlink()
        path.symlink_to('/unknown/' + SENTINEL)
        self.reject('PROC_ALIAS_INVALID')

    def test_duplicate_listener_same_path_or_both_aliases_rejected(self):
        for rows in ([self.row, self.row], [self.row, self.row.replace('/run/', '/var/run/')]):
            self.set_table(rows)
            self.reject('LISTENER_INVALID')

    def test_nonlistener_row_at_same_path_rejected_even_if_listener_also_exists(self):
        self.set_table([self.row, self.row.replace('00010000', '00000000')])
        self.reject('LISTENER_INVALID')

    def test_unknown_flags_type_state_protocol_inode_or_path_rejected(self):
        for row in (self.row.replace('00010000', '00000000'), self.row.replace('0001 01', '0002 01'),
                    self.row.replace('0001 01', '0001 03'), self.row.replace('12345', '0'),
                    self.row.replace('/run/docker.sock', '/unknown/' + SENTINEL)):
            self.set_table([row])
            self.reject('LISTENER_INVALID')

    def test_unrelated_private_kernel_paths_are_not_exposed_or_treated_as_target(self):
        self.set_table([self.row, '0000000000000000: 00000002 00000000 00010000 0001 01 55555 /private/' + SENTINEL])
        report = self.collect()
        self.assertNotIn(SENTINEL, json.dumps(report))

    def test_daemon_fd_does_not_hold_listener_inode_rejected(self):
        self.fd.unlink()
        self.fd.symlink_to('socket:[55555]')
        self.reject('DAEMON_FD_MISSING')

    def test_deleted_fd_link_or_no_fd_is_not_accepted(self):
        self.fd.unlink()
        self.fd.symlink_to('socket:[12345] (deleted)')
        self.reject('DAEMON_FD_MISSING')
        self.fd.unlink()
        self.reject('DAEMON_FD_MISSING')

    def test_followed_socket_fd_type_inode_and_root_owner_all_required(self):
        original = copy.copy(self.reader.fd_value)
        for key, value in (('st_ino', 55555), ('st_mode', stat.S_IFREG | 0o600), ('st_uid', -1)):
            self.reader.fd_value = copy.copy(original)
            setattr(self.reader.fd_value, key, value)
            self.reject('FD_INVALID')

    def test_fd_directory_symlink_rejected(self):
        directory = self.fd.parent
        alternate = directory.with_name('other-fds')
        directory.rename(alternate)
        directory.symlink_to(alternate, target_is_directory=True)
        self.reject()

    def test_unknown_fd_entry_or_regular_fd_leaf_rejected(self):
        bad = self.fd.parent / SENTINEL
        bad.symlink_to('socket:[12345]')
        self.reject('FD_INVALID')
        bad.unlink()
        self.fd.unlink()
        self.fd.write_text('socket:[12345]')
        self.reject('FD_INVALID')

    def test_multiple_daemon_fds_same_listener_allowed_with_finite_count(self):
        (self.fd.parent / '4').symlink_to('socket:[12345]')
        self.assertEqual(self.collect()['daemonListenerFdCount'], 2)

    def test_systemd_may_also_hold_listener_but_not_replace_runtime_daemon_holder(self):
        directory = self.root / 'proc/1/fd'
        directory.mkdir(parents=True)
        (directory / '3').symlink_to('socket:[12345]')
        self.assertEqual(self.collect()['socketActivationCreatorStatus'], 'NOT_MEASURED')
        self.fd.unlink()
        self.reject('DAEMON_FD_MISSING')

    def test_fixed_runtime_identity_source_pin_is_independently_checked(self):
        self.get_base.stop()
        try:
            self.assertEqual(m._base().EXECUTABLE, self.base.EXECUTABLE)
            with patch.object(m.Path, 'read_bytes', return_value=b'UNMEASURED_SOURCE'):
                self.reject('BASE_SOURCE_UNMEASURED')
        finally:
            self.get_base.start()

    def test_fd_replacement_during_kernel_follow_stat_rejected(self):
        original = self.reader._follow_socket_fd
        def replacement(parent, leaf):
            value = original(parent, leaf)
            self.fd.unlink()
            self.fd.symlink_to('socket:[12345]')
            return value
        with patch.object(self.reader, '_follow_socket_fd', side_effect=replacement):
            self.reject('SOCKET_BINDING_DRIFT')

    def test_socket_inode_hardlink_is_not_an_accepted_path_alias(self):
        os.link(self.node, self.node.with_name('extra-link'))
        self.reject('SOCKET_PATH_INVALID')

    def test_fake_unknown_engineid_input_cannot_satisfy_missing_fd(self):
        self.fd.unlink()
        self.case.controller.engine_id = 'matching-but-not-authority'
        self.reject('DAEMON_FD_MISSING')

    def test_identity_changes_after_socket_observation_rejected(self):
        self.case.controller.actions[('systemctl', 7)] = lambda: self.case.set_starttime(101)
        self.reject('SOCKET_BINDING_DRIFT')

    def test_recreated_filesystem_socket_before_second_observation_rejected(self):
        sockets = []
        def replace():
            self.node.unlink()
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            bind_node(sock, self.node)
            self.node.chmod(0o660)
            sockets.append(sock)
        self.case.controller.actions[('systemctl', 7)] = replace
        try:
            self.reject('SOCKET_BINDING_DRIFT')
        finally:
            for sock in sockets:
                sock.close()

    def test_listener_or_fd_inode_replaced_between_observations_rejected(self):
        def replace():
            self.set_table([self.row.replace('12345', '12346')])
            self.fd.unlink()
            self.fd.symlink_to('socket:[12346]')
            self.reader.fd_value.st_ino = 12346
        self.case.controller.actions[('systemctl', 7)] = replace
        self.reject('SOCKET_BINDING_DRIFT')

    def test_equivalent_refcount_changes_do_not_invent_process_identity_drift(self):
        self.case.controller.actions[('systemctl', 7)] = lambda: self.set_table([self.row.replace('00000002', '00000003')])
        self.assertEqual(self.collect()['listenerRowCount'], 1)

    def test_closed_report_rejects_unknown_keys_bad_hash_host_and_authority(self):
        original = self.collect()
        for mutate in (lambda r: r.update({'authority': True}), lambda r: r.update({'unixHost': 'tcp://remote'}),
                       lambda r: r.update({'unknown': SENTINEL}), lambda r: r.update({'listenerSha256': SENTINEL}),
                       lambda r: r.update({'daemonListenerFdCount': True}),
                       lambda r: r['runtimeIdentity'].update({'proofConstructed': True})):
            value = copy.deepcopy(original)
            mutate(value)
            with self.assertRaises(m.Rejected):
                m.validate_binding(value)

    def test_controlled_client_bracket_rejects_changed_hash_or_runtime_identity(self):
        before = self.collect()
        self.assertEqual(m.assert_same_binding(before, copy.deepcopy(before)), before)
        after = copy.deepcopy(before)
        after['socketNodeSha256'] = 'a' * 64
        with self.assertRaisesRegex(m.Rejected, '^SOCKET_BINDING_DRIFT$'):
            m.assert_same_binding(before, after)

    def test_dynamic_errors_and_base_exceptions_cannot_leak_private_value(self):
        for error in (RuntimeError(SENTINEL), m.Rejected(SENTINEL), self.base.Rejected(SENTINEL)):
            with patch.object(self.reader, '_follow_run_alias', side_effect=error):
                self.reject('SOCKET_BINDING_UNAVAILABLE')


if __name__ == '__main__':
    unittest.main()
