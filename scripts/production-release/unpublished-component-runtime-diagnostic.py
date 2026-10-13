"""Read-only diagnostic: finite missing-field reconstruction, never authority.

The full original configuration digest must match. No existing field is removed.
Only enumerated empty DNS representations and an explicitly requested,
unqualified Env ordering probe can vary existing values.
Config/HostConfig/Mounts values and credentials never appear in the result.
"""

import copy
import hashlib
import itertools
import json
import math
import re

MAX_BODY_BYTES = 512 * 1024
MISSING = object()
DEFAULTS = (
    ('Config', 'OnBuild', (None, [])),
    ('HostConfig', 'KernelMemory', (0,)),
    ('HostConfig', 'KernelMemoryTCP', (0,)),
)
EMPTY_DNS_FIELDS = ('Dns', 'DnsOptions', 'DnsSearch')


class ReconstructionRejected(ValueError):
    """The code is public; rejected values are intentionally never included."""


def need(value, code):
    if not value:
        raise ReconstructionRejected(code)


def _json_shape(value, depth=0):
    need(depth <= 64, 'CONFIGURATION_BODY_TOO_DEEP')
    kind = type(value)
    if kind is dict:
        need(all(type(key) is str for key in value), 'CONFIGURATION_BODY_INVALID')
        for child in value.values():
            _json_shape(child, depth + 1)
    elif kind is list:
        for child in value:
            _json_shape(child, depth + 1)
    else:
        need(kind in (str, int, float, bool, type(None)), 'CONFIGURATION_BODY_INVALID')
        need(kind is not float or math.isfinite(value), 'CONFIGURATION_BODY_INVALID')


def fingerprint(body):
    """Match the production snapshot's complete canonical JSON digest."""
    try:
        raw = json.dumps(body, sort_keys=True, separators=(',', ':'),
                         ensure_ascii=True, allow_nan=False).encode()
    except (TypeError, ValueError, OverflowError):
        raise ReconstructionRejected('CONFIGURATION_BODY_INVALID') from None
    need(len(raw) <= MAX_BODY_BYTES, 'CONFIGURATION_BODY_TOO_LARGE')
    return hashlib.sha256(raw).hexdigest()


def _validated_body(body):
    need(type(body) is dict and set(body) == {'Config', 'HostConfig', 'Mounts'}
         and type(body['Config']) is dict and type(body['HostConfig']) is dict
         and type(body['Mounts']) is list, 'CONFIGURATION_BODY_INVALID')
    _json_shape(body)
    destinations = []
    for mount in body['Mounts']:
        need(type(mount) is dict and type(mount.get('Destination')) is str
             and mount['Destination'].startswith('/'), 'CONFIGURATION_MOUNTS_INVALID')
        destinations.append(mount['Destination'])
    need(destinations == sorted(destinations) and len(set(destinations)) == len(destinations),
         'CONFIGURATION_MOUNTS_NOT_CANONICAL')
    fingerprint(body)
    return body


def _env_probe(body):
    values = body['Config'].get('Env')
    need(type(values) is list and all(type(value) is str and '=' in value
         and bool(value.split('=', 1)[0]) for value in values), 'ENV_PROBE_INVALID')
    names = [value.split('=', 1)[0] for value in values]
    need(len(set(names)) == len(names), 'ENV_PROBE_DUPLICATE_VARIABLE')
    return sorted(values)


def reconstruct_legacy_sha(body, expected_sha256, *, probe_env_order=False):
    """Try at most 12 default shapes (24 with the unqualified Env probe).

    A match is an offline finding. It does not prove a restart, daemon version,
    native invocation, source authority, or a valid production baseline.
    """
    need(type(expected_sha256) is str
         and re.fullmatch('[a-f0-9]{64}', expected_sha256) is not None,
         'EXPECTED_CONFIGURATION_SHA_INVALID')
    need(type(probe_env_order) is bool, 'ENV_PROBE_SELECTION_INVALID')
    current = _validated_body(body)
    env_sorted = _env_probe(current) if probe_env_order else None
    env_modes = (False, True) if env_sorted is not None and env_sorted != current['Config']['Env'] else (False,)
    choices = [(MISSING, *values) if field not in current[group] else (MISSING,)
               for group, field, values in DEFAULTS]
    candidates, matches = [], []
    for selections in itertools.product(*choices):
        for sort_env in env_modes:
            candidate = copy.deepcopy(current)
            changes = []
            for (group, field, _), value in zip(DEFAULTS, selections):
                if value is not MISSING:
                    # Enumeration never substitutes for an existing value.
                    need(field not in candidate[group], 'EXISTING_FIELD_REPLACEMENT_FORBIDDEN')
                    candidate[group][field] = copy.deepcopy(value)
                    changes.append({'path': group + '.' + field, 'operation': 'fill_missing',
                                    'value': copy.deepcopy(value)})
            if sort_env:
                candidate['Config']['Env'] = env_sorted[:]
                changes.append({'path': 'Config.Env', 'operation': 'sort_order_probe',
                                'semanticQualified': False})
            digest = fingerprint(candidate)
            summary = {'sha256': digest, 'changes': changes,
                       'containsUnqualifiedEnvOrderProbe': sort_env}
            candidates.append(summary)
            if digest == expected_sha256:
                matches.append(copy.deepcopy(summary))
    need(len(candidates) <= (24 if probe_env_order else 12), 'RECONSTRUCTION_BOUND_EXCEEDED')
    return {'scope': 'OFFLINE_RESTART_CONFIGURATION_RECONSTRUCTION', 'version': 1,
            'status': 'EXACT_LEGACY_SHA_MATCH' if matches else 'NO_MATCH',
            'currentSha256': fingerprint(current), 'expectedSha256': expected_sha256,
            'candidateCount': len(candidates), 'matches': matches, 'candidates': candidates,
            'qualified': False, 'productionAuthority': False,
            'nativeRestartProven': False, 'oldSealChanged': False}


