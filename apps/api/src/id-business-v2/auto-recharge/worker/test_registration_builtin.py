import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import fingerprint_runtime
import registration_builtin as builtin
from checkout_core import Stop
import test_registration
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

    def prepare_job(self):
        value = server_payload()
        runtime = MagicMock(_discard=AsyncMock(), playwright=object())
        job = builtin.RegistrationServerJob(value['id'], value,
            'http://api:3000/api/id-business-v2/auto-registration/local', runtime)
        return job, runtime

    def prepared_environments(self, count):
        return [{'browser': MagicMock(close=AsyncMock(return_value=None)), 'context': MagicMock(),
                 'proxy': {'server': 'http://proxy.example.test:8080'}} for _ in range(count)]

    async def test_confirmed_duplicate_closes_before_fresh_bind_and_one_flow(self):
        job, runtime = self.prepare_job(); profiles = builtin.BuiltinProfiles()
        prepared = self.prepared_environments(2)
        events, opener = [], MagicMock()
        conflict = test_registration.RegistrationCallbackConflictTests().conflict('浏览器指纹与已有任务重复，请重新生成')
        opener.open.side_effect = [conflict, test_registration.RegistrationCallbackConflictTests.Response()]
        async def prepare(_config, launch, **_kwargs):
            self.assertIsNone(profiles.profile)
            events.append('prepare')
            value = prepared[events.count('prepare') - 1]
            self.assertIs(await launch(value['proxy']), value['browser'])
            self.assertIs(profiles.profile['browser'], value['browser'])
            self.assertIsNone(profiles.profile['context'])
            return value
        async def close(resource):
            events.append('close-A' if resource is prepared[0]['browser'] else 'close-B')
            return True
        flow = MagicMock(run=AsyncMock())
        with (patch.object(builtin, 'PROFILES', profiles),
              patch.object(builtin.server_proxy, 'prepare_browser', prepare),
              patch.object(fingerprint_runtime, 'launch_fingerprint_browser', AsyncMock(
                  side_effect=[value['browser'] for value in prepared])) as launch,
              patch.object(fingerprint_runtime, 'fingerprint_signature', AsyncMock(side_effect=['a' * 64, 'b' * 64])),
              patch.object(fingerprint_runtime, 'close_fingerprint_resource', close),
              patch('registration_job.build_opener', return_value=opener),
              patch('registration_job.logging.getLogger', return_value=MagicMock()),
              patch('registration_browser.RegistrationBrowser', return_value=flow) as create):
            await job.execute_builtin()
        self.assertEqual(events, ['prepare', 'close-A', 'prepare', 'close-B'])
        self.assertEqual(job.payload['browserProfileId'], 'reg_' + 'b' * 64)
        self.assertEqual((job.id, job.attempt), (server_payload()['id'], 1))
        self.assertEqual(job.registration_callback_error['conflict_kind'], 'fingerprint_duplicate')
        create.assert_called_once_with(job, prepared[1]['context'])
        flow.run.assert_awaited_once()
        self.assertEqual(opener.open.call_count, 2)
        self.assertEqual(launch.await_count, 2)
        self.assertIsNot(opener.open.call_args_list[0].args[0], opener.open.call_args_list[1].args[0])
        self.assertIsNone(profiles.profile)
        self.assertIsNone(job._profile_prepare_deadline)

    async def helper_interruption(self, reason, cleanup_succeeds):
        # Exercise the actual helper before it returns its prepared resource.
        job, runtime = self.prepare_job(); profiles = builtin.BuiltinProfiles()
        prepared = self.prepared_environments(1)[0]
        browser, context, proxy = prepared['browser'], prepared['context'], prepared['proxy']
        original_proxy = dict(proxy)
        browser.new_context = AsyncMock(return_value=context)
        context.route = AsyncMock()
        browser.close = AsyncMock(return_value=None) if cleanup_succeeds else AsyncMock(side_effect=OSError('synthetic-close'))
        job.event = MagicMock()
        clock = [100.0]
        reached = []
        async def observe(_context, **_kwargs):
            self.assertIs(_context, context)
            self.assertIs(profiles.profile['browser'], browser)
            self.assertIsNone(profiles.profile['context'])
            self.assertIsNot(profiles.profile['proxy'], proxy)
            reached.append(True)
            if reason == 'timeout':
                clock[0] = 161.0
            else:
                job.cancelled.set()
            await asyncio.Event().wait()
        with (patch.object(builtin, 'time', SimpleNamespace(monotonic=lambda: clock[0])),
              patch.object(builtin.server_proxy, 'resolve', AsyncMock(return_value=proxy)),
              patch.object(builtin.server_proxy, 'observe_exit', observe),
              patch.object(fingerprint_runtime, 'launch_fingerprint_browser', AsyncMock(return_value=browser)) as launch,
              patch.object(fingerprint_runtime, 'fingerprint_signature', AsyncMock()) as signature,
              patch('registration_browser.RegistrationBrowser') as create):
            with self.assertRaises(Stop) as stopped:
                await profiles.open(runtime, job)
            expected = ('session_load_timeout' if reason == 'timeout' else 'operation_cancelled')
            self.assertEqual(stopped.exception.report['reason'], expected if cleanup_succeeds else 'fingerprint_cleanup_failed')
            self.assertEqual(reached, [True])
            launch.assert_awaited_once()
            signature.assert_not_awaited(); create.assert_not_called()
            self.assertEqual(browser.close.await_count, 2)
            self.assertEqual(proxy, {})
            self.assertIsNone(job.payload['browserProfileId'])
            self.assertIsNone(job._profile_prepare_deadline)
            if cleanup_succeeds:
                self.assertIsNone(profiles.profile)
            else:
                self.assertIs(profiles.profile['browser'], browser)
                self.assertEqual(profiles.profile['proxy'], original_proxy)
                with self.assertRaises(Stop) as retained:
                    await profiles.open(runtime, job)
                self.assertEqual(retained.exception.report['reason'], 'builtin_original_window_pending')
                launch.assert_awaited_once()
                runtime._discard.assert_awaited_once()

    async def test_helper_timeout_before_return_keeps_browser_when_close_fails(self):
        await self.helper_interruption('timeout', False)

    async def test_helper_cancellation_before_return_keeps_browser_when_close_fails(self):
        await self.helper_interruption('cancel', False)

    async def test_helper_timeout_and_cancel_before_return_release_confirmed_closed_browser(self):
        for reason in ['timeout', 'cancel']:
            with self.subTest(reason=reason):
                await self.helper_interruption(reason, True)

    async def test_helper_retry_checks_owned_browser_close_before_launching_another(self):
        job, runtime = self.prepare_job(); profiles = builtin.BuiltinProfiles()
        prepared = self.prepared_environments(1)[0]
        browser, context, proxy = prepared['browser'], prepared['context'], prepared['proxy']
        original_proxy = dict(proxy)
        browser.new_context = AsyncMock(return_value=context)
        context.route = AsyncMock()
        # The helper confirms its first cleanup, but the owner cannot confirm
        # the resource is released; no subsequent native launch is permitted.
        browser.close = AsyncMock(side_effect=[None, OSError('synthetic-close'), OSError('synthetic-close')])
        job.event = MagicMock()
        with (patch.object(builtin.server_proxy, 'resolve', AsyncMock(side_effect=[proxy, dict(original_proxy)])),
              patch.object(builtin.server_proxy, 'observe_exit', AsyncMock(side_effect=Stop('proxy_network_unconfirmed'))),
              patch.object(fingerprint_runtime, 'launch_fingerprint_browser', AsyncMock(return_value=browser)) as launch,
              patch.object(fingerprint_runtime, 'fingerprint_signature', AsyncMock()) as signature):
            with self.assertRaises(Stop) as stopped:
                await profiles.open(runtime, job)
        self.assertEqual(stopped.exception.report['reason'], 'fingerprint_cleanup_failed')
        launch.assert_awaited_once(); signature.assert_not_awaited()
        self.assertEqual(browser.close.await_count, 3)
        self.assertIs(profiles.profile['browser'], browser)
        self.assertEqual(profiles.profile['proxy'], original_proxy)

    async def preparation_diagnostic(self, primary, *, retained=None):
        job, runtime = self.prepare_job(); profiles = builtin.BuiltinProfiles()
        browser = self.prepared_environments(1)[0]['browser']
        if retained is not None:
            job.registration_prepare_error, job.registration_prepare_cleanup_error = retained
            job.registration_cleanup_error = 'OSError'
        async def prepare(_config, launch, **_kwargs):
            await launch({'syntheticOnly': True})
            raise primary
        logger = MagicMock()
        with (patch.object(builtin.server_proxy, 'prepare_browser', prepare),
              patch.object(fingerprint_runtime, 'launch_fingerprint_browser', AsyncMock(return_value=browser)),
              patch.object(fingerprint_runtime, 'close_fingerprint_resource', AsyncMock(return_value=False)),
              patch.object(builtin.logging, 'getLogger', return_value=logger)):
            with self.assertRaises(Stop) as stopped:
                await profiles.open(runtime, job)
        self.assertEqual(stopped.exception.report['reason'], 'fingerprint_cleanup_failed')
        self.assertIs(profiles.profile['browser'], browser)
        self.assertEqual(profiles.profile['proxy'], {'syntheticOnly': True})
        self.assertIsNone(job.payload['browserProfileId'])
        logger.warning.assert_called_once()
        output = logger.warning.call_args.args[0] % logger.warning.call_args.args[1:]
        self.assertNotIn('synthetic-private-value', output)
        self.assertNotIn('synthetic-private-value', repr(job.registration_prepare_error))
        self.assertNotIn('synthetic-private-value', repr(job.registration_prepare_cleanup_error))
        return job, output

    async def test_preparation_cleanup_logs_closed_first_reason_and_secondary_without_exception_text(self):
        class PrivateError(Exception):
            def __str__(self):
                raise AssertionError('Unknown exception text must never be read')
        for primary, reason, kind in [(Stop('session_load_timeout'), 'session_load_timeout', 'Stop'),
                                     (Stop('operation_cancelled'), 'operation_cancelled', 'Stop'),
                                     (Stop('synthetic-private-value'), 'unknown', 'Stop'),
                                     (PrivateError('synthetic-private-value'), 'unknown', 'UnexpectedError')]:
            with self.subTest(kind=kind, reason=reason):
                job, output = await self.preparation_diagnostic(primary)
                self.assertEqual(job.registration_prepare_error, {'reason': reason, 'error_type': kind})
                self.assertEqual(job.registration_prepare_cleanup_error,
                                 {'reason': 'fingerprint_cleanup_failed', 'error_type': 'Stop'})
                self.assertEqual(job.registration_cleanup_error, 'Stop')
                self.assertIn('primary_reason=' + reason, output)
                self.assertIn('cleanup_reason=fingerprint_cleanup_failed', output)

    async def test_preparation_cleanup_never_replaces_existing_first_diagnostics(self):
        first = {'reason': 'session_load_timeout', 'error_type': 'Stop'}
        cleanup = {'reason': 'fingerprint_cleanup_failed', 'error_type': 'Stop'}
        job, output = await self.preparation_diagnostic(Stop('operation_cancelled'), retained=(first, cleanup))
        self.assertIs(job.registration_prepare_error, first)
        self.assertIs(job.registration_prepare_cleanup_error, cleanup)
        self.assertEqual(job.registration_cleanup_error, 'OSError')
        self.assertIn('primary_reason=session_load_timeout', output)

    async def test_rejected_signature_is_not_bound_again_and_third_environment_can_succeed(self):
        job, runtime = self.prepare_job(); profiles = builtin.BuiltinProfiles()
        prepared, opener = self.prepared_environments(3), MagicMock()
        opener.open.side_effect = [test_registration.RegistrationCallbackConflictTests().conflict('浏览器指纹与已有任务重复，请重新生成'),
                                  test_registration.RegistrationCallbackConflictTests.Response()]
        with (patch.object(builtin.server_proxy, 'prepare_browser', AsyncMock(side_effect=prepared)) as prepare,
              patch.object(fingerprint_runtime, 'fingerprint_signature', AsyncMock(side_effect=['a' * 64, 'a' * 64, 'b' * 64])),
              patch.object(fingerprint_runtime, 'close_fingerprint_resource', AsyncMock(return_value=True)) as close,
              patch('registration_job.build_opener', return_value=opener),
              patch('registration_job.logging.getLogger', return_value=MagicMock())):
            result = await profiles.open(runtime, job)
        self.assertEqual(result['id'], 'reg_' + 'b' * 64)
        self.assertEqual(prepare.await_count, 3)
        self.assertEqual(close.await_count, 2)
        self.assertEqual(opener.open.call_count, 2)
        self.assertIs(result['browser'], prepared[2]['browser'])

    async def test_three_rejected_environments_stop_without_a_fourth_or_flow(self):
        for signatures in [['a' * 64] * 3, ['a' * 64, 'b' * 64, 'c' * 64]]:
            with self.subTest(distinct=len(set(signatures))):
                job, runtime = self.prepare_job(); profiles = builtin.BuiltinProfiles()
                opener = MagicMock()
                opener.open.side_effect = [test_registration.RegistrationCallbackConflictTests().conflict(
                    '浏览器指纹与已有任务重复，请重新生成') for _ in range(3)]
                with (patch.object(builtin, 'PROFILES', profiles),
                      patch.object(builtin.server_proxy, 'prepare_browser', AsyncMock(side_effect=self.prepared_environments(4))) as prepare,
                      patch.object(fingerprint_runtime, 'fingerprint_signature', AsyncMock(side_effect=signatures)),
                      patch.object(fingerprint_runtime, 'close_fingerprint_resource', AsyncMock(return_value=True)) as close,
                      patch('registration_job.build_opener', return_value=opener),
                      patch('registration_job.logging.getLogger', return_value=MagicMock()),
                      patch('registration_browser.RegistrationBrowser') as create):
                    with self.assertRaises(Stop) as stopped: await job.execute_builtin()
                self.assertEqual(stopped.exception.report['reason'], 'durable_state_unavailable')
                self.assertEqual(prepare.await_count, 3)
                self.assertEqual(close.await_count, 3)
                self.assertEqual(opener.open.call_count, len(set(signatures)))
                create.assert_not_called()
                self.assertIsNone(profiles.profile)
                self.assertIsNone(job.payload['browserProfileId'])

    async def test_duplicate_cleanup_failure_keeps_owned_resource_and_never_regenerates(self):
        for close_result in [False, OSError('synthetic-cleanup')]:
            with self.subTest(raises=isinstance(close_result, Exception)):
                job, runtime = self.prepare_job(); profiles = builtin.BuiltinProfiles()
                prepared = self.prepared_environments(1)[0]
                job.event = MagicMock(side_effect=builtin.PreparationFingerprintDuplicate(job.id, job.attempt, 'reg_' + 'a' * 64))
                closer = AsyncMock(side_effect=close_result) if isinstance(close_result, Exception) else AsyncMock(return_value=False)
                with (patch.object(builtin.server_proxy, 'prepare_browser', AsyncMock(return_value=prepared)) as prepare,
                      patch.object(fingerprint_runtime, 'fingerprint_signature', AsyncMock(return_value='a' * 64)),
                      patch.object(fingerprint_runtime, 'close_fingerprint_resource', closer)):
                    with self.assertRaises(Stop) as stopped: await profiles.open(runtime, job)
                self.assertEqual(stopped.exception.report['reason'], 'fingerprint_cleanup_failed')
                prepare.assert_awaited_once()
                closer.assert_awaited_once()
                self.assertIs(profiles.profile['browser'], prepared['browser'])
                self.assertIn('server', profiles.profile['proxy'])

    async def test_ambiguous_callback_never_regenerates_even_with_old_duplicate_diagnostic(self):
        job, runtime = self.prepare_job(); profiles = builtin.BuiltinProfiles()
        job.registration_callback_error = {'conflict_kind': 'fingerprint_duplicate'}
        job.event = MagicMock(side_effect=Stop('durable_state_unavailable'))
        with (patch.object(builtin.server_proxy, 'prepare_browser', AsyncMock(return_value=self.prepared_environments(1)[0])) as prepare,
              patch.object(fingerprint_runtime, 'fingerprint_signature', AsyncMock(return_value='a' * 64)),
              patch.object(fingerprint_runtime, 'close_fingerprint_resource', AsyncMock(return_value=True)) as close):
            with self.assertRaises(Stop): await profiles.open(runtime, job)
        prepare.assert_awaited_once(); close.assert_awaited_once()
        self.assertEqual(job.registration_callback_error, {'conflict_kind': 'fingerprint_duplicate'})

    async def test_flow_or_submission_state_without_original_window_never_prepares(self):
        variants = [('payload', 'step', 'email'), ('payload', 'registered', True),
                    ('payload', 'passwordVerified', True), ('payload', 'mfaVerified', True),
                    ('job', 'registration_state', {}), ('job', 'registration_operation', 'email_submit'),
                    ('job', 'awaiting_code', True), ('job', 'pending_code', ('123456', None)),
                    ('job', 'waiting_for_user', True), ('job', 'last_delivered_mail_id', 'fixture-mail')]
        for where, key, value in variants:
            with self.subTest(where=where, key=key):
                job, runtime = self.prepare_job()
                if where == 'payload':job.payload[key] = value
                else:setattr(job, key, value)
                with patch.object(builtin.server_proxy, 'prepare_browser', AsyncMock()) as prepare:
                    with self.assertRaises(Stop): await builtin.BuiltinProfiles().open(runtime, job)
                prepare.assert_not_awaited(); runtime._discard.assert_not_awaited()

    async def test_cancellation_before_prepare_after_close_and_before_bind_never_rebuilds(self):
        for phase in ['before_prepare', 'after_close', 'before_bind']:
            with self.subTest(phase=phase):
                job, runtime = self.prepare_job(); profiles = builtin.BuiltinProfiles()
                if phase == 'before_prepare':job.cancelled.set()
                job.event = MagicMock(side_effect=builtin.PreparationFingerprintDuplicate(job.id, job.attempt, 'reg_' + 'a' * 64))
                async def signature(_context):
                    if phase == 'before_bind':job.cancelled.set()
                    return 'a' * 64
                async def close(_resource):
                    if phase == 'after_close':job.cancelled.set()
                    return True
                with (patch.object(builtin.server_proxy, 'prepare_browser', AsyncMock(return_value=self.prepared_environments(1)[0])) as prepare,
                      patch.object(fingerprint_runtime, 'fingerprint_signature', signature),
                      patch.object(fingerprint_runtime, 'close_fingerprint_resource', close)):
                    with self.assertRaises(Stop) as stopped: await profiles.open(runtime, job)
                self.assertEqual(stopped.exception.report['reason'], 'operation_cancelled')
                self.assertEqual(prepare.await_count, 0 if phase == 'before_prepare' else 1)
                self.assertEqual(job.event.call_count, 1 if phase == 'after_close' else 0)
                self.assertIsNone(profiles.profile)

    async def test_one_sixty_second_budget_covers_both_environments_and_cleanup(self):
        job, runtime = self.prepare_job(); profiles = builtin.BuiltinProfiles()
        prepared = self.prepared_environments(2); clock = [100.0]; deadlines = []
        async def prepare(*_args, **_kwargs):
            deadlines.append(job._profile_prepare_deadline)
            clock[0] += 15 if len(deadlines) == 1 else 30
            return prepared[len(deadlines) - 1]
        async def signature(context):
            clock[0] += 5 if context is prepared[0]['context'] else 6
            return 'a' * 64 if context is prepared[0]['context'] else 'b' * 64
        def event(*_args, **_kwargs):
            clock[0] += 3
            raise builtin.PreparationFingerprintDuplicate(job.id, job.attempt, 'reg_' + 'a' * 64)
        async def close(_resource):clock[0] += 2; return True
        job.event = MagicMock(side_effect=event)
        with (patch.object(builtin, 'time', SimpleNamespace(monotonic=lambda: clock[0])),
              patch.object(builtin.server_proxy, 'prepare_browser', prepare),
              patch.object(fingerprint_runtime, 'fingerprint_signature', signature),
              patch.object(fingerprint_runtime, 'close_fingerprint_resource', close)):
            with self.assertRaises(Stop) as stopped: await profiles.open(runtime, job)
        self.assertEqual(stopped.exception.report['reason'], 'session_load_timeout')
        self.assertEqual(deadlines, [160.0, 160.0])
        job.event.assert_called_once()
        self.assertLessEqual(clock[0], 165)
        self.assertIsNone(profiles.profile)
        self.assertIsNone(job._profile_prepare_deadline)

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

    async def test_email_and_code_facts_pass_unchanged_through_retained_window_attempts(self):
        value = server_payload()
        for email_submitted, code_submitted in [(False, False), (True, False), (False, True), (True, True)]:
            with self.subTest(email=email_submitted, code=code_submitted):
                state = {'email_submitted': email_submitted, 'code_submitted': code_submitted,
                         'profile_submitted': True}
                expected = dict(state)
                profile = self.owned_profile(value['id'])
                profile['browser'].is_connected.return_value = True
                profile['registration_state'] = state
                profiles = builtin.BuiltinProfiles()
                profiles.profile = profile
                body = {**value, 'browserProfileId': profile['id']}
                for attempt in [1, 2]:
                    job = builtin.RegistrationServerJob(value['id'], {**body, 'attempt': attempt},
                        'http://api:3000/api/id-business-v2/auto-registration/local', MagicMock())
                    flow = MagicMock(run=AsyncMock(side_effect=Stop('mailbox_timeout')))
                    with (patch.object(builtin, 'PROFILES', profiles),
                          patch('registration_browser.RegistrationBrowser', return_value=flow) as create):
                        with self.assertRaises(Stop):
                            await job.execute_builtin()
                    create.assert_called_once_with(job, profile['context'])
                    self.assertIs(job.registration_state, state)
                    self.assertIs(profiles.profile, profile)
                    self.assertEqual(state, expected)

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
        browsers = [MagicMock(new_context=AsyncMock(return_value=context), close=AsyncMock()) for _ in range(10)]
        runtime = MagicMock(_discard=AsyncMock(), playwright=object())
        with (patch.object(builtin.server_proxy, 'resolve_proxy', return_value={'server': 'http://proxy.example.test:8080'}),
              patch.object(builtin.server_proxy, 'observe_exit', AsyncMock(return_value={'ip': '8.8.8.8', 'country': 'JP'})),
              patch.object(fingerprint_runtime, 'launch_fingerprint_browser', AsyncMock(side_effect=browsers)) as launch):
            profiles = builtin.BuiltinProfiles()
            with self.assertRaises(Stop): await profiles.open(runtime, job)
            self.assertEqual(launch.await_count, 10)
            self.assertEqual([browser.close.await_count for browser in browsers], [2] * 10)
            self.assertIsNone(profiles.profile)
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


