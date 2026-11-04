"""Use the established exact-main OIDC/SSM transport for the reviewed Admin delta."""
import argparse
import importlib.util
import inspect
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PREFIX = 'interaction-flow'
WORKFLOW = '.github/workflows/' + PREFIX + '-publication.yml'
OUT = ROOT / '.deploy' / PREFIX


def load(name):
    spec = importlib.util.spec_from_file_location('interaction_pub_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


R = load(PREFIX + '-runtime.py')
P = load('permission-loading-publication.py')
P.PREFIX, P.WORKFLOW, P.OUT, P.R = PREFIX, WORKFLOW, OUT, R
P.F.WORKFLOW, P.F.P = WORKFLOW, R
need, sha = R.need, R.sha


def contract():
    return json.loads((HERE / R.CONTRACT_FILE).read_bytes())


def check(c):
    R.validate_contract(c)
    need(P.F.git('merge-base', '--is-ancestor', c['reviewBase'], 'HEAD') is not None, 'REVIEW_BASE_REQUIRED')
    changed = set(P.F.git('diff', '--name-only', c['reviewBase'], 'HEAD').decode().splitlines())
    # Uncommitted preparation is checked with the same finite allowlist locally.
    changed.update(P.F.git('diff', '--name-only', 'HEAD').decode().splitlines())
    need(changed <= set(c['candidateFiles']), 'UNREVIEWED_EXTENSION')
    for name, expected in {**c['sources'], **c['validationSources']}.items():
        need(sha((ROOT / name).read_bytes()) == expected, 'SOURCE_CHANGED')
    for name, expected in c['helperPins'].items():
        need(sha((HERE / name).read_bytes()) == expected, 'INHERITED_CONTROL_CHANGED')
    need(sha((ROOT / WORKFLOW).read_bytes()) == c['workflowSha256']
         and sha((ROOT / 'package-lock.json').read_bytes()) == c['mainPackageLockSha256'], 'BUILD_INPUT_CHANGED')


def transport(plan, mode):
    source = inspect.getsource(P.F.transport)
    before = "directory/'financial-closure-release.py'"
    need(source.count(before) == 1, 'TRANSPORT_RECIPE_CHANGED')
    source = source.replace(before, "directory/'interaction-flow-runtime.py'")
    source = source.replace('financial-entry-', 'interaction-flow-entry-')
    source = source.replace('FINANCIAL_PUBLICATION|BITBROWSER_HISTORY', 'PERMISSION_LOADING|FINANCIAL_PUBLICATION|BITBROWSER_HISTORY')
    namespace = dict(P.F.__dict__)
    exec(compile(source, '<interaction-flow-transport>', 'exec'), namespace)
    return namespace['transport'](plan, mode, OUT)


P.check, P.transport = check, transport


def publish(c):
    source = inspect.getsource(P.publish)
    before = '仅修复查询未启用被误报权限不足；仅切换 Admin，保留 API、数据库和其他六个服务。'
    need(source.count(before) == 1, 'PUBLICATION_RECIPE_CHANGED')
    source = source.replace(before, '升级加载、切页、表格测量和会话草稿；仅切换 Admin，保留其他六个服务。')
    source = source.replace('切页权限提示修复 ', '加载与交互升级 ')
    namespace = dict(P.__dict__)
    exec(compile(source, '<interaction-flow-publication>', 'exec'), namespace)
    return namespace['publish'](c)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('check', 'build', 'publish', 'observe'))
    args = parser.parse_args()
    {'check': check, 'build': P.build, 'publish': publish, 'observe': P.observe}[args.mode](contract())
    if args.mode == 'check':
        print(json.dumps({'status': 'INTERACTION_FLOW_SOURCE_VERIFIED'}))
