# Finite registration95 definitions loaded into the verified controller namespace.
REGISTRATION_INTERSTITIAL_ID = 'registration-worker-95-20261008'
REGISTRATION_INTERSTITIAL_FILE = 'deploy/aws/' + REGISTRATION_INTERSTITIAL_ID + '.json'
REGISTRATION_INTERSTITIAL_CURRENT = '4c170e661c871dc14dccc98a8d6e5cf983141341'
REGISTRATION_INTERSTITIAL_TREE = '32ae747dd13b66a9548eb7c1d66aaac106ba87ec'
REGISTRATION_INTERSTITIAL_PRODUCER = '65a1469507d66786f24cacc9751c068db09eab76772c6873cc3612de1b777d77'
REGISTRATION_INTERSTITIAL_PREVIOUS_PROFILE = '6f2d4fb8dd8997943c721de8a1f1acdc8fb2cbcf86ffde231438ad1ddbd4f4e8'
REGISTRATION_INTERSTITIAL_BASELINE_RAW = '5596aa182c7de15766ce0c77e0439f9c3d5840fd8f0e287ef7a968d4d35892aa'
REGISTRATION_INTERSTITIAL_BASELINE_CANONICAL = '5cd42dd7d592b58dd74fcfdcfaa6e6c34918532492120e359740e06bc71ae1d5'
REGISTRATION_INTERSTITIAL_SOURCE = '3ed6bfe598f87909cc29c03485d329fde7202ae6'
REGISTRATION_INTERSTITIAL_SOURCE_SHA256 = {'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py': 'ae791cd40c79b222e4d75992e65f4cab527c793da9a36f3656d3f40c65051c73'}
REGISTRATION_INTERSTITIAL_VALIDATION_SHA256 = {'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py': '8542a19b95c27d3441e1dc01f3b5ac95c2df75abb1cb3682f730c8733ec2ca4d'}
REGISTRATION_INTERSTITIAL_PROJECTION_SHA256 = 'a6912b88f9d364654647f9557a1b9ece473bda978db1c01adaedda5add1e846c'
REGISTRATION_INTERSTITIAL_HANDOFF = {'receiptSha256': '9cafed1290e22214cf09459ba019b0a544190af32497ff225a7313e72b4a0bf3', 'taskId': '252ab243-d96b-4928-8116-b83dedc1d240', 'attempt': 8, 'registered': True, 'passwordLoginVerified': False, 'mfaLoginVerified': False, 'windowExists': False, 'leaseActive': False, 'busy': False}
REGISTRATION_INTERSTITIAL_CONTROLS = REGISTRATION_FOLLOWUP_CONTROLS | frozenset({'scripts/production-release/registration-interstitial-95.py'})
REGISTRATION_INTERSTITIAL_PRIVATE = REGISTRATION_FOLLOWUP_API_ADMIN_PRIVATE | frozenset({
    'registration-recovery-audit.compose.json', 'order-archive-seal.reader.json', 'order-archive-cleanup.reader.json'})


def registration_interstitial_record(value):
    require(isinstance(value,dict) and len(value)==28 and historical_fingerprint(value)==REGISTRATION_INTERSTITIAL_BASELINE_CANONICAL,
        'Fixed registration interstitial actual94 baseline unavailable')
    require(value['status']=='VERIFIED_94_API815_RUNTIME_BASELINE' and value['manifest']['commit']==REGISTRATION_INTERSTITIAL_CURRENT
        and value['manifest']['sourceTree']==REGISTRATION_INTERSTITIAL_TREE and value['controllerSha256']==REGISTRATION_INTERSTITIAL_PRODUCER
        and value['profileSha256']==REGISTRATION_INTERSTITIAL_PREVIOUS_PROFILE and value['original80SealMatched']is True
        and value['readOnly']is True and type(value['databaseWrites'])is int and value['databaseWrites']==0
        and value['windowRestarted']is False and value['runtimeStable']is True and value['registrationIdle']is True,
        'Fixed registration interstitial actual94 baseline changed')
    return value


def registration_interstitial_profile_path():
    path=Path(__file__).absolute();message='Fixed registration interstitial carrier location changed'
    require(path.name=='remote-deploy.py' and path.resolve()==path and not path.is_symlink(),message)
    if path.parent.parent==BASE/'.staging':
        require(BASE.is_absolute() and BASE.resolve()==BASE and re.fullmatch(r'oidc-[a-f0-9]{40}',path.parent.name),message)
        target=path.parent/Path(REGISTRATION_INTERSTITIAL_FILE).name
    else:
        require(path.parent.name=='production-release' and path.parent.parent.name=='scripts',message)
        target=path.parents[2]/REGISTRATION_INTERSTITIAL_FILE
    require(target.resolve()==target and not target.is_symlink(),message)
    return target


def registration_interstitial_profile_bytes():
    path=registration_interstitial_profile_path()
    modes=(0o644,) if path.parent.parent==BASE/'.staging' else (0o644,0o664)
    return fixed_recharge_bytes(path,modes=modes,limit=128*1024)


def registration_interstitial_verify_carrier(source_sha,profile_sha):
    source=fixed_recharge_bytes(Path(__file__).absolute(),modes=(0o644,),limit=1024*1024)
    raw=registration_interstitial_profile_bytes()
    require(hashlib.sha256(source).hexdigest()==source_sha and hashlib.sha256(raw).hexdigest()==profile_sha,
        'Fixed registration interstitial carrier hash changed')
    value=registration_interstitial_profile(fixed_recharge_json(raw))
    require(value['controlSourceSha256']['scripts/production-release/remote-deploy.py']==source_sha,
        'Fixed registration interstitial carrier source changed')
    return value


def registration_interstitial_fixed():
    value=fixed_recharge_json(registration_interstitial_profile_bytes())
    return registration_interstitial_record(value['runtimeBaseline'])


def registration_interstitial_contract():
    return {'id':REGISTRATION_INTERSTITIAL_ID,'file':REGISTRATION_INTERSTITIAL_FILE,'current':REGISTRATION_INTERSTITIAL_CURRENT,
        'source':REGISTRATION_INTERSTITIAL_SOURCE,'sourceSha256':REGISTRATION_INTERSTITIAL_SOURCE_SHA256,
        'projectionSha256':REGISTRATION_INTERSTITIAL_PROJECTION_SHA256,'runtimeBaseline':registration_interstitial_fixed()}


def check_registration_interstitial_scope():
    root=Path(__file__).resolve().parents[2]
    profile=registration_interstitial_profile(fixed_recharge_json(fixed_recharge_bytes(root/REGISTRATION_INTERSTITIAL_FILE,modes=(0o644,0o664),limit=128*1024)))
    for name,digest in {**profile['registrationSourceSha256'],**profile['validationSourceSha256'],**profile['controlSourceSha256']}.items():
        require(hashlib.sha256(fixed_recharge_bytes(root/name,modes=(0o644,0o664,0o755,0o775))).hexdigest()==digest,
            'Fixed registration interstitial reviewed source changed')
    return root,profile


