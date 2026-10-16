"""后台原结算延迟挂载的纯单元回归；不连接浏览器或使用真实银行卡。"""
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from checkout_core import Stop
from payment_form import PaymentDetails, fill_official_form
from bitbrowser_connector import LocalJob
from test_bitbrowser_connector import payload
from browser_checkout import quote_from_text


def details():
    return PaymentDetails('4242424242424242', '12/39', '123', 'Synthetic User',
                          'test@example.invalid', 'US', 'Synthetic street', '',
                          'Synthetic city', 'OR', '97204')


class DeferredFields:
    def __init__(self, page, selector):
        self.page, self.selector = page, selector

    def filter(self, **_):
        return self

    async def count(self):
        return int(self.page.active and self.selector.startswith("input[autocomplete='cc-"))

    def nth(self, _):
        return self

    async def fill(self, _):
        if not self.page.active:
            raise AssertionError('background field was written')
        self.page.events.append(self.selector)


class DeferredCheckout:
    url = 'https://js.stripe.com/synthetic'

    def __init__(self):
        self.active, self.events = False, []
        self.frames = [self]

    async def bring_to_front(self):
        self.events.append('activate')
        self.active = True

    def locator(self, selector):
        return DeferredFields(self, selector)

    def get_by_label(self, *_args, **_kwargs):
        return SimpleNamespace(count=AsyncMock(return_value=0))


class PaymentFormFocusTests(unittest.IsolatedAsyncioTestCase):
    async def test_background_checkout_is_activated_before_any_card_write(self):
        page = DeferredCheckout()
        with patch('payment_form.one_billing_field', new=AsyncMock(return_value=None)):
            result = await fill_official_form(page, details())
        self.assertEqual(page.events, ['activate', "input[autocomplete='cc-number']",
                                      "input[autocomplete='cc-exp']", "input[autocomplete='cc-csc']"])
        self.assertTrue(result['card_fields_filled'])
        self.assertEqual(result['billing_fields_filled'], [])

    async def test_activation_failure_does_not_write_fields(self):
        page = DeferredCheckout()
        page.bring_to_front = AsyncMock(side_effect=RuntimeError('activation failed'))
        with self.assertRaisesRegex(RuntimeError, 'activation failed'):
            await fill_official_form(page, details())
        self.assertEqual(page.events, [])


    async def test_invalid_details_stop_before_activation(self):
        page, invalid = DeferredCheckout(), details()
        invalid.number = 'invalid'
        with self.assertRaises(Stop):
            await fill_official_form(page, invalid)
        self.assertEqual(page.events, [])


class CancelledVerifiedQuoteTests(unittest.TestCase):
    def run_cancel(self, *, previous=None, terminal=None, cancelled=True, sent=False):
        job = LocalJob(payload())
        job.callback.send = Mock(return_value={'ok': True})
        quote = quote_from_text('ChatGPT Plus\n今日应付金额\nMYR 92.50\n预估税费\nMYR 0.00\n'
                                '将按 每月 自动续订。将按 MYR 92.50/月 收费。', 'MYR')

        async def execute():
            job.cancelled, job.payment_request_sent = cancelled, sent
            job.result = {'status': 'awaiting_confirmation', 'quote': quote,
                          'quote_authority': 'official_checkout_response', **(previous or {})}
            return {'status': 'blocked', 'reason': 'operation_cancelled',
                    'quote': {'today': None}, **(terminal or {})}

        job.execute = execute
        job.run()
        result = job.callback.send.call_args.args[0]
        self.assertEqual(result['type'], 'finished')
        return result['result'], quote

    def test_cancel_keeps_verified_final_quote_and_clears_obsolete_prompt(self):
        result, quote = self.run_cancel()
        self.assertEqual(result['quote'], quote)
        self.assertEqual(result['quote_authority'], 'official_checkout_response')
        self.assertEqual(result['status'], 'payment_cancelled')
        self.assertEqual(result['stage'], 'confirmation_cancelled')
        self.assertEqual(result['page_state'], 'checkout')
        self.assertFalse(result['user_action_required'])
        self.assertFalse(result['payment_attempted'])
        self.assertEqual(result['payment_requests_sent'], 0)

    def test_real_failures_and_unverified_quote_are_not_rewritten(self):
        for args in ({'terminal': {'reason': 'payment_quote_changed'}},
                     {'previous': {'quote_authority': None}},
                     {'previous': {'status': 'running'}}, {'cancelled': False}):
            with self.subTest(args=args):
                result, _ = self.run_cancel(**args)
                self.assertNotEqual(result['status'], 'payment_cancelled')
    def test_payment_evidence_and_request_risks_are_not_rewritten(self):
        for args in ({'sent': True}, {'terminal': {'payment_requests_sent': 1}},
                     {'terminal': {'confirmation_requests_sent': 1}},
                     {'terminal': {'payment_attempted': True}},
                     {'terminal': {'payment_status': 'unknown'}},
                     {'terminal': {'payment_outcome': 'paid_pending_activation'}},
                     {'terminal': {'payment_record_write_failed': True}},
                     {'terminal': {'payment_evidence': {'status': 'paid'}}}):
            with self.subTest(args=args):
                result, _ = self.run_cancel(**args)
                self.assertNotEqual(result['status'], 'payment_cancelled')
