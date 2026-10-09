import io
import json
import unittest
from unittest.mock import MagicMock, patch

import bitbrowser_connector as connector
from checkout_core import Stop


class ConnectorHealthTests(unittest.TestCase):
    def handler(self):
        handler = object.__new__(connector.Handler)
        handler.path = '/health'
        handler.headers = {'Origin': 'https://admin.example'}
        handler.allowed_origins = {'https://admin.example'}
        handler.reply = MagicMock()
        return handler

    def test_health_identifies_version_origin_and_capabilities_without_side_effects(self):
        handler = self.handler()
        with patch.object(connector.REGISTRY, 'jobs', {}), patch.object(connector.REGISTRY, 'start') as start:
            handler.do_GET()
            handler.reply.assert_called_once_with(200, {
                'ok': True, 'version': 4, 'service': 'id-business-v2-auto-recharge-connector',
                'role': 'recharge',
                'capabilities': [
                    'browser-catalog', 'browser-options', 'browser-profile-v2', 'session-load-retry',
                    'same-window-page-refresh', 'password-login', 'login-code',
                    'manual-payment-confirmation', 'recharge-process-isolation',
                    'payment-unknown-resolution',
                    'prepayment-page-recovery', 'stale-owned-profile-cleanup',
                    'same-profile-proxy-recovery', 'json-page-ready',
                ], 'originAllowed': True, 'busy': False
            })
            start.assert_not_called()

    def test_health_reports_disallowed_origin_and_busy_job(self):
        handler = self.handler()
        handler.headers = {'Origin': 'https://other.example'}
        with patch.object(connector.REGISTRY, 'jobs', {'fixture': MagicMock(done=False)}):
            handler.do_GET()
        self.assertFalse(handler.reply.call_args.args[1]['originAllowed'])
        self.assertTrue(handler.reply.call_args.args[1]['busy'])

    def test_origin_and_token_rejections_never_start_a_job_or_echo_credentials(self):
        for origin, reason in [('https://other.example', 'connector_origin_not_allowed'),
                               ('https://admin.example', 'connector_token_invalid')]:
            handler = self.handler()
            handler.path = '/jobs'
            handler.headers = {'Origin': origin, 'X-Auto-Recharge-Connector': 'fixture-wrong'}
            handler.connector_token = 'fixture-correct'
            handler.rfile = io.BytesIO(b'{}')
            with patch.object(connector.REGISTRY, 'start') as start:
                handler.do_POST()
                start.assert_not_called()
            handler.reply.assert_called_once_with(403, {'ok': False, 'reason': reason})

    def test_removed_registration_payload_cannot_start_or_reuse_a_recharge_job(self):
        registry = connector.Registry()
        previous = MagicMock(done=False)
        registry.jobs['fixture-id'] = previous
        with (patch.object(connector, 'LocalJob') as create,
              patch.object(connector.threading, 'Thread') as thread):
            for job_id in ('fixture-id', 'new-id'):
                with self.subTest(job_id=job_id), self.assertRaises(Stop) as stopped:
                    registry.start({'id': job_id, 'mode': 'registration'})
                self.assertEqual(stopped.exception.report['reason'], 'invalid_connector_payload')
            create.assert_not_called()
            thread.assert_not_called()
        self.assertEqual(registry.jobs, {'fixture-id': previous})
        self.assertEqual(previous.mock_calls, [])

    def test_recharge_resume_cancel_and_login_code_routes_still_signal_original_job(self):
        job_id = '11111111-1111-4111-8111-111111111111'
        for action, body, method, args in (
                ('code', {'code': '123456'}, 'signal_code', ('123456',)),
                ('resume', {}, 'signal_resume', ()),
                ('cancel', {}, 'signal_cancel', ())):
            with self.subTest(action=action):
                job = MagicMock()
                handler = self.handler()
                handler.path = f'/jobs/{job_id}/{action}'
                data = json.dumps(body).encode()
                handler.connector_token = 'fixture-connector-authentication'
                handler.headers.update({'X-Auto-Recharge-Connector': handler.connector_token,
                                        'Content-Length': str(len(data))})
                handler.rfile = io.BytesIO(data)
                with patch.object(connector.REGISTRY, 'get', return_value=job):
                    handler.do_POST()
                handler.reply.assert_called_once_with(200, {'ok': True})
                getattr(job, method).assert_called_once_with(*args)

    def test_registration_code_metadata_is_rejected_for_recharge_job(self):
        job = MagicMock()
        handler = self.handler()
        handler.path = '/jobs/11111111-1111-4111-8111-111111111111/code'
        data = b'{"code":"123456","attempt":1,"step":"email_code"}'
        handler.connector_token = 'fixture-connector-authentication'
        handler.headers.update({'X-Auto-Recharge-Connector': handler.connector_token,
                                'Content-Length': str(len(data))})
        handler.rfile = io.BytesIO(data)
        with patch.object(connector.REGISTRY, 'get', return_value=job):
            handler.do_POST()
        handler.reply.assert_called_once_with(409, {'ok': False, 'reason': 'invalid_login_code'})
        job.signal_code.assert_not_called()


if __name__ == '__main__':
    unittest.main()
