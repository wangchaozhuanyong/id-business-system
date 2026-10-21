"""Finite first-open diagnostics overlay; reuse the audited engine publisher."""
import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('first_open_release_core', HERE / 'online-checkout-initialization-release.py')
CORE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(CORE)
CORE.PREFIX = 'online-checkout-first-open'
CORE.SCOPE = 'ONLINE_CHECKOUT_FIRST_OPEN'
CORE.CURRENT = 'be4dc7ea9da6b42fbc9f61653cb006d1242b1493'
CORE.REVIEW_BASE = 'be4dc7ea9da6b42fbc9f61653cb006d1242b1493'
CORE.ENGINE_BASE = 'cb38a1ef351b42f98ce86740b2191fd54207fa32'
CORE.ENGINE_PROOF_FILE = 'online-card-visibility-build-proof.json'
CORE.ENGINE_IMAGE = 'sha256:9230ff58e604ee4d5200d9ee6611e2fa1419c833faf13b1f5d1f30167c3af3a1'
# Bound to a fresh, completed predecessor observation before source freeze.
CORE.MANIFEST_SHA = 'ee3ebfcd85f399bd57c6e2ca86747ed335ba8cdbda89bb2316735766da894020'
CORE.PRESERVATION_FILE = 'bitbrowser-history-preservation.json'
CORE.PRESERVATION_SHA = 'acdd82150181a3ca1f04bcb14da4d034abb75c602bae360fe0398918abf405a2'
CORE.PREDECESSOR_PROOFS = {'bitbrowser-history-build-proof.json': 'b47ad6719660bd44ff910fbf9a57c84ad5da3a3bbe27cda15be7273531623274', 'online-card-control-diagnostics-build-proof.json': '03c5460b365088ced8e77ed61ef2b153d204587d2a398620e9a2a3662b0cc080', 'online-card-visibility-build-proof.json': '98afb721e1ed84bb6c12a6d6d09da43adffc760ec67e032aa88ff743af95ada4', 'online-checkout-actionability-build-proof.json': 'e2cea0e27318da7e9cb4c143f2cd26d7b87dc9cc90361eb5ef4f0db17d86f388', 'online-checkout-initialization-build-proof.json': '0ff009667813314701e6164210cb07d4eeb3335dd109454d1609354015b2fbe9'}
CORE.CONTRACT_FILE = CORE.PREFIX + '-contract.json'
CORE.WORKFLOW = '.github/workflows/' + CORE.PREFIX + '-validation.yml'
CORE.FILES = frozenset(('SOURCE_MANIFEST.json', 'checkout-form.cjs', 'checkout-initialization.cjs',
    'test/checkout-form.test.cjs', 'test/checkout-navigation.test.cjs',
    'test/checkout-initialization.test.cjs', 'test/checkout-recovery.test.cjs', 'test/debug-checkout.test.cjs',
    'upstream/chatgpt.js', 'upstream/index.js'))
CORE.ADDED = frozenset(('checkout-initialization.cjs', 'test/checkout-initialization.test.cjs'))
CORE.CONTROLS = frozenset((*CORE.CONTROLS, *(CORE.PREFIX + '-' + suffix
    for suffix in ('build.py', 'release.py', 'release.test.py'))))
CORE.PUBLIC_CONTROLS = frozenset((CORE.WORKFLOW, *CORE.REVIEW_CONTROLS,
    'scripts/production-release/online-checkout-initialization-release.py',
    *('scripts/production-release/' + CORE.PREFIX + '-' + suffix
        for suffix in ('build.py', 'release.py', 'release.test.py', 'contract.json'))))
CORE.INITIALIZATION_TESTS = (*CORE.INITIALIZATION_TESTS, 'test/checkout-form.test.cjs',
    'test/checkout-navigation.test.cjs', 'test/debug-checkout.test.cjs', 'test/checkout-initialization.test.cjs', 'test/checkout-recovery.test.cjs')
CORE.INITIALIZATION_REPORTS = tuple((name, suite, mode, 10 if suite == 'SESSION_ROUTING' else total)
    for name, suite, mode, total in CORE.INITIALIZATION_REPORTS) + (
    ('checkout-form.tap', 'CHECKOUT_FORM', 'native', 134),
    ('checkout-navigation.tap', 'CHECKOUT_NAVIGATION', 'native', 30),
    ('debug-checkout.tap', 'DEBUG_CHECKOUT', 'native', 15),
    ('checkout-initialization.tap', 'CHECKOUT_INITIALIZATION', 'native', 17),
    ('checkout-recovery.tap', 'CHECKOUT_RECOVERY', 'native', 47))


def __getattr__(name):
    return getattr(CORE, name)
