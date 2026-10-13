import asyncio
import json
import time
import threading
import io
import contextlib
import subprocess
import sys
import gc
import weakref
from pathlib import Path
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener
from unittest.mock import AsyncMock, MagicMock, patch

import bitbrowser_connector as connector
from checkout_core import Stop


JOB_ID = "11111111-1111-4111-8111-111111111111"


def payload():
    return {
        "id": JOB_ID,
        "mode": "payment",
        "plan": "plus",
        "windowName": "申请gpt-001",
        "sessionJson": '{"accessToken":"fixture"}',
        "details": {
            "number": "5555555555554444",
            "expiry": "12/39",
            "cvc": "123",
            "name": "Test User",
            "email": "test@example.invalid",
        },
        "address": {
            "id": "22222222-2222-4222-8222-222222222222",
            "line1": "1221 SW Fourth Avenue",
            "country": "US",
            "city": "Portland",
            "state": "OR",
            "postalCode": "97204",
        },
        "bitBrowser": {
            "localApiUrl": "http://127.0.0.1:54345",
            "localApiToken": "b" * 32,
            "groupName": "gpt账号注册",
            "tagName": "申请gpt",
            "proxyType": "http",
            "dynamicProxyUrl": "https://proxy.example/secret",
        },
        "safety": {
            "lockedCurrency": "USD",
            "authorizeSinglePayment": True,
            "manualPaymentConfirmation": True,
        },
        "callbackUrl": "https://admin.example/api/id-business-v2/auto-recharge/local/" + JOB_ID,
        "agentToken": "a" * 64,
        "authorizeSinglePayment": True,
    }


def confirmed(job, quote, last4):
    """Synthetic explicit human confirmation; never connects to a browser."""
    job.account_key = job.account_key or "c" * 64
    original = job.callback.send
    def callback(body):
        result = original(body)
        if body.get("result", {}).get("status") == "awaiting_confirmation":
            pending = job.state()["result"]
            job.signal_confirm(pending["nonce"], pending["quote_digest"])
        return result
    job.callback.send = callback
    try:
        return job.confirm(quote, last4)
    finally:
        job.callback.send = original


def resolution_payload():
    return {
        "id": JOB_ID,
        "mode": "resolve_unknown_payment",
        "plan": "pro-20x",
        "accountKey": "c" * 64,
        "checkoutIdentifier": "oaics_historical",
        "sourceJobId": "22222222-2222-4222-8222-222222222222",
        "verificationJobId": "33333333-3333-4333-8333-333333333333",
        "callbackUrl": "https://admin.example/api/id-business-v2/auto-recharge/local/" + JOB_ID,
        "agentToken": "a" * 64,
    }


