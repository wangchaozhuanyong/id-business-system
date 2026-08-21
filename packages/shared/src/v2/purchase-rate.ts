import { V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES } from './decimal.js';

export const V2_PURCHASE_RATE_ROUNDING_MODES = ['ROUND_DOWN', 'ROUND_HALF_UP', 'ROUND_UP'] as const;

export type V2PurchaseRateRoundingMode = (typeof V2_PURCHASE_RATE_ROUNDING_MODES)[number];

export interface CalculateV2PurchaseRateInput {
  marketRateCnyPerUnit: string;
  purchaseRatio: string;
  quoteUnit: string;
  decimalPlaces: number;
  roundingMode: V2PurchaseRateRoundingMode;
}

export interface V2PurchaseRateCalculation {
  purchaseRateRaw: string;
  purchaseRateDisplay: string;
  purchaseRateFormatted: string;
}

interface ParsedUnsignedDecimal {
  units: bigint;
  scale: number;
}

const MAX_PERSISTED_RATE_UNITS = 10n ** BigInt(V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES + 10) - 1n;

export function calculateV2PurchaseRate(
  input: CalculateV2PurchaseRateInput
): V2PurchaseRateCalculation {
  if (
    !Number.isInteger(input.decimalPlaces) ||
    input.decimalPlaces < 0 ||
    input.decimalPlaces > V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES
  ) {
    throw new Error(`收购价小数位必须是 0 到 ${V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES} 之间的整数`);
  }
  if (!V2_PURCHASE_RATE_ROUNDING_MODES.includes(input.roundingMode)) {
    throw new Error('收购价舍入方式无效');
  }

  const marketRate = parsePositiveDecimal(input.marketRateCnyPerUnit, '国际人民币汇率');
  const purchaseRatio = parsePositiveDecimal(input.purchaseRatio, '收购比例');
  const quoteUnit = parsePositiveDecimal(input.quoteUnit, '显示单位');
  if (isGreaterThanOne(purchaseRatio)) {
    throw new Error('收购比例不能大于 100%');
  }

  const exactUnits = marketRate.units * purchaseRatio.units * quoteUnit.units;
  const exactScale = marketRate.scale + purchaseRatio.scale + quoteUnit.scale;
  const rawUnits = rescalePositive(
    exactUnits,
    exactScale,
    V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES,
    'ROUND_HALF_UP'
  );
  const displayUnits = rescalePositive(
    exactUnits,
    exactScale,
    input.decimalPlaces,
    input.roundingMode
  );
  if (rawUnits === 0n) {
    throw new Error('收购价小于系统可保存的最小汇率精度');
  }
  const persistedDisplayUnits =
    displayUnits * 10n ** BigInt(V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES - input.decimalPlaces);
  if (rawUnits > MAX_PERSISTED_RATE_UNITS || persistedDisplayUnits > MAX_PERSISTED_RATE_UNITS) {
    throw new Error('收购价超过系统可保存的最大汇率范围');
  }

  return {
    purchaseRateRaw: formatCanonical(rawUnits, V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES),
    purchaseRateDisplay: formatCanonical(displayUnits, input.decimalPlaces),
    purchaseRateFormatted: formatFixed(displayUnits, input.decimalPlaces)
  };
}

export function formatV2PurchaseRate(value: string, decimalPlaces: number) {
  const parsed = parseUnsignedDecimal(value, '收购价');
  const units = rescalePositive(parsed.units, parsed.scale, decimalPlaces, 'ROUND_HALF_UP');
  return formatFixed(units, decimalPlaces);
}

function parsePositiveDecimal(value: string, label: string) {
  const parsed = parseUnsignedDecimal(value, label);
  if (parsed.units <= 0n) throw new Error(`${label}必须大于 0`);
  if (parsed.scale > V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES) {
    throw new Error(`${label}最多保留 ${V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES} 位小数`);
  }
  return parsed;
}

function parseUnsignedDecimal(value: string, label: string): ParsedUnsignedDecimal {
  const normalized = String(value ?? '').trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) throw new Error(`${label}格式无效`);
  const fraction = match[2] ?? '';
  return {
    units: BigInt(`${match[1]}${fraction}`),
    scale: fraction.length
  };
}

function isGreaterThanOne(value: ParsedUnsignedDecimal) {
  return value.units > 10n ** BigInt(value.scale);
}

function rescalePositive(
  units: bigint,
  currentScale: number,
  targetScale: number,
  roundingMode: V2PurchaseRateRoundingMode
) {
  if (currentScale <= targetScale) {
    return units * 10n ** BigInt(targetScale - currentScale);
  }

  const divisor = 10n ** BigInt(currentScale - targetScale);
  const quotient = units / divisor;
  const remainder = units % divisor;
  if (remainder === 0n || roundingMode === 'ROUND_DOWN') return quotient;
  if (roundingMode === 'ROUND_UP') return quotient + 1n;
  return remainder * 2n >= divisor ? quotient + 1n : quotient;
}

function formatCanonical(units: bigint, scale: number) {
  if (scale === 0) return units.toString();
  const fixed = formatFixed(units, scale);
  const canonical = fixed.replace(/\.?0+$/, '');
  return canonical || '0';
}

function formatFixed(units: bigint, scale: number) {
  if (scale === 0) return units.toString();
  const digits = units.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}
