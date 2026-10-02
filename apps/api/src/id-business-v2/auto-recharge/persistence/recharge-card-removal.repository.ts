import { Injectable } from '@nestjs/common';
import { acquireMysqlTransactionLock } from '../../../common/prisma/mysql-transaction-lock';
import type { V2CommandTransaction } from '../../runtime/public-api';

@Injectable()
export class RechargeCardRemovalRepository {
  lock(tx: V2CommandTransaction) {
    return acquireMysqlTransactionLock(tx, 'auto-recharge-single-worker');
  }
  account(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2ChatgptAccount.findUnique({ where: { id } });
  }
  openingOrder(tx: V2CommandTransaction, accountId: string) {
    return tx.idBusinessV2BankRechargeOrder.findFirst({
      where: {
        accountId,
        OR: [{ verifiedAt: { not: null } }, { status: { in: ['completed', 'refunded'] } }]
      },
      include: { card: true },
      orderBy: [{ openedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]
    });
  }
  accounts(tx: V2CommandTransaction, cardId: string) {
    return tx.idBusinessV2BankRechargeOrder.findMany({
      where: { cardId, accountId: { not: null } },
      select: { accountId: true },
      distinct: ['accountId']
    });
  }
  activeJob(tx: V2CommandTransaction, cardId: string) {
    return tx.idBusinessV2RechargeJob.findFirst({
      where: { cardId, state: { not: 'finished' } },
      select: { id: true }
    });
  }
  orders(tx: V2CommandTransaction, cardId: string) {
    return tx.idBusinessV2BankRechargeOrder.count({ where: { cardId } });
  }
  async remove(
    tx: V2CommandTransaction,
    card: { id: string; label: string; last4: string },
    summaryEncrypted: string | null
  ) {
    await tx.idBusinessV2BankRechargeOrder.updateMany({
      where: { cardId: card.id },
      data: {
        cardLabelSnapshot: card.label,
        cardLast4: card.last4,
        cardDeletedAt: new Date(),
        ...(summaryEncrypted ? { cardNumberSummaryEncrypted: summaryEncrypted } : {})
      }
    });
    await tx.idBusinessV2BankRechargeCard.delete({ where: { id: card.id } });
  }
}
