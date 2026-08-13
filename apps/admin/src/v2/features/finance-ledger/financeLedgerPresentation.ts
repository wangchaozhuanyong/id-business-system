import { formatV2Decimal } from '@/v2/utils/decimal';
import type { V2FinanceHistoryBackfillPreview } from '@apple-business/shared';
import type {
  V2FinanceAccountCode,
  V2FinanceAccountType,
  V2FinanceCurrency,
  V2FinanceHistoryStatus,
  V2FinanceJournalType,
  V2FinancePeriodStatus
} from './contracts';

type HistoryAssetOpeningAdjustment =
  V2FinanceHistoryBackfillPreview['assetOpening']['adjustments'][number];

export function formatCny(value: string) {
  return `¥${formatNumber(value)}`;
}

export function formatOriginal(value: string, currency: V2FinanceCurrency) {
  const prefix =
    currency === 'CNY' ? '¥' : currency === 'MYR' ? 'RM ' : currency === 'USD' ? '$' : '₮';
  return `${prefix}${formatNumber(value)}`;
}

export function amountTone(value: string) {
  return value.startsWith('-') && !/^-(?:0|0\.0+)$/.test(value) ? 'is-negative' : '';
}

export function formatDate(value?: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value));
}

export function accountTypeLabel(value: V2FinanceAccountType) {
  return (
    {
      bank: '银行卡',
      cash: '现金',
      ewallet: '电子钱包',
      usdt_wallet: 'USDT 钱包'
    } as const
  )[value];
}

export function periodStatusLabel(value: V2FinancePeriodStatus) {
  return value === 'closed' ? '已关账' : value === 'reopened' ? '已重新打开' : '开放';
}

export function periodStatusType(value: V2FinancePeriodStatus) {
  return value === 'closed' ? 'info' : value === 'reopened' ? 'warning' : 'success';
}

export function historyStatusLabel(value?: V2FinanceHistoryStatus) {
  return (
    {
      not_started: '未开始回填',
      in_progress: '回填中',
      incomplete: '待人工确认',
      completed: '历史已确认'
    } as const
  )[value ?? 'not_started'];
}

export function isMeaningfulHistoryStatement(value: string) {
  const normalized = value.trim();
  return normalized.length >= 6 && /\p{L}/u.test(normalized) && !/^(.)\1+$/u.test(normalized);
}

export function journalTypeLabel(value: V2FinanceJournalType) {
  const labels: Partial<Record<V2FinanceJournalType, string>> = {
    supplier_deposit: '供应商充值',
    supplier_refund: '供应商退款',
    supplier_adjustment: '供应商调整',
    gift_card_purchase: '礼品卡采购',
    gift_card_redemption_loss: '礼品卡赎回',
    gift_card_withdrawal_pending: '撤回待退款',
    gift_card_refund_received: '卡商退款到账',
    gift_card_refund_write_off: '卡商退款核销',
    account_purchase: 'ID 采购',
    order_completed: '订单完成',
    order_refund: '订单退款',
    order_cancel: '订单取消',
    order_recovery: '订单收回',
    account_loss: 'ID 报损',
    expense: '经营开支',
    opening_balance: '期初余额',
    fx_gain_loss: '汇兑损益',
    manual_adjustment: '手工调整',
    historical_backfill: '历史回填',
    reversal: '冲销'
  };
  return labels[value] ?? value;
}

export function accountCodeLabel(value: V2FinanceAccountCode) {
  const labels: Record<V2FinanceAccountCode, string> = {
    cash: '自有资金',
    supplier_prepayment: '卡商预付款',
    supplier_refund_receivable: '待卡商退款',
    gift_card_inventory: '礼品卡余额资产',
    id_inventory: 'ID 库存',
    sales_revenue: '销售收入',
    platform_fee: '平台手续费',
    gift_card_cost: '余额销售成本',
    id_cost: 'ID 销售成本',
    refund_loss: '退款损失',
    gift_card_redemption_loss: '礼品卡赎回损失',
    balance_loss: 'ID 余额报损',
    id_purchase_loss: 'ID 采购成本报损',
    operating_expense: '经营开支',
    realized_fx_gain_loss: '已实现汇兑损益',
    opening_equity: '期初权益',
    manual_adjustment: '手工调整'
  };
  return labels[value];
}

export function historyAssetOpeningAccountLabel(
  value: HistoryAssetOpeningAdjustment['accountCode']
) {
  return (
    {
      gift_card_inventory: '礼品卡库存',
      id_inventory: '未售 ID 库存',
      supplier_prepayment: '卡商预付款',
      supplier_refund_receivable: '卡商退款应收'
    } as const
  )[value];
}

export function historyAssetOpeningDirectionLabel(
  value: HistoryAssetOpeningAdjustment['direction']
) {
  return value === 'debit' ? '借方补记' : '贷方冲减';
}

function formatNumber(value: string) {
  return formatV2Decimal(value, { minimumFractionDigits: 2 });
}
