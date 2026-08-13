import type { V2ProfileSessionRecord } from './contracts';
import { getV2BusinessNowMs } from '@/v2/runtime/businessClock';

export function formatProfileDate(value?: string | null) {
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

export function profileClientSummary(value?: string | null) {
  const text = value?.trim();
  if (!text) return '—';
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

export function profileSessionStateMeta(
  item: V2ProfileSessionRecord,
  now = getV2BusinessNowMs() ?? Number.NEGATIVE_INFINITY
) {
  if (item.revokedAt) return { label: '已下线', type: 'info' as const };
  if (new Date(item.expiresAt).getTime() <= now) {
    return { label: '已过期', type: 'warning' as const };
  }
  if (item.isCurrent) return { label: '当前设备', type: 'success' as const };
  return { label: '在线', type: 'primary' as const };
}

export function profileRoleLabel(roles: Array<{ name: string }>) {
  return (
    roles
      .map((role) => role.name.trim())
      .filter(Boolean)
      .join('、') || '未分配角色'
  );
}
