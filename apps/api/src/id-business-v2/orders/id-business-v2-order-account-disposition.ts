import { BadRequestException, ConflictException } from '@nestjs/common';
import { IdBusinessV2OrderAccountDisposition, Prisma as PrismaNamespace } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';

export interface AccountDispositionOrder {
  id: string;
  accountId: string | null;
  accountDisposition: IdBusinessV2OrderAccountDisposition;
  accountCostAmount: PrismaNamespace.Decimal;
}

export function normalizeOrderAccountDisposition(
  value: unknown
): IdBusinessV2OrderAccountDisposition {
  if (
    value === IdBusinessV2OrderAccountDisposition.retained ||
    value === IdBusinessV2OrderAccountDisposition.sold
  ) {
    return value;
  }
  throw new BadRequestException('ID 处理方式无效');
}

export async function applyNewOrderAccountDisposition(
  tx: PrismaNamespace.TransactionClient,
  orderId: string,
  accountId: string,
  disposition: IdBusinessV2OrderAccountDisposition,
  operator?: AuthenticatedUser
) {
  const account = await lockAccountForSale(tx, accountId);
  if (!account) {
    throw new ConflictException('使用 ID 不存在，请重新匹配');
  }
  if (account.lossReportedAt) {
    throw new ConflictException('已报损 ID 永久冻结，不能用于订单');
  }

  if (disposition === IdBusinessV2OrderAccountDisposition.sold) {
    assertAccountCanBeSold(account.soldByOrderId, orderId);
    await markAccountSold(tx, account.id, orderId, account.soldByOrderId === orderId, operator);
  }

  await tx.idBusinessV2Order.update({
    where: {
      id: orderId
    },
    data: {
      accountCostAmount:
        disposition === IdBusinessV2OrderAccountDisposition.sold ? account.purchaseCost : 0,
      accountDisposition: disposition,
      updatedByUserId: operator?.id
    }
  });
}

export async function applyUpdatedOrderAccountDisposition(
  tx: PrismaNamespace.TransactionClient,
  order: AccountDispositionOrder,
  accountId: string,
  disposition: IdBusinessV2OrderAccountDisposition,
  operator?: AuthenticatedUser
) {
  const account = await lockAccountForSale(tx, accountId);
  if (!account) {
    throw new ConflictException('使用 ID 不存在或已删除');
  }
  if (account.lossReportedAt) {
    throw new ConflictException('已报损 ID 永久冻结，不能用于订单');
  }

  if (
    order.accountDisposition === IdBusinessV2OrderAccountDisposition.sold &&
    order.accountId &&
    (order.accountId !== accountId || disposition !== IdBusinessV2OrderAccountDisposition.sold)
  ) {
    await releaseSoldOrderAccount(tx, order, operator);
  }

  if (disposition !== IdBusinessV2OrderAccountDisposition.sold) {
    return new PrismaNamespace.Decimal(0);
  }

  assertAccountCanBeSold(account.soldByOrderId, order.id);
  await markAccountSold(tx, account.id, order.id, account.soldByOrderId === order.id, operator);
  return order.accountDisposition === IdBusinessV2OrderAccountDisposition.sold &&
    order.accountId === accountId
    ? order.accountCostAmount
    : account.purchaseCost;
}

export async function releaseSoldOrderAccount(
  tx: PrismaNamespace.TransactionClient,
  order: Pick<AccountDispositionOrder, 'id' | 'accountId'>,
  operator?: AuthenticatedUser
) {
  if (!order.accountId) return;
  const result = await tx.idBusinessV2Account.updateMany({
    where: {
      id: order.accountId,
      soldByOrderId: order.id,
      lossReportedAt: null
    },
    data: {
      soldByOrderId: null,
      soldAt: null,
      updatedByUserId: operator?.id
    }
  });
  if (result.count === 0) {
    const lostAccount = await tx.idBusinessV2Account.findFirst({
      where: {
        id: order.accountId,
        soldByOrderId: order.id,
        lossReportedAt: { not: null }
      },
      select: { id: true }
    });
    if (lostAccount) {
      throw new ConflictException('已报损 ID 永久冻结，不能标记为收回或恢复可用');
    }
  }
}

async function lockAccountForSale(tx: PrismaNamespace.TransactionClient, accountId: string) {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      purchaseCost: PrismaNamespace.Decimal;
      soldByOrderId: string | null;
      lossReportedAt: Date | null;
    }>
  >(PrismaNamespace.sql`
    SELECT
      "id",
      "purchase_cost" AS "purchaseCost",
      "sold_by_order_id" AS "soldByOrderId",
      "loss_reported_at" AS "lossReportedAt"
    FROM "id_business_v2_accounts"
    WHERE
      "id" = CAST(${accountId} AS UUID)
      AND "deleted_at" IS NULL
    FOR UPDATE
  `);
  return rows[0] ?? null;
}

function assertAccountCanBeSold(soldByOrderId: string | null, orderId: string) {
  if (soldByOrderId && soldByOrderId !== orderId) {
    throw new ConflictException('该 ID 已被其他订单卖出，不能再次使用');
  }
}

function markAccountSold(
  tx: PrismaNamespace.TransactionClient,
  accountId: string,
  orderId: string,
  replay: boolean,
  operator?: AuthenticatedUser
) {
  return tx.idBusinessV2Account.update({
    where: {
      id: accountId
    },
    data: {
      soldByOrderId: orderId,
      soldAt: replay ? undefined : new Date(),
      updatedByUserId: operator?.id
    }
  });
}
