import { ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  type V2CommandTransaction
} from '../runtime/public-api';
import { normalizeFinanceMonth, normalizeFinanceText } from './id-business-v2-finance-input';
import { IdBusinessV2FinanceCommandRepository } from './persistence/id-business-v2-finance-command.repository';
import { IdBusinessV2FinanceQueryRepository } from './persistence/id-business-v2-finance-query.repository';

@Injectable()
export class IdBusinessV2FinancePeriodsService {
  constructor(
    private readonly commandTransactions: V2CommandTransactionManager,
    private readonly commandRepository: IdBusinessV2FinanceCommandRepository,
    private readonly queryRepository: IdBusinessV2FinanceQueryRepository,
    private readonly audit: V2TransactionalAuditService
  ) {}

  list() {
    return this.queryRepository.listPeriods();
  }

  async close(monthValue: string, operator?: AuthenticatedUser) {
    const month = normalizeFinanceMonth(monthValue);
    return this.commandTransactions.execute(
      async (tx) => {
        const existing = await this.commandRepository.findPeriod(tx, month);
        if (existing?.status === 'closed') return existing;
        const now = new Date();
        const period = await this.commandRepository.closePeriod(tx, month, now, operator?.id);
        await this.writeAudit(tx, operator, 'close', month, null);
        return period;
      },
      { requestId: randomUUID(), operator }
    );
  }

  async reopen(monthValue: string, reasonValue: string, operator?: AuthenticatedUser) {
    const month = normalizeFinanceMonth(monthValue);
    const reason = normalizeFinanceText(reasonValue, '重新打开原因', 500, true)!;
    return this.commandTransactions.execute(
      async (tx) => {
        const existing = await this.commandRepository.findPeriod(tx, month);
        if (!existing || existing.status !== 'closed') {
          throw new ConflictException('只有已关账月份可以重新打开');
        }
        const period = await this.commandRepository.reopenPeriod(
          tx,
          month,
          reason,
          new Date(),
          operator?.id
        );
        await this.writeAudit(tx, operator, 'reopen', month, reason);
        return period;
      },
      { requestId: randomUUID(), operator }
    );
  }

  private writeAudit(
    tx: V2CommandTransaction,
    operator: AuthenticatedUser | undefined,
    action: string,
    month: string,
    reason: string | null
  ) {
    return this.audit.append(tx, {
      userId: operator?.id,
      module: 'id_business_v2_finance',
      action: `id_business_v2.finance_period.${action}`,
      objectType: 'id_business_v2_finance_period',
      afterData: { month, reason },
      remark: action === 'close' ? `财务关账：${month}` : `重新打开财务月份：${month}`
    });
  }
}
