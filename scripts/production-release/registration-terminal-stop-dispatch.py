"""Bind one native validation to one accepted API-only forward publication."""
import importlib.util
import json
from pathlib import Path
import types

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
NAME = 'registration-terminal-stop-20261017'
OUTPUT = ROOT / '.deploy' / NAME


def load(name):
    spec = importlib.util.spec_from_file_location('terminal_dispatch_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


r = load('registration-terminal-stop-release.py')


def verified_contract():
    raw = (HERE / 'registration-terminal-stop-contract.json').read_bytes()
    value = json.loads(raw)
    r.verify_contract(value)
    return raw, value


def rename(value):
    if isinstance(value, types.CodeType):
        return value.replace(co_consts=tuple(rename(item) for item in value.co_consts))
    if not isinstance(value, str):
        return value
    if "stage='ENTRY_DOWNLOAD'" in value:
        marker = ' contract=json.loads(raw)\n'
        r.need(value.count(marker) == 1, 'ENTRY_CONTRACT_RECIPE_CHANGED')
        value = value.replace(marker, marker + """ contract_path=entry/'registration-parity-diagnostics-contract.json'
 if contract_path.exists() or contract_path.is_symlink():
  if contract_path.is_symlink() or not contract_path.is_file() or contract_path.read_bytes()!=raw:raise RuntimeError('REGISTRATION_PARITY_DIAGNOSTICS_CONTRACT_ENTRY_CHANGED')
 else:
  descriptor=os.open(contract_path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
  with os.fdopen(descriptor,'wb') as output:output.write(raw)
""")
    for suffix in ('build.py', 'release.py', 'dispatch.py', 'contract.json', 'release.test.py', 'validation.yml'):
        value = value.replace('registration-parity-diagnostics-' + suffix, 'registration-terminal-stop-' + suffix)
    value = value.replace('注册流程证据的 API 与 Admin 精确增量；保存产物不代表生产切换或真实注册验收。',
                          '仅一个注册 Worker 文件的终止修复；保存产物不代表生产切换或真实注册成功。')
    return value.replace('registration-parity-diagnostics', NAME).replace('REGISTRATION_PARITY_DIAGNOSTICS', r.SCOPE)


def namespace():
    old = load('registration-parity-diagnostics-dispatch.py')
    values = {**old.__dict__, 'ROOT': ROOT, 'OUTPUT': OUTPUT, 'verified_contract': verified_contract, 'need': r.need}
    for name in ('prepare_plan', 'transport', 'publish'):
        original = getattr(old, name)
        values[name] = types.FunctionType(rename(original.__code__), values, name, original.__defaults__, original.__closure__)
    return values


if __name__ == '__main__':
    import sys
    r.need(len(sys.argv) == 1, 'DISPATCH_ARGUMENTS_INVALID')
    namespace()['publish']()
