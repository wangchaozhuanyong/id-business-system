"""Fixed-scope production diagnostics and approved cleanup, without secret output."""
import argparse
import base64
import fcntl
import gzip
import hashlib
import importlib.util
import json
import time
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

BASE = Path('/opt/id-business-v2')
EXPECTED = '63e7c3b9fdb462517373b48f338626dafaf856ca'
PREVIOUS = 'a9530728a1b15d3dbb49fe7c38aa3c87e385467f'
REVIEWED_BASELINES = {
    EXPECTED: PREVIOUS,
    'cecc14b530fd32d595fe5ae14612fbde68ae9175': EXPECTED,
}
READ_ONLY_BASELINES = {
    'e7c9862d58599995954883f1c1f6038283afffab': {
        'release': '20261008T020705Z-e7c9862d5859',
        'manifestSha256': '52f2582e5edeb9e1c9af63c70fff4ca5a5bdad11c0fd7fb8f090fd1670b4c2eb',
        'previousRelease': '20261007T221905Z-04570d75c779',
        'previousCommit': '04570d75c779fd91a0933ef9416f6d62698b6b91',
        'previousManifestSha256': '0aacc82fc257bc2c4837a4b513223a01ec4f608fbacc0b009c1551b5ceb18b97',
    },
}
APPROVED_SCOPE = 'audit-routine-20261002T110000Z'
CUTOFF = '2026-10-02 11:00:00'
MAX_APPROVED_COUNT = 19848
LEGACY_PLAN_SHA256 = 'fd03e4c0590d803b8f2f2722bf88f89bb0b1a900c74d9107b651192589b6a3a8'
RETENTION_MIGRATION = '20261002123500_routine_audit_retention_exception'
RETENTION_MIGRATION_SHA256 = 'e00ead9e611e506a877848f96390c00078f600ed8df628dedb99573ceb5b31b3'
ROUTINE_ACTIONS = (
    'id_business_v2.website_visit.collect',
    'id_business_v2.exchange_rate.schedule.claim',
    'id_business_v2.exchange_rate.collect.started',
    'id_business_v2.exchange_rate.collect.success',
    'id_business_v2.exchange_rate.fx_snapshot.collect',
)


def read(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=120)
    if result.returncode:
        mysql_error = re.search(r'ERROR (\d+) \(([A-Z0-9]+)\)', result.stderr)
        if mysql_error:
            raise RuntimeError('Diagnostic MySQL error ' + mysql_error[1] + ' (' + mysql_error[2] + ')')
        raise RuntimeError('Diagnostic command failed; details suppressed')
    return result.stdout.strip()


def archived_images(path, deadline=None):
    """Read Docker save metadata and hash small config members without extracting files."""
    configs = {}
    manifest = None
    with tarfile.open(path, 'r|*') as archive:
        for member in archive:
            require(deadline is None or time.monotonic() < deadline,
                    'Archive metadata time budget exceeded')
            if not member.isfile() or member.size > 4 * 1024 * 1024:
                continue
            name = member.name.removeprefix('./')
            config_match = re.fullmatch(r'(?:blobs/sha256/)?([a-f0-9]{64})(?:\.json)?', name)
            if name != 'manifest.json' and not config_match:
                continue
            source = archive.extractfile(member)
            if source is None:
                continue
            payload = source.read(4 * 1024 * 1024 + 1)
            if config_match:
                configs[config_match[1]] = hashlib.sha256(payload).hexdigest() == config_match[1]
            else:
                manifest = json.loads(payload)
    if not isinstance(manifest, list):
        return []
    result = []
    for item in manifest:
        match = re.fullmatch(r'(?:blobs/sha256/)?([a-f0-9]{64})(?:\.json)?', item.get('Config', ''))
        if match and configs.get(match[1]):
            result.append({'imageId': 'sha256:' + match[1], 'configVerified': True,
                           'repoTags': item.get('RepoTags') or []})
    return result


