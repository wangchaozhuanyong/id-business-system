import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readProjectFile(path) {
  return readFileSync(resolve(projectRoot, path), 'utf8');
}

test('AWS MySQL backup shell scripts pass bash syntax validation', () => {
  for (const script of ['scripts/backup-aws-mysql.sh', 'scripts/verify-aws-mysql-backup.sh']) {
    const result = spawnSync('bash', ['-n', resolve(projectRoot, script)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
});

test('production backup requires S3 and verifies the remote SHA-256 checksum', () => {
  const source = readProjectFile('scripts/backup-aws-mysql.sh');

  assert.match(source, /MYSQL_BACKUP_S3_BUCKET 未配置/);
  assert.match(source, /--checksum-algorithm SHA256/);
  assert.match(source, /--checksum-mode ENABLED/);
  assert.match(source, /remote_checksum_base64/);
  assert.match(source, /MYSQL_BACKUP_LOCAL_RETENTION_COUNT/);
  assert.match(source, /MYSQL_BACKUP_LOCAL_MAX_BYTES/);
  assert.match(source, /MYSQL_BACKUP_MIN_FREE_BYTES/);
  assert.match(source, /prune_local_backups/);
  assert.match(source, /mysql-dump-restore-normalizer\.sed/);
  assert.match(source, /sed -E -f "\$\{normalizer_script\}"/);
  assert.match(source, /MYSQL_BACKUP_USER/);
  assert.match(source, /MYSQL_BACKUP_PASSWORD/);
  assert.doesNotMatch(source, /--user="\$MYSQL_USER"/);
});

test('restore verification downloads S3 data into an isolated MySQL 8.4 container', () => {
  const source = readProjectFile('scripts/verify-aws-mysql-backup.sh');

  assert.match(source, /mysql_image="mysql:8\.4@sha256:[a-f0-9]{64}"/);
  assert.match(source, /--network none/);
  assert.match(source, /--checksum-mode ENABLED/);
  assert.match(source, /normalize_mysql_dump_stream/);
  assert.match(source, /CHECK TABLE/);
  assert.doesNotMatch(source, /mysqlcheck --check/);
  assert.match(source, /checked_table_count/);
  assert.match(source, /_prisma_migrations/);
  assert.match(source, /id_business_v2_finance_journals/);
  assert.match(source, /trap cleanup EXIT INT TERM/);
});

test('restore normalizer fixes MySQL trigger terminators without rewriting normal SQL', () => {
  const fixture = [
    'CREATE TABLE `untouched` (`id` int); */;;',
    'DELIMITER ;;',
    "/*!50003 CREATE*/ /*!50003 TRIGGER `single` BEFORE UPDATE ON `x` FOR EACH ROW SIGNAL SQLSTATE '45000'; */;;",
    '/*!50003 CREATE*/ /*!50003 TRIGGER `multi` BEFORE INSERT ON `x` FOR EACH ROW SET NEW.`v` = CASE',
    '  WHEN NEW.`v` = 1 THEN 2',
    '  ELSE NULL',
    'END; */;;',
    'DELIMITER ;',
    ''
  ].join('\n');
  const result = spawnSync(
    'sed',
    ['-E', '-f', resolve(projectRoot, 'scripts/mysql-dump-restore-normalizer.sed')],
    { encoding: 'utf8', input: fixture }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    fixture
      .replace("SIGNAL SQLSTATE '45000'; */;;", "SIGNAL SQLSTATE '45000' */;;")
      .replace('END; */;;', 'END */;;')
  );
});

test('systemd uses frequent backups and a weekly restore verification', () => {
  const backupTimer = readProjectFile('deploy/systemd/id-business-v2-mysql-backup.timer');
  const backupService = readProjectFile('deploy/systemd/id-business-v2-mysql-backup.service');
  const verifyTimer = readProjectFile('deploy/systemd/id-business-v2-mysql-backup-verify.timer');
  const verifyService = readProjectFile(
    'deploy/systemd/id-business-v2-mysql-backup-verify.service'
  );

  assert.match(backupTimer, /OnCalendar=\*-\*-\* \*:00,30:00/);
  assert.match(verifyTimer, /OnCalendar=Sun/);
  assert.match(backupService, /User=root/);
  assert.match(backupService, /UMask=0077/);
  assert.match(verifyService, /User=root/);
  assert.match(verifyService, /UMask=0077/);
  assert.match(verifyService, /verify-aws-mysql-backup\.sh/);
});

test('S3 lifecycle expires backup objects instead of retaining them forever', () => {
  const template = readProjectFile('deploy/aws/id-business-v2-backup-ssm.yaml');

  assert.match(template, /ExpirationInDays: 90/);
  assert.match(template, /NoncurrentVersionExpiration:\s+NoncurrentDays: 30/);
});
test('obsolete PostgreSQL production backup workflow is absent', () => {
  assert.equal(existsSync(resolve(projectRoot, '.github/workflows/production-backup.yml')), false);
});
