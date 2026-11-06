export const V2_DECIMAL_PLACES = 4;
export const V2_DECIMAL_STEP = '0.0001';
export const V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES = 8;

interface ParsedDecimal {
  negative: boolean;
  units: bigint;
  scale: number;
}

export function v2UnsignedDecimalPattern(decimalPlaces = V2_DECIMAL_PLACES) {
  return new RegExp(`^\\d+(\\.\\d{1,${decimalPlaces}})?$`);
}

export function isV2UnsignedDecimal(
  value: unknown,
  options: {
    allowZero?: boolean;
    decimalPlaces?: number;
  } = {}
) {
  const normalized = String(value ?? '').trim();
  const decimalPlaces = options.decimalPlaces ?? V2_DECIMAL_PLACES;
  if (!v2UnsignedDecimalPattern(decimalPlaces).test(normalized)) return false;
  const parsed = parseDecimal(normalized);
  if (!parsed) return false;
  return options.allowZero === false ? parsed.units > 0n : true;
}

export function roundDecimalString(value: string | number, decimalPlaces = V2_DECIMAL_PLACES) {
  const parsed = parseDecimal(value);
  if (!parsed) throw new Error('无效的小数');
  const roundedUnits = rescaleHalfUp(parsed.units, parsed.scale, decimalPlaces);
  return formatScaledInteger(parsed.negative ? -roundedUnits : roundedUnits, decimalPlaces);
}

export function addDecimalStrings(
  left: string | number,
  right: string | number,
  decimalPlaces = V2_DECIMAL_PLACES
) {
  const leftValue = parseDecimal(left);
  const rightValue = parseDecimal(right);
  if (!leftValue || !rightValue) throw new Error('无效的小数');
  const calculationScale = Math.max(leftValue.scale, rightValue.scale);
  const leftUnits = signedUnits(leftValue, calculationScale);
  const rightUnits = signedUnits(rightValue, calculationScale);
  const result = leftUnits + rightUnits;
  const negative = result < 0n;
  const roundedUnits = rescaleHalfUp(negative ? -result : result, calculationScale, decimalPlaces);
  return formatScaledInteger(negative ? -roundedUnits : roundedUnits, decimalPlaces);
}

export function multiplyDecimalStrings(
  left: string | number,
  right: string | number,
  decimalPlaces = V2_DECIMAL_PLACES
) {
  const leftValue = parseDecimal(left);
  const rightValue = parseDecimal(right);
  if (!leftValue || !rightValue) throw new Error('无效的小数');
  const negative = leftValue.negative !== rightValue.negative;
  const resultUnits = leftValue.units * rightValue.units;
  const roundedUnits = rescaleHalfUp(
    resultUnits,
    leftValue.scale + rightValue.scale,
    decimalPlaces
  );
  return formatScaledInteger(negative ? -roundedUnits : roundedUnits, decimalPlaces);
}

export function divideDecimalStrings(
  numerator: string | number,
  denominator: string | number,
  decimalPlaces = V2_DECIMAL_PLACES
) {
  const numeratorValue = parseDecimal(numerator);
  const denominatorValue = parseDecimal(denominator);
  if (!numeratorValue || !denominatorValue || denominatorValue.units === 0n) {
    throw new Error('无效的小数除法');
  }

  const negative = numeratorValue.negative !== denominatorValue.negative;
  const exponent = denominatorValue.scale + decimalPlaces - numeratorValue.scale;
  const scaledNumerator =
    exponent >= 0 ? numeratorValue.units * 10n ** BigInt(exponent) : numeratorValue.units;
  const scaledDenominator =
    exponent >= 0 ? denominatorValue.units : denominatorValue.units * 10n ** BigInt(-exponent);
  const quotient = divideHalfUp(scaledNumerator, scaledDenominator);
  return formatScaledInteger(negative ? -quotient : quotient, decimalPlaces);
}

function parseDecimal(value: string | number): ParsedDecimal | null {
  const normalized = String(value).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) return null;
  const fraction = match[3] ?? '';
  return {
    negative: match[1] === '-',
    units: BigInt(`${match[2]}${fraction}`),
    scale: fraction.length
  };
}

function signedUnits(value: ParsedDecimal, targetScale: number) {
  const units = value.units * 10n ** BigInt(targetScale - value.scale);
  return value.negative ? -units : units;
}

function rescaleHalfUp(units: bigint, currentScale: number, targetScale: number) {
  if (currentScale <= targetScale) {
    return units * 10n ** BigInt(targetScale - currentScale);
  }
  return divideHalfUp(units, 10n ** BigInt(currentScale - targetScale));
}

function divideHalfUp(value: bigint, divisor: bigint) {
  const quotient = value / divisor;
  const remainder = value % divisor;
  return remainder * 2n >= divisor ? quotient + 1n : quotient;
}

function formatScaledInteger(value: bigint, scale: number) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  if (scale === 0) return `${negative ? '-' : ''}${absolute.toString()}`;
  const digits = absolute.toString().padStart(scale + 1, '0');
  const integerPart = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  const formatted = fraction ? `${integerPart}.${fraction}` : integerPart;
  return negative && absolute !== 0n ? `-${formatted}` : formatted;
}
