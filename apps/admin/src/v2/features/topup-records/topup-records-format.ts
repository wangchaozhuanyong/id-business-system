import { formatV2Decimal } from '@/v2/utils/decimal';
import type { V2BalanceLedgerEntryType, V2GiftCardRecordStatus } from './contracts';
import type { RecordsTab } from './useTopupRecordsPage';

export function giftCardStatusLabel(status: V2GiftCardRecordStatus) {
  return {
    credited: '加卡成功',
    redeemed: '被赎回',
    withdrawn: '已撤回'
  }[status];
}

export function giftCardStatusType(status: V2GiftCardRecordStatus) {
  return status === 'credited' ? 'success' : status === 'redeemed' ? 'warning' : 'info';
}

export function ledgerTypeLabel(entryType: V2BalanceLedgerEntryType) {
  return {
    gift_card_credit: '礼品卡入账',
    gift_card_redeemed: '被赎回扣减',
    gift_card_withdrawal: '撤回扣减',
    order_consumption: '订单扣减',
    order_consumption_reversal: '订单退款恢复',
    opening_balance: '期初余额',
    manual_adjustment: '手工修正',
    account_loss: 'ID 报损冻结'
  }[entryType];
}

export function ledgerTypeTag(entryType: V2BalanceLedgerEntryType) {
  if (entryType === 'account_loss') return 'danger';
  return entryType === 'gift_card_credit' || entryType === 'opening_balance'
    ? 'success'
    : entryType === 'gift_card_redeemed' || entryType === 'order_consumption'
      ? 'warning'
      : 'info';
}

export function deltaType(value: string) {
  return Number(value) < 0 ? 'debit' : 'credit';
}

export function formatDecimal(value: string) {
  return formatV2Decimal(value);
}

export function formatSignedDecimal(value: string) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  const formatted = formatDecimal(String(Math.abs(number)));
  return number > 0 ? `+${formatted}` : number < 0 ? `-${formatted}` : formatted;
}

export function formatSignedCurrency(value: string) {
  const number = Number(value);
  if (!Number.isFinite(number)) return `¥${value}`;
  const formatted = `¥${formatDecimal(String(Math.abs(number)))}`;
  return number > 0 ? `+${formatted}` : number < 0 ? `-${formatted}` : formatted;
}

export function formatOptionalDecimal(value?: string) {
  return value === undefined ? '—' : formatDecimal(value);
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value));
}

export function readRecordsTab(value: unknown): RecordsTab {
  const normalized = Array.isArray(value) ? value[0] : value;
  return normalized === 'ledger' || normalized === 'suppliers' || normalized === 'payments'
    ? normalized
    : 'giftCards';
}

export function readAccountId(value: unknown) {
  const normalized = readQueryString(value, 36);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    normalized
  )
    ? normalized
    : '';
}

export function readQueryString(value: unknown, maximumLength: number) {
  const normalized = Array.isArray(value) ? value[0] : value;
  return typeof normalized === 'string' ? normalized.trim().slice(0, maximumLength) : '';
}
