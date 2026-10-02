import { V2_GOOGLE_SHEETS_REPORT_NAMES } from '@apple-business/shared';
import { Amount4 } from '../runtime/public-api';
import { buildGoogleSheetsDetailReports } from './id-business-v2-google-sheets-detail-report';
import {
  dateTime,
  decimal,
  financeAccountLabel
} from './id-business-v2-google-sheets-report-values';
import type { GoogleSheetsDetailSource } from './persistence/id-business-v2-google-sheets-detail.select';
import type {
  IdBusinessV2GoogleSheetsFinanceRow,
  IdBusinessV2GoogleSheetsGiftCardRow,
  IdBusinessV2GoogleSheetsOrderRow,
  IdBusinessV2GoogleSheetsRenewalRow
} from './persistence/id-business-v2-google-sheets-sync.repository';
import type { IdBusinessV2GoogleSheetReport } from './providers/id-business-v2-google-sheets.client';
import {
  retainedGoogleSheetsRowCount,
  type GoogleSheetsReportRetention
} from './id-business-v2-google-sheets-retention';

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

type GoogleSheetsReportSource = GoogleSheetsDetailSource & {
  orders: IdBusinessV2GoogleSheetsOrderRow[];
  giftCards: IdBusinessV2GoogleSheetsGiftCardRow[];
  renewals: IdBusinessV2GoogleSheetsRenewalRow[];
  financeJournals: IdBusinessV2GoogleSheetsFinanceRow[];
};

export function buildIdBusinessV2GoogleSheetsReports(
  source: GoogleSheetsReportSource
): IdBusinessV2GoogleSheetReport[] {
  return prepareIdBusinessV2GoogleSheetsReports(source).reports;
}

export function prepareIdBusinessV2GoogleSheetsReports(
  source: GoogleSheetsReportSource,
  previous: GoogleSheetsReportRetention = { records: {} }
) {
  const finance = financeRows(source.financeJournals, previous.financeSummaryAfter);
  const reports: IdBusinessV2GoogleSheetReport[] = [
    { name: V2_GOOGLE_SHEETS_REPORT_NAMES[0], rows: orderRows(source.orders) },
    { name: V2_GOOGLE_SHEETS_REPORT_NAMES[1], rows: giftCardRows(source.giftCards) },
    { name: V2_GOOGLE_SHEETS_REPORT_NAMES[2], rows: renewalRows(source.renewals) },
    { name: V2_GOOGLE_SHEETS_REPORT_NAMES[3], rows: finance.rows },
    ...buildGoogleSheetsDetailReports(source)
  ];
  return {
    reports,
    retention: { ...previous, ...(finance.after ? { financeSummaryAfter: finance.after } : {}) }
  };
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
      '所属 ID（脱敏）',
      '礼品卡号（脱敏）',
      '付款钱包',
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
      row.id,
      row.account.appleIdMasked,
      row.codeMasked,
      row.purchaseFinanceAccount?.name ?? '',
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

function financeRows(rows: IdBusinessV2GoogleSheetsFinanceRow[], previousAfter?: string) {
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
    .filter((row) => !previousAfter || `${row.date}:${row.accountCode}` > previousAfter)
    .sort((left, right) => {
      const a = `${left.date}:${left.accountCode}`;
      const b = `${right.date}:${right.accountCode}`;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  const removed = values.length - retainedGoogleSheetsRowCount(values.length);
  const cutoff = removed ? values[removed - 1] : undefined;
  return {
    after: cutoff ? `${cutoff.date}:${cutoff.accountCode}` : previousAfter,
    rows: [
      ['业务日期', '财务科目', '借方人民币', '贷方人民币', '净额人民币', '分录数'],
      ...values
        .slice(removed)
        .map((row) => [
          row.date,
          financeAccountLabel(row.accountCode),
          row.debit.toFixed(4),
          row.credit.toFixed(4),
          row.debit.sub(row.credit).toFixed(4),
          String(row.entries)
        ])
    ]
  };
}
