"""Local-only tests of the finite pending-online generated build projection."""

from contextlib import contextmanager
import copy
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('pending_projection',
    Path(__file__).with_name('api-admin-pending-projection.py'))
projection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(projection)


def archive_files(raw, commit=None):
    files = {}
    prefix = 'id-business-system-' + commit + '/' if commit else ''
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:*') as archive:
        for member in archive:
            if member.isfile():
                name = member.name[len(prefix):] if prefix else member.name
                files[name] = (archive.extractfile(member).read(),
                               '100755' if member.mode & 0o111 else '100644')
    return files


def git_archive(commit, *, prefix=False):
    args = ['git', 'archive', '--format=tar']
    if prefix:
        args.append('--prefix=id-business-system-' + commit + '/')
    return subprocess.check_output([*args, commit], cwd=ROOT)


@contextmanager
def cwd(directory):
    previous = Path.cwd()
    os.chdir(directory)
    try:
        yield
    finally:
        os.chdir(previous)


class PendingProjectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.baseline = archive_files(git_archive(projection.BASELINE_COMMIT))
        cls.online = archive_files(git_archive(projection.ONLINE_COMMIT))
        cls.commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT).decode().strip()
        cls.candidate = archive_files(git_archive(cls.commit))
        cls.tree = subprocess.check_output(['git', 'rev-parse', cls.commit + '^{tree}'], cwd=ROOT).decode().strip()
        cls.output, cls.record = projection.project_files(cls.candidate, cls.baseline,
                                                        cls.online, cls.commit, cls.tree)
        cls.runtime = ROOT / '.runtime/pending-projection-tests'
        cls.runtime.mkdir(parents=True, exist_ok=True)

    def project(self, files=None):
        files = dict(self.candidate) if files is None else files
        return projection.project_files(files, self.baseline, self.online,
                                        self.commit, projection.source_tree(files))

    def controller(self):
        archives = {commit: git_archive(commit, prefix=True) for commit in
                    (projection.BASELINE_COMMIT, projection.ONLINE_COMMIT, self.commit)}
        return SimpleNamespace(
            registration_archive=archive_files,
            registration_download=MagicMock(side_effect=lambda commit: archives[commit]))

    def changed_file(self, name, transform, *, mode=None):
        files = dict(self.candidate)
        raw, old_mode = files[name]
        files[name] = (transform(raw), mode or old_mode)
        return files

    def test_exact_candidate_tree_and_reference_seals_match_real_git(self):
        self.assertEqual(projection.source_tree(self.candidate), self.tree)
        projection.validate_references(self.baseline, self.online)
        self.assertEqual(len(self.record['generatedFiles']), 26)
        self.assertEqual(len(self.record['removedFiles']), 152)

    def test_generated_inputs_use_exact_online_inverse_and_preserve_all_other_files(self):
        for name in projection.FILE_SEALS:
            self.assertEqual(self.output[name], self.baseline[name])
        for name, row in self.candidate.items():
            if name not in projection.FILE_SEALS and name not in self.record['removedFiles']:
                self.assertEqual(self.output[name], row, name)
        for root in projection.ONLINE_SOURCE_SEALS:
            self.assertFalse(any(name.startswith(root + '/') for name in self.output))
        self.assertTrue(all(name not in self.output for name in projection.REMOVED_FILE_SEALS))

    def test_real_bitbrowser_worker_and_table_improvements_are_not_reverted(self):
        names = ('apps/api/src/id-business-v2/auto-recharge/worker/bitbrowser_connector.py',
                 'apps/admin/src/v2/features/auto-recharge/bitbrowser-login-page.ts',
                 'apps/admin/src/v2/components/V2Table.vue', 'apps/admin/src/v2/styles/records.css')
        for name in names:
            self.assertEqual(self.output[name], self.candidate[name])
        self.assertNotEqual(self.output[names[0]], self.baseline[names[0]])

    def test_later_nonintersecting_central_change_is_preserved_byte_for_byte(self):
        name = 'apps/admin/src/v2/features/registry.ts'
        suffix = b'\n// Later independent BitBrowser registration change.\n'
        files = self.changed_file(name, lambda raw: raw + suffix)
        output, record = self.project(files)
        self.assertEqual(output[name][0], self.baseline[name][0] + suffix)
        self.assertNotEqual(record['projectionSha256'], self.record['projectionSha256'])

    def test_candidate_tree_mismatch_rejects_before_projection(self):
        with self.assertRaisesRegex(RuntimeError, 'CANDIDATE_TREE_CHANGED'):
            projection.project_files(self.candidate, self.baseline, self.online, self.commit, '0' * 40)

    def test_reference_blob_or_mode_change_rejects(self):
        baseline = dict(self.baseline)
        name = 'apps/api/src/main.ts'
        baseline[name] = (baseline[name][0] + b'\n', baseline[name][1])
        with self.assertRaisesRegex(RuntimeError, 'REFERENCE_TREE_CHANGED'):
            projection.project_files(self.candidate, baseline, self.online, self.commit, self.tree)
        online = dict(self.online)
        online[name] = (online[name][0], '100755')
        with self.assertRaisesRegex(RuntimeError, 'REFERENCE_TREE_CHANGED'):
            projection.project_files(self.candidate, self.baseline, online, self.commit, self.tree)

    def test_partial_already_removed_or_crossed_delta_rejects(self):
        name = 'apps/api/src/id-business-v2/id-business-v2.module.ts'
        for raw in (self.baseline[name][0], self.candidate[name][0].replace(
                b'    OnlineRechargeModule,', b'    OnlineRechargeModule /* changed */,')):
            files = dict(self.candidate)
            files[name] = (raw, files[name][1])
            with self.subTest(raw=raw[:30]), self.assertRaisesRegex(RuntimeError, 'DELTA_INTERSECTION'):
                self.project(files)

    def test_duplicate_hunk_rejects_instead_of_selecting_one_match(self):
        files = self.changed_file('apps/admin/src/v2/features/registry.ts', lambda raw: raw + raw)
        with self.assertRaisesRegex(RuntimeError, 'DELTA_INTERSECTION'):
            self.project(files)

    def test_central_executable_mode_change_rejects(self):
        files = self.changed_file('apps/api/src/main.ts', lambda raw: raw, mode='100755')
        with self.assertRaisesRegex(RuntimeError, 'INPUT_FILE_CHANGED'):
            self.project(files)

    def test_runtime_schema_seed_compose_change_rejects_even_outside_online_delta(self):
        for name in projection.RUNTIME_FILES:
            files = self.changed_file(name, lambda raw: raw + b'\n')
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'RUNTIME_INPUT_CHANGED'):
                self.project(files)

    def test_online_directory_extra_missing_changed_and_mode_changed_all_reject(self):
        name = 'apps/admin/src/v2/features/online-recharge/manifest.ts'
        changed = self.changed_file(name, lambda raw: raw + b'\n')
        missing = dict(self.candidate)
        del missing[name]
        extra = dict(self.candidate)
        extra[name + '.unknown'] = (b'unknown', '100644')
        mode = self.changed_file(name, lambda raw: raw, mode='100755')
        for files in (changed, missing, extra, mode):
            with self.subTest(case=len(files)), self.assertRaisesRegex(RuntimeError, 'INPUT_DIRECTORY_CHANGED'):
                self.project(files)

    def test_removed_event_and_migration_inputs_are_not_wildcards(self):
        for name in projection.REMOVED_FILE_SEALS:
            files = self.changed_file(name, lambda raw: raw + b'\n')
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'INPUT_FILE_CHANGED'):
                self.project(files)

    def test_source_entries_reject_traversal_symlink_modes_and_file_directory_collision(self):
        for name, row in (('../outside', (b'bad', '100644')), ('/outside', (b'bad', '100644')),
                          ('normal', (b'bad', '120000')), ('apps', (b'collision', '100644'))):
            files = dict(self.candidate)
            files[name] = row
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'SOURCE_INVALID'):
                self.project(files)

    def test_record_validation_is_pure_and_bound_to_candidate_commit_tree(self):
        forbidden = SimpleNamespace(registration_download=MagicMock(side_effect=AssertionError('network')))
        self.assertEqual(projection.validate_record(forbidden, self.record, self.commit, self.tree), self.record)
        forbidden.registration_download.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, 'RECORD_IDENTITY_CHANGED'):
            projection.validate_record(forbidden, self.record, 'a' * 40, self.tree)

    def test_record_unknown_fields_removed_file_inventory_and_hash_tampering_reject(self):
        examples = []
        record = copy.deepcopy(self.record)
        record['onlinePublished'] = True
        examples.append(record)
        record = copy.deepcopy(self.record)
        del record['removedFiles'][next(iter(record['removedFiles']))]
        examples.append(record)
        record = copy.deepcopy(self.record)
        record['generatedFiles']['apps/api/src/main.ts']['after']['sha256'] = '0' * 64
        examples.append(record)
        record = copy.deepcopy(self.record)
        record['projectionSha256'] = '0' * 64
        examples.append(record)
        for record in examples:
            with self.assertRaisesRegex(RuntimeError, 'RECORD_CHANGED'):
                projection.validate_record(None, record, self.commit, self.tree)

    def test_verify_output_detects_added_removed_modified_or_mode_changed_bytes(self):
        missing = dict(self.output)
        del missing['apps/api/src/main.ts']
        extra = dict(self.output)
        extra['unknown'] = (b'bad', '100644')
        changed = dict(self.output)
        changed['apps/api/src/main.ts'] = (b'bad', '100644')
        mode = dict(self.output)
        mode['apps/api/src/main.ts'] = (mode['apps/api/src/main.ts'][0], '100755')
        for files in (missing, extra, changed, mode):
            with self.assertRaisesRegex(RuntimeError, 'OUTPUT_CHANGED'):
                projection.verify_output(files, self.record)

    def test_runtime_stage_reconstructs_exact_source_and_returns_only_three_configs(self):
        d = self.controller()
        result = projection.runtime_config_files(d, self.candidate, self.record)
        self.assertEqual(set(result), set(projection.RUNTIME_FILES))
        self.assertTrue(all(result[name] == self.baseline[name] for name in result))
        self.assertEqual(d.registration_download.call_count, 2)

    def test_runtime_stage_does_not_trust_a_self_consistent_forged_record(self):
        forged = copy.deepcopy(self.record)
        forged['generatedFiles']['apps/api/src/main.ts']['after']['sha256'] = '0' * 64
        forged['projectionSha256'] = projection.fingerprint({k: v for k, v in forged.items()
                                                           if k != 'projectionSha256'})
        projection.validate_record(None, forged, self.commit, self.tree)
        with self.assertRaisesRegex(RuntimeError, 'RECORD_SOURCE_CHANGED'):
            projection.runtime_config_files(self.controller(), self.candidate, forged)

    def test_runtime_stage_refuses_generated_or_uncommitted_sources_as_original_candidate(self):
        for files in (self.output, self.changed_file('docs/V2_TASKS.md', lambda raw: raw + b'WIP')):
            with self.assertRaisesRegex(RuntimeError, 'CANDIDATE_TREE_CHANGED'):
                projection.runtime_config_files(self.controller(), files, self.record)

    def test_prepare_build_uses_immutable_archive_and_never_edits_checkout(self):
        with tempfile.TemporaryDirectory(dir=self.runtime) as temporary:
            root = Path(temporary)
            working_file = root / 'apps/api/src/main.ts'
            working_file.parent.mkdir(parents=True)
            working_file.write_bytes(b'Uncommitted working content must not enter context.')
            d = self.controller()
            d.run = MagicMock(side_effect=[self.commit, self.tree])

            def write_files(target, files):
                target.mkdir(mode=0o700)
                for name, (raw, mode) in files.items():
                    path = target / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(raw)
                    path.chmod(0o755 if mode == '100755' else 0o644)

            d.write_registration_files = write_files
            env = {'RELEASE_OPERATION': 'release_api_workspace', 'RELEASE_COMMIT': self.commit, 'SOURCE_TREE': self.tree}
            with cwd(root), patch.dict(os.environ, env), patch.object(
                    projection.subprocess, 'check_output', return_value=git_archive(self.commit, prefix=True)):
                record = projection.prepare_build(d)
                self.assertEqual(record, self.record)
                self.assertEqual((root / projection.CONTEXT_PATH / 'apps/api/src/main.ts').read_bytes(),
                                 self.output['apps/api/src/main.ts'][0])
                self.assertTrue(working_file.read_bytes().startswith(b'Uncommitted'))
                self.assertEqual((root / projection.RECORD_PATH).stat().st_mode & 0o777, 0o600)
                projection.verify_build_context(d, projection.CONTEXT_PATH, record)
                added = root / projection.CONTEXT_PATH / 'unexpected-host-file'
                added.write_bytes(b'bad')
                with self.assertRaisesRegex(RuntimeError, 'CONTEXT_CHANGED'):
                    projection.verify_build_context(d, projection.CONTEXT_PATH, record)
                added.unlink()
                executable = root / projection.CONTEXT_PATH / 'apps/api/src/main.ts'
                executable.chmod(0o666)
                with self.assertRaisesRegex(RuntimeError, 'CONTEXT_INVALID'):
                    projection.verify_build_context(d, projection.CONTEXT_PATH, record)

    def test_prepare_existing_context_or_other_operation_rejects_without_mutation(self):
        with tempfile.TemporaryDirectory(dir=self.runtime) as temporary:
            root = Path(temporary)
            target = root / projection.CONTEXT_PATH
            target.mkdir(parents=True)
            d = SimpleNamespace(run=MagicMock(side_effect=[self.commit, self.tree]))
            env = {'RELEASE_OPERATION': 'release_api_workspace', 'RELEASE_COMMIT': self.commit, 'SOURCE_TREE': self.tree}
            with cwd(root), patch.dict(os.environ, env):
                with self.assertRaisesRegex(RuntimeError, 'OUTPUT_EXISTS'):
                    projection.prepare_build(d)
            with cwd(root), patch.dict(os.environ, {'RELEASE_OPERATION': 'release_online_recharge'}):
                with self.assertRaisesRegex(RuntimeError, 'SCOPE_CONFLICT'):
                    projection.prepare_build(d)

    def test_projection_is_deterministic_and_does_not_mutate_input_dictionaries(self):
        candidate = dict(self.candidate)
        output, record = self.project(candidate)
        self.assertEqual(candidate, self.candidate)
        self.assertEqual(output, self.output)
        self.assertEqual(record, self.record)


if __name__ == '__main__':
    unittest.main()
