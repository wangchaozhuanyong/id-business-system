#!/usr/bin/env python3
"""Owned, disposable native/adapter canary. No production credentials or payment calls."""
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import runpy
import secrets
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = Path('/opt/id-business-independent')
FORMAL_MYSQL = 'id-business-independent-formal-mysql'
REVISION = '4e9bb201cf481d4bcc85da34970fc26c63ab818a'
OWNER_LABEL = 'com.id-business.native-canary.owner'
SHA_LABEL = 'com.id-business.native-canary.revision'
RETURN_PATHS = {'/api/admin/cdks/returns/check', '/api/admin/cdks/returns/commit', '/api/admin/cdks/returns/receipt'}
STOCK_PATH = '/api/admin/cdks/returns/stock'
ALLOWED_GETS = RETURN_PATHS | {STOCK_PATH, '/api/public/runtime', '/api/admin/session', '/api/admin/cards', '/api/admin/recharge-routing'}
PRIVATE_NETWORKS = tuple(ipaddress.ip_network(value) for value in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))


class CanaryError(Exception):
    pass


def encoded(value):
    return base64.urlsafe_b64encode(value).rstrip(b'=').decode('ascii')


def compact(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False)


def assertion(secret, path, actor, method='GET'):
    value = {'method': method, 'path': path, 'actor': actor, 'exp': int(time.time() * 1000) + 15000}
    payload = encoded(compact(value).encode())
    return payload + '.' + encoded(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest())


def native_token(bridge, version):
    secret = encoded(hmac.new(bridge.encode(), b'id-business/codexdaichong/native-admin-token/f4d7761/v1', hashlib.sha256).digest())
    now = int(time.time() * 1000)
    payload = encoded(compact({'sub': 'admin', 'permissions': ['admin'], 'pv': version,
                              'email': 'canary@example.test', 'iat': now, 'exp': now + 15000}).encode())
    return payload + '.' + encoded(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest())


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_json(origin, path, headers=None, method='GET', body=None):
    if path not in ALLOWED_GETS or not re.fullmatch(r'http://127\.0\.0\.1:[1-9][0-9]{0,4}', origin):
        raise CanaryError('read_endpoint_rejected')
    if method not in ('GET', 'PUT', 'POST') or (method == 'PUT' and path != '/api/admin/recharge-routing') or (method == 'POST' and path not in RETURN_PATHS):
        raise CanaryError('write_endpoint_rejected')
    request = urllib.request.Request(origin + path, headers=headers or {}, method=method,
                                     data=compact(body).encode() if body is not None else None)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPHandler(), NoRedirect())
    try:
        response = opener.open(request, timeout=5)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read(131073)
        if len(raw) > 131072:
            raise CanaryError('response_too_large')
        try:
            value = json.loads(raw)
        except Exception:
            raise CanaryError('invalid_json_response') from None
        return response.status, value


def same_owner(data, sha, owner, container_id, name=None):
    labels = data.get('Config', {}).get('Labels') or {}
    return (data.get('Id') == container_id and labels.get(OWNER_LABEL) == owner and
            labels.get(SHA_LABEL) == sha and labels.get('com.id-business.native-canary') == 'true' and
            (name is None or data.get('Name') == '/' + name))


def mysql_arguments(image, name, database, user, labels, entrypoint):
    script = ('IFS= read -r MYSQL_ROOT_PASSWORD; IFS= read -r MYSQL_PASSWORD; '
              'export MYSQL_ROOT_PASSWORD MYSQL_PASSWORD; exec "$@"')
    return ['docker', 'create', '--rm', '-i', '--name', name, *labels, '--network', 'bridge',
            '--memory', '384m', '--memory-swap', '384m', '--security-opt', 'no-new-privileges',
            '--tmpfs', '/var/lib/mysql:rw,nosuid,nodev,size=256m',
            '--publish', '127.0.0.1::3306', '-e', 'MYSQL_DATABASE=' + database, '-e', 'MYSQL_USER=' + user,
            '--entrypoint', 'bash', image, '-ec', script, '--', *entrypoint, 'mysqld',
            '--innodb-buffer-pool-size=32M', '--innodb-log-buffer-size=4M', '--performance-schema=OFF',
            '--max-connections=12', '--table-open-cache=64', '--tmp-table-size=4M',
            '--max-heap-table-size=4M', '--skip-log-bin', '--mysqlx=0']


