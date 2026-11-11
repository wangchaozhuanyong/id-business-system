#!/usr/bin/env python3
"""Private encrypted logical snapshot; SQL and credentials never become local files."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path('/opt/id-business-independent')
MYSQL_CONTAINER = 'id-business-independent-formal-mysql'
MYSQL_DATABASE = 'id_redesign_codexdaichong_prod'
BACKUP_FILENAME = 'mysql.sql.aes256gcm'


def credential(name):
    value = subprocess.check_output(['systemd-creds', 'decrypt', '--name=' + name,
                                    str(ROOT / 'formal/private' / (name + '.cred')), '-'],
                                   stderr=subprocess.DEVNULL).decode().strip()
    if not re.fullmatch('[a-f0-9]{64}', value):
        raise ValueError('Invalid sealed input')
    return value


def file_digest(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(65536), b''):
            digest.update(chunk)
    return digest.hexdigest()


def take_snapshot(sha, destination, *, backup_key=None):
    if not re.fullmatch('[a-f0-9]{40}', sha):
        raise ValueError('Expected release revision')
    scheduled = backup_key is not None
    if scheduled and not re.fullmatch('[a-f0-9]{64}', backup_key):
        raise ValueError('Invalid scheduled backup key')
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    image = (ROOT / 'formal/node-image-id').read_text().strip()
    script = (ROOT / 'releases' / sha / 'source/deploy/recharge-core/seal-backup.mjs').read_text()
    command = ['docker', 'run', '--pull=never', '--rm', '-i', '--network', 'none', '--read-only',
               '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--entrypoint', 'node', image,
               '--input-type=module', '-e', script, 'seal-backup.mjs']
    password = credential('independent-mysql-app')
    if not scheduled:
        backup_key = credential('independent-recharge-bridge')
    children = []
    try:
        dump = subprocess.Popen(['docker', 'exec', '-i', MYSQL_CONTAINER,
                                 'bash', '-ec', 'IFS= read -r MYSQL_PWD; export MYSQL_PWD; exec mysqldump '
                                 '--host=127.0.0.1 --user=id_redesign_recharge --single-transaction '
                                 '--skip-lock-tables --no-tablespaces --set-gtid-purged=OFF '
                                 '--databases ' + MYSQL_DATABASE],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        children.append(dump)
        dump.stdin.write((password + '\n').encode())
        dump.stdin.close()
        backup = destination / BACKUP_FILENAME
        with backup.open('xb') as output:
            os.chmod(backup, 0o600)
            seal = subprocess.Popen(command + ['seal', sha], stdin=subprocess.PIPE, stdout=output, stderr=subprocess.PIPE)
            children.append(seal)
            seal.stdin.write((backup_key + '\n').encode())
            while True:
                chunk = dump.stdout.read(65536)
                if not chunk:
                    break
                seal.stdin.write(chunk)
            seal.stdin.close()
            seal_error = seal.stderr.read()
            seal_status = seal.wait()
        dump_error = dump.stderr.read()
        dump_status = dump.wait()
        if dump_status != 0 or seal_status != 0:
            raise ValueError('Snapshot did not finish')
        metadata = json.loads(seal_error)
        verify = subprocess.Popen(command + ['verify', sha], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        children.append(verify)
        verify.stdin.write((backup_key + '\n').encode())
        with backup.open('rb') as encrypted:
            while True:
                chunk = encrypted.read(65536)
                if not chunk:
                    break
                verify.stdin.write(chunk)
        verify.stdin.close()
        verified = verify.stdout.read()
        verify_error = verify.stderr.read()
        if verify.wait() != 0:
            raise ValueError('Snapshot verification failed')
        restored = json.loads(verified)
        if (restored['sha256'] != metadata['sha256'] or restored['bytes'] != metadata['bytes']
                or restored['bytes'] <= 0 or not restored['verified']):
            raise ValueError('Snapshot digest mismatch')
        scheme = ('AES-256-GCM; per-backup key domain-separated by source revision'
                  if scheduled else 'AES-256-GCM; existing bridge domain-separated by source revision')
        manifest = {'revision': sha, 'encrypted': True, 'verified': True, 'plainBytes': metadata['bytes'],
                    'plainSha256': metadata['sha256'], 'cipherSha256': file_digest(backup),
                    'scheme': scheme, 'database': MYSQL_DATABASE}
        (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        return manifest
    finally:
        for child in reversed(children):
            if child.poll() is None:
                for stream in [child.stdin, child.stdout]:
                    try:
                        if stream: stream.close()
                    except OSError:
                        pass
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
def main():
    if len(sys.argv) != 2 or not re.fullmatch('[a-f0-9]{40}', sys.argv[1]):
        raise ValueError('Expected release revision')
    sha = sys.argv[1]
    destination = ROOT / 'backups' / ('recharge-core-' + sha)
    manifest = take_snapshot(sha, destination)
    print(json.dumps({'backup': str(destination), 'verified': True, 'plainBytes': manifest['plainBytes']}))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Encrypted database snapshot failed; production switch is prohibited.', file=sys.stderr)
        sys.exit(1)
