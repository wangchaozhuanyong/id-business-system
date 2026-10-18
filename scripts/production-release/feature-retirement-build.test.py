"""Pure admission tests: no installs, Docker, database, GitHub or production calls."""
import io
import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
spec = importlib.util.spec_from_file_location('feature_retirement_build', HERE / 'feature-retirement-build.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


class RetirementBuildTests(unittest.TestCase):
    def setUp(self):
        directory = ROOT / '.runtime/feature-retirement-build-tests'
        directory.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=directory)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def archive(self, entries):
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode='w') as archive:
            for name, kind in entries:
                member = tarfile.TarInfo(name)
                if kind == 'link':
                    member.type, member.linkname = tarfile.SYMTYPE, '/outside'
                    archive.addfile(member)
                else:
                    member.size = 4
                    archive.addfile(member, io.BytesIO(b'data'))
        return raw.getvalue()

    def test_archive_rejects_traversal_absolute_links_and_duplicate_files(self):
        for entries in [[('../outside', 'file')], [('/absolute', 'file')],
                        [('apps/link', 'link')], [('same', 'file'), ('same', 'file')],
                        [('apps/../outside', 'file')], [('apps\\outside', 'file')]]:
            with self.subTest(entries=entries), self.assertRaisesRegex(RuntimeError, 'ARCHIVE_'):
                b.extract_source(self.archive(entries), self.root / 'extracted')
        self.assertFalse((self.root / 'extracted').exists())
        b.extract_source(self.archive([('apps/safe.ts', 'file')]), self.root / 'extracted')
        self.assertEqual((self.root / 'extracted/apps/safe.ts').read_bytes(), b'data')

    def test_overlay_deletes_only_exact_owned_role_files(self):
        source = self.root / 'source'
        context = self.root / 'candidate'
        names = {'apps/api/src/remove.ts': None, 'apps/api/src/keep.ts': b'new-api',
                 'packages/shared/src/shared.ts': b'new-shared',
                 'apps/admin/src/keep.ts': b'new-admin'}
        for name, raw in names.items():
            target = context / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b'old')
            if raw is not None:
                current = source / name
                current.parent.mkdir(parents=True, exist_ok=True)
                current.write_bytes(raw)
        keep = context / 'apps/api/src/unrelated.ts'
        keep.write_bytes(b'preserve')
        hashes = {name: b.digest(raw) if raw else None for name, raw in names.items()}
        with patch.object(b, 'ROOT', source):
            b.overlay_sources(context, hashes, 'api')
        self.assertFalse((context / 'apps/api/src/remove.ts').exists())
        self.assertEqual((context / 'apps/api/src/keep.ts').read_bytes(), b'new-api')
        self.assertEqual((context / 'packages/shared/src/shared.ts').read_bytes(), b'new-shared')
        self.assertEqual((context / 'apps/admin/src/keep.ts').read_bytes(), b'old')
        self.assertEqual(keep.read_bytes(), b'preserve')
        with patch.object(b, 'ROOT', source), self.assertRaisesRegex(RuntimeError, 'DELETED_SOURCE_NOT_IN_BASELINE'):
            b.overlay_sources(context, hashes, 'api')

    def test_overlay_rejects_unreviewed_source_symlink_and_missing_hash(self):
        context = self.root / 'candidate'
        context.mkdir()
        with self.assertRaisesRegex(RuntimeError, 'SOURCE_PATH_INVALID'):
            b.overlay_sources(context, {'apps/api/prisma-mysql/schema.prisma': 'a' * 64}, 'api')
        name = 'apps/api/src/test.ts'
        (context / name).parent.mkdir(parents=True)
        (context / name).symlink_to(self.root / 'not-a-source')
        with self.assertRaisesRegex(RuntimeError, 'SOURCE_SYMLINK'):
            b.overlay_sources(context, {name: 'a' * 64}, 'api')

    def test_exact_output_delta_includes_changed_added_and_deleted_sidecars(self):
        modules = {'old.js': 'old-js', 'changed.js': 'before-js', 'added.js': None}
        before = {'old' + ext: 'old' + ext for ext in b.OUTPUT_SUFFIXES}
        before['old.js'] = 'old-js'
        before.update({'changed' + ext: 'before' + ext for ext in b.OUTPUT_SUFFIXES})
        before['changed.js'] = 'before-js'
        after = {'changed.js': 'after-js', 'changed.js.map': 'after-map',
                 'changed.d.ts': before['changed.d.ts'], 'added.js': 'new-js', 'added.d.ts': 'new-type'}
        baseline = {**before, **{'added' + ext: None for ext in b.OUTPUT_SUFFIXES}}
        updated, deleted = b.output_delta(before, after, baseline, modules, 'API')
        self.assertEqual(updated, {'added.d.ts': 'new-type', 'added.js': 'new-js',
                                  'changed.js': 'after-js', 'changed.js.map': 'after-map'})
        self.assertEqual(deleted, {name: before[name] for name in sorted(before) if name.startswith('old')})

    def test_output_delta_rejects_missing_baseline_extra_module_and_unchanged_claim(self):
        baseline = {'owned.js': 'before', 'owned.js.map': 'map', 'owned.d.ts': 'types'}
        after = {**baseline, 'owned.js': 'after'}
        for before, candidate, files, modules, error in [
            ({**baseline, 'owned.js': 'wrong'}, after, baseline, {'owned.js': 'before'}, 'BASELINE_NOT_REPRODUCED'),
            (baseline, {**after, 'online-recharge/unowned.js': 'extra'}, baseline, {'owned.js': 'before'}, 'OUTPUT_SCOPE_CHANGED'),
            (baseline, after, {'owned.js': 'before'}, {'owned.js': 'before'}, 'BASELINE_SCOPE_CHANGED'),
            (baseline, baseline, baseline, {'owned.js': 'before'}, 'OUTPUT_SCOPE_CHANGED'),
            (baseline, after, baseline, {'../owned.js': 'before'}, 'MODULE_PATH_INVALID')
        ]:
            with self.subTest(error=error), self.assertRaisesRegex(RuntimeError, error):
                b.output_delta(before, candidate, files, modules, 'API')

    def test_declaration_differences_bind_compile_bytes_and_preserve_runtime_deletion_pins(self):
        runtime = {'gone.js': 'js-before', 'gone.js.map': 'map-before', 'gone.d.ts': 'old-live-types',
                   'kept.js': 'kept-before', 'kept.js.map': 'kept-map', 'kept.d.ts': None}
        compiled = {**runtime, 'gone.d.ts': 'compiled-types', 'kept.d.ts': 'compiled-kept-types'}
        before = {name: value for name, value in compiled.items() if value is not None}
        after = {'kept.js': 'kept-after', 'kept.js.map': 'kept-map', 'kept.d.ts': 'new-types'}
        modules = {'gone.js': 'js-before', 'kept.js': 'kept-before'}
        updated, removed = b.output_delta(before, after, runtime, modules, 'API', compiled)
        self.assertEqual(removed['gone.d.ts'], 'old-live-types')
        self.assertEqual(updated['kept.d.ts'], 'new-types')
        with self.assertRaisesRegex(RuntimeError, 'NONDECLARATION_BASELINE_OVERRIDE'):
            b.output_delta(before, after, runtime, modules, 'API', {**compiled, 'kept.js': 'rewritten'})

    def test_pinned_unshipped_declarations_cannot_admit_a_javascript_or_unlisted_change(self):
        baseline = {'owned.js': 'old-js', 'owned.js.map': 'old-map', 'owned.d.ts': 'old-types'}
        before = {**baseline, 'other.js': 'same-js', 'other.js.map': 'same-map',
                  'other.d.ts': 'old-other-types', 'tsconfig.build.tsbuildinfo': 'old-cache'}
        after = {**before, 'owned.js': 'new-js', 'other.d.ts': 'new-other-types',
                 'tsconfig.build.tsbuildinfo': 'new-cache'}
        omitted = {'other.d.ts': {'baselineSha256': 'old-other-types', 'compiledSha256': 'new-other-types'}}
        updated, removed = b.output_delta(before, after, baseline, {'owned.js': 'old-js'}, 'API', None, omitted)
        self.assertEqual(updated, {'owned.js': 'new-js'})
        self.assertEqual(removed, {})
        for candidate, pin in [({**after, 'other.js': 'changed-js'}, omitted),
                               (after, {}), (after, {'other.d.ts': {**omitted['other.d.ts'], 'compiledSha256': 'wrong'}}),
                               ({**after, 'other.tsbuildinfo': 'unapproved-cache'}, omitted)]:
            with self.subTest(candidate=candidate, pin=pin), self.assertRaises(RuntimeError):
                b.output_delta(before, candidate, baseline, {'owned.js': 'old-js'}, 'API', None, pin)

    def test_inventory_refuses_symlinks(self):
        (self.root / 'safe').write_bytes(b'safe')
        (self.root / 'unsafe').symlink_to(self.root / 'safe')
        with self.assertRaisesRegex(RuntimeError, 'CONTENT_SYMLINK'):
            b.inventory(self.root)

    def test_quality_accepts_only_successful_exact_main_push_run(self):
        commit, tree = 'a' * 40, 'b' * 40
        valid = {'id': 123, 'path': '.github/workflows/quality.yml', 'head_branch': 'main',
                 'head_sha': commit, 'conclusion': 'success', 'event': 'push', 'status': 'completed'}
        with patch.object(b, 'git', side_effect=lambda *args: (tree if args[-1] == 'HEAD^{tree}' else commit).encode()):
            with patch.object(b.subprocess, 'check_output', return_value=json.dumps({'workflow_runs': [valid]}).encode()):
                self.assertEqual(b.quality()['runId'], '123')
            for key, value in [('head_branch', 'other'), ('head_sha', 'c' * 40),
                               ('conclusion', 'failure'), ('path', '.github/workflows/unrelated.yml'),
                               ('event', 'workflow_dispatch'), ('status', 'in_progress')]:
                with self.subTest(key=key), patch.object(b.subprocess, 'check_output',
                    return_value=json.dumps({'workflow_runs': [{**valid, key: value}]}).encode()), \
                        self.assertRaisesRegex(RuntimeError, 'QUALITY_GATE_NOT_SUCCESSFUL'):
                    b.quality()

    def test_package_rejects_changed_payload_and_unbound_browser_receipt_before_quality(self):
        output = self.root / 'output'
        payload = output / 'payload'
        payload.mkdir(parents=True)
        (payload / 'deletions.json').write_text('{}\n')
        contract = self.root / 'contract.json'
        contract.write_text('{}\n')
        browser = output / 'browser-acceptance/frontend-static-acceptance.json'
        browser.parent.mkdir()
        browser.write_text('{"status":"passed"}\n')
        proof = {'scope': 'test', 'commit': 'a' * 40, 'tree': 'b' * 40,
                 'contractSha256': b.digest(contract.read_bytes()), 'files': b.inventory(payload)}
        receipt = {**{key: proof[key] for key in ('scope', 'commit', 'tree', 'contractSha256')},
                   'uiChecks': list(b.UI_CHECKS), 'status': 'PASS', 'businessActions': 0,
                   'externalRequests': 0, 'browserReportSha256': 'wrong'}
        (output / 'prepared-build-proof.json').write_text(json.dumps(proof))
        receipt_file = output / 'validation-receipt.json'
        receipt_file.write_text(json.dumps(receipt))
        quality = Mock(side_effect=AssertionError('quality must not run before local evidence validation'))
        git = lambda *args: (proof['tree'] if args[-1] == 'HEAD^{tree}' else proof['commit']).encode()
        with patch.object(b, 'OUTPUT', output), patch.object(b, 'CONTRACT', contract), \
                patch.object(b, 'verify_sources'), patch.object(b, 'git', side_effect=git), \
                patch.object(b, 'quality', quality):
            with self.assertRaisesRegex(RuntimeError, 'VALIDATION_MISSING'):
                b.package({})
            receipt['browserReportSha256'] = b.digest(browser.read_bytes())
            receipt_file.write_text(json.dumps(receipt))
            (payload / 'unreviewed').write_text('unreviewed')
            with self.assertRaisesRegex(RuntimeError, 'COMPILED_INPUT_MOVED'):
                b.package({})
        quality.assert_not_called()

    def test_workflow_requires_both_gates_and_keeps_native_publication_serial(self):
        workflow = (ROOT / '.github/workflows/feature-retirement-validation.yml').read_text()
        self.assertIn('needs: [validate, quality-gate]', workflow)
        self.assertIn("github.ref == 'refs/heads/main' && inputs.commit == github.sha", workflow)
        self.assertIn('group: id-business-v2-production-release\n  cancel-in-progress: false', workflow)
        self.assertIn('id-token: write', workflow)
        self.assertIn('feature-retirement-dispatch.py', workflow)
        self.assertNotIn('workflow_run:', workflow)
        self.assertNotIn('services:', workflow)
        self.assertNotIn('migrate:deploy', workflow)

    def test_published_successor_is_exact_git_delta_and_content(self):
        name = 'apps/admin/src/v2/features/online-recharge/rechargeVoice.ts'
        c = {'publishedAdminRecipe': {'commit': '6da10d2e4bd9de6df145899648e234000f84b72b'},
             'adminSourceBaseline': 'a' * 40,
             'adminPublishedSources': {name: b.digest(b'published')}}
        with patch.object(b, 'git', side_effect=[(name + '\n').encode(), b'published']):
            self.assertEqual(b.preserved_admin_sources(c), {name: b'published'})
        with patch.object(b, 'git', return_value=b''):
            with self.assertRaisesRegex(RuntimeError, 'SUCCESSOR_SCOPE_CHANGED'):
                b.preserved_admin_sources(c)
        with patch.object(b, 'git', side_effect=[(name + '\n').encode(), b'other']):
            with self.assertRaisesRegex(RuntimeError, 'SUCCESSOR_CHANGED'):
                b.preserved_admin_sources(c)

    def test_successor_cannot_import_dependencies_or_unowned_files(self):
        for name in ['apps/admin/package.json', '../outside', 'apps/api/src/other.ts']:
            c = {'publishedAdminRecipe': {'commit': '6da10d2e4bd9de6df145899648e234000f84b72b'},
                 'adminSourceBaseline': 'a' * 40, 'adminPublishedSources': {name: b.digest(b'published')}}
            with patch.object(b, 'git', return_value=(name + '\n').encode()):
                with self.assertRaisesRegex(RuntimeError, 'SUCCESSOR_PATH_INVALID'):
                    b.preserved_admin_sources(c)


if __name__ == '__main__':
    unittest.main()
