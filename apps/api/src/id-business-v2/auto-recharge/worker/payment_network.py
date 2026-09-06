"""已确认报价的一次官方表单付款；未知请求默认拒绝。"""
from __future__ import annotations

import asyncio
import json
import re
from urllib.parse import parse_qs, urlsplit

from browser_checkout import NetworkGuard, progress
from checkout_core import MAX_BYTES, Stop, safe_text
from payment_state import payment_evidence


class PaymentGuard(NetworkGuard):
    def __init__(self, target, payment_ledger):
        super().__init__(target)
        self.payment_ledger = payment_ledger
        self.target_plan = payment_ledger.target_plan
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

    def persist_observation(self, **updates):
        """磁盘故障不能抹掉刚收到的付款凭据，也不能重新开放付款。"""
        try:
            self.payment_ledger.update(payment_status=self.payment_state, evidence=self.evidence,
                                       reason=self.payment_error, **updates)
        except OSError:
            self.persistence_error = True
            progress("payment_record_write_failed", repeated_payment="blocked")

    def approve(self, quote):
        if not self.account_verified or self.checkout_id != self.payment_ledger.checkout_id:
            raise Stop("payment_account_or_order_unverified")
        if not self.payment_ledger.record or not self.payment_ledger.record.get("payment_attempted"):
            raise Stop("payment_marker_required")
        if quote.get("plan") != self.target_plan:
            raise Stop("payment_quote_plan_mismatch")
        self.quote = quote
        self.approved = True
        self.payment_state = "unknown"

    async def route(self, route):
        request = route.request
        p = urlsplit(request.url)
        exact_stripe = p.scheme == "https" and p.hostname == "api.stripe.com" and request.method == "POST"
        if self.approved and not self.read_only and self.payment_state == "unknown" and exact_stripe:
            if p.path == "/v1/payment_methods" and not self.tokenization_sent and not self.confirmation_sent:
                # 只允许官网自身生成的 card PaymentMethod，不改写原始请求。
                try:
                    body = request.post_data or ""
                    parsed = json.loads(body) if body.lstrip().startswith("{") else parse_qs(body)
                    kind = parsed.get("type")
                    if kind not in ("card", ["card"]):
                        raise ValueError()
                except (TypeError, ValueError):
                    await route.abort("blockedbyclient")
                    return
                self.tokenization_sent = 1
                self.token_request = request
                await route.fallback()
                return
            if p.path == f"/v1/payment_pages/{self.checkout_id}/confirm" and not self.confirmation_reserved:
                # 在第一个 await 之前预留唯一提交，第二个请求不能参与预检或污染结果。
                self.confirmation_reserved = True
                try:
                    if self.validate_before_confirm:
                        await self.validate_before_confirm()
                    self.payment_ledger.mark_confirmation_sent()
                except Exception:
                    self.payment_error = "payment_request_precheck_failed"
                    self.payment_done.set()
                    await route.abort("blockedbyclient")
                    return
                self.confirmation_sent = 1
                self.confirm_request = request
                progress("payment_request_sending", attempt=1)
                await route.fallback()
                return
        await super().route(route)

    async def response(self, response):
        await super().response(response)
        p = urlsplit(response.url)
        if p.scheme != "https" or p.hostname != "api.stripe.com" or not self.checkout_id:
            return
        initialization = (p.path == f"/v1/payment_pages/{self.checkout_id}/init"
                          and response.request.method == "POST" and self.account_verified)
        confirmation = response.request is self.confirm_request
        linked_read = (self.linked_intent and response.request.method == "GET"
                       and p.path == f"/v1/payment_intents/{self.linked_intent}")
        if not (initialization or confirmation or linked_read or response.request is self.token_request):
            return
        try:
            raw = await response.body()
            if len(raw) > MAX_BYTES:
                return
            data = json.loads(raw)
            if not isinstance(data, dict):
                return
            if (initialization or confirmation) and "session_id" in data and data["session_id"] != self.checkout_id:
                if self.approved:
                    self.payment_error = "payment_order_binding_changed"
                    self.payment_done.set()
                return
            # 同一结算响应中确实返回的 PaymentIntent 才能作为证据关联。
            intent = data.get("payment_intent")
            intent_id = intent.get("id") if isinstance(intent, dict) else intent
            if (initialization or confirmation) and isinstance(intent_id, str) and re.fullmatch(r"pi_[A-Za-z0-9]{1,180}", intent_id):
                if self.linked_intent and self.linked_intent != intent_id:
                    if confirmation:
                        self.payment_error = "payment_intent_binding_changed"
                        self.payment_done.set()
                    return
                self.linked_intent = intent_id
            if not self.approved or not self.quote:
                return
            evidence = payment_evidence(data, self.checkout_id, self.quote, linked_intent=self.linked_intent) if (
                200 <= response.status < 300 and (initialization or confirmation or linked_read)) else None
            if evidence:
                self.evidence = evidence
                self.payment_state = "paid"
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
            action_intent = intent if isinstance(intent, dict) else data if linked_read else None
            if (isinstance(action_intent, dict) and action_intent.get("status") == "requires_action"
                    or code == "authentication_required"):
                self.payment_state = "requires_action"
                self.persist_observation()
                self.payment_done.set()
            elif code in {"card_declined", "expired_card", "incorrect_cvc", "incorrect_number", "invalid_number", "insufficient_funds"}:
                self.payment_error = code
                self.payment_state = "declined"
                self.persist_observation()
                self.payment_done.set()
            elif confirmation:
                self.payment_error = "official_payment_evidence_not_observed"
                self.payment_done.set()
        except Exception:
            # 不输出 Stripe 响应正文、卡号、client_secret 或完整 traceback。
            if self.payment_state != "paid" and (confirmation or response.request is self.token_request):
                self.payment_error = "payment_response_not_verified"
                self.payment_done.set()

    def summary(self):
        return {**super().summary(), "payment_requests_sent": self.confirmation_sent,
                "card_tokenization_requests_sent": self.tokenization_sent,
                "payment_status": self.payment_state,
                "payment_evidence": self.evidence,
                "payment_record_write_failed": self.persistence_error,
                "payment_http_status": self.payment_http_status,
                "payment_failure_reason": safe_text(self.payment_error)}
