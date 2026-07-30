import { formatV2Decimal } from '@/v2/utils/decimal';

export function formatSupplierFundDecimal(value: string) {
  return formatV2Decimal(value, { minimumFractionDigits: 2 });
}

export function formatSupplierFundSignedCurrency(value: string) {
  const negative = value.startsWith('-');
  const absolute = negative ? value.slice(1) : value;
  return `${negative ? '-' : '+'}¥${formatSupplierFundDecimal(absolute)}`;
}

export function formatSupplierFundDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value));
}

export function formatOptionalSupplierFundDate(value: string | null) {
  return value ? formatSupplierFundDate(value) : '—';
}

export function toLocalDateTimeInput(value: Date) {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}
