import {
  V2_DECIMAL_PLACES,
  V2_DECIMAL_STEP,
  addDecimalStrings,
  divideDecimalStrings,
  isV2UnsignedDecimal,
  multiplyDecimalStrings,
  roundDecimalString
} from '@apple-business/shared';

export {
  V2_DECIMAL_PLACES,
  V2_DECIMAL_STEP,
  addDecimalStrings,
  divideDecimalStrings,
  isV2UnsignedDecimal,
  multiplyDecimalStrings,
  roundDecimalString
};

export function formatV2Decimal(
  value: string | number | null | undefined,
  options: {
    minimumFractionDigits?: number;
  } = {}
) {
  if (value === null || value === undefined || value === '') return '-';
  try {
    const rounded = roundDecimalString(value);
    const negative = rounded.startsWith('-');
    const normalized = negative ? rounded.slice(1) : rounded;
    const [integerPart, fraction = ''] = normalized.split('.');
    const minimumFractionDigits = Math.min(
      V2_DECIMAL_PLACES,
      Math.max(0, options.minimumFractionDigits ?? 0)
    );
    const paddedFraction = fraction.padEnd(minimumFractionDigits, '0');
    const groupedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const formatted = paddedFraction ? `${groupedInteger}.${paddedFraction}` : groupedInteger;
    return negative && normalized !== '0' ? `-${formatted}` : formatted;
  } catch {
    return String(value);
  }
}
