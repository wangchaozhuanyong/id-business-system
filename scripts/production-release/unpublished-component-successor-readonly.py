"""Independent bounded transport and authentication for the finite successor.

The already published hotfix is a cold predecessor, never a publication target.
Historical B is authenticated from immutable files and its genuine ended Q;
its old live database assumptions are not reused for a later migration.
"""
import ast
import base64
import gzip
import hashlib
import inspect
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import time
import zlib

INSTANCE = 'i-05836da38606e633c'
REGION = 'ap-northeast-1'
CONTRACT_FIELDS = frozenset(('currentRelease', 'manifestSha256', 'adminPredecessorRelease',
    'adminPredecessorManifestSha256', 'adminPublicationSha256', 'hotfixPublicationSha256',
    'services', 'apiImage', 'apiSourceCommit', 'apiSourceTree', 'historicalB', 'hotfixScope',
    'hotfixKeys', 'roles', 'hotfixReadbackCommandId', 'hotfixReadbackInvocationBytesSha256',
    'hotfixStdoutSha256', 'hotfixDecodedSha256', 'historicalWireSha256'))
HOTFIX_FIELDS = frozenset(('adminImageId', 'apiImageId', 'baselineApiCommit', 'businessActions',
    'current', 'migrationPerformed', 'patchSourceCommit', 'preservedServices', 'publicReady', 'scope', 'status'))
INPUT_SCOPE = 'UNPUBLISHED_COMPONENT_INPUT_BUNDLE'
INPUT_CHUNK_BYTES = 8192
# Independent genuine restart Q; historical H/B/Q and BASELINE_CONTRACT stay sealed.
NATIVE_RESTART_AUTHORITY = {'commandId': '4b8d9c99-03da-449e-9d64-731208fe3bc8',
 'commandListBytesSha256': '06b4a003aeefa24fbabde99848cbf18e946831b22e4bbfcd6e85eda5de8fed2c',
 'configurationModelsSha256': 'c73c4fe017bce40a54f7031ce10c5d02178463fc81a8c3fd68d1138a604a5aa3',
 'invocationBytesSha256': '9f1ea98fd2d592b5a97454eebd0ee1992410a05ba100a7113c9bed62cbdff39f',
 'parametersSha256': 'a741521da8fd3552dd1d7d24c79d84e61b975d751fa64a7be168d12a5652013f',
 'programSha256': '169850e7723c6018d2a3bab8ef607bd1cd3921276127385ee432cd3ef8f70a69',
 'receiptKeyset': ['businessActions',
                   'configurationModels',
                   'currentCommit',
                   'currentRelease',
                   'dnsFields',
                   'docker',
                   'hostBootIdSha256',
                   'instanceId',
                   'legacyConfigurationSha256',
                   'manifestSha256',
                   'migrationPerformed',
                   'migrationState',
                   'onlinePublished',
                   'publicAdminBuildId',
                   'publicReady',
                   'scope',
                   'services',
                   'sourceCommit',
                   'sourcePinsSha256',
                   'sourceTree',
                   'status',
                   'version'],
 'receiptSha256': 'e70a5954e154ea7eb05b838e58156b3fd6e2f6065ef1a1ea75055801592b2b03',
 'servicesSha256': 'b6f4173005681c7e7ab6baba6fbd4b8f2bee972a3f38c8ce2a02b680dd40ef83',
 'sourceCommit': 'e90f02a65cdf63b656e82eed6e25fd8a68a21b7b',
 'sourcePinsSha256': '51501bce8c0ad3a82670f548cb9d9e601d85822e9a07f5a02df205158e916b9d',
 'sourceTree': 'd05f53c00552b444dd557fd56457668e60410017',
 'stdoutSha256': '09707dfecc6d10a9ab416e9551f5877cebcfe96d565294b75bee9cfe34b4d169'}


def need(value, code):
    if not value:
        raise RuntimeError('UNPUBLISHED_COMPONENT_' + code)


