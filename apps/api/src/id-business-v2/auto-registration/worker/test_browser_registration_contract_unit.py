"""Connector -> Nest-shaped JSON -> real Worker DTO/state; no transport or database."""
import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import HTTPException
import apple_browser_registration as worker
import browser_registration_connector as connector
from browser_registration_flow import RegistrationFlow, Stop
from test_browser_registration_connector import FakeContext, FakePage, PROFILE, TASK, claim, payload


class NativeContract:
    def __init__(self, page, callback, *, cancel_before_creation=False):
        self.page, self.callback = page, callback
        self.code_reads = 0
        self.code_phases = []
        self.results = []
        self.opened = None
        self.cancel_before_creation = cancel_before_creation
        self.state = {'version': 1, 'phase': 'claimed',
            'expiresAt': (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(),
            'claimIdHash': None, 'sequence': 0, 'lastEvent': None, 'lastEventHash': None,
            'profileId': None, 'passwordAcknowledged': False, 'browserOpened': False,
            'emailSubmitted': False, 'failureReason': None, 'creationEvidence': None}

    def post(self, url, body, headers, *, timeout):
        # Mirrors the reviewed Nest boundary: raw nonce stays in its header;
        # only its digest crosses the private actor-bound Worker bridge.
        if headers.get('Authorization') != 'Bearer ' + payload()['launchToken']:
            raise AssertionError('capability mismatch')
        nonce = headers['X-Registration-Browser-Nonce']
        self.assert_nonce(nonce)
        private = {**body, 'claimId': hashlib.sha256(nonce.encode()).hexdigest()}
        action = url.rsplit('/', 1)[1]
        try:
            if action == 'claim':
                request = worker.PrivateInput.model_validate(private)
                self.state['claimIdHash'] = hashlib.sha256(request.claimId.encode()).hexdigest()
                data = claim()
            elif action == 'event':
                request = worker.EventInput.model_validate(private)
                original_sequence = self.state['sequence']
                self.state = worker.advance_event(self.state, request, claim()['proxy'])
                if request.event == 'browser_opened':
                    self.opened = request
                if request.event == 'profile_required' and request.sequence != original_sequence:
                    self.page.manual_profile_ready = True
                    if self.cancel_before_creation:
                        self.state['phase'] = 'cancelled'
                        self.state['failureReason'] = 'cancelled'
                data = {'accepted': True}
            elif action == 'code':
                worker.CodeInput.model_validate(private)
                self.code_phases.append(self.state['phase'])
                if self.state['phase'] != 'email_code_required':
                    raise HTTPException(409, 'wrong phase')
                self.code_reads += 1
                data = {'code': None if self.code_reads < 3 else '123456'}
            elif action == 'result':
                request = worker.ResultInput.model_validate(private)
                if self.state['phase'] != 'official_identity_observed':
                    raise AssertionError('identity event missing')
                if request.profileId != self.state['profileId']:
                    raise AssertionError('profile mismatch')
                if not self.state['passwordAcknowledged']:
                    raise AssertionError('password ACK missing')
                self.results.append(request)
                data = {'accepted': True}
            else:
                raise AssertionError('unexpected callback')
        except HTTPException:
            raise Stop('callback_rejected') from None
        return {'success': True, 'data': data, 'message': 'ok',
                'requestId': TASK, 'timestamp': datetime.now(timezone.utc).isoformat()}

    def assert_nonce(self, nonce):
        if nonce != self.callback.nonce or len(nonce) != 64:
            raise AssertionError('nonce mismatch')


class ConnectorWorkerContractTests(unittest.IsolatedAsyncioTestCase):
    async def run_native_flow(self, *, cancel=False, observation=None):
        page = FakePage()
        callback = connector.CallbackClient(payload())
        native = NativeContract(page, callback, cancel_before_creation=cancel)
        tick = [0]

        def clock():
            tick[0] += 1
            return tick[0]

        flow = RegistrationFlow(claim(), callback, timeout=300, clock=clock)
        page.flow = flow
        original_sleep = asyncio.sleep

        async def advance(_):
            if page.manual_profile_ready:
                page.manual_profile_ready = False
                await page.submit('manual-profile')
            await original_sleep(0)

        with patch.object(connector, 'json_post', side_effect=native.post), \
                patch('browser_registration_flow.asyncio.sleep', side_effect=advance):
            claimed = callback.send('claim', {})
            connector.validate_claim(claimed, TASK)
            if cancel:
                with self.assertRaises(RuntimeError):
                    await flow.run(FakeContext(page), page, PROFILE, attempt_observation=observation)
            else:
                await flow.run(FakeContext(page), page, PROFILE, attempt_observation=observation)
        return flow, native

    async def test_pending_email_then_code_keeps_worker_phase_and_finishes(self):
        flow, native = await self.run_native_flow()
        self.assertEqual(native.code_reads, 3)
        self.assertEqual(native.code_phases, ['email_code_required'] * 3)
        self.assertEqual(len(native.results), 1)
        self.assertEqual(native.results[0].email, claim()['email'])
        self.assertEqual(native.results[0].creationStatus, 200)
        self.assertEqual(flow.creation_requests, 1)

    async def test_worker_cancel_blocks_creation_before_network_release(self):
        flow, native = await self.run_native_flow(cancel=True)
        self.assertEqual(native.state['phase'], 'cancelled')
        self.assertEqual(flow.creation_requests, 0)
        self.assertEqual(native.results, [])
        self.assertTrue(flow.observation_failed)
        self.assertEqual(flow.request_rejected_reason, 'callback_rejected')

    async def test_browser_trace_contract_survives_nonce_envelope_and_worker_validation(self):
        _, native = await self.run_native_flow(observation={
            'attemptIp': '203.0.113.7', 'attemptCountry': 'JP', 'observationSource': 'cloudflare_trace'})
        self.assertEqual(native.opened.attemptIp, '203.0.113.7')
        self.assertEqual(native.opened.attemptCountry, 'JP')
        self.assertEqual(native.opened.observationSource, 'cloudflare_trace')
        self.assertEqual(len(native.results), 1)


if __name__ == '__main__':
    unittest.main()