def archive_inventory():
    root = BASE / 'artifacts'
    if not root.is_dir() or root.is_symlink():
        return []
    result = []
    deadline = time.monotonic() + 120
    for path in sorted(root.rglob('*')):
        if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(root):
            continue
        require(len(result) < 500, 'Artifact inventory exceeds reviewed bound')
        stat = path.stat()
        item = {'path': str(path.relative_to(BASE)), 'bytes': stat.st_size,
                'mtimeNs': stat.st_mtime_ns}
        if path.name.endswith(('.tar', '.tar.gz', '.tgz')):
            try:
                item['dockerImages'] = archived_images(path, deadline)
            except (tarfile.TarError, ValueError, OSError):
                item['archiveMetadataStatus'] = 'UNAVAILABLE'
        result.append(item)
    return result


def diagnose(expected=EXPECTED):
    initial_baseline = readonly_baseline(expected)
    project = None
    for line in (initial_baseline[0] / '.env.aws.production').read_text().splitlines():
        if line.startswith('COMPOSE_PROJECT_NAME='):
            project = line.split('=', 1)[1].strip()
            break
    if not project or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,62}', project):
        raise RuntimeError('Unexpected Compose project')
    containers = read('docker', 'ps', '-q', '--filter',
                      'label=com.docker.compose.project=' + project).splitlines()
    mysql = read('docker', 'ps', '-q', '--filter',
                 'label=com.docker.compose.project=' + project, '--filter',
                 'label=com.docker.compose.service=mysql').splitlines()
    if len(mysql) != 1:
        raise RuntimeError('Expected exactly one production MySQL container')
    image_ids = sorted(set(read('docker', 'image', 'ls', '--no-trunc', '--quiet').splitlines()))
    image_format = ('{"id":{{json .Id}},"repoTags":{{json .RepoTags}},'
                    '"sizeBytes":{{json .Size}},"architecture":{{json .Architecture}},'
                    '"created":{{json .Created}}}')
    image_inventory = [json.loads(read('docker', 'image', 'inspect', '--format',
                                      image_format, image_id)) for image_id in image_ids]
    container_image_ids = sorted({read('docker', 'inspect', '--format', '{{.Image}}', item)
                                  for item in read('docker', 'ps', '-a', '-q').splitlines()})
    actions = ','.join("'" + action + "'" for action in ROUTINE_ACTIONS)
    queries = [
        "SELECT JSON_OBJECT('kind','tables','table',TABLE_NAME,'estimatedRows',TABLE_ROWS,"
        "'dataBytes',DATA_LENGTH,'indexBytes',INDEX_LENGTH,'freeBytes',DATA_FREE) "
        "FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() "
        "ORDER BY DATA_LENGTH+INDEX_LENGTH DESC LIMIT 20",
        "SELECT JSON_OBJECT('kind','auditTotal','count',COUNT(*),'oldest',MIN(created_at),"
        "'newest',MAX(created_at)) FROM audit_logs",
        "SELECT JSON_OBJECT('kind','auditActions','module',module,'action',action,"
        "'count',COUNT(*),'oldest',MIN(created_at),'newest',MAX(created_at)) "
        "FROM audit_logs GROUP BY module,action ORDER BY COUNT(*) DESC",
        "SELECT JSON_OBJECT('kind','auditForeignKeys','table',TABLE_NAME,'column',COLUMN_NAME) "
        "FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA=DATABASE() "
        "AND REFERENCED_TABLE_NAME='audit_logs'",
        "SELECT JSON_OBJECT('kind','routineCandidates','action',a.action,'count',COUNT(*)) "
        "FROM audit_logs a WHERE a.module='id_business_v2' AND a.action IN (" + actions + ") "
        "AND a.user_id IS NULL AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.after_data,'$.triggerType')),'') <> 'manual' AND a.created_at < '2026-10-02 11:00:00' AND NOT EXISTS (SELECT 1 FROM "
        "id_business_v2_governance_job_items g WHERE g.result_audit_log_id=a.id) "
        "GROUP BY a.action",
    ]
    sql = 'SET TRANSACTION READ ONLY; START TRANSACTION; ' + '; '.join(queries) + '; ROLLBACK;'
    mysql_output = read('docker', 'exec', mysql[0], 'sh', '-c',
                        'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql '
                        '--host=127.0.0.1 --user=root --database="$MYSQL_DATABASE" '
                        '--batch --skip-column-names --execute "$1"', 'sh', sql)
    memory = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key, value = line.split(':', 1)
        if key in ('MemTotal', 'MemAvailable', 'MemFree', 'Cached', 'Buffers',
                   'SwapTotal', 'SwapFree', 'SReclaimable'):
            memory[key + 'Bytes'] = int(value.split()[0]) * 1024
    disk = shutil.disk_usage(BASE)
    result = {
        'mode': 'READ_ONLY', 'currentCommit': expected, 'memory': memory,
        'disk': {'totalBytes': disk.total, 'usedBytes': disk.used, 'freeBytes': disk.free},
        'allLocalImages': image_inventory, 'allContainerImageIds': container_image_ids,
        'containers': [json.loads(row) for row in read('docker', 'stats', '--no-stream',
                       '--format', '{{json .}}', *containers).splitlines()],
        'directories': read('du', '-x', '-B1', '--max-depth=1', '/var/lib/docker',
                            '/var/log', '/opt/id-business-v2').splitlines(),
        'database': [json.loads(row) for row in mysql_output.splitlines()],
        'candidateCutoffUtc': '2026-10-02T11:00:00Z',
        'archiveInventory': archive_inventory(),
    }
    receipt_dir = BASE / 'maintenance/storage-cleanup-20261002'
    for name in ('audit-cleanup-receipt.json', 'audit-before.json', 'audit-after.json'):
        path = receipt_dir / name
        if path.is_file() and not path.is_symlink():
            result.setdefault('maintenanceReceipts', {})[name] = json.loads(path.read_text())
    backups = sorted((BASE / 'backups/mysql').glob('id-business-v2-*.sql.gz'))
    result['latestLocalBackupName'] = backups[-1].name if backups else None
    require(readonly_baseline(expected) == initial_baseline,
            'Production baseline changed during diagnostics')
    return result


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def baseline(expected):
    require(expected in REVIEWED_BASELINES, 'Scope production baseline differs')
    require((BASE / 'current').resolve().parent == BASE / 'releases', 'Unexpected release path')
    manifest = json.loads((BASE / 'current/release-manifest.json').read_text())
    require(manifest['commit'] == expected, 'Production baseline changed')
    previous = Path(manifest['previousRelease']).resolve()
    require(previous.parent == BASE / 'releases', 'Unexpected rollback path')
    require(json.loads((previous / 'release-manifest.json').read_text())['commit'] == REVIEWED_BASELINES[expected],
            'Rollback baseline changed')
    return (BASE / 'current').resolve()


