"""Offline recovery phase ordering and exact original selection checks."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent

def load(name):
    spec=importlib.util.spec_from_file_location('recovery_test_' + name.replace('-', '_'), HERE/name)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

p=load('online-checkout-initialization-recovery.py')
fixtures=load('online-checkout-initialization-release.test.py')
contract, identity, runtime_parent = fixtures.contract, fixtures.identity, fixtures.runtime_parent


class FencedRecovery(unittest.TestCase):
    def test_fenced_health_never_calls_rpc_and_restores_legacy_health(self):
        c = contract(); states = c['baseline']['services']; h = Mock(); d = Mock()
        d.run.return_value = json.dumps(p.HEALTH); previous = h.engine_idle
        def verify(driver, helper, *args):
            return helper.engine_idle(driver, states['online-recharge'], c, wait_connected=True)
        with patch.object(p.LEGACY, 'verify_runtime', side_effect=verify):
            p.verify_runtime(d, h, states, c, states, c['beforeEngineFiles'], fenced=True)
        self.assertEqual(d.run.call_count, 1)
        self.assertNotIn('rpc(', d.run.call_args.args[-1])
        self.assertIs(h.engine_idle, previous)
        with self.assertRaisesRegex(RuntimeError, 'HEALTH_PHASE_INVALID'):
            p.verify_runtime(d, h, states, c, states, {}, admitted=True, fenced=True)

    def scenario(self, mutation=None, *, busy=False, adoption_failure=False):
        c = contract(); plan = {**identity(), 'mode': 'release'}
        c['controlPins'] = {name: p.sha((HERE / name).read_bytes()) for name in p.CONTROLS}
        control = {'commit': 'd' * 40, 'sourceSha256': p.sha(Path(p.__file__).read_bytes())}
        trace = []; running = False; unlocked = False; d = Mock(); h = Mock(); fence = Mock()
        with tempfile.TemporaryDirectory(dir=runtime_parent(), prefix='initialization-resume-fixture-') as scratch:
            base = Path(scratch); target = base / 'releases' / 'selected'; target.mkdir(parents=True)
            (base / '.deploy.lock').write_text('')
            (base / 'current').symlink_to(target, target_is_directory=True)
            expected = {'target': str(target), 'containerId': 'a' * 64, 'image': 'sha256:' + 'e' * 64}
            stage = base / '.staging' / (p.PREFIX + '-' + plan['commit'] + '-' + plan['workflowRunId']); stage.mkdir(parents=True)
            proof_raw = b'{"files":{}}'; plan['buildProofSha256'] = p.sha(proof_raw)
            (target / (p.PREFIX + '-build-proof.json')).write_bytes(proof_raw)
            manifest = {'status': 'SWITCH_FAILED', 'commit': plan['commit'], 'sourceTree': plan['tree'],
                'scope': p.SCOPE, 'images': {'online-recharge': {'digest': expected['image'],
                    'sourceCommit': plan['commit'], 'reference': 'id-business-v2-' + p.PREFIX + ':' + plan['commit'] + '-' + plan['workflowRunId']}}}
            receipt = {'status': 'SWITCH_STARTED', 'commit': plan['commit'], 'candidateImageId': expected['image'],
                'buildProofSha256': plan['buildProofSha256'], 'before': c['baseline']['services'], 'backup': {'s3Verified': True}}
            journal = {'status': 'SWITCH_FAILED', 'target': str(target), 'sourceSelected': True,
                'candidateQuiet': 'STOPPED', 'apiTransactionsCancelled': False}
            if mutation == 'journal': journal['candidateQuiet'] = 'UNCONFIRMED'
            if mutation == 'source': manifest['images']['online-recharge']['sourceCommit'] = 'f' * 40
            if mutation == 'proof': (target / (p.PREFIX + '-build-proof.json')).write_bytes(b'{}')
            if mutation == 'backup': receipt['backup']['s3Verified'] = False
            if mutation == 'reserved': (stage / ('resume-' + control['commit'] + '.json')).write_text('{}')
            if mutation == 'control': control['sourceSha256'] = 'f' * 64
            for name, value in [('release-manifest.json', manifest), (p.PREFIX + '-preservation.json', receipt)]:
                (target / name).write_text(json.dumps(value))
            (stage / 'switch-state.json').write_text(json.dumps(journal))
            states = copy.deepcopy(c['baseline']['services']); states['online-recharge'].update(
                containerId=expected['containerId'], image=expected['image'], status='exited', health='unhealthy')
            if mutation == 'preserved': states['api']['containerId'] = 'f' * 64
            def snapshot(*_args):
                value = copy.deepcopy(states)
                if running: value['online-recharge'].update(status='running', health='healthy')
                return value
            h.snapshot.side_effect = snapshot
            def run(*args, **_kwargs):
                nonlocal running
                if args[:2] == ('docker', 'inspect'):
                    return json.dumps([{'Id': expected['containerId'], 'Image': expected['image'],
                        'State': {'Running': mutation == 'running', 'Paused': False}}])
                if args[:2] == ('docker', 'start'):
                    running = True; trace.append('start'); return ''
                self.assertEqual(args[:2], ('docker', 'exec'))
                self.assertNotIn('rpc(', args[-1]); self.assertFalse(unlocked)
                trace.append('local-health'); return json.dumps({**p.HEALTH, 'activeTasks': 1 if busy else 0})
            d.run.side_effect = run
            def acquire():
                fence.deadline = time.monotonic() + 120; trace.append('lock')
            def close():
                nonlocal unlocked
                unlocked = True; trace.append('unlock')
            fence.acquire.side_effect = acquire; fence.close.side_effect = close
            marker = Mock(); marker.sql_fence_class.return_value = lambda *_args: fence
            marker.registration_marker.side_effect = AssertionError('RETIRED_REGISTRATION_MUST_NOT_BE_READ')
            marker_raw = json.dumps({'scope': p.SCOPE, 'commit': plan['commit'],
                'workflowRunId': plan['workflowRunId']}, sort_keys=True).encode()
            (base / 'maintenance.json').write_bytes(marker_raw if mutation != 'marker' else b'{}')
            real_markers = p.ORIGINAL.load('proxy-result-identity-release.py')
            marker.verify_markers.side_effect = real_markers.verify_markers
            def release_markers(receipt):
                self.assertEqual(receipt['paths'], [str(base / 'maintenance.json')])
                real_markers.release_markers(receipt); trace.append('marker-release')
            marker.release_markers.side_effect = release_markers
            def admitted(*_args):
                self.assertTrue(unlocked); trace.append('fresh-rpc')
                if adoption_failure: raise RuntimeError('READBACK_UNAVAILABLE')
            original = SimpleNamespace(validate_plan=Mock(), verify_proof=Mock(), verify_host=Mock(),
                verify_adopted=Mock(side_effect=admitted), LEGACY=SimpleNamespace(helpers=lambda:
                    (h, Mock(), d, SimpleNamespace(acquire_release_lock=Mock()), marker, SimpleNamespace())))
            def legacy(driver, helper, *_args):
                return helper.engine_idle(driver, snapshot()['online-recharge'], c, wait_connected=True)
            error = None; value = None
            def stop(_driver, candidate):
                self.assertEqual(candidate['containerId'], expected['containerId'])
                self.assertEqual(candidate['image'], expected['image'])
                self.assertIn('startedAtSha256', candidate)
                trace.append('stop'); return 'STOPPED'
            with patch.object(p, 'BASE', base), patch.object(p, 'load', return_value=original), \
                patch.object(p.LEGACY, 'verify_runtime', side_effect=legacy), \
                patch.object(p, 'quiet_candidate', side_effect=stop):
                try: value = p.resume_failed_selection(plan, c, control, expected)
                except Exception as caught: error = caught
            return SimpleNamespace(value=value, error=error, trace=trace,
                manifest=json.loads((target / 'release-manifest.json').read_text()), marker=marker,
                journal=json.loads((stage / 'switch-state.json').read_text()))

    def test_resume_unlocks_before_fresh_rpc_and_never_creates_a_checkout(self):
        result = self.scenario(); self.assertIsNone(result.error)
        self.assertEqual(result.trace, ['lock', 'start', 'local-health', 'unlock', 'marker-release', 'fresh-rpc'])
        self.assertTrue(result.value['resumedOriginalSelection']); self.assertEqual(result.value['businessActions'], 0)
        self.assertEqual(result.manifest['status'], 'DEPLOYED')

    def test_changed_evidence_or_running_candidate_never_starts(self):
        for mutation in ('journal', 'proof', 'backup', 'preserved', 'running', 'source', 'reserved', 'control', 'marker'):
            with self.subTest(mutation=mutation):
                result = self.scenario(mutation); self.assertIsNotNone(result.error)
                self.assertNotIn('start', result.trace); result.marker.release_markers.assert_not_called()

    def test_busy_health_stops_same_candidate_and_preserves_marker(self):
        result = self.scenario(busy=True); self.assertIsNotNone(result.error)
        self.assertEqual(result.trace, ['lock', 'start', 'local-health', 'stop', 'unlock'])
        self.assertEqual(result.manifest['status'], 'SWITCH_FAILED'); result.marker.release_markers.assert_not_called()

    def test_admitted_but_unreadable_result_is_retained_without_stopping_or_replaying(self):
        result = self.scenario(adoption_failure=True)
        self.assertIsNotNone(result.error)
        self.assertEqual(result.trace, ['lock', 'start', 'local-health', 'unlock', 'marker-release', 'fresh-rpc'])
        self.assertEqual(result.manifest['status'], 'DEPLOYED')
        self.assertEqual(result.journal['status'], 'COMMITTED_NEEDS_READBACK')


if __name__ == '__main__':
    unittest.main()
