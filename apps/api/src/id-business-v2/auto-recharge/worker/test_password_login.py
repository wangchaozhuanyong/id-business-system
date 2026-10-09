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
        page = MagicMock(url="https://auth.openai.com/u/mfa-otp-challenge")
        page.goto = AsyncMock()
        email_field = MagicMock(fill=AsyncMock(), press=AsyncMock())
        password_field = MagicMock(fill=AsyncMock(), press=AsyncMock())
        code_field = MagicMock(fill=AsyncMock(), press=AsyncMock(),
                               input_value=AsyncMock(return_value="123456"))
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

    async def test_bitbrowser_email_challenge_never_requests_or_fills_totp(self):
        page = MagicMock(url="https://auth.openai.com/u/email-verification")
        email_field = MagicMock(fill=AsyncMock(), press=AsyncMock())
        password_field = MagicMock(fill=AsyncMock(), press=AsyncMock())
        code_field = MagicMock(fill=AsyncMock(), press=AsyncMock())
        code_field.locator.return_value = MagicMock(
            count=AsyncMock(return_value=1), inner_text=AsyncMock(return_value="Check your inbox"))
        target = BrowserCredential("", "account_fixture", "user_fixture")
        identity = {"account_matched": True, "current_plan": "free"}
        code_receiver = AsyncMock(return_value="123456")
        human_wait = AsyncMock()
        with (patch.object(login, "official_identity", new=AsyncMock(
                side_effect=[None, None, None, (target, identity)])),
              patch.object(login, "wait_for_input", new=AsyncMock(
                side_effect=[email_field, password_field])),
              patch.object(login, "unique_visible", new=AsyncMock(return_value=code_field))):
            result = await login.login_with_password(
                page, "test@example.invalid", "local-password", code_receiver,
                human_wait, MagicMock(), initial_loaded=True)
        self.assertEqual(result, (target, identity))
        code_receiver.assert_not_awaited()
        code_field.fill.assert_not_awaited()
        code_field.press.assert_not_awaited()
        human_wait.assert_awaited_once_with("verification_required", 1800)

    async def test_totp_challenge_changed_while_filling_never_submits(self):
        page = MagicMock(url="https://auth.openai.com/u/mfa-otp-challenge")
        email_field = MagicMock(fill=AsyncMock(), press=AsyncMock())
        password_field = MagicMock(fill=AsyncMock(), press=AsyncMock())
        form = MagicMock(count=AsyncMock(return_value=1),
                         inner_text=AsyncMock(return_value="Use your authenticator app"))
        async def change_challenge(_value):
            page.url = "https://auth.openai.com/u/email-verification"
            form.inner_text.return_value = "Check your inbox"
        code_field = MagicMock(fill=AsyncMock(side_effect=change_challenge), press=AsyncMock(),
                               input_value=AsyncMock(return_value="123456"))
        code_field.locator.return_value = form
        target = BrowserCredential("", "account_fixture", "user_fixture")
        identity = {"account_matched": True, "current_plan": "free"}
        human_wait = AsyncMock()
        with (patch.object(login, "official_identity", new=AsyncMock(
                side_effect=[None, None, None, (target, identity)])),
              patch.object(login, "wait_for_input", new=AsyncMock(
                side_effect=[email_field, password_field])),
              patch.object(login, "unique_visible", new=AsyncMock(return_value=code_field))):
            result = await login.login_with_password(
                page, "test@example.invalid", "local-password", AsyncMock(return_value="123456"),
                human_wait, MagicMock(), initial_loaded=True)
        self.assertEqual(result, (target, identity))
        self.assertEqual(code_field.fill.await_args_list[0].args, ("123456",))
        self.assertEqual(code_field.fill.await_args_list[-1].args, ("",))
        code_field.press.assert_not_awaited()
        human_wait.assert_awaited_once_with("verification_required", 1800)

    async def test_totp_input_changed_while_filling_is_cleared_without_submission(self):
        page = MagicMock(url="https://auth.openai.com/u/mfa-otp-challenge")
        fields = [MagicMock(fill=AsyncMock(), press=AsyncMock()) for _ in range(3)]
        fields[2].input_value = AsyncMock(return_value="654321")
        target = BrowserCredential("", "account_fixture", "user_fixture")
        identity = {"account_matched": True, "current_plan": "free"}
        human_wait = AsyncMock()
        with (patch.object(login, "official_identity", new=AsyncMock(
                side_effect=[None, None, None, (target, identity)])),
              patch.object(login, "wait_for_input", new=AsyncMock(side_effect=fields[:2])),
              patch.object(login, "unique_visible", new=AsyncMock(return_value=fields[2]))):
            result = await login.login_with_password(
                page, "test@example.invalid", "local-password", AsyncMock(return_value="123456"),
                human_wait, MagicMock(), initial_loaded=True)
        self.assertEqual(result, (target, identity))
        self.assertEqual(fields[2].fill.await_args_list[-1].args, ("",))
        fields[2].press.assert_not_awaited()
        human_wait.assert_awaited_once()

    async def login_with_expiring_code(self, expiry_stage=None):
        page = MagicMock(url="https://auth.openai.com/u/mfa-otp-challenge")
        fields = [MagicMock(fill=AsyncMock(), press=AsyncMock()) for _ in range(3)]
        fields[2].input_value = AsyncMock(return_value="123456")
        target = BrowserCredential("", "account_fixture", "user_fixture")
        identity = {"account_matched": True, "current_plan": "free"}
        supplied = {"code": "123456", "expiresAt": connector.datetime.fromtimestamp(
            101, connector.timezone.utc).isoformat()}
        human_wait = AsyncMock()
        observed = [None, None, None, (target, identity)] if expiry_stage else [None, None, (target, identity)]
        with (patch.object(login.time, "time", return_value=102 if expiry_stage == "received" else 100) as clock,
              patch.object(login, "official_identity", new=AsyncMock(side_effect=observed)),
              patch.object(login, "wait_for_input", new=AsyncMock(side_effect=fields[:2])),
              patch.object(login, "unique_visible", new=AsyncMock(return_value=fields[2])),
              patch.object(login.asyncio, "sleep", new=AsyncMock())):
            if expiry_stage == "fill":
                async def expire_during_fill(_value):
                    clock.return_value = 102
                fields[2].fill.side_effect = expire_during_fill
            result = await login.login_with_password(
                page, "test@example.invalid", "local-password", AsyncMock(return_value=supplied),
                human_wait, MagicMock(), initial_loaded=True)
        self.assertEqual(result, (target, identity))
        self.assertEqual(supplied, {})
        return fields[2], human_wait

    async def test_current_automatic_code_with_expiry_is_filled_and_submitted_once(self):
        field, human_wait = await self.login_with_expiring_code()
        field.fill.assert_awaited_once_with("123456")
        field.press.assert_awaited_once_with("Enter")
        human_wait.assert_not_awaited()

    async def test_code_already_expired_at_browser_receive_is_not_filled_or_submitted(self):
        field, human_wait = await self.login_with_expiring_code("received")
        self.assertTrue(all(call.args == ("",) for call in field.fill.await_args_list))
        field.press.assert_not_awaited()
        human_wait.assert_awaited_once()

    async def test_code_expiring_while_filling_is_cleared_and_not_submitted(self):
        field, human_wait = await self.login_with_expiring_code("fill")
        self.assertEqual(field.fill.await_args_list[0].args, ("123456",))
        self.assertEqual(field.fill.await_args_list[-1].args, ("",))
        field.press.assert_not_awaited()
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
            return_value=SimpleNamespace(contexts=[context], version="152.0.0"))))
        target = BrowserCredential("", "account_fixture", "user_fixture")
        with (patch.object(login, "login_with_password", new=AsyncMock(return_value=(
                target, {"current_plan": "free"}))) as sign_in,
              patch.object(login, "clear_visible_secrets", new=AsyncMock()) as clear,
              patch("browser_checkout.prepare_proxy_in_context", new=AsyncMock(
                  return_value={"country": "US"})),
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

    async def test_missing_or_different_running_kernel_stops_before_login_and_payment(self):
        for version, reason in ((None, "bitbrowser_profile_configuration_unverified"),
                                ("130.0.0", "bitbrowser_profile_configuration_mismatch")):
            data = payload()
            data.pop("sessionJson")
            data["login"] = {"email": "test@example.invalid", "password": "local-password"}
            job = connector.LocalJob(data)
            job.callback = MagicMock()
            job.restore_account = MagicMock()
            client = MagicMock(create_profile=MagicMock(return_value="a" * 32),
                               open_profile=MagicMock(return_value="http://127.0.0.1:12345"))
            context = MagicMock()
            playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=AsyncMock(
                return_value=SimpleNamespace(contexts=[context], version=version))))
            with (self.subTest(version=version),
                  patch.object(login, "login_with_password", new=AsyncMock()) as sign_in,
                  patch.object(bitbrowser_retry, "cancellable_flow", new=AsyncMock()) as payment):
                result = await bitbrowser_retry._execute_profiles(job, client, None, playwright, set())
            self.assertEqual(result["status"], "blocked")
            self.assertEqual(result["reason"], reason)
            sign_in.assert_not_awaited()
            payment.assert_not_awaited()
            job.restore_account.assert_not_called()
            context.route.assert_not_called()


if __name__ == "__main__":
    unittest.main()
