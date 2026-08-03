import { describe, expect, it } from 'vitest';
import {
  exchangeRunStatusLabel,
  formatSystemMonitoringDate,
  formatSystemMonitoringDetail,
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
});
