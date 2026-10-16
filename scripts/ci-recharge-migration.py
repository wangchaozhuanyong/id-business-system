"""Exercise additive recharge settings and shared pool migrations in owned isolated MySQL."""
from pathlib import Path
import argparse
import json
import subprocess
import time
import uuid
from lib.native_mysql_fixture import NativeMysqlFixture, add_fixture_arguments, validate_fixture_arguments

root = Path(__file__).resolve().parents[1]
name = 'id-business-recharge-migration-' + uuid.uuid4().hex[:12]
image = 'mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb'
parser = argparse.ArgumentParser()
add_fixture_arguments(parser)
args = parser.parse_args()
validate_fixture_arguments(parser, args)
native_fixture = None


def sql(statement):
    if native_fixture is not None:
        result = native_fixture.execute(statement)
        if result.returncode:
            raise subprocess.CalledProcessError(result.returncode, ['native-mysql-fixture'])
        return result.stdout.strip()
    return subprocess.run(['docker', 'exec', '-i', name, 'mysql', '-h127.0.0.1', '-uroot', '-N', '-B', 'recharge_fixture'], input=statement, text=True, capture_output=True, check=True).stdout.strip()


if args.runtime == 'native':
    native_fixture = NativeMysqlFixture('recharge_fixture', args.mysql_bin, args.work_directory)
else:
    subprocess.run(['docker', 'run', '-d', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/mysql', '-e', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes', '-e', 'MYSQL_DATABASE=recharge_fixture', image], check=True, stdout=subprocess.DEVNULL)
