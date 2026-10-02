import { V2_GOOGLE_SHEETS_REPORT_NAMES } from '@apple-business/shared';
import {
  dateTime,
  decimal,
  financeAccountLabel
} from './id-business-v2-google-sheets-report-values';
import type { GoogleSheetsDetailSource } from './persistence/id-business-v2-google-sheets-detail.select';
import type { IdBusinessV2GoogleSheetsRenewalRow } from './persistence/id-business-v2-google-sheets-sync.repository';
import type { IdBusinessV2GoogleSheetReport } from './providers/id-business-v2-google-sheets.client';

const STATUS_LABELS = { active: '启用', disabled: '停用' } as const;
const MAILBOX_STATUS_LABELS = { ...STATUS_LABELS, auth_failed: '授权失效' } as const;
const PROVIDER_LABELS = { gmail: 'Gmail', icloud: 'iCloud', microsoft: '微软邮箱' } as const;
const WALLET_TYPE_LABELS = {
  bank: '银行账户',
  cash: '现金账户',
  ewallet: '电子钱包',
  usdt_wallet: 'USDT 钱包'
} as const;
const ACTIVATION_STATUS_LABELS = {
  active: '生效中',
  expired: '已到期',
  cancelled: '已取消',
  abnormal: '异常'
} as const;
const AUTO_RENEWAL_LABELS = { unknown: '未确认', enabled: '已开启', disabled: '已关闭' } as const;
const INFLOW_NATURE_LABELS = {
  operating_income: '经营收入',
  capital_contribution: '股东投入',
  borrowed_funds: '借入资金'
} as const;
const JOURNAL_TYPE_LABELS = {
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
  bank_recharge_completed: '银充订单完成',
  order_refund: '订单退款',
  order_cancel: '订单取消',
  order_recovery: '订单收回',
  order_upgrade_balance_return: '订单升级退币',
  account_loss: 'ID 报损',
  expense: '经营开支',
  manual_operating_income: '手工经营收入',
  capital_contribution: '股东投入',
  borrowed_funds_received: '借入资金',
  opening_balance: '期初余额',
  fx_gain_loss: '汇兑损益',
  manual_adjustment: '手工调整',
  historical_backfill: '历史回填',
  reversal: '冲销',
  fx_exchange: '账户换汇'
} as const;

