import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { mapAmount4, type Amount4, type V2CommandTransaction } from '../../runtime/public-api';

interface LockedSupplierAccountPersistenceRow {
  id: string;
  supplierOptionId: string;
  supplierName: string;
  currency: 'CNY' | 'MYR' | 'USD' | 'USDT';
  currentBalance: unknown;
  currentBalanceCny: unknown;
  initializedAt: Date | null;
}

export interface LockedSupplierAccountRow extends Omit<
  LockedSupplierAccountPersistenceRow,
  'currentBalance' | 'currentBalanceCny'
> {
  currentBalance: Amount4;
  currentBalanceCny: Amount4;
}

@Injectable()
export class IdBusinessV2TopupSupplierAccountRepository {
  async lockBySupplierOptionId(tx: V2CommandTransaction, supplierOptionId: string) {
    const rows = await tx.$queryRaw<LockedSupplierAccountPersistenceRow[]>(Prisma.sql`
      SELECT
        account."id",
        account."supplier_option_id" AS "supplierOptionId",
        supplier."name" AS "supplierName",
        account."currency",
        account."current_balance" AS "currentBalance",
        account."current_balance_cny" AS "currentBalanceCny",
        account."initialized_at" AS "initializedAt"
      FROM "id_business_v2_topup_supplier_accounts" account
      INNER JOIN "id_business_v2_options" supplier
        ON supplier."id" = account."supplier_option_id"
      WHERE
        account."supplier_option_id" = ${supplierOptionId}
        AND account."currency" = 'CNY'
        AND account."status" = 'active'
        AND supplier."type" = 'topup_supplier'
        AND supplier."status" = 'active'
        AND supplier."deleted_at" IS NULL
      FOR UPDATE
    `);
    return rows[0] ? mapLockedSupplierAccount(rows[0]) : null;
  }

  async lockById(tx: V2CommandTransaction, accountId: string) {
    const rows = await tx.$queryRaw<LockedSupplierAccountPersistenceRow[]>(Prisma.sql`
      SELECT
        account."id",
        account."supplier_option_id" AS "supplierOptionId",
        supplier."name" AS "supplierName",
        account."currency",
        account."current_balance" AS "currentBalance",
        account."current_balance_cny" AS "currentBalanceCny",
        account."initialized_at" AS "initializedAt"
      FROM "id_business_v2_topup_supplier_accounts" account
      INNER JOIN "id_business_v2_options" supplier
        ON supplier."id" = account."supplier_option_id"
      WHERE account."id" = ${accountId}
      FOR UPDATE
    `);
    return rows[0] ? mapLockedSupplierAccount(rows[0]) : null;
  }

  async lockByIds(tx: V2CommandTransaction, accountIds: string[]) {
    const uniqueIds = [...new Set(accountIds)].sort();
    const rows = await tx.$queryRaw<LockedSupplierAccountPersistenceRow[]>(Prisma.sql`
      SELECT
        account."id",
        account."supplier_option_id" AS "supplierOptionId",
        supplier."name" AS "supplierName",
        account."currency",
        account."current_balance" AS "currentBalance",
        account."current_balance_cny" AS "currentBalanceCny",
        account."initialized_at" AS "initializedAt"
      FROM "id_business_v2_topup_supplier_accounts" account
      INNER JOIN "id_business_v2_options" supplier
        ON supplier."id" = account."supplier_option_id"
      WHERE
        account."id" IN (${Prisma.join(uniqueIds.map((id) => Prisma.sql`${id}`))})
        AND account."currency" = 'CNY'
      ORDER BY account."id"
      FOR UPDATE
    `);
    return new Map(rows.map((row) => [row.id, mapLockedSupplierAccount(row)]));
  }
}

function mapLockedSupplierAccount(
  row: LockedSupplierAccountPersistenceRow
): LockedSupplierAccountRow {
  return {
    ...row,
    currentBalance: mapAmount4(
      row.currentBalance,
      'id_business_v2_topup_supplier_accounts.current_balance'
    ),
    currentBalanceCny: mapAmount4(
      row.currentBalanceCny,
      'id_business_v2_topup_supplier_accounts.current_balance_cny'
    )
  };
}
