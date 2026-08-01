import type { V2SystemMonitorStatus } from './contracts';

export function systemMonitorStatusMeta(status: V2SystemMonitorStatus) {
  if (status === 'healthy') return { label: '正常', type: 'success' as const };
  if (status === 'degraded') return { label: '异常', type: 'danger' as const };
  return { label: '未知', type: 'info' as const };
}

export function systemOverallStatusMeta(status: 'healthy' | 'degraded' | 'partial') {
  if (status === 'healthy') return { label: '已检查项正常', type: 'success' as const };
  if (status === 'degraded') return { label: '存在异常', type: 'danger' as const };
  return { label: '部分可观测', type: 'warning' as const };
}

export function formatSystemMonitoringDate(value?: string | null) {
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
    second: '2-digit',
    hour12: false
  }).format(date);
}

export function exchangeRunStatusLabel(status?: 'running' | 'success' | 'failed') {
  if (status === 'running') return '运行中';
  if (status === 'success') return '成功';
  if (status === 'failed') return '失败';
  return '无运行记录';
}
