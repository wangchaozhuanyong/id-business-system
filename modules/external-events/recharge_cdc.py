"""Independent read-only MySQL ROW subscriber. Never imports the payment core.

stdout contains bounded job identifiers and table categories only. The parent
acknowledges a receipt over stdin after applying the existing business rules.
Neither raw binlog rows nor credentials are logged or written to checkpoints.
"""
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

TABLES = frozenset(("task_logs", "billing_records", "cdk_codes", "card_assets",
                   "orbitcard_card_usage", "orbitcard_card_recharges"))
JOB = re.compile(r"[A-Za-z0-9_-]{1,120}\Z")
FILE = re.compile(r"[A-Za-z0-9_.-]{1,160}\Z")


class Unavailable(RuntimeError):
    pass


def private_json(path):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
        raise Unavailable("private_file_required")
    return json.loads(path.read_text())


def save_checkpoint(path, value):
    path = Path(path)
    # The configured project-owned runtime directory must already exist.
    if not path.parent.is_dir() or path.is_symlink():
        raise Unavailable("checkpoint_path_invalid")
    fd, filename = tempfile.mkstemp(prefix=path.name + ".pending-", dir=path.parent)
    temporary = Path(filename)
    try:
        with os.fdopen(fd, "w") as target:
            json.dump(value, target, separators=(",", ":"))
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary.exists():
            temporary.unlink()


class Transaction:
    def __init__(self):
        self.jobs = set()
        self.scopes = set()

    def rows(self, table, rows):
        if table not in TABLES:
            return
        self.scopes.add(table)
        if table not in ("task_logs", "orbitcard_card_recharges"):
            return
        for row in rows:
            # Both sides matter when a task key is changed or removed.
            for values in (row.get("values"), row.get("before_values"), row.get("after_values")):
                if values is None:
                    continue
                value = values.get("job_key")
                if not isinstance(value, str) or not JOB.fullmatch(value):
                    raise Unavailable("task_identity_unavailable")
                self.jobs.add(value)
                if len(self.jobs) > 512:
                    raise Unavailable("transaction_too_large")

    def event(self, source, position, snapshot=False):
        event = {"version": 1, "jobs": sorted(self.jobs), "scopes": sorted(self.scopes),
                 "reconcile": bool(self.scopes - {"task_logs"}) or snapshot}
        # The opaque receipt identifies replayed work without exposing position
        # or a source identifier to downstream observers.
        raw = json.dumps([source, position, event], sort_keys=True, separators=(",", ":"))
        event["receipt"] = hashlib.sha256(raw.encode()).hexdigest()
        return event


def deliver(event):
    print(json.dumps(event, separators=(",", ":")), flush=True)
    acknowledgement = sys.stdin.readline(256)
    if acknowledgement != event["receipt"] + "\n":
        raise Unavailable("event_not_acknowledged")


def scalar(connection, sql):
    with connection.cursor() as cursor:
        cursor.execute(sql)
        return cursor.fetchone()[0]


def preflight(connection, database):
    with connection.cursor() as cursor:
        cursor.execute("SELECT @@version, @@server_uuid, @@log_bin, @@binlog_format, "
                       "@@binlog_row_image, @@binlog_row_metadata")
        version, source, enabled, format_, image, metadata = cursor.fetchone()
        # This first connector is deliberately limited to the tested MySQL 8
        # family. MariaDB/other versions need their own compatibility evidence.
        if not version.startswith("8.") or not enabled or (format_, image, metadata) != ("ROW", "FULL", "FULL"):
            raise Unavailable("mysql_replication_capability_mismatch")
        cursor.execute("SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=%s", (database,))
        engines = dict(cursor.fetchall())
        if any(engines.get(name) != "InnoDB" for name in TABLES):
            raise Unavailable("transactional_tables_required")
        cursor.execute("SHOW BINARY LOGS")
        logs = {row[0]: row[1] for row in cursor.fetchall()}
        try:
            cursor.execute("SHOW BINARY LOG STATUS")
        except Exception:
            cursor.execute("SHOW MASTER STATUS")
        position = cursor.fetchone()
        if not position or not FILE.fullmatch(position[0]):
            raise Unavailable("binlog_position_unavailable")
        return source, logs, {"file": position[0], "position": position[1]}


