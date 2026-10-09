"""Offline image acceptance for packaging, private SQLite and worker restart.

Run with the image interpreter as the image's unprivileged runtime user. The
synthetic database is created inside the module's mounted data directory, never
in the operating database. Credentials exist only in memory and private pipes.
No registration, mail, token refresh, upload or payment endpoint is called.
"""

from __future__ import annotations

import importlib
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

import workspace


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main() -> None:
    runtime_parent = workspace.PROJECT_ROOT / ".runtime/auto-registration"
    # This directory is intentionally not created by acceptance: a missing or
    # unwritable volume must fail, rather than fall back to another location.
    if not runtime_parent.is_dir() or not os.access(runtime_parent, os.W_OK):
        raise RuntimeError("自动注册数据挂载未就绪")
    key = secrets.token_urlsafe(48)
    token = secrets.token_urlsafe(32)
    fixture_key = "id.integration.acceptance-fixture"
    fixture_value = secrets.token_urlsafe(40)
    port = free_port()
    origin = f"http://127.0.0.1:{port}"

    def request(path: str, authenticated: bool = True) -> tuple[int, bytes]:
        headers = {"X-ID-Workspace-Token": token} if authenticated else {}
        try:
            with urllib.request.urlopen(urllib.request.Request(origin + path, headers=headers), timeout=1) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def stop(child: subprocess.Popen) -> None:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)

    with tempfile.TemporaryDirectory(prefix="image-acceptance-", dir=runtime_parent) as temporary:
        directory = Path(temporary)

        def launch(encryption_key: str) -> subprocess.Popen:
            child = subprocess.Popen(
                [sys.executable, "-B", str(workspace.WORKER_DIR / "workspace.py")],
                cwd=directory,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env={"PATH": os.environ.get("PATH", ""), "PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1"},
            )
            child.stdin.write((json.dumps({"internalToken": token, "encryptionKey": encryption_key, "runtimeDir": str(directory), "port": port}) + "\n").encode())
            child.stdin.close()
            return child

        def wait_ready(child: subprocess.Popen) -> None:
            for _ in range(80):
                if child.poll() is not None:
                    raise RuntimeError("自动注册离线服务启动失败")
                try:
                    status, body = request("/health")
                    health = json.loads(body)
                    if status == 200 and health == {"status": "ready", "database": "isolated-sqlite", "upstream": "93ab984"}:
                        return
                except (urllib.error.URLError, ValueError):
                    pass
                time.sleep(0.1)
            raise RuntimeError("自动注册离线服务未通过健康校验")

        child = launch(key)
        try:
            wait_ready(child)
            if request("/health", authenticated=False)[0] != 401:
                raise RuntimeError("自动注册内部访问隔离失败")
            for path in ("/", "/accounts", "/email-services", "/payment", "/settings", "/static/js/app.js", "/static/id-workspace.js", "/static/id-workspace.css", "/static/id-system-skin.css"):
                status, body = request(path)
                if status != 200 or not body:
                    raise RuntimeError("自动注册镜像资源校验失败")
        finally:
            stop(child)

        encrypted_type = workspace.EncryptedValue(key, workspace.Text())
        encrypted = encrypted_type.process_bind_param(fixture_value, None)
        database = directory / "database.db"
        with sqlite3.connect(database) as db:
            db.execute("INSERT INTO settings (key,value,category) VALUES (?,?,?)", (fixture_key, encrypted, "general"))
            db.commit()
        if database.stat().st_mode & 0o777 != 0o600 or directory.stat().st_mode & 0o777 != 0o700:
            raise RuntimeError("自动注册资料目录权限校验失败")

        child = launch(key)
        try:
            wait_ready(child)
            with sqlite3.connect(database) as db:
                persisted = db.execute("SELECT value FROM settings WHERE key = ?", (fixture_key,)).fetchone()[0]
            if persisted != encrypted or fixture_value in persisted or encrypted_type.process_result_value(persisted, None) != fixture_value:
                raise RuntimeError("自动注册重启持久化校验失败")
        finally:
            stop(child)

        child = launch(secrets.token_urlsafe(48))
        try:
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                raise RuntimeError("自动注册错误密钥未拒绝启动") from None
            if child.returncode == 0:
                raise RuntimeError("自动注册错误密钥未拒绝启动")
        finally:
            stop(child)

    print(json.dumps({"status": "PASS", "checks": ["private-health", "packaged-resources", "private-sqlite", "encrypted-storage", "restart-persistence", "wrong-key-rejected"], "businessActions": 0}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"status": "FAIL", "message": "自动注册离线运行验收未通过"}), file=sys.stderr)
        raise SystemExit(1) from None
