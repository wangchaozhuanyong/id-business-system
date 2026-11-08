import { readFile } from 'node:fs/promises';
const plans = new Set(['plus', 'pro100', 'pro200', 'pro500']);
const valid = item => item && /^KC-[A-F0-9]{28}$/.test(item.code || '') && plans.has(item.plan);
const validOperation = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(id);
const blocked = (reason, state = 'blocked') => ({ state, eligible: false, reason });
export async function migrateRechargeCodeReturns(connection) {
  const sql = await readFile(new URL('./code-returns-migration.sql', import.meta.url), 'utf8');
  await connection.query(sql);
}

/** Uses the original pool and transaction helper. No payment/task function is replaced. */
export function createNativeCodeReturns({ store }) {
  async function inspect(connection, item, operationId) {
    const query = async (sql, values) => (await connection.query(sql, values))[0];
    // The existing markCdkUsed conditional update competes for this same InnoDB row lock.
    const [code] = await query(`SELECT cdk_code, plan_type, type, is_active, used_at, shipped_at,
      fail_count, cooldown_until FROM cdk_codes WHERE cdk_code = ? FOR UPDATE`, [item.code]);
    if (!code || code.plan_type !== item.plan || code.type !== '自助') return blocked('充值码不存在或套餐不一致');
    const receipts = await query(`SELECT operation_id, cdk_code, plan_type, returned_at
      FROM id_recharge_code_returns WHERE cdk_code = ? OR operation_id = ?`, [item.code, operationId || '']);
    if (receipts.length) {
      const receipt = receipts.find(row => row.cdk_code === item.code && row.plan_type === item.plan &&
        (!operationId || row.operation_id === operationId));
      if (receipt && Number(code.is_active) === 0 && !code.used_at)
        return { state: 'returned', eligible: false, reason: '已归还', operationId: receipt.operation_id,
          returnedAt: new Date(receipt.returned_at).toISOString() };
      return blocked('归还回执与充值码状态冲突，请管理员核对', 'conflict');
    }
    if (Number(code.is_active) !== 1) return blocked('充值码已停用，归还状态待核对');
    if (code.used_at) return blocked('充值码已使用或正在受理');
    if (code.shipped_at) return blocked('充值码已交付，不能直接归还');
    if (Number(code.fail_count || 0) > 0 || code.cooldown_until) return blocked('存在历史尝试或冷却记录，请管理员核对');
    if ((await query('SELECT 1 FROM task_logs WHERE cdk_code = ? LIMIT 1', [item.code])).length)
      return blocked('存在历史充值任务，请管理员核对');
    if ((await query('SELECT 1 FROM activation_manual_holds WHERE cdk_code = ? AND resolved_at IS NULL LIMIT 1', [item.code])).length)
      return blocked('存在人工待核对付款，不能归还');
    return { state: 'unused', eligible: true, reason: '可归还' };
  }
  async function check(item) {
    return store.withTransaction(connection => inspect(connection, item));
  }
  async function receipt(item) {
    const rows = await store.runQuery(`SELECT operation_id, cdk_code, plan_type, returned_at
      FROM id_recharge_code_returns WHERE operation_id = ?`, [item.operationId]);
    if (!rows.length) return { state: 'not-found', eligible: false, reason: '尚无归还回执' };
    if (rows.length !== 1 || rows[0].cdk_code !== item.code || rows[0].plan_type !== item.plan)
      return blocked('归还操作编号与原码不一致', 'conflict');
    return store.withTransaction(connection => inspect(connection, item, item.operationId));
  }
  async function commit(item) {
    return store.withTransaction(async connection => {
      const result = await inspect(connection, item, item.operationId);
      if (!result.eligible) return result;
      const [changed] = await connection.execute(`UPDATE cdk_codes SET is_active = 0
        WHERE cdk_code = ? AND plan_type = ? AND type = '自助' AND is_active = 1
          AND used_at IS NULL AND shipped_at IS NULL`, [item.code, item.plan]);
      if (changed.affectedRows !== 1) throw new Error('code_return_race');
      await connection.execute(`INSERT INTO id_recharge_code_returns (operation_id, cdk_code, plan_type)
        VALUES (?, ?, ?)`, [item.operationId, item.code, item.plan]);
      // Read within the same transaction; the caller receives this only after commit succeeds.
      return inspect(connection, item, item.operationId);
    });
  }
  async function handle(req, res) {
    const path = (req.originalUrl || req.url).split('?')[0];
    if (req.method !== 'POST' || !['/api/admin/cdks/returns/check', '/api/admin/cdks/returns/commit',
      '/api/admin/cdks/returns/receipt'].includes(path)) return res.status(404).json({ success: false, message: '接口不存在' });
    try {
      if (path.endsWith('/check')) {
        const items = req.body?.items;
        if (!Array.isArray(items) || !items.length || items.length > 100 || !items.every(valid))
          return res.status(400).json({ success: false, message: '归还核对资料无效' });
        const result = [];
        for (const item of items) result.push({ code: item.code, plan: item.plan, ...await check(item) });
        return res.json({ success: true, items: result });
      }
      const item = req.body;
      if (!valid(item) || !validOperation(item.operationId))
        return res.status(400).json({ success: false, message: '归还操作资料无效' });
      return res.json({ success: true, receipt: await (path.endsWith('/commit') ? commit(item) : receipt(item)) });
    } catch {
      return res.status(503).json({ success: false, message: '无法确认充值码归还状态，请按原操作核对' });
    }
  }
  return { check, commit, receipt, handle };
}
