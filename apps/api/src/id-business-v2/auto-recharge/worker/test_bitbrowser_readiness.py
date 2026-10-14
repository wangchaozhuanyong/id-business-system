"""原窗口代理预检和登录页面同步；仅合成数据，不访问外网。"""
from types import SimpleNamespace
import json
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import AsyncMock, patch

import browser_checkout
import browser_password_login
from browser_session import SessionBudget
from checkout_core import BrowserCredential, Credential, Stop


class ProxyPreparationTests(unittest.IsolatedAsyncioTestCase):
    def make_context(self, status=200):
        page = SimpleNamespace(url='about:blank', goto=AsyncMock(return_value=SimpleNamespace(status=status)),
                               title=AsyncMock(return_value='ChatGPT'))
        context = SimpleNamespace(pages=[page], route=AsyncMock(), unroute=AsyncMock())
        return context, page

    async def test_original_tab_reads_exit_then_home_and_removes_guard(self):
        context, page = self.make_context()
        network = {'ip': '8.8.8.8', 'country': 'PH', 'observedAt': '2026-10-09T00:00:00Z'}
        with patch.object(browser_checkout, 'observe_page_network', AsyncMock(return_value=network)) as probe:
            result = await browser_checkout.prepare_proxy_in_context(context, 'PH', budget=SessionBudget(600))
        self.assertEqual(result, network)
        self.assertEqual([call.args[0] for call in page.goto.await_args_list],
                         ['https://chatgpt.com/cdn-cgi/trace', 'https://chatgpt.com/'])
        self.assertIs(probe.await_args.args[0], page)
        self.assertEqual(probe.await_args.args[1].seconds, 20)
        context.route.assert_not_awaited()
        context.unroute.assert_not_awaited()

    async def test_wrong_country_stops_before_home(self):
        context, page = self.make_context()
        with patch.object(browser_checkout, 'observe_page_network', AsyncMock(return_value={
                'ip': '8.8.8.8', 'country': 'US'})), self.assertRaises(Stop) as error:
            await browser_checkout.prepare_proxy_in_context(context, 'PH', budget=SessionBudget(600))
        self.assertEqual(error.exception.report['reason'], 'proxy_country_mismatch')
        self.assertEqual(page.goto.await_count, 1)

    async def test_challenge_and_http_failure_never_become_proxy_network_failure(self):
        for status, reason in ((403, 'verification_required'), (500, 'http_error')):
            context, page = self.make_context(status)
            with self.subTest(status=status), self.assertRaises(Stop) as error:
                await browser_checkout.prepare_proxy_in_context(context, budget=SessionBudget(600))
            self.assertEqual(error.exception.report['reason'], reason)
            self.assertEqual(page.goto.await_count, 1)
            context.unroute.assert_not_awaited()

    async def test_explicit_transport_failure_is_redacted_and_bounded(self):
        context, page = self.make_context()
        page.goto.side_effect = RuntimeError('net::ERR_PROXY_CONNECTION_FAILED secret-url')
        with self.assertRaises(Stop) as error:
            await browser_checkout.prepare_proxy_in_context(context, budget=SessionBudget(600))
        self.assertEqual(error.exception.report['reason'], 'proxy_network_error')
        self.assertNotIn('secret-url', str(error.exception.report))
        context.unroute.assert_not_awaited()


