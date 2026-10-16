"""One native browser release; the prior failed workflow remains a failed workflow."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUTPUT = ROOT / '.deploy/registration-browser'
spec = importlib.util.spec_from_file_location('browser_dispatch_release', HERE / 'registration-browser-release.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
need = r.need


def execute(*args):
    result = subprocess.run(args, cwd=ROOT, capture_output=True)
    need(result.returncode == 0, 'PLATFORM_REQUEST_FAILED')
    return result.stdout


def github(path):
    return json.loads(execute('gh', 'api', path))


def verified_contract():
    raw = (HERE / 'registration-browser-contract.json').read_bytes()
    contract = json.loads(raw)
    r.verify_contract(contract)
    return raw, contract


def namespace():
    return r.private_namespace(r.OLD_NAME + '-dispatch.py', {'ROOT': ROOT, 'OUTPUT': OUTPUT,
        'execute': execute, 'github': github, 'verified_contract': verified_contract,
        'prepare_plan': prepare_plan, 'transport': transport})


def prepare_plan():
    _, contract = verified_contract()
    # AWS credentials exist only in the publish job. Fetch the exact original
    # command before a new GitHub release or accepted command can be created.
    raw = execute('aws', 'ssm', 'get-command-invocation', '--region', 'ap-northeast-1',
        '--command-id', r.FORWARD_COMMAND, '--instance-id', r.INSTANCE, '--output', 'json')
    native = json.loads(raw)
    r.verify_forward_native(native, contract['predecessorNative'])
    mailbox_receipts = {}
    for mode in ('release', 'readback'):
        receipt = execute('aws', 'ssm', 'get-command-invocation', '--region', 'ap-northeast-1',
            '--command-id', contract['mailboxNative'][mode + 'CommandId'], '--instance-id', r.INSTANCE,
            '--output', 'json')
        r.verify_mailbox_native(json.loads(receipt), contract['mailboxNative'], mode)
        mailbox_receipts[mode] = receipt
    # Call its frozen implementation, not our override of its public entry.
    original = r.private_namespace(r.OLD_NAME + '-dispatch.py', {'ROOT': ROOT, 'OUTPUT': OUTPUT,
        'execute': execute, 'github': github, 'verified_contract': verified_contract})
    plan, admitted = original['prepare_plan']()
    (OUTPUT / 'predecessor-forward-native.json').write_bytes(raw)
    for mode, receipt in mailbox_receipts.items():
        (OUTPUT / ('mailbox-' + mode + '-native.json')).write_bytes(receipt)
    return plan, admitted


def transport(plan, mode):
    return r.private_namespace(r.OLD_NAME + '-dispatch.py', {'ROOT': ROOT, 'OUTPUT': OUTPUT,
        'execute': execute, 'github': github, 'verified_contract': verified_contract})['transport'](plan, mode)


def publish():
    namespace()['publish']()


def main():
    publish()


if __name__ == '__main__':
    need(len(sys.argv) == 1, 'DISPATCH_ARGUMENTS_INVALID')
    main()
