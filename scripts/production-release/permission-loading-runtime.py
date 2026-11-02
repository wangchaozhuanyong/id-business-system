"""Admin-only mailbox settings repair; API, database and workers stay unchanged."""
import datetime
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import shutil
import urllib.request

HERE = Path(__file__).resolve().parent
BASE = Path('/opt/id-business-v2')
PREFIX = 'permission-loading'
CONTRACT_FILE = PREFIX + '-contract.json'
SCOPE = 'PERMISSION_LOADING_ACTIVATION_20261102'
CURRENT = 'dc957e0553301efe49d76142aeb287b0f1c8333d'
ADMIN_PARENT = '42443056ac7d17b1a8c9146da62a6439755b234a'
SOURCES = ('apps/admin/src/v2/components/asyncRegionState.ts', 'apps/admin/src/v2/components/V2AsyncRegion.vue', 'apps/admin/src/v2/features/proxy-pool/V2ProxyPoolView.vue')
HOST_SOURCE_PRESENCE = {SOURCES[0]: False, SOURCES[1]: True, SOURCES[2]: False}


def need(value, code):
    if not value:
        raise RuntimeError('PERMISSION_LOADING_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location('mailbox_settings_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_contract(c):
    need(c['version'] == 1 and c['scope'] == SCOPE and c['expectedCurrent'] == CURRENT
         and c['updatedServices'] == ['admin'] and c['migrationPerformed'] is False
         and type(c['businessActions']) is int and c['businessActions'] == 0
         and set(c['sources']) == set(SOURCES)
         and c['baselineHostSourcePresence'] == HOST_SOURCE_PRESENCE
         and all(type(v) is bool for v in c['baselineHostSourcePresence'].values())
         and c['hostSourceObservationRunId'] == 41491628317
         and c['baselineAdminCommit'] == ADMIN_PARENT
         and c['awsAccount'] == '098208446664', 'SCOPE_CHANGED')


def verify_proof(proof, plan, c, files):
    validate_contract(c)
    need(all(proof.get(k) == plan[k] for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controlSources', 'qualitySourceEvidence', 'nativeParentCapture')), 'BUILD_PROVENANCE_CHANGED')
    need(proof['scope'] == SCOPE and proof['sources'] == c['sources'] and proof['baselineAdminReproduced'] is True
         and proof['baselineAdminFiles'] == c['baselineAdminFiles'] and proof['migrationPerformed'] is False
         and proof['businessActions'] == 0, 'BUILD_PROOF_CHANGED')
    expected = {**{'source/' + n: v for n, v in c['sources'].items()}, **{'admin/html/' + n: v for n, v in proof['adminFiles'].items()}}
    need(expected == proof['files'] == files, 'PAYLOAD_SCOPE_CHANGED')


def utilities(c):
    history = load('bitbrowser-history-release.py')
    history.MODULES = frozenset()
    h, d, retired = history.helpers()
    return d, h


def host_source_inventory(current, c):
    result = {}
    for name in SOURCES:
        path = current / name
        need(path.parent.resolve().is_relative_to(current) and not path.is_symlink(), 'PARENT_HOST_SOURCE_LINK')
        if c['baselineHostSourcePresence'][name]:
            need(path.is_file(), 'PARENT_HOST_SOURCE_MISSING')
            result[name] = sha(path.read_bytes())
        else:
            need(not path.exists(), 'PARENT_HOST_SOURCE_APPEARED')
            result[name] = None
    return result


def write_candidate_sources(target, payload):
    for name in SOURCES:
        path = target / name
        need(path.parent.resolve().is_relative_to(target) and not path.is_symlink(), 'HOST_SOURCE_PATH_CHANGED')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes((payload / 'source' / name).read_bytes())


def capture(c, d, h, diagnostics=None):
    def stage(name):
        if diagnostics is not None:
            diagnostics['stage'] = name
    stage('MANIFEST')
    current = (BASE / 'current').resolve(strict=True)
    manifest = json.loads((current / 'release-manifest.json').read_bytes())
    need(current.parent == BASE / 'releases' and manifest['commit'] == CURRENT
         and manifest['status'] == 'DEPLOYED', 'CURRENT_CHANGED')
    stage('SERVICES')
    states = h.snapshot(d, current)
    need(set(states) == set(c['preservedServices']) | {'admin'}
         and all(states[n]['image'] == manifest['images'][n]['digest'] for n in ('api', 'admin')), 'PARENT_IMAGES_CHANGED')
    stage('RUNTIME')
    history = load('bitbrowser-history-release.py')
    history.MODULES = frozenset()
    runtime = history.runtime(d, states)
    need(runtime == c['baselineRuntime'], 'PARENT_RUNTIME_CHANGED')
    stage('ADMIN_FILES')
    shared = load('shared-bank-card-release.py')
    shared.read_hashes(d, states['admin']['containerId'], '/usr/share/nginx/html/', c['baselineAdminFiles'])
    stage('HOST_SOURCES')
    host_sources = host_source_inventory(current, c)
    stage('DISK')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    stage('CONFIGURATION')
    names = ('.env.aws.production', 'docker-compose.aws-mysql.yml', 'compose.release.json', 'deploy/caddy/Caddyfile.aws', 'apps/api/prisma-mysql/schema.prisma')
    return {'current': str(current), 'manifestSha256': sha((current / 'release-manifest.json').read_bytes()),
            'services': states, 'runtime': runtime, 'hostSourceSha256': host_sources,
            'configurationSha256': {n: sha((current / n).read_bytes()) for n in names},
            'adminConfigurationSha256': h.configuration(d, states['admin'])}


def inspect_parent(c, d, h):
    """Read-only bounded diagnostics; never return exception messages or file contents."""
    result = {'status': 'PERMISSION_LOADING_PARENT_DIAGNOSED', 'businessActions': 0,
              'releaseAuthority': False, 'stage': 'MANIFEST', 'baselineCaptured': False}
    try:
        capture(c, d, h, result)
        result['baselineCaptured'] = True
    except Exception as error:
        result['exceptionType'] = type(error).__name__
        code = str(error)
        if re.fullmatch('(?:PERMISSION_LOADING|RECHARGE_RECORD|BITBROWSER_HISTORY|SHARED_BANK_CARD|ONLINE_QUERY_NETWORK)_[A-Z0-9_]+', code):
            result['controlledCode'] = code
        frames = []
        trace = error.__traceback__
        while trace:
            frames.append({'file': Path(trace.tb_frame.f_code.co_filename).name,
                           'function': trace.tb_frame.f_code.co_name, 'line': trace.tb_lineno})
            trace = trace.tb_next
        result['frames'] = frames[-3:]
    current = (BASE / 'current').resolve()
    result['hostSourcePresence'] = {n: (current / n).is_file() for n in SOURCES}
    result['configurationPresence'] = {n: (current / n).is_file() for n in (
        '.env.aws.production', 'docker-compose.aws-mysql.yml', 'compose.release.json',
        'deploy/caddy/Caddyfile.aws', 'apps/api/prisma-mysql/schema.prisma')}
    return result


def baseline(parent, c, d, h):
    current = (BASE / 'current').resolve()
    need(str(current) == parent['current'] and sha((current / 'release-manifest.json').read_bytes()) == parent['manifestSha256'], 'CURRENT_CHANGED')
    need(h.snapshot(d, current) == parent['services'] and all(sha((current / n).read_bytes()) == v for n, v in parent['configurationSha256'].items()), 'PARENT_CHANGED')
    need(host_source_inventory(current, c) == parent['hostSourceSha256'], 'PARENT_HOST_SOURCE_CHANGED')
    return current


def verify_deployed(d, target, parent, proof, image_id, c, h):
    states = h.snapshot(d, target)
    need(all(states[n] == parent['services'][n] for n in states if n != 'admin'), 'PRESERVED_SERVICE_CHANGED')
    need(states['admin']['image'] == image_id and states['admin']['environmentSha256'] == parent['services']['admin']['environmentSha256']
         and h.configuration(d, states['admin']) == parent['adminConfigurationSha256'], 'ADMIN_CONFIGURATION_CHANGED')
    need(all(sha((target / n).read_bytes()) == v for n, v in parent['configurationSha256'].items() if n != 'compose.release.json'), 'PRESERVED_CONFIGURATION_CHANGED')
    load('shared-bank-card-release.py').read_hashes(d, states['admin']['containerId'], '/usr/share/nginx/html/', proof['adminFiles'])
    need(all(sha((target / n).read_bytes()) == v for n, v in c['sources'].items()), 'PUBLISHED_SOURCE_CHANGED')
    history = load('bitbrowser-history-release.py')
    history.MODULES = frozenset()
    actual = history.runtime(d, states)
    need(all(actual[n] == parent['runtime'][n] for n in parent['runtime'] if n != 'adminInventory'), 'API_RUNTIME_CHANGED')


def release(plan, c):
    validate_contract(c)
    need(plan['contractSha256'] == sha((HERE / CONTRACT_FILE).read_bytes())
         and all(sha((HERE / n).read_bytes()) == v for n, v in plan['controlSources'].items()), 'CONTROL_CHANGED')
    d, h = utilities(c)
    with (BASE / '.deploy.lock').open('a') as lock:
        load('recharge-availability-release.py').acquire_release_lock(lock)
        if plan['mode'] == 'inspect-parent':
            return inspect_parent(c, d, h)
        if plan['mode'] == 'parent':
            return {'status': 'PERMISSION_LOADING_PARENT_VERIFIED', 'baseline': capture(c, d, h), 'businessActions': 0}
        parent = plan['nativeParentCapture']['baseline']
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve()
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            raw = (target / (PREFIX + '-build-proof.json')).read_bytes()
            need(manifest['commit'] == plan['commit'] and manifest['scope'] == SCOPE and sha(raw) == plan['buildProofSha256'], 'READBACK_CHANGED')
            verify_deployed(d, target, parent, json.loads(raw), manifest['images']['admin']['digest'], c, h)
            return {'status': 'PERMISSION_LOADING_READBACK_VERIFIED', 'commit': plan['commit'], 'migrationPerformed': False, 'businessActions': 0}
        current = baseline(parent, c, d, h)
        if plan['mode'] == 'preflight':
            return {'status': 'PERMISSION_LOADING_PREFLIGHT_VERIFIED', 'businessActions': 0}
        need(plan['mode'] == 'release', 'MODE_INVALID')
        stage = BASE / '.staging' / (PREFIX + '-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        expected_url = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/' + PREFIX + '-' + plan['commit'] + '/' + PREFIX + '-artifact.tar.gz'
        need(plan['artifactUrl'] == expected_url, 'ARTIFACT_LOCATION_CHANGED')
        with urllib.request.urlopen(expected_url, timeout=60) as response:
            raw = response.read(40 * 1024**2 + 1)
        need(len(raw) < 40 * 1024**2 and sha(raw) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        shared = load('shared-bank-card-release.py')
        payload = shared.safe_archive(raw, stage / 'content')
        proof_raw = (payload / 'build-proof.json').read_bytes()
        need(sha(proof_raw) == plan['buildProofSha256'], 'BUILD_PROOF_CHANGED')
        proof = json.loads(proof_raw)
        files = h.file_inventory(payload)
        files.pop('build-proof.json')
        verify_proof(proof, plan, c, files)
        context = stage / 'image-admin'
        shutil.copytree(payload / 'admin/html', context / 'html')
        load('recharge-availability-release.py').normalize_image_context(context)
        ref = 'id-business-v2-permission-loading:' + plan['commit'] + '-' + plan['workflowRunId']
        (context / 'Dockerfile').write_text('FROM ' + h.base_image_reference(d, parent['services']['admin'])
            + '\nCOPY html/ /usr/share/nginx/html/\nLABEL org.opencontainers.image.revision="' + plan['commit']
            + '" id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n')
        h.build_image(d, context, ref, 'admin', parent['services']['admin'], stage)
        image = json.loads(d.run('docker', 'image', 'inspect', ref))[0]
        shared.verify_image(json.loads(d.run('docker', 'image', 'inspect', parent['services']['admin']['image']))[0], image, plan)
        prefix = '/usr/share/nginx/html/'
        output = d.run('docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'sha256sum', ref,
                       *(prefix + name for name in proof['adminFiles']), timeout=60)
        actual = {line.split('  ', 1)[1].removeprefix(prefix): line.split('  ', 1)[0] for line in output.splitlines()}
        need(actual == proof['adminFiles'], 'IMAGE_CONTENT_CHANGED')
        current = baseline(parent, c, d, h)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-' + PREFIX)
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(current, target, symlinks=True)
        write_candidate_sources(target, payload)
        for name in plan['controlSources']:
            (target / 'scripts/production-release' / name).write_bytes((HERE / name).read_bytes())
        override = json.loads((target / 'compose.release.json').read_bytes())
        override['services']['admin']['image'] = ref
        (target / 'compose.release.json').write_text(json.dumps(override, sort_keys=True, indent=2) + '\n')
        (target / 'compose.release.json').chmod(0o600)
        baseline(parent, c, d, h)
        journal = stage / 'switch-state.json'
        journal.write_text(json.dumps({'status': 'STARTED', 'target': str(target)}) + '\n')
        try:
            load('dependency-security-runtime.py').latest_main(plan['commit'])
            d.compose(target, 'up', '-d', '--no-deps', 'admin', timeout=180)
            d.wait_healthy(target, 'admin')
            verify_deployed(d, target, parent, proof, image['Id'], c, h)
        except BaseException:
            journal.write_text(json.dumps({'status': 'FAILED', 'target': str(target), 'businessActions': 0}) + '\n')
            raise
        manifest = json.loads((current / 'release-manifest.json').read_bytes())
        manifest.update(commit=plan['commit'], applicationCommit=plan['commit'], controlCommit=plan['commit'], version='v2-' + plan['commit'],
            sourceTree=plan['tree'], sourceBranch='main', scope=SCOPE, previousCommit=CURRENT, previousRelease=str(current), status='DEPLOYED',
            servicesUpdated=['admin'], servicesRebound=[], newMigrations=[], migrationPerformed=False, paymentActions=0)
        manifest['images']['admin'] = {'reference': ref, 'digest': image['Id'], 'sourceCommit': plan['commit']}
        projections = manifest.setdefault('roleSourceProjections', {})
        projections['admin'] = {'kind': SCOPE, 'commit': plan['commit'], 'parentProjection': projections.get('admin'),
                                'buildProofSha256': plan['buildProofSha256'], 'sources': c['sources']}
        (target / (PREFIX + '-build-proof.json')).write_bytes(proof_raw)
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-' + PREFIX)
        journal.write_text(json.dumps({'status': 'DEPLOYED', 'commit': plan['commit']}) + '\n')
        return {'status': 'PERMISSION_LOADING_DEPLOYED', 'commit': plan['commit'], 'migrationPerformed': False, 'businessActions': 0}
