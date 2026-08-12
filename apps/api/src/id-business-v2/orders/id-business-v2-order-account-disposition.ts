import { BadRequestException, ConflictException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { Amount4, type V2CommandTransaction } from '../runtime/public-api';
import type { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';
import type {
  IdBusinessV2OrderAccountDisposition,
  IdBusinessV2OrderAccountSource
} from './id-business-v2-order.types';

export interface AccountDispositionOrder {
  id: string;
  accountId: string | null;
  accountDisposition: IdBusinessV2OrderAccountDisposition;
  accountCostAmount: Amount4;
  appliedAccountCostAmount: Amount4;
  accountSource: IdBusinessV2OrderAccountSource;
}

export function normalizeOrderAccountDisposition(
  value: unknown
): IdBusinessV2OrderAccountDisposition {
  if (value === 'retained' || value === 'sold') {
    return value;
  }
  throw new BadRequestException('ID 处理方式无效');
}

export async function applyNewOrderAccountDisposition(
  tx: V2CommandTransaction,
  repository: IdBusinessV2OrdersRepository,
  orderId: string,
  accountId: string,
  disposition: IdBusinessV2OrderAccountDisposition,
  accountSource: IdBusinessV2OrderAccountSource,
  operator?: AuthenticatedUser
) {
  const account = await repository.lockAccountForSale(tx, accountId);
  if (!account) {
    throw new ConflictException('使用 ID 不存在，请重新匹配');
  }
  if (account.lossReportedAt) {
    throw new ConflictException('已报损冻结 ID 不能用于订单');
  }

  if (accountSource === 'customer_owned' && !account.soldByOrderId) {
    throw new ConflictException('客户已购 ID 缺少原销售归属');
  }
  if (accountSource === 'inventory' && disposition === 'sold') {
    assertAccountCanBeSold(account.soldByOrderId, orderId);
    await markAccountSold(
      tx,
      repository,
      account.id,
      orderId,
      account.soldByOrderId === orderId,
      operator
    );
  }

  await repository.updateOrder(tx, orderId, {
    accountCostAmount:
      accountSource === 'inventory' && disposition === 'sold'
        ? account.purchaseCost.toString()
        : '0',
    appliedAccountCostAmount:
      accountSource === 'inventory' && disposition === 'sold'
        ? account.purchaseCost.toString()
        : '0',
    accountDisposition: accountSource === 'customer_owned' ? 'retained' : disposition,
    updatedByUserId: operator?.id
  });
}

export async function applyUpdatedOrderAccountDisposition(
  tx: V2CommandTransaction,
  repository: IdBusinessV2OrdersRepository,
  order: AccountDispositionOrder,
  accountId: string,
  disposition: IdBusinessV2OrderAccountDisposition,
  operator?: AuthenticatedUser
) {
  const account = await repository.lockAccountForSale(tx, accountId);
  if (!account) {
    throw new ConflictException('使用 ID 不存在或已删除');
  }
  if (account.lossReportedAt) {
    throw new ConflictException('已报损冻结 ID 不能用于订单');
  }

  if (
    order.accountDisposition === 'sold' &&
    order.accountId &&
    (order.accountId !== accountId || disposition !== 'sold')
  ) {
    await releaseSoldOrderAccount(tx, repository, order, operator);
  }

  if (order.accountSource === 'customer_owned' || disposition !== 'sold') {
    return Amount4.zero();
  }

  assertAccountCanBeSold(account.soldByOrderId, order.id);
  await markAccountSold(
    tx,
    repository,
    account.id,
    order.id,
    account.soldByOrderId === order.id,
    operator
  );
  return order.accountDisposition === 'sold' && order.accountId === accountId
    ? order.accountCostAmount
    : account.purchaseCost;
}

export async function releaseSoldOrderAccount(
  tx: V2CommandTransaction,
  repository: IdBusinessV2OrdersRepository,
  order: Pick<AccountDispositionOrder, 'id' | 'accountId'>,
  operator?: AuthenticatedUser
) {
  if (!order.accountId) return;
  const result = await repository.releaseSoldAccount(tx, {
    accountId: order.accountId,
    orderId: order.id,
    updatedByUserId: operator?.id
  });
  if (result.count === 0) {
    const lostAccount = await repository.findLostSoldAccount(tx, order.accountId, order.id);
    if (lostAccount) {
      throw new ConflictException('已报损冻结 ID 不能标记为收回或恢复可用');
    }
  }
}

function assertAccountCanBeSold(soldByOrderId: string | null, orderId: string) {
  if (soldByOrderId && soldByOrderId !== orderId) {
    throw new ConflictException('该 ID 已被其他订单卖出，不能再次使用');
  }
}

function markAccountSold(
  tx: V2CommandTransaction,
  repository: IdBusinessV2OrdersRepository,
  accountId: string,
  orderId: string,
  replay: boolean,
  operator?: AuthenticatedUser
) {
  return repository.markAccountSold(tx, {
    accountId,
    orderId,
    soldAt: replay ? undefined : new Date(),
    updatedByUserId: operator?.id
  });
}
