import type { TagProps } from 'element-plus';
import { formatV2Decimal } from '@/v2/utils/decimal';
import type { V2OptionSelector, V2OrderAccountDisposition, V2OrderStatus } from './contracts';

export const statusOptions: Array<{
  value: V2OrderStatus;
  label: string;
  type: TagProps['type'];
}> = [
  { value: 'draft', label: '草稿', type: 'info' },
  { value: 'pending', label: '待处理', type: 'warning' },
  { value: 'waiting_external', label: '等待 Apple 执行', type: 'warning' },
  { value: 'processing', label: '处理中', type: 'primary' },
  { value: 'completed', label: '已完成', type: 'success' },
  { value: 'refunded', label: '已退款', type: 'warning' },
  { value: 'cancelled', label: '已取消', type: 'info' },
  { value: 'failed', label: '失败', type: 'danger' }
];

export const accountDispositionOptions: Array<{
  value: V2OrderAccountDisposition;
  label: string;
  type: TagProps['type'];
}> = [
  { value: 'retained', label: '保留 ID', type: 'info' },
  { value: 'sold', label: '已卖出', type: 'danger' },
  { value: 'recovered', label: '已收回', type: 'success' }
];

export function statusMeta(status: V2OrderStatus) {
  return (
    statusOptions.find((option) => option.value === status) ?? {
      value: status,
      label: status,
      type: 'info' as const
    }
  );
}

export function accountDispositionMeta(disposition: V2OrderAccountDisposition) {
  return (
    accountDispositionOptions.find((option) => option.value === disposition) ?? {
      value: disposition,
      label: disposition,
      type: 'info' as const
    }
  );
}

export function lockScopeLabel(value: 'by_service' | 'global') {
  return value === 'global' ? '整个 ID' : '当前业务';
}

export function selectorLabel(option: V2OptionSelector) {
  return [option.country?.name, option.parent?.name, option.name].filter(Boolean).join(' / ');
}

export function formatDecimal(value: string) {
  return formatV2Decimal(value);
}

export function formatNullableDecimal(value: string | null) {
  return value === null ? '-' : formatDecimal(value);
}

export function profitClass(value: string | null) {
  if (value === null || Number(value) === 0) return 'v2-order-money';
  return Number(value) > 0 ? 'v2-order-profit--positive' : 'v2-order-profit--negative';
}

export function formatDate(value: string | null) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value));
}
