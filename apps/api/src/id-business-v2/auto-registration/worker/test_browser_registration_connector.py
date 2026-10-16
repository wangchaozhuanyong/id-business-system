"""Pure fakes: no browser, external network, filesystem credentials or database."""
import asyncio
from datetime import datetime, timezone
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import browser_registration_connector as connector
from browser_registration_flow import (RegistrationFlow, Stop, TRACE_URL, SIGNUP_ENTRY_TEXT, observe_browser_exit,
    parse_exit_trace, official, profile_details, submit_for, unique_visible)


TASK = '11111111-1111-4111-8111-111111111111'
ORIGIN = 'https://admin.example.test'
PROFILE = 'a' * 32


def payload():
    return {'taskUuid': TASK, 'launchToken': 'x' * 64,
            'callbackBaseUrl': ORIGIN + '/api/id-business-v2/auto-registration/browser/tasks/' + TASK}


def claim():
    return {'taskUuid': TASK, 'email': 'fixture@example.test', 'password': 'private-example-password',
            'proxy': 'socks5://user:pass@proxy.example.test:1080',
            'bitBrowser': {'apiUrl': 'http://127.0.0.1:54345', 'apiToken': 'local-private-token'}}


class SecurityTests(unittest.TestCase):
    def test_exact_https_origin(self):
        self.assertEqual(connector.origin(ORIGIN), ORIGIN)
        for url in ('http://admin.example.test', 'https://127.0.0.1', 'https://localhost',
                    'https://127.0.0.2', 'https://localhost.', 'https://dev.localhost',
                    ORIGIN + '/path', ORIGIN + '?secret=a', 'https://admin.example.test.evil/x',
                    'https://user:secret@admin.example.test', ORIGIN + ':444', ORIGIN + '#x'):
            with self.subTest(url=url), self.assertRaises(Stop):
                connector.origin(url)

    def test_launch_binds_origin_task_and_fixed_path(self):
        self.assertEqual(connector.launch_payload(payload(), {ORIGIN}, ORIGIN), payload())
        for changes in ({'callbackBaseUrl': payload()['callbackBaseUrl'] + '/claim'},
                        {'callbackBaseUrl': payload()['callbackBaseUrl'].replace('admin.', 'evil.')},
                        {'taskUuid': 'not-a-uuid'}, {'launchToken': 'x\nAuthorization:secret'},
                        {'password': 'never-accept-browser-password'}):
            with self.subTest(changes=changes), self.assertRaises(Stop):
                connector.launch_payload({**payload(), **changes}, {ORIGIN}, ORIGIN)

    def test_nonce_and_token_only_go_to_callback_headers(self):
        client = connector.CallbackClient(payload())
        with patch.object(connector, 'json_post', return_value={'success': True, 'data': {'accepted': True}}) as post:
            self.assertTrue(client.send('event', {'event': 'password_submitting'})['accepted'])
        url, body, headers = post.call_args.args
        self.assertEqual(url, payload()['callbackBaseUrl'] + '/event')
        self.assertEqual(headers['Authorization'], 'Bearer ' + payload()['launchToken'])
        self.assertRegex(headers['X-Registration-Browser-Nonce'], r'^[a-f0-9]{64}$')
        self.assertNotIn(payload()['launchToken'], json.dumps(body))
        client.clear()
        self.assertEqual(client.token, '')

    def test_unknown_callback_operation_rejected(self):
        with self.assertRaises(Stop):
            connector.CallbackClient(payload()).send('../other', {})

    def test_only_result_gets_extended_callback_deadline(self):
        client = connector.CallbackClient(payload())
        with patch.object(connector, 'json_post', return_value={'accepted': True}) as post:
            for action, timeout in (('result', 75), ('code', 20), ('event', 15)):
                client.send(action, {})
                self.assertEqual(post.call_args.kwargs['timeout'], timeout)

    def test_proxy_is_only_explicit_worker_choice(self):
        selected = connector.fixed_proxy(claim()['proxy'])
        self.assertEqual(selected['host'], 'proxy.example.test')
        self.assertEqual(selected['proxyType'], 'socks5')
        escaped = connector.fixed_proxy('http://a%40b:p%3Ass@proxy.example.test:80')
        self.assertEqual((escaped['proxyUserName'], escaped['proxyPassword']), ('a@b', 'p:ss'))
        self.assertEqual(connector.fixed_proxy(None), {'proxyMethod': 2, 'proxyType': 'noproxy'})
        for value in ('file:///etc/passwd', 'http://host/path', 'https://host:443?key=secret',
                      'http://a%0Ab:b@host:80', 'socks4://host:90'):
            with self.subTest(value=value), self.assertRaises(Stop):
                connector.fixed_proxy(value)

    def test_claim_needs_fixed_identity_password_and_configuration(self):
        self.assertEqual(connector.validate_claim(claim(), TASK), claim())
        for change in ({'taskUuid': 'different'}, {'password': None}, {'email': 'short'},
                       {'proxy': 'https://example.test/path'}, {'bitBrowser': {}}):
            with self.subTest(change=change), self.assertRaises(Stop):
                connector.validate_claim({**claim(), **change}, TASK)

    def test_duplicate_json_keys_rejected(self):
        with self.assertRaises(Stop):
            json.loads('{"launchToken":"a","launchToken":"b"}', object_pairs_hook=connector.object_pairs)

    def test_exception_never_contains_original_message(self):
        self.assertEqual(str(Stop('secret-cookie-value')), 'operation_failed')
        self.assertEqual(connector.failure_reason('private-http-message'), 'connector_error')

    def test_local_endpoint_is_loopback_only(self):
        for value in ('https://127.0.0.1:54345', 'http://example.test:54345',
                      'http://user:pass@127.0.0.1:54345', 'http://127.0.0.1:54345/path'):
            with self.subTest(value=value), self.assertRaises(Stop):
                connector.local_url(value)

    def test_official_origin_not_lookalike(self):
        self.assertTrue(official('https://auth.openai.com/create-account'))
        self.assertTrue(official('https://chatgpt.com/'))
        for value in ('http://auth.openai.com', 'https://auth.openai.com.evil/',
                      'https://user:pass@auth.openai.com/', 'https://auth.openai.com:8443/'):
            self.assertFalse(official(value))

    def test_profile_never_invents_name_or_birthday(self):
        self.assertIsNone(profile_details(None))
        self.assertIsNone(profile_details({'name': 'Provided'}))
        self.assertIsNone(profile_details({'name': 'Provided', 'birthDate': '2099-01-01'}))
        self.assertIsNone(profile_details({'name': 'Provided', 'birthDate': '2000-02-30'}))
        self.assertEqual(profile_details({'name': 'Provided', 'birthDate': '1990-02-20'}),
                         {'name': 'Provided', 'birthDate': '1990-02-20'})

    def test_trace_is_plain_text_and_only_keeps_valid_ip_country(self):
        result = parse_exit_trace('h=cloudflare.com\nip=203.0.113.7\nloc=JP\nuag=not-recorded\n')
        self.assertEqual(result, {'attemptIp': '203.0.113.7', 'attemptCountry': 'JP',
                                 'observationSource': 'cloudflare_trace'})
        self.assertEqual(parse_exit_trace('ip=2001:db8::1\nloc=MY')['attemptIp'], '2001:db8::1')
        for body in ('{"ip":"203.0.113.7","loc":"JP"}', '<html>ip=203.0.113.7\nloc=JP</html>',
                     'ip=not-an-ip\nloc=JP', 'ip=203.0.113.7\nloc=',
                     'ip=203.0.113.7\nloc=jp', 'ip=203.0.113.7\nloc=JP\nip=203.0.113.8',
                     'ip=203.0.113.7\nloc=JP\nloc=MY', 'x' * 16385):
            with self.subTest(body=body[:40]):
                self.assertEqual(parse_exit_trace(body), {})

    def test_signup_entry_aliases_are_exact_and_never_login(self):
        for label in ('Sign up', 'Sign up for free', 'Create account', 'Create an account',
                      '注册', '免费注册', '创建账号'):
            self.assertIsNotNone(SIGNUP_ENTRY_TEXT.fullmatch(label))
        for label in ('Sign in', 'Log in', '登录', 'Already have an account? Sign up',
                      'Create an account and pay', '注册并充值'):
            self.assertIsNone(SIGNUP_ENTRY_TEXT.fullmatch(label))

    def test_profile_diagnostic_only_records_closed_states_not_values_or_unknown_keys(self):
        expected = connector.fixed_proxy(claim()['proxy'])
        detail = {'id': PROFILE, 'syncTabs': False, 'syncCookies': True,
                  'syncLocalStorage': 'raw-cookie-should-not-appear', 'syncIndexedDb': 0,
                  'proxyMethod': 2, 'proxyType': 'wrong-raw-type-value',
                  'host': 'do-not-log-host', 'port': 1080,
                  'proxyUserName': expected['proxyUserName'],
                  'proxyPassword': 'raw-proxy-password-never-log',
                  'unknown-raw-key-never-log': 'raw-secret-value'}
        value = connector.profile_readback_diagnostic(PROFILE, detail, expected)
        self.assertEqual(value['sync'], {'syncTabs': 'false', 'syncCookies': 'true',
            'syncLocalStorage': 'wrong_type', 'syncIndexedDb': 'wrong_type', 'syncAuthorization': 'absent'})
        self.assertEqual(value['proxy'], {'proxyMethod': 'matches', 'proxyType': 'mismatch',
            'host': 'mismatch', 'port': 'matches', 'proxyUserName': 'matches', 'proxyPassword': 'mismatch'})
        serialized = json.dumps(value)
        for secret in ('raw-cookie-should-not-appear', 'wrong-raw-type-value', 'do-not-log-host',
                       'raw-proxy-password-never-log', 'unknown-raw-key-never-log', 'raw-secret-value',
                       claim()['bitBrowser']['apiToken'], claim()['password'], claim()['proxy']):
            self.assertNotIn(secret, serialized)

    def test_profile_detail_gate_failure_retains_closed_diagnostic_without_open(self):
        bit = connector.BitBrowserClient(claim()['bitBrowser'])
        with patch.object(bit, 'post', side_effect=[{'id': PROFILE}, {'id': PROFILE}]) as post:
            with self.assertRaises(Stop):
                bit.create(TASK, claim()['proxy'], {})
        self.assertEqual(bit.created_profile_id, PROFILE)
        self.assertEqual(bit.profile_diagnostic['readback'], 'observed')
        self.assertEqual(set(bit.profile_diagnostic['sync'].values()), {'absent'})
        self.assertEqual(set(bit.profile_diagnostic['proxy'].values()), {'absent'})
        self.assertEqual([call.args[0] for call in post.call_args_list], ['/browser/update', '/browser/detail'])

    def test_profile_detail_transport_failure_preserves_safe_unavailable_summary(self):
        bit = connector.BitBrowserClient(claim()['bitBrowser'])
        with patch.object(bit, 'post', side_effect=[{'id': PROFILE}, Stop('bitbrowser_unavailable')]):
            with self.assertRaises(Stop):
                bit.create(TASK, None, {})
        self.assertEqual(bit.profile_diagnostic['readback'], 'unavailable')
        self.assertEqual(bit.profile_diagnostic['proxy'], {'proxyMethod': 'absent', 'proxyType': 'absent'})

    def test_native_profile_ignores_recharge_proxy_and_fingerprint(self):
        bit = connector.BitBrowserClient(claim()['bitBrowser'])
        detail = {'id': PROFILE, 'syncTabs': False, 'syncCookies': False,
                  'syncLocalStorage': False, 'syncIndexedDb': False, 'syncAuthorization': False,
                  **connector.fixed_proxy(claim()['proxy'])}
        with patch.object(bit, 'post', side_effect=[{'id': PROFILE}, detail]) as post:
            bit.create(TASK, claim()['proxy'], {'proxyMode': 'dynamic', 'staticHost': 'evil',
                'dynamicProxyUrl': 'https://evil.test', 'os': 'Win32', 'coreVersion': '152'})
        body = post.call_args_list[0].args[1]
        self.assertEqual(body['host'], 'proxy.example.test')
        self.assertEqual(body['proxyMethod'], 2)
        self.assertNotIn('os', body['browserFingerPrint'])
        self.assertEqual(body['password'], '')
        self.assertFalse(body['credentialsEnableService'])
        self.assertNotIn('dynamicIpUrl', body)

    def test_sync_or_proxy_readback_mismatch_stops_before_open(self):
        bit = connector.BitBrowserClient(claim()['bitBrowser'])
        for detail in ({'id': PROFILE}, {'id': PROFILE, 'syncCookies': True}):
            with patch.object(bit, 'post', side_effect=[{'id': PROFILE}, detail]) as post:
                with self.assertRaises(Stop):
                    bit.create(TASK, None, {})
                self.assertEqual(post.call_count, 2)
                self.assertEqual(bit.created_profile_id, PROFILE)

    def test_official_profile_string_and_mandatory_fingerprint_object(self):
        profile = '2c9c2dsdsd323xceeeds24a30065'
        bit = connector.BitBrowserClient(claim()['bitBrowser'])
        detail = {'id': profile, 'syncTabs': False, 'syncCookies': False,
                  'syncLocalStorage': False, 'syncIndexedDb': False, 'syncAuthorization': False,
                  'proxyMethod': 2, 'proxyType': 'noproxy'}
        with patch.object(bit, 'post', side_effect=[{'id': profile}, detail]) as post:
            self.assertEqual(bit.create(TASK, None, None), profile)
        self.assertEqual(post.call_args_list[0].args[1]['browserFingerPrint'], {})

    def test_official_http_debug_authority_is_only_loopback(self):
        bit = connector.BitBrowserClient(claim()['bitBrowser'])
        with patch.object(bit, 'post', return_value={'http': '127.0.0.1:53325'}):
            self.assertEqual(bit.open(PROFILE), 'http://127.0.0.1:53325')
        for endpoint in ('example.test:53325', '127.0.0.1:999999', '127.0.0.1:53325?secret=a'):
            with patch.object(bit, 'post', return_value={'http': endpoint}), self.assertRaises(Stop):
                bit.open(PROFILE)

    def test_job_duplicate_is_idempotent_and_different_capability_conflicts(self):
        runner = AsyncMock()
        jobs = connector.JobRegistry(runner)
        with patch.object(connector.threading, 'Thread') as thread:
            jobs.start(payload())
            jobs.start(payload())
            self.assertEqual(thread.call_count, 1)
            with self.assertRaises(Stop):
                jobs.start({**payload(), 'launchToken': 'y' * 64})
            with self.assertRaises(Stop):
                jobs.start({**payload(), 'taskUuid': '22222222-2222-4222-8222-222222222222'})

    def test_host_and_origin_must_each_be_single_exact_value(self):
        from email.message import Message
        handler = object.__new__(connector.Handler)
        handler.allowed_origins = {ORIGIN}
        handler.headers = Message()
        handler.headers['Host'] = '127.0.0.1:55324'
        handler.headers['Origin'] = ORIGIN
        self.assertEqual(handler.allowed(), ORIGIN)
        handler.headers['Host'] = '127.0.0.1:55324'
        with self.assertRaises(Stop):
            handler.allowed()

    def test_http_callback_errors_do_not_leak_body_or_url(self):
        with patch.object(connector, 'build_opener') as opener:
            opener.return_value.open.side_effect = ValueError('password=never-print-me')
            with self.assertRaises(Stop) as error:
                connector.json_post('https://test.invalid', {}, {})
        self.assertEqual(str(error.exception), 'callback_unavailable')

    def test_no_recharge_or_database_imports(self):
        import ast
        directory = Path(__file__).parent
        forbidden = {'pay', 'bitbrowser_connector', 'sqlite3', 'sqlalchemy', 'workspace', 'src'}
        for filename in ('browser_registration_connector.py', 'browser_registration_flow.py'):
            tree = ast.parse((directory / filename).read_text())
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    self.assertFalse({name.name.split('.')[0] for name in node.names} & forbidden)
                if isinstance(node, ast.ImportFrom):
                    self.assertNotIn((node.module or '').split('.')[0], forbidden)


