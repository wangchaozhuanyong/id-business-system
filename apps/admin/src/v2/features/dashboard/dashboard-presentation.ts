import type { V2DashboardOrderStatus } from './contracts';

export function formatDashboardDate(value?: string | null, dateOnly = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit', hour12: false })
  }).format(date);
}

export function formatDashboardMoney(value?: string | null) {
  if (value === null || value === undefined || value === '') return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}

export function dashboardOrderStatusMeta(status: V2DashboardOrderStatus) {
  const labels: Record<V2DashboardOrderStatus, string> = {
    draft: '草稿',
    pending: '待处理',
    waiting_external: '等待外部',
    processing: '处理中',
    completed: '已完成',
    refunded: '已退款',
    cancelled: '已取消',
    failed: '失败'
  };
  if (status === 'completed') return { label: labels[status], type: 'success' as const };
  if (status === 'failed') return { label: labels[status], type: 'danger' as const };
  if (status === 'cancelled' || status === 'refunded') {
    return { label: labels[status], type: 'info' as const };
  }
  return { label: labels[status], type: 'warning' as const };
}

export function financeHistoryLabel(
  status: 'not_started' | 'in_progress' | 'incomplete' | 'completed' | null
) {
  if (status === 'completed') return '历史数据已确认';
  if (status === 'in_progress') return '历史数据回填中';
  if (status === 'incomplete') return '历史数据待确认';
  if (status === 'not_started') return '历史数据未回填';
  return '无财务查看权限';
}

export function auditActionLabel(action: string) {
  const normalized = action.trim().replaceAll('_', ' ');
  return normalized || '未知操作';
}
