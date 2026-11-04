"""Rebuild the published main source and the new exact main source; no artifact reuse."""
import importlib.util
from pathlib import Path


def build(c, plan, qa, capture, out, runtime):
    path = Path(__file__).with_name('permission-loading-build.py')
    spec = importlib.util.spec_from_file_location('interaction_parent_build', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.build(c, plan, qa, capture, out, runtime)
