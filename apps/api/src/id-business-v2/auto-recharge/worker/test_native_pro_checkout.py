"""首购 Pro 原生结算契约：纯合成 DOM、事件与临时账本；不启动浏览器或联网。"""
import asyncio
import base64
import contextlib
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from attempt_ledger import AttemptLedger, assert_no_other_payment, atomic_json, checkout_record_path
from browser_checkout import NetworkGuard, quote_from_page, run_browser, select_checkout_tier, workflow
from browser_session import SessionBudget
from checkout_core import BrowserCredential, CHECKOUT_PATH, Stop
from pay import (include_payment_record, original_payment_feedback, payment_handler,
                 run_checkout_flow, verified_quote_once)
from payment_recovery import recheck_in_context
from payment_form import subscribe_button
from payment_network import PaymentGuard
from payment_state import PaymentLedger, quote_digest
from plan_selection import Selection, checkout_radio_plan, select_plan, verify_selected_plan
from plans import pro_radio_plan


CS = 'cs_native_synthetic'
CHECKOUT_URL = 'https://chatgpt.com/checkout/openai_ie/' + CS
QUOTE = {'plan': 'pro-500', 'today': {'currency': 'PHP', 'amount': '27999.00', 'amount_minor': 2799900},
         'tax': {'currency': 'PHP', 'amount': '0.00', 'amount_minor': 0},
         'renewal': {'currency': 'PHP', 'amount': '27999.00', 'amount_minor': 2799900},
         'renewal_interval': 'monthly'}


