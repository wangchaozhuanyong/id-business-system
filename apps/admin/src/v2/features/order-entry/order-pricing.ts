import type { V2FinanceCurrency } from '@apple-business/shared';
import { V2_DECIMAL_PLACES, divideDecimalStrings } from '@/v2/utils/decimal';

const AMOUNT_SCALE = V2_DECIMAL_PLACES;
const PERCENT_SCALE = V2_DECIMAL_PLACES;
const PERCENT_FACTOR = 10n ** BigInt(PERCENT_SCALE);
const PERCENT_BASE = 100n * PERCENT_FACTOR;
const MAX_AMOUNT_UNITS = 999_999_999_999_999_999n;

export interface SuggestedReceivedAmount {
  amount: string | null;
  platformFee: string | null;
  estimatedProfit: string | null;
  estimatedProfitRate: string | null;
  error: string;
}

export function isNonNegativeOrderAmount(value: unknown) {
  return parseUnsignedDecimal(value, AMOUNT_SCALE, MAX_AMOUNT_UNITS) !== null;
}

export function isPositiveOrderAmount(value: unknown) {
  const amount = parseUnsignedDecimal(value, AMOUNT_SCALE, MAX_AMOUNT_UNITS);
  return amount !== null && amount > 0n;
}

export function calculatePlatformFeeAmount(
  receivedAmount: unknown,
  fixedFee: unknown,
  percentageFee: unknown
) {
  const received = parseUnsignedDecimal(receivedAmount, AMOUNT_SCALE, MAX_AMOUNT_UNITS);
  const fixed = parseUnsignedDecimal(fixedFee, AMOUNT_SCALE, MAX_AMOUNT_UNITS);
  const percentage = parseUnsignedDecimal(percentageFee, PERCENT_SCALE, PERCENT_BASE);
  if (received === null || fixed === null || percentage === null) return null;

  const percentageAmount = divideHalfUp(received * percentage, PERCENT_BASE);
  const fee = fixed + percentageAmount;
  if (fee > MAX_AMOUNT_UNITS) return null;
  return formatScaledInteger(fee, AMOUNT_SCALE);
}

export function calculateEstimatedProfitAmount(
  receivedAmount: unknown,
  platformFee: unknown,
  appliedAccountCostAmount: unknown,
  estimatedBalanceCostAmount: unknown
) {
  const received = parseUnsignedDecimal(receivedAmount, AMOUNT_SCALE, MAX_AMOUNT_UNITS);
  const fee = parseUnsignedDecimal(platformFee, AMOUNT_SCALE, MAX_AMOUNT_UNITS);
  const accountCost = parseUnsignedDecimal(
    appliedAccountCostAmount,
    AMOUNT_SCALE,
    MAX_AMOUNT_UNITS
  );
  const balanceCost = parseUnsignedDecimal(
    estimatedBalanceCostAmount,
    AMOUNT_SCALE,
    MAX_AMOUNT_UNITS
  );
  if (received === null || fee === null || accountCost === null || balanceCost === null)
    return null;

  return formatScaledInteger(received - fee - accountCost - balanceCost, AMOUNT_SCALE);
}

export function calculateProfitRate(profitAmount: unknown, receivedAmount: unknown) {
  const profit = parseSignedDecimal(profitAmount, AMOUNT_SCALE, MAX_AMOUNT_UNITS);
  const received = parseUnsignedDecimal(receivedAmount, AMOUNT_SCALE, MAX_AMOUNT_UNITS);
  if (profit === null || received === null || received <= 0n) return null;
  const rate = divideHalfUpSigned(profit * PERCENT_BASE, received);
  return formatScaledInteger(rate, PERCENT_SCALE);
}

export function calculateSuggestedOriginalAmount(
  suggestedCnyAmount: unknown,
  currency: V2FinanceCurrency,
  rateToCny: unknown
) {
  const amount = parseUnsignedDecimal(suggestedCnyAmount, AMOUNT_SCALE, MAX_AMOUNT_UNITS);
  if (amount === null) return null;
  if (currency === 'CNY') return formatScaledInteger(amount, AMOUNT_SCALE);
  const rate = parseUnsignedDecimal(rateToCny, PERCENT_SCALE, MAX_AMOUNT_UNITS);
  if (rate === null || rate <= 0n) return null;
  return divideDecimalStrings(
    formatScaledInteger(amount, AMOUNT_SCALE),
    formatScaledInteger(rate, PERCENT_SCALE)
  );
}

