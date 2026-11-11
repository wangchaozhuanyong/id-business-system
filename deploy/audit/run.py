"""Check ID production controls without publishing account or backup metadata."""

import datetime as dt
import json
import os
import re
import subprocess
from collections import defaultdict
from decimal import Decimal

ACCOUNT = "098208446664"
REGION = "ap-northeast-1"
ROLE = "id-business-v2-github-audit"
REPOSITORY = "id-business-v2-release"
BUCKET = f"id-business-v2-backups-{ACCOUNT}-{REGION}"
BUDGET = "ID-Production-Monthly"
PREFIX = "mysql/daily/independent-recharge/"
BACKUP = re.compile(PREFIX + r"([0-9]{8}T[0-9]{6}Z)/[a-f0-9]{40}/(manifest\.json|mysql\.sql\.aes256gcm)")


class AuditError(RuntimeError):
    pass


def aws(*args, region=REGION, expect_denied=False):
    result = subprocess.run(
        ["aws", "--region", region, "--no-cli-pager", "--cli-connect-timeout", "8",
         "--cli-read-timeout", "15", *args, "--output", "json"],
        capture_output=True, text=True, timeout=50, env=os.environ | {"AWS_MAX_ATTEMPTS": "2"},
    )
    if expect_denied:
        return result.returncode != 0 and "(AccessDenied)" in result.stderr
    if result.returncode:
        match = re.search(r"An error occurred \(([a-zA-Z0-9_.-]+)\)", result.stderr)
        code = match[1] if match else "response_unavailable"
        raise AuditError(f"{args[0]} {args[1]}: {code}")
    return json.loads(result.stdout)


def require(ok, reason):
    if not ok:
        raise AuditError(reason)


def check_identity():
    identity = aws("sts", "get-caller-identity")
    require(identity["Account"] == ACCOUNT and
            identity["Arn"].startswith(f"arn:aws:sts::{ACCOUNT}:assumed-role/{ROLE}/id-audit-"),
            "unexpected_identity")
    print("ID read-only role verified")


def check_budget():
    scope = ("--account-id", ACCOUNT, "--budget-name", BUDGET)
    budget = aws("budgets", "describe-budget", *scope, region="us-east-1")["Budget"]
    alerts = aws("budgets", "describe-notifications-for-budget", *scope, region="us-east-1")["Notifications"]
    require(budget["TimeUnit"] == "MONTHLY" and budget["CostTypes"]["IncludeCredit"] is False and
            budget["BudgetLimit"]["Unit"] == "USD" and Decimal(budget["BudgetLimit"]["Amount"]) == 40 and
            set(budget["CostFilters"]["TagKeyValue"]) == {"user:Project$ID", "user:Project$id-business-independent"},
            "budget_scope_or_amount_changed")
    # DescribeNotificationsForBudget can omit the default percentage threshold type.
    thresholds = {(item["NotificationType"], item.get("ThresholdType", "PERCENTAGE"),
                   item["ComparisonOperator"], item["Threshold"]) for item in alerts}
    require(len(alerts) == 2 and thresholds == {("ACTUAL", "PERCENTAGE", "GREATER_THAN", 80),
            ("FORECASTED", "PERCENTAGE", "GREATER_THAN", 100)}, "budget_alerts_changed")
    print("ID budget and notification thresholds verified")


def check_registry():
    scope = ("--registry-id", ACCOUNT)
    repo, = aws("ecr", "describe-repositories", *scope, "--repository-names", REPOSITORY)["repositories"]
    require(repo["imageTagMutability"] == "IMMUTABLE", "registry_tag_mutability_changed")
    images = aws("ecr", "describe-images", *scope, "--repository-name", REPOSITORY)["imageDetails"]
    require(bool(images), "registry_empty")
    print("ID registry metadata and immutable tags verified")


def check_backups():
    scope = ("--bucket", BUCKET, "--expected-bucket-owner", ACCOUNT)
    versioning = aws("s3api", "get-bucket-versioning", *scope)
    require(versioning["Status"] == "Enabled", "backup_bucket_not_versioned")
    rules = aws("s3api", "get-bucket-lifecycle-configuration", *scope)["Rules"]
    for prefix, current, older in (("mysql/daily/", 90, 30), ("release-artifacts/temporary/", 7, 7)):
        matching = [rule for rule in rules if rule.get("Filter", {}).get("Prefix") == prefix]
        require(len(matching) == 1 and matching[0]["Status"] == "Enabled" and
                matching[0]["Expiration"]["Days"] == current and
                matching[0]["NoncurrentVersionExpiration"]["NoncurrentDays"] == older, "backup_retention_changed")
    require(aws("s3api", "list-objects-v2", *scope, "--prefix", "release-artifacts/formal/",
                "--max-keys", "1", "--no-paginate", expect_denied=True), "out_of_scope_listing_not_denied")
    now = dt.datetime.now(dt.timezone.utc)
    pairs = defaultdict(set)
    for date in (now, now - dt.timedelta(days=1)):
        result = aws("s3api", "list-objects-v2", *scope, "--prefix", PREFIX + date.strftime("%Y%m%d"))
        for row in result.get("Contents", []):
            match = BACKUP.fullmatch(row["Key"])
            if match and row["Size"] > 0:
                pairs[row["Key"].rsplit("/", 1)[0]].add(match[2])
    complete = [dt.datetime.strptime(folder.split("/")[-2], "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)
                for folder, names in pairs.items() if names == {"manifest.json", "mysql.sql.aes256gcm"}]
    require(complete and dt.timedelta(0) <= now - max(complete) <= dt.timedelta(minutes=35),
            "missing_fresh_mysql_backup_pair")
    print("ID backup retention, fresh object pair and denied out-of-scope listing verified")


def main():
    for operation in (check_identity, check_budget, check_registry, check_backups):
        try:
            operation()
        except AuditError as error:
            raise SystemExit(f"ID audit failed at {operation.__name__}: {error}") from None
        except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError):
            raise SystemExit(f"ID audit failed at {operation.__name__}: invalid_response") from None


if __name__ == "__main__":
    main()
