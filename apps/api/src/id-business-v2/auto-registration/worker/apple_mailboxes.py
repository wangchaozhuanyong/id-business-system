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
from pydantic import BaseModel, ConfigDict, Field, StrictInt
from sqlalchemy import text

from src.services.base import BaseEmailService, EmailServiceFactory, EmailServiceType

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
        "registrationStatus": "unknown", "revision": 0,
        "registrationIp": None, "registrationIpSource": None, "source": None,
        "markedAt": None, "operatorId": None, "note": "",
        "activeTaskUuid": None, "attemptIp": None, "attemptCountry": None,
        "registrationCountry": None, "lastTaskUuid": None,
        "lastResultKind": None, "taskStatus": None,
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


class StartInput(MailboxItem):
    operatorId: str


class MailResponse(Input):
    code: str | None
    mailId: str | None
    error: str | None = None


class RegistrationFacts:
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
            return empty_record(expected)
        try:
            record = json.loads(row.value)
            if (not isinstance(record, dict) or record.get("email") != expected
                    or record.get("registrationStatus") not in {"unknown", "unregistered", "registered"}
                    or type(record.get("revision")) is not int or record["revision"] < 1):
                raise ValueError()
            return {**empty_record(expected), **record}
        except (ValueError, TypeError):
            raise HTTPException(503, "隐藏邮箱登记资料需要核对") from None

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
                record.update(
                    aliasId=safe_id(item.aliasId), registrationStatus=request.registrationStatus,
                    registrationIp=address,
                    registrationIpSource="manual" if address is not None else None,
                    registrationCountry=None, source="manual", markedAt=now_iso(),
                    operatorId=operator_id, note=request.note.strip(),
                )
                records.append(self.write(db, record))
        return records

    def reserve(self, request: StartInput, task_uuid: str) -> dict[str, Any]:
        email, alias_id, operator_id = normalize_email(request.email), safe_id(request.aliasId), safe_id(request.operatorId)
        with self.transaction() as db:
            record = self.read(db, email)
            self.compare(record, request.revision)
            if record["activeTaskUuid"]:
                raise HTTPException(409, "该邮箱已有占用任务，请先核对")
            if record["registrationStatus"] != "unregistered":
                raise HTTPException(409, "请先核对并标记为未注册，已注册邮箱不能重复注册")
            record.update(aliasId=alias_id, operatorId=operator_id, activeTaskUuid=task_uuid,
                          lastTaskUuid=task_uuid, taskStatus="pending", lastResultKind=None,
                          attemptIp=None, attemptCountry=None, lastMailId=None)
            db.add(self.models.RegistrationTask(task_uuid=task_uuid, status="pending"))
            db.add(self.models.Setting(key=TASK_PREFIX + task_uuid, category="general",
                                       description="隐藏邮箱任务关联",
                                       value=json.dumps({"email": email, "aliasId": alias_id, "resultKind": None})))
            return self.write(db, record)

    def observe(self, email: str, task_uuid: str, **updates: Any) -> dict[str, Any]:
        with self.transaction() as db:
            record = self.read(db, email)
            if record["activeTaskUuid"] != task_uuid:
                raise HTTPException(409, "注册任务与邮箱占用不一致")
            record.update(updates)
            return self.write(db, record)

    def registered(self, email: str, task_uuid: str, existing: bool):
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
                task_fact.value = json.dumps(task_data)
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
            record.update(activeTaskUuid=None, taskStatus=status)
            if record["lastResultKind"] is None:
                record["lastResultKind"] = "failed"
            task_fact = db.get(self.models.Setting, TASK_PREFIX + task_uuid)
            if task_fact is not None:
                task_data = json.loads(task_fact.value)
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
        if record["activeTaskUuid"] and not self.live(record["activeTaskUuid"]):
            return {**record, "taskStatus": "interrupted"}
        return record

    async def start(self, request: StartInput):
        with self.lock:
            if self.stopping or len(self.contexts) >= 100:
                raise HTTPException(503, "注册任务较多，请稍后再试")
        task_uuid = str(uuid.uuid4())
        record = self.store.reserve(request, task_uuid)
        context = {"taskUuid": task_uuid, "aliasId": safe_id(request.aliasId), "email": normalize_email(request.email),
                   "startedAt": time.time(), "cancelled": False, "integration": self}
        with self.lock:
            self.contexts[task_uuid] = context

        async def execute():
            try:
                await self.route.run_registration_task(task_uuid, "temp_mail", None, {}, None)
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
                    "record": record, "resultKind": task_data["resultKind"]}

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

    def observe_engine(self, engine, provider):
        context = provider.context
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
            result = original_signup(*args, **kwargs)
            if result.is_existing_account:
                self.store.registered(context["email"], context["taskUuid"], existing=True)
            return result

        def send(*args, **kwargs):
            provider.otp_lower_bound = time.time()
            return original_send(*args, **kwargs)

        def create(*args, **kwargs):
            result = original_create(*args, **kwargs)
            if result:
                self.store.registered(context["email"], context["taskUuid"], existing=False)
            return result

        def mark(*args, **kwargs):
            result = original_mark(*args, **kwargs)
            self.store.registered(context["email"], context["taskUuid"], existing=True)
            return result

        engine._submit_signup_form, engine._send_verification_code = signup, send
        engine._create_user_account, engine._mark_email_as_registered = create, mark

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