def registration_interstitial_history(previous):
    fixed=registration_interstitial_fixed();message='Fixed registration interstitial actual94 history changed'
    require(previous.is_absolute()and previous.resolve()==previous and previous.parent==BASE/'releases'and str(previous)==fixed['current'],message)
    observed={}
    def read(path,**options):
        raw=fixed_recharge_bytes(path,**options);require(path not in observed or observed[path][0]==raw,message)
        observed[path]=(raw,options);return raw
    for name,digest in fixed['fileSha256'].items():
        modes=(fixed['privateFileModes'][name],)if name in REGISTRATION_INTERSTITIAL_PRIVATE else(0o644,0o664,0o755,0o775)
        require(hashlib.sha256(read(previous/name,modes=modes)).hexdigest()==digest,message)
    public=fixed_recharge_file_map(previous,omitted=REGISTRATION_INTERSTITIAL_PRIVATE)
    require({'fileCount':len(public),'sha256':historical_fingerprint(public)}==fixed['publicSourceMap'],message)
    identity=main80_recharge_public_snapshot(previous,public)
    manifest=fixed_recharge_json(read(previous/'release-manifest.json',modes=(0o600,)))
    require(manifest==fixed['manifest']and set(manifest)==set(fixed['manifest']),message)
    producer=read(previous/'scripts/production-release/remote-deploy.py',modes=(0o644,))
    require(hashlib.sha256(producer).hexdigest()==REGISTRATION_INTERSTITIAL_PRODUCER,message)
    namespace={'__name__':'fixed_registration94_history_only','__file__':str(previous/'scripts/production-release/remote-deploy.py')}
    exec(compile(producer,namespace['__file__'],'exec'),namespace)
    require(namespace['BASE']==BASE,message)
    old_profile_raw=read(previous/REGISTRATION_FOLLOWUP_FILE,modes=(0o644,),limit=128*1024)
    require(hashlib.sha256(old_profile_raw).hexdigest()==REGISTRATION_INTERSTITIAL_PREVIOUS_PROFILE,message)
    old_profile=namespace['registration_profile'](fixed_recharge_json(old_profile_raw),profile_id=REGISTRATION_FOLLOWUP_ID)
    old_manifest,origin=namespace['registration_followup_api_admin_history'](Path(manifest['previousRelease']))
    require(manifest['previousCommit']==REGISTRATION_FOLLOWUP_RELEASE_CURRENT
        and manifest['previousManifestSha256']==fixed['historical815']['fileSha256']['release-manifest.json']
        and old_manifest==namespace['REGISTRATION_FOLLOWUP_API_ADMIN_BASELINE']['manifest'],message)
    # Reconstruct the original94 public projection from its exact archive, never current host code.
    archive=registration_download(REGISTRATION_INTERSTITIAL_CURRENT)
    require(hashlib.sha256(archive).hexdigest()==manifest['sourceArchiveSha256'],message)
    candidate=registration_archive(archive,REGISTRATION_INTERSTITIAL_CURRENT)
    require(candidate[REGISTRATION_FOLLOWUP_FILE][0]==old_profile_raw,message)
    namespace['registration_login_source'](old_profile,candidate)
    basis=registration_archive(registration_download(RECHARGE_SCOPE_CURRENT),RECHARGE_SCOPE_CURRENT)
    worker=namespace['registration_login_worker_projection'](old_profile,basis,candidate)
    runtime=namespace['registration_followup_api_admin_runtime'](Path(manifest['previousRelease']),candidate,worker,
        namespace['registration_contract'](REGISTRATION_FOLLOWUP_ID),old_profile)
    expected={name:(hashlib.sha256(raw).hexdigest(),0o755 if mode=='100755'else 0o644)for name,(raw,mode)in runtime.items()}
    expected['docker-compose.aws-mysql.yml']=(expected['docker-compose.aws-mysql.yml'][0],public['docker-compose.aws-mysql.yml'][1])
    require(public==expected,message)
    original=fixed_recharge_json(private_maintenance_receipt(origin/'before-audit.json'))['gate']
    audit_facts=[]
    for stage in ('before','after'):
        report=fixed_recharge_json(read(previous/(stage+'-audit.json'),modes=(fixed['privateFileModes'][stage+'-audit.json'],)))
        require(require_registration_zero_report(report,stage,original)==fixed['audits'][stage],message)
        audit_facts.append((report['checks'],report['identity']))
    require(audit_facts[0]==audit_facts[1],message)
    namespace['registration_followup_api_admin_carried'](previous)
    require(all(fixed_recharge_bytes(path,**options)==raw for path,(raw,options)in observed.items())
        and fixed_recharge_file_map(previous,omitted=REGISTRATION_INTERSTITIAL_PRIVATE)==public,message)
    require_main80_recharge_public_snapshot(identity)
    return manifest,origin


def registration_interstitial_baseline(previous,states=None):
    fixed=registration_interstitial_fixed();message='Fixed registration interstitial running baseline changed'
    pointer=(BASE/'current').resolve();live=registration_followup_api_admin_states(pointer)
    manifest,origin=registration_interstitial_history(previous)
    if pointer==previous:
        require(live==fixed['liveServices']and(states is None or states==live),message)
        path=previous/'scripts/production-release/remote-deploy.py';raw=fixed_recharge_bytes(path,modes=(0o644,))
        require(hashlib.sha256(raw).hexdigest()==REGISTRATION_INTERSTITIAL_PRODUCER,message)
        namespace={'__name__':'fixed_registration94_current_only','__file__':str(path)};exec(compile(raw,str(path),'exec'),namespace)
        require(namespace['check_registration_followup_deployment'](REGISTRATION_INTERSTITIAL_CURRENT,
            REGISTRATION_INTERSTITIAL_TREE,REGISTRATION_INTERSTITIAL_PREVIOUS_PROFILE)==fixed['readback'],message)
    else:
        require(states is None,message)
        raw=fixed_recharge_bytes(pointer/'release-manifest.json',modes=(0o600,));value=fixed_recharge_json(raw)
        require(value['previousRelease']==str(previous)and value['previousCommit']==REGISTRATION_INTERSTITIAL_CURRENT
            and value['previousManifestSha256']==fixed['fileSha256']['release-manifest.json']and value['servicesUpdated']==['auto-registration']
            and value['fixedRegistrationRelease']['id']==REGISTRATION_INTERSTITIAL_ID and'apiAdminPublication'not in value,message)
        require(registration_preserved_states(live)==registration_preserved_states(fixed['liveServices'])
            and live['auto-registration']['environmentSha256']==fixed['liveServices']['auto-registration']['environmentSha256'],message)
    registration_followup_api_admin_running(pointer)
    recharge_2f_running_hashes(pointer,recharge_2f_scope(fixed_recharge_json(fixed_recharge_bytes(
        Path(REGISTRATION_FOLLOWUP_BASELINE['current'])/RECHARGE_2F_FILE,modes=(0o644,),limit=128*1024))))
    require(registration_interstitial_history(previous)==(manifest,origin)and(BASE/'current').resolve()==pointer
        and registration_followup_api_admin_states(pointer)==live,message)
    if pointer!=previous:require(fixed_recharge_bytes(pointer/'release-manifest.json',modes=(0o600,))==raw,message)
    return manifest,origin


