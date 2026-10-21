import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertV2AuditConnectionReadOnly,
  buildV2DataIntegrityCheckQuery
} from './lib/v2-data-integrity-audit.mjs';
import { V2_ONLINE_RECHARGE_INTEGRITY_CHECKS } from './lib/v2-online-recharge-integrity.mjs';

export async function auditOnlineRechargeIntegrity(client, { expectedDatabase }) {
  if (!expectedDatabase) throw new Error('缺少巡检目标数据库');
  try {
    await client.$connect();
    assertV2AuditConnectionReadOnly(await client.$queryRawUnsafe('SHOW GRANTS'));
    await client.$executeRawUnsafe('SET SESSION TRANSACTION READ ONLY');
    const checks = await client.$transaction(
      async (tx) => {
        const [identity] = await tx.$queryRawUnsafe(
          'SELECT DATABASE() AS databaseName, @@transaction_isolation AS isolationLevel, ' +
            '@@session.transaction_read_only AS readOnly, @@session.foreign_key_checks AS foreignKeys'
        );
        if (
          identity?.databaseName !== expectedDatabase ||
          identity.isolationLevel !== 'REPEATABLE-READ' ||
          String(identity.readOnly) !== '1' ||
          String(identity.foreignKeys) !== '1'
        )
          throw new Error('巡检目标或只读事务状态不符合要求');
        const results = [];
        for (const definition of V2_ONLINE_RECHARGE_INTEGRITY_CHECKS) {
          let rows;
          try {
            rows = await tx.$queryRawUnsafe(buildV2DataIntegrityCheckQuery(definition.sql));
          } catch {
            throw new Error(`线上代充巡检规则执行失败：${definition.code}`);
          }
          const value = rows.length === 1 ? String(rows[0].count) : '';
          const count = Number(value);
          if (!/^\d+$/.test(value) || !Number.isSafeInteger(count))
            throw new Error(`线上代充巡检返回无效计数：${definition.code}`);
          results.push({ code: definition.code, severity: definition.severity, count });
        }
        return results;
      },
      { isolationLevel: 'RepeatableRead', timeout: 120000 }
    );
    const count = (severity) =>
      checks.filter((c) => c.severity === severity).reduce((n, c) => n + c.count, 0);
    const errorCount = count('error'),
      warningCount = count('warning');
    return {
      ok: errorCount === 0 && warningCount === 0,
      checkCount: checks.length,
      errorCount,
      warningCount,
      verifiedReadOnlyAccount: true,
      checks,
      generatedAt: new Date().toISOString()
    };
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const value = process.env.V2_DATA_INTEGRITY_DATABASE_URL;
    if (!value || !/^mysql:\/\//i.test(value)) throw new Error('缺少 MySQL 只读巡检连接');
    const url = new URL(value);
    const { PrismaClient } = await import('@prisma/client');
    const result = await auditOnlineRechargeIntegrity(new PrismaClient({ datasourceUrl: value }), {
      expectedDatabase: decodeURIComponent(url.pathname.slice(1))
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.error('线上代充只读巡检未完成；请检查只读权限、目标和规则，连接信息已隐藏');
    process.exitCode = 1;
  }
}
