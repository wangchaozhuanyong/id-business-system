#!/usr/bin/env python3
"""Briefly pause new recharge mutations at the existing HTTPS edge, without touching core."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path('/opt/id-business-independent')
HOST = '54-249-61-238.sslip.io'
CONTAINER = 'id-business-independent-caddy'
GATE_BODY = 'Recharge service is updating. Please retry shortly.'


def reload_strategy(version):
    match = re.match(r'^v(\d+)\.(\d+)\.(\d+)(?:\s|$)', version.strip())
    if not match or int(match[1]) != 2:
        raise ValueError('Unsupported gateway version')
    # Caddy added SIGUSR1 config reload in 2.11. The existing 2.10 gateway
    # has admin off, so it needs a bounded restart of the same container.
    return 'signal' if int(match[2]) >= 11 else 'restart'


def probe_matches(raw, enable):
    headers, separator, body = raw.partition('\r\n\r\n')
    status = re.match(r'^HTTP/\S+ (\d{3})(?:\s|$)', headers)
    if not separator or not status:
        return False
    if enable:
        return (status[1] == '503' and body == GATE_BODY and
                re.search(r'(?im)^retry-after:\s*60\s*$', headers) is not None)
    return status[1] in ['401', '403'] and body != GATE_BODY


def reload_gateway():
    def inspect():
        return json.loads(subprocess.check_output(['docker', 'inspect', CONTAINER]))[0]
    before = inspect()
    version = subprocess.check_output(['docker', 'exec', CONTAINER, 'caddy', 'version'], text=True)
    strategy = reload_strategy(version)
    command = (['docker', 'kill', '--signal=USR1', CONTAINER] if strategy == 'signal' else
               ['docker', 'restart', '--time', '20', CONTAINER])
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    after = inspect()
    before_mounts = sorted(before['Mounts'], key=lambda mount: mount['Destination'])
    after_mounts = sorted(after['Mounts'], key=lambda mount: mount['Destination'])
    if (before['Id'] != after['Id'] or before['Image'] != after['Image'] or
            before_mounts != after_mounts or not after['State']['Running']):
        raise ValueError('Gateway identity changed')
    return {'strategy': strategy, 'containerId': after['Id'], 'imageId': after['Image'],
            'beforeStartedAt': before['State']['StartedAt'], 'afterStartedAt': after['State']['StartedAt']}


def gated_text(text, sha, enable):
    begin = '# BEGIN ID CORE RELEASE ' + sha
    end = '# END ID CORE RELEASE ' + sha
    if enable:
        if '# BEGIN ID CORE RELEASE ' in text:
            raise ValueError('An ingress gate already exists')
        pattern = re.compile(r'(?m)^(?:https://)?' + re.escape(HOST) + r'\s*\{\s*$')
        matches = list(pattern.finditer(text))
        if len(matches) != 1:
            raise ValueError('Unexpected HTTPS site structure')
        block = ('\n    ' + begin + '\n    @coreRestoreMutations {\n'
                 '        path /integrations/codexdaichong/api/*\n'
                 '        method POST PUT PATCH DELETE\n    }\n'
                 '    handle @coreRestoreMutations {\n        header Retry-After 60\n'
                 '        respond "Recharge service is updating. Please retry shortly." 503\n'
                 '    }\n    ' + end + '\n')
        index = matches[0].end()
        return text[:index] + block + text[index:]
    pattern = re.compile(r'\n    ' + re.escape(begin) + r'\n.*?    ' + re.escape(end) + r'\n', re.S)
    result, count = pattern.subn('', text)
    if count != 1:
        raise ValueError('The release gate does not match this revision')
    return result


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ['enable', 'disable'] or not re.fullmatch('[a-f0-9]{40}', sys.argv[2]):
        raise ValueError('Expected gate action and revision')
    enable, sha = sys.argv[1] == 'enable', sys.argv[2]
    path = ROOT / 'formal/gateway/Caddyfile'
    if path.is_symlink():
        raise ValueError('Unexpected gateway source')
    before = path.read_text()
    after = gated_text(before, sha, enable)
    validation = subprocess.run(['docker', 'exec', '-i', 'id-business-independent-caddy',
                                 'caddy', 'adapt', '--config', '-', '--adapter', 'caddyfile'],
                                input=after.encode(), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if validation.returncode:
        raise ValueError('Gateway gate validation failed')
    # Preserve the inode of the existing read-only bind mount. All other text
    # remains byte-for-byte identical; this is not a production version rollback.
    with path.open('r+') as stream:
        if stream.read() != before:
            raise ValueError('Gateway source changed concurrently')
        stream.seek(0); stream.write(after); stream.truncate(); stream.flush(); os.fsync(stream.fileno())
    reload = reload_gateway()
    routes = ['verify-cdk', 'run-process', 'admin/cards']
    for _ in range(12):
        confirmed = True
        for route in routes:
            probe = subprocess.run(['curl', '--silent', '--show-error', '--max-time', '3',
                                    '--resolve', HOST + ':443:127.0.0.1', '-X', 'POST',
                                    'https://' + HOST + '/integrations/codexdaichong/api/' + route,
                                    '--dump-header', '-'], capture_output=True)
            confirmed = confirmed and probe.returncode == 0 and probe_matches(probe.stdout.decode(), enable)
        if confirmed:
            print(json.dumps({'revision': sha, 'gate': 'enabled' if enable else 'disabled',
                              'routesVerified': len(routes), 'reload': reload,
                              'sourceSha256': hashlib.sha256(after.encode()).hexdigest()}))
            return
        time.sleep(0.5)
    raise ValueError('Gateway did not confirm the requested gate')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Recharge ingress gate is unconfirmed; inspect the original receipt before continuing.', file=sys.stderr)
        sys.exit(1)
