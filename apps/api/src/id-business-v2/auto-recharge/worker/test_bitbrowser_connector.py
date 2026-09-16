import asyncio
import json
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
        },
        "callbackUrl": "https://admin.example/api/id-business-v2/auto-recharge/local/" + JOB_ID,
        "agentToken": "a" * 64,
        "authorizeSinglePayment": True,
    }


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
                {"address": {**value["address"], "city": "Other"}},
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
        money = {"amount": "20.00", "amount_minor": 2000, "currency": "USD"}
        quote = {
            "plan": "plus",
            "today": money,
            "tax": {"amount": "0.00", "amount_minor": 0, "currency": "USD"},
            "renewal": money,
            "renewal_interval": "monthly",
        }
        self.assertTrue(job.confirm(quote, "4444"))
        job.progress.assert_called_once()
        with self.assertRaises(Stop):
            job.confirm({**quote, "today": {**money, "currency": "PHP"}}, "4444")
        with self.assertRaises(Stop):
            job.confirm({**quote, "today": {**money, "amount": "40.00", "amount_minor": 4000}}, "4444")
        with self.assertRaises(Stop):
            job.confirm({**quote, "tax": None}, "4444")

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
