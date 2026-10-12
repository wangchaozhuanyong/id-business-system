"""Existing Apple aliases, encrypted registration facts and private mail bridge.

The upstream algorithm and its four providers are unchanged. Only an explicitly
leased integration task receives this provider through a thread-local adapter.
No mailbox authorization or application session credential crosses this bridge.
"""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from datetime import datetime, timezone
from enum import Enum
import hashlib
import importlib
import ipaddress
import json
import math
import re
import threading
import time
from typing import Any, Literal
import uuid

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator, model_validator
from sqlalchemy import func, text

from src.services.base import BaseEmailService, EmailServiceFactory, EmailServiceType
from apple_closed_loop import (BATCH_PREFIX, ClosedLoopFacts, SYNC_ERRORS, PUBLIC_FIELDS as CLOSED_LOOP_PUBLIC_FIELDS,
                               resolve_system_proxy, verify_identity)
from apple_registration_diagnostics import (RegistrationDiagnostics, STAGES, ERROR_KINDS,
                                             PUBLIC_FIELDS as DIAGNOSTIC_PUBLIC_FIELDS)

PUBLIC_FIELDS = CLOSED_LOOP_PUBLIC_FIELDS | DIAGNOSTIC_PUBLIC_FIELDS

PREFIX = "id.apple-mailbox."
TASK_PREFIX = "id.apple-task."
TASK_STATUSES = {"pending", "running", "completed", "failed", "cancelled"}
ERRORS = {"mailbox_unavailable", "authorization_expired", "session_invalid", "address_changed", "mail_query_failed"}
_context = threading.local()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def normalize_email(value: str) -> str:
    value = value.strip().lower()
    if len(value) > 254 or any(ord(character) < 33 or ord(character) == 127 for character in value) or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
        raise HTTPException(400, "邮箱地址无效")
    return value


def safe_id(value: str) -> str:
    value = value.strip()
    if not value or len(value) > 191 or any(ord(character) < 33 for character in value):
        raise HTTPException(400, "资料标识无效")
    return value


def ip_value(value: str | None) -> str | None:
    if value is None or value == "":
        return None
    try:
        return str(ipaddress.ip_address(value.strip()))
    except ValueError:
        raise HTTPException(400, "注册 IP 格式无效") from None


def key_for(email: str) -> str:
    return PREFIX + hashlib.sha256(normalize_email(email).encode()).hexdigest()


def empty_record(email: str) -> dict[str, Any]:
    return {
        "email": normalize_email(email), "aliasId": None,
        "registrationStatus": "unregistered", "revision": 0,
        "registrationIp": None, "registrationIpSource": None, "source": None,
        "markedAt": None, "operatorId": None, "note": "",
        "activeTaskUuid": None, "attemptIp": None, "attemptCountry": None,
        "registrationCountry": None, "lastTaskUuid": None,
        "lastResultKind": None, "taskStatus": None,
        "localSaveStatus": "not_started", "syncStatus": "not_started", "systemAccountId": None,
        "syncErrorKind": None, "identityStatus": "not_verified", "passwordStatus": "not_started",
        "stage": "queued", "reason": None, "lastHttpStatus": None,
        "proxySource": "default", "proxyId": None, "mailboxSelection": "specified", "firstFailure": None,
    }


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class RecordsInput(Input):
    emails: list[str] = Field(max_length=10000)


class MailboxItem(Input):
    aliasId: str
    email: str
    revision: StrictInt = Field(ge=0)


class MarkInput(Input):
    items: list[MailboxItem] = Field(min_length=1, max_length=100)
    registrationStatus: Literal["unknown", "unregistered", "registered"]
    registrationIp: str | None = None
    note: str = Field(default="", max_length=500)
    operatorId: str


class ExecutionOptions(Input):
    proxy: str | None = None
    system_proxy: dict[str, Any] | None = None
    proxySource: Literal["system", "explicit", "default"] = "default"
    proxyId: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,191}$")
    mailboxSelection: Literal["specified", "automatic"] = "specified"
    auto_upload_cpa: bool = False
    cpa_service_ids: list[StrictInt] = Field(default_factory=list, max_length=100)
    auto_upload_sub2api: bool = False
    sub2api_service_ids: list[StrictInt] = Field(default_factory=list, max_length=100)
    auto_upload_tm: bool = False
    tm_service_ids: list[StrictInt] = Field(default_factory=list, max_length=100)

    @field_validator("proxyId", mode="before")
    @classmethod
    def normalized_proxy_id(cls, value):
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def proxy_reference(self):
        if (self.proxySource == "system") != (self.proxyId is not None):
            raise ValueError("系统代理来源必须绑定有效资料标识")
        return self


class StartInput(MailboxItem):
    operatorId: str
    options: ExecutionOptions = Field(default_factory=ExecutionOptions)


class BatchInput(Input):
    items: list[MailboxItem] = Field(min_length=1, max_length=100)
    operatorId: str
    concurrency: StrictInt = Field(default=1, ge=1, le=50)
    mode: Literal["parallel", "pipeline"] = "pipeline"
    interval_min: StrictInt = Field(default=5, ge=0, le=3600)
    interval_max: StrictInt = Field(default=30, ge=0, le=3600)
    options: ExecutionOptions = Field(default_factory=ExecutionOptions)


class SyncAck(Input):
    accountId: str
    status: Literal["saved", "failed", "conflict"]
    errorKind: str | None = None


class MailResponse(Input):
    code: str | None
    mailId: str | None
    error: str | None = None


