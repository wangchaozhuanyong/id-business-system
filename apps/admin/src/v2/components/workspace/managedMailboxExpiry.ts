import { V2_MANAGED_MAILBOX_QUERY_CODE_VALIDITY } from '@apple-business/shared';

export type V2ManagedMailboxQueryCodeExpiryState = 'expired' | 'invalid' | 'valid' | 'warning';

export interface V2ManagedMailboxQueryCodeExpiryMeta {
  detail: string;
  label: string;
  state: V2ManagedMailboxQueryCodeExpiryState;
}

export function resolveV2ManagedMailboxQueryCodeExpiry(
  value: string,
  nowMs: number,
  formatted: string
): V2ManagedMailboxQueryCodeExpiryMeta {
  const expiresAt = Date.parse(value);
  if (!Number.isFinite(expiresAt)) {
    return { detail: '无法读取到期时间', label: '时间异常', state: 'invalid' };
  }
  const remainingMs = expiresAt - nowMs;
  if (remainingMs <= 0) {
    return { detail: `${formatted} 到期`, label: '已到期', state: 'expired' };
  }
  if (remainingMs <= V2_MANAGED_MAILBOX_QUERY_CODE_VALIDITY.warningHours * 60 * 60 * 1000) {
    const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    const hours = Math.floor(remainingMinutes / 60);
    const minutes = remainingMinutes % 60;
    return {
      detail: `${formatted} 到期`,
      label: `剩余 ${hours}小时${minutes ? `${minutes}分钟` : ''}`,
      state: 'warning'
    };
  }
  return { detail: `${formatted} 到期`, label: '有效', state: 'valid' };
}
