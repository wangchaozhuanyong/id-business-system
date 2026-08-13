import { formatV2Decimal } from '@/v2/utils/decimal';
import { formatV2DateTime, toV2DateTimeInput } from '@/v2/utils/dateTime';

export function formatSupplierFundDecimal(value: string) {
  return formatV2Decimal(value, { minimumFractionDigits: 2 });
}

export function formatSupplierFundSignedCurrency(value: string) {
  const negative = value.startsWith('-');
  const absolute = negative ? value.slice(1) : value;
  return `${negative ? '-' : '+'}¥${formatSupplierFundDecimal(absolute)}`;
}

export function formatSupplierFundDate(value: string) {
  return formatV2DateTime(value, {}, '—');
}

export function formatOptionalSupplierFundDate(value: string | null) {
  return value ? formatSupplierFundDate(value) : '—';
}

export function toLocalDateTimeInput(value: Date) {
  return toV2DateTimeInput(value);
}
