"""Real browser DOM fixture; all requests are fulfilled locally in memory."""
import asyncio
import os
import unittest
from unittest.mock import patch, AsyncMock
from checkout_core import Stop
from registration_security import totp
from registration_browser import RegistrationBrowser


@unittest.skipUnless(os.environ.get('V2_REGISTRATION_BROWSER_TEST') == '1', 'explicit local fixture')
class BrowserTests(unittest.IsolatedAsyncioTestCase):
    async def test_full_local_registration_flow(self):
        from playwright.async_api import async_playwright
        state = {'registered': False, 'password': None, 'mfa': False}
        events = []; receipts = []; expected = 'owner@example.test'; key = 'JBSWY3DPEHPK3PXP'
        class Job:
            def __init__(self):
                self.payload = dict(email=expected, password='synthetic-only-password', displayName='李华', birthDate='1996-01-01', registered=False, passwordVerified=False, mfaVerified=False, totpSecret=None)
                self.step = 'queued'; self.awaiting_code = False
            def check(self):
                pass
            def event(self, event_type, **data):
                events.append(event_type); self.step = data.get('step', self.step)
                receipts.append((event_type, data))
            def prepare_mail(self, step):
                self.step = step; self.awaiting_code = True
            async def wait_code(self):
                self.awaiting_code = False; return '123456'
            async def manual(self, reason):
                raise AssertionError('Supported local fixture unexpectedly paused: ' + reason)
        html = '''<!doctype html><html><body><main id="app"></main><script>
const root=document.getElementById('app');window.accountEmail='';
function profile(){root.innerHTML='<form><input name="name" autocomplete="name"><input type="date" name="birthdate"><button>Continue</button></form>';root.querySelector('form').onsubmit=async ev=>{ev.preventDefault();await window.fixture('profile',{name:root.querySelector('[name=name]').value,birth:root.querySelector('[name=birthdate]').value});window.accountEmail='owner@example.test';settings();};}
function settings(){root.innerHTML='<button>Security</button><button>Add password</button><button role="switch" aria-label="Authenticator app" aria-checked="false">Authenticator app</button><aside><div aria-label="Special offer">Try 1 month free</div></aside>';const buttons=root.querySelectorAll('button');buttons[0].onclick=()=>{};buttons[1].onclick=()=>{root.innerHTML='<form><input type="password" autocomplete="new-password"><input type="password" autocomplete="new-password"><button>Save password</button></form>';root.querySelector('form').onsubmit=async ev=>{ev.preventDefault();await window.fixture('password',{password:root.querySelector('input').value});settings();};};buttons[2].onclick=()=>{root.innerHTML='<div role="dialog" aria-label="Set authenticator"><span>Scan setup key</span><code>JBSWY3DPEHPK3PXP</code><form><input name="code" autocomplete="one-time-code"><button>Continue</button></form></div>';root.querySelector('form').onsubmit=async ev=>{ev.preventDefault();await window.fixture('enroll',{code:root.querySelector('input').value});settings();root.querySelector('[role=switch]').setAttribute('aria-checked','true');};};}
root.innerHTML='<form><input type="email" name="email"><button>Continue</button></form>';root.querySelector('form').onsubmit=async ev=>{ev.preventDefault();const email=root.querySelector('input').value;const snapshot=await window.fixture('email',{email});if(!snapshot.registered){root.innerHTML='<form><input name="code" autocomplete="one-time-code"><button>Continue</button></form>';root.querySelector('form').onsubmit=ev=>{ev.preventDefault();profile();};}else{root.innerHTML='<form><input type="password" autocomplete="current-password"><button>Continue</button></form>';root.querySelector('form').onsubmit=async ev=>{ev.preventDefault();const check=await window.fixture('login',{password:root.querySelector('input').value});if(!check.correct){root.innerHTML='<p>Wrong password</p>';return;}if(!check.mfa){window.accountEmail=email;settings();return;}root.innerHTML='<p>Authenticator app</p><form><input name="code" autocomplete="one-time-code"><button>Continue</button></form>';root.querySelector('form').onsubmit=async ev=>{ev.preventDefault();await window.fixture('challenge',{code:root.querySelector('input').value});window.accountEmail=email;settings();};};}};
</script></body></html>'''
        async def binding(_source, operation, data):
            if operation == 'email':
                self.assertEqual(data['email'], expected); return dict(state)
            if operation == 'profile':
                self.assertEqual(data, {'name': '李华', 'birth': '1996-01-01'}); state['registered'] = True
            if operation == 'password':
                state['password'] = data['password']
            if operation == 'login':
                return {'correct': state['password'] is not None and data['password'] == state['password'], 'mfa': state['mfa']}
            if operation in {'enroll', 'challenge'}:
                self.assertEqual(data['code'], totp(key)); state['mfa'] = True
            return dict(state)
        async def identity(page, email):
            current = await page.evaluate('window.accountEmail'); self.assertIn(current, ['', expected])
            return ('synthetic-target', 'synthetic-identity') if current == email else None
        async with async_playwright() as driver:
            browser = await driver.chromium.launch(headless=True)
            original_context = browser.new_context
            async def fixture_context():
                context = await original_context(); original_page = context.new_page
                async def fixture_page():
                    page = await original_page(); await page.expose_binding('fixture', binding)
                    async def route_fixture(route):
                        if route.request.url.endswith('/cdn-cgi/trace'):
                            await route.fulfill(content_type='text/plain', body='ip=192.0.2.1\nloc=PH\n')
                        else:
                            await route.fulfill(content_type='text/html', body=html)
                    await page.route('**/*', route_fixture)
                    return page
                context.new_page = fixture_page
                return context
            browser.new_context = fixture_context
            context = await fixture_context(); job = Job(); flow = RegistrationBrowser(job, context)
            async def settle(_seconds=2):
                await asyncio.sleep(.02)
            flow.settle = settle
            try:
                with patch('registration_browser.official_identity', identity):
                    await flow.run()
                self.assertTrue(state['registered']); self.assertTrue(state['mfa']); self.assertEqual(state['password'], job.payload['password'])
                for stage in ['registered', 'password_verified', 'totp_pending', 'mfa_verified', 'offer', 'complete']:
                    self.assertIn(stage, events)
                self.assertTrue(job.payload['passwordVerified']); self.assertTrue(job.payload['mfaVerified'])
                registered = [data for event_type, data in receipts if event_type == 'registered']
                self.assertEqual(len(registered), 1)
                self.assertEqual(registered[0]['registrationCountryCode'], 'PH')
                self.assertNotIn('ip', registered[0])
            finally:
                await browser.close()


