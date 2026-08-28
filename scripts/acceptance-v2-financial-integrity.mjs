import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const containerName = `id-business-v2-financial-integrity-${process.pid}`;
const databaseName = `id_business_v2_financial_integrity_${process.pid}`;
const rootPassword = 'v2_financial_integrity_root_only';
const auditUser = 'id_business_audit';
const auditPassword = 'v2_financial_integrity_audit_only';
const schemaPath = 'apps/api/prisma-mysql/schema.prisma';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    ...options
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout?.trim() ?? '';
}

function runAllowingFailure(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    ...options
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function mysql(sql) {
  return run('docker', [
    'exec',
    containerName,
    'mysql',
    '--user=root',
    `--password=${rootPassword}`,
    '--batch',
    '--skip-column-names',
    databaseName,
    '--execute',
    sql
  ]);
}

try {
  run('docker', [
    'run',
    '--rm',
    '--detach',
    '--name',
    containerName,
    '--env',
    `MYSQL_ROOT_PASSWORD=${rootPassword}`,
    '--env',
    `MYSQL_DATABASE=${databaseName}`,
    '--publish',
    '127.0.0.1::3306',
    'mysql:8.4',
    '--character-set-server=utf8mb4',
    '--collation-server=utf8mb4_0900_ai_ci',
    '--default-time-zone=+00:00',
    '--sql-mode=ANSI_QUOTES,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION',
    '--log-bin-trust-function-creators=1'
  ]);

  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const probe = runAllowingFailure('docker', [
      'exec',
      containerName,
      'mysqladmin',
      'ping',
      '--host=127.0.0.1',
      '--user=root',
      `--password=${rootPassword}`,
      '--silent'
    ]);
    if (probe.status === 0) {
      ready = true;
      break;
    }
    await wait(500);
  }
  if (!ready) throw new Error('财务完整性隔离 MySQL 在 60 秒内未就绪');

  const portOutput = run('docker', ['port', containerName, '3306/tcp']);
  const portMatch = portOutput.match(/:(\d+)$/m);
  if (!portMatch) throw new Error('无法解析财务完整性隔离 MySQL 端口');
  const rootUrl = `mysql://root:${rootPassword}@127.0.0.1:${portMatch[1]}/${databaseName}`;
  const auditUrl = `mysql://${auditUser}:${auditPassword}@127.0.0.1:${portMatch[1]}/${databaseName}`;

  run('npm', ['run', 'prisma:mysql:generate'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: rootUrl }
  });
  run('npx', ['prisma', 'migrate', 'deploy', '--schema', schemaPath], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: rootUrl }
  });

  run(
    'npm',
    [
      'run',
      'test',
      '--workspace=@apple-business/api',
      '--',
      '--run',
      'src/id-business-v2/finance/id-business-v2-financial-integrity-mysql.integration.spec.ts'
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: rootUrl,
        V2_FINANCIAL_INTEGRITY_DATABASE_URL: rootUrl
      }
    }
  );

  const provisioned = JSON.parse(
    run('node', ['scripts/provision-v2-data-integrity-auditor.mjs'], {
      env: {
        ...process.env,
        V2_DATA_INTEGRITY_DATABASE_URL: auditUrl,
        MYSQL_DATABASE: databaseName,
        MYSQL_ROOT_PASSWORD: rootPassword,
        MYSQL_HOST_PORT: portMatch[1]
      }
    })
  );
  assert.equal(provisioned.ok, true);
  assert.equal(provisioned.username, auditUser);

  const healthy = JSON.parse(
    run('node', ['scripts/v2-data-integrity-audit.mjs'], {
      env: { ...process.env, V2_DATA_INTEGRITY_DATABASE_URL: auditUrl }
    })
  );
  assert.equal(healthy.ok, true);
  assert.equal(healthy.checkCount, 38);
  assert.equal(healthy.violationCount, 0);
  assert.match(healthy.identity.currentUser, /^id_business_audit@/);

  const writeAccountAudit = runAllowingFailure('node', ['scripts/v2-data-integrity-audit.mjs'], {
    env: { ...process.env, V2_DATA_INTEGRITY_DATABASE_URL: rootUrl }
  });
  assert.notEqual(writeAccountAudit.status, 0);
  assert.match(
    `${writeAccountAudit.stdout}\n${writeAccountAudit.stderr}`,
    /仅具备 SELECT\/SHOW VIEW 权限/
  );

  const plaintextInsert = runAllowingFailure('docker', [
    'exec',
    containerName,
    'mysql',
    '--user=root',
    `--password=${rootPassword}`,
    databaseName,
    '--execute',
    `INSERT INTO users (id, username, display_name, phone, password_hash, updated_at)
     VALUES ('fa000000-0000-4000-8000-000000000001', 'plaintext-phone', '明文手机号',
             '13800138000', 'integration-only', CURRENT_TIMESTAMP(6));`
  ]);
  assert.notEqual(plaintextInsert.status, 0);
  assert.match(`${plaintextInsert.stdout}\n${plaintextInsert.stderr}`, /Unknown column 'phone'/);

  mysql(
    `INSERT INTO id_business_v2_finance_journals (
       id, journal_no, journal_type, source_type, source_id, business_date,
       period_month, occurred_at, status, summary, idempotency_key, updated_at
     ) VALUES (
       'fa100000-0000-4000-8000-000000000001', 'FINTEGRITY-BROKEN-1', 'expense',
       'expense', 'fa200000-0000-4000-8000-000000000001', '2026-08-28',
       '2026-08', '2026-08-28 10:00:00.000000', 'posted', '故意构造不平凭证',
       'financial-integrity:broken-journal', CURRENT_TIMESTAMP(6)
     );
     INSERT INTO id_business_v2_finance_journal_lines (
       id, journal_id, line_no, account_code, direction, currency,
       amount_original, fx_rate_to_cny, amount_cny
     ) VALUES (
       'fa110000-0000-4000-8000-000000000001',
       'fa100000-0000-4000-8000-000000000001', 1, 'operating_expense', 'debit',
       'CNY', 12.3400, 1.00000000, 12.3400
     );
     INSERT INTO id_business_v2_options (
       id, type, code, name, unique_key, status, updated_at
     ) VALUES (
       'fa300000-0000-4000-8000-000000000001', 'service', 'integrity-service',
       '完整性验收业务', 'service:integrity-service', 'disabled', CURRENT_TIMESTAMP(6)
     );
     INSERT INTO id_business_v2_customers (
       id, name, phone_search_tokens, wechat_search_tokens, qq_search_tokens,
       whatsapp_search_tokens, updated_at
     )
     VALUES (
       'fa310000-0000-4000-8000-000000000001', '完整性验收客户', JSON_ARRAY(),
       JSON_ARRAY(), JSON_ARRAY(), JSON_ARRAY(), CURRENT_TIMESTAMP(6)
     );
     INSERT INTO id_business_v2_orders (
       id, order_no, customer_id, service_option_id, received_amount,
       received_original_amount, website_account_search_tokens, profit_amount, status, opened_at,
       idempotency_key, updated_at
     ) VALUES (
       'fa320000-0000-4000-8000-000000000001', 'FINTEGRITY-ORDER-BROKEN-1',
       'fa310000-0000-4000-8000-000000000001',
       'fa300000-0000-4000-8000-000000000001', 88.8800, 88.8800,
       JSON_ARRAY(), 88.8800, 'completed', '2026-08-28 10:00:00.000000',
       'financial-integrity:broken-order', CURRENT_TIMESTAMP(6)
     );`
  );

  const brokenAudit = runAllowingFailure('node', ['scripts/v2-data-integrity-audit.mjs'], {
    env: { ...process.env, V2_DATA_INTEGRITY_DATABASE_URL: auditUrl }
  });
  assert.equal(brokenAudit.status, 1);
  const broken = JSON.parse(brokenAudit.stdout);
  assert.equal(broken.ok, false);
  assert.ok(broken.failedChecks.includes('finance_journal_unbalanced'));
  assert.ok(broken.failedChecks.includes('completed_order_finance_reconciliation_mismatch'));
  assert.ok(broken.violationCount >= 1);

  console.log(
    JSON.stringify({
      ok: true,
      database: databaseName,
      checkCount: healthy.checkCount,
      verified: [
        'real-mysql-post-rollback-idempotency-concurrency',
        'dedicated-readonly-auditor-provisioning',
        'clean-mysql-full-scan',
        'readonly-account-enforcement',
        'plaintext-phone-column-absent',
        'known-unbalanced-journal-detection',
        'known-completed-order-profit-mismatch-detection'
      ],
      cleanup: 'remove-disposable-mysql-container'
    })
  );
} finally {
  runAllowingFailure('docker', ['rm', '--force', containerName], { stdio: 'ignore' });
}
