import json
import asyncio
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import AsyncMock, patch

import server
from checkout_core import Stop


class ServerTests(unittest.TestCase):
    def test_reads_cgroup_v2_oom_kill_counter(self):
        with tempfile.TemporaryDirectory() as folder:
            events = Path(folder) / 'memory.events'
            events.write_text('low 0\nhigh 0\noom 3\noom_kill 2\n', encoding='utf-8')
            self.assertEqual(server.read_cgroup_oom_kill(events), 2)
            events.write_text('oom_kill invalid\n', encoding='utf-8')
            self.assertIsNone(server.read_cgroup_oom_kill(events))
            self.assertIsNone(server.read_cgroup_oom_kill(Path(folder) / 'missing'))

    def test_oom_increment_overrides_browser_failure_and_preserves_stage(self):
        original = {'status': 'blocked', 'reason': 'official_plan_browser_error',
                    'stage': 'plan_selection', 'error_type': 'TargetClosedError'}
        result = server.apply_browser_memory_result(original, 4, 5)
        self.assertEqual(result['reason'], 'browser_memory_exhausted')
        self.assertEqual(result['stage'], 'plan_selection')
        self.assertEqual(result['error_type'], 'TargetClosedError')
        self.assertEqual(result['checkout_requests_sent'], 0)
        self.assertEqual(result['payment_requests_sent'], 0)

    def test_normal_browser_error_and_page_crash_are_not_mislabeled_as_oom(self):
        for failure in (
            {'status': 'blocked', 'reason': 'browser_operation_failed', 'error_type': 'Error'},
            {'status': 'blocked', 'reason': 'official_plan_browser_error', 'error_type': 'TargetClosedError'},
        ):
            with self.subTest(failure=failure):
                self.assertIs(server.apply_browser_memory_result(failure, 7, 7), failure)
                self.assertIs(server.apply_browser_memory_result(failure, None, None), failure)

    def test_job_reports_oom_once_without_retrying_or_sending_payment(self):
        job = server.Job('test', {})
        calls = []
        execute = AsyncMock(return_value={
            'status': 'blocked', 'reason': 'official_plan_browser_error',
            'stage': 'plan_selection', 'checkout_requests_sent': 0,
            'payment_requests_sent': 0,
        })
        with patch.object(server, 'read_cgroup_oom_kill', side_effect=[10, 11]), \
             patch.object(server.Job, 'execute', execute), \
             patch.object(server, 'callback', side_effect=lambda _, body: calls.append(body)):
            job.run()
        execute.assert_awaited_once()
        self.assertEqual(calls[-1]['type'], 'finished')
        self.assertEqual(calls[-1]['result']['reason'], 'browser_memory_exhausted')
        self.assertEqual(calls[-1]['result']['checkout_requests_sent'], 0)
        self.assertEqual(calls[-1]['result']['payment_requests_sent'], 0)

    def test_diagnostics_survive_callback_without_free_text_or_secrets(self):
        safe = {'step': 'pricing_page', 'error_type': 'TimeoutError', 'role': 'link',
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
            self.assertEqual(seen[0]['result']['quote_authority'], 'official_checkout_response')

    def test_details_waits_for_one_explicit_submission_and_clears_worker_copy(self):
        job = server.Job('test', {})
        seen = []
        result = []
        payload = {'details': {
            'number': '5555555555554444', 'expiry': '12/39', 'cvc': '123',
            'name': 'Synthetic User', 'email': 'test@example.invalid',
            'country': 'US', 'line1': '1221 SW Fourth Avenue', 'line2': '',
            'city': 'Portland', 'state': 'OR', 'postal_code': '97204'}}
        with patch.object(server, 'callback', side_effect=lambda _, body: seen.append(body)):
            thread = threading.Thread(target=lambda: result.append(job.details({'plan': 'plus'})))
            thread.start()
            for _ in range(1000):
                if job.waiting_details:
                    break
                threading.Event().wait(.001)
            job.submit_details(payload)
            thread.join(2)
        self.assertEqual(result[0].last4, '4444')
        self.assertIsNone(job.pending_details)
        self.assertEqual(payload, {})
        self.assertEqual(seen[0]['type'], 'details_required')
        with self.assertRaises(Stop):
            job.submit_details({'details': {}})

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

    def test_quote_replaces_only_an_unavailable_existing_checkout_once(self):
        async def exercise():
            with tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                (root / 'existing.json').write_text('{}')
                target = type('Target', (), {'account_id': 'account'})()
                with patch.object(server.attempt_ledger, 'checkout_record_path',
                                  return_value=root / 'existing.json'), \
                     patch.object(server.browser_checkout, 'run_browser', new_callable=AsyncMock,
                                  side_effect=[
                                      {'status': 'blocked', 'reason': 'existing_checkout_unavailable',
                                       'checkout_requests_sent': 0, 'payment_requests_sent': 0},
                                      {'status': 'checkout_quote_verified'}
                                  ]) as run:
                    result = await server.quote_checkout(target, 'plus', root)
                self.assertEqual(result['status'], 'checkout_quote_verified')
                self.assertEqual(run.await_count, 2)
                self.assertTrue(run.await_args_list[0].kwargs['inspect_existing'])
                self.assertTrue(run.await_args_list[1].kwargs['create'])
                self.assertTrue(run.await_args_list[1].kwargs['replace_unpaid_checkout'])
        asyncio.run(exercise())


if __name__ == '__main__':
    unittest.main()
