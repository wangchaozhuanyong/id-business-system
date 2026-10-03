import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import fingerprint_runtime
import registration_builtin as builtin
from checkout_core import Stop
from test_registration import payload


def server_payload():
    value = payload()
    for key in ('bitBrowser', 'callbackUrl', 'windowName'):
        value.pop(key)
    value.update(proxy={'mode': 'dynamic', 'type': 'http', 'extractionUrl': 'https://proxy.example.test/extract'},
                 expectedCountry='US')
    return value


class BuiltinTests(unittest.IsolatedAsyncioTestCase):
    def owned_profile(self, job_id='fixture-job'):
        return {'id': 'reg_' + 'a' * 64, 'job_id': job_id, 'context': MagicMock(),
                'browser': MagicMock(), 'proxy': {'server': 'http://proxy.example.test:8080'}}

    async def test_optional_age_snapshot_survives_private_payload_validation(self):
        for age in [20, 21, 45]:
            with self.subTest(age=age):
                value = server_payload(); value['registrationAge'] = age
                job = builtin.RegistrationServerJob(value['id'], value,
                    'http://api:3000/api/id-business-v2/auto-registration/local', MagicMock())
                self.assertEqual(job.payload['registrationAge'], age)
                self.assertEqual(job.payload['birthDate'], value['birthDate'])

    async def test_fixed_age_does_not_advance_when_same_task_attempt_changes(self):
        for age in [20, 21, 45]:
            with self.subTest(age=age):
                value = server_payload(); value['registrationAge'] = age
                for attempt in [1, 2, 3]:
                    job = builtin.RegistrationServerJob(value['id'], {**value, 'attempt': attempt},
                        'http://api:3000/api/id-business-v2/auto-registration/local', MagicMock())
                    self.assertEqual(job.id, value['id'])
                    self.assertEqual(job.payload['registrationAge'], age)
                    self.assertEqual(job.payload['birthDate'], value['birthDate'])

    async def test_profile_submission_fact_survives_new_attempt_in_retained_window(self):
        value = server_payload()
        state = {'profile_submitted': True}
        profile = self.owned_profile(value['id']); profile['registration_state'] = state
        for attempt in [1, 2]:
            job = builtin.RegistrationServerJob(value['id'], {**value, 'attempt': attempt},
                'http://api:3000/api/id-business-v2/auto-registration/local', MagicMock())
            flow = MagicMock(run=AsyncMock(side_effect=Stop('form_unrecognized')))
            with (patch.object(builtin.PROFILES, 'open', AsyncMock(return_value=profile)),
                  patch('registration_browser.RegistrationBrowser', return_value=flow)):
                with self.assertRaises(Stop): await job.execute_builtin()
            self.assertIs(job.registration_state, state)
            self.assertTrue(job.registration_state['profile_submitted'])

    async def test_unconfirmed_close_keeps_original_profile_and_blocks_another_task(self):
        profiles = builtin.BuiltinProfiles()
        profile = profiles.profile = self.owned_profile()
        with patch.object(fingerprint_runtime, 'close_fingerprint_resource', AsyncMock(return_value=False)):
            with self.assertRaises(Stop) as stopped: await profiles.close('fixture-job')
        self.assertEqual(stopped.exception.report['reason'], 'fingerprint_cleanup_failed')
        self.assertIs(profiles.profile, profile)
        self.assertIn('server', profile['proxy'])
        job = SimpleNamespace(id='next-job', payload={'browserProfileId': None})
        with patch.object(builtin.server_proxy, 'prepare_browser', AsyncMock()) as prepare:
            with self.assertRaises(Stop) as blocked: await profiles.open(MagicMock(), job)
        self.assertEqual(blocked.exception.report['reason'], 'builtin_original_window_pending')
        prepare.assert_not_awaited()

    async def test_close_exception_is_controlled_and_preserves_resource_for_retry(self):
        profiles = builtin.BuiltinProfiles()
        profile = profiles.profile = self.owned_profile()
        with patch.object(fingerprint_runtime, 'close_fingerprint_resource', AsyncMock(side_effect=RuntimeError('fixture failure'))):
            with self.assertRaises(Stop) as stopped: await profiles.close('fixture-job')
        self.assertEqual(stopped.exception.report['reason'], 'fingerprint_cleanup_failed')
        self.assertIs(profiles.profile, profile)
        with patch.object(fingerprint_runtime, 'close_fingerprint_resource', AsyncMock(return_value=True)):
            await profiles.close('fixture-job')
        self.assertIsNone(profiles.profile)
        self.assertEqual(profile, {})

    async def test_confirmed_close_releases_queue_and_clears_original_proxy(self):
        profiles = builtin.BuiltinProfiles()
        profile = profiles.profile = self.owned_profile()
        proxy = profile['proxy']
        with patch.object(fingerprint_runtime, 'close_fingerprint_resource', AsyncMock(return_value=True)) as close:
            await profiles.close('fixture-job')
        close.assert_awaited_once()
        self.assertIsNone(profiles.profile)
        self.assertEqual(proxy, {})
        self.assertEqual(profile, {})

    async def test_prepared_profile_is_owned_when_fingerprint_probe_and_cleanup_fail(self):
        value = server_payload()
        job = builtin.RegistrationServerJob(value['id'], value,
            'http://api:3000/api/id-business-v2/auto-registration/local', MagicMock())
        profiles = builtin.BuiltinProfiles()
        browser, context, proxy = MagicMock(), MagicMock(), {'server': 'http://proxy.example.test:8080'}
        prepared = {'browser': browser, 'context': context, 'proxy': proxy}
        with (patch.object(builtin.server_proxy, 'prepare_browser', AsyncMock(return_value=prepared)),
              patch.object(fingerprint_runtime, 'fingerprint_signature', AsyncMock(side_effect=Stop('fingerprint_start_timeout'))),
              patch.object(fingerprint_runtime, 'close_fingerprint_resource', AsyncMock(return_value=False))):
            with self.assertRaises(Stop) as stopped: await profiles.open(MagicMock(_discard=AsyncMock()), job)
        self.assertEqual(stopped.exception.report['reason'], 'fingerprint_cleanup_failed')
        self.assertIs(profiles.profile['browser'], browser)
        self.assertEqual(profiles.profile['job_id'], job.id)
        self.assertIsNone(job.payload['browserProfileId'])

    async def test_terminal_receipt_waits_until_original_window_is_confirmed_closed(self):
        value = server_payload()
        job = builtin.RegistrationServerJob(value['id'], value,
            'http://api:3000/api/id-business-v2/auto-registration/local', MagicMock())
        profiles = builtin.BuiltinProfiles()
        profiles.profile = self.owned_profile(job.id)
        calls = []
        async def flow():
            job.event('complete', step='completed')
            self.assertEqual(calls, [])
        async def close_resource(_browser):
            self.assertEqual(calls, [])
            return True
        with (patch.object(builtin, 'PROFILES', profiles),
              patch.object(profiles, 'open', AsyncMock(return_value=profiles.profile)),
              patch('registration_browser.RegistrationBrowser', return_value=MagicMock(run=flow)),
              patch.object(fingerprint_runtime, 'close_fingerprint_resource', close_resource),
              patch.object(builtin.RegistrationJob, 'event', lambda _job, event_type, **data: calls.append((event_type, data)))):
            await job.execute_builtin()
        self.assertIsNone(profiles.profile)
        self.assertEqual(calls, [('complete', {'step': 'completed'})])

    async def test_finished_task_cancel_does_not_claim_failed_cleanup_succeeded(self):
        value = server_payload()
        runtime = MagicMock(started=True)
        job = builtin.RegistrationServerJob(value['id'], value,
            'http://api:3000/api/id-business-v2/auto-registration/local', runtime)
        job.done = True
        runtime.run_registration.side_effect = Stop('fingerprint_cleanup_failed')
        with self.assertRaises(Stop) as stopped: job.cancel()
        self.assertEqual(stopped.exception.report['reason'], 'fingerprint_cleanup_failed')
        self.assertTrue(job.cancelled.is_set())
        runtime.run_registration.assert_called_once()

    async def test_registration_flow_failure_preserves_original_window_without_preparing_again(self):
        value = server_payload()
        job = builtin.RegistrationServerJob(value['id'], value,
            'http://api:3000/api/id-business-v2/auto-registration/local', MagicMock())
        profile = {'context': MagicMock(), 'browser': MagicMock(), 'proxy': {}}
        flow = MagicMock(run=AsyncMock(side_effect=Stop('form_unrecognized')))
        with (patch.object(builtin.PROFILES, 'open', AsyncMock(return_value=profile)) as open_original,
              patch.object(builtin.PROFILES, 'close', AsyncMock()) as close,
              patch('registration_browser.RegistrationBrowser', return_value=flow),
              patch.object(builtin.server_proxy, 'prepare_browser', AsyncMock()) as prepare):
            with self.assertRaises(Stop) as stopped: await job.execute_builtin()
        self.assertEqual(stopped.exception.report['reason'], 'form_unrecognized')
        open_original.assert_awaited_once()
        flow.run.assert_awaited_once()
        close.assert_not_awaited()
        prepare.assert_not_awaited()
        self.assertIs(job.profile, profile)

    async def test_extract_once_then_open_and_resume_original_environment(self):
        profiles = builtin.BuiltinProfiles()
        page = MagicMock(url='https://chatgpt.com/auth/login', goto=AsyncMock(return_value=MagicMock(status=200)))
        context = MagicMock(route=AsyncMock(), unroute=AsyncMock(), new_page=AsyncMock(return_value=page))
        browser = MagicMock(new_context=AsyncMock(return_value=context), is_connected=lambda: True, close=AsyncMock())
        job = builtin.RegistrationServerJob(server_payload()['id'], server_payload(),
            'http://api:3000/api/id-business-v2/auto-registration/local', MagicMock())
        job.event = MagicMock()
        context.browser = browser
        runtime = MagicMock(_discard=AsyncMock(), playwright=object())
        with (patch.object(builtin.server_proxy, 'resolve_proxy', return_value={'server': 'http://proxy.example.test:8080'}) as resolve,
              patch.object(builtin.server_proxy, 'observe_exit', AsyncMock(return_value={'ip': '8.8.8.8', 'country': 'US'})),
              patch.object(fingerprint_runtime, 'launch_fingerprint_browser', AsyncMock(return_value=browser)) as launch,
              patch.object(fingerprint_runtime, 'fingerprint_signature', AsyncMock(return_value='a' * 64))):
            first = await profiles.open(runtime, job)
            self.assertEqual(first['id'], 'reg_' + 'a' * 64)
            self.assertEqual(await profiles.open(runtime, job), first)
            resolve.assert_called_once()
            launch.assert_awaited_once()
            context_args = browser.new_context.await_args.kwargs
            self.assertEqual(context_args['proxy'], {'server': 'http://proxy.example.test:8080'})
            job.profile = first
            await job.new_verification_context()
            self.assertEqual(browser.new_context.await_args.kwargs, context_args)

    async def test_missing_original_profile_never_starts_fresh_registration(self):
        value = server_payload(); value['browserProfileId'] = 'reg_' + 'b' * 64
        job = builtin.RegistrationServerJob(value['id'], value,
            'http://api:3000/api/id-business-v2/auto-registration/local', MagicMock())
        with patch.object(fingerprint_runtime, 'launch_fingerprint_browser', AsyncMock()) as launch:
            with self.assertRaises(Stop) as stopped:
                await builtin.BuiltinProfiles().open(MagicMock(), job)
            self.assertEqual(stopped.exception.report['reason'], 'builtin_profile_missing')
            launch.assert_not_awaited()

    async def test_country_mismatch_exhausts_ten_attempts_before_any_registration_submission(self):
        value = server_payload()
        job = builtin.RegistrationServerJob(value['id'], value,
            'http://api:3000/api/id-business-v2/auto-registration/local', MagicMock())
        job.event = MagicMock()
        context = MagicMock(route=AsyncMock(), unroute=AsyncMock())
        browser = MagicMock(new_context=AsyncMock(return_value=context), close=AsyncMock())
        runtime = MagicMock(_discard=AsyncMock(), playwright=object())
        with (patch.object(builtin.server_proxy, 'resolve_proxy', return_value={'server': 'http://proxy.example.test:8080'}),
              patch.object(builtin.server_proxy, 'observe_exit', AsyncMock(return_value={'ip': '8.8.8.8', 'country': 'JP'})),
              patch.object(fingerprint_runtime, 'launch_fingerprint_browser', AsyncMock(return_value=browser))):
            with self.assertRaises(Stop): await builtin.BuiltinProfiles().open(runtime, job)
            self.assertEqual(browser.close.await_count, 10)
            self.assertFalse(any('browserProfileId' in call.kwargs for call in job.event.call_args_list))

    async def test_private_dispatch_replays_same_attempt_without_second_window(self):
        value = server_payload()
        job = builtin.RegistrationServerJob(value['id'], value,
            'http://api:3000/api/id-business-v2/auto-registration/local', MagicMock())
        handler = SimpleNamespace(job=job, path='/registration/jobs/' + job.id)
        self.assertIs(builtin.handle_request(handler, value, 'unused', MagicMock()), job)
        changed = dict(value, attempt=value['attempt'] + 1)
        with self.assertRaises(Stop): builtin.handle_request(handler, changed, 'unused', MagicMock())
        job.done = True
        self.assertIs(builtin.handle_request(handler, value, 'unused', MagicMock()), job)

    async def test_partial_window_rejects_new_job_and_preserves_original_resume(self):
        value = server_payload()
        profile_id = 'reg_' + 'a' * 64
        profiles = builtin.BuiltinProfiles()
        profiles.profile = self.owned_profile(value['id'])
        handler = SimpleNamespace(job=None, path='/registration/jobs/' + value['id'])
        with patch.object(builtin, 'PROFILES', profiles):
            with self.assertRaises(Stop) as stopped:
                builtin.handle_request(handler, value, 'unused', MagicMock())
            self.assertEqual(stopped.exception.report['reason'], 'builtin_original_window_pending')
            value['browserProfileId'] = profile_id
            resumed = builtin.handle_request(handler, value,
                'http://api:3000/api/id-business-v2/auto-registration/local', MagicMock())
            self.assertEqual(resumed.id, value['id'])
            next_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
            handler.path = '/registration/jobs/' + next_id
            with self.assertRaises(Stop) as another:
                builtin.handle_request(handler, dict(value, id=next_id), 'unused', MagicMock())
            self.assertEqual(another.exception.report['reason'], 'builtin_original_window_pending')
        self.assertEqual(profiles.profile['job_id'], value['id'])

    async def test_lost_original_window_is_rejected_before_job_acceptance(self):
        value = server_payload()
        value['browserProfileId'] = 'reg_' + 'a' * 64
        handler = SimpleNamespace(job=None, path='/registration/jobs/' + value['id'])
        with patch.object(builtin, 'PROFILES', builtin.BuiltinProfiles()):
            with self.assertRaises(Stop) as stopped:
                builtin.handle_request(handler, value, 'unused', MagicMock())
        self.assertEqual(stopped.exception.report['reason'], 'builtin_profile_missing')

    async def test_dispatch_rejection_exposes_only_controlled_reason(self):
        value = builtin.dispatch_rejection(Stop('worker_busy', sensitive='synthetic-private-details'))
        self.assertEqual(value, {'ok': False, 'reason': 'worker_busy'})
        self.assertIsNone(builtin.dispatch_rejection(Stop('synthetic-private-details')))
        self.assertIsNone(builtin.dispatch_rejection(RuntimeError('synthetic-private-details')))
    async def test_missing_kernel_has_no_chromium_fallback(self):
        driver = MagicMock()
        with self.assertRaises(Stop):
            await fingerprint_runtime.launch_fingerprint_browser(driver, executable_path='/absent/browser')
        driver.chromium.launch.assert_not_called()
        driver.firefox.launch.assert_not_called()

    async def test_cancelled_and_wrong_attempt_commands_do_not_change_task(self):
        value = server_payload()
        job = builtin.RegistrationServerJob(value['id'], value,
            'http://api:3000/api/id-business-v2/auto-registration/local', MagicMock())
        handler = SimpleNamespace(job=job, path='/registration/jobs/' + job.id + '/cancel')
        with self.assertRaises(ValueError): builtin.handle_request(handler, {'attempt': 99}, 'unused', MagicMock())
        self.assertFalse(job.cancelled.is_set())
        builtin.handle_request(handler, {'attempt': job.attempt}, 'unused', MagicMock())
        self.assertTrue(job.cancelled.is_set())


