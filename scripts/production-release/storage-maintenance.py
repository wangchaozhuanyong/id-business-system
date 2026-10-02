"""Production aggregate diagnostics. No deletion, secrets, or row payload output."""
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

BASE = Path('/opt/id-business-v2')
EXPECTED = '63e7c3b9fdb462517373b48f338626dafaf856ca'
PREVIOUS = 'a9530728a1b15d3dbb49fe7c38aa3c87e385467f'
APPROVED_SCOPE = 'audit-routine-20261002T110000Z'
CUTOFF = '2026-10-02 11:00:00'
MAX_APPROVED_COUNT = 19848
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
        raise RuntimeError('Diagnostic command failed; details suppressed')
    return result.stdout.strip()


def diagnose():
    manifest = json.loads((BASE / 'current/release-manifest.json').read_text())
    if manifest['commit'] != EXPECTED:
        raise RuntimeError('Production baseline changed')
    project = None
    for line in (BASE / 'current/.env.aws.production').read_text().splitlines():
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
        'mode': 'READ_ONLY', 'currentCommit': EXPECTED, 'memory': memory,
        'disk': {'totalBytes': disk.total, 'usedBytes': disk.used, 'freeBytes': disk.free},
        'allLocalImages': image_inventory, 'allContainerImageIds': container_image_ids,
        'containers': [json.loads(row) for row in read('docker', 'stats', '--no-stream',
                       '--format', '{{json .}}', *containers).splitlines()],
        'directories': read('du', '-x', '-B1', '--max-depth=1', '/var/lib/docker',
                            '/var/log', '/opt/id-business-v2').splitlines(),
        'database': [json.loads(row) for row in mysql_output.splitlines()],
        'candidateCutoffUtc': '2026-10-02T11:00:00Z',
    }
    if json.loads((BASE / 'current/release-manifest.json').read_text())['commit'] != EXPECTED:
        raise RuntimeError('Production baseline changed during diagnostics')
    return result


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def baseline(expected):
    require(expected == EXPECTED, 'Scope production baseline differs')
    require((BASE / 'current').resolve().parent == BASE / 'releases', 'Unexpected release path')
    manifest = json.loads((BASE / 'current/release-manifest.json').read_text())
    require(manifest['commit'] == expected, 'Production baseline changed')
    previous = Path(manifest['previousRelease']).resolve()
    require(previous.parent == BASE / 'releases', 'Unexpected rollback path')
    require(json.loads((previous / 'release-manifest.json').read_text())['commit'] == PREVIOUS,
            'Rollback baseline changed')
    return (BASE / 'current').resolve()


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
        'DELETE a FROM audit_logs a WHERE ' + where
        + f" AND @candidate_count={count} AND @candidate_hash='{digest}'; "
        'SET @deleted=ROW_COUNT(); '
        'INSERT INTO audit_logs (id,module,action,object_type,before_data,after_data,remark,created_at) '
        "SELECT UUID(),'maintenance','maintenance.audit_log.cleanup','audit_logs',"
        f"JSON_OBJECT('count',{count},'idsSha256','{digest}'),"
        f"JSON_OBJECT('deleted',@deleted,'cutoffUtc','2026-10-02T11:00:00Z','backup','{backup['name']}'),"
        "'用户已批准清理自动采集审计，其他业务及恢复记录保留',UTC_TIMESTAMP(6) "
        f'WHERE @deleted={count}; COMMIT; '
        "SELECT JSON_OBJECT('deleted',@deleted,'candidateCount',@candidate_count,"
        "'candidateHash',@candidate_hash,'totalAfter',(SELECT COUNT(*) FROM audit_logs));"
    )


def cleanup_audit(expected, approved_scope):
    require(approved_scope == APPROVED_SCOPE, 'Explicit fixed-scope approval required')
    with (BASE / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        directory = baseline(expected)
        container = project_mysql()
        preview = preview_audit(container)
        if preview['count'] == 0:
            return {'mode': 'ALREADY_CLEAN', 'deleted': 0, 'preview': preview}
        receipt_dir = BASE / 'maintenance/storage-cleanup-20261002'
        receipt_dir.mkdir(parents=True, exist_ok=True)
        receipt_dir.chmod(0o700)
        deployment = helper('remote-deploy')
        before = deployment.audit(directory, receipt_dir / 'audit-before.json')
        backup = fresh_backup(directory)
        baseline(expected)
        refreshed = preview_audit(container)
        require(all(refreshed[key] == preview[key] for key in ('count', 'idsSha256', 'references')),
                'Audit candidate set changed before deletion')
        receipt = json.loads(mysql(container, deletion_sql(preview, backup), read_only=False))
        receipt.update({'mode': 'APPLIED', 'preview': preview, 'backup': backup,
                        'dataAuditBefore': before})
        (receipt_dir / 'audit-cleanup-receipt.json').write_text(json.dumps(receipt, indent=2))
        (receipt_dir / 'audit-cleanup-receipt.json').chmod(0o600)
        require(receipt['deleted'] == preview['count'], 'Candidate guard prevented deletion')
        receipt['dataAuditAfter'] = deployment.audit(directory, receipt_dir / 'audit-after.json')
        require(preview_audit(container)['count'] == 0, 'Approved audit candidates remain')
        baseline(expected)
        (receipt_dir / 'audit-cleanup-receipt.json').write_text(json.dumps(receipt, indent=2))
        return receipt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--operation', choices=('diagnose', 'cleanup-audit'), required=True)
    parser.add_argument('--expected-current', required=True)
    parser.add_argument('--approved-scope')
    args = parser.parse_args()
    baseline(args.expected_current)
    result = diagnose() if args.operation == 'diagnose' else cleanup_audit(
        args.expected_current, args.approved_scope)
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
