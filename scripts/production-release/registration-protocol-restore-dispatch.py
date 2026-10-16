"""One new forward release. Historical accepted operations are never repeated."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
NAME = 'registration-protocol-restore'
OUTPUT = ROOT / '.deploy' / NAME
spec = importlib.util.spec_from_file_location('restore_dispatch_release', HERE / (NAME + '-release.py'))
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
    raw = (HERE / (NAME + '-contract.json')).read_bytes()
    contract = json.loads(raw)
    r.verify_contract(contract)
    return raw, contract


def verify_native_receipt(raw, binding):
    value = json.loads(raw)
    need(r.digest(r.canonical(value)) == binding['canonicalSha256'] and value['CommandId'] == binding['commandId']
         and value['InstanceId'] == r.INSTANCE and value['Status'] == 'Success'
         and value['ResponseCode'] == 0 and value.get('DocumentName') == 'AWS-RunShellScript'
         and not value['StandardErrorContent'].strip(),
         'PREDECESSOR_NATIVE_RECEIPT_CHANGED')
    result = json.loads(value['StandardOutputContent'])
    need(result == binding['result'], 'PREDECESSOR_NATIVE_RESULT_CHANGED')


def namespace(overrides=None):
    return r.private_namespace(r.OLD_NAME + '-dispatch.py', {'ROOT': ROOT, 'OUTPUT': OUTPUT,
        'execute': execute, 'github': github, 'verified_contract': verified_contract,
        **(overrides or {})})


def prepare_plan():
    _, contract = verified_contract()
    receipts = {}
    for stage, binding in contract['predecessorReceipts'].items():
        need(stage in {'finalize', 'readback'}, 'PREDECESSOR_RECEIPT_SCOPE_CHANGED')
        raw = execute('aws', 'ssm', 'get-command-invocation', '--region', 'ap-northeast-1',
            '--command-id', binding['commandId'], '--instance-id', r.INSTANCE, '--output', 'json')
        verify_native_receipt(raw, binding)
        receipts[stage] = raw
    need(set(receipts) == {'finalize', 'readback'}, 'PREDECESSOR_NOT_INDEPENDENTLY_VERIFIED')
    plan, admitted = namespace()['prepare_plan']()
    for stage, raw in receipts.items():
        (OUTPUT / ('shared-card-' + stage + '-native.json')).write_bytes(raw)
    return plan, admitted


def transport(plan, mode):
    return namespace()['transport'](plan, mode)


def main():
    namespace({'prepare_plan': prepare_plan, 'transport': transport})['publish']()


if __name__ == '__main__':
    need(len(sys.argv) == 1, 'DISPATCH_ARGUMENTS_INVALID')
    main()
