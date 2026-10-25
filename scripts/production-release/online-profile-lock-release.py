"""Finite host-control publication and offline profile recovery; retain all images."""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import traceback
import urllib.request

HERE = Path(__file__).resolve().parent
BASE = Path('/opt/id-business-v2')
PREFIX = 'online-profile-lock'
SCOPE = 'ONLINE_PROFILE_LOCK_RECOVERY_20261025'
CURRENT = '034f737d551412928e99f589370b937f2b263593'
SOURCE = '4d2a6001b24452640c10255ffe775221b3591b04'
SOURCE_TREE = 'a30e444771fc7ce1a9eae448923cb441b464628b'
CONTRACT_FILE = PREFIX + '-contract.json'
UPDATED = ('api', 'online-recharge')
PRESERVED = ('admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge')
SERVICES = (*UPDATED, *PRESERVED)
SEALED = {'sources': '10cfbdbdda55a8bc3a535a97490a6cdcbaf1f8382cc1889fecff3d0242e45006',
          'expectedImages': '9940d75486da717a7c953acc2cc84069f2305160a55a2315bcf87b7aa00d5e97',
          'engineFiles': '55ce8ffd86e45424c7d8ccf3e7bd2c0d186a1db77e37c9443fd4a134062c00a5',
          'apiFiles': 'bfa992316eeb42c6c36872f9143fa0ac8d8b8cac1fcf001484586143bb2f11b7',
          'adminFiles': '01d14361018ee8cfe13f7fc6d16c33197476853b9f550be1d84e8557b27b4024',
          'availabilityRecovery': 'adf8734c754247be57db47e2b2cdf31e4feff1289cb1eea13d78f49a10382298'}


def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_PROFILE_LOCK_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location('profile_lock_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if name in ('recharge-record-release.py', 'proxy-result-identity-release.py'):
        # Match the deployed publisher's retired-registration boundary. The
        # legacy marker requires a volume that the current API must not mount.
        retired = load('online-query-network-release.py')
        retired.BASE, retired.SCOPE, retired.SERVICES = BASE, SCOPE, SERVICES
        if name == 'recharge-record-release.py':
            module.SERVICES = SERVICES
            module.guards = lambda d, directory, states, c: retired.retired_guards(d, directory, states, c, module)
        else:
            module.claim_markers = retired.claim_retired_markers
    return module


def validate_contract(c):
    need(c.get('version') == 1 and c.get('scope') == SCOPE and c.get('expectedCurrent') == CURRENT
         and c.get('sourceReviewCommit') == SOURCE and c.get('sourceReviewTree') == SOURCE_TREE
         and c.get('sourcePullRequest') == 717, 'CONTRACT_IDENTITY')
    need(c.get('updatedServices') == list(UPDATED) and c.get('preservedServices') == list(PRESERVED)
         and c.get('awsTargetAccount') == '098208446664'
         and c.get('awsTargetInstance') == 'i-0838cebf64f0e2a89'
         and c.get('migrationPerformed') is False and type(c.get('businessActions')) is int
         and c['businessActions'] == 0, 'SIDE_EFFECT_SCOPE')
    need(all(sha(canonical(c.get(key))) == digest for key, digest in SEALED.items()), 'CONTENT_CHANGED')
    parent = c['parentArtifact']
    need(parent['artifactSha256'] == '61864e0ed7a618a9aea4af3e299ae3e710347eed4aba1c4586fad9f1ee9a3dff'
         and parent['buildProofSha256'] == '44b8a3ad814351478382c66795f8cf4df20d47890ed13cf5553f316f8fddf270'
         and parent['artifactUrl'] == 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/online-country-evidence-' + CURRENT + '/online-country-evidence-artifact.tar.gz', 'PARENT_CHANGED')
    need(c['sqlFenceHelperSha256'] == c['controlPins']['api-admin-scope.py'] ==
         '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925', 'FENCE_CHANGED')


def verify_quality(q, commit, tree):
    need(q.get('commit') == commit and q.get('tree') == tree
         and q.get('source', {}).get('head') == SOURCE and q['source'].get('tree') == SOURCE_TREE
         and q['source'].get('pullRequest') == 717 and q.get('control', {}).get('pullRequest', 0) > 717
         and q['control'].get('tree') == tree and q.get('main', {}).get('head') == commit, 'QUALITY_REQUIRED')
    for part in ('source', 'control'):
        need(re.fullmatch('[a-f0-9]{40}', q[part].get('head', ''))
             and re.fullmatch('[a-f0-9]{64}', q[part].get('sourceReceiptSha256', ''))
             and re.fullmatch('[1-9][0-9]*', q[part].get('runId', '')), 'QUALITY_RECEIPT_REQUIRED')


def helpers(c):
    h = load('recharge-record-release.py')
    h.SERVICES = SERVICES
    d = h.load_utilities(HERE / 'remote-deploy.py', c['controlPins']['remote-deploy.py'])
    p = load('online-checkout-release.py')
    return h, d, p


def content(d, states, c, h, p):
    need(set(states) == set(SERVICES) and all(states[n]['image'] == c['expectedImages'][n]
         and states[n]['status'] == 'running' and states[n]['health'] in ('healthy', None) for n in SERVICES),
         'RUNTIME_IMAGES_CHANGED')
    p.read_hashes(d, states['admin']['containerId'], '/usr/share/nginx/html/', c['adminFiles'])
    p.read_hashes(d, states['api']['containerId'], '/app/apps/api/dist/', c['apiFiles'])
    load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], c['engineFiles'])


