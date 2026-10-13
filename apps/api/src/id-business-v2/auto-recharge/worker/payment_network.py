"""监听原官网结算与付款结果；自动操作由任务控制层授权。"""
from __future__ import annotations

import asyncio
import json
import re
from urllib.parse import parse_qs, urlsplit

from browser_checkout import NetworkGuard, progress
from checkout_core import MAX_BYTES, Stop, safe_text
from payment_state import payment_evidence
from payment_3ds import ThreeDSAuthentication, AUTH_PATHS, checkout_resource_url
from upgrade_authentication import AuthenticationReceipts, response_body
from types import SimpleNamespace


class PaymentGuard(NetworkGuard):
    def __init__(self, target, payment_ledger=None, checkout_ledger=None, target_plan=None):
        super().__init__(target, checkout_ledger)
        self.payment_ledger = payment_ledger
        self.target_plan = (payment_ledger.target_plan if payment_ledger else target_plan
                            or getattr(checkout_ledger, "target_plan", "plus"))
        self.approved = False
        self.confirmation_sent = 0
        self.confirmation_reserved = False
        self.tokenization_sent = 0
        self.linked_intent = None
        self.evidence = None
        self.payment_state = "not_attempted"
        self.payment_error = None
        self.payment_done = asyncio.Event()
        self.quote = None
        self.confirm_request = None
        self.token_request = None
        self.validate_before_confirm = None
        self.read_only = False
        self.persistence_error = False
        self.payment_http_status = None
        self.official_quote_binding = None
        self.official_binding_version = 0
        self.three_ds = ThreeDSAuthentication()
        self.three_ds_ready = asyncio.Event()
        self.three_ds_closed = False
        self.observed_requests = set()
        self.quote_requests = {}
        self.quote_request_version = 0
        self.authentication_receipts = AuthenticationReceipts()
        self.settling = False
        self.observations_closed = False
        self.deferred_observation = {}

    def finish_three_ds(self):
        self.three_ds_closed = True
        self.three_ds.close()

    def attach_payment_ledger(self, ledger):
        if self.payment_ledger is not None or ledger.target_plan != self.target_plan:
            raise Stop("payment_ledger_attachment_invalid")
        self.payment_ledger = ledger

    def persist_observation(self, **updates):
        """磁盘故障不能抹掉刚收到的付款凭据，也不能重新开放付款。"""
        if self.settling:
            self.deferred_observation.update(updates)
            return
        try:
            if self.payment_ledger is None:
                raise Stop("payment_record_required")
            self.payment_ledger.update(payment_status=self.payment_state, evidence=self.evidence,
                                       reason=self.payment_error, **updates)
        except (OSError, Stop):
            self.persistence_error = True
            progress("payment_record_write_failed", repeated_payment="blocked")

    def flush_observation(self):
        if self.payment_ledger is None or not self.payment_ledger.record:
            return
        try:
            self.payment_ledger.update(payment_status=self.payment_state, evidence=self.evidence,
                reason=self.payment_error, **self.deferred_observation)
        except (OSError, Stop):
            self.persistence_error = True
        self.deferred_observation.clear()

    def approve(self, quote):
        if (self.payment_ledger is None or not self.account_verified
                or self.checkout_id != self.payment_ledger.checkout_id):
            raise Stop("payment_account_or_order_unverified")
        if not self.payment_ledger.record or not self.payment_ledger.record.get("payment_attempted"):
            raise Stop("payment_marker_required")
        if quote.get("plan") != self.target_plan:
            raise Stop("payment_quote_plan_mismatch")
        self.quote = quote
        self.approved = True
        self.payment_state = "unknown"

    def observe_request(self, request):
        if request in self.observed_requests:
            return
        super().observe_request(request)
        p = urlsplit(request.url)
        if p.scheme != "https" or p.hostname != "api.stripe.com" or not self.checkout_id:
            return
        base = f"/v1/payment_pages/{self.checkout_id}"
        if p.path in {base, base + "/init", base + "/update"} and self.account_verified:
            self.quote_request_version += 1
            self.quote_requests[request] = self.quote_request_version
            self.official_quote_binding = None
            self.checkout_initializations_allowed += int(p.path == base + "/init")
        if (self.read_only or self.operation_cancelled() or not self.payment_ledger
                or not (self.payment_ledger.record or {}).get("payment_attempted")):
            return
        if request.method == "POST" and p.path == "/v1/payment_methods":
            self.tokenization_sent += 1
            self.token_request = request
        if request.method == "POST" and p.path == base + "/confirm":
            self.confirmation_sent += 1
            self.confirmation_reserved = True
            if self.confirm_request is None:
                self.confirm_request = request
                try:
                    self.payment_ledger.mark_confirmation_sent()
                except (OSError, Stop):
                    self.persistence_error = True
            else:
                self.payment_error = "official_payment_evidence_not_observed"
            progress("payment_request_sending", attempt=self.confirmation_sent)

    async def observe_authentication_request(self, request):
        if request in self.three_ds.requests:
            return True
        if self.read_only or self.three_ds_closed or self.confirmation_sent != 1:
            return False
        parsed = urlsplit(request.url)
        if (parsed.hostname == "api.stripe.com" and parsed.path in AUTH_PATHS
                and not self.three_ds_ready.is_set()):
            try:
                await asyncio.wait_for(self.three_ds_ready.wait(), timeout=5)
            except asyncio.TimeoutError:
                return False
        if self.payment_state != "requires_action":
            return False
        verified = await self.three_ds.decision(request, self.target, self.checkout_id)
        if verified is False:
            self.three_ds.requests.pop(request, None)
        return verified

    async def route(self, route):
        self.observe_request(route.request)
        await route.fallback()

    async def response(self, response):
        if self.observations_closed:
            return
        self.observe_request(response.request)
        p = urlsplit(response.url)
        authentication_candidate = (self.confirmation_sent == 1 and p.scheme == 'https'
            and p.hostname == 'api.stripe.com' and p.path in AUTH_PATHS
            and response.request.method == 'POST')
        if not authentication_candidate:
            await super().response(response)
        await self.three_ds.observe_redirect(response)
        if self.observations_closed:
            return
        if p.scheme != "https" or p.hostname != "api.stripe.com" or not self.checkout_id:
            return
        initialization = response.request in self.quote_requests and self.account_verified
        confirmation = response.request is self.confirm_request
        authentication = self.three_ds.requests.get(response.request) in AUTH_PATHS
        linked_read = (self.linked_intent and response.request.method == "GET"
                       and p.path == f"/v1/payment_intents/{self.linked_intent}")
        if not (initialization or confirmation or linked_read or authentication_candidate or authentication or response.request is self.token_request):
            return
        try:
            raw = await response_body(response, self)
            if len(raw) > MAX_BYTES:
                if authentication:
                    self.three_ds.reject()
                    self.payment_error = 'payment_response_not_verified'
                    self.payment_done.set()
                return
            data = json.loads(raw)
            if not isinstance(data, dict):
                if authentication:
                    self.three_ds.reject()
                    self.payment_error = 'payment_response_not_verified'
                    self.payment_done.set()
                return
            if authentication_candidate:
                if not self.authentication_receipts.binding.intent_id:
                    self.authentication_receipts.capture(response.request, response.status, data, len(raw))
                    return
                if not await self.authentication_receipts.verified(response.request, self.target, self.checkout_id):
                    return
                if self.observations_closed:
                    return
                authentication = True
                self.three_ds.requests.setdefault(response.request, p.path)
            await self.consume_response(response, data, initialization, confirmation, authentication, linked_read)
        except Exception:
            # 不输出 Stripe 响应正文、卡号、client_secret 或完整 traceback。
            if self.payment_state != 'paid' and (confirmation or authentication or response.request is self.token_request):
                self.payment_error = 'payment_response_not_verified'
                if authentication:
                    self.three_ds.close('failed')
                self.payment_done.set()
        finally:
            if confirmation or authentication:
                self.three_ds_ready.set()
            if confirmation and self.authentication_receipts.binding.intent_id:
                for request, status, facts, _size in self.authentication_receipts.take():
                    if (await self.authentication_receipts.verified(request, self.target, self.checkout_id)
                            and not self.observations_closed):
                        self.three_ds.requests.setdefault(request, urlsplit(request.url).path)
                        receipt = SimpleNamespace(request=request, status=status, url=request.url)
                        await self.consume_response(receipt, facts, False, False, True, False)

    async def consume_response(self, response, data, initialization, confirmation, authentication, linked_read):
        try:
            if authentication:
                if response.status >= 400:
                    self.three_ds.close('failed')
                elif not self.authentication_receipts.binding.observe_authentication(response.request, data, allow_challenge=False):
                    self.payment_error = 'three_ds_binding_unverified'
                    self.three_ds.close('failed')
                    self.payment_done.set()
                    return
                elif not self.three_ds.closed:
                    self.three_ds.observe_authentication(response.request, data)
                    if self.three_ds.needs_user:
                        self.authentication_receipts.binding.status = 'awaiting_user'
            if (initialization or confirmation or authentication) and "session_id" in data and data["session_id"] != self.checkout_id:
                if self.approved:
                    self.payment_error = "payment_order_binding_changed"
                    self.three_ds.close('failed')
                    self.payment_done.set()
                return
            if initialization and self.quote_requests[response.request] == self.quote_request_version:
                summary = data.get("total_summary")
                due = (data.get("amount_total") if "amount_total" in data else
                       summary.get("due") if isinstance(summary, dict) else None)
                currency = str(data.get("currency", "")).upper()
                if (200 <= response.status < 300 and type(due) is int and due > 0
                        and re.fullmatch(r"[A-Z]{3}", currency)):
                    self.official_quote_binding = {"amount_minor": due, "currency": currency}
                    details = data.get("total_details")
                    if isinstance(details, dict) and type(details.get("amount_tax")) is int and details["amount_tax"] >= 0:
                        self.official_quote_binding["tax_minor"] = details["amount_tax"]
                    self.official_binding_version += 1
            # 同一结算响应中确实返回的 PaymentIntent 才能作为证据关联。
            intent = data if data.get('object') == 'payment_intent' else data.get("payment_intent")
            intent_id = intent.get("id") if isinstance(intent, dict) else intent
            if (initialization or confirmation) and isinstance(intent_id, str) and re.fullmatch(r"pi_[A-Za-z0-9]{1,180}", intent_id):
                if self.linked_intent and self.linked_intent != intent_id:
                    if confirmation:
                        self.payment_error = "payment_intent_binding_changed"
                        self.payment_done.set()
                    return
                self.linked_intent = intent_id
            if (confirmation and isinstance(intent, dict) and intent.get('status') == 'requires_action'
                    and self.quote and type(intent.get('amount')) is int
                    and intent['amount'] == self.quote['today']['amount_minor']
                    and str(intent.get('currency', '')).upper() == self.quote['today']['currency']):
                self.authentication_receipts.bind(intent, self.linked_intent)
            # Ending automation must not discard an in-flight original payment
            # receipt. It grants observation only; confirmation stays reserved.
            original_in_flight = (self.read_only and self.confirmation_sent == 1
                and self.payment_ledger is not None
                and (self.payment_ledger.record or {}).get('payment_attempted') is True)
            if not self.quote or not self.approved and not original_in_flight:
                return
            evidence = payment_evidence(data, self.checkout_id, self.quote, linked_intent=self.linked_intent) if (
                200 <= response.status < 300 and (initialization or confirmation or linked_read or authentication)) else None
            if evidence:
                self.evidence = self.evidence or evidence
                self.payment_state = "paid"
                self.three_ds.close('completed')
                self.payment_error = None
                self.persist_observation()
                self.payment_done.set()
                return
            if self.payment_state == "paid":
                return
            # 付款前发出的初始化响应即使迟到，也不能作为本次拒付或验证结果。
            if initialization and not self.read_only:
                return
            if confirmation or response.request is self.token_request:
                self.payment_http_status = response.status
            error = data.get("error")
            code = error.get("code") if isinstance(error, dict) else None
            action_intent = intent if isinstance(intent, dict) else data if linked_read or authentication else None
            if (isinstance(action_intent, dict) and action_intent.get("status") == "requires_action"
                    or code == "authentication_required"):
                self.payment_state = "requires_action"
                if (not self.read_only and not self.three_ds_closed and self.confirmation_sent == 1 and (confirmation or linked_read or authentication)
                        and 200 <= response.status < 300):
                    if (isinstance(action_intent, dict) and type(action_intent.get('amount')) is int
                            and action_intent['amount'] == self.quote['today']['amount_minor']
                            and str(action_intent.get('currency', '')).upper() == self.quote['today']['currency']):
                        self.three_ds.bind(action_intent, self.linked_intent)
                    else:
                        self.three_ds.reject()
                self.persist_observation()
                self.payment_done.set()
            elif code in {"card_declined", "expired_card", "incorrect_cvc", "incorrect_number", "invalid_number", "insufficient_funds"}:
                self.payment_error = code
                self.payment_state = "declined"
                self.three_ds.close('failed')
                self.persist_observation()
                self.payment_done.set()
            elif authentication and (response.status >= 400 or data.get('state') == 'failed'
                    or isinstance(action_intent, dict) and action_intent.get('status') in {'requires_payment_method', 'canceled'}):
                self.payment_error = 'three_ds_authentication_failed'
                self.three_ds.close('failed')
                self.payment_done.set()
            elif confirmation:
                self.payment_error = "official_payment_evidence_not_observed"
                self.payment_done.set()
        except Exception:
            # 不输出 Stripe 响应正文、卡号、client_secret 或完整 traceback。
            if self.payment_state != "paid" and (confirmation or authentication or response.request is self.token_request):
                self.payment_error = "payment_response_not_verified"
                if authentication:
                    self.three_ds.close('failed')
                self.payment_done.set()

    def summary(self):
        return {**super().summary(), "payment_requests_sent": self.confirmation_sent,
                "card_tokenization_requests_sent": self.tokenization_sent,
                "payment_status": self.payment_state,
                "payment_evidence": self.evidence,
                "payment_record_write_failed": self.persistence_error,
                "payment_http_status": self.payment_http_status,
                "payment_failure_reason": safe_text(self.payment_error),
                "three_ds_status": self.three_ds.status,
                "quote_authority": "official_checkout_response" if self.official_quote_binding else None}
