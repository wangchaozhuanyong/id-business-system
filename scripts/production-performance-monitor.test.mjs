import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readProjectFile(path) {
  return readFileSync(resolve(projectRoot, path), 'utf8');
}

test('production performance audit is read-only, bounded and secret-safe', () => {
  const scriptPath = resolve(projectRoot, 'scripts/audit-aws-mysql-performance.sh');
  const source = readProjectFile('scripts/audit-aws-mysql-performance.sh');
  const syntax = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });

  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(source, /performance_schema\.global_status/u);
  assert.match(source, /events_statements_summary_by_digest/u);
  assert.match(source, /LAST_SEEN >= UTC_TIMESTAMP\(\) - INTERVAL 10 MINUTE/u);
  assert.match(source, /DIGEST_TEXT NOT LIKE 'SELECT SQL_NO_CACHE%'/u);
  assert.match(source, /slow_digest/u);
  assert.doesNotMatch(source, /DIGEST_TEXT[^\n]*printf/u);
  assert.doesNotMatch(source, /\b(?:INSERT\s+INTO|UPDATE\s+`|DELETE\s+FROM)\b/u);
  assert.doesNotMatch(source, /--password=/u);
  assert.match(source, /MYSQL_PERFORMANCE_MAX_CONNECTION_USAGE_PCT/u);
  assert.match(source, /MYSQL_PERFORMANCE_MAX_QUERY_MS/u);
  assert.match(source, /MYSQL_PERFORMANCE_MAX_ABORTED_CLIENTS_DELTA/u);
});

test('production performance audit runs every five minutes under systemd', () => {
  const service = readProjectFile('deploy/systemd/id-business-v2-mysql-performance.service');
  const timer = readProjectFile('deploy/systemd/id-business-v2-mysql-performance.timer');
  const installer = readProjectFile('scripts/install-aws-production-artifact.sh');

  assert.match(service, /User=root/u);
  assert.match(service, /UMask=0077/u);
  assert.match(service, /StateDirectory=id-business-v2-mysql-performance/u);
  assert.match(service, /audit-aws-mysql-performance\.sh/u);
  assert.match(timer, /OnCalendar=\*-\*-\* \*:00\/5:00/u);
  assert.match(timer, /Persistent=true/u);
  assert.match(installer, /install_performance_timer/u);
  assert.match(installer, /systemctl start id-business-v2-mysql-performance\.service/u);
  assert.match(installer, /performance_timer_changed/u);
  assert.match(installer, /systemctl disable --now id-business-v2-mysql-performance\.timer/u);
});

test('production runtime probe is read-only, bounded and has stop thresholds', () => {
  const probePath = resolve(projectRoot, 'scripts/probe-v2-production-runtime.mjs');
  const source = readProjectFile('scripts/probe-v2-production-runtime.mjs');
  const syntax = spawnSync(process.execPath, ['--check', probePath], { encoding: 'utf8' });

  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(source, /V2_PRODUCTION_PROBE_CONFIRM/u);
  assert.match(source, /read-only-maintenance/u);
  assert.match(source, /V2_PRODUCTION_P99_STOP_MS/u);
  assert.match(source, /V2_PRODUCTION_MAX_REQUEST_MS/u);
  assert.match(source, /allowLocal \? 30 : 300/u);
  assert.match(source, /item <= 40/u);
  assert.match(source, /api\/realtime\/events/u);
  assert.match(source, /maxHeartbeatGapMs < 40_000/u);
  assert.doesNotMatch(source, /api\/id-business-v2\/orders['"`],\s*\{\s*method:\s*['"]POST/u);
});
