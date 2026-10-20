"""Freeze and build only this reviewed card visibility overlay on native main."""
import argparse
import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent

def load(name):
    spec = importlib.util.spec_from_file_location('card_visibility_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

CORE = load('online-checkout-initialization-build.py')
CORE.PREFIX = 'online-card-visibility'
CORE.CONTRACT = HERE / (CORE.PREFIX + '-contract.json')
CORE.OUT = CORE.ROOT / '.deploy' / CORE.PREFIX
CORE.REPORTS = CORE.ROOT / '.runtime' / (CORE.PREFIX + '-ci')
CORE.publisher = lambda: load('online-card-visibility-release.py').CORE
# The six-file overlay was merged before this narrow repair. Review only the
# exact repair delta against the latest main; freeze/check still hash every
# overlay file and the full engine inventory against the production base.
REVIEW_DELTA = frozenset((
    'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json',
    'apps/api/src/id-business-v2/online-recharge/engine/checkout-form.cjs',
    'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-form.test.cjs',
    'docs/ONLINE_RECHARGE.md', 'docs/V2_TASKS.md',
    'scripts/ci-online-settings-scope.mjs', 'scripts/ci-online-settings-scope.test.mjs',
    *('scripts/production-release/online-card-visibility-' + name
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