class RegistrationFacts(ClosedLoopFacts):
    """One encrypted settings row per normalized email; no schema changes."""

    def __init__(self, models: Any, sessions: Any):
        self.models, self.sessions = models, sessions

    @contextmanager
    def transaction(self):
        with self.sessions.get_db() as db:
            # A process-local mutex is insufficient when the worker is replaced.
            # BEGIN IMMEDIATE serializes read/compare/write on the SQLite file.
            db.execute(text("BEGIN IMMEDIATE"))
            try:
                yield db
                db.commit()
            except BaseException:
                db.rollback()
                raise

    def read(self, db: Any, email: str) -> dict[str, Any]:
        expected = normalize_email(email)
        row = db.get(self.models.Setting, key_for(expected))
        if row is None:
            record = empty_record(expected)
            account = db.query(self.models.Account).filter(func.lower(self.models.Account.email) == expected).first()
            if account is not None:
                # Preserve historical accounts and failed placeholders. A failed
                # row isn't a new-registration proof, and isn't a fresh mailbox.
                record["registrationStatus"] = "registered" if account.status != "failed" else "unknown"
                record["source"] = "account_history"
            return record
        try:
            record = json.loads(row.value)
            if (not isinstance(record, dict) or record.get("email") != expected
                    or record.get("registrationStatus") not in {"unknown", "unregistered", "registered"}
                    or type(record.get("revision")) is not int or record["revision"] < 1):
                raise ValueError()
            record = {**empty_record(expected), **record}
            # Older manual corrections or deleting the local account cannot
            # erase independently persisted remote registration evidence.
            if (not record.get("activeTaskUuid") and record["registrationStatus"] != "registered"
                    and self.reliable_registration(db, record)):
                record["registrationStatus"] = "registered"
            return record
        except (ValueError, TypeError):
            raise HTTPException(503, "隐藏邮箱登记资料需要核对") from None

    def reliable_registration(self, db, record):
        def proven(row):
            if row is None:
                return False
            try:
                data = json.loads(row.value)
            except (ValueError, TypeError):
                raise HTTPException(503, "注册事实登记需要核对") from None
            if not isinstance(data, dict) or data.get("email") != record["email"]:
                return False
            return (data.get("creationConfirmed") is True or data.get("resultKind") == "new_registration"
                    or data.get("verifiedExistingAccount") is True
                    or (data.get("identityStatus") == "verified"
                        and (data.get("rawResult") or {}).get("source") == "login"))

        identifiers = {record.get("registrationEvidenceTaskUuid"), record.get("lastTaskUuid")} - {None}
        for task_uuid in identifiers:
            if proven(db.get(self.models.Setting, TASK_PREFIX + task_uuid)):
                return True
        if not identifiers:
            return False
        # Legacy rows have no evidence index. An earlier bound task may still
        # prove registration even when a later historical correction changed
        # lastTaskUuid. Only those existing histories need this fallback scan.
        for row in db.query(self.models.Setting).filter(self.models.Setting.key.startswith(TASK_PREFIX)).all():
            if proven(row):
                return True
        return False

    def write(self, db: Any, record: dict[str, Any]) -> dict[str, Any]:
        record = {**record, "revision": record["revision"] + 1}
        key = key_for(record["email"])
        row = db.get(self.models.Setting, key)
        if row is None:
            row = self.models.Setting(key=key, category="general", description="隐藏邮箱注册登记")
            db.add(row)
        row.value = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
        return record

    def records(self, emails: list[str]) -> list[dict[str, Any]]:
        with self.sessions.get_db() as db:
            return [self.read(db, email) for email in emails]

    @staticmethod
    def compare(record: dict[str, Any], revision: int):
        if record["revision"] != revision:
            raise HTTPException(409, "邮箱登记已更新，请刷新后重试")

    def mark(self, request: MarkInput) -> list[dict[str, Any]]:
        operator_id = safe_id(request.operatorId)
        address = ip_value(request.registrationIp)
        if request.registrationStatus != "registered" and address is not None:
            raise HTTPException(400, "只有已注册邮箱可以登记历史注册 IP")
        emails = [normalize_email(item.email) for item in request.items]
        if len(set(emails)) != len(emails):
            raise HTTPException(400, "同一个邮箱不能重复标记")
        records = []
        with self.transaction() as db:
            for item, email in zip(request.items, emails):
                record = self.read(db, email)
                self.compare(record, item.revision)
                if record["activeTaskUuid"]:
                    raise HTTPException(409, "邮箱仍被注册任务占用，请先核对任务")
                if request.registrationStatus != "registered" and self.reliable_registration(db, record):
                    raise HTTPException(409, "邮箱已有可靠官网注册事实，不能改回未知或未注册")
                historical = db.query(self.models.Account).filter(func.lower(self.models.Account.email) == email).first()
                if request.registrationStatus == "unregistered" and historical is not None and historical.status != "failed":
                    raise HTTPException(409, "邮箱已有历史账号，不能重新放入未注册池")
                record.update(
                    aliasId=safe_id(item.aliasId), registrationStatus=request.registrationStatus,
                    registrationIp=address,
                    registrationIpSource="manual" if address is not None else None,
                    registrationCountry=None, source="manual", markedAt=now_iso(),
                    operatorId=operator_id, note=request.note.strip(),
                )
                records.append(self.write(db, record))
        return records

    def reserve(self, request: StartInput, task_uuid: str, db=None, batch_id=None) -> dict[str, Any]:
        email, alias_id, operator_id = normalize_email(request.email), safe_id(request.aliasId), safe_id(request.operatorId)
        if db is None:
            with self.transaction() as connection:
                return self.reserve(request, task_uuid, connection, batch_id)
        record = self.read(db, email)
        self.compare(record, request.revision)
        if record["activeTaskUuid"]:
            raise HTTPException(409, "该邮箱已有占用任务，请先核对")
        if self.reliable_registration(db, record):
            raise HTTPException(409, "邮箱已有可靠官网注册事实，不能重复注册")
        historical = db.query(self.models.Account).filter(func.lower(self.models.Account.email) == email).first()
        if historical is not None and historical.status != "failed":
            raise HTTPException(409, "邮箱已有历史账号，不能重复注册")
        if record["registrationStatus"] != "unregistered":
            raise HTTPException(409, "请先核对并标记为未注册，已注册邮箱不能重复注册")
        diagnostics = {"proxySource": request.options.proxySource, "proxyId": request.options.proxyId,
                       "mailboxSelection": request.options.mailboxSelection, "firstFailure": None}
        record.update(aliasId=alias_id, operatorId=operator_id, activeTaskUuid=task_uuid,
                          lastTaskUuid=task_uuid, taskStatus="pending", lastResultKind=None,
                          attemptIp=None, attemptCountry=None, lastMailId=None,
                          localSaveStatus="not_started", syncStatus="not_started", systemAccountId=None,
                          syncErrorKind=None, identityStatus="not_verified", passwordStatus="not_started",
                          stage="queued", reason=None, lastHttpStatus=None, **diagnostics)
        db.add(self.models.RegistrationTask(task_uuid=task_uuid, status="pending"))
        db.add(self.models.Setting(key=TASK_PREFIX + task_uuid, category="general",
                                       description="隐藏邮箱任务关联",
                                       value=json.dumps({"email": email, "aliasId": alias_id, "operatorId": operator_id,
                                           "resultKind": None, "mirrorAccountId": str(uuid.uuid4()), "attempt": 1,
                                           "localSaveStatus": "not_started", "syncStatus": "not_started",
                                           "stage": "queued", "sideEffectPossible": False, "batchId": batch_id,
                                           "startedAt": now_iso(), **diagnostics})))
        return self.write(db, record)

    def record_failure(self, task_uuid, stage, error_kind, http_status, elapsed_ms):
        if (stage not in STAGES or error_kind not in ERROR_KINDS or
                (http_status is not None and (type(http_status) is not int or not 100 <= http_status <= 599)) or
                type(elapsed_ms) is not int or elapsed_ms < 0):
            raise ValueError("失败诊断格式无效")
        with self.transaction() as db:
            row, data = self.task_data(db, task_uuid)
            if data.get("firstFailure") is not None:
                return
            failure = {"stage": stage, "errorKind": error_kind, "httpStatus": http_status,
                       "elapsedMs": elapsed_ms, "observedAt": now_iso()}
            data["firstFailure"] = failure
            data["lastHttpStatus"] = http_status
            record = self.current(db, task_uuid, data)
            if record is None:
                data["syncStatus"] = "quarantined"
            else:
                record["firstFailure"] = failure
                record["lastHttpStatus"] = http_status
                self.write(db, record)
            row.value = json.dumps(data, ensure_ascii=False)

    def observe(self, email: str, task_uuid: str, **updates: Any) -> dict[str, Any]:
        with self.transaction() as db:
            record = self.read(db, email)
            if record["activeTaskUuid"] != task_uuid:
                raise HTTPException(409, "注册任务与邮箱占用不一致")
            record.update(updates)
            return self.write(db, record)

    def registered(self, email: str, task_uuid: str, existing: bool, identity=None):
        with self.transaction() as db:
            record = self.read(db, email)
            if record["activeTaskUuid"] != task_uuid:
                raise HTTPException(409, "注册任务与邮箱占用不一致")
            # Observing an existing-account login proves it was registered, but
            # that attempt's exit IP is not historical registration evidence.
            if record["registrationStatus"] != "registered":
                record.update(registrationStatus="registered", source="automatic", markedAt=now_iso())
            record["lastResultKind"] = "existing_account" if existing else "new_registration"
            task_fact = db.get(self.models.Setting, TASK_PREFIX + task_uuid)
            if task_fact is not None:
                task_data = json.loads(task_fact.value)
                task_data["resultKind"] = record["lastResultKind"]
                if not existing:
                    task_data["creationConfirmed"] = True
                elif identity and identity.get("identityStatus") == "verified":
                    task_data.update(verifiedExistingAccount=True, **identity)
                task_fact.value = json.dumps(task_data)
            if not existing or (identity and identity.get("identityStatus") == "verified"):
                record["registrationEvidenceTaskUuid"] = task_uuid
            if not existing and record["registrationIp"] is None:
                record["registrationIp"] = record["attemptIp"]
                record["registrationIpSource"] = "observed" if record["attemptIp"] else None
                record["registrationCountry"] = record["attemptCountry"]
            return self.write(db, record)

    def finish(self, email: str, task_uuid: str, cancelled: bool):
        with self.transaction() as db:
            record = self.read(db, email)
            if record["activeTaskUuid"] != task_uuid:
                return
            task = db.query(self.models.RegistrationTask).filter_by(task_uuid=task_uuid).first()
            status = task.status if task is not None and task.status in TASK_STATUSES else "failed"
            if cancelled:
                status = "cancelled"
            if status in {"pending", "running"}:
                status = "failed"
            if task is not None:
                task.status = status
            task_fact, task_data = self.task_data(db, task_uuid)
            uncertain = bool(task_data.get("sideEffectPossible") and record["registrationStatus"] != "registered")
            record.update(activeTaskUuid=task_uuid if uncertain else None, taskStatus="awaiting_review" if uncertain else status)
            if uncertain:
                record["registrationStatus"] = "unknown"
                task_data["needsReview"] = True
            if record["lastResultKind"] is None:
                record["lastResultKind"] = "failed"
            task_data["resultKind"] = record["lastResultKind"]
            task_fact.value = json.dumps(task_data)
            self.write(db, record)

    def recover(self, request: StartInput, is_live: Any):
        with self.transaction() as db:
            record = self.read(db, request.email)
            self.compare(record, request.revision)
            if not record["activeTaskUuid"]:
                raise HTTPException(409, "该邮箱没有待恢复的占用")
            if is_live(record["activeTaskUuid"]):
                raise HTTPException(409, "任务线程仍在执行，不能解除占用")
            record.update(aliasId=safe_id(request.aliasId), operatorId=safe_id(request.operatorId),
                          activeTaskUuid=None, taskStatus="interrupted")
            if record["registrationStatus"] != "registered":
                record["registrationStatus"] = "unknown"
            return self.write(db, record)


