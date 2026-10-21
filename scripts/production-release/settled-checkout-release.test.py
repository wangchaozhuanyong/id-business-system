"""Offline negative cases for the one-module successor and preserved parent."""
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


class SettledCheckoutTests(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / P.CONTRACT_FILE).read_bytes())

    def test_exact_frozen_inputs(self):
        B.check(self.c)
        self.assertEqual(set(self.c['productionSources']), {P.SOURCE_FILE})
        self.assertEqual(len(P.MODULES), 3)

    def test_scope_widening_parent_change_and_side_effects_rejected(self):
        mutations = [
            lambda c: c['productionSources'].update({'unrelated.ts': 'a' * 64}),
            lambda c: c['validationSources'].clear(),
            lambda c: c['apiModules'].append('other.js'),
            lambda c: c.update(updatedServices=['api', 'admin']),
            lambda c: c.update(reboundServices=['auto-recharge']),
            lambda c: c.update(preservedServices=['mysql']),
            lambda c: c.update(migrationPerformed=True),
            lambda c: c.update(businessActions=1),
            lambda c: c.update(expectedCurrent='b' * 40),
            lambda c: c.update(sourceReviewCommit='c' * 40),
            lambda c: c['baseline']['apiModules'].clear(),
            lambda c: c['baseline']['database'].update(pending=1),
            lambda c: c.update(sqlFenceHelperSha256='d' * 64)
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                c = copy.deepcopy(self.c)
                mutate(c)
                with self.assertRaises(RuntimeError):
                    P.validate_contract(c)

    def test_lock_backup_fence_smoke_and_readback_stay_inherited(self):
        p = P.engine(self.c)
        self.assertEqual(p.UPDATED, ('api',))
        self.assertEqual(p.REBOUND, ('online-recharge',))
        self.assertIn('admin', p.PRESERVED)
        for function in (p.release, p.baseline, p.activate_services, p.smoke):
            self.assertTrue(function.__code__.co_filename.endswith('bitbrowser-history-release.py'))

    def proof(self):
        modules = {n: '1' * 64 for n in P.MODULES}
        qa = {'sources': {'commit': P.SOURCE, 'pullRequest': 655, 'runId': '1',
                          'sourceReceiptSha256': 'a' * 64},
              'release': {'commit': 'b' * 40, 'runId': '2'}}
        return {'version': 1, 'commit': 'b' * 40, 'tree': 'c' * 40,
                'workflowRunId': '3', 'workflowRunAttempt': '1', 'contractSha256': 'd' * 64,
                'scope': P.SCOPE, 'recipe': P.RECIPE, 'qualityVerification': qa,
                'productionSources': self.c['productionSources'], 'controlSources': self.c['controlPins'],
                'parentModulesReproduced': self.c['baseline']['apiModules'],
                'compiledUnselectedUnchanged': True, 'baselineSharedUnchanged': True,
                'baselineClientUnchanged': True, 'migrationPerformed': False, 'businessActions': 0,
                'apiModules': modules, 'files': {
                    **{'api/modules/' + n: v for n, v in modules.items()},
                    **{'source/' + n: v for n, v in self.c['productionSources'].items()}}}

    def test_payload_and_quality_tampering_rejected(self):
        proof = self.proof()
        h = type('Inventory', (), {'file_inventory': staticmethod(lambda _: proof['files'])})
        P.verify_proof(proof, proof, self.c, None, h)
        for key, value in [('businessActions', 1), ('migrationPerformed', True),
                           ('compiledUnselectedUnchanged', False), ('baselineClientUnchanged', False),
                           ('parentModulesReproduced', {}), ('productionSources', {}),
                           ('apiModules', {}), ('qualityVerification', {})]:
            with self.subTest(key=key):
                changed = copy.deepcopy(proof)
                changed[key] = value
                with self.assertRaises((RuntimeError, KeyError)):
                    P.verify_proof(changed, changed, self.c, None, h)
        proof['files']['admin/html/index.html'] = 'e' * 64
        with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_CHANGED'):
            P.verify_proof(proof, proof, self.c, None, h)

    def test_only_js_and_map_change_declaration_is_preserved(self):
        before = {**self.c['baseline']['apiModules'], 'other.js': 'a' * 64}
        after = {**before, **{n: 'b' * 64 for n in P.MODULES if not n.endswith('.d.ts')}}
        B.verify_delta(before, after, {'shared.js': 'c'}, {'shared.js': 'c'}, {'client': 'd'}, {'client': 'd'}, self.c)
        for mutate in (lambda a: a.update({'other.js': 'changed'}),
                       lambda a: a.update({next(n for n in P.MODULES if n.endswith('.d.ts')): 'changed'})):
            changed = copy.deepcopy(after)
            mutate(changed)
            with self.assertRaisesRegex(RuntimeError, 'COMPILED_SCOPE_CHANGED'):
                B.verify_delta(before, changed, {}, {}, {}, {}, self.c)
        with self.assertRaisesRegex(RuntimeError, 'PRESERVED_RUNTIME_CHANGED'):
            B.verify_delta(before, after, {}, {'new': 'changed'}, {}, {}, self.c)

    def test_parent_or_compiled_parent_cannot_be_substituted(self):
        before = dict(self.c['baseline']['apiModules'])
        before[next(n for n in P.MODULES if n.endswith('.js'))] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'NATIVE_PARENT_NOT_REPRODUCED'):
            B.verify_delta(before, before, {}, {}, {}, {}, self.c)

    def test_transport_persists_intent_and_never_retries_uncertain_send(self):
        import tempfile
        from types import SimpleNamespace
        root = P.ROOT / '.runtime'
        root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root) as name:
            with patch.object(B, 'OUT', Path(name)), patch.object(B.subprocess, 'run',
                    return_value=SimpleNamespace(returncode=1, stdout=b'')) as send:
                with self.assertRaisesRegex(RuntimeError, 'COMMAND_ACCEPTANCE_UNCERTAIN'):
                    B.transport({'commit': 'a' * 40, 'workflowRunId': '1'}, 'release')
                self.assertEqual(send.call_count, 1)
                with self.assertRaisesRegex(RuntimeError, 'COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN'):
                    B.transport({'commit': 'a' * 40, 'workflowRunId': '1'}, 'release')
                self.assertEqual(send.call_count, 1)

    def test_api_layer_rebuilds_normalized_ancestors_and_checks_runtime_uid(self):
        import tempfile
        from types import SimpleNamespace
        original_load = P.load
        commands = []

        def build(driver, context, reference, role, before, stage):
            self.assertIn('COPY overlay/ /', (context / 'Dockerfile').read_text())
            for name in ('overlay', 'overlay/app', 'overlay/app/apps', 'overlay/app/apps/api',
                         'overlay/app/apps/api/dist', 'overlay/app/apps/api/dist/nested'):
                self.assertEqual((context / name).stat().st_mode & 0o777, 0o755)
            driver.run('docker', 'build', '--network', 'none', str(context))

        driver = SimpleNamespace(run=lambda *a, **kw: commands.append(a) or 'READABLE\n')
        fake = SimpleNamespace(helpers=lambda: (SimpleNamespace(build_image=build), driver, None))
        with patch.object(P, 'load', side_effect=lambda name: fake if name == 'bitbrowser-history-release.py' else original_load(name)):
            p = P.engine(self.c)
            h, _, _ = p.helpers()
            with tempfile.TemporaryDirectory(dir=P.ROOT / '.runtime') as name:
                context = Path(name)
                (context / 'modules/nested').mkdir(parents=True, mode=0o700)
                (context / 'modules/nested/test.js').write_text('test')
                (context / 'Dockerfile').write_text('FROM parent\nCOPY modules/ /app/apps/api/dist/\n')
                h.build_image(driver, context, 'candidate', 'api', {}, context)
        self.assertEqual(commands[0][:3], ('docker', 'build', '--no-cache'))
        self.assertEqual(commands[1][:8], ('docker', 'run', '--rm', '--network', 'none', '--user', '1000:1000', '--entrypoint'))


if __name__ == '__main__':
    unittest.main()