def registration_interstitial_runtime(previous,candidate,worker,contract,profile):
    fixed=registration_interstitial_fixed();public=fixed_recharge_file_map(previous,omitted=REGISTRATION_INTERSTITIAL_PRIVATE)
    require({'fileCount':len(public),'sha256':historical_fingerprint(public)}==fixed['publicSourceMap'],
        'Fixed registration interstitial public source changed')
    runtime={name:(fixed_recharge_bytes(previous/name,modes=(mode,)),'100755'if mode&0o111 else'100644')
        for name,(_digest,mode)in public.items()if not name.startswith(REGISTRATION_WORKER_PREFIX)}
    runtime.update({name:row for name,row in worker.items()if name.startswith(REGISTRATION_WORKER_PREFIX)})
    runtime.update({name:candidate[name]for name in REGISTRATION_INTERSTITIAL_CONTROLS|{contract['file']}})
    require(runtime[REGISTRATION_FOLLOWUP_FILE][0]==fixed_recharge_bytes(previous/REGISTRATION_FOLLOWUP_FILE,modes=(0o644,),limit=128*1024),
        'Fixed registration interstitial retained94 profile changed')
    registration_followup_api_admin_carried(previous)
    return runtime


def registration_interstitial_readback_receipt(current,tree,profile_sha,*,profile_id=REGISTRATION_INTERSTITIAL_ID):
    require(profile_id==REGISTRATION_INTERSTITIAL_ID,'Fixed registration interstitial selection changed')
    receipt=registration_readback_receipt(current,tree,profile_sha,profile_id=REGISTRATION_FOLLOWUP_ID)
    receipt.update(id=REGISTRATION_INTERSTITIAL_ID,previousCommit=REGISTRATION_INTERSTITIAL_CURRENT,
        registrationSourceCommit=REGISTRATION_INTERSTITIAL_SOURCE,workerProjectionSha256=REGISTRATION_INTERSTITIAL_PROJECTION_SHA256,
        registrationHandoff=REGISTRATION_INTERSTITIAL_HANDOFF)
    return receipt


def validate_registration_interstitial_readback(value,current,tree,profile_sha,*,profile_id=REGISTRATION_INTERSTITIAL_ID):
    expected=registration_interstitial_readback_receipt(current,tree,profile_sha,profile_id=profile_id)
    require(type(value)is dict and historical_fingerprint(value)==historical_fingerprint(expected) and all(type(value[name])is type(item)for name,item in expected.items()),
        'Fixed registration interstitial readback changed')
    return value

def registration_interstitial_profile(value):
    """No source, projection or confirmed window handoff is inferred from a draft."""
    require(isinstance(value,dict),'Fixed registration interstitial profile unavailable')
    api_admin=registration_interstitial_record(value.get('runtimeBaseline'))
    digest = lambda x: isinstance(x, str) and re.fullmatch(r'[a-f0-9]{64}', x) is not None
    keys = {'version', 'kind', 'id', 'enabled', 'expectedCurrent', 'baselineRelease',
        'registrationSourceCommit', 'workerBasisCommit', 'registrationSourceSha256',
        'validationSourceSha256', 'workerProjection', 'workerProjectionSha256',
        'apiBasisCommit', 'apiBasisProjectionSha256', 'apiProjectionSha256',
        'apiCompiledSourceSha256', 'apiCompiledSourceProjectionSha256',
        'buildInputSha256', 'controlSourceSha256', 'scope', 'financeValidator',
        'financeClearance', 'runtimeBaseline', 'registrationHandoff'}
    require(isinstance(value, dict) and set(value) == keys and type(value['version']) is int
        and value['version'] == 1 and value['enabled'] is True
        and value['kind'] == 'FIXED_REGISTRATION_RUNTIME_SCOPE' and value['id'] == REGISTRATION_INTERSTITIAL_ID
        and value['expectedCurrent'] == REGISTRATION_INTERSTITIAL_CURRENT
        and isinstance(REGISTRATION_INTERSTITIAL_SOURCE, str) and re.fullmatch(r'[a-f0-9]{40}', REGISTRATION_INTERSTITIAL_SOURCE)
        and value['registrationSourceCommit'] == REGISTRATION_INTERSTITIAL_SOURCE
        and value['workerBasisCommit'] == REGISTRATION_LOGIN_CURRENT
        and historical_fingerprint(value['baselineRelease']) == historical_fingerprint(REGISTRATION_BASELINE)
        and historical_fingerprint(value['runtimeBaseline']) == historical_fingerprint(api_admin)
        and historical_fingerprint(value['scope']) == historical_fingerprint(REGISTRATION_LOGIN_SCOPE)
        and historical_fingerprint(value['financeValidator']) == historical_fingerprint(REGISTRATION_FINANCE)
        and historical_fingerprint(value['financeClearance']) == historical_fingerprint(REGISTRATION_CLEARANCE), 'Fixed registration login scope unavailable')
    require(value['registrationSourceSha256'] == REGISTRATION_INTERSTITIAL_SOURCE_SHA256
        and isinstance(REGISTRATION_INTERSTITIAL_SOURCE_SHA256, dict)
        and set(REGISTRATION_INTERSTITIAL_SOURCE_SHA256) == {REGISTRATION_WORKER_PREFIX + 'registration_browser.py'}
        and all(digest(x) for x in REGISTRATION_INTERSTITIAL_SOURCE_SHA256.values())
        and value['validationSourceSha256'] == REGISTRATION_INTERSTITIAL_VALIDATION_SHA256
        and isinstance(REGISTRATION_INTERSTITIAL_VALIDATION_SHA256, dict)
        and set(REGISTRATION_INTERSTITIAL_VALIDATION_SHA256) == {REGISTRATION_WORKER_PREFIX + 'test_registration_browser.py'}
        and all(digest(x) for x in REGISTRATION_INTERSTITIAL_VALIDATION_SHA256.values())
        and isinstance(value['controlSourceSha256'], dict)
        and set(value['controlSourceSha256']) == REGISTRATION_INTERSTITIAL_CONTROLS
        and all(digest(x) for x in value['controlSourceSha256'].values())
        and value['buildInputSha256'] == {'.dockerignore': '9f69c1f476e723f1d8de9892058c34abc3817481b6d8259da4175c3f6293c05d',
            'scripts/audit-python-dependencies.py': '99b90a53943699d44c3fca8642db0ef7917ce618d2f3e09a4e30f31c127ee41c'},
        'Fixed registration login reviewed source unavailable')
    require(value['apiBasisCommit'] == REGISTRATION_CURRENT
        and value['apiBasisProjectionSha256'] == REGISTRATION_RECOVERY_API_BASIS_SHA256
        and value['apiProjectionSha256'] == REGISTRATION_RECOVERY_API_PROJECTION_SHA256
        and value['apiCompiledSourceSha256'] == REGISTRATION_RECOVERY_API_COMPILED_SHA256
        and value['apiCompiledSourceProjectionSha256'] == REGISTRATION_RECOVERY_API_COMPILED_PROJECTION_SHA256,
        'Fixed registration login retained API source changed')
    handoff = value['registrationHandoff']
    require(isinstance(handoff, dict) and handoff == REGISTRATION_INTERSTITIAL_HANDOFF
        and set(handoff) == {'receiptSha256', 'taskId', 'attempt', 'registered', 'passwordLoginVerified',
            'mfaLoginVerified', 'windowExists', 'leaseActive', 'busy'}
        and digest(handoff['receiptSha256']) and handoff['taskId'] == '252ab243-d96b-4928-8116-b83dedc1d240'
        and type(handoff['attempt']) is int and handoff['attempt'] == 8 and handoff['registered'] is True
        and type(handoff['passwordLoginVerified']) is bool and type(handoff['mfaLoginVerified']) is bool
        and handoff['windowExists'] is False and handoff['leaseActive'] is False and handoff['busy'] is False,
        'Fixed registration login confirmed handoff unavailable')
    projection = value['workerProjection']; old = REGISTRATION_LOGIN_WORKER_BASIS
    require(isinstance(projection, dict) and set(projection) == set(old) and len(old) == 60
        and all(isinstance(row, dict) and set(row) == {'mode', 'sha256'}
            and row['mode'] == old[name]['mode'] and digest(row['sha256']) for name, row in projection.items())
        and all(projection[name] == old[name] for name in old if name not in REGISTRATION_LOGIN_FILES)
        and all(projection[name]['sha256'] == {**value['registrationSourceSha256'], **value['validationSourceSha256']}[name]
            for name in REGISTRATION_LOGIN_FILES)
        and digest(REGISTRATION_INTERSTITIAL_PROJECTION_SHA256)
        and value['workerProjectionSha256'] == REGISTRATION_INTERSTITIAL_PROJECTION_SHA256 == historical_fingerprint(projection),
        'Fixed registration login Worker projection changed')
    return value

