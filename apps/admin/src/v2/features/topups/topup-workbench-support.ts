import { formatV2Decimal, isV2UnsignedDecimal, multiplyDecimalStrings } from '@/v2/utils/decimal';
import type { V2TopupServiceSummary } from './contracts';

interface GiftCardValueForm {
  faceValue: string;
  exchangeRate: string;
}

export function toLocalDateTimeInput(value: Date) {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

export function calculateCreditCostPreview(form: GiftCardValueForm) {
  if (
    !isV2UnsignedDecimal(form.faceValue, { allowZero: false }) ||
    !isV2UnsignedDecimal(form.exchangeRate, {
      allowZero: false,
      decimalPlaces: 8
    })
  ) {
    return '';
  }
  return multiplyDecimalStrings(form.faceValue, form.exchangeRate);
}

export function maskGiftCardCode(value: string) {
  if (value.length < 8) return value;
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

export function formatDecimal(value: string) {
  return formatV2Decimal(value);
}

export function isValidBalanceInput(value: string) {
  return !value || isV2UnsignedDecimal(value);
}

export function formatDate(value: string) {
  return formatDateTime(value, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function formatTime(value: string) {
  return formatDateTime(value, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

export function servicePath(service: V2TopupServiceSummary) {
  return service.parent ? `${service.parent.name} / ${service.name}` : service.name;
}

export function formatElapsed(value: string | null) {
  if (!value) return '-';
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours < 48) return `${Math.max(1, hours)} 小时前`;
  return `${Math.max(2, Math.floor(hours / 24))} 天前`;
}

function formatDateTime(value: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('zh-CN', { ...options, hour12: false }).format(new Date(value));
}
