"""Resolve a reviewed production browser cache without reading private configuration."""
import inspect
import json
import os
from pathlib import Path
import re
import subprocess


def select_browser_cache(manifest, expected_current, repository):
    if not re.fullmatch(r"[a-f0-9]{40}", expected_current or "") or manifest.get("commit") != expected_current:
        raise RuntimeError("Production cache baseline changed")
    if not re.fullmatch(r"[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release", repository or ""):
        raise RuntimeError("Browser cache repository is not the project repository")
    image = (manifest.get("images") or {}).get("auto-recharge") or {}
    reference, image_id = image.get("reference"), image.get("digest")
    if not isinstance(reference, str) or not re.fullmatch(
        re.escape(repository) + r":[a-f0-9]{40}-[1-9][0-9]*-[1-9][0-9]*-auto-recharge", reference
    ) or not isinstance(image_id, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id):
        raise RuntimeError("Immutable production browser cache identity is unavailable")
    return {"reference": reference, "imageId": image_id, "currentCommit": expected_current}


def aws_json(*args):
    result = subprocess.run(["aws", *args, "--output", "json"], capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError("AWS cache metadata operation failed; raw output suppressed")
    return json.loads(result.stdout)


def main():
    expected, repository = os.environ["EXPECTED_CURRENT"], os.environ["RELEASE_REPOSITORY"]
    select_source = inspect.getsource(select_browser_cache)
    # Structured serialization keeps the reviewed inputs out of shell interpolation.
    remote = (
        "import json, re\nfrom pathlib import Path\n" + select_source
        + "\nbase = Path('/opt/id-business-v2')\ncurrent = (base / 'current').resolve()\n"
        + "if current.parent != base / 'releases': raise RuntimeError('Unexpected production release path')\n"
        + "manifest = json.loads((current / 'release-manifest.json').read_text())\n"
        + "print(json.dumps(select_browser_cache(manifest, "
        + repr(expected) + ", " + repr(repository) + ")))\n"
    )
    invocation = aws_json("ssm", "send-command", "--cli-input-json", json.dumps({
        "InstanceIds": [os.environ["PRODUCTION_INSTANCE_ID"]], "DocumentName": "AWS-RunShellScript",
        "Parameters": {"commands": ["python3 - <<'PY'\n" + remote + "\nPY"], "executionTimeout": ["60"]},
        "Comment": "Read immutable production browser cache identity; no private configuration",
    }))
    command_id = invocation["Command"]["CommandId"]
    waited = subprocess.run(
        ["aws", "ssm", "wait", "command-executed", "--command-id", command_id,
         "--instance-id", os.environ["PRODUCTION_INSTANCE_ID"]],
        capture_output=True, timeout=120,
    )
    if waited.returncode:
        raise RuntimeError("Production browser cache read did not complete")
    receipt = aws_json("ssm", "get-command-invocation", "--command-id", command_id,
        "--instance-id", os.environ["PRODUCTION_INSTANCE_ID"])
    if (receipt.get("Status") != "Success" or type(receipt.get("ResponseCode")) is not int
            or receipt["ResponseCode"] != 0 or receipt.get("CommandId") != command_id
            or receipt.get("InstanceId") != os.environ["PRODUCTION_INSTANCE_ID"]):
        raise RuntimeError("Production browser cache read was unsuccessful")
    cache = json.loads(receipt["StandardOutputContent"])
    if cache.get("currentCommit") != expected:
        raise RuntimeError("Production browser cache response changed")
    # Verify the ECR config digest before a build can import this image.
    verified = select_browser_cache({"commit": expected, "images": {"auto-recharge": {
        "reference": cache.get("reference"), "digest": cache.get("imageId")}}}, expected, repository)
    tag = verified["reference"].split(":")[-1]
    ecr = aws_json("ecr", "batch-get-image", "--repository-name", "id-business-v2-release",
        "--image-ids", "imageTag=" + tag)
    if ecr.get("failures") or len(ecr.get("images", [])) != 1 or (
        json.loads(ecr["images"][0]["imageManifest"]).get("config", {}).get("digest") != verified["imageId"]
    ):
        raise RuntimeError("Production browser cache differs from immutable ECR identity")
    project = Path(__file__).resolve().parents[2]
    output = project / ".deploy/production-release/browser-cache-input.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({**verified, "readOnlyCommandId": command_id}, indent=2) + "\n")
    with open(os.environ["GITHUB_ENV"], "a") as environment:
        environment.write("RELEASE_BROWSER_CACHE_IMAGE=" + verified["reference"] + "\n")
        environment.write("RELEASE_BROWSER_CACHE_IMAGE_ID=" + verified["imageId"] + "\n")
    print("Verified immutable production browser cache")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Browser cache preparation failed; raw output suppressed")
        raise SystemExit(1)
