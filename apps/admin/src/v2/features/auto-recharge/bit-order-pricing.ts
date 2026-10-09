import {
  addDecimalStrings,
  divideDecimalStrings,
  multiplyDecimalStrings,
  roundDecimalString,
  V2_FINANCE_CURRENCY_OPTIONS,
  isV2UnsignedDecimal
} from '@apple-business/shared';
import type {
  BankRechargeOrder,
  BitOrderPricingSettings,
  BitOrderPricingRate
} from './bank-recharge-api';
import type { emptyForm } from './bank-recharge-order-form';

export function estimateBitOrder(
  order: BankRechargeOrder,
  settings: BitOrderPricingSettings | undefined,
  rates: BitOrderPricingRate[],
  now = Date.now()
) {
  const editable =
    order.accountingVersion === 'subscription_cost_v2' &&
    !['completed', 'refunded', 'cancelled'].includes(order.status);
  const currency =
    (order.receivedAmount != null
      ? order.receivedCurrencyCode
      : editable
        ? settings?.receivedCurrencyCode
        : null) ?? 'CNY';
  const receipt =
    order.receivedAmount ?? (editable ? settings?.planPrices[order.plan] : null) ?? null;
  function cachedRate(code: string, saved?: string | null) {
    if (code === 'CNY') return '1';
    if (saved) return saved;
    const found = rates.find((item) => item.currency === code);
    return found?.rateToCny && (!found.expiresAt || Date.parse(found.expiresAt) > now)
      ? found.rateToCny
      : null;
  }
  function cny(amount: string | null, code: string, saved?: string | null) {
    if (amount === null) return null;
    if (/^0(?:\.0+)?$/.test(amount)) return '0';
    const fx = cachedRate(code, saved);
    return fx ? multiplyDecimalStrings(amount, fx, 4) : null;
  }
  function percent(amount: string, percentage: string, precision = 4) {
    return roundDecimalString(
      divideDecimalStrings(multiplyDecimalStrings(amount, percentage, 16), '100', 16),
      precision
    );
  }
  const chargeFx = cachedRate(order.chargeCurrencyCode, order.chargeFxRateToCny);
  const savedReceiptRate = order.receivedAmount != null ? order.receivedFxRateToCny : null;
  const receiptFx = cachedRate(currency, savedReceiptRate);
  const principalCny = cny(order.chargeAmount, order.chargeCurrencyCode, order.chargeFxRateToCny);
  let shoppingFee = order.shoppingFeeAmount ?? null;
  const shoppingCurrency =
    order.shoppingFeeAmount != null ? (order.shoppingFeeCurrencyCode ?? currency) : currency;
  if (
    shoppingFee === null &&
    editable &&
    receipt !== null &&
    settings?.shoppingFeePercent != null
  ) {
    const precision =
      V2_FINANCE_CURRENCY_OPTIONS.find((item) => item.code === currency)?.minorUnits ?? 4;
    shoppingFee = percent(receipt, settings.shoppingFeePercent, precision);
  }
  let usdtFee = order.usdtFeeAmount ?? null;
  const usdtCurrency = order.usdtFeeAmount != null ? (order.usdtFeeCurrencyCode ?? 'USDT') : 'USDT';
  const usdtFx = cachedRate(usdtCurrency, order.usdtFeeFxRateToCny);
  if (usdtFee === null && editable && settings?.usdtFeePercent != null) {
    if (/^0(?:\.0+)?$/.test(settings.usdtFeePercent)) usdtFee = '0';
    else if (principalCny !== null && usdtFx) {
      usdtFee = divideDecimalStrings(percent(principalCny, settings.usdtFeePercent, 8), usdtFx, 4);
    }
  }
  const receivedCny = cny(receipt, currency, savedReceiptRate);
  const usdtCny = cny(usdtFee, usdtCurrency, order.usdtFeeFxRateToCny);
  const shoppingCny = cny(shoppingFee, shoppingCurrency, order.shoppingFeeFxRateToCny);
  const profit =
    order.profitAmountCny ??
    (editable && [receivedCny, principalCny, usdtCny, shoppingCny].every((value) => value !== null)
      ? [principalCny!, usdtCny!, shoppingCny!].reduce(
          (value, cost) => addDecimalStrings(value, `-${cost}`, 4),
          receivedCny!
        )
      : null);
  return {
    receipt,
    currency,
    shoppingFee,
    shoppingCurrency,
    usdtFee,
    usdtCurrency,
    profit,
    chargeFx,
    receiptFx,
    usdtFx,
    shoppingFx: cachedRate(shoppingCurrency, order.shoppingFeeFxRateToCny),
    receiptEstimated: order.receivedAmount == null && receipt !== null,
    shoppingEstimated: order.shoppingFeeAmount == null && shoppingFee !== null,
    usdtEstimated: order.usdtFeeAmount == null && usdtFee !== null,
    profitEstimated: order.profitAmountCny == null && profit !== null
  };
}

