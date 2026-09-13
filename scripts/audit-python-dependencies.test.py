import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("audit_python", Path(__file__).with_name("audit-python-dependencies.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AuditTests(unittest.TestCase):
    def test_reports_affected_versions_and_deduplicates_environment_inventory(self):
        environments = {"a": [{"name": "demo_lib", "version": "1"}],
                        "b": [{"name": "demo-lib", "version": "1"}]}
        result = module.audit(environments, lambda _: {"results": [{"vulns": [{"id": "GHSA-test"}]}]})
        self.assertEqual(result["packageVersions"], 1)
        self.assertEqual(result["findings"][0]["advisories"], ["GHSA-test"])

    def test_does_not_treat_empty_inventory_or_incomplete_response_as_safe(self):
        with self.assertRaises(ValueError):
            module.audit({}, lambda _: {})
        for response in ({}, {"results": []}, {"results": [None]},
                         {"results": [{"error": "unavailable"}]},
                         {"results": [{"vulns": None}]}):
            with self.subTest(response=response), self.assertRaises(ValueError):
                module.audit({"a": [{"name": "demo", "version": "1"}]}, lambda _: response)

    def test_network_errors_propagate_instead_of_returning_a_clean_report(self):
        def unavailable(_):
            raise TimeoutError("OSV unavailable")
        with self.assertRaises(TimeoutError):
            module.audit({"a": [{"name": "demo", "version": "1"}]}, unavailable)

    def test_batches_complete_inventories_without_dropping_packages(self):
        sizes = []
        def query(payload):
            sizes.append(len(payload["queries"]))
            return {"results": [{} for _ in payload["queries"]]}
        report = module.audit({"a": [{"name": f"p{i}", "version": "1"} for i in range(201)]}, query)
        self.assertEqual(sizes, [100, 100, 1])
        self.assertEqual(report["packageVersions"], 201)
        self.assertEqual(report["findings"], [])


if __name__ == "__main__":
    unittest.main()
