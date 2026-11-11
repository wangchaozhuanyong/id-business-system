import unittest
from unittest.mock import patch

import run


class BudgetAuditTests(unittest.TestCase):
    def test_omitted_percentage_is_accepted_and_absolute_threshold_is_rejected(self):
        budget = {"Budget": {
            "TimeUnit": "MONTHLY",
            "CostTypes": {"IncludeCredit": False},
            "BudgetLimit": {"Amount": "40.0", "Unit": "USD"},
            "CostFilters": {"TagKeyValue": ["user:Project$ID", "user:Project$id-business-independent"]},
        }}
        actual = {"NotificationType": "ACTUAL", "ComparisonOperator": "GREATER_THAN", "Threshold": 80.0}
        forecast = {"NotificationType": "FORECASTED", "ComparisonOperator": "GREATER_THAN", "Threshold": 100.0}
        with patch.object(run, "aws", side_effect=[budget, {"Notifications": [actual, forecast]}]):
            run.check_budget()
        absolute = actual | {"ThresholdType": "ABSOLUTE_VALUE"}
        with patch.object(run, "aws", side_effect=[budget, {"Notifications": [absolute, forecast]}]):
            with self.assertRaisesRegex(run.AuditError, "budget_alerts_changed"):
                run.check_budget()