def load(filename):
    import importlib.util
    path = Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location('successor_' + filename.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def decode_hotfix(output, expected_stdout_sha, expected_decoded_sha):
    c = load('unpublished-component-successor.py')
    need(type(output) is str and 0 < len(output.encode()) < 24000
         and digest(output.encode()) == expected_stdout_sha, 'HOTFIX_Q_CHANGED')
    envelope = c.closed_json(output.encode(), 24000)
    need(set(envelope) == {'encoding', 'sha256', 'payload'}
         and envelope['encoding'] == 'zlib-base64' and envelope['sha256'] == expected_decoded_sha
         and type(envelope['payload']) is str, 'HOTFIX_Q_CHANGED')
    packed = base64.b64decode(envelope['payload'], validate=True)
    need(0 < len(packed) < 12000, 'HOTFIX_Q_CHANGED')
    decoder = zlib.decompressobj()
    raw = decoder.decompress(packed, 16384)
    need(decoder.eof and not decoder.unconsumed_tail and not decoder.unused_data
         and 0 < len(raw) < 16384 and digest(raw) == expected_decoded_sha, 'HOTFIX_Q_CHANGED')
    receipt = c.closed_json(raw, 16384)
    need(set(receipt) == HOTFIX_FIELDS, 'HOTFIX_Q_CHANGED')
    return receipt


def native_hotfix(d, contract):
    c = load('unpublished-component-successor.py')
    # The instance has no GetCommandInvocation permission. The trusted runner
    # obtains the actual ended AWS invocation and installs its exact bytes via
    # the existing descriptor writer. The source-bound byte seal is mandatory.
    path = (d.BASE / '.staging' / ('component-hotfix-origin-'
            + contract['hotfixReadbackInvocationBytesSha256']) / 'invocation.json')
    raw = c.private_bytes(path, cap=128 * 1024)
    return validate_hotfix_native(raw, contract)


def validate_hotfix_native(raw, contract):
    c = load('unpublished-component-successor.py')
    need(digest(raw) == contract['hotfixReadbackInvocationBytesSha256'], 'HOTFIX_Q_CHANGED')
    value = c.closed_json(raw, 128 * 1024)
    need(value.get('CommandId') == contract['hotfixReadbackCommandId']
         and value.get('InstanceId') == INSTANCE and value.get('DocumentName') == 'AWS-RunShellScript'
         and value.get('PluginName') == 'aws:runShellScript' and value.get('Status') == 'Success'
         and type(value.get('ResponseCode')) is int and value['ResponseCode'] == 0
         and value.get('StandardErrorContent') == '', 'HOTFIX_Q_CHANGED')
    return decode_hotfix(value.get('StandardOutputContent'), contract['hotfixStdoutSha256'],
                        contract['hotfixDecodedSha256'])


def historical_b(d, contract):
    c = load('unpublished-component-successor.py')
    expected = contract['historicalB']
    need(type(expected) is dict and set(expected) == {'release', 'sourceTree', 'manifestSha256',
        'recordSha256', 'proofSha256', 'nativeReadbackCommandId', 'nativeInvocationRelativePath',
        'nativeInvocationSha256', 'nativeStdoutSha256'}, 'B_ORIGIN_CHANGED')
    directory = Path(expected['release'])
    need(directory.parent == d.BASE / 'releases' and directory.resolve() == directory
         and not directory.is_symlink(), 'B_ORIGIN_CHANGED')
    raws = {name: c.private_bytes(directory / name, cap=128 * 1024) for name in (
        'release-manifest.json', 'api-workspace-preservation.json', 'api-workspace-build-proof.json')}
    for name, key in (('release-manifest.json', 'manifestSha256'),
                      ('api-workspace-preservation.json', 'recordSha256'),
                      ('api-workspace-build-proof.json', 'proofSha256')):
        need(digest(raws[name]) == expected[key], 'B_ORIGIN_CHANGED')
    manifest, record, proof = (c.closed_json(raws[n], 128 * 1024) for n in raws)
    need(manifest['commit'] == contract['apiSourceCommit'] and manifest['sourceTree'] == expected['sourceTree']
         == contract['apiSourceTree'] and proof['commit'] == manifest['commit']
         and proof['sourceTree'] == manifest['sourceTree'], 'B_ORIGIN_CHANGED')
    match = re.fullmatch(r'github-actions-([1-9][0-9]*)-([1-9][0-9]*)', manifest.get('deploymentRun', ''))
    need(match is not None, 'B_ORIGIN_CHANGED')
    relative = ('.staging/api-workspace-preflight-' + manifest['commit'] + '-'
                + match[1] + '-' + match[2] + '/api-workspace-readback-invocation.json')
    need(expected['nativeInvocationRelativePath'] == relative, 'B_ORIGIN_CHANGED')
    raw = c.private_bytes(d.BASE / relative, cap=65536)
    need(digest(raw) == expected['nativeInvocationSha256'], 'B_ORIGIN_CHANGED')
    native = c.closed_json(raw, 65536)
    need(native.get('CommandId') == expected['nativeReadbackCommandId'] and native.get('InstanceId') == INSTANCE
         and native.get('DocumentName') == 'AWS-RunShellScript' and native.get('PluginName') == 'aws:runShellScript'
         and native.get('Status') == 'Success' and type(native.get('ResponseCode')) is int
         and native['ResponseCode'] == 0 and native.get('StandardErrorContent') == ''
         and type(native.get('StandardOutputContent')) is str
         and digest(native['StandardOutputContent'].encode()) == expected['nativeStdoutSha256'], 'B_ORIGIN_CHANGED')
    wire_path = Path(__file__).with_name('api-admin-pending-receipt-wire.py')
    need(digest(wire_path.read_bytes()) == contract['historicalWireSha256'], 'B_ORIGIN_CHANGED')
    wire = load(wire_path.name)
    receipt = wire.decode_receipt_output(native['StandardOutputContent'], scope='API_ADMIN_WORKSPACE')
    need(receipt.get('status') == 'API_ADMIN_WORKSPACE_VERIFIED' and receipt.get('commit') == manifest['commit']
         and receipt.get('sourceTree') == manifest['sourceTree'] and receipt.get('services') == record['after']
         and receipt.get('buildProofSha256') == c.fingerprint(proof)
         and receipt.get('servicesUpdated') == ['api', 'admin']
         and type(receipt.get('preservedServiceCount')) is int and receipt['preservedServiceCount'] == 5
         and receipt.get('runningImagesAndContentMatched') is True and receipt.get('environmentUnchanged') is True,
         'B_ORIGIN_CHANGED')
    return {n: expected[n] for n in ('release', 'manifestSha256', 'recordSha256', 'proofSha256',
        'nativeReadbackCommandId', 'nativeInvocationSha256')} | {'authenticated': True}


def restart_origin_paths(d, authority):
    folder = d.BASE / '.staging' / ('component-same-container-restart-origin-'
                                   + authority['invocationBytesSha256'])
    return folder / 'invocation.json', folder / 'command-list.json'


def validate_restart_material(c, invocation_raw, command_list_raw):
    """Authenticate both original AWS reads and the exact executed source."""
    authority = NATIVE_RESTART_AUTHORITY
    fields = {'commandId', 'invocationBytesSha256', 'commandListBytesSha256', 'parametersSha256',
        'programSha256', 'stdoutSha256', 'sourcePinsSha256', 'servicesSha256',
        'configurationModelsSha256', 'receiptSha256', 'receiptKeyset', 'sourceCommit', 'sourceTree'}
    need(type(authority) is dict and set(authority) == fields, 'RESTART_NATIVE_NOT_SEALED')
    need(all(type(authority[k]) is str and re.fullmatch('[a-f0-9]{64}', authority[k])
         for k in fields if k.endswith('Sha256'))
         and all(type(authority[k]) is str and re.fullmatch('[a-f0-9]{40}', authority[k])
                 for k in ('sourceCommit', 'sourceTree')), 'RESTART_NATIVE_NOT_SEALED')
    need(digest(invocation_raw) == authority['invocationBytesSha256']
         and digest(command_list_raw) == authority['commandListBytesSha256'], 'RESTART_NATIVE_BYTES_CHANGED')
    native, receipt = c.validate_invocation(invocation_raw, authority['commandId'], INSTANCE)
    commands = c.closed_json(command_list_raw, 128 * 1024)
    need(set(commands) == {'Commands'} and type(commands['Commands']) is list
         and len(commands['Commands']) == 1, 'RESTART_COMMAND_LIST_CHANGED')
    command = commands['Commands'][0]
    need(type(command) is dict and command.get('CommandId') == authority['commandId']
         and command.get('DocumentName') == 'AWS-RunShellScript'
         and command.get('Status') == command.get('StatusDetails') == 'Success'
         and command.get('InstanceIds') == [INSTANCE] and command.get('Targets') == []
         and all(type(command.get(k)) is int and command[k] == expected for k, expected in
                 (('TargetCount', 1), ('CompletedCount', 1), ('ErrorCount', 0), ('DeliveryTimedOutCount', 0))),
         'RESTART_COMMAND_LIST_CHANGED')
    parameters = command.get('Parameters')
    need(type(parameters) is dict and set(parameters) == {'commands', 'executionTimeout'}
         and c.fingerprint(parameters) == authority['parametersSha256']
         and type(parameters['commands']) is list and len(parameters['commands']) == 1
         and type(parameters['commands'][0]) is str, 'RESTART_PARAMETERS_CHANGED')
    argv = shlex.split(parameters['commands'][0])
    need(len(argv) == 4 and argv[:3] == ['python3', '-B', '-c'], 'RESTART_PROGRAM_CHANGED')
    carrier = ast.parse(argv[3])
    encoded = [node for node in ast.walk(carrier) if isinstance(node, ast.Call)
               and ast.unparse(node.func) == 'base64.b64decode']
    need(len(encoded) == 1 and len(encoded[0].args) == 1
         and isinstance(encoded[0].args[0], ast.Constant) and type(encoded[0].args[0].value) is str,
         'RESTART_PROGRAM_CHANGED')
    packed = base64.b64decode(encoded[0].args[0].value, validate=True)
    need(0 < len(packed) <= 24 * 1024, 'RESTART_PROGRAM_CHANGED')
    decoder = zlib.decompressobj(31)
    program = decoder.decompress(packed, 128 * 1024)
    need(decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail
         and 0 < len(program) < 128 * 1024 and digest(program) == authority['programSha256'],
         'RESTART_PROGRAM_CHANGED')
    assignments = [node for node in ast.walk(ast.parse(program)) if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == 'pins' for target in node.targets)]
    need(len(assignments) == 1, 'RESTART_SOURCE_PINS_CHANGED')
    pins = ast.literal_eval(assignments[0].value)
    need(type(pins) is dict and set(pins) == set(c.HELPERS)
         and all(type(v) is str and re.fullmatch('[a-f0-9]{64}', v) for v in pins.values())
         and c.fingerprint(pins) == authority['sourcePinsSha256'], 'RESTART_SOURCE_PINS_CHANGED')
    need(sorted(receipt) == authority['receiptKeyset'] and len(receipt) == 22
         and type(receipt['version']) is int and receipt['version'] == 1
         and receipt['scope'] == 'UNPUBLISHED_COMPONENT_SAME_CONTAINER_RESTART'
         and receipt['status'] == 'SAME_CONTAINER_RESTART_VERIFIED'
         and receipt['instanceId'] == INSTANCE and receipt['sourceCommit'] == authority['sourceCommit']
         and receipt['sourceTree'] == authority['sourceTree']
         and receipt['sourcePinsSha256'] == authority['sourcePinsSha256']
         and c.fingerprint(receipt) == authority['receiptSha256']
         and digest(native['StandardOutputContent'].encode()) == authority['stdoutSha256']
         and c.fingerprint(receipt['services']) == authority['servicesSha256']
         and c.fingerprint(receipt['configurationModels']) == authority['configurationModelsSha256']
         and receipt['dnsFields'] == ['Dns', 'DnsOptions', 'DnsSearch']
         and receipt['docker'] == {'version': '25.0.16', 'apiVersion': '1.44', 'minApiVersion': '1.24'}
         and type(receipt['hostBootIdSha256']) is str
         and re.fullmatch('[a-f0-9]{64}', receipt['hostBootIdSha256'])
         and receipt['publicReady'] is True and type(receipt['businessActions']) is int
         and receipt['businessActions'] == 0
         and receipt['migrationPerformed'] is False and receipt['onlinePublished'] is False
         and type(receipt['migrationState']) is dict and receipt['migrationState'].get('status') == 'PENDING',
         'RESTART_RECEIPT_CHANGED')
    return receipt, pins