class AppleServiceType(str, Enum):
    APPLE_HIDDEN = "apple_hidden"


class AppleHiddenMailboxProvider(BaseEmailService):
    def __init__(self, integration: "AppleMailboxIntegration", context: dict[str, Any]):
        super().__init__(AppleServiceType.APPLE_HIDDEN, "苹果隐藏邮箱")
        self.integration, self.context = integration, context
        self.otp_lower_bound: float | None = None

    def create_email(self, config=None):
        record = self.integration.store.records([self.context["email"]])[0]
        if record["activeTaskUuid"] != self.context["taskUuid"]:
            raise ValueError("邮箱占用已变化")
        return {"email": self.context["email"], "service_id": self.context["aliasId"]}

    def get_verification_code(self, email, email_id=None, timeout=120,
                              pattern=r"(?<!\d)(\d{6})(?!\d)", otp_sent_at=None):
        if normalize_email(email) != self.context["email"] or email_id != self.context["aliasId"]:
            raise ValueError("验证码邮箱与任务不一致")
        since = min(value for value in (otp_sent_at, self.otp_lower_bound) if value is not None) if (otp_sent_at is not None or self.otp_lower_bound is not None) else None
        if since is None or not isinstance(since, (int, float)) or not math.isfinite(since) or since < self.context["startedAt"] or since > time.time() + 1:
            raise ValueError("验证码发送时间缺失或无效")
        return self.integration.wait_for_code(self.context, since, min(max(timeout, 0), 120))

    def list_emails(self, **kwargs):
        return [self.create_email()]

    def delete_email(self, email_id):
        # This provider borrows an existing address; it never deletes that alias.
        return False

    def check_health(self):
        return self.integration.live(self.context["taskUuid"])


