import { V2_GOOGLE_SHEETS_REPORT_NAMES } from '@apple-business/shared';
import { Amount4 } from '../runtime/public-api';
import type {
  IdBusinessV2GoogleSheetsFinanceRow,
  IdBusinessV2GoogleSheetsGiftCardRow,
  IdBusinessV2GoogleSheetsOrderRow,
  IdBusinessV2GoogleSheetsRenewalRow
} from './persistence/id-business-v2-google-sheets-sync.repository';
import type { IdBusinessV2GoogleSheetReport } from './providers/id-business-v2-google-sheets.client';

const REPORT_ROW_LIMIT = 10_000;
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

const ORDER_STATUS_LABELS = {
  draft: '草稿',
  pending: '待处理',
  waiting_external: '等待外部处理',
  processing: '处理中',
  completed: '已完成',
  refunded: '已退款',
  cancelled: '已取消',
  failed: '失败'
} as const;

const GIFT_CARD_STATUS_LABELS = {
  credited: '已入账',
  redeemed: '已赎回',
  withdrawn: '已撤回'
} as const;

const REFUND_STATUS_LABELS = {
  none: '无',
  pending: '待退款',
  received: '已收到退款',
  written_off: '已核销'
} as const;

const ACTIVATION_STATUS_LABELS = {
  active: '生效中',
  expired: '已到期',
  cancelled: '已取消',
  abnormal: '异常'
} as const;

const AUTO_RENEWAL_LABELS = {
  unknown: '未确认',
  enabled: '已开启',
  disabled: '已关闭'
} as const;

const FINANCE_ACCOUNT_LABELS: Record<string, string> = {
  cash: '自有资金',
  supplier_prepayment: '卡商预付款',
  supplier_refund_receivable: '卡商退款应收',
  gift_card_inventory: '礼品卡库存',
  id_inventory: 'ID 库存',
  sales_revenue: '销售收入',
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
  manual_adjustment: '手工调整'
};

export function buildIdBusinessV2GoogleSheetsReports(source: {
  orders: IdBusinessV2GoogleSheetsOrderRow[];
  giftCards: IdBusinessV2GoogleSheetsGiftCardRow[];
  renewals: IdBusinessV2GoogleSheetsRenewalRow[];
  financeJournals: IdBusinessV2GoogleSheetsFinanceRow[];
}): IdBusinessV2GoogleSheetReport[] {
  return [
    { name: V2_GOOGLE_SHEETS_REPORT_NAMES[0], rows: orderRows(source.orders) },
    { name: V2_GOOGLE_SHEETS_REPORT_NAMES[1], rows: giftCardRows(source.giftCards) },
    { name: V2_GOOGLE_SHEETS_REPORT_NAMES[2], rows: renewalRows(source.renewals) },
    { name: V2_GOOGLE_SHEETS_REPORT_NAMES[3], rows: financeRows(source.financeJournals) }
  ];
}

function orderRows(rows: IdBusinessV2GoogleSheetsOrderRow[]) {
  return [
    [
      '订单号',
      '客户',
      '业务分类',
      '服务',
      '状态',
      '实收原币',
      '币种',
      '实收人民币',
      '平台手续费',
      '余额成本',
      'ID 成本',
      '退款成本',
      '利润',
      'ID 来源',
      'ID 处理',
      '结算平台',
      '开通时间',
      '到期时间',
      '最后更新'
    ],
    ...rows.map((row) => [
      row.orderNo,
      row.customer.name,
      row.serviceOption.parent?.name ?? '',
      row.serviceOption.name,
      ORDER_STATUS_LABELS[row.status],
      decimal(row.receivedOriginalAmount),
      row.receivedCurrency,
      decimal(row.receivedAmount),
      decimal(row.platformFeeAmount),
      decimal(row.appliedBalanceCostAmount),
      decimal(row.appliedAccountCostAmount),
      decimal(row.refundCostAmount),
      decimal(row.profitAmount),
      row.accountSource === 'inventory' ? '库存 ID' : '客户已有 ID',
      row.accountDisposition === 'sold'
        ? '已售出'
        : row.accountDisposition === 'recovered'
          ? '已收回'
          : '保留',
      row.settlementPlatform?.name ?? '',
      dateTime(row.openedAt),
      dateTime(row.dueAt),
      dateTime(row.updatedAt)
    ])
  ];
}

