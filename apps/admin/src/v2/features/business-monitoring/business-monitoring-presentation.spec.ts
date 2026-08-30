import { describe, expect, it } from 'vitest';
import {
  businessMonitoringCategoryBreakdown,
  businessMonitoringCategoryLabel,
  businessMonitoringRuleLabel,
  businessMonitoringSeverityMeta,
  formatBusinessMonitoringDate
} from './business-monitoring-presentation';

describe('business monitoring presentation', () => {
  it('maps controlled severity and category values', () => {
    expect(businessMonitoringSeverityMeta('critical')).toEqual({
      label: '紧急',
      type: 'danger'
    });
    expect(businessMonitoringSeverityMeta('info')).toEqual({ label: '提示', type: 'info' });
    expect(businessMonitoringCategoryLabel('exchange_rate')).toBe('汇率采集');
  });

  it('keeps missing and invalid dates explicit', () => {
    expect(formatBusinessMonitoringDate()).toBe('—');
    expect(formatBusinessMonitoringDate('invalid')).toBe('—');
    expect(formatBusinessMonitoringDate('2026-07-31T16:00:00.000Z')).not.toBe('—');
  });

  it('uses the configured Chinese rule title without exposing an unknown internal key', () => {
    const rules = [
      {
        key: 'negative-balance',
        category: 'balance' as const,
        severity: 'critical' as const,
        title: '负数余额检查',
        description: '检查余额是否小于零'
      }
    ];

    expect(businessMonitoringRuleLabel('negative-balance', rules)).toBe('负数余额检查');
    expect(businessMonitoringRuleLabel('internal-rule-key', rules)).toBe('未配置的监控规则');
  });

  it('builds a stable, truthful category distribution', () => {
    const breakdown = businessMonitoringCategoryBreakdown({
      total: 10,
      critical: 2,
      warning: 3,
      info: 5,
      byCategory: {
        order: 4,
        balance: 3,
        renewal: 2,
        exchange_rate: 1,
        finance: 0
      }
    });

    expect(breakdown.map((item) => item.category)).toEqual([
      'order',
      'balance',
      'renewal',
      'exchange_rate',
      'finance'
    ]);
    expect(breakdown[0]).toMatchObject({ label: '订单', count: 4, share: 40 });
    expect(breakdown[4]).toMatchObject({ count: 0, share: 0 });
  });
});
