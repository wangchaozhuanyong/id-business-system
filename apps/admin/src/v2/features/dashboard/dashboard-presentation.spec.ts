import { describe, expect, it } from 'vitest';
import {
  auditActionLabel,
  dashboardOrderStatusMeta,
  financeHistoryLabel,
  formatDashboardDate,
  formatDashboardMoney,
  formatDashboardTime
} from './dashboard-presentation';

describe('dashboard presentation', () => {
  it('keeps missing and invalid values explicit', () => {
    expect(formatDashboardDate()).toBe('—');
    expect(formatDashboardMoney(null)).toBe('—');
    expect(formatDashboardMoney('not-money')).toBe('—');
    expect(formatDashboardTime()).toBe('—');
    expect(formatDashboardTime('2026-08-02T07:52:00+08:00')).toBe('07:52');
  });

  it('maps controlled order and finance states', () => {
    expect(dashboardOrderStatusMeta('completed')).toMatchObject({
      label: '已完成',
      type: 'success'
    });
    expect(dashboardOrderStatusMeta('failed')).toMatchObject({ label: '失败', type: 'danger' });
    expect(dashboardOrderStatusMeta('refunded')).toMatchObject({
      label: '已退款',
      type: 'warning'
    });
    expect(dashboardOrderStatusMeta('cancelled')).toMatchObject({
      label: '已取消',
      type: 'info'
    });
    expect(financeHistoryLabel('incomplete')).toBe('历史数据待确认');
  });

  it('maps known audit actions to customer-facing Chinese labels', () => {
    expect(auditActionLabel('order_update')).toBe('更新订单');
    expect(auditActionLabel('id_business_v2.renewal.manual.complete')).toBe('确认续费');
    expect(auditActionLabel('id_business_v2.account.update')).toBe('更新 ID');
    expect(auditActionLabel('')).toBe('其他操作');
    expect(auditActionLabel('id_business_v2.unknown.action')).toBe('其他操作');
  });
});
