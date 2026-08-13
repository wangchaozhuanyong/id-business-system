export type IdBusinessV2OrderBalanceRefundMode = 'none' | 'full' | 'custom';

export interface RefundIdBusinessV2OrderDto {
  refundCostAmount: string | number;
  reason: string;
  balanceRefundMode?: IdBusinessV2OrderBalanceRefundMode;
  customRefundBalanceAmount?: string | number;
  /** 兼容旧版管理端；新请求使用 balanceRefundMode。 */
  restoreBalance?: boolean;
  idempotencyKey: string;
}
