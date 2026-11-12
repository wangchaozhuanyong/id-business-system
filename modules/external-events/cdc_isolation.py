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
    cursor.execute("SET GLOBAL binlog_row_metadata='FULL'")
    cursor.execute("CREATE DATABASE isolated_events")
    cursor.execute("USE isolated_events")
    cursor.execute("CREATE TABLE task_logs (job_key VARCHAR(120) PRIMARY KEY, "
                   "session_payload TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB")
    for table in ("billing_records", "cdk_codes", "card_assets", "orbitcard_card_usage", "orbitcard_card_recharges"):
        cursor.execute(f"CREATE TABLE {table} (id INT PRIMARY KEY, job_key VARCHAR(120), secret_field TEXT) ENGINE=InnoDB")
    cursor.execute("INSERT INTO task_logs(job_key,session_payload) VALUES ('snapshot-job','synthetic-private-value')")
config = {"host": "127.0.0.1", "port": port, "user": "root", "password": "", "database": database,
          "serverId": 3511012, "sinceEpochSeconds": 0}
config_file = output / "synthetic-config.json"
config_file.write_text(json.dumps(config)); config_file.chmod(0o600)
checkpoint = output / "checkpoint.json"
process = None
checks = []


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
    checks.append("snapshot_before_incremental")
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
    with connection.cursor() as cursor:
        cursor.execute("ALTER TABLE task_logs ADD COLUMN isolated_extra INT")
    process.wait(timeout=10)
    assert process.returncode != 0
    assert process.stderr.read().strip() == "recharge_event_subscriber_unavailable"
    checks.append("schema_change_stops_without_advancing")
finally:
    if process and process.poll() is None:
        stop()
    connection.close()
    config_file.unlink(missing_ok=True)

(output / "result.json").write_text(json.dumps({"passed": checks, "productionConnections": 0}, indent=2) + "\n")
print(json.dumps({"passed": checks, "productionConnections": 0}))
