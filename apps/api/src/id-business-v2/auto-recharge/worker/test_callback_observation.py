"""Local callback failures preserve only safe diagnostics and never replay a POST."""
import io
import json
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError

import bitbrowser_connector as connector
import bitbrowser_retry
from bitbrowser_options import DEFAULTS
from callback_observation import ERROR_REASONS, operation_metadata
from checkout_core import Stop
from test_bitbrowser_connector import JOB_ID, payload


URL = 'https://example.test/api/id-business-v2/auto-recharge/local/' + JOB_ID
REQUEST_ID = '4a33ab4a-5bcf-4a9e-80a9-09173ec8a010'
TOKEN = 'a' * 64


def rejection(status, data=None, *, headers=None, stream=None):
    if stream is None:
        stream = io.BytesIO(json.dumps(data or {}).encode())
    return HTTPError(URL, status, 'synthetic response text must not be retained', headers or {}, stream)


class CallbackObservationTests(unittest.TestCase):
    def client(self):
        return connector.CallbackClient(URL, TOKEN, JOB_ID)

    def failure_report(self, error, body=None):
        opener = SimpleNamespace(open=Mock(side_effect=error))
        with patch.object(connector, 'build_opener', return_value=opener), self.assertRaises(Stop) as stopped:
            self.client().send(body or {'type': 'restore', 'accountKey': 'c' * 64})
        self.assertEqual(opener.open.call_count, 1)
        self.assertEqual(stopped.exception.report['reason'], 'durable_state_unavailable')
        return stopped.exception.report

    def test_409_keeps_original_request_id_status_and_controlled_business_reason(self):
        body = {'type': 'restore', 'sessionJson': '{"accessToken":"private-session"}',
                'details': {'password': 'PrivatePassword', 'number': '5555555555554444'}}
        report = self.failure_report(rejection(409, {
            'message': '原订单记录未核实，禁止创建新订单', 'errorCode': 'CONFLICT',
            'requestId': 'body-request-id-ignored', 'token': TOKEN,
            'request': body, 'debug': {'headers': {'Authorization': 'Bearer ' + TOKEN}},
        }, headers={'X-Request-Id': REQUEST_ID}), body)
        self.assertEqual(report, {'status': 'blocked', 'reason': 'durable_state_unavailable',
            'callback_failure_kind': 'http', 'callback_http_status': 409, 'callback_operation': 'restore',
            'callback_error_code': 'CONFLICT', 'callback_request_id': REQUEST_ID,
            'callback_business_reason': 'callback_original_checkout_unverified'})
        for private in (TOKEN, 'PrivatePassword', '5555555555554444', 'private-session', 'Authorization', '原订单'):
            self.assertNotIn(private, json.dumps(report, ensure_ascii=False))

    def test_exact_business_mapping_does_not_change_execution_reason(self):
        for (status, message), reason in ERROR_REASONS.items():
            with self.subTest(reason=reason):
                report = self.failure_report(rejection(status, {'message': message}))
                self.assertEqual(report['callback_business_reason'], reason)
                altered = self.failure_report(rejection(status, {'message': message + ' secret-suffix'}))
                self.assertNotIn('callback_business_reason', altered)

    def test_cycle_protection_maps_without_changing_payment_authority(self):
        for message, reason in [
            ('该账户仍有未核实付款或订阅待生效，只能复查原订单', 'callback_previous_payment_unverified'),
            ('该账户仍有未完成的原结算，不能创建新周期订单', 'callback_previous_checkout_unfinished'),
        ]:
            report = self.failure_report(rejection(409, {'message': message, 'errorCode': 'CONFLICT', 'requestId': REQUEST_ID}))
            self.assertEqual(report['callback_business_reason'], reason)
            self.assertEqual(report['reason'], 'durable_state_unavailable')
            self.assertNotIn('operator_resolution', report)
            self.assertNotIn('payment_status', report)
            self.assertNotIn('message', report)

    def test_unverified_historical_payment_message_maps_to_existing_payment_reason(self):
        report = self.failure_report(rejection(409, {'message': '原订单编号不一致，历史付款状态未核实',
                                                    'requestId': REQUEST_ID}))
        self.assertEqual(report['callback_business_reason'], 'callback_original_payment_unverified')
        self.assertEqual(report['callback_request_id'], REQUEST_ID)
        self.assertNotIn('message', report)

    def test_unverified_original_identifier_message_maps_to_existing_checkout_reason(self):
        report = self.failure_report(rejection(409, {'message': '原订单编号未核实，禁止创建新订单',
                                                    'requestId': REQUEST_ID}))
        self.assertEqual(report['callback_business_reason'], 'callback_original_checkout_unverified')
        self.assertEqual(report['callback_request_id'], REQUEST_ID)
        self.assertNotIn('message', report)

    def test_auth_and_conflict_failures_never_enter_proxy_reopen(self):
        for status in (401, 403, 409):
            with self.subTest(status=status):
                report = self.failure_report(rejection(status, {'message': 'untrusted provider detail', 'requestId': REQUEST_ID}))
                job = connector.LocalJob(payload())
                job.profile_id = 'd' * 32
                self.assertFalse(bitbrowser_retry.proxy_reopen_allowed(job,
                    SimpleNamespace(session_token='fixture'), report, DEFAULTS, {job.profile_id}))

    def test_unknown_409_and_500_do_not_invent_business_reason_or_copy_message(self):
        for status, message in ((409, 'unknown private account conflict'),
                                (500, '原订单记录未核实，禁止创建新订单')):
            with self.subTest(status=status):
                report = self.failure_report(rejection(status, {'message': message, 'requestId': REQUEST_ID,
                    'stack': TOKEN, 'details': {'password': 'private-password'}}))
                self.assertEqual(report['callback_http_status'], status)
                self.assertNotIn('callback_business_reason', report)
                self.assertNotIn('message', report)
                self.assertNotIn(TOKEN, str(report))
                self.assertNotIn('private-password', str(report))

    def test_reflected_token_password_card_and_nested_session_are_not_identifiers(self):
        body = {'type': 'restore', 'details': {'password': 'PASSWORDSECRET', 'number': '5555555555554444', 'cvc': '987'},
                'extra': [{'sessionJson': '{"accessToken":"SessionSecret12345"}'}]}
        for reflected in (TOKEN, 'PASSWORDSECRET', '5555555555554444', 'SessionSecret12345',
                          'prefix-PASSWORDSECRET-suffix', 'request-987-private'):
            with self.subTest(reflected=reflected):
                report = self.failure_report(rejection(409, {'requestId': reflected, 'errorCode': reflected},
                    headers={'X-Request-Id': reflected}), body)
                self.assertNotIn('callback_request_id', report)
                self.assertNotIn('callback_error_code', report)

    def test_invalid_identifiers_are_discarded(self):
        for request_id in ('short', 'request\nprivate', 'x' * 129, 4, ['not-an-id']):
            with self.subTest(request_id=request_id):
                report = self.failure_report(rejection(409, {'requestId': request_id, 'errorCode': 'arbitrary private text'},
                    headers={'X-Request-Id': request_id}))
                self.assertNotIn('callback_request_id', report)
                self.assertNotIn('callback_error_code', report)

    def test_duplicate_error_json_does_not_override_original_header_id(self):
        stream = io.BytesIO(b'{"requestId":"safe-id-111","requestId":"private-id-222","errorCode":"CONFLICT"}')
        report = self.failure_report(rejection(409, stream=stream, headers={'X-Request-Id': REQUEST_ID}))
        self.assertEqual(report['callback_request_id'], REQUEST_ID)
        self.assertNotIn('callback_error_code', report)

    def test_error_body_is_limited_to_16_kib(self):
        class TrackedBody(io.BytesIO):
            def __init__(self, value):
                super().__init__(value)
                self.total_read = 0
            def read1(self, size):
                value = super().read1(size)
                self.total_read += len(value)
                return value
        stream = TrackedBody(json.dumps({'message': '原订单记录未核实，禁止创建新订单',
                                         'errorCode': 'CONFLICT', 'private': 'x' * 17000}).encode())
        report = self.failure_report(rejection(409, stream=stream, headers={'X-Request-Id': REQUEST_ID}))
        self.assertLessEqual(stream.total_read, 16 * 1024 + 1)
        self.assertEqual(report['callback_request_id'], REQUEST_ID)
        self.assertNotIn('callback_business_reason', report)
        self.assertNotIn('callback_error_code', report)

    def test_hanging_error_body_preserves_known_status_and_request_id_with_absolute_deadline(self):
        released = threading.Event()
        class HangingBody:
            def read(self, _size):
                released.wait(1)
                return b'{"message":"late private response"}'
            def close(self):
                pass
        before = time.monotonic()
        try:
            with patch.object(connector.CallbackClient, 'SEND_SECONDS', .04):
                report = self.failure_report(rejection(409, stream=HangingBody(), headers={'X-Request-Id': REQUEST_ID}))
            self.assertLess(time.monotonic() - before, .25)
            self.assertEqual(report['callback_http_status'], 409)
            self.assertEqual(report['callback_request_id'], REQUEST_ID)
            self.assertNotIn('callback_business_reason', report)
        finally:
            released.set()

    def test_timeout_does_not_claim_http_conflict_or_historical_lock(self):
        released = threading.Event()
        def slow_open(*_args, **_kwargs):
            released.wait(1)
            raise TimeoutError('private network failure')
        before = time.monotonic()
        try:
            with patch.object(connector.CallbackClient, 'SEND_SECONDS', .04):
                report = self.failure_report(slow_open, {'type': 'prepare_next_subscription_cycle', 'phase': 'status'})
            self.assertLess(time.monotonic() - before, .25)
            self.assertEqual(report['callback_failure_kind'], 'timeout')
            self.assertEqual(report['callback_phase'], 'status')
            self.assertNotIn('callback_http_status', report)
            self.assertNotIn('callback_business_reason', report)
            self.assertNotIn('private', str(report))
        finally:
            released.set()

    def test_transport_failure_does_not_copy_exception_or_claim_http_status(self):
        report = self.failure_report(URLError('private-token-' + TOKEN))
        self.assertEqual(report['callback_failure_kind'], 'transport')
        self.assertNotIn('callback_http_status', report)
        self.assertNotIn(TOKEN, str(report))

    def test_invalid_success_body_uses_controlled_invalid_response_diagnostic(self):
        class Response(io.BytesIO):
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                self.close()
        for raw in (b'[]', b'{"success":true,"data":{},"data":{"private":"value"}}',
                    b'{"success":false,"message":"private detail"}'):
            with self.subTest(raw=raw):
                opener = SimpleNamespace(open=Mock(return_value=Response(raw)))
                with patch.object(connector, 'build_opener', return_value=opener), self.assertRaises(Stop) as stopped:
                    self.client().send({'type': 'ledger'})
                self.assertEqual(stopped.exception.report['callback_failure_kind'], 'invalid_response')
                self.assertNotIn('private', str(stopped.exception.report))
                self.assertEqual(opener.open.call_count, 1)

    def test_valid_success_and_controlled_operations_keep_existing_protocol(self):
        class Response(io.BytesIO):
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                self.close()
        opener = SimpleNamespace(open=Mock(return_value=Response(b'{"success":true,"data":{"revision":7}}')))
        with patch.object(connector, 'build_opener', return_value=opener):
            self.assertEqual(self.client().send({'type': 'ledger'}), {'revision': 7})
        self.assertEqual(opener.open.call_count, 1)
        self.assertEqual(operation_metadata({'type': 'untrusted-operation', 'phase': 'private'}), {})
        self.assertEqual(operation_metadata({'type': 'prepare_next_subscription_cycle', 'phase': []}),
                         {'callback_operation': 'prepare_next_subscription_cycle'})

    def test_restore_first_error_survives_failed_finished_callback(self):
        job = connector.LocalJob(payload())
        first = rejection(409, {'message': '原订单记录未核实，禁止创建新订单',
                                'errorCode': 'CONFLICT', 'requestId': REQUEST_ID})
        second = rejection(500, {'message': 'private finishing failure', 'requestId': 'finishing-id-222'})
        opener = SimpleNamespace(open=Mock(side_effect=[first, second]))
        async def execute():
            job.restore_account(SimpleNamespace(account_id='fixture-account'))
            self.fail('Restore failure must stop before browser execution')
        job.execute = execute
        with patch.object(connector, 'build_opener', return_value=opener):
            job.run()
        self.assertTrue(job.done)
        self.assertFalse(job.finished_callback_acknowledged)
        self.assertEqual(job.result['reason'], 'durable_state_unavailable')
        self.assertEqual(job.result['callback_http_status'], 409)
        self.assertEqual(job.result['callback_operation'], 'restore')
        self.assertEqual(job.result['callback_request_id'], REQUEST_ID)
        self.assertEqual(job.result['callback_business_reason'], 'callback_original_checkout_unverified')
        self.assertEqual(job.result['payment_requests_sent'], 0)
        self.assertFalse(job.result['payment_attempted'])
        self.assertNotIn('finishing-id-222', str(job.result))
        self.assertEqual(opener.open.call_count, 2)
        sent_types = [json.loads(call.args[0].data)['type'] for call in opener.open.call_args_list]
        self.assertEqual(sent_types, ['restore', 'finished'])
        self.assertEqual(job.callback.token, '')

    def test_completed_snapshot_preserves_all_safe_callback_diagnostics(self):
        job = connector.LocalJob(payload())
        metadata = {'callback_http_status': 409, 'callback_operation': 'prepare_next_subscription_cycle',
            'callback_phase': 'inspect', 'callback_failure_kind': 'http',
            'callback_error_code': 'CONFLICT', 'callback_request_id': REQUEST_ID,
            'callback_business_reason': 'callback_original_checkout_unverified'}
        job.result = {'status': 'blocked', 'reason': 'durable_state_unavailable', **metadata,
                      'raw_response': 'private secret', 'headers': {'Authorization': TOKEN}}
        completed = connector.CompletedJob(job, time.monotonic())
        self.assertEqual(completed.state()['result'],
            {'status': 'blocked', 'reason': 'durable_state_unavailable', **metadata})
        self.assertFalse(hasattr(completed, 'callback'))


if __name__ == '__main__':
    unittest.main()