class LoginReadinessTests(unittest.IsolatedAsyncioTestCase):
    async def test_restore_refresh_and_ui_sync_share_one_refresh_allowance(self):
        page, target, refreshed, identity, budget = self.make([False] * 10, seconds=25)
        budget.refresh_count = 1
        with patch.object(browser_checkout, 'check_session', AsyncMock(return_value=(refreshed, identity))), \
                patch.object(browser_checkout.asyncio, 'sleep', AsyncMock()), self.assertRaises(Stop) as error:
            await browser_checkout.synchronize_login_page(page, target, identity, budget=budget)
        self.assertEqual(error.exception.report['reason'], 'official_login_page_not_ready')
        page.reload.assert_not_awaited()

    def make(self, sequence, seconds=30):
        self.now = 0
        target = BrowserCredential('synthetic-session', 'synthetic-account', 'synthetic-user', '')
        refreshed = Credential('synthetic-access', target.account_id, 2000000000)
        identity = {'account_matched': True, 'current_plan': 'free'}
        page = SimpleNamespace(evaluate=AsyncMock(), reload=AsyncMock(return_value=SimpleNamespace(status=200)))
        items = iter(sequence)

        async def evaluate(*_):
            self.now += 6
            return next(items)

        page.evaluate.side_effect = evaluate
        budget = SessionBudget(seconds, clock=lambda: self.now)
        return page, target, refreshed, identity, budget

    async def test_identity_alone_waits_for_page_without_refreshing(self):
        page, target, refreshed, identity, budget = self.make([False, False, True])
        with patch.object(browser_checkout, 'check_session', AsyncMock(return_value=(refreshed, identity))) as check, \
                patch.object(browser_checkout.asyncio, 'sleep', AsyncMock()):
            result_target, result_identity = await browser_checkout.synchronize_login_page(
                page, target, identity, budget=budget)
        page.reload.assert_not_awaited()
        self.assertEqual(check.await_count, 3)
        self.assertEqual(result_identity, identity)
        self.assertEqual(result_target.account_id, target.account_id)
        self.assertEqual(result_target.user_id, target.user_id)
        self.assertEqual(result_target.session_token, '')
        self.assertIn('accounts-profile-button', page.evaluate.await_args.args[0])

    async def test_already_ready_does_not_refresh_or_wait_for_all_resources(self):
        page, target, refreshed, identity, budget = self.make([True])
        with patch.object(browser_checkout, 'check_session', AsyncMock(return_value=(refreshed, identity))):
            await browser_checkout.synchronize_login_page(page, target, identity, budget=budget)
        page.reload.assert_not_awaited()

    async def test_permanent_anonymous_ui_finishes_without_infinite_refresh(self):
        page, target, refreshed, identity, budget = self.make([False] * 10, seconds=25)
        with patch.object(browser_checkout, 'check_session', AsyncMock(return_value=(refreshed, identity))), \
                patch.object(browser_checkout.asyncio, 'sleep', AsyncMock()), self.assertRaises(Stop) as error:
            await browser_checkout.synchronize_login_page(page, target, identity, budget=budget)
        self.assertEqual(error.exception.report['reason'], 'official_login_page_not_ready')
        self.assertTrue(error.exception.report['account_matched'])
        page.reload.assert_not_awaited()

    async def test_identity_change_or_expiration_after_refresh_is_not_ui_failure(self):
        for reason in ('official_user_mismatch', 'access_token_expired', 'verification_required'):
            page, target, refreshed, identity, budget = self.make([False, False])
            check = AsyncMock(side_effect=[(refreshed, identity), (refreshed, identity), Stop(reason)])
            with self.subTest(reason=reason), patch.object(browser_checkout, 'check_session', check), \
                    patch.object(browser_checkout.asyncio, 'sleep', AsyncMock()), self.assertRaises(Stop) as error:
                await browser_checkout.synchronize_login_page(page, target, identity, budget=budget)
            self.assertEqual(error.exception.report['reason'], reason)
            page.reload.assert_not_awaited()

    async def test_cancel_stops_without_refresh(self):
        page, target, _, identity, _ = self.make([False])
        budget = SessionBudget(30, cancelled=lambda: True)
        with self.assertRaises(Stop) as error:
            await browser_checkout.synchronize_login_page(page, target, identity, budget=budget)
        self.assertEqual(error.exception.report['reason'], 'operation_cancelled')
        page.reload.assert_not_awaited()

    async def test_identity_read_deadline_keeps_original_timeout_reason(self):
        for step in ('session_read', 'account_read'):
            page, target, _, identity, budget = self.make([True])
            async def timed_out(*_args, **_kwargs):
                budget.step = step
                self.now = budget.seconds
                raise Stop('session_load_timeout', error_type='TimeoutError')
            with self.subTest(step=step):
                with patch.object(browser_checkout, 'check_session', AsyncMock(side_effect=timed_out)), \
                        self.assertRaises(Stop) as error:
                    await browser_checkout.synchronize_login_page(page, target, identity, budget=budget)
                self.assertEqual(error.exception.report['reason'], 'session_load_timeout')
                self.assertEqual(error.exception.report['error_type'], 'TimeoutError')
                page.evaluate.assert_not_awaited()
                page.reload.assert_not_awaited()

    async def test_ui_read_timeout_before_deadline_keeps_original_reason(self):
        page, target, refreshed, identity, budget = self.make([False])
        page.evaluate.side_effect = Stop('session_load_timeout', error_type='TimeoutError')
        with patch.object(browser_checkout, 'check_session', AsyncMock(return_value=(refreshed, identity))), \
                self.assertRaises(Stop) as error:
            await browser_checkout.synchronize_login_page(page, target, identity, budget=budget)
        self.assertEqual(error.exception.report['reason'], 'session_load_timeout')
        self.assertLess(budget.elapsed, budget.seconds)
        page.reload.assert_not_awaited()


