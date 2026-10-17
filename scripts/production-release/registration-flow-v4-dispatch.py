"""Bind this task's native validation to one finite accepted publication.

Reuse the established immutable artifact/SSM transport in a private namespace;
the old dispatcher, its accepted operation IDs and its contract are unchanged.
"""
import importlib.util
import json
from pathlib import Path
import types

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
NAME = 'registration-flow-v4-20261017'
OUTPUT = ROOT / '.deploy' / NAME


def load(name):
    spec = importlib.util.spec_from_file_location('repair_dispatch_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


r = load('registration-flow-v4-release.py')


def verified_contract():
    raw = (HERE / 'registration-flow-v4-contract.json').read_bytes()
    value = json.loads(raw)
    r.verify_contract(value)
    return raw, value


def rename(value):
    if isinstance(value, types.CodeType):
        return value.replace(co_consts=tuple(rename(item) for item in value.co_consts))
    if not isinstance(value, str):
        return value
    for suffix in ('build.py', 'release.py', 'dispatch.py', 'contract.json', 'release.test.py', 'validation.yml'):
        value = value.replace('registration-parity-diagnostics-' + suffix, 'registration-flow-v4-' + suffix)
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
