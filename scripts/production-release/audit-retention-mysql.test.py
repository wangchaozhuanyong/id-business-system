"""Exercise the approved trigger exception in an isolated, networkless MySQL fixture."""
import argparse
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.native_mysql_fixture import NativeMysqlFixture, add_fixture_arguments, validate_fixture_arguments

MIGRATION = Path('apps/api/prisma-mysql/migrations/20261002123500_routine_audit_retention_exception/migration.sql')
SCOPE = 'audit-routine-20261002T110000Z'
spec = importlib.util.spec_from_file_location('storage', Path(__file__).with_name('storage-maintenance.py'))
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)
fixture_args = argparse.Namespace(runtime='docker', mysql_bin=None, work_directory=None)


def static_check():
    sql = MIGRATION.read_text()
    assert storage.retention_migration(sql) == sql
    assert 'FOREIGN_KEY_CHECKS' not in sql and 'GRANT ' not in sql
    assert sql.count('DROP TRIGGER') == 1 and 'idv2_audit_log_no_update' not in sql
    assert all(action in sql for action in storage.ROUTINE_ACTIONS)
    return sql


class RetentionMysqlTests(unittest.TestCase):
    @classmethod
    def command(cls, *args, env=None):
        return subprocess.run(args, env=env, capture_output=True, text=True, timeout=180)

    @classmethod
    def execute(cls, sql, user='root', expected_error=None):
        if cls.native_fixture is not None:
            result = cls.native_fixture.execute(sql, user, cls.password if user != 'root' else None)
        else:
            result = cls.command('docker', 'exec', cls.container, 'sh', '-c',
                'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --host="$4" --protocol="$3" '
                '--database=storage_retention_test --default-character-set=utf8mb4 '
                '--batch --skip-column-names --user="$1" --execute="$2"', 'sh', user, sql,
                'TCP' if user == 'root' else 'SOCKET', '127.0.0.1' if user == 'root' else 'localhost')
        if expected_error:
            if result.returncode == 0 or not re.search(r'ERROR ' + str(expected_error) + r' \(', result.stderr):
                code = re.search(r'ERROR (\d+) \(([A-Z0-9]+)\)', result.stderr)
                raise AssertionError('Expected MySQL error ' + str(expected_error) + '; observed '
                                     + (code[1] if code else 'no error code'))
        elif result.returncode:
            raise AssertionError('MySQL fixture operation failed; private output suppressed')
        return result.stdout.strip()

    @classmethod
    def setUpClass(cls):
        sql = static_check()
        cls.password = secrets.token_hex(24)
        cls.container = 'idv2-audit-retention-test-' + uuid.uuid4().hex[:12]
        cls.native_fixture = None
        if fixture_args.runtime == 'native':
            cls.native_fixture = NativeMysqlFixture('storage_retention_test', fixture_args.mysql_bin, fixture_args.work_directory)
        else:
            env = os.environ.copy()
            env['MYSQL_ROOT_PASSWORD'] = cls.password
            started = cls.command('docker', 'run', '--detach', '--rm', '--network', 'none',
                '--name', cls.container, '-e', 'MYSQL_ROOT_PASSWORD', '-e',
                'MYSQL_DATABASE=storage_retention_test', 'mysql:8.4', env=env)
            if started.returncode:
                raise AssertionError('Isolated MySQL fixture could not start')
        try:
            for _ in range(90):
                try:
                    cls.execute('SELECT 1')
                    break
                except AssertionError:
                    time.sleep(1)
            else:
                raise AssertionError('MySQL fixture readiness timed out')
            cls.execute("CREATE TABLE audit_logs (id CHAR(36) PRIMARY KEY,module VARCHAR(100) NOT NULL,"
                "action VARCHAR(100) NOT NULL,user_id CHAR(36),after_data JSON,created_at DATETIME(6) NOT NULL,"
                "object_type VARCHAR(100),before_data JSON,remark TEXT);"
                "CREATE TABLE audit_refs (id INT PRIMARY KEY,audit_id CHAR(36),"
                "FOREIGN KEY (audit_id) REFERENCES audit_logs(id) ON DELETE RESTRICT);"
                "CREATE USER 'retention_runtime'@'localhost' IDENTIFIED BY '" + cls.password + "';"
                "GRANT SELECT,INSERT,DELETE ON storage_retention_test.* TO 'retention_runtime'@'localhost';"
                "CREATE USER 'retention_readonly'@'localhost' IDENTIFIED BY '" + cls.password + "';"
                "GRANT SELECT ON storage_retention_test.* TO 'retention_readonly'@'localhost';")
            cli_sql = sql.replace('CREATE TRIGGER', 'DELIMITER $$\nCREATE TRIGGER', 1)
            cli_sql = cli_sql.removesuffix('END;\n') + 'END$$\nDELIMITER ;\n'
            cls.execute(cli_sql)
        except BaseException:
            if cls.native_fixture is not None:
                cls.native_fixture.close()
            else:
                cls.command('docker', 'stop', cls.container)
            raise

    @classmethod
    def tearDownClass(cls):
        if cls.native_fixture is not None:
            cls.native_fixture.close()
        else:
            cls.command('docker', 'stop', cls.container)

    def row(self, action=None, module='id_business_v2', user=None, manual=False,
            created='2026-10-02 10:59:59'):
        identity = str(uuid.uuid4())
        user_sql = "'" + user + "'" if user else 'NULL'
        after = "JSON_OBJECT('triggerType','manual')" if manual else 'NULL'
        self.execute("INSERT INTO audit_logs (id,module,action,user_id,after_data,created_at) VALUES ('" + identity + "','" + module + "','"
            + (action or storage.ROUTINE_ACTIONS[0]) + "'," + user_sql + ',' + after + ",'" + created + "')")
        return identity

    def delete(self, identity, user='root', scope=SCOPE, error=None):
        setting = "'" + scope + "'" if scope else 'NULL'
        self.execute('SET @idv2_routine_audit_cleanup_scope=' + setting + "; DELETE FROM audit_logs WHERE id='"
            + identity + "';", user, error)

    def test_default_root_connection_cannot_delete(self):
        self.delete(self.row(), scope=None, error=1644)

    def test_wrong_scope_cannot_delete(self):
        self.delete(self.row(), scope='unapproved', error=1644)

    def test_nonroot_with_delete_privilege_and_flag_is_rejected(self):
        self.delete(self.row(), user='retention_runtime', error=1644)

    def test_all_five_approved_actions_can_be_cleaned(self):
        for action in storage.ROUTINE_ACTIONS:
            identity = self.row(action=action)
            self.delete(identity)
            self.assertEqual(self.execute("SELECT COUNT(*) FROM audit_logs WHERE id='" + identity + "'"), '0')

    def test_employee_owned_record_is_protected(self):
        self.delete(self.row(user=str(uuid.uuid4())), error=1644)

    def test_manual_collection_is_protected(self):
        self.delete(self.row(manual=True), error=1644)

    def test_cutoff_and_newer_records_are_protected(self):
        for created in ('2026-10-02 11:00:00', '2026-10-02 12:00:00'):
            self.delete(self.row(created=created), error=1644)

    def test_other_module_is_protected(self):
        self.delete(self.row(module='security'), error=1644)

    def test_business_failure_security_and_cleanup_records_are_protected(self):
        for action in ('id_business_v2.settings.update', 'id_business_v2.exchange_rate.collect.failed',
                       'security.login', 'maintenance.audit_log.cleanup'):
            self.delete(self.row(action=action), error=1644)

    def test_foreign_key_reference_remains_protected(self):
        identity = self.row()
        self.execute("INSERT INTO audit_refs VALUES (1,'" + identity + "')")
        self.delete(identity, error=1451)

    def test_connection_flag_does_not_override_delete_privileges(self):
        self.delete(self.row(), user='retention_readonly', error=1142)

    def test_atomic_cleanup_sql_checks_digest_records_receipt_and_protects_references(self):
        self.row()
        referenced = self.row()
        self.execute("INSERT INTO audit_refs VALUES (2,'" + referenced + "')")
        refs = [{'table': 'audit_refs', 'column': 'audit_id', 'sameSchema': 1}]
        where = storage.audit_predicate(refs)
        identities = self.execute('SELECT a.id FROM audit_logs a WHERE ' + where + ' ORDER BY a.id').splitlines()
        preview = {'count': len(identities), 'idsSha256': hashlib.sha256(','.join(identities).encode()).hexdigest(),
                   'references': refs}
        backup = {'name': 'id-business-v2-20261002T120000Z.sql.gz', 's3Verified': True}
        wrong = {**preview, 'idsSha256': '0' * 64}
        rejected = json.loads(self.execute(storage.deletion_sql(wrong, backup)))
        self.assertEqual(rejected['deleted'], 0)
        actual = json.loads(self.execute(storage.deletion_sql(preview, backup)))
        self.assertEqual(actual['deleted'], len(identities))
        self.assertEqual(self.execute('SELECT COUNT(*) FROM audit_logs a WHERE ' + where), '0')
        self.assertEqual(self.execute("SELECT COUNT(*) FROM audit_logs WHERE id='" + referenced + "'"), '1')
        self.assertEqual(self.execute("SELECT COUNT(*) FROM audit_logs WHERE action='maintenance.audit_log.cleanup'"), '1')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--static', action='store_true')
    add_fixture_arguments(parser)
    args = parser.parse_args()
    validate_fixture_arguments(parser, args)
    fixture_args = args
    if args.runtime == 'native':
        MIGRATION = Path(__file__).resolve().parents[2] / MIGRATION
    if args.static:
        static_check()
        print('Audit retention static scope verified; MySQL behavior awaits isolated CI fixture')
    else:
        unittest.main(argv=['audit-retention-mysql.test.py'])
