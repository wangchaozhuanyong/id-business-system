#!/usr/bin/env python3
"""Host supervisor for one role. Adapter restarts never stop the native engine."""
import base64
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

ROOT = Path('/opt/id-business-independent')
NATIVE = 'id-business-independent-recharge-native'
ADAPTER = 'id-business-independent-recharge'
DATABASE = 'id-business-independent-formal-mysql'
NATIVE_PORT = '44579'
ADAPTER_PORT = '44575'
PROOF_DOMAIN = b'id-business/codexdaichong/native-network-proof/v1\0'
UPSTREAM_REVISION = '4e9bb201cf481d4bcc85da34970fc26c63ab818a'


def inspect(name):
    return json.loads(subprocess.check_output(['docker', 'inspect', name], text=True))[0]


def network_proof(data, bridge, native_url, container=NATIVE, now=None):
    now = int(time.time() * 1000) if now is None else now
    payload = {'v': 1, 'nativeUrl': native_url, 'container': container,
               'containerId': data['Id'], 'networkMode': data['HostConfig']['NetworkMode'],
               'ports': data['NetworkSettings']['Ports'], 'running': data['State']['Running'],
               'issuedAt': now, 'expiresAt': now + 30000}
    encoded = base64.urlsafe_b64encode(json.dumps(payload, sort_keys=True, separators=(',', ':'),
                                                ensure_ascii=False).encode()).rstrip(b'=')
    signature = hmac.new(bridge.encode(), PROOF_DOMAIN + encoded, hashlib.sha256).digest()
    return (encoded + b'.' + base64.urlsafe_b64encode(signature).rstrip(b'=')).decode()


def adapter_source_mounts(source):
    if not source.is_dir() or source.resolve() != source:
        raise ValueError('Invalid staged adapter source')
    args = []
    for name in ('modules', 'deploy/recharge-core'):
        directory = source / name
        if not directory.is_dir() or directory.resolve() != directory:
            raise ValueError('Missing staged adapter code')
        args += ['--mount', 'type=bind,src=' + str(directory) + ',dst=/candidate/' + name + ',readonly']
    return args


