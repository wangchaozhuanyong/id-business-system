"""Finite, forward-only retirement of auto-registration over an exact live predecessor.

No migration, backup, row deletion, volume removal, payment, or automatic rollback.
Raw container configuration is compared only in memory; receipts contain hashes.
"""
import copy
import datetime
import fcntl
import hashlib
import importlib.util
import io
import json
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import tarfile
import urllib.request

BASE = Path('/opt/id-business-v2')
HERE = Path(__file__).resolve().parent
SCOPE = 'AUTO_REGISTRATION_RETIREMENT_20261018'
BEFORE = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge',
          'auto-registration', 'online-recharge')
AFTER = tuple(name for name in BEFORE if name != 'auto-registration')
PRESERVED = ('mysql', 'media-resolver', 'auto-recharge')
SUFFIXES = ('.js', '.js.map', '.d.ts')
LABEL = 'id-business-v2.feature-retirement-build-proof-sha256'
RETIRED_ROOTS = ('/app/apps/api/src/id-business-v2/auto-registration',
                 '/app/apps/api/dist/id-business-v2/auto-registration', '/opt/id-registration',
                 '/app/.runtime/auto-registration')
UI_CHECKS = ('admin-ui', 'v2-ui-language', 'v2-color-contrast', 'v2-table-standard',
             'v2-loading-standard', 'v2-module-architecture', 'v2-isolation')


