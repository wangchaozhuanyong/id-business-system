"""Finite, forward-only API dependency layer. No migration or automatic rollback."""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import urllib.request

HERE = Path(__file__).resolve().parent
BASE = Path('/opt/id-business-v2')
PREFIX = 'dependency-security'
CONTRACT_FILE = PREFIX + '-contract.json'
SCOPE = 'DEPENDENCY_SECURITY_20261101'


def need(value, code):
    if not value:
        raise RuntimeError('DEPENDENCY_SECURITY_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location('dependency_runtime_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_contract(c):
    load('dependency-security-publication.py').validate(c)
    need(c['scope'] == SCOPE and c['updatedServices'] == ['api'] and c['reboundServices'] == ['online-recharge']
         and c['baselineSha256'] == sha(canonical(c['baseline']))
         and set(c['afterVersions']) == set(c['packageDirectories']), 'PUBLICATION_SCOPE_CHANGED')
    need(c['baselineSha256'] == BASELINE_SHA, 'FROZEN_BASELINE_CHANGED')


BASELINE_SHA = 'e099a90311facad7f09b257bc4fae05188a3836312676d2672d04bf32c0420b3'


def roots(names):
    return sorted(n for n in names if not any(n.startswith(p + '/') for p in names if p != n))


def package_roots(c):
    active = [n for n in c['packageDirectories'] if c['baseline']['dependencies']['inventory'][n] is not None or c['afterVersions'][n] is not None]
    return roots(active)


def verify_quality(q, plan, c):
    need(q.get('commit') == plan['commit'] and q.get('tree') == plan['tree']
         and all(q.get('source', {}).get(n) == v for n, v in c['sourceReview'].items())
         and q.get('control', {}).get('main') == plan['commit'] and q['control'].get('tree') == plan['tree']
         and type(q['control'].get('pullRequest')) is int and q['control']['pullRequest'] > 766
         and q.get('main', {}).get('head') == plan['commit'], 'QUALITY_REQUIRED')
    for group in ('source', 'control'):
        need(re.fullmatch('[a-f0-9]{40}', q[group].get('head', ''))
             and re.fullmatch('[a-f0-9]{64}', q[group].get('sourceReceiptSha256', ''))
             and re.fullmatch('[1-9][0-9]*', q[group].get('runId', '')), 'QUALITY_RECEIPT_REQUIRED')
    need(re.fullmatch('[1-9][0-9]*', q['main'].get('runId', '')), 'MAIN_QUALITY_REQUIRED')


def verify_proof(proof, plan, c, files):
    validate_contract(c)
    keys = ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controlSources', 'qualitySourceEvidence')
    need(all(proof.get(n) == plan[n] for n in keys) and proof['scope'] == SCOPE
         and proof['baselineSha256'] == c['baselineSha256'] and proof['sources'] == c['sources']
         and proof['packageRoots'] == package_roots(c) and proof['packageVersions'] == c['afterVersions']
         and proof['migrationPerformed'] is False and type(proof['businessActions']) is int
         and proof['businessActions'] == 0 and proof['files'] == files, 'BUILD_PROOF_CHANGED')
    fixed = {**{'source/' + n: v for n, v in c['sources'].items()},
             'probes/dependency-security-regressions.test.mjs': c['probeSha256']}
    need(all(files.get(n) == v for n, v in fixed.items()), 'SOURCE_OR_PROBE_CHANGED')
    allowed = ['packages/' + n + '/' for n in proof['packageRoots'] if c['afterVersions'][n] is not None]
    need(all(n in fixed or any(n.startswith(p) for p in allowed) for n in files)
         and all('packages/' + n + '/package.json' in files for n in proof['packageRoots'] if c['afterVersions'][n] is not None), 'PAYLOAD_SCOPE_CHANGED')
    verify_quality(proof['qualitySourceEvidence'], plan, c)


def utilities():
    history = load('bitbrowser-history-release.py')
    history.MODULES = frozenset()
    h, d, retired = history.helpers()
    return history, h, d, retired


def baseline(c, history, h, d):
    b = c['baseline']
    current = (BASE / 'current').resolve(strict=True)
    need(str(current) == b['current'] and current.parent == BASE / 'releases'
         and sha((current / 'release-manifest.json').read_bytes()) == b['manifestSha256'], 'CURRENT_CHANGED')
    states = h.snapshot(d, current)
    need(states == b['services'] and all(sha((current / n).read_bytes()) == v for n, v in b['configurationSha256'].items())
         and all(h.configuration(d, st) == b['runtimeConfigurationSha256'][n] for n, st in states.items()), 'PARENT_CHANGED')
    need(history.runtime(d, states) == b['runtime'] and history.database(d, states['api']) == b['database']
         and load('dependency-security-publication.py').dependency_state(d, states['api']['containerId'], c) == b['dependencies'], 'PARENT_CONTENT_CHANGED')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    h.guards(d, current, states, {'engineHealth': c['engineHealth']})
    load('online-session-observer-release.py').profile_unlocked(d, states['online-recharge'])
    return current, states


def verify_image(original, built, plan):
    layers = original['RootFS']['Layers']
    need(built['RootFS']['Layers'][:len(layers)] == layers and len(built['RootFS']['Layers']) == len(layers) + 2, 'IMAGE_LAYERS_CHANGED')
    load('recharge-source-recovery-release.py').verify_image_configuration(original['Config'], built['Config'])
    need(built['Config']['Labels'] == {**(original['Config'].get('Labels') or {}),
         'org.opencontainers.image.revision': plan['commit'],
         'id-business-v2.recharge-record-build-proof-sha256': plan['buildProofSha256']}, 'IMAGE_LABELS_CHANGED')


def verify_dependencies(state, proof, c):
    before = c['baseline']['dependencies']
    need(all(state[n] == before[n] for n in ('node', 'platform', 'arch', 'preservedNodeModules'))
         and state['metadata'] == c['runtimeMetadataSha256'], 'PRESERVED_DEPENDENCIES_CHANGED')
    for name, version in c['afterVersions'].items():
        actual = state['inventory'][name]
        if version is None:
            need(actual is None, 'REMOVED_NESTED_PACKAGE_PRESENT')
        else:
            prefix = 'packages/' + name + '/'
            files = {n[len(prefix):]: v for n, v in proof['files'].items() if n.startswith(prefix)}
            need(actual == {'version': version, 'count': len(files), 'sha256': sha(canonical(files))}, 'PACKAGE_CONTENT_CHANGED')


def verify_deployed(d, target, proof, image, c, history, h):
    states, b = h.snapshot(d, target), c['baseline']
    need(set(states) == set(b['services']) and all(states[n] == b['services'][n] for n in states if n not in ('api', 'online-recharge')), 'PRESERVED_SERVICE_CHANGED')
    need(states['api']['image'] == image and states['online-recharge']['image'] == b['services']['online-recharge']['image'], 'DEPLOYED_IMAGE_CHANGED')
    need(all(h.configuration(d, st) == b['runtimeConfigurationSha256'][n]
         and st['environmentSha256'] == b['services'][n]['environmentSha256'] for n, st in states.items()), 'RUNTIME_CONFIGURATION_CHANGED')
    need(all(sha((target / n).read_bytes()) == v for n, v in b['configurationSha256'].items() if n != 'compose.release.json')
         and all(sha((target / 'dependency-security-source' / n).read_bytes()) == v for n, v in c['sources'].items())
         and all((sha((target / n).read_bytes()) if (target / n).is_file() else None) == v for n, v in b['hostMetadataSha256'].items()), 'HOST_CONTENT_CHANGED')
    need(history.runtime(d, states) == b['runtime'] and history.database(d, states['api']) == b['database'], 'APPLICATION_OR_SCHEMA_CHANGED')
    row = json.loads(d.run('docker', 'inspect', states['online-recharge']['containerId']))[0]
    need(row['HostConfig']['NetworkMode'] == 'container:' + states['api']['containerId'], 'ENGINE_NETWORK_BINDING_CHANGED')
    prior = json.loads((HERE / 'online-session-observer-contract.json').read_bytes())
    load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], prior['afterEngineFiles'])
    verify_dependencies(load('dependency-security-publication.py').dependency_state(d, states['api']['containerId'], c), proof, c)
    h.engine_idle(d, states['online-recharge'], {'engineHealth': c['engineHealth']}, wait_connected=True)
    return states


