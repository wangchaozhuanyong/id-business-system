import { describe, expect, it } from 'vitest';
import {
  exchangeRunStatusLabel,
  formatSystemMonitoringDate,
  formatSystemMonitoringDetail,
  sortSystemMonitoringChecks,
  summarizeSystemMonitoringChecks,
  systemMonitorStatusMeta,
  systemOverallStatusMeta
} from './system-monitoring-presentation';

describe('system monitoring presentation', () => {
  it('maps health statuses without treating unknown as healthy', () => {
    expect(systemMonitorStatusMeta('healthy')).toEqual({ label: '正常', type: 'success' });
    expect(systemMonitorStatusMeta('unknown')).toEqual({ label: '未知', type: 'info' });
    expect(systemOverallStatusMeta('partial')).toEqual({
      label: '部分可观测',
      type: 'warning'
    });
  });

  it('formats controlled task states and invalid dates explicitly', () => {
    expect(exchangeRunStatusLabel('failed')).toBe('失败');
    expect(exchangeRunStatusLabel()).toBe('无运行记录');
    expect(formatSystemMonitoringDate('invalid')).toBe('—');
  });

  it('formats ISO timestamps embedded in check details with the Malaysia timezone', () => {
    expect(formatSystemMonitoringDetail('下次计划时间：2026-08-02T01:02:03.000Z')).toBe(
      '下次计划时间：2026/08/02 09:02:03'
    );
    expect(formatSystemMonitoringDetail('未提供时间')).toBe('未提供时间');
  });

  it('prioritizes attention states and reports evidence coverage', () => {
    const checks = [
      { key: 'api', title: 'API', status: 'healthy' as const, value: '可用', detail: '通过' },
      {
        key: 'history',
        title: '历史错误率',
        status: 'unknown' as const,
        value: '未知',
        detail: '缺少证据'
      },
      {
        key: 'database',
        title: '数据库',
        status: 'degraded' as const,
        value: '超时',
        detail: '探针失败'
      }
    ];

    expect(sortSystemMonitoringChecks(checks).map((check) => check.status)).toEqual([
      'degraded',
      'unknown',
      'healthy'
    ]);
    expect(summarizeSystemMonitoringChecks(checks)).toEqual({
      healthy: 1,
      degraded: 1,
      unknown: 1,
      total: 3,
      observable: 2,
      coverageRate: 67
    });
  });
});
