import copy
import base64
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

DIRECTORY = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


disk = load('disk_policy', DIRECTORY / 'disk-retention.py')
cache = load('disk_legacy_cache', DIRECTORY / 'maintain-image-cache.py')
EXPECTED = 'a' * 40
PENDING = 'b' * 40 + '-900-1'
OLD = 'c' * 40 + '-800-1'
UNKNOWN = 'd' * 40 + '-850-1'


def policy():
    return {'kind': disk.KIND, 'version': 1, 'approved': False,
            'sourceSha256': 'e' * 64, 'maintainerSha256': 'f' * 64, 'candidateRegistrySha256': '1' * 64,
            'protectedCandidateBatches': [PENDING], 'supersededOnlineBatches': [OLD],
            'budgets': {'targetFreeBytes': 12 * 1024**3, 'cleanupThresholdBytes': 10 * 1024**3,
                        'criticalFreeBytes': 6 * 1024**3, 'projectArtifactsBytes': 4 * 1024**3,
                        'localBackupsBytes': 1024**3, 'systemLogsBytes': 1024**3}}


def image(number, batch, service='online-recharge'):
    return {'id': 'sha256:' + f'{number:064x}', 'repoTags': [cache.REPOSITORY + ':' + batch + '-' + service]}


class PlanningTests(unittest.TestCase):
    def setUp(self):
        self.policy = policy()
        self.rows = [image(n, PENDING, role) for n, role in enumerate(('admin', 'api', 'migrate', 'online-recharge'), 1)]
        self.rows += [image(5, OLD), image(6, UNKNOWN)]
        self.manifest = {'commit': EXPECTED, 'previousCommit': '9' * 40,
                         'deploymentRun': 'github-actions-1000-1', 'images': {}, 'rollback': {}}
        self.previous = {'commit': '9' * 40, 'images': {}}
        self.dependencies = {'version': 1, 'imageIds': [], 'serviceRollback': {}, 'evidenceSha256': {}}
        self.helper = SimpleNamespace(REPOSITORY=cache.REPOSITORY, make_plan=cache.make_plan,
            protected_images=cache.protected_images, current=Mock(return_value=(self.manifest, self.previous)),
            collect_dependencies=Mock(return_value=self.dependencies), active_images=Mock(return_value=set()),
            verify_remote=Mock(), read=Mock())

    def planned(self, rows=None):
        with patch.object(disk, 'manifest_digest', return_value='a' * 64):
            return disk.plan(self.policy, self.helper, EXPECTED, self.rows if rows is None else rows)

    def test_only_explicitly_superseded_online_batch_is_reclaimable(self):
        result = self.planned()
        self.assertEqual(result['candidateCount'], 1)
        self.assertEqual(result['corePlan']['items'][0]['imageId'], self.rows[4]['id'])
        self.assertIn(self.rows[5]['id'], result['corePlan']['protectedImageIds'])

    def test_pending_whole_batch_is_kept_including_api_admin_and_migrate(self):
        result = self.planned()
        self.assertTrue({x['id'] for x in self.rows[:4]} <= set(result['corePlan']['protectedImageIds']))

    def test_missing_component_rejects_before_any_deletion(self):
        for index in range(4):
            with self.subTest(index=index), self.assertRaisesRegex(RuntimeError, 'PENDING_BATCH_NOT_COMPLETE'):
                self.planned(self.rows[:index] + self.rows[index + 1:])
        self.helper.read.assert_not_called()

    def test_running_stopped_current_previous_and_dependencies_remain_protected(self):
        old = self.rows[4]['id']
        for field in ('container', 'current', 'previous', 'dependency', 'rollback'):
            with self.subTest(field=field):
                self.helper.active_images.return_value = {old} if field == 'container' else set()
                self.manifest['images'] = {'online-recharge': {'digest': old}} if field == 'current' else {}
                self.previous['images'] = {'online-recharge': {'digest': old}} if field == 'previous' else {}
                self.dependencies['imageIds'] = [old] if field == 'dependency' else []
                self.manifest['rollback'] = {'images': {'online-recharge': old}} if field == 'rollback' else {}
                self.assertEqual(self.planned()['candidateCount'], 0)

    def test_newer_build_held_even_if_mistakenly_listed_superseded(self):
        newer = 'd' * 40 + '-1001-1'; self.policy['supersededOnlineBatches'].append(newer)
        result = self.planned(self.rows + [image(7, newer)])
        self.assertNotIn(image(7, newer)['id'], [x['imageId'] for x in result['corePlan']['items']])

    def test_foreign_mixed_and_unrecognized_aliases_hold_whole_image(self):
        for alias in ('foreign:latest', cache.REPOSITORY + ':unknown'):
            rows = copy.deepcopy(self.rows); rows[4]['repoTags'].append(alias)
            self.assertEqual(self.planned(rows)['candidateCount'], 0)

    def test_shared_image_with_one_pending_alias_is_held_whole(self):
        rows = copy.deepcopy(self.rows); rows[4]['repoTags'].append(rows[3]['repoTags'][0])
        # Same immutable content under the pending tag must never be removed through an older alias.
        self.assertEqual(self.planned(rows)['candidateCount'], 0)

    def test_approval_flag_does_not_change_reviewed_rules_identity(self):
        before = disk.policy_digest(self.policy); self.policy['approved'] = True
        self.assertEqual(before, disk.policy_digest(self.policy))

    def test_invalid_policy_and_overlapping_or_multiple_pending_batches_reject(self):
        cases = []
        for key, value in [('version', True), ('approved', 'true'), ('sourceSha256', 'bad'),
                           ('protectedCandidateBatches', [PENDING, UNKNOWN]), ('supersededOnlineBatches', [PENDING])]:
            p = policy(); p[key] = value; cases.append(p)
        p = policy(); p['budgets']['localBackupsBytes'] = True; cases.append(p)
        p = policy(); p['budgets']['criticalFreeBytes'] = p['budgets']['targetFreeBytes']; cases.append(p)
        for p in cases:
            with self.assertRaises(RuntimeError): disk.validate_policy(p)

    def test_duplicate_json_keys_and_nonfinite_values_are_rejected(self):
        for raw in ('{"a":1,"a":2}', '{"a":NaN}'):
            with self.assertRaises(RuntimeError): disk.closed_json(raw)

    def apply_dynamic(self, fail_after=None, guard=None):
        self.policy['approved'] = True
        reviewed = self.planned(); removed = []; checkpoints = []
        live = copy.deepcopy(self.rows)
        def read(*args):
            if args[:3] == ('docker', 'image', 'inspect'):
                return next(x['id'] for x in live if args[-1] in x['repoTags'])
            if args[:3] == ('docker', 'image', 'rm'):
                if fail_after is not None and len(removed) >= fail_after: raise RuntimeError('MOCK_DELETE_FAILURE')
                row = next(x for x in live if args[-1] in x['repoTags']); row['repoTags'].remove(args[-1])
                if not row['repoTags']: live.remove(row)
                return ''
            raise AssertionError(args)
        self.helper.read.side_effect = read
        with patch.object(disk, 'manifest_digest', return_value='a' * 64), \
                patch.object(disk, 'inventory', side_effect=lambda unused: copy.deepcopy(live)):
            disk.apply(self.policy, self.helper, reviewed, disk.digest(reviewed), removed=removed,
                       checkpoint=lambda item, state: checkpoints.append((item['tag'], state)), guard=guard)
        return removed, checkpoints

    def test_exact_plan_and_ecr_verified_before_precise_nonforce_removal(self):
        removed, checkpoints = self.apply_dynamic()
        self.assertEqual(len(removed), 1)
        self.assertEqual([x[1] for x in checkpoints], ['ATTEMPTED_RESULT_UNCONFIRMED', 'REMOVED'])
        commands = [call.args for call in self.helper.read.call_args_list]
        self.assertIn(('docker', 'image', 'rm', '--no-prune', cache.REPOSITORY + ':' + OLD + '-online-recharge'), commands)
        self.assertEqual(self.helper.verify_remote.call_count, 2)

    def test_unapproved_policy_or_wrong_plan_hash_never_removes(self):
        reviewed = self.planned()
        for p, sha in ((self.policy, disk.digest(reviewed)), ({**self.policy, 'approved': True}, '0' * 64)):
            with self.assertRaisesRegex(RuntimeError, 'PLAN_NOT_APPROVED'):
                disk.apply(p, self.helper, reviewed, sha)
        self.helper.read.assert_not_called()

    def test_ecr_failure_keeps_all_images(self):
        self.helper.verify_remote.side_effect = RuntimeError('ECR_UNAVAILABLE')
        with self.assertRaisesRegex(RuntimeError, 'ECR_UNAVAILABLE'): self.apply_dynamic()
        self.helper.read.assert_not_called()

    def test_changed_config_guard_stops_before_remove(self):
        with self.assertRaisesRegex(RuntimeError, 'CONFIG_CHANGED'):
            self.apply_dynamic(guard=Mock(side_effect=RuntimeError('CONFIG_CHANGED')))
        self.helper.read.assert_not_called()

    def test_changed_pending_or_container_protection_stops_before_remove(self):
        reviewed = self.planned(); self.policy['approved'] = True
        self.helper.active_images.return_value = {self.rows[4]['id']}
        with patch.object(disk, 'inventory', return_value=self.rows), \
                patch.object(disk, 'manifest_digest', return_value='a' * 64), \
                self.assertRaisesRegex(RuntimeError, 'PLAN_CHANGED'):
            disk.apply(self.policy, self.helper, reviewed, disk.digest(reviewed))
        self.helper.read.assert_not_called()

    def test_failure_retains_confirmed_removal_prefix_and_last_intent(self):
        second = 'c' * 40 + '-801-1'
        self.policy['supersededOnlineBatches'].append(second); self.rows.append(image(7, second))
        self.policy['approved'] = True
        reviewed = self.planned(); removed = []; checkpoints = []; live = copy.deepcopy(self.rows)
        def read(*args):
            if args[:3] == ('docker', 'image', 'inspect'):
                return next(x['id'] for x in live if args[-1] in x['repoTags'])
            if args[:3] == ('docker', 'image', 'rm'):
                if removed: raise RuntimeError('MOCK_SECOND_REMOVE_FAILURE')
                live.remove(next(x for x in live if args[-1] in x['repoTags'])); return ''
            raise AssertionError(args)
        self.helper.read.side_effect = read
        with patch.object(disk, 'manifest_digest', return_value='a' * 64), \
                patch.object(disk, 'inventory', side_effect=lambda unused: copy.deepcopy(live)), \
                self.assertRaisesRegex(RuntimeError, 'MOCK_SECOND_REMOVE_FAILURE'):
            disk.apply(self.policy, self.helper, reviewed, disk.digest(reviewed), removed=removed,
                       checkpoint=lambda item, state: checkpoints.append((item['tag'], state)))
        self.assertEqual(removed, [OLD + '-online-recharge'])
        self.assertEqual(checkpoints[-1], (second + '-online-recharge', 'ATTEMPTED_RESULT_UNCONFIRMED'))

    def test_pending_batch_policy_change_stops_before_any_deletion(self):
        reviewed = self.planned(); self.policy['approved'] = True; self.policy['protectedCandidateBatches'] = []
        with patch.object(disk, 'manifest_digest', return_value='a' * 64), \
                patch.object(disk, 'inventory', return_value=self.rows), \
                self.assertRaisesRegex(RuntimeError, 'PLAN_CHANGED'):
            disk.apply(self.policy, self.helper, reviewed, disk.digest(reviewed))
        self.helper.read.assert_not_called()

    def test_free_space_bands_use_reserved_headroom_in_bytes(self):
        for size, status in ((5, 'CRITICAL'), (7, 'LOW'), (11, 'BELOW_TARGET'), (12, 'OK')):
            self.assertEqual(disk.free_space_status(size * 1024**3, self.policy['budgets']), status)