export function validateTargetProfitRate(targetProfitRate: unknown, percentageFee: unknown) {
  const targetRate = parseUnsignedDecimal(targetProfitRate, PERCENT_SCALE, PERCENT_BASE);
  if (targetRate === null) {
    return `目标利润率必须是最多 ${V2_DECIMAL_PLACES} 位小数且不超过 100 的非负数`;
  }
  const platformRate = parseUnsignedDecimal(percentageFee, PERCENT_SCALE, PERCENT_BASE);
  if (platformRate === null) return '结算平台手续费比例配置无效';
  if (targetRate + platformRate >= PERCENT_BASE) {
    return '目标利润率与平台手续费率合计必须小于 100%';
  }
  return '';
}

export function calculateSuggestedReceivedAmount(input: {
  targetProfitRate: unknown;
  appliedAccountCostAmount: unknown;
  estimatedBalanceCostAmount: unknown;
  fixedFee: unknown;
  percentageFee: unknown;
}): SuggestedReceivedAmount {
  const targetProfitRate = parseUnsignedDecimal(
    input.targetProfitRate,
    PERCENT_SCALE,
    PERCENT_BASE
  );
  const rateError = validateTargetProfitRate(input.targetProfitRate, input.percentageFee);
  if (rateError || targetProfitRate === null) return unavailableSuggestion(rateError);
  const accountCost = parseUnsignedDecimal(
    input.appliedAccountCostAmount,
    AMOUNT_SCALE,
    MAX_AMOUNT_UNITS
  );
  if (accountCost === null) {
    return unavailableSuggestion('ID 成本格式无效');
  }
  const balanceCost = parseUnsignedDecimal(
    input.estimatedBalanceCostAmount,
    AMOUNT_SCALE,
    MAX_AMOUNT_UNITS
  );
  if (balanceCost === null) {
    return unavailableSuggestion('请先选择可用 ID，以确定预计消耗成本');
  }
  const fixedFee = parseUnsignedDecimal(input.fixedFee, AMOUNT_SCALE, MAX_AMOUNT_UNITS);
  const percentageFee = parseUnsignedDecimal(input.percentageFee, PERCENT_SCALE, PERCENT_BASE);
  if (fixedFee === null || percentageFee === null) {
    return unavailableSuggestion('结算平台手续费配置无效');
  }

  const baseAmount = accountCost + balanceCost + fixedFee;
  if (baseAmount === 0n) {
    return unavailableSuggestion('当前成本为 0，无法按利润率反推唯一价格，请手动定价');
  }

  const netPercentage = PERCENT_BASE - percentageFee - targetProfitRate;
  let received = divideCeil(baseAmount * PERCENT_BASE, netPercentage);
  if (received > MAX_AMOUNT_UNITS) {
    return unavailableSuggestion('建议收款金额超出系统金额上限');
  }

  let result = calculateSuggestionResult(
    received,
    fixedFee,
    percentageFee,
    accountCost,
    balanceCost
  );
  if (result.feeUnits > MAX_AMOUNT_UNITS) {
    return unavailableSuggestion('建议平台手续费超出系统金额上限');
  }
  while (result.profitUnits * PERCENT_BASE < received * targetProfitRate) {
    received += 1n;
    if (received > MAX_AMOUNT_UNITS) {
      return unavailableSuggestion('建议收款金额超出系统金额上限');
    }
    result = calculateSuggestionResult(received, fixedFee, percentageFee, accountCost, balanceCost);
    if (result.feeUnits > MAX_AMOUNT_UNITS) {
      return unavailableSuggestion('建议平台手续费超出系统金额上限');
    }
  }

  return {
    amount: formatScaledInteger(received, AMOUNT_SCALE),
    platformFee: formatScaledInteger(result.feeUnits, AMOUNT_SCALE),
    estimatedProfit: formatScaledInteger(result.profitUnits, AMOUNT_SCALE),
    estimatedProfitRate: calculateProfitRate(
      formatScaledInteger(result.profitUnits, AMOUNT_SCALE),
      formatScaledInteger(received, AMOUNT_SCALE)
    ),
    error: ''
  };
}

