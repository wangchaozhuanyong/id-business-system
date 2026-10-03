"""Original new-card UI through one original subscription update, fully intercepted."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from urllib.parse import urlsplit

from checkout_core import ACCOUNT_PATH
from subscription_upgrade import run_upgrade_in_context
import test_upgrade_card_selection as cards
from test_payment import details
from test_subscribe import account, fixture

OUTPUT = Path(__file__).resolve().parents[6] / '.runtime/upgrade-any-card-20261003/card-helper/flow-fixtures'


@unittest.skipUnless(os.environ.get('V2_PAYMENT_3DS_BROWSER_TEST') == '1', 'Explicit local intercepted browser fixtures')
class UpgradeNewCardFlowTests(cards.CardBrowserFixture):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        OUTPUT.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=OUTPUT)
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / 'state'
        self.updates, self.previews, self.card_completed = [], [], False
        self.final_plan = 'plus'
        self.confirmed, self.stages = [], []

    def home(self):
        page = super().home()
        entry = '''<main><h1>Pro</h1><div role="radiogroup" aria-label="Choose Pro plan tier">
        <button role="radio" aria-checked="false" onclick="choose(this)">100</button>
        <button role="radio" aria-checked="false" onclick="choose(this)">200</button>
        <button role="radio" aria-checked="false" onclick="choose(this)">500</button></div>
        <button onclick="openUpgrade()">Upgrade to Pro</button></main>
        <script>function choose(el){document.querySelectorAll('[role=radio]').forEach(n=>n.setAttribute('aria-checked',String(n===el)))}
        function openUpgrade(){document.querySelector('main').innerHTML=`<div role="dialog"><h2>Upgrade</h2>
        <p>ChatGPT Pro 200</p><p>MYR 420.00</p><p>Billed monthly, starting today</p><p>Total due today</p><p id="due">MYR 400.00</p>
        <p>Tax</p><p id="tax">MYR 0.00</p><button onclick="pay()">Pay now</button></div>`}
        async function pay(){const radio=document.querySelector('[name=plan-upgrade-payment-method]:checked');
        await fetch('/backend-api/subscriptions/update',{method:'POST',headers,body:JSON.stringify({account_id:account.account_id,
        updated_plan:'chatgptpro',payment_method_id:radio.value})})}
        window.addEventListener('message',event=>{if(event.origin==='https://js.stripe.com'){
        document.querySelector('#due').textContent='MYR 401.00';document.querySelector('#tax').textContent='MYR 1.00'}});
        </script>'''
        return page + entry

    async def server(self, route):
        request, path = route.request, urlsplit(route.request.url).path
        if path == '/api/auth/session':
            data = json.loads(fixture())
        elif path == ACCOUNT_PATH:
            data = account(self.final_plan)
        elif path == '/backend-api/subscriptions':
            data = {'account_id': self.target.account_id, 'plan_type': self.final_plan,
                    'is_processor_stripe': True, 'will_renew': True, 'is_delinquent': False,
                    'active_start': '2026-10-03T00:00:00Z', 'active_until': '2026-11-03T00:00:00Z'}
        elif path == '/backend-api/subscriptions/update/preview':
            tax = 100 if self.card_completed else 0
            self.previews.append(tax)
            data = {'currency': 'MYR', 'amount_due': {'amount': 40000 + tax, 'amount_excluding_tax': 40000, 'tax_amount': tax},
                    'positive_line_item_total': 42000, 'negative_line_item_total': -2000,
                    'default_payment_method': {'card_last4': '9999'}}
        elif path == '/backend-api/subscriptions/update':
            self.updates.append(request.post_data_json['payment_method_id'])
            records = list((self.state / 'payments').glob('*.json'))
            self.assertEqual(len(records), 1)
            self.assertEqual(json.loads(records[0].read_text())['confirmation_requests_sent'], 1)
            self.assertEqual(self.confirmed, [(40100, 100, 42000, '4242')])
            self.final_plan = 'pro'
            data = {'status': 'complete', 'pending_update_invoice_id': 'in_Upgrade', 'payment_intent': {
                'object': 'payment_intent', 'id': 'pi_Upgrade', 'status': 'succeeded', 'currency': 'myr', 'amount_received': 40100}}
        elif path == '/backend-api/invoices':
            data = {'data': [{'object': 'invoice', 'id': 'in_Upgrade', 'status': 'paid', 'paid': True,
                             'amount_paid': 40100, 'currency': 'myr', 'payment_intent': 'pi_Upgrade'}]}
        else:
            if path in ('/v1/setup_intents/seti_Synthetic/confirm', cards.BASE + '/confirm', cards.BASE + '/pm_New/finalize'):
                self.assertFalse(list((self.state / 'payments').glob('*.json')))
                self.assertFalse(self.updates)
                self.assertFalse(self.confirmed)
            if path in (cards.BASE + '/pm_New/finalize', cards.BASE + '/confirm'):
                self.card_completed = True
            await super().server(route)
            return
        await route.fulfill(content_type='application/json', body=json.dumps(data))

    async def run_flow(self, mode):
        self.mode = mode
        await self.page.goto('https://chatgpt.com/')
        authorized = details()
        def confirmer(quote, tail):
            self.confirmed.append((quote['today']['amount_minor'], quote['tax']['amount_minor'], quote['renewal']['amount_minor'], tail))
            return True
        with unittest.mock.patch('subscription_upgrade.progress', side_effect=lambda stage, **_fields: self.stages.append(stage)):
            result = await run_upgrade_in_context(self.page, self.target, self.state, 'pro-20x',
                details_reader=lambda _quote: authorized, confirmer=confirmer, wait_seconds=15, poll_count=1, poll_interval=0)
        self.assertEqual(result['status'], 'subscription_activated', result)
        self.assertEqual(result['payment_status'], 'paid')
        self.assertEqual(result['payment_evidence']['identifier'], 'pi_Upgrade')
        self.assertEqual(result['payment_requests_sent'], 1)
        self.assertEqual(self.updates, ['pm_Canonical' if mode == 'legacy' else 'pm_New'])
        self.assertEqual(self.previews[0], 0)
        self.assertTrue(all(value == 100 for value in self.previews[1:]))
        self.assertEqual(authorized.number, '')
        self.assertEqual(authorized.cvc, '')

    async def test_legacy_new_card_canonical_pm_unique_upgrade_after_fresh_quote(self):
        await self.run_flow('legacy')

    async def test_confirmation_token_new_card_unique_upgrade_after_fresh_quote(self):
        await self.run_flow('token')


if __name__ == '__main__':
    unittest.main()
