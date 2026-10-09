"""Offline integration checks: no real registration, mail or payment requests."""

import importlib
import os
from pathlib import Path
import secrets
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
import workspace


class WorkspaceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = tempfile.TemporaryDirectory(prefix="auto-registration-unit-", dir=workspace.PROJECT_ROOT / ".runtime")
        cls.internal_token = secrets.token_urlsafe(32)
        cls.encryption_key = secrets.token_urlsafe(48)
        cls.headers = {"X-ID-Workspace-Token": cls.internal_token}
        cls.audited_headers = {**cls.headers, "X-ID-Workspace-Sensitive-Access": "audited"}
        os.environ["APP_DATABASE_URL"] = "mysql://must-never-be-used/primary"
        os.environ["DATABASE_URL"] = "mysql://must-never-be-used/primary"
        cls.app = workspace.create_workspace_app({"runtimeDir": cls.runtime.name, "internalToken": cls.internal_token, "encryptionKey": cls.encryption_key})
        cls.client_context = TestClient(cls.app)
        cls.client = cls.client_context.__enter__()
        cls.models = importlib.import_module("src.database.models")
        cls.sessions = importlib.import_module("src.database.session")
        with cls.sessions.get_db() as db:
            account = cls.models.Account(email="local-fixture@example.invalid", email_service="outlook", password="fixture-password-do-not-use", access_token="fixture-access-token", refresh_token="fixture-refresh-token", cookies="fixture-cookie=value", proxy_used="http://fixture-user:fixture-password@127.0.0.1:1234", extra_data={"token": "nested-fixture-token"})
            email = cls.models.EmailService(service_type="outlook", name="本地测试邮箱", config={"password": "fixture-email-password", "refresh_token": "fixture-email-token", "admin_password": "fixture-admin-password", "nested": {"client_secret": "fixture-client-secret", "headers": {"X-Admin-Auth": "fixture-admin-auth"}}})
            proxy = cls.models.Proxy(name="本地测试代理", host="127.0.0.1", port=1234, username="fixture-user", password="fixture-proxy-password")
            setting = cls.models.Setting(key="fixture.secret", value="fixture-secret-value")
            task = cls.models.RegistrationTask(task_uuid="local-fixture-task", logs="生成密码: fixture-generated-password\n普通步骤完成", result={"password": "fixture-result-password"})
            db.add_all([account, email, proxy, setting, task])
            db.commit()
            cls.account_id = account.id
            cls.email_id = email.id
            cls.proxy_id = proxy.id

    @classmethod
    def tearDownClass(cls):
        cls.client_context.__exit__(None, None, None)
        cls.sessions.get_session_manager().engine.dispose()
        cls.runtime.cleanup()

    def test_isolated_sqlite_ignores_inherited_mysql(self):
        expected = "sqlite:///" + str(Path(self.runtime.name) / "database.db")
        self.assertEqual(os.environ["APP_DATABASE_URL"], expected)
        self.assertNotIn("DATABASE_URL", os.environ)
        self.assertEqual(self.sessions.get_session_manager().database_url, expected)
        self.assertNotIn("src.web.app", sys.modules)
        self.assertEqual(self.client.get("/health", headers=self.headers).json()["database"], "isolated-sqlite")

    def test_every_http_surface_requires_internal_auth(self):
        for path in ("/health", "/", "/accounts", "/api/accounts", "/static/js/accounts.js", "/static/id-system-skin.css"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 401)
                self.assertEqual(self.client.get(path, headers={"X-ID-Workspace-Token": "incorrect"}).status_code, 401)
        self.assertEqual(self.client.get("/login", headers=self.headers).status_code, 404)

    def test_secret_fields_are_encrypted_on_disk_and_round_trip(self):
        with sqlite3.connect(Path(self.runtime.name) / "database.db") as db:
            for table, column in (("accounts", "password"), ("accounts", "access_token"), ("accounts", "cookies"), ("accounts", "extra_data"), ("email_services", "config"), ("proxies", "username"), ("proxies", "password"), ("settings", "value"), ("registration_tasks", "result")):
                value = db.execute(f'SELECT "{column}" FROM "{table}" WHERE "{column}" IS NOT NULL LIMIT 1').fetchone()[0]
                self.assertTrue(value.startswith("idenc:v1:"), f"{table}.{column}")
                self.assertNotIn("fixture", value)
        with self.sessions.get_db() as db:
            self.assertEqual(db.get(self.models.Account, self.account_id).password, "fixture-password-do-not-use")
            self.assertEqual(db.get(self.models.EmailService, self.email_id).config["password"], "fixture-email-password")

    def test_plaintext_and_wrong_key_fail_closed(self):
        encrypted_type = workspace.EncryptedValue(self.encryption_key, self.models.Account.__table__.c.password.type.original_type)
        with self.assertRaises(ValueError):
            encrypted_type.process_result_value("old-plaintext", None)
        stored = encrypted_type.process_bind_param("fixture-password", None)
        wrong = workspace.EncryptedValue(secrets.token_urlsafe(48), encrypted_type.original_type)
        with self.assertRaises(Exception):
            wrong.process_result_value(stored, None)

    def test_default_list_masks_password_and_cookies(self):
        response = self.client.get("/api/accounts", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        account = response.json()["accounts"][0]
        self.assertEqual(account["password"], workspace.MASK)
        self.assertEqual(account["cookies"], workspace.MASK)
        self.assertNotIn("fixture-password", account["proxy_used"])

    def test_account_patch_response_masks_password_and_cookies(self):
        response = self.client.patch(f"/api/accounts/{self.account_id}", headers=self.headers, json={"status": "active"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["password"], workspace.MASK)
        self.assertEqual(response.json()["cookies"], workspace.MASK)

    def test_email_config_defaults_mask_nested_admin_credentials(self):
        for path in ("/api/email-services", f"/api/email-services/{self.email_id}"):
            with self.subTest(path=path):
                response = self.client.get(path, headers=self.headers)
                self.assertEqual(response.status_code, 200)
                self.assertNotIn("fixture-admin-password", response.text)
                self.assertNotIn("fixture-client-secret", response.text)
                self.assertNotIn("fixture-admin-auth", response.text)
        full = self.client.get(f"/api/email-services/{self.email_id}/full", headers=self.audited_headers)
        self.assertEqual(full.json()["config"]["admin_password"], "fixture-admin-password")
        self.assertEqual(full.json()["config"]["nested"]["client_secret"], "fixture-client-secret")

    def test_sensitive_reads_require_audited_gateway(self):
        for path in (f"/api/accounts/{self.account_id}", f"/api/accounts/{self.account_id}/tokens", f"/api/accounts/{self.account_id}/cookies", f"/api/accounts/{self.account_id}/credentials", f"/api/email-services/{self.email_id}/full", f"/api/settings/proxies/{self.proxy_id}"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path, headers=self.headers).status_code, 403)
                self.assertEqual(self.client.get(path, headers=self.audited_headers).status_code, 200)
        result = self.client.get(f"/api/accounts/{self.account_id}/credentials", headers=self.audited_headers).json()
        self.assertEqual(result["password"], "fixture-password-do-not-use")
        self.assertEqual(set(result), {"id", "password"})
        self.assertEqual(self.client.post("/api/accounts/export/json", headers=self.headers, json={"ids": [self.account_id]}).status_code, 403)

    def test_password_generation_and_task_logs_are_scrubbed_before_storage(self):
        registration = importlib.import_module("src.core.register")
        engine = registration.RegistrationEngine.__new__(registration.RegistrationEngine)
        engine.logs = []
        engine.task_uuid = None
        callbacks = []
        engine.callback_logger = callbacks.append
        engine._log("生成密码: fixture-generated-password")
        self.assertNotIn("fixture-generated-password", engine.logs[0])
        self.assertNotIn("fixture-generated-password", callbacks[0])
        manager = importlib.import_module("src.web.task_manager").task_manager
        manager.add_log("log-fixture", "Cookie: fixture-cookie=value")
        self.assertNotIn("fixture-cookie", str(manager.get_logs("log-fixture")))
        with self.sessions.get_db() as db:
            logs = db.query(self.models.RegistrationTask).filter_by(task_uuid="local-fixture-task").first().logs
            self.assertNotIn("fixture-generated-password", logs)
            self.assertIn("普通步骤完成", logs)
        self.assertNotIn("fixture-oauth-code", workspace.redact_text("回调地址: http://localhost/callback?code=fixture-oauth-code&state=fixture-state"))
        long_proxy = "http://fixture-long-user:" + ("f1xtur3valu3" * 20) + "@127.0.0.1:1234"
        abbreviated = "任务 local-fixture-task 使用代理: " + long_proxy[:50] + "..."
        redacted = workspace.redact_text(abbreviated)
        self.assertNotIn("fixture-long-user", redacted)
        self.assertNotIn("f1xtur3valu3", redacted)
        self.assertIn("代理地址已隐藏", redacted)

    def test_database_backup_is_private_and_stays_in_runtime_directory(self):
        response = self.client.post("/api/settings/database/backup", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        backup = Path(response.json()["backup_path"])
        self.assertTrue(backup.is_relative_to(Path(self.runtime.name) / "backups"))
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        with sqlite3.connect(backup) as db:
            value = db.execute("SELECT password FROM accounts WHERE id = ?", (self.account_id,)).fetchone()[0]
            self.assertTrue(value.startswith("idenc:v1:"))

    def test_templates_and_assets_are_branded_and_prefixed(self):
        html = self.client.get("/", headers=self.headers).text
        self.assertNotIn('<nav class="navbar">', html)
        self.assertIn(workspace.BRAND, html)
        self.assertIn("data-v2-registration-workspace", html)
        self.assertIn(f'src="{workspace.WORKSPACE_PREFIX}/static/id-workspace.js"', html)
        self.assertIn(f'href="{workspace.WORKSPACE_PREFIX}/accounts"', html)
        self.assertLess(html.index("/static/css/style.css"), html.index("/static/id-system-skin.css"))
        self.assertLess(html.index("/static/id-system-skin.css"), html.index("/static/id-workspace.css"))
        script = self.client.get("/static/js/app.js", headers=self.headers).text
        self.assertIn("${window.location.host}" + workspace.WORKSPACE_PREFIX + "/api/ws/task/", script)
        self.assertIn("window.idWorkspaceCopyPassword(btn.dataset.accountId)", script)
        self.assertNotIn('data-pwd="${escapeHtml(account.password)}"', script)
        self.assertEqual(self.client.get("/static/id-system-skin.css", headers=self.headers).status_code, 200)

    def test_websocket_internal_protocol_auth_and_ping(self):
        with self.assertRaises(Exception):
            with self.client.websocket_connect("/api/ws/task/ws-fixture"):
                pass
        with self.client.websocket_connect("/api/ws/task/ws-fixture", subprotocols=[self.internal_token]) as websocket:
            self.assertEqual(websocket.accepted_subprotocol, self.internal_token)
            websocket.send_json({"type": "ping"})
            self.assertEqual(websocket.receive_json(), {"type": "pong"})

    def test_runtime_directory_must_stay_inside_project(self):
        with self.assertRaises(ValueError):
            workspace.create_workspace_app({"runtimeDir": "/tmp/not-owned-by-project", "internalToken": self.internal_token, "encryptionKey": self.encryption_key})

    def test_health_rejects_corrupted_encryption_marker_without_leaking_details(self):
        with self.sessions.get_db() as db:
            marker = db.get(self.models.Setting, workspace.HEALTH_SETTING_KEY)
            original = marker.value
            db.execute(workspace.text("UPDATE settings SET value = :value WHERE key = :key"), {"value": "corrupt-offline-fixture", "key": workspace.HEALTH_SETTING_KEY})
            db.commit()
        try:
            response = self.client.get("/health", headers=self.headers)
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json(), {"detail": "自动注册运行环境未就绪"})
            self.assertNotIn("corrupt-offline-fixture", response.text)
        finally:
            with self.sessions.get_db() as db:
                db.query(self.models.Setting).filter_by(key=workspace.HEALTH_SETTING_KEY).update({"value": original})
                db.commit()
        self.assertEqual(self.client.get("/health", headers=self.headers).status_code, 200)

    def test_health_rejects_missing_packaged_resources(self):
        original = Path.is_file
        with patch.object(Path, "is_file", lambda path: False if path == workspace.WORKER_DIR / "id-workspace.css" else original(path)):
            response = self.client.get("/health", headers=self.headers)
            self.assertEqual(response.status_code, 503)

    def test_health_has_no_persistent_write_side_effect(self):
        with sqlite3.connect(Path(self.runtime.name) / "database.db") as db:
            before = db.execute("SELECT key,value FROM settings ORDER BY key").fetchall()
        for _ in range(3):
            self.assertEqual(self.client.get("/health", headers=self.headers).status_code, 200)
        with sqlite3.connect(Path(self.runtime.name) / "database.db") as db:
            self.assertEqual(db.execute("SELECT key,value FROM settings ORDER BY key").fetchall(), before)


if __name__ == "__main__":
    unittest.main()
