"""Joint immutable-source regressions; archives and projections stay in memory."""

import ast
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
from types import SimpleNamespace
import unittest


ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
APP_PREFIXES = ('apps/api/', 'apps/admin/', 'packages/shared/')
APP_FILES = ('package.json', 'package-lock.json', '.dockerignore',
             'tsconfig.base.json', 'deploy/nginx/admin.conf')
# Independent literals retain the original application seal and admit exactly
# the reviewed successor. Caller-supplied or recomputed hashes grant no scope.
APPLICATION_SEAL = '2e9549278a2e883a6a7eba4a90a565146919e3ce631f4c5cfe8e5771b2dfd647'
PUBLISHED_APPLICATION_SEAL = 'c4f1c8d57580412999493e0895faf5c912611dcc8973abffeb11d5f2aae0064b'
CONFIRM_INPUTS = {
    'apps/admin/src/v2/features/auto-recharge/useRechargeLocalConfirmation.ts': {
        'mode': '100644', 'sha256': 'e68503d21fba26c5303d58eae0e35d2f076e167fb1a16aeb592084dcc199c352'},
    'apps/admin/src/v2/features/auto-recharge/useRechargeLocalConfirmation.spec.ts': {
        'mode': '100644', 'sha256': '39597b5f8e5a6db3d5aaff309ab013156c59d7b50279a7d91e8e47a215a991af'},
}
CONFIRM_OVERLAY = 'a3ea38d3f31dce7f438d067e6bfbafe4108636ed50c75621beb44a8948b2b8b7'


def verify_application_worktree(sealed, current, projection):
    fingerprint = lambda value: hashlib.sha256(json.dumps(value, sort_keys=True,
        separators=(',', ':')).encode()).hexdigest()
    before = projection.inventory(sealed)
    seal = fingerprint(before)
    if len(before) != 2191 or seal not in (APPLICATION_SEAL, PUBLISHED_APPLICATION_SEAL):
        raise RuntimeError('JOINT_ORIGINAL_APPLICATION_SEAL_CHANGED')
    if set(current) != set(sealed):
        raise RuntimeError('JOINT_APPLICATION_PATHS_CHANGED')
    changed = {name for name in sealed if current[name] != sealed[name]}
    if not changed:
        return 'ORIGINAL_APPLICATION' if seal == APPLICATION_SEAL else 'PUBLISHED_APPLICATION'
    if seal != PUBLISHED_APPLICATION_SEAL:
        raise RuntimeError('JOINT_CONFIRM_PUBLISHED_BASELINE_REQUIRED')
    if changed != set(CONFIRM_INPUTS):
        raise RuntimeError('JOINT_UNREVIEWED_APPLICATION_CHANGE')
    overlay = projection.inventory({name: current[name] for name in changed})
    if overlay != CONFIRM_INPUTS or fingerprint(overlay) != CONFIRM_OVERLAY:
        raise RuntimeError('JOINT_CONFIRM_OVERLAY_CHANGED')
    return 'ADMIN_CONFIRM_EXPIRY_20261014'
REMAINING_REVIEWED_SOURCE = '28132dc776ccb94c44e243a81731f27c91ae4ed3'
REMAINING_REVIEWED_PATHS = frozenset((
    'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct-api.ts',
    'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct.spec.ts',
    'apps/admin/src/v2/features/auto-recharge/useBitBrowserDirectOpen.spec.ts',
    'apps/admin/src/v2/features/auto-recharge/useBitBrowserDirectOpen.ts',
    'apps/api/src/id-business-v2/auto-recharge/recharge-owned-profile.spec.ts',
    'apps/api/src/id-business-v2/auto-recharge/worker/bitbrowser_connector.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_bitbrowser_connector.py',
))


