import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

type TransactionLockClient = Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>;

export function isMysqlRuntimeDatabase(
  databaseUrl = process.env.DATABASE_URL ?? process.env.V2_RUNTIME_DATABASE_URL
) {
  return databaseUrl?.trim().toLowerCase().startsWith('mysql://') ?? false;
}

export async function acquireMysqlTransactionLock(client: TransactionLockClient, lockKey: string) {
  if (!isMysqlRuntimeDatabase()) {
    await client.$queryRaw`
      SELECT 1::integer AS "locked"
      FROM (
        SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
      ) AS "transaction_lock"
    `;
    return;
  }

  const normalizedKey = createHash('sha256').update(lockKey).digest('hex');
  await client.$executeRaw`
    INSERT INTO "mysql_transaction_locks" ("lock_key", "updated_at")
    VALUES (${normalizedKey}, UTC_TIMESTAMP(6))
    ON DUPLICATE KEY UPDATE "updated_at" = VALUES("updated_at")
  `;
}
