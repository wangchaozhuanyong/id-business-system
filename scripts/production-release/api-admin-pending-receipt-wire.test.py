"""Bounded receipt framing; successful decoding confers no release authority.

Fixtures are synthetic and load the actual release helper. No Docker, AWS,
network, real environment, or source-owner runtime fixture is used.
"""
import base64
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import random
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch
import zlib


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / '.runtime/bitbrowser-publish-20261010/receipt-wire-tests'
WORKSPACE = 'API_ADMIN_WORKSPACE'
ORIGIN_SCOPE = 'PENDING_ONLINE_MIGRATION'
PROOF_KIND = 'API_FIXED_DECLARATION_EQUIVALENCE'
KIND = 'WORKSPACE_PENDING_DECLARATION_RECEIPT'
ERROR = 'API_ADMIN_RECEIPT_WIRE_INVALID'
WIRE_LIMIT = 24000
DECODED_LIMIT = 65536
FIELDS = {'kind', 'version', 'encoding', 'decodedLength', 'decodedSha256', 'payload'}


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec)
    module.SCOPE = WORKSPACE
    spec.loader.exec_module(module)
    return module


s = load('receipt_wire_actual_module', 'api-admin-pending-receipt-wire.py')
t = load('receipt_wire_actual_authority', 'api-admin-readonly.py')


def minimum():
    # Valid only for transport selection, deliberately incomplete for authority.
    return {'status': 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED', 'commit': 'a' * 40,
        'pendingOnlineMigrationOrigin': {'version': 2, 'scope': ORIGIN_SCOPE,
            'restoredConfigurationProof': {'version': 3, 'kind': PROOF_KIND}}}


def raw_receipt(receipt=None):
    return json.dumps(minimum() if receipt is None else receipt).encode('utf-8')


def envelope(raw, compressed=None):
    packed = gzip.compress(raw, mtime=0) if compressed is None else compressed
    return {'kind': KIND, 'version': 1, 'encoding': 'gzip-base64',
        'decodedLength': len(raw), 'decodedSha256': hashlib.sha256(raw).hexdigest(),
        'payload': base64.b64encode(packed).decode('ascii')}


def complete_synthetic_receipt():
    receipt = minimum()
    receipt['services'] = {name: {'image': 'sha256:' + str(index) * 64,
        'reference': 'synthetic-' + name, 'status': 'running',
        'health': None if name == 'caddy' else 'healthy',
        'containerId': str(index) * 64, 'startedAtSha256': 'a' * 64,
        'environmentSha256': 'b' * 64, 'configurationSha256': 'c' * 64}
        for index, name in enumerate(('api', 'admin', 'mysql', 'caddy', 'media-resolver',
            'auto-recharge', 'auto-registration'), 1)}
    receipt['pendingOnlineMigrationOrigin']['restoredConfigurationProof']['syntheticEvidence'] = [
        {'path': 'synthetic.path.' + str(index), 'valueSha256': format(index, '064x')}
        for index in range(240)]
    return receipt


