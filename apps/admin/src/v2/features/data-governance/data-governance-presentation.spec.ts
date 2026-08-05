import { describe, expect, it } from 'vitest';
import {
  canCancelGovernanceJob,
  formatGovernanceDate,
  getGovernanceItemStatusMeta,
  getGovernanceJobStatusMeta,
  governancePreviewBlockedReason,
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

  it('keeps governance preview creation blocked until an independent approver is ready', () => {
    const blockedReason = '当前没有其他启用管理员可完成异人审批';
    expect(
      governancePreviewBlockedReason(
        {
          approvalReadiness: {
            activeAdminCount: 1,
            eligibleApproverCount: 0,
            ready: false,
            blockedReason
          }
        },
        { loading: false, error: '' }
      )
    ).toBe(blockedReason);
    expect(
      governancePreviewBlockedReason(
        {
          approvalReadiness: {
            activeAdminCount: 2,
            eligibleApproverCount: 1,
            ready: true,
            blockedReason: null
          }
        },
        { loading: false, error: '' }
      )
    ).toBe('');
    expect(governancePreviewBlockedReason(null, { loading: true, error: '' })).toContain('核验');
    expect(governancePreviewBlockedReason(null, { loading: false, error: '503' })).toContain(
      '无法确认'
    );
  });

  it('only exposes cancellation to the requester while approval is pending', () => {
    const job = { status: 'pending_approval' as const, requestedByUserId: 'requester-id' };

    expect(canCancelGovernanceJob(job, 'requester-id')).toBe(true);
    expect(canCancelGovernanceJob(job, 'other-admin-id')).toBe(false);
    expect(canCancelGovernanceJob({ ...job, status: 'approved' }, 'requester-id')).toBe(false);
    expect(canCancelGovernanceJob(job, undefined)).toBe(false);
  });
});
