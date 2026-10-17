"""Offline contract, payload, preservation and actual switch-order guards; no cloud or database."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


r = load('online-checkout-cs-release.py')
b = load('online-checkout-cs-build.py')


class PublicationTests(unittest.TestCase):
    def contract(self):
        previous = json.loads((HERE / 'online-legacy-close-contract.json').read_bytes())
        before = previous['engineFiles']
        after = {**before, **{name: 'f' * 64 for name in r.ENGINE_DELTA}}
        for name, pin in r.VALIDATION_ONLY_SOURCES.items():
            after[name.removeprefix(r.ENGINE_ROOT + '/')] = pin['sha256']
        c = {**previous, 'version': 1, 'scope': r.SCOPE,
             'reviewBase': 'a' * 40, 'sourceReviewCommit': 'b' * 40,
             'publishedSourceCommit': r.PUBLISHED_SOURCE_COMMIT,
             'apiModules': [r.API_MODULE], 'apiDeclarationOnly': {r.DECLARATION: 'd' * 64},
             'beforeEngineFiles': before, 'afterEngineFiles': after,
             'validationOnlySources': copy.deepcopy(r.VALIDATION_ONLY_SOURCES),
             'predecessorContractSha256': b.sha((HERE / 'online-legacy-close-contract.json').read_bytes()),
             'controlFiles': [*previous['controlFiles'], 'online-checkout-cs-build.py',
                              'online-checkout-cs-release.py', 'online-checkout-cs-release.test.py'],
             'publishedOverlays': [
                 {'proofFile': 'online-checkout-build-proof.json', 'proofSha256': 'a' * 64},
                 {'proofFile': 'registration-latest-build-proof.json', 'proofSha256': 'b' * 64},
                 {'proofFile': 'online-legacy-close-build-proof.json', 'proofSha256': 'c' * 64}],
             'sources': {name: 'e' * 64 for name in r.ALLOWED_SOURCES}}
        for name in r.BUSINESS_ENGINE_DELTA:
            c['sources'][r.ENGINE_ROOT + '/' + name] = after[name]
        return c

    def fixture(self):
        c = self.contract()
        plan = {'commit': 'b' * 40, 'tree': 'c' * 40, 'workflowRunId': '123',
                'workflowRunAttempt': '1', 'contractSha256': 'd' * 64,
                'controlSources': {name: 'a' * 64 for name in c['controlFiles']}}
        modules = {r.API_MODULE.removesuffix('.js') + ext: 'a' * 64 for ext in ('.js', '.js.map', '.d.ts')}
        modules[r.DECLARATION] = c['apiDeclarationOnly'][r.DECLARATION]
        files = {**{'source/' + name: value for name, value in c['sources'].items()},
                 **{'api/modules/' + name: value for name, value in modules.items()},
                 **{'engine/' + name: c['afterEngineFiles'][name] for name in r.ENGINE_DELTA}}
        proof = {**plan, 'version': 1, 'scope': r.SCOPE,
                 'runtimeBaselineCommit': c['expectedCurrent'],
                 'publishedSourceCommit': c['publishedSourceCommit'],
                 'predecessorContractSha256': c['predecessorContractSha256'],
                 'sources': c['sources'], 'apiModules': modules,
                 'validationOnlySources': c['validationOnlySources'],
                 'beforeEngineFiles': c['beforeEngineFiles'], 'afterEngineFiles': c['afterEngineFiles'],
                 'preservedAdminFiles': c['publicFiles'], 'baselineApiReproduced': True,
                 'files': files, 'updatedServices': list(r.UPDATED), 'preservedServices': list(r.PRESERVED),
                 'migrationPerformed': False, 'businessActions': 0}
        return c, plan, proof, files

    def temporary(self):
        # A fresh CI checkout has no ignored evidence directory yet.
        parent = ROOT / '.runtime/online-checkout-cs-fix-20261017'
        parent.mkdir(parents=True, exist_ok=True)
        return tempfile.TemporaryDirectory(dir=parent)

    def test_temporary_evidence_initializes_a_clean_project_checkout(self):
        with self.temporary() as outer:
            fresh = Path(outer) / 'fresh-checkout'
            with patch.dict(self.temporary.__func__.__globals__, {'ROOT': fresh}):
                with self.temporary() as directory:
                    self.assertEqual(Path(directory).parent,
                                     fresh / '.runtime/online-checkout-cs-fix-20261017')
                    self.assertTrue(Path(directory).is_dir())

    def reuse_fixture(self):
        run = {'id': int(b.REUSED_RUN['runId']), 'head_sha': b.REUSED_RUN['commit'],
               'head_branch': 'main', 'event': 'workflow_dispatch',
               'path': '.github/workflows/online-checkout-cs-validation.yml',
               'status': 'completed', 'conclusion': 'success'}
        jobs = [{'name': 'validate', 'conclusion': 'success',
                 'steps': [{'name': name, 'conclusion': 'success'} for name in b.REUSED_STEPS]}]
        return run, jobs, sorted(b.REUSE_CONTROLS)

    def test_reuse_authenticates_the_exact_successful_native_run_and_only_control_changes(self):
        run, jobs, changes = self.reuse_fixture()
        self.assertTrue(b.validate_reuse(run, jobs, changes))
        for changed in [{'id': 123}, {'head_sha': 'f' * 40}, {'head_branch': 'other'},
                        {'event': 'push'}, {'path': '.github/workflows/quality.yml'},
                        {'status': 'in_progress'}, {'conclusion': 'failure'}]:
            with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                b.validate_reuse({**run, **changed}, jobs, changes)
        for changed in [[], changes + ['apps/api/src/id-business-v2/online-recharge/contracts.ts'],
                        changes + ['package-lock.json'], changes + ['scripts/production-release/api-admin-scope.py']]:
            with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                b.validate_reuse(run, jobs, changed)

    def test_reuse_rejects_missing_duplicate_skipped_failed_or_unrelated_native_checks(self):
        run, jobs, changes = self.reuse_fixture()
        variants = [[], jobs + jobs, [{**jobs[0], 'name': 'other'}],
                    [{**jobs[0], 'conclusion': 'failure'}]]
        for index in range(len(b.REUSED_STEPS)):
            for status in ('skipped', 'failure', 'cancelled'):
                bad = copy.deepcopy(jobs)
                bad[0]['steps'][index]['conclusion'] = status
                variants.append(bad)
        variants.extend([[{**jobs[0], 'steps': jobs[0]['steps'][:1]}],
                         [{**jobs[0], 'steps': jobs[0]['steps'] + [jobs[0]['steps'][0]]}],
                         [{**jobs[0], 'steps': jobs[0]['steps'] + [{'name': 'other', 'conclusion': 'failure'}]}]])
        for changed in variants:
            with self.subTest(jobs=changed), self.assertRaises(RuntimeError):
                b.validate_reuse(run, changed, changes)

    def test_finite_contract_accepts_new_runtime_and_review_base_without_guessing_them(self):
        c = self.contract()
        r.validate_contract(c)
        c['reviewBase'] = 'f' * 40
        c['expectedCurrent'] = 'e' * 40
        c['current'] = '/opt/id-business-v2/releases/newer-independent-registration'
        c['publicFiles']['assets/newer-published.js'] = 'a' * 64
        c['beforeApiOnlineFiles']['id-business-v2/online-recharge/retained.d.ts'] = 'a' * 64
        c['beforeEngineFiles'] = {**c['beforeEngineFiles'], 'retained.cjs': 'b' * 64}
        c['afterEngineFiles'] = {**c['afterEngineFiles'], 'retained.cjs': 'b' * 64}
        r.validate_contract(c)
        self.assertEqual(len(r.ALLOWED_SOURCES), 16)
        self.assertEqual(len(r.BUSINESS_ENGINE_DELTA), 10)
        self.assertEqual(len(r.ENGINE_DELTA), 11)
        self.assertEqual(r.UPDATED, ('api', 'online-recharge'))

    def test_actual_frozen_contract_runs_reviewed_sql_helper_admission_without_a_process_or_database(self):
        c = json.loads((HERE / r.CONTRACT_FILE).read_bytes())
        self.assertEqual(c['sqlFenceHelperSha256'], r.SQL_FENCE_HELPER_SHA256)
        self.assertEqual(r.sha((HERE / 'api-admin-scope.py').read_bytes()), r.SQL_FENCE_HELPER_SHA256)
        original_load = r.load
        admitted = []
        def traced_load(name):
            module = original_load(name)
            if name == 'proxy-result-identity-release.py':
                actual_admission = module.sql_fence_class
                def admission(contract):
                    fence = actual_admission(contract)
                    admitted.append(fence)
                    return fence
                module.sql_fence_class = admission
            return module
        with patch.object(r, 'load', side_effect=traced_load), \
                patch('subprocess.Popen', side_effect=AssertionError('admission cannot start a process')), \
                patch('subprocess.run', side_effect=AssertionError('admission cannot run a command')):
            r.validate_contract(c)
        self.assertEqual(len(admitted), 1)
        fence = admitted[0]
        self.assertEqual(fence.__name__, 'OnlineSqlFence')
        self.assertIn('id_business_v2_recharge_jobs', fence.QUERY)
        self.assertTrue(any(isinstance(value, str) and 'id_business_v2_recharge_jobs WRITE' in value
                            for value in fence.acquire.__code__.co_consts))

    def test_missing_or_changed_sql_helper_binding_stops_before_any_admission(self):
        c = self.contract()
        for value in [None, '', '0' * 64]:
            damaged = {**c, 'sqlFenceHelperSha256': value}
            if value is None:
                damaged.pop('sqlFenceHelperSha256')
            with self.subTest(value=value), patch.object(r, 'load') as loader, \
                    self.assertRaisesRegex(RuntimeError, 'SQL_FENCE_BINDING_CHANGED'):
                r.validate_contract(damaged)
            loader.assert_not_called()

    def test_actual_sql_helper_file_is_checked_before_admission(self):
        c = self.contract()
        with self.temporary() as directory:
            controls = Path(directory)
            helper = controls / 'api-admin-scope.py'
            for kind in ['missing', 'changed', 'symlink']:
                if kind == 'changed':
                    helper.write_bytes(b'changed helper')
                elif kind == 'symlink':
                    helper.unlink()
                    helper.symlink_to(HERE / 'api-admin-scope.py')
                with self.subTest(kind=kind), patch.object(r, 'HERE', controls), \
                        patch.object(r, 'load') as loader, \
                        self.assertRaisesRegex(RuntimeError, 'SQL_FENCE_SOURCE_CHANGED'):
                    r.validate_contract(c)
                loader.assert_not_called()

    def test_contract_rejects_extra_source_module_engine_changes_and_old_check_reuse(self):
        c = self.contract()
        changes = [
            {'scope': 'OTHER'}, {'publishedSourceCommit': 'a' * 40}, {'reviewBase': 'invalid'},
            {'sources': {**c['sources'], 'apps/admin/unreviewed.vue': 'a' * 64}},
            {'sources': {**c['sources'], 'apps/api/prisma-mysql/schema.prisma': 'a' * 64}},
            {'apiModules': [r.API_MODULE, 'auth/auth.service.js']},
            {'apiDeclarationOnly': {**c['apiDeclarationOnly'], 'auth/auth.service.d.ts': 'a' * 64}},
            {'beforeApiOnlineFiles': {'auth/auth.service.js': 'a' * 64}},
            {'afterEngineFiles': {**c['afterEngineFiles'], 'unreviewed.cjs': 'a' * 64}},
            {'afterEngineFiles': {**c['afterEngineFiles'], 'worker.cjs': 'a' * 64}},
            {'afterEngineFiles': {name: value for name, value in c['afterEngineFiles'].items() if name != 'worker.cjs'}},
            {'publishedOverlays': c['publishedOverlays'][:2]},
            {'validationReuse': {'runId': 'old'}}, {'services': {'api': {}}},
            {'controlFiles': c['controlFiles'] + ['../outside.py']},
            {'controlFiles': c['controlFiles'] + [c['controlFiles'][0]]}, {'controlFiles': []},
            {'validationOnlySources': {}},
            {'validationOnlySources': {**c['validationOnlySources'],
                r.ENGINE_ROOT + '/worker.cjs': {'commit': r.PUBLISHED_SOURCE_COMMIT, 'sha256': 'a' * 64}}},
        ]
        for change in changes:
            with self.subTest(change=list(change)), self.assertRaises(RuntimeError):
                r.validate_contract({**c, **change})

    def test_native_proof_binds_complete_source_runtime_and_preserved_website(self):
        c, plan, proof, files = self.fixture()
        r.verify_proof(proof, plan, c, files)
        for change in [{'commit': 'f' * 40}, {'tree': 'f' * 40}, {'workflowRunAttempt': '2'},
                       {'controlSources': {}}, {'sources': {}}, {'validationOnlySources': {}},
                       {'runtimeBaselineCommit': 'f' * 40},
                       {'publishedSourceCommit': 'f' * 40}, {'predecessorContractSha256': 'f' * 64},
                       {'beforeEngineFiles': {}}, {'afterEngineFiles': {}}, {'baselineApiReproduced': False},
                       {'preservedAdminFiles': {}}, {'updatedServices': ['api', 'admin', 'online-recharge']},
                       {'preservedServices': ['mysql']}, {'migrationPerformed': True},
                       {'businessActions': 1}, {'businessActions': False}]:
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                r.verify_proof({**proof, **change}, plan, c, files)

    def test_payload_cannot_include_admin_auth_secrets_schema_or_omit_a_required_file(self):
        c, plan, proof, files = self.fixture()
        for path in ['admin/html/index.html', 'engine/.env', 'api/schema.prisma',
                     'api/modules/auth/auth.service.js', 'source/.env.aws.production']:
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                r.verify_proof(proof, plan, c, {**files, path: 'f' * 64})
        for path in ['engine/checkout-recovery.cjs', 'engine/test/payment-observation.test.cjs',
                     'api/modules/' + r.DECLARATION]:
            smaller = {name: value for name, value in files.items() if name != path}
            with self.subTest(missing=path), self.assertRaises(RuntimeError):
                r.verify_proof({**proof, 'files': smaller}, plan, c, smaller)
        damaged = {**proof, 'apiModules': {**proof['apiModules'], r.DECLARATION: 'f' * 64}}
        with self.assertRaises(RuntimeError):
            r.verify_proof(damaged, plan, c, files)

    def test_compiled_delta_allows_only_the_checkout_module_and_explicit_contract_declaration(self):
        c, _, proof, _ = self.fixture()
        before = {name: 'b' * 64 for name in proof['apiModules']}
        after = {**before, r.API_MODULE: 'c' * 64, r.API_MODULE + '.map': 'e' * 64,
                 r.DECLARATION: c['apiDeclarationOnly'][r.DECLARATION]}
        delta = load('online-checkout-build.py').module_delta
        self.assertEqual(set(delta(before, after, c['apiModules'], c['apiDeclarationOnly'])), set(before))
        for damaged in [
                {**after, 'auth/auth.service.js': 'a' * 64},
                {**after, 'id-business-v2/online-recharge/contracts.js.map': 'a' * 64},
                {**after, r.DECLARATION: 'f' * 64},
                {name: value for name, value in after.items() if name != r.API_MODULE}]:
            with self.subTest(keys=list(damaged)), self.assertRaises(RuntimeError):
                delta(before, damaged, c['apiModules'], c['apiDeclarationOnly'])

    def test_reconstruction_retains_the_published_engine_then_applies_only_the_8df_closure(self):
        with self.temporary() as directory:
            root = Path(directory)
            controls = root / 'controls'
            controls.mkdir()
            content = b'published closure source'
            previous = {'sources': {'apps/api/retained-closure.ts': b.sha(content)}}
            raw = json.dumps(previous).encode()
            (controls / 'online-legacy-close-contract.json').write_bytes(raw)
            def reconstruct(target, recipe):
                self.assertEqual(recipe, previous)
                path = target / 'engine/worker.cjs'
                path.parent.mkdir(parents=True)
                path.write_bytes(b'published worker')
            builder = types.SimpleNamespace(reconstruct=reconstruct)
            helper = load('recharge-record-release.py')
            def loader(name):
                return builder if name == 'online-legacy-close-build.py' else helper
            c = {'predecessorContractSha256': b.sha(raw), 'publishedSourceCommit': r.PUBLISHED_SOURCE_COMMIT,
                 'engineRoot': 'engine', 'beforeEngineFiles': {'worker.cjs': b.sha(b'published worker')}}
            with patch.object(b, 'HERE', controls), patch.object(b, 'load', side_effect=loader), \
                    patch.object(b, 'git', return_value=content) as git:
                b.reconstruct(root / 'context', c)
                git.assert_called_once_with('show', r.PUBLISHED_SOURCE_COMMIT + ':apps/api/retained-closure.ts')
                self.assertEqual((root / 'context/apps/api/retained-closure.ts').read_bytes(), content)
                c['predecessorContractSha256'] = '0' * 64
                with self.assertRaises(RuntimeError):
                    b.reconstruct(root / 'unused', c)

    def test_source_manifest_requires_every_candidate_file_once_with_its_real_bytes(self):
        with self.temporary() as directory:
            context = Path(directory)
            engine = context / 'engine'
            engine.mkdir()
            (engine / 'retained.cjs').write_bytes(b'published')
            row = {'path': 'retained.cjs', 'adaptedSha256': b.sha(b'published')}
            manifest = engine / 'SOURCE_MANIFEST.json'
            c = {'engineRoot': 'engine', 'afterEngineFiles': {'retained.cjs': row['adaptedSha256']}}
            for rows in [[row], [row, row], [{**row, 'adaptedSha256': '0' * 64}], []]:
                manifest.write_text(json.dumps({'files': rows}))
                if rows == [row]:
                    b.engine_manifest(context, c)
                else:
                    with self.subTest(rows=rows), self.assertRaises(RuntimeError):
                        b.engine_manifest(context, c)

    def test_validation_only_test_is_extracted_from_the_exact_existing_git_commit(self):
        c = self.contract()
        with self.temporary() as directory:
            target = Path(directory)
            b.validation_sources(target, c)
            for name, pin in c['validationOnlySources'].items():
                self.assertEqual(b.sha((target / name).read_bytes()), pin['sha256'])
                self.assertNotIn(name, c['sources'])
                self.assertEqual(pin['commit'], r.PUBLISHED_SOURCE_COMMIT)
            self.assertEqual([p.relative_to(target).as_posix() for p in target.rglob('*') if p.is_file()],
                             list(c['validationOnlySources']))

    def test_validation_pins_cannot_change_revision_hash_path_or_add_a_runtime_source(self):
        c = self.contract()
        name, pin = next(iter(c['validationOnlySources'].items()))
        changes = [{name: {**pin, 'commit': 'f' * 40}}, {name: {**pin, 'sha256': '0' * 64}},
                   {name: {**pin, 'extra': 'unreviewed'}},
                   {r.ENGINE_ROOT + '/worker.cjs': pin},
                   {name: pin, r.ENGINE_ROOT + '/upstream/index.js': pin}]
        for pins in changes:
            bad = {**c, 'validationOnlySources': pins}
            with self.subTest(pins=pins), self.assertRaises(RuntimeError):
                r.validate_contract(bad)
            with patch.object(b, 'git') as git, self.assertRaises(RuntimeError):
                b.validation_sources(Path('/must-not-write'), bad)
            git.assert_not_called()
        with self.temporary() as directory, patch.object(b, 'git', return_value=b'wrong pinned bytes'), \
                self.assertRaises(RuntimeError):
            b.validation_sources(Path(directory), c)

    def test_existing_publication_proofs_are_retained_without_overwrite(self):
        with self.temporary() as directory:
            path = Path(directory)
            c = self.contract()
            for row in c['publishedOverlays']:
                content = row['proofFile'].encode()
                (path / row['proofFile']).write_bytes(content)
                row['proofSha256'] = r.sha(content)
            r.published_proofs(path, c)
            for row in c['publishedOverlays']:
                target = path / row['proofFile']
                original = target.read_bytes()
                target.write_bytes(b'drift')
                with self.assertRaises(RuntimeError):
                    r.published_proofs(path, c)
                target.write_bytes(original)

    def test_website_comparison_covers_added_and_missing_files_not_only_the_expected_subset(self):
        c = {'publicFiles': {'index.html': 'a' * 64}, 'nginxSha256': 'b' * 64}
        states = {'admin': {'containerId': 'same-admin'}}
        valid = 'a' * 64 + '  /usr/share/nginx/html/index.html\n'
        for output in [valid, '', valid + 'c' * 64 + '  /usr/share/nginx/html/extra.js\n', valid + valid]:
            d = types.SimpleNamespace(run=Mock(side_effect=[output, 'b' * 64 + '  nginx']))
            if output == valid:
                r.preserved_admin(d, states, c)
            else:
                with self.subTest(output=output), self.assertRaises(RuntimeError):
                    r.preserved_admin(d, states, c)

    def test_runtime_requires_the_sidecar_to_share_the_new_api_network(self):
        c = self.contract()
        states = c['services']
        module = types.SimpleNamespace(configuration_matches=Mock(return_value=True))
        for mode in ['container:' + states['api']['containerId'], 'bridge', 'container:old-api']:
            d = types.SimpleNamespace(run=Mock(return_value=json.dumps([{'HostConfig': {'NetworkMode': mode}}])))
            with patch.object(r, 'load', return_value=module):
                if mode == 'container:' + states['api']['containerId']:
                    r.verify_runtime(d, object(), states, c)
                else:
                    with self.assertRaises(RuntimeError):
                        r.verify_runtime(d, object(), states, c)

    def test_preflight_rejects_invalid_identity_before_any_runtime_driver_load(self):
        c, plan, _, _ = self.fixture()
        admission = load('proxy-result-identity-release.py')
        def only_admission(name):
            self.assertEqual(name, 'proxy-result-identity-release.py')
            return admission
        for changed in [{'mode': 'finalize'}, {'commit': 'invalid'}, {'tree': 'invalid'},
                        {'workflowRunId': '0'}, {'workflowRunAttempt': '0'}]:
            with self.subTest(changed=changed), patch.object(r, 'load', side_effect=only_admission) as loader, \
                    self.assertRaises(RuntimeError):
                r.release({**plan, 'mode': 'preflight', **changed}, c)
            self.assertEqual([call.args for call in loader.call_args_list], [('proxy-result-identity-release.py',)])

    def test_delta_images_retain_the_parent_layers_command_environment_and_labels(self):
        verifier = load('online-checkout-release.py').verify_image
        original = {'RootFS': {'Layers': ['base-1', 'base-2']},
                    'Config': {'Env': ['PRESERVED=1'], 'Cmd': ['node', 'main.js'],
                               'Labels': {'published': 'retained'}}}
        plan = {'commit': 'a' * 40, 'buildProofSha256': 'b' * 64}
        built = copy.deepcopy(original)
        built['RootFS']['Layers'].append('only-reviewed-copy')
        built['Config']['Labels'].update({'org.opencontainers.image.revision': plan['commit'],
            'id-business-v2.recharge-record-build-proof-sha256': plan['buildProofSha256']})
        verifier(original, built, plan)
        for section, key, value in [
                ('RootFS', 'Layers', ['unrelated-base', 'delta']),
                ('RootFS', 'Layers', original['RootFS']['Layers'] + ['extra', 'extra']),
                ('Config', 'Env', ['PRESERVED=changed']), ('Config', 'Cmd', ['other']),
                ('Config', 'Labels', {})]:
            damaged = copy.deepcopy(built)
            damaged[section][key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                verifier(original, damaged, plan)

    def test_preflight_fixes_manifest_services_and_disk_headroom_before_any_switch(self):
        with self.temporary() as directory:
            base = Path(directory)
            previous = base / 'releases/published'
            previous.mkdir(parents=True)
            (base / 'current').symlink_to(previous, target_is_directory=True)
            c = self.contract()
            c['current'] = str(previous)
            manifest = json.dumps({'commit': c['expectedCurrent']}).encode()
            (previous / 'release-manifest.json').write_bytes(manifest)
            c['manifestSha256'] = r.sha(manifest)
            for name in c['configurationSha256']:
                raw = ('synthetic ' + name).encode()
                (previous / name).write_bytes(raw)
                c['configurationSha256'][name] = r.sha(raw)
            for row in c['publishedOverlays']:
                raw = row['proofFile'].encode()
                (previous / row['proofFile']).write_bytes(raw)
                row['proofSha256'] = r.sha(raw)
            normalizer = previous / 'normalizer.sed'
            normalizer.write_bytes(b'synthetic normalizer')
            c['backupNormalizerPath'] = str(normalizer)
            c['backupNormalizerSha256'] = r.sha(normalizer.read_bytes())
            h = types.SimpleNamespace(snapshot=Mock(return_value=c['services']), guards=Mock())
            helper = types.SimpleNamespace(read_hashes=Mock(), engine_content=Mock())
            disk = types.SimpleNamespace(free=7 * 1024**3)
            with patch.object(r, 'BASE', base), patch.object(r, 'verify_runtime'), \
                    patch.object(r, 'preserved_admin'), patch.object(r, 'load', return_value=helper), \
                    patch.object(r.shutil, 'disk_usage', return_value=disk):
                self.assertEqual(r.baseline(object(), h, c)[0], previous)
                h.guards.assert_called_once()
                disk.free = 6 * 1024**3
                with self.assertRaisesRegex(RuntimeError, 'DISK_LOW'):
                    r.baseline(object(), h, c)
                disk.free = 7 * 1024**3
                changed = copy.deepcopy(c['services'])
                changed['admin']['containerId'] = 'another-website'
                h.snapshot.return_value = changed
                with self.assertRaisesRegex(RuntimeError, 'SERVICES_CHANGED'):
                    r.baseline(object(), h, c)
                h.snapshot.return_value = c['services']
                (previous / 'release-manifest.json').write_bytes(b'{}')
                with self.assertRaisesRegex(RuntimeError, 'MANIFEST_CHANGED'):
                    r.baseline(object(), h, c)

    def test_smoke_preserves_every_other_service_and_both_updated_environments(self):
        c, _, proof, _ = self.fixture()
        states = copy.deepcopy(c['services'])
        for role in r.UPDATED:
            states[role] = {**states[role], 'image': 'sha256:new-' + role, 'containerId': 'new-' + role}
        modules = types.SimpleNamespace(read_hashes=Mock(), engine_content=Mock())
        h = types.SimpleNamespace(engine_idle=Mock())
        with patch.object(r, 'load', return_value=modules), patch.object(r, 'verify_runtime'), \
                patch.object(r, 'preserved_admin'):
            r.smoke(object(), h, Path('/unused'), states, proof, c)
            for role, key in [(role, 'containerId') for role in r.PRESERVED] + [
                    (role, 'environmentSha256') for role in r.UPDATED]:
                altered = copy.deepcopy(states)
                altered[role][key] = 'drift'
                with self.subTest(role=role, key=key), self.assertRaises(RuntimeError):
                    r.smoke(object(), h, Path('/unused'), altered, proof, c)

    def switch_fixture(self, busy=False):
        c, plan, proof, _ = self.fixture()
        before = c['services']
        images = {role: {'imageId': 'new-' + role} for role in r.UPDATED}
        after = {**before, **{role: {**before[role], 'image': images[role]['imageId']} for role in r.UPDATED}}
        events = []
        def idle():
            events.append('idle')
            if busy:
                raise RuntimeError('busy')
        fence = types.SimpleNamespace(acquire=lambda: events.append('acquire'), check_idle=idle,
                                      close=lambda: events.append('close'))
        p = types.SimpleNamespace(claim_markers=lambda *args: events.append('markers') or {'owner': 'candidate'},
                                 sql_fence_class=lambda c: lambda *args: events.append('fence-init') or fence,
                                 release_markers=lambda *args: events.append('release-markers'))
        d = types.SimpleNamespace(compose=lambda directory, *args, **kwargs: events.append(('compose', args)),
                                 wait_healthy=lambda directory, role: events.append(('healthy', role)))
        h = types.SimpleNamespace(snapshot=lambda *args: after, guards=lambda *args: events.append('guards'))
        journal = types.SimpleNamespace(write_text=lambda raw: events.append(json.loads(raw)['status']))
        return c, plan, proof, before, images, after, events, d, h, p, journal

    def test_switch_uses_the_sql_fence_and_never_recreates_the_website_or_other_roles(self):
        c, plan, proof, before, images, after, events, d, h, p, journal = self.switch_fixture()
        with patch.object(r, 'smoke', side_effect=lambda *args: events.append('smoke')):
            result = r.switch_services(d, h, p, Path('/previous'), Path('/target'), plan,
                                       before, images, proof, c, journal)
        self.assertEqual(result, after)
        self.assertEqual(events, [
            'fence-init', 'markers', 'SWITCH_STARTED', 'acquire', ('compose', ('stop', 'online-recharge')), 'idle',
            ('compose', ('stop', 'api')), 'idle', 'close',
            ('compose', ('up', '-d', '--no-deps', 'api')), ('healthy', 'api'),
            ('compose', ('up', '-d', '--no-deps', '--force-recreate', 'online-recharge')),
            ('healthy', 'online-recharge'), 'smoke', 'close', 'release-markers', 'guards'])

    def test_a_busy_fence_stops_the_switch_before_api_stop_and_keeps_failure_ownership(self):
        c, plan, proof, before, images, _, events, d, h, p, journal = self.switch_fixture(busy=True)
        with patch.object(r, 'smoke') as smoke, self.assertRaisesRegex(RuntimeError, 'busy'):
            r.switch_services(d, h, p, Path('/previous'), Path('/target'), plan,
                              before, images, proof, c, journal)
        self.assertEqual(events, ['fence-init', 'markers', 'SWITCH_STARTED', 'acquire',
                                 ('compose', ('stop', 'online-recharge')), 'idle', 'SWITCH_FAILED', 'close'])
        smoke.assert_not_called()

    def test_fence_admission_failure_does_not_claim_markers_or_begin_a_switch(self):
        c, plan, proof, before, images, _, events, d, h, p, journal = self.switch_fixture()
        p.sql_fence_class = Mock(side_effect=RuntimeError('helper admission failed'))
        p.claim_markers = Mock()
        with self.assertRaisesRegex(RuntimeError, 'helper admission failed'):
            r.switch_services(d, h, p, Path('/previous'), Path('/target'), plan,
                              before, images, proof, c, journal)
        p.claim_markers.assert_not_called()
        self.assertEqual(events, [])

    def test_actual_fence_constructor_failure_does_not_claim_markers_or_start_a_database_process(self):
        c, plan, proof, before, images, _, events, d, h, _, journal = self.switch_fixture()
        p = load('proxy-result-identity-release.py')
        p.claim_markers = Mock()
        d.service_state = Mock(side_effect=RuntimeError('mysql snapshot unavailable'))
        with patch.object(p.subprocess, 'Popen', side_effect=AssertionError('constructor cannot open database')), \
                self.assertRaisesRegex(RuntimeError, 'mysql snapshot unavailable'):
            r.switch_services(d, h, p, Path('/previous'), Path('/target'), plan,
                              before, images, proof, c, journal)
        d.service_state.assert_called_once_with(Path('/previous'), 'mysql',
                                                include_container_id=True, include_environment_hash=True)
        p.claim_markers.assert_not_called()
        self.assertEqual(events, [])

    def test_failed_post_switch_verification_never_releases_markers_or_reports_success(self):
        c, plan, proof, before, images, _, events, d, h, p, journal = self.switch_fixture()
        with patch.object(r, 'smoke', side_effect=RuntimeError('content drift')), \
                self.assertRaisesRegex(RuntimeError, 'content drift'):
            r.switch_services(d, h, p, Path('/previous'), Path('/target'), plan,
                              before, images, proof, c, journal)
        self.assertIn('SWITCH_FAILED', events)
        self.assertNotIn('release-markers', events)
        self.assertNotIn('guards', events)


if __name__ == '__main__':
    unittest.main()
