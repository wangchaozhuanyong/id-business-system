#!/usr/bin/env python3
"""Fixed-source declaration measurement adapter; inventory never authorizes release.

All Docker/Compose calls use the existing controller's output-suppressing `run`.
No import side effects, database access, network service, or deployment action.
Production generator/schema/default-pool sources must be independently reviewed
and frozen in this module before `measure` can create a stopped reference.
"""
import copy
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import stat

BASELINE = '0a03fa28e6b844a18833d5c63f1de700f091fc64'
COMPOSE_BLOB_SHA256 = '953c6264f157b00218f2a019d5e2c0b6bc4a34f687f2ec42ad782e0009e7672c'
KIND = 'ONLINE_RECHARGE_GENERATOR_SOURCE_INVENTORY'
NETWORK_ROLES = ('default', 'media-egress', 'recharge-control', 'registration-control')
SERVICES = ('media-resolver', 'auto-recharge', 'auto-registration', 'api', 'admin', 'mysql', 'caddy')
IDENTITY_KEYS = frozenset(('image', 'reference', 'status', 'health', 'containerId',
                           'startedAtSha256', 'environmentSha256', 'configurationSha256'))
FILES = ('docker-compose.aws-mysql.yml', 'compose.release.json', '.env.aws.production')
API_FIELDS = frozenset(('build', 'cap_drop', 'depends_on', 'environment', 'healthcheck', 'init',
                       'logging', 'networks', 'read_only', 'restart', 'security_opt', 'tmpfs',
                       'volumes', 'image', 'pull_policy', 'labels', 'command', 'entrypoint'))
POOL_KEYS = frozenset(('Base', 'Size'))
NETWORK_FIELDS = frozenset(('Name', 'Id', 'Created', 'Scope', 'Driver', 'EnableIPv4', 'EnableIPv6',
    'IPAM', 'Internal', 'Attachable', 'Ingress', 'ConfigFrom', 'ConfigOnly', 'Containers', 'Options', 'Labels'))
VOLUME_FIELDS = frozenset(('CreatedAt', 'Driver', 'Labels', 'Mountpoint', 'Name', 'Options', 'Scope', 'Status'))
CODES = ('SOURCE_NOT_MEASURED', 'GENERATOR_UNAVAILABLE', 'CLI_SOURCE_NOT_MEASURED',
         'DEFAULT_POOLS_UNAVAILABLE', 'SOURCE_SHAPE_UNAVAILABLE', 'IMAGE_CACHE_UNAVAILABLE',
         'RESOURCE_SCHEMA_UNAVAILABLE', 'RESOURCE_PROPERTIES_UNAVAILABLE', 'ACTUAL_SHAPE_UNAVAILABLE',
         'RUNTIME_IDENTITY_UNAVAILABLE', 'RUNTIME_SOCKET_UNAVAILABLE', 'RUNTIME_TOOLS_UNAVAILABLE')
# Empty intentionally: no production Engine/Compose binary/schema/pool source has
# been measured and reviewed. Do not auto-register the LOCAL v5.4 fixture.
REVIEWED_GENERATORS = {}
VERSION = re.compile(r'[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\Z')
HEX = re.compile(r'[a-f0-9]{64}\Z')
DIGEST = re.compile(r'sha256:[a-f0-9]{64}\Z')
RESOURCE_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\Z')
INFO_FORMAT = ('{"id":{{json .ID}},"serverVersion":{{json .ServerVersion}},'
               '"defaultAddressPools":{{json .DefaultAddressPools}},'
               '"osType":{{json .OSType}},"architecture":{{json .Architecture}},'
               '"plugins":{{json .ClientInfo.Plugins}}}')
REPORT_KEYS = frozenset(('version', 'kind', 'status', 'authority', 'productionEligible',
    'measurementPerformed', 'proofConstructed', 'rawOutputSuppressed', 'generator',
    'daemonDefaultAddressPools', 'sourceShape', 'actualConfigurationShape', 'runtimeDaemonIdentity', 'runtimeDaemonSocket',
    'runtimeCollectionTools',
    'resources', 'cacheImage', 'codes'))
GENERATOR_KEYS = frozenset(('composeVersion', 'engineVersion', 'engineApiVersion', 'dockerCliVersion',
    'dockerCliSha256', 'composeCliSha256', 'daemonIdentitySha256', 'nativePlatform',
    'reviewedSourceStatus', 'engineGitCommit', 'dockerCliGitCommit', 'enginePackage', 'dockerCliPackage'))
SOURCE_KEYS = frozenset(('status', 'apiFieldNames', 'environmentKeyCount', 'declaredNetworkCount',
    'mountTypeCounts', 'schemaSha256', 'representation'))
RESOURCE_KEYS = frozenset(('status', 'connectedNetworkCount', 'namedVolumeCount',
    'networkSchemaSha256', 'volumeSchemaSha256', 'propertiesSha256',
    'unknownNetworkFieldCount', 'unknownVolumeFieldCount', 'reviewedSchemaStatus'))
CACHE_KEYS = frozenset(('status', 'expectedImageIdSha256', 'observedImageIdSha256', 'referenceSha256'))
ACTUAL_SHAPE_KEYS = frozenset(('status', 'apiCreatorVersion', 'networkCreatorVersions', 'volumeCreatorVersion',
    'bindsEncoding', 'bindsCount', 'mountsEncoding', 'mountsCount', 'hostMountFieldNames', 'hostMountUnknownFieldCount'))
