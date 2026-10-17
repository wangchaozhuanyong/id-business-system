"""v4 contract and real AST adapter tests: no application, database or network."""
import copy
from contextlib import ExitStack, nullcontext
import json
from pathlib import Path
import socket
import sqlite3
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import apple_registration_diagnostics as diagnostics
import flow_evidence as flow
import release_safety as safety
import test_registration_parity_unit as parity


class FlowV4Tests(unittest.TestCase):
    def setUp(self):
        self.guards = ExitStack()
        for module, name in ((sqlite3, "connect"), (socket, "socket"), (socket, "create_connection"), (socket, "getaddrinfo")):
            self.guards.enter_context(patch.object(module, name, side_effect=AssertionError("v4 pure test: IO forbidden")))
        self.addCleanup(self.guards.close)

    def response(self, status=200, **kwargs):
        return parity.Response(status, **kwargs)

    def sequence(self, target, values, scenario=None):
        original = parity.Transport.request
        values = iter(values)

        def request(session, method, url, *args, **kwargs):
            if url != target:
                return original(session, method, url, *args, **kwargs)
            session.requests.append((method, url, copy.deepcopy(args), copy.deepcopy(kwargs), session.index))
            session.events.append(("request", method, url))
            value = next(values)
            if isinstance(value, Exception):
                raise value
            if callable(value):
                return value(session)
            return copy.deepcopy(value)

        with patch.object(parity.Transport, "request", request):
            return parity.execute(True, scenario)

    def test_latest_32_observations_keep_global_sequence_and_first_failure(self):
        facts = parity.MemoryFacts([])
        failure = {"stage": "authorize", "errorKind": "http_rejected", "httpStatus": 403,
                   "elapsedMs": 1, "observedAt": parity.STAMP}
        facts.update_task(parity.TASK, firstFailure=failure)
        for _ in range(45):
            evidence = flow.observation(self.response(403), "authorize")
            facts.record_flow_evidence(parity.TASK, "authorize", evidence)
        value = facts.data["flowEvidence"]
        self.assertEqual([row["sequence"] for row in value["attempts"]], list(range(14, 46)))
        self.assertTrue(value["attemptsTruncated"])
        self.assertEqual(facts.data["firstFailure"], failure)
        flow.validate_flow_evidence(value)

    def test_mixed_response_then_network_error_never_reuses_old_response(self):
        run = self.sequence(parity.AUTHORIZE, [self.response(), self.response(403), TimeoutError("fixture-private")],
                            {"cookie_at": 3})
        value = run.facts.data["flowEvidence"]
        self.assertEqual([item["outcome"] for item in value["attempts"]], ["response", "response", "network_error"])
        self.assertEqual([item["observation"]["httpStatus"] if item["observation"] else None for item in value["attempts"]], [200, 403, None])
        self.assertNotIn("authorize", value)
        self.assertEqual(run.facts.data["firstFailure"]["stage"], "authorize")
        self.assertIsNone(run.facts.data["firstFailure"]["httpStatus"])
        self.assertEqual(run.facts.data["firstFailure"]["errorKind"], "network_error")
        self.assertEqual([item[1] for item in run.requests], [parity.AUTHORIZE] * 3)

    def test_sentinel_original_http_client_retries_are_observed_individually(self):
        target = parity.ENDPOINTS["sentinel"]
        run = self.sequence(target, [self.response(500, url=target), self.response(body={"token": "fixture-private"}, url=target)])
        rows = [row for row in run.facts.data["flowEvidence"]["attempts"] if row["stage"] == "sentinel"]
        self.assertEqual([row["observation"]["httpStatus"] for row in rows], [500, 200])
        requests = [item for item in run.requests if item[1] == target]
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0][2:], requests[1][2:])
        self.assertEqual(run.facts.data["flowEvidence"]["sentinel"]["decision"], "accepted")

    def test_sentinel_response_then_terminal_network_failures_clear_summary(self):
        target = parity.ENDPOINTS["sentinel"]
        run = self.sequence(target, [self.response(500, url=target), TimeoutError("private-1"), TimeoutError("private-2")])
        value = run.facts.data["flowEvidence"]
        rows = [row for row in value["attempts"] if row["stage"] == "sentinel"]
        self.assertEqual([row["outcome"] for row in rows], ["response", "network_error", "network_error"])
        self.assertNotIn("sentinel", value)
        self.assertEqual(run.facts.data["firstFailure"]["errorKind"], "network_error")
        self.assertIsNone(run.facts.data["firstFailure"]["httpStatus"])
        self.assertFalse(any(item[1] == parity.ENDPOINTS["signup"] for item in run.requests))

    def test_cookie_presence_observes_before_and_after_without_value(self):
        def add_cookie(session):
            session.cookies["oai-did"] = "fixture-private-device-cookie"
            return self.response()
        run = self.sequence(parity.AUTHORIZE, [add_cookie], {"cookie_at": 3})
        row = run.facts.data["flowEvidence"]["attempts"][0]
        self.assertEqual((row["deviceCookieBefore"], row["deviceCookieAfter"]), ("absent", "present"))
        self.assertNotIn("fixture-private-device-cookie", json.dumps(run.facts.data["flowEvidence"]))
        self.assertEqual(flow.device_cookie_presence(SimpleNamespace()), "not_observed")

    def test_stale_device_cookie_does_not_allow_official_403(self):
        run = parity.execute(True, {"authorize": self.response(403)})
        rows = run.facts.data["flowEvidence"]["attempts"]
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(row["deviceCookieBefore"] == row["deviceCookieAfter"] == "present" for row in rows))
        self.assertTrue(all(row["responseClass"] == "unclassified" for row in rows))
        self.assertEqual(run.generated.call_count, 0)

    def test_explicit_authorize_refusals_stop_after_first_response(self):
        challenge = self.response(403)
        challenge.headers["cf-mitigated"] = "challenge"
        cases = ((challenge, "verification_required"), (self.response(429), "rate_limited"),
                 (self.response(403, body={"error": {"code": "fixture-private"}}), "structured_rejection"))
        for response, classification in cases:
            with self.subTest(classification=classification):
                run = parity.execute(True, {"authorize": response})
                self.assertFalse(run.result.success)
                self.assertEqual([item[1] for item in run.requests], [parity.AUTHORIZE])
                self.assertEqual(len(run.client.sessions), 1)
                rows = run.facts.data["flowEvidence"]["attempts"]
                self.assertEqual(len(rows), 1)
                self.assertEqual((rows[0]["outcome"], rows[0]["responseClass"]), ("response", classification))
                self.assertEqual(run.facts.data["firstFailure"]["stage"], "authorize")
                self.assertEqual(run.facts.data["firstFailure"]["httpStatus"], response.status_code)
                self.assertEqual(run.facts.data["firstFailure"]["errorKind"], "http_rejected")
                self.assertEqual(run.generated.call_count, 0)

    def test_sentinel_explicit_500_refusal_skips_original_http_retry(self):
        target = parity.ENDPOINTS["sentinel"]
        challenge = self.response(500, url=target)
        challenge.headers["cf-mitigated"] = "challenge"
        for response in (challenge, self.response(500, body={"error": "fixture-private"}, url=target)):
            with self.subTest(headers=response.headers):
                run = parity.execute(True, {"sentinel": response})
                self.assertFalse(run.result.success)
                self.assertEqual([item[1] for item in run.requests], [parity.AUTHORIZE, target])
                rows = run.facts.data["flowEvidence"]["attempts"]
                self.assertEqual(len(rows), 2)
                self.assertEqual(rows[-1]["outcome"], "response")
                self.assertEqual(run.facts.data["firstFailure"]["errorKind"], "http_rejected")
                self.assertEqual(run.facts.data["firstFailure"]["httpStatus"], 500)
                self.assertFalse(getattr(run.engine, "_apple_evidence_storage_failed", False))

    def test_normal_transport_errors_keep_original_network_retry(self):
        for target, response in ((parity.AUTHORIZE, self.response()),
                                 (parity.ENDPOINTS["sentinel"], self.response(body={"token": "fixture-private"}, url=parity.ENDPOINTS["sentinel"]))):
            for error in (TimeoutError("fixture-private"), ConnectionError("fixture-private"),
                          parity.NAMESPACE["cffi_requests"].RequestsError("fixture-private")):
                with self.subTest(target=target, error=type(error).__name__):
                    run = self.sequence(target, [error, response])
                    rows = [item for item in run.facts.data["flowEvidence"]["attempts"]
                            if item["stage"] == ("authorize" if target == parity.AUTHORIZE else "sentinel")]
                    self.assertEqual([item["outcome"] for item in rows], ["network_error", "response"])
                    self.assertEqual(sum(item[1] == target for item in run.requests), 2)
                    self.assertTrue(any(item[1] == parity.ENDPOINTS["create_account"] for item in run.requests))
                    # The harness deliberately ends at the original workspace
                    # lookup; a recovered transport error is not its failure.
                    self.assertEqual(run.facts.data["firstFailure"]["stage"], "workspace")
                    self.assertIsNone(getattr(run.engine, "_apple_transport_stop_state", None))

    def test_all_four_evidence_storage_failures_stop_without_new_session(self):
        original = parity.MemoryFacts.record_flow_evidence
        expected = {"authorize": 1, "sentinel": 2, "signup": 3, "password": 4}
        for slot, count in expected.items():
            failed = []
            def record(store, task, observed_slot, evidence, **kwargs):
                if observed_slot == slot and not failed:
                    failed.append(True)
                    raise RuntimeError("fixture-private-storage")
                return original(store, task, observed_slot, evidence, **kwargs)
            with self.subTest(slot=slot), patch.object(parity.MemoryFacts, "record_flow_evidence", record):
                run = parity.execute(True)
            self.assertFalse(run.result.success)
            self.assertEqual(len(run.requests), count)
            self.assertEqual(len(run.client.sessions), 1)
            self.assertEqual(run.facts.data["firstFailure"]["stage"], slot)
            self.assertEqual(run.facts.data["firstFailure"]["httpStatus"], 200)
            self.assertEqual(run.facts.data["firstFailure"]["errorKind"], "evidence_storage_error")
            self.assertEqual(run.facts.data["flowEvidence"]["attempts"][-1]["outcome"], "evidence_storage_error")
            self.assertNotIn("fixture-private-storage", run.result.error_message)

    def test_storage_failure_on_sentinel_500_does_not_become_network_retry(self):
        original = parity.MemoryFacts.record_flow_evidence
        failed = []
        def record(store, task, slot, evidence, **kwargs):
            if slot == "sentinel" and not failed:
                failed.append(True)
                raise RuntimeError("fixture-private-storage")
            return original(store, task, slot, evidence, **kwargs)
        with patch.object(parity.MemoryFacts, "record_flow_evidence", record):
            run = parity.execute(True, {"sentinel": self.response(500, url=parity.ENDPOINTS["sentinel"])})
        self.assertFalse(run.result.success)
        self.assertEqual([item[1] for item in run.requests], [parity.AUTHORIZE, parity.ENDPOINTS["sentinel"]])
        self.assertEqual(run.facts.data["firstFailure"]["errorKind"], "evidence_storage_error")
        self.assertEqual(run.facts.data["firstFailure"]["httpStatus"], 500)
        self.assertEqual(run.facts.data["lastHttpStatus"], 500)

    def test_persistent_evidence_storage_failure_still_stops_transport(self):
        with patch.object(parity.MemoryFacts, "record_flow_evidence", side_effect=RuntimeError("fixture-private-storage")):
            run = parity.execute(True)
        self.assertFalse(run.result.success)
        self.assertEqual([item[1] for item in run.requests], [parity.AUTHORIZE])
        self.assertEqual(len(run.client.sessions), 1)
        self.assertEqual(run.facts.data["firstFailure"]["errorKind"], "evidence_storage_error")
        self.assertEqual(run.facts.data["firstFailure"]["httpStatus"], 200)
        self.assertNotIn("fixture-private-storage", run.result.error_message)

    def test_terminal_stop_keeps_first_failure_and_blocks_late_steps_per_engine(self):
        response = self.response(403)
        response.headers["cf-mitigated"] = "challenge"
        original = parity.MemoryFacts.record_failure
        calls = []
        def failure(store, *args):
            calls.append(args)
            return original(store, *args)
        with patch.object(parity.MemoryFacts, "record_failure", failure):
            run = parity.execute(True, {"authorize": response})
        self.assertFalse(run.result.success)
        self.assertEqual(len(calls), 1)
        first = copy.deepcopy(run.facts.data["firstFailure"])
        count = len(run.requests)
        for action in (run.engine._get_device_id,
                       lambda: run.engine._check_sentinel("fixture-private"),
                       lambda: run.engine._submit_signup_form("fixture-private", "fixture-private"),
                       run.engine._register_password):
            with self.assertRaises(Exception):
                action()
            self.assertEqual(len(run.requests), count)
            self.assertEqual(run.facts.data["firstFailure"], first)
        self.assertEqual(run.generated.call_count, 0)
        rerun = run.engine.run()
        self.assertFalse(rerun.success)
        self.assertEqual(len(run.requests), count)
        self.assertEqual(run.facts.data["firstFailure"], first)
        clean = parity.execute(True)
        self.assertTrue(any(item[1] == parity.ENDPOINTS["create_account"] for item in clean.requests))
        self.assertEqual(clean.facts.data["firstFailure"]["stage"], "workspace")
        self.assertIsNone(getattr(clean.engine, "_apple_transport_stop_state", None))

    def test_original_task_runner_finishes_terminal_engine_as_failed(self):
        response = self.response(403)
        response.headers["cf-mitigated"] = "challenge"
        run = parity.execute(True, {"authorize": response})
        requests = len(run.requests)
        database_statuses, public_statuses = [], []
        def update_task(_db, _task, **updates):
            if "status" in updates:
                database_statuses.append(updates["status"])
            return SimpleNamespace()
        class ProviderType(str):
            TEMPMAIL, CUSTOM_DOMAIN, OUTLOOK = "tempmail", "custom_domain", "outlook"
        namespace = {"Optional": parity.NAMESPACE["Optional"], "List": list,
            "datetime": SimpleNamespace(utcnow=lambda: parity.NAMESPACE["datetime"](2026, 10, 17)),
            "get_db": lambda: nullcontext(object()),
            "crud": SimpleNamespace(update_registration_task=update_task),
            "task_manager": SimpleNamespace(is_cancelled=lambda _: False,
                update_status=lambda _task, status, **_: public_statuses.append(status),
                create_log_callback=lambda *_args, **_kwargs: Mock()),
            "get_proxy_for_registration": lambda _: (None, None), "get_settings": lambda: SimpleNamespace(),
            "EmailServiceType": ProviderType, "EmailServiceFactory": SimpleNamespace(create=lambda *_: object()),
            "RegistrationEngine": lambda **_: run.engine,
            "logger": SimpleNamespace(info=Mock(), warning=Mock(), error=Mock())}
        parity.source_definitions(HERE.parent / "upstream/src/web/routes/registration.py", {},
                                  {"_run_sync_registration_task"}, namespace)
        namespace["_run_sync_registration_task"](parity.TASK, "fixture", None, {})
        self.assertEqual(database_statuses, ["running", "failed"])
        self.assertEqual(public_statuses, ["running", "failed"])
        self.assertEqual(len(run.requests), requests)
        self.assertEqual(run.facts.data["firstFailure"]["stage"], "authorize")

    def test_storage_error_retains_http_fact_and_blocks_further_transport(self):
        original = parity.MemoryFacts.record_flow_evidence
        failures = []
        def record(store, task, slot, evidence, **kwargs):
            if slot == "authorize" and not failures:
                failures.append(True)
                raise RuntimeError("fixture-private-database-error")
            return original(store, task, slot, evidence, **kwargs)
        with patch.object(parity.MemoryFacts, "record_flow_evidence", record):
            run = parity.execute(True)
        self.assertEqual([request[1] for request in run.requests], [parity.AUTHORIZE])
        row = run.facts.data["flowEvidence"]["attempts"][0]
        self.assertEqual((row["outcome"], row["observation"]["httpStatus"]), ("evidence_storage_error", 200))
        self.assertEqual(run.facts.data["firstFailure"]["errorKind"], "evidence_storage_error")
        self.assertEqual(run.facts.data["firstFailure"]["httpStatus"], 200)
        self.assertNotIn("fixture-private-database-error", json.dumps(run.facts.data))

    def test_storage_failure_after_commit_updates_same_observation_not_a_new_request(self):
        original = parity.MemoryFacts.record_flow_evidence
        failures = []
        def record(store, task, slot, evidence, **kwargs):
            result = original(store, task, slot, evidence, **kwargs)
            if slot == "sentinel" and not failures:
                failures.append(True)
                raise RuntimeError("fixture-private-acknowledgement")
            return result
        with patch.object(parity.MemoryFacts, "record_flow_evidence", record):
            run = parity.execute(True)
        rows = [row for row in run.facts.data["flowEvidence"]["attempts"] if row["stage"] == "sentinel"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["outcome"], "evidence_storage_error")
        self.assertFalse(any(item[1] == parity.ENDPOINTS["signup"] for item in run.requests))

    def test_explicit_response_classification_never_guesses_403_cause(self):
        unknown = self.response(403)
        self.assertEqual(flow.response_classification(unknown, "authorize"), "unclassified")
        challenge = self.response(403)
        challenge.headers["cf-mitigated"] = "challenge"
        self.assertEqual(flow.response_classification(challenge, "authorize"), "verification_required")
        structured = self.response(403, body={"error": "fixture-private-message"})
        self.assertEqual(flow.response_classification(structured, "authorize"), "structured_rejection")
        self.assertEqual(flow.response_classification(self.response(429), "authorize"), "rate_limited")
        self.assertEqual(flow.response_classification(None, "authorize"), "not_applicable")
        challenge.url = "https://other.invalid/"
        self.assertEqual(flow.response_classification(challenge, "authorize"), "unclassified")

    def test_sentinel_token_cannot_override_explicit_official_errors(self):
        for field, value in (("error", {"code": "fixture-private"}), ("errors", ["fixture-private"])):
            response = self.response(body={"token": "fixture-private-token", field: value}, url=parity.ENDPOINTS["sentinel"])
            old_shape = flow.observation(response, "sentinel")
            self.assertEqual(old_shape["decision"], "accepted")
            self.assertEqual(flow.response_classification(response, "sentinel", old_shape), "structured_rejection")
            self.assertFalse(flow.response_admitted(response, "sentinel", old_shape))
            run = parity.execute(True, {"sentinel": response})
            self.assertEqual([item[1] for item in run.requests], [parity.AUTHORIZE, parity.ENDPOINTS["sentinel"]])
            row = run.facts.data["flowEvidence"]["attempts"][-1]
            self.assertEqual(row["responseClass"], "structured_rejection")
            self.assertEqual(row["observation"]["decision"], "accepted")
            self.assertNotEqual(run.facts.data["firstFailure"]["errorKind"], "network_error")
            self.assertNotIn("fixture-private", json.dumps(run.facts.data["flowEvidence"]))

    def test_explicit_verification_header_stops_all_four_live_slots(self):
        for slot in ("authorize", "sentinel", "signup", "password"):
            body = {"token": "fixture-private"} if slot == "sentinel" else {} if slot == "password" else {"page": {"type": "password"}}
            response = self.response(body=body, url=parity.ENDPOINTS["sentinel"] if slot == "sentinel" else "https://auth.openai.com/create-account")
            response.headers["cf-mitigated"] = "challenge"
            run = parity.execute(True, {slot: response})
            rows = [row for row in run.facts.data["flowEvidence"]["attempts"] if row["stage"] == slot]
            self.assertTrue(rows)
            self.assertTrue(all(row["responseClass"] == "verification_required" and row["observation"]["decision"] == "accepted" for row in rows))
            forbidden = {"authorize": parity.ENDPOINTS["sentinel"], "sentinel": parity.ENDPOINTS["signup"],
                         "signup": parity.ENDPOINTS["register"], "password": parity.ENDPOINTS["send_otp"]}[slot]
            self.assertFalse(any(item[1] == forbidden for item in run.requests))
            self.assertNotEqual(run.facts.data["firstFailure"]["errorKind"], "network_error")

    def test_live_rejection_does_not_rewrite_legacy_sentinel_evidence(self):
        response = self.response(body={"token": "fixture-private", "error": "fixture-private"}, url=parity.ENDPOINTS["sentinel"])
        for version in (1, 2, 3):
            run = parity.execute(True, {"sentinel": response}, flow_version=version)
            self.assertEqual(run.facts.data["flowEvidence"], {"version": version})
            self.assertFalse(any(item[1] == parity.ENDPOINTS["signup"] for item in run.requests))

    def test_actual_configuration_snapshot_contains_only_closed_equality_booleans(self):
        engine = SimpleNamespace(oauth_manager=SimpleNamespace(**flow.OAUTH_DEFAULTS), proxy_url="http://private:secret@fixture.invalid")
        summary = flow.configuration_summary(engine, "explicit")
        self.assertTrue(all(summary[key] for key in flow.CONFIGURATION_FIELDS - {"proxySource"}))
        self.assertEqual(summary["proxySource"], "explicit")
        self.assertNotIn("secret", json.dumps(summary))
        self.assertNotIn("http", json.dumps(summary))
        facts = parity.MemoryFacts([])
        facts.record_configuration_summary(parity.TASK, summary)
        self.assertEqual(facts.data["flowEvidence"]["configurationSummary"], summary)
        engine.oauth_manager.redirect_uri = "https://fixture.invalid/private"
        self.assertFalse(flow.configuration_summary(engine)["redirectUriMatchesFrozenDefault"])
        self.assertIsNone(flow.configuration_summary(SimpleNamespace())["proxyPresent"])

    def test_frozen_defaults_match_original_source_constants(self):
        constants = parity.literal_constants("OAUTH_CLIENT_ID", "OAUTH_AUTH_URL", "OAUTH_TOKEN_URL", "OAUTH_REDIRECT_URI", "OAUTH_SCOPE")
        self.assertEqual(flow.OAUTH_DEFAULTS, {key: constants["OAUTH_" + key.upper()] for key in flow.OAUTH_DEFAULTS})

    def test_all_historical_versions_remain_byte_identical_during_live_observation(self):
        evidence = flow.observation(self.response(), "signup")
        for version in (1, 2, 3):
            facts = parity.MemoryFacts([], flow_version=version)
            facts.update_task(parity.TASK, flowEvidence={"version": version,
                "signup": flow.observation_for_version("signup", evidence, version)})
            before = facts.row.value
            facts.record_flow_evidence(parity.TASK, "signup", flow.observation(self.response(403), "signup"))
            facts.record_flow_evidence(parity.TASK, "authorize", None, outcome="network_error", response_class="not_applicable")
            facts.record_configuration_summary(parity.TASK, flow.configuration_summary(SimpleNamespace()))
            self.assertEqual(facts.row.value, before)

    def test_closed_validator_rejects_secret_extras_sequence_gaps_and_stale_summary(self):
        evidence = flow.observation(self.response(403), "authorize")
        good = flow.append_attempt(flow.new_flow_evidence(), flow.attempt_evidence("authorize", evidence))
        mutations = [lambda value: value["attempts"][0].update(cookie="fixture-private"),
                     lambda value: value["attempts"][0].update(sequence=True),
                     lambda value: value.update(attemptsTruncated=True),
                     lambda value: value["attempts"][0].update(outcome="network_error"),
                     lambda value: value["attempts"][0].update(responseClass="raw-server-message"),
                     lambda value: value.update(configurationSummary={"proxy": "fixture-private"}),
                     lambda value: value.pop("authorize")]
        for mutate in mutations:
            bad = copy.deepcopy(good)
            mutate(bad)
            with self.assertRaises(ValueError):
                flow.validate_flow_evidence(bad)

    def test_safe_reader_accepts_v4_and_new_diagnostic_stage_without_database(self):
        evidence = flow.observation(self.response(403), "authorize")
        task = {"email": "fixture@example.invalid", "aliasId": "fixture", "resultKind": "failed",
                "flowEvidence": flow.append_attempt(flow.new_flow_evidence(), flow.attempt_evidence("authorize", evidence)),
                "stage": "authorize", "firstFailure": {"stage": "authorize", "errorKind": "evidence_storage_error",
                    "httpStatus": 403, "elapsedMs": 1, "observedAt": parity.STAMP}}
        safety.validate_task(parity.TASK, task)
        task["flowEvidence"]["attempts"][0]["token"] = "fixture-private"
        with self.assertRaises(safety.SafetyError):
            safety.validate_task(parity.TASK, task)

    def test_diagnostic_storage_error_is_separate_from_original_network_exception(self):
        original_error = TimeoutError("fixture-private-network")
        store = SimpleNamespace(update_task=Mock(return_value=True))
        recorder = diagnostics.RegistrationDiagnostics(store, parity.TASK)
        recorder.active = {}
        with self.assertRaises(TimeoutError) as raised:
            recorder.request(Mock(side_effect=original_error))
        self.assertIs(raised.exception, original_error)
        self.assertEqual(recorder.active["errorKind"], "network_error")
        recorder.active = {}
        store.update_task.side_effect = RuntimeError("fixture-private-database")
        with self.assertRaises(diagnostics.EvidenceStorageError) as storage:
            recorder.request(Mock(return_value=self.response(403)))
        self.assertEqual(recorder.active["errorKind"], "evidence_storage_error")
        self.assertEqual(recorder.active["httpStatus"], 403)
        self.assertEqual(storage.exception.http_status, 403)
        self.assertNotIn("fixture-private", str(storage.exception))


if __name__ == "__main__":
    unittest.main()
