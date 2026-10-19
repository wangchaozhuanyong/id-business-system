"""Finite read-only card exclusion diagnostics; reuse the audited engine overlay."""
import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('card_diagnostics_release_core', HERE / 'online-checkout-initialization-release.py')
CORE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(CORE)
CORE.PREFIX = 'online-card-control-diagnostics'
CORE.SCOPE = 'ONLINE_CARD_CONTROL_DIAGNOSTICS'
CORE.CURRENT = CORE.ENGINE_BASE = 'bd40a0b68a31821708a7204225a1dbf79b210efe'
CORE.REVIEW_BASE = '0b625c8e0ecb06f4052a4b3d7f3e318e390ca07b'
CORE.ENGINE_PROOF_FILE = 'online-checkout-initialization-build-proof.json'
CORE.ENGINE_IMAGE = 'sha256:efcd4b195120e83ab1df71b2244604f187a5e19963d565b5439feb0e3dca2e21'
CORE.MANIFEST_SHA = '21cc4388a22090d7a379a509f2feb154f7d37adea9f1bdc23b15223d0084d31c'
CORE.PRESERVATION_FILE = 'online-checkout-initialization-preservation.json'
CORE.PRESERVATION_SHA = 'bb3a25a5d9ac898685eaef84b3e6622a4ea9133bc334c2e963039a2c2f968d0c'
CORE.PREDECESSOR_PROOFS = {**CORE.PREDECESSOR_PROOFS,
    'online-checkout-initialization-build-proof.json': '0ff009667813314701e6164210cb07d4eeb3335dd109454d1609354015b2fbe9'}
CORE.CONTRACT_FILE = CORE.PREFIX + '-contract.json'
CORE.WORKFLOW = '.github/workflows/' + CORE.PREFIX + '-validation.yml'
CORE.FILES = frozenset(('SOURCE_MANIFEST.json', 'checkout-form.cjs', 'test/checkout-form.test.cjs',
    'test/checkout-navigation.test.cjs', 'upstream/chatgpt.js', 'upstream/index.js'))
CORE.ADDED = frozenset()
CORE.CONTROLS = frozenset((*CORE.CONTROLS, *(CORE.PREFIX + '-' + suffix
    for suffix in ('build.py', 'release.py', 'release.test.py'))))
CORE.PUBLIC_CONTROLS = frozenset((CORE.WORKFLOW, *CORE.REVIEW_CONTROLS,
    'scripts/production-release/online-checkout-initialization-release.py',
    *('scripts/production-release/' + CORE.PREFIX + '-' + suffix
        for suffix in ('build.py', 'release.py', 'release.test.py', 'contract.json'))))


def __getattr__(name):
    return getattr(CORE, name)
