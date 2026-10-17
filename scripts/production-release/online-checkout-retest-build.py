"""Build the finite follow-on repair over the already reproduced and published checkout."""
import hashlib
import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def main():
    load('online-checkout-retest-release.py').validate_contract(json.loads((HERE / 'online-checkout-retest-contract.json').read_bytes()))
    b = load('online-checkout-build.py')
    reconstruct_previous = b.reconstruct
    def reconstruct_current(context, contract, controls):
        previous = json.loads((HERE / 'online-checkout-contract.json').read_bytes())
        b.need(b.sha((HERE / 'online-checkout-contract.json').read_bytes()) == contract['predecessorContractSha256'], 'PREDECESSOR_CONTRACT_CHANGED')
        reconstruct_previous(context, previous, controls)
        for name, expected in contract['predecessorSources'].items():
            raw = b.git('show', contract['adminPublishedCommit'] + ':' + name)
            b.need(b.sha(raw) == expected, 'PREDECESSOR_SOURCE_CHANGED')
            target = context / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
        b.overlay_engine(context, contract)
    b.reconstruct = reconstruct_current
    b.OUT = ROOT / '.deploy/online-checkout-retest'
    b.CONTRACT_FILE = 'online-checkout-retest-contract.json'
    b.main()

if __name__ == '__main__':
    main()
