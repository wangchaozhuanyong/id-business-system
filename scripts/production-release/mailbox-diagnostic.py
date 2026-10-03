"""Pin the running API and emit only a bounded, filtered mailbox diagnostic receipt."""
import fcntl
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import sys
import time

BASE = Path('/opt/id-business-v2')
MAILBOX_PROGRAM = globals().get('MAILBOX_PROGRAM')
LIMIT = 4096
CATEGORIES = {'SUCCESS', 'CONFIGURATION', 'NETWORK', 'HTTP', 'AUTHORIZATION', 'GRAPHQL', 'RESPONSE'}
CODES = {
    'OK', 'INVALID_CONFIGURATION', 'URL_CREDENTIALS_REJECTED', 'HTTPS_REQUIRED',
    'ADMIN_PATH_REQUIRED', 'FORBIDDEN', 'UNAUTHENTICATED', 'PLATFORM_OWNER_REQUIRED',
    'GRAPHQL_VALIDATION_FAILED', 'GRAPHQL_PARSE_FAILED', 'BAD_USER_INPUT',
    'INTERNAL_SERVER_ERROR', 'USER_INPUT_ERROR', 'GRAPHQL_ERROR', 'HTTP_AUTHORIZATION', 'HTTP_ERROR',
    'REDIRECT_BLOCKED', 'DNS_ERROR', 'CONNECTION_REFUSED', 'CONNECTION_RESET',
    'TIMEOUT', 'TOTAL_TIMEOUT', 'NETWORK_UNREACHABLE', 'TLS_ERROR', 'NETWORK_ERROR',
    'INVALID_JSON', 'RESPONSE_TOO_LARGE', 'INVALID_RESPONSE', 'DIAGNOSTIC_FAILED',
}
FAILURE_CODES = {'TOTAL_TIMEOUT', 'OUTPUT_LIMIT_EXCEEDED', 'COMMAND_FAILED', 'INVALID_RECEIPT',
                 'BASELINE_MISMATCH', 'IMAGE_MISMATCH', 'API_CONTAINER_MISMATCH',
                 'INVALID_EXPECTED_CURRENT', 'PROGRAM_UNAVAILABLE', 'LOCK_UNAVAILABLE',
                 'DEPLOYMENT_LOCKED', 'DIAGNOSTIC_FAILED'}


class DiagnosticError(Exception):
    def __init__(self, code):
        self.code = code


def require(condition, code):
    if not condition:
        raise DiagnosticError(code)


def remaining(deadline):
    seconds = deadline - time.monotonic()
    require(seconds > 0, 'TOTAL_TIMEOUT')
    return seconds


def run(*args, data=None, timeout=10):
    """Never capture stderr; bound stdout while reading, including Docker exec."""
    deadline = time.monotonic() + timeout
    output = bytearray()
    with subprocess.Popen(args, stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
        try:
            with selectors.DefaultSelector() as selector:
                os.set_blocking(process.stdout.fileno(), False)
                selector.register(process.stdout, selectors.EVENT_READ)
                pending = memoryview(data) if data is not None else None
                if pending is not None:
                    os.set_blocking(process.stdin.fileno(), False)
                    selector.register(process.stdin, selectors.EVENT_WRITE)
                while selector.get_map():
                    events = selector.select(remaining(deadline))
                    require(events, 'TOTAL_TIMEOUT')
                    for key, _ in events:
                        if key.fileobj is process.stdin:
                            if pending:
                                pending = pending[os.write(process.stdin.fileno(), pending):]
                            if not pending:
                                selector.unregister(process.stdin)
                                process.stdin.close()
                        else:
                            chunk = os.read(process.stdout.fileno(), LIMIT + 1 - len(output))
                            if not chunk:
                                selector.unregister(process.stdout)
                            else:
                                output.extend(chunk)
                                require(len(output) <= LIMIT, 'OUTPUT_LIMIT_EXCEEDED')
                require(process.wait(timeout=remaining(deadline)) == 0, 'COMMAND_FAILED')
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise DiagnosticError('TOTAL_TIMEOUT') from None
        except BaseException:
            process.kill()
            process.wait()
            raise
    try:
        return output.decode('utf-8')
    except UnicodeError:
        raise DiagnosticError('INVALID_RECEIPT') from None


def filter_receipt(raw):
    require(isinstance(raw, str) and len(raw.encode()) <= LIMIT, 'OUTPUT_LIMIT_EXCEEDED')
    try:
        payload = json.loads(raw)
    except (ValueError, TypeError):
        raise DiagnosticError('INVALID_RECEIPT') from None
    require(isinstance(payload, dict), 'INVALID_RECEIPT')
    result = {}
    for name in ('configured', 'https', 'adminPath', 'queryChannelPresent'):
        require(type(payload.get(name)) is bool, 'INVALID_RECEIPT')
        result[name] = payload[name]
    for name, root in (('primaryAccounts', 'icloudPrimaryAccounts'), ('virtualEmails', 'icloudVirtualEmails')):
        source = payload.get(name)
        require(isinstance(source, dict), 'INVALID_RECEIPT')
        require(isinstance(source.get('category'), str) and source['category'] in CATEGORIES,
                'INVALID_RECEIPT')
        require(isinstance(source.get('code'), str) and source['code'] in CODES, 'INVALID_RECEIPT')
        status = source.get('status')
        count = source.get('count')
        require(status is None or type(status) is int and 100 <= status <= 599, 'INVALID_RECEIPT')
        require(count is None or type(count) is int and 0 <= count <= 1000000, 'INVALID_RECEIPT')
        require(source.get('path') in ([], [root]), 'INVALID_RECEIPT')
        if source['category'] == 'SUCCESS':
            require(source['code'] == 'OK' and status is not None and 200 <= status < 300
                    and count is not None and source['path'] == [root], 'INVALID_RECEIPT')
        else:
            require(count is None and source['code'] != 'OK', 'INVALID_RECEIPT')
        result[name] = {key: source[key] for key in ('category', 'status', 'count', 'code', 'path')}
    return result


def filter_runtime_receipt(raw):
    require(isinstance(raw, str) and len(raw.encode()) <= LIMIT, 'OUTPUT_LIMIT_EXCEEDED')
    try:
        payload = json.loads(raw)
    except (ValueError, TypeError):
        raise DiagnosticError('INVALID_RECEIPT') from None
    require(isinstance(payload, dict) and payload.get('mode') == 'READ_ONLY', 'INVALID_RECEIPT')
    verified = payload.get('baselineVerified') is True and payload.get('containerVerified') is True
    if verified:
        return {'mode': 'READ_ONLY', 'baselineVerified': True, 'containerVerified': True,
                **filter_receipt(raw)}
    require(payload.get('baselineVerified') is False and payload.get('containerVerified') is False
            and isinstance(payload.get('code'), str) and payload['code'] in FAILURE_CODES,
            'INVALID_RECEIPT')
    return {'mode': 'READ_ONLY', 'baselineVerified': False, 'containerVerified': False,
            'code': payload['code']}


def manifest(expected):
    current = BASE / 'current'
    require(current.is_symlink(), 'BASELINE_MISMATCH')
    release = current.resolve()
    require(release.parent == BASE / 'releases', 'BASELINE_MISMATCH')
    path = release / 'release-manifest.json'
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 65536,
            'BASELINE_MISMATCH')
    payload = json.loads(path.read_text())
    require(payload.get('commit') == expected, 'BASELINE_MISMATCH')
    image = payload.get('images', {}).get('api', {})
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', image.get('digest', '')) is not None
            and re.fullmatch(r'[0-9a-f]{40}', image.get('sourceCommit', '')) is not None,
            'IMAGE_MISMATCH')
    return release, image


