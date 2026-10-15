import { acquireMysqlTransactionLock } from '../../../common/prisma/mysql-transaction-lock';
import { Injectable } from '@nestjs/common';
import type { V2CommandTransaction } from '../../runtime/public-api';

@Injectable()
export class BankRechargeOnlineOrderRepository {
  async findExisting(
    tx: V2CommandTransaction,
    taskId: string,
    paymentReference: string | null,
    checkoutIdentifier: string | null
  ) {
    await acquireMysqlTransactionLock(tx, 'bank-recharge-order-evidence');
    return tx.idBusinessV2BankRechargeOrder.findMany({
      where: {
        OR: [
          { onlineRechargeTaskId: taskId },
          ...(paymentReference
            ? [{ paymentEvidenceId: paymentReference }, { manualEvidenceRef: paymentReference }]
            : []),
          ...(checkoutIdentifier ? [{ checkoutIdentifier }] : [])
        ]
      },
      take: 3
    });
  }
  findCard(tx: V2CommandTransaction, id: string) {
    return tx.onlineRechargeCard.findUnique({
      where: { id },
      select: { id: true, last4: true, status: true }
    });
  }
}