def capture(d, c, h, p):
    previous = (BASE / 'current').resolve(strict=True)
    need(previous.parent == BASE / 'releases', 'CURRENT_PATH')
    raw = (previous / 'release-manifest.json').read_bytes()
    manifest = json.loads(raw)
    need(manifest['commit'] == CURRENT and manifest['status'] == 'DEPLOYED', 'CURRENT_CHANGED')
    need(sha((previous / 'online-checkout-build-proof.json').read_bytes()) == c['parentArtifact']['buildProofSha256'],
         'PUBLISHED_PROOF_CHANGED')
    receipt = json.loads((previous / 'online-checkout-preservation.json').read_bytes())
    states = h.snapshot(d, previous)
    need(receipt['commit'] == CURRENT and receipt['artifactSha256'] == c['parentArtifact']['artifactSha256']
         and receipt['buildProofSha256'] == c['parentArtifact']['buildProofSha256'],
         'PARENT_SERVICES_CHANGED')
    verify_availability_recovery(c, previous, states, receipt['after'], sha(raw))
    h.guards(d, previous, states, c)
    content(d, states, c, h, p)
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    return {'current': str(previous), 'expectedCurrent': CURRENT, 'manifestSha256': sha(raw),
            'availabilityRecoverySha256': c['availabilityRecovery']['sha256'],
            'services': states, 'configurationSha256': {name: sha((previous / name).read_bytes())
                for name in ('.env.aws.production', 'compose.release.json', 'docker-compose.aws-mysql.yml')},
            'runtimeConfigurationSha256': {name: h.configuration(d, value) for name, value in states.items()}}


