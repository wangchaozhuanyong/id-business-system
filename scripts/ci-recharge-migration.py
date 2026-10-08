"""Exercise only the additive recharge-settings migration in disposable, network-isolated MySQL."""
from pathlib import Path
import argparse
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
    print('Recharge migration passed: existing row retained, nullable defaults and new fields verified')
finally:
    if native_fixture is not None:
        native_fixture.close()
    else:
        subprocess.run(['docker', 'rm', '-f', name], check=True, stdout=subprocess.DEVNULL)