def readonly_baseline(expected):
    """Pin the diagnostic release chain without widening cleanup authorization."""
    reviewed = READ_ONLY_BASELINES.get(expected)
    if reviewed is None:
        directory = baseline(expected)
    else:
        directory = (BASE / 'current').resolve()
        require(directory == BASE / 'releases' / reviewed['release'], 'Unexpected release path')
    manifest_bytes = (directory / 'release-manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    require(manifest['commit'] == expected, 'Production baseline changed')
    previous = Path(manifest['previousRelease']).resolve()
    manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
    if reviewed is not None:
        require(Path(manifest['previousRelease']) == BASE / 'releases' / reviewed['previousRelease']
                and previous == BASE / 'releases' / reviewed['previousRelease'],
                'Unexpected rollback path')
        require(manifest.get('previousCommit') == reviewed['previousCommit'], 'Rollback baseline changed')
        require(manifest_sha == reviewed['manifestSha256'], 'Production manifest bytes changed')
    else:
        require(previous.parent == BASE / 'releases', 'Unexpected rollback path')
    previous_bytes = (previous / 'release-manifest.json').read_bytes()
    previous_manifest = json.loads(previous_bytes)
    previous_sha = hashlib.sha256(previous_bytes).hexdigest()
    require(previous_manifest['commit'] == (reviewed['previousCommit'] if reviewed
                                           else REVIEWED_BASELINES[expected]),
            'Rollback baseline changed')
    if reviewed is not None:
        require(previous_sha == reviewed['previousManifestSha256'], 'Production manifest bytes changed')
    require((BASE / 'current').resolve() == directory, 'Production release pointer changed')
    return directory, manifest_sha, previous, previous_sha


def project_mysql():
    values = {}
    with (BASE / 'current/.env.aws.production').open() as source:
        for line in source:
            if line.startswith('COMPOSE_PROJECT_NAME='):
                values['project'] = line.rstrip('\n').split('=', 1)[1]
    project = values.get('project', '')
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,62}', project), 'Unexpected project')
    ids = read('docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project=' + project,
               '--filter', 'label=com.docker.compose.service=mysql').splitlines()
    require(len(ids) == 1, 'Expected one running project MySQL')
    return ids[0]


