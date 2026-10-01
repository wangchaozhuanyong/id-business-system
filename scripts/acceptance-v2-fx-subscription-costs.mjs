import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const evidence = path.join(root, '.runtime/fx-subscription-cost-20261001');
const staged = path.join(evidence, 'migration-baseline');
const container = `id-business-fx-cost-${process.pid}`;
const database = `bank_recharge_fx_cost_${process.pid}`;
const legacyDb = `bank_recharge_legacy_${process.pid}`;
const migrationOnly = process.argv.includes('--migration-only');
const compatibilityOnly = process.argv.includes('--compatibility-only');
const fixturePassword = 'isolated_fx_cost_fixture';
function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  } catch (error) {
    throw new Error(
      [command, error.stdout, error.stderr]
        .filter(Boolean)
        .join('\n')
        .replaceAll(fixturePassword, '[redacted]'),
      { cause: error }
    );
  }
}
function sql(statement, db = database) {
  return run('docker', [
    'exec',
    container,
    'mysql',
    '--user=root',
    `--password=${fixturePassword}`,
    '--batch',
    '--skip-column-names',
    db,
    '--execute',
    statement
  ]);
}
let outcome;
try {
  mkdirSync(path.join(staged, 'migrations'), { recursive: true });
  const migrations = path.join(root, 'apps/api/prisma-mysql/migrations');
  // The baseline schema is the current schema before this task. Only the new migration is withheld.
  cpSync(path.join(evidence, 'schema.before.prisma'), path.join(staged, 'schema.prisma'));
  for (const entry of readdirSync(migrations))
    if (entry !== '20261001090000_fx_subscription_costs')
      cpSync(path.join(migrations, entry), path.join(staged, 'migrations', entry), {
        recursive: true
      });
  run('docker', [
    'run',
    '--rm',
    '-d',
    '--name',
    container,
    '-e',
    `MYSQL_ROOT_PASSWORD=${fixturePassword}`,
    '-e',
    `MYSQL_DATABASE=${database}`,
    '-p',
    '127.0.0.1::3306',
    'mysql:8.4',
    '--default-time-zone=+00:00',
    '--log-bin-trust-function-creators=1'
  ]);
  let ready = false;
  for (let n = 0; n < 120; n++) {
    if (
      spawnSync(
        'docker',
        [
          'exec',
          container,
          'mysqladmin',
          'ping',
          '--host=127.0.0.1',
          '-uroot',
          `-p${fixturePassword}`,
          '--silent'
        ],
        { stdio: 'ignore' }
      ).status === 0
    ) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(ready, '隔离 MySQL 启动失败');
  const port = run('docker', ['port', container, '3306/tcp'])
    .trim()
    .match(/:(\d+)$/)[1];
  const url = `mysql://root:${fixturePassword}@127.0.0.1:${port}/${database}`;
  run('npx', ['prisma', 'migrate', 'deploy', '--schema', path.join(staged, 'schema.prisma')], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe'
  });
  const baselineDrift = run(
    'npx',
    [
      'prisma',
      'migrate',
      'diff',
      '--from-url',
      url,
      '--to-schema-datamodel',
      path.join(staged, 'schema.prisma')
    ],
    { env: { ...process.env, DATABASE_URL: url } }
  );
  sql(
    "INSERT INTO id_business_v2_bank_recharge_orders (id,order_no,source,plan,charge_amount,charge_currency_code,customer_fee_rate,customer_fee_amount,bank_fee_amount,bank_fee_currency_code,profit_amount_cny,updated_at) VALUES ('fa000000-0000-4000-8000-000000000123','MIGRATION_LEGACY_FIXTURE','manual','plus',100,'CNY',2.5,2.5,3,'CNY',47,NOW(6))"
  );
  run('npx', ['prisma', 'migrate', 'deploy', '--schema', 'apps/api/prisma-mysql/schema.prisma'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe'
  });
  const history = sql(
    "SELECT accounting_version,customer_fee_amount,bank_fee_amount,profit_amount_cny,usdt_fee_amount IS NULL,shopping_fee_amount IS NULL FROM id_business_v2_bank_recharge_orders WHERE order_no='MIGRATION_LEGACY_FIXTURE'"
  ).trim();
  assert.equal(history, 'legacy\t2.5000\t3.0000\t47.0000\t1\t1');
  if (!migrationOnly) {
    run(
      'npm',
      [
        'run',
        'test',
        '--workspace',
        '@apple-business/api',
        '--',
        'src/id-business-v2/finance/finance-exchange-costs-mysql.integration.spec.ts',
        ...(compatibilityOnly ? ['-t', '旧口径转换'] : [])
      ],
      { env: { ...process.env, V2_EXCHANGE_COST_TEST_DATABASE_URL: url }, stdio: 'inherit' }
    );
    if (!compatibilityOnly) {
      sql(`CREATE DATABASE \`${legacyDb}\``);
      const legacyUrl = `mysql://root:${fixturePassword}@127.0.0.1:${port}/${legacyDb}`;
      run(
        'npx',
        ['prisma', 'migrate', 'deploy', '--schema', 'apps/api/prisma-mysql/schema.prisma'],
        {
          env: { ...process.env, DATABASE_URL: legacyUrl },
          stdio: 'ignore'
        }
      );
      run(
        'npm',
        [
          'run',
          'test',
          '--workspace',
          '@apple-business/api',
          '--',
          'src/id-business-v2/auto-recharge/bank-recharge-mysql.integration.spec.ts'
        ],
        { env: { ...process.env, V2_BANK_RECHARGE_TEST_DATABASE_URL: legacyUrl }, stdio: 'inherit' }
      );
    }
  }
  const drift = run(
    'npx',
    [
      'prisma',
      'migrate',
      'diff',
      '--from-url',
      url,
      '--to-schema-datamodel',
      'apps/api/prisma-mysql/schema.prisma'
    ],
    { env: { ...process.env, DATABASE_URL: url } }
  );
  assert.equal(drift, baselineDrift, '本次迁移不得引入新增 schema 差异');
  outcome = {
    ok: true,
    migration: '20261001090000_fx_subscription_costs',
    historicalRowPreserved: true,
    introducedMigrationDrift: false,
    existingSchemaConventions: !/No difference/.test(baselineDrift),
    phase: migrationOnly ? 'migration-only' : compatibilityOnly ? 'compatibility-only' : 'full',
    database: 'disposable_local_mysql',
    completedAt: new Date().toISOString()
  };
  console.log(JSON.stringify(outcome));
} catch (error) {
  outcome = {
    ok: false,
    error: String(error.message).replaceAll(fixturePassword, '[redacted]'),
    completedAt: new Date().toISOString()
  };
  throw error;
} finally {
  if (outcome)
    writeFileSync(
      path.join(
        evidence,
        compatibilityOnly ? 'mysql-compatibility-acceptance.json' : 'mysql-acceptance.json'
      ),
      JSON.stringify(outcome, null, 2)
    );
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
}