def restart_host_facts(d):
    version = json.loads(d.run('docker', 'version', '--format', '{{json .Server}}'))
    return {'version': version['Version'], 'apiVersion': version['ApiVersion'],
            'minApiVersion': version['MinAPIVersion']}, digest(Path('/proc/sys/kernel/random/boot_id').read_bytes())


def verify_restart_source_pins(d, pins, commit):
    for name, expected in pins.items():
        path = d.BASE / '.staging' / ('oidc-' + commit) / name
        need(path.resolve() == path and not path.is_symlink(), 'RESTART_SOURCE_PINS_CHANGED')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            before = os.fstat(fd)
            need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                 and before.st_uid in (0, os.geteuid()) and before.st_mode & 0o022 == 0
                 and 0 < before.st_size < 2 * 1024**2, 'RESTART_SOURCE_PINS_CHANGED')
            raw = b''
            while len(raw) <= before.st_size:
                part = os.read(fd, min(65536, before.st_size - len(raw) + 1))
                if not part:
                    break
                raw += part
            after = os.fstat(fd)
            visible = path.lstat()
            identity = lambda row: (row.st_dev, row.st_ino, row.st_mode, row.st_uid, row.st_nlink,
                                    row.st_size, row.st_mtime_ns, row.st_ctime_ns)
            need(identity(before) == identity(after) == identity(visible)
                 and len(raw) == before.st_size and digest(raw) == expected, 'RESTART_SOURCE_PINS_CHANGED')
        finally:
            os.close(fd)


def authenticate_restart_native(c, d, current, manifest, contract, states):
    need('restorationNative' not in contract, 'RESTART_RESTORATION_AUTHORITY_MIXED')
    need(type(NATIVE_RESTART_AUTHORITY) is dict, 'RESTART_NATIVE_NOT_SEALED')
    paths = restart_origin_paths(d, NATIVE_RESTART_AUTHORITY)
    receipt, pins = validate_restart_material(c, *(c.private_bytes(path, cap=128 * 1024) for path in paths))
    need(receipt['currentRelease'] == str(current) == contract['currentRelease']
         and receipt['currentCommit'] == manifest['commit']
         and receipt['manifestSha256'] == contract['manifestSha256']
         and receipt['publicAdminBuildId'] == 'v2-' + manifest['commit'], 'RESTART_MANIFEST_CHANGED')
    need(set(states) == set(receipt['services']) == set(contract['services']) == set(c.SERVICES)
         and states == receipt['services'] and set(receipt['configurationModels']) == set(c.SERVICES)
         and set(receipt['legacyConfigurationSha256']) == set(c.SERVICES), 'RESTART_CURRENT_STATE_CHANGED')
    verify_restart_source_pins(d, pins, receipt['sourceCommit'])
    docker, boot = restart_host_facts(d)
    need(docker == receipt['docker'] and boot == receipt['hostBootIdSha256'], 'RESTART_HOST_CHANGED')
    for name in c.SERVICES:
        old, state = contract['services'][name], states[name]
        need(type(state) is dict and set(state) == set(old)
             and all(state[k] == old[k] for k in old if k not in ('startedAtSha256', 'configurationSha256'))
             and type(state['startedAtSha256']) is str and re.fullmatch('[a-f0-9]{64}', state['startedAtSha256'])
             and state['startedAtSha256'] != old['startedAtSha256'], 'RESTART_IDENTITY_CHANGED')
        body = c.configuration_body(d, state)
        need(all(k in body['HostConfig'] and type(body['HostConfig'][k]) is list
                 and body['HostConfig'][k] == [] for k in receipt['dnsFields']), 'RESTART_DNS_NOT_EMPTY')
        need(c.fingerprint(c.canonical_dns_configuration(body)) == old['configurationSha256']
             == receipt['legacyConfigurationSha256'][name]
             and c.configuration_model(d, state) == receipt['configurationModels'][name],
             'RESTART_CONFIGURATION_CHANGED')
    return {'scope': receipt['scope'], 'authenticated': True,
        'commandId': NATIVE_RESTART_AUTHORITY['commandId'],
        'invocationBytesSha256': NATIVE_RESTART_AUTHORITY['invocationBytesSha256'],
        'commandListBytesSha256': NATIVE_RESTART_AUTHORITY['commandListBytesSha256'],
        'parametersSha256': NATIVE_RESTART_AUTHORITY['parametersSha256'],
        'programSha256': NATIVE_RESTART_AUTHORITY['programSha256'],
        'sourceCommit': receipt['sourceCommit'], 'sourceTree': receipt['sourceTree'],
        'sourcePinsSha256': receipt['sourcePinsSha256'], 'servicesSha256': c.fingerprint(states),
        'configurationModelsSha256': c.fingerprint(receipt['configurationModels']),
        'migrationState': receipt['migrationState']}