class FlowTests(unittest.IsolatedAsyncioTestCase):
    def route(self, url, method='POST'):
        return SimpleNamespace(request=SimpleNamespace(method=method, url=url,
            is_navigation_request=Mock(return_value=False), frame=SimpleNamespace(parent_frame=None)),
            abort=AsyncMock(), continue_=AsyncMock())

    async def test_trace_browser_navigation_validates_fixed_final_source_and_body(self):
        response = SimpleNamespace(status=200, url=TRACE_URL,
            request=SimpleNamespace(redirected_from=None),
            all_headers=AsyncMock(return_value={'content-type': 'text/plain; charset=UTF-8'}))
        page = SimpleNamespace(url=TRACE_URL, route=AsyncMock(), unroute=AsyncMock(),
            goto=AsyncMock(return_value=response), locator=Mock(return_value=SimpleNamespace(
                inner_text=AsyncMock(return_value='ip=203.0.113.7\nloc=JP'))))
        self.assertEqual((await observe_browser_exit(page))['attemptCountry'], 'JP')
        page.goto.assert_awaited_once_with(TRACE_URL, wait_until='domcontentloaded', timeout=15000)
        page.unroute.assert_awaited_once()
        for changes in ({'status': 403}, {'url': 'https://evil.test/cdn-cgi/trace'},
                        {'request': SimpleNamespace(redirected_from=object())},
                        {'all_headers': AsyncMock(return_value={'content-type': 'text/html'})}):
            original = dict(response.__dict__)
            response.__dict__.update(changes)
            self.assertEqual(await observe_browser_exit(page), {})
            response.__dict__.update(original)

    async def test_trace_failure_is_optional_and_redirect_request_is_blocked(self):
        page = SimpleNamespace(route=AsyncMock(), unroute=AsyncMock(),
                               goto=AsyncMock(side_effect=TimeoutError('private detail')))
        self.assertEqual(await observe_browser_exit(page), {})
        guard = page.route.call_args.args[1]
        route = self.route('https://evil.test/redirect', 'GET')
        route.request.redirected_from = object()
        await guard(route)
        route.abort.assert_awaited_once()
        route = self.route(TRACE_URL, 'GET')
        route.request.redirected_from = None
        await guard(route)
        route.continue_.assert_awaited_once()

    async def test_created_profile_is_reported_when_detail_readback_fails(self):
        callback = Mock()
        callback.send.side_effect = lambda action, body: claim() if action == 'claim' else {'accepted': True}
        bit = Mock(created_profile_id=PROFILE)
        bit.create.side_effect = Stop('profile_unverified')
        state = {'status': 'accepted'}
        with patch.object(connector, 'CallbackClient', return_value=callback), \
                patch.object(connector, 'BitBrowserClient', return_value=bit):
            await connector.execute(payload(), state)
        self.assertEqual(state['profileId'], PROFILE)
        fails = [call.args[1] for call in callback.send.call_args_list if call.args[0] == 'fail']
        self.assertEqual(fails[0]['profileId'], PROFILE)
        self.assertFalse(fails[0]['sideEffectPossible'])
        bit.open.assert_not_called()

    async def test_failed_new_profile_diagnostic_is_retained_and_logged_as_one_safe_json_line(self):
        callback = Mock()
        callback.send.side_effect = lambda action, body: claim() if action == 'claim' else {'accepted': True}
        diagnostic = connector.profile_readback_diagnostic(PROFILE, {'id': PROFILE}, connector.fixed_proxy(None))
        bit = Mock(created_profile_id=PROFILE, profile_diagnostic=diagnostic)
        bit.create.side_effect = Stop('profile_unverified')
        state = {'status': 'accepted'}
        with patch.object(connector, 'CallbackClient', return_value=callback), \
                patch.object(connector, 'BitBrowserClient', return_value=bit), patch('builtins.print') as log:
            await connector.execute(payload(), state)
        self.assertEqual(state['profileDiagnostic'], diagnostic)
        log.assert_called_once()
        line = log.call_args.args[0]
        self.assertNotIn('\n', line)
        self.assertEqual(json.loads(line), diagnostic)
        self.assertTrue(log.call_args.kwargs['flush'])
        for action in callback.send.call_args_list:
            if action.args[0] == 'fail':
                self.assertNotIn('profileDiagnostic', action.args[1])

    async def test_password_network_write_blocked_without_ack(self):
        flow = RegistrationFlow(claim(), Mock())
        route = self.route('https://auth.openai.com/api/accounts/user/register')
        await flow.guard_request(route)
        route.abort.assert_awaited_once()
        route.continue_.assert_not_awaited()

    async def test_password_requires_server_accepted_ack(self):
        callback = Mock()
        callback.send.return_value = {'accepted': False}
        flow = RegistrationFlow(claim(), callback)
        with self.assertRaises(Stop):
            await flow.event('password_submitting')
        self.assertFalse(flow.password_ack)

    async def test_second_password_or_creation_post_is_blocked(self):
        for endpoint in ('user/register', 'create_account', 'email-otp/validate'):
            callback = Mock()
            callback.send.return_value = {'accepted': True}
            flow = RegistrationFlow(claim(), callback)
            flow.last_event = {'event': 'password_submitting', 'sequence': 3, 'profileId': PROFILE}
            flow.password_ack = True
            route = self.route('https://auth.openai.com/api/accounts/' + endpoint)
            await flow.guard_request(route)
            await flow.guard_request(route)
            self.assertEqual(route.continue_.await_count, 1)
            self.assertEqual(route.abort.await_count, 1)
            self.assertTrue(flow.side_effect_possible)

    async def test_challenge_requests_untouched_no_token_processing(self):
        flow = RegistrationFlow(claim(), Mock())
        route = self.route('https://challenges.cloudflare.com/example')
        await flow.guard_request(route)
        route.continue_.assert_awaited_once()
        self.assertEqual(flow.critical_requests, {})

    async def test_payment_writes_are_blocked(self):
        flow = RegistrationFlow(claim(), Mock())
        route = self.route('https://api.stripe.com/v1/payment_intents')
        await flow.guard_request(route)
        route.abort.assert_awaited_once()

    async def test_creation_requires_official_fixed_path_status_json_no_error(self):
        for status, raw, source, expected in (
                (200, b'{}', 'https://auth.openai.com/api/accounts/create_account', 200),
                (400, b'{}', 'https://auth.openai.com/api/accounts/create_account', None),
                (200, b'{"error":"rejected"}', 'https://auth.openai.com/api/accounts/create_account', None),
                (200, b'[]', 'https://auth.openai.com/api/accounts/create_account', None),
                (200, b'not json', 'https://auth.openai.com/api/accounts/create_account', None),
                (200, b'{}', 'https://evil.test/api/accounts/create_account', None)):
            with self.subTest(status=status, raw=raw):
                flow = RegistrationFlow(claim(), Mock())
                frame = object()
                response = SimpleNamespace(url=source, request=SimpleNamespace(method='POST'),
                    status=status, frame=frame, body=AsyncMock(return_value=raw))
                await flow.observe_creation(response, SimpleNamespace(main_frame=frame))
                self.assertEqual(flow.creation_status, expected)

    async def test_session_requires_full_email_match(self):
        flow = RegistrationFlow(claim(), Mock())
        page = SimpleNamespace(url='https://chatgpt.com/', evaluate=AsyncMock(return_value={
            'user': {'id': 'user-fixture', 'email': 'another@example.test'}, 'accessToken': 'secret' * 10}))
        with self.assertRaises(Stop) as error:
            await flow.identity(page)
        self.assertEqual(error.exception.reason, 'identity_mismatch')

    async def test_identity_is_separate_from_creation_evidence(self):
        flow = RegistrationFlow(claim(), Mock())
        flow.profile_id = PROFILE
        page = SimpleNamespace(url='https://chatgpt.com/', evaluate=AsyncMock(return_value={
            'user': {'id': 'user-fixture', 'email': claim()['email']}, 'accessToken': 'secret' * 10}))
        data = await flow.identity(page)
        self.assertIsNone(data['creationStatus'])
        self.assertTrue(flow.identity_user_present)
        self.assertNotIn('password', data)
        self.assertEqual(data['session'], {'accessToken': 'secret' * 10})

    async def test_error_session_does_not_prove_anonymous(self):
        flow = RegistrationFlow(claim(), Mock())
        page = SimpleNamespace(url='https://chatgpt.com/', evaluate=AsyncMock(return_value={'error': 'blocked'}))
        self.assertIsNone(await flow.identity(page))
        self.assertFalse(flow.identity_anonymous_verified)

    async def test_unique_visible_does_not_choose_among_ambiguous_inputs(self):
        visible = SimpleNamespace(is_visible=AsyncMock(return_value=True))
        scope = SimpleNamespace(locator=Mock(return_value=SimpleNamespace(
            count=AsyncMock(return_value=2), nth=Mock(return_value=visible))))
        with self.assertRaises(Stop):
            await unique_visible(scope, 'input')

    async def test_form_action_must_be_official(self):
        form = SimpleNamespace(count=AsyncMock(return_value=1),
            get_attribute=AsyncMock(return_value='https://evil.test/steal'))
        field = SimpleNamespace(locator=Mock(return_value=form))
        with self.assertRaises(Stop):
            await submit_for(SimpleNamespace(url='https://auth.openai.com/create-account'), field)

    async def test_foreign_top_navigation_and_credential_endpoint_blocked(self):
        flow = RegistrationFlow(claim(), Mock())
        route = self.route('https://evil.test/steal', 'GET')
        route.request.is_navigation_request.return_value = True
        await flow.guard_request(route)
        route.abort.assert_awaited_once()
        route = self.route('https://evil.test/api/accounts/user/register')
        await flow.guard_request(route)
        route.abort.assert_awaited_once()

    async def test_full_visible_signup_manual_profile_and_official_identity(self):
        page = FakePage()
        context = FakeContext(page)
        callback = Mock()
        replies = []

        def send(action, body):
            replies.append((action, body))
            if action == 'event' and body['event'] == 'profile_required':
                page.manual_profile_ready = True
            return {'code': '123456'} if action == 'code' else {'accepted': True}

        callback.send.side_effect = send
        tick = [0]

        def clock():
            tick[0] += 1
            return tick[0]

        flow = RegistrationFlow(claim(), callback, clock=clock)
        page.flow = flow
        original_sleep = asyncio.sleep

        async def advance(_):
            if page.manual_profile_ready:
                page.manual_profile_ready = False
                await page.submit('manual-profile')
            await original_sleep(0)

        with patch('browser_registration_flow.asyncio.sleep', side_effect=advance):
            await flow.run(context, page, PROFILE)
        events = [body['event'] for action, body in replies if action == 'event']
        self.assertIn('profile_required', events)
        code_events = [body['sequence'] for action, body in replies
                       if action == 'event' and body['event'] == 'email_code_required']
        self.assertEqual(len(set(code_events)), 1)
        self.assertEqual(page.submissions, ['email', 'password', 'code', 'manual-profile'])
        self.assertTrue(page.password_ack_at_submit)
        self.assertEqual(page.values['email'], claim()['email'])
        self.assertEqual(page.values['password'], claim()['password'])
        self.assertEqual(page.values['code'], '123456')
        results = [body for action, body in replies if action == 'result']
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]['email'], claim()['email'])
        self.assertEqual(results[0]['creationEvidence'], {'pathKind': 'create_account',
            'httpStatus': 200, 'noError': True, 'officialOrigin': True})
        self.assertNotIn('password', results[0])
        self.assertEqual(flow.creation_requests, 1)
        self.assertFalse(page.listener_attached)

    async def test_full_flow_password_ack_failure_never_submits_password(self):
        page = FakePage()
        callback = Mock()
        callback.send.side_effect = lambda action, body: {
            'accepted': not (action == 'event' and body['event'] == 'password_submitting')}
        flow = RegistrationFlow(claim(), callback)
        page.flow = flow
        with patch('browser_registration_flow.asyncio.sleep', new=AsyncMock()):
            with self.assertRaises(Stop):
                await flow.run(FakeContext(page), page, PROFILE)
        self.assertEqual(page.submissions, ['email'])
        self.assertNotEqual(page.values.get('password'), claim()['password'])
        self.assertFalse(flow.side_effect_possible)
        self.assertFalse(page.listener_attached)

    async def test_navigation_timeout_detaches_listener_without_closing_window(self):
        page = FakePage()
        page.goto = AsyncMock(side_effect=TimeoutError('secret-url-not-reported'))
        callback = Mock()
        callback.send.return_value = {'accepted': True}
        flow = RegistrationFlow(claim(), callback)
        with self.assertRaises(TimeoutError):
            await flow.run(FakeContext(page), page, PROFILE)
        self.assertFalse(page.listener_attached)

    async def test_initial_session_unknown_never_fills_or_submits_email(self):
        page = FakePage()
        page.evaluate = AsyncMock(return_value=None)
        callback = Mock()
        callback.send.return_value = {'accepted': True}
        tick = iter(range(200))
        flow = RegistrationFlow(claim(), callback, timeout=5, clock=lambda: next(tick))
        with patch('browser_registration_flow.asyncio.sleep', new=AsyncMock()):
            with self.assertRaises(Stop) as error:
                await flow.run(FakeContext(page), page, PROFILE)
        self.assertEqual(error.exception.reason, 'registration_timeout')
        self.assertEqual(page.submissions, [])
        self.assertEqual(page.values, {})


