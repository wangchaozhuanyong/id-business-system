const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

const FINANCE_ACCOUNT_LABELS: Record<string, string> = {
  cash: '自有资金',
  supplier_prepayment: '卡商预付款',
  supplier_refund_receivable: '卡商退款应收',
  gift_card_inventory: '礼品卡库存',
  id_inventory: 'ID 库存',
  sales_revenue: '销售收入',
  bank_recharge_revenue: '银充代付收入',
  bank_recharge_service_fee: '银充服务费收入',
  bank_recharge_cost: '银充代付成本',
  bank_recharge_bank_fee: '银充银行手续费',
  other_operating_revenue: '其他经营收入',
  contributed_capital: '股东投入',
  borrowed_funds_payable: '借入资金',
  platform_fee: '平台手续费',
  gift_card_cost: '礼品卡成本',
  id_cost: 'ID 成本',
  customer_owned_balance_cost: '客户自有余额成本',
  refund_loss: '退款损失',
  gift_card_redemption_loss: '礼品卡赎回损失',
  balance_loss: '余额报损',
  id_purchase_loss: 'ID 采购报损',
  operating_expense: '经营开支',
  realized_fx_gain_loss: '已实现汇兑损益',
  opening_equity: '期初权益',
  manual_adjustment: '手工调整',
  fx_exchange_fee: '换汇费用',
  bank_recharge_usdt_fee: '订阅 USDT 手续费',
  bank_recharge_shopping_fee: '订阅购物网手续费'
};

export function financeAccountLabel(code: string) {
  return FINANCE_ACCOUNT_LABELS[code] ?? '其他财务科目';
}

export function decimal(value: { toString(): string } | null) {
  return value?.toString() ?? '';
}

export function dateTime(value: Date | null) {
  return value ? dateTimeFormatter.format(value).replace(/\//g, '-') : '';
}
