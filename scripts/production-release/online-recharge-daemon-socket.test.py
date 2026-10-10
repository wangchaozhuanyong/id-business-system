import copy
import importlib.util
import os
from pathlib import Path
import socket
import struct
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

m = load('vfs_binding', HERE / 'online-recharge-daemon-socket.py')
old = load('legacy37_test_helpers', HERE / 'online-recharge-daemon-listener.test.py')
old.HERE = HERE
old.fixtures.HERE = HERE
SENTINEL = old.SENTINEL


def attribute(kind, data):
    raw = m.ATTR.pack(m.ATTR.size + len(data), kind) + data
    return raw + b'\0' * (-len(raw) % 4)


def packet(inode, node_inode, device, *, seq=41, port=7777, cookie=(101, 202), attrs=None):
    body = m.RESPONSE.pack(1, 1, 10, 0, inode, *cookie)
    if attrs is None:
        attrs = attribute(1, struct.pack('=II', node_inode, device)) + attribute(6, b'\0') + attribute(7, struct.pack('=I', 0))
    body += attrs
    return m.HEADER.pack(16 + len(body), 20, 0, seq, port) + body


class FakeNetlink:
    def __init__(self, case):
        self.case = case
        self.closed = False
        self.local = (7777, 0)
        self.sender = (0, 0)
        self.flags = 0
        self.ancillary = []
        self.reply_mutation = None
        self.sent = []

    def settimeout(self, timeout):
        self.case.assertEqual(timeout, 3)

    def bind(self, address):
        self.case.assertEqual(address, (0, 0))

    def getsockname(self):
        return self.local

    def sendto(self, raw, address):
        self.case.assertEqual(address, (0, 0))
        self.sent.append(raw)
        return len(raw)

    def recvmsg(self, budget, ancillary):
        self.case.assertEqual((budget, ancillary), (4096, 0))
        raw = self.sent[-1]
        length, kind, flags, seq, port = m.HEADER.unpack_from(raw)
        self.case.assertEqual((length, kind, flags), (40, 20, 1))
        family, protocol, pad, states, inode, show, c0, c1 = m.REQUEST.unpack_from(raw, 16)
        self.case.assertEqual((family, protocol, pad, states, show), (1, 0, 0, 1 << 10, 0x42))
        self.case.assertEqual(inode, 12345)
        self.case.requests.append((c0, c1))
        result = packet(inode, self.case.target_inode, self.case.target_device,
                        seq=seq, port=port, cookie=self.case.cookie)
        if self.reply_mutation:
            result = self.reply_mutation(result)
        return result, self.ancillary, self.flags, self.sender

    def close(self):
        self.closed = True