def mysql(container, query, read_only=True):
    if read_only:
        query = 'SET TRANSACTION READ ONLY; START TRANSACTION; ' + query + '; ROLLBACK;'
    return read('docker', 'exec', container, 'sh', '-c',
                'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --host=127.0.0.1 '
                '--user=root --database="$MYSQL_DATABASE" --default-character-set=utf8mb4 '
                '--batch --skip-column-names --execute "$1"', 'sh', query)


def references(container):
    query = "SELECT JSON_OBJECT('table',TABLE_NAME,'column',COLUMN_NAME,'sameSchema'," \
            "TABLE_SCHEMA=DATABASE()) FROM information_schema.KEY_COLUMN_USAGE " \
            "WHERE REFERENCED_TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='audit_logs' ORDER BY TABLE_NAME,COLUMN_NAME"
    return [json.loads(line) for line in mysql(container, query).splitlines()]


def audit_predicate(refs):
    actions = ','.join("'" + action + "'" for action in ROUTINE_ACTIONS)
    predicate = "a.module='id_business_v2' AND a.action IN (" + actions + ") " \
                "AND a.user_id IS NULL AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.after_data,'$.triggerType')),'') <> 'manual' AND a.created_at < '" + CUTOFF + "'"
    for ref in refs:
        require(ref.get('sameSchema') == 1, 'Cross-schema audit reference must be reviewed')
        require(all(re.fullmatch(r'[A-Za-z0-9_]+', ref[key]) for key in ('table', 'column')),
                'Unexpected audit reference identifier')
        predicate += " AND NOT EXISTS (SELECT 1 FROM `" + ref['table'] + "` r WHERE r.`" \
                     + ref['column'] + "`=a.id)"
    return predicate


def preview_audit(container):
    refs = references(container)
    ids = mysql(container, 'SELECT a.id FROM audit_logs a WHERE ' + audit_predicate(refs)
                + ' ORDER BY a.id').splitlines()
    require(all(re.fullmatch(r'[a-f0-9-]{36}', value) for value in ids), 'Unexpected audit ID')
    require(len(ids) <= MAX_APPROVED_COUNT, 'Candidate count exceeds approved scope')
    total = int(mysql(container, 'SELECT COUNT(*) FROM audit_logs'))
    return {'count': len(ids), 'idsSha256': hashlib.sha256(','.join(ids).encode()).hexdigest(),
            'totalBefore': total, 'references': refs, 'cutoffUtc': '2026-10-02T11:00:00Z'}


