"""Independent finite recharge successor, reusing the reviewed native publisher.

Historical source seals and cold origin validators remain unchanged on disk.
Only this isolated consumer namespace admits the sealed recharge overlay.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).parent
PREFIX = 'recharge-flow-successor'
SCOPE = 'RECHARGE_FLOW_API_ADMIN_SUCCESSOR'
CONTEXT = '.deploy/production-release/' + PREFIX + '-build-context'
PROJECTION = '.deploy/production-release/' + PREFIX + '-build-projection.json'
PROOF = '.deploy/production-release/' + PREFIX + '-build-proof.json'
PREFLIGHT = '.deploy/production-release/' + PREFIX + '-preflight.json'
LABEL = 'id-business-v2.recharge-flow-successor-projection-sha256'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


projection = load('recharge_flow_projection', 'recharge-flow-successor-projection.py')


def need(condition, code):
    if not condition:
        raise RuntimeError('RECHARGE_FLOW_' + code)


def source(d, producer):
    raw = d.registration_download(producer['commit'])
    need(type(raw) is bytes and 0 < len(raw) <= 128 * 1024 * 1024, 'SOURCE_ARCHIVE_INVALID')
    candidate = d.registration_archive(raw, producer['commit'])
    need(projection.source_tree(candidate) == producer['sourceTree'], 'SOURCE_TREE_CHANGED')
    for name in reused.HELPERS:
        path = 'scripts/production-release/' + name
        need(path in candidate and candidate[path][0] == (HERE / name).read_bytes(), 'EXECUTOR_SOURCE_CHANGED')
    output, record = projection.project_sources(d, candidate, producer['commit'], producer['sourceTree'])
    return candidate, output, record, projection.contract()['applicationInputSha256'], projection.digest(raw)


def configure_reused():
    c = load('recharge_flow_isolated_publisher', 'unpublished-component-successor.py')
    # These are future-consumer identifiers, never replacements for B/H/ONLINE
    # history. The original entry and all its constants remain independently callable.
    for name, value in {'PREFIX': PREFIX, 'SCOPE': SCOPE, 'BUILD_SCOPE': 'RECHARGE_FLOW_BUILD',
        'TRANSPORT_SCOPE': 'RECHARGE_FLOW_PREFLIGHT_TRANSPORT', 'CONTEXT': CONTEXT,
        'PROJECTION': PROJECTION, 'PROOF': PROOF, 'PREFLIGHT': PREFLIGHT, 'LABEL': LABEL,
        'APPLICATION_SOURCE': projection.BUSINESS_COMMIT,
        'APPLICATION_TREE': projection.contract()['businessTree'],
        'APPROVED_APPLICATION_INPUT_SHA256': projection.contract()['applicationInputSha256'],
        'APPLICATION_INPUT_COUNT': 76}.items():
        setattr(c, name, value)
    c.HELPERS = tuple(dict.fromkeys((*c.HELPERS, 'recharge-flow-successor.py',
        'recharge-flow-successor-readonly.py', 'recharge-flow-successor-projection.py',
        'recharge-flow-successor-contract.json', 'unpublished-component-runtime-diagnostic.py')))
    c.source = source
    c.projection_module = projection.projection_module
    original_migration_content = c.migration_image_content
    c.migration_image_content = lambda module, output: original_migration_content(
        module, {path[4:]: row for path, row in output.items() if path.startswith('api/')})
    return c


reused = configure_reused()


def __getattr__(name):
    return getattr(reused, name)


def prepare_local(output):
    """Only local source materialization for root's isolated compile review."""
    project = HERE.parent.parent.resolve()
    target = Path(output).absolute()
    need(target.resolve() == target and not target.exists()
         and target.is_relative_to(project / '.runtime')
         and not any(item.is_symlink() for item in target.parents), 'LOCAL_OUTPUT_INVALID')
    d = reused.modules()[0]
    d.registration_download = lambda commit: subprocess.check_output(
        ['git', 'archive', '--format=tar', '--prefix=id-business-system-' + commit + '/', commit], cwd=project)
    commit = projection.BUSINESS_COMMIT
    candidate = d.registration_archive(d.registration_download(commit), commit)
    for path, row in projection.contract()['approvedTestChanges'].items():
        raw = (project / path).read_bytes()
        need(projection.digest(raw) == row['after']['sha256'], 'TEST_SOURCE_CHANGED')
        candidate[path] = (raw, row['after']['mode'])
    tree = projection.source_tree(candidate)
    output_files, record = projection.project_sources(d, candidate, commit, tree)
    target.parent.mkdir(parents=True, exist_ok=True)
    d.write_registration_files(target, output_files)
    receipt = {'status': 'LOCAL_SOURCE_PROJECTION_ONLY', 'productionQualified': False,
        'businessCommit': commit, 'projection': record, 'output': str(target),
        'productionWrites': 0, 'businessActions': 0}
    target.with_name(target.name + '-projection.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
    return {'status': receipt['status'], 'output': str(target), 'projectionSha256': record['projectionSha256'],
        'apiContext': str(target / 'api'), 'adminContext': str(target / 'admin')}


def cli(argv=None):
    args = list(argv if argv is not None else __import__('sys').argv[1:])
    if args and args[0] == 'prepare-local':
        parser = argparse.ArgumentParser()
        parser.add_argument('operation', choices=('prepare-local',))
        parser.add_argument('--output', required=True)
        return prepare_local(parser.parse_args(args).output)
    import sys
    previous = sys.argv
    try:
        sys.argv = [str(HERE / 'recharge-flow-successor.py'), *args]
        return reused.cli()
    finally:
        sys.argv = previous


if __name__ == '__main__':
    try:
        print(json.dumps(cli(), sort_keys=True, separators=(',', ':')))
    except Exception as error:
        code = str(error) if re.fullmatch('(?:RECHARGE_FLOW|UNPUBLISHED_COMPONENT)_[A-Z0-9_]+', str(error)) else 'RECHARGE_FLOW_UNAVAILABLE'
        receipt = {'scope': SCOPE, 'status': 'RECHARGE_FLOW_FAILED', 'code': code,
                   'onlinePublished': False, 'migrationPerformed': False, 'businessActions': 0}
        if isinstance(error, reused.ComponentFailure):
            receipt = error.receipt
        print(json.dumps(receipt, sort_keys=True, separators=(',', ':')))
        raise SystemExit(1) from None
