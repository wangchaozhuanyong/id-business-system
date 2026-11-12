import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { checkNativeProductionDatabase, nativeProductionRuntimeEnv } from '/candidate/modules/recharge/codexdaichong/runtime.mjs';
import { createNativeRechargeRouting, DEFAULT_PLAN_ROUTES } from '/candidate/modules/recharge/codexdaichong/native-routing.mjs';

const engineDir = '/candidate/.runtime/codexdaichong';
const require = createRequire(engineDir + '/package.json');
const { createConnection } = require('mysql2/promise');
const [password, secret] = readFileSync(0, 'utf8').trimEnd().split('\n');
const env = nativeProductionRuntimeEnv({ ...process.env, DB_PASSWORD: password, ID_RECHARGE_BRIDGE_SECRET: secret });
const db = await createConnection({ host: env.DB_HOST, port: Number(env.DB_PORT), database: env.DB_NAME,
  user: env.DB_USER, password: env.DB_PASSWORD, connectTimeout: 3000 });

try {
  if (process.argv.includes('--require-idle')) await checkNativeProductionDatabase(env, createConnection);
  await db.query('START TRANSACTION READ ONLY');
  const [[row]] = await db.query({ sql: `
    SELECT DATABASE() AS databaseName, CURRENT_USER() AS account,
      (EXISTS(SELECT 1 FROM app_config WHERE config_key = 'gpt_api_enabled' AND config_value = '1')
        AND EXISTS(SELECT 1 FROM app_config WHERE config_key = 'gpt_api_key' AND LENGTH(TRIM(config_value)) > 0)) AS providerActive,
      (SELECT COUNT(*) FROM task_logs WHERE status NOT IN ('success', 'failed', 'card_invalid')
        AND (NULLIF(gpt_api_order_id, '') IS NOT NULL OR NULLIF(gpt_api_task_id, '') IS NOT NULL)) AS providerInFlight,
      (SELECT COUNT(*) FROM activation_manual_holds AS hold_row JOIN task_logs AS task
        ON task.job_key = hold_row.failed_job_key WHERE hold_row.resolved_at IS NULL
          AND (NULLIF(task.gpt_api_order_id, '') IS NOT NULL OR NULLIF(task.gpt_api_task_id, '') IS NOT NULL)) AS providerUnresolved,
      (SELECT COUNT(*) FROM card_assets WHERE is_active = 1 AND in_use = 0 AND status = '正常'
        AND (cooldown_until IS NULL OR cooldown_until < NOW())) AS availableCards
  `, timeout: 5000 });
  if (row?.databaseName !== env.DB_NAME || row.account?.split('@')[0] !== env.DB_USER)
    throw new Error('Database identity mismatch');
  const result = { providerActive: Boolean(row.providerActive), providerInFlight: Number(row.providerInFlight),
    providerUnresolved: Number(row.providerUnresolved), availableCards: Number(row.availableCards), readOnly: true };
  if (process.argv.includes('--routes')) {
    const routing = createNativeRechargeRouting({ engineDir, store: {
      async runQuery(sql, values) { const [rows] = await db.query({ sql, timeout: 5000 }, values); return rows; },
      async runExecute() { return {}; }
    } });
    result.routes = Object.fromEntries(await Promise.all(Object.keys(DEFAULT_PLAN_ROUTES).map(async plan => {
      try { return [plan, Boolean(await routing.resolve(plan))]; }
      catch { return [plan, false]; }
    })));
  }
  console.log(JSON.stringify(result));
} catch {
  process.exitCode = 1;
} finally {
  await db.end();
}