HOST_MOUNT_FIELDS = frozenset(('Type', 'Source', 'Target', 'ReadOnly', 'Consistency', 'BindOptions',
                              'VolumeOptions', 'TmpfsOptions'))
DAEMON_IDENTITY_SOURCE_SHA256 = '32d4b45c936685ffc46a876007796027bb8f9ef7f5ac43ca8b243c05c9b23b4f'
DAEMON_SOCKET_SOURCE_SHA256 = '601d62d10e84c5dc82f591aa4f694ff68b236977002eb780eed2b3d5b9dc1d85'


class Rejected(RuntimeError):
    """Only fixed, non-sensitive codes escape this module."""


def check(condition, code):
    if not condition:
        raise Rejected(code)


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def sha(value):
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def unique_json(raw, limit=16 * 1024**2):
    check(isinstance(raw, str) and 0 < len(raw.encode()) <= limit, 'INPUT_INVALID')
    def pairs(rows):
        out = {}
        for key, value in rows:
            check(key not in out, 'INPUT_INVALID')
            out[key] = value
        return out
    try:
        return json.loads(raw, object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(Rejected('INPUT_INVALID')))
    except (ValueError, TypeError, RecursionError):
        raise Rejected('INPUT_INVALID') from None


def read(d, *args, env=None, limit=16 * 1024**2):
    return unique_json(d.run(*args, timeout=30, **({'env': env} if env is not None else {})), limit)


def one(d, *args):
    rows = read(d, *args)
    check(isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict), 'INPUT_INVALID')
    return rows[0]


def clean_source_environment(directory):
    names = set()
    for name in FILES[:2]:
        path = directory / name
        check(path.is_file() and not path.is_symlink() and path.stat().st_size <= 1024**2, 'INPUT_INVALID')
        names.update(re.findall(r'\$\{([A-Za-z_][A-Za-z0-9_]*)', path.read_text()))
    return {key: value for key, value in os.environ.items()
            if key not in names and not key.startswith('COMPOSE_')}


def render_source(d, directory):
    # Keep complete build and paths. Never use the scope's recursively normalized renderer.
    environment = clean_source_environment(directory)
    return read(d, 'docker', 'compose', '--env-file', str(directory / FILES[2]),
                '-f', str(directory / FILES[0]), '-f', str(directory / FILES[1]),
                'config', '--format', 'json', env=environment)


def source_shape(model):
    check(isinstance(model, dict) and isinstance(model.get('services'), dict), 'INPUT_INVALID')
    api = model['services'].get('api')
    check(isinstance(api, dict) and set(api) <= API_FIELDS and isinstance(api.get('environment'), dict)
          and all(isinstance(v, str) for v in api['environment'].values()), 'INPUT_INVALID')
    # Fixed 0a source declares neither command nor entrypoint. compose-go v2.14
    # intentionally emits null for both in JSON; [] means clearing image defaults
    # and must remain a different, rejected source. Keep the full rendered fields.
    check(all(api.get(key) is None for key in ('command', 'entrypoint')), 'INPUT_INVALID')
    networks = api.get('networks')
    check(isinstance(networks, dict) and set(networks) == set(NETWORK_ROLES), 'INPUT_INVALID')
    mounts = api.get('volumes')
    check(isinstance(mounts, list) and all(isinstance(m, dict) and m.get('type') in ('volume', 'bind')
          for m in mounts), 'INPUT_INVALID')
    dependencies = api.get('depends_on', {})
    check(isinstance(dependencies, dict) and set(dependencies) <= {'migrate', 'media-resolver'}
          and all(isinstance(row, dict) and set(row) <= {'condition', 'required', 'restart'}
                  for row in dependencies.values())
          and all(row is None or isinstance(row, dict) and set(row) <= {'priority'}
                  for row in networks.values())
          and all(set(row) <= {'type', 'source', 'target', 'read_only', 'volume', 'bind', 'consistency'}
                  for row in mounts), 'INPUT_INVALID')
    representation = {'dependencyFieldNames': {key: sorted(row) for key, row in sorted(dependencies.items())},
        'networkEntryFieldNames': {key: sorted(row or {}) for key, row in sorted(networks.items())},
        'volumeFieldNames': [sorted(row) for row in mounts]}
    schema = {key: type(value).__name__ for key, value in api.items()}
    return {'status': 'OBSERVED', 'apiFieldNames': sorted(api), 'environmentKeyCount': len(api['environment']),
            'declaredNetworkCount': len(networks), 'mountTypeCounts': {
                kind: sum(m['type'] == kind for m in mounts) for kind in ('volume', 'bind')},
            'schemaSha256': fingerprint(schema), 'representation': representation}