def authenticate_hotfix(d, current, manifest, contract):
    c = load('unpublished-component-successor.py')
    need(type(contract) is dict and set(contract) in (CONTRACT_FIELDS,
         CONTRACT_FIELDS | {'restorationNative'}), 'BASELINE_CONTRACT_NOT_SEALED')
    need(str(current) == contract['currentRelease'] and current.resolve() == current
         and current.parent == d.BASE / 'releases' and not current.is_symlink(), 'HOTFIX_BASELINE_CHANGED')
    raw = c.private_bytes(current / 'release-manifest.json', cap=128 * 1024)
    need(c.closed_json(raw, 128 * 1024) == manifest and digest(raw) == contract['manifestSha256'],
         'HOTFIX_BASELINE_CHANGED')
    ledger = manifest.get('apiHotfixPublication')
    need(type(ledger) is dict and sorted(ledger) == contract['hotfixKeys']
         and c.fingerprint(ledger) == contract['hotfixPublicationSha256']
         and c.fingerprint(manifest['adminPublication']) == contract['adminPublicationSha256']
         and ledger['scope'] == contract['hotfixScope'] == 'API_RECOVERY_SINGLE_SOURCE_HOTFIX'
         and ledger['servicesUpdated'] == ['api'] and ledger['newMigrations'] == []
         and all(ledger[n] is False for n in ('migrationPerformed', 'databaseGrantsChanged',
             'paymentPerformed', 'subscriptionChanged', 'externalNotification'))
         and ledger['sqliteMaintenanceCleared'] is True, 'HOTFIX_BASELINE_CHANGED')
    need(sorted(ledger['before']) == sorted(ledger['after']) == contract['roles'] == sorted(c.SERVICES)
         and all(ledger['before'][n] == ledger['after'][n] for n in c.SERVICES if n != 'api'),
         'HOTFIX_SERVICES_CHANGED')
    for n in ('beforeAudit', 'afterAudit'):
        c.audit_guard(ledger[n])
    receipt = native_hotfix(d, contract)
    need(receipt['scope'] == ledger['scope'] and receipt['status'] == 'API_HOTFIX_READBACK_VERIFIED'
         and receipt['current'] == str(current) and receipt['patchSourceCommit'] == ledger['patchSourceCommit']
         == manifest['commit'] and receipt['baselineApiCommit'] == ledger['baselineApiCommit'] == contract['apiSourceCommit']
         and receipt['apiImageId'] == ledger['imageId'] == contract['apiImage']['imageId']
         and receipt['adminImageId'] == contract['services']['admin']['image']
         and type(receipt['businessActions']) is int and receipt['businessActions'] == 0
         and type(receipt['preservedServices']) is int and receipt['preservedServices'] == 6
         and receipt['migrationPerformed'] is False and receipt['publicReady'] is True, 'HOTFIX_Q_CHANGED')
    predecessor = Path(contract['adminPredecessorRelease'])
    before_raw = c.private_bytes(predecessor / 'release-manifest.json', cap=128 * 1024)
    before = c.closed_json(before_raw, 128 * 1024)
    need(predecessor.parent == d.BASE / 'releases' and predecessor.resolve() == predecessor
         and not predecessor.is_symlink() and str(predecessor) == manifest['previousRelease'] == ledger['previousRelease']
         and digest(before_raw) == contract['adminPredecessorManifestSha256']
         == manifest['previousManifestSha256'] == ledger['previousManifestSha256']
         and before['adminPublication'] == manifest['adminPublication']
         and before['previousRelease'] == contract['historicalB']['release'], 'B_ORIGIN_CHANGED')
    historical = historical_b(d, contract)
    _, _, scope, _ = c.modules(d)
    states = scope.snapshot(d, current)
    restart = None
    if 'restorationNative' in contract or states == contract['services']:
        binding = restoration_binding(c, d, contract, states)
    elif NATIVE_RESTART_AUTHORITY is not None:
        restart = authenticate_restart_native(c, d, current, manifest, contract, states)
        binding = None
        need(all(all(ledger['after'][n][k] == contract['services'][n][k] for k in ledger['after'][n])
                 for n in c.SERVICES), 'HOTFIX_SERVICES_CHANGED')
    else:
        binding = restoration_binding(c, d, contract, states)
    if binding is None and restart is None:
        for n in c.SERVICES:
            need(all(states[n][k] == ledger['after'][n][k] for k in ledger['after'][n]), 'HOTFIX_SERVICES_CHANGED')
    need(c.private_bytes(current / 'release-manifest.json', cap=128 * 1024) == raw, 'HOTFIX_BASELINE_CHANGED')
    return {'apiImage': contract['apiImage'], 'apiSourceCommit': contract['apiSourceCommit'],
        'apiSourceTree': contract['apiSourceTree'], 'hotfixPublicationSha256': contract['hotfixPublicationSha256'],
        'hotfixReadbackCommandId': contract['hotfixReadbackCommandId'],
        'hotfixReadbackInvocationBytesSha256': contract['hotfixReadbackInvocationBytesSha256'],
        'services': states, 'restorationBinding': binding, 'nativeRestartBinding': restart, 'historicalB': historical}


