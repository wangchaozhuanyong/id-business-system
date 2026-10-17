"""Pure finite-admission and switch tests. No Docker, network or database."""
import copy
import base64
import builtins
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import sqlite3
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch
from urllib.parse import unquote, urlsplit

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location('terminal_test_' + name.replace('-', '_'), HERE / name)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


r = load('registration-terminal-stop-release.py')
b = load('registration-terminal-stop-build.py')
d = load('registration-terminal-stop-dispatch.py')


class TerminalControls(unittest.TestCase):
    def setUp(self):
        for target in (patch.object(socket.socket, 'connect', side_effect=AssertionError('network disabled')),
                       patch.object(sqlite3, 'connect', side_effect=AssertionError('database disabled'))):
            target.start()
            self.addCleanup(target.stop)

    def ready(self):
        old = r.prior_contract()
        successor = r.successor_contract()
        rows = {**old['baselineWorkerFiles'], **old['workerFiles']}
        baseline = copy.deepcopy(old['baseline'])
        baseline.update(commit=r.CURRENT, current='/opt/id-business-v2/releases/approved-a92',
                        manifestSha256='e' * 64, adminBuildId='v2-' + r.CURRENT, publicIndexSha256='f' * 64)
        for role in ('api', 'admin'):
            image = r.PUBLISHED_RECHARGE['native']['readback']['result']['images'][role]['imageId']
            baseline['services'][role]['image'] = image
            baseline['images'][role].update(image=image, revision=r.CURRENT)
        baseline['images']['online-recharge']['revision'] = r.PUBLISHED_SUCCESSOR['commit']
        baseline['inventory']['worker'] = r.signature(rows)
        baseline['inventory']['admin'] = r.signature(successor['publicFiles'])
        registration_inventory = copy.deepcopy(baseline['inventory'])
        baseline['inventory']['api'] = {**baseline['inventory']['api'], 'sha256': 'd' * 64}
        baseline['inventory']['apiJavascript'] = {**baseline['inventory']['apiJavascript'], 'sha256': 'c' * 64}
        baseline['inventory']['admin'] = {**baseline['inventory']['admin'], 'sha256': 'e' * 64}
        baseline['inventory']['engine'] = r.signature(successor['afterEngineFiles'])
        baseline['successorApiModules'] = {**{'id-business-v2/online-recharge/checkout-recovery' + ext: 'a' * 64
            for ext in ('.js', '.js.map', '.d.ts')}, 'id-business-v2/online-recharge/contracts.d.ts': 'b' * 64}
        baseline['successorApiModules'].update({n: 'c' * 64 for n in r.inherited_api_paths()[1]})
        baseline['publishedProofs']['online-checkout-cs-build-proof.json'] = {'sha256': r.PUBLISHED_SUCCESSOR['proofSha256']}
        baseline['publishedProofs']['recharge-checkout-build-proof.json'] = {'sha256': r.PUBLISHED_RECHARGE['proofSha256']}
        c = {'version': 1, 'name': r.NAME, 'scope': r.SCOPE, 'frozen': True, 'admission': 'VERIFIED',
             'pendingEvidence': [], 'migration': None, 'businessActions': 0, 'expectedCurrent': r.CURRENT,
             'sourceBaseline': r.SOURCE_BASE, 'sourceBaselineTree': r.SOURCE_TREE, 'publishedPrevious': r.PUBLISHED_PREVIOUS,
             'publishedSuccessor': r.PUBLISHED_SUCCESSOR,
             'publishedRecharge': r.PUBLISHED_RECHARGE,
             'applicationPaths': list(r.APPLICATION_PATHS), 'expectedGitChanges': list(r.TASK_PATHS),
             'sources': {n: r.digest((r.ROOT / n).read_bytes()) for n in r.APPLICATION_PATHS},
             'validationSources': {}, 'pythonTests': list(r.PYTHON_TESTS), 'apiJavascriptDelta': [],
             'apiRuntimeDelta': [], 'adminDelta': [], 'dependencyDelta': [], 'updatedServices': ['api'],
             'reboundServices': ['online-recharge'], 'baseline': baseline, 'current': baseline['current'],
             'manifestSha256': baseline['manifestSha256'], 'baselineWorkerFiles': rows,
             'schemaSha256': baseline['schemaSha256'], 'publicIndexSha256': baseline['publicIndexSha256'],
             'roleSourceCommits': {'api': r.CURRENT, 'admin': r.CURRENT,
                                  'online-recharge': r.PUBLISHED_SUCCESSOR['commit']},
             'registrationInventory': registration_inventory,
             'configurationSha256': baseline['configurationSha256'],
             'runtimeConfigurationSha256': baseline['runtimeConfigurationSha256'],
             'sourceProjectionSha256': {'roleSourceProjections': baseline['roleSourceProjectionsSha256'],
                                        'adminSourceProjection': baseline['adminSourceProjectionSha256']},
             'hostSourceInheritance': {'release': baseline['current'], 'files': {}},
             'controlFiles': list(r.control_files()),
             'controlHashes': {n: r.digest((HERE / n).read_bytes()) for n in r.control_files()}}
        c['workerFiles'] = {'apple_mailboxes.py': c['sources'][r.SOURCE]}
        for name in ('backupNormalizerPath', 'engineHealth', 'sqlFenceHelperSha256', 'qualityEvidenceHelperSha256'):
            c[name] = old[name]
        c['buildSupportHashes'] = {'scripts/production-release/registration-closure-release.py':
            old['buildSupportHashes']['scripts/production-release/registration-closure-release.py']}
        return c

    def proof(self, c, plan):
        after = copy.deepcopy(c['baseline']['inventory'])
        after['worker'] = r.signature({**c['baselineWorkerFiles'], **c['workerFiles']})
        result = {k: plan[k] for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt',
                                       'contractSha256', 'controlSources')}
        result.update(version=1, scope=r.SCOPE, sources=c['sources'], validationSources={},
                      workerFiles=c['workerFiles'], apiModules={}, apiJavascriptDelta=[], adminFiles={},
                      baselineInventory=c['baseline']['inventory'], afterInventory=after,
                      validation={'status': 'PASS', 'worker': True, 'isolatedPersistence': True,
                                  'pythonTests': list(r.PYTHON_TESTS)}, inheritedValidation=r.inherited_validation(),
                      migrationPerformed=False, businessActions=0)
        result['files'] = {**{'source/' + n: v for n, v in c['sources'].items()},
                           **{'api/worker/' + n: v for n, v in c['workerFiles'].items()}}
        return result

    def test_draft_cannot_reach_release_or_transport(self):
        c = self.ready()
        c.update(admission='DRAFT', frozen=False)
        with self.assertRaisesRegex(RuntimeError, 'CONTRACT_NOT_ADMITTED'):
            r.release({}, c)
        with patch.object(d, 'verified_contract', side_effect=RuntimeError('DRAFT')):
            with self.assertRaisesRegex(RuntimeError, 'DRAFT'):
                d.namespace()['transport']({}, 'release')

    def test_complete_synthetic_admission_and_tamper_rejection(self):
        c = self.ready()
        with patch.object(r, 'BASELINE_PROJECTION_SHA256', r.digest(r.canonical(c['baseline']))):
            r.verify_contract(c)
            for mutate in (
                    lambda x: x.update(expectedCurrent='0' * 40),
                    lambda x: x.update(sourceBaseline='0' * 40),
                    lambda x: x.update(sourceBaselineTree='0' * 40),
                    lambda x: x['baseline']['inventory']['admin'].update(sha256='0' * 64),
                    lambda x: x['baseline']['services']['api'].update(image='sha256:' + '0' * 64),
                    lambda x: x.update(migration={'name': 'wrong'}),
                    lambda x: x.update(businessActions=False),
                    lambda x: x.update(apiJavascriptDelta=['changed.js']),
                    lambda x: x.update(dependencyDelta=['requests']),
                    lambda x: x['workerFiles'].update({'flow_evidence.py': '0' * 64}),
                    lambda x: x['sources'].pop(r.TEST_SOURCE),
                    lambda x: x['expectedGitChanges'].append('unreviewed.py'),
                    lambda x: x['expectedGitChanges'].pop(),
                    lambda x: x['controlHashes'].update({'remote-deploy.py': '0' * 64}),
                    lambda x: x.pop('buildSupportHashes'),
                    lambda x: x['buildSupportHashes'].update({'unexpected.py': '0' * 64}),
                    lambda x: x['buildSupportHashes'].update({
                        'scripts/production-release/registration-closure-release.py': '0' * 64}),
                    lambda x: x['publishedPrevious'].update(runId='1')):
                candidate = copy.deepcopy(c)
                mutate(candidate)
                with self.subTest(mutate=mutate), self.assertRaises(RuntimeError):
                    r.verify_contract(candidate)

    def test_latest_recharge_is_current_with_cs_engine_and_a92_worker_preserved(self):
        c = self.ready()
        self.assertNotEqual(c['baseline']['inventory']['engine'], c['registrationInventory']['engine'])
        self.assertNotEqual(c['baseline']['inventory']['apiJavascript'], c['registrationInventory']['apiJavascript'])
        self.assertEqual(c['baseline']['inventory']['worker'], c['registrationInventory']['worker'])
        with patch.object(r, 'BASELINE_PROJECTION_SHA256', r.digest(r.canonical(c['baseline']))):
            r.verify_contract(c)
            for mutate in (
                    lambda x: x.update(expectedCurrent=r.REGISTRATION_ORIGIN),
                    lambda x: x['baseline']['inventory'].update(api=x['registrationInventory']['api']),
                    lambda x: x['baseline']['inventory'].update(engine=x['registrationInventory']['engine']),
                    lambda x: x['publishedSuccessor'].update(commit=r.REGISTRATION_ORIGIN),
                    lambda x: x.update(expectedCurrent=r.PUBLISHED_SUCCESSOR['commit']),
                    lambda x: x['publishedRecharge']['native']['readback']['result'].update(commit=r.PUBLISHED_SUCCESSOR['commit']),
                    lambda x: x['publishedSuccessor']['native']['readback']['result'].update(commit=r.REGISTRATION_ORIGIN),
                    lambda x: x['baseline'].pop('successorApiModules'),
                    lambda x: x['roleSourceCommits'].update({'online-recharge': '055b308bf357d460ee7746c9e60ae46d575f7661'})):
                changed = copy.deepcopy(c)
                mutate(changed)
                with self.subTest(mutate=mutate), self.assertRaises(RuntimeError):
                    r.verify_contract(changed)

    def test_cs_proof_uses_frozen_successor_verifier_and_live_four_module_hashes(self):
        c = self.ready()
        recipe = r.successor_contract()
        binding = r.PUBLISHED_SUCCESSOR
        publisher = r.helper('online-checkout-cs-release.py')
        modules = {**{'id-business-v2/online-recharge/checkout-recovery' + ext: 'a' * 64
            for ext in ('.js', '.js.map', '.d.ts')}, **recipe['apiDeclarationOnly']}
        c['baseline']['successorApiModules'].update(modules)
        proof = {'version': 1, 'scope': binding['scope'], 'commit': binding['commit'], 'tree': binding['tree'],
                 'workflowRunId': binding['runId'], 'workflowRunAttempt': str(binding['attempt']),
                 'contractSha256': binding['contractSha256'], 'controlSources': {
                     n: r.digest(b.git('show', binding['commit'] + ':scripts/production-release/' + n))
                     for n in recipe['controlFiles']}, 'sources': recipe['sources'],
                 'validationOnlySources': recipe['validationOnlySources'], 'apiModules': modules,
                 'runtimeBaselineCommit': r.REGISTRATION_ORIGIN, 'publishedSourceCommit': recipe['publishedSourceCommit'],
                 'predecessorContractSha256': recipe['predecessorContractSha256'],
                 'beforeEngineFiles': recipe['beforeEngineFiles'], 'afterEngineFiles': recipe['afterEngineFiles'],
                 'baselineApiReproduced': True, 'preservedAdminFiles': recipe['publicFiles'],
                 'updatedServices': list(publisher.UPDATED), 'preservedServices': list(publisher.PRESERVED),
                 'migrationPerformed': False, 'businessActions': 0}
        proof['files'] = {**{'source/' + n: v for n, v in recipe['sources'].items()},
                          **{'api/modules/' + n: v for n, v in modules.items()},
                          **{'engine/' + n: recipe['afterEngineFiles'][n] for n in publisher.ENGINE_DELTA}}
        with patch.object(b, 'bundle_contents', return_value=(proof['files'], proof)):
            self.assertIs(b.verify_successor_bundle(b'synthetic parser seam', c), proof)
        for mutate in (
                lambda x: x.update(commit=r.REGISTRATION_ORIGIN),
                lambda x: x['controlSources'].pop('online-checkout-cs-release.py'),
                lambda x: x['apiModules'].pop('id-business-v2/online-recharge/contracts.d.ts'),
                lambda x: x['afterEngineFiles'].update({'checkout-recovery.cjs': '0' * 64}),
                lambda x: x['preservedAdminFiles'].update({'index.html': '0' * 64}),
                lambda x: x.update(runtimeBaselineCommit='0' * 40)):
            changed = copy.deepcopy(proof)
            mutate(changed)
            with self.subTest(mutate=mutate), patch.object(b, 'bundle_contents', return_value=(proof['files'], changed)):
                with self.assertRaises(RuntimeError):
                    b.verify_successor_bundle(b'synthetic parser seam', c)
        changed = copy.deepcopy(c)
        changed['baseline']['successorApiModules'] = {**modules,
            'id-business-v2/online-recharge/checkout-recovery.js': '0' * 64}
        with patch.object(b, 'bundle_contents', return_value=(proof['files'], proof)):
            with self.assertRaisesRegex(RuntimeError, 'SUCCESSOR_RUNTIME_CHANGED'):
                b.verify_successor_bundle(b'synthetic parser seam', changed)

    def test_worker_proof_preserves_all_other_components_and_truthful_inheritance(self):
        c = self.ready()
        plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '123', 'workflowRunAttempt': '1',
                'contractSha256': 'c' * 64, 'controlSources': c['controlHashes']}
        proof = self.proof(c, plan)
        h = Mock()
        h.file_inventory.return_value = {**proof['files'], 'build-proof.json': '0' * 64}
        self.assertIs(r.verify_proof(proof, plan, c, Path('unused'), h), proof)
        for mutate in (
                lambda x: x['afterInventory']['admin'].update(sha256='0' * 64),
                lambda x: x['afterInventory']['api'].update(sha256='0' * 64),
                lambda x: x['afterInventory']['prisma'].update(sha256='0' * 64),
                lambda x: x['afterInventory']['engine'].update(sha256='0' * 64),
                lambda x: x['adminFiles'].update({'index.html': '0' * 64}),
                lambda x: x['apiModules'].update({'a.js': '0' * 64}),
                lambda x: x['workerFiles'].update({'workspace.py': '0' * 64}),
                lambda x: x['validation'].update(admin=True),
                lambda x: x.update(inheritedValidation={}),
                lambda x: x.update(businessActions=False)):
            candidate = copy.deepcopy(proof)
            mutate(candidate)
            with self.subTest(mutate=mutate), self.assertRaises(RuntimeError):
                r.verify_proof(candidate, plan, c, Path('unused'), h)

    def test_recharge_legacy_proof_shape_preserves_latest_admin_and_42_api_files(self):
        c = self.ready()
        recipe, binding = r.recharge_contract(), r.PUBLISHED_RECHARGE
        modules = {name: 'a' * 64 for name in r.inherited_api_paths()[1]}
        admin = {**{f'assets/synthetic-{i}.js': 'b' * 64 for i in range(250)}, 'index.html': 'c' * 64}
        c['baseline']['successorApiModules'].update(modules)
        c['baseline']['inventory']['admin'] = r.signature({**r.successor_contract()['publicFiles'], **admin})
        c['publicIndexSha256'] = admin['index.html']
        mysql = {'version': 1, 'scope': 'OWNED_EMPTY_DATABASE', 'runtime': 'github-actions-mysql-service',
                 'database': recipe['isolatedMysqlTest']['database'], 'commit': binding['commit'],
                 'tree': binding['tree'], 'workflowRunId': binding['runId'], 'workflowRunAttempt': str(binding['attempt']),
                 'testFile': recipe['isolatedMysqlTest']['testFile'],
                 'testFileSha256': recipe['sources'][recipe['isolatedMysqlTest']['testFile']],
                 'reportSha256': 'd' * 64, 'testsTotal': 8, 'testsPassed': 8, 'testsSkipped': 0, 'testsTodo': 0,
                 'productionActions': 0, 'browserRequests': 0}
        proof = {'version': 1, 'scope': binding['scope'], 'commit': binding['commit'], 'tree': binding['tree'],
                 'workflowRunId': binding['runId'], 'workflowRunAttempt': str(binding['attempt']),
                 'contractSha256': binding['contractSha256'], 'baselineApiReproduced': True,
                 'baselineAdminReproduced': True, 'baselinePublishedVerified': {
                     'apiSource': recipe['apiSourceBaseline'], 'adminSource': recipe['adminSourceBaseline'], 'verified': True},
                 'qualityVerification': {'commit': binding['commit'], 'sourceTree': binding['tree'],
                                         'path': '.github/workflows/quality.yml', 'conclusion': 'success'},
                 'databaseVerification': recipe['databaseVerification'], 'isolatedMysqlVerification': mysql,
                 'apiModules': modules, 'adminFiles': admin, 'updatedServices': ['api', 'admin'],
                 'migrationPerformed': False, 'businessActions': 0}
        for field, name in (('controllerSha256', 'recharge-checkout-release.py'),
                            ('helperSha256', 'recharge-record-release.py'), ('releaseUtilitySha256', 'remote-deploy.py')):
            proof[field] = r.digest(b.git('show', binding['commit'] + ':scripts/production-release/' + name))
        proof['files'] = {**{'source/' + n: v for n, v in recipe['sources'].items()},
                          **{'api/modules/' + n: v for n, v in modules.items()},
                          **{'admin/html/' + n: v for n, v in admin.items()}}
        self.assertNotIn('sources', proof)
        self.assertNotIn('controlSources', proof)
        with patch.object(b, 'bundle_contents', return_value=(proof['files'], proof)):
            self.assertIs(b.verify_recharge_bundle(b'synthetic parser seam', c), proof)
        for mutate in (
                lambda x: x.update(commit=r.PUBLISHED_SUCCESSOR['commit']),
                lambda x: x.update(controllerSha256='0' * 64),
                lambda x: x['isolatedMysqlVerification'].update(testsPassed=0),
                lambda x: x['apiModules'].pop(next(iter(modules))),
                lambda x: x['adminFiles'].update({'index.html': '0' * 64})):
            changed = copy.deepcopy(proof)
            mutate(changed)
            with self.subTest(mutate=mutate), patch.object(b, 'bundle_contents', return_value=(proof['files'], changed)):
                with self.assertRaises(RuntimeError):
                    b.verify_recharge_bundle(b'synthetic parser seam', c)
        changed = copy.deepcopy(c)
        changed['baseline']['inventory']['admin'] = r.signature(r.successor_contract()['publicFiles'])
        with patch.object(b, 'bundle_contents', return_value=(proof['files'], proof)):
            with self.assertRaisesRegex(RuntimeError, 'RECHARGE_RUNTIME_CHANGED'):
                b.verify_recharge_bundle(b'synthetic parser seam', changed)

    def test_native_artifact_rejection_happens_before_extraction(self):
        with self.assertRaisesRegex(RuntimeError, 'PUBLISHED_ARTIFACT_CHANGED'):
            b.verify_previous_bundle(b'unreviewed bytes', {})

    def test_native_prior_run_or_artifact_mismatch_never_downloads_another_bundle(self):
        binding = r.PUBLISHED_PREVIOUS
        run = {'head_sha': binding['commit'], 'head_branch': 'main', 'event': 'workflow_dispatch',
               'path': binding['workflowPath'], 'status': 'completed', 'conclusion': 'success', 'run_attempt': 1}
        artifact = {'id': binding['artifactId'], 'name': binding['artifactName'],
                    'digest': binding['artifactDigest'], 'size_in_bytes': binding['artifactSize'],
                    'expired': False, 'workflow_run': {'id': int(binding['runId']), 'head_sha': binding['commit']}}
        for field, value in (('head_sha', '0' * 40), ('path', 'wrong.yml'), ('run_attempt', 2),
                             ('conclusion', 'failure')):
            changed = {**run, field: value}
            with patch.object(b.subprocess, 'check_output', return_value=json.dumps(changed).encode()) as request:
                with self.assertRaisesRegex(RuntimeError, 'PUBLISHED_NATIVE_RUN_CHANGED'):
                    b.previous_artifact({})
                self.assertEqual(request.call_count, 1)
        for field, value in (('id', 1), ('digest', 'sha256:' + '0' * 64), ('expired', True)):
            changed = {**artifact, field: value}
            with patch.object(b.subprocess, 'check_output', side_effect=[json.dumps(run).encode(),
                    json.dumps(changed).encode()]) as request:
                with self.assertRaisesRegex(RuntimeError, 'PUBLISHED_NATIVE_ARTIFACT_CHANGED'):
                    b.previous_artifact({})
                self.assertEqual(request.call_count, 2)

    def test_local_worker_check_is_blocked_before_database_or_dependency_work(self):
        with patch.dict('os.environ', {'GITHUB_ACTIONS': 'false'}), patch.object(b, 'OUT', Path('/missing')):
            with self.assertRaisesRegex(RuntimeError, 'ISOLATED_CI_REQUIRED'):
                b.check_worker()

    def generated_transport_fixture(self, parent, existing=None):
        # Execute the exact generated SSM Python, redirecting only its absolute
        # host path and platform/HTTP boundaries into this project's fixture.
        entry, output = parent / 'entry', parent / 'receipts'
        output.mkdir()
        real_path, real_import = type(parent), builtins.__import__
        real_spec = importlib.util.spec_from_file_location
        release_source = (HERE / 'registration-terminal-stop-release.py').read_bytes()
        controls = {'registration-terminal-stop-release.py': release_source,
                    'recharge-record-release.py': b'# synthetic platform helper\n',
                    'remote-deploy.py': b'# synthetic platform utility\n'}
        hashes = {name: r.digest(raw) for name, raw in controls.items()}
        raw = json.dumps({'controlHashes': hashes}, sort_keys=True).encode()
        contract_path = entry / 'registration-terminal-stop-contract.json'
        if existing is not None:
            entry.mkdir()
            if existing == 'different':
                contract_path.write_bytes(b'pre-existing different contract')
            elif existing in ('symlink', 'dangling'):
                target = parent / 'contract-target.json'
                if existing == 'symlink': target.write_bytes(raw)
                contract_path.symlink_to(target)
        completed, invoked, downloads, native = [], [], [], {}
        commit, run_id = 'a' * 40, '123'
        expected_entry = '/opt/id-business-v2/.staging/' + d.NAME + '-entry-' + commit + '-' + run_id
        def path(value, *parts):
            if str(value).startswith('/opt/id-business-v2/.staging/'):
                self.assertEqual(str(value), expected_entry)
                return entry.joinpath(*parts)
            return real_path(value, *parts)
        def imports(name, globals=None, locals=None, fromlist=(), level=0):
            if name == 'pathlib' and 'Path' in fromlist:
                return types.SimpleNamespace(Path=path)
            return real_import(name, globals, locals, fromlist, level)
        accepted_code = compile("def release(plan, contract, d, h):\n"
            " completed.append(plan['mode'])\n"
            " return {'status':'SYNTHETIC_ENTRY_VERIFIED','commit':plan['commit']}\n", '<synthetic-pure-platform>', 'exec').co_consts[0]
        old = types.SimpleNamespace(release=lambda: None, completed=completed)
        platform = types.SimpleNamespace(load_utilities=lambda *args: object())
        def spec(name, filename, *args, **kwargs):
            value = real_spec(name, filename, *args, **kwargs)
            loader = value.loader
            class Loader:
                def create_module(self, current): return loader.create_module(current)
                def exec_module(self, module):
                    loader.exec_module(module)
                    # Keep the new release() own-contract read and digest check
                    # real; unrelated hardware/admission is outside this fixture.
                    module.verify_contract = Mock()
                    module.helper = lambda helper: {'recharge-record-release.py': platform,
                        'registration-parity-diagnostics-release.py': old,
                        'registration-flow-v4-release.py': types.SimpleNamespace(sqlite_receipt=lambda: None)}[helper]
                    module.adapted_release_code = lambda original: accepted_code
                    original = module.release
                    def release(*values):
                        invoked.append(1)
                        return original(*values)
                    module.release = release
            value.loader = Loader()
            return value
        def urlopen(url, **kwargs):
            name = url.rsplit('/', 1)[-1]
            downloads.append(name)
            self.assertIn(name, {'registration-terminal-stop-contract.json', *controls})
            return io.BytesIO(raw if name == 'registration-terminal-stop-contract.json' else controls[name])
        def execute(*args):
            self.assertEqual(args[:3], ('aws', 'ssm', 'send-command'))
            parameters = json.loads(args[args.index('--parameters') + 1])
            command = parameters['commands'][0]
            source = '\n'.join(command.splitlines()[1:-1])
            stream = io.StringIO()
            previous_mask = os.umask(0o077)
            previous_bytecode = sys.dont_write_bytecode
            code = 0
            try:
                with patch.object(builtins, '__import__', side_effect=imports), \
                        patch.object(importlib.util, 'spec_from_file_location', side_effect=spec), \
                        patch.object(r.urllib.request, 'urlopen', side_effect=urlopen), contextlib.redirect_stdout(stream):
                    try: exec(compile(source, '<generated-ssm-transport>', 'exec'), {'__name__': '__main__'})
                    except SystemExit as error: code = error.code
            finally:
                os.umask(previous_mask)
                sys.dont_write_bytecode = previous_bytecode
            native.update(Status='Success' if code == 0 else 'Failed', ResponseCode=code,
                          StandardErrorContent='', StandardOutputContent=stream.getvalue())
            return json.dumps({'Command': {'CommandId': 'synthetic-command'}}).encode()
        values = d.namespace()
        values.update(OUTPUT=output, execute=execute, verified_contract=lambda: (raw, json.loads(raw)))
        values['subprocess'] = types.SimpleNamespace(run=lambda *args, **kwargs: types.SimpleNamespace(
            returncode=0, stdout=json.dumps(native).encode()))
        plan = {'commit': commit, 'tree': 'b' * 40, 'workflowRunId': run_id, 'workflowRunAttempt': '1',
                'controlSources': hashes, 'contractSha256': r.digest(raw)}
        return values['transport'], plan, contract_path, raw, completed, invoked, downloads, native

    def test_generated_transport_saves_verified_contract_and_reuses_identical_file(self):
        parent = r.ROOT / '.runtime/registration-terminal-stop-20261017/control-tests'
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='transport-', dir=parent) as directory:
            transport, plan, path, raw, completed, invoked, _, _ = self.generated_transport_fixture(Path(directory))
            with contextlib.redirect_stdout(io.StringIO()): transport(plan, 'preflight')
            self.assertEqual(path.read_bytes(), raw)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            original_inode = path.stat().st_ino
            with contextlib.redirect_stdout(io.StringIO()): transport(plan, 'release')
            self.assertEqual(path.stat().st_ino, original_inode)
            self.assertEqual(path.read_bytes(), raw)
            self.assertEqual(completed, ['preflight', 'release'])
            self.assertEqual(len(invoked), 2)

    def test_generated_transport_rejects_different_or_symlink_contract_before_release(self):
        parent = r.ROOT / '.runtime/registration-terminal-stop-20261017/control-tests'
        parent.mkdir(parents=True, exist_ok=True)
        for existing in ('different', 'symlink', 'dangling'):
            with self.subTest(existing=existing), tempfile.TemporaryDirectory(prefix='transport-', dir=parent) as directory:
                transport, plan, path, _, completed, invoked, downloads, native = self.generated_transport_fixture(
                    Path(directory), existing)
                with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(RuntimeError, 'NATIVE_PREFLIGHT_FAILED'):
                    transport(plan, 'preflight')
                self.assertEqual(completed, [])
                self.assertEqual(invoked, [])
                self.assertEqual(downloads, ['registration-terminal-stop-contract.json'])
                self.assertEqual(json.loads(native['StandardOutputContent'])['code'], r.SCOPE + '_CONTRACT_ENTRY_CHANGED')
                if existing == 'different': self.assertEqual(path.read_bytes(), b'pre-existing different contract')
                else: self.assertTrue(path.is_symlink())

    def test_frozen_switch_adaptation_fails_closed_if_recipe_changes(self):
        old = r.helper('registration-parity-diagnostics-release.py')
        code = r.adapted_release_code(old.release)
        self.assertIsInstance(code, types.CodeType)
        with patch.object(r.inspect, 'getsource', return_value='def release():\n    pass\n'):
            with self.assertRaisesRegex(RuntimeError, 'FROZEN_SWITCH_RECIPE_CHANGED'):
                r.adapted_release_code(old.release)

    def test_public_readback_uses_inherited_admin_and_rejects_preservation_changes(self):
        c = self.ready()
        public = ('<html>v2-' + r.CURRENT + '</html>\n').encode()
        c['publicIndexSha256'] = r.digest(public)
        before = {name: {'containerId': name, 'image': name, 'reference': name, 'environmentSha256': 'env'}
                  for name in ('api', 'admin', 'online-recharge', *r.PRESERVED[1:])}
        after = copy.deepcopy(before)
        after['api']['containerId'] = 'new-api'
        after['online-recharge']['containerId'] = 'new-sidecar'
        c['runtimeConfigurationSha256'] = {role: 'config' for role in after}
        proof = {'afterInventory': c['baseline']['inventory']}
        receipt = {'before': before, 'database': {'hash': 'database'}, 'sqlite': {'hash': 'sqlite'},
                   'previousRoleProjections': {'api': {'commit': 'old-api'}, 'admin': {'commit': r.CURRENT},
                                               'online-recharge': {'commit': 'engine'}}}
        old, h, driver = Mock(), Mock(), Mock()
        h.configuration.return_value = 'config'
        old.runtime.return_value = proof['afterInventory']
        old.mysql_receipt.return_value = receipt['database']
        old.sqlite_receipt.return_value = receipt['sqlite']
        def command(*args, **kwargs):
            if args[:2] == ('docker', 'inspect'):
                return json.dumps([{'HostConfig': {'NetworkMode': 'container:new-api'}}])
            return (c['baseline']['schemaSha256'] if args[-1].endswith('schema.prisma')
                    else c['baseline']['nginxSha256']) + '  file'
        driver.run.side_effect = command
        parent = r.ROOT / '.runtime/registration-terminal-stop-20261017/control-tests'
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='readback-', dir=parent) as directory:
            target = Path(directory)
            (target / 'release-manifest.json').write_text(json.dumps({
                'roleSourceProjections': receipt['previousRoleProjections']}))
            with patch.object(r, 'helper', return_value=old), patch.object(r.urllib.request, 'urlopen',
                    side_effect=lambda *args, **kwargs: io.BytesIO(public)) as read_public:
                r.smoke(driver, target, after, c, proof, receipt, h, Mock(), Mock())
                self.assertEqual(read_public.call_count, 1)
                for role in r.PRESERVED:
                    changed = copy.deepcopy(after)
                    changed[role]['image'] = 'unapproved'
                    with self.subTest(role=role), self.assertRaisesRegex(RuntimeError, 'PRESERVED_SERVICE_CHANGED'):
                        r.smoke(driver, target, changed, c, proof, receipt, h, Mock(), Mock())
                self.assertEqual(read_public.call_count, 1)

    def test_real_backup_wrapper_reaches_frozen_backup_and_verifies_s3_without_a_database(self):
        c = self.ready()
        closure = r.helper('registration-closure-release.py')
        parity = r.helper('registration-parity-diagnostics-release.py')
        summary = {'logicalSha256': 'a' * 64}
        c['baseline']['sqlite'] = summary
        payload = b'SYNTHETIC_BACKUP_BYTES'
        reads = Mock(return_value=summary)
        driver = Mock()
        driver.environment_values.return_value = {'MYSQL_BACKUP_S3_BUCKET': 'synthetic-backup'}
        head = {'ContentLength': len(payload), 'ChecksumSHA256': base64.b64encode(
            bytes.fromhex(r.digest(payload))).decode(), 'ServerSideEncryption': 'AES256'}
        driver.run.side_effect = ['', json.dumps(head)]
        parent = r.ROOT / '.runtime/registration-terminal-stop-20261017/control-tests'
        parent.mkdir(parents=True, exist_ok=True)
        class Connection:
            def __init__(self, path, **kwargs):
                self.path = Path(unquote(urlsplit(path).path)) if isinstance(path, str) and path.startswith('file:') else Path(path)
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def execute(self, *args): return self
            def fetchall(self): return [('ok',)]
            def backup(self, destination): destination.path.write_bytes(payload)
        with tempfile.TemporaryDirectory(prefix='backup-', dir=parent) as directory:
            base = Path(directory)
            (base / 'backups').mkdir()
            volume = base / 'volume'
            volume.mkdir()
            (volume / 'database.db').write_bytes(b'SYNTHETIC_SOURCE')
            marker = volume / '.maintenance'
            marker.write_bytes(b'controlled-owner')
            safety = base / 'release_safety.py'
            safety.write_bytes(b'synthetic safety')
            def helper(name):
                if name == 'registration-parity-diagnostics-release.py': return parity
                if name == 'registration-flow-v4-release.py': return types.SimpleNamespace(sqlite_receipt=reads)
                raise AssertionError('unexpected helper')
            with patch.object(r, 'helper', side_effect=helper), patch.object(closure, 'BASE', base), \
                    patch.object(closure, 'load', return_value=types.SimpleNamespace(logical_summary=lambda db: summary)), \
                    patch.object(sqlite3, 'connect', side_effect=Connection) as connect:
                value = r.backup_sqlite(closure, driver, base, {'commit': 'b' * 40, 'workflowRunId': '123'},
                                        {}, marker, safety, c)
            self.assertTrue(value['s3Verified'])
            self.assertEqual(value['logical'], summary)
            self.assertEqual(value['sha256'], r.digest(payload))
            self.assertEqual(reads.call_args_list[0].args, (driver, base, c, None))
            self.assertEqual(reads.call_args_list[1].args, (driver, base, c, summary['logicalSha256']))
            self.assertEqual(connect.call_count, 3)
            self.assertEqual(driver.run.call_args_list[0].args[:3], ('aws', 's3api', 'put-object'))
            self.assertEqual(driver.run.call_args_list[1].args[:3], ('aws', 's3api', 'head-object'))

    def test_adapted_switch_operates_api_only_and_rebinds_existing_sidecar(self):
        parent = r.ROOT / '.runtime/registration-terminal-stop-20261017/control-tests'
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='switch-', dir=parent) as directory:
            base = Path(directory)
            previous = base / 'releases/previous'
            previous.mkdir(parents=True)
            (base / '.staging').mkdir()
            (base / '.deploy.lock').touch()
            manifest = {'commit': r.CURRENT, 'roleSourceProjections': {
                'api': {'commit': r.CURRENT}, 'admin': {'commit': r.CURRENT}, 'online-recharge': {'commit': 'd' * 40}},
                'images': {}}
            raw_manifest = json.dumps(manifest).encode()
            (previous / 'release-manifest.json').write_bytes(raw_manifest)
            (previous / 'compose.release.json').write_text(json.dumps({'services': {
                'api': {'image': 'old-api'}, 'admin': {'image': 'old-admin'}}}))
            before = {name: {'containerId': 'old-' + name, 'image': 'base-' + name} for name in
                      ('api', 'admin', 'online-recharge', *r.PRESERVED[1:])}
            after = copy.deepcopy(before)
            after['api'] = {'containerId': 'new-api', 'image': 'new-api-image'}
            after['online-recharge']['containerId'] = 'new-sidecar'
            observed = {'database': {'hash': 'db'}, 'sqlite': {'logicalSha256': 'sqlite'}}
            a, finite, h, driver = Mock(), Mock(), Mock(), Mock()
            driver.assert_no_active_recharge = Mock()
            driver.assert_no_active_registration = Mock()
            a.write_release_override.side_effect = lambda path, value: path.write_text(json.dumps(value))
            finite.claim_markers.return_value = {'paths': ['unused', str(base / 'marker')]}
            h.base_image_reference.return_value = 'published-api'
            h.fresh_scoped_backup.return_value = {'s3Verified': True}
            h.snapshot.return_value = after
            driver.run.return_value = json.dumps([{'Id': 'new-api-image'}])
            proof = {'sources': {}, 'apiModules': {}, 'adminFiles': {}, 'workerFiles': {'apple_mailboxes.py': '1' * 64}}
            plan = {'mode': 'release', 'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '123',
                    'workflowRunAttempt': '1', 'runtimeBaseline': observed, 'controlSources': {},
                    'artifactSha256': r.digest(b'archive'), 'buildProofSha256': r.digest(json.dumps(proof).encode()),
                    'artifactUrl': 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/'
                                   + r.NAME + '-' + 'a' * 40 + '/' + r.NAME + '-artifact.tar.gz'}
            contract = {'scope': r.SCOPE, 'expectedCurrent': r.CURRENT, 'migration': None, 'frozen': True,
                        'sources': {}, 'hostSourceInheritance': {'files': {}}, 'backupNormalizerPath': 'normalizer',
                        'baselineWorkerFiles': {'release_safety.py': r.digest(b'safety')},
                        'sourceProjectionSha256': {}, 'sourceBaseline': r.CURRENT, 'sourceBaselineTree': r.SOURCE_TREE,
                        'roleSourceCommits': {}, 'reviewedApplicationCommit': plan['commit']}
            safety = previous / r.WORKER / 'release_safety.py'
            safety.parent.mkdir(parents=True)
            safety.write_bytes(b'safety')
            old = r.helper('registration-parity-diagnostics-release.py')
            payload = base / 'payload'
            (payload / 'api/worker').mkdir(parents=True)
            (payload / 'api/worker/apple_mailboxes.py').write_bytes(b'candidate')
            (payload / 'build-proof.json').write_text(json.dumps(proof))
            helpers = {'recharge-availability-release.py': a, 'proxy-result-identity-release.py': finite}
            values = {**old.__dict__, 'BASE': base, 'CURRENT': r.CURRENT, 'SCOPE': r.SCOPE,
                      'PRESERVED': r.PRESERVED, 'need': r.need, 'verify_contract': Mock(),
                      'helper': lambda name: helpers.get(name, Mock()), 'baseline': Mock(return_value=(
                          previous, raw_manifest, before, observed)), 'archive': Mock(return_value=payload),
                      'verify_proof': Mock(return_value=proof), 'inherited_host_source': lambda c: previous,
                      'sqlite_receipt': Mock(return_value=observed['sqlite']),
                      'backup_sqlite': Mock(return_value={'s3Verified': True, 'logical': observed['sqlite']}),
                      'smoke': Mock()}
            execute = types.FunctionType(r.adapted_release_code(old.release), values)
            with patch.object(old.urllib.request, 'urlopen', return_value=io.BytesIO(b'archive')):
                result = execute(plan, contract, driver, h)
            self.assertEqual(result['updatedServices'], ['api'])
            self.assertEqual(result['reboundServices'], ['online-recharge'])
            self.assertEqual(set(result['images']), {'api'})
            builds = h.build_image.call_args_list
            self.assertEqual(len(builds), 1)
            dockerfile = (builds[0].args[1] / 'Dockerfile').read_text()
            self.assertIn('COPY worker/', dockerfile)
            self.assertNotIn('COPY modules/', dockerfile)
            self.assertNotIn('html', dockerfile)
            commands = driver.compose.call_args_list
            self.assertEqual([call.args[1:] for call in commands], [
                ('up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'api'),
                ('up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'online-recharge')])
            target = driver.point_current.call_args.args[0]
            value = json.loads((target / 'release-manifest.json').read_bytes())
            self.assertEqual(value['roleSourceProjections']['admin'], manifest['roleSourceProjections']['admin'])
            self.assertEqual(value['roleSourceProjections']['online-recharge'], manifest['roleSourceProjections']['online-recharge'])
            self.assertEqual(json.loads((target / 'compose.release.json').read_bytes())['services']['admin']['image'], 'old-admin')
            self.assertEqual(value['servicesUpdated'], ['api'])


if __name__ == '__main__':
    unittest.main()