class CountryTests(unittest.IsolatedAsyncioTestCase):
    def flow(self):
        class Job:
            payload = {}
            def check(self):
                pass
        flow = RegistrationBrowser(Job(), None)
        flow.page = type('Page', (), {'url': 'https://chatgpt.com/'})()
        return flow

    async def test_country_is_observed_from_registration_page_only(self):
        flow = self.flow()
        with patch('registration_browser.observe_page_network', AsyncMock(return_value={'ip': '192.0.2.1', 'country': 'PH'})) as probe:
            self.assertEqual(await flow.registration_country(), 'PH')
            probe.assert_awaited_once_with(flow.page)

    async def test_unknown_trace_keeps_country_empty(self):
        with patch('registration_browser.observe_page_network', AsyncMock(side_effect=Stop('proxy_network_unconfirmed'))):
            self.assertIsNone(await self.flow().registration_country())
        with patch('registration_browser.observe_page_network', AsyncMock(return_value={'country': 'ZZ'})):
            self.assertIsNone(await self.flow().registration_country())

    async def test_cancelled_probe_is_not_treated_as_success(self):
        with patch('registration_browser.observe_page_network', AsyncMock(side_effect=Stop('cancelled'))):
            with self.assertRaises(Stop) as failure:
                await self.flow().registration_country()
            self.assertEqual(failure.exception.report['reason'], 'cancelled')


if __name__ == '__main__':
    unittest.main()
