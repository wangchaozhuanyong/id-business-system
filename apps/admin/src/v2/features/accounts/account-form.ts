import {
  divideDecimalStrings,
  isV2UnsignedDecimal,
  multiplyDecimalStrings
} from '@/v2/utils/decimal';

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
  return isV2UnsignedDecimal(value);
}

export function isNonNegativeExchangeRate(value: unknown) {
  return isV2UnsignedDecimal(value);
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
  return multiplyDecimalStrings(String(balance), String(exchangeRate));
}

export function calculateExchangeRate(balance: unknown, balanceCostAmount: unknown) {
  if (!isNonNegativeDecimal(balance) || !isNonNegativeDecimal(balanceCostAmount)) return null;
  if (isZeroDecimal(balance)) return '0';
  return divideDecimalStrings(String(balanceCostAmount), String(balance));
}
