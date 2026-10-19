import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { RechargeRepository } from './persistence/recharge.repository';
import { BankRechargeOrderService } from './bank-recharge-order.service';
import { BankRechargeCardService } from './bank-recharge-card.service';
import { settleRechargeManually } from './recharge-manual-settlement';

@Injectable()
export class RechargeManualSettlementService {
  constructor(
    private readonly repository: RechargeRepository,
    private readonly orders: BankRechargeOrderService,
    private readonly cards: BankRechargeCardService,
    private readonly audit: V2TransactionalAuditService,
    private readonly transactions: V2CommandTransactionManager
  ) {}
  settle(id: string, value: unknown, operator: AuthenticatedUser) {
    return this.transactions.execute(
      (tx) =>
        settleRechargeManually({
          tx,
          repository: this.repository,
          orders: this.orders,
          cards: this.cards,
          audit: this.audit,
          id,
          value,
          operator
        }),
      {
        changedScopes: [
          'auto-recharge',
          'online-recharge',
          'renewals',
          'renewal-warning-summary',
          'dashboard'
        ],
        requestId: randomUUID(),
        operator,
        retryMode: 'none'
      }
    );
  }
}
