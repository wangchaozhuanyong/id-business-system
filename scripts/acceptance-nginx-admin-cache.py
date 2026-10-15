"""Real, disposable Nginx regression for equal-size epoch-mtime SPA releases.

The Mac may run --static only. --docker is restricted to Linux GitHub Actions,
uses no production identity, exposes no host port and starts no API/database.
"""
import argparse
import gzip
import hashlib
import json
import os
import pathlib
import platform
import re
import subprocess
import tempfile
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
LEGACY_CONFIG_SHA256 = '5bc80e906215c63ee0bf79f123d672dbba604e03aad94f0eb444a03a9664b1da'
LABEL = 'id-business.test.nginx-cache'


def need(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def configuration():
    current = (ROOT / 'deploy/nginx/admin.conf').read_text()
    for directive in ('    etag off;\n', '    if_modified_since off;\n'):
        need(current.count(directive) == 1, 'CACHE_DIRECTIVE_NOT_UNIQUE')
    legacy = current.replace('    etag off;\n', '').replace('    if_modified_since off;\n', '')
    need(sha(legacy.encode()) == LEGACY_CONFIG_SHA256, 'CHANGE_OUTSIDE_APPROVED_CACHE_DIRECTIVES')
    need('  location / {\n    etag off;\n    if_modified_since off;\n' in current,
         'CACHE_DIRECTIVES_OUTSIDE_SPA_LOCATION')
    dockerfile = (ROOT / 'apps/admin/Dockerfile').read_text()
    images = re.findall(r'^FROM (nginx:[\w.-]+@sha256:[0-9a-f]{64})(?: AS \w+)?$', dockerfile, re.M)
    need(len(images) == 1, 'PINNED_NGINX_RUNTIME_MISSING')
    return current, legacy, images[0]


def native(args, *, timeout=45, checked=True):
    result = subprocess.run(args, capture_output=True, timeout=timeout)
    if checked:
        need(result.returncode == 0, 'DISPOSABLE_NGINX_COMMAND_FAILED')
    return result


def request(identifier, path, headers=None):
    args = ['docker', 'exec', identifier, 'wget', '-S', '-O', '-']
    for key, value in (headers or {'Accept-Encoding': 'identity'}).items():
        args += ['--header', key + ': ' + value]
    result = native(args + ['http://127.0.0.1' + path], timeout=10, checked=False)
    stderr = result.stderr.decode(errors='replace')
    matches = re.findall(r'HTTP/\S+\s+(\d{3})', stderr)
    need(matches, 'NGINX_RESPONSE_STATUS_MISSING')
    status = int(matches[-1])
    fields = {key.lower(): value.strip() for key, value in
              re.findall(r'^\s+([A-Za-z0-9-]+):\s*(.*?)\r?$', stderr, re.M)}
    body = result.stdout
    if fields.get('content-encoding') == 'gzip' and body:
        body = gzip.decompress(body)
    need(status == 304 or result.returncode == 0, 'NGINX_RESPONSE_FAILED')
    return status, fields, body


def write_index(directory, raw):
    path = directory / 'index.html'
    path.write_bytes(raw)
    path.chmod(0o644)
    os.utime(path, (0, 0))


def run_variant(name, config, image, old, new, validators=None):
    token = uuid.uuid4().hex
    container = 'id-business-nginx-cache-' + token
    identifier = None
    runtime = ROOT / '.runtime/nginx-admin-cache'
    runtime.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=name + '-', dir=runtime) as temporary:
        directory = pathlib.Path(temporary)
        static = directory / 'html'
        (static / 'assets').mkdir(parents=True)
        static.chmod(0o755)
        (static / 'assets').chmod(0o755)
        asset = static / 'assets/frozen.js'
        asset.write_bytes(b'console.log("immutable")')
        asset.chmod(0o644)
        os.utime(asset, (0, 0))
        write_index(static, old)
        config_file = directory / 'default.conf'
        config_file.write_text(config)
        config_file.chmod(0o644)
        try:
            raw = native(['docker', 'run', '--detach', '--name', container, '--label', LABEL + '=' + token,
                          '--network', 'none', '--add-host', 'api:127.0.0.1', '--read-only',
                          '--tmpfs', '/var/run', '--tmpfs', '/var/cache/nginx', '--tmpfs', '/tmp',
                          '--mount', 'type=bind,source=' + str(config_file) + ',target=/etc/nginx/conf.d/default.conf,readonly',
                          '--mount', 'type=bind,source=' + str(static) + ',target=/usr/share/nginx/html,readonly',
                          '--entrypoint', 'nginx', image, '-g', 'daemon off;']).stdout.decode().strip()
            need(re.fullmatch(r'[0-9a-f]{64}', raw), 'TEST_CONTAINER_ID_INVALID')
            identifier = raw
            native(['docker', 'exec', identifier, 'nginx', '-t'])
            version = native(['docker', 'exec', identifier, 'nginx', '-v']).stderr.decode().strip()
            for attempt in range(30):
                try:
                    initial = request(identifier, '/')
                    if initial[0] == 200:
                        break
                except RuntimeError:
                    pass
                time.sleep(0.1)
            else:
                raise RuntimeError('DISPOSABLE_NGINX_NOT_READY')
            need(initial[2] == old and initial[1].get('cache-control') == 'no-cache', 'INITIAL_RESPONSE_CHANGED')
            if validators is None:
                validators = {'etag': initial[1].get('etag'), 'lastModified': initial[1].get('last-modified')}
                need(validators['etag'] == '"0-752"' and validators['lastModified'] == 'Thu, 01 Jan 1970 00:00:00 GMT',
                     'LEGACY_VALIDATOR_COLLISION_NOT_REPRODUCED')
            else:
                need('etag' not in initial[1], 'FIXED_SPA_ETAG_STILL_ENABLED')
            write_index(static, new)
            need((static / 'index.html').stat().st_mtime == 0, 'FIXTURE_MTIME_CHANGED')
            conditional = [
                ('old-etag', {'If-None-Match': validators['etag']}),
                ('old-modified-since', {'If-Modified-Since': validators['lastModified']}),
                ('both-old-validators', {'If-None-Match': validators['etag'], 'If-Modified-Since': validators['lastModified']}),
                ('weak-old-etag', {'If-None-Match': 'W/' + validators['etag']}),
            ]
            cases = []
            for path in ('/', '/index.html', '/v2/auto-recharge'):
                for case, headers in conditional:
                    status, fields, body = request(identifier, path, {'Accept-Encoding': 'identity', **headers})
                    need(status == (304 if name == 'legacy' else 200), 'CONDITIONAL_CACHE_REGRESSION')
                    if name != 'legacy':
                        need(body == new and 'etag' not in fields, 'FIXED_RESPONSE_NOT_LATEST_BYTES')
                    cases.append({'path': path, 'condition': case, 'status': status,
                                  'latestBodyVerified': body == new})
            status, fields, body = request(identifier, '/', {'Accept-Encoding': 'gzip', 'If-None-Match': validators['etag']})
            need(status == (304 if name == 'legacy' else 200), 'GZIP_CONDITIONAL_CACHE_REGRESSION')
            if name != 'legacy':
                need(body == new, 'GZIP_RESPONSE_NOT_LATEST_BYTES')
            cases.append({'path': '/', 'condition': 'gzip-old-etag', 'status': status,
                          'latestBodyVerified': body == new})
            status, fields, body = request(identifier, '/')
            need(status == 200 and body == new, 'UNCONDITIONAL_RESPONSE_NOT_LATEST_BYTES')
            asset_status, asset_fields, asset_body = request(identifier, '/assets/frozen.js')
            need(asset_status == 200 and asset_body == asset.read_bytes()
                 and asset_fields.get('cache-control') == 'public, max-age=31536000, immutable',
                 'HASHED_ASSET_CACHE_CHANGED')
            asset_status, _, _ = request(identifier, '/assets/frozen.js', {'If-None-Match': asset_fields['etag']})
            need(asset_status == 304, 'HASHED_ASSET_REVALIDATION_DISABLED')
            return {'variant': name, 'nginxVersion': version, 'configSha256': sha(config.encode()),
                    'validators': validators, 'cases': cases, 'unchangedAssetConditionalStatus': asset_status}
        finally:
            # Remove only our unique, labelled disposable fixture, even after an unknown start result.
            inspect = native(['docker', 'inspect', container], checked=False)
            if inspect.returncode == 0:
                rows = json.loads(inspect.stdout)
                need(len(rows) == 1 and rows[0]['Config']['Labels'].get(LABEL) == token,
                     'DISPOSABLE_CONTAINER_OWNERSHIP_CHANGED')
                native(['docker', 'rm', '--force', rows[0]['Id']])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--docker', action='store_true')
    parser.add_argument('--static', action='store_true')
    args = parser.parse_args()
    current, legacy, image = configuration()
    old = b'<html><body>release-old</body></html>'.ljust(1874, b' ')
    new = b'<html><body>release-new</body></html>'.ljust(1874, b' ')
    need(len(old) == len(new) and sha(old) != sha(new), 'FIXTURE_CONTENT_COLLISION')
    if args.static and not args.docker:
        print(json.dumps({'status': 'STATIC_INPUTS_VERIFIED_REAL_NGINX_NOT_RUN', 'indexBytes': len(old),
                          'image': image, 'legacyConfigSha256': sha(legacy.encode()),
                          'candidateConfigSha256': sha(current.encode())}))
        return
    need(args.docker and platform.system() == 'Linux' and os.environ.get('GITHUB_ACTIONS') == 'true',
         'REAL_NGINX_REQUIRES_LINUX_GITHUB_ACTIONS')
    native(['docker', 'pull', image], timeout=180)
    before = run_variant('legacy', legacy, image, old, new)
    after = run_variant('fixed', current, image, old, new, before['validators'])
    result = {'status': 'REAL_NGINX_CACHE_REGRESSION_PASSED', 'scope': 'DISPOSABLE_CI_ONLY',
              'image': image, 'indexBytes': len(old), 'mtime': 0,
              'sameLengthDifferentContents': True, 'legacy': before, 'fixed': after,
              'productionOperations': False, 'paymentActions': 0}
    output = ROOT / '.runtime/nginx-admin-cache/verification.json'
    with output.open('x') as file:
        json.dump(result, file, sort_keys=True, indent=2)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
