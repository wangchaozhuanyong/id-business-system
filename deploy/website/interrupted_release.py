"""Read the original SSM evidence for the interrupted 2026-11-27 cutover."""

import hashlib
import json


INTERRUPTED_SHA = "d7a9b22909ea7d716a202866fe08a99e9e70128a"
INTERRUPTED_WEBSITE_SHA = "d34197782def5119712887cfdb34c57ff14badb6"
INTERRUPTED_OLD_ASSETS = "8bc14b7e2f588444d7a2bf7aa88810ae9f3c7116103754e17019515f8cd484fc"
INTERRUPTED_NEW_ASSETS = "827d2d6e6b94f12c2355364e6b87758d997c46bcb33fe93da1c613350a90773d"
INTERRUPTED_GATEWAY_SHA256 = "cfd4d24a89fcbe4243cb519a87610cc2abbe7cfa5d9ee5359ac3a6d2e9b5d238"
INTERRUPTED_OLD_NATIVE_SHA = "45ba71fbd4054669a029ab2b565f49ceb6a3242b"
INTERRUPTED_OLD_NATIVE_IMAGE = "sha256:eec2a83a677987807c627ba0708e0cea94a1e5b411341b63242c1d1554020506"
_RUN = "45941856485/1"
_RELEASE_COMMAND = "b431b85c-90aa-4357-9c4d-43bdb8f541af"
_PREFLIGHT_COMMAND = "f2aaffba-7a9c-407e-ab3c-989d09f82a89"
_PREFLIGHT_OUTPUT_SHA256 = "41ec3bfe5d916fd8d1c8027f0c5ce5fd8aeef348a2b9a53e4a621bc589038592"
_RELEASE_ERROR = "container_metadata_read_failed:recharge-native:not_found"


def _matches(record, expected):
    return isinstance(record, dict) and all(
        key in record and type(record[key]) is type(value) and record[key] == value for key, value in expected.items()
    )


def _read_invocation(aws, instance, operation, command, status, response_code):
    expected = {
        "CommandId": command,
        "DocumentName": "AWS-RunShellScript",
        "Comment": f"ID website {operation} {INTERRUPTED_SHA[:12]} run {_RUN}",
        "Status": status,
        "StatusDetails": status,
    }
    history = aws("ssm", "list-commands", "--command-id", command)
    commands = history.get("Commands") if isinstance(history, dict) else None
    if (not isinstance(commands, list) or len(commands) != 1 or history.get("NextToken") or
            not _matches(commands[0], {**expected, "InstanceIds": [instance],
                                       "CompletedCount": 1, "ErrorCount": response_code})):
        raise RuntimeError("interrupted_release_command_not_verified")
    invocation = aws("ssm", "get-command-invocation", "--command-id", command, "--instance-id", instance)
    if not _matches(invocation, {**expected, "InstanceId": instance, "ResponseCode": response_code,
                                 "PluginName": "aws:runShellScript"}):
        raise RuntimeError("interrupted_release_invocation_not_verified")
    return invocation


def original_baseline(aws, instance):
    release = _read_invocation(aws, instance, "release", _RELEASE_COMMAND, "Failed", 1)
    error = release.get("StandardErrorContent")
    output = release.get("StandardOutputContent")
    if (not isinstance(error, str) or
            error.splitlines() != [_RELEASE_ERROR, "failed to run commands: exit status 1"] or
            not isinstance(output, str) or
            "Switching the drained native recharge runtime" not in output.splitlines()):
        raise RuntimeError("interrupted_release_failure_not_verified")

    preflight = _read_invocation(aws, instance, "preflight", _PREFLIGHT_COMMAND, "Success", 0)
    output = preflight.get("StandardOutputContent")
    # The complete snapshot is pinned, including component identities and launcher digests.
    if (preflight.get("StandardErrorContent") != "" or not isinstance(output, str) or
            hashlib.sha256(output.strip().encode()).hexdigest() != _PREFLIGHT_OUTPUT_SHA256):
        raise RuntimeError("interrupted_release_preflight_not_verified")
    try:
        before = json.loads(output)
        components = before["components"]
        native = components["recharge-native"]
        if (before["gatewaySha256"] != INTERRUPTED_GATEWAY_SHA256 or
                before["assetsSha256"] != INTERRUPTED_OLD_ASSETS or
                not _matches(before["mountedAssets"], {"available": True, "sha256": INTERRUPTED_OLD_ASSETS}) or
                not all(_matches(components[name], {"revision": INTERRUPTED_WEBSITE_SHA, "running": True})
                        for name in ("app", "drive-backup", "sheets-sync")) or
                not all(_matches(components[name], {"revision": INTERRUPTED_OLD_NATIVE_SHA, "running": True,
                                                   "image": INTERRUPTED_OLD_NATIVE_IMAGE})
                        for name in ("recharge", "recharge-native")) or
                not _matches(before["nativePublication"], {"identity": native, "imageLabelsVerified": True})):
            raise ValueError
    except (KeyError, TypeError, ValueError):
        raise RuntimeError("interrupted_release_preflight_baseline_mismatch") from None
    return before