class AppleMailboxIntegration:
    def __init__(self, models, sessions, task_manager, redact):
        self.models, self.sessions, self.task_manager, self.redact = models, sessions, task_manager, redact
        self.store = RegistrationFacts(models, sessions)
        self.contexts: dict[str, dict[str, Any]] = {}
        self.jobs: dict[str, asyncio.Task] = {}
        self.requests: dict[str, dict[str, Any]] = {}
        self.lock = threading.RLock()
        self.running_threads: set[str] = set()
        self.stopping = False
        self.route = importlib.import_module("src.web.routes.registration")
        self.install_adapters()

    def live(self, task_uuid):
        with self.lock:
            job = self.jobs.get(task_uuid)
            return bool((job is not None and not job.done()) or task_uuid in self.running_threads)

    def public_record(self, record):
        record = {key: record.get(key, value) for key, value in empty_record(record["email"]).items()}
        if record["activeTaskUuid"] and not self.live(record["activeTaskUuid"]) and record.get("taskStatus") != "awaiting_review":
            return {**record, "taskStatus": "interrupted"}
        return record

    async def start(self, request: StartInput):
        with self.lock:
            if self.stopping or len(self.contexts) >= 100:
                raise HTTPException(503, "注册任务较多，请稍后再试")
        proxy = await self.execution_proxy(request.options)
        task_uuid = str(uuid.uuid4())
        record = self.store.reserve(request, task_uuid)
        context = {"taskUuid": task_uuid, "aliasId": safe_id(request.aliasId), "email": normalize_email(request.email),
                   "startedAt": time.time(), "cancelled": False, "integration": self,
                   "options": request.options, "proxy": proxy}
        with self.lock:
            self.contexts[task_uuid] = context

        async def execute():
            try:
                await self.route.run_registration_task(task_uuid, *self.runner_arguments(request.options, proxy))
            finally:
                if not self.stopping:
                    self.store.finish(context["email"], task_uuid, context["cancelled"])
                with self.lock:
                    for identifier, pending in list(self.requests.items()):
                        if pending["taskUuid"] == task_uuid:
                            self.requests.pop(identifier)
                            pending["event"].set()
                    self.contexts.pop(task_uuid, None)

        job = asyncio.create_task(execute())
        with self.lock:
            self.jobs[task_uuid] = job

        def completed(done):
            # Retrieve any exception without writing raw task information to logs.
            if not done.cancelled():
                done.exception()
            with self.lock:
                self.jobs.pop(task_uuid, None)

        job.add_done_callback(completed)
        return {"taskUuid": task_uuid, "record": self.public_record(record)}

    async def execution_proxy(self, options):
        if options.system_proxy is not None:
            try:
                return await asyncio.to_thread(resolve_system_proxy, options.system_proxy)
            except ValueError:
                raise HTTPException(409, "所选系统代理暂不可用") from None
        return options.proxy

    @staticmethod
    def runner_arguments(options, proxy):
        return ("temp_mail", proxy, {}, None, "", "", options.auto_upload_cpa, options.cpa_service_ids,
                options.auto_upload_sub2api, options.sub2api_service_ids, options.auto_upload_tm, options.tm_service_ids)

    async def batch(self, request: BatchInput):
        if request.interval_max < request.interval_min:
            raise HTTPException(400, "批量间隔时间无效")
        emails = [normalize_email(item.email) for item in request.items]
        if len(set(emails)) != len(emails):
            raise HTTPException(400, "批量目标不能包含重复邮箱")
        with self.lock:
            if self.stopping or len(self.contexts) + len(request.items) > 100:
                raise HTTPException(503, "注册任务较多，请稍后再试")
        proxy = await self.execution_proxy(request.options)
        batch_id, task_uuids, records, skipped = str(uuid.uuid4()), [], [], []
        data = {"batchId": batch_id, "operatorId": request.operatorId, "taskUuids": task_uuids,
                "cancelled": False, "createdAt": now_iso(), "mode": request.mode,
                "concurrency": request.concurrency, "interval_min": request.interval_min,
                "interval_max": request.interval_max, "skipped": skipped}
        with self.store.transaction() as db:
            for item in request.items:
                task_uuid = str(uuid.uuid4())
                try:
                    record = self.store.reserve(StartInput(**item.model_dump(), operatorId=request.operatorId,
                                                          options=request.options),
                                                task_uuid, db, batch_id)
                except HTTPException as error:
                    if error.status_code != 409:
                        raise
                    skipped.append({"aliasId": item.aliasId, "reason": "mailbox_unavailable"})
                    continue
                task_uuids.append(task_uuid)
                records.append(record)
            if task_uuids:
                db.add(self.models.Setting(key=BATCH_PREFIX + batch_id, category="general",
                                           description="隐藏邮箱批次关联", value=json.dumps(data)))
        if not task_uuids:
            return {"batchId": None, "taskUuids": [], "records": [], "skipped": skipped}
        with self.lock:
            for task_uuid, record in zip(task_uuids, records):
                self.contexts[task_uuid] = {"taskUuid": task_uuid, "aliasId": record["aliasId"], "email": record["email"],
                    "startedAt": time.time(), "cancelled": False, "integration": self, "options": request.options,
                    "proxy": proxy, "batchId": batch_id}

        async def execute():
            try:
                if self.batch_status(batch_id)["cancelled"]:
                    return
                options = request.options
                await self.route.run_batch_registration(batch_id, task_uuids, "temp_mail", proxy, {}, None,
                    request.interval_min, request.interval_max, request.concurrency, request.mode,
                    options.auto_upload_cpa, options.cpa_service_ids, options.auto_upload_sub2api,
                    options.sub2api_service_ids, options.auto_upload_tm, options.tm_service_ids)
            finally:
                for task_uuid in task_uuids:
                    with self.lock:
                        context = self.contexts.get(task_uuid)
                    if context is not None and not self.stopping and task_uuid not in self.running_threads:
                        self.store.finish(context["email"], task_uuid, context["cancelled"])
                        with self.lock:
                            self.contexts.pop(task_uuid, None)
                    with self.lock:
                        self.jobs.pop(task_uuid, None)
        job = asyncio.create_task(execute())
        with self.lock:
            for task_uuid in task_uuids:
                self.jobs[task_uuid] = job
        # Retrieve task exceptions; the encrypted bindings survive failure.
        job.add_done_callback(lambda done: done.exception() if not done.cancelled() else None)
        return {"batchId": batch_id, "taskUuids": task_uuids,
                "records": [self.public_record(record) for record in records], "skipped": skipped}

    def batch_status(self, batch_id):
        try:
            uuid.UUID(batch_id)
        except ValueError:
            raise HTTPException(400, "批次标识无效") from None
        with self.sessions.get_db() as db:
            row = db.get(self.models.Setting, BATCH_PREFIX + batch_id)
            if row is None:
                raise HTTPException(404, "隐藏邮箱批次不存在")
            data = json.loads(row.value)
        tasks = [self.task(task_uuid) for task_uuid in data["taskUuids"]]
        allowed = {key: data[key] for key in ("batchId", "operatorId", "taskUuids", "cancelled", "createdAt", "mode",
                   "concurrency", "interval_min", "interval_max", "skipped")}
        return {**allowed, "tasks": tasks, "completed": sum(item["status"] in {"completed", "failed", "cancelled"} for item in tasks)}

    def cancel_batch(self, batch_id):
        data = self.batch_status(batch_id)
        with self.store.transaction() as db:
            row = db.get(self.models.Setting, BATCH_PREFIX + batch_id)
            binding = json.loads(row.value)
            binding["cancelled"] = True
            row.value = json.dumps(binding)
        state = self.route.batch_tasks.get(batch_id)
        if state is not None:
            state["cancelled"] = True
        for task_uuid in data["taskUuids"]:
            if self.live(task_uuid):
                self.cancel(task_uuid)
        return {"accepted": True}

    def task(self, task_uuid):
        try:
            uuid.UUID(task_uuid)
        except ValueError:
            raise HTTPException(400, "任务标识无效") from None
        with self.sessions.get_db() as db:
            task = db.query(self.models.RegistrationTask).filter_by(task_uuid=task_uuid).first()
            if task is None:
                raise HTTPException(404, "注册任务不存在")
            binding = db.get(self.models.Setting, TASK_PREFIX + task_uuid)
            if binding is None:
                raise HTTPException(404, "隐藏邮箱注册任务不存在")
            task_data = json.loads(binding.value)
            record = self.store.read(db, task_data["email"])
            record = self.public_record(record)
            status = "interrupted" if (task.status in {"pending", "running"} or record["activeTaskUuid"] == task_uuid) and not self.live(task_uuid) else task.status
            if status not in TASK_STATUSES | {"interrupted"}:
                status = "interrupted"
            return {"taskUuid": task_uuid, "status": status,
                    "logs": [self.redact(line) for line in (task.logs or "").splitlines()],
                    "record": record, "resultKind": task_data["resultKind"],
                    **{key: task_data.get(key) for key in PUBLIC_FIELDS}}

    def cancel(self, task_uuid):
        with self.lock:
            context = self.contexts.get(task_uuid)
            if context is None or not self.live(task_uuid):
                raise HTTPException(409, "任务已结束或中断，请刷新后核对")
            context["cancelled"] = True
            self.task_manager.cancel_task(task_uuid)
            for pending in self.requests.values():
                if pending["taskUuid"] == task_uuid:
                    pending["event"].set()
        # Keep the lease until the real executor returns, even after cancellation.
        return {"accepted": True}

    def pending_requests(self):
        with self.lock:
            return [{key: value for key, value in pending.items() if key in {"id", "taskUuid", "aliasId", "email", "since", "previousId"}}
                    for pending in self.requests.values() if not pending["event"].is_set()]

    def respond(self, identifier: str, response: MailResponse):
        if response.error is not None and response.error not in ERRORS:
            raise HTTPException(400, "邮件桥接错误类型无效")
        if (response.code is None) != (response.mailId is None):
            raise HTTPException(400, "验证码和邮件标识必须同时提供")
        if response.code is not None and (response.error is not None or not re.fullmatch(r"[0-9]{6}", response.code)):
            raise HTTPException(400, "仅接受六位数字验证码")
        if response.mailId is not None:
            safe_id(response.mailId)
        with self.lock:
            pending = self.requests.get(identifier)
            if pending is None or pending["event"].is_set() or not self.live(pending["taskUuid"]):
                raise HTTPException(409, "验证码查询请求已结束")
            if response.mailId is not None:
                record = self.store.records([pending["email"]])[0]
                if record["activeTaskUuid"] != pending["taskUuid"] or response.mailId in record.get("consumedMailIds", []):
                    raise HTTPException(409, "该邮件已消费或邮箱占用已变化")
            pending["response"] = response.model_dump()
            pending["event"].set()
        return {"accepted": True}

    def wait_for_code(self, context, since, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if context["cancelled"]:
                return None
            record = self.store.records([context["email"]])[0]
            if record["activeTaskUuid"] != context["taskUuid"]:
                raise ValueError("邮箱占用已变化")
            identifier = str(uuid.uuid4())
            pending = {"id": identifier, "taskUuid": context["taskUuid"], "aliasId": context["aliasId"],
                       "email": context["email"], "since": datetime.fromtimestamp(since, timezone.utc).isoformat().replace("+00:00", "Z"),
                       "previousId": record.get("lastMailId"), "event": threading.Event(), "response": None}
            with self.lock:
                self.requests[identifier] = pending
            try:
                until = min(deadline, time.monotonic() + 25)
                while not pending["event"].is_set() and time.monotonic() < until and not context["cancelled"]:
                    pending["event"].wait(min(0.25, max(0, until - time.monotonic())))
                response = pending["response"]
                if context["cancelled"]:
                    return None
                if response and response["error"]:
                    raise ValueError("邮箱授权或邮件查询暂时不可用，请核对")
                if response and response["code"]:
                    with self.store.transaction() as db:
                        current = self.store.read(db, context["email"])
                        if current["activeTaskUuid"] != context["taskUuid"]:
                            raise ValueError("邮箱占用已变化")
                        consumed = current.get("consumedMailIds", [])
                        if response["mailId"] not in consumed:
                            current.update(lastMailId=response["mailId"], consumedMailIds=(consumed + [response["mailId"]])[-100:])
                            self.store.write(db, current)
                            return response["code"]
            finally:
                with self.lock:
                    self.requests.pop(identifier, None)
            remaining = min(2, max(0, deadline - time.monotonic()))
            until = time.monotonic() + remaining
            while time.monotonic() < until and not context["cancelled"]:
                time.sleep(min(0.1, max(0, until - time.monotonic())))
        return None

    def guard_session(self, engine, task_uuid, session):
        if getattr(session, "_id_apple_post", False):
            return
        original_post = session.post
        endpoints = importlib.import_module("src.core.register").OPENAI_API_ENDPOINTS

        def post(url, *args, **kwargs):
            # Every replacement session keeps the same pre-submission durable
            # guard. Request bodies and response text never enter diagnostics.
            if url == endpoints["register"]:
                with self.sessions.get_db() as db:
                    _, binding = self.store.task_data(db, task_uuid)
                if not binding.get("passwordCheckpoint"):
                    raise ValueError("密码尚未可靠保存，不能提交")
                if not self.store.update_task(task_uuid, sideEffectPossible=True,
                                              stage="password", passwordStatus="submitted"):
                    raise ValueError("邮箱占用已变化，不能提交")
            diagnostics = getattr(engine, "_apple_diagnostics", None)
            if diagnostics is not None:
                return diagnostics.request(original_post, url, *args, **kwargs)
            return original_post(url, *args, **kwargs)

        session.post = post
        session._id_apple_post = True

    def observe_engine(self, engine, provider):
        context = provider.context
        task_uuid = context["taskUuid"]
        if hasattr(engine, "oauth_manager"):
            self.store.configuration_checkpoint(task_uuid, engine.oauth_manager.client_id, engine.proxy_url)
        original_get = engine.http_client.get

        def get(url, *args, **kwargs):
            response = original_get(url, *args, **kwargs)
            if url == "https://cloudflare.com/cdn-cgi/trace":
                values = dict(line.split("=", 1) for line in response.text.splitlines() if "=" in line)
                try:
                    address = ip_value(values.get("ip"))
                    country = values.get("loc")
                    if country is not None and not re.fullmatch(r"[A-Z]{2}", country):
                        country = None
                    self.store.observe(context["email"], context["taskUuid"], attemptIp=address, attemptCountry=country)
                except (ValueError, HTTPException):
                    pass
            return response

        engine.http_client.get = get
        original_signup, original_send = engine._submit_signup_form, engine._send_verification_code
        original_create, original_mark = engine._create_user_account, engine._mark_email_as_registered

        def signup(*args, **kwargs):
            provider.otp_lower_bound = time.time()
            if not self.store.update_task(task_uuid, stage="signup"):
                raise ValueError("邮箱占用已变化，不能继续注册")
            result = original_signup(*args, **kwargs)
            if result.is_existing_account:
                # email_otp selects upstream's login branch but does not prove
                # the requested account exists. Keep its lease until an
                # independently authenticated official identity matches.
                if not self.store.update_task(task_uuid, existingAccountIndication=True, sideEffectPossible=True,
                                              reason="existing_account_suspected"):
                    raise ValueError("迟到的账号存在结果已隔离，请核对")
            return result

        def send(*args, **kwargs):
            provider.otp_lower_bound = time.time()
            if not self.store.update_task(task_uuid, stage="verification_code"):
                raise ValueError("邮箱占用已变化，不能继续取码")
            return original_send(*args, **kwargs)

        def create(*args, **kwargs):
            if not self.store.update_task(task_uuid, stage="create_account", sideEffectPossible=True):
                raise ValueError("邮箱占用已变化，不能创建账号")
            result = original_create(*args, **kwargs)
            if result:
                if not self.store.update_task(task_uuid, creationConfirmed=True):
                    raise ValueError("迟到的账号创建结果已隔离，请核对")
                self.store.registered(context["email"], context["taskUuid"], existing=False)
            else:
                self.store.update_task(task_uuid, reason="account_creation_failed")
            return result

        def mark(*args, **kwargs):
            if not self.store.update_task(task_uuid, existingAccountIndication=True, sideEffectPossible=True,
                                          reason="existing_account_suspected"):
                raise ValueError("邮箱占用已变化，不能写入已有账号提示")
            result = original_mark(*args, **kwargs)
            # Frozen upstream calls this for loose "already/exists" message
            # matches. Keep it out of the candidate pool without asserting a
            # successful registration or using it as mirror identity evidence.
            return result

        engine._submit_signup_form, engine._send_verification_code = signup, send
        engine._create_user_account, engine._mark_email_as_registered = create, mark
        if hasattr(engine, "_generate_password"):
            original_generate = engine._generate_password

            def generate(*args, **kwargs):
                password = self.store.password_checkpoint(task_uuid, lambda: original_generate(*args, **kwargs))
                if not self.store.update_task(task_uuid, stage="password", passwordStatus="saved"):
                    raise ValueError("邮箱占用已变化，不能提交密码")
                return password

            engine._generate_password = generate
        if hasattr(engine, "_init_session"):
            original_init = engine._init_session
            engine._apple_guard_session = lambda session: self.guard_session(engine, task_uuid, session)

            def initialize_session(*args, **kwargs):
                result = original_init(*args, **kwargs)
                if result:
                    engine._apple_guard_session(engine.session)
                return result

            engine._init_session = initialize_session
        if hasattr(engine, "run"):
            original_run = engine.run

            def run(*args, **kwargs):
                result = original_run(*args, **kwargs)
                if result.success:
                    self.store.update_task(task_uuid, stage="identity")
                    identity = verify_identity(engine.session, context["email"], result.access_token)
                    engine._apple_identity = identity
                    if result.source == "login" and identity.get("identityStatus") == "verified":
                        self.store.registered(context["email"], task_uuid, existing=True, identity=identity)
                    if not self.store.capture_result(task_uuid, result, identity):
                        raise ValueError("注册结果需要核对，不能继续保存")
                return result

            engine.run = run
        if hasattr(engine, "_handle_oauth_callback"):
            original_oauth = engine._handle_oauth_callback

            def oauth(*args, **kwargs):
                if not self.store.update_task(task_uuid, stage="oauth"):
                    raise ValueError("邮箱占用已变化，不能继续授权")
                return original_oauth(*args, **kwargs)

            engine._handle_oauth_callback = oauth
        if hasattr(engine, "save_to_database"):
            original_save = engine.save_to_database
            engine._apple_original_save = original_save

            def save(result):
                identity = getattr(engine, "_apple_identity", None)
                if identity is None:
                    with self.sessions.get_db() as db:
                        _, binding = self.store.task_data(db, task_uuid)
                    identity = {key: binding.get(key) for key in ("identityStatus", "identityEvidence", "reason")}
                if not self.store.capture_result(task_uuid, result, identity):
                    raise ValueError("原注册资料不满足保存条件")
                return self.persist_result(task_uuid, result, original_save, identity)

            engine.save_to_database = save

        engine._apple_diagnostics = RegistrationDiagnostics(self.store, task_uuid)
        engine._apple_diagnostics.install(engine)

    def persisted_account(self, email):
        from types import SimpleNamespace
        with self.sessions.get_db() as db:
            account = db.query(self.models.Account).filter(func.lower(self.models.Account.email) == normalize_email(email)).first()
            if account is None:
                return None
            return SimpleNamespace(id=account.id, email=account.email, extra_data=account.extra_data or {})

    def persist_result(self, task_uuid, result, original_save, identity):
        if not self.store.update_task(task_uuid, stage="account_save"):
            raise ValueError("邮箱占用已变化，不能保存账号")
        account = self.persisted_account(result.email)
        if account is not None and account.extra_data.get("idSourceTaskUuid") != task_uuid:
            self.store.update_task(task_uuid, localSaveStatus="failed", syncStatus="conflict",
                                   syncErrorKind="email_conflict", reason="email_conflict")
            raise ValueError("邮箱已有其他来源账号，请核对后处理")
        result.metadata = {**(result.metadata or {}), "idSourceTaskUuid": task_uuid}
        if account is None:
            if not original_save(result):
                account = self.persisted_account(result.email)
                if account is None or account.extra_data.get("idSourceTaskUuid") != task_uuid:
                    self.store.update_task(task_uuid, localSaveStatus="failed", syncStatus="blocked",
                                           syncErrorKind="local_save_failed", reason="local_save_failed")
                    raise ValueError("账号注册结果已保留，本地保存失败")
            account = self.persisted_account(result.email)
        if account is None:
            self.store.update_task(task_uuid, localSaveStatus="failed", syncStatus="blocked",
                                   syncErrorKind="local_save_failed", reason="local_save_failed")
            raise ValueError("本地保存尚未取得账号回执")
        # Frozen save reads today's settings. Restore the bound execution's
        # original client ID and proxy after checking this task owns the row,
        # before producing its durable save/sync receipt.
        with self.store.transaction() as db:
            _, data = self.store.task_data(db, task_uuid)
            snapshot = data.get("configurationCheckpoint")
            original = db.get(self.models.Account, account.id)
            if (self.store.current(db, task_uuid, data) is None or not snapshot or original is None or
                    (original.extra_data or {}).get("idSourceTaskUuid") != task_uuid):
                raise ValueError("原执行配置或账号来源需要核对")
            original.client_id = snapshot["clientId"]
            original.proxy_used = snapshot.get("proxyUsed")
        if not self.store.account_saved(task_uuid, account, identity):
            raise ValueError("邮箱占用已变化，迟到保存结果需要核对")
        return True

    def local_save_retry(self, task_uuid):
        if self.live(task_uuid):
            raise HTTPException(409, "原任务仍在执行，请稍后核对")
        with self.sessions.get_db() as db:
            _, data = self.store.task_data(db, task_uuid)
            if self.store.current(db, task_uuid, data) is None or not data.get("rawResult"):
                raise HTTPException(409, "原任务资料不满足恢复条件")
            raw = dict(data["rawResult"])
        if not raw.get("success"):
            raise HTTPException(409, "原注册尚未取得成功结果")
        if data.get("localSaveStatus") == "saved" and self.persisted_account(data["email"]) is None:
            self.store.update_task(task_uuid, syncStatus="conflict", syncErrorKind="deleted_account", reason="deleted_account")
            raise HTTPException(409, "原账号已删除，不能通过补存恢复")
        # Only replay the account-save method. Registration, OTP, uploads and
        # subscription operations are never called by this recovery endpoint.
        context = {"taskUuid": task_uuid, "email": data["email"], "aliasId": data["aliasId"],
                   "integration": self, "cancelled": False, "startedAt": time.time()}
        provider = AppleHiddenMailboxProvider(self, context)
        engine = self.route.RegistrationEngine(provider, task_uuid=task_uuid)
        engine.email_info = {"email": data["email"], "service_id": data["aliasId"]}
        snapshot = data.get("configurationCheckpoint")
        if not snapshot:
            raise HTTPException(409, "原执行配置未完整保留，请先核对")
        engine.proxy_url = snapshot.get("proxyUsed")
        registration = importlib.import_module("src.core.register")
        result = registration.RegistrationResult(**raw)
        try:
            engine.save_to_database(result)
        except Exception:
            raise HTTPException(409, "原注册结果仍未可靠保存，请核对保存状态") from None
        return {"accepted": True, "task": self.task(task_uuid)}

    def sync_retry(self, task_uuid):
        with self.sessions.get_db() as db:
            _, data = self.store.task_data(db, task_uuid)
            if self.store.current(db, task_uuid, data) is None:
                raise HTTPException(409, "原任务占用已变化，请核对")
        if data.get("syncStatus") != "awaiting_identity":
            return self.store.sync_retry(task_uuid)
        if data.get("localSaveStatus") != "saved" or not data.get("syncPayload"):
            raise HTTPException(409, "原账号尚未可靠保存")
        raw = data.get("rawResult", {})
        with self.sessions.get_db() as db:
            account = db.query(self.models.Account).filter_by(id=int(data["syncPayload"]["upstreamAccountId"])).first()
            if account is None or (account.extra_data or {}).get("idSourceTaskUuid") != task_uuid:
                raise HTTPException(409, "原账号已删除或来源变化，不能继续核验")
            proxy = account.proxy_used
        from src.core.http_client import OpenAIHTTPClient
        client = OpenAIHTTPClient(proxy_url=proxy)
        try:
            session = client.session
            if raw.get("session_token"):
                session.cookies.set("__Secure-next-auth.session-token", raw["session_token"], domain="chatgpt.com")
            identity = verify_identity(session, data["email"], raw.get("access_token"))
        finally:
            client.close()
        receipt = self.store.identity_refreshed(task_uuid, identity)
        if identity.get("identityStatus") == "verified" and raw.get("source") == "login":
            record = self.store.records([data["email"]])[0]
            if record.get("activeTaskUuid") == task_uuid:
                self.store.registered(data["email"], task_uuid, existing=True, identity=identity)
                self.store.finish(data["email"], task_uuid, False)
        return receipt

    def active_tasks(self):
        tasks = []
        with self.lock:
            identifiers = list(self.contexts)
        with self.sessions.get_db() as db:
            for task_uuid in identifiers:
                if not self.live(task_uuid):
                    continue
                task = db.query(self.models.RegistrationTask).filter_by(task_uuid=task_uuid).first()
                if task is None or task.status not in {"pending", "running"}:
                    continue
                _, data = self.store.task_data(db, task_uuid)
                record = self.store.current(db, task_uuid, data)
                if record is None or record.get("activeTaskUuid") != task_uuid:
                    continue
                tasks.append({"taskUuid": task_uuid, "aliasId": data["aliasId"], "email": data["email"],
                              "operatorId": data["operatorId"], "startedAt": data.get("startedAt"),
                              "previousId": record.get("lastMailId")})
        return {"tasks": tasks}

    def install_adapters(self):
        # Install global dispatch wrappers once. The integration object is held
        # only in a private thread-local context for a known leased task.
        if not getattr(EmailServiceFactory, "_id_apple_adapter", False):
            factory = EmailServiceFactory.create.__func__

            def create(cls, service_type, config, name=None):
                context = getattr(_context, "task", None)
                if context is not None and service_type == EmailServiceType.TEMP_MAIL:
                    return AppleHiddenMailboxProvider(context["integration"], context)
                return factory(cls, service_type, config, name)

            EmailServiceFactory.create = classmethod(create)
            EmailServiceFactory._id_apple_adapter = True
        engine_class = self.route.RegistrationEngine
        if not getattr(engine_class, "_id_apple_adapter", False):
            original = engine_class.__init__

            def initialize(engine, *args, **kwargs):
                original(engine, *args, **kwargs)
                if isinstance(engine.email_service, AppleHiddenMailboxProvider):
                    engine.email_service.integration.observe_engine(engine, engine.email_service)

            engine_class.__init__ = initialize
            engine_class._id_apple_adapter = True
        if not getattr(self.route._run_sync_registration_task, "_id_apple_adapter", False):
            original_run = self.route._run_sync_registration_task

            def run(task_uuid, *args, **kwargs):
                integrations = getattr(self.route, "_id_apple_integrations", [])
                integration = next((item for item in integrations if task_uuid in item.contexts), None)
                if integration is None:
                    return original_run(task_uuid, *args, **kwargs)
                context = integration.contexts[task_uuid]
                _context.task = context
                with integration.lock:
                    integration.running_threads.add(task_uuid)
                try:
                    integration.store.observe(context["email"], task_uuid, taskStatus="running")
                    return original_run(task_uuid, *args, **kwargs)
                finally:
                    _context.task = None
                    with integration.lock:
                        integration.running_threads.discard(task_uuid)

            run._id_apple_adapter = True
            self.route._run_sync_registration_task = run
            self.route._id_apple_integrations = []
        self.route._id_apple_integrations.append(self)

    async def shutdown(self):
        # A stopped worker does not certify that the remote account was never
        # created. Durable leases survive the process and require explicit review.
        with self.lock:
            self.stopping = True
            for context in self.contexts.values():
                context["cancelled"] = True
            for pending in self.requests.values():
                pending["event"].set()


def install_apple_mailboxes(app: FastAPI, models, sessions, task_manager, redact):
    integration = AppleMailboxIntegration(models, sessions, task_manager, redact)
    base = "/internal/apple-mailboxes"

    @app.post(base + "/records")
    async def records(request: RecordsInput):
        return {"records": [integration.public_record(item) for item in integration.store.records(request.emails)]}

    @app.post(base + "/mark")
    async def mark(request: MarkInput):
        return {"records": [integration.public_record(item) for item in integration.store.mark(request)]}

    @app.post(base + "/start")
    async def start(request: StartInput):
        return await integration.start(request)

    @app.post(base + "/batch")
    async def batch(request: BatchInput):
        return await integration.batch(request)

    @app.get(base + "/batches/{batch_id}")
    async def batch_status(batch_id: str):
        return integration.batch_status(batch_id)

    @app.post(base + "/batches/{batch_id}/cancel")
    async def cancel_batch(batch_id: str):
        return integration.cancel_batch(batch_id)

    @app.get(base + "/sync-pending")
    async def sync_pending():
        return integration.store.sync_pending()

    @app.get(base + "/tasks-active")
    async def active_tasks():
        return integration.active_tasks()

    @app.get(base + "/tasks/{task_uuid}/sync-payload")
    async def sync_payload(task_uuid: str):
        return integration.store.sync_payload(task_uuid)

    @app.post(base + "/tasks/{task_uuid}/sync-ack")
    async def sync_ack(task_uuid: str, request: SyncAck):
        return integration.store.sync_ack(task_uuid, request.accountId, request.status, request.errorKind)

    @app.post(base + "/tasks/{task_uuid}/sync-retry")
    async def sync_retry(task_uuid: str):
        return await asyncio.to_thread(integration.sync_retry, task_uuid)

    @app.post(base + "/tasks/{task_uuid}/local-save-retry")
    async def local_save_retry(task_uuid: str):
        return await asyncio.to_thread(integration.local_save_retry, task_uuid)

    @app.post(base + "/recover")
    async def recover(request: StartInput):
        return {"record": integration.public_record(integration.store.recover(request, integration.live))}

    @app.get(base + "/requests")
    async def requests():
        return {"requests": integration.pending_requests()}

    @app.post(base + "/requests/{identifier}")
    async def respond(identifier: str, response: MailResponse):
        return integration.respond(identifier, response)

    @app.get(base + "/tasks/{task_uuid}")
    async def task(task_uuid: str):
        return integration.task(task_uuid)

    @app.post(base + "/tasks/{task_uuid}/cancel")
    async def cancel(task_uuid: str):
        return integration.cancel(task_uuid)

    app.on_event("shutdown")(integration.shutdown)
    app.state.apple_mailboxes = integration
    return integration
