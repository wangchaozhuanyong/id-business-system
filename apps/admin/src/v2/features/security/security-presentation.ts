import type {
  V2ActiveSessionRecord,
  V2LoginLogRecord,
  V2LoginLogStatus,
  V2SecurityUser
} from './contracts';
import { getV2BusinessNowMs } from '@/v2/runtime/businessClock';

export function formatSecurityDate(value?: string | null) {
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

export function securityUserLabel(user?: V2SecurityUser | null, fallback?: string) {
  if (!user) return fallback?.trim() || '未知用户';
  return `${user.displayName}（${user.username}）`;
}

export function loginStatusMeta(status: V2LoginLogStatus) {
  if (status === 'success') return { label: '成功', type: 'success' as const };
  if (status === 'blocked') return { label: '已拦截', type: 'danger' as const };
  return { label: '失败', type: 'warning' as const };
}

export function loginRiskLabel(item: V2LoginLogRecord) {
  return item.abnormal ? '异常' : '正常';
}

export function sessionStateMeta(
  item: V2ActiveSessionRecord,
  now = getV2BusinessNowMs() ?? Number.NEGATIVE_INFINITY
) {
  if (item.revokedAt) return { label: '已下线', type: 'info' as const };
  if (new Date(item.expiresAt).getTime() <= now) {
    return { label: '已过期', type: 'warning' as const };
  }
  if (item.isCurrent) return { label: '当前会话', type: 'success' as const };
  return { label: '在线', type: 'primary' as const };
}

export function clientSummary(value?: string | null) {
  const text = value?.trim();
  if (!text) return '—';
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}