export function calculateEstimatedBalanceCostAmount(
  currentBalance: unknown,
  balanceCostAmount: unknown,
  consumptionAmount: unknown
) {
  const balance = parseUnsignedDecimal(currentBalance, AMOUNT_SCALE, MAX_AMOUNT_UNITS);
  const cost = parseUnsignedDecimal(balanceCostAmount, AMOUNT_SCALE, MAX_AMOUNT_UNITS);
  const consumption = parseUnsignedDecimal(consumptionAmount, AMOUNT_SCALE, MAX_AMOUNT_UNITS);
  if (balance === null || cost === null || consumption === null || balance <= 0n) return null;
  if (consumption > balance) return null;
  if (consumption === balance) return formatScaledInteger(cost, AMOUNT_SCALE);
  const estimated = divideHalfUp(consumption * cost, balance);
  return formatScaledInteger(estimated > cost ? cost : estimated, AMOUNT_SCALE);
}

function calculateSuggestionResult(
  received: bigint,
  fixedFee: bigint,
  percentageFee: bigint,
  accountCost: bigint,
  balanceCost: bigint
) {
  const feeUnits = fixedFee + divideHalfUp(received * percentageFee, PERCENT_BASE);
  return {
    feeUnits,
    profitUnits: received - feeUnits - accountCost - balanceCost
  };
}

export function calculateTotalCostAmount(
  platformFee: unknown,
  appliedAccountCostAmount: unknown,
  estimatedBalanceCostAmount: unknown
) {
  const fee = parseUnsignedDecimal(platformFee, AMOUNT_SCALE, MAX_AMOUNT_UNITS);
  const accountCost = parseUnsignedDecimal(
    appliedAccountCostAmount,
    AMOUNT_SCALE,
    MAX_AMOUNT_UNITS
  );
  const balanceCost = parseUnsignedDecimal(
    estimatedBalanceCostAmount,
    AMOUNT_SCALE,
    MAX_AMOUNT_UNITS
  );
  if (fee === null || accountCost === null || balanceCost === null) return null;
  const total = fee + accountCost + balanceCost;
  return total <= MAX_AMOUNT_UNITS ? formatScaledInteger(total, AMOUNT_SCALE) : null;
}

function unavailableSuggestion(error: string): SuggestedReceivedAmount {
  return {
    amount: null,
    platformFee: null,
    estimatedProfit: null,
    estimatedProfitRate: null,
    error
  };
}

function parseUnsignedDecimal(value: unknown, scale: number, maximum: bigint) {
  const normalized = String(value ?? '').trim();
  if (!new RegExp(`^\\d+(\\.\\d{1,${scale}})?$`).test(normalized)) return null;
  const [integerPart = '0', fractionalPart = ''] = normalized.split('.');
  const units = BigInt(`${integerPart}${fractionalPart.padEnd(scale, '0')}`);
  return units <= maximum ? units : null;
}

function parseSignedDecimal(value: unknown, scale: number, maximum: bigint) {
  const normalized = String(value ?? '').trim();
  if (!new RegExp(`^-?\\d+(\\.\\d{1,${scale}})?$`).test(normalized)) return null;
  const negative = normalized.startsWith('-');
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [integerPart = '0', fractionalPart = ''] = unsigned.split('.');
  const units = BigInt(`${integerPart}${fractionalPart.padEnd(scale, '0')}`);
  if (units > maximum) return null;
  return negative ? -units : units;
}

function divideHalfUp(value: bigint, divisor: bigint) {
  const quotient = value / divisor;
  const remainder = value % divisor;
  return remainder * 2n >= divisor ? quotient + 1n : quotient;
}

function divideHalfUpSigned(value: bigint, divisor: bigint) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const result = divideHalfUp(absolute, divisor);
  return negative ? -result : result;
}

function divideCeil(value: bigint, divisor: bigint) {
  return (value + divisor - 1n) / divisor;
}

function formatScaledInteger(value: bigint, scale: number) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const digits = absolute.toString().padStart(scale + 1, '0');
  const integerPart = digits.slice(0, -scale);
  const fractionalPart = digits.slice(-scale).replace(/0+$/, '');
  const formatted = fractionalPart ? `${integerPart}.${fractionalPart}` : integerPart;
  return negative ? `-${formatted}` : formatted;
}
