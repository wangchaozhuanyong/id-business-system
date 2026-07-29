export interface AccountFormState {
  appleId: string;
  password: string;
  phone: string;
  securityInfo: string;
  countryOptionId: string;
  statusOptionId: string;
  supplierOptionId: string;
  currentBalance: string;
  exchangeRate: string;
  balanceCostAmount: string;
  balanceAdjustmentReason: string;
  purchaseCost: number;
  active: boolean;
  remark: string;
}

export function emptyAccountForm(): AccountFormState {
  return {
    appleId: '',
    password: '',
    phone: '',
    securityInfo: '',
    countryOptionId: '',
    statusOptionId: '',
    supplierOptionId: '',
    currentBalance: '0',
    exchangeRate: '0',
    balanceCostAmount: '0',
    balanceAdjustmentReason: '',
    purchaseCost: 0,
    active: true,
    remark: ''
  };
}

export function isNonNegativeDecimal(value: unknown) {
  const normalized = String(value ?? '').trim();
  return /^\d+(\.\d{1,4})?$/.test(normalized);
}

export function isNonNegativeExchangeRate(value: unknown) {
  const normalized = String(value ?? '').trim();
  return /^\d+(\.\d{1,8})?$/.test(normalized);
}

export function normalizeDecimalInput(value: unknown) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '0';
  const [integerPart = '0', fractionalPart = ''] = normalized.split('.');
  const integer = integerPart.replace(/^0+(?=\d)/, '') || '0';
  const fractional = fractionalPart.replace(/0+$/, '');
  return fractional ? `${integer}.${fractional}` : integer;
}

export function isZeroDecimal(value: unknown) {
  return normalizeDecimalInput(value) === '0';
}

export function calculateBalanceCost(balance: unknown, exchangeRate: unknown) {
  if (!isNonNegativeDecimal(balance) || !isNonNegativeExchangeRate(exchangeRate)) return null;

  const balanceUnits = decimalToScaledInteger(balance, 4);
  const exchangeRateUnits = decimalToScaledInteger(exchangeRate, 8);
  const costUnits = roundHalfUp(balanceUnits * exchangeRateUnits, 10n ** 8n);
  return scaledIntegerToDecimal(costUnits, 4);
}

export function calculateExchangeRate(balance: unknown, balanceCostAmount: unknown) {
  if (!isNonNegativeDecimal(balance) || !isNonNegativeDecimal(balanceCostAmount)) return null;

  const balanceUnits = decimalToScaledInteger(balance, 4);
  if (balanceUnits === 0n) return '0';

  const costUnits = decimalToScaledInteger(balanceCostAmount, 4);
  const exchangeRateUnits = roundHalfUp(costUnits * 10n ** 8n, balanceUnits);
  return scaledIntegerToDecimal(exchangeRateUnits, 8);
}

function decimalToScaledInteger(value: unknown, scale: number) {
  const [integerPart = '0', fractionalPart = ''] = normalizeDecimalInput(value).split('.');
  const digits = `${integerPart}${fractionalPart.padEnd(scale, '0')}`;
  return BigInt(digits);
}

function roundHalfUp(value: bigint, divisor: bigint) {
  const quotient = value / divisor;
  const remainder = value % divisor;
  return remainder * 2n >= divisor ? quotient + 1n : quotient;
}

function scaledIntegerToDecimal(value: bigint, scale: number) {
  const digits = value.toString().padStart(scale + 1, '0');
  const integerPart = digits.slice(0, -scale);
  const fractionalPart = digits.slice(-scale).replace(/0+$/, '');
  return fractionalPart ? `${integerPart}.${fractionalPart}` : integerPart;
}
