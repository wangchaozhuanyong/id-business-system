#!/usr/bin/env node

import process from 'node:process';
import { Client } from 'pg';
import { normalizeDatabaseConnection } from './lib/production-closure-audit.mjs';
import {
  V2_DATA_INTEGRITY_CHECKS,
  assessV2DataIntegrity,
  buildV2DataIntegrityCheckQuery
} from './lib/v2-data-integrity-audit.mjs';

const databaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('缺少只读审计数据库地址（DATABASE_URL）');

const client = new Client({
  ...normalizeDatabaseConnection(databaseUrl),
  application_name: 'id-v2-data-integrity-audit'
});

try {
  await client.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const identity = (
    await client.query(
      `SELECT current_user AS "currentUser",
              current_setting('transaction_read_only') AS "transactionReadOnly"`
    )
  ).rows[0];
  const checks = [];
  for (const check of V2_DATA_INTEGRITY_CHECKS) {
    const result = (await client.query(buildV2DataIntegrityCheckQuery(check.sql))).rows[0];
    checks.push({
      code: check.code,
      description: check.description,
      count: Number(result.count),
      samples: result.samples
    });
  }
  await client.query('COMMIT');

  const assessment = assessV2DataIntegrity(checks);
  console.log(
    JSON.stringify(
      {
        ...assessment,
        generatedAt: new Date().toISOString(),
        identity,
        checks
      },
      null,
      2
    )
  );
  if (!assessment.ok) process.exitCode = 1;
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await client.end().catch(() => undefined);
}
