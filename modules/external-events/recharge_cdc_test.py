import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("cdc", HERE / "recharge_cdc.py")
cdc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cdc)


class CommittedRows(unittest.TestCase):
    def test_only_safe_identifiers_leave_transaction(self):
        transaction = cdc.Transaction()
        transaction.rows("task_logs", [{"before_values": {"job_key": "before", "session_payload": "private"},
                                        "after_values": {"job_key": "after", "card_number": "private"}}])
        transaction.rows("billing_records", [{"values": {"secret_field": "private"}}])
        event = transaction.event("source", {"file": "binlog.000001", "position": 400})
        self.assertEqual(event["jobs"], ["after", "before"])
        self.assertTrue(event["reconcile"])
        self.assertNotIn("private", json.dumps(event))
        self.assertEqual(event, transaction.event("source", {"file": "binlog.000001", "position": 400}))
        self.assertNotEqual(event["receipt"], transaction.event("source", {"file": "binlog.000001", "position": 401})["receipt"])

    def test_missing_metadata_and_oversized_transactions_fail_closed(self):
        with self.assertRaises(cdc.Unavailable):
            cdc.Transaction().rows("task_logs", [{"values": {"UNKNOWN_COL0": "job"}}])
        with self.assertRaises(cdc.Unavailable):
            cdc.Transaction().rows("task_logs", [{"values": {"job_key": "job-" + str(i)}} for i in range(513)])

    def test_checkpoint_atomically_replaces_private_metadata_without_business_rows(self):
        runtime = HERE.parents[1] / ".runtime"
        runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=runtime) as directory:
            target = Path(directory) / "checkpoint.json"
            cdc.save_checkpoint(target, {"position": 4})
            self.assertEqual(cdc.private_json(target), {"position": 4})
            cdc.save_checkpoint(target, {"position": 28})
            self.assertEqual(cdc.private_json(target), {"position": 28})
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            target.chmod(0o644)
            with self.assertRaises(cdc.Unavailable):
                cdc.private_json(target)


if __name__ == "__main__":
    unittest.main()
