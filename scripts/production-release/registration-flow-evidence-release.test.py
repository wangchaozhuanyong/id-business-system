"""Pure publication controls: all databases, containers, HTTP, AWS and GitHub are fake."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUTPUT = ROOT / '.runtime/registration-flow-evidence-20261016/control-tests'


def load(name):
    spec = importlib.util.spec_from_file_location('flow_test_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


r = load('registration-flow-evidence-release.py')
b = load('registration-flow-evidence-build.py')
dispatch = load('registration-flow-evidence-dispatch.py')
h = load('recharge-record-release.py')
finite = load('proxy-result-identity-release.py')


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


class FlowEvidenceControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        OUTPUT.mkdir(parents=True, exist_ok=True)
        cls.contract = json.loads((HERE / 'registration-flow-evidence-contract.json').read_bytes())

    def test_current_baseline_and_no_schema_or_upstream_payload(self):
        c = self.contract
        self.assertEqual(c['expectedCurrent'], '69eba563895bf083b24c8214a088454d5df34922')
        self.assertEqual(c['manifestSha256'], '1ac35c615202a5ee41c4c8197868f6dbefb16f19012a6cfaba5ee0bbd57f37c9')
        self.assertIsNone(c['migration'])
        self.assertEqual((len(c['baselineApiFiles']), len(c['baselineAdminFiles']),
                          len(c['baselineEngineFiles']), len(c['baselinePrismaClientFiles'])), (584, 257, 83, 18))
        self.assertEqual(c['baselineAdminBuildId'], 'v2-7c3c102c98539d33cb379ef018427371ba750cb7')
        self.assertEqual(c['identityNative']['commit'], c['expectedCurrent'])
        self.assertEqual(c['sourceBaseline'], '88bce5ab09d20cd303f1fdd5fe310cb0b42e1451')
        self.assertEqual(c['sourceBaselineTree'], '57a0d354276724e70945513c9db806919e245b09')
        self.assertNotEqual(c['sourceBaseline'], c['expectedCurrent'])
        self.assertTrue(all('/upstream/' not in n for n in c['allowedApplicationPaths']))
        self.assertTrue(all('/prisma' not in n for n in c['allowedApplicationPaths']))

    def test_unfrozen_source_contract_fails_before_any_build(self):
        with self.assertRaisesRegex(RuntimeError, 'CONTRACT_NOT_FROZEN'):
            b.verify_sources({**self.contract, 'frozen': False})

    def test_git_review_base_is_separate_from_published_projection_and_scope_is_exact(self):
        contract = {**self.contract, 'frozen': True}
        approved = set(contract['sources']) | set(contract['validationSources']) | set(contract['controlPaths'])
        original = b.git

        def git_fixture(*args):
            if args[0] == 'status':
                return b''
            if args[:2] == ('diff', '--name-only'):
                self.assertEqual(args[2:], (contract['sourceBaseline'], 'HEAD'))
                return '\n'.join(sorted(approved)).encode()
            return original(*args)

        with patch.object(b, 'git', side_effect=git_fixture):
            b.verify_sources(contract)
            with self.assertRaisesRegex(RuntimeError, 'CONTRACT_NOT_FROZEN'):
                b.verify_sources({**contract, 'sourceBaseline': contract['expectedCurrent']})
        with patch.object(b, 'git', side_effect=lambda *args: b'foreign/path\n' if args[0] == 'diff' else git_fixture(*args)):
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_SCOPE_CHANGED'):
                b.verify_sources(contract)

    def test_finite_api_declaration_propagation_and_unknown_outputs(self):
        module = 'id-business-v2/auto-registration/apple-mailboxes.types.js'
        before = {module: 'old-js', module.removesuffix('.js') + '.d.ts': 'old-declaration', 'unrelated.js': 'fixed'}
        after = {**before, module.removesuffix('.js') + '.d.ts': 'new-declaration'}
        self.assertEqual(b.api_delta(before, after, {module: 'old-js'}),
                         {module.removesuffix('.js') + '.d.ts': 'new-declaration'})
        for value in ({**after, 'unrelated.js': 'changed'}, {k: v for k, v in after.items() if k != 'unrelated.js'}, before):
            with self.assertRaisesRegex(RuntimeError, 'API_OUTPUT_SCOPE_CHANGED'):
                b.api_delta(before, value, {module: 'old-js'})
        with self.assertRaisesRegex(RuntimeError, 'BASE_APPROVED_MODULE_NOT_REPRODUCED'):
            b.api_delta(before, after, {module: 'foreign'})

    def test_private_client_comparison_only_rewrites_two_metadata_fields_and_rejects_other_bytes(self):
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary:
            contexts = [Path(temporary) / role for role in ('before', 'after')]
            published = self.contract['prismaPathMetadata']['publishedContext']
            common = {'engine.node': b'frozen synthetic engine', 'schema.prisma': b'frozen schema',
                      'index.d.ts': b'frozen declaration'}

            def generated(prefix):
                return ('const config = {\n  "output": {\n      "value": '
                        + json.dumps(prefix + '/node_modules/@prisma/client', ensure_ascii=False)
                        + ',\n      "fromEnvVar": null\n    },\n  "sourceFilePath": '
                        + json.dumps(prefix + '/apps/api/prisma-mysql/schema.prisma', ensure_ascii=False)
                        + '\n};\nconst stable = 1;\n').encode()

            expected = {**{name: sha(raw) for name, raw in common.items()},
                        **{name: sha(generated(published)) for name in ('index.js', 'edge.js', 'wasm.js')}}
            contract = {**self.contract, 'baselinePrismaClientFiles': expected}
            for context in contexts:
                directory = context / 'node_modules/.prisma/client'
                directory.mkdir(parents=True)
                for name, raw in {**common, **{name: generated(str(context)) for name in ('index.js', 'edge.js', 'wasm.js')}}.items():
                    (directory / name).write_bytes(raw)
                before = b.inventory(directory)
                self.assertEqual(b.unchanged_client(context, contract), expected)
                self.assertEqual(b.inventory(directory), before, 'comparison must not edit generated files')
            directory = contexts[1] / 'node_modules/.prisma/client'
            for name, replacement in [('engine.node', b'foreign engine'), ('schema.prisma', b'foreign schema'),
                                      ('index.d.ts', b'foreign declaration'),
                                      ('index.js', generated(str(contexts[1])).replace(b'const stable = 1', b'const stable = 2')),
                                      ('index.js', generated(str(contexts[1])).replace(b'const stable = 1;\n', b'const stable = 1;\r\n')),
                                      ('index.js', generated(str(contexts[1])).replace(b'"fromEnvVar": null', b'"fromEnvVar": "FOREIGN"'))]:
                path = directory / name
                original = path.read_bytes()
                path.write_bytes(replacement)
                with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'UNCHANGED_CLIENT_NOT_REPRODUCED'):
                    b.unchanged_client(contexts[1], contract)
                path.write_bytes(original)
            path = directory / 'index.js'
            original = path.read_bytes()
            for raw in (original.replace(b'"sourceFilePath": ', b'"unknown": '),
                        original.replace(str(contexts[1]).encode(), b'/foreign/path'), original + original):
                path.write_bytes(raw)
                with self.assertRaisesRegex(RuntimeError, 'CLIENT_METADATA_FIELD_CHANGED'):
                    b.unchanged_client(contexts[1], contract)
            path.write_bytes(original)
            for name in ('tsconfig.tsbuildinfo', 'tsconfig.build.tsbuildinfo'):
                foreign = directory / name
                foreign.write_bytes(b'undeclared file')
                with self.assertRaisesRegex(RuntimeError, 'UNCHANGED_CLIENT_NOT_REPRODUCED'):
                    b.unchanged_client(contexts[1], contract)
                foreign.unlink()

    def test_archive_rejects_traversal_duplicate_link_and_foreign_roots(self):
        for names, link in [(['payload/../../foreign'], False), (['foreign/file'], False),
                            (['payload/link'], True), (['payload/same', 'payload/same'], False)]:
            with self.subTest(names=names), tempfile.TemporaryDirectory(dir=OUTPUT) as directory:
                data = io.BytesIO()
                with tarfile.open(fileobj=data, mode='w:gz') as archive:
                    for name in names:
                        entry = tarfile.TarInfo(name)
                        if link:
                            entry.type, entry.linkname = tarfile.SYMTYPE, '/foreign'
                        archive.addfile(entry, io.BytesIO())
                with self.assertRaisesRegex(RuntimeError, 'ARTIFACT_PATH_INVALID'):
                    r.archive(data.getvalue(), Path(directory) / 'content')

    def test_generated_runtime_inventory_programs_parse_without_importing_api(self):
        adapter = Mock()
        for method, args in [(r.api_inventory, ({'containerId': 'fake'}, '/fixed/', {},)),
                             (r.worker_inventory, ({'containerId': 'fake'}, {}))]:
            adapter.run.return_value = '{}'
            method(adapter, *args)
            command = adapter.run.call_args.args
            self.assertEqual(command[:3], ('docker', 'exec', 'fake'))
            source = command[-1]
            result = subprocess.run(['node', '--check'], input=source, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('@prisma/client', source)
            self.assertNotIn('process.env', source)

    def test_existing_three_table_fence_and_owned_registration_gate_remain_real(self):
        klass = finite.sql_fence_class(self.contract)
        self.assertIn('id_business_v2_recharge_jobs', klass.QUERY)
        self.assertEqual(klass.QUERY.count('SELECT COUNT(*)'), 3)
        self.assertEqual(r.PRESERVED, ('mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration'))
        with tempfile.TemporaryDirectory(dir=OUTPUT) as directory:
            root = Path(directory)
            marker = root / 'registration-marker'
            with patch.object(finite, 'BASE', root), patch.object(finite, 'registration_marker', return_value=marker):
                receipt = finite.claim_markers(Mock(), {}, {'commit': 'a' * 40, 'workflowRunId': '123'})
                finite.verify_markers(receipt)
                marker.write_text('foreign')
                with self.assertRaisesRegex(RuntimeError, 'MAINTENANCE_OWNER_CHANGED'):
                    finite.release_markers(receipt)
                self.assertTrue((root / 'maintenance.json').exists())

    def proof_fixture(self, directory):
        c = copy.deepcopy(self.contract)
        relative = 'apps/api/src/id-business-v2/auto-registration/worker/flow_evidence.py'
        raw = b'only synthetic evidence helper'
        c.update(sources={relative: sha(raw)}, validationSources={}, workerFiles={'flow_evidence.py': sha(raw)})
        module = 'id-business-v2/auto-registration/apple-mailboxes.types.js'
        c['apiModules'] = {module: 'old'}
        plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '123', 'workflowRunAttempt': '1',
                'contractSha256': 'c' * 64, 'controlSources': {}}
        proof = {**plan, 'version': 1, 'scope': r.SCOPE, 'sources': c['sources'], 'validationSources': {},
                 'sourceBaseline': c['sourceBaseline'], 'sourceBaselineTree': c['sourceBaselineTree'],
                 'runtimeBaselineCommit': c['expectedCurrent'], 'sourceProjection': 'PUBLISHED_RUNTIME_PLUS_TASK_DELTA',
                 'workerFiles': c['workerFiles'], 'baselinePrismaClientFiles': c['baselinePrismaClientFiles'],
                 'prismaPathMetadata': c['prismaPathMetadata'],
                 'baselineEngineFiles': c['baselineEngineFiles'], 'schemaSha256': c['schemaSha256'],
                 'baselineApiReproduced': True, 'baselineAdminReproduced': True, 'unchangedClientReproduced': True,
                 'registrationNative': c['registrationNative'], 'identityNative': c['identityNative'],
                 'updatedServices': ['api', 'admin'], 'reboundServices': ['online-recharge'],
                 'migrationPerformed': False, 'businessActions': 0,
                 'apiModules': {module: sha(b'new')},
                 'adminFiles': {f'assets/file-{n}.js': sha(b'asset') for n in range(201)},
                 'validation': {'scope': r.SCOPE, 'sources': c['sources'], 'validationSources': {},
                                'businessActions': 0, 'externalRequests': 0, 'status': 'PASS'}}
        for relative, raw in [('source/' + relative, raw), ('api/worker/flow_evidence.py', raw),
                              ('api/modules/' + module, b'new')]:
            path = directory / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        for name in proof['adminFiles']:
            path = directory / 'admin/html' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'asset')
        proof['files'] = h.file_inventory(directory)
        return c, plan, proof

    def test_exact_payload_has_worker_helper_and_no_client_schema_or_engine(self):
        with tempfile.TemporaryDirectory(dir=OUTPUT) as name:
            payload = Path(name)
            c, plan, proof = self.proof_fixture(payload)
            r.verify_proof(proof, plan, c, payload, h)
            for relative in ['api/prisma-client/index.js', 'api/schema.prisma', 'online-recharge/engine/worker.cjs',
                             'api/worker/unknown.py']:
                path = payload / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('foreign')
                with self.subTest(relative=relative), self.assertRaisesRegex(RuntimeError, 'PAYLOAD_SCOPE_CHANGED'):
                    r.verify_proof(proof, plan, c, payload, h)
                path.unlink()
            for field in ['workerFiles', 'baselinePrismaClientFiles', 'migrationPerformed', 'updatedServices', 'reboundServices',
                          'validationSources', 'sources', 'unchangedClientReproduced']:
                changed = copy.deepcopy(proof)
                changed[field] = 'foreign'
                with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'PROOF_INVALID'):
                    r.verify_proof(changed, plan, c, payload, h)

    def test_existing_workflow_reuses_entry_and_finite_mode_is_explicit(self):
        source = (ROOT / '.github/workflows/registration-closure-validation.yml').read_text()
        self.assertIn('registration-flow-evidence', source)
        self.assertIn('group: id-business-v2-production-release', source)
        self.assertIn('cancel-in-progress: false', source)
        self.assertIn('inputs.commit == github.sha', source)
        self.assertIn('registration-closure-build.py validate', source)
        self.assertIn('registration-closure-build.py package', source)
        self.assertIn("inputs.release_kind != 'registration-flow-evidence'", source)
        for filename in ['registration-closure-build.py', 'registration-closure-dispatch.py']:
            self.assertIn("os.environ.get('REGISTRATION_FLOW_EVIDENCE') == '1'", (HERE / filename).read_text())

    def test_no_database_migration_or_engine_rebuild_in_forward_controller(self):
        source = (HERE / 'registration-flow-evidence-release.py').read_text()
        self.assertNotIn('apply_migration', source)
        self.assertNotIn('migrate deploy', source)
        self.assertNotIn('prisma-client/', source[source.index('for role, copies, count in'):])
        self.assertIn("('api', 'COPY modules/", source)
        self.assertIn("'--force-recreate', 'online-recharge'", source)
        self.assertLess(source.index("fence.stop(before['api']"), source.index("fence.stop(before['online-recharge']"))
        self.assertLess(source.index('smoke(d, target, states'), source.index("finite.release_markers(receipt['maintenance'])"))
        self.assertIn('NEEDS_FORWARD_DIAGNOSIS', source)
        self.assertIn('if fence is not None:', source)
        self.assertNotIn('rollback(', source)

    def test_ssm_transport_never_repeats_accepted_send_or_discards_pending_receipt(self):
        with tempfile.TemporaryDirectory(dir=OUTPUT) as name:
            directory = Path(name)
            plan = {'commit': 'a' * 40, 'controlSources': {}, 'workflowRunId': '123'}
            accepted = {'Command': {'CommandId': 'fake-command'}}
            response = {'Status': 'Success', 'ResponseCode': 0, 'StandardErrorContent': '',
                        'StandardOutputContent': json.dumps({'commit': plan['commit']})}
            with patch.object(dispatch, 'OUTPUT', directory), patch.object(dispatch, 'execute', return_value=json.dumps(accepted).encode()) as send, \
                    patch.object(dispatch.subprocess, 'run', return_value=Mock(returncode=0, stdout=json.dumps(response).encode())):
                dispatch.transport(plan, 'preflight')
                self.assertEqual(send.call_count, 1)
                self.assertEqual(json.loads((directory / 'preflight-accepted-command.json').read_bytes())['CommandId'], 'fake-command')
                with self.assertRaisesRegex(RuntimeError, 'COMMAND_ALREADY_ACCEPTED'):
                    dispatch.transport(plan, 'preflight')
                self.assertEqual(send.call_count, 1)

    def test_real_release_call_graph_builds_two_images_rebinds_engine_and_retains_failed_markers(self):
        for fail_switch in (False, True):
            with self.subTest(fail_switch=fail_switch), tempfile.TemporaryDirectory(dir=OUTPUT) as temporary:
                base = Path(temporary)
                previous = base / 'releases/previous'
                previous.mkdir(parents=True)
                (base / '.staging').mkdir()
                (base / 'current').symlink_to(previous)
                source = previous / r.WORKER / 'release_safety.py'
                source.parent.mkdir(parents=True)
                source.write_bytes(b'old fixed safety')
                (previous / 'compose.release.json').write_text(json.dumps({'services': {
                    name: {'image': 'original-' + name} for name in ('api', 'admin', 'online-recharge')}}))
                projections = {name: {'kind': 'exact-published-' + name} for name in ('api', 'admin', 'online-recharge')}
                raw_manifest = json.dumps({'roleSourceProjections': projections, 'images': {}, 'commit': b.BASE}).encode()
                (previous / 'release-manifest.json').write_bytes(raw_manifest)
                payload = base / 'fixture'
                payload.mkdir()
                c, plan, proof = self.proof_fixture(payload)
                c.update(frozen=True, baselineWorkerFiles={'release_safety.py': sha(source.read_bytes())})
                plan.update(mode='release')
                proof_raw = json.dumps(proof).encode()
                (payload / 'build-proof.json').write_bytes(proof_raw)
                stream = io.BytesIO()
                with tarfile.open(fileobj=stream, mode='w:gz') as archive:
                    archive.add(payload, arcname='payload')
                bundle = stream.getvalue()
                plan.update(buildProofSha256=sha(proof_raw), artifactSha256=sha(bundle),
                    artifactUrl='https://github.com/wangchaozhuanyong/id-business-system/releases/download/registration-flow-evidence-'
                    + plan['commit'] + '/registration-flow-evidence-artifact.tar.gz')
                before = {role: {'containerId': role + '-old', 'image': 'image-' + role,
                    'reference': 'original-' + role, 'environmentSha256': 'env-' + role} for role in
                    ('api', 'admin', 'online-recharge', *r.PRESERVED)}
                after = copy.deepcopy(before)
                observed = {'sqlite': {'logicalSha256': 'synthetic-logical'}, 'database': {'safe': True}}
                plan['runtimeBaseline'] = observed
                calls, image_metadata = [], {}
                original = {'RootFS': {'Layers': ['base']}, 'Config': {'Labels': {}, 'Env': ['fixed=1']}}

                def docker(*args, **kwargs):
                    if args[:3] == ('docker', 'image', 'inspect'):
                        return json.dumps([image_metadata.get(args[3], original)])
                    raise AssertionError('Unexpected container operation')

                def build_image(driver, context, reference, role, state, stage):
                    self.assertIn(role, ('api', 'admin'))
                    image_metadata[reference] = {'Id': 'new-' + role,
                        'RootFS': {'Layers': ['base'] + ['copy'] * (2 if role == 'api' else 1)},
                        'Config': {'Env': ['fixed=1'], 'Labels': {'org.opencontainers.image.revision': plan['commit'],
                            'id-business-v2.recharge-record-build-proof-sha256': plan['buildProofSha256']}}}
                    calls.append('build-' + role)

                def compose(directory, *args, **kwargs):
                    self.assertEqual(args[:2], ('up', '-d'))
                    calls.append('start-' + args[-1])
                    if fail_switch:
                        raise RuntimeError('synthetic-switch-failure')
                    for role in ('api', 'admin') if args[-1] == 'admin' else ('online-recharge',):
                        after[role]['containerId'] = role + '-new'
                        if role != 'online-recharge':
                            after[role]['image'] = 'new-' + role

                class Fence:
                    def __init__(self, *_): pass
                    def acquire(self): calls.append('acquire')
                    def check_idle(self): calls.append('idle')
                    def stop(self, state, *, grace): calls.append(('stop', state['containerId'], grace))
                    def close(self): calls.append('close')

                driver = Mock(run=docker, compose=compose, assert_no_active_recharge=Mock(), assert_no_active_registration=Mock())
                driver.point_current.side_effect = lambda target, _: ((base / 'current').unlink(), (base / 'current').symlink_to(target))
                adapter = Mock(snapshot=Mock(side_effect=lambda *_: copy.deepcopy(after)), build_image=build_image,
                    base_image_reference=lambda _, state: state['reference'], fresh_scoped_backup=Mock(return_value={'s3Verified': True}))
                a = load('recharge-availability-release.py')
                registration = Mock(backup_sqlite_locked=Mock(return_value={'s3Verified': True, 'logical': observed['sqlite']}))
                wrappers = Mock(claim_markers=finite.claim_markers, verify_markers=finite.verify_markers,
                    release_markers=finite.release_markers, sqlite_receipt=Mock(return_value=observed['sqlite']),
                    sql_fence_class=Mock(return_value=Fence), verify_overlay_image=finite.verify_overlay_image)
                helpers = {'recharge-availability-release.py': a, 'proxy-result-identity-release.py': wrappers,
                           'registration-closure-release.py': registration, 'recharge-billing-release.py': Mock()}
                marker = base / 'registration-marker'
                with patch.object(r, 'BASE', base), patch.object(r, 'helper', side_effect=lambda name: helpers[name]), \
                        patch.object(r, 'baseline', return_value=(previous, raw_manifest, before, observed)), \
                        patch.object(r, 'verify_proof', side_effect=lambda *args: proof), patch.object(r, 'smoke') as smoke, \
                        patch.object(r.urllib.request, 'urlopen', return_value=io.BytesIO(bundle)), \
                        patch.object(finite, 'BASE', base), patch.object(finite, 'registration_marker', return_value=marker):
                    if fail_switch:
                        with self.assertRaisesRegex(RuntimeError, 'synthetic-switch-failure'):
                            r.release(plan, c, driver, adapter)
                        self.assertTrue(marker.exists())
                        self.assertEqual((base / 'current').resolve(), previous)
                        journal = next((base / '.staging').glob('*/switch-state.json'))
                        self.assertEqual(json.loads(journal.read_bytes())['status'], 'NEEDS_FORWARD_DIAGNOSIS')
                    else:
                        result = r.release(plan, c, driver, adapter)
                        self.assertEqual(result['updatedServices'], ['api', 'admin'])
                        self.assertEqual(result['reboundServices'], ['online-recharge'])
                        self.assertFalse(result['migrationPerformed'])
                        self.assertTrue(marker.exists(), 'gate must survive until independent readback')
                        r.release({**plan, 'mode': 'readback'}, c, driver, adapter)
                        self.assertFalse(marker.exists())
                        self.assertEqual(smoke.call_count, 2)
                self.assertEqual(calls[:2], ['build-api', 'build-admin'])
                self.assertIn(('stop', 'api-old', 30), calls)
                self.assertIn(('stop', 'online-recharge-old', 45), calls)
                self.assertLess(calls.index(('stop', 'api-old', 30)), calls.index(('stop', 'online-recharge-old', 45)))
                self.assertEqual(calls.count('close'), 1)


if __name__ == '__main__':
    unittest.main()
