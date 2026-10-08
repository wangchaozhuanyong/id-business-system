import asyncio
import json
import time
import threading
import io
import contextlib
import subprocess
import sys
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch

import bitbrowser_connector as connector
from checkout_core import Stop


JOB_ID = "11111111-1111-4111-8111-111111111111"


def payload():
    return {
        "id": JOB_ID,
        "mode": "payment",
        "plan": "plus",
        "windowName": "申请gpt-001",
        "sessionJson": '{"accessToken":"fixture"}',
        "details": {
            "number": "5555555555554444",
            "expiry": "12/39",
            "cvc": "123",
            "name": "Test User",
            "email": "test@example.invalid",
        },
        "address": {
            "id": "22222222-2222-4222-8222-222222222222",
            "line1": "1221 SW Fourth Avenue",
            "country": "US",
            "city": "Portland",
            "state": "OR",
            "postalCode": "97204",
        },
        "bitBrowser": {
            "localApiUrl": "http://127.0.0.1:54345",
            "localApiToken": "b" * 32,
            "groupName": "gpt账号注册",
            "tagName": "申请gpt",
            "proxyType": "http",
            "dynamicProxyUrl": "https://proxy.example/secret",
        },
        "safety": {
            "lockedCurrency": "USD",
            "maxAmount": "30.00",
            "maxAmountMinor": 3000,
            "authorizeSinglePayment": True,
            "manualPaymentConfirmation": True,
        },
        "callbackUrl": "https://admin.example/api/id-business-v2/auto-recharge/local/" + JOB_ID,
        "agentToken": "a" * 64,
        "authorizeSinglePayment": True,
    }


def confirmed(job, quote, last4):
    """Synthetic explicit human confirmation; never connects to a browser."""
    job.account_key = job.account_key or "c" * 64
    original = job.callback.send
    def callback(body):
        result = original(body)
        if body.get("result", {}).get("status") == "awaiting_confirmation":
            pending = job.state()["result"]
            job.signal_confirm(pending["nonce"], pending["quote_digest"])
        return result
    job.callback.send = callback
    try:
        return job.confirm(quote, last4)
    finally:
        job.callback.send = original


def resolution_payload():
    return {
        "id": JOB_ID,
        "mode": "resolve_unknown_payment",
        "plan": "pro-20x",
        "accountKey": "c" * 64,
        "checkoutIdentifier": "oaics_historical",
        "sourceJobId": "22222222-2222-4222-8222-222222222222",
        "verificationJobId": "33333333-3333-4333-8333-333333333333",
        "callbackUrl": "https://admin.example/api/id-business-v2/auto-recharge/local/" + JOB_ID,
        "agentToken": "a" * 64,
    }


