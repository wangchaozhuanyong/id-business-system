"""纯合成时间／控件回归；不连接官网，不使用真实付款资料。"""
import asyncio
import io
import json
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from browser_session import SessionBudget
from checkout_core import Stop
from pay import payment_handler, current_quote, quote_check_state, verified_quote_once
from payment_form import CARD_FIELDS, fill_official_form, wait_for_payment_form
from test_payment_form_focus import DeferredCheckout, DeferredFields, details
from browser_checkout import quote_from_text


class Clock:
    def __init__(self):
        self.now = 0
        self.original_sleep = asyncio.sleep

    def __call__(self):
        return self.now

    async def sleep(self, seconds):
        self.now += seconds
        await self.original_sleep(0)


class TimedField(DeferredFields):
    async def count(self):
        if self.selector not in CARD_FIELDS:
            return 0
        if self.selector == CARD_FIELDS[-1]:
            if self.page.kind == 'missing' and self.page.clock() < self.page.ready_at:
                return 0
            if self.page.kind == 'duplicate':
                return 2
        return 1

    async def is_enabled(self):
        return self.page.kind != 'disabled' or self.page.clock() >= self.page.ready_at

    async def is_editable(self):
        return self.page.kind != 'readonly' or self.page.clock() >= self.page.ready_at

    async def fill(self, value):
        self.page.writes.append(self.page.clock())
        await super().fill(value)


class TimedCheckout(DeferredCheckout):
    def __init__(self, clock, *, kind='missing', ready_at=20):
        super().__init__()
        self.clock, self.kind, self.ready_at = clock, kind, ready_at
        self.writes = []

    def locator(self, selector):
        return TimedField(self, selector)


class ReadinessBudgetTests(unittest.IsolatedAsyncioTestCase):
    async def test_all_fields_wait_beyond_fifteen_seconds_before_any_write(self):
        for kind in ('missing', 'disabled', 'readonly'):
            with self.subTest(kind=kind):
                clock = Clock()
                page = TimedCheckout(clock, kind=kind)
                budget = SessionBudget(30, clock=clock)
                with (patch('payment_form.asyncio.sleep', new=clock.sleep),
                      patch('payment_form.one_billing_field', new=AsyncMock(return_value=None))):
                    result = await fill_official_form(page, details(), budget=budget)
                self.assertTrue(result['card_fields_filled'])
                self.assertEqual(len(page.writes), 3)
                self.assertTrue(all(20 <= value < 30 for value in page.writes))
                self.assertEqual(page.events, ['activate', *CARD_FIELDS])

    async def test_missing_field_expires_at_original_round_deadline_without_writing(self):
        clock = Clock()
        page = TimedCheckout(clock, ready_at=200)
        budget = SessionBudget(30, clock=clock)
        clock.now = 28
        with patch('payment_form.asyncio.sleep', new=clock.sleep), self.assertRaises(Stop) as stopped:
            await fill_official_form(page, details(), budget=budget)
        self.assertEqual(stopped.exception.report['reason'], 'session_load_timeout')
        self.assertLess(clock(), 30.3)
        self.assertEqual(page.writes, [])

    async def test_cancellation_and_duplicate_fields_stop_before_any_write(self):
        for kind in ('missing', 'duplicate'):
            with self.subTest(kind=kind):
                clock = Clock()
                page = TimedCheckout(clock, kind=kind, ready_at=200)
                budget = SessionBudget(30, clock=clock, cancelled=lambda: clock() >= 2)
                with patch('payment_form.asyncio.sleep', new=clock.sleep), self.assertRaises(Stop) as stopped:
                    await fill_official_form(page, details(), budget=budget)
                self.assertEqual(stopped.exception.report['reason'],
                    'operation_cancelled' if kind == 'missing' else 'ambiguous_official_payment_field')
                self.assertEqual(page.writes, [])

    async def test_untrusted_frame_never_qualifies_as_ready(self):
        clock = Clock()
        page = TimedCheckout(clock, ready_at=0)
        page.url = 'https://untrusted.example.invalid'
        budget = SessionBudget(1, clock=clock)
        with patch('payment_form.asyncio.sleep', new=clock.sleep), self.assertRaises(Stop):
            await wait_for_payment_form(page, budget=budget)
        self.assertEqual(page.writes, [])