def reconstruct_empty_dns_sha(body, expected_sha256):
    """Observe only Docker 25's three existing empty DNS representations.

    readHostConfig() calls InitDNSHostConfig(), which represents nil DNS slices
    as empty slices. This finite hypothesis is never publication authority:
    https://github.com/moby/moby/blob/v25.0.16/container/container.go#L525-L545
    Every nonempty value and every other configuration field stays exact.
    """
    need(type(expected_sha256) is str and re.fullmatch('[a-f0-9]{64}', expected_sha256),
         'EXPECTED_CONFIGURATION_SHA_INVALID')
    current = _validated_body(body)
    fields = tuple(name for name in EMPTY_DNS_FIELDS if name in current['HostConfig']
                   and (current['HostConfig'][name] is None
                        or type(current['HostConfig'][name]) is list and current['HostConfig'][name] == []))
    matches = []
    count = 0
    for values in itertools.product((None, []), repeat=len(fields)):
        candidate = copy.deepcopy(current)
        changes = []
        for name, value in zip(fields, values):
            if type(candidate['HostConfig'][name]) is not type(value):
                candidate['HostConfig'][name] = copy.deepcopy(value)
                changes.append({'path': 'HostConfig.' + name, 'operation': 'empty_dns_representation',
                                'value': copy.deepcopy(value)})
        candidate_sha256 = fingerprint(candidate)
        count += 1
        if candidate_sha256 == expected_sha256:
            matches.append({'sha256': candidate_sha256, 'changes': changes})
    need(1 <= count <= 8, 'DNS_REPRESENTATION_BOUND_EXCEEDED')
    return {'status': 'EXACT_LEGACY_SHA_MATCH' if matches else 'NO_MATCH',
            'candidateCount': count, 'matches': matches, 'qualified': False, 'productionAuthority': False}


# This namespace observes runtime facts. No consumer/publication branch admits it.
import argparse
import base64
import gzip
import importlib.util
import inspect
import os
from pathlib import Path
import shlex
import subprocess
import time

NAME = 'unpublished-component-runtime-diagnostic.py'
PREFIX = 'unpublished-component-runtime-diagnostic'
SCOPE = 'UNPUBLISHED_COMPONENT_RUNTIME_DIAGNOSTIC'
OPERATION = 'diagnose_unpublished_component_runtime'
REGION = 'ap-northeast-1'
INSTANCE = 'i-05836da38606e633c'
ROLES = ('admin', 'api', 'auto-recharge', 'auto-registration', 'caddy', 'media-resolver', 'mysql')
STATE_FIELDS = frozenset(('containerId', 'image', 'reference', 'status', 'health',
                         'startedAtSha256', 'environmentSha256', 'configurationSha256'))
STABLE_FIELDS = STATE_FIELDS - {'startedAtSha256', 'configurationSha256'}
PROBE_SECONDS = 360
SSM_SECONDS = 900
COMMENT = 'ID read-only unpublished component runtime diagnostic'
RECEIPT_FIELDS = frozenset(('version', 'scope', 'status', 'producer', 'qualityRunId',
    'instanceId', 'currentRelease', 'currentCommit', 'manifestSha256', 'hostBootIdSha256',
    'docker', 'services', 'configuration', 'qualified', 'productionAuthority', 'businessActions'))


