"""Synthetic directory metadata fixtures; all chown calls mocked, no production."""
from pathlib import Path
import ast
import importlib.util
import json
import os
import stat
import tempfile
import types
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).with_name('online-recharge-backup-parent-owner-repair.py')
spec = importlib.util.spec_from_file_location('backup_owner_core_test', SOURCE)
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
OUTPUT = SOURCE.parents[2] / '.runtime/online-recharge-release-20261009/build/consolidated-online-after-bit-preparation-20261010/backup-parent-owner-core-tests/isolated-fixtures'


class RepairTests(unittest.TestCase):
    def setUp(self):
        OUTPUT.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='owner-core-', dir=OUTPUT)
        self.base = Path(self.temporary.name)
        self.backups = self.base / 'backups'; self.backups.mkdir(mode=0o700)
        self.child = self.backups / 'mysql'; self.child.mkdir(mode=0o700)
        self.content = self.child / 'synthetic.sql.gz'
        self.content.write_bytes(b'synthetic unchanged original bytes')
        self.content.chmod(0o600)
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        self.parent_fd = os.open(self.base, flags)
        self.backups_fd = os.open(self.backups, flags)
        self.real_uid = os.geteuid()
        self.original_fstat, self.original_stat = os.fstat, os.stat
        self.target_values = {'st_uid': self.real_uid}
        self.visible_values, self.parent_values = {}, {}
        self.chown_calls, self.guard_calls = [], []
        self.guard_effect, self.chown_effect = None, None
        def virtual(row, overrides):
            names = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink',
                     'st_size', 'st_mtime_ns', 'st_ctime_ns')
            return types.SimpleNamespace(**{**{name: getattr(row, name) for name in names}, **overrides})
        def fstat(fd):
            row = self.original_fstat(fd)
            if fd == self.backups_fd:
                return virtual(row, self.target_values)
            if fd == self.parent_fd:
                return virtual(row, self.parent_values)
            return row
        def visible(name, *args, **kwargs):
            row = self.original_stat(name, *args, **kwargs)
            if name == 'backups' and kwargs.get('dir_fd') == self.parent_fd:
                self.assertIs(kwargs.get('follow_symlinks'), False)
                return virtual(row, {**self.target_values, **self.visible_values})
            return row
        def fchown(fd, uid, gid):
            self.chown_calls.append((fd, uid, gid))
            self.assertEqual((fd, uid, gid), (self.backups_fd, 0, -1))
            if self.chown_effect:
                return self.chown_effect()
            self.target_values['st_uid'] = self.real_uid
        self.stack = [patch.object(core, '_root_identity', lambda: True),
                      patch.object(core, '_uid', lambda: self.real_uid),
                      patch.object(core.os, 'fstat', fstat),
                      patch.object(core.os, 'stat', visible),
                      patch.object(core.os, 'fchown', fchown)]
        for item in self.stack:
            item.start()

    def tearDown(self):
        for item in reversed(self.stack):
            item.stop()
        os.close(self.backups_fd); os.close(self.parent_fd)
        self.temporary.cleanup()

    def guard(self):
        self.guard_calls.append(1)
        if self.guard_effect:
            self.guard_effect(len(self.guard_calls))

    def run_repair(self):
        # Bound methods are not accepted by production; the pinned transport
        # supplies an ordinary closure with its own immutable source binding.
        def guard():
            self.guard()
        value = core.repair(self.parent_fd, self.backups_fd, guard=guard)
        self.assertEqual(set(value), core.FIELDS)
        self.assertIn(value['status'], core.STATUSES)
        self.assertIn(value['code'], core.CODES)
        self.assertIn(value['localStateBefore'], core.LOCAL_STATES)
        self.assertIn(value['localStateAfter'], core.LOCAL_STATES)
        self.assertEqual(value['kind'], 'BACKUP_PARENT_OWNER_REPAIR_V1')
        self.assertEqual(value['mode'], 'repair_owner')
        self.assertFalse(value['installed'])
        self.assertTrue(value['rawOutputSuppressed'])
        return value

    def nonroot(self):
        self.target_values['st_uid'] = self.real_uid + 10001

    def test_root_owner_no_change_still_rechecks_three_guards(self):
        value = self.run_repair()
        self.assertEqual(value['status'], 'NO_CHANGE')
        self.assertEqual(value['localStateBefore'], 'MATCH')
        self.assertEqual(value['localStateAfter'], 'MATCH')
        self.assertFalse(value['mutationAttempted'])
        self.assertEqual(self.chown_calls, [])
        self.assertEqual(len(self.guard_calls), 3)

    def test_nonroot_owner_repaired_only_held_fd(self):
        self.nonroot()
        original_gid = self.original_fstat(self.backups_fd).st_gid
        original_mode = self.original_fstat(self.backups_fd).st_mode
        original_inode = self.original_fstat(self.backups_fd).st_ino
        value = self.run_repair()
        self.assertEqual(value['status'], 'REPAIRED')
        self.assertEqual(value['localStateBefore'], 'OWNER')
        self.assertEqual(value['localStateAfter'], 'MATCH')
        self.assertTrue(value['mutationAttempted'])
        self.assertEqual(len(self.chown_calls), 1)
        after = self.original_fstat(self.backups_fd)
        self.assertEqual((after.st_gid, after.st_mode, after.st_ino),
                         (original_gid, original_mode, original_inode))

    def test_initial_public_write_refused(self):
        self.nonroot()
        self.target_values['st_mode'] = stat.S_IFDIR | 0o722
        value = self.run_repair()
        self.assertEqual(value['code'], 'PUBLIC_WRITABLE')
        self.assertEqual(self.chown_calls, [])

    def test_initial_special_bits_refused_without_chmod(self):
        for special in (0o1000, 0o2000, 0o4000):
            with self.subTest(special=special):
                self.target_values['st_mode'] = stat.S_IFDIR | 0o700 | special
                value = self.run_repair()
                self.assertEqual(value['code'], 'SPECIAL_MODE')
                self.assertFalse(value['mutationAttempted'])
        self.assertEqual(self.chown_calls, [])

    def test_visible_symlink_refused(self):
        self.visible_values['st_mode'] = stat.S_IFLNK | 0o777
        value = self.run_repair()
        self.assertEqual(value['code'], 'LINK')
        self.assertEqual(self.chown_calls, [])

    def test_nondirectory_refused(self):
        self.target_values['st_mode'] = stat.S_IFREG | 0o600
        value = self.run_repair()
        self.assertEqual(value['code'], 'NON_DIRECTORY')

    def test_initial_visible_inode_must_match_held_fd(self):
        self.visible_values['st_ino'] = self.original_fstat(self.backups_fd).st_ino + 1
        value = self.run_repair()
        self.assertEqual(value['code'], 'INODE_CHANGED')
        self.assertEqual(self.chown_calls, [])

    def test_metadata_change_in_each_before_guard_rejected(self):
        cases = (('st_uid', self.real_uid + 20002, 'UID_CHANGED'),
                 ('st_gid', self.original_fstat(self.backups_fd).st_gid + 1, 'GID_CHANGED'),
                 ('st_mode', stat.S_IFDIR | 0o500, 'MODE_CHANGED'),
                 ('st_ino', self.original_fstat(self.backups_fd).st_ino + 1, 'INODE_CHANGED'))
        for point in (1, 2):
            for field, changed, code in cases:
                with self.subTest(point=point, field=field):
                    self.target_values = {'st_uid': self.real_uid + 10001}
                    self.guard_calls.clear(); self.chown_calls.clear()
                    def effect(n):
                        if n == point:
                            self.target_values[field] = changed
                    self.guard_effect = effect
                    value = self.run_repair()
                    self.assertEqual(value['code'], code)
                    self.assertEqual(value['status'], 'FAILED')
                    self.assertFalse(value['mutationAttempted'])
                    self.assertEqual(self.chown_calls, [])

    def test_first_and_second_guard_failure_prevent_mutation(self):
        self.nonroot()
        for point in (1, 2):
            with self.subTest(point=point):
                self.guard_calls.clear()
                def effect(n):
                    if n == point:
                        raise RuntimeError('fixture private exception never emitted')
                self.guard_effect = effect
                value = self.run_repair()
                self.assertEqual(value['code'], 'GUARD_FAILED')
                self.assertEqual(value['status'], 'FAILED')
                self.assertFalse(value['mutationAttempted'])
        self.assertEqual(self.chown_calls, [])

    def test_post_guard_failure_preserves_attempt_flag_without_rollback(self):
        self.nonroot()
        def effect(n):
            if n == 3:
                raise RuntimeError('fixture private exception never emitted')
        self.guard_effect = effect
        value = self.run_repair()
        self.assertEqual(value['code'], 'GUARD_FAILED')
        self.assertEqual(value['status'], 'FAILED_MUTATED_UNVERIFIED')
        self.assertTrue(value['mutationAttempted'])
        self.assertEqual(len(self.chown_calls), 1)
        self.assertNotIn('fixture private', json.dumps(value))

    def test_fchown_oserror_even_before_change_is_unverified(self):
        self.nonroot()
        def failed():
            raise OSError('fixture private OS error')
        self.chown_effect = failed
        value = self.run_repair()
        self.assertEqual(value['status'], 'FAILED_MUTATED_UNVERIFIED')
        self.assertEqual(value['code'], 'FCHOWN_FAILED')
        self.assertTrue(value['mutationAttempted'])
        self.assertEqual(len(self.chown_calls), 1)
        self.assertNotIn('fixture private', json.dumps(value))

    def test_partial_mutation_oserror_never_rolls_back(self):
        self.nonroot()
        def partial():
            self.target_values['st_uid'] = self.real_uid
            raise OSError('fixture private partial error')
        self.chown_effect = partial
        value = self.run_repair()
        self.assertEqual(value['status'], 'FAILED_MUTATED_UNVERIFIED')
        self.assertEqual(value['code'], 'FCHOWN_FAILED')
        self.assertEqual(len(self.chown_calls), 1)

    def test_wrong_metadata_after_fchown_is_unverified(self):
        cases = (('st_uid', self.real_uid + 1, 'UID_CHANGED'),
                 ('st_gid', self.original_fstat(self.backups_fd).st_gid + 1, 'GID_CHANGED'),
                 ('st_mode', stat.S_IFDIR | 0o500, 'MODE_CHANGED'),
                 ('st_ino', self.original_fstat(self.backups_fd).st_ino + 1, 'INODE_CHANGED'))
        for field, changed, code in cases:
            with self.subTest(field=field):
                self.target_values = {'st_uid': self.real_uid + 10001}
                self.chown_calls.clear()
                def effect():
                    self.target_values['st_uid'] = self.real_uid
                    self.target_values[field] = changed
                self.chown_effect = effect
                value = self.run_repair()
                self.assertEqual(value['status'], 'FAILED_MUTATED_UNVERIFIED')
                self.assertEqual(value['code'], code)
                self.assertTrue(value['mutationAttempted'])
                self.assertEqual(len(self.chown_calls), 1)

    def test_replaced_visible_directory_during_guard_is_not_touched(self):
        self.nonroot()
        def effect(n):
            if n == 2:
                self.visible_values['st_ino'] = self.original_fstat(self.backups_fd).st_ino + 1
        self.guard_effect = effect
        value = self.run_repair()
        self.assertEqual(value['code'], 'INODE_CHANGED')
        self.assertFalse(value['mutationAttempted'])

    def test_parent_metadata_change_before_mutation_is_rejected(self):
        self.nonroot()
        def effect(n):
            if n == 1:
                self.parent_values['st_gid'] = self.original_fstat(self.parent_fd).st_gid + 1
        self.guard_effect = effect
        value = self.run_repair()
        self.assertEqual(value['code'], 'ANCESTOR_CHANGED')
        self.assertFalse(value['mutationAttempted'])

    def test_root_required_and_invalid_scope(self):
        with patch.object(core, '_root_identity', lambda: False):
            self.assertEqual(self.run_repair()['code'], 'ROOT_REQUIRED')
        for first, second, callback in ((True, self.backups_fd, lambda: None),
                                        (self.parent_fd, self.parent_fd, lambda: None),
                                        (self.parent_fd, self.backups_fd, None),
                                        (self.parent_fd, self.backups_fd, self.guard)):
            value = core.repair(first, second, guard=callback)
            self.assertEqual(value['code'], 'SCOPE_INVALID')
            self.assertFalse(value['mutationAttempted'])

    def test_child_contents_and_metadata_never_read_or_changed_by_core(self):
        self.nonroot()
        original_bytes = self.content.read_bytes()
        before = self.original_stat(self.content)
        denied = ('open', 'listdir', 'scandir', 'read', 'write', 'fchmod', 'chmod', 'chown', 'walk')
        patches = [patch.object(core.os, name, side_effect=AssertionError('child access or extra mutation')) for name in denied]
        try:
            for item in patches:
                item.start()
            value = self.run_repair()
        finally:
            for item in reversed(patches):
                item.stop()
        self.assertEqual(value['status'], 'REPAIRED')
        self.assertEqual(self.content.read_bytes(), original_bytes)
        after = self.original_stat(self.content)
        self.assertEqual((after.st_ino, after.st_uid, after.st_gid, after.st_mode, after.st_size, after.st_mtime_ns),
                         (before.st_ino, before.st_uid, before.st_gid, before.st_mode, before.st_size, before.st_mtime_ns))

    def test_receipt_has_only_fixed_enums_and_booleans_no_owner_values(self):
        self.nonroot(); value = self.run_repair()
        self.assertTrue(all(type(item) in (str, bool) for item in value.values()))
        self.assertNotIn('uid', value); self.assertNotIn('gid', value)
        self.assertNotIn('directory', value); self.assertNotIn('modeBefore', value)

    def test_post_guard_baseexception_is_also_unverified(self):
        self.nonroot()
        def effect(n):
            if n == 3:
                raise SystemExit('fixture private exit')
        self.guard_effect = effect
        value = self.run_repair()
        self.assertEqual(value['status'], 'FAILED_MUTATED_UNVERIFIED')
        self.assertEqual(value['code'], 'GUARD_FAILED')
        self.assertTrue(value['mutationAttempted'])

    def test_only_mutation_ast_is_fixed_fchown(self):
        tree = ast.parse(SOURCE.read_bytes())
        mutations = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                     and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name)
                     and node.func.value.id == 'os' and node.func.attr in ('fchown', 'chown', 'chmod', 'fchmod', 'open', 'read', 'write')]
        self.assertEqual(len(mutations), 1)
        call = mutations[0]
        self.assertEqual(call.func.attr, 'fchown')
        self.assertIsInstance(call.args[0], ast.Name)
        self.assertEqual(call.args[0].id, 'backups_fd')
        self.assertEqual(ast.literal_eval(call.args[1]), 0)
        self.assertEqual(ast.literal_eval(call.args[2]), -1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