def native_package(d, path, expected_name):
    """Installed RPM identity only; it does not prove the daemon executable.

    Literal paths and known package names, closed metadata, no RPM scripts or
    package installation. Unsupported/non-RPM hosts report unmeasured.
    """
    raw = d.run('rpm', '-qf', path, '--queryformat', '%{NAME}|%{VERSION}|%{RELEASE}|%{ARCH}', timeout=30)
    check(isinstance(raw, str) and 0 < len(raw) <= 256, 'INPUT_INVALID')
    rows = raw.split('|')
    check(len(rows) == 4 and rows[0] in expected_name and VERSION.fullmatch(rows[1])
          and re.fullmatch(r'[0-9][a-z0-9._]{0,95}', rows[2])
          and rows[3] in ('x86_64', 'aarch64'), 'INPUT_INVALID')
    return dict(zip(('name', 'version', 'release', 'architecture'), rows))


def binary_hash(path, name):
    """Only known native CLI locations; no arbitrary path supplied by inspect."""
    allowed = ({'/usr/bin/docker', '/usr/local/bin/docker'} if name == 'docker' else {
        '/usr/libexec/docker/cli-plugins/docker-compose', '/usr/lib/docker/cli-plugins/docker-compose',
        '/usr/local/lib/docker/cli-plugins/docker-compose', '/usr/local/libexec/docker/cli-plugins/docker-compose'})
    check(isinstance(path, str) and path in allowed, 'SOURCE_NOT_MEASURED')
    file = Path(path)
    check(file.is_file() and not file.is_symlink() and file.stat().st_size <= 128 * 1024**2,
          'SOURCE_NOT_MEASURED')
    with file.open('rb') as stream:
        check(stream.read(4) == b'\x7fELF', 'SOURCE_NOT_MEASURED')
        stream.seek(0)
        value = hashlib.sha256()
        for block in iter(lambda: stream.read(1024**2), b''):
            value.update(block)
    return value.hexdigest()


def pools_statement(rows):
    # Moby 25 leaves this slice nil when no custom pools are configured; the
    # Docker info JSON template emits null. This observes an absent custom
    # declaration only, never the effective builtin pool or source approval.
    raw_rows = rows
    if rows is None:
        rows = []
    check(isinstance(rows, list) and len(rows) <= 32, 'INPUT_INVALID')
    pools = []
    for row in rows:
        check(isinstance(row, dict) and set(row) == POOL_KEYS and type(row['Size']) is int,
              'INPUT_INVALID')
        try:
            network = ipaddress.ip_network(row['Base'], strict=True)
        except (ValueError, TypeError):
            raise Rejected('INPUT_INVALID') from None
        check(network.version == 4 and network.prefixlen <= row['Size'] <= 30, 'INPUT_INVALID')
        pools.append({'base': str(network), 'size': row['Size']})
    check(len({(r['base'], r['size']) for r in pools}) == len(pools), 'INPUT_INVALID')
    return {'status': 'DECLARED' if pools else 'UNDECLARED', 'pools': pools,
            'reviewedRulesStatus': 'SOURCE_NOT_MEASURED',
            'sourceEncoding': 'NULL' if raw_rows is None else 'ARRAY',
            'sourceValueSha256': fingerprint(raw_rows)}


def schema_summary(value, known):
    return {'knownFields': {key: type(value[key]).__name__ for key in sorted(set(value) & known)},
            'unknownFieldCount': len(set(value) - known)}


def daemon_identity_capability():
    path = Path(__file__).with_name('online-recharge-daemon-identity.py')
    check(path.is_file() and not path.is_symlink(), 'SOURCE_NOT_MEASURED')
    source = path.read_bytes()
    check(sha(source) == DAEMON_IDENTITY_SOURCE_SHA256,
          'SOURCE_NOT_MEASURED')
    module_spec = importlib.util.spec_from_file_location('_fixed_dockerd_runtime_identity', path)
    module = importlib.util.module_from_spec(module_spec)
    exec(compile(source, str(path), 'exec'), module.__dict__)
    return module


def daemon_socket_capability():
    path = Path(__file__).with_name('online-recharge-daemon-socket.py')
    check(path.is_file() and not path.is_symlink(), 'SOURCE_NOT_MEASURED')
    source = path.read_bytes()
    check(sha(source) == DAEMON_SOCKET_SOURCE_SHA256, 'SOURCE_NOT_MEASURED')
    module_spec = importlib.util.spec_from_file_location('_fixed_dockerd_socket_binding', path)
    module = importlib.util.module_from_spec(module_spec)
    exec(compile(source, str(path), 'exec'), module.__dict__)
    return module


def actual_configuration_shape(host, labels, networks, volumes):
    """Safe representation only; full Config/HostConfig remains mandatory for equivalence.

    Values, mount sources, arbitrary labels and unknown field names never escape.
    This cannot replace a complete inspect or qualify a generator.
    """
    check(type(host) is dict and type(labels) is dict and len(networks) == 4 and len(volumes) == 1,
          'INPUT_INVALID')
    def creator(value):
        check(type(value) is dict, 'INPUT_INVALID')
        version = value.get('com.docker.compose.version')
        check(type(version) is str and VERSION.fullmatch(version), 'INPUT_INVALID')
        return version
    def encoding(name):
        value = host.get(name)
        if name not in host:
            return 'ABSENT', None, []
        if value is None:
            return 'NULL', None, []
        check(type(value) is list and len(value) <= 8, 'INPUT_INVALID')
        if name == 'Binds':
            check(all(type(row) is str and len(row) <= 2048 for row in value), 'INPUT_INVALID')
        else:
            check(all(type(row) is dict for row in value), 'INPUT_INVALID')
        return 'ARRAY', len(value), value
    binds_encoding, binds_count, _binds = encoding('Binds')
    mounts_encoding, mounts_count, mounts = encoding('Mounts')
    return {'status': 'OBSERVED', 'apiCreatorVersion': creator(labels),
        'networkCreatorVersions': sorted({creator(row.get('Labels')) for row in networks}),
        'volumeCreatorVersion': creator(volumes[0].get('Labels')),
        'bindsEncoding': binds_encoding, 'bindsCount': binds_count,
        'mountsEncoding': mounts_encoding, 'mountsCount': mounts_count,
        'hostMountFieldNames': [sorted(set(row) & HOST_MOUNT_FIELDS) for row in mounts],
        'hostMountUnknownFieldCount': sum(len(set(row) - HOST_MOUNT_FIELDS) for row in mounts)}