def load(filename):
    spec = importlib.util.spec_from_file_location('joint_' + filename.replace('-', '_'), HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def archived_files(commit):
    raw = subprocess.check_output(['git', 'archive', '--format=tar', commit], cwd=ROOT)
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as source:
        return {item.name: (source.extractfile(item).read(), '100755' if item.mode & 0o111 else '100644')
                for item in source if item.isfile()}


def assigned(raw, name):
    tree = ast.parse(raw)
    value = next(node.value for node in tree.body if isinstance(node, ast.Assign)
                 and any(isinstance(target, ast.Name) and target.id == name for target in node.targets))
    if isinstance(value, ast.Dict):
        return {ast.literal_eval(key): assigned(raw, item.id) if isinstance(item, ast.Name) else ast.literal_eval(item)
                for key, item in zip(value.keys, value.values)}
    return ast.literal_eval(value)


class JointSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.core = load('unpublished-component-successor.py')
        cls.projection = cls.core.projection_module()
        cls.candidate = archived_files(cls.core.APPLICATION_SOURCE)
        cls.base = archived_files('0a03fa28e6b844a18833d5c63f1de700f091fc64')
        cls.online = archived_files('28a3ba4ffd17d36001b1104c97394f5ae871d73d')
        cls.reviewed458 = archived_files('a019e794fd6b3313fa312ad5a08fa4559f876d18')
        cls.old_api = archived_files('31d2c6885a45817cd40d23fce8d6145bc9f18af2')
        cls.old_admin = archived_files('60e164b75d1eedaab440c17139bf9ba55de08c61')
        cls.original_application_source = archived_files('b1a775d1dc0bc460fb59eebcec089342b6134788')
        cls.published = archived_files('f193f34ea09a2c37485c1582a81b33ee3acec865')
        cls.reviewed_remaining = archived_files(REMAINING_REVIEWED_SOURCE)
        cls.output, cls.record = cls.projection.project_files(cls.candidate, cls.base, cls.online,
            cls.core.APPLICATION_SOURCE, cls.core.APPLICATION_TREE)
        cls.application = {name: row for name, row in cls.projection.inventory(cls.candidate).items()
                           if name.startswith(APP_PREFIXES) or name in APP_FILES}

    def test_business_archive_tree_and_all_application_bytes_match_the_worktree_seal(self):
        self.assertEqual(self.projection.source_tree(self.candidate), self.core.APPLICATION_TREE)
        self.assertEqual(len(self.application), self.core.APPLICATION_INPUT_COUNT)
        self.assertEqual(self.core.fingerprint(self.application), self.core.APPROVED_APPLICATION_INPUT_SHA256)
        paths = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard',
            '--', 'apps/api', 'apps/admin', 'packages/shared', *APP_FILES], cwd=ROOT).decode().splitlines()
        present = {name for name in paths if (ROOT / name).is_file()}
        self.assertEqual(present, set(self.application))
        current = {}
        for name in sorted(present):
            with self.subTest(path=name):
                path = ROOT / name
                self.assertFalse(path.is_symlink())
                current[name] = (path.read_bytes(), '100755' if path.stat().st_mode & 0o111 else '100644')
        sealed = {name: self.candidate[name] for name in present}
        profile = verify_application_worktree(sealed, current, self.projection)
        for name in sorted(present - (set(CONFIRM_INPUTS) if profile == 'ADMIN_CONFIRM_EXPIRY_20261014' else set())):
            with self.subTest(path=name):
                self.assertEqual(current[name], self.candidate[name])
        if profile == 'ADMIN_CONFIRM_EXPIRY_20261014':
            # Prove these independent literals agree with the real production
            # projection and its fixed predecessor/control archives, in memory.
            adapter = load('admin-pending-online-release.py')
            self.assertEqual(set(adapter.CONFIRM_FILES), set(CONFIRM_INPUTS))
            self.assertEqual(adapter.CONFIRM_OVERLAY_SHA256, CONFIRM_OVERLAY)
            self.assertEqual(adapter.CONFIRM_BASELINE, '43c31870c9497d900491cdb19c5f61c766f3b344')
            self.assertEqual(adapter.CONFIRM_CONTROL_SOURCE, '43c31870c9497d900491cdb19c5f61c766f3b344')
            tracked = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard'],
                cwd=ROOT).decode().splitlines()
            full = {}
            for name in tracked:
                path = ROOT / name
                self.assertFalse(path.is_symlink(), name)
                if path.is_file():
                    full[name] = (path.read_bytes(), '100755' if path.stat().st_mode & 0o111 else '100644')
            self.assertEqual({name: full[name] for name in current}, current)
            output, record, runtime = adapter.project_confirm(full,
                archived_files(adapter.CONFIRM_BASELINE), self.base, self.online,
                'a' * 40, self.projection.source_tree(full), archived_files(adapter.CONFIRM_CONTROL_SOURCE))
            self.assertEqual(record['profile'], profile)
            self.assertEqual(record['overlayFiles'], CONFIRM_INPUTS)
            self.assertEqual(record['overlaySha256'], CONFIRM_OVERLAY)
            self.assertEqual(record['sourceBasisCommit'], adapter.CONFIRM_BASELINE)
            self.assertEqual(record['controlSourceTree'], 'ede35ed238c2b0c00f536dbca25014d748637749')
            self.assertFalse(any('/online-recharge/' in name for name in output))
            for name, row in runtime.items():
                self.assertEqual(output[name], row)

    def test_original_application_branch_still_requires_the_entire_original_seal(self):
        sealed = {name: self.original_application_source[name] for name in self.application}
        self.assertEqual(self.projection.source_tree(self.original_application_source),
                         'c45fa8f14a97e215d47ec9dc2a325f5fe611a921')
        self.assertEqual(verify_application_worktree(sealed, dict(sealed), self.projection),
                         'ORIGINAL_APPLICATION')
        published = {name: self.candidate[name] for name in self.application}
        self.assertEqual(verify_application_worktree(published, dict(published), self.projection),
                         'PUBLISHED_APPLICATION')
        old_with_overlay = {**sealed, **{name: ((ROOT / name).read_bytes(), '100644') for name in CONFIRM_INPUTS}}
        with self.assertRaisesRegex(RuntimeError, 'CONFIRM_PUBLISHED_BASELINE_REQUIRED'):
            verify_application_worktree(sealed, old_with_overlay, self.projection)
        substituted = dict(sealed)
        name = next(iter(CONFIRM_INPUTS))
        substituted[name] = (sealed[name][0] + b'\n// substituted seal\n', '100644')
        with self.assertRaisesRegex(RuntimeError, 'ORIGINAL_APPLICATION_SEAL_CHANGED'):
            verify_application_worktree(substituted, substituted, self.projection)

    def test_reviewed_successor_rejects_mutated_single_deleted_added_and_mode_changed_inputs(self):
        sealed = {name: self.candidate[name] for name in self.application}
        approved = {**sealed, **{name: ((ROOT / name).read_bytes(), '100644') for name in CONFIRM_INPUTS}}
        self.assertEqual(verify_application_worktree(sealed, approved, self.projection),
                         'ADMIN_CONFIRM_EXPIRY_20261014')
        first, second = CONFIRM_INPUTS
        for fault in ('bytes', 'single', 'delete', 'add', 'overlay-mode', 'other-mode'):
            current = dict(approved)
            if fault == 'bytes': current[first] = (current[first][0] + b'\n// tampered\n', '100644')
            elif fault == 'single': current[second] = sealed[second]
            elif fault == 'delete': del current[first]
            elif fault == 'add': current['apps/admin/src/v2/features/unknown.ts'] = (b'export {}', '100644')
            elif fault == 'overlay-mode': current[first] = (current[first][0], '100755')
            else:
                name = 'package-lock.json'; current[name] = (current[name][0], '100755')
            with self.subTest(fault=fault), self.assertRaises(RuntimeError):
                verify_application_worktree(sealed, current, self.projection)
        for name in ('apps/api/src/main.ts', 'apps/api/src/auth/auth.service.ts',
                     'apps/admin/src/v2/styles/base.css', 'packages/shared/src/v2/auto-recharge.ts',
                     'apps/api/prisma-mysql/schema.prisma', 'package-lock.json', *REMAINING_REVIEWED_PATHS):
            current = dict(approved); raw, mode = current[name]
            current[name] = (raw + b'\n// unreviewed\n', mode)
            with self.subTest(path=name), self.assertRaisesRegex(RuntimeError, 'UNREVIEWED_APPLICATION_CHANGE'):
                verify_application_worktree(sealed, current, self.projection)

    def test_projection_retains_every_source_outside_the_exact_online_delta(self):
        generated, removed = set(self.record['generatedFiles']), set(self.record['removedFiles'])
        for name, row in self.candidate.items():
            if name not in generated | removed:
                with self.subTest(path=name):
                    self.assertEqual(self.output[name], row)
        self.assertEqual(set(self.output), set(self.candidate) - removed)

    def test_reviewed_table_employee_and_mailbox_batch_survives(self):
        paths = (
            'apps/admin/src/v2/components/V2TableActionColumn.vue',
            'apps/api/src/id-business-v2/auto-recharge/recharge-connection-access.ts',
            'apps/api/src/id-business-v2/auto-registration/worker/apple_closed_loop.py',
            'apps/api/src/id-business-v2/auto-registration/worker/apple_registration_diagnostics.py',
        )
        for name in paths:
            with self.subTest(path=name):
                self.assertEqual(self.output[name], self.reviewed458[name])
        self.assertNotEqual(self.output[paths[1]], self.old_api.get(paths[1]))
        self.assertNotEqual(self.output[paths[2]], self.old_api.get(paths[2]))

    def test_all_reviewed_recharge_app_and_shared_files_survive(self):
        spec = load('recharge-flow-successor-projection.py').contract()
        for name, digest in spec['businessFiles'].items():
            if name.startswith(APP_PREFIXES):
                with self.subTest(path=name):
                    if name in REMAINING_REVIEWED_PATHS:
                        self.assertEqual(hashlib.sha256(self.published[name][0]).hexdigest(), digest)
                        self.assertEqual(self.output[name], self.reviewed_remaining[name])
                    else:
                        self.assertEqual(hashlib.sha256(self.output[name][0]).hexdigest(), digest)
                        self.assertEqual(self.output[name][1], self.published[name][1])
        shared = self.output['packages/shared/src/v2/auto-recharge.ts'][0]
        self.assertIn(b'V2_RECHARGE_SUBSCRIPTION_CYCLE_PROTOCOL', shared)
        self.assertIn(b'next-subscription-cycle-v1', shared)

    def test_only_the_exact_reviewed_seven_file_remaining_delta_is_admitted(self):
        paths = {n for n in set(self.published) | set(self.reviewed_remaining) | set(self.candidate)
                 if n.startswith(APP_PREFIXES) or n in APP_FILES}
        changed = {n for n in paths if self.published.get(n) != self.reviewed_remaining.get(n)}
        self.assertEqual(changed, REMAINING_REVIEWED_PATHS)
        candidate_changed = {n for n in paths if self.published.get(n) != self.candidate.get(n)}
        self.assertEqual(candidate_changed, REMAINING_REVIEWED_PATHS)
        for name in REMAINING_REVIEWED_PATHS:
            with self.subTest(path=name):
                self.assertEqual(self.output[name], self.reviewed_remaining[name])
                self.assertEqual(self.output[name], self.candidate[name])
                self.assertNotEqual(self.output[name], self.published[name])

    def test_workspace_dock_and_latest_table_width_fix_survive_without_old_admin(self):
        for name in (
            'apps/admin/src/v2/components/workspace/V2WorkspaceDock.vue',
            'apps/admin/src/v2/composables/useV2TableContentWidths.ts',
            'apps/admin/src/v2/styles/base.css',
        ):
            with self.subTest(path=name):
                self.assertEqual(self.output[name], self.candidate[name])
                self.assertNotEqual(self.output[name], self.old_admin.get(name))
        layout = self.output['apps/admin/src/v2/layouts/V2AdminLayout.vue'][0]
        self.assertIn(b'<V2WorkspaceDock', layout)
        self.assertNotIn(b'<V2QuickActions', layout)
        self.assertNotIn(b'<V2WorkspaceLauncher', layout)

    def test_online_modules_and_entries_are_absent_from_the_projected_runtime(self):
        self.assertFalse(any(name.startswith(('apps/api/src/id-business-v2/online-recharge/',
            'apps/admin/src/v2/features/online-recharge/')) for name in self.output))
        self.assertNotIn('apps/api/prisma-mysql/migrations/20261009093000_online_recharge/migration.sql', self.output)
        for name in ('apps/admin/src/v2-router.ts', 'apps/admin/src/v2/features/registry.ts',
                     'apps/admin/src/v2/layouts/V2AdminLayout.vue'):
            with self.subTest(path=name):
                self.assertNotIn(b'online-recharge', self.output[name][0])

    def test_only_the_original_connection_migration_and_schema_are_projected(self):
        name = self.core.MIGRATION_ROOT + '/' + self.core.MIGRATION_FILE
        self.assertEqual(self.output[name], self.candidate[name])
        self.assertEqual(hashlib.sha256(self.output[name][0]).hexdigest(), self.core.MIGRATION_IDENTITY['sha256'])
        self.assertEqual(hashlib.sha256(self.output[self.core.MIGRATION_SCHEMA][0]).hexdigest(),
                         self.core.MIGRATION_IDENTITY['schemaAfterSha256'])
        old = subprocess.check_output(['git', 'show', '42e8eab5:scripts/production-release/unpublished-component-successor.py'], cwd=ROOT)
        self.assertEqual(self.core.MIGRATION_IDENTITY, assigned(old, 'MIGRATION_IDENTITY'))

    def test_five_preserved_services_and_historical_authority_are_unchanged(self):
        self.assertEqual(self.core.UPDATED, ('api', 'admin'))
        self.assertEqual(set(self.core.PRESERVED), {'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration'})
        old = subprocess.check_output(['git', 'show', '42e8eab5:scripts/production-release/unpublished-component-successor.py'], cwd=ROOT)
        self.assertEqual(self.core.SERVICES, assigned(old, 'SERVICES'))
        self.assertEqual(self.core.BASELINE_CONTRACT, assigned(old, 'BASELINE_CONTRACT'))
        reader = load('unpublished-component-successor-readonly.py')
        old_reader = subprocess.check_output(['git', 'show', '42e8eab5:scripts/production-release/unpublished-component-successor-readonly.py'], cwd=ROOT)
        self.assertEqual(reader.NATIVE_RESTART_AUTHORITY, assigned(old_reader, 'NATIVE_RESTART_AUTHORITY'))

    def test_original_source_guard_rejects_both_api_and_admin_rollback_inputs(self):
        current = dict(self.candidate)
        for name in self.core.HELPERS:
            path = HERE / name
            current['scripts/production-release/' + name] = (path.read_bytes(), '100755' if path.stat().st_mode & 0o111 else '100644')
        # A future control commit retains the sealed application archive while
        # owning its new helpers. Parse genuine tar bytes with the real reader.
        producer = self.core.producer('a' * 40, self.projection.source_tree(current), '12', '1')
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as archive:
            for name, (raw, mode) in current.items():
                item = tarfile.TarInfo('id-business-system-' + producer['commit'] + '/' + name)
                item.size, item.mode = len(raw), 0o755 if mode == '100755' else 0o644
                archive.addfile(item, io.BytesIO(raw))
        encoded = buffer.getvalue()
        d = self.core.modules()[0]
        d.registration_download = lambda commit: encoded if commit == producer['commit'] else subprocess.check_output(
            ['git', 'archive', '--format=tar', '--prefix=id-business-system-' + commit + '/', commit], cwd=ROOT)
        files, output, record, application_sha, archive_sha = self.core.source(d, producer)
        self.assertEqual(files, current)
        self.assertEqual(application_sha, self.core.APPROVED_APPLICATION_INPUT_SHA256)
        self.assertEqual(archive_sha, hashlib.sha256(encoded).hexdigest())
        self.assertEqual(record['candidateTree'], producer['sourceTree'])
        self.assertEqual(output['apps/admin/src/v2/components/workspace/V2WorkspaceDock.vue'], current['apps/admin/src/v2/components/workspace/V2WorkspaceDock.vue'])
        for path, old in (
            ('apps/api/src/id-business-v2/auto-recharge/recharge.service.ts', self.old_api),
            ('apps/admin/src/v2/styles/base.css', self.old_admin),
        ):
            with self.subTest(path=path):
                rollback = {**current, path: old[path]}
                producer = self.core.producer('a' * 40, self.projection.source_tree(rollback), '12', '1')
                d = SimpleNamespace(registration_download=lambda _commit: b'offline-archive-fixture',
                                    registration_archive=lambda _raw, _commit: rollback)
                with self.assertRaisesRegex(RuntimeError, 'APPLICATION_INPUTS_NOT_SEALED'):
                    self.core.source(d, producer)


if __name__ == '__main__':
    unittest.main()