def credential(account_id='synthetic-account'):
    def part(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
    token = '.'.join((part({'alg': 'RS256'}), part({'exp': int(time.time()) + 3600,
        'https://api.openai.com/auth': {'chatgpt_account_id': account_id}}), 'c3ludGhldGlj'))
    return BrowserCredential('', account_id, 'synthetic-user', token)


def sanitized_document(document):
    """Use the real API sanitizer, including its current allowlist, without starting Nest."""
    root = Path(__file__).resolve().parents[6]
    source = root / 'apps/api/src/id-business-v2/auto-recharge/recharge-validation.ts'
    driver = """const fs=require('fs');const ts=require('typescript');
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(
fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,
target:ts.ScriptTarget.ES2022,esModuleInterop:true,experimentalDecorators:true}}).outputText,file);
const {safeDocument}=require(process.argv[2]);
process.stdout.write(JSON.stringify(safeDocument(JSON.parse(fs.readFileSync(0,'utf8')))));"""
    result = subprocess.run([shutil.which('node'), '-e', driver, str(root), str(source)],
        input=json.dumps(document), text=True, capture_output=True, timeout=15, check=True, cwd=root)
    return json.loads(result.stdout)


def merged_confirmation_callbacks(initial, awaiting, finished):
    """Execute the API's real sanitizer and progress/finished callback merge."""
    root = Path(__file__).resolve().parents[6]
    directory = root / 'apps/api/src/id-business-v2/auto-recharge'
    driver = """const fs=require('fs');const path=require('path');const ts=require('typescript');
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(
fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,
target:ts.ScriptTarget.ES2022,esModuleInterop:true,experimentalDecorators:true}}).outputText,file);
const {safeDocument}=require(path.join(process.argv[1],'recharge-validation.ts'));
const {mergeRechargeCallbackResult}=require(path.join(process.argv[1],'recharge-bank-callback.ts'));
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const initial=safeDocument({initial_quote:input.initial});
const awaiting=mergeRechargeCallbackResult({action:'bitbrowser',plan:'pro-500',result:initial},safeDocument(input.awaiting));
const finished=mergeRechargeCallbackResult({action:'bitbrowser',plan:'pro-500',result:awaiting},safeDocument(input.finished));
process.stdout.write(JSON.stringify({awaiting,finished}));"""
    result = subprocess.run([shutil.which('node'), '-e', driver, str(directory)], input=json.dumps({
        'initial': initial, 'awaiting': awaiting, 'finished': finished}), text=True,
        capture_output=True, timeout=20, check=True, cwd=root)
    return json.loads(result.stdout)


class Node:
    def __init__(self, role=None, text='', *, attrs=None, children=(), native_checked=None):
        self.role, self.text = role, text
        self.attrs = dict(attrs or {})
        self.children, self.parent = list(children), None
        self.native_checked, self.visible, self.enabled = native_checked, True, True
        self.clicks, self.on_click = 0, None
        for child in self.children:
            child.parent = self

    def descendants(self):
        for child in self.children:
            yield child
            yield from child.descendants()

    @property
    def name(self):
        return self.attrs.get('aria-label', self.text)


class Locator:
    def __init__(self, nodes):
        self.nodes = list(dict.fromkeys(nodes))

    @property
    def first(self):
        return Locator(self.nodes[:1])

    def filter(self, *, visible=None, has_text=None):
        return Locator(n for n in self.nodes if (visible is None or n.visible == visible)
            and (has_text is None or has_text.search(n.text)))

    def or_(self, other):
        return Locator([*self.nodes, *other.nodes])

    def get_by_role(self, role, *, name=None):
        return Locator(n for root in self.nodes for n in root.descendants()
            if n.role == role and (name is None or (name.search(n.name) if hasattr(name, 'search') else n.name == name)))

    def get_by_text(self, text, *, exact=False):
        return Locator(n for root in self.nodes for n in root.descendants()
            if (n.text == text if exact else text in n.text))

    def locator(self, selector):
        if selector == '..':
            return Locator(n.parent for n in self.nodes if n.parent is not None)
        if selector == '[data-testid="pro-pricing-modal-column-top-half"]':
            return Locator(n for root in self.nodes for n in root.descendants()
                if n.attrs.get('data-testid') == 'pro-pricing-modal-column-top-half')
        if selector == "button[type='submit']":
            return Locator(n for root in self.nodes for n in root.descendants()
                if n.role == 'button' and n.attrs.get('type') == 'submit')
        raise AssertionError('unmodelled selector: ' + selector)

    async def count(self):
        return len(self.nodes)

    async def is_visible(self):
        return len(self.nodes) == 1 and self.nodes[0].visible

    async def is_enabled(self):
        return len(self.nodes) == 1 and self.nodes[0].enabled

    async def get_attribute(self, name):
        return self.nodes[0].attrs.get(name) if len(self.nodes) == 1 else None

    async def evaluate(self, _expression):
        # The semantic heading is owned by the same marked card in this fake DOM.
        node = self.nodes[0]
        while node is not None:
            if node.attrs.get('data-testid') == 'pro-pricing-modal-column-top-half':
                return True
            node = node.parent
        return False

    async def evaluate_all(self, expression):
        """Execute the production JS against native/ARIA fake nodes, not a canned row list."""
        runtime = shutil.which('node')
        if not runtime:
            raise AssertionError('Node runtime required for synthetic DOM contract')
        descriptors = [{'label': n.name, 'aria': n.attrs.get('aria-checked'),
                        'state': n.attrs.get('data-state'), 'native': n.native_checked,
                        'native_label': n.text} for n in self.nodes]
        driver = """const fs=require('fs');const x=JSON.parse(fs.readFileSync(0,'utf8'));
const nodes=x.nodes.map(n=>({innerText:n.label,checked:n.native,
labels:n.native===null?null:[{innerText:n.native_label}],
matches:s=>s==='input[type="radio"]'&&n.native!==null,
getAttribute:k=>k==='aria-label'?(n.native===null?n.label:null):
k==='aria-checked'?n.aria:k==='data-state'?n.state:null}));
const read=new Function('nodes','return ('+x.expression+')(nodes)');
process.stdout.write(JSON.stringify(read(nodes)));"""
        result = subprocess.run([runtime, '-e', driver], input=json.dumps({'expression': expression,
            'nodes': descriptors}), text=True, capture_output=True, timeout=5, check=True)
        return json.loads(result.stdout)

    async def wait_for(self, **_kwargs):
        if not self.nodes or not all(n.visible for n in self.nodes):
            raise AssertionError('synthetic missing or hidden control')

    async def click(self, **_kwargs):
        if len(self.nodes) != 1 or not self.nodes[0].enabled:
            raise AssertionError('synthetic ambiguous or disabled click')
        node = self.nodes[0]
        node.clicks += 1
        if node.on_click:
            await node.on_click()


class Page(Locator):
    def __init__(self):
        self.entry = Node('button', '升级至 Pro')
        self.card = Node(children=(Node('heading', 'ChatGPT Pro'), self.entry),
                         attrs={'data-testid': 'pro-pricing-modal-column-top-half'})
        self.overview = Node(children=(self.card,))
        self.radios = [Node('radio', label, attrs={'data-state': 'checked' if i == 0 else 'unchecked'},
                            native_checked=i == 0) for i, label in enumerate((
            'PHP 5599.00\n标准', 'PHP 11199.00\n更多使用额度', 'PHP 27999.00\n最高使用额度'))]
        self.group = Node('radiogroup', attrs={'aria-label': 'Pro 订阅套餐'}, children=self.radios)
        self.submit = Node('button', '升级至 Pro', attrs={'type': 'submit'})
        self.checkout = Node(children=(self.group, self.submit))
        self.url = 'https://chatgpt.com/'
        self.context = None
        self.quote_reads = []
        super().__init__([self.overview])
        for radio in self.radios:
            async def select(chosen=radio):
                for current in self.radios:
                    current.native_checked = current is chosen
                    current.attrs['data-state'] = 'checked' if current is chosen else 'unchecked'
            radio.on_click = select

    def locator(self, selector):
        if selector == 'body':
            return Body(self)
        return super().locator(selector)

    def show_checkout(self, checkout_id=CS):
        self.url = 'https://chatgpt.com/checkout/openai_ie/' + checkout_id
        self.nodes = [self.checkout]

    def set_default_timeout(self, _timeout):
        pass

    async def goto(self, url, **_kwargs):
        self.url = url
        return None

    async def title(self):
        return 'ChatGPT'


class Body(Locator):
    def __init__(self, page):
        super().__init__(page.nodes)
        self.page = page

    async def inner_text(self):
        selected = [i for i, node in enumerate(self.page.radios) if node.native_checked is True]
        if len(selected) != 1:
            return 'ChatGPT Pro\n报价正在更新'
        # Fixture prices depend on the fake DOM's state, independently of production parsing.
        amount = getattr(self.page, 'quote_amounts', ('5599.00', '11199.00', '27999.00'))[selected[0]]
        tax = getattr(self.page, 'quote_taxes', ('0.00', '0.00', '0.00'))[selected[0]]
        tax_label = getattr(self.page, 'tax_label', '税费')
        self.page.quote_reads.append((selected[0], amount, self.page.url))
        return ('ChatGPT Pro\n' + '\n'.join(node.text for node in self.page.radios)
                + f'\n今日应付金额\nPHP {amount}\n{tax_label} PHP {tax}\n将按 PHP {amount}/月 收费。')


class StrictPage:
    """真实 Page 只产生 Locator，不暴露 Locator 集合接口。"""
    def __init__(self, page):
        self.page = page

    def __getattr__(self, name):
        if name in {'count', 'get_attribute', 'evaluate_all', 'inner_text', 'filter', 'or_'}:
            raise AttributeError('Page has no locator collection interface')
        return getattr(self.page, name)


class Request:
    def __init__(self, target, *, plan='chatgptprolite', url=None, data=None):
        self.url = url or 'https://chatgpt.com' + CHECKOUT_PATH
        self.method, self.headers = 'POST', {'authorization': 'Bearer ' + target.old_token}
        self.post_data_json = data if data is not None else {'plan_name': plan}
        self.post_data = json.dumps(self.post_data_json)


class Response:
    def __init__(self, request, data):
        self.request, self.url, self.status, self.data = request, request.url, 200, data

    async def body(self):
        return json.dumps(self.data).encode()

    async def all_headers(self):
        return {'content-type': 'application/json'}


class Context:
    def __init__(self, page):
        self.pages, self.listeners = [page], {}
        page.context = self

    def on(self, name, handler):
        self.listeners.setdefault(name, []).append(handler)

    def remove_listener(self, name, handler):
        self.listeners[name].remove(handler)

    async def emit(self, name, value):
        for handler in tuple(self.listeners.get(name, ())):
            handler(value)
        if name == 'response':
            tasks = {task for handler in self.listeners[name]
                     for task in getattr(getattr(handler, '__self__', None), 'tasks', ())}
            if tasks:
                await asyncio.gather(*tasks)


def fake_expect(locator):
    class Assertion:
        async def to_have_count(self, expected, **_kwargs):
            if await locator.count() != expected:
                raise AssertionError('synthetic count mismatch')

        async def to_be_visible(self, **_kwargs):
            if not await locator.is_visible():
                raise AssertionError('synthetic hidden control')

        async def to_be_enabled(self, **_kwargs):
            if not await locator.is_enabled():
                raise AssertionError('synthetic disabled control')
    return Assertion()


class NativeProContractTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / 'state'
        self.target, self.page = credential(), Page()
        self.enterContext(patch('plan_selection.expect', side_effect=fake_expect))
        self.stderr = io.StringIO()
        self.enterContext(contextlib.redirect_stderr(self.stderr))

    def ledger(self):
        return self.enterContext(AttemptLedger(self.state, self.target.account_id, target_plan='pro-500'))

    def guard(self, *, payment=False, pending=True):
        ledger = self.ledger()
        guard = PaymentGuard(self.target, checkout_ledger=ledger) if payment else NetworkGuard(self.target, ledger)
        guard.account_verified = True
        guard.prepare_first_pro_checkout(tier_pending=pending, current_plan='free')
        return guard

    async def create(self, guard):
        guard.begin_checkout()
        request = Request(self.target)
        guard.observe_request(request)
        await guard.response(Response(request, {'checkout_session_id': CS, 'processor_entity': 'openai_ie',
            'billing_details': {'currency': 'PHP', 'country': 'PH'}}))
        self.page.show_checkout()
        return request

    async def quote_binding(self, guard, suffix='init', checkout_id=CS, amount=559900, tax=0):
        request = Request(self.target, url=f'https://api.stripe.com/v1/payment_pages/{checkout_id}/{suffix}', data={})
        guard.observe_request(request)
        await guard.response(Response(request, {'session_id': checkout_id, 'amount_total': amount,
            'currency': 'php', 'total_details': {'amount_tax': tax}}))
        return request

    def sanitized_record(self):
        with AttemptLedger(self.state, self.target.account_id, target_plan='pro-500') as ledger:
            ledger.begin()
            ledger.finish({'checkout_identifier': CS, 'processor_entity': 'openai_ie',
                'returned_currency': 'PHP', 'checkout_outcome': 'created',
                'first_pro_checkout': True, 'checkout_plan': 'pro-5x',
                'checkout_tier_pending': True, 'checkout_tier_verified': False,
                'checkout_tier_binding_minimum': 2, 'checkout_tier_request_minimum': 2})
            original = dict(ledger.record)
        clean = sanitized_document(original)
        self.assertFalse(any(key.startswith(('first_', 'checkout_tier_', 'tier_')) or key == 'checkout_plan'
                             for key in clean))
        self.assertEqual(clean['target_plan'], 'pro-500')
        self.assertEqual(clean['plan'], 'chatgptpromax')
        path = checkout_record_path(self.state, self.target.account_id, 'pro-500')
        atomic_json(path, clean)
        return clean, path

    async def confirmation_report(self, mode='expired'):
        import bitbrowser_connector as connector
        from test_bitbrowser_connector import payload
        from test_payment import details
        record, path = self.sanitized_record()
        before = path.read_bytes()
        self.page.show_checkout()
        self.page.quote_amounts = ('6490.00', '12990.00', '32490.00')
        self.page.quote_taxes = ('695.36', '1391.79', '3481.07')
        self.page.tax_label = '增值税 (VAT) (12%)'
        context = Context(StrictPage(self.page))
        guards, callbacks, private_confirmation = [], [], []
        value = payload()
        value['plan'] = 'pro-500'
        value['safety']['lockedCurrency'] = 'PHP'
        job = connector.LocalJob(value)
        job.root, job.account_key = self.state, hashlib.sha256(self.target.account_id.encode()).hexdigest()
        elapsed_confirmation = [False]
        def callback(body):
            callbacks.append(json.loads(json.dumps(body)))
            if body.get('result', {}).get('status') == 'awaiting_confirmation':
                pending = job.pending_confirmation
                private_confirmation.append((pending['nonce'], pending['quote_digest']))
                if mode == 'duration_expired':
                    job.signal_confirm(pending['nonce'], pending['quote_digest'])
                    elapsed_confirmation[0] = True
            return {'ok': True}
        job.callback.send = Mock(side_effect=callback)
        def factory(target, _ledger):
            guard = PaymentGuard(target, target_plan='pro-500')
            guards.append(guard)
            return guard
        original_select = self.page.radios[2].on_click
        async def update_initial_quote():
            await original_select()
            await self.quote_binding(guards[0], 'update', amount=3249000, tax=348107)
        self.page.radios[2].on_click = update_initial_quote
        async def fill_us_address(_page, payment_details):
            self.assertEqual(payment_details.country, 'US')
            self.page.quote_amounts = ('6490.00', '12990.00', '29008.93')
            self.page.quote_taxes = ('0.00', '0.00', '0.00')
            await self.quote_binding(guards[0], 'update', amount=2900893, tax=0)
            return {'card_fields_filled': True, 'billing_fields_filled': ['country', 'name', 'line1']}
        async def prepare(page, guard, identity, _initial):
            with PaymentLedger(self.state, self.target.account_id, target_plan='pro-500') as payment:
                guard.attach_payment_ledger(payment)
                with contextlib.ExitStack() as controls:
                    if mode == 'expired':
                        controls.enter_context(patch('bitbrowser_connector.time', SimpleNamespace(
                            time=Mock(side_effect=(1700000000, 1700000301)))))
                        controls.enter_context(patch.object(job.confirmation_event, 'wait', return_value=False))
                    if mode == 'duration_expired':
                        controls.enter_context(patch('pay.time', SimpleNamespace(
                            monotonic=lambda: time.monotonic() + (301 if elapsed_confirmation[0] else 0))))
                    return await payment_handler(page, guard, identity, payment, self.target, pay=True,
                        details_reader=details, confirmer=job.confirm, wait_seconds=0,
                        poll_count=0, poll_interval=0, quote_wait_seconds=1.5)
        identity = {'session_status': 'verified', 'account_matched': True, 'current_plan': 'free'}
        with patch('browser_checkout.check_session', AsyncMock(return_value=(self.target, identity))), \
                patch('pay.check_session', AsyncMock(return_value=(self.target, identity))), \
                patch('pay.fill_official_form', AsyncMock(side_effect=fill_us_address)), \
                patch('pay.verify_billing_fields', AsyncMock()), \
                patch('pay.verify_card_fields', AsyncMock()), \
                patch.dict('os.environ', {'AUTO_RECHARGE_CALLBACK_URL': ''}):
            result = await run_browser(self.target, inspect_existing=True, state_dir=self.state,
                target_plan='pro-500', browser_context=context, quote_handler=prepare, guard_factory=factory,
                allow_checkout_tier_change=True, session_budget=SessionBudget(.5))
        self.assertEqual(result['checkout_identifier'], record['checkout_identifier'])
        self.assertEqual(result['checkout_requests_sent'], 0)
        self.assertEqual(result['payment_requests_sent'], 0)
        self.assertEqual(guards[0].confirmation_sent, 0)
        self.assertEqual(self.page.submit.clicks, 0)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(list((self.state / 'payments').glob('*.json')), [])
        self.assertEqual(job.confirmation_consumed, mode == 'duration_expired')
        self.assertIsNone(job.pending_confirmation)
        with self.assertRaises(Stop) as rejected:
            job.signal_confirm(*private_confirmation[0])
        self.assertEqual(rejected.exception.report['reason'], 'payment_confirmation_invalid')
        initial = [json.loads(line)['initial_quote'] for line in self.stderr.getvalue().splitlines()
                   if line.startswith('{') and json.loads(line).get('event') == 'quote_ready'][0]
        return result, callbacks[0]['result'], initial

    async def test_real_confirmation_expiry_retains_final_quote_through_workflow_and_api_merge(self):
        result, awaiting, initial = await self.confirmation_report()
        self.assertEqual(awaiting['quote']['today']['amount_minor'], 2900893)
        self.assertEqual(awaiting['quote']['tax']['amount_minor'], 0)
        self.assertEqual(result['reason'], 'payment_confirmation_expired', result)
        self.assertEqual(result['stage'], 'payment_confirmation', result)
        self.assertEqual(result['quote']['today']['amount_minor'], 2900893)
        self.assertEqual(result['quote']['tax']['amount_minor'], 0)
        self.assertEqual(result['quote']['renewal']['amount_minor'], 2900893)
        self.assertEqual(result['quote']['renewal_interval'], 'monthly')
        self.assertEqual(initial['today']['amount_minor'], 3249000)
        self.assertEqual(initial['tax']['amount_minor'], 348107)
        self.assertNotIn('visible_quote_lines', result)
        merged = merged_confirmation_callbacks(initial, awaiting, result)
        for state in merged.values():
            self.assertEqual(state['quote']['today']['amount_minor'], 2900893)
            self.assertEqual(state['quote']['tax']['amount_minor'], 0)
            self.assertEqual(state['initial_quote']['today']['amount_minor'], 3249000)
            self.assertEqual(state['initial_quote']['tax']['amount_minor'], 348107)
        self.assertEqual(merged['finished']['stage'], 'payment_confirmation')

    async def test_actual_payment_handler_own_elapsed_expiry_retains_final_quote(self):
        result, awaiting, initial = await self.confirmation_report('duration_expired')
        self.assertEqual(result['reason'], 'payment_confirmation_expired', result)
        self.assertEqual(result['stage'], 'payment_confirmation', result)
        self.assertEqual(result['quote']['today']['amount_minor'], 2900893)
        self.assertEqual(result['quote']['tax']['amount_minor'], 0)
        self.assertEqual(initial['today']['amount_minor'], 3249000)
        self.assertEqual(awaiting['quote']['today']['amount_minor'], 2900893)
        self.assertNotIn('visible_quote_lines', result)

    async def test_workflow_explicit_quote_changed_report_is_not_overwritten_by_initial_quote(self):
        record, path = self.sanitized_record()
        before = path.read_bytes()
        self.page.show_checkout()
        self.page.quote_amounts = ('6490.00', '12990.00', '32490.00')
        self.page.quote_taxes = ('695.36', '1391.79', '3481.07')
        self.page.tax_label = '增值税 (VAT) (12%)'
        context = Context(StrictPage(self.page))
        guards = []
        def factory(target, _ledger):
            guard = PaymentGuard(target, target_plan='pro-500')
            guards.append(guard)
            return guard
        original_select = self.page.radios[2].on_click
        async def update_initial_quote():
            await original_select()
            await self.quote_binding(guards[0], 'update', amount=3249000, tax=348107)
        self.page.radios[2].on_click = update_initial_quote
        async def explicit_change(page, guard, _identity, initial):
            self.assertEqual(initial['today']['amount_minor'], 3249000)
            self.page.quote_amounts = ('6490.00', '12990.00', '29008.93')
            self.page.quote_taxes = ('0.00', '0.00', '0.00')
            await self.quote_binding(guard, 'update', amount=2900893, tax=0)
            changed = await verified_quote_once(page, guard)
            raise Stop('payment_quote_changed', stage='payment_quote_recheck', quote=changed)
        identity = {'session_status': 'verified', 'account_matched': True, 'current_plan': 'free'}
        with patch('browser_checkout.check_session', AsyncMock(return_value=(self.target, identity))), \
                patch.dict('os.environ', {'AUTO_RECHARGE_CALLBACK_URL': ''}):
            result = await run_browser(self.target, inspect_existing=True, state_dir=self.state,
                target_plan='pro-500', browser_context=context, quote_handler=explicit_change, guard_factory=factory,
                allow_checkout_tier_change=True, session_budget=SessionBudget(.5))
        self.assertEqual(result['reason'], 'payment_quote_changed')
        self.assertEqual(result['stage'], 'payment_quote_recheck')
        self.assertEqual(result['quote']['today']['amount_minor'], 2900893)
        self.assertEqual(result['quote']['tax']['amount_minor'], 0)
        self.assertNotIn('visible_quote_lines', result)
        self.assertEqual(result['checkout_identifier'], record['checkout_identifier'])
        self.assertEqual(result['checkout_requests_sent'], 0)
        self.assertEqual(result['payment_requests_sent'], 0)
        self.assertEqual(self.page.submit.clicks, 0)
        self.assertEqual(path.read_bytes(), before)

    def assert_recovery_diagnostic(self, reason, *, tier_allowed, current_record=False,
                                   eligibility_checked=True, payment_checked=True,
                                   proof_valid=True, missing_fields=()):
        events = [json.loads(line) for line in self.stderr.getvalue().splitlines() if line.startswith('{')]
        diagnostics = [event for event in events if event.get('event') == 'first_pro_recovery_diagnostic']
        self.assertEqual(len(diagnostics), 1, diagnostics)
        diagnostic = diagnostics[0]
        self.assertEqual(set(diagnostic), {'event', 'canonical_proof_valid', 'tier_change_requested',
            'tier_change_allowed', 'payment_record_checked', 'current_checkout_payment_record', 'write_eligibility_checked',
            'missing_proof_fields', 'eligibility_reason'})
        for key in ('canonical_proof_valid', 'tier_change_requested', 'tier_change_allowed',
                    'payment_record_checked', 'current_checkout_payment_record', 'write_eligibility_checked'):
            self.assertIs(type(diagnostic[key]), bool)
        self.assertEqual(diagnostic['canonical_proof_valid'], proof_valid)
        self.assertTrue(diagnostic['tier_change_requested'])
        self.assertEqual(diagnostic['tier_change_allowed'], tier_allowed)
        self.assertEqual(diagnostic['current_checkout_payment_record'], current_record)
        self.assertEqual(diagnostic['payment_record_checked'], payment_checked)
        self.assertEqual(diagnostic['write_eligibility_checked'], eligibility_checked)
        self.assertEqual(diagnostic['missing_proof_fields'], list(missing_fields))
        self.assertEqual(diagnostic['eligibility_reason'], reason)
        encoded = json.dumps(diagnostic)
        self.assertNotIn(CS, encoded)
        self.assertNotIn(self.target.account_id, encoded)
        self.assertNotIn(hashlib.sha256(self.target.account_id.encode()).hexdigest(), encoded)
        self.assertNotIn(self.target.old_token, encoded)

    async def test_real_api_sanitizer_record_restores_original_checkout_and_prepares_vat_quote(self):
        record, path = self.sanitized_record()
        await self.assert_real_cleaned_recovery_prepares(record, path)

    async def assert_real_cleaned_recovery_prepares(self, record, path, history_paths=()):
        from test_payment import details
        before = path.read_bytes()
        history_before = {item: item.read_bytes() for item in history_paths}
        self.page.show_checkout()
        self.page.quote_amounts = ('6490.00', '12990.00', '32490.00')
        self.page.quote_taxes = ('695.36', '1391.79', '3481.07')
        self.page.tax_label = '增值税 (VAT) (12%)'
        page = StrictPage(self.page)
        context = Context(page)
        guards = []
        def factory(target, _ledger):
            guard = PaymentGuard(target, target_plan='pro-500')
            guards.append(guard)
            return guard
        original_select = self.page.radios[2].on_click
        async def update_checkout():
            await original_select()
            await self.quote_binding(guards[0], 'update', amount=3249000, tax=348107)
        self.page.radios[2].on_click = update_checkout
        identity = {'session_status': 'verified', 'account_matched': True, 'current_plan': 'free'}
        async def prepare(active_page, guard, live_identity, _quote):
            with PaymentLedger(self.state, self.target.account_id, target_plan='pro-500') as payment:
                guard.attach_payment_ledger(payment)
                return await payment_handler(active_page, guard, live_identity, payment, self.target,
                    pay=False, details_reader=details, confirmer=lambda *_args: False,
                    wait_seconds=0, poll_count=0, poll_interval=0, quote_wait_seconds=1.5)
        async def filled_and_repriced(*_args):
            await self.quote_binding(guards[0], 'update', amount=3249000, tax=348107)
            return {'card_fields_filled': True, 'billing_fields_filled': ['country', 'name', 'line1']}
        with patch('browser_checkout.check_session', AsyncMock(return_value=(self.target, identity))) as session, \
                patch('pay.fill_official_form', AsyncMock(side_effect=filled_and_repriced)) as fill, \
                patch('pay.verify_billing_fields', AsyncMock()) as verify, \
                patch('pay.verify_card_fields', AsyncMock()), \
                patch.dict('os.environ', {'AUTO_RECHARGE_CALLBACK_URL': ''}):
            result = await run_browser(self.target, inspect_existing=True, state_dir=self.state,
                target_plan='pro-500', browser_context=context, guard_factory=factory,
                quote_handler=prepare, allow_checkout_tier_change=True, session_budget=SessionBudget(.5))
        self.assertEqual(result.get('status'), 'payment_prepared', result)
        self.assertEqual(result['quote']['plan'], 'pro-500')
        self.assertEqual(result['quote']['today']['amount_minor'], 3249000)
        self.assertEqual(result['quote']['tax']['amount_minor'], 348107)
        self.assertEqual(result['quote']['renewal']['amount_minor'], 3249000)
        self.assertEqual(result['quote']['renewal_interval'], 'monthly')
        self.assertEqual(result['quote']['plan_source'], 'official_checkout_selected_radio')
        self.assertEqual(result['quote_authority'], 'official_checkout_response')
        self.assertEqual(result['checkout_identifier'], record['checkout_identifier'])
        self.assertEqual(result['checkout_requests_sent'], 0)
        self.assertEqual(result['payment_requests_sent'], 0)
        self.assertEqual(guards[0].confirmation_sent, 0)
        self.assertEqual(self.page.radios[2].clicks, 1)
        self.assertEqual(self.page.entry.clicks, 0)
        self.assertEqual(self.page.submit.clicks, 0)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(set((self.state / 'payments').glob('*.json')), set(history_paths))
        self.assertTrue(all(item.read_bytes() == value for item, value in history_before.items()))
        session.assert_awaited_once()
        fill.assert_awaited_once()
        verify.assert_awaited_once()
        self.assert_recovery_diagnostic('qualified', tier_allowed=True)

    def historical_payment(self, kind):
        old_checkout = 'cs_previous_synthetic'
        key = hashlib.sha256(self.target.account_id.encode()).hexdigest()
        record = {'schema_version': 3, 'account_key': key, 'target_plan': 'pro-500',
            'checkout_identifier': old_checkout, 'quote': QUOTE, 'quote_digest': quote_digest(QUOTE),
            'card_last4': '4242', 'payment_attempted': True, 'payment_status': 'unknown',
            'confirmation_requests_sent': 1, 'payment_evidence': None, 'subscription_status': 'not_verified'}
        if kind in {'resolved', 'incomplete_resolved'}:
            record.update(operator_resolution='confirmed_no_bank_request',
                resolved_at='2026-10-14T00:00:00.000Z',
                resolution_job_id='11111111-1111-4111-8111-111111111111',
                source_job_id='22222222-2222-4222-8222-222222222222',
                verification_job_id='33333333-3333-4333-8333-333333333333')
            if kind == 'incomplete_resolved':
                record.pop('verification_job_id')
        elif kind == 'cancelled':
            record.update(cancelled_before_confirmation=True, payment_status='cancelled',
                          confirmation_requests_sent=0)
        elif kind == 'closed':
            record.update(payment_status='paid', status='subscription_activated',
                subscription_status='pro-500', current_plan='promax',
                payment_evidence={'kind': 'checkout_session', 'identifier': old_checkout,
                    'amount_minor': 2799900, 'currency': 'PHP'},
                cycle_resolution={'protocol': 1, 'status': 'closed', 'account_key': key,
                    'target_plan': 'pro-500', 'source_job_id': '22222222-2222-4222-8222-222222222222',
                    'original_document_digest': 'd' * 64, 'review_digest': 'c' * 64,
                    'closed_at': time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(time.time() - 60)) + '.000Z'})
        folder = self.state / 'payments'
        folder.mkdir(mode=0o700, exist_ok=True)
        path = folder / (hashlib.sha256(old_checkout.encode()).hexdigest() + '.json')
        atomic_json(path, record)
        return path

    async def test_fully_resolved_other_checkout_does_not_block_cleaned_recovery_preparation(self):
        record, path = self.sanitized_record()
        history = self.historical_payment('resolved')
        assert_no_other_payment(self.state, self.target.account_id, CS, read_only=False)
        await self.assert_real_cleaned_recovery_prepares(record, path, (history,))

    async def test_cancelled_before_confirmation_other_checkout_does_not_block_cleaned_recovery_preparation(self):
        record, path = self.sanitized_record()
        history = self.historical_payment('cancelled')
        assert_no_other_payment(self.state, self.target.account_id, CS, read_only=False)
        await self.assert_real_cleaned_recovery_prepares(record, path, (history,))

    async def test_unresolved_or_incompletely_resolved_other_payment_stops_before_browser_selection(self):
        base = self.state
        for kind in ('unresolved', 'incomplete_resolved'):
            with self.subTest(kind=kind):
                self.state, self.page = base / kind, Page()
                self.stderr.seek(0)
                self.stderr.truncate(0)
                _record, path = self.sanitized_record()
                history = self.historical_payment(kind)
                before, history_before = path.read_bytes(), history.read_bytes()
                with self.assertRaises(Stop) as blocked:
                    assert_no_other_payment(self.state, self.target.account_id, CS, read_only=False)
                self.assertEqual(blocked.exception.report['reason'], 'account_has_other_payment_attempt')
                self.page.show_checkout()
                context = Context(StrictPage(self.page))
                with self.assertRaises(Stop) as blocked:
                    await run_browser(self.target, inspect_existing=True, state_dir=self.state,
                        target_plan='pro-500', browser_context=context, quote_handler=AsyncMock(),
                        guard_factory=lambda target, _ledger: PaymentGuard(target, target_plan='pro-500'),
                        allow_checkout_tier_change=True, session_budget=SessionBudget(.5))
                self.assertEqual(blocked.exception.report['reason'], 'account_has_other_payment_attempt')
                self.assertEqual(self.page.radios[2].clicks, 0)
                self.assertEqual(self.page.entry.clicks, 0)
                self.assertEqual(self.page.submit.clicks, 0)
                self.assertEqual(path.read_bytes(), before)
                self.assertEqual(history.read_bytes(), history_before)
                self.assert_recovery_diagnostic('original_payment_eligibility_rejected', tier_allowed=False,
                                                eligibility_checked=False, payment_checked=False)

    async def test_closed_history_without_cycle_grant_only_allows_readonly_inspection(self):
        _record, path = self.sanitized_record()
        history = self.historical_payment('closed')
        before, history_before = path.read_bytes(), history.read_bytes()
        assert_no_other_payment(self.state, self.target.account_id, CS, read_only=True)
        with self.assertRaises(Stop) as blocked:
            assert_no_other_payment(self.state, self.target.account_id, CS, read_only=False)
        self.assertEqual(blocked.exception.report['reason'], 'account_has_other_payment_attempt')
        self.page.show_checkout()
        context = Context(StrictPage(self.page))
        handler = AsyncMock()
        identity = {'session_status': 'verified', 'account_matched': True, 'current_plan': 'free'}
        with patch('browser_checkout.check_session', AsyncMock(return_value=(self.target, identity))), \
                patch.dict('os.environ', {'AUTO_RECHARGE_CALLBACK_URL': ''}):
            with self.assertRaises(Stop) as blocked:
                await run_browser(self.target, inspect_existing=True, state_dir=self.state,
                    target_plan='pro-500', browser_context=context, quote_handler=handler,
                    guard_factory=lambda target, _ledger: PaymentGuard(target, target_plan='pro-500'),
                    allow_checkout_tier_change=True, session_budget=SessionBudget(.5))
        self.assertEqual(blocked.exception.report['reason'], 'account_has_other_payment_attempt')
        self.assertEqual(self.page.radios[2].clicks, 0)
        self.assertEqual(self.page.submit.clicks, 0)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(history.read_bytes(), history_before)
        handler.assert_not_awaited()

        self.assert_recovery_diagnostic('original_payment_eligibility_rejected', tier_allowed=False)

    async def test_canonical_cleaned_recovery_proof_requires_exact_fields_and_no_payment_markers(self):
        from browser_checkout import can_restore_first_pro_checkout
        record, _path = self.sanitized_record()
        self.assertTrue(can_restore_first_pro_checkout(record, 'pro-500'))
        required = ('target_plan', 'plan', 'account_matched', 'current_plan_before',
                    'transport', 'checkout_outcome', 'payment_status')
        for key in required:
            with self.subTest(missing=key):
                incomplete = {field: value for field, value in record.items() if field != key}
                self.assertFalse(can_restore_first_pro_checkout(incomplete, 'pro-500'))
        for changed in ({'target_plan': 'pro-20x'}, {'plan': 'chatgptprolite'},
                {'account_matched': 1}, {'account_matched': 'true'}, {'current_plan_before': 'plus'},
                {'current_plan_before': None}, {'transport': 'server'}, {'checkout_outcome': 'unknown'},
                {'payment_status': 'unknown'}, {'payment_attempted': True}, {'payment_attempted': 0},
                {'payment_attempted': 'false'}, {'operation': 'subscription_upgrade'},
                {'upgrade_identifier': 'synthetic-upgrade'}, {'upgrade_invoice_identifier': 'in_synthetic'},
                {'upgrade_payment_intent_identifier': 'pi_synthetic'}, {'payment_evidence': {}},
                {'payment_requests_sent': 1}, {'confirmation_requests_sent': 1},
                {'confirmation_requests_sent': False}, {'card_tokenization_requests_sent': '0'}):
            with self.subTest(changed=changed):
                self.assertFalse(can_restore_first_pro_checkout({**record, **changed}, 'pro-500'))
        for target in ('plus', 'go', 'pro-20x', 'invented'):
            with self.subTest(target=target):
                self.assertFalse(can_restore_first_pro_checkout(record, target))

    async def test_cleaned_recovery_rechecks_live_free_account_before_any_tier_change(self):
        _record, path = self.sanitized_record()
        before = path.read_bytes()
        page = StrictPage(self.page)
        for current, error, reason in (('plus', None, 'incompatible_existing_subscription'),
                                      ('free', Stop('target_account_mismatch'), 'target_account_mismatch')):
            with self.subTest(current=current, error=error is not None):
                self.page.show_checkout()
                context = Context(page)
                handler = AsyncMock()
                identity = {'session_status': 'verified', 'account_matched': True, 'current_plan': current}
                session = AsyncMock(side_effect=error, return_value=(self.target, identity))
                with patch('browser_checkout.check_session', session), \
                        patch.dict('os.environ', {'AUTO_RECHARGE_CALLBACK_URL': ''}):
                    result = await run_browser(self.target, inspect_existing=True, state_dir=self.state,
                        target_plan='pro-500', browser_context=context,
                        guard_factory=lambda target, _ledger: PaymentGuard(target, target_plan='pro-500'),
                        quote_handler=handler, allow_checkout_tier_change=True, session_budget=SessionBudget(.5))
                self.assertEqual(result['reason'], reason, result)
                self.assertEqual(result['checkout_requests_sent'], 0)
                self.assertEqual(result['payment_requests_sent'], 0)
                self.assertEqual(self.page.radios[2].clicks, 0)
                self.assertEqual(self.page.submit.clicks, 0)
                self.assertEqual(path.read_bytes(), before)
                handler.assert_not_awaited()
                session.assert_awaited_once()

    async def test_real_payment_marker_makes_cleaned_recovery_readonly_without_changing_tier(self):
        _record, path = self.sanitized_record()
        before = path.read_bytes()
        with PaymentLedger(self.state, self.target.account_id, target_plan='pro-500') as payment:
            payment.begin(QUOTE, confirmed_digest=quote_digest(QUOTE), card_last4='4242')
            payment_path = payment.path
            marker_before = payment_path.read_bytes()
        self.page.show_checkout()
        context = Context(StrictPage(self.page))
        handler = AsyncMock()
        identity = {'session_status': 'verified', 'account_matched': True, 'current_plan': 'free'}
        with patch('browser_checkout.check_session', AsyncMock(return_value=(self.target, identity))), \
                patch.dict('os.environ', {'AUTO_RECHARGE_CALLBACK_URL': ''}):
            result = await run_browser(self.target, inspect_existing=True, state_dir=self.state,
                target_plan='pro-500', browser_context=context,
                guard_factory=lambda target, _ledger: PaymentGuard(target, target_plan='pro-500'),
                quote_handler=handler, allow_checkout_tier_change=True, session_budget=SessionBudget(.5))
        self.assertEqual(result['reason'], 'checkout_tier_not_verified', result)
        self.assertEqual(result['checkout_requests_sent'], 0)
        self.assertEqual(result['payment_requests_sent'], 0)
        self.assertEqual(self.page.radios[2].clicks, 0)
        self.assertEqual(self.page.submit.clicks, 0)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(payment_path.read_bytes(), marker_before)
        handler.assert_not_awaited()
        self.assert_recovery_diagnostic('current_checkout_payment_record', tier_allowed=False,
                                        current_record=True, eligibility_checked=False)

    async def test_actual_checkout_flow_incomplete_metadata_never_replaces_original_checkout(self):
        record, path = self.sanitized_record()
        record.pop('transport')
        atomic_json(path, record)
        before = path.read_bytes()
        self.page.show_checkout()
        context = Context(StrictPage(self.page))
        details_reader = Mock(side_effect=AssertionError('incomplete proof must stop before details'))
        confirmer = Mock(side_effect=AssertionError('incomplete proof must stop before confirmation'))
        identity = {'session_status': 'verified', 'account_matched': True, 'current_plan': 'free'}
        with patch('browser_checkout.check_session', AsyncMock(return_value=(self.target, identity))), \
                patch.dict('os.environ', {'AUTO_RECHARGE_CALLBACK_URL': ''}):
            result = await run_checkout_flow(self.target, self.state, 'pro-500',
                details_reader=details_reader, confirmer=confirmer, browser_context=context,
                session_budget=SessionBudget(.5), wait_seconds=0, poll_count=0, poll_interval=0)
        self.assertEqual(result['reason'], 'checkout_tier_not_verified', result)
        self.assertEqual(result['checkout_identifier'], CS)
        self.assertEqual(result['checkout_requests_sent'], 0)
        self.assertEqual(result['payment_requests_sent'], 0)
        self.assertNotIn('checkout_replacement_performed', result)
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse((self.state / 'history').exists())
        self.assertEqual(list((self.state / 'payments').glob('*.json')), [])
        self.assertEqual(self.page.entry.clicks, 0)
        self.assertEqual(self.page.radios[2].clicks, 0)
        self.assertEqual(self.page.submit.clicks, 0)
        details_reader.assert_not_called()
        confirmer.assert_not_called()
        self.assert_recovery_diagnostic('qualified', tier_allowed=True,
                                        proof_valid=False, missing_fields=('transport',))

    async def test_strict_page_without_count_selects_bound_native_checkout_tier(self):
        guard = self.guard()
        await self.create(guard)
        page = StrictPage(self.page)
        self.assertFalse(hasattr(page, 'count'))
        await select_checkout_tier(page, guard, 'pro-500', allow_change=True)
        self.assertTrue(guard.checkout_tier_verified)
        self.assertEqual(self.page.radios[2].clicks, 1)
        self.assertEqual(self.page.submit.clicks, 0)
        self.assertEqual(self.page.url, CHECKOUT_URL)

    async def test_strict_page_resumes_original_checkout_without_new_creation(self):
        original_guard = self.guard()
        await self.create(original_guard)
        original_record = dict(original_guard.ledger.record)
        page = StrictPage(self.page)
        context = Context(page)
        guards = []
        def factory(target, _ledger):
            guard = PaymentGuard(target, target_plan='pro-500')
            guards.append(guard)
            return guard
        original_select = self.page.radios[2].on_click
        async def update_checkout():
            await original_select()
            await self.quote_binding(guards[0], 'update', amount=2799900)
        self.page.radios[2].on_click = update_checkout
        identity = {'session_status': 'verified', 'account_matched': True, 'current_plan': 'free'}
        async def inspect_cta(active_page, guard, _identity, quote):
            self.assertEqual(quote['plan'], 'pro-500')
            self.assertEqual((await verified_quote_once(active_page, guard))['plan'], 'pro-500')
            await subscribe_button(active_page, first_pro_context=guard)
            return {'synthetic_cta_ready': True}
        with patch('browser_checkout.check_session', AsyncMock(return_value=(self.target, identity))), \
                patch.dict('os.environ', {'AUTO_RECHARGE_CALLBACK_URL': ''}):
            result = await workflow(context, self.target, existing=original_record, target_plan='pro-500',
                                    guard_factory=factory, quote_handler=inspect_cta,
                                    allow_checkout_tier_change=True)
        self.assertEqual(result.get('status'), 'checkout_quote_verified', result)
        self.assertTrue(result['synthetic_cta_ready'])
        self.assertEqual(result['checkout_identifier'], original_record['checkout_identifier'])
        self.assertEqual(result['checkout_requests_sent'], 0)
        self.assertEqual(result['payment_requests_sent'], 0)
        self.assertEqual(self.page.entry.clicks, 0)
        self.assertEqual(self.page.submit.clicks, 0)
        self.assertEqual(original_guard.ledger.record['checkout_identifier'], original_record['checkout_identifier'])

    async def test_overview_without_radio_defers_tier_and_does_not_click(self):
        with patch.object(Selection, 'open_menu', new=AsyncMock(return_value=self.page)), \
                patch('plan_selection.plan_scope', new=AsyncMock(return_value=self.page)):
            button, pending = await select_plan(self.page, 'pro-500', lambda *_args, **_kwargs: None,
                                               allow_checkout_tier=True)
            await verify_selected_plan(self.page, 'pro-500', checkout_tier_pending=pending)
        self.assertTrue(pending)
        self.assertEqual(button.nodes, [self.page.entry])
        self.assertEqual(self.page.entry.clicks, 0)
        self.assertEqual(await self.page.get_by_role('radio').count(), 0)

    async def test_top_half_card_direct_parent_owned_sibling_cta_is_allowed(self):
        # Official card marker owns the title; its immediate wrapper owns one CTA.
        self.page.card.children.remove(self.page.entry)
        self.page.overview.children.append(self.page.entry)
        self.page.entry.parent = self.page.overview
        with patch.object(Selection, 'open_menu', new=AsyncMock(return_value=self.page)), \
                patch('plan_selection.plan_scope', new=AsyncMock(return_value=self.page)):
            button, pending = await select_plan(self.page, 'pro-500', lambda *_args, **_kwargs: None,
                                               allow_checkout_tier=True)
            await verify_selected_plan(self.page, 'pro-500', checkout_tier_pending=pending)
        self.assertTrue(pending)
        self.assertEqual(button.nodes, [self.page.entry])
        self.assertEqual(self.page.entry.clicks, 0)

    async def test_top_half_card_parent_extra_heading_button_radio_or_group_is_rejected(self):
        self.page.card.children.remove(self.page.entry)
        self.page.overview.children.append(self.page.entry)
        self.page.entry.parent = self.page.overview
        for extra in (Node('heading', '账单说明'), Node('heading', 'Plus'), Node('button', '其他操作'),
                      Node('radio', '最高使用额度', native_checked=False), Node('radiogroup', 'Other tiers')):
            with self.subTest(role=extra.role, label=extra.text):
                extra.parent = self.page.overview
                self.page.overview.children.append(extra)
                with patch.object(Selection, 'open_menu', new=AsyncMock(return_value=self.page)), \
                        self.assertRaises(Stop) as blocked:
                    await select_plan(self.page, 'pro-500', lambda *_args, **_kwargs: None,
                                      allow_checkout_tier=True)
                self.assertEqual(blocked.exception.report['reason'], 'official_plan_option_not_found')
                self.page.overview.children.remove(extra)
        self.assertEqual(self.page.entry.clicks, 0)

    async def test_pending_only_allows_lite_or_exact_target_with_matched_account(self):
        guard = self.guard()
        guard.begin_checkout()
        headers = {'authorization': 'Bearer ' + self.target.old_token}
        for plan, expected in (('chatgptprolite', 'create'), ('chatgptpromax', 'create'),
                ('chatgptpro', 'plan_mismatch'), ('chatgptplusplan', 'plan_mismatch'),
                ('chatgptgoplan', 'plan_mismatch'), ('invented-plan', 'unknown_write')):
            with self.subTest(plan=plan):
                self.assertEqual(guard.classify('POST', 'https://chatgpt.com' + CHECKOUT_PATH,
                    {'plan_name': plan}, headers), expected)
        for changed in ({}, {'authorization': 'Bearer ' + credential('other-account').old_token},
                {**headers, 'chatgpt-account-id': 'other-account'}):
            with self.subTest(headers=tuple(changed)):
                self.assertEqual(guard.classify('POST', 'https://chatgpt.com' + CHECKOUT_PATH,
                    {'plan_name': 'chatgptprolite'}, changed), 'account_mismatch')

    async def test_no_pending_never_allows_initial_lite_for_max_target(self):
        guard = self.guard(pending=False)
        guard.begin_checkout()
        self.assertEqual(guard.classify('POST', 'https://chatgpt.com' + CHECKOUT_PATH,
            {'plan_name': 'chatgptprolite'}, {'authorization': 'Bearer ' + self.target.old_token}), 'plan_mismatch')

    async def test_pending_preparation_requires_original_verified_unattempted_target(self):
        guard = NetworkGuard(self.target, self.ledger())
        guard.account_verified = True
        for key, value in (('account_verified', False), ('target_plan', 'plus'),
                ('target_plan', 'pro-20x'), ('armed', True), ('sent', 1), ('checkout_id', CS)):
            with self.subTest(key=key, value=value):
                original = getattr(guard, key)
                setattr(guard, key, value)
                with self.assertRaises(Stop) as blocked:
                    guard.prepare_first_pro_checkout(tier_pending=True, current_plan='free')
                self.assertEqual(blocked.exception.report['reason'], 'checkout_unarmed')
                setattr(guard, key, original)

    async def test_initial_lite_response_records_initial_plan_separately_from_max_target(self):
        guard = self.guard()
        await self.create(guard)
        self.assertEqual(guard.sent, 1)
        self.assertEqual(guard.checkout_id, CS)
        self.assertEqual(guard.ledger.record['checkout_plan'], 'pro-5x')
        self.assertEqual(guard.ledger.record['target_plan'], 'pro-500')
        self.assertEqual(guard.ledger.record['plan'], 'chatgptpromax')
        persisted = guard.ledger.path.read_text()
        self.assertNotIn(self.target.old_token, persisted)
        self.assertNotIn('authorization', persisted)

    async def test_second_checkout_is_rejected_even_after_guard_disarmed(self):
        guard = self.guard()
        await self.create(guard)
        guard.armed = False
        guard.observe_request(Request(self.target, plan='chatgptpromax'))
        self.assertEqual(guard.sent, 2)
        self.assertEqual(guard.error.report['reason'], 'checkout_result_unknown')
        with self.assertRaises(Stop):
            await select_checkout_tier(self.page, guard, 'pro-500', allow_change=True)
        self.assertEqual(self.page.radios[2].clicks, 0)

    async def test_native_checked_script_runs_and_php_usage_selects_max(self):
        self.page.show_checkout()
        await Locator([self.page.radios[2]]).click()
        self.assertEqual(await checkout_radio_plan(Locator([self.page.group]), strict=True), 'pro-500')
        self.page.radios[2].text = 'PHP 500.00'
        with self.assertRaises(Stop):
            await checkout_radio_plan(Locator([self.page.group]), strict=True)

    async def test_native_and_aria_conflict_or_multiple_selection_fails_before_click(self):
        guard = self.guard()
        await self.create(guard)
        self.page.radios[0].attrs['aria-checked'] = 'false'
        with self.assertRaises(Stop) as blocked:
            await select_checkout_tier(self.page, guard, 'pro-500', allow_change=True)
        self.assertEqual(blocked.exception.report['reason'], 'selected_plan_changed')
        self.page.radios[0].attrs.pop('aria-checked')
        self.page.radios[1].native_checked = True
        self.page.radios[1].attrs['data-state'] = 'checked'
        with self.assertRaises(Stop) as blocked:
            await select_checkout_tier(self.page, guard, 'pro-500', allow_change=True)
        self.assertEqual(blocked.exception.report['reason'], 'selected_plan_changed')
        self.assertEqual(self.page.radios[2].clicks, 0)
        self.assertFalse(guard.checkout_tier_verified)

    async def test_legacy_aria_selection_is_supported_but_unknown_state_is_not(self):
        rows = [{'label': 'PHP 999.00\n最高使用额度', 'checked': 'true', 'native_checked': None, 'state': 'checked'}]
        self.assertEqual(pro_radio_plan(rows), 'pro-500')
        for changed in ({'checked': 'mixed'}, {'state': 'unchecked'}, {'native_checked': 1}):
            with self.subTest(changed=changed):
                self.assertIsNone(pro_radio_plan([{**rows[0], **changed}]))

    async def test_same_checkout_tier_update_requires_new_quote_request_binding_for_cta(self):
        guard = self.guard(payment=True)
        await self.create(guard)
        await self.quote_binding(guard)
        await select_checkout_tier(self.page, guard, 'pro-500', allow_change=True)
        self.assertEqual((guard.checkout_tier_binding_minimum, guard.checkout_tier_request_minimum), (2, 2))
        self.assertEqual(self.page.radios[2].clicks, 1)
        self.assertTrue(guard.checkout_tier_verified)
        self.assertFalse(guard.checkout_tier_pending)
        with self.assertRaises(Stop) as blocked:
            await subscribe_button(self.page, first_pro_context=guard)
        self.assertEqual(blocked.exception.report['reason'], 'payment_quote_not_ready')
        await self.quote_binding(guard, 'update', amount=2799900)
        button = await subscribe_button(self.page, first_pro_context=guard)
        self.assertEqual(button.nodes, [self.page.submit])
        self.assertEqual(guard.checkout_id, CS)
        self.assertEqual(guard.sent, 1)
        self.assertEqual(self.page.submit.clicks, 0)
        self.assertTrue(guard.ledger.record['checkout_tier_verified'])

    async def test_inspection_readonly_and_existing_payment_never_change_tier(self):
        guard = self.guard(payment=True)
        await self.create(guard)
        with self.assertRaises(Stop) as blocked:
            await select_checkout_tier(self.page, guard, 'pro-500')
        self.assertEqual(blocked.exception.report['reason'], 'checkout_tier_not_verified')
        guard.read_only = True
        with self.assertRaises(Stop) as blocked:
            await select_checkout_tier(self.page, guard, 'pro-500', allow_change=True)
        self.assertEqual(blocked.exception.report['reason'], 'checkout_tier_not_verified')
        guard.read_only = False
        guard.payment_ledger = SimpleNamespace(record={'payment_attempted': True})
        with self.assertRaises(Stop) as blocked:
            await select_checkout_tier(self.page, guard, 'pro-500', allow_change=True)
        self.assertEqual(blocked.exception.report['reason'], 'checkout_tier_not_verified')
        self.assertFalse(guard.checkout_tier_verified)
        self.assertEqual(self.page.radios[2].clicks, 0)

    async def test_old_quote_request_version_is_rejected_before_dom_quote_read(self):
        guard = self.guard(payment=True)
        await self.create(guard)
        await self.quote_binding(guard)
        await select_checkout_tier(self.page, guard, 'pro-500', allow_change=True)
        guard.official_binding_version = guard.checkout_tier_binding_minimum
        with patch('pay.quote_from_page', new=AsyncMock(return_value=QUOTE)) as read:
            self.assertIsNone(await verified_quote_once(self.page, guard))
            read.assert_not_awaited()
            guard.official_quote_binding_request_version = guard.checkout_tier_request_minimum
            guard.official_quote_binding = {'currency': 'PHP', 'amount_minor': 2799900, 'tax_minor': 0}
            self.assertEqual(await verified_quote_once(self.page, guard), QUOTE)
            read.assert_awaited_once()

    async def test_changed_checkout_after_radio_click_is_rejected(self):
        guard = self.guard()
        await self.create(guard)
        original = self.page.radios[2].on_click
        async def change_checkout():
            await original()
            self.page.show_checkout('cs_other_synthetic')
        self.page.radios[2].on_click = change_checkout
        with self.assertRaises(Stop) as blocked:
            await select_checkout_tier(self.page, guard, 'pro-500', allow_change=True)
        self.assertEqual(blocked.exception.report['reason'], 'checkout_page_identifier_unverified')
        self.assertFalse(guard.checkout_tier_verified)
        self.assertEqual(self.page.submit.clicks, 0)

    async def test_duplicate_creation_during_tier_update_is_rejected(self):
        guard = self.guard()
        await self.create(guard)
        original = self.page.radios[2].on_click
        async def duplicate_checkout():
            await original()
            guard.observe_request(Request(self.target, plan='chatgptpromax'))
        self.page.radios[2].on_click = duplicate_checkout
        with self.assertRaises(Stop) as blocked:
            await select_checkout_tier(self.page, guard, 'pro-500', allow_change=True)
        self.assertEqual(blocked.exception.report['reason'], 'checkout_result_unknown')
        self.assertFalse(guard.checkout_tier_verified)
        self.assertEqual(self.page.submit.clicks, 0)

    async def test_upgrade_cta_requires_first_pro_context_and_subscribe_remains_supported(self):
        self.page.show_checkout()
        with self.assertRaises(Stop) as blocked:
            await subscribe_button(self.page)
        self.assertEqual(blocked.exception.report['reason'], 'official_subscribe_button_not_ready')
        for label in ('Subscribe', '订阅', '訂閱'):
            with self.subTest(label=label):
                self.page.submit.text = label
                self.assertEqual((await subscribe_button(self.page)).nodes, [self.page.submit])
        self.assertEqual(self.page.submit.clicks, 0)

    async def test_synthetic_workflow_creates_once_updates_same_checkout_and_never_pays(self):
        context = Context(self.page)
        guards = []
        def factory(target, ledger):
            guard = PaymentGuard(target, checkout_ledger=ledger)
            guards.append(guard)
            return guard
        async def initial_checkout():
            request = Request(self.target)
            await context.emit('request', request)
            await context.emit('response', Response(request, {'checkout_session_id': CS,
                'processor_entity': 'openai_ie', 'billing_details': {'currency': 'PHP', 'country': 'PH'}}))
            self.page.show_checkout()
            await self.quote_binding(guards[0])
            initial = await quote_from_page(self.page)
            self.assertEqual(initial['plan'], 'pro-5x')
            self.assertEqual(initial['today']['amount_minor'], 559900)
        self.page.entry.on_click = initial_checkout
        original = self.page.radios[2].on_click
        async def update_checkout():
            await original()
            await self.quote_binding(guards[0], 'update', amount=2799900)
        self.page.radios[2].on_click = update_checkout
        identity = {'session_status': 'verified', 'account_matched': True, 'current_plan': 'free'}
        async def inspect_cta(page, guard, _identity, _quote):
            parsed = await verified_quote_once(page, guard)
            self.assertIsNotNone(parsed)
            self.assertEqual(parsed['plan'], 'pro-500')
            self.assertEqual(parsed['today'], QUOTE['today'])
            self.assertEqual(parsed['tax'], QUOTE['tax'])
            self.assertEqual(parsed['renewal'], QUOTE['renewal'])
            self.assertEqual(parsed['renewal_interval'], 'monthly')
            self.assertEqual(parsed['source'], 'official_checkout_visible_text')
            self.assertEqual(parsed['plan_source'], 'official_checkout_selected_radio')
            self.assertEqual((await subscribe_button(page, first_pro_context=guard)).nodes, [self.page.submit])
            return {'synthetic_cta_ready': True}
        ledger = self.ledger()
        with patch.object(Selection, 'open_menu', new=AsyncMock(return_value=self.page)), \
                patch('plan_selection.plan_scope', new=AsyncMock(return_value=self.page)), \
                patch('browser_checkout.check_session', new=AsyncMock(return_value=(self.target, identity))), \
                patch.dict('os.environ', {'AUTO_RECHARGE_CALLBACK_URL': ''}):
            result = await workflow(context, self.target, ledger=ledger, target_plan='pro-500',
                                    guard_factory=factory, quote_handler=inspect_cta,
                                    allow_checkout_tier_change=True)
        self.assertEqual(result.get('status'), 'checkout_quote_verified', result)
        self.assertTrue(result['synthetic_cta_ready'])
        self.assertEqual(result['checkout_identifier'], CS)
        self.assertEqual(result['checkout_requests_sent'], 1)
        self.assertEqual(result['payment_requests_sent'], 0)
        self.assertEqual(result['checkout_plan'], 'pro-5x')
        self.assertEqual(result['target_plan'], 'pro-500')
        self.assertEqual(result['quote']['today'], QUOTE['today'])
        self.assertEqual(result['quote']['plan_source'], 'official_checkout_selected_radio')
        self.assertEqual(self.page.quote_reads[0], (0, '5599.00', CHECKOUT_URL))
        self.assertTrue(all(state == (2, '27999.00', CHECKOUT_URL) for state in self.page.quote_reads[1:]))
        self.assertEqual(ledger.record['checkout_plan'], 'pro-5x')
        self.assertEqual(ledger.record['target_plan'], 'pro-500')
        self.assertEqual(self.page.entry.clicks, 1)
        self.assertEqual(self.page.radios[2].clicks, 1)
        self.assertEqual(self.page.submit.clicks, 0)