def helper(name):
    path = BASE / 'current/scripts/production-release' / (name + '.py')
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fresh_backup(directory):
    backup_dir = BASE / 'backups/mysql'
    existing = {path.name for path in backup_dir.glob('id-business-v2-*.sql.gz')}
    started = time.time()
    read('bash', str(directory / 'scripts/backup-aws-mysql.sh'))
    copies = [path for path in backup_dir.glob('id-business-v2-*.sql.gz')
              if path.name not in existing and path.stat().st_mtime >= started - 2]
    require(len(copies) == 1, 'Expected exactly one fresh backup')
    module = helper('cleanup-verified-backups')
    identity = module.verified(copies[0], module.configuration())
    return {'name': copies[0].name, 'bytes': identity[1], 's3Verified': True}


def deletion_sql(preview, backup):
    count, digest = preview['count'], preview['idsSha256']
    require(isinstance(count, int) and 0 < count <= MAX_APPROVED_COUNT, 'Invalid approved count')
    require(re.fullmatch(r'[a-f0-9]{64}', digest), 'Invalid candidate digest')
    require(re.fullmatch(r'id-business-v2-\d{8}T\d{6}Z\.sql\.gz', backup['name'])
            and backup.get('s3Verified') is True, 'Verified backup required')
    where = audit_predicate(preview['references'])
    # Recompute and compare the entire set inside the same Serializable transaction.
    # A changed candidate set causes zero deletions and no false success audit.
    return (
        'SET SESSION group_concat_max_len=2000000; '
        'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE; START TRANSACTION; '
        "SELECT COUNT(*),SHA2(GROUP_CONCAT(a.id ORDER BY a.id SEPARATOR ','),256) "
        'INTO @candidate_count,@candidate_hash FROM audit_logs a WHERE ' + where + '; '
        "SET @idv2_routine_audit_cleanup_scope='" + APPROVED_SCOPE + "'; "
        'DELETE a FROM audit_logs a WHERE ' + where
        + f" AND @candidate_count={count} AND @candidate_hash='{digest}'; "
        'SET @deleted=ROW_COUNT(); '
        'INSERT INTO audit_logs (id,module,action,object_type,before_data,after_data,remark,created_at) '
        "SELECT UUID(),'maintenance','maintenance.audit_log.cleanup','audit_logs',"
        f"JSON_OBJECT('count',{count},'idsSha256','{digest}'),"
        f"JSON_OBJECT('deleted',@deleted,'cutoffUtc','2026-10-02T11:00:00Z','backup','{backup['name']}'),"
        "'用户已批准清理自动采集审计，其他业务及恢复记录保留',UTC_TIMESTAMP(6) "
        f'WHERE @deleted={count}; SET @idv2_routine_audit_cleanup_scope=NULL; COMMIT; '
        "SELECT JSON_OBJECT('deleted',@deleted,'candidateCount',@candidate_count,"
        "'candidateHash',@candidate_hash,'totalAfter',(SELECT COUNT(*) FROM audit_logs));"
    )


def retention_migration(sql):
    require(isinstance(sql, str) and hashlib.sha256(sql.encode()).hexdigest() == RETENTION_MIGRATION_SHA256,
            'Retention migration differs from approved digest')
    return sql


def prepare_retention(directory, container, sql, deployment):
    sql = retention_migration(sql)
    root = BASE / 'maintenance/storage-cleanup-20261002/prisma-mysql'
    source = directory / 'apps/api/prisma-mysql'
    if not root.exists():
        shutil.copytree(source, root)
    require(root.is_dir() and not root.is_symlink(), 'Unexpected retention migration directory')
    original = {str(path.relative_to(source)): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in source.rglob('*') if path.is_file()}
    copied = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
              for path in root.rglob('*') if path.is_file()
              and str(path.relative_to(root)) != 'migrations/' + RETENTION_MIGRATION + '/migration.sql'}
    require(original == copied, 'Existing Prisma migration inputs changed')
    target = root / 'migrations' / RETENTION_MIGRATION / 'migration.sql'
    target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    if target.exists():
        require(target.read_text() == sql, 'Retention migration candidate changed')
    else:
        target.write_text(sql)
        target.chmod(0o644)
    deployment.compose(directory, 'run', '--rm', '--no-deps', '-v',
                       str(root) + ':/app/apps/api/prisma-mysql:ro', 'migrate', timeout=240)
    rows = mysql(container, "SELECT JSON_OBJECT('name',migration_name,'checksum',checksum,"
                 "'finished',finished_at IS NOT NULL,'rolledBack',rolled_back_at IS NOT NULL) "
                 "FROM _prisma_migrations WHERE migration_name='" + RETENTION_MIGRATION + "'").splitlines()
    require(len(rows) == 1, 'Expected one retention migration record')
    receipt = json.loads(rows[0])
    require(receipt['checksum'] == RETENTION_MIGRATION_SHA256 and receipt['finished'] == 1
            and receipt['rolledBack'] == 0, 'Retention migration completion not verified')
    return receipt


