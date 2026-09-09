"""单笔付款状态：提交前持久化，未知结果只能查原单。"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import time

from attempt_ledger import atomic_json, existing_checkout, assert_no_other_payment
from browser_checkout import money
from checkout_core import Stop, unique_object
from plans import PLANS, plan_spec, subscription_match

_UNOBSERVED = object()


def canonical_quote(quote):
    if (not isinstance(quote, dict) or quote.get("plan") not in PLANS
            or not quote.get("today") or quote.get("tax") is None or not quote.get("renewal")):
        raise Stop("complete_payment_quote_required")
    today, renewal = quote["today"], quote["renewal"]
    for item in (today, renewal, quote.get("tax")):
        if item is None:
            continue
        if (not isinstance(item, dict) or type(item.get("amount_minor")) is not int
                or not isinstance(item.get("amount"), str) or not isinstance(item.get("currency"), str)
                or money(item["currency"] + " " + item["amount"]) != item):
            raise Stop("invalid_payment_amount")
    if (today.get("currency") != quote["tax"].get("currency")
            or today.get("currency") != renewal.get("currency")
            or quote.get("renewal_interval") != "monthly"
            or type(today.get("amount_minor")) is not int or today["amount_minor"] <= 0):
        raise Stop("unsupported_payment_quote")
    return {"plan": quote["plan"], "today": today, "tax": quote.get("tax"),
            "renewal": renewal, "renewal_interval": quote["renewal_interval"]}


def quote_digest(quote):
    """v3 只绑定付款相关字段，展示来源等脱敏元数据不能破坏原单恢复。"""
    return hashlib.sha256(json.dumps(canonical_quote(quote), sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def legacy_quote_digest(quote):
    return hashlib.sha256(json.dumps(quote, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def validate_evidence(evidence, checkout_id, quote):
    if not isinstance(evidence, dict) or set(evidence) != {"kind", "identifier", "amount_minor", "currency"}:
        raise Stop("invalid_payment_evidence")
    valid_identifier = (evidence["kind"] == "checkout_session" and evidence["identifier"] == checkout_id
        or evidence["kind"] == "payment_intent" and isinstance(evidence["identifier"], str)
        and re.fullmatch(r"pi_[A-Za-z0-9]{1,180}", evidence["identifier"]))
    if (not valid_identifier or type(evidence["amount_minor"]) is not int
            or evidence["amount_minor"] != quote["today"]["amount_minor"]
            or evidence["currency"] != quote["today"]["currency"]):
        raise Stop("payment_evidence_mismatch")
    return evidence


def payment_evidence(data, checkout_id, quote, *, linked_intent=None):
    """仅提取已绑定订单的明确付款证据；返回主页/Plus 已生效都不是付款凭据。"""
    if not isinstance(data, dict):
        return None
    today = quote["today"]
    # 当前官网 /payment_pages/<同一订单>/init 实际用 total_summary.due，
    # 通用 Checkout Session 用 amount_total。只接受可明确核对的整数金额；
    # paid 本身或应付变为 0 不替代本次真实实付金额。
    summary = data.get("total_summary")
    charged_amount = data.get("amount_total") if "amount_total" in data else (
        summary.get("due") if isinstance(summary, dict) else None)
    amount_matches = type(charged_amount) is int and charged_amount == today["amount_minor"]
    if isinstance(summary, dict) and "due" in summary:
        amount_matches = amount_matches and type(summary["due"]) is int and summary["due"] == today["amount_minor"]
    # 官网该对象的 id 与结算编号不同，实际绑定字段为 session_id；不能只查 id。
    order_matches = (data.get("session_id") == checkout_id if "session_id" in data else data.get("id") == checkout_id)
    if (data.get("object") == "checkout.session" and order_matches
            and data.get("payment_status") == "paid" and data.get("status") == "complete"
            and amount_matches
            and str(data.get("currency", "")).upper() == today["currency"]):
        return {"kind": "checkout_session", "identifier": checkout_id,
                "amount_minor": today["amount_minor"], "currency": today["currency"]}
    candidates = [data, data.get("payment_intent")]
    for intent in candidates:
        if (linked_intent and isinstance(intent, dict) and intent.get("object") == "payment_intent"
                and intent.get("id") == linked_intent and intent.get("status") == "succeeded"
                and type(intent.get("amount_received")) is int and intent.get("amount_received") == today["amount_minor"]
                and str(intent.get("currency", "")).upper() == today["currency"]):
            return {"kind": "payment_intent", "identifier": linked_intent,
                    "amount_minor": today["amount_minor"], "currency": today["currency"]}
    return None


def outcome(payment_status, current_plan, evidence=None, *, target_plan="plus", current_tier=None):
    if payment_status == "paid" and evidence:
        match = subscription_match(target_plan, current_plan, current_tier)
        return {"matched": "subscription_activated", "tier_not_verified": "paid_tier_pending_verification"}.get(match, "paid_pending_activation")
    if payment_status == "declined":
        return "payment_failed"
    if payment_status == "requires_action":
        return "verification_required"
    return "payment_result_unknown"


class PaymentLedger:
    def __init__(self, root: Path, account_id: str, *, target_plan="plus", held_lock_fd=None):
        self.root, self.account_id = root, account_id
        plan_spec(target_plan)
        self.target_plan = target_plan
        self.account_key = hashlib.sha256(account_id.encode()).hexdigest()
        self.fd = None
        self.held_lock_fd = held_lock_fd
        self.owns_lock = False
        self.record = None

    def __enter__(self):
        if self.root.is_symlink():
            raise Stop("unsafe_state_directory")
        # 与建单共用账户锁，防止两个进程同时准备该账户的付款。
        if self.held_lock_fd is not None:
            if type(self.held_lock_fd) is not int or self.held_lock_fd < 0:
                raise Stop("account_operation_lock_invalid")
            self.fd = self.held_lock_fd
        else:
            self.fd = os.open(self.root / (self.account_key + ".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            self.owns_lock = True
        try:
            if self.owns_lock:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.checkout = existing_checkout(self.root, self.account_id, self.target_plan)
            self.checkout_id = self.checkout["checkout_identifier"]
            assert_no_other_payment(self.root, self.account_id, self.checkout_id)
            folder = self.root / "payments"
            if folder.is_symlink():
                raise Stop("unsafe_state_directory")
            folder.mkdir(mode=0o700, exist_ok=True)
            self.path = folder / (hashlib.sha256(self.checkout_id.encode()).hexdigest() + ".json")
            if self.path.is_symlink():
                raise Stop("unsafe_state_file")
            if self.path.exists():
                with self.path.open("rb") as f:
                    raw = f.read(65537)
                if len(raw) > 65536:
                    raise Stop("invalid_payment_record")
                self.record = json.loads(raw, object_pairs_hook=unique_object)
                schema = self.record.get("schema_version")
                if (not isinstance(self.record, dict) or self.record.get("account_key") != self.account_key
                        or self.record.get("checkout_identifier") != self.checkout_id
                        or schema not in (1, 2, 3) or self.record.get("payment_attempted") is not True
                        or self.record.get("target_plan", "plus") != self.target_plan):
                    raise Stop("invalid_payment_record")
                quote = self.record.get("quote")
                fingerprint = self.record.get("quote_digest")
                legacy_candidates = [quote]
                if isinstance(quote, dict) and self.target_plan.startswith("pro-"):
                    legacy_candidates.append({**quote, "plan_source": "official_checkout_selected_radio"})
                digest_valid = (quote_digest(quote) == fingerprint if schema == 3 else any(
                    legacy_quote_digest(candidate) == fingerprint for candidate in legacy_candidates))
                if (not digest_valid
                        or self.record["quote"]["plan"] != self.target_plan
                        or self.record.get("payment_status") not in {"unknown", "paid", "declined", "requires_action"}
                        or type(self.record.get("confirmation_requests_sent")) is not int
                        or self.record["confirmation_requests_sent"] not in (0, 1)):
                    raise Stop("invalid_payment_record")
                evidence = self.record.get("payment_evidence")
                if evidence:
                    validate_evidence(evidence, self.checkout_id, self.record["quote"])
                if self.record["payment_status"] == "paid" and not evidence:
                    raise Stop("invalid_payment_record")
            return self
        except BlockingIOError:
            self.__exit__()
            raise Stop("account_operation_in_progress") from None
        except BaseException:
            self.__exit__()
            raise

    def assert_unattempted(self):
        if self.record is not None:
            raise Stop("previous_payment_attempt_exists", payment_status=self.record.get("payment_status", "unknown"),
                       action="recheck_original_order_only")

    def begin(self, quote, *, confirmed_digest, card_last4):
        self.assert_unattempted()
        if quote.get("plan") != self.target_plan:
            raise Stop("payment_quote_plan_mismatch")
        fingerprint = quote_digest(quote)
        if confirmed_digest != fingerprint:
            raise Stop("payment_quote_changed")
        if self.fd is None or not re.fullmatch(r"\d{4}", card_last4):
            raise Stop("invalid_payment_preparation")
        record = {"schema_version": 3, "account_key": self.account_key, "target_plan": self.target_plan,
                  "checkout_identifier": self.checkout_id, "quote": quote,
                  "quote_digest": fingerprint, "card_last4": card_last4,
                  "payment_attempted": True, "payment_status": "unknown",
                  "stage": "before_payment_click", "created_at": int(time.time()),
                  "confirmation_requests_sent": 0, "payment_evidence": None,
                  "subscription_status": "not_verified"}
        atomic_json(self.path, record)
        self.record = record

    def mark_confirmation_sent(self):
        if not self.record or self.record.get("confirmation_requests_sent"):
            raise Stop("duplicate_payment_blocked")
        updated = {**self.record, "confirmation_requests_sent": 1, "stage": "payment_request_sending"}
        atomic_json(self.path, updated)
        self.record = updated

    def update(self, *, payment_status=None, evidence=None, current_plan=_UNOBSERVED, current_tier=None, reason=None):
        if not self.record:
            raise Stop("payment_record_required")
        data = dict(self.record)
        if payment_status:
            if payment_status not in {"paid", "declined", "requires_action", "unknown"}:
                raise Stop("invalid_payment_status")
            # 已取得的付款证据不能被迟到回包降级为失败。
            if data.get("payment_status") != "paid":
                data["payment_status"] = payment_status
        if evidence:
            validate_evidence(evidence, self.checkout_id, data["quote"])
            data["payment_evidence"] = evidence
        if data["payment_status"] == "paid" and not data.get("payment_evidence"):
            raise Stop("payment_evidence_required")
        if current_plan in {"free", "plus", "pro"}:
            data["current_plan"] = current_plan
            data["current_tier"] = current_tier if current_tier in (5, 20) else None
            match = subscription_match(self.target_plan, current_plan, data["current_tier"])
            data["subscription_status"] = self.target_plan if match == "matched" else match
        elif current_plan is not _UNOBSERVED:
            data.pop("current_plan", None)
            data.pop("current_tier", None)
            data["subscription_status"] = "not_verified"
        if reason and re.fullmatch(r"[a-z0-9_]{1,80}", reason):
            data["last_reason"] = reason
        data["updated_at"] = int(time.time())
        data["status"] = outcome(data["payment_status"], data.get("current_plan"), data.get("payment_evidence"),
                                 target_plan=self.target_plan, current_tier=data.get("current_tier"))
        atomic_json(self.path, data)
        self.record = data

    def __exit__(self, *args):
        if self.fd is not None and self.owns_lock:
            os.close(self.fd)
        self.fd = None
        self.owns_lock = False
