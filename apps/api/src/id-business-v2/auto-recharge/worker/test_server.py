import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import server
from checkout_core import Stop


class ServerTests(unittest.TestCase):
    def test_diagnostics_survive_callback_without_free_text_or_secrets(self):
        safe = {'step': 'choose_tier', 'error_type': 'TimeoutError', 'role': 'radio',
                'matched_count': 0, 'enabled': False, 'available_plans': ['plus']}
        value = {**safe, 'message': 'sessionToken=private', 'html': '<input value="123">',
                 'available_plans': ['plus', 'private']}
        self.assertEqual(server.public_result({'diagnostics': value}), {'diagnostics': safe})
        self.assertEqual(server.public_result({'diagnostics': {'step': [], 'role': {}, 'error_type': 'private'}}), {'diagnostics': {}})

    def test_no_credential_fields_in_public_result(self):
        result = server.public_result({'status': 'blocked', 'accessToken': 'private',
            'sessionToken': 'private', 'details': {'cvc': 'private'}, 'cookie': 'private'})
        self.assertEqual(result, {'status': 'blocked'})

    def test_confirm_requires_current_nonce_and_only_once(self):
        job = server.Job('test', {})
        job.nonce = 'a' * 64
        with self.assertRaises(Stop):
            job.signal('b' * 64)
        self.assertFalse(job.confirmed)
        job.signal('a' * 64)
        self.assertTrue(job.confirmed)
        with self.assertRaises(Stop):
            job.signal('a' * 64)

    def test_confirmation_waits_for_web_action(self):
        job = server.Job('test', {})
        seen = []
        with patch.object(server, 'callback', side_effect=lambda _, body: seen.append(body)):
            result = []
            thread = threading.Thread(target=lambda: result.append(job.confirm({'plan': 'plus'}, '0000')))
            thread.start()
            for _ in range(1000):
                if job.nonce:
                    break
                threading.Event().wait(.001)
            self.assertFalse(result)
            job.signal(job.nonce)
            thread.join(2)
            self.assertEqual(result, [True])
            self.assertEqual(seen[0]['type'], 'confirmation')

    def test_cancel_does_not_authorize_payment(self):
        job = server.Job('test', {})
        job.nonce = 'a' * 64
        job.signal(cancel=True)
        self.assertFalse(job.confirmed)

    def test_durable_revision_ack_required(self):
        job = server.Job('test', {})
        job.account_key = 'b' * 64
        with tempfile.TemporaryDirectory() as folder:
            job.root = Path(folder)
            path = job.root / ('b' * 64 + '.json')
            with patch.object(server, 'callback', side_effect=Stop('durable_state_unavailable')):
                with self.assertRaises(Stop):
                    job.persist(path, {'status': 'checkout_attempted'})
            self.assertEqual(job.revisions, {})
            with patch.object(server, 'callback', return_value={'revision': 1}) as callback:
                job.persist(path, {'status': 'checkout_attempted'})
            self.assertEqual(callback.call_args.args[1]['revision'], 0)
            self.assertEqual(job.revisions[path.name], 1)

    def test_invalid_record_path_cannot_write(self):
        job = server.Job('test', {})
        job.root = Path('/tmp')
        with patch.object(server, 'callback') as callback:
            with self.assertRaises(Stop):
                job.persist(Path('/tmp/credentials.json'), {})
            callback.assert_not_called()

    def test_invalid_json_reports_failure_without_saving_input(self):
        job = server.Job('test', {'sessionJson': 'not-json', 'action': 'check', 'plan': 'plus'})
        calls = []
        with patch.object(server, 'callback', side_effect=lambda _, body: calls.append(body)):
            job.run()
        self.assertTrue(job.done)
        self.assertEqual(job.payload, {})
        self.assertNotIn('not-json', json.dumps(calls))
        self.assertEqual(calls[-1]['type'], 'finished')


if __name__ == '__main__':
    unittest.main()
