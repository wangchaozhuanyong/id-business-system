import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import browser_password_login as login
import server
from checkout_core import Stop


class RechargeEmailCodeTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_explicit_email_challenge_reads_mail(self):
        field = MagicMock()
        form = MagicMock(count=AsyncMock(return_value=1), inner_text=AsyncMock())
        field.locator.return_value = form
        cases = [
            ("https://auth.openai.com/u/email-verification", "Check your inbox", "email"),
            ("https://auth.openai.com/u/challenge", "Enter the code sent to your email", "email"),
            ("https://auth.openai.com/u/mfa-otp-challenge", "Enter a code", "totp"),
            ("https://auth.openai.com/u/mfa-otp-challenge", "Check your email for a code", "email"),
            ("https://auth.openai.com/u/challenge", "Use your authenticator app", "totp"),
            ("https://auth.openai.com/u/challenge", "Enter verification code", "unknown"),
            ("https://auth.openai.com/u/challenge", "Email owner@example.invalid. Enter your code", "unknown"),
            ("https://auth.openai.com/u/email-verification", "SMS sent to phone number", "unknown"),
            ("https://evil.invalid/email-verification", "Check your inbox", "unknown"),
            ("https://auth.openai.com:444/email-verification", "Check your inbox", "unknown")
        ]
        for url, text, expected in cases:
            form.inner_text.return_value = text
            self.assertEqual(await login.login_code_type(MagicMock(url=url), field), expected)

    async def login_fixture(self, *, challenge="email", changed=False, no_password=False,
                            observed=None, failed=False):
        page = MagicMock(url="https://auth.openai.com/u/email-verification")
        fields = [MagicMock(fill=AsyncMock(), press=AsyncMock()) for _ in range(3)]
        fields[2].input_value = AsyncMock(side_effect=lambda: fields[2].fill.await_args.args[0])
        received = AsyncMock(return_value="123456")
        totp = AsyncMock(return_value="654321")
        accepted = AsyncMock()
        prepare = AsyncMock()
        human = AsyncMock(side_effect=Stop("verification_required", user_action_required=True))
        progress = MagicMock()
        target = (MagicMock(), {"current_plan": "free"})
        classifications = iter([challenge, "totp" if changed else challenge])
        async def classify(*_args):
            return next(classifications, challenge)
        with (patch.object(login, "official_identity", new=AsyncMock(side_effect=observed or [None, None, target])),
              patch.object(login, "wait_for_input", new=AsyncMock(side_effect=[fields[0], None if no_password else fields[1]])),
              patch.object(login, "unique_visible", new=AsyncMock(return_value=fields[2])),
              patch.object(login, "login_code_type", new=AsyncMock(side_effect=classify)),
              patch.object(login.asyncio, "sleep", new=AsyncMock())):
            if changed or failed:
                with self.assertRaises(Stop) as stopped:
                    await login.login_with_password(page, "owner@example.invalid", "synthetic", totp,
                        human, progress, initial_loaded=True, prepare_email_code=prepare,
                        wait_for_email_code=received, email_code_accepted=accepted)
                self.assertEqual(stopped.exception.report["reason"],
                                 "verification_required" if failed else "recharge_email_code_type_changed")
            else:
                await login.login_with_password(page, "owner@example.invalid", "synthetic", totp,
                    human, progress, initial_loaded=True, prepare_email_code=prepare,
                    wait_for_email_code=received, email_code_accepted=accepted)
                human.assert_not_awaited()
        if failed and challenge == "email":
            self.assertNotIn("login_manual_required", [call.args[0] for call in progress.call_args_list])
        return fields, received, totp, accepted, prepare

    async def test_email_code_is_filled_once_and_acknowledged_only_after_identity(self):
        fields, received, totp, accepted, prepare = await self.login_fixture()
        prepare.assert_awaited_once()
        received.assert_awaited_once_with(120)
        totp.assert_not_awaited()
        fields[2].fill.assert_awaited_once_with("123456")
        fields[2].press.assert_awaited_once_with("Enter")
        accepted.assert_awaited_once()

    async def test_email_code_before_password_is_supported(self):
        fields, received, totp, accepted, _ = await self.login_fixture(no_password=True)
        fields[1].fill.assert_not_awaited()
        received.assert_awaited_once()
        accepted.assert_awaited_once()
        totp.assert_not_awaited()

    async def test_mail_wait_does_not_consume_the_official_acceptance_window(self):
        with patch.object(login.time, "monotonic", side_effect=[0, 0, 61, 61, 62]):
            _, received, _, accepted, _ = await self.login_fixture(
                observed=[None, None, None, (MagicMock(), {"current_plan": "free"})])
        received.assert_awaited_once()
        accepted.assert_awaited_once()

    async def test_delayed_mail_with_no_identity_stops_without_retrying_the_code(self):
        with patch.object(login.time, "monotonic", side_effect=[0, 0, 61, 107]):
            fields, received, _, accepted, _ = await self.login_fixture(
                observed=[None, None, None], failed=True)
        received.assert_awaited_once()
        fields[2].fill.assert_awaited_once_with("123456")
        fields[2].press.assert_awaited_once_with("Enter")
        accepted.assert_not_awaited()

    async def test_identity_on_last_read_acknowledges_before_manual_stage(self):
        with patch.object(login.time, "monotonic", side_effect=[0, 0, 61, 107]):
            _, received, _, accepted, _ = await self.login_fixture()
        received.assert_awaited_once()
        accepted.assert_awaited_once()

    async def test_totp_challenge_never_reads_email(self):
        fields, received, totp, accepted, _ = await self.login_fixture(challenge="totp")
        received.assert_not_awaited()
        totp.assert_awaited_once_with(1800)
        accepted.assert_not_awaited()
        fields[2].fill.assert_awaited_once_with("654321")

    async def chained_challenge_fixture(self, challenges):
        page = MagicMock(url="https://auth.openai.com/u/challenge")
        fields = [MagicMock(fill=AsyncMock(), press=AsyncMock()) for _ in range(3)]
        fields[2].input_value = AsyncMock(side_effect=lambda: fields[2].fill.await_args.args[0])
        received = AsyncMock(return_value="123456")
        totp = AsyncMock(return_value="654321")
        human = AsyncMock(side_effect=Stop("verification_required", user_action_required=True))
        progress = MagicMock()
        submissions = []
        verified = False
        target = (MagicMock(), {"current_plan": "free"})
        async def submit(_key):
            submissions.append(challenges[len(submissions)])
        async def identity(*_args):
            nonlocal verified
            if len(submissions) == len(challenges):
                verified = True
                return target
            return None
        async def classify(*_args):
            return challenges[len(submissions)]
        async def ack():
            self.assertTrue(verified)
            self.assertEqual(progress.call_args.args[0], "login_email_code_submitted")
        accepted = AsyncMock(side_effect=ack)
        fields[2].press.side_effect = submit
        with (patch.object(login, "official_identity", new=AsyncMock(side_effect=identity)),
              patch.object(login, "wait_for_input", new=AsyncMock(side_effect=fields[:2])),
              patch.object(login, "unique_visible", new=AsyncMock(return_value=fields[2])),
              patch.object(login, "login_code_type", new=AsyncMock(side_effect=classify)),
              patch.object(login.asyncio, "sleep", new=AsyncMock())):
            result = await login.login_with_password(page, "owner@example.invalid", "synthetic", totp,
                human, progress, initial_loaded=True, prepare_email_code=AsyncMock(),
                wait_for_email_code=received, email_code_accepted=accepted)
        self.assertEqual(result, target)
        self.assertEqual(submissions, challenges)
        received.assert_awaited_once_with(120)
        totp.assert_awaited_once_with(1800)
        accepted.assert_awaited_once()
        human.assert_not_awaited()
        return fields[2]

    async def test_totp_then_email_collects_each_code_once(self):
        field = await self.chained_challenge_fixture(["totp", "email"])
        self.assertEqual([call.args[0] for call in field.fill.await_args_list], ["654321", "123456"])

    async def test_email_then_totp_preserves_mail_ack_after_identity(self):
        field = await self.chained_challenge_fixture(["email", "totp"])
        self.assertEqual([call.args[0] for call in field.fill.await_args_list], ["123456", "654321"])

    async def test_same_kind_challenge_is_never_retried(self):
        for challenge in ("email", "totp"):
            with self.subTest(challenge=challenge):
                with patch.object(login.time, "monotonic", side_effect=[0, 0, 1, 2, 47]):
                    fields, received, totp, accepted, _ = await self.login_fixture(
                        challenge=challenge, observed=[None, None, None, None, None], failed=True)
                fields[2].press.assert_awaited_once_with("Enter")
                (received if challenge == "email" else totp).assert_awaited_once()
                (totp if challenge == "email" else received).assert_not_awaited()
                accepted.assert_not_awaited()

    async def test_page_change_during_email_read_never_fills_or_acknowledges(self):
        fields, received, totp, accepted, _ = await self.login_fixture(changed=True)
        received.assert_awaited_once()
        fields[2].fill.assert_not_awaited()
        accepted.assert_not_awaited()

    async def test_failed_official_identity_does_not_acknowledge_the_email(self):
        page = MagicMock(url="https://auth.openai.com/u/email-verification")
        fields = [MagicMock(fill=AsyncMock(), press=AsyncMock()) for _ in range(3)]
        fields[2].input_value = AsyncMock(side_effect=lambda: fields[2].fill.await_args.args[0])
        accepted = AsyncMock()
        with (patch.object(login, "official_identity", new=AsyncMock(side_effect=[
                None, None, Stop("official_login_email_mismatch")])),
              patch.object(login, "wait_for_input", new=AsyncMock(side_effect=fields[:2])),
              patch.object(login, "unique_visible", new=AsyncMock(return_value=fields[2])),
              patch.object(login, "login_code_type", new=AsyncMock(return_value="email")),
              patch.object(login.asyncio, "sleep", new=AsyncMock())):
            with self.assertRaises(Stop):
                await login.login_with_password(page, "owner@example.invalid", "synthetic", AsyncMock(),
                    AsyncMock(), MagicMock(), initial_loaded=True, prepare_email_code=AsyncMock(),
                    wait_for_email_code=AsyncMock(return_value="123456"), email_code_accepted=accepted)
        fields[2].fill.assert_awaited_once_with("123456")
        accepted.assert_not_awaited()

    async def test_unknown_challenge_does_not_read_mail_or_generate_totp(self):
        page = MagicMock(url="https://auth.openai.com/u/challenge")
        fields = [MagicMock(fill=AsyncMock(), press=AsyncMock()) for _ in range(3)]
        read = AsyncMock()
        totp = AsyncMock()
        human = AsyncMock(side_effect=Stop("verification_required", user_action_required=True))
        with (patch.object(login, "official_identity", new=AsyncMock(return_value=None)),
              patch.object(login, "wait_for_input", new=AsyncMock(side_effect=fields[:2])),
              patch.object(login, "unique_visible", new=AsyncMock(return_value=fields[2])),
              patch.object(login, "login_code_type", new=AsyncMock(return_value="unknown"))):
            with self.assertRaises(Stop):
                await login.login_with_password(page, "owner@example.invalid", "synthetic", totp,
                    human, MagicMock(), initial_loaded=True, wait_for_email_code=read)
        read.assert_not_awaited()
        totp.assert_not_awaited()
        fields[2].fill.assert_not_awaited()

    async def test_server_polling_only_keeps_mail_id_and_cancellation_stops_fill(self):
        job = server.Job("11111111-1111-4111-8111-111111111111", {"plan": "plus"})
        page = MagicMock(url="https://auth.openai.com/u/email-verification", close=AsyncMock())
        context = MagicMock(new_page=AsyncMock(return_value=page), route=AsyncMock(), unroute=AsyncMock())
        credentials = {"email": "owner@example.invalid", "password": "synthetic"}
        result_mail = {"mailId": "mail-fixture", "code": "123456"}
        requests = []
        def request(_id, body):
            requests.append(body)
            return {"mail": result_mail} if body["type"] == "read" else {"ok": True}
        async def browser_flow(*_args, **kwargs):
            await kwargs["prepare_email_code"]()
            code = await kwargs["wait_for_email_code"](120)
            self.assertEqual(code, "123456")
            self.assertEqual(result_mail, {})
            await kwargs["email_code_accepted"]()
            job.cancelled = True
            with self.assertRaises(Stop):
                await kwargs["wait_for_email_code"](120)
            return MagicMock(), {"current_plan": "free"}
        with (patch.object(server, "email_code_request", side_effect=request),
              patch.object(login, "login_with_password", new=AsyncMock(side_effect=browser_flow)),
              patch.object(login, "clear_visible_secrets", new=AsyncMock())):
            await job.login_target(context, credentials)
        self.assertEqual(credentials, {})
        self.assertEqual(requests, [{"type": "prepare"}, {"type": "read"},
                                    {"type": "received", "mailId": "mail-fixture"}])
        self.assertNotIn("123456", str(requests))


if __name__ == "__main__":
    unittest.main()