def diag_need(ok, code):
    if not ok:
        raise RuntimeError('UNPUBLISHED_COMPONENT_DIAGNOSTIC_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def closed(raw, cap=128 * 1024):
    diag_need(type(raw) is bytes and 0 < len(raw) < cap, 'JSON_SIZE')
    def unique(items):
        result = {}
        for name, value in items:
            diag_need(name not in result, 'JSON_DUPLICATE')
            result[name] = value
        return result
    def constant(_):
        raise RuntimeError('UNPUBLISHED_COMPONENT_DIAGNOSTIC_JSON_CONSTANT')
    try:
        value = json.loads(raw, object_pairs_hook=unique, parse_constant=constant)
    except (UnicodeError, ValueError):
        raise RuntimeError('UNPUBLISHED_COMPONENT_DIAGNOSTIC_JSON_INVALID') from None
    diag_need(type(value) is dict, 'JSON_OBJECT')
    return value


def load(name):
    path = Path(__file__).with_name(name)
    spec = importlib.util.spec_from_file_location('runtime_diagnostic_' + name.replace('.', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def producer(value):
    diag_need(type(value) is dict and set(value) == {'commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'}
        and all(type(value[n]) is str and re.fullmatch('[a-f0-9]{40}', value[n]) for n in ('commit', 'sourceTree'))
        and all(type(value[n]) is str and re.fullmatch('[1-9][0-9]{0,19}', value[n]) for n in ('workflowRunId', 'workflowRunAttempt')), 'PRODUCER')
    return dict(value)


def selection():
    diag_need(os.environ.get('RELEASE_OPERATION') == OPERATION and os.environ.get('GITHUB_ACTIONS') == 'true'
        and os.environ.get('GITHUB_REF') == 'refs/heads/main' and os.environ.get('AWS_REGION') == REGION
        and os.environ.get('PRODUCTION_INSTANCE_ID') == INSTANCE
        and os.environ.get('HISTORICAL_EXCEPTION', 'none') == 'none'
        and os.environ.get('API_FAULT_RESTORE_APPROVED', 'false') == 'false'
        and not any(os.environ.get(n) for n in ('REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID',
             'REUSE_IMAGE_RUN_ATTEMPT', 'POST_CLEANUP_SEAL_SHA256', 'ORDER_ARCHIVE_SEAL_SHA256',
             'ORDER_ARCHIVE_PREPARED_IMAGES_SHA256', 'RELEASE_BROWSER_CACHE_IMAGE', 'RELEASE_BROWSER_CACHE_IMAGE_ID',
             'CACHE_PLAN_SHA256', 'DIAGNOSTIC_COMMAND_ID')), 'SELECTION')
    p = producer({n: os.environ.get(e, '') for n, e in (('commit', 'RELEASE_COMMIT'), ('sourceTree', 'SOURCE_TREE'),
        ('workflowRunId', 'GITHUB_RUN_ID'), ('workflowRunAttempt', 'GITHUB_RUN_ATTEMPT'))})
    quality = os.environ.get('QUALITY_RUN_ID', '')
    diag_need(re.fullmatch('[1-9][0-9]{0,19}', quality) is not None, 'QUALITY')
    expected = os.environ.get('EXPECTED_CURRENT', '')
    # Current H is the actual manifest commit; its exact full bytes are checked remotely.
    diag_need(type(expected) is str and re.fullmatch('[a-f0-9]{40}', expected), 'EXPECTED_CURRENT')
    return p, quality, expected


def api_versions(server):
    diag_need(type(server) is dict and all(type(server.get(n)) is str for n in ('Version', 'ApiVersion', 'MinAPIVersion')), 'DOCKER_VERSION')
    numbers = []
    for n in ('MinAPIVersion', 'ApiVersion'):
        match = re.fullmatch(r'1\.([0-9]{2})', server[n])
        diag_need(match is not None, 'DOCKER_API_RANGE')
        numbers.append(int(match.group(1)))
    low, high = numbers
    diag_need(20 <= low <= high <= 60 and re.fullmatch('[A-Za-z0-9_.+-]{1,64}', server['Version']), 'DOCKER_API_RANGE')
    result = tuple('1.' + str(n) for n in range(max(low, 40), high + 1))
    diag_need(len(result) <= 21, 'DOCKER_API_BOUND')
    return result


def checked_states(states, expected):
    diag_need(type(states) is dict and set(states) == set(expected) == set(ROLES), 'ROLES')
    for role, row in states.items():
        diag_need(type(row) is dict and set(row) == STATE_FIELDS and row['status'] == 'running'
            and row['health'] == expected[role]['health']
            and all(row[n] == expected[role][n] for n in STABLE_FIELDS), 'SERVICE_IDENTITY')
        diag_need(all(type(row[n]) is str and re.fullmatch('[a-f0-9]{64}', row[n])
            for n in ('containerId', 'startedAtSha256', 'environmentSha256', 'configurationSha256'))
            and re.fullmatch('sha256:[a-f0-9]{64}', row['image']) is not None, 'SERVICE_SHAPE')
    return states


def inspect_body(raw, state):
    diag_need(type(raw) is str and 0 < len(raw.encode()) < 1024 * 1024, 'INSPECT_SIZE')
    # The complete row remains in memory. Its values are never a receipt field.
    value = json.loads(raw)
    diag_need(type(value) is list and len(value) == 1 and type(value[0]) is dict, 'INSPECT_SHAPE')
    row = value[0]
    diag_need(row.get('Id') == state['containerId'] and row.get('Image') == state['image']
        and type(row.get('Config')) is dict and row['Config'].get('Image') == state['reference']
        and type(row['Config'].get('Env')) is list and all(type(n) is str for n in row['Config']['Env'])
        and fingerprint(sorted(row['Config']['Env'])) == state['environmentSha256']
        and type(row.get('HostConfig')) is dict and type(row.get('Mounts')) is list, 'INSPECT_IDENTITY')
    body = {'Config': row['Config'], 'HostConfig': row['HostConfig'],
            'Mounts': sorted(row['Mounts'], key=lambda n: n.get('Destination', ''))}
    _validated_body(body)
    return body


def key_names(body):
    result = {'configKeys': sorted(body['Config']), 'hostConfigKeys': sorted(body['HostConfig']),
              'mountKeys': sorted({n for row in body['Mounts'] for n in row})}
    diag_need(all(len(names) <= 192 and all(re.fullmatch('[A-Za-z][A-Za-z0-9_]{0,127}', n) for n in names)
                  for names in result.values()), 'KEY_NAMES')
    return result


def probe(p, quality, expected, *, context=None, inspect_version=None, clock=time.monotonic, boot_id_bytes=None):
    p = producer(p)
    c = load('unpublished-component-successor.py')
    d, _admin, scope, _projection = c.modules() if context is None else context
    deadline = clock() + PROBE_SECONDS
    def remaining():
        left = deadline - clock()
        diag_need(left > 0, 'DEADLINE')
        return min(20, left)
    current = (d.BASE / 'current').resolve()
    diag_need(str(current) == c.BASELINE_CONTRACT['currentRelease'], 'CURRENT_RELEASE')
    raw = c.private_bytes(current / 'release-manifest.json')
    manifest = closed(raw)
    diag_need(digest(raw) == c.BASELINE_CONTRACT['manifestSha256'] and manifest.get('commit') == expected, 'MANIFEST')
    def snapshot():
        remaining()
        # Reject an ONLINE service before the old snapshot's optional ONLINE branch.
        diag_need(set(scope.workspace_service_names(d, current)) == set(ROLES), 'ROLES')
        original_run = d.run
        def bounded_run(*args, **kwargs):
            kwargs['timeout'] = min(kwargs.get('timeout', 20), remaining())
            return original_run(*args, **kwargs)
        d.run = bounded_run
        try:
            return scope.snapshot(d, current)
        finally:
            d.run = original_run
    states = checked_states(snapshot(), c.BASELINE_CONTRACT['services'])
    server = closed(d.run('docker', 'version', '--format', '{{json .Server}}', timeout=remaining()).encode())
    versions = api_versions(server)
    def native_inspect(cid, api, timeout):
        result = subprocess.run(['docker', 'inspect', cid], env={**os.environ, 'DOCKER_API_VERSION': api},
                                capture_output=True, text=True, timeout=timeout)
        return result.returncode, result.stdout  # Never stderr or raw stdout in receipt.
    inspect_version = native_inspect if inspect_version is None else inspect_version
    configurations = {}
    for role in ROLES:
        state, original = states[role], c.BASELINE_CONTRACT['services'][role]
        body = inspect_body(d.run('docker', 'inspect', state['containerId'], timeout=remaining()), state)
        diag_need(fingerprint(body) == state['configurationSha256'], 'SNAPSHOT_CONFIG_MOVED')
        result = reconstruct_legacy_sha(body, original['configurationSha256'], probe_env_order=True)
        dns = reconstruct_empty_dns_sha(body, original['configurationSha256'])
        matched, errors = [], []
        for api in versions:
            try:
                code, stdout = inspect_version(state['containerId'], api, remaining())
            except subprocess.TimeoutExpired:
                errors.append(api); continue
            if code:
                errors.append(api); continue
            historic = inspect_body(stdout, state)
            if fingerprint(historic) == original['configurationSha256']:
                matched.append(api)
        configurations[role] = {**key_names(body), 'expectedSha256': original['configurationSha256'],
            'currentSha256': result['currentSha256'], 'startedAtChanged': state['startedAtSha256'] != original['startedAtSha256'],
            'candidateCount': result['candidateCount'], 'matchingDefaults': result['matches'],
            'dnsCandidateCount': dns['candidateCount'], 'matchingDnsRepresentations': dns['matches'],
            'matchingApiVersions': matched, 'failedApiVersions': errors, 'qualified': False}
    remaining()
    diag_need((d.BASE / 'current').resolve() == current and c.private_bytes(current / 'release-manifest.json') == raw
        and snapshot() == states, 'CURRENT_MOVED')
    boot = Path('/proc/sys/kernel/random/boot_id').read_bytes() if boot_id_bytes is None else boot_id_bytes
    diag_need(type(boot) is bytes and re.fullmatch(rb'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\n?', boot), 'BOOT_ID')
    boot_sha = digest(boot)
    return {'version': 1, 'scope': SCOPE, 'status': 'READONLY_COMPLETE', 'producer': p, 'qualityRunId': quality,
        'instanceId': INSTANCE, 'currentRelease': str(current), 'currentCommit': expected, 'manifestSha256': digest(raw),
        'hostBootIdSha256': boot_sha, 'docker': {n: server[n] for n in ('Version', 'ApiVersion', 'MinAPIVersion')},
        'services': states, 'configuration': configurations, 'qualified': False,
        'productionAuthority': False, 'businessActions': 0}


def parameters(p, quality, expected):
    p = producer(p)
    diag_need(re.fullmatch('[1-9][0-9]{0,19}', quality) is not None
        and re.fullmatch('[a-f0-9]{40}', expected) is not None, 'INPUT')
    c, original = load('unpublished-component-successor.py'), load('api-admin-readonly.py')
    directory = '/opt/id-business-v2/.staging/oidc-' + p['commit']
    pins = {name: digest(Path(__file__).with_name(name).read_bytes()) for name in (*c.HELPERS, NAME)}
    encoded = base64.b64encode(json.dumps(p, sort_keys=True, separators=(',', ':')).encode()).decode()
    program = (inspect.getsource(original._store_files) + '\ntry:\n    _store_files(' + repr(directory) + ', '
        + repr(p['commit']) + ', ' + repr(pins) + ', False)\n'
        + '    import runpy,sys\n    sys.argv=' + repr([directory + '/' + NAME, 'remote', '--producer', encoded,
            '--quality-run-id', quality, '--expected-current', expected]) + '\n'
        + '    runpy.run_path(sys.argv[0],run_name="__main__")\n'
        + 'except BaseException:\n    print(' + repr(json.dumps({'scope': SCOPE, 'status': 'DIAGNOSTIC_FAILED',
            'qualified': False, 'productionAuthority': False, 'businessActions': 0, 'code': 'REMOTE_READ_FAILED'}, separators=(',', ':')))
        + ')\n    raise SystemExit(1) from None\n').encode()
    diag_need(len(program) < 32 * 1024, 'SOURCE_PROGRAM_SIZE')
    packed = base64.b85encode(gzip.compress(program, mtime=0)).decode()
    bootstrap = ('import base64,hashlib,zlib;v=zlib.decompressobj(31);r=v.decompress(base64.b85decode('
        + repr(packed) + '),32768);assert 0<len(r)<32768 and v.eof and not v.unused_data and not v.unconsumed_tail;'
        + 'assert hashlib.sha256(r).hexdigest()==' + repr(digest(program))
        + ';exec(compile(r,"<fixed-runtime-diagnostic>","exec"))')
    params = {'commands': ['python3 -B -c ' + shlex.quote(bootstrap)], 'executionTimeout': [str(SSM_SECONDS)]}
    diag_need(len(json.dumps(params).encode()) < 20 * 1024, 'PARAMETERS_SIZE')
    return params, program


def write_once(path, raw):
    load('api-admin-readonly.py').write_workspace_private_bytes(path, raw)


def private(path):
    return load('unpublished-component-successor.py').private_bytes(path, cap=128 * 1024)


def command_raw(*args, optional=False):
    result = subprocess.run(args, capture_output=True, timeout=60)
    if result.returncode:
        if optional and b'InvocationDoesNotExist' in result.stderr:
            return None
        raise RuntimeError('UNPUBLISHED_COMPONENT_DIAGNOSTIC_TRANSPORT_FAILED')
    return result.stdout


def verify_main(p):
    diag_need(command_raw('git', 'rev-parse', 'HEAD').decode().strip() == p['commit']
        and command_raw('git', 'rev-parse', 'HEAD^{tree}').decode().strip() == p['sourceTree']
        and command_raw('git', 'status', '--porcelain', '--untracked-files=all').strip() == b''
        and command_raw('git', 'ls-remote', 'origin', 'refs/heads/main').decode().strip() == p['commit'] + '\trefs/heads/main', 'STALE_MAIN')


def validate_receipt(value, p, quality, expected):
    diag_need(type(value) is dict and set(value) == RECEIPT_FIELDS and type(value['version']) is int and value['version'] == 1
        and value['scope'] == SCOPE and value['status'] == 'READONLY_COMPLETE' and value['producer'] == p
        and value['qualityRunId'] == quality and value['instanceId'] == INSTANCE and value['currentCommit'] == expected
        and value['qualified'] is False and value['productionAuthority'] is False
        and type(value['businessActions']) is int and value['businessActions'] == 0, 'RECEIPT')
    c = load('unpublished-component-successor.py')
    diag_need(value['currentRelease'] == c.BASELINE_CONTRACT['currentRelease']
        and value['manifestSha256'] == c.BASELINE_CONTRACT['manifestSha256']
        and re.fullmatch('[a-f0-9]{64}', value['hostBootIdSha256']) is not None, 'RECEIPT_BASELINE')
    checked_states(value['services'], c.BASELINE_CONTRACT['services'])
    diag_need(set(value['configuration']) == set(ROLES), 'RECEIPT_CONFIGURATION')
    versions = api_versions(value['docker'])
    for role, facts in value['configuration'].items():
        fields = {'configKeys', 'hostConfigKeys', 'mountKeys', 'expectedSha256', 'currentSha256', 'startedAtChanged',
            'candidateCount', 'matchingDefaults', 'dnsCandidateCount', 'matchingDnsRepresentations',
            'matchingApiVersions', 'failedApiVersions', 'qualified'}
        diag_need(type(facts) is dict and set(facts) == fields and facts['qualified'] is False
            and facts['expectedSha256'] == c.BASELINE_CONTRACT['services'][role]['configurationSha256']
            and facts['currentSha256'] == value['services'][role]['configurationSha256']
            and type(facts['startedAtChanged']) is bool
            and facts['startedAtChanged'] == (value['services'][role]['startedAtSha256'] != c.BASELINE_CONTRACT['services'][role]['startedAtSha256'])
            and type(facts['candidateCount']) is int
            and 0 < facts['candidateCount'] <= 24 and type(facts['matchingDefaults']) is list
            and len(facts['matchingDefaults']) <= 24 and type(facts['dnsCandidateCount']) is int
            and 1 <= facts['dnsCandidateCount'] <= 8 and type(facts['matchingDnsRepresentations']) is list
            and len(facts['matchingDnsRepresentations']) <= 1, 'RECEIPT_CONFIGURATION')
        for name in ('configKeys', 'hostConfigKeys', 'mountKeys'):
            diag_need(type(facts[name]) is list and facts[name] == sorted(set(facts[name])) and len(facts[name]) <= 192
                and all(type(n) is str and re.fullmatch('[A-Za-z][A-Za-z0-9_]{0,127}', n) for n in facts[name]), 'RECEIPT_KEY_NAMES')
        for name in ('matchingApiVersions', 'failedApiVersions'):
            diag_need(type(facts[name]) is list and len(facts[name]) == len(set(facts[name]))
                and all(n in versions for n in facts[name]), 'RECEIPT_API_VERSION')
        diag_need(not set(facts['matchingApiVersions']) & set(facts['failedApiVersions']), 'RECEIPT_API_VERSION')
        for match in facts['matchingDnsRepresentations']:
            diag_need(type(match) is dict and set(match) == {'sha256', 'changes'}
                and match['sha256'] == facts['expectedSha256'] and type(match['changes']) is list
                and len(match['changes']) <= 3, 'RECEIPT_DNS_MATCH')
            paths = []
            for change in match['changes']:
                diag_need(type(change) is dict and set(change) == {'path', 'operation', 'value'}
                    and change['path'] in tuple('HostConfig.' + name for name in EMPTY_DNS_FIELDS)
                    and change['operation'] == 'empty_dns_representation'
                    and (change['value'] is None or type(change['value']) is list and change['value'] == []), 'RECEIPT_DNS_MATCH')
                paths.append(change['path'])
            diag_need(len(set(paths)) == len(paths) and paths == sorted(paths), 'RECEIPT_DNS_MATCH')
        # Only documented public default values/path markers may be retained.
        for match in facts['matchingDefaults']:
            diag_need(type(match) is dict and set(match) == {'sha256', 'changes', 'containsUnqualifiedEnvOrderProbe'}
                and match['sha256'] == facts['expectedSha256'] and type(match['containsUnqualifiedEnvOrderProbe']) is bool
                and type(match['changes']) is list and len(match['changes']) <= 4, 'RECEIPT_MATCH')
            for change in match['changes']:
                diag_need(type(change) is dict, 'RECEIPT_MATCH')
                if change.get('operation') == 'sort_order_probe':
                    diag_need(change == {'path': 'Config.Env', 'operation': 'sort_order_probe', 'semanticQualified': False}, 'RECEIPT_MATCH')
                else:
                    diag_need(set(change) == {'path', 'operation', 'value'} and change['operation'] == 'fill_missing'
                        and any(change['path'] == group + '.' + field and any(type(change['value']) is type(v) and change['value'] == v for v in values)
                            for group, field, values in DEFAULTS), 'RECEIPT_MATCH')
    return value


def validate_native(raw, command_id):
    value = closed(raw)
    required = {'CommandId', 'InstanceId', 'DocumentName', 'PluginName', 'Status', 'ResponseCode',
        'StandardOutputContent', 'StandardErrorContent', 'ExecutionStartDateTime', 'ExecutionEndDateTime'}
    optional = {'Comment', 'DocumentVersion', 'StatusDetails', 'ExecutionElapsedTime',
        'StandardOutputUrl', 'StandardErrorUrl', 'CloudWatchOutputConfig'}
    diag_need(required <= set(value) <= required | optional, 'NATIVE_FIELDS')
    cloudwatch = value.get('CloudWatchOutputConfig', {})
    diag_need(value.get('Comment', COMMENT) == COMMENT
        and value.get('StatusDetails', 'Success') == 'Success'
        and re.fullmatch(r'(?:\$DEFAULT|[1-9][0-9]{0,5})', value.get('DocumentVersion', '$DEFAULT'))
        and re.fullmatch(r'PT(?=.+)(?:[0-9]{1,3}H)?(?:[0-9]{1,3}M)?(?:[0-9]{1,5}(?:\.[0-9]{1,9})?S)?',
                         value.get('ExecutionElapsedTime', 'PT0S'))
        and type(cloudwatch) is dict and set(cloudwatch) <= {'CloudWatchLogGroupName', 'CloudWatchOutputEnabled'}
        and cloudwatch.get('CloudWatchLogGroupName', '') == ''
        and cloudwatch.get('CloudWatchOutputEnabled', False) is False, 'NATIVE_METADATA')
    return load('unpublished-component-successor.py').validate_invocation(raw, command_id, INSTANCE)


def original_parameters(command_id, params):
    raw = command_raw('aws', '--region', REGION, 'ssm', 'list-commands', '--command-id', command_id, '--output', 'json')
    result = closed(raw)
    diag_need(set(result) <= {'Commands', 'NextToken'} and result.get('NextToken', '') == ''
        and type(result.get('Commands')) is list and len(result['Commands']) == 1, 'NATIVE_COMMAND')
    row = result['Commands'][0]
    diag_need(type(row) is dict and row.get('CommandId') == command_id
        and row.get('InstanceIds') == [INSTANCE] and row.get('Targets', []) == []
        and row.get('DocumentName') == 'AWS-RunShellScript' and row.get('Comment') == COMMENT
        and row.get('Parameters') == params, 'NATIVE_PARAMETERS')
    # Never retain raw ListCommands metadata: only the exact credential-free parameters.
    return json.dumps({'commandId': command_id, 'instanceId': INSTANCE,
        'parameters': params, 'parametersSha256': fingerprint(params),
        'nativeListCommandsSha256': digest(raw)}, sort_keys=True, separators=(',', ':')).encode()


def transport():
    p, quality, expected = selection()
    verify_main(p)
    # The descriptor writer creates parents without following a .deploy symlink.
    folder = Path.cwd() / '.deploy/production-release'
    meta_path = folder / (PREFIX + '-invocation-metadata.json')
    intent_path = folder / (PREFIX + '-send-intent.json')
    params_path = folder / (PREFIX + '-parameters.json')
    source_path = folder / (PREFIX + '-source-program.py')
    if meta_path.exists() or meta_path.is_symlink():
        meta = closed(private(meta_path))
        diag_need(set(meta) == {'commandId', 'instanceId', 'producer', 'qualityRunId', 'expectedCurrent', 'status'}
            and meta['producer'] == p and meta['qualityRunId'] == quality and meta['expectedCurrent'] == expected
            and meta['instanceId'] == INSTANCE and meta['status'] == 'ACCEPTED', 'ACCEPTED_CONTEXT')
        command_id = meta['commandId']
        params = closed(private(params_path))
        source = private(source_path)
        intent = closed(private(intent_path))
        diag_need(intent == {'producer': p, 'qualityRunId': quality, 'expectedCurrent': expected,
            'parametersSha256': fingerprint(params), 'sourceProgramSha256': digest(source), 'status': 'SEND_INTENT_RECORDED'}, 'ACCEPTED_INTENT')
        current_params, current_source = parameters(p, quality, expected)
        diag_need(params == current_params and source == current_source, 'ACCEPTED_SOURCE')
    else:
        diag_need(not intent_path.exists() and not intent_path.is_symlink(), 'UNKNOWN_SEND_RECONCILIATION_REQUIRED')
        params, source = parameters(p, quality, expected)
        write_once(params_path, json.dumps(params, sort_keys=True, separators=(',', ':')).encode())
        write_once(source_path, source)
        write_once(intent_path, json.dumps({'producer': p, 'qualityRunId': quality, 'expectedCurrent': expected,
            'parametersSha256': fingerprint(params), 'sourceProgramSha256': digest(source), 'status': 'SEND_INTENT_RECORDED'}, sort_keys=True).encode())
        verify_main(p)
        command_id = command_raw('aws', '--region', REGION, 'ssm', 'send-command', '--instance-ids', INSTANCE,
            '--document-name', 'AWS-RunShellScript', '--parameters', json.dumps(params), '--timeout-seconds', str(SSM_SECONDS),
            '--comment', COMMENT, '--query', 'Command.CommandId', '--output', 'text').decode().strip()
        diag_need(re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', command_id) is not None, 'COMMAND_ID')
        meta = {'commandId': command_id, 'instanceId': INSTANCE, 'producer': p, 'qualityRunId': quality,
            'expectedCurrent': expected, 'status': 'ACCEPTED'}
        write_once(meta_path, json.dumps(meta, sort_keys=True).encode())
    diag_need(re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', command_id) is not None, 'COMMAND_ID')
    deadline = time.monotonic() + SSM_SECONDS + 60
    while time.monotonic() < deadline:
        raw = command_raw('aws', '--region', REGION, 'ssm', 'get-command-invocation', '--command-id', command_id,
            '--instance-id', INSTANCE, '--output', 'json', optional=True)
        if raw is None:
            time.sleep(5); continue
        provisional = closed(raw)
        diag_need(provisional.get('CommandId') == command_id and provisional.get('InstanceId') == INSTANCE
            and provisional.get('DocumentName') == 'AWS-RunShellScript', 'NATIVE_IDENTITY')
        if provisional.get('Status') in ('Pending', 'InProgress', 'Delayed'):
            time.sleep(5); continue
        if provisional.get('Status') != 'Success':
            write_once(folder / (PREFIX + '-failure.json'), json.dumps({'scope': SCOPE,
                'status': 'DIAGNOSTIC_FAILED_RAW_SUPPRESSED', 'commandId': command_id, 'instanceId': INSTANCE,
                'nativeInvocationSha256': digest(raw), 'qualified': False, 'productionAuthority': False, 'businessActions': 0}, sort_keys=True).encode())
            raise RuntimeError('UNPUBLISHED_COMPONENT_DIAGNOSTIC_NATIVE_FAILED')
        native, receipt = validate_native(raw, command_id)
        validate_receipt(receipt, p, quality, expected)
        write_once(folder / (PREFIX + '-original-parameters.json'), original_parameters(command_id, params))
        # Only an exact credential-free closed receipt permits retaining raw native.
        write_once(folder / (PREFIX + '-native.json'), raw)
        write_once(folder / (PREFIX + '-result.json'), json.dumps({'commandId': command_id, 'instanceId': INSTANCE,
            'nativeInvocationSha256': digest(raw), 'receipt': receipt, 'qualified': False, 'productionAuthority': False}, sort_keys=True).encode())
        print(json.dumps({'scope': SCOPE, 'status': 'READONLY_COMPLETE', 'commandId': command_id,
            'qualified': False, 'productionAuthority': False, 'businessActions': 0}, sort_keys=True))
        return receipt
    raise RuntimeError('UNPUBLISHED_COMPONENT_DIAGNOSTIC_ACCEPTED_RESULT_PENDING')


def cli():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('diagnose', 'remote'))
    parser.add_argument('--producer')
    parser.add_argument('--quality-run-id')
    parser.add_argument('--expected-current')
    args = parser.parse_args()
    if args.mode == 'diagnose':
        diag_need(not any((args.producer, args.quality_run_id, args.expected_current)), 'CLIENT_ARGUMENTS')
        return transport()
    diag_need(type(args.producer) is str and len(args.producer) < 1024, 'REMOTE_ARGUMENTS')
    p = producer(closed(base64.b64decode(args.producer, validate=True)))
    diag_need(re.fullmatch('[1-9][0-9]{0,19}', args.quality_run_id or '') is not None
        and re.fullmatch('[a-f0-9]{40}', args.expected_current or '') is not None, 'REMOTE_ARGUMENTS')
    value = probe(p, args.quality_run_id, args.expected_current)
    validate_receipt(value, p, args.quality_run_id, args.expected_current)
    raw = json.dumps(value, sort_keys=True, separators=(',', ':'))
    diag_need(len(raw.encode()) < 24000, 'RECEIPT_SIZE')
    print(raw)
    return value


if __name__ == '__main__':
    try:
        cli()
    except BaseException:
        print(json.dumps({'scope': SCOPE, 'status': 'DIAGNOSTIC_FAILED', 'qualified': False,
            'productionAuthority': False, 'businessActions': 0, 'code': 'REMOTE_READ_FAILED'}, sort_keys=True))
        raise SystemExit(1) from None
