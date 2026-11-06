#!/usr/bin/env python3
"""Audit installed Python environments against OSV. Errors never count as a pass."""
import argparse
import json
import subprocess
from pathlib import Path
from urllib.request import Request, urlopen

INVENTORY = """import importlib.metadata,json
print(json.dumps(sorted([{"name":d.metadata["Name"],"version":d.version}
for d in importlib.metadata.distributions()],key=lambda d:d["name"].lower())))
"""


def audit(environments, query):
    packages = sorted({(p["name"].lower().replace("_", "-"), p["version"])
                       for rows in environments.values() for p in rows})
    if not packages:
        raise ValueError("Python dependency inventory is empty")
    findings = []
    for offset in range(0, len(packages), 100):
        batch = packages[offset:offset + 100]
        result = query({"queries": [
            {"package": {"name": name, "ecosystem": "PyPI"}, "version": version}
            for name, version in batch]})
        rows = result.get("results")
        if not isinstance(rows, list) or len(rows) != len(batch):
            raise ValueError("OSV returned an incomplete response")
        for (name, version), row in zip(batch, rows):
            if not isinstance(row, dict) or set(row) - {"vulns"}:
                raise ValueError("OSV returned an invalid result")
            vulnerabilities = row.get("vulns", [])
            if not isinstance(vulnerabilities, list):
                raise ValueError("OSV returned invalid vulnerabilities")
            if vulnerabilities:
                findings.append({"name": name, "version": version,
                                 "advisories": sorted({v["id"] for v in vulnerabilities})})
    return {"packageVersions": len(packages), "environments": environments, "findings": findings}


def query_osv(payload):
    request = Request("https://api.osv.dev/v1/querybatch",
                      data=json.dumps(payload).encode(),
                      headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=45) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    environments = {}
    for executable in args.python:
        rows = json.loads(subprocess.check_output([executable, "-c", INVENTORY], text=True, timeout=30))
        if not rows:
            raise ValueError("Python dependency inventory is empty")
        environments[executable] = rows
    report = audit(environments, query_osv)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"packageVersions": report["packageVersions"], "findings": report["findings"]}))
    return 1 if report["findings"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