class ReceiptWire(unittest.TestCase):
    def reject(self, operation):
        with self.assertRaises(RuntimeError) as caught:
            operation()
        self.assertEqual(caught.exception.args, (ERROR,))
        self.assertIsNone(caught.exception.__cause__)

    def decode(self, value, scope=WORKSPACE):
        output = json.dumps(value) if type(value) is dict else value
        return s.decode_receipt_output(output, scope=scope)

    def test_plain_writer_preserves_exact_old_json_bytes(self):
        examples = [
            {'status': 'API_ADMIN_VERIFIED', 'commit': 'a' * 40, 'freeBytes': 10000000},
            {'status': 'API_REGISTRATION_VERIFICATION_FAILED', 'code': 'API_ADMIN_STEP_FAILED'},
            {'status': 'API_ADMIN_WORKSPACE_VERIFICATION_FAILED', 'code': 'API_ADMIN_READ_UNAVAILABLE'},
            {'status': 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED',
                'pendingOnlineMigrationOrigin': {'version': 1, 'scope': ORIGIN_SCOPE}},
            {'status': 'UNRELATED', 'kind': 'OPAQUE_LEGACY_FIELD'},
            {'label': '中文', 'truth': True, 'null': None, 'float': 1.25}]
        for scope in ('API_ADMIN', 'API_REGISTRATION', 'API_ADMIN_MIGRATION', WORKSPACE):
            for receipt in examples:
                with self.subTest(scope=scope, receipt=receipt.get('status', 'unicode')):
                    self.assertEqual(s.receipt_output(receipt, scope=scope), json.dumps(receipt))

    def test_plain_type_error_remains_original_json_exception(self):
        for receipt in ({'bad': object()}, {('unsupported',): 'key'}):
            for scope in ('API_ADMIN', WORKSPACE):
                with self.subTest(scope=scope):
                    with self.assertRaises(TypeError) as legacy:
                        json.dumps(receipt)
                    with self.assertRaises(TypeError) as actual:
                        s.receipt_output(receipt, scope=scope)
                    self.assertEqual(actual.exception.args, legacy.exception.args)

    def test_plain_circular_value_error_remains_original_json_exception(self):
        receipt = {}; receipt['cycle'] = receipt
        with self.assertRaises(ValueError) as legacy:
            json.dumps(receipt)
        with self.assertRaises(ValueError) as actual:
            s.receipt_output(receipt, scope=WORKSPACE)
        self.assertEqual(actual.exception.args, legacy.exception.args)

    def test_declared_serialization_errors_are_controlled_and_safe(self):
        for broken in (object(), {('SYNTHETIC_PRIVATE_CANARY',): object()}):
            receipt = minimum(); receipt['extra'] = broken
            self.reject(lambda: s.receipt_output(receipt, scope=WORKSPACE))
        receipt = minimum(); receipt['cycle'] = receipt
        self.reject(lambda: s.receipt_output(receipt, scope=WORKSPACE))

    def test_plain_reader_matches_legal_old_json_loads(self):
        for scope in ('API_ADMIN', 'API_REGISTRATION', 'API_ADMIN_MIGRATION', WORKSPACE):
            for raw in (' {"status":"NORMAL", "services":{"caddy":{"health":null}}}\n',
                '{"message": "中文", "value": 1.25}', '{"status":"FAILURE","version":1}'):
                with self.subTest(scope=scope):
                    self.assertEqual(s.decode_receipt_output(raw, scope=scope), json.loads(raw))

    def test_only_workspace_origin_v2_proof_v3_uses_envelope(self):
        receipt = minimum(); wire = s.receipt_output(receipt, scope=WORKSPACE)
        value = json.loads(wire)
        self.assertEqual(set(value), FIELDS)
        self.assertEqual(value['kind'], KIND)
        self.assertEqual(value['version'], 1)
        self.assertEqual(value['encoding'], 'gzip-base64')
        self.assertTrue(wire.isascii()); self.assertNotIn('\n', wire)
        self.assertEqual(s.decode_receipt_output(wire + '\n', scope=WORKSPACE), receipt)
        for scope in ('API_ADMIN', 'API_REGISTRATION', 'API_ADMIN_MIGRATION', 'ONLINE_RECHARGE'):
            with self.subTest(scope=scope):
                self.reject(lambda: s.receipt_output(receipt, scope=scope))
                self.reject(lambda: s.decode_receipt_output(wire + '\n', scope=scope))

    def test_payload_digest_covers_exact_old_json_utf8_without_print_lf(self):
        receipt = minimum(); receipt['note'] = '中文'
        parsed = json.loads(s.receipt_output(receipt, scope=WORKSPACE))
        raw = gzip.decompress(base64.b64decode(parsed['payload']))
        self.assertEqual(raw, json.dumps(receipt).encode('utf-8'))
        self.assertEqual(parsed['decodedLength'], len(raw))
        self.assertEqual(parsed['decodedSha256'], hashlib.sha256(raw).hexdigest())
        self.assertFalse(raw.endswith(b'\n'))
        self.assertNotEqual(parsed['decodedSha256'], hashlib.sha256(raw + b'\n').hexdigest())

    def test_large_synthetic_receipt_preserves_all_seven_eight_field_states(self):
        receipt = complete_synthetic_receipt()
        self.assertGreater(len(raw_receipt(receipt)), WIRE_LIMIT)
        wire = s.receipt_output(receipt, scope=WORKSPACE)
        self.assertLess(len(wire) + 1, WIRE_LIMIT)
        self.assertLess(len(raw_receipt(receipt)), DECODED_LIMIT)
        decoded = self.decode(wire + '\n')
        self.assertEqual(decoded, receipt)
        self.assertEqual(set(decoded['services']), {'api', 'admin', 'mysql', 'caddy',
            'media-resolver', 'auto-recharge', 'auto-registration'})
        for row in decoded['services'].values():
            self.assertEqual(len(row), 8)

    def test_saved_f_contains_decoded_receipt_and_client_metadata_not_envelope(self):
        receipt = complete_synthetic_receipt()
        wire = s.receipt_output(receipt, scope=WORKSPACE)
        decoded = self.decode(wire + '\n')
        metadata = {'commandId': '00000000-0000-0000-0000-000000000001', 'mode': 'preflight',
            'releaseCandidateCommit': 'b' * 40, 'workflowRunId': '70000000001', 'workflowRunAttempt': '1'}
        saved = (json.dumps({**metadata, **decoded}, indent=2) + '\n').encode('utf-8')
        expected = (json.dumps({**metadata, **receipt}, indent=2) + '\n').encode('utf-8')
        OUTPUT.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary:
            path = Path(temporary) / 'synthetic-preflight-result.json'
            path.write_bytes(saved)
            self.assertEqual(path.read_bytes(), expected)
        self.assertFalse(FIELDS <= set(json.loads(saved)))
        self.assertNotEqual(hashlib.sha256(saved).hexdigest(), json.loads(wire)['decodedSha256'])
        # A client wrapper is an archived receipt, never a second wire framing.
        self.reject(lambda: self.decode(saved.decode('utf-8')))

    def test_decoded_fake_proof_still_fails_actual_authority_validator(self):
        receipt = self.decode(s.receipt_output(minimum(), scope=WORKSPACE))
        with patch.object(t, 'command', side_effect=AssertionError('no external calls allowed')) as external:
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_RECEIPT_CHANGED$'):
                t.validate_receipt(receipt, 'a' * 40, 'preflight', WORKSPACE)
        external.assert_not_called()

    def test_malformed_declared_proof_never_falls_back_to_plain(self):
        changes = (
            lambda x: x['pendingOnlineMigrationOrigin'].update(version=True),
            lambda x: x['pendingOnlineMigrationOrigin'].update(version=2.0),
            lambda x: x['pendingOnlineMigrationOrigin'].update(version=1),
            lambda x: x['pendingOnlineMigrationOrigin'].update(scope='OTHER'),
            lambda x: x['pendingOnlineMigrationOrigin'].pop('restoredConfigurationProof'),
            lambda x: x['pendingOnlineMigrationOrigin'].update(restoredConfigurationProof=None),
            lambda x: x['pendingOnlineMigrationOrigin']['restoredConfigurationProof'].update(version=True),
            lambda x: x['pendingOnlineMigrationOrigin']['restoredConfigurationProof'].update(version=3.0),
            lambda x: x['pendingOnlineMigrationOrigin']['restoredConfigurationProof'].update(version=2),
            lambda x: x['pendingOnlineMigrationOrigin']['restoredConfigurationProof'].update(kind='OLD_FULL_HASH_WITNESS'))
        for index, change in enumerate(changes):
            with self.subTest(change=index):
                receipt = minimum(); change(receipt)
                self.reject(lambda: s.receipt_output(receipt, scope=WORKSPACE))
                self.reject(lambda: self.decode(json.dumps(receipt)))

    def test_plain_new_proof_is_a_downgrade_and_rejected(self):
        self.reject(lambda: self.decode(json.dumps(minimum())))

    def test_unknown_envelope_versions_kinds_encoding_and_field_sets_reject(self):
        changes = (lambda x: x.update(version=2), lambda x: x.update(version=True),
            lambda x: x.update(version='1'), lambda x: x.update(kind='UNKNOWN'),
            lambda x: x.update(kind=None), lambda x: x.update(encoding='zlib-base64'),
            lambda x: x.update(encoding=None), lambda x: x.update(extra='SYNTHETIC_PRIVATE_CANARY'))
        for index, change in enumerate(changes):
            with self.subTest(change=index):
                value = envelope(raw_receipt()); change(value)
                self.reject(lambda: self.decode(value))
        for field in FIELDS:
            with self.subTest(missing=field):
                value = envelope(raw_receipt()); value.pop(field)
                self.reject(lambda: self.decode(value))

    def test_duplicate_keys_reject_outer_nested_and_decoded_levels(self):
        encoded = json.dumps(envelope(raw_receipt()))
        self.reject(lambda: self.decode(encoded[:-1] + ', "version":1}'))
        self.reject(lambda: self.decode('{"status":"NORMAL","status":"NORMAL"}'))
        self.reject(lambda: self.decode('{"status":"NORMAL","nested":{"a":1,"a":1}}'))
        raw = raw_receipt()[:-1] + b', "status":"DUPLICATE"}'
        self.reject(lambda: self.decode(envelope(raw)))
        raw = raw_receipt().replace(b'"version": 3', b'"version": 3, "version": 3')
        self.reject(lambda: self.decode(envelope(raw)))

    def test_nonfinite_json_rejects_plain_outer_decoded_and_declared_writer(self):
        for token in ('NaN', 'Infinity', '-Infinity'):
            with self.subTest(token=token):
                self.reject(lambda: self.decode('{"status":"NORMAL","value":' + token + '}'))
                self.reject(lambda: self.decode(json.dumps(envelope(raw_receipt()))[:-1] + ',"extra":' + token + '}'))
                self.reject(lambda: self.decode(envelope(raw_receipt()[:-1] + b',"extra":' + token.encode() + b'}')))
        receipt = minimum(); receipt['bad'] = float('nan')
        self.reject(lambda: s.receipt_output(receipt, scope=WORKSPACE))

    def test_invalid_json_non_dict_inputs_and_utf8_reject(self):
        for value in (None, b'{}', 1, '', '[]', 'null', '1', '"text"', '{', '{} trailing'):
            with self.subTest(value=type(value).__name__):
                self.reject(lambda: s.decode_receipt_output(value, scope=WORKSPACE))
        for raw in (b'[]', b'null', b'1', b'"text"', b'{} trailing', b'{"bad":"\xff"}'):
            self.reject(lambda: self.decode(envelope(raw)))

    def test_exact_decoded_length_digest_and_payload_types_are_required(self):
        for key, value in (
            ('decodedLength', None), ('decodedLength', True), ('decodedLength', '10'),
            ('decodedLength', 0), ('decodedLength', -1), ('decodedLength', DECODED_LIMIT),
            ('decodedLength', len(raw_receipt()) + 1), ('decodedLength', len(raw_receipt()) - 1),
            ('decodedSha256', None), ('decodedSha256', 1), ('decodedSha256', 'a' * 63),
            ('decodedSha256', 'A' * 64), ('decodedSha256', '0' * 64),
            ('payload', None), ('payload', []), ('payload', {}), ('payload', 1),
            ('payload', True), ('payload', ''), ('payload', '中文')):
            with self.subTest(key=key, value=type(value).__name__):
                changed = envelope(raw_receipt()); changed[key] = value
                self.reject(lambda: self.decode(changed))

    def test_base64_requires_canonical_alphabet_no_padding_or_whitespace_extras(self):
        value = envelope(raw_receipt())
        for padding in range(8):
            if value['payload'].endswith('='):
                break
            receipt = minimum(); receipt['padding'] = 'x' * padding
            value = envelope(raw_receipt(receipt))
        self.assertTrue(value['payload'].endswith('='))
        payloads = ('!' + value['payload'], value['payload'] + '\n',
            value['payload'] + '=', value['payload'].rstrip('='), '____', '!!!!',
            value['payload'].replace('+', '-', 1) if '+' in value['payload'] else '-bad')
        for payload in payloads:
            with self.subTest(length=len(payload)):
                self.reject(lambda: self.decode(dict(value, payload=payload)))

    def test_noncanonical_base64_padding_bits_reject(self):
        # A decoder may accept nonzero pad bits; canonical round-trip must not.
        for padding in range(3):
            raw = raw_receipt(); receipt = minimum(); receipt['padding'] = 'x' * padding
            raw = raw_receipt(receipt); value = envelope(raw)
            if value['payload'].endswith('='):
                alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
                index = len(value['payload'].rstrip('=')) - 1
                old = alphabet.index(value['payload'][index])
                changed = value['payload'][:index] + alphabet[old | 1] + value['payload'][index + 1:]
                self.assertNotEqual(changed, value['payload'])
                self.assertEqual(base64.b64decode(changed), base64.b64decode(value['payload']))
                self.reject(lambda: self.decode(dict(value, payload=changed)))
                return
        self.fail('synthetic gzip fixture must exercise padding bits')

    def test_gzip_header_eof_suffix_members_crc_and_isize_are_strict(self):
        raw = raw_receipt(); packed = gzip.compress(raw, mtime=0)
        for blob in (b'not-gzip', packed[:8], packed[:-1], packed[:-8], packed + b'\0',
            packed + b'SYNTHETIC_PRIVATE_CANARY', packed + packed,
            packed[:-8] + bytes([packed[-8] ^ 1]) + packed[-7:],
            packed[:-1] + bytes([packed[-1] ^ 1])):
            with self.subTest(size=len(blob)):
                self.reject(lambda: self.decode(envelope(raw, blob)))

    def test_non_pending_and_nested_envelopes_reject(self):
        for receipt in ({'status': 'NORMAL'}, {'status': 'FAILURE'},
            {'pendingOnlineMigrationOrigin': {'version': 1}},
            {'kind': 'SOME_OTHER_PROTOCOL', **minimum()}):
            self.reject(lambda: self.decode(envelope(raw_receipt(receipt))))
        self.reject(lambda: self.decode(envelope(json.dumps(envelope(raw_receipt())).encode())))

    def test_declared_writer_rejects_reserved_envelope_fields(self):
        for field in FIELDS - {'version'}:
            with self.subTest(field=field):
                receipt = minimum(); receipt[field] = 'SYNTHETIC_PRIVATE_CANARY'
                self.reject(lambda: s.receipt_output(receipt, scope=WORKSPACE))

    def test_one_bounded_inflate_no_flush_or_second_decode(self):
        inflater = zlib.decompressobj(wbits=31)
        calls = []
        class Proxy:
            def decompress(self, blob, cap):
                calls.append(cap)
                return inflater.decompress(blob, cap)
            def flush(self, *args):
                raise AssertionError('unbounded flush forbidden')
            @property
            def eof(self): return inflater.eof
            @property
            def unused_data(self): return inflater.unused_data
            @property
            def unconsumed_tail(self): return inflater.unconsumed_tail
        with patch.object(s.zlib, 'decompressobj', return_value=Proxy()) as make:
            self.assertEqual(self.decode(envelope(raw_receipt())), minimum())
        make.assert_called_once_with(wbits=31)
        self.assertEqual(calls, [DECODED_LIMIT])

    def test_zip_bomb_stops_at_cap_and_rejects(self):
        raw = b'A' * (4 * 1024 * 1024)
        value = envelope(raw_receipt(), gzip.compress(raw, mtime=0))
        self.assertLess(len(json.dumps(value)) + 1, WIRE_LIMIT)
        self.reject(lambda: self.decode(value))

    def test_decoded_byte_limit_is_strict(self):
        receipt = minimum(); receipt['padding'] = ''
        fixed = len(raw_receipt(receipt))
        receipt['padding'] = 'x' * (DECODED_LIMIT - 1 - fixed)
        wire = s.receipt_output(receipt, scope=WORKSPACE)
        self.assertEqual(json.loads(wire)['decodedLength'], DECODED_LIMIT - 1)
        self.assertEqual(self.decode(wire), receipt)
        receipt['padding'] += 'x'
        self.assertEqual(len(raw_receipt(receipt)), DECODED_LIMIT)
        self.reject(lambda: s.receipt_output(receipt, scope=WORKSPACE))
        self.reject(lambda: self.decode(envelope(raw_receipt(receipt))))

    def test_valid_unicode_raw_receipt_counts_bytes_not_characters(self):
        receipt = minimum(); receipt['note'] = '中'
        raw = json.dumps(receipt, ensure_ascii=False).encode('utf-8')
        self.assertGreater(len(raw), len(raw.decode('utf-8')))
        self.assertEqual(self.decode(envelope(raw)), receipt)
        changed = envelope(raw); changed['decodedLength'] = len(raw.decode('utf-8'))
        self.reject(lambda: self.decode(changed))

    def test_wire_limit_is_strict_before_parse_or_inflate(self):
        plain = '{"status":"NORMAL","padding":""}'
        output = plain[:-2] + 'x' * (WIRE_LIMIT - 1 - len(plain)) + '"}'
        self.assertEqual(len(output), WIRE_LIMIT - 1)
        self.assertEqual(self.decode(output)['status'], 'NORMAL')
        self.reject(lambda: self.decode(output + '\n'))
        with patch.object(s.zlib, 'decompressobj', side_effect=AssertionError('must not inflate')):
            self.reject(lambda: self.decode('x' * WIRE_LIMIT))

    def test_writer_final_print_lf_counts_toward_strict_limit(self):
        wire = s.receipt_output(minimum(), scope=WORKSPACE)
        with patch.object(s, 'pending_receipt_wire_wire_limit', len(wire) + 1):
            self.reject(lambda: s.receipt_output(minimum(), scope=WORKSPACE))
        with patch.object(s, 'pending_receipt_wire_wire_limit', len(wire) + 2):
            self.assertEqual(s.receipt_output(minimum(), scope=WORKSPACE), wire)

    def test_writer_rejects_incompressible_wire_even_with_decoded_budget(self):
        rng = random.Random(4311)
        receipt = minimum(); receipt['padding'] = ''.join(rng.choice(
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') for _ in range(36000))
        self.assertLess(len(raw_receipt(receipt)), DECODED_LIMIT)
        self.reject(lambda: s.receipt_output(receipt, scope=WORKSPACE))

    def test_controlled_rejection_emits_no_raw_input_exception_or_stdout(self):
        capture = io.StringIO()
        with redirect_stdout(capture):
            self.reject(lambda: self.decode('{"payload":"SYNTHETIC_PRIVATE_CANARY"}'))
        self.assertEqual(capture.getvalue(), '')


if __name__ == '__main__':
    unittest.main(verbosity=2)
