"""Package the pinned browser client and broker dependencies off the production host."""

import hashlib
import io
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
NOVNC_COMMIT = "63107bd06d9e1f6136ff21aeda8cd62cbf0d433e"  # v1.7.0
NOVNC_SHA256 = "06dac239be3973ed79a00e357a68aab996e6ed2fd496ee2cc6e6a34020344ac9"


def browser_client(target):
    with urlopen(f"https://codeload.github.com/novnc/noVNC/tar.gz/{NOVNC_COMMIT}", timeout=30) as response:
        data = response.read(4 * 1024 * 1024 + 1)
    if hashlib.sha256(data).hexdigest() != NOVNC_SHA256:
        raise ValueError("manual_workspace_client_hash_mismatch")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            if path.parts[:1] != ("noVNC-" + NOVNC_COMMIT,) or not member.isfile() or ".." in path.parts:
                continue
            relative = PurePosixPath(*path.parts[1:])
            if not (relative.parts[:1] in (("core",), ("vendor",), ("docs",)) and
                    (relative.suffix == ".js" or relative.name.startswith("LICENSE")) or
                    relative == PurePosixPath("LICENSE.txt")):
                continue
            file = target.joinpath(*relative.parts)
            file.parent.mkdir(mode=0o755, exist_ok=True, parents=True)
            file.write_bytes(archive.extractfile(member).read())
    if not (target / "core/rfb.js").is_file():
        raise ValueError("manual_workspace_client_missing")


def build(sha):
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("release_revision_required")
    output = ROOT / ".runtime/website-release"
    runtime = output / "manual-runtime"
    runtime.mkdir(parents=True, exist_ok=False, mode=0o755)
    subprocess.run([sys.executable, "-m", "pip", "--isolated", "install", "--disable-pip-version-check",
                    "--no-compile", "--require-hashes", "--no-deps", "--only-binary=:all:",
                    "--platform", "manylinux_2_28_x86_64", "--python-version", "39",
                    "--implementation", "cp", "--abi", "cp39", "--target", str(runtime / "site-packages"),
                    "-r", str(ROOT / "deploy/manual-desktop/requirements-x86-python39.txt")], check=True)
    browser_client(runtime / "novnc")
    with tarfile.open(output / f"independent-manual-runtime-{sha}.tar.gz", mode="x:gz") as archive:
        for directory in ("site-packages", "novnc"):
            archive.add(runtime / directory, arcname=directory)


if __name__ == "__main__":
    build(sys.argv[1])
