"""Existing Apple aliases, encrypted registration facts and private mail bridge.

The upstream algorithm and its four providers are unchanged. Only an explicitly
leased integration task receives this provider through a thread-local adapter.
No mailbox authorization or application session credential crosses this bridge.
"""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from contextvars import ContextVar
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
from urllib.parse import urlsplit
import uuid

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator, model_validator
from sqlalchemy import func, null, text

from src.services.base import BaseEmailService, EmailServiceFactory, EmailServiceType
from apple_closed_loop import (BATCH_PREFIX, ClosedLoopFacts, RESULT_FIELDS, SYNC_ERRORS, PUBLIC_FIELDS as CLOSED_LOOP_PUBLIC_FIELDS,
                               resolve_system_proxy, verify_identity)
from apple_registration_diagnostics import (EvidenceStorageError, RegistrationDiagnostics, STAGES, ERROR_KINDS,
                                             PUBLIC_FIELDS as DIAGNOSTIC_PUBLIC_FIELDS)
from flow_evidence import (append_attempt, attempt_evidence, configuration_summary, device_cookie_presence,
                           new_flow_evidence, observation, response_admitted, response_classification,
                           validate_configuration_summary, validate_flow_evidence, validate_observation)

PUBLIC_FIELDS = CLOSED_LOOP_PUBLIC_FIELDS | DIAGNOSTIC_PUBLIC_FIELDS

PREFIX = "id.apple-mailbox."
TASK_PREFIX = "id.apple-task."
TASK_STATUSES = {"pending", "running", "completed", "failed", "cancelled"}
ERRORS = {"mailbox_unavailable", "authorization_expired", "session_invalid", "address_changed", "mail_query_failed"}
_context = threading.local()
execution_actor = ContextVar("id_registration_execution_actor", default=None)


def context_authorization_only(integration, task_uuid):
    with integration.lock:
        return bool(integration.contexts.get(task_uuid, {}).get("authorizationOnly"))


def reject_browser_protocol_task(integration, task_uuid):
    # Withdrawal never converts a historical browser task into an HTTP task,
    # including after restart when its in-memory execution mode is absent.
    with integration.lock:
        browser = integration.contexts.get(task_uuid, {}).get("browserMode")
    with integration.sessions.get_db() as db:
        row = db.get(integration.models.Setting, TASK_PREFIX + task_uuid)
        historical = row is not None and "browserRegistration" in json.loads(row.value)
    if browser or historical:
        raise ValueError("历史浏览器注册任务不能调用服务器注册执行器")


def confirms_account_creation(request_url, response):
    """Reject explicit transport/error pages without guessing success fields."""
    def official(value):
        if not isinstance(value, str):
            return False
        try:
            parts = urlsplit(value)
            return (parts.scheme == "https" and parts.hostname == "auth.openai.com"
                    and parts.username is None and parts.password is None and parts.port in {None, 443})
        except ValueError:
            return False
    if (not official(request_url) or not official(getattr(response, "url", None))
            or getattr(response, "status_code", None) != 200):
        return False
    try:
        value = response.json()
        return (isinstance(value, dict) and "error" not in value and "errors" not in value
                and value.get("success") is not False)
    except Exception:
        return False


class DeferredDiagnosticsStore:
    """A provider's address is unknown until create_email returns.

    Pre-address diagnostics stay in this execution context. They cannot invent
    an email or access a nonexistent durable task before provider binding.
    """
    def __init__(self, store, context):
        self.store, self.context = store, context

    def update_task(self, task_uuid, **updates):
        pending = self.context.setdefault("diagnosticUpdates", {})
        if not self.context.get("email"):
            pending.update(updates)
            return True
        values = {**pending, **updates}
        pending.clear()
        return self.store.update_task(task_uuid, **values)

    def record_failure(self, task_uuid, stage, error_kind, http_status, elapsed_ms):
        if self.context.get("email"):
            return self.store.record_failure(task_uuid, stage, error_kind, http_status, elapsed_ms)


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
        "registrationCountry": None, "registeredAt": None, "lastTaskUuid": None,
        "lastResultKind": None, "taskStatus": None,
        "localSaveStatus": "not_started", "syncStatus": "not_started", "systemAccountId": None,
        "syncErrorKind": None, "identityStatus": "not_verified", "passwordStatus": "not_started",
        "stage": "queued", "reason": None, "lastHttpStatus": None,
        "proxySource": "default", "proxyId": None, "mailboxSelection": "specified", "firstFailure": None,
        "manualSyncId": None,
        "creationConfirmed": False, "authorizationStatus": None,
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


class ManualSyncPrepare(MailboxItem):
    operatorId: str


