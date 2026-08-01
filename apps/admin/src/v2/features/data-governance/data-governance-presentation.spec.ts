import { describe, expect, it } from 'vitest';
import {
  formatGovernanceDate,
  getGovernanceItemStatusMeta,
  getGovernanceJobStatusMeta,
  governanceJobTypeLabel,
  recycleEntityLabel,
  shortHash
} from './data-governance-presentation';

describe('data governance presentation', () => {
  it('maps controlled workflow values and keeps unknown values explicit', () => {
    expect(recycleEntityLabel('account')).toBe('ID 资料');
    expect(governanceJobTypeLabel('exchange_rate_cleanup')).toBe('汇率历史清理');
    expect(getGovernanceJobStatusMeta('approved')).toEqual({
      label: '待执行',
      type: 'primary'
    });
    expect(getGovernanceItemStatusMeta('failed')).toEqual({
      label: '失败',
      type: 'danger'
    });
    expect(recycleEntityLabel('unsupported')).toBe('未知类型');
    expect(getGovernanceJobStatusMeta('unsupported')).toEqual({
      label: '未知状态',
      type: 'info'
    });
  });

  it('formats missing evidence without inventing values', () => {
    expect(formatGovernanceDate(undefined)).toBe('—');
    expect(formatGovernanceDate('not-a-date')).toBe('—');
    expect(shortHash('')).toBe('—');
    expect(shortHash('0123456789abcdefghijklmnop')).toBe('0123456789…klmnop');
  });
});