def cleanup_audit(expected, approved_scope, migration_sql=None):
    require(approved_scope == APPROVED_SCOPE, 'Explicit fixed-scope approval required')
    with (BASE / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print('STORAGE_STAGE baseline', flush=True)
        directory = baseline(expected)
        container = project_mysql()
        print('STORAGE_STAGE audit_preview', flush=True)
        preview = preview_audit(container)
        if preview['count'] == 0:
            return {'mode': 'ALREADY_CLEAN', 'deleted': 0, 'preview': preview}
        receipt_dir = BASE / 'maintenance/storage-cleanup-20261002'
        receipt_dir.mkdir(parents=True, exist_ok=True)
        receipt_dir.chmod(0o700)
        deployment = helper('remote-deploy')
        print('STORAGE_STAGE financial_before', flush=True)
        before = deployment.audit(directory, receipt_dir / 'audit-before.json')
        print('STORAGE_STAGE verified_backup', flush=True)
        backup = fresh_backup(directory)
        print('STORAGE_STAGE approved_retention_migration', flush=True)
        migration = prepare_retention(directory, container, migration_sql, deployment)
        baseline(expected)
        refreshed = preview_audit(container)
        require(all(refreshed[key] == preview[key] for key in ('count', 'idsSha256', 'references')),
                'Audit candidate set changed before deletion')
        print('STORAGE_STAGE guarded_delete', flush=True)
        receipt = json.loads(mysql(container, deletion_sql(preview, backup), read_only=False))
        receipt.update({'mode': 'APPLIED', 'preview': preview, 'backup': backup,
                        'dataAuditBefore': before, 'retentionMigration': migration})
        (receipt_dir / 'audit-cleanup-receipt.json').write_text(json.dumps(receipt, indent=2))
        (receipt_dir / 'audit-cleanup-receipt.json').chmod(0o600)
        require(receipt['deleted'] == preview['count'], 'Candidate guard prevented deletion')
        print('STORAGE_STAGE financial_after', flush=True)
        receipt['dataAuditAfter'] = deployment.audit(directory, receipt_dir / 'audit-after.json')
        require(preview_audit(container)['count'] == 0, 'Approved audit candidates remain')
        baseline(expected)
        (receipt_dir / 'audit-cleanup-receipt.json').write_text(json.dumps(receipt, indent=2))
        return receipt


def legacy_cache_plan(plan_json):
    plan = json.loads(plan_json)
    digest = hashlib.sha256(json.dumps(plan, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    require(digest == LEGACY_PLAN_SHA256, 'Legacy cache plan differs from reviewed digest')
    require(len(plan['items']) == 42 and sum(len(item['references']) for item in plan['items']) == 50,
            'Legacy cache reviewed count changed')
    sources = {source['commit'] for source in plan['sources'] if source['retainedIn'] == 'origin/main'}
    for item in plan['items']:
        require(item['sourceCommit'] in sources and any(
            ref.endswith(':' + item['sourceCommit']) for ref in item['references']),
            'Retained source recovery proof missing')
        require(all(re.fullmatch(r'id-business-v2-(?:admin|api|migrate|auto-recharge|media-resolver):[a-f0-9]{40}', ref)
                    for ref in item['references']), 'Reference is outside legacy project cache')
    return plan


def container_images():
    return {read('docker', 'inspect', '--format', '{{.Image}}', item)
            for item in read('docker', 'ps', '-a', '-q').splitlines()}


def legacy_image_identity(item):
    metadata = json.loads(read('docker', 'image', 'inspect', '--format',
        '{"id":{{json .Id}},"repoTags":{{json .RepoTags}}}', item['imageId']))
    require(metadata['id'] == item['imageId'] and sorted(metadata['repoTags'] or []) == item['references'],
            'Legacy image identity or references changed')


def cleanup_legacy_cache(expected, plan_json, apply=False):
    plan = legacy_cache_plan(plan_json)
    require(expected == plan['expectedCurrent'], 'Legacy cache production baseline differs')
    with (BASE / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        baseline(expected)
        manifest = json.loads((BASE / 'current/release-manifest.json').read_text())
        previous = json.loads((Path(manifest['previousRelease']) / 'release-manifest.json').read_text())
        require(previous['commit'] == plan['expectedPrevious'], 'Legacy cache rollback changed')
        protected = container_images()
        for release in (manifest, previous):
            protected.update(image['digest'] for image in release.get('images', {}).values())
            protected.update(release.get('rollback', {}).get('images', {}).values())
        for item in plan['items']:
            require(item['imageId'] not in protected, 'Legacy image is used by a container or protected release')
            legacy_image_identity(item)
        before = shutil.disk_usage(BASE).free
        removed = []
        receipt = {'mode': 'APPLIED' if apply else 'PLAN_ONLY', 'removed': removed,
                   'approvedImageCount': 42, 'approvedReferenceCount': 50,
                   'recovery': plan['recovery'], 'planSha256': LEGACY_PLAN_SHA256,
                   'freeBytesBefore': before}
        receipt_dir = BASE / 'maintenance/storage-cleanup-20261002'
        if apply:
            receipt_dir.mkdir(parents=True, exist_ok=True)
            receipt_dir.chmod(0o700)
            for item in plan['items']:
                baseline(expected)
                require(item['imageId'] not in container_images(), 'Legacy image became used by a container')
                legacy_image_identity(item)
                for reference in item['references']:
                    require(item['imageId'] not in container_images(), 'Legacy image became used by a container')
                    read('docker', 'image', 'rm', '--no-prune', reference)
                    removed.append(reference)
                    path = receipt_dir / 'legacy-cache-cleanup-receipt.json'
                    path.write_text(json.dumps(receipt, indent=2))
                    path.chmod(0o600)
        baseline(expected)
        receipt['freeBytesAfter'] = shutil.disk_usage(BASE).free
        if apply:
            path.write_text(json.dumps(receipt, indent=2))
        return receipt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--operation', choices=('diagnose', 'cleanup-audit', 'verify-legacy-cache',
                                               'cleanup-legacy-cache'), required=True)
    parser.add_argument('--expected-current', required=True)
    parser.add_argument('--approved-scope')
    parser.add_argument('--legacy-plan-json')
    parser.add_argument('--retention-migration-sql')
    args = parser.parse_args()
    if args.operation == 'diagnose':
        result = diagnose(args.expected_current)
    else:
        baseline(args.expected_current)
        if args.operation == 'cleanup-audit':
            result = cleanup_audit(args.expected_current, args.approved_scope, args.retention_migration_sql)
        else:
            result = cleanup_legacy_cache(args.expected_current, args.legacy_plan_json,
                                          apply=args.operation == 'cleanup-legacy-cache')
    encoded = base64.b64encode(gzip.compress(json.dumps(result).encode())).decode()
    print('STORAGE_MAINTENANCE ' + json.dumps({'encoding': 'gzip+base64', 'payload': encoded}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'STORAGE_MAINTENANCE_FAILED', 'errorType': type(error).__name__,
                          'reason': str(error) if isinstance(error, RuntimeError)
                          else 'Failure details suppressed'}))
        raise SystemExit(1)