def latest_main(commit):
    url = 'https://api.github.com/repos/wangchaozhuanyong/id-business-system/git/ref/heads/main'
    with urllib.request.urlopen(urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'User-Agent': 'id-business-dependency-publication'}), timeout=30) as response:
        need(json.load(response)['object']['sha'] == commit, 'MAIN_MOVED')


def release(plan, c):
    validate_contract(c)
    need(plan['mode'] in ('preflight', 'release', 'readback')
         and all(re.fullmatch('[a-f0-9]{40}', plan[n]) for n in ('commit', 'tree'))
         and all(re.fullmatch('[1-9][0-9]*', plan[n]) for n in ('workflowRunId', 'workflowRunAttempt'))
         and plan['contractSha256'] == sha((HERE / CONTRACT_FILE).read_bytes())
         and all(sha((HERE / n).read_bytes()) == v for n, v in plan['controlSources'].items()), 'PLAN_CHANGED')
    history, h, d, retired = utilities()
    a, p = load('recharge-availability-release.py'), load('proxy-result-identity-release.py')
    with (BASE / '.deploy.lock').open('a') as lock:
        a.acquire_release_lock(lock)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve(strict=True)
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            raw = (target / (PREFIX + '-build-proof.json')).read_bytes()
            need(manifest['commit'] == plan['commit'] and manifest['scope'] == SCOPE and sha(raw) == plan['buildProofSha256'], 'READBACK_CHANGED')
            proof = json.loads(raw)
            verify_proof(proof, plan, c, proof['files'])
            states = verify_deployed(d, target, proof, manifest['images']['api']['digest'], c, history, h)
            receipt = json.loads((target / (PREFIX + '-preservation.json')).read_bytes())
            need(receipt['commit'] == plan['commit'] and receipt['before'] == c['baseline']['services']
                 and receipt['after'] == states and receipt['backup']['s3Verified'] is True
                 and receipt['businessActions'] == 0 and receipt['migrationPerformed'] is False, 'PRESERVATION_RECEIPT_CHANGED')
            image = json.loads(d.run('docker', 'image', 'inspect', states['api']['image']))[0]
            need(image['Config']['Labels']['org.opencontainers.image.revision'] == plan['commit'], 'LIVE_IMAGE_REVISION_CHANGED')
            return {'status': 'DEPENDENCY_SECURITY_READBACK_VERIFIED', 'commit': plan['commit'],
                    'apiImage': states['api']['image'], 'packageVersions': c['afterVersions'], 'businessActions': 0, 'migrationPerformed': False}
        current, before = baseline(c, history, h, d)
        latest_main(plan['commit'])
        if plan['mode'] == 'preflight':
            return {'status': 'DEPENDENCY_SECURITY_PREFLIGHT_VERIFIED', 'businessActions': 0}
        stage = BASE / '.staging' / (PREFIX + '-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        expected_url = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/' + PREFIX + '-' + plan['commit'] + '/' + PREFIX + '-artifact.tar.gz'
        need(plan['artifactUrl'] == expected_url, 'ARTIFACT_LOCATION_CHANGED')
        with urllib.request.urlopen(expected_url, timeout=60) as response:
            raw = response.read(40 * 1024**2 + 1)
        need(len(raw) < 40 * 1024**2 and sha(raw) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        payload = load('shared-bank-card-release.py').safe_archive(raw, stage / 'content')
        proof_raw = (payload / 'build-proof.json').read_bytes()
        need(sha(proof_raw) == plan['buildProofSha256'], 'BUILD_PROOF_CHANGED')
        proof = json.loads(proof_raw)
        files = h.file_inventory(payload)
        files.pop('build-proof.json')
        verify_proof(proof, plan, c, files)
        context = stage / 'image-api'
        shutil.copytree(payload / 'packages', context / 'app')
        metadata = context / 'app/apps/api/package.json'
        metadata.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(payload / 'source/apps/api/package.json', metadata)
        a.normalize_image_context(context)
        ref = 'id-business-v2-dependency-security:' + plan['commit'] + '-' + plan['workflowRunId']
        delete = ' '.join('/app/' + n for n in package_roots(c))
        (context / 'Dockerfile').write_text('FROM ' + h.base_image_reference(d, before['api'])
            + '\nRUN rm -rf -- ' + delete + '\nCOPY app/ /app/\nLABEL org.opencontainers.image.revision="' + plan['commit']
            + '" id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n')
        h.build_image(d, context, ref, 'api', before['api'], stage)
        image = json.loads(d.run('docker', 'image', 'inspect', ref))[0]
        verify_image(json.loads(d.run('docker', 'image', 'inspect', before['api']['image']))[0], image, plan)
        observer = load('dependency-security-publication.py')
        verify_dependencies(observer.dependency_state(d, ref, c, image=True), proof, c)
        # Synthetic inputs and loopback endpoints, in an isolated read-only container.
        d.run('docker', 'run', '--rm', '--network', 'none', '--read-only', '--mount',
              'type=bind,source=' + str(payload / 'probes/dependency-security-regressions.test.mjs') + ',target=/app/scripts/dependency-security-regressions.test.mjs,readonly',
              '--entrypoint', 'node', ref, '--test', '--test-name-pattern=compressed JSON trailing bytes|nested address comments|query serialization handles|IPv6 validation rejects', '/app/scripts/dependency-security-regressions.test.mjs', timeout=60)
        d.run('docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node', ref, '-e',
              "const a=require('node:assert/strict');const {ExpressAdapter}=require('@nestjs/platform-express');"
              "a.ok(new ExpressAdapter());a.equal(typeof require('multer')().single('fixture'),'function');"
              "a.equal(require('multer/package.json').version,'2.5.0');console.log('DEPENDENCY_COMPATIBILITY_VERIFIED');", timeout=30)
        current, before = baseline(c, history, h, d)
        backup = h.fresh_scoped_backup(d, current, plan, normalizer_path=Path(c['baseline']['backupNormalizerPath']))
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-' + PREFIX)
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(current, target, symlinks=True)
        need(not (target / 'dependency-security-source').exists(), 'SOURCE_ARCHIVE_EXISTS')
        shutil.copytree(payload / 'source', target / 'dependency-security-source')
        for name in plan['controlSources']:
            path = target / 'scripts/production-release' / name
            need(not path.is_symlink() and path.resolve().is_relative_to(target), 'HOST_CONTROL_PATH_CHANGED')
            path.write_bytes((HERE / name).read_bytes())
        override = json.loads((target / 'compose.release.json').read_bytes())
        override['services']['api']['image'] = ref
        a.write_release_override(target / 'compose.release.json', override)
        baseline(c, history, h, d)
        latest_main(plan['commit'])
        retired.SCOPE = SCOPE
        markers = retired.claim_retired_markers(d, before, plan)
        fence = p.sql_fence_class(c)(d, current)
        journal = stage / 'switch-state.json'
        journal.write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target), 'maintenance': markers}) + '\n')
        try:
            fence.acquire()
            p.verify_markers(markers)
            history.activate_services(d, target, before, fence)
            after = verify_deployed(d, target, proof, image['Id'], c, history, h)
        except BaseException:
            journal.write_text(json.dumps({'status': 'NEEDS_FORWARD_DIAGNOSIS', 'target': str(target), 'rollbackPerformed': False, 'maintenanceHeld': True}) + '\n')
            raise
        finally:
            fence.close()
        manifest = json.loads((current / 'release-manifest.json').read_bytes())
        prior = manifest.setdefault('roleSourceProjections', {}).get('api')
        manifest['roleSourceProjections']['api'] = {'kind': SCOPE, 'commit': plan['commit'], 'parentProjection': prior,
            'sources': c['sources'], 'sourceArchive': 'dependency-security-source', 'runtimeMetadataSha256': c['runtimeMetadataSha256'], 'buildProofSha256': plan['buildProofSha256']}
        manifest['images']['api'] = {'reference': ref, 'digest': image['Id'], 'sourceCommit': plan['commit']}
        manifest.update(commit=plan['commit'], applicationCommit=plan['commit'], controlCommit=plan['commit'],
            version='v2-' + plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=SCOPE,
            previousCommit=c['expectedCurrent'], previousRelease=str(current), previousManifestSha256=c['baseline']['manifestSha256'],
            status='DEPLOYED', servicesUpdated=['api'], servicesRebound=['online-recharge'], newMigrations=[], migrationPerformed=False, paymentActions=0)
        receipt = {'commit': plan['commit'], 'before': before, 'after': after, 'backup': backup, 'businessActions': 0, 'migrationPerformed': False}
        (target / (PREFIX + '-preservation.json')).write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
        (target / (PREFIX + '-build-proof.json')).write_bytes(proof_raw)
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-' + PREFIX)
        p.release_markers(markers)
        h.guards(d, target, after, {'engineHealth': c['engineHealth']})
        journal.write_text(json.dumps({'status': 'DEPLOYED', 'commit': plan['commit']}) + '\n')
        return {'status': 'DEPENDENCY_SECURITY_DEPLOYED', 'commit': plan['commit'], 'businessActions': 0, 'migrationPerformed': False}