def restoration_binding(c, d, contract, states):
    authority = contract.get('restorationNative')
    if authority is None:
        need(states == contract['services'], 'RESTORATION_NATIVE_SEAL_REQUIRED')
        return None
    # Only a new reviewed source contract can name these native identities.
    # The current first-publication contract contains no restoration authority.
    need(type(authority) is dict and set(authority) == {'producer', 'bindingSha256',
         'commandId', 'invocationBytesSha256'}, 'RESTORATION_NATIVE_SEAL_REQUIRED')
    binding = c.authenticate_restoration(d, authority['producer'],
        binding_sha256=authority['bindingSha256'], command_id=authority['commandId'],
        invocation_sha256=authority['invocationBytesSha256'])
    need(type(binding) is dict and binding.get('authenticated') is True
         and binding.get('servicesSha256') == c.fingerprint(states)
         and all(states[n] == contract['services'][n] for n in c.PRESERVED), 'RESTORATION_NATIVE_SEAL_REQUIRED')
    for n in c.UPDATED:
        need(all(states[n][k] == contract['services'][n][k] for k in
                 ('image', 'reference', 'environmentSha256'))
             and states[n]['status'] == 'running' and states[n]['health'] == 'healthy',
             'RESTORATION_NATIVE_SEAL_REQUIRED')
    return binding


def command_raw(*args, optional=False):
    result = subprocess.run(args, capture_output=True, timeout=60)
    if result.returncode:
        if optional and b'InvocationDoesNotExist' in result.stderr:
            return None
        raise RuntimeError('UNPUBLISHED_COMPONENT_TRANSPORT_UNAVAILABLE')
    need(0 < len(result.stdout) < 128 * 1024, 'TRANSPORT_OUTPUT_SIZE')
    return result.stdout


