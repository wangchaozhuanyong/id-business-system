"""Build hash-locked pure Python wheels into a deterministic release artifact."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[2]


def build(sha):
    if len(sha) != 40 or any(character not in '0123456789abcdef' for character in sha):
        raise ValueError('release_revision_required')
    output = ROOT / '.runtime/website-release'
    target = output / 'event-runtime'
    target.mkdir(parents=True, exist_ok=False)
    subprocess.run([sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-compile',
                    '--require-hashes', '--only-binary=:all:', '--target', str(target),
                    '-r', str(ROOT / 'modules/external-events/requirements.txt')], check=True)
    files = sorted(path for path in target.rglob('*') if path.is_file())
    manifest = {str(path.relative_to(target)): hashlib.sha256(path.read_bytes()).hexdigest() for path in files}
    (target / 'manifest.json').write_text(json.dumps({'sha': sha, 'files': manifest}, sort_keys=True))
    files.append(target / 'manifest.json')
    with (output / f'independent-event-runtime-{sha}.tar.gz').open('xb') as raw:
        with gzip.GzipFile(fileobj=raw, mode='wb', mtime=0, filename='') as compressed:
            with tarfile.open(fileobj=compressed, mode='w') as archive:
                for path in sorted(files):
                    data = path.read_bytes()
                    entry = tarfile.TarInfo(str(path.relative_to(target)))
                    entry.size = len(data); entry.mode = 0o644
                    archive.addfile(entry, io.BytesIO(data))


if __name__ == '__main__':
    build(sys.argv[1])