def docker_arguments(role, sha, database_ip, image, native_url=None, source=None):
    if role not in ['native', 'adapter'] or not re.fullmatch('[a-f0-9]{40}', sha):
        raise ValueError('Invalid release role')
    name = NATIVE if role == 'native' else ADAPTER
    args = ['docker', 'run', '--pull=never', '--rm', '-i', '--name', name,
            '--label', 'com.id-business.independent=true',
            '--label', 'org.opencontainers.image.revision=' + sha,
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']
    if role == 'native':
        if source is not None:
            raise ValueError('The original engine uses its own image')
        args += ['--network', 'bridge', '--publish', '127.0.0.1:' + NATIVE_PORT + ':3000',
                 '--shm-size', '2g']
        for directory in ['debug_screenshots', 'product_files', 'data']:
            args += ['--mount', 'type=bind,src=' + str(ROOT / 'formal/recharge-data' / directory) +
                     ',dst=/candidate/.runtime/codexdaichong/' + directory]
        args += ['--mount', 'type=bind,src=' + str(ROOT / 'formal/recharge-data/data') + ',dst=/app/data']
        host, port, service_port = database_ip, '3306', '3000'
    else:
        args += ['--network', 'host', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m',
                 '-e', 'ID_RECHARGE_NATIVE_URL=' + native_url,
                 '-e', 'ID_RECHARGE_NATIVE_CONTAINER=' + NATIVE]
        if source is not None:
            args += adapter_source_mounts(source)
        host, port, service_port = '127.0.0.1', '44576', ADAPTER_PORT
    for key, value in {'DB_HOST': host, 'DB_PORT': port, 'PORT': service_port,
                       'DB_NAME': 'id_redesign_codexdaichong_prod', 'DB_USER': 'id_redesign_recharge'}.items():
        args += ['-e', key + '=' + value]
    return args + [image, role]


def main():
    if len(sys.argv) not in (3, 5):
        raise ValueError('Expected role and release revision')
    role, sha = sys.argv[1:3]
    if role not in ['native', 'adapter'] or not re.fullmatch('[a-f0-9]{40}', sha):
        raise ValueError('Invalid release role')
    source = None
    native_revision = sha
    image = 'id-business-independent-recharge:' + sha
    if len(sys.argv) == 5:
        native_revision, image = sys.argv[3:]
        if role != 'adapter' or not re.fullmatch('[a-f0-9]{40}', native_revision) or not re.fullmatch('sha256:[a-f0-9]{64}', image):
            raise ValueError('Invalid compatible adapter launch')
        source = ROOT / 'releases' / sha / 'source'
        if Path(__file__).resolve() != source / 'deploy/recharge-core/run-recharge.py':
            raise ValueError('Adapter launcher source mismatch')
    # The lock belongs to the host launcher, never to the payment process.
    # An unavailable Docker daemon is an error, not permission to start twice.
    launch_lock = None
    if role == 'native':
        lock_path = ROOT / 'formal/.native-recharge-launch.lock'
        descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        launch_lock = os.fdopen(descriptor, 'a')
        fcntl.flock(launch_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        existing = subprocess.check_output(['docker', 'ps', '-a', '--filter', 'name=^/' + NATIVE + '$', '--format', '{{.ID}}'], text=True).strip()
        if existing:
            raise ValueError('An original engine already exists; leave it running')
    built = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image], text=True))[0]
    labels = built['Config']['Labels']
    if labels.get('org.opencontainers.image.revision') != native_revision:
        raise ValueError('Image revision mismatch')
    if source is not None and (built['Id'] != image or labels.get('org.id-business.upstream.revision') != UPSTREAM_REVISION):
        raise ValueError('Pinned runtime image mismatch')
    credentials = Path(os.environ['CREDENTIALS_DIRECTORY'])
    password = (credentials / 'independent-mysql-app').read_text().strip()
    bridge = (credentials / 'independent-recharge-bridge').read_text().strip()
    if not all(re.fullmatch('[a-f0-9]{64}', value) for value in [password, bridge]):
        raise ValueError('Invalid sealed configuration')
    options = json.loads((credentials / 'independent-recharge-options').read_text())
    allowed = json.loads((Path(__file__).parent / 'runtime-settings.json').read_text())
    if not isinstance(options, dict) or any(key not in allowed or not isinstance(value, str) or
                                           len(value) > 32768 for key, value in options.items()):
        raise ValueError('Invalid sealed runtime options')
    if role == 'native':
        for directory in ['debug_screenshots', 'product_files', 'data']:
            path = ROOT / 'formal/recharge-data' / directory
            if path.is_symlink() or not path.is_dir() or path.stat().st_mode & 0o077:
                raise ValueError('Private runtime output directory unavailable')
    mysql = inspect(DATABASE)
    if not mysql['State']['Running']:
        raise ValueError('Database is not running')
    database_ip = mysql['NetworkSettings']['Networks']['bridge']['IPAddress']
    if not re.fullmatch(r'172\.17\.(?:\d{1,3})\.(?:\d{1,3})', database_ip):
        raise ValueError('Unexpected dedicated database network')
    native_url = 'http://127.0.0.1:' + NATIVE_PORT
    proof = None
    if role == 'adapter':
        native = inspect(NATIVE)
        if native['Config']['Labels'].get('org.opencontainers.image.revision') != native_revision or \
                (source is not None and native['Image'] != built['Id']):
            raise ValueError('Native revision mismatch')
        proof = network_proof(native, bridge, native_url)
    args = docker_arguments(role, sha, database_ip, built['Id'], native_url, source)
    sealed = (password + '\n' + bridge + '\n' + json.dumps(options, separators=(',', ':')) + '\n' + (proof + '\n' if proof else '')).encode()
    if role == 'native':
        preflight = ['docker', 'run', '--pull=never', '--rm', '-i', '--network', 'bridge',
                     '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']
        for key, value in {'DB_HOST': database_ip, 'DB_PORT': '3306', 'PORT': '3000',
                           'DB_NAME': 'id_redesign_codexdaichong_prod', 'DB_USER': 'id_redesign_recharge'}.items():
            preflight += ['-e', key + '=' + value]
        subprocess.run(preflight + [built['Id'], 'preflight-native'], input=sealed,
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    child = subprocess.Popen(args, stdin=subprocess.PIPE)
    def stop(signum, _frame):
        # Only this role's process receives the signal. Never cancel a native
        # task when an unrelated collector or adapter process exits.
        if child.poll() is None:
            child.send_signal(signum)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        child.stdin.write(sealed)
        child.stdin.close()
        return child.wait()
    finally:
        if role == 'adapter' and child.poll() is None:
            child.terminate()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        # Never emit subprocess output or sealed material in an exception.
        print('Recharge role startup failed; inspect the private release evidence.', file=sys.stderr)
        sys.exit(1)
