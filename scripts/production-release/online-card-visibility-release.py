"""Finite rendered hidden card control compatibility; reuse the audited engine overlay."""
import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('card_visibility_release_core', HERE / 'online-checkout-initialization-release.py')
CORE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(CORE)
CORE.PREFIX = 'online-card-visibility'
CORE.SCOPE = 'ONLINE_CARD_VISIBILITY'
CORE.CURRENT = CORE.ENGINE_BASE = 'fe52794341fe07d518b4fcc8b2141a67341487c7'
CORE.REVIEW_BASE = 'fe52794341fe07d518b4fcc8b2141a67341487c7'
CORE.ENGINE_PROOF_FILE = 'online-card-control-diagnostics-build-proof.json'
CORE.ENGINE_IMAGE = 'sha256:9c745aeeb3f30713d572945dc55a6067a494e914c9a144c23e341270be7ec052'
CORE.MANIFEST_SHA = '33558844fa6970755a1d6adcdd3b577e47a346ddfbac7d10e3e50e2fbcaba5e1'
CORE.PRESERVATION_FILE = 'online-card-control-diagnostics-preservation.json'
CORE.PRESERVATION_SHA = 'f68cace4fd37383a2d89138cbadf666c3d6b5fedd324bd43f540636e8865f73d'
CORE.PREDECESSOR_PROOFS = {'bitbrowser-history-build-proof.json': '21ae3a28caa39c7f4c08fdb70b3e20780c4ed639d4d0bc4d11272dbd9d6d0354', 'online-card-control-diagnostics-build-proof.json': '03c5460b365088ced8e77ed61ef2b153d204587d2a398620e9a2a3662b0cc080', 'online-checkout-actionability-build-proof.json': 'e2cea0e27318da7e9cb4c143f2cd26d7b87dc9cc90361eb5ef4f0db17d86f388', 'online-checkout-initialization-build-proof.json': '0ff009667813314701e6164210cb07d4eeb3335dd109454d1609354015b2fbe9'}
CORE.CONTRACT_FILE = CORE.PREFIX + '-contract.json'
CORE.WORKFLOW = '.github/workflows/' + CORE.PREFIX + '-validation.yml'
CORE.FILES = frozenset(('SOURCE_MANIFEST.json', 'checkout-form.cjs', 'test/checkout-form.test.cjs',
    'test/checkout-interaction.test.cjs', 'test/session-routing-browser.test.cjs', 'test/recharge-flow-acceptance.test.cjs'))
CORE.ADDED = frozenset()
CORE.CONTROLS = frozenset((*CORE.CONTROLS, *(CORE.PREFIX + '-' + suffix
    for suffix in ('build.py', 'release.py', 'release.test.py'))))
CORE.PUBLIC_CONTROLS = frozenset((CORE.WORKFLOW, *CORE.REVIEW_CONTROLS,
    'scripts/production-release/online-checkout-initialization-release.py',
    *('scripts/production-release/' + CORE.PREFIX + '-' + suffix
        for suffix in ('build.py', 'release.py', 'release.test.py', 'contract.json'))))

CORE.INITIALIZATION_TESTS = (*CORE.INITIALIZATION_TESTS, 'test/checkout-form.test.cjs', 'test/checkout-interaction.test.cjs', 'test/recharge-flow-acceptance.test.cjs')
CORE.INITIALIZATION_REPORTS = tuple((name, suite, mode, 10 if suite == 'SESSION_ROUTING' else total)
    for name, suite, mode, total in CORE.INITIALIZATION_REPORTS) + (
    ('checkout-form.tap', 'CHECKOUT_FORM', 'native', 133),
    ('checkout-interaction.tap', 'CHECKOUT_INTERACTION', 'native', 49),
    ('hidden-flow.tap', 'HIDDEN_COMPLETE_FLOW', 'native', 1))


def __getattr__(name):
    return getattr(CORE, name)
