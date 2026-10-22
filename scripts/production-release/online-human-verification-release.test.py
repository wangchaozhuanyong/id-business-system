"""Finite source, parent lineage, payload and unchanged production boundaries."""
import copy
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('human_release_test', HERE / 'online-human-verification-release.py')
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)


class HumanRelease(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (P.ROOT / '.runtime').mkdir(exist_ok=True)

    def setUp(self):
        self.c = json.loads((HERE / P.CONTRACT_FILE).read_bytes())

    def reject(self, mutate):
        c = copy.deepcopy(self.c)
        mutate(c)
        with self.assertRaises(RuntimeError):
            P.validate_contract(c)

    def test_closed_sources_and_services(self):
        P.validate_contract(self.c)
        self.assertEqual(len(P.SOURCES), 20)
        self.assertEqual(len(P.MODULES), 15)
        self.assertEqual(len(P.ABSENT), 3)
        self.assertEqual(self.c['updatedServices'], ['api', 'admin', 'online-recharge'])

    def test_wrong_parent(self):
        self.reject(lambda c: c.update(expectedCurrent='a' * 40))

    def test_unreviewed_source(self):
        self.reject(lambda c: c['productionSources'].update({'apps/api/src/other.ts': 'a' * 64}))

    def test_missing_source(self):
        self.reject(lambda c: c['productionSources'].pop(next(iter(P.API))))

    def test_business_actions(self):
        self.reject(lambda c: c.update(businessActions=1))

    def test_migrations(self):
        self.reject(lambda c: c.update(migrationPerformed=True))

    def test_configuration_and_preserved_roles(self):
        self.reject(lambda c: c['updatedServices'].append('mysql'))
        self.reject(lambda c: c['preservedServices'].remove('caddy'))
        self.reject(lambda c: c['reboundServices'].append('auto-recharge'))

    def test_sql_fence(self):
        self.reject(lambda c: c.update(sqlFenceHelperSha256='a' * 64))

    def test_parent_proof_and_controls(self):
        self.reject(lambda c: c['parentPlan'].update(buildProofSha256='a' * 64))
        self.reject(lambda c: c['controlPins'].pop('online-execution-contract.json'))

    def test_clean_remote_stage_contains_full_parent_lineage(self):
        with tempfile.TemporaryDirectory(dir=P.ROOT / '.runtime') as folder:
            stage = Path(folder)
            for n, digest in {**self.c['controlPins'], P.CONTRACT_FILE: P.sha((HERE / P.CONTRACT_FILE).read_bytes())}.items():
                self.assertEqual(P.sha((HERE / n).read_bytes()), digest)
                shutil.copyfile(HERE / n, stage / n)
            staged_spec = importlib.util.spec_from_file_location('human_clean_stage', stage / 'online-human-verification-release.py')
            staged = importlib.util.module_from_spec(staged_spec)
            staged_spec.loader.exec_module(staged)
            staged.validate_contract(self.c)
            prior = staged.load('online-execution-release.py')
            prior.validate_contract(json.loads((stage / prior.CONTRACT_FILE).read_bytes()))

    def test_only_new_service_can_be_absent_from_parent(self):
        native = self.c['nativeParentApiModules']
        P.verify_parent_modules(native, native)
        with self.assertRaises(RuntimeError):
            P.verify_parent_modules({}, native)
        for n in native:
            with self.assertRaises(RuntimeError):
                P.verify_parent_modules({**native, n: 'b' * 64}, native)

    def test_payload_rejects_extra_or_modified_file(self):
        h = P.load('recharge-record-release.py')
        with tempfile.TemporaryDirectory(dir=P.ROOT / '.runtime') as folder:
            payload = Path(folder)
            for n in self.c['productionSources']:
                dest = payload / 'source' / n
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(P.ROOT / n, dest)
                if n.startswith(P.ENGINE):
                    dest = payload / 'online-recharge/source' / n.removeprefix(P.ENGINE)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(P.ROOT / n, dest)
            api = {}
            for n in P.MODULES:
                dest = payload / 'api/modules' / n
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text('synthetic-compiled-output')
                api[n] = P.sha(dest.read_bytes())
            admin = {}
            for n in ['index.html', *(f'assets/synthetic-{i}.js' for i in range(249))]:
                dest = payload / 'admin/html' / n
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text('synthetic-admin-output')
                admin[n] = P.sha(dest.read_bytes())
            parent_modules = self.c['nativeParentApiModules']
            quality = {'sources': {'commit': 'a' * 40, 'reviewedBusinessCommit': P.SOURCE, 'mainCommit': P.SOURCE_MAIN,
                       'pullRequest': 676, 'sourceReceiptSha256': 'a' * 64, 'runId': '1'},
                       'controls': {'commit': 'c' * 40, 'baseCommit': P.CONTROL_BASE, 'pullRequest': P.CONTROL_PR,
                                    'sourceReceiptSha256': 'c' * 64, 'runId': '3'},
                       'release': {'commit': 'b' * 40, 'runId': '2'}}
            parent = {'status': 'ONLINE_HUMAN_PARENT_VERIFIED', 'commit': P.CURRENT,
                      'baseline': {'apiModules': parent_modules}, 'businessActions': 0}
            proof = {'commit': 'b' * 40, 'tree': 'c' * 40, 'workflowRunId': '2', 'workflowRunAttempt': '1',
                'contractSha256': 'a' * 64, 'scope': P.SCOPE, 'recipe': P.RECIPE,
                'productionSources': self.c['productionSources'], 'controlSources': self.c['controlPins'],
                'apiModules': api, 'adminFiles': admin, 'parentNativeModules': parent_modules,
                'parentModulesReproduced': parent_modules, 'nativeParentCapture': parent,
                'qualityVerification': quality, 'baselineSharedUnchanged': True, 'baselineClientUnchanged': True,
                'businessActions': 0, 'migrationPerformed': False, 'files': h.file_inventory(payload)}
            P.verify_proof(proof, proof, self.c, payload, h)
            (payload / 'unexpected').write_text('extra')
            with self.assertRaises(RuntimeError):
                P.verify_proof(proof, proof, self.c, payload, h)

    def test_existing_lock_backup_fence_and_receipts_are_reused(self):
        source = (HERE / 'bitbrowser-history-release.py').read_text()
        for required in ('a.acquire_release_lock(lock)', 'h.fresh_scoped_backup', 'fence.acquire()',
                         'NEEDS_FORWARD_DIAGNOSIS', 'rollbackPerformed', 'SOURCE_INHERITANCE_CHANGED'):
            self.assertIn(required, source)
        publication = (HERE / 'online-human-verification-publication.py').read_text()
        for required in ('COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN', 'NATIVE_RECEIPT_IDENTITY',
                         "transport(plan, 'readback')", 'SOURCE_RECEIPT_CHANGED'):
            self.assertIn(required, publication)

    def test_manifest_keeps_role_and_admin_lineage(self):
        roles = {n: {'commit': 'b' * 40, 'sources': {}, 'parentProjection': {'role': n}}
                 for n in P.UPDATED}
        before = {'commit': P.CURRENT, 'sources': {'old': 'a' * 64}}
        manifest = {'scope': P.SCOPE, 'roleSourceProjections': roles,
                    'adminSourceProjection': before,
                    'bitbrowserHistoryPublication': {'commit': 'b' * 40},
                    'apiCompiledArtifact': {'sha256': 'a' * 64}}
        result = P.project_manifest(manifest, self.c)
        self.assertEqual(result['previousAdminSourceProjection'], before)
        self.assertEqual(result['adminSourceProjection'], result['roleSourceProjections']['admin'])
        self.assertIsNot(result['adminSourceProjection'], result['roleSourceProjections']['admin'])
        for role, paths in (('api', P.API), ('admin', P.ADMIN),
                            ('online-recharge', {P.ENGINE + n for n in P.ENGINE_NAMES})):
            self.assertEqual(set(result['roleSourceProjections'][role]['sources']), paths)
            self.assertEqual(result['roleSourceProjections'][role]['parentProjection'], {'role': role})
        self.assertEqual(result['onlineRechargeCompiledArtifact'], result['apiCompiledArtifact'])
        with self.assertRaises(RuntimeError):
            P.project_manifest({**manifest, 'scope': 'other'}, self.c)

    def test_full_admin_inventory_stays_server_bound(self):
        files = {f'assets/{i}.js': P.sha(str(i).encode()) for i in range(5175)}
        baseline = {'adminInventory': {'count': len(files), 'sha256': P.sha(P.canonical(files))}}
        self.assertEqual(P.verify_parent_admin_files(files, baseline), files)
        for bad in ({}, {**files, 'extra': 'a' * 64}, {**files, 'assets/0.js': 'b' * 64}):
            with self.assertRaises(RuntimeError):
                P.verify_parent_admin_files(bad, baseline)

    def test_parent_admin_inventory_survives_native_stage_cleanup(self):
        files = {'index.html': 'a' * 64, 'assets/previous.js': 'b' * 64}
        baseline = {'adminInventory': {'count': len(files), 'sha256': P.sha(P.canonical(files))}}
        with tempfile.TemporaryDirectory(dir=P.ROOT / '.runtime') as folder:
            target = Path(folder)
            P.persist_parent_admin_files(target, files, baseline)
            saved = json.loads((target / 'online-human-parent-admin-files.json').read_bytes())
            self.assertEqual(P.verify_parent_admin_files(saved, baseline), files)
            with self.assertRaises(RuntimeError):
                P.persist_parent_admin_files(target, files, baseline)
            with self.assertRaises(RuntimeError):
                P.persist_parent_admin_files(target, {'index.html': 'c' * 64}, baseline)

    def test_quality_requires_source_control_and_main_receipts(self):
        value = {'sources': {'commit': 'a' * 40, 'reviewedBusinessCommit': P.SOURCE, 'mainCommit': P.SOURCE_MAIN,
                            'pullRequest': 676, 'sourceReceiptSha256': 'a' * 64, 'runId': '1'},
                 'controls': {'commit': 'b' * 40, 'baseCommit': P.CONTROL_BASE, 'pullRequest': P.CONTROL_PR,
                              'sourceReceiptSha256': 'b' * 64, 'runId': '2'},
                 'release': {'commit': 'c' * 40, 'runId': '3'}}
        P.verify_quality(value, 'c' * 40)
        for change in (lambda v: v.pop('controls'),
                       lambda v: v['controls'].update(baseCommit='d' * 40),
                       lambda v: v['controls'].update(pullRequest=676),
                       lambda v: v['sources'].update(mainCommit='d' * 40)):
            bad = copy.deepcopy(value)
            change(bad)
            with self.assertRaises(RuntimeError):
                P.verify_quality(bad, 'c' * 40)

    def test_publication_reuses_only_exact_business_and_control_provenance(self):
        pub = P.load('online-human-verification-publication.py')
        source, control, commit = 'a' * 40, 'b' * 40, 'c' * 40
        source_tree, control_tree = 'd' * 40, 'e' * 40
        revisions = {source: ('sources', 11), control: ('controls', 12), commit: ('release', 13)}
        runs = {n: {'id': n, 'head_sha': rev, 'run_attempt': 1, 'status': 'completed', 'conclusion': 'success',
                    'event': 'push' if role == 'release' else 'pull_request'} for rev, (role, n) in revisions.items()}
        controls = ['scripts/production-release/online-human-verification-' + n
                    for n in ('release.py', 'publication.py', 'release.test.py', 'contract.json')]
        extra, wrong_tree, missing_engine = False, False, False
        def git(*args):
            if args[0] == 'merge-base': return b''
            if args[0] == 'diff':
                selected = controls if args[2] == P.SOURCE_MAIN else list(pub.CONTROL_PATHS)
                if extra and args[2] == P.SOURCE_MAIN: selected = [*selected, 'apps/api/src/auth/auth.service.ts']
                return '\n'.join(selected).encode()
            return ((source_tree if args[1] == P.SOURCE_MAIN + '^{tree}' else control_tree) + '\n').encode()
        def github(path):
            if path == 'pulls/676':
                return {'merged_at': 'synthetic', 'base': {'ref': 'main'}, 'merge_commit_sha': P.SOURCE_MAIN, 'head': {'sha': source}}
            if path == 'pulls/' + str(P.CONTROL_PR):
                return {'merged_at': 'synthetic', 'base': {'ref': 'main', 'sha': P.CONTROL_BASE}, 'merge_commit_sha': commit, 'head': {'sha': control}}
            if '?head_sha=' in path: return {'workflow_runs': [runs[revisions[path.split('=')[-1]][1]]]}
            n = int(path.split('/')[2])
            names = ['quality', 'change-scope', 'recharge (guards)']
            if n == 11: names += ['recharge (api)', 'recharge (admin)'] + ([] if missing_engine else ['recharge (online-engine)'])
            return {'jobs': [{'name': name, 'conclusion': 'success'} for name in names]}
        def artifact(run, *_args):
            source_role = run['id'] == 11
            receipt = {'repository': pub.REPO, 'headSha': run['head_sha'], 'pullRequest': 676 if source_role else P.CONTROL_PR,
                       'runId': run['id'], 'runAttempt': 1,
                       'testedTree': source_tree if source_role or wrong_tree else control_tree}
            return receipt, 'f' * 64
        with patch.object(pub, 'git', git), patch.object(pub, 'github', github), \
             patch.object(pub.F, 'require_run', lambda *_args: None), patch.object(pub.F, 'artifact_json', artifact):
            self.assertEqual(set(pub.quality(self.c, commit)), {'sources', 'controls', 'release'})
            extra = True
            with self.assertRaisesRegex(RuntimeError, 'CONTROL_EXTENSION_CHANGED'): pub.quality(self.c, commit)
            extra, wrong_tree = False, True
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_RECEIPT_CHANGED'): pub.quality(self.c, commit)
            wrong_tree, missing_engine = False, True
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_QUALITY_REQUIRED'): pub.quality(self.c, commit)

    def test_historical_fetch_is_fixed_missing_only_and_type_checked(self):
        pub = P.load('online-human-verification-publication.py')
        self.assertEqual(len(pub.HISTORICAL_REVIEW_COMMITS), 40)
        missing = 'e0bda43bab61ee6673471cfcffc878d268b70cf5'
        self.assertIn(missing, pub.HISTORICAL_REVIEW_COMMITS)
        state = {'fetched': False, 'wrong': False}
        fetches = []
        def run(args, **_kwargs):
            return pub.subprocess.CompletedProcess(args, int(args[-1] == missing and not state['fetched']))
        def git(*args):
            if args[0] == 'fetch':
                fetches.append(args)
                state['fetched'] = True
                return b''
            return b'tree\n' if state['wrong'] else b'commit\n'
        with patch.object(pub.subprocess, 'run', run), patch.object(pub, 'git', git):
            pub.prefetch_historical_sources()
            self.assertEqual(fetches, [('fetch', '--no-tags', '--no-write-fetch-head', 'origin', missing)])
            pub.prefetch_historical_sources()
            self.assertEqual(len(fetches), 1)
            state['wrong'] = True
            with self.assertRaisesRegex(RuntimeError, 'HISTORICAL_SOURCE_TYPE_CHANGED'):
                pub.prefetch_historical_sources()


if __name__ == '__main__':
    unittest.main()
