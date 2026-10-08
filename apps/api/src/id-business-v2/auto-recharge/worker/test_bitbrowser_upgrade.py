"""本机升级接合契约；不连接真实浏览器、账号或支付。"""
import asyncio
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import attempt_ledger
import bitbrowser_connector as connector
import bitbrowser_retry
import browser_checkout
import payment_state
import subscription_upgrade as upgrade
from checkout_core import BrowserCredential, Stop, parse_browser_credential
from test_bitbrowser_connector import payload
from test_subscribe import fixture


UPGRADE_ID = "upg_" + "b" * 32


def payment_payload():
    value = payload()
    value["plan"] = "pro-5x"
    return value


def quote():
    amount = {"currency": "USD", "amount_minor": 2000, "amount": "20.00"}
    return {"plan": "pro-5x", "today": amount,
            "tax": {"currency": "USD", "amount_minor": 0, "amount": "0.00"},
            "renewal": amount, "renewal_interval": "monthly", "operation": "subscription_upgrade",
            "upgrade_identifier": UPGRADE_ID, "quote_authority": "official_upgrade_preview"}


def recheck_payload():
    value = payment_payload()
    for key in ("details", "address", "safety", "authorizeSinglePayment"):
        value.pop(key)
    return {**value, "mode": "recheck", "upgradeIdentifier": UPGRADE_ID}


class BitBrowserUpgradeTests(unittest.TestCase):
    def test_upgrade_identifier_is_recheck_only_and_pro_only(self):
        value = recheck_payload()
        self.assertIs(connector.validate_payload(value), value)
        for change in ({"upgradeIdentifier": None}, {"upgradeIdentifier": "cs_wrong"},
                       {"upgradeIdentifier": "upg_" + "b" * 31}, {"plan": "go"}, {"plan": "plus"},
                       {"mode": "open_browser"}):
            with self.subTest(change=change), self.assertRaises(Stop):
                connector.validate_payload({**value, **change})
        with self.assertRaises(Stop):
            connector.validate_payload({**payment_payload(), "upgradeIdentifier": UPGRADE_ID})

    def test_real_local_confirmation_emits_complete_upgrade_binding(self):
        job = connector.LocalJob(payment_payload())
        job.callback.send = MagicMock(return_value={})
        self.assertTrue(job.confirm(quote(), "4444"))
        result = job.callback.send.call_args.args[0]["result"]
        self.assertEqual(result["quote_authority"], "official_upgrade_preview")
        self.assertEqual(result["operation"], "subscription_upgrade")
        self.assertEqual(result["current_plan_before"], "plus")
        self.assertEqual(result["target_plan"], "pro-5x")
        self.assertEqual(result["upgrade_identifier"], UPGRADE_ID)
        self.assertEqual(result["payment_requests_sent"], 0)
        for changed in ({"upgrade_identifier": "cs_wrong"}, {"plan": "plus"}):
            with self.subTest(changed=changed), self.assertRaises(Stop):
                job.confirm({**quote(), **changed}, "4444")
        job.payment_request_sent = True
        with self.assertRaises(Stop):
            job.confirm(quote(), "4444")

    def test_upgrade_receipt_keeps_safe_binding_and_drops_secrets(self):
        safe = {"operation": "subscription_upgrade", "current_plan_before": "plus",
                "upgrade_identifier": UPGRADE_ID, "upgrade_invoice_identifier": "in_Synthetic",
                "upgrade_payment_intent_identifier": "pi_Synthetic", "three_ds_status": "completed",
                "subscription_period": {"source": "official_subscription_response"}}
        self.assertEqual(connector.public_result({**safe, "password": "synthetic",
            "client_secret": "synthetic", "details": {"cvc": "123"}}), safe)

    def test_durable_upgrade_marker_precedes_unique_update_and_hooks_restore(self):
        job = connector.LocalJob(payment_payload())
        target = parse_browser_credential(fixture())
        job.account_key = hashlib.sha256(target.account_id.encode()).hexdigest()
        callbacks = []
        def callback(body):
            callbacks.append(body)
            return {"revision": body.get("revision", 0) + 1}
        job.callback.send = MagicMock(side_effect=callback)
        original_atomic = upgrade.atomic_json
        original_progress = upgrade.progress
        async def execute():
            self.assertIs(upgrade.progress.__self__, job)
            job.confirm(quote(), "4444")
            with upgrade.UpgradeLedger(job.root, target.account_id, "pro-5x") as ledger:
                ledger.begin(quote(), "4444")
                guard = upgrade.UpgradeGuard(target, ledger)
                guard.approved = True
                guard.method_id = "pm_Synthetic"
                guard.preflight = AsyncMock()
                request = SimpleNamespace(method="POST", url="https://chatgpt.com" + upgrade.UPGRADE_PATH,
                    post_data_json={"account_id": target.account_id, "updated_plan": "chatgptprolite", "payment_method_id": "pm_Synthetic"},
                    headers={"chatgpt-account-id": target.account_id,
                             "authorization": "Bearer " + json.loads(fixture())["accessToken"]})
                fallback_observed = []
                async def fallback():
                    persisted = [item for item in callbacks if item["type"] == "ledger"]
                    fallback_observed.append(persisted[-1]["document"]["confirmation_requests_sent"])
                routes = [SimpleNamespace(request=request, fallback=AsyncMock(side_effect=fallback),
                           abort=AsyncMock()) for _ in range(2)]
                await asyncio.gather(*(guard.route(route) for route in routes))
                self.assertEqual(sum(route.fallback.await_count for route in routes), 1)
                self.assertEqual(sum(route.abort.await_count for route in routes), 1)
                self.assertEqual(fallback_observed, [1])
                self.assertTrue(job.payment_request_sent)
                self.assertEqual(guard.sent, 1)
                self.assertEqual(ledger.record["upgrade_identifier"], UPGRADE_ID)
                return {**ledger.record, "payment_requests_sent": 1}
        job.execute = execute
        job.run()
        self.assertIs(upgrade.atomic_json, original_atomic)
        self.assertIs(upgrade.progress, original_progress)
        ledgers = [item for item in callbacks if item["type"] == "ledger"]
        self.assertEqual([item["document"]["confirmation_requests_sent"] for item in ledgers], [0, 1])
        self.assertEqual(ledgers[0]["fileKey"], "payments/" + hashlib.sha256(UPGRADE_ID.encode()).hexdigest() + ".json")
        final = callbacks[-1]["result"]
        self.assertEqual(final["upgrade_identifier"], UPGRADE_ID)
        self.assertEqual(final["payment_requests_sent"], 1)

    def test_durable_failure_prevents_official_update_and_restores_hooks(self):
        job = connector.LocalJob(payment_payload())
        target = parse_browser_credential(fixture())
        job.account_key = hashlib.sha256(target.account_id.encode()).hexdigest()
        accepted = []
        request = SimpleNamespace(method="POST", url="https://chatgpt.com" + upgrade.UPGRADE_PATH,
            post_data_json={"account_id": target.account_id, "updated_plan": "chatgptprolite", "payment_method_id": "pm_Synthetic"},
            headers={"chatgpt-account-id": target.account_id,
                     "authorization": "Bearer " + json.loads(fixture())["accessToken"]})
        route = SimpleNamespace(request=request, fallback=AsyncMock(), abort=AsyncMock())
        original_atomic = upgrade.atomic_json
        original_progress = upgrade.progress
        def callback(body):
            if body["type"] == "ledger":
                if body["document"]["confirmation_requests_sent"] == 1:
                    raise Stop("durable_state_unavailable")
                accepted.append(body["document"])
                return {"revision": body.get("revision", 0) + 1}
            return {}
        job.callback.send = MagicMock(side_effect=callback)
        async def execute():
            with upgrade.UpgradeLedger(job.root, target.account_id, "pro-5x") as ledger:
                ledger.begin(quote(), "4444")
                guard = upgrade.UpgradeGuard(target, ledger)
                guard.approved = True
                guard.method_id = "pm_Synthetic"
                guard.preflight = AsyncMock()
                await guard.route(route)
                self.assertEqual(guard.sent, 0)
                self.assertEqual(ledger.record["confirmation_requests_sent"], 0)
                raise guard.error
        job.execute = execute
        job.run()
        route.fallback.assert_not_awaited()
        route.abort.assert_awaited_once_with("blockedbyclient")
        self.assertEqual([record["confirmation_requests_sent"] for record in accepted], [0])
        self.assertFalse(job.payment_request_sent)
        self.assertIs(upgrade.atomic_json, original_atomic)
        self.assertIs(upgrade.progress, original_progress)
        self.assertEqual(job.callback.send.call_args.args[0]["result"]["reason"], "durable_state_unavailable")


