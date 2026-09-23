import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  ID_BUSINESS_V2_RENEWAL_WARNING_DEFAULT_DAYS,
  ID_BUSINESS_V2_RENEWAL_WARNING_SCOPE
} from '../../renewals/public-api';
import { bankRechargeText } from '../bank-recharge-validation';

@Injectable()
export class BankRechargeQueryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async renewalWarnings(now = new Date()) {
    const setting = await this.prisma.idBusinessV2RenewalWarningSetting.findUnique({
      where: { scope: ID_BUSINESS_V2_RENEWAL_WARNING_SCOPE }
    });
    const warningDays =
      setting && setting.warningDays >= 1 && setting.warningDays <= 365
        ? setting.warningDays
        : ID_BUSINESS_V2_RENEWAL_WARNING_DEFAULT_DAYS;
    const boundary = new Date(now.getTime() + warningDays * 24 * 60 * 60 * 1000);
    const where: Prisma.IdBusinessV2BankRechargeSubscriptionWhereInput = {
      status: 'active',
      dueAt: { not: null, lte: boundary }
    };
    const [upcomingCount, expiredCount, subscriptions, nextDue, nextEntering] = await Promise.all([
      this.prisma.idBusinessV2BankRechargeSubscription.count({
        where: { ...where, dueAt: { gt: now, lte: boundary } }
      }),
      this.prisma.idBusinessV2BankRechargeSubscription.count({
        where: { ...where, dueAt: { lte: now } }
      }),
      this.prisma.idBusinessV2BankRechargeSubscription.findMany({
        where,
        include: {
          account: { select: { emailMasked: true } },
          customer: { select: { name: true } },
          currentOrder: { select: { id: true, orderNo: true } }
        },
        orderBy: { dueAt: 'asc' },
        take: 100
      }),
      this.prisma.idBusinessV2BankRechargeSubscription.findFirst({
        where: { status: 'active', dueAt: { gt: now, lte: boundary } },
        select: { dueAt: true },
        orderBy: { dueAt: 'asc' }
      }),
      this.prisma.idBusinessV2BankRechargeSubscription.findFirst({
        where: { status: 'active', dueAt: { gt: boundary } },
        select: { dueAt: true },
        orderBy: { dueAt: 'asc' }
      })
    ]);
    const nextBoundary = Math.min(
      now.getTime() + 60 * 60 * 1000,
      nextDue?.dueAt?.getTime() ?? Infinity,
      nextEntering?.dueAt
        ? nextEntering.dueAt.getTime() - warningDays * 24 * 60 * 60 * 1000
        : Infinity
    );
    return {
      warningDays,
      upcomingCount,
      expiredCount,
      totalCount: upcomingCount + expiredCount,
      items: subscriptions.map((item) => ({
        id: item.id,
        orderId: item.currentOrder.id,
        orderNo: item.currentOrder.orderNo,
        customerName: item.customer?.name ?? '待关联客户',
        accountMasked: item.account.emailMasked,
        plan: item.plan,
        dueAt: item.dueAt,
        warningState: item.dueAt && item.dueAt <= now ? 'expired' : 'upcoming'
      })),
      evaluatedAt: now,
      revalidateAt: new Date(nextBoundary)
    };
  }

  async list(value: unknown) {
    const query =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const page = this.pageNumber(query.page, 1, 100000);
    const pageSize = this.pageNumber(query.pageSize, 20, 100);
    const keyword = bankRechargeText(query.keyword, '搜索词', 160, false);
    const status = bankRechargeText(query.status, '订单状态', 40, false);
    if (
      status &&
      ![
        'pending_details',
        'pending_finance',
        'pending_receipt',
        'completed',
        'refunded',
        'cancelled'
      ].includes(status)
    ) {
      throw new BadRequestException('订单状态无效');
    }
    const where: Prisma.IdBusinessV2BankRechargeOrderWhereInput = {
      ...(status
        ? { status: status as Prisma.EnumIdBusinessV2BankRechargeOrderStatusFilter['equals'] }
        : {}),
      ...(keyword
        ? {
            OR: [
              { orderNo: { contains: keyword } },
              { customer: { is: { name: { contains: keyword } } } },
              { account: { is: { emailMasked: { contains: keyword } } } },
              { cardLast4: { contains: keyword } }
            ]
          }
        : {})
    };
    const [items, total] = await Promise.all([
      this.prisma.idBusinessV2BankRechargeOrder.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true } },
          account: { select: { id: true, emailMasked: true } },
          card: { select: { id: true, label: true, last4: true } },
          activeSubscription: { select: { status: true } }
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      this.prisma.idBusinessV2BankRechargeOrder.count({ where })
    ]);
    return { items, total, page, pageSize };
  }

  async options() {
    const [customers, financeAccounts] = await Promise.all([
      this.prisma.idBusinessV2Customer.findMany({
        where: { deletedAt: null, recordStatus: 'active' },
        select: { id: true, name: true },
        orderBy: { updatedAt: 'desc' },
        take: 1000
      }),
      this.prisma.idBusinessV2FinanceAccount.findMany({
        where: { status: 'active' },
        select: { id: true, name: true, currency: true, accountType: true },
        orderBy: { name: 'asc' }
      })
    ]);
    return { customers, financeAccounts };
  }

  private pageNumber(value: unknown, fallback: number, max: number) {
    if (value === undefined || value === null || value === '') return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > max) {
      throw new BadRequestException('分页参数无效');
    }
    return number;
  }
}