class CliSelectionTests(unittest.TestCase):
    def selected(self, **overrides):
        return SimpleNamespace(**{'scheduled': False, 'apply': False, 'phase': None,
                                  'approved_plan_sha256': None, 'event_base64': None, **overrides})

    def encoded(self, value):
        return base64.b64encode(json.dumps(value).encode()).decode()

    def test_plan_daily_explicit_apply_and_three_phases_remain_valid_without_mutating_args(self):
        pull = {'record': {}, 'supersedes': [], 'sourceArchiveBytes': 1}
        publication = {'record': {}}
        cases = [(self.selected(), None), (self.selected(scheduled=True), None),
                 (self.selected(apply=True, approved_plan_sha256='a' * 64), None),
                 (self.selected(phase='before-build'), None),
                 (self.selected(phase='before-build', event_base64=self.encoded(None)), None),
                 (self.selected(phase='before-pull', event_base64=self.encoded(pull)), pull),
                 (self.selected(phase='after-publish', event_base64=self.encoded(publication)), publication)]
        for args, event in cases:
            with self.subTest(args=vars(args)):
                original = copy.deepcopy((vars(args), event))
                disk.validate_cli_selection(args, event)
                self.assertEqual((vars(args), event), original)

    def test_scheduled_and_apply_cannot_override_explicit_plan_approval(self):
        args = self.selected(scheduled=True, apply=True, approved_plan_sha256='a' * 64)
        with self.assertRaisesRegex(RuntimeError, 'MODE_SELECTION_INVALID'):
            disk.validate_cli_selection(args, None)

    def test_release_phase_cannot_mix_with_daily_or_explicit_apply(self):
        for phase in ('before-build', 'before-pull', 'after-publish'):
            for mode in ('scheduled', 'apply'):
                args = self.selected(phase=phase, **{mode: True})
                with self.subTest(phase=phase, mode=mode), self.assertRaisesRegex(RuntimeError, 'PHASE_SELECTION_INVALID'):
                    disk.validate_cli_selection(args, None)

    def test_approval_hash_requires_explicit_apply(self):
        for phase, scheduled in ((None, False), (None, True), ('before-build', False),
                                 ('before-pull', False), ('after-publish', False)):
            args = self.selected(phase=phase, scheduled=scheduled, approved_plan_sha256='a' * 64)
            with self.subTest(phase=phase, scheduled=scheduled), self.assertRaisesRegex(RuntimeError, 'UNEXPECTED_PLAN_APPROVAL'):
                disk.validate_cli_selection(args, None)

    def test_explicit_apply_requires_an_exact_approval_hash(self):
        for approved in (None, '', 'a' * 63, 'A' * 64, True, 1):
            with self.subTest(approved=approved), self.assertRaisesRegex(RuntimeError, 'PLAN_APPROVAL_REQUIRED'):
                disk.validate_cli_selection(self.selected(apply=True, approved_plan_sha256=approved), None)

    def test_before_build_rejects_any_non_null_event(self):
        for event in ({}, {'record': {}}, [], 'event', False, 0):
            args = self.selected(phase='before-build', event_base64=self.encoded(event))
            with self.subTest(event=event), self.assertRaisesRegex(RuntimeError, 'EVENT_SELECTION_INVALID'):
                disk.validate_cli_selection(args, event)

    def test_pull_and_publication_require_nonempty_object_event_and_event_flag(self):
        for phase in ('before-pull', 'after-publish'):
            for event in (None, {}, [], 'event', False, 0):
                args = self.selected(phase=phase, event_base64=self.encoded(event))
                with self.subTest(phase=phase, event=event), self.assertRaisesRegex(RuntimeError, 'EVENT_SELECTION_INVALID'):
                    disk.validate_cli_selection(args, event)
            with self.assertRaisesRegex(RuntimeError, 'EVENT_SELECTION_INVALID'):
                disk.validate_cli_selection(self.selected(phase=phase), {'record': {}})

    def test_event_payload_is_bounded_and_only_allowed_with_release_phase(self):
        for phase, encoded in ((None, self.encoded(None)), ('before-build', ''),
                               ('before-build', 'a' * 24001), ('before-build', True)):
            args = self.selected(phase=phase, event_base64=encoded)
            with self.subTest(phase=phase, encoded=type(encoded)), self.assertRaisesRegex(RuntimeError, 'EVENT_SIZE_INVALID'):
                disk.validate_cli_selection(args, None)

    def test_unrecognized_phase_and_nonboolean_mode_flags_reject(self):
        for args in (self.selected(phase='cleanup'), self.selected(scheduled=1), self.selected(apply='true')):
            with self.assertRaisesRegex(RuntimeError, 'MODE_SELECTION_INVALID'):
                disk.validate_cli_selection(args, None)

    def test_invalid_modes_and_before_build_payload_reject_before_any_native_file_read(self):
        base = ['disk-retention.py', '--config', str(disk.INSTALL / 'config.json'),
                '--expected-source-sha256', 'f' * 64]
        cases = [(['--scheduled', '--apply', '--approved-plan-sha256', 'a' * 64], 'MODE_SELECTION_INVALID'),
                 (['--phase', 'before-build', '--event-base64', self.encoded({'record': {}})], 'EVENT_SELECTION_INVALID'),
                 (['--phase', 'before-pull'], 'EVENT_SELECTION_INVALID')]
        for flags, error in cases:
            with self.subTest(flags=flags), patch('sys.argv', base + flags), \
                    patch.object(disk, 'read_private') as reading, self.assertRaisesRegex(RuntimeError, error):
                disk.main()
            reading.assert_not_called()


if __name__ == '__main__':
    unittest.main()