class PreparationBudgetTests(unittest.IsolatedAsyncioTestCase):
    async def invoke(self, budget, fill, quote, *, pay=True):
        card = details()
        guard = SimpleNamespace(official_binding_version=0, checkout_id='cs_synthetic', approve=Mock())
        ledger = SimpleNamespace(target_plan='plus', begin=Mock())
        confirmer = Mock()
        self.card, self.guard, self.ledger, self.confirmer = card, guard, ledger, confirmer
        self.page = SimpleNamespace(reload=AsyncMock())
        with (patch('pay.fill_official_form', new=fill), patch('pay.current_quote', new=quote),
              patch('pay.verify_billing_fields', new=AsyncMock()),
              patch('pay.verify_card_fields', new=AsyncMock()), patch('pay.progress')):
            return await payment_handler(self.page, guard,
                {'network': {'country': 'US'}}, ledger, None, pay=pay, details_reader=lambda: card,
                confirmer=confirmer, wait_seconds=1, poll_count=0, poll_interval=0,
                form_budget=budget)

    async def test_fill_and_reprice_share_remaining_round_time_and_fail_before_confirmation(self):
        clock = Clock()
        budget = SessionBudget(30, clock=clock)
        clock.now = 5  # 本轮前面的官网核对已经消耗时间。

        async def fill(*_args, **_kwargs):
            clock.now += 20
            return {'billing_fields_filled': []}

        async def quote(*_args, **kwargs):
            self.assertLessEqual(kwargs['wait_seconds'], 5)
            clock.now += 6
            return quote_from_text('ChatGPT Plus\n今日应付金额\nMYR 92.50\n预估税费\nMYR 0.00\n'
                                   '将按 每月 自动续订。将按 MYR 92.50/月 收费。', 'MYR')

        with self.assertRaises(Stop) as stopped:
            await self.invoke(budget, fill, quote)
        self.assertEqual(stopped.exception.report['reason'], 'payment_quote_not_ready')
        self.assertEqual(stopped.exception.report['quote_wait_seconds'], 30)
        self.confirmer.assert_not_called()
        self.ledger.begin.assert_not_called()
        self.guard.approve.assert_not_called()
        self.page.reload.assert_not_awaited()
        self.assertFalse(self.card.number or self.card.cvc)

    async def test_hanging_fill_is_bounded_cancelled_and_never_confirms(self):
        ended = asyncio.Event()

        async def fill(*_args, **_kwargs):
            try:
                await asyncio.Event().wait()
            finally:
                ended.set()

        quote = AsyncMock()
        with self.assertRaises(Stop) as stopped:
            await asyncio.wait_for(self.invoke(SessionBudget(.03), fill, quote), timeout=1)
        self.assertEqual(stopped.exception.report['reason'], 'official_payment_field_not_ready')
        self.assertTrue(ended.is_set())
        quote.assert_not_awaited()
        self.confirmer.assert_not_called()
        self.ledger.begin.assert_not_called()
        self.page.reload.assert_not_awaited()
        self.assertFalse(self.card.number or self.card.cvc)

class OriginalQuoteReadTests(unittest.IsolatedAsyncioTestCase):
    def complete_quote(self):
        return quote_from_text('ChatGPT Plus\n今日应付金额\nMYR 92.50\n预估税费\nMYR 0.00\n'
                               '将按 每月 自动续订。将按 MYR 92.50/月 收费。', 'MYR')

    async def short_poll(self, seconds):
        await self.original_sleep(min(seconds, .002))

    async def test_missing_binding_is_read_again_and_progress_uses_original_round(self):
        self.original_sleep = asyncio.sleep
        clock = Clock()
        budget = SessionBudget(120, clock=clock)
        clock.now = 40
        guard = SimpleNamespace(official_binding_version=1)
        value = self.complete_quote()

        async def read():
            guard.official_binding_version = 2

        with (patch('pay.verified_quote_once', new=AsyncMock(return_value=value)),
              patch('pay.asyncio.sleep', new=self.short_poll), patch('pay.progress') as report):
            reader = AsyncMock(side_effect=read)
            quote = await current_quote(object(), guard, 2, wait_seconds=.2,
                                        binding_reader=reader, progress_budget=budget)
        self.assertEqual(quote, value)
        reader.assert_awaited_once()
        self.assertEqual(report.call_args.kwargs['quote_elapsed_seconds'], 40)
        self.assertEqual(report.call_args.kwargs['quote_wait_seconds'], 120)

    async def test_read_limit_and_timeout_keep_page_and_never_accept_visible_old_price(self):
        self.original_sleep = asyncio.sleep
        page, guard, reader = SimpleNamespace(reload=AsyncMock()), SimpleNamespace(official_binding_version=2), AsyncMock()
        with (patch('pay.verified_quote_once', new=AsyncMock(return_value=None)),
              patch('pay.asyncio.sleep', new=self.short_poll), patch('pay.progress'),
              patch('pay.NATIVE_QUOTE_READ_INTERVAL', 0), self.assertRaises(Stop) as stopped):
            await current_quote(page, guard, wait_seconds=.04, binding_reader=reader)
        self.assertEqual(reader.await_count, 3)
        self.assertEqual(stopped.exception.report['reason'], 'payment_quote_not_ready')
        page.reload.assert_not_awaited()

    async def test_hanging_original_read_is_cancelled_at_remaining_deadline(self):
        ended = asyncio.Event()

        async def read():
            try:
                await asyncio.Event().wait()
            finally:
                ended.set()

        with (patch('pay.verified_quote_once', new=AsyncMock(return_value=None)),
              patch('pay.progress'), self.assertRaises(Stop) as stopped):
            await current_quote(object(), SimpleNamespace(official_binding_version=1),
                                wait_seconds=.03, binding_reader=read)
        self.assertEqual(stopped.exception.report['reason'], 'payment_quote_not_ready')
        self.assertTrue(ended.is_set())


class QuoteCheckDiagnosticTests(unittest.IsolatedAsyncioTestCase):
    async def test_fixed_state_log_deduplicates_and_never_logs_unknown_input(self):
        output, guard = io.StringIO(), SimpleNamespace()
        with patch('pay.sys.stderr', output):
            quote_check_state(guard, 'billing_mismatch')
            quote_check_state(guard, 'billing_mismatch')
            quote_check_state(guard, 'private input must not be logged')
        rows = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(rows, [{'event': 'checkout_quote_check', 'state': 'billing_mismatch'}])

    async def test_bill_mismatch_diagnostic_does_not_read_page_or_expose_fingerprint(self):
        guard = SimpleNamespace(official_quote_binding={'native': True, 'billing_fingerprint': 'old-private'},
                                expected_billing_fingerprint='new-private')
        output = io.StringIO()
        with patch('pay.sys.stderr', output), patch('pay.quote_from_page', new=AsyncMock()) as read:
            self.assertIsNone(await verified_quote_once(object(), guard))
        read.assert_not_awaited()
        self.assertEqual(json.loads(output.getvalue())['state'], 'billing_mismatch')
        self.assertNotIn('private', output.getvalue())