class LoginComposerDOMTests(unittest.TestCase):
    """Execute the real readiness expression in a local, fully stubbed browser."""
    @classmethod
    def setUpClass(cls):
        node = shutil.which('node')
        if not node:
            raise unittest.SkipTest('Node runtime unavailable for the DOM fixture')
        root = Path(__file__).resolve().parents[6]
        available = subprocess.run([node, '-e',
            "require('fs').accessSync(require('playwright').chromium.executablePath())"],
            cwd=root, text=True, capture_output=True, timeout=10)
        if available.returncode != 0:
            raise unittest.SkipTest('Local Playwright browser unavailable for the DOM fixture')
        script = r"""
const {chromium} = require('playwright');
const {expression, modes} = JSON.parse(require('fs').readFileSync(0, 'utf8'));
(async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        await page.routeWebSocket('wss://chatgpt.com/synthetic-boot', ws =>
            ws.onMessage(() => ws.send('ready')));
        const account = '<button data-testid="accounts-profile-button" aria-haspopup="menu">Account</button>';
        await page.route('**/*', route => route.fulfill({status: 200, contentType: 'text/html', body: account}));
        await page.goto('https://chatgpt.com/');
        const variants = {
            menu_only: '',
            textarea_disabled: '<form><textarea id="prompt-textarea" disabled></textarea></form>',
            textarea_readonly: '<form><textarea id="prompt-textarea" readonly></textarea></form>',
            form_busy: '<form aria-busy="true"><textarea id="prompt-textarea"></textarea></form>',
            spinner: '<form><textarea id="prompt-textarea"></textarea><span class="animate-spin">Loading</span></form>',
            progressbar: '<form><textarea id="prompt-textarea"></textarea><span role="progressbar">Loading</span></form>',
            hidden_composer: '<form aria-hidden="true"><textarea id="prompt-textarea"></textarea></form>',
            inert_composer: '<form inert><textarea id="prompt-textarea"></textarea></form>',
            pointer_blocked: '<form><div id="prompt-textarea" contenteditable="true" style="pointer-events:none">Prompt</div></form>',
            textarea_empty_send_disabled: '<form><textarea id="prompt-textarea"></textarea><button disabled>Send</button></form>',
            prose_mirror: '<form><div id="prompt-textarea" class="ProseMirror" contenteditable="true" role="textbox" aria-multiline="true"><p><br></p></div></form>',
            editable_false: '<form><div id="prompt-textarea" contenteditable="false" role="textbox">Prompt</div></form>',
            hidden_spinner: '<form><textarea data-testid="prompt-textarea"></textarea><span class="animate-spin" style="display:none">Loading</span></form>'
        };
        const results = {};
        for (const [name, markup] of Object.entries(variants)) {
            await page.setContent(account + markup);
            results[name] = await page.evaluate('(' + expression + ')()');
        }
        // A genuine local boot waits for both an official session POST and a
        // WebSocket handshake. Every HTTP response and socket is intercepted;
        // this test never reaches ChatGPT or any payment service.
        for (const [mode, sessionAllowed] of Object.entries(modes)) {
            await page.unroute('**/*');
            await page.route('**/*', route => {
                if (sessionAllowed && route.request().method() === 'POST' &&
                    route.request().url() === 'https://chatgpt.com/api/auth/session')
                    return route.fulfill({status: 200, contentType: 'application/json', body: '{"initialized":true}'});
                return route.abort('blockedbyclient');
            });
            await page.setContent(account + '<form aria-busy="true"><textarea id="prompt-textarea" disabled></textarea><button disabled>Send</button></form>');
            results[mode + '_boot_before'] = await page.evaluate('(' + expression + ')()');
            results[mode + '_session_post'] = await page.evaluate(async () => {
                const session = await fetch('/api/auth/session', {method: 'POST', credentials: 'include'});
                const initialized = (await session.json()).initialized;
                await new Promise((resolve, reject) => {
                    const socket = new WebSocket('wss://chatgpt.com/synthetic-boot');
                    const timer = setTimeout(() => { socket.close(); reject(new Error('local socket timeout')); }, 5000);
                    socket.onopen = () => socket.send('boot');
                    socket.onmessage = () => { clearTimeout(timer); socket.close(); resolve(); };
                });
                document.querySelector('form').removeAttribute('aria-busy');
                document.querySelector('textarea').disabled = false;
                return initialized;
            });
            results[mode + '_boot_after'] = await page.evaluate('(' + expression + ')()');
        }
        process.stdout.write(JSON.stringify(results));
    } finally { await browser.close(); }
})().catch(error => { process.stderr.write(error.name + ': ' + error.message); process.exitCode = 1; });
"""
        completed = subprocess.run([node, '-e', script], cwd=root,
                                   input=json.dumps({'expression': browser_checkout.LOGIN_PAGE_READY_EXPRESSION,
                                       'modes': {
                                           'login': not browser_password_login.login_payment_write(
                                               'POST', 'https://chatgpt.com/api/auth/session'),
                                           'recharge': browser_checkout.NetworkGuard(None).classify(
                                               'POST', 'https://chatgpt.com/api/auth/session') == 'read'}}),
                                   text=True, capture_output=True, timeout=30)
        if completed.returncode != 0:
            raise AssertionError('Local DOM fixture failed: ' + completed.stderr)
        cls.results = json.loads(completed.stdout)

    def test_menu_visible_with_busy_or_uneditable_composer_is_not_ready(self):
        for name in ('menu_only', 'textarea_disabled', 'textarea_readonly', 'form_busy',
                     'spinner', 'progressbar', 'hidden_composer', 'inert_composer',
                     'pointer_blocked', 'editable_false'):
            with self.subTest(name=name):
                self.assertIs(self.results[name], False)

    def test_writable_composer_is_ready_with_empty_disabled_send(self):
        for name in ('textarea_empty_send_disabled', 'prose_mirror', 'hidden_spinner'):
            with self.subTest(name=name):
                self.assertIs(self.results[name], True)

    def test_session_post_and_socket_boot_finish_before_readiness(self):
        for mode in ('login', 'recharge'):
            with self.subTest(mode=mode):
                self.assertIs(self.results[mode + '_boot_before'], False)
                self.assertIs(self.results[mode + '_session_post'], True)
                self.assertIs(self.results[mode + '_boot_after'], True)


if __name__ == '__main__':
    unittest.main()