def validate_services(services):
    check(isinstance(services, dict) and set(services) == set(SERVICES), 'INPUT_INVALID')
    for name, row in services.items():
        check(isinstance(row, dict) and set(row) == IDENTITY_KEYS and row['status'] == 'running'
              and row['health'] in ((None, 'healthy') if name == 'caddy' else ('healthy',))
              and DIGEST.fullmatch(row['image'] or '') and HEX.fullmatch(row['containerId'] or '')
              and isinstance(row['reference'], str) and 0 < len(row['reference']) <= 512
              and all(HEX.fullmatch(row[k] or '') for k in ('startedAtSha256', 'environmentSha256', 'configurationSha256')),
              'INPUT_INVALID')


def inventory(d, directory, *, services, image_reference, image_id):
    """Read-only version/pool/resource source inventory. No actual Config.Env read.

    Controller binds directory/files/images/seven-service identities externally.
    Values containing Env never leave `render_source`; only schema/counts escape.
    No reference resources, proof, approval or eligibility are constructed.
    """
    validate_services(services)
    directory = Path(directory)
    check(directory.is_absolute() and directory.resolve() == directory and directory.is_dir(), 'INPUT_INVALID')
    check(image_reference == services['api']['reference'] and image_id == services['api']['image'], 'INPUT_INVALID')
    report = {'version': 1, 'kind': KIND, 'status': 'SOURCE_NOT_MEASURED', 'authority': False,
        'productionEligible': False, 'measurementPerformed': False, 'proofConstructed': False,
        'rawOutputSuppressed': True, 'generator': {key: None for key in GENERATOR_KEYS},
        'daemonDefaultAddressPools': {'status': 'UNAVAILABLE', 'pools': [], 'reviewedRulesStatus': 'SOURCE_NOT_MEASURED',
                                     'sourceEncoding': None, 'sourceValueSha256': None},
        'sourceShape': {'status': 'NOT_MEASURED', 'apiFieldNames': [], 'environmentKeyCount': None,
                       'declaredNetworkCount': None, 'mountTypeCounts': None, 'schemaSha256': None,
                       'representation': None},
        'actualConfigurationShape': {key: ('NOT_MEASURED' if key == 'status' else None)
                                     for key in ACTUAL_SHAPE_KEYS},
        'runtimeDaemonIdentity': {'status': 'NOT_MEASURED', 'report': None},
        'runtimeDaemonSocket': {'status': 'NOT_MEASURED', 'report': None},
        'runtimeCollectionTools': {'status': 'NOT_MEASURED', 'bytesSha256': None, 'identitySha256': None},
        'resources': {'status': 'NOT_MEASURED', 'connectedNetworkCount': None, 'namedVolumeCount': None,
            'networkSchemaSha256': None, 'volumeSchemaSha256': None, 'propertiesSha256': None,
            'unknownNetworkFieldCount': None, 'unknownVolumeFieldCount': None, 'reviewedSchemaStatus': 'SOURCE_NOT_MEASURED'},
        'cacheImage': {'status': 'NOT_MEASURED', 'expectedImageIdSha256': sha(image_id),
                       'observedImageIdSha256': None, 'referenceSha256': sha(image_reference)}, 'codes': []}
    report['generator']['reviewedSourceStatus'] = 'SOURCE_NOT_MEASURED'
    codes = {'SOURCE_NOT_MEASURED'}
    try:
        identity = daemon_identity_capability()
        runtime = identity.runtime_daemon_identity(d)
        identity.validate_runtime_identity(runtime)
        report['runtimeDaemonIdentity'] = {'status': 'OBSERVED', 'report': runtime}
    except Exception:
        codes.add('RUNTIME_IDENTITY_UNAVAILABLE')
    try:
        check(report['runtimeDaemonIdentity']['status'] == 'OBSERVED', 'SOURCE_NOT_MEASURED')
        reader = identity._reader_factory()
        tools = {}
        for path in ('/usr/bin/systemctl', '/usr/bin/rpm'):
            raw, node = reader.read(path, 128 * 1024**2, executable=True)
            tools[path] = {'bytesSha256': sha(raw), 'identity': node}
        tools_sha = fingerprint(tools)
        check(tools_sha == runtime['runtime']['collectionToolsSha256'], 'SOURCE_NOT_MEASURED')
        report['runtimeCollectionTools'] = {'status': 'OBSERVED',
            'bytesSha256': {path: row['bytesSha256'] for path, row in tools.items()},
            'identitySha256': tools_sha}
    except Exception:
        codes.add('RUNTIME_TOOLS_UNAVAILABLE')
    try:
        check(report['runtimeDaemonIdentity']['status'] == 'OBSERVED', 'SOURCE_NOT_MEASURED')
        socket = daemon_socket_capability()
        binding = socket.runtime_daemon_socket_binding(d)
        socket.validate_binding(binding)
        check(binding['listenerBinding']['runtimeIdentity'] == report['runtimeDaemonIdentity']['report'], 'SOURCE_NOT_MEASURED')
        report['runtimeDaemonSocket'] = {'status': 'OBSERVED', 'report': binding}
    except Exception:
        codes.add('RUNTIME_SOCKET_UNAVAILABLE')
    try:
        info = read(d, 'docker', 'info', '--format', INFO_FORMAT, limit=128 * 1024)
        version = read(d, 'docker', 'version', '--format', '{{json .}}', limit=128 * 1024)
        compose = d.run('docker', 'compose', 'version', '--short', timeout=30).strip().removeprefix('v')
        check(VERSION.fullmatch(compose) and isinstance(info.get('id'), str) and 0 < len(info['id']) <= 256,
              'INPUT_INVALID')
        server, client = version['Server'], version['Client']
        check(VERSION.fullmatch(server['Version']) and VERSION.fullmatch(client['Version'])
              and re.fullmatch(r'[0-9]{1,2}\.[0-9]{1,2}', server['ApiVersion'])
              and info['serverVersion'] == server['Version'], 'INPUT_INVALID')
        platform = info['osType'] + '/' + info['architecture']
        check(platform in ('linux/x86_64', 'linux/amd64', 'linux/aarch64', 'linux/arm64'), 'INPUT_INVALID')
        report['generator'].update({'composeVersion': compose, 'engineVersion': server['Version'],
            'engineApiVersion': server['ApiVersion'], 'dockerCliVersion': client['Version'],
            'daemonIdentitySha256': sha(info['id']), 'nativePlatform': platform})
        for output, branch in (('engineGitCommit', server), ('dockerCliGitCommit', client)):
            value = branch.get('GitCommit')
            if isinstance(value, str) and re.fullmatch(r'[a-f0-9]{7,40}', value):
                report['generator'][output] = value
        for output, path, names in (('enginePackage', '/usr/bin/dockerd', ('docker', 'moby-engine')),
                                    ('dockerCliPackage', '/usr/bin/docker', ('docker', 'docker-cli', 'moby-cli'))):
            try:
                report['generator'][output] = native_package(d, path, names)
            except Exception:
                pass
        try:
            report['daemonDefaultAddressPools'] = pools_statement(info['defaultAddressPools'])
        except Exception:
            codes.add('DEFAULT_POOLS_UNAVAILABLE')
        try:
            plugins = info['plugins']
            check(isinstance(plugins, list), 'INPUT_INVALID')
            paths = [p['Path'] for p in plugins if isinstance(p, dict) and p.get('Name') == 'compose']
            check(len(paths) == 1, 'INPUT_INVALID')
            report['generator']['dockerCliSha256'] = binary_hash(shutil.which('docker'), 'docker')
            report['generator']['composeCliSha256'] = binary_hash(paths[0], 'compose')
        except Exception:
            codes.add('CLI_SOURCE_NOT_MEASURED')
    except Exception:
        codes.add('GENERATOR_UNAVAILABLE')
    try:
        report['sourceShape'] = source_shape(render_source(d, directory))
    except Exception:
        codes.add('SOURCE_SHAPE_UNAVAILABLE')
    try:
        observed = read(d, 'docker', 'image', 'inspect', '--format', '{{json .Id}}', image_reference, limit=1024)
        check(isinstance(observed, str) and DIGEST.fullmatch(observed), 'INPUT_INVALID')
        report['cacheImage'].update({'status': 'MATCH' if observed == image_id else 'MISMATCH',
                                    'observedImageIdSha256': sha(observed)})
    except Exception:
        codes.add('IMAGE_CACHE_UNAVAILABLE')
    try:
        cid = services['api']['containerId']
        networks = read(d, 'docker', 'inspect', '--format', '{{json .NetworkSettings.Networks}}', cid)
        mounts = read(d, 'docker', 'inspect', '--format', '{{json .Mounts}}', cid)
        check(isinstance(networks, dict) and len(networks) <= 8 and isinstance(mounts, list) and len(mounts) <= 8,
              'INPUT_INVALID')
        nets, volumes = [], []
        for name, endpoint in networks.items():
            check(isinstance(name, str) and RESOURCE_NAME.fullmatch(name) and isinstance(endpoint, dict)
                  and HEX.fullmatch(endpoint.get('NetworkID', '')), 'INPUT_INVALID')
            net = one(d, 'docker', 'network', 'inspect', endpoint['NetworkID'])
            check(net.get('Id') == endpoint['NetworkID'] and net.get('Name') == name, 'INPUT_INVALID')
            nets.append(net)
        for mount in mounts:
            check(isinstance(mount, dict), 'INPUT_INVALID')
            if mount.get('Type') == 'volume':
                name = mount.get('Name')
                check(isinstance(name, str) and RESOURCE_NAME.fullmatch(name), 'INPUT_INVALID')
                vol = one(d, 'docker', 'volume', 'inspect', name)
                check(vol.get('Name') == name and vol.get('Mountpoint') == mount.get('Source'), 'INPUT_INVALID')
                volumes.append(vol)
        net_schemas = [schema_summary(n, NETWORK_FIELDS) for n in nets]
        vol_schemas = [schema_summary(v, VOLUME_FIELDS) for v in volumes]
        properties = {'networks': [{key: row.get(key) for key in ('Driver', 'Scope', 'Internal', 'EnableIPv4',
                        'EnableIPv6', 'Attachable', 'Ingress', 'ConfigOnly', 'ConfigFrom', 'Options', 'IPAM')} for row in nets],
                      'volumes': [{key: row.get(key) for key in ('Driver', 'Scope', 'Options')} for row in volumes]}
        report['resources'].update({'status': 'OBSERVED', 'connectedNetworkCount': len(nets), 'namedVolumeCount': len(volumes),
            'networkSchemaSha256': fingerprint(net_schemas), 'volumeSchemaSha256': fingerprint(vol_schemas),
            'propertiesSha256': fingerprint(properties),
            'unknownNetworkFieldCount': sum(r['unknownFieldCount'] for r in net_schemas),
            'unknownVolumeFieldCount': sum(r['unknownFieldCount'] for r in vol_schemas)})
        try:
            host = read(d, 'docker', 'inspect', '--format', '{{json .HostConfig}}', cid)
            labels = read(d, 'docker', 'inspect', '--format', '{{json .Config.Labels}}', cid)
            report['actualConfigurationShape'] = actual_configuration_shape(host, labels, nets, volumes)
        except Exception:
            codes.add('ACTUAL_SHAPE_UNAVAILABLE')
    except Exception:
        codes.add('RESOURCE_SCHEMA_UNAVAILABLE')
    report['codes'] = [code for code in CODES if code in codes]
    return validate_inventory(report)


