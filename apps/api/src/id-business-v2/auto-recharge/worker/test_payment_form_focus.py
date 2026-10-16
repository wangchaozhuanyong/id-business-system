"""后台原结算延迟挂载的纯单元回归；不连接浏览器或使用真实银行卡。"""
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from checkout_core import Stop
from payment_form import PaymentDetails, fill_official_form


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