try:
    deadline = time.monotonic() + 120
    while True:
        try:
            sql('SELECT 1;')
            break
        except subprocess.CalledProcessError:
            if time.monotonic() >= deadline:
                raise RuntimeError('Disposable MySQL startup timed out') from None
            time.sleep(1)
    migrations = root / 'apps/api/prisma-mysql/migrations'
    sql((migrations / '20260912180000_auto_recharge_bitbrowser_settings/migration.sql').read_text())
    sql("INSERT INTO id_business_v2_recharge_browser_settings(owner_id,updated_at) VALUES ('fixture',NOW());")
    sql((migrations / '20260913100000_auto_recharge_browser_options/migration.sql').read_text())
    assert sql('SELECT COUNT(*) FROM id_business_v2_recharge_browser_settings WHERE browser_options IS NULL AND static_proxy_credentials_encrypted IS NULL;') == '1'
    sql("UPDATE id_business_v2_recharge_browser_settings SET browser_options=JSON_OBJECT('proxyMode','static'),static_proxy_credentials_encrypted='encrypted-fixture' WHERE owner_id='fixture';")
    assert sql("SELECT JSON_UNQUOTE(JSON_EXTRACT(browser_options,'$.proxyMode')),static_proxy_credentials_encrypted FROM id_business_v2_recharge_browser_settings WHERE owner_id='fixture';") == 'static\tencrypted-fixture'
    # Exercise the actual shared-pool migration with duplicate content, old IDs and an
    # existing job foreign key. Only synthetic encrypted payloads enter this fixture.
    sql("CREATE TABLE id_business_v2_recharge_jobs (id CHAR(36) PRIMARY KEY) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;")
    sql((migrations / '20260930210000_recharge_proxy_catalog/migration.sql').read_text())
    source = (migrations / '20261009093000_online_recharge/migration.sql').read_text()
    start = source.index('CREATE TABLE `online_recharge_proxies`')
    sql(source[start:source.index(';', start) + 1])
    original = '11111111-1111-4111-8111-111111111111'
    duplicate = '22222222-2222-4222-8222-222222222222'
    online = '33333333-3333-4333-8333-333333333333'
    sql(f"INSERT INTO id_business_v2_recharge_proxies(id,country_code,kind,connection_mode,protocol,url_encrypted,url_hash,remark1,remark2,updated_at) VALUES ('{original}','PH','mobile','direct','http','synthetic-old','{'a'*64}','first','second',NOW(6));")
    sql(f"INSERT INTO id_business_v2_recharge_jobs(id,proxy_id) VALUES ('fixture-job','{original}');")
    for identity, digest, active in [(duplicate,'a', 'disabled'), (online,'b','active'), (original,'c','active')]:
        protocol = 'extraction' if identity == online else 'http'
        sql(f"INSERT INTO online_recharge_proxies(id,connection_encrypted,connection_hash,display_host,protocol,status,exit_ip,latency_ms,test_message,tested_at,updated_at) VALUES ('{identity}','synthetic-online','{digest*64}','gateway.example.test:8080','{protocol}','{active}','8.8.8.8',25,'test fixture',NOW(6),NOW(6));")
    sql((migrations / '20261015120000_shared_proxy_pool/migration.sql').read_text())
    assert sql('SELECT COUNT(*) FROM id_business_v2_recharge_proxies;') == '3'
    assert sql('SELECT COUNT(*) FROM id_business_v2_proxy_aliases;') == '3'
    assert sql('SELECT COUNT(*) FROM online_recharge_proxies;') == '3'
    assert sql(f"SELECT proxy_id FROM id_business_v2_recharge_jobs WHERE id='fixture-job';") == original
    assert sql(f"SELECT proxy_id FROM id_business_v2_proxy_aliases WHERE old_id='{duplicate}';") == original
    assert sql(f"SELECT proxy_id <> old_id FROM id_business_v2_proxy_aliases WHERE old_id='{original}';") == '1'
    assert sql(f"SELECT HEX(remark),active,exit_ip,latency_ms FROM id_business_v2_recharge_proxies WHERE id='{original}';") == '66697273740A7365636F6E64\t0\t8.8.8.8\t25'
    assert sql(f"SELECT country_code IS NULL AND kind IS NULL FROM id_business_v2_recharge_proxies WHERE id='{online}';") == '1'
    assert sql(f"SELECT connection_mode,protocol FROM id_business_v2_recharge_proxies WHERE id='{online}';") == 'extraction\thttp'
    print('Shared proxy migration passed: deduplication, metadata gaps, collision aliases, history FK, notes, telemetry and retained source verified')
    # Shared cards: execute the real migration against historical task shapes.
    # This fixture runs only in isolated CI; no production data or credentials.
    for table in ['online_recharge_config', 'online_recharge_cards']:
        start = source.index(f'CREATE TABLE `{table}`')
        sql(source[start:source.index(';', start) + 1])
    sql('''CREATE TABLE id_business_v2_bank_recharge_cards (
        id CHAR(36) PRIMARY KEY, number_encrypted TEXT, number_hash CHAR(64), last4 CHAR(4),
        expiry VARCHAR(5), active BOOLEAN, created_at DATETIME(6), updated_at DATETIME(6))
        DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
        CREATE TABLE id_business_v2_bank_recharge_orders (
        id CHAR(36) PRIMARY KEY, card_id CHAR(36), account_id CHAR(36), recharge_job_id CHAR(36),
        verified_at DATETIME(6), status VARCHAR(30))
        DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
        ALTER TABLE id_business_v2_recharge_jobs ADD card_id CHAR(36), ADD state VARCHAR(30),
        ADD result JSON, ADD lease_until DATETIME(6);''')
    cases = [
        ('running', 'running', {'payment_attempted': False}, True),
        ('unknown', 'finished', {'payment_attempted': True, 'payment_status': 'unknown', 'status': 'payment_result_unknown'}, True),
        ('resolved', 'finished', {'payment_attempted': True, 'payment_status': 'unknown', 'status': 'payment_unknown_resolved', 'operator_resolution': 'confirmed_no_bank_request', 'resolution_job_id': str(uuid.UUID(int=999))}, False),
        ('verified', 'finished', {'payment_attempted': True, 'payment_status': 'unknown', 'status': 'payment_result_unknown'}, False),
        ('declined', 'finished', {'payment_attempted': True, 'payment_status': 'declined'}, False),
        ('activated', 'finished', {'payment_attempted': True, 'status': 'subscription_activated'}, False),
    ]
    for index, (label, state, result, _) in enumerate(cases, 1):
        card_id = str(uuid.UUID(int=100 + index))
        job_id = str(uuid.UUID(int=200 + index))
        digest = f'{index:064x}'
        sql(f"INSERT INTO id_business_v2_bank_recharge_cards VALUES ('{card_id}','synthetic-encrypted','{digest}','{index:04d}','12/99',TRUE,NOW(6),NOW(6));")
        sql(f"INSERT INTO id_business_v2_recharge_jobs(id,card_id,state,result,lease_until) VALUES ('{job_id}','{card_id}','{state}','{json.dumps(result)}','2000-01-01');")
        if label == 'verified':
            sql(f"INSERT INTO id_business_v2_bank_recharge_orders VALUES ('{uuid.UUID(int=300)}','{card_id}','{uuid.UUID(int=400)}','{job_id}',NOW(6),'completed');")
    sql((migrations / '20261016150000_shared_bank_card_pool/migration.sql').read_text())
    assert sql('SELECT COUNT(*) FROM online_recharge_cards;') == str(len(cases))
    for index, (label, _, _, retained) in enumerate(cases, 1):
        lease = sql(f"SELECT COALESCE(lease_owner,'none') FROM online_recharge_cards WHERE number_hash='{index:064x}';")
        assert lease == (str(uuid.UUID(int=200 + index)) if retained else 'none'), label
    assert sql("SELECT success_count,JSON_CONTAINS(allowed_plans,JSON_QUOTE('plus')) FROM online_recharge_cards WHERE last4='0004';") == '1\t1'
    print('Shared card migration passed: unresolved leases retained; resolved, verified, declined and activated history stays unlocked')
    print('Recharge migration passed: existing row retained, nullable defaults and new fields verified')
finally:
    if native_fixture is not None:
        native_fixture.close()
    else:
        subprocess.run(['docker', 'rm', '-f', name], check=True, stdout=subprocess.DEVNULL)
