import json
import unittest
from unittest.mock import patch

import run


class RetentionAuditTests(unittest.TestCase):
    def check_images(self, sizes):
        response = {"imageDetails": [
            {"imageDigest": f"sha256:{index:064x}", "imageSizeInBytes": size}
            for index, size in enumerate(sizes)
        ]}
        repository = {"repositories": [{"imageTagMutability": "IMMUTABLE"}]}
        with patch.object(run, "aws", side_effect=[repository, response]):
            run.check_registry()

    def test_registry_reports_count_or_size_growth_independently(self):
        self.check_images([run.ECR_BASELINE_REPORTED_BYTES])
        with self.assertRaisesRegex(run.AuditError, "registry_image_count_above_review_limit"):
            self.check_images([100] * (run.ECR_BASELINE_COUNT + run.ECR_IMAGE_GROWTH_ALLOWANCE + 1))
        with self.assertRaisesRegex(run.AuditError, "registry_image_size_above_review_limit"):
            self.check_images([run.ECR_BASELINE_REPORTED_BYTES + run.ECR_REPORTED_BYTE_GROWTH_ALLOWANCE + 1])

    def test_archive_rules_must_remain_scoped_and_transition_only(self):
        rules = json.loads(run.ARCHIVE_POLICY.read_text())["Rules"]
        run.check_legacy_archive_rules(rules)
        changed = [rules[0] | {"Expiration": {"Days": 90}}, rules[1]]
        with self.assertRaisesRegex(run.AuditError, "legacy_archive_lifecycle_changed"):
            run.check_legacy_archive_rules(changed)
        changed = [rules[0], rules[1] | {"Filter": {"Prefix": "release-artifacts/"}}]
        with self.assertRaisesRegex(run.AuditError, "legacy_archive_lifecycle_changed"):
            run.check_legacy_archive_rules(changed)

    def test_formal_release_rules_require_the_retirement_tag(self):
        rules = json.loads(run.FORMAL_RELEASE_POLICY.read_text())["Rules"]
        run.check_formal_release_rules(rules)
        broad = [rules[0] | {"Filter": {"Prefix": "release-artifacts/formal/"}}, rules[1]]
        with self.assertRaisesRegex(run.AuditError, "formal_release_lifecycle_changed"):
            run.check_formal_release_rules(broad)

    def test_formal_release_rules_reject_an_overlapping_expiration(self):
        rules = json.loads(run.FORMAL_RELEASE_POLICY.read_text())["Rules"]
        extra = {"ID": "Unexpected", "Status": "Enabled", "Expiration": {"Days": 90}}
        for filter_ in ({}, {"Prefix": "release-artifacts/"}, {
                "And": {"Prefix": "release-artifacts/formal/a/", "Tags": [
                    {"Key": "cleanup", "Value": "yes"}]}}):
            with self.subTest(filter_=filter_), self.assertRaisesRegex(
                    run.AuditError, "unreviewed_expiration_overlaps_formal_releases"):
                run.check_formal_release_rules(rules + [extra | {"Filter": filter_}])
        run.check_formal_release_rules(rules + [extra | {"Filter": {"Prefix": "mysql/daily/"}}])
