"""Private, leased browser registration. Never runs the protocol executor.

Only the authenticated Nest bridge can claim a task. Browser facts alone are
insufficient: credentials are independently checked against an official account
before the existing encrypted save and synchronization path is used.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import importlib
import ipaddress
import json
import re
import secrets
from types import SimpleNamespace
from typing import Literal
from urllib.parse import urlsplit
import uuid

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator, model_validator

from apple_closed_loop import verify_identity

EVENTS = frozenset({"browser_opened", "email_submitting", "password_submitting",
    "email_code_required", "profile_required", "human_verification_required", "official_identity_observed"})
TERMINAL = frozenset({"completed", "failed", "cancelled", "expired", "interrupted"})
PHASES = EVENTS | TERMINAL | {"waiting_for_browser", "claimed", "identity_verifying"}
FAILURES = frozenset({"browser_unavailable", "browser_disconnected", "official_rejected", "existing_account",
    "human_verification_required", "identity_missing", "identity_mismatch", "flow_changed", "timeout",
    "cancelled", "connector_error"})
STAGE = {"browser_opened": "signup", "email_submitting": "signup", "password_submitting": "password",
    "email_code_required": "verification_code", "profile_required": "create_account",
    "human_verification_required": "signup", "official_identity_observed": "identity"}
CHECKPOINT_FIELDS = {"version", "phase", "expiresAt", "claimIdHash", "sequence", "lastEvent", "lastEventHash", "profileId",
    "passwordAcknowledged", "browserOpened", "emailSubmitted", "failureReason", "creationEvidence"}


def timestamp():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_time(value):
    if not isinstance(value, str) or len(value) > 40:
        raise ValueError("时间无效")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("时间必须带时区")
    return result.astimezone(timezone.utc)


def validate_checkpoint(value):
    """Closed persistence format, also used by read-only release validation."""
    if (not isinstance(value, dict) or set(value) != CHECKPOINT_FIELDS or type(value.get("version")) is not int or value["version"] != 1
            or value.get("phase") not in PHASES or type(value.get("sequence")) is not int
            or not 0 <= value["sequence"] <= 1000 or value.get("lastEvent") not in EVENTS | {None}
            or value.get("failureReason") not in FAILURES | {None}
            or any(type(value.get(key)) is not bool for key in ("passwordAcknowledged", "browserOpened", "emailSubmitted"))
            or (value.get("claimIdHash") is not None and (not isinstance(value["claimIdHash"], str)
                or not re.fullmatch(r"[0-9a-f]{64}", value["claimIdHash"])))
            or (value.get("lastEventHash") is not None and (not isinstance(value["lastEventHash"], str)
                or not re.fullmatch(r"[0-9a-f]{64}", value["lastEventHash"])))
            or (value.get("profileId") is not None and (not isinstance(value["profileId"], str)
                or not re.fullmatch(r"[A-Za-z0-9_-]{1,191}", value["profileId"])))):
        raise ValueError("浏览器检查点无效")
    parse_time(value["expiresAt"])
    evidence = value.get("creationEvidence")
    if evidence is not None:
        CreationEvidence.model_validate(evidence)


class PrivateInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    claimId: str = Field(pattern=r"^[0-9a-f]{64}$")


class EventInput(PrivateInput):
    event: Literal["browser_opened", "email_submitting", "password_submitting", "email_code_required",
                   "profile_required", "human_verification_required", "official_identity_observed"]
    sequence: StrictInt = Field(ge=1, le=1000)
    profileId: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,191}$")
    directConnection: bool | None = None
    attemptIp: str | None = None
    attemptCountry: str | None = Field(default=None, pattern=r"^[A-Z]{2}$")
    observationSource: Literal["cloudflare_trace"] | None = None

    @field_validator("attemptIp")
    @classmethod
    def valid_observed_ip(cls, value):
        if value is None:
            return None
        # Browser observations use the same normalized IP representation as the
        # existing registration facts; URLs, ports and scoped IPv6 are invalid.
        if value != value.strip() or "%" in value:
            raise ValueError("观察到的出口 IP 无效")
        try:
            return str(ipaddress.ip_address(value))
        except ValueError:
            raise ValueError("观察到的出口 IP 无效") from None

    @model_validator(mode="after")
    def trace_observation(self):
        facts = (self.attemptIp, self.attemptCountry, self.observationSource)
        if any(value is not None for value in facts) and (self.event != "browser_opened" or any(value is None for value in facts)):
            raise ValueError("出口观察仅能在打开浏览器时完整提交")
        return self


class CodeInput(PrivateInput):
    after: str

    @field_validator("after")
    @classmethod
    def valid_after(cls, value):
        parse_time(value)
        return value


class SessionInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    accessToken: str | None = Field(default=None, min_length=1, max_length=32768)
    sessionToken: str | None = Field(default=None, min_length=1, max_length=32768)

    @model_validator(mode="after")
    def credentials(self):
        if not (self.accessToken or self.sessionToken):
            raise ValueError("缺少官网会话")
        for item in (self.accessToken, self.sessionToken):
            if item is not None and any(ord(char) < 33 or ord(char) == 127 for char in item):
                raise ValueError("官网会话格式无效")
        return self


class CreationEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    pathKind: Literal["create_account"]
    httpStatus: Literal[200, 201]
    noError: Literal[True]
    officialOrigin: Literal[True]

    @model_validator(mode="before")
    @classmethod
    def strict_facts(cls, value):
        if (not isinstance(value, dict) or type(value.get("httpStatus")) is not int
                or value.get("noError") is not True or value.get("officialOrigin") is not True):
            raise ValueError("创建证据格式无效")
        return value


class ResultInput(PrivateInput):
    email: str
    officialUserId: str = Field(min_length=1, max_length=191, pattern=r"^[A-Za-z0-9_|:-]+$")
    officialAccountId: str | None = Field(default=None, min_length=1, max_length=191, pattern=r"^[A-Za-z0-9_|:-]+$")
    creationObserved: Literal[True]
    creationStatus: Literal[200, 201]
    creationEvidence: CreationEvidence
    session: SessionInput
    profileId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,191}$")

    @model_validator(mode="before")
    @classmethod
    def strict_facts(cls, value):
        if (not isinstance(value, dict) or value.get("creationObserved") is not True
                or type(value.get("creationStatus")) is not int):
            raise ValueError("创建事实格式无效")
        return value

    @model_validator(mode="after")
    def creation_matches(self):
        if self.creationStatus != self.creationEvidence.httpStatus:
            raise ValueError("创建证据不一致")
        return self


class FailInput(PrivateInput):
    reason: Literal["browser_unavailable", "browser_disconnected", "official_rejected", "existing_account",
        "human_verification_required", "identity_missing", "identity_mismatch", "flow_changed", "timeout",
        "cancelled", "connector_error"]
    sideEffectPossible: bool
    profileId: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,191}$")
    stage: Literal["password", "verification_validate", "create_account", "signup"] | None = None
    httpStatus: StrictInt | None = Field(default=None, ge=400, le=599)

    @model_validator(mode="after")
    def official_rejection_diagnostic(self):
        if ((self.stage is None) != (self.httpStatus is None)
                or (self.stage is not None and self.reason != "official_rejected")):
            raise ValueError("官网拒绝诊断必须成对且属于官网拒绝结果")
        return self


def fixed_proxy(value):
    if value is None:
        return None
    try:
        parsed = urlsplit(value)
        if (not isinstance(value, str) or len(value) > 16384 or parsed.scheme not in {"http", "https", "socks5"}
                or not parsed.hostname or parsed.port is None or not 1 <= parsed.port <= 65535
                or parsed.path not in {"", "/"} or parsed.query or parsed.fragment
                or any(ord(char) < 33 or ord(char) == 127 for char in value)):
            raise ValueError()
    except (TypeError, ValueError):
        raise HTTPException(409, "浏览器注册需要有效的固定代理地址") from None
    return value


def public_summary(checkpoint, *, live=True):
    validate_checkpoint(checkpoint)
    phase = checkpoint["phase"]
    if phase not in TERMINAL:
        if parse_time(checkpoint["expiresAt"]) <= datetime.now(timezone.utc):
            phase = "expired"
        elif not live:
            phase = "interrupted"
    return {"phase": phase, "needAction": phase in {"human_verification_required", "profile_required"},
            **({"profileId": checkpoint["profileId"]} if checkpoint.get("profileId") else {})}


def advance_event(checkpoint, request, proxy):
    """Pure state transition. Commit this value before acknowledging an action."""
    validate_checkpoint(checkpoint)
    if checkpoint["phase"] in TERMINAL | {"identity_verifying"}:
        raise HTTPException(409, "浏览器任务已结束或正在核验")
    profile = checkpoint.get("profileId")
    event_hash = hashlib.sha256(json.dumps(request.model_dump(exclude={"claimId"}), sort_keys=True,
                                          separators=(",", ":")).encode()).hexdigest()
    if profile is not None and request.profileId != profile:
        raise HTTPException(409, "浏览器窗口与任务不一致")
    if request.sequence == checkpoint["sequence"]:
        if event_hash == checkpoint["lastEventHash"]:
            return dict(checkpoint)
        raise HTTPException(409, "事件序号已被其他事实使用")
    if request.sequence != checkpoint["sequence"] + 1:
        raise HTTPException(409, "浏览器事件顺序已变化")
    if request.event == "browser_opened":
        if checkpoint["browserOpened"] or not request.profileId or (proxy is None and request.directConnection is not True):
            raise HTTPException(409, "浏览器或直连确认不完整")
        if proxy is not None and request.directConnection is True:
            raise HTTPException(409, "浏览器连接方式与固定代理不一致")
    elif not checkpoint["browserOpened"] or not request.profileId:
        raise HTTPException(409, "浏览器尚未绑定任务")
    if request.event == "password_submitting" and (not checkpoint["emailSubmitted"] or checkpoint["passwordAcknowledged"]):
        raise HTTPException(409, "密码提交条件不满足，不能重复提交")
    if request.event == "official_identity_observed" and not checkpoint["passwordAcknowledged"]:
        raise HTTPException(409, "没有本次新注册的密码提交确认")
    value = {**checkpoint, "phase": request.event, "sequence": request.sequence,
             "lastEvent": request.event, "lastEventHash": event_hash, "profileId": request.profileId or profile}
    if request.event == "browser_opened":
        value["browserOpened"] = True
    if request.event == "email_submitting":
        value["emailSubmitted"] = True
    if request.event == "password_submitting":
        value["passwordAcknowledged"] = True
    return value


class BrowserRegistration:
    def __init__(self, integration, actor):
        self.integration, self.store, self.actor = integration, integration.store, actor
        self.code_waiters = set()

    def binding(self, db, task_uuid, claim_id=None, *, allow_terminal=False):
        row, data = self.store.task_data(db, task_uuid)
        state = data.get("browserRegistration")
        try:
            validate_checkpoint(state)
        except (TypeError, ValueError):
            raise HTTPException(409, "该任务不是有效的浏览器注册任务") from None
        if not self.actor.get() or data.get("operatorId") != self.actor.get():
            raise HTTPException(403, "仅原操作人可以操作浏览器注册任务")
        record = self.store.current(db, task_uuid, data)
        if record is None or (not allow_terminal and record.get("activeTaskUuid") != task_uuid):
            raise HTTPException(409, "原邮箱占用已变化")
        if claim_id is not None and state["claimIdHash"] != hashlib.sha256(claim_id.encode()).hexdigest():
            raise HTTPException(403, "浏览器认领凭据不一致")
        if not allow_terminal and (state["phase"] in TERMINAL
                or parse_time(state["expiresAt"]) <= datetime.now(timezone.utc)):
            raise HTTPException(409, "浏览器注册任务已结束或过期")
        if not allow_terminal:
            task = db.query(self.integration.models.RegistrationTask).filter_by(task_uuid=task_uuid).first()
            if task is None or task.status not in {"pending", "running"}:
                raise HTTPException(409, "注册任务已结束、取消或删除")
        return row, data, record, state

    def context(self, task_uuid):
        with self.integration.lock:
            context = self.integration.contexts.get(task_uuid)
            if (self.integration.stopping or context is None or not context.get("browserMode") or context["cancelled"]):
                raise HTTPException(409, "浏览器任务已中断，请核对原任务，不能重新注册")
            return context

    async def start(self, request):
        if not self.actor.get() or self.actor.get() != request.operatorId:
            raise HTTPException(403, "注册操作人不一致")
        if (request.options.auto_upload_cpa or request.options.auto_upload_sub2api or request.options.auto_upload_tm):
            raise HTTPException(400, "浏览器注册不执行自动上传")
        with self.integration.lock:
            if self.integration.stopping or len(self.integration.contexts) >= 100:
                raise HTTPException(503, "注册任务较多，请稍后再试")
        proxy = await self.integration.execution_proxy(request.options)
        settings = importlib.import_module("src.config.settings").get_settings()
        if request.options.proxySource == "default" and proxy is None:
            with self.integration.sessions.get_db() as db:
                selected = self.integration.route.crud.get_random_proxy(db)
                proxy = selected.proxy_url if selected is not None else None
            if proxy is None:
                if settings.proxy_dynamic_enabled:
                    raise HTTPException(409, "请为浏览器注册选择一个可固定的代理资料")
                proxy = settings.proxy_url
        proxy = fixed_proxy(proxy)
        task_uuid = str(uuid.uuid4())
        state = {"version": 1, "phase": "waiting_for_browser",
            "expiresAt": (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat().replace("+00:00", "Z"),
            "claimIdHash": None, "sequence": 0, "lastEvent": None, "lastEventHash": None, "profileId": None,
            "passwordAcknowledged": False, "browserOpened": False, "emailSubmitted": False,
            "failureReason": None, "creationEvidence": None}
        # Reserve and freeze the browser mode in one transaction. An interrupted
        # start can never leave a task eligible for the original protocol route.
        with self.store.transaction() as db:
            record = self.store.reserve(request, task_uuid, db)
            db.flush()
            row, data = self.store.task_data(db, task_uuid)
            data.update(browserRegistration=state, configurationCheckpoint={"clientId": settings.openai_client_id,
                                                                          "proxyUsed": proxy})
            row.value = json.dumps(data, ensure_ascii=False)
        context = {"taskUuid": task_uuid, "email": request.email.strip().lower(), "aliasId": request.aliasId,
            "startedAt": datetime.now(timezone.utc).timestamp(), "cancelled": False,
            "integration": self.integration, "browserMode": True, "proxy": proxy,
            "expiresAt": state["expiresAt"]}
        with self.integration.lock:
            self.integration.contexts[task_uuid] = context
        return {"taskUuid": task_uuid, "record": self.integration.public_record(record),
                "browserRegistration": public_summary(state)}

    def claim(self, task_uuid, request):
        self.context(task_uuid)
        with self.store.transaction() as db:
            row, data, record, state = self.binding(db, task_uuid)
            digest = hashlib.sha256(request.claimId.encode()).hexdigest()
            if state["claimIdHash"] is not None and state["claimIdHash"] != digest:
                raise HTTPException(409, "浏览器任务已经被认领")
            if state["phase"] not in {"waiting_for_browser", "claimed"}:
                raise HTTPException(409, "原窗口已开始，请继续原窗口，不能重新打开")
            if not data.get("passwordCheckpoint"):
                data.update(passwordCheckpoint="Aa1!" + secrets.token_urlsafe(24), passwordSavedAt=timestamp(), passwordStatus="saved")
            state = {**state, "claimIdHash": digest, "phase": "claimed"}
            data["browserRegistration"] = state
            row.value = json.dumps(data, ensure_ascii=False)
            task = db.query(self.integration.models.RegistrationTask).filter_by(task_uuid=task_uuid).first()
            if task is None:
                raise HTTPException(409, "注册任务登记不完整")
            task.status = "running"
            record.update(taskStatus="running", passwordStatus="saved")
            self.store.write(db, record)
            result = {"taskUuid": task_uuid, "email": data["email"], "password": data["passwordCheckpoint"],
                      "proxy": data["configurationCheckpoint"]["proxyUsed"]}
        return result

    def event(self, task_uuid, request):
        context = self.context(task_uuid)
        with self.store.transaction() as db:
            row, data, record, state = self.binding(db, task_uuid, request.claimId)
            changed = advance_event(state, request, data["configurationCheckpoint"]["proxyUsed"])
            if changed == state:
                return {"accepted": True}
            data.update(browserRegistration=changed, stage=STAGE[request.event])
            if request.event == "password_submitting":
                if not data.get("passwordCheckpoint"):
                    raise HTTPException(409, "密码尚未持久保存")
                data.update(sideEffectPossible=True, passwordStatus="submitted")
                record["passwordStatus"] = "submitted"
            record["stage"] = data["stage"]
            row.value = json.dumps(data, ensure_ascii=False)
            if request.event == "browser_opened" and request.observationSource == "cloudflare_trace":
                # Reuse the existing fact writer inside this same transaction:
                # the ACK cannot precede the real browser exit observation.
                self.store.observe(context["email"], task_uuid, db=db, stage=data["stage"],
                                   attemptIp=request.attemptIp, attemptCountry=request.attemptCountry)
            else:
                self.store.write(db, record)
        if request.event == "browser_opened" and request.observationSource == "cloudflare_trace":
            context.update(attemptIp=request.attemptIp, attemptCountry=request.attemptCountry)
        return {"accepted": True}

    async def code(self, task_uuid, request):
        context = self.context(task_uuid)
        with self.integration.sessions.get_db() as db:
            _, data, _, state = self.binding(db, task_uuid, request.claimId)
            if state["phase"] != "email_code_required":
                raise HTTPException(409, "任务当前没有请求邮箱验证码")
            since = parse_time(request.after).timestamp()
            if not context["startedAt"] <= since <= datetime.now(timezone.utc).timestamp() + 1:
                raise HTTPException(400, "验证码查询时间不属于本任务")
        with self.integration.lock:
            if task_uuid in self.code_waiters:
                raise HTTPException(409, "验证码查询正在进行")
            self.code_waiters.add(task_uuid)
        try:
            code = await asyncio.to_thread(self.integration.wait_for_code, context, since, 12)
            if code is not None and not re.fullmatch(r"[0-9]{6}", code):
                raise HTTPException(409, "验证码查询结果需要核对")
            return {"code": code}
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(409, "邮箱验证码暂不可用，请核对邮箱服务") from None
        finally:
            with self.integration.lock:
                self.code_waiters.discard(task_uuid)

    def finish(self, task_uuid, request=None, *, cancelled=False):
        with self.integration.lock:
            return self._finish(task_uuid, request, cancelled=cancelled)

    def _finish(self, task_uuid, request=None, *, cancelled=False):
        # Cancellation also works after a worker restart/expiry. It never
        # restarts a browser, and finish retains every uncertain remote effect.
        with self.integration.lock:
            context = self.integration.contexts.get(task_uuid)
            if context and context.get("browserCommitting"):
                raise HTTPException(409, "注册结果正在可靠保存，请稍后核对")
        with self.store.transaction() as db:
            row, data, record, state = self.binding(db, task_uuid, request.claimId if request else None, allow_terminal=True)
            if state["phase"] in TERMINAL:
                return {"accepted": True}
            if request is not None and state.get("profileId") and request.profileId != state["profileId"]:
                raise HTTPException(409, "浏览器窗口与任务不一致")
            if request is not None and request.sideEffectPossible:
                data["sideEffectPossible"] = True
            state = {**state, "phase": "cancelled" if cancelled else "failed",
                     "failureReason": "cancelled" if cancelled else request.reason}
            if request is not None and state["profileId"] is None and request.profileId:
                # A local profile may have been created before its detail check
                # failed. Keep its identity for review; never delete it here.
                state["profileId"] = request.profileId
            data["browserRegistration"] = state
            row.value = json.dumps(data, ensure_ascii=False)
            task = db.query(self.integration.models.RegistrationTask).filter_by(task_uuid=task_uuid).first()
            if task is None:
                raise HTTPException(409, "注册任务登记不完整")
            task.status = "cancelled" if cancelled else "failed"
            task.completed_at = datetime.now(timezone.utc).replace(tzinfo=None)
            task.error_message = "浏览器注册已停止，请核对原任务，勿重复创建账号"
        if context:
            context["cancelled"] = True
        if request is not None and request.stage is not None:
            observed = datetime.now(timezone.utc).timestamp()
            elapsed_ms = max(0, int((observed - (context or {}).get("startedAt", observed)) * 1000))
            self.store.record_failure(task_uuid, request.stage, "http_rejected", request.httpStatus, elapsed_ms)
            self.store.observe(data["email"], task_uuid, lastHttpStatus=request.httpStatus)
        self.store.finish(data["email"], task_uuid, cancelled)
        self.cleanup(task_uuid)
        return {"accepted": True}

    def cleanup(self, task_uuid):
        with self.integration.lock:
            self.integration.contexts.pop(task_uuid, None)
            for pending in self.integration.requests.values():
                if pending["taskUuid"] == task_uuid:
                    pending["event"].set()

    def result(self, task_uuid, request):
        with self.integration.sessions.get_db() as db:
            _, saved, _, finished = self.binding(db, task_uuid, request.claimId, allow_terminal=True)
            if finished["phase"] == "completed":
                if (request.email.strip().lower() != saved["email"] or request.profileId != finished["profileId"]
                        or (saved.get("identityEvidence") or {}).get("officialUserIdHash") != hashlib.sha256(request.officialUserId.encode()).hexdigest()):
                    raise HTTPException(409, "注册结果回执与原任务不一致")
                return {"accepted": True, "task": self.integration.task(task_uuid)}
        context = self.context(task_uuid)
        with self.store.transaction() as db:
            row, data, _, state = self.binding(db, task_uuid, request.claimId)
            if (request.email.strip().lower() != data["email"] or request.profileId != state["profileId"]
                    or not state["passwordAcknowledged"] or not data.get("sideEffectPossible")
                    or state["phase"] != "official_identity_observed"):
                raise HTTPException(409, "缺少本次同窗口新建账号证据，不能作为注册成功")
            # A browser's successful creation response is an observed fact,
            # distinct from independently verified identity/registration. Keep
            # that closed evidence even if the following official read fails.
            data["browserRegistration"] = {**state, "phase": "identity_verifying",
                                           "creationEvidence": request.creationEvidence.model_dump()}
            data["stage"] = "identity"
            row.value = json.dumps(data, ensure_ascii=False)
            proxy, password = data["configurationCheckpoint"]["proxyUsed"], data["passwordCheckpoint"]
        from src.core.http_client import OpenAIHTTPClient
        client = None
        try:
            client = OpenAIHTTPClient(proxy_url=proxy)
            if request.session.sessionToken:
                client.session.cookies.set("__Secure-next-auth.session-token", request.session.sessionToken, domain="chatgpt.com")
            identity = verify_identity(client.session, data["email"], request.session.accessToken)
        except Exception:
            identity = {"identityStatus": "awaiting_identity", "reason": "identity_missing"}
        finally:
            if client is not None:
                try:
                    client.close()
                except Exception:
                    pass
        if (identity.get("identityStatus") != "verified" or not identity.get("identityEvidence")
                or identity["identityEvidence"].get("officialUserIdHash") != hashlib.sha256(request.officialUserId.encode()).hexdigest()):
            mismatch = identity.get("identityStatus") in {"verified", "mismatch"}
            self.store.update_task(task_uuid, identityStatus="mismatch" if mismatch else "awaiting_identity",
                                   reason="identity_mismatch" if mismatch else "identity_missing")
            # Retain the lease after a possible creation. A login-only browser
            # session can never be promoted to a new registration here.
            with self.store.transaction() as db:
                row, binding, _, state = self.binding(db, task_uuid, request.claimId)
                binding["browserRegistration"] = {**state, "phase": "failed", "failureReason": "identity_mismatch" if mismatch else "identity_missing"}
                row.value = json.dumps(binding, ensure_ascii=False)
                task = db.query(self.integration.models.RegistrationTask).filter_by(task_uuid=task_uuid).first()
                task.status = "failed"
                task.error_message = "官网账号身份核验未通过，请核对原浏览器窗口"
            self.store.finish(data["email"], task_uuid, False)
            self.cleanup(task_uuid)
            raise HTTPException(409, "官网账号身份核验未通过，原任务与占用已保留")
        # Recheck the claim/lease after the network read, before any registration
        # fact or credential is stored. Cancellation cannot admit a late result.
        with self.committing(task_uuid):
            return self.persist_verified(task_uuid, request, data, identity, proxy, password)

    @contextmanager
    def committing(self, task_uuid):
        with self.integration.lock:
            context = self.context(task_uuid)
            context["browserCommitting"] = True
        try:
            yield
        finally:
            # A failed disk commit must not turn the in-memory cancel guard
            # into a permanent latch. The encrypted lease remains authoritative.
            with self.integration.lock:
                if self.integration.contexts.get(task_uuid) is context:
                    context.pop("browserCommitting", None)

    def persist_verified(self, task_uuid, request, data, identity, proxy, password):
        from src.core.register import RegistrationResult
        with self.store.transaction() as db:
            row, binding, _, state = self.binding(db, task_uuid, request.claimId)
            if state["phase"] != "identity_verifying":
                raise HTTPException(409, "任务状态已变化，请核对原任务")
            binding["browserRegistration"] = {**state, "creationEvidence": request.creationEvidence.model_dump()}
            row.value = json.dumps(binding, ensure_ascii=False)
        self.store.registered(data["email"], task_uuid, existing=False, identity=identity)
        result = RegistrationResult(success=True, email=data["email"], password=password,
            account_id=request.officialAccountId or "", access_token=request.session.accessToken or "",
            session_token=request.session.sessionToken or "", source="register", metadata={"idSourceTaskUuid": task_uuid})
        if not self.store.capture_result(task_uuid, result, identity):
            raise HTTPException(409, "注册结果需要核对，原创建事实已保留")
        saver = SimpleNamespace(email_service=SimpleNamespace(service_type=SimpleNamespace(value="apple_hidden")),
            email_info={"service_id": data["aliasId"]}, proxy_url=proxy, _log=lambda *args, **kwargs: None)
        try:
            self.integration.persist_result(task_uuid, result,
                lambda value: self.integration.route.RegistrationEngine.save_to_database(saver, value), identity)
        except Exception:
            self.store.update_task(task_uuid, localSaveStatus="failed", reason="local_save_failed")
            self._complete(task_uuid, "failed", "connector_error")
            raise HTTPException(409, "官网创建与身份已确认，账号资料待原任务补存") from None
        self._complete(task_uuid, "completed", None)
        return {"accepted": True, "task": self.integration.task(task_uuid)}

    def _complete(self, task_uuid, phase, reason):
        with self.store.transaction() as db:
            row, data = self.store.task_data(db, task_uuid)
            state = data["browserRegistration"]
            data["browserRegistration"] = {**state, "phase": phase, "failureReason": reason}
            row.value = json.dumps(data, ensure_ascii=False)
            task = db.query(self.integration.models.RegistrationTask).filter_by(task_uuid=task_uuid).first()
            task.status = "completed" if phase == "completed" else "failed"
            task.completed_at = datetime.now(timezone.utc).replace(tzinfo=None)
            task.error_message = None if phase == "completed" else "官网创建已确认，资料待补存"
        self.store.finish(data["email"], task_uuid, False)
        self.cleanup(task_uuid)


def install_browser_registration(app, integration, start_model, actor):
    adapter = BrowserRegistration(integration, actor)
    integration.browser = adapter
    base = "/internal/apple-mailboxes/browser"

    # FastAPI's default validation detail includes the rejected input value.
    # Tokens and proxy credentials must never be echoed by this private bridge.
    from fastapi.exceptions import RequestValidationError
    from fastapi.exception_handlers import request_validation_exception_handler
    from fastapi.responses import JSONResponse
    previous_handler = app.exception_handlers.get(RequestValidationError, request_validation_exception_handler)

    async def validation_error(request, error):
        if request.url.path.startswith(base + "/"):
            return JSONResponse({"detail": "浏览器注册请求格式无效"}, status_code=422)
        return await previous_handler(request, error)

    app.add_exception_handler(RequestValidationError, validation_error)

    # The existing StartInput remains the single validated start contract.
    async def start(request):
        return await adapter.start(request)
    start.__annotations__["request"] = start_model
    app.post(base + "/start")(start)

    @app.post(base + "/tasks/{task_uuid}/claim")
    async def claim(task_uuid: str, request: PrivateInput):
        return await asyncio.to_thread(adapter.claim, task_uuid, request)

    @app.post(base + "/tasks/{task_uuid}/event")
    async def event(task_uuid: str, request: EventInput):
        return await asyncio.to_thread(adapter.event, task_uuid, request)

    @app.post(base + "/tasks/{task_uuid}/code")
    async def code(task_uuid: str, request: CodeInput):
        return await adapter.code(task_uuid, request)

    @app.post(base + "/tasks/{task_uuid}/result")
    async def result(task_uuid: str, request: ResultInput):
        return await asyncio.to_thread(adapter.result, task_uuid, request)

    @app.post(base + "/tasks/{task_uuid}/fail")
    async def fail(task_uuid: str, request: FailInput):
        return await asyncio.to_thread(adapter.finish, task_uuid, request)

    @app.post(base + "/tasks/{task_uuid}/cancel")
    async def cancel(task_uuid: str, request: PrivateInput):
        # Authenticate the bound claim before taking the normal cancel path.
        with integration.sessions.get_db() as db:
            adapter.binding(db, task_uuid, request.claimId)
        return await asyncio.to_thread(adapter.finish, task_uuid, cancelled=True)

    return adapter