def prepare_registration_interstitial_build():
    root, profile = check_registration_interstitial_scope()
    names = profile['registrationSourceSha256'].keys() | profile['validationSourceSha256'].keys() | profile['controlSourceSha256'].keys()
    candidate = {name: (fixed_recharge_bytes(root / name, modes=(0o644, 0o664, 0o755, 0o775)),
        '100755' if (root / name).stat().st_mode & 0o111 else '100644') for name in names}
    basis = registration_archive(registration_download(RECHARGE_SCOPE_CURRENT), RECHARGE_SCOPE_CURRENT)
    worker = registration_login_worker_projection(profile, basis, candidate)
    output = root / '.deploy/production-release'
    require(not output.is_symlink() and not (root / '.deploy').is_symlink(), 'Fixed registration output changed')
    output.mkdir(parents=True, exist_ok=True)
    target = output / 'registration-build-projection.json'
    require(not target.exists() and not target.is_symlink(), 'Fixed registration output already exists')
    write_registration_files(output / 'registration-build-context', worker)
    manifest = {'version': 1, 'id': REGISTRATION_INTERSTITIAL_ID,
        'sourceCommit': run('git', '-C', str(root), 'rev-parse', 'HEAD'),
        'sourceTree': run('git', '-C', str(root), 'rev-parse', 'HEAD^{tree}'),
        'registrationSourceCommit': profile['registrationSourceCommit'], 'workerBasisCommit': REGISTRATION_LOGIN_CURRENT,
        'workerProjectionSha256': profile['workerProjectionSha256'],
        'registrationSourceSha256': profile['registrationSourceSha256'], 'validationSourceSha256': profile['validationSourceSha256'],
        'contextPath': '.deploy/production-release/registration-build-context'}
    target.write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest

