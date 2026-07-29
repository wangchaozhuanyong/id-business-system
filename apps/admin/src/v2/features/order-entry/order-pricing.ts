const AMOUNT_SCALE = 4;
const CENT_FACTOR = 100n;
const PERCENT_SCALE = 4;
const PERCENT_FACTOR = 10n ** BigInt(PERCENT_SCALE);
const PERCENT_BASE = 100n * PERCENT_FACTOR;
const MAX_AMOUNT_UNITS = 999_999_999_999_999_999n;

export interface SuggestedReceivedAmount {
  amount: string | null;
  platformFee: string | null;
  estimatedProfit: string | null;
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
  estimatedBalanceCostAmount: unknown
) {
  const received = parseUnsignedDecimal(receivedAmount, AMOUNT_SCALE, MAX_AMOUNT_UNITS);
  const fee = parseUnsignedDecimal(platformFee, AMOUNT_SCALE, MAX_AMOUNT_UNITS);
  const balanceCost = parseUnsignedDecimal(
    estimatedBalanceCostAmount,
    AMOUNT_SCALE,
    MAX_AMOUNT_UNITS
  );
  if (received === null || fee === null || balanceCost === null) return null;

  return formatScaledInteger(received - fee - balanceCost, AMOUNT_SCALE);
}

export function calculateSuggestedReceivedAmount(input: {
  targetProfit: unknown;
  estimatedBalanceCostAmount: unknown;
  fixedFee: unknown;
  percentageFee: unknown;
}): SuggestedReceivedAmount {
  const targetProfit = parseUnsignedDecimal(input.targetProfit, AMOUNT_SCALE, MAX_AMOUNT_UNITS);
  if (targetProfit === null) {
    return unavailableSuggestion('预计利润必须是最多 4 位小数的非负金额');
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

  const netPercentage = PERCENT_BASE - percentageFee;
  if (netPercentage <= 0n) {
    return unavailableSuggestion('手续费比例为 100%，无法计算建议收款金额');
  }

  const baseAmount = targetProfit + balanceCost + fixedFee;
  let cents = divideCeil(baseAmount * PERCENT_BASE, netPercentage * CENT_FACTOR);
  let received = cents * CENT_FACTOR;
  if (received > MAX_AMOUNT_UNITS) {
    return unavailableSuggestion('建议收款金额超出系统金额上限');
  }

  let result = calculateSuggestionResult(received, fixedFee, percentageFee, balanceCost);
  if (result.feeUnits > MAX_AMOUNT_UNITS) {
    return unavailableSuggestion('建议平台手续费超出系统金额上限');
  }
  while (result.profitUnits < targetProfit) {
    cents += 1n;
    received = cents * CENT_FACTOR;
    if (received > MAX_AMOUNT_UNITS) {
      return unavailableSuggestion('建议收款金额超出系统金额上限');
    }
    result = calculateSuggestionResult(received, fixedFee, percentageFee, balanceCost);
    if (result.feeUnits > MAX_AMOUNT_UNITS) {
      return unavailableSuggestion('建议平台手续费超出系统金额上限');
    }
  }

  return {
    amount: formatScaledInteger(received, AMOUNT_SCALE),
    platformFee: formatScaledInteger(result.feeUnits, AMOUNT_SCALE),
    estimatedProfit: formatScaledInteger(result.profitUnits, AMOUNT_SCALE),
    error: ''
  };
}

function calculateSuggestionResult(
  received: bigint,
  fixedFee: bigint,
  percentageFee: bigint,
  balanceCost: bigint
) {
  const feeUnits = fixedFee + divideHalfUp(received * percentageFee, PERCENT_BASE);
  return {
    feeUnits,
    profitUnits: received - feeUnits - balanceCost
  };
}

function unavailableSuggestion(error: string): SuggestedReceivedAmount {
  return {
    amount: null,
    platformFee: null,
    estimatedProfit: null,
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

function divideHalfUp(value: bigint, divisor: bigint) {
  const quotient = value / divisor;
  const remainder = value % divisor;
  return remainder * 2n >= divisor ? quotient + 1n : quotient;
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