def api_container(release, image, deadline):
    containers = run('docker', 'compose', '--env-file', str(release / '.env.aws.production'),
                     '-f', str(release / 'docker-compose.aws-mysql.yml'),
                     '-f', str(release / 'compose.release.json'),
                     'ps', '--status', 'running', '--quiet', 'api',
                     timeout=min(10, remaining(deadline))).splitlines()
    require(len(containers) == 1 and re.fullmatch(r'[0-9a-f]{12,64}', containers[0]) is not None,
            'API_CONTAINER_MISMATCH')
    container = containers[0]
    selected = ('{"image":{{json .Image}},"status":{{json .State.Status}},'
                '"health":{{json .State.Health.Status}},'
                '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
                '"project":{{json (index .Config.Labels "com.docker.compose.project")}}}')
    state = json.loads(run('docker', 'inspect', '--format', selected, container,
                          timeout=min(10, remaining(deadline))))
    require(state.get('image') == image['digest'] and state.get('status') == 'running'
            and state.get('health') == 'healthy' and state.get('service') == 'api'
            and isinstance(state.get('project'), str)
            and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,62}', state['project']) is not None,
            'API_CONTAINER_MISMATCH')
    revision = run('docker', 'image', 'inspect', '--format',
                   '{{index .Config.Labels "org.opencontainers.image.revision"}}', image['digest'],
                   timeout=min(10, remaining(deadline))).strip()
    require(revision == image['sourceCommit'], 'IMAGE_MISMATCH')
    return container


def diagnose(expected):
    require(isinstance(expected, str) and re.fullmatch(r'[0-9a-f]{40}', expected) is not None,
            'INVALID_EXPECTED_CURRENT')
    require(isinstance(MAILBOX_PROGRAM, str) and 0 < len(MAILBOX_PROGRAM.encode()) <= 16384,
            'PROGRAM_UNAVAILABLE')
    deadline = time.monotonic() + 45
    try:
        lock = (BASE / '.deploy.lock').open('r')
    except OSError:
        raise DiagnosticError('LOCK_UNAVAILABLE') from None
    with lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DiagnosticError('DEPLOYMENT_LOCKED') from None
        release, image = manifest(expected)
        container = api_container(release, image, deadline)
        raw = run('docker', 'exec', '-i', container, 'node', '--input-type=module', '-',
                  data=MAILBOX_PROGRAM.encode(), timeout=remaining(deadline))
        receipt = filter_receipt(raw)
        after_release, after_image = manifest(expected)
        require(after_release == release and after_image == image, 'BASELINE_MISMATCH')
        require(api_container(after_release, after_image, deadline) == container,
                'API_CONTAINER_MISMATCH')
        return {'mode': 'READ_ONLY', 'baselineVerified': True, 'containerVerified': True, **receipt}


def main():
    try:
        require(len(sys.argv) == 3 and sys.argv[1] == '--expected-current', 'INVALID_EXPECTED_CURRENT')
        result = diagnose(sys.argv[2])
    except DiagnosticError as error:
        result = {'mode': 'READ_ONLY', 'baselineVerified': False, 'containerVerified': False,
                  'code': error.code}
    except BaseException:
        result = {'mode': 'READ_ONLY', 'baselineVerified': False, 'containerVerified': False,
                  'code': 'DIAGNOSTIC_FAILED'}
    output = json.dumps(result, separators=(',', ':'))
    if len(output.encode()) <= LIMIT:
        print(output)
    else:
        print('{"mode":"READ_ONLY","code":"OUTPUT_LIMIT_EXCEEDED"}')


if __name__ == '__main__':
    main()
