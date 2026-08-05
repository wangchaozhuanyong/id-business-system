import type {
  V2GovernanceItemStatus,
  V2GovernanceJob,
  V2GovernanceJobStatus,
  V2GovernanceJobType,
  V2GovernanceOverview,
  V2GovernanceRecycleEntity
} from './contracts';

export const recycleEntityLabels: Record<V2GovernanceRecycleEntity, string> = {
  account: 'ID 资料',
  customer: '客户',
  option: '业务选项',
  order: '订单'
};

export const governanceJobTypeLabels: Record<V2GovernanceJobType, string> = {
  recycle_restore: '回收站恢复',
  exchange_rate_cleanup: '汇率历史清理'
};

export const governanceJobStatusMeta: Record<
  V2GovernanceJobStatus,
  { label: string; type: 'info' | 'primary' | 'warning' | 'success' | 'danger' }
> = {
  pending_approval: { label: '待审批', type: 'warning' },
  approved: { label: '待执行', type: 'primary' },
  running: { label: '执行中', type: 'primary' },
  succeeded: { label: '已完成', type: 'success' },
  partially_succeeded: { label: '部分完成', type: 'warning' },
  failed: { label: '执行失败', type: 'danger' },
  rejected: { label: '已驳回', type: 'danger' },
  cancelled: { label: '已取消', type: 'info' }
};

export const governanceItemStatusMeta: Record<
  V2GovernanceItemStatus,
  { label: string; type: 'info' | 'primary' | 'warning' | 'success' | 'danger' }
> = {
  pending: { label: '待执行', type: 'info' },
  processing: { label: '执行中', type: 'primary' },
  succeeded: { label: '成功', type: 'success' },
  skipped: { label: '已跳过', type: 'warning' },
  failed: { label: '失败', type: 'danger' }
};

export function recycleEntityLabel(value: unknown) {
  return typeof value === 'string' && value in recycleEntityLabels
    ? recycleEntityLabels[value as V2GovernanceRecycleEntity]
    : '未知类型';
}

export function governanceJobTypeLabel(value: unknown) {
  return typeof value === 'string' && value in governanceJobTypeLabels
    ? governanceJobTypeLabels[value as V2GovernanceJobType]
    : '未知任务';
}

export function getGovernanceJobStatusMeta(value: unknown) {
  return typeof value === 'string' && value in governanceJobStatusMeta
    ? governanceJobStatusMeta[value as V2GovernanceJobStatus]
    : { label: '未知状态', type: 'info' as const };
}

export function getGovernanceItemStatusMeta(value: unknown) {
  return typeof value === 'string' && value in governanceItemStatusMeta
    ? governanceItemStatusMeta[value as V2GovernanceItemStatus]
    : { label: '未知状态', type: 'info' as const };
}

export function canCancelGovernanceJob(
  job: Pick<V2GovernanceJob, 'status' | 'requestedByUserId'>,
  currentUserId: string | null | undefined
) {
  return (
    Boolean(currentUserId) &&
    job.status === 'pending_approval' &&
    job.requestedByUserId === currentUserId
  );
}

export function formatGovernanceDate(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

export function shortHash(value: string) {
  return value ? `${value.slice(0, 10)}…${value.slice(-6)}` : '—';
}

export function governancePreviewBlockedReason(
  overview: Pick<V2GovernanceOverview, 'approvalReadiness'> | null | undefined,
  state: { loading: boolean; error: string }
) {
  if (overview) return overview.approvalReadiness.blockedReason ?? '';
  if (state.loading) return '正在核验异人审批条件，请稍候';
  if (state.error) return '无法确认异人审批条件，请先刷新治理概况';
  return '异人审批条件尚未就绪，请先刷新治理概况';
}
