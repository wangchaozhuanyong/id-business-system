// 普通订单沿用原有四种收款币种；财务账户的扩展币种不自动扩大订单契约。
export const V2_ORDER_RECEIPT_CURRENCIES = ['CNY', 'MYR', 'USD', 'USDT'] as const;

export type V2OrderReceiptCurrency = (typeof V2_ORDER_RECEIPT_CURRENCIES)[number];

export function isV2OrderReceiptCurrency(value: unknown): value is V2OrderReceiptCurrency {
  return V2_ORDER_RECEIPT_CURRENCIES.some((currency) => currency === value);
}
