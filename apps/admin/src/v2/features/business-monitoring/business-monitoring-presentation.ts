import type { V2BusinessMonitoringCategory, V2BusinessMonitoringSeverity } from './contracts';

export function businessMonitoringSeverityMeta(severity: V2BusinessMonitoringSeverity) {
  const labels: Record<V2BusinessMonitoringSeverity, string> = {
    critical: '紧急',
    warning: '警告',
    info: '提示'
  };
  if (severity === 'critical') return { label: labels[severity], type: 'danger' as const };
  if (severity === 'warning') return { label: labels[severity], type: 'warning' as const };
  return { label: labels[severity], type: 'info' as const };
}

export function businessMonitoringCategoryLabel(category: V2BusinessMonitoringCategory) {
  const labels: Record<V2BusinessMonitoringCategory, string> = {
    order: '订单',
    balance: '余额',
    renewal: '续费与开通',
    exchange_rate: '汇率采集',
    finance: '财务基线'
  };
  return labels[category];
}

export function formatBusinessMonitoringDate(value?: string | null) {
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
