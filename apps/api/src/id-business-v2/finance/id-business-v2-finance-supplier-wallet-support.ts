import { NotFoundException } from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { toV2DecimalString } from '../decimal-policy';

export async function lockFinanceSupplierWallet(tx: Prisma.TransactionClient, walletId: string) {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      currency: 'CNY' | 'MYR' | 'USDT';
      currentBalance: PrismaNamespace.Decimal;
      currentBalanceCny: PrismaNamespace.Decimal;
      supplierName: string;
    }>
  >`
    SELECT
      account."id",
      account."currency",
      account."current_balance" AS "currentBalance",
      account."current_balance_cny" AS "currentBalanceCny",
      supplier."name" AS "supplierName"
    FROM "id_business_v2_topup_supplier_accounts" account
    INNER JOIN "id_business_v2_options" supplier
      ON supplier."id" = account."supplier_option_id"
    WHERE account."id" = ${walletId}::uuid
    FOR UPDATE OF account
  `;
  const row = rows[0];
  if (!row) throw new NotFoundException('供应商钱包不存在');
  return row;
}

export function toFinanceSupplierWalletResponse(item: {
  id: string;
  supplierOptionId: string;
  currency: string;
  openingBalance: PrismaNamespace.Decimal;
  currentBalance: PrismaNamespace.Decimal;
  openingBalanceCny: PrismaNamespace.Decimal;
  currentBalanceCny: PrismaNamespace.Decimal;
  status: string;
  initializedAt: Date | null;
  updatedAt: Date;
  supplierOption: { name: string };
}) {
  return {
    id: item.id,
    supplierOptionId: item.supplierOptionId,
    supplierName: item.supplierOption.name,
    currency: item.currency,
    openingBalance: toV2DecimalString(item.openingBalance),
    currentBalance: toV2DecimalString(item.currentBalance),
    openingBalanceCny: toV2DecimalString(item.openingBalanceCny),
    currentBalanceCny: toV2DecimalString(item.currentBalanceCny),
    status: item.status,
    initializedAt: item.initializedAt,
    updatedAt: item.updatedAt
  };
}

export function toFinanceSupplierPaymentResponse(item: {
  id: string;
  supplierAccountId: string;
  paidCurrency: string;
  paidAmount: PrismaNamespace.Decimal;
  networkFeeAmount: PrismaNamespace.Decimal;
  fxRateToCny: PrismaNamespace.Decimal;
  creditedAmount: PrismaNamespace.Decimal;
  creditedCny: PrismaNamespace.Decimal;
  paidAt: Date;
  createdAt: Date;
  supplierAccount: { supplierOption: { name: string } };
}) {
  return {
    id: item.id,
    supplierAccountId: item.supplierAccountId,
    supplierName: item.supplierAccount.supplierOption.name,
    paidCurrency: item.paidCurrency,
    paidAmount: toV2DecimalString(item.paidAmount),
    networkFeeAmount: toV2DecimalString(item.networkFeeAmount),
    fxRateToCny: item.fxRateToCny.toString(),
    creditedAmount: toV2DecimalString(item.creditedAmount),
    creditedCny: toV2DecimalString(item.creditedCny),
    paidAt: item.paidAt,
    createdAt: item.createdAt
  };
}

export function writeFinanceSupplierWalletAudit(
  tx: Prisma.TransactionClient,
  operator: AuthenticatedUser | undefined,
  action: string,
  objectId: string,
  afterData: Prisma.InputJsonValue
) {
  return tx.auditLog.create({
    data: {
      userId: operator?.id,
      module: 'id_business_v2_finance',
      action: `id_business_v2.finance_supplier_wallet.${action}`,
      objectType: 'id_business_v2_topup_supplier_account',
      objectId,
      afterData,
      remark: '供应商资金账务变更'
    }
  });
}
