"""真实 Chromium + 全部请求由本地夹具拦截；不连接真实 ChatGPT 或支付服务。"""
import asyncio
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

from playwright.async_api import async_playwright

from attempt_ledger import AttemptLedger
from browser_checkout import workflow
from checkout_core import ROOT, CHECKOUT_PATH, BrowserCredential, parse_browser_credential
from test_subscribe import fixture, account


class BrowserTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(ROOT / ".browsers"))
        self.p = await async_playwright().start()
        self.browser = await self.p.chromium.launch(headless=True)
        self.context = await self.browser.new_context(service_workers="block")
        self.temp = tempfile.TemporaryDirectory()
        self.state = Path(self.temp.name) / "state"
        self.target = parse_browser_credential(fixture(expired=True))
        self.session = json.loads(fixture())
        self.creates = []
        self.payments = 0
        self.initializations = 0
        self.reject = False
        self.session_invalid = False
        self.mismatch = False
        self.accounts_reads = 0
        self.quote_currency = "MYR"
        self.duplicate = True
        self.delayed_upgrade = False
        self.delayed_plus = False
        self.delayed_hydration = False
        self.business_pricing = False
        self.english_personal_radio = False
        self.duplicate_plus = False
        self.disabled_plus = False
        self.verification_menu = False
        self.home_entry_missing = False
        self.duplicate_pricing_card = False
        self.expire_existing_checkout = False
        await self.context.route("**/*", self.server)

    async def asyncTearDown(self):
        await self.context.close()
        await self.browser.close()
        await self.p.stop()
        self.temp.cleanup()

    async def server(self, route):
        r = route.request
        path = urlsplit(r.url).path
        if path == "/api/auth/session":
            cookie = (await r.all_headers()).get("cookie", "")
            self.assertIn("__Secure-next-auth.session-token=" + self.target.session_token, cookie)
            data = {} if self.session_invalid else self.session
            if self.mismatch:
                data = {**data, "user": {"id": "other"}}
            await route.fulfill(json=data)
        elif path.startswith("/backend-api/accounts/"):
            self.accounts_reads += 1
            self.assertEqual(r.headers.get("authorization"), "Bearer " + self.session["accessToken"])
            await route.fulfill(json=account())
        elif path == CHECKOUT_PATH and r.method == "POST":
            # 验证标记已经存在且请求未被脚本改写。
            self.assertTrue(any(self.state.glob("*.json")))
            self.creates.append(r.post_data_json)
            if self.reject:
                await route.fulfill(status=400, json={"detail": "Our systems have detected unusual activity. Please try again later."})
            else:
                await route.fulfill(json={"checkout_session_id": "oaics_synthetic", "processor_entity": "openai_ie",
                                           "billing_details": {"currency": self.quote_currency}})
        elif path.endswith("/confirm"):
            self.payments += 1
            await route.fulfill(json={"forbidden": True})
        elif path == "/v1/payment_pages/oaics_synthetic/init":
            self.initializations += 1
            await route.fulfill(json={"synthetic_initialization": True}, headers={"Access-Control-Allow-Origin": "https://chatgpt.com"})
        elif path == "/checkout/verify":
            await route.fulfill(content_type="text/html; charset=utf-8",
                                body="<html><body>There was an error processing your payment</body></html>")
        elif path.startswith("/checkout/") and self.expire_existing_checkout:
            await route.fulfill(content_type="text/html; charset=utf-8",
                                body="<html><script>location.replace('/checkout/verify')</script></html>")
        elif path.startswith("/checkout/"):
            await route.fulfill(content_type="text/html; charset=utf-8", body=f'''<html><body>
                <h1>ChatGPT Plus</h1><div>Total due today</div><div>{self.quote_currency} 99.00</div>
                <div>Tax</div><div>{self.quote_currency} 0.00</div><div>Renews</div><div>{self.quote_currency} 99.00</div>
                <div>per month</div><button>Pay now</button>
                <script>fetch('/backend-api/payments/checkout/confirm', {{method:'POST'}}).catch(()=>{{}});</script>
                <script>fetch('https://api.stripe.com/v1/payment_pages/oaics_synthetic/init', {{method:'POST'}}).catch(()=>{{}});</script>
                </body></html>''')
        elif path == "/pricing":
            duplicate = '<a href="/?from=pricing">Get Plus</a>' if self.duplicate_pricing_card else ''
            await route.fulfill(content_type="text/html; charset=utf-8", body=f'''<html><title>Pricing</title><body>
                <main>
                  <section><h2>Free</h2><a href="/">Get Free</a></section>
                  <section><h2>Go</h2><a href="/explore/go">Get Go</a></section>
                  <section><h2>Plus</h2><a href="/?from=pricing">Get Plus</a>{duplicate}</section>
                  <section><h2>Pro</h2><a href="/?from=pricing&amp;plan=pro">Get Pro</a></section>
                </main>
                <footer><a href="/?from=footer">Get Plus</a></footer>
                </body></html>''')
        elif path == "/":
            from_pricing = "from=pricing" in urlsplit(r.url).query
            headers = json.dumps({"Content-Type": "application/json", "Authorization": "Bearer " + self.session["accessToken"],
                                  "chatgpt-account-id": self.target.account_id})
            body = json.dumps({"plan_name": "chatgptplusplan", "billing_details": {"country": "MY", "currency": self.quote_currency}})
            upgrade_hidden = self.delayed_upgrade or self.home_entry_missing
            plus_hidden = not from_pricing
            html = f'''<html><title>ChatGPT</title><body>
                <div style="visibility:hidden"><button>Upgrade</button><button>Get Plus</button></div>
                <button id="upgrade" {'hidden' if upgrade_hidden else ''} onclick="document.querySelector('#plus').hidden={str(self.business_pricing).lower()};document.querySelector('#personal').hidden={str(not self.business_pricing).lower()}">Upgrade</button>
                <button id="personal" hidden aria-label="切换以改为个人套餐" onclick="document.querySelector('#plus').hidden=false">个人</button>
                <button id="plus" {'hidden' if plus_hidden else ''} {'disabled' if self.delayed_plus else ''} onclick="create()">Get Plus</button>
                <script>if({str(not self.home_entry_missing).lower()})setTimeout(()=>document.querySelector('#upgrade').hidden=false, 500);
                setTimeout(()=>document.querySelector('#plus').disabled=false, 1000);
                if({str(self.delayed_hydration).lower()}){{
                    const node=document.querySelector('#upgrade');const handler=node.onclick;
                    node.onclick=null;setTimeout(()=>node.onclick=handler,1500);
                }}
                async function create(){{
                  const options={{method:'POST',headers:{headers},body:JSON.stringify({body})}};
                  const first=fetch('{CHECKOUT_PATH}',options);
                  if({str(self.duplicate).lower()})fetch('{CHECKOUT_PATH}',options).catch(()=>{{}});
                  const r=await first; const data=await r.json();
                  if(r.ok)location.href='/checkout/openai_ie/'+data.checkout_session_id;
                }}</script></body></html>'''
            if self.english_personal_radio:
                html = html.replace('aria-label="切换以改为个人套餐"', 'role="radio" aria-checked="false" aria-label="Toggle for switching to Personal plans"')
                html = html.replace("document.querySelector('#plus').hidden=false", "document.querySelector('#plus').hidden=false;document.querySelector('#personal').setAttribute('aria-checked','true')")
                html = html.replace('>Get Plus</button>', '>Upgrade to Plus</button>')
            if self.duplicate_plus:
                html = html.replace("async function create()", "setTimeout(()=>{const copy=document.querySelector('#plus').cloneNode(true);copy.id='copy';copy.hidden=false;document.body.append(copy)},100);async function create()")
            if self.disabled_plus:
                html = html.replace("setTimeout(()=>document.querySelector('#plus').disabled=false, 1000);", "document.querySelector('#plus').disabled=true;")
            if self.verification_menu:
                html = html.replace("async function create()", "setTimeout(()=>{document.title='Verify you are human';document.querySelector('#plus').remove()},50);async function create()")
            await route.fulfill(content_type="text/html; charset=utf-8", body=html)
        else:
            # 任何未列入夹具的请求都在本机终止，不访问公网。
            await route.abort()

    async def run_flow(self, create):
        with contextlib.redirect_stderr(io.StringIO()):
            if create:
                with AttemptLedger(self.state, self.target.account_id) as ledger:
                    return await workflow(self.context, self.target, ledger=ledger, quote_timeout=1)
            return await workflow(self.context, self.target)

    async def test_session_only_refresh_no_create(self):
        result = await self.run_flow(False)
        self.assertEqual(result["status"], "session_verified", result)
        self.assertTrue(result["credential_refreshed"])
        self.assertEqual(result["checkout_requests_sent"], 0)
        self.assertFalse(self.state.exists())
        self.assertFalse(self.creates)
        self.assertTrue(result["session_cookie_sent"])

    async def test_3835_byte_session_sent_as_one_unchanged_cookie(self):
        self.target = BrowserCredential("x" * 3835, self.target.account_id, self.target.user_id, self.target.old_token)
        result = await self.run_flow(False)
        self.assertEqual(result["status"], "session_verified", result)
        self.assertFalse(self.creates)

    async def test_invalid_session_does_not_create_or_login(self):
        self.session_invalid = True
        result = await self.run_flow(True)
        self.assertEqual(result["reason"], "json_session_not_restored", result)
        self.assertFalse(self.creates)
        self.assertFalse(list(self.state.glob("*.json")))

    async def test_mismatched_user_stops_before_accounts_or_create(self):
        self.mismatch = True
        result = await self.run_flow(True)
        self.assertEqual(result["reason"], "official_user_mismatch", result)
        self.assertEqual(self.accounts_reads, 0)
        self.assertFalse(self.creates)

    async def test_official_quote_single_create_and_payment_block(self):
        result = await self.run_flow(True)
        self.assertEqual(result["status"], "checkout_quote_verified", result)
        self.assertEqual(result["quote"]["today"], {"currency": "MYR", "amount": "99.00", "amount_minor": 9900})
        self.assertEqual(len(self.creates), 1)
        self.assertEqual(self.creates[0]["billing_details"], {"country": "MY", "currency": "MYR"})
        self.assertEqual(self.payments, 0)
        self.assertGreaterEqual(result["payment_requests_blocked"], 1)
        self.assertEqual(result["duplicate_requests_blocked"], 1)

    async def test_waits_for_upgrade_after_session_response(self):
        self.delayed_upgrade = True
        result = await self.run_flow(True)
        self.assertEqual(result["status"], "checkout_quote_verified", result)
        self.assertEqual(len(self.creates), 1)

    async def test_waits_for_plus_to_be_enabled(self):
        self.delayed_plus = True
        result = await self.run_flow(True)
        self.assertEqual(result["status"], "checkout_quote_verified", result)
        self.assertEqual(len(self.creates), 1)

    async def test_menu_click_before_hydration_does_not_repeat_checkout(self):
        self.delayed_hydration = True
        result = await self.run_flow(True)
        self.assertEqual(result["status"], "checkout_quote_verified", result)
        self.assertEqual(len(self.creates), 1)

    async def test_switches_from_business_to_personal_before_plus(self):
        self.business_pricing = True
        result = await self.run_flow(True)
        self.assertEqual(result["status"], "checkout_quote_verified", result)
        self.assertEqual(len(self.creates), 1)
        self.assertEqual(self.creates[0]["plan_name"], "chatgptplusplan")

    async def test_observed_english_personal_radio_and_upgrade_to_plus(self):
        self.business_pricing = self.english_personal_radio = True
        result = await self.run_flow(True)
        self.assertEqual(result['status'], 'checkout_quote_verified', result)
        self.assertEqual(len(self.creates), 1)
        self.assertEqual(self.payments, 0)

    async def test_pricing_card_fallback_ignores_page_level_duplicate(self):
        self.home_entry_missing = True
        with patch('plan_selection.HOME_ENTRY_SECONDS', .05):
            result = await self.run_flow(True)
        self.assertEqual(result['status'], 'checkout_quote_verified', result)
        self.assertEqual(len(self.creates), 1)
        self.assertEqual(self.payments, 0)

    async def test_duplicate_link_inside_pricing_card_stops_before_checkout(self):
        self.home_entry_missing = self.duplicate_pricing_card = True
        with patch('plan_selection.HOME_ENTRY_SECONDS', .05), patch('plan_selection.STEP_SECONDS', .5):
            result = await self.run_flow(True)
        self.assertEqual(result['reason'], 'official_plan_option_ambiguous', result)
        self.assertEqual(result['diagnostics']['step'], 'pricing_page')
        self.assertEqual(result['diagnostics']['role'], 'link')
        self.assertEqual(result['diagnostics']['matched_count'], 2)
        self.assertFalse(self.creates)
        self.assertEqual(result['payment_requests_sent'], 0)

    async def test_duplicate_target_controls_stop_with_safe_diagnostics(self):
        self.delayed_plus = self.duplicate_plus = True
        with patch('plan_selection.STEP_SECONDS', .5), patch('plan_selection.SELECTION_SECONDS', 2):
            result = await self.run_flow(True)
        self.assertEqual(result['reason'], 'official_plan_option_ambiguous', result)
        self.assertEqual(result['diagnostics']['matched_count'], 2)
        self.assertEqual(result['diagnostics']['step'], 'choose_plan')
        self.assertFalse(self.creates)
        self.assertEqual(result['payment_requests_sent'], 0)

    async def test_disabled_plan_stops_without_checkout(self):
        self.disabled_plus = True
        with patch('plan_selection.STEP_SECONDS', .5), patch('plan_selection.SELECTION_SECONDS', 2):
            result = await self.run_flow(True)
        self.assertEqual(result['reason'], 'official_plan_option_disabled', result)
        self.assertFalse(result['diagnostics']['enabled'])
        self.assertFalse(self.creates)

    async def test_selection_and_quote_progress_is_reported(self):
        events = []
        with patch('browser_checkout.progress', side_effect=lambda stage, **data: events.append((stage, data))):
            result = await self.run_flow(True)
        stages = [stage for stage, _ in events]
        self.assertEqual(result['status'], 'checkout_quote_verified', result)
        for stage in ('plan_selection', 'checkout_create', 'checkout_wait', 'quote_read'):
            self.assertIn(stage, stages)
        self.assertIn('choose_plan', [data.get('diagnostics', {}).get('step') for _, data in events])

    async def test_challenge_during_menu_selection_stops_without_order(self):
        self.verification_menu = self.disabled_plus = True
        with patch('plan_selection.STEP_SECONDS', .5), patch('plan_selection.SELECTION_SECONDS', 2):
            result = await self.run_flow(True)
        self.assertEqual(result['reason'], 'verification_required', result)
        self.assertFalse(self.creates)

    async def test_overall_selection_deadline_is_bounded(self):
        self.disabled_plus = True
        start = asyncio.get_running_loop().time()
        with patch('plan_selection.STEP_SECONDS', 2), patch('plan_selection.SELECTION_SECONDS', .5):
            result = await self.run_flow(True)
        self.assertLess(asyncio.get_running_loop().time() - start, 3)
        self.assertEqual(result['status'], 'blocked', result)
        self.assertFalse(self.creates)

    async def test_inspect_existing_quote_never_creates_new_checkout(self):
        existing = {"checkout_identifier": "oaics_synthetic", "processor_entity": "openai_ie", "returned_currency": "MYR"}
        with contextlib.redirect_stderr(io.StringIO()):
            result = await workflow(self.context, self.target, existing=existing, quote_timeout=1)
        self.assertEqual(result["status"], "checkout_quote_verified", result)
        self.assertTrue(result["inspection_only"])
        self.assertEqual(result["checkout_requests_sent"], 0)
        self.assertFalse(self.creates)
        self.assertEqual(self.payments, 0)
        self.assertEqual(self.initializations, 1)
        self.assertEqual(result["checkout_initializations_allowed"], 1)

    async def test_expired_existing_checkout_is_identified_without_creating_or_paying(self):
        self.expire_existing_checkout = True
        existing = {"checkout_identifier": "oaics_synthetic", "processor_entity": "openai_ie",
                    "returned_currency": "MYR"}
        with contextlib.redirect_stderr(io.StringIO()):
            result = await workflow(self.context, self.target, existing=existing, quote_timeout=1)
        self.assertEqual(result["reason"], "existing_checkout_unavailable", result)
        self.assertEqual(result["checkout_requests_sent"], 0)
        self.assertEqual(result["payment_requests_sent"], 0)
        self.assertFalse(self.creates)

    async def test_rejection_is_reported_at_checkout_with_no_payment(self):
        self.reject = True
        result = await self.run_flow(True)
        self.assertEqual(result["http_status"], 400, result)
        self.assertEqual(result["stage"], "checkout_create")
        self.assertEqual(len(self.creates), 1)
        self.assertEqual(self.payments, 0)
        self.assertEqual(result["checkout_status"], "rejected")

    async def test_review_window_reports_late_blocked_requests(self):
        async def late_request():
            for _ in range(100):
                pages = self.context.pages
                if pages and "/checkout/" in pages[0].url:
                    await asyncio.sleep(0.1)
                    await pages[0].evaluate("fetch('/backend-api/payments/checkout/confirm', {method:'POST'}).catch(()=>null)")
                    return
                await asyncio.sleep(0.01)
            self.fail("quote page did not open")
        task = asyncio.create_task(late_request())
        existing = {"checkout_identifier": "oaics_synthetic", "processor_entity": "openai_ie", "returned_currency": "MYR"}
        with contextlib.redirect_stderr(io.StringIO()):
            result = await workflow(self.context, self.target, existing=existing, quote_timeout=1, review_seconds=0.3)
        await task
        self.assertEqual(result["status"], "checkout_quote_verified", result)
        self.assertEqual(result["payment_requests_blocked"], 2)
        self.assertEqual(sum(result["blocked_payment_related_paths"].values()), 2)
        self.assertEqual(self.payments, 0)
        self.assertFalse(self.creates)

    async def test_unknown_currency_never_claims_quote_success(self):
        self.quote_currency = "ZZZ"
        result = await self.run_flow(True)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["reason"], "quote_needs_review_or_billing", result)
        self.assertIsNone(result["quote"]["today"])
        self.assertEqual(len(self.creates), 1)
        self.assertEqual(self.payments, 0)


if __name__ == "__main__":
    unittest.main()