def verify_availability_recovery(c, previous, states, original, manifest_sha):
    # Keep the old preservation receipt immutable. Admit only the exact native
    # proof of restoring these same containers, not arbitrary startup drift.
    expected = c['availabilityRecovery']
    path = Path(expected['path'])
    need(path.is_relative_to(BASE / '.staging') and not path.is_symlink(), 'RECOVERY_PATH_CHANGED')
    raw = path.read_bytes()
    need(sha(raw) == expected['sha256'], 'RECOVERY_RECEIPT_CHANGED')
    value = json.loads(raw)
    need(value.get('status') == 'ORIGINAL_SERVICE_AVAILABILITY_RESTORED'
         and value.get('operation') == 'DOCKER_START_EXACT_ORIGINAL'
         and value.get('source') == expected['source'] and value.get('originalCommit') == expected['originalCommit']
         and value.get('originalRun') == expected['originalRun'] and value.get('current') == str(previous)
         and value.get('manifestSha256') == manifest_sha and value.get('before') == original
         and value.get('after') == states and value.get('imagesChanged') is False
         and value.get('pointerChanged') is False and type(value.get('businessActions')) is int
         and value['businessActions'] == 0 and set(states) == set(SERVICES), 'RECOVERY_RECEIPT_CHANGED')
    need(all(states[n] == original[n] for n in PRESERVED)
         and all({k: v for k, v in states[n].items() if k != 'startedAtSha256'} ==
                 {k: v for k, v in original[n].items() if k != 'startedAtSha256'} for n in UPDATED),
         'RECOVERY_SERVICE_CHANGED')


def verify_proof(proof, plan, c, files):
    validate_contract(c)
    need(proof.get('version') == 1 and proof.get('scope') == SCOPE
         and all(proof.get(key) == plan.get(key) for key in ('commit', 'tree', 'workflowRunId',
             'workflowRunAttempt', 'contractSha256', 'controlSources', 'qualitySourceEvidence', 'nativeParentCapture'))
         and proof.get('sources') == c['sources'] and proof.get('imagesRebuilt') is False
         and proof.get('migrationPerformed') is False and proof.get('businessActions') == 0, 'PROOF_CHANGED')
    verify_quality(proof['qualitySourceEvidence'], plan['commit'], plan['tree'])
    need(proof['nativeParentCapture']['status'] == 'ONLINE_PROFILE_LOCK_PARENT_VERIFIED'
         and proof['nativeParentCapture']['baseline']['expectedCurrent'] == CURRENT, 'PARENT_REQUIRED')
    need(files == proof.get('files') == {'source/' + name: digest for name, digest in c['sources'].items()},
         'PAYLOAD_SCOPE_CHANGED')