class VfsTests(unittest.TestCase):
    def setUp(self):
        self.fixture = old.SocketTests('test_nonempty_bound_filesystem_socket_and_kernel_fd_fixture_has_no_authority')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.addCleanup(self.fixture.tearDown)
        self.node = self.fixture.node
        self.target_inode = self.node.stat().st_ino
        self.target_device = m.kernel_device(self.node.stat().st_dev)
        self.cookie = (101, 202)
        self.requests = []
        self.channels = []
        self.channel_setup = None
        def factory():
            channel = FakeNetlink(self)
            self.channels.append(channel)
            if self.channel_setup:
                self.channel_setup(channel)
            return channel
        self.modules = patch.object(m, '_listener', return_value=old.m)
        self.netlink = patch.object(m, '_netlink_socket', side_effect=factory)
        self.sequence = patch.object(m, '_sequence', return_value=41)
        for item in (self.modules, self.netlink, self.sequence):
            item.start()
            self.addCleanup(item.stop)

    def collect(self):
        return m.runtime_daemon_socket_binding(self.fixture.case.controller)

    def reject(self, code=None):
        with self.assertRaises(m.Rejected) as raised:
            self.collect()
        self.assertIn(str(raised.exception), m.CODES)
        self.assertNotIn(SENTINEL, str(raised.exception))
        self.assertTrue(raised.exception.__suppress_context__)
        self.assertTrue(all(channel.closed for channel in self.channels))
        if code:
            self.assertEqual(str(raised.exception), code)

    def parse(self, raw):
        return m.decode_packet(raw, sequence=41, port=7777, inode=12345)

    def test_fixed_kernel_vfs_tuple_matches_actual_private_filesystem_node(self):
        result = self.collect()
        self.assertEqual(result['kind'], 'DOCKERD_FIXED_UNIX_VFS_BINDING')
        self.assertEqual(result['version'], 2)
        self.assertEqual(result['status'], 'VFS_BOUND_TO_RUNTIME_DAEMON')
        self.assertEqual(result['vfsBinding']['vfsInodeSha256'], m.digest(self.node.stat().st_ino))
        self.assertEqual(result['vfsBinding']['vfsDeviceSha256'], m.digest(self.target_device))
        self.assertEqual(result['listenerBinding']['runtimeIdentity']['runtime']['binarySha256'],
                         self.fixture.base.digest(self.fixture.case.binary.read_bytes()))
        for key in ('authority', 'productionEligible', 'proofConstructed'):
            self.assertIs(result[key], False)
        self.assertEqual(self.requests, [m.NOCOOKIE, self.cookie])
        self.assertTrue(all(channel.closed for channel in self.channels))

    def test_unlinked_original_listener_and_new_same_path_socket_old37_passes_new2_rejects(self):
        self.fixture.local_socket.listen(1)
        self.node.unlink()
        proxy = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(proxy.close)
        old.bind_node(proxy, self.node)
        proxy.listen(1)
        self.node.chmod(0o660)
        self.assertNotEqual(self.node.stat().st_ino, self.target_inode)
        self.assertEqual(self.fixture.collect()['status'], 'LISTENER_HELD_BY_RUNTIME_DAEMON')
        self.reject('VFS_NODE_MISMATCH')

    def test_other_path_proxy_renamed_over_unlinked_endpoint_cannot_borrow_old_fd(self):
        self.fixture.local_socket.listen(1)
        replacement = self.node.with_name('private-proxy.sock')
        proxy = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(proxy.close)
        old.bind_node(proxy, replacement)
        proxy.listen(1)
        replacement.chmod(0o660)
        self.node.unlink()
        os.rename(replacement, self.node)
        self.assertEqual(self.fixture.collect()['status'], 'LISTENER_HELD_BY_RUNTIME_DAEMON')
        self.reject('VFS_NODE_MISMATCH')

    def test_same_engineid_claim_or_successful_proxy_placeholder_cannot_override_vfs_failure(self):
        self.fixture.case.controller.engine_id = 'same-but-not-authority'
        self.fixture.case.controller.client_success = True
        self.target_inode += 1
        self.reject('VFS_NODE_MISMATCH')

    def test_correct_inode_but_different_device_rejected(self):
        self.target_device ^= 1
        self.reject('VFS_NODE_MISMATCH')

    def test_device_uses_kernel_internal_major20_not_user_stat_encoding(self):
        linux_style = os.makedev(8, 273)
        self.assertEqual(m.kernel_device(linux_style), (8 << 20) | 273)
        self.assertNotEqual(m.kernel_device(linux_style), linux_style)

    def test_vfs_inode_over_32_bits_is_rejected_not_truncated(self):
        observed = {'path': {'node': {'file': (self.node.stat().st_dev, 2**32 + self.target_inode) + (0,) * 7}},
                    'listener': {'kernelInode': '12345'}}
        with self.assertRaisesRegex(m.Rejected, '^VFS_QUERY_INVALID$'):
            m.check_node(observed, {'kernelInode': 12345, 'vfsInode': self.target_inode, 'vfsDevice': self.target_device})

    def test_exact_request_inode_limits_types_cookie_and_non_dump_flags(self):
        raw = m.query_bytes(12345, 41, 7777)
        self.assertEqual(m.HEADER.unpack_from(raw), (40, 20, 1, 41, 7777))
        self.assertEqual(m.REQUEST.unpack_from(raw, 16), (1, 0, 0, 1024, 12345, 66, *m.NOCOOKIE))
        for args in ((0, 41, 7777), (2**32, 41, 7777), (True, 41, 7777),
                     (12345, 0, 7777), (12345, 41, 0)):
            with self.assertRaisesRegex(m.Rejected, '^VFS_QUERY_INVALID$'):
                m.query_bytes(*args)

    def test_kernel_sender_port_zero_and_message_destination_client_port_are_distinct(self):
        self.assertEqual(self.collect()['status'], 'VFS_BOUND_TO_RUNTIME_DAEMON')
        self.channel_setup = lambda channel: setattr(channel, 'sender', (7777, 0))
        self.reject('VFS_WIRE_INVALID')

    def test_multicast_sender_truncation_control_and_unknown_recv_flags_rejected(self):
        for mutate in (lambda c: setattr(c, 'sender', (0, 1)), lambda c: setattr(c, 'flags', socket.MSG_TRUNC),
                       lambda c: setattr(c, 'flags', socket.MSG_CTRUNC), lambda c: setattr(c, 'flags', 0x4000),
                       lambda c: setattr(c, 'ancillary', [(1, 1, b'SYNTHETIC')])):
            self.channel_setup = mutate
            self.reject('VFS_WIRE_INVALID')

    def test_invalid_local_port_multicast_or_partial_send_rejected(self):
        for local in ((0, 0), (7777, 1), (True, 0), ('7777', 0)):
            self.channel_setup = lambda c, local=local: setattr(c, 'local', local)
            self.reject('VFS_QUERY_INVALID')
        self.channel_setup = lambda c: setattr(c, 'sendto', lambda *args: 1)
        self.reject('VFS_DIAG_UNAVAILABLE')

    def test_header_sequence_and_destination_port_must_match_exact_request(self):
        raw = packet(12345, self.target_inode, self.target_device)
        for offset, value in ((8, 42), (12, 0), (12, 7778)):
            mutated = bytearray(raw)
            struct.pack_into('=I', mutated, offset, value)
            with self.assertRaisesRegex(m.Rejected, '^VFS_WIRE_INVALID$'):
                self.parse(bytes(mutated))

    def test_empty_truncated_oversize_or_wrong_message_lengths_rejected(self):
        raw = packet(12345, self.target_inode, self.target_device)
        variants = (b'', raw[:15], raw[:-1], raw + b'\0', b'x' * 4097)
        for mutated in variants:
            with self.assertRaisesRegex(m.Rejected, '^VFS_WIRE_INVALID$'):
                self.parse(mutated)

    def test_multipart_dump_interrupted_done_noop_and_multiple_messages_rejected(self):
        raw = packet(12345, self.target_inode, self.target_device)
        for kind, flags in ((20, 2), (20, 0x10), (20, 0x20), (3, 0), (1, 0), (4, 0)):
            mutated = bytearray(raw)
            struct.pack_into('=HH', mutated, 4, kind, flags)
            with self.assertRaisesRegex(m.Rejected, '^VFS_WIRE_INVALID$'):
                self.parse(bytes(mutated))
        with self.assertRaisesRegex(m.Rejected, '^VFS_WIRE_INVALID$'):
            self.parse(raw + raw)

    def test_kernel_error_frame_fails_closed_without_outputting_message(self):
        raw = m.HEADER.pack(24, 2, 0, 41, 7777) + struct.pack('=i', -2) + b'err!'
        with self.assertRaisesRegex(m.Rejected, '^VFS_DIAG_UNAVAILABLE$'):
            self.parse(raw)

    def test_wrong_family_type_state_padding_or_kernel_inode_rejected(self):
        raw = packet(12345, self.target_inode, self.target_device)
        for offset, value in ((16, 2), (17, 2), (18, 1), (19, 1), (20, 42)):
            mutated = bytearray(raw)
            mutated[offset] = value
            with self.assertRaisesRegex(m.Rejected, '^VFS_WIRE_INVALID$'):
                self.parse(bytes(mutated))

    def test_nocookie_reply_and_reused_inode_changed_cookie_rejected(self):
        with self.assertRaisesRegex(m.Rejected, '^VFS_WIRE_INVALID$'):
            self.parse(packet(12345, self.target_inode, self.target_device, cookie=m.NOCOOKIE))
        with self.assertRaisesRegex(m.Rejected, '^VFS_DRIFT$'):
            m.decode_packet(packet(12345, self.target_inode, self.target_device, cookie=(303, 404)),
                            sequence=41, port=7777, inode=12345, expected_cookie=self.cookie)

    def test_missing_vfs_uid_shutdown_duplicates_unknown_flags_and_attr_types_rejected(self):
        vfs = attribute(1, struct.pack('=II', self.target_inode, self.target_device))
        shut = attribute(6, b'\0')
        uid = attribute(7, struct.pack('=I', 0))
        for attrs in (shut + uid, vfs + shut, vfs + uid, vfs + vfs + shut + uid,
                      vfs + shut + uid + attribute(0, b'/PRIVATE/' + SENTINEL.encode()),
                      attribute(0x8001, struct.pack('=II', self.target_inode, self.target_device)) + shut + uid):
            with self.assertRaisesRegex(m.Rejected, '^VFS_WIRE_INVALID$'):
                self.parse(packet(12345, self.target_inode, self.target_device, attrs=attrs))

    def test_malformed_attribute_lengths_padding_and_payload_sizes_rejected(self):
        shut = attribute(6, b'\0')
        uid = attribute(7, struct.pack('=I', 0))
        for attrs in (m.ATTR.pack(3, 1), m.ATTR.pack(1000, 1),
                      attribute(1, b'a' * 4) + shut + uid,
                      attribute(1, struct.pack('=II', self.target_inode, self.target_device)) + b'\x05\x00\x06\x00\0xxx' + uid,
                      attribute(1, struct.pack('=II', self.target_inode, self.target_device)) + shut + attribute(7, b'\0')):
            with self.assertRaisesRegex(m.Rejected, '^VFS_WIRE_INVALID$'):
                self.parse(packet(12345, self.target_inode, self.target_device, attrs=attrs))

    def test_nonroot_diag_uid_closed_socket_or_zero_inode_rejected(self):
        for attrs in (attribute(1, struct.pack('=II', self.target_inode, self.target_device)) + attribute(6, b'\0') + attribute(7, struct.pack('=I', 1000)),
                      attribute(1, struct.pack('=II', self.target_inode, self.target_device)) + attribute(6, b'\x01') + attribute(7, struct.pack('=I', 0)),
                      attribute(1, struct.pack('=II', 0, self.target_device)) + attribute(6, b'\0') + attribute(7, struct.pack('=I', 0))):
            with self.assertRaisesRegex(m.Rejected, '^VFS_WIRE_INVALID$'):
                self.parse(packet(12345, self.target_inode, self.target_device, attrs=attrs))

    def test_kernel_query_cookie_changes_between_exact_reads_rejected(self):
        def change(channel):
            if len(self.channels) == 2:
                self.cookie = (303, 404)
        self.channel_setup = change
        self.reject('VFS_DRIFT')

    def test_vfs_tuple_changes_between_queries_rejected_even_with_same_cookie(self):
        def change(channel):
            if len(self.channels) == 2:
                self.target_device ^= 1
        self.channel_setup = change
        self.reject('VFS_NODE_MISMATCH')

    def test_leaf_replaced_after_second_query_is_detected_by_final_node_read(self):
        proxy = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(proxy.close)
        original = FakeNetlink.recvmsg
        def receive(channel, *args):
            value = original(channel, *args)
            if len(self.channels) == 2:
                self.node.unlink()
                old.bind_node(proxy, self.node)
                self.node.chmod(0o660)
            return value
        with patch.object(FakeNetlink, 'recvmsg', receive):
            self.reject('VFS_DRIFT')

    def test_runtime_mainpid_fd_still_required_with_vfs_match(self):
        self.fixture.fd.unlink()
        self.reject('DAEMON_FD_MISSING')
        with self.assertRaises(m.Rejected) as raised:
            self.collect()
        self.assertEqual(raised.exception.diagnostic_phase, 'OBSERVATION_FIRST')

    def test_unavailable_kernel_protocol_permissions_timeout_are_static_failure(self):
        with patch.object(m, '_netlink_socket', side_effect=OSError(SENTINEL)):
            self.reject('VFS_DIAG_UNAVAILABLE')
        self.channel_setup = lambda c: setattr(c, 'recvmsg', lambda *args: (_ for _ in ()).throw(TimeoutError(SENTINEL)))
        self.reject('VFS_DIAG_UNAVAILABLE')

    def test_no_real_netlink_socket_is_ever_opened_by_tests(self):
        with patch.object(m.socket, 'socket', side_effect=AssertionError('ACTUAL_NETLINK_FORBIDDEN')):
            self.assertEqual(self.collect()['status'], 'VFS_BOUND_TO_RUNTIME_DAEMON')

    def test_v2_validator_rejects_old37_or_unknown_field_hash_and_authority(self):
        with self.assertRaisesRegex(m.Rejected, '^VFS_REPORT_INVALID$'):
            m.validate_binding(self.fixture.collect())
        original = self.collect()
        for mutate in (lambda r: r.update({'authority': True}), lambda r: r.update({'version': 1}),
                       lambda r: r.update({'unknown': SENTINEL}),
                       lambda r: r['vfsBinding'].update({'vfsIdentitySha256': SENTINEL}),
                       lambda r: r['listenerBinding'].update({'unixHost': 'tcp://other'})):
            value = copy.deepcopy(original)
            mutate(value)
            with self.assertRaisesRegex(m.Rejected, '^VFS_REPORT_INVALID$'):
                m.validate_binding(value)

    def test_before_after_guard_rejects_valid_shaped_different_vfs_tuple(self):
        before = self.collect()
        self.assertEqual(m.assert_same_binding(before, copy.deepcopy(before)), before)
        after = copy.deepcopy(before)
        after['vfsBinding']['vfsIdentitySha256'] = 'a' * 64
        with self.assertRaisesRegex(m.Rejected, '^VFS_DRIFT$'):
            m.assert_same_binding(before, after)

    def test_real_random_sequence_not_added_to_stable_binding(self):
        with patch.object(m, '_sequence', side_effect=[41, 42, 43, 44]):
            before = self.collect()
            after = self.collect()
        self.assertEqual(m.assert_same_binding(before, after), before)

    def test_default_factory_on_nonlinux_or_nonroot_rejects_without_socket_open(self):
        self.netlink.stop()
        try:
            with patch.object(m.sys, 'platform', 'darwin'), patch.object(m.socket, 'socket', side_effect=AssertionError('ACTUAL_NETLINK_FORBIDDEN')):
                with self.assertRaisesRegex(m.Rejected, '^VFS_DIAG_UNAVAILABLE$'):
                    m._netlink_socket()
            with patch.object(m.sys, 'platform', 'linux'), patch.object(m.os, 'geteuid', return_value=1000), patch.object(m.socket, 'socket', side_effect=AssertionError('ACTUAL_NETLINK_FORBIDDEN')):
                with self.assertRaisesRegex(m.Rejected, '^VFS_DIAG_UNAVAILABLE$'):
                    m._netlink_socket()
        finally:
            self.netlink.start()


    def test_measured_dependency_bytes_and_identity_seal_are_required(self):
        self.modules.stop()
        try:
            self.assertEqual(m._listener().BASE_SHA, m.IDENTITY_SHA)
            for key in ('LISTENER_SHA', 'IDENTITY_SHA'):
                with patch.object(m, key, '0' * 64):
                    with self.assertRaisesRegex(m.Rejected, '^VFS_SOURCE_UNMEASURED$'):
                        m._listener()
        finally:
            self.modules.start()

    def test_nested_report_unknown_fields_and_all_authority_flags_rejected(self):
        original = self.collect()
        for mutate in (lambda r: r.update({'productionEligible': True}),
                       lambda r: r.update({'proofConstructed': True}),
                       lambda r: r.update({'rawOutputSuppressed': False}),
                       lambda r: r['vfsBinding'].update({'unknown': SENTINEL}),
                       lambda r: r['vfsBinding'].update({'protocol': SENTINEL}),
                       lambda r: r['listenerBinding']['runtimeIdentity'].update({'unknown': SENTINEL})):
            value = copy.deepcopy(original)
            mutate(value)
            with self.assertRaisesRegex(m.Rejected, '^VFS_REPORT_INVALID$'):
                m.validate_binding(value)

    def test_receive_metadata_types_and_boolean_port_groups_rejected(self):
        self.channel_setup = lambda c: setattr(c, 'local', (7777, False))
        self.reject('VFS_QUERY_INVALID')
        for mutate in (lambda c: setattr(c, 'sender', (False, 0)),
                       lambda c: setattr(c, 'sender', [0, 0]),
                       lambda c: setattr(c, 'flags', False),
                       lambda c: setattr(c, 'ancillary', ())):
            self.channel_setup = mutate
            self.reject('VFS_WIRE_INVALID')

    def test_query_bind_send_and_receive_exception_strings_are_never_reported(self):
        for name in ('settimeout', 'bind', 'getsockname', 'sendto', 'recvmsg'):
            def broken(*args):
                raise OSError(SENTINEL)
            self.channel_setup = lambda c, name=name: setattr(c, name, broken)
            self.reject('VFS_DIAG_UNAVAILABLE')

    def test_no_cookie_input_wrong_cookie_types_and_unknown_future_attributes_rejected(self):
        for cookie in ((1,), (1, -1), (1, 2**32), [1, 2], (True, 2)):
            with self.assertRaisesRegex(m.Rejected, '^VFS_QUERY_INVALID$'):
                m.query_bytes(12345, 41, 7777, cookie)
        attrs = attribute(1, struct.pack('=II', self.target_inode, self.target_device)) + attribute(6, b'\0') + attribute(7, struct.pack('=I', 0))
        for extra in (attribute(8, b'UNKNOWN'), attribute(0x4001, b'UNKNOWN')):
            with self.assertRaisesRegex(m.Rejected, '^VFS_WIRE_INVALID$'):
                self.parse(packet(12345, self.target_inode, self.target_device, attrs=attrs + extra))


if __name__ == '__main__':
    unittest.main()
