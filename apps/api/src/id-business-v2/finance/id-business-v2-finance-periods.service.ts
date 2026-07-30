import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { normalizeFinanceMonth, normalizeFinanceText } from './id-business-v2-finance-input';

@Injectable()
export class IdBusinessV2FinancePeriodsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.idBusinessV2FinancePeriod.findMany({
      orderBy: { month: 'desc' },
      take: 120
    });
  }

  async close(monthValue: string, operator?: AuthenticatedUser) {
    const month = normalizeFinanceMonth(monthValue);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.idBusinessV2FinancePeriod.findUnique({ where: { month } });
      if (existing?.status === 'closed') return existing;
      const now = new Date();
      const period = await tx.idBusinessV2FinancePeriod.upsert({
        where: { month },
        update: {
          status: 'closed',
          closedAt: now,
          closedByUserId: operator?.id,
          reopenReason: null,
          reopenedAt: null,
          reopenedByUserId: null
        },
        create: {
          month,
          status: 'closed',
          closedAt: now,
          closedByUserId: operator?.id
        }
      });
      await this.writeAudit(tx, operator, 'close', month, null);
      return period;
    });
  }

  async reopen(monthValue: string, reasonValue: string, operator?: AuthenticatedUser) {
    const month = normalizeFinanceMonth(monthValue);
    const reason = normalizeFinanceText(reasonValue, '重新打开原因', 500, true)!;
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.idBusinessV2FinancePeriod.findUnique({ where: { month } });
      if (!existing || existing.status !== 'closed') {
        throw new ConflictException('只有已关账月份可以重新打开');
      }
      const period = await tx.idBusinessV2FinancePeriod.update({
        where: { month },
        data: {
          status: 'reopened',
          reopenReason: reason,
          reopenedAt: new Date(),
          reopenedByUserId: operator?.id
        }
      });
      await this.writeAudit(tx, operator, 'reopen', month, reason);
      return period;
    });
  }

  private writeAudit(
    tx: Prisma.TransactionClient,
    operator: AuthenticatedUser | undefined,
    action: string,
    month: string,
    reason: string | null
  ) {
    return tx.auditLog.create({
      data: {
        userId: operator?.id,
        module: 'id_business_v2_finance',
        action: `id_business_v2.finance_period.${action}`,
        objectType: 'id_business_v2_finance_period',
        objectId: null,
        afterData: { month, reason },
        remark: action === 'close' ? `财务关账：${month}` : `重新打开财务月份：${month}`
      }
    });
  }
}