def verify_after(d, target, before, c, h, p, baseline):
    after = h.snapshot(d, target)
    need(all(after[n] == before[n] for n in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
    need(all({k: v for k, v in after[n].items() if k != 'startedAtSha256'} ==
             {k: v for k, v in before[n].items() if k != 'startedAtSha256'} for n in UPDATED), 'CONTAINER_CHANGED')
    need(all(h.configuration(d, state) == baseline['runtimeConfigurationSha256'][name]
             for name, state in after.items()), 'RUNTIME_CONFIGURATION_CHANGED')
    content(d, after, c, h, p)
    return after


def start_existing(d, directory, before):
    # Retain exact containers, images, namespace target IDs and all configuration.
    for role in UPDATED:
        # The generic service_state uses `compose ps -q`, which omits stopped
        # containers. Inspect the exact original selection before starting it.
        selected = d.compose(directory, 'ps', '--all', '--quiet', role).strip()
        need(selected == before[role]['containerId'], 'CONTAINER_CHANGED')
        rows = json.loads(d.run('docker', 'inspect', selected))
        need(type(rows) is list and len(rows) == 1, 'CONTAINER_CHANGED')
        row = rows[0]
        env = row.get('Config', {}).get('Env')
        need(row.get('Id') == selected and row.get('Image') == before[role]['image']
             and row['Config'].get('Image') == before[role]['reference']
             and type(env) is list and bool(env) and all(type(value) is str for value in env)
             and d.historical_fingerprint(sorted(env)) == before[role]['environmentSha256']
             and row.get('State', {}).get('Status') in ('running', 'exited'), 'CONTAINER_CHANGED')
        if row['State']['Status'] == 'exited':
            # Do not expand Compose's service/dependency graph during recovery.
            # The selection, image, reference and environment were checked above.
            d.run('docker', 'start', selected, timeout=90)
        d.wait_healthy(directory, role)


def release(plan, c):
    validate_contract(c)
    need(plan['mode'] in ('parent', 'preflight', 'release', 'readback') and re.fullmatch('[a-f0-9]{40}', plan['commit'])
         and re.fullmatch('[a-f0-9]{40}', plan['tree'])
         and re.fullmatch('[1-9][0-9]*', plan.get('workflowRunId', ''))
         and re.fullmatch('[1-9][0-9]*', plan.get('workflowRunAttempt', '')), 'PLAN_INVALID')
    need(sha((HERE / CONTRACT_FILE).read_bytes()) == plan['contractSha256']
         and plan['controlSources'] == {**c['controlPins'], CONTRACT_FILE: plan['contractSha256']}
         and all(sha((HERE / name).read_bytes()) == digest for name, digest in plan['controlSources'].items()),
         'CONTROL_CHANGED')
    h, d, p = helpers(c)
    with (BASE / '.deploy.lock').open('a') as lock:
        load('recharge-availability-release.py').acquire_release_lock(lock)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve(strict=True)
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            receipt = json.loads((target / (PREFIX + '-preservation.json')).read_bytes())
            need(manifest['commit'] == plan['commit'] and manifest['scope'] == SCOPE
                 and receipt['commit'] == plan['commit'] and h.snapshot(d, target) == receipt['after']
                 and sha((target / (PREFIX + '-build-proof.json')).read_bytes()) == plan['buildProofSha256'], 'READBACK_CHANGED')
            content(d, receipt['after'], c, h, p)
            h.guards(d, target, receipt['after'], c)
            return {'status': 'ONLINE_PROFILE_LOCK_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'],
                    'profileLockRecovery': receipt['profileLockRecovery'], 'imagesRebuilt': False, 'businessActions': 0}
        baseline = capture(d, c, h, p)
        if plan['mode'] == 'parent':
            return {'status': 'ONLINE_PROFILE_LOCK_PARENT_VERIFIED', 'baseline': baseline, 'businessActions': 0}
        need(plan.get('nativeParentCapture', {}).get('baseline') == baseline, 'PARENT_MOVED')
        if plan['mode'] == 'preflight':
            return {'status': 'ONLINE_PROFILE_LOCK_PREFLIGHT_VERIFIED', 'commit': plan['commit'], 'businessActions': 0}
        expected = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/' + PREFIX + '-' + plan['commit'] + '/' + PREFIX + '-artifact.tar.gz'
        need(plan['artifactUrl'] == expected, 'ARTIFACT_LOCATION')
        with urllib.request.urlopen(expected, timeout=60) as response:
            raw = response.read(2 * 1024**2 + 1)
        need(len(raw) <= 2 * 1024**2 and sha(raw) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        stage = BASE / '.staging' / (PREFIX + '-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        payload = h.safe_archive(raw, stage / 'content')
        proofraw = (payload / 'build-proof.json').read_bytes()
        need(sha(proofraw) == plan['buildProofSha256'], 'PROOF_CHANGED')
        proof = json.loads(proofraw)
        files = h.file_inventory(payload)
        files.pop('build-proof.json')
        verify_proof(proof, plan, c, files)
        previous = Path(baseline['current'])
        backup = h.fresh_scoped_backup(d, previous, plan, normalizer_path=Path(c['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        need(capture(d, c, h, p) == baseline, 'PARENT_MOVED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-profile-lock')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(previous, target, symlinks=True)
        for name in c['sources']:
            destination = target / name
            need(destination.resolve().is_relative_to(target) and not destination.is_symlink(), 'SOURCE_PATH_INVALID')
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((payload / 'source' / name).read_bytes())
        for name in plan['controlSources']:
            (target / 'scripts/production-release' / name).write_bytes((HERE / name).read_bytes())
        owner = load('proxy-result-identity-release.py')
        owner.SCOPE = SCOPE
        fence = owner.sql_fence_class(c)(d, previous)
        marker = owner.claim_markers(d, baseline['services'], plan)
        journal = stage / 'switch-state.json'
        journal.write_text(json.dumps({'status': 'STARTED', 'commit': plan['commit']}) + '\n')
        try:
            fence.acquire()
            recovery = p.profile_recovery_source(plan)
            recovered = p.stop_recharge_and_recover(d, previous, baseline['services'], lock, fence, recovery)
            start_existing(d, target, baseline['services'])
            after = verify_after(d, target, baseline['services'], c, h, p, baseline)
        except BaseException as error:
            fence.close()
            # Restore service availability only: same containers and images, no code/data rollback.
            restored = False
            try:
                need((BASE / 'current').resolve() == previous, 'CURRENT_CHANGED')
                start_existing(d, previous, baseline['services'])
                verify_after(d, previous, baseline['services'], c, h, p, baseline)
                restored = True
            finally:
                journal.write_text(json.dumps({'status': 'FAILED', 'servicesRestored': restored,
                                               'failure': failure_report(error, plan),
                                               'businessActions': 0}) + '\n')
                if restored:
                    owner.release_markers(marker)
            raise
        finally:
            fence.close()
        owner.release_markers(marker)
        h.guards(d, target, after, c)
        receipt = {'status': 'DEPLOYED', 'commit': plan['commit'], 'before': baseline['services'], 'after': after,
                   'profileLockRecovery': recovered, 'imagesRebuilt': False, 'backup': backup,
                   'artifactSha256': plan['artifactSha256'], 'buildProofSha256': plan['buildProofSha256'],
                   'preservedServices': list(PRESERVED), 'migrationPerformed': False, 'businessActions': 0}
        (target / (PREFIX + '-preservation.json')).write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
        (target / (PREFIX + '-build-proof.json')).write_bytes(proofraw)
        manifest = json.loads((previous / 'release-manifest.json').read_bytes())
        manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=SCOPE,
                        previousCommit=CURRENT, previousRelease=str(previous), previousManifestSha256=baseline['manifestSha256'],
                        status='DEPLOYED', servicesUpdated=list(UPDATED), newMigrations=[], migrationPerformed=False,
                        paymentActions=0, profileLockPublication=receipt)
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-profile-lock')
        journal.write_text(json.dumps({'status': 'DEPLOYED', 'commit': plan['commit'], 'businessActions': 0}) + '\n')
        return {'status': 'ONLINE_PROFILE_LOCK_DEPLOYED', 'commit': plan['commit'], 'profileLockRecovery': recovered,
                'imagesRebuilt': False, 'preservedServices': list(PRESERVED), 'migrationPerformed': False, 'businessActions': 0}


def failure_report(error, plan):
    code = str(error) if re.fullmatch(r'(?:ONLINE_PROFILE_LOCK|ONLINE_CHECKOUT_PROFILE|ONLINE_QUERY_NETWORK)_[A-Z_]{1,100}', str(error)) else 'ONLINE_PROFILE_LOCK_UNCONFIRMED'
    kind = type(error).__name__
    allowed = ('RuntimeError', 'CalledProcessError', 'TimeoutExpired', 'FileNotFoundError',
               'PermissionError', 'AttributeError', 'KeyError', 'TypeError', 'ValueError', 'JSONDecodeError')
    frames = [{'file': Path(frame.filename).name, 'line': frame.lineno}
              for frame in traceback.extract_tb(error.__traceback__)
              if Path(frame.filename).name in plan.get('controlSources', {})][-4:]
    return {'status': 'FAILED', 'code': code, 'mode': plan.get('mode'),
            'errorClass': kind if kind in allowed else 'OTHER', 'sourceFrames': frames, 'businessActions': 0}
