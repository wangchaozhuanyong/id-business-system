"""Pure controls: no database, Docker daemon, network, secret, or production write."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location('test_registration_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


r = load('registration-closure-release.py')
b = load('registration-closure-build.py')
h = load('recharge-record-release.py')
d = load('registration-closure-dispatch.py')


class RegistrationClosureControls(unittest.TestCase):
    def test_api_delta_refuses_unapproved_outputs_or_removal(self):
        before = {'id-business-v2/proxy-pool/proxy-pool.service.js': 'original', 'other.js': 'protected'}
        after = {**before, 'id-business-v2/proxy-pool/proxy-pool.service.js': 'candidate'}
        self.assertEqual(b.api_delta(before, after, {'id-business-v2/proxy-pool/proxy-pool.service.js': 'original'}),
                         {'id-business-v2/proxy-pool/proxy-pool.service.js': 'candidate'})
        for changed in ({**after, 'other.js': 'foreign'}, {k: v for k, v in after.items() if k != 'other.js'}):
            with self.assertRaisesRegex(RuntimeError, 'API_OUTPUT_SCOPE_CHANGED'):
                b.api_delta(before, changed, {'id-business-v2/proxy-pool/proxy-pool.service.js': 'original'})
        with self.assertRaisesRegex(RuntimeError, 'BASE_API_NOT_REPRODUCED'):
            b.api_delta(before, after, {'id-business-v2/proxy-pool/proxy-pool.service.js': 'wrong baseline'})

    def test_database_readback_accepts_only_nullable_reviewed_fields_and_one_checksum(self):
        contract = {'migration': {'sha256': 'reviewed-checksum'}}
        before = {'pending': 0, 'columns': [], 'rows': []}
        r.check_migration(before, contract)
        after = {'pending': 0, 'columns': [
            {'COLUMN_NAME': 'registered_at', 'IS_NULLABLE': 'YES', 'DATA_TYPE': 'datetime'},
            {'COLUMN_NAME': 'registration_ip_encrypted', 'IS_NULLABLE': 'YES', 'DATA_TYPE': 'text'}],
            'rows': [{'checksum': 'reviewed-checksum', 'finished': True, 'rolledBack': False}]}
        r.check_migration(after, contract, True)
        for change in ('pending', 'columns', 'rows'):
            invalid = copy.deepcopy(after)
            invalid[change] = 1 if change == 'pending' else []
            with self.assertRaises(RuntimeError):
                r.check_migration(invalid, contract, True)
        with self.assertRaisesRegex(RuntimeError, 'MIGRATION_BASELINE_CHANGED'):
            r.check_migration(after, contract)

    def test_safe_archive_rejects_links_traversal_duplicates_and_foreign_root(self):
        output = ROOT / '.runtime/auto-registration-review-20261016/release-control-tests'
        output.mkdir(parents=True, exist_ok=True)
        for name, symlink in [('../escape', False), ('foreign/file', False), ('payload/link', True)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory(dir=output) as temp:
                raw = io.BytesIO()
                with tarfile.open(fileobj=raw, mode='w:gz') as archive:
                    item = tarfile.TarInfo(name)
                    item.type = tarfile.SYMTYPE if symlink else tarfile.REGTYPE
                    item.linkname = '/etc/passwd' if symlink else ''
                    item.size = 0
                    archive.addfile(item, io.BytesIO())
                with self.assertRaisesRegex(RuntimeError, 'ARTIFACT_PATH_INVALID'):
                    r.safe_archive(raw.getvalue(), Path(temp) / 'content')

    def test_proof_requires_exact_native_identity_database_and_all_payload_hashes(self):
        output = ROOT / '.runtime/auto-registration-review-20261016/release-control-tests'
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as temp:
            path = Path(temp)
            source = 'apps/api/src/id-business-v2/proxy-pool/service.ts'
            module = 'id-business-v2/proxy-pool/service.js'
            schema = 'apps/api/prisma-mysql/schema.prisma'
            contents = {'source/' + source: b'approved', 'source/' + schema: b'schema', 'api/schema.prisma': b'schema', 'api/modules/' + module: b'compiled',
                        'api/prisma-client/index.js': b'client', 'api/prisma-client/schema.prisma': b'schema',
                        'api/worker/workspace.py': b'worker', 'online-recharge/engine/proxy-test.cjs': b'engine'}
            contents.update({'admin/html/' + ('index.html' if i == 0 else 'assets/' + str(i) + '.js'): str(i).encode() for i in range(201)})
            for name, raw in contents.items():
                file = path / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(raw)
            files = h.file_inventory(path)
            contract = {'changedSources': {source: files['source/' + source], schema: files['source/' + schema]}, 'apiModules': {module: 'baseline'},
                        'engineFiles': {'proxy-test.cjs': 'baseline'}, 'baselineEngineInventory': {}, 'adminBuildNodeEnv': 'production', 'baselineBuildId': 'v2-baseline', 'observedAdminNativeBuild': {'runtimeExactMatch': False}, 'migration': {'name': 'reviewed'}, 'protectedPublishedRecovery': {'nativeRunId': 'native', 'nativeArtifactDigest': 'digest'}}
            plan = {n: 'exact-' + n for n in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256')}
            plan['controlSources'] = {'registration-closure-release.py': 'reviewed'}
            proof = {**plan, 'version': 1, 'scope': r.SCOPE, 'baselineApiReproduced': True,
                     'baselineAdminReproduced': True, 'baselinePublishedRecoveryNativeVerified': {'runId': 'native', 'artifactDigest': 'digest', 'verified': True}, 'databaseVerification': {'isolated': True,
                       'registrationMysqlSqlite': 'PASS', 'proxyMysql': 'PASS', 'externalRequests': 0, 'businessActions': 0},
                     'plannedMigration': contract['migration'], 'migrationPerformed': False, 'businessActions': 0,
                     'updatedServices': ['api', 'admin', 'online-recharge'], 'files': files}
            for prefix, field in [('api/modules/', 'apiModules'), ('api/worker/', 'workerFiles'),
                                 ('api/prisma-client/', 'prismaClientFiles'), ('admin/html/', 'adminFiles'),
                                 ('online-recharge/engine/', 'engineFiles')]:
                proof[field] = {n.removeprefix(prefix): v for n, v in files.items() if n.startswith(prefix)}
            proof['engineManifestFiles'] = proof['engineFiles']
            proof['adminBuildEnvironment'] = {role: {'nodeEnv': 'production',
                'buildId': 'v2-baseline' if role == 'baseline' else 'v2-' + plan['commit'],
                'configuration': 'TRACKED_UNCHANGED', 'artifactPostProcessing': False} for role in ('baseline', 'candidate')}
            proof['observedAdminNativeBuild'] = contract['observedAdminNativeBuild']
            r.verify_proof(proof, plan, contract, path, h)
            for field in ('commit', 'tree', 'databaseVerification', 'controlSources', 'migrationPerformed'):
                bad = copy.deepcopy(proof)
                bad[field] = 'unverified'
                with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'PROOF_INVALID'):
                    r.verify_proof(bad, plan, contract, path, h)
            (path / 'api/modules/foreign.js').write_text('foreign')
            with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_CHANGED'):
                r.verify_proof(proof, plan, contract, path, h)

    def test_migration_uses_only_atomic_reviewed_sql_without_deploy_or_pull(self):
        source = (HERE / 'registration-closure-release.py').read_text()
        self.assertIn("*command, 'db', 'execute'", source)
        self.assertIn("*command, 'migrate', 'resolve', '--applied'", source)
        self.assertNotIn("*command, 'migrate', 'deploy'", source)
        self.assertIn("'--no-deps', '--pull', 'never'", source)
        self.assertNotIn('prune', source)
        self.assertNotIn('rollback(', source)

    def test_workflow_explicitly_verifies_both_database_tracks_and_current_roles(self):
        workflow = (ROOT / '.github/workflows/registration-closure-validation.yml').read_text()
        runner = (HERE / 'registration-closure-database.mjs').read_text()
        self.assertIn('registration-closure-database.mjs', workflow)
        self.assertIn('acceptance-v2-registration-mirror-mysql.mjs', runner)
        self.assertIn('acceptance-v2-shared-proxy-mysql.mjs', runner)
        self.assertIn('test_release_safety', workflow)
        self.assertIn('test_registration_closed_loop_unit', workflow)
        prefix = '$GITHUB_WORKSPACE/.deploy/registration-closure-release/python/bin/python -B -m unittest '
        self.assertEqual([line.strip() for line in workflow.splitlines() if line.strip().startswith(prefix)],
                         [prefix + name for name in ('test_workspace', 'test_apple_mailboxes',
                                                     'test_release_safety', 'test_registration_closed_loop_unit')])
        self.assertIn('test/proxy-test.test.cjs', workflow)
        engine_dependencies = ('      - name: Install frozen engine dependency lock for proxy tests\n'
                               '        working-directory: .deploy/registration-closure-release/candidate/apps/api/src/id-business-v2/online-recharge/engine/upstream\n'
                               '        run: npm ci --ignore-scripts --no-audit --no-fund\n')
        self.assertIn(engine_dependencies, workflow)
        self.assertLess(workflow.index(engine_dependencies), workflow.index('Verify proxy engine behavior without payment'))
        self.assertLess(workflow.index('Compile API for isolated database acceptance'), workflow.index('Verify isolated registration MySQL SQLite'))
        for name in ('proxy-test.test.cjs', 'dispatch.test.cjs', 'proxy-worker.test.cjs', 'proxy-pool.test.cjs'):
            self.assertTrue((ROOT / 'apps/api/src/id-business-v2/online-recharge/engine/test' / name).is_file())
        self.assertIn('path.parent.chmod(0o755)', (HERE / 'registration-closure-release.py').read_text())
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertIn('id-business-v2-production-release', workflow)
        self.assertIn('GH_TOKEN: ${{ github.token }}', workflow)
        self.assertIn('node scripts/acceptance-v2-registration-inventory-ui.mjs', workflow)
        self.assertIn('node scripts/acceptance-v2-registration-native-ui.mjs', workflow)
        self.assertIn('node scripts/acceptance-v2-recharge-proxies-ui.mjs', workflow)
        self.assertEqual(len(r.PRESERVED), 5)
        self.assertIn('auto-registration', r.PRESERVED)
        self.assertIn('FIELD_ENCRYPTION_KEY travels only', (HERE / 'registration-closure-release.py').read_text())

    def test_projection_is_exact_and_context_bound(self):
        output = ROOT / '.runtime/auto-registration-review-20261016/release-control-tests'
        output.mkdir(parents=True, exist_ok=True)
        path = 'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs'
        before, after = 'preserved lease\\nproxy old\\n', 'preserved lease\\nproxy fixed\\n'
        contract = {'changedSources': {path: 'main-successor'}, 'engineFiles': {'worker.cjs': b.digest(before.encode())},
            'engineSourceProjection': {'worker.cjs': {'baselineCommit': 'published',
                'baselineSha256': b.digest(before.encode()), 'candidateSha256': b.digest(after.encode()),
                'replacements': [{'before': 'proxy old', 'after': 'proxy fixed'}]}}}
        with tempfile.TemporaryDirectory(dir=output) as name:
            context = Path(name)
            file = context / path
            file.parent.mkdir(parents=True)
            file.write_text('unpublished main successor')
            with patch.object(b, 'git', return_value=before.encode()):
                b.apply_engine_projection(contract, context)
                self.assertEqual(file.read_text(), after)
                invalid = copy.deepcopy(contract)
                invalid['engineSourceProjection']['worker.cjs']['replacements'][0]['before'] = 'missing context'
                with self.assertRaisesRegex(RuntimeError, 'ENGINE_PROJECTION_CONTEXT_CHANGED'):
                    b.apply_engine_projection(invalid, context)

    def test_failure_cleanup_releases_only_before_uncertain_write(self):
        output = ROOT / '.runtime/auto-registration-review-20261016/release-control-tests'
        output.mkdir(parents=True, exist_ok=True)
        for uncertain in (False, True):
            with tempfile.TemporaryDirectory(dir=output) as name:
                stage = Path(name)
                marker = stage / '.id-release-maintenance.json'
                marker.write_text('owned')
                if uncertain:
                    (stage / 'migration-operation.json').write_text('{"phase":"STARTED"}')
                receipt = r.finalize_failed_attempt(stage, {'markerPath': str(marker), 'markerSha256': r.digest(b'owned')})
                self.assertEqual(marker.exists(), uncertain)
                self.assertEqual(receipt['maintenanceHeld'], uncertain)
        source = (HERE / 'registration-closure-dispatch.py').read_text()
        self.assertIn('response.read(1024*1024+1)', source)
        self.assertIn('len(contract_raw)>1024*1024', source)
        self.assertLess((HERE / 'registration-closure-contract.json').stat().st_size, 1024 * 1024)

    def test_published_governance_fixture_admission_is_exact(self):
        name = 'apps/api/src/id-business-v2/data-governance/bank-recharge-governance-mysql.integration.spec.ts'
        protection = {'sources': {}, 'validationSources': {name: 'reviewed'}}
        self.assertTrue(b.admitted_source(name, protection))
        self.assertFalse(b.admitted_source(name.replace('bank-recharge-governance', 'foreign'), protection))
        self.assertFalse(b.admitted_source(name.replace('.integration.spec.ts', '.service.ts'), protection))


    def test_quality_gate_requires_exact_main_or_authenticated_identical_pr_tree(self):
        import zipfile
        commit, tree, head = 'a' * 40, 'b' * 40, 'c' * 40
        run = {'id': 99, 'run_attempt': 1, 'head_sha': commit, 'head_branch': 'main', 'event': 'push', 'status': 'completed',
               'conclusion': 'success', 'path': '.github/workflows/quality.yml'}
        with patch.object(d, 'github', return_value={'workflow_runs': [run]}):
            self.assertEqual(d.quality_source_evidence(commit, tree)['kind'], 'EXACT_MAIN_SUCCESS')
        pr = {'number': 10, 'merged_at': 'now', 'merge_commit_sha': commit,
              'base': {'ref': 'main'}, 'head': {'sha': head, 'repo': {'full_name': d.REPOSITORY}}}
        proof = {'repository': d.REPOSITORY, 'runId': 99, 'runAttempt': 1, 'pullRequest': 10,
                 'headSha': head, 'baseSha': 'd' * 40, 'testedTree': tree}
        raw = io.BytesIO()
        with zipfile.ZipFile(raw, 'w') as archive:
            archive.writestr('evidence.json', json.dumps(proof))
        artifact = {'id': 123, 'name': 'quality-source-evidence-1', 'expired': False,
                    'digest': 'sha256:' + d.sha(raw.getvalue())}
        responses = [{'workflow_runs': []}, [pr], {'workflow_runs': [{**run, 'head_sha': head, 'event': 'pull_request'}]},
                     {'artifacts': [artifact]}]
        with patch.object(d, 'github', side_effect=responses), patch.object(d, 'execute', return_value=raw.getvalue()):
            self.assertEqual(d.quality_source_evidence(commit, tree)['kind'], 'IDENTICAL_PR_TESTED_TREE')
        with patch.object(d, 'github', side_effect=responses), patch.object(d, 'execute', return_value=raw.getvalue()):
            with self.assertRaisesRegex(RuntimeError, 'QUALITY_SOURCE_EVIDENCE_UNAVAILABLE'):
                d.quality_source_evidence(commit, 'f' * 40)

    def test_admin_build_reproduces_actual_production_without_postprocessing_and_manifest_is_exact(self):
        source = (HERE / 'registration-closure-build.py').read_text()
        self.assertIn("contract['adminBuildNodeEnv'] == 'production'", source)
        self.assertIn("'NODE_ENV': contract['adminBuildNodeEnv']", source)
        self.assertIn("'artifactPostProcessing': False", source)
        self.assertIn("'BASE_ADMIN_NOT_REPRODUCED'", source)
        output = ROOT / '.runtime/auto-registration-review-20261016/release-control-tests'
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as temp:
            context = Path(temp)
            engine = context / 'apps/api/src/id-business-v2/online-recharge/engine'
            engine.mkdir(parents=True)
            (engine / 'entry.cjs').write_bytes(b'reviewed')
            (engine / 'SOURCE_MANIFEST.json').write_text(json.dumps({'files': [
                {'path': 'entry.cjs', 'adaptedSha256': b.digest(b'reviewed')}]}))
            self.assertEqual(b.verify_engine_manifest(context), {'entry.cjs': b.digest(b'reviewed')})
            (engine / 'entry.cjs').write_bytes(b'unreviewed')
            with self.assertRaisesRegex(RuntimeError, 'ENGINE_MANIFEST_CHANGED'):
                b.verify_engine_manifest(context)


    def test_latest_native_production_artifact_matches_current_without_relabeling_old_test_build(self):
        published, current = 'b' * 40, 'c' * 40
        observed = {'runId': '2', 'runAttempt': 1, 'commit': current, 'artifactDigest': 'latest-digest',
                    'workflowPath': '.github/workflows/recharge-checkout-validation.yml',
                    'runtimeExactMatch': True, 'nodeEnv': 'production',
                    'nativeAdminFileCount': 1, 'runtimeAdminFileCount': 1}
        contract = {'expectedCurrent': current, 'adminBuildNodeEnv': 'production', 'baselineAdminFiles': {'index.html': 'hash'},
                    'protectedPublishedRecovery': {'nativeRunId': '1', 'publicationCommit': published, 'nativeArtifactDigest': 'old-digest'},
                    'observedAdminNativeBuild': observed}
        responses = [
            {'head_sha': published, 'conclusion': 'success', 'path': '.github/workflows/online-recharge-audit-validation.yml'},
            {'artifacts': [{'digest': 'old-digest', 'expired': False, 'workflow_run': {'head_sha': published}}]},
            {'head_sha': current, 'conclusion': 'success', 'run_attempt': 1, 'path': observed['workflowPath']},
            {'artifacts': [{'digest': 'latest-digest', 'expired': False, 'name': 'recharge-checkout-' + current + '-1',
                            'workflow_run': {'head_sha': current}}]}]
        raw = [json.dumps(value).encode() for value in responses]
        with patch.object(b.subprocess, 'check_output', side_effect=raw):
            self.assertTrue(b.verify_published_native(contract)['verified'])
        for field, value in [('runtimeExactMatch', False), ('workflowPath', '.github/workflows/online-recharge-audit-validation.yml'),
                             ('nodeEnv', 'test'), ('runtimeAdminFileCount', 2)]:
            invalid = copy.deepcopy(contract)
            invalid['observedAdminNativeBuild'][field] = value
            with patch.object(b.subprocess, 'check_output', side_effect=raw):
                with self.assertRaisesRegex(RuntimeError, 'OBSERVED_ADMIN_NATIVE_CHANGED'):
                    b.verify_published_native(invalid)


    def test_control_sources_keep_existing_frozen_channels_intact(self):
        release = (HERE / 'registration-closure-release.py').read_text()
        self.assertIn('acquire_release_lock', release)
        self.assertIn('runtimeBaseline', release)
        self.assertIn('fresh_scoped_backup', release)
        self.assertIn('preserve_sqlite', release)
        self.assertIn('original.backup(copied)', release)
        self.assertIn('MAINTENANCE_OWNER_CHANGED', release)
        self.assertIn("'--network', 'none'", (HERE / 'recharge-record-release.py').read_text())
        self.assertNotIn('encryptionKey\':', release)
        self.assertIn("config.encryptionKey=process.env.FIELD_ENCRYPTION_KEY", release)


if __name__ == '__main__':
    unittest.main()
