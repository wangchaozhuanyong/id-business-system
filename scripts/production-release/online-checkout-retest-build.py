"""Build the finite follow-on repair over the already reproduced and published checkout."""
import os
import subprocess
import sys
import urllib.request
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

REUSED_STEPS = ('Verify protected publication and affected API behavior',
    'Verify actual Chromium form and existing engine regressions',
    'Verify task progress lifecycle', 'Verify management interface rules')
REUSE_CONTROLS = frozenset(('scripts/production-release/online-checkout-build.py',
    'scripts/production-release/online-checkout-release.py',
    'scripts/production-release/online-checkout-retest-build.py',
    'scripts/production-release/online-checkout-retest-release.py',
    'scripts/production-release/online-checkout-retest-release.test.py',
    'scripts/production-release/online-checkout-retest-contract.json',
    '.github/workflows/online-checkout-retest-validation.yml'))

def validate_reuse(reuse, run, jobs, changes):
    ok = (reuse == {'runId': '39004100959', 'commit': 'c71568852416fd62a41557e926b3d47df3acef89'}
        and str(run.get('id')) == reuse['runId'] and run.get('head_sha') == reuse['commit']
        and run.get('head_branch') == 'main' and run.get('event') == 'workflow_dispatch'
        and run.get('path') == '.github/workflows/online-checkout-retest-validation.yml'
        and run.get('status') == 'completed' and run.get('conclusion') == 'failure'
        and len(jobs) == 1 and jobs[0].get('name') == 'validate' and set(changes) <= REUSE_CONTROLS)
    steps = {s['name']: s['conclusion'] for s in jobs[0].get('steps', [])} if len(jobs) == 1 else {}
    ok = ok and all(steps.get(n) == 'success' for n in REUSED_STEPS)
    ok = ok and {n for n, result in steps.items() if result == 'failure'} == {'Reproduce current three roles and build only this repair'}
    if not ok: raise RuntimeError('ONLINE_CHECKOUT_VALIDATION_REUSE_CHANGED')
    return True

def verify_reuse():
    contract = json.loads((HERE / 'online-checkout-retest-contract.json').read_bytes())
    reuse = contract.get('validationReuse')
    if not reuse: return False
    def api(suffix):
        request = urllib.request.Request('https://api.github.com/repos/wangchaozhuanyong/id-business-system/actions/runs/' + reuse['runId'] + suffix,
            headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json'})
        with urllib.request.urlopen(request, timeout=30) as response: return json.load(response)
    run = api('')
    jobs = api('/attempts/' + str(run['run_attempt']) + '/jobs')['jobs']
    changes = subprocess.check_output(['git', 'diff', '--name-only', reuse['commit'], 'HEAD'], cwd=ROOT).decode().splitlines()
    return validate_reuse(reuse, run, jobs, changes)

def main():
    verify_reuse()
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
    if sys.argv[1:] == ['--verify-reuse']:
        print('reused=' + str(verify_reuse()).lower())
    elif sys.argv[1:]:
        raise RuntimeError('ONLINE_CHECKOUT_ARGUMENTS_INVALID')
    else:
        main()
