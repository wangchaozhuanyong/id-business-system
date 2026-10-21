"""Reject widened scope and preserve the existing finite publication guards."""
import ast
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import tempfile
import base64
import zlib
import io
import zipfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('manual_release_tests', HERE / 'bitbrowser-manual-release.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def project_temporary_directory(root=HERE.parents[1]):
    directory = root / '.runtime'
    directory.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(dir=directory)


class ManualReleaseTests(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / p.CONTRACT_FILE).read_bytes())

    def test_temporary_directory_initializes_fresh_project_runtime(self):
        with project_temporary_directory() as outer:
            root = Path(outer) / 'fresh-checkout'
            root.mkdir()
            self.assertFalse((root / '.runtime').exists())
            with project_temporary_directory(root) as temporary:
                self.assertEqual(Path(temporary).parent, root / '.runtime')
                self.assertTrue(Path(temporary).is_dir())
            self.assertFalse(Path(temporary).exists())

    def test_exact_frozen_contract(self):
        p.validate_contract(self.c)
        self.assertEqual(len(self.c['productionSources']), 43)
        self.assertEqual(len(self.c['sharedModules']), 4)

    def test_review_anchor_is_on_mainline_before_squash_merging_publisher(self):
        b = p.load('bitbrowser-manual-build.py')
        self.assertEqual(b.git('merge-base', p.SOURCE, self.c['reviewBase']).decode().strip(), p.SOURCE)
        with patch.object(b, 'git', return_value=b'2ecce1a22aab84f0ae4c40a573511567f7309d71\n'):
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_MAINLINE_REQUIRED'):
                b.check(self.c)

    def test_reject_different_source_parent_or_recipe(self):
        for key in ('sourceReviewCommit', 'expectedCurrent', 'predecessorProofSha256', 'recipe'):
            c = copy.deepcopy(self.c)
            c[key] = 'invalid'
            with self.assertRaises(RuntimeError):
                p.validate_contract(c)

    def test_schema_and_unrelated_runtime_cannot_be_added(self):
        for name in ('apps/api/prisma-mysql/schema.prisma', 'apps/admin/src/v2/features/other/index.ts',
            'apps/api/src/id-business-v2/online-recharge/engine.ts'):
            c = copy.deepcopy(self.c)
            c['sources'][name] = 'a' * 64
            with self.assertRaises(RuntimeError):
                p.validate_contract(c)

    def test_reconstructed_parents_are_finite_and_native_bound(self):
        self.assertEqual(len(self.c['reconstructedParents']), 4)
        self.assertEqual(len(self.c['reconstructedRuntimeModules']), 3)
        for field in ('reconstructedParents', 'reconstructedRuntimeModules'):
            c = copy.deepcopy(self.c)
            c[field].pop(next(iter(c[field])))
            with self.assertRaises(RuntimeError):
                p.validate_contract(c)
        for path in ('../index.html', 'assets/other.js'):
            c = copy.deepcopy(self.c)
            c['reconstructedAdminChunk']['path'] = path
            with self.assertRaises(RuntimeError):
                p.validate_contract(c)
        c = copy.deepcopy(self.c)
        name = next(iter(c['reconstructedParents']))
        c['reconstructedParents'][name]['sourceCommit'] = 'a' * 40
        with self.assertRaises(RuntimeError):
            p.validate_contract(c)

    def test_selected_shared_output_required(self):
        for key in ('apiModules', 'sharedModules'):
            c = copy.deepcopy(self.c)
            c[key] = c[key][1:]
            with self.assertRaises(RuntimeError):
                p.validate_contract(c)

    def test_build_dependency_patch_rejects_other_packages_and_versions_even_with_updated_hash(self):
        b = p.load('bitbrowser-manual-build.py')
        patch = self.c['buildDependencyPatch']
        before = b.git('show', patch['parentCommit'] + ':' + patch['path'])
        after = (HERE.parents[1] / patch['path']).read_bytes()
        p.verify_build_dependency_patch(before, after, self.c)
        for kind in ('other-package', 'version', 'metadata'):
            changed = json.loads(after)
            if kind == 'other-package':
                changed['packages']['node_modules/axios']['version'] = '99.0.0'
            elif kind == 'version':
                changed['packages']['node_modules/follow-redirects']['version'] = '1.16.2'
            else:
                changed['packages']['node_modules/follow-redirects']['license'] = 'different'
            raw = json.dumps(changed).encode()
            c = copy.deepcopy(self.c)
            c['buildDependencyPatch']['sha256'] = p.sha(raw)
            with self.assertRaises(RuntimeError):
                p.verify_build_dependency_patch(before, raw, c)
        for change in ({'path': 'package.json'}, {'package': 'axios'}, {'toVersion': '1.16.2'}):
            c = copy.deepcopy(self.c)
            c['buildDependencyPatch'].update(change)
            with self.assertRaises(RuntimeError):
                p.validate_contract(c)

    def test_finite_context_uses_reviewed_lock_and_does_not_overwrite_unknown_parent(self):
        b = p.load('bitbrowser-manual-build.py')
        patch = self.c['buildDependencyPatch']
        before = b.git('show', patch['parentCommit'] + ':' + patch['path'])
        after = (HERE.parents[1] / patch['path']).read_bytes()
        with project_temporary_directory() as temporary:
            context = Path(temporary)
            target = context / patch['path']
            target.write_bytes(before)
            b.patch_build_lock(context, self.c, p)
            self.assertEqual(target.read_bytes(), after)
            target.write_bytes(b'{}')
            with self.assertRaises(RuntimeError):
                b.patch_build_lock(context, self.c, p)
            self.assertEqual(target.read_bytes(), b'{}')

    def test_build_only_dependency_cannot_silently_enter_preserved_server_runtime(self):
        driver = type('Driver', (), {'run': lambda *args, **kwargs: '{"buildOnlyDependencyInstalled":true}'})()
        with self.assertRaisesRegex(RuntimeError, 'BUILD_ONLY_DEPENDENCY_IN_RUNTIME'):
            p.runtime(driver, {'api': {'containerId': 'test'}}, self.c)

    def test_manual_mysql_must_be_native_and_not_skipped(self):
        value = {'sourceCommit': p.SOURCE, 'runId': '123', 'testedCommit': 'a' * 40, 'manualTestsPassed': 4,
            'manualTestsSkipped': 0, 'financialStepPassed': True, 'rollbackStepPassed': True,
            'nativeLogSha256': 'a' * 64}
        identity = {'qualityVerification': {'sources': {'runId': '123', 'commit': 'a' * 40}}}
        p.verify_mysql(value, identity, self.c)
        for key, invalid in (('sourceCommit', 'a' * 40), ('testedCommit', 'b' * 40), ('runId', '456'), ('manualTestsPassed', 0), ('manualTestsSkipped', 4),
            ('financialStepPassed', False), ('rollbackStepPassed', False), ('nativeLogSha256', '')):
            with self.assertRaises(RuntimeError):
                p.verify_mysql({**value, key: invalid}, identity, self.c)

    def test_native_main_identical_tree_evidence_is_reused_without_skipping_source_quality(self):
        b = p.load('bitbrowser-manual-build.py')
        rows = [{'name': name, 'conclusion': 'success'} for name in ('change-scope', 'quality')]
        rows += [{'name': 'full-quality', 'conclusion': 'skipped'}]
        b.require_quality_jobs(rows, source=False, p=p)
        with self.assertRaises(RuntimeError):
            b.require_quality_jobs(rows, source=True, p=p)
        for name in ('change-scope', 'quality', 'full-quality'):
            invalid = [{**r, 'conclusion': 'failure'} if r['name'] == name else r for r in rows]
            with self.assertRaises(RuntimeError):
                b.require_quality_jobs(invalid, source=False, p=p)
        rows[-1]['conclusion'] = 'success'
        b.require_quality_jobs(rows, source=True, p=p)

    def test_native_mysql_log_accepts_real_and_cli_escaped_colors_but_not_skips(self):
        b = p.load('bitbrowser-manual-build.py')
        prefix = 'full-quality\tVerify financial integrity on disposable MySQL\t2026-10-19T00:00:00Z '
        body = '✓ src/id-business-v2/auto-recharge/recharge-mysql.integration.spec.ts (5 tests)'
        suffix = '\nfull-quality\tVerify rollback, deletion and restore integrity on MySQL\tdone'
        for start, end in [('', ''), ('\x1b[32m', '\x1b[39m'), ('^[[32m', '^[[39m')]:
            colored = body.replace('✓', start + '✓' + end).replace('(5 tests)', start + '(' + end + start + '5 tests' + end + start + ')' + end)
            b.verify_manual_mysql_log((prefix + colored + suffix).encode(), p)
        for invalid in [prefix.replace('Verify financial integrity on disposable MySQL', 'Test') + body + suffix,
            prefix + body.replace('(5 tests)', '(5 tests | 4 skipped)') + suffix,
            prefix + body + '\n' + prefix + body + suffix,
            prefix + body.replace('(5 tests)', '(4 tests)') + suffix]:
            with self.assertRaises(RuntimeError):
                b.verify_manual_mysql_log(invalid.encode(), p)

    def test_transport_encodes_parent_before_send_and_decodes_one_accepted_result(self):
        d = p.load('bitbrowser-manual-dispatch.py')
        expected = {'status': 'BITBROWSER_MANUAL_READONLY_PARENT', 'databaseWrites': 0}
        report = {'zlibBase64': base64.b64encode(zlib.compress(json.dumps(expected).encode())).decode()}
        response = {'Status': 'Success', 'ResponseCode': 0, 'StandardErrorContent': '',
            'StandardOutputContent': json.dumps(report)}
        with project_temporary_directory() as temporary:
            d.OUT = Path(temporary)
            with patch.object(d.subprocess, 'check_output', return_value=b'{"Command":{"CommandId":"test-parent"}}') as send, \
                patch.object(d.subprocess, 'run', return_value=type('Result', (), {'returncode': 0, 'stdout': json.dumps(response).encode()})()):
                self.assertEqual(d.transport({'commit': 'a' * 40, 'workflowRunId': '123'}, 'parent'), expected)
                self.assertEqual(send.call_count, 1)
                parameters = json.loads(send.call_args.args[0][send.call_args.args[0].index('--parameters') + 1])
                self.assertIn('PLAN_ZLIB64=', parameters['commands'][0])
                self.assertTrue((d.OUT / 'parent-accepted.json').is_file())
                with self.assertRaises(RuntimeError):
                    d.transport({'commit': 'a' * 40, 'workflowRunId': '123'}, 'parent')
                self.assertEqual(send.call_count, 1)

    def test_source_receipt_authenticates_native_pr_base_separately_from_business_diff_base(self):
        b = p.load('bitbrowser-manual-build.py')
        run = {'id': 123, 'run_attempt': 1}
        pr = {'number': 640, 'head': {'sha': 'a' * 40}, 'base': {'sha': 'b' * 40}}
        evidence = {'repository': 'wangchaozhuanyong/id-business-system', 'runId': 123,
            'runAttempt': 1, 'pullRequest': 640, 'headSha': 'a' * 40, 'baseSha': 'b' * 40, 'testedTree': 'c' * 40}
        def encoded(value):
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, 'w') as archive:
                archive.writestr('evidence.json', json.dumps(value))
            return stream.getvalue()
        raw = encoded(evidence)
        artifact = {'id': 456, 'name': 'quality-source-evidence-1', 'expired': False, 'digest': 'sha256:' + p.sha(raw)}
        with patch.object(b, 'github', return_value={'artifacts': [artifact]}), \
            patch.object(b.subprocess, 'check_output', return_value=raw):
            receipt = b.source_receipt(run, pr, {'tree': 'c' * 40}, self.c, p)
            self.assertEqual(receipt['testedTree'], 'c' * 40)
            with self.assertRaises(RuntimeError):
                b.source_receipt(run, {**pr, 'base': {'sha': 'd' * 40}}, {'tree': 'c' * 40}, self.c, p)

    def test_adapter_preserves_activation_and_sql_fence(self):
        engine = p.engine(self.c)
        original = p.load('bitbrowser-history-release.py')
        import inspect
        self.assertEqual(inspect.getsource(engine.activate_services), inspect.getsource(original.activate_services))
        self.assertEqual(engine.UPDATED, ('api', 'admin'))
        self.assertEqual(engine.PRESERVED, ('mysql', 'caddy', 'media-resolver', 'auto-recharge'))
        self.assertEqual(engine.REBOUND, ('online-recharge',))

    def test_derived_publisher_resolves_all_global_names_before_activation(self):
        import builtins
        import symtable
        table = symtable.symtable((HERE / 'bitbrowser-manual-release.py').read_text(), str(HERE / 'bitbrowser-manual-release.py'), 'exec')
        publish = next(row for row in table.get_children() if row.get_name() == '_publish')
        unresolved = set(publish.get_globals()) - set(p.__dict__) - set(dir(builtins))
        self.assertEqual(unresolved, set(), 'Activation must not reach an unresolved inherited module name')

    def test_publication_keeps_original_guarded_algorithm(self):
        # Compare AST, allowing only qualification of inherited globals, rename,
        # explicit engine parameter and native parent injection. No guard omitted.
        old_tree = ast.parse((HERE / 'bitbrowser-history-release.py').read_text())
        new_tree = ast.parse((HERE / 'bitbrowser-manual-release.py').read_text())
        old = next(n for n in old_tree.body if isinstance(n, ast.FunctionDef) and n.name == 'release')
        new = next(n for n in new_tree.body if isinstance(n, ast.FunctionDef) and n.name == '_publish')
        new = copy.deepcopy(new)
        new.name = 'release'
        new.args.args.pop(0)
        injections = [n for n in new.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name)
            and t.id == 'c' for t in n.targets)]
        self.assertEqual(len(injections), 1)
        self.assertEqual(ast.dump(injections[0].value), ast.dump(ast.parse("{**c, 'baseline': plan['nativeParentCapture']['baseline']}", mode='eval').body))
        new.body.remove(injections[0])

        class Unqualify(ast.NodeTransformer):
            def visit_Attribute(self, node):
                if isinstance(node.value, ast.Name) and node.value.id == 'engine':
                    return ast.copy_location(ast.Name(id=node.attr, ctx=node.ctx), node)
                return self.generic_visit(node)

        # Shared runtime sources are now part of the API's source lineage.
        lineage = [n for n in ast.walk(new) if isinstance(n, ast.DictComp)
            and n.generators and isinstance(n.generators[0].target, ast.Tuple)]
        extended = [n for n in lineage if n.generators[0].ifs and isinstance(n.generators[0].ifs[0], ast.BoolOp)]
        self.assertEqual(len(extended), 1)
        condition = extended[0].generators[0].ifs[0]
        self.assertEqual(ast.unparse(condition), "n.startswith('apps/' + role + '/') or (role == 'api' and n.startswith('packages/shared/'))")
        extended[0].generators[0].ifs = [condition.values[0]]
        new = Unqualify().visit(new)
        self.assertEqual(ast.dump(new, include_attributes=False), ast.dump(old, include_attributes=False))


if __name__ == '__main__':
    unittest.main()