class CallbackDiagnosticTests(unittest.TestCase):
    class Response(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            self.close()

    def client(self, token='private-fixture-token'):
        return connector.CallbackClient(payload()['callbackUrl'], token, JOB_ID)

    def failure(self, error, body=None, *, token='private-fixture-token'):
        with patch.object(connector, 'build_opener') as opener:
            opener.return_value.open.side_effect = error
            output = io.StringIO()
            with contextlib.redirect_stdout(output), self.assertRaises(Stop) as stopped:
                self.client(token).send(body or {'type': 'restore', 'accountKey': 'c' * 64})
            self.assertEqual(opener.return_value.open.call_count, 1)
        self.assertEqual(stopped.exception.report['reason'], 'durable_state_unavailable')
        diagnostic = json.loads(output.getvalue())
        self.assertEqual(diagnostic['event'], 'recharge_record_callback_failed')
        self.assertEqual(diagnostic['jobId'], JOB_ID)
        self.assertLess(len(output.getvalue()), 1024)
        self.assertLessEqual(set(diagnostic), {'event', 'jobId', 'operation', 'phase', 'errorType',
            'failure', 'observedAt', 'httpStatus', 'errorCode', 'requestId', 'rejectionCause'})
        self.assertEqual(connector.datetime.fromisoformat(diagnostic['observedAt']).utcoffset(),
                         connector.datetime.now(connector.timezone.utc).utcoffset())
        for private in ('private-fixture', 'admin.example', 'c' * 64):
            self.assertNotIn(private, output.getvalue())
        return stopped.exception.report, diagnostic

    def test_http_rejection_keeps_original_stop_and_safe_tracking_metadata(self):
        tracking = '22222222-2222-4222-8222-222222222222'
        for status in (400, 401, 403, 409, 429, 500, 503):
            with self.subTest(status=status):
                raw = json.dumps({'success': False, 'errorCode': 'FORBIDDEN',
                    'requestId': tracking, 'message': 'private-fixture-response'}).encode()
                report, diagnostic = self.failure(HTTPError(payload()['callbackUrl'], status,
                    'private-fixture-http-message', {}, io.BytesIO(raw)))
                self.assertEqual(report['callback_http_status'], status)
                self.assertEqual(report['callback_error_code'], 'FORBIDDEN')
                self.assertEqual(report['callback_request_id'], tracking)
                self.assertEqual(report['callback_failure_kind'], 'http')
                self.assertNotIn('error_type', report)
                self.assertEqual(diagnostic['httpStatus'], status)
                self.assertEqual(diagnostic['errorType'], 'HTTPError')
                self.assertEqual(diagnostic['requestId'], tracking)
                self.assertEqual(diagnostic['errorCode'], 'FORBIDDEN')
                self.assertEqual(diagnostic['failure'], 'http_rejected')

    def test_current_auth_codes_are_logged_without_copying_error_body(self):
        for status, code in ((401, 'AUTH_INVALID'), (403, 'AUTH_PERMISSION_DENIED')):
            with self.subTest(code=code):
                raw = json.dumps({'errorCode': code, 'message': 'private-fixture-response'}).encode()
                report, diagnostic = self.failure(HTTPError(payload()['callbackUrl'], status,
                    'private-fixture', {}, io.BytesIO(raw)))
                self.assertEqual(report['callback_http_status'], status)
                self.assertEqual(diagnostic['errorCode'], code)

    def test_transport_errors_have_controlled_categories_without_exception_text(self):
        for error, name, failure_kind in (
                (TimeoutError('private-fixture-timeout'), 'TimeoutError', 'timeout'),
                (URLError('private-fixture-network'), 'URLError', 'transport'),
                (OSError('private-fixture-network'), 'OSError', 'transport'),
                (RuntimeError('private-fixture-network'), 'Exception', 'transport')):
            with self.subTest(name=name):
                report, diagnostic = self.failure(error, {'type': 'ledger',
                    'document': {'secret': 'private-fixture'}})
                self.assertEqual(report['callback_failure_kind'], failure_kind)
                self.assertEqual(diagnostic['errorType'], name)
                self.assertNotIn('httpStatus', diagnostic)
                self.assertNotIn('http_status', report)

    def test_invalid_success_response_and_size_limit_stop_without_retry(self):
        for raw, failure in ((b'not-json-private-fixture', 'response'),
                (b'{"success":true,"data":{},"data":{}}', 'response'),
                (b'{"success":false,"data":{}}', 'response'),
                (b'{"success":true,"data":[]}', 'response'),
                (b' ' * (connector.MAX_BODY + 1), 'response_too_large')):
            with self.subTest(size=len(raw)), patch.object(connector, 'build_opener') as opener:
                opener.return_value.open.return_value = self.Response(raw)
                output = io.StringIO()
                with contextlib.redirect_stdout(output), self.assertRaises(Stop) as stopped:
                    self.client().send({'type': 'restore'})
                self.assertEqual(stopped.exception.report['callback_failure_kind'], 'invalid_response')
                self.assertEqual(json.loads(output.getvalue())['failure'], failure)
                self.assertNotIn('private-fixture', output.getvalue())
                self.assertEqual(opener.return_value.open.call_count, 1)

    def test_valid_response_boundary_keeps_return_protocol_and_ten_second_budget(self):
        raw = b'{"success":true,"data":{"records":[]}}'
        for size in (len(raw), connector.MAX_BODY):
            with self.subTest(size=size), patch.object(connector, 'build_opener') as opener:
                opener.return_value.open.return_value = self.Response(raw + b' ' * (size - len(raw)))
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    self.assertEqual(self.client().send({'type': 'restore'}), {'records': []})
                self.assertEqual(output.getvalue(), '')
                self.assertGreater(opener.return_value.open.call_args.kwargs['timeout'], 9)
                self.assertLessEqual(opener.return_value.open.call_args.kwargs['timeout'], 10)
                self.assertEqual(opener.return_value.open.call_count, 1)

    def test_untrusted_codes_identifiers_and_operation_are_not_logged(self):
        for code, request_id, message, operation in (
                ('PRIVATE_FIXTURE_CODE', 'private-fixture-request', 'private-fixture-body', 'private-fixture-operation'),
                (['FORBIDDEN'], ['private-fixture'], {'private-fixture': 'body'}, []),
                ('X' * 10000, 'x' * 10000, '该账户属于另一操作人的原任务 private-fixture', {})):
            with self.subTest(code_type=type(code).__name__):
                raw = json.dumps({'errorCode': code, 'requestId': request_id, 'message': message}).encode()
                _, diagnostic = self.failure(HTTPError(payload()['callbackUrl'], 403,
                    'private-fixture', {}, io.BytesIO(raw)), {'type': operation})
                self.assertNotIn('requestId', diagnostic)
                self.assertNotIn('errorCode', diagnostic)
                self.assertNotIn('rejectionCause', diagnostic)
                self.assertEqual(diagnostic['operation'], 'unknown')

    def test_uuid_shaped_secret_and_standard_code_shaped_password_are_not_logged(self):
        tracking = '22222222-2222-4222-8222-222222222222'
        raw = json.dumps({'errorCode': 'FORBIDDEN', 'requestId': tracking}).encode()
        _, diagnostic = self.failure(HTTPError(payload()['callbackUrl'], 403,
            'private-fixture', {'X-Request-Id': tracking}, io.BytesIO(raw)),
            {'type': 'restore', 'password': 'FORBIDDEN'}, token=tracking)
        self.assertNotIn('requestId', diagnostic)
        self.assertNotIn('errorCode', diagnostic)

    def test_job_id_colliding_with_sensitive_input_is_omitted_without_changing_failure(self):
        for body, token in (({'type': 'finished', 'password': JOB_ID}, 'private-fixture-token'),
                ({'type': 'finished'}, JOB_ID)):
            with self.subTest(password_collision='password' in body), patch.object(connector, 'build_opener') as opener:
                raw = json.dumps({'errorCode': 'CONFLICT', 'requestId': JOB_ID}).encode()
                opener.return_value.open.side_effect = HTTPError(payload()['callbackUrl'], 409,
                    'private-fixture', {}, io.BytesIO(raw))
                output = io.StringIO()
                with contextlib.redirect_stdout(output), self.assertRaises(Stop) as stopped:
                    self.client(token).send(body)
                diagnostic = json.loads(output.getvalue())
                self.assertNotIn('jobId', diagnostic)
                self.assertNotIn('requestId', diagnostic)
                self.assertNotIn(JOB_ID, output.getvalue())
                self.assertEqual(diagnostic['event'], 'recharge_record_callback_failed')
                self.assertEqual(diagnostic['operation'], 'finished')
                self.assertEqual(diagnostic['httpStatus'], 409)
                self.assertEqual(stopped.exception.report['reason'], 'durable_state_unavailable')
                self.assertEqual(stopped.exception.report['callback_http_status'], 409)
                self.assertEqual(opener.return_value.open.call_count, 1)

    def test_log_sink_failure_preserves_original_stop(self):
        for sink in (RuntimeError('private-fixture-sink'), BrokenPipeError(), ValueError()):
            with self.subTest(sink=type(sink).__name__), patch.object(connector, 'build_opener') as opener:
                opener.return_value.open.side_effect = HTTPError(payload()['callbackUrl'], 403,
                    'private-fixture', {}, io.BytesIO(b'{}'))
                with patch('builtins.print', side_effect=sink), self.assertRaises(Stop) as stopped:
                    self.client().send({'type': 'restore'})
                self.assertEqual(stopped.exception.report['reason'], 'durable_state_unavailable')
                self.assertEqual(stopped.exception.report['callback_http_status'], 403)
                self.assertEqual(opener.return_value.open.call_count, 1)

    def test_fixed_guard_messages_map_only_to_safe_labels(self):
        for message, cause in (
                ('本机连接凭据无效', 'callback_credentials_rejected'),
                ('执行窗口已结束，请重新核验原订单', 'job_expired'),
                ('账户标识不一致', 'account_mismatch'),
                ('该账户属于另一操作人的原任务', 'account_owner_mismatch'),
                ('本次任务已绑定另一比特窗口，不能覆盖原窗口', 'profile_conflict'),
                ('原订单编号不一致', 'checkout_conflict')):
            with self.subTest(cause=cause):
                raw = json.dumps({'message': message}).encode()
                _, diagnostic = self.failure(HTTPError(payload()['callbackUrl'], 403,
                    'private-fixture', {}, io.BytesIO(raw)), {'type': 'finished',
                    'result': {'secret': 'private-fixture'}})
                self.assertEqual(diagnostic['operation'], 'finished')
                self.assertEqual(diagnostic['rejectionCause'], cause)

    def test_caller_deadline_returns_once_and_late_transport_never_logs_again(self):
        for late_error in (False, True):
            with self.subTest(late_error=late_error):
                release, returned = threading.Event(), threading.Event()
                def slow_open(*_args, **_kwargs):
                    release.wait(1)
                    try:
                        if late_error:
                            raise HTTPError(payload()['callbackUrl'], 409, 'private-fixture', {},
                                io.BytesIO(b'{"errorCode":"CONFLICT"}'))
                        return self.Response(b'{"success":true,"data":{"secret":"private-fixture"}}')
                    finally:
                        returned.set()
                output = io.StringIO()
                try:
                    with patch.object(connector, 'build_opener') as opener, contextlib.redirect_stdout(output):
                        opener.return_value.open.side_effect = slow_open
                        before = time.monotonic()
                        with self.assertRaises(Stop) as stopped:
                            self.client().send({'type': 'prepare_next_subscription_cycle', 'phase': 'status'},
                                deadline=before + .03)
                        self.assertLess(time.monotonic() - before, .25)
                        self.assertEqual(stopped.exception.report['callback_failure_kind'], 'timeout')
                        diagnostic = json.loads(output.getvalue())
                        self.assertEqual(diagnostic['phase'], 'status')
                        self.assertEqual(diagnostic['errorType'], 'TimeoutError')
                        first_output = output.getvalue()
                        release.set()
                        self.assertTrue(returned.wait(.5))
                        time.sleep(.01)
                        self.assertEqual(output.getvalue(), first_output)
                        self.assertEqual(opener.return_value.open.call_count, 1)
                        self.assertLessEqual(opener.return_value.open.call_args.kwargs['timeout'], .03)
                finally:
                    release.set()


class BitBrowserConnectorTests(unittest.TestCase):
    def test_local_api_never_uses_environment_proxy(self):
        class LocalApi(BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"success":true,"data":{"list":[]}}')

            def log_message(self, *_):
                pass

        with ThreadingHTTPServer(('127.0.0.1', 0), LocalApi) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            origin = 'http://127.0.0.1:%d' % server.server_port
            try:
                with patch.dict('os.environ', {'http_proxy': 'http://127.0.0.1:1'}, clear=True), \
                        patch('urllib.request.proxy_bypass', return_value=False):
                    # The previous transport sends even loopback through the proxy.
                    with self.assertRaises(Exception):
                        build_opener(connector.NoRedirect).open(Request(origin, data=b'{}'), timeout=1)
                    client = connector.BitBrowserClient(origin, 'synthetic-token-123456')
                    self.assertEqual(client.post('/group/list', {}), {'list': []})
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_local_api_http_rejections_preserve_auth_vs_connection_reason(self):
        client = connector.BitBrowserClient('http://127.0.0.1:54345', 'synthetic-token-123456')
        for status, reason in ((401, 'bitbrowser_api_token_invalid'), (403, 'bitbrowser_api_token_invalid'),
                               (500, 'bitbrowser_local_api_rejected')):
            with self.subTest(status=status), patch.object(connector, 'build_opener') as opener:
                opener.return_value.open.side_effect = HTTPError(client.base_url, status, 'synthetic', {}, None)
                with self.assertRaises(Stop) as error:
                    client.post('/group/list', {})
                self.assertEqual(error.exception.report['reason'], reason)
                self.assertNotIn('synthetic-token', str(error.exception.report))

    def test_restore_binds_only_valid_callback_original_checkout_and_never_changes_it(self):
        from types import SimpleNamespace
        for checkout_id in ('oaics_existing', 'cs_existing'):
            with self.subTest(checkout_id=checkout_id):
                job = connector.LocalJob(payload())
                job.callback.send = MagicMock(return_value={
                    'records': [], 'originalCheckoutIdentifier': checkout_id})
                job.restore_account(SimpleNamespace(account_id='fixture-account'))
                self.assertEqual(job.original_checkout_identifier, checkout_id)
                job.callback.send.return_value = {'records': [], 'originalCheckoutIdentifier': 'oaics_other'}
                with self.assertRaises(Stop) as stopped:
                    job.restore_account(SimpleNamespace(account_id='fixture-account'))
                self.assertEqual(stopped.exception.report['reason'], 'durable_state_unavailable')
                self.assertEqual(job.original_checkout_identifier, checkout_id)

    def test_restore_rejects_malformed_original_checkout_before_writing_records(self):
        from types import SimpleNamespace
        for checkout_id in ('upgrade_existing', 'oaics_', 'oaics_private?token=fixture',
                            'cs_' + 'x' * 201, 123, {}, True):
            with self.subTest(checkout_id=type(checkout_id).__name__):
                job = connector.LocalJob(payload())
                job.callback.send = MagicMock(return_value={
                    'records': [], 'originalCheckoutIdentifier': checkout_id})
                with patch.object(connector, 'write_json') as write, self.assertRaises(Stop) as stopped:
                    job.restore_account(SimpleNamespace(account_id='fixture-account'))
                self.assertEqual(stopped.exception.report['reason'], 'durable_state_unavailable')
                self.assertIsNone(job.original_checkout_identifier)
                write.assert_not_called()

    def test_restore_does_not_accept_original_checkout_from_launch_payload(self):
        value = {**payload(), 'originalCheckoutIdentifier': 'oaics_forged'}
        with self.assertRaises(Stop):
            connector.validate_payload(value)
        job = connector.LocalJob(payload())
        self.assertIsNone(job.original_checkout_identifier)

    def test_official_cleanup_acknowledgements_allow_strings_but_reads_stay_strict(self):
        client = connector.BitBrowserClient("http://127.0.0.1:54345", "b" * 32)
        with patch.object(connector, "build_opener") as opener:
            response = opener.return_value.open.return_value.__enter__.return_value
            for path in ("/browser/close", "/browser/delete"):
                for data in ("success", None, {}, True):
                    response.read.return_value = json.dumps({"success": True, "data": data}).encode()
                    self.assertEqual(client.post(path, {"id": "a" * 32}), {})
                response.read.return_value = b'{"success":false,"data":"failure"}'
                with self.assertRaises(Stop):
                    client.post(path, {"id": "a" * 32})
            response.read.return_value = b'{"success":true,"data":"unverified"}'
            for path in ("/browser/detail", "/browser/pids/alive"):
                with self.assertRaises(Stop):
                    client.post(path, {"id": "a" * 32})

    def test_payload_is_complete_and_card_is_valid_before_browser_side_effects(self):
        value = payload()
        self.assertIs(connector.validate_payload(value), value)
        for change in (
                {"authorizeSinglePayment": False},
                {"extra": "field"},
                {"details": {**value["details"], "number": "123"}},
                {"address": {**value["address"], "country": "invalid"}},
                {"safety": {**value["safety"], "manualPaymentConfirmation": False}},
                {"safety": {**value["safety"], "lockedCurrency": "INVALID"}},
                {"safety": {**value["safety"], "unknown": True}}):
            with self.subTest(change=change), self.assertRaises(Stop):
                connector.validate_payload({**value, **change})

    def test_launch_needs_no_payment_cap_and_ignores_legacy_cap_values(self):
        value = payload()
        self.assertNotIn('maxAmount', value['safety'])
        self.assertNotIn('maxAmountMinor', value['safety'])
        self.assertIs(connector.validate_payload(value), value)
        for legacy in ({'maxAmount': '1.00', 'maxAmountMinor': 1},
                       {'maxAmount': None, 'maxAmountMinor': -1},
                       {'maxAmount': 'unused'}, {'maxAmountMinor': False}):
            with self.subTest(legacy=list(legacy)):
                changed = {**value, 'safety': {**value['safety'], **legacy}}
                self.assertIs(connector.validate_payload(changed), changed)
        self.assertNotIn('max_amount', connector.public_result({'max_amount': '1.00'}))

    def test_recheck_payload_contains_no_card_address_or_payment_authorization(self):
        value = payload()
        recheck = {key: value[key] for key in (
            "id", "plan", "windowName", "sessionJson", "bitBrowser", "callbackUrl", "agentToken")}
        recheck["mode"] = "recheck"
        self.assertIs(connector.validate_payload(recheck), recheck)
        with self.assertRaises(Stop):
            connector.validate_payload({**recheck, "details": value["details"]})

    def test_open_browser_payload_contains_no_card_address_or_payment_authorization(self):
        value = payload()
        open_payload = {key: value[key] for key in (
            "id", "windowName", "sessionJson", "bitBrowser", "callbackUrl", "agentToken")}
        open_payload["mode"] = "open_browser"
        validated = connector.validate_payload(open_payload)
        self.assertEqual(validated["mode"], "open_browser")
        self.assertEqual(validated["plan"], "plus")
        for forbidden in ("details", "address", "safety", "authorizeSinglePayment"):
            with self.subTest(forbidden=forbidden), self.assertRaises(Stop):
                connector.validate_payload({**open_payload, forbidden: value.get(forbidden, True)})

    def test_password_login_payload_stays_local_and_requires_matching_billing_email(self):
        value = payload()
        value.pop("sessionJson")
        value["login"] = {"email": "test@example.invalid", "password": "local-only-password"}
        self.assertIs(connector.validate_payload(value), value)
        for changed in (
                {**value, "sessionJson": "forbidden"},
                {**value, "login": {"email": "test@example.invalid", "password": ""}},
                {**value, "details": {**value["details"], "email": "other@example.invalid"}},
                {**value, "login": {**value["login"], "code": "123456"}}):
            with self.subTest(changed=changed), self.assertRaises(Stop):
                connector.validate_payload(changed)
        self.assertNotIn("login", connector.public_result(value))

    def test_code_is_accepted_only_while_requested_and_never_sent_in_progress(self):
        value = payload()
        value.pop("sessionJson")
        value["login"] = {"email": "test@example.invalid", "password": "local-only-password"}
        job = connector.LocalJob(value)
        job.callback.send = MagicMock(return_value={})
        with self.assertRaises(Stop):
            job.signal_code("123456")

        async def scenario():
            waiting = asyncio.create_task(job.wait_for_code(2))
            for _ in range(50):
                if job.waiting_for_code:
                    break
                await asyncio.sleep(.005)
            job.signal_code("123456")
            self.assertEqual(await waiting, "123456")
            self.assertFalse(job.waiting_for_code)

        asyncio.run(scenario())
        self.assertNotIn("123456", str(job.callback.send.call_args_list))
        self.assertIsNone(job.login_code)

    def test_code_expiry_is_preserved_only_in_memory_until_the_original_waiter_receives_it(self):
        job = connector.LocalJob(payload())
        job.callback.send = MagicMock(return_value={})
        expiry = connector.datetime.fromtimestamp(101, connector.timezone.utc).isoformat()
        async def scenario():
            waiting = asyncio.create_task(job.wait_for_code(2))
            for _ in range(50):
                if job.waiting_for_code:
                    break
                await asyncio.sleep(.005)
            job.signal_code("123456", expiry)
            self.assertEqual(await waiting, {"code": "123456", "expiresAt": expiry})
        with patch.object(connector.time, "time", return_value=100):
            asyncio.run(scenario())
        self.assertIsNone(job.login_code)
        self.assertFalse(job.waiting_for_code)
        self.assertNotIn("123456", str(job.callback.send.call_args_list))
        self.assertNotIn(expiry, str(job.callback.send.call_args_list))
        self.assertNotIn("expiresAt", str(job.state()))

    def test_code_expired_while_queued_is_cleared_before_returning_to_the_browser(self):
        job = connector.LocalJob(payload())
        job.callback.send = MagicMock(return_value={})
        expiry = connector.datetime.fromtimestamp(101, connector.timezone.utc).isoformat()
        async def scenario(clock):
            waiting = asyncio.create_task(job.wait_for_code(2))
            for _ in range(50):
                if job.waiting_for_code:
                    break
                await asyncio.sleep(.005)
            job.signal_code("123456", expiry)
            queued = job.login_code
            clock.return_value = 102
            with self.assertRaises(Stop) as stopped:
                await waiting
            self.assertEqual(stopped.exception.report["reason"], "login_code_expired")
            self.assertEqual(queued, {})
        with patch.object(connector.time, "time", return_value=100) as clock:
            asyncio.run(scenario(clock))
        self.assertIsNone(job.login_code)
        self.assertFalse(job.waiting_for_code)

    def test_already_expired_code_wakes_the_original_waiter_for_manual_completion(self):
        job = connector.LocalJob(payload())
        job.callback.send = MagicMock(return_value={})
        expiry = connector.datetime.fromtimestamp(99, connector.timezone.utc).isoformat()
        async def scenario():
            waiting = asyncio.create_task(job.wait_for_code(2))
            for _ in range(50):
                if job.waiting_for_code:
                    break
                await asyncio.sleep(.005)
            with self.assertRaises(Stop) as stopped:
                job.signal_code("123456", expiry)
            self.assertEqual(stopped.exception.report["reason"], "login_code_expired")
            with self.assertRaises(Stop) as stopped:
                await waiting
            self.assertEqual(stopped.exception.report["reason"], "login_code_expired")
        with patch.object(connector.time, "time", return_value=100):
            asyncio.run(scenario())
        self.assertIsNone(job.login_code)
        self.assertFalse(job.waiting_for_code)

    def test_invalid_expiry_is_rejected_without_accepting_a_code(self):
        for expiry in (True, 1, "invalid", "2030-01-01T00:00:00", "" ):
            with self.subTest(expiry=expiry):
                job = connector.LocalJob(payload())
                job.waiting_for_code = True
                with self.assertRaises(Stop) as stopped:
                    job.signal_code("123456", expiry)
                self.assertEqual(stopped.exception.report["reason"], "invalid_login_code")
                self.assertIsNone(job.login_code)
                self.assertFalse(job.code_event.is_set())

    def test_unknown_payment_resolution_has_no_browser_session_or_payment_data(self):
        value = resolution_payload()
        self.assertIs(connector.validate_payload(value), value)
        for key in ("sessionJson", "bitBrowser", "details", "authorizeSinglePayment"):
            with self.subTest(key=key), self.assertRaises(Stop):
                connector.validate_payload({**value, key: "forbidden"})
        job = connector.LocalJob(value)
        job.callback.send = MagicMock(return_value={"ok": True})
        result = asyncio.run(job.execute())
        self.assertTrue(job.resolution_committed)
        self.assertEqual(result["payment_requests_sent"], 0)
        job.callback.send.assert_called_once_with({
            "type": "resolve_unknown_payment",
            "plan": "pro-20x",
            "accountKey": "c" * 64,
            "checkoutIdentifier": "oaics_historical",
            "sourceJobId": "22222222-2222-4222-8222-222222222222",
            "verificationJobId": "33333333-3333-4333-8333-333333333333",
        })

    def test_only_loopback_local_apis_and_job_bound_callbacks_are_allowed(self):
        self.assertEqual(
            connector.local_origin("http://127.0.0.1:54345", "api"),
            "http://127.0.0.1:54345")
        with self.assertRaises(Stop):
            connector.local_origin("https://remote.example", "api")
        with self.assertRaises(Stop):
            connector.callback_url(
                "https://admin.example/api/id-business-v2/auto-recharge/local/"
                "22222222-2222-4222-8222-222222222222",
                JOB_ID)

    def test_profile_uses_documented_dynamic_proxy_and_fixed_chinese_language(self):
        client = connector.BitBrowserClient("http://127.0.0.1:54345", "b" * 32)
        calls = []

        def post(path, body):
            calls.append((path, body))
            if path == "/group/list":
                return {"list": [{"id": "group_12345678", "groupName": "gpt账号注册"}]}
            if path == "/browserTag/list":
                return {"data": [{"id": "a" * 32, "tagName": "申请gpt"}]}
            return {"id": "b" * 32}

        client.post = post
        profile_id = client.create_profile(payload()["bitBrowser"], "申请gpt-001")

        self.assertEqual(profile_id, "b" * 32)
        body = calls[2][1]
        self.assertEqual(body["url"], "https://chatgpt.com/")
        self.assertEqual(body["platform"], "")
        self.assertEqual(body["name"], "申请gpt-001")
        self.assertEqual(body["remark"], "申请gpt")
        self.assertEqual(body["proxyMethod"], 3)
        self.assertTrue(body["isDynamicIpChangeIp"])
        self.assertEqual(body["dynamicIpUrl"], "https://proxy.example/secret")
        self.assertFalse(body["credentialsEnableService"])
        for key in ("syncTabs", "syncCookies", "syncLocalStorage", "syncIndexedDb", "syncAuthorization"):
            self.assertIs(body[key], False)
        self.assertFalse(body["browserFingerPrint"]["isIpCreateLanguage"])
        self.assertEqual(body["browserFingerPrint"]["languages"], "zh-CN")
        self.assertFalse(body["browserFingerPrint"]["isIpCreateDisplayLanguage"])
        self.assertEqual(calls[3], ("/browserTag/updateRelation", {
            "browserId": profile_id, "addTagIds": ["a" * 32], "removeTagIds": []
        }))

    def test_profile_sync_must_be_verified_before_opening(self):
        client = connector.BitBrowserClient("http://127.0.0.1:54345", "b" * 32)
        safe = {"id": "profile_12345678", **dict.fromkeys((
            "syncTabs", "syncCookies", "syncLocalStorage", "syncIndexedDb", "syncAuthorization"), False)}
        for key in safe:
            for value in (True, None, "false", 0):
                client.post = MagicMock(return_value={**safe, key: value})
                with self.subTest(key=key, value=value), self.assertRaises(Stop):
                    client.open_profile(safe["id"])
                client.post.assert_called_once_with("/browser/detail", {"id": safe["id"]})
        client.post = MagicMock(side_effect=[safe, {"ws": "ws://127.0.0.1:9222/devtools/browser/test"}])
        self.assertTrue(client.open_profile(safe["id"]).startswith("ws://127.0.0.1"))
        self.assertEqual(client.post.call_args.args[0], "/browser/open")

    def test_profile_inventory_returns_only_verified_exact_ids(self):
        client = connector.BitBrowserClient("http://127.0.0.1:54345", "b" * 32)
        client.post = MagicMock(return_value={"list": [{"id": "a" * 32}, {"id": "b" * 32}]})
        self.assertEqual(client.list_profile_ids(), {"a" * 32, "b" * 32})
        client.post.assert_called_once_with("/browser/list", {"page": 0, "pageSize": 100})
        client.post = MagicMock(return_value={"list": [{"id": "not-a-profile"}]})
        with self.assertRaises(Stop):
            client.list_profile_ids()

    def test_profile_inventory_rejects_incomplete_counts_duplicates_and_non_hex_ids(self):
        client = connector.BitBrowserClient("http://127.0.0.1:54345", "b" * 32)
        for data in ({"list": [], "total": 1},
                     {"list": [{"id": "a" * 32}, {"id": "a" * 32}]},
                     {"list": [{"id": "z" * 32}]},
                     {"list": [], "total": True},
                     {"list": [], "total": 2001}):
            with self.subTest(data=data), self.assertRaises(Stop):
                client.post = MagicMock(return_value=data)
                client.list_profile_ids()
        rows = [{"id": format(i, "032x")} for i in range(100)]
        client.post = MagicMock(side_effect=[{"list": rows, "total": 100},
                                            {"list": [], "total": 101}])
        with self.assertRaises(Stop):
            client.list_profile_ids()
        client.post = MagicMock(return_value={"list": rows})
        with self.assertRaises(Stop):
            client.list_profile_ids()

    def test_profile_inventory_checks_all_pages_before_confirming_absence(self):
        client = connector.BitBrowserClient("http://127.0.0.1:54345", "b" * 32)
        rows = [{"id": format(i, "032x")} for i in range(100)]
        client.post = MagicMock(side_effect=[{"list": rows, "total": 101},
                                            {"list": [{"id": "a" * 32}], "total": 101}])
        self.assertIn("a" * 32, client.list_profile_ids())
        self.assertEqual([call.args[1]["page"] for call in client.post.call_args_list], [0, 1])

    def test_currency_amount_and_tax_guards_run_before_payment(self):
        job = connector.LocalJob(payload())
        job.progress = MagicMock()
        job.callback.send = MagicMock(return_value={})
        money = {"amount": "20.00", "amount_minor": 2000, "currency": "USD"}
        quote = {
            "plan": "plus",
            "today": money,
            "tax": {"amount": "0.00", "amount_minor": 0, "currency": "USD"},
            "renewal": money,
            "renewal_interval": "monthly",
        }
        self.assertTrue(confirmed(job, quote, "4444"))
        job.progress.assert_called_once()
        with self.assertRaises(Stop):
            job.confirm({**quote, "today": {**money, "currency": "PHP"}}, "4444")
        with self.assertRaises(Stop):
            job.confirm({**quote, "today": {**money, "amount": "40.00", "amount_minor": 4000}}, "4444")
        with self.assertRaises(Stop):
            job.confirm({**quote, "tax": None}, "4444")

    def test_actual_confirmation_waits_and_nonce_is_single_use_quote_bound(self):
        value = payload()
        value['safety'].update(maxAmount='30.00', maxAmountMinor=3000)
        job = connector.LocalJob(value)
        job.account_key = "c" * 64
        job.callback.send = MagicMock(return_value={})
        amount = {"currency": "USD", "amount_minor": 4000, "amount": "40.00"}
        quote = {"plan": "plus", "today": amount, "renewal": amount,
                 "tax": {"currency": "USD", "amount_minor": 0, "amount": "0.00"},
                 "renewal_interval": "monthly"}
        outcome = []
        thread = threading.Thread(target=lambda: outcome.append(job.confirm(quote, "4444")))
        thread.start()
        for _ in range(100):
            if job.state()["status"] == "awaiting_confirmation":
                break
            time.sleep(.005)
        state = job.state()["result"]
        self.assertTrue(thread.is_alive())
        self.assertFalse(job.payment_request_sent)
        with self.assertRaises(Stop):
            job.signal_confirm(state["nonce"], "f" * 64)
        with self.assertRaises(Stop):
            job.signal_confirm("wrong", state["quote_digest"])
        job.signal_resume()
        self.assertTrue(thread.is_alive())
        self.assertNotIn(state["nonce"], str(job.callback.send.call_args_list))
        job.signal_confirm(state["nonce"], state["quote_digest"])
        thread.join(1)
        self.assertEqual(outcome, [True])
        self.assertFalse(job.payment_request_sent)
        self.assertEqual(job.state()['result']['payment_requests_sent'], 0)
        with self.assertRaises(Stop):
            job.signal_confirm(state["nonce"], state["quote_digest"])
        with self.assertRaises(Stop):
            job.confirm(quote, "4444")
        self.assertNotIn("nonce", job.state()["result"])

    def test_confirmation_account_binding_and_expiry_cannot_be_reused(self):
        amount = {"currency": "USD", "amount_minor": 2000, "amount": "20.00"}
        quote = {"plan": "plus", "today": amount, "renewal": amount,
                 "tax": {"currency": "USD", "amount_minor": 0, "amount": "0.00"},
                 "renewal_interval": "monthly"}
        for change in ("account", "quote", "expiry"):
            job = connector.LocalJob(payload())
            job.account_key = "c" * 64
            def callback(body):
                if body.get("result", {}).get("status") != "awaiting_confirmation":
                    return {}
                state = job.state()["result"]
                if change == "account":
                    job.account_key = "d" * 64
                elif change == "quote":
                    quote["today"] = {**amount, "amount_minor": 2100, "amount": "21.00"}
                else:
                    job.pending_confirmation["expires_at"] = time.time() - 1
                try:
                    job.signal_confirm(state["nonce"], state["quote_digest"])
                except Stop:
                    job.cancelled = True
                    job.confirmation_event.set()
                return {}
            job.callback.send = callback
            with self.subTest(change=change), self.assertRaises(Stop):
                job.confirm(quote, "4444")
            self.assertFalse(job.payment_request_sent)
            quote["today"] = amount

    def test_retired_registration_role_and_payload_cannot_use_recharge_registry(self):
        with self.assertRaisesRegex(ValueError, "unsupported connector role"):
            connector.Registry("registration")
        recharge = connector.Registry("recharge")
        with self.assertRaises(Stop):
            recharge.start({"mode": "registration", "id": JOB_ID})
        self.assertEqual(recharge.jobs, {})

    def test_health_and_authenticated_http_confirmation_use_dedicated_role(self):
        job = connector.LocalJob(payload())
        job.account_key = "c" * 64
        job.callback.send = MagicMock(return_value={})
        amount = {"currency": "USD", "amount_minor": 2000, "amount": "20.00"}
        quote = {"plan": "plus", "today": amount, "renewal": amount,
                 "tax": {"currency": "USD", "amount_minor": 0, "amount": "0.00"},
                 "renewal_interval": "monthly"}
        outcome = []
        thread = threading.Thread(target=lambda: outcome.append(job.confirm(quote, "4444")))
        thread.start()
        for _ in range(100):
            if job.state()["status"] == "awaiting_confirmation":
                break
            time.sleep(.005)
        registry = connector.Registry("recharge")
        registry.jobs[job.id] = job
        handler = object.__new__(connector.Handler)
        handler.allowed_origins = {"https://admin.example"}
        handler.connector_token = "fixture-connector"
        handler.headers = {"Origin": "https://admin.example", "X-Auto-Recharge-Connector": "fixture-connector"}
        handler.reply = MagicMock()
        with patch.object(connector, 'REGISTRY', registry):
            handler.path = '/health'
            handler.do_GET()
            health = handler.reply.call_args.args[1]
            self.assertEqual(health['version'], 4)
            self.assertEqual(health['role'], 'recharge')
            self.assertIn('manual-payment-confirmation', health['capabilities'])
            self.assertIn('recharge-process-isolation', health['capabilities'])
            self.assertNotIn('account-registration', health['capabilities'])
            handler.path = '/jobs/' + job.id
            handler.do_GET()
            state = handler.reply.call_args.args[1]['result']
            handler.path += '/confirm'
            body = json.dumps({'nonce': state['nonce'], 'quoteDigest': state['quote_digest']}).encode()
            handler.headers['Content-Length'] = str(len(body))
            handler.rfile = io.BytesIO(body)
            handler.do_POST()
            self.assertEqual(handler.reply.call_args.args, (200, {'ok': True}))
            handler.rfile = io.BytesIO(body)
            handler.do_POST()
            self.assertEqual(handler.reply.call_args.args[0], 409)
        thread.join(1)
        self.assertEqual(outcome, [True])

    def test_command_default_and_recharge_role_use_only_dedicated_recharge_port(self):
        for argv in ([], ['--role', 'recharge']):
            with (patch.object(connector, 'ThreadingHTTPServer') as server,
                  patch.object(connector, 'load_connector_token', return_value='fixture') as token,
                  patch.object(connector, 'REGISTRY', connector.Registry('recharge')),
                  contextlib.redirect_stdout(io.StringIO())):
                connector.main([*argv, '--allowed-origin', 'https://admin.example'])
                server.assert_called_once_with(('127.0.0.1', 55322), connector.Handler)
                self.assertIn('bitbrowser-recharge-assistant', str(token.call_args.args[0]))
                self.assertEqual(connector.REGISTRY.role, 'recharge')

    def test_retired_registration_cli_role_is_rejected_before_token_or_listener(self):
        with (patch.object(connector, 'ThreadingHTTPServer') as server,
              patch.object(connector, 'load_connector_token') as token,
              contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit)):
            connector.main(['--role', 'registration', '--allowed-origin', 'https://admin.example'])
        server.assert_not_called()
        token.assert_not_called()

    def test_recharge_assistant_imports_without_server_browser_dependencies(self):
        folder = Path(__file__).resolve().parent
        script = """import builtins,sys
sys.path.insert(0,sys.argv[1])
original = builtins.__import__
def minimal(name,*args,**kwargs):
    if name.split('.')[0] in {'camoufox','browserforge','numpy','fingerprint_runtime','server','playwright'}:
        raise ImportError('server browser dependency unavailable')
    return original(name,*args,**kwargs)
builtins.__import__ = minimal
import bitbrowser_connector
assert bitbrowser_connector.Registry('recharge').role == 'recharge'
"""
        result = subprocess.run([sys.executable, '-I', '-c', script, str(folder)],
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        lock = (folder / 'requirements-bitbrowser.lock.txt').read_text()
        for unused in ('camoufox', 'browserforge', 'numpy'):
            self.assertNotIn(unused, lock)

    def test_real_billing_address_is_not_fixed_to_one_fixture_city(self):
        value = payload()
        value["address"] = {**value["address"], "country": "PH", "city": "Manila",
                            "state": "Metro Manila", "postalCode": "1000", "line1": "Synthetic street"}
        self.assertIs(connector.validate_payload(value), value)
        for authorized in (False, None):
            with self.assertRaises(Stop):
                connector.validate_payload({**value, "safety": {
                    **value["safety"], "manualPaymentConfirmation": authorized}})

    def test_payment_progress_never_falls_back_to_zero_attempts(self):
        job = connector.LocalJob(payload())
        job.callback.send = MagicMock(return_value={})
        job.progress("payment_request_sending", attempt=1)
        report = job.callback.send.call_args.args[0]["result"]
        self.assertTrue(report["payment_attempted"])
        self.assertEqual(report["payment_requests_sent"], 1)

    def test_human_verification_keeps_the_same_job_waiting_until_explicit_resume(self):
        job = connector.LocalJob(payload())
        job.callback.send = MagicMock(return_value={})

        async def scenario():
            waiting = asyncio.create_task(job.wait_for_user("verification_required", 2))
            for _ in range(20):
                if job.waiting_for_user:
                    break
                await asyncio.sleep(0.005)
            self.assertTrue(job.waiting_for_user)
            job.signal_resume()
            await waiting
            self.assertFalse(job.waiting_for_user)

        asyncio.run(scenario())

    def test_public_results_never_include_local_secrets_or_card_data(self):
        self.assertEqual(
            connector.public_result({
                "status": "blocked",
                "sessionJson": "private",
                "localApiToken": "private",
                "dynamicProxyUrl": "private",
                "details": {"cvc": "123"},
            }),
            {"status": "blocked"})

    def test_public_result_preserves_bounded_session_diagnostics(self):
        diagnostics = {
            "session_cookie_sent": True,
            "session_cookie_format": "chunked",
            "official_session_http_status": 200,
            "official_session_user_present": True,
            "official_session_access_token_present": True,
            "access_token_expires_at": 1799999990,
            "credential_checked_at": 1800000000,
            "access_token_seconds_remaining": -10,
            "auth_session_writes_blocked": 0,
        }
        self.assertEqual(connector.public_result({**diagnostics, "cookie": "private",
                         "accessToken": "private"}), diagnostics)

    def test_public_session_diagnostics_reject_arbitrary_secret_values(self):
        for value in ("private", {"token": "private"}, ["private"], None):
            with self.subTest(value_type=type(value).__name__):
                self.assertEqual(connector.public_result({
                    key: value for key in (
                        "session_cookie_sent", "official_session_user_present",
                        "official_session_access_token_present", "official_session_http_status",
                        "access_token_expires_at", "credential_checked_at",
                        "access_token_seconds_remaining", "auth_session_writes_blocked",
                        "session_cookie_format")}), {})
        self.assertEqual(connector.public_result({"official_session_http_status": True,
                         "auth_session_writes_blocked": -1, "credential_checked_at": 0}), {})




class CompletedJobResourceTests(unittest.TestCase):
    class InertThread:
        def __init__(self, **_kwargs):
            pass

        def start(self):
            pass

    def next_payload(self, number):
        value = payload()
        value['id'] = f'{number:08x}-1111-4111-8111-111111111111'
        value['callbackUrl'] = 'https://admin.example/api/id-business-v2/auto-recharge/local/' + value['id']
        return value

    def test_one_thousand_completed_calls_release_full_objects_and_real_temporary_state(self):
        registry, refs, folders = connector.Registry(), [], []
        statuses = ('subscription_activated', 'blocked', 'cancelled', 'payment_result_unknown')

        async def inert_execute(job):
            job.context = object()
            job.revisions['fixture'] = 1
            folders.append(job.root)
            (job.root / 'fixture-public-state').write_text('synthetic-public-state')
            status = statuses[int(job.id[:8], 16) % len(statuses)]
            job.payment_request_sent = status in {'subscription_activated', 'payment_result_unknown'}
            return {'status': status, 'payment_status': 'paid' if status == 'subscription_activated'
                    else 'unknown' if job.payment_request_sent else 'not_attempted'}

        with (patch.object(connector.threading, 'Thread', self.InertThread),
              patch.object(connector.LocalJob, 'execute', inert_execute),
              patch.object(connector.CallbackClient, 'send', return_value={'ok': True}) as callback,
              patch.object(connector, 'BitBrowserClient') as browser):
            for number in range(1, 1001):
                job = registry.start(self.next_payload(number))
                refs.append(weakref.ref(job))
                registry._run(job)
                self.assertEqual(job.payload, {})
                self.assertIsNone(job.root)
                self.assertIsNone(job.context)
                self.assertEqual(job.revisions, {})
                self.assertEqual(job.callback.token, '')
                self.assertEqual(job.callback.url, '')
                if number in (100, 1000):
                    self.assertLessEqual(len(registry.jobs), connector.MAX_COMPLETED_JOBS)
                    self.assertTrue(all(isinstance(item, connector.CompletedJob)
                                        for item in registry.jobs.values()))
                    self.assertFalse(registry.busy())
            self.assertEqual(callback.call_count, 1000)
            browser.assert_not_called()
        del job
        gc.collect()
        self.assertTrue(all(ref() is None for ref in refs))
        self.assertTrue(all(not folder.exists() for folder in folders))

    def test_completed_snapshot_is_scalar_bounded_and_drops_quotes_nonces_and_credentials(self):
        job = connector.LocalJob(payload())
        job.result = {'status': 'blocked', 'reason': 'public_reason', 'nonce': 'synthetic-private',
                      'password': 'synthetic-private', 'quote': {'nested': 'synthetic-private'},
                      'payment_evidence': {'nested': 'synthetic-private'},
                      'stage': 'x' * 221, 'browser_profile_id': 'b' * 32,
                      'payment_requests_sent': 1, 'payment_status': 'unknown'}
        completed = connector.CompletedJob(job, 100)
        self.assertEqual(completed.state()['result'], {
            'status': 'blocked', 'reason': 'public_reason', 'browser_profile_id': 'b' * 32,
            'payment_requests_sent': 1, 'payment_status': 'unknown'})
        self.assertFalse(hasattr(completed, 'payload'))
        self.assertFalse(hasattr(completed, 'context'))
        self.assertFalse(hasattr(completed, 'callback'))

    def test_duplicate_completed_id_returns_snapshot_without_starting_a_thread(self):
        registry = connector.Registry()
        job = connector.LocalJob(payload())
        job.done = True
        job.finished_callback_acknowledged = True
        job.result = {'status': 'subscription_activated'}
        completed = connector.CompletedJob(job, time.monotonic())
        registry.jobs[job.id] = completed
        with patch.object(connector.threading, 'Thread') as thread:
            self.assertIs(registry.start(payload()), completed)
            thread.assert_not_called()

    def test_finished_callback_failure_keeps_only_protected_summary_until_lease_has_expired(self):
        registry = connector.Registry()
        value = self.next_payload(1)

        async def inert_execute(job):
            job.payment_request_sent = True
            return {'status': 'payment_result_unknown', 'payment_status': 'unknown'}

        with (patch.object(connector.threading, 'Thread', self.InertThread),
              patch.object(connector.LocalJob, 'execute', inert_execute),
              patch.object(connector.CallbackClient, 'send', side_effect=Stop('durable_state_unavailable')),
              patch.object(connector.time, 'monotonic', return_value=100)):
            job = registry.start(value)
            registry._run(job)
            completed = registry.get(job.id)
            self.assertIsInstance(completed, connector.CompletedJob)
            self.assertFalse(completed.acknowledged)
            self.assertEqual(completed.state()['result']['payment_status'], 'unknown')
            self.assertEqual(job.payload, {})
        with patch.object(connector.time, 'monotonic', return_value=100 + 45 * 60):
            self.assertIs(registry.start(self.next_payload(1)), completed)
        with patch.object(connector.time, 'monotonic', return_value=completed.expires_at):
            self.assertIsNone(registry.get(job.id))

    def test_unconfirmed_capacity_never_evicts_uncertain_ids_to_make_room(self):
        registry = connector.Registry()
        with patch.object(connector.time, 'monotonic', return_value=100):
            for number in range(1, connector.MAX_COMPLETED_JOBS + 1):
                job = connector.LocalJob(self.next_payload(number))
                registry.jobs[job.id] = connector.CompletedJob(job, 100)
            self.assertTrue(registry.busy())
            with self.assertRaises(Stop) as stopped:
                registry.start(self.next_payload(connector.MAX_COMPLETED_JOBS + 1))
            self.assertEqual(stopped.exception.report['reason'], 'another_local_job_is_running')
            self.assertEqual(len(registry.jobs), connector.MAX_COMPLETED_JOBS)
            self.assertIs(registry.start(self.next_payload(1)), registry.get(self.next_payload(1)['id']))

    def test_done_during_final_callback_is_still_busy_until_run_returns(self):
        registry, entered, released = connector.Registry(), threading.Event(), threading.Event()

        def finish(job):
            job.done = True
            job.result = {'status': 'blocked'}
            entered.set()
            released.wait(2)
            job.finished_callback_acknowledged = True

        with patch.object(connector.LocalJob, 'run', finish):
            job = registry.start(self.next_payload(1))
            try:
                self.assertTrue(entered.wait(1))
                self.assertTrue(registry.busy())
                with self.assertRaises(Stop):
                    registry.start(self.next_payload(2))
            finally:
                released.set()
            for _ in range(100):
                if isinstance(registry.get(job.id), connector.CompletedJob):
                    break
                time.sleep(.005)
            self.assertIsInstance(registry.get(job.id), connector.CompletedJob)
            self.assertFalse(registry.busy())

    def test_unexpected_worker_failure_retires_secrets_and_keeps_unknown_payment_guard(self):
        for attempted in (False, True):
            with self.subTest(attempted=attempted):
                registry = connector.Registry()
                with patch.object(connector.threading, 'Thread', self.InertThread):
                    job = registry.start(self.next_payload(1))
                job.payment_request_sent = attempted
                with patch.object(job, 'run', side_effect=RuntimeError('synthetic-private-error')):
                    registry._run(job)
                completed = registry.get(job.id)
                self.assertIsInstance(completed, connector.CompletedJob)
                self.assertFalse(completed.acknowledged)
                self.assertEqual(completed.result, {
                    'status': 'blocked', 'reason': 'local_browser_operation_failed',
                    'payment_attempted': attempted, 'payment_requests_sent': int(attempted),
                    'payment_status': 'unknown' if attempted else 'not_attempted'})
                self.assertEqual(job.payload, {})
                self.assertEqual(job.callback.token, '')
                self.assertEqual(job.callback.url, '')
                self.assertIsNone(job.context)
                self.assertFalse(registry.busy())

    def test_thread_start_failure_drops_unstarted_job_and_releases_its_payload(self):
        registry = connector.Registry()
        value = self.next_payload(1)
        with patch.object(connector.threading, 'Thread') as thread:
            thread.return_value.start.side_effect = RuntimeError('synthetic-private-error')
            with self.assertRaises(Stop) as stopped:
                registry.start(value)
        self.assertEqual(stopped.exception.report['reason'], 'local_browser_operation_failed')
        self.assertEqual(registry.jobs, {})
        self.assertEqual(value, {})
        self.assertFalse(registry.busy())

    def test_terminal_http_actions_cannot_resume_confirm_cancel_or_supply_codes(self):
        registry = connector.Registry()
        job = connector.LocalJob(payload())
        registry.jobs[job.id] = connector.CompletedJob(job, time.monotonic())
        handler = object.__new__(connector.Handler)
        handler.headers = {'Origin': 'https://admin.example', 'X-Auto-Recharge-Connector': 'fixture'}
        handler.allowed_origins = {'https://admin.example'}
        handler.connector_token = 'fixture'
        handler.reply = MagicMock()
        with patch.object(connector, 'REGISTRY', registry):
            handler.path = '/jobs/' + job.id
            handler.do_GET()
            self.assertTrue(handler.reply.call_args.args[1]['done'])
            for action in ('resume', 'cancel', 'code', 'confirm'):
                handler.path = '/jobs/' + job.id + '/' + action
                handler.headers['Content-Length'] = '2'
                handler.rfile = io.BytesIO(b'{}')
                handler.do_POST()
                self.assertEqual(handler.reply.call_args.args[0], 409)


class ConnectorLeaseGateTests(unittest.IsolatedAsyncioTestCase):
    async def test_evicted_terminal_id_checks_api_before_json_or_password_browser_actions(self):
        for method in ('json', 'password'):
            for mode in ('payment', 'recheck', 'open_browser'):
                with self.subTest(method=method, mode=mode):
                    value = payload()
                    value['mode'] = mode
                    if mode != 'payment':
                        for key in ('details', 'address', 'safety', 'authorizeSinglePayment'):
                            value.pop(key)
                    if method == 'password':
                        value.pop('sessionJson')
                        value['login'] = {'email': 'test@example.invalid', 'password': 'synthetic-password'}
                    job = connector.LocalJob(value)
                    job.callback.send = MagicMock(side_effect=Stop('durable_state_unavailable'))
                    with (patch.object(connector, 'parse_browser_credential') as parse,
                          patch.object(connector, 'BitBrowserClient') as browser,
                          patch.object(connector.bitbrowser_retry, 'execute_profiles', AsyncMock()) as execute):
                        with self.assertRaises(Stop):
                            await job.execute()
                        self.assertEqual(job.callback.send.call_args.args[0]['type'], 'progress')
                        self.assertEqual(job.callback.send.call_args.args[0]['result']['stage'], 'connector_dispatch')
                        parse.assert_not_called()
                        browser.assert_not_called()
                        execute.assert_not_awaited()

    async def test_invalid_progress_acknowledgement_does_not_start_browser(self):
        job = connector.LocalJob(payload())
        job.callback.send = MagicMock(return_value={})
        with patch.object(connector, 'BitBrowserClient') as browser:
            with self.assertRaises(Stop):
                await job.execute()
            browser.assert_not_called()

    async def test_resolution_reuses_original_short_lease_callback_and_never_opens_browser(self):
        job = connector.LocalJob(resolution_payload())
        job.callback.send = MagicMock(return_value={'ok': True})
        with patch.object(connector, 'BitBrowserClient') as browser:
            result = await job.execute()
        self.assertEqual(job.callback.send.call_count, 1)
        self.assertEqual(job.callback.send.call_args.args[0]['type'], 'resolve_unknown_payment')
        self.assertEqual(result['status'], 'payment_unknown_resolved')
        self.assertTrue(connector.CompletedJob(job, time.monotonic()).acknowledged)
        browser.assert_not_called()


if __name__ == "__main__":
    unittest.main()
