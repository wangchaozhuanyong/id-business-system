"""Local synthetic fixtures; no host backup, S3, database or production calls."""
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import time
import types
import unittest
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parent.parent
OUTPUT = PROJECT / '.runtime/backup-retention-protection-20261011'
SOURCE = PROJECT / 'scripts/backup-retention-protection.py'
M = types.ModuleType('backup_retention_fixture')
exec(compile(SOURCE.read_bytes(), str(SOURCE), 'exec'), M.__dict__)


class FixtureAuthority(M.Authority):
    """Begin the held walk at this user's private fixture root on macOS/Linux.

    Production still walks root-owned ancestors from '/'. The fixture does
    not assert those host ancestors are production authorities.
    """
    def __init__(self):
        self.fds, self.directories, self.files, self.absent = [], [], [], []
        try:
            self.base = os.open(M.BASE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            self.fds.append(self.base)
            M.trusted_directory(os.fstat(self.base))
            self.releases = self.child(self.base, 'releases')
            self.backups = self.child(self.child(self.base, 'backups'), 'mysql')
            self.current, self.current_anchor = self.current_read()
        except BaseException:
            self.close()
            raise


class RetentionTests(unittest.TestCase):
    def setUp(self):
        OUTPUT.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='fixture-', dir=OUTPUT)
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.releases = self.base / 'releases'
        self.mysql = self.base / 'backups/mysql'
        self.releases.mkdir(mode=0o700)
        self.mysql.mkdir(parents=True, mode=0o700)
        self.write(self.mysql / '.backup.lock', b'')
        self.write(self.base / '.deploy.lock', b'')
        self.now = time.time()
        self.history_backup = (self.name(1), self.name(2))
        history = []
        for index, (commit, unused, status, step) in enumerate(M.HISTORY):
            directory = self.releases / ('20261009T01000' + str(index) + 'Z-' + commit[:12])
            directory.mkdir(mode=0o700)
            failure = {'candidateCommit': commit, 'previousCommit': M.BASELINE,
                'status': status, 'step': step, 'rollbackOk': True,
                'currentPointsToCandidate': False, 'receiptPersisted': True}
            self.document(directory / 'online-recharge-failure.json', failure)
            self.document(directory / 'backup-verification.json', self.receipt(self.history_backup[index]))
            digest = hashlib.sha256(json.dumps(failure, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            history.append((commit, digest, status, step))
            if index == 1:
                self.document(directory / 'release-manifest.json', {'commit': commit,
                    'previousCommit': M.BASELINE, 'backupBeforeRelease': self.history_backup[index]})
        self.previous = self.release('20261009T020000Z-111111111111', self.name(3))
        self.current = self.release('20261009T030000Z-222222222222', self.name(4),
                                    previous=self.previous)
        (self.base / 'current').symlink_to(self.current)
        for key, value in (('BASE', self.base), ('ROOT_UID', os.geteuid()),
                           ('HISTORY', tuple(history)), ('Authority', FixtureAuthority)):
            control = patch.object(M, key, value)
            control.start()
            self.addCleanup(control.stop)

    def write(self, path, raw):
        path.write_bytes(raw)
        path.chmod(0o600)

    def document(self, path, value):
        self.write(path, json.dumps(value).encode())

    def name(self, index):
        return 'id-business-v2-20261001T' + str(index).zfill(6) + 'Z.sql.gz'

    def receipt(self, name):
        return {'name': name, 'size': 1, 'sha256': 'a' * 64, 's3Verified': True}

    def release(self, name, backup, previous=None):
        directory = self.releases / name
        directory.mkdir(mode=0o700)
        self.document(directory / 'backup-verification.json', self.receipt(backup))
        manifest = {'backupBeforeRelease': backup}
        if previous is not None:
            manifest['previousRelease'] = str(previous)
        self.document(directory / 'release-manifest.json', manifest)
        return directory

    def backup(self, index, size=1):
        path = self.mysql / self.name(index)
        with path.open('wb') as stream:
            stream.truncate(size)
        path.chmod(0o600)
        return path

    def names(self):
        return sorted(path.name for path in self.mysql.iterdir() if M.BACKUP_NAME.fullmatch(path.name))

    def reject(self, code, count=48, capacity=67108864):
        before = self.names()
        with self.assertRaises(M.Rejected) as error:
            M.prune(count, capacity, apply=True)
        self.assertEqual(error.exception.args, (code,))
        self.assertEqual(self.names(), before)

    def active(self, index=0, age=5):
        stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime(self.now - age - index))
        directory = self.releases / (stamp + '-' + str(index + 3) * 12)
        directory.mkdir(mode=0o700)
        self.document(directory / 'backup-verification.json', self.receipt(self.name(5 + index)))
        return directory

    def deployment_lock(self):
        fd = os.open(self.base / '.deploy.lock', os.O_RDWR)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd

    def test_count_prunes_only_oldest_unprotected_and_keeps_latest(self):
        for index in range(1, 9):
            self.backup(index)
        result = M.prune(5, 67108864, apply=True)
        self.assertEqual(self.names(), [self.name(index) for index in (1, 2, 3, 4, 8)])
        self.assertEqual((result['removedCount'], result['countAfter']), (3, 5))

    def test_capacity_prunes_only_unprotected_and_counts_pinned_bytes(self):
        for index in range(1, 9):
            self.backup(index, 12 * 1024**2)
        result = M.prune(48, 64 * 1024**2, apply=True)
        self.assertEqual(self.names(), [self.name(index) for index in (1, 2, 3, 4, 8)])
        self.assertEqual(result['retainedBytes'], 60 * 1024**2)

    def test_missing_history_and_current_references_remain_protected(self):
        for index in range(5, 9):
            self.backup(index)
        result = M.prune(2, 67108864, apply=True)
        self.assertEqual(result['protectedCount'], 4)
        self.assertEqual(self.names(), [self.name(7), self.name(8)])

    def test_unsatisfiable_count_fails_before_any_delete(self):
        for index in range(1, 9):
            self.backup(index)
        self.reject('LIMIT_UNSATISFIABLE', count=4)

    def test_unsatisfiable_capacity_fails_before_any_delete(self):
        for index in range(1, 9):
            self.backup(index, 20 * 1024**2)
        self.reject('LIMIT_UNSATISFIABLE')

    def test_plan_does_not_delete(self):
        for index in range(1, 9):
            self.backup(index)
        result = M.prune(5, 67108864)
        self.assertEqual(result['status'], 'PLAN_ONLY')
        self.assertEqual(result['candidateCount'], 3)
        self.assertEqual(len(self.names()), 8)

    def test_original_backup_glob_still_counts_unreferenced_old_names(self):
        for index in range(1, 9):
            self.backup(index)
        old = self.mysql / 'id-business-v2-000old.sql.gz'
        self.write(old, b'old')
        untouched = self.mysql / 'other.sql.gz'
        self.write(untouched, b'other')
        result = M.prune(5, 67108864, apply=True)
        self.assertEqual((result['countBefore'], result['removedCount']), (9, 4))
        self.assertFalse(old.exists())
        self.assertTrue(untouched.exists())

    def test_bad_receipt_and_disagreement_fail_before_delete(self):
        for index in range(5, 9):
            self.backup(index)
        original = (self.current / 'backup-verification.json').read_bytes()
        for field, value in (('name', '../bad.sql.gz'), ('name', None), ('size', True),
                             ('sha256', 'bad'), ('s3Verified', False)):
            with self.subTest(field=field, value=value):
                altered = self.receipt(self.name(4))
                altered[field] = value
                self.document(self.current / 'backup-verification.json', altered)
                self.reject('REFERENCE_INVALID', count=2)
        self.write(self.current / 'backup-verification.json', original)
        self.document(self.current / 'release-manifest.json', {'backupBeforeRelease': self.name(99)})
        self.reject('REFERENCE_INVALID', count=2)

    def test_duplicate_and_nonfinite_json_fail_before_delete(self):
        for raw in (b'{"backupBeforeRelease":"x","backupBeforeRelease":"y"}',
                    b'{"backupBeforeRelease":NaN}', b'[]', b'not-json'):
            with self.subTest(raw=raw):
                self.write(self.current / 'release-manifest.json', raw)
                self.reject('REFERENCE_INVALID', count=2)

    def test_history_binding_change_fails_before_delete(self):
        commit = M.HISTORY[0][0]
        directory = next(path for path in self.releases.iterdir() if path.name.endswith(commit[:12]))
        value = json.loads((directory / 'online-recharge-failure.json').read_bytes())
        value['rollbackOk'] = False
        self.document(directory / 'online-recharge-failure.json', value)
        self.reject('REFERENCE_INVALID')

    def test_previous_path_outside_release_is_rejected(self):
        self.document(self.current / 'release-manifest.json', {'backupBeforeRelease': self.name(4),
                      'previousRelease': str(self.base / 'elsewhere')})
        self.reject('REFERENCE_INVALID')

    def test_previous_canonical_component_does_not_gain_timestamp_requirement(self):
        retained = self.releases / 'retained-previous'
        self.previous.rename(retained)
        self.document(self.current / 'release-manifest.json', {'backupBeforeRelease': self.name(4),
                      'previousRelease': str(retained)})
        self.assertEqual(M.prune(48, 67108864)['protectedCount'], 4)
        for suffix in ('../outside', 'bad\x00name', 'bad\ud800name', 'x' * 256):
            with self.subTest(suffix=suffix):
                self.document(self.current / 'release-manifest.json', {'backupBeforeRelease': self.name(4),
                              'previousRelease': str(self.releases) + '/' + suffix})
                self.reject('REFERENCE_INVALID')

    def test_active_receipt_requires_lock_fresh_private_unended_unique_directory(self):
        self.active()
        self.deployment_lock()
        for index in range(1, 9):
            self.backup(index)
        result = M.prune(6, 67108864, apply=True)
        self.assertEqual(result['protectedCount'], 5)
        self.assertEqual(self.names(), [self.name(index) for index in (1, 2, 3, 4, 5, 8)])

    def test_manifest_written_before_switch_keeps_exact_live_backup_protected(self):
        active = self.active()
        self.document(active / 'release-manifest.json', {'commit': '3' * 40,
                      'previousRelease': str(self.current), 'backupBeforeRelease': self.name(5)})
        self.deployment_lock()
        for index in range(1, 9):
            self.backup(index)
        result = M.prune(6, 67108864, apply=True)
        self.assertEqual(result['protectedCount'], 5)
        self.assertEqual(self.names(), [self.name(index) for index in (1, 2, 3, 4, 5, 8)])

    def test_transition_manifest_commit_and_backup_must_match_before_deletion(self):
        active = self.active()
        self.deployment_lock()
        for index in range(1, 9):
            self.backup(index)
        good = {'commit': '3' * 40, 'previousRelease': str(self.current),
                'backupBeforeRelease': self.name(5)}
        for field, value in (('commit', '4' * 40), ('commit', None),
                             ('backupBeforeRelease', self.name(6)), ('backupBeforeRelease', None)):
            with self.subTest(field=field, value=value):
                self.document(active / 'release-manifest.json', {**good, field: value})
                self.reject('REFERENCE_INVALID', count=6)

    def test_finished_manifest_not_pointing_to_current_never_pins(self):
        active = self.active()
        self.document(active / 'release-manifest.json', {'commit': '3' * 40,
                      'previousRelease': str(self.previous), 'backupBeforeRelease': self.name(5)})
        self.write(active / 'backup-verification.json', b'unrelated-ended-receipt')
        self.deployment_lock()
        for index in range(1, 9):
            self.backup(index)
        result = M.prune(5, 67108864, apply=True)
        self.assertEqual(result['protectedCount'], 4)
        self.assertNotIn(self.name(5), self.names())

    def test_transition_manifest_does_not_override_failure_lock_or_freshness(self):
        active = self.active()
        self.document(active / 'release-manifest.json', {'commit': '3' * 40,
                      'previousRelease': str(self.current), 'backupBeforeRelease': self.name(5)})
        self.assertEqual(M.prune(48, 67108864)['protectedCount'], 4)
        self.deployment_lock()
        self.document(active / 'api-workspace-failure.json', {'status': 'ended'})
        self.assertEqual(M.prune(48, 67108864)['protectedCount'], 4)
        (active / 'api-workspace-failure.json').unlink()
        os.utime(active / 'backup-verification.json', (self.now - 4000, self.now - 4000))
        self.reject('REFERENCE_INVALID')

    def test_unlocked_ended_and_stale_directories_do_not_pin(self):
        active = self.active()
        for index in range(1, 9):
            self.backup(index)
        self.assertEqual(M.prune(5, 67108864)['protectedCount'], 4)
        self.deployment_lock()
        self.document(active / 'api-workspace-failure.json', {'status': 'ended'})
        self.assertEqual(M.prune(5, 67108864)['protectedCount'], 4)
        (active / 'api-workspace-failure.json').unlink()
        (active / 'backup-verification.json').touch()
        old = self.active(index=1, age=3700)
        self.document(active / 'release-manifest.json', {'backupBeforeRelease': self.name(5)})
        self.assertEqual(M.prune(5, 67108864)['protectedCount'], 4)
        self.assertTrue(old.exists())

    def test_multiple_active_sources_fail_before_deletion(self):
        self.active()
        self.active(index=1)
        self.deployment_lock()
        self.reject('ACTIVE_AMBIGUOUS')

    def test_bad_active_reference_fails_before_deletion(self):
        active = self.active()
        self.document(active / 'backup-verification.json', self.receipt('../bad.sql.gz'))
        self.deployment_lock()
        self.reject('REFERENCE_INVALID')

    def test_active_directory_and_receipt_freshness_are_checked_before_deletion(self):
        active = self.active()
        self.deployment_lock()
        active.chmod(0o750)
        self.reject('REFERENCE_INVALID')
        active.chmod(0o700)
        os.utime(active / 'backup-verification.json', (self.now - 4000, self.now - 4000))
        self.reject('REFERENCE_INVALID')
        os.utime(active / 'backup-verification.json', (self.now + 60, self.now + 60))
        self.reject('REFERENCE_INVALID')

    def test_unreferenced_finished_history_does_not_pin_or_require_its_receipt(self):
        finished = self.release('20261009T040000Z-ffffffffffff', self.name(5))
        self.write(finished / 'backup-verification.json', b'private-unrelated-ended-document')
        self.deployment_lock()
        for index in range(1, 9):
            self.backup(index)
        result = M.prune(5, 67108864, apply=True)
        self.assertEqual(result['protectedCount'], 4)
        self.assertNotIn(self.name(5), self.names())

    def test_symlink_metadata_and_symlink_backup_are_never_followed(self):
        target = self.current / 'backup-verification.json'
        target.rename(self.current / 'receipt-original.json')
        target.symlink_to(self.current / 'receipt-original.json')
        self.reject('REFERENCE_INVALID')
        target.unlink()
        (self.current / 'receipt-original.json').rename(target)
        self.backup(8)
        (self.mysql / self.name(6)).symlink_to(self.mysql / self.name(8))
        self.reject('REFERENCE_INVALID')

    def test_replaced_reference_after_plan_refuses_delete(self):
        for index in range(1, 9):
            self.backup(index)
        original = M.Authority.check
        calls = 0
        def changing(authority):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.document(self.current / 'release-manifest.json', {'backupBeforeRelease': self.name(88)})
            return original(authority)
        with patch.object(M.Authority, 'check', changing):
            self.reject('AUTHORITY_CHANGED', count=5)

    def test_new_backup_after_plan_refuses_delete(self):
        for index in range(1, 9):
            self.backup(index)
        original = M.Authority.check
        calls = 0
        def changing(authority):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.backup(9)
            return original(authority)
        with patch.object(M.Authority, 'check', changing):
            with self.assertRaises(M.Rejected) as error:
                M.prune(5, 67108864, apply=True)
        self.assertEqual(error.exception.args, ('AUTHORITY_CHANGED',))
        self.assertEqual(error.exception.removed_count, 0)
        self.assertEqual(len(self.names()), 9)

    def test_delete_failure_records_exact_partial_count_without_raw_exception(self):
        for index in range(1, 9):
            self.backup(index)
        original = os.unlink
        calls = 0
        def failing(name, *, dir_fd=None):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError('fixture-only private unknown detail')
            return original(name, dir_fd=dir_fd)
        with patch.object(M.os, 'unlink', failing):
            with self.assertRaises(M.Rejected) as error:
                M.prune(5, 67108864, apply=True)
        self.assertEqual(error.exception.args, ('IO_FAILURE',))
        self.assertEqual(error.exception.removed_count, 1)
        self.assertEqual(self.names(), [self.name(index) for index in (1, 2, 3, 4, 6, 7, 8)])

    def test_file_owner_mode_and_hardlink_rejections_precede_deletion(self):
        self.backup(5)
        self.backup(8)
        (self.mysql / self.name(5)).chmod(0o622)
        self.reject('REFERENCE_INVALID', count=2)
        (self.mysql / self.name(5)).chmod(0o600)
        os.link(self.mysql / self.name(5), self.mysql / self.name(6))
        self.reject('REFERENCE_INVALID', count=2)
        fake = types.SimpleNamespace(st_mode=0o100600, st_uid=M.ROOT_UID + 1, st_nlink=1)
        with self.assertRaises(M.Rejected):
            M.trusted_file(fake)

    def test_cli_plan_and_failures_are_finite_without_paths_or_private_details(self):
        import sys
        arguments = ['backup-retention-protection.py', '--retention-count', '48',
                     '--max-bytes', '67108864']
        output = io.StringIO()
        with patch.object(sys, 'argv', arguments), patch.object(sys, 'stdout', output):
            self.assertEqual(M.main(), 0)
        value = json.loads(output.getvalue())
        self.assertEqual(set(value), {'kind', 'status', 'code', 'protectedCount', 'countBefore',
            'candidateCount', 'removedCount', 'countAfter', 'retainedBytes', 'rawOutputSuppressed'})
        self.assertEqual((value['status'], value['removedCount']), ('PLAN_ONLY', 0))
        for error, expected_code, removed in (
            (OSError(str(self.base) + '/fixture-private-detail'), 'IO_FAILURE', 0),
            (M.Rejected('AUTHORITY_CHANGED', 1), 'AUTHORITY_CHANGED', 1)):
            output = io.StringIO()
            with patch.object(sys, 'argv', arguments), patch.object(sys, 'stdout', output), \
                    patch.object(M, 'prune', side_effect=error):
                self.assertEqual(M.main(), 1)
            value = json.loads(output.getvalue())
            self.assertEqual(set(value), {'kind', 'status', 'code', 'removedCount', 'rawOutputSuppressed'})
            self.assertEqual(value['status'], 'FAILED_MUTATED_UNVERIFIED' if removed else 'FAILED')
            self.assertEqual((value['code'], value['removedCount']), (expected_code, removed))
            self.assertNotIn(str(self.base), output.getvalue())

    def test_existing_backup_lock_busy_and_wrong_inherited_fd_rejected(self):
        fd = os.open(self.mysql / '.backup.lock', os.O_RDWR)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.reject('LOCK_BUSY')
        result = M.prune(48, 67108864, backup_lock_fd=fd)
        self.assertEqual(result['code'], 'OK')
        wrong = os.open(self.base / '.deploy.lock', os.O_RDONLY)
        self.addCleanup(os.close, wrong)
        with self.assertRaises(M.Rejected) as error:
            M.prune(48, 67108864, backup_lock_fd=wrong)
        self.assertEqual(error.exception.args, ('LOCK_INVALID',))

    def test_script_keeps_current_inputs_and_resolves_local_helper(self):
        script = (PROJECT / 'scripts/backup-aws-mysql.sh').read_text()
        self.assertIn('deployment_directory="/opt/id-business-v2/current"', script)
        for value in ('environment_file="${deployment_directory}/.env.aws.production"',
                      'compose_file="${deployment_directory}/docker-compose.aws-mysql.yml"',
                      'normalizer_script="${deployment_directory}/scripts/mysql-dump-restore-normalizer.sed"',
                      'retention_script="${script_directory}/backup-retention-protection.py"',
                      '--backup-lock-fd 9', '--retention-count "${local_retention_count}"',
                      '--max-bytes "${local_max_bytes}"'):
            self.assertIn(value, script)
        self.assertEqual(script.count('\nprune_local_backups\n'), 2)


if __name__ == '__main__':
    unittest.main()
