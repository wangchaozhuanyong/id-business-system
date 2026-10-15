"""Complete one already applied native switch without rebuilding or replacing services."""
import ast
import fcntl
import hashlib
import json
from pathlib import Path
import tempfile


def need(condition, code):
    if not condition:
        raise RuntimeError('RECHARGE_RECORD_FINALIZE_' + code)


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def verified_proof(m, artifact, plan, contract, stage):
    # The original build added its Dockerfile to the extracted build directory.
    # Revalidate the immutable archive, never that subsequently modified directory.
    with tempfile.TemporaryDirectory(prefix='finalization-proof-', dir=stage) as directory:
        payload = m.safe_archive(artifact, Path(directory) / 'original')
        proof_raw = (payload / 'build-proof.json').read_bytes()
        need(m.digest(proof_raw) == plan['buildProofSha256'], 'PROOF_CHANGED')
        return m.validate_proof(json.loads(proof_raw), plan, contract, payload)


def declared_models(d, previous, target, before_reference, after_reference):
    old = json.loads(d.compose(previous, 'config', '--format', 'json'))
    new = json.loads(d.compose(target, 'config', '--format', 'json'))
    need(old['services']['api']['image'] == before_reference
         and new['services']['api']['image'] == after_reference, 'DECLARED_IMAGE_CHANGED')
    new['services']['api']['image'] = before_reference

    def original_paths(value):
        if isinstance(value, dict):
            return {k: original_paths(v) for k, v in value.items()}
        if isinstance(value, list):
            return [original_paths(v) for v in value]
        if isinstance(value, str):
            if value == str(target):
                return str(previous)
            return value.replace(str(target) + '/', str(previous) + '/')
        return value

    need(old == original_paths(new), 'DECLARED_CONFIGURATION_CHANGED')
    return old


def finish_function(controller):
    """Use the exact original completion statements; never replay the switch."""
    tree = ast.parse(Path(controller.__file__).read_text())
    release = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'release')
    body = next(n for n in release.body if isinstance(n, ast.With)).body
    anchors = [i for i, node in enumerate(body)
               if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
               and isinstance(node.value.func, ast.Name) and node.value.func.id == 'need'
               and len(node.value.args) == 2 and isinstance(node.value.args[1], ast.Constant)
               and node.value.args[1].value == 'IMAGE_MISMATCH']
    need(len(anchors) == 1, 'COMPLETION_SOURCE_CHANGED')
    signature = ('plan,contract,d,previous,raw_manifest,before,stage,payload,proof,'
                 'images,backup,target,stamp,after,failure_path')
    function = ast.parse('def finish(' + signature + '):\n    pass\n').body[0]
    function.body = body[anchors[0]:]
    module = ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[]))
    namespace = dict(controller.__dict__)
    exec(compile(module, controller.__file__ + ':existing-switch-completion', 'exec'), namespace)
    return namespace['finish']


