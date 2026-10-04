import asyncio
import unittest
from unittest.mock import MagicMock

import registration_builtin as builtin
from checkout_core import Stop
from test_registration_builtin import server_payload


class MailEventTests(unittest.IsolatedAsyncioTestCase):
    def job(self):
        value = server_payload()
        job = builtin.RegistrationServerJob(value['id'], value,
            'http://api:3000/api/id-business-v2/auto-registration/local', MagicMock())
        job.event = MagicMock()
        job.read_mail = MagicMock()
        job.prepare_mail('email_code')
        return job

    async def test_waiting_never_polls_mail_and_a_private_delivery_wakes_it(self):
        job = self.job()
        waiting = asyncio.create_task(job.wait_code())
        await asyncio.sleep(.02)
        job.read_mail.assert_not_called()
        job.signal_code('123456', job.attempt, 'email_code', 'fixture-mail-1')
        job.signal_code('123456', job.attempt, 'email_code', 'fixture-mail-1')
        self.assertEqual(await asyncio.wait_for(waiting, 1), '123456')
        job.signal_code('123456', job.attempt, 'email_code', 'fixture-mail-1')
        job.read_mail.assert_not_called()
        accepted = [call for call in job.event.call_args_list if call.args[0] == 'mail_accepted']
        self.assertEqual(len(accepted), 1)

    async def test_cancelled_and_stale_attempt_delivery_is_rejected(self):
        job = self.job()
        with self.assertRaises(Stop): job.signal_code('123456', job.attempt + 1, 'email_code', 'fixture-mail-1')
        job.signal_cancel()
        with self.assertRaises(Stop): job.signal_code('123456', job.attempt, 'email_code', 'fixture-mail-1')
