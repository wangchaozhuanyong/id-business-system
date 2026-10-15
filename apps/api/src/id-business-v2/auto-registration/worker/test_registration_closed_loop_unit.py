"""Pure memory/fake-transport regressions; never creates or opens a database."""
import asyncio
from contextlib import contextmanager
import hashlib
import importlib
import json
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import apple_closed_loop as closed
import release_safety as safety
import workspace

# Import only definitions, bypassing upstream package initializers. A guard
# proves these tests cannot accidentally become a SQLite integration suite.
workspace._package_without_initializer("src", workspace.UPSTREAM_DIR / "src")
workspace._package_without_initializer("src.web", workspace.UPSTREAM_DIR / "src/web")
with patch.object(sqlite3, "connect", side_effect=AssertionError("database disabled")):
    apple = importlib.import_module("apple_mailboxes")

TASK = "82b25c6d-404f-47e9-a624-e106bd1a22cb"
ACCOUNT = "f968c218-9335-44df-9ad3-53106607cccf"
STAMP = "2026-10-16T01:00:00Z"


def payload(version=2, identity="creation_confirmed"):
    value = dict(accountId=ACCOUNT, sourceTaskUuid=TASK, upstreamAccountId="7", operatorId="fixture-admin",
                 aliasId="fixture-alias", email="unit@example.invalid", password="fixture-only-secret",
                 registrationCountry="PH", source="register", identityStatus=identity, identityEvidence=None)
    if version == 2:
        value.update(schemaVersion=2, provider="apple_hidden", registrationIp="8.8.8.8", registeredAt=STAMP,
                     creationConfirmed=True)
    value["fingerprint"] = closed.fingerprint(value)
    return value


class MemoryFacts(closed.ClosedLoopFacts):
    def __init__(self, data=None, record=None):
        self.data = data or {}
        self.record = record or {"email": "unit@example.invalid", "registrationCountry": "PH",
                                 "registrationIp": "8.8.8.8", "lastTaskUuid": TASK, "activeTaskUuid": None}
        self.row = SimpleNamespace(key=closed.TASK_PREFIX + TASK, value=json.dumps(self.data))
        self.db = MagicMock()
        self.models = SimpleNamespace(Setting=SimpleNamespace(key=MagicMock()), Account=Mock())
        self.sessions = SimpleNamespace(get_db=self.transaction)
        self.db.query.return_value.filter.return_value.all.return_value = [self.row]

    @contextmanager
    def transaction(self):
        self.data = json.loads(self.row.value)
        yield self.db
        self.data = json.loads(self.row.value)

    def task_data(self, db, task_uuid):
        return self.row, json.loads(self.row.value)

    def current(self, db, task_uuid, data):
        return self.record

    def write(self, db, record):
        self.record = record
        return record


