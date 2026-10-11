"""Original Team Manager HTTP contract through the worker's name adapter."""

import importlib
import inspect
from pathlib import Path
import secrets
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import upload_compat
import workspace


class UploadCompatibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # The single-account uploader needs the actual upstream models, but no
        # database or runtime. Avoid importing its unauthenticated global app.
        if "src" not in sys.modules:
            workspace._package_without_initializer("src", workspace.UPSTREAM_DIR / "src")
        if "src.web" not in sys.modules:
            workspace._package_without_initializer("src.web", workspace.UPSTREAM_DIR / "src/web")
        cls.module = importlib.import_module("src.core.upload.team_manager_upload")

    def setUp(self):
        network = patch.object(self.module.cffi_requests.Session, "request",
                               side_effect=AssertionError("external-network-disabled"))
        network.start()
        self.addCleanup(network.stop)
        self.original_alias = getattr(self.module, "upload_account_to_tm", None)
        if self.original_alias is not None:
            del self.module.upload_account_to_tm
        self.account = SimpleNamespace(email="tm-fixture@example.invalid",
            access_token=secrets.token_urlsafe(32), session_token=secrets.token_urlsafe(32),
            refresh_token=secrets.token_urlsafe(32), client_id="synthetic-client")
        self.api_key = secrets.token_urlsafe(32)

    def tearDown(self):
        if self.original_alias is not None:
            self.module.upload_account_to_tm = self.original_alias
        elif hasattr(self.module, "upload_account_to_tm"):
            del self.module.upload_account_to_tm

    def install(self):
        upload_compat.install_upload_compatibility()
        return self.module.upload_account_to_tm

    def test_alias_is_the_real_function_and_repeated_install_is_idempotent(self):
        original = self.module.upload_to_team_manager
        alias = self.install()
        self.assertIs(alias, original)
        self.assertEqual(list(inspect.signature(alias).parameters), ["account", "api_url", "api_key"])
        upload_compat.install_upload_compatibility()
        self.assertIs(self.module.upload_account_to_tm, original)

    def test_existing_native_export_is_not_overwritten(self):
        native = Mock(return_value=(False, "native-result"))
        self.module.upload_account_to_tm = native
        upload_compat.install_upload_compatibility()
        self.assertIs(self.module.upload_account_to_tm, native)

    def test_real_request_body_headers_and_success_statuses_are_preserved(self):
        alias = self.install()
        for status in (200, 201):
            with self.subTest(status=status), patch.object(self.module.cffi_requests, "post",
                    return_value=SimpleNamespace(status_code=status)) as post:
                self.assertEqual(alias(self.account, "https://tm.example.invalid/", self.api_key),
                                 (True, "上传成功"))
                post.assert_called_once_with("https://tm.example.invalid/api/accounts/import",
                    headers={"X-API-Key": self.api_key, "Content-Type": "application/json"},
                    json={"import_type": "single", "email": self.account.email,
                          "access_token": self.account.access_token,
                          "session_token": self.account.session_token,
                          "refresh_token": self.account.refresh_token, "client_id": "synthetic-client"},
                    proxies=None, timeout=30, impersonate="chrome110")

    def test_http_failure_remains_failure_without_automatic_retry(self):
        alias = self.install()
        response = SimpleNamespace(status_code=503, json=lambda: {"message": "synthetic-refusal"})
        with patch.object(self.module.cffi_requests, "post", return_value=response) as post:
            self.assertEqual(alias(self.account, "https://tm.example.invalid", self.api_key),
                             (False, "synthetic-refusal"))
            post.assert_called_once()

    def test_transport_failure_remains_failure_without_automatic_retry(self):
        alias = self.install()
        with patch.object(self.module.cffi_requests, "post", side_effect=RuntimeError("synthetic-timeout")) as post:
            with patch.object(self.module.logger, "error"):
                success, message = alias(self.account, "https://tm.example.invalid", self.api_key)
            self.assertFalse(success)
            self.assertIn("synthetic-timeout", message)
            post.assert_called_once()

    def test_missing_configuration_or_access_token_never_posts(self):
        alias = self.install()
        no_access = SimpleNamespace(access_token=None)
        for account, url, key in ((self.account, "", self.api_key),
                                  (self.account, "https://tm.example.invalid", ""),
                                  (no_access, "https://tm.example.invalid", self.api_key)):
            with patch.object(self.module.cffi_requests, "post") as post:
                self.assertFalse(alias(account, url, key)[0])
                post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