export function bitOrderPricingFormDefaults(
  order: BankRechargeOrder,
  form: ReturnType<typeof emptyForm>,
  settings: BitOrderPricingSettings | undefined,
  rates: BitOrderPricingRate[],
  now = Date.now()
) {
  const chargeAmount = order.source === 'automatic' ? order.chargeAmount : form.chargeAmount;
  if (!chargeAmount) throw new Error('请先填写代付金额');
  const chargeCurrencyCode =
    order.source === 'automatic' ? order.chargeCurrencyCode : form.chargeCurrencyCode;
  const receiptCurrency = form.receivedAmount
    ? form.receivedCurrencyCode
    : (settings?.receivedCurrencyCode ?? 'CNY');
  for (const [value, label] of [
    [chargeAmount, '代付金额'],
    [form.receivedAmount, '客户实收']
  ] as const) {
    if (value && !isV2UnsignedDecimal(value, { allowZero: true, decimalPlaces: 4 }))
      throw new Error(`${label}请填写非负金额，最多四位小数`);
  }
  const usdtRate = form.usdtFeeCurrencyCode === 'USDT' ? form.usdtFeeFxRateToCny : '';
  const shoppingRate =
    form.shoppingFeeCurrencyCode === receiptCurrency ? form.shoppingFeeFxRateToCny : '';
  const receiptRate = form.receivedAmount ? form.receivedFxRateToCny : '';
  for (const value of [form.chargeFxRateToCny, usdtRate, shoppingRate, receiptRate]) {
    if (value && !isV2UnsignedDecimal(value, { allowZero: false, decimalPlaces: 8 }))
      throw new Error('汇率请填写大于零的数值，最多八位小数');
  }
  const preview = estimateBitOrder(
    {
      ...order,
      plan: order.source === 'automatic' ? order.plan : form.plan,
      status: 'pending_details',
      accountingVersion: 'subscription_cost_v2',
      profitAmountCny: null,
      chargeAmount,
      chargeCurrencyCode,
      receivedAmount: form.receivedAmount || null,
      receivedCurrencyCode: receiptCurrency,
      chargeFxRateToCny: form.chargeFxRateToCny || null,
      receivedFxRateToCny: receiptRate || null,
      usdtFeeAmount: null,
      shoppingFeeAmount: null,
      usdtFeeCurrencyCode: 'USDT',
      shoppingFeeCurrencyCode: receiptCurrency,
      usdtFeeFxRateToCny: usdtRate || null,
      shoppingFeeFxRateToCny: shoppingRate || null
    },
    settings,
    rates,
    now
  );
  const patch: Partial<ReturnType<typeof emptyForm>> = {};
  if (preview.receipt !== null) {
    patch.receivedAmount = preview.receipt;
    patch.receivedCurrencyCode = preview.currency;
    if (!form.receivedAmount || form.receivedCurrencyCode !== preview.currency) {
      if (form.receivedCurrencyCode !== preview.currency) patch.receivedFinanceAccountId = '';
      patch.receivedFxRateToCny = preview.receiptFx ?? '';
    } else if (!form.receivedFxRateToCny && preview.receiptFx)
      patch.receivedFxRateToCny = preview.receiptFx;
  }
  if (!form.chargeFxRateToCny && preview.chargeFx) patch.chargeFxRateToCny = preview.chargeFx;
  for (const prefix of ['usdtFee', 'shoppingFee'] as const) {
    const amount = prefix === 'usdtFee' ? preview.usdtFee : preview.shoppingFee;
    const currency = prefix === 'usdtFee' ? preview.usdtCurrency : preview.shoppingCurrency;
    if (amount === null) continue;
    if (form[`${prefix}CurrencyCode`] !== currency) {
      patch[`${prefix}FinanceAccountId`] = '';
      patch[`${prefix}FxRateToCny`] = '';
      patch[`${prefix}ManualRateReason`] = '';
    }
    patch[`${prefix}Amount`] = amount;
    patch[`${prefix}CurrencyCode`] = currency;
  }
  return { patch, preview };
}
