"""建单前落盘和单次重试资格；只保存脱敏状态，不保存网页会话。"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import time
import uuid

from checkout_core import Stop, unique_object, write_json
from plans import plan_spec


def checkout_record_path(state_dir, account_id, target_plan="plus"):
    plan_spec(target_plan)
    key = hashlib.sha256(account_id.encode()).hexdigest()
    return state_dir / (key + ("" if target_plan == "plus" else "-" + target_plan) + ".json")


def assert_no_other_payment(state_dir, account_id, checkout_id=None):
    """同一账户已有付款尝试时只能复查原单，切换套餐不能绕过禁重付。"""
    key = hashlib.sha256(account_id.encode()).hexdigest()
    folder = state_dir / "payments"
    if folder.is_symlink():
        raise Stop("unsafe_state_directory")
    for path in folder.glob("*.json"):
        if path.is_symlink() or path.stat().st_size > 65536:
            raise Stop("invalid_payment_record")
        data = json.loads(path.read_text(), object_pairs_hook=unique_object)
        if not isinstance(data, dict):
            raise Stop("invalid_payment_record")
        if data.get("account_key") == key and data.get("payment_attempted"):
            if checkout_id is None or data.get("checkout_identifier") != checkout_id:
                raise Stop("account_has_other_payment_attempt", action="recheck_original_order_only")


def existing_checkout(state_dir: Path, account_id: str, target_plan="plus") -> dict:
    path = checkout_record_path(state_dir, account_id, target_plan)
    if state_dir.is_symlink() or path.is_symlink():
        raise Stop("unsafe_state_file")
    with path.open("rb") as f:
        raw = f.read(65537)
    if len(raw) > 65536:
        raise Stop("invalid_checkout_record")
    record = json.loads(raw, object_pairs_hook=unique_object)
    if (not isinstance(record, dict) or record.get("plan") != plan_spec(target_plan)["official_name"]
            or record.get("target_plan", "plus") != target_plan):
        raise Stop("invalid_checkout_record")
    sid, entity = record.get("checkout_identifier"), record.get("processor_entity")
    if not isinstance(sid, str) or not re.fullmatch(r"(?:cs|oaics)_[A-Za-z0-9_]{1,200}", sid):
        raise Stop("missing_checkout_identifier")
    if not isinstance(entity, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,40}", entity):
        raise Stop("missing_observed_checkout_entity")
    return record


def rejected_retry_allowed(record: dict) -> bool:
    if record.get("retry_of") or record.get("payment_status") != "not_attempted":
        return False
    if any(record.get(key) for key in ("checkout_identifier", "checkout_session_id", "session_id",
                                        "checkout_link_available", "payment_attempted")):
        return False
    legacy = (record.get("stage") is None and type(record.get("created_at")) is int
              and record.get("plan") == "chatgptplusplan"
              and record.get("checkout_outcome") == "not_confirmed")
    return bool((record.get("stage") == "checkout_create" or legacy)
                and record.get("status") == "blocked" and record.get("reason") == "http_error"
                and record.get("response_format") == "json"
                and record.get("http_status") in (400, 401, 403, 422)
                and record.get("challenge_observed") is False)


def atomic_json(path: Path, data: dict):
    temp = path.with_name("." + path.name + "." + uuid.uuid4().hex)
    try:
        write_json(temp, data, exclusive=True)
        os.replace(temp, path)
        fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        temp.unlink(missing_ok=True)


class AttemptLedger:
    def __init__(self, state_dir: Path, account_id: str, *, retry_rejected=False, target_plan="plus"):
        self.root = state_dir
        self.account_id = account_id
        self.target_plan = target_plan
        self.key = hashlib.sha256(account_id.encode()).hexdigest()
        self.path = checkout_record_path(state_dir, account_id, target_plan)
        self.retry_rejected = retry_rejected
        self.fd = None
        self.previous = None
        self.previous_bytes = None
        self.record = None

    def __enter__(self):
        if self.root.is_symlink():
            raise Stop("unsafe_state_directory")
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.fd = os.open(self.root / (self.key + ".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(self.fd)
            self.fd = None
            raise Stop("account_operation_in_progress") from None
        try:
            assert_no_other_payment(self.root, self.account_id)
            if self.path.is_symlink():
                raise Stop("unsafe_state_file")
            if self.path.exists():
                self.previous_bytes = self.path.read_bytes()
                if len(self.previous_bytes) > 65536:
                    raise ValueError()
                self.previous = json.loads(self.previous_bytes, object_pairs_hook=unique_object)
                if not isinstance(self.previous, dict):
                    raise ValueError()
                if (self.previous.get("plan") != plan_spec(self.target_plan)["official_name"]
                        or self.previous.get("target_plan", "plus") != self.target_plan):
                    raise Stop("checkout_record_plan_mismatch")
                if not (self.retry_rejected and rejected_retry_allowed(self.previous)):
                    raise Stop("previous_checkout_attempt_exists", retry_eligible=rejected_retry_allowed(self.previous))
            elif self.retry_rejected:
                raise Stop("retry_requires_rejected_record")
        except BaseException:
            self.__exit__(None, None, None)
            raise
        return self

    def begin(self):
        if self.record is not None or self.fd is None:
            raise Stop("duplicate_checkout_blocked")
        retry_of = None
        if self.previous_bytes is not None:
            digest = hashlib.sha256(self.previous_bytes).hexdigest()
            history = self.root / "history"
            if history.is_symlink():
                raise Stop("unsafe_state_directory")
            history.mkdir(mode=0o700, exist_ok=True)
            archive = history / (self.key + "-" + digest + ".json")
            # 备份保留原始字节；失败时不发出建单请求。
            if archive.exists():
                if archive.read_bytes() != self.previous_bytes:
                    raise Stop("history_conflict")
            else:
                fd = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "wb") as f:
                    f.write(self.previous_bytes)
                    f.flush()
                    os.fsync(f.fileno())
            retry_of = digest
        record = {"schema_version": 2, "run_id": uuid.uuid4().hex, "created_at": int(time.time()),
                  "status": "checkout_attempted", "stage": "checkout_create", "plan": plan_spec(self.target_plan)["official_name"],
                  "target_plan": self.target_plan,
                  "account_matched": True, "current_plan_before": "free", "retry_of": retry_of,
                  "checkout_outcome": "unknown", "payment_status": "not_attempted", "transport": "official_browser"}
        atomic_json(self.path, record)
        self.record = record

    def finish(self, result: dict):
        if self.record is not None:
            self.record = {**self.record, **result}
            atomic_json(self.path, self.record)

    def __exit__(self, *args):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