class RegistrationClosedLoopUnitTests(unittest.TestCase):
    def setUp(self):
        self.stack = __import__("contextlib").ExitStack()
        self.stack.enter_context(patch.object(sqlite3, "connect", side_effect=AssertionError("database disabled")))
        self.stack.enter_context(patch.object(socket.socket, "connect", side_effect=AssertionError("network disabled")))
        self.addCleanup(self.stack.close)

    def test_legacy_fingerprint_keeps_original_receipt(self):
        value = payload(1, "verified")
        fields = {key: value[key] for key in ("accountId", "sourceTaskUuid", "upstreamAccountId", "email", "registrationCountry", "source")}
        self.assertEqual(value["fingerprint"], hashlib.sha256(json.dumps(fields, sort_keys=True, separators=(",", ":")).encode()).hexdigest())
        value.update(password="changed", identityStatus="awaiting_identity", registeredAt=STAMP)
        self.assertEqual(value["fingerprint"], closed.fingerprint(value))

    def test_v2_authorization_upgrade_changes_receipt_without_hashing_password(self):
        partial = payload()
        complete = payload(identity="verified")
        self.assertNotEqual(partial["fingerprint"], complete["fingerprint"])
        complete["password"] = "different-fixture"
        self.assertEqual(complete["fingerprint"], closed.fingerprint(complete))

    def test_release_accepts_legacy_and_v2_receipts(self):
        for value in (payload(1, "verified"), payload(), payload(identity="verified")):
            binding = {**value, "mirrorAccountId": ACCOUNT, "passwordCheckpoint": value["password"]}
            safety.validate_sync(value, TASK, binding)

    def test_release_refuses_unconfirmed_partial(self):
        value = payload()
        with self.assertRaises(safety.SafetyError):
            safety.validate_sync(value, TASK, {**value, "mirrorAccountId": ACCOUNT, "creationConfirmed": False,
                                              "passwordCheckpoint": value["password"]})

    def test_release_refuses_wrong_checkpoint_password(self):
        value = payload()
        with self.assertRaises(safety.SafetyError):
            safety.validate_sync(value, TASK, {**value, "mirrorAccountId": ACCOUNT, "passwordCheckpoint": "other"})

    def test_release_refuses_invalid_or_extra_registration_fact(self):
        for update in ({"registrationIp": "error page"}, {"registeredAt": "2026-10-16"}, {"provider": "other"}, {"extra": "field"}):
            value = {**payload(), **update}
            with self.assertRaises(safety.SafetyError):
                safety.validate_sync(value, TASK, {**value, "mirrorAccountId": ACCOUNT, "passwordCheckpoint": value["password"]})

    def test_pending_retries_transient_failures_when_due(self):
        facts = MemoryFacts(dict(syncStatus="failed", syncErrorKind="storage_unavailable", operatorId="fixture-admin",
                                 syncRetryCount=1, syncNextRetryAt="2000-01-01T00:00:00Z"))
        self.assertEqual(facts.sync_pending()["tasks"], [{"taskUuid": TASK, "operatorId": "fixture-admin", "syncStatus": "pending"}])
        self.assertEqual(facts.data["syncStatus"], "pending")

    def test_legacy_transient_failure_without_retry_metadata_gets_compensated(self):
        facts = MemoryFacts(dict(syncStatus="failed", syncErrorKind="storage_unavailable", operatorId="fixture-admin"))
        self.assertEqual(len(facts.sync_pending()["tasks"]), 1)

    def test_pending_does_not_retry_conflicts_future_or_exhausted(self):
        for changes in ({"syncErrorKind": "email_conflict"}, {"syncRetryCount": 3}, {"syncNextRetryAt": "2999-01-01T00:00:00Z"}):
            facts = MemoryFacts({"syncStatus": "failed", "syncErrorKind": "storage_unavailable", "operatorId": "fixture-admin",
                                 "syncRetryCount": 1, "syncNextRetryAt": "2000-01-01T00:00:00Z", **changes})
            self.assertEqual(facts.sync_pending(), {"tasks": []})

    def test_transient_ack_records_bounded_retry_backoff(self):
        facts = MemoryFacts(dict(syncStatus="pending", mirrorAccountId=ACCOUNT, syncPayload=payload(), syncRetryCount=2))
        facts.sync_ack(TASK, ACCOUNT, "failed", "storage_unavailable", facts.data["syncPayload"]["fingerprint"])
        self.assertEqual(facts.data["syncRetryCount"], 3)
        self.assertTrue(safety.nullable_date(facts.data["syncNextRetryAt"]))

    def test_old_partial_ack_cannot_consume_new_verified_pending_receipt(self):
        latest = payload(identity="verified")
        facts = MemoryFacts(dict(syncStatus="pending", mirrorAccountId=ACCOUNT, syncPayload=latest))
        with self.assertRaises(apple.HTTPException):
            facts.sync_ack(TASK, ACCOUNT, "saved", payload_fingerprint=payload()["fingerprint"])
        self.assertEqual(facts.data["syncStatus"], "pending")
        facts.sync_ack(TASK, ACCOUNT, "saved", payload_fingerprint=latest["fingerprint"])
        self.assertEqual(facts.data["syncStatus"], "saved")

    def test_legacy_ack_without_fingerprint_remains_compatible(self):
        facts = MemoryFacts(dict(syncStatus="pending", mirrorAccountId=ACCOUNT, syncPayload=payload(1, "verified")))
        self.assertTrue(facts.sync_ack(TASK, ACCOUNT, "saved")["accepted"])

    def test_explicit_retry_resets_budget_without_registration(self):
        facts = MemoryFacts(dict(syncStatus="failed", syncPayload=payload(), syncRetryCount=3))
        facts.sync_retry(TASK)
        self.assertEqual((facts.data["syncStatus"], facts.data["syncRetryCount"]), ("pending", 0))

    def test_creation_receipt_uses_original_creation_network_and_time(self):
        facts = MemoryFacts(dict(schemaVersion=2, provider="apple_hidden", creationConfirmed=True,
             creationConfirmedAt=STAMP, passwordCheckpoint="fixture-only-secret", mirrorAccountId=ACCOUNT,
             operatorId="fixture-admin", aliasId="fixture-alias", email="unit@example.invalid",
             rawResult={"source": "register", "password": "fixture-only-secret"}))
        account = SimpleNamespace(id=7, email="unit@example.invalid", extra_data={"idSourceTaskUuid": TASK})
        self.assertTrue(facts.account_saved(TASK, account, {"identityStatus": "awaiting_identity", "reason": "identity_missing"}))
        self.assertEqual(facts.data["syncStatus"], "pending")
        self.assertEqual(facts.data["syncPayload"]["identityStatus"], "creation_confirmed")
        self.assertEqual(facts.data["syncPayload"]["registeredAt"], STAMP)
        self.assertEqual(facts.data["syncPayload"]["registrationIp"], "8.8.8.8")

    def test_existing_login_does_not_claim_login_exit_as_registration_ip(self):
        facts = MemoryFacts(dict(schemaVersion=2, provider="outlook", mirrorAccountId=ACCOUNT,
             operatorId="fixture-admin", aliasId="fixture-alias", email="unit@example.invalid",
             rawResult={"source": "login", "password": ""}))
        account = SimpleNamespace(id=7, email="unit@example.invalid", extra_data={"idSourceTaskUuid": TASK})
        facts.account_saved(TASK, account, {"identityStatus": "verified"})
        self.assertIsNone(facts.data["syncPayload"]["registrationIp"])
        self.assertIsNone(facts.data["syncPayload"]["registeredAt"])

    def test_partial_payload_cannot_sync_without_matching_checkpoint(self):
        facts = MemoryFacts(dict(syncStatus="pending", localSaveStatus="saved", creationConfirmed=True,
                                syncPayload=payload(), passwordCheckpoint="other"))
        with self.assertRaises(apple.HTTPException):
            facts.sync_payload(TASK)
        facts.db.query.assert_not_called()

    def test_wrong_official_identity_never_replaces_created_checkpoint(self):
        raw = {"success": False, "email": "unit@example.invalid", "password": "fixture-only-secret"}
        facts = MemoryFacts({"email": "unit@example.invalid", "rawResult": raw})
        self.assertFalse(facts.capture_result(TASK, SimpleNamespace(),
            {"identityStatus": "mismatch", "reason": "identity_mismatch"}))
        self.assertEqual(facts.data["rawResult"], raw)
        self.assertEqual(facts.data["syncStatus"], "quarantined")

    def test_creation_saves_real_minimal_row_before_oauth(self):
        facts = MemoryFacts(dict(schemaVersion=2, provider="apple_hidden", creationConfirmed=True,
             creationConfirmedAt=STAMP, passwordCheckpoint="fixture-only-secret", mirrorAccountId=ACCOUNT,
             operatorId="fixture-admin", aliasId="fixture-alias", email="unit@example.invalid",
             configurationCheckpoint={"clientId": "fixture-client", "proxyUsed": None}))
        facts.db.query.return_value.filter.return_value.first.return_value = None
        created = []
        def account_model(**values):
            account = SimpleNamespace(id=7, **values)
            created.append(account)
            return account
        integration = object.__new__(apple.AppleMailboxIntegration)
        integration.store = facts
        integration.models = SimpleNamespace(Account=SimpleNamespace(email=MagicMock()))
        # Supply a model that supports both the class-level lookup column and
        # construction, without importing SQLAlchemy's database models.
        constructor = Mock(side_effect=account_model)
        constructor.email = MagicMock()
        integration.models.Account = constructor
        engine = SimpleNamespace(email_service=SimpleNamespace(service_type=SimpleNamespace(value="apple_hidden")),
                                 email_info={"service_id": "fixture-alias"})
        integration.persist_created_account(TASK, engine)
        self.assertEqual(len(created), 1)
        self.assertEqual(created[0].password, "fixture-only-secret")
        self.assertEqual(created[0].status, "expired")
        self.assertIsNone(getattr(created[0], "access_token", None))
        self.assertIsNone(getattr(created[0], "account_id", None))
        self.assertEqual(created[0].extra_data["idAuthorizationStatus"], "pending")
        self.assertEqual(facts.data["syncPayload"]["upstreamAccountId"], "7")
        self.assertFalse(facts.data["rawResult"]["success"])

    def test_legacy_created_checkpoint_without_raw_can_upgrade_without_inventing_time(self):
        for observed in (True, False):
            with self.subTest(observed=observed):
                facts = MemoryFacts(dict(creationConfirmed=True, passwordCheckpoint="fixture-only-secret",
                      mirrorAccountId=ACCOUNT, operatorId="fixture-admin", aliasId="fixture-alias",
                      email="unit@example.invalid", configurationCheckpoint={"clientId": "fixture-client", "proxyUsed": None}))
                facts.record.update(source="automatic" if observed else "manual", markedAt=STAMP,
                                    registrationEvidenceTaskUuid=TASK if observed else None)
                facts.db.query.return_value.filter.return_value.first.return_value = None
                constructor = Mock(side_effect=lambda **values: SimpleNamespace(id=7, **values))
                constructor.email = MagicMock()
                integration = object.__new__(apple.AppleMailboxIntegration)
                integration.store, integration.models = facts, SimpleNamespace(Account=constructor)
                engine = SimpleNamespace(email_service=SimpleNamespace(service_type=SimpleNamespace(value="apple_hidden")),
                                         email_info={"service_id": "fixture-alias"})
                integration.persist_created_account(TASK, engine)
                self.assertEqual(facts.data["schemaVersion"], 2)
                self.assertEqual(facts.data["syncPayload"]["registeredAt"], STAMP if observed else None)
                self.assertEqual(facts.data["syncPayload"]["identityStatus"], "creation_confirmed")

    def test_authorization_completes_the_same_row_without_original_insert(self):
        facts = MemoryFacts(dict(schemaVersion=2, provider="apple_hidden", creationConfirmed=True,
             creationConfirmedAt=STAMP, passwordCheckpoint="fixture-only-secret", mirrorAccountId=ACCOUNT,
             operatorId="fixture-admin", aliasId="fixture-alias", email="unit@example.invalid",
             rawResult={"source": "register", "password": "fixture-only-secret"},
             configurationCheckpoint={"clientId": "original-client", "proxyUsed": None}))
        row = SimpleNamespace(id=7, email="unit@example.invalid", extra_data={"idSourceTaskUuid": TASK}, status="expired")
        facts.db.get.return_value = row
        integration = object.__new__(apple.AppleMailboxIntegration)
        integration.store, integration.models = facts, SimpleNamespace(Account=Mock())
        integration.persisted_account = Mock(return_value=row)
        original_save = Mock()
        result = SimpleNamespace(email=row.email, metadata={}, password="fixture-only-secret", access_token="fixture-token")
        integration.persist_result(TASK, result, original_save, {"identityStatus": "verified"})
        original_save.assert_not_called()
        self.assertEqual(row.id, 7)
        self.assertEqual(row.access_token, "fixture-token")
        self.assertEqual(row.client_id, "original-client")
        self.assertEqual(row.status, "active")
        self.assertEqual(facts.record["authorizationStatus"], "complete")

    def test_blank_manual_edit_preserves_observed_creation_facts(self):
        record = {**apple.empty_record("unit@example.invalid"), "revision": 4, "registrationStatus": "registered",
                  "registrationIp": "8.8.8.8", "registrationIpSource": "observed", "registrationCountry": "PH",
                  "registeredAt": STAMP, "markedAt": STAMP, "source": "automatic"}
        facts = object.__new__(apple.RegistrationFacts)
        db = MagicMock()
        db.query.return_value.filter.return_value.first.return_value = None
        @contextmanager
        def transaction(): yield db
        facts.transaction, facts.read = transaction, Mock(return_value=record)
        facts.reliable_registration = Mock(return_value=True)
        facts.models = SimpleNamespace(Account=SimpleNamespace(email=MagicMock()))
        facts.write = lambda db, current: current
        request = apple.MarkInput(items=[{"aliasId": "fixture-alias", "email": record["email"], "revision": 4}],
                                  registrationStatus="registered", registrationIp=None, operatorId="fixture-admin")
        result = facts.mark(request)[0]
        self.assertEqual((result["registrationIp"], result["registrationCountry"], result["registeredAt"], result["source"]),
                         ("8.8.8.8", "PH", STAMP, "automatic"))

    def test_manual_ack_is_idempotent_and_never_fabricates_task(self):
        record = {**apple.empty_record("unit@example.invalid"), "revision": 4, "registrationStatus": "registered",
                  "source": "manual", "aliasId": "fixture-alias", "manualSyncId": TASK,
                  "syncStatus": "saved", "systemAccountId": ACCOUNT}
        facts = object.__new__(apple.RegistrationFacts)
        @contextmanager
        def transaction(): yield None
        facts.transaction, facts.read = transaction, Mock(return_value=record)
        facts.write = Mock()
        request = apple.ManualSyncAck(email=record["email"], aliasId="fixture-alias", revision=3,
                                     manualSyncId=TASK, accountId=ACCOUNT, status="saved")
        self.assertEqual(facts.manual_sync_ack(request), record)
        facts.write.assert_not_called()
        self.assertIsNone(record["lastTaskUuid"])

    def test_manual_backfill_cannot_take_over_an_original_created_task(self):
        record = {**apple.empty_record("unit@example.invalid"), "revision": 4, "registrationStatus": "registered",
                  "source": "manual", "aliasId": "fixture-alias", "lastTaskUuid": TASK}
        facts = object.__new__(apple.RegistrationFacts)
        @contextmanager
        def transaction(): yield None
        facts.transaction, facts.read = transaction, Mock(return_value=record)
        facts.reliable_registration = Mock(return_value=True)
        facts.write = Mock()
        request = apple.ManualSyncPrepare(email=record["email"], aliasId="fixture-alias", revision=4, operatorId="fixture-admin")
        with self.assertRaisesRegex(apple.HTTPException, "官网创建事实"):
            facts.manual_sync_prepare(request)
        facts.write.assert_not_called()

    def test_manual_failure_ack_accepts_null_account_without_losing_error(self):
        record = {**apple.empty_record("unit@example.invalid"), "revision": 4, "registrationStatus": "registered",
                  "source": "manual", "aliasId": "fixture-alias", "manualSyncId": TASK, "syncStatus": "pending"}
        facts = object.__new__(apple.RegistrationFacts)
        @contextmanager
        def transaction(): yield None
        facts.transaction, facts.read = transaction, Mock(return_value=record)
        facts.write = lambda db, value: value
        request = apple.ManualSyncAck(email=record["email"], aliasId="fixture-alias", revision=4,
                                     manualSyncId=TASK, accountId=None, status="failed", errorKind="storage_unavailable")
        result = facts.manual_sync_ack(request)
        self.assertEqual((result["syncStatus"], result["syncErrorKind"], result["systemAccountId"]),
                         ("failed", "storage_unavailable", None))
        with self.assertRaises(apple.HTTPException):
            facts.manual_sync_ack(request.model_copy(update={"status": "saved"}))

    def test_native_account_summary_reads_original_store_binding(self):
        facts = MemoryFacts(dict(creationConfirmed=True, identityStatus="awaiting_identity", syncStatus="pending",
                                 passwordCheckpoint="fixture-only-secret", email="unit@example.invalid"))
        account = SimpleNamespace(extra_data={"idSourceTaskUuid": TASK})
        facts.db.get.side_effect = lambda model, key: account if key == 7 else facts.row
        integration = object.__new__(apple.AppleMailboxIntegration)
        integration.store, integration.sessions, integration.models = facts, facts.sessions, facts.models
        integration.live = Mock(return_value=False)
        summary = integration.account_summaries([7])[7]
        self.assertTrue(summary["canResume"])
        self.assertEqual(summary["authorizationStatus"], "pending")
        self.assertNotIn("fixture-only-secret", json.dumps(summary))

    def test_common_provider_binding_keeps_real_service_identifier_and_context(self):
        for service in ("tempmail", "temp_mail", "custom_domain", "outlook"):
            with self.subTest(service=service):
                record = apple.empty_record("unit@example.invalid")
                facts = object.__new__(apple.RegistrationFacts)
                db = MagicMock()
                db.get.return_value = None
                @contextmanager
                def transaction(): yield db
                facts.transaction, facts.read = transaction, Mock(return_value=record)
                facts.reliable_registration = Mock(return_value=False)
                facts.write = lambda db, value: value
                facts.models = SimpleNamespace(Setting=Mock(side_effect=lambda **values: SimpleNamespace(**values)))
                context = {"operatorId": "fixture-admin", "attemptIp": "8.8.8.8", "attemptCountry": "PH"}
                engine = SimpleNamespace(email=record["email"], email_info={"email": record["email"], "service_id": "real-fixture-service"},
                       email_service=SimpleNamespace(service_type=SimpleNamespace(value=service), config={"base_url": "https://mail.example.invalid"}))
                facts.bind_provider(TASK, context, engine)
                binding = json.loads(db.add.call_args.args[0].value)
                self.assertEqual(binding["provider"], service)
                self.assertEqual(binding["aliasId"], "real-fixture-service")
                self.assertEqual(binding["providerCheckpoint"]["emailInfo"], engine.email_info)
                self.assertEqual(record["attemptIp"], "8.8.8.8")
                self.assertIsNone(record["registrationIp"])
                self.assertIsNone(record["registeredAt"])

    def test_generic_original_ip_then_email_order_defers_task_writes_until_address_exists(self):
        context = {"taskUuid": TASK, "generic": True, "email": None, "operatorId": "fixture-admin"}
        store = Mock()
        store.update_task.side_effect = lambda task, **updates: bool(context["email"]) or self.fail("task write before email binding")
        def bind(task, current, engine):
            self.assertEqual(task, TASK)
            current.update(email=engine.email, aliasId=engine.email_info["service_id"])
        store.bind_provider.side_effect = bind
        integration = object.__new__(apple.AppleMailboxIntegration)
        integration.store = store
        response = SimpleNamespace(status_code=200, text="ip=8.8.8.8\nloc=PH\n")
        engine = SimpleNamespace(http_client=SimpleNamespace(get=Mock(return_value=response)),
             oauth_manager=SimpleNamespace(client_id="fixture-client"), proxy_url=None,
             _submit_signup_form=Mock(), _send_verification_code=Mock(),
             _create_user_account=Mock(), _mark_email_as_registered=Mock(), _start_oauth=lambda: True)
        def check_ip():
            engine.http_client.get("https://cloudflare.com/cdn-cgi/trace")
            return True, "PH"
        def create_email():
            engine.email, engine.email_info = "unit@example.invalid", {"service_id": "real-fixture-service"}
            return True
        engine._check_ip_location, engine._create_email = check_ip, create_email
        integration.observe_engine(engine, SimpleNamespace(context=context, otp_lower_bound=None))
        self.assertEqual(engine._check_ip_location(), (True, "PH"))
        store.update_task.assert_not_called()
        store.configuration_checkpoint.assert_not_called()
        self.assertTrue(engine._create_email())
        store.bind_provider.assert_called_once()
        self.assertEqual(context["email"], "unit@example.invalid")
        self.assertTrue(engine._start_oauth())
        self.assertTrue(store.update_task.called)
        self.assertEqual(context["attemptIp"], "8.8.8.8")

    def test_partial_legacy_creation_time_can_stay_unknown(self):
        value = payload()
        value["registeredAt"] = None
        value["fingerprint"] = closed.fingerprint(value)
        safety.validate_sync(value, TASK, {**value, "mirrorAccountId": ACCOUNT, "passwordCheckpoint": value["password"]})

    def test_authorization_guard_blocks_password_post(self):
        integration = object.__new__(apple.AppleMailboxIntegration)
        integration.contexts = {TASK: {"authorizationOnly": True}}
        integration.lock = threading.RLock()
        original = Mock()
        session = SimpleNamespace(post=original)
        endpoints = {"register": "https://auth.example.invalid/register", "signup": "https://auth.example.invalid/continue"}
        engine = SimpleNamespace()
        with patch.object(apple.importlib, "import_module", return_value=SimpleNamespace(OPENAI_API_ENDPOINTS=endpoints)):
            integration.guard_session(engine, TASK, session)
        with self.assertRaises(ValueError):
            session.post(endpoints["register"], data="{}")
        original.assert_not_called()

    def test_authorization_guard_selects_login_without_replacing_email(self):
        integration = object.__new__(apple.AppleMailboxIntegration)
        integration.contexts = {TASK: {"authorizationOnly": True}}
        integration.lock = threading.RLock()
        original = Mock()
        session = SimpleNamespace(post=original)
        endpoints = {"register": "https://auth.example.invalid/register", "signup": "https://auth.example.invalid/continue"}
        with patch.object(apple.importlib, "import_module", return_value=SimpleNamespace(OPENAI_API_ENDPOINTS=endpoints)):
            integration.guard_session(SimpleNamespace(), TASK, session)
        session.post(endpoints["signup"], data=json.dumps({"username": {"value": "unit@example.invalid"}, "screen_hint": "signup"}))
        body = json.loads(original.call_args.kwargs["data"])
        self.assertEqual(body["screen_hint"], "login")
        self.assertEqual(body["username"]["value"], "unit@example.invalid")

    def test_creation_confirmation_rejects_html_json_errors_and_wrong_origin(self):
        endpoint = "https://auth.openai.com/api/accounts/create_account"
        def response(value=None, url=endpoint, error=None):
            return SimpleNamespace(status_code=200, url=url, json=Mock(side_effect=error, return_value=value))
        self.assertTrue(apple.confirms_account_creation(endpoint, response({})))
        for value in ({"error": {"message": "fixture"}}, {"errors": []}, {"success": False}, [], "html", None):
            self.assertFalse(apple.confirms_account_creation(endpoint, response(value)))
        self.assertFalse(apple.confirms_account_creation(endpoint, response(error=ValueError("HTML page"))))
        for wrong in ("https://example.invalid/create", "http://auth.openai.com/api/accounts/create_account",
                      "https://auth.openai.com.example.invalid/create", "https://user@auth.openai.com/create",
                      "https://auth.openai.com:444/create"):
            self.assertFalse(apple.confirms_account_creation(wrong, response({})))
            self.assertFalse(apple.confirms_account_creation(endpoint, response({}, url=wrong)))

    def test_invalid_create_200_keeps_unknown_lease_and_never_persists_created_account(self):
        endpoint = "https://auth.openai.com/api/accounts/create_account"
        facts = MemoryFacts({"email": "unit@example.invalid", "operatorId": "fixture-admin"},
            {**apple.empty_record("unit@example.invalid"), "activeTaskUuid": TASK, "lastTaskUuid": TASK})
        facts.registered = Mock(side_effect=AssertionError("invalid response cannot prove creation"))
        integration = object.__new__(apple.AppleMailboxIntegration)
        integration.store, integration.sessions = facts, facts.sessions
        integration.contexts, integration.lock = {TASK: {}}, threading.RLock()
        integration.persist_created_account = Mock(side_effect=AssertionError("invalid response cannot save created account"))
        invalid = SimpleNamespace(status_code=200, url=endpoint, json=Mock(return_value={"error": "fixture error"}))
        session = SimpleNamespace(post=Mock(return_value=invalid), get=Mock())
        engine = SimpleNamespace(session=session, http_client=SimpleNamespace(get=Mock()),
            _submit_signup_form=Mock(), _send_verification_code=Mock(), _mark_email_as_registered=Mock())
        # Reproduce the frozen method's exact status-only contract. The real
        # adapter must reject the explicit error before this can return True.
        def upstream_create():
            try:
                return engine.session.post(endpoint).status_code == 200
            except Exception:
                return False
        engine._create_user_account = upstream_create
        endpoints = {"register": "https://auth.openai.com/register", "signup": "https://auth.openai.com/continue", "create_account": endpoint}
        with patch.object(apple.importlib, "import_module", return_value=SimpleNamespace(OPENAI_API_ENDPOINTS=endpoints)):
            integration.guard_session(engine, TASK, session)
        integration.observe_engine(engine, SimpleNamespace(context={"taskUuid": TASK, "email": "unit@example.invalid"}, otp_lower_bound=None))
        self.assertFalse(engine._create_user_account())
        facts.registered.assert_not_called()
        integration.persist_created_account.assert_not_called()
        self.assertNotIn("creationConfirmed", facts.data)
        facts.read = Mock(return_value=facts.record)
        facts.models.RegistrationTask = Mock()
        facts.db.query.return_value.filter_by.return_value.first.return_value = SimpleNamespace(status="failed")
        apple.RegistrationFacts.finish(facts, "unit@example.invalid", TASK, False)
        self.assertEqual(facts.record["registrationStatus"], "unknown")
        self.assertEqual(facts.record["taskStatus"], "awaiting_review")
        self.assertEqual(facts.record["activeTaskUuid"], TASK)

    def test_served_assets_remove_subscription_and_keep_uploads(self):
        html = workspace.transform_asset((workspace.UPSTREAM_DIR / "templates/accounts.html").read_text(), html=True)
        script = workspace.transform_asset((workspace.UPSTREAM_DIR / "static/js/accounts.js").read_text(), asset_name="accounts.js")
        self.assertNotIn('id="batch-check-sub-btn"', html)
        self.assertNotIn("markSubscription(", script)
        self.assertNotIn("/mark-subscription", script)
        self.assertIn("/upload-tm", script)
        self.assertIn("/batch-upload-tm", script)
        self.assertIn("window.idRegistrationAccountFacts(account)", script)
        self.assertIn("注册结果与凭据", html)

    def test_native_statistics_refresh_after_action_and_pending_completion(self):
        script = r"""
const assert = require('node:assert/strict');
globalThis.window = globalThis;
let pending = false, stats = 0, polls = 0;
window.addEventListener = () => {};
window.clearTimeout = () => {};
window.setTimeout = () => { polls += 1; return polls; };
window.loadAccounts = async () => { window.idRegistrationPending = pending; };
window.loadStats = async () => { stats += 1; };
require('node:vm').runInThisContext(require('node:fs').readFileSync(0, 'utf8'));
(async () => {
  await window.loadAccounts();
  assert.equal(stats, 0, 'initial page already loads its own statistics');
  window.idRegistrationRefreshStats = true;
  await window.loadAccounts();
  assert.equal(stats, 1, 'completed user action refreshes statistics');
  pending = true;
  await window.loadAccounts();
  assert.equal(stats, 1, 'pending row does not duplicate statistics requests');
  assert.equal(polls, 1);
  pending = false;
  await window.loadAccounts();
  assert.equal(stats, 2, 'background completion refreshes statistics');
})().catch(error => { console.error(error); process.exitCode = 1; });
"""
        result = subprocess.run(["node", "-e", script], input=workspace._REGISTRATION_ACCOUNT_BRIDGE,
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_payment_boundary_retires_only_subscription_routes(self):
        async def call(path):
            app = Mock()
            async def target(scope, receive, send):
                await send({"type": "http.response.start", "status": 200, "headers": []})
                await send({"type": "http.response.body", "body": b"ok"})
            boundary = workspace.WorkspaceGatewayBoundary(target, "fixture-token", Path("/not-opened"))
            output = []
            async def send(value): output.append(value)
            async def receive(): return {"type": "http.request", "body": b""}
            with patch.object(workspace, "maintenance_active", return_value=False):
                await boundary({"type": "http", "method": "POST", "path": path,
                                "headers": [(b"x-id-workspace-token", b"fixture-token")]}, receive, send)
            return output[0]["status"]
        for path in ("/api/payment/generate-link", "/api/payment/accounts/7/mark-subscription", "/api/payment/accounts/batch-check-subscription"):
            self.assertEqual(asyncio.run(call(path)), 410)
        self.assertEqual(asyncio.run(call("/api/payment/accounts/7/upload-tm")), 200)


if __name__ == "__main__":
    unittest.main()
