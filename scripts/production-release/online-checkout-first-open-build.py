"""Freeze and build only the reviewed first-open diagnostic delta on latest main."""
import argparse
import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location('first_open_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


CORE = load('online-checkout-initialization-build.py')
CORE.PREFIX = 'online-checkout-first-open'
CORE.CONTRACT = HERE / (CORE.PREFIX + '-contract.json')
CORE.OUT = CORE.ROOT / '.deploy' / CORE.PREFIX
CORE.REPORTS = CORE.ROOT / '.runtime' / (CORE.PREFIX + '-ci')
CORE.publisher = lambda: load('online-checkout-first-open-release.py').CORE
REVIEW_DELTA = frozenset((
    *(CORE.publisher().ENGINE + '/' + name for name in CORE.publisher().FILES),
    'docs/ONLINE_RECHARGE.md', 'docs/V2_TASKS.md',
    *CORE.publisher().REVIEW_CONTROLS,
    CORE.publisher().WORKFLOW,
    *('scripts/production-release/online-checkout-first-open-' + name
        for name in ('build.py', 'release.py', 'release.test.py', 'contract.json'))))
CORE.reviewed_paths = lambda _publisher: REVIEW_DELTA


def __getattr__(name):
    return getattr(CORE, name)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--freeze', action='store_true'); parser.add_argument('--baseline')
    parser.add_argument('--source-review'); parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.freeze:
        CORE.publisher().need(args.baseline and args.source_review and not args.check, 'FREEZE_ARGUMENTS_INVALID')
        CORE.freeze(args.baseline, args.source_review)
    elif args.check:
        CORE.check(json.loads(CORE.CONTRACT.read_bytes()))
        print(json.dumps({'status': 'SOURCE_VERIFIED', 'businessActions': 0}))
    else:
        CORE.publisher().need(not args.baseline and not args.source_review, 'ARGUMENTS_INVALID'); CORE.main()
