import { describe, expect, it } from 'vitest';
import {
  businessMonitoringCategoryLabel,
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
});