class FakeContext:
    def __init__(self, page):
        self.page = page

    async def route(self, _pattern, guard):
        self.page.guard = guard

    async def unroute(self, *_):
        return None


class FakeLocator:
    def __init__(self, page, kind, present=True):
        self.page, self.kind, self.present = page, kind, present

    async def count(self):
        return 1 if self.present else 0

    def nth(self, _):
        return self

    async def is_visible(self):
        return self.present

    async def is_enabled(self):
        return True

    def locator(self, selector):
        return FakeLocator(self.page, 'form' if selector.startswith('xpath') else 'submit')

    async def get_attribute(self, _):
        return None

    async def fill(self, value):
        self.page.values[self.kind] = value

    async def click(self, **_):
        await self.page.submit(self.page.stage)


class FakePage:
    def __init__(self):
        self.url = 'about:blank'
        self.stage = 'email'
        self.main_frame = object()
        self.values, self.submissions = {}, []
        self.listener_attached = False
        self.manual_profile_ready = False
        self.password_ack_at_submit = False

    def is_closed(self):
        return False

    async def goto(self, target, **_kwargs):
        self.url = target if target == 'https://chatgpt.com/' else 'https://auth.openai.com/create-account'

    def on(self, _event, callback):
        self.observed = callback
        self.listener_attached = True

    def remove_listener(self, *_):
        self.listener_attached = False

    def locator(self, selector):
        key = ('password' if 'password' in selector else 'code' if 'one-time-code' in selector
               else 'name' if 'name="name"' in selector else 'birthday' if 'date' in selector else 'email')
        present = self.stage == key or self.stage == 'profile' and key == 'name'
        return FakeLocator(self, key, present)

    def get_by_role(self, *_args, **_kwargs):
        return FakeLocator(self, 'entry', False)

    async def evaluate(self, _):
        return {'user': {'id': 'user-fixture', 'email': claim()['email']},
                'accessToken': 'official-private-access-token'} if self.stage == 'complete' else {'user': None}

    async def submit(self, kind):
        self.submissions.append(kind)
        endpoint = {'password': 'user/register', 'code': 'email-otp/validate',
                    'manual-profile': 'create_account'}.get(kind)
        if endpoint:
            request = SimpleNamespace(method='POST', url='https://auth.openai.com/api/accounts/' + endpoint,
                is_navigation_request=Mock(return_value=False), frame=SimpleNamespace(parent_frame=None))
            route = SimpleNamespace(request=request, abort=AsyncMock(), continue_=AsyncMock())
            await self.guard(route)
            if route.abort.await_count:
                raise RuntimeError('blocked')
        if kind == 'password':
            self.password_ack_at_submit = self.flow.password_ack
        if kind == 'manual-profile':
            response = SimpleNamespace(url=request.url, request=request, status=200,
                frame=self.main_frame, body=AsyncMock(return_value=b'{}'))
            self.observed(response)
            self.stage, self.url = 'complete', 'https://chatgpt.com/'
        else:
            self.stage, path = {'email': ('password', 'create-account/password'),
                'password': ('code', 'email-verification'), 'code': ('profile', 'about-you')}[kind]
            self.url = 'https://auth.openai.com/' + path


if __name__ == '__main__':
    unittest.main()
