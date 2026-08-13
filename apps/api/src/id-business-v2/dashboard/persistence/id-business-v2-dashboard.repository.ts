import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { mapAmount4, mapOptionalAmount4 } from '../../runtime/public-api';
import type { DashboardAccess } from '../dashboard.types';

const ACTIVE_ORDER_STATUSES = ['draft', 'pending', 'waiting_external', 'processing'] as const;

@Injectable()
export class IdBusinessV2DashboardRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getRenewalWarningDays() {
    const settings = await this.prisma.idBusinessV2RenewalWarningSetting.findUnique({
      where: { scope: 'global' },
      select: { warningDays: true }
    });
    return Math.min(365, Math.max(1, settings?.warningDays ?? 3));
  }

  async loadBusiness(
    access: DashboardAccess,
    window: { start: Date; end: Date; businessDate: string }
  ) {
    const orderWhere = { deletedAt: null, createdAt: { gte: window.start, lt: window.end } };
    const completedWhere = {
      deletedAt: null,
      status: 'completed' as const,
      statusChangedAt: { gte: window.start, lt: window.end }
    };
    const [todayOrders, completedAggregate, todayActivations, topupAggregate] = await Promise.all([
      access.orders ? this.prisma.idBusinessV2Order.count({ where: orderWhere }) : null,
      access.orders || access.finance
        ? this.prisma.idBusinessV2Order.aggregate({
            where: completedWhere,
            _count: { _all: true },
            _sum: { receivedAmount: true, profitAmount: true }
          })
        : null,
      access.activations
        ? this.prisma.idBusinessV2Activation.count({
            where: { createdAt: { gte: window.start, lt: window.end } }
          })
        : null,
      access.balances
        ? this.prisma.idBusinessV2GiftCard.aggregate({
            where: { creditedAt: { gte: window.start, lt: window.end } },
            _count: { _all: true },
            _sum: { costAmount: true }
          })
        : null
    ]);

    return {
      todayOrders,
      completedCount: completedAggregate?._count._all ?? null,
      completedReceivedAmount: mapOptionalAmount4(
        completedAggregate?._sum.receivedAmount,
        'id_business_v2_orders.received_amount.sum'
      ),
      completedProfitAmount: mapOptionalAmount4(
        completedAggregate?._sum.profitAmount,
        'id_business_v2_orders.profit_amount.sum'
      ),
      todayActivations,
      topupCount: topupAggregate?._count._all ?? null,
      topupCostAmount: mapOptionalAmount4(
        topupAggregate?._sum.costAmount,
        'id_business_v2_gift_cards.cost_amount.sum'
      )
    };
  }

  async loadRisks(
    access: DashboardAccess,
    window: { start: Date; end: Date },
    renewalWarningEnd: Date
  ) {
    const availableAccountWhere = {
      deletedAt: null,
      recordStatus: 'active' as const,
      lossReportedAt: null
    };
    const [
      pendingOrders,
      failedOrders,
      overdueRenewals,
      dueSoonRenewals,
      lowBalanceAccounts,
      failedExchangeRuns
    ] = await Promise.all([
      access.orders
        ? this.prisma.idBusinessV2Order.count({
            where: { deletedAt: null, status: { in: [...ACTIVE_ORDER_STATUSES] } }
          })
        : null,
      access.orders
        ? this.prisma.idBusinessV2Order.count({ where: { deletedAt: null, status: 'failed' } })
        : null,
      access.renewals
        ? this.prisma.idBusinessV2Activation.count({
            where: { status: 'active', dueAt: { lt: window.start } }
          })
        : null,
      access.renewals
        ? this.prisma.idBusinessV2Activation.count({
            where: {
              status: 'active',
              dueAt: { gte: window.start, lt: renewalWarningEnd }
            }
          })
        : null,
      access.accounts && access.balances
        ? this.prisma.idBusinessV2Account.count({
            where: { ...availableAccountWhere, currentBalance: { lte: 0 } }
          })
        : null,
      access.exchangeRates
        ? this.prisma.idBusinessV2ExchangeRateRun.count({
            where: {
              status: 'failed',
              startedAt: {
                gte: new Date(window.end.getTime() - 24 * 60 * 60 * 1000),
                lt: window.end
              }
            }
          })
        : null
    ]);

    return {
      pendingOrders,
      failedOrders,
      overdueRenewals,
      dueSoonRenewals,
      lowBalanceAccounts,
      failedExchangeRuns
    };
  }

  async loadAssets(access: DashboardAccess) {
    if (!access.accounts) return null;
    const availableWhere = {
      deletedAt: null,
      recordStatus: 'active' as const,
      soldByOrderId: null,
      lossReportedAt: null
    };
    const [totalAccounts, availableAccounts, balanceInventory, idInventory, financeSettings] =
      await Promise.all([
        this.prisma.idBusinessV2Account.count({ where: { deletedAt: null } }),
        this.prisma.idBusinessV2Account.count({ where: availableWhere }),
        access.finance
          ? this.prisma.idBusinessV2Account.aggregate({
              where: { deletedAt: null, lossReportedAt: null, ownershipTransferredAt: null },
              _sum: { balanceCostAmount: true }
            })
          : null,
        access.finance
          ? this.prisma.idBusinessV2Account.aggregate({
              where: { deletedAt: null, lossReportedAt: null, ownershipTransferredAt: null },
              _sum: { purchaseCost: true }
            })
          : null,
        access.finance
          ? this.prisma.idBusinessV2FinanceSettings.findUnique({
              where: { id: 1 },
              select: { historyStatus: true }
            })
          : null
      ]);
    return {
      totalAccounts,
      availableAccounts,
      balanceCostAmount: mapOptionalAmount4(
        balanceInventory?._sum.balanceCostAmount,
        'id_business_v2_accounts.balance_cost_amount.sum'
      ),
      purchaseCost: mapOptionalAmount4(
        idInventory?._sum.purchaseCost,
        'id_business_v2_accounts.purchase_cost.sum'
      ),
      financeHistoryStatus: financeSettings?.historyStatus ?? null
    };
  }

  async loadRecentOrders() {
    const items = await this.prisma.idBusinessV2Order.findMany({
      where: { deletedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 5,
      select: {
        id: true,
        orderNo: true,
        status: true,
        receivedAmount: true,
        profitAmount: true,
        createdAt: true,
        customer: { select: { name: true } },
        serviceOption: { select: { name: true } }
      }
    });
    return items.map((item) => ({
      ...item,
      receivedAmount: mapAmount4(item.receivedAmount, 'id_business_v2_orders.received_amount'),
      profitAmount: mapOptionalAmount4(item.profitAmount, 'id_business_v2_orders.profit_amount')
    }));
  }

  loadUpcomingRenewals(renewalWarningEnd: Date) {
    return this.prisma.idBusinessV2Activation.findMany({
      where: { status: 'active', dueAt: { lt: renewalWarningEnd } },
      orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      take: 5,
      select: {
        id: true,
        status: true,
        dueAt: true,
        customer: { select: { name: true } },
        serviceOption: { select: { name: true } },
        account: { select: { appleIdMasked: true } }
      }
    });
  }

  loadRecentAudits() {
    return this.prisma.auditLog.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 5,
      select: {
        id: true,
        module: true,
        action: true,
        objectType: true,
        createdAt: true,
        user: { select: { username: true, displayName: true } }
      }
    });
  }
}
