"""Offline negative cases for the finite admin successor and preserved live API."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location('test_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = load('settled-checkout-release.py')
B = load('settled-checkout-publication.py')


class NativeTaxContextPublicationTests(unittest.TestCase):
    def setUp(self):
        (P.ROOT / '.runtime').mkdir(exist_ok=True)
        self.c = json.loads((HERE / P.CONTRACT_FILE).read_bytes())

    def test_exact_frozen_inputs(self):
        B.check(self.c)
        self.assertEqual(set(self.c['productionSources']), P.SOURCES)
        self.assertEqual(P.MODULES, frozenset())

    def test_scope_parent_and_side_effect_widening_rejected(self):
        mutations = [
            lambda c: c['productionSources'].update({'unrelated.ts': 'a' * 64}),
            lambda c: c['validationSources'].clear(),
            lambda c: c['apiModules'].append('other.js'),
            lambda c: c.update(updatedServices=['api', 'admin']),
            lambda c: c.update(reboundServices=['online-recharge']),
            lambda c: c.update(preservedServices=['mysql']),
            lambda c: c.update(migrationPerformed=True),
            lambda c: c.update(businessActions=1),
            lambda c: c.update(expectedCurrent='b' * 40),
            lambda c: c.update(sourceReviewCommit='c' * 40),
            lambda c: c['baseline']['apiModules'].update({'other.js': 'a' * 64}),
            lambda c: c['baseline']['database'].update(pending=1),
            lambda c: c['adminParent'].update(commit='b' * 40),
            lambda c: c['adminParent']['adminFiles'].clear(),
            lambda c: c.update(sqlFenceHelperSha256='d' * 64)
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                c = copy.deepcopy(self.c)
                mutate(c)
                with self.assertRaises(RuntimeError):
                    P.validate_contract(c)

    def test_native_lock_backup_fence_and_admin_merge_remain_inherited(self):
        p = P.engine(self.c)
        self.assertEqual(p.UPDATED, ('admin',))
        self.assertEqual(p.REBOUND, ())
        self.assertIn('api', p.PRESERVED)
        self.assertIn('online-recharge', p.PRESERVED)
        self.assertEqual(p.RECIPE, p.FOLLOWUP)
        self.assertNotEqual(p.RECIPE, p.BOUNDED)
        for function in (p.release, p.baseline, p.activate_services, p.smoke, p.verify_admin_merge):
            self.assertTrue(function.__code__.co_filename.endswith('bitbrowser-history-release.py'))
        self.assertEqual(p.runtime.__code__.co_filename, p.smoke.__code__.co_filename)

    def proof(self):
        files = {n: '1' * 64 for n in self.c['adminParent']['adminFiles']}
        qa = {'sources': {'commit': P.SOURCE, 'pullRequest': 664, 'runId': '1',
                          'sourceReceiptSha256': 'a' * 64},
              'release': {'commit': 'b' * 40, 'runId': '2'}}
        return {'version': 1, 'commit': 'b' * 40, 'tree': 'c' * 40,
                'workflowRunId': '3', 'workflowRunAttempt': '1', 'contractSha256': 'd' * 64,
                'scope': P.SCOPE, 'recipe': P.RECIPE, 'qualityVerification': qa,
                'productionSources': self.c['productionSources'], 'controlSources': self.c['controlPins'],
                'baselineAdminReproduced': True, 'baselineAdminFiles': self.c['adminParent']['adminFiles'],
                'migrationPerformed': False, 'businessActions': 0,
                'apiModules': {}, 'adminFiles': files, 'files': {
                    **{'admin/html/' + n: v for n, v in files.items()},
                    **{'source/' + n: v for n, v in self.c['productionSources'].items()}}}

    def test_payload_api_and_quality_tampering_rejected(self):
        proof = self.proof()
        h = type('Inventory', (), {'file_inventory': staticmethod(lambda _: dict(proof['files']))})
        P.verify_proof(proof, proof, self.c, None, h)
        for key, value in [('businessActions', 1), ('migrationPerformed', True),
                           ('baselineAdminReproduced', False), ('baselineAdminFiles', {}),
                           ('productionSources', {}), ('adminFiles', {}),
                           ('apiModules', {'other.js': 'e' * 64}), ('qualityVerification', {})]:
            with self.subTest(key=key):
                changed = copy.deepcopy(proof)
                changed[key] = value
                with self.assertRaises((RuntimeError, KeyError)):
                    P.verify_proof(changed, changed, self.c, None, h)
        proof['files']['api/modules/other.js'] = 'e' * 64
        with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_CHANGED'):
            P.verify_proof(proof, proof, self.c, None, h)

    def test_native_parent_must_be_reproduced_and_build_must_change(self):
        before = dict(self.c['adminParent']['adminFiles'])
        after = {**before, 'index.html': 'e' * 64}
        B.verify_delta(before, after, self.c)
        before['index.html'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'NATIVE_PARENT_NOT_REPRODUCED'):
            B.verify_delta(before, after, self.c)
        before = dict(self.c['adminParent']['adminFiles'])
        with self.assertRaisesRegex(RuntimeError, 'ADMIN_OUTPUT_UNCHANGED'):
            B.verify_delta(before, before, self.c)

    def test_historical_assets_preserved_and_mutated_old_assets_rejected(self):
        p = P.engine(self.c)
        before = {'index.html': 'a' * 64, 'assets/old.js': 'b' * 64}
        candidate = {'index.html': 'c' * 64, 'assets/new.js': 'd' * 64}
        baseline = {'count': len(before), 'sha256': P.sha(P.canonical(before))}
        merged = {**before, **candidate}
        self.assertEqual(p.verify_admin_merge(before, candidate, merged, baseline)['count'], 3)
        for actual in (candidate, {**merged, 'assets/old.js': 'e' * 64}):
            with self.assertRaises(RuntimeError):
                p.verify_admin_merge(before, candidate, actual, baseline)

    def test_transport_records_intent_and_never_retries_uncertain_send(self):
        import tempfile
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory(dir=P.ROOT / '.runtime') as name:
            with patch.object(B, 'OUT', Path(name)), patch.object(B.subprocess, 'run',
                    return_value=SimpleNamespace(returncode=1, stdout=b'')) as send:
                with self.assertRaisesRegex(RuntimeError, 'COMMAND_ACCEPTANCE_UNCERTAIN'):
                    B.transport({'commit': 'a' * 40, 'workflowRunId': '1'}, 'release')
                self.assertEqual(send.call_count, 1)
                with self.assertRaisesRegex(RuntimeError, 'COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN'):
                    B.transport({'commit': 'a' * 40, 'workflowRunId': '1'}, 'release')
                self.assertEqual(send.call_count, 1)

    def test_only_admin_image_builds_fresh_and_checks_unprivileged_readability(self):
        import tempfile
        from types import SimpleNamespace
        original_load = P.load
        commands = []
        def build(driver, context, reference, role, before, stage):
            driver.run('docker', 'build', '--network', 'none', str(context))
        driver = SimpleNamespace(run=lambda *a, **kw: commands.append(a) or 'READABLE\n')
        fake = SimpleNamespace(helpers=lambda: (SimpleNamespace(build_image=build), driver, None))
        with patch.object(P, 'load', side_effect=lambda name: fake if name == 'bitbrowser-history-release.py' else original_load(name)):
            p = P.engine(self.c)
            h, _, _ = p.helpers()
            with tempfile.TemporaryDirectory(dir=P.ROOT / '.runtime') as name:
                h.build_image(driver, Path(name), 'candidate', 'admin', {}, Path(name))
                with self.assertRaisesRegex(RuntimeError, 'ADMIN_ONLY_BUILD'):
                    h.build_image(driver, Path(name), 'candidate', 'api', {}, Path(name))
        self.assertEqual(commands[0][:3], ('docker', 'build', '--no-cache'))
        self.assertEqual(commands[1][:8], ('docker', 'run', '--rm', '--network', 'none', '--user', '101:101', '--entrypoint'))


if __name__ == '__main__':
    unittest.main()
