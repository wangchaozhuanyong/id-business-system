"""Pure dispatcher admission tests; no GitHub, AWS, downloads, or databases."""
import ast
import base64
import copy
import gzip
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import warnings
import zipfile


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
spec = importlib.util.spec_from_file_location(
    'feature_retirement_dispatch', HERE / 'feature-retirement-dispatch.py'
)
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


class RetirementDispatchTests(unittest.TestCase):
    def setUp(self):
        directory = ROOT / '.runtime/feature-retirement-dispatch-tests'
        directory.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=directory)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.output = self.root / 'output'
        self.output.mkdir()
        self.commit, self.tree = 'a' * 40, 'b' * 40
        self.run_id, self.attempt = '123456', '2'
        self.quality_id = '654321'
        self.command_id = '11111111-2222-4333-8444-555555555555'
        self.environment = {
            'GITHUB_SHA': self.commit, 'GITHUB_RUN_ID': self.run_id,
            'GITHUB_RUN_ATTEMPT': self.attempt, 'GITHUB_REPOSITORY': d.REPOSITORY,
            'GITHUB_REF': 'refs/heads/main', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
            'RELEASE_COMMIT': self.commit, 'EXPECTED_CURRENT': 'c' * 40,
        }
        controls = {}
        for name in d.BOOTSTRAP:
            relative = 'scripts/production-release/' + name
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            raw = ('# fixture only: ' + name + '\n').encode()
            target.write_bytes(raw)
            controls[relative] = d.sha(raw)
        self.contract = {
            'scope': 'AUTO_REGISTRATION_RETIREMENT_TEST',
            'expectedCurrent': self.environment['EXPECTED_CURRENT'], 'controlSources': controls,
        }
        self.contract_raw = json.dumps(self.contract, sort_keys=True).encode()
        (self.root / d.CONTRACT).write_bytes(self.contract_raw)
        self.quality = {
            'runId': self.quality_id, 'commit': self.commit, 'sourceTree': self.tree,
            'path': '.github/workflows/quality.yml', 'conclusion': 'success',
        }
        self.proof = {
            'scope': self.contract['scope'], 'commit': self.commit, 'tree': self.tree,
            'workflowRunId': self.run_id, 'workflowRunAttempt': self.attempt,
            'contractSha256': d.sha(self.contract_raw), 'controlSources': controls,
            'qualityVerification': copy.deepcopy(self.quality),
        }
        self.native = {
            'id': int(self.run_id), 'head_sha': self.commit, 'head_branch': 'main',
            'event': 'workflow_dispatch', 'path': d.WORKFLOW,
            'run_attempt': int(self.attempt), 'status': 'in_progress',
        }
        self.jobs = [
            {'name': name, 'status': 'completed', 'conclusion': 'success',
             'run_id': int(self.run_id), 'head_sha': self.commit}
            for name in ('validate', 'quality-gate')
        ]
        self.checked_quality = {
            'id': int(self.quality_id), 'head_sha': self.commit, 'head_branch': 'main',
            'event': 'push', 'path': self.quality['path'], 'conclusion': 'success',
            'status': 'completed',
        }
        self.releases = []
        for context in (
            patch.object(d, 'ROOT', self.root), patch.object(d, 'OUTPUT', self.output),
            patch.dict(d.os.environ, self.environment, clear=True),
            patch.object(d.subprocess, 'run', side_effect=AssertionError('unmocked process')),
        ):
            context.start()
            self.addCleanup(context.stop)

    def archive(self, extras=(), *, duplicate_proof=False):
        proof_raw = json.dumps(self.proof, sort_keys=True).encode()
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz') as archive:
            entries = [('payload/build-proof.json', 'file', proof_raw), *extras]
            if duplicate_proof:
                entries.append(('payload/build-proof.json', 'file', proof_raw))
            for name, kind, raw in entries:
                member = tarfile.TarInfo(name)
                if kind == 'symlink':
                    member.type, member.linkname = tarfile.SYMTYPE, '../outside'
                    archive.addfile(member)
                elif kind == 'hardlink':
                    member.type, member.linkname = tarfile.LNKTYPE, 'payload/build-proof.json'
                    archive.addfile(member)
                else:
                    member.size = len(raw)
                    archive.addfile(member, io.BytesIO(raw))
        return output.getvalue(), proof_raw

    def zipped(self, bundle=None, *, extras=(), duplicate_proof=False, declared=None):
        if bundle is None:
            bundle, _ = self.archive(extras, duplicate_proof=duplicate_proof)
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('feature-retirement-artifact.tar.gz', bundle)
            archive.writestr('artifact-sha256.txt', declared or d.sha(bundle))
        raw = output.getvalue()
        metadata = {
            'id': 17, 'name': 'feature-retirement-' + self.commit + '-' + self.attempt,
            'expired': False, 'digest': 'sha256:' + d.sha(raw),
            'workflow_run': {'id': int(self.run_id), 'head_sha': self.commit},
        }
        return raw, metadata

    def prepare(self, metadata_patch=None):
        zipped, metadata = self.zipped()
        metadata.update(metadata_patch or {})

        def github(path):
            if path.endswith('/actions/runs/' + self.run_id):
                return copy.deepcopy(self.native)
            if path.endswith('/attempts/' + self.attempt + '/jobs'):
                return {'jobs': copy.deepcopy(self.jobs)}
            if path.endswith('/actions/runs/' + self.run_id + '/artifacts'):
                return {'artifacts': [metadata]}
            if path.endswith('/actions/runs/' + self.quality_id):
                return copy.deepcopy(self.checked_quality)
            raise AssertionError('unmocked GitHub read')

        def execute(*args, **kwargs):
            if args == ('git', 'rev-parse', 'HEAD^{tree}'):
                return self.tree.encode()
            if args[:2] == ('gh', 'api') and args[-1].endswith('/actions/artifacts/17/zip'):
                return zipped
            if args[:3] == ('gh', 'release', 'create'):
                self.releases.append(args)
                return b''
            raise AssertionError('unmocked platform execution')

        with patch.object(d, 'github', side_effect=github), patch.object(d, 'execute', side_effect=execute):
            return d.prepare_plan()

    def plan(self):
        return {
            'version': 1, 'scope': self.contract['scope'], 'commit': self.commit, 'tree': self.tree,
            'branch': 'main', 'workflowRunId': self.run_id, 'workflowRunAttempt': self.attempt,
            'contractSha256': d.sha(self.contract_raw), 'artifactSha256': 'd' * 64,
            'buildProofSha256': 'e' * 64, 'controlSources': self.contract['controlSources'],
            'qualityVerification': self.quality,
            'artifactUrl': 'https://github.com/' + d.REPOSITORY + '/releases/download/test/bundle.tar.gz',
        }

    def invocation(self, mode='preflight', **changes):
        statuses = {
            'preflight': 'FEATURE_RETIREMENT_PREFLIGHT_VERIFIED',
            'release': 'FEATURE_RETIREMENT_DEPLOYED',
            'readback': 'FEATURE_RETIREMENT_READBACK_VERIFIED',
        }
        receipt = {'commit': self.commit, 'mode': mode, 'status': statuses[mode]}
        if mode == 'preflight':
            receipt['runtimeBaseline'] = {'fingerprint': 'f' * 64}
        text = 'FEATURE_RETIREMENT_GZIP_BASE64=' + base64.b64encode(
            gzip.compress(json.dumps(receipt).encode())
        ).decode()
        return {'Status': 'Success', 'ResponseCode': 0, 'StandardErrorContent': '',
                'StandardOutputContent': text, **changes}

    def transport(self, plan=None, *, mode='preflight', invocation=None, send_error=None):
        sent = []

        def execute(*args, **kwargs):
            self.assertEqual(args[:3], ('aws', 'ssm', 'send-command'))
            self.assertEqual(kwargs['env']['AWS_MAX_ATTEMPTS'], '1')
            sent.append(args)
            if send_error:
                raise send_error
            return json.dumps({'Command': {'CommandId': self.command_id}}).encode()

        response = invocation or self.invocation(mode)
        process = SimpleNamespace(returncode=0, stdout=json.dumps(response).encode())
        with patch.object(d, 'execute', side_effect=execute), \
                patch.object(d.subprocess, 'run', return_value=process), \
                patch.object(d.time, 'sleep'), patch('builtins.print'):
            result = d.transport(plan or self.plan(), self.contract, mode)
        return result, sent

    def test_valid_artifact_preserves_proof_and_plan_quality_binding(self):
        zipped, metadata = self.zipped()
        bundle, declared, proof_raw, proof = d.artifact_bytes(zipped, metadata, self.commit, self.attempt)
        self.assertEqual(d.sha(bundle), declared)
        self.assertEqual(json.loads(proof_raw), proof)
        plan, contract = self.prepare()
        self.assertEqual(contract, self.contract)
        for field in ('scope', 'commit', 'tree', 'workflowRunId', 'workflowRunAttempt',
                      'contractSha256', 'controlSources', 'qualityVerification'):
            self.assertEqual(plan[field], self.proof[field])
        self.assertEqual(len(self.releases), 1)

    def test_changed_zip_digest_bundle_declaration_commit_and_attempt_are_rejected(self):
        zipped, metadata = self.zipped()
        for raw, meta, commit, attempt in [
            (zipped + b'changed', metadata, self.commit, self.attempt),
            (zipped, {**metadata, 'digest': 'sha256:' + '0' * 64}, self.commit, self.attempt),
            (zipped, metadata, 'f' * 40, self.attempt), (zipped, metadata, self.commit, '3'),
        ]:
            with self.subTest(commit=commit, attempt=attempt), self.assertRaises(RuntimeError):
                d.artifact_bytes(raw, meta, commit, attempt)
        raw, meta = self.zipped(declared='0' * 64)
        with self.assertRaisesRegex(RuntimeError, 'COMPILED_ARTIFACT_CHANGED'):
            d.artifact_bytes(raw, meta, self.commit, self.attempt)

    def test_archive_rejects_traversal_absolute_links_duplicates_and_oversized_expansion(self):
        for extras in [
            [('../outside', 'file', b'no')], [('/absolute', 'file', b'no')],
            [('payload/../outside', 'file', b'no')], [('payload\\outside', 'file', b'no')],
            [('payload/link', 'symlink', b'')], [('payload/link', 'hardlink', b'')],
            [('payload/same', 'file', b'1'), ('payload/same', 'file', b'2')],
        ]:
            with self.subTest(extras=extras), self.assertRaises(RuntimeError):
                raw, meta = self.zipped(extras=extras)
                d.artifact_bytes(raw, meta, self.commit, self.attempt)
        with self.assertRaises(RuntimeError):
            raw, meta = self.zipped(extras=[('payload/large', 'file', b'x' * (8 * 1024**2 + 1))])
            d.artifact_bytes(raw, meta, self.commit, self.attempt)
        raw, meta = self.zipped()
        for members in [
            [tarfile.TarInfo('payload/' + str(index)) for index in range(8193)],
            [tarfile.TarInfo('payload/chunk-' + str(index)) for index in range(17)],
        ]:
            if len(members) == 17:
                for member in members:
                    member.size = 8 * 1024**2
            archive = Mock()
            archive.__iter__ = Mock(side_effect=lambda: iter(members))
            context = Mock()
            context.__enter__ = Mock(return_value=archive)
            context.__exit__ = Mock(return_value=False)
            with self.subTest(memberCount=len(members)), patch.object(d.tarfile, 'open', return_value=context), \
                    self.assertRaisesRegex(RuntimeError, 'BUDGET'):
                d.artifact_bytes(raw, meta, self.commit, self.attempt)

    def test_duplicate_proof_and_zip_extra_or_duplicate_members_are_rejected(self):
        raw, meta = self.zipped(duplicate_proof=True)
        with self.assertRaisesRegex(RuntimeError, 'FEATURE_RETIREMENT_NATIVE'):
            d.artifact_bytes(raw, meta, self.commit, self.attempt)
        for extra in ('../outside', 'artifact-sha256.txt'):
            bundle, _ = self.archive()
            output = io.BytesIO()
            with warnings.catch_warnings(), zipfile.ZipFile(output, 'w') as archive:
                warnings.simplefilter('ignore', UserWarning)
                archive.writestr('feature-retirement-artifact.tar.gz', bundle)
                archive.writestr('artifact-sha256.txt', d.sha(bundle))
                archive.writestr(extra, b'changed')
            zipped = output.getvalue()
            with self.subTest(extra=extra), self.assertRaisesRegex(RuntimeError, 'LAYOUT'):
                d.artifact_bytes(zipped, {'digest': 'sha256:' + d.sha(zipped)}, self.commit, self.attempt)

    def test_only_exact_main_manual_selection_is_admitted(self):
        for key, value in [
            ('GITHUB_REPOSITORY', 'other/repository'), ('GITHUB_REF', 'refs/heads/other'),
            ('GITHUB_EVENT_NAME', 'push'), ('RELEASE_COMMIT', 'f' * 40),
            ('GITHUB_SHA', '../invalid'), ('GITHUB_RUN_ID', '0'), ('GITHUB_RUN_ATTEMPT', '0'),
        ]:
            with self.subTest(key=key), patch.dict(d.os.environ, {key: value}), \
                    self.assertRaisesRegex(RuntimeError, 'MAIN_SELECTION_INVALID'):
                self.prepare()
        self.assertEqual(self.releases, [])

    def test_native_workflow_identity_and_both_unique_successful_validation_jobs_are_required(self):
        original_native, original_jobs = copy.deepcopy(self.native), copy.deepcopy(self.jobs)
        for key, value in [('head_sha', 'f' * 40), ('head_branch', 'other'),
                           ('event', 'push'), ('path', '.github/workflows/other.yml'), ('run_attempt', 1)]:
            self.native = {**original_native, key: value}
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'WORKFLOW_IDENTITY_INVALID'):
                self.prepare()
        self.native = original_native
        for jobs in [original_jobs[:1], original_jobs + [original_jobs[0]],
                     [{**original_jobs[0], 'status': 'in_progress'}, original_jobs[1]],
                     [{**original_jobs[0], 'conclusion': 'failure'}, original_jobs[1]],
                     [original_jobs[0], {**original_jobs[1], 'conclusion': 'cancelled'}]]:
            self.jobs = jobs
            with self.subTest(jobs=jobs), self.assertRaisesRegex(RuntimeError, 'NATIVE_VALIDATION_NOT_SUCCESSFUL'):
                self.prepare()
        self.assertEqual(self.releases, [])

    def test_artifact_expiry_wrong_source_scope_tree_controls_and_quality_proof_are_rejected(self):
        for changes in [{'expired': True}, {'workflow_run': {'head_sha': 'f' * 40}}]:
            with self.subTest(changes=changes), self.assertRaisesRegex(RuntimeError, 'ARTIFACT_UNAVAILABLE'):
                self.prepare(changes)
        original = copy.deepcopy(self.proof)
        for key, value in [('scope', 'other'), ('tree', 'f' * 40), ('workflowRunId', '999'),
                           ('contractSha256', '0' * 64), ('controlSources', {}),
                           ('qualityVerification', {**self.quality, 'sourceTree': 'f' * 40})]:
            self.proof = {**copy.deepcopy(original), key: value}
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.prepare()
        self.assertEqual(self.releases, [])

    def test_quality_live_readback_must_be_completed_successful_exact_main_push(self):
        original = copy.deepcopy(self.checked_quality)
        for key, value in [('head_sha', 'f' * 40), ('head_branch', 'other'),
                           ('event', 'workflow_dispatch'), ('path', '.github/workflows/other.yml'),
                           ('conclusion', 'failure'), ('status', 'in_progress')]:
            self.checked_quality = {**original, key: value}
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'QUALITY_GATE_CHANGED'):
                self.prepare()

    def test_source_changes_and_predecessor_mismatch_stop_before_publication(self):
        source = self.root / next(iter(self.contract['controlSources']))
        source.write_text('changed')
        with self.assertRaisesRegex(RuntimeError, 'EXECUTOR_SOURCE_CHANGED'):
            self.prepare()
        self.assertEqual(self.releases, [])
        with patch.dict(d.os.environ, {'EXPECTED_CURRENT': 'f' * 40}), \
                self.assertRaisesRegex(RuntimeError, 'BUILD_IDENTITY_CHANGED'):
            self.prepare()

    def test_transport_bootstrap_compiles_and_embeds_exact_plan_runtime_baseline(self):
        plan = {**self.plan(), 'runtimeBaseline': {'fingerprint': 'f' * 64}}
        receipt, sent = self.transport(plan, mode='release')
        self.assertEqual(receipt['mode'], 'release')
        self.assertEqual(len(sent), 1)
        args = sent[0]
        self.assertIn(d.INSTANCE, args)
        self.assertIn(d.REGION, args)
        parameters = json.loads(args[args.index('--parameters') + 1])
        command = parameters['commands'][0]
        source = command.split("python3 - <<'RETIREMENT_RELEASE'\n", 1)[1].rsplit('\nRETIREMENT_RELEASE', 1)[0]
        compile(source, '<retirement-server-bootstrap>', 'exec')
        tree = ast.parse(source)
        assignments = {node.targets[0].id: ast.literal_eval(node.value)
                       for node in tree.body if isinstance(node, ast.Assign)
                       and isinstance(node.targets[0], ast.Name)
                       and node.targets[0].id in {'PLAN_JSON', 'RAW_BASE'}}
        self.assertEqual(json.loads(assignments['PLAN_JSON']), {**plan, 'mode': 'release'})
        self.assertEqual(assignments['RAW_BASE'], 'https://raw.githubusercontent.com/' + d.REPOSITORY + '/' + self.commit + '/')
        self.assertNotIn('for name in BOOTSTRAP:', source)
        self.assertTrue(all('scripts/production-release/' + name in plan['controlSources'] for name in d.BOOTSTRAP))

    def test_dispatch_plan_fields_and_bootstrap_helpers_match_runtime_contract(self):
        runtime = ast.parse((HERE / 'feature-retirement-release.py').read_text())
        validate = next(node for node in runtime.body
                        if isinstance(node, ast.FunctionDef) and node.name == 'validate_plan')
        fields = next(ast.literal_eval(node.value) for node in validate.body
                      if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
                      and node.targets[0].id == 'fields')
        self.assertEqual(set(self.plan()) | {'mode'}, fields)
        self.assertEqual((set(self.plan()) | {'mode', 'runtimeBaseline'}) - fields,
                         {'runtimeBaseline'})
        helper_sets = [set(ast.literal_eval(node)) for node in ast.walk(validate)
                       if isinstance(node, ast.Tuple) and node.elts
                       and all(isinstance(item, ast.Constant) and isinstance(item.value, str)
                               for item in node.elts)
                       and any(item.value == 'feature-retirement-release.py' for item in node.elts)]
        self.assertIn(set(d.BOOTSTRAP), helper_sets)
        actual_scope = next(ast.literal_eval(node.value) for node in runtime.body
                            if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
                            and node.targets[0].id == 'SCOPE')
        contract = json.loads((ROOT / d.CONTRACT).read_text())
        self.assertEqual(contract['scope'], actual_scope)

    def test_existing_intent_accepted_or_symlink_refuses_any_second_ssm_submission(self):
        for filename, symlink in [
            ('preflight-command-intent.json', False), ('preflight-accepted-command.json', False),
            ('preflight-command-intent.json', True), ('preflight-accepted-command.json', True),
        ]:
            path = self.output / filename
            if symlink:
                path.symlink_to(self.output / 'missing-target')
            else:
                path.write_text('{}')
            execute = Mock(side_effect=AssertionError('must not send'))
            with self.subTest(filename=filename, symlink=symlink), patch.object(d, 'execute', execute), \
                    self.assertRaisesRegex(RuntimeError, 'COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN'):
                d.transport(self.plan(), self.contract, 'preflight')
            execute.assert_not_called()
            path.unlink()

    def test_send_failure_keeps_intent_and_refuses_retry_even_without_accepted_receipt(self):
        with self.assertRaisesRegex(RuntimeError, 'synthetic send unavailable'):
            self.transport(send_error=RuntimeError('synthetic send unavailable'))
        self.assertTrue((self.output / 'preflight-command-intent.json').is_file())
        self.assertFalse((self.output / 'preflight-accepted-command.json').exists())
        with self.assertRaisesRegex(RuntimeError, 'COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN'):
            self.transport()

    def test_failed_or_uncertain_ssm_result_keeps_original_identity_and_cannot_repeat(self):
        for response in [self.invocation(Status='Failed', ResponseCode=1),
                         self.invocation(Status='TimedOut', ResponseCode=1),
                         self.invocation(Status='Cancelled', ResponseCode=1),
                         self.invocation(Status='InProgress')]:
            with self.subTest(status=response['Status']), self.assertRaisesRegex(RuntimeError, 'NATIVE_PREFLIGHT_FAILED|STILL_PENDING'):
                self.transport(invocation=response)
            accepted = json.loads((self.output / 'preflight-accepted-command.json').read_text())
            self.assertEqual(accepted['CommandId'], self.command_id)
            with self.assertRaisesRegex(RuntimeError, 'COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN'):
                self.transport()
            for path in self.output.glob('preflight-*'):
                path.unlink()

    def test_wrong_commit_or_stderr_is_not_accepted_as_native_business_success(self):
        encoded = base64.b64encode(gzip.compress(json.dumps({'commit': 'f' * 40}).encode())).decode()
        for response in [self.invocation(StandardErrorContent='synthetic failure'),
                         self.invocation(StandardOutputContent='FEATURE_RETIREMENT_GZIP_BASE64=' + encoded)]:
            with self.subTest(response=response), self.assertRaises(RuntimeError):
                self.transport(invocation=response)
            for path in self.output.glob('preflight-*'):
                path.unlink()

    def test_transport_rejects_wrong_business_status_or_mode_even_if_ssm_succeeds(self):
        for changes in [
            {'status': 'FEATURE_RETIREMENT_FAILED'},
            {'mode': 'release'},
            {'status': 'FEATURE_RETIREMENT_DEPLOYED'},
        ]:
            receipt = {'commit': self.commit, 'mode': 'preflight',
                       'status': 'FEATURE_RETIREMENT_PREFLIGHT_VERIFIED', **changes}
            encoded = base64.b64encode(gzip.compress(json.dumps(receipt).encode())).decode()
            response = self.invocation(StandardOutputContent='FEATURE_RETIREMENT_GZIP_BASE64=' + encoded)
            with self.subTest(changes=changes), self.assertRaises(RuntimeError):
                self.transport(invocation=response)
            with self.assertRaisesRegex(RuntimeError, 'COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN'):
                self.transport()
            for path in self.output.glob('preflight-*'):
                path.unlink()

    def test_publish_carries_baseline_once_and_rejects_failed_preflight_before_release(self):
        plan, baseline = self.plan(), {'fingerprint': 'f' * 64}
        calls = []

        def transport(candidate, contract, mode):
            calls.append((mode, copy.deepcopy(candidate)))
            if mode == 'preflight':
                self.assertNotIn('runtimeBaseline', candidate)
                return {'status': 'FEATURE_RETIREMENT_PREFLIGHT_VERIFIED', 'runtimeBaseline': baseline}
            self.assertEqual(candidate['runtimeBaseline'], baseline)
            return {'commit': self.commit, 'mode': mode,
                    'status': 'FEATURE_RETIREMENT_DEPLOYED' if mode == 'release'
                    else 'FEATURE_RETIREMENT_READBACK_VERIFIED'}

        with patch.object(d, 'prepare_plan', return_value=(plan, self.contract)), \
                patch.object(d, 'transport', side_effect=transport):
            d.publish()
        self.assertEqual([mode for mode, _ in calls], ['preflight', 'release', 'readback'])
        for preflight in [{'status': 'FEATURE_RETIREMENT_FAILED'},
                          {'status': 'FEATURE_RETIREMENT_PREFLIGHT_VERIFIED'}]:
            transport = Mock(return_value=preflight)
            with patch.object(d, 'prepare_plan', return_value=(plan, self.contract)), \
                    patch.object(d, 'transport', transport), self.assertRaisesRegex(RuntimeError, 'PREFLIGHT_RECEIPT_INVALID'):
                d.publish()
            self.assertEqual(transport.call_count, 1)

    def test_failed_release_and_readback_stop_without_repeating_the_operation(self):
        plan = self.plan()
        for failed_mode in ('release', 'readback'):
            calls = []

            def transport(candidate, contract, mode):
                calls.append(mode)
                if mode == 'preflight':
                    return {'status': 'FEATURE_RETIREMENT_PREFLIGHT_VERIFIED',
                            'runtimeBaseline': {'fingerprint': 'f' * 64}}
                if mode == failed_mode:
                    raise RuntimeError('FEATURE_RETIREMENT_NATIVE_RECEIPT_INVALID')
                return {'status': 'FEATURE_RETIREMENT_DEPLOYED', 'mode': mode, 'commit': self.commit}

            with self.subTest(mode=failed_mode), \
                    patch.object(d, 'prepare_plan', return_value=(plan, self.contract)), \
                    patch.object(d, 'transport', side_effect=transport), self.assertRaises(RuntimeError):
                d.publish()
            self.assertEqual(calls, ['preflight', 'release'] if failed_mode == 'release'
                             else ['preflight', 'release', 'readback'])


if __name__ == '__main__':
    unittest.main()
