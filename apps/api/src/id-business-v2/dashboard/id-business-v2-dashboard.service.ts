import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { Amount4 } from '../runtime/public-api';
import type { DashboardAccess } from './dashboard.types';
import { IdBusinessV2DashboardRepository } from './persistence/id-business-v2-dashboard.repository';

const BEIJING_OFFSET = '+08:00';
const DAY_MS = 24 * 60 * 60 * 1000;
export type { DashboardAccess } from './dashboard.types';

@Injectable()
export class IdBusinessV2DashboardService {
  constructor(private readonly repository: IdBusinessV2DashboardRepository) {}

  async overview(user: AuthenticatedUser | undefined, now = new Date()) {
    if (!user) throw new UnauthorizedException('Authentication required');
    const access = this.resolveAccess(user);
    const window = this.businessDayWindow(now);
    const warningDays = access.renewals ? await this.getRenewalWarningDays() : 3;
    const renewalWarningEnd = new Date(window.start.getTime() + (warningDays + 1) * DAY_MS);

    const [business, risks, assets, recentOrders, upcomingRenewals, recentAudits] =
      await Promise.all([
        this.loadBusiness(access, window),
        this.loadRisks(access, window, renewalWarningEnd),
        this.loadAssets(access),
        this.loadRecentOrders(access),
        this.loadUpcomingRenewals(access, renewalWarningEnd),
        this.loadRecentAudits(access)
      ]);

    return {
      generatedAt: now.toISOString(),
      businessDate: window.businessDate,
      timezone: 'Asia/Shanghai',
      warningDays,
      access,
      business,
      risks,
      assets,
      recentOrders,
      upcomingRenewals,
      recentAudits
    };
  }

  private async loadBusiness(
    access: DashboardAccess,
    window: { start: Date; end: Date; businessDate: string }
  ) {
    const result = await this.repository.loadBusiness(access, window);

    return {
      todayOrders: result.todayOrders,
      todayCompletedOrders: access.orders ? (result.completedCount ?? 0) : null,
      todayActivations: result.todayActivations,
      todayTopups: result.topupCount,
      todayTopupCostCny: this.decimalOrNull(result.topupCostAmount),
      todayRevenueCny: access.finance ? this.decimalOrNull(result.completedReceivedAmount) : null,
      todayProfitCny: access.finance ? this.decimalOrNull(result.completedProfitAmount) : null
    };
  }

  private async loadRisks(
    access: DashboardAccess,
    window: { start: Date; end: Date },
    renewalWarningEnd: Date
  ) {
    return this.repository.loadRisks(access, window, renewalWarningEnd);
  }

  private async loadAssets(access: DashboardAccess) {
    if (!access.accounts) {
      return {
        totalAccounts: null,
        availableAccounts: null,
        inventoryBookValueCny: null,
        financeHistoryStatus: null
      };
    }
    const result = await this.repository.loadAssets(access);
    const inventoryBookValue = result
      ? (result.balanceCostAmount?.add(result.purchaseCost ?? Amount4.zero()) ?? Amount4.zero())
      : null;

    return {
      totalAccounts: result?.totalAccounts ?? null,
      availableAccounts: result?.availableAccounts ?? null,
      inventoryBookValueCny: this.decimalOrNull(inventoryBookValue),
      financeHistoryStatus: result?.financeHistoryStatus ?? null
    };
  }

  private async loadRecentOrders(access: DashboardAccess) {
    if (!access.orders) return [];
    const items = await this.repository.loadRecentOrders();
    return items.map((item) => ({
      ...item,
      receivedAmount: item.receivedAmount.toString(),
      profitAmount: access.finance ? this.decimalOrNull(item.profitAmount) : null,
      createdAt: item.createdAt.toISOString()
    }));
  }

  private async loadUpcomingRenewals(access: DashboardAccess, renewalWarningEnd: Date) {
    if (!access.renewals) return [];
    const items = await this.repository.loadUpcomingRenewals(renewalWarningEnd);
    return items.map((item) => ({
      ...item,
      dueAt: item.dueAt?.toISOString() ?? null
    }));
  }

  private async loadRecentAudits(access: DashboardAccess) {
    if (!access.audit) return [];
    const items = await this.repository.loadRecentAudits();
    return items.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() }));
  }

  private async getRenewalWarningDays() {
    return this.repository.getRenewalWarningDays();
  }

  private resolveAccess(user: AuthenticatedUser): DashboardAccess {
    const admin = user.roles.includes('admin');
    const permissions = new Set(user.permissions);
    const has = (permission: string) => admin || permissions.has(permission);
    return {
      orders: has('apple.order.view'),
      activations: has('apple.activation.view'),
      renewals: has('apple.renewal_task.view'),
      accounts: has('apple.account.view'),
      balances: has('apple.balance.view'),
      exchangeRates: has('apple.exchange_rate.view'),
      finance: has('data.analytics.view') || has('finance.view'),
      audit: has('audit_log.view')
    };
  }

  private businessDayWindow(now: Date) {
    const businessDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(now);
    const start = new Date(`${businessDate}T00:00:00${BEIJING_OFFSET}`);
    return { businessDate, start, end: new Date(start.getTime() + DAY_MS) };
  }

  private decimalOrNull(value: Amount4 | null | undefined) {
    return value?.toString() ?? null;
  }
}
