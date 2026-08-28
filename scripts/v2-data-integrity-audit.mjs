#!/usr/bin/env node

import process from 'node:process';
import { PrismaClient } from '@prisma/client';
import {
  V2_DATA_INTEGRITY_CHECKS,
  assessV2DataIntegrity,
  assertV2AuditConnectionReadOnly,
  buildV2DataIntegrityCheckQueries,
  normalizeV2DataIntegritySamples
} from './lib/v2-data-integrity-audit.mjs';

const databaseUrl = process.env.V2_DATA_INTEGRITY_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('缺少 MySQL 只读巡检地址（V2_DATA_INTEGRITY_DATABASE_URL）');
}
if (!/^mysql:\/\//i.test(databaseUrl.trim())) {
  throw new Error('数据一致性巡检只支持当前 MySQL 运行时');
}

const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

try {
  await client.$connect();
  const grants = await client.$queryRawUnsafe('SHOW GRANTS');
  assertV2AuditConnectionReadOnly(grants);

  const { identity, checks } = await client.$transaction(
    async (tx) => {
      const identityRows = await tx.$queryRawUnsafe(
        `SELECT CURRENT_USER() AS currentUser,
                @@transaction_isolation AS transactionIsolation,
                @@session.foreign_key_checks AS foreignKeyChecks`
      );
      const results = [];
      for (const check of V2_DATA_INTEGRITY_CHECKS) {
        try {
          const queries = buildV2DataIntegrityCheckQueries(check.sql);
          const countRows = await tx.$queryRawUnsafe(queries.count);
          const count = Number(countRows[0]?.count ?? 0);
          const sampleRows = count > 0 ? await tx.$queryRawUnsafe(queries.samples) : [];
          results.push({
            code: check.code,
            description: check.description,
            count,
            samples: normalizeV2DataIntegritySamples(sampleRows)
          });
        } catch (error) {
          throw new Error(`MySQL 数据一致性巡检 ${check.code} 执行失败`, { cause: error });
        }
      }
      return { identity: identityRows[0], checks: results };
    },
    { isolationLevel: 'RepeatableRead', timeout: 120_000 }
  );

  const assessment = assessV2DataIntegrity(checks);
  console.log(
    JSON.stringify(
      {
        ...assessment,
        generatedAt: new Date().toISOString(),
        identity,
        checks
      },
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
      2
    )
  );
  if (!assessment.ok) process.exitCode = 1;
} finally {
  await client.$disconnect().catch(() => undefined);
}
