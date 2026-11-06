"""Prepare the pinned F2 source with the reviewed runtime dependency correction."""
import hashlib
import io
from pathlib import Path
import tarfile
import tomllib
from urllib.request import urlopen

COMMIT = "7dab3e2ffffaa2535834d28fca99dbc2e89fa9d3"
ARCHIVE_SHA256 = "36742ce4710dfd4b312d65948dfad42711743c9db1e73322deb0f53d2e652205"
MANIFEST_SHA256 = "babc745d592f109a09b260f15b61a70605266c2bba431dd98ed6ccab6950eadb"
CHANGES = {
    "black==24.10.0": None,
    "pytest==8.3.4": None,
    "pytest-asyncio==0.25.0": None,
    "click==8.1.7": "click==8.3.3",
    "protobuf==5.28.3": "protobuf==5.29.6",
    "cryptography==44.0.1": "cryptography==50.0.1",
}


def patch_manifest(data):
    if hashlib.sha256(data).hexdigest() != MANIFEST_SHA256:
        raise ValueError("F2 manifest changed; review dependency patch before building")
    text = data.decode()
    for old, new in CHANGES.items():
        source = '    "' + old + '",\n'
        if text.count(source) != 1:
            raise ValueError("F2 dependency patch does not match")
        text = text.replace(source, '    "' + new + '",\n' if new else "")
    tomllib.loads(text)
    return text


def main():
    with urlopen(f"https://codeload.github.com/Johnserf-Seed/f2/tar.gz/{COMMIT}", timeout=60) as response:
        data = response.read(32 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != ARCHIVE_SHA256:
        raise ValueError("F2 source archive checksum mismatch")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        archive.extractall("/tmp/f2-build", filter="data")
    manifest = Path(f"/tmp/f2-build/f2-{COMMIT}/pyproject.toml")
    manifest.write_text(patch_manifest(manifest.read_bytes()))


if __name__ == "__main__":
    main()
