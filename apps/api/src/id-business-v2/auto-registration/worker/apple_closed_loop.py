"""Durable, encrypted checkpoints for the existing Apple mailbox adapter.

Only the worker's private API may read sync payloads. Public summaries use an
allowlist. Neither recovery nor synchronization invokes registration or uploads.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
from typing import Any
from urllib.parse import quote
import uuid

from fastapi import HTTPException

TASK_PREFIX = "id.apple-task."
BATCH_PREFIX = "id.apple-batch."
SYNC_ERRORS = {"email_conflict", "deleted_account", "storage_unavailable", "sync_failed",
               "identity_missing", "identity_mismatch", "local_save_failed", "payload_invalid"}
RESULT_FIELDS = {"success", "email", "password", "account_id", "workspace_id", "access_token",
                 "refresh_token", "id_token", "session_token", "source", "metadata"}
PUBLIC_FIELDS = {"localSaveStatus", "syncStatus", "systemAccountId", "syncErrorKind",
                 "identityStatus", "passwordStatus", "stage", "reason", "lastHttpStatus"}


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def fingerprint(payload):
    fields = {key: payload[key] for key in ("accountId", "sourceTaskUuid", "upstreamAccountId",
              "email", "registrationCountry", "source")}
    return hashlib.sha256(json.dumps(fields, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode("utf-8")).hexdigest()


def resolve_system_proxy(config):
    # Reuse the project's checked DNS/extraction implementation. No new network
    # endpoint, retry algorithm or proxy credential parser is introduced here.
    directory = Path(__file__).resolve().parents[2] / "auto-recharge" / "worker"
    if str(directory) not in sys.path:
        sys.path.append(str(directory))
    from server_proxy import resolve_proxy
    try:
        connection = resolve_proxy(config)
        server = connection["server"]
        username, password = connection.get("username", ""), connection.get("password", "")
        if username or password:
            scheme, address = server.split("://", 1)
            return f"{scheme}://{quote(username, safe='')}:{quote(password, safe='')}@{address}"
        return server
    except Exception:
        raise ValueError("所选系统代理暂不可用") from None


def verify_identity(session, expected_email, access_token=None):
    """Use the same official /api/auth/session contract as password recharge.

    OAuth tokens and unsigned JWTs are deliberately insufficient. The existing
    curl context often lacks a ChatGPT session cookie; that stays pending.
    """
    checks = []
    try:
        if session.cookies.get("__Secure-next-auth.session-token"):
            checks.append(("https://chatgpt.com/api/auth/session", {}, "official_session_response"))
    except Exception:
        pass
    if isinstance(access_token, str) and access_token:
        # Endpoint and Bearer contract already used by frozen token_refresh.py.
        # Unlike its status-only check, require the selected account's identity.
        checks.append(("https://chatgpt.com/backend-api/me", {
            "authorization": f"Bearer {access_token}", "accept": "application/json"}, "official_me_response"))
    for endpoint, headers, source in checks:
        try:
            response = session.get(endpoint, headers=headers, timeout=15, allow_redirects=False)
            if response.status_code != 200 or response.url != endpoint:
                continue
            data = response.json()
            if not isinstance(data, dict) or data.get("error"):
                continue
            user = data.get("user") if source == "official_session_response" else data
            if source == "official_session_response" and not data.get("accessToken"):
                continue
            if not isinstance(user, dict):
                continue
            identifier = user.get("id") or user.get("user_id")
            if not isinstance(identifier, str) or not identifier or not isinstance(user.get("email"), str):
                continue
            if user["email"].strip().lower() != expected_email.strip().lower():
                return {"identityStatus": "mismatch", "reason": "identity_mismatch"}
            return {"identityStatus": "verified", "reason": None, "identityEvidence": {
                "source": source, "emailMatched": True,
                "officialUserIdHash": hashlib.sha256(identifier.encode()).hexdigest(), "observedAt": now()}}
        except Exception:
            continue
    return {"identityStatus": "awaiting_identity", "reason": "identity_missing"}


class ClosedLoopFacts:
    """Mixin using RegistrationFacts' existing SQLite transaction and cipher."""

    def task_data(self, db, task_uuid):
        try:
            uuid.UUID(task_uuid)
        except (ValueError, TypeError):
            raise HTTPException(400, "任务标识无效") from None
        row = db.get(self.models.Setting, TASK_PREFIX + task_uuid)
        if row is None:
            raise HTTPException(404, "隐藏邮箱注册任务不存在")
        try:
            data = json.loads(row.value)
            if not isinstance(data, dict) or not isinstance(data.get("email"), str):
                raise ValueError()
            return row, data
        except (ValueError, TypeError):
            raise HTTPException(503, "任务登记需要核对") from None

    def current(self, db, task_uuid, data):
        record = self.read(db, data["email"])
        if (record.get("activeTaskUuid") == task_uuid or
                (not record.get("activeTaskUuid") and record.get("lastTaskUuid") == task_uuid)):
            return record
        return None

    def update_task(self, task_uuid, *, require_current=True, **updates):
        with self.transaction() as db:
            row, data = self.task_data(db, task_uuid)
            record = self.current(db, task_uuid, data)
            if require_current and record is None:
                # Keep bound late facts in their original encrypted task, but
                # never advance a different mailbox lease or its sync queue.
                data["lateFacts"] = (data.get("lateFacts", []) + [{"observedAt": now(), **updates}])[-4:]
                data["syncStatus"] = "quarantined"
                row.value = json.dumps(data, ensure_ascii=False)
                return False
            data.update(updates)
            row.value = json.dumps(data, ensure_ascii=False)
            if record is not None:
                record.update({key: value for key, value in updates.items() if key in PUBLIC_FIELDS})
                self.write(db, record)
            return True

    def password_checkpoint(self, task_uuid, generate):
        with self.transaction() as db:
            row, data = self.task_data(db, task_uuid)
            if self.current(db, task_uuid, data) is None:
                raise ValueError("任务占用已变化，不能提交密码")
            password = data.get("passwordCheckpoint")
            if password is None:
                password = generate()
                if not isinstance(password, str) or not password or len(password) > 255:
                    raise ValueError("密码生成失败")
                data.update(passwordCheckpoint=password, passwordSavedAt=now(), passwordStatus="saved")
                row.value = json.dumps(data, ensure_ascii=False)
        # Returning is the durable commit acknowledgement. A failed commit
        # propagates before the original password POST can be reached.
        return password

    def configuration_checkpoint(self, task_uuid, client_id, proxy):
        with self.transaction() as db:
            row, data = self.task_data(db, task_uuid)
            if self.current(db, task_uuid, data) is None:
                raise ValueError("任务占用已变化，不能开始注册")
            if "configurationCheckpoint" not in data:
                if not isinstance(client_id, str) or not client_id or len(client_id) > 255:
                    raise ValueError("注册配置不完整")
                data["configurationCheckpoint"] = {"clientId": client_id, "proxyUsed": proxy}
                row.value = json.dumps(data, ensure_ascii=False)
            return dict(data["configurationCheckpoint"])

    def capture_result(self, task_uuid, result, identity):
        with self.sessions.get_db() as db:
            _, data = self.task_data(db, task_uuid)
        values = {key: getattr(result, key, None) for key in RESULT_FIELDS}
        values["metadata"] = {**(values.get("metadata") or {}), "idSourceTaskUuid": task_uuid}
        if (not isinstance(values["email"], str) or values["email"].strip().lower() != data["email"]
                or values["source"] not in {"register", "login"}):
            self.update_task(task_uuid, rawResult=values, syncStatus="quarantined", reason="identity_mismatch")
            return False
        if values["source"] == "register" and data.get("passwordCheckpoint") != values["password"]:
            self.update_task(task_uuid, rawResult=values, syncStatus="blocked", reason="password_missing")
            return False
        return self.update_task(task_uuid, rawResult=values, localSaveStatus="pending", **identity)

    def account_saved(self, task_uuid, account, identity):
        with self.transaction() as db:
            row, data = self.task_data(db, task_uuid)
            record = self.current(db, task_uuid, data)
            if record is None:
                data.update(syncStatus="quarantined", localSaveStatus="saved", upstreamAccountId=str(account.id))
                row.value = json.dumps(data, ensure_ascii=False)
                return False
            raw = data.get("rawResult", {})
            if account.email.strip().lower() != data["email"] or (account.extra_data or {}).get("idSourceTaskUuid") != task_uuid:
                raise HTTPException(409, "原账号来源不一致")
            payload = {"accountId": data["mirrorAccountId"], "sourceTaskUuid": task_uuid,
                       "upstreamAccountId": str(account.id), "operatorId": data["operatorId"],
                       "aliasId": data["aliasId"], "email": data["email"],
                       "password": raw.get("password") or "", "registrationCountry": record.get("registrationCountry"),
                       "source": raw.get("source"), "identityStatus": identity.get("identityStatus"),
                       "identityEvidence": identity.get("identityEvidence")}
            payload["fingerprint"] = fingerprint(payload)
            status = "pending" if identity.get("identityStatus") == "verified" else "awaiting_identity"
            data.update(upstreamAccountId=str(account.id), syncPayload=payload, localSaveStatus="saved", syncStatus=status,
                        stage="sync", syncErrorKind=identity.get("reason"), **identity)
            row.value = json.dumps(data, ensure_ascii=False)
            record.update(localSaveStatus="saved", syncStatus=status, identityStatus=identity.get("identityStatus"),
                          stage="sync", syncErrorKind=identity.get("reason"), reason=identity.get("reason"))
            self.write(db, record)
            return True

    def sync_payload(self, task_uuid):
        with self.sessions.get_db() as db:
            _, data = self.task_data(db, task_uuid)
            payload = data.get("syncPayload")
            if (data.get("syncStatus") not in {"pending", "failed", "saved"} or data.get("localSaveStatus") != "saved"
                    or not isinstance(payload, dict) or payload.get("identityStatus") != "verified"
                    or self.current(db, task_uuid, data) is None):
                raise HTTPException(409, "账号尚不满足同步条件，请先核对注册与身份")
            account = db.query(self.models.Account).filter_by(id=int(payload["upstreamAccountId"])).first()
            valid = (account is not None and account.email.strip().lower() == data["email"] and
                     (account.extra_data or {}).get("idSourceTaskUuid") == task_uuid)
            result = dict(payload)
        if not valid:
            self.update_task(task_uuid, syncStatus="conflict", syncErrorKind="deleted_account", reason="deleted_account")
            raise HTTPException(409, "原账号已删除或来源变化，不能重放同步")
        return result

    def sync_pending(self):
        tasks = []
        with self.sessions.get_db() as db:
            for row in db.query(self.models.Setting).filter(self.models.Setting.key.startswith(TASK_PREFIX)).all():
                data = json.loads(row.value)
                task_uuid = row.key[len(TASK_PREFIX):]
                if data.get("syncStatus") == "pending" and self.current(db, task_uuid, data) is not None:
                    tasks.append({"taskUuid": task_uuid, "operatorId": data["operatorId"], "syncStatus": "pending"})
        return {"tasks": tasks}

    def sync_ack(self, task_uuid, account_id, status, error_kind=None):
        if status not in {"saved", "failed", "conflict"} or (error_kind is not None and error_kind not in SYNC_ERRORS):
            raise HTTPException(400, "账号同步回执无效")
        with self.transaction() as db:
            row, data = self.task_data(db, task_uuid)
            if account_id != data.get("mirrorAccountId") or not data.get("syncPayload"):
                raise HTTPException(409, "账号同步回执与原任务不一致")
            record = self.current(db, task_uuid, data)
            if record is None:
                raise HTTPException(409, "迟到的同步回执需要核对")
            if data.get("syncStatus") == "saved":
                return {"accepted": True, "syncStatus": "saved"}
            if data.get("syncStatus") not in {"pending", "failed", "conflict"}:
                raise HTTPException(409, "当前任务不允许接收同步回执")
            data.update(syncStatus=status, syncErrorKind=error_kind,
                        systemAccountId=account_id if status == "saved" else None, syncedAt=now() if status == "saved" else None)
            row.value = json.dumps(data, ensure_ascii=False)
            record.update(syncStatus=status, syncErrorKind=error_kind, systemAccountId=data["systemAccountId"])
            self.write(db, record)
        return {"accepted": True, "syncStatus": status}

    def sync_retry(self, task_uuid):
        with self.transaction() as db:
            row, data = self.task_data(db, task_uuid)
            record = self.current(db, task_uuid, data)
            if record is None or not data.get("syncPayload"):
                raise HTTPException(409, "原任务资料不满足重试条件")
            if data.get("syncStatus") == "saved":
                return {"accepted": True, "syncStatus": "saved"}
            if data.get("syncStatus") not in {"failed", "pending"}:
                raise HTTPException(409, "请先核对身份或账号冲突，不能直接重试")
            data.update(syncStatus="pending", syncErrorKind=None)
            row.value = json.dumps(data, ensure_ascii=False)
            record.update(syncStatus="pending", syncErrorKind=None)
            self.write(db, record)
        return {"accepted": True, "syncStatus": "pending"}

    def identity_refreshed(self, task_uuid, identity):
        with self.transaction() as db:
            row, data = self.task_data(db, task_uuid)
            record = self.current(db, task_uuid, data)
            if record is None or not data.get("syncPayload") or data.get("syncStatus") == "saved":
                raise HTTPException(409, "原任务状态已变化，请刷新后核对")
            status = "pending" if identity.get("identityStatus") == "verified" else "awaiting_identity"
            data["syncPayload"].update({key: identity.get(key) for key in ("identityStatus", "identityEvidence")})
            data.update(syncStatus=status, syncErrorKind=identity.get("reason"), **identity)
            row.value = json.dumps(data, ensure_ascii=False)
            record.update(syncStatus=status, syncErrorKind=identity.get("reason"),
                          identityStatus=identity.get("identityStatus"), reason=identity.get("reason"))
            self.write(db, record)
        return {"accepted": True, "syncStatus": status}

