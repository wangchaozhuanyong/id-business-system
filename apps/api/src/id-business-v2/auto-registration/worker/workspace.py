"""Authenticated local adapter for the unchanged cf-jx/codex-register sources.

The Nest gateway supplies one JSON line through stdin. No local dotenv files are
read and credentials are never command-line arguments. The upstream registration,
mail, batch and payment algorithms remain in the vendored source tree.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import importlib
import json
import logging
import os
from pathlib import Path
import re
import secrets
import sqlite3
import sys
import types
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.templating import Jinja2Templates
from sqlalchemy import Text, text
from sqlalchemy.types import TypeDecorator
from release_safety import maintenance_active

WORKER_DIR = Path(__file__).resolve().parent
UPSTREAM_DIR = WORKER_DIR.parent / "upstream"
PROJECT_ROOT = WORKER_DIR.parents[5]
WORKSPACE_PREFIX = "/api/id-business-v2/auto-registration/workspace"
BRAND = "ID 业务管理系统 · 自动注册"
MASK = "********"
HEALTH_SETTING_KEY = "id.integration.health"
HEALTH_SETTING_VALUE = "id-auto-registration-encryption-v1"
_SENSITIVE_KEY = re.compile(r"password|passwd|pwd|token|cookie|secret|api[_-]?key|authorization|credential|admin[_-]?auth|验证码|密码|密钥|令牌|凭据", re.I)


def redact_text(value: Any) -> str:
    """Remove secret-bearing log lines rather than attempting partial masking."""
    text = str(value)
    safe = []
    for line in text.splitlines():
        if _SENSITIVE_KEY.search(line) and re.search(r"[:：=]|Bearer\s|生成密码|生成.*验证码", line, re.I):
            safe.append("[敏感内容已隐藏]")
        else:
            # Upstream abbreviates actual_proxy_url to 50 characters before
            # logging. A long credential can therefore omit the separating @.
            line = re.sub(r"((?:使用代理|proxy[_\s-]?(?:url|used)|actual_proxy_url)\s*[:：=]\s*)(?:https?|socks5h?)://\S+", r"\1[代理地址已隐藏]", line, flags=re.I)
            line = re.sub(r"(https?|socks5h?)://[^\s/@]+:[^\s/@]+@", r"\1://[凭据已隐藏]@", line, flags=re.I)
            line = re.sub(r"(?<![\w-])eyJ[\w-]+\.[\w-]+\.[\w-]+", "[令牌已隐藏]", line)
            line = re.sub(r"([?&](?:code|state|code_verifier|key)\s*=)[^&#\s]+", r"\1[凭据已隐藏]", line, flags=re.I)
            safe.append(line)
    return "\n".join(safe).replace("apple_hidden", "苹果隐藏邮箱")


def sanitize_payload(value: Any, *, log_context: bool = False, mask_secrets: bool = False) -> Any:
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            is_log = log_context or key in {"logs", "log", "message", "error", "error_message", "detail"}
            if mask_secrets and _SENSITIVE_KEY.search(key) and not key.startswith(("has_", "can_")):
                result[key] = MASK if item else item
            elif key in {"proxy", "proxy_used", "proxy_url", "api_url", "dynamic_api_url"} and isinstance(item, str):
                result[key] = redact_text(item)
            else:
                result[key] = sanitize_payload(item, log_context=is_log, mask_secrets=mask_secrets)
        return result
    if isinstance(value, list):
        return [sanitize_payload(item, log_context=log_context, mask_secrets=mask_secrets) for item in value]
    return redact_text(value) if log_context and isinstance(value, str) else value


class SecretLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact_text(record.getMessage())
        record.args = ()
        # Exception text can contain response bodies and credentials.
        if record.exc_info:
            record.exc_text = redact_text(logging.Formatter().formatException(record.exc_info))
            record.exc_info = None
        return True


class EncryptedValue(TypeDecorator):
    """Transparent AES-GCM storage retaining each upstream Python value type."""

    impl = Text
    cache_ok = True

    def __init__(self, encryption_key: str, original_type: Any):
        super().__init__()
        self.cipher = AESGCM(hashlib.sha256(encryption_key.encode("utf-8")).digest())
        self.original_type = original_type

    def process_bind_param(self, value: Any, dialect: Any) -> str | None:
        if value is None:
            return None
        # JSONEncodedDict is deliberately retained; registration receives dicts.
        if isinstance(self.original_type, TypeDecorator):
            value = self.original_type.process_bind_param(value, dialect)
        nonce = secrets.token_bytes(12)
        encrypted = self.cipher.encrypt(nonce, str(value).encode("utf-8"), b"id-auto-registration-v1")
        return "idenc:v1:" + base64.urlsafe_b64encode(nonce + encrypted).decode("ascii")

    def process_result_value(self, value: str | None, dialect: Any) -> Any:
        if value is None:
            return None
        if not value.startswith("idenc:v1:"):
            raise ValueError("自动注册资料未加密，拒绝读取")
        packed = base64.urlsafe_b64decode(value[9:])
        plain = self.cipher.decrypt(packed[:12], packed[12:], b"id-auto-registration-v1").decode("utf-8")
        if isinstance(self.original_type, TypeDecorator):
            return self.original_type.process_result_value(plain, dialect)
        return plain


class SanitizedLog(TypeDecorator):
    impl = Text
    cache_ok = True

    def process_bind_param(self, value: Any, dialect: Any) -> str | None:
        return None if value is None else redact_text(value)

    def process_result_value(self, value: Any, dialect: Any) -> str | None:
        return None if value is None else redact_text(value)


def _package_without_initializer(name: str, directory: Path) -> None:
    """Avoid upstream src.web.__init__ importing its unauthenticated global app."""
    package = types.ModuleType(name)
    package.__path__ = [str(directory)]
    package.__package__ = name
    sys.modules[name] = package


def install_upstream_adapters(encryption_key: str, runtime_dir: Path) -> tuple[Any, Any]:
    _package_without_initializer("src", UPSTREAM_DIR / "src")
    _package_without_initializer("src.web", UPSTREAM_DIR / "src" / "web")
    models = importlib.import_module("src.database.models")
    encrypted_columns = {
        "accounts": {"password", "access_token", "refresh_token", "id_token", "session_token", "cookies", "extra_data", "proxy_used"},
        "email_services": {"config"},
        "registration_tasks": {"proxy", "result"},
        "settings": {"value"},
        "proxies": {"username", "password"},
        "cpa_services": {"api_token"},
        "sub2api_services": {"api_key"},
        "tm_services": {"api_key"},
    }
    for table_name, columns in encrypted_columns.items():
        for column_name in columns:
            column = models.Base.metadata.tables[table_name].c[column_name]
            column.type = EncryptedValue(encryption_key, column.type)
    models.RegistrationTask.__table__.c.logs.type = SanitizedLog()
    models.RegistrationTask.__table__.c.error_message.type = SanitizedLog()

    config = importlib.import_module("src.config.settings")
    # Integration-owned settings cannot redirect storage or resurrect another login.
    fixed_settings = {
        "app_name": BRAND,
        "database_url": f"sqlite:///{runtime_dir / 'database.db'}",
        "webui_host": "127.0.0.1",
        "webui_access_password": secrets.token_urlsafe(48),
        "webui_secret_key": secrets.token_urlsafe(48),
        "log_file": str(runtime_dir / "worker.log"),
    }
    for key, value in fixed_settings.items():
        config.SETTING_DEFINITIONS[key].default_value = value
    original_update = config.update_settings

    def update_settings(**kwargs: Any) -> Any:
        return original_update(**{key: value for key, value in kwargs.items() if key not in fixed_settings})

    config.update_settings = update_settings
    registration = importlib.import_module("src.core.register")
    original_log = registration.RegistrationEngine._log

    def registration_log(engine: Any, message: str, level: str = "info") -> Any:
        return original_log(engine, redact_text(message), level)

    registration.RegistrationEngine._log = registration_log
    original_result = registration.RegistrationResult.to_dict

    def registration_result(result: Any) -> dict[str, Any]:
        return sanitize_payload(original_result(result), mask_secrets=True)

    registration.RegistrationResult.to_dict = registration_result
    task_module = importlib.import_module("src.web.task_manager")
    for method_name in ("add_log", "add_batch_log"):
        original = getattr(task_module.TaskManager, method_name)

        def safe_log(manager: Any, identifier: str, message: str, _original: Any = original) -> Any:
            return _original(manager, identifier, redact_text(message))

        setattr(task_module.TaskManager, method_name, safe_log)
    return models, task_module.task_manager


def requires_sensitive_access(path: str, method: str) -> bool:
    if method == "POST" and path.startswith("/api/accounts/export/"):
        return True
    if method != "GET":
        return False
    return bool(re.fullmatch(r"/api/accounts/\d+(?:/(?:tokens|cookies|credentials))?", path)
                or re.fullmatch(r"/api/(?:email-services|cpa-services|sub2api-services)/\d+/full", path)
                or re.fullmatch(r"/api/settings/proxies/\d+", path))


def transform_asset(source: str, *, html: bool = False, asset_name: str = "") -> str:
    """Adapt branding and same-origin URLs without altering the business source."""
    if html:
        source = re.sub(r"<nav\b[^>]*class=[\"'][^\"']*navbar[^\"']*[\"'][^>]*>.*?</nav>", "", source, flags=re.S | re.I)
        for name in ("OpenAI/Codex CLI 自动注册系统", "OpenAI 自动注册系统", "OpenAI 注册系统", "Codex Register"):
            source = source.replace(name, BRAND)
    source = re.sub(r"(?P<quote>[\"'`])/(?P<path>api|static)(?=[/\"'`])", lambda match: match["quote"] + WORKSPACE_PREFIX + "/" + match["path"], source)
    source = re.sub(r"(?P<attribute>href|src|action)=(?P<quote>[\"'])/(?P<path>(?!/)[^\"']*)", lambda match: match["attribute"] + "=" + match["quote"] + ("/" + match["path"] if match["path"].startswith(WORKSPACE_PREFIX.lstrip("/")) else WORKSPACE_PREFIX + "/" + match["path"]), source)
    source = source.replace("${window.location.host}/api/", "${window.location.host}" + WORKSPACE_PREFIX + "/api/")
    if asset_name == "utils.js":
        # Extend only the served display map; retain the upstream stored value.
        source += "\nstatusMap.service.apple_hidden = '苹果隐藏邮箱';\n"
    if asset_name in {"accounts.js", "app.js"}:
        source = source.replace('data-pwd="${escapeHtml(account.password)}"', 'data-account-id="${account.id}"')
        source = source.replace("copyToClipboard(btn.dataset.pwd);", "window.idWorkspaceCopyPassword(btn.dataset.accountId);")
        source = source.replace('onclick="togglePassword(this, this.dataset.pwd)"', 'onclick="window.idWorkspaceTogglePassword(this, this.dataset.accountId)"')
        if asset_name == "app.js":
            source = source.replace('<span class="password-hidden" title="点击查看">', '<span class="password-hidden" data-account-id="${account.id}" onclick="window.idWorkspaceTogglePassword(this, this.dataset.accountId)" title="点击查看">')
        source += "\n" + _PASSWORD_BRIDGE
    if html:
        source = source.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-v2-registration-workspace>')
        source = source.replace("<head>", '<head>\n<script src="' + WORKSPACE_PREFIX + '/static/id-workspace.js"></script>', 1)
        source = source.replace("</head>", '<link rel="stylesheet" href="' + WORKSPACE_PREFIX + '/static/id-system-skin.css">\n<link rel="stylesheet" href="' + WORKSPACE_PREFIX + '/static/id-workspace.css">\n</head>', 1)
    return source


_PASSWORD_BRIDGE = """
window.idWorkspaceReadPassword = async function(id) {
    const response = await fetch('""" + WORKSPACE_PREFIX + """/api/accounts/' + encodeURIComponent(id) + '/credentials');
    const body = await response.json();
    if (!response.ok) throw new Error(body.detail || '读取密码失败');
    return body.password || '';
};
window.idWorkspaceCopyPassword = async function(id) {
    try { const password = await window.idWorkspaceReadPassword(id); await copyToClipboard(password); }
    catch (error) { toast.error(error.message); }
};
window.idWorkspaceTogglePassword = async function(element, id) {
    if (element.dataset.revealed === 'true') {
        element.textContent = '********'; element.dataset.revealed = 'false'; element.classList.add('password-hidden'); return;
    }
    element.setAttribute('aria-busy', 'true');
    try { element.textContent = await window.idWorkspaceReadPassword(id); element.dataset.revealed = 'true'; element.classList.remove('password-hidden'); }
    catch (error) { toast.error(error.message); }
    finally { element.removeAttribute('aria-busy'); }
};
"""


class WorkspaceGatewayBoundary:
    def __init__(self, app: Any, internal_token: str, runtime_dir: Path):
        self.app = app
        self.internal_token = internal_token
        self.runtime_dir = runtime_dir

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return
        headers = {key.decode("latin1").lower(): value.decode("latin1") for key, value in scope.get("headers", [])}
        token = headers.get("x-id-workspace-token", "")
        protocol_auth = False
        if scope["type"] == "websocket" and not token:
            protocol_auth = self.internal_token in scope.get("subprotocols", [])
            token = self.internal_token if protocol_auth else ""
        if not token or not hmac.compare_digest(token, self.internal_token):
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 4401})
            else:
                await JSONResponse({"detail": "请通过系统登录后访问"}, status_code=401)(scope, receive, send)
            return
        if scope["type"] == "http" and scope.get("method", "GET") not in {"GET", "HEAD", "OPTIONS"} and maintenance_active(self.runtime_dir):
            await JSONResponse({"detail": "自动注册正在维护，请稍后重试"}, status_code=503)(scope, receive, send)
            return
        path = scope["path"]
        if requires_sensitive_access(path, scope.get("method", "GET")) and headers.get("x-id-workspace-sensitive-access") != "audited":
            await JSONResponse({"detail": "敏感资料必须经过系统权限校验和审计"}, status_code=403)(scope, receive, send)
            return
        if scope["type"] == "websocket":
            ws_closed = False

            async def safe_ws_receive() -> dict[str, Any]:
                nonlocal ws_closed
                message = await receive()
                if message["type"] == "websocket.receive" and maintenance_active(self.runtime_dir):
                    try:
                        payload = json.loads(message.get("text") or message.get("bytes") or "")
                        heartbeat = isinstance(payload, dict) and payload.get("type") == "ping"
                    except (ValueError, TypeError):
                        heartbeat = False
                    if not heartbeat:
                        ws_closed = True
                        await send({"type": "websocket.close", "code": 1013, "reason": "自动注册正在维护，请稍后重试"})
                        return {"type": "websocket.disconnect", "code": 1013}
                return message

            async def safe_ws_send(message: dict[str, Any]) -> None:
                if ws_closed:
                    return
                if message["type"] == "websocket.accept" and protocol_auth:
                    message = {**message, "subprotocol": self.internal_token}
                if message["type"] == "websocket.send" and message.get("text"):
                    try:
                        message = {**message, "text": json.dumps(sanitize_payload(json.loads(message["text"]), mask_secrets=True), ensure_ascii=False)}
                    except (ValueError, TypeError):
                        message = {**message, "text": redact_text(message["text"])}
                await send(message)
            await self.app(scope, safe_ws_receive, safe_ws_send)
            return
        start = None
        chunks = []
        rewrite = False

        async def safe_http_send(message: dict[str, Any]) -> None:
            nonlocal start, rewrite
            if message["type"] == "http.response.start":
                start = message
                response_headers = dict(message.get("headers", []))
                rewrite = b"application/json" in response_headers.get(b"content-type", b"")
                if not rewrite:
                    await send(message)
            elif message["type"] == "http.response.body" and rewrite:
                chunks.append(message.get("body", b""))
                if not message.get("more_body"):
                    body = b"".join(chunks)
                    try:
                        payload = sanitize_payload(json.loads(body))
                        if isinstance(payload, dict) and (path == "/api/accounts" or (scope.get("method") == "PATCH" and re.fullmatch(r"/api/accounts/\d+", path))):
                            accounts = payload.get("accounts", []) if path == "/api/accounts" else [payload]
                            for account in accounts:
                                for key in ("password", "cookies"):
                                    account[key] = MASK if account.get(key) else account.get(key)
                                if account.get("proxy_used"):
                                    account["proxy_used"] = redact_text(account["proxy_used"])
                        if path.startswith("/api/registration/"):
                            payload = sanitize_payload(payload, mask_secrets=True)
                        if path.startswith("/api/email-services") and not re.fullmatch(r"/api/email-services/\d+/full", path):
                            payload = sanitize_payload(payload, mask_secrets=True)
                        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                    except (ValueError, TypeError):
                        body = json.dumps({"detail": "响应格式错误"}, ensure_ascii=False).encode("utf-8")
                    updated = [(key, value) for key, value in start.get("headers", []) if key.lower() not in {b"content-length", b"etag"}]
                    updated.append((b"content-length", str(len(body)).encode()))
                    await send({**start, "headers": updated})
                    await send({"type": "http.response.body", "body": body})
            else:
                await send(message)
        await self.app(scope, receive, safe_http_send)


def create_workspace_app(config: dict[str, Any]) -> FastAPI:
    runtime_dir = Path(config["runtimeDir"])
    if not runtime_dir.is_absolute() or not runtime_dir.resolve().is_relative_to(PROJECT_ROOT):
        raise ValueError("自动注册运行目录必须位于当前项目内")
    internal_token = config["internalToken"]
    encryption_key = config["encryptionKey"]
    if not isinstance(internal_token, str) or len(internal_token) < 32 or not isinstance(encryption_key, str) or len(encryption_key) < 32:
        raise ValueError("自动注册内部凭据无效")
    runtime_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(runtime_dir, 0o700)
    if (runtime_dir / "database.db").is_symlink():
        raise ValueError("自动注册数据库不能使用外部链接")
    os.environ["APP_DATABASE_URL"] = f"sqlite:///{runtime_dir / 'database.db'}"
    os.environ["APP_DATA_DIR"] = str(runtime_dir)
    os.environ.pop("DATABASE_URL", None)
    os.environ.pop("APP_ACCESS_PASSWORD", None)
    os.environ.pop("APP_HOST", None)
    os.environ.pop("APP_PORT", None)
    models, task_manager = install_upstream_adapters(encryption_key, runtime_dir)
    sessions = importlib.import_module("src.database.session")

    def verify_resources() -> None:
        required = [
            WORKER_DIR / "apple_mailboxes.py",
            WORKER_DIR / "release_safety.py",
            WORKER_DIR / "id-workspace.js",
            WORKER_DIR / "id-workspace.css",
            PROJECT_ROOT / "apps/admin/src/v2/styles/base.css",
            *[UPSTREAM_DIR / "templates" / name for name in ("index.html", "accounts.html", "email_services.html", "settings.html", "payment.html")],
            UPSTREAM_DIR / "static/css/style.css",
            *[UPSTREAM_DIR / "static/js" / name for name in ("utils.js", "app.js", "accounts.js", "email_services.js", "settings.js", "payment.js")],
        ]
        if any(not path.is_file() or path.stat().st_size == 0 for path in required):
            raise RuntimeError("自动注册资源不完整")

    def verify_storage() -> None:
        with sessions.get_db() as db:
            marker = db.get(models.Setting, HEALTH_SETTING_KEY)
            if marker is None or marker.value != HEALTH_SETTING_VALUE:
                raise RuntimeError("自动注册加密资料校验失败")
            # A read-only volume must not appear healthy. Rewrite only the
            # integration marker to its existing ciphertext, then roll back.
            db.execute(text("UPDATE settings SET value = value WHERE key = :key"), {"key": HEALTH_SETTING_KEY})
            db.rollback()
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    log_handler = logging.FileHandler(runtime_dir / "worker.log", encoding="utf-8")
    os.chmod(runtime_dir / "worker.log", 0o600)
    logging.getLogger().addHandler(log_handler)
    for handler in logging.getLogger().handlers:
        handler.addFilter(SecretLogFilter())
    app = FastAPI(title=BRAND, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(WorkspaceGatewayBoundary, internal_token=internal_token, runtime_dir=runtime_dir)
    from apple_mailboxes import install_apple_mailboxes
    install_apple_mailboxes(app, models, sessions, task_manager, redact_text)
    api_router = importlib.import_module("src.web.routes").api_router
    ws_router = importlib.import_module("src.web.routes.websocket").router

    @app.get("/api/accounts/{account_id}/credentials")
    async def account_credentials(account_id: int) -> Any:
        session = importlib.import_module("src.database.session")
        with session.get_db() as db:
            account = db.query(models.Account).filter(models.Account.id == account_id).first()
            if account is None:
                raise HTTPException(status_code=404, detail="账号不存在")
            return {"id": account.id, "password": account.password}

    @app.post("/api/settings/database/backup")
    async def database_backup() -> Any:
        # Upstream imports fastapi.Path as a filesystem Path here. Keep the
        # source intact and adapt that incompatible filesystem call locally.
        from datetime import datetime, timezone
        backup_dir = runtime_dir / "backups"
        backup_dir.mkdir(exist_ok=True, mode=0o700)
        backup_path = backup_dir / ("database_backup_" + datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S_%f") + ".db")
        with sqlite3.connect(runtime_dir / "database.db") as source_db:
            with sqlite3.connect(backup_path) as backup_db:
                source_db.backup(backup_db)
        os.chmod(backup_path, 0o600)
        return {"success": True, "message": "数据库备份成功", "backup_path": str(backup_path)}

    app.include_router(api_router, prefix="/api")
    app.include_router(ws_router, prefix="/api")
    templates = Jinja2Templates(directory=str(UPSTREAM_DIR / "templates"))
    for page, template in (("/", "index.html"), ("/accounts", "accounts.html"), ("/email-services", "email_services.html"), ("/settings", "settings.html"), ("/payment", "payment.html")):
        def page_handler(template_name: str) -> Any:
            async def render_page(request: Request) -> HTMLResponse:
                rendered = templates.get_template(template_name).render(request=request)
                return HTMLResponse(transform_asset(rendered, html=True))
            return render_page
        app.add_api_route(page, page_handler(template), response_class=HTMLResponse)

    @app.get("/static/{asset_path:path}")
    async def static_asset(asset_path: str) -> Response:
        if asset_path in {"id-workspace.js", "id-workspace.css"}:
            path = WORKER_DIR / asset_path
        elif asset_path == "id-system-skin.css":
            path = PROJECT_ROOT / "apps/admin/src/v2/styles/base.css"
        else:
            path = (UPSTREAM_DIR / "static" / asset_path).resolve()
            if not path.is_relative_to((UPSTREAM_DIR / "static").resolve()):
                raise HTTPException(status_code=404)
        if not path.is_file():
            raise HTTPException(status_code=404)
        content = path.read_bytes()
        if asset_path == "id-system-skin.css":
            content = re.sub(r"^@import\s+['\"](?:element-plus/theme-chalk/dark/css-vars\.css|\./layout\.css)['\"];\s*", "", content.decode("utf-8"), flags=re.M).encode("utf-8")
        if path.suffix in {".js", ".css"} and path.is_relative_to(UPSTREAM_DIR / "static"):
            content = transform_asset(content.decode("utf-8"), asset_name=path.name).encode("utf-8")
        media_type = {".js": "text/javascript", ".css": "text/css"}.get(path.suffix, "application/octet-stream")
        return Response(content, media_type=media_type)

    @app.get("/health")
    async def health() -> Any:
        try:
            verify_resources()
            verify_storage()
            loop = task_manager.get_loop()
            if loop is None or not loop.is_running():
                raise RuntimeError("自动注册任务服务未运行")
        except Exception:
            raise HTTPException(status_code=503, detail="自动注册运行环境未就绪") from None
        return {"status": "ready", "database": "isolated-sqlite", "upstream": "93ab984"}

    @app.on_event("startup")
    async def startup() -> None:
        verify_resources()
        initializer = importlib.import_module("src.database.init_db")
        initializer.initialize_database(os.environ["APP_DATABASE_URL"])
        os.chmod(runtime_dir / "database.db", 0o600)
        with sessions.get_db() as db:
            marker = db.get(models.Setting, HEALTH_SETTING_KEY)
            if marker is None:
                # Existing settings are encrypted too: reading any one before
                # adding the marker rejects a changed encryption key on upgrade.
                db.query(models.Setting).first()
                db.add(models.Setting(key=HEALTH_SETTING_KEY, value=HEALTH_SETTING_VALUE, category="general", description="自动注册运行环境校验"))
                db.commit()
            elif marker.value != HEALTH_SETTING_VALUE:
                raise RuntimeError("自动注册加密资料校验失败")
        verify_storage()
        task_manager.set_loop(asyncio.get_running_loop())

    @app.on_event("shutdown")
    async def shutdown() -> None:
        logging.getLogger().removeHandler(log_handler)
        log_handler.close()

    return app


def main() -> None:
    config = json.loads(sys.stdin.readline())
    app = create_workspace_app(config)
    import uvicorn
    # The gateway is the sole public entry point; upstream has no second login.
    uvicorn.run(app, host="127.0.0.1", port=int(config.get("port", 55323)), access_log=False, log_level="warning")


if __name__ == "__main__":
    main()
