"""Runs only in a GitHub-hosted isolated MySQL service, never on a workstation."""
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import time
import pymysql

if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("CDC_ISOLATION") != "synthetic-only":
    raise SystemExit("remote_isolation_required")

root = Path(__file__).resolve().parents[2]
output = root / ".runtime/external-event-isolation"
output.mkdir(parents=True, exist_ok=True, mode=0o700)
database = "isolated_events"
port = int(os.environ["CDC_MYSQL_PORT"])
connection = pymysql.connect(host="127.0.0.1", port=port, user="root", password="", autocommit=True)
with connection.cursor() as cursor:
    cursor.execute("SET GLOBAL binlog_format='ROW'")
    cursor.execute("SET GLOBAL binlog_row_image='FULL'")
    cursor.execute("SET PERSIST binlog_row_metadata='FULL'")
    cursor.execute("SELECT VARIABLE_VALUE FROM performance_schema.persisted_variables WHERE VARIABLE_NAME='binlog_row_metadata'")
    assert cursor.fetchone()[0] == 'FULL'
    cursor.execute("CREATE DATABASE isolated_events")
    cursor.execute("USE isolated_events")
    cursor.execute("CREATE TABLE task_logs (job_key VARCHAR(120) PRIMARY KEY, "
                   "session_payload TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, "
                   "updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ENGINE=InnoDB")
    for table in ("billing_records", "cdk_codes", "card_assets", "orbitcard_card_usage", "orbitcard_card_recharges"):
        cursor.execute(f"CREATE TABLE {table} (id INT PRIMARY KEY, job_key VARCHAR(120), secret_field TEXT) ENGINE=InnoDB")
    cursor.execute("CREATE TABLE bootstrap_aux (id INT PRIMARY KEY) ENGINE=InnoDB")
    cursor.execute("INSERT INTO task_logs(job_key,session_payload,created_at) VALUES "
                   "('snapshot-job','synthetic-private-value',DATE_SUB(CURRENT_TIMESTAMP,INTERVAL 1 DAY))")
    cursor.execute("CREATE USER 'isolated_event_reader'@'%' IDENTIFIED BY 'synthetic-reader-password' REQUIRE SSL WITH MAX_USER_CONNECTIONS 4")
    cursor.execute("GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'isolated_event_reader'@'%'")
    for table in ("task_logs", "billing_records", "cdk_codes", "card_assets", "orbitcard_card_usage", "orbitcard_card_recharges"):
        cursor.execute(f"GRANT SELECT ON isolated_events.{table} TO 'isolated_event_reader'@'%'")
    cursor.execute("SHOW GRANTS FOR 'isolated_event_reader'@'%'")
    grants = {row[0] for row in cursor.fetchall()}
    expected_grants = {"GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO `isolated_event_reader`@`%`"} | {
        f"GRANT SELECT ON `isolated_events`.`{table}` TO `isolated_event_reader`@`%`" for table in
        ("task_logs", "billing_records", "cdk_codes", "card_assets", "orbitcard_card_usage", "orbitcard_card_recharges")}
    assert grants == expected_grants
certificate = output / 'mysql-ca.pem'
certificate.write_bytes(subprocess.check_output(['docker', 'exec', os.environ['CDC_MYSQL_CONTAINER'],
                                                'cat', '/var/lib/mysql/ca.pem']))
config = {"host": "127.0.0.1", "port": port, "user": "isolated_event_reader", "password": "synthetic-reader-password", "database": database,
          "serverId": 3511012, "sinceEpochSeconds": int(time.time()) - 60, "caFile": str(certificate)}
config_file = output / "synthetic-config.json"
config_file.write_text(json.dumps(config)); config_file.chmod(0o600)
checkpoint = output / "checkpoint.json"
process = None
checks = ['metadata_full_is_dynamic_and_persisted']
reader_connection = pymysql.connect(host='127.0.0.1', port=port, user=config['user'], password=config['password'], database=database,
                                    ssl_ca=str(certificate), ssl_verify_cert=True, ssl_verify_identity=False)
try:
    with reader_connection.cursor() as cursor:
        cursor.execute("SHOW SESSION STATUS LIKE 'Ssl_cipher'")
        assert cursor.fetchone()[1]
        checks.append('reader_tls_certificate_verified')
        try:
            cursor.execute("INSERT INTO task_logs(job_key) VALUES ('forbidden-reader-write')")
            raise AssertionError('reader_must_not_write')
        except pymysql.err.OperationalError as error:
            assert error.args[0] == 1142
    checks.append('least_privilege_reader_cannot_write')
finally:
    reader_connection.close()


def start():
    return subprocess.Popen([sys.executable, "-B", str(root / "modules/external-events/recharge_cdc.py"),
                             str(config_file), str(checkpoint)], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)


def receive(timeout=12):
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        if not selector.select(timeout):
            raise AssertionError("subscriber_event_timeout")
    line = process.stdout.readline()
    assert line, "subscriber_closed"
    assert "synthetic-private-value" not in line and "secret_field" not in line and "session_payload" not in line
    event = json.loads(line)
    assert set(event) == {"version", "receipt", "jobs", "scopes", "reconcile"}
    return event


def idle():
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        assert not selector.select(0.4), "unexpected_event_without_commit"


def acknowledge(event):
    process.stdin.write(event["receipt"] + "\n"); process.stdin.flush()


def stop():
    process.terminate()
    process.wait(timeout=10)
    for pipe in (process.stdin, process.stdout, process.stderr):
        pipe.close()