def _validate_inventory(value):
    """Closed non-authoritative transport schema; malformed values never leak."""
    check(isinstance(value, dict) and set(value) == REPORT_KEYS and type(value['version']) is int
          and value['version'] == 1 and value['kind'] == KIND and value['status'] == 'SOURCE_NOT_MEASURED'
          and all(value[k] is False for k in ('authority', 'productionEligible', 'measurementPerformed', 'proofConstructed'))
          and value['rawOutputSuppressed'] is True, 'INVENTORY_INVALID')
    g, p, s, r, c = (value[k] for k in ('generator', 'daemonDefaultAddressPools', 'sourceShape', 'resources', 'cacheImage'))
    check(isinstance(g, dict) and set(g) == GENERATOR_KEYS and g['reviewedSourceStatus'] == 'SOURCE_NOT_MEASURED'
          and all(g[k] is None or isinstance(g[k], str) and VERSION.fullmatch(g[k]) for k in
                  ('composeVersion', 'engineVersion', 'dockerCliVersion'))
          and (g['engineApiVersion'] is None or isinstance(g['engineApiVersion'], str)
               and re.fullmatch(r'[0-9]{1,2}\.[0-9]{1,2}', g['engineApiVersion']))
          and all(g[k] is None or isinstance(g[k], str) and HEX.fullmatch(g[k]) for k in
                  ('dockerCliSha256', 'composeCliSha256', 'daemonIdentitySha256'))
          and g['nativePlatform'] in (None, 'linux/x86_64', 'linux/amd64', 'linux/aarch64', 'linux/arm64'), 'INVENTORY_INVALID')
    check(all(g[k] is None or isinstance(g[k], str) and re.fullmatch(r'[a-f0-9]{7,40}', g[k])
              for k in ('engineGitCommit', 'dockerCliGitCommit')), 'INVENTORY_INVALID')
    for key in ('enginePackage', 'dockerCliPackage'):
        row = g[key]
        check(row is None or isinstance(row, dict) and set(row) == {'name', 'version', 'release', 'architecture'}
              and row['name'] in (('docker', 'moby-engine') if key == 'enginePackage'
                                  else ('docker', 'docker-cli', 'moby-cli'))
              and isinstance(row['version'], str) and VERSION.fullmatch(row['version'])
              and isinstance(row['release'], str) and re.fullmatch(r'[0-9][a-z0-9._]{0,95}', row['release'])
              and row['architecture'] in ('x86_64', 'aarch64'), 'INVENTORY_INVALID')
    check(isinstance(p, dict) and set(p) == {'status', 'pools', 'reviewedRulesStatus', 'sourceEncoding', 'sourceValueSha256'}
          and p['status'] in ('DECLARED', 'UNDECLARED', 'UNAVAILABLE') and p['reviewedRulesStatus'] == 'SOURCE_NOT_MEASURED'
          and isinstance(p['pools'], list) and len(p['pools']) <= 32, 'INVENTORY_INVALID')
    normalized = pools_statement([{'Base': row.get('base'), 'Size': row.get('size')} for row in p['pools']
                                 if isinstance(row, dict) and set(row) == {'base', 'size'}])
    check(len(normalized['pools']) == len(p['pools']) and normalized['pools'] == p['pools']
          and (p['status'] == 'DECLARED') is bool(p['pools']), 'INVENTORY_INVALID')
    check((p['status'] == 'UNAVAILABLE' and p['sourceEncoding'] is None and p['sourceValueSha256'] is None)
          or (p['status'] != 'UNAVAILABLE' and p['sourceEncoding'] in ('NULL', 'ARRAY')
              and p['sourceValueSha256'] == (fingerprint(None) if p['sourceEncoding'] == 'NULL'
                                             else normalized['sourceValueSha256'])
              and (p['sourceEncoding'] != 'NULL' or p['status'] == 'UNDECLARED')),
          'INVENTORY_INVALID')
    check(isinstance(s, dict) and set(s) == SOURCE_KEYS and s['status'] in ('OBSERVED', 'NOT_MEASURED')
          and isinstance(s['apiFieldNames'], list) and s['apiFieldNames'] == sorted(set(s['apiFieldNames']))
          and set(s['apiFieldNames']) <= API_FIELDS, 'INVENTORY_INVALID')
    counts = [s['environmentKeyCount'], s['declaredNetworkCount'], *[r.get(k) for k in
              ('connectedNetworkCount', 'namedVolumeCount', 'unknownNetworkFieldCount', 'unknownVolumeFieldCount')]]
    check(all(v is None or type(v) is int and 0 <= v <= 4096 for v in counts), 'INVENTORY_INVALID')
    check(s['mountTypeCounts'] is None or isinstance(s['mountTypeCounts'], dict)
          and set(s['mountTypeCounts']) == {'volume', 'bind'}
          and all(type(v) is int and 0 <= v <= 8 for v in s['mountTypeCounts'].values()), 'INVENTORY_INVALID')
    check(isinstance(r, dict) and set(r) == RESOURCE_KEYS and r['status'] in ('OBSERVED', 'NOT_MEASURED')
          and r['reviewedSchemaStatus'] == 'SOURCE_NOT_MEASURED', 'INVENTORY_INVALID')
    check(all(v is None or isinstance(v, str) and HEX.fullmatch(v) for v in
              (s['schemaSha256'], r['networkSchemaSha256'], r['volumeSchemaSha256'], r['propertiesSha256'])), 'INVENTORY_INVALID')
    a = value['actualConfigurationShape']
    check(type(a) is dict and set(a) == ACTUAL_SHAPE_KEYS and a['status'] in ('OBSERVED', 'NOT_MEASURED'),
          'INVENTORY_INVALID')
    if a['status'] == 'NOT_MEASURED':
        check(all(a[key] is None for key in ACTUAL_SHAPE_KEYS - {'status'}), 'INVENTORY_INVALID')
    else:
        check(all(type(a[key]) is str and VERSION.fullmatch(a[key]) for key in
                  ('apiCreatorVersion', 'volumeCreatorVersion'))
              and type(a['networkCreatorVersions']) is list and 1 <= len(a['networkCreatorVersions']) <= 4
              and a['networkCreatorVersions'] == sorted(set(a['networkCreatorVersions']))
              and all(type(v) is str and VERSION.fullmatch(v) for v in a['networkCreatorVersions']),
              'INVENTORY_INVALID')
        for encoding_key, count_key in (('bindsEncoding', 'bindsCount'), ('mountsEncoding', 'mountsCount')):
            check(a[encoding_key] in ('ABSENT', 'NULL', 'ARRAY')
                  and ((a[encoding_key] == 'ARRAY' and type(a[count_key]) is int and 0 <= a[count_key] <= 8)
                       or (a[encoding_key] != 'ARRAY' and a[count_key] is None)), 'INVENTORY_INVALID')
        check(type(a['hostMountFieldNames']) is list
              and len(a['hostMountFieldNames']) == (a['mountsCount'] or 0)
              and all(type(row) is list and row == sorted(set(row)) and set(row) <= HOST_MOUNT_FIELDS
                      for row in a['hostMountFieldNames'])
              and type(a['hostMountUnknownFieldCount']) is int and 0 <= a['hostMountUnknownFieldCount'] <= 4096,
              'INVENTORY_INVALID')
    runtime = value['runtimeDaemonIdentity']
    check(type(runtime) is dict and set(runtime) == {'status', 'report'}
          and runtime['status'] in ('OBSERVED', 'NOT_MEASURED'), 'INVENTORY_INVALID')
    if runtime['status'] == 'NOT_MEASURED':
        check(runtime['report'] is None, 'INVENTORY_INVALID')
    else:
        daemon_identity_capability().validate_runtime_identity(runtime['report'])
    tools = value['runtimeCollectionTools']
    check(type(tools) is dict and set(tools) == {'status', 'bytesSha256', 'identitySha256'}
          and tools['status'] in ('OBSERVED', 'NOT_MEASURED'), 'INVENTORY_INVALID')
    if tools['status'] == 'NOT_MEASURED':
        check(tools['bytesSha256'] is None and tools['identitySha256'] is None, 'INVENTORY_INVALID')
    else:
        check(runtime['status'] == 'OBSERVED' and type(tools['bytesSha256']) is dict
              and set(tools['bytesSha256']) == {'/usr/bin/systemctl', '/usr/bin/rpm'}
              and all(type(v) is str and HEX.fullmatch(v) for v in tools['bytesSha256'].values())
              and type(tools['identitySha256']) is str and HEX.fullmatch(tools['identitySha256'])
              and tools['identitySha256'] == runtime['report']['runtime']['collectionToolsSha256'],
              'INVENTORY_INVALID')
    socket = value['runtimeDaemonSocket']
    check(type(socket) is dict and set(socket) == {'status', 'report'}
          and socket['status'] in ('OBSERVED', 'NOT_MEASURED'), 'INVENTORY_INVALID')
    if socket['status'] == 'NOT_MEASURED':
        check(socket['report'] is None, 'INVENTORY_INVALID')
    else:
        daemon_socket_capability().validate_binding(socket['report'])
        check(runtime['status'] == 'OBSERVED' and socket['report']['listenerBinding']['runtimeIdentity'] == runtime['report'],
              'INVENTORY_INVALID')
    check(isinstance(c, dict) and set(c) == CACHE_KEYS and c['status'] in ('MATCH', 'MISMATCH', 'NOT_MEASURED')
          and all(isinstance(c[k], str) and HEX.fullmatch(c[k]) for k in ('expectedImageIdSha256', 'referenceSha256'))
          and (c['observedImageIdSha256'] is None or isinstance(c['observedImageIdSha256'], str)
               and HEX.fullmatch(c['observedImageIdSha256']))
          and (c['status'] == 'NOT_MEASURED') is (c['observedImageIdSha256'] is None)
          and (c['status'] != 'MATCH' or c['expectedImageIdSha256'] == c['observedImageIdSha256'])
          and (c['status'] != 'MISMATCH' or c['expectedImageIdSha256'] != c['observedImageIdSha256']), 'INVENTORY_INVALID')
    if s['status'] == 'NOT_MEASURED':
        check(s['apiFieldNames'] == [] and all(s[k] is None for k in
              ('environmentKeyCount', 'declaredNetworkCount', 'mountTypeCounts', 'schemaSha256', 'representation')), 'INVENTORY_INVALID')
    else:
        check({'environment', 'networks', 'volumes'} <= set(s['apiFieldNames'])
              and s['environmentKeyCount'] is not None and s['declaredNetworkCount'] == 4
              and s['mountTypeCounts'] is not None and s['schemaSha256'] is not None, 'INVENTORY_INVALID')
        shape = s['representation']
        check(isinstance(shape, dict) and set(shape) == {'dependencyFieldNames', 'networkEntryFieldNames', 'volumeFieldNames'}
              and isinstance(shape['dependencyFieldNames'], dict)
              and set(shape['dependencyFieldNames']) <= {'migrate', 'media-resolver'}
              and isinstance(shape['networkEntryFieldNames'], dict)
              and set(shape['networkEntryFieldNames']) == set(NETWORK_ROLES)
              and isinstance(shape['volumeFieldNames'], list) and len(shape['volumeFieldNames']) <= 8,
              'INVENTORY_INVALID')
        for rows, allowed in ((shape['dependencyFieldNames'].values(), {'condition', 'required', 'restart'}),
                              (shape['networkEntryFieldNames'].values(), {'priority'}),
                              (shape['volumeFieldNames'], {'type', 'source', 'target', 'read_only', 'volume', 'bind', 'consistency'})):
            check(all(isinstance(row, list) and row == sorted(set(row)) and set(row) <= allowed
                      for row in rows), 'INVENTORY_INVALID')
    if r['status'] == 'NOT_MEASURED':
        check(all(r[k] is None for k in RESOURCE_KEYS - {'status', 'reviewedSchemaStatus'}), 'INVENTORY_INVALID')
    else:
        check(all(r[k] is not None for k in RESOURCE_KEYS - {'status', 'reviewedSchemaStatus'})
              and r['connectedNetworkCount'] <= 8 and r['namedVolumeCount'] <= 8, 'INVENTORY_INVALID')
    check(isinstance(value['codes'], list) and 'SOURCE_NOT_MEASURED' in value['codes']
          and value['codes'] == [code for code in CODES if code in value['codes']], 'INVENTORY_INVALID')
    return copy.deepcopy(value)


def validate_inventory(value):
    try:
        return _validate_inventory(value)
    except Exception:
        raise Rejected('INVENTORY_INVALID') from None


def measure(d, directory, *, services, image_reference, image_id, source_seal, stability_reader):
    """Formal entry: unknown generator source refuses before any create operation.

    The producer protocol/source-seal binding remains the calling controller's
    responsibility. No runtime-supplied generator policy can register a version.
    """
    report = inventory(d, directory, services=services, image_reference=image_reference, image_id=image_id)
    key = (report['generator']['engineVersion'], report['generator']['composeVersion'])
    check(key in REVIEWED_GENERATORS, 'SOURCE_NOT_MEASURED')
    return _measure_reviewed(d, directory, services=services, image_reference=image_reference,
        image_id=image_id, source_seal=source_seal, stability_reader=stability_reader,
        inventory_report=report, generator=REVIEWED_GENERATORS[key])


def _measure_reviewed(*args, **kwargs):
    # Orchestrator follows once read-only inventory transport has been integrated.
    raise Rejected('SOURCE_NOT_MEASURED')