class BitBrowserUpgradeRecheckTests(unittest.IsolatedAsyncioTestCase):
    async def test_recheck_restores_same_upgrade_id_without_payment_flow(self):
        job = connector.LocalJob(recheck_payload())
        job.callback.send = MagicMock(return_value={})
        job.root = Path("/synthetic/readonly/state")
        target = BrowserCredential("", "synthetic-account", "synthetic-user")
        context = SimpleNamespace()
        browser = SimpleNamespace(contexts=[context], version="152.0.0")
        playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=AsyncMock(return_value=browser)))
        client = SimpleNamespace(create_profile=MagicMock(return_value="a" * 32),
                                 open_profile=MagicMock(return_value="http://127.0.0.1:12345"))
        with (patch.object(upgrade, "recheck_upgrade_in_context", new=AsyncMock(return_value={
                "status": "subscription_activated", "upgrade_identifier": UPGRADE_ID,
                "payment_requests_sent": 0, "recheck_only": True})) as read,
              patch.object(bitbrowser_retry, "cleanup_stale_profiles", new=AsyncMock()),
              patch.object(bitbrowser_retry.payment_recovery, "recheck_in_context", new=AsyncMock()) as old,
              patch.object(bitbrowser_retry, "cancellable_flow", new=AsyncMock()) as payment):
            result = await bitbrowser_retry._execute_profiles(job, client, target, playwright, set())
        read.assert_awaited_once_with(context, target, job.root, "pro-5x", UPGRADE_ID)
        old.assert_not_awaited()
        payment.assert_not_awaited()
        self.assertEqual(result["payment_requests_sent"], 0)


if __name__ == "__main__":
    unittest.main()
