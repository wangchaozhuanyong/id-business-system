import type { Prisma } from '@prisma/client';

export const ORDER_REPORT_SELECT = {
  id: true,
  orderNo: true,
  customer: { select: { name: true } },
  serviceOption: { select: { name: true, parent: { select: { name: true } } } },
  settlementPlatform: { select: { name: true } },
  receivedAmount: true,
  receivedOriginalAmount: true,
  receivedCurrency: true,
  platformFeeAmount: true,
  appliedAccountCostAmount: true,
  appliedBalanceCostAmount: true,
  refundCostAmount: true,
  profitAmount: true,
  status: true,
  accountSource: true,
  accountDisposition: true,
  openedAt: true,
  dueAt: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.IdBusinessV2OrderSelect;

export const GIFT_CARD_REPORT_SELECT = {
  id: true,
  createdAt: true,
  account: { select: { appleIdMasked: true } },
  codeMasked: true,
  purchaseFinanceAccount: { select: { name: true } },
  cardNameSnapshot: true,
  countryNameSnapshot: true,
  currencyCodeSnapshot: true,
  supplierNameSnapshot: true,
  faceValue: true,
  exchangeRate: true,
  costAmount: true,
  purchaseOriginalAmount: true,
  purchaseCurrency: true,
  purchaseFxRateToCny: true,
  supplierRefundStatus: true,
  supplierRefundAmountCny: true,
  status: true,
  creditedAt: true,
  updatedAt: true
} satisfies Prisma.IdBusinessV2GiftCardSelect;

export const RENEWAL_REPORT_SELECT = {
  id: true,
  createdAt: true,
  account: { select: { appleIdMasked: true } },
  order: { select: { orderNo: true } },
  customer: { select: { name: true } },
  serviceOption: { select: { name: true, parent: { select: { name: true } } } },
  openedAt: true,
  dueAt: true,
  status: true,
  autoRenewalStatus: true,
  renewedFromActivationId: true,
  updatedAt: true
} satisfies Prisma.IdBusinessV2ActivationSelect;

export const FINANCE_REPORT_SELECT = {
  businessDate: true,
  lines: {
    select: {
      accountCode: true,
      amountCny: true,
      direction: true
    }
  }
} satisfies Prisma.IdBusinessV2FinanceJournalSelect;

export type IdBusinessV2GoogleSheetsOrderRow = Prisma.IdBusinessV2OrderGetPayload<{
  select: typeof ORDER_REPORT_SELECT;
}>;
export type IdBusinessV2GoogleSheetsGiftCardRow = Prisma.IdBusinessV2GiftCardGetPayload<{
  select: typeof GIFT_CARD_REPORT_SELECT;
}>;
export type IdBusinessV2GoogleSheetsRenewalRow = Prisma.IdBusinessV2ActivationGetPayload<{
  select: typeof RENEWAL_REPORT_SELECT;
}>;
export type IdBusinessV2GoogleSheetsFinanceRow = Prisma.IdBusinessV2FinanceJournalGetPayload<{
  select: typeof FINANCE_REPORT_SELECT;
}>;

// Export business metadata only; encrypted credentials and unstructured remarks stay in the system.
export const CHATGPT_REPORT_SELECT = {
  id: true,
  emailMasked: true,
  status: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.IdBusinessV2ChatgptAccountSelect;

export const MAILBOX_REPORT_SELECT = {
  id: true,
  email: true,
  label: true,
  provider: true,
  status: true,
  queryCodeExpiresAt: true,
  lastVerifiedAt: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.IdBusinessV2ManagedMailboxSelect;

export const BANK_CARD_REPORT_SELECT = {
  id: true,
  label: true,
  last4: true,
  currencyCode: true,
  active: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.IdBusinessV2BankRechargeCardSelect;

export const CUSTOMER_REPORT_SELECT = {
  id: true,
  name: true,
  phoneMasked: true,
  wechatMasked: true,
  qqMasked: true,
  whatsappMasked: true,
  sourceOption: { select: { name: true } },
  recordStatus: true,
  tags: { select: { option: { select: { name: true } } }, orderBy: { optionId: 'asc' } },
  services: {
    select: { option: { select: { name: true } }, activationCount: true },
    orderBy: { optionId: 'asc' }
  },
  createdAt: true,
  updatedAt: true
} satisfies Prisma.IdBusinessV2CustomerSelect;

export const WALLET_REPORT_SELECT = {
  id: true,
  name: true,
  accountType: true,
  currency: true,
  openingBalance: true,
  currentBalance: true,
  openingBalanceCny: true,
  currentBalanceCny: true,
  status: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.IdBusinessV2FinanceAccountSelect;

export const FINANCE_ENTRY_REPORT_SELECT = {
  id: true,
  lineNo: true,
  accountCode: true,
  direction: true,
  currency: true,
  amountOriginal: true,
  fxRateToCny: true,
  amountCny: true,
  financeAccount: { select: { name: true } },
  supplierAccount: { select: { supplierOption: { select: { name: true } } } },
  journal: {
    select: {
      journalNo: true,
      businessDate: true,
      occurredAt: true,
      journalType: true,
      status: true,
      reversalOfJournalId: true,
      expense: { select: { categoryNameSnapshot: true } },
      inflow: { select: { categoryNameSnapshot: true, nature: true } },
      updatedAt: true
    }
  },
  createdAt: true
} satisfies Prisma.IdBusinessV2FinanceJournalLineSelect;

export type GoogleSheetsChatgptRow = Prisma.IdBusinessV2ChatgptAccountGetPayload<{
  select: typeof CHATGPT_REPORT_SELECT;
}>;
export type GoogleSheetsMailboxRow = Prisma.IdBusinessV2ManagedMailboxGetPayload<{
  select: typeof MAILBOX_REPORT_SELECT;
}>;
export type GoogleSheetsBankCardRow = Prisma.IdBusinessV2BankRechargeCardGetPayload<{
  select: typeof BANK_CARD_REPORT_SELECT;
}>;
export type GoogleSheetsCustomerRow = Prisma.IdBusinessV2CustomerGetPayload<{
  select: typeof CUSTOMER_REPORT_SELECT;
}>;
export type GoogleSheetsWalletRow = Prisma.IdBusinessV2FinanceAccountGetPayload<{
  select: typeof WALLET_REPORT_SELECT;
}>;
export type GoogleSheetsFinanceEntryRow = Prisma.IdBusinessV2FinanceJournalLineGetPayload<{
  select: typeof FINANCE_ENTRY_REPORT_SELECT;
}>;

export interface GoogleSheetsDetailSource {
  chatgptAccounts: GoogleSheetsChatgptRow[];
  mailboxes: GoogleSheetsMailboxRow[];
  bankCards: GoogleSheetsBankCardRow[];
  customers: GoogleSheetsCustomerRow[];
  wallets: GoogleSheetsWalletRow[];
  financeEntries: GoogleSheetsFinanceEntryRow[];
}
