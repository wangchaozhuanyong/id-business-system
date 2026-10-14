"""Read an already accepted ONLINE invocation; never submit an SSM command.

Original GitHub artifacts and native stdout/stderr stay in memory. Only a closed
summary of identities, controlled codes and hashes is saved in the workspace.
"""
import argparse
import ast
import base64
import gzip
import io
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import zipfile


def load_client():
    import importlib.util
    path = Path(__file__).with_name('online-recharge-component-readonly.py')
    spec = importlib.util.spec_from_file_location('online_component_diagnostic_client', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


client = load_client()
REPOSITORY = 'wangchaozhuanyong/id-business-system'
RESULT = 'online-recharge-component-evidence-diagnostic.json'
CAP = 4 * 1024 * 1024


def need(condition, code):
    client.r.need(condition, 'DIAGNOSTIC_' + code)


def read_command(arguments, cap=128 * 1024):
    # Only this closed command surface may cross the external transport.
    endpoint = arguments[-1] if arguments else ''
    github = (arguments == ['gh', 'api', '--help'] or
        (arguments[:2] == ['gh', 'api'] and (len(arguments) == 3 or
         len(arguments) == 4 and arguments[2] == '--allow-escape-sequences')
         and type(endpoint) is str and endpoint.startswith('repos/' + REPOSITORY + '/')))
    git = (len(arguments) == 3 and (arguments[:2] == ['git', 'show']
        and re.fullmatch('[a-f0-9]{40}:scripts/production-release/[a-z0-9.-]+', arguments[2]) is not None
        or arguments[:2] == ['git', 'rev-parse']
        and re.fullmatch('[a-f0-9]{40}\\^\\{tree\\}', arguments[2]) is not None))
    aws = (len(arguments) == 11 and arguments[:6]
        == ['aws', '--region', 'ap-northeast-1', 'ssm', 'get-command-invocation', '--command-id']
        and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', arguments[6]) is not None
        and arguments[7] == '--instance-id' and re.fullmatch('i-[a-f0-9]{8,17}', arguments[8]) is not None
        and arguments[9:] == ['--output', 'json'])
    allowed = github or git or aws
    need(allowed, 'COMMAND_FORBIDDEN')
    process = subprocess.run(arguments, capture_output=True, timeout=45)
    need(process.returncode == 0, 'READ_TRANSPORT_UNAVAILABLE')
    need(type(process.stdout) is bytes and 0 < len(process.stdout) < cap, 'READ_SIZE_INVALID')
    return process.stdout


def api(endpoint):
    need(endpoint.startswith('repos/' + REPOSITORY + '/'), 'REPOSITORY_CHANGED')
    return json.loads(read_command(['gh', 'api', endpoint]))


def artifact_bytes(identity):
    # Newer gh escapes binary/ANSI output by default; older gh lacks the flag.
    help_raw = read_command(['gh', 'api', '--help'])
    options = ['--allow-escape-sequences'] if b'--allow-escape-sequences' in help_raw else []
    return read_command(['gh', 'api', *options,
        'repos/' + REPOSITORY + '/actions/artifacts/' + str(identity) + '/zip'], CAP)


def json_member(archive, name):
    return client.r.c.load_core().closed_json(archive.read(name), 256 * 1024)


def authenticate_parameters(params, p, instance, mode='preflight', saved=None):
    need(mode in ('preflight', 'release', 'readback'), 'MODE_INVALID')
    need(type(params) is dict and set(params) == {'commands', 'executionTimeout'}
         and params['executionTimeout'] == ['1800' if mode == 'release' else '600'] and type(params['commands']) is list
         and len(params['commands']) == 1 and type(params['commands'][0]) is str, 'PARAMETERS_CHANGED')
    command = shlex.split(params['commands'][0])
    need(len(command) == 4 and command[:3] == ['python3', '-B', '-c'], 'PARAMETERS_CHANGED')
    match = re.fullmatch(r'import base64,gzip;exec\(compile\(gzip\.decompress\(base64\.b64decode\((.+),validate=True\)\),'
                        r'"<online-component-transport>","exec"\)\)', command[3])
    need(match is not None, 'PARAMETERS_CHANGED')
    packed = ast.literal_eval(match[1])
    need(type(packed) is str, 'PARAMETERS_CHANGED')
    program = client.r.bounded_gzip(base64.b64decode(packed, validate=True), 2 * 1024 * 1024)
    tree = ast.parse(program.decode('utf8'))
    # Read literal bindings only. No downloaded or artifact-provided code runs.
    stores = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
              and isinstance(node.func, ast.Name) and node.func.id == '_store_files']
    calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
             and isinstance(node.func, ast.Subscript) and isinstance(node.func.value, ast.Name)
             and node.func.value.id == 'client' and isinstance(node.func.slice, ast.Constant)
             and node.func.slice.value == 'server_arguments']
    need(len(stores) == len(calls) == 1 and not stores[0].keywords and not calls[0].keywords,
         'PARAMETERS_CHANGED')
    staging = '/opt/id-business-v2/.staging/online-component-' + '-'.join(
        p[n] for n in ('commit', 'workflowRunId', 'workflowRunAttempt'))
    store = [ast.literal_eval(item) for item in stores[0].args]
    need(len(store) == 4 and store[0] == staging and store[1] == p['commit'] and store[3] is False,
         'PARAMETERS_CHANGED')
    pins = store[2]
    core = client.r.c.load_core()
    helpers = (*core.HELPERS, 'online-recharge-component-consumer.py',
        'online-recharge-component-runtime.py', 'online-recharge-component-readonly.py')
    need(type(pins) is dict and set(pins) == set(helpers), 'HELPERS_CHANGED')
    for name, digest in pins.items():
        need(type(digest) is str and re.fullmatch('[a-f0-9]{64}', digest), 'HELPERS_CHANGED')
        raw = read_command(['git', 'show', p['commit'] + ':scripts/production-release/' + name],
                           2 * 1024 * 1024)
        need(client.r.c.digest(raw) == digest, 'HELPERS_CHANGED')
    args = [ast.literal_eval(item) for item in calls[0].args]
    need(len(args) == 6, 'PARAMETERS_CHANGED')
    expected_args = [mode, '--commit', p['commit'], '--source-tree', p['sourceTree'],
        '--run-id', p['workflowRunId'], '--run-attempt', p['workflowRunAttempt']]
    if mode != 'readback':
        expected_args += ['--expected-current', client.r.current_predecessor()]
    if mode == 'release':
        need(type(saved) is dict and all(name in saved for name in ('proof', 'preflight')), 'BUILD_EVIDENCE_MISSING')
        proof_arg = args[5]
        need(type(proof_arg) is str and proof_arg.startswith('gzip-base64:'), 'BUILD_EVIDENCE_CHANGED')
        proof_raw = client.r.bounded_gzip(base64.b64decode(proof_arg[len('gzip-base64:'):], validate=True), 256 * 1024)
        need(proof_raw == saved['proof'], 'BUILD_EVIDENCE_CHANGED')
        proof = core.closed_json(proof_raw, 256 * 1024)
        need(type(args[4]) is str, 'PREFLIGHT_CHANGED')
        preflight_raw = client.r.bounded_gzip(base64.b64decode(args[4], validate=True), 128 * 1024)
        transport = client.preflight_from_native(core, client.r, args[3], preflight_raw)
        need(transport == core.closed_json(saved['preflight'], 256 * 1024)
             and transport.get('producer') == p, 'PREFLIGHT_CHANGED')
        references = [row.get('reference') for row in proof.get('images', {}).values()]
        need(len(references) == 4 and all(type(row) is str and ':' in row for row in references), 'BUILD_EVIDENCE_CHANGED')
        repository = references[0].rsplit(':', 1)[0]
        quality_id = proof.get('qualityRunId')
        client.r.validate_build(proof, p, proof.get('sourceProjection'), transport, quality_id, repository)
        client.r.validate_preflight(core, transport, p, client.r.current_predecessor())
        projection = proof.get('sourceProjection', {})
        need(projection.get('candidateProducer') == p
             and client.r.c.fingerprint(projection) == transport['serverReceipt'].get('sourceProjectionSha256'),
             'BUILD_PRODUCER_CHANGED')
        quality = api('repos/' + REPOSITORY + '/actions/runs/' + quality_id)
        need(str(quality.get('id')) == quality_id and quality.get('path') == '.github/workflows/quality.yml'
             and quality.get('repository', {}).get('full_name') == REPOSITORY and quality.get('event') == 'push'
             and quality.get('status') == 'completed' and quality.get('conclusion') == 'success'
             and quality.get('head_sha') == p['commit'], 'QUALITY_CHANGED')
        expected_args += ['--repository', repository, '--ci-run-id', quality_id, '--api-fault-restore-approved']
    else:
        need(args[3:] == [None, None, None], 'PARAMETERS_CHANGED')
    need(args[0] == expected_args, 'PARAMETERS_CHANGED')
    for packed_native, authority in zip(args[1:3], (client.r.authority(), client.r.current_authority())):
        need(type(packed_native) is str and authority['instanceId'] == instance, 'NATIVE_BINDING_CHANGED')
        native = client.r.bounded_gzip(base64.b64decode(packed_native, validate=True), 128 * 1024)
        client.validate_sealed_native(core, authority, native)
    return client.r.c.fingerprint(params)