def registration_interstitial_finance_audit(directory, receipt, *, stage, source, before_receipt=None, control_source=None, profile_id=REGISTRATION_INTERSTITIAL_ID):
    require(profile_id == REGISTRATION_INTERSTITIAL_ID, 'Fixed registration recovery audit selection changed')
    contract = registration_interstitial_contract()
    require(stage in ('before', 'after'), 'Fixed registration audit stage changed')
    require_registration_finance_source(source)
    policy, seal = reviewed_order_archive_seal(source, REGISTRATION_FINANCE['releaseSealSha256'],
        REGISTRATION_CURRENT, REGISTRATION_BASELINE['sourceTree'], REGISTRATION_FINANCE['preparedImagesSha256'],
        str(REGISTRATION_FINANCE['preparationRunId']), str(REGISTRATION_FINANCE['preparationRunAttempt']))
    frozen = {**REGISTRATION_FINANCE, 'sourceTree': policy['candidateBindings']['sourceTree'],
        'candidateCommit': REGISTRATION_CURRENT, 'candidateTree': REGISTRATION_BASELINE['sourceTree'],
        'images': seal['images'], 'migration': seal['migration']}
    control_source = control_source or Path(__file__).resolve().parents[2]
    profile_raw = fixed_recharge_bytes(control_source / contract['file'], modes=(0o644, 0o664), limit=128 * 1024)
    profile = registration_interstitial_profile(fixed_recharge_json(profile_raw))
    auditor = control_source / 'scripts/v2-registration-finance-audit.mjs'
    require(hashlib.sha256(fixed_recharge_bytes(auditor, modes=(0o644, 0o664))).hexdigest()
        == profile['controlSourceSha256']['scripts/v2-registration-finance-audit.mjs'],
        'Fixed registration reviewed source changed')
    override = fixed_recharge_json((directory / 'compose.release.json').read_bytes())
    audit_reference = (REGISTRATION_RECOVERY_BASELINE['manifest']['images']['api']['reference']
        if profile_id == REGISTRATION_INTERSTITIAL_ID else override['services']['api']['image'])
    image = json.loads(run('docker', 'image', 'inspect', audit_reference))[0]
    require(image['Id'] == seal['images']['api']
        == REGISTRATION_RECOVERY_BASELINE['manifest']['images']['api']['digest'], 'Order archive audit image changed')
    audit_override = registration_recovery_audit_override(control_source, image['Id'])
    env = os.environ.copy(); env['V2_DATA_INTEGRITY_DATABASE_URL'] = maintenance_container_audit_url(
        environment_values(directory / '.env.aws.production'))
    identity = registration_recovery_audit_reader(directory, audit_override)
    seal_reader = prepare_post_cleanup_reader_copy(control_source, ORDER_ARCHIVE_SEAL,
        REGISTRATION_FINANCE['releaseSealSha256'], 'order-archive-seal.reader.json', identity)
    cleanup_reader = prepare_post_cleanup_reader_copy(control_source, POST_CLEANUP_RECEIPT,
        HISTORY_POST_CLEANUP_RECEIPT_SHA256, 'order-archive-cleanup.reader.json', identity)
    mounts = ['-v', f'{source / "scripts"}:/app/scripts:ro', '-v', f'{source / "deploy/aws"}:/release-policy:ro',
        '-v', f'{auditor}:/registration-control/audit.mjs:ro',
        '-v', f'{control_source / contract["file"]}:/registration-control/profile.json:ro',
        '-v', f'{seal_reader}:/release-order-archive-seal.json:ro',
        '-v', f'{cleanup_reader}:/release-cleanup-receipt.json:ro']
    arguments = ['node', '/registration-control/audit.mjs', '--profile=/registration-control/profile.json',
        f'--policy=/release-policy/{HISTORY_ORDER_ARCHIVE_POLICY_ID}.json', f'--stage={stage}',
        '--seal=/release-order-archive-seal.json', '--cleanup-receipt=/release-cleanup-receipt.json']
    if stage == 'after':
        require(before_receipt is not None, 'Fixed registration before audit missing')
        require_registration_zero_report(fixed_recharge_json(private_maintenance_receipt(before_receipt)), 'before', frozen)
        prepare_registration_recovery_before_receipt(directory, before_receipt, audit_override)
        mounts.extend(['-v', f'{before_receipt}:/release-before-audit.json:ro'])
        arguments.append('--before-receipt=/release-before-audit.json')
    else:
        require(before_receipt is None, 'Fixed registration audit stage changed')
    report = fixed_recharge_json(compose(directory, '-f', str(audit_override), 'run', '--rm', '--no-deps', '--pull', 'never',
        *mounts, '-e', 'V2_DATA_INTEGRITY_DATABASE_URL', 'api', *arguments, env=env, timeout=240).encode())
    summary = require_registration_zero_report(report, stage, frozen)
    if stage == 'after':
        before = fixed_recharge_json(private_maintenance_receipt(before_receipt))
        require(before['checks'] == report['checks'] and before['identity'] == report['identity'],
                'Fixed registration integrity facts changed')
    receipt.write_text(json.dumps(report, indent=2) + '\n'); receipt.chmod(0o600)
    return summary

