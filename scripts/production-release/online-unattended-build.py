"""Build the reviewed unattended repair over the exact published 0222 source."""
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


def configure(builder):
    reconstruct = builder.reconstruct

    def published(context, contract, controls):
        old_raw = (HERE / 'online-checkout-retest-contract.json').read_bytes()
        builder.need(builder.sha(old_raw) == contract['predecessorRecipeSha256'], 'PREDECESSOR_RECIPE_CHANGED')
        old = json.loads(old_raw)
        first_raw = (HERE / 'online-checkout-contract.json').read_bytes()
        builder.need(builder.sha(first_raw) == old['predecessorContractSha256'], 'PREDECESSOR_CONTRACT_CHANGED')
        reconstruct(context, json.loads(first_raw), controls)
        for sources, commit in [(old['predecessorSources'], old['adminPublishedCommit']),
                                (old['sources'], contract['expectedCurrent'])]:
            for name, expected in sources.items():
                raw = builder.git('show', commit + ':' + name)
                builder.need(builder.sha(raw) == expected, 'PUBLISHED_SOURCE_CHANGED')
                target = context / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(raw)
        builder.overlay_engine(context, contract)

    builder.reconstruct = published
    builder.OUT = ROOT / '.deploy/online-unattended'
    builder.CONTRACT_FILE = 'online-unattended-contract.json'
    return builder


def main():
    contract = json.loads((HERE / 'online-unattended-contract.json').read_bytes())
    load('online-unattended-release.py').validate_contract(contract)
    builder = load('online-checkout-build.py')
    engine = ROOT / contract['engineRoot']
    rows = json.loads((engine / 'SOURCE_MANIFEST.json').read_bytes())['files']
    entries = {row['path']: row['adaptedSha256'] for row in rows}
    builder.need(len(entries) == len(rows) and entries == {
        n: digest for n, digest in contract['afterEngineFiles'].items() if n != 'SOURCE_MANIFEST.json'
    } and all(builder.sha((engine / name).read_bytes()) == digest for name, digest in entries.items()),
        'ENGINE_MANIFEST_CHANGED')
    configure(builder).main()


if __name__ == '__main__':
    main()