class FinishedTaskTests(unittest.TestCase):
    def test_close_failure_reports_partial_without_false_complete_or_releasing_queue(self):
        value = server_payload()
        runtime = SimpleNamespace(run_registration=lambda operation: asyncio.run(operation()))
        job = builtin.RegistrationServerJob(value['id'], value,
            'http://api:3000/api/id-business-v2/auto-registration/local', runtime)
        profiles = builtin.BuiltinProfiles()
        profile = profiles.profile = {'id': 'reg_' + 'a' * 64, 'job_id': job.id,
            'context': MagicMock(), 'browser': MagicMock(), 'proxy': {}}
        receipts = []
        async def flow(): job.event('complete', step='completed')
        with (patch.object(builtin, 'PROFILES', profiles),
              patch.object(profiles, 'open', AsyncMock(return_value=profile)),
              patch('registration_browser.RegistrationBrowser', return_value=MagicMock(run=flow)),
              patch.object(fingerprint_runtime, 'close_fingerprint_resource', AsyncMock(return_value=False)),
              patch.object(builtin.RegistrationJob, 'event', lambda _job, event_type, **data: receipts.append((event_type, data)))):
            job.run()
        self.assertTrue(job.done)
        self.assertIs(profiles.profile, profile)
        self.assertEqual(receipts, [('partial', {'reason': 'fingerprint_cleanup_failed'})])


if __name__ == '__main__': unittest.main()