class BitBrowserConnectorTests(unittest.TestCase):
    def test_official_cleanup_acknowledgements_allow_strings_but_reads_stay_strict(self):
        client = connector.BitBrowserClient("http://127.0.0.1:54345", "b" * 32)
        with patch.object(connector, "build_opener") as opener:
            response = opener.return_value.open.return_value.__enter__.return_value
            for path in ("/browser/close", "/browser/delete"):
                for data in ("success", None, {}, True):
                    response.read.return_value = json.dumps({"success": True, "data": data}).encode()
                    self.assertEqual(client.post(path, {"id": "a" * 32}), {})
                response.read.return_value = b'{"success":false,"data":"failure"}'
                with self.assertRaises(Stop):
                    client.post(path, {"id": "a" * 32})
            response.read.return_value = b'{"success":true,"data":"unverified"}'
            for path in ("/browser/detail", "/browser/pids/alive"):
                with self.assertRaises(Stop):
                    client.post(path, {"id": "a" * 32})

    def test_payload_is_complete_and_card_is_valid_before_browser_side_effects(self):
        value = payload()
        self.assertIs(connector.validate_payload(value), value)
        for change in (
                {"authorizeSinglePayment": False},
                {"extra": "field"},
                {"details": {**value["details"], "number": "123"}},
                {"address": {**value["address"], "country": "invalid"}},
                {"safety": {**value["safety"], "maxAmountMinor": 2000}}):
            with self.subTest(change=change), self.assertRaises(Stop):
                connector.validate_payload({**value, **change})

    def test_recheck_payload_contains_no_card_address_or_payment_authorization(self):
        value = payload()
        recheck = {key: value[key] for key in (
            "id", "plan", "windowName", "sessionJson", "bitBrowser", "callbackUrl", "agentToken")}
        recheck["mode"] = "recheck"
        self.assertIs(connector.validate_payload(recheck), recheck)
        with self.assertRaises(Stop):
            connector.validate_payload({**recheck, "details": value["details"]})

    def test_open_browser_payload_contains_no_card_address_or_payment_authorization(self):
        value = payload()
        open_payload = {key: value[key] for key in (
            "id", "windowName", "sessionJson", "bitBrowser", "callbackUrl", "agentToken")}
        open_payload["mode"] = "open_browser"
        validated = connector.validate_payload(open_payload)
        self.assertEqual(validated["mode"], "open_browser")
        self.assertEqual(validated["plan"], "plus")
        for forbidden in ("details", "address", "safety", "authorizeSinglePayment"):
            with self.subTest(forbidden=forbidden), self.assertRaises(Stop):
                connector.validate_payload({**open_payload, forbidden: value.get(forbidden, True)})

    def test_password_login_payload_stays_local_and_requires_matching_billing_email(self):
        value = payload()
        value.pop("sessionJson")
        value["login"] = {"email": "test@example.invalid", "password": "local-only-password"}
        self.assertIs(connector.validate_payload(value), value)
        for changed in (
                {**value, "sessionJson": "forbidden"},
                {**value, "login": {"email": "test@example.invalid", "password": ""}},
                {**value, "details": {**value["details"], "email": "other@example.invalid"}},
                {**value, "login": {**value["login"], "code": "123456"}}):
            with self.subTest(changed=changed), self.assertRaises(Stop):
                connector.validate_payload(changed)
        self.assertNotIn("login", connector.public_result(value))

    def test_code_is_accepted_only_while_requested_and_never_sent_in_progress(self):
        value = payload()
        value.pop("sessionJson")
        value["login"] = {"email": "test@example.invalid", "password": "local-only-password"}
        job = connector.LocalJob(value)
        job.callback.send = MagicMock(return_value={})
        with self.assertRaises(Stop):
            job.signal_code("123456")

        async def scenario():
            waiting = asyncio.create_task(job.wait_for_code(2))
            for _ in range(50):
                if job.waiting_for_code:
                    break
                await asyncio.sleep(.005)
            job.signal_code("123456")
            self.assertEqual(await waiting, "123456")
            self.assertFalse(job.waiting_for_code)

        asyncio.run(scenario())
        self.assertNotIn("123456", str(job.callback.send.call_args_list))
        self.assertIsNone(job.login_code)

    def test_unknown_payment_resolution_has_no_browser_session_or_payment_data(self):
        value = resolution_payload()
        self.assertIs(connector.validate_payload(value), value)
        for key in ("sessionJson", "bitBrowser", "details", "authorizeSinglePayment"):
            with self.subTest(key=key), self.assertRaises(Stop):
                connector.validate_payload({**value, key: "forbidden"})
        job = connector.LocalJob(value)
        job.callback.send = MagicMock(return_value={"ok": True})
        result = asyncio.run(job.execute())
        self.assertTrue(job.resolution_committed)
        self.assertEqual(result["payment_requests_sent"], 0)
        job.callback.send.assert_called_once_with({
            "type": "resolve_unknown_payment",
            "plan": "pro-20x",
            "accountKey": "c" * 64,
            "checkoutIdentifier": "oaics_historical",
            "sourceJobId": "22222222-2222-4222-8222-222222222222",
            "verificationJobId": "33333333-3333-4333-8333-333333333333",
        })

    def test_only_loopback_local_apis_and_job_bound_callbacks_are_allowed(self):
        self.assertEqual(
            connector.local_origin("http://127.0.0.1:54345", "api"),
            "http://127.0.0.1:54345")
        with self.assertRaises(Stop):
            connector.local_origin("https://remote.example", "api")
        with self.assertRaises(Stop):
            connector.callback_url(
                "https://admin.example/api/id-business-v2/auto-recharge/local/"
                "22222222-2222-4222-8222-222222222222",
                JOB_ID)

    def test_profile_uses_documented_dynamic_proxy_and_fixed_chinese_language(self):
        client = connector.BitBrowserClient("http://127.0.0.1:54345", "b" * 32)
        calls = []

        def post(path, body):
            calls.append((path, body))
            if path == "/group/list":
                return {"list": [{"id": "group_12345678", "groupName": "gpt账号注册"}]}
            if path == "/browserTag/list":
                return {"data": [{"id": "a" * 32, "tagName": "申请gpt"}]}
            return {"id": "b" * 32}

        client.post = post
        profile_id = client.create_profile(payload()["bitBrowser"], "申请gpt-001")

        self.assertEqual(profile_id, "b" * 32)
        body = calls[2][1]
        self.assertEqual(body["url"], "https://chatgpt.com")
        self.assertEqual(body["name"], "申请gpt-001")
        self.assertEqual(body["remark"], "申请gpt")
        self.assertEqual(body["proxyMethod"], 3)
        self.assertTrue(body["isDynamicIpChangeIp"])
        self.assertEqual(body["dynamicIpUrl"], "https://proxy.example/secret")
        self.assertFalse(body["credentialsEnableService"])
        for key in ("syncTabs", "syncCookies", "syncLocalStorage", "syncIndexedDb", "syncAuthorization"):
            self.assertIs(body[key], False)
        self.assertFalse(body["browserFingerPrint"]["isIpCreateLanguage"])
        self.assertEqual(body["browserFingerPrint"]["languages"], "zh-CN")
        self.assertFalse(body["browserFingerPrint"]["isIpCreateDisplayLanguage"])
        self.assertEqual(calls[3], ("/browserTag/updateRelation", {
            "browserId": profile_id, "addTagIds": ["a" * 32], "removeTagIds": []
        }))

    def test_profile_sync_must_be_verified_before_opening(self):
        client = connector.BitBrowserClient("http://127.0.0.1:54345", "b" * 32)
        safe = {"id": "profile_12345678", **dict.fromkeys((
            "syncTabs", "syncCookies", "syncLocalStorage", "syncIndexedDb", "syncAuthorization"), False)}
        for key in safe:
            for value in (True, None, "false", 0):
                client.post = MagicMock(return_value={**safe, key: value})
                with self.subTest(key=key, value=value), self.assertRaises(Stop):
                    client.open_profile(safe["id"])
                client.post.assert_called_once_with("/browser/detail", {"id": safe["id"]})
        client.post = MagicMock(side_effect=[safe, {"ws": "ws://127.0.0.1:9222/devtools/browser/test"}])
        self.assertTrue(client.open_profile(safe["id"]).startswith("ws://127.0.0.1"))
        self.assertEqual(client.post.call_args.args[0], "/browser/open")

    def test_profile_inventory_returns_only_verified_exact_ids(self):
        client = connector.BitBrowserClient("http://127.0.0.1:54345", "b" * 32)
        client.post = MagicMock(return_value={"list": [{"id": "a" * 32}, {"id": "b" * 32}]})
        self.assertEqual(client.list_profile_ids(), {"a" * 32, "b" * 32})
        client.post.assert_called_once_with("/browser/list", {"page": 0, "pageSize": 100})
        client.post = MagicMock(return_value={"list": [{"id": "not-a-profile"}]})
        with self.assertRaises(Stop):
            client.list_profile_ids()

    def test_currency_amount_and_tax_guards_run_before_payment(self):
        job = connector.LocalJob(payload())
        job.progress = MagicMock()
        job.callback.send = MagicMock(return_value={})
        money = {"amount": "20.00", "amount_minor": 2000, "currency": "USD"}
        quote = {
            "plan": "plus",
            "today": money,
            "tax": {"amount": "0.00", "amount_minor": 0, "currency": "USD"},
            "renewal": money,
            "renewal_interval": "monthly",
        }
        self.assertTrue(confirmed(job, quote, "4444"))
        job.progress.assert_called_once()
        with self.assertRaises(Stop):
            job.confirm({**quote, "today": {**money, "currency": "PHP"}}, "4444")
        with self.assertRaises(Stop):
            job.confirm({**quote, "today": {**money, "amount": "40.00", "amount_minor": 4000}}, "4444")
        with self.assertRaises(Stop):
            job.confirm({**quote, "tax": None}, "4444")

    def test_actual_confirmation_waits_and_nonce_is_single_use_quote_bound(self):
        job = connector.LocalJob(payload())
        job.account_key = "c" * 64
        job.callback.send = MagicMock(return_value={})
        amount = {"currency": "USD", "amount_minor": 2000, "amount": "20.00"}
        quote = {"plan": "plus", "today": amount, "renewal": amount,
                 "tax": {"currency": "USD", "amount_minor": 0, "amount": "0.00"},
                 "renewal_interval": "monthly"}
        outcome = []
        thread = threading.Thread(target=lambda: outcome.append(job.confirm(quote, "4444")))
        thread.start()
        for _ in range(100):
            if job.state()["status"] == "awaiting_confirmation":
                break
            time.sleep(.005)
        state = job.state()["result"]
        self.assertTrue(thread.is_alive())
        self.assertFalse(job.payment_request_sent)
        with self.assertRaises(Stop):
            job.signal_confirm(state["nonce"], "f" * 64)
        with self.assertRaises(Stop):
            job.signal_confirm("wrong", state["quote_digest"])
        job.signal_resume()
        self.assertTrue(thread.is_alive())
        self.assertNotIn(state["nonce"], str(job.callback.send.call_args_list))
        job.signal_confirm(state["nonce"], state["quote_digest"])
        thread.join(1)
        self.assertEqual(outcome, [True])
        with self.assertRaises(Stop):
            job.signal_confirm(state["nonce"], state["quote_digest"])
        with self.assertRaises(Stop):
            job.confirm(quote, "4444")
        self.assertNotIn("nonce", job.state()["result"])

    def test_confirmation_account_binding_and_expiry_cannot_be_reused(self):
        amount = {"currency": "USD", "amount_minor": 2000, "amount": "20.00"}
        quote = {"plan": "plus", "today": amount, "renewal": amount,
                 "tax": {"currency": "USD", "amount_minor": 0, "amount": "0.00"},
                 "renewal_interval": "monthly"}
        for change in ("account", "quote", "expiry"):
            job = connector.LocalJob(payload())
            job.account_key = "c" * 64
            def callback(body):
                if body.get("result", {}).get("status") != "awaiting_confirmation":
                    return {}
                state = job.state()["result"]
                if change == "account":
                    job.account_key = "d" * 64
                elif change == "quote":
                    quote["today"] = {**amount, "amount_minor": 2100, "amount": "21.00"}
                else:
                    job.pending_confirmation["expires_at"] = time.time() - 1
                try:
                    job.signal_confirm(state["nonce"], state["quote_digest"])
                except Stop:
                    job.cancelled = True
                    job.confirmation_event.set()
                return {}
            job.callback.send = callback
            with self.subTest(change=change), self.assertRaises(Stop):
                job.confirm(quote, "4444")
            self.assertFalse(job.payment_request_sent)
            quote["today"] = amount

    def test_roles_cannot_share_registration_and_recharge_registry(self):
        registration = connector.Registry("registration")
        recharge = connector.Registry("recharge")
        with self.assertRaises(Stop) as reason:
            registration.start(payload())
        self.assertEqual(reason.exception.report["reason"], "connector_role_mismatch")
        with self.assertRaises(Stop):
            recharge.start({"mode": "registration", "id": JOB_ID})
        self.assertIsNot(registration.jobs, recharge.jobs)

    def test_health_and_authenticated_http_confirmation_use_dedicated_role(self):
        job = connector.LocalJob(payload())
        job.account_key = "c" * 64
        job.callback.send = MagicMock(return_value={})
        amount = {"currency": "USD", "amount_minor": 2000, "amount": "20.00"}
        quote = {"plan": "plus", "today": amount, "renewal": amount,
                 "tax": {"currency": "USD", "amount_minor": 0, "amount": "0.00"},
                 "renewal_interval": "monthly"}
        outcome = []
        thread = threading.Thread(target=lambda: outcome.append(job.confirm(quote, "4444")))
        thread.start()
        for _ in range(100):
            if job.state()["status"] == "awaiting_confirmation":
                break
            time.sleep(.005)
        registry = connector.Registry("recharge")
        registry.jobs[job.id] = job
        handler = object.__new__(connector.Handler)
        handler.allowed_origins = {"https://admin.example"}
        handler.connector_token = "fixture-connector"
        handler.headers = {"Origin": "https://admin.example", "X-Auto-Recharge-Connector": "fixture-connector"}
        handler.reply = MagicMock()
        with patch.object(connector, 'REGISTRY', registry):
            handler.path = '/health'
            handler.do_GET()
            health = handler.reply.call_args.args[1]
            self.assertEqual(health['version'], 4)
            self.assertEqual(health['role'], 'recharge')
            self.assertIn('manual-payment-confirmation', health['capabilities'])
            self.assertIn('recharge-process-isolation', health['capabilities'])
            self.assertNotIn('account-registration', health['capabilities'])
            handler.path = '/jobs/' + job.id
            handler.do_GET()
            state = handler.reply.call_args.args[1]['result']
            handler.path += '/confirm'
            body = json.dumps({'nonce': state['nonce'], 'quoteDigest': state['quote_digest']}).encode()
            handler.headers['Content-Length'] = str(len(body))
            handler.rfile = io.BytesIO(body)
            handler.do_POST()
            self.assertEqual(handler.reply.call_args.args, (200, {'ok': True}))
            handler.rfile = io.BytesIO(body)
            handler.do_POST()
            self.assertEqual(handler.reply.call_args.args[0], 409)
        thread.join(1)
        self.assertEqual(outcome, [True])

    def test_command_roles_preserve_registration_port_and_recharge_isolation(self):
        for role, expected_port, expected_token_dir in (
                ('registration', 55321, 'auto-recharge-connector'),
                ('recharge', 55322, 'bitbrowser-recharge-assistant')):
            with (patch.object(connector, 'ThreadingHTTPServer') as server,
                  patch.object(connector, 'load_connector_token', return_value='fixture') as token,
                  patch.object(connector, 'REGISTRY', connector.Registry(role)),
                  contextlib.redirect_stdout(io.StringIO())):
                connector.main(['--role', role, '--allowed-origin', 'https://admin.example'])
                server.assert_called_once_with(('127.0.0.1', expected_port), connector.Handler)
                self.assertIn(expected_token_dir, str(token.call_args.args[0]))
                self.assertEqual(connector.REGISTRY.role, role)

    def test_recharge_assistant_imports_without_server_browser_dependencies(self):
        folder = Path(__file__).resolve().parent
        script = """import builtins,sys
sys.path.insert(0,sys.argv[1])
original = builtins.__import__
def minimal(name,*args,**kwargs):
    if name.split('.')[0] in {'camoufox','browserforge','numpy','fingerprint_runtime','server'}:
        raise ImportError('server browser dependency unavailable')
    return original(name,*args,**kwargs)
builtins.__import__ = minimal
import bitbrowser_connector
assert bitbrowser_connector.Registry('recharge').role == 'recharge'
"""
        result = subprocess.run([sys.executable, '-I', '-c', script, str(folder)],
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        lock = (folder / 'requirements-bitbrowser.lock.txt').read_text()
        for unused in ('camoufox', 'browserforge', 'numpy'):
            self.assertNotIn(unused, lock)

    def test_real_billing_address_is_not_fixed_to_one_fixture_city(self):
        value = payload()
        value["address"] = {**value["address"], "country": "PH", "city": "Manila",
                            "state": "Metro Manila", "postalCode": "1000", "line1": "Synthetic street"}
        self.assertIs(connector.validate_payload(value), value)
        for authorized in (False, None):
            with self.assertRaises(Stop):
                connector.validate_payload({**value, "safety": {
                    **value["safety"], "manualPaymentConfirmation": authorized}})

    def test_payment_progress_never_falls_back_to_zero_attempts(self):
        job = connector.LocalJob(payload())
        job.callback.send = MagicMock(return_value={})
        job.progress("payment_request_sending", attempt=1)
        report = job.callback.send.call_args.args[0]["result"]
        self.assertTrue(report["payment_attempted"])
        self.assertEqual(report["payment_requests_sent"], 1)

    def test_human_verification_keeps_the_same_job_waiting_until_explicit_resume(self):
        job = connector.LocalJob(payload())
        job.callback.send = MagicMock(return_value={})

        async def scenario():
            waiting = asyncio.create_task(job.wait_for_user("verification_required", 2))
            for _ in range(20):
                if job.waiting_for_user:
                    break
                await asyncio.sleep(0.005)
            self.assertTrue(job.waiting_for_user)
            job.signal_resume()
            await waiting
            self.assertFalse(job.waiting_for_user)

        asyncio.run(scenario())

    def test_public_results_never_include_local_secrets_or_card_data(self):
        self.assertEqual(
            connector.public_result({
                "status": "blocked",
                "sessionJson": "private",
                "localApiToken": "private",
                "dynamicProxyUrl": "private",
                "details": {"cvc": "123"},
            }),
            {"status": "blocked"})


if __name__ == "__main__":
    unittest.main()