class ManualSyncAck(MailboxItem):
    manualSyncId: str
    accountId: str | None
    status: Literal["saved", "failed", "conflict"]
    errorKind: str | None = None


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
    fingerprint: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


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
                # Empty manual edits cannot erase an observed creation fact.
                proven = self.reliable_registration(db, record)
                registration_ip = record.get("registrationIp") if proven or address is None else address
                record.update(
                    aliasId=safe_id(item.aliasId), registrationStatus=request.registrationStatus,
                    registrationIp=registration_ip,
                    registrationIpSource=(record.get("registrationIpSource") if proven or address is None else "manual"),
                    source=record.get("source") if proven else "manual", markedAt=record.get("markedAt") if proven else now_iso(),
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
                                           "startedAt": now_iso(), "schemaVersion": 2,
                                           "provider": "apple_hidden", "flowEvidence": new_flow_evidence(), **diagnostics})))
        return self.write(db, record)

    def manual_sync_prepare(self, request):
        with self.transaction() as db:
            record = self.read(db, request.email)
            self.compare(record, request.revision)
            if (record.get("source") != "manual" or record.get("registrationStatus") != "registered"
                    or record.get("activeTaskUuid") or record.get("aliasId") != safe_id(request.aliasId)):
                raise HTTPException(409, "仅无占用任务的人工已注册邮箱可以补齐台账")
            if self.reliable_registration(db, record):
                raise HTTPException(409, "已有官网创建事实，请在原任务补存或同步")
            if record.get("syncStatus") != "saved":
                record.update(manualSyncId=record.get("manualSyncId") or str(uuid.uuid4()),
                              operatorId=safe_id(request.operatorId), syncStatus="pending", syncErrorKind=None)
                record = self.write(db, record)
            return record

    def manual_sync_ack(self, request):
        if request.errorKind is not None and request.errorKind not in SYNC_ERRORS:
            raise HTTPException(400, "同步错误类型无效")
        if request.status == "saved" and not request.accountId:
            raise HTTPException(400, "成功回执必须包含主账号标识")
        with self.transaction() as db:
            record = self.read(db, request.email)
            if (record.get("manualSyncId") != request.manualSyncId or record.get("source") != "manual"
                    or record.get("registrationStatus") != "registered" or record.get("activeTaskUuid")
                    or record.get("aliasId") != safe_id(request.aliasId)):
                raise HTTPException(409, "人工资料来源已变化，请重新核对")
            if record.get("syncStatus") == "saved" and record.get("systemAccountId") == request.accountId:
                return record
            self.compare(record, request.revision)
            record.update(syncStatus=request.status, syncErrorKind=request.errorKind,
                          systemAccountId=safe_id(request.accountId) if request.status == "saved" else None)
            return self.write(db, record)

    def bind_provider(self, task_uuid, context, engine):
        email = normalize_email(engine.email)
        alias = safe_id(str((engine.email_info or {}).get("service_id") or email))
        with self.transaction() as db:
            if db.get(self.models.Setting, TASK_PREFIX + task_uuid) is not None:
                raise ValueError("任务已绑定其他执行资料")
            record = self.read(db, email)
            if record.get("activeTaskUuid") or self.reliable_registration(db, record) or record["registrationStatus"] != "unregistered":
                raise ValueError("邮箱已有注册事实或占用，不能重复创建")
            record.update(aliasId=alias, operatorId=context["operatorId"], activeTaskUuid=task_uuid,
                          lastTaskUuid=task_uuid, taskStatus="running", stage="signup", source="automatic",
                          attemptIp=context.get("attemptIp"), attemptCountry=context.get("attemptCountry"))
            provider = engine.email_service.service_type.value
            db.add(self.models.Setting(key=TASK_PREFIX + task_uuid, category="general", description="邮箱注册任务关联",
                   value=json.dumps({"email": email, "aliasId": alias, "operatorId": context["operatorId"],
                     "mirrorAccountId": str(uuid.uuid4()), "schemaVersion": 2, "provider": provider,
                     "resultKind": None, "attempt": 1, "sideEffectPossible": False, "startedAt": now_iso(),
                     "localSaveStatus": "not_started", "syncStatus": "not_started", "stage": "signup",
                     "providerCheckpoint": {"serviceType": provider, "config": engine.email_service.config,
                                            "emailInfo": engine.email_info}})))
            self.write(db, record)
        context.update(email=email, aliasId=alias)

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

    def record_configuration_summary(self, task_uuid, summary):
        validate_configuration_summary(summary)
        with self.transaction() as db:
            row, data = self.task_data(db, task_uuid)
            if self.current(db, task_uuid, data) is None:
                return False
            flow = data.get("flowEvidence", new_flow_evidence())
            validate_flow_evidence(flow)
            if flow["version"] < 4:
                return True
            if flow["configurationSummary"] is None:
                flow = {**flow, "configurationSummary": {**summary, "proxySource": data.get("proxySource") or summary["proxySource"]}}
                validate_flow_evidence(flow)
                data["flowEvidence"] = flow
                row.value = json.dumps(data, ensure_ascii=False)
        return True

    def record_flow_evidence(self, task_uuid, slot, evidence, *, outcome="response", response_class="unclassified",
                             device_cookie_before="not_observed", device_cookie_after="not_observed", observed_transport=False):
        if type(observed_transport) is not bool:
            raise ValueError("注册证据来源无效")
        attempt = attempt_evidence(slot, evidence, outcome=outcome, response_class=response_class,
                                   device_cookie_before=device_cookie_before, device_cookie_after=device_cookie_after)
        with self.transaction() as db:
            row, data = self.task_data(db, task_uuid)
            record = self.current(db, task_uuid, data)
            if record is None:
                return False
            flow = data.get("flowEvidence", new_flow_evidence())
            validate_flow_evidence(flow)
            if flow["version"] < 4:
                # Historical flow records are immutable. Live admission always
                # uses the fresh v3 observation outside this storage function.
                return True
            data["flowEvidence"] = append_attempt(flow, attempt)
            if observed_transport:
                status = evidence["httpStatus"] if evidence is not None else None
                data["lastHttpStatus"] = record["lastHttpStatus"] = status
                self.write(db, record)
            row.value = json.dumps(data, ensure_ascii=False)
        return True

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
                    task_data.setdefault("creationConfirmedAt", now_iso())
                    record["registeredAt"] = task_data["creationConfirmedAt"]
                    record.update(creationConfirmed=True, authorizationStatus="pending")
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
        self.generic_actors: dict[str, str] = {}
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
        if record.get("lastTaskUuid"):
            with self.sessions.get_db() as db:
                row = db.get(self.models.Setting, TASK_PREFIX + record["lastTaskUuid"])
                binding = json.loads(row.value) if row is not None else {}
                if binding.get("email") == record["email"] and binding.get("creationConfirmed"):
                    record["creationConfirmed"] = True
                    record["authorizationStatus"] = "complete" if binding.get("identityStatus") == "verified" else "pending"
                    record["registeredAt"] = binding.get("creationConfirmedAt") or record.get("registeredAt")
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
            flow = task_data.get("flowEvidence")
            if "flowEvidence" in task_data:
                validate_flow_evidence(flow)
            record = self.store.read(db, task_data["email"])
            record = self.public_record(record)
            status = "interrupted" if (task.status in {"pending", "running"} or record["activeTaskUuid"] == task_uuid) and not self.live(task_uuid) else task.status
            if status not in TASK_STATUSES | {"interrupted"}:
                status = "interrupted"
            return {"taskUuid": task_uuid, "status": status,
                    "logs": [self.redact(line) for line in (task.logs or "").splitlines()],
                    "record": record, "resultKind": task_data["resultKind"],
                    **({"flowEvidence": flow} if "flowEvidence" in task_data else {}),
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

    def observe_flow_request(self, engine, task_uuid, session, slot, original, *args, **kwargs):
        """Observe one original transport call without changing its arguments."""
        def storage_error(status=None):
            halt = getattr(engine, "_apple_halt_transport", None)
            if callable(halt):
                halt("evidence_storage_error", status)
            raise EvidenceStorageError(status) from None

        if getattr(engine, "_apple_evidence_storage_failed", False):
            storage_error()
        diagnostics = getattr(engine, "_apple_diagnostics", None)
        before = device_cookie_presence(session)
        evidence, response_class = None, "not_applicable"
        try:
            response = (diagnostics.capture(original, *args, **kwargs)
                        if diagnostics is not None else original(*args, **kwargs))
        except EvidenceStorageError as error:
            storage_error(error.http_status)
        except Exception:
            try:
                if not self.store.record_flow_evidence(task_uuid, slot, None, outcome="network_error",
                        response_class="not_applicable", device_cookie_before=before,
                        device_cookie_after=device_cookie_presence(session), observed_transport=True):
                    raise EvidenceStorageError()
            except Exception:
                engine._apple_evidence_storage_failed = True
                if diagnostics is not None and diagnostics.active is not None:
                    diagnostics.active["errorKind"] = "evidence_storage_error"
                try:
                    self.store.record_flow_evidence(task_uuid, slot, None, outcome="evidence_storage_error",
                        response_class="not_applicable", device_cookie_before=before,
                        device_cookie_after=device_cookie_presence(session), observed_transport=True)
                except Exception:
                    pass
                storage_error()
            raise
        evidence = observation(response, slot)
        response_class = response_classification(response, slot, evidence)
        after = device_cookie_presence(session)
        try:
            if not self.store.record_flow_evidence(task_uuid, slot, evidence, response_class=response_class,
                    device_cookie_before=before, device_cookie_after=after, observed_transport=True):
                raise EvidenceStorageError(evidence["httpStatus"])
        except Exception:
            engine._apple_evidence_storage_failed = True
            if diagnostics is not None and diagnostics.active is not None:
                diagnostics.active.update(errorKind="evidence_storage_error", httpStatus=evidence["httpStatus"])
            try:
                self.store.record_flow_evidence(task_uuid, slot, evidence, outcome="evidence_storage_error",
                    response_class=response_class, device_cookie_before=before, device_cookie_after=after, observed_transport=True)
            except Exception:
                pass
            storage_error(evidence["httpStatus"])
        if response_class in {"verification_required", "structured_rejection", "rate_limited"}:
            # Escape the original device/HTTP retry catches only after the
            # response and its safe evidence have both been observed.
            if diagnostics is not None and diagnostics.active is not None:
                code = evidence.get("responseDetails", {}).get("errorKind")
                if code in {"account_creation_failed", "user_exists"}:
                    diagnostics.active["errorKind"] = code
            halt = getattr(engine, "_apple_halt_transport", None)
            if callable(halt):
                halt("http_rejected", evidence["httpStatus"])
            raise ValueError("官网明确拒绝本次流程，已停止后续请求；请核对任务诊断")
        return response, evidence, response_class

    def guard_session(self, engine, task_uuid, session):
        if getattr(session, "_id_apple_post", False):
            return
        original_post = session.post
        original_get = session.get
        original_request = getattr(session, "request", None)
        endpoints = importlib.import_module("src.core.register").OPENAI_API_ENDPOINTS

        def ensure_active():
            state = getattr(engine, "_apple_transport_stop_state", None)
            halt = getattr(engine, "_apple_halt_transport", None)
            if state is not None and callable(halt):
                halt(*state)
            if getattr(engine, "_apple_evidence_storage_failed", False):
                if callable(halt):
                    halt("evidence_storage_error")
                raise EvidenceStorageError()

        if callable(original_request):
            def request(method, url, *args, **kwargs):
                ensure_active()
                if url != endpoints["sentinel"] or not isinstance(method, str) or method.upper() != "POST":
                    return original_request(method, url, *args, **kwargs)
                engine._apple_sentinel_evidence = None
                engine._apple_sentinel_session = None
                engine._apple_sentinel_admitted = False
                response, evidence, classification = self.observe_flow_request(engine, task_uuid, session, "sentinel",
                                                               original_request, method, url, *args, **kwargs)
                engine._apple_sentinel_evidence = evidence
                engine._apple_sentinel_session = session
                engine._apple_sentinel_admitted = response_admitted(response, "sentinel", evidence, response_class=classification)
                return response

            session.request = request

        def get(url, *args, **kwargs):
            ensure_active()
            diagnostics = getattr(engine, "_apple_diagnostics", None)
            start = getattr(engine, "oauth_start", None)
            if start is not None and url == getattr(start, "auth_url", None):
                response, evidence, classification = self.observe_flow_request(engine, task_uuid, session, "authorize", original_get, url, *args, **kwargs)
                if not response_admitted(response, "authorize", evidence, response_class=classification):
                    raise ValueError("授权入口响应未通过校验，已停止后续注册")
                return response
            return (diagnostics.request(original_get, url, *args, **kwargs)
                    if diagnostics is not None else original_get(url, *args, **kwargs))

        def post(url, *args, **kwargs):
            ensure_active()
            # Every replacement session keeps the same pre-submission durable
            # guard. Request bodies and response text never enter diagnostics.
            if url == endpoints["register"]:
                if context_authorization_only(self, task_uuid):
                    raise ValueError("授权续接不能再次提交注册密码")
                with self.sessions.get_db() as db:
                    _, binding = self.store.task_data(db, task_uuid)
                if not binding.get("passwordCheckpoint"):
                    raise ValueError("密码尚未可靠保存，不能提交")
                if not self.store.update_task(task_uuid, sideEffectPossible=True,
                                              stage="password", passwordStatus="submitted"):
                    raise ValueError("邮箱占用已变化，不能提交")
            if url == endpoints["signup"] and context_authorization_only(self, task_uuid):
                # Reuse the frozen authorization request, selecting its login
                # screen. Refuse every later account-creation side effect.
                body = json.loads(kwargs.get("data") or "{}")
                body["screen_hint"] = "login"
                kwargs["data"] = json.dumps(body)
                kwargs["headers"] = {**kwargs.get("headers", {}), "referer": "https://auth.openai.com/log-in"}
            diagnostics = getattr(engine, "_apple_diagnostics", None)
            slot = "signup" if url == endpoints["signup"] else "password" if url == endpoints["register"] else None
            if slot is not None:
                response, evidence, classification = self.observe_flow_request(engine, task_uuid, session, slot, original_post, url, *args, **kwargs)
                if slot == "signup":
                    # The wrapper below validates the response before the
                    # original algorithm can enter its password/login branch.
                    engine._apple_signup_evidence = evidence
                    engine._apple_signup_admitted = response_admitted(response, slot, evidence, response_class=classification)
                if (evidence.get("reason") == "upstream_error" and diagnostics is not None
                        and diagnostics.active is not None):
                    error_kind = evidence["responseDetails"]["errorKind"]
                    if error_kind in {"account_creation_failed", "user_exists"}:
                        diagnostics.active["errorKind"] = error_kind
                if slot == "password" and not response_admitted(response, slot, evidence, response_class=classification):
                    raise ValueError("密码响应未通过校验，已停止验证码和账号创建；请核对原任务")
            else:
                response = (diagnostics.request(original_post, url, *args, **kwargs)
                            if diagnostics is not None else original_post(url, *args, **kwargs))
            if (url == endpoints.get("create_account") and getattr(response, "status_code", None) == 200
                    and not confirms_account_creation(url, response)):
                # The official side effect may already have happened. Raising
                # keeps the existing lease and unknown-result recovery guard;
                # it must never become an invitation to create another account.
                raise ValueError("官网创建响应无法确认，请核对原任务；不要重复注册")
            return response

        session.get, session.post = get, post
        session._id_apple_get = True
        session._id_apple_post = True

    def observe_engine(self, engine, provider):
        context = provider.context
        task_uuid = context["taskUuid"]

        class TransportStopped(BaseException):
            # Instance-local control flow, never a public exception or record.
            # BaseException escapes only the upstream broad retry catches; the
            # engine-step boundaries below immediately normalize it again.
            def __init__(self, kind, http_status):
                super().__init__("注册流程已停止")
                self.kind, self.http_status = kind, http_status

        def halt_transport(kind, http_status=None):
            if kind not in {"http_rejected", "evidence_storage_error"}:
                raise ValueError("注册停止原因无效")
            status = http_status if type(http_status) is int and 100 <= http_status <= 599 else None
            state = getattr(engine, "_apple_transport_stop_state", None)
            if state is None:
                state = engine._apple_transport_stop_state = (kind, status)
            if state[0] == "evidence_storage_error":
                engine._apple_evidence_storage_failed = True
            diagnostics = getattr(engine, "_apple_diagnostics", None)
            if diagnostics is not None and diagnostics.active is not None:
                diagnostics.active["httpStatus"] = state[1]
                if state[0] == "evidence_storage_error":
                    diagnostics.active["errorKind"] = state[0]
                elif diagnostics.active.get("errorKind") not in {"account_creation_failed", "user_exists"}:
                    # Keep the existing firstFailure meaning for HTTP 200;
                    # its explicit refusal remains in v4 responseClass.
                    diagnostics.active["errorKind"] = "http_rejected" if state[1] is not None and state[1] >= 400 else "unknown"
            raise TransportStopped(*state)

        def normalize_transport_stop(original, check_stopped=True, password_step=False):
            def call(*args, **kwargs):
                try:
                    state = getattr(engine, "_apple_transport_stop_state", None)
                    if check_stopped and state is not None:
                        halt_transport(*state)
                    return original(*args, **kwargs)
                except TransportStopped as error:
                    if error.kind == "evidence_storage_error":
                        raise EvidenceStorageError(error.http_status) from None
                    if password_step:
                        # Keep the original password step's failure contract;
                        # the stop state still blocks every later transport.
                        return False, None
                    raise ValueError("官网明确拒绝本次流程，已停止后续请求；请核对任务诊断") from None
            return call

        engine._apple_halt_transport = halt_transport
        if hasattr(engine, "oauth_manager") and context.get("email"):
            self.store.configuration_checkpoint(task_uuid, engine.oauth_manager.client_id, engine.proxy_url)
            try:
                if not self.store.record_configuration_summary(task_uuid, configuration_summary(engine)):
                    raise EvidenceStorageError()
            except Exception:
                raise EvidenceStorageError() from None
        if context.get("generic"):
            original_email = engine._create_email

            def create_email(*args, **kwargs):
                result = original_email(*args, **kwargs)
                if result and not context.get("authorizationOnly"):
                    self.store.bind_provider(task_uuid, context, engine)
                    self.store.configuration_checkpoint(task_uuid, engine.oauth_manager.client_id, engine.proxy_url)
                    try:
                        if not self.store.record_configuration_summary(task_uuid, configuration_summary(engine)):
                            raise EvidenceStorageError()
                    except Exception:
                        raise EvidenceStorageError() from None
                return result

            engine._create_email = create_email
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
                    if context.get("email"):
                        self.store.observe(context["email"], context["taskUuid"], attemptIp=address, attemptCountry=country)
                    else:
                        context.update(attemptIp=address, attemptCountry=country)
                except (ValueError, HTTPException):
                    pass
            return response

        engine.http_client.get = get
        original_client_post = engine.http_client.post
        endpoints = importlib.import_module("src.core.register").OPENAI_API_ENDPOINTS

        def client_post(url, *args, **kwargs):
            if url != endpoints["sentinel"]:
                return original_client_post(url, *args, **kwargs)
            engine._apple_sentinel_evidence = None
            engine._apple_sentinel_session = None
            engine._apple_sentinel_admitted = False
            diagnostics = getattr(engine, "_apple_diagnostics", None)
            # Force the existing observer to guard this exact session before
            # frozen HTTPClient.request makes any of its physical attempts.
            engine.http_client.session
            return (diagnostics.capture(original_client_post, url, *args, **kwargs)
                    if diagnostics is not None else original_client_post(url, *args, **kwargs))

        engine.http_client.post = client_post
        original_signup, original_send = engine._submit_signup_form, engine._send_verification_code
        original_create, original_mark = engine._create_user_account, engine._mark_email_as_registered

        if hasattr(engine, "_check_sentinel"):
            original_sentinel = engine._check_sentinel

            def sentinel(*args, **kwargs):
                # Upstream catches transport/JSON errors and then continues.
                # Enforce this decision outside that catch, on the same session.
                engine._apple_sentinel_evidence = None
                engine._apple_sentinel_session = None
                engine._apple_sentinel_admitted = False
                result = original_sentinel(*args, **kwargs)
                evidence = engine._apple_sentinel_evidence
                if (not isinstance(evidence, dict) or evidence.get("decision") != "accepted"
                        or not getattr(engine, "_apple_sentinel_admitted", False)
                        or engine._apple_sentinel_session is not engine.session
                        or not isinstance(result, str) or not result.strip()):
                    raise ValueError("官网前置安全校验未通过，已停止提交邮箱和密码；请查看任务诊断")
                return result

            engine._check_sentinel = sentinel

        def signup(*args, **kwargs):
            evidence = getattr(engine, "_apple_sentinel_evidence", None)
            if (not isinstance(evidence, dict) or evidence.get("decision") != "accepted"
                    or not getattr(engine, "_apple_sentinel_admitted", False)
                    or getattr(engine, "_apple_sentinel_session", None) is not engine.session):
                raise ValueError("官网前置安全校验未通过，不能提交邮箱或密码")
            provider.otp_lower_bound = time.time()
            if not self.store.update_task(task_uuid, stage="signup"):
                raise ValueError("邮箱占用已变化，不能继续注册")
            engine._apple_signup_evidence = None
            engine._apple_signup_admitted = False
            result = original_signup(*args, **kwargs)
            evidence = engine._apple_signup_evidence
            if (result.success and (not isinstance(evidence, dict) or evidence.get("decision") != "accepted"
                    or not getattr(engine, "_apple_signup_admitted", False)
                    or evidence.get("pageKind") != ("existing_account" if result.is_existing_account else "new_account")
                    or result.page_type != ("email_otp_verification" if result.is_existing_account else "password"))):
                result.success = False
                result.error_message = "注册前置响应未通过校验，未提交密码或继续登录"
                return result
            if context.get("authorizationOnly") and not result.is_existing_account:
                result.success = False
                result.error_message = "官网未返回已有账号登录验证，请人工核对；未再次注册"
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
            if context.get("authorizationOnly"):
                raise ValueError("授权续接不能再次创建账号")
            if not self.store.update_task(task_uuid, stage="create_account", sideEffectPossible=True):
                raise ValueError("邮箱占用已变化，不能创建账号")
            result = original_create(*args, **kwargs)
            if result:
                if not self.store.update_task(task_uuid, creationConfirmed=True):
                    raise ValueError("迟到的账号创建结果已隔离，请核对")
                self.store.registered(context["email"], context["taskUuid"], existing=False)
                self.persist_created_account(task_uuid, engine)
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
                    with self.sessions.get_db() as db:
                        _, binding = self.store.task_data(db, task_uuid)
                    if binding.get("creationConfirmed"):
                        result.source = "register"
                        result.password = binding.get("passwordCheckpoint") or result.password
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

        # None of the private stop signals may escape into the task runner.
        # Ordinary exceptions retain their original retry/return contracts.
        for name in ("_check_ip_location", "_get_device_id", "_check_sentinel", "_submit_signup_form", "_register_password", "run"):
            original = getattr(engine, name, None)
            if callable(original):
                setattr(engine, name, normalize_transport_stop(original, check_stopped=name != "run",
                                                               password_step=name == "_register_password"))
        diagnostic_store = DeferredDiagnosticsStore(self.store, context) if context.get("generic") else self.store
        engine._apple_diagnostics = RegistrationDiagnostics(diagnostic_store, task_uuid)
        engine._apple_diagnostics.install(engine)

    def persist_created_account(self, task_uuid, engine):
        """Save a real minimal row as soon as the official create call succeeds.

        Missing OAuth identifiers and tokens stay NULL. The engine-assigned
        SQLite row ID is the only upstream identifier passed to the mirror.
        """
        with self.store.transaction() as db:
            task_row, binding = self.store.task_data(db, task_uuid)
            if (not binding.get("creationConfirmed") or not binding.get("passwordCheckpoint")
                    or self.store.current(db, task_uuid, binding) is None):
                raise ValueError("官网创建事实或密码检查点需要核对")
            if binding.get("schemaVersion") != 2 and not binding.get("syncPayload"):
                record = self.store.current(db, task_uuid, binding)
                if not binding.get("operatorId") or not binding.get("mirrorAccountId"):
                    raise ValueError("历史任务来源不完整，请先核对")
                observed_at = (record.get("registeredAt") or record.get("markedAt")) if (
                    record.get("source") == "automatic" and record.get("registrationEvidenceTaskUuid") == task_uuid) else None
                binding.update(schemaVersion=2, provider="apple_hidden", creationConfirmedAt=observed_at)
                task_row.value = json.dumps(binding, ensure_ascii=False)
            account = db.query(self.models.Account).filter(func.lower(self.models.Account.email) == binding["email"]).first()
            if account is not None and (account.extra_data or {}).get("idSourceTaskUuid") != task_uuid:
                raise ValueError("邮箱已有其他来源账号，请核对")
            if account is None:
                snapshot = binding.get("configurationCheckpoint") or {}
                account = self.models.Account(email=binding["email"], password=binding["passwordCheckpoint"],
                          client_id=snapshot.get("clientId"), proxy_used=snapshot.get("proxyUsed"),
                          email_service=engine.email_service.service_type.value,
                          email_service_id=(engine.email_info or {}).get("service_id"), source="register", status="expired",
                          registered_at=(datetime.fromisoformat(binding["creationConfirmedAt"].replace("Z", "+00:00")).replace(tzinfo=None)
                                         if binding.get("creationConfirmedAt") else null()),
                          extra_data={"idSourceTaskUuid": task_uuid, "idAuthorizationStatus": "pending"})
                db.add(account)
                db.flush()
            account_id = account.id
        from types import SimpleNamespace
        raw = {key: None for key in RESULT_FIELDS}
        raw.update(success=False, email=binding["email"], password=binding["passwordCheckpoint"], source="register",
                   metadata={"idSourceTaskUuid": task_uuid, "idAuthorizationStatus": "pending"})
        identity = {"identityStatus": "awaiting_identity", "reason": "identity_missing", "identityEvidence": None}
        self.store.update_task(task_uuid, rawResult=raw, localSaveStatus="saved", **identity)
        account = SimpleNamespace(id=account_id, email=binding["email"], extra_data={"idSourceTaskUuid": task_uuid})
        self.store.account_saved(task_uuid, account, identity)

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
            # Complete the same minimal row; never create a second account or
            # silently accept an old row without saving the new credentials.
            for name in ("password", "access_token", "refresh_token", "id_token", "session_token", "account_id", "workspace_id"):
                value = getattr(result, name, None)
                if value:
                    setattr(original, name, value)
            original.extra_data = {**(original.extra_data or {}), **(result.metadata or {}),
                                   "idAuthorizationStatus": "complete"}
            original.status = "active"
        if not self.store.account_saved(task_uuid, account, identity):
            raise ValueError("邮箱占用已变化，迟到保存结果需要核对")
        return True

    def local_save_retry(self, task_uuid):
        if self.live(task_uuid):
            raise HTTPException(409, "原任务仍在执行，请稍后核对")
        with self.sessions.get_db() as db:
            _, data = self.store.task_data(db, task_uuid)
            if self.store.current(db, task_uuid, data) is None or not (data.get("rawResult") or data.get("creationConfirmed")):
                raise HTTPException(409, "原任务资料不满足恢复条件")
            raw = dict(data["rawResult"]) if data.get("rawResult") else {key: None for key in RESULT_FIELDS}
            if not data.get("rawResult"):
                raw.update(success=False, email=data["email"], password=data.get("passwordCheckpoint"), source="register",
                           metadata={"idSourceTaskUuid": task_uuid})
        if not raw.get("success") and not data.get("creationConfirmed"):
            raise HTTPException(409, "原注册尚未取得成功结果或官网创建事实")
        if data.get("localSaveStatus") == "saved" and self.persisted_account(data["email"]) is None:
            self.store.update_task(task_uuid, syncStatus="conflict", syncErrorKind="deleted_account", reason="deleted_account")
            raise HTTPException(409, "原账号已删除，不能通过补存恢复")
        # Only replay the account-save method. Registration, OTP, uploads and
        # subscription operations are never called by this recovery endpoint.
        context = {"taskUuid": task_uuid, "email": data["email"], "aliasId": data["aliasId"],
                   "integration": self, "cancelled": False, "startedAt": time.time()}
        provider = self.recovery_provider(context, data)
        engine = self.route.RegistrationEngine(provider, task_uuid=task_uuid)
        engine.email_info = {"email": data["email"], "service_id": data["aliasId"]}
        snapshot = data.get("configurationCheckpoint")
        if not snapshot:
            raise HTTPException(409, "原执行配置未完整保留，请先核对")
        engine.proxy_url = snapshot.get("proxyUsed")
        registration = importlib.import_module("src.core.register")
        result = registration.RegistrationResult(**raw)
        try:
            if raw.get("success"):
                if data.get("provider", "apple_hidden") == "apple_hidden":
                    engine.save_to_database(result)
                else:
                    identity = {key: data.get(key) for key in ("identityStatus", "identityEvidence", "reason")}
                    self.persist_result(task_uuid, result, engine.save_to_database, identity)
            else:
                self.persist_created_account(task_uuid, engine)
        except Exception:
            raise HTTPException(409, "原注册结果仍未可靠保存，请核对保存状态") from None
        return {"accepted": True, "task": self.task(task_uuid)}

    async def resume_authorization(self, task_uuid):
        if self.live(task_uuid):
            raise HTTPException(409, "原任务仍在执行，请稍后核对")
        with self.sessions.get_db() as db:
            _, checkpoint = self.store.task_data(db, task_uuid)
            if "browserRegistration" in checkpoint:
                raise HTTPException(409, "历史浏览器注册任务不能切换服务器执行器续接")
            if (self.store.current(db, task_uuid, checkpoint) is None or not checkpoint.get("creationConfirmed")
                    or not checkpoint.get("passwordCheckpoint") or not checkpoint.get("configurationCheckpoint")):
                raise HTTPException(409, "只有原官网创建确认且检查点完整的任务可以续接授权")
        # Historical OAuth failures may predate the minimal-account save.
        # Restore that original checkpoint before any new network request.
        if checkpoint.get("localSaveStatus") != "saved":
            await asyncio.to_thread(self.local_save_retry, task_uuid)
        with self.store.transaction() as db:
            if self.live(task_uuid):
                raise HTTPException(409, "原任务已在执行，请勿重复续接")
            _, data = self.store.task_data(db, task_uuid)
            record = self.store.current(db, task_uuid, data)
            if (record is None or not data.get("creationConfirmed") or not data.get("passwordCheckpoint")
                    or not data.get("configurationCheckpoint")):
                raise HTTPException(409, "只有原官网创建确认且检查点完整的任务可以续接授权")
            if data.get("provider", "apple_hidden") != "apple_hidden" and not data.get("providerCheckpoint"):
                raise HTTPException(409, "原邮箱服务检查点不完整，请人工核对")
            if data.get("identityStatus") == "verified":
                raise HTTPException(409, "原账号已完成身份核验，无需重新授权")
            record.update(activeTaskUuid=task_uuid, taskStatus="pending", stage="oauth", reason=None)
            self.store.write(db, record)
            task = db.query(self.models.RegistrationTask).filter_by(task_uuid=task_uuid).first()
            if task is not None:
                task.status = "pending"
            proxy = data["configurationCheckpoint"].get("proxyUsed")
        context = {"taskUuid": task_uuid, "email": data["email"], "aliasId": data["aliasId"],
                   "integration": self, "startedAt": time.time(), "cancelled": False, "authorizationOnly": True}
        with self.lock:
            self.contexts[task_uuid] = context

        async def execute():
            try:
                await asyncio.to_thread(self.run_authorization_task, context, data, proxy)
            finally:
                self.store.finish(context["email"], task_uuid, context["cancelled"])
                with self.lock:
                    self.contexts.pop(task_uuid, None)
                    self.jobs.pop(task_uuid, None)

        self.jobs[task_uuid] = asyncio.create_task(execute())
        return {"accepted": True, "taskUuid": task_uuid,
                "record": self.public_record(self.store.records([data["email"]])[0]), "task": self.task(task_uuid)}

    def run_authorization_task(self, context, binding, proxy):
        task_uuid = context["taskUuid"]
        _context.task = context
        with self.lock:
            self.running_threads.add(task_uuid)
        try:
            provider = self.recovery_provider(context, binding)
            engine = self.route.RegistrationEngine(provider, proxy_url=proxy, task_uuid=task_uuid,
                     callback_logger=self.task_manager.create_log_callback(task_uuid))
            engine.oauth_manager.client_id = binding["configurationCheckpoint"]["clientId"]
            result = engine.run()
            if result.success:
                engine.save_to_database(result)
            with self.store.transaction() as db:
                task = db.query(self.models.RegistrationTask).filter_by(task_uuid=task_uuid).first()
                if task is not None:
                    task.status = "completed" if result.success else "failed"
                    task.completed_at = datetime.now(timezone.utc).replace(tzinfo=None)
                    task.error_message = None if result.success else "授权尚未完成，官网创建事实与密码已保留"
            self.task_manager.update_status(task_uuid, "completed" if result.success else "failed")
        except Exception:
            with self.store.transaction() as db:
                task = db.query(self.models.RegistrationTask).filter_by(task_uuid=task_uuid).first()
                if task is not None:
                    task.status = "failed"
                    task.error_message = "授权续接未完成，原账号资料已保留，请核对后重试"
            self.task_manager.update_status(task_uuid, "failed", error="授权续接未完成，请核对后重试")
        finally:
            _context.task = None
            with self.lock:
                self.running_threads.discard(task_uuid)

    def recovery_provider(self, context, binding):
        if binding.get("provider", "apple_hidden") == "apple_hidden":
            return AppleHiddenMailboxProvider(self, context)
        context["generic"] = True
        snapshot = binding["providerCheckpoint"]
        provider = EmailServiceFactory.create(EmailServiceType(snapshot["serviceType"]), snapshot["config"])
        email_info = dict(snapshot["emailInfo"])
        if normalize_email(email_info.get("email", "")) != context["email"]:
            raise ValueError("原邮箱身份不一致")
        provider.create_email = lambda config=None: dict(email_info)
        if hasattr(provider, "_email_cache"):
            provider._email_cache[context["email"]] = email_info
        if hasattr(provider, "_emails_cache"):
            provider._emails_cache[email_info.get("service_id") or email_info.get("id")] = email_info
        return provider

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
                if self.contexts.get(task_uuid, {}).get("generic"):
                    continue
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

    def account_summaries(self, identifiers):
        result = {}
        with self.sessions.get_db() as db:
            for identifier in identifiers:
                account = db.get(self.models.Account, identifier)
                task_uuid = (account.extra_data or {}).get("idSourceTaskUuid") if account is not None else None
                if not task_uuid:
                    continue
                row = db.get(self.models.Setting, TASK_PREFIX + task_uuid)
                if row is None:
                    continue
                binding = json.loads(row.value)
                record = self.store.current(db, task_uuid, binding)
                result[identifier] = {"sourceTaskUuid": task_uuid, "provider": binding.get("provider", "apple_hidden"),
                    "creationConfirmed": bool(binding.get("creationConfirmed")),
                    "authorizationStatus": "complete" if binding.get("identityStatus") == "verified" else "pending",
                    "syncStatus": binding.get("syncStatus", "not_started"),
                    "taskRunning": self.live(task_uuid),
                    "systemAccountId": binding.get("systemAccountId"),
                    "canResume": bool(record is not None and not self.live(task_uuid) and binding.get("creationConfirmed")
                        and binding.get("passwordCheckpoint") and binding.get("identityStatus") != "verified"),
                    "canRetrySync": bool(record is not None and not self.live(task_uuid)
                        and binding.get("syncStatus") in {"failed", "pending", "awaiting_identity"})}
        return result

    def install_adapters(self):
        # Install global dispatch wrappers once. The integration object is held
        # only in a private thread-local context for a known leased task.
        if not getattr(EmailServiceFactory, "_id_apple_adapter", False):
            factory = EmailServiceFactory.create.__func__

            def create(cls, service_type, config, name=None):
                context = getattr(_context, "task", None)
                if context is not None and not context.get("generic") and service_type == EmailServiceType.TEMP_MAIL:
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
                else:
                    context = getattr(_context, "task", None)
                    if context is not None and context.get("generic"):
                        from types import SimpleNamespace
                        context["integration"].observe_engine(engine, SimpleNamespace(context=context, otp_lower_bound=None))

            engine_class.__init__ = initialize
            engine_class._id_apple_adapter = True
        if not getattr(self.route._run_sync_registration_task, "_id_apple_adapter", False):
            original_run = self.route._run_sync_registration_task

            def run(task_uuid, *args, **kwargs):
                integrations = getattr(self.route, "_id_apple_integrations", [])
                for candidate in integrations:
                    reject_browser_protocol_task(candidate, task_uuid)
                integration = next((item for item in integrations if task_uuid in item.contexts), None)
                if integration is None:
                    integration = next((item for item in integrations if task_uuid in item.generic_actors), None)
                    if integration is None:
                        raise ValueError("注册任务缺少可信操作人，不能执行")
                    context = {"taskUuid": task_uuid, "operatorId": integration.generic_actors[task_uuid],
                               "integration": integration, "generic": True, "email": None,
                               "startedAt": time.time(), "cancelled": False}
                    integration.contexts[task_uuid] = context
                context = integration.contexts[task_uuid]
                _context.task = context
                with integration.lock:
                    integration.running_threads.add(task_uuid)
                try:
                    if context.get("email"):
                        integration.store.observe(context["email"], task_uuid, taskStatus="running")
                    return original_run(task_uuid, *args, **kwargs)
                finally:
                    if context.get("generic"):
                        if context.get("email"):
                            integration.store.finish(context["email"], task_uuid, False)
                        integration.contexts.pop(task_uuid, None)
                        integration.generic_actors.pop(task_uuid, None)
                    _context.task = None
                    with integration.lock:
                        integration.running_threads.discard(task_uuid)

            run._id_apple_adapter = True
            self.route._run_sync_registration_task = run
            self.route._id_apple_integrations = []
        self.route._id_apple_integrations.append(self)
        if not getattr(self.route.run_registration_task, "_id_actor_adapter", False):
            original_async_run = self.route.run_registration_task

            async def async_run(task_uuid, *args, **kwargs):
                actor = execution_actor.get()
                integrations = getattr(self.route, "_id_apple_integrations", [])
                for candidate in integrations:
                    reject_browser_protocol_task(candidate, task_uuid)
                integration = next((item for item in integrations if task_uuid in item.contexts), None)
                if integration is None and actor:
                    integration = integrations[-1]
                    integration.generic_actors[task_uuid] = safe_id(actor)
                return await original_async_run(task_uuid, *args, **kwargs)

            async_run._id_actor_adapter = True
            self.route.run_registration_task = async_run

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

    @app.post(base + "/manual-sync-prepare")
    async def manual_sync_prepare(request: ManualSyncPrepare):
        return {"record": integration.public_record(integration.store.manual_sync_prepare(request))}

    @app.post(base + "/manual-sync-ack")
    async def manual_sync_ack(request: ManualSyncAck):
        return {"record": integration.public_record(integration.store.manual_sync_ack(request))}

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
        return integration.store.sync_ack(task_uuid, request.accountId, request.status, request.errorKind, request.fingerprint)

    @app.post(base + "/tasks/{task_uuid}/sync-retry")
    async def sync_retry(task_uuid: str):
        return await asyncio.to_thread(integration.sync_retry, task_uuid)

    @app.post(base + "/tasks/{task_uuid}/local-save-retry")
    async def local_save_retry(task_uuid: str):
        return await asyncio.to_thread(integration.local_save_retry, task_uuid)

    @app.post(base + "/tasks/{task_uuid}/authorization-resume")
    async def resume_authorization(task_uuid: str):
        return await integration.resume_authorization(task_uuid)

    def native_task_owner(task_uuid):
        with sessions.get_db() as db:
            _, binding = integration.store.task_data(db, task_uuid)
            if not execution_actor.get() or binding.get("operatorId") != execution_actor.get():
                raise HTTPException(403, "仅原任务操作人可以恢复注册结果")

    @app.post("/api/registration/tasks/{task_uuid}/authorization-resume")
    async def native_resume_authorization(task_uuid: str):
        native_task_owner(task_uuid)
        return await integration.resume_authorization(task_uuid)

    @app.post("/api/registration/tasks/{task_uuid}/sync-retry")
    async def native_sync_retry(task_uuid: str):
        native_task_owner(task_uuid)
        return await asyncio.to_thread(integration.sync_retry, task_uuid)

    @app.post("/api/registration/tasks/{task_uuid}/local-save-retry")
    async def native_local_save_retry(task_uuid: str):
        native_task_owner(task_uuid)
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
