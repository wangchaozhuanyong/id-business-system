"""Bounded continuation of one failed selected publication; no rebuild or task replay."""
import importlib.util
import json
from pathlib import Path
import re
import time

HERE = Path(__file__).resolve().parent

def load(name):
    spec = importlib.util.spec_from_file_location('initialization_recovery_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

ORIGINAL = load('online-checkout-initialization-release.py')
BASE, PREFIX, SCOPE = ORIGINAL.BASE, ORIGINAL.PREFIX, ORIGINAL.SCOPE
PRESERVED, CONTROLS, HEALTH = ORIGINAL.PRESERVED, ORIGINAL.CONTROLS, ORIGINAL.HEALTH
SERVICES = ORIGINAL.SERVICES
LEGACY, sha, need, quiet_candidate = ORIGINAL.LEGACY, ORIGINAL.sha, ORIGINAL.need, ORIGINAL.quiet_candidate
connected_engine = ORIGINAL.connected_engine


def fenced_engine(d, state, _contract, **_kwargs):
    # The parent has already completed its startup RPC before health is ready.
    # A second API request while task tables are locked can wait behind claimJob.
    code = ("require('/workspace/engine/healthcheck.cjs').check().then(v=>console.log(JSON.stringify({"
        "ready:v.ready,mode:v.mode,activeTasks:v.activeTasks,stopping:v.stopping,rpcConnected:v.rpcConnected})))"
        ".catch(()=>process.exit(1))")
    value = json.loads(d.run('docker', 'exec', state['containerId'], 'node', '-e', code, timeout=10))
    need(value == HEALTH and type(value.get('activeTasks')) is int, 'FENCED_ENGINE_NOT_IDLE')
    return value


def verify_runtime(d, h, states, c, original, files, *, admitted=False, fenced=False):
    need(not (admitted and fenced), 'HEALTH_PHASE_INVALID')
    need(set(states) == set(SERVICES) and all(states[n] == original[n] for n in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
    # helpers() loads this private module per publication. Preserve every legacy
    # configuration/source check, changing only the post-admission health read.
    engine_health = h.engine_idle
    try:
        if admitted: h.engine_idle = connected_engine
        elif fenced: h.engine_idle = fenced_engine
        LEGACY.verify_runtime(d, h, states, c, original, files)
    finally:
        h.engine_idle = engine_health


def resume_failed_selection(plan, c, control, expected):
    """Resume one stopped, already-selected image; never rebuild or replay a task."""
    need(set(control) == {'commit', 'sourceSha256'}
        and re.fullmatch('[a-f0-9]{40}', control['commit'])
        and sha(Path(__file__).read_bytes()) == control['sourceSha256'], 'RECOVERY_CONTROL_CHANGED')
    original = load(PREFIX + '-release.py')
    original.validate_plan(plan, c)
    need(all(not (HERE / n).is_symlink() and sha((HERE / n).read_bytes()) == digest
        for n, digest in c['controlPins'].items()), 'RECOVERY_ORIGINAL_CONTROL_CHANGED')
    need(set(expected) == {'target', 'containerId', 'image'}
        and re.fullmatch('[a-f0-9]{64}', expected['containerId'])
        and re.fullmatch('sha256:[a-f0-9]{64}', expected['image']), 'RECOVERY_IDENTITY_INVALID')
    h, _old, d, a, p, retired = original.LEGACY.helpers()
    p.SCOPE = retired.SCOPE = SCOPE
    with (BASE / '.deploy.lock').open('r') as lock:
        a.acquire_release_lock(lock)
        target = (BASE / 'current').resolve()
        need(str(target) == expected['target'] and target.parent == BASE / 'releases', 'RECOVERY_TARGET_CHANGED')
        manifest_path = target / 'release-manifest.json'
        receipt_path = target / (PREFIX + '-preservation.json')
        manifest = json.loads(manifest_path.read_bytes()); receipt = json.loads(receipt_path.read_bytes())
        stage = BASE / '.staging' / (PREFIX + '-' + plan['commit'] + '-' + plan['workflowRunId'])
        journal_path = stage / 'switch-state.json'; journal = json.loads(journal_path.read_bytes())
        image = expected['image']
        need(manifest.get('status') == 'SWITCH_FAILED' and manifest.get('commit') == plan['commit']
            and manifest.get('sourceTree') == plan['tree'] and manifest.get('scope') == SCOPE
            and manifest.get('images', {}).get('online-recharge') == {
                'digest': image, 'sourceCommit': plan['commit'],
                'reference': 'id-business-v2-' + PREFIX + ':' + plan['commit'] + '-' + plan['workflowRunId']}
            and receipt.get('status') == 'SWITCH_STARTED' and receipt.get('commit') == plan['commit']
            and receipt.get('candidateImageId') == image and receipt.get('buildProofSha256') == plan['buildProofSha256']
            and receipt.get('before') == c['baseline']['services'] and receipt.get('backup', {}).get('s3Verified') is True
            and journal == {'status': 'SWITCH_FAILED', 'target': str(target), 'sourceSelected': True,
                'candidateQuiet': 'STOPPED', 'apiTransactionsCancelled': False}, 'RECOVERY_STATE_CHANGED')
        proof_raw = (target / (PREFIX + '-build-proof.json')).read_bytes()
        need(sha(proof_raw) == plan['buildProofSha256'], 'RECOVERY_PROOF_CHANGED')
        proof = json.loads(proof_raw); original.verify_proof(proof, plan, c, proof['files'])
        states = h.snapshot(d, target)
        need(all(states[n] == c['baseline']['services'][n] for n in PRESERVED)
            and states['online-recharge']['containerId'] == expected['containerId']
            and states['online-recharge']['image'] == image, 'RECOVERY_SERVICE_CHANGED')
        metadata = json.loads(d.run('docker', 'inspect', expected['containerId']))[0]
        need(metadata['Id'] == expected['containerId'] and metadata['Image'] == image
            and metadata['State']['Running'] is False and metadata['State'].get('Paused') is False, 'RECOVERY_NOT_STOPPED')
        original.verify_host(target, states, c, plan)
        marker_raw = json.dumps({'scope': SCOPE, 'commit': plan['commit'], 'workflowRunId': plan['workflowRunId']}, sort_keys=True).encode()
        marker = {'paths': [str(BASE / 'maintenance.json')], 'ownerSha256': sha(marker_raw)}
        p.verify_markers(marker)
        recovery_path = stage / ('resume-' + control['commit'] + '.json')
        with recovery_path.open('x') as output:
            json.dump({'status': 'ACCEPTED', 'control': control, 'originalJournal': journal,
                'expected': expected, 'businessActions': 0}, output, sort_keys=True)
        fence = p.sql_fence_class(c)(d, Path(c['baseline']['current']))
        started = False
        run = d.run
        cleanup = False
        def bounded_run(*args, **kwargs):
            remaining = fence.deadline - time.monotonic() - (0 if cleanup else 45)
            need(remaining > 0, 'RECOVERY_BUDGET_EXHAUSTED')
            kwargs['timeout'] = min(float(kwargs.get('timeout', 300)), remaining)
            return run(*args, **kwargs)
        try:
            fence.acquire()
            d.run = bounded_run
            # The original image and exact container stay fixed throughout recovery.
            started = True
            d.run('docker', 'start', expected['containerId'], timeout=15)
            deadline = time.monotonic() + 20
            while True:
                after = h.snapshot(d, target)
                need(after['online-recharge']['containerId'] == expected['containerId']
                    and after['online-recharge']['image'] == image, 'RECOVERY_SERVICE_CHANGED')
                if after['online-recharge']['health'] == 'healthy': break
                need(after['online-recharge']['status'] == 'running' and time.monotonic() < deadline, 'RECOVERY_NOT_HEALTHY')
                time.sleep(1)
            verify_runtime(d, h, after, c, receipt['before'], c['afterEngineFiles'], fenced=True)
            original.verify_host(target, after, c, plan)
            fence.check_idle()
            receipt.update(status='DEPLOYED', after=after, image=image, recoveryControl=control)
            manifest['status'] = 'DEPLOYED'; manifest['recoveryControl'] = control
            receipt_path.write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
            manifest_path.write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        except BaseException:
            cleanup = True
            quiet = 'NOT_STARTED'
            try:
                if started: quiet = quiet_candidate(d, {'containerId': expected['containerId'], 'image': image})
            except Exception:
                quiet = 'UNCONFIRMED'
            manifest['status'] = 'SWITCH_FAILED'
            manifest_path.write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
            recovery_path.write_text(json.dumps({'status': 'FAILED', 'control': control,
                'candidateQuiet': quiet, 'apiTransactionsCancelled': False, 'businessActions': 0}) + '\n')
            raise
        finally:
            d.run = run
            fence.close()
        # No API request is issued until the same-connection task fence is gone.
        try:
            p.release_markers(marker)
            original.verify_adopted(d, h, target, c, plan, receipt)
        except BaseException:
            pending = {'status': 'COMMITTED_NEEDS_READBACK', 'target': str(target),
                'recoveryControl': control, 'candidateQuiet': 'ADMITTED', 'apiTransactionsCancelled': False}
            journal_path.write_text(json.dumps(pending) + '\n')
            recovery_path.write_text(json.dumps(pending) + '\n')
            raise
        journal_path.write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target), 'recoveryControl': control}) + '\n')
        result = {'status': SCOPE + '_DEPLOYED', 'commit': plan['commit'], 'updatedServices': ['online-recharge'],
            'preservedServices': list(PRESERVED), 'migrationPerformed': False, 'businessActions': 0,
            'recoveryControl': control, 'resumedOriginalSelection': True}
        recovery_path.write_text(json.dumps(result, sort_keys=True) + '\n')
        return result