def selected(mode):
    c = load('unpublished-component-successor.py')
    need(mode in ('preflight', 'release', 'readback'), 'SELECTION_INVALID')
    need(os.environ.get('AWS_REGION') == REGION and os.environ.get('PRODUCTION_INSTANCE_ID') == INSTANCE
         and os.environ.get('RELEASE_OPERATION') in ('verify_unpublished_components', 'release_unpublished_components')
         and os.environ.get('HISTORICAL_EXCEPTION', 'none') == 'none'
         and not any(os.environ.get(n) for n in ('REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID',
                                               'CACHE_PLAN_SHA256', 'DIAGNOSTIC_COMMAND_ID')),
         'SELECTION_INVALID')
    p = c.producer(os.environ['RELEASE_COMMIT'], os.environ['SOURCE_TREE'],
                   os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT'])
    need(re.fullmatch('[a-f0-9]{40}', os.environ.get('EXPECTED_CURRENT', '')) is not None, 'SELECTION_INVALID')
    flag = os.environ.get('API_FAULT_RESTORE_APPROVED', 'false')
    need(flag in ('true', 'false') and (mode != 'release' or flag == 'true'), 'API_FAULT_RESTORE_APPROVAL_REQUIRED')
    need(mode == 'preflight' or os.environ['RELEASE_OPERATION'] == 'release_unpublished_components', 'SELECTION_INVALID')
    return c, p


def input_bundle(p, proof_raw, transport_raw):
    need(type(proof_raw) is bytes and 0 < len(proof_raw) < 128 * 1024
         and type(transport_raw) is bytes and 0 < len(transport_raw) < 24576, 'INPUT_BUNDLE_SIZE_INVALID')
    raw = (b'ID_UNPUBLISHED_COMPONENT_INPUTS_V1\n' + len(proof_raw).to_bytes(4, 'big') + proof_raw
           + len(transport_raw).to_bytes(4, 'big') + transport_raw)
    packed = gzip.compress(raw, mtime=0)
    need(0 < len(packed) < 160 * 1024, 'INPUT_BUNDLE_SIZE_INVALID')
    chunks = [packed[n:n + INPUT_CHUNK_BYTES] for n in range(0, len(packed), INPUT_CHUNK_BYTES)]
    plan = {'version': 1, 'scope': INPUT_SCOPE, 'producer': p, 'bundleSha256': digest(packed),
        'compressedLength': len(packed), 'decodedLength': len(raw), 'proofLength': len(proof_raw),
        'proofSha256': digest(proof_raw), 'preflightLength': len(transport_raw), 'preflightSha256': digest(transport_raw),
        'chunks': [{'index': n, 'size': len(chunk), 'sha256': digest(chunk)} for n, chunk in enumerate(chunks)]}
    return plan, chunks


def input_directory(plan, base=None):
    p = plan['producer']
    root = Path('/opt/id-business-v2/.staging/component-inputs') if base is None else Path(base)
    return root / (p['commit'] + '-' + p['workflowRunId'] + '-' + p['workflowRunAttempt']) / plan['bundleSha256']


def read_input_bundle(plan, base=None):
    """Descriptor-bound, finite public evidence; never a configuration reader."""
    import hashlib, os, stat, zlib
    from pathlib import Path
    def required(value):
        if not value:
            raise RuntimeError('UNPUBLISHED_COMPONENT_INPUT_BUNDLE_CHANGED')
    fields = {'version', 'scope', 'producer', 'bundleSha256', 'compressedLength', 'decodedLength',
              'proofLength', 'proofSha256', 'preflightLength', 'preflightSha256', 'chunks'}
    required(type(plan) is dict and set(plan) == fields and type(plan['version']) is int and plan['version'] == 1
             and plan['scope'] == 'UNPUBLISHED_COMPONENT_INPUT_BUNDLE')
    p = plan['producer']
    import re
    required(type(p) is dict and set(p) == {'commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'}
             and all(type(p[n]) is str and re.fullmatch('[a-f0-9]{40}', p[n]) for n in ('commit', 'sourceTree'))
             and all(type(p[n]) is str and re.fullmatch('[1-9][0-9]{0,19}', p[n]) for n in ('workflowRunId', 'workflowRunAttempt')))
    required(all(type(plan[n]) is str and re.fullmatch('[a-f0-9]{64}', plan[n])
                 for n in ('bundleSha256', 'proofSha256', 'preflightSha256'))
             and all(type(plan[n]) is int and 0 < plan[n] < bound for n, bound in
                 (('compressedLength', 160 * 1024), ('decodedLength', 160 * 1024),
                  ('proofLength', 128 * 1024), ('preflightLength', 24576)))
             and type(plan['chunks']) is list and 0 < len(plan['chunks']) <= 20)
    root = Path('/opt/id-business-v2/.staging/component-inputs') if base is None else Path(base)
    folder = root / (p['commit'] + '-' + p['workflowRunId'] + '-' + p['workflowRunAttempt']) / plan['bundleSha256']
    required(folder.is_absolute() and folder.resolve() == folder and not folder.is_symlink())
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    directory = os.open('/', flags)
    try:
        for part in folder.parts[1:]:
            child = os.open(part, flags, dir_fd=directory)
            try:
                metadata = os.fstat(child)
                required(stat.S_ISDIR(metadata.st_mode) and metadata.st_uid in (0, os.getuid()) and not metadata.st_mode & 0o022)
            except Exception:
                os.close(child); raise
            os.close(directory); directory = child
        required(stat.S_IMODE(os.fstat(directory).st_mode) == 0o700)
        chunks = []
        for index, row in enumerate(plan['chunks']):
            required(type(row) is dict and set(row) == {'index', 'size', 'sha256'}
                     and type(row['index']) is int and row['index'] == index
                     and type(row['size']) is int and 0 < row['size'] <= 8192
                     and type(row['sha256']) is str and re.fullmatch('[a-f0-9]{64}', row['sha256']))
            fd = os.open('part-' + str(index).zfill(3) + '.bin', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            with os.fdopen(fd, 'rb') as stream:
                before = os.fstat(stream.fileno())
                required(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid() and before.st_nlink == 1
                         and stat.S_IMODE(before.st_mode) == 0o600 and before.st_size == row['size'])
                raw = stream.read(8193); after = os.fstat(stream.fileno())
                identity = lambda n: (n.st_dev, n.st_ino, n.st_mode, n.st_nlink, n.st_uid, n.st_size, n.st_mtime_ns, n.st_ctime_ns)
                required(identity(before) == identity(after) and len(raw) == row['size']
                         and identity(after) == identity(os.stat('part-' + str(index).zfill(3) + '.bin',
                             dir_fd=directory, follow_symlinks=False))
                         and hashlib.sha256(raw).hexdigest() == row['sha256'])
                chunks.append(raw)
    finally:
        os.close(directory)
    packed = b''.join(chunks)
    required(len(packed) == plan['compressedLength'] and hashlib.sha256(packed).hexdigest() == plan['bundleSha256'])
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    raw = decoder.decompress(packed, 160 * 1024)
    required(decoder.eof and not decoder.unconsumed_tail and not decoder.unused_data
             and len(raw) == plan['decodedLength'] and raw.startswith(b'ID_UNPUBLISHED_COMPONENT_INPUTS_V1\n'))
    offset = len(b'ID_UNPUBLISHED_COMPONENT_INPUTS_V1\n')
    proof_length = int.from_bytes(raw[offset:offset + 4], 'big'); offset += 4
    required(proof_length == plan['proofLength'])
    proof = raw[offset:offset + proof_length]; offset += proof_length
    preflight_length = int.from_bytes(raw[offset:offset + 4], 'big'); offset += 4
    transport = raw[offset:offset + preflight_length]; offset += preflight_length
    required(preflight_length == plan['preflightLength'] and offset == len(raw)
             and hashlib.sha256(proof).hexdigest() == plan['proofSha256']
             and hashlib.sha256(transport).hexdigest() == plan['preflightSha256'])
    return proof, transport


def restart_origin_bytes(c):
    if NATIVE_RESTART_AUTHORITY is None:
        return None
    command_id = NATIVE_RESTART_AUTHORITY['commandId']
    raw_get = command_raw('aws', '--region', REGION, 'ssm', 'get-command-invocation',
        '--command-id', command_id, '--instance-id', INSTANCE, '--output', 'json')
    raw_list = command_raw('aws', '--region', REGION, 'ssm', 'list-commands',
        '--command-id', command_id, '--output', 'json')
    validate_restart_material(c, raw_get, raw_list)
    return raw_get, raw_list


def component_predecessor_bytes(c):
    # Only the exact already published component may use this new origin.
    # The instance has no GetCommandInvocation permission; the trusted runner
    # carries the original ended bytes through the existing private writer.
    if os.environ.get('EXPECTED_CURRENT') != c.COMPONENT_PREDECESSOR['producer']['commit']:
        return None
    raw = command_raw('aws', '--region', REGION, 'ssm', 'get-command-invocation',
        '--command-id', c.COMPONENT_PREDECESSOR['commandId'], '--instance-id', INSTANCE, '--output', 'json')
    c.validate_component_predecessor_native(raw)
    return raw


def parameters(mode, environment=None, *, input_artifacts=None):
    c, p = selected(mode)
    directory = '/opt/id-business-v2/.staging/oidc-' + p['commit']
    original = load('api-admin-readonly.py')
    pins = {n: digest(Path(__file__).with_name(n).read_bytes()) for n in c.HELPERS}
    args = [mode, '--commit', p['commit']]
    payload_args, input_program = '', ''
    if mode in ('preflight', 'release'):
        args += ['--source-tree', p['sourceTree'], '--expected-current', os.environ['EXPECTED_CURRENT'],
                 '--run-id', p['workflowRunId'], '--run-attempt', p['workflowRunAttempt']]
    if mode == 'release':
        need(input_artifacts is None or type(input_artifacts) is tuple and len(input_artifacts) == 2,
             'INPUT_ARTIFACTS_INVALID')
        proof_raw = c.private_bytes(Path(c.PROOF).resolve(), cap=128 * 1024) if input_artifacts is None else input_artifacts[0]
        proof = c.closed_json(proof_raw, 128 * 1024)
        transport_raw = c.private_bytes(Path(c.PREFLIGHT).resolve(), cap=24576) if input_artifacts is None else input_artifacts[1]
        transport = c.closed_json(transport_raw, 24576)
        c.local_preflight(transport, p)
        need(proof['scope'] == c.BUILD_SCOPE and proof['commit'] == p['commit']
             and proof['sourceTree'] == p['sourceTree'] and proof['runId'] == p['workflowRunId']
             and proof['runAttempt'] == p['workflowRunAttempt']
             and proof['qualityRunId'] == os.environ['QUALITY_RUN_ID']
             and proof['preflightSha256'] == c.fingerprint(transport), 'BUILD_PROOF_CHANGED')
        args += ['--repository', os.environ['RELEASE_REPOSITORY'], '--ci-run-id', os.environ['QUALITY_RUN_ID'],
                 '--api-fault-restore-approved']
        # The genuine projection plus native preflight cannot fit one 20 KiB
        # command even when JSON is compressed before base64. Stage only these
        # credential-free bytes in bounded private chunks. The final command
        # reassembles and verifies every byte before encoding CLI arguments.
        plan, _chunks = input_bundle(p, proof_raw, transport_raw)
        input_program = (inspect.getsource(read_input_bundle) + '\n_proof_raw,_transport_raw=read_input_bundle('
                         + repr(plan) + ')\n')
        payload_args = (' + ["--build-proof",base64.b64encode(_proof_raw).decode(),'
                        '"--preflight",base64.b64encode(_transport_raw).decode()]')
    # Only source files from the exact checked-out GitHub commit are fetched;
    # the existing descriptor writer rejects aliases, symlinks and byte drift.
    raw_origin = command_raw('aws', '--region', REGION, 'ssm', 'get-command-invocation',
        '--command-id', c.BASELINE_CONTRACT['hotfixReadbackCommandId'], '--instance-id', INSTANCE,
        '--output', 'json')
    validate_hotfix_native(raw_origin, c.BASELINE_CONTRACT)
    origin_path = ('/opt/id-business-v2/.staging/component-hotfix-origin-'
                   + c.BASELINE_CONTRACT['hotfixReadbackInvocationBytesSha256'] + '/invocation.json')
    component_program = ''
    component_raw = component_predecessor_bytes(c)
    if component_raw is not None:
        component_path = '/opt/id-business-v2/.staging/component-published-origin-' + c.COMPONENT_PREDECESSOR['invocationBytesSha256'] + '/invocation.json'
        component_program = '\nwrite_workspace_private_bytes(' + repr(component_path) + ',' + repr(component_raw) + ')\n'
    restart_program = ''
    restart_raw = restart_origin_bytes(c)
    if restart_raw is not None:
        base = '/opt/id-business-v2/.staging/component-same-container-restart-origin-'
        folder = base + NATIVE_RESTART_AUTHORITY['invocationBytesSha256']
        restart_program = ('\nwrite_workspace_private_bytes(' + repr(folder + '/invocation.json')
            + ',' + repr(restart_raw[0]) + ')\nwrite_workspace_private_bytes('
            + repr(folder + '/command-list.json') + ',' + repr(restart_raw[1]) + ')\n')
    program = (inspect.getsource(original._store_files) + '\n_store_files(' + repr(directory) + ', '
        + repr(p['commit']) + ', ' + repr(pins) + ', False)\n'
        + 'import os,stat,base64\nfrom pathlib import Path\n'
        + inspect.getsource(original.write_workspace_private_bytes)
        + '\nwrite_workspace_private_bytes(' + repr(origin_path) + ',' + repr(raw_origin) + ')\n'
        + component_program
        + restart_program
        + input_program
        + 'import sys,runpy\nsys.argv=[' + repr(directory + '/unpublished-component-successor.py') + ']+ '
        + repr(args) + payload_args + '\nrunpy.run_path(sys.argv[0],run_name="__main__")\n')
    packed = base64.b64encode(gzip.compress(program.encode(), mtime=0)).decode()
    # The program carries compressed proof bytes, never an unbounded shell argv.
    carrier = ('import base64,gzip;exec(compile(gzip.decompress(base64.b64decode('
               + repr(packed) + ',validate=True)),"<finite-component-transport>","exec"))')
    result = {'commands': ['python3 -B -c ' + shlex.quote(carrier)],
              'executionTimeout': ['3600' if mode == 'release' else '600']}
    need(len(json.dumps(result).encode()) < 20 * 1024, 'TRANSPORT_PARAMETERS_TOO_LARGE')
    return result


def chunk_parameters(p, plan, chunk, index):
    need(type(index) is int and 0 <= index < len(plan['chunks']) and type(chunk) is bytes
         and 0 < len(chunk) <= INPUT_CHUNK_BYTES and plan['producer'] == p
         and len(chunk) == plan['chunks'][index]['size'] and digest(chunk) == plan['chunks'][index]['sha256'],
         'INPUT_CHUNK_CHANGED')
    original = load('api-admin-readonly.py')
    path = input_directory(plan) / ('part-' + str(index).zfill(3) + '.bin')
    receipt = {'scope': INPUT_SCOPE, 'status': 'INPUT_CHUNK_INSTALLED', 'producer': p,
        'bundleSha256': plan['bundleSha256'], 'index': index, 'sha256': digest(chunk),
        'size': len(chunk), 'businessActions': 0}
    program = ('import os,stat,json\nfrom pathlib import Path\n'
        + inspect.getsource(original.write_workspace_private_bytes)
        + '\nwrite_workspace_private_bytes(' + repr(str(path)) + ',' + repr(chunk) + ')\n'
        + 'print(json.dumps(' + repr(receipt) + ',sort_keys=True,separators=(",",":")))\n')
    packed = base64.b64encode(gzip.compress(program.encode(), mtime=0)).decode()
    carrier = ('import base64,gzip;exec(compile(gzip.decompress(base64.b64decode('
        + repr(packed) + ',validate=True)),"<finite-input-chunk>","exec"))')
    result = {'commands': ['python3 -B -c ' + shlex.quote(carrier)], 'executionTimeout': ['120']}
    need(len(json.dumps(result).encode()) < 20 * 1024, 'INPUT_CHUNK_PARAMETERS_TOO_LARGE')
    return result, receipt


def install_input_bundle(c, p, plan, chunks):
    """Each technical write has its own intent and immutable native receipt."""
    need(plan['producer'] == p and len(chunks) == len(plan['chunks']), 'INPUT_BUNDLE_CHANGED')
    folder = Path('.deploy/production-release').resolve()
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    aws = ['aws', '--region', REGION, 'ssm']
    for index, chunk in enumerate(chunks):
        params, expected = chunk_parameters(p, plan, chunk, index)
        name = c.PREFIX + '-input-' + plan['bundleSha256'] + '-' + str(index).zfill(3)
        metadata_path, intent_path = folder / (name + '-metadata.json'), folder / (name + '-intent.json')
        binding = {'producer': p, 'bundleSha256': plan['bundleSha256'], 'index': index,
                   'sha256': digest(chunk), 'instanceId': INSTANCE}
        if metadata_path.exists() or metadata_path.is_symlink():
            metadata = c.closed_json(c.private_bytes(metadata_path))
            need(set(metadata) == set(binding) | {'commandId', 'status'} and metadata['status'] == 'ACCEPTED'
                 and all(metadata[k] == v for k, v in binding.items()), 'INPUT_ACCEPTED_COMMAND_CHANGED')
            command_id = metadata['commandId']
        else:
            need(not intent_path.exists() and not intent_path.is_symlink(), 'INPUT_SEND_RESULT_UNKNOWN_RECONCILIATION_REQUIRED')
            c.write_private(intent_path, {**binding, 'status': 'SEND_INTENT_RECORDED', 'parametersSha256': c.fingerprint(params)})
            command_id = command_raw(*aws, 'send-command', '--instance-ids', INSTANCE,
                '--document-name', 'AWS-RunShellScript', '--parameters', json.dumps(params), '--timeout-seconds', '180',
                '--comment', 'ID immutable component input chunk', '--query', 'Command.CommandId', '--output', 'text').decode().strip()
            need(re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', command_id or '') is not None,
                 'INPUT_COMMAND_INVALID')
            metadata = {**binding, 'commandId': command_id, 'status': 'ACCEPTED'}
            c.write_private(metadata_path, metadata)
        need(type(command_id) is str and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', command_id), 'INPUT_COMMAND_INVALID')
        deadline = time.monotonic() + 200
        while time.monotonic() < deadline:
            raw = command_raw(*aws, 'get-command-invocation', '--command-id', command_id,
                              '--instance-id', INSTANCE, '--output', 'json', optional=True)
            if raw is None:
                time.sleep(2); continue
            provisional = c.closed_json(raw, 128 * 1024)
            if provisional.get('Status') in ('Pending', 'InProgress', 'Delayed'):
                time.sleep(2); continue
            invocation, receipt = c.validate_invocation(raw, command_id, INSTANCE)
            need(invocation['Status'] == 'Success' and receipt == expected and set(receipt) == set(expected)
                 and all(type(receipt[n]) is int for n in ('index', 'size', 'businessActions')), 'INPUT_RECEIPT_CHANGED')
            write_once(c, folder / (name + '-receipt.json'),
                {**metadata, 'invocationBytesSha256': digest(raw), 'receipt': receipt})
            break
        else:
            raise RuntimeError('UNPUBLISHED_COMPONENT_INPUT_ACCEPTED_RESULT_PENDING')


def transport(mode):
    c, p = selected(mode)
    aws = ['aws', '--region', REGION, 'ssm']
    folder = Path('.deploy/production-release').resolve()
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    metadata_path = folder / (c.PREFIX + '-' + mode + '-invocation-metadata.json')
    intent_path = folder / (c.PREFIX + '-' + mode + '-send-intent.json')
    if metadata_path.exists() or metadata_path.is_symlink():
        metadata = c.closed_json(c.private_bytes(metadata_path))
        need(set(metadata) == {'commandId', 'instanceId', 'mode', 'status', 'producer'}
             and metadata['instanceId'] == INSTANCE and metadata['mode'] == mode
             and metadata['producer'] == p and metadata['status'] == 'ACCEPTED', 'ACCEPTED_COMMAND_CHANGED')
        command_id = metadata['commandId']
    else:
        need(not intent_path.exists() and not intent_path.is_symlink(),
             'SEND_RESULT_UNKNOWN_RECONCILIATION_REQUIRED')
        inputs = None
        if mode == 'release':
            inputs = (c.private_bytes(Path(c.PROOF).resolve(), cap=128 * 1024),
                      c.private_bytes(Path(c.PREFLIGHT).resolve(), cap=24576))
        params = parameters(mode, input_artifacts=inputs)
        if inputs is not None:
            plan, chunks = input_bundle(p, *inputs)
            install_input_bundle(c, p, plan, chunks)
            verify_main_head(p)
        # AWS SendCommand has no caller-provided idempotency key. Persist intent
        # first; a lost accepted response must never turn into a second send.
        c.write_private(intent_path, {'producer': p, 'mode': mode, 'instanceId': INSTANCE,
            'parametersSha256': c.fingerprint(params), 'status': 'SEND_INTENT_RECORDED'})
        command_id = command_raw(*aws, 'send-command', '--instance-ids', INSTANCE,
            '--document-name', 'AWS-RunShellScript', '--parameters', json.dumps(params),
            '--timeout-seconds', '3600' if mode == 'release' else '600',
            '--comment', 'ID finite unpublished components ' + mode,
            '--query', 'Command.CommandId', '--output', 'text').decode().strip()
        metadata = {'commandId': command_id, 'instanceId': INSTANCE, 'mode': mode,
                    'status': 'ACCEPTED', 'producer': p}
        c.write_private(metadata_path, metadata)
    need(type(command_id) is str
         and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', command_id) is not None,
         'TRANSPORT_COMMAND_INVALID')
    # Keep the accepted command identity before waiting. A resumed operator can
    # query this exact command instead of launching a second production job.
    deadline = time.monotonic() + (3700 if mode == 'release' else 660)
    while time.monotonic() < deadline:
        time.sleep(5)
        raw = command_raw(*aws, 'get-command-invocation', '--command-id', command_id,
                         '--instance-id', INSTANCE, '--output', 'json', optional=True)
        if raw is None:
            continue
        provisional = c.closed_json(raw, 128 * 1024)
        if provisional.get('Status') in ('Pending', 'InProgress', 'Delayed'):
            continue
        if provisional.get('Status') != 'Success':
            code = 'UNPUBLISHED_COMPONENT_REMOTE_FAILED'
            try:
                failure = c.closed_json(provisional.get('StandardOutputContent', '').encode(), 24000)
                if re.fullmatch('UNPUBLISHED_COMPONENT_[A-Z0-9_]+', failure.get('code', '')):
                    code = failure['code']
            except Exception:
                pass
            write_once(c, folder / (c.PREFIX + '-' + mode + '-failure.json'),
                {**metadata, 'status': provisional.get('Status'), 'responseCode': provisional.get('ResponseCode'), 'code': code})
            raise RuntimeError(code)
        invocation, receipt = c.validate_invocation(raw, command_id, INSTANCE)
        if mode == 'preflight':
            result = c.make_transport(raw, command_id, INSTANCE)
            c.local_preflight(result, p)
            write_once(c, Path(c.PREFLIGHT).resolve(), result)
        else:
            expected = 'UNPUBLISHED_COMPONENT_VERIFIED'
            need(receipt.get('scope') == c.SCOPE and receipt.get('status') == expected
                 and receipt.get('commit') == p['commit'] and receipt.get('sourceTree') == p['sourceTree']
                 and receipt.get('onlinePublished') is False
                 and type(receipt.get('businessActions')) is int and receipt['businessActions'] == 0,
                 'TRANSPORT_RECEIPT_CHANGED')
            result = {'commandId': command_id, 'instanceId': INSTANCE, 'status': invocation['Status'],
                      'invocationBytesSha256': digest(raw), 'receipt': receipt}
            write_once(c, folder / (c.PREFIX + '-' + mode + '.json'), result)
        print(json.dumps({'commandId': command_id, 'status': receipt['status'], 'commit': p['commit']}, sort_keys=True))
        return result
    raise RuntimeError('UNPUBLISHED_COMPONENT_ACCEPTED_COMMAND_RESULT_PENDING')


def verify_main_head(p):
    raw = command_raw('git', 'ls-remote', 'origin', 'refs/heads/main')
    need(type(raw) is bytes and raw.decode('ascii').strip() == p['commit'] + '\trefs/heads/main',
         'STALE_MAIN_FORMAL_SEND_FORBIDDEN')


def write_once(c, path, value):
    if path.exists() or path.is_symlink():
        need(c.closed_json(c.private_bytes(path)) == value, 'SAVED_RECEIPT_CHANGED')
    else:
        c.write_private(path, value)


if __name__ == '__main__':
    try:
        need(len(sys.argv) == 2, 'SELECTION_INVALID')
        transport(sys.argv[1])
    except Exception as error:
        code = str(error) if re.fullmatch('UNPUBLISHED_COMPONENT_[A-Z0-9_]+', str(error)) else 'UNPUBLISHED_COMPONENT_TRANSPORT_UNAVAILABLE'
        print(json.dumps({'scope': 'UNPUBLISHED_COMPONENT_TRANSPORT', 'status': 'FAILED', 'code': code}))
        raise SystemExit(1) from None
