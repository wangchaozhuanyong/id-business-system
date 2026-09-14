import io
import unittest
from unittest.mock import MagicMock, patch

import bitbrowser_connector as connector


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
                'ok': True, 'version': 2, 'service': 'id-business-v2-auto-recharge-connector',
                'capabilities': [
                    'browser-catalog', 'browser-options', 'session-load-retry',
                    'same-window-page-refresh', 'payment-unknown-resolution'
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


if __name__ == '__main__':
    unittest.main()
