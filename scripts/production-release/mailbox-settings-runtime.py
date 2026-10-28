"""Admin-only mailbox settings repair; API, database and workers stay unchanged."""
import datetime
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import urllib.request

HERE = Path(__file__).resolve().parent
BASE = Path('/opt/id-business-v2')
PREFIX = 'mailbox-settings'
CONTRACT_FILE = PREFIX + '-contract.json'
SCOPE = 'MAILBOX_SETTINGS_INITIAL_STATE_20261028'
CURRENT = '93615a3fe9920c0c7933649c5ceb11e501cac4b0'
ADMIN_PARENT = 'f9a9a4184ba6689abc778ff68e391b1b2dd75834'
SOURCE = 'apps/admin/src/v2/components/workspace/V2ManagedMailboxPanel.vue'


def need(value, code):
    if not value:
        raise RuntimeError('MAILBOX_SETTINGS_' + code)


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
    need(c['scope'] == SCOPE and c['expectedCurrent'] == CURRENT and c['updatedServices'] == ['admin']
         and c['migrationPerformed'] is False and c['businessActions'] == 0
         and set(c['sources']) == {SOURCE}, 'SCOPE_CHANGED')


def verify_proof(proof, plan, c, files):
    validate_contract(c)
    need(all(proof.get(k) == plan[k] for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controlSources', 'qualitySourceEvidence', 'nativeParentCapture')), 'BUILD_PROVENANCE_CHANGED')
    need(proof['scope'] == SCOPE and proof['sources'] == c['sources'] and proof['baselineAdminReproduced'] is True
         and proof['baselineAdminFiles'] == c['baselineAdminFiles'] and proof['migrationPerformed'] is False
         and proof['businessActions'] == 0, 'BUILD_PROOF_CHANGED')
    expected = {'source/' + SOURCE: c['sources'][SOURCE], **{'admin/html/' + n: v for n, v in proof['adminFiles'].items()}}
    need(expected == proof['files'] == files, 'PAYLOAD_SCOPE_CHANGED')


def utilities(c):
    return load('mailbox-validity-runtime.py').utilities(c)


def capture(c, d, h):
    current = (BASE / 'current').resolve()
    manifest = json.loads((current / 'release-manifest.json').read_bytes())
    need(current.parent == BASE / 'releases' and manifest['commit'] == CURRENT and manifest['status'] == 'DEPLOYED', 'CURRENT_CHANGED')
    raw = (current / 'mailbox-validity-build-proof.json').read_bytes()
    need(sha(raw) == c['parentProofSha256'] and json.loads(raw)['commit'] == ADMIN_PARENT, 'PARENT_PROOF_CHANGED')
    prior = json.loads(raw)
    need(prior['adminFiles'] == c['baselineAdminFiles'] and prior['sources'] == c['baselineSources'], 'PARENT_PROJECTION_CHANGED')
    states = h.snapshot(d, current)
    need(all(states[n]['image'] == manifest['images'][n]['digest'] for n in ('api', 'admin')), 'PARENT_IMAGES_CHANGED')
    shared = load('shared-bank-card-release.py')
    for root, files in [('/app/apps/api/dist/', {**prior['apiModules'], **prior['preservedApiDeclarations']}),
                        ('/app/node_modules/.prisma/client/', prior['prismaClientFiles'])]:
        shared.read_hashes(d, states['api']['containerId'], root, files)
    shared.read_hashes(d, states['admin']['containerId'], '/usr/share/nginx/html/', c['baselineAdminFiles'])
    need(all(sha((current / n).read_bytes()) == v for n, v in c['baselineSources'].items()), 'PARENT_SOURCE_CHANGED')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    return {'current': str(current), 'manifestSha256': sha((current / 'release-manifest.json').read_bytes()),
            'services': states, 'configurationSha256': {n: sha((current / n).read_bytes()) for n in c['configurationFiles']},
            'adminConfigurationSha256': h.configuration(d, states['admin'])}


def baseline(parent, c, d, h):
    current = (BASE / 'current').resolve()
    need(str(current) == parent['current'] and sha((current / 'release-manifest.json').read_bytes()) == parent['manifestSha256'], 'CURRENT_CHANGED')
    need(h.snapshot(d, current) == parent['services'] and all(sha((current / n).read_bytes()) == v for n, v in parent['configurationSha256'].items()), 'PARENT_CHANGED')
    return current


def verify_deployed(d, target, parent, proof, image_id, c, h):
    states = h.snapshot(d, target)
    need(all(states[n] == parent['services'][n] for n in states if n != 'admin'), 'PRESERVED_SERVICE_CHANGED')
    need(states['admin']['image'] == image_id and states['admin']['environmentSha256'] == parent['services']['admin']['environmentSha256']
         and h.configuration(d, states['admin']) == parent['adminConfigurationSha256'], 'ADMIN_CONFIGURATION_CHANGED')
    need(all(sha((target / n).read_bytes()) == v for n, v in parent['configurationSha256'].items() if n != 'compose.release.json'), 'PRESERVED_CONFIGURATION_CHANGED')
    load('shared-bank-card-release.py').read_hashes(d, states['admin']['containerId'], '/usr/share/nginx/html/', proof['adminFiles'])
    need(sha((target / SOURCE).read_bytes()) == c['sources'][SOURCE], 'PUBLISHED_SOURCE_CHANGED')


def release(plan, c):
    validate_contract(c)
    need(plan['contractSha256'] == sha((HERE / CONTRACT_FILE).read_bytes())
         and all(sha((HERE / n).read_bytes()) == v for n, v in plan['controlSources'].items()), 'CONTROL_CHANGED')
    d, h = utilities(c)
    with (BASE / '.deploy.lock').open('a') as lock:
        load('recharge-availability-release.py').acquire_release_lock(lock)
        if plan['mode'] == 'parent':
            return {'status': 'MAILBOX_SETTINGS_PARENT_VERIFIED', 'baseline': capture(c, d, h), 'businessActions': 0}
        parent = plan['nativeParentCapture']['baseline']
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve()
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            raw = (target / (PREFIX + '-build-proof.json')).read_bytes()
            need(manifest['commit'] == plan['commit'] and manifest['scope'] == SCOPE and sha(raw) == plan['buildProofSha256'], 'READBACK_CHANGED')
            verify_deployed(d, target, parent, json.loads(raw), manifest['images']['admin']['digest'], c, h)
            return {'status': 'MAILBOX_SETTINGS_READBACK_VERIFIED', 'commit': plan['commit'], 'migrationPerformed': False, 'businessActions': 0}
        current = baseline(parent, c, d, h)
        if plan['mode'] == 'preflight':
            return {'status': 'MAILBOX_SETTINGS_PREFLIGHT_VERIFIED', 'businessActions': 0}
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
        ref = 'id-business-v2-mailbox-settings:' + plan['commit'] + '-' + plan['workflowRunId']
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
        need((target / SOURCE).resolve().is_relative_to(target) and not (target / SOURCE).is_symlink(), 'HOST_SOURCE_PATH_CHANGED')
        (target / SOURCE).write_bytes((payload / 'source' / SOURCE).read_bytes())
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
        return {'status': 'MAILBOX_SETTINGS_DEPLOYED', 'commit': plan['commit'], 'migrationPerformed': False, 'businessActions': 0}
