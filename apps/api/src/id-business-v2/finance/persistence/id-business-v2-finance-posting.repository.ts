import type { Prisma } from '@prisma/client';
import { mapAmount4 } from '../../runtime/public-api';

export async function findLockedFinancePeriodStatus(tx: Prisma.TransactionClient, month: string) {
  const rows = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT "status"
    FROM "id_business_v2_finance_periods"
    WHERE "month" = ${month}
    FOR SHARE
  `;
  return rows[0]?.status ?? null;
}

export async function lockFinanceAccount(tx: Prisma.TransactionClient, accountId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string; status: string; currentBalance: unknown }>>`
    SELECT "id", "status", "current_balance" AS "currentBalance"
    FROM "id_business_v2_finance_accounts"
    WHERE "id" = ${accountId}
    FOR UPDATE
  `;
  const row = rows[0];
  return row
    ? {
        ...row,
        currentBalance: mapAmount4(
          row.currentBalance,
          'id_business_v2_finance_accounts.current_balance'
        )
      }
    : null;
}