class PostPaymentFeedbackTests(unittest.IsolatedAsyncioTestCase):
    """真实付款控制层与可信假帧；不启动浏览器、发请求或解题。"""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / 'state'
        self.target, self.page = credential(), Page()
        self.page.show_checkout()
        self.page.main_frame = SimpleNamespace(url=CHECKOUT_URL)
        self.page.frames = [self.page.main_frame]
        Context(self.page)
        with AttemptLedger(self.state, self.target.account_id, target_plan='pro-500') as ledger:
            ledger.begin()
            ledger.finish({'checkout_identifier': CS, 'processor_entity': 'openai_ie',
                           'returned_currency': 'PHP', 'checkout_outcome': 'created'})
        self.checkout_path = checkout_record_path(self.state, self.target.account_id, 'pro-500')
        self.checkout_before = self.checkout_path.read_bytes()

    def captcha(self, *, visible=True, trusted=True, parent=None, checked=False):
        element = SimpleNamespace(is_visible=AsyncMock(return_value=visible),
                                  bounding_box=AsyncMock(return_value={'x': 0, 'y': 0, 'width': 300, 'height': 250}))
        frame = SimpleNamespace(url=('https://newassets.hcaptcha.com/challenge' if trusted
                                     else 'https://untrusted.example.invalid/challenge'),
                                parent_frame=parent or self.page.main_frame,
                                locator=lambda _selector: SimpleNamespace(count=AsyncMock(return_value=int(checked))),
                                frame_element=AsyncMock(return_value=element))
        self.page.frames.append(frame)
        return frame

    def error(self, *, visible=True):
        node = Node(text='我们未能验证您的支付方式。请选择另一支付方式并重试。')
        node.visible = visible
        self.page.checkout.children.append(node)
        return node

    def guard(self, *, attempted=True):
        ledger = self.enterContext(PaymentLedger(self.state, self.target.account_id, target_plan='pro-500'))
        if attempted:
            ledger.begin(QUOTE, confirmed_digest=quote_digest(QUOTE), card_last4='4242')
            ledger.mark_confirmation_sent()
        guard = PaymentGuard(self.target, ledger)
        guard.account_verified, guard.checkout_id = True, CS
        return guard, ledger

    async def flow(self, mode='captcha'):
        from test_payment import details
        callbacks, ticks = [], [0.0]
        with PaymentLedger(self.state, self.target.account_id, target_plan='pro-500') as ledger:
            guard = PaymentGuard(self.target, ledger)
            guard.account_verified, guard.checkout_id = True, CS
            guard.official_quote_binding = {'amount_minor': 2799900, 'currency': 'PHP', 'tax_minor': 0}
            guard.official_binding_version = 1
            request = Request(self.target, url='https://api.stripe.com/v1/payment_pages/' + CS + '/confirm', data={})
            async def submitted():
                guard.observe_request(request)
                if mode == 'page_failure':
                    self.error()
                elif mode == 'declined':
                    await guard.response(Response(request, {'error': {'code': 'incorrect_number'}}))
                elif mode in {'action', 'bank', 'unsupported'}:
                    guard.payment_state = 'requires_action'
                    if mode == 'bank':
                        guard.three_ds.status = 'awaiting_user'
                    elif mode == 'unsupported':
                        guard.three_ds.status = 'unsupported'
                else:
                    self.captcha()
            self.page.submit.on_click = submitted
            async def tick(seconds):
                ticks[0] += max(seconds, .01)
                if mode == 'gone':
                    self.page.frames = [self.page.main_frame]
                elif mode == 'paid':
                    await guard.response(Response(request, {'object': 'checkout.session', 'session_id': CS,
                        'status': 'complete', 'payment_status': 'paid', 'amount_total': 2799900, 'currency': 'php'}))
            async def identity(*_args):
                return {'account_matched': True, 'current_plan': 'promax' if guard.evidence else 'free'}
            with patch('pay.current_quote', AsyncMock(return_value=QUOTE)), \
                    patch('pay.verified_quote_once', AsyncMock(return_value=QUOTE)), \
                    patch('pay.fill_official_form', AsyncMock(return_value={
                        'card_fields_filled': True, 'billing_fields_filled': []})), \
                    patch('pay.verify_card_fields', AsyncMock()), patch('pay.verify_billing_fields', AsyncMock()), \
                    patch('pay.subscribe_button', AsyncMock(return_value=Locator([self.page.submit]))), \
                    patch('pay.verify_identity_again', AsyncMock(side_effect=identity)), \
                    patch('pay.progress', side_effect=lambda stage, **data: callbacks.append({'stage': stage, **data})), \
                    patch('pay.time', SimpleNamespace(monotonic=lambda: ticks[0])), \
                    patch('pay.asyncio.sleep', AsyncMock(side_effect=tick)), \
                    patch.dict('os.environ', {'AUTO_RECHARGE_CALLBACK_URL': ''}):
                result = await payment_handler(self.page, guard, {'current_plan': 'free'}, ledger, self.target,
                    pay=True, details_reader=details, confirmer=lambda *_args: True,
                    wait_seconds=1, poll_count=1, poll_interval=0)
            result.update(guard.summary())
            result.update(account_matched=True, checkout_identifier=CS)
            result = include_payment_record(result, ledger)
            self.assertEqual(guard.confirmation_sent, 1)
            self.assertEqual(ledger.record['confirmation_requests_sent'], 1)
            self.assertEqual(self.page.submit.clicks, 1)
            self.assertEqual(guard.sent, 0)
            self.assertEqual(self.page.url, CHECKOUT_URL)
            self.assertEqual(self.checkout_path.read_bytes(), self.checkout_before)
            self.assertEqual(result['repeated_payment'], 'blocked')
            self.last_observation_seconds = ticks[0]
            return result, callbacks

    async def test_local_captcha_wait_reports_original_quote_and_retains_unknown_lock(self):
        result, callbacks = await self.flow()
        awaiting = [value for value in callbacks if value['stage'] == 'payment_human_verification']
        self.assertEqual(len(awaiting), 1)
        self.assertEqual(awaiting[0]['quote'], QUOTE)
        self.assertEqual(awaiting[0]['payment_requests_sent'], 1)
        self.assertEqual(awaiting[0]['confirmation_requests_sent'], 1)
        self.assertEqual(awaiting[0]['reason'], 'payment_hcaptcha_required')
        self.assertTrue(awaiting[0]['user_action_required'])
        self.assertEqual(result['status'], 'verification_required')
        self.assertEqual(result['payment_status'], 'unknown')
        self.assertEqual(result['reason'], 'payment_hcaptcha_required')
        merged = merged_confirmation_callbacks(QUOTE, {'reason': None, 'user_action_required': False}, result)
        self.assertEqual(merged['finished']['reason'], 'payment_hcaptcha_required')
        self.assertTrue(merged['finished']['user_action_required'])
        import bitbrowser_connector as connector
        completed = connector.CompletedJob(SimpleNamespace(id='synthetic', result=result,
            finished_callback_acknowledged=True, resolution_committed=False), 0)
        self.assertEqual(completed.state()['result']['reason'], 'payment_hcaptcha_required')
        self.assertTrue(completed.state()['result']['user_action_required'])
        with PaymentLedger(self.state, self.target.account_id, target_plan='pro-500') as ledger:
            with self.assertRaises(Stop):
                ledger.assert_unattempted()

    async def test_completed_captcha_clears_old_prompt_without_retrying_unknown_payment(self):
        result, callbacks = await self.flow('gone')
        awaiting = next(value for value in callbacks if value['stage'] == 'payment_human_verification')
        self.assertEqual(result['status'], 'payment_result_unknown')
        self.assertIsNone(result['reason'])
        self.assertFalse(result['user_action_required'])
        merged = merged_confirmation_callbacks(QUOTE, awaiting, result)
        self.assertIsNone(merged['finished']['reason'])
        self.assertFalse(merged['finished']['user_action_required'])

    async def test_paid_evidence_after_captcha_clears_prompt_and_has_no_second_confirm(self):
        result, callbacks = await self.flow('paid')
        self.assertEqual(result['status'], 'subscription_activated', result)
        self.assertEqual(result['payment_status'], 'paid')
        self.assertIsNone(result['reason'])
        self.assertFalse(result['user_action_required'])
        awaiting = next(value for value in callbacks if value['stage'] == 'payment_human_verification')
        merged = merged_confirmation_callbacks(QUOTE, awaiting, result)
        self.assertEqual(merged['finished']['payment_status'], 'paid')
        self.assertIsNone(merged['finished']['reason'])
        # workflow removes its transient reason on paid; the payment record projection restores an explicit clear.
        without_reason = dict(result)
        without_reason.pop('reason')
        with PaymentLedger(self.state, self.target.account_id, target_plan='pro-500') as ledger:
            projected = include_payment_record(without_reason, ledger)
        self.assertIsNone(projected['reason'])

    async def test_page_failure_is_advisory_unknown_and_keeps_original_payment_lock(self):
        result, _callbacks = await self.flow('page_failure')
        self.assertEqual(result['status'], 'payment_result_unknown')
        self.assertEqual(result['payment_status'], 'unknown')
        self.assertEqual(result['reason'], 'official_payment_method_verification_failed')
        self.assertIsNone(result.get('payment_failure_reason'))
        clean = sanitized_document(result)
        self.assertEqual(clean['reason'], 'official_payment_method_verification_failed')
        self.assertNotIn('payment_failure_reason', clean)
        with PaymentLedger(self.state, self.target.account_id, target_plan='pro-500') as ledger:
            with self.assertRaises(Stop):
                ledger.assert_unattempted()

    async def test_real_decline_does_not_become_human_verification(self):
        result, callbacks = await self.flow('declined')
        self.assertEqual(result['status'], 'payment_failed', result)
        self.assertEqual(result['payment_status'], 'declined')
        self.assertEqual(result['payment_failure_reason'], 'incorrect_number')
        self.assertFalse(any(item['stage'] == 'payment_human_verification' for item in callbacks))

    async def test_hidden_untrusted_checked_and_foreign_ancestry_frames_do_not_prompt(self):
        guard, _ledger = self.guard()
        for values in ({'visible': False}, {'trusted': False}, {'checked': True},
                       {'parent': SimpleNamespace(url='https://untrusted.example.invalid/',
                                                  parent_frame=self.page.main_frame)}):
            with self.subTest(values=list(values)):
                self.page.frames = [self.page.main_frame]
                self.captcha(**values)
                self.assertEqual(await original_payment_feedback(self.page, guard), {})

    async def test_unverified_account_and_changed_checkout_cannot_supply_page_reason(self):
        guard, ledger = self.guard()
        self.error()
        self.captcha()
        for url in ('https://chatgpt.com/checkout/openai_ie/cs_another',
                    'https://untrusted.example.invalid/' + CS, 'http://chatgpt.com/checkout/openai_ie/' + CS,
                    'https://chatgpt.com/not-checkout/' + CS):
            with self.subTest(url=url):
                self.page.url = url
                self.assertEqual(await original_payment_feedback(self.page, guard), {})
        self.page.url = CHECKOUT_URL
        guard.account_verified = False
        self.assertEqual(await original_payment_feedback(self.page, guard), {})
        guard.account_verified = True
        ledger.record['checkout_identifier'] = 'cs_another'
        self.assertEqual(await original_payment_feedback(self.page, guard), {})

    async def test_page_change_during_observation_and_paid_receipt_override_visible_error(self):
        guard, _ledger = self.guard()
        error = self.error()
        original = self.page.get_by_text
        def changed(text, **kwargs):
            value = original(text, **kwargs)
            async def visible():
                self.page.url = 'https://chatgpt.com/checkout/openai_ie/cs_another'
                return True
            value.is_visible = visible
            return value
        with patch.object(self.page, 'get_by_text', changed):
            self.assertEqual(await original_payment_feedback(self.page, guard), {})
        self.page.url = CHECKOUT_URL
        def paid_during_read(text, **kwargs):
            value = original(text, **kwargs)
            async def visible():
                guard.payment_state, guard.evidence = 'paid', {'kind': 'checkout_session'}
                return True
            value.is_visible = visible
            return value
        with patch.object(self.page, 'get_by_text', paid_during_read):
            self.assertEqual(await original_payment_feedback(self.page, guard), {})
        guard.payment_state, guard.evidence = 'paid', {'kind': 'checkout_session'}
        self.assertEqual(await original_payment_feedback(self.page, guard), {})
        guard.payment_state, guard.evidence = 'unknown', None
        error.visible = False
        self.assertEqual(await original_payment_feedback(self.page, guard), {})

    async def test_network_requires_action_does_not_claim_visible_captcha(self):
        guard, _ledger = self.guard()
        guard.payment_state = 'requires_action'
        feedback = await original_payment_feedback(self.page, guard)
        self.assertEqual(feedback['reason'], 'verification_required')
        self.assertTrue(feedback['user_action_required'])
        self.assertEqual(guard.three_ds.status, 'not_required')

    async def test_bank_and_unsupported_network_actions_do_not_enter_captcha_wait_branch(self):
        for mode in ('action', 'bank', 'unsupported'):
            with self.subTest(mode=mode):
                # Each case has its own original checkout marker and payment lock.
                previous = self.state
                self.state = previous / mode
                with AttemptLedger(self.state, self.target.account_id, target_plan='pro-500') as marker:
                    marker.begin()
                    marker.finish({'checkout_identifier': CS, 'processor_entity': 'openai_ie',
                                   'returned_currency': 'PHP', 'checkout_outcome': 'created'})
                self.checkout_path = checkout_record_path(self.state, self.target.account_id, 'pro-500')
                self.checkout_before = self.checkout_path.read_bytes()
                self.page.submit.clicks = 0
                result, callbacks = await self.flow(mode)
                self.assertEqual(result['status'], 'verification_required')
                self.assertTrue(result['user_action_required'])
                self.assertFalse(any(item['stage'] == 'payment_human_verification' for item in callbacks))
                self.assertNotEqual(result['reason'], 'payment_hcaptcha_required')
                self.assertLessEqual(self.last_observation_seconds, 1)
                if mode == 'unsupported':
                    self.assertEqual(self.last_observation_seconds, 0)
                self.state = previous

    async def test_readonly_recheck_reports_original_verification_or_page_error_without_new_payment(self):
        guard, ledger = self.guard()
        ledger.update(payment_status='requires_action')
        self.error()
        context = self.page.context
        context.new_page = AsyncMock(return_value=self.page)
        async def goto(url, **_kwargs):
            self.page.url = url
        self.page.goto = goto
        identity = {'account_matched': True, 'current_plan': 'free', 'session_status': 'verified'}
        with patch('payment_recovery.check_session', AsyncMock(return_value=(self.target, identity))), \
                patch('pay.verify_identity_again', AsyncMock(return_value=identity)), \
                patch('pay.verified_quote_once', AsyncMock(return_value=QUOTE)):
            result = await recheck_in_context(context, self.target, ledger, timeout=.001)
        self.assertEqual(result['reason'], 'official_payment_method_verification_failed')
        self.assertEqual(result['status'], 'verification_required')
        self.assertEqual(result['payment_status'], 'requires_action')
        self.assertTrue(result['recheck_only'])
        self.assertEqual(result['payment_requests_sent'], 0)
        self.assertEqual(result['checkout_requests_sent'], 0)
        self.assertEqual(self.page.submit.clicks, 0)
        self.assertEqual(ledger.record['confirmation_requests_sent'], 1)
        self.assertEqual(self.checkout_path.read_bytes(), self.checkout_before)
        self.assertFalse(result['user_action_required'])
        self.page.checkout.children.pop()
        with patch('payment_recovery.check_session', AsyncMock(return_value=(self.target, identity))), \
                patch('pay.verify_identity_again', AsyncMock(return_value=identity)), \
                patch('pay.verified_quote_once', AsyncMock(return_value=QUOTE)):
            result = await recheck_in_context(context, self.target, ledger, timeout=.001)
        self.assertEqual(result['reason'], 'verification_required')
        self.assertTrue(result['user_action_required'])
        self.assertEqual(guard.confirmation_sent, 0)
        self.captcha()
        with patch('payment_recovery.check_session', AsyncMock(return_value=(self.target, identity))), \
                patch('pay.verify_identity_again', AsyncMock(return_value=identity)), \
                patch('pay.verified_quote_once', AsyncMock(return_value=QUOTE)):
            result = await recheck_in_context(context, self.target, ledger, timeout=.001)
        self.assertEqual(result['reason'], 'payment_hcaptcha_required')
        self.assertTrue(result['user_action_required'])
        merged = merged_confirmation_callbacks(QUOTE, {'reason': None, 'user_action_required': False}, result)
        self.assertEqual(merged['finished']['reason'], 'payment_hcaptcha_required')
        self.assertEqual(merged['finished']['payment_requests_sent'], 0)


if __name__ == '__main__':
    unittest.main()
