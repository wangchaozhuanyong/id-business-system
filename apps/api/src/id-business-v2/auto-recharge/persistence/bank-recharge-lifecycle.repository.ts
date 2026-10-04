import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { acquireMysqlTransactionLock } from '../../../common/prisma/mysql-transaction-lock';
import type { V2CommandTransaction } from '../../runtime/public-api';

@Injectable()
export class BankRechargeLifecycleRepository {
  constructor(private readonly prisma: PrismaService) {}

  read<T>(work: (tx: V2CommandTransaction) => Promise<T>) {
    return this.prisma.$transaction(work, { isolationLevel: 'Serializable' });
  }
  lock(tx: V2CommandTransaction) {
    return acquireMysqlTransactionLock(tx, 'auto-recharge-single-worker');
  }
  account(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2ChatgptAccount.findUnique({ where: { id } });
  }
  order(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2BankRechargeOrder.findUnique({ where: { id } });
  }
  async accountReferences(tx: V2CommandTransaction, id: string) {
    const [jobs, orders, subscriptions, registrations] = await Promise.all([
      tx.idBusinessV2RechargeJob.count({ where: { chatgptAccountId: id } }),
      tx.idBusinessV2BankRechargeOrder.count({ where: { accountId: id } }),
      tx.idBusinessV2BankRechargeSubscription.count({ where: { accountId: id } }),
      tx.idBusinessV2RegistrationJob.count({ where: { accountId: id } })
    ]);
    return { jobs, orders, subscriptions, registrations };
  }
  async orderReferences(tx: V2CommandTransaction, id: string, accountId: string | null) {
    const [journals, successor, subscription] = await Promise.all([
      tx.idBusinessV2FinanceJournal.count({ where: { sourceType: 'bank_recharge', sourceId: id } }),
      tx.idBusinessV2BankRechargeOrder.count({ where: { renewedFromOrderId: id } }),
      accountId
        ? tx.idBusinessV2BankRechargeSubscription.findUnique({ where: { accountId } })
        : null
    ]);
    return {
      journals,
      successor,
      currentOrderId: subscription?.currentOrderId ?? null,
      subscriptionUpdatedAt: subscription?.updatedAt.toISOString() ?? null
    };
  }
  updateAccount(tx: V2CommandTransaction, id: string, deletedAt: Date | null, operatorId: string) {
    return tx.idBusinessV2ChatgptAccount.update({
      where: { id },
      data: { deletedAt, status: 'disabled', updatedByUserId: operatorId }
    });
  }
  updateOrder(
    tx: V2CommandTransaction,
    id: string,
    deletedAt: Date | null,
    restoring: boolean,
    operatorId: string
  ) {
    return tx.idBusinessV2BankRechargeOrder.update({
      where: { id },
      data: {
        deletedAt,
        status: restoring ? 'pending_details' : 'cancelled',
        ...(restoring ? { openedAt: null, dueAt: null } : {}),
        updatedByUserId: operatorId
      }
    });
  }
  cancelProjection(tx: V2CommandTransaction, currentOrderId: string) {
    return tx.idBusinessV2BankRechargeSubscription.updateMany({
      where: { currentOrderId },
      data: { status: 'cancelled' }
    });
  }
  originalPaymentAccountKey(tx: V2CommandTransaction, rechargeJobId: string) {
    return tx.idBusinessV2RechargeJob.findUnique({
      where: { id: rechargeJobId },
      select: { accountKey: true }
    });
  }
  subscription(tx: V2CommandTransaction, accountId: string) {
    return tx.idBusinessV2BankRechargeSubscription.findUnique({ where: { accountId } });
  }
  updateDates(
    tx: V2CommandTransaction,
    id: string,
    openedAt: Date,
    dueAt: Date,
    operatorId: string
  ) {
    return tx.idBusinessV2BankRechargeOrder.update({
      where: { id },
      data: { openedAt, dueAt, updatedByUserId: operatorId }
    });
  }
  activateReviewed(
    tx: V2CommandTransaction,
    order: {
      id: string;
      accountId: string;
      customerId: string | null;
      plan: string;
      openedAt: Date;
      dueAt: Date;
    }
  ) {
    const data = {
      accountId: order.accountId,
      currentOrderId: order.id,
      customerId: order.customerId,
      plan: order.plan,
      openedAt: order.openedAt,
      dueAt: order.dueAt,
      status: order.dueAt > new Date() ? ('active' as const) : ('expired' as const)
    };
    return tx.idBusinessV2BankRechargeSubscription.upsert({
      where: { accountId: order.accountId },
      create: data,
      update: data
    });
  }
  command(tx: V2CommandTransaction, operationId: string) {
    return tx.auditLog.findFirst({
      where: {
        module: 'id_business_v2',
        afterData: { path: '$.lifecycleOperationId', equals: operationId }
      },
      select: { afterData: true }
    });
  }
}
