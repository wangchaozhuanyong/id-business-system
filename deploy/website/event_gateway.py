"""Connect the existing mail event route through the existing private gateway."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path('/opt/id-business-independent/formal')
GATEWAY = ROOT / 'gateway/Caddyfile'
ORIGINAL = '''http://127.0.0.1:44570 {
  bind 127.0.0.1
  @mailAdmin {
    method POST
    path /admin-api
  }
  handle @mailAdmin {
    reverse_proxy https://console.moyaoai.com {
      header_up Host console.moyaoai.com
    }
  }
  @mailShop {
    method POST
    path /shop-api
  }
  handle @mailShop {
    reverse_proxy https://moyaoai.com {
      header_up Host moyaoai.com
    }
  }
  handle {
    respond 404
  }
}'''
UPDATED = ORIGINAL.replace('path /shop-api', 'path /shop-api /storefront-realtime/mail-events')


def transform(content):
    if content.count(UPDATED) == 1 and content.count('http://127.0.0.1:44570 {') == 1:
        return content
    if content.count(ORIGINAL) != 1 or content.count('http://127.0.0.1:44570 {') != 1:
        raise RuntimeError('private_gateway_baseline_changed')
    return content.replace(ORIGINAL, UPDATED)


def caddy(operation, content):
    result = subprocess.run(['docker', 'exec', '-i', 'id-business-independent-caddy', 'caddy', operation,
                             '--config', '-', '--adapter', 'caddyfile'], input=content.encode(),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    if result.returncode:
        raise RuntimeError('private_gateway_' + operation + '_failed')


def activate(content):
    if not re.search(r'(?m)^\s*admin\s+off\s*$', content):
        caddy('reload', content)
        return 'admin-reload'
    # Caddy < 2.11 cannot reload with its admin API disabled. Preserve that
    # isolation and the pinned image; restart only this peripheral gateway.
    container = 'id-business-independent-caddy'
    command = json.loads(subprocess.check_output(
        ['docker', 'inspect', '--format', '{{json .Config.Cmd}}', container], text=True))
    if command != ['caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']:
        raise RuntimeError('private_gateway_start_command_changed')
    version = subprocess.check_output(['docker', 'exec', container, 'caddy', 'version'], text=True)
    match = re.match(r'^v2\.(\d+)\.\d+(?:\s|$)', version)
    if not match:
        raise RuntimeError('private_gateway_version_unsupported')
    signal_reload = int(match[1]) >= 11
    command = (['docker', 'kill', '--signal=USR1', container] if signal_reload else
               ['docker', 'restart', '--time', '30', container])
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=45)
    if result.returncode:
        raise RuntimeError('private_gateway_activation_failed')
    return 'signal-reload' if signal_reload else 'gateway-restart'


def probe():
    req = urllib.request.Request('http://127.0.0.1:44570/storefront-realtime/mail-events',
        data=b'{}', headers={'Content-Type': 'application/json', 'Accept': 'text/event-stream',
                            'User-Agent': 'node'}, method='POST')
    try:
        urllib.request.urlopen(req, timeout=10).close()
    except urllib.error.HTTPError as error:
        return error.code == 400 and error.read(500) == b'{"error":"invalid_request"}'
    except (urllib.error.URLError, TimeoutError):
        pass
    return False


def prepare(apply=False):
    with (ROOT / '.application-release.lock').open('r') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        before = GATEWAY.read_text()
        after = transform(before)
        caddy('validate', after)
        receipt = {'validated': True, 'changed': before != after, 'applied': False,
                   'beforeSha256': hashlib.sha256(before.encode()).hexdigest(),
                   'afterSha256': hashlib.sha256(after.encode()).hexdigest(),
                   'route': '/storefront-realtime/mail-events', 'businessWrites': 0}
        if not apply:
            return receipt
        if GATEWAY.read_text() != before:
            raise RuntimeError('private_gateway_changed_during_validation')
        if before != after:
            # Keep the inode used by the existing file bind mount. The exact
            # candidate was validated before touching the live file.
            with GATEWAY.open('r+') as target:
                target.write(after); target.truncate(); target.flush(); os.fsync(target.fileno())
        # A previous attempt may have written the file but failed to activate it.
        # Verify the running route independently of file equality, then retry
        # activation only when needed.
        activation = 'already-active'
        if not probe():
            activation = activate(after)
            for attempt in range(6):
                if probe():
                    break
                if attempt == 5:
                    raise RuntimeError('mail_event_preflight_unavailable')
                time.sleep(1)
        receipt.update(applied=True, activation=activation, upstreamInvalidRequest=400)
        return receipt


if __name__ == '__main__':
    try:
        print(json.dumps(prepare(apply=sys.argv[1:] == ['--apply']), sort_keys=True))
    except Exception:
        print('private_mail_gateway_preparation_unavailable')
        raise SystemExit(1)
