"""Approved, additive CDC prerequisites on the managed production host only.

No business writes, password changes, application restarts or payment actions.
Credentials stay in host memory and the existing sealed-credential store.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import subprocess

ROOT = Path('/opt/id-business-independent')
CONTAINER = 'id-business-independent-formal-mysql'
DATABASE = 'id_redesign_codexdaichong_prod'
USER = 'id_recharge_events'
HOST = '172.17.0.1'
CREDENTIAL = 'independent-recharge-events'
TABLES = ('task_logs', 'billing_records', 'cdk_codes', 'card_assets',
          'orbitcard_card_usage', 'orbitcard_card_recharges')


def run(args, data=None):
    result = subprocess.run(args, input=data, capture_output=True, timeout=30)
    if result.returncode:
        raise RuntimeError('managed_event_preparation_failed')
    return result.stdout


def credential(name):
    value = run(['systemd-creds', 'decrypt', '--name=' + name,
                 str(ROOT / 'formal/private' / (name + '.cred')), '-']).decode().strip()
    if not re.fullmatch('[a-f0-9]{64}', value):
        raise RuntimeError('sealed_credential_invalid')
    return value


def grant_statements():
    account = "'" + USER + "'@'" + HOST + "'"
    return ['GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO ' + account] + [
        f'GRANT SELECT ON `{DATABASE}`.`{table}` TO {account}' for table in TABLES]


def prepare():
    if os.geteuid() != 0 or not (ROOT / 'formal/private').is_dir():
        raise RuntimeError('managed_host_required')
    with (ROOT / 'formal/.application-release.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        password = credential('independent-mysql-root')
        container = json.loads(run(['docker', 'inspect', CONTAINER]))[0]
        if container['NetworkSettings']['Ports'].get('3306/tcp') != [{'HostIp': '127.0.0.1', 'HostPort': '44576'}] or \
                {network['Gateway'] for network in container['NetworkSettings']['Networks'].values()} != {HOST}:
            raise RuntimeError('mysql_private_network_changed')

        def sql(statement):
            return run(['docker', 'exec', '-i', CONTAINER, 'bash', '-ec',
                        'IFS= read -r MYSQL_PWD; export MYSQL_PWD; '
                        'exec mysql --host=127.0.0.1 --user=root --batch --skip-column-names'],
                       (password + '\n' + statement + ';\n').encode()).decode().strip()

        values = sql('SELECT @@version, @@log_bin, @@binlog_format, @@binlog_row_image, '
                     '@@binlog_row_metadata, @@binlog_expire_logs_seconds, @@gtid_mode').split('\t')
        if len(values) != 7 or not values[0].startswith('8.4.') or values[1:4] != ['1', 'ROW', 'FULL'] or \
                values[4] not in ('MINIMAL', 'FULL') or values[5:] != ['2592000', 'OFF']:
            raise RuntimeError('mysql_baseline_changed')
        existing = sql(f"SELECT COUNT(*) FROM mysql.user WHERE User='{USER}'")
        if any(row.split('\t')[0] == '3511012' for row in sql('SHOW REPLICAS').splitlines()):
            raise RuntimeError('event_server_identity_already_used')
        sealed = ROOT / 'formal/private' / (CREDENTIAL + '.cred')
        if existing != '0':
            raise RuntimeError('event_account_already_exists_read_back_before_retry')
        if sealed.exists() or sealed.is_symlink():
            raise RuntimeError('event_credential_already_exists_inspect_before_retry')
        # Create the durable encrypted recovery source before creating the user.
        # If a later step fails, retain it for reconciliation; never rotate it.
        new_password = secrets.token_hex(32)
        run(['systemd-creds', 'encrypt', '--name=' + CREDENTIAL, '-', str(sealed)], new_password.encode())
        sealed.chmod(0o600)
        if credential(CREDENTIAL) != new_password:
            raise RuntimeError('sealed_credential_readback_failed')
        account = "'" + USER + "'@'" + HOST + "'"
        sql(f"CREATE USER {account} IDENTIFIED BY '{new_password}' REQUIRE SSL WITH MAX_USER_CONNECTIONS 4")
        for grant in grant_statements():
            sql(grant)
        # Dynamic GLOBAL metadata; persisted by MySQL itself. No restart and no
        # changes to ROW format, row image, GTID, retention or existing accounts.
        sql("SET PERSIST binlog_row_metadata = 'FULL'")
        after = sql('SELECT @@binlog_row_metadata, @@binlog_format, @@binlog_row_image, '
                    '@@binlog_expire_logs_seconds, @@gtid_mode').split('\t')
        if after != ['FULL', 'ROW', 'FULL', '2592000', 'OFF']:
            raise RuntimeError('metadata_readback_failed')
        persisted = sql("SELECT VARIABLE_VALUE FROM performance_schema.persisted_variables "
                        "WHERE VARIABLE_NAME='binlog_row_metadata'")
        if persisted != 'FULL':
            raise RuntimeError('metadata_persistence_failed')
        grants = sql('SHOW GRANTS FOR ' + account).splitlines()
        expected = {f'GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO `{USER}`@`{HOST}`'} | {
            f'GRANT SELECT ON `{DATABASE}`.`{table}` TO `{USER}`@`{HOST}`' for table in TABLES}
        if set(grants) != expected:
            raise RuntimeError('event_grants_mismatch')
        return {'account': USER, 'host': HOST, 'tables': list(TABLES), 'grants': grants,
                'metadataBefore': values[4], 'metadataAfter': after[0], 'persisted': persisted,
                'sealedCredential': CREDENTIAL, 'businessWrites': 0, 'restarts': 0}


if __name__ == '__main__':
    try:
        print(json.dumps(prepare(), sort_keys=True))
    except Exception as error:
        # Even native command errors may contain SQL; emit fixed codes only.
        message = str(error)
        print(message if re.fullmatch('[a-z_]+', message) else 'event_preparation_unavailable')
        raise SystemExit(1)