def stream(config, checkpoint_path, send=deliver):
    import pymysql
    from pymysqlreplication import BinLogStreamReader
    from pymysqlreplication.event import XidEvent, QueryEvent, RotateEvent
    from pymysqlreplication.row_event import WriteRowsEvent, UpdateRowsEvent, DeleteRowsEvent

    database = config["database"]
    if not re.fullmatch(r"[A-Za-z0-9_]{1,64}", database):
        raise Unavailable("database_name_invalid")
    # Only a private loopback transport or verified TLS is accepted.
    settings = {key: config[key] for key in ("host", "port", "user", "password")}
    if settings["host"] not in ("127.0.0.1", "localhost", "::1"):
        if not isinstance(config.get("caFile"), str):
            raise Unavailable("verified_tls_required")
        settings.update(ssl_ca=config["caFile"], ssl_verify_cert=True, ssl_verify_identity=True)
    settings.update(connect_timeout=10, read_timeout=45, write_timeout=10, charset="utf8mb4")
    if not isinstance(config["serverId"], int) or not 1 <= config["serverId"] <= 2**32 - 1:
        raise Unavailable("replica_identity_invalid")
    since = config["sinceEpochSeconds"]
    if not isinstance(since, int) or since < 0:
        raise Unavailable("snapshot_boundary_required")
    connection = pymysql.connect(**settings, database=database, autocommit=True)
    reader = None
    try:
        source, logs, start = preflight(connection, database)
        if config["serverId"] == scalar(connection, "SELECT @@server_id"):
            raise Unavailable("replica_identity_conflict")
        saved = private_json(checkpoint_path) if Path(checkpoint_path).exists() else None
        if saved:
            start = saved["position"]
            if saved["source"] != source or saved["database"] != database or \
                    start["file"] not in logs or not 4 <= start["position"] <= logs[start["file"]]:
                raise Unavailable("checkpoint_no_longer_available")
        else:
            saved = {"source": source, "database": database, "position": start, "snapshotDone": False}
            save_checkpoint(checkpoint_path, saved)
        if not saved["snapshotDone"]:
            # Capture the log position before reading the snapshot. Commits
            # during the snapshot are replayed afterward, so none are lost.
            last = ""
            while True:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT job_key FROM task_logs WHERE job_key > %s "
                                   "AND created_at >= FROM_UNIXTIME(%s) ORDER BY job_key LIMIT 512", (last, since))
                    rows = cursor.fetchall()
                if not rows:
                    break
                transaction = Transaction()
                transaction.rows("task_logs", [{"values": {"job_key": row[0]}} for row in rows])
                send(transaction.event(source, start, snapshot=True))
                last = rows[-1][0]
            saved["snapshotDone"] = True
            save_checkpoint(checkpoint_path, saved)
        reader = BinLogStreamReader(connection_settings=settings, server_id=config["serverId"],
                                    only_schemas=[database], only_tables=list(TABLES),
                                    only_events=[WriteRowsEvent, UpdateRowsEvent, DeleteRowsEvent,
                                                 XidEvent, QueryEvent, RotateEvent],
                                    log_file=start["file"], log_pos=start["position"],
                                    resume_stream=True, blocking=True, slave_heartbeat=15,
                                    verify_checksum=True, enable_logging=False)
        transaction = Transaction()
        for event in reader:
            if isinstance(event, (WriteRowsEvent, UpdateRowsEvent, DeleteRowsEvent)):
                transaction.rows(event.table, event.rows)
            elif isinstance(event, QueryEvent):
                query = event.query.strip().upper()
                if query == "ROLLBACK":
                    transaction = Transaction()
                elif query not in ("BEGIN", "COMMIT"):
                    # Do not silently continue across DDL or statement logging.
                    raise Unavailable("schema_or_statement_event_requires_review")
                elif query == "COMMIT":
                    raise Unavailable("unexpected_statement_commit")
            elif isinstance(event, XidEvent):
                position = {"file": reader.log_file, "position": event.packet.log_pos}
                if transaction.scopes:
                    send(transaction.event(source, position))
                saved["position"] = position
                save_checkpoint(checkpoint_path, saved)
                transaction = Transaction()
            elif isinstance(event, RotateEvent) and transaction.scopes:
                raise Unavailable("rotation_inside_transaction")
    finally:
        if reader:
            reader.close()
        connection.close()


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    try:
        stream(private_json(sys.argv[1]), sys.argv[2])
    except BaseException:
        # Includes connection/library failures: never emit their raw messages.
        sys.stderr.write("recharge_event_subscriber_unavailable\n")
        sys.exit(1)
