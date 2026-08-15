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

  it('normalizes audit action labels without inventing translations', () => {
    expect(auditActionLabel('order_update')).toBe('order update');
    expect(auditActionLabel('')).toBe('未知操作');
  });
});