def finalize(m, d, plan, contract, expected_after, original_failure, finalizer_commit, *, verify_only=False):
    """All runtime commands before the final pointer update are read-only."""
    need(original_failure == {'commandId': '368cdef2-a0a7-492a-afa7-957497f17842',
                              'code': 'RECHARGE_RECORD_RUNTIME_CONFIGURATION_CHANGED'},
         'ORIGINAL_FAILURE_CHANGED')
    need(plan['commit'] == 'e197218c8b387a37c99da9b2e924712196f088e2'
         and plan['workflowRunId'] == '38710839862', 'ORIGINAL_OPERATION_CHANGED')
    base = m.BASE
    with (base / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        previous = (base / 'current').resolve()
        need(str(previous) == contract['current'], 'CURRENT_CHANGED')
        raw_manifest = (previous / 'release-manifest.json').read_bytes()
        need(m.digest(raw_manifest) == contract['manifestSha256'], 'MANIFEST_CHANGED')
        stage = base / '.staging' / ('recharge-record-' + plan['commit'] + '-' + plan['workflowRunId'])
        failure_path = stage / 'switch-state.json'
        switch = json.loads(failure_path.read_bytes())
        target = Path(switch['target'])
        need(switch == {'commit': plan['commit'], 'previous': str(previous),
                        'status': 'SWITCH_STARTED', 'target': str(target)}
             and target.parent == base / 'releases'
             and target.name.endswith('-' + plan['commit'][:12] + '-recharge-record'),
             'SWITCH_STAGE_CHANGED')
        need(not (target / 'recharge-record-preservation.json').exists(), 'ALREADY_FINALIZED')
        before = contract['services']
        after = m.snapshot(d, target)
        need(after == expected_after and all(after[n] == before[n] for n in m.PRESERVED),
             'SERVICES_CHANGED')
        need(all(after[n]['environmentSha256'] == before[n]['environmentSha256']
                 for n in m.SERVICES), 'ENVIRONMENT_CHANGED')
        need(all(v['status'] == 'running' and v['health'] in ('healthy', None)
                 for v in after.values()), 'SERVICE_UNHEALTHY')
        artifact = (stage / 'artifact.tar.gz').read_bytes()
        need(m.digest(artifact) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        proof = verified_proof(m, artifact, plan, contract, stage)
        payload = None  # The original completion tail only needs the verified proof.
        for name, expected in {**contract['changedSources'], **contract['publishedAdminSources']}.items():
            path = target / name
            need(path.resolve().is_relative_to(target) and not path.is_symlink()
                 and m.digest(path.read_bytes()) == expected, 'SOURCE_CHANGED')
        for name, key in (('recharge-record-release.py', 'controllerSha256'),
                          ('remote-deploy.py', 'releaseUtilitySha256'),
                          ('recharge-record-contract.json', 'contractSha256')):
            need(m.digest((target / 'scripts/production-release' / name).read_bytes()) == plan[key],
                 'ORIGINAL_CONTROL_CHANGED')
        reference = 'id-business-v2-records:' + plan['commit'] + '-' + plan['workflowRunId'] + '-api'
        image = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
        old_image = json.loads(d.run('docker', 'image', 'inspect', before['api']['image']))[0]
        need(image['Id'] == after['api']['image'] and after['api']['reference'] == reference,
             'API_IMAGE_CHANGED')
        need(image['RootFS']['Layers'][:len(old_image['RootFS']['Layers'])] == old_image['RootFS']['Layers']
             and {k: v for k, v in image['Config'].items() if k != 'Labels'}
             == {k: v for k, v in old_image['Config'].items() if k != 'Labels'},
             'IMAGE_CONFIGURATION_CHANGED')
        need(image['Config']['Labels'] == {**(old_image['Config'].get('Labels') or {}),
              'org.opencontainers.image.revision': plan['commit'],
              'id-business-v2.recharge-record-build-proof-sha256': plan['buildProofSha256']},
             'IMAGE_LABELS_CHANGED')
        declared = declared_models(d, previous, target, before['api']['reference'], reference)
        api = json.loads(d.run('docker', 'inspect', after['api']['containerId']))[0]
        host = api['HostConfig']
        need(host['ReadonlyRootfs'] is True and host['Init'] is True
             and host['CapDrop'] == ['ALL'] and host['SecurityOpt'] == ['no-new-privileges:true']
             and host['Privileged'] is False and host['NetworkMode'] == '20260821t095106z_default',
             'API_SECURITY_CONFIGURATION_CHANGED')
        original_volumes = json.loads(raw_manifest)['actualDeployment']['services']['api']['volumeNames']
        need(sorted(v['Name'] for v in api['Mounts'] if v['Type'] == 'volume') == original_volumes
             and len(api['Mounts']) == len(original_volumes), 'API_VOLUMES_CHANGED')
        expected_health = declared['services']['api']['healthcheck']
        actual_health = api['Config']['Healthcheck']
        need(actual_health['Test'] == expected_health['test'] and actual_health['Retries'] == expected_health['retries'],
             'API_HEALTHCHECK_CHANGED')
        code = "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync(" + json.dumps(m.MODULE) + ")).digest('hex'))"
        need(d.compose(target, 'exec', '-T', 'api', 'node', '-e', code) == proof['files']['api/recharge-validation.js'],
             'API_CONTENT_CHANGED')
        backup_path = base / 'backups' / ('recharge-record-' + plan['commit'] + '-' + plan['workflowRunId']) / 'backup-verification.json'
        backup = json.loads(backup_path.read_bytes())
        backup_file = Path(backup['path'])
        need(backup['s3Verified'] is True and backup['retentionActions'] == 0
             and backup_file.is_file() and m.digest(backup_file.read_bytes()) == backup['sha256']
             and backup_file.stat().st_size == backup['size'], 'BACKUP_CHANGED')
        import base64
        head = json.loads(d.run('aws', 's3api', 'head-object', '--region', 'ap-northeast-1',
                               '--bucket', backup['s3Bucket'], '--key', backup['s3Key'], '--checksum-mode', 'ENABLED'))
        need(head.get('ContentLength') == backup['size'] and head.get('ServerSideEncryption') == 'AES256'
             and head.get('ChecksumSHA256') == base64.b64encode(bytes.fromhex(backup['sha256'])).decode(),
             'BACKUP_S3_CHANGED')
        m.verify_admin_content(d, after['admin'], contract)
        m.guards(d, target, after, contract)
        if verify_only:
            return {'status': 'EXISTING_SWITCH_FINALIZATION_GUARDS_VERIFIED',
                    'commit': plan['commit'], 'servicesSha256': fingerprint(after),
                    'declaredConfigurationPreserved': True, 'backupReverified': True,
                    'newContainerOperations': 0, 'businessActions': 0}
        images = {'api': {'reference': reference, 'imageId': image['Id']}}
        stamp = target.name.split('-', 1)[0]
        own_source = Path(__file__).read_bytes()
        own_target = target / 'scripts/production-release/recharge-record-finalize.py'
        need(not own_target.exists() or own_target.read_bytes() == own_source,
             'FINALIZER_SOURCE_CHANGED')
        own_target.write_bytes(own_source)
        result = finish_function(m)(plan, contract, d, previous, raw_manifest, before, stage,
                                    payload, proof, images, backup, target, stamp, after, failure_path)
        completion = {'status': 'EXISTING_NATIVE_SWITCH_FINALIZED', 'deployedCommit': plan['commit'],
                      'finalizerCommit': finalizer_commit, 'originalWorkflowRunId': plan['workflowRunId'],
                      'finalizerSha256': hashlib.sha256(own_source).hexdigest(),
                      'originalFailure': original_failure, 'originalWorkflowPublishResult': 'failure',
                      'declaredConfigurationPreserved': True, 'environmentValuesPreserved': True,
                      'sixContainersPreserved': True, 'newContainerOperations': 0,
                      'backupReverified': True, 'migrationPerformed': False, 'businessActions': 0}
        (target / 'recharge-record-finalization.json').write_text(json.dumps(completion, sort_keys=True, indent=2) + '\n')
        manifest_path = target / 'release-manifest.json'
        manifest = json.loads(manifest_path.read_bytes())
        manifest['publicationFinalization'] = completion
        manifest_path.write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        return {**result, 'completion': completion}