function giftCardRows(rows: IdBusinessV2GoogleSheetsGiftCardRow[]) {
  return [
    [
      '记录编号',
      '礼品卡名称',
      '国家或地区',
      '面值币种',
      '面值',
      '加卡汇率',
      '人民币成本',
      '付款原币',
      '付款币种',
      '付款汇率',
      '供应商',
      '卡状态',
      '供应商退款状态',
      '供应商退款人民币',
      '加卡时间',
      '最后更新'
    ],
    ...rows.map((row) => [
      row.id.slice(0, 8),
      row.cardNameSnapshot,
      row.countryNameSnapshot,
      row.currencyCodeSnapshot ?? '',
      decimal(row.faceValue),
      decimal(row.exchangeRate),
      decimal(row.costAmount),
      decimal(row.purchaseOriginalAmount),
      row.purchaseCurrency,
      decimal(row.purchaseFxRateToCny),
      row.supplierNameSnapshot ?? '',
      GIFT_CARD_STATUS_LABELS[row.status],
      REFUND_STATUS_LABELS[row.supplierRefundStatus],
      decimal(row.supplierRefundAmountCny),
      dateTime(row.creditedAt),
      dateTime(row.updatedAt)
    ])
  ];
}

function renewalRows(rows: IdBusinessV2GoogleSheetsRenewalRow[]) {
  return [
    [
      '订单号',
      '客户',
      '业务分类',
      '服务',
      '记录类型',
      '状态',
      '自动续费',
      '开通时间',
      '到期时间',
      '最后更新'
    ],
    ...rows.map((row) => [
      row.order.orderNo,
      row.customer.name,
      row.serviceOption.parent?.name ?? '',
      row.serviceOption.name,
      row.renewedFromActivationId ? '续费' : '首次开通',
      ACTIVATION_STATUS_LABELS[row.status],
      AUTO_RENEWAL_LABELS[row.autoRenewalStatus],
      dateTime(row.openedAt),
      dateTime(row.dueAt),
      dateTime(row.updatedAt)
    ])
  ];
}

function financeRows(rows: IdBusinessV2GoogleSheetsFinanceRow[]) {
  const groups = new Map<
    string,
    { date: string; accountCode: string; debit: Amount4; credit: Amount4; entries: number }
  >();
  for (const journal of rows) {
    const date = journal.businessDate.toISOString().slice(0, 10);
    for (const line of journal.lines) {
      const key = `${date}:${line.accountCode}`;
      const group = groups.get(key) ?? {
        date,
        accountCode: line.accountCode,
        debit: Amount4.zero(),
        credit: Amount4.zero(),
        entries: 0
      };
      if (line.direction === 'debit') group.debit = group.debit.add(line.amountCny);
      else group.credit = group.credit.add(line.amountCny);
      group.entries += 1;
      groups.set(key, group);
    }
  }
  const values = [...groups.values()]
    .sort(
      (left, right) =>
        right.date.localeCompare(left.date) || left.accountCode.localeCompare(right.accountCode)
    )
    .slice(0, REPORT_ROW_LIMIT);
  return [
    ['业务日期', '财务科目', '借方人民币', '贷方人民币', '净额人民币', '分录数'],
    ...values.map((row) => [
      row.date,
      FINANCE_ACCOUNT_LABELS[row.accountCode] ?? row.accountCode,
      row.debit.toFixed(4),
      row.credit.toFixed(4),
      row.debit.sub(row.credit).toFixed(4),
      String(row.entries)
    ])
  ];
}

function decimal(value: { toString(): string } | null) {
  return value?.toString() ?? '';
}

function dateTime(value: Date | null) {
  return value ? dateTimeFormatter.format(value).replace(/\//g, '-') : '';
}