def original_evidence(run_id, attempt):
    need(re.fullmatch('[1-9][0-9]*', run_id or '') and re.fullmatch('[1-9][0-9]*', attempt or ''), 'SELECTION_INVALID')
    prefix = 'repos/' + REPOSITORY
    run = api(prefix + '/actions/runs/' + run_id + '/attempts/' + attempt)
    need(type(run) is dict and str(run.get('id')) == run_id and str(run.get('run_attempt')) == attempt
         and run.get('repository', {}).get('full_name') == REPOSITORY
         and run.get('path') == '.github/workflows/production-release.yml'
         and run.get('event') == 'workflow_dispatch' and run.get('head_branch') == 'main'
         and run.get('status') == 'completed' and run.get('conclusion') == 'failure'
         and type(run.get('head_sha')) is str and re.fullmatch('[a-f0-9]{40}', run['head_sha']), 'RUN_CHANGED')
    commit = api(prefix + '/commits/' + run['head_sha'])
    source_tree = commit.get('commit', {}).get('tree', {}).get('sha')
    need(commit.get('sha') == run['head_sha'] and type(source_tree) is str
         and re.fullmatch('[a-f0-9]{40}', source_tree), 'SOURCE_TREE_CHANGED')
    need(read_command(['git', 'rev-parse', run['head_sha'] + '^{tree}']).decode('ascii').strip() == source_tree,
         'SOURCE_TREE_CHANGED')
    p = client.r.producer(run['head_sha'], source_tree, run_id, attempt)
    jobs = api(prefix + '/actions/runs/' + run_id + '/attempts/' + attempt + '/jobs?per_page=100')
    matches = [row for row in jobs.get('jobs', []) if row.get('name') == 'release']
    need(len(matches) == 1 and matches[0].get('status') == 'completed'
         and matches[0].get('conclusion') == 'failure' and type(matches[0].get('id')) is int,
         'JOB_CHANGED')
    job = matches[0]
    need(job.get('head_sha', p['commit']) == p['commit'] and any(
        row.get('name') == 'Verify online recharge predecessor and idle workers before building'
        and row.get('conclusion') in ('success', 'failure') for row in job.get('steps', [])), 'JOB_CHANGED')
    listing = api(prefix + '/actions/runs/' + run_id + '/artifacts?per_page=100')
    artifact_name = 'online-recharge-evidence-' + run_id + '-' + attempt
    matches = [row for row in listing.get('artifacts', []) if row.get('name') == artifact_name]
    need(len(matches) == 1 and matches[0].get('expired') is False
         and type(matches[0].get('id')) is int and type(matches[0].get('size_in_bytes')) is int
         and 0 < matches[0]['size_in_bytes'] < CAP, 'ARTIFACT_CHANGED')
    artifact = matches[0]
    binding = artifact.get('workflow_run', {})
    need(str(binding.get('id', run_id)) == run_id and binding.get('head_sha', p['commit']) == p['commit'],
         'ARTIFACT_CHANGED')
    raw = artifact_bytes(artifact['id'])
    digest = artifact.get('digest')
    need(digest is None or digest == 'sha256:' + client.r.c.digest(raw), 'ARTIFACT_BYTES_CHANGED')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        rows = archive.infolist()
        need(len(rows) <= 30 and len({row.filename for row in rows}) == len(rows)
             and sum(row.file_size for row in rows) < CAP
             and all('/' not in row.filename and '\\' not in row.filename and not row.is_dir()
                     and row.file_size < 256 * 1024 for row in rows), 'ARTIFACT_MEMBERS_CHANGED')
        names = {row.filename for row in rows}
        mode = next((name for name in ('readback', 'release', 'preflight')
            if client.r.PREFIX + '-' + name + '-invocation-metadata.json' in names), None)
        need(mode is not None, 'ACCEPTED_METADATA_MISSING')
        stem = client.r.PREFIX + '-' + mode + '-'
        metadata = json_member(archive, stem + 'invocation-metadata.json')
        intent = json_member(archive, stem + 'send-intent.json')
        params = json_member(archive, stem + 'parameters.json')
        saved = ({'proof': archive.read(client.r.PREFIX + '-build-proof.json'),
                  'preflight': archive.read(client.r.PREFIX + '-preflight.json')} if mode == 'release' else None)
    instance = client.r.authority()['instanceId']
    need(type(metadata) is dict and set(metadata) == {'producer', 'mode', 'commandId', 'instanceId', 'status'}
         and metadata['producer'] == p and metadata['mode'] == mode and metadata['status'] == 'ACCEPTED'
         and metadata['instanceId'] == instance and type(metadata['commandId']) is str
         and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', metadata['commandId']), 'METADATA_CHANGED')
    need(type(intent) is dict and set(intent) == {'producer', 'mode', 'expectedCurrent', 'parametersSha256', 'status'}
         and intent['producer'] == p and intent['mode'] == mode
         and intent['expectedCurrent'] == client.r.current_predecessor()
         and intent['status'] == 'SUBMITTING_ONCE'
         and intent['parametersSha256'] == authenticate_parameters(params, p, instance, mode, saved), 'INTENT_CHANGED')
    return {'producer': p, 'mode': mode, 'commandId': metadata['commandId'], 'instanceId': instance,
            'evidenceJobId': str(job['id']), 'artifactId': str(artifact['id']),
            'artifactBytesSha256': client.r.c.digest(raw)}


def observe(binding):
    core = client.r.c.load_core()
    trace = {'phase': 'poll', 'accepted': True, 'commandId': binding['commandId'], 'instanceId': binding['instanceId']}
    try:
        raw = read_command(['aws', '--region', 'ap-northeast-1', 'ssm', 'get-command-invocation',
            '--command-id', binding['commandId'], '--instance-id', binding['instanceId'], '--output', 'json'])
        trace.update(client.native_details(raw))
        native = core.closed_json(raw, 128 * 1024)
        client.stage(trace, 'authenticate-native')
        need(type(native) is dict and native.get('CommandId') == binding['commandId']
             and native.get('InstanceId') == binding['instanceId'], 'NATIVE_IDENTITY_CHANGED')
        if native.get('Status') in ('Pending', 'InProgress', 'Delayed', 'Cancelling'):
            client.stage(trace, 'poll')
            return {**client.diagnostic_failure(RuntimeError('ONLINE_RECHARGE_COMPONENT_RESULT_NOT_ENDED'),
                binding['mode'], binding['producer'], trace), **binding}
        client.stage(trace, 'authenticate-native')
        if native.get('Status') == 'Failed':
            failure = client.validate_failure_native(core, raw, binding['producer'], binding['commandId'], binding['instanceId'])
            return {**client.diagnostic_failure(client.NativeFailure(failure), binding['mode'], binding['producer'], trace), **binding}
        if native.get('Status') != 'Success':
            client.stage(trace, 'poll')
            raise RuntimeError('ONLINE_RECHARGE_COMPONENT_RESULT_NOT_AUTHENTICATED')
        client.validate_native(core, raw, binding['mode'], binding['producer'], binding['commandId'], binding['instanceId'])
        return {**client.diagnostic_failure(RuntimeError('ONLINE_RECHARGE_COMPONENT_NATIVE_VERIFIED'),
            binding['mode'], binding['producer'], trace), **binding, 'outcome': 'VERIFIED_SUCCESS',
            'nativeAuthenticated': True, 'status': 'ONLINE_RECHARGE_COMPONENT_DIAGNOSTIC_VERIFIED'}
    except Exception as error:
        return {**client.diagnostic_failure(error, binding['mode'], binding['producer'], trace), **binding}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-run-id', required=True)
    parser.add_argument('--evidence-run-attempt', required=True)
    args = parser.parse_args(argv)
    try:
        result = observe(original_evidence(args.evidence_run_id, args.evidence_run_attempt))
    except Exception as error:
        result = client.diagnostic_failure(error, 'diagnostic', trace={'phase': 'diagnostic'})
    output = client.output_directory()
    client.write_once(client.r.c.load_core(), output / RESULT, result)
    print(json.dumps(result, sort_keys=True))
    # A diagnosed Failed invocation is a successful read-only observation.
    return 0 if result.get('nativeAuthenticated') is True and 'commandId' in result else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps(client.diagnostic_failure(error, 'diagnostic'), sort_keys=True))
        sys.exit(1)