def wait_for_heartbeats(count):
    observed = bytearray()
    deadline = time.monotonic() + 40
    with selectors.DefaultSelector() as selector:
        selector.register(process.stderr, selectors.EVENT_READ)
        while observed.count(b"recharge_event_subscriber_heartbeat\n") < count:
            remaining = deadline - time.monotonic()
            assert remaining > 0 and selector.select(remaining), "subscriber_heartbeat_timeout"
            chunk = os.read(process.stderr.fileno(), 4096)
            assert chunk, "subscriber_closed_before_heartbeat"
            observed.extend(chunk)
    assert b"recharge_event_subscriber_review_required" not in observed


def assert_schema_stop(statement):
    previous = checkpoint.read_bytes()
    with connection.cursor() as cursor:
        cursor.execute(statement)
    process.wait(timeout=10)
    assert process.returncode == 2
    assert process.stderr.read().strip().splitlines()[-1] == "recharge_event_subscriber_review_required"
    assert checkpoint.read_bytes() == previous
    for pipe in (process.stdin, process.stdout, process.stderr):
        pipe.close()


try:
    process = start()
    first = receive(); assert first["jobs"] == ["snapshot-job"]
    acknowledge(first)
    until = time.monotonic() + 10
    while time.monotonic() < until:
        if json.loads(checkpoint.read_text())["snapshotDone"]:
            break
        time.sleep(0.05)
    assert json.loads(checkpoint.read_text())["snapshotDone"]
    checks.extend(["snapshot_before_incremental", "older_created_task_with_new_update_is_in_snapshot"])
    connection.begin()
    with connection.cursor() as cursor:
        cursor.execute("INSERT INTO task_logs(job_key,session_payload) VALUES ('rolled-back','synthetic-private-value')")
    idle(); connection.rollback(); idle()
    checks.append("rollback_and_uncommitted_rows_emit_nothing")
    connection.begin()
    with connection.cursor() as cursor:
        cursor.executemany("INSERT INTO task_logs(job_key,session_payload) VALUES (%s,%s)",
                           [(f"committed-{i:02}", "synthetic-private-value") for i in range(19)])
    idle(); connection.commit()
    committed = receive(); assert len(committed["jobs"]) == 19
    before = checkpoint.read_bytes()
    stop(); process = start()
    replay = receive(); assert replay == committed
    assert checkpoint.read_bytes() == before
    acknowledge(replay)
    until = time.monotonic() + 10
    while checkpoint.read_bytes() == before and time.monotonic() < until:
        time.sleep(0.05)
    assert checkpoint.read_bytes() != before
    checks.append("crash_before_ack_replays_same_receipt")
    stop(); process = start(); idle()
    with connection.cursor() as cursor:
        cursor.execute("INSERT INTO billing_records VALUES (1, 'committed-00', 'synthetic-private-value')")
    bill = receive(); assert bill["jobs"] == [] and bill["scopes"] == ["billing_records"] and bill["reconcile"]
    acknowledge(bill); idle()
    checks.extend(["restart_after_ack_does_not_replay", "late_bill_requests_reconciliation", "sensitive_fields_never_emitted"])
    old_file = json.loads(checkpoint.read_text())['position']['file']
    with connection.cursor() as cursor:
        cursor.execute('FLUSH BINARY LOGS')
    until = time.monotonic() + 10
    while json.loads(checkpoint.read_text())['position']['file'] == old_file and time.monotonic() < until:
        time.sleep(0.05)
    assert json.loads(checkpoint.read_text())['position']['file'] != old_file
    idle()
    checks.append('idle_rotation_advances_private_position_without_business_event')
    # Leave the old position in place across the same initialization sequence
    # that stopped the production reader, then replay the next committed row.
    before_bootstrap = checkpoint.read_bytes()
    stop()
    with connection.cursor() as cursor:
        cursor.execute("CREATE TABLE IF NOT EXISTS bootstrap_aux (id INT PRIMARY KEY) "
                       "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci")
        cursor.execute("CREATE TABLE IF NOT EXISTS task_logs (job_key VARCHAR(120) PRIMARY KEY) ENGINE=InnoDB")
        cursor.execute("INSERT INTO task_logs(job_key, session_payload) VALUES ('after-bootstrap', 'synthetic-private-value')")
    process = start()
    resumed = receive()
    assert resumed["jobs"] == ["after-bootstrap"]
    after_bootstrap = checkpoint.read_bytes()
    assert after_bootstrap != before_bootstrap
    acknowledge(resumed)
    until = time.monotonic() + 10
    while checkpoint.read_bytes() == after_bootstrap and time.monotonic() < until:
        time.sleep(0.05)
    assert checkpoint.read_bytes() != after_bootstrap
    checks.append("existing_table_initialization_replays_from_checkpoint_then_delivers_committed_order")
    wait_for_heartbeats(2)
    idle()
    checks.append("live_idle_reader_emits_heartbeats_without_business_events")
    assert_schema_stop("ALTER TABLE task_logs ADD COLUMN isolated_extra INT")
    checks.append("alter_table_stops_without_advancing")

    checkpoint = output / "new-table-checkpoint.json"
    process = start()
    acknowledge(receive())
    wait_for_heartbeats(1)
    assert_schema_stop("CREATE TABLE IF NOT EXISTS actual_new_table (id INT PRIMARY KEY) ENGINE=InnoDB")
    checks.append("actual_create_if_not_exists_stops_without_advancing")
finally:
    if process and process.poll() is None:
        stop()
    connection.close()
    config_file.unlink(missing_ok=True)

(output / "result.json").write_text(json.dumps({"passed": checks, "productionConnections": 0}, indent=2) + "\n")
print(json.dumps({"passed": checks, "productionConnections": 0}))