def registration_interstitial_release(args):
    profile_observation = True
    hydration = False
    continuation = initial = email = callback = email_request = email_observation = False
    profile_id = REGISTRATION_INTERSTITIAL_ID
    contract = registration_interstitial_contract()
    updated_services = registration_updated_services(profile_id)
    require(getattr(args, 'registration_worker_95', False) is True and all((not getattr(args, name, False) for name in ('registration_worker_b8_80', 'registration_worker_956', 'registration_worker_85', 'registration_worker_86', 'registration_worker_87', 'registration_worker_88', 'registration_worker_89', 'registration_worker_90', 'registration_worker_91', 'registration_worker_92', 'registration_worker_93', 'registration_worker_94'))), 'Fixed registration selection changed')
    require(args.expected_current == contract['current'] and (not args.admin_only) and (not getattr(args, 'api_admin_only', False)) and (not getattr(args, 'api_admin_build_proof', None)) and (not getattr(args, 'recharge_pro_main80', False)) and (not getattr(args, 'recharge_pro_974', False)) and (not getattr(args, 'recharge_pro_2f', False)) and all((not getattr(args, name) for name in ('historical_finance_exception', 'historical_finance_continuation', 'historical_finance_recharge_diagnostics', 'historical_finance_maintenance_continuation', 'historical_finance_mailbox_batch', 'recharge_pro_menu_b8', 'recharge_pro_menu_7f', 'historical_finance_post_cleanup', 'historical_finance_order_archive', 'post_cleanup_seal_sha256', 'order_archive_seal_sha256', 'order_archive_prepared_images_sha256'))) and ((args.image_commit or args.commit) == args.commit) and ((args.image_run_id or args.run_id) == args.run_id) and ((args.image_run_attempt or args.run_attempt) == args.run_attempt), 'Fixed registration selection changed')
    require(all((re.fullmatch('[a-f0-9]{40}', value or '') for value in (args.commit, args.source_tree))) and all((re.fullmatch('[1-9][0-9]*', value or '') for value in (args.run_id, args.run_attempt, args.ci_run_id))) and re.fullmatch('[0-9]{12}\\.dkr\\.ecr\\.ap-northeast-1\\.amazonaws\\.com/id-business-v2-release', args.repository), 'Fixed registration selection changed')
    require(isinstance(REGISTRATION_INTERSTITIAL_SOURCE, str) and re.fullmatch(r'[a-f0-9]{40}', REGISTRATION_INTERSTITIAL_SOURCE)
        and isinstance(REGISTRATION_INTERSTITIAL_PROJECTION_SHA256, str) and re.fullmatch(r'[a-f0-9]{64}', REGISTRATION_INTERSTITIAL_PROJECTION_SHA256)
        and isinstance(REGISTRATION_INTERSTITIAL_HANDOFF, dict), 'Fixed registration login source unavailable')
    registration_interstitial_profile(fixed_recharge_json(registration_interstitial_profile_bytes()))
    os.umask(63)
    with (BASE / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        previous = (BASE / 'current').resolve()
        states = registration_followup_api_admin_states(previous)
        (old_manifest, origin) = registration_interstitial_baseline(previous, states)
        assert_release_jobs_idle(previous, ('auto-registration',))
        assert_no_active_registration(previous)
        stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
        release = BASE / 'releases' / (stamp + '-' + args.commit[:12])
        step = 'source'
        changed = False
        try:
            candidate_raw = registration_download(args.commit)
            candidate = registration_archive(candidate_raw, args.commit)
            profile_raw = candidate[contract['file']][0]
            profile = registration_interstitial_profile(fixed_recharge_json(profile_raw))
            basis_raw = registration_download(RECHARGE_SCOPE_CURRENT)
            basis = registration_archive(basis_raw, RECHARGE_SCOPE_CURRENT)
            worker = registration_login_worker_projection(profile,basis,candidate)
            finance_raw = registration_download(REGISTRATION_CURRENT)
            require(hashlib.sha256(finance_raw).hexdigest() == REGISTRATION_BASELINE['sourceArchiveSha256'], 'Fixed registration finance archive changed')
            runtime = registration_interstitial_runtime(previous,candidate,worker,contract,profile)
            write_registration_files(release, runtime)
            # Retain the independently proven815 build/preservation receipts as private bytes.
            for name in ('api-admin-build-proof.json', 'api-admin-preservation.json'):
                raw = fixed_recharge_bytes(previous / name, modes=(REGISTRATION_FOLLOWUP_API_ADMIN_BASELINE['privateFileModes'][name],))
                require(hashlib.sha256(raw).hexdigest() == REGISTRATION_FOLLOWUP_API_ADMIN_BASELINE['fileSha256'][name], 'Fixed registration retained API Admin receipt changed')
                (release / name).write_bytes(raw); (release / name).chmod(0o600)
            for name in ('docker-compose.aws-mysql.yml', '.env.aws.production'):
                shutil.copy2(previous / name, release / name)
            (release / '.env.aws.production').chmod(384)
            environment = fixed_recharge_bytes(previous / '.env.aws.production')
            finance_source = prepare_registration_finance_source(args, finance_raw)
            require(shutil.disk_usage(BASE).free > 6 * 1024 ** 3, 'Insufficient free disk before pull')
            step = 'audit-before'
            before_audit = registration_interstitial_finance_audit(previous, release / 'before-audit.json', stage='before', source=finance_source, control_source=release, profile_id=profile_id)
            step = 'images'
            references = {name: args.repository + ':' + args.commit + '-' + args.run_id + '-' + args.run_attempt + '-' + ('auto-recharge' if name == 'auto-registration' else name) for name in updated_services}
            images = {}
            registry = args.repository.split('/')[0]
            password = run('aws', 'ecr', 'get-login-password', '--region', 'ap-northeast-1')
            logged = subprocess.run(['docker', 'login', '--username', 'AWS', '--password-stdin', registry], input=password, capture_output=True, text=True)
            require(logged.returncode == 0, 'ECR login failed')
            try:
                for (name, reference) in references.items():
                    run('docker', 'pull', reference, timeout=900)
                    image = json.loads(run('docker', 'image', 'inspect', reference))[0]
                    require(image['Architecture'] == 'amd64' and image['Config']['Labels'].get('org.opencontainers.image.revision') == args.commit and (not hydration or name != 'admin' or image['Config']['Labels'].get('id-business-v2.admin-projection-sha256') == profile['adminProjectionSha256']), 'Fixed registration image changed')
                    require(image['Config']['Labels'].get('id-business-v2.worker-projection-sha256') == profile['workerProjectionSha256'], 'Fixed registration login image projection changed')
                    images[name] = image
            finally:
                subprocess.run(['docker', 'logout', registry], capture_output=True, text=True)
            override = fixed_recharge_json((previous / 'compose.release.json').read_bytes())
            for (name, reference) in references.items():
                override['services'][name]['image'] = reference
            (release / 'compose.release.json').write_text(json.dumps(override, indent=2) + '\n')
            require(shutil.disk_usage(BASE).free > 2 * 1024 ** 3, 'Insufficient free disk after pull')
            step = 'backup'
            backup = fresh_backup(previous)
            (release / 'backup-verification.json').write_text(json.dumps(backup, indent=2) + '\n')
            (release / 'backup-verification.json').chmod(384)
            require((BASE / 'current').resolve() == previous, 'Fixed registration baseline changed')
            require(registration_followup_api_admin_states(previous) == states, 'Fixed registration baseline changed')
            require_diagnostics_environment_unchanged(previous, release, environment)
            registration_interstitial_baseline(previous, states)
            assert_release_jobs_idle(previous, ('auto-registration',))
            step = 'switch'
            assert_no_active_registration(previous)
            changed = True
            compose(release, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', *updated_services, timeout=300)
            for name in updated_services:
                wait_healthy(release, name)
            registration_worker_hashes(release, profile)
            registration_followup_api_admin_running(release, profile)
            step = 'audit-after'
            after_audit = registration_interstitial_finance_audit(release, release / 'after-audit.json', stage='after', source=finance_source, before_receipt=release / 'before-audit.json', control_source=release, profile_id=profile_id)
            after = registration_followup_api_admin_states(release)
            require(registration_selected_preserved_states(after, profile_id) == registration_selected_preserved_states(states, profile_id) and all((after[name]['image'] == images[name]['Id'] and after[name]['reference'] == references[name] for name in updated_services)) and (not (hydration or profile_observation) or all((after[name]['environmentSha256'] == states[name]['environmentSha256'] for name in updated_services))), 'Fixed registration preserved service changed')
            require_diagnostics_environment_unchanged(previous, release, environment)
            registration_worker_hashes(release, profile)
            registration_followup_api_admin_running(release, profile)
            require_registration_finance_source(finance_source)
            manifest = dict(old_manifest)
            manifest.pop('apiAdminPublication', None)
            manifest.update(commit=args.commit, sourceBranch='main', sourceTree=args.source_tree, previousCommit=contract['current'], previousRelease=str(previous), previousManifestSha256=contract['runtimeBaseline']['fileSha256']['release-manifest.json'], deploymentRun='github-actions-' + args.run_id + '-' + args.run_attempt, imageBuildRun='github-actions-' + args.run_id + '-' + args.run_attempt, ciWorkflow='Quality Gate', ciWorkflowRunId=int(args.ci_run_id), releaseTag='v2-production-' + stamp, sourceArchiveSha256=hashlib.sha256(candidate_raw).hexdigest(), servicesUpdated=list(updated_services), migrationApplied=False, newMigrations=[], databaseGrants={'status': 'SKIPPED', 'reason': 'FIXED_REGISTRATION_NO_MIGRATIONS'}, dataAuditBefore=before_audit, dataAuditAfter=after_audit, backupBeforeRelease=backup['name'], deployedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
            manifest['images'] = {**old_manifest['images'], **{name: {'reference': references[name], 'digest': images[name]['Id'], 'sourceCommit': args.commit} for name in updated_services}}
            manifest['fixedRegistrationRelease'] = {'id': contract['id'], 'profileRawSha256': hashlib.sha256(profile_raw).hexdigest(), 'registrationSourceCommit': contract['source'], 'workerBasisCommit': REGISTRATION_LOGIN_CURRENT, 'workerProjectionSha256': contract['projectionSha256'], 'financeSourceCommit': REGISTRATION_CURRENT, 'financePolicyId': HISTORY_ORDER_ARCHIVE_POLICY_ID, 'financeMode': REGISTRATION_CLEARANCE['mode'], 'clearanceSealSha256': historical_fingerprint(REGISTRATION_CLEARANCE), 'environmentUnchanged': True, 'migrationStatus': 'SKIPPED', 'databaseGrantSyncStatus': 'SKIPPED', 'cacheStatus': 'SKIPPED'}
            manifest['fixedRegistrationRelease'].update(apiRuntimeRevision=REGISTRATION_FOLLOWUP_RELEASE_CURRENT, apiBuildProofSha256=historical_fingerprint(REGISTRATION_FOLLOWUP_API_ADMIN_BASELINE['buildProof']), apiContentSha256=REGISTRATION_FOLLOWUP_API_ADMIN_BASELINE['buildProof']['images']['api']['sha256'], adminContentSha256=REGISTRATION_FOLLOWUP_API_ADMIN_BASELINE['buildProof']['images']['admin']['sha256'], apiBasisCommit=REGISTRATION_CURRENT, apiBasisProjectionSha256=profile['apiBasisProjectionSha256'], apiProjectionSha256=profile['apiProjectionSha256'], apiCompiledSourceProjectionSha256=profile['apiCompiledSourceProjectionSha256'], registrationHandoff=profile['registrationHandoff'])
            manifest['fixedRegistrationPreservedStates'] = {'before': registration_selected_preserved_states(states, profile_id), 'after': registration_selected_preserved_states(after, profile_id)}
            manifest['rollback'] = {'release': str(previous), 'images': {name: states[name]['image'] for name in updated_services}, 'servicesAdded': []}
            (release / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
            require((BASE / 'current').resolve() == previous, 'Fixed registration baseline changed')
            point_current(release, stamp + '-publish')
            print(json.dumps({'status': 'DEPLOYED', 'commit': args.commit, 'servicesUpdated': list(updated_services), 'migrationApplied': False, 'auditViolations': 0, 'unchangedServiceContainersPreserved': True}), flush=True)
            return 0
        except Exception as error:
            rollback_ok = True
            if changed:
                try:
                    registration_rollback(previous, release, states)
                    if (BASE / 'current').resolve() == release:
                        point_current(previous, stamp + '-recover')
                except Exception:
                    rollback_ok = False
            print(json.dumps({'status': 'DEPLOY_FAILED', 'step': step, 'errorType': type(error).__name__, 'rollbackOk': rollback_ok, 'servicesStarted': list(updated_services) if changed else []}), flush=True)
            return 1

def check_registration_interstitial_deployment(expected_current, source_tree, profile_raw_sha256, *, profile_id=REGISTRATION_INTERSTITIAL_ID):
    require(profile_id == REGISTRATION_INTERSTITIAL_ID, 'Fixed registration recovery selection changed')
    contract = registration_interstitial_contract()
    updated_services = registration_updated_services(profile_id)
    receipt = registration_interstitial_readback_receipt(expected_current, source_tree, profile_raw_sha256, profile_id=profile_id)
    validate_registration_interstitial_readback(receipt, expected_current, source_tree, profile_raw_sha256, profile_id=profile_id)
    current = (BASE / 'current').resolve()
    require(current.parent == BASE / 'releases'
        and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + expected_current[:12], current.name),
        'Fixed registration readback unavailable')
    profile_raw = fixed_recharge_bytes(current / contract['file'], modes=(0o644, 0o664), limit=128 * 1024)
    require(hashlib.sha256(profile_raw).hexdigest() == profile_raw_sha256, 'Fixed registration profile changed')
    profile = registration_interstitial_profile(fixed_recharge_json(profile_raw))
    if profile_id == REGISTRATION_INTERSTITIAL_ID:
        registration_followup_api_admin_carried(current)
    if profile_id == REGISTRATION_EMAIL_OBSERVATION_ID and REGISTRATION_EMAIL_OBSERVATION_PRO_BASELINE is not None:
        registration_observation_pro_profile(current)
    reviewed = {name: (fixed_recharge_bytes(current / name, modes=(0o644, 0o664, 0o755, 0o775)), '100644')
                for name in profile['registrationSourceSha256'].keys() | profile['validationSourceSha256'].keys() | profile['controlSourceSha256'].keys()}
    registration_login_source(profile, reviewed)
    manifest = fixed_recharge_json(private_maintenance_receipt(current / 'release-manifest.json'))
    require(manifest.get('commit') == expected_current and manifest.get('sourceTree') == source_tree
        and manifest.get('previousCommit') == contract['current']
        and manifest.get('previousManifestSha256') == contract['runtimeBaseline']['fileSha256']['release-manifest.json']
        and manifest.get('servicesUpdated') == list(updated_services) and manifest.get('migrationApplied') is False
        and manifest.get('newMigrations') == []
        and manifest.get('databaseGrants') == {'status': 'SKIPPED', 'reason': 'FIXED_REGISTRATION_NO_MIGRATIONS'},
        'Fixed registration manifest changed')
    provenance = {'id': contract['id'],
        'profileRawSha256': profile_raw_sha256, 'registrationSourceCommit': contract['source'],
        'workerBasisCommit': REGISTRATION_LOGIN_CURRENT, 'workerProjectionSha256': contract['projectionSha256'],
        'financeSourceCommit': REGISTRATION_CURRENT, 'financePolicyId': HISTORY_ORDER_ARCHIVE_POLICY_ID,
        'financeMode': REGISTRATION_CLEARANCE['mode'],
        'clearanceSealSha256': historical_fingerprint(REGISTRATION_CLEARANCE),
        'environmentUnchanged': True, 'migrationStatus': 'SKIPPED', 'databaseGrantSyncStatus': 'SKIPPED',
        'cacheStatus': 'SKIPPED'}
    if profile_id == REGISTRATION_INTERSTITIAL_ID:
        provenance.update(apiRuntimeRevision=REGISTRATION_FOLLOWUP_RELEASE_CURRENT, apiBuildProofSha256=historical_fingerprint(REGISTRATION_FOLLOWUP_API_ADMIN_BASELINE['buildProof']), apiContentSha256=REGISTRATION_FOLLOWUP_API_ADMIN_BASELINE['buildProof']['images']['api']['sha256'], adminContentSha256=REGISTRATION_FOLLOWUP_API_ADMIN_BASELINE['buildProof']['images']['admin']['sha256'], apiBasisCommit=REGISTRATION_CURRENT, apiBasisProjectionSha256=profile['apiBasisProjectionSha256'],
            apiProjectionSha256=profile['apiProjectionSha256'],
            apiCompiledSourceProjectionSha256=profile['apiCompiledSourceProjectionSha256'], registrationHandoff=profile['registrationHandoff'])
    if profile_id == REGISTRATION_HYDRATION_ID:
        provenance.update(adminSourceCommit=profile['adminSourceCommit'], adminBasisCommit=REGISTRATION_CURRENT,
            adminProjectionSha256=profile['adminProjectionSha256'])
    require(manifest.get('fixedRegistrationRelease') == provenance, 'Fixed registration manifest provenance changed')
    previous = Path(manifest['previousRelease'])
    old_manifest, _origin = registration_interstitial_baseline(previous)
    require('apiAdminPublication' not in manifest and manifest.get('fixedRechargeRelease') == old_manifest.get('fixedRechargeRelease')
        and manifest.get('fixedRechargePreservedStates') == old_manifest.get('fixedRechargePreservedStates'),
        'Fixed registration followup preserved Pro provenance changed')
    images = manifest['images']
    require(set(images) == set(old_manifest['images'])
        and all(images[name] == old_manifest['images'][name] for name in images if name not in updated_services),
        'Fixed registration preserved image changed')
    live = registration_followup_api_admin_states(current)
    saved = manifest['fixedRegistrationPreservedStates']
    require(set(saved) == {'before', 'after'} and saved['before'] == saved['after']
        == registration_selected_preserved_states(live, profile_id)
        and all(row['status'] == 'running' for row in live.values())
        and all(live[name]['health'] == 'healthy' for name in ALL_SERVICES if name != 'caddy'),
        'Fixed registration preserved service changed')
    if contract['runtimeBaseline'] is not None:
        require(registration_selected_preserved_states(live, profile_id) == registration_selected_preserved_states(
            contract['runtimeBaseline']['liveServices'], profile_id), 'Fixed registration continuation preserved service changed')
    if profile_id in (REGISTRATION_INTERSTITIAL_ID,):
        require(all(live[name]['environmentSha256'] == contract['runtimeBaseline']['liveServices'][name]['environmentSha256']
            for name in updated_services), 'Fixed hydration updated service environment changed')
    run_id = manifest['deploymentRun']
    require(re.fullmatch(r'github-actions-[1-9][0-9]*-[1-9][0-9]*', run_id)
        and manifest['imageBuildRun'] == run_id, 'Fixed registration image provenance changed')
    for service in updated_services:
        reference = images[service]['reference']
        require(re.fullmatch(r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release:'
            + expected_current + '-' + run_id.removeprefix('github-actions-') + '-' + ('auto-recharge' if service == 'auto-registration' else service), reference)
            and images[service]['sourceCommit'] == expected_current
            and live[service]['reference'] == reference
            and live[service]['image'] == images[service]['digest'],
            'Fixed registration image provenance changed')
        metadata = json.loads(run('docker', 'image', 'inspect', live[service]['image']))[0]
        require(metadata['Architecture'] == 'amd64' and metadata['Id'] == live[service]['image']
            and metadata['Config']['Labels'].get('org.opencontainers.image.revision') == expected_current
            and (profile_id != REGISTRATION_HYDRATION_ID or service != 'admin'
                or metadata['Config']['Labels'].get('id-business-v2.admin-projection-sha256')
                    == profile['adminProjectionSha256']),
            'Fixed registration image provenance changed')
        if profile_id == REGISTRATION_INTERSTITIAL_ID:
            require(metadata['Config']['Labels'].get('id-business-v2.worker-projection-sha256') == profile['workerProjectionSha256'], 'Fixed registration login image projection changed')
    require((current / 'docker-compose.aws-mysql.yml').read_bytes() == (previous / 'docker-compose.aws-mysql.yml').read_bytes()
        and (current / '.env.aws.production').read_bytes() == (previous / '.env.aws.production').read_bytes()
        and fixed_recharge_json((current / 'compose.release.json').read_bytes()) == {
            'services': {name: {'image': images[name]['reference'], 'pull_policy': 'never'}
                         for name in (*SERVICES, 'migrate')}}, 'Fixed registration configuration changed')
    original = fixed_recharge_json(private_maintenance_receipt(_origin / 'before-audit.json'))['gate']
    audit_facts = []
    for stage in ('before', 'after'):
        report = fixed_recharge_json(private_maintenance_receipt(current / (stage + '-audit.json')))
        summary = require_registration_zero_report(report, stage, original)
        require(manifest['dataAudit' + stage.title()] == summary, 'Fixed registration audit changed')
        audit_facts.append((report['checks'], report['identity']))
    require(audit_facts[0] == audit_facts[1], 'Fixed registration audit facts changed')
    registration_worker_hashes(current, profile)
    if profile_id == REGISTRATION_INTERSTITIAL_ID:
        registration_followup_api_admin_running(current, profile)
    require((BASE / 'current').resolve() == current, 'Fixed registration current changed')
    require(registration_followup_api_admin_states(current) == live, 'Fixed registration current service changed')
    if profile_id == REGISTRATION_INTERSTITIAL_ID:
        registration_followup_api_admin_carried(current)
    if profile_id == REGISTRATION_EMAIL_OBSERVATION_ID and REGISTRATION_EMAIL_OBSERVATION_PRO_BASELINE is not None:
        registration_observation_pro_profile(current)
    return validate_registration_interstitial_readback(receipt, expected_current, source_tree, profile_raw_sha256, profile_id=profile_id)

def registration_interstitial_main(tokens):
    parser=argparse.ArgumentParser()
    for name in ('commit','source-tree','repository','expected-current','run-id','run-attempt','ci-run-id'):
        parser.add_argument('--'+name,required=True)
    parser.add_argument('--registration-worker-95',action='store_true',required=True)
    for name in ('image-commit','image-run-id','image-run-attempt'):parser.add_argument('--'+name)
    args=parser.parse_args(tokens)
    for name in ('admin_only','api_admin_only','api_admin_build_proof','recharge_pro_main80','recharge_pro_974','recharge_pro_2f',
        'historical_finance_exception','historical_finance_continuation','historical_finance_recharge_diagnostics',
        'historical_finance_maintenance_continuation','historical_finance_mailbox_batch','recharge_pro_menu_b8','recharge_pro_menu_7f',
        'historical_finance_post_cleanup','historical_finance_order_archive','post_cleanup_seal_sha256','order_archive_seal_sha256',
        'order_archive_prepared_images_sha256'):
        setattr(args,name,None)
    return registration_interstitial_release(args)


def registration_interstitial_cli(tokens):
    if tokens[:1]in (['--check-fixed-registration-scope'],['--prepare-fixed-registration-build']):
        require(tokens[1:]==['--registration-profile',REGISTRATION_INTERSTITIAL_ID],'Fixed registration interstitial selection changed')
        if tokens[0]=='--prepare-fixed-registration-build':
            print('REGISTRATION_PROJECTION_PREPARED '+json.dumps(prepare_registration_interstitial_build(),sort_keys=True,separators=(',',':')))
        else:check_registration_interstitial_scope();print('REGISTRATION_PROFILE_VERIFIED')
    elif tokens[:1]==['--check-fixed-registration-deployment']:
        require(tokens[-2:]==['--registration-profile',REGISTRATION_INTERSTITIAL_ID]and len(tokens)==9,
            'Fixed registration interstitial readback unavailable')
        values=dict(zip(tokens[1:-2:2],tokens[2:-2:2]));require(set(values)=={'--expected-current','--source-tree','--registration-profile-sha256'},
            'Fixed registration interstitial readback unavailable')
        print('FIXED_REGISTRATION_RELEASE_VERIFIED '+json.dumps(check_registration_interstitial_deployment(
            values['--expected-current'],values['--source-tree'],values['--registration-profile-sha256']),sort_keys=True,separators=(',',':')))
    else:return registration_interstitial_main(tokens)
    return 0