export function buildGoogleSheetsDetailReports(
  source: GoogleSheetsDetailSource & { renewals: IdBusinessV2GoogleSheetsRenewalRow[] }
): IdBusinessV2GoogleSheetReport[] {
  return [
    {
      name: V2_GOOGLE_SHEETS_REPORT_NAMES[4],
      rows: [
        ['账号编号', '账号邮箱（脱敏）', '状态', '创建时间', '最后更新'],
        ...source.chatgptAccounts.map((row) => [
          row.id,
          row.emailMasked,
          STATUS_LABELS[row.status],
          dateTime(row.createdAt),
          dateTime(row.updatedAt)
        ])
      ]
    },
    {
      name: V2_GOOGLE_SHEETS_REPORT_NAMES[5],
      rows: [
        [
          '邮箱编号',
          '邮箱地址',
          '名称',
          '服务商',
          '状态',
          '查询授权到期时间',
          '最近验证时间',
          '创建时间',
          '最后更新'
        ],
        ...source.mailboxes.map((row) => [
          row.id,
          row.email,
          row.label ?? '',
          PROVIDER_LABELS[row.provider],
          MAILBOX_STATUS_LABELS[row.status],
          dateTime(row.queryCodeExpiresAt),
          dateTime(row.lastVerifiedAt),
          dateTime(row.createdAt),
          dateTime(row.updatedAt)
        ])
      ]
    },
    {
      name: V2_GOOGLE_SHEETS_REPORT_NAMES[6],
      rows: [
        ['银行卡编号', '名称', '卡号（仅尾四位）', '币种', '状态', '创建时间', '最后更新'],
        ...source.bankCards.map((row) => [
          row.id,
          row.label,
          `**** ${row.last4}`,
          row.currencyCode,
          row.active ? '启用' : '停用',
          dateTime(row.createdAt),
          dateTime(row.updatedAt)
        ])
      ]
    },
    {
      name: V2_GOOGLE_SHEETS_REPORT_NAMES[7],
      rows: [
        [
          '客户编号',
          '客户名称',
          '手机号（脱敏）',
          '微信（脱敏）',
          'QQ（脱敏）',
          'WhatsApp（脱敏）',
          '客户来源',
          '状态',
          '标签',
          '服务及开通次数',
          '创建时间',
          '最后更新'
        ],
        ...source.customers.map((row) => [
          row.id,
          row.name,
          row.phoneMasked ?? '',
          row.wechatMasked ?? '',
          row.qqMasked ?? '',
          row.whatsappMasked ?? '',
          row.sourceOption?.name ?? '',
          STATUS_LABELS[row.recordStatus],
          row.tags.map(({ option }) => option.name).join('、'),
          row.services
            .map(({ option, activationCount }) => `${option.name}：${activationCount}次`)
            .join('、'),
          dateTime(row.createdAt),
          dateTime(row.updatedAt)
        ])
      ]
    },
    {
      name: V2_GOOGLE_SHEETS_REPORT_NAMES[8],
      rows: [
        [
          '开通编号',
          '订单号',
          '客户',
          '关联 ID（脱敏）',
          '业务分类',
          '服务',
          '记录类型',
          '状态',
          '自动续费',
          '上次开通编号',
          '开通时间',
          '到期时间',
          '最后更新'
        ],
        ...source.renewals.map((row) => [
          row.id,
          row.order.orderNo,
          row.customer.name,
          row.account.appleIdMasked,
          row.serviceOption.parent?.name ?? '',
          row.serviceOption.name,
          row.renewedFromActivationId ? '续费' : '首次开通',
          ACTIVATION_STATUS_LABELS[row.status],
          AUTO_RENEWAL_LABELS[row.autoRenewalStatus],
          row.renewedFromActivationId ?? '',
          dateTime(row.openedAt),
          dateTime(row.dueAt),
          dateTime(row.updatedAt)
        ])
      ]
    },
    {
      name: V2_GOOGLE_SHEETS_REPORT_NAMES[9],
      rows: [
        [
          '账户编号',
          '钱包名称',
          '账户类型',
          '币种',
          '期初原币余额',
          '当前原币余额',
          '期初人民币账面余额',
          '当前人民币账面余额',
          '状态',
          '创建时间',
          '最后更新'
        ],
        ...source.wallets.map((row) => [
          row.id,
          row.name,
          WALLET_TYPE_LABELS[row.accountType],
          row.currency,
          decimal(row.openingBalance),
          decimal(row.currentBalance),
          decimal(row.openingBalanceCny),
          decimal(row.currentBalanceCny),
          STATUS_LABELS[row.status],
          dateTime(row.createdAt),
          dateTime(row.updatedAt)
        ])
      ]
    },
    {
      name: V2_GOOGLE_SHEETS_REPORT_NAMES[10],
      rows: [
        [
          '分录编号',
          '凭证号',
          '凭证行号',
          '业务日期',
          '发生时间',
          '业务类型',
          '状态',
          '财务科目',
          '借贷方向',
          '币种',
          '原币金额',
          '人民币汇率',
          '人民币金额',
          '钱包账户',
          '卡商',
          '收支分类',
          '收入资金性质',
          '冲销原凭证编号',
          '创建时间',
          '最后更新'
        ],
        ...source.financeEntries.map((row) => [
          row.id,
          row.journal.journalNo,
          String(row.lineNo),
          row.journal.businessDate.toISOString().slice(0, 10),
          dateTime(row.journal.occurredAt),
          JOURNAL_TYPE_LABELS[row.journal.journalType],
          row.journal.status === 'posted' ? '已入账' : '已冲销',
          financeAccountLabel(row.accountCode),
          row.direction === 'debit' ? '借方' : '贷方',
          row.currency,
          decimal(row.amountOriginal),
          decimal(row.fxRateToCny),
          decimal(row.amountCny),
          row.financeAccount?.name ?? '',
          row.supplierAccount?.supplierOption.name ?? '',
          row.journal.expense?.categoryNameSnapshot ??
            row.journal.inflow?.categoryNameSnapshot ??
            '',
          row.journal.inflow ? INFLOW_NATURE_LABELS[row.journal.inflow.nature] : '',
          row.journal.reversalOfJournalId ?? '',
          dateTime(row.createdAt),
          dateTime(row.journal.updatedAt)
        ])
      ]
    }
  ];
}
