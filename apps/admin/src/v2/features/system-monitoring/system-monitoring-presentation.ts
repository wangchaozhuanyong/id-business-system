import type { V2SystemMonitoringCheck, V2SystemMonitorStatus } from './contracts';

const SYSTEM_MONITOR_STATUS_PRIORITY: Record<V2SystemMonitorStatus, number> = {
  degraded: 0,
  unknown: 1,
  healthy: 2
};

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

export function sortSystemMonitoringChecks(checks: V2SystemMonitoringCheck[]) {
  return [...checks].sort(
    (left, right) =>
      SYSTEM_MONITOR_STATUS_PRIORITY[left.status] - SYSTEM_MONITOR_STATUS_PRIORITY[right.status]
  );
}

export function summarizeSystemMonitoringChecks(checks: V2SystemMonitoringCheck[]) {
  const summary = checks.reduce(
    (result, check) => {
      result[check.status] += 1;
      return result;
    },
    { healthy: 0, degraded: 0, unknown: 0 }
  );
  const observable = summary.healthy + summary.degraded;

  return {
    ...summary,
    total: checks.length,
    observable,
    coverageRate: checks.length > 0 ? Math.round((observable / checks.length) * 100) : 0
  };
}

export function formatSystemMonitoringDate(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

const SYSTEM_MONITORING_ISO_DATE_PATTERN =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z\b/g;

export function formatSystemMonitoringDetail(detail: string) {
  return detail.replace(SYSTEM_MONITORING_ISO_DATE_PATTERN, (value) =>
    formatSystemMonitoringDate(value)
  );
}

export function exchangeRunStatusLabel(status?: 'running' | 'success' | 'failed') {
  if (status === 'running') return '运行中';
  if (status === 'success') return '成功';
  if (status === 'failed') return '失败';
  return '无运行记录';
}
