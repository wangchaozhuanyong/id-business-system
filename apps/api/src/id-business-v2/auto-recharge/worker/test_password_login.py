import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import bitbrowser_connector as connector
import bitbrowser_retry
import browser_password_login as login
from checkout_core import BrowserCredential, Stop
from test_bitbrowser_connector import payload


class PasswordLoginTests(unittest.IsolatedAsyncioTestCase):
    def test_auth_writes_allowed_but_checkout_and_payment_writes_blocked(self):
        self.assertFalse(login.login_payment_write("POST", "https://auth.openai.com/oauth/token"))
        self.assertFalse(login.login_payment_write("GET", "https://api.stripe.com/v1/payment_methods"))
        self.assertTrue(login.login_payment_write("POST", "https://api.stripe.com/v1/payment_methods"))
        self.assertTrue(login.login_payment_write("POST", "https://chatgpt.com/backend-api/payments/checkout"))

    async def test_password_and_code_are_submitted_only_on_the_official_page(self):
        page = MagicMock(url="https://chatgpt.com/auth/login")
        page.goto = AsyncMock()
        email_field = MagicMock(fill=AsyncMock(), press=AsyncMock())
        password_field = MagicMock(fill=AsyncMock(), press=AsyncMock())
        code_field = MagicMock(fill=AsyncMock(), press=AsyncMock())
        target = BrowserCredential("", "account_fixture", "user_fixture")
        identity = {"account_matched": True, "current_plan": "free"}
        code_receiver = AsyncMock(return_value="123456")
        human_wait = AsyncMock()
        progress = MagicMock()
        with (patch.object(login, "official_identity", new=AsyncMock(
                side_effect=[None, None, (target, identity)])),
              patch.object(login, "wait_for_input", new=AsyncMock(
                side_effect=[email_field, password_field])),
              patch.object(login, "unique_visible", new=AsyncMock(return_value=code_field)),
              patch.object(login.asyncio, "sleep", new=AsyncMock())):
            result = await login.login_with_password(
                page, "test@example.invalid", "local-password", code_receiver, human_wait, progress)
        self.assertEqual(result, (target, identity))
        email_field.fill.assert_awaited_once_with("test@example.invalid")
        password_field.fill.assert_awaited_once_with("local-password")
        code_field.fill.assert_awaited_once_with("123456")
        code_receiver.assert_awaited_once()
        human_wait.assert_not_awaited()
        self.assertIn("login_code_submitted", [call.args[0] for call in progress.call_args_list])

    async def test_unexpected_provider_is_not_filled(self):
        page = MagicMock(url="https://accounts.google.com/")
        page.goto = AsyncMock()
        human_wait = AsyncMock()
        with patch.object(login, "official_identity", new=AsyncMock(return_value=None)):
            with self.assertRaises(Stop) as stopped:
                await login.login_with_password(
                    page, "test@example.invalid", "local-password", AsyncMock(), human_wait, MagicMock())
        self.assertEqual(stopped.exception.report["reason"], "official_login_not_verified")
        human_wait.assert_awaited_once()

    async def test_official_email_mismatch_stops_before_account_binding(self):
        page = MagicMock(url="https://chatgpt.com/")
        with patch.object(login, "browser_read", new=AsyncMock(return_value={
                "user": {"id": "other", "email": "other@example.invalid"},
                "accessToken": "redacted"})), patch.object(login, "check_session") as checked:
            with self.assertRaises(Stop) as stopped:
                await login.official_identity(page, "test@example.invalid")
        self.assertEqual(stopped.exception.report["reason"], "official_login_email_mismatch")
        checked.assert_not_called()

    async def test_visible_password_and_code_are_cleared_after_login(self):
        page = MagicMock(url="https://auth.openai.com/u/login")
        password_field = MagicMock(fill=AsyncMock())
        code_field = MagicMock(fill=AsyncMock())
        with patch.object(login, "unique_visible", new=AsyncMock(
                side_effect=[password_field, code_field])):
            await login.clear_visible_secrets(page)
        password_field.fill.assert_awaited_once_with("")
        code_field.fill.assert_awaited_once_with("")

    async def test_verified_password_login_is_bound_before_payment_flow(self):
        data = payload()
        data.pop("sessionJson")
        data["login"] = {"email": "test@example.invalid", "password": "local-password"}
        job = connector.LocalJob(data)
        job.callback = MagicMock()
        job.restore_account = MagicMock()
        client = MagicMock(create_profile=MagicMock(return_value="a" * 32),
                           open_profile=MagicMock(return_value="http://127.0.0.1:12345"))
        page = MagicMock(url="about:blank", set_default_timeout=MagicMock())
        context = MagicMock(pages=[page], route=AsyncMock(), unroute=AsyncMock())
        playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=AsyncMock(
            return_value=SimpleNamespace(contexts=[context]))))
        target = BrowserCredential("", "account_fixture", "user_fixture")
        with (patch.object(login, "login_with_password", new=AsyncMock(return_value=(
                target, {"current_plan": "free"}))) as sign_in,
              patch.object(login, "clear_visible_secrets", new=AsyncMock()) as clear,
              patch.object(bitbrowser_retry, "cleanup_stale_profiles", new=AsyncMock()),
              patch.object(bitbrowser_retry, "cancellable_flow", new=AsyncMock(return_value={
                  "status": "payment_cancelled", "payment_requests_sent": 0})) as payment):
            result = await bitbrowser_retry.execute_profiles(job, client, None, playwright)
        self.assertEqual(result["status"], "payment_cancelled")
        sign_in.assert_awaited_once()
        clear.assert_awaited_once_with(page)
        job.restore_account.assert_called_once_with(target)
        self.assertIs(payment.await_args.args[1], target)
        self.assertNotIn("login", job.payload)
        context.route.assert_awaited_once()
        context.unroute.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
