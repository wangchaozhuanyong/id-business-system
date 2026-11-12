"""Connect the existing mail event route through the existing private gateway."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
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
            caddy('reload', after)
        req = urllib.request.Request('http://127.0.0.1:44570/storefront-realtime/mail-events',
            data=b'{}', headers={'Content-Type': 'application/json', 'Accept': 'text/event-stream'}, method='POST')
        try:
            urllib.request.urlopen(req, timeout=20).close()
            raise RuntimeError('mail_event_preflight_unexpected')
        except urllib.error.HTTPError as error:
            if error.code != 400 or error.read(500) != b'{"error":"invalid_request"}':
                raise RuntimeError('mail_event_preflight_unavailable')
        receipt.update(applied=True, upstreamInvalidRequest=400)
        return receipt


if __name__ == '__main__':
    try:
        print(json.dumps(prepare(apply=sys.argv[1:] == ['--apply']), sort_keys=True))
    except Exception:
        print('private_mail_gateway_preparation_unavailable')
        raise SystemExit(1)