def need(value, code):
    if not value:
        raise RuntimeError('FEATURE_RETIREMENT_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def fingerprint(value):
    return digest(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())


def closed_json(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            need(key not in value, 'JSON_DUPLICATE_KEY')
            value[key] = item
        return value
    need(isinstance(raw, bytes) and len(raw) <= 16 * 1024**2, 'JSON_SIZE_INVALID')
    try:
        return json.loads(raw, object_pairs_hook=pairs,
                          parse_constant=lambda _: need(False, 'JSON_CONSTANT_INVALID'))
    except (UnicodeError, ValueError):
        raise RuntimeError('FEATURE_RETIREMENT_JSON_INVALID') from None


def safe_name(name):
    return (isinstance(name, str) and bool(name) and len(name) <= 512
            and re.fullmatch(r'[A-Za-z0-9_.@/-]+', name) is not None
            and not PurePosixPath(name).is_absolute()
            and all(part not in ('', '.', '..') for part in name.split('/')))


def sha(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None


def hash_map(value, *, nullable=False):
    return (type(value) is dict and all(safe_name(name) and (sha(item) or nullable and item is None)
                                       for name, item in value.items()))


def load(name):
    spec = importlib.util.spec_from_file_location('feature_retirement_' + name.replace('-', '_'), HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_plan(plan, c):
    fields = {'version', 'scope', 'commit', 'tree', 'branch', 'workflowRunId', 'workflowRunAttempt',
              'contractSha256', 'buildProofSha256', 'artifactUrl', 'artifactSha256',
              'controlSources', 'qualityVerification', 'mode'}
    need(type(plan) is dict and set(plan) == fields | ({'runtimeBaseline'} if plan.get('mode') in ('release', 'readback') else set()), 'PLAN_FIELDS_INVALID')
    need(type(plan['version']) is int and plan['version'] == 1 and plan['scope'] == SCOPE
         and plan['mode'] in ('preflight', 'release', 'readback') and plan['branch'] == 'main'
         and all(isinstance(plan[n], str) and re.fullmatch('[a-f0-9]{40}', plan[n]) for n in ('commit', 'tree'))
         and all(isinstance(plan[n], str) and re.fullmatch('[1-9][0-9]*', plan[n]) for n in ('workflowRunId', 'workflowRunAttempt'))
         and all(sha(plan[n]) for n in ('contractSha256', 'buildProofSha256', 'artifactSha256')), 'PLAN_IDENTITY_INVALID')
    need(plan['artifactUrl'] == 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/feature-retirement-'
         + plan['commit'] + '/feature-retirement-artifact.tar.gz', 'ARTIFACT_LOCATION_INVALID')
    need(c.get('version') == 1 and c.get('scope') == SCOPE
         and c.get('backupCreated') is False and c.get('cleanupDataInRelease') is False
         and c.get('migrationPerformed') is False and type(c.get('businessActions')) is int and c['businessActions'] == 0
         and c.get('databaseVerification') == {'isolatedDatabaseStarted': False, 'migrationPerformed': False,
             'productionDatabaseWrites': False, 'schemaChanged': False}, 'CONTRACT_BOUNDARY_INVALID')
    need(digest((HERE / 'feature-retirement-contract.json').read_bytes()) == plan['contractSha256']
         and closed_json((HERE / 'feature-retirement-contract.json').read_bytes()) == c, 'CONTRACT_CHANGED')
    need(hash_map(c.get('controlSources')) and c['controlSources'] == plan['controlSources']
         and all(name.startswith(('scripts/', '.github/workflows/')) or name in ('apps/api/Dockerfile.mysql', 'package.json') for name in c['controlSources']), 'CONTROLLER_SCOPE_INVALID')
    for name, expected in c['controlSources'].items():
        # Dispatcher stages the production-release helpers together, not a repository checkout.
        if name.startswith('scripts/production-release/') and Path(name).name in (
                'feature-retirement-release.py', 'remote-deploy.py', 'recharge-record-release.py',
                'recharge-availability-release.py', 'api-admin-scope.py'):
            need(digest((HERE / Path(name).name).read_bytes()) == expected, 'CONTROLLER_CHANGED')
    need(type(c.get('retiredHostPaths')) is list and len(c['retiredHostPaths']) == len(set(c['retiredHostPaths']))
         and all(safe_name(n) and n.startswith(('scripts/', '.github/workflows/')) and ('registration' in n)
                 and n not in c['controlSources'] for n in c['retiredHostPaths']), 'RETIRED_HOST_SCOPE_INVALID')
    need(hash_map(c.get('adminBaselineFiles')) and hash_map(c.get('publicFiles'))
         and all(c['adminBaselineFiles'].get(n) == v for n, v in c['publicFiles'].items()), 'ADMIN_BASELINE_INVALID')
    need(hash_map(c.get('retiredAdminAssets', {}))
         and all(c.get('adminBaselineFiles', {}).get(n) == v and Path(n).name.startswith(('V2AutoRegistration', 'V2AppleMailboxes'))
                 for n, v in c.get('retiredAdminAssets', {}).items()), 'RETIRED_ADMIN_SCOPE_INVALID')
    need(hash_map(c.get('sources'), nullable=True)
         and all(name.startswith(('apps/', 'packages/')) for name in c['sources']), 'SOURCE_SCOPE_INVALID')
    for role in ('api', 'shared'):
        modules, baseline = c.get(role + 'Modules'), c.get(role + 'BaselineFiles')
        need(hash_map(modules, nullable=True) and bool(modules) and all(n.endswith('.js') for n in modules)
             and hash_map(baseline, nullable=True)
             and set(baseline) == {n[:-3] + ext for n in modules for ext in SUFFIXES}
             and all(baseline[n] == old for n, old in modules.items()), 'MODULE_SCOPE_INVALID')
    compiled = c.get('apiCompiledBaselineFiles')
    need(hash_map(compiled, nullable=True) and set(compiled) == set(c['apiBaselineFiles'])
         and all(n.endswith('.d.ts') for n in compiled if compiled[n] != c['apiBaselineFiles'][n]), 'API_COMPILED_BASELINE_INVALID')
    omitted = c.get('omittedApiDeclarations')
    need(type(omitted) is dict and all(safe_name(n) and n.endswith('.d.ts') and n not in c['apiBaselineFiles']
         and type(v) is dict and set(v) == {'baselineSha256', 'compiledSha256'}
         and all(sha(h) for h in v.values()) and v['baselineSha256'] != v['compiledSha256']
         for n, v in omitted.items()), 'OMITTED_DECLARATIONS_INVALID')
    need(set(c.get('services', {})) == set(BEFORE)
         and set(c.get('runtimeConfigurationSha256', {})) == set(BEFORE)
         and all(sha(v) for v in c['runtimeConfigurationSha256'].values())
         and Path(c.get('current', '')).parent == BASE / 'releases'
         and sha(c.get('manifestSha256')) and re.fullmatch('[a-f0-9]{40}', c.get('expectedCurrent', ''))
         and hash_map(c.get('configurationSha256')), 'BASELINE_INVALID')
    need(all(isinstance(c.get(n), str) and re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]+', c[n])
             for n in ('registrationVolume', 'onlineVolume')) and c['registrationVolume'] != c['onlineVolume'], 'VOLUME_SCOPE_INVALID')
    need(Path(c.get('actualCaddyMountSource', '')).is_relative_to(BASE / 'releases')
         and Path(c['actualCaddyMountSource']).name == 'Caddyfile.aws'
         and sha(c.get('actualCaddyMountFileSha256')), 'CADDY_BASELINE_INVALID')
    q = plan['qualityVerification']
    need(type(q) is dict and set(q) == {'runId', 'commit', 'sourceTree', 'path', 'conclusion'}
         and q.get('commit') == plan['commit'] and q.get('sourceTree') == plan['tree']
         and q.get('path') == '.github/workflows/quality.yml' and q.get('conclusion') == 'success'
         and isinstance(q.get('runId'), str) and re.fullmatch('[1-9][0-9]*', q['runId']), 'QUALITY_NOT_SUCCESSFUL')


def inventory(root):
    need(root.is_dir() and not root.is_symlink(), 'INVENTORY_ROOT_INVALID')
    result = {}
    for path in sorted(root.rglob('*')):
        need(not path.is_symlink(), 'CONTENT_SYMLINK')
        if path.is_file():
            name = path.relative_to(root).as_posix()
            need(safe_name(name), 'CONTENT_PATH_INVALID')
            result[name] = digest(path.read_bytes())
    return result


def safe_archive(raw, destination):
    need(not destination.exists() and len(raw) <= 128 * 1024**2, 'ARTIFACT_SIZE_INVALID')
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        members = archive.getmembers()
        need(len(members) <= 12000 and sum(m.size for m in members) <= 256 * 1024**2, 'ARTIFACT_EXPANSION_INVALID')
        names = set()
        for member in members:
            name = member.name.rstrip('/')
            need(safe_name(name) and (name == 'payload' or name.startswith('payload/'))
                 and name not in names and (member.isdir() or member.isfile())
                 and member.size <= 32 * 1024**2, 'ARTIFACT_PATH_INVALID')
            names.add(name)
        destination.mkdir(mode=0o700)
        for member in members:
            target = destination / member.name.rstrip('/')
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.extractfile(member).read())
                target.chmod(0o644)
    return destination / 'payload'


def validate_proof(proof, plan, c, payload):
    fields = {'version', 'scope', 'commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256',
              'controlSources', 'sources', 'apiModules', 'apiDeletedModules', 'sharedModules', 'sharedDeletedModules',
              'adminFiles', 'files', 'baselineApiReproduced', 'baselineAdminReproduced', 'baselineSharedReproduced',
              'qualityVerification', 'validation', 'databaseVerification', 'updatedServices', 'migrationPerformed', 'businessActions',
              'baselineApiCompiledReproduced', 'baselineApiFullInventoryReproduced', 'baselineApiDeclarationDifferences',
              'omittedApiDeclarations', 'omittedApiDeclarationsPackaged', 'omittedApiDeclarationsDeployed'}
    need(type(proof) is dict and set(proof) == fields and type(proof['version']) is int and proof['version'] == 1
         and all(proof[n] == plan[n] for n in ('scope', 'commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controlSources', 'qualityVerification'))
         and proof['sources'] == c['sources'] and all(proof[n] is True for n in ('baselineApiReproduced', 'baselineAdminReproduced', 'baselineSharedReproduced'))
         and proof['databaseVerification'] == c['databaseVerification'] and proof['migrationPerformed'] is False
         and type(proof['businessActions']) is int and proof['businessActions'] == 0
         and proof['updatedServices'] == ['api', 'admin'], 'BUILD_PROOF_INVALID')
    differences = {n: {'runtimeSha256': c['apiBaselineFiles'][n], 'compiledSha256': value}
                   for n, value in c['apiCompiledBaselineFiles'].items() if value != c['apiBaselineFiles'][n]}
    need(proof['baselineApiCompiledReproduced'] is True
         and proof['baselineApiFullInventoryReproduced'] is (not bool(differences))
         and proof['baselineApiDeclarationDifferences'] == differences, 'COMPILED_DECLARATION_EVIDENCE_CHANGED')
    need(proof['omittedApiDeclarations'] == c['omittedApiDeclarations']
         and proof['omittedApiDeclarationsPackaged'] is False and proof['omittedApiDeclarationsDeployed'] is False
         and not set(c['omittedApiDeclarations']) & (set(proof['apiModules']) | set(proof['apiDeletedModules'])), 'OMITTED_DECLARATIONS_DEPLOYED')
    validation = proof['validation']
    need(type(validation) is dict and set(validation) == {'scope', 'commit', 'tree', 'contractSha256', 'uiChecks', 'browserReportSha256', 'status', 'businessActions', 'externalRequests'}
         and all(validation[n] == proof[n] for n in ('scope', 'commit', 'tree', 'contractSha256'))
         and validation['uiChecks'] == list(UI_CHECKS) and validation['status'] == 'PASS'
         and sha(validation['browserReportSha256']) and type(validation['businessActions']) is int and validation['businessActions'] == 0
         and type(validation['externalRequests']) is int and validation['externalRequests'] == 0, 'VALIDATION_MISSING')
    actual = inventory(payload)
    actual.pop('build-proof.json', None)
    need(actual == proof['files'] and hash_map(actual), 'PAYLOAD_CHANGED')
    sources = {**c['sources'], **c['controlSources']}
    expected = {'source/' + name: value for name, value in sources.items() if value is not None}
    for role, prefix in (('api', 'api/modules/'), ('shared', 'api/shared/')):
        changed, removed = proof[role + 'Modules'], proof[role + 'DeletedModules']
        baseline = c[role + 'BaselineFiles']
        need(hash_map(changed) and hash_map(removed) and not set(changed) & set(removed)
             and set(changed) | set(removed) <= set(baseline)
             and all(baseline[n] != value for n, value in changed.items())
             and all(baseline[n] == value for n, value in removed.items()), 'COMPILED_DELTA_INVALID')
        # Every .js entry declared changed by the contract must actually change or disappear.
        need(set(c[role + 'Modules']) <= set(changed) | set(removed), 'COMPILED_DELTA_INCOMPLETE')
        expected.update({prefix + n: v for n, v in changed.items()})
    need(hash_map(proof['adminFiles']) and 'index.html' in proof['adminFiles'] and len(proof['adminFiles']) >= 2, 'ADMIN_FILES_INVALID')
    expected.update({'admin/html/' + n: v for n, v in proof['adminFiles'].items()})
    deletions = {'version': 1, 'apiModules': proof['apiDeletedModules'], 'sharedModules': proof['sharedDeletedModules'],
                 'sources': sorted(n for n, v in c['sources'].items() if v is None)}
    raw = json.dumps(deletions, sort_keys=True, indent=2).encode() + b'\n'
    need((payload / 'deletions.json').read_bytes() == raw, 'DELETIONS_CHANGED')
    expected['deletions.json'] = digest(raw)
    need(actual == expected, 'PAYLOAD_SCOPE_CHANGED')
    return proof


def inspect(d, state):
    rows = closed_json(d.run('docker', 'inspect', state['containerId']).encode())
    need(type(rows) is list and len(rows) == 1, 'CONTAINER_INSPECT_INVALID')
    row = rows[0]
    need(row.get('Id') == state['containerId'] and row.get('Image') == state['image']
         and digest(row.get('State', {}).get('StartedAt', '').encode()) == state['startedAtSha256'], 'CONTAINER_IDENTITY_CHANGED')
    return row


def snapshot(d, directory, roles):
    return {n: d.service_state(directory, n, include_container_id=True, include_environment_hash=True) for n in roles}


def model(row, *, role, retiring=False, caddy_source=None):
    value = {k: copy.deepcopy(row[k]) for k in ('Config', 'HostConfig', 'Mounts')}
    config, host = value['Config'], value['HostConfig']
    config['Hostname'], config['Image'] = '${CONTAINER}', '${IMAGE}'
    config['Env'] = sorted(config.get('Env') or [])
    labels = config.get('Labels') or {}
    for key in tuple(labels):
        if key == 'org.opencontainers.image.revision' or key == LABEL or key in (
                'com.docker.compose.image', 'com.docker.compose.config-hash', 'com.docker.compose.version',
                'com.docker.compose.project.config_files', 'com.docker.compose.project.working_dir',
                'com.docker.compose.project.environment_file', 'com.docker.compose.depends_on', 'com.docker.compose.replace'):
            labels.pop(key)
    config['Labels'] = labels
    if role == 'online-recharge':
        host['NetworkMode'] = 'container:${API}'
    if retiring and role == 'api':
        config['Env'] = [n for n in config['Env'] if not n.startswith('AUTO_REGISTRATION_WORKER_URL=')]
        value['Mounts'] = [m for m in value['Mounts'] if m.get('Destination') != '/app/.runtime/auto-registration']
        if host.get('Binds') is not None:
            host['Binds'] = [m for m in host['Binds'] if m.split(':')[1:2] != ['/app/.runtime/auto-registration']]
        if host.get('Mounts') is not None:
            host['Mounts'] = [m for m in host['Mounts'] if m.get('Target') != '/app/.runtime/auto-registration']
    if role == 'caddy':
        mounts = [m for m in value['Mounts'] if m.get('Destination') == '/etc/caddy/Caddyfile']
        need(len(mounts) == 1 and mounts[0].get('Source') == caddy_source and mounts[0].get('RW') is False, 'CADDY_MOUNT_CHANGED')
        mounts[0]['Source'] = '${RELEASE}/deploy/caddy/Caddyfile.aws'
        if host.get('Binds') is not None:
            host['Binds'] = [('${RELEASE}/deploy/caddy/Caddyfile.aws' + m[m.index(':'):])
                             if m.split(':')[1:2] == ['/etc/caddy/Caddyfile'] else m for m in host['Binds']]
    value['Mounts'] = sorted(value['Mounts'], key=lambda m: (m.get('Destination', ''), m.get('Source', '')))
    return value


def online_binding(d, directory, c, states=None):
    states = states or snapshot(d, directory, AFTER)
    worker, api = states['online-recharge'], states['api']
    engine, server = inspect(d, worker), inspect(d, api)
    a = [m for m in engine.get('Mounts', []) if m.get('Destination') == '/workspace/engine/runtime']
    b = [m for m in server.get('Mounts', []) if m.get('Destination') == '/app/.runtime/online-recharge']
    labels, api_labels = engine.get('Config', {}).get('Labels', {}), server.get('Config', {}).get('Labels', {})
    need(engine.get('HostConfig', {}).get('NetworkMode') == 'container:' + api['containerId']
         and not engine['HostConfig'].get('PortBindings') and len(a) == len(b) == 1
         and all(m.get('Type') == 'volume' and m.get('Name') == c['onlineVolume'] and m.get('RW') is True for m in a + b)
         and labels.get('com.docker.compose.service') == 'online-recharge'
         and labels.get('com.docker.compose.container-number') == '1'
         and labels.get('com.docker.compose.project') == api_labels.get('com.docker.compose.project')
         and bool(labels.get('com.docker.compose.project'))
         and engine['Config'].get('Hostname') == server['Config'].get('Hostname') == api['containerId'][:12], 'ONLINE_BINDING_CHANGED')
    volume = closed_json(d.run('docker', 'volume', 'inspect', c['onlineVolume']).encode())
    need(type(volume) is list and len(volume) == 1 and volume[0].get('Name') == c['onlineVolume'], 'ONLINE_VOLUME_CHANGED')
    return {'image': worker['image'], 'reference': worker['reference'], 'environmentSha256': worker['environmentSha256'],
            'configurationSha256': fingerprint(model(engine, role='online-recharge')),
            'volumeIdentitySha256': fingerprint(volume[0]), 'apiContainerId': api['containerId'],
            'containerId': worker['containerId'], 'startedAtSha256': worker['startedAtSha256']}


def runtime_inventory(d, state, path, *, image=False):
    need(path in ('/app/apps/api/dist', '/app/packages/shared/dist', '/usr/share/nginx/html'), 'RUNTIME_ROOT_INVALID')
    code = r"""const fs=require('node:fs'),p=require('node:path'),crypto=require('node:crypto');const root=process.argv[1],out={};
function walk(dir){for(const n of fs.readdirSync(dir).sort()){const f=p.join(dir,n),s=fs.lstatSync(f);if(s.isSymbolicLink()||!s.isFile()&&!s.isDirectory())throw Error('invalid');if(s.isDirectory())walk(f);else out[p.relative(root,f).split(p.sep).join('/')]=crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}}walk(root);console.log(JSON.stringify(out));"""
    # Admin's nginx image has no Node runtime; use the existing POSIX sha256sum utility there.
    if path == '/usr/share/nginx/html':
        source = 'cd ' + path + ' && test -z "$(find . -type l -print -quit)" && find . -type f -exec sha256sum {} +'
        command = ('docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'sh', state['reference'], '-c', source) if image else ('docker', 'exec', state['containerId'], 'sh', '-c', source)
        result = {}
        for line in d.run(*command, timeout=90).splitlines():
            value, name = line.split('  ', 1)
            need(name.startswith('./') and safe_name(name[2:]) and sha(value) and name[2:] not in result, 'RUNTIME_INVENTORY_INVALID')
            result[name[2:]] = value
    else:
        command = ('docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node', state['reference'], '-e', code, path) if image else ('docker', 'exec', state['containerId'], 'node', '-e', code, path)
        result = closed_json(d.run(*command, timeout=90).encode())
    need(hash_map(result), 'RUNTIME_INVENTORY_INVALID')
    return result


def sqlite_idle(d, directory, c, scope=None):
    scope = scope or load('api-admin-scope')
    # The already deployed helper reads a read-only volume into memory and emits
    # only controlled counts/hashes. The encryption key stays on private stdin.
    image = closed_json(d.run('docker', 'image', 'inspect', c['services']['api']['reference']).encode())
    need(type(image) is list and len(image) == 1 and image[0].get('Id') == c['services']['api']['image'], 'SQLITE_READER_IMAGE_CHANGED')
    value = scope.workspace_private_inspect(d, directory, c['services']['api']['reference'],
                                            c['registrationVolume'], mode='inspect', timeout=20)
    need(value.get('status') == 'PASS' and type(value.get('taskCounts', {}).get('pending')) is int
         and value['taskCounts']['pending'] == 0 and type(value['taskCounts'].get('running')) is int
         and value['taskCounts']['running'] == 0
         and type(value.get('activeAppleLeaseCount')) is int and value['activeAppleLeaseCount'] == 0
         and type(value.get('businessActions')) is int and value['businessActions'] == 0, 'SQLITE_NOT_IDLE')
    return fingerprint(value)


def baseline(d, c, h):
    previous = (BASE / 'current').resolve()
    need(previous == Path(c['current']) and previous.parent == BASE / 'releases' and not previous.is_symlink(), 'CURRENT_CHANGED')
    raw = (previous / 'release-manifest.json').read_bytes()
    need(digest(raw) == c['manifestSha256'] and closed_json(raw).get('commit') == c['expectedCurrent'], 'MANIFEST_CHANGED')
    need(all(not (previous / n).is_symlink() and digest((previous / n).read_bytes()) == expected
             for n, expected in c['configurationSha256'].items()), 'CONFIGURATION_CHANGED')
    mounted = Path(c['actualCaddyMountSource'])
    need(not mounted.is_symlink() and digest(mounted.read_bytes()) == c['actualCaddyMountFileSha256'], 'CADDY_SOURCE_CHANGED')
    states = snapshot(d, previous, BEFORE)
    need(states == c['services'] and all(h.fingerprint(h.configuration(d, states[n])) == expected
              for n, expected in c['runtimeConfigurationSha256'].items()), 'RUNTIME_BASELINE_CHANGED')
    api = runtime_inventory(d, states['api'], '/app/apps/api/dist')
    shared = runtime_inventory(d, states['api'], '/app/packages/shared/dist')
    admin = runtime_inventory(d, states['admin'], '/usr/share/nginx/html')
    need(all(api.get(n) == v for n, v in c['apiBaselineFiles'].items())
         and all(shared.get(n) == v for n, v in c['sharedBaselineFiles'].items())
         and admin == c['adminBaselineFiles'], 'BASELINE_FILES_CHANGED')
    rows = {n: inspect(d, states[n]) for n in BEFORE}
    for state in states.values():
        h.base_image_reference(d, state)
    registration_mounts = [v for v in rows['api']['Mounts'] if v.get('Destination') == '/app/.runtime/auto-registration']
    need(len(registration_mounts) == 1 and registration_mounts[0].get('Type') == 'volume'
         and registration_mounts[0].get('Name') == c['registrationVolume'] and registration_mounts[0].get('RW') is True, 'REGISTRATION_MOUNT_CHANGED')
    project = rows['api']['Config']['Labels'].get('com.docker.compose.project')
    verify_registration(rows['auto-registration'], states['auto-registration'], project)
    registration = closed_json(d.run('docker', 'volume', 'inspect', c['registrationVolume']).encode())
    need(type(registration) is list and len(registration) == 1 and registration[0].get('Name') == c['registrationVolume'], 'REGISTRATION_VOLUME_CHANGED')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    binding = online_binding(d, previous, c, states)
    d.assert_no_active_recharge(previous)
    d.assert_no_active_registration(previous)
    h.engine_idle(d, states['online-recharge'], c)
    sqlite_hash = sqlite_idle(d, previous, c)
    receipt = {'version': 1, 'current': str(previous), 'manifestSha256': digest(raw), 'services': states,
               'configurationSha256': c['configurationSha256'], 'runtimeConfigurationSha256': c['runtimeConfigurationSha256'],
               'apiInventorySha256': fingerprint(api), 'sharedInventorySha256': fingerprint(shared),
               'adminInventorySha256': fingerprint(admin), 'onlineBindingSha256': fingerprint(binding),
               'registrationVolumeSha256': fingerprint(registration[0]), 'sqliteSafetySha256': sqlite_hash}
    return {'directory': previous, 'manifest': raw, 'states': states, 'rows': rows,
            'api': api, 'shared': shared, 'admin': admin, 'binding': binding,
            'registrationVolumeSha256': fingerprint(registration[0]), 'receipt': receipt}


def verify_registration(row, identity, project):
    labels = row.get('Config', {}).get('Labels', {})
    env = row.get('Config', {}).get('Env', [])
    need(row.get('Id') == identity['containerId'] and row.get('Image') == identity['image']
         and digest(row.get('State', {}).get('StartedAt', '').encode()) == identity['startedAtSha256']
         and labels.get('com.docker.compose.service') == 'auto-registration'
         and labels.get('com.docker.compose.project') == project and bool(project)
         and labels.get('com.docker.compose.container-number') == '1'
         and [v for v in env if v.startswith('AUTO_RECHARGE_WORKER_ROLE=')] == ['AUTO_RECHARGE_WORKER_ROLE=registration'], 'RETIREMENT_IDENTITY_INVALID')


def retired_containers(d, project):
    output = d.run('docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project,
                   '--filter', 'label=com.docker.compose.service=auto-registration')
    rows = output.splitlines() if output else []
    need(all(re.fullmatch('[a-f0-9]{12,64}', n) for n in rows), 'RETIREMENT_INVENTORY_INVALID')
    return rows


def retire_container(d, identity, project):
    row = inspect(d, identity)
    verify_registration(row, identity, project)
    # ps may emit short IDs; compare each to the exact approved full identity.
    need(all(identity['containerId'].startswith(n) for n in retired_containers(d, project)), 'EXTRA_REGISTRATION_CONTAINER')
    if row['State'].get('Running') is True:
        d.run('docker', 'stop', '--time', '30', identity['containerId'], timeout=40)
    stopped = inspect(d, identity)
    verify_registration(stopped, identity, project)
    need(stopped['State'].get('Running') is False, 'REGISTRATION_NOT_STOPPED')
    d.run('docker', 'rm', identity['containerId'], timeout=30)
    need(not retired_containers(d, project), 'REGISTRATION_STILL_PRESENT')


def remove_blocks(text, parent, keys):
    """Remove only named two-space YAML mapping blocks beneath a top-level key."""
    lines, output, section, removing, removed = text.splitlines(keepends=True), [], None, False, set()
    for line in lines:
        top = re.match(r'^([A-Za-z][A-Za-z0-9_-]*):(?:\s|$)', line)
        if top:
            section, removing = top[1], False
        child = re.match(r'^  ([A-Za-z0-9_-]+):(?:\s|$)', line)
        if child:
            removing = section == parent and child[1] in keys
            if removing:
                need(child[1] not in removed, 'COMPOSE_DUPLICATE_BLOCK')
                removed.add(child[1])
        if not removing:
            output.append(line)
    need(removed == set(keys), 'COMPOSE_RETIRED_BLOCK_MISSING')
    return ''.join(output)


def retirement_compose(text):
    text = remove_blocks(text, 'services', {'auto-registration'})
    text = remove_blocks(text, 'networks', {'registration-control', 'registration-egress'})
    output, service, counts = [], None, {'mount': 0, 'env': 0, 'network': 0}
    for line in text.splitlines(keepends=True):
        match = re.match(r'^  ([A-Za-z0-9_-]+):(?:\s|$)', line)
        if match:
            service = match[1]
        if re.match(r'^\S', line):
            service = None
        if service == 'api':
            kind = ('mount' if re.fullmatch(r'      - auto_registration_data:/app/\.runtime/auto-registration\s*\n?', line) else
                    'env' if re.fullmatch(r'      AUTO_REGISTRATION_WORKER_URL: http://auto-registration:8051\s*\n?', line) else
                    'network' if re.fullmatch(r'      - registration-control\s*\n?', line) else None)
            if kind:
                counts[kind] += 1
                continue
        output.append(line)
    need(counts == {'mount': 1, 'env': 1, 'network': 1}, 'COMPOSE_API_REMOVAL_CHANGED')
    result = remove_blocks(''.join(output), 'volumes', {'auto_registration_data'})
    # The removed declaration must not be referenced by another service, profile,
    # or YAML anchor. Fail closed rather than deleting a still-shared volume.
    need(not any(re.search(r'(?<![A-Za-z0-9_-])auto_registration_data(?![A-Za-z0-9_-])',
                           line.split('#', 1)[0]) for line in result.splitlines()),
         'REGISTRATION_VOLUME_STILL_REFERENCED')
    return result


def retirement_caddy(raw):
    text = raw.decode()
    marker = '\t@registrationWorkspace path /api/id-business-v2/auto-registration/workspace /api/id-business-v2/auto-registration/workspace/*\n'
    block = marker + '\thandle @registrationWorkspace {\n\t\t# Preserve the authenticated workspace\'s own frame and inline-script policy.\n\t\treverse_proxy api:3000 {\n\t\t\tflush_interval -1\n\t\t}\n\t}\n\n'
    need(text.count(block) == 1, 'CADDY_RETIRED_HANDLE_CHANGED')
    output = text.replace(block, '', 1).encode()
    need(b'@registrationWorkspace' not in output and b'auto-registration' not in output, 'CADDY_RETIRED_HANDLE_REMAINS')
    return output


def verify_registration_volume_unused(services):
    for service in services.values():
        for volume in service.get('volumes', []):
            source = volume.get('source') if isinstance(volume, dict) else volume.split(':', 1)[0]
            need(source != 'auto_registration_data', 'REGISTRATION_VOLUME_STILL_REFERENCED')


def retirement_override(value, images, target):
    result = copy.deepcopy(value)
    services = result.get('services', {})
    services.pop('auto-registration', None)
    need(all(n in services for n in ('api', 'admin')), 'OVERRIDE_SERVICE_MISSING')
    for role in ('api', 'admin'):
        services[role]['image'] = images[role]['reference']
    api = services['api']
    env = api.get('environment')
    if isinstance(env, dict):
        env.pop('AUTO_REGISTRATION_WORKER_URL', None)
    elif isinstance(env, list):
        api['environment'] = [n for n in env if not n.startswith('AUTO_REGISTRATION_WORKER_URL=')]
    if 'volumes' in api:
        api['volumes'] = [v for v in api['volumes'] if (v.get('target') if isinstance(v, dict) else v.split(':')[1]) != '/app/.runtime/auto-registration']
    if isinstance(api.get('networks'), dict):
        api['networks'].pop('registration-control', None)
    elif isinstance(api.get('networks'), list):
        api['networks'] = [n for n in api['networks'] if n != 'registration-control']
    if isinstance(result.get('networks'), dict):
        for n in ('registration-control', 'registration-egress'):
            result['networks'].pop(n, None)
    verify_registration_volume_unused(services)
    if isinstance(result.get('volumes'), dict):
        result['volumes'].pop('auto_registration_data', None)
    # Override just this bind, preserving existing named Caddy data/config volumes.
    caddy = services.setdefault('caddy', {})
    binds = [v for v in caddy.get('volumes', []) if (v.get('target') if isinstance(v, dict) else v.split(':')[1]) != '/etc/caddy/Caddyfile']
    binds.append({'type': 'bind', 'source': str(target / 'deploy/caddy/Caddyfile.aws'),
                  'target': '/etc/caddy/Caddyfile', 'read_only': True, 'bind': {'create_host_path': True}})
    caddy['volumes'] = binds
    return result


def normalize_render(value, directory):
    if isinstance(value, str):
        return value.replace(str(directory), '${RELEASE}')
    if isinstance(value, list):
        return [normalize_render(n, directory) for n in value]
    if isinstance(value, dict):
        return {k: normalize_render(v, directory) for k, v in value.items()}
    return value


def verify_rendered(before, after, images, previous, target):
    expected = normalize_render(copy.deepcopy(before), previous)
    actual = normalize_render(after, target)
    services = expected['services']
    need('auto-registration' in services, 'COMPOSE_RETIRED_SERVICE_MISSING')
    services.pop('auto-registration')
    api = services['api']
    need('AUTO_REGISTRATION_WORKER_URL' in api.get('environment', {}), 'COMPOSE_RETIRED_ENV_MISSING')
    api['environment'].pop('AUTO_REGISTRATION_WORKER_URL')
    api['volumes'] = [v for v in api.get('volumes', []) if v.get('target') != '/app/.runtime/auto-registration']
    api['networks'].pop('registration-control', None)
    verify_registration_volume_unused(services)
    need('auto_registration_data' in expected.get('volumes', {}), 'COMPOSE_RETIRED_VOLUME_MISSING')
    expected['volumes'].pop('auto_registration_data')
    for n in ('registration-control', 'registration-egress'):
        expected.get('networks', {}).pop(n, None)
    for role in ('api', 'admin'):
        services[role]['image'] = images[role]['reference']
    for volume in services['caddy']['volumes']:
        if volume.get('target') == '/etc/caddy/Caddyfile':
            volume['source'] = '${RELEASE}/deploy/caddy/Caddyfile.aws'
            # The explicit override may omit Compose's default create_host_path flag.
            volume['bind'] = volume.get('bind', {'create_host_path': True})
    for volume in actual['services']['caddy']['volumes']:
        if volume.get('target') == '/etc/caddy/Caddyfile':
            volume['bind'] = volume.get('bind', {'create_host_path': True})
    need(actual == expected, 'COMPOSE_UNRELATED_CONFIGURATION_CHANGED')


def apply_sources(target, payload, c):
    for name in c['retiredHostPaths']:
        path = target / name
        need(not path.is_symlink() and path.resolve().is_relative_to(target), 'RETIRED_HOST_PATH_INVALID')
        if path.exists():
            need(path.is_file(), 'RETIRED_HOST_PATH_NOT_FILE')
            path.unlink()
    for name in c['retiredHostPaths']:
        need(not (target / name).exists() and not (target / name).is_symlink(), 'READBACK_RETIRED_HOST_PATH_PRESENT')
    for name, expected in {**c['sources'], **c['controlSources']}.items():
        path = target / name
        need(not path.is_symlink() and path.resolve().is_relative_to(target), 'HOST_SOURCE_PATH_INVALID')
        if expected is None:
            if path.exists():
                need(path.is_file(), 'HOST_DELETION_NOT_FILE')
                path.unlink()
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((payload / 'source' / name).read_bytes())
            path.chmod(0o644)
    retired = target / 'apps/api/src/id-business-v2/auto-registration'
    if retired.exists():
        # Only empty directories may remain after the exact contract source deletions.
        need(not any(p.is_file() or p.is_symlink() for p in retired.rglob('*')), 'UNREVIEWED_RETIRED_SOURCE_REMAINS')
        shutil.rmtree(retired)


def publish_contract(target, plan):
    source = HERE / 'feature-retirement-contract.json'
    raw = source.read_bytes()
    need(not source.is_symlink() and digest(raw) == plan['contractSha256'], 'CONTRACT_CHANGED_BEFORE_COPY')
    path = target / 'scripts/production-release/feature-retirement-contract.json'
    need(not path.is_symlink() and path.resolve().is_relative_to(target), 'CONTRACT_TARGET_PATH_INVALID')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    path.chmod(0o644)


def image_dockerfile(role, reference, original, proof, plan, c=None):
    need(re.fullmatch(r'[a-z0-9][a-z0-9._:/@-]{1,255}', reference) is not None, 'IMAGE_REFERENCE_INVALID')
    user = original.get('User', '')
    need(isinstance(user, str) and re.fullmatch(r'[A-Za-z0-9_.:-]*', user) is not None, 'IMAGE_USER_INVALID')
    lines = ['FROM ' + reference] + (['USER root'] if user else [])
    if role == 'api':
        deleted = ['/app/apps/api/dist/' + n for n in proof['apiDeletedModules']]
        deleted += ['/app/packages/shared/dist/' + n for n in proof['sharedDeletedModules']]
        need(all(safe_name(n) for n in proof['apiDeletedModules']) and all(safe_name(n) for n in proof['sharedDeletedModules']), 'IMAGE_DELETION_INVALID')
        lines += ['RUN rm -rf -- ' + ' '.join(shlex.quote(n) for n in (*RETIRED_ROOTS, *deleted)),
                  'COPY modules/ /app/apps/api/dist/', 'COPY shared/ /app/packages/shared/dist/']
    else:
        retired = (c or {}).get('retiredAdminAssets', {})
        need(hash_map(retired), 'RETIRED_ADMIN_SCOPE_INVALID')
        if retired:
            lines += ['RUN rm -f -- ' + ' '.join(shlex.quote('/usr/share/nginx/html/' + n) for n in retired)]
        lines += ['COPY html/ /usr/share/nginx/html/',
                  'RUN find /usr/share/nginx/html -type d -exec chmod 755 {} + && find /usr/share/nginx/html -type f -exec chmod 644 {} +']
    lines += (['USER ' + user] if user else [])
    lines += ['LABEL org.opencontainers.image.revision="' + plan['commit']
              + '" ' + LABEL + '="' + plan['buildProofSha256'] + '"']
    return '\n'.join(lines) + '\n'


def expected_inventory(before, changed, deleted):
    need(not set(changed) & set(deleted) and all(before.get(n) == v for n, v in deleted.items()), 'DELETED_BASELINE_CHANGED')
    return {**{n: v for n, v in before.items() if n not in deleted}, **changed}


def verify_image_config(original, built):
    need({k: v for k, v in built.items() if k not in ('Labels', 'Image')} ==
         {k: v for k, v in original.items() if k not in ('Labels', 'Image')}, 'IMAGE_CONFIGURATION_CHANGED')


def build_images(d, h, payload, proof, plan, before, stage, c):
    images = {}
    for role in ('api', 'admin'):
        context = payload / role
        for folder in (('modules', 'shared') if role == 'api' else ('html',)):
            (context / folder).mkdir(exist_ok=True)
        original = closed_json(d.run('docker', 'image', 'inspect', before[role]['image']).encode())[0]
        reference = h.base_image_reference(d, before[role])
        (context / 'Dockerfile').write_text(image_dockerfile(role, reference, original['Config'], proof, plan, c))
        image = 'id-business-v2-feature-retirement:' + plan['commit'] + '-' + plan['workflowRunId'] + '-' + role
        h.build_image(d, context, image, role, before[role], stage)
        built = closed_json(d.run('docker', 'image', 'inspect', image).encode())[0]
        need(built['RootFS']['Layers'][:len(original['RootFS']['Layers'])] == original['RootFS']['Layers'], 'BASE_IMAGE_LAYERS_CHANGED')
        verify_image_config(original['Config'], built['Config'])
        need(built['Config']['Labels'] == {**(original['Config'].get('Labels') or {}),
             'org.opencontainers.image.revision': plan['commit'], LABEL: plan['buildProofSha256']}, 'IMAGE_LABELS_CHANGED')
        images[role] = {'reference': image, 'imageId': built['Id']}
    return images


def verify_readback_delta(actual, changed, deleted, baseline, expected_before_hash):
    need(hash_map(actual) and hash_map(changed) and hash_map(deleted)
         and not set(changed) & set(deleted) and set(changed) | set(deleted) <= set(baseline)
         and all(actual.get(n) == v for n, v in changed.items())
         and all(n not in actual and baseline[n] == v for n, v in deleted.items()), 'READBACK_DELTA_CHANGED')
    reconstructed = dict(actual)
    for name in changed:
        if baseline[name] is None:
            reconstructed.pop(name)
        else:
            reconstructed[name] = baseline[name]
    reconstructed.update(deleted)
    need(fingerprint(reconstructed) == expected_before_hash, 'READBACK_UNRELATED_CONTENT_CHANGED')


def verify_contents(d, states, proof, expected, *, image=False):
    for role, root, expected_files in (('api', '/app/apps/api/dist', expected['api']),
                                      ('api', '/app/packages/shared/dist', expected['shared']),
                                      ('admin', '/usr/share/nginx/html', expected['admin'])):
        need(runtime_inventory(d, states[role], root, image=image) == expected_files, 'RUNTIME_CONTENT_CHANGED')
    command = ('docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'sh', states['api']['reference']) if image else ('docker', 'exec', states['api']['containerId'], 'sh')
    d.run(*command, '-c', ' && '.join('test ! -e ' + shlex.quote(n) for n in RETIRED_ROOTS))


def runtime_receipt(before):
    return before['receipt']


def verify_runtime_after(d, c, before, after, target, h):
    need(all(after[n] == before['states'][n] for n in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
    project = before['rows']['api']['Config']['Labels']['com.docker.compose.project']
    need(not retired_containers(d, project), 'RETIRED_CONTAINER_RETURNED')
    registration = closed_json(d.run('docker', 'volume', 'inspect', c['registrationVolume']).encode())
    need(len(registration) == 1 and fingerprint(registration[0]) == before['registrationVolumeSha256'], 'REGISTRATION_VOLUME_CHANGED')
    for role in ('api', 'admin', 'caddy', 'online-recharge'):
        row = inspect(d, after[role])
        old = model(before['rows'][role], role=role, retiring=True,
                    caddy_source=c['actualCaddyMountSource'] if role == 'caddy' else None)
        new = model(row, role=role, caddy_source=str(target / 'deploy/caddy/Caddyfile.aws') if role == 'caddy' else None)
        need(old == new, 'UNRELATED_RUNTIME_CONFIGURATION_CHANGED')
        if role == 'api':
            old_networks = set(before['rows'][role].get('NetworkSettings', {}).get('Networks', {}))
            removed = {n for n in old_networks if n.endswith('_registration-control') or n == 'registration-control'}
            new_networks = set(row.get('NetworkSettings', {}).get('Networks', {}))
            need(len(removed) == 1 and new_networks == old_networks - removed, 'API_NETWORKS_CHANGED')
    h.engine_idle(d, after['online-recharge'], c, wait_connected=True)
    binding = online_binding(d, target, c, after)
    need(all(binding[n] == before['binding'][n] for n in ('image', 'reference', 'environmentSha256', 'configurationSha256', 'volumeIdentitySha256')), 'ONLINE_RUNTIME_CHANGED')
    return binding


def public_smoke(proof):
    with urllib.request.urlopen(urllib.request.Request('https://54-249-61-238.sslip.io/',
                               headers={'Cache-Control': 'no-cache'}), timeout=25) as response:
        raw = response.read(2 * 1024**2 + 1)
    need(len(raw) <= 2 * 1024**2 and digest(raw) == proof['adminFiles']['index.html']
         and ('v2-' + proof['commit']).encode() in raw, 'PUBLIC_ADMIN_CHANGED')


def write_json(path, value):
    path.write_text(json.dumps(value, sort_keys=True, indent=2) + '\n')
    path.chmod(0o600)


def readback(plan, c, d, h):
    target = (BASE / 'current').resolve()
    need(target.parent == BASE / 'releases' and target != Path(c['current']), 'READBACK_TARGET_INVALID')
    contract_path = target / 'scripts/production-release/feature-retirement-contract.json'
    need(not contract_path.is_symlink() and contract_path.resolve().is_relative_to(target)
         and digest(contract_path.read_bytes()) == plan['contractSha256'], 'READBACK_CONTRACT_CHANGED')
    manifest = closed_json((target / 'release-manifest.json').read_bytes())
    need(manifest.get('scope') == SCOPE and manifest.get('commit') == plan['commit'] and manifest.get('sourceTree') == plan['tree']
         and manifest.get('previousRelease') == c['current'] and manifest.get('previousManifestSha256') == c['manifestSha256']
         and manifest.get('servicesRetired') == ['auto-registration']
         and manifest.get('buildProofSha256') == plan['buildProofSha256'], 'READBACK_MANIFEST_CHANGED')
    receipt = closed_json((target / 'feature-retirement-preservation.json').read_bytes())
    need(digest((target / 'feature-retirement-preservation.json').read_bytes()) == manifest.get('preservationSha256')
         and receipt.get('runtimeBaseline') == plan['runtimeBaseline'] and receipt.get('status') == 'FEATURE_RETIREMENT_DEPLOYED', 'READBACK_RECEIPT_CHANGED')
    proof_raw = (target / 'feature-retirement-build-proof.json').read_bytes()
    need(digest(proof_raw) == plan['buildProofSha256'], 'READBACK_PROOF_CHANGED')
    proof = closed_json(proof_raw)
    need(all(proof.get(n) == plan[n] for n in ('scope', 'commit', 'tree', 'contractSha256', 'controlSources', 'qualityVerification')), 'READBACK_PROOF_INVALID')
    after = snapshot(d, target, AFTER)
    need(after == receipt['after'] and all(after[n] == c['services'][n] for n in PRESERVED), 'READBACK_SERVICES_CHANGED')
    need(all(not (target / n).is_symlink() and digest((target / n).read_bytes()) == v
             for n, v in receipt['configurationSha256'].items()), 'READBACK_CONFIGURATION_CHANGED')
    for name in c['retiredHostPaths']:
        need(not (target / name).exists() and not (target / name).is_symlink(), 'READBACK_RETIRED_HOST_PATH_PRESENT')
    for name, expected in {**c['sources'], **c['controlSources']}.items():
        path = target / name
        need(not path.is_symlink() and path.resolve().is_relative_to(target)
             and (not path.exists() if expected is None else path.is_file() and digest(path.read_bytes()) == expected), 'READBACK_SOURCE_CHANGED')
    before = {'states': c['services'], 'rows': {}, 'binding': receipt['beforeOnlineBinding'],
              'registrationVolumeSha256': plan['runtimeBaseline']['registrationVolumeSha256']}
    # Reconstruct only the in-memory predecessor models from the exact original containers
    # for preserved roles. Recreated roles use hashes recorded before the switch and pinned
    # by the manifest. Never trust receipt health without measuring the running components.
    for role in AFTER:
        current_model = model(inspect(d, after[role]), role=role,
                              caddy_source=str(target / 'deploy/caddy/Caddyfile.aws') if role == 'caddy' else None)
        need(fingerprint(current_model) == receipt['expectedRuntimeModels'][role], 'READBACK_RUNTIME_CONFIGURATION_CHANGED')
        if role in ('api', 'admin'):
            need(after[role]['image'] == receipt['images'][role]['imageId'], 'READBACK_IMAGE_CHANGED')
    project = inspect(d, after['api'])['Config']['Labels']['com.docker.compose.project']
    need(not retired_containers(d, project), 'READBACK_REGISTRATION_PRESENT')
    registration = closed_json(d.run('docker', 'volume', 'inspect', c['registrationVolume']).encode())
    need(len(registration) == 1 and fingerprint(registration[0]) == before['registrationVolumeSha256'], 'READBACK_VOLUME_CHANGED')
    binding = online_binding(d, target, c, after)
    need(all(binding[n] == receipt['beforeOnlineBinding'][n] for n in ('image', 'reference', 'environmentSha256', 'configurationSha256', 'volumeIdentitySha256')), 'READBACK_ONLINE_CHANGED')
    verify_contents(d, after, proof, receipt['expectedInventories'])
    for role, path in (('api', '/app/apps/api/dist'), ('shared', '/app/packages/shared/dist')):
        verify_readback_delta(runtime_inventory(d, after['api'], path), proof[role + 'Modules'],
                              proof[role + 'DeletedModules'], c[role + 'BaselineFiles'],
                              plan['runtimeBaseline'][role + 'InventorySha256'])
    need(fingerprint(c['adminBaselineFiles']) == plan['runtimeBaseline']['adminInventorySha256']
         and runtime_inventory(d, after['admin'], '/usr/share/nginx/html') == expected_inventory(
             c['adminBaselineFiles'], proof['adminFiles'], c.get('retiredAdminAssets', {})), 'READBACK_ADMIN_HISTORY_CHANGED')
    for role in ('api', 'admin'):
        old_image = closed_json(d.run('docker', 'image', 'inspect', c['services'][role]['image']).encode())[0]
        new_image = closed_json(d.run('docker', 'image', 'inspect', after[role]['image']).encode())[0]
        need(new_image['RootFS']['Layers'][:len(old_image['RootFS']['Layers'])] == old_image['RootFS']['Layers'], 'READBACK_IMAGE_LAYERS_CHANGED')
        verify_image_config(old_image['Config'], new_image['Config'])
        need(new_image['Config'].get('Labels') == {**(old_image['Config'].get('Labels') or {}),
             'org.opencontainers.image.revision': plan['commit'], LABEL: plan['buildProofSha256']}, 'READBACK_IMAGE_LABELS_CHANGED')
    h.engine_idle(d, after['online-recharge'], c, wait_connected=True)
    d.assert_no_active_recharge(target)
    need(sqlite_idle(d, target, c) == plan['runtimeBaseline']['sqliteSafetySha256'], 'READBACK_SQLITE_CHANGED')
    public_smoke(proof)
    return {'status': 'FEATURE_RETIREMENT_READBACK_VERIFIED', 'mode': 'readback', 'commit': plan['commit'],
            'tree': plan['tree'], 'images': receipt['images'], 'retiredServices': ['auto-registration'],
            'preservedServices': list(PRESERVED), 'businessActions': 0, 'migrationPerformed': False,
            'backupCreated': False, 'dataDeleted': False}


def verify_reference(d, reference, expected):
    rows = closed_json(d.run('docker', 'image', 'inspect', reference).encode())
    need(type(rows) is list and len(rows) == 1 and rows[0].get('Id') == expected, 'SELECTED_REFERENCE_CHANGED')


def switch_services(d, c, previous, target, before, h, baseline_receipt, images, *, progress=lambda _: None, scope=None):
    scope = scope or load('api-admin-scope')
    # This private helper instance retains the original SQL fence/rebind implementation,
    # while its binding validator supports the pinned physical formal-volume names.
    scope.online_binding = lambda selected, directory, states=None: online_binding(selected, directory, c, states)
    audit = scope.WorkspaceAuditBarrier(d, previous)
    # Historical terminal failures are not active work. The same-connection READ
    # lock blocks new audited dispatch; SQLite summary and leases prove idleness.
    audit.QUERY = "SELECT JSON_OBJECT('version',1,'connectionId',CONNECTION_ID(),'busy',0);\n"
    progress('audit_barrier_acquire')
    audit.acquire()
    try:
        audit.before_stop()
        progress('sqlite_locked_initial_check')
        need(sqlite_idle(d, previous, c, scope) == baseline_receipt['sqliteSafetySha256'], 'SQLITE_CHANGED_BEFORE_STOP')
        d.assert_no_active_recharge(previous)
        d.assert_no_active_registration(previous)
        h.engine_idle(d, before['states']['online-recharge'], c)
        fence = scope.OnlineSqlFence(d, previous)
        progress('online_fence_acquire')
        fence.acquire()
        try:
            fence.check_idle()
            progress('retire_registration_container')
            retire_container(d, before['states']['auto-registration'], before['rows']['api']['Config']['Labels']['com.docker.compose.project'])
            progress('stop_online_recharge')
            fence.stop(before['states']['online-recharge'], grace=45)
            audit.before_stop()
            need(sqlite_idle(d, previous, c, scope) == baseline_receipt['sqliteSafetySha256'], 'SQLITE_CHANGED_BEFORE_STOP')
            progress('stop_old_api')
            fence.stop(before['states']['api'], grace=30)
        finally:
            fence.close()
    finally:
        audit.close()
    progress('start_api')
    verify_reference(d, images['api']['reference'], images['api']['imageId'])
    d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'api', timeout=300)
    d.wait_healthy(target, 'api')
    progress('rebind_online_recharge')
    verify_reference(d, before['states']['online-recharge']['reference'], before['states']['online-recharge']['image'])
    scope.online_rebind(d, target, {'binding': before['binding']})
    for role in ('admin', 'caddy'):
        progress('start_' + role)
        verify_reference(d, images[role]['reference'] if role == 'admin' else before['states'][role]['reference'],
                         images[role]['imageId'] if role == 'admin' else before['states'][role]['image'])
        d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', role, timeout=180)
        d.wait_healthy(target, role)


def release(plan, c, d, h=None):
    validate_plan(plan, c)
    h = h or load('recharge-record-release')
    with (BASE / '.deploy.lock').open('a') as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('FEATURE_RETIREMENT_RELEASE_LOCKED') from None
        if plan['mode'] == 'readback':
            return readback(plan, c, d, h)
        before = baseline(d, c, h)
        if plan['mode'] == 'preflight':
            return {'status': 'FEATURE_RETIREMENT_PREFLIGHT_VERIFIED', 'mode': 'preflight', 'commit': plan['commit'],
                    'runtimeBaseline': runtime_receipt(before), 'businessActions': 0, 'migrationPerformed': False,
                    'backupCreated': False, 'dataDeleted': False}
        need(plan.get('runtimeBaseline') == runtime_receipt(before), 'PREFLIGHT_BASELINE_CHANGED')
        stage = BASE / '.staging' / ('feature-retirement-' + plan['commit'] + '-' + plan['workflowRunId'] + '-' + plan['workflowRunAttempt'])
        need(not stage.parent.is_symlink(), 'STAGING_PATH_INVALID')
        stage.parent.mkdir(mode=0o700, exist_ok=True)
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        state_path = stage / 'switch-state.json'
        journal = {'status': 'PREPARING', 'commit': plan['commit'], 'lastStep': 'download_artifact'}
        def progress(step, **fields):
            journal.update(lastStep=step, **fields)
            write_json(state_path, journal)
        progress('download_artifact')
        try:
            with urllib.request.urlopen(plan['artifactUrl'], timeout=60) as response:
                raw = response.read(128 * 1024**2 + 1)
            need(0 < len(raw) <= 128 * 1024**2 and digest(raw) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
            payload = safe_archive(raw, stage / 'content')
            raw_proof = (payload / 'build-proof.json').read_bytes()
            need(digest(raw_proof) == plan['buildProofSha256'], 'BUILD_PROOF_CHANGED')
            proof = validate_proof(closed_json(raw_proof), plan, c, payload)
            expected = {role: expected_inventory(before[role], proof[role + 'Modules'], proof[role + 'DeletedModules']) for role in ('api', 'shared')}
            expected['admin'] = expected_inventory(before['admin'], proof['adminFiles'], c.get('retiredAdminAssets', {}))
            need(not any(n.startswith('id-business-v2/auto-registration/') for n in expected['api']), 'RETIRED_COMPILED_FILES_REMAIN')
            images = build_images(d, h, payload, proof, plan, before['states'], stage, c)
            image_states = {n: {'reference': v['reference']} for n, v in images.items()}
            verify_contents(d, image_states, proof, expected, image=True)
            stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
            target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-feature-retirement')
            need(not target.exists(), 'TARGET_EXISTS')
            previous = before['directory']
            shutil.copytree(previous, target, symlinks=True)
            apply_sources(target, payload, c)
            publish_contract(target, plan)
            (target / 'docker-compose.aws-mysql.yml').write_text(retirement_compose((previous / 'docker-compose.aws-mysql.yml').read_text()))
            caddy_path = target / 'deploy/caddy/Caddyfile.aws'
            need(not caddy_path.is_symlink(), 'CADDY_TARGET_SYMLINK')
            caddy_path.write_bytes(retirement_caddy(Path(c['actualCaddyMountSource']).read_bytes()))
            caddy_path.chmod(0o644)
            override = retirement_override(closed_json((previous / 'compose.release.json').read_bytes()), images, target)
            write_json(target / 'compose.release.json', override)
            rendered_before = closed_json(d.compose(previous, 'config', '--format', 'json').encode())
            rendered_after = closed_json(d.compose(target, 'config', '--format', 'json').encode())
            verify_rendered(rendered_before, rendered_after, images, previous, target)
            # Validate the exact new Caddy configuration using the unchanged edge image.
            domains = [v for v in before['rows']['caddy']['Config'].get('Env', []) if v.startswith('APP_DOMAIN=')]
            need(len(domains) == 1 and re.fullmatch(r'APP_DOMAIN=[A-Za-z0-9.*_-]+', domains[0]), 'CADDY_DOMAIN_INVALID')
            d.run('docker', 'run', '--rm', '--network', 'none', '--read-only', '--env', domains[0],
                  '--mount', 'type=bind,src=' + str(caddy_path) + ',dst=/etc/caddy/Caddyfile,readonly',
                  before['states']['caddy']['reference'], 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile', timeout=45)
            fresh = baseline(d, c, h)
            need(runtime_receipt(fresh) == plan['runtimeBaseline'], 'BASELINE_MOVED')
            for role, image in images.items():
                verify_reference(d, image['reference'], image['imageId'])
            progress('switch_prepared', status='SWITCH_STARTED', target=str(target), previous=str(previous), switchStarted=True)
            switch_services(d, c, previous, target, before, h, plan['runtimeBaseline'], images, progress=progress)
            after = snapshot(d, target, AFTER)
            need(all(after[n]['image'] == v['imageId'] for n, v in images.items())
                 and after['caddy']['image'] == before['states']['caddy']['image'], 'SELECTED_IMAGE_CHANGED')
            progress('verify_runtime_and_content')
            verify_runtime_after(d, c, before, after, target, h)
            verify_contents(d, after, proof, expected)
            public_smoke(proof)
            config_hashes = {n: digest((target / n).read_bytes()) for n in c['configurationSha256']}
            need(config_hashes['.env.aws.production'] == c['configurationSha256']['.env.aws.production'], 'HOST_ENVIRONMENT_CHANGED')
            receipt = {'status': 'FEATURE_RETIREMENT_DEPLOYED', 'mode': 'release', 'commit': plan['commit'], 'tree': plan['tree'],
                       'runtimeBaseline': plan['runtimeBaseline'], 'before': before['states'], 'after': after,
                       'images': images, 'beforeOnlineBinding': before['binding'], 'expectedInventories': expected,
                       'expectedRuntimeModels': {n: fingerprint(model(inspect(d, after[n]), role=n,
                            caddy_source=str(caddy_path) if n == 'caddy' else None)) for n in AFTER},
                       'configurationSha256': config_hashes, 'workflowRunId': plan['workflowRunId'],
                       'retiredServices': ['auto-registration'], 'businessActions': 0, 'migrationPerformed': False,
                       'backupCreated': False, 'dataDeleted': False}
            write_json(target / 'feature-retirement-preservation.json', receipt)
            (target / 'feature-retirement-build-proof.json').write_bytes(raw_proof)
            manifest = closed_json(before['manifest'])
            projections = copy.deepcopy(manifest.get('roleSourceProjections', {}))
            for role in ('api', 'admin'):
                projections[role] = {'kind': 'PUBLISHED_ROLE_WITH_AUTOMATIC_REGISTRATION_REMOVED',
                    'commit': plan['commit'], 'sourceTree': plan['tree'], 'buildProofSha256': plan['buildProofSha256'],
                    'sourceBaseline': c[role + 'SourceBaseline'], 'previousProjection': projections.get(role)}
            projections.pop('auto-registration', None)
            manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=SCOPE,
                status='DEPLOYED', previousCommit=c['expectedCurrent'], previousRelease=str(previous),
                previousManifestSha256=c['manifestSha256'], servicesUpdated=['api', 'admin', 'caddy'],
                servicesRetired=['auto-registration'], dependentServiceRebound='online-recharge',
                roleSourceProjections=projections, adminSourceProjection=projections['admin'],
                newMigrations=[], migrationPerformed=False, businessActions=0, backupCreated=False, dataDeleted=False,
                buildProofSha256=plan['buildProofSha256'], preservationSha256=digest((target / 'feature-retirement-preservation.json').read_bytes()),
                validationRun=plan['workflowRunId'], compiledArtifact={'url': plan['artifactUrl'], 'sha256': plan['artifactSha256']},
                deploymentMethod='NATIVE_CI_APPROVED_SSM_FORWARD_FEATURE_RETIREMENT')
            for n in ('acceptedSwitchCommandId', 'publicationFinalization', 'deploymentRun', 'actualDeployment', 'backupBeforeRelease'):
                manifest.pop(n, None)
            manifest.setdefault('images', {}).pop('auto-registration', None)
            for role, value in images.items():
                manifest['images'][role] = {'reference': value['reference'], 'digest': value['imageId'], 'sourceCommit': plan['commit']}
            write_json(target / 'release-manifest.json', manifest)
            progress('point_current')
            d.point_current(target, stamp + '-feature-retirement')
            progress('complete', status='DEPLOYED')
            return {n: receipt[n] for n in ('status', 'mode', 'commit', 'tree', 'images', 'workflowRunId', 'businessActions', 'migrationPerformed', 'backupCreated', 'dataDeleted')}
        except Exception as error:
            # A switched component is diagnosed forward; never resurrect the removed feature.
            journal.update(status='NEEDS_FORWARD_DIAGNOSIS', exceptionType=type(error).__name__,
                           code=str(error) if re.fullmatch(r'(?:FEATURE_RETIREMENT|API_ADMIN|RECHARGE_RECORD)_[A-Z0-9_]+', str(error)) else 'COMMAND_FAILED')
            if journal.get('switchStarted'):
                actual = {}
                for role in BEFORE:
                    try:
                        state = d.service_state(Path(journal['target']), role, include_container_id=True, include_environment_hash=True)
                        actual[role] = {n: state.get(n) for n in ('containerId', 'image', 'reference', 'status', 'health', 'startedAtSha256', 'environmentSha256')}
                    except Exception as status_error:
                        actual[role] = {'status': 'UNAVAILABLE', 'exceptionType': type(status_error).__name__}
                journal['actualServices'] = actual
            write_json(state_path, journal)
            raise
