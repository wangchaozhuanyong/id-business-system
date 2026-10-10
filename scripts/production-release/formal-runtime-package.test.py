"""Five fixed package suites; collector includes its source-schema regression.

Only project-local test files are executed. No profile, path or command may be
supplied by the caller, and every failed or missing suite fails this aggregate.
"""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / 'scripts' / 'production-release' / 'formal-runtime-package'
SUITES = (
    ('bootstrap-boundary.test.py',),
    ('package.test.py',),
    ('package-source.test.py',),
    ('qualified.test.py',),
    ('collector.test.py', 'collector-schema.test.py'),
)


def main():
    for suite in SUITES:
        for name in suite:
            file = PACKAGE / name
            if file.is_symlink() or not file.is_file():
                print('Missing fixed formal runtime package test', file=sys.stderr)
                return 1
            try:
                result = subprocess.run(
                    [sys.executable, '-B', str(file)], cwd=ROOT,
                    check=False, timeout=120,
                )
            except (OSError, subprocess.TimeoutExpired):
                print('Formal runtime package test execution failed', file=sys.stderr)
                return 1
            if result.returncode != 0:
                return 1
    return 0


if __name__ == '__main__':
    if len(sys.argv) != 1:
        raise SystemExit('Formal runtime package aggregate accepts no arguments')
    raise SystemExit(main())