def role_arguments(image, role, name, database, user, host, database_port, labels, native_url=None, native_name=None, service_port=3000):
    if role not in ('native', 'adapter'):
        raise CanaryError('invalid_canary_role')
    args = ['docker', 'create', '--rm', '-i', '--name', name, *labels, '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges', '--memory', '512m' if role == 'native' else '192m',
            '--memory-swap', '512m' if role == 'native' else '192m']
    if role == 'native':
        args += ['--network', 'bridge', '--publish', '127.0.0.1::3000', '--shm-size', '64m']
    else:
        args += ['--network', 'host', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m',
                 '-e', 'ID_RECHARGE_NATIVE_URL=' + native_url, '-e', 'ID_RECHARGE_NATIVE_CONTAINER=' + native_name]
    for key, value in {'DB_HOST': host, 'DB_PORT': str(database_port), 'DB_NAME': database, 'DB_USER': user, 'PORT': str(service_port)}.items():
        args += ['-e', key + '=' + value]
    return args + [image, 'canary-' + role]


class Canary:
    def __init__(self, sha):
        if not re.fullmatch('[a-f0-9]{40}', sha):
            raise CanaryError('invalid_release_revision')
        self.sha = sha
        self.image = 'id-business-independent-recharge:' + sha
        self.owner = secrets.token_hex(16)
        self.database = 'id_redesign_codexdaichong_test_release_' + sha[:12]
        self.user = 'canary_' + sha[:12]
        self.password, self.root_password, self.bridge = (secrets.token_hex(32) for _ in range(3))
        self.redactions = [self.password, self.root_password, self.bridge]
        self.names = {role: 'id-native-canary-' + sha[:12] + '-' + role for role in ('mysql', 'native', 'adapter')}
        self.operations = ROOT / 'releases' / sha / 'operations'
        self.receipt = self.operations / 'native-canary.receipt.json'
        self.created = []
        self.created_names = {}
        self.processes = []
        self.readers = []
        self.log_errors = []
        self.checks = []
        self.log_prefix = 'native-canary-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + self.owner[:8]

    def command(self, args, input=None, timeout=15):
        result = subprocess.run(args, input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, check=False)
        if result.returncode:
            raise CanaryError('controlled_command_failed')
        return result.stdout.decode('utf-8').strip()

    def inspect(self, identity):
        return json.loads(self.command(['docker', 'inspect', identity]))[0]

    def labels(self):
        return ['--label', 'com.id-business.native-canary=true', '--label', SHA_LABEL + '=' + self.sha,
                '--label', OWNER_LABEL + '=' + self.owner]

    def log_reader(self, process, role):
        try:
            path = self.operations / (self.log_prefix + '-' + role + '.log')
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as output:
                for line in iter(process.stdout.readline, b''):
                    for value in tuple(self.redactions):
                        line = line.replace(value.encode(), b'[REDACTED]')
                    output.write(line)
                    output.flush()
        except Exception:
            self.log_errors.append(role)

    def start(self, role, args, sealed):
        identity = self.command(args, timeout=30)
        if not re.fullmatch('[a-f0-9]{64}', identity):
            raise CanaryError('invalid_created_container')
        self.created.append(identity)
        self.created_names[identity] = self.names[role]
        data = self.inspect(identity)
        if not same_owner(data, self.sha, self.owner, identity, self.names[role]):
            raise CanaryError('created_container_ownership_mismatch')
        process = subprocess.Popen(['docker', 'start', '--attach', '--interactive', identity],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.processes.append(process)
        reader = threading.Thread(target=self.log_reader, args=(process, role), daemon=True)
        reader.start()
        self.readers.append(reader)
        process.stdin.write(sealed.encode())
        process.stdin.close()
        return identity

    def wait(self, probe, code, timeout=120):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                result = probe()
                if result:
                    self.checks.append(code)
                    return result
            except Exception:
                pass
            if any(process.poll() is not None for process in self.processes):
                raise CanaryError('canary_container_exited')
            time.sleep(1)
        raise CanaryError(code + '_timeout')

    def mysql_query(self, identity, query):
        if query not in ('SELECT 1', "SELECT config_value FROM app_config WHERE config_key = 'admin_password_version'"):
            if query not in getattr(self, 'return_queries', ()) or identity != getattr(self, 'return_mysql', None):
                raise CanaryError('canary_read_query_rejected')
            if not same_owner(self.inspect(identity), self.sha, self.owner, identity, self.names['mysql']):
                raise CanaryError('canary_return_query_ownership_rejected')
        return self.command(['docker', 'exec', '-i', identity, 'bash', '-ec',
                             'IFS= read -r MYSQL_PWD; export MYSQL_PWD; exec "$@"', '--',
                             'mysql', '--protocol=TCP', '-h127.0.0.1', '-P3306', '-u' + self.user,
                             '--database=' + self.database, '--default-character-set=utf8mb4', '--batch', '--skip-column-names',
                             '--connect-timeout=2', '-e', query], input=(self.password + '\n').encode(), timeout=8)

    def published(self, identity, port):
        values = self.inspect(identity)['NetworkSettings']['Ports'].get(port)
        if not isinstance(values, list) or len(values) != 1 or values[0].get('HostIp') != '127.0.0.1':
            raise CanaryError('canary_binding_not_private')
        value = values[0].get('HostPort', '')
        if not value.isdecimal() or not 1 <= int(value) <= 65535:
            raise CanaryError('canary_binding_invalid')
        return int(value)

    def source_check(self, identity, code):
        script = ('import {verifyCodexdaichongSource} from "/candidate/modules/recharge/codexdaichong/prepare.mjs";'
                  'console.log(JSON.stringify(await verifyCodexdaichongSource("/candidate/.runtime/codexdaichong")));')
        result = json.loads(self.command(['docker', 'exec', identity, 'node', '--input-type=module', '-e', script], timeout=30))
        if (result.get('revision') != REVISION or result.get('files') != 203 or
            result.get('originalFiles') != 199 or result.get('routingFiles') !=
            ['pricing-checkout.js', 'region-config.js', 'server.js'] or result.get('returnFiles') != ['mysql-store.js', 'server.js']):
            raise CanaryError('pristine_source_mismatch')
        self.checks.append(code)

    def check_code_returns(self, mysql, native, adapter_url, privileged, sealed):
        migration = json.loads(self.command(['docker', 'exec', '-i', native, 'node',
            '/candidate/deploy/recharge-core/entry.mjs', 'migrate-canary-code-returns'], input=sealed.encode(), timeout=30))
        if migration != {'migration': 'unused-code-returns-v1', 'tables': 1, 'completed': True}:
            raise CanaryError('code_returns_migration_failed')
        codes = ['KC-' + hashlib.sha256((self.sha + ':return:' + str(i)).encode()).hexdigest()[:28].upper() for i in range(13)]
        values = ','.join("('%s',1,'自助','plus')" % code for code in codes)
        # Exact synthetic statements are registered only for this owned fixture container.
        # General SQL, other containers and the production database remain inaccessible.
        self.return_mysql = mysql
        self.return_queries = {
            'INSERT INTO cdk_codes(cdk_code,is_active,type,plan_type) VALUES ' + values,
            "SELECT is_active FROM cdk_codes WHERE cdk_code='%s'" % codes[0],
            "DELETE FROM cdk_codes WHERE cdk_code='%s'" % codes[0],
            "INSERT INTO task_logs(job_key,token_preview,cdk_code,status,message,display_time) VALUES('return-canary-task','synthetic','%s','failed','synthetic','synthetic')" % codes[9],
            "INSERT INTO activation_manual_holds(account_key,cdk_code,reason) VALUES('return-canary','%s','synthetic')" % codes[10],
            "UPDATE cdk_codes SET shipped_at=CURRENT_TIMESTAMP WHERE cdk_code='%s'" % codes[11],
            'SELECT COUNT(*) FROM id_recharge_code_returns',
            *("UPDATE cdk_codes SET used_at=CURRENT_TIMESTAMP WHERE cdk_code='%s' AND is_active=1 AND used_at IS NULL; SELECT ROW_COUNT()" % codes[index] for index in range(1, 9))
        }
        self.mysql_query(mysql, 'INSERT INTO cdk_codes(cdk_code,is_active,type,plan_type) VALUES ' + values)
        service = {**privileged, 'id': 'order-reconciliation'}
        def request(action, body, actor=service):
            path = '/api/admin/cdks/returns/' + action
            headers = {'x-id-recharge-assertion': assertion(self.bridge, path, actor, 'POST'), 'Content-Type': 'application/json'}
            return http_json(adapter_url, path, headers, 'POST', body)
        def command(index):
            return {'code': codes[index], 'plan': 'plus', 'operationId': 'return_' + hashlib.sha256((self.sha + ':' + str(index)).encode()).hexdigest()[:32]}
        status, _ = request('check', {'items': [{'code': codes[0], 'plan': 'plus'}]}, privileged)
        if status != 403:
            raise CanaryError('code_returns_service_boundary_failed')
        status, first = request('commit', command(0))
        if status != 200 or first.get('receipt', {}).get('state') != 'returned':
            raise CanaryError('code_return_atomic_commit_failed')
        for action in ('commit', 'receipt'):
            status, result = request(action, command(0))
            if status != 200 or result.get('receipt') != first.get('receipt'):
                raise CanaryError('code_return_idempotency_failed')
        if self.mysql_query(mysql, "SELECT is_active FROM cdk_codes WHERE cdk_code='%s'" % codes[0]) != '0':
            raise CanaryError('returned_code_still_active')
        try:
            self.mysql_query(mysql, "DELETE FROM cdk_codes WHERE cdk_code='%s'" % codes[0])
        except CanaryError:
            pass
        else:
            raise CanaryError('return_tombstone_can_be_deleted')
        self.checks.append('code_return_atomic_receipt_and_permanent_invalidation')
        for index in range(1, 9):
            barrier = threading.Barrier(2)
            def redeem():
                barrier.wait(timeout=5)
                return self.mysql_query(mysql, "UPDATE cdk_codes SET used_at=CURRENT_TIMESTAMP WHERE cdk_code='%s' AND is_active=1 AND used_at IS NULL; SELECT ROW_COUNT()" % codes[index])
            def give_back():
                barrier.wait(timeout=5)
                return request('commit', command(index))
            with ThreadPoolExecutor(max_workers=2) as executor:
                use = executor.submit(redeem)
                returned = executor.submit(give_back)
                used, (status, result) = use.result(), returned.result()
            receipt = result.get('receipt', {})
            if status != 200 or receipt.get('state') not in ('returned', 'blocked') or used not in ('0', '1'):
                raise CanaryError('code_return_race_unknown_result')
            if int(used) + int(receipt.get('state') == 'returned') != 1:
                raise CanaryError('code_return_and_redeem_both_succeeded_or_failed')
        self.checks.append('code_return_vs_native_claim_compare_and_set_eight_races')
        self.mysql_query(mysql, "INSERT INTO task_logs(job_key,token_preview,cdk_code,status,message,display_time) VALUES('return-canary-task','synthetic','%s','failed','synthetic','synthetic')" % codes[9])
        self.mysql_query(mysql, "INSERT INTO activation_manual_holds(account_key,cdk_code,reason) VALUES('return-canary','%s','synthetic')" % codes[10])
        self.mysql_query(mysql, "UPDATE cdk_codes SET shipped_at=CURRENT_TIMESTAMP WHERE cdk_code='%s'" % codes[11])
        for index in (9, 10, 11):
            status, result = request('commit', command(index))
            if status != 200 or result.get('receipt', {}).get('state') != 'blocked':
                raise CanaryError('code_return_history_hold_or_delivery_not_blocked')
        status, result = request('commit', {**command(12), 'operationId': command(0)['operationId']})
        if status != 200 or result.get('receipt', {}).get('state') != 'conflict':
            raise CanaryError('code_return_operation_collision_not_blocked')
        count = self.mysql_query(mysql, 'SELECT COUNT(*) FROM id_recharge_code_returns')
        self.command(['docker', 'exec', '-i', native, 'node', '/candidate/deploy/recharge-core/entry.mjs',
                      'migrate-canary-code-returns'], input=sealed.encode(), timeout=30)
        if self.mysql_query(mysql, 'SELECT COUNT(*) FROM id_recharge_code_returns') != count:
            raise CanaryError('code_return_migration_not_idempotent')
        self.checks.append('code_return_history_delivery_hold_collision_and_additive_migration')

        eligible, shipped = 'KC-23456789ABCDEFG', 'KC-23456789ABCDEFH'
        stock_fixture = ('INSERT INTO cdk_codes(cdk_code,is_active,type,plan_type,shipped_at) VALUES '
                         "('%s',1,'自助','plus',NULL),('%s',1,'自助','plus',CURRENT_TIMESTAMP)") % (eligible, shipped)
        self.return_queries.add(stock_fixture)
        self.mysql_query(mysql, stock_fixture)
        denied, _ = http_json(adapter_url, STOCK_PATH, {
            'x-id-recharge-assertion': assertion(self.bridge, STOCK_PATH, privileged)})
        status, value = http_json(adapter_url, STOCK_PATH, {
            'x-id-recharge-assertion': assertion(self.bridge, STOCK_PATH, service)})
        if denied != 403 or status != 200 or value != {'success': True, 'items': [{'code': eligible, 'plan': 'plus'}]}:
            raise CanaryError('stock_service_boundary_or_eligibility_failed')
        self.checks.append('stock_private_read_and_original_short_code_eligibility')

    def run(self):
        if not (ROOT / 'releases' / self.sha / 'source/deploy/recharge-core/run-recharge.py').is_file():
            raise CanaryError('formal_source_not_available')
        self.operations.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.operations.is_symlink() or self.receipt.exists():
            raise CanaryError('canary_evidence_already_exists_or_invalid')
        existing = set(self.command(['docker', 'container', 'ls', '--all', '--format', '{{.Names}}']).splitlines())
        if any(name in existing for name in self.names.values()):
            raise CanaryError('canary_name_already_exists')
        label = self.command(['docker', 'image', 'inspect', '--format',
                              '{{index .Config.Labels "org.opencontainers.image.revision"}}', self.image])
        if label != self.sha:
            raise CanaryError('image_revision_mismatch')
        mysql_image = self.command(['docker', 'inspect', '--format', '{{.Image}}', FORMAL_MYSQL])
        if not re.fullmatch('sha256:[a-f0-9]{64}', mysql_image):
            raise CanaryError('formal_mysql_binary_unavailable')
        entrypoint = json.loads(self.command(['docker', 'image', 'inspect', '--format', '{{json .Config.Entrypoint}}', mysql_image]))
        if not isinstance(entrypoint, list) or len(entrypoint) != 1 or Path(entrypoint[0]).name != 'docker-entrypoint.sh':
            raise CanaryError('unsupported_mysql_binary_entrypoint')
        mysql = self.start('mysql', mysql_arguments(mysql_image, self.names['mysql'], self.database, self.user,
                                                   self.labels(), entrypoint), self.root_password + '\n' + self.password + '\n')
        self.wait(lambda: self.mysql_query(mysql, 'SELECT 1') == '1', 'isolated_mysql_tcp_ready', timeout=150)
        mysql_port = self.published(mysql, '3306/tcp')
        address = self.inspect(mysql)['NetworkSettings']['Networks']['bridge']['IPAddress']
        if not any(ipaddress.ip_address(address) in network for network in PRIVATE_NETWORKS):
            raise CanaryError('canary_mysql_address_not_private')
        native = self.start('native', role_arguments(self.image, 'native', self.names['native'], self.database,
                            self.user, address, 3306, self.labels()), self.password + '\n' + self.bridge + '\n' +
                            compact({'BROWSER_POOL': '0', 'HEADFUL': '0', 'RECORD_VIDEO': '0'}) + '\n')
        native_port = self.wait(lambda: self.published(native, '3000/tcp'), 'native_private_binding', timeout=30)
        native_url = 'http://127.0.0.1:' + str(native_port)
        def runtime_ready(origin, headers=None):
            status, value = http_json(origin, '/api/public/runtime', headers)
            runtime = value.get('runtime', {})
            return status == 200 and value.get('success') is True and runtime.get('active_foreground_jobs') == 0 and runtime.get('max_foreground_jobs', 0) >= 1
        self.wait(lambda: runtime_ready(native_url), 'native_runtime_ready')
        sealed = self.password + '\n' + self.bridge + '\n{}\n'
        migration = json.loads(self.command(['docker', 'exec', '-i', native, 'node',
            '/candidate/deploy/recharge-core/entry.mjs', 'migrate-canary-routing'],
            input=sealed.encode(), timeout=30))
        if migration != {'migration': 'per-plan-routing-v1', 'tables': 2, 'completed': True}:
            raise CanaryError('routing_migration_failed')
        self.checks.append('routing_additive_migration')

        version = int(self.mysql_query(mysql, "SELECT config_value FROM app_config WHERE config_key = 'admin_password_version'"))
        if version < 1:
            raise CanaryError('native_password_version_invalid')
        bearer = native_token(self.bridge, version)
        self.redactions.append(bearer)
        status, session = http_json(native_url, '/api/admin/session', {'Authorization': 'Bearer ' + bearer})
        if status != 200 or session.get('success') is not True or 'admin' not in session.get('permissions', []):
            raise CanaryError('native_bearer_admin_session_failed')
        self.checks.append('native_bearer_admin_session')
        self.source_check(native, 'source_203_native')
        with socket.socket() as reserved:
            reserved.bind(('127.0.0.1', 0))
            adapter_port = reserved.getsockname()[1]
        launcher = runpy.run_path(str(ROOT / 'releases' / self.sha / 'source/deploy/recharge-core/run-recharge.py'))
        proof = launcher['network_proof'](self.inspect(native), self.bridge, native_url, container=self.names['native'])
        self.redactions.append(proof)
        adapter = self.start('adapter', role_arguments(self.image, 'adapter', self.names['adapter'], self.database,
                             self.user, '127.0.0.1', mysql_port, self.labels(), native_url, self.names['native'], adapter_port),
                             self.password + '\n' + self.bridge + '\n{}\n' + proof + '\n')
        adapter_url = 'http://127.0.0.1:' + str(adapter_port)
        customer = {'id': 'canary-customer', 'email': 'customer@example.test', 'admin': False, 'sensitive': False}
        privileged = {**customer, 'id': 'canary-super', 'admin': True, 'sensitive': True}
        def headers(path, actor):
            return {'x-id-recharge-assertion': assertion(self.bridge, path, actor)}
        self.wait(lambda: runtime_ready(adapter_url, headers('/api/public/runtime', customer)), 'adapter_runtime_ready')
        status, _ = http_json(adapter_url, '/api/admin/cards', headers('/api/admin/cards', customer))
        if status != 403:
            raise CanaryError('customer_cards_not_denied')
        self.checks.append('customer_cards_denied')
        status, cards = http_json(adapter_url, '/api/admin/cards', headers('/api/admin/cards', privileged))
        if status != 200 or cards.get('success') is not True or cards.get('cards') != []:
            raise CanaryError('super_empty_cards_failed')
        self.checks.append('super_empty_cards')
        route_path = '/api/admin/recharge-routing'
        def route(actor, method='GET', body=None):
            return http_json(adapter_url, route_path,
                {'x-id-recharge-assertion': assertion(self.bridge, route_path, actor, method),
                 'Content-Type': 'application/json'}, method, body)
        status, _ = route(customer)
        if status != 403:
            raise CanaryError('customer_routing_not_denied')
        status, _ = route({**privileged, 'sensitive': False}, 'PUT', {})
        if status != 403:
            raise CanaryError('staff_routing_write_not_denied')
        self.checks.append('routing_permissions')
        expected = {'plus': 'PH', 'pro100': 'EG', 'pro200': 'PH', 'pro500': 'EG'}
        status, config = route(privileged)
        if (status != 200 or config.get('plans') != expected or config.get('version') != 1 or
            config.get('auditCount') != 1 or config.get('billingAddressCountry') != 'US'):
            raise CanaryError('routing_defaults_invalid')
        status, _ = route(privileged, 'PUT', {'version': 1, 'plans': {**expected, 'plus': 'MY'}})
        if status != 200:
            raise CanaryError('routing_save_failed')
        status, _ = route(privileged, 'PUT', {'version': 1, 'plans': expected})
        if status != 409:
            raise CanaryError('routing_stale_version_accepted')
        status, config = route(privileged, 'PUT', {'version': 2, 'plans': expected})
        if status != 200 or config.get('auditCount') != 3:
            raise CanaryError('routing_audit_missing')
        self.command(['docker', 'exec', '-i', native, 'node',
            '/candidate/deploy/recharge-core/entry.mjs', 'migrate-canary-routing'], input=sealed.encode(), timeout=30)
        status, config = route(privileged)
        if status != 200 or config.get('version') != 3 or config.get('auditCount') != 3:
            raise CanaryError('routing_migration_not_idempotent')
        self.checks.append('routing_persistence_version_audit_and_migration_idempotency')
        self.check_code_returns(mysql, native, adapter_url, privileged, sealed)
        self.source_check(adapter, 'source_203_adapter')
        self.checks.append('no_payment_or_activation_requests')

    def cleanup(self):
        clean = True
        for identity in reversed(self.created):
            try:
                try:
                    data = self.inspect(identity)
                except CanaryError:
                    continue
                if not same_owner(data, self.sha, self.owner, identity, self.created_names[identity]):
                    clean = False
                    continue
                waiter = subprocess.Popen(['docker', 'wait', identity], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                stopped = subprocess.run(['docker', 'stop', '--time', '25', identity], stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL, timeout=35, check=False)
                try:
                    waiter.communicate(timeout=35)
                except subprocess.TimeoutExpired:
                    waiter.terminate()
                    waiter.communicate(timeout=5)
                    clean = False
                if stopped.returncode:
                    remaining = subprocess.run(['docker', 'container', 'ls', '--all', '--no-trunc', '--format', '{{.ID}}'],
                                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10, check=False)
                    if remaining.returncode or identity in remaining.stdout.decode().splitlines():
                        clean = False
            except Exception:
                clean = False
        if self.created:
            try:
                remaining = set(self.command(['docker', 'container', 'ls', '--all', '--no-trunc', '--format', '{{.ID}}']).splitlines())
                if any(identity in remaining for identity in self.created):
                    clean = False
            except Exception:
                clean = False
        for process in self.processes:
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.terminate()
                clean = False
        for reader in self.readers:
            reader.join(timeout=5)
            if reader.is_alive():
                clean = False
        return clean and not self.log_errors


def main():
    if len(sys.argv) != 2:
        raise CanaryError('expected_release_revision')
    canary = Canary(sys.argv[1])
    def interrupted(_signum, _frame):
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise CanaryError('canary_interrupted')
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    failure = None
    try:
        canary.run()
    except Exception as error:
        failure = str(error) if isinstance(error, CanaryError) else 'canary_validation_failed'
    finally:
        clean = canary.cleanup()
    if not clean:
        failure = 'canary_cleanup_not_confirmed'
    if failure:
        print(compact({'ok': False, 'mainSha': canary.sha, 'reason': failure, 'productionWrites': False}))
        return 1
    canary.checks.append('owned_temporary_containers_removed')
    receipt = {'mainSha': canary.sha, 'checks': canary.checks, 'productionWrites': False}
    descriptor = os.open(canary.receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        output.write(compact(receipt) + '\n')
        output.flush()
        os.fsync(output.fileno())
    print(compact({'ok': True, 'mainSha': canary.sha, 'checks': len(canary.checks), 'productionWrites': False}))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('{"ok":false,"reason":"canary_startup_failed","productionWrites":false}')
        sys.exit(1)
