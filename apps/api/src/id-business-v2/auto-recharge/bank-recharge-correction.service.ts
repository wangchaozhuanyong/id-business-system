import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2FinancePostingService } from '../finance/public-api';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  assertV2ExpectedUpdatedAt,
  normalizeV2ExpectedUpdatedAt
} from '../runtime/public-api';
import { bankRechargeOrderAuditSnapshot } from './bank-recharge-order-audit';
import { BankRechargeFinanceService } from './bank-recharge-finance.service';
import { BankRechargeOrderService } from './bank-recharge-order.service';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';
import { bankRechargeId, bankRechargeObject, bankRechargeText } from './bank-recharge-validation';

@Injectable()
export class BankRechargeCorrectionService {
  constructor(
    private readonly repository: BankRechargeRepository,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly posting: IdBusinessV2FinancePostingService,
    private readonly orders: BankRechargeOrderService,
    private readonly finance: BankRechargeFinanceService
  ) {}

  async correct(id: string, value: unknown, operator: AuthenticatedUser) {
    bankRechargeId(id, '银充订单');
    const { reason: reasonValue, ...input } = bankRechargeObject(value);
    const reason = bankRechargeText(reasonValue, '更正原因', 300);
    const expected = normalizeV2ExpectedUpdatedAt(input.expectedUpdatedAt, '银充订单');
    return this.transactions.execute(
      async (tx) => {
        const previous = await this.repository.findOrder(tx, id);
        if (!previous) throw new NotFoundException('银充订单不存在');
        assertV2ExpectedUpdatedAt(previous.updatedAt, expected, '银充订单');
        if (previous.status !== 'completed' || previous.financeStatus !== 'posted') {
          throw new ConflictException('仅未发生退款的已完成银充订单可以更正');
        }
        if ((await this.repository.listRefundJournals(tx, id)).length) {
          throw new ConflictException('已有退款或回款记录，请先核对售后账务，不能直接更正');
        }
        const original = await this.repository.findCompletionJournal(tx, id);
        if (!original) throw new ConflictException('找不到有效的银充完成日记');
        await this.posting.reverse(
          tx,
          original.id,
          reason,
          `bank_recharge_correction:${id}:${expected.toISOString()}`,
          operator
        );
        const pending = await this.repository.updateOrder(tx, {
          where: { id },
          data: {
            status: 'pending_details',
            financeStatus: 'unposted',
            updatedByUserId: operator.id
          }
        });
        const updated = await this.orders.updateInTransaction(
          tx,
          id,
          { ...input, expectedUpdatedAt: pending.updatedAt.toISOString() },
          operator
        );
        const completed = await this.finance.completeInTransaction(
          tx,
          id,
          { expectedUpdatedAt: updated.updatedAt.toISOString() },
          operator,
          `bank_recharge_completed:${id}:correction:${expected.toISOString()}`
        );
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.bank_recharge.order.correct',
          objectType: 'bank_recharge_order',
          objectId: id,
          beforeData: bankRechargeOrderAuditSnapshot(previous),
          afterData: {
            ...bankRechargeOrderAuditSnapshot(completed),
            reason,
            originalJournalId: original.id,
            replacementJournalId: (await this.repository.findCompletionJournal(tx, id))?.id ?? null
          },
          remark: '银充订单更正：同一事务冲销原日记、更新资料并重新入账'
        });
        return completed;
      },
      {
        changedScopes: [
          'auto-recharge',
          'renewals',
          'renewal-warning-summary',
          'dashboard',
          'finance-ledger',
          'finance-accounts',
          'finance-reports'
        ],
        requestId: randomUUID(),
        operator,
        retryMode: 'none'
      }
    );
  }
}