class RegisteredColdBuiltinTests(unittest.IsolatedAsyncioTestCase):
    def job(self,step='password',verified=False):
        value=server_payload();value.update(registered=True,passwordVerified=verified,step=step)
        runtime=MagicMock(_discard=AsyncMock(),playwright=object())
        job=builtin.RegistrationServerJob(value['id'],value,'http://api:3000/api/id-business-v2/auto-registration/local',runtime)
        return job,runtime

    async def test_fresh_registered_profile_binds_actual_signature_before_auth_marker(self):
        from registration_browser import REGISTERED_AUTH_RECOVERY
        for step,verified in [('registered',False),('password',False),('password_verified',True),('mfa',True)]:
            with self.subTest(step=step):
                job,runtime=self.job(step,verified); profiles=builtin.BuiltinProfiles()
                prepared=BuiltinTests.prepared_environments(self,1)[0]
                order=[]
                def event(_name,**data):
                    self.assertEqual(data,{'browserProfileId':'reg_'+'b'*64,'reason':'proxy_ready'})
                    self.assertFalse(hasattr(job,'registration_state'));order.append('bound')
                job.event=MagicMock(side_effect=event)
                def create(actual,context):
                    self.assertIs(actual,job);self.assertIs(context,prepared['context'])
                    marker=job.registration_state[REGISTERED_AUTH_RECOVERY]
                    self.assertEqual(marker,{'context':context,'page':None,'submitted':False,'guard':None})
                    self.assertEqual(job.payload['browserProfileId'],'reg_'+'b'*64)
                    order.append('auth-ready');return MagicMock(run=AsyncMock())
                with patch.object(builtin,'PROFILES',profiles),patch.object(builtin.server_proxy,'prepare_browser',AsyncMock(return_value=prepared)),patch.object(fingerprint_runtime,'fingerprint_signature',AsyncMock(return_value='b'*64)),patch.object(fingerprint_runtime,'close_fingerprint_resource',AsyncMock(return_value=True)),patch('registration_browser.RegistrationBrowser',side_effect=create):
                    await job.execute_builtin()
                self.assertEqual(order,['bound','auth-ready'])
                self.assertEqual((job.payload['registered'],job.payload['passwordVerified'],job.payload['mfaVerified']),(True,verified,False))

    async def test_registered_duplicate_closes_before_one_new_signature_and_keeps_step_flags(self):
        job,runtime=self.job('mfa',True);profiles=builtin.BuiltinProfiles()
        values=BuiltinTests.prepared_environments(self,2); order=[]
        async def prepare(*_args,**_kwargs):order.append('prepare');return values[order.count('prepare')-1]
        def event(_name,**data):
            order.append('bind')
            if data['browserProfileId']=='reg_'+'a'*64:raise builtin.PreparationFingerprintDuplicate(job.id,job.attempt,data['browserProfileId'])
        async def close(_browser):order.append('close');return True
        job.event=MagicMock(side_effect=event)
        with patch.object(builtin.server_proxy,'prepare_browser',prepare),patch.object(fingerprint_runtime,'fingerprint_signature',AsyncMock(side_effect=['a'*64,'b'*64])),patch.object(fingerprint_runtime,'close_fingerprint_resource',close):
            await profiles.open(runtime,job)
        self.assertEqual(order,['prepare','bind','close','prepare','bind'])
        self.assertEqual(job.payload['browserProfileId'],'reg_'+'b'*64)
        self.assertEqual((job.step,job.payload['registered'],job.payload['passwordVerified'],job.payload['mfaVerified']),('mfa',True,True,False))

    async def test_unregistered_lost_or_forged_profile_never_prepares_registration_again(self):
        for forged in [False,True]:
            job,runtime=self.job()
            if forged:job.payload['browserProfileId']='reg_'+'a'*64
            else:job.payload['registered']=False
            with patch.object(builtin.server_proxy,'prepare_browser',AsyncMock()) as prepare:
                with self.assertRaises(Stop):await builtin.BuiltinProfiles().open(runtime,job)
            prepare.assert_not_awaited();runtime._discard.assert_not_awaited()

    async def test_cold_duplicate_close_failure_retains_owner_without_second_environment(self):
        job,runtime=self.job();profiles=builtin.BuiltinProfiles(); prepared=BuiltinTests.prepared_environments(self,1)[0]
        job.event=MagicMock(side_effect=builtin.PreparationFingerprintDuplicate(job.id,job.attempt,'reg_'+'a'*64))
        with patch.object(builtin.server_proxy,'prepare_browser',AsyncMock(return_value=prepared)) as prepare,patch.object(fingerprint_runtime,'fingerprint_signature',AsyncMock(return_value='a'*64)),patch.object(fingerprint_runtime,'close_fingerprint_resource',AsyncMock(return_value=False)):
            with self.assertRaises(Stop) as stopped:await profiles.open(runtime,job)
        self.assertEqual(stopped.exception.report['reason'],'fingerprint_cleanup_failed')
        prepare.assert_awaited_once();self.assertIs(profiles.profile['context'],prepared['context'])
        self.assertIsNone(job.payload['browserProfileId']);self.assertTrue(job.payload['registered'])


class FinishedTaskTests(unittest.TestCase):
    def test_failure_diagnostics_exclude_exception_text_and_uncontrolled_codes(self):
        value = server_payload()
        Error = type('Error', (Exception,), {})
        runtime = MagicMock(run_registration=MagicMock(side_effect=Error('synthetic-private-detail')))
        job = builtin.RegistrationServerJob(value['id'], value,
            'http://api:3000/api/id-business-v2/auto-registration/local', runtime)
        job.registration_operation = 'identity_read'
        job.registration_observation_error = {'reason': 'session_network_error', 'browser_error_code': 'synthetic-private-code'}
        job.event = MagicMock()
        with self.assertLogs('registration', level='WARNING') as captured:
            job.run()
        logged = '\n'.join(captured.output)
        self.assertIn('operation=identity_read error_type=Error', logged)
        self.assertIn('browser_error_code=none observation_reason=session_network_error', logged)
        self.assertNotIn('synthetic-private', logged)
        job.event.assert_called_once_with('partial', reason='builtin_execution_failed')

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
